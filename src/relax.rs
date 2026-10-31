//! Making a drawing look better without changing the diagram.
//!
//! [`relax`] moves vertices by springs (edges toward a common length),
//! repulsion (vertices apart) and smoothing (toward the midpoint of their
//! neighbors).  [`simplify`] removes vertices where a strand is nearly
//! straight.  Every step is accepted only if each segment still crosses
//! exactly the segments it crossed before and keeps a minimum distance from
//! the vertices it does not touch, so the crossings, their over/under
//! choices and hence the diagram are unchanged (two crossings on one strand
//! may pass each other only through a Reidemeister III move).

use crate::geometry::Drawing;
use std::collections::{HashMap, HashSet};

type P = (f64, f64);

fn sub(a: P, b: P) -> P {
    (a.0 - b.0, a.1 - b.1)
}
fn cross(a: P, b: P) -> f64 {
    a.0 * b.1 - a.1 * b.0
}
fn norm(a: P) -> f64 {
    a.0.hypot(a.1)
}

/// Do the open segments `pq` and `rs` cross?
fn crosses(p: P, q: P, r: P, s: P) -> bool {
    let d1 = cross(sub(q, p), sub(r, p));
    let d2 = cross(sub(q, p), sub(s, p));
    let d3 = cross(sub(s, r), sub(p, r));
    let d4 = cross(sub(s, r), sub(q, r));
    d1 * d2 < 0.0 && d3 * d4 < 0.0
}

/// Distance from `x` to the segment `pq`.
fn dist_to_segment(x: P, p: P, q: P) -> f64 {
    let d = sub(q, p);
    let len2 = d.0 * d.0 + d.1 * d.1;
    let t = if len2 > 0.0 {
        (((x.0 - p.0) * d.0 + (x.1 - p.1) * d.1) / len2).clamp(0.0, 1.0)
    } else {
        0.0
    };
    norm(sub(x, (p.0 + t * d.0, p.1 + t * d.1)))
}

/// The drawing as positions with neighbor links.
struct Net {
    pos: Vec<P>,
    next: Vec<usize>,
    prev: Vec<usize>,
    id: Vec<u32>,
    alive: Vec<bool>,
}

impl Net {
    fn new(d: &Drawing) -> Net {
        let mut net = Net {
            pos: Vec::new(),
            next: Vec::new(),
            prev: Vec::new(),
            id: Vec::new(),
            alive: Vec::new(),
        };
        for poly in &d.components {
            let base = net.pos.len();
            let n = poly.len();
            for (k, v) in poly.iter().enumerate() {
                net.pos.push((v.x, v.y));
                net.id.push(v.id);
                net.next.push(base + (k + 1) % n);
                net.prev.push(base + (k + n - 1) % n);
                net.alive.push(true);
            }
        }
        net
    }

