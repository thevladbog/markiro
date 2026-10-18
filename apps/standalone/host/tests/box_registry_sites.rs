//! Every write that changes what the box registry shows moves `boxes.changed_at` to the host's
//! time (plan ТСД-Х, task Х4). `box_registry_touch.rs` knows every writer of `boxes`; this file
//! proves each writer's call to `facts::registry_touch` is there: remove one call and one test
//! here goes red (the mutants are named at each test).

mod support;

use serde_json::{json, Value};
use support::app::{
    admin, box_closed, box_id, fact, instant, issue_block, issue_pallet_block, ok_scan,
    open_pallet_floor, pair_handheld, pallet_closed, pallet_id, receipts, record_id, shift_setup,
    sscc, Admin, Floor,
};
use support::disaggregation::{applied, pallet_day};
use support::handheld::{
    added, box_sscc, closed_boxes, event, opened, pallet_block, pallet_sscc, product_of,
    receipts_of,
};
use time::Duration;

async fn changed(admin: &Admin) -> Vec<(String, Option<String>)> {
    sqlx::query_as("SELECT id, changed_at FROM boxes ORDER BY id")
        .fetch_all(&admin.app.state.pool)
        .await
        .unwrap()
}

/// Every closed box has `at` as its change time.
fn all_at(rows: &[(String, Option<String>)], at: &str) {
    assert!(!rows.is_empty());
    for (id, changed_at) in rows {
        assert_eq!(changed_at.as_deref(), Some(at), "{id}");
    }
}

/// Two boxes closed on production pallet 1 (not yet closed) at the clock's time `T`; returns the
/// floor and the pallet block.
async fn boxes_on_a_standing_pallet(admin: &Admin) -> (Floor, Value) {
    let setup = shift_setup(admin).await;
    let floor = open_pallet_floor(admin, &setup, &admin.key.clone(), &setup.line).await;
    let block = issue_block(
        &admin.app,
        &floor.key,
        "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a",
    )
    .await;
    let pallets = issue_pallet_block(
        &admin.app,
        &floor.key,
        "5e4d3c2b-1a09-4f8e-9d7c-6b5a4f3e2d1c",
    )
    .await;
    let mut records = Vec::new();
    for (n, serial) in [(1_u32, 1500_u64), (2, 1501)] {
        let mut closed = box_closed(
            &box_id(n),
            &block,
            serial,
            &[n],
            &instant(10 * n, 0),
            &instant(10 * n + 5, 0),
        );
        closed["palletId"] = json!(pallet_id(1));
        records.push(fact(
            &record_id(n),
            "scan",
            &floor.shift,
            ok_scan(n, &box_id(n), &instant(10 * n, 0)),
        ));
        records.push(fact(&record_id(10 + n), "box_closed", &floor.shift, closed));
    }
    let answered = receipts(&admin.app, &floor.key, &records).await;
    assert!(
        answered.iter().all(|r| r["outcome"] == "accepted"),
        "{answered:?}"
    );
    (floor, pallets)
}

/// Mutant: drop `registry_touch::box_by_id` from `facts/box_closed.rs`.
#[tokio::test]
async fn a_box_closing_stamps_its_change_time() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    closed_boxes(&admin, &setup, 2).await;
    all_at(&changed(&admin).await, &admin.app.state.timestamp());
}

/// Mutant: drop `registry_touch::pallet_boxes` from `facts/pallet_closed.rs`.
#[tokio::test]
async fn a_production_pallet_closing_moves_its_boxes() {
    let admin = admin().await;
    let (floor, pallets) = boxes_on_a_standing_pallet(&admin).await;
    let before = admin.app.state.timestamp();
    all_at(&changed(&admin).await, &before);
    admin.app.clock.advance(Duration::seconds(40));
    let answered = receipts(
        &admin.app,
        &floor.key,
        &[fact(
            &record_id(50),
            "pallet_closed",
            &floor.shift,
            pallet_closed(
                &pallet_id(1),
                &pallets,
                40,
                2,
                &instant(10, 0),
                &instant(41, 0),
            ),
        )],
    )
    .await;
    assert_eq!(answered[0]["outcome"], json!("accepted"), "{answered:?}");
    let after = admin.app.state.timestamp();
    assert_ne!(before, after);
    all_at(&changed(&admin).await, &after);
}

