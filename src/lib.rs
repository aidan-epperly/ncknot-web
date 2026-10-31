//! The WebAssembly side of the knot workbench: drawing analysis and
//! invariants behind a four-function byte interface, so the page needs no
//! generated glue (see `www/knot.js`).
//!
//! JavaScript asks for an input buffer ([`input_buffer`]), writes a UTF-8
//! JSON request into the module's memory, calls [`call`] with a function
//! number, and reads the UTF-8 JSON answer at [`output_ptr`] /
//! [`output_len`].  Functions: 0 analyze a drawing, 1 alternating
//! over-strands, 2 compute invariants, 3 the knot table, 4 lay out a PD code.
//!
//! The page instantiates the module twice: on the main thread for drawing
//! analysis (fast, called while dragging) and in a Web Worker for the
//! invariants (possibly slow; the worker is terminated to cancel).

// The only `unsafe` is `#[unsafe(no_mangle)]` on the four exports below
// (exported symbol names must not clash); no unsafe operations anywhere.
#![deny(unsafe_code)]

pub mod api;
pub mod geometry;
pub mod layout;
pub mod relax;

use std::cell::RefCell;

thread_local! {
    static INPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static OUTPUT: RefCell<String> = const { RefCell::new(String::new()) };
}

/// A buffer of `len` bytes for the next request; JavaScript writes into it.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn input_buffer(len: usize) -> *mut u8 {
    INPUT.with(|b| {
        let mut b = b.borrow_mut();
        b.clear();
        b.resize(len, 0);
        b.as_mut_ptr()
    })
}

/// Runs function `f` on the request in the input buffer; returns the
/// length of the answer.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn call(f: u32) -> usize {
    let input = INPUT.with(|b| String::from_utf8(b.borrow().clone()));
    let out = match input {
        Err(_) => r#"{"error":"request is not UTF-8"}"#.to_string(),
        Ok(s) => match f {
            0 => api::analyze_json(&s),
            1 => api::alternating_json(&s),
            2 => api::compute(&s),
            3 => api::table_json(),
            4 => api::layout_json(&s),
            _ => r#"{"error":"unknown function"}"#.to_string(),
        },
    };
    OUTPUT.with(|o| {
        *o.borrow_mut() = out;
        o.borrow().len()
    })
}

/// Where the last answer starts.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn output_ptr() -> *const u8 {
    OUTPUT.with(|o| o.borrow().as_ptr())
}

/// The length of the last answer in bytes.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn output_len() -> usize {
    OUTPUT.with(|o| o.borrow().len())
}
