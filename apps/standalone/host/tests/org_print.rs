//! What a device prints about the organization outside a shift (plan ТСД-Х, task Х5): its name,
//! INN, SSCC issuer prefix and, when the license has `customLogo`, its print logo.

mod support;

use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{admin, empty, pair_device, pair_handheld, request, with_device, Admin};
use support::license::{file, load_ok};

async fn org_print(admin: &Admin, key: &str) -> (StatusCode, Value) {
    admin
        .app
        .send(empty(with_device(
            request("GET", "/v1/device/org/print"),
            key,
        )))
        .await
}

#[tokio::test]
async fn a_handheld_and_a_station_read_the_organization_to_print() {
    let admin = admin().await;
    let handheld = pair_handheld(&admin).await;
    let expected = json!({
        "name": "ООО «Атолл»", "inn": "7707083893", "issuerPrefix": "460068200", "logo": null
    });
    for key in [&handheld, &admin.key] {
        let (status, body) = org_print(&admin, key).await;
        assert_eq!((status, body), (StatusCode::OK, expected.clone()));
    }
    let (_, office) = pair_device(&admin.app, "office").await;
    let (status, refused) = org_print(&admin, &office).await;
    assert_eq!(
        (status, refused["error"]["code"].clone()),
        (StatusCode::FORBIDDEN, json!("forbidden"))
    );
}

#[tokio::test]
async fn the_logo_comes_with_the_feature_and_never_without_it() {
    let admin = admin().await;
    let handheld = pair_handheld(&admin).await;
    let logo = json!({ "width": 10, "height": 2, "pixelsBase64": "8MAPQA==" });
    let (status, set) = admin
        .call("PUT", "/v1/office/org/logo", Some(logo.clone()))
        .await;
    assert_eq!(status, StatusCode::OK, "{set}");
    let (_, body) = org_print(&admin, &handheld).await;
    assert_eq!(body["logo"], logo);
    load_ok(
        &admin,
        &file(&admin.app.state.host_id, |terms| {
            terms["features"]["customLogo"] = json!(false)
        }),
    )
    .await;
    let (_, body) = org_print(&admin, &handheld).await;
    assert_eq!(
        body["logo"],
        Value::Null,
        "the bundled Markiro logo prints without the feature"
    );
    assert_eq!(body["name"], json!("ООО «Атолл»"));
}
