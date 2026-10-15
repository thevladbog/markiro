//! The wire of the duplicate print (plan РЕЖ, part B, protocol 5): the
//! validation print policy of a shift as the office plans and sees it and as
//! a station enters it (the snapshot freezes the duplicate template whole),
//! and the `unit_label` fact, one record per event of a unit label job. Every
//! fixture round-trips; a snapshot frozen before part B still reads, and
//! writes back without the new field.

use markiro_proto::{
    DeviceShift, FactKind, FactRecord, LabelVerification, OfficeShift, ReprintReason, ShiftCreate,
    ShiftMode, ShiftSnapshot, ShiftUpdate, UnitLabelEvent, UnitLabelFact, UnitLabelTotals,
    ValidationPrint, PROTOCOL_VERSION,
};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::{json, Value};

fn fixture(name: &str) -> Value {
    let path = format!("{}/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    let text =
        std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("read {path}: {error}"));
    serde_json::from_str(&text).unwrap_or_else(|error| panic!("parse {path}: {error}"))
}

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

const DUPLICATE_TEMPLATE: &str = "b7c8d9e0-f1a2-4b3c-8d4e-5f6a7b8c9d0e";

fn duplicate(verification: LabelVerification) -> ValidationPrint {
    ValidationPrint::DuplicateDm {
        verification,
        template_id: DUPLICATE_TEMPLATE.to_owned(),
    }
}

#[test]
fn protocol_5_carries_the_duplicate_print() {
    assert_eq!(PROTOCOL_VERSION, 6);
    assert_eq!(FactKind::UnitLabel.as_str(), "unit_label");
    assert_eq!(
        serde_json::to_value(FactKind::UnitLabel).unwrap(),
        json!("unit_label")
    );
    assert_eq!(
        "unit_label".parse::<FactKind>().unwrap(),
        FactKind::UnitLabel
    );
}

#[test]
fn the_office_plans_a_validation_shift_that_prints_a_duplicate() {
    let create: ShiftCreate = round_trip("shift-create-validation-print.json");
    assert_eq!(create.mode, ShiftMode::Validation);
    // The owner's default: the check of the printed label is not required.
    assert_eq!(
        create.validation_print,
        Some(duplicate(LabelVerification::None))
    );
    // A shift planned without the field (every request before protocol 5)
    // names no policy, and writes back without it.
    let plain: ShiftCreate = round_trip("shift-create-validation.json");
    assert_eq!(plain.validation_print, None);
}

#[test]
fn the_office_sees_the_policy_of_a_shift() {
    let shift: OfficeShift = round_trip("office-shift-validation-print.json");
    assert_eq!(shift.mode, ShiftMode::Validation);
    assert_eq!(
        shift.validation_print,
        Some(duplicate(LabelVerification::None))
    );
    // Its card counts its labels (task B3).
    assert_eq!(
        shift.totals.unit_labels,
        Some(UnitLabelTotals {
            sent: 321,
            verified: 0,
            skipped: 0,
            unresolved: 2,
            reprints: 3
        })
    );
    for name in ["office-shift.json", "office-shift-validation.json"] {
        let shift: OfficeShift = round_trip(name);
        assert_eq!(shift.validation_print, None, "{name}");
        assert_eq!(shift.totals.unit_labels, None, "{name}");
    }
}

#[test]
fn an_edit_sends_the_policy_only_when_it_changes_it() {
    let edit: ShiftUpdate = round_trip("shift-update.json");
    assert_eq!(edit.validation_print, None);
    let mut value = fixture("shift-update.json");
    value["validationPrint"] = json!({ "mode": "none" });
    let off: ShiftUpdate = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(off.validation_print, Some(ValidationPrint::None {}));
    assert_eq!(serde_json::to_value(&off).unwrap(), value);
}

#[test]
fn the_snapshot_freezes_the_policy_and_the_duplicate_template_whole() {
    let entered: DeviceShift = round_trip("device-shift-entered-validation-print.json");
    let policy = entered
        .validation_print
        .clone()
        .expect("the shift names its policy");
    let snapshot = entered.snapshot.expect("an entry carries the snapshot");
    let frozen = snapshot
        .validation_print
        .expect("the snapshot freezes the policy");
    // The snapshot's policy is the shift's.
    let ValidationPrint::DuplicateDm {
        verification,
        template_id,
    } = policy
    else {
        panic!("the shift prints a duplicate");
    };
    assert_eq!(frozen.verification, verification);
    assert_eq!(frozen.template.id, template_id);
    assert!(frozen.template.spec["elements"].is_array());
    assert_ne!(frozen.template.id, snapshot.box_template.id);
}

