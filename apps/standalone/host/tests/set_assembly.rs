mod support;

use aws_lc_rs::digest::{digest, SHA256};
use axum::http::{Request, StatusCode};
use serde_json::{json, Value};
use support::app::{
    admin, audit_row, audit_trail, box_exception, box_id, close_from_office, empty, fact, instant,
    ok_scan, open_floor, pair_device, pair_handheld, receipts, record_id, request, shift_closed,
    shift_setup, sscc, with_device, Admin,
};
use support::disaggregation::{add, apply, create, day_with_setup, line, REASON};

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

#[tokio::test]
async fn disaggregation_releases_the_components_but_keeps_the_set_mark_and_journal() {
    let admin = admin().await;
    let (mut setup, _) = day_with_setup(&admin, true).await;
    let unit = product(
        &admin,
        json!({
            "gtin14": UNIT, "name": "Крем", "chzProductGroupCode": 35,
            "boxCapacity": 12, "palletBoxCapacity": 40
        }),
    )
    .await;
    setup.product = unit["id"].as_str().unwrap().to_owned();
    let (_, box_key) = pair_device(&admin.app, "station").await;
    let handheld = pair_handheld(&admin).await;
    let boxes = open_floor(&admin, &setup, &box_key, &setup.other_line).await;
    let set = product(
        &admin,
        json!({
            "gtin14": SET, "name": "Набор", "chzProductGroupCode": 35,
            "setItems": [{"gtin14": UNIT, "productName": "Крем", "quantity": 1}]
        }),
    )
    .await;
    let (device_id, key) = pair_device(&admin.app, "station").await;
    let (status, assigned) = admin
        .app
        .send(support::app::json(
            with_device(request("PUT", "/v1/device/line"), &key),
            json!({"lineId": setup.line}),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{assigned}");
    let start = || async {
        let (status, shift) = admin
            .call(
                "POST",
                "/v1/office/shifts",
                Some(json!({
                    "productId": set["id"], "lineId": setup.line,
                    "productionDate": "2026-10-08", "mode": "validation"
                })),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{shift}");
        let id = shift["id"].as_str().unwrap().to_owned();
        let (status, entered) = admin
            .app
            .send(support::app::json(
                with_device(
                    request("POST", &format!("/v1/device/shifts/{id}/enter")),
                    &key,
                ),
                json!({"supports": ["validation-v1", "set-assembly-v1"]}),
            ))
            .await;
        assert_eq!(status, StatusCode::OK, "{entered}");
        id
    };
    let shift = start().await;
    let parent = mark(SET, "OUTER01");
    let component = mark(UNIT, "INNER01");
    let mut boxed = ok_scan(1, &box_id(4), &instant(7, 0));
    boxed["code"] = component.clone();
    let scan = fact(&record_id(7), "scan", &boxes.shift, boxed.clone());
    let hash = component["codeHash"].as_str().unwrap();
    let preflight = |key: &str, query: &str| {
        empty(with_device(
            request("GET", &format!("/v1/device/codes/{hash}{query}")),
            key,
        ))
    };
    let aggregate = "?aggregation=true";
    let free = (StatusCode::OK, json!({"status": "free"}));
    assert_eq!(admin.app.send(preflight(&box_key, aggregate)).await, free);
    let assembled = |n, shift: &str, parent: &Value, component: &Value| {
        fact(
            &record_id(n),
            "set_assembled",
            shift,
            json!({
                "assembledAt": instant(n, 0), "setCode": parent, "items": [component]
            }),
        )
    };
    let original = assembled(10, &shift, &parent, &component);
    let original_receipt = receipts(&admin.app, &key, &[original.clone()]).await;
    assert_eq!(original_receipt[0]["outcome"], "accepted");
    let held = admin.app.send(preflight(&box_key, aggregate)).await;
    assert_eq!(held.0, StatusCode::OK);
    assert_eq!(held.1["status"], "in_set");
    let winner = &held.1["owner"];
    assert_eq!(winner["shiftId"], shift);
    assert_eq!(winner["deviceId"], device_id);
    assert_eq!(winner["scannedAt"], instant(10, 0));
    assert_eq!(winner["sameDevice"], false);
    assert_eq!(admin.app.send(preflight(&handheld, aggregate)).await, held);
    assert_eq!(admin.app.send(preflight(&box_key, "")).await, free);
    assert_eq!(
        admin
            .app
            .send(preflight(&box_key, "?aggregation=false"))
            .await,
        free
    );

    // The earlier scan arrives after the successful set assembly and the shift close.
    close_from_office(&admin, &boxes.shift, "Проверка позднего скана").await;
    let blocked = receipts(&admin.app, &box_key, std::slice::from_ref(&scan)).await;
    assert_eq!(
        blocked,
        [json!({
            "id": record_id(7), "outcome": "conflict",
            "details": {"winner": winner, "setMembership": true}
        })]
    );
    let saved: (String, String, Option<String>, bool, bool) = sqlx::query_as(
        "SELECT s.verdict, s.duplicate_source, s.box_id,
                EXISTS(SELECT 1 FROM box_items WHERE scan_id = s.id),
                EXISTS(SELECT 1 FROM code_owners WHERE scan_id = s.id)
         FROM scans s WHERE s.device_id = ? AND s.record_id = ?",
    )
    .bind(&boxes.station)
    .bind(record_id(7))
    .fetch_one(&admin.app.state.pool)
    .await
    .unwrap();
    assert_eq!(
        saved,
        ("duplicate".into(), "host".into(), None, false, false)
    );

    let doc = create(&admin, json!({"reasonId": REASON})).await;
    let doc_id = doc["document"]["id"].as_str().unwrap();
    let raw = format!(" ]d2{} ", parent["canonical"].as_str().unwrap());
    let box_sscc = sscc(1500);
    let (status, draft) = add(
        &admin,
        doc_id,
        json!([line(&raw, None), line(&box_sscc, Some(&box_sscc))]),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{draft}");
    assert_eq!(draft["lines"][0]["status"], "shift_open");
    assert_eq!(draft["lines"][0]["setCode"], format!("01{SET}21OUTER01"));
    assert_eq!(draft["lines"][0]["setId"], record_id(10));
    assert_eq!(draft["lines"][0]["shiftId"], shift);
    assert_eq!(draft["lines"][0]["codeCount"], 1);

    let close = fact(
        &record_id(11),
        "shift_closed",
        &shift,
        shift_closed(None, 1, 0, None, &instant(11, 0)),
    );
    assert_eq!(
        receipts(&admin.app, &key, &[close]).await[0]["outcome"],
        "accepted"
    );
    let invalid = create(&admin, json!({"reasonId": REASON})).await;
    let invalid_id = invalid["document"]["id"].as_str().unwrap();
    let (status, invalid) = add(
        &admin,
        invalid_id,
        json!([
            line(&raw, None),
            line(component["canonical"].as_str().unwrap(), None),
            line(&box_sscc, Some(&box_sscc))
        ]),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{invalid}");
    assert_eq!(invalid["lines"][1]["status"], "not_found");
    let (status, invalid_apply) = apply(&admin, &invalid).await;
    assert_eq!(status, StatusCode::CONFLICT, "{invalid_apply}");
    assert_eq!(invalid_apply["error"]["details"]["invalidLines"], 1);
    // The invalid line did not partially apply either valid line.
    let (status, done) = apply(&admin, &draft).await;
    assert_eq!(status, StatusCode::OK, "{done}");
    assert_eq!(done["document"]["status"], "applied");
    assert_eq!(done["lines"][0]["status"], "ok");
    assert_eq!(done["lines"][1]["status"], "ok");
    assert_eq!(admin.app.send(preflight(&box_key, aggregate)).await, free);
    assert_eq!(receipts(&admin.app, &box_key, &[scan]).await, blocked);
    let retried = fact(&record_id(8), "scan", &boxes.shift, boxed);
    assert_eq!(
        receipts(&admin.app, &box_key, &[retried]).await[0]["outcome"],
        "accepted"
    );
    let packed: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM box_items WHERE box_id = ?")
        .bind(box_id(4))
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    assert_eq!(packed, 1);
    let clear = fact(
        &record_id(9),
        "box_exception",
        &boxes.shift,
        box_exception("clear", &box_id(4), &instant(8, 0)),
    );
    assert_eq!(
        receipts(&admin.app, &box_key, &[clear]).await[0]["outcome"],
        "accepted"
    );
    assert_eq!(
        receipts(&admin.app, &key, &[original]).await,
        original_receipt
    );

    let (_, feed) = admin
        .app
        .send(empty(with_device(
            request("GET", "/v1/changes?since=0"),
            &key,
        )))
        .await;
    let release = feed["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["entity"] == "set_releases")
        .expect("set release from zero");
    assert_eq!(release["id"], done["lines"][0]["id"]);
    assert_eq!(release["rev"], done["document"]["rev"]);
    assert_eq!(
        release["data"],
        json!({
            "deviceId": device_id, "recordId": record_id(10), "shiftId": shift,
            "setCodeHash": parent["codeHash"]
        })
    );
    let (_, sets) = admin
        .call("GET", &format!("/v1/office/shifts/{shift}/sets"), None)
        .await;
    assert_eq!(sets[0]["outcome"], "accepted");
    assert_eq!(sets[0]["items"][0], component);
    assert_eq!(sets[0]["disassembledAt"], done["document"]["appliedAt"]);
    assert_eq!(sets[0]["disaggregationDocumentId"], doc_id);
    let (_, shift_card) = admin
        .call("GET", &format!("/v1/office/shifts/{shift}"), None)
        .await;
    assert_eq!(shift_card["totals"]["acceptedUnits"], 1);
    let audits = audit_trail(&admin.app, "disaggregation.apply").await;
    assert_eq!(audits.len(), 2);
    assert_eq!(
        audits[1],
        audit_row(
            &admin.id,
            "disaggregation.apply",
            "disaggregation_document",
            doc_id,
            json!({"docNo": done["document"]["docNo"], "boxes": 1, "pallets": 0, "sets": 1, "codes": 4})
        )
    );

    let (status, report) = admin
        .call(
            "GET",
            &format!("/v1/office/disaggregation/{doc_id}/report-data?variant=full"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{report}");
    assert_eq!(report["lines"][0]["sscc"], Value::Null);
    assert_eq!(report["lines"][0]["setCode"], draft["lines"][0]["setCode"]);
    assert_eq!(
        report["lines"][0]["items"][0]["canonical"],
        component["canonical"]
    );
    assert_eq!(report["lines"][1]["sscc"], box_sscc);
    assert_eq!(report["lines"][1]["items"].as_array().unwrap().len(), 3);
    let (status, shift_report) = admin
        .call(
            "GET",
            &format!("/v1/office/shifts/{shift}/disaggregation-report?variant=full"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{shift_report}");
    assert_eq!(shift_report["lines"], json!([report["lines"][0]]));

    let (status, xml) = admin.call("POST", &format!("/v1/office/disaggregation/{doc_id}/exports"),
        Some(json!({"formatId": "disaggregation_xml_gismt", "formatVersion": 1, "packingCount": 1}))).await;
    assert_eq!(status, StatusCode::CONFLICT, "{xml}");
    assert_eq!(
        xml["error"]["details"]["constraint"],
        "set_disaggregation_xml_unsupported"
    );
    let (status, exported) = admin.call(
        "POST",
        &format!("/v1/office/disaggregation/{doc_id}/exports"),
        Some(json!({"formatId": "disaggregation_json_gismt", "formatVersion": 1, "packingCount": 2})),
    ).await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{exported}");

    let next = start().await;
    let outcomes = receipts(
        &admin.app,
        &key,
        &[
            assembled(12, &next, &parent, &component),
            assembled(13, &next, &mark(SET, "OUTER02"), &component),
        ],
    )
    .await;
    assert_eq!(outcomes[0]["outcome"], "conflict");
    assert_eq!(outcomes[0]["details"]["codeHash"], parent["codeHash"]);
    assert_eq!(outcomes[1]["outcome"], "accepted");

    let retry = create(&admin, json!({"reasonId": REASON})).await;
    let retry_id = retry["document"]["id"].as_str().unwrap();
    let code = draft["lines"][0]["setCode"].as_str().unwrap();
    let (status, checked) = add(
        &admin,
        retry_id,
        json!([line(code, None), line(&raw, None)]),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{checked}");
    assert_eq!(checked["lines"][0]["status"], "already_disassembled");
    assert_eq!(checked["lines"][1]["status"], "duplicate");
}
