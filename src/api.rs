//! JSON in, JSON out: what the page asks of ncknot.

use crate::geometry::{alternating, analyze, Drawing};
use ncknot::{table, BigInt, Diagram, IntLaurent, Ring};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// A Laurent polynomial as `[[exponent numerator, denominator, coefficient], …]`
/// plus its plain-text form.
fn poly(p: &IntLaurent, var: &str, den: i64) -> Value {
    let terms: Vec<Value> = p.terms().map(|(e, c)| json!([e, den, c.to_string()])).collect();
    json!({ "terms": terms, "text": p.display_as(var, den), "var": var })
}

fn big(x: &BigInt) -> String {
    x.to_string()
}

/// The page's request.
#[derive(Debug, Deserialize)]
pub struct Request {
    /// What to compute: `"basic"`, `"khovanov"` or `"homs"`.
    pub task: String,
    /// The diagram as a PD code (1-based labels).
    #[serde(default)]
    pub pd: Vec<[i64; 4]>,
    /// Crossingless components.
    #[serde(default)]
    pub free_loops: usize,
    /// Prime for colorings.
    #[serde(default = "three")]
    pub p: u64,
    /// `"Z"` or a prime as a string, for Khovanov homology.
    #[serde(default)]
    pub ring: Option<String>,
    /// Degree `m` of `S_m`.
    #[serde(default = "three_usize")]
    pub m: usize,
    /// Only transitive homomorphisms.
    #[serde(default)]
    pub transitive: bool,
    /// For `"family"`: the diagrams of a family, each with a label.
    #[serde(default)]
    pub items: Vec<FamilyItem>,
}

/// One member of a family (`"family"` task).
#[derive(Debug, Deserialize)]
pub struct FamilyItem {
    /// Shown in the table (e.g. the twist number).
    pub label: String,
    /// PD code.
    pub pd: Vec<[i64; 4]>,
    /// Crossingless components.
    #[serde(default)]
    pub free_loops: usize,
}

fn three() -> u64 {
    3
}
fn three_usize() -> usize {
    3
}

/// Largest crossing number for Khovanov homology in the browser.
pub const KHOVANOV_LIMIT: usize = 18;

fn diagram(req: &Request) -> Result<Diagram, String> {
    let d = if req.pd.is_empty() {
        Diagram::unlink(req.free_loops.max(1))
    } else {
        let d = Diagram::from_pd(&req.pd).map_err(|e| e.to_string())?;
        if req.free_loops > 0 {
            d.disjoint_union(&Diagram::unlink(req.free_loops))
        } else {
            d
        }
    };
    Ok(d)
}

fn basic(d: &Diagram, p: u64) -> Value {
    let jones = d.jones();
    let knot = d.components() == 1;
    let (np, nm) = d.sign_counts();
    json!({
        "crossings": d.crossings(),
        "components": d.components(),
        "writhe": d.writhe(),
        "positive": np,
        "negative": nm,
        "jones": poly(jones.in_sqrt_t(), "t", 2),
        "alexander": poly(&d.alexander(), "t", 1),
        "alexander_note": if knot { "Conway-normalized" } else { "up to ±t^k" },
        "conway": d.conway().ok().map(|c| poly(&c, "z", 1)),
        "determinant": big(&d.determinant()),
        "signature": d.signature().map_err(|e| e.to_string()),
        "colorings": d.colorings(p).map(|c| big(&c)).map_err(|e| e.to_string()),
        "p": p,
        "double_cover": d.double_branched_cover_homology().iter().map(big).collect::<Vec<_>>(),
        "linking": d.linking_matrix(),
        "pd": d.pd_code(),
    })
}

fn khovanov(d: &Diagram, ring: &str) -> Result<Value, String> {
    if d.crossings() > KHOVANOV_LIMIT {
        return Err(format!(
            "{} crossings: Khovanov homology here is limited to {KHOVANOV_LIMIT} (2^n states)",
            d.crossings()
        ));
    }
    let ring = match ring {
        "Z" => Ring::Integers,
        s => Ring::Fp(s.parse().map_err(|_| format!("not a prime: {s}"))?),
    };
    let kh = d.khovanov(ring).map_err(|e| e.to_string())?;
    let ranks: Vec<Value> = kh.ranks.iter().map(|(&(h, q), &r)| json!([h, q, r])).collect();
    let torsion: Vec<Value> = kh
        .torsion
        .iter()
        .map(|(&(h, q), t)| json!([h, q, t.iter().map(big).collect::<Vec<_>>()]))
        .collect();
    Ok(json!({
        "ranks": ranks,
        "torsion": torsion,
        "total": kh.total_rank(),
        "poincare": kh.poincare(),
        "euler": poly(&kh.euler_characteristic(), "q", 1),
    }))
}

fn family_member(item: &FamilyItem) -> Value {
    let req = Request {
        task: String::new(),
        pd: item.pd.clone(),
        free_loops: item.free_loops,
        p: 3,
        ring: None,
        m: 3,
        transitive: false,
        items: Vec::new(),
    };
    match diagram(&req) {
        Err(e) => json!({ "label": item.label, "error": e }),
        Ok(d) => json!({
            "label": item.label,
            "crossings": d.crossings(),
            "components": d.components(),
            "determinant": big(&d.determinant()),
            "signature": d.signature().ok(),
            "alexander": poly(&d.alexander(), "t", 1),
            "jones": poly(d.jones().in_sqrt_t(), "t", 2),
        }),
    }
}

