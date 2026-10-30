use markiro_proto::OfficeWarehousePalletDetail;

#[test]
fn warehouse_card_fixture_preserves_all_wire_fields() {
    let text = include_str!("../fixtures/office-warehouse-pallet-detail.json");
    let card: OfficeWarehousePalletDetail = serde_json::from_str(text).unwrap();
    assert_eq!(card.source, "cabinet");
    assert_eq!(card.members[0].production_date, "2026-10-29");
    assert_eq!(
        serde_json::to_value(card).unwrap(),
        serde_json::from_str::<serde_json::Value>(text).unwrap()
    );
}

#[test]
fn warehouse_disaggregation_line_has_its_own_target_without_a_shift() {
    let text = include_str!("../fixtures/warehouse-disaggregation-line.json");
    let line: markiro_proto::disaggregation::DisaggregationLine =
        serde_json::from_str(text).unwrap();
    assert!(line.pallet_id.is_none());
    assert!(line.shift_id.is_none());
    assert!(line.warehouse_pallet_id.is_some());
    assert_eq!(
        serde_json::to_value(line).unwrap(),
        serde_json::from_str::<serde_json::Value>(text).unwrap()
    );
}

#[test]
fn box_card_can_link_to_a_warehouse_parent() {
    let text = include_str!("../fixtures/office-box-card-warehouse.json");
    let card: markiro_proto::pack_cards::OfficeBoxCard = serde_json::from_str(text).unwrap();
    assert_eq!(
        card.pallet.as_ref().unwrap().kind.as_deref(),
        Some("warehouse")
    );
    assert_eq!(
        serde_json::to_value(card).unwrap(),
        serde_json::from_str::<serde_json::Value>(text).unwrap()
    );
}

#[test]
fn native_code_placement_keeps_origin_and_warehouse_parent_kind() {
    let text = include_str!("../fixtures/office-code-item-warehouse.json");
    let item: markiro_proto::code_search::OfficeCodeItem = serde_json::from_str(text).unwrap();
    assert_eq!(item.pallet_kind.as_deref(), Some("warehouse"));
    assert_eq!(
        serde_json::to_value(item).unwrap(),
        serde_json::from_str::<serde_json::Value>(text).unwrap()
    );
}
