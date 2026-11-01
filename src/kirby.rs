//! The Kirby tab: a drawing of a family of Kirby diagrams becomes an
//! [`ncknot::kirby::KirbyDiagram`], on which the page runs moves and tables.
//!
//! A drawing is a planar graph of straight segments.  Every segment carries
//! a label: a handle, a width (an expression in the parameters, such as `n`
//! or `n+1`: that many parallel strands) and a direction.  Where segments
//! cross, the drawing records which passes over.  A point where three or
//! more segments meet is a junction: one of its strands is the whole bundle
//! and the others are its parts, side by side.  A twist box is a line drawn
//! across some strands; the strands crossing it get its half-twists, either
//! moved around each other as flat ribbons or each strand on its own.
//!
//! Coordinates are the page's (y down); they are flipped to y up here, so
//! "counterclockwise" is the usual one.

use ncknot::kirby::{HandleKind, KirbyDiagram, NodeKind, Units};
use ncknot::param::Poly;
use ncknot::KnotGroup;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;

/// A parameter: a name and optionally a parity (`"odd"` or `"even"`).
#[derive(Debug, Deserialize)]
pub struct KParam {
    /// Its name.
    pub name: String,
    /// `"odd"`, `"even"` or absent.
    #[serde(default)]
    pub parity: Option<String>,
}

/// A handle.
#[derive(Debug, Deserialize)]
pub struct KHandle {
    /// Its name.
    pub name: String,
    /// `"dotted"` or `"framed"`.
    pub kind: String,
    /// The framing (an expression) of a 2-handle.
    #[serde(default)]
    pub framing: Option<String>,
}

/// A point of the drawing.
#[derive(Debug, Deserialize)]
pub struct KPoint {
    /// Its id.
    pub id: u64,
    /// Page coordinates.
    pub x: f64,
    /// Page coordinates (y down).
    pub y: f64,
}

/// A segment and its label.
#[derive(Debug, Deserialize)]
pub struct KSeg {
    /// Its id.
    pub id: u64,
    /// First endpoint.
    pub a: u64,
    /// Second endpoint.
    pub b: u64,
    /// Index into the handles.
    pub handle: usize,
    /// Number of strands (an expression).
    pub width: String,
    /// `1`: the strands run from `a` to `b`; `−1`: back.
    pub dir: i8,
}

/// A twist box: the line from `p` to `q` across the strands it twists.
#[derive(Debug, Deserialize)]
pub struct KBox {
    /// One end of the line.
    pub p: [f64; 2],
    /// The other end.
    pub q: [f64; 2],
    /// The number of half-twists (an expression).
    pub twists: String,
    /// `"ribbons"` (each strand crossing the line is a flat ribbon) or
    /// `"strands"` (every single strand twists).
    #[serde(default = "ribbons")]
    pub units: String,
}

fn ribbons() -> String {
    "ribbons".into()
}

/// A drawing.
#[derive(Debug, Deserialize)]
pub struct KDrawing {
    /// The parameters.
    #[serde(default)]
    pub params: Vec<KParam>,
    /// The handles.
    pub handles: Vec<KHandle>,
    /// The points.
    pub points: Vec<KPoint>,
    /// The segments.
    pub segs: Vec<KSeg>,
    /// `[seg, seg, the one over]` for the crossings set by hand; otherwise
    /// the later segment passes over.
    #[serde(default)]
    pub over: Vec<[u64; 3]>,
    /// The twist boxes.
    #[serde(default)]
    pub boxes: Vec<KBox>,
}

/// A move.
#[derive(Debug, Deserialize)]
pub struct KMove {
    /// `"cancel"`.
    pub op: String,
    /// The dotted circle.
    pub dotted: String,
    /// The 2-handle through it.
    pub handle: String,
}

/// The page's request.
#[derive(Debug, Deserialize)]
pub struct KRequest {
    /// `"summary"`, `"table"` or `"member"`.
    pub task: String,
    /// The drawing.
    pub drawing: KDrawing,
    /// Moves to apply, in order.
    #[serde(default)]
    pub moves: Vec<KMove>,
    /// For `"table"`: `[from, to]` per parameter.
    #[serde(default)]
    pub ranges: Vec<[i64; 2]>,
    /// For `"member"`: one value per parameter.
    #[serde(default)]
    pub values: Vec<i64>,
    /// For `"table"`: compute the Alexander polynomial up to this many crossings.
    #[serde(default)]
    pub alexander_limit: usize,
    /// For `"table"`: count homomorphisms of the boundary's group to `S_k` (0: no).
    #[serde(default)]
    pub boundary_homs: usize,
}

