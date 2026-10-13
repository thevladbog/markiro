mod support;

use axum::http::StatusCode;
use markiro_host::auth::OfficeContext;
use serde_json::{json, Value};
use support::app::{
    admin, audit_row, audit_rows, audit_trail, empty, host_revision, request,
    turn_the_user_off_at_the_next_activity, with_device, Admin, TestApp,
};

/// A new product as the office's form sends it, with blanks to trim.
fn milk() -> Value {
    json!({
        "gtin14": " 04600682000013 ",
        "name": " Молоко 3,2% 0,9 л ",
        "printName": " Молоко 3,2% ",
        "chzProductGroupCode": 8,
        "boxCapacity": 12,
        "palletBoxCapacity": 40,
        "shelfLifeDays": 10
    })
}

/// The record `milk()` creates.
fn milk_record(id: &str, rev: i64) -> Value {
    json!({
        "id": id, "gtin14": "04600682000013", "name": "Молоко 3,2% 0,9 л", "printName": "Молоко 3,2%",
        "chzProductGroupCode": 8, "boxCapacity": 12, "palletBoxCapacity": 40, "shelfLifeDays": 10,
        "defaultBoxTemplateId": null, "defaultPalletTemplateId": null,
        "defaultPalletSheetId": null,
        "egaisCode": null, "defaultCounterpartyId": null, "photoChecksum": null,
        "archived": false, "status": "active", "rev": rev
    })
}

/// A beer product (ЧЗ group 15) with an EGAIS code to trim.
fn beer() -> Value {
    json!({
        "gtin14": "04607001234560", "name": "Пиво светлое 0,5 л",
        "chzProductGroupCode": 15, "boxCapacity": 20, "palletBoxCapacity": 60,
        "egaisCode": " 0150320000001234567 "
    })
}

