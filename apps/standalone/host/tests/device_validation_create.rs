//! A station creates a validation shift on its own (beta 3.2): `mode` and
//! `validationPrint` follow the office's rules, a station that names neither
//! still makes an aggregation shift that prints nothing.

mod support;

use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{
    admin, empty, json as json_request, office_template, request, shift_setup, with_device, Admin,
    ShiftSetup,
};

const REQUEST: &str = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";

async fn on_line(admin: &Admin, setup: &ShiftSetup) {
    let (status, body) = admin
        .app
        .send(json_request(
            with_device(request("PUT", "/v1/device/line"), &admin.key),
            json!({ "lineId": setup.line }),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
}

fn body(setup: &ShiftSetup, extra: Value) -> Value {
    let mut body = json!({
        "requestId": REQUEST,
        "productId": setup.product,
        "boxTemplateId": setup.template,
        "productionDate": "2026-10-09"
    });
    for (key, value) in extra.as_object().unwrap() {
        body[key] = value.clone();
    }
    body
}

async fn create(admin: &Admin, body: Value) -> (StatusCode, Value) {
    admin
        .app
        .send(json_request(
            with_device(request("POST", "/v1/device/shifts"), &admin.key),
            body,
        ))
        .await
}

fn field(response: &Value) -> Value {
    response["error"]["details"]["field"].clone()
}

#[tokio::test]
async fn a_station_creates_a_validation_shift_that_prints_a_duplicate() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    on_line(&admin, &setup).await;
    let duplicate = office_template(&admin, "product_duplicate", true, json!([8])).await;
    let policy =
        json!({ "mode": "duplicate_dm", "verification": "required", "templateId": duplicate });
    let (status, created) = create(
        &admin,
        body(
            &setup,
            json!({ "mode": "validation", "validationPrint": policy }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    assert_eq!(
        (
            created["mode"].clone(),
            created["validationPrint"].clone(),
            created["palletsEnabled"].clone(),
            created["createdFrom"].clone()
        ),
        (
            json!("validation"),
            policy.clone(),
            json!(false),
            json!("station")
        )
    );
    // The same request again is the same shift, whatever the body says now.
    let (status, again) = create(&admin, body(&setup, json!({}))).await;
    assert_eq!(
        (status, again["id"].clone()),
        (StatusCode::OK, created["id"].clone())
    );
    let (actor_kind, details): (String, String) =
        sqlx::query_as("SELECT actor_kind, details FROM audit_log WHERE action = 'shift.create'")
            .fetch_one(&admin.app.state.pool)
            .await
            .unwrap();
    let details: Value = serde_json::from_str(&details).unwrap();
    assert_eq!(actor_kind, "device");
    assert_eq!(details["mode"], "validation");
    assert_eq!(details["validationPrint"], policy);
}

#[tokio::test]
async fn a_station_that_names_no_mode_creates_an_aggregation_shift() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    on_line(&admin, &setup).await;
    let (status, created) = create(&admin, body(&setup, json!({}))).await;
    assert_eq!(status, StatusCode::OK, "{created}");
    assert_eq!(created["mode"], "aggregation");
    assert!(created.get("validationPrint").is_none_or(Value::is_null));
}

#[tokio::test]
async fn a_station_create_follows_the_modes_rules() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    on_line(&admin, &setup).await;
    let duplicate = office_template(&admin, "product_duplicate", true, json!([8])).await;
    let other_group = office_template(&admin, "product_duplicate", true, json!([5])).await;
    let policy =
        |id: &str| json!({ "mode": "duplicate_dm", "verification": "none", "templateId": id });
    // An aggregation shift prints no duplicate.
    let (status, refused) = create(
        &admin,
        body(&setup, json!({ "validationPrint": policy(&duplicate) })),
    )
    .await;
    assert_eq!(
        (status, field(&refused)),
        (StatusCode::BAD_REQUEST, json!("validationPrint"))
    );
    // A validation shift has no pallets.
    let (status, refused) = create(
        &admin,
        body(
            &setup,
            json!({ "mode": "validation", "palletsEnabled": true }),
        ),
    )
    .await;
    assert_eq!(
        (status, field(&refused)),
        (StatusCode::BAD_REQUEST, json!("palletsEnabled"))
    );
    // The duplicate template must fit the product.
    let (status, refused) = create(
        &admin,
        body(
            &setup,
            json!({ "mode": "validation", "validationPrint": policy(&other_group) }),
        ),
    )
    .await;
    assert_eq!(
        (status, field(&refused)),
        (StatusCode::BAD_REQUEST, json!("validationPrint.templateId"))
    );
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM shifts")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    let _ = empty;
}
