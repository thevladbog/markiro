mod support;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use http_body_util::BodyExt;
use markiro_host::auth::AuthDevice;
use markiro_host::error::ApiPath;
use markiro_host::routes::device_shifts::enter_shift;
use markiro_proto::DeviceKind;
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

/// `POST /v1/device/shifts/{id}/enter` with `key`.
async fn enter(admin: &Admin, key: &str, shift: &Value) -> (StatusCode, Value) {
    let path = format!("/v1/device/shifts/{}/enter", shift["id"].as_str().unwrap());
    device_call(admin, key, "POST", &path, None).await
}

/// The participants of a shift, as `(device, first entry, last entry)`.
async fn participants(admin: &Admin, shift: &Value) -> Vec<(String, String, String)> {
    sqlx::query_as(
        "SELECT device_id, first_entered_at, last_entered_at FROM shift_participants \
         WHERE shift_id = ? ORDER BY device_id",
    )
    .bind(shift["id"].as_str().unwrap())
    .fetch_all(&admin.app.state.pool)
    .await
    .unwrap()
}

#[tokio::test]
async fn entering_a_planned_shift_opens_it_and_freezes_its_snapshot() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let station = device_id(&admin, &admin.key).await;
    select_line(&admin, &admin.key, &setup.line).await;
    let (status, berth) = admin
        .call(
            "POST",
            "/v1/office/counterparties",
            Some(json!({ "name": "ООО «Северный берег»", "gln": "4601234000017", "gs1Prefixes": [] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{berth}");
    let mut body = shift_body(&setup);
    body["counterpartyId"] = berth["id"].clone();
    let shift = plan_shift(&admin, body).await;
    let id = shift["id"].as_str().unwrap().to_owned();
    let opened_at = admin.app.state.timestamp();
    let mut wake = admin.app.state.revisions.subscribe();
    let (status, entered) = enter(&admin, &admin.key, &shift).await;
    assert_eq!(status, StatusCode::OK, "{entered}");
    let snapshot = json!({
        "product": {
            "id": setup.product, "gtin14": "04600682000013", "name": "Молоко 3,2% 0,9 л",
            "printName": "Молоко 3,2%", "chzProductGroupCode": 8, "shelfLifeDays": 10
        },
        "boxTemplate": {
            "id": setup.template, "name": "Короб 58×40", "rev": 2,
            "spec": { "widthMm": 58, "heightMm": 40, "dpi": 203, "language": "zpl", "elements": [] }
        },
        "issuerPrefix": "460068200",
        "counterpartyName": "ООО «Северный берег»"
    });
    let mut expected = device_shift(&id, "OCT26-001", &setup);
    for (key, value) in [
        ("status", json!("active")),
        ("counterpartyName", json!("ООО «Северный берег»")),
        ("ownerDeviceId", json!(station)),
        ("openedAt", json!(opened_at)),
        ("snapshot", snapshot.clone()),
    ] {
        expected[key] = value;
    }
    assert_eq!(entered, expected);
    // The wizard, the template, the product, the counterparty, the plan and
    // the opening each took a revision.
    assert_eq!(host_revision(&admin.app).await, 6);
    // The opening wakes the streams with its revision, so the line's other
    // stations read the shift as busy without waiting for another write.
    assert!(wake.has_changed().unwrap());
    assert_eq!(*wake.borrow_and_update(), 6);
    assert_eq!(*admin.app.state.revisions.borrow(), 6);
    assert_eq!(
        audit_trail(&admin.app, "shift.open").await,
        vec![device_row(
            &station,
            "shift.open",
            &id,
            json!({ "number": "OCT26-001", "templateId": setup.template, "templateRev": 2 })
        )]
    );
    assert_eq!(
        participants(&admin, &shift).await,
        vec![(station.clone(), opened_at.clone(), opened_at.clone())]
    );
    let (status, office) = admin
        .call("GET", &format!("/v1/office/shifts/{id}"), None)
        .await;
    assert_eq!(
        (
            status,
            office["status"].clone(),
            office["ownerDeviceId"].clone(),
            office["openedAt"].clone(),
            office["rev"].clone()
        ),
        (
            StatusCode::OK,
            json!("active"),
            json!(station),
            json!(opened_at),
            json!(6)
        )
    );

    // The catalog, the template, the counterparty and the GLN change; the
    // shift keeps what it froze.
    let (status, product) = admin
        .call(
            "PUT",
            &format!("/v1/office/products/{}", setup.product),
            Some(json!({
                "gtin14": "04600682000013", "name": "Молоко 2,5%", "chzProductGroupCode": 8,
                "boxCapacity": 12, "palletBoxCapacity": 40, "archived": false, "expectedRev": 3
            })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{product}");
    let (status, template) = admin
        .call(
            "PUT",
            &format!("/v1/office/templates/{}", setup.template),
            Some(json!({ "spec": { "widthMm": 100 }, "expectedRev": 2 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{template}");
    let (status, org) = admin.call("GET", "/v1/office/org", None).await;
    assert_eq!(status, StatusCode::OK, "{org}");
    let (status, moved) = admin
        .call(
            "PUT",
            "/v1/office/org",
            Some(json!({
                "name": org["name"], "inn": org["inn"], "gln": "4601234000017",
                "gs1Prefixes": org["gs1Prefixes"], "timeZone": org["timeZone"],
                "expectedRev": org["rev"]
            })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{moved}");
    admin.app.clock.advance(time::Duration::minutes(5));
    let revision = host_revision(&admin.app).await;
    // The edits above woke the streams; entering again must not.
    wake.borrow_and_update();
    let rows = audit_rows(&admin.app).await;
    let (status, again) = enter(&admin, &admin.key, &shift).await;
    assert_eq!(
        (status, again["snapshot"].clone()),
        (StatusCode::OK, snapshot)
    );
    assert_eq!(again["productName"], "Молоко 3,2% 0,9 л");
    // Entering again takes no revision and writes no row; it marks the
    // entry.
    assert_eq!(host_revision(&admin.app).await, revision);
    assert!(!wake.has_changed().unwrap());
    assert_eq!(*admin.app.state.revisions.borrow(), revision);
    assert_eq!(audit_rows(&admin.app).await, rows);
    assert_eq!(
        participants(&admin, &shift).await,
        vec![(station, opened_at, admin.app.state.timestamp())]
    );
}

#[tokio::test]
async fn a_shift_takes_one_station_of_its_line_and_never_opens_once_closed() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let station = device_id(&admin, &admin.key).await;
    select_line(&admin, &admin.key, &setup.line).await;
    let (_, colleague) = pair_device(&admin.app, "station").await;
    select_line(&admin, &colleague, &setup.line).await;
    let (_, elsewhere) = pair_device(&admin.app, "station").await;
    select_line(&admin, &elsewhere, &setup.other_line).await;
    let (_, unassigned) = pair_device(&admin.app, "station").await;
    let (_, office_pc) = pair_device(&admin.app, "office").await;
    let shift = plan_shift(&admin, shift_body(&setup)).await;
    let conflict = |constraint: &str| {
        (
            StatusCode::CONFLICT,
            json!({ "code": "conflict", "constraint": constraint }),
        )
    };
    let try_enter = |key: String| {
        let admin = &admin;
        let shift = &shift;
        async move {
            let (status, body) = enter(admin, &key, shift).await;
            (
                status,
                json!({
                    "code": body["error"]["code"],
                    "constraint": body["error"]["details"]["constraint"]
                }),
            )
        }
    };
    // Another line, or none, never opens it.
    assert_eq!(try_enter(elsewhere.clone()).await, conflict("shift_line"));
    assert_eq!(try_enter(unassigned).await, conflict("shift_line"));
    let (status, refused) = enter(&admin, &office_pc, &shift).await;
    assert_eq!(
        (status, refused["error"]["code"].clone()),
        (StatusCode::FORBIDDEN, json!("forbidden"))
    );
    let (status, entered) = enter(&admin, &admin.key, &shift).await;
    assert_eq!(status, StatusCode::OK, "{entered}");
    // Once one station opened it, another of the line is refused.
    let revision = host_revision(&admin.app).await;
    let rows = audit_rows(&admin.app).await;
    assert_eq!(try_enter(colleague.clone()).await, conflict("shift_busy"));
    assert_eq!(
        participants(&admin, &shift)
            .await
            .into_iter()
            .map(|(device, _, _)| device)
            .collect::<Vec<_>>(),
        vec![station.clone()]
    );
    // A closed shift opens for nobody, its own station included.
    sqlx::query(
        "UPDATE shifts SET status = 'closed', closed_at = ?, closed_by_kind = 'device', \
         closed_by = ? WHERE id = ?",
    )
    .bind(admin.app.state.timestamp())
    .bind(&station)
    .bind(shift["id"].as_str().unwrap())
    .execute(&admin.app.state.pool)
    .await
    .unwrap();
    for key in [admin.key.clone(), colleague] {
        let (status, body) = enter(&admin, &key, &shift).await;
        assert_eq!(
            (status, body["error"]["details"].clone()),
            (
                StatusCode::CONFLICT,
                json!({ "constraint": "shift_status", "status": "closed" })
            )
        );
    }
    let (status, missing) = enter(&admin, &admin.key, &json!({ "id": "no-such-shift" })).await;
    assert_eq!(
        (status, missing["error"]["code"].clone()),
        (StatusCode::NOT_FOUND, json!("not_found"))
    );
    assert_eq!(host_revision(&admin.app).await, revision);
    assert_eq!(audit_rows(&admin.app).await, rows);
}

#[tokio::test]
async fn a_plan_that_no_longer_fits_its_product_or_template_does_not_open() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    select_line(&admin, &admin.key, &setup.line).await;
    let shift = plan_shift(&admin, shift_body(&setup)).await;
    let product_path = format!("/v1/office/products/{}", setup.product);
    let product = |archived: bool, pallet: Value, rev: i64| {
        json!({
            "gtin14": "04600682000013", "name": "Молоко 3,2% 0,9 л", "chzProductGroupCode": 8,
            "boxCapacity": 12, "palletBoxCapacity": pallet, "archived": archived,
            "expectedRev": rev
        })
    };
    let template_path = format!("/v1/office/templates/{}", setup.template);
    let refused = |constraint: &str| json!({ "constraint": constraint });
    let attempt = || async {
        let (status, body) = enter(&admin, &admin.key, &shift).await;
        (status, body["error"]["details"].clone())
    };
    // The product archived, then a draft (no pallet capacity).
    let (status, _) = admin
        .call("PUT", &product_path, Some(product(true, json!(40), 3)))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        attempt().await,
        (StatusCode::CONFLICT, refused("product_inactive"))
    );
    let (status, _) = admin
        .call("PUT", &product_path, Some(product(false, Value::Null, 5)))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        attempt().await,
        (StatusCode::CONFLICT, refused("product_inactive"))
    );
    let (status, _) = admin
        .call("PUT", &product_path, Some(product(false, json!(40), 6)))
        .await;
    assert_eq!(status, StatusCode::OK);
    // The template disabled, then narrowed to beer.
    let (status, _) = admin
        .call(
            "PUT",
            &template_path,
            Some(json!({ "enabled": false, "expectedRev": 2 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        attempt().await,
        (StatusCode::CONFLICT, refused("template_not_fit"))
    );
    let (status, _) = admin
        .call(
            "PUT",
            &template_path,
            Some(json!({ "enabled": true, "chzProductGroupCodes": [15], "expectedRev": 8 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let revision = host_revision(&admin.app).await;
    assert_eq!(
        attempt().await,
        (StatusCode::CONFLICT, refused("template_not_fit"))
    );
    // Nothing opened: the plan waits, and no revision was taken.
    let (_, office) = admin
        .call(
            "GET",
            &format!("/v1/office/shifts/{}", shift["id"].as_str().unwrap()),
            None,
        )
        .await;
    assert_eq!(
        (office["status"].clone(), office["ownerDeviceId"].clone()),
        (json!("planned"), Value::Null)
    );
    assert_eq!(host_revision(&admin.app).await, revision);
    assert!(participants(&admin, &shift).await.is_empty());
    // Widened again, it opens.
    let (status, _) = admin
        .call(
            "PUT",
            &template_path,
            Some(json!({ "chzProductGroupCodes": null, "expectedRev": 9 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let (status, entered) = enter(&admin, &admin.key, &shift).await;
    assert_eq!(
        (status, entered["status"].clone()),
        (StatusCode::OK, json!("active"))
    );
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

/// The status and `details` of an entry that is refused.
async fn refused_entry(admin: &Admin, key: &str, shift: &Value) -> (StatusCode, Value) {
    let (status, body) = enter(admin, key, shift).await;
    (status, body["error"]["details"].clone())
}

/// Archive or restore the shift's product (it is a complete, active product
/// otherwise); returns its new revision.
async fn archive_product(admin: &Admin, setup: &ShiftSetup, archived: bool, rev: i64) -> i64 {
    let (status, product) = admin
        .call(
            "PUT",
            &format!("/v1/office/products/{}", setup.product),
            Some(json!({
                "gtin14": "04600682000013", "name": "Молоко 3,2% 0,9 л",
                "printName": "Молоко 3,2%", "chzProductGroupCode": 8, "boxCapacity": 12,
                "palletBoxCapacity": 40, "shelfLifeDays": 10, "archived": archived,
                "expectedRev": rev
            })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{product}");
    product["rev"].as_i64().unwrap()
}

/// Change the shift's template with `patch` (and its `expectedRev`); returns
/// its new revision.
async fn patch_template(admin: &Admin, setup: &ShiftSetup, mut patch: Value, rev: i64) -> i64 {
    patch["expectedRev"] = json!(rev);
    let (status, template) = admin
        .call(
            "PUT",
            &format!("/v1/office/templates/{}", setup.template),
            Some(patch),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{template}");
    template["rev"].as_i64().unwrap()
}

#[tokio::test]
async fn an_entry_names_the_first_rule_it_breaks_and_the_owner_keeps_its_shift() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let station = device_id(&admin, &admin.key).await;
    select_line(&admin, &admin.key, &setup.line).await;
    let (_, colleague) = pair_device(&admin.app, "station").await;
    select_line(&admin, &colleague, &setup.line).await;
    let (_, elsewhere) = pair_device(&admin.app, "station").await;
    select_line(&admin, &elsewhere, &setup.other_line).await;
    let (_, unassigned) = pair_device(&admin.app, "station").await;
    let handheld = pair_handheld(&admin).await;
    let shift = plan_shift(&admin, shift_body(&setup)).await;
    let busy = (StatusCode::CONFLICT, json!({ "constraint": "shift_busy" }));
    let line = (StatusCode::CONFLICT, json!({ "constraint": "shift_line" }));
    let mut product_rev = archive_product(&admin, &setup, true, 3).await;
    let mut template_rev = patch_template(&admin, &setup, json!({ "enabled": false }), 2).await;
    // The line is checked before the plan; the product before the template
    // (both are broken here).
    let revision = host_revision(&admin.app).await;
    let rows = audit_rows(&admin.app).await;
    // Only a station enters, whatever its line (a handheld has none).
    let (status, refused) = enter(&admin, &handheld, &shift).await;
    assert_eq!(
        (status, refused["error"]["code"].clone()),
        (StatusCode::FORBIDDEN, json!("forbidden"))
    );
    assert_eq!(refused_entry(&admin, &elsewhere, &shift).await, line);
    assert_eq!(refused_entry(&admin, &unassigned, &shift).await, line);
    assert_eq!(
        refused_entry(&admin, &admin.key, &shift).await,
        (
            StatusCode::CONFLICT,
            json!({ "constraint": "product_inactive" })
        )
    );
    assert_eq!(host_revision(&admin.app).await, revision);
    assert_eq!(audit_rows(&admin.app).await, rows);
    product_rev = archive_product(&admin, &setup, false, product_rev).await;
    template_rev = patch_template(&admin, &setup, json!({ "enabled": true }), template_rev).await;
    let (status, entered) = enter(&admin, &admin.key, &shift).await;
    assert_eq!(status, StatusCode::OK, "{entered}");
    // The station's list does not carry the snapshot.
    let (status, listed) = device_call(&admin, &admin.key, "GET", "/v1/device/shifts", None).await;
    assert_eq!(status, StatusCode::OK, "{listed}");
    assert_eq!(listed["shifts"][0]["status"], "active");
    assert!(listed["shifts"][0].get("snapshot").is_none(), "{listed}");

    // The plan breaks now; a shift another station opened is busy before the
    // plan is looked at, the line before busy.
    archive_product(&admin, &setup, true, product_rev).await;
    patch_template(&admin, &setup, json!({ "enabled": false }), template_rev).await;
    let revision = host_revision(&admin.app).await;
    let rows = audit_rows(&admin.app).await;
    assert_eq!(refused_entry(&admin, &colleague, &shift).await, busy);
    assert_eq!(refused_entry(&admin, &elsewhere, &shift).await, line);
    assert_eq!(refused_entry(&admin, &unassigned, &shift).await, line);
    // The owner enters again and gets what it froze: a product archived or
    // a template disabled since does not take the shift from a running line.
    let (status, again) = enter(&admin, &admin.key, &shift).await;
    assert_eq!(status, StatusCode::OK, "{again}");
    assert_eq!(again, entered);
    assert_eq!(host_revision(&admin.app).await, revision);
    assert_eq!(audit_rows(&admin.app).await, rows);
    assert_eq!(
        participants(&admin, &shift)
            .await
            .into_iter()
            .map(|(device, _, _)| device)
            .collect::<Vec<_>>(),
        vec![station.clone()]
    );
    // The owner's own station moved to another line no longer enters.
    select_line(&admin, &admin.key, &setup.other_line).await;
    assert_eq!(refused_entry(&admin, &admin.key, &shift).await, line);
    // Closed, the shift opens for nobody; the status comes first, whatever
    // line the station is on.
    close_directly(&admin, &shift, &station).await;
    let closed = (
        StatusCode::CONFLICT,
        json!({ "constraint": "shift_status", "status": "closed" }),
    );
    for key in [&admin.key, &colleague, &elsewhere, &unassigned] {
        assert_eq!(refused_entry(&admin, key, &shift).await, closed);
    }
}

#[tokio::test]
async fn a_station_shift_without_a_counterparty_opens_on_a_template_that_names_its_group() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let station = device_id(&admin, &admin.key).await;
    select_line(&admin, &admin.key, &setup.line).await;
    let template_rev = patch_template(
        &admin,
        &setup,
        json!({ "chzProductGroupCodes": [15, 8] }),
        2,
    )
    .await;
    let (status, created) = device_call(
        &admin,
        &admin.key,
        "POST",
        "/v1/device/shifts",
        Some(device_create(&setup, REQUEST)),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let (status, entered) = enter(&admin, &admin.key, &created).await;
    assert_eq!(status, StatusCode::OK, "{entered}");
    assert_eq!(entered["status"], "active");
    assert_eq!(entered["createdFrom"], "station");
    assert_eq!(entered["counterpartyName"], Value::Null);
    assert_eq!(
        entered["snapshot"],
        json!({
            "product": {
                "id": setup.product, "gtin14": "04600682000013", "name": "Молоко 3,2% 0,9 л",
                "printName": "Молоко 3,2%", "chzProductGroupCode": 8, "shelfLifeDays": 10
            },
            "boxTemplate": {
                "id": setup.template, "name": "Короб 58×40", "rev": template_rev,
                "spec": { "widthMm": 58, "heightMm": 40, "dpi": 203, "language": "zpl", "elements": [] }
            },
            "issuerPrefix": "460068200",
            "counterpartyName": null
        })
    );
    // The number of a shift a station made keeps its `/S` in the audit row.
    assert_eq!(
        audit_trail(&admin.app, "shift.open").await,
        vec![device_row(
            &station,
            "shift.open",
            created["id"].as_str().unwrap(),
            json!({
                "number": "OCT26-001/S", "templateId": setup.template,
                "templateRev": template_rev
            })
        )]
    );
}

#[tokio::test]
async fn a_template_deleted_behind_the_plan_does_not_open_it() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    select_line(&admin, &admin.key, &setup.line).await;
    let shift = plan_shift(&admin, shift_body(&setup)).await;
    // The office refuses to delete a template a planned shift names
    // (`template_in_use`); a template gone anyway is a plan that no longer
    // fits, not a server error.
    sqlx::query("DELETE FROM label_templates WHERE id = ?")
        .bind(&setup.template)
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    assert_eq!(
        refused_entry(&admin, &admin.key, &shift).await,
        (
            StatusCode::CONFLICT,
            json!({ "constraint": "template_not_fit" })
        )
    );
}

#[tokio::test]
async fn a_layout_of_the_largest_size_is_frozen_whole() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    select_line(&admin, &admin.key, &setup.line).await;
    // The most a template stores (256 KB once compact).
    let spec = json!({ "f": "я".repeat((262_144 - 8) / 2) });
    assert_eq!(serde_json::to_string(&spec).unwrap().len(), 262_144);
    patch_template(&admin, &setup, json!({ "spec": spec }), 2).await;
    let shift = plan_shift(&admin, shift_body(&setup)).await;
    let (status, entered) = enter(&admin, &admin.key, &shift).await;
    assert_eq!(status, StatusCode::OK, "{}", entered["error"]);
    assert_eq!(entered["snapshot"]["boxTemplate"]["spec"], spec);
    let (status, again) = enter(&admin, &admin.key, &shift).await;
    assert_eq!((status, again), (StatusCode::OK, entered));
}

#[tokio::test]
async fn two_stations_entering_together_leave_one_owner() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    select_line(&admin, &admin.key, &setup.line).await;
    let (_, colleague) = pair_device(&admin.app, "station").await;
    select_line(&admin, &colleague, &setup.line).await;
    let shift = plan_shift(&admin, shift_body(&setup)).await;
    let (first, second) = tokio::join!(
        enter(&admin, &admin.key, &shift),
        enter(&admin, &colleague, &shift)
    );
    let mut statuses = [first.0, second.0];
    statuses.sort();
    assert_eq!(statuses, [StatusCode::OK, StatusCode::CONFLICT]);
    let loser = if first.0 == StatusCode::OK {
        second
    } else {
        first
    };
    assert_eq!(loser.1["error"]["details"]["constraint"], "shift_busy");
    assert_eq!(participants(&admin, &shift).await.len(), 1);
    assert_eq!(audit_trail(&admin.app, "shift.open").await.len(), 1);
}

/// The entry reads the shift only after it holds the write lock. A colleague's
/// entry that is still being written when this station's request arrives is
/// therefore seen, and the loser answers `shift_busy`; with a deferred
/// transaction the stale `planned` row would be read first and the write
/// would fail with a database error.
#[tokio::test]
async fn an_entry_waiting_for_the_write_lock_sees_the_entry_that_held_it() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    select_line(&admin, &admin.key, &setup.line).await;
    let (colleague, colleague_key) = pair_device(&admin.app, "station").await;
    select_line(&admin, &colleague_key, &setup.line).await;
    let shift = plan_shift(&admin, shift_body(&setup)).await;
    let id = shift["id"].as_str().unwrap().to_owned();
    // Read before the lock is taken: a request through the router writes.
    let station = device_id(&admin, &admin.key).await;

    // The colleague's entry, held open at the moment it has written.
    let mut holder = markiro_host::db::begin_write(&admin.app.state.pool)
        .await
        .unwrap();
    let at = admin.app.state.timestamp();
    sqlx::query(
        "UPDATE shifts SET status = 'active', snapshot = ?, opened_at = ?, owner_device_id = ? \
         WHERE id = ?",
    )
    .bind(snapshot("Молоко", Value::Null).to_string())
    .bind(&at)
    .bind(&colleague)
    .bind(&id)
    .execute(&mut *holder)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO shift_participants (shift_id, device_id, first_entered_at, last_entered_at) \
         VALUES (?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&colleague)
    .bind(&at)
    .bind(&at)
    .execute(&mut *holder)
    .await
    .unwrap();

    // This station's entry arrives meanwhile and has to wait for the lock.
    // The handler is called directly: the device authentication in front of
    // it writes `last_seen_at`, so through the router the request would
    // already wait there, before the handler opened its transaction.
    let mut entry = Box::pin(enter_shift(
        State(admin.app.state.clone()),
        AuthDevice {
            id: station,
            kind: DeviceKind::Station,
        },
        ApiPath(id.clone()),
    ));
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(200), &mut entry)
            .await
            .is_err(),
        "the entry answered while another writer held the lock"
    );
    holder.commit().await.unwrap();

    let refusal = entry.await.expect_err("the shift was taken meanwhile");
    let response = refusal.into_response();
    let status = response.status();
    let body: Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(
        (status, body["error"]["details"]["constraint"].clone()),
        (StatusCode::CONFLICT, json!("shift_busy")),
        "{body}"
    );
    let rows: Vec<String> =
        sqlx::query_scalar("SELECT device_id FROM shift_participants WHERE shift_id = ?")
            .bind(&id)
            .fetch_all(&admin.app.state.pool)
            .await
            .unwrap();
    assert_eq!(rows, vec![colleague]);
    assert!(audit_trail(&admin.app, "shift.open").await.is_empty());
}
