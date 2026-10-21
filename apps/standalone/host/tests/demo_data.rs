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
    assert_eq!(shift["productionDate"], "2026-09-21");
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
        json!({ "productionDate": "2026-09-21" })
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

/// A demo shift worked on its station: 10 demo codes in two boxes of 5 on one pallet; `close`
/// closes the shift from the station.
struct DemoRun {
    shift: String,
    boxes: Vec<String>,
    pallet: String,
}

fn demo_code(n: u32) -> Value {
    json!({
        "codeHash": format!("{:064x}", 0xd0000 + n),
        "gtin14": DEMO_GTIN,
        "serial": format!("DEMO{n:09}"),
        "canonical": format!("01{DEMO_GTIN}21DEMO{n:09}\u{1d}91DEMO\u{1d}92Tail{n}")
    })
}

fn demo_digest(members: std::ops::RangeInclusive<u32>) -> String {
    let hashes: Vec<String> = members.map(|n| format!("{:064x}", 0xd0000 + n)).collect();
    markiro_host::facts::rules::box_membership_digest(&hashes)
}

async fn run_demo_shift(admin: &support::app::Admin, close: bool) -> DemoRun {
    use support::app::{box_id, fact, instant, pallet_id, receipts, record_id, sscc_of};
    let set = demo_set(admin).await;
    let shift = set.shift["id"].as_str().unwrap().to_owned();
    let (status, line) = device_call(
        admin,
        &admin.key,
        "PUT",
        "/v1/device/line",
        Some(json!({ "lineId": set.line })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{line}");
    let (status, entered) = device_call(
        admin,
        &admin.key,
        "POST",
        &format!("/v1/device/shifts/{shift}/enter"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{entered}");
    let block = |extension: u8, request: &'static str| {
        let body =
            json!({ "requestId": request, "issuerPrefix": DEMO_PREFIX, "extension": extension });
        async move {
            let (status, block) = device_call(
                admin,
                &admin.key,
                "POST",
                "/v1/device/sscc/blocks",
                Some(body),
            )
            .await;
            assert_eq!(status, StatusCode::OK, "{block}");
            block
        }
    };
    let boxes_block = block(0, "7e6d5c4b-3a2f-4e1d-9c8b-7a6f5e4d3c2b").await;
    let pallets_block = block(1, "8f7e6d5c-4b3a-4f2e-8d1c-9b8a7f6e5d4c").await;
    let pallet = pallet_id(1);
    let mut records = Vec::new();
    let mut n = 0;
    for b in 1..=2_u32 {
        for code in (b - 1) * 5 + 1..=b * 5 {
            n += 1;
            records.push(fact(
                &record_id(n),
                "scan",
                &shift,
                json!({
                    "scannedAt": instant(code, 0), "verdict": "ok", "duplicateSource": null,
                    "rawKind": "km", "rawLength": 40, "code": demo_code(code), "boxId": box_id(b)
                }),
            ));
        }
        n += 1;
        records.push(fact(
            &record_id(n),
            "box_closed",
            &shift,
            json!({
                "boxId": box_id(b), "sscc": sscc_of(0, DEMO_PREFIX, u64::from(b)),
                "blockId": boxes_block["id"], "serial": b,
                "openedAt": instant((b - 1) * 5 + 1, 0), "closedAt": instant(b * 5, 500),
                "itemCount": 5, "membershipDigest": demo_digest((b - 1) * 5 + 1..=b * 5),
                "palletId": pallet
            }),
        ));
    }
    n += 1;
    records.push(fact(
        &record_id(n),
        "pallet_closed",
        &shift,
        json!({
            "palletId": pallet, "sscc": sscc_of(1, DEMO_PREFIX, 0), "blockId": pallets_block["id"],
            "serial": 0, "openedAt": instant(1, 0), "closedAt": instant(10, 600), "boxCount": 2
        }),
    ));
    if close {
        n += 1;
        records.push(fact(
            &record_id(n),
            "shift_closed",
            &shift,
            json!({
                "plannedQtySnapshot": 20, "actualQty": 10, "closedBoxCount": 2,
                "reasonCode": "other_production_deviation", "closedAt": instant(20, 0)
            }),
        ));
    }
    let answers = receipts(&admin.app, &admin.key, &records).await;
    assert!(
        answers
            .iter()
            .all(|receipt| receipt["outcome"] == "accepted"),
        "{answers:?}"
    );
    DemoRun {
        shift,
        boxes: vec![sscc_of(0, DEMO_PREFIX, 1), sscc_of(0, DEMO_PREFIX, 2)],
        pallet: sscc_of(1, DEMO_PREFIX, 0),
    }
}

#[tokio::test]
async fn a_demo_shift_goes_into_no_document_for_gismt_but_its_csv_may_be_saved() {
    let admin = demo_admin().await;
    let run = run_demo_shift(&admin, true).await;
    let record = |format: &str, version: u32| {
        json!({
            "formatId": format, "formatVersion": version, "maxLines": null, "palletId": null,
            "documentId": "4f3e2d1c-0b9a-4876-9543-210fedcba987", "partCount": 1,
            "codeCount": 10, "boxCount": 2, "palletCount": 1, "openPalletSuppressedBoxCount": 0
        })
    };
    let path = format!("/v1/office/shifts/{}/exports", run.shift);
    let (status, body) = admin
        .call(
            "POST",
            &path,
            Some(record("shift_xml_gismt_aggregation", 1)),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(constraint(&body), "demo_shift");
    assert_eq!(audit_trail(&admin.app, "shift.export").await.len(), 0);
    let (status, body) = admin
        .call("POST", &path, Some(record("shift_csv_flat", 1)))
        .await;
    assert!(status.is_success(), "{status} {body}");
}

#[tokio::test]
async fn a_demo_box_goes_into_no_disaggregation_document() {
    let admin = demo_admin().await;
    let run = run_demo_shift(&admin, true).await;
    let (status, document) = admin
        .call(
            "POST",
            "/v1/office/disaggregation",
            Some(json!({ "reasonId": null, "comment": null })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{document}");
    let id = document["document"]["id"].as_str().unwrap();
    let (status, body) = admin
        .call(
            "POST",
            &format!("/v1/office/disaggregation/{id}/lines"),
            Some(json!({
                "lines": [
                    { "input": run.boxes[0], "sscc": run.boxes[0] },
                    { "input": run.pallet, "sscc": run.pallet }
                ],
                "import": false
            })),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(constraint(&body), "demo_box");
    assert_eq!(
        body["error"]["details"]["ssccs"],
        json!([run.boxes[0], run.pallet])
    );
    assert_eq!(
        count(
            &admin.app,
            "SELECT COUNT(*) FROM disaggregation_document_lines"
        )
        .await,
        0
    );
}

#[tokio::test]
async fn the_usage_statistics_count_no_demo_shift() {
    let admin = demo_admin().await;
    let (status, before) = admin.call("GET", "/v1/office/usage-stats", None).await;
    assert_eq!(status, StatusCode::OK, "{before}");
    run_demo_shift(&admin, true).await;
    let (status, after) = admin.call("GET", "/v1/office/usage-stats", None).await;
    assert_eq!(status, StatusCode::OK, "{after}");
    assert_eq!(before["months"], after["months"]);
    // The demo shift's month is in the window, and counts nothing.
    let september = after["months"]
        .as_array()
        .unwrap()
        .iter()
        .find(|month| month["month"] == "2026-09")
        .expect("the demo shift's month is in the window")
        .clone();
    assert_eq!(september["shifts"]["aggregation"], 0);
    assert_eq!(september["scans"]["accepted"], 0);
    assert_eq!(september["boxes"]["closed"], 0);
    assert_eq!(september["pallets"]["closed"], 0);
}

/// Rows still referring to the demo data, by table.
async fn demo_rows(app: &TestApp) -> Vec<(&'static str, i64)> {
    let mut rows = Vec::new();
    for (table, sql) in [
        ("products", "SELECT COUNT(*) FROM products"),
        ("product_photos", "SELECT COUNT(*) FROM product_photos"),
        ("shifts", "SELECT COUNT(*) FROM shifts"),
        ("scans", "SELECT COUNT(*) FROM scans"),
        ("boxes", "SELECT COUNT(*) FROM boxes"),
        ("box_items", "SELECT COUNT(*) FROM box_items"),
        ("pallets", "SELECT COUNT(*) FROM pallets"),
        ("code_owners", "SELECT COUNT(*) FROM code_owners"),
        (
            "fact_receipts",
            "SELECT COUNT(*) FROM fact_receipts WHERE shift_id IS NOT NULL",
        ),
        (
            "shift_close_events",
            "SELECT COUNT(*) FROM shift_close_events",
        ),
        (
            "shift_participants",
            "SELECT COUNT(*) FROM shift_participants",
        ),
        (
            "shift_number_counters",
            "SELECT COUNT(*) FROM shift_number_counters",
        ),
        (
            "sscc_counters",
            "SELECT COUNT(*) FROM sscc_counters WHERE issuer_prefix = '290000000'",
        ),
        (
            "sscc_blocks",
            "SELECT COUNT(*) FROM sscc_blocks WHERE issuer_prefix = '290000000'",
        ),
    ] {
        rows.push((table, count(app, sql).await));
    }
    rows
}

#[tokio::test]
async fn the_summary_says_what_the_demo_data_holds() {
    let admin = demo_admin().await;
    let (status, summary) = admin.call("GET", "/v1/office/demo-data", None).await;
    assert_eq!(status, StatusCode::OK, "{summary}");
    let product: String = sqlx::query_scalar("SELECT id FROM products")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    assert_eq!(
        summary,
        json!({
            "present": true, "productId": product, "shifts": 1, "boxes": 0, "pallets": 0,
            "codes": 0, "activeShifts": []
        })
    );
    run_demo_shift(&admin, false).await;
    // A technologist reads it too.
    let technologist = admin.technologist().await;
    let (status, summary) = admin
        .call_as(&technologist, "GET", "/v1/office/demo-data", None)
        .await;
    assert_eq!(status, StatusCode::OK, "{summary}");
    assert_eq!(
        (
            &summary["boxes"],
            &summary["pallets"],
            &summary["codes"],
            &summary["activeShifts"]
        ),
        (&json!(2), &json!(1), &json!(10), &json!(["DEMO-001"]))
    );
}

#[tokio::test]
async fn a_host_without_demo_data_deletes_nothing() {
    let admin = support::app::admin().await;
    let rev = host_revision(&admin.app).await;
    let rows = support::app::audit_rows(&admin.app).await;
    let (status, summary) = admin.call("GET", "/v1/office/demo-data", None).await;
    assert_eq!(status, StatusCode::OK, "{summary}");
    assert_eq!(summary["present"], false);
    let (status, body) = admin.call("DELETE", "/v1/office/demo-data", None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["present"], false);
    assert_eq!(host_revision(&admin.app).await, rev);
    assert_eq!(support::app::audit_rows(&admin.app).await, rows);
}

#[tokio::test]
async fn an_open_demo_shift_stops_the_delete_and_only_an_administrator_deletes() {
    let admin = demo_admin().await;
    let technologist = admin.technologist().await;
    let (status, body) = admin
        .call_as(&technologist, "DELETE", "/v1/office/demo-data", None)
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    run_demo_shift(&admin, false).await;
    let before = demo_rows(&admin.app).await;
    let rev = host_revision(&admin.app).await;
    let (status, body) = admin.call("DELETE", "/v1/office/demo-data", None).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(constraint(&body), "demo_shift_active");
    assert_eq!(body["error"]["details"]["shifts"], json!(["DEMO-001"]));
    assert_eq!(demo_rows(&admin.app).await, before);
    assert_eq!(host_revision(&admin.app).await, rev);
    assert!(audit_trail(&admin.app, "demo_data.delete").await.is_empty());
}

#[tokio::test]
async fn the_delete_removes_every_trace_of_the_demo_data_in_one_revision() {
    let admin = demo_admin().await;
    let run = run_demo_shift(&admin, true).await;
    let product: String = sqlx::query_scalar("SELECT id FROM products")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    let rev = host_revision(&admin.app).await;
    let (status, removed) = admin.call("DELETE", "/v1/office/demo-data", None).await;
    assert_eq!(status, StatusCode::OK, "{removed}");
    assert_eq!(
        removed,
        json!({
            "present": true, "productId": product, "shifts": 1, "boxes": 2, "pallets": 1,
            "codes": 10, "activeShifts": []
        })
    );
    assert!(demo_rows(&admin.app)
        .await
        .iter()
        .all(|(_, rows)| *rows == 0));
    assert_eq!(host_revision(&admin.app).await, rev + 1);
    // The organization's work data stays.
    assert_eq!(count(&admin.app, "SELECT COUNT(*) FROM lines").await, 2);
    assert_eq!(
        count(&admin.app, "SELECT COUNT(*) FROM label_templates").await,
        2
    );
    assert_eq!(
        count(
            &admin.app,
            "SELECT COUNT(*) FROM sscc_counters WHERE issuer_prefix = '460068200'"
        )
        .await,
        2
    );
    // The product leaves the stations' feed as a tombstone.
    assert_eq!(
        support::app::tombstones(&admin.app).await,
        vec![("products".to_owned(), product.clone(), rev + 1)]
    );
    let trail = audit_trail(&admin.app, "demo_data.delete").await;
    assert_eq!(
        trail,
        vec![(
            "office_user".to_owned(),
            Some(admin.id.clone()),
            "demo_data.delete".to_owned(),
            Some("product".to_owned()),
            Some(product.clone()),
            "ok".to_owned(),
            json!({ "shifts": 1, "boxes": 2, "pallets": 1, "codes": 10 }),
        )]
    );
    let (status, summary) = admin.call("GET", "/v1/office/demo-data", None).await;
    assert_eq!(status, StatusCode::OK, "{summary}");
    assert_eq!(summary["present"], false);
    // A second press changes nothing.
    let (status, again) = admin.call("DELETE", "/v1/office/demo-data", None).await;
    assert_eq!((status, &again["present"]), (StatusCode::OK, &json!(false)));
    assert_eq!(host_revision(&admin.app).await, rev + 1);

    // A station's late fact of the removed shift is acknowledged and dropped.
    let late = support::app::fact(
        &support::app::record_id(900),
        "scan",
        &run.shift,
        json!({
            "scannedAt": support::app::instant(30, 0), "verdict": "ok", "duplicateSource": null,
            "rawKind": "km", "rawLength": 40, "code": demo_code(11),
            "boxId": support::app::box_id(3)
        }),
    );
    let answers = support::app::receipts(&admin.app, &admin.key, &[late]).await;
    assert_eq!(
        answers,
        vec![json!({ "id": support::app::record_id(900), "outcome": "accepted" })]
    );
    assert_eq!(count(&admin.app, "SELECT COUNT(*) FROM scans").await, 0);

    // The demo prefix is free again.
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
    assert_eq!(status, StatusCode::OK, "{body}");
}

#[tokio::test]
async fn a_planned_demo_shift_goes_with_the_demo_data() {
    let admin = demo_admin().await;
    let (status, removed) = admin.call("DELETE", "/v1/office/demo-data", None).await;
    assert_eq!(status, StatusCode::OK, "{removed}");
    assert_eq!(removed["shifts"], 1);
    assert!(demo_rows(&admin.app)
        .await
        .iter()
        .all(|(_, rows)| *rows == 0));
}
