//! Bundles: components standing for several parallel copies.

use ncknot::{table, Braid, Diagram};
use ncknot_web::geometry::{alternating, analyze, Drawing, TwistBox, Vertex};
use ncknot_web::layout::{layout, Rect};

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

fn square(id0: u32, x: f64, y: f64, s: f64) -> Vec<Vertex> {
    polygon(id0, &[(x, y), (x + s, y), (x + s, y + s), (x, y + s)])
}

fn diagram(d: &Drawing) -> Diagram {
    analyze(d).unwrap().1
}

#[test]
fn a_bundled_circle_is_an_unlink() {
    for k in 1..=4u32 {
        let d = Drawing {
            components: vec![square(0, 0.0, 0.0, 200.0)],
            mult: vec![k],
            ..Default::default()
        };
        let dg = diagram(&d);
        assert_eq!(dg.components(), k as usize);
        assert_eq!(dg.jones(), Diagram::unlink(k as usize).jones(), "k = {k}");
    }
    // multiplicity 0 removes the component
    let d = Drawing {
        components: vec![square(0, 0.0, 0.0, 200.0), square(10, 400.0, 0.0, 100.0)],
        mult: vec![0, 1],
        ..Default::default()
    };
    assert_eq!(diagram(&d).components(), 1);
}

#[test]
fn bundles_cross_in_grids() {
    // a Hopf link; then component A doubled, then both bundled
    let mut d = Drawing {
        components: vec![square(0, 0.0, 0.0, 200.0), square(10, 100.0, 100.0, 200.0)],
        ..Default::default()
    };
    d.over = alternating(&d).unwrap();
    let lk = diagram(&d).linking_matrix()[0][1];
    assert_eq!(lk.abs(), 1);
    for (a, b) in [(2u32, 1u32), (2, 3), (3, 2)] {
        d.mult = vec![a, b];
        let dg = diagram(&d);
        assert_eq!(dg.crossings(), 2 * (a * b) as usize, "{a}x{b}");
        assert_eq!(dg.components(), (a + b) as usize);
        // (ncknot numbers components in its own order) every copy of A links
        // every copy of B lk times; nothing else is linked
        let m = dg.linking_matrix();
        let linked: Vec<i64> = (0..m.len())
            .flat_map(|i| (i + 1..m.len()).map(move |j| (i, j)))
            .map(|(i, j)| m[i][j])
            .filter(|&x| x != 0)
            .collect();
        assert_eq!(linked, vec![lk; (a * b) as usize], "{a}x{b}: {m:?}");
    }
}

#[test]
fn a_twisted_bundle_is_a_braid_closure() {
    // one loop of multiplicity k with a box on its right side: Δ^n on k strands
    for k in 2..=4u32 {
        for n in [-2i64, -1, 1, 2, 3] {
            let d = Drawing {
                components: vec![square(0, 0.0, 0.0, 300.0)],
                mult: vec![k],
                boxes: vec![TwistBox::new(&[1], n)],
                ..Default::default()
            };
            let dg = diagram(&d);
            let delta: Vec<i32> = (1..k as i32).rev().flat_map(|m| 1..=m).collect();
            let word: Vec<i32> = (0..n.unsigned_abs())
                .flat_map(|_| delta.iter().map(|&g| g * n.signum() as i32))
                .collect();
            let want = Braid::new(k as usize, &word).unwrap().closure();
            assert_eq!(dg.components(), want.components(), "k = {k}, n = {n}");
            assert_eq!(dg.jones(), want.jones(), "k = {k}, n = {n}");
        }
    }
}

#[test]
fn a_doubled_knot_has_blackboard_framing() {
    // the 2-cable of a knot diagram: two copies linked writhe times
    for name in ["3_1", "4_1", "5_2"] {
        let k = table::diagram(name).unwrap();
        let (mut d, _) = layout(
            &k,
            Rect {
                x: 0.0,
                y: 0.0,
                w: 800.0,
                h: 600.0,
            },
            1,
        )
        .unwrap();
        let w = diagram(&d).writhe();
        d.mult = vec![2];
        let dg = diagram(&d);
        assert_eq!(dg.components(), 2, "{name}");
        assert_eq!(dg.crossings(), 4 * k.crossings(), "{name}");
        assert_eq!(dg.linking_matrix()[0][1], w, "{name}");
    }
}