type P2 = (f64, f64);

fn sub(a: P2, b: P2) -> P2 {
    (a.0 - b.0, a.1 - b.1)
}

fn cross(a: P2, b: P2) -> f64 {
    a.0 * b.1 - a.1 * b.0
}

/// Where segments `p0 p1` and `q0 q1` cross: the parameters along each.
fn intersect(p0: P2, p1: P2, q0: P2, q1: P2) -> Option<(f64, f64)> {
    let r = sub(p1, p0);
    let s = sub(q1, q0);
    let den = cross(r, s);
    if den.abs() < 1e-12 {
        return None;
    }
    let qp = sub(q0, p0);
    let t = cross(qp, s) / den;
    let u = cross(qp, r) / den;
    let eps = 1e-9;
    (t > eps && t < 1.0 - eps && u > eps && u < 1.0 - eps).then_some((t, u))
}

/// A place on a segment to walk from: `(segment index, event index, side)`;
/// the event index is 0 at endpoint `a`, `k + 1` for the `k`-th event along
/// the segment and `events + 1` at `b`; side `+1` walks toward `b`.
type Port = (usize, usize, i8);

/// A strand piece between two stops.
struct Piece {
    start: Port,
    end: Port,
    handle: usize,
    width: Poly,
    /// Relative to walking from `start` to `end`.
    dir: i8,
}

