//! Pure domain logic: no framework, no I/O, no dependencies.
//!
//! In the app: the rules every layer above relies on (what a note is, how two statements of it merge).
//! Used by: `app` (use-cases), `adapters` (the model server merges with the real rule).
//! Uses: nothing; `stacks/rust/boundaries.mjs` fails the build if a dependency appears.

pub mod config;
pub mod note;
