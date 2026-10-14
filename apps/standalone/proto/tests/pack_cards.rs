//! The wire of the box and pallet cards and of the pallet list (plan КРТ):
//! every fixture round-trips, and the cards carry no full code.

use markiro_proto::code_search::CodePlacementState;
use markiro_proto::pack_cards::{
    OfficeBoxCard, OfficePalletCard, OfficePalletPage, CARD_ROW_LIMIT, PALLET_PAGE_SIZE,
};
use markiro_proto::{ExceptionKind, OfficeBox, PalletExceptionKind};
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
fn a_box_card_round_trips_with_every_state_of_an_item_and_no_full_code() {
    let card: OfficeBoxCard = round_trip("office-box-card.json");
    let states: Vec<CodePlacementState> = card.items.iter().map(|item| item.state).collect();
    assert_eq!(
        states,
        [
            CodePlacementState::Removed,
            CodePlacementState::Displaced,
            CodePlacementState::Packed
        ]
    );
    assert_eq!(card.exceptions[0].kind, ExceptionKind::Undo);
    // No full code on this wire: no group separator, no crypto tail.
    let text = fixture("office-box-card.json").to_string();
    assert!(
        !text.contains("\\u001d") && !text.contains("canonical"),
        "{text}"
    );
}

#[test]
fn a_card_of_a_host_before_plan_dzg_reads_without_documents() {
    let mut card = fixture("office-box-card.json");
    card.as_object_mut().unwrap().remove("documents");
    let card: OfficeBoxCard = serde_json::from_value(card).unwrap();
    assert!(card.documents.is_empty());
    let mut pallet = fixture("office-pallet-card.json");
    pallet.as_object_mut().unwrap().remove("documents");
    let pallet: OfficePalletCard = serde_json::from_value(pallet).unwrap();
    assert!(pallet.documents.is_empty());
}

#[test]
fn a_pallet_card_and_a_page_round_trip() {
    let card: OfficePalletCard = round_trip("office-pallet-card.json");
    assert_eq!((card.boxes, card.box_count_reported), (1, Some(2)));
    assert_eq!(card.members.len(), 2, "a box taken apart stays on the list");
    assert_eq!(card.exceptions[0].kind, PalletExceptionKind::Reprint);
    let page: OfficePalletPage = round_trip("office-pallet-page.json");
    assert_eq!(page.items[0].closed_at, None, "open pallets come first");
    assert_eq!((CARD_ROW_LIMIT, PALLET_PAGE_SIZE), (10_000, 100));
}

#[test]
fn a_box_of_a_host_before_plan_krt_reads_without_its_operator() {
    let mut boxes = fixture("office-boxes.json");
    boxes[0].as_object_mut().unwrap().remove("operatorName");
    let boxes: Vec<OfficeBox> = serde_json::from_value(boxes).unwrap();
    assert_eq!(boxes[0].operator_name, None);
}
