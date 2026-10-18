mod support;
use axum::extract::FromRequestParts;
use axum::http::StatusCode;
use markiro_host::auth::AuthDevice;
use serde_json::json;
use support::app::{admin, json as body, request, with_device, with_session};

const EPOCH: &str = "d0000000-0000-4000-8000-000000000001";

#[tokio::test]
async fn stale_and_missing_epochs_cannot_write_but_reads_and_current_epoch_work() {
    let a = admin().await;
    sqlx::query("UPDATE site SET dataset_epoch=? WHERE id=1")
        .bind(EPOCH)
        .execute(&a.app.state.pool)
        .await
        .unwrap();
    let (status, value) = a
        .call("POST", "/v1/office/lines", Some(json!({"name":"Stale"})))
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{value}");
    assert_eq!(value["error"]["details"]["constraint"], "dataset_changed");
    assert_eq!(
        a.call("GET", "/v1/office/lines", None).await.0,
        StatusCode::OK
    );
    let builder = with_session(request("POST", "/v1/office/lines"), &a.key, &a.token)
        .header("x-markiro-dataset-epoch", EPOCH);
    let (status, value) = a.app.send(body(builder, json!({"name":"Fresh"}))).await;
    assert!(status.is_success(), "{value}");
    let builder = with_device(request("POST", "/v1/device/facts"), &a.key).header(
        "x-markiro-dataset-epoch",
        "d0000000-0000-4000-8000-000000000002",
    );
    let (status, value) = a.app.send(body(builder, json!({}))).await;
    assert_eq!(status, StatusCode::CONFLICT, "{value}");
    assert_eq!(value["error"]["details"]["constraint"], "dataset_changed");
}

#[tokio::test]
async fn a_request_authenticated_before_replacement_is_fenced_inside_its_transaction() {
    let a = admin().await;
    let r = with_device(request("POST", "/v1/device/facts"), &a.key)
        .body(())
        .unwrap();
    let (mut parts, _) = r.into_parts();
    let device = AuthDevice::from_request_parts(&mut parts, &a.app.state)
        .await
        .unwrap();
    sqlx::query("UPDATE site SET dataset_epoch=? WHERE id=1")
        .bind(EPOCH)
        .execute(&a.app.state.pool)
        .await
        .unwrap();
    let mut tx = markiro_host::db::begin_write(&a.app.state.pool)
        .await
        .unwrap();
    assert!(device.require_live_in(&mut tx).await.is_err());
}
