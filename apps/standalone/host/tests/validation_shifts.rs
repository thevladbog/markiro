//! Validation shifts on the host (plan РЕЖ, A5): the facts of a validation
//! shift (an accepted scan without a box, no box or pallet facts, a close
//! with no boxes), the registry shared with aggregation shifts, the shift's
//! totals and its export source.

mod support;

use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{
    accepted, admin, box_closed, box_exception, box_id, code, code_hash, empty, fact, fact_rows,
    instant, issue_block, ok_scan, open_floor, open_validation_floor, pair_device, receipts,
    record_id, rejected, request, shift_closed, shift_setup, with_device, Admin, Floor, ShiftSetup,
};

/// The `data` of an accepted scan of code `n` in a validation shift at `at`:
/// no box (protocol 4).
fn checked_scan(n: u32, at: &str) -> Value {
    let mut scan = ok_scan(n, &box_id(0), at);
    scan["boxId"] = Value::Null;
    scan
}

/// An administrator's host with the station on the first line inside an
/// open validation shift.
async fn validation_floor() -> (Admin, ShiftSetup, Floor) {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_validation_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    (admin, setup, floor)
}

/// The journal's `(record, shift, verdict, box)` rows, by record.
async fn scan_rows(admin: &Admin) -> Vec<Value> {
    let rows: Vec<(String, String, String, Option<String>)> = sqlx::query_as(
        "SELECT record_id, shift_id, verdict, box_id FROM scans ORDER BY record_id, device_id",
    )
    .fetch_all(&admin.app.state.pool)
    .await
    .unwrap();
    rows.into_iter()
        .map(|row| json!([row.0, row.1, row.2, row.3]))
        .collect()
}

/// The registry: `(code hash, owner's record, shift, device, box, scanned at)`.
async fn owners(admin: &Admin) -> Vec<Value> {
    type OwnerRow = (String, String, String, String, Option<String>, String);
    let rows: Vec<OwnerRow> = sqlx::query_as(
        "SELECT o.code_hash, s.record_id, o.shift_id, o.device_id, o.box_id, o.scanned_at \
         FROM code_owners o JOIN scans s ON s.id = o.scan_id ORDER BY o.code_hash",
    )
    .fetch_all(&admin.app.state.pool)
    .await
    .unwrap();
    rows.into_iter()
        .map(|row| json!([row.0, row.1, row.2, row.3, row.4, row.5]))
        .collect()
}

/// Every item: `(record of the scan, box, code hash, removed, displaced)`.
async fn items(admin: &Admin) -> Vec<Value> {
    type ItemRow = (String, String, String, Option<String>, Option<String>);
    let rows: Vec<ItemRow> = sqlx::query_as(
        "SELECT s.record_id, i.box_id, i.code_hash, i.removed_at, i.displaced_at \
         FROM box_items i JOIN scans s ON s.id = i.scan_id ORDER BY s.record_id",
    )
    .fetch_all(&admin.app.state.pool)
    .await
    .unwrap();
    rows.into_iter()
        .map(|row| json!([row.0, row.1, row.2, row.3, row.4]))
        .collect()
}

/// The conflicts: `(code hash, winner's record, loser's record)`.
async fn conflicts(admin: &Admin) -> Vec<Value> {
    let rows: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT c.code_hash, w.record_id, l.record_id FROM code_conflicts c \
         JOIN scans w ON w.id = c.winner_scan_id JOIN scans l ON l.id = c.loser_scan_id \
         ORDER BY w.record_id, l.record_id",
    )
    .fetch_all(&admin.app.state.pool)
    .await
    .unwrap();
    rows.into_iter()
        .map(|row| json!([row.0, row.1, row.2]))
        .collect()
}

/// `GET /v1/device/codes/{hash}` of code `n`, asked with `key`.
async fn check_code(admin: &Admin, key: &str, n: u32) -> (StatusCode, Value) {
    admin
        .app
        .send(empty(with_device(
            request("GET", &format!("/v1/device/codes/{}", code_hash(n))),
            key,
        )))
        .await
}