    /// Segments are named by their first vertex.
    fn segs(&self) -> impl Iterator<Item = usize> + '_ {
        (0..self.pos.len()).filter(|&v| self.alive[v])
    }

    fn adjacent(&self, s: usize, t: usize) -> bool {
        s == t || self.next[s] == t || self.next[t] == s
    }

    /// The segments that the segment from `a` to `b` (named `s`) crosses.
    fn crossings_of(&self, s: usize, a: P, b: P, skip: &[usize]) -> HashSet<usize> {
        self.segs()
            .filter(|&t| !self.adjacent(s, t) && !skip.contains(&t))
            .filter(|&t| crosses(a, b, self.pos[t], self.pos[self.next[t]]))
            .collect()
    }

    /// Is every vertex other than `ends` at least `gap` from the segment `ab`?
    fn clear(&self, a: P, b: P, ends: &[usize], gap: f64) -> bool {
        self.segs()
            .filter(|v| !ends.contains(v))
            .all(|v| dist_to_segment(self.pos[v], a, b) >= gap)
    }

    /// May vertex `v` move to `np`?  Both of its segments must cross exactly
    /// the segments they crossed before, and every clearance (a vertex from a
    /// segment it does not touch) must stay at least `gap`, or not shrink if it
    /// is already below `gap`.
    fn can_move(&self, v: usize, np: P, crossing: &HashMap<usize, HashSet<usize>>, gap: f64) -> bool {
        let (a, b) = (self.prev[v], self.next[v]);
        let (pa, pv, pb) = (self.pos[a], self.pos[v], self.pos[b]);
        if self.crossings_of(a, pa, np, &[]) != crossing[&a]
            || self.crossings_of(v, np, pb, &[]) != crossing[&v]
        {
            return false;
        }
        let ok = |new: f64, old: f64| new >= gap.min(old);
        // other vertices against v's two segments
        let vertices_ok = self.segs().filter(|&u| u != a && u != v && u != b).all(|u| {
            let x = self.pos[u];
            ok(dist_to_segment(x, pa, np), dist_to_segment(x, pa, pv))
                && ok(dist_to_segment(x, np, pb), dist_to_segment(x, pv, pb))
        });
        // v against the other segments
        vertices_ok
            && self.segs().filter(|&t| t != a && t != v).all(|t| {
                let (p, q) = (self.pos[t], self.pos[self.next[t]]);
                ok(dist_to_segment(np, p, q), dist_to_segment(pv, p, q))
            })
    }

    fn crossing_sets(&self) -> HashMap<usize, HashSet<usize>> {
        self.segs()
            .map(|s| (s, self.crossings_of(s, self.pos[s], self.pos[self.next[s]], &[])))
            .collect()
    }

    fn mean_length(&self) -> f64 {
        let segs: Vec<usize> = self.segs().collect();
        let total: f64 = segs
            .iter()
            .map(|&s| norm(sub(self.pos[self.next[s]], self.pos[s])))
            .sum();
        total / segs.len().max(1) as f64
    }

    fn component_size(&self, v: usize) -> usize {
        let mut k = 1;
        let mut u = self.next[v];
        while u != v {
            k += 1;
            u = self.next[u];
        }
        k
    }
}

/// Spring/repulsion/smoothing relaxation (`iterations` rounds), keeping
/// every crossing.  Drawings with twist boxes are left alone (moving a
/// strand could put another between a box's two strands).
pub fn relax(d: &mut Drawing, iterations: usize) {
    if !d.boxes.is_empty() {
        return;
    }
    let mut net = Net::new(d);
    let n = net.pos.len();
    if n < 3 {
        return;
    }
    let mut crossing: HashMap<usize, HashSet<usize>> = HashMap::new();
    for s in 0..n {
        let set = net.crossings_of(s, net.pos[s], net.pos[net.next[s]], &[]);
        crossing.insert(s, set);
    }
    let total: f64 = (0..n).map(|s| norm(sub(net.pos[net.next[s]], net.pos[s]))).sum();
    let l0 = total / n as f64;
    let gap = 0.12 * l0;
    for it in 0..iterations {
        let temp = 1.0 - it as f64 / iterations as f64;
        for v in 0..n {
            let p = net.pos[v];
            let (a, b) = (net.prev[v], net.next[v]);
            let (pa, pb) = (net.pos[a], net.pos[b]);
            let mut f = (0.0, 0.0);
            // smoothing toward the neighbors' midpoint
            f.0 += 0.35 * ((pa.0 + pb.0) / 2.0 - p.0);
            f.1 += 0.35 * ((pa.1 + pb.1) / 2.0 - p.1);
            // springs
            for q in [pa, pb] {
                let d = sub(q, p);
                let len = norm(d).max(1e-9);
                let k = 0.15 * (len - l0) / len;
                f.0 += k * d.0;
                f.1 += k * d.1;
            }
            // repulsion
            for u in 0..n {
                if u == v || u == a || u == b {
                    continue;
                }
                let d = sub(p, net.pos[u]);
                let r2 = d.0 * d.0 + d.1 * d.1;
                if r2 < 9.0 * l0 * l0 {
                    let k = 0.08 * l0 * l0 / r2.max(1e-6 * l0 * l0);
                    f.0 += k * d.0 / r2.sqrt().max(1e-9);
                    f.1 += k * d.1 / r2.sqrt().max(1e-9);
                }
            }
            let step = norm(f);
            let cap = 0.25 * l0 * temp;
            if step < 1e-9 {
                continue;
            }
            let scale = (cap / step).min(1.0);
            let np = (p.0 + scale * f.0, p.1 + scale * f.1);
            // accept only if both segments at v cross what they crossed before
            if net.can_move(v, np, &crossing, gap) {
                net.pos[v] = np;
            }
        }
    }
    write_back(d, &net, &HashMap::new());
}