/// Builds the Kirby diagram of a drawing.
pub fn build(d: &KDrawing) -> Result<KirbyDiagram, String> {
    let params: Vec<(&str, Option<bool>)> = d
        .params
        .iter()
        .map(|p| {
            let parity = match p.parity.as_deref() {
                Some("odd") => Some(true),
                Some("even") => Some(false),
                _ => None,
            };
            (p.name.as_str(), parity)
        })
        .collect();
    let mut k = KirbyDiagram::new(&params);
    let names = k.param_names();
    let parse = |s: &str, what: &str| Poly::parse(s, &names).map_err(|e| format!("{what} '{s}': {e}"));
    for h in &d.handles {
        if h.kind == "dotted" {
            k.dotted(&h.name);
        } else {
            let f = parse(
                h.framing.as_deref().unwrap_or("0"),
                &format!("framing of {}", h.name),
            )?;
            k.framed(&h.name, f);
        }
    }
    if d.segs.is_empty() {
        return Err("draw some strands first".into());
    }
    let pt: HashMap<u64, P2> = d.points.iter().map(|p| (p.id, (p.x, -p.y))).collect();
    let mut degree: HashMap<u64, Vec<usize>> = HashMap::new();
    for (i, s) in d.segs.iter().enumerate() {
        if !pt.contains_key(&s.a) || !pt.contains_key(&s.b) || s.a == s.b {
            return Err(format!("segment {} has a bad endpoint", s.id));
        }
        if s.handle >= d.handles.len() {
            return Err(format!("segment {} has no handle", s.id));
        }
        degree.entry(s.a).or_default().push(i);
        degree.entry(s.b).or_default().push(i);
    }
    let ends = |i: usize| (pt[&d.segs[i].a], pt[&d.segs[i].b]);
    let widths: Vec<Poly> = d
        .segs
        .iter()
        .map(|s| parse(&s.width, "width"))
        .collect::<Result<_, _>>()?;

    // events along each segment: crossings and box cuts, with their parameter
    enum Ev {
        Cross(usize),
        Cut(usize, usize),
    }
    let mut events: Vec<Vec<(f64, Ev)>> = (0..d.segs.len()).map(|_| Vec::new()).collect();
    // crossings: (under seg, t, over seg, u)
    let over_set: HashMap<(u64, u64), u64> = d
        .over
        .iter()
        .map(|&[a, b, o]| ((a.min(b), a.max(b)), o))
        .collect();
    let mut crossings: Vec<(usize, f64, usize, f64)> = Vec::new();
    for i in 0..d.segs.len() {
        for j in i + 1..d.segs.len() {
            let (si, sj) = (&d.segs[i], &d.segs[j]);
            if si.a == sj.a || si.a == sj.b || si.b == sj.a || si.b == sj.b {
                continue;
            }
            let (p0, p1) = ends(i);
            let (q0, q1) = ends(j);
            if let Some((t, u)) = intersect(p0, p1, q0, q1) {
                let key = (si.id.min(sj.id), si.id.max(sj.id));
                let over = over_set.get(&key).copied().unwrap_or(key.1);
                let c = if over == si.id { (j, u, i, t) } else { (i, t, j, u) };
                events[c.0].push((c.1, Ev::Cross(crossings.len())));
                events[c.2].push((c.3, Ev::Cross(crossings.len())));
                crossings.push(c);
            }
        }
    }
    // box cuts: per box, (seg, t, position along the line)
    let mut cuts: Vec<Vec<(usize, f64, f64)>> = Vec::new();
    for (bi, b) in d.boxes.iter().enumerate() {
        let (p, q) = ((b.p[0], -b.p[1]), (b.q[0], -b.q[1]));
        let mut v = Vec::new();
        for i in 0..d.segs.len() {
            let (a0, a1) = ends(i);
            if let Some((t, s)) = intersect(a0, a1, p, q) {
                v.push((i, t, s));
            }
        }
        if v.is_empty() {
            return Err(format!("twist box {} crosses no strand", bi + 1));
        }
        v.sort_by(|x, y| x.2.total_cmp(&y.2));
        for (j, &(i, t, _)) in v.iter().enumerate() {
            events[i].push((t, Ev::Cut(bi, j)));
        }
        cuts.push(v);
    }
    for ev in &mut events {
        ev.sort_by(|x, y| x.0.total_cmp(&y.0));
    }
    let last = |i: usize| events[i].len() + 1;
    let ev_index = |i: usize, f: &dyn Fn(&Ev) -> bool| events[i].iter().position(|(_, e)| f(e)).unwrap() + 1;

    // stops at points: junctions (degree ≥ 3), and one point on each loop
    // that has no other stop
    for (id, segs) in &degree {
        if segs.len() == 1 {
            return Err(format!(
                "a strand ends loose at ({:.0}, {:.0})",
                pt[id].0, -pt[id].1
            ));
        }
    }
    let mut stop_points: Vec<u64> = degree
        .iter()
        .filter(|(_, s)| s.len() >= 3)
        .map(|(&id, _)| id)
        .collect();
    stop_points.sort_unstable();
    let is_stop = |id: u64, stops: &[u64]| stops.contains(&id);

    // walk from a port to the next stop
    let walk = |start: Port, stops: &[u64]| -> Result<(Port, Vec<(usize, i8)>), String> {
        let (mut seg, mut idx, mut side) = start;
        let mut path = vec![(seg, side)];
        loop {
            let nxt = idx as i64 + side as i64;
            if nxt >= 1 && (nxt as usize) < last(seg) {
                return Ok(((seg, nxt as usize, -side), path));
            }
            // an endpoint
            let s = &d.segs[seg];
            let p = if side > 0 { s.b } else { s.a };
            let at = if side > 0 { last(seg) } else { 0 };
            if is_stop(p, stops) {
                return Ok(((seg, at, -side), path));
            }
            let other = degree[&p].iter().copied().find(|&o| o != seg).unwrap();
            let os = &d.segs[other];
            if os.a == p {
                (seg, idx, side) = (other, 0, 1);
            } else {
                (seg, idx, side) = (other, last(other), -1);
            }
            path.push((seg, side));
            if (seg, idx, side) == start {
                return Err("internal: a loop without stops".into());
            }
        }
    };

    // all ports at stops
    let mut ports: Vec<Port> = Vec::new();
    for i in 0..d.segs.len() {
        for e in 1..last(i) {
            ports.push((i, e, -1));
            ports.push((i, e, 1));
        }
    }
    // loops with no stop at all get one at a point
    let mut covered = vec![false; d.segs.len()];
    let mark = |covered: &mut Vec<bool>, path: &[(usize, i8)]| {
        for &(s, _) in path {
            covered[s] = true;
        }
    };
    let mut pieces: Vec<Piece> = Vec::new();
    let mut seen: HashMap<Port, usize> = HashMap::new();
    let label = |path: &[(usize, i8)]| -> Result<(usize, Poly, i8), String> {
        let (s0, side0) = path[0];
        let first = (d.segs[s0].handle, widths[s0].clone(), d.segs[s0].dir * side0);
        for &(s, side) in path {
            let l = (d.segs[s].handle, widths[s].clone(), d.segs[s].dir * side);
            if l != first {
                return Err(format!(
                    "the labels change along a strand of {} (segment {}): set the whole strand at once",
                    d.handles[first.0].name, d.segs[s].id
                ));
            }
        }
        Ok(first)
    };
    let add_piece = |start: Port,
                     stops: &[u64],
                     pieces: &mut Vec<Piece>,
                     seen: &mut HashMap<Port, usize>,
                     covered: &mut Vec<bool>|
     -> Result<(), String> {
        if seen.contains_key(&start) {
            return Ok(());
        }
        let (end, path) = walk(start, stops)?;
        mark(covered, &path);
        let (handle, width, dir) = label(&path)?;
        seen.insert(start, pieces.len());
        seen.insert(end, pieces.len());
        pieces.push(Piece {
            start,
            end,
            handle,
            width,
            dir,
        });
        Ok(())
    };
    let junction_ports = |p: u64| -> Vec<Port> {
        degree[&p]
            .iter()
            .map(|&i| {
                if d.segs[i].a == p {
                    (i, 0, 1)
                } else {
                    (i, last(i), -1)
                }
            })
            .collect()
    };
    for &p in &ports.clone() {
        add_piece(p, &stop_points, &mut pieces, &mut seen, &mut covered)?;
    }
    for &p in &stop_points.clone() {
        for port in junction_ports(p) {
            add_piece(port, &stop_points, &mut pieces, &mut seen, &mut covered)?;
        }
    }
    let mut loop_points: Vec<u64> = Vec::new();
    while let Some(i) = covered.iter().position(|c| !c) {
        let p = d.segs[i].a;
        stop_points.push(p);
        loop_points.push(p);
        for port in junction_ports(p) {
            add_piece(port, &stop_points, &mut pieces, &mut seen, &mut covered)?;
        }
    }

    // nodes, and where each port sits: (node, slot)
    let mut slot_of: HashMap<Port, (usize, usize)> = HashMap::new();
    for (c, &(u, t, o, s)) in crossings.iter().enumerate() {
        let n = k.node(NodeKind::Cross, 4);
        let iu = ev_index(u, &|e| matches!(e, Ev::Cross(x) if *x == c));
        let io = ev_index(o, &|e| matches!(e, Ev::Cross(x) if *x == c));
        let _ = (t, s);
        let (ua, ub) = ends(u);
        let (oa, ob) = ends(o);
        let back = sub(ua, ub);
        let fwd = sub(ob, oa);
        slot_of.insert((u, iu, -1), (n, 0));
        slot_of.insert((u, iu, 1), (n, 2));
        if cross(back, fwd) > 0.0 {
            slot_of.insert((o, io, 1), (n, 1));
            slot_of.insert((o, io, -1), (n, 3));
        } else {
            slot_of.insert((o, io, -1), (n, 1));
            slot_of.insert((o, io, 1), (n, 3));
        }
    }
    // does the piece at this port run into the node there?
    let into = |port: Port| -> (usize, i8, Poly, bool) {
        let pc = &pieces[seen[&port]];
        let is_end = pc.end == port && pc.start != port;
        let toward = if is_end { pc.dir > 0 } else { pc.dir < 0 };
        (pc.handle, pc.dir, pc.width.clone(), toward)
    };
    // boxes: a merge below, the twist, a split above (below = right of p → q)
    // (groups, tail, head) of the cables into and out of each box
    type Cable = (Vec<(usize, i8, Poly)>, (usize, usize), (usize, usize));
    let mut box_edges: Vec<Cable> = Vec::new();
    for (bi, b) in d.boxes.iter().enumerate() {
        let (p, q) = ((b.p[0], -b.p[1]), (b.q[0], -b.q[1]));
        let dvec = sub(q, p);
        let kk = cuts[bi].len();
        let twists = parse(&b.twists, "twist box")?;
        let units = if b.units == "strands" {
            Units::Strands
        } else {
            Units::Ribbons(vec![1; kk])
        };
        let merge = k.node(NodeKind::Split, kk + 1);
        let tw = k.node(
            NodeKind::Twist {
                half_twists: twists,
                units,
            },
            2,
        );
        let top = k.node(NodeKind::Split, kk + 1);
        let mut bottoms = Vec::new();
        let mut tops = Vec::new();
        for (j, &(i, _, _)) in cuts[bi].iter().enumerate() {
            let e = ev_index(i, &|ev| matches!(ev, Ev::Cut(x, y) if *x == bi && *y == j));
            let (a, bb) = ends(i);
            let pos = {
                let t = events[i][e - 1].0;
                (a.0 + t * (bb.0 - a.0), a.1 + t * (bb.1 - a.1))
            };
            let a_below = cross(dvec, sub(a, pos)) < 0.0;
            let (below, above) = if a_below {
                ((i, e, -1), (i, e, 1))
            } else {
                ((i, e, 1), (i, e, -1))
            };
            bottoms.push(below);
            tops.push(above);
        }
        // merge: [cable, parts left to right]; split above: [cable, parts right to left]
        let mut cable_in = Vec::new();
        for (j, &port) in bottoms.iter().enumerate() {
            slot_of.insert(port, (merge, j + 1));
            let (h, _, w, toward) = into(port);
            cable_in.push((h, if toward { 1 } else { -1 }, w));
        }
        let mut cable_out = Vec::new();
        for (j, &port) in tops.iter().enumerate() {
            slot_of.insert(port, (top, kk - j));
            let (h, _, w, toward) = into(port);
            cable_out.push((h, if toward { -1 } else { 1 }, w));
        }
        box_edges.push((cable_in, (merge, 0), (tw, 0)));
        box_edges.push((cable_out, (tw, 1), (top, 0)));
    }
    // junctions: counterclockwise, the whole bundle first
    for &p in &stop_points {
        let mut ps = junction_ports(p);
        let at = pt[&p];
        let angle = |port: &Port| {
            let (a, b) = ends(port.0);
            let other = if d.segs[port.0].a == p { b } else { a };
            let v = sub(other, at);
            v.1.atan2(v.0)
        };
        ps.sort_by(|x, y| angle(x).total_cmp(&angle(y)));
        let n = k.node(NodeKind::Split, ps.len());
        let w: Vec<Poly> = ps.iter().map(|&port| into(port).2).collect();
        let total = w.iter().fold(Poly::zero(), |acc, x| &acc + x);
        let whole = if loop_points.contains(&p) {
            Some(0)
        } else {
            (0..ps.len()).find(|&i| &w[i] * 2 == total)
        };
        let whole = whole.ok_or_else(|| {
            format!(
                "at the junction ({:.0}, {:.0}) no bundle is the sum of the others",
                at.0, -at.1
            )
        })?;
        for (s, &port) in ps.iter().cycle().skip(whole).take(ps.len()).enumerate() {
            slot_of.insert(port, (n, s));
        }
    }
    for pc in &pieces {
        let tail = *slot_of.get(&pc.start).ok_or("internal: an unplaced port")?;
        let head = *slot_of.get(&pc.end).ok_or("internal: an unplaced port")?;
        k.edge(&[(pc.handle, pc.dir, pc.width.clone())], tail, head);
    }
    for (g, tail, head) in box_edges {
        k.edge(&g, tail, head);
    }
    k.validate().map_err(|e| e.to_string())?;
    Ok(k)
}

