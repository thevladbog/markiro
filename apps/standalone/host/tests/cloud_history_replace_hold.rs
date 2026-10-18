#[path = "support/history.rs"]
mod history;
mod support;

use axum::http::StatusCode;
use markiro_host::backup::Backups;
use serde_json::json;
use support::app::{admin, cloud_import_request, host_revision, IMPORT_ID};

#[tokio::test]
async fn canceling_replacement_history_requires_another_explicit_replacement() {
    let mut a = admin().await;
    let local = a.app.dir().join("backups");
    std::fs::create_dir_all(&local).unwrap();
    a.app.state = a.app.state.clone().with_backups(Backups::new(
        a.app.dir().to_path_buf(),
        local,
        a.app.dir().join("host.db"),
        a.app.state.host_id.clone(),
    ));
    let original = history::request();
    let mut replacement = cloud_import_request(IMPORT_ID, false);
    replacement["replacement"] =
        json!({ "expectedRevision": host_revision(&a.app).await, "history": original["manifest"] });
    let (status, result) = a
        .call("POST", "/v1/office/import", Some(replacement.clone()))
        .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    let (status, result) = a
        .call("POST", "/v1/office/import/history", Some(original.clone()))
        .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    let (status, result) = a
        .call(
            "POST",
            "/v1/office/import/history/cancel",
            Some(json!({ "batchId": original["manifest"]["checksum"] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{result}");

    let mut changed = original;
    changed["manifest"]["exportedAt"] = json!("2026-10-18T00:00:00.000Z");
    history::seal(&mut changed);
    let before = host_revision(&a.app).await;
    for dry_run in [true, false] {
        changed["dryRun"] = json!(dry_run);
        let (status, result) = a
            .call("POST", "/v1/office/import/history", Some(changed.clone()))
            .await;
        assert_eq!(status, StatusCode::CONFLICT, "{result}");
        assert_eq!(
            result["error"]["details"]["constraint"],
            "replacement_history_canceled"
        );
        assert_eq!(host_revision(&a.app).await, before);
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT replacement_pending FROM site WHERE id=1")
                .fetch_one(&a.app.state.pool)
                .await
                .unwrap(),
            1
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM cloud_history_batches")
                .fetch_one(&a.app.state.pool)
                .await
                .unwrap(),
            0
        );
    }

    replacement["importId"] = json!("10000000-0000-4000-8000-000000000099");
    replacement["replacement"] =
        json!({ "expectedRevision": before, "history": changed["manifest"] });
    let (status, result) = a.call("POST", "/v1/office/import", Some(replacement)).await;
    assert_eq!(status, StatusCode::OK, "{result}");
    changed["dryRun"] = json!(false);
    let (status, result) = a
        .call("POST", "/v1/office/import/history", Some(changed.clone()))
        .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    let (status, result) = a
        .call(
            "POST",
            "/v1/office/import/history/complete",
            Some(json!({ "batchId": changed["manifest"]["checksum"] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT replacement_pending FROM site WHERE id=1")
            .fetch_one(&a.app.state.pool)
            .await
            .unwrap(),
        0
    );
}
