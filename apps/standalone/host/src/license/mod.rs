//! The site's license (plan ЛЦ-2, spec 2026-10-13 §3, §4, §7, §8): the files
//! the office loads, the state the host computes from them and the time it
//! trusts, and the gates of new shifts, seats and features. Only the host
//! decides the state; devices read it (`GET /v1/device`).

pub mod state;