/// Mutant: drop `registry_touch::pallet_boxes` from `facts/pallet_exception.rs`.
#[tokio::test]
async fn a_station_taking_a_pallet_apart_moves_its_boxes() {
    let admin = admin().await;
    let (floor, pallets) = boxes_on_a_standing_pallet(&admin).await;
    let closed = fact(
        &record_id(50),
        "pallet_closed",
        &floor.shift,
        pallet_closed(
            &pallet_id(1),
            &pallets,
            40,
            2,
            &instant(10, 0),
            &instant(41, 0),
        ),
    );
    assert_eq!(
        receipts(&admin.app, &floor.key, &[closed]).await[0]["outcome"],
        json!("accepted")
    );
    admin.app.clock.advance(Duration::seconds(40));
    let exception = fact(
        &record_id(51),
        "pallet_exception",
        &floor.shift,
        json!({
            "exception": "disassemble", "palletId": pallet_id(1), "reasonCode": "other",
            "reasonText": "Перепутали товар", "occurredAt": instant(60, 0)
        }),
    );
    let answered = receipts(&admin.app, &floor.key, &[exception]).await;
    assert_eq!(answered[0]["outcome"], json!("accepted"), "{answered:?}");
    all_at(&changed(&admin).await, &admin.app.state.timestamp());
}

/// Mutant: drop `registry_touch::box_by_id` from `disaggregation.rs` (the box branch).
#[tokio::test]
async fn an_office_disassembly_of_a_box_moves_that_box_only() {
    let admin = admin().await;
    pallet_day(&admin, true).await;
    let before = admin.app.state.timestamp();
    admin.app.clock.advance(Duration::seconds(90));
    applied(&admin, &[sscc(1500)]).await;
    let now = admin.app.state.timestamp();
    let rows = changed(&admin).await;
    assert_eq!(
        rows[0].1.as_deref(),
        Some(now.as_str()),
        "the box taken apart"
    );
    assert_eq!(
        rows[1].1.as_deref(),
        Some(before.as_str()),
        "the other box is untouched"
    );
}

/// Mutant: drop `registry_touch::pallet_boxes` from `disaggregation.rs` (the pallet branch).
#[tokio::test]
async fn an_office_disassembly_of_a_pallet_moves_its_boxes() {
    let admin = admin().await;
    pallet_day(&admin, true).await;
    admin.app.clock.advance(Duration::seconds(90));
    applied(&admin, &[pallet_sscc(40)]).await;
    all_at(&changed(&admin).await, &admin.app.state.timestamp());
}

/// Mutant: drop `registry_touch::box_by_sscc` from the `box_removed` handler of `pallet_events.rs`.
#[tokio::test]
async fn a_box_taken_off_a_warehouse_pallet_moves_only_that_box() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    closed_boxes(&admin, &setup, 2).await;
    let key = pair_handheld(&admin).await;
    pallet_block(&admin, &key, "8f7e6d5c-4b3a-4f2e-8d1c-9b8a7f6e5d4c").await;
    let pallet = "a1000000-0000-4000-8000-000000000001";
    receipts_of(
        &admin,
        &key,
        &[
            opened(1, pallet, product_of(&setup), &instant(100, 0)),
            added(2, pallet, &box_sscc(1500), &instant(101, 0)),
            added(3, pallet, &box_sscc(1501), &instant(102, 0)),
        ],
    )
    .await;
    let before = admin.app.state.timestamp();
    admin.app.clock.advance(Duration::seconds(30));
    let removed = event(
        4,
        "pallet_box_removed",
        json!({ "palletId": pallet, "boxSscc": box_sscc(1500), "removedAt": instant(110, 0) }),
    );
    let answered = receipts_of(&admin, &key, &[removed]).await;
    assert_eq!(answered[0]["outcome"], json!("accepted"), "{answered:?}");
    let rows: Vec<(String, Option<String>)> =
        sqlx::query_as("SELECT sscc, changed_at FROM boxes ORDER BY sscc")
            .fetch_all(&admin.app.state.pool)
            .await
            .unwrap();
    let now = admin.app.state.timestamp();
    assert_eq!(rows[0], (box_sscc(1500), Some(now)));
    assert_eq!(rows[1], (box_sscc(1501), Some(before)));
}
