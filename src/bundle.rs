//! Bundles: a component drawn once that stands for several parallel copies.
//!
//! `Drawing::mult[c]` copies of component `c` follow it side by side
//! (blackboard framing), spaced `spacing` apart along the left normal.  Every
//! crossing of the drawing becomes a grid of crossings of the copies, all
//! with the drawn crossing's over/under choice; a twist box on a bundle
//! twists all its copies together.  The expansion is geometric: the copies
//! are offset polygons (mitered at the vertices), the crossings of the copies
//! are found as for any drawing, and each is matched to the drawn crossing it
//! comes from (same two components, segments at most one vertex apart).

use crate::geometry::{analyze, Drawing, Vertex};
use std::collections::HashMap;

type P = (f64, f64);

/// Does the drawing have a component with a multiplicity other than one?
pub fn has_bundles(d: &Drawing) -> bool {
    d.mult.iter().any(|&m| m != 1)
}

fn mult_of(d: &Drawing, c: usize) -> usize {
    d.mult.get(c).copied().unwrap_or(1) as usize
}

/// A spacing that keeps the copies close to the drawn strand: a small
/// fraction of the shortest segment, divided by the widest bundle.
pub fn default_spacing(d: &Drawing) -> f64 {
    let shortest = d
        .components
        .iter()
        .flat_map(|poly| {
            (0..poly.len()).map(move |k| {
                let (a, b) = (&poly[k], &poly[(k + 1) % poly.len()]);
                (a.x - b.x).hypot(a.y - b.y)
            })
        })
        .fold(f64::INFINITY, f64::min);
    let widest = (0..d.components.len())
        .map(|c| mult_of(d, c))
        .max()
        .unwrap_or(1)
        .max(1);
    0.04 * shortest / widest as f64
}

/// The drawing with every bundle replaced by its parallel copies.
pub fn expand(d: &Drawing, spacing: f64) -> Result<Drawing, String> {
    if !has_bundles(d) {
        return Ok(d.clone());
    }
    // the drawn diagram decides every over/under choice (its boxes only act
    // on the copies)
    let drawn = Drawing {
        mult: Vec::new(),
        boxes: Vec::new(),
        ..d.clone()
    };
    let (orig, _) = analyze(&drawn)?;
    let mut where_orig: HashMap<u32, (usize, usize, usize)> = HashMap::new(); // id -> (component, index, length)
    for (c, poly) in d.components.iter().enumerate() {
        for (k, v) in poly.iter().enumerate() {
            where_orig.insert(v.id, (c, k, poly.len()));
        }
    }
    let mut next_id = d.components.iter().flatten().map(|v| v.id).max().unwrap_or(0) + 1;
    let mut components = Vec::new();
    let mut copy_of: HashMap<(u32, usize), u32> = HashMap::new(); // (drawn id, copy) -> id
    let mut origin: HashMap<u32, u32> = HashMap::new(); // id -> drawn id
    for (c, poly) in d.components.iter().enumerate() {
        let k = mult_of(d, c);
        let n = poly.len();
        // left normals of the segments (screen coordinates, y down)
        let normal: Vec<P> = (0..n)
            .map(|j| {
                let (a, b) = (&poly[j], &poly[(j + 1) % n]);
                let (dx, dy) = (b.x - a.x, b.y - a.y);
                let l = dx.hypot(dy).max(1e-300);
                (dy / l, -dx / l)
            })
            .collect();
        for i in 0..k {
            let t = (i as f64 - (k as f64 - 1.0) / 2.0) * spacing;
            let copy: Vec<Vertex> = (0..n)
                .map(|j| {
                    let (a, b) = (normal[(j + n - 1) % n], normal[j]);
                    let denom = 1.0 + a.0 * b.0 + a.1 * b.1;
                    let miter = if denom > 0.2 {
                        ((a.0 + b.0) / denom, (a.1 + b.1) / denom)
                    } else {
                        b
                    };
                    let id = if k == 1 {
                        poly[j].id
                    } else {
                        next_id += 1;
                        next_id - 1
                    };
                    copy_of.insert((poly[j].id, i), id);
                    origin.insert(id, poly[j].id);
                    Vertex {
                        id,
                        x: poly[j].x + t * miter.0,
                        y: poly[j].y + t * miter.1,
                    }
                })
                .collect();
            components.push(copy);
        }
    }
    // crossings of the copies, each matched to the drawn crossing it comes from
    let copies = Drawing {
        components,
        over: Vec::new(),
        boxes: Vec::new(),
        mult: Vec::new(),
    };
    let near = |a: u32, b: u32| {
        let (ca, ka, n) = where_orig[&a];
        let (cb, kb, _) = where_orig[&b];
        let d = ka.abs_diff(kb);
        ca == cb && d.min(n - d) <= 1
    };
    let mut over = Vec::new();
    for h in crate::geometry::crossing_pairs(&copies)? {
        let (sa, sb, at) = h;
        let (oa, ob) = (origin[&sa], origin[&sb]);
        let mut best: Option<(f64, u32)> = None;
        for x in &orig.crossings {
            for (pa, pb) in [(x.a, x.b), (x.b, x.a)] {
                if near(oa, pa) && near(ob, pb) {
                    let dist = (x.x - at.0).hypot(x.y - at.1);
                    let top = if x.over == pa { sa } else { sb };
                    if best.is_none_or(|(bd, _)| dist < bd) {
                        best = Some((dist, top));
                    }
                }
            }
        }
        let Some((_, top)) = best else {
            return Err(
                "a bundle is too wide where its strand turns sharply; give that corner more room".into(),
            );
        };
        over.push([sa, sb, top]);
    }
    if over.len() != expected_crossings(d, &orig) {
        return Err("a bundle is too wide where its strand turns sharply; give that corner more room".into());
    }
    // twist boxes twist every copy of their strands
    let boxes = d
        .boxes
        .iter()
        .map(|b| {
            let segs = b
                .strands()
                .into_iter()
                .flat_map(|s| {
                    let k = where_orig.get(&s).map_or(1, |&(c, _, _)| mult_of(d, c));
                    (0..k).map(move |i| (s, i))
                })
                .filter_map(|key| copy_of.get(&key).copied())
                .collect();
            crate::geometry::TwistBox::new_segs(segs, b.n)
        })
        .collect();
    Ok(Drawing {
        boxes,
        over,
        ..copies
    })
}

/// Crossings the expansion must have: each drawn crossing of components `a`
/// and `b` becomes `mult(a) · mult(b)` crossings.
fn expected_crossings(d: &Drawing, orig: &crate::geometry::Analysis) -> usize {
    let comp_of: HashMap<u32, usize> = d
        .components
        .iter()
        .enumerate()
        .flat_map(|(c, poly)| poly.iter().map(move |v| (v.id, c)))
        .collect();
    orig.crossings
        .iter()
        .map(|x| mult_of(d, comp_of[&x.a]) * mult_of(d, comp_of[&x.b]))
        .sum()
}
