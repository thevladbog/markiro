mod support;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use http_body_util::BodyExt;
use markiro_host::auth::AuthDevice;
use markiro_host::error::{ApiError, ApiJson, ApiPath};
use markiro_host::routes::device_shifts::{create_device_shift, enter_shift};
use markiro_proto::{DeviceKind, DeviceShift, DeviceShiftCreate};
use serde_json::{json, Value};
use support::app::{
    admin, audit_rows, audit_trail, default_sheet_is, empty, host_revision, json as json_request,
    office_template, pair_device, pallet_shift_body, pallet_template, plan_shift, request,
    sheet_spec, shift_body, shift_setup, stock_sheet, with_device, Admin, AuditRow, ShiftSetup,
    LAN,
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
async fn a_station_creating_a_shift_wakes_the_streams_with_its_revision_and_a_repeat_does_not() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    select_line(&admin, &admin.key, &setup.line).await;
    let before = host_revision(&admin.app).await;
    let mut wake = admin.app.state.revisions.subscribe();
    assert!(!wake.has_changed().unwrap());
    let (status, created) = device_call(
        &admin,
        &admin.key,
        "POST",
        "/v1/device/shifts",
        Some(device_create(&setup, REQUEST)),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    // The line's other stations read the new plan on this event.
    assert!(wake.has_changed().unwrap(), "the create wakes the streams");
    assert_eq!(*wake.borrow_and_update(), before + 1);
    assert_eq!(host_revision(&admin.app).await, before + 1);
    // The same request again writes nothing and wakes nobody.
    let (status, repeated) = device_call(
        &admin,
        &admin.key,
        "POST",
        "/v1/device/shifts",
        Some(device_create(&setup, REQUEST)),
    )
    .await;
    assert_eq!((status, repeated), (StatusCode::OK, created));
    assert!(!wake.has_changed().unwrap());
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
        "counterpartyName": "ООО «Северный берег»",
        // The wizard's organization, without a logo (plan А4).
        "organization": { "name": "ООО «Атолл»", "inn": "7701234567", "logo": null }
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
    // A station's shift has no pallets: neither the record nor the row
    // carries a pallet field.
    assert_eq!(
        [
            office["palletsEnabled"].clone(),
            office["palletBoxCapacity"].clone(),
            office["palletTemplateId"].clone()
        ],
        [json!(false), Value::Null, Value::Null]
    );
    let columns: (i64, Option<i64>, Option<String>) = sqlx::query_as(
        "SELECT pallets_enabled, pallet_box_capacity, pallet_template_id FROM shifts WHERE id = ?",
    )
    .bind(created["id"].as_str().unwrap())
    .fetch_one(&admin.app.state.pool)
    .await
    .unwrap();
    assert_eq!(columns, (0, None, None));
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
            "counterpartyName": null,
            "organization": { "name": "ООО «Атолл»", "inn": "7701234567", "logo": null }
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
    // it may write `last_seen_at` (once a minute), so through the router the
    // request could already wait there, before the handler opened its
    // transaction.
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

/// A station's shift write that has passed the device authentication and now
/// waits for the write lock, with the office revoking the station in the
/// meantime: the handler is called directly (the authentication in front of it
/// may write `last_seen_at`, once a minute, so through the router the request
/// could already wait there), and the revocation is committed by the writer it
/// waits for.
async fn revoked_while_waiting<F>(admin: &Admin, station: &str, handler: F) -> (StatusCode, Value)
where
    F: std::future::Future<Output = Result<axum::Json<DeviceShift>, ApiError>>,
{
    let mut holder = markiro_host::db::begin_write(&admin.app.state.pool)
        .await
        .unwrap();
    let mut waiting = Box::pin(handler);
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(200), &mut waiting)
            .await
            .is_err(),
        "the write answered while another writer held the lock"
    );
    sqlx::query("UPDATE devices SET revoked_at = ? WHERE id = ?")
        .bind(admin.app.state.timestamp())
        .bind(station)
        .execute(&mut *holder)
        .await
        .unwrap();
    holder.commit().await.unwrap();
    let response = match waiting.await {
        Ok(shift) => shift.into_response(),
        Err(error) => error.into_response(),
    };
    let status = response.status();
    let body = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&body).unwrap())
}

#[tokio::test]
async fn a_station_revoked_while_its_write_waited_neither_enters_nor_creates_a_shift() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let shift = plan_shift(&admin, shift_body(&setup)).await;
    let id = shift["id"].as_str().unwrap().to_owned();
    let mut stations = Vec::new();
    for _ in 0..2 {
        let (station, key) = pair_device(&admin.app, "station").await;
        select_line(&admin, &key, &setup.line).await;
        stations.push(station);
    }
    let revision = host_revision(&admin.app).await;
    let rows = audit_rows(&admin.app).await;
    let counters: Vec<(String, i64)> =
        sqlx::query_as("SELECT month_key, last_seq FROM shift_number_counters")
            .fetch_all(&admin.app.state.pool)
            .await
            .unwrap();
    let enter_handler = enter_shift(
        State(admin.app.state.clone()),
        AuthDevice {
            id: stations[0].clone(),
            kind: DeviceKind::Station,
        },
        ApiPath(id.clone()),
    );
    let create: DeviceShiftCreate = serde_json::from_value(device_create(&setup, REQUEST)).unwrap();
    let create_handler = create_device_shift(
        State(admin.app.state.clone()),
        AuthDevice {
            id: stations[1].clone(),
            kind: DeviceKind::Station,
        },
        ApiJson(create),
    );
    for (what, station, answer) in [
        (
            "enter",
            &stations[0],
            revoked_while_waiting(&admin, &stations[0], enter_handler).await,
        ),
        (
            "create",
            &stations[1],
            revoked_while_waiting(&admin, &stations[1], create_handler).await,
        ),
    ] {
        let (status, body) = answer;
        assert_eq!(
            (status, body["error"]["details"]["credential"].clone()),
            (StatusCode::UNAUTHORIZED, json!("device")),
            "{what} {station}: {body}"
        );
    }
    // The plan is still free for a colleague, and nothing was written.
    let (status, office) = admin
        .call("GET", &format!("/v1/office/shifts/{id}"), None)
        .await;
    assert_eq!(
        (
            status,
            office["status"].clone(),
            office["ownerDeviceId"].clone()
        ),
        (StatusCode::OK, json!("planned"), Value::Null)
    );
    let participants: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM shift_participants")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    let shifts: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM shifts")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    assert_eq!((participants, shifts), (0, 1));
    let after: Vec<(String, i64)> =
        sqlx::query_as("SELECT month_key, last_seq FROM shift_number_counters")
            .fetch_all(&admin.app.state.pool)
            .await
            .unwrap();
    assert_eq!(after, counters);
    assert_eq!(host_revision(&admin.app).await, revision);
    assert_eq!(audit_rows(&admin.app).await, rows);
}

