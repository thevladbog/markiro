//! Demo data (spec 2026-10-21-standalone-wizard-demo-data-design): the wizard's set, its
//! rules, its isolation and its removal.

mod support;

use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{
    audit_trail, bootstrap_body, demo_admin, demo_bootstrap_body, host_revision,
    json as json_request, pair_device, request, with_device, TestApp,
};

const DEMO_GTIN: &str = "02900000000018";
const DEMO_PREFIX: &str = "290000000";

async fn wizard(app: &TestApp, body: Value) -> (StatusCode, Value) {
    let (_, key) = pair_device(app, "station").await;
    app.send(json_request(
        with_device(request("POST", "/v1/bootstrap"), &key),
        body,
    ))
    .await
}

async fn count(app: &TestApp, sql: &str) -> i64 {
    sqlx::query_scalar(sql)
        .fetch_one(&app.state.pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn the_wizard_installs_the_demo_set_in_its_own_revision() {
    let admin = demo_admin().await;
    let app = &admin.app;
    let rev = host_revision(app).await;
    assert_eq!(rev, 1);

    let product: (String, String, String, i64, i64, i64, i64, i64, i64, i64) = sqlx::query_as(
        "SELECT id, gtin14, name, chz_group_code, box_capacity, pallet_box_capacity, \
         shelf_life_days, demo, archived, rev FROM products",
    )
    .fetch_one(&app.state.pool)
    .await
    .unwrap();
    assert_eq!(
        (
            &product.1[..],
            &product.2[..],
            product.3,
            product.4,
            product.5,
            product.6
        ),
        (DEMO_GTIN, "Демо: вода питьевая 0,5 л", 13, 5, 2, 365)
    );
    assert_eq!((product.7, product.8, product.9), (1, 0, 1));

    let photo: (i64, i64, String, i64) = sqlx::query_as(
        "SELECT width, height, media_type, length(data) FROM product_photos WHERE product_id = ?",
    )
    .bind(&product.0)
    .fetch_one(&app.state.pool)
    .await
    .unwrap();
    assert_eq!((photo.0, photo.1, &photo.2[..]), (480, 480, "image/png"));
    assert!(photo.3 > 0 && photo.3 <= 300_000);
    assert_eq!(
        count(app, "SELECT photo_rev FROM products").await,
        1,
        "the station fetches the photo"
    );

    let counters: Vec<(String, i64, i64, i64)> = sqlx::query_as(
        "SELECT issuer_prefix, extension, next_serial, rev FROM sscc_counters \
         WHERE issuer_prefix = ? ORDER BY extension",
    )
    .bind(DEMO_PREFIX)
    .fetch_all(&app.state.pool)
    .await
    .unwrap();
    assert_eq!(
        counters,
        vec![(DEMO_PREFIX.into(), 0, 1, 1), (DEMO_PREFIX.into(), 1, 0, 1)]
    );

    let first_line: String = sqlx::query_scalar("SELECT id FROM lines WHERE name = 'Линия 1'")
        .fetch_one(&app.state.pool)
        .await
        .unwrap();
    let (status, shifts) = admin.call("GET", "/v1/office/shifts", None).await;
    assert_eq!(status, StatusCode::OK, "{shifts}");
    let shifts = shifts.as_array().unwrap();
    assert_eq!(shifts.len(), 1, "{shifts:?}");
    let shift = &shifts[0];
    assert_eq!(shift["number"], "DEMO-001");
    assert_eq!(shift["status"], "planned");
    assert_eq!(shift["mode"], "aggregation");
    assert_eq!(shift["productId"], json!(product.0));
    assert_eq!(shift["lineId"], json!(first_line));
    assert_eq!(shift["productionDate"], "2026-10-21");
    assert_eq!(shift["plannedQty"], 20);
    assert_eq!(shift["boxCapacity"], 5);
    assert_eq!(shift["palletsEnabled"], true);
    assert_eq!(shift["palletBoxCapacity"], 2);
    assert_eq!(shift["rev"], 1);
    // The demo shift draws no number of the organization's months.
    assert_eq!(
        count(
            app,
            "SELECT COUNT(*) FROM shift_number_counters WHERE month_key <> 'DEMO'"
        )
        .await,
        0
    );

    let trail = audit_trail(app, "host.bootstrap").await;
    assert_eq!(trail.len(), 1);
    assert_eq!(
        trail[0].6["demoData"],
        json!({ "productionDate": "2026-10-21" })
    );
}

#[tokio::test]
async fn the_trial_starts_with_the_wizard_with_or_without_the_demo_data() {
    for body in [bootstrap_body(), demo_bootstrap_body()] {
        let app = TestApp::new().await;
        let (status, response) = wizard(&app, body).await;
        assert_eq!(status, StatusCode::OK, "{response}");
        let started: Option<i64> =
            sqlx::query_scalar("SELECT trial_started_at FROM license_clock WHERE id = 1")
                .fetch_one(&app.state.pool)
                .await
                .unwrap();
        assert!(started.is_some());
    }
}

#[tokio::test]
async fn a_wizard_without_the_flag_installs_no_demo() {
    let app = TestApp::new().await;
    let (status, response) = wizard(&app, bootstrap_body()).await;
    assert_eq!(status, StatusCode::OK, "{response}");
    for table in [
        "products",
        "shifts",
        "product_photos",
        "shift_number_counters",
    ] {
        assert_eq!(
            count(&app, &format!("SELECT COUNT(*) FROM {table}")).await,
            0,
            "{table}"
        );
    }
    assert_eq!(
        count(
            &app,
            "SELECT COUNT(*) FROM sscc_counters WHERE issuer_prefix = '290000000'"
        )
        .await,
        0
    );
    assert!(audit_trail(&app, "host.bootstrap").await[0]
        .6
        .get("demoData")
        .is_none());
}

#[tokio::test]
async fn the_demo_set_needs_its_templates_a_date_and_another_prefix_and_a_refusal_creates_nothing()
{
    let without_templates = {
        let mut body = bootstrap_body();
        body["demoData"] = json!({ "productionDate": "2026-10-21" });
        body
    };
    let bad_date = {
        let mut body = demo_bootstrap_body();
        body["demoData"] = json!({ "productionDate": "2026-02-30" });
        body
    };
    let demo_gln = {
        let mut body = demo_bootstrap_body();
        body["org"]["gln"] = json!("2900000000018");
        body
    };
    for (body, field) in [
        (without_templates, "demoData"),
        (bad_date, "demoData.productionDate"),
        (demo_gln, "demoData"),
    ] {
        let app = TestApp::new().await;
        let (status, response) = wizard(&app, body).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{response}");
        assert_eq!(response["error"]["details"]["field"], field, "{response}");
        assert_eq!(count(&app, "SELECT COUNT(*) FROM office_users").await, 0);
    }
}

/// The demo product, the demo shift and the wizard's first line and stock templates.
struct DemoSet {
    product: String,
    shift: Value,
    line: String,
    box_template: String,
    pallet_template: String,
}

async fn demo_set(admin: &support::app::Admin) -> DemoSet {
    let pool = &admin.app.state.pool;
    let product: String = sqlx::query_scalar("SELECT id FROM products WHERE demo = 1")
        .fetch_one(pool)
        .await
        .unwrap();
    let line: String = sqlx::query_scalar("SELECT id FROM lines WHERE name = 'Линия 1'")
        .fetch_one(pool)
        .await
        .unwrap();
    let template = |purpose: &'static str| async move {
        sqlx::query_scalar::<_, String>("SELECT id FROM label_templates WHERE purpose = ?")
            .bind(purpose)
            .fetch_one(pool)
            .await
            .unwrap()
    };
    let (status, shifts) = admin.call("GET", "/v1/office/shifts", None).await;
    assert_eq!(status, StatusCode::OK, "{shifts}");
    DemoSet {
        product,
        shift: shifts[0].clone(),
        line,
        box_template: template("box").await,
        pallet_template: template("pallet").await,
    }
}

/// A device request with `key`.
async fn device_call(
    admin: &support::app::Admin,
    key: &str,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let builder = with_device(request(method, path), key);
    match body {
        Some(body) => admin.app.send(json_request(builder, body)).await,
        None => admin.app.send(support::app::empty(builder)).await,
    }
}

fn demo_photo_base64() -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(include_bytes!("../assets/demo-product.png"))
}

