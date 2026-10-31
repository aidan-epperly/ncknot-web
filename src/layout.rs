//! Drawing a PD code: a planar straight-line layout of the diagram.
//!
//! The projection is a 4-valent plane graph whose faces ncknot knows
//! ([`Diagram::faces`]).  It is refined into a triangulation: every edge is
//! subdivided twice, every corner of a crossing gets a vertex (joined to the
//! crossing and the subdivision points on both sides), and every face gets
//! a center joined to its corners and subdivision points.  Face boundaries
//! are then simple cycles even where a nugatory crossing meets a face twice,
//! so the graph is 3-connected, and Tutte's barycentric embedding (the
//! outer face on a circle, every other vertex at the average of its
//! neighbors) draws it without crossings and with convex faces.  The knot
//! is the polyline through the
//! subdivision points.  At a crossing the two strands do not pass through
//! the crossing vertex itself: each becomes a short chord between points on
//! its two edges near the vertex, and since the four edges leave the vertex
//! in the PD code's counterclockwise order, the two chords cross there and
//! nowhere else.  The result is then relaxed and simplified
//! ([`crate::relax`]), which keeps every crossing.

use crate::geometry::{Drawing, Vertex};
use faer::linalg::solvers::Solve;
use faer::Mat;
use ncknot::Diagram;
use std::collections::HashMap;

/// The view rectangle to fill, in screen coordinates.
#[derive(Clone, Copy, Debug, serde::Deserialize)]
pub struct Rect {
    /// Left.
    pub x: f64,
    /// Top.
    pub y: f64,
    /// Width.
    pub w: f64,
    /// Height.
    pub h: f64,
}

type P = (f64, f64);

/// The layout of one connected piece of the projection: positions of the
/// crossings and edge subdivision points (math coordinates, y up), keyed as
/// below.
struct Piece {
    /// Position of crossing `c`.
    cross: HashMap<usize, P>,
    /// Positions of the two subdivision points of edge `e` (tail side first).
    mids: HashMap<usize, [P; 2]>,
}

