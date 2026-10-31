//! From a drawing (closed polygons, one per component) to a PD code.
//!
//! Vertices carry stable ids chosen by the editor; a segment is named by the
//! id of its first vertex, so a crossing is named by the pair of its two
//! segments and its over/under choice survives dragging.  Coordinates are
//! screen coordinates (y pointing down); they are flipped internally so that
//! "counterclockwise" in the PD code means counterclockwise on screen.

use ncknot::Diagram;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

/// A polygon vertex.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Vertex {
    /// Stable id (unique in the drawing).
    pub id: u32,
    /// Screen x.
    pub x: f64,
    /// Screen y (down).
    pub y: f64,
}

/// The editor's state: closed polygons and the chosen over-strands.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct Drawing {
    /// One closed polygon per component, in the direction of travel.
    pub components: Vec<Vec<Vertex>>,
    /// `[segment a, segment b, over segment]` for crossings whose over-strand
    /// was chosen; any other crossing puts the segment with the larger id on
    /// top (the strand drawn last).
    #[serde(default)]
    pub over: Vec<[u32; 3]>,
    /// Twist boxes.
    #[serde(default)]
    pub boxes: Vec<TwistBox>,
}

/// `n` half-twists of a bundle of two or more strands (segments, named by
/// the ids of their first vertices), placed at the segments' midpoints; see
/// [`analyze`].  Older drawings name two strands as `a` and `b`.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct TwistBox {
    /// The strands.
    #[serde(default)]
    pub segs: Vec<u32>,
    /// First strand of a two-strand box (older format).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub a: Option<u32>,
    /// Second strand of a two-strand box (older format).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub b: Option<u32>,
    /// Number of half-twists of the bundle (sign = handedness).
    pub n: i64,
}

impl TwistBox {
    /// A box on these strands.
    pub fn new(segs: &[u32], n: i64) -> Self {
        TwistBox {
            segs: segs.to_vec(),
            n,
            ..Default::default()
        }
    }

    /// The strands, in either format.
    pub fn strands(&self) -> Vec<u32> {
        if self.segs.is_empty() {
            self.a.into_iter().chain(self.b).collect()
        } else {
            self.segs.clone()
        }
    }
}

/// One crossing of the drawing.
#[derive(Clone, Debug, Serialize)]
pub struct CrossingInfo {
    /// Screen position.
    pub x: f64,
    /// Screen position.
    pub y: f64,
    /// The two segments (ids of their first vertices).
    pub a: u32,
    /// See `a`.
    pub b: u32,
    /// The segment on top.
    pub over: u32,
    /// The crossing sign.
    pub sign: i64,
}

/// The analyzed drawing.
#[derive(Clone, Debug, Serialize)]
pub struct Analysis {
    /// Crossings, in PD order.
    pub crossings: Vec<CrossingInfo>,
    /// The PD code (1-based edge labels, as `Diagram::pd_code`).
    pub pd: Vec<[usize; 4]>,
    /// Components without crossings.
    pub free_loops: usize,
    /// Number of components (after twist boxes reconnect strands).
    pub components: usize,
    /// Crossings inside twist boxes.
    pub box_crossings: usize,
}

struct Seg {
    comp: usize,
    k: usize,
    id: u32,
    p: (f64, f64),
    q: (f64, f64),
}

fn cross(a: (f64, f64), b: (f64, f64)) -> f64 {
    a.0 * b.1 - a.1 * b.0
}

fn sub(a: (f64, f64), b: (f64, f64)) -> (f64, f64) {
    (a.0 - b.0, a.1 - b.1)
}

/// A crossing between two segments: positions `t`, `u` along them.
struct Hit {
    i: usize,
    j: usize,
    t: f64,
    u: f64,
    at: (f64, f64),
}

fn segments(d: &Drawing) -> Result<Vec<Seg>, String> {
    let mut ids = HashSet::new();
    let mut segs = Vec::new();
    for (c, poly) in d.components.iter().enumerate() {
        if poly.len() < 3 {
            return Err(format!("component {} has fewer than 3 vertices", c + 1));
        }
        for (k, v) in poly.iter().enumerate() {
            if !v.x.is_finite() || !v.y.is_finite() {
                return Err("a vertex has a non-finite coordinate".into());
            }
            if !ids.insert(v.id) {
                return Err(format!("vertex id {} is used twice", v.id));
            }
            let w = &poly[(k + 1) % poly.len()];
            // flip y: screen counterclockwise = mathematical counterclockwise
            segs.push(Seg {
                comp: c,
                k,
                id: v.id,
                p: (v.x, -v.y),
                q: (w.x, -w.y),
            });
        }
    }
    Ok(segs)
}

