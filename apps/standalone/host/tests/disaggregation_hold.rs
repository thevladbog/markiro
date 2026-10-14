//! An apply while the restore hold is on (plan ДЗГ-О, an owner decision taken
//! from the ДЗГ report): the host answers `conflict` `restore_hold` and takes
//! nothing apart. Everything else about a document works as before.

mod support;

use axum::http::StatusCode;
use serde_json::json;
use support::app::{admin, audit_trail, sscc};
use support::disaggregation::{add, apply, create, day, line, REASON};

const HELD_SINCE: &str = "2026-10-09T15:00:00Z";

async fn count(admin: &support::app::Admin, sql: &str) -> i64 {
    sqlx::query_scalar(sql)
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn an_apply_during_the_restore_hold_is_a_conflict_and_takes_nothing_apart() {
    let admin = admin().await;
    day(&admin, true).await;
    let doc = create(&admin, json!({ "reasonId": REASON })).await;
    let id = doc["document"]["id"].as_str().unwrap().to_owned();
    let (_, detail) = add(&admin, &id, json!([line(&sscc(1500), Some(&sscc(1500)))])).await;
    sqlx::query("UPDATE site SET facts_held_since = ? WHERE id = 1")
        .bind(HELD_SINCE)
        .execute(&admin.app.state.pool)
        .await
        .unwrap();

    let (status, body) = apply(&admin, &detail).await;

    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"]["code"], "conflict");
    assert_eq!(body["error"]["details"]["constraint"], "restore_hold");
    assert_eq!(body["error"]["details"]["since"], HELD_SINCE);
    assert_eq!(
        count(
            &admin,
            "SELECT COUNT(*) FROM boxes WHERE disassembled_at IS NOT NULL"
        )
        .await,
        0
    );
    assert_eq!(count(&admin, "SELECT COUNT(*) FROM code_releases").await, 0);
    assert_eq!(
        count(
            &admin,
            "SELECT COUNT(*) FROM disaggregation_documents WHERE status = 'applied'"
        )
        .await,
        0
    );
    assert!(audit_trail(&admin.app, "disaggregation.apply")
        .await
        .is_empty());

    // The draft is still there to read and to cancel while the hold lasts.
    let (status, card) = admin
        .call("GET", &format!("/v1/office/disaggregation/{id}"), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{card}");
    assert_eq!(card["document"]["status"], "draft");

    // Resumed: the same document, the same revision, applies.
    sqlx::query("UPDATE site SET facts_held_since = NULL WHERE id = 1")
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    let (status, done) = apply(&admin, &detail).await;
    assert_eq!(status, StatusCode::OK, "{done}");
    assert_eq!(done["document"]["status"], "applied");
}
