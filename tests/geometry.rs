//! Drawings to diagrams.

use ncknot::{table, BigInt, Diagram};
use ncknot_web::geometry::{alternating, analyze, Drawing, Vertex};

fn polygon(id0: u32, pts: &[(f64, f64)]) -> Vec<Vertex> {
    pts.iter()
        .enumerate()
        .map(|(k, &(x, y))| Vertex {
            id: id0 + k as u32,
            x,
            y,
        })
        .collect()
}

/// The pentagram {5/2}, traversed as one closed polygon.
fn pentagram() -> Vec<Vertex> {
    let pts: Vec<(f64, f64)> = (0..5)
        .map(|k| {
            let a = std::f64::consts::FRAC_PI_2 + 4.0 * std::f64::consts::PI * k as f64 / 5.0;
            (100.0 * a.cos(), -100.0 * a.sin())
        })
        .collect();
    polygon(0, &pts)
}

fn diagram(d: &Drawing) -> Diagram {
    analyze(d).unwrap().1
}

#[test]
fn pentagram_is_an_unknot_or_cinquefoil() {
    let mut d = Drawing {
        components: vec![pentagram()],
        over: vec![],
        boxes: vec![],
    };
    let (a, k) = analyze(&d).unwrap();
    assert_eq!(a.crossings.len(), 5);
    // larger id on top: not alternating, and the diagram is still a knot
    assert_eq!(k.components(), 1);
    // alternating: the (2,5) torus knot
    d.over = alternating(&d).unwrap();
    let k = diagram(&d);
    let t25 = table::diagram("5_1").unwrap();
    assert_eq!(k.alexander(), t25.alexander());
    assert_eq!(k.determinant(), BigInt::from(5));
    let v = k.jones();
    assert!(v == t25.jones() || v == t25.mirror().jones());
    assert_eq!(k.signature().unwrap().abs(), 4);
    // flipping every crossing gives the mirror image
    let mut m = d.clone();
    for o in &mut m.over {
        o[2] = if o[2] == o[0] { o[1] } else { o[0] };
    }
    assert_eq!(diagram(&m).jones(), k.mirror().jones());
}

#[test]
fn signs_follow_the_screen() {
    // two overlapping squares: a Hopf link; screen y points down
    let a = polygon(0, &[(0.0, 0.0), (100.0, 0.0), (100.0, 100.0), (0.0, 100.0)]);
    let b = polygon(10, &[(50.0, 50.0), (150.0, 50.0), (150.0, 150.0), (50.0, 150.0)]);
    let mut d = Drawing {
        components: vec![a, b],
        over: vec![],
        boxes: vec![],
    };
    let (an, k) = analyze(&d).unwrap();
    assert_eq!(an.crossings.len(), 2);
    // larger ids (square b) on top at both crossings: unlinked
    assert_eq!(k.linking_matrix()[0][1], 0);
    assert_eq!(k.jones(), Diagram::unlink(2).jones());
    d.over = alternating(&d).unwrap();
    let k = diagram(&d);
    assert_eq!(k.linking_matrix()[0][1].abs(), 1);
    // both squares run clockwise on screen; the computed signs agree with
    // the over/under picture: crossing (100, 50) has b (going right) over a
    // (going down) or the reverse
    let an = analyze(&d).unwrap().0;
    for c in &an.crossings {
        let a_over = c.over == c.a;
        let at_right = (c.x - 100.0).abs() < 1e-9;
        // at (100,50): a goes down (0,1 screen), b goes right (1,0)
        // at (50,100): a goes left (-1,0), b goes up (0,-1)
        let (da, db): ((f64, f64), (f64, f64)) = if at_right {
            ((0.0, 1.0), (1.0, 0.0))
        } else {
            ((-1.0, 0.0), (0.0, -1.0))
        };
        let (over, under) = if a_over { (da, db) } else { (db, da) };
        // math coordinates (y up): positive iff over × under > 0
        let (o, u) = ((over.0, -over.1), (under.0, -under.1));
        let expect = if o.0 * u.1 - o.1 * u.0 > 0.0 { 1 } else { -1 };
        assert_eq!(c.sign, expect, "{c:?}");
    }
    // the two crossings of a Hopf link have the same sign
    assert_eq!(an.crossings[0].sign, an.crossings[1].sign);
}

#[test]
fn degenerate_drawings_are_reported() {
    let tri = polygon(0, &[(0.0, 0.0), (10.0, 0.0), (0.0, 10.0)]);
    // a vertex exactly on another strand
    let touch = polygon(10, &[(5.0, 0.0), (5.0, -10.0), (8.0, -10.0)]);
    let d = Drawing {
        components: vec![tri.clone(), touch],
        over: vec![],
        boxes: vec![],
    };
    assert!(analyze(&d).is_err());
    let d = Drawing {
        components: vec![polygon(0, &[(0.0, 0.0), (1.0, 0.0)])],
        over: vec![],
        boxes: vec![],
    };
    assert!(analyze(&d).is_err());
    // a lone triangle is the unknot
    let d = Drawing {
        components: vec![tri],
        over: vec![],
        boxes: vec![],
    };
    assert_eq!(diagram(&d).jones(), Diagram::unknot().jones());
}

#[test]
fn compute_api_round_trip() {
    let out = ncknot_web::api::compute(r#"{"task":"basic","pd":[[1,4,2,5],[3,6,4,1],[5,2,6,3]]}"#);
    let v: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["jones"]["text"], "-t^-4 + t^-3 + t^-1");
    assert_eq!(v["determinant"], "3");
    assert_eq!(v["signature"]["Ok"], 2);
    let out =
        ncknot_web::api::compute(r#"{"task":"khovanov","pd":[[1,4,2,5],[3,6,4,1],[5,2,6,3]],"ring":"Z"}"#);
    let v: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["total"], 4);
    let out = ncknot_web::api::compute(r#"{"task":"homs","pd":[[1,4,2,5],[3,6,4,1],[5,2,6,3]],"m":3}"#);
    let v: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["count"], "12");
}