/// Moves vertices that sit close to a crossing away from it, along the
/// strand they continue on, so that every crossing has room on both strands
/// (`frac` of the mean segment length on each side, where the strand allows).
/// Every move keeps all crossings, as in [`relax`].
pub fn open_crossings(d: &mut Drawing, frac: f64, rounds: usize) {
    if !d.boxes.is_empty() {
        return;
    }
    let mut net = Net::new(d);
    if net.pos.len() < 3 {
        return;
    }
    let mut crossing = net.crossing_sets();
    let l0 = net.mean_length();
    let (target, gap) = (frac * l0, 0.12 * l0);
    for _ in 0..rounds {
        let mut moved = false;
        // crossing points
        let mut points = Vec::new();
        for (&s0, set) in &crossing {
            for &t in set.iter().filter(|&&t| s0 < t) {
                let (p, q) = (net.pos[s0], net.pos[net.next[s0]]);
                let (r, u) = (net.pos[t], net.pos[net.next[t]]);
                let den = cross(sub(q, p), sub(u, r));
                if den != 0.0 {
                    let k = cross(sub(r, p), sub(u, r)) / den;
                    points.push((p.0 + k * (q.0 - p.0), p.1 + k * (q.1 - p.1)));
                }
            }
        }
        let verts: Vec<usize> = net.segs().collect();
        for &x in &points {
            for &v in &verts {
                let pv = net.pos[v];
                let dist = norm(sub(pv, x));
                if dist >= target {
                    continue;
                }
                // along the segment of v that does not run through the
                // crossing (moving along the other one would carry v across
                // it), then the other way, then straight away from it
                let (a, b) = (net.pos[net.prev[v]], net.pos[net.next[v]]);
                let (first, second) = if dist_to_segment(x, a, pv) < dist_to_segment(x, pv, b) {
                    (b, a)
                } else {
                    (a, b)
                };
                let away = sub(pv, x);
                let mut candidates = Vec::new();
                for toward in [first, second] {
                    let along = sub(toward, pv);
                    if norm(along) > 1e-12 {
                        let step = (target - dist).min(0.6 * norm(along));
                        candidates.push((
                            pv.0 + step * along.0 / norm(along),
                            pv.1 + step * along.1 / norm(along),
                        ));
                    }
                }
                if norm(away) > 1e-12 {
                    let step = target - dist;
                    candidates.push((
                        pv.0 + step * away.0 / norm(away),
                        pv.1 + step * away.1 / norm(away),
                    ));
                }
                for np in candidates {
                    if norm(sub(np, x)) > dist && net.can_move(v, np, &crossing, gap) {
                        net.pos[v] = np;
                        moved = true;
                        break;
                    }
                }
            }
        }
        if !moved {
            break;
        }
        crossing = net.crossing_sets();
    }
    write_back(d, &net, &HashMap::new());
}

