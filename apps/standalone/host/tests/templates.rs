mod support;

use axum::http::StatusCode;
use markiro_host::templates::{fits, Scope};
use markiro_proto::TemplatePurpose;
use serde_json::{json, Value};
use support::app::{
    admin, audit_row, audit_rows, audit_trail, host_revision, nested,
    turn_the_user_off_at_the_next_activity, Admin, TestApp,
};

/// `proto/fixtures/template-eligibility.json` holds the cases the host's
/// rule and the domain's must answer alike; plan 1e2 reads it in Vitest.
#[test]
fn the_eligibility_fixture_matches_fits() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../proto/fixtures/template-eligibility.json"
    );
    let text = std::fs::read_to_string(path).unwrap_or_else(|error| panic!("read {path}: {error}"));
    let fixture: Value = serde_json::from_str(&text).unwrap();
    let cases = fixture["cases"].as_array().expect("cases");
    assert_eq!(cases.len(), 12);
    for case in cases {
        let template = &case["template"];
        let scope = Scope {
            purpose: serde_json::from_value(template["purpose"].clone()).unwrap(),
            enabled: template["enabled"].as_bool().unwrap(),
            codes: serde_json::from_value(template["chzProductGroupCodes"].clone()).unwrap(),
        };
        let slot = &case["slot"];
        let purpose: TemplatePurpose = serde_json::from_value(slot["purpose"].clone()).unwrap();
        let category: Option<u32> =
            serde_json::from_value(slot["chzProductGroupCode"].clone()).unwrap();
        assert_eq!(
            fits(&scope, purpose, category),
            case["fits"].as_bool().unwrap(),
            "{case}"
        );
    }
}

/// A small layout, as the office's editor saves one.
fn layout() -> Value {
    json!({ "widthMm": 58, "heightMm": 40, "dpi": 203, "language": "zpl", "elements": [] })
}

async fn create(admin: &Admin, body: Value) -> Value {
    let (status, created) = admin.call("POST", "/v1/office/templates", Some(body)).await;
    assert_eq!(status, StatusCode::OK, "{created}");
    created
}

fn box_template(name: &str) -> Value {
    json!({ "name": name, "purpose": "box", "enabled": true, "spec": layout() })
}

fn path(template: &Value) -> String {
    format!("/v1/office/templates/{}", template["id"].as_str().unwrap())
}

fn error(body: &Value) -> (Value, Value) {
    (
        body["error"]["code"].clone(),
        body["error"]["details"].clone(),
    )
}

/// A stock template as the wizard leaves one, written straight into its
/// table; returns its id and revision.
async fn insert_stock(app: &TestApp) -> (String, i64) {
    let mut tx = markiro_host::db::begin_write(&app.state.pool)
        .await
        .unwrap();
    let rev = markiro_host::db::next_revision(&mut tx).await.unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO label_templates (id, name, purpose, enabled, spec, stock, rev) \
         VALUES (?, 'Коробка 58×40', 'box', 1, ?, 1, ?)",
    )
    .bind(&id)
    .bind(layout().to_string())
    .bind(rev)
    .execute(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();
    (id, rev)
}

