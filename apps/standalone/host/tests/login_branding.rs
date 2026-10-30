//! Pre-login branding reveals only the licensed logo to a paired office/station.
mod support;

use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{admin, empty, pair_device, pair_handheld, request, with_device, Admin};
use support::license::{file, load_ok};

const PATH: &str = "/v1/device/login-branding";

async fn read(admin: &Admin, key: &str) -> (StatusCode, Value) {
    admin
        .app
        .send(empty(with_device(request("GET", PATH), key)))
        .await
}

#[tokio::test]
async fn paired_office_and_station_read_only_the_licensed_logo_without_a_session() {
    let admin = admin().await;
    let (_, office) = pair_device(&admin.app, "office").await;
    let (status, set) = admin
        .call(
            "PUT",
            "/v1/office/org/logo",
            Some(json!({
                "width": 10, "height": 2, "pixelsBase64": "8MAPQA=="
            })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    for key in [&admin.key, &office] {
        assert_eq!(read(&admin, key).await, (StatusCode::OK, set.clone()));
        for protected in [
            "/v1/office/org",
            "/v1/office/org/logo",
            "/v1/office/license",
            "/v1/office/users",
        ] {
            let (status, _) = admin
                .app
                .send(empty(with_device(request("GET", protected), key)))
                .await;
            assert_eq!(
                status,
                StatusCode::UNAUTHORIZED,
                "{protected} remains session protected"
            );
        }
    }
    load_ok(
        &admin,
        &file(&admin.app.state.host_id, |terms| {
            terms["features"]["customLogo"] = json!(false);
        }),
    )
    .await;
    assert_eq!(
        read(&admin, &office).await,
        (StatusCode::OK, json!({"logo": null}))
    );
}

#[tokio::test]
async fn missing_and_deleted_logos_fall_back_without_an_office_session() {
    let admin = admin().await;
    assert_eq!(
        read(&admin, &admin.key).await,
        (StatusCode::OK, json!({"logo": null}))
    );
    admin
        .call(
            "PUT",
            "/v1/office/org/logo",
            Some(json!({
                "width": 10, "height": 2, "pixelsBase64": "8MAPQA=="
            })),
        )
        .await;
    admin.call("DELETE", "/v1/office/org/logo", None).await;
    assert_eq!(
        read(&admin, &admin.key).await,
        (StatusCode::OK, json!({"logo": null}))
    );
}

#[tokio::test]
async fn unpaired_handheld_and_revoked_devices_cannot_read_login_branding() {
    let admin = admin().await;
    let (status, _) = admin.app.send(empty(request("GET", PATH))).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(
        read(&admin, "invalid-test-key").await.0,
        StatusCode::UNAUTHORIZED
    );
    let handheld = pair_handheld(&admin).await;
    assert_eq!(read(&admin, &handheld).await.0, StatusCode::FORBIDDEN);
    let (id, office) = pair_device(&admin.app, "office").await;
    let (status, revoked) = admin
        .call("POST", &format!("/v1/office/devices/{id}/revoke"), None)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert!(revoked["revokedAt"].as_str().is_some());
    assert_eq!(read(&admin, &office).await.0, StatusCode::UNAUTHORIZED);
}