fn intersections(segs: &[Seg], sizes: &[usize]) -> Result<Vec<Hit>, String> {
    let mut hits = Vec::new();
    for i in 0..segs.len() {
        for j in i + 1..segs.len() {
            let (a, b) = (&segs[i], &segs[j]);
            if a.comp == b.comp {
                let n = sizes[a.comp];
                if (a.k + 1) % n == b.k || (b.k + 1) % n == a.k {
                    continue; // neighbors share a vertex
                }
            }
            let r = sub(a.q, a.p);
            let s = sub(b.q, b.p);
            let scale = (r.0.hypot(r.1) * s.0.hypot(s.1)).max(1e-300);
            let den = cross(r, s);
            let w = sub(b.p, a.p);
            if den.abs() <= 1e-12 * scale {
                // parallel: only an overlap is a problem
                if cross(w, r).abs() <= 1e-9 * scale {
                    let rr = r.0 * r.0 + r.1 * r.1;
                    let t0 = (w.0 * r.0 + w.1 * r.1) / rr;
                    let t1 = t0 + (s.0 * r.0 + s.1 * r.1) / rr;
                    if t0.max(t1) > 0.0 && t0.min(t1) < 1.0 {
                        return Err("two strands overlap; move a vertex".into());
                    }
                }
                continue;
            }
            let t = cross(w, s) / den;
            let u = cross(w, r) / den;
            let eps = 1e-9;
            let inside = |x: f64| x > eps && x < 1.0 - eps;
            let near = |x: f64| x > -eps && x < 1.0 + eps;
            if inside(t) && inside(u) {
                hits.push(Hit {
                    i,
                    j,
                    t,
                    u,
                    at: (a.p.0 + t * r.0, a.p.1 + t * r.1),
                });
            } else if near(t) && near(u) {
                return Err("a vertex lies on a strand; move it slightly".into());
            }
        }
    }
    Ok(hits)
}

/// The over segment of every crossing (`chosen` overrides, else the larger id).
fn over_choice(chosen: &[[u32; 3]]) -> HashMap<(u32, u32), u32> {
    chosen
        .iter()
        .filter(|[a, b, o]| o == a || o == b)
        .map(|&[a, b, o]| ((a.min(b), a.max(b)), o))
        .collect()
}

/// A passage of a component through a crossing or a twist box.
#[derive(Clone, Copy)]
enum Through {
    /// Drawing crossing `c`; over-strand?
    Crossing(usize, bool),
    /// Twist box `b`; strand `a` (0) or `b` (1) of the box.
    Box(usize, usize),
}

/// `(edge in, edge out, direction of the segment)` of a passage.
type Ends = (i64, i64, (f64, f64));