/// Applies the moves in order.
fn apply(k: KirbyDiagram, moves: &[KMove]) -> Result<Vec<KirbyDiagram>, String> {
    let mut stages = vec![k];
    for m in moves {
        let cur = stages.last().unwrap();
        let find = |name: &str| cur.handle(name).ok_or_else(|| format!("no handle {name}"));
        let next = match m.op.as_str() {
            "cancel" => cur
                .cancel(find(&m.dotted)?, find(&m.handle)?)
                .map_err(|e| format!("cancel {} with {}: {e}", m.dotted, m.handle))?,
            op => return Err(format!("unknown move {op}")),
        };
        stages.push(next);
    }
    Ok(stages)
}

/// A summary of one stage.
fn summary(k: &KirbyDiagram) -> Value {
    let names = k.param_names();
    let l = k.linking();
    let handles: Vec<Value> = k
        .handles
        .iter()
        .enumerate()
        .map(|(i, h)| {
            json!({
                "name": h.name,
                "dotted": h.kind == HandleKind::Dotted,
                "framing": match &h.kind { HandleKind::Framed(f) => f.display(&names), HandleKind::Dotted => String::new() },
                "writhe": l.writhe[i].display(&names),
            })
        })
        .collect();
    let lk: Vec<Vec<String>> =
        l.lk.iter()
            .map(|r| r.iter().map(|p| p.display(&names)).collect())
            .collect();
    json!({ "handles": handles, "lk": lk })
}

