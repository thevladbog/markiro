//! Facts a device sends (stage 2a spec §4.4): scans, closed boxes, label
//! checks, box exceptions and a shift's close, in batches of
//! `POST /v1/device/facts`. The host reads each record on its own and
//! answers a receipt for each; the same record sent again gets the same
//! receipt. Marking rules stay in `@markiro/domain`: the device sends the
//! code's hash, GTIN, serial and canonical text, and the host checks their
//! shape and the shift's GTIN, never the code itself.

pub mod rules;
