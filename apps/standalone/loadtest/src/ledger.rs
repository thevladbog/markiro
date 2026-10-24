//! What the host acknowledged, kept as the run goes: the oracle the end of
//! the run reconciles the host's totals against. Only the first receipt of a
//! record counts (a resend gets the same one); a code is kept by the first
//! eight bytes of its hash, which keeps a four-hour run small.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use markiro_proto::FactKind;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// What the harness knows of a fact it queued, to read its receipt by.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FactMeta {
    pub kind: FactKind,
    /// The key of the code of an accepted-verdict scan.
    pub claims: Option<u64>,
}

#[derive(Debug, Default)]
pub struct Ledger {
    pub records: BTreeMap<u32, u64>,
    pub scan_rows: BTreeMap<u32, u64>,
    pub accepted_scans: BTreeMap<u32, u64>,
    pub conflict_receipts: u64,
    pub accepted_codes: HashMap<u64, u32>,
    pub boxes_closed: BTreeMap<u32, u64>,
    pub pallets_closed: BTreeMap<u32, u64>,
    pub rejected: BTreeMap<String, u64>,
    /// The ids of the records each device had acknowledged, when asked for (`track_ids`): a
    /// scenario that kills the host checks every one of them is still there afterwards.
    acked_ids: Option<BTreeMap<u32, BTreeSet<String>>>,
}

/// The oracle's figures, as a report keeps them.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Expected {
    pub records: u64,
    pub scan_rows: u64,
    pub distinct_accepted_codes: u64,
    pub conflict_receipts: u64,
    pub displacements: u64,
    pub boxes_closed: u64,
    pub pallets_closed: u64,
    pub rejected: u64,
}

/// What the end-of-run checks read of the ledger, copied out of its lock.
#[derive(Debug, Clone, Default)]
pub struct Snapshot {
    pub expected: Expected,
    pub records: BTreeMap<u32, u64>,
    pub scan_rows: BTreeMap<u32, u64>,
    pub boxes_closed: BTreeMap<u32, u64>,
    pub pallets_closed: BTreeMap<u32, u64>,
}

fn bump<K: Ord>(map: &mut BTreeMap<K, u64>, key: K) {
    *map.entry(key).or_default() += 1;
}

impl Ledger {
    /// Keep the id of every record acknowledged from now on (off by default: a long run's ids
    /// would only cost memory).
    pub fn track_ids(&mut self) {
        self.acked_ids.get_or_insert_with(BTreeMap::new);
    }

    /// The acknowledged record ids by device, when tracked.
    pub fn acked_ids(&self) -> Option<&BTreeMap<u32, BTreeSet<String>>> {
        self.acked_ids.as_ref()
    }

    /// The receipt of one of `device`'s records, the first time it is seen.
    pub fn apply(&mut self, device: u32, meta: &FactMeta, receipt: &Value) {
        bump(&mut self.records, device);
        if let (Some(ids), Some(id)) = (
            self.acked_ids.as_mut(),
            receipt.get("id").and_then(Value::as_str),
        ) {
            ids.entry(device).or_default().insert(id.to_owned());
        }
        let outcome = receipt.get("outcome").and_then(Value::as_str).unwrap_or("");
        if outcome == "rejected" {
            let code = receipt
                .get("code")
                .and_then(Value::as_str)
                .unwrap_or("none");
            bump(&mut self.rejected, code.to_owned());
            return;
        }
        match (meta.kind, outcome) {
            (FactKind::Scan, "accepted") => {
                bump(&mut self.scan_rows, device);
                if let Some(key) = meta.claims {
                    bump(&mut self.accepted_scans, device);
                    *self.accepted_codes.entry(key).or_default() += 1;
                }
            }
            (FactKind::Scan, "conflict") => {
                bump(&mut self.scan_rows, device);
                self.conflict_receipts += 1;
            }
            (FactKind::BoxClosed, "accepted") => bump(&mut self.boxes_closed, device),
            (FactKind::PalletClosed, "accepted") => bump(&mut self.pallets_closed, device),
            _ => {}
        }
    }

    /// Two accepted scans of one code mean the earlier displaced the later
    /// owner: one `displaced` row for each scan beyond the first.
    pub fn displacements(&self) -> u64 {
        self.accepted_codes
            .values()
            .map(|count| u64::from(count.saturating_sub(1)))
            .sum()
    }

