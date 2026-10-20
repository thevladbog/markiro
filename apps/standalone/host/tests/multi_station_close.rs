//! Each participant closes its own part (plan 2b, spec §4.2 «Закрытие своей части», «План и
//! причина», §12.9): the shift closes with its last part; only a shared shift's last close may need
//! a reason, judged by the whole shift against the host's plan, and a close without it still closes
//! the shift, marked for the office; a closed part's later facts are late.

mod support;

use serde_json::json;
use support::app::{
    accepted, admin, audit_trail, box_id, fact, host_revision, instant, ok_scan, receipts,
    record_id, shift_closed, shift_setup,
};
use support::multi::{enter, leave, participant, shared, status_of, MULTI};

fn device_row(
    device: &str,
    action: &str,
    shift: &str,
    details: serde_json::Value,
) -> support::app::AuditRow {
    (
        "device".to_owned(),
        Some(device.to_owned()),
        action.to_owned(),
        Some("shift".to_owned()),
        Some(shift.to_owned()),
        "ok".to_owned(),
        details,
    )
}

#[tokio::test]
async fn the_first_closer_closes_its_part_and_the_last_one_closes_the_shift() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let (a, b, shift, number) = shared(&admin, &setup, Some(10)).await;
    assert_eq!(
        receipts(
            &admin.app,
            &a.key,
            &[fact(
                &record_id(1),
                "scan",
                &shift,
                ok_scan(1, &box_id(1), &instant(1, 0))
            )]
        )
        .await,
        vec![accepted(&record_id(1))]
    );
    let revision = host_revision(&admin.app).await;
    // A closes its part without a reason although its 1 is not the plan of 10: nobody refuses it.
    let close_a = fact(
        &record_id(2),
        "shift_closed",
        &shift,
        shift_closed(Some(10), 1, 0, None, &instant(60, 0)),
    );
    assert_eq!(
        receipts(&admin.app, &a.key, &[close_a]).await,
        vec![
            json!({ "id": record_id(2), "outcome": "accepted", "details": { "partClosed": true } })
        ]
    );
    assert_eq!(host_revision(&admin.app).await, revision + 1);
    assert_eq!(status_of(&admin, &shift).await, "active");
    assert_eq!(
        participant(&admin, &shift, &a.id).await,
        (
            "closed".to_owned(),
            None,
            Some("device".to_owned()),
            Some(1),
            None
        )
    );
    assert_eq!(
        audit_trail(&admin.app, "shift.part_closed").await,
        vec![device_row(
            &a.id,
            "shift.part_closed",
            &shift,
            json!({ "number": number, "actualQty": 1, "closedBoxCount": 0, "reasonCode": null })
        )]
    );
    assert!(audit_trail(&admin.app, "shift.close").await.is_empty());
    // B closes last without a reason; the whole shift's 1 misses the plan of 10.
    let close_b = fact(
        &record_id(1),
        "shift_closed",
        &shift,
        shift_closed(Some(10), 0, 0, None, &instant(120, 0)),
    );
    assert_eq!(
        receipts(&admin.app, &b.key, &[close_b]).await,
        vec![
            json!({ "id": record_id(1), "outcome": "accepted", "details": { "reasonMissing": true } })
        ]
    );
    let row: (String, String, String, String, Option<String>, bool) = sqlx::query_as(
        "SELECT status, closed_at, closed_by_kind, closed_by, close_reason_code, \
         close_reason_missing FROM shifts WHERE id = ?",
    )
    .bind(&shift)
    .fetch_one(&admin.app.state.pool)
    .await
    .unwrap();
    assert_eq!(
        row,
        (
            "closed".to_owned(),
            "2026-10-08T06:02:00Z".to_owned(),
            "device".to_owned(),
            b.id.clone(),
            None,
            true
        )
    );
    assert_eq!(
        audit_trail(&admin.app, "shift.close").await,
        vec![device_row(
            &b.id,
            "shift.close",
            &shift,
            json!({
                "actualQty": 0, "plannedQty": 10, "closedBoxCount": 0, "reasonCode": null,
                "participants": 2, "acceptedTotal": 1, "reasonMissing": true
            })
        )]
    );
    assert_eq!(audit_trail(&admin.app, "shift.part_closed").await.len(), 1);
}