/// A counterparty of the office's; returns its record.
async fn counterparty(admin: &Admin, name: &str, gln: &str) -> Value {
    let (status, created) = admin
        .call(
            "POST",
            "/v1/office/counterparties",
            Some(json!({ "name": name, "gln": gln, "gs1Prefixes": [] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    created
}

/// A `PUT` body: every field of `record`, over `expected_rev`.
fn full(record: &Value, expected_rev: i64) -> Value {
    let mut body = record.clone();
    let fields = body.as_object_mut().unwrap();
    for computed in ["id", "status", "rev", "photoChecksum"] {
        fields.remove(computed);
    }
    fields.insert("expectedRev".to_owned(), json!(expected_rev));
    body
}

async fn create(admin: &Admin, body: Value) -> Value {
    let (status, created) = admin.call("POST", "/v1/office/products", Some(body)).await;
    assert_eq!(status, StatusCode::OK, "{created}");
    created
}

fn path(product: &Value) -> String {
    format!("/v1/office/products/{}", product["id"].as_str().unwrap())
}

fn constraint(body: &Value) -> Value {
    body["error"]["details"]["constraint"].clone()
}

/// A template written straight into its table (the template routes come
/// with rules of their own); returns its id.
async fn insert_template(
    app: &TestApp,
    purpose: &str,
    enabled: bool,
    codes: Option<&str>,
) -> String {
    let mut tx = markiro_host::db::begin_write(&app.state.pool)
        .await
        .unwrap();
    let rev = markiro_host::db::next_revision(&mut tx).await.unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO label_templates (id, name, purpose, enabled, category_codes, spec, rev) \
         VALUES (?, 'Шаблон', ?, ?, ?, '{}', ?)",
    )
    .bind(&id)
    .bind(purpose)
    .bind(enabled)
    .bind(codes)
    .bind(rev)
    .execute(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();
    id
}

#[tokio::test]
async fn an_administrator_creates_lists_and_updates_products() {
    let admin = admin().await;
    let created = create(&admin, milk()).await;
    let id = created["id"].as_str().unwrap().to_owned();
    // The wizard took revision 1.
    assert_eq!(created, milk_record(&id, 2));
    assert_eq!(
        audit_trail(&admin.app, "product.create").await,
        vec![admin.row(
            "product.create",
            "product",
            &id,
            json!({ "gtin14": "04600682000013", "name": "Молоко 3,2% 0,9 л" })
        )]
    );
    let (status, list) = admin.call("GET", "/v1/office/products", None).await;
    assert_eq!((status, list), (StatusCode::OK, json!([created.clone()])));
    // Stations get the product without the office's id and revision fields.
    let mut data = full(&created, 0);
    data.as_object_mut().unwrap().remove("expectedRev");
    // The preferred A4 sheet is the office's only: no station prints from it;
    // nor from the EGAIS code (a shift freezes it in its snapshot) or the
    // default counterparty (plan ТОВ).
    for office_only in ["defaultPalletSheetId", "egaisCode", "defaultCounterpartyId"] {
        data.as_object_mut().unwrap().remove(office_only);
    }
    data["status"] = json!("active");
    assert_eq!(
        admin.feed(1).await,
        json!([{ "entity": "products", "id": id, "rev": 2, "deleted": false, "data": data }])
    );

    let mut change = full(&created, 2);
    change["printName"] = Value::Null;
    change["palletBoxCapacity"] = json!(48);
    change["archived"] = json!(true);
    let (status, updated) = admin
        .call("PUT", &path(&created), Some(change.clone()))
        .await;
    assert_eq!(status, StatusCode::OK, "{updated}");
    assert_eq!(
        (
            updated["printName"].clone(),
            updated["palletBoxCapacity"].clone(),
            updated["archived"].clone(),
            updated["rev"].clone()
        ),
        (Value::Null, json!(48), json!(true), json!(3))
    );
    assert_eq!(
        audit_trail(&admin.app, "product.update").await,
        vec![admin.row(
            "product.update",
            "product",
            &id,
            json!({
                "changed": ["printName", "palletBoxCapacity", "archived"],
                "printName": { "from": "Молоко 3,2%", "to": null },
                "palletBoxCapacity": { "from": 40, "to": 48 },
                "archived": { "from": false, "to": true }
            })
        )]
    );

    // The same values again change nothing.
    change["expectedRev"] = json!(3);
    let (status, same) = admin.call("PUT", &path(&created), Some(change)).await;
    assert_eq!((status, same), (StatusCode::OK, updated));
    assert_eq!(host_revision(&admin.app).await, 3);
    assert_eq!(audit_trail(&admin.app, "product.update").await.len(), 1);
    // An update over an old revision is refused and writes nothing.
    let rows = audit_rows(&admin.app).await;
    let (status, body) = admin
        .call("PUT", &path(&created), Some(full(&created, 2)))
        .await;
    assert_eq!(
        (
            status,
            body["error"]["code"].clone(),
            body["error"]["details"]["currentRev"].clone()
        ),
        (StatusCode::CONFLICT, json!("stale_revision"), json!(3))
    );
    assert_eq!(host_revision(&admin.app).await, 3);
    assert_eq!(audit_rows(&admin.app).await, rows);
}

#[tokio::test]
async fn a_product_is_active_once_it_has_a_group_and_both_capacities() {
    let admin = admin().await;
    let draft = create(
        &admin,
        json!({ "gtin14": "04600682000020", "name": "Кефир 1% 0,9 л" }),
    )
    .await;
    assert_eq!(
        (draft["status"].clone(), draft["printName"].clone()),
        (json!("draft"), Value::Null)
    );
    let mut body = full(&draft, 2);
    body["chzProductGroupCode"] = json!(8);
    body["boxCapacity"] = json!(12);
    let (status, still) = admin.call("PUT", &path(&draft), Some(body)).await;
    assert_eq!(
        (status, still["status"].clone()),
        (StatusCode::OK, json!("draft"))
    );
    let mut body = full(&still, 3);
    body["palletBoxCapacity"] = json!(40);
    let (status, active) = admin.call("PUT", &path(&draft), Some(body)).await;
    assert_eq!(
        (status, active["status"].clone()),
        (StatusCode::OK, json!("active"))
    );
    assert_eq!(admin.feed(3).await[0]["data"]["status"], json!("active"));
}

#[tokio::test]
async fn a_gtin_is_unique_among_products_in_use() {
    let admin = admin().await;
    let first = create(&admin, milk()).await;
    let rows = audit_rows(&admin.app).await;
    let (status, body) = admin
        .call("POST", "/v1/office/products", Some(milk()))
        .await;
    assert_eq!(
        (status, constraint(&body)),
        (StatusCode::CONFLICT, json!("gtin14"))
    );
    assert_eq!(
        host_revision(&admin.app).await,
        2,
        "a refused write takes no revision"
    );
    assert_eq!(audit_rows(&admin.app).await, rows);

    // Once the first is archived, its GTIN is free...
    let mut archive = full(&first, 2);
    archive["archived"] = json!(true);
    let (status, archived) = admin.call("PUT", &path(&first), Some(archive)).await;
    assert_eq!(status, StatusCode::OK, "{archived}");
    create(&admin, milk()).await;
    // ...and the archived one cannot come back while another product in use
    // holds it.
    let mut restore = full(&archived, 3);
    restore["archived"] = json!(false);
    let (status, body) = admin.call("PUT", &path(&first), Some(restore)).await;
    assert_eq!(
        (status, constraint(&body)),
        (StatusCode::CONFLICT, json!("gtin14"))
    );
    let sharing: Vec<bool> = sqlx::query_scalar(
        "SELECT archived FROM products WHERE gtin14 = '04600682000013' ORDER BY archived",
    )
    .fetch_all(&admin.app.state.pool)
    .await
    .unwrap();
    assert_eq!(sharing, vec![false, true]);
}

#[tokio::test]
async fn product_fields_are_checked() {
    let admin = admin().await;
    let unknown = "9b2e4a6c-0000-4000-8000-000000000000";
    for (field, value) in [
        ("gtin14", json!("4600682000013")),
        ("gtin14", json!("0460068200001X")),
        ("name", json!(" ")),
        ("name", json!("м".repeat(201))),
        ("name", json!("Молоко\u{0}")),
        ("printName", json!("м".repeat(201))),
        // 18 is not a ЧЗ product group.
        ("chzProductGroupCode", json!(18)),
        ("boxCapacity", json!(0)),
        ("boxCapacity", json!(100_001)),
        ("palletBoxCapacity", json!(10_001)),
        ("shelfLifeDays", json!(3_651)),
        ("defaultBoxTemplateId", json!(unknown)),
        ("defaultPalletTemplateId", json!(unknown)),
    ] {
        let mut body = milk();
        body[field] = value;
        let (status, error) = admin.call("POST", "/v1/office/products", Some(body)).await;
        assert_eq!(
            (status, error["error"]["details"]["field"].clone()),
            (StatusCode::BAD_REQUEST, json!(field)),
            "{field}"
        );
    }
    // A field the host does not keep, or a count that is not one, is refused
    // as a whole. (Plan ТОВ keeps an EGAIS code, but only for group 15: on
    // this product of group 8 it is refused as a field, see below.)
    for (field, value) in [("unitPrice", json!(120)), ("boxCapacity", json!(-1))] {
        let mut body = milk();
        body[field] = value;
        let (status, error) = admin.call("POST", "/v1/office/products", Some(body)).await;
        assert_eq!(
            (status, error["error"]["code"].clone()),
            (StatusCode::BAD_REQUEST, json!("validation_failed")),
            "{field}"
        );
    }
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM products")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    assert!(audit_trail(&admin.app, "product.create").await.is_empty());
}

/// A default template must be a template of its slot's purpose; that it is
/// enabled and covers the product's group is checked by the office when it
/// is chosen and by the station before it is used, so a template disabled
/// or narrowed later never blocks the product.
#[tokio::test]
async fn a_default_template_is_of_its_slots_purpose_and_stays_a_preference() {
    let admin = admin().await;
    let pallet = insert_template(&admin.app, "pallet", true, None).await;
    let beer_box = insert_template(&admin.app, "box", false, Some("[15]")).await;

    let mut body = milk();
    body["defaultBoxTemplateId"] = json!(pallet);
    let (status, error) = admin
        .call("POST", "/v1/office/products", Some(body.clone()))
        .await;
    assert_eq!(
        (status, error["error"]["details"]["field"].clone()),
        (StatusCode::BAD_REQUEST, json!("defaultBoxTemplateId"))
    );
    body["defaultBoxTemplateId"] = json!(beer_box);
    body["defaultPalletTemplateId"] = json!(beer_box);
    let (status, error) = admin
        .call("POST", "/v1/office/products", Some(body.clone()))
        .await;
    assert_eq!(
        (status, error["error"]["details"]["field"].clone()),
        (StatusCode::BAD_REQUEST, json!("defaultPalletTemplateId"))
    );
    // A disabled box template scoped to beer stands as the milk product's
    // box preference.
    body["defaultPalletTemplateId"] = json!(pallet);
    let created = create(&admin, body).await;
    assert_eq!(
        (
            created["defaultBoxTemplateId"].clone(),
            created["defaultPalletTemplateId"].clone()
        ),
        (json!(beer_box), json!(pallet))
    );
}

#[tokio::test]
async fn technologists_create_and_change_products() {
    let admin = admin().await;
    let (tech, tech_id) = admin.technologist_session().await;
    let (status, created) = admin
        .call_as(&tech, "POST", "/v1/office/products", Some(milk()))
        .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let id = created["id"].as_str().unwrap().to_owned();
    let mut change = full(&created, created["rev"].as_i64().unwrap());
    change["shelfLifeDays"] = json!(14);
    let (status, updated) = admin
        .call_as(&tech, "PUT", &path(&created), Some(change))
        .await;
    assert_eq!(status, StatusCode::OK, "{updated}");
    let (status, list) = admin
        .call_as(&tech, "GET", "/v1/office/products", None)
        .await;
    assert_eq!((status, list), (StatusCode::OK, json!([updated])));
    assert_eq!(
        audit_trail(&admin.app, "product.create").await,
        vec![audit_row(
            &tech_id,
            "product.create",
            "product",
            &id,
            json!({ "gtin14": "04600682000013", "name": "Молоко 3,2% 0,9 л" })
        )]
    );
    assert_eq!(
        audit_trail(&admin.app, "product.update").await,
        vec![audit_row(
            &tech_id,
            "product.update",
            "product",
            &id,
            json!({ "changed": ["shelfLifeDays"], "shelfLifeDays": { "from": 10, "to": 14 } })
        )]
    );
}

/// Catalog writes read the session and the role again inside their write
/// transaction, as administrator writes do: a session that ended, or a user
/// turned off, after the extractor passed stops the write.
#[tokio::test]
async fn catalog_writes_recheck_the_session_inside_the_transaction() {
    let admin = admin().await;
    let (tech, tech_id) = admin.technologist_session().await;
    let (_, me) = admin.call_as(&tech, "GET", "/v1/office/me", None).await;
    let (session_id, device_id): (String, String) =
        sqlx::query_as("SELECT id, device_id FROM office_sessions WHERE user_id = ?")
            .bind(&tech_id)
            .fetch_one(&admin.app.state.pool)
            .await
            .unwrap();
    let context = OfficeContext {
        device_id,
        session_id,
        user: serde_json::from_value(me).unwrap(),
    };
    context.require_catalog().unwrap();
    let mut tx = markiro_host::db::begin_write(&admin.app.state.pool)
        .await
        .unwrap();
    context.require_catalog_in(&mut tx).await.unwrap();
    tx.rollback().await.unwrap();

    sqlx::query("UPDATE office_users SET active = 0 WHERE id = ?")
        .bind(&tech_id)
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    let mut tx = markiro_host::db::begin_write(&admin.app.state.pool)
        .await
        .unwrap();
    let refused = context.require_catalog_in(&mut tx).await.unwrap_err();
    assert_eq!(
        (
            refused.code(),
            refused.details().unwrap()["credential"].clone()
        ),
        ("unauthorized", json!("session"))
    );
}

#[tokio::test]
async fn an_unknown_product_is_not_found_once_its_body_is_valid() {
    let admin = admin().await;
    let path = "/v1/office/products/9b2e4a6c-0000-4000-8000-000000000000";
    let revision = host_revision(&admin.app).await;
    let rows = audit_rows(&admin.app).await;
    let mut invalid = full(&milk_record("x", 1), 1);
    invalid["gtin14"] = json!("1");
    let (status, body) = admin.call("PUT", path, Some(invalid)).await;
    assert_eq!(
        (status, body["error"]["details"]["field"].clone()),
        (StatusCode::BAD_REQUEST, json!("gtin14"))
    );
    let (status, body) = admin
        .call("PUT", path, Some(full(&milk_record("x", 1), 1)))
        .await;
    assert_eq!(
        (status, body["error"]["code"].clone()),
        (StatusCode::NOT_FOUND, json!("not_found"))
    );
    assert_eq!(host_revision(&admin.app).await, revision);
    assert_eq!(audit_rows(&admin.app).await, rows);
}

/// A `PUT` over a revision that is not the product's is stale whichever side
/// it errs on: one older than the record (it changed since it was read) and
/// one ahead of it (a client that never read it). Each answers the record's
/// own revision and writes nothing; the same body over the right revision is
/// accepted, so the revision is the only thing wrong with it.
#[tokio::test]
async fn a_put_over_a_revision_older_or_ahead_of_the_product_is_stale() {
    let admin = admin().await;
    let created = create(&admin, milk()).await;
    let mut first = full(&created, created["rev"].as_i64().unwrap());
    first["shelfLifeDays"] = json!(14);
    let (status, changed) = admin.call("PUT", &path(&created), Some(first)).await;
    assert_eq!(status, StatusCode::OK, "{changed}");
    let rev = changed["rev"].as_i64().unwrap();
    let revision = host_revision(&admin.app).await;
    let rows = audit_rows(&admin.app).await;
    for (side, expected_rev) in [("older", rev - 1), ("ahead", rev + 1)] {
        let mut body = full(&changed, expected_rev);
        body["shelfLifeDays"] = json!(21);
        let (status, refused) = admin.call("PUT", &path(&created), Some(body)).await;
        assert_eq!(
            (
                status,
                refused["error"]["code"].clone(),
                refused["error"]["details"]["currentRev"].clone()
            ),
            (StatusCode::CONFLICT, json!("stale_revision"), json!(rev)),
            "{side}"
        );
        assert_eq!(host_revision(&admin.app).await, revision, "{side}");
        assert_eq!(audit_rows(&admin.app).await, rows, "{side}");
        let (_, list) = admin.call("GET", "/v1/office/products", None).await;
        assert_eq!(list, json!([changed.clone()]), "{side}");
    }
    let mut body = full(&changed, rev);
    body["shelfLifeDays"] = json!(21);
    let (status, accepted) = admin.call("PUT", &path(&created), Some(body)).await;
    assert_eq!(status, StatusCode::OK, "{accepted}");
    assert_eq!(
        (accepted["shelfLifeDays"].clone(), accepted["rev"].clone()),
        (json!(21), json!(revision + 1))
    );
}

/// The body is checked before the revision is compared, whichever side of the
/// record's revision the request errs on: a product group or a template that
/// is not there is `validation_failed` on that field (400), never
/// `stale_revision` (409), over a revision older than the record's and over
/// one ahead of it. The templates' and the defaults' routes check in this
/// order too.
#[tokio::test]
async fn a_bad_reference_is_refused_before_the_revision_is_compared() {
    let admin = admin().await;
    let created = create(&admin, milk()).await;
    let rev = created["rev"].as_i64().unwrap();
    let unknown = "9b2e4a6c-0000-4000-8000-000000000000";
    let revision = host_revision(&admin.app).await;
    let rows = audit_rows(&admin.app).await;
    for expected_rev in [rev - 1, rev + 1] {
        for (field, value) in [
            // 18 is not a ЧЗ product group.
            ("chzProductGroupCode", json!(18)),
            ("defaultBoxTemplateId", json!(unknown)),
        ] {
            let mut body = full(&created, expected_rev);
            body[field] = value;
            let (status, refused) = admin.call("PUT", &path(&created), Some(body)).await;
            assert_eq!(
                (
                    status,
                    refused["error"]["code"].clone(),
                    refused["error"]["details"]["field"].clone()
                ),
                (
                    StatusCode::BAD_REQUEST,
                    json!("validation_failed"),
                    json!(field)
                ),
                "{field} over {expected_rev}"
            );
        }
    }
    assert_eq!(host_revision(&admin.app).await, revision);
    assert_eq!(audit_rows(&admin.app).await, rows);
}

/// Products are read only with an office session: a device key alone (a
/// station or a handheld, which are not the office) is refused naming the
/// session, and no credential at all names the device.
#[tokio::test]
async fn products_are_read_only_with_an_office_session() {
    let admin = admin().await;
    create(&admin, milk()).await;
    let (status, refused) = admin
        .app
        .send(empty(with_device(
            request("GET", "/v1/office/products"),
            &admin.key,
        )))
        .await;
    assert_eq!(
        (status, refused["error"]["details"]["credential"].clone()),
        (StatusCode::UNAUTHORIZED, json!("session"))
    );
    let (status, refused) = admin
        .app
        .send(empty(request("GET", "/v1/office/products")))
        .await;
    assert_eq!(
        (status, refused["error"]["details"]["credential"].clone()),
        (StatusCode::UNAUTHORIZED, json!("device"))
    );
}

// Beyond the plan. The review of the product table asked for the GTIN
// coverage, and each mutant of a rule below survived the plan's own tests.

/// A product written straight into its table, so that its id is the test's
/// choice (the routes draw a new one each time).
async fn insert_product(app: &TestApp, id: &str, gtin14: &str, name: &str, archived: bool) {
    let mut tx = markiro_host::db::begin_write(&app.state.pool)
        .await
        .unwrap();
    let rev = markiro_host::db::next_revision(&mut tx).await.unwrap();
    sqlx::query("INSERT INTO products (id, gtin14, name, archived, rev) VALUES (?, ?, ?, ?, ?)")
        .bind(id)
        .bind(gtin14)
        .bind(name)
        .bind(archived)
        .bind(rev)
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
}

/// `record` with its archive flag set through `PUT`; returns the stored record.
async fn set_archived(admin: &Admin, record: &Value, archived: bool) -> Value {
    let mut body = full(record, record["rev"].as_i64().unwrap());
    body["archived"] = json!(archived);
    let (status, stored) = admin.call("PUT", &path(record), Some(body)).await;
    assert_eq!(status, StatusCode::OK, "{stored}");
    stored
}

/// An archived product does not reserve its GTIN: a new product takes it and
/// two archived products share it. One of them comes back while nothing in
/// use holds the GTIN; the other cannot. Changing a GTIN into one a product
/// in use holds is refused like creating or restoring one, and a refusal
/// takes no revision and writes no audit row.
#[tokio::test]
async fn archived_products_may_share_a_gtin_and_come_back_one_at_a_time() {
    let admin = admin().await;
    let first = create(&admin, milk()).await;
    let first = set_archived(&admin, &first, true).await;
    // A new product takes the archived one's GTIN and is archived in turn.
    let second = create(&admin, milk()).await;
    assert_eq!(second["gtin14"], first["gtin14"]);
    let second = set_archived(&admin, &second, true).await;
    let held: Vec<bool> =
        sqlx::query_scalar("SELECT archived FROM products WHERE gtin14 = '04600682000013'")
            .fetch_all(&admin.app.state.pool)
            .await
            .unwrap();
    assert_eq!(held, vec![true, true]);

    // One comes back: no product in use holds the GTIN.
    let first = set_archived(&admin, &first, false).await;
    assert_eq!(first["archived"], json!(false));
    let kefir = create(
        &admin,
        json!({ "gtin14": "04600682000020", "name": "Кефир 1% 0,9 л" }),
    )
    .await;
    let revision = host_revision(&admin.app).await;
    let rows = audit_rows(&admin.app).await;
    // The other cannot, and a product in use cannot take the GTIN either.
    let mut restore = full(&second, second["rev"].as_i64().unwrap());
    restore["archived"] = json!(false);
    let (status, body) = admin.call("PUT", &path(&second), Some(restore)).await;
    assert_eq!(
        (status, constraint(&body)),
        (StatusCode::CONFLICT, json!("gtin14"))
    );
    let mut change = full(&kefir, kefir["rev"].as_i64().unwrap());
    change["gtin14"] = json!("04600682000013");
    let (status, body) = admin.call("PUT", &path(&kefir), Some(change)).await;
    assert_eq!(
        (status, constraint(&body)),
        (StatusCode::CONFLICT, json!("gtin14"))
    );
    assert_eq!(
        host_revision(&admin.app).await,
        revision,
        "a refused write takes no revision"
    );
    assert_eq!(audit_rows(&admin.app).await, rows);
    // A free GTIN is another matter.
    let mut change = full(&kefir, kefir["rev"].as_i64().unwrap());
    change["gtin14"] = json!("04600682000037");
    let (status, moved) = admin.call("PUT", &path(&kefir), Some(change)).await;
    assert_eq!(
        (status, moved["gtin14"].clone()),
        (StatusCode::OK, json!("04600682000037"))
    );
}

/// Products are listed in use first, then by name byte for byte (so «Zeta»
/// stands before «alpha» and a Cyrillic capital before a small letter), then
/// by id; an archived product comes after every product in use, whatever its
/// name. They are written in the opposite order, so the order they were
/// stored in cannot pass for the right one.
#[tokio::test]
async fn products_are_listed_in_use_first_then_by_name_bytewise_then_by_id() {
    let admin = admin().await;
    let listed = [
        ("00000000-0000-4000-8000-000000000001", "Zeta", false),
        ("00000000-0000-4000-8000-000000000002", "alpha", false),
        ("00000000-0000-4000-8000-000000000003", "Молоко", false),
        ("00000000-0000-4000-8000-000000000004", "Молоко", false),
        ("00000000-0000-4000-8000-000000000005", "Яблоко", false),
        ("00000000-0000-4000-8000-000000000006", "апельсин", false),
        ("00000000-0000-4000-8000-000000000007", "Аист", true),
        ("00000000-0000-4000-8000-000000000008", "Яблоко", true),
    ];
    for (position, (id, name, archived)) in listed.iter().enumerate().rev() {
        let gtin14 = format!("{:014}", position + 1);
        insert_product(&admin.app, id, &gtin14, name, *archived).await;
    }
    let (status, list) = admin.call("GET", "/v1/office/products", None).await;
    assert_eq!(status, StatusCode::OK, "{list}");
    let stored: Vec<(&str, &str, bool)> = list
        .as_array()
        .unwrap()
        .iter()
        .map(|product| {
            (
                product["id"].as_str().unwrap(),
                product["name"].as_str().unwrap(),
                product["archived"].as_bool().unwrap(),
            )
        })
        .collect();
    assert_eq!(stored, listed);
}

/// The bounds themselves are accepted: the longest names, the largest counts
/// and the smallest ones. (The plan's field test pins the first value past
/// each ceiling; these pin the ceilings.)
#[tokio::test]
async fn product_fields_accept_their_bounds() {
    let admin = admin().await;
    let mut largest = milk();
    largest["name"] = json!("м".repeat(200));
    largest["printName"] = json!("п".repeat(200));
    largest["boxCapacity"] = json!(100_000);
    largest["palletBoxCapacity"] = json!(10_000);
    largest["shelfLifeDays"] = json!(3_650);
    let created = create(&admin, largest).await;
    assert_eq!(
        (
            created["name"].as_str().unwrap().chars().count(),
            created["printName"].as_str().unwrap().chars().count(),
            created["boxCapacity"].clone(),
            created["palletBoxCapacity"].clone(),
            created["shelfLifeDays"].clone()
        ),
        (200, 200, json!(100_000), json!(10_000), json!(3_650))
    );
    let mut smallest = milk();
    smallest["gtin14"] = json!("04600682000020");
    smallest["name"] = json!("м");
    smallest["printName"] = json!("п");
    smallest["boxCapacity"] = json!(1);
    smallest["palletBoxCapacity"] = json!(1);
    smallest["shelfLifeDays"] = json!(1);
    let created = create(&admin, smallest).await;
    assert_eq!(
        (
            created["name"].clone(),
            created["printName"].clone(),
            created["boxCapacity"].clone(),
            created["palletBoxCapacity"].clone(),
            created["shelfLifeDays"].clone()
        ),
        (json!("м"), json!("п"), json!(1), json!(1), json!(1))
    );
}

/// The product routes call `require_catalog_in` themselves, not only the
/// helper: a technologist is turned off after the extractor read them as
/// active and before the write transaction begins. A trigger does it at the
/// moment the extractor records the session's activity (it does once a
/// minute), so the order is the same on every run. The write is refused as an
/// ended session and leaves no trace. The session is still there afterwards,
/// which the extractor would not leave behind a user it found turned off, so
/// the refusal is the route's own.
#[tokio::test]
async fn product_writes_stop_a_user_turned_off_after_the_extractor_passed() {
    let admin = admin().await;
    let (tech, tech_id) = admin.technologist_session().await;
    let session_id: String = sqlx::query_scalar("SELECT id FROM office_sessions WHERE user_id = ?")
        .bind(&tech_id)
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    let product = create(&admin, milk()).await;
    let revision = host_revision(&admin.app).await;
    let rows = audit_rows(&admin.app).await;
    turn_the_user_off_at_the_next_activity(&admin.app, &tech_id).await;

    let mut another = milk();
    another["gtin14"] = json!("04600682000020");
    let mut change = full(&product, product["rev"].as_i64().unwrap());
    change["shelfLifeDays"] = json!(14);
    for (method, route, body) in [
        ("POST", "/v1/office/products".to_owned(), another),
        ("PUT", path(&product), change),
    ] {
        // Let a minute pass, so that the extractor records activity, and turn
        // the user back on for this round.
        admin.app.clock.advance(time::Duration::minutes(2));
        sqlx::query("UPDATE office_users SET active = 1 WHERE id = ?")
            .bind(&tech_id)
            .execute(&admin.app.state.pool)
            .await
            .unwrap();
        let (status, error) = admin.call_as(&tech, method, &route, Some(body)).await;
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

/// A `PUT` that changes every field stores each in its own column and records
/// each change, the default templates included.
#[tokio::test]
async fn an_update_writes_every_field_to_its_own_column() {
    let admin = admin().await;
    let box_template = insert_template(&admin.app, "box", true, None).await;
    let pallet_template = insert_template(&admin.app, "pallet", true, None).await;
    let created = create(&admin, milk()).await;
    let id = created["id"].as_str().unwrap().to_owned();
    let rev = created["rev"].as_i64().unwrap();
    let change = json!({
        "gtin14": "04600682000020",
        "name": "Молоко 2,5% 1 л",
        "printName": "Молоко 2,5%",
        "chzProductGroupCode": 15,
        "boxCapacity": 24,
        "palletBoxCapacity": 48,
        "shelfLifeDays": 14,
        "defaultBoxTemplateId": box_template,
        "defaultPalletTemplateId": pallet_template,
        "archived": true,
        "expectedRev": rev
    });
    let (status, updated) = admin.call("PUT", &path(&created), Some(change)).await;
    assert_eq!(status, StatusCode::OK, "{updated}");
    let expected = json!({
        "id": id, "gtin14": "04600682000020", "name": "Молоко 2,5% 1 л",
        "printName": "Молоко 2,5%", "chzProductGroupCode": 15,
        "boxCapacity": 24, "palletBoxCapacity": 48, "shelfLifeDays": 14,
        "defaultBoxTemplateId": box_template, "defaultPalletTemplateId": pallet_template,
        "defaultPalletSheetId": null,
        "egaisCode": null, "defaultCounterpartyId": null, "photoChecksum": null,
        "archived": true, "status": "active", "rev": rev + 1
    });
    assert_eq!(updated, expected);
    // The list reads the row again.
    let (status, list) = admin.call("GET", "/v1/office/products", None).await;
    assert_eq!((status, list), (StatusCode::OK, json!([expected])));
    assert_eq!(
        audit_trail(&admin.app, "product.update").await,
        vec![admin.row(
            "product.update",
            "product",
            &id,
            json!({
                "changed": [
                    "gtin14", "name", "printName", "chzProductGroupCode", "boxCapacity",
                    "palletBoxCapacity", "shelfLifeDays", "defaultBoxTemplateId",
                    "defaultPalletTemplateId", "archived"
                ],
                "gtin14": { "from": "04600682000013", "to": "04600682000020" },
                "name": { "from": "Молоко 3,2% 0,9 л", "to": "Молоко 2,5% 1 л" },
                "printName": { "from": "Молоко 3,2%", "to": "Молоко 2,5%" },
                "chzProductGroupCode": { "from": 8, "to": 15 },
                "boxCapacity": { "from": 12, "to": 24 },
                "palletBoxCapacity": { "from": 40, "to": 48 },
                "shelfLifeDays": { "from": 10, "to": 14 },
                "defaultBoxTemplateId": { "from": null, "to": box_template },
                "defaultPalletTemplateId": { "from": null, "to": pallet_template },
                "archived": { "from": false, "to": true }
            })
        )]
    );
}

/// A `PUT` is the whole record: without `archived`, `expectedRev`, `gtin14` or
/// `name` it is refused as a body. What it sends is checked as a create's is,
/// references included, and nothing is written when a check fails. An
/// optional field it leaves out is cleared, as `null` clears it.
#[tokio::test]
async fn an_update_needs_the_whole_record_and_is_checked_like_a_create() {
    let admin = admin().await;
    let pallet = insert_template(&admin.app, "pallet", true, None).await;
    let created = create(&admin, milk()).await;
    let id = created["id"].as_str().unwrap().to_owned();
    let rev = created["rev"].as_i64().unwrap();
    let revision = host_revision(&admin.app).await;
    let rows = audit_rows(&admin.app).await;
    for missing in ["archived", "expectedRev", "gtin14", "name"] {
        let mut body = full(&created, rev);
        body.as_object_mut().unwrap().remove(missing);
        let (status, error) = admin.call("PUT", &path(&created), Some(body)).await;
        assert_eq!(
            (status, error["error"]["code"].clone()),
            (StatusCode::BAD_REQUEST, json!("validation_failed")),
            "{missing}"
        );
    }
    let unknown = "9b2e4a6c-0000-4000-8000-000000000000";
    for (field, value) in [
        ("gtin14", json!("4600682000013")),
        ("name", json!(" ")),
        ("printName", json!("м".repeat(201))),
        ("chzProductGroupCode", json!(18)),
        ("boxCapacity", json!(0)),
        ("palletBoxCapacity", json!(10_001)),
        ("shelfLifeDays", json!(3_651)),
        ("defaultBoxTemplateId", json!(unknown)),
        // A pallet template is not a box template.
        ("defaultBoxTemplateId", json!(pallet)),
        ("defaultPalletTemplateId", json!(unknown)),
    ] {
        let mut body = full(&created, rev);
        body[field] = value;
        let (status, error) = admin.call("PUT", &path(&created), Some(body)).await;
        assert_eq!(
            (status, error["error"]["details"]["field"].clone()),
            (StatusCode::BAD_REQUEST, json!(field)),
            "{field}"
        );
    }
    assert_eq!(host_revision(&admin.app).await, revision);
    assert_eq!(audit_rows(&admin.app).await, rows);

    let mut body = full(&created, rev);
    for optional in [
        "printName",
        "chzProductGroupCode",
        "boxCapacity",
        "palletBoxCapacity",
        "shelfLifeDays",
        "defaultBoxTemplateId",
        "defaultPalletTemplateId",
    ] {
        body.as_object_mut().unwrap().remove(optional);
    }
    let (status, cleared) = admin.call("PUT", &path(&created), Some(body)).await;
    assert_eq!(status, StatusCode::OK, "{cleared}");
    assert_eq!(
        cleared,
        json!({
            "id": id, "gtin14": "04600682000013", "name": "Молоко 3,2% 0,9 л",
            "printName": null, "chzProductGroupCode": null, "boxCapacity": null,
            "palletBoxCapacity": null, "shelfLifeDays": null,
            "defaultBoxTemplateId": null, "defaultPalletTemplateId": null,
            "defaultPalletSheetId": null,
            "egaisCode": null, "defaultCounterpartyId": null, "photoChecksum": null,
            "archived": false, "status": "draft", "rev": rev + 1
        })
    );
}

#[tokio::test]
async fn a_beer_product_keeps_its_trimmed_egais_code() {
    let admin = admin().await;
    let created = create(&admin, beer()).await;
    assert_eq!(created["egaisCode"], "0150320000001234567");
    assert_eq!(created["defaultCounterpartyId"], Value::Null);
    assert_eq!(created["photoChecksum"], Value::Null);
    let stored: Option<String> = sqlx::query_scalar("SELECT egais_code FROM products WHERE id = ?")
        .bind(created["id"].as_str().unwrap())
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    assert_eq!(stored.as_deref(), Some("0150320000001234567"));
    assert_eq!(
        audit_trail(&admin.app, "product.create").await,
        vec![admin.row(
            "product.create",
            "product",
            created["id"].as_str().unwrap(),
            json!({
                "gtin14": "04607001234560", "name": "Пиво светлое 0,5 л",
                "egaisCode": "0150320000001234567", "defaultCounterpartyId": null
            })
        )]
    );
    // A blank code is none.
    let mut body = beer();
    body["gtin14"] = json!("04607001234577");
    body["egaisCode"] = json!("   ");
    assert_eq!(create(&admin, body).await["egaisCode"], Value::Null);
}

#[tokio::test]
async fn an_egais_code_outside_group_15_is_refused() {
    let admin = admin().await;
    let rows = audit_rows(&admin.app).await;
    for group in [json!(8), Value::Null] {
        let mut body = milk();
        body["chzProductGroupCode"] = group.clone();
        body["egaisCode"] = json!("0150320000001234567");
        let (status, error) = admin.call("POST", "/v1/office/products", Some(body)).await;
        assert_eq!(
            (
                status,
                error["error"]["code"].clone(),
                error["error"]["details"]["field"].clone()
            ),
            (
                StatusCode::BAD_REQUEST,
                json!("validation_failed"),
                json!("egaisCode")
            ),
            "group {group}: {error}"
        );
    }
    assert_eq!(audit_rows(&admin.app).await, rows);
}

#[tokio::test]
async fn a_code_sent_outside_group_15_is_refused_before_the_product_is_read() {
    let admin = admin().await;
    let mut body = milk();
    body["egaisCode"] = json!("0150320000001234567");
    body["archived"] = json!(false);
    body["expectedRev"] = json!(1);
    let unknown = format!("/v1/office/products/{}", uuid::Uuid::new_v4());
    let (status, error) = admin.call("PUT", &unknown, Some(body)).await;
    assert_eq!(
        (status, error["error"]["details"]["field"].clone()),
        (StatusCode::BAD_REQUEST, json!("egaisCode")),
        "{error}"
    );
}

#[tokio::test]
async fn changing_the_group_away_from_15_with_the_code_kept_is_refused() {
    let admin = admin().await;
    let created = create(&admin, beer()).await;
    let rev = created["rev"].as_i64().unwrap();
    let mut body = full(&created, rev);
    body["chzProductGroupCode"] = json!(8);
    let (status, error) = admin.call("PUT", &path(&created), Some(body.clone())).await;
    assert_eq!(
        (status, error["error"]["details"]["field"].clone()),
        (StatusCode::BAD_REQUEST, json!("egaisCode")),
        "{error}"
    );
    // Left out (an office from before plan ТОВ), the code is kept, so the
    // change is refused the same way.
    body.as_object_mut().unwrap().remove("egaisCode");
    let (status, error) = admin.call("PUT", &path(&created), Some(body.clone())).await;
    assert_eq!(
        (status, error["error"]["details"]["field"].clone()),
        (StatusCode::BAD_REQUEST, json!("egaisCode")),
        "{error}"
    );
    // Cleared with it, the group changes.
    body["egaisCode"] = Value::Null;
    let (status, updated) = admin.call("PUT", &path(&created), Some(body)).await;
    assert_eq!(status, StatusCode::OK, "{updated}");
    assert_eq!(
        (
            updated["chzProductGroupCode"].clone(),
            updated["egaisCode"].clone()
        ),
        (json!(8), Value::Null)
    );
}

#[tokio::test]
async fn an_egais_code_of_65_characters_or_with_a_control_character_is_refused() {
    let admin = admin().await;
    let rows = audit_rows(&admin.app).await;
    for code in ["1".repeat(65), "0150320\u{1}000001234567".to_owned()] {
        let mut body = beer();
        body["egaisCode"] = json!(code);
        let (status, error) = admin.call("POST", "/v1/office/products", Some(body)).await;
        assert_eq!(
            (
                status,
                error["error"]["code"].clone(),
                error["error"]["details"]["field"].clone()
            ),
            (
                StatusCode::BAD_REQUEST,
                json!("validation_failed"),
                json!("egaisCode")
            ),
            "{code:?}: {error}"
        );
    }
    // 64 characters, the cloud's bound, are kept.
    let mut body = beer();
    body["egaisCode"] = json!("Я".repeat(64));
    assert_eq!(
        create(&admin, body).await["egaisCode"],
        json!("Я".repeat(64))
    );
    assert_eq!(audit_rows(&admin.app).await, rows + 1);
}

#[tokio::test]
async fn the_default_counterparty_must_be_in_use() {
    let admin = admin().await;
    let north = counterparty(&admin, "ООО «Север»", "4601234000017").await;
    let south = counterparty(&admin, "ООО «Юг»", "4609876000013").await;
    // South is archived.
    let mut archive = south.clone();
    for computed in ["id", "rev"] {
        archive.as_object_mut().unwrap().remove(computed);
    }
    archive["archived"] = json!(true);
    archive["expectedRev"] = south["rev"].clone();
    let (status, body) = admin
        .call(
            "PUT",
            &format!(
                "/v1/office/counterparties/{}",
                south["id"].as_str().unwrap()
            ),
            Some(archive),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let rows = audit_rows(&admin.app).await;
    for id in [json!(uuid::Uuid::new_v4().to_string()), south["id"].clone()] {
        let mut body = milk();
        body["defaultCounterpartyId"] = id.clone();
        let (status, error) = admin.call("POST", "/v1/office/products", Some(body)).await;
        assert_eq!(
            (
                status,
                error["error"]["code"].clone(),
                error["error"]["details"]["field"].clone()
            ),
            (
                StatusCode::BAD_REQUEST,
                json!("validation_failed"),
                json!("defaultCounterpartyId")
            ),
            "{id}: {error}"
        );
    }
    assert_eq!(audit_rows(&admin.app).await, rows);
    let mut body = milk();
    body["defaultCounterpartyId"] = north["id"].clone();
    let created = create(&admin, body).await;
    assert_eq!(created["defaultCounterpartyId"], north["id"]);
    assert_eq!(
        audit_trail(&admin.app, "product.create").await,
        vec![admin.row(
            "product.create",
            "product",
            created["id"].as_str().unwrap(),
            json!({
                "gtin14": "04600682000013", "name": "Молоко 3,2% 0,9 л",
                "egaisCode": null, "defaultCounterpartyId": north["id"]
            })
        )]
    );
    // Archiving it later keeps the product's pointer, and an update that
    // keeps it is not refused.
    let mut archive = north.clone();
    for computed in ["id", "rev"] {
        archive.as_object_mut().unwrap().remove(computed);
    }
    archive["archived"] = json!(true);
    archive["expectedRev"] = north["rev"].clone();
    let (status, body) = admin
        .call(
            "PUT",
            &format!(
                "/v1/office/counterparties/{}",
                north["id"].as_str().unwrap()
            ),
            Some(archive),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, list) = admin.call("GET", "/v1/office/products", None).await;
    assert_eq!(
        (status, list[0]["defaultCounterpartyId"].clone()),
        (StatusCode::OK, north["id"].clone())
    );
    let mut change = full(&list[0], list[0]["rev"].as_i64().unwrap());
    change["shelfLifeDays"] = json!(12);
    let (status, updated) = admin.call("PUT", &path(&list[0]), Some(change)).await;
    assert_eq!(status, StatusCode::OK, "{updated}");
    assert_eq!(updated["defaultCounterpartyId"], north["id"]);
}

#[tokio::test]
async fn the_update_audits_the_egais_code_and_the_counterparty() {
    let admin = admin().await;
    let north = counterparty(&admin, "ООО «Север»", "4601234000017").await;
    let created = create(&admin, beer()).await;
    let mut body = full(&created, created["rev"].as_i64().unwrap());
    body["egaisCode"] = json!("0150320000007654321");
    body["defaultCounterpartyId"] = north["id"].clone();
    let (status, updated) = admin.call("PUT", &path(&created), Some(body)).await;
    assert_eq!(status, StatusCode::OK, "{updated}");
    let id = created["id"].as_str().unwrap();
    assert_eq!(
        audit_trail(&admin.app, "product.update").await,
        vec![admin.row(
            "product.update",
            "product",
            id,
            json!({
                "changed": ["egaisCode", "defaultCounterpartyId"],
                "egaisCode": { "from": "0150320000001234567", "to": "0150320000007654321" },
                "defaultCounterpartyId": { "from": null, "to": north["id"] }
            })
        )]
    );
    // Left out of an update, both are kept.
    let mut body = full(&updated, updated["rev"].as_i64().unwrap());
    let fields = body.as_object_mut().unwrap();
    fields.remove("egaisCode");
    fields.remove("defaultCounterpartyId");
    body["shelfLifeDays"] = json!(30);
    let (status, kept) = admin.call("PUT", &path(&created), Some(body)).await;
    assert_eq!(status, StatusCode::OK, "{kept}");
    assert_eq!(
        (
            kept["egaisCode"].clone(),
            kept["defaultCounterpartyId"].clone()
        ),
        (json!("0150320000007654321"), north["id"].clone())
    );
}
