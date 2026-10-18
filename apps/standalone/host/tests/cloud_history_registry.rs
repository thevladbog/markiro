#[path = "support/history.rs"]
mod history;
mod support;
use axum::http::StatusCode;
use support::app::{request, with_device};

#[tokio::test]
async fn external_owner_box_is_provenance_without_a_fabricated_pack_or_shift_card() {
    let owner: serde_json::Value = serde_json::from_str(include_str!(
        "../../proto/fixtures/cloud-history-external-owner.json"
    ))
    .unwrap();
    let mut r = history::request();
    r["part"]["payload"]["owners"]
        .as_array_mut()
        .unwrap()
        .push(owner.clone());
    history::seal(&mut r);
    let (a, _) = history::setup_request(r, true).await;
    let (status, result) = a
        .app
        .send(
            with_device(
                request(
                    "GET",
                    &format!("/v1/device/codes/{}", owner["hash"].as_str().unwrap()),
                ),
                &a.key,
            )
            .body(axum::body::Body::empty())
            .unwrap(),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(result["owner"]["shiftNumber"], owner["number"]);
    assert_eq!(
        result["owner"]["deviceId"],
        "00000000-0000-0000-0000-000000000000"
    );
    // CodeOwner intentionally has no box field; the office conflict retains it.
    assert!(result["owner"].get("boxId").is_none());
    sqlx::query("UPDATE products SET archived=1")
        .execute(&a.app.state.pool)
        .await
        .unwrap();
    let setup = support::app::shift_setup(&a).await;
    let floor = support::app::open_floor(&a, &setup, &a.key, &setup.line).await;
    let mut scan = support::app::ok_scan(
        999,
        &support::app::box_id(999),
        &support::app::instant(999, 0),
    );
    scan["code"]["codeHash"] = owner["hash"].clone();
    let batch = [support::app::fact(
        &support::app::record_id(999),
        "scan",
        &floor.shift,
        scan,
    )];
    assert_eq!(
        support::app::receipts(&a.app, &floor.key, &batch).await[0]["outcome"],
        "conflict"
    );
    let (status, conflicts) = a.call("GET", "/v1/office/conflicts", None).await;
    assert_eq!(status, StatusCode::OK, "{conflicts}");
    assert_eq!(conflicts["items"][0]["winner"]["boxId"], owner["boxId"]);
    assert!(conflicts["items"][0]["winner"]["boxSscc"].is_null());
    for (kind, field) in [("cloud-boxes", "boxId"), ("cloud-shifts", "shiftId")] {
        assert_eq!(
            a.call(
                "GET",
                &format!("/v1/office/{kind}/{}", owner[field].as_str().unwrap()),
                None
            )
            .await
            .0,
            StatusCode::NOT_FOUND
        );
    }
}

#[tokio::test]
async fn completed_import_ids_are_reserved_across_native_pack_creation() {
    use support::app::*;
    use support::handheld::{opened, receipts_of, PALLET_A};
    let (a, r) = history::setup(true).await;
    sqlx::query("UPDATE products SET archived=1")
        .execute(&a.app.state.pool)
        .await
        .unwrap();
    let setup = shift_setup(&a).await;
    let floor = open_pallet_floor(&a, &setup, &a.key, &setup.line).await;
    let block = issue_pallet_block(&a.app, &floor.key, &record_id(800)).await;
    let key = pair_handheld(&a).await;
    for (i, group) in ["shifts", "boxes", "pallets"].iter().enumerate() {
        let id = r["part"]["payload"][group][0]["id"].as_str().unwrap();
        let n = 810 + i as u32;
        let batch = [fact(
            &record_id(n),
            "scan",
            &floor.shift,
            ok_scan(n, id, &instant(n, 0)),
        )];
        let result = receipts(&a.app, &floor.key, &batch).await;
        assert_eq!(result[0]["code"], "box_unknown", "{result:?}");
        assert_eq!(receipts(&a.app, &floor.key, &batch).await, result);
        let batch = [fact(
            &record_id(n + 10),
            "pallet_closed",
            &floor.shift,
            pallet_closed(id, &block, 40, 1, &instant(n, 0), &instant(n, 1)),
        )];
        let result = receipts(&a.app, &floor.key, &batch).await;
        assert_eq!(result[0]["code"], "pallet_unknown", "{result:?}");
        let result = receipts_of(&a, &key, &[opened(n, id, &setup.product, &instant(n, 0))]).await;
        assert_eq!(result[0]["outcome"], "rejected", "{result:?}");
        assert_eq!(result[0]["details"]["field"], "data.palletId");
    }
    // Real native identities still accept retries, including a second record id.
    let batch = [fact(
        &record_id(850),
        "scan",
        &floor.shift,
        ok_scan(850, &box_id(850), &instant(850, 0)),
    )];
    let result = receipts(&a.app, &floor.key, &batch).await;
    assert_eq!(result[0]["outcome"], "accepted");
    assert_eq!(receipts(&a.app, &floor.key, &batch).await, result);
    let batch = [
        opened(851, PALLET_A, &setup.product, &instant(851, 0)),
        opened(852, PALLET_A, &setup.product, &instant(851, 0)),
    ];
    assert!(receipts_of(&a, &key, &batch)
        .await
        .iter()
        .all(|r| r["outcome"] == "accepted"));
}

#[tokio::test]
async fn old_live_blocks_cannot_reuse_imported_sscc_on_any_native_pack() {
    use support::app::*;
    use support::handheld::{event, opened, receipts_of, PALLET_A};
    let (a, r) = history::setup(true).await;
    sqlx::query("UPDATE products SET archived=1")
        .execute(&a.app.state.pool)
        .await
        .unwrap();
    let setup = shift_setup(&a).await;
    let floor = open_pallet_floor(&a, &setup, &a.key, &setup.line).await;
    let box_block = issue_block(&a.app, &floor.key, &record_id(900)).await;
    let pallet_block = issue_pallet_block(&a.app, &floor.key, &record_id(901)).await;
    let key = pair_handheld(&a).await;
    let warehouse_block = issue_pallet_block(&a.app, &key, &record_id(902)).await;
    // Model a previously issued, still live offline block spanning an imported serial.
    sqlx::query("UPDATE sscc_blocks SET from_serial=0")
        .execute(&a.app.state.pool)
        .await
        .unwrap();
    let imported_box = r["part"]["payload"]["boxes"][0]["sscc"].as_str().unwrap();
    let imported_pallet = r["part"]["payload"]["pallets"][0]["sscc"].as_str().unwrap();
    let serial = |sscc: &str| sscc[10..17].parse::<u64>().unwrap();
    let scan = fact(
        &record_id(903),
        "scan",
        &floor.shift,
        ok_scan(903, &box_id(903), &instant(903, 0)),
    );
    assert_eq!(
        receipts(&a.app, &floor.key, &[scan]).await[0]["outcome"],
        "accepted"
    );
    let mut close = box_closed(
        &box_id(903),
        &box_block,
        serial(imported_box),
        &[903],
        &instant(903, 0),
        &instant(903, 1),
    );
    close["sscc"] = serde_json::json!(imported_box);
    let mut pallet = pallet_closed(
        &pallet_id(904),
        &pallet_block,
        serial(imported_pallet),
        1,
        &instant(904, 0),
        &instant(904, 1),
    );
    pallet["sscc"] = serde_json::json!(imported_pallet);
    let batch = [
        fact(&record_id(905), "box_closed", &floor.shift, close),
        fact(&record_id(906), "pallet_closed", &floor.shift, pallet),
    ];
    let result = receipts(&a.app, &floor.key, &batch).await;
    assert!(
        result.iter().all(|r| r["code"] == "sscc_taken"),
        "{result:?}"
    );
    assert_eq!(receipts(&a.app, &floor.key, &batch).await, result);
    let batch = [
        opened(907, PALLET_A, &setup.product, &instant(907, 0)),
        event(
            908,
            "warehouse_pallet_closed",
            serde_json::json!({"palletId":PALLET_A,"sscc":imported_pallet,"blockId":warehouse_block["id"],"serial":serial(imported_pallet),"openedAt":instant(907,0),"closedAt":instant(907,1),"boxCount":1}),
        ),
    ];
    let result = receipts_of(&a, &key, &batch).await;
    assert_eq!(result[0]["outcome"], "accepted", "{result:?}");
    assert_eq!(result[1]["code"], "sscc_taken", "{result:?}");
    assert_eq!(receipts_of(&a, &key, &batch).await, result);
}

#[tokio::test]
async fn backdated_offline_scan_loses_and_cloud_conflict_is_reviewable() {
    use support::app::{
        box_id, fact, instant, json, ok_scan, open_floor, receipts, record_id, shift_setup,
    };
    let (a, r) = history::setup(true).await;
    let source = &r["part"]["payload"]["codes"][0];
    sqlx::query("UPDATE products SET archived=1")
        .execute(&a.app.state.pool)
        .await
        .unwrap();
    let setup = shift_setup(&a).await;
    let floor = open_floor(&a, &setup, &a.key, &setup.line).await;
    let mut scan = ok_scan(1, &box_id(99), &instant(1, 0));
    scan["code"] = serde_json::json!({"codeHash":source["hash"],"canonical":source["canonical"],"gtin14":source["gtin14"],"serial":source["serial"]});
    let facts = [fact(&record_id(99), "scan", &floor.shift, scan)];
    let answered = receipts(&a.app, &floor.key, &facts).await;
    assert_eq!(answered[0]["outcome"], "conflict", "{answered:?}");
    assert_eq!(receipts(&a.app, &floor.key, &facts).await, answered);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM code_owners")
            .fetch_one(&a.app.state.pool)
            .await
            .unwrap(),
        0
    );
    let (status, list) = a.call("GET", "/v1/office/conflicts", None).await;
    assert_eq!(status, StatusCode::OK, "{list}");
    assert_eq!(list["total"], 1, "{list}");
    assert_eq!(
        list["items"][0]["winner"]["deviceId"],
        "00000000-0000-0000-0000-000000000000"
    );
    let id = list["items"][0]["id"].as_str().unwrap();
    let (token, user_id) = a.technologist_session().await;
    let (status, review) = a
        .call_as(
            &token,
            "POST",
            &format!("/v1/office/conflicts/{id}/review"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{review}");
    assert!(review["reviewedAt"].is_string());
    let expected = serde_json::json!({"kind":"late","loserShiftId":floor.shift,"loserDeviceId":floor.station,"winnerShiftId":source["shiftId"]});
    assert_eq!(
        support::app::audit_trail(&a.app, "conflict.review").await,
        vec![(
            "office_user".to_owned(),
            Some(user_id),
            "conflict.review".to_owned(),
            Some("code_conflict".to_owned()),
            Some(id.to_owned()),
            "ok".to_owned(),
            expected
        )]
    );
    assert_eq!(
        a.call("POST", &format!("/v1/office/conflicts/{id}/review"), None)
            .await
            .1,
        review
    );
    assert_eq!(
        support::app::audit_trail(&a.app, "conflict.review")
            .await
            .len(),
        1
    );
    let (status, result) = a
        .app
        .send(json(
            with_device(request("POST", "/v1/device/conflicts/status"), &floor.key),
            serde_json::json!({"recordIds":[record_id(99)]}),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(result["reviewed"][0]["recordId"], record_id(99));
}

#[tokio::test]
async fn reprocessing_never_moves_the_original_owner_into_its_report_shift() {
    let (a, r) = history::setup(true).await;
    let code = r["part"]["payload"]["codes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["flatOnly"] == true)
        .unwrap();
    let hash = code["hash"].as_str().unwrap();
    let (status, body) = a
        .app
        .send(
            with_device(request("GET", &format!("/v1/device/codes/{hash}")), &a.key)
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_ne!(body["owner"]["shiftId"], code["shiftId"]);
    let owner = r["part"]["payload"]["owners"]
        .as_array()
        .unwrap()
        .iter()
        .find(|o| o["hash"] == hash)
        .unwrap();
    assert_eq!(body["owner"]["shiftId"], owner["shiftId"]);
    assert_eq!(body["owner"]["shiftNumber"], owner["number"]);
}

#[tokio::test]
async fn online_check_returns_imported_owner_without_a_device_or_scan() {
    let (a, r) = history::setup(true).await;
    let owner = &r["part"]["payload"]["owners"][0];
    let path = format!("/v1/device/codes/{}", owner["hash"].as_str().unwrap());
    let (status, body) = a
        .app
        .send(
            with_device(request("GET", &path), &a.key)
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["status"], "taken", "{body}");
    assert_eq!(body["owner"]["shiftNumber"], owner["number"]);
    assert_eq!(
        body["owner"]["deviceId"],
        "00000000-0000-0000-0000-000000000000"
    );
    assert_eq!(body["owner"]["sameDevice"], false);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM scans")
            .fetch_one(&a.app.state.pool)
            .await
            .unwrap(),
        0
    );
}