/// Small values satisfying the parities, to check a drawing on.
fn sample_values(k: &KirbyDiagram) -> Vec<Vec<i64>> {
    let pick = |p: &ncknot::kirby::Param, base: i64| match p.parity {
        Some(true) => base | 1,
        Some(false) => base & !1,
        None => base,
    };
    [1, 2]
        .iter()
        .map(|&b| k.params.iter().map(|p| pick(p, b).max(1)).collect())
        .collect()
}

/// The Kirby tab's requests: `"summary"` (each stage's handles, framings,
/// writhes and linking numbers, checked against small members), `"table"`
/// (per member of the final stage: crossings, writhe, Seifert data,
/// Alexander polynomial, boundary homomorphisms) and `"member"` (one member's
/// PD code).
pub fn kirby_json(input: &str) -> String {
    let req: KRequest = match serde_json::from_str(input) {
        Ok(r) => r,
        Err(e) => return json!({ "error": format!("bad request: {e}") }).to_string(),
    };
    match run(&req) {
        Ok(v) => v.to_string(),
        Err(e) => json!({ "error": e }).to_string(),
    }
}

fn run(req: &KRequest) -> Result<Value, String> {
    let k = build(&req.drawing)?;
    let stages = apply(k, &req.moves)?;
    let last = stages.last().unwrap();
    match req.task.as_str() {
        "summary" => {
            for v in sample_values(&stages[0]) {
                stages[0]
                    .check(&v)
                    .map_err(|e| format!("the drawing does not hold together at {v:?}: {e}"))?;
            }
            Ok(json!({
                "params": stages[0].param_names(),
                "stages": stages.iter().map(summary).collect::<Vec<_>>(),
            }))
        }
        "member" => {
            let ex = last.expand(&req.values).map_err(|e| e.to_string())?;
            let d = &ex.diagram;
            Ok(json!({
                "pd": d.pd_code(),
                "free_loops": d.free_loops(),
                "crossings": d.crossings(),
                "components": d.components(),
            }))
        }
        "table" => {
            if req.ranges.len() != last.params.len() {
                return Err("one range per parameter".into());
            }
            let mut combos: Vec<Vec<i64>> = vec![vec![]];
            for (p, &[a, b]) in last.params.iter().zip(&req.ranges) {
                let vals: Vec<i64> = (a.min(b)..=a.max(b))
                    .filter(|v| p.parity.is_none_or(|odd| (v.rem_euclid(2) == 1) == odd))
                    .collect();
                combos = combos
                    .into_iter()
                    .flat_map(|c| {
                        vals.iter().map(move |&v| {
                            let mut c = c.clone();
                            c.push(v);
                            c
                        })
                    })
                    .collect();
            }
            if combos.len() > 400 {
                return Err(format!(
                    "{} members: narrow the ranges (at most 400)",
                    combos.len()
                ));
            }
            let rows: Vec<Value> = combos.iter().map(|v| row(&stages, v, req)).collect();
            Ok(json!({ "rows": rows }))
        }
        t => Err(format!("unknown task {t}")),
    }
}

