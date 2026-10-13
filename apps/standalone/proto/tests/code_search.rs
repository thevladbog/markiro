//! The wire of the office's code search: every fixture round-trips, and the
//! page's bounds are the ones the webview reads.

use markiro_proto::code_search::{
    CodePlacementState, OfficeCodeCard, OfficeCodeEvent, OfficeCodePage, CODE_PAGE_SIZE,
    CODE_SEARCH_CAP,
};
use markiro_proto::{DuplicateSource, ExceptionKind, ScanVerdict};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;

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

#[test]
fn a_page_round_trips_with_every_state_of_a_placement() {
    let page: OfficeCodePage = round_trip("office-code-page.json");
    assert_eq!((page.page, page.page_count, page.total), (1, 1, 2));
    assert!(!page.capped);
    let states: Vec<CodePlacementState> = page.items.iter().map(|item| item.state).collect();
    assert_eq!(
        states,
        [CodePlacementState::Packed, CodePlacementState::Removed]
    );
    // The page's bounds: 50 rows a page, at most 10 000 counted.
    assert_eq!((CODE_PAGE_SIZE, CODE_SEARCH_CAP), (50, 10_000));
    for (state, text) in [
        (CodePlacementState::OpenBox, "open_box"),
        (CodePlacementState::Packed, "packed"),
        (CodePlacementState::Removed, "removed"),
        (CodePlacementState::Displaced, "displaced"),
        (CodePlacementState::Checked, "checked"),
    ] {
        assert_eq!(serde_json::to_value(state).unwrap(), Value::from(text));
    }
}

#[test]
fn a_card_round_trips_with_every_kind_of_event() {
    let card: OfficeCodeCard = round_trip("office-code-card.json");
    assert!(
        card.canonical.contains('\u{1d}'),
        "the group separator stays"
    );
    assert_eq!(card.placements.len(), 1);
    let kinds: Vec<&str> = card
        .events
        .iter()
        .map(|event| match event {
            OfficeCodeEvent::Scan { .. } => "scan",
            OfficeCodeEvent::Removed { .. } => "removed",
            OfficeCodeEvent::Displaced { .. } => "displaced",
            OfficeCodeEvent::Reprint { .. } => "reprint",
        })
        .collect();
    assert_eq!(
        kinds,
        ["scan", "scan", "scan", "removed", "displaced", "reprint"]
    );
    assert!(matches!(
        card.events[0],
        OfficeCodeEvent::Scan {
            verdict: ScanVerdict::WrongGtin,
            placed: false,
            ..
        }
    ));
    assert!(matches!(
        card.events[2],
        OfficeCodeEvent::Scan {
            duplicate_source: Some(DuplicateSource::Host),
            ..
        }
    ));
    assert!(matches!(
        card.events[3],
        OfficeCodeEvent::Removed {
            exception: Some(ExceptionKind::Undo),
            ..
        }
    ));
}

/// A validation shift's code (plan РЕЖ): its placements name no box, one
/// `checked`, one `displaced`, and the displacement names no box either.
#[test]
fn a_validation_shifts_card_round_trips_without_a_box() {
    let card: OfficeCodeCard = round_trip("office-code-card-validation.json");
    let placements: Vec<(CodePlacementState, Option<&str>)> = card
        .placements
        .iter()
        .map(|item| (item.state, item.box_id.as_deref()))
        .collect();
    assert_eq!(
        placements,
        [
            (CodePlacementState::Displaced, None),
            (CodePlacementState::Checked, None)
        ]
    );
    assert!(matches!(
        card.events.last(),
        Some(OfficeCodeEvent::Displaced {
            box_id: None,
            box_sscc: None,
            ..
        })
    ));
}