/// `GET /v1/office/shifts/{id}` as the administrator.
async fn office_shift(admin: &Admin, id: &str) -> Value {
    let (status, shift) = admin
        .call("GET", &format!("/v1/office/shifts/{id}"), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{shift}");
    shift
}

/// (а), (ж): an accepted scan of a validation shift names no box: the
/// journal keeps it without one, the registry gives its code to it without
/// one, and no box or item is made. The same batch again gets the same
/// receipts and writes nothing.
#[tokio::test]
async fn an_accepted_scan_of_a_validation_shift_owns_its_code_without_a_box() {
    let (admin, _, floor) = validation_floor().await;
    let batch = [
        fact(
            &record_id(1),
            "scan",
            &floor.shift,
            checked_scan(1, &instant(1, 0)),
        ),
        fact(
            &record_id(2),
            "scan",
            &floor.shift,
            checked_scan(2, &instant(2, 0)),
        ),
    ];
    let answered = receipts(&admin.app, &floor.key, &batch).await;
    assert_eq!(
        answered,
        vec![accepted(&record_id(1)), accepted(&record_id(2))]
    );
    assert_eq!(
        scan_rows(&admin).await,
        vec![
            json!([record_id(1), floor.shift, "ok", null]),
            json!([record_id(2), floor.shift, "ok", null]),
        ]
    );
    assert_eq!(
        owners(&admin).await,
        vec![
            json!([
                code_hash(1),
                record_id(1),
                floor.shift,
                floor.station,
                null,
                instant(1, 0)
            ]),
            json!([
                code_hash(2),
                record_id(2),
                floor.shift,
                floor.station,
                null,
                instant(2, 0)
            ]),
        ]
    );
    assert_eq!(items(&admin).await, Vec::<Value>::new());
    let kept = fact_rows(&admin.app).await;
    assert_eq!(kept["boxes"], 0);
    assert_eq!(receipts(&admin.app, &floor.key, &batch).await, answered);
    assert_eq!(fact_rows(&admin.app).await, kept);
}

/// (г): an accepted scan names a box in an aggregation shift and none in a
/// validation shift; the other way round is `invalid_record` on
/// `data.boxId`, and nothing of the record is kept but its receipt.
#[tokio::test]
async fn an_accepted_scan_names_a_box_exactly_in_an_aggregation_shift() {
    let (admin, setup, floor) = validation_floor().await;
    let (_, colleague_key) = pair_device(&admin.app, "station").await;
    let aggregation = open_floor(&admin, &setup, &colleague_key, &setup.other_line).await;
    let before = fact_rows(&admin.app).await;
    let boxed = fact(
        &record_id(1),
        "scan",
        &floor.shift,
        ok_scan(1, &box_id(1), &instant(1, 0)),
    );
    assert_eq!(
        receipts(&admin.app, &floor.key, &[boxed]).await,
        vec![rejected(
            Some(&record_id(1)),
            "invalid_record",
            Some("data.boxId")
        )]
    );
    let unboxed = fact(
        &record_id(2),
        "scan",
        &aggregation.shift,
        checked_scan(2, &instant(2, 0)),
    );
    assert_eq!(
        receipts(&admin.app, &aggregation.key, &[unboxed]).await,
        vec![rejected(
            Some(&record_id(2)),
            "invalid_record",
            Some("data.boxId")
        )]
    );
    let mut expected = before.clone();
    expected["fact_receipts"] = json!(before["fact_receipts"].as_i64().unwrap() + 2);
    assert_eq!(fact_rows(&admin.app).await, expected);
}

/// (б): a code a validation shift accepted is not free for an aggregation
/// shift: the station's check of the code (the host duplicate of Р8) names
/// the validation scan, a later scan of it at another station is `conflict`
/// with the validation scan as the winner, and puts nothing into its box.
#[tokio::test]
async fn a_code_a_validation_shift_accepted_is_not_free_for_an_aggregation_shift() {
    let (admin, setup, floor) = validation_floor().await;
    let (_, colleague_key) = pair_device(&admin.app, "station").await;
    let aggregation = open_floor(&admin, &setup, &colleague_key, &setup.other_line).await;
    assert_eq!(
        receipts(
            &admin.app,
            &floor.key,
            &[fact(
                &record_id(1),
                "scan",
                &floor.shift,
                checked_scan(7, &instant(10, 0))
            )]
        )
        .await,
        vec![accepted(&record_id(1))]
    );
    let taken = |same_device: bool| {
        json!({
            "status": "taken",
            "owner": {
                "shiftId": floor.shift, "shiftNumber": floor.number, "deviceId": floor.station,
                "scannedAt": instant(10, 0), "sameDevice": same_device
            }
        })
    };
    assert_eq!(
        check_code(&admin, &aggregation.key, 7).await,
        (StatusCode::OK, taken(false))
    );
    assert_eq!(
        check_code(&admin, &floor.key, 7).await,
        (StatusCode::OK, taken(true))
    );
    let later = fact(
        &record_id(2),
        "scan",
        &aggregation.shift,
        ok_scan(7, &box_id(2), &instant(20, 0)),
    );
    assert_eq!(
        receipts(&admin.app, &aggregation.key, &[later]).await,
        vec![json!({
            "id": record_id(2), "outcome": "conflict",
            "details": { "winner": {
                "shiftId": floor.shift, "shiftNumber": floor.number,
                "deviceId": floor.station, "scannedAt": instant(10, 0), "sameDevice": false
            } }
        })]
    );
    assert_eq!(
        conflicts(&admin).await,
        vec![json!([code_hash(7), record_id(1), record_id(2)])]
    );
    assert_eq!(
        owners(&admin).await,
        vec![json!([
            code_hash(7),
            record_id(1),
            floor.shift,
            floor.station,
            null,
            instant(10, 0)
        ])]
    );
    assert_eq!(items(&admin).await, Vec::<Value>::new());
}

/// (в): an earlier validation scan that arrives later takes the code from
/// an aggregation shift's box: the box's item is displaced (the host's
/// instant), the code is the validation scan's without a box, and the
/// conflict names the validation scan as the winner. The aggregation
/// station's undo of that item, sent after, takes nothing out: the item is
/// no longer live, and the code stays the validation scan's.
#[tokio::test]
async fn an_earlier_validation_scan_takes_the_code_out_of_a_box() {
    let (admin, setup, floor) = validation_floor().await;
    let (_, colleague_key) = pair_device(&admin.app, "station").await;
    let aggregation = open_floor(&admin, &setup, &colleague_key, &setup.other_line).await;
    assert_eq!(
        receipts(
            &admin.app,
            &aggregation.key,
            &[fact(
                &record_id(1),
                "scan",
                &aggregation.shift,
                ok_scan(7, &box_id(1), &instant(100, 0))
            )]
        )
        .await,
        vec![accepted(&record_id(1))]
    );
    admin.app.clock.advance(time::Duration::minutes(1));
    let displaced_at = admin.app.state.timestamp();
    assert_eq!(
        receipts(
            &admin.app,
            &floor.key,
            &[fact(
                &record_id(2),
                "scan",
                &floor.shift,
                checked_scan(7, &instant(50, 0))
            )]
        )
        .await,
        vec![accepted(&record_id(2))]
    );
    assert_eq!(
        items(&admin).await,
        vec![json!([
            record_id(1),
            box_id(1),
            code_hash(7),
            null,
            displaced_at
        ])]
    );
    assert_eq!(
        owners(&admin).await,
        vec![json!([
            code_hash(7),
            record_id(2),
            floor.shift,
            floor.station,
            null,
            instant(50, 0)
        ])]
    );
    assert_eq!(
        conflicts(&admin).await,
        vec![json!([code_hash(7), record_id(2), record_id(1)])]
    );
    // The aggregation shift's box holds nothing live now; the validation
    // shift counts the code.
    let totals = |shift: &Value| shift["totals"]["acceptedUnits"].clone();
    assert_eq!(totals(&office_shift(&admin, &aggregation.shift).await), 0);
    assert_eq!(totals(&office_shift(&admin, &floor.shift).await), 1);

    let owners_before = owners(&admin).await;
    let items_before = items(&admin).await;
    let mut undo = box_exception("undo", &box_id(1), &instant(200, 0));
    undo["codeHash"] = json!(code_hash(7));
    undo["targetScannedAt"] = json!(instant(100, 0));
    assert_eq!(
        receipts(
            &admin.app,
            &aggregation.key,
            &[fact(
                &record_id(3),
                "box_exception",
                &aggregation.shift,
                undo
            )]
        )
        .await,
        vec![accepted(&record_id(3))]
    );
    assert_eq!(owners(&admin).await, owners_before);
    assert_eq!(items(&admin).await, items_before);
    assert_eq!(totals(&office_shift(&admin, &floor.shift).await), 1);
}

/// (д): a validation shift has no boxes and no pallets, so every box and
/// pallet fact of it is `invalid_record` on `shift_mode`, whatever its
/// content, before anything of it is read or written; the receipt is kept
/// with its kind and shift, and the same record again gets it again.
#[tokio::test]
async fn box_and_pallet_facts_of_a_validation_shift_are_refused_on_its_mode() {
    let (admin, _, floor) = validation_floor().await;
    let block = issue_block(
        &admin.app,
        &floor.key,
        "0c4a7b2e-9d1f-4e3a-8b5c-6d7e8f9a0b1c",
    )
    .await;
    let mut exception = box_exception("reprint", &box_id(1), &instant(30, 0));
    exception["reasonCode"] = json!("damaged_label");
    let pallet = "a0000000-0000-4000-8000-000000000001";
    let records = [
        (
            "box_closed",
            box_closed(
                &box_id(1),
                &block,
                1500,
                &[1],
                &instant(1, 0),
                &instant(20, 0),
            ),
        ),
        (
            "box_label",
            json!({ "boxId": box_id(1), "outcome": "verified", "at": instant(21, 0) }),
        ),
        ("box_exception", exception),
        (
            "pallet_closed",
            json!({
                "palletId": pallet, "sscc": "146006820000000406", "blockId": block["id"],
                "serial": 40, "openedAt": instant(1, 0), "closedAt": instant(40, 0),
                "boxCount": 1
            }),
        ),
        (
            "pallet_label",
            json!({ "palletId": pallet, "outcome": "skipped", "at": instant(41, 0) }),
        ),
        (
            "pallet_exception",
            json!({
                "exception": "disassemble", "palletId": pallet, "reasonCode": "wrong_quantity",
                "reasonText": null, "occurredAt": instant(42, 0)
            }),
        ),
    ];
    let before = fact_rows(&admin.app).await;
    let batch: Vec<Value> = records
        .iter()
        .enumerate()
        .map(|(n, (kind, data))| fact(&record_id(n as u32 + 1), kind, &floor.shift, data.clone()))
        .collect();
    let refused: Vec<Value> = (1..=records.len() as u32)
        .map(|n| rejected(Some(&record_id(n)), "invalid_record", Some("shift_mode")))
        .collect();
    assert_eq!(receipts(&admin.app, &floor.key, &batch).await, refused);
    let mut expected = before.clone();
    expected["fact_receipts"] =
        json!(before["fact_receipts"].as_u64().unwrap() + records.len() as u64);
    assert_eq!(fact_rows(&admin.app).await, expected);
    let pallets: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pallets")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    assert_eq!(pallets, 0);
    let consumed: Option<i64> =
        sqlx::query_scalar("SELECT consumed_through FROM sscc_blocks WHERE id = ?")
            .bind(block["id"].as_str().unwrap())
            .fetch_one(&admin.app.state.pool)
            .await
            .unwrap();
    assert_eq!(consumed, None);
    let kept: Vec<(String, Option<String>, Option<String>)> =
        sqlx::query_as("SELECT kind, shift_id, details FROM fact_receipts ORDER BY record_id")
            .fetch_all(&admin.app.state.pool)
            .await
            .unwrap();
    let kinds: Vec<(String, Option<String>, Option<String>)> = records
        .iter()
        .map(|(kind, _)| {
            (
                (*kind).to_owned(),
                Some(floor.shift.clone()),
                Some(json!({ "field": "shift_mode" }).to_string()),
            )
        })
        .collect();
    assert_eq!(kept, kinds);
    assert_eq!(receipts(&admin.app, &floor.key, &batch).await, refused);
}

/// A `unit_label` fact (protocol 5, part B of plan РЕЖ) is not taken before
/// task B3 reads it: this host answers it exactly as a kind it does not know
/// (`invalid_record` with no field, the receipt kept without a kind or a
/// shift), whatever the shift, writes nothing else, and gives the same
/// receipt again.
#[tokio::test]
async fn a_unit_label_fact_is_answered_as_a_kind_this_host_does_not_read_yet() {
    let (admin, _, floor) = validation_floor().await;
    let accepted_scan = fact(
        &record_id(1),
        "scan",
        &floor.shift,
        checked_scan(1, &instant(1, 0)),
    );
    assert_eq!(
        receipts(&admin.app, &floor.key, &[accepted_scan]).await,
        [accepted(&record_id(1))]
    );
    let label = |n: u32, shift: &str| {
        fact(
            &record_id(n),
            "unit_label",
            shift,
            json!({
                "jobId": "2e7f4a9c-6b1d-4c3e-9a5f-8d0b1c2e3f4a", "codeHash": code_hash(1),
                "attemptNo": 1, "event": "prepared", "reason": null, "errorCode": null,
                "payloadDigest": code_hash(7), "bytesDigest": code_hash(8),
                "at": instant(2, 0)
            }),
        )
    };
    let unknown_shift = "00000000-0000-4000-8000-00000000ffff";
    let batch = [label(2, &floor.shift), label(3, unknown_shift)];
    let before = fact_rows(&admin.app).await;
    let refused = vec![
        rejected(Some(&record_id(2)), "invalid_record", None),
        rejected(Some(&record_id(3)), "invalid_record", None),
    ];
    assert_eq!(receipts(&admin.app, &floor.key, &batch).await, refused);
    let mut expected = before.clone();
    expected["fact_receipts"] = json!(before["fact_receipts"].as_u64().unwrap() + 2);
    assert_eq!(fact_rows(&admin.app).await, expected);
    let kept: Vec<(String, Option<String>, Option<String>, String)> = sqlx::query_as(
        "SELECT record_id, kind, shift_id, code FROM fact_receipts WHERE record_id <> ? \
         ORDER BY record_id",
    )
    .bind(record_id(1))
    .fetch_all(&admin.app.state.pool)
    .await
    .unwrap();
    assert_eq!(
        kept,
        [
            (record_id(2), None, None, "invalid_record".to_owned()),
            (record_id(3), None, None, "invalid_record".to_owned()),
        ]
    );
    assert_eq!(receipts(&admin.app, &floor.key, &batch).await, refused);
}

/// (е): a station's close of a validation shift counts no boxes: one with
/// `closedBoxCount` other than 0 is `invalid_record` on
/// `data.closedBoxCount` and the shift stays open; with 0 it closes.
#[tokio::test]
async fn a_close_of_a_validation_shift_counts_no_boxes() {
    let (admin, _, floor) = validation_floor().await;
    assert_eq!(
        receipts(
            &admin.app,
            &floor.key,
            &[fact(
                &record_id(1),
                "scan",
                &floor.shift,
                checked_scan(1, &instant(1, 0))
            )]
        )
        .await,
        vec![accepted(&record_id(1))]
    );
    let with_a_box = fact(
        &record_id(2),
        "shift_closed",
        &floor.shift,
        shift_closed(None, 1, 1, None, &instant(60, 0)),
    );
    assert_eq!(
        receipts(&admin.app, &floor.key, &[with_a_box]).await,
        vec![rejected(
            Some(&record_id(2)),
            "invalid_record",
            Some("data.closedBoxCount")
        )]
    );
    assert_eq!(office_shift(&admin, &floor.shift).await["status"], "active");
    let events: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM shift_close_events")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    assert_eq!(events, 0);
    let without = fact(
        &record_id(3),
        "shift_closed",
        &floor.shift,
        shift_closed(None, 1, 0, None, &instant(61, 0)),
    );
    assert_eq!(
        receipts(&admin.app, &floor.key, &[without]).await,
        vec![accepted(&record_id(3))]
    );
    assert_eq!(office_shift(&admin, &floor.shift).await["status"], "closed");
}

/// (з): the totals of a validation shift count the codes it owns, every one
/// without a box, in the list and in one shift's answer alike; it has no
/// boxes and no pallets. A code an earlier scan of another shift took is no
/// longer counted.
#[tokio::test]
async fn the_totals_of_a_validation_shift_count_the_codes_it_owns() {
    let (admin, setup, floor) = validation_floor().await;
    let batch: Vec<Value> = (1..=3)
        .map(|n| {
            fact(
                &record_id(n),
                "scan",
                &floor.shift,
                checked_scan(n, &instant(10 + n, 0)),
            )
        })
        .collect();
    receipts(&admin.app, &floor.key, &batch).await;
    let (_, colleague_key) = pair_device(&admin.app, "station").await;
    let aggregation = open_floor(&admin, &setup, &colleague_key, &setup.other_line).await;
    let earlier = fact(
        &record_id(9),
        "scan",
        &aggregation.shift,
        ok_scan(3, &box_id(1), &instant(1, 0)),
    );
    assert_eq!(
        receipts(&admin.app, &aggregation.key, &[earlier]).await,
        vec![accepted(&record_id(9))]
    );
    // Code 3 is the box scan's now, with its box; a validation owner has no
    // item to displace.
    let validation_owner = |n: u32| {
        json!([
            code_hash(n),
            record_id(n),
            floor.shift,
            floor.station,
            null,
            instant(10 + n, 0)
        ])
    };
    assert_eq!(
        owners(&admin).await,
        vec![
            validation_owner(1),
            validation_owner(2),
            json!([
                code_hash(3),
                record_id(9),
                aggregation.shift,
                aggregation.station,
                box_id(1),
                instant(1, 0)
            ]),
        ]
    );
    assert_eq!(
        items(&admin).await,
        vec![json!([record_id(9), box_id(1), code_hash(3), null, null])]
    );
    let shift = office_shift(&admin, &floor.shift).await;
    assert_eq!(
        shift["totals"],
        json!({
            "acceptedUnits": 2, "unitsInClosedBoxes": 0, "closedBoxes": 0, "openBoxes": 0,
            "lastFactAt": shift["totals"]["lastFactAt"], "deviceIds": [floor.station],
            "closedPallets": 0, "openPallets": 0
        })
    );
    let (status, list) = admin.call("GET", "/v1/office/shifts", None).await;
    assert_eq!(status, StatusCode::OK, "{list}");
    let listed = list
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["id"] == floor.shift.as_str())
        .unwrap();
    assert_eq!(listed["totals"], shift["totals"]);
    // The aggregation shift counts its box's item, not owners without a box.
    assert_eq!(
        office_shift(&admin, &aggregation.shift).await["totals"]["acceptedUnits"],
        1
    );
}

