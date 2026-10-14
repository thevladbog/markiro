mod support;

use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{
    admin, audit_row, audit_rows, audit_trail, default_sheet_is, empty, host_revision,
    office_template, pair_device, pallet_shift_body, pallet_template, plan_shift, request,
    seed_office_user, shift_body, shift_setup, stock_sheet, turn_the_user_off_at_the_next_activity,
    with_device, Admin, ShiftSetup,
};

/// The record of `shift_body(setup)` planned at `rev`: the product's box
/// capacity, no plan and no counterparty, and no facts yet.
fn planned(id: &str, number: &str, setup: &ShiftSetup, rev: i64) -> Value {
    json!({
        "id": id, "number": number, "status": "planned", "mode": "aggregation",
        "palletsEnabled": false, "createdFrom": "office", "productId": setup.product,
        "lineId": setup.line, "counterpartyId": null, "productionDate": "2026-10-08",
        "plannedQty": null, "boxCapacity": 12, "boxTemplateId": setup.template,
        "palletBoxCapacity": null, "palletTemplateId": null, "palletSheetTemplateId": null,
        "ownerDeviceId": null, "openedAt": null, "closedAt": null, "closeReasonCode": null,
        "closeReasonText": null, "lateDataAt": null, "createdAt": "2026-09-21T14:13:20Z",
        "rev": rev,
        "totals": {
            "acceptedUnits": 0, "unitsInClosedBoxes": 0, "closedBoxes": 0, "openBoxes": 0,
            "lastFactAt": null, "deviceIds": [], "closedPallets": 0, "openPallets": 0
        }
    })
}

fn path(shift: &Value) -> String {
    format!("/v1/office/shifts/{}", shift["id"].as_str().unwrap())
}

fn refusal(body: &Value) -> (Value, Value) {
    (
        body["error"]["code"].clone(),
        body["error"]["details"].clone(),
    )
}

/// This station's own id, as the host has it.
async fn station_id(admin: &Admin) -> String {
    let (status, device) = admin
        .app
        .send(empty(with_device(request("GET", "/v1/device"), &admin.key)))
        .await;
    assert_eq!(status, StatusCode::OK, "{device}");
    device["id"].as_str().unwrap().to_owned()
}

/// Open a shift straight in its table, as if this station had entered it
/// (the station's entry comes with the device routes).
async fn open_directly(admin: &Admin, shift: &Value) {
    let device = station_id(admin).await;
    sqlx::query(
        "UPDATE shifts SET status = 'active', snapshot = '{}', opened_at = ?, \
         owner_device_id = ? WHERE id = ?",
    )
    .bind(admin.app.state.timestamp())
    .bind(&device)
    .bind(shift["id"].as_str().unwrap())
    .execute(&admin.app.state.pool)
    .await
    .unwrap();
}

/// Close a shift straight in its table, as if this station had opened and
/// closed it (the close comes with the routes of later tasks).
async fn close_directly(admin: &Admin, shift: &Value) {
    let device = station_id(admin).await;
    sqlx::query(
        "UPDATE shifts SET status = 'closed', snapshot = '{}', opened_at = ?1, \
         owner_device_id = ?2, closed_at = ?1, closed_by_kind = 'device', closed_by = ?2 \
         WHERE id = ?3",
    )
    .bind(admin.app.state.timestamp())
    .bind(&device)
    .bind(shift["id"].as_str().unwrap())
    .execute(&admin.app.state.pool)
    .await
    .unwrap();
}

#[tokio::test]
async fn an_administrator_plans_a_shift_and_reads_it_back() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let shift = plan_shift(&admin, shift_body(&setup)).await;
    let id = shift["id"].as_str().unwrap().to_owned();
    // The wizard took revision 1, the template 2 and the product 3.
    assert_eq!(shift, planned(&id, "OCT26-001", &setup, 4));
    assert_eq!(host_revision(&admin.app).await, 4);
    assert_eq!(
        audit_trail(&admin.app, "shift.create").await,
        vec![admin.row(
            "shift.create",
            "shift",
            &id,
            json!({
                "number": "OCT26-001", "productId": setup.product, "lineId": setup.line,
                "productionDate": "2026-10-08"
            })
        )]
    );
    let (status, one) = admin.call("GET", &path(&shift), None).await;
    assert_eq!((status, one), (StatusCode::OK, shift.clone()));
    let (status, list) = admin.call("GET", "/v1/office/shifts", None).await;
    assert_eq!((status, list), (StatusCode::OK, json!([shift])));
    let (status, missing) = admin
        .call("GET", "/v1/office/shifts/no-such-shift", None)
        .await;
    assert_eq!(
        (status, missing["error"]["code"].clone()),
        (StatusCode::NOT_FOUND, json!("not_found"))
    );
}

#[tokio::test]
async fn numbers_count_per_month_of_the_production_date() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let mut body = shift_body(&setup);
    let first = plan_shift(&admin, body.clone()).await;
    let second = plan_shift(&admin, body.clone()).await;
    body["productionDate"] = json!("2026-11-02");
    let november = plan_shift(&admin, body.clone()).await;
    body["productionDate"] = json!("2026-10-31");
    let third = plan_shift(&admin, body).await;
    assert_eq!(
        [&first, &second, &november, &third].map(|shift| shift["number"].clone()),
        [
            json!("OCT26-001"),
            json!("OCT26-002"),
            json!("NOV26-001"),
            json!("OCT26-003")
        ]
    );
    let counters: Vec<(String, i64)> =
        sqlx::query_as("SELECT month_key, last_seq FROM shift_number_counters ORDER BY month_key")
            .fetch_all(&admin.app.state.pool)
            .await
            .unwrap();
    assert_eq!(
        counters,
        vec![("NOV26".to_owned(), 1), ("OCT26".to_owned(), 3)]
    );
    // The list puts the newest production date first, and within one date
    // (the clock is fixed, so `created_at` ties) the higher number first. The
    // ids are random, so give the older shift the smaller id: only the number
    // then puts the newer one first, on every run.
    for (shift, id) in [
        (&first, "00000000-0000-4000-8000-000000000001"),
        (&second, "00000000-0000-4000-8000-000000000002"),
    ] {
        sqlx::query("UPDATE shifts SET id = ?1 WHERE id = ?2")
            .bind(id)
            .bind(shift["id"].as_str().unwrap())
            .execute(&admin.app.state.pool)
            .await
            .unwrap();
    }
    let (status, list) = admin.call("GET", "/v1/office/shifts", None).await;
    assert_eq!(status, StatusCode::OK, "{list}");
    assert_eq!(
        list.as_array()
            .unwrap()
            .iter()
            .map(|shift| shift["number"].clone())
            .collect::<Vec<_>>(),
        [
            json!("NOV26-001"),
            json!("OCT26-003"),
            json!("OCT26-002"),
            json!("OCT26-001")
        ]
    );
}

/// A box template scoped to the product's own group fits it; the plan names
/// the template and the shift keeps it.
#[tokio::test]
async fn a_box_template_scoped_to_the_products_group_fits_it() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    for codes in [json!([8]), json!([8, 15])] {
        let (status, template) = admin
            .call(
                "POST",
                "/v1/office/templates",
                Some(json!({
                    "name": "Короб молока", "purpose": "box", "enabled": true,
                    "chzProductGroupCodes": codes, "spec": { "widthMm": 58 }
                })),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{template}");
        let mut body = shift_body(&setup);
        body["boxTemplateId"] = template["id"].clone();
        let shift = plan_shift(&admin, body).await;
        assert_eq!(shift["boxTemplateId"], template["id"], "{codes}");
    }
}

/// A pallet template scoped to the product's own group fits it, planned or
/// switched on by an edit (a template that covers only another group does
/// not: `a_plan_with_pallets_needs_a_fitting_pallet_template_and_one_without_sends_neither`).
#[tokio::test]
async fn a_pallet_template_scoped_to_the_products_group_fits_it() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    for codes in [json!([8]), json!([8, 15])] {
        let template = office_template(&admin, "pallet", true, codes.clone()).await;
        let planned = plan_shift(&admin, pallet_shift_body(&setup, &template)).await;
        assert_eq!(planned["palletTemplateId"], json!(template), "{codes}");
        let plain = plan_shift(&admin, shift_body(&setup)).await;
        let (status, on) = admin
            .call(
                "PUT",
                &path(&plain),
                Some(json!({
                    "palletsEnabled": true, "palletTemplateId": template,
                    "expectedRev": plain["rev"]
                })),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{codes}: {on}");
        assert_eq!(on["palletTemplateId"], json!(template), "{codes}");
    }
}

/// The planning route re-reads the user's session and role inside the write
/// transaction, not only in the extractor: a user turned off after the
/// extractor read them as active (a trigger does it at the moment the
/// extractor records the session's activity) cannot plan a shift. The refusal
/// is the route's own and leaves no shift, no audit row, no revision and no
/// number drawn.
#[tokio::test]
async fn planning_stops_a_user_turned_off_after_the_extractor_passed() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let (tech, tech_id) = admin.technologist_session().await;
    let session_id: String = sqlx::query_scalar("SELECT id FROM office_sessions WHERE user_id = ?")
        .bind(&tech_id)
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    let revision = host_revision(&admin.app).await;
    let rows = audit_rows(&admin.app).await;
    turn_the_user_off_at_the_next_activity(&admin.app, &tech_id).await;
    // Let a minute pass, so that the extractor records activity.
    admin.app.clock.advance(time::Duration::minutes(2));
    let (status, error) = admin
        .call_as(&tech, "POST", "/v1/office/shifts", Some(shift_body(&setup)))
        .await;
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
        "{error}"
    );
    let active: i64 = sqlx::query_scalar("SELECT active FROM office_users WHERE id = ?")
        .bind(&tech_id)
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    assert_eq!(active, 0, "the trigger ran after the extractor");
    let sessions: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM office_sessions WHERE id = ?")
        .bind(&session_id)
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    assert_eq!(
        sessions, 1,
        "the refusal is the route's, not the extractor's"
    );
    let written: i64 = sqlx::query_scalar(
        "SELECT (SELECT COUNT(*) FROM shifts) + (SELECT COUNT(*) FROM shift_number_counters)",
    )
    .fetch_one(&admin.app.state.pool)
    .await
    .unwrap();
    assert_eq!(written, 0, "no shift and no number drawn");
    assert_eq!(host_revision(&admin.app).await, revision);
    assert_eq!(audit_rows(&admin.app).await, rows);
}

