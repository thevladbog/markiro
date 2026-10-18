//! A handheld on the host's floor (plan ТСД-Х, task Х2, spec 6.3, 6.7): the office gives it a
//! line, it reads and enters its line's shift naming `handheld-host-v1`, gets blocks of both
//! extensions, sends facts and closes the shift; a station on the same line finds the shift busy;
//! a license that ran out stops its first entry and nothing that runs.

mod support;

use axum::http::StatusCode;
use markiro_host::facts::rules::box_membership_digest;
use serde_json::{json, Value};
use support::app::{
    accepted, admin, audit_rows, box_id, code_hash, empty, fact, host_revision, instant,
    json as json_request, ok_scan, pair_handheld, plan_shift, receipts, record_id, request,
    shift_body, shift_closed, shift_setup, with_device, Admin, ShiftSetup,
};
use support::license::{expired_file, load_ok};

const SUPPORTS: &str = "handheld-host-v1";

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

/// A handheld the office put on `line`; returns its id and key.
async fn handheld_on(admin: &Admin, line: &str) -> (String, String) {
    let key = pair_handheld(admin).await;
    let (status, info) = device_call(admin, &key, "GET", "/v1/device", None).await;
    assert_eq!(status, StatusCode::OK, "{info}");
    let id = info["id"].as_str().unwrap().to_owned();
    let (status, updated) = admin
        .call(
            "PUT",
            &format!("/v1/office/devices/{id}"),
            Some(json!({ "name": "ТСД 1", "lineId": line })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{updated}");
    (id, key)
}

async fn enter(
    admin: &Admin,
    key: &str,
    shift: &Value,
    supports: Option<&[&str]>,
) -> (StatusCode, Value) {
    let path = format!("/v1/device/shifts/{}/enter", shift["id"].as_str().unwrap());
    device_call(
        admin,
        key,
        "POST",
        &path,
        supports.map(|names| json!({ "supports": names })),
    )
    .await
}

fn constraint(body: &Value) -> Value {
    body["error"]["details"]["constraint"].clone()
}

async fn block(admin: &Admin, key: &str, request_id: &str, extension: u8) -> Value {
    let (status, block) = device_call(
        admin,
        key,
        "POST",
        "/v1/device/sscc/blocks",
        Some(
            json!({ "requestId": request_id, "issuerPrefix": "460068200", "extension": extension }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{block}");
    block
}

async fn planned(admin: &Admin, setup: &ShiftSetup) -> Value {
    plan_shift(admin, shift_body(setup)).await
}

#[tokio::test]
async fn a_handheld_on_a_line_reads_and_enters_its_shift_naming_the_capability() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let shift = planned(&admin, &setup).await;
    let (id, key) = handheld_on(&admin, &setup.line).await;

    let (status, listed) = device_call(&admin, &key, "GET", "/v1/device/shifts", None).await;
    assert_eq!(status, StatusCode::OK, "{listed}");
    assert_eq!(listed["shifts"][0]["id"], shift["id"]);

    // Without the capability the host asks for an update, and writes nothing.
    let (rows, rev) = (
        audit_rows(&admin.app).await,
        host_revision(&admin.app).await,
    );
    for supports in [None, Some(&["validation-v1"][..])] {
        let (status, refused) = enter(&admin, &key, &shift, supports).await;
        assert_eq!(
            (status, constraint(&refused)),
            (StatusCode::CONFLICT, json!("station_update")),
            "{supports:?}"
        );
    }
    assert_eq!(
        (
            audit_rows(&admin.app).await,
            host_revision(&admin.app).await
        ),
        (rows, rev)
    );

    let (status, entered) = enter(&admin, &key, &shift, Some(&[SUPPORTS])).await;
    assert_eq!(status, StatusCode::OK, "{entered}");
    assert_eq!(entered["status"], json!("active"));
    assert_eq!(entered["ownerDeviceId"], json!(id));
    assert_eq!(entered["snapshot"]["issuerPrefix"], json!("460068200"));
    // The owner enters again and gets the same snapshot.
    let (status, again) = enter(&admin, &key, &shift, Some(&[SUPPORTS])).await;
    assert_eq!(
        (status, again["snapshot"].clone()),
        (StatusCode::OK, entered["snapshot"].clone())
    );
}

#[tokio::test]
async fn a_handheld_without_a_line_or_on_another_line_finds_the_shift_on_another_line() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let shift = planned(&admin, &setup).await;
    let (_, elsewhere) = handheld_on(&admin, &setup.other_line).await;
    let (status, refused) = enter(&admin, &elsewhere, &shift, Some(&[SUPPORTS])).await;
    assert_eq!(
        (status, constraint(&refused)),
        (StatusCode::CONFLICT, json!("shift_line"))
    );
    let unassigned = pair_handheld(&admin).await;
    let (status, refused) = enter(&admin, &unassigned, &shift, Some(&[SUPPORTS])).await;
    assert_eq!(
        (status, constraint(&refused)),
        (StatusCode::CONFLICT, json!("shift_line"))
    );
}

#[tokio::test]
async fn one_device_works_a_shift_so_a_station_on_the_line_finds_it_busy() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let shift = planned(&admin, &setup).await;
    let (_, key) = handheld_on(&admin, &setup.line).await;
    let (status, moved) = device_call(
        &admin,
        &admin.key,
        "PUT",
        "/v1/device/line",
        Some(json!({ "lineId": setup.line })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{moved}");
    let (status, entered) = enter(&admin, &key, &shift, Some(&[SUPPORTS])).await;
    assert_eq!(status, StatusCode::OK, "{entered}");
    let (status, busy) = enter(&admin, &admin.key, &shift, None).await;
    assert_eq!(
        (status, constraint(&busy)),
        (StatusCode::CONFLICT, json!("shift_busy"))
    );
}

#[tokio::test]
async fn a_handheld_gets_blocks_sends_facts_and_closes_its_shift() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let shift = planned(&admin, &setup).await;
    let (_, key) = handheld_on(&admin, &setup.line).await;
    let (status, entered) = enter(&admin, &key, &shift, Some(&[SUPPORTS])).await;
    assert_eq!(status, StatusCode::OK, "{entered}");
    let boxes = block(&admin, &key, "7e6d5c4b-3a2f-4e1d-9c8b-7a6f5e4d3c2b", 0).await;
    assert_eq!(
        (boxes["fromSerial"].clone(), boxes["toSerial"].clone()),
        (json!(1500), json!(3499))
    );
    // The pallet extension too, from the pallet counter the wizard started at 40.
    let pallets = block(&admin, &key, "8f7e6d5c-4b3a-4f2e-8d1c-9b8a7f6e5d4c", 1).await;
    assert_eq!(pallets["fromSerial"], json!(40));

    let shift_id = shift["id"].as_str().unwrap();
    let digest = box_membership_digest(&[code_hash(1)]);
    let batch = [
        fact(
            &record_id(1),
            "scan",
            shift_id,
            ok_scan(1, &box_id(1), &instant(1, 0)),
        ),
        fact(
            &record_id(2),
            "box_closed",
            shift_id,
            json!({
                "boxId": box_id(1), "sscc": "046006820000015000", "blockId": boxes["id"],
                "serial": 1500, "openedAt": instant(1, 0), "closedAt": instant(30, 0),
                "itemCount": 1, "membershipDigest": digest
            }),
        ),
        fact(
            &record_id(3),
            "shift_closed",
            shift_id,
            shift_closed(None, 1, 1, None, &instant(60, 0)),
        ),
    ];
    assert_eq!(
        receipts(&admin.app, &key, &batch).await,
        vec![
            accepted(&record_id(1)),
            accepted(&record_id(2)),
            accepted(&record_id(3))
        ]
    );
    let status: String = sqlx::query_scalar("SELECT status FROM shifts WHERE id = ?")
        .bind(shift_id)
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    assert_eq!(status, "closed");
}

#[tokio::test]
async fn a_license_that_ran_out_stops_a_first_entry_and_never_an_open_handheld_shift() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let open = planned(&admin, &setup).await;
    let (_, key) = handheld_on(&admin, &setup.line).await;
    let (status, entered) = enter(&admin, &key, &open, Some(&[SUPPORTS])).await;
    assert_eq!(status, StatusCode::OK, "{entered}");
    let next = planned(&admin, &setup).await;
    load_ok(&admin, &expired_file(&admin.app.state.host_id)).await;

    // The first entry into another planned shift is the one closed move.
    let (status, refused) = enter(&admin, &key, &next, Some(&[SUPPORTS])).await;
    assert_eq!(
        (status, refused["error"]["details"]["constraint"].clone()),
        (StatusCode::CONFLICT, json!("license_restricted"))
    );
    // The open shift is entered again, gets facts and is closed.
    let (status, again) = enter(&admin, &key, &open, Some(&[SUPPORTS])).await;
    assert_eq!(status, StatusCode::OK, "{again}");
    let shift_id = open["id"].as_str().unwrap();
    assert_eq!(
        receipts(
            &admin.app,
            &key,
            &[
                fact(
                    &record_id(1),
                    "scan",
                    shift_id,
                    ok_scan(1, &box_id(1), &instant(1, 0))
                ),
                fact(
                    &record_id(2),
                    "shift_closed",
                    shift_id,
                    shift_closed(None, 1, 0, None, &instant(60, 0))
                ),
            ],
        )
        .await,
        vec![accepted(&record_id(1)), accepted(&record_id(2))]
    );
}