fn row(stages: &[KirbyDiagram], v: &[i64], req: &KRequest) -> Value {
    let last = stages.last().unwrap();
    let ex = match last.expand(v) {
        Ok(ex) => ex,
        Err(e) => return json!({ "values": v, "error": e.to_string() }),
    };
    let d = &ex.diagram;
    let w = d.writhe();
    let s = d.seifert_circles().1 as i64;
    let cp = d.seifert_graph_components(Some(1)) as i64;
    let cn = d.seifert_graph_components(Some(-1)) as i64;
    let alexander = (d.crossings() <= req.alexander_limit).then(|| d.alexander().to_string());
    let homs = (req.boundary_homs >= 2).then(|| {
        let per_stage: Vec<String> = stages
            .iter()
            .map(|k| match k.expand(v) {
                Ok(ex) => match k.surgery_framings(&ex, v) {
                    Ok(f) => {
                        let rel = KnotGroup::surgery_relators(&ex.diagram, &f);
                        ex.diagram
                            .group()
                            .count_homomorphisms_with(&rel, req.boundary_homs, false)
                            .to_string()
                    }
                    Err(e) => e.to_string(),
                },
                Err(e) => e.to_string(),
            })
            .collect();
        per_stage
    });
    json!({
        "values": v,
        "crossings": d.crossings(),
        "components": d.components(),
        "writhe": w,
        "seifert": s,
        "cpos": cp,
        "cneg": cn,
        "bound_pos": w - s + 2 * cp - 1,
        "bound_neg": -w - s + 2 * cn - 1,
        "alexander": alexander,
        "homs": homs,
    })
}