fn layout_piece(d: &Diagram, crossings: &[usize]) -> Result<Piece, String> {
    let in_piece: std::collections::HashSet<usize> = crossings.iter().copied().collect();
    let edges: Vec<usize> = (0..d.edges())
        .filter(|&e| in_piece.contains(&d.edge_ends(e)[0].0))
        .collect();
    // vertex numbering: crossings, then 2 per edge, then faces
    let mut vid: HashMap<(u8, usize), usize> = HashMap::new();
    let mut count = 0;
    let mut id = |key: (u8, usize), vid: &mut HashMap<(u8, usize), usize>| {
        *vid.entry(key).or_insert_with(|| {
            count += 1;
            count - 1
        })
    };
    for &c in crossings {
        id((0, c), &mut vid);
    }
    for &e in &edges {
        id((1, e), &mut vid);
        id((2, e), &mut vid);
    }
    let mut adj: Vec<Vec<usize>> = Vec::new();
    let link = |u: usize, v: usize, adj: &mut Vec<Vec<usize>>| {
        let n = u.max(v) + 1;
        if adj.len() < n {
            adj.resize(n, Vec::new());
        }
        if u != v && !adj[u].contains(&v) {
            adj[u].push(v);
            adj[v].push(u);
        }
    };
    for &e in &edges {
        let [(t, _), (h, _)] = d.edge_ends(e);
        let (vt, v1, v2, vh) = (vid[&(0, t)], vid[&(1, e)], vid[&(2, e)], vid[&(0, h)]);
        link(vt, v1, &mut adj);
        link(v1, v2, &mut adj);
        link(v2, vh, &mut adj);
    }
    // the subdivision point of the edge at slot s of crossing c next to c
    let near = |c: usize, s: u8| {
        let e = d.crossing(c)[s as usize];
        if d.edge_ends(e)[0] == (c, s) {
            (1u8, e)
        } else {
            (2u8, e)
        }
    };
    // corner vertices: (c, k) sits between slots k and k + 1, joined to c and
    // to the subdivision points on both sides
    for &c in crossings {
        for k in 0..4u8 {
            let v = id((4, 4 * c + k as usize), &mut vid);
            link(v, vid[&(0, c)], &mut adj);
            link(v, vid[&near(c, k)], &mut adj);
            link(v, vid[&near(c, (k + 1) % 4)], &mut adj);
        }
    }
    // face boundaries through corners and subdivision points: simple cycles,
    // even where a nugatory crossing meets a face twice
    let faces: Vec<Vec<usize>> = d
        .faces()
        .into_iter()
        .filter(|f| in_piece.contains(&f[0].0))
        .map(|f| {
            let mut cycle = Vec::new();
            for &(c, k) in &f {
                cycle.push(vid[&(4, 4 * c + k as usize)]);
                let e = d.crossing(c)[k as usize];
                if d.edge_ends(e)[0] == (c, k) {
                    cycle.extend([vid[&(1, e)], vid[&(2, e)]]);
                } else {
                    cycle.extend([vid[&(2, e)], vid[&(1, e)]]);
                }
            }
            cycle
        })
        .collect();
    let outer = (0..faces.len())
        .max_by_key(|&f| faces[f].len())
        .ok_or("no faces")?;
    // a center in every other face; the result is a triangulation
    for (f, cycle) in faces.iter().enumerate() {
        if f == outer {
            continue;
        }
        let v = id((3, f), &mut vid);
        for &u in cycle {
            link(v, u, &mut adj);
        }
    }
    let n = count;
    adj.resize(n, Vec::new());
    // the outer face on a circle, in the order that keeps the rotation
    // system counterclockwise (faces are traced with the face on the left)
    let boundary = &faces[outer];
    let mut pos: Vec<Option<P>> = vec![None; n];
    let m = boundary.len() as f64;
    for (i, &v) in boundary.iter().enumerate() {
        let a = -2.0 * std::f64::consts::PI * i as f64 / m;
        pos[v] = Some((a.cos(), a.sin()));
    }
    // Tutte: L_II x_I = −L_IB x_B
    let interior: Vec<usize> = (0..n).filter(|&v| pos[v].is_none()).collect();
    let index: HashMap<usize, usize> = interior.iter().enumerate().map(|(i, &v)| (v, i)).collect();
    let k = interior.len();
    let mut lap = Mat::<f64>::zeros(k, k);
    let mut rhs = Mat::<f64>::zeros(k, 2);
    for (i, &v) in interior.iter().enumerate() {
        lap[(i, i)] = adj[v].len() as f64;
        for &u in &adj[v] {
            match (index.get(&u), pos[u]) {
                (Some(&j), _) => lap[(i, j)] -= 1.0,
                (None, Some((x, y))) => {
                    rhs[(i, 0)] += x;
                    rhs[(i, 1)] += y;
                }
                (None, None) => unreachable!(),
            }
        }
    }
    if k > 0 {
        let sol = lap.partial_piv_lu().solve(&rhs);
        for (i, &v) in interior.iter().enumerate() {
            pos[v] = Some((sol[(i, 0)], sol[(i, 1)]));
        }
    }
    let at = |key: (u8, usize)| pos[vid[&key]].unwrap();
    Ok(Piece {
        cross: crossings.iter().map(|&c| (c, at((0, c)))).collect(),
        mids: edges.iter().map(|&e| (e, [at((1, e)), at((2, e))])).collect(),
    })
}

/// The connected pieces of the projection, as lists of crossings.
fn pieces(d: &Diagram) -> Vec<Vec<usize>> {
    let n = d.crossings();
    let mut seen = vec![false; n];
    let mut out = Vec::new();
    for s in 0..n {
        if seen[s] {
            continue;
        }
        seen[s] = true;
        let mut stack = vec![s];
        let mut piece = Vec::new();
        while let Some(c) = stack.pop() {
            piece.push(c);
            for e in d.crossing(c) {
                for (c2, _) in d.edge_ends(e) {
                    if !seen[c2] {
                        seen[c2] = true;
                        stack.push(c2);
                    }
                }
            }
        }
        piece.sort_unstable();
        out.push(piece);
    }
    out
}