fn constraint(body: &Value) -> &Value {
    &body["error"]["details"]["constraint"]
}

#[tokio::test]
async fn the_demo_product_is_read_only() {
    let admin = demo_admin().await;
    let set = demo_set(&admin).await;
    let path = format!("/v1/office/products/{}", set.product);
    let (status, body) = admin
        .call(
            "PUT",
            &path,
            Some(json!({
                "gtin14": "04600682000013", "name": "Молоко", "printName": null,
                "chzProductGroupCode": 13, "boxCapacity": 5, "palletBoxCapacity": 2,
                "shelfLifeDays": 365, "defaultBoxTemplateId": null,
                "defaultPalletTemplateId": null, "archived": false, "expectedRev": 1
            })),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(constraint(&body), "demo_product");
    let (status, body) = admin
        .call(
            "PUT",
            &format!("{path}/photo"),
            Some(json!({ "width": 480, "height": 480, "dataBase64": demo_photo_base64() })),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(constraint(&body), "demo_product");
    let (status, body) = admin.call("DELETE", &format!("{path}/photo"), None).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(constraint(&body), "demo_product");
    assert_eq!(
        count(&admin.app, "SELECT COUNT(*) FROM product_photos").await,
        1
    );
    assert_eq!(audit_trail(&admin.app, "product.update").await.len(), 0);

    // The office and the feed see the flag.
    let (status, products) = admin.call("GET", "/v1/office/products", None).await;
    assert_eq!(status, StatusCode::OK, "{products}");
    assert_eq!(products[0]["demo"], true);
    let feed = admin.feed(0).await;
    let record = feed
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["entity"] == "products")
        .expect("the demo product rides the feed");
    assert_eq!(record["data"]["demo"], true);
    assert_eq!(record["data"]["gtin14"], DEMO_GTIN);
}

#[tokio::test]
async fn a_new_shift_of_the_demo_product_is_a_demo_shift_with_a_demo_number() {
    let admin = demo_admin().await;
    let set = demo_set(&admin).await;
    let (status, planned) = admin
        .call(
            "POST",
            "/v1/office/shifts",
            Some(json!({
                "productId": set.product, "lineId": set.line, "productionDate": "2026-11-02",
                "boxTemplateId": set.box_template, "mode": "aggregation",
                "palletsEnabled": true, "palletTemplateId": set.pallet_template
            })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{planned}");
    assert_eq!(planned["number"], "DEMO-002");

    let (status, line) = device_call(
        &admin,
        &admin.key,
        "PUT",
        "/v1/device/line",
        Some(json!({ "lineId": set.line })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{line}");
    let (status, created) = device_call(
        &admin,
        &admin.key,
        "POST",
        "/v1/device/shifts",
        Some(json!({
            "requestId": "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
            "productId": set.product,
            "boxTemplateId": set.box_template,
            "productionDate": "2026-11-03"
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    assert_eq!(created["number"], "DEMO-003/S");
    assert_eq!(
        count(
            &admin.app,
            "SELECT COUNT(*) FROM shift_number_counters WHERE month_key <> 'DEMO'"
        )
        .await,
        0
    );
}

#[tokio::test]
async fn a_demo_shift_takes_its_ssccs_from_the_demo_prefix_which_the_office_does_not_list() {
    let admin = demo_admin().await;
    let set = demo_set(&admin).await;
    let (status, line) = device_call(
        &admin,
        &admin.key,
        "PUT",
        "/v1/device/line",
        Some(json!({ "lineId": set.line })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{line}");
    let path = format!(
        "/v1/device/shifts/{}/enter",
        set.shift["id"].as_str().unwrap()
    );
    let (status, entered) = device_call(&admin, &admin.key, "POST", &path, None).await;
    assert_eq!(status, StatusCode::OK, "{entered}");
    assert_eq!(entered["snapshot"]["issuerPrefix"], DEMO_PREFIX);
    let (status, block) = device_call(
        &admin,
        &admin.key,
        "POST",
        "/v1/device/sscc/blocks",
        Some(json!({
            "requestId": "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a",
            "issuerPrefix": DEMO_PREFIX,
            "extension": 0
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{block}");
    assert_eq!(block["fromSerial"], 1);

    let (status, sscc) = admin.call("GET", "/v1/office/sscc", None).await;
    assert_eq!(status, StatusCode::OK, "{sscc}");
    assert!(
        sscc["counters"]
            .as_array()
            .unwrap()
            .iter()
            .all(|counter| counter["issuerPrefix"] != DEMO_PREFIX),
        "{sscc}"
    );
    let (status, body) = admin
        .call(
            "PUT",
            &format!("/v1/office/sscc/counters/{DEMO_PREFIX}/0"),
            Some(json!({ "nextSerial": 5000, "expectedRev": 2 })),
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
}

#[tokio::test]
async fn the_organization_takes_no_gln_of_the_demo_prefix_while_the_demo_data_is_there() {
    let admin = demo_admin().await;
    let (status, body) = admin
        .call(
            "PUT",
            "/v1/office/org",
            Some(json!({
                "name": "ООО «Атолл»", "inn": "7707083893", "gln": "2900000000018",
                "gs1Prefixes": ["4600682"], "timeZone": "Europe/Moscow", "expectedRev": 1
            })),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(body["error"]["details"]["field"], "gln");
}