/// Removes vertices where the strand turns by less than `max_turn` radians,
/// keeping every crossing.  Over/under choices are re-keyed to the merged
/// segments.
pub fn simplify(d: &mut Drawing, max_turn: f64) {
    let mut net = Net::new(d);
    let n = net.pos.len();
    let mut crossing: HashMap<usize, HashSet<usize>> = HashMap::new();
    for s in 0..n {
        let set = net.crossings_of(s, net.pos[s], net.pos[net.next[s]], &[]);
        crossing.insert(s, set);
    }
    let lens: f64 = (0..n).map(|s| norm(sub(net.pos[net.next[s]], net.pos[s]))).sum();
    let gap = 0.12 * lens / n.max(1) as f64;
    // removed vertex → the vertex that now starts its segment
    let mut merged_into: HashMap<usize, usize> = HashMap::new();
    // segments carrying a twist box keep their ends (the box sits at the midpoint)
    let boxed: HashSet<u32> = d.boxes.iter().flat_map(|b| [b.a, b.b]).collect();
    let mut changed = true;
    while changed {
        changed = false;
        for v in 0..n {
            if !net.alive[v] || net.component_size(v) <= 3 {
                continue;
            }
            let (a, b) = (net.prev[v], net.next[v]);
            if boxed.contains(&net.id[a]) || boxed.contains(&net.id[v]) {
                continue;
            }
            let (pa, p, pb) = (net.pos[a], net.pos[v], net.pos[b]);
            let (u, w) = (sub(p, pa), sub(pb, p));
            let turn = cross(u, w).atan2(u.0 * w.0 + u.1 * w.1).abs();
            if turn > max_turn {
                continue;
            }
            let (ca, cv) = (&crossing[&a], &crossing[&v]);
            if !ca.is_disjoint(cv) {
                continue;
            }
            let want: HashSet<usize> = ca.union(cv).copied().collect();
            // the merged segment a → b, ignoring the vanishing segment v
            let got: HashSet<usize> = net
                .segs()
                .filter(|&t| t != v && t != a && t != b && net.next[t] != a)
                .filter(|&t| crosses(pa, pb, net.pos[t], net.pos[net.next[t]]))
                .collect();
            if got != want || !net.clear(pa, pb, &[a, v, b], gap) {
                continue;
            }
            // remove v
            net.alive[v] = false;
            net.next[a] = b;
            net.prev[b] = a;
            crossing.insert(a, want.clone());
            crossing.remove(&v);
            for t in &want {
                let set = crossing.get_mut(t).unwrap();
                set.remove(&v);
                set.insert(a);
            }
            merged_into.insert(v, a);
            changed = true;
        }
    }
    write_back(d, &net, &merged_into);
}

fn write_back(d: &mut Drawing, net: &Net, merged_into: &HashMap<usize, usize>) {
    // segment ids: a removed vertex's segment is now its live predecessor's
    let index_of: HashMap<u32, usize> = net.id.iter().enumerate().map(|(i, &id)| (id, i)).collect();
    let resolve = |id: u32| {
        let mut v = index_of[&id];
        while let Some(&u) = merged_into.get(&v) {
            v = u;
        }
        net.id[v]
    };
    let mut k = 0;
    for poly in &mut d.components {
        let start = k;
        k += poly.len();
        let first_alive = (start..k)
            .find(|&v| net.alive[v])
            .expect("components keep 3 vertices");
        let mut out = Vec::new();
        let mut v = first_alive;
        loop {
            out.push(crate::geometry::Vertex {
                id: net.id[v],
                x: net.pos[v].0,
                y: net.pos[v].1,
            });
            v = net.next[v];
            if v == first_alive {
                break;
            }
        }
        *poly = out;
    }
    for o in &mut d.over {
        *o = [resolve(o[0]), resolve(o[1]), resolve(o[2])];
    }
    for b in &mut d.boxes {
        b.a = resolve(b.a);
        b.b = resolve(b.b);
    }
}

/// Scales and translates the drawing (aspect kept) to fill `view` with a
/// margin.
pub fn fit(d: &mut Drawing, view: crate::layout::Rect) {
    let pts: Vec<&crate::geometry::Vertex> = d.components.iter().flatten().collect();
    if pts.is_empty() {
        return;
    }
    let (mut x0, mut x1, mut y0, mut y1) =
        (f64::INFINITY, f64::NEG_INFINITY, f64::INFINITY, f64::NEG_INFINITY);
    for v in &pts {
        x0 = x0.min(v.x);
        x1 = x1.max(v.x);
        y0 = y0.min(v.y);
        y1 = y1.max(v.y);
    }
    let margin = 0.07;
    let s = ((1.0 - 2.0 * margin) * view.w / (x1 - x0).max(1e-9))
        .min((1.0 - 2.0 * margin) * view.h / (y1 - y0).max(1e-9));
    let (ox, oy) = (
        view.x + (view.w - s * (x1 - x0)) / 2.0,
        view.y + (view.h - s * (y1 - y0)) / 2.0,
    );
    for v in d.components.iter_mut().flatten() {
        v.x = ox + (v.x - x0) * s;
        v.y = oy + (v.y - y0) * s;
    }
}
