//! Use-cases and the ports they depend on.
//!
//! In the app: what the product does (save a note, deliver it) in terms of ports, never a vendor.
//! Used by: the composition root (wires adapters in); `adapters` implements the ports.
//! Uses: `domain`. Depends on no adapter, and the boundary check keeps it so.

pub mod config;
pub mod note_sync;
pub mod ports;
