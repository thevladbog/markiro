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
