//! A4 pallet sheets (plan А4, task 3): `GET`/`POST /v1/office/pallet-sheets`,
//! `PUT`/`DELETE …/{id}` and `PUT /v1/office/pallet-sheet-default`.

mod support;

use axum::http::StatusCode;
use markiro_host::routes::pallet_sheets::default_sheet;
use serde_json::{json, Value};
use support::app::{
    admin, audit_rows, audit_trail, empty, host_revision, login, pallet_shift_body,
    pallet_template, plan_shift, request, seed_office_user, shift_setup,
    turn_the_user_off_at_the_next_activity, with_device, Admin,
};

const LIST: &str = "/v1/office/pallet-sheets";
const DEFAULT: &str = "/v1/office/pallet-sheet-default";

fn spec() -> Value {
    json!({ "schemaVersion": 2, "kind": "pallet_sheet", "dpi": 300, "page": {} })
}

async fn create(admin: &Admin, body: Value) -> Value {
    let (status, created) = admin.call("POST", LIST, Some(body)).await;
    assert_eq!(status, StatusCode::OK, "{created}");
    created
}

fn stock(key: &str, name: &str) -> Value {
    json!({ "name": name, "presetKey": key, "spec": spec() })
}

fn path(sheet: &Value) -> String {
    format!("{LIST}/{}", sheet["id"].as_str().unwrap())
}

async fn set_default(admin: &Admin, id: &Value) -> (StatusCode, Value) {
    admin
        .call("PUT", DEFAULT, Some(json!({ "templateId": id })))
        .await
}

/// `(status, code, constraint)` of a refusal.
fn conflict(status: StatusCode, body: &Value) -> (StatusCode, Value, Value) {
    (
        status,
        body["error"]["code"].clone(),
        body["error"]["details"]["constraint"].clone(),
    )
}

/// `(status, code, field)` of a refusal.
fn invalid(status: StatusCode, body: &Value) -> (StatusCode, Value, Value) {
    (
        status,
        body["error"]["code"].clone(),
        body["error"]["details"]["field"].clone(),
    )
}

/// Everything the sheets hold, as `(id, name, enabled, preset_key, revision)`,
/// plus the default.
async fn stored(
    admin: &Admin,
) -> (
    Vec<(String, String, bool, Option<String>, i64)>,
    Option<String>,
) {
    let rows = sqlx::query_as(
        "SELECT id, name, enabled, preset_key, revision FROM pallet_sheet_templates ORDER BY id",
    )
    .fetch_all(&admin.app.state.pool)
    .await
    .unwrap();
    let default = sqlx::query_scalar("SELECT default_pallet_sheet_template_id FROM org_profile")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    (rows, default)
}

/// The id of the one station the wizard paired.
async fn station_id(admin: &Admin) -> String {
    let (status, device) = admin
        .app
        .send(empty(with_device(request("GET", "/v1/device"), &admin.key)))
        .await;
    assert_eq!(status, StatusCode::OK, "{device}");
    device["id"].as_str().unwrap().to_owned()
}

