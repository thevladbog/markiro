mod support;
use markiro_host::cloud_history::read::BoxCardScope;

async fn assert_indexed(scope: &str, index: &str) {
    let a = support::app::admin().await;
    let id = "20000000-0000-4000-8000-000000000001";
    let query = match scope {
        "box" => BoxCardScope::Box(id),
        "shift" => BoxCardScope::Shift(id),
        "pallet" => BoxCardScope::Pallet(id),
        _ => panic!("unknown test scope"),
    };
    let plan: Vec<(i64, i64, i64, String)> =
        sqlx::query_as(&format!("EXPLAIN QUERY PLAN {}", query.sql()))
            .bind(query.id())
            .fetch_all(&a.app.state.pool)
            .await
            .unwrap();
    let steps: Vec<_> = plan.iter().map(|(_, _, _, step)| step.as_str()).collect();
    assert!(
        !steps.iter().any(|step| step.starts_with("SCAN x")),
        "{scope}: {steps:?}"
    );
    assert!(
        steps
            .iter()
            .any(|step| step.starts_with("SEARCH x") && step.contains(index)),
        "{scope}: {steps:?}"
    );
    assert!(
        steps
            .iter()
            .any(|step| step.starts_with("SEARCH i") && step.contains("box_id=?")),
        "{scope} item lookup: {steps:?}"
    );
}

#[tokio::test]
async fn individual_box_card_searches_primary_key() {
    assert_indexed("box", "sqlite_autoindex_cloud_history_boxes_1").await;
}
#[tokio::test]
async fn shift_box_cards_search_shift_index() {
    assert_indexed("shift", "cloud_history_boxes_shift").await;
}
#[tokio::test]
async fn pallet_member_cards_search_pallet_index() {
    assert_indexed("pallet", "cloud_history_boxes_pallet").await;
}
