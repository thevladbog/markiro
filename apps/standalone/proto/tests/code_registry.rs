use markiro_proto::code_registry::{CodeRegistryCard, CodeRegistryPage};
#[test]
fn registry_fixtures_round_trip_both_sources_and_nullable_provenance() {
    let page: serde_json::Value =
        serde_json::from_str(include_str!("../fixtures/code-registry-page.json")).unwrap();
    let card: serde_json::Value =
        serde_json::from_str(include_str!("../fixtures/code-registry-card.json")).unwrap();
    assert_eq!(
        serde_json::to_value(serde_json::from_value::<CodeRegistryPage>(page.clone()).unwrap())
            .unwrap(),
        page
    );
    assert_eq!(
        serde_json::to_value(serde_json::from_value::<CodeRegistryCard>(card.clone()).unwrap())
            .unwrap(),
        card
    );
}