#[tokio::test]
async fn a_stock_sheet_added_twice_is_one_sheet() {
    let admin = admin().await;
    let first = create(
        &admin,
        stock("pallet-a4-portrait", "Палета А4 · вертикальная"),
    )
    .await;
    assert_eq!(
        (first["revision"].clone(), first["enabled"].clone()),
        (json!(1), json!(true))
    );
    assert_eq!(first["presetKey"], "pallet-a4-portrait");
    assert_eq!(first["spec"], spec());
    let rows = audit_rows(&admin.app).await;
    let again = create(&admin, stock("pallet-a4-portrait", "Другое имя")).await;
    assert_eq!(again, first);
    assert_eq!(
        audit_rows(&admin.app).await,
        rows,
        "the replay audits nothing"
    );
    let (_, list) = admin.call("GET", LIST, None).await;
    assert_eq!(list["sheets"].as_array().unwrap().len(), 1);
    assert_eq!(list["defaultId"], Value::Null);
    assert_eq!(
        audit_trail(&admin.app, "pallet_sheet.create").await,
        vec![admin.row(
            "pallet_sheet.create",
            "pallet_sheet",
            first["id"].as_str().unwrap(),
            json!({ "name": "Палета А4 · вертикальная", "presetKey": "pallet-a4-portrait" })
        )]
    );
    // A renamed stock sheet is not sown again either.
    let (status, _) = admin
        .call(
            "PUT",
            &path(&first),
            Some(json!({ "name": "Цех 2", "expectedRevision": 1 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let again = create(
        &admin,
        stock("pallet-a4-portrait", "Палета А4 · вертикальная"),
    )
    .await;
    assert_eq!(
        (again["name"].clone(), again["revision"].clone()),
        (json!("Цех 2"), json!(2))
    );
    // A sheet of the office's own has no key and is a new one each time.
    let own = json!({ "name": "Свой", "spec": spec() });
    let (one, two) = (create(&admin, own.clone()).await, create(&admin, own).await);
    assert_ne!(one["id"], two["id"]);
    assert_eq!(one["presetKey"], Value::Null);
}

#[tokio::test]
async fn the_list_is_by_name_with_the_default() {
    let admin = admin().await;
    let (_, empty_list) = admin.call("GET", LIST, None).await;
    assert_eq!(empty_list, json!({ "sheets": [], "defaultId": null }));
    // Eight names in no order: the ids are random, so only the name sorts.
    let mut made = Vec::new();
    for name in ["Д", "Б", "Ж", "А", "Г", "В", "Е", "З"] {
        let enabled = name != "А";
        made.push(
            create(
                &admin,
                json!({ "name": name, "spec": spec(), "enabled": enabled }),
            )
            .await,
        );
    }
    made.sort_by_key(|sheet| sheet["name"].as_str().unwrap().to_owned());
    let (a, b) = (made[0].clone(), made[1].clone());
    let (status, answer) = set_default(&admin, &b["id"]).await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    let (_, list) = admin.call("GET", LIST, None).await;
    assert_eq!(list, json!({ "sheets": made, "defaultId": b["id"] }));
    assert_eq!(answer, list, "the default answer is the whole list");
    assert_eq!(a["enabled"], false);
    // The technologist reads the same list.
    let token = admin.technologist().await;
    let (status, read) = admin.call_as(&token, "GET", LIST, None).await;
    assert_eq!((status, read), (StatusCode::OK, list));
}

#[tokio::test]
async fn a_sheet_is_checked_before_it_is_kept() {
    let admin = admin().await;
    let label = json!({ "name": "Этикетка", "spec": { "widthMm": 58, "heightMm": 40 } });
    let mut cases: Vec<(&str, Value, &str)> = vec![
        ("a label spec", label, "spec"),
        (
            "a v1 sheet",
            json!({ "name": "x", "spec": { "schemaVersion": 1, "kind": "pallet_sheet" } }),
            "spec",
        ),
        ("an array spec", json!({ "name": "x", "spec": [] }), "spec"),
        (
            "a spec past 64 KiB",
            json!({ "name": "x", "spec": {
                "schemaVersion": 2, "kind": "pallet_sheet", "pad": "x".repeat(65_536) } }),
            "spec",
        ),
        (
            "a blank name",
            json!({ "name": "  ", "spec": spec() }),
            "name",
        ),
        (
            "a 201-character name",
            json!({ "name": "ш".repeat(201), "spec": spec() }),
            "name",
        ),
        (
            "an upper-case key",
            json!({ "name": "x", "presetKey": "Pallet", "spec": spec() }),
            "presetKey",
        ),
        (
            "an empty key",
            json!({ "name": "x", "presetKey": "", "spec": spec() }),
            "presetKey",
        ),
        (
            "a 65-character key",
            json!({ "name": "x", "presetKey": "a".repeat(65), "spec": spec() }),
            "presetKey",
        ),
    ];
    let mut deep = json!({});
    for _ in 0..70 {
        deep = json!({ "a": deep });
    }
    cases.push((
        "a spec 71 levels deep",
        json!({ "name": "x", "spec": {
            "schemaVersion": 2, "kind": "pallet_sheet", "deep": deep } }),
        "spec",
    ));
    let rows = audit_rows(&admin.app).await;
    for (what, body, field) in cases {
        let (status, error) = admin.call("POST", LIST, Some(body)).await;
        assert_eq!(
            invalid(status, &error),
            (
                StatusCode::BAD_REQUEST,
                json!("validation_failed"),
                json!(field)
            ),
            "{what}: {error}"
        );
    }
    // Not the shape at all: an unknown field, a missing spec, a stored id.
    for (what, body) in [
        ("an id", json!({ "name": "x", "spec": spec(), "id": "x" })),
        (
            "a revision",
            json!({ "name": "x", "spec": spec(), "revision": 5 }),
        ),
        ("no spec", json!({ "name": "x" })),
        ("no name", json!({ "spec": spec() })),
        (
            "a string flag",
            json!({ "name": "x", "spec": spec(), "enabled": "yes" }),
        ),
    ] {
        let (status, error) = admin.call("POST", LIST, Some(body)).await;
        assert_eq!(
            (status, error["error"]["code"].clone()),
            (StatusCode::BAD_REQUEST, json!("validation_failed")),
            "{what}: {error}"
        );
    }
    // The exact bounds are kept: a 64-character key, a 200-character name.
    let key = "a".repeat(64);
    create(
        &admin,
        json!({ "name": "ш".repeat(200), "presetKey": key, "spec": spec() }),
    )
    .await;
    // A body past the router's JSON ceiling is refused outright.
    let (status, error) = admin
        .call(
            "POST",
            LIST,
            Some(json!({ "name": "x", "spec": {
                "schemaVersion": 2, "kind": "pallet_sheet", "pad": "x".repeat(3 * 1024 * 1024) } })),
        )
        .await;
    assert_eq!(
        (status, error["error"]["code"].clone()),
        (StatusCode::BAD_REQUEST, json!("validation_failed")),
        "{error}"
    );
    assert_eq!(
        stored(&admin).await.0.len(),
        1,
        "only the exact-bounds sheet"
    );
    assert_eq!(audit_rows(&admin.app).await, rows + 1);
}

#[tokio::test]
async fn a_rename_and_a_switch_raise_the_revision_over_the_expected_one() {
    let admin = admin().await;
    let sheet = create(&admin, stock("pallet-a4-landscape", "Горизонтальная")).await;
    let id = sheet["id"].as_str().unwrap();
    let before = host_revision(&admin.app).await;
    let (status, renamed) = admin
        .call(
            "PUT",
            &path(&sheet),
            Some(json!({ "name": " Цех 2 ", "expectedRevision": 1 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{renamed}");
    assert_eq!(
        (renamed["name"].clone(), renamed["revision"].clone()),
        (json!("Цех 2"), json!(2)),
        "trimmed, one revision"
    );
    assert_eq!(
        renamed["spec"], sheet["spec"],
        "the layout is never touched"
    );
    // Stale on both sides: the old revision and one ahead.
    for stale in [1, 3] {
        let rows = audit_rows(&admin.app).await;
        let (status, refused) = admin
            .call(
                "PUT",
                &path(&sheet),
                Some(json!({ "enabled": false, "expectedRevision": stale })),
            )
            .await;
        assert_eq!(
            (
                status,
                refused["error"]["code"].clone(),
                refused["error"]["details"]["currentRev"].clone()
            ),
            (StatusCode::CONFLICT, json!("stale_revision"), json!(2)),
            "{stale}"
        );
        assert_eq!(audit_rows(&admin.app).await, rows);
    }
    let (status, off) = admin
        .call(
            "PUT",
            &path(&sheet),
            Some(json!({ "enabled": false, "expectedRevision": 2 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{off}");
    assert_eq!(
        (off["enabled"].clone(), off["revision"].clone()),
        (json!(false), json!(3))
    );
    // Both at once is one change, one revision.
    let (_, both) = admin
        .call(
            "PUT",
            &path(&sheet),
            Some(json!({ "name": "Цех 3", "enabled": true, "expectedRevision": 3 })),
        )
        .await;
    assert_eq!(both["revision"], 4);
    assert_eq!(
        audit_trail(&admin.app, "pallet_sheet.update").await,
        vec![
            admin.row(
                "pallet_sheet.update",
                "pallet_sheet",
                id,
                json!({ "changed": ["name"], "name": { "from": "Горизонтальная", "to": "Цех 2" } })
            ),
            admin.row(
                "pallet_sheet.update",
                "pallet_sheet",
                id,
                json!({ "changed": ["enabled"], "enabled": { "from": true, "to": false } })
            ),
            admin.row(
                "pallet_sheet.update",
                "pallet_sheet",
                id,
                json!({
                    "changed": ["name", "enabled"],
                    "name": { "from": "Цех 2", "to": "Цех 3" },
                    "enabled": { "from": false, "to": true }
                })
            ),
        ]
    );
    // No sheet is in the station feed: the host's revision never moved.
    assert_eq!(host_revision(&admin.app).await, before);
}

#[tokio::test]
async fn an_update_that_changes_nothing_is_quiet() {
    let admin = admin().await;
    let sheet = create(&admin, stock("pallet-a4-portrait", "Вертикальная")).await;
    let rows = audit_rows(&admin.app).await;
    for body in [
        json!({ "expectedRevision": 1 }),
        json!({ "name": "Вертикальная", "expectedRevision": 1 }),
        json!({ "name": "  Вертикальная ", "enabled": true, "expectedRevision": 1 }),
    ] {
        let (status, same) = admin.call("PUT", &path(&sheet), Some(body)).await;
        assert_eq!((status, &same), (StatusCode::OK, &sheet));
    }
    assert_eq!(audit_rows(&admin.app).await, rows);
    assert_eq!(stored(&admin).await.0[0].4, 1, "no revision was taken");
}

#[tokio::test]
async fn a_bad_update_is_refused_and_changes_nothing() {
    let admin = admin().await;
    let sheet = create(&admin, stock("pallet-a4-portrait", "Вертикальная")).await;
    let before = stored(&admin).await;
    let rows = audit_rows(&admin.app).await;
    for (what, body) in [
        (
            "a blank name",
            json!({ "name": " ", "expectedRevision": 1 }),
        ),
        (
            "a long name",
            json!({ "name": "ш".repeat(201), "expectedRevision": 1 }),
        ),
    ] {
        let (status, error) = admin.call("PUT", &path(&sheet), Some(body)).await;
        assert_eq!(
            invalid(status, &error),
            (
                StatusCode::BAD_REQUEST,
                json!("validation_failed"),
                json!("name")
            ),
            "{what}"
        );
    }
    for (what, body) in [
        (
            "a new layout",
            json!({ "spec": spec(), "expectedRevision": 1 }),
        ),
        (
            "a new key",
            json!({ "presetKey": "x", "expectedRevision": 1 }),
        ),
        (
            "a revision of its own",
            json!({ "revision": 9, "expectedRevision": 1 }),
        ),
        ("no expected revision", json!({ "name": "x" })),
        (
            "a null revision",
            json!({ "name": "x", "expectedRevision": null }),
        ),
    ] {
        let (status, error) = admin.call("PUT", &path(&sheet), Some(body)).await;
        assert_eq!(
            (status, error["error"]["code"].clone()),
            (StatusCode::BAD_REQUEST, json!("validation_failed")),
            "{what}: {error}"
        );
    }
    let missing = "/v1/office/pallet-sheets/8f6d1c2e-3b4a-4c5d-9e8f-7a6b5c4d3e2f";
    let (status, error) = admin
        .call(
            "PUT",
            missing,
            Some(json!({ "name": "x", "expectedRevision": 1 })),
        )
        .await;
    assert_eq!(
        (status, error["error"]["message"].clone()),
        (StatusCode::NOT_FOUND, json!("no such sheet"))
    );
    assert_eq!(stored(&admin).await, before);
    assert_eq!(audit_rows(&admin.app).await, rows);
}

#[tokio::test]
async fn the_default_sheet_is_neither_switched_off_nor_deleted() {
    let admin = admin().await;
    let sheet = create(&admin, stock("pallet-a4-portrait", "Вертикальная")).await;
    let id = sheet["id"].as_str().unwrap();
    let before = host_revision(&admin.app).await;
    let (status, list) = set_default(&admin, &sheet["id"]).await;
    assert_eq!(status, StatusCode::OK, "{list}");
    assert_eq!(list["defaultId"], id);
    assert_eq!(
        audit_trail(&admin.app, "pallet_sheet.default").await,
        vec![admin.row(
            "pallet_sheet.default",
            "org_profile",
            "1",
            json!({ "changed": ["templateId"], "templateId": { "from": null, "to": id } })
        )]
    );
    // A body without the field is not "no default": the default stays.
    let (status, refused) = admin.call("PUT", DEFAULT, Some(json!({}))).await;
    assert_eq!(
        (status, refused["error"]["code"].clone()),
        (StatusCode::BAD_REQUEST, json!("validation_failed"))
    );
    assert_eq!(stored(&admin).await.1.as_deref(), Some(id));
    let rows = audit_rows(&admin.app).await;
    let (status, refused) = admin
        .call(
            "PUT",
            &path(&sheet),
            Some(json!({ "enabled": false, "expectedRevision": 1 })),
        )
        .await;
    assert_eq!(
        conflict(status, &refused),
        (
            StatusCode::CONFLICT,
            json!("conflict"),
            json!("template_is_default")
        )
    );
    // A rename of the default is fine; only switching it off is refused.
    let (status, renamed) = admin
        .call(
            "PUT",
            &path(&sheet),
            Some(json!({ "name": "Основной", "expectedRevision": 1 })),
        )
        .await;
    assert_eq!(
        (status, renamed["revision"].clone()),
        (StatusCode::OK, json!(2))
    );
    let (status, refused) = admin.call("DELETE", &path(&sheet), None).await;
    assert_eq!(
        conflict(status, &refused),
        (
            StatusCode::CONFLICT,
            json!("conflict"),
            json!("template_is_default")
        )
    );
    assert_eq!(audit_rows(&admin.app).await, rows + 1, "only the rename");
    assert_eq!(stored(&admin).await.0.len(), 1);
    // Setting the same default again is quiet.
    let rows = audit_rows(&admin.app).await;
    let (status, _) = set_default(&admin, &sheet["id"]).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(audit_rows(&admin.app).await, rows);
    // None again, and the sheet can be switched off and deleted.
    let (status, none) = set_default(&admin, &Value::Null).await;
    assert_eq!(
        (status, none["defaultId"].clone()),
        (StatusCode::OK, Value::Null)
    );
    assert_eq!(
        audit_trail(&admin.app, "pallet_sheet.default").await[1],
        admin.row(
            "pallet_sheet.default",
            "org_profile",
            "1",
            json!({ "changed": ["templateId"], "templateId": { "from": id, "to": null } })
        )
    );
    let (status, _) = set_default(&admin, &Value::Null).await;
    assert_eq!(status, StatusCode::OK, "clearing none is quiet");
    assert_eq!(
        audit_trail(&admin.app, "pallet_sheet.default").await.len(),
        2
    );
    let (status, off) = admin
        .call(
            "PUT",
            &path(&sheet),
            Some(json!({ "enabled": false, "expectedRevision": 2 })),
        )
        .await;
    assert_eq!(
        (status, off["enabled"].clone()),
        (StatusCode::OK, json!(false))
    );
    let (status, _) = admin.call("DELETE", &path(&sheet), None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(
        audit_trail(&admin.app, "pallet_sheet.delete").await,
        vec![admin.row(
            "pallet_sheet.delete",
            "pallet_sheet",
            id,
            json!({ "name": "Основной" })
        )]
    );
    assert_eq!(stored(&admin).await, (vec![], None));
    assert_eq!(host_revision(&admin.app).await, before, "no feed revision");
}

#[tokio::test]
async fn a_disabled_sheet_is_not_the_default_and_an_unknown_one_either() {
    let admin = admin().await;
    let mut body = stock("pallet-a4-two-a5", "Две А5");
    body["enabled"] = json!(false);
    let sheet = create(&admin, body).await;
    let rows = audit_rows(&admin.app).await;
    let missing = json!("8f6d1c2e-3b4a-4c5d-9e8f-7a6b5c4d3e2f");
    for id in [sheet["id"].clone(), missing, json!("not a uuid")] {
        let (status, refused) = set_default(&admin, &id).await;
        assert_eq!(
            invalid(status, &refused),
            (
                StatusCode::BAD_REQUEST,
                json!("validation_failed"),
                json!("templateId")
            ),
            "{id}"
        );
    }
    // Not the shape: no templateId at all, or a stray field.
    for body in [json!({}), json!({ "templateId": null, "enabled": true })] {
        let (status, refused) = admin.call("PUT", DEFAULT, Some(body)).await;
        assert_eq!(
            (status, refused["error"]["code"].clone()),
            (StatusCode::BAD_REQUEST, json!("validation_failed"))
        );
    }
    assert_eq!(audit_rows(&admin.app).await, rows);
    assert_eq!(stored(&admin).await.1, None);
    // Once it is on, it can be the default.
    let (status, _) = admin
        .call(
            "PUT",
            &path(&sheet),
            Some(json!({ "enabled": true, "expectedRevision": 1 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = set_default(&admin, &sheet["id"]).await;
    assert_eq!(status, StatusCode::OK);
}

/// The helpers task 4 plans a shift with: the default only while enabled,
/// and a sheet to name only while it exists and is on.
#[tokio::test]
async fn the_default_and_the_check_see_only_an_enabled_sheet() {
    let admin = admin().await;
    let pool = &admin.app.state.pool;
    let mut conn = pool.acquire().await.unwrap();
    assert_eq!(default_sheet(&mut conn).await.unwrap(), None);
    let sheet = create(&admin, stock("pallet-a4-portrait", "Вертикальная")).await;
    let id = sheet["id"].as_str().unwrap();
    assert_eq!(
        default_sheet(&mut conn).await.unwrap(),
        None,
        "no default chosen"
    );
    set_default(&admin, &sheet["id"]).await;
    assert_eq!(default_sheet(&mut conn).await.unwrap().as_deref(), Some(id));
    // A default turned off behind the routes' back (the routes refuse it) is
    // no default for a new shift.
    sqlx::query("UPDATE pallet_sheet_templates SET enabled = 0")
        .execute(pool)
        .await
        .unwrap();
    assert_eq!(default_sheet(&mut conn).await.unwrap(), None);
    let check = markiro_host::routes::pallet_sheets::check_sheet(&mut conn, "palletSheetId", id)
        .await
        .expect_err("a disabled sheet");
    assert_eq!(
        check.details().and_then(|details| details.get("field")),
        Some(&json!("palletSheetId"))
    );
    let missing = markiro_host::routes::pallet_sheets::check_sheet(
        &mut conn,
        "palletSheetId",
        "8f6d1c2e-3b4a-4c5d-9e8f-7a6b5c4d3e2f",
    )
    .await;
    assert_eq!(missing.unwrap_err().code(), "validation_failed");
    sqlx::query("UPDATE pallet_sheet_templates SET enabled = 1")
        .execute(pool)
        .await
        .unwrap();
    markiro_host::routes::pallet_sheets::check_sheet(&mut conn, "palletSheetId", id)
        .await
        .expect("an enabled sheet");
}

#[tokio::test]
async fn a_sheet_a_planned_shift_names_is_not_deleted_but_an_opened_one_is() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let pallet = pallet_template(&admin).await;
    let sheet = create(&admin, stock("pallet-a4-portrait", "Вертикальная")).await;
    let id = sheet["id"].as_str().unwrap();
    // Five planned shifts: the ids are random, so only the host's order sorts.
    let mut shifts = Vec::new();
    for _ in 0..5 {
        let shift = plan_shift(&admin, pallet_shift_body(&setup, &pallet)).await;
        sqlx::query("UPDATE shifts SET pallet_sheet_template_id = ? WHERE id = ?")
            .bind(id)
            .bind(shift["id"].as_str().unwrap())
            .execute(&admin.app.state.pool)
            .await
            .unwrap();
        shifts.push(shift["id"].clone());
    }
    let rows = audit_rows(&admin.app).await;
    let (status, refused) = admin.call("DELETE", &path(&sheet), None).await;
    let mut sorted = shifts.clone();
    sorted.sort_by_key(|id| id.as_str().unwrap().to_owned());
    assert_eq!(
        (
            status,
            refused["error"]["code"].clone(),
            refused["error"]["details"].clone()
        ),
        (
            StatusCode::CONFLICT,
            json!("conflict"),
            json!({ "constraint": "template_in_use", "shiftIds": sorted })
        )
    );
    assert_eq!(audit_rows(&admin.app).await, rows);
    assert_eq!(stored(&admin).await.0.len(), 1);

    // The shifts open: the sheet now lives in their snapshots, the delete
    // goes through and the shifts keep what they were given.
    let station = station_id(&admin).await;
    for shift in &shifts {
        sqlx::query(
            "UPDATE shifts SET status = ?, snapshot = '{}', opened_at = ?, owner_device_id = ? \
             WHERE id = ?",
        )
        .bind("active")
        .bind(admin.app.state.timestamp())
        .bind(&station)
        .bind(shift.as_str().unwrap())
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    }
    // One of them closed: a past shift is no reason to keep the sheet either.
    sqlx::query(
        "UPDATE shifts SET status = 'closed', closed_at = ?1, closed_by_kind = 'device', \
         closed_by = ?2 WHERE id = ?3",
    )
    .bind(admin.app.state.timestamp())
    .bind(&station)
    .bind(shifts[0].as_str().unwrap())
    .execute(&admin.app.state.pool)
    .await
    .unwrap();
    let (status, body) = admin.call("DELETE", &path(&sheet), None).await;
    assert_eq!((status, body), (StatusCode::NO_CONTENT, Value::Null));
    let named: Vec<(String, Option<String>)> =
        sqlx::query_as("SELECT status, pallet_sheet_template_id FROM shifts ORDER BY status")
            .fetch_all(&admin.app.state.pool)
            .await
            .unwrap();
    assert_eq!(
        named,
        [("active", 4), ("closed", 1)]
            .iter()
            .flat_map(|(status, count)| {
                std::iter::repeat_n(((*status).to_owned(), Some(id.to_owned())), *count)
            })
            .collect::<Vec<_>>(),
        "a delete never rewrites a shift"
    );
    // Gone: a second delete finds nothing.
    let (status, _) = admin.call("DELETE", &path(&sheet), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(
        audit_trail(&admin.app, "pallet_sheet.delete").await.len(),
        1
    );
}

#[tokio::test]
async fn a_sheet_that_does_not_exist_is_not_found_to_delete() {
    let admin = admin().await;
    let rows = audit_rows(&admin.app).await;
    let (status, error) = admin
        .call(
            "DELETE",
            "/v1/office/pallet-sheets/8f6d1c2e-3b4a-4c5d-9e8f-7a6b5c4d3e2f",
            None,
        )
        .await;
    assert_eq!(
        (status, error["error"]["message"].clone()),
        (StatusCode::NOT_FOUND, json!("no such sheet"))
    );
    assert_eq!(audit_rows(&admin.app).await, rows);
}

#[tokio::test]
async fn a_technologist_keeps_the_sheets_too() {
    let admin = admin().await;
    let (token, id) = admin.technologist_session().await;
    let (status, sheet) = admin
        .call_as(
            &token,
            "POST",
            LIST,
            Some(stock("pallet-a4-portrait", "Вертикальная")),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{sheet}");
    let (status, _) = admin
        .call_as(
            &token,
            "PUT",
            DEFAULT,
            Some(json!({ "templateId": sheet["id"] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = admin
        .call_as(
            &token,
            "PUT",
            &path(&sheet),
            Some(json!({ "name": "Цех", "expectedRevision": 1 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = admin
        .call_as(&token, "PUT", DEFAULT, Some(json!({ "templateId": null })))
        .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = admin.call_as(&token, "DELETE", &path(&sheet), None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    // The audit names the technologist, not the administrator.
    assert_eq!(
        audit_trail(&admin.app, "pallet_sheet.create").await[0]
            .1
            .as_deref(),
        Some(id.as_str())
    );
}

#[tokio::test]
async fn nobody_without_an_office_session_touches_the_sheets() {
    let admin = admin().await;
    let sheet = create(&admin, stock("pallet-a4-portrait", "Вертикальная")).await;
    let before = stored(&admin).await;
    let rows = audit_rows(&admin.app).await;
    let item = path(&sheet);
    let calls: Vec<(&str, &str, Option<Value>)> = vec![
        ("GET", LIST, None),
        ("POST", LIST, Some(stock("pallet-a4-landscape", "x"))),
        (
            "PUT",
            &item,
            Some(json!({ "name": "x", "expectedRevision": 1 })),
        ),
        ("DELETE", &item, None),
        ("PUT", DEFAULT, Some(json!({ "templateId": null }))),
    ];
    for (method, uri, body) in calls {
        let build = |device: bool| {
            let builder = request(method, uri);
            let builder = if device {
                with_device(builder, &admin.key)
            } else {
                builder
            };
            match &body {
                Some(body) => support::app::json(builder, body.clone()),
                None => empty(builder),
            }
        };
        // A paired station, or a handheld's key alike, is a device and not
        // an office user.
        let (status, error) = admin.app.send(build(true)).await;
        assert_eq!(
            (status, error["error"]["code"].clone()),
            (StatusCode::UNAUTHORIZED, json!("unauthorized")),
            "{method} {uri}: {error}"
        );
        let (status, error) = admin.app.send(build(false)).await;
        assert_eq!(
            (status, error["error"]["details"]["credential"].clone()),
            (StatusCode::UNAUTHORIZED, json!("device")),
            "{method} {uri}: {error}"
        );
    }
    assert_eq!(stored(&admin).await, before);
    assert_eq!(audit_rows(&admin.app).await, rows);
}

/// A user turned off after the extractor passed must not write: every write
/// route reads the role again inside its own transaction.
#[tokio::test]
async fn a_user_turned_off_after_the_extractor_passed_writes_nothing() {
    let admin = admin().await;
    let sheet = create(&admin, stock("pallet-a4-portrait", "Вертикальная")).await;
    let item = path(&sheet);
    let writes: Vec<(&str, String, Option<Value>)> = vec![
        (
            "POST",
            LIST.to_owned(),
            Some(stock("pallet-a4-landscape", "Горизонтальная")),
        ),
        (
            "PUT",
            item.clone(),
            Some(json!({ "name": "x", "expectedRevision": 1 })),
        ),
        ("DELETE", item.clone(), None),
        (
            "PUT",
            DEFAULT.to_owned(),
            Some(json!({ "templateId": sheet["id"] })),
        ),
    ];
    let before = stored(&admin).await;
    for (index, (method, uri, body)) in writes.into_iter().enumerate() {
        let login_name = format!("second-{index}");
        let id = seed_office_user(&admin.app, &login_name, "technologist", "second password").await;
        let token = login(&admin.app, &admin.key, &login_name, "second password").await;
        let rows = audit_rows(&admin.app).await;
        turn_the_user_off_at_the_next_activity(&admin.app, &id).await;
        admin.app.clock.advance(time::Duration::minutes(2));
        let (status, error) = admin.call_as(&token, method, &uri, body).await;
        assert_eq!(
            (status, error["error"]["code"].clone()),
            (StatusCode::UNAUTHORIZED, json!("unauthorized")),
            "{method} {uri}: {error}"
        );
        assert_eq!(stored(&admin).await, before, "{method} {uri}");
        assert_eq!(audit_rows(&admin.app).await, rows, "{method} {uri}");
    }
}

/// The three statements the routes run on tables that grow search by an
/// index, never a scan of the table.
#[tokio::test]
async fn the_sheet_statements_search_by_an_index() {
    use markiro_host::routes::pallet_sheets::{
        BY_PRESET_SQL, DEFAULT_SHEET_SQL, PLANNED_SHIFTS_SQL,
    };
    let admin = admin().await;
    for (name, sql, index) in [
        (
            "preset",
            BY_PRESET_SQL,
            "sqlite_autoindex_pallet_sheet_templates",
        ),
        ("planned", PLANNED_SHIFTS_SQL, "shifts_planned_pallet_sheet"),
        ("default", DEFAULT_SHEET_SQL, "PRIMARY KEY"),
    ] {
        let plan: Vec<(i64, i64, i64, String)> =
            sqlx::query_as(&format!("EXPLAIN QUERY PLAN {sql}"))
                .bind("x")
                .fetch_all(&admin.app.state.pool)
                .await
                .unwrap();
        let steps: Vec<&str> = plan.iter().map(|(_, _, _, step)| step.as_str()).collect();
        assert!(
            steps.iter().all(|step| !step.starts_with("SCAN")),
            "{name}: {steps:?}"
        );
        assert!(
            steps.iter().any(|step| step.contains(index)),
            "{name} does not use {index}: {steps:?}"
        );
    }
}
