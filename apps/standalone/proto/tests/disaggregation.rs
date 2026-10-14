//! The wire of office disaggregation documents (plan ДЗГ): every fixture
//! round-trips, a code release rides the feed keyed by its box, and the
//! requests refuse what the host does not know.

use markiro_proto::disaggregation::{
    constraints, CodeReleaseRecord, DisaggregationCreate, DisaggregationDetail,
    DisaggregationDocument, DisaggregationLineStatus, DisaggregationLinesAdd, DisaggregationReason,
    DisaggregationReasonCreate, DisaggregationReasonUpdate, DisaggregationSource,
    DisaggregationStatus, DisaggregationTransition, DisaggregationUpdate,
};
use markiro_proto::{entities, ChangesResponse, ErrorBody};
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
fn every_disaggregation_fixture_round_trips() {
    let detail: DisaggregationDetail = round_trip("disaggregation-detail.json");
    assert_eq!(
        detail
            .lines
            .iter()
            .map(|line| line.status)
            .collect::<Vec<_>>(),
        [
            DisaggregationLineStatus::Ok,
            DisaggregationLineStatus::ShiftOpen,
            DisaggregationLineStatus::AlreadyDisassembled,
            DisaggregationLineStatus::Duplicate,
            DisaggregationLineStatus::NotFound,
        ]
    );
    assert_eq!(detail.document.status, DisaggregationStatus::Draft);
    assert_eq!(detail.document.source, DisaggregationSource::Manual);
    let applied: DisaggregationDocument = round_trip("disaggregation-document.json");
    assert_eq!(applied.status, DisaggregationStatus::Applied);
    round_trip::<DisaggregationReason>("disaggregation-reason.json");
    round_trip::<DisaggregationReasonCreate>("disaggregation-reason-create.json");
    round_trip::<DisaggregationReasonUpdate>("disaggregation-reason-update.json");
    round_trip::<DisaggregationCreate>("disaggregation-create.json");
    round_trip::<DisaggregationUpdate>("disaggregation-update.json");
    round_trip::<DisaggregationLinesAdd>("disaggregation-lines-add.json");
    round_trip::<DisaggregationTransition>("disaggregation-transition.json");
    let error: ErrorBody = round_trip("error-disaggregation-invalid-lines.json");
    let details = error.error.details.unwrap();
    assert_eq!(details["constraint"], constraints::INVALID_LINES);
    assert!(constraints::ALL.contains(&constraints::INVALID_LINES));
}

#[test]
fn a_code_release_rides_the_feed_keyed_by_its_box() {
    let page: ChangesResponse = round_trip("changes-code-releases.json");
    let [item] = page.items.as_slice() else {
        panic!("one item: {:?}", page.items);
    };
    assert_eq!(item.entity, entities::CODE_RELEASES);
    assert_eq!(item.id, "b0000000-0000-4000-8000-000000000001");
    assert!(!item.deleted);
    let record: CodeReleaseRecord = serde_json::from_value(item.data.clone().unwrap()).unwrap();
    assert_eq!(record.code_count, 12);
    assert_eq!(record.document_id, "6a1f3c5e-7b9d-4e2f-8a4c-1d3e5f7a9b0c");
}

#[test]
fn the_requests_refuse_an_unknown_field_and_the_statuses_read_their_names() {
    let mut add = fixture("disaggregation-lines-add.json");
    add["lines"][0]["boxId"] = Value::from("b0000000-0000-4000-8000-000000000001");
    assert!(serde_json::from_value::<DisaggregationLinesAdd>(add).is_err());
    let mut update = fixture("disaggregation-reason-update.json");
    update["rev"] = Value::from(0);
    assert!(serde_json::from_value::<DisaggregationReasonUpdate>(update).is_err());

    for status in [
        DisaggregationStatus::Draft,
        DisaggregationStatus::Applied,
        DisaggregationStatus::Cancelled,
    ] {
        assert_eq!(status.as_str().parse::<DisaggregationStatus>(), Ok(status));
        assert_eq!(
            serde_json::to_value(status).unwrap(),
            Value::from(status.as_str())
        );
    }
    for source in [DisaggregationSource::Manual, DisaggregationSource::Import] {
        assert_eq!(source.as_str().parse::<DisaggregationSource>(), Ok(source));
    }
    for status in [
        DisaggregationLineStatus::Ok,
        DisaggregationLineStatus::NotFound,
        DisaggregationLineStatus::NotClosed,
        DisaggregationLineStatus::ShiftOpen,
        DisaggregationLineStatus::AlreadyDisassembled,
        DisaggregationLineStatus::Duplicate,
    ] {
        assert_eq!(
            status.as_str().parse::<DisaggregationLineStatus>(),
            Ok(status)
        );
    }
    assert!("written_off".parse::<DisaggregationLineStatus>().is_err());
    assert!("bogus".parse::<DisaggregationStatus>().is_err());
}

/// A header or a line that leaves a nullable key out is refused, not read as
/// `null`: a `PUT` without `comment` would otherwise clear the comment.
#[test]
fn a_nullable_key_must_be_there() {
    for body in [
        serde_json::json!({ "reasonId": null, "expectedRev": 3 }),
        serde_json::json!({ "comment": null, "expectedRev": 3 }),
        serde_json::json!({ "expectedRev": 3 }),
    ] {
        assert!(
            serde_json::from_value::<DisaggregationUpdate>(body.clone()).is_err(),
            "{body}"
        );
    }
    assert!(serde_json::from_value::<DisaggregationLinesAdd>(
        serde_json::json!({ "lines": [{ "input": "x" }] })
    )
    .is_err());
    let explicit: DisaggregationUpdate = serde_json::from_value(
        serde_json::json!({ "reasonId": null, "comment": null, "expectedRev": 3 }),
    )
    .unwrap();
    assert_eq!((explicit.reason_id, explicit.comment), (None, None));
}
