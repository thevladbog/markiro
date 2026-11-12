mod support;

use aws_lc_rs::digest::{digest, SHA256};
use axum::http::{Request, StatusCode};
use serde_json::{json, Value};
use support::app::{
    admin, empty, fact, instant, pair_device, receipts, record_id, request, shift_closed,
    shift_setup, with_device, Admin,
};

const SET: &str = "04607123456781";
const UNIT: &str = "04607123456804";

async fn product(admin: &Admin, body: Value) -> Value {
    let (status, product) = admin.call("POST", "/v1/office/products", Some(body)).await;
    assert_eq!(status, StatusCode::OK, "{product}");
    product
}

fn mark(gtin: &str, serial: &str) -> Value {
    let key = format!("01{gtin}21{serial}");
    let hash: String = digest(&SHA256, key.as_bytes())
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    json!({
        "gtin14": gtin,
        "serial": serial,
        "canonical": format!("{key}\u{1d}93dAbc"),
        "codeHash": hash,
    })
}

#[tokio::test]
async fn freezes_the_recipe_and_atomically_registers_each_complete_set_once() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    product(
        &admin,
        json!({
            "gtin14": UNIT, "name": "Крем", "chzProductGroupCode": 35,
            "boxCapacity": 12, "palletBoxCapacity": 40
        }),
    )
    .await;
    let set = product(
        &admin,
        json!({
            "gtin14": SET, "name": "Набор", "chzProductGroupCode": 35,
            "setItems": [{"gtin14": UNIT, "productName": "Имя от клиента", "quantity": 2}]
        }),
    )
    .await;
    assert_eq!(set["setItems"][0]["productName"], "Крем");
    let (status, _) = admin
        .app
        .send(support::app::json(
            with_device(request("PUT", "/v1/device/line"), &admin.key),
            json!({"lineId": setup.line}),
        ))
        .await;
    assert_eq!(status, StatusCode::OK);
    let (status, shift) = admin
        .call(
            "POST",
            "/v1/office/shifts",
            Some(json!({
                "productId": set["id"], "lineId": setup.line, "productionDate": "2026-10-08",
                "mode": "validation"
            })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{shift}");
    let id = shift["id"].as_str().unwrap();
    let enter = format!("/v1/device/shifts/{id}/enter");
    let old = |method: &str, path: &str| {
        with_device(
            Request::builder().method(method).uri(path).header(
                markiro_proto::PROTOCOL_HEADER,
                markiro_proto::SET_ASSEMBLY_PROTOCOL_VERSION - 1,
            ),
            &admin.key,
        )
    };
    let (status, old_shifts) = admin.app.send(empty(old("GET", "/v1/device/shifts"))).await;
    assert_eq!(status, StatusCode::OK, "{old_shifts}");
    assert!(old_shifts["shifts"].as_array().unwrap().is_empty());
    let supports = json!({"supports": ["validation-v1", "set-assembly-v1"]});
    let (status, refused) = admin
        .app
        .send(support::app::json(old("POST", &enter), supports.clone()))
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{refused}");
    assert_eq!(refused["error"]["details"]["constraint"], "station_update");
    let (status, _) = admin
        .app
        .send(empty(with_device(request("POST", &enter), &admin.key)))
        .await;
    assert!(!status.is_success());
    let (status, snapshot) = admin
        .app
        .send(support::app::json(
            with_device(request("POST", &enter), &admin.key),
            supports,
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{snapshot}");
    assert_eq!(snapshot["snapshot"]["product"]["setItems"], set["setItems"]);
    let (status, updated) = admin.call("PUT", &format!("/v1/office/products/{}", set["id"].as_str().unwrap()), Some(json!({
        "expectedRev": set["rev"], "archived": false, "gtin14": SET, "name": "Набор", "chzProductGroupCode": 35,
        "setItems": [{"gtin14": UNIT, "productName": "Крем", "quantity": 1}]
    }))).await;
    assert_eq!(status, StatusCode::OK, "{updated}");

    let make = |n, set_code, items: Vec<Value>| {
        fact(
            &record_id(n),
            "set_assembled",
            id,
            json!({
                "assembledAt": instant(n, 0), "setCode": set_code, "items": items
            }),
        )
    };
    let first = mark(UNIT, "UNIT001");
    let second = mark(UNIT, "UNIT002");
    let third = mark(UNIT, "UNIT003");
    let other = mark(UNIT, "UNIT004");
    let incomplete = make(1, mark(SET, "SET0001"), vec![first.clone()]);
    let complete = make(2, mark(SET, "SET0002"), vec![second, first.clone()]);
    let overlap = make(3, mark(SET, "SET0003"), vec![third.clone(), first.clone()]);
    let overfilled = make(
        5,
        mark(SET, "SET0005"),
        vec![first.clone(), third.clone(), other.clone()],
    );
    let after_overlap = make(4, mark(SET, "SET0003"), vec![third, other]);
    let result = receipts(
        &admin.app,
        &admin.key,
        &[
            incomplete,
            complete.clone(),
            overlap,
            after_overlap,
            overfilled,
        ],
    )
    .await;
    assert_eq!(result[0]["outcome"], "rejected", "{result:?}");
    assert_eq!(result[1]["outcome"], "accepted", "{result:?}");
    assert_eq!(result[2]["outcome"], "conflict", "{result:?}");
    assert_eq!(result[3]["outcome"], "accepted", "{result:?}");
    assert_eq!(result[4]["outcome"], "rejected", "{result:?}");
    assert_eq!(
        receipts(&admin.app, &admin.key, &[complete]).await,
        result[1..2]
    );
    let (status, sets) = admin
        .call("GET", &format!("/v1/office/shifts/{id}/sets"), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{sets}");
    assert_eq!(sets.as_array().unwrap().len(), 3);
    assert_eq!(sets[0]["items"][0]["serial"], "UNIT002");
    assert_eq!(sets[1]["outcome"], "conflict");
    let (status, shift) = admin
        .call("GET", &format!("/v1/office/shifts/{id}"), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{shift}");
    assert_eq!(shift["totals"]["acceptedUnits"], 2);
    assert_eq!(shift["setItems"][0]["quantity"], 2);
    let close = fact(
        &record_id(6),
        "shift_closed",
        id,
        shift_closed(None, 2, 0, None, &instant(6, 0)),
    );
    let result = receipts(&admin.app, &admin.key, &[close]).await;
    assert_eq!(result[0]["outcome"], "accepted", "{result:?}");
    let (_, closed) = admin
        .call("GET", &format!("/v1/office/shifts/{id}"), None)
        .await;
    assert_eq!(closed["status"], "closed");
    assert_eq!(closed["totals"]["acceptedUnits"], 2);

    // A second station can have the same inputs in its offline journal. The first
    // accepted set keeps its ownership across shifts, and the losing station sees who won.
    let (_, other_key) = pair_device(&admin.app, "station").await;
    let (status, moved) = admin
        .app
        .send(support::app::json(
            with_device(request("PUT", "/v1/device/line"), &other_key),
            json!({"lineId": setup.other_line}),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{moved}");
    let (status, other_shift) = admin
        .app
        .send(support::app::json(
            with_device(request("POST", "/v1/device/shifts"), &other_key),
            json!({
                "requestId": record_id(50), "productId": set["id"],
                "productionDate": "2026-10-08", "mode": "validation"
            }),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{other_shift}");
    let other_id = other_shift["id"].as_str().unwrap();
    let (status, entered) = admin
        .app
        .send(support::app::json(
            with_device(
                request("POST", &format!("/v1/device/shifts/{other_id}/enter")),
                &other_key,
            ),
            json!({"supports": ["validation-v1", "set-assembly-v1"]}),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{entered}");
    assert_eq!(entered["snapshot"]["product"]["setItems"][0]["quantity"], 1);
    let overlap = fact(
        &record_id(51),
        "set_assembled",
        other_id,
        json!({
            "assembledAt": instant(1, 0), "setCode": mark(SET, "SET0051"),
            "items": [mark(UNIT, "UNIT001")]
        }),
    );
    let result = receipts(&admin.app, &other_key, &[overlap]).await;
    assert_eq!(result[0]["outcome"], "conflict", "{result:?}");
    assert_eq!(result[0]["details"]["winner"]["shiftId"], id);
    assert_eq!(result[0]["details"]["winner"]["sameDevice"], false);
}
