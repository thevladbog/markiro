//! The backup and restore shapes (plan РК) against their fixtures, which
//! `test/backups.test.ts` parses with the Zod schemas too.

use markiro_proto::backup::{
    dir_problems, failure, known_block_codes, BackupSettingsUpdate, BackupState, BackupTrigger,
    KnownBlockOutcome, KnownBlocksRequest, KnownBlocksResponse,
};
use markiro_proto::{codes, ErrorBody, Hello};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::{json, Value};

fn fixture(name: &str) -> Value {
    let path = format!("{}/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    let text =
        std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("read {path}: {error}"));
    serde_json::from_str(&text).unwrap_or_else(|error| panic!("parse {path}: {error}"))
}

/// Deserialize into `T` and serialize back: the JSON must survive unchanged.
fn round_trip<T: DeserializeOwned + Serialize>(name: &str) -> T {
    let original = fixture(name);
    let typed: T =
        serde_json::from_value(original.clone()).unwrap_or_else(|error| panic!("{name}: {error}"));
    assert_eq!(
        serde_json::to_value(&typed).unwrap(),
        original,
        "{name} changed on round trip"
    );
    typed
}

#[test]
fn backup_states_round_trip() {
    let state: BackupState = round_trip("backup-state.json");
    assert_eq!(state.local.copies.len(), 2);
    assert_eq!(state.local.copies[1].trigger, BackupTrigger::Manual);
    assert!(state.local.copies[0].host_identity);
    assert!(!state.local.copies[1].host_identity);
    let second = state.second.expect("the fixture has a second folder");
    assert_eq!(
        second.last_attempt.unwrap().code.as_deref(),
        Some(failure::DESTINATION_UNAVAILABLE)
    );
    let running: BackupState = round_trip("backup-state-running.json");
    assert_eq!(running.second, None);
    assert_eq!(running.running.unwrap().trigger, BackupTrigger::Manual);
    assert_eq!(running.restore_hold, None);
}

#[test]
fn a_held_host_names_its_stations_and_refuses_facts_with_restore_pending() {
    let held: BackupState = round_trip("backup-state-held.json");
    let hold = held.restore_hold.expect("the fixture holds the facts");
    assert_eq!(hold.since, "2026-10-09T15:00:00Z");
    let reconciled: Vec<bool> = hold.stations.iter().map(|each| each.reconciled).collect();
    assert_eq!(reconciled, [true, false]);
    assert_eq!(hold.stations[1].last_seen_at, None);
    let refusal: ErrorBody = round_trip("error-restore-pending.json");
    assert_eq!(refusal.error.code, codes::RESTORE_PENDING);
    assert!(codes::ALL.contains(&codes::RESTORE_PENDING));
}

#[test]
fn the_settings_update_is_strict_and_clears_with_null() {
    let update: BackupSettingsUpdate = round_trip("backup-settings-update.json");
    assert_eq!(update.expected_rev, 7);
    let cleared: BackupSettingsUpdate =
        serde_json::from_value(json!({ "secondDir": null, "expectedRev": 1 })).unwrap();
    assert_eq!(cleared.second_dir, None);
    let extra = json!({ "secondDir": null, "expectedRev": 1, "localDir": "/x" });
    assert!(serde_json::from_value::<BackupSettingsUpdate>(extra).is_err());
    let missing = json!({ "expectedRev": 1 });
    assert!(serde_json::from_value::<BackupSettingsUpdate>(missing).is_err());
}

#[test]
fn known_blocks_round_trip_and_the_request_is_strict() {
    let request: KnownBlocksRequest = round_trip("known-blocks-request.json");
    assert_eq!(request.blocks[0].to_serial, 5499);
    let mut extra = fixture("known-blocks-request.json");
    extra["blocks"][0]["nextSerial"] = json!(3600);
    assert!(serde_json::from_value::<KnownBlocksRequest>(extra).is_err());
    let mut top_level = fixture("known-blocks-request.json");
    top_level["epoch"] = json!("5d2c8e1a-7b3f-4c9d-a0e1-2f3a4b5c6d7e");
    assert!(serde_json::from_value::<KnownBlocksRequest>(top_level).is_err());
    let response: KnownBlocksResponse = round_trip("known-blocks-response.json");
    let outcomes: Vec<_> = response.results.iter().map(|each| each.outcome).collect();
    assert_eq!(
        outcomes,
        [
            KnownBlockOutcome::Registered,
            KnownBlockOutcome::Known,
            KnownBlockOutcome::Refused
        ]
    );
}

#[test]
fn hello_carries_the_restore_epoch_only_after_a_restore() {
    let restored: Hello = round_trip("hello-restored.json");
    assert_eq!(
        restored.restore_epoch.as_deref(),
        Some("5d2c8e1a-7b3f-4c9d-a0e1-2f3a4b5c6d7e")
    );
    let plain: Hello = round_trip("hello.json");
    assert_eq!(plain.restore_epoch, None);
    assert!(serde_json::to_value(&plain)
        .unwrap()
        .get("restoreEpoch")
        .is_none());
}

#[test]
fn the_code_lists_match_their_fixture() {
    let listed = fixture("backup-codes.json");
    let names = |key: &str| -> Vec<String> {
        listed[key]
            .as_array()
            .unwrap()
            .iter()
            .map(|code| code.as_str().unwrap().to_owned())
            .collect()
    };
    assert_eq!(names("failures"), failure::ALL);
    assert_eq!(names("dirProblems"), dir_problems::ALL);
    assert_eq!(names("knownBlockCodes"), known_block_codes::ALL);
}