/// Analyses a drawing: crossings, signs and the PD code, with the diagram.
///
/// Drawing crossings come first in the PD code, then the crossings of the
/// twist boxes in box order.  Each box sits at the midpoints of its two
/// segments and holds `|n|` half-twists: looking along segment `a`, the
/// strand coming from the left passes over when `n > 0`, so two parallel
/// strands get positive crossings.  An odd box reconnects its strands; the
/// orientation of every component is then solved over the whole diagram,
/// keeping the drawn direction where it can.
pub fn analyze(d: &Drawing) -> Result<(Analysis, Diagram), String> {
    let segs = segments(d)?;
    let sizes: Vec<usize> = d.components.iter().map(|p| p.len()).collect();
    let hits = intersections(&segs, &sizes)?;
    let chosen = over_choice(&d.over);
    let seg_of: HashMap<u32, usize> = segs.iter().enumerate().map(|(i, s)| (s.id, i)).collect();
    // twist boxes with n ≠ 0: strands ordered left to right looking along the
    // first one, with that direction
    let mut boxes: Vec<(Vec<usize>, i64, (f64, f64))> = Vec::new();
    let mut used = HashSet::new();
    for tb in d.boxes.iter().filter(|b| b.n != 0) {
        let ids = tb.strands();
        if ids.len() < 2 {
            return Err("a twist box needs at least two strands".into());
        }
        let mut idx = Vec::with_capacity(ids.len());
        for id in &ids {
            let Some(&i) = seg_of.get(id) else {
                return Err("a twist box refers to a strand that no longer exists".into());
            };
            if !used.insert(i) {
                return Err("a strand can be in only one twist box, once".into());
            }
            idx.push(i);
        }
        let u = sub(segs[idx[0]].q, segs[idx[0]].p);
        let left = (-u.1, u.0);
        let m0 = mid(&segs[idx[0]]);
        let offset = |i: usize| {
            let m = sub(mid(&segs[i]), m0);
            m.0 * left.0 + m.1 * left.1
        };
        idx.sort_by(|&x, &y| offset(y).partial_cmp(&offset(x)).unwrap());
        // nothing may pass between neighbouring strands of the bundle
        for w in idx.windows(2) {
            let (p, q) = (mid(&segs[w[0]]), mid(&segs[w[1]]));
            if segs
                .iter()
                .enumerate()
                .any(|(k, s)| k != w[0] && k != w[1] && meets(p, q, s.p, s.q))
            {
                return Err("a strand passes between the strands of a twist box".into());
            }
        }
        boxes.push((idx, tb.n, u));
    }
    // passages along each component: (k, t, through)
    let mut passages: Vec<Vec<(usize, f64, Through)>> = vec![Vec::new(); sizes.len()];
    let mut overs = Vec::with_capacity(hits.len());
    for (c, h) in hits.iter().enumerate() {
        let (a, b) = (&segs[h.i], &segs[h.j]);
        let key = (a.id.min(b.id), a.id.max(b.id));
        let over = chosen.get(&key).copied().unwrap_or(key.1);
        overs.push(over);
        passages[a.comp].push((a.k, h.t, Through::Crossing(c, over == a.id)));
        passages[b.comp].push((b.k, h.u, Through::Crossing(c, over == b.id)));
    }
    for (bi, (idx, _, _)) in boxes.iter().enumerate() {
        for (pos, &i) in idx.iter().enumerate() {
            passages[segs[i].comp].push((segs[i].k, 0.5, Through::Box(bi, pos)));
        }
    }
    // edges: per component, edge j leaves passage j
    let mut at_crossing: Vec<[Option<Ends>; 2]> = vec![[None, None]; hits.len()];
    let mut at_box: Vec<Vec<Option<Ends>>> = boxes.iter().map(|(idx, _, _)| vec![None; idx.len()]).collect();
    let mut base = 1i64;
    let mut free = 0;
    for (comp, list) in passages.iter_mut().enumerate() {
        if list.is_empty() {
            free += 1;
            continue;
        }
        list.sort_by(|x, y| (x.0, x.1).partial_cmp(&(y.0, y.1)).unwrap());
        let m = list.len() as i64;
        for (j, &(k, _, through)) in list.iter().enumerate() {
            let j = j as i64;
            let seg = &segs[seg_of[&d.components[comp][k].id]];
            let ends = (base + (j - 1).rem_euclid(m), base + j, sub(seg.q, seg.p));
            match through {
                Through::Crossing(c, over) => at_crossing[c][usize::from(over)] = Some(ends),
                Through::Box(b, s) => at_box[b][s] = Some(ends),
            }
        }
        base += m;
    }
    // crossings counterclockwise with the under-strand at slots 0 and 2, and
    // the drawn direction of the edges leaving them
    let mut code: Vec<[i64; 4]> = Vec::new();
    let mut hint: HashMap<i64, (usize, usize)> = HashMap::new();
    for (c, ends) in at_crossing.iter().enumerate() {
        let (ui, uo, du) = ends[0].expect("under passage");
        let (oi, oo, dov) = ends[1].expect("over passage");
        // counterclockwise from the incoming under-strand (direction −du)
        let positive = cross((-du.0, -du.1), dov) > 0.0;
        code.push(if positive {
            [ui, oo, uo, oi]
        } else {
            [ui, oi, uo, oo]
        });
        hint.insert(uo, (c, 2));
        hint.insert(oo, (c, if positive { 1 } else { 3 }));
    }
    let mut fresh = base;
    for (bi, (idx, n, u)) in boxes.iter().enumerate() {
        let k = idx.len();
        // per position (left to right): the edge at the bottom and the edge at
        // the top of the box, looking along u
        let mut bottom = Vec::with_capacity(k);
        let mut top = Vec::with_capacity(k);
        let mut along = Vec::with_capacity(k);
        for slot in &at_box[bi] {
            let (e_in, e_out, dir) = slot.expect("box passage");
            let parallel = dir.0 * u.0 + dir.1 * u.1 > 0.0;
            along.push(parallel);
            if parallel {
                bottom.push(e_in);
                top.push(e_out);
            } else {
                bottom.push(e_out);
                top.push(e_in);
            }
        }
        // Δ^n, Δ = (σ_1 ⋯ σ_{k-1})(σ_1 ⋯ σ_{k-2}) ⋯ σ_1: positions of the generators
        let delta: Vec<usize> = (1..k).rev().flat_map(|m| 0..m).collect();
        let first = code.len();
        let mut cur = bottom.clone();
        for _ in 0..n.unsigned_abs() {
            for &i in &delta {
                let (l, r) = (i, i + 1);
                fresh += 2;
                let (tl, tr) = (fresh - 2, fresh - 1);
                // corners: BR = cur[r], TR = tr, TL = tl, BL = cur[l]; "/" is BL–TR
                code.push(if *n > 0 {
                    [cur[r], tr, tl, cur[l]] // "/" over: the under-strand is BR–TL
                } else {
                    [cur[l], cur[r], tr, tl] // "\" over: the under-strand is BL–TR
                });
                cur[l] = tl;
                cur[r] = tr;
            }
        }
        // the edges leaving the top are the strands' continuations
        let rename: HashMap<i64, i64> = cur.iter().copied().zip(top.iter().copied()).collect();
        for x in &mut code[first..] {
            for l in x.iter_mut() {
                if let Some(&t) = rename.get(l) {
                    *l = t;
                }
            }
        }
        // the drawn direction: where each strand's outgoing edge leaves the box
        let (top_slots, bottom_slots): ([usize; 2], [usize; 2]) = if *n > 0 {
            ([1, 2], [0, 3])
        } else {
            ([2, 3], [0, 1])
        };
        for pos in 0..k {
            let (_, e_out, _) = at_box[bi][pos].unwrap();
            let found = if along[pos] {
                (first..code.len())
                    .rev()
                    .find_map(|c| top_slots.iter().find(|&&t| code[c][t] == e_out).map(|&t| (c, t)))
            } else {
                (first..code.len()).find_map(|c| {
                    bottom_slots
                        .iter()
                        .find(|&&t| code[c][t] == e_out)
                        .map(|&t| (c, t))
                })
            };
            if let Some(h) = found {
                hint.entry(e_out).or_insert(h);
            }
        }
    }
    let code = orient(&code, &hint)?;
    let diagram = if code.is_empty() {
        Diagram::unlink(free)
    } else {
        let dg = Diagram::from_pd(&code).map_err(|e| {
            if boxes.is_empty() {
                e.to_string()
            } else {
                format!("{e} (are the twist box strands next to each other?)")
            }
        })?;
        if free > 0 {
            dg.disjoint_union(&Diagram::unlink(free))
        } else {
            dg
        }
    };
    let crossings = hits
        .iter()
        .enumerate()
        .map(|(c, h)| CrossingInfo {
            x: h.at.0,
            y: -h.at.1,
            a: segs[h.i].id,
            b: segs[h.j].id,
            over: overs[c],
            sign: diagram.sign(c),
        })
        .collect();
    Ok((
        Analysis {
            crossings,
            pd: diagram.pd_code(),
            free_loops: free,
            components: diagram.components(),
            box_crossings: code.len() - hits.len(),
        },
        diagram,
    ))
}