/// A shift opened before part B froze a snapshot without the field: the
/// owner's re-entry reads the stored text through [`ShiftSnapshot`], so it
/// must read as no policy, and the host's answer must write it back as it
/// was (the field is left out, not `null`).
#[test]
fn a_snapshot_frozen_before_part_b_reads_and_writes_back_unchanged() {
    for name in [
        "device-shift-entered.json",
        "device-shift-entered-pallets.json",
        "device-shift-entered-sheet.json",
        "device-shift-entered-validation.json",
    ] {
        let entered: DeviceShift = round_trip(name);
        assert_eq!(entered.validation_print, None, "{name}");
        let stored = fixture(name)["snapshot"].clone();
        let snapshot: ShiftSnapshot = serde_json::from_value(stored.clone()).unwrap();
        assert_eq!(snapshot.validation_print, None, "{name}");
        let text = serde_json::to_string(&snapshot).unwrap();
        assert!(!text.contains("validationPrint"), "{name}: {text}");
        assert_eq!(
            serde_json::from_str::<Value>(&text).unwrap(),
            stored,
            "{name}"
        );
    }
}

#[test]
fn the_policy_reads_exactly_its_two_shapes() {
    let read = |value: Value| serde_json::from_value::<ValidationPrint>(value);
    assert_eq!(
        read(json!({ "mode": "none" })).unwrap(),
        ValidationPrint::None {}
    );
    assert_eq!(
        read(json!({ "mode": "duplicate_dm", "verification": "required", "templateId": DUPLICATE_TEMPLATE }))
            .unwrap(),
        duplicate(LabelVerification::Required)
    );
    for refused in [
        json!({}),
        json!({ "mode": "aggregation" }),
        json!({ "mode": "duplicate_dm" }),
        json!({ "mode": "duplicate_dm", "verification": "none" }),
        json!({ "mode": "duplicate_dm", "templateId": DUPLICATE_TEMPLATE }),
        json!({ "mode": "duplicate_dm", "verification": "optional", "templateId": DUPLICATE_TEMPLATE }),
        json!({ "mode": "duplicate_dm", "verification": "none", "template_id": DUPLICATE_TEMPLATE }),
        // The cloud's reprocessing of earlier codes is part C: not this wire.
        json!({
            "mode": "duplicate_dm", "verification": "none", "templateId": DUPLICATE_TEMPLATE,
            "allowPreviouslyAcceptedCodes": false
        }),
        json!({ "mode": "none", "templateId": DUPLICATE_TEMPLATE }),
        json!({ "mode": "none", "verification": "none" }),
    ] {
        assert!(read(refused.clone()).is_err(), "{refused}");
    }
    assert_eq!(
        (
            LabelVerification::None.as_str(),
            LabelVerification::Required.as_str()
        ),
        ("none", "required")
    );
    assert_eq!(
        "required".parse::<LabelVerification>().unwrap(),
        LabelVerification::Required
    );
}

#[test]
fn every_unit_label_fixture_reads_as_its_event() {
    let expected = [
        ("prepared", 1, UnitLabelEvent::Prepared, None, None),
        ("sent", 1, UnitLabelEvent::Sent, None, None),
        ("verified", 1, UnitLabelEvent::Verified, None, None),
        (
            "skipped",
            1,
            UnitLabelEvent::VerificationSkipped,
            None,
            None,
        ),
        (
            "unknown",
            1,
            UnitLabelEvent::DeliveryUnknown,
            None,
            Some("interrupted"),
        ),
        (
            "reprint",
            2,
            UnitLabelEvent::Prepared,
            Some(ReprintReason::Damaged),
            None,
        ),
    ];
    let mut jobs = Vec::new();
    for (name, attempt_no, event, reason, error_code) in expected {
        let record: FactRecord = round_trip(&format!("fact-unit-label-{name}.json"));
        assert_eq!(record.kind, FactKind::UnitLabel, "{name}");
        let data = record.data.clone();
        let fact: UnitLabelFact =
            serde_json::from_value(data.clone()).unwrap_or_else(|error| panic!("{name}: {error}"));
        assert_eq!(serde_json::to_value(&fact).unwrap(), data, "{name}");
        assert_eq!(
            (
                fact.attempt_no,
                fact.event,
                fact.reason,
                fact.error_code.as_deref()
            ),
            (attempt_no, event, reason, error_code),
            "{name}"
        );
        // Never the full code: its hash and the digests only.
        assert!(!data.to_string().contains('\u{1d}'), "{name}");
        jobs.push(fact.job_id);
    }
    jobs.dedup();
    assert_eq!(jobs.len(), 1, "the fixtures are one job's events");
}

/// A skipped check and a reprint's `prepared` are the operator's decisions
/// (their record names the operator, as `isOperatorDecision` in
/// `protocol.ts`); a first attempt's `prepared` and every other event are
/// not.
#[test]
fn a_skipped_check_and_a_reprint_are_the_operators_decisions() {
    let data = fixture("fact-unit-label-sent.json")["data"].clone();
    let fact: UnitLabelFact = serde_json::from_value(data).unwrap();
    for event in [
        UnitLabelEvent::Prepared,
        UnitLabelEvent::Sending,
        UnitLabelEvent::Sent,
        UnitLabelEvent::FailedBeforeSend,
        UnitLabelEvent::DeliveryUnknown,
        UnitLabelEvent::Verified,
        UnitLabelEvent::VerificationRejected,
        UnitLabelEvent::VerificationSkipped,
    ] {
        for attempt_no in [1, 2] {
            let decision = event == UnitLabelEvent::VerificationSkipped
                || (event == UnitLabelEvent::Prepared && attempt_no == 2);
            let fact = UnitLabelFact {
                event,
                attempt_no,
                ..fact.clone()
            };
            assert_eq!(
                fact.is_operator_decision(),
                decision,
                "{event:?} {attempt_no}"
            );
        }
    }
}