#[tokio::test]
async fn the_last_closer_needs_no_reason_when_the_whole_shift_meets_the_plan() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let (a, b, shift, _) = shared(&admin, &setup, Some(2)).await;
    let scan = |n: u32, box_n: u32| {
        fact(
            &record_id(n),
            "scan",
            &shift,
            ok_scan(n, &box_id(box_n), &instant(n, 0)),
        )
    };
    assert_eq!(
        receipts(&admin.app, &a.key, &[scan(1, 1)]).await,
        vec![accepted(&record_id(1))]
    );
    assert_eq!(
        receipts(&admin.app, &b.key, &[scan(2, 2)]).await,
        vec![accepted(&record_id(2))]
    );
    let close = |n: u32| {
        fact(
            &record_id(n),
            "shift_closed",
            &shift,
            shift_closed(Some(2), 1, 0, None, &instant(90, 0)),
        )
    };
    assert_eq!(
        receipts(&admin.app, &a.key, &[close(3)]).await,
        vec![
            json!({ "id": record_id(3), "outcome": "accepted", "details": { "partClosed": true } })
        ]
    );
    assert_eq!(
        receipts(&admin.app, &b.key, &[close(3)]).await,
        vec![accepted(&record_id(3))]
    );
    let missing: bool = sqlx::query_scalar("SELECT close_reason_missing FROM shifts WHERE id = ?")
        .bind(&shift)
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    assert_eq!(
        (status_of(&admin, &shift).await.as_str(), missing),
        ("closed", false)
    );
}

#[tokio::test]
async fn a_participant_that_left_keeps_the_shift_open_until_it_closes_too() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let (a, b, shift, _) = shared(&admin, &setup, None).await;
    let (status, _) = leave(&admin, &b, &shift).await;
    assert_eq!(status, axum::http::StatusCode::OK);
    let close = |n: u32| {
        fact(
            &record_id(n),
            "shift_closed",
            &shift,
            shift_closed(None, 0, 0, None, &instant(30, 0)),
        )
    };
    assert_eq!(
        receipts(&admin.app, &a.key, &[close(1)]).await,
        vec![
            json!({ "id": record_id(1), "outcome": "accepted", "details": { "partClosed": true } })
        ]
    );
    assert_eq!(status_of(&admin, &shift).await, "active");
    assert_eq!(
        receipts(&admin.app, &b.key, &[close(1)]).await,
        vec![accepted(&record_id(1))]
    );
    assert_eq!(status_of(&admin, &shift).await, "closed");
    assert_eq!(
        participant(&admin, &shift, &b.id).await,
        (
            "closed".to_owned(),
            None,
            Some("device".to_owned()),
            Some(0),
            None
        )
    );
}

#[tokio::test]
async fn a_closed_part_reads_the_shift_back_takes_late_facts_and_closes_only_once() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let (a, _b, shift, _) = shared(&admin, &setup, None).await;
    let close = |n: u32| {
        fact(
            &record_id(n),
            "shift_closed",
            &shift,
            shift_closed(None, 0, 0, None, &instant(30, 0)),
        )
    };
    receipts(&admin.app, &a.key, &[close(1)]).await;
    let revision = host_revision(&admin.app).await;
    // Its entry reads the shift back: nothing is written.
    let (status, back) = enter(&admin, &a, &shift, &[MULTI]).await;
    assert_eq!(
        (
            status,
            back["myState"].clone(),
            back["snapshot"].is_object()
        ),
        (axum::http::StatusCode::OK, json!("closed"), true)
    );
    assert_eq!(host_revision(&admin.app).await, revision);
    // A later scan is taken and marks the part late once; the shift is not late.
    admin.app.clock.advance(time::Duration::minutes(3));
    let late_at = admin.app.state.timestamp();
    assert_eq!(
        receipts(
            &admin.app,
            &a.key,
            &[fact(
                &record_id(2),
                "scan",
                &shift,
                ok_scan(5, &box_id(5), &instant(40, 0))
            )]
        )
        .await,
        vec![accepted(&record_id(2))]
    );
    assert_eq!(host_revision(&admin.app).await, revision + 1);
    assert_eq!(
        participant(&admin, &shift, &a.id).await,
        (
            "closed".to_owned(),
            None,
            Some("device".to_owned()),
            Some(0),
            Some(late_at)
        )
    );
    let shift_late: Option<String> =
        sqlx::query_scalar("SELECT late_data_at FROM shifts WHERE id = ?")
            .bind(&shift)
            .fetch_one(&admin.app.state.pool)
            .await
            .unwrap();
    assert_eq!(shift_late, None);
    // A second close of the closed part changes nothing and is kept as already closed.
    assert_eq!(
        receipts(&admin.app, &a.key, &[close(3)]).await,
        vec![
            json!({ "id": record_id(3), "outcome": "accepted", "details": { "partClosed": true } })
        ]
    );
    assert_eq!(host_revision(&admin.app).await, revision + 1);
    let outcomes: Vec<String> = sqlx::query_scalar(
        "SELECT outcome FROM shift_close_events WHERE shift_id = ? AND device_id = ? \
         ORDER BY received_at, record_id",
    )
    .bind(&shift)
    .bind(&a.id)
    .fetch_all(&admin.app.state.pool)
    .await
    .unwrap();
    assert_eq!(outcomes, ["accepted", "already_closed"]);
}