    pub fn snapshot(&self) -> Snapshot {
        Snapshot {
            expected: self.expected(),
            records: self.records.clone(),
            scan_rows: self.scan_rows.clone(),
            boxes_closed: self.boxes_closed.clone(),
            pallets_closed: self.pallets_closed.clone(),
        }
    }

    pub fn expected(&self) -> Expected {
        Expected {
            records: self.records.values().sum(),
            scan_rows: self.scan_rows.values().sum(),
            distinct_accepted_codes: self.accepted_codes.len() as u64,
            conflict_receipts: self.conflict_receipts,
            displacements: self.displacements(),
            boxes_closed: self.boxes_closed.values().sum(),
            pallets_closed: self.pallets_closed.values().sum(),
            rejected: self.rejected.values().sum(),
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::rng::Rng;

    fn scan(claims: Option<u64>) -> FactMeta {
        FactMeta {
            kind: FactKind::Scan,
            claims,
        }
    }

    fn kind(kind: FactKind) -> FactMeta {
        FactMeta { kind, claims: None }
    }

    #[test]
    fn acknowledged_record_ids_are_kept_by_device_only_when_asked_for() {
        let mut ledger = Ledger::default();
        ledger.apply(
            0,
            &scan(Some(1)),
            &json!({"id": "r0", "outcome": "accepted"}),
        );
        assert!(ledger.acked_ids().is_none());
        ledger.track_ids();
        ledger.apply(
            0,
            &scan(Some(2)),
            &json!({"id": "r1", "outcome": "accepted"}),
        );
        ledger.apply(
            1,
            &scan(Some(2)),
            &json!({"id": "r2", "outcome": "conflict"}),
        );
        ledger.apply(
            1,
            &scan(Some(3)),
            &json!({"id": "r3", "outcome": "rejected", "code": "gtin_mismatch"}),
        );
        let ids = ledger.acked_ids().expect("tracked");
        let set = |items: &[&str]| {
            items
                .iter()
                .map(|id| (*id).to_owned())
                .collect::<BTreeSet<_>>()
        };
        assert_eq!(ids.get(&0), Some(&set(&["r1"])));
        assert_eq!(ids.get(&1), Some(&set(&["r2", "r3"])));
    }

    #[test]
    fn receipts_are_read_by_kind_and_outcome() {
        let mut ledger = Ledger::default();
        ledger.apply(0, &scan(Some(1)), &json!({"outcome": "accepted"}));
        ledger.apply(1, &scan(Some(2)), &json!({"outcome": "accepted"}));
        ledger.apply(1, &scan(Some(1)), &json!({"outcome": "conflict"}));
        ledger.apply(1, &scan(None), &json!({"outcome": "accepted"}));
        ledger.apply(
            0,
            &FactMeta {
                kind: FactKind::BoxClosed,
                claims: None,
            },
            &json!({"outcome": "accepted"}),
        );
        ledger.apply(
            0,
            &scan(Some(3)),
            &json!({"outcome": "rejected", "code": "gtin_mismatch"}),
        );
        let expected = ledger.expected();
        assert_eq!(
            expected,
            Expected {
                records: 6,
                scan_rows: 4,
                distinct_accepted_codes: 2,
                conflict_receipts: 1,
                displacements: 0,
                boxes_closed: 1,
                pallets_closed: 0,
                rejected: 1,
            }
        );
        assert_eq!(ledger.rejected["gtin_mismatch"], 1);
        assert_eq!(ledger.accepted_scans[&1], 1);
    }

    #[test]
    fn a_code_accepted_twice_counts_one_displacement_and_one_code() {
        let mut ledger = Ledger::default();
        ledger.apply(0, &scan(Some(9)), &json!({"outcome": "accepted"}));
        ledger.apply(1, &scan(Some(9)), &json!({"outcome": "accepted"}));
        assert_eq!(ledger.displacements(), 1);
        assert_eq!(ledger.expected().distinct_accepted_codes, 1);
        assert_eq!(ledger.expected().scan_rows, 2);
    }

    #[test]
    fn a_rejected_receipt_without_a_code_is_kept_under_none_and_writes_no_row() {
        let mut ledger = Ledger::default();
        ledger.apply(4, &scan(Some(5)), &json!({"outcome": "rejected"}));
        assert_eq!(ledger.rejected["none"], 1);
        let expected = ledger.expected();
        assert_eq!((expected.records, expected.scan_rows), (1, 0));
        assert!(ledger.accepted_codes.is_empty());
    }

    #[test]
    fn pallet_closes_count_and_a_conflict_of_another_kind_counts_only_as_a_record() {
        let mut ledger = Ledger::default();
        let pallet = kind(FactKind::PalletClosed);
        ledger.apply(2, &pallet, &json!({"outcome": "accepted"}));
        ledger.apply(2, &pallet, &json!({"outcome": "conflict"}));
        let expected = ledger.expected();
        assert_eq!((expected.records, expected.pallets_closed), (2, 1));
        assert_eq!(expected.conflict_receipts, 0);
    }

    #[test]
    fn the_snapshot_is_a_copy_of_what_the_checks_read() {
        let mut ledger = Ledger::default();
        ledger.apply(0, &scan(Some(1)), &json!({"outcome": "accepted"}));
        ledger.apply(
            1,
            &kind(FactKind::BoxClosed),
            &json!({"outcome": "accepted"}),
        );
        ledger.apply(
            1,
            &kind(FactKind::PalletClosed),
            &json!({"outcome": "accepted"}),
        );
        let snapshot = ledger.snapshot();
        ledger.apply(0, &scan(Some(2)), &json!({"outcome": "accepted"}));
        assert_eq!(snapshot.expected.records, 3);
        assert_eq!(snapshot.records[&0], 1);
        assert_eq!(snapshot.records[&1], 2);
        assert_eq!(snapshot.scan_rows[&0], 1);
        assert_eq!(snapshot.boxes_closed[&1], 1);
        assert_eq!(snapshot.pallets_closed[&1], 1);
        assert_eq!(ledger.expected().records, 4);
    }

    /// The invariant the end-of-run check leans on: whatever the arrival
    /// order of accepted scans, every acceptance of a code beyond the first is
    /// one displacement, and the totals agree with each other.
    #[test]
    fn totals_agree_for_any_mix_of_receipts() {
        let outcomes = ["accepted", "conflict", "rejected"];
        for seed in 0..40 {
            let mut rng = Rng::new(seed);
            let mut ledger = Ledger::default();
            let (mut accepted_claims, mut conflicts, mut rejected) = (0u64, 0u64, 0u64);
            let (mut applied, mut scan_rows) = (0u64, 0u64);
            let mut distinct = std::collections::HashSet::new();
            for _ in 0..300 {
                let device = rng.range(0, 5) as u32;
                let key = rng.range(0, 40);
                let claims = rng.chance(0.8).then_some(key);
                let outcome = outcomes[rng.range(0, 3) as usize];
                let receipt = if outcome == "rejected" {
                    json!({"outcome": outcome, "code": "gtin_mismatch"})
                } else {
                    json!({"outcome": outcome})
                };
                ledger.apply(device, &scan(claims), &receipt);
                applied += 1;
                match outcome {
                    "rejected" => rejected += 1,
                    "conflict" => {
                        conflicts += 1;
                        scan_rows += 1;
                    }
                    _ => {
                        scan_rows += 1;
                        if let Some(key) = claims {
                            accepted_claims += 1;
                            distinct.insert(key);
                        }
                    }
                }
            }
            let expected = ledger.expected();
            assert_eq!(expected.records, applied, "seed {seed}");
            assert_eq!(expected.scan_rows, scan_rows, "seed {seed}");
            assert_eq!(expected.rejected, rejected, "seed {seed}");
            assert_eq!(expected.conflict_receipts, conflicts, "seed {seed}");
            assert_eq!(
                expected.distinct_accepted_codes,
                distinct.len() as u64,
                "seed {seed}"
            );
            assert_eq!(
                expected.displacements + expected.distinct_accepted_codes,
                accepted_claims,
                "seed {seed}"
            );
        }
    }

    #[test]
    fn expected_is_serialised_in_camel_case_as_a_report_keeps_it() {
        let value = serde_json::to_value(Expected {
            records: 1,
            scan_rows: 2,
            distinct_accepted_codes: 3,
            conflict_receipts: 4,
            displacements: 5,
            boxes_closed: 6,
            pallets_closed: 7,
            rejected: 8,
        })
        .unwrap();
        assert_eq!(value["scanRows"], 2);
        assert_eq!(value["distinctAcceptedCodes"], 3);
        assert_eq!(value["conflictReceipts"], 4);
        assert_eq!(value["palletsClosed"], 7);
        let back: Expected = serde_json::from_value(value).unwrap();
        assert_eq!(back.rejected, 8);
    }
}