/// The names are the domain's (`productLabelEventSchema` kinds and its
/// `ReprintReason`, `packages/domain/src/product-labels/contracts.ts`).
#[test]
fn the_events_and_the_reasons_are_the_domains() {
    let events = [
        (UnitLabelEvent::Prepared, "prepared"),
        (UnitLabelEvent::Sending, "sending"),
        (UnitLabelEvent::Sent, "sent"),
        (UnitLabelEvent::FailedBeforeSend, "failed_before_send"),
        (UnitLabelEvent::DeliveryUnknown, "delivery_unknown"),
        (UnitLabelEvent::Verified, "verified"),
        (
            UnitLabelEvent::VerificationRejected,
            "verification_rejected",
        ),
        (UnitLabelEvent::VerificationSkipped, "verification_skipped"),
    ];
    for (event, name) in events {
        assert_eq!(event.as_str(), name);
        assert_eq!(serde_json::to_value(event).unwrap(), json!(name));
        assert_eq!(name.parse::<UnitLabelEvent>().unwrap(), event);
    }
    for (reason, name) in [
        (ReprintReason::NotPrinted, "not_printed"),
        (ReprintReason::Damaged, "damaged"),
        (ReprintReason::Lost, "lost"),
    ] {
        assert_eq!(reason.as_str(), name);
        assert_eq!(serde_json::to_value(reason).unwrap(), json!(name));
        assert_eq!(name.parse::<ReprintReason>().unwrap(), reason);
    }
}

#[test]
fn a_unit_label_fact_refuses_what_it_does_not_know() {
    let data = fixture("fact-unit-label-sent.json")["data"].clone();
    let read = |value: Value| serde_json::from_value::<UnitLabelFact>(value);
    let mut extra = data.clone();
    extra["code"] = json!("0104600682000013215Yq'Ct;\u{1d}93dGVz");
    assert!(read(extra).is_err());
    let mut event = data.clone();
    event["event"] = json!("printed");
    assert!(read(event).is_err());
    let mut reason = data.clone();
    reason["reason"] = json!("smudged");
    assert!(read(reason).is_err());
    let mut attempt = data;
    attempt["attemptNo"] = json!(-1);
    assert!(read(attempt).is_err());
}

/// The rules of a unit label event that every record must keep and the host
/// checks before it writes one (`UnitLabelFact::check`), from the fixture the
/// webview's `unitLabelFactSchema` is held to as well
/// (`proto/fixtures/unit-label-rules.json`): the events and each one's error
/// codes, the reprint reasons, and each case's refused field.
#[test]
fn a_unit_label_fact_keeps_the_rules_of_the_shared_fixture() {
    let rules = fixture("unit-label-rules.json");
    let events: Vec<&str> = rules["events"]
        .as_array()
        .unwrap()
        .iter()
        .map(|event| event.as_str().unwrap())
        .collect();
    let all = [
        UnitLabelEvent::Prepared,
        UnitLabelEvent::Sending,
        UnitLabelEvent::Sent,
        UnitLabelEvent::FailedBeforeSend,
        UnitLabelEvent::DeliveryUnknown,
        UnitLabelEvent::Verified,
        UnitLabelEvent::VerificationRejected,
        UnitLabelEvent::VerificationSkipped,
    ];
    assert_eq!(
        events,
        all.iter().map(|event| event.as_str()).collect::<Vec<_>>()
    );
    for event in all {
        assert_eq!(
            json!(event.error_codes()),
            rules["errorCodes"][event.as_str()],
            "{}",
            event.as_str()
        );
    }
    assert_eq!(
        rules["reasons"],
        json!([
            ReprintReason::NotPrinted.as_str(),
            ReprintReason::Damaged.as_str(),
            ReprintReason::Lost.as_str()
        ])
    );
    let cases = rules["cases"].as_array().unwrap();
    assert!(cases.len() > 20, "{}", cases.len());
    for case in cases {
        let mut data = rules["base"].clone();
        for (key, value) in case["change"].as_object().unwrap() {
            data[key] = value.clone();
        }
        let fact: UnitLabelFact = serde_json::from_value(data.clone())
            .unwrap_or_else(|error| panic!("{}: {error}", case["change"]));
        assert_eq!(
            fact.check().err(),
            case["field"].as_str(),
            "{}",
            case["change"]
        );
    }
}
