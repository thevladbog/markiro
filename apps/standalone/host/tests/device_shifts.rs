mod support;

use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{
    admin, audit_rows, audit_trail, empty, host_revision, json as json_request, pair_device,
    plan_shift, request, shift_body, shift_setup, with_device, Admin, AuditRow, ShiftSetup, LAN,
};

/// This station's own id, as the host has it.
async fn device_id(admin: &Admin, key: &str) -> String {
    let (status, device) = admin
        .app
        .send(empty(with_device(request("GET", "/v1/device"), key)))
        .await;
    assert_eq!(status, StatusCode::OK, "{device}");
    device["id"].as_str().unwrap().to_owned()
}

/// Put the station of `key` on `line`.
async fn select_line(admin: &Admin, key: &str, line: &str) {
    let (status, body) = admin
        .app
        .send(json_request(
            with_device(request("PUT", "/v1/device/line"), key),
            json!({ "lineId": line }),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
}

/// A device request with `key`; returns the status and the body.
async fn device_call(
    admin: &Admin,
    key: &str,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let builder = with_device(request(method, path), key);
    match body {
        Some(body) => admin.app.send(json_request(builder, body)).await,
        None => admin.app.send(empty(builder)).await,
    }
}

/// The ids of a `GET /v1/device/shifts` answer, in order.
async fn listed(admin: &Admin, key: &str) -> Vec<Value> {
    let (status, body) = device_call(admin, key, "GET", "/v1/device/shifts", None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body["shifts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|shift| shift["id"].clone())
        .collect()
}

/// Open a shift straight in its table for `device`, with a snapshot that
/// names the product and the counterparty, and record the device's entry
/// (the entry route comes with the next task).
async fn open_directly(admin: &Admin, shift: &Value, device: &str, snapshot: Value) {
    let at = admin.app.state.timestamp();
    let id = shift["id"].as_str().unwrap();
    sqlx::query(
        "UPDATE shifts SET status = 'active', snapshot = ?, opened_at = ?, owner_device_id = ? \
         WHERE id = ?",
    )
    .bind(snapshot.to_string())
    .bind(&at)
    .bind(device)
    .bind(id)
    .execute(&admin.app.state.pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO shift_participants (shift_id, device_id, first_entered_at, last_entered_at) \
         VALUES (?, ?, ?, ?)",
    )
    .bind(id)
    .bind(device)
    .bind(&at)
    .bind(&at)
    .execute(&admin.app.state.pool)
    .await
    .unwrap();
}

/// Close an open shift straight in its table.
async fn close_directly(admin: &Admin, shift: &Value, device: &str) {
    sqlx::query(
        "UPDATE shifts SET status = 'closed', closed_at = ?, closed_by_kind = 'device', \
         closed_by = ? WHERE id = ?",
    )
    .bind(admin.app.state.timestamp())
    .bind(device)
    .bind(shift["id"].as_str().unwrap())
    .execute(&admin.app.state.pool)
    .await
    .unwrap();
}

fn snapshot(product_name: &str, counterparty_name: Value) -> Value {
    json!({
        // Not the record's GTIN: the shift keeps the one it opened with.
        "product": { "name": product_name, "gtin14": "04600682000020" },
        "counterpartyName": counterparty_name
    })
}

/// A station's view of `shift_body(setup)` planned on the first line.
fn device_shift(id: &str, number: &str, setup: &ShiftSetup) -> Value {
    json!({
        "id": id, "number": number, "status": "planned", "mode": "aggregation",
        "palletsEnabled": false, "createdFrom": "office", "lineId": setup.line,
        "productId": setup.product, "productName": "Молоко 3,2% 0,9 л",
        "productGtin14": "04600682000013", "counterpartyName": null,
        "productionDate": "2026-10-08", "plannedQty": null, "boxCapacity": 12,
        "boxTemplateId": setup.template, "ownerDeviceId": null, "openedAt": null,
        "closedAt": null
    })
}

#[tokio::test]
async fn a_station_sees_the_open_shifts_of_its_line_and_those_it_entered() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let station = device_id(&admin, &admin.key).await;
    let (other, other_key) = pair_device(&admin.app, "station").await;
    select_line(&admin, &admin.key, &setup.line).await;
    select_line(&admin, &other_key, &setup.line).await;
    let mut body = shift_body(&setup);
    let planned = plan_shift(&admin, body.clone()).await;
    body["productionDate"] = json!("2026-10-07");
    let busy = plan_shift(&admin, body.clone()).await;
    let closed = plan_shift(&admin, body.clone()).await;
    body["lineId"] = json!(setup.other_line);
    let elsewhere = plan_shift(&admin, body.clone()).await;
    let entered_elsewhere = plan_shift(&admin, body).await;
    open_directly(
        &admin,
        &busy,
        &other,
        snapshot("Молоко (снимок)", json!("ООО «Берег»")),
    )
    .await;
    open_directly(&admin, &closed, &station, snapshot("Молоко", Value::Null)).await;
    close_directly(&admin, &closed, &station).await;
    open_directly(
        &admin,
        &entered_elsewhere,
        &station,
        snapshot("Молоко", Value::Null),
    )
    .await;

    // By production date: the busy shift of 7 October, the closed one this
    // station entered, the one it entered on another line, then the plan.
    assert_eq!(
        listed(&admin, &admin.key).await,
        vec![
            busy["id"].clone(),
            closed["id"].clone(),
            entered_elsewhere["id"].clone(),
            planned["id"].clone()
        ]
    );
    // The other station sees its own shift and the plan, not this
    // station's closed shift or the other line.
    assert_eq!(
        listed(&admin, &other_key).await,
        vec![busy["id"].clone(), planned["id"].clone()]
    );
    assert!(!listed(&admin, &admin.key)
        .await
        .contains(&elsewhere["id"].clone()));

    // A plan reads the product as it is; an open shift reads its snapshot.
    let (status, list) = device_call(&admin, &admin.key, "GET", "/v1/device/shifts", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        list["shifts"][3],
        device_shift(
            planned["id"].as_str().unwrap(),
            planned["number"].as_str().unwrap(),
            &setup
        )
    );
    let busy_view = &list["shifts"][0];
    assert_eq!(
        [
            busy_view["status"].clone(),
            busy_view["productName"].clone(),
            busy_view["productGtin14"].clone(),
            busy_view["counterpartyName"].clone(),
            busy_view["ownerDeviceId"].clone()
        ],
        [
            json!("active"),
            json!("Молоко (снимок)"),
            json!("04600682000020"),
            json!("ООО «Берег»"),
            json!(other)
        ]
    );

    // A closed shift this station entered leaves its list after 30 days.
    admin.app.clock.advance(time::Duration::days(30));
    assert!(listed(&admin, &admin.key)
        .await
        .contains(&closed["id"].clone()));
    admin.app.clock.advance(time::Duration::seconds(1));
    assert!(!listed(&admin, &admin.key)
        .await
        .contains(&closed["id"].clone()));
}

#[tokio::test]
async fn only_a_station_reads_and_creates_shifts() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let (_, unassigned) = pair_device(&admin.app, "station").await;
    plan_shift(&admin, shift_body(&setup)).await;
    // A station without a line sees no line's shifts.
    assert_eq!(listed(&admin, &unassigned).await, Vec::<Value>::new());
    // A device of another kind (the office kind pairs from loopback, a
    // handheld with a code).
    let (_, office_pc) = pair_device(&admin.app, "office").await;
    let handheld = pair_handheld(&admin).await;
    for (method, body) in [
        ("GET", None),
        ("POST", Some(device_create(&setup, REQUEST))),
    ] {
        for (kind, key) in [("office", &office_pc), ("handheld", &handheld)] {
            let (status, refused) =
                device_call(&admin, key, method, "/v1/device/shifts", body.clone()).await;
            assert_eq!(
                (status, refused["error"]["code"].clone()),
                (StatusCode::FORBIDDEN, json!("forbidden")),
                "{kind} {method}"
            );
        }
        let builder = request(method, "/v1/device/shifts");
        let (status, refused) = match body {
            Some(body) => admin.app.send(json_request(builder, body)).await,
            None => admin.app.send(empty(builder)).await,
        };
        assert_eq!(
            (status, refused["error"]["details"]["credential"].clone()),
            (StatusCode::UNAUTHORIZED, json!("device")),
            "{method}"
        );
    }
}

/// A station's create of `setup`'s product with `request_id`.
fn device_create(setup: &ShiftSetup, request_id: &str) -> Value {
    json!({
        "requestId": request_id,
        "productId": setup.product,
        "boxTemplateId": setup.template,
        "productionDate": "2026-10-09"
    })
}

const REQUEST: &str = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const SECOND_REQUEST: &str = "1b2c3d4e-5f60-4a71-8b82-93a4b5c6d7e8";

/// A handheld device paired with a code, as the office hands one out;
/// returns its key.
async fn pair_handheld(admin: &Admin) -> String {
    let (status, code) = admin.call("POST", "/v1/office/pairing-codes", None).await;
    assert_eq!(status, StatusCode::OK, "{code}");
    let (status, paired) = admin
        .app
        .send_from(
            LAN,
            json_request(
                request("POST", "/v1/pairing/claim"),
                json!({ "code": code["code"], "kind": "handheld", "name": "ТСД 1",
                    "appVersion": "1.2.0", "capabilities": ["scanner"] }),
            ),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{paired}");
    paired["deviceKey"].as_str().unwrap().to_owned()
}

/// The `ok` audit row a station writes.
fn device_row(device: &str, action: &str, target_id: &str, details: Value) -> AuditRow {
    (
        "device".to_owned(),
        Some(device.to_owned()),
        action.to_owned(),
        Some("shift".to_owned()),
        Some(target_id.to_owned()),
        "ok".to_owned(),
        details,
    )
}

#[tokio::test]
async fn a_station_creates_a_shift_on_its_line_once_per_request() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let station = device_id(&admin, &admin.key).await;
    select_line(&admin, &admin.key, &setup.line).await;
    let (status, created) = device_call(
        &admin,
        &admin.key,
        "POST",
        "/v1/device/shifts",
        Some(device_create(&setup, REQUEST)),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let id = created["id"].as_str().unwrap().to_owned();
    let mut expected = device_shift(&id, "OCT26-001/S", &setup);
    expected["createdFrom"] = json!("station");
    expected["productionDate"] = json!("2026-10-09");
    assert_eq!(created, expected);
    assert_eq!(host_revision(&admin.app).await, 4);
    assert_eq!(
        audit_trail(&admin.app, "shift.create").await,
        vec![device_row(
            &station,
            "shift.create",
            &id,
            json!({
                "number": "OCT26-001/S", "productId": setup.product, "lineId": setup.line,
                "productionDate": "2026-10-09"
            })
        )]
    );
    // The office sees it as a station's.
    let (status, office) = admin
        .call("GET", &format!("/v1/office/shifts/{id}"), None)
        .await;
    assert_eq!(
        (
            status,
            office["createdFrom"].clone(),
            office["number"].clone()
        ),
        (StatusCode::OK, json!("station"), json!("OCT26-001/S"))
    );
    // The same request again is the same shift, whatever it says now: no
    // second shift, no revision, no row.
    let rows = audit_rows(&admin.app).await;
    let mut again = device_create(&setup, REQUEST);
    again["plannedQty"] = json!(600);
    let (status, repeated) =
        device_call(&admin, &admin.key, "POST", "/v1/device/shifts", Some(again)).await;
    assert_eq!((status, repeated), (StatusCode::OK, created.clone()));
    assert_eq!(host_revision(&admin.app).await, 4);
    assert_eq!(audit_rows(&admin.app).await, rows);
    // Another request of the same station is another shift.
    let (status, second) = device_call(
        &admin,
        &admin.key,
        "POST",
        "/v1/device/shifts",
        Some(device_create(&setup, SECOND_REQUEST)),
    )
    .await;
    assert_eq!(
        (status, second["number"].clone()),
        (StatusCode::OK, json!("OCT26-002/S"))
    );
    assert_ne!(second["id"], created["id"]);
    assert_eq!(host_revision(&admin.app).await, 5);
    // Another station's request with the same id is its own.
    let (_, other_key) = pair_device(&admin.app, "station").await;
    select_line(&admin, &other_key, &setup.line).await;
    let (status, other) = device_call(
        &admin,
        &other_key,
        "POST",
        "/v1/device/shifts",
        Some(device_create(&setup, REQUEST)),
    )
    .await;
    assert_eq!(
        (status, other["number"].clone()),
        (StatusCode::OK, json!("OCT26-003/S"))
    );
}

#[tokio::test]
async fn a_station_create_follows_the_plan_rules_on_its_own_line() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let (status, draft) = admin
        .call(
            "POST",
            "/v1/office/products",
            Some(json!({ "gtin14": "04600682000020", "name": "Кефир" })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{draft}");
    let (status, beer) = admin
        .call(
            "POST",
            "/v1/office/templates",
            Some(json!({ "name": "Пиво", "purpose": "box", "enabled": true,
                "chzProductGroupCodes": [15], "spec": { "widthMm": 58 } })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{beer}");
    let rows = audit_rows(&admin.app).await;
    let revision = host_revision(&admin.app).await;
    let create = |change: Value| {
        let mut body = device_create(&setup, REQUEST);
        for (key, value) in change.as_object().unwrap() {
            body[key] = value.clone();
        }
        body
    };
    let refused = |status: StatusCode, code: &str, details: Value| (status, (json!(code), details));
    let field = |name: &str| {
        refused(
            StatusCode::BAD_REQUEST,
            "validation_failed",
            json!({ "field": name }),
        )
    };
    let send = |body: Value| async {
        let (status, answer) =
            device_call(&admin, &admin.key, "POST", "/v1/device/shifts", Some(body)).await;
        (
            status,
            (
                answer["error"]["code"].clone(),
                answer["error"]["details"].clone(),
            ),
        )
    };
    // Without a line there is nowhere to put the shift.
    assert_eq!(
        send(create(json!({}))).await,
        refused(
            StatusCode::CONFLICT,
            "conflict",
            json!({ "constraint": "shift_line" })
        )
    );
    select_line(&admin, &admin.key, &setup.line).await;
    for (change, expected) in [
        (json!({ "requestId": "not-a-uuid" }), field("requestId")),
        (
            json!({ "requestId": REQUEST.to_uppercase() }),
            field("requestId"),
        ),
        (
            json!({ "productId": draft["id"] }),
            refused(
                StatusCode::CONFLICT,
                "conflict",
                json!({ "constraint": "product_inactive" }),
            ),
        ),
        (
            json!({ "boxTemplateId": beer["id"] }),
            field("boxTemplateId"),
        ),
        (
            json!({ "counterpartyId": "no-such-counterparty" }),
            field("counterpartyId"),
        ),
        (
            json!({ "productionDate": "2026-02-29" }),
            field("productionDate"),
        ),
        (json!({ "plannedQty": 0 }), field("plannedQty")),
        (json!({ "boxCapacity": 100_001 }), field("boxCapacity")),
    ] {
        assert_eq!(send(create(change.clone())).await, expected, "{change}");
    }
    // A station creates on its own line only: a line is no field.
    let (status, (code, details)) = send(create(json!({ "lineId": setup.other_line }))).await;
    assert_eq!(
        (status, code, details),
        (
            StatusCode::BAD_REQUEST,
            json!("validation_failed"),
            Value::Null
        )
    );
    // A station left on an archived line creates nothing there.
    let (status, line) = admin
        .call(
            "PUT",
            &format!("/v1/office/lines/{}", setup.line),
            Some(json!({ "archived": true, "expectedRev": 1 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{line}");
    assert_eq!(send(create(json!({}))).await, field("lineId"));
    // The line's archiving is the only write.
    assert_eq!(audit_rows(&admin.app).await, rows + 2);
    assert_eq!(host_revision(&admin.app).await, revision + 1);
}

#[tokio::test]
async fn a_station_create_takes_every_field_it_names() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    select_line(&admin, &admin.key, &setup.line).await;
    let (status, counterparty) = admin
        .call(
            "POST",
            "/v1/office/counterparties",
            Some(json!({ "name": "ООО «Северный берег»", "gln": "4601234000017", "gs1Prefixes": [] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{counterparty}");
    let mut body = device_create(&setup, REQUEST);
    body["boxCapacity"] = json!(6);
    body["plannedQty"] = json!(1200);
    body["counterpartyId"] = counterparty["id"].clone();
    let (status, created) =
        device_call(&admin, &admin.key, "POST", "/v1/device/shifts", Some(body)).await;
    assert_eq!(status, StatusCode::OK, "{created}");
    // The capacity is the station's, not the product's 12; the counterparty
    // is named by the record until the shift opens.
    assert_eq!(
        [
            created["boxCapacity"].clone(),
            created["plannedQty"].clone(),
            created["counterpartyName"].clone()
        ],
        [json!(6), json!(1200), json!("ООО «Северный берег»")]
    );
    let (status, office) = admin
        .call(
            "GET",
            &format!("/v1/office/shifts/{}", created["id"].as_str().unwrap()),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{office}");
    assert_eq!(office["counterpartyId"], counterparty["id"]);
    assert_eq!(office["lineId"], json!(setup.line));
}
