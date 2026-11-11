//! A station builds a warehouse pallet independently of the shifts that closed its boxes.

mod support;

use axum::http::StatusCode;
use markiro_host::facts::rules::box_membership_digest;
use serde_json::{json, Value};
use support::app::{
    admin, audit_row, audit_trail, box_id, close_from_office, code_hash, empty, fact,
    host_revision, instant, issue_block, ok_scan, open_floor, pair_device, pair_handheld, receipts,
    record_id, request, shift_setup, with_device, Admin,
};
use support::handheld::{
    accepted, added, box_sscc, closed_boxes, event, events, opened, pallet_block, pallet_sscc,
    receipts_of, rejected, PALLET_A, PALLET_B,
};
use support::license::{file, load_ok};

const REQUEST_ID: &str = "8f7e6d5c-4b3a-4f2e-8d1c-9b8a7f6e5d4c";

async fn operator(admin: &Admin) -> String {
    let (status, body) = admin
        .call(
            "POST",
            "/v1/office/operators",
            Some(json!({
                "login": "0042", "name": "Оператор поста",
                "pinPhc": "pbkdf2$sha256$100000$bWFya2lyby1waW4tc2FsdA==$3OKvrZ2+EfTB2zsCso90r5g8c6Ib6t+Bv+cGJOpgPmU="
            })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body["id"].as_str().unwrap().to_owned()
}

fn by(mut event: Value, operator: &str) -> Value {
    event["operatorId"] = json!(operator);
    event
}

async fn registry(admin: &Admin, key: &str) -> (StatusCode, Value) {
    admin
        .app
        .send(empty(with_device(
            request("GET", "/v1/device/box-registry"),
            key,
        )))
        .await
}

#[tokio::test]
async fn station_builds_one_pallet_from_two_shifts_while_a_source_shift_is_open() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let first = closed_boxes(&admin, &setup, 1).await;
    assert_eq!(
        close_from_office(&admin, &first.shift, "Смена окончена").await["status"],
        "closed"
    );
    let (_, other_producer) = pair_device(&admin.app, "station").await;
    let second = open_floor(&admin, &setup, &other_producer, &setup.other_line).await;
    let block = issue_block(&admin.app, &second.key, REQUEST_ID).await;
    let second_serial = block["fromSerial"].as_u64().unwrap() as u32;
    let second_sscc = box_sscc(second_serial);
    let second_box = box_id(2);
    let facts = [
        fact(
            &record_id(102),
            "scan",
            &second.shift,
            ok_scan(2, &second_box, &instant(2, 0)),
        ),
        fact(
            &record_id(202),
            "box_closed",
            &second.shift,
            json!({
                "boxId": second_box, "sscc": second_sscc, "blockId": block["id"],
                "serial": second_serial, "openedAt": instant(2, 0), "closedAt": instant(2, 500),
                "itemCount": 1, "membershipDigest": box_membership_digest(&[code_hash(2)])
            }),
        ),
    ];
    for receipt in receipts(&admin.app, &second.key, &facts).await {
        assert_eq!(receipt["outcome"], "accepted", "{receipt}");
    }

    let (assembly_id, assembly_key) = pair_device(&admin.app, "station").await;
    let (status, data) = registry(&admin, &assembly_key).await;
    assert_eq!(status, StatusCode::OK, "{data}");
    assert_eq!(data["canOpenPallets"], true);
    let items = data["items"].as_array().unwrap();
    for (sscc, source) in [(box_sscc(1500), &first), (second_sscc.clone(), &second)] {
        let item = items.iter().find(|item| item["sscc"] == sscc).unwrap();
        assert_eq!(item["shiftNumber"], source.number);
        assert_eq!(item["productId"], setup.product);
        assert_eq!(item["palletActive"], false);
        assert!(item["closedAt"].is_string());
    }
    let handheld = pair_handheld(&admin).await;
    let (status, data) = registry(&admin, &handheld).await;
    assert_eq!(status, StatusCode::OK, "{data}");
    assert!(data.get("canOpenPallets").is_none());
    assert!(data["items"]
        .as_array()
        .unwrap()
        .iter()
        .all(|item| item.get("shiftNumber").is_none()));

    let operator = operator(&admin).await;
    let block = pallet_block(&admin, &assembly_key, REQUEST_ID).await;
    let serial = block["fromSerial"].as_u64().unwrap() as u32;
    let sscc = pallet_sscc(serial);
    let records = [
        opened(1, PALLET_A, &setup.product, &instant(100, 0)),
        added(2, PALLET_A, &box_sscc(1500), &instant(101, 0)),
        added(3, PALLET_A, &second_sscc, &instant(102, 0)),
        event(
            4,
            "warehouse_pallet_closed",
            json!({
                "palletId": PALLET_A, "sscc": sscc, "blockId": block["id"], "serial": serial,
                "openedAt": instant(100, 0), "closedAt": instant(110, 0), "boxCount": 2
            }),
        ),
    ]
    .map(|event| by(event, &operator));
    let expected = vec![accepted(1), accepted(2), accepted(3), accepted(4)];
    assert_eq!(receipts_of(&admin, &assembly_key, &records).await, expected);
    assert_eq!(receipts_of(&admin, &assembly_key, &records).await, expected);
    let disassemble = by(
        event(
            5,
            "warehouse_pallet_disassembled",
            json!({
                "palletId":PALLET_A,"reasonCode":"other","reasonText":"Проверка допуска",
                "disassembledAt":instant(111, 0)
            }),
        ),
        &operator,
    );
    assert_eq!(
        receipts_of(&admin, &assembly_key, &[disassemble]).await,
        vec![rejected(5, "invalid_record", Some(json!({"field":"kind"})))]
    );
    let (device_id, operator_id): (String, String) =
        sqlx::query_as("SELECT device_id, operator_id FROM warehouse_pallets WHERE id = ?")
            .bind(PALLET_A)
            .fetch_one(&admin.app.state.pool)
            .await
            .unwrap();
    assert_eq!((device_id, operator_id), (assembly_id, operator));

    let (status, detail) = admin
        .call(
            "GET",
            &format!("/v1/office/warehouse-pallets/{PALLET_A}"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{detail}");
    assert_eq!(detail["sscc"], sscc);
    assert_eq!(detail["boxes"], 2);
    let members = detail["members"].as_array().unwrap();
    assert_eq!(members[0]["shiftId"], first.shift);
    assert_eq!(members[1]["shiftId"], second.shift);
    let (status, shift) = admin
        .call("GET", &format!("/v1/office/shifts/{}", second.shift), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{shift}");
    assert_eq!(shift["status"], "active");

    assert_eq!(
        receipts_of(
            &admin,
            &handheld,
            &[
                opened(1, PALLET_B, &setup.product, &instant(120, 0)),
                added(2, PALLET_B, &second_sscc, &instant(121, 0)),
            ]
        )
        .await,
        vec![
            accepted(1),
            rejected(
                2,
                "box_on_pallet",
                Some(json!({"palletId": PALLET_A, "palletSscc": sscc}))
            )
        ],
    );
}

#[tokio::test]
async fn station_requires_a_historical_actor_id_and_office_devices_cannot_use_the_routes() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let (_, office) = pair_device(&admin.app, "office").await;
    let (_, station) = pair_device(&admin.app, "station").await;
    let mut missing = opened(1, PALLET_A, &setup.product, &instant(100, 0));
    missing["operatorId"] = Value::Null;
    let malformed = by(
        opened(2, PALLET_A, &setup.product, &instant(100, 0)),
        "unknown",
    );
    let bad_actor = |n| rejected(n, "invalid_record", Some(json!({ "field": "operatorId" })));
    assert_eq!(
        events(&admin, &office, &[malformed.clone()]).await.0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(registry(&admin, &office).await.0, StatusCode::FORBIDDEN);
    assert_eq!(
        receipts_of(&admin, &station, &[missing, malformed]).await,
        vec![bad_actor(1), bad_actor(2)]
    );
    let operator = operator(&admin).await;
    let (status, body) = admin.call("GET", "/v1/office/operators", None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, body) = admin
        .call(
            "PUT",
            &format!("/v1/office/operators/{operator}"),
            Some(json!({"active":false,"expectedRev":body[0]["rev"]})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let queued = by(
        opened(3, PALLET_A, &setup.product, &instant(100, 0)),
        &operator,
    );
    assert_eq!(
        receipts_of(&admin, &station, &[queued]).await,
        vec![accepted(3)]
    );
    let unknown_after_restore = by(
        opened(4, PALLET_A, &setup.product, &instant(100, 0)),
        REQUEST_ID,
    );
    assert_eq!(
        receipts_of(&admin, &station, &[unknown_after_restore]).await,
        vec![accepted(4)]
    );
}

fn close_event(n: u32, pallet: &str, operator: &str, block: &Value, count: u32) -> Value {
    let serial = block["fromSerial"].as_u64().unwrap() as u32;
    by(
        event(
            n,
            "warehouse_pallet_closed",
            json!({
                "palletId": pallet, "sscc": pallet_sscc(serial), "blockId": block["id"], "serial": serial,
                "openedAt": instant(100, 0), "closedAt": instant(110, 0), "boxCount": count,
            }),
        ),
        operator,
    )
}

#[tokio::test]
async fn an_office_review_approves_the_exact_authoritative_box_set_for_a_new_close() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    closed_boxes(&admin, &setup, 1).await;
    let (station_id, station) = pair_device(&admin.app, "station").await;
    let (_, other) = pair_device(&admin.app, "station").await;
    let operator = operator(&admin).await;
    let (tech, tech_id) = admin.technologist_session().await;
    let block = pallet_block(&admin, &station, REQUEST_ID).await;
    let close = close_event(3, PALLET_A, &operator, &block, 2);
    let revision = host_revision(&admin.app).await;
    let receipts = receipts_of(
        &admin,
        &station,
        &[
            by(
                opened(1, PALLET_A, &setup.product, &instant(100, 0)),
                &operator,
            ),
            by(
                added(2, PALLET_A, &box_sscc(1500), &instant(101, 0)),
                &operator,
            ),
            close.clone(),
        ],
    )
    .await;
    assert_eq!(receipts[2]["code"], "pallet_count_mismatch");
    assert_eq!(host_revision(&admin.app).await, revision + 1);
    let issue = receipts[2]["details"]["closeIssueId"]
        .as_str()
        .expect("a rejected printed close has a durable case");
    let following = by(
        opened(7, PALLET_B, &setup.product, &instant(120, 0)),
        &operator,
    );
    for attempt in [
        following.clone(),
        close_event(8, PALLET_B, &operator, &block, 1),
    ] {
        let (status, response) = events(&admin, &station, &[attempt]).await;
        assert_eq!(status, StatusCode::CONFLICT, "{response}");
        assert_eq!(
            response["error"]["details"]["constraint"],
            "previous_pallet_needs_review"
        );
    }
    assert_eq!(
        receipts_of(&admin, &station, &[close]).await,
        vec![receipts[2].clone()]
    );
    let get = format!("/v1/device/pallet-events/close-issues/{issue}");
    let resolve = format!("/v1/office/warehouse-pallets/close-issues/{issue}/resolve");
    let poll = |key: &str| empty(with_device(request("GET", &get), key));
    assert_eq!(admin.app.send(poll(&other)).await.0, StatusCode::NOT_FOUND);
    let (status, list) = admin
        .call("GET", "/v1/office/warehouse-pallets/close-issues", None)
        .await;
    assert_eq!(status, StatusCode::OK, "{list}");
    assert_eq!(list["issues"][0]["id"], issue);
    assert_eq!(list["issues"][0]["palletId"], PALLET_A);
    assert_eq!(list["issues"][0]["reportedBoxes"], 2);
    assert_eq!(
        list["issues"][0]["currentBoxSsccs"],
        json!([box_sscc(1500)])
    );
    let (status, premature) = events(
        &admin,
        &station,
        &[close_event(4, PALLET_A, &operator, &block, 1)],
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{premature}");
    assert_eq!(premature["receipts"][0]["details"]["closeIssueId"], issue);
    assert_eq!(premature["receipts"][0]["outcome"], "rejected");
    let (status, stale) = admin
        .call(
            "POST",
            &resolve,
            Some(json!({
                "action":"approve_reclose","expectedBoxSsccs":[box_sscc(1501)]
            })),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{stale}");
    assert_eq!(
        stale["error"]["details"]["constraint"],
        "pallet_contents_changed"
    );
    let (status, approved) = admin
        .call_as(
            &tech,
            "POST",
            &resolve,
            Some(json!({
                "action":"approve_reclose","expectedBoxSsccs":[box_sscc(1500)]
            })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{approved}");
    assert_eq!(approved["approvedBoxSsccs"], json!([box_sscc(1500)]));
    assert_eq!(approved["status"], "approved");
    assert_eq!(host_revision(&admin.app).await, revision + 2);
    assert_eq!(
        audit_trail(&admin.app, "warehouse_pallet.close_issue.resolve").await,
        vec![audit_row(
            &tech_id,
            "warehouse_pallet.close_issue.resolve",
            "warehouse_pallet_close_issue",
            issue,
            json!({"action":"approve_reclose","deviceId":station_id,"palletId":PALLET_A,"sscc":approved["sscc"],"approvedBoxes":1}),
        )]
    );
    assert_eq!(
        receipts_of(
            &admin,
            &station,
            &[close_event(5, PALLET_A, &operator, &block, 1)]
        )
        .await,
        vec![accepted(5)]
    );
    let (status, reclosed) = admin.app.send(poll(&station)).await;
    assert_eq!(status, StatusCode::OK, "{reclosed}");
    assert_eq!(reclosed["status"], "reclosed");
    assert_eq!(host_revision(&admin.app).await, revision + 3);
    assert_eq!(
        receipts_of(&admin, &station, &[following]).await,
        vec![accepted(7)]
    );
}

#[tokio::test]
async fn a_reclose_rechecks_box_identity_even_when_the_count_stayed_the_same() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    closed_boxes(&admin, &setup, 2).await;
    let (_, station) = pair_device(&admin.app, "station").await;
    let operator = operator(&admin).await;
    let block = pallet_block(&admin, &station, REQUEST_ID).await;
    let receipts = receipts_of(
        &admin,
        &station,
        &[
            by(
                opened(1, PALLET_A, &setup.product, &instant(100, 0)),
                &operator,
            ),
            by(
                added(2, PALLET_A, &box_sscc(1500), &instant(101, 0)),
                &operator,
            ),
            close_event(3, PALLET_A, &operator, &block, 2),
        ],
    )
    .await;
    let issue = receipts[2]["details"]["closeIssueId"].as_str().unwrap();
    let resolve = format!("/v1/office/warehouse-pallets/close-issues/{issue}/resolve");
    let (status, approved) = admin
        .call(
            "POST",
            &resolve,
            Some(json!({
                "action":"approve_reclose","expectedBoxSsccs":[box_sscc(1500)]
            })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{approved}");
    let receipts = receipts_of(
        &admin,
        &station,
        &[
            by(
                event(
                    4,
                    "pallet_box_removed",
                    json!({
                        "palletId":PALLET_A,"boxSscc":box_sscc(1500),"removedAt":instant(105,0)
                    }),
                ),
                &operator,
            ),
            by(
                added(5, PALLET_A, &box_sscc(1501), &instant(106, 0)),
                &operator,
            ),
            close_event(6, PALLET_A, &operator, &block, 1),
        ],
    )
    .await;
    assert_eq!(&receipts[..2], &[accepted(4), accepted(5)]);
    assert_eq!(
        receipts[2],
        rejected(
            6,
            "pallet_count_mismatch",
            Some(json!({"counted":1,"closeIssueId":issue}))
        )
    );
    let (status, list) = admin
        .call("GET", "/v1/office/warehouse-pallets/close-issues", None)
        .await;
    assert_eq!(status, StatusCode::OK, "{list}");
    assert_eq!(list["issues"][0]["id"], issue);
    assert_eq!(list["issues"][0]["status"], "pending");
    assert_eq!(
        list["issues"][0]["currentBoxSsccs"],
        json!([box_sscc(1501)])
    );
    assert!(list["issues"][0].get("approvedBoxes").is_none());
}

#[tokio::test]
async fn cancelling_a_rejected_close_releases_boxes_but_retires_its_valid_printed_number() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    closed_boxes(&admin, &setup, 1).await;
    let (_, station) = pair_device(&admin.app, "station").await;
    let operator = operator(&admin).await;
    let block = pallet_block(&admin, &station, REQUEST_ID).await;
    let receipts = receipts_of(
        &admin,
        &station,
        &[
            by(
                opened(1, PALLET_A, &setup.product, &instant(100, 0)),
                &operator,
            ),
            by(
                added(2, PALLET_A, &box_sscc(1500), &instant(101, 0)),
                &operator,
            ),
            close_event(3, PALLET_A, &operator, &block, 2),
        ],
    )
    .await;
    let issue = receipts[2]["details"]["closeIssueId"]
        .as_str()
        .expect("a rejected close has a case");
    let path = format!("/v1/office/warehouse-pallets/close-issues/{issue}/resolve");
    let tech = admin.technologist().await;
    assert_eq!(
        admin
            .call_as(
                &tech,
                "POST",
                &path,
                Some(json!({"action":"cancel","labelRemoved":true}))
            )
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        admin
            .call(
                "POST",
                &path,
                Some(json!({"action":"cancel","labelRemoved":false}))
            )
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    let cancel = json!({"action":"cancel","labelRemoved":true});
    let (status, cancelled) = admin.call("POST", &path, Some(cancel.clone())).await;
    assert_eq!(status, StatusCode::OK, "{cancelled}");
    assert_eq!(cancelled["status"], "cancelled");
    assert_eq!(admin.call("POST", &path, Some(cancel)).await.1, cancelled);
    assert_eq!(
        receipts_of(
            &admin,
            &station,
            &[
                by(
                    opened(4, PALLET_B, &setup.product, &instant(120, 0)),
                    &operator
                ),
                by(
                    added(5, PALLET_B, &box_sscc(1500), &instant(121, 0)),
                    &operator
                ),
            ]
        )
        .await,
        vec![accepted(4), accepted(5)]
    );
    let retired = receipts_of(
        &admin,
        &station,
        &[close_event(6, PALLET_B, &operator, &block, 1)],
    )
    .await;
    assert_eq!(retired[0]["code"], "sscc_not_issued");
}

#[tokio::test]
async fn a_locally_printed_pallet_that_never_opened_on_host_can_be_cancelled() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let (_, station) = pair_device(&admin.app, "station").await;
    let operator = operator(&admin).await;
    let block = pallet_block(&admin, &station, REQUEST_ID).await;
    let receipt = receipts_of(
        &admin,
        &station,
        &[close_event(1, PALLET_A, &operator, &block, 1)],
    )
    .await;
    assert_eq!(receipt[0]["code"], "pallet_unknown");
    let issue = receipt[0]["details"]["closeIssueId"].as_str().unwrap();
    let path = format!("/v1/office/warehouse-pallets/close-issues/{issue}/resolve");
    let (status, cancelled) = admin
        .call(
            "POST",
            &path,
            Some(json!({"action":"cancel","labelRemoved":true})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{cancelled}");
    assert_eq!(cancelled["status"], "cancelled");
    assert_eq!(cancelled["currentBoxSsccs"], json!([]));
    let serial = block["fromSerial"].as_i64().unwrap();
    let consumed: Option<i64> =
        sqlx::query_scalar("SELECT consumed_through FROM sscc_blocks WHERE id = ?")
            .bind(block["id"].as_str().unwrap())
            .fetch_one(&admin.app.state.pool)
            .await
            .unwrap();
    assert_eq!(consumed, Some(serial));
    let replay = receipts_of(
        &admin,
        &station,
        &[
            by(
                opened(2, PALLET_A, &setup.product, &instant(100, 0)),
                &operator,
            ),
            close_event(3, PALLET_A, &operator, &block, 1),
        ],
    )
    .await;
    for (receipt, n) in replay.iter().zip([2, 3]) {
        assert_eq!(
            *receipt,
            rejected(n, "pallet_state", Some(json!({"closeIssueId":issue})))
        );
    }
}

#[tokio::test]
async fn a_station_key_cannot_disassemble_a_cabinet_pallet_of_its_own_device() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    closed_boxes(&admin, &setup, 1).await;
    let operator = operator(&admin).await;
    let (status, body) = admin
        .call(
            "POST",
            "/v1/office/warehouse-pallets",
            Some(json!({"requestId":REQUEST_ID,"codes":[box_sscc(1500)]})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let id = body["id"].as_str().unwrap();
    let records = [
        by(opened(1, id, &setup.product, &instant(100, 0)), &operator),
        by(
            event(
                2,
                "warehouse_pallet_disassembled",
                json!({
                    "palletId": id, "reasonCode": "other", "reasonText": "Сверка",
                    "disassembledAt": instant(110, 0)
                }),
            ),
            &operator,
        ),
    ];
    assert_eq!(
        receipts_of(&admin, &admin.key, &records).await,
        vec![
            rejected(1, "invalid_record", Some(json!({"field": "data.palletId"}))),
            rejected(2, "invalid_record", Some(json!({"field": "kind"}))),
        ]
    );
}

#[tokio::test]
async fn a_station_can_read_the_registry_when_pallets_are_disabled() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let operator = operator(&admin).await;
    load_ok(
        &admin,
        &file(&admin.app.state.host_id, |terms| {
            terms["features"]["pallets"] = json!(false);
        }),
    )
    .await;
    let (status, data) = registry(&admin, &admin.key).await;
    assert_eq!(status, StatusCode::OK, "{data}");
    assert_eq!(data["canOpenPallets"], false);
    assert_eq!(
        receipts_of(
            &admin,
            &admin.key,
            &[by(
                opened(1, PALLET_A, &setup.product, &instant(100, 0)),
                &operator
            ),]
        )
        .await,
        vec![rejected(1, "feature_disabled", None)]
    );
}
