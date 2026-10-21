//! The office closes a shared shift whole (plan 2b, spec §4.2 «Принудительное закрытие»): every
//! part still open closes as the office's, the row names who had not closed, late data stays late;
//! and the office gives the reason a shift its devices closed without (§12.9).

mod support;

use axum::http::StatusCode;
use serde_json::json;
use support::app::{
    accepted, admin, audit_trail, box_id, close_from_office, fact, instant, ok_scan, receipts,
    record_id, shift_closed, shift_setup,
};
use support::multi::{leave, participant, shared};

#[tokio::test]
async fn the_office_closes_every_open_part_and_names_who_had_not_closed() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let (a, b, shift, _) = shared(&admin, &setup, None).await;
    let (status, _) = leave(&admin, &b, &shift).await;
    assert_eq!(status, StatusCode::OK);
    let closed = close_from_office(&admin, &shift, "Станция Б сломалась").await;
    assert_eq!(closed["status"], json!("closed"));
    assert_eq!(
        closed["participants"]
            .as_array()
            .unwrap()
            .iter()
            .map(|participant| (
                participant["state"].clone(),
                participant["closedBy"].clone()
            ))
            .collect::<Vec<_>>(),
        vec![
            (json!("closed"), json!("office_user")),
            (json!("closed"), json!("office_user"))
        ]
    );
    assert_eq!(
        audit_trail(&admin.app, "shift.force_closed").await,
        vec![admin.row(
            "shift.force_closed",
            "shift",
            &shift,
            json!({
                "reason": "Станция Б сломалась",
                "notClosed": [
                    { "deviceId": a.id, "state": "active" },
                    { "deviceId": b.id, "state": "left" }
                ]
            })
        )]
    );
    assert!(audit_trail(&admin.app, "shift.close").await.is_empty());
    // A's later scan is taken and late; its close is already closed.
    let late_at = admin.app.state.timestamp();
    assert_eq!(
        receipts(
            &admin.app,
            &a.key,
            &[
                fact(
                    &record_id(1),
                    "scan",
                    &shift,
                    ok_scan(1, &box_id(1), &instant(1, 0))
                ),
                fact(
                    &record_id(2),
                    "shift_closed",
                    &shift,
                    shift_closed(None, 1, 0, None, &instant(9, 0))
                )
            ]
        )
        .await,
        vec![
            accepted(&record_id(1)),
            json!({ "id": record_id(2), "outcome": "accepted", "details": { "alreadyClosed": true } })
        ]
    );
    assert_eq!(
        participant(&admin, &shift, &a.id).await,
        (
            "closed".to_owned(),
            None,
            Some("office_user".to_owned()),
            None,
            Some(late_at.clone())
        )
    );
    let shift_late: Option<String> =
        sqlx::query_scalar("SELECT late_data_at FROM shifts WHERE id = ?")
            .bind(&shift)
            .fetch_one(&admin.app.state.pool)
            .await
            .unwrap();
    assert_eq!(shift_late, Some(late_at));
}

#[tokio::test]
async fn the_office_gives_the_reason_a_shared_shift_closed_without() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let (a, b, shift, _) = shared(&admin, &setup, Some(5)).await;
    let close = |n: u32| {
        fact(
            &record_id(n),
            "shift_closed",
            &shift,
            shift_closed(Some(5), 0, 0, None, &instant(30, 0)),
        )
    };
    receipts(&admin.app, &a.key, &[close(1)]).await;
    receipts(&admin.app, &b.key, &[close(1)]).await;
    let path = format!("/v1/office/shifts/{shift}");
    let (_, current) = admin.call("GET", &path, None).await;
    assert_eq!(current["closeReasonMissing"], json!(true));
    let reason_path = format!("{path}/close-reason");
    let (status, refused) = admin
        .call(
            "PUT",
            &reason_path,
            Some(json!({ "reasonCode": "broken", "expectedRev": current["rev"] })),
        )
        .await;
    assert_eq!(
        (status, refused["error"]["details"]["field"].clone()),
        (StatusCode::BAD_REQUEST, json!("reasonCode"))
    );
    let (status, stale) = admin
        .call(
            "PUT",
            &reason_path,
            Some(json!({ "reasonCode": "equipment_stop", "expectedRev": 1 })),
        )
        .await;
    assert_eq!(
        (status, stale["error"]["code"].clone()),
        (StatusCode::CONFLICT, json!("stale_revision"))
    );
    let (status, set) = admin
        .call(
            "PUT",
            &reason_path,
            Some(json!({ "reasonCode": "equipment_stop", "expectedRev": current["rev"] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{set}");
    assert_eq!(
        (
            set["closeReasonCode"].clone(),
            set.get("closeReasonMissing").is_none()
        ),
        (json!("equipment_stop"), true)
    );
    assert_eq!(
        audit_trail(&admin.app, "shift.close_reason").await,
        vec![admin.row(
            "shift.close_reason",
            "shift",
            &shift,
            json!({ "reasonCode": "equipment_stop" })
        )]
    );
    let (status, again) = admin
        .call(
            "PUT",
            &reason_path,
            Some(json!({ "reasonCode": "equipment_stop", "expectedRev": set["rev"] })),
        )
        .await;
    assert_eq!(
        (status, again["error"]["details"]["constraint"].clone()),
        (StatusCode::CONFLICT, json!("close_reason_not_missing"))
    );
}

#[tokio::test]
async fn a_refused_or_repeated_forced_close_writes_nothing() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let (_, _, shift, _) = shared(&admin, &setup, None).await;
    let path = format!("/v1/office/shifts/{shift}");
    let (_, current) = admin.call("GET", &path, None).await;
    let revision = support::app::host_revision(&admin.app).await;
    let close = format!("{path}/close");
    // No reason, a blank one and a stale revision are refused before anything is written.
    for (body, code) in [
        (
            json!({ "reason": "", "expectedRev": current["rev"] }),
            "validation_failed",
        ),
        (
            json!({ "reason": "  ", "expectedRev": current["rev"] }),
            "validation_failed",
        ),
        (
            json!({ "reason": "Сбой", "expectedRev": 1 }),
            "stale_revision",
        ),
    ] {
        let (status, refused) = admin.call("POST", &close, Some(body)).await;
        assert_eq!(refused["error"]["code"], json!(code), "{refused}");
        assert!(status.is_client_error());
    }
    assert_eq!(support::app::host_revision(&admin.app).await, revision);
    assert!(audit_trail(&admin.app, "shift.force_closed")
        .await
        .is_empty());
    let closed = close_from_office(&admin, &shift, "Сбой").await;
    let revision = support::app::host_revision(&admin.app).await;
    let (status, again) = admin
        .call(
            "POST",
            &close,
            Some(json!({ "reason": "Ещё раз", "expectedRev": closed["rev"] })),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{again}");
    assert_eq!(support::app::host_revision(&admin.app).await, revision);
    assert_eq!(audit_trail(&admin.app, "shift.force_closed").await.len(), 1);
}