#[tokio::test]
async fn templates_are_created_listed_read_and_updated() {
    let admin = admin().await;
    let created = create(&admin, box_template(" Молоко 58×40 ")).await;
    let id = created["id"].as_str().unwrap().to_owned();
    // The wizard took revision 1.
    assert_eq!(
        created,
        json!({
            "id": id, "name": "Молоко 58×40", "purpose": "box", "enabled": true,
            "chzProductGroupCodes": null, "stock": false, "spec": layout(), "rev": 2
        })
    );
    assert_eq!(
        audit_trail(&admin.app, "template.create").await,
        vec![admin.row(
            "template.create",
            "template",
            &id,
            json!({ "name": "Молоко 58×40", "purpose": "box" })
        )]
    );
    // The list carries summaries...
    let (status, list) = admin.call("GET", "/v1/office/templates", None).await;
    assert_eq!(status, StatusCode::OK, "{list}");
    assert_eq!(
        list,
        json!([{
            "id": id, "name": "Молоко 58×40", "purpose": "box", "enabled": true,
            "chzProductGroupCodes": null, "stock": false,
            "widthMm": 58, "heightMm": 40, "dpi": 203, "language": "zpl", "rev": 2
        }])
    );
    // ...and one template its layout.
    let (status, read) = admin.call("GET", &path(&created), None).await;
    assert_eq!((status, read), (StatusCode::OK, created.clone()));
    // Stations get the layout as JSON.
    assert_eq!(
        admin.feed(1).await,
        json!([{
            "entity": "label_templates", "id": id, "rev": 2, "deleted": false,
            "data": {
                "name": "Молоко 58×40", "purpose": "box", "enabled": true,
                "chzProductGroupCodes": null, "stock": false, "spec": layout()
            }
        }])
    );

    let (status, renamed) = admin
        .call(
            "PUT",
            &path(&created),
            Some(json!({ "name": "Молоко и кефир 58×40", "chzProductGroupCodes": [8, 15], "expectedRev": 2 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{renamed}");
    assert_eq!(
        (
            renamed["name"].clone(),
            renamed["chzProductGroupCodes"].clone(),
            renamed["rev"].clone()
        ),
        (json!("Молоко и кефир 58×40"), json!([8, 15]), json!(3))
    );
    // A new layout is named in the audit row, never written there.
    let mut wider = layout();
    wider["widthMm"] = json!(75);
    let (status, widened) = admin
        .call(
            "PUT",
            &path(&created),
            Some(json!({ "spec": wider, "expectedRev": 3 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{widened}");
    assert_eq!(
        (widened["spec"].clone(), widened["rev"].clone()),
        (wider.clone(), json!(4))
    );
    assert_eq!(
        audit_trail(&admin.app, "template.update").await,
        vec![
            admin.row(
                "template.update",
                "template",
                &id,
                json!({
                    "changed": ["name", "chzProductGroupCodes"],
                    "name": { "from": "Молоко 58×40", "to": "Молоко и кефир 58×40" },
                    "chzProductGroupCodes": { "from": null, "to": [8, 15] }
                })
            ),
            admin.row(
                "template.update",
                "template",
                &id,
                json!({ "changed": ["spec"] })
            ),
        ]
    );

    // The same values again change nothing.
    let (status, same) = admin
        .call(
            "PUT",
            &path(&created),
            Some(json!({ "name": " Молоко и кефир 58×40 ", "enabled": true, "spec": wider, "expectedRev": 4 })),
        )
        .await;
    assert_eq!((status, same), (StatusCode::OK, widened));
    assert_eq!(host_revision(&admin.app).await, 4);
    assert_eq!(audit_trail(&admin.app, "template.update").await.len(), 2);
    // An update over an old revision is refused and writes nothing.
    let rows = audit_rows(&admin.app).await;
    let (status, body) = admin
        .call(
            "PUT",
            &path(&created),
            Some(json!({ "enabled": false, "expectedRev": 3 })),
        )
        .await;
    assert_eq!(
        (
            status,
            body["error"]["code"].clone(),
            body["error"]["details"]["currentRev"].clone()
        ),
        (StatusCode::CONFLICT, json!("stale_revision"), json!(4))
    );
    assert_eq!(host_revision(&admin.app).await, 4);
    assert_eq!(audit_rows(&admin.app).await, rows);
}

/// The host keeps a layout it does not understand: the summary reads what
/// the stored spec holds, `null` where it has nothing of the right type.
#[tokio::test]
async fn a_summary_reads_the_layout_as_it_stands() {
    let admin = admin().await;
    create(
        &admin,
        json!({
            "name": "Черновик", "purpose": "pallet", "enabled": false,
            "spec": { "widthMm": 58.5, "dpi": "203", "language": 7 }
        }),
    )
    .await;
    let (status, list) = admin.call("GET", "/v1/office/templates", None).await;
    assert_eq!(status, StatusCode::OK, "{list}");
    assert_eq!(
        (
            list[0]["widthMm"].clone(),
            list[0]["heightMm"].clone(),
            list[0]["dpi"].clone(),
            list[0]["language"].clone()
        ),
        (json!(58.5), Value::Null, Value::Null, Value::Null)
    );

    // A resolution is read only as an integer that fits a `u32`: any other
    // number (one above `i64::MAX`, a negative one, a fraction, one above
    // `u32::MAX`) is `null`. One such layout never breaks the list for
    // everybody, so the list is read, and its status asserted, after each.
    for (n, (dpi, expected)) in [
        (json!(10_000_000_000_000_000_000_u64), Value::Null),
        (json!(-203), Value::Null),
        (json!(203.5), Value::Null),
        (json!(4_294_967_296_u64), Value::Null),
        (json!(4_294_967_295_u64), json!(4_294_967_295_u64)),
    ]
    .into_iter()
    .enumerate()
    {
        let created = create(
            &admin,
            json!({
                "name": format!("Разрешение {n}"), "purpose": "box", "enabled": true,
                "spec": { "dpi": dpi }
            }),
        )
        .await;
        let (status, list) = admin.call("GET", "/v1/office/templates", None).await;
        assert_eq!(status, StatusCode::OK, "dpi {dpi}: {list}");
        let summary = list
            .as_array()
            .unwrap()
            .iter()
            .find(|summary| summary["id"] == created["id"])
            .expect("the template is listed");
        assert_eq!(summary["dpi"], expected, "dpi {dpi}");
    }
    // A size is read as the number it is, however large: no layout the host
    // accepts makes the list answer 500.
    let created = create(
        &admin,
        json!({
            "name": "Огромный", "purpose": "box", "enabled": true,
            "spec": { "widthMm": 10_000_000_000_000_000_000_u64, "heightMm": 1e23 }
        }),
    )
    .await;
    let (status, list) = admin.call("GET", "/v1/office/templates", None).await;
    assert_eq!(status, StatusCode::OK, "{list}");
    let summary = list
        .as_array()
        .unwrap()
        .iter()
        .find(|summary| summary["id"] == created["id"])
        .expect("the template is listed");
    assert_eq!(
        (summary["widthMm"].clone(), summary["heightMm"].clone()),
        (json!(10_000_000_000_000_000_000_u64), json!(1e23))
    );
}

#[tokio::test]
async fn template_fields_are_checked() {
    let admin = admin().await;
    for (field, value) in [
        ("name", json!(" ")),
        ("name", json!("ш".repeat(201))),
        ("name", json!("Коробка\t58×40")),
        ("chzProductGroupCodes", json!([])),
        ("chzProductGroupCodes", json!([8, 8])),
        // 18 is not a ЧЗ product group.
        ("chzProductGroupCodes", json!([8, 18])),
        ("spec", json!([])),
        ("spec", json!("{}")),
        ("spec", json!({ "filler": "x".repeat(262_144) })),
    ] {
        let mut body = box_template("Коробка 58×40");
        body[field] = value;
        let (status, refused) = admin.call("POST", "/v1/office/templates", Some(body)).await;
        assert_eq!(
            (status, refused["error"]["details"]["field"].clone()),
            (StatusCode::BAD_REQUEST, json!(field)),
            "{field}"
        );
    }
    // An unknown purpose, or a field no request sets, is refused as a whole.
    for (field, value) in [("purpose", json!("label")), ("stock", json!(true))] {
        let mut body = box_template("Коробка 58×40");
        body[field] = value;
        let (status, refused) = admin.call("POST", "/v1/office/templates", Some(body)).await;
        assert_eq!(
            (status, refused["error"]["code"].clone()),
            (StatusCode::BAD_REQUEST, json!("validation_failed")),
            "{field}"
        );
    }
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM label_templates")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    assert!(audit_trail(&admin.app, "template.create").await.is_empty());
}

#[tokio::test]
async fn a_purpose_never_changes() {
    let admin = admin().await;
    let created = create(&admin, box_template("Коробка 58×40")).await;
    let (status, body) = admin
        .call(
            "PUT",
            &path(&created),
            Some(json!({ "purpose": "pallet", "expectedRev": 2 })),
        )
        .await;
    assert_eq!(
        (status, body["error"]["code"].clone()),
        (StatusCode::BAD_REQUEST, json!("validation_failed"))
    );
    let (_, read) = admin.call("GET", &path(&created), None).await;
    assert_eq!(read, created);
}

#[tokio::test]
async fn a_stock_template_keeps_its_name_and_layout_and_is_never_deleted() {
    let admin = admin().await;
    let (stock, rev) = insert_stock(&admin.app).await;
    let stock_path = format!("/v1/office/templates/{stock}");
    let rows = audit_rows(&admin.app).await;
    for change in [
        json!({ "name": "Моя коробка", "expectedRev": rev }),
        json!({ "spec": { "widthMm": 75 }, "expectedRev": rev }),
    ] {
        let (status, body) = admin.call("PUT", &stock_path, Some(change)).await;
        assert_eq!(
            (status, body["error"]["details"]["constraint"].clone()),
            (StatusCode::CONFLICT, json!("stock_template"))
        );
    }
    let (status, body) = admin.call("DELETE", &stock_path, None).await;
    assert_eq!(
        (status, body["error"]["details"]["constraint"].clone()),
        (StatusCode::CONFLICT, json!("stock_template"))
    );
    assert_eq!(host_revision(&admin.app).await, rev);
    assert_eq!(audit_rows(&admin.app).await, rows);

    // It may be disabled and narrowed, its own name and layout sent along.
    let (status, narrowed) = admin
        .call(
            "PUT",
            &stock_path,
            Some(json!({
                "name": "Коробка 58×40", "spec": layout(), "enabled": false,
                "chzProductGroupCodes": [8], "expectedRev": rev
            })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{narrowed}");
    assert_eq!(
        (
            narrowed["enabled"].clone(),
            narrowed["chzProductGroupCodes"].clone(),
            narrowed["stock"].clone()
        ),
        (json!(false), json!([8]), json!(true))
    );
    assert_eq!(
        audit_trail(&admin.app, "template.update").await,
        vec![admin.row(
            "template.update",
            "template",
            &stock,
            json!({
                "changed": ["enabled", "chzProductGroupCodes"],
                "enabled": { "from": true, "to": false },
                "chzProductGroupCodes": { "from": null, "to": [8] }
            })
        )]
    );
    // A copy of its layout is an ordinary template.
    let copy = create(&admin, box_template("Коробка 58×40 (копия)")).await;
    assert_eq!(copy["stock"], json!(false));
}

#[tokio::test]
async fn a_default_is_never_disabled_narrowed_out_of_its_category_or_deleted() {
    let admin = admin().await;
    let created = create(&admin, box_template("Коробка 58×40")).await;
    let id = created["id"].as_str().unwrap().to_owned();
    let mut tx = markiro_host::db::begin_write(&admin.app.state.pool)
        .await
        .unwrap();
    let rev = markiro_host::db::next_revision(&mut tx).await.unwrap();
    sqlx::query("UPDATE org_profile SET default_box_template_id = ?, rev = ? WHERE id = 1")
        .bind(&id)
        .bind(rev)
        .execute(&mut *tx)
        .await
        .unwrap();
    for code in [15, 8] {
        sqlx::query(
            "INSERT INTO category_template_defaults (chz_group_code, purpose, template_id, rev) \
             VALUES (?, 'box', ?, ?)",
        )
        .bind(code)
        .bind(&id)
        .bind(rev)
        .execute(&mut *tx)
        .await
        .unwrap();
    }
    tx.commit().await.unwrap();
    let rows = audit_rows(&admin.app).await;

    let refusal = |organization: bool, categories: Value| {
        (
            json!("conflict"),
            json!({ "constraint": "template_is_default", "organizationDefault": organization, "categoryDefaults": categories }),
        )
    };
    let (status, body) = admin
        .call(
            "PUT",
            &path(&created),
            Some(json!({ "enabled": false, "expectedRev": 2 })),
        )
        .await;
    assert_eq!(
        (status, error(&body)),
        (StatusCode::CONFLICT, refusal(true, json!([8, 15])))
    );
    // The organization's default must cover every category.
    let (status, body) = admin
        .call(
            "PUT",
            &path(&created),
            Some(json!({ "chzProductGroupCodes": [8], "expectedRev": 2 })),
        )
        .await;
    assert_eq!(
        (status, error(&body)),
        (StatusCode::CONFLICT, refusal(true, json!([15])))
    );
    let (status, body) = admin.call("DELETE", &path(&created), None).await;
    assert_eq!(
        (status, error(&body)),
        (StatusCode::CONFLICT, refusal(true, json!([8, 15])))
    );
    assert_eq!(host_revision(&admin.app).await, rev);
    assert_eq!(audit_rows(&admin.app).await, rows);

    // Without the organization's default, the template may narrow to the
    // categories it serves, but not out of one.
    sqlx::query("UPDATE org_profile SET default_box_template_id = NULL WHERE id = 1")
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    let (status, narrowed) = admin
        .call(
            "PUT",
            &path(&created),
            Some(json!({ "chzProductGroupCodes": [8, 15], "expectedRev": 2 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{narrowed}");
    let (status, body) = admin
        .call(
            "PUT",
            &path(&created),
            Some(json!({ "chzProductGroupCodes": [8], "expectedRev": narrowed["rev"] })),
        )
        .await;
    assert_eq!(
        (status, error(&body)),
        (StatusCode::CONFLICT, refusal(false, json!([15])))
    );
}

#[tokio::test]
async fn deleting_a_template_clears_the_products_that_name_it() {
    let admin = admin().await;
    let boxes = create(&admin, box_template("Коробка 58×40")).await;
    let pallets = create(
        &admin,
        json!({ "name": "Паллета 100×150", "purpose": "pallet", "enabled": true, "spec": layout() }),
    )
    .await;
    let (status, named) = admin
        .call(
            "POST",
            "/v1/office/products",
            Some(json!({
                "gtin14": "04600682000013", "name": "Молоко",
                "defaultBoxTemplateId": boxes["id"], "defaultPalletTemplateId": pallets["id"]
            })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{named}");
    let (status, other) = admin
        .call(
            "POST",
            "/v1/office/products",
            Some(json!({ "gtin14": "04600682000020", "name": "Кефир" })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{other}");
    let before = host_revision(&admin.app).await;

    let (status, body) = admin.call("DELETE", &path(&boxes), None).await;
    assert_eq!((status, body), (StatusCode::NO_CONTENT, Value::Null));
    let rev = before + 1;
    assert_eq!(host_revision(&admin.app).await, rev);
    let (status, _) = admin.call("GET", &path(&boxes), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    // The product that named it lost that preference at the delete's
    // revision; the other is untouched.
    let mut cleared = named.clone();
    cleared["defaultBoxTemplateId"] = Value::Null;
    cleared["rev"] = json!(rev);
    let (_, products) = admin.call("GET", "/v1/office/products", None).await;
    assert_eq!(products, json!([other, cleared]));
    let mut data = cleared.clone();
    for office_only in [
        "id",
        "rev",
        "defaultPalletSheetId",
        "egaisCode",
        "defaultCounterpartyId",
        "photoChecksum",
    ] {
        data.as_object_mut().unwrap().remove(office_only);
    }
    assert_eq!(
        admin.feed(before).await,
        json!([
            { "entity": "label_templates", "id": boxes["id"], "rev": rev, "deleted": true },
            { "entity": "products", "id": named["id"], "rev": rev, "deleted": false, "data": data }
        ])
    );
    assert_eq!(
        audit_trail(&admin.app, "template.delete").await,
        vec![admin.row(
            "template.delete",
            "template",
            boxes["id"].as_str().unwrap(),
            json!({ "name": "Коробка 58×40", "purpose": "box", "productsCleared": 1 })
        )]
    );

    // Repeated after a lost answer, the delete changes nothing.
    let (status, _) = admin.call("DELETE", &path(&boxes), None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(host_revision(&admin.app).await, rev);
    assert_eq!(audit_trail(&admin.app, "template.delete").await.len(), 1);
    let (status, body) = admin
        .call(
            "DELETE",
            "/v1/office/templates/9b2e4a6c-0000-4000-8000-000000000000",
            None,
        )
        .await;
    assert_eq!(
        (status, body["error"]["code"].clone()),
        (StatusCode::NOT_FOUND, json!("not_found"))
    );
}

#[tokio::test]
async fn technologists_write_templates() {
    let admin = admin().await;
    let (tech, tech_id) = admin.technologist_session().await;
    let (status, created) = admin
        .call_as(
            &tech,
            "POST",
            "/v1/office/templates",
            Some(box_template("Коробка 58×40")),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let id = created["id"].as_str().unwrap().to_owned();
    let (status, _) = admin
        .call_as(
            &tech,
            "PUT",
            &path(&created),
            Some(json!({ "enabled": false, "expectedRev": created["rev"] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = admin.call_as(&tech, "DELETE", &path(&created), None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let trail = [
        audit_trail(&admin.app, "template.create").await,
        audit_trail(&admin.app, "template.update").await,
        audit_trail(&admin.app, "template.delete").await,
    ]
    .concat();
    assert_eq!(
        trail,
        vec![
            audit_row(
                &tech_id,
                "template.create",
                "template",
                &id,
                json!({ "name": "Коробка 58×40", "purpose": "box" })
            ),
            audit_row(
                &tech_id,
                "template.update",
                "template",
                &id,
                json!({ "changed": ["enabled"], "enabled": { "from": true, "to": false } })
            ),
            audit_row(
                &tech_id,
                "template.delete",
                "template",
                &id,
                json!({ "name": "Коробка 58×40", "purpose": "box", "productsCleared": 0 })
            ),
        ]
    );
}

#[tokio::test]
async fn an_unknown_template_is_not_found_once_its_body_is_valid() {
    let admin = admin().await;
    let path = "/v1/office/templates/9b2e4a6c-0000-4000-8000-000000000000";
    let revision = host_revision(&admin.app).await;
    let rows = audit_rows(&admin.app).await;
    let (status, _) = admin.call("GET", path, None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, body) = admin
        .call("PUT", path, Some(json!({ "name": " ", "expectedRev": 1 })))
        .await;
    assert_eq!(
        (status, body["error"]["details"]["field"].clone()),
        (StatusCode::BAD_REQUEST, json!("name"))
    );
    let (status, body) = admin
        .call(
            "PUT",
            path,
            Some(json!({ "enabled": false, "expectedRev": 1 })),
        )
        .await;
    assert_eq!(
        (status, body["error"]["code"].clone()),
        (StatusCode::NOT_FOUND, json!("not_found"))
    );
    assert_eq!(host_revision(&admin.app).await, revision);
    assert_eq!(audit_rows(&admin.app).await, rows);
}

// Beyond the plan. The review of the catalog rights asked for a proof, route
// by route, that every write rechecks the session inside its own transaction,
// and for a stale revision on both sides. A mutant run of the template routes
// then found each rule below unpinned by the plan's own tests.

/// A template written straight into its table, so that its id, name and
/// purpose are the test's choice (the routes draw a new id each time); it is
/// enabled, for every category and not a stock template. Returns its revision.
async fn insert_template(app: &TestApp, id: &str, name: &str, purpose: &str) -> i64 {
    let mut tx = markiro_host::db::begin_write(&app.state.pool)
        .await
        .unwrap();
    let rev = markiro_host::db::next_revision(&mut tx).await.unwrap();
    sqlx::query(
        "INSERT INTO label_templates (id, name, purpose, enabled, spec, stock, rev) \
         VALUES (?, ?, ?, 1, ?, 0, ?)",
    )
    .bind(id)
    .bind(name)
    .bind(purpose)
    .bind(layout().to_string())
    .bind(rev)
    .execute(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();
    rev
}

/// `id` made a default of `purpose`: the organization's, through `column` of
/// its profile when one is given, and each of `categories`'.
async fn make_default(
    app: &TestApp,
    id: &str,
    purpose: &str,
    column: Option<&str>,
    categories: &[u32],
) {
    let mut tx = markiro_host::db::begin_write(&app.state.pool)
        .await
        .unwrap();
    let rev = markiro_host::db::next_revision(&mut tx).await.unwrap();
    if let Some(column) = column {
        sqlx::query(&format!(
            "UPDATE org_profile SET {column} = ?, rev = ? WHERE id = 1"
        ))
        .bind(id)
        .bind(rev)
        .execute(&mut *tx)
        .await
        .unwrap();
    }
    for code in categories {
        sqlx::query(
            "INSERT INTO category_template_defaults (chz_group_code, purpose, template_id, rev) \
             VALUES (?, ?, ?, ?)",
        )
        .bind(code)
        .bind(purpose)
        .bind(id)
        .bind(rev)
        .execute(&mut *tx)
        .await
        .unwrap();
    }
    tx.commit().await.unwrap();
}

/// What a template that is a default answers to a change that would break the
/// default: `conflict` on `template_is_default`, naming the defaults in the way.
fn default_refusal(organization: bool, categories: Value) -> (Value, Value) {
    (
        json!("conflict"),
        json!({
            "constraint": "template_is_default",
            "organizationDefault": organization,
            "categoryDefaults": categories
        }),
    )
}

/// The template routes call `require_catalog_in` themselves, not only the
/// helper (`products.rs` proves the helper): a technologist is turned off
/// after the extractor read them as active and before the write transaction
/// begins. A trigger does it at the moment the extractor records the session's
/// activity (it does once a minute), so the order is the same on every run.
/// Each write is refused as an ended session. The session is still there
/// afterwards, which the extractor would not leave behind a user it found
/// turned off, so the refusal is the route's own; nothing else changed.
#[tokio::test]
async fn template_writes_stop_a_user_turned_off_after_the_extractor_passed() {
    let admin = admin().await;
    let (tech, tech_id) = admin.technologist_session().await;
    let template = create(&admin, box_template("Коробка 58×40")).await;
    let session_id: String = sqlx::query_scalar("SELECT id FROM office_sessions WHERE user_id = ?")
        .bind(&tech_id)
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    let revision = host_revision(&admin.app).await;
    let rows = audit_rows(&admin.app).await;
    turn_the_user_off_at_the_next_activity(&admin.app, &tech_id).await;

    for (method, route, body) in [
        (
            "POST",
            "/v1/office/templates".to_owned(),
            Some(box_template("Другая коробка")),
        ),
        (
            "PUT",
            path(&template),
            Some(json!({ "enabled": false, "expectedRev": template["rev"] })),
        ),
        ("DELETE", path(&template), None),
    ] {
        // Let a minute pass, so that the extractor records activity, and turn
        // the user back on for this round.
        admin.app.clock.advance(time::Duration::minutes(2));
        sqlx::query("UPDATE office_users SET active = 1 WHERE id = ?")
            .bind(&tech_id)
            .execute(&admin.app.state.pool)
            .await
            .unwrap();
        let (status, error) = admin.call_as(&tech, method, &route, body).await;
        assert_eq!(
            (
                status,
                error["error"]["code"].clone(),
                error["error"]["details"]["credential"].clone()
            ),
            (
                StatusCode::UNAUTHORIZED,
                json!("unauthorized"),
                json!("session")
            ),
            "{method}"
        );
        let active: i64 = sqlx::query_scalar("SELECT active FROM office_users WHERE id = ?")
            .bind(&tech_id)
            .fetch_one(&admin.app.state.pool)
            .await
            .unwrap();
        assert_eq!(active, 0, "the trigger ran after the extractor: {method}");
        let sessions: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM office_sessions WHERE id = ?")
            .bind(&session_id)
            .fetch_one(&admin.app.state.pool)
            .await
            .unwrap();
        assert_eq!(
            sessions, 1,
            "the refusal is the route's, not the extractor's: {method}"
        );
        assert_eq!(host_revision(&admin.app).await, revision, "{method}");
        assert_eq!(audit_rows(&admin.app).await, rows, "{method}");
    }
}

/// A `PUT` over a revision that is not the template's is stale whichever side
/// it errs on: one older than the record (it changed since it was read) and
/// one ahead of it (a client that never read it). Each answers the record's
/// own revision and writes nothing.
#[tokio::test]
async fn a_put_over_a_revision_older_or_ahead_of_the_template_is_stale() {
    let admin = admin().await;
    let created = create(&admin, box_template("Коробка 58×40")).await;
    let (status, renamed) = admin
        .call(
            "PUT",
            &path(&created),
            Some(json!({ "name": "Коробка 58×40 новая", "expectedRev": created["rev"] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{renamed}");
    let rev = renamed["rev"].as_i64().unwrap();
    let revision = host_revision(&admin.app).await;
    let rows = audit_rows(&admin.app).await;
    for (side, expected_rev) in [("older", rev - 1), ("ahead", rev + 1)] {
        let (status, body) = admin
            .call(
                "PUT",
                &path(&created),
                Some(json!({ "enabled": false, "expectedRev": expected_rev })),
            )
            .await;
        assert_eq!(
            (
                status,
                body["error"]["code"].clone(),
                body["error"]["details"]["currentRev"].clone()
            ),
            (StatusCode::CONFLICT, json!("stale_revision"), json!(rev)),
            "{side}"
        );
        assert_eq!(host_revision(&admin.app).await, revision, "{side}");
        assert_eq!(audit_rows(&admin.app).await, rows, "{side}");
        let (_, read) = admin.call("GET", &path(&created), None).await;
        assert_eq!(read, renamed, "{side}");
    }
}

/// Templates are listed by name byte for byte (so «Zeta» stands before
/// «alpha» and a Cyrillic capital before a small letter), then by id. They are
/// written in the opposite order, so the order they were stored in cannot pass
/// for the right one.
#[tokio::test]
async fn templates_are_listed_by_name_bytewise_then_by_id() {
    let admin = admin().await;
    let listed = [
        ("00000000-0000-4000-8000-000000000001", "Zeta"),
        ("00000000-0000-4000-8000-000000000002", "alpha"),
        ("00000000-0000-4000-8000-000000000003", "Молоко"),
        ("00000000-0000-4000-8000-000000000004", "Молоко"),
        ("00000000-0000-4000-8000-000000000005", "Яблоко"),
        ("00000000-0000-4000-8000-000000000006", "апельсин"),
    ];
    for (id, name) in listed.iter().rev() {
        insert_template(&admin.app, id, name, "box").await;
    }
    let (status, list) = admin.call("GET", "/v1/office/templates", None).await;
    assert_eq!(status, StatusCode::OK, "{list}");
    let stored: Vec<(&str, &str)> = list
        .as_array()
        .unwrap()
        .iter()
        .map(|template| {
            (
                template["id"].as_str().unwrap(),
                template["name"].as_str().unwrap(),
            )
        })
        .collect();
    assert_eq!(stored, listed);
}

/// A `PUT` is checked as a `POST` is, field by field: the name, the
/// categories (a repeat, an empty list, a code that is no product group) and
/// the layout. A check that fails writes nothing.
#[tokio::test]
async fn an_update_is_checked_like_a_create() {
    let admin = admin().await;
    let created = create(&admin, box_template("Коробка 58×40")).await;
    let revision = host_revision(&admin.app).await;
    let rows = audit_rows(&admin.app).await;
    for (field, value) in [
        ("name", json!(" ")),
        ("name", json!("ш".repeat(201))),
        ("name", json!("Коробка\t58×40")),
        ("chzProductGroupCodes", json!([])),
        ("chzProductGroupCodes", json!([8, 8])),
        // 18 is not a ЧЗ product group.
        ("chzProductGroupCodes", json!([8, 18])),
        ("spec", json!([])),
        ("spec", json!("{}")),
        ("spec", json!({ "filler": "x".repeat(262_144) })),
    ] {
        let mut body = json!({ "expectedRev": created["rev"] });
        body[field] = value;
        let (status, refused) = admin.call("PUT", &path(&created), Some(body)).await;
        assert_eq!(
            (status, refused["error"]["details"]["field"].clone()),
            (StatusCode::BAD_REQUEST, json!(field)),
            "{field}"
        );
    }
    assert_eq!(host_revision(&admin.app).await, revision);
    assert_eq!(audit_rows(&admin.app).await, rows);
    let (_, read) = admin.call("GET", &path(&created), None).await;
    assert_eq!(read, created);
}

/// `chzProductGroupCodes: null` widens a template to every category, and a
/// `PUT` that leaves the field out keeps the categories it has.
#[tokio::test]
async fn null_widens_a_template_to_every_category_and_a_missing_field_keeps_them() {
    let admin = admin().await;
    let mut body = box_template("Коробка 58×40");
    body["chzProductGroupCodes"] = json!([8, 15]);
    let created = create(&admin, body).await;
    let id = created["id"].as_str().unwrap().to_owned();
    assert_eq!(created["chzProductGroupCodes"], json!([8, 15]));
    let (status, disabled) = admin
        .call(
            "PUT",
            &path(&created),
            Some(json!({ "enabled": false, "expectedRev": created["rev"] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{disabled}");
    assert_eq!(disabled["chzProductGroupCodes"], json!([8, 15]));
    let (status, widened) = admin
        .call(
            "PUT",
            &path(&created),
            Some(json!({ "chzProductGroupCodes": null, "expectedRev": disabled["rev"] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{widened}");
    assert_eq!(
        (
            widened["chzProductGroupCodes"].clone(),
            widened["enabled"].clone()
        ),
        (Value::Null, json!(false))
    );
    // The list is read as itself: an error body indexes to `null` too.
    let (status, list) = admin.call("GET", "/v1/office/templates", None).await;
    assert_eq!(status, StatusCode::OK, "{list}");
    assert_eq!(list[0]["id"], json!(id));
    assert_eq!(list[0]["chzProductGroupCodes"], Value::Null);
    assert_eq!(
        audit_trail(&admin.app, "template.update").await,
        vec![
            admin.row(
                "template.update",
                "template",
                &id,
                json!({ "changed": ["enabled"], "enabled": { "from": true, "to": false } })
            ),
            admin.row(
                "template.update",
                "template",
                &id,
                json!({
                    "changed": ["chzProductGroupCodes"],
                    "chzProductGroupCodes": { "from": [8, 15], "to": null }
                })
            ),
        ]
    );
}

/// The organization's default of each purpose is held by its own column of
/// the profile: a box template by `default_box_template_id`, a pallet one by
/// `default_pallet_template_id`, a duplicate one by
/// `default_duplicate_template_id`. A default of the organization alone has no
/// categories to list, and is refused all the same.
#[tokio::test]
async fn the_organizations_default_of_every_purpose_is_protected_by_its_own_column() {
    let admin = admin().await;
    for (n, (purpose, column)) in [
        ("box", "default_box_template_id"),
        ("pallet", "default_pallet_template_id"),
        ("product_duplicate", "default_duplicate_template_id"),
    ]
    .into_iter()
    .enumerate()
    {
        let id = format!("00000000-0000-4000-8000-00000000000{n}");
        let rev = insert_template(&admin.app, &id, "Шаблон", purpose).await;
        make_default(&admin.app, &id, purpose, Some(column), &[]).await;
        let revision = host_revision(&admin.app).await;
        let rows = audit_rows(&admin.app).await;
        let route = format!("/v1/office/templates/{id}");
        for (change, method, body) in [
            (
                "disable",
                "PUT",
                Some(json!({ "enabled": false, "expectedRev": rev })),
            ),
            (
                "narrow",
                "PUT",
                Some(json!({ "chzProductGroupCodes": [8], "expectedRev": rev })),
            ),
            ("delete", "DELETE", None),
        ] {
            let (status, refused) = admin.call(method, &route, body).await;
            assert_eq!(
                (status, error(&refused)),
                (StatusCode::CONFLICT, default_refusal(true, json!([]))),
                "{purpose} {change}"
            );
        }
        assert_eq!(host_revision(&admin.app).await, revision, "{purpose}");
        assert_eq!(audit_rows(&admin.app).await, rows, "{purpose}");
    }
}

/// A category's default alone, with no default of the organization, holds its
/// template: it is neither disabled nor deleted.
#[tokio::test]
async fn a_category_default_alone_protects_its_template() {
    let admin = admin().await;
    let created = create(&admin, box_template("Коробка 58×40")).await;
    let id = created["id"].as_str().unwrap().to_owned();
    make_default(&admin.app, &id, "box", None, &[15, 8]).await;
    let revision = host_revision(&admin.app).await;
    let rows = audit_rows(&admin.app).await;
    for (change, method, body) in [
        (
            "disable",
            "PUT",
            Some(json!({ "enabled": false, "expectedRev": created["rev"] })),
        ),
        ("delete", "DELETE", None),
    ] {
        let (status, refused) = admin.call(method, &path(&created), body).await;
        assert_eq!(
            (status, error(&refused)),
            (StatusCode::CONFLICT, default_refusal(false, json!([8, 15]))),
            "{change}"
        );
    }
    assert_eq!(host_revision(&admin.app).await, revision);
    assert_eq!(audit_rows(&admin.app).await, rows);
}

/// A stock template may be disabled and narrowed only where no default stands
/// in the way: the defaults check is the same as for any other template, and
/// a delete of it is the stock rule's refusal first.
#[tokio::test]
async fn a_stock_template_that_is_a_default_is_protected_as_one() {
    let admin = admin().await;
    let (stock, rev) = insert_stock(&admin.app).await;
    make_default(
        &admin.app,
        &stock,
        "box",
        Some("default_box_template_id"),
        &[8],
    )
    .await;
    let revision = host_revision(&admin.app).await;
    let rows = audit_rows(&admin.app).await;
    let route = format!("/v1/office/templates/{stock}");
    for change in [
        json!({ "enabled": false, "expectedRev": rev }),
        json!({ "chzProductGroupCodes": [15], "expectedRev": rev }),
    ] {
        let (status, refused) = admin.call("PUT", &route, Some(change)).await;
        assert_eq!(
            (status, error(&refused)),
            (StatusCode::CONFLICT, default_refusal(true, json!([8])))
        );
    }
    let (status, refused) = admin.call("DELETE", &route, None).await;
    assert_eq!(
        (status, refused["error"]["details"]["constraint"].clone()),
        (StatusCode::CONFLICT, json!("stock_template"))
    );
    assert_eq!(host_revision(&admin.app).await, revision);
    assert_eq!(audit_rows(&admin.app).await, rows);
}

/// Deleting a pallet template clears the pallet preference of every product
/// that names it, an archived one included, and leaves a box preference
/// where a product has one; each product it clears takes the delete's
/// revision and rides the feed after the template's tombstone.
#[tokio::test]
async fn deleting_a_pallet_template_clears_the_pallet_preference_of_every_product_naming_it() {
    let admin = admin().await;
    let boxes = create(&admin, box_template("Коробка 58×40")).await;
    let pallets = create(
        &admin,
        json!({ "name": "Паллета 100×150", "purpose": "pallet", "enabled": true, "spec": layout() }),
    )
    .await;
    let mut records = Vec::new();
    for body in [
        json!({
            "gtin14": "04600682000013", "name": "Молоко",
            "defaultBoxTemplateId": boxes["id"], "defaultPalletTemplateId": pallets["id"]
        }),
        json!({ "gtin14": "04600682000020", "name": "Кефир", "defaultPalletTemplateId": pallets["id"] }),
        json!({ "gtin14": "04600682000037", "name": "Сметана", "defaultBoxTemplateId": boxes["id"] }),
        json!({ "gtin14": "04600682000044", "name": "Ряженка", "defaultPalletTemplateId": pallets["id"] }),
    ] {
        let (status, record) = admin.call("POST", "/v1/office/products", Some(body)).await;
        assert_eq!(status, StatusCode::OK, "{record}");
        records.push(record);
    }
    let (status, archived) = admin
        .call(
            "PUT",
            &format!("/v1/office/products/{}", records[3]["id"].as_str().unwrap()),
            Some(json!({
                "gtin14": "04600682000044", "name": "Ряженка",
                "defaultPalletTemplateId": pallets["id"], "archived": true,
                "expectedRev": records[3]["rev"]
            })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{archived}");
    let before = host_revision(&admin.app).await;

    let (status, body) = admin.call("DELETE", &path(&pallets), None).await;
    assert_eq!((status, body), (StatusCode::NO_CONTENT, Value::Null));
    let rev = before + 1;
    assert_eq!(host_revision(&admin.app).await, rev);
    let cleared = |record: &Value| {
        let mut cleared = record.clone();
        cleared["defaultPalletTemplateId"] = Value::Null;
        cleared["rev"] = json!(rev);
        cleared
    };
    // Products in use come first, by name; the archived one last.
    let (_, products) = admin.call("GET", "/v1/office/products", None).await;
    assert_eq!(
        products,
        json!([
            cleared(&records[1]),
            cleared(&records[0]),
            records[2],
            cleared(&archived)
        ])
    );
    assert_eq!(products[1]["defaultBoxTemplateId"], boxes["id"]);
    let feed = admin.feed(before).await;
    let items = feed.as_array().unwrap();
    assert_eq!(items.len(), 4, "{feed}");
    assert_eq!(
        items[0],
        json!({ "entity": "label_templates", "id": pallets["id"], "rev": rev, "deleted": true })
    );
    let mut ids: Vec<&str> = items[1..]
        .iter()
        .map(|item| {
            assert_eq!(
                (
                    item["entity"].clone(),
                    item["rev"].clone(),
                    item["deleted"].clone(),
                    item["data"]["defaultPalletTemplateId"].clone()
                ),
                (json!("products"), json!(rev), json!(false), Value::Null)
            );
            item["id"].as_str().unwrap()
        })
        .collect();
    ids.sort_unstable();
    let mut cleared_ids =
        [&records[0], &records[1], &archived].map(|record| record["id"].as_str().unwrap());
    cleared_ids.sort_unstable();
    assert_eq!(ids, cleared_ids);
    assert_eq!(
        audit_trail(&admin.app, "template.delete").await,
        vec![admin.row(
            "template.delete",
            "template",
            pallets["id"].as_str().unwrap(),
            json!({ "name": "Паллета 100×150", "purpose": "pallet", "productsCleared": 3 })
        )]
    );
}

/// Every office role reads templates, the list and one; without an office
/// session (a device key alone) neither is answered.
#[tokio::test]
async fn templates_are_read_by_every_role_and_only_with_an_office_session() {
    let admin = admin().await;
    let tech = admin.technologist().await;
    let created = create(&admin, box_template("Коробка 58×40")).await;
    for token in [admin.token.clone(), tech] {
        let (status, list) = admin
            .call_as(&token, "GET", "/v1/office/templates", None)
            .await;
        assert_eq!(status, StatusCode::OK, "{list}");
        assert_eq!(list.as_array().unwrap().len(), 1);
        let (status, read) = admin.call_as(&token, "GET", &path(&created), None).await;
        assert_eq!((status, read), (StatusCode::OK, created.clone()));
    }
    for route in ["/v1/office/templates".to_owned(), path(&created)] {
        let (status, body) = admin
            .app
            .send(support::app::empty(support::app::with_device(
                support::app::request("GET", &route),
                &admin.key,
            )))
            .await;
        assert_eq!(
            (status, body["error"]["details"]["credential"].clone()),
            (StatusCode::UNAUTHORIZED, json!("session")),
            "{route}"
        );
    }
}

/// A template is stored with the purpose and the state it is created with, a
/// duplicate template included, and the list reads both back.
#[tokio::test]
async fn a_template_is_created_with_the_purpose_and_state_it_is_sent_with() {
    let admin = admin().await;
    let mut expected = Vec::new();
    for purpose in ["box", "pallet", "product_duplicate"] {
        for enabled in [true, false] {
            let name = format!("{purpose} {enabled}");
            let created = create(
                &admin,
                json!({ "name": name, "purpose": purpose, "enabled": enabled, "spec": layout() }),
            )
            .await;
            assert_eq!(
                (created["purpose"].clone(), created["enabled"].clone()),
                (json!(purpose), json!(enabled)),
                "{name}"
            );
            expected.push((name, purpose.to_owned(), enabled));
        }
    }
    expected.sort();
    let (_, list) = admin.call("GET", "/v1/office/templates", None).await;
    let listed: Vec<(String, String, bool)> = list
        .as_array()
        .unwrap()
        .iter()
        .map(|template| {
            (
                template["name"].as_str().unwrap().to_owned(),
                template["purpose"].as_str().unwrap().to_owned(),
                template["enabled"].as_bool().unwrap(),
            )
        })
        .collect();
    assert_eq!(listed, expected);
}

/// Only a change that would leave a default unfit is refused: enabling a
/// template that stands as a default without fitting its slot repairs it. (The
/// routes keep such a state from arising, so it is written by hand here.)
#[tokio::test]
async fn a_change_that_leaves_a_default_fit_is_not_refused() {
    let admin = admin().await;
    let id = "00000000-0000-4000-8000-000000000001";
    let rev = insert_template(&admin.app, id, "Коробка 58×40", "box").await;
    sqlx::query("UPDATE label_templates SET enabled = 0 WHERE id = ?")
        .bind(id)
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    make_default(
        &admin.app,
        id,
        "box",
        Some("default_box_template_id"),
        &[8, 15],
    )
    .await;
    let (status, enabled) = admin
        .call(
            "PUT",
            &format!("/v1/office/templates/{id}"),
            Some(json!({ "enabled": true, "expectedRev": rev })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{enabled}");
    assert_eq!(enabled["enabled"], json!(true));
}

/// Every template write that takes a revision announces it to the streams
/// once it has committed, as every writer does
/// (`every_revision_bump_wakes_subscribers_after_its_commit`); a refusal, a
/// no-op and a delete repeated after a lost answer announce nothing.
#[tokio::test]
async fn template_writes_wake_the_streams_with_their_revision() {
    let admin = admin().await;
    let latest = || *admin.app.state.revisions.borrow();
    let created = create(&admin, box_template("Коробка 58×40")).await;
    assert_eq!(latest(), created["rev"].as_i64().unwrap(), "create");
    let (status, updated) = admin
        .call(
            "PUT",
            &path(&created),
            Some(json!({ "enabled": false, "expectedRev": created["rev"] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{updated}");
    assert_eq!(latest(), updated["rev"].as_i64().unwrap(), "update");
    // A no-op and a stale update take no revision and wake nobody; each is
    // answered as it should be (a 500 would wake nobody either).
    for (expected_rev, expected_status) in [
        (updated["rev"].as_i64().unwrap(), StatusCode::OK),
        (created["rev"].as_i64().unwrap(), StatusCode::CONFLICT),
    ] {
        let (status, body) = admin
            .call(
                "PUT",
                &path(&created),
                Some(json!({ "enabled": false, "expectedRev": expected_rev })),
            )
            .await;
        assert_eq!(status, expected_status, "{expected_rev}: {body}");
        assert_eq!(latest(), updated["rev"].as_i64().unwrap(), "{expected_rev}");
    }
    let (status, _) = admin.call("DELETE", &path(&created), None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(latest(), host_revision(&admin.app).await, "delete");
    assert_eq!(latest(), updated["rev"].as_i64().unwrap() + 1, "delete");
    let (status, _) = admin.call("DELETE", &path(&created), None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(latest(), updated["rev"].as_i64().unwrap() + 1, "repeat");
}

/// The host keeps a layout of exactly 256 KiB of compact JSON, as the table's
/// own `CHECK` does, and refuses one byte more: a `POST` and a `PUT` alike.
/// (The unit test measures the limit by `MAX_SPEC_BYTES` itself, so only this
/// one pins its value and its agreement with the table.)
#[tokio::test]
async fn a_layout_of_exactly_256_kib_is_kept_and_one_byte_more_is_refused() {
    let admin = admin().await;
    // `{"f":"…"}` is 8 bytes longer than the text it holds.
    let filler = |bytes: usize| json!({ "f": "x".repeat(bytes - 8) });
    let mut body = box_template("Коробка 58×40");
    body["spec"] = filler(262_144);
    let created = create(&admin, body).await;
    let stored: i64 = sqlx::query_scalar("SELECT length(CAST(spec AS BLOB)) FROM label_templates")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    assert_eq!(stored, 262_144);
    let revision = host_revision(&admin.app).await;
    let rows = audit_rows(&admin.app).await;
    let mut body = box_template("Коробка 58×40 (больше)");
    body["spec"] = filler(262_145);
    let (status, refused) = admin.call("POST", "/v1/office/templates", Some(body)).await;
    assert_eq!(
        (status, refused["error"]["details"]["field"].clone()),
        (StatusCode::BAD_REQUEST, json!("spec"))
    );
    let (status, refused) = admin
        .call(
            "PUT",
            &path(&created),
            Some(json!({ "spec": filler(262_145), "expectedRev": created["rev"] })),
        )
        .await;
    assert_eq!(
        (status, refused["error"]["details"]["field"].clone()),
        (StatusCode::BAD_REQUEST, json!("spec"))
    );
    assert_eq!(host_revision(&admin.app).await, revision);
    assert_eq!(audit_rows(&admin.app).await, rows);
}

// Fix round 1, from the review of this task: a layout the host accepts must
// not break what reads it back, the list for everybody (a resolution above
// `i64::MAX`, the summary test above) and every station's feed (a layout
// nested too deeply, below).

use http_body_util::BodyExt;
use tower::ServiceExt;

/// A layout nests at most 64 levels (`MAX_SPEC_DEPTH`; an object or an array
/// is a level, a scalar none): a feed page wraps it in four more, and the
/// station reads every host answer with `serde_json::from_slice`, which stops
/// at 127. Exactly 64 levels are kept, by a `POST` and a `PUT` alike; one level
/// more is refused as `spec` and writes nothing. (Literals, not the constant,
/// so that this pins the bound itself.)
#[tokio::test]
async fn a_layout_nested_64_levels_is_kept_and_one_level_more_is_refused() {
    let admin = admin().await;
    let mut body = box_template("Коробка 58×40");
    body["spec"] = nested(64);
    let created = create(&admin, body).await;
    assert_eq!(created["spec"], nested(64));
    let (status, read) = admin.call("GET", &path(&created), None).await;
    assert_eq!((status, read["spec"].clone()), (StatusCode::OK, nested(64)));
    let other = create(&admin, box_template("Коробка 58×40 (другая)")).await;
    let revision = host_revision(&admin.app).await;
    let rows = audit_rows(&admin.app).await;

    let refused_as_spec = |status: StatusCode, body: &Value| {
        (
            status,
            body["error"]["code"].clone(),
            body["error"]["details"]["field"].clone(),
        )
    };
    let mut body = box_template("Коробка 58×40 (глубже)");
    body["spec"] = nested(65);
    let (status, refused) = admin.call("POST", "/v1/office/templates", Some(body)).await;
    assert_eq!(
        refused_as_spec(status, &refused),
        (
            StatusCode::BAD_REQUEST,
            json!("validation_failed"),
            json!("spec")
        ),
        "POST"
    );
    let (status, refused) = admin
        .call(
            "PUT",
            &path(&other),
            Some(json!({ "spec": nested(65), "expectedRev": other["rev"] })),
        )
        .await;
    assert_eq!(
        refused_as_spec(status, &refused),
        (
            StatusCode::BAD_REQUEST,
            json!("validation_failed"),
            json!("spec")
        ),
        "PUT"
    );
    assert_eq!(host_revision(&admin.app).await, revision);
    assert_eq!(audit_rows(&admin.app).await, rows);

    let (status, updated) = admin
        .call(
            "PUT",
            &path(&other),
            Some(json!({ "spec": nested(64), "expectedRev": other["rev"] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{updated}");
    assert_eq!(updated["spec"], nested(64));
}

/// A real layout's shape: shallow keys (`widthMm`, `dpi`, `language`) on both
/// sides of the one branch that nests, `elements`; `levels` levels in all.
fn layout_nested(levels: usize) -> Value {
    let mut spec = layout();
    spec["elements"] = json!([nested(levels - 2)]);
    spec
}

/// The depth of a layout is its deepest branch's, not the shallowest
/// sibling's: a layout with its usual shallow keys beside a branch that nests
/// is kept at 64 levels, by a `POST` and a `PUT` alike, and refused at 65. (The
/// single-chain case above cannot tell the two measures apart.)
#[tokio::test]
async fn a_deep_branch_beside_shallow_keys_counts_by_its_own_depth() {
    let admin = admin().await;
    let mut body = box_template("Коробка 58×40");
    body["spec"] = layout_nested(64);
    let created = create(&admin, body).await;
    assert_eq!(created["spec"], layout_nested(64));
    let other = create(&admin, box_template("Коробка 58×40 (другая)")).await;
    let revision = host_revision(&admin.app).await;
    let rows = audit_rows(&admin.app).await;

    let mut body = box_template("Коробка 58×40 (глубже)");
    body["spec"] = layout_nested(65);
    let (status, refused) = admin.call("POST", "/v1/office/templates", Some(body)).await;
    assert_eq!(
        (status, refused["error"]["details"]["field"].clone()),
        (StatusCode::BAD_REQUEST, json!("spec")),
        "POST"
    );
    let (status, refused) = admin
        .call(
            "PUT",
            &path(&other),
            Some(json!({ "spec": layout_nested(65), "expectedRev": other["rev"] })),
        )
        .await;
    assert_eq!(
        (status, refused["error"]["details"]["field"].clone()),
        (StatusCode::BAD_REQUEST, json!("spec")),
        "PUT"
    );
    assert_eq!(host_revision(&admin.app).await, revision);
    assert_eq!(audit_rows(&admin.app).await, rows);

    let (status, updated) = admin
        .call(
            "PUT",
            &path(&other),
            Some(json!({ "spec": layout_nested(64), "expectedRev": other["rev"] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{updated}");
    assert_eq!(updated["spec"], layout_nested(64));
}

/// The feed page that carries a layout at the bound parses back as the
/// station shell parses every host answer, with `serde_json::from_slice` (127
/// levels at most): the page wraps the layout in four more levels, which the
/// bound leaves room for. A layout the page could not carry would be refetched
/// from the same revision for ever, and no later change would reach any
/// station.
#[tokio::test]
async fn a_layout_at_the_depth_bound_travels_in_a_feed_page_the_station_can_parse() {
    let admin = admin().await;
    let mut body = box_template("Коробка 58×40");
    body["spec"] = nested(markiro_host::validate::MAX_SPEC_DEPTH);
    let created = create(&admin, body).await;
    let request = support::app::empty(support::app::with_device(
        support::app::request("GET", "/v1/changes?since=1"),
        &admin.key,
    ));
    let response = markiro_host::server::router(admin.app.state.clone())
        .oneshot(request)
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let page: Value =
        serde_json::from_slice(&bytes).expect("a page the station shell can parse back");
    assert_eq!(page["items"][0]["id"], created["id"]);
    assert_eq!(
        page["items"][0]["data"]["spec"],
        nested(markiro_host::validate::MAX_SPEC_DEPTH)
    );
}
