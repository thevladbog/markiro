//! A handheld's side of the host's floor for tests (plan ТСД-Х): closed boxes to build a warehouse
//! pallet of, and the records of `POST /v1/device/pallet-events`.

use axum::http::StatusCode;
use markiro_host::facts::rules::box_membership_digest;
use serde_json::{json, Value};

use super::app::{
    box_id, code_hash, empty, fact, instant, issue_block, json as json_request, ok_scan,
    open_floor, pair_handheld, pallet_shift_body, pallet_template, plan_shift, receipts, record_id,
    request, with_device, Admin, Floor, ShiftSetup,
};

pub const PALLET_A: &str = "a1000000-0000-4000-8000-000000000001";
pub const PALLET_B: &str = "a1000000-0000-4000-8000-000000000002";
pub const OPERATOR: &str = "c4a1e2b3-5d6f-4a7b-8c9d-0e1f2a3b4c5d";

/// The SSCC of box serial `n` of the first box block (the host never checks the check digit).
pub fn box_sscc(n: u32) -> String {
    format!("0460068200{n:07}0")
}

pub fn pallet_sscc(n: u32) -> String {
    format!("1460068200{n:07}9")
}

pub async fn events(admin: &Admin, key: &str, records: &[Value]) -> (StatusCode, Value) {
    admin
        .app
        .send(json_request(
            with_device(request("POST", "/v1/device/pallet-events"), key),
            json!({ "records": records }),
        ))
        .await
}

pub async fn receipts_of(admin: &Admin, key: &str, records: &[Value]) -> Vec<Value> {
    let (status, body) = events(admin, key, records).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body["receipts"].as_array().unwrap().clone()
}

pub fn event(n: u32, kind: &str, data: Value) -> Value {
    json!({ "id": record_id(n), "kind": kind, "operatorId": OPERATOR, "data": data })
}

pub fn opened(n: u32, pallet: &str, product: &str, at: &str) -> Value {
    event(
        n,
        "warehouse_pallet_opened",
        json!({ "palletId": pallet, "productId": product, "openedAt": at }),
    )
}

pub fn added(n: u32, pallet: &str, sscc: &str, at: &str) -> Value {
    event(
        n,
        "pallet_box_added",
        json!({ "palletId": pallet, "boxSscc": sscc, "addedAt": at }),
    )
}

pub fn accepted(n: u32) -> Value {
    json!({ "id": record_id(n), "outcome": "accepted" })
}

pub fn rejected(n: u32, code: &str, details: Option<Value>) -> Value {
    let mut receipt = json!({ "id": record_id(n), "outcome": "rejected", "code": code });
    if let Some(details) = details {
        receipt["details"] = details;
    }
    receipt
}

/// A station closes box `n` (serial 1499 + n) in a shift of `setup`'s product: the boxes a
/// warehouse pallet is built of. Returns the floor: the station's shift and key (its box block is
/// 1500-3499, the wizard's first).
pub async fn closed_boxes(admin: &Admin, setup: &ShiftSetup, count: u32) -> Floor {
    let floor = open_floor(admin, setup, &admin.key, &setup.line).await;
    let block = issue_block(
        &admin.app,
        &floor.key,
        "7e6d5c4b-3a2f-4e1d-9c8b-7a6f5e4d3c2b",
    )
    .await;
    for n in 1..=count {
        let digest = box_membership_digest(&[code_hash(n)]);
        let batch = [
            fact(
                &record_id(100 + n),
                "scan",
                &floor.shift,
                ok_scan(n, &box_id(n), &instant(n, 0)),
            ),
            fact(
                &record_id(200 + n),
                "box_closed",
                &floor.shift,
                json!({
                    "boxId": box_id(n), "sscc": box_sscc(1499 + n), "blockId": block["id"],
                    "serial": 1499 + n, "openedAt": instant(n, 0), "closedAt": instant(n, 500),
                    "itemCount": 1, "membershipDigest": digest
                }),
            ),
        ];
        assert_eq!(receipts(&admin.app, &floor.key, &batch).await.len(), 2);
    }
    floor
}

/// The id of the pallet block (extension 1) the handheld `key` was issued.
pub async fn pallet_block(admin: &Admin, key: &str, request_id: &str) -> Value {
    let (status, block) = admin
        .app
        .send(json_request(
            with_device(request("POST", "/v1/device/sscc/blocks"), key),
            json!({ "requestId": request_id, "issuerPrefix": "460068200", "extension": 1 }),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{block}");
    block
}

pub fn product_of(setup: &ShiftSetup) -> &str {
    &setup.product
}

/// A handheld on `setup`'s line (the office gives it the line), a shift with pallets planned on that
/// line and entered by the handheld naming `handheld-host-v1`: the handheld is the shift's owner.
pub async fn open_handheld_pallet_floor(admin: &Admin, setup: &ShiftSetup) -> Floor {
    let key = pair_handheld(admin).await;
    let (status, info) = admin
        .app
        .send(empty(with_device(request("GET", "/v1/device"), &key)))
        .await;
    assert_eq!(status, StatusCode::OK, "{info}");
    let id = info["id"].as_str().unwrap().to_owned();
    let (status, updated) = admin
        .call(
            "PUT",
            &format!("/v1/office/devices/{id}"),
            Some(json!({ "name": "ТСД 1", "lineId": setup.line })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{updated}");
    let template = pallet_template(admin).await;
    let shift = plan_shift(admin, pallet_shift_body(setup, &template)).await;
    let path = format!("/v1/device/shifts/{}/enter", shift["id"].as_str().unwrap());
    let (status, entered) = admin
        .app
        .send(json_request(
            with_device(request("POST", &path), &key),
            json!({ "supports": ["handheld-host-v1"] }),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{entered}");
    Floor {
        shift: shift["id"].as_str().unwrap().to_owned(),
        number: shift["number"].as_str().unwrap().to_owned(),
        station: id,
        key,
    }
}