fn mid(s: &Seg) -> (f64, f64) {
    ((s.p.0 + s.q.0) / 2.0, (s.p.1 + s.q.1) / 2.0)
}

/// Do the closed segments `pq` and `rs` meet?
fn meets(p: (f64, f64), q: (f64, f64), r: (f64, f64), s: (f64, f64)) -> bool {
    let side = |a: (f64, f64), b: (f64, f64), c: (f64, f64)| cross(sub(b, a), sub(c, a));
    let (d1, d2) = (side(p, q, r), side(p, q, s));
    let (d3, d4) = (side(r, s, p), side(r, s, q));
    d1 * d2 <= 0.0 && d3 * d4 <= 0.0 && !(d1 == 0.0 && d2 == 0.0)
}

/// Orients unoriented crossings (counterclockwise labels, under-strand at
/// slots 0 and 2) into PD form: every component gets the direction of its
/// first hinted edge (`hint`: the slot an edge leaves), or an arbitrary one,
/// and each crossing is rotated to start at its incoming under-strand.
fn orient(code: &[[i64; 4]], hint: &HashMap<i64, (usize, usize)>) -> Result<Vec<[i64; 4]>, String> {
    let mut occ: HashMap<i64, Vec<(usize, usize)>> = HashMap::new();
    for (c, x) in code.iter().enumerate() {
        for (s, &l) in x.iter().enumerate() {
            occ.entry(l).or_default().push((c, s));
        }
    }
    if let Some((l, _)) = occ.iter().find(|(_, v)| v.len() != 2) {
        return Err(format!("internal: edge {l} does not have two ends"));
    }
    // head[c][s]: does an edge arrive at slot s of crossing c?
    let mut head = vec![[None::<bool>; 4]; code.len()];
    let mut labels: Vec<i64> = occ.keys().copied().collect();
    labels.sort_unstable();
    // hinted edges first, in label order, then the rest
    let mut starts: Vec<(i64, (usize, usize))> = labels
        .iter()
        .filter_map(|l| hint.get(l).map(|&t| (*l, t)))
        .collect();
    starts.extend(labels.iter().map(|l| (*l, occ[l][0])));
    for (l, tail) in starts {
        if head[tail.0][tail.1].is_some() {
            continue; // component already oriented
        }
        let (mut label, mut tail) = (l, tail);
        loop {
            let ends = &occ[&label];
            let h = if ends[0] == tail { ends[1] } else { ends[0] };
            head[tail.0][tail.1] = Some(false);
            head[h.0][h.1] = Some(true);
            // straight through the crossing
            let next = (h.0, (h.1 + 2) % 4);
            if head[next.0][next.1].is_some() {
                break;
            }
            tail = next;
            label = code[next.0][next.1];
        }
    }
    Ok(code
        .iter()
        .enumerate()
        .map(|(c, x)| {
            if head[c][0] == Some(true) {
                *x
            } else {
                [x[2], x[3], x[0], x[1]]
            }
        })
        .collect())
}

