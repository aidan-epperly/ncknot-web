//! Layouts redraw the same diagram.

use ncknot::{table, Braid, Diagram};
use ncknot_web::geometry::analyze;
use ncknot_web::layout::{layout, Rect};

const VIEW: Rect = Rect {
    x: 0.0,
    y: 0.0,
    w: 800.0,
    h: 600.0,
};

fn round_trip(d: &Diagram, what: &str) {
    let (drawing, _) = layout(d, VIEW, 1).unwrap_or_else(|e| panic!("{what}: {e}"));
    let (a, d2) = analyze(&drawing).unwrap_or_else(|e| panic!("{what}: {e}"));
    assert_eq!(a.crossings.len(), d.crossings(), "{what}");
    assert_eq!(d2.components(), d.components(), "{what}");
    assert_eq!(d2.writhe(), d.writhe(), "{what}");
    assert_eq!(d2.jones(), d.jones(), "{what}");
    assert_eq!(d2.alexander(), d.alexander(), "{what}");
    if d.is_connected_projection() {
        assert_eq!(d2.signature().unwrap(), d.signature().unwrap(), "{what}");
    }
    assert_eq!(d2.linking_matrix(), d.linking_matrix(), "{what}");
}

#[test]
fn table_knots_round_trip() {
    for &(name, _, _) in table::BRAIDS {
        round_trip(&table::diagram(name).unwrap(), name);
    }
    let lh = Diagram::parse_pd("X[1,4,2,5], X[3,6,4,1], X[5,2,6,3]").unwrap();
    round_trip(&lh, "KnotTheory 3_1");
    round_trip(&Diagram::parse_pd("X[1,1,2,2]").unwrap(), "kink");
    round_trip(&Diagram::parse_pd("X[1,3,2,4], X[3,1,4,2]").unwrap(), "Hopf");
}

#[test]
fn random_braids_round_trip() {
    let mut seed = 12345u64;
    let mut rnd = |m: u64| {
        seed = seed
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        (seed >> 33) % m
    };
    for trial in 0..60 {
        let strands = 2 + rnd(4) as usize;
        let len = 1 + rnd(14) as usize;
        let word: Vec<i32> = (0..len)
            .map(|_| {
                let g = 1 + rnd(strands as u64 - 1) as i32;
                if rnd(2) == 0 {
                    g
                } else {
                    -g
                }
            })
            .collect();
        let d = Braid::new(strands, &word).unwrap().closure();
        round_trip(&d, &format!("trial {trial}: {strands} strands {word:?}"));
    }
    // split diagrams and free loops
    let u = table::diagram("3_1")
        .unwrap()
        .disjoint_union(&table::diagram("4_1").unwrap());
    round_trip(&u.disjoint_union(&Diagram::unlink(1)), "3_1 + 4_1 + O");
}

/// Vertices keep a clear distance from every crossing, so the over/under gap
/// and the editing handles do not sit on top of each other.
#[test]
fn crossings_have_room() {
    for &(name, _, _) in table::BRAIDS {
        let d = table::diagram(name).unwrap();
        let (drawing, _) = layout(&d, VIEW, 1).unwrap();
        let (a, _) = analyze(&drawing).unwrap();
        let pts: Vec<(f64, f64)> = drawing.components.iter().flatten().map(|v| (v.x, v.y)).collect();
        let closest = a
            .crossings
            .iter()
            .flat_map(|x| pts.iter().map(move |p| (p.0 - x.x).hypot(p.1 - x.y)))
            .fold(f64::INFINITY, f64::min);
        // the over/under halo follows the strand, so a few pixels suffice; most
        // crossings get far more room
        assert!(closest > 5.0, "{name}: a vertex {closest:.1} px from a crossing");
    }
}
