//! A4 sheets chosen by default on a par with the pallet labels (beta
//! feedback, migration `0019`): the organization's and each category's
//! default sheet in the templates' defaults document, a product's preferred
//! sheet, and the order a shift takes them in. A sheet and a thermal label
//! never take each other's place: each slot reads its own table.

mod support;

use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{
    admin, audit_rows, audit_trail, default_sheet_is, json as json_request, pallet_shift_body,
    pallet_template, plan_shift, request, shift_setup, stock_sheet, with_device, Admin, ShiftSetup,
};

const DEFAULTS: &str = "/v1/office/template-defaults";
const PRODUCTS: &str = "/v1/office/products";

async fn document(admin: &Admin) -> Value {
    let (status, document) = admin.call("GET", DEFAULTS, None).await;
    assert_eq!(status, StatusCode::OK, "{document}");
    document
}

/// The document as it is, with `changes` laid over it and its revision as
/// the expected one.
async fn put_over(admin: &Admin, changes: Value) -> (StatusCode, Value) {
    let current = document(admin).await;
    let mut body = json!({
        "defaultBoxTemplateId": current["defaultBoxTemplateId"],
        "defaultPalletTemplateId": current["defaultPalletTemplateId"],
        "defaultDuplicateTemplateId": current["defaultDuplicateTemplateId"],
        "categories": current["categories"],
        "expectedRev": current["rev"],
    });
    for (key, value) in changes.as_object().unwrap() {
        body[key] = value.clone();
    }
    admin.call("PUT", DEFAULTS, Some(body)).await
}

/// `(status, code, field)` of a refusal.
fn invalid(status: StatusCode, body: &Value) -> (StatusCode, Value, Value) {
    (
        status,
        body["error"]["code"].clone(),
        body["error"]["details"]["field"].clone(),
    )
}

fn refused_on(field: &str) -> (StatusCode, Value, Value) {
    (
        StatusCode::BAD_REQUEST,
        json!("validation_failed"),
        json!(field),
    )
}

/// The product of `setup` as the office reads it.
async fn product(admin: &Admin, id: &str) -> Value {
    let (status, list) = admin.call("GET", PRODUCTS, None).await;
    assert_eq!(status, StatusCode::OK, "{list}");
    list.as_array()
        .unwrap()
        .iter()
        .find(|each| each["id"] == id)
        .cloned()
        .expect("the product is listed")
}

/// `PUT` of the product `id` as it is, with `changes` laid over it.
async fn update_product(admin: &Admin, id: &str, changes: Value) -> (StatusCode, Value) {
    let current = product(admin, id).await;
    let mut body = json!({
        "gtin14": current["gtin14"],
        "name": current["name"],
        "printName": current["printName"],
        "chzProductGroupCode": current["chzProductGroupCode"],
        "boxCapacity": current["boxCapacity"],
        "palletBoxCapacity": current["palletBoxCapacity"],
        "shelfLifeDays": current["shelfLifeDays"],
        "defaultBoxTemplateId": current["defaultBoxTemplateId"],
        "defaultPalletTemplateId": current["defaultPalletTemplateId"],
        "archived": current["archived"],
        "expectedRev": current["rev"],
    });
    for (key, value) in changes.as_object().unwrap() {
        body[key] = value.clone();
    }
    admin
        .call("PUT", &format!("{PRODUCTS}/{id}"), Some(body))
        .await
}

/// The sheet a shift planned now without naming one gets.
async fn planned_sheet(admin: &Admin, setup: &ShiftSetup, pallet: &str) -> Value {
    plan_shift(admin, pallet_shift_body(setup, pallet)).await["palletSheetTemplateId"].clone()
}

#[tokio::test]
async fn the_document_carries_the_sheet_defaults() {
    let admin = admin().await;
    let fresh = document(&admin).await;
    assert_eq!(fresh["defaultPalletSheetId"], Value::Null);
    assert_eq!(fresh["palletSheetCategories"], json!([]));
    // The sheets page's own route and the document show the same default.
    let sheet = stock_sheet(&admin, "pallet-a4-portrait").await;
    default_sheet_is(&admin, &sheet).await;
    assert_eq!(document(&admin).await["defaultPalletSheetId"], json!(sheet));
}