/// Runs one request; errors come back as `{"error": …}`.
pub fn compute(input: &str) -> String {
    let run = || -> Result<Value, String> {
        let req: Request = serde_json::from_str(input).map_err(|e| e.to_string())?;
        if req.task == "family" {
            return Ok(Value::Array(req.items.iter().map(family_member).collect()));
        }
        let d = diagram(&req)?;
        match req.task.as_str() {
            "basic" => Ok(basic(&d, req.p)),
            "khovanov" => khovanov(&d, req.ring.as_deref().unwrap_or("2")),
            "homs" => {
                if !(1..=7).contains(&req.m) {
                    return Err("S_m with 1 ≤ m ≤ 7".into());
                }
                let n = d.group().count_homomorphisms_to_symmetric(req.m, req.transitive);
                Ok(json!({ "m": req.m, "transitive": req.transitive, "count": big(&n) }))
            }
            t => Err(format!("unknown task {t}")),
        }
    };
    match run() {
        Ok(v) => v.to_string(),
        Err(e) => json!({ "error": e }).to_string(),
    }
}

/// Analyses a drawing (see [`analyze`]).
pub fn analyze_json(input: &str) -> String {
    let run = || -> Result<Value, String> {
        let d: Drawing = serde_json::from_str(input).map_err(|e| e.to_string())?;
        let (a, _) = analyze(&d)?;
        serde_json::to_value(a).map_err(|e| e.to_string())
    };
    match run() {
        Ok(v) => v.to_string(),
        Err(e) => json!({ "error": e }).to_string(),
    }
}

/// A layout request: a PD code, the view to fill and the first vertex id.
#[derive(Debug, Deserialize)]
struct LayoutRequest {
    pd: Vec<[i64; 4]>,
    #[serde(default)]
    free_loops: usize,
    view: crate::layout::Rect,
    first_id: u32,
}

/// Lays out a PD code (see [`crate::layout`]): `{drawing, next_id}`.
pub fn layout_json(input: &str) -> String {
    let run = || -> Result<Value, String> {
        let req: LayoutRequest = serde_json::from_str(input).map_err(|e| e.to_string())?;
        let d = diagram(&Request {
            task: String::new(),
            pd: req.pd,
            free_loops: req.free_loops,
            p: 3,
            ring: None,
            m: 3,
            transitive: false,
            items: Vec::new(),
        })?;
        let (drawing, next) = crate::layout::layout(&d, req.view, req.first_id)?;
        Ok(json!({ "drawing": drawing, "next_id": next }))
    };
    match run() {
        Ok(v) => v.to_string(),
        Err(e) => json!({ "error": e }).to_string(),
    }
}

/// A bundle expansion request: the drawing and the spacing of the copies.
#[derive(Debug, Deserialize)]
struct ExpandRequest {
    drawing: Drawing,
    spacing: f64,
}

/// The drawing with its bundles expanded into parallel copies, for display:
/// `{drawing}`.
pub fn expand_json(input: &str) -> String {
    let run = || -> Result<Value, String> {
        let req: ExpandRequest = serde_json::from_str(input).map_err(|e| e.to_string())?;
        let d = crate::bundle::expand(&req.drawing, req.spacing)?;
        Ok(json!({ "drawing": d }))
    };
    match run() {
        Ok(v) => v.to_string(),
        Err(e) => json!({ "error": e }).to_string(),
    }
}

/// Alternating over-strand choices for a drawing (see [`alternating`]).
pub fn alternating_json(input: &str) -> String {
    let run = || -> Result<Value, String> {
        let d: Drawing = serde_json::from_str(input).map_err(|e| e.to_string())?;
        Ok(json!({ "over": alternating(&d)? }))
    };
    match run() {
        Ok(v) => v.to_string(),
        Err(e) => json!({ "error": e }).to_string(),
    }
}

/// A table entry with the invariants the page matches drawings against.
#[derive(Serialize)]
struct Entry {
    name: &'static str,
    strands: usize,
    word: &'static [i32],
    components: usize,
    jones: String,
    jones_mirror: String,
    alexander: String,
    pd: Vec<[usize; 4]>,
}

/// The named knots and links with their braid words, Jones polynomials
/// (also of the mirror image) and Alexander polynomials.
pub fn table_json() -> String {
    let mut entries: Vec<Entry> = vec![Entry {
        name: "0_1",
        strands: 1,
        word: &[],
        components: 1,
        jones: "1".into(),
        jones_mirror: "1".into(),
        alexander: "1".into(),
        pd: Vec::new(),
    }];
    entries.extend(table::BRAIDS.iter().map(|&(name, strands, word)| {
        let d = table::diagram(name).expect("table entry");
        Entry {
            name,
            strands,
            word,
            components: d.components(),
            jones: d.jones().to_string(),
            jones_mirror: d.mirror().jones().to_string(),
            alexander: d.alexander().to_string(),
            pd: d.pd_code(),
        }
    }));
    serde_json::to_string(&entries).unwrap()
}