#[tokio::test]
async fn a_shift_the_office_closes_reads_closed_to_its_owner_and_no_station_reenters_it() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let station = device_id(&admin, &admin.key).await;
    select_line(&admin, &admin.key, &setup.line).await;
    let (_, colleague) = pair_device(&admin.app, "station").await;
    select_line(&admin, &colleague, &setup.line).await;
    let shift = plan_shift(&admin, shift_body(&setup)).await;
    let id = shift["id"].as_str().unwrap().to_owned();
    // The station of the line enters, so the shift is open and its own.
    let (status, entered) = enter(&admin, &admin.key, &shift).await;
    assert_eq!(status, StatusCode::OK, "{entered}");
    assert_eq!(entered["status"], json!("active"));
    let opened_at = entered["openedAt"].as_str().unwrap().to_owned();
    let read = |key: String| {
        let admin = &admin;
        let id = id.clone();
        async move {
            let (status, body) = device_call(admin, &key, "GET", "/v1/device/shifts", None).await;
            assert_eq!(status, StatusCode::OK, "{body}");
            body["shifts"]
                .as_array()
                .unwrap()
                .iter()
                .find(|shift| shift["id"] == json!(id))
                .cloned()
        }
    };
    let before = read(admin.key.clone())
        .await
        .expect("the open shift is listed");
    assert_eq!(
        (&before["status"], &before["closedAt"]),
        (&json!("active"), &Value::Null)
    );
    // The office closes it, later than the entry.
    admin.app.clock.advance(time::Duration::minutes(5));
    let closed_instant = admin.app.state.timestamp();
    assert_ne!(closed_instant, opened_at);
    let path = format!("/v1/office/shifts/{id}");
    let (status, office) = admin.call("GET", &path, None).await;
    assert_eq!(status, StatusCode::OK, "{office}");
    let (status, closed) = admin
        .call(
            "POST",
            &format!("{path}/close"),
            Some(json!({ "reason": "Сбой питания", "expectedRev": office["rev"] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{closed}");
    assert_eq!(closed["status"], json!("closed"));
    // The owner's list still has the shift, now closed and stamped with the
    // instant of the close; nothing else of it changed.
    let after = read(admin.key.clone())
        .await
        .expect("the owner still lists the closed shift");
    assert_eq!(after["status"], json!("closed"));
    assert_eq!(after["closedAt"], json!(closed_instant));
    assert_eq!(after["openedAt"], json!(opened_at));
    assert_eq!(after["ownerDeviceId"], json!(station));
    assert_eq!(after["number"], before["number"]);
    // A closed shift a station never entered is no longer on its line's list.
    assert_eq!(read(colleague.clone()).await, None);
    // Nobody enters it again, the owner included.
    for key in [admin.key.clone(), colleague] {
        let (status, body) = enter(&admin, &key, &shift).await;
        assert_eq!(
            (
                status,
                body["error"]["code"].clone(),
                body["error"]["details"].clone()
            ),
            (
                StatusCode::CONFLICT,
                json!("conflict"),
                json!({ "constraint": "shift_status", "status": "closed" })
            ),
            "{body}"
        );
    }
}

/// A station creates a shift with pallets under the office's rules and
/// enters it: the snapshot freezes the pallet template with its layout,
/// the opening's audit row names it, and the station's list names the
/// pallet capacity and template only for a shift with pallets.
#[tokio::test]
async fn a_station_creates_a_shift_with_pallets_and_its_entry_freezes_the_pallet_template() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let station = device_id(&admin, &admin.key).await;
    select_line(&admin, &admin.key, &setup.line).await;
    let pallet = pallet_template(&admin).await;
    let mut create = device_create(&setup, REQUEST);
    create["palletsEnabled"] = json!(true);
    create["palletTemplateId"] = json!(pallet);
    let (status, created) = device_call(
        &admin,
        &admin.key,
        "POST",
        "/v1/device/shifts",
        Some(create),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let id = created["id"].as_str().unwrap().to_owned();
    let mut expected = device_shift(&id, "OCT26-001/S", &setup);
    expected["createdFrom"] = json!("station");
    expected["productionDate"] = json!("2026-10-09");
    expected["palletsEnabled"] = json!(true);
    expected["palletBoxCapacity"] = json!(40);
    expected["palletTemplateId"] = json!(pallet);
    assert_eq!(created, expected);
    let plain = plan_shift(&admin, shift_body(&setup)).await;
    let opened_at = admin.app.state.timestamp();
    let (status, entered) = enter(&admin, &admin.key, &created).await;
    assert_eq!(status, StatusCode::OK, "{entered}");
    // The wizard, the box template and the product took revisions 1 to 3,
    // the pallet template 4.
    let pallet_snapshot = json!({
        "id": pallet, "name": "Паллета 100×150", "rev": 4,
        "spec": { "widthMm": 100, "heightMm": 150, "dpi": 203, "language": "zpl", "elements": [] }
    });
    assert_eq!(entered["snapshot"]["palletTemplate"], pallet_snapshot);
    assert_eq!(entered["palletBoxCapacity"], json!(40));
    assert_eq!(
        audit_trail(&admin.app, "shift.open").await,
        vec![device_row(
            &station,
            "shift.open",
            &id,
            json!({
                "number": "OCT26-001/S", "templateId": setup.template, "templateRev": 2,
                "palletTemplateId": pallet, "palletTemplateRev": 4
            })
        )]
    );
    assert_eq!(entered["openedAt"], json!(opened_at));
    // The list names the pallet fields of the shift with pallets only.
    let (status, list) = device_call(&admin, &admin.key, "GET", "/v1/device/shifts", None).await;
    assert_eq!(status, StatusCode::OK, "{list}");
    let shifts = list["shifts"].as_array().unwrap();
    let listed = |id: &Value| {
        shifts
            .iter()
            .find(|shift| shift["id"] == *id)
            .cloned()
            .unwrap()
    };
    let mut with_pallets = entered.clone();
    with_pallets.as_object_mut().unwrap().remove("snapshot");
    assert_eq!(listed(&created["id"]), with_pallets);
    let plain_listed = listed(&plain["id"]);
    for key in ["palletBoxCapacity", "palletTemplateId"] {
        assert!(
            !plain_listed.as_object().unwrap().contains_key(key),
            "{key}"
        );
    }
    // The pallet template changes; the shift keeps the layout it froze.
    let (status, changed) = admin
        .call(
            "PUT",
            &format!("/v1/office/templates/{pallet}"),
            Some(json!({ "spec": { "widthMm": 120 }, "expectedRev": 4 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{changed}");
    let (status, again) = enter(&admin, &admin.key, &created).await;
    assert_eq!(
        (status, again["snapshot"]["palletTemplate"].clone()),
        (StatusCode::OK, pallet_snapshot)
    );
    // A shift without pallets freezes no pallet template.
    let (status, plain_entered) = enter(&admin, &admin.key, &plain).await;
    assert_eq!(status, StatusCode::OK, "{plain_entered}");
    assert!(!plain_entered["snapshot"]
        .as_object()
        .unwrap()
        .contains_key("palletTemplate"));
}

/// A station's create follows the office's pallet rules: a template that
/// fits, and no pallet field without pallets. A refusal writes nothing.
#[tokio::test]
async fn a_station_create_follows_the_pallet_rules() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    select_line(&admin, &admin.key, &setup.line).await;
    let pallet = pallet_template(&admin).await;
    let disabled = office_template(&admin, "pallet", false, Value::Null).await;
    let rows = audit_rows(&admin.app).await;
    let revision = host_revision(&admin.app).await;
    let field = |name: &str| (json!("validation_failed"), json!({ "field": name }));
    for (change, expected) in [
        (json!({ "palletsEnabled": true }), field("palletTemplateId")),
        (
            json!({ "palletsEnabled": true, "palletTemplateId": setup.template }),
            field("palletTemplateId"),
        ),
        (
            json!({ "palletsEnabled": true, "palletTemplateId": disabled }),
            field("palletTemplateId"),
        ),
        (
            json!({ "palletsEnabled": true, "palletTemplateId": pallet, "palletBoxCapacity": 0 }),
            field("palletBoxCapacity"),
        ),
        (
            json!({ "palletBoxCapacity": 40 }),
            field("palletBoxCapacity"),
        ),
        (
            json!({ "palletTemplateId": pallet }),
            field("palletTemplateId"),
        ),
    ] {
        let mut body = device_create(&setup, REQUEST);
        for (key, value) in change.as_object().unwrap() {
            body[key] = value.clone();
        }
        let (status, refused) =
            device_call(&admin, &admin.key, "POST", "/v1/device/shifts", Some(body)).await;
        assert_eq!(
            (
                status,
                (
                    refused["error"]["code"].clone(),
                    refused["error"]["details"].clone()
                )
            ),
            (StatusCode::BAD_REQUEST, expected),
            "{change}"
        );
    }
    assert_eq!(audit_rows(&admin.app).await, rows);
    assert_eq!(host_revision(&admin.app).await, revision);
}

/// A pallet template disabled or narrowed after the plan keeps the shift
/// from opening (`pallet_template_not_fit`): nothing is frozen or written,
/// and once it fits again the shift opens.
#[tokio::test]
async fn a_pallet_template_that_no_longer_fits_keeps_the_shift_planned() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    select_line(&admin, &admin.key, &setup.line).await;
    let pallet = pallet_template(&admin).await;
    let shift = plan_shift(&admin, pallet_shift_body(&setup, &pallet)).await;
    let template = format!("/v1/office/templates/{pallet}");
    for change in [
        json!({ "enabled": false }),
        json!({ "chzProductGroupCodes": [15] }),
    ] {
        let (_, current) = admin.call("GET", &template, None).await;
        let mut body = change.clone();
        body["expectedRev"] = current["rev"].clone();
        let (status, narrowed) = admin.call("PUT", &template, Some(body)).await;
        assert_eq!(status, StatusCode::OK, "{narrowed}");
        let rows = audit_rows(&admin.app).await;
        let revision = host_revision(&admin.app).await;
        let (status, refused) = enter(&admin, &admin.key, &shift).await;
        assert_eq!(
            (status, refused["error"]["details"].clone()),
            (
                StatusCode::CONFLICT,
                json!({ "constraint": "pallet_template_not_fit" })
            ),
            "{change}"
        );
        assert_eq!(audit_rows(&admin.app).await, rows);
        assert_eq!(host_revision(&admin.app).await, revision);
        let (_, office) = admin
            .call(
                "GET",
                &format!("/v1/office/shifts/{}", shift["id"].as_str().unwrap()),
                None,
            )
            .await;
        assert_eq!(office["status"], json!("planned"), "{change}");
        // Fit again for the next case.
        let (_, current) = admin.call("GET", &template, None).await;
        let (status, back) = admin
            .call(
                "PUT",
                &template,
                Some(json!({
                    "enabled": true, "chzProductGroupCodes": null,
                    "expectedRev": current["rev"]
                })),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{back}");
    }
    let (status, entered) = enter(&admin, &admin.key, &shift).await;
    assert_eq!(
        (status, entered["snapshot"]["palletTemplate"]["id"].clone()),
        (StatusCode::OK, json!(pallet))
    );
}

/// Change the template `id` with `patch`, whatever revision it is at.
async fn patch_template_by_id(admin: &Admin, id: &str, mut patch: Value) {
    let path = format!("/v1/office/templates/{id}");
    let (_, current) = admin.call("GET", &path, None).await;
    patch["expectedRev"] = current["rev"].clone();
    let (status, changed) = admin.call("PUT", &path, Some(patch)).await;
    assert_eq!(status, StatusCode::OK, "{changed}");
}

/// The snapshot text a shift stores, as the table keeps it.
async fn stored_snapshot(admin: &Admin, shift: &Value) -> Option<String> {
    sqlx::query_scalar("SELECT snapshot FROM shifts WHERE id = ?")
        .bind(shift["id"].as_str().unwrap())
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap()
}

/// A refused entry, which must have written nothing: the revision, the audit
/// rows and the stored snapshot are as they were.
async fn refused_untouched(admin: &Admin, key: &str, shift: &Value) -> (StatusCode, Value) {
    let revision = host_revision(&admin.app).await;
    let rows = audit_rows(&admin.app).await;
    let stored = stored_snapshot(admin, shift).await;
    let refused = refused_entry(admin, key, shift).await;
    assert_eq!(host_revision(&admin.app).await, revision);
    assert_eq!(audit_rows(&admin.app).await, rows);
    assert_eq!(stored_snapshot(admin, shift).await, stored);
    refused
}

/// An entry with pallets names the first rule it breaks: the product, the box
/// template, then the pallet template, and the station's own rules (status,
/// line, owner) before any of them. A refusal writes nothing. The owner who
/// has the shift open enters again with the pallet template it froze, whatever
/// became of the template since, and the stored snapshot is not touched.
#[tokio::test]
async fn an_entry_with_pallets_names_the_first_rule_it_breaks_and_the_frozen_pallet_template_stays()
{
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let station = device_id(&admin, &admin.key).await;
    select_line(&admin, &admin.key, &setup.line).await;
    let (_, colleague) = pair_device(&admin.app, "station").await;
    select_line(&admin, &colleague, &setup.line).await;
    let (_, elsewhere) = pair_device(&admin.app, "station").await;
    select_line(&admin, &elsewhere, &setup.other_line).await;
    let pallet = pallet_template(&admin).await;
    let shift = plan_shift(&admin, pallet_shift_body(&setup, &pallet)).await;
    // A colleague of the line reads the pallet fields of the planned shift.
    let (status, listed) = device_call(&admin, &colleague, "GET", "/v1/device/shifts", None).await;
    assert_eq!(status, StatusCode::OK, "{listed}");
    assert_eq!(
        (
            listed["shifts"][0]["palletsEnabled"].clone(),
            listed["shifts"][0]["palletBoxCapacity"].clone(),
            listed["shifts"][0]["palletTemplateId"].clone()
        ),
        (json!(true), json!(40), json!(pallet))
    );
    // Everything is broken at once.
    let product_rev = archive_product(&admin, &setup, true, 3).await;
    patch_template_by_id(&admin, &setup.template, json!({ "enabled": false })).await;
    patch_template_by_id(&admin, &pallet, json!({ "enabled": false })).await;
    let line = (StatusCode::CONFLICT, json!({ "constraint": "shift_line" }));
    let refused = |constraint: &str| (StatusCode::CONFLICT, json!({ "constraint": constraint }));
    assert_eq!(refused_untouched(&admin, &elsewhere, &shift).await, line);
    assert_eq!(
        refused_untouched(&admin, &admin.key, &shift).await,
        refused("product_inactive")
    );
    archive_product(&admin, &setup, false, product_rev).await;
    assert_eq!(
        refused_untouched(&admin, &admin.key, &shift).await,
        refused("template_not_fit")
    );
    patch_template_by_id(&admin, &setup.template, json!({ "enabled": true })).await;
    assert_eq!(
        refused_untouched(&admin, &admin.key, &shift).await,
        refused("pallet_template_not_fit")
    );
    assert_eq!(refused_untouched(&admin, &elsewhere, &shift).await, line);
    assert_eq!(stored_snapshot(&admin, &shift).await, None);
    patch_template_by_id(&admin, &pallet, json!({ "enabled": true })).await;
    let (status, entered) = enter(&admin, &admin.key, &shift).await;
    assert_eq!(status, StatusCode::OK, "{entered}");
    assert_eq!(entered["snapshot"]["palletTemplate"]["id"], json!(pallet));
    let frozen = stored_snapshot(&admin, &shift).await.expect("frozen");
    // The pallet template is disabled, narrowed away, then gone. The shift is
    // open, so a colleague finds it busy and `elsewhere` off the line, before
    // the pallet template is looked at, and the owner enters again with what
    // it froze: no revision, no row, the same stored snapshot.
    for step in 0..3 {
        match step {
            0 => patch_template_by_id(&admin, &pallet, json!({ "enabled": false })).await,
            1 => {
                patch_template_by_id(
                    &admin,
                    &pallet,
                    json!({ "enabled": true, "chzProductGroupCodes": [15] }),
                )
                .await
            }
            _ => {
                sqlx::query("DELETE FROM label_templates WHERE id = ?")
                    .bind(&pallet)
                    .execute(&admin.app.state.pool)
                    .await
                    .unwrap();
            }
        }
        let revision = host_revision(&admin.app).await;
        let rows = audit_rows(&admin.app).await;
        assert_eq!(
            refused_entry(&admin, &colleague, &shift).await,
            refused("shift_busy"),
            "step {step}"
        );
        assert_eq!(
            refused_entry(&admin, &elsewhere, &shift).await,
            line,
            "step {step}"
        );
        let (status, back) = enter(&admin, &admin.key, &shift).await;
        assert_eq!((status, &back), (StatusCode::OK, &entered), "step {step}");
        assert_eq!(stored_snapshot(&admin, &shift).await, Some(frozen.clone()));
        assert_eq!(host_revision(&admin.app).await, revision, "step {step}");
        assert_eq!(audit_rows(&admin.app).await, rows, "step {step}");
    }
    assert_eq!(
        participants(&admin, &shift)
            .await
            .into_iter()
            .map(|(device, _, _)| device)
            .collect::<Vec<_>>(),
        vec![station.clone()]
    );
    // Closed, the shift opens for nobody, the status before the pallet
    // template (which is gone).
    close_directly(&admin, &shift, &station).await;
    for key in [&admin.key, &colleague, &elsewhere] {
        assert_eq!(
            refused_entry(&admin, key, &shift).await,
            (
                StatusCode::CONFLICT,
                json!({ "constraint": "shift_status", "status": "closed" })
            )
        );
    }
}

/// A pallet template scoped to the groups of the product fits it at the
/// entry, whether it names the product's group alone or among others, and
/// stops fitting when it is narrowed to groups without it; a template
/// deleted behind the plan keeps the shift planned, not a server error.
#[tokio::test]
async fn a_pallet_template_scoped_to_the_products_group_opens_the_shift() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    select_line(&admin, &admin.key, &setup.line).await;
    let not_fit = (
        StatusCode::CONFLICT,
        json!({ "constraint": "pallet_template_not_fit" }),
    );
    for (codes, narrowed) in [(json!([8]), json!([15])), (json!([15, 8]), json!([15, 16]))] {
        let pallet = office_template(&admin, "pallet", true, codes).await;
        let shift = plan_shift(&admin, pallet_shift_body(&setup, &pallet)).await;
        patch_template_by_id(&admin, &pallet, json!({ "chzProductGroupCodes": narrowed })).await;
        assert_eq!(
            refused_untouched(&admin, &admin.key, &shift).await,
            not_fit,
            "{narrowed}"
        );
        patch_template_by_id(&admin, &pallet, json!({ "chzProductGroupCodes": [8, 15] })).await;
        let (status, entered) = enter(&admin, &admin.key, &shift).await;
        assert_eq!(status, StatusCode::OK, "{entered}");
        assert_eq!(entered["snapshot"]["palletTemplate"]["id"], json!(pallet));
        // One station, one open shift at a time: close this one.
        let station = device_id(&admin, &admin.key).await;
        close_directly(&admin, &shift, &station).await;
    }
    let pallet = pallet_template(&admin).await;
    let shift = plan_shift(&admin, pallet_shift_body(&setup, &pallet)).await;
    sqlx::query("DELETE FROM label_templates WHERE id = ?")
        .bind(&pallet)
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    assert_eq!(refused_untouched(&admin, &admin.key, &shift).await, not_fit);
}

/// A station's create with pallets keeps what it names, writes the same audit
/// row as a create without them, and repeated with the same `requestId`
/// answers the shift it made whatever the pallet fields say now. The capacity
/// takes 1 to 10 000; a station without a line cannot plan pallets either.
#[tokio::test]
async fn a_station_create_with_pallets_keeps_what_it_names_and_repeats_as_the_same_shift() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let station = device_id(&admin, &admin.key).await;
    let (_, unassigned) = pair_device(&admin.app, "station").await;
    let pallet = pallet_template(&admin).await;
    let with_pallets = |request: &str, capacity: Value| {
        let mut body = device_create(&setup, request);
        body["palletsEnabled"] = json!(true);
        body["palletTemplateId"] = json!(pallet);
        if !capacity.is_null() {
            body["palletBoxCapacity"] = capacity;
        }
        body
    };
    // No line: nothing is planned, pallets or not.
    let revision = host_revision(&admin.app).await;
    let rows = audit_rows(&admin.app).await;
    let (status, refused) = device_call(
        &admin,
        &unassigned,
        "POST",
        "/v1/device/shifts",
        Some(with_pallets(REQUEST, json!(25))),
    )
    .await;
    assert_eq!(
        (status, refused["error"]["details"].clone()),
        (StatusCode::CONFLICT, json!({ "constraint": "shift_line" }))
    );
    assert_eq!(audit_rows(&admin.app).await, rows);
    assert_eq!(host_revision(&admin.app).await, revision);
    select_line(&admin, &admin.key, &setup.line).await;
    let revision = host_revision(&admin.app).await;
    let rows = audit_rows(&admin.app).await;
    // The edges of the capacity.
    let mut wake = admin.app.state.revisions.subscribe();
    wake.borrow_and_update();
    let (status, refused) = device_call(
        &admin,
        &admin.key,
        "POST",
        "/v1/device/shifts",
        Some(with_pallets(SECOND_REQUEST, json!(10_001))),
    )
    .await;
    assert_eq!(
        (status, refused["error"]["details"].clone()),
        (
            StatusCode::BAD_REQUEST,
            json!({ "field": "palletBoxCapacity" })
        )
    );
    assert_eq!(audit_rows(&admin.app).await, rows);
    assert_eq!(host_revision(&admin.app).await, revision);
    assert!(!wake.has_changed().unwrap());
    let (status, largest) = device_call(
        &admin,
        &admin.key,
        "POST",
        "/v1/device/shifts",
        Some(with_pallets(SECOND_REQUEST, json!(10_000))),
    )
    .await;
    assert_eq!(
        (status, largest["palletBoxCapacity"].clone()),
        (StatusCode::OK, json!(10_000)),
        "{largest}"
    );
    // The capacity the station names is the shift's, not the product's 40.
    let (status, created) = device_call(
        &admin,
        &admin.key,
        "POST",
        "/v1/device/shifts",
        Some(with_pallets(REQUEST, json!(25))),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let id = created["id"].as_str().unwrap().to_owned();
    assert_eq!(
        (
            created["palletsEnabled"].clone(),
            created["palletBoxCapacity"].clone(),
            created["palletTemplateId"].clone()
        ),
        (json!(true), json!(25), json!(pallet))
    );
    let columns: (i64, Option<i64>, Option<String>) = sqlx::query_as(
        "SELECT pallets_enabled, pallet_box_capacity, pallet_template_id FROM shifts WHERE id = ?",
    )
    .bind(&id)
    .fetch_one(&admin.app.state.pool)
    .await
    .unwrap();
    assert_eq!(columns, (1, Some(25), Some(pallet.clone())));
    // The audit row is the one a create without pallets writes.
    let trail = audit_trail(&admin.app, "shift.create").await;
    assert_eq!(
        trail.last().unwrap(),
        &device_row(
            &station,
            "shift.create",
            &id,
            json!({
                "number": "OCT26-002/S", "productId": setup.product, "lineId": setup.line,
                "productionDate": "2026-10-09"
            })
        )
    );
    // The same request again: the same shift, whatever the pallet fields say
    // now, with nothing written; the capacity is the first one's.
    let revision = host_revision(&admin.app).await;
    let rows = audit_rows(&admin.app).await;
    let shifts: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM shifts")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    wake.borrow_and_update();
    for body in [
        with_pallets(REQUEST, json!(7)),
        device_create(&setup, REQUEST),
    ] {
        let (status, repeated) =
            device_call(&admin, &admin.key, "POST", "/v1/device/shifts", Some(body)).await;
        assert_eq!((status, repeated), (StatusCode::OK, created.clone()));
    }
    assert_eq!(host_revision(&admin.app).await, revision);
    assert_eq!(audit_rows(&admin.app).await, rows);
    assert!(!wake.has_changed().unwrap());
    let after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM shifts")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    assert_eq!(after, shifts);
}

/// `proto/fixtures/error-snapshot-too-large.json`, which the webview's
/// `test/protocol.test.ts` reads too.
fn snapshot_too_large_fixture() -> Value {
    let path = format!(
        "{}/../proto/fixtures/error-snapshot-too-large.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let text =
        std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("read {path}: {error}"));
    serde_json::from_str(&text).unwrap()
}

/// A template of `purpose` for every group whose layout carries `filler`
/// bytes of text in one element, a layout the host keeps up to 256 KB.
async fn heavy_template(admin: &Admin, purpose: &str, filler: usize) -> String {
    let (status, template) = admin
        .call(
            "POST",
            "/v1/office/templates",
            Some(json!({
                "name": "Макет с запасом", "purpose": purpose, "enabled": true,
                "spec": {
                    "widthMm": 100, "heightMm": 150, "dpi": 203, "language": "zpl",
                    "elements": [{ "kind": "text", "value": "x".repeat(filler) }]
                }
            })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{}", template["error"]);
    template["id"].as_str().unwrap().to_owned()
}

/// The size of the stored snapshot as the table's `CHECK` measures it.
async fn stored_snapshot_bytes(admin: &Admin, shift: &Value) -> Option<i64> {
    sqlx::query_scalar("SELECT length(CAST(snapshot AS BLOB)) FROM shifts WHERE id = ?")
        .bind(shift["id"].as_str().unwrap())
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap()
}

/// What is stored of a planned shift that nobody entered: its status, owner
/// and opening time, and its participants.
async fn unopened(admin: &Admin, shift: &Value) -> (String, Option<String>, Option<String>, usize) {
    let (status, owner, opened_at): (String, Option<String>, Option<String>) =
        sqlx::query_as("SELECT status, owner_device_id, opened_at FROM shifts WHERE id = ?")
            .bind(shift["id"].as_str().unwrap())
            .fetch_one(&admin.app.state.pool)
            .await
            .unwrap();
    (
        status,
        owner,
        opened_at,
        participants(admin, shift).await.len(),
    )
}

/// A box layout and a pallet layout that are each within the template bound
/// (256 KB) but together exceed the 320 KB the snapshot column keeps are no
/// 500: the entry is a `conflict` on `snapshot_too_large`, the answer of
/// `proto/fixtures/error-snapshot-too-large.json`, and writes nothing. The
/// size is checked after the templates, and once the office points the shift
/// at a small pallet template it opens.
#[tokio::test]
async fn two_layouts_too_large_together_keep_the_shift_planned() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    select_line(&admin, &admin.key, &setup.line).await;
    let box_template = heavy_template(&admin, "box", 170_000).await;
    let pallet = heavy_template(&admin, "pallet", 170_000).await;
    let mut body = pallet_shift_body(&setup, &pallet);
    body["boxTemplateId"] = json!(box_template);
    let shift = plan_shift(&admin, body).await;
    let revision = host_revision(&admin.app).await;
    let rows = audit_rows(&admin.app).await;
    let (status, refused) = enter(&admin, &admin.key, &shift).await;
    assert_eq!(
        (status, &refused),
        (StatusCode::CONFLICT, &snapshot_too_large_fixture()),
        "{}",
        refused["error"]
    );
    assert_eq!(host_revision(&admin.app).await, revision);
    assert_eq!(audit_rows(&admin.app).await, rows);
    assert!(audit_trail(&admin.app, "shift.open").await.is_empty());
    assert_eq!(stored_snapshot_bytes(&admin, &shift).await, None);
    assert_eq!(
        unopened(&admin, &shift).await,
        ("planned".to_owned(), None, None, 0)
    );
    // The pallet template is looked at before the size: one that no longer
    // fits is named first, whatever its layout.
    patch_template_by_id(&admin, &pallet, json!({ "enabled": false })).await;
    assert_eq!(
        refused_untouched(&admin, &admin.key, &shift).await,
        (
            StatusCode::CONFLICT,
            json!({ "constraint": "pallet_template_not_fit" })
        )
    );
    // A small pallet template brings the snapshot under the bound.
    let small = pallet_template(&admin).await;
    let (status, pointed) = admin
        .call(
            "PUT",
            &format!("/v1/office/shifts/{}", shift["id"].as_str().unwrap()),
            Some(json!({ "palletTemplateId": small, "expectedRev": shift["rev"] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{pointed}");
    let (status, entered) = enter(&admin, &admin.key, &shift).await;
    assert_eq!(status, StatusCode::OK, "{}", entered["error"]);
    assert_eq!(entered["snapshot"]["palletTemplate"]["id"], json!(small));
    assert_eq!(
        entered["snapshot"]["boxTemplate"]["id"],
        json!(box_template)
    );
    assert!(stored_snapshot_bytes(&admin, &shift).await.unwrap() < 327_680);
    assert_eq!(
        unopened(&admin, &shift).await.0,
        "active",
        "the entry opened the shift"
    );
}

/// The entry of a pallet shift whose box layout is `box_filler` bytes of
/// text and whose pallet layout is `pallet_filler`, on a host of its own:
/// the answer's status and the size of the stored snapshot. Every host is
/// made the same way, so the sizes differ by the fillers alone.
async fn entry_with_layouts(box_filler: usize, pallet_filler: usize) -> (StatusCode, Option<i64>) {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    select_line(&admin, &admin.key, &setup.line).await;
    let box_template = heavy_template(&admin, "box", box_filler).await;
    let pallet = heavy_template(&admin, "pallet", pallet_filler).await;
    let mut body = pallet_shift_body(&setup, &pallet);
    body["boxTemplateId"] = json!(box_template);
    let shift = plan_shift(&admin, body).await;
    let (status, _) = enter(&admin, &admin.key, &shift).await;
    (status, stored_snapshot_bytes(&admin, &shift).await)
}

/// The limit is the table's `CHECK`, 327 680 bytes of snapshot text: one that
/// size opens the shift, one byte more is the clean refusal.
#[tokio::test]
async fn a_snapshot_of_exactly_the_limit_opens_the_shift_and_one_byte_more_does_not() {
    const LIMIT: usize = 327_680;
    let (status, measured) = entry_with_layouts(100_000, 100_000).await;
    assert_eq!(status, StatusCode::OK);
    let measured = usize::try_from(measured.expect("stored")).unwrap();
    let room = LIMIT - measured;
    assert_eq!(
        entry_with_layouts(100_000, 100_000 + room).await,
        (StatusCode::OK, Some(i64::try_from(LIMIT).unwrap()))
    );
    assert_eq!(
        entry_with_layouts(100_000, 100_000 + room + 1).await,
        (StatusCode::CONFLICT, None)
    );
}

// The A4 sheet and the organization in a shift's snapshot (plan А4, task 4).

const LOGO: &str = "8MAPQA==";

async fn set_logo(admin: &Admin) {
    let (status, body) = admin
        .call(
            "PUT",
            "/v1/office/org/logo",
            Some(json!({ "width": 10, "height": 2, "pixelsBase64": LOGO })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
}

/// A station on the first line and a shift with pallets planned on it,
/// naming `sheet` (the default when `None`), not yet entered.
async fn planned_with_sheet(
    admin: &Admin,
    setup: &ShiftSetup,
    sheet: Option<&str>,
) -> (String, Value) {
    let station = device_id(admin, &admin.key).await;
    select_line(admin, &admin.key, &setup.line).await;
    let template = pallet_template(admin).await;
    let mut body = pallet_shift_body(setup, &template);
    if let Some(sheet) = sheet {
        body["palletSheetTemplateId"] = json!(sheet);
    }
    (station, plan_shift(admin, body).await)
}

#[tokio::test]
async fn the_entry_freezes_the_sheet_and_the_organization_with_its_logo() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    set_logo(&admin).await;
    let sheet = stock_sheet(&admin, "pallet-a4-portrait").await;
    default_sheet_is(&admin, &sheet).await;
    let (station, shift) = planned_with_sheet(&admin, &setup, None).await;
    let id = shift["id"].as_str().unwrap().to_owned();
    assert_eq!(shift["palletSheetTemplateId"], json!(sheet));
    let (status, entered) = enter(&admin, &admin.key, &shift).await;
    assert_eq!(status, StatusCode::OK, "{entered}");
    let snapshot = entered["snapshot"].clone();
    assert_eq!(
        snapshot["palletSheet"],
        json!({
            "id": sheet, "name": "pallet-a4-portrait", "revision": 1,
            "spec": sheet_spec("pallet-a4-portrait")
        })
    );
    assert_eq!(
        snapshot["organization"],
        json!({
            "name": "ООО «Атолл»", "inn": "7701234567",
            "logo": { "width": 10, "height": 2, "pixelsBase64": LOGO }
        })
    );
    // The opening's audit row names the sheet and its revision, not its layout.
    assert_eq!(
        audit_trail(&admin.app, "shift.open").await,
        vec![device_row(
            &station,
            "shift.open",
            &id,
            json!({
                "number": "OCT26-001", "templateId": setup.template, "templateRev": 2,
                "palletTemplateId": snapshot["palletTemplate"]["id"],
                "palletTemplateRev": snapshot["palletTemplate"]["rev"],
                "palletSheetTemplateId": sheet, "palletSheetRevision": 1
            })
        )]
    );
    // The first answer and the owner's re-entry carry the same snapshot.
    let (_, again) = enter(&admin, &admin.key, &shift).await;
    assert_eq!(again["snapshot"], snapshot);
    let stored: String = sqlx::query_scalar("SELECT snapshot FROM shifts WHERE id = ?")
        .bind(&id)
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    assert_eq!(serde_json::from_str::<Value>(&stored).unwrap(), snapshot);
}

/// A later change of the sheet, the organization or the logo never reaches
/// a shift that is open: its snapshot owns them.
#[tokio::test]
async fn a_later_change_of_the_sheet_the_organization_or_the_logo_leaves_an_open_shift_alone() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    set_logo(&admin).await;
    let sheet = stock_sheet(&admin, "pallet-a4-portrait").await;
    let (_, shift) = planned_with_sheet(&admin, &setup, Some(&sheet)).await;
    let (status, entered) = enter(&admin, &admin.key, &shift).await;
    assert_eq!(status, StatusCode::OK, "{entered}");
    let snapshot = entered["snapshot"].clone();
    // Rename, disable (each takes a revision of the sheet).
    let url = format!("/v1/office/pallet-sheets/{sheet}");
    let (status, renamed) = admin
        .call(
            "PUT",
            &url,
            Some(json!({ "name": "Другое имя", "expectedRevision": 1 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{renamed}");
    let (status, off) = admin
        .call(
            "PUT",
            &url,
            Some(json!({ "enabled": false, "expectedRevision": 2 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{off}");
    assert_eq!(off["revision"], 3);
    let (_, again) = enter(&admin, &admin.key, &shift).await;
    assert_eq!(
        again["snapshot"], snapshot,
        "after a rename and a switch off"
    );
    // The layout in the table changes under it (the host's update takes no
    // layout; a restore or a later version might).
    sqlx::query("UPDATE pallet_sheet_templates SET spec = ? WHERE id = ?")
        .bind(sheet_spec("other").to_string())
        .bind(&sheet)
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    // The organization is renamed and its logo replaced, then cleared.
    let (_, org) = admin.call("GET", "/v1/office/org", None).await;
    let (status, moved) = admin
        .call(
            "PUT",
            "/v1/office/org",
            Some(json!({
                "name": "ООО «Новое имя»", "inn": "7707083893", "gln": org["gln"],
                "gs1Prefixes": org["gs1Prefixes"], "timeZone": org["timeZone"],
                "expectedRev": org["rev"]
            })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{moved}");
    let (status, logo) = admin
        .call(
            "PUT",
            "/v1/office/org/logo",
            Some(json!({ "width": 8, "height": 1, "pixelsBase64": "/w==" })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{logo}");
    let (_, again) = enter(&admin, &admin.key, &shift).await;
    assert_eq!(
        again["snapshot"], snapshot,
        "after the table, the organization and the logo"
    );
    let (status, cleared) = admin.call("DELETE", "/v1/office/org/logo", None).await;
    assert_eq!(
        (status, cleared["logo"].clone()),
        (StatusCode::OK, Value::Null)
    );
    // The sheet is deleted: an open shift does not block it.
    let (status, gone) = admin.call("DELETE", &url, None).await;
    assert!(status.is_success(), "{gone}");
    let (_, again) = enter(&admin, &admin.key, &shift).await;
    assert_eq!(
        again["snapshot"], snapshot,
        "after the logo and the sheet are gone"
    );
    // The station's own list names no snapshot, and the shift a new station
    // opens now freezes the new state.
    let (_, fresh) = planned_with_sheet(&admin, &setup, None).await;
    let (status, entered) = enter(&admin, &admin.key, &fresh).await;
    assert_eq!(status, StatusCode::OK, "{entered}");
    assert!(entered["snapshot"].get("palletSheet").is_none());
    assert_eq!(
        entered["snapshot"]["organization"],
        json!({ "name": "ООО «Новое имя»", "inn": "7707083893", "logo": null })
    );
}

/// A planned shift whose sheet was turned off after planning opens with the
/// sheet as it is (turning off only stops new shifts from choosing it); a
/// sheet that is gone (never through the API, which refuses it) opens the
/// shift with no sheet rather than refusing the entry.
#[tokio::test]
async fn a_disabled_sheet_is_frozen_as_it_is_and_a_missing_one_as_none() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let sheet = stock_sheet(&admin, "pallet-a4-portrait").await;
    let (station, disabled) = planned_with_sheet(&admin, &setup, Some(&sheet)).await;
    let (status, _) = admin
        .call(
            "PUT",
            &format!("/v1/office/pallet-sheets/{sheet}"),
            Some(json!({ "enabled": false, "expectedRevision": 1 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let (status, entered) = enter(&admin, &admin.key, &disabled).await;
    assert_eq!(status, StatusCode::OK, "{entered}");
    assert_eq!(
        entered["snapshot"]["palletSheet"],
        json!({
            "id": sheet, "name": "pallet-a4-portrait", "revision": 2,
            "spec": sheet_spec("pallet-a4-portrait")
        })
    );
    // A second station-free shift naming a sheet that is gone from the table.
    let other = stock_sheet(&admin, "pallet-a4-landscape").await;
    let (_, missing) = planned_with_sheet(&admin, &setup, Some(&other)).await;
    sqlx::query("DELETE FROM pallet_sheet_templates WHERE id = ?")
        .bind(&other)
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    let before = audit_rows(&admin.app).await;
    let (status, entered) = enter(&admin, &admin.key, &missing).await;
    assert_eq!(status, StatusCode::OK, "{entered}");
    assert_eq!(entered["status"], "active");
    assert!(
        entered["snapshot"].get("palletSheet").is_none(),
        "{entered}"
    );
    assert!(entered["snapshot"]["palletTemplate"].is_object());
    assert!(entered["snapshot"]["organization"].is_object());
    // The opening is audited without a sheet.
    let trail = audit_trail(&admin.app, "shift.open").await;
    assert_eq!(trail.len(), 2);
    assert_eq!(audit_rows(&admin.app).await, before + 1);
    let row = trail
        .iter()
        .find(|row| row.4.as_deref() == missing["id"].as_str())
        .unwrap();
    assert_eq!(row.0, "device");
    assert_eq!(row.1.as_deref(), Some(station.as_str()));
    assert!(row.6.get("palletSheetTemplateId").is_none());
    assert!(row.6.get("palletSheetRevision").is_none());
}

#[tokio::test]
async fn a_shift_with_no_sheet_and_one_without_pallets_freeze_the_organization_only() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    // Pallets, no default sheet.
    let (_, pallets) = planned_with_sheet(&admin, &setup, None).await;
    let (status, entered) = enter(&admin, &admin.key, &pallets).await;
    assert_eq!(status, StatusCode::OK, "{entered}");
    assert!(entered["snapshot"].get("palletSheet").is_none());
    assert_eq!(
        entered["snapshot"]["organization"],
        json!({ "name": "ООО «Атолл»", "inn": "7701234567", "logo": null })
    );
    // No pallets, a default sheet: none reaches the shift.
    let sheet = stock_sheet(&admin, "pallet-a4-portrait").await;
    default_sheet_is(&admin, &sheet).await;
    let plain = plan_shift(&admin, shift_body(&setup)).await;
    let (status, entered) = enter(&admin, &admin.key, &plain).await;
    assert_eq!(status, StatusCode::OK, "{entered}");
    assert!(entered["snapshot"].get("palletSheet").is_none());
    assert!(entered["snapshot"]["organization"].is_object());
}

/// A station creates a shift with pallets: it names no sheet (decision
/// А4-3), so the host gives it the default one; the office reads it.
#[tokio::test]
async fn a_station_created_shift_with_pallets_takes_the_default_sheet() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    select_line(&admin, &admin.key, &setup.line).await;
    let pallet = pallet_template(&admin).await;
    let portrait = stock_sheet(&admin, "pallet-a4-portrait").await;
    let landscape = stock_sheet(&admin, "pallet-a4-landscape").await;
    let mut create = device_create(&setup, REQUEST);
    create["palletsEnabled"] = json!(true);
    create["palletTemplateId"] = json!(pallet);
    let (status, none) = device_call(
        &admin,
        &admin.key,
        "POST",
        "/v1/device/shifts",
        Some(create.clone()),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{none}");
    let (_, office) = admin
        .call(
            "GET",
            &format!("/v1/office/shifts/{}", none["id"].as_str().unwrap()),
            None,
        )
        .await;
    assert_eq!(office["palletSheetTemplateId"], Value::Null);
    default_sheet_is(&admin, &portrait).await;
    create["requestId"] = json!(SECOND_REQUEST);
    let (status, created) = device_call(
        &admin,
        &admin.key,
        "POST",
        "/v1/device/shifts",
        Some(create.clone()),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    // The station's own record names no sheet.
    assert!(created.get("palletSheetTemplateId").is_none());
    let (_, office) = admin
        .call(
            "GET",
            &format!("/v1/office/shifts/{}", created["id"].as_str().unwrap()),
            None,
        )
        .await;
    assert_eq!(office["palletSheetTemplateId"], json!(portrait));
    // The wire accepts a sheet in the request; the host checks it as the
    // office's.
    let mut named = create.clone();
    named["requestId"] = json!("2c3d4e5f-6071-4a82-8c93-a4b5c6d7e8f9");
    named["palletSheetTemplateId"] = json!(landscape);
    let (status, made) =
        device_call(&admin, &admin.key, "POST", "/v1/device/shifts", Some(named)).await;
    assert_eq!(status, StatusCode::OK, "{made}");
    let (_, office) = admin
        .call(
            "GET",
            &format!("/v1/office/shifts/{}", made["id"].as_str().unwrap()),
            None,
        )
        .await;
    assert_eq!(office["palletSheetTemplateId"], json!(landscape));
    // Its entry freezes that sheet.
    let (status, entered) = enter(&admin, &admin.key, &made).await;
    assert_eq!(status, StatusCode::OK, "{entered}");
    assert_eq!(entered["snapshot"]["palletSheet"]["id"], json!(landscape));
}

#[tokio::test]
async fn a_station_create_refuses_a_sheet_without_pallets_or_one_that_is_not_there() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    select_line(&admin, &admin.key, &setup.line).await;
    let pallet = pallet_template(&admin).await;
    let sheet = stock_sheet(&admin, "pallet-a4-portrait").await;
    let rows = audit_rows(&admin.app).await;
    let revision = host_revision(&admin.app).await;
    let mut no_pallets = device_create(&setup, REQUEST);
    no_pallets["palletSheetTemplateId"] = json!(sheet);
    let mut unknown = device_create(&setup, SECOND_REQUEST);
    unknown["palletsEnabled"] = json!(true);
    unknown["palletTemplateId"] = json!(pallet);
    unknown["palletSheetTemplateId"] = json!("6a3f0c5e-1b2d-4e8f-9a7b-0c1d2e3f4a5b");
    for body in [no_pallets, unknown] {
        let (status, refused) =
            device_call(&admin, &admin.key, "POST", "/v1/device/shifts", Some(body)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{refused}");
        assert_eq!(
            refused["error"]["details"]["field"],
            "palletSheetTemplateId"
        );
    }
    assert_eq!(audit_rows(&admin.app).await, rows);
    assert_eq!(host_revision(&admin.app).await, revision);
}

/// The sheet and the largest logo count against a shift's 320 KB: a plan
/// whose layouts fit without them is refused with them, and nothing opens.
#[tokio::test]
async fn a_sheet_and_a_logo_that_make_the_snapshot_too_large_refuse_the_entry() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    // The largest logo: 1024 x 512 bits, 87 384 characters of base64.
    let bits = "AAAA".repeat(21_845) + "AA==";
    let (status, logo) = admin
        .call(
            "PUT",
            "/v1/office/org/logo",
            Some(json!({ "width": 1024, "height": 512, "pixelsBase64": bits })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{logo}");
    // A box layout of 190 KB, in the table as a long-lived plan would have it.
    let big = json!({ "widthMm": 58, "heightMm": 40, "dpi": 203, "language": "zpl",
        "elements": [], "note": "x".repeat(190_000) });
    sqlx::query("UPDATE label_templates SET spec = ? WHERE id = ?")
        .bind(big.to_string())
        .bind(&setup.template)
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    let sheet = stock_sheet(&admin, "pallet-a4-portrait").await;
    sqlx::query("UPDATE pallet_sheet_templates SET spec = ? WHERE id = ?")
        .bind(
            json!({
                "schemaVersion": 2, "kind": "pallet_sheet", "dpi": 300, "pad": "y".repeat(65_000)
            })
            .to_string(),
        )
        .bind(&sheet)
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    let (_, without) = planned_with_sheet(&admin, &setup, None).await;
    let (_, with) = planned_with_sheet(&admin, &setup, Some(&sheet)).await;
    // Without the sheet, the box layout, the logo and the pallet layout fit.
    let (status, entered) = enter(&admin, &admin.key, &without).await;
    assert_eq!(status, StatusCode::OK, "{entered}");
    // With it they do not.
    let revision = host_revision(&admin.app).await;
    let (status, refused) = enter(&admin, &admin.key, &with).await;
    assert_eq!(status, StatusCode::CONFLICT, "{refused}");
    assert_eq!(
        refused["error"]["details"]["constraint"],
        "snapshot_too_large"
    );
    assert_eq!(host_revision(&admin.app).await, revision);
    let (_, still) = admin
        .call(
            "GET",
            &format!("/v1/office/shifts/{}", with["id"].as_str().unwrap()),
            None,
        )
        .await;
    assert_eq!(still["status"], "planned");
}
