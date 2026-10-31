//! Twist boxes against closures of integer tangles.

use ncknot::{table, BigInt, Diagram};
use ncknot_web::geometry::{analyze, Drawing, TwistBox, Vertex};

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

/// Two rectangles side by side; a box on their facing sides is the
/// denominator closure of the integer tangle `n`: the torus link `T(2, n)`.
/// `parallel`: the facing sides run the same way.
fn two_rectangles(n: i64, parallel: bool) -> Drawing {
    let a = polygon(0, &[(0.0, 0.0), (100.0, 0.0), (100.0, 200.0), (0.0, 200.0)]); // right side: id 1, down
    let b = if parallel {
        polygon(10, &[(130.0, 0.0), (130.0, 200.0), (230.0, 200.0), (230.0, 0.0)])
    // left side: id 10, down
    } else {
        polygon(10, &[(130.0, 0.0), (230.0, 0.0), (230.0, 200.0), (130.0, 200.0)])
        // left side: id 13, up
    };
    Drawing {
        components: vec![a, b],
        over: vec![],
        // the older two-strand format, still accepted
        boxes: vec![TwistBox {
            a: Some(1),
            b: Some(if parallel { 10 } else { 13 }),
            n,
            ..Default::default()
        }],
    }
}

fn diagram(d: &Drawing) -> Diagram {
    analyze(d).unwrap().1
}

#[test]
fn denominator_closure_is_a_two_bridge_torus_link() {
    for n in [-6i64, -5, -4, -3, -2, -1, 1, 2, 3, 4, 5, 6, 7] {
        for parallel in [true, false] {
            let d = diagram(&two_rectangles(n, parallel));
            assert_eq!(d.crossings(), n.unsigned_abs() as usize);
            assert_eq!(d.components(), if n % 2 == 0 { 2 } else { 1 }, "n = {n}");
            assert_eq!(
                d.determinant(),
                BigInt::from(n.abs()),
                "n = {n}, parallel {parallel}"
            );
            if n % 2 != 0 {
                // a knot: T(2, n) up to mirror, whatever the drawn orientations
                let t = ncknot::Braid::torus(2, n as i32).unwrap().closure();
                assert_eq!(d.jones(), t.jones(), "n = {n}");
                assert_eq!(d.signature().unwrap(), t.signature().unwrap(), "n = {n}");
            } else if parallel {
                // parallel strands, n > 0: positive crossings, linking number n/2
                assert_eq!(d.writhe(), n, "n = {n}");
                assert_eq!(d.linking_matrix()[0][1], n / 2);
            } else {
                assert_eq!(d.writhe(), -n, "n = {n}");
            }
        }
    }
    // the convention: three right-handed half-twists give the right-handed trefoil
    let d = diagram(&two_rectangles(3, true));
    assert_eq!(d.jones(), table::diagram("3_1").unwrap().jones());
}

#[test]
fn numerator_closure_is_the_unknot() {
    // one tall rectangle, a box on its two long sides
    for n in -4i64..=5 {
        let d = Drawing {
            components: vec![polygon(
                0,
                &[(0.0, 0.0), (60.0, 0.0), (60.0, 300.0), (0.0, 300.0)],
            )],
            over: vec![],
            boxes: vec![TwistBox::new(&[1, 3], n)],
        };
        let k = diagram(&d);
        assert_eq!(k.components(), 1);
        assert_eq!(k.jones(), Diagram::unknot().jones(), "n = {n}");
    }
}

#[test]
fn boxes_with_a_strand_between_are_refused() {
    let mut d = two_rectangles(3, true);
    // a third rectangle whose side runs between the two boxed strands
    d.components.push(polygon(
        20,
        &[(115.0, -50.0), (118.0, -50.0), (118.0, 250.0), (115.0, 250.0)],
    ));
    assert!(analyze(&d).unwrap_err().contains("between"));
    // and a box on one strand twice
    let mut d = two_rectangles(3, true);
    d.boxes.push(TwistBox::new(&[1, 3], 1));
    assert!(analyze(&d).is_err());
}

/// `k` concentric loops with a box across their right sides: the closure of
/// the braid Δ^n, Δ = (σ_1 ⋯ σ_{k-1})(σ_1 ⋯ σ_{k-2}) ⋯ σ_1 the half twist.
fn nested_loops(k: usize, n: i64) -> Drawing {
    let components = (0..k)
        .map(|j| {
            let g = 30.0 * j as f64;
            polygon(
                10 * j as u32,
                &[
                    (300.0 - g, 100.0 - g),
                    (500.0 + g, 100.0 - g),
                    (500.0 + g, 400.0 + g),
                    (300.0 - g, 400.0 + g),
                ],
            )
        })
        .collect();
    let segs: Vec<u32> = (0..k).map(|j| 10 * j as u32 + 1).collect(); // the right sides
    Drawing {
        components,
        over: vec![],
        boxes: vec![TwistBox::new(&segs, n)],
    }
}

#[test]
fn bundle_boxes_are_half_twists() {
    for k in 2..=4usize {
        for n in [-3i64, -2, -1, 1, 2, 3] {
            let d = diagram(&nested_loops(k, n));
            let delta: Vec<i32> = (1..k as i32).rev().flat_map(|m| 1..=m).collect();
            let word: Vec<i32> = (0..n.unsigned_abs())
                .flat_map(|_| delta.iter().map(|&g| g * n.signum() as i32))
                .collect();
            let want = ncknot::Braid::new(k, &word).unwrap().closure();
            assert_eq!(d.crossings(), word.len(), "k = {k}, n = {n}");
            assert_eq!(d.components(), want.components(), "k = {k}, n = {n}");
            assert_eq!(d.jones(), want.jones(), "k = {k}, n = {n}");
            assert_eq!(d.alexander(), want.alexander(), "k = {k}, n = {n}");
        }
    }
    // a full twist on three strands is the torus link T(3, 3)
    let d = diagram(&nested_loops(3, 2));
    assert_eq!(d.jones(), ncknot::Braid::torus(3, 3).unwrap().closure().jones());
}
