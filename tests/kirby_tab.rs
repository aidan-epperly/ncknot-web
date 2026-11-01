//! The Kirby tab's drawings: a drawn family gives the same symbolic data as
//! the family built by hand in ncknot's tests, and the moves and tables run.

use ncknot_web::kirby::{build, kirby_json, KDrawing};
use serde_json::{json, Value};

/// A two-parameter family drawn with straight segments: a dotted circle R
/// (a rectangle); G winding n + 1 times up and n times down through R, one
/// strand peeling off above R and rejoining below; B through R once, with a
/// box of m half-twists, passing under G's upward bundles and over the
/// downward one, above and below R.
pub fn spiral_drawing() -> Value {
    let pts = [
        (1, 200, 430),
        (2, 820, 430),
        (3, 820, 500),
        (4, 200, 500), // R
        (10, 300, 540),
        (11, 300, 380),
        (12, 300, 120),
        (13, 600, 120),
        (14, 600, 760),
        (15, 280, 760),
        (16, 280, 580),
        (17, 150, 350),
        (18, 150, 620),
        (19, 340, 620),
        (20, 330, 580), // G
        (30, 760, 580),
        (31, 760, 370),
        (32, 910, 370),
        (33, 910, 530), // B, small loop
        (40, 950, 530),
        (41, 950, 680),
        (42, 100, 680),
        (43, 100, 880),
        (44, 1080, 880),
        (45, 1080, 40),
        (46, 100, 40),
        (47, 100, 200),
        (48, 950, 200), // B, the long way
    ];
    let points: Vec<Value> = pts
        .iter()
        .map(|&(id, x, y)| json!({"id": id, "x": x, "y": y}))
        .collect();
    let mut segs = Vec::new();
    let mut seg = |id: u64, a: u64, b: u64, h: usize, w: &str| {
        segs.push(json!({"id": id, "a": a, "b": b, "handle": h, "width": w, "dir": 1}));
    };
    for (i, (a, b)) in [(1, 2), (2, 3), (3, 4), (4, 1)].iter().enumerate() {
        seg(100 + i as u64, *a, *b, 0, "1");
    }
    seg(110, 10, 11, 1, "n+1"); // U, up through R
    seg(111, 11, 12, 1, "n"); // up to the top cap
    seg(112, 12, 13, 1, "n");
    seg(113, 13, 14, 1, "n"); // D, down through R
    seg(114, 14, 15, 1, "n");
    seg(115, 15, 16, 1, "n"); // up to the bottom junction
    seg(116, 16, 10, 1, "n");
    for (i, (a, b)) in [(11, 17), (17, 18), (18, 19), (19, 20), (20, 10)]
        .iter()
        .enumerate()
    {
        seg(120 + i as u64, *a, *b, 1, "1"); // the peeled strand
    }
    for (i, (a, b)) in [(30, 31), (31, 32), (32, 33), (33, 30)].iter().enumerate() {
        seg(130 + i as u64, *a, *b, 2, "1");
    }
    for (i, (a, b)) in [
        (40, 41),
        (41, 42),
        (42, 43),
        (43, 44),
        (44, 45),
        (45, 46),
        (46, 47),
        (47, 48),
        (48, 40),
    ]
    .iter()
    .enumerate()
    {
        seg(140 + i as u64, *a, *b, 2, "1");
    }
    let over = vec![
        [100, 110, 110],
        [100, 113, 113],
        [100, 130, 130], // over R's top edge
        [102, 110, 102],
        [102, 113, 102],
        [102, 130, 102], // under its bottom edge
        [122, 115, 122], // the peeled strand over the lower bundle
        [147, 111, 111],
        [147, 113, 147], // B above R
        [141, 113, 141],
        [141, 115, 115], // B below R
    ];
    json!({
        "params": [{"name": "n"}, {"name": "m", "parity": "odd"}],
        "handles": [
            {"name": "R", "kind": "dotted"},
            {"name": "G", "kind": "framed", "framing": "0"},
            {"name": "B", "kind": "framed", "framing": "0"},
        ],
        "points": points,
        "segs": segs,
        "over": over,
        "boxes": [{"p": [880, 450], "q": [980, 450], "twists": "m"}],
    })
}

fn ask(req: Value) -> Value {
    let out: Value = serde_json::from_str(&kirby_json(&req.to_string())).unwrap();
    assert!(out.get("error").is_none(), "{out}");
    out
}

#[test]
fn drawn_family_matches_the_hand_built_one() {
    let d: KDrawing = serde_json::from_value(spiral_drawing()).unwrap();
    let k = build(&d).unwrap();
    let names = k.param_names();
    let l = k.linking();
    assert_eq!(l.writhe[1].display(&names), "n");
    assert_eq!(l.writhe[2].display(&names), "m");
    assert_eq!(l.lk[1][2].display(&names), "0");
    assert_eq!(l.lk[0][1].as_integer().map(i64::abs), Some(1));
    assert_eq!(l.lk[0][2].as_integer().map(i64::abs), Some(1));
    for n in 1..=3 {
        for m in [-3, -1, 1, 3] {
            k.check(&[n, m]).unwrap();
        }
    }
    let moves = json!([{"op": "cancel", "dotted": "R", "handle": "B"}]);
    let s = ask(json!({"task": "summary", "drawing": spiral_drawing(), "moves": moves}));
    let after = &s["stages"][1]["handles"][0];
    assert_eq!(after["name"], "G");
    assert_eq!(after["framing"], "0");
    assert_eq!(after["writhe"], "2*n*m + n + m");
    // the same Seifert data as the family built by hand, and the boundary is kept
    let t = ask(json!({
        "task": "table", "drawing": spiral_drawing(), "moves": moves,
        "ranges": [[1, 5], [-7, 7]], "alexander_limit": 30,
    }));
    assert_eq!(t["rows"].as_array().unwrap().len(), 5 * 8);
    for r in t["rows"].as_array().unwrap() {
        let (n, m) = (r["values"][0].as_i64().unwrap(), r["values"][1].as_i64().unwrap());
        let want = if m > 0 {
            m - 2 * n - 1
        } else {
            6 * n * m - m - 2 * n - 1
        };
        assert_eq!(r["bound_pos"].as_i64().unwrap(), want, "{r}");
        assert_eq!(r["components"], 1);
    }
    let t = ask(json!({
        "task": "table", "drawing": spiral_drawing(), "moves": moves,
        "ranges": [[1, 1], [-1, 3]], "boundary_homs": 4,
    }));
    for r in t["rows"].as_array().unwrap() {
        let homs = r["homs"].as_array().unwrap();
        assert_eq!(homs[0], homs[1], "{r}");
    }
    let mem = ask(json!({"task": "member", "drawing": spiral_drawing(), "moves": moves, "values": [1, 1]}));
    assert_eq!(mem["crossings"], 28);
}

#[test]
fn drawing_errors_are_explained() {
    let mut d = spiral_drawing();
    d["segs"][4]["width"] = json!("n+2"); // U no longer splits into n and 1
    let out: Value =
        serde_json::from_str(&kirby_json(&json!({"task": "summary", "drawing": d}).to_string())).unwrap();
    assert!(
        out["error"].as_str().unwrap().contains("labels change")
            || out["error"].as_str().unwrap().contains("junction"),
        "{out}"
    );
    let mut d = spiral_drawing();
    d["segs"].as_array_mut().unwrap().pop(); // a loose end
    let out: Value =
        serde_json::from_str(&kirby_json(&json!({"task": "summary", "drawing": d}).to_string())).unwrap();
    assert!(out["error"].as_str().unwrap().contains("loose"), "{out}");
}