/// Over-strand choices that make the drawing alternating: along every
/// component the passages alternate over, under, over, …  The phase of each
/// component is fixed by the crossings it shares with the others.
pub fn alternating(d: &Drawing) -> Result<Vec<[u32; 3]>, String> {
    let segs = segments(d)?;
    let sizes: Vec<usize> = d.components.iter().map(|p| p.len()).collect();
    let hits = intersections(&segs, &sizes)?;
    // passage index along its component of each end of each crossing
    let mut lists: Vec<Vec<(usize, f64, usize, u8)>> = vec![Vec::new(); sizes.len()];
    for (c, h) in hits.iter().enumerate() {
        lists[segs[h.i].comp].push((segs[h.i].k, h.t, c, 0));
        lists[segs[h.j].comp].push((segs[h.j].k, h.u, c, 1));
    }
    let mut index = vec![[(0usize, 0usize); 2]; hits.len()]; // (component, position)
    for (comp, list) in lists.iter_mut().enumerate() {
        list.sort_by(|x, y| (x.0, x.1).partial_cmp(&(y.0, y.1)).unwrap());
        for (pos, &(_, _, c, end)) in list.iter().enumerate() {
            index[c][end as usize] = (comp, pos);
        }
    }
    // phase[comp]: passage `pos` is over iff (pos + phase) is even
    let mut phase: Vec<Option<usize>> = vec![None; sizes.len()];
    for start in 0..sizes.len() {
        if phase[start].is_some() {
            continue;
        }
        phase[start] = Some(0);
        let mut stack = vec![start];
        while let Some(comp) = stack.pop() {
            for ends in &index {
                for e in 0..2 {
                    let (ca, pa) = ends[e];
                    let (cb, pb) = ends[1 - e];
                    if ca != comp {
                        continue;
                    }
                    // exactly one end over: (pa + φa) and (pb + φb) differ in parity
                    let want = (pa + phase[ca].unwrap() + 1 + pb) % 2;
                    match phase[cb] {
                        None => {
                            phase[cb] = Some(want);
                            stack.push(cb);
                        }
                        Some(p) if p != want => {
                            return Err("no alternating choice exists for this drawing".into())
                        }
                        Some(_) => {}
                    }
                }
            }
        }
    }
    Ok(hits
        .iter()
        .enumerate()
        .map(|(c, h)| {
            let (a, b) = (segs[h.i].id, segs[h.j].id);
            let (comp, pos) = index[c][0];
            let a_over = (pos + phase[comp].unwrap()).is_multiple_of(2);
            [a, b, if a_over { a } else { b }]
        })
        .collect())
}