/// Lays out a diagram in `view`; vertex ids start at `first_id`.  Returns
/// the drawing and the next free id.
pub fn layout(d: &Diagram, view: Rect, first_id: u32) -> Result<(Drawing, u32), String> {
    let pieces = pieces(d);
    let slots = pieces.len() + d.free_loops();
    if slots == 0 {
        return Ok((Drawing::default(), first_id));
    }
    // each piece or loop gets a square cell in a row
    let cell = (view.w / slots as f64).min(view.h);
    let x0 = view.x + (view.w - cell * slots as f64) / 2.0;
    let y0 = view.y + (view.h - cell) / 2.0;
    let mut cross: HashMap<usize, P> = HashMap::new();
    let mut mids: HashMap<usize, [P; 2]> = HashMap::new();
    for (i, piece) in pieces.iter().enumerate() {
        let lp = layout_piece(d, piece)?;
        // unit disk → cell, flipping y for the screen
        let (cx, cy, r) = (x0 + cell * (i as f64 + 0.5), y0 + cell / 2.0, cell * 0.42);
        let map = |(x, y): P| (cx + r * x, cy - r * y);
        cross.extend(lp.cross.into_iter().map(|(c, p)| (c, map(p))));
        mids.extend(lp.mids.into_iter().map(|(e, [a, b])| (e, [map(a), map(b)])));
    }
    let mut next = first_id;
    let mut components: Vec<Vec<Vertex>> = Vec::new();
    // the chord ends near crossing c on slot s
    let neighbor = |c: usize, s: u8| {
        let e = d.crossing(c)[s as usize];
        let [tail, _] = d.edge_ends(e);
        if tail == (c, s) {
            mids[&e][0]
        } else {
            mids[&e][1]
        }
    };
    let chord_end = |c: usize, s: u8| {
        let p = cross[&c];
        let reach = (0..4)
            .map(|t| {
                let q = neighbor(c, t);
                (q.0 - p.0).hypot(q.1 - p.1)
            })
            .fold(f64::INFINITY, f64::min);
        let q = neighbor(c, s);
        let len = (q.0 - p.0).hypot(q.1 - p.1).max(1e-12);
        let eps = 0.4 * reach;
        (p.0 + eps * (q.0 - p.0) / len, p.1 + eps * (q.1 - p.1) / len)
    };
    // components: follow the edges; the chord through a crossing starts at
    // the point where the incoming edge ends
    let mut chord: HashMap<(usize, u8), u32> = HashMap::new();
    let mut done = vec![false; d.edges()];
    for e0 in 0..d.edges() {
        if done[e0] {
            continue;
        }
        let mut poly = Vec::new();
        let mut e = e0;
        while !done[e] {
            done[e] = true;
            let [(tc, ts), (hc, hs)] = d.edge_ends(e);
            let pts = [chord_end(tc, ts), mids[&e][0], mids[&e][1], chord_end(hc, hs)];
            for (j, p) in pts.into_iter().enumerate() {
                if j == 3 {
                    chord.insert((hc, hs), next);
                }
                poly.push(Vertex {
                    id: next,
                    x: p.0,
                    y: p.1,
                });
                next += 1;
            }
            e = d.crossing(hc)[((hs + 2) % 4) as usize];
        }
        components.push(poly);
    }
    let over = (0..d.crossings())
        .map(|c| {
            let u = chord[&(c, 0)];
            let o = chord[&(c, d.over_in_slot(c))];
            [u, o, o]
        })
        .collect();
    // crossingless loops: hexagons in the remaining cells
    for j in 0..d.free_loops() {
        let (cx, cy, r) = (
            x0 + cell * ((pieces.len() + j) as f64 + 0.5),
            y0 + cell / 2.0,
            cell * 0.3,
        );
        components.push(
            (0..6)
                .map(|k| {
                    let a = std::f64::consts::PI * k as f64 / 3.0;
                    next += 1;
                    Vertex {
                        id: next - 1,
                        x: cx + r * a.cos(),
                        y: cy + r * a.sin(),
                    }
                })
                .collect(),
        );
    }
    let mut drawing = Drawing {
        components,
        over,
        boxes: Vec::new(),
    };
    // Tutte drawings crowd the middle: relax, drop straight vertices, refit
    let iterations = (4000 / (d.crossings() + 10)).clamp(25, 160);
    crate::relax::relax(&mut drawing, iterations);
    crate::relax::simplify(&mut drawing, 0.25);
    crate::relax::fit(&mut drawing, view);
    Ok((drawing, next))
}
