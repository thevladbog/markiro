mod support;

use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{
    admin, audit_row, audit_rows, audit_trail, empty, host_revision, plan_shift, request,
    seed_office_user, shift_body, shift_setup, turn_the_user_off_at_the_next_activity, with_device,
    Admin, ShiftSetup,
};

/// The record of `shift_body(setup)` planned at `rev`: the product's box
/// capacity, no plan and no counterparty.
fn planned(id: &str, number: &str, setup: &ShiftSetup, rev: i64) -> Value {
    json!({
        "id": id, "number": number, "status": "planned", "mode": "aggregation",
        "palletsEnabled": false, "createdFrom": "office", "productId": setup.product,
        "lineId": setup.line, "counterpartyId": null, "productionDate": "2026-10-08",
        "plannedQty": null, "boxCapacity": 12, "boxTemplateId": setup.template,
        "ownerDeviceId": null, "openedAt": null, "closedAt": null, "closeReasonCode": null,
        "closeReasonText": null, "lateDataAt": null, "createdAt": "2026-09-21T14:13:20Z",
        "rev": rev
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
    for computed in ["id", "status", "rev"] {
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
        (json!({ "mode": "validation" }), field("mode")),
        (json!({ "palletsEnabled": true }), field("palletsEnabled")),
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
        (json!({ "mode": "validation" }), field("mode")),
        (json!({ "palletsEnabled": true }), field("palletsEnabled")),
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
        // As `turn_the_user_off_at_the_next_activity`, one trigger per user.
        sqlx::query(&format!(
            "CREATE TRIGGER turn_{method}_user_off AFTER UPDATE OF last_seen_at ON office_sessions \
             WHEN NEW.user_id = '{user}' \
             BEGIN UPDATE office_users SET active = 0 WHERE id = NEW.user_id; END"
        ))
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
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