#[tokio::test]
async fn a_plan_takes_every_field_it_names() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let (status, counterparty) = admin
        .call(
            "POST",
            "/v1/office/counterparties",
            Some(json!({ "name": "ООО «Северный берег»", "gln": "4601234000017", "gs1Prefixes": [] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{counterparty}");
    let mut body = shift_body(&setup);
    body["lineId"] = json!(setup.other_line);
    body["boxCapacity"] = json!(6);
    body["plannedQty"] = json!(1200);
    body["counterpartyId"] = counterparty["id"].clone();
    body["mode"] = json!("aggregation");
    body["palletsEnabled"] = json!(false);
    let shift = plan_shift(&admin, body).await;
    assert_eq!(
        [
            shift["lineId"].clone(),
            shift["boxCapacity"].clone(),
            shift["plannedQty"].clone(),
            shift["counterpartyId"].clone()
        ],
        [
            json!(setup.other_line),
            json!(6),
            json!(1200),
            counterparty["id"].clone()
        ]
    );
}

#[tokio::test]
async fn a_technologist_plans_shifts_too_and_a_device_alone_reads_none() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let (token, technologist) = admin.technologist_session().await;
    let (status, shift) = admin
        .call_as(
            &token,
            "POST",
            "/v1/office/shifts",
            Some(shift_body(&setup)),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{shift}");
    let id = shift["id"].as_str().unwrap();
    assert_eq!(
        audit_trail(&admin.app, "shift.create").await,
        vec![audit_row(
            &technologist,
            "shift.create",
            "shift",
            id,
            json!({
                "number": "OCT26-001", "productId": setup.product, "lineId": setup.line,
                "productionDate": "2026-10-08"
            })
        )]
    );
    let (status, list) = admin
        .call_as(&token, "GET", "/v1/office/shifts", None)
        .await;
    assert_eq!((status, list), (StatusCode::OK, json!([shift])));
    // A device key opens no office route.
    for (method, path) in [
        ("GET", "/v1/office/shifts".to_owned()),
        ("GET", format!("/v1/office/shifts/{id}")),
        ("POST", "/v1/office/shifts".to_owned()),
    ] {
        let (status, body) = admin
            .app
            .send(empty(with_device(request(method, &path), &admin.key)))
            .await;
        assert_eq!(
            (status, body["error"]["details"]["credential"].clone()),
            (StatusCode::UNAUTHORIZED, json!("session")),
            "{method} {path}"
        );
    }
}

#[tokio::test]
async fn a_plan_needs_an_active_product_an_active_line_and_a_fitting_template() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let template = |purpose: &str, enabled: bool, codes: Value| {
        json!({
            "name": "Другой", "purpose": purpose, "enabled": enabled,
            "chzProductGroupCodes": codes, "spec": { "widthMm": 58 }
        })
    };
    let mut ids = Vec::new();
    for body in [
        template("pallet", true, Value::Null),
        template("box", false, Value::Null),
        template("box", true, json!([15])),
    ] {
        let (status, created) = admin.call("POST", "/v1/office/templates", Some(body)).await;
        assert_eq!(status, StatusCode::OK, "{created}");
        ids.push(created["id"].clone());
    }
    let (status, draft) = admin
        .call(
            "POST",
            "/v1/office/products",
            Some(json!({ "gtin14": "04600682000020", "name": "Кефир" })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{draft}");
    let (status, archived) = admin
        .call(
            "POST",
            "/v1/office/products",
            Some(json!({
                "gtin14": "04600682000037", "name": "Ряженка", "chzProductGroupCode": 8,
                "boxCapacity": 12, "palletBoxCapacity": 40
            })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{archived}");
    let mut archive = archived.clone();
    for computed in ["id", "status", "rev", "photoChecksum"] {
        archive.as_object_mut().unwrap().remove(computed);
    }
    archive["archived"] = json!(true);
    archive["expectedRev"] = archived["rev"].clone();
    let (status, body) = admin
        .call(
            "PUT",
            &format!("/v1/office/products/{}", archived["id"].as_str().unwrap()),
            Some(archive),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, line) = admin
        .call(
            "PUT",
            &format!("/v1/office/lines/{}", setup.other_line),
            Some(json!({ "archived": true, "expectedRev": 1 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{line}");
    let (status, counterparty) = admin
        .call(
            "POST",
            "/v1/office/counterparties",
            Some(json!({ "name": "ООО «Берег»", "gln": "4601234000017", "gs1Prefixes": [] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{counterparty}");
    let (status, body) = admin
        .call(
            "PUT",
            &format!(
                "/v1/office/counterparties/{}",
                counterparty["id"].as_str().unwrap()
            ),
            Some(json!({
                "name": "ООО «Берег»", "gln": "4601234000017", "gs1Prefixes": [],
                "archived": true, "expectedRev": counterparty["rev"]
            })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");

    let rows = audit_rows(&admin.app).await;
    let revision = host_revision(&admin.app).await;
    let field = |name: &str| (json!("validation_failed"), json!({ "field": name }));
    let inactive = (
        json!("conflict"),
        json!({ "constraint": "product_inactive" }),
    );
    for (change, expected) in [
        (
            json!({ "productId": "no-such-product" }),
            field("productId"),
        ),
        (json!({ "productId": draft["id"] }), inactive.clone()),
        (json!({ "productId": archived["id"] }), inactive),
        (json!({ "lineId": "no-such-line" }), field("lineId")),
        (json!({ "lineId": setup.other_line }), field("lineId")),
        (
            json!({ "counterpartyId": "no-such-counterparty" }),
            field("counterpartyId"),
        ),
        (
            json!({ "counterpartyId": counterparty["id"] }),
            field("counterpartyId"),
        ),
        (
            json!({ "boxTemplateId": "no-such-template" }),
            field("boxTemplateId"),
        ),
        (json!({ "boxTemplateId": ids[0] }), field("boxTemplateId")),
        (json!({ "boxTemplateId": ids[1] }), field("boxTemplateId")),
        (json!({ "boxTemplateId": ids[2] }), field("boxTemplateId")),
        (
            json!({ "productionDate": "2026-02-29" }),
            field("productionDate"),
        ),
        (
            json!({ "productionDate": " 2026-10-08" }),
            field("productionDate"),
        ),
        (json!({ "plannedQty": 0 }), field("plannedQty")),
        (json!({ "plannedQty": 10_000_001 }), field("plannedQty")),
        (json!({ "boxCapacity": 0 }), field("boxCapacity")),
        (json!({ "boxCapacity": 100_001 }), field("boxCapacity")),
        // A validation shift has no pallets (plan РЕЖ): refused on the flag,
        // before the pallet template, which fits here, is looked at.
        (
            json!({ "mode": "validation", "palletsEnabled": true, "palletTemplateId": ids[0] }),
            field("palletsEnabled"),
        ),
        (json!({ "palletsEnabled": true }), field("palletTemplateId")),
    ] {
        let mut body = shift_body(&setup);
        for (key, value) in change.as_object().unwrap() {
            body[key] = value.clone();
        }
        let (status, refused) = admin.call("POST", "/v1/office/shifts", Some(body)).await;
        let expected_status = if expected.0 == "conflict" {
            StatusCode::CONFLICT
        } else {
            StatusCode::BAD_REQUEST
        };
        assert_eq!(
            (status, refusal(&refused)),
            (expected_status, expected),
            "{change}"
        );
    }
    // A field the request may not carry, and a mode no build knows.
    for change in [
        json!({ "status": "active" }),
        json!({ "number": "OCT26-001" }),
        json!({ "mode": "pallets" }),
        json!({ "plannedQty": -1 }),
    ] {
        let mut body = shift_body(&setup);
        for (key, value) in change.as_object().unwrap() {
            body[key] = value.clone();
        }
        let (status, refused) = admin.call("POST", "/v1/office/shifts", Some(body)).await;
        assert_eq!(
            (status, refused["error"]["code"].clone()),
            (StatusCode::BAD_REQUEST, json!("validation_failed")),
            "{change}"
        );
        assert!(refused["error"]["details"].is_null(), "{change}: {refused}");
    }
    // Nothing was written: no row, no revision, no number drawn.
    assert_eq!(audit_rows(&admin.app).await, rows);
    assert_eq!(host_revision(&admin.app).await, revision);
    let (_, list) = admin.call("GET", "/v1/office/shifts", None).await;
    assert_eq!(list, json!([]));
    let counters: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM shift_number_counters")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    assert_eq!(counters, 0);
}

#[tokio::test]
async fn the_list_holds_open_shifts_and_recent_closed_ones_or_a_period() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    // The host's clock reads 2026-09-21, so the last 31 days start on
    // 2026-08-21.
    let mut shifts = Vec::new();
    for date in ["2026-01-10", "2026-08-20", "2026-08-21", "2026-12-01"] {
        let mut body = shift_body(&setup);
        body["productionDate"] = json!(date);
        shifts.push(plan_shift(&admin, body).await);
    }
    close_directly(&admin, &shifts[1]).await;
    close_directly(&admin, &shifts[2]).await;
    let read = |shift: &Value| shift["id"].clone();
    let ids = |list: &Value| -> Vec<Value> { list.as_array().unwrap().iter().map(read).collect() };

    let (status, list) = admin.call("GET", "/v1/office/shifts", None).await;
    assert_eq!(status, StatusCode::OK, "{list}");
    // Newest production date first; the planned shift of January stays.
    assert_eq!(
        ids(&list),
        vec![read(&shifts[3]), read(&shifts[2]), read(&shifts[0])]
    );
    let period = |query: &str| format!("/v1/office/shifts?{query}");
    for (query, expected) in [
        (
            "from=2026-01-01&to=2026-08-20",
            vec![read(&shifts[1]), read(&shifts[0])],
        ),
        ("from=2026-08-21", vec![read(&shifts[3]), read(&shifts[2])]),
        ("to=2026-01-10", vec![read(&shifts[0])]),
        ("from=2026-08-20&to=2026-08-20", vec![read(&shifts[1])]),
    ] {
        let (status, list) = admin.call("GET", &period(query), None).await;
        assert_eq!((status, ids(&list)), (StatusCode::OK, expected), "{query}");
    }
    for (query, field) in [
        ("from=2026-02-30", Some("from")),
        ("to=26-01-01", Some("to")),
        ("from=2026-09-02&to=2026-09-01", Some("to")),
        ("status=closed", None),
    ] {
        let (status, refused) = admin.call("GET", &period(query), None).await;
        assert_eq!(
            (status, refused["error"]["details"]["field"].as_str()),
            (StatusCode::BAD_REQUEST, field),
            "{query}"
        );
    }
}

/// A counterparty in use; returns its id.
async fn counterparty(admin: &Admin, name: &str) -> Value {
    let (status, created) = admin
        .call(
            "POST",
            "/v1/office/counterparties",
            Some(json!({ "name": name, "gln": "4601234000017", "gs1Prefixes": [] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    created
}

#[tokio::test]
async fn a_planned_shift_changes_what_is_sent_and_keeps_its_number() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let berth = counterparty(&admin, "ООО «Северный берег»").await;
    let shift = plan_shift(&admin, shift_body(&setup)).await;
    let id = shift["id"].as_str().unwrap().to_owned();
    let (status, updated) = admin
        .call(
            "PUT",
            &path(&shift),
            Some(json!({
                "lineId": setup.other_line, "productionDate": "2026-11-03", "boxCapacity": 6,
                "plannedQty": 1200, "counterpartyId": berth["id"], "expectedRev": 5
            })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{updated}");
    let mut expected = planned(&id, "OCT26-001", &setup, 6);
    for (key, value) in [
        ("lineId", json!(setup.other_line)),
        ("productionDate", json!("2026-11-03")),
        ("boxCapacity", json!(6)),
        ("plannedQty", json!(1200)),
        ("counterpartyId", berth["id"].clone()),
    ] {
        expected[key] = value;
    }
    assert_eq!(updated, expected);
    assert_eq!(
        audit_trail(&admin.app, "shift.update").await,
        vec![admin.row(
            "shift.update",
            "shift",
            &id,
            json!({
                "changed": ["lineId", "productionDate", "boxCapacity", "plannedQty", "counterpartyId"],
                "lineId": { "from": setup.line, "to": setup.other_line },
                "productionDate": { "from": "2026-10-08", "to": "2026-11-03" },
                "boxCapacity": { "from": 12, "to": 6 },
                "plannedQty": { "from": null, "to": 1200 },
                "counterpartyId": { "from": null, "to": berth["id"] },
            })
        )]
    );
    // `null` clears the plan and the counterparty; a field left out stays.
    let (status, cleared) = admin
        .call(
            "PUT",
            &path(&shift),
            Some(json!({ "plannedQty": null, "counterpartyId": null, "expectedRev": 6 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{cleared}");
    assert_eq!(
        [
            cleared["plannedQty"].clone(),
            cleared["counterpartyId"].clone(),
            cleared["lineId"].clone(),
            cleared["rev"].clone()
        ],
        [Value::Null, Value::Null, json!(setup.other_line), json!(7)]
    );
    // The same values again change nothing: no revision, no row.
    let rows = audit_rows(&admin.app).await;
    let (status, same) = admin
        .call(
            "PUT",
            &path(&shift),
            Some(json!({ "lineId": setup.other_line, "boxCapacity": 6, "expectedRev": 7 })),
        )
        .await;
    assert_eq!((status, same), (StatusCode::OK, cleared.clone()));
    assert_eq!(host_revision(&admin.app).await, 7);
    assert_eq!(audit_rows(&admin.app).await, rows);
    // An older revision and one ahead of the record are both stale.
    for expected_rev in [6, 8] {
        let (status, refused) = admin
            .call(
                "PUT",
                &path(&shift),
                Some(json!({ "plannedQty": 5, "expectedRev": expected_rev })),
            )
            .await;
        assert_eq!(
            (status, refusal(&refused)),
            (
                StatusCode::CONFLICT,
                (json!("stale_revision"), json!({ "currentRev": 7 }))
            )
        );
    }
    // A technologist edits too.
    let token = admin.technologist().await;
    let (status, edited) = admin
        .call_as(
            &token,
            "PUT",
            &path(&shift),
            Some(json!({ "plannedQty": 5, "expectedRev": 7 })),
        )
        .await;
    assert_eq!(
        (status, edited["plannedQty"].clone()),
        (StatusCode::OK, json!(5))
    );
}

/// Changing the template of a planned shift to one scoped to the product's own
/// group is stored, read back and audited with the old and the new id; the
/// fit check runs against the product's group, not another.
#[tokio::test]
async fn a_planned_shifts_template_change_is_stored_read_back_and_audited() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let (status, scoped) = admin
        .call(
            "POST",
            "/v1/office/templates",
            Some(json!({
                "name": "Короб молока", "purpose": "box", "enabled": true,
                "chzProductGroupCodes": [8], "spec": { "widthMm": 58 }
            })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{scoped}");
    let shift = plan_shift(&admin, shift_body(&setup)).await;
    let id = shift["id"].as_str().unwrap().to_owned();
    let (status, updated) = admin
        .call(
            "PUT",
            &path(&shift),
            Some(json!({ "boxTemplateId": scoped["id"], "expectedRev": shift["rev"] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{updated}");
    let mut expected = planned(&id, "OCT26-001", &setup, shift["rev"].as_i64().unwrap() + 1);
    expected["boxTemplateId"] = scoped["id"].clone();
    assert_eq!(updated, expected);
    let (status, read_back) = admin.call("GET", &path(&shift), None).await;
    assert_eq!(status, StatusCode::OK, "{read_back}");
    assert_eq!(read_back, expected);
    assert_eq!(
        audit_trail(&admin.app, "shift.update").await,
        vec![admin.row(
            "shift.update",
            "shift",
            &id,
            json!({
                "changed": ["boxTemplateId"],
                "boxTemplateId": { "from": setup.template, "to": scoped["id"] },
            })
        )]
    );
}

#[tokio::test]
async fn an_edit_checks_a_changed_line_template_or_counterparty_and_keeps_unchanged_ones() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let berth = counterparty(&admin, "ООО «Берег»").await;
    let (status, other) = admin
        .call(
            "POST",
            "/v1/office/templates",
            Some(json!({ "name": "Пиво", "purpose": "box", "enabled": true,
                "chzProductGroupCodes": [15], "spec": { "widthMm": 58 } })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{other}");
    let mut body = shift_body(&setup);
    body["counterpartyId"] = berth["id"].clone();
    let shift = plan_shift(&admin, body).await;
    // The line, the template and the counterparty go out of use afterwards.
    let (status, line) = admin
        .call(
            "PUT",
            &format!("/v1/office/lines/{}", setup.line),
            Some(json!({ "archived": true, "expectedRev": 1 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{line}");
    let (status, template) = admin
        .call(
            "PUT",
            &format!("/v1/office/templates/{}", setup.template),
            Some(json!({ "enabled": false, "expectedRev": 2 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{template}");
    let (status, archived) = admin
        .call(
            "PUT",
            &format!(
                "/v1/office/counterparties/{}",
                berth["id"].as_str().unwrap()
            ),
            Some(
                json!({ "name": "ООО «Берег»", "gln": "4601234000017", "gs1Prefixes": [],
                "archived": true, "expectedRev": berth["rev"] }),
            ),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{archived}");
    // An edit that keeps them all still goes through.
    let rev = shift["rev"].as_i64().unwrap();
    let (status, kept) = admin
        .call(
            "PUT",
            &path(&shift),
            Some(json!({
                "lineId": setup.line, "boxTemplateId": setup.template,
                "counterpartyId": berth["id"], "plannedQty": 100, "expectedRev": rev
            })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{kept}");
    let rev = kept["rev"].as_i64().unwrap();
    let rows = audit_rows(&admin.app).await;
    let field = |name: &str| (json!("validation_failed"), json!({ "field": name }));
    let (status, line_two) = admin
        .call(
            "PUT",
            &format!("/v1/office/lines/{}", setup.other_line),
            Some(json!({ "archived": true, "expectedRev": 1 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{line_two}");
    let rows = rows + 1;
    for (change, expected) in [
        (json!({ "lineId": setup.other_line }), field("lineId")),
        (json!({ "lineId": "no-such-line" }), field("lineId")),
        (
            json!({ "boxTemplateId": other["id"] }),
            field("boxTemplateId"),
        ),
        (
            json!({ "boxTemplateId": "no-such-template" }),
            field("boxTemplateId"),
        ),
        (
            json!({ "counterpartyId": "no-such-counterparty" }),
            field("counterpartyId"),
        ),
        (
            json!({ "productionDate": "2026-13-01" }),
            field("productionDate"),
        ),
        (json!({ "plannedQty": 0 }), field("plannedQty")),
        (json!({ "boxCapacity": 100_001 }), field("boxCapacity")),
        (
            json!({ "mode": "validation", "palletsEnabled": true }),
            field("palletsEnabled"),
        ),
        (json!({ "palletsEnabled": true }), field("palletTemplateId")),
    ] {
        let mut body = change.clone();
        body["expectedRev"] = json!(rev);
        let (status, refused) = admin.call("PUT", &path(&shift), Some(body)).await;
        assert_eq!(
            (status, refusal(&refused)),
            (StatusCode::BAD_REQUEST, expected),
            "{change}"
        );
    }
    // The product never changes: it is no field of an edit.
    let (status, refused) = admin
        .call(
            "PUT",
            &path(&shift),
            Some(json!({ "productId": setup.product, "expectedRev": rev })),
        )
        .await;
    assert_eq!(
        (status, refused["error"]["code"].clone()),
        (StatusCode::BAD_REQUEST, json!("validation_failed"))
    );
    assert!(refused["error"]["details"].is_null(), "{refused}");
    let (status, missing) = admin
        .call(
            "PUT",
            "/v1/office/shifts/no-such-shift",
            Some(json!({ "plannedQty": 1, "expectedRev": 1 })),
        )
        .await;
    assert_eq!(
        (status, missing["error"]["code"].clone()),
        (StatusCode::NOT_FOUND, json!("not_found"))
    );
    assert_eq!(audit_rows(&admin.app).await, rows);
    // A changed template also needs the product still in use: once the
    // product is archived, a template scoped to its group is refused, while
    // an edit that keeps the template still goes through.
    let (status, scoped) = admin
        .call(
            "POST",
            "/v1/office/templates",
            Some(
                json!({ "name": "Короб молока", "purpose": "box", "enabled": true,
                "chzProductGroupCodes": [8], "spec": { "widthMm": 58 } }),
            ),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{scoped}");
    let (status, list) = admin.call("GET", "/v1/office/products", None).await;
    assert_eq!(status, StatusCode::OK, "{list}");
    let mut archive = list
        .as_array()
        .unwrap()
        .iter()
        .find(|product| product["id"] == json!(setup.product))
        .cloned()
        .expect("the product is listed");
    let product_rev = archive["rev"].clone();
    for computed in ["id", "status", "rev", "photoChecksum"] {
        archive.as_object_mut().unwrap().remove(computed);
    }
    archive["archived"] = json!(true);
    archive["expectedRev"] = product_rev;
    let (status, body) = admin
        .call(
            "PUT",
            &format!("/v1/office/products/{}", setup.product),
            Some(archive),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let rows = audit_rows(&admin.app).await;
    let (status, refused) = admin
        .call(
            "PUT",
            &path(&shift),
            Some(json!({ "boxTemplateId": scoped["id"], "expectedRev": rev })),
        )
        .await;
    assert_eq!(
        (status, refusal(&refused)),
        (
            StatusCode::CONFLICT,
            (
                json!("conflict"),
                json!({ "constraint": "product_inactive" })
            )
        )
    );
    assert_eq!(audit_rows(&admin.app).await, rows);
    let (status, kept) = admin
        .call(
            "PUT",
            &path(&shift),
            Some(json!({ "boxTemplateId": setup.template, "plannedQty": 7, "expectedRev": rev })),
        )
        .await;
    assert_eq!(
        (status, kept["plannedQty"].clone()),
        (StatusCode::OK, json!(7)),
        "{kept}"
    );
}

#[tokio::test]
async fn an_active_shift_takes_only_its_plan_and_a_closed_one_nothing() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let berth = counterparty(&admin, "ООО «Причал»").await;
    let shift = plan_shift(&admin, shift_body(&setup)).await;
    let id = shift["id"].as_str().unwrap().to_owned();
    open_directly(&admin, &shift).await;
    let (status, planned_more) = admin
        .call(
            "PUT",
            &path(&shift),
            Some(json!({ "plannedQty": 900, "lineId": setup.line, "expectedRev": shift["rev"] })),
        )
        .await;
    assert_eq!(
        (status, planned_more["plannedQty"].clone()),
        (StatusCode::OK, json!(900))
    );
    assert_eq!(
        audit_trail(&admin.app, "shift.update").await,
        vec![admin.row(
            "shift.update",
            "shift",
            &id,
            json!({ "changed": ["plannedQty"], "plannedQty": { "from": null, "to": 900 } })
        )]
    );
    let status_conflict = |status: &str| json!({ "constraint": "shift_status", "status": status });
    for change in [
        json!({ "boxCapacity": 6 }),
        json!({ "lineId": setup.other_line }),
        json!({ "productionDate": "2026-10-09" }),
        json!({ "counterpartyId": berth["id"] }),
        json!({ "counterpartyId": null, "plannedQty": 800, "boxTemplateId": "other" }),
    ] {
        let mut body = change.clone();
        body["expectedRev"] = planned_more["rev"].clone();
        let (status, refused) = admin.call("PUT", &path(&shift), Some(body)).await;
        assert_eq!(
            (status, refusal(&refused)),
            (
                StatusCode::CONFLICT,
                (json!("conflict"), status_conflict("active"))
            ),
            "{change}"
        );
    }
    close_directly(&admin, &shift).await;
    let (status, refused) = admin
        .call(
            "PUT",
            &path(&shift),
            Some(json!({ "plannedQty": 1, "expectedRev": planned_more["rev"] })),
        )
        .await;
    assert_eq!(
        (status, refusal(&refused)),
        (
            StatusCode::CONFLICT,
            (json!("conflict"), status_conflict("closed"))
        )
    );
}

/// The office plans a validation shift (plan РЕЖ, Р1): stored and read back
/// with its mode, audited with it, and never with pallets, so never with an
/// A4 sheet either, not even the organization's default one.
#[tokio::test]
async fn the_office_plans_a_validation_shift_without_pallets() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let sheet = stock_sheet(&admin, "pallet-a4-portrait").await;
    default_sheet_is(&admin, &sheet).await;
    let mut body = shift_body(&setup);
    body["mode"] = json!("validation");
    let shift = plan_shift(&admin, body.clone()).await;
    let id = shift["id"].as_str().unwrap().to_owned();
    let mut expected = planned(&id, "OCT26-001", &setup, shift["rev"].as_i64().unwrap());
    expected["mode"] = json!("validation");
    assert_eq!(shift, expected);
    let (status, read_back) = admin.call("GET", &path(&shift), None).await;
    assert_eq!((status, read_back), (StatusCode::OK, expected));
    let mode: String = sqlx::query_scalar("SELECT mode FROM shifts WHERE id = ?")
        .bind(&id)
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    assert_eq!(mode, "validation");
    assert_eq!(
        audit_trail(&admin.app, "shift.create").await,
        vec![admin.row(
            "shift.create",
            "shift",
            &id,
            json!({
                "number": "OCT26-001", "productId": setup.product, "lineId": setup.line,
                "productionDate": "2026-10-08", "mode": "validation"
            })
        )]
    );
    // Pallets, a pallet field or an A4 sheet: each refused, nothing written.
    let template = pallet_template(&admin).await;
    let rows = audit_rows(&admin.app).await;
    let revision = host_revision(&admin.app).await;
    let field = |name: &str| (json!("validation_failed"), json!({ "field": name }));
    for (change, expected) in [
        (json!({ "palletsEnabled": true }), field("palletsEnabled")),
        (
            json!({ "palletsEnabled": true, "palletTemplateId": template }),
            field("palletsEnabled"),
        ),
        (
            json!({ "palletTemplateId": template }),
            field("palletTemplateId"),
        ),
        (
            json!({ "palletSheetTemplateId": sheet }),
            field("palletSheetTemplateId"),
        ),
    ] {
        let mut refused_body = body.clone();
        for (key, value) in change.as_object().unwrap() {
            refused_body[key] = value.clone();
        }
        let (status, refused) = admin
            .call("POST", "/v1/office/shifts", Some(refused_body))
            .await;
        assert_eq!(
            (status, refusal(&refused)),
            (StatusCode::BAD_REQUEST, expected),
            "{change}"
        );
    }
    assert_eq!(audit_rows(&admin.app).await, rows);
    assert_eq!(host_revision(&admin.app).await, revision);
}

/// A planned shift changes its mode (plan РЕЖ, Р1): to validation only
/// without pallets, which the same edit may turn off; the change is audited
/// with its `{ from, to }`. A validation shift takes no pallets by an edit,
/// and an active shift keeps its mode (`shift_status`).
#[tokio::test]
async fn a_planned_shift_changes_its_mode_and_an_active_one_keeps_it() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let template = pallet_template(&admin).await;
    let sheet = stock_sheet(&admin, "pallet-a4-portrait").await;
    default_sheet_is(&admin, &sheet).await;
    let field = |name: &str| (json!("validation_failed"), json!({ "field": name }));

    // Pallets on: validation is refused until the same edit turns them off.
    let pallets = plan_shift(&admin, pallet_shift_body(&setup, &template)).await;
    assert_eq!(pallets["palletSheetTemplateId"], json!(sheet));
    let rows = audit_rows(&admin.app).await;
    let revision = host_revision(&admin.app).await;
    let (status, refused) = admin
        .call(
            "PUT",
            &path(&pallets),
            Some(json!({ "mode": "validation", "expectedRev": pallets["rev"] })),
        )
        .await;
    assert_eq!(
        (status, refusal(&refused)),
        (StatusCode::BAD_REQUEST, field("palletsEnabled"))
    );
    assert_eq!(audit_rows(&admin.app).await, rows);
    assert_eq!(host_revision(&admin.app).await, revision);
    let (status, switched) = admin
        .call(
            "PUT",
            &path(&pallets),
            Some(json!({
                "mode": "validation", "palletsEnabled": false, "expectedRev": pallets["rev"]
            })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{switched}");
    assert_eq!(
        [
            switched["mode"].clone(),
            switched["palletsEnabled"].clone(),
            switched["palletTemplateId"].clone(),
            switched["palletBoxCapacity"].clone(),
            switched["palletSheetTemplateId"].clone(),
        ],
        [
            json!("validation"),
            json!(false),
            Value::Null,
            Value::Null,
            Value::Null
        ]
    );
    let pallets_id = pallets["id"].as_str().unwrap();
    assert_eq!(
        audit_trail(&admin.app, "shift.update").await,
        vec![admin.row(
            "shift.update",
            "shift",
            pallets_id,
            json!({
                "changed": [
                    "mode", "palletsEnabled", "palletBoxCapacity", "palletTemplateId",
                    "palletSheetTemplateId"
                ],
                "mode": { "from": "aggregation", "to": "validation" },
                "palletsEnabled": { "from": true, "to": false },
                "palletBoxCapacity": { "from": 40, "to": null },
                "palletTemplateId": { "from": template, "to": null },
                "palletSheetTemplateId": { "from": sheet, "to": null },
            })
        )]
    );
    // A validation shift takes no pallets by an edit, nor an A4 sheet; the
    // default sheet (`null`) asks for nothing and passes.
    let rows = audit_rows(&admin.app).await;
    for (change, expected) in [
        (
            json!({ "palletsEnabled": true, "palletTemplateId": template }),
            field("palletsEnabled"),
        ),
        (json!({ "palletsEnabled": true }), field("palletsEnabled")),
        (
            json!({ "palletSheetTemplateId": sheet }),
            field("palletSheetTemplateId"),
        ),
    ] {
        let mut body = change.clone();
        body["expectedRev"] = switched["rev"].clone();
        let (status, refused) = admin.call("PUT", &path(&switched), Some(body)).await;
        assert_eq!(
            (status, refusal(&refused)),
            (StatusCode::BAD_REQUEST, expected),
            "{change}"
        );
    }
    let (status, same) = admin
        .call(
            "PUT",
            &path(&switched),
            Some(json!({ "palletSheetTemplateId": null, "expectedRev": switched["rev"] })),
        )
        .await;
    assert_eq!((status, same), (StatusCode::OK, switched.clone()));
    assert_eq!(audit_rows(&admin.app).await, rows);
    // Back to aggregation, pallets turned on in the same edit.
    let (status, back) = admin
        .call(
            "PUT",
            &path(&switched),
            Some(json!({
                "mode": "aggregation", "palletsEnabled": true, "palletTemplateId": template,
                "expectedRev": switched["rev"]
            })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{back}");
    assert_eq!(
        [back["mode"].clone(), back["palletsEnabled"].clone()],
        [json!("aggregation"), json!(true)]
    );

    // Without pallets the mode alone changes, named alone in the row.
    let plain = plan_shift(&admin, shift_body(&setup)).await;
    let plain_id = plain["id"].as_str().unwrap().to_owned();
    let (status, validation) = admin
        .call(
            "PUT",
            &path(&plain),
            Some(json!({ "mode": "validation", "expectedRev": plain["rev"] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{validation}");
    let mut expected = planned(
        &plain_id,
        "OCT26-002",
        &setup,
        validation["rev"].as_i64().unwrap(),
    );
    expected["mode"] = json!("validation");
    assert_eq!(validation, expected);
    assert_eq!(
        audit_trail(&admin.app, "shift.update")
            .await
            .last()
            .cloned(),
        Some(admin.row(
            "shift.update",
            "shift",
            &plain_id,
            json!({
                "changed": ["mode"],
                "mode": { "from": "aggregation", "to": "validation" },
            })
        ))
    );
    // The same mode again changes nothing.
    let rows = audit_rows(&admin.app).await;
    let revision = host_revision(&admin.app).await;
    let (status, same) = admin
        .call(
            "PUT",
            &path(&plain),
            Some(json!({ "mode": "validation", "expectedRev": validation["rev"] })),
        )
        .await;
    assert_eq!((status, same), (StatusCode::OK, validation.clone()));
    assert_eq!(audit_rows(&admin.app).await, rows);
    assert_eq!(host_revision(&admin.app).await, revision);

    // Open, the shift keeps its mode either way; its plan still changes.
    open_directly(&admin, &validation).await;
    let status_conflict = json!({ "constraint": "shift_status", "status": "active" });
    for change in [
        json!({ "mode": "aggregation" }),
        json!({ "mode": "aggregation", "plannedQty": 10 }),
    ] {
        let mut body = change.clone();
        body["expectedRev"] = validation["rev"].clone();
        let (status, refused) = admin.call("PUT", &path(&validation), Some(body)).await;
        assert_eq!(
            (status, refusal(&refused)),
            (
                StatusCode::CONFLICT,
                (json!("conflict"), status_conflict.clone())
            ),
            "{change}"
        );
    }
    assert_eq!(audit_rows(&admin.app).await, rows);
    let (status, more) = admin
        .call(
            "PUT",
            &path(&validation),
            Some(json!({
                "mode": "validation", "plannedQty": 10, "expectedRev": validation["rev"]
            })),
        )
        .await;
    assert_eq!(
        (status, more["mode"].clone(), more["plannedQty"].clone()),
        (StatusCode::OK, json!("validation"), json!(10)),
        "{more}"
    );
    // An active shift's mode and pallets are fixed: the refusal is its status,
    // before the rules of the mode it would have (a validation shift with
    // pallets) are looked at.
    let rows = audit_rows(&admin.app).await;
    let mut body = json!({ "palletsEnabled": true, "palletTemplateId": template });
    body["expectedRev"] = more["rev"].clone();
    let (status, refused) = admin.call("PUT", &path(&more), Some(body)).await;
    assert_eq!(
        (status, refusal(&refused)),
        (
            StatusCode::CONFLICT,
            (json!("conflict"), status_conflict.clone())
        ),
        "an active validation shift takes no pallets"
    );
    open_directly(&admin, &back).await;
    let (status, refused) = admin
        .call(
            "PUT",
            &path(&back),
            Some(json!({ "mode": "validation", "expectedRev": back["rev"] })),
        )
        .await;
    assert_eq!(
        (status, refusal(&refused)),
        (StatusCode::CONFLICT, (json!("conflict"), status_conflict)),
        "an active pallet shift does not become a validation one"
    );
    assert_eq!(audit_rows(&admin.app).await, rows);
}

#[tokio::test]
async fn only_a_planned_shift_is_deleted() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let shift = plan_shift(&admin, shift_body(&setup)).await;
    let id = shift["id"].as_str().unwrap().to_owned();
    let (status, body) = admin.call("DELETE", &path(&shift), None).await;
    assert_eq!((status, body), (StatusCode::NO_CONTENT, Value::Null));
    assert_eq!(host_revision(&admin.app).await, 5);
    assert_eq!(
        audit_trail(&admin.app, "shift.delete").await,
        vec![admin.row(
            "shift.delete",
            "shift",
            &id,
            json!({ "number": "OCT26-001" })
        )]
    );
    for method in ["GET", "DELETE"] {
        let (status, missing) = admin.call(method, &path(&shift), None).await;
        assert_eq!(
            (status, missing["error"]["code"].clone()),
            (StatusCode::NOT_FOUND, json!("not_found")),
            "{method}"
        );
    }
    // The number is not drawn again.
    let next = plan_shift(&admin, shift_body(&setup)).await;
    assert_eq!(next["number"], "OCT26-002");
    // An open shift and a closed one stay.
    open_directly(&admin, &next).await;
    let token = admin.technologist().await;
    let (status, refused) = admin.call_as(&token, "DELETE", &path(&next), None).await;
    assert_eq!(
        (status, refusal(&refused)),
        (
            StatusCode::CONFLICT,
            (
                json!("conflict"),
                json!({ "constraint": "shift_status", "status": "active" })
            )
        )
    );
    close_directly(&admin, &next).await;
    let (status, refused) = admin.call("DELETE", &path(&next), None).await;
    assert_eq!(
        (status, refusal(&refused)),
        (
            StatusCode::CONFLICT,
            (
                json!("conflict"),
                json!({ "constraint": "shift_status", "status": "closed" })
            )
        )
    );
    // A technologist deletes a planned one.
    let third = plan_shift(&admin, shift_body(&setup)).await;
    let (status, _) = admin.call_as(&token, "DELETE", &path(&third), None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn office_create_edit_and_delete_each_wake_the_streams_with_their_revision() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    // A station reads its shifts only after a revision event, so a write that
    // takes a revision without waking the streams hides the shift (or its
    // deletion) from the line until some other write comes.
    let mut wake = admin.app.state.revisions.subscribe();
    assert!(!wake.has_changed().unwrap());
    let shift = plan_shift(&admin, shift_body(&setup)).await;
    let created = host_revision(&admin.app).await;
    assert_eq!(shift["rev"], json!(created));
    assert!(wake.has_changed().unwrap(), "the create wakes the streams");
    assert_eq!(*wake.borrow_and_update(), created);

    // A change that changes nothing takes no revision and wakes nobody.
    let (status, same) = admin
        .call(
            "PUT",
            &path(&shift),
            Some(json!({ "boxCapacity": 12, "expectedRev": created })),
        )
        .await;
    assert_eq!((status, same), (StatusCode::OK, shift.clone()));
    assert!(!wake.has_changed().unwrap());

    let (status, updated) = admin
        .call(
            "PUT",
            &path(&shift),
            Some(json!({ "plannedQty": 600, "expectedRev": created })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{updated}");
    assert_eq!(updated["rev"], json!(created + 1));
    assert!(wake.has_changed().unwrap(), "the edit wakes the streams");
    assert_eq!(*wake.borrow_and_update(), created + 1);
    assert_eq!(host_revision(&admin.app).await, created + 1);

    let (status, _) = admin.call("DELETE", &path(&shift), None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert!(wake.has_changed().unwrap(), "the delete wakes the streams");
    assert_eq!(*wake.borrow_and_update(), created + 2);
    assert_eq!(host_revision(&admin.app).await, created + 2);
}

#[tokio::test]
async fn a_template_that_a_planned_shift_names_is_not_deleted() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let first = plan_shift(&admin, shift_body(&setup)).await;
    let second = plan_shift(&admin, shift_body(&setup)).await;
    let template = format!("/v1/office/templates/{}", setup.template);
    let rows = audit_rows(&admin.app).await;
    let revision = host_revision(&admin.app).await;
    let mut planned_ids = vec![first["id"].clone(), second["id"].clone()];
    planned_ids.sort_by(|a, b| a.as_str().cmp(&b.as_str()));
    let (status, refused) = admin.call("DELETE", &template, None).await;
    assert_eq!(
        (status, refusal(&refused)),
        (
            StatusCode::CONFLICT,
            (
                json!("conflict"),
                json!({ "constraint": "template_in_use", "shiftIds": planned_ids })
            )
        )
    );
    assert_eq!(audit_rows(&admin.app).await, rows);
    assert_eq!(host_revision(&admin.app).await, revision);
    let (status, _) = admin.call("GET", &template, None).await;
    assert_eq!(status, StatusCode::OK);
    // An open shift keeps its layout in its snapshot; a deleted plan names
    // nothing.
    open_directly(&admin, &first).await;
    let (status, _) = admin.call("DELETE", &path(&second), None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, body) = admin.call("DELETE", &template, None).await;
    assert_eq!((status, body), (StatusCode::NO_CONTENT, Value::Null));
}

#[tokio::test]
async fn the_office_closes_an_active_shift_with_its_reason() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let shift = plan_shift(&admin, shift_body(&setup)).await;
    let id = shift["id"].as_str().unwrap().to_owned();
    open_directly(&admin, &shift).await;
    admin.app.clock.advance(time::Duration::minutes(20));
    let close = format!("{}/close", path(&shift));
    let (status, closed) = admin
        .call(
            "POST",
            &close,
            Some(json!({ "reason": "  Станция линии 1 вышла из строя  ", "expectedRev": 4 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{closed}");
    assert_eq!(
        [
            closed["status"].clone(),
            closed["closedAt"].clone(),
            closed["closeReasonText"].clone(),
            closed["closeReasonCode"].clone(),
            closed["rev"].clone()
        ],
        [
            json!("closed"),
            json!(admin.app.state.timestamp()),
            json!("Станция линии 1 вышла из строя"),
            Value::Null,
            json!(5)
        ]
    );
    assert_eq!(host_revision(&admin.app).await, 5);
    assert_eq!(
        audit_trail(&admin.app, "shift.close").await,
        vec![admin.row(
            "shift.close",
            "shift",
            &id,
            json!({ "reason": "Станция линии 1 вышла из строя" })
        )]
    );
    let (by, kind): (String, String) =
        sqlx::query_as("SELECT closed_by, closed_by_kind FROM shifts WHERE id = ?")
            .bind(&id)
            .fetch_one(&admin.app.state.pool)
            .await
            .unwrap();
    assert_eq!((by, kind), (admin.id.clone(), "office_user".to_owned()));
    // Closed is closed: closing again is refused.
    let (status, refused) = admin
        .call(
            "POST",
            &close,
            Some(json!({ "reason": "Ещё раз", "expectedRev": 5 })),
        )
        .await;
    assert_eq!(
        (status, refusal(&refused)),
        (
            StatusCode::CONFLICT,
            (
                json!("conflict"),
                json!({ "constraint": "shift_status", "status": "closed" })
            )
        )
    );
}

#[tokio::test]
async fn only_an_active_shift_closes_and_only_with_a_reason() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let planned = plan_shift(&admin, shift_body(&setup)).await;
    let active = plan_shift(&admin, shift_body(&setup)).await;
    open_directly(&admin, &active).await;
    let rows = audit_rows(&admin.app).await;
    let revision = host_revision(&admin.app).await;
    let close = |shift: &Value| format!("{}/close", path(shift));
    let (status, refused) = admin
        .call(
            "POST",
            &close(&planned),
            Some(json!({ "reason": "Не нужна", "expectedRev": 4 })),
        )
        .await;
    assert_eq!(
        (status, refusal(&refused)),
        (
            StatusCode::CONFLICT,
            (
                json!("conflict"),
                json!({ "constraint": "shift_status", "status": "planned" })
            )
        )
    );
    for reason in ["аб", "  аб  ", &"я".repeat(501), "Сбой\tстанции"] {
        let (status, refused) = admin
            .call(
                "POST",
                &close(&active),
                Some(json!({ "reason": reason, "expectedRev": 5 })),
            )
            .await;
        assert_eq!(
            (status, refusal(&refused)),
            (
                StatusCode::BAD_REQUEST,
                (json!("validation_failed"), json!({ "field": "reason" }))
            ),
            "{reason:?}"
        );
    }
    for expected_rev in [4, 6] {
        let (status, refused) = admin
            .call(
                "POST",
                &close(&active),
                Some(json!({ "reason": "Сбой", "expectedRev": expected_rev })),
            )
            .await;
        assert_eq!(
            (status, refusal(&refused)),
            (
                StatusCode::CONFLICT,
                (json!("stale_revision"), json!({ "currentRev": 5 }))
            )
        );
    }
    let (status, refused) = admin
        .call("POST", &close(&active), Some(json!({ "expectedRev": 5 })))
        .await;
    assert_eq!(
        (status, refused["error"]["code"].clone()),
        (StatusCode::BAD_REQUEST, json!("validation_failed"))
    );
    let (status, missing) = admin
        .call(
            "POST",
            "/v1/office/shifts/no-such-shift/close",
            Some(json!({ "reason": "Сбой", "expectedRev": 1 })),
        )
        .await;
    assert_eq!(
        (status, missing["error"]["code"].clone()),
        (StatusCode::NOT_FOUND, json!("not_found"))
    );
    assert_eq!(audit_rows(&admin.app).await, rows);
    assert_eq!(host_revision(&admin.app).await, revision);
    // Exactly 500 characters, by a technologist.
    let token = admin.technologist().await;
    let (status, closed) = admin
        .call_as(
            &token,
            "POST",
            &close(&active),
            Some(json!({ "reason": "я".repeat(500), "expectedRev": 5 })),
        )
        .await;
    assert_eq!(
        (status, closed["status"].clone()),
        (StatusCode::OK, json!("closed"))
    );
}

/// Every column of `shifts` a close must leave alone, as one JSON text.
async fn untouched_columns(admin: &Admin, id: &str) -> Value {
    const COLUMNS: [&str; 23] = [
        "id",
        "number_month_key",
        "number_seq",
        "created_from",
        "created_by_kind",
        "created_by",
        "create_request_id",
        "mode",
        "pallets_enabled",
        "product_id",
        "line_id",
        "counterparty_id",
        "production_date",
        "planned_qty",
        "box_capacity",
        "pallet_box_capacity",
        "box_template_id",
        "pallet_template_id",
        "owner_device_id",
        "snapshot",
        "opened_at",
        "late_data_at",
        "created_at",
    ];
    let pairs: Vec<String> = COLUMNS
        .iter()
        .map(|column| format!("'{column}', {column}"))
        .collect();
    let text: String = sqlx::query_scalar(&format!(
        "SELECT json_object({}) FROM shifts WHERE id = ?",
        pairs.join(", ")
    ))
    .bind(id)
    .fetch_one(&admin.app.state.pool)
    .await
    .unwrap();
    serde_json::from_str(&text).unwrap()
}

/// The WHOLE row of a shift (every column the table has, `status`, `rev` and
/// `closed_*` included) as one JSON text, so a bystander is compared in full.
async fn whole_row(admin: &Admin, id: &str) -> Value {
    let columns: Vec<String> =
        sqlx::query_scalar("SELECT name FROM pragma_table_info('shifts') ORDER BY cid")
            .fetch_all(&admin.app.state.pool)
            .await
            .unwrap();
    assert!(columns.len() >= 30, "{columns:?}");
    for needed in [
        "status",
        "rev",
        "closed_at",
        "closed_by",
        "close_reason_text",
    ] {
        assert!(columns.iter().any(|c| c == needed), "{needed}");
    }
    let pairs: Vec<String> = columns
        .iter()
        .map(|column| format!("'{column}', {column}"))
        .collect();
    let text: String = sqlx::query_scalar(&format!(
        "SELECT json_object({}) FROM shifts WHERE id = ?",
        pairs.join(", ")
    ))
    .bind(id)
    .fetch_one(&admin.app.state.pool)
    .await
    .unwrap();
    serde_json::from_str(&text).unwrap()
}

#[tokio::test]
async fn a_close_writes_only_the_closing_columns_and_wakes_the_streams() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let shift = plan_shift(&admin, shift_body(&setup)).await;
    let bystander = plan_shift(&admin, shift_body(&setup)).await;
    let id = shift["id"].as_str().unwrap().to_owned();
    open_directly(&admin, &shift).await;
    // The bystander is RUNNING too: a close that reached past its own row
    // would close it, and only an active neighbour can show that.
    open_directly(&admin, &bystander).await;
    sqlx::query("INSERT INTO shift_participants (shift_id, device_id, first_entered_at, last_entered_at) SELECT ?, owner_device_id, opened_at, opened_at FROM shifts WHERE id = ?")
        .bind(&id)
        .bind(&id)
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    let before = untouched_columns(&admin, &id).await;
    let bystander_id = bystander["id"].as_str().unwrap().to_owned();
    let bystander_before = whole_row(&admin, &bystander_id).await;
    assert_eq!(bystander_before["status"], json!("active"));
    let counters: Vec<(String, i64)> =
        sqlx::query_as("SELECT month_key, last_seq FROM shift_number_counters ORDER BY month_key")
            .fetch_all(&admin.app.state.pool)
            .await
            .unwrap();
    let participants: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM shift_participants")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    let rows = audit_rows(&admin.app).await;
    let next = host_revision(&admin.app).await + 1;
    let mut wake = admin.app.state.revisions.subscribe();
    assert!(!wake.has_changed().unwrap());
    let (status, closed) = admin
        .call(
            "POST",
            &format!("{}/close", path(&shift)),
            Some(json!({ "reason": "Сбой", "expectedRev": shift["rev"] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{closed}");
    // The streams wake with the close's own revision, so the line's stations
    // read the shift as closed without waiting for another write.
    assert!(wake.has_changed().unwrap());
    assert_eq!(*wake.borrow_and_update(), next);
    assert_eq!(*admin.app.state.revisions.borrow(), next);
    assert_eq!(closed["rev"], json!(next));
    assert_eq!(untouched_columns(&admin, &id).await, before);
    // The running neighbour is the same row, column for column: still
    // active, same `rev`, nothing of a close on it.
    assert_eq!(whole_row(&admin, &bystander_id).await, bystander_before);
    let closed_row = whole_row(&admin, &id).await;
    assert_eq!(closed_row["status"], json!("closed"));
    assert_eq!(closed_row["rev"], json!(next));
    // The stored row and the answer agree.
    let (status, read_back) = admin.call("GET", &path(&shift), None).await;
    assert_eq!((status, read_back), (StatusCode::OK, closed));
    let after: Vec<(String, i64)> =
        sqlx::query_as("SELECT month_key, last_seq FROM shift_number_counters ORDER BY month_key")
            .fetch_all(&admin.app.state.pool)
            .await
            .unwrap();
    assert_eq!(after, counters);
    let still: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM shift_participants")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    assert_eq!(still, participants);
    assert_eq!(audit_rows(&admin.app).await, rows + 1);
}

#[tokio::test]
async fn a_reason_is_trimmed_counted_in_characters_and_free_of_control_characters() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let wrong = |reason: Value| json!({ "reason": reason, "expectedRev": 4 });
    let active = plan_shift(&admin, shift_body(&setup)).await;
    open_directly(&admin, &active).await;
    let rows = audit_rows(&admin.app).await;
    let revision = host_revision(&admin.app).await;
    let rejected = [
        json!(""),
        json!("   "),
        json!("я"),
        json!("Сбой\nстанции"),
        json!("Сбой\u{85}станции"),
        json!("Сбой станции\u{7f}"),
        json!(format!("{}ы", "я".repeat(500))),
        json!(format!("  {}ы  ", "я".repeat(500))),
        json!(["Сбой"]),
        json!(null),
        json!(500),
    ];
    for reason in rejected {
        let (status, refused) = admin
            .call(
                "POST",
                &format!("{}/close", path(&active)),
                Some(wrong(reason.clone())),
            )
            .await;
        assert_eq!(
            (status, refused["error"]["code"].clone()),
            (StatusCode::BAD_REQUEST, json!("validation_failed")),
            "{reason}"
        );
    }
    // A bad reason is refused before the shift is even looked up.
    let (status, refused) = admin
        .call(
            "POST",
            "/v1/office/shifts/no-such-shift/close",
            Some(wrong(json!("аб"))),
        )
        .await;
    assert_eq!(
        (status, refusal(&refused)),
        (
            StatusCode::BAD_REQUEST,
            (json!("validation_failed"), json!({ "field": "reason" }))
        )
    );
    // The office names no reason code, and the revision is required.
    for body in [
        json!({ "reason": "Сбой", "reasonCode": "equipment_failure", "expectedRev": 4 }),
        json!({ "reason": "Сбой" }),
        json!({ "reason": "Сбой", "expectedRev": "4" }),
    ] {
        let (status, refused) = admin
            .call("POST", &format!("{}/close", path(&active)), Some(body))
            .await;
        assert_eq!(
            (status, refused["error"]["code"].clone()),
            (StatusCode::BAD_REQUEST, json!("validation_failed"))
        );
    }
    assert_eq!(audit_rows(&admin.app).await, rows);
    assert_eq!(host_revision(&admin.app).await, revision);
    let (status, still) = admin.call("GET", &path(&active), None).await;
    assert_eq!(
        (
            status,
            still["status"].clone(),
            still["closeReasonText"].clone()
        ),
        (StatusCode::OK, json!("active"), Value::Null)
    );
    // What is stored is the trimmed text, counted in characters: three
    // Cyrillic letters are six bytes, and 500 of them a thousand.
    let accepted = [
        ("  абв  ", "абв".to_owned()),
        ("а б", "а б".to_owned()),
        (&format!("  {}  ", "я".repeat(500)), "я".repeat(500)),
        ("Сбой\u{a0}станции", "Сбой\u{a0}станции".to_owned()),
    ];
    for (reason, stored) in accepted {
        let shift = plan_shift(&admin, shift_body(&setup)).await;
        open_directly(&admin, &shift).await;
        let (status, closed) = admin
            .call(
                "POST",
                &format!("{}/close", path(&shift)),
                Some(json!({ "reason": reason, "expectedRev": shift["rev"] })),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{reason:?}: {closed}");
        assert_eq!(closed["closeReasonText"], json!(stored), "{reason:?}");
        let audited = audit_trail(&admin.app, "shift.close").await;
        assert_eq!(
            audited.last().map(|row| row.6.clone()),
            Some(json!({ "reason": stored })),
            "{reason:?}"
        );
    }
}

#[tokio::test]
async fn the_state_machine_and_the_revision_decide_before_anything_is_written() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let planned = plan_shift(&admin, shift_body(&setup)).await;
    let closed = plan_shift(&admin, shift_body(&setup)).await;
    open_directly(&admin, &closed).await;
    let (status, done) = admin
        .call(
            "POST",
            &format!("{}/close", path(&closed)),
            Some(json!({ "reason": "Сбой", "expectedRev": closed["rev"] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{done}");
    let gone = plan_shift(&admin, shift_body(&setup)).await;
    let (status, _) = admin.call("DELETE", &path(&gone), None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let rows = audit_rows(&admin.app).await;
    let revision = host_revision(&admin.app).await;
    let planned_before = untouched_columns(&admin, planned["id"].as_str().unwrap()).await;
    let stale = |shift: &Value, expected_rev: i64| {
        (
            format!("{}/close", path(shift)),
            json!({ "reason": "Сбой", "expectedRev": expected_rev }),
        )
    };
    // A wrong revision is stale whatever the status; the right one on a
    // planned or a closed shift is the status, with the status named.
    let planned_rev = planned["rev"].as_i64().unwrap();
    let closed_rev = done["rev"].as_i64().unwrap();
    for (shift, current) in [(&planned, planned_rev), (&closed, closed_rev)] {
        let (route, body) = stale(shift, current + 1);
        let (status, refused) = admin.call("POST", &route, Some(body)).await;
        assert_eq!(
            (status, refusal(&refused)),
            (
                StatusCode::CONFLICT,
                (json!("stale_revision"), json!({ "currentRev": current }))
            )
        );
    }
    for (shift, current, name) in [
        (&planned, planned_rev, "planned"),
        (&closed, closed_rev, "closed"),
    ] {
        let (route, body) = stale(shift, current);
        let (status, refused) = admin.call("POST", &route, Some(body)).await;
        assert_eq!(
            (status, refusal(&refused)),
            (
                StatusCode::CONFLICT,
                (
                    json!("conflict"),
                    json!({ "constraint": "shift_status", "status": name })
                )
            )
        );
    }
    // A shift that is gone cannot be closed.
    let (route, body) = stale(&gone, 4);
    let (status, refused) = admin.call("POST", &route, Some(body)).await;
    assert_eq!(
        (status, refused["error"]["code"].clone()),
        (StatusCode::NOT_FOUND, json!("not_found"))
    );
    assert_eq!(audit_rows(&admin.app).await, rows);
    assert_eq!(host_revision(&admin.app).await, revision);
    assert_eq!(
        untouched_columns(&admin, planned["id"].as_str().unwrap()).await,
        planned_before
    );
    let (status, unchanged) = admin.call("GET", &path(&planned), None).await;
    assert_eq!((status, unchanged), (StatusCode::OK, planned));
    let (status, same) = admin.call("GET", &path(&closed), None).await;
    assert_eq!((status, same), (StatusCode::OK, done));
}

#[tokio::test]
async fn a_technologist_closes_in_their_name_and_a_user_turned_off_or_a_device_cannot() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let (tech, tech_id) = admin.technologist_session().await;
    let shift = plan_shift(&admin, shift_body(&setup)).await;
    let id = shift["id"].as_str().unwrap().to_owned();
    open_directly(&admin, &shift).await;
    let close = format!("{}/close", path(&shift));
    let body = json!({ "reason": "Сбой", "expectedRev": shift["rev"] });
    // A device key alone opens no office route.
    let revision = host_revision(&admin.app).await;
    let rows = audit_rows(&admin.app).await;
    let (status, refused) = admin
        .app
        .send(support::app::json(
            with_device(request("POST", &close), &admin.key),
            body.clone(),
        ))
        .await;
    assert_eq!(
        (status, refused["error"]["details"]["credential"].clone()),
        (StatusCode::UNAUTHORIZED, json!("session"))
    );
    // A user turned off after the extractor passed is refused by the route's
    // own check inside the transaction.
    turn_the_user_off_at_the_next_activity(&admin.app, &tech_id).await;
    admin.app.clock.advance(time::Duration::minutes(2));
    let (status, error) = admin
        .call_as(&tech, "POST", &close, Some(body.clone()))
        .await;
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
        "{error}"
    );
    assert_eq!(host_revision(&admin.app).await, revision);
    assert_eq!(audit_rows(&admin.app).await, rows);
    let (status, unchanged) = admin.call("GET", &path(&shift), None).await;
    assert_eq!(
        (status, unchanged["status"].clone()),
        (StatusCode::OK, json!("active"))
    );
    // Another technologist closes it, and the row names them.
    let other =
        seed_office_user(&admin.app, "tech2", "technologist", "technologist password").await;
    let token = support::app::login(&admin.app, &admin.key, "tech2", "technologist password").await;
    let (status, closed) = admin.call_as(&token, "POST", &close, Some(body)).await;
    assert_eq!(status, StatusCode::OK, "{closed}");
    assert_eq!(
        audit_trail(&admin.app, "shift.close").await,
        vec![support::app::audit_row(
            &other,
            "shift.close",
            "shift",
            &id,
            json!({ "reason": "Сбой" })
        )]
    );
    let (by, kind): (String, String) =
        sqlx::query_as("SELECT closed_by, closed_by_kind FROM shifts WHERE id = ?")
            .bind(&id)
            .fetch_one(&admin.app.state.pool)
            .await
            .unwrap();
    assert_eq!((by, kind), (other, "office_user".to_owned()));
}

#[tokio::test]
async fn editing_and_deleting_stop_a_user_turned_off_after_the_extractor_passed() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let shift = plan_shift(&admin, shift_body(&setup)).await;
    // One user per request: the first request turns its user off, and the
    // next one would be refused by the extractor, not by the route.
    let mut users = Vec::new();
    for login in ["tech-put", "tech-delete"] {
        let id = seed_office_user(&admin.app, login, "technologist", "technologist password").await;
        let token =
            support::app::login(&admin.app, &admin.key, login, "technologist password").await;
        users.push((id, token));
    }
    let revision = host_revision(&admin.app).await;
    let rows = audit_rows(&admin.app).await;
    for ((user, token), (method, body)) in users.iter().zip([
        (
            "PUT",
            Some(json!({ "plannedQty": 5, "expectedRev": shift["rev"] })),
        ),
        ("DELETE", None),
    ]) {
        turn_the_user_off_at_the_next_activity(&admin.app, user).await;
        admin.app.clock.advance(time::Duration::minutes(2));
        let (status, error) = admin.call_as(token, method, &path(&shift), body).await;
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
            "{method}: {error}"
        );
    }
    let (status, unchanged) = admin.call("GET", &path(&shift), None).await;
    assert_eq!((status, unchanged), (StatusCode::OK, shift.clone()));
    assert_eq!(host_revision(&admin.app).await, revision);
    assert_eq!(audit_rows(&admin.app).await, rows);
    // A device key opens neither route.
    let put = support::app::json(
        with_device(request("PUT", &path(&shift)), &admin.key),
        json!({ "plannedQty": 5, "expectedRev": shift["rev"] }),
    );
    let delete = empty(with_device(request("DELETE", &path(&shift)), &admin.key));
    for (method, request) in [("PUT", put), ("DELETE", delete)] {
        let (status, refused) = admin.app.send(request).await;
        assert_eq!(
            (status, refused["error"]["details"]["credential"].clone()),
            (StatusCode::UNAUTHORIZED, json!("session")),
            "{method}"
        );
    }
}

/// Run `UPDATE shifts SET {set} WHERE id = ?` and answer the database's
/// refusal; a statement the schema takes is a failure of the test.
async fn schema_refuses(admin: &Admin, shift: &Value, set: &str) -> String {
    let outcome = sqlx::query(&format!("UPDATE shifts SET {set} WHERE id = ?"))
        .bind(shift["id"].as_str().unwrap())
        .execute(&admin.app.state.pool)
        .await;
    outcome
        .err()
        .unwrap_or_else(|| panic!("the schema took {set:?}"))
        .to_string()
}

/// The statuses of `0009` hold the whole lifecycle in the table itself, so no
/// route, present or future, can leave a shift half open or half closed: a
/// shift in the middle of its life is open, owned and snapshotted, and says
/// who closed it exactly when it is closed.
#[tokio::test]
async fn a_shift_row_that_breaks_its_lifecycle_is_refused_by_the_schema() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let device = station_id(&admin).await;
    let planned = plan_shift(&admin, shift_body(&setup)).await;
    let active = plan_shift(&admin, shift_body(&setup)).await;
    let closed = plan_shift(&admin, shift_body(&setup)).await;
    open_directly(&admin, &active).await;
    open_directly(&admin, &closed).await;
    close_directly(&admin, &closed).await;
    let at = admin.app.state.timestamp();
    let owner = format!("owner_device_id = '{device}'");
    let closing = format!("closed_at = '{at}', closed_by_kind = 'device', closed_by = '{device}'");

    for (shift, label, set) in [
        // A planned shift is unopened.
        (
            &planned,
            "planned with a snapshot",
            "snapshot = '{}'".to_owned(),
        ),
        (
            &planned,
            "planned with an opening",
            format!("opened_at = '{at}'"),
        ),
        (&planned, "planned with an owner", owner.clone()),
        // An active one is snapshotted, opened and owned.
        (
            &active,
            "active without a snapshot",
            "snapshot = NULL".to_owned(),
        ),
        (
            &active,
            "active without an opening",
            "opened_at = NULL".to_owned(),
        ),
        (
            &active,
            "active without an owner",
            "owner_device_id = NULL".to_owned(),
        ),
        (&active, "back to planned", "status = 'planned'".to_owned()),
        // So is a closed one, which also says when and by whom.
        (
            &closed,
            "closed without a snapshot",
            "snapshot = NULL".to_owned(),
        ),
        (
            &closed,
            "closed without an opening",
            "opened_at = NULL".to_owned(),
        ),
        (
            &closed,
            "closed without an owner",
            "owner_device_id = NULL".to_owned(),
        ),
        (
            &closed,
            "closed without a time",
            "closed_at = NULL".to_owned(),
        ),
        (
            &closed,
            "closed without a kind",
            "closed_by_kind = NULL".to_owned(),
        ),
        (
            &closed,
            "closed without a closer",
            "closed_by = NULL".to_owned(),
        ),
        (&closed, "closed, reopened", "status = 'active'".to_owned()),
        // A shift that is not closed says nothing of a close.
        (
            &planned,
            "planned with a closer",
            "closed_by = 'x'".to_owned(),
        ),
        (
            &active,
            "active with a closer",
            "closed_by = 'x'".to_owned(),
        ),
        (
            &active,
            "active with a close time",
            format!("closed_at = '{at}'"),
        ),
        (
            &active,
            "active with a close kind",
            "closed_by_kind = 'device'".to_owned(),
        ),
        // A close that misses one of its three columns.
        (
            &active,
            "closed without a time",
            format!("status = 'closed', closed_by_kind = 'device', closed_by = '{device}'"),
        ),
        (
            &active,
            "closed without a kind",
            format!("status = 'closed', closed_at = '{at}', closed_by = '{device}'"),
        ),
        (
            &active,
            "closed without a closer",
            format!("status = 'closed', closed_at = '{at}', closed_by_kind = 'device'"),
        ),
        (
            &active,
            "closed with nothing",
            "status = 'closed'".to_owned(),
        ),
    ] {
        let message = schema_refuses(&admin, shift, &set).await;
        assert!(
            message.contains("CHECK constraint failed"),
            "{label}: {message}"
        );
    }

    // Every refusal left its row as it was.
    for (shift, status) in [
        (&planned, "planned"),
        (&active, "active"),
        (&closed, "closed"),
    ] {
        let (status_now, has_closer): (String, bool) =
            sqlx::query_as("SELECT status, closed_by IS NOT NULL FROM shifts WHERE id = ?")
                .bind(shift["id"].as_str().unwrap())
                .fetch_one(&admin.app.state.pool)
                .await
                .unwrap();
        assert_eq!(
            (status_now, has_closer),
            (status.to_owned(), status == "closed")
        );
    }

    // The lifecycle the routes write is what the schema takes: the opening
    // fills the three columns together, the close the three of its own.
    sqlx::query(
        "UPDATE shifts SET status = 'active', snapshot = '{}', opened_at = ?1, \
         owner_device_id = ?2 WHERE id = ?3",
    )
    .bind(&at)
    .bind(&device)
    .bind(planned["id"].as_str().unwrap())
    .execute(&admin.app.state.pool)
    .await
    .unwrap();
    sqlx::query(&format!(
        "UPDATE shifts SET status = 'closed', {closing} WHERE id = ?"
    ))
    .bind(planned["id"].as_str().unwrap())
    .execute(&admin.app.state.pool)
    .await
    .unwrap();
}

fn field(name: &str) -> (Value, Value) {
    (json!("validation_failed"), json!({ "field": name }))
}

/// A shift with pallets names its pallet template and takes the product's
/// pallet capacity unless it names its own; a shift without pallets names
/// neither. The plan's audit row is the same with pallets or without.
#[tokio::test]
async fn a_shift_with_pallets_takes_its_template_and_the_products_capacity() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let pallet = pallet_template(&admin).await;
    let shift = plan_shift(&admin, pallet_shift_body(&setup, &pallet)).await;
    let id = shift["id"].as_str().unwrap().to_owned();
    let mut expected = planned(&id, "OCT26-001", &setup, shift["rev"].as_i64().unwrap());
    expected["palletsEnabled"] = json!(true);
    expected["palletBoxCapacity"] = json!(40);
    expected["palletTemplateId"] = json!(pallet);
    assert_eq!(shift, expected);
    let (status, read_back) = admin.call("GET", &path(&shift), None).await;
    assert_eq!((status, read_back), (StatusCode::OK, expected));
    let mut body = pallet_shift_body(&setup, &pallet);
    body["palletBoxCapacity"] = json!(10_000);
    let named = plan_shift(&admin, body).await;
    assert_eq!(
        (
            named["palletsEnabled"].clone(),
            named["palletBoxCapacity"].clone(),
            named["palletTemplateId"].clone()
        ),
        (json!(true), json!(10_000), json!(pallet))
    );
    let plain = plan_shift(&admin, shift_body(&setup)).await;
    assert_eq!(
        (
            plain["palletsEnabled"].clone(),
            plain["palletBoxCapacity"].clone(),
            plain["palletTemplateId"].clone()
        ),
        (json!(false), Value::Null, Value::Null)
    );
    assert_eq!(
        audit_trail(&admin.app, "shift.create").await[0],
        admin.row(
            "shift.create",
            "shift",
            &id,
            json!({
                "number": "OCT26-001", "productId": setup.product, "lineId": setup.line,
                "productionDate": "2026-10-08"
            })
        )
    );
}

/// A plan with pallets needs a pallet template that fits the product: an
/// enabled one of the pallet purpose covering its group. A plan without
/// pallets sends no pallet field. A refusal writes nothing.
#[tokio::test]
async fn a_plan_with_pallets_needs_a_fitting_pallet_template_and_one_without_sends_neither() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let pallet = pallet_template(&admin).await;
    let disabled = office_template(&admin, "pallet", false, Value::Null).await;
    let other_group = office_template(&admin, "pallet", true, json!([15])).await;
    let rows = audit_rows(&admin.app).await;
    let revision = host_revision(&admin.app).await;
    for (change, expected) in [
        (
            json!({ "palletsEnabled": false, "palletBoxCapacity": 40 }),
            field("palletBoxCapacity"),
        ),
        (
            json!({ "palletTemplateId": pallet }),
            field("palletTemplateId"),
        ),
        (json!({ "palletsEnabled": true }), field("palletTemplateId")),
        (
            json!({ "palletsEnabled": true, "palletBoxCapacity": 40 }),
            field("palletTemplateId"),
        ),
        (
            json!({ "palletsEnabled": true, "palletTemplateId": pallet, "palletBoxCapacity": 0 }),
            field("palletBoxCapacity"),
        ),
        (
            json!({
                "palletsEnabled": true, "palletTemplateId": pallet, "palletBoxCapacity": 10_001
            }),
            field("palletBoxCapacity"),
        ),
        (
            json!({ "palletsEnabled": true, "palletTemplateId": setup.template }),
            field("palletTemplateId"),
        ),
        (
            json!({ "palletsEnabled": true, "palletTemplateId": disabled }),
            field("palletTemplateId"),
        ),
        (
            json!({ "palletsEnabled": true, "palletTemplateId": other_group }),
            field("palletTemplateId"),
        ),
        (
            json!({ "palletsEnabled": true, "palletTemplateId": "no-such-template" }),
            field("palletTemplateId"),
        ),
    ] {
        let mut body = shift_body(&setup);
        for (key, value) in change.as_object().unwrap() {
            body[key] = value.clone();
        }
        let (status, refused) = admin.call("POST", "/v1/office/shifts", Some(body)).await;
        assert_eq!(
            (status, refusal(&refused)),
            (StatusCode::BAD_REQUEST, expected),
            "{change}"
        );
    }
    assert_eq!(audit_rows(&admin.app).await, rows);
    assert_eq!(host_revision(&admin.app).await, revision);
    let (_, list) = admin.call("GET", "/v1/office/shifts", None).await;
    assert_eq!(list, json!([]));
}

/// A planned shift turns pallets on (with a template; the capacity is the
/// product's), changes their capacity or template, and turns them off,
/// which clears both; each change is audited field by field.
#[tokio::test]
async fn a_planned_shift_turns_pallets_on_changes_them_and_turns_them_off() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let pallet = pallet_template(&admin).await;
    let other = pallet_template(&admin).await;
    let shift = plan_shift(&admin, shift_body(&setup)).await;
    let id = shift["id"].as_str().unwrap().to_owned();
    let mut rev = shift["rev"].clone();
    let mut expected_trail = Vec::new();
    for (change, after, details) in [
        (
            json!({ "palletsEnabled": true, "palletTemplateId": pallet }),
            (json!(true), json!(40), json!(pallet)),
            json!({
                "changed": ["palletsEnabled", "palletBoxCapacity", "palletTemplateId"],
                "palletsEnabled": { "from": false, "to": true },
                "palletBoxCapacity": { "from": null, "to": 40 },
                "palletTemplateId": { "from": null, "to": pallet },
            }),
        ),
        (
            json!({ "palletBoxCapacity": 30 }),
            (json!(true), json!(30), json!(pallet)),
            json!({
                "changed": ["palletBoxCapacity"],
                "palletBoxCapacity": { "from": 40, "to": 30 },
            }),
        ),
        (
            json!({ "palletTemplateId": other }),
            (json!(true), json!(30), json!(other)),
            json!({
                "changed": ["palletTemplateId"],
                "palletTemplateId": { "from": pallet, "to": other },
            }),
        ),
        (
            json!({ "palletsEnabled": false }),
            (json!(false), Value::Null, Value::Null),
            json!({
                "changed": ["palletsEnabled", "palletBoxCapacity", "palletTemplateId"],
                "palletsEnabled": { "from": true, "to": false },
                "palletBoxCapacity": { "from": 30, "to": null },
                "palletTemplateId": { "from": other, "to": null },
            }),
        ),
    ] {
        let mut body = change.clone();
        body["expectedRev"] = rev.clone();
        let (status, updated) = admin.call("PUT", &path(&shift), Some(body)).await;
        assert_eq!(status, StatusCode::OK, "{change}: {updated}");
        assert_eq!(
            (
                updated["palletsEnabled"].clone(),
                updated["palletBoxCapacity"].clone(),
                updated["palletTemplateId"].clone()
            ),
            after,
            "{change}"
        );
        let (_, read_back) = admin.call("GET", &path(&shift), None).await;
        assert_eq!(read_back, updated, "{change}");
        rev = updated["rev"].clone();
        expected_trail.push(admin.row("shift.update", "shift", &id, details));
    }
    assert_eq!(
        audit_trail(&admin.app, "shift.update").await,
        expected_trail
    );
}

/// An edit keeps the pallet fields it does not send, even a template
/// disabled since, and checks a template it changes; pallets turned on need
/// a template, and a shift without pallets takes no pallet field.
#[tokio::test]
async fn an_edit_keeps_unsent_pallet_fields_and_checks_what_it_changes() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let pallet = pallet_template(&admin).await;
    let disabled = office_template(&admin, "pallet", false, Value::Null).await;
    let with_pallets = plan_shift(&admin, pallet_shift_body(&setup, &pallet)).await;
    let plain = plan_shift(&admin, shift_body(&setup)).await;
    // The shift's template is disabled after it was planned.
    let (status, template) = admin
        .call("GET", &format!("/v1/office/templates/{pallet}"), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{template}");
    let (status, turned_off) = admin
        .call(
            "PUT",
            &format!("/v1/office/templates/{pallet}"),
            Some(json!({ "enabled": false, "expectedRev": template["rev"] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{turned_off}");
    let rows = audit_rows(&admin.app).await;
    let revision = host_revision(&admin.app).await;
    for (shift, change, expected) in [
        (
            &with_pallets,
            json!({ "palletTemplateId": setup.template }),
            field("palletTemplateId"),
        ),
        (
            &with_pallets,
            json!({ "palletTemplateId": disabled }),
            field("palletTemplateId"),
        ),
        (
            &with_pallets,
            json!({ "palletsEnabled": false, "palletBoxCapacity": 20 }),
            field("palletBoxCapacity"),
        ),
        (
            &with_pallets,
            json!({ "palletsEnabled": false, "palletTemplateId": pallet }),
            field("palletTemplateId"),
        ),
        (
            &with_pallets,
            json!({ "palletBoxCapacity": 10_001 }),
            field("palletBoxCapacity"),
        ),
        (
            &plain,
            json!({ "palletsEnabled": true }),
            field("palletTemplateId"),
        ),
        (
            &plain,
            json!({ "palletBoxCapacity": 20 }),
            field("palletBoxCapacity"),
        ),
        (
            &plain,
            json!({ "palletTemplateId": pallet }),
            field("palletTemplateId"),
        ),
    ] {
        let mut body = change.clone();
        body["expectedRev"] = shift["rev"].clone();
        let (status, refused) = admin.call("PUT", &path(shift), Some(body)).await;
        assert_eq!(
            (status, refusal(&refused)),
            (StatusCode::BAD_REQUEST, expected),
            "{change}"
        );
    }
    assert_eq!(audit_rows(&admin.app).await, rows);
    assert_eq!(host_revision(&admin.app).await, revision);
    // A bad capacity is refused before the shift is looked up.
    let (status, refused) = admin
        .call(
            "PUT",
            "/v1/office/shifts/no-such-shift",
            Some(json!({ "palletBoxCapacity": 0, "expectedRev": 1 })),
        )
        .await;
    assert_eq!(
        (status, refusal(&refused)),
        (StatusCode::BAD_REQUEST, field("palletBoxCapacity"))
    );
    // The disabled template stays while the edit does not change it.
    let (status, updated) = admin
        .call(
            "PUT",
            &path(&with_pallets),
            Some(json!({ "palletBoxCapacity": 25, "expectedRev": with_pallets["rev"] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{updated}");
    assert_eq!(
        (
            updated["palletBoxCapacity"].clone(),
            updated["palletTemplateId"].clone()
        ),
        (json!(25), json!(pallet))
    );
    // The same value again changes nothing: no revision, no audit row.
    let revision = host_revision(&admin.app).await;
    let (status, same) = admin
        .call(
            "PUT",
            &path(&with_pallets),
            Some(json!({
                "palletsEnabled": true, "palletTemplateId": pallet, "palletBoxCapacity": 25,
                "expectedRev": updated["rev"]
            })),
        )
        .await;
    assert_eq!((status, same), (StatusCode::OK, updated));
    assert_eq!(host_revision(&admin.app).await, revision);
}

/// An open shift keeps its pallets: an edit that sends them unchanged
/// passes with its plan, one that changes them is `shift_status`.
#[tokio::test]
async fn an_active_shift_keeps_its_pallets() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let pallet = pallet_template(&admin).await;
    let other = pallet_template(&admin).await;
    let shift = plan_shift(&admin, pallet_shift_body(&setup, &pallet)).await;
    let plain = plan_shift(&admin, shift_body(&setup)).await;
    open_directly(&admin, &shift).await;
    open_directly(&admin, &plain).await;
    let (_, current) = admin.call("GET", &path(&shift), None).await;
    let (_, current_plain) = admin.call("GET", &path(&plain), None).await;
    let active = || {
        (
            StatusCode::CONFLICT,
            (
                json!("conflict"),
                json!({ "constraint": "shift_status", "status": "active" }),
            ),
        )
    };
    for (shift, change) in [
        (&current, json!({ "palletsEnabled": false })),
        (&current, json!({ "palletBoxCapacity": 30 })),
        (&current, json!({ "palletTemplateId": other })),
        (
            &current_plain,
            json!({ "palletsEnabled": true, "palletTemplateId": pallet }),
        ),
    ] {
        let mut body = change.clone();
        body["expectedRev"] = shift["rev"].clone();
        let (status, refused) = admin.call("PUT", &path(shift), Some(body)).await;
        assert_eq!((status, refusal(&refused)), active(), "{change}");
    }
    let (status, updated) = admin
        .call(
            "PUT",
            &path(&current),
            Some(json!({
                "palletsEnabled": true, "palletBoxCapacity": 40, "palletTemplateId": pallet,
                "plannedQty": 800, "expectedRev": current["rev"]
            })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{updated}");
    assert_eq!(
        (
            updated["plannedQty"].clone(),
            updated["palletBoxCapacity"].clone(),
            updated["palletTemplateId"].clone()
        ),
        (json!(800), json!(40), json!(pallet))
    );
}

/// A pallet template a planned shift names is not deleted either; once the
/// shift is open its layout lives in the snapshot.
#[tokio::test]
async fn a_pallet_template_a_planned_shift_names_is_not_deleted() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let pallet = pallet_template(&admin).await;
    let shift = plan_shift(&admin, pallet_shift_body(&setup, &pallet)).await;
    let template = format!("/v1/office/templates/{pallet}");
    let rows = audit_rows(&admin.app).await;
    let revision = host_revision(&admin.app).await;
    let (status, refused) = admin.call("DELETE", &template, None).await;
    assert_eq!(
        (status, refusal(&refused)),
        (
            StatusCode::CONFLICT,
            (
                json!("conflict"),
                json!({ "constraint": "template_in_use", "shiftIds": [shift["id"]] })
            )
        )
    );
    assert_eq!(audit_rows(&admin.app).await, rows);
    assert_eq!(host_revision(&admin.app).await, revision);
    open_directly(&admin, &shift).await;
    let (status, body) = admin.call("DELETE", &template, None).await;
    assert_eq!((status, body), (StatusCode::NO_CONTENT, Value::Null));
}

/// The pallet columns of `shifts` go together: a shift with pallets names
/// their capacity and template, a shift without names neither (two
/// triggers of `0012`, since `0009` takes no new CHECK).
#[tokio::test]
async fn the_schema_keeps_a_shifts_pallet_fields_together() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let pallet = pallet_template(&admin).await;
    let with_pallets = plan_shift(&admin, pallet_shift_body(&setup, &pallet)).await;
    let plain = plan_shift(&admin, shift_body(&setup)).await;
    for (shift, set) in [
        (&plain, "pallets_enabled = 1".to_owned()),
        (
            &plain,
            "pallets_enabled = 1, pallet_box_capacity = 40".to_owned(),
        ),
        (
            &plain,
            format!("pallets_enabled = 1, pallet_template_id = '{pallet}'"),
        ),
        (&plain, "pallet_box_capacity = 40".to_owned()),
        (&plain, format!("pallet_template_id = '{pallet}'")),
        (&with_pallets, "pallets_enabled = 0".to_owned()),
        (&with_pallets, "pallet_box_capacity = NULL".to_owned()),
        (&with_pallets, "pallet_template_id = NULL".to_owned()),
    ] {
        let message = schema_refuses(&admin, shift, &set).await;
        assert!(
            message.contains("shift pallets: capacity and template exactly when enabled"),
            "{set}: {message}"
        );
    }
    // A new row is held the same way.
    let copy = |enabled: i64, capacity: &str, template: &str| {
        format!(
            "INSERT INTO shifts (id, number_month_key, number_seq, created_from, \
             created_by_kind, created_by, status, mode, pallets_enabled, product_id, line_id, \
             production_date, box_capacity, box_template_id, pallet_box_capacity, \
             pallet_template_id, created_at, rev) \
             SELECT 'copy', number_month_key, number_seq + 100, created_from, created_by_kind, \
             created_by, status, mode, {enabled}, product_id, line_id, production_date, \
             box_capacity, box_template_id, {capacity}, {template}, created_at, rev \
             FROM shifts WHERE id = ?"
        )
    };
    let quoted = format!("'{pallet}'");
    for (enabled, capacity, template) in [
        (1, "NULL", quoted.as_str()),
        (1, "40", "NULL"),
        (0, "40", "NULL"),
        (0, "NULL", quoted.as_str()),
    ] {
        let outcome = sqlx::query(&copy(enabled, capacity, template))
            .bind(plain["id"].as_str().unwrap())
            .execute(&admin.app.state.pool)
            .await;
        let message = outcome
            .err()
            .unwrap_or_else(|| panic!("the schema took {enabled} {capacity} {template}"))
            .to_string();
        assert!(
            message.contains("shift pallets: capacity and template exactly when enabled"),
            "{message}"
        );
    }
    // Together, either way, the rows are taken.
    sqlx::query(&copy(1, "40", &quoted))
        .bind(plain["id"].as_str().unwrap())
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    sqlx::query(&format!(
        "UPDATE shifts SET pallets_enabled = 1, pallet_box_capacity = 40, \
         pallet_template_id = '{pallet}' WHERE id = ?"
    ))
    .bind(plain["id"].as_str().unwrap())
    .execute(&admin.app.state.pool)
    .await
    .unwrap();
    sqlx::query(
        "UPDATE shifts SET pallets_enabled = 0, pallet_box_capacity = NULL, \
         pallet_template_id = NULL WHERE id = ?",
    )
    .bind(with_pallets["id"].as_str().unwrap())
    .execute(&admin.app.state.pool)
    .await
    .unwrap();
}

/// What a shift's pallet columns hold in the table itself: the flag, the
/// capacity and the template.
async fn pallet_columns(admin: &Admin, shift: &Value) -> (i64, Option<i64>, Option<String>) {
    sqlx::query_as(
        "SELECT pallets_enabled, pallet_box_capacity, pallet_template_id FROM shifts WHERE id = ?",
    )
    .bind(shift["id"].as_str().unwrap())
    .fetch_one(&admin.app.state.pool)
    .await
    .unwrap()
}

/// A shift without pallets records no pallet field anywhere: not in its
/// row, not in its create or update audit rows, not when an edit turns its
/// pallets off or repeats `palletsEnabled: false`.
#[tokio::test]
async fn a_shift_without_pallets_records_no_pallet_field_anywhere() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let pallet = pallet_template(&admin).await;
    let plain = plan_shift(&admin, shift_body(&setup)).await;
    let mut explicit_body = shift_body(&setup);
    explicit_body["palletsEnabled"] = json!(false);
    let explicit = plan_shift(&admin, explicit_body).await;
    let with_pallets = plan_shift(&admin, pallet_shift_body(&setup, &pallet)).await;
    let created = |shift: &Value, number: &str| {
        admin.row(
            "shift.create",
            "shift",
            shift["id"].as_str().unwrap(),
            json!({
                "number": number, "productId": setup.product, "lineId": setup.line,
                "productionDate": "2026-10-08"
            }),
        )
    };
    assert_eq!(
        audit_trail(&admin.app, "shift.create").await,
        vec![
            created(&plain, "OCT26-001"),
            created(&explicit, "OCT26-002"),
            created(&with_pallets, "OCT26-003")
        ]
    );
    for shift in [&plain, &explicit] {
        assert_eq!(pallet_columns(&admin, shift).await, (0, None, None));
    }
    assert_eq!(
        pallet_columns(&admin, &with_pallets).await,
        (1, Some(40), Some(pallet.clone()))
    );
    // An edit that leaves the pallets alone writes no pallet field.
    let (status, edited) = admin
        .call(
            "PUT",
            &path(&plain),
            Some(json!({ "plannedQty": 900, "expectedRev": plain["rev"] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{edited}");
    assert_eq!(
        audit_trail(&admin.app, "shift.update").await,
        vec![admin.row(
            "shift.update",
            "shift",
            plain["id"].as_str().unwrap(),
            json!({ "changed": ["plannedQty"], "plannedQty": { "from": null, "to": 900 } })
        )]
    );
    assert_eq!(pallet_columns(&admin, &plain).await, (0, None, None));
    // `palletsEnabled: false` on a shift without pallets changes nothing.
    let revision = host_revision(&admin.app).await;
    let (status, same) = admin
        .call(
            "PUT",
            &path(&edited),
            Some(json!({ "palletsEnabled": false, "expectedRev": edited["rev"] })),
        )
        .await;
    assert_eq!((status, same), (StatusCode::OK, edited.clone()));
    assert_eq!(host_revision(&admin.app).await, revision);
    assert_eq!(audit_trail(&admin.app, "shift.update").await.len(), 1);
    // Turning the pallets off leaves nothing of them in the table.
    let (status, off) = admin
        .call(
            "PUT",
            &path(&with_pallets),
            Some(json!({ "palletsEnabled": false, "expectedRev": with_pallets["rev"] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{off}");
    assert_eq!(pallet_columns(&admin, &with_pallets).await, (0, None, None));
}

/// Pallets turned on by an edit take the capacity the edit names, not the
/// product's, and a capacity without a template is refused; the largest
/// capacity is taken, and a closed shift keeps its pallets.
#[tokio::test]
async fn pallets_turned_on_take_the_capacity_the_edit_names_and_a_closed_shift_keeps_them() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let pallet = pallet_template(&admin).await;
    let plain = plan_shift(&admin, shift_body(&setup)).await;
    let id = plain["id"].as_str().unwrap().to_owned();
    let (status, refused) = admin
        .call(
            "PUT",
            &path(&plain),
            Some(json!({
                "palletsEnabled": true, "palletBoxCapacity": 25, "expectedRev": plain["rev"]
            })),
        )
        .await;
    assert_eq!(
        (status, refusal(&refused)),
        (StatusCode::BAD_REQUEST, field("palletTemplateId"))
    );
    assert_eq!(pallet_columns(&admin, &plain).await, (0, None, None));
    let (status, on) = admin
        .call(
            "PUT",
            &path(&plain),
            Some(json!({
                "palletsEnabled": true, "palletTemplateId": pallet, "palletBoxCapacity": 25,
                "expectedRev": plain["rev"]
            })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{on}");
    assert_eq!(
        (
            on["palletsEnabled"].clone(),
            on["palletBoxCapacity"].clone(),
            on["palletTemplateId"].clone()
        ),
        (json!(true), json!(25), json!(pallet))
    );
    assert_eq!(
        audit_trail(&admin.app, "shift.update").await,
        vec![admin.row(
            "shift.update",
            "shift",
            &id,
            json!({
                "changed": ["palletsEnabled", "palletBoxCapacity", "palletTemplateId"],
                "palletsEnabled": { "from": false, "to": true },
                "palletBoxCapacity": { "from": null, "to": 25 },
                "palletTemplateId": { "from": null, "to": pallet },
            })
        )]
    );
    let (status, largest) = admin
        .call(
            "PUT",
            &path(&on),
            Some(json!({ "palletBoxCapacity": 10_000, "expectedRev": on["rev"] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{largest}");
    assert_eq!(largest["palletBoxCapacity"], json!(10_000));
    close_directly(&admin, &largest).await;
    let (_, closed) = admin.call("GET", &path(&largest), None).await;
    for change in [
        json!({ "palletBoxCapacity": 30 }),
        json!({ "palletsEnabled": false }),
        json!({ "palletTemplateId": pallet_template(&admin).await }),
    ] {
        let mut body = change.clone();
        body["expectedRev"] = closed["rev"].clone();
        let (status, refused) = admin.call("PUT", &path(&closed), Some(body)).await;
        assert_eq!(
            (status, refusal(&refused)),
            (
                StatusCode::CONFLICT,
                (
                    json!("conflict"),
                    json!({ "constraint": "shift_status", "status": "closed" })
                )
            ),
            "{change}"
        );
    }
    assert_eq!(
        pallet_columns(&admin, &closed).await,
        (1, Some(10_000), Some(pallet))
    );
}

/// A statement the schema refuses; the message names the kind of guard.
async fn refused(admin: &Admin, sql: &str, guard: &str) {
    let outcome = sqlx::query(sql).execute(&admin.app.state.pool).await;
    let message = outcome
        .err()
        .unwrap_or_else(|| panic!("the schema took {sql}"))
        .to_string();
    assert!(message.contains(guard), "{sql}: {message}");
}

/// A statement the schema takes (the control of the refusals around it).
async fn taken(admin: &Admin, sql: &str) {
    sqlx::query(sql)
        .execute(&admin.app.state.pool)
        .await
        .unwrap_or_else(|error| panic!("{sql}: {error}"));
}

/// An `INSERT` into `table` of `base` with `over` set or added; every value
/// is an SQL literal.
fn insert_into(table: &str, base: &[(&str, &str)], over: &[(&str, &str)]) -> String {
    let mut columns: Vec<(String, String)> = base
        .iter()
        .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
        .collect();
    for (name, value) in over {
        match columns.iter_mut().find(|(column, _)| column == name) {
            Some(slot) => slot.1 = (*value).to_owned(),
            None => columns.push(((*name).to_owned(), (*value).to_owned())),
        }
    }
    let names: Vec<&str> = columns.iter().map(|(name, _)| name.as_str()).collect();
    let values: Vec<&str> = columns.iter().map(|(_, value)| value.as_str()).collect();
    format!(
        "INSERT INTO {table} ({}) VALUES ({})",
        names.join(", "),
        values.join(", ")
    )
}

/// The SSCC of a pallet of serial `n` under the prefix 460068200 (extension
/// 1, a placeholder check digit: the schema reads only the shape).
fn pallet_sscc(n: u32) -> String {
    format!("1460068200{n:08}")
}

/// The tables of `0012` refuse the rows no fact may leave. Every refusal
/// breaks one rule and is paired with a control that differs in one thing.
#[tokio::test]
async fn the_pallet_tables_refuse_the_rows_no_fact_may_leave() {
    const CLOSED: &str = "'2026-10-08T08:30:00.000Z'";
    const AT: &str = "'2026-10-08T08:00:00.000Z'";
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let shift = plan_shift(&admin, shift_body(&setup)).await;
    let shift = format!("'{}'", shift["id"].as_str().unwrap());
    let device = format!("'{}'", station_id(&admin).await);
    let (colleague, _) = pair_device(&admin.app, "station").await;
    let colleague = format!("'{colleague}'");
    for (extension, request) in [(1, "pallet-block"), (0, "box-block")] {
        taken(
            &admin,
            &format!(
                "INSERT INTO sscc_blocks (id, issuer_prefix, extension, device_id, request_id, \
                 from_serial, to_serial, issued_at) VALUES ('{request}', '460068200', \
                 {extension}, {device}, '{request}', 0, 199, {AT})"
            ),
        )
        .await;
    }
    let ids: Vec<String> = (0..=30).map(|n| format!("'pallet-{n}'")).collect();
    let open = [
        ("shift_id", shift.as_str()),
        ("device_id", device.as_str()),
        ("opened_at", AT),
        ("received_at", AT),
    ];
    let serial = |n: u32| n.to_string();
    let sscc_literal = |n: u32| format!("'{}'", pallet_sscc(n));
    // A closed pallet: its SSCC, block, serial and count come together.
    let closed = |n: u32| -> Vec<(&str, String)> {
        vec![
            ("id", ids[n as usize].clone()),
            ("closed_at", CLOSED.to_owned()),
            ("sscc", sscc_literal(n)),
            ("block_id", "'pallet-block'".to_owned()),
            ("serial", serial(n)),
            ("box_count_reported", "3".to_owned()),
        ]
    };
    let pallet = |n: u32, over: &[(&str, &str)]| -> String {
        let mut columns: Vec<(&str, &str)> = open.to_vec();
        let named = closed(n);
        for (name, value) in &named {
            columns.push((name, value.as_str()));
        }
        insert_into("pallets", &columns, over)
    };
    let open_pallet = |n: u32, over: &[(&str, &str)]| -> String {
        let mut columns: Vec<(&str, &str)> = open.to_vec();
        columns.push(("id", ids[n as usize].as_str()));
        insert_into("pallets", &columns, over)
    };
    // Controls: a closed pallet, a pallet taken apart, an open pallet, and a
    // second and third open pallet of the same station and shift (one open
    // pallet is the station's rule, not the table's).
    taken(&admin, &pallet(1, &[])).await;
    taken(&admin, &pallet(2, &[("disassembled_at", CLOSED)])).await;
    taken(&admin, &open_pallet(3, &[])).await;
    taken(&admin, &open_pallet(4, &[])).await;
    taken(&admin, &open_pallet(5, &[])).await;
    let check = "CHECK constraint failed";
    for (n, over, guard) in [
        // A closed pallet lacks one of the four things that come with it.
        (10, vec![("sscc", "NULL")], check),
        (11, vec![("block_id", "NULL")], check),
        (12, vec![("serial", "NULL")], check),
        (13, vec![("box_count_reported", "NULL")], check),
        // An open pallet has one of them.
        (
            14,
            vec![
                ("closed_at", "NULL"),
                ("block_id", "NULL"),
                ("serial", "NULL"),
                ("box_count_reported", "NULL"),
            ],
            check,
        ),
        (
            15,
            vec![
                ("closed_at", "NULL"),
                ("sscc", "NULL"),
                ("serial", "NULL"),
                ("box_count_reported", "NULL"),
            ],
            check,
        ),
        (
            16,
            vec![
                ("closed_at", "NULL"),
                ("sscc", "NULL"),
                ("block_id", "NULL"),
                ("box_count_reported", "NULL"),
            ],
            check,
        ),
        (
            17,
            vec![
                ("closed_at", "NULL"),
                ("sscc", "NULL"),
                ("block_id", "NULL"),
                ("serial", "NULL"),
            ],
            check,
        ),
        // A count of boxes is positive; an open pallet is not taken apart.
        (18, vec![("box_count_reported", "0")], check),
        (
            19,
            vec![
                ("closed_at", "NULL"),
                ("sscc", "NULL"),
                ("block_id", "NULL"),
                ("serial", "NULL"),
                ("box_count_reported", "NULL"),
                ("disassembled_at", CLOSED),
            ],
            check,
        ),
        // The SSCC of a pallet: 18 digits, the extension 1 first.
        (20, vec![("sscc", "'14600682000000020'")], check),
        (21, vec![("sscc", "'1460068200000000211'")], check),
        (22, vec![("sscc", "'046006820000000022'")], check),
        // One SSCC is one pallet; one serial of a block is one label.
        (
            23,
            vec![("sscc", "'146006820000000001'")],
            "UNIQUE constraint failed",
        ),
        (24, vec![("serial", "1")], "UNIQUE constraint failed"),
        // The references.
        (
            25,
            vec![("shift_id", "'no-such-shift'")],
            "FOREIGN KEY constraint failed",
        ),
        (
            26,
            vec![("device_id", "'no-such-device'")],
            "FOREIGN KEY constraint failed",
        ),
        (
            27,
            vec![("block_id", "'no-such-block'")],
            "FOREIGN KEY constraint failed",
        ),
        (
            28,
            vec![("opened_at", "NULL")],
            "NOT NULL constraint failed",
        ),
        (
            29,
            vec![("received_at", "NULL")],
            "NOT NULL constraint failed",
        ),
    ] {
        refused(&admin, &pallet(n, &over), guard).await;
    }
    // The same serial of another block is another label: a control for the
    // pair, and the SSCC of an open pallet may not be set without the rest.
    taken(
        &admin,
        &pallet(6, &[("block_id", "'box-block'"), ("serial", "1")]),
    )
    .await;
    refused(
        &admin,
        &open_pallet(7, &[("sscc", "'146006820000000007'")]),
        check,
    )
    .await;
    // A pallet may not go back to its open state, nor be taken apart open.
    refused(
        &admin,
        "UPDATE pallets SET closed_at = NULL WHERE id = 'pallet-1'",
        check,
    )
    .await;
    refused(
        &admin,
        "UPDATE pallets SET disassembled_at = 'x' WHERE id = 'pallet-3'",
        check,
    )
    .await;
    taken(
        &admin,
        "UPDATE pallets SET disassembled_at = 'x' WHERE id = 'pallet-1'",
    )
    .await;

    // Exceptions of a pallet.
    let exception = |n: u32, device: &str, over: &[(&str, &str)]| -> String {
        let id = format!("'exception-{n}'");
        let record = format!("'record-{n}'");
        insert_into(
            "pallet_exceptions",
            &[
                ("id", id.as_str()),
                ("record_id", record.as_str()),
                ("kind", "'reprint'"),
                ("pallet_id", "'pallet-1'"),
                ("reason_code", "'damaged'"),
                ("shift_id", shift.as_str()),
                ("device_id", device),
                ("occurred_at", AT),
                ("received_at", AT),
            ],
            over,
        )
    };
    taken(&admin, &exception(1, &device, &[])).await;
    taken(&admin, &exception(2, &device, &[("kind", "'disassemble'")])).await;
    taken(
        &admin,
        &exception(
            3,
            &device,
            &[("reason_code", "'other'"), ("reason_text", "'torn'")],
        ),
    )
    .await;
    // Another device may use a record id the first one used.
    taken(
        &admin,
        &insert_into(
            "pallet_exceptions",
            &[
                ("id", "'exception-4'"),
                ("record_id", "'record-1'"),
                ("kind", "'reprint'"),
                ("pallet_id", "'pallet-1'"),
                ("reason_code", "'damaged'"),
                ("shift_id", shift.as_str()),
                ("device_id", colleague.as_str()),
                ("occurred_at", AT),
                ("received_at", AT),
            ],
            &[],
        ),
    )
    .await;
    for (n, over, guard) in [
        (10, vec![("kind", "'other'")], check),
        (11, vec![("kind", "NULL")], "NOT NULL constraint failed"),
        (12, vec![("reason_text", "'torn'")], check),
        (
            13,
            vec![("reason_code", "NULL")],
            "NOT NULL constraint failed",
        ),
        (
            14,
            vec![("pallet_id", "'no-such-pallet'")],
            "FOREIGN KEY constraint failed",
        ),
        (
            15,
            vec![("shift_id", "'no-such-shift'")],
            "FOREIGN KEY constraint failed",
        ),
        (
            16,
            vec![("device_id", "'no-such-device'")],
            "FOREIGN KEY constraint failed",
        ),
        (
            17,
            vec![("record_id", "'record-1'")],
            "UNIQUE constraint failed",
        ),
    ] {
        refused(&admin, &exception(n, &device, &over), guard).await;
    }

    // A box joins a pallet only once it is closed.
    let box_row = |id: &str, over: &[(&str, &str)]| -> String {
        let quoted = format!("'{id}'");
        insert_into(
            "boxes",
            &[
                ("id", quoted.as_str()),
                ("shift_id", shift.as_str()),
                ("device_id", device.as_str()),
                ("opened_at", AT),
                ("received_at", AT),
            ],
            over,
        )
    };
    // A closed box: its SSCC, block, serial and digest verdict come together.
    let box_with = |id: &str, serial: u32, over: &[(&str, &str)]| -> String {
        let sscc = format!("'0460068200{serial:07}0'");
        let serial = serial.to_string();
        let mut all: Vec<(&str, &str)> = vec![
            ("closed_at", CLOSED),
            ("sscc", sscc.as_str()),
            ("block_id", "'box-block'"),
            ("serial", serial.as_str()),
            ("digest_matches", "1"),
        ];
        all.extend_from_slice(over);
        box_row(id, &all)
    };
    taken(&admin, &box_with("box-1", 10, &[])).await;
    taken(
        &admin,
        &box_with("box-2", 11, &[("pallet_id", "'pallet-1'")]),
    )
    .await;
    taken(&admin, &box_row("box-3", &[])).await;
    refused(
        &admin,
        &box_row("box-4", &[("pallet_id", "'pallet-1'")]),
        check,
    )
    .await;
    refused(
        &admin,
        &box_with("box-5", 12, &[("pallet_id", "'no-such-pallet'")]),
        "FOREIGN KEY constraint failed",
    )
    .await;
    refused(
        &admin,
        "UPDATE boxes SET pallet_id = 'pallet-1' WHERE id = 'box-3'",
        check,
    )
    .await;
    taken(
        &admin,
        "UPDATE boxes SET pallet_id = 'pallet-1' WHERE id = 'box-1'",
    )
    .await;

    // The indexes: the lookups of the pallet tables and the deletion guard of
    // a pallet template, which reads a planned shift's pallet template.
    let indexes: Vec<String> = sqlx::query_scalar(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name IN \
         ('pallets_sscc', 'pallets_block_serial', 'pallets_shift', 'boxes_pallet', \
          'pallet_exceptions_record', 'pallet_exceptions_pallet', \
          'shifts_planned_pallet_template') ORDER BY name",
    )
    .fetch_all(&admin.app.state.pool)
    .await
    .unwrap();
    assert_eq!(
        indexes,
        [
            "boxes_pallet",
            "pallet_exceptions_pallet",
            "pallet_exceptions_record",
            "pallets_block_serial",
            "pallets_shift",
            "pallets_sscc",
            "shifts_planned_pallet_template"
        ]
    );
    let guard: String = sqlx::query_scalar(
        "SELECT sql FROM sqlite_master WHERE name = 'shifts_planned_pallet_template'",
    )
    .fetch_one(&admin.app.state.pool)
    .await
    .unwrap();
    assert!(
        guard.contains("ON shifts (pallet_template_id)")
            && guard.ends_with("WHERE status = 'planned'"),
        "{guard}"
    );
}

// The A4 sheet of a shift (plan А4, task 4).

#[tokio::test]
async fn a_shift_with_pallets_takes_the_named_sheet_or_the_default() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let template = pallet_template(&admin).await;
    // No default sheet: no sheet.
    let plain = plan_shift(&admin, pallet_shift_body(&setup, &template)).await;
    assert_eq!(plain["palletSheetTemplateId"], Value::Null);
    let portrait = stock_sheet(&admin, "pallet-a4-portrait").await;
    let landscape = stock_sheet(&admin, "pallet-a4-landscape").await;
    default_sheet_is(&admin, &portrait).await;
    let defaulted = plan_shift(&admin, pallet_shift_body(&setup, &template)).await;
    assert_eq!(defaulted["palletSheetTemplateId"], json!(portrait));
    let mut named = pallet_shift_body(&setup, &template);
    named["palletSheetTemplateId"] = json!(landscape);
    let named = plan_shift(&admin, named).await;
    assert_eq!(named["palletSheetTemplateId"], json!(landscape));
    // The shifts read back as they were planned, and the audit row names the
    // sheet of the shifts that have one, and only of them.
    let (status, read_back) = admin.call("GET", &path(&named), None).await;
    assert_eq!((status, read_back), (StatusCode::OK, named.clone()));
    let trail = audit_trail(&admin.app, "shift.create").await;
    let detail = |shift: &Value| {
        let id = shift["id"].as_str().unwrap();
        let row = trail
            .iter()
            .find(|row| row.4.as_deref() == Some(id))
            .unwrap();
        row.6.clone()
    };
    assert!(detail(&plain).get("palletSheetTemplateId").is_none());
    assert_eq!(detail(&defaulted)["palletSheetTemplateId"], json!(portrait));
    assert_eq!(detail(&named)["palletSheetTemplateId"], json!(landscape));
}

#[tokio::test]
async fn a_shift_without_pallets_names_no_sheet() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let sheet = stock_sheet(&admin, "pallet-a4-portrait").await;
    // A default sheet does not reach a shift without pallets.
    default_sheet_is(&admin, &sheet).await;
    let plain = plan_shift(&admin, shift_body(&setup)).await;
    assert_eq!(plain["palletSheetTemplateId"], Value::Null);
    let rows = audit_rows(&admin.app).await;
    let revision = host_revision(&admin.app).await;
    let mut body = shift_body(&setup);
    body["palletSheetTemplateId"] = json!(sheet);
    let (status, refused) = admin.call("POST", "/v1/office/shifts", Some(body)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{refused}");
    assert_eq!(refused["error"]["code"], "validation_failed");
    assert_eq!(
        refused["error"]["details"]["field"],
        "palletSheetTemplateId"
    );
    // The refusal wrote nothing.
    assert_eq!(audit_rows(&admin.app).await, rows);
    assert_eq!(host_revision(&admin.app).await, revision);
    let (_, list) = admin.call("GET", "/v1/office/shifts", None).await;
    assert_eq!(list.as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn a_sheet_that_is_not_there_or_not_enabled_is_refused_at_planning() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let template = pallet_template(&admin).await;
    let sheet = stock_sheet(&admin, "pallet-a4-portrait").await;
    let (status, _) = admin
        .call(
            "PUT",
            &format!("/v1/office/pallet-sheets/{sheet}"),
            Some(json!({ "enabled": false, "expectedRevision": 1 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    for id in [sheet.as_str(), "6a3f0c5e-1b2d-4e8f-9a7b-0c1d2e3f4a5b"] {
        let mut body = pallet_shift_body(&setup, &template);
        body["palletSheetTemplateId"] = json!(id);
        let (status, refused) = admin.call("POST", "/v1/office/shifts", Some(body)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{refused}");
        assert_eq!(
            refused["error"]["details"]["field"],
            "palletSheetTemplateId"
        );
    }
    let (_, list) = admin.call("GET", "/v1/office/shifts", None).await;
    assert_eq!(list, json!([]));
}

#[tokio::test]
async fn an_edit_changes_the_sheet_and_turning_pallets_off_clears_it() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let template = pallet_template(&admin).await;
    let portrait = stock_sheet(&admin, "pallet-a4-portrait").await;
    let landscape = stock_sheet(&admin, "pallet-a4-landscape").await;
    let mut body = pallet_shift_body(&setup, &template);
    body["palletSheetTemplateId"] = json!(portrait);
    let shift = plan_shift(&admin, body).await;
    let id = shift["id"].as_str().unwrap().to_owned();
    let (status, changed) = admin
        .call(
            "PUT",
            &path(&shift),
            Some(json!({ "palletSheetTemplateId": landscape, "expectedRev": shift["rev"] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{changed}");
    assert_eq!(changed["palletSheetTemplateId"], json!(landscape));
    assert_eq!(
        audit_trail(&admin.app, "shift.update").await,
        vec![admin.row(
            "shift.update",
            "shift",
            &id,
            json!({
                "changed": ["palletSheetTemplateId"],
                "palletSheetTemplateId": { "from": portrait, "to": landscape },
            })
        )]
    );
    // Another edit keeps the sheet, whatever it sends besides.
    let (status, kept) = admin
        .call(
            "PUT",
            &path(&shift),
            Some(json!({ "plannedQty": 500, "expectedRev": changed["rev"] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{kept}");
    assert_eq!(kept["palletSheetTemplateId"], json!(landscape));
    // Sending the sheet it already has changes nothing.
    let (status, same) = admin
        .call(
            "PUT",
            &path(&shift),
            Some(json!({ "palletSheetTemplateId": landscape, "expectedRev": kept["rev"] })),
        )
        .await;
    assert_eq!(
        (status, same["rev"].clone()),
        (StatusCode::OK, kept["rev"].clone())
    );
    let (status, off) = admin
        .call(
            "PUT",
            &path(&shift),
            Some(json!({ "palletsEnabled": false, "expectedRev": kept["rev"] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{off}");
    assert_eq!(off["palletSheetTemplateId"], Value::Null);
    let stored: Option<String> =
        sqlx::query_scalar("SELECT pallet_sheet_template_id FROM shifts WHERE id = ?")
            .bind(&id)
            .fetch_one(&admin.app.state.pool)
            .await
            .unwrap();
    assert_eq!(stored, None);
    // Without pallets a sheet is refused, and the refusal changes nothing.
    let revision = host_revision(&admin.app).await;
    let (status, refused) = admin
        .call(
            "PUT",
            &path(&shift),
            Some(json!({ "palletSheetTemplateId": portrait, "expectedRev": off["rev"] })),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{refused}");
    assert_eq!(
        refused["error"]["details"]["field"],
        "palletSheetTemplateId"
    );
    assert_eq!(host_revision(&admin.app).await, revision);
}

#[tokio::test]
async fn pallets_turned_on_by_an_edit_take_the_named_sheet_or_the_default() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let template = pallet_template(&admin).await;
    let portrait = stock_sheet(&admin, "pallet-a4-portrait").await;
    let landscape = stock_sheet(&admin, "pallet-a4-landscape").await;
    let first = plan_shift(&admin, shift_body(&setup)).await;
    // No default sheet yet: pallets on, no sheet.
    let (status, plain) = admin
        .call(
            "PUT",
            &path(&first),
            Some(json!({
                "palletsEnabled": true, "palletTemplateId": template, "expectedRev": first["rev"]
            })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{plain}");
    assert_eq!(plain["palletSheetTemplateId"], Value::Null);
    default_sheet_is(&admin, &portrait).await;
    // The default reaches the shift whose pallets just turned on, not one
    // that already had them.
    let second = plan_shift(&admin, shift_body(&setup)).await;
    let (status, defaulted) = admin
        .call(
            "PUT",
            &path(&second),
            Some(json!({
                "palletsEnabled": true, "palletTemplateId": template, "expectedRev": second["rev"]
            })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{defaulted}");
    assert_eq!(defaulted["palletSheetTemplateId"], json!(portrait));
    let (status, kept) = admin
        .call(
            "PUT",
            &path(&first),
            Some(json!({ "plannedQty": 7, "expectedRev": plain["rev"] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{kept}");
    assert_eq!(kept["palletSheetTemplateId"], Value::Null);
    // Turned on with a named sheet, the named one wins.
    let third = plan_shift(&admin, shift_body(&setup)).await;
    let (status, named) = admin
        .call(
            "PUT",
            &path(&third),
            Some(json!({
                "palletsEnabled": true, "palletTemplateId": template,
                "palletSheetTemplateId": landscape, "expectedRev": third["rev"]
            })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{named}");
    assert_eq!(named["palletSheetTemplateId"], json!(landscape));
}

#[tokio::test]
async fn an_edit_checks_a_changed_sheet_and_keeps_an_unchanged_one_even_if_disabled() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let template = pallet_template(&admin).await;
    let portrait = stock_sheet(&admin, "pallet-a4-portrait").await;
    let landscape = stock_sheet(&admin, "pallet-a4-landscape").await;
    let mut body = pallet_shift_body(&setup, &template);
    body["palletSheetTemplateId"] = json!(portrait);
    let shift = plan_shift(&admin, body).await;
    let (status, _) = admin
        .call(
            "PUT",
            &format!("/v1/office/pallet-sheets/{portrait}"),
            Some(json!({ "enabled": false, "expectedRevision": 1 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = admin
        .call(
            "PUT",
            &format!("/v1/office/pallet-sheets/{landscape}"),
            Some(json!({ "enabled": false, "expectedRevision": 1 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    // The planned shift keeps the sheet turned off since...
    let (status, kept) = admin
        .call(
            "PUT",
            &path(&shift),
            Some(json!({ "plannedQty": 9, "expectedRev": shift["rev"] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{kept}");
    assert_eq!(kept["palletSheetTemplateId"], json!(portrait));
    // Naming that very sheet again is no move, so it is not checked either.
    let (status, again) = admin
        .call(
            "PUT",
            &path(&shift),
            Some(json!({
                "palletSheetTemplateId": portrait, "plannedQty": 11, "expectedRev": kept["rev"]
            })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{again}");
    assert_eq!(again["palletSheetTemplateId"], json!(portrait));
    let kept = again;
    // ... and refuses to move to a sheet that is turned off or not there.
    for id in [landscape.as_str(), "6a3f0c5e-1b2d-4e8f-9a7b-0c1d2e3f4a5b"] {
        let (status, refused) = admin
            .call(
                "PUT",
                &path(&shift),
                Some(json!({ "palletSheetTemplateId": id, "expectedRev": kept["rev"] })),
            )
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{refused}");
        assert_eq!(
            refused["error"]["details"]["field"],
            "palletSheetTemplateId"
        );
    }
    let (_, now) = admin.call("GET", &path(&shift), None).await;
    assert_eq!(now["palletSheetTemplateId"], json!(portrait));
}

#[tokio::test]
async fn an_open_shift_keeps_its_sheet_and_takes_no_other() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let template = pallet_template(&admin).await;
    let portrait = stock_sheet(&admin, "pallet-a4-portrait").await;
    let landscape = stock_sheet(&admin, "pallet-a4-landscape").await;
    let mut body = pallet_shift_body(&setup, &template);
    body["palletSheetTemplateId"] = json!(portrait);
    let shift = plan_shift(&admin, body).await;
    open_directly(&admin, &shift).await;
    let (_, open) = admin.call("GET", &path(&shift), None).await;
    // The plan edit of an active shift passes with the sheet it has...
    let (status, planned) = admin
        .call(
            "PUT",
            &path(&shift),
            Some(json!({
                "plannedQty": 3, "palletSheetTemplateId": portrait, "expectedRev": open["rev"]
            })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{planned}");
    assert_eq!(planned["palletSheetTemplateId"], json!(portrait));
    // ... and is `shift_status` with another sheet.
    let (status, refused) = admin
        .call(
            "PUT",
            &path(&shift),
            Some(json!({ "palletSheetTemplateId": landscape, "expectedRev": planned["rev"] })),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{refused}");
    assert_eq!(refused["error"]["details"]["constraint"], "shift_status");
    let (_, now) = admin.call("GET", &path(&shift), None).await;
    assert_eq!(now["palletSheetTemplateId"], json!(portrait));
}

/// `palletSheetTemplateId: null` (plan А4, final wave): a planned shift goes
/// back to the organization's main sheet as it is at that edit — none when
/// there is no main sheet — and keeps it; the audit row names the move.
#[tokio::test]
async fn a_planned_shift_goes_back_to_the_main_sheet_with_null() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let template = pallet_template(&admin).await;
    let portrait = stock_sheet(&admin, "pallet-a4-portrait").await;
    let landscape = stock_sheet(&admin, "pallet-a4-landscape").await;
    let mut body = pallet_shift_body(&setup, &template);
    body["palletSheetTemplateId"] = json!(landscape);
    // No main sheet yet: back to «main» is no sheet.
    let first = plan_shift(&admin, body.clone()).await;
    let first_id = first["id"].as_str().unwrap().to_owned();
    let (status, bare) = admin
        .call(
            "PUT",
            &path(&first),
            Some(json!({ "palletSheetTemplateId": null, "expectedRev": first["rev"] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{bare}");
    assert_eq!(bare["palletSheetTemplateId"], Value::Null);
    // With a main sheet, «main» is that sheet, resolved at the edit.
    default_sheet_is(&admin, &portrait).await;
    let second = plan_shift(&admin, body).await;
    let second_id = second["id"].as_str().unwrap().to_owned();
    assert_eq!(second["palletSheetTemplateId"], json!(landscape));
    let (status, main) = admin
        .call(
            "PUT",
            &path(&second),
            Some(json!({ "palletSheetTemplateId": null, "expectedRev": second["rev"] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{main}");
    assert_eq!(main["palletSheetTemplateId"], json!(portrait));
    let stored: Option<String> =
        sqlx::query_scalar("SELECT pallet_sheet_template_id FROM shifts WHERE id = ?")
            .bind(&second_id)
            .fetch_one(&admin.app.state.pool)
            .await
            .unwrap();
    assert_eq!(stored.as_deref(), Some(portrait.as_str()));
    assert_eq!(
        audit_trail(&admin.app, "shift.update").await,
        vec![
            admin.row(
                "shift.update",
                "shift",
                &first_id,
                json!({
                    "changed": ["palletSheetTemplateId"],
                    "palletSheetTemplateId": { "from": landscape, "to": null },
                })
            ),
            admin.row(
                "shift.update",
                "shift",
                &second_id,
                json!({
                    "changed": ["palletSheetTemplateId"],
                    "palletSheetTemplateId": { "from": landscape, "to": portrait },
                })
            ),
        ]
    );
    // `null` again, now the main sheet it holds, changes nothing: no revision,
    // no audit row.
    let rows = audit_rows(&admin.app).await;
    let revision = host_revision(&admin.app).await;
    let (status, same) = admin
        .call(
            "PUT",
            &path(&second),
            Some(json!({ "palletSheetTemplateId": null, "expectedRev": main["rev"] })),
        )
        .await;
    assert_eq!(
        (status, same["rev"].clone()),
        (StatusCode::OK, main["rev"].clone())
    );
    assert_eq!(audit_rows(&admin.app).await, rows);
    assert_eq!(host_revision(&admin.app).await, revision);
    // A later change of the main sheet does not reach the shift, and an edit
    // that leaves the field out keeps what it holds.
    default_sheet_is(&admin, &landscape).await;
    let (status, kept) = admin
        .call(
            "PUT",
            &path(&second),
            Some(json!({ "plannedQty": 40, "expectedRev": main["rev"] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{kept}");
    assert_eq!(kept["palletSheetTemplateId"], json!(portrait));
    // The shift that had none takes the main sheet of the moment it asks.
    let (status, now) = admin
        .call(
            "PUT",
            &path(&first),
            Some(json!({ "palletSheetTemplateId": null, "expectedRev": bare["rev"] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{now}");
    assert_eq!(now["palletSheetTemplateId"], json!(landscape));
    // Pallets turned on with `null` take the main sheet too.
    let plain = plan_shift(&admin, shift_body(&setup)).await;
    let (status, on) = admin
        .call(
            "PUT",
            &path(&plain),
            Some(json!({
                "palletsEnabled": true, "palletTemplateId": template,
                "palletSheetTemplateId": null, "expectedRev": plain["rev"]
            })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{on}");
    assert_eq!(on["palletSheetTemplateId"], json!(landscape));
}

/// `null` asks for no sheet where there are no pallets, and an open shift
/// takes it only when the main sheet is the one it holds.
#[tokio::test]
async fn null_without_pallets_asks_for_nothing_and_an_open_shift_keeps_its_sheet() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let template = pallet_template(&admin).await;
    let portrait = stock_sheet(&admin, "pallet-a4-portrait").await;
    let landscape = stock_sheet(&admin, "pallet-a4-landscape").await;
    default_sheet_is(&admin, &portrait).await;
    // A shift without pallets: `null` passes and changes nothing.
    let plain = plan_shift(&admin, shift_body(&setup)).await;
    let rows = audit_rows(&admin.app).await;
    let revision = host_revision(&admin.app).await;
    let (status, same) = admin
        .call(
            "PUT",
            &path(&plain),
            Some(json!({ "palletSheetTemplateId": null, "expectedRev": plain["rev"] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{same}");
    assert_eq!(
        (same["rev"].clone(), same["palletSheetTemplateId"].clone()),
        (plain["rev"].clone(), Value::Null)
    );
    assert_eq!(audit_rows(&admin.app).await, rows);
    assert_eq!(host_revision(&admin.app).await, revision);
    // Pallets turned off in the same edit as `null`: no sheet.
    let mut body = pallet_shift_body(&setup, &template);
    body["palletSheetTemplateId"] = json!(landscape);
    let sheeted = plan_shift(&admin, body).await;
    let (status, off) = admin
        .call(
            "PUT",
            &path(&sheeted),
            Some(json!({
                "palletsEnabled": false, "palletSheetTemplateId": null,
                "expectedRev": sheeted["rev"]
            })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{off}");
    assert_eq!(
        (
            off["palletsEnabled"].clone(),
            off["palletSheetTemplateId"].clone()
        ),
        (json!(false), Value::Null)
    );
    // An open shift that holds the main sheet takes `null` with its plan...
    let held = plan_shift(&admin, pallet_shift_body(&setup, &template)).await;
    assert_eq!(held["palletSheetTemplateId"], json!(portrait));
    open_directly(&admin, &held).await;
    let (_, open) = admin.call("GET", &path(&held), None).await;
    let (status, planned) = admin
        .call(
            "PUT",
            &path(&held),
            Some(json!({
                "plannedQty": 3, "palletSheetTemplateId": null, "expectedRev": open["rev"]
            })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{planned}");
    assert_eq!(
        (
            planned["plannedQty"].clone(),
            planned["palletSheetTemplateId"].clone()
        ),
        (json!(3), json!(portrait))
    );
    // ... and refuses it as `shift_status` once the main sheet is another.
    default_sheet_is(&admin, &landscape).await;
    let revision = host_revision(&admin.app).await;
    let (status, refused) = admin
        .call(
            "PUT",
            &path(&held),
            Some(json!({ "palletSheetTemplateId": null, "expectedRev": planned["rev"] })),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{refused}");
    assert_eq!(refused["error"]["details"]["constraint"], "shift_status");
    assert_eq!(host_revision(&admin.app).await, revision);
    let (_, now) = admin.call("GET", &path(&held), None).await;
    assert_eq!(now["palletSheetTemplateId"], json!(portrait));
}