/// (и): the export source of a validation shift lists the codes the shift
/// owns, with their owning scans' canonical text, by their scan instant and
/// then their hash (the order the office's port sorts them in), and no box,
/// item or pallet.
#[tokio::test]
async fn the_export_source_of_a_validation_shift_lists_its_codes_without_boxes() {
    let (admin, _, floor) = validation_floor().await;
    let batch = [
        fact(
            &record_id(1),
            "scan",
            &floor.shift,
            checked_scan(5, &instant(20, 0)),
        ),
        fact(
            &record_id(2),
            "scan",
            &floor.shift,
            checked_scan(4, &instant(10, 0)),
        ),
        fact(
            &record_id(3),
            "scan",
            &floor.shift,
            checked_scan(6, &instant(10, 0)),
        ),
        fact(
            &record_id(4),
            "shift_closed",
            &floor.shift,
            shift_closed(None, 3, 0, None, &instant(30, 0)),
        ),
    ];
    receipts(&admin.app, &floor.key, &batch).await;
    let (status, source) = admin
        .call(
            "GET",
            &format!("/v1/office/shifts/{}/export-source", floor.shift),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{source}");
    let owned = |n: u32, at: &str| json!({ "codeHash": code_hash(n), "scannedAt": at, "canonical": code(n)["canonical"] });
    assert_eq!(
        source["codes"],
        json!([
            owned(4, &instant(10, 0)),
            owned(6, &instant(10, 0)),
            owned(5, &instant(20, 0))
        ])
    );
    for list in ["boxes", "items", "pallets"] {
        assert_eq!(source[list], json!([]), "{list}");
    }
    assert_eq!(source["shift"]["status"], "closed");
    assert_eq!(source["shift"]["palletsEnabled"], false);
    assert_eq!(source["shift"]["stationClosedAt"], instant(30, 0));
}

/// A unit a validation shift accepted is found for a warehouse reprint as
/// any unit is: its label is the unit's own code, which needs no box.
#[tokio::test]
async fn a_unit_of_a_validation_shift_is_found_for_a_warehouse_reprint() {
    let (admin, _, floor) = validation_floor().await;
    receipts(
        &admin.app,
        &floor.key,
        &[fact(
            &record_id(1),
            "scan",
            &floor.shift,
            checked_scan(1, &instant(1, 0)),
        )],
    )
    .await;
    let (_, asking) = pair_device(&admin.app, "station").await;
    let (status, body) = admin
        .app
        .send(support::app::json(
            support::app::with_device(
                support::app::request("POST", "/v1/device/warehouse/lookup"),
                &asking,
            ),
            json!({ "codeHash": code_hash(1) }),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["status"], "found");
    let source = &body["source"];
    assert_eq!(source["kind"], "unit");
    assert_eq!(source["canonical"], code(1)["canonical"]);
    assert_eq!(source["shiftId"], floor.shift);
    assert_eq!(source["itemCount"], 1);
}

/// (ж2): the code search finds the accepted scans of a validation shift,
/// which put their codes into no box: one that owns its code is `checked`,
/// one an earlier scan of another shift took is `displaced` (the host's
/// instant, from the conflict) with no box either; a validation scan that
/// lost its code on arrival is no placement, as an aggregation scan that
/// lost it is not. The card tells the same.
#[tokio::test]
async fn the_code_search_finds_the_accepted_scans_of_a_validation_shift() {
    let (admin, setup, floor) = validation_floor().await;
    let (_, colleague_key) = pair_device(&admin.app, "station").await;
    let aggregation = open_floor(&admin, &setup, &colleague_key, &setup.other_line).await;
    let checked = |n: u32, code: u32, second: u32| {
        fact(
            &record_id(n),
            "scan",
            &floor.shift,
            checked_scan(code, &instant(second, 0)),
        )
    };
    let boxed = |n: u32, code: u32, second: u32| {
        fact(
            &record_id(n),
            "scan",
            &aggregation.shift,
            ok_scan(code, &box_id(1), &instant(second, 0)),
        )
    };
    let outcomes = |answered: Vec<Value>| -> Vec<String> {
        answered
            .iter()
            .map(|receipt| receipt["outcome"].as_str().unwrap().to_owned())
            .collect()
    };
    assert_eq!(
        outcomes(
            receipts(
                &admin.app,
                &floor.key,
                &[checked(1, 1, 10), checked(2, 2, 20)]
            )
            .await
        ),
        ["accepted", "accepted"]
    );
    admin.app.clock.advance(time::Duration::minutes(1));
    let displaced_at = admin.app.state.timestamp();
    // An earlier scan of code 2 takes it; a later one of code 1 loses.
    assert_eq!(
        outcomes(
            receipts(
                &admin.app,
                &aggregation.key,
                &[boxed(3, 2, 5), boxed(4, 1, 40)]
            )
            .await
        ),
        ["accepted", "conflict"]
    );
    // The validation shift's own later scan of code 1 loses it too.
    assert_eq!(
        outcomes(receipts(&admin.app, &floor.key, &[checked(5, 1, 50)]).await),
        ["conflict"]
    );

    let search = |query: String| {
        let admin = &admin;
        async move {
            let (status, page) = admin
                .call("GET", &format!("/v1/office/codes?{query}"), None)
                .await;
            assert_eq!(status, StatusCode::OK, "{query}: {page}");
            page
        }
    };
    let rows = |page: &Value| -> Vec<(String, String, String, Value, Value)> {
        page["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| {
                (
                    item["codeHash"].as_str().unwrap().to_owned(),
                    item["scannedAt"].as_str().unwrap().to_owned(),
                    item["state"].as_str().unwrap().to_owned(),
                    item["boxId"].clone(),
                    item["leftAt"].clone(),
                )
            })
            .collect()
    };
    let page = search(format!("codeHash={}", code_hash(1))).await;
    assert_eq!(
        rows(&page),
        [(
            code_hash(1),
            instant(10, 0),
            "checked".to_owned(),
            Value::Null,
            Value::Null
        )]
    );
    let item = &page["items"][0];
    for field in [
        "boxSscc",
        "boxClosedAt",
        "boxDisassembledAt",
        "palletId",
        "palletSscc",
    ] {
        assert_eq!(item[field], Value::Null, "{field}");
    }
    assert_eq!(
        (&item["shiftId"], &item["shiftNumber"], &item["deviceId"]),
        (
            &json!(floor.shift),
            &json!(floor.number),
            &json!(floor.station)
        )
    );
    let code_2 = vec![
        (
            code_hash(2),
            instant(20, 0),
            "displaced".to_owned(),
            Value::Null,
            json!(displaced_at),
        ),
        (
            code_hash(2),
            instant(5, 0),
            "open_box".to_owned(),
            json!(box_id(1)),
            Value::Null,
        ),
    ];
    assert_eq!(
        rows(&search(format!("codeHash={}", code_hash(2))).await),
        code_2
    );
    let shift_page = search(format!("shift={}", floor.number)).await;
    assert_eq!(
        rows(&shift_page),
        [
            code_2[0].clone(),
            (
                code_hash(1),
                instant(10, 0),
                "checked".to_owned(),
                Value::Null,
                Value::Null
            )
        ]
    );
    assert_eq!(shift_page["total"], 2);
    for query in ["gtin=04600682000013".to_owned(), "fromMs=0".to_owned()] {
        let page = search(query.clone()).await;
        assert_eq!(page["total"], 3, "{query}: {page}");
    }

    let card = |n: u32| {
        let admin = &admin;
        async move {
            let (status, card) = admin
                .call("GET", &format!("/v1/office/codes/{}", code_hash(n)), None)
                .await;
            assert_eq!(status, StatusCode::OK, "{card}");
            card
        }
    };
    let first = card(1).await;
    assert_eq!(first["ownerScanId"], first["placements"][0]["scanId"]);
    assert_eq!(first["placements"].as_array().unwrap().len(), 1);
    let scans: Vec<(Value, Value, Value)> = first["events"]
        .as_array()
        .unwrap()
        .iter()
        .map(|event| {
            assert_eq!(event["type"], "scan", "{event}");
            (
                event["at"].clone(),
                event["boxId"].clone(),
                event["placed"].clone(),
            )
        })
        .collect();
    assert_eq!(
        scans,
        [
            (json!(instant(10, 0)), Value::Null, json!(true)),
            (json!(instant(40, 0)), json!(box_id(1)), json!(false)),
            (json!(instant(50, 0)), Value::Null, json!(false)),
        ]
    );
    let second = card(2).await;
    let displaced: Vec<&Value> = second["events"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|event| event["type"] == "displaced")
        .collect();
    assert_eq!(
        displaced,
        [&json!({ "type": "displaced", "at": displaced_at, "boxId": null, "boxSscc": null })]
    );
    let placed: Vec<(Value, Value)> = second["events"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|event| event["type"] == "scan")
        .map(|event| (event["at"].clone(), event["placed"].clone()))
        .collect();
    assert_eq!(
        placed,
        [
            (json!(instant(5, 0)), json!(true)),
            (json!(instant(20, 0)), json!(true))
        ]
    );
}