#[tokio::test]
async fn the_sheet_defaults_are_saved_with_the_document() {
    let admin = admin().await;
    let portrait = stock_sheet(&admin, "pallet-a4-portrait").await;
    let landscape = stock_sheet(&admin, "pallet-a4-landscape").await;
    let before = document(&admin).await;
    let (status, saved) = put_over(
        &admin,
        json!({
            "defaultPalletSheetId": portrait,
            "palletSheetCategories": [
                { "chzProductGroupCode": 8, "sheetId": landscape },
                { "chzProductGroupCode": 3, "sheetId": portrait }
            ]
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(saved["defaultPalletSheetId"], json!(portrait));
    // By code, whatever order was sent.
    assert_eq!(
        saved["palletSheetCategories"],
        json!([
            { "chzProductGroupCode": 3, "sheetId": portrait },
            { "chzProductGroupCode": 8, "sheetId": landscape }
        ])
    );
    assert!(saved["rev"].as_i64().unwrap() > before["rev"].as_i64().unwrap());
    assert_eq!(document(&admin).await, saved);
    assert_eq!(
        audit_trail(&admin.app, "template_defaults.update").await,
        vec![admin.row(
            "template_defaults.update",
            "template_defaults",
            "1",
            json!({
                "changed": ["defaultPalletSheetId", "palletSheetCategories"],
                "defaultPalletSheetId": { "from": null, "to": portrait },
                "palletSheetCategories": {
                    "from": [],
                    "to": [
                        { "chzProductGroupCode": 3, "sheetId": portrait },
                        { "chzProductGroupCode": 8, "sheetId": landscape }
                    ]
                }
            })
        )]
    );
    // A write over the older revision is stale, and the same document again
    // writes nothing.
    let mut stale = json!({
        "categories": [], "defaultPalletSheetId": null, "expectedRev": before["rev"]
    });
    let (status, refused) = admin.call("PUT", DEFAULTS, Some(stale.clone())).await;
    assert_eq!(
        (status, refused["error"]["code"].clone()),
        (StatusCode::CONFLICT, json!("stale_revision")),
        "{refused}"
    );
    let rows = audit_rows(&admin.app).await;
    let (status, again) = put_over(
        &admin,
        json!({
            "defaultPalletSheetId": portrait,
            "palletSheetCategories": [
                { "chzProductGroupCode": 8, "sheetId": landscape },
                { "chzProductGroupCode": 3, "sheetId": portrait }
            ]
        }),
    )
    .await;
    assert_eq!((status, &again), (StatusCode::OK, &saved));
    assert_eq!(audit_rows(&admin.app).await, rows);
    // Cleared: one category left out, the organization's none.
    stale["expectedRev"] = saved["rev"].clone();
    stale["palletSheetCategories"] = json!([{ "chzProductGroupCode": 3, "sheetId": portrait }]);
    let (status, cleared) = admin.call("PUT", DEFAULTS, Some(stale)).await;
    assert_eq!(status, StatusCode::OK, "{cleared}");
    assert_eq!(cleared["defaultPalletSheetId"], Value::Null);
    assert_eq!(
        cleared["palletSheetCategories"],
        json!([{ "chzProductGroupCode": 3, "sheetId": portrait }])
    );
    // A later write over the revision the cleared row had is stale too: the
    // revision never moves back.
    let (status, refused) = admin
        .call(
            "PUT",
            DEFAULTS,
            Some(json!({ "categories": [], "expectedRev": saved["rev"] })),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{refused}");
}

/// An office from before this change sends neither sheet field: the sheet
/// defaults stay as they are.
#[tokio::test]
async fn a_document_without_the_sheet_fields_keeps_them() {
    let admin = admin().await;
    let sheet = stock_sheet(&admin, "pallet-a4-portrait").await;
    let (status, _) = put_over(
        &admin,
        json!({
            "defaultPalletSheetId": sheet,
            "palletSheetCategories": [{ "chzProductGroupCode": 8, "sheetId": sheet }]
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let pallet = pallet_template(&admin).await;
    let (status, saved) = put_over(&admin, json!({ "defaultPalletTemplateId": pallet })).await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(saved["defaultPalletTemplateId"], json!(pallet));
    assert_eq!(saved["defaultPalletSheetId"], json!(sheet));
    assert_eq!(
        saved["palletSheetCategories"],
        json!([{ "chzProductGroupCode": 8, "sheetId": sheet }])
    );
}

/// A pallet document is a thermal label or an A4 sheet, each in its own
/// slot: an id of the one is refused where the other is required, at every
/// level.
#[tokio::test]
async fn a_label_and_a_sheet_never_take_each_others_place() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let pallet = pallet_template(&admin).await;
    let sheet = stock_sheet(&admin, "pallet-a4-portrait").await;
    let rows = audit_rows(&admin.app).await;
    for (changes, field) in [
        (
            json!({ "defaultPalletTemplateId": sheet }),
            "defaultPalletTemplateId",
        ),
        (
            json!({ "defaultPalletSheetId": pallet }),
            "defaultPalletSheetId",
        ),
        (
            json!({ "categories": [
                { "chzProductGroupCode": 8, "purpose": "pallet", "templateId": sheet }
            ] }),
            "categories.0.templateId",
        ),
        (
            json!({ "palletSheetCategories": [{ "chzProductGroupCode": 8, "sheetId": pallet }] }),
            "palletSheetCategories.0.sheetId",
        ),
    ] {
        let (status, refused) = put_over(&admin, changes.clone()).await;
        assert_eq!(invalid(status, &refused), refused_on(field), "{changes}");
    }
    for (changes, field) in [
        (
            json!({ "defaultPalletTemplateId": sheet }),
            "defaultPalletTemplateId",
        ),
        (
            json!({ "defaultPalletSheetId": pallet }),
            "defaultPalletSheetId",
        ),
    ] {
        let (status, refused) = update_product(&admin, &setup.product, changes.clone()).await;
        assert_eq!(invalid(status, &refused), refused_on(field), "{changes}");
    }
    let mut create = json!({
        "gtin14": "04600682000020", "name": "Кефир", "defaultPalletSheetId": pallet
    });
    let (status, refused) = admin.call("POST", PRODUCTS, Some(create.clone())).await;
    assert_eq!(
        invalid(status, &refused),
        refused_on("defaultPalletSheetId")
    );
    create["defaultPalletSheetId"] = Value::Null;
    create["defaultPalletTemplateId"] = json!(sheet);
    let (status, refused) = admin.call("POST", PRODUCTS, Some(create)).await;
    assert_eq!(
        invalid(status, &refused),
        refused_on("defaultPalletTemplateId")
    );
    // A shift's sheet is a sheet, not a pallet label.
    let mut body = pallet_shift_body(&setup, &pallet);
    body["palletSheetTemplateId"] = json!(pallet);
    let (status, refused) = admin.call("POST", "/v1/office/shifts", Some(body)).await;
    assert_eq!(
        invalid(status, &refused),
        refused_on("palletSheetTemplateId")
    );
    assert_eq!(audit_rows(&admin.app).await, rows, "nothing was written");
}

#[tokio::test]
async fn a_sheet_default_is_checked_before_it_is_kept() {
    let admin = admin().await;
    let sheet = stock_sheet(&admin, "pallet-a4-portrait").await;
    let off = stock_sheet(&admin, "pallet-a4-landscape").await;
    let (status, _) = admin
        .call(
            "PUT",
            &format!("/v1/office/pallet-sheets/{off}"),
            Some(json!({ "enabled": false, "expectedRevision": 1 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let missing = "8f6d1c2e-3b4a-4c5d-9e8f-7a6b5c4d3e2f";
    let rows = audit_rows(&admin.app).await;
    for (changes, field) in [
        (
            json!({ "defaultPalletSheetId": off }),
            "defaultPalletSheetId",
        ),
        (
            json!({ "defaultPalletSheetId": missing }),
            "defaultPalletSheetId",
        ),
        (
            json!({ "palletSheetCategories": [{ "chzProductGroupCode": 8, "sheetId": off }] }),
            "palletSheetCategories.0.sheetId",
        ),
        (
            json!({ "palletSheetCategories": [{ "chzProductGroupCode": 999, "sheetId": sheet }] }),
            "palletSheetCategories.0.chzProductGroupCode",
        ),
        (
            json!({ "palletSheetCategories": [
                { "chzProductGroupCode": 8, "sheetId": sheet },
                { "chzProductGroupCode": 8, "sheetId": sheet }
            ] }),
            "palletSheetCategories.1",
        ),
    ] {
        let (status, refused) = put_over(&admin, changes.clone()).await;
        assert_eq!(invalid(status, &refused), refused_on(field), "{changes}");
    }
    // Not the shape: a stray field in an entry.
    let (status, refused) = put_over(
        &admin,
        json!({ "palletSheetCategories": [
            { "chzProductGroupCode": 8, "sheetId": sheet, "purpose": "pallet" }
        ] }),
    )
    .await;
    assert_eq!(
        (status, refused["error"]["code"].clone()),
        (StatusCode::BAD_REQUEST, json!("validation_failed"))
    );
    assert_eq!(audit_rows(&admin.app).await, rows);
    assert_eq!(document(&admin).await["palletSheetCategories"], json!([]));
}

/// A sheet a category takes by default is held as the organization's is: it
/// is neither switched off nor deleted, and the refusal says whose default
/// it is, as a label template's does.
#[tokio::test]
async fn a_categorys_default_sheet_is_neither_switched_off_nor_deleted() {
    let admin = admin().await;
    let sheet = stock_sheet(&admin, "pallet-a4-portrait").await;
    let (status, _) = put_over(
        &admin,
        json!({ "palletSheetCategories": [
            { "chzProductGroupCode": 8, "sheetId": sheet },
            { "chzProductGroupCode": 3, "sheetId": sheet }
        ] }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let item = format!("/v1/office/pallet-sheets/{sheet}");
    let rows = audit_rows(&admin.app).await;
    for (method, body) in [
        (
            "PUT",
            Some(json!({ "enabled": false, "expectedRevision": 1 })),
        ),
        ("DELETE", None),
    ] {
        let (status, refused) = admin.call(method, &item, body).await;
        assert_eq!(
            (
                status,
                refused["error"]["code"].clone(),
                refused["error"]["details"].clone()
            ),
            (
                StatusCode::CONFLICT,
                json!("conflict"),
                json!({
                    "constraint": "template_is_default",
                    "organizationDefault": false,
                    "categoryDefaults": [3, 8]
                })
            ),
            "{method}"
        );
    }
    assert_eq!(audit_rows(&admin.app).await, rows);
    // A rename still goes through.
    let (status, renamed) = admin
        .call(
            "PUT",
            &item,
            Some(json!({ "name": "Цех 2", "expectedRevision": 1 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{renamed}");
}

#[tokio::test]
async fn a_product_prefers_a_sheet() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let sheet = stock_sheet(&admin, "pallet-a4-portrait").await;
    assert_eq!(
        product(&admin, &setup.product).await["defaultPalletSheetId"],
        Value::Null
    );
    let (status, chosen) = update_product(
        &admin,
        &setup.product,
        json!({ "defaultPalletSheetId": sheet }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{chosen}");
    assert_eq!(chosen["defaultPalletSheetId"], json!(sheet));
    let trail = audit_trail(&admin.app, "product.update").await;
    assert_eq!(
        trail.last().unwrap().6,
        json!({
            "changed": ["defaultPalletSheetId"],
            "defaultPalletSheetId": { "from": null, "to": sheet }
        })
    );
    // An office from before this change leaves the field out: it is kept.
    let (status, kept) =
        update_product(&admin, &setup.product, json!({ "shelfLifeDays": 12 })).await;
    assert_eq!(status, StatusCode::OK, "{kept}");
    assert_eq!(kept["defaultPalletSheetId"], json!(sheet));
    // A sheet switched off later stays the product's preference.
    let (status, _) = admin
        .call(
            "PUT",
            &format!("/v1/office/pallet-sheets/{sheet}"),
            Some(json!({ "enabled": false, "expectedRevision": 1 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let (status, archived) =
        update_product(&admin, &setup.product, json!({ "archived": true })).await;
    assert_eq!(status, StatusCode::OK, "{archived}");
    assert_eq!(archived["defaultPalletSheetId"], json!(sheet));
    // `null` clears it.
    let (status, cleared) = update_product(
        &admin,
        &setup.product,
        json!({ "defaultPalletSheetId": null }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{cleared}");
    assert_eq!(cleared["defaultPalletSheetId"], Value::Null);
    // A new product may name one from the start.
    let (status, created) = admin
        .call(
            "POST",
            PRODUCTS,
            Some(json!({
                "gtin14": "04600682000020", "name": "Кефир", "defaultPalletSheetId": sheet
            })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    assert_eq!(created["defaultPalletSheetId"], json!(sheet));
}

/// Deleting a sheet clears every product preference that names it at the
/// delete's revision, so those products ride the feed again, as a label
/// template's delete does.
#[tokio::test]
async fn deleting_a_sheet_clears_the_products_that_prefer_it() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let sheet = stock_sheet(&admin, "pallet-a4-portrait").await;
    let (_, chosen) = update_product(
        &admin,
        &setup.product,
        json!({ "defaultPalletSheetId": sheet }),
    )
    .await;
    let (status, _) = admin
        .call("DELETE", &format!("/v1/office/pallet-sheets/{sheet}"), None)
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let after = product(&admin, &setup.product).await;
    assert_eq!(after["defaultPalletSheetId"], Value::Null);
    assert!(after["rev"].as_i64().unwrap() > chosen["rev"].as_i64().unwrap());
    let feed = admin.feed(chosen["rev"].as_i64().unwrap()).await;
    assert!(
        feed.as_array()
            .unwrap()
            .iter()
            .any(|item| item["entity"] == "products" && item["id"] == setup.product.as_str()),
        "{feed}"
    );
    assert_eq!(
        audit_trail(&admin.app, "pallet_sheet.delete").await,
        vec![admin.row(
            "pallet_sheet.delete",
            "pallet_sheet",
            &sheet,
            json!({ "name": "pallet-a4-portrait", "productsCleared": 1 })
        )]
    );
}

/// A shift with pallets that names no sheet takes the product's preferred
/// sheet while it is on, else its category's default, else the
/// organization's, else none, as the pallet label goes from the product to
/// the category to the organization. A station's shift too.
#[tokio::test]
async fn a_shift_takes_the_products_sheet_then_the_categorys_then_the_organizations() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let pallet = pallet_template(&admin).await;
    let main = stock_sheet(&admin, "pallet-a4-portrait").await;
    let category = stock_sheet(&admin, "pallet-a4-landscape").await;
    let own = stock_sheet(&admin, "pallet-a4-two-a5").await;
    assert_eq!(planned_sheet(&admin, &setup, &pallet).await, Value::Null);
    default_sheet_is(&admin, &main).await;
    assert_eq!(planned_sheet(&admin, &setup, &pallet).await, json!(main));
    // Another category's default is not the milk's.
    let (status, _) = put_over(
        &admin,
        json!({ "palletSheetCategories": [{ "chzProductGroupCode": 3, "sheetId": category }] }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(planned_sheet(&admin, &setup, &pallet).await, json!(main));
    let (status, _) = put_over(
        &admin,
        json!({ "palletSheetCategories": [{ "chzProductGroupCode": 8, "sheetId": category }] }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        planned_sheet(&admin, &setup, &pallet).await,
        json!(category)
    );
    let (status, _) = update_product(
        &admin,
        &setup.product,
        json!({ "defaultPalletSheetId": own }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let planned = plan_shift(&admin, pallet_shift_body(&setup, &pallet)).await;
    assert_eq!(planned["palletSheetTemplateId"], json!(own));
    // A sheet named in the request still wins.
    let mut named = pallet_shift_body(&setup, &pallet);
    named["palletSheetTemplateId"] = json!(main);
    assert_eq!(
        plan_shift(&admin, named).await["palletSheetTemplateId"],
        json!(main)
    );
    // The station's shift, which never names a sheet, takes the same.
    let (status, body) = admin
        .app
        .send(json_request(
            with_device(request("PUT", "/v1/device/line"), &admin.key),
            json!({ "lineId": setup.line }),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, station) = admin
        .app
        .send(json_request(
            with_device(request("POST", "/v1/device/shifts"), &admin.key),
            json!({
                "requestId": "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
                "productId": setup.product,
                "boxTemplateId": setup.template,
                "productionDate": "2026-10-09",
                "palletsEnabled": true,
                "palletTemplateId": pallet
            }),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{station}");
    let (_, office) = admin
        .call(
            "GET",
            &format!("/v1/office/shifts/{}", station["id"].as_str().unwrap()),
            None,
        )
        .await;
    assert_eq!(office["palletSheetTemplateId"], json!(own));
    // The product's sheet switched off: the category's.
    let (status, _) = admin
        .call(
            "PUT",
            &format!("/v1/office/pallet-sheets/{own}"),
            Some(json!({ "enabled": false, "expectedRevision": 1 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        planned_sheet(&admin, &setup, &pallet).await,
        json!(category)
    );
    // A planned shift sent back to the default (`null`) takes the chain as it
    // is at that edit.
    let (status, edited) = admin
        .call(
            "PUT",
            &format!("/v1/office/shifts/{}", planned["id"].as_str().unwrap()),
            Some(json!({ "palletSheetTemplateId": null, "expectedRev": planned["rev"] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{edited}");
    assert_eq!(edited["palletSheetTemplateId"], json!(category));
}

/// The technologist chooses the sheet defaults too; a device never does.
#[tokio::test]
async fn a_technologist_chooses_the_sheet_defaults_and_a_device_never_does() {
    let admin = admin().await;
    let sheet = stock_sheet(&admin, "pallet-a4-portrait").await;
    let current = document(&admin).await;
    let body = json!({
        "categories": [],
        "defaultPalletSheetId": sheet,
        "palletSheetCategories": [{ "chzProductGroupCode": 8, "sheetId": sheet }],
        "expectedRev": current["rev"]
    });
    let rows = audit_rows(&admin.app).await;
    let (status, refused) = admin
        .app
        .send(json_request(
            with_device(request("PUT", DEFAULTS), &admin.key),
            body.clone(),
        ))
        .await;
    assert_eq!(
        (status, refused["error"]["code"].clone()),
        (StatusCode::UNAUTHORIZED, json!("unauthorized"))
    );
    assert_eq!(audit_rows(&admin.app).await, rows);
    let (token, id) = admin.technologist_session().await;
    let (status, saved) = admin.call_as(&token, "PUT", DEFAULTS, Some(body)).await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(saved["defaultPalletSheetId"], json!(sheet));
    assert_eq!(
        audit_trail(&admin.app, "template_defaults.update").await[0]
            .1
            .as_deref(),
        Some(id.as_str())
    );
}

/// The statements a shift and a delete run on tables that grow search by an
/// index, never a scan.
#[tokio::test]
async fn the_sheet_default_statements_search_by_an_index() {
    use markiro_host::routes::pallet_sheets::{PRODUCTS_PREFERRING_SQL, PRODUCT_SHEET_SQL};
    let admin = admin().await;
    for (name, sql, index) in [
        ("chain", PRODUCT_SHEET_SQL, "sqlite_autoindex_products"),
        (
            "preferring",
            PRODUCTS_PREFERRING_SQL,
            "products_default_pallet_sheet",
        ),
    ] {
        let plan: Vec<(i64, i64, i64, String)> =
            sqlx::query_as(&format!("EXPLAIN QUERY PLAN {sql}"))
                .bind("x")
                .fetch_all(&admin.app.state.pool)
                .await
                .unwrap();
        let steps: Vec<&str> = plan.iter().map(|(_, _, _, step)| step.as_str()).collect();
        // The chain's outer `SELECT COALESCE(…)` reads no table: its constant
        // row is the only scan allowed.
        assert!(
            steps
                .iter()
                .all(|step| !step.starts_with("SCAN") || *step == "SCAN CONSTANT ROW"),
            "{name}: {steps:?}"
        );
        assert!(
            steps.iter().any(|step| step.contains(index)),
            "{name} does not use {index}: {steps:?}"
        );
    }
}
