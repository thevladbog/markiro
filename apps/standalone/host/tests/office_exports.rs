mod support;

use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{
    admin, box_closed, box_exception, box_id, close_from_office, code, code_hash, empty, fact,
    instant, issue_block, issue_pallet_block, ok_scan, open_floor, open_pallet_floor, pair_device,
    pallet_closed, pallet_id, pallet_sscc, receipts, record_id, request, shift_closed, shift_setup,
    sscc, with_device, Admin, Floor, ShiftSetup,
};

const BLOCK_REQUEST: &str = "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a";
const SHIFT_REQUEST: &str = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const PALLET_REQUEST: &str = "5e4d3c2b-1a09-4f8e-9d7c-6b5a4f3e2d1c";
const COLLEAGUE_BLOCK_REQUEST: &str = "7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d";
const COLLEAGUE_PALLET_REQUEST: &str = "9b8a7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d";

/// Send `records` from `floor`'s station; every one must be accepted.
async fn accept(admin: &Admin, floor: &Floor, records: &[Value]) {
    let answered = receipts(&admin.app, &floor.key, records).await;
    assert!(
        answered.iter().all(|r| r["outcome"] == "accepted"),
        "{answered:?}"
    );
}

/// `GET /v1/office/shifts/{shift}/export-source` as the administrator.
async fn export_source(admin: &Admin, shift: &str) -> (StatusCode, Value) {
    admin
        .call(
            "GET",
            &format!("/v1/office/shifts/{shift}/export-source"),
            None,
        )
        .await
}

/// Code `n` as the export source lists it.
fn owned(n: u32, scanned_at: &str) -> Value {
    json!({
        "codeHash": code_hash(n),
        "scannedAt": scanned_at,
        "canonical": code(n)["canonical"],
    })
}

/// A shift with pallets after a day's facts: boxes 1 (codes 1 and 2, on
/// pallet 1) and 2 (code 3, on no pallet) closed, box 3 open with code 4,
/// code 5 scanned into box 1 and taken out again, pallet 1 closed, and the
/// station's close. A colleague's shift with pallets on the other line has
/// a code, a box and a pallet of its own. The export source names exactly
/// the shift's own rows: the codes it owns with their owning scans'
/// canonical text, every box, the live items only and every pallet, with
/// the host's close in whole seconds beside the station's own instant.
#[tokio::test]
async fn the_export_source_of_a_closed_shift_names_its_own_codes_boxes_live_items_and_pallets() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_pallet_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let block = issue_block(&admin.app, &floor.key, BLOCK_REQUEST).await;
    let pallets = issue_pallet_block(&admin.app, &floor.key, PALLET_REQUEST).await;
    let shift = floor.shift.clone();
    let mut undo = box_exception("undo", &box_id(1), &instant(12, 0));
    undo["codeHash"] = json!(code_hash(5));
    undo["targetScannedAt"] = json!(instant(11, 0));
    let mut first_box = box_closed(
        &box_id(1),
        &block,
        1500,
        &[1, 2],
        &instant(10, 500),
        &instant(20, 0),
    );
    first_box["palletId"] = json!(pallet_id(1));
    accept(
        &admin,
        &floor,
        &[
            fact(
                &record_id(1),
                "scan",
                &shift,
                ok_scan(2, &box_id(1), &instant(10, 500)),
            ),
            fact(
                &record_id(2),
                "scan",
                &shift,
                ok_scan(1, &box_id(1), &instant(10, 500)),
            ),
            fact(
                &record_id(3),
                "scan",
                &shift,
                ok_scan(5, &box_id(1), &instant(11, 0)),
            ),
            fact(&record_id(4), "box_exception", &shift, undo),
            fact(&record_id(5), "box_closed", &shift, first_box),
            fact(
                &record_id(6),
                "scan",
                &shift,
                ok_scan(3, &box_id(2), &instant(30, 0)),
            ),
            fact(
                &record_id(7),
                "box_closed",
                &shift,
                box_closed(
                    &box_id(2),
                    &block,
                    1501,
                    &[3],
                    &instant(30, 0),
                    &instant(40, 0),
                ),
            ),
            fact(
                &record_id(8),
                "scan",
                &shift,
                ok_scan(4, &box_id(3), &instant(50, 0)),
            ),
            fact(
                &record_id(9),
                "pallet_closed",
                &shift,
                pallet_closed(
                    &pallet_id(1),
                    &pallets,
                    40,
                    1,
                    &instant(20, 0),
                    &instant(60, 250),
                ),
            ),
        ],
    )
    .await;
    // The colleague's shift: its code, box and pallet are its own.
    let (_, colleague_key) = pair_device(&admin.app, "station").await;
    let colleague = open_pallet_floor(&admin, &setup, &colleague_key, &setup.other_line).await;
    let colleague_block = issue_block(&admin.app, &colleague.key, COLLEAGUE_BLOCK_REQUEST).await;
    let colleague_pallets =
        issue_pallet_block(&admin.app, &colleague.key, COLLEAGUE_PALLET_REQUEST).await;
    let mut their_box = box_closed(
        &box_id(11),
        &colleague_block,
        3500,
        &[7],
        &instant(5, 0),
        &instant(6, 0),
    );
    their_box["palletId"] = json!(pallet_id(11));
    accept(
        &admin,
        &colleague,
        &[
            fact(
                &record_id(1),
                "scan",
                &colleague.shift,
                ok_scan(7, &box_id(11), &instant(5, 0)),
            ),
            fact(&record_id(2), "box_closed", &colleague.shift, their_box),
            fact(
                &record_id(3),
                "pallet_closed",
                &colleague.shift,
                pallet_closed(
                    &pallet_id(11),
                    &colleague_pallets,
                    240,
                    1,
                    &instant(6, 0),
                    &instant(7, 0),
                ),
            ),
        ],
    )
    .await;
    accept(
        &admin,
        &floor,
        &[fact(
            &record_id(10),
            "shift_closed",
            &shift,
            shift_closed(None, 4, 2, None, &instant(70, 412)),
        )],
    )
    .await;

    let (status, source) = export_source(&admin, &shift).await;
    assert_eq!(status, StatusCode::OK, "{source}");
    assert_eq!(
        source,
        json!({
            "shift": {
                "id": shift,
                "number": floor.number,
                "status": "closed",
                "productionDate": "2026-10-08",
                "productName": "Молоко 3,2% 0,9 л",
                "palletsEnabled": true,
                "closedAt": "2026-10-08T06:01:10Z",
                "stationClosedAt": instant(70, 412),
                "lateDataAt": null,
            },
            "organization": { "name": "ООО «Атолл»", "inn": "7701234567" },
            // One instant for codes 1 and 2: the hash orders them.
            "codes": [
                owned(1, &instant(10, 500)),
                owned(2, &instant(10, 500)),
                owned(3, &instant(30, 0)),
                owned(4, &instant(50, 0)),
            ],
            "boxes": [
                {
                    "id": box_id(1), "sscc": sscc(1500), "openedAt": instant(10, 500),
                    "closedAt": instant(20, 0), "disassembledAt": null, "palletId": pallet_id(1),
                },
                {
                    "id": box_id(2), "sscc": sscc(1501), "openedAt": instant(30, 0),
                    "closedAt": instant(40, 0), "disassembledAt": null, "palletId": null,
                },
                {
                    "id": box_id(3), "sscc": null, "openedAt": instant(50, 0),
                    "closedAt": null, "disassembledAt": null, "palletId": null,
                },
            ],
            "items": [
                { "boxId": box_id(1), "codeHash": code_hash(1) },
                { "boxId": box_id(1), "codeHash": code_hash(2) },
                { "boxId": box_id(2), "codeHash": code_hash(3) },
                { "boxId": box_id(3), "codeHash": code_hash(4) },
            ],
            "pallets": [{
                "id": pallet_id(1), "sscc": pallet_sscc(40), "openedAt": instant(20, 0),
                "closedAt": instant(60, 250), "disassembledAt": null,
            }],
        })
    );
    // The colleague's source names only the colleague's rows.
    let (status, theirs) = export_source(&admin, &colleague.shift).await;
    assert_eq!(status, StatusCode::OK, "{theirs}");
    assert_eq!(theirs["codes"], json!([owned(7, &instant(5, 0))]));
    assert_eq!(
        theirs["items"],
        json!([{ "boxId": box_id(11), "codeHash": code_hash(7) }])
    );
    assert_eq!(theirs["boxes"].as_array().map(Vec::len), Some(1));
    assert_eq!(theirs["pallets"][0]["id"], json!(pallet_id(11)));
    assert_eq!(theirs["pallets"].as_array().map(Vec::len), Some(1));
    assert_eq!(theirs["shift"]["status"], "active");
    assert_eq!(theirs["shift"]["closedAt"], Value::Null);
    assert_eq!(theirs["shift"]["stationClosedAt"], Value::Null);
}

/// A code an earlier scan on another line took leaves the shift's codes and
/// its box's live items, though the box stays closed; a box taken apart
/// stays listed, its items gone. A shift the office closed has no station
/// close: `stationClosedAt` is `null` and `closedAt` is the office's.
#[tokio::test]
async fn displaced_and_disassembled_items_leave_the_source_and_an_office_close_has_no_station_instant(
) {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let block = issue_block(&admin.app, &floor.key, BLOCK_REQUEST).await;
    let shift = floor.shift.clone();
    let mut disassemble = box_exception("disassemble", &box_id(2), &instant(40, 0));
    disassemble["reasonCode"] = json!("other");
    disassemble["reasonText"] = json!("Помятый короб");
    accept(
        &admin,
        &floor,
        &[
            fact(
                &record_id(1),
                "scan",
                &shift,
                ok_scan(1, &box_id(1), &instant(10, 0)),
            ),
            fact(
                &record_id(2),
                "box_closed",
                &shift,
                box_closed(
                    &box_id(1),
                    &block,
                    1500,
                    &[1],
                    &instant(10, 0),
                    &instant(20, 0),
                ),
            ),
            fact(
                &record_id(3),
                "scan",
                &shift,
                ok_scan(2, &box_id(2), &instant(25, 0)),
            ),
            fact(
                &record_id(4),
                "box_closed",
                &shift,
                box_closed(
                    &box_id(2),
                    &block,
                    1501,
                    &[2],
                    &instant(25, 0),
                    &instant(30, 0),
                ),
            ),
            fact(&record_id(5), "box_exception", &shift, disassemble),
        ],
    )
    .await;
    let (_, colleague_key) = pair_device(&admin.app, "station").await;
    let colleague = open_floor(&admin, &setup, &colleague_key, &setup.other_line).await;
    // An earlier scan of code 1 on the colleague's line takes it.
    accept(
        &admin,
        &colleague,
        &[fact(
            &record_id(1),
            "scan",
            &colleague.shift,
            ok_scan(1, &box_id(11), &instant(5, 0)),
        )],
    )
    .await;
    let closed = close_from_office(&admin, &shift, "Станция не отвечает").await;
    // The station's own close after the office's is `already_closed`, never
    // the shift's close; its label check arrives late and marks the shift.
    accept(
        &admin,
        &floor,
        &[
            fact(
                &record_id(6),
                "shift_closed",
                &shift,
                shift_closed(None, 1, 1, None, &instant(90, 0)),
            ),
            fact(
                &record_id(7),
                "box_label",
                &shift,
                json!({ "boxId": box_id(1), "outcome": "verified", "at": instant(91, 0) }),
            ),
        ],
    )
    .await;
    // The product renamed after the close: the source names it as it is now,
    // as the cloud's export joins the product.
    let (status, product) = admin.call("GET", "/v1/office/products", None).await;
    assert_eq!(status, StatusCode::OK, "{product}");
    let mut renamed = product[0].clone();
    for field in ["id", "status", "rev", "photoChecksum"] {
        renamed.as_object_mut().unwrap().remove(field);
    }
    renamed["name"] = json!("Молоко 2,5% 0,9 л");
    renamed["expectedRev"] = product[0]["rev"].clone();
    let (status, body) = admin
        .call(
            "PUT",
            &format!("/v1/office/products/{}", setup.product),
            Some(renamed),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, office) = admin
        .call("GET", &format!("/v1/office/shifts/{shift}"), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{office}");
    assert!(office["lateDataAt"].is_string(), "{office}");

    let (status, source) = export_source(&admin, &shift).await;
    assert_eq!(status, StatusCode::OK, "{source}");
    assert_eq!(source["codes"], json!([]));
    assert_eq!(source["items"], json!([]));
    assert_eq!(
        source["boxes"],
        json!([
            {
                "id": box_id(1), "sscc": sscc(1500), "openedAt": instant(10, 0),
                "closedAt": instant(20, 0), "disassembledAt": null, "palletId": null,
            },
            {
                "id": box_id(2), "sscc": sscc(1501), "openedAt": instant(25, 0),
                "closedAt": instant(30, 0), "disassembledAt": instant(40, 0), "palletId": null,
            },
        ])
    );
    assert_eq!(source["shift"]["status"], "closed");
    assert_eq!(source["shift"]["closedAt"], closed["closedAt"]);
    assert_eq!(source["shift"]["stationClosedAt"], Value::Null);
    assert_eq!(source["shift"]["lateDataAt"], office["lateDataAt"]);
    assert_eq!(source["shift"]["productName"], "Молоко 2,5% 0,9 л");
    assert_eq!(source["shift"]["palletsEnabled"], false);
    assert_eq!(source["pallets"], json!([]));
    // The code now belongs to the colleague's shift, with its own scan.
    let (_, theirs) = export_source(&admin, &colleague.shift).await;
    assert_eq!(theirs["codes"], json!([owned(1, &instant(5, 0))]));
}

/// Every office role reads the source; an unknown shift is `not_found`; a
/// planned shift answers with empty lists; the device key alone is no
/// office session.
#[tokio::test]
async fn every_office_role_reads_the_source_and_an_unknown_shift_is_not_found() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let planned = support::app::plan_shift(&admin, support::app::shift_body(&setup)).await;
    let id = planned["id"].as_str().unwrap();
    let path = format!("/v1/office/shifts/{id}/export-source");
    let technologist = admin.technologist().await;
    let (status, source) = admin.call_as(&technologist, "GET", &path, None).await;
    assert_eq!(status, StatusCode::OK, "{source}");
    assert_eq!(source["shift"]["status"], "planned");
    assert_eq!(source["shift"]["number"], planned["number"]);
    for list in ["codes", "boxes", "items", "pallets"] {
        assert_eq!(source[list], json!([]), "{list}");
    }
    let (status, body) = export_source(&admin, "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b").await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    assert_eq!(body["error"]["code"], "not_found");
    let (status, body) = admin
        .app
        .send(empty(with_device(request("GET", &path), &admin.key)))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
    assert_eq!(body["error"]["details"]["credential"], "session");
}

/// Each query of the source searches by an index: none reads through every
/// scan, owner, box, item, pallet or close of the host, so a year of facts
/// costs the export of one shift nothing (the 366-day lesson of plan 2a3).
#[tokio::test]
async fn every_query_of_the_source_searches_by_an_index() {
    let admin = admin().await;
    for (name, sql) in [
        ("shift", markiro_host::routes::office_exports::SHIFT_SQL),
        ("codes", markiro_host::routes::office_exports::CODES_SQL),
        ("boxes", markiro_host::routes::office_exports::BOXES_SQL),
        ("items", markiro_host::routes::office_exports::ITEMS_SQL),
        ("pallets", markiro_host::routes::office_exports::PALLETS_SQL),
    ] {
        let plan: Vec<(i64, i64, i64, String)> =
            sqlx::query_as(&format!("EXPLAIN QUERY PLAN {sql}"))
                .bind("0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b")
                .fetch_all(&admin.app.state.pool)
                .await
                .unwrap();
        let steps: Vec<&str> = plan.iter().map(|(_, _, _, step)| step.as_str()).collect();
        assert!(
            steps.iter().all(|step| !step.starts_with("SCAN")),
            "{name}: {steps:?}"
        );
        assert!(
            steps.iter().any(|step| step.starts_with("SEARCH")),
            "{name}: {steps:?}"
        );
    }
}

const DOCUMENT: &str = "5d6e7f80-9a1b-4c2d-8e3f-4a5b6c7d8e9f";

/// A record of `format` with no pallet, one part and the counts 3, 2, 1.
fn record_of(format: &str, version: u32) -> Value {
    json!({
        "formatId": format, "formatVersion": version, "maxLines": null, "palletId": null,
        "documentId": DOCUMENT, "partCount": 1, "codeCount": 3, "boxCount": 2,
        "palletCount": 1, "openPalletSuppressedBoxCount": 0,
    })
}

/// A shift with pallets after one box (code 1) on pallet 1, which closed;
/// pallet 2 holds box 2 and stays open. The shift stays active.
async fn pallet_shift(admin: &Admin) -> (ShiftSetup, Floor) {
    let setup = shift_setup(admin).await;
    let floor = open_pallet_floor(admin, &setup, &admin.key.clone(), &setup.line).await;
    let block = issue_block(&admin.app, &floor.key, BLOCK_REQUEST).await;
    let pallets = issue_pallet_block(&admin.app, &floor.key, PALLET_REQUEST).await;
    let shift = floor.shift.clone();
    let mut first = box_closed(
        &box_id(1),
        &block,
        1500,
        &[1],
        &instant(10, 0),
        &instant(11, 0),
    );
    first["palletId"] = json!(pallet_id(1));
    let mut second = box_closed(
        &box_id(2),
        &block,
        1501,
        &[2],
        &instant(20, 0),
        &instant(21, 0),
    );
    second["palletId"] = json!(pallet_id(2));
    accept(
        admin,
        &floor,
        &[
            fact(
                &record_id(1),
                "scan",
                &shift,
                ok_scan(1, &box_id(1), &instant(10, 0)),
            ),
            fact(&record_id(2), "box_closed", &shift, first),
            fact(
                &record_id(3),
                "pallet_closed",
                &shift,
                pallet_closed(
                    &pallet_id(1),
                    &pallets,
                    40,
                    1,
                    &instant(11, 0),
                    &instant(12, 0),
                ),
            ),
            fact(
                &record_id(4),
                "scan",
                &shift,
                ok_scan(2, &box_id(2), &instant(20, 0)),
            ),
            fact(&record_id(5), "box_closed", &shift, second),
        ],
    )
    .await;
    (setup, floor)
}

/// The station's close of `floor`'s shift.
async fn close_by_station(admin: &Admin, floor: &Floor) {
    accept(
        admin,
        floor,
        &[fact(
            &record_id(6),
            "shift_closed",
            &floor.shift,
            shift_closed(None, 2, 2, None, &instant(30, 0)),
        )],
    )
    .await;
}

async fn record_export(
    admin: &Admin,
    token: &str,
    shift: &str,
    record: Value,
) -> (StatusCode, Value) {
    admin
        .call_as(
            token,
            "POST",
            &format!("/v1/office/shifts/{shift}/exports"),
            Some(record),
        )
        .await
}

/// An export of a closed shift writes one `shift.export` row, by whichever
/// office user saved it, with exactly what the record says; a pallet's
/// export of a pallet of an active shift writes one too. Neither takes a
/// revision: nothing a station or a list reads changed.
#[tokio::test]
async fn an_export_writes_one_audit_row_with_what_it_wrote() {
    let admin = admin().await;
    let (_, floor) = pallet_shift(&admin).await;
    let shift = floor.shift.clone();
    // A pallet's export while the shift is still active.
    let revision = support::app::host_revision(&admin.app).await;
    let mut of_pallet = record_of("pallet_xml_gismt_aggregation", 1);
    of_pallet["palletId"] = json!(pallet_id(1));
    of_pallet["codeCount"] = json!(0);
    of_pallet["boxCount"] = json!(1);
    let (status, body) = record_export(&admin, &admin.token, &shift, of_pallet).await;
    assert_eq!((status, &body), (StatusCode::NO_CONTENT, &Value::Null));
    assert_eq!(support::app::host_revision(&admin.app).await, revision);
    close_by_station(&admin, &floor).await;
    let technologist = admin.technologist_session().await;
    let revision_after_close = support::app::host_revision(&admin.app).await;
    let mut of_shift = record_of("shift_xml_gismt_aggregation_pallets", 1);
    of_shift["maxLines"] = json!(2);
    of_shift["partCount"] = json!(3);
    of_shift["openPalletSuppressedBoxCount"] = json!(1);
    let (status, _) = record_export(&admin, &technologist.0, &shift, of_shift).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(
        support::app::host_revision(&admin.app).await,
        revision_after_close
    );
    assert_eq!(
        support::app::audit_trail(&admin.app, "shift.export").await,
        vec![
            admin.row(
                "shift.export",
                "shift",
                &shift,
                json!({
                    "formatId": "pallet_xml_gismt_aggregation", "formatVersion": 1,
                    "maxLines": null, "palletId": pallet_id(1), "documentId": DOCUMENT,
                    "partCount": 1, "codeCount": 0, "boxCount": 1, "palletCount": 1,
                    "openPalletSuppressedBoxCount": 0,
                })
            ),
            support::app::audit_row(
                &technologist.1,
                "shift.export",
                "shift",
                &shift,
                json!({
                    "formatId": "shift_xml_gismt_aggregation_pallets", "formatVersion": 1,
                    "maxLines": 2, "palletId": null, "documentId": DOCUMENT,
                    "partCount": 3, "codeCount": 3, "boxCount": 2, "palletCount": 1,
                    "openPalletSuppressedBoxCount": 1,
                })
            ),
        ]
    );
}

/// What the host refuses changes nothing and writes no row: a format the
/// domain does not advertise (a retired version too), a pallet named or
/// missing against the format, `maxLines` outside 2–1 000 000 or on a
/// pallet, a `documentId` that is no UUID, no part or a pallet in two
/// parts, an unknown shift, a shift's export of a shift not closed, a pallet
/// of another shift. Both ends of `maxLines` are taken.
#[tokio::test]
async fn a_refused_record_writes_no_row_and_the_bounds_of_max_lines_are_taken() {
    let admin = admin().await;
    let (setup, floor) = pallet_shift(&admin).await;
    let shift = floor.shift.clone();
    let token = admin.token.clone();
    let field = |body: &Value| body["error"]["details"]["field"].clone();
    // The shift is still active: a shift's export is refused.
    let (status, body) =
        record_export(&admin, &token, &shift, record_of("shift_txt_pallets", 1)).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"]["details"]["status"], "active");
    close_by_station(&admin, &floor).await;
    // The station's next shift has a pallet of its own: pallet 3.
    let next = open_pallet_floor(&admin, &setup, &floor.key, &setup.line).await;
    let block = issue_block(&admin.app, &next.key, BLOCK_REQUEST).await;
    let mut on_three = box_closed(
        &box_id(3),
        &block,
        1502,
        &[3],
        &instant(40, 0),
        &instant(41, 0),
    );
    on_three["palletId"] = json!(pallet_id(3));
    accept(
        &admin,
        &next,
        &[
            fact(
                &record_id(7),
                "scan",
                &next.shift,
                ok_scan(3, &box_id(3), &instant(40, 0)),
            ),
            fact(&record_id(8), "box_closed", &next.shift, on_three),
        ],
    )
    .await;
    let mut cases: Vec<(Value, &str)> = Vec::new();
    cases.push((record_of("shift_pdf_flat", 1), "formatId"));
    cases.push((record_of("shift_txt_boxes", 1), "formatId"));
    cases.push((record_of("pallet_xml_gismt_aggregation", 1), "palletId"));
    let mut named = record_of("shift_txt_flat", 1);
    named["palletId"] = json!(pallet_id(1));
    cases.push((named, "palletId"));
    for lines in [1, 1_000_001] {
        let mut wrong = record_of("shift_txt_flat", 1);
        wrong["maxLines"] = json!(lines);
        cases.push((wrong, "maxLines"));
    }
    let mut pallet_lines = record_of("pallet_xml_gismt_aggregation", 1);
    pallet_lines["palletId"] = json!(pallet_id(1));
    pallet_lines["maxLines"] = json!(2000);
    cases.push((pallet_lines, "maxLines"));
    let mut document = record_of("shift_txt_flat", 1);
    document["documentId"] = json!("SEP26-003");
    cases.push((document, "documentId"));
    let mut no_part = record_of("shift_txt_flat", 1);
    no_part["partCount"] = json!(0);
    cases.push((no_part, "partCount"));
    let mut two_parts = record_of("pallet_xml_gismt_aggregation", 1);
    two_parts["palletId"] = json!(pallet_id(1));
    two_parts["partCount"] = json!(2);
    cases.push((two_parts, "partCount"));
    let mut unknown = record_of("pallet_xml_gismt_aggregation", 1);
    unknown["palletId"] = json!(pallet_id(99));
    cases.push((unknown, "palletId"));
    let mut foreign = record_of("pallet_xml_gismt_aggregation", 1);
    foreign["palletId"] = json!(pallet_id(3));
    cases.push((foreign, "palletId"));
    for (record, expected) in cases {
        let (status, body) = record_export(&admin, &token, &shift, record.clone()).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{record} {body}");
        assert_eq!(body["error"]["code"], "validation_failed", "{record}");
        assert_eq!(field(&body), json!(expected), "{record}");
    }
    let (status, body) = record_export(
        &admin,
        &token,
        "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
        record_of("shift_txt_flat", 1),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    assert_eq!(
        support::app::audit_trail(&admin.app, "shift.export").await,
        vec![]
    );
    for lines in [2, 1_000_000] {
        let mut taken = record_of("shift_txt_flat", 1);
        taken["maxLines"] = json!(lines);
        let (status, body) = record_export(&admin, &token, &shift, taken).await;
        assert_eq!(status, StatusCode::NO_CONTENT, "{lines} {body}");
    }
    assert_eq!(
        support::app::audit_trail(&admin.app, "shift.export")
            .await
            .len(),
        2
    );
}

/// Every format of the host's lists is recorded at its own version and at no
/// other (the retired `shift_txt_boxes@1` among them): the version is part of
/// the format, not decoration.
#[tokio::test]
async fn every_format_is_recorded_at_its_own_version_and_at_no_other() {
    let admin = admin().await;
    let (_, floor) = pallet_shift(&admin).await;
    close_by_station(&admin, &floor).await;
    let shift = floor.shift.clone();
    let mut taken = 0;
    for (id, version) in markiro_host::routes::office_exports::SHIFT_FORMATS {
        for other in [0, version + 1, version + 2] {
            let (status, body) =
                record_export(&admin, &admin.token, &shift, record_of(id, other)).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{id}@{other} {body}");
            assert_eq!(
                body["error"]["details"]["field"], "formatId",
                "{id}@{other}"
            );
        }
        let (status, body) =
            record_export(&admin, &admin.token, &shift, record_of(id, version)).await;
        assert_eq!(status, StatusCode::NO_CONTENT, "{id}@{version} {body}");
        taken += 1;
    }
    for (id, version) in markiro_host::routes::office_exports::PALLET_FORMATS {
        for other in [0, version + 1] {
            let mut wrong = record_of(id, other);
            wrong["palletId"] = json!(pallet_id(1));
            let (status, body) = record_export(&admin, &admin.token, &shift, wrong).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{id}@{other} {body}");
            assert_eq!(
                body["error"]["details"]["field"], "formatId",
                "{id}@{other}"
            );
        }
        let mut right = record_of(id, version);
        right["palletId"] = json!(pallet_id(1));
        let (status, body) = record_export(&admin, &admin.token, &shift, right).await;
        assert_eq!(status, StatusCode::NO_CONTENT, "{id}@{version} {body}");
        taken += 1;
    }
    let rows = support::app::audit_trail(&admin.app, "shift.export").await;
    assert_eq!(rows.len(), taken);
    assert_eq!(taken, 12);
}

/// The reversed TXT boxes format (`shift_txt_boxes_reversed`, the cloud's
/// #681) is named by its own id at its own version 1: the host records it
/// for a closed shift, with exactly what the record says, and refuses a
/// look-alike id, the version of its sibling `shift_txt_boxes` (2) and a
/// pallet named on it, so the plain boxes format neither stands in for it nor
/// does it admit a pallet's record.
#[tokio::test]
async fn the_reversed_boxes_format_is_recorded_at_version_one_and_no_look_alike_is() {
    let admin = admin().await;
    let (_, floor) = pallet_shift(&admin).await;
    close_by_station(&admin, &floor).await;
    let shift = floor.shift.clone();
    for (id, version) in [
        ("shift_txt_boxes_reversed", 0),
        ("shift_txt_boxes_reversed", 2),
        ("shift_txt_boxes_reverse", 1),
        ("shift_txt_boxes_reversed ", 1),
        ("shift_csv_boxes_reversed", 1),
        ("shift_txt_reversed", 1),
        ("", 1),
    ] {
        let (status, body) =
            record_export(&admin, &admin.token, &shift, record_of(id, version)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{id:?}@{version} {body}");
        assert_eq!(
            body["error"]["details"]["field"], "formatId",
            "{id:?}@{version}"
        );
    }
    let mut with_pallet = record_of("shift_txt_boxes_reversed", 1);
    with_pallet["palletId"] = json!(pallet_id(1));
    let (status, body) = record_export(&admin, &admin.token, &shift, with_pallet).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(body["error"]["details"]["field"], "palletId");
    assert_eq!(
        support::app::audit_trail(&admin.app, "shift.export").await,
        vec![]
    );
    let mut record = record_of("shift_txt_boxes_reversed", 1);
    record["maxLines"] = json!(2);
    record["partCount"] = json!(3);
    let (status, body) = record_export(&admin, &admin.token, &shift, record).await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{body}");
    assert_eq!(
        support::app::audit_trail(&admin.app, "shift.export").await,
        vec![admin.row(
            "shift.export",
            "shift",
            &shift,
            json!({
                "formatId": "shift_txt_boxes_reversed", "formatVersion": 1,
                "maxLines": 2, "palletId": null, "documentId": DOCUMENT,
                "partCount": 3, "codeCount": 3, "boxCount": 2, "palletCount": 1,
                "openPalletSuppressedBoxCount": 0,
            })
        )]
    );
}

/// The session gate: no session, a device key alone and an unknown token are
/// all `401` and record nothing; a planned shift is refused for a shift's
/// format as an active one is (`conflict` naming its status), and a
/// technologist's refused post writes nothing either.
#[tokio::test]
async fn only_a_signed_in_office_user_records_and_a_planned_shift_is_not_exportable() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let planned = support::app::plan_shift(&admin, support::app::shift_body(&setup)).await;
    let id = planned["id"].as_str().unwrap();
    let path = format!("/v1/office/shifts/{id}/exports");
    let body = record_of("shift_txt_flat", 1);
    let (status, answer) = admin
        .app
        .send(support::app::json(request("POST", &path), body.clone()))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "no credential {answer}");
    let (status, answer) = admin
        .app
        .send(support::app::json(
            with_device(request("POST", &path), &admin.key),
            body.clone(),
        ))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "device key {answer}");
    let (status, answer) = admin
        .app
        .send(support::app::json(
            support::app::with_session(request("POST", &path), &admin.key, "not-a-token"),
            body.clone(),
        ))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "unknown token {answer}");
    let technologist = admin.technologist().await;
    let (status, answer) = record_export(&admin, &technologist, id, body).await;
    assert_eq!(status, StatusCode::CONFLICT, "{answer}");
    assert_eq!(answer["error"]["details"]["status"], "planned");
    assert_eq!(
        support::app::audit_trail(&admin.app, "shift.export").await,
        vec![]
    );
}

/// A pallet's export of a shift already closed is recorded too (its state is
/// not checked again), and the same record posted twice is two rows: every
/// export that saved files is one.
#[tokio::test]
async fn a_pallet_of_a_closed_shift_and_a_repeated_post_each_write_a_row() {
    let admin = admin().await;
    let (_, floor) = pallet_shift(&admin).await;
    close_by_station(&admin, &floor).await;
    let mut of_pallet = record_of("pallet_xml_gismt_aggregation", 1);
    of_pallet["palletId"] = json!(pallet_id(1));
    for _ in 0..2 {
        let (status, body) =
            record_export(&admin, &admin.token, &floor.shift, of_pallet.clone()).await;
        assert_eq!(status, StatusCode::NO_CONTENT, "{body}");
    }
    let rows = support::app::audit_trail(&admin.app, "shift.export").await;
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0], rows[1]);
    assert_eq!(rows[0].3.as_deref(), Some("shift"));
    assert_eq!(rows[0].4.as_deref(), Some(floor.shift.as_str()));
    assert_eq!(rows[0].6["palletId"], json!(pallet_id(1)));
}

/// A body the host cannot read as the record is `400` and records nothing:
/// a field it does not know, a missing field (`maxLines` and `palletId`
/// read as `null` when missing, as serde reads an `Option`), a count that is negative,
/// fractional, null or a string, a `palletId` that is no UUID.
#[tokio::test]
async fn a_body_that_is_not_the_record_is_refused_and_writes_no_row() {
    let admin = admin().await;
    let (_, floor) = pallet_shift(&admin).await;
    close_by_station(&admin, &floor).await;
    let mut cases: Vec<(&str, Value)> = Vec::new();
    let mut extra = record_of("shift_txt_flat", 1);
    extra["folder"] = json!("C:\\Users\\someone");
    cases.push(("folder", extra));
    for field in [
        "formatId",
        "formatVersion",
        "documentId",
        "partCount",
        "codeCount",
        "boxCount",
        "palletCount",
        "openPalletSuppressedBoxCount",
    ] {
        let mut missing = record_of("shift_txt_flat", 1);
        missing.as_object_mut().unwrap().remove(field);
        cases.push((field, missing));
    }
    for (field, wrong) in [
        ("maxLines", json!(-5)),
        ("maxLines", json!(2.5)),
        ("maxLines", json!("100")),
        ("formatVersion", json!(1.5)),
        ("partCount", json!(-1)),
        ("partCount", json!(1.5)),
        ("partCount", json!(null)),
        ("codeCount", json!(-1)),
        ("codeCount", json!("3")),
        ("boxCount", json!(-1)),
        ("palletCount", json!(1.5)),
        ("openPalletSuppressedBoxCount", json!(-1)),
        ("documentId", json!(null)),
        ("formatId", json!(7)),
    ] {
        let mut record = record_of("shift_txt_flat", 1);
        record[field] = wrong;
        cases.push((field, record));
    }
    let mut not_uuid = record_of("pallet_xml_gismt_aggregation", 1);
    not_uuid["palletId"] = json!("pallet-1");
    cases.push(("palletId", not_uuid));
    for (what, record) in cases {
        let (status, body) =
            record_export(&admin, &admin.token, &floor.shift, record.clone()).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{what} {record} {body}");
    }
    let path = format!("/v1/office/shifts/{}/exports", floor.shift);
    let (status, body) = admin
        .call_as(&admin.token, "POST", &path, Some(json!([])))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(
        support::app::audit_trail(&admin.app, "shift.export").await,
        vec![]
    );
}

/// A count above 32 bits is recorded whole: a shift's codes are counted in a
/// `u64`, the parts' other counts in a `u32`.
#[tokio::test]
async fn a_count_above_32_bits_is_recorded_whole() {
    let admin = admin().await;
    let (_, floor) = pallet_shift(&admin).await;
    close_by_station(&admin, &floor).await;
    let mut big = record_of("shift_txt_flat", 1);
    big["codeCount"] = json!(5_000_000_000_u64);
    let (status, body) = record_export(&admin, &admin.token, &floor.shift, big).await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{body}");
    let rows = support::app::audit_trail(&admin.app, "shift.export").await;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].6["codeCount"], json!(5_000_000_000_u64));
}

/// The host's lists of formats are the fixture's, which the webview checks
/// against `@markiro/domain` (`test/protocol.test.ts`).
#[test]
fn the_formats_the_host_takes_are_the_fixtures() {
    let path = format!(
        "{}/../proto/fixtures/export-formats.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let fixture: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let listed = |kind: &str| -> Vec<(String, u32)> {
        fixture[kind]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| {
                (
                    f["id"].as_str().unwrap().to_owned(),
                    u32::try_from(f["version"].as_u64().unwrap()).unwrap(),
                )
            })
            .collect()
    };
    let own = |formats: &[(&str, u32)]| -> Vec<(String, u32)> {
        formats
            .iter()
            .map(|(id, version)| ((*id).to_owned(), *version))
            .collect()
    };
    assert_eq!(
        own(&markiro_host::routes::office_exports::SHIFT_FORMATS),
        listed("shift")
    );
    assert_eq!(
        own(&markiro_host::routes::office_exports::PALLET_FORMATS),
        listed("pallet")
    );
}

/// An office user turned off while the request waited records nothing: the
/// session is read again inside the write.
#[tokio::test]
async fn a_user_turned_off_before_the_write_records_nothing() {
    let admin = admin().await;
    let (_, floor) = pallet_shift(&admin).await;
    close_by_station(&admin, &floor).await;
    let (token, tech_id) = admin.technologist_session().await;
    support::app::turn_the_user_off_at_the_next_activity(&admin.app, &tech_id).await;
    admin.app.clock.advance(time::Duration::minutes(2));
    let (status, body) =
        record_export(&admin, &token, &floor.shift, record_of("shift_txt_flat", 1)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
    assert_eq!(body["error"]["details"]["credential"], "session");
    assert_eq!(
        support::app::audit_trail(&admin.app, "shift.export").await,
        vec![]
    );
}

/// A scan of `verdict` that owns nothing and lies in no box.
fn other_scan(verdict: &str, raw_kind: &str, code: Value, source: Value, at: &str) -> Value {
    json!({
        "scannedAt": at, "verdict": verdict, "duplicateSource": source, "rawKind": raw_kind,
        "rawLength": 14, "code": code, "boxId": null
    })
}

/// Code `n` owned at `scanned_at` with the canonical text `canonical`.
fn owned_as(n: u32, scanned_at: &str, canonical: &str) -> Value {
    json!({ "codeHash": code_hash(n), "scannedAt": scanned_at, "canonical": canonical })
}

/// The codes of the source are the codes the shift owns, each once, with the
/// canonical text of the scan that owns it, in the order of the scans'
/// instants whatever order they arrived or hash in: a duplicate, a wrong
/// GTIN, an invalid scan and the scan another scan outran are no code of the
/// shift. Boxes come in the order they opened.
#[tokio::test]
async fn codes_are_listed_once_with_the_owning_scans_text_in_the_order_of_the_scans() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let shift = floor.shift.clone();
    // The same code under two crypto tails: the later scan arrives first and
    // the earlier one, which arrives after it, owns the code.
    let tail = |at: &str, box_n: u32, text: &str| {
        let mut scan = ok_scan(5, &box_id(box_n), at);
        scan["code"]["canonical"] = json!(text);
        scan
    };
    let mut wrong = code(8);
    wrong["gtin14"] = json!("04600682000099");
    accept(
        &admin,
        &floor,
        &[
            fact(
                &record_id(1),
                "scan",
                &shift,
                ok_scan(3, &box_id(1), &instant(30, 0)),
            ),
            fact(
                &record_id(2),
                "scan",
                &shift,
                ok_scan(9, &box_id(1), &instant(10, 0)),
            ),
            fact(
                &record_id(3),
                "scan",
                &shift,
                tail(&instant(100, 0), 2, "010460068200001321S000005\u{1d}93LATE"),
            ),
            fact(
                &record_id(4),
                "scan",
                &shift,
                tail(&instant(50, 0), 3, "010460068200001321S000005\u{1d}93EARLY"),
            ),
            fact(
                &record_id(5),
                "scan",
                &shift,
                other_scan("duplicate", "km", code(9), json!("local"), &instant(60, 0)),
            ),
            fact(
                &record_id(6),
                "scan",
                &shift,
                other_scan("wrong_gtin", "km", wrong, Value::Null, &instant(61, 0)),
            ),
            fact(
                &record_id(7),
                "scan",
                &shift,
                other_scan("invalid", "gtin", Value::Null, Value::Null, &instant(62, 0)),
            ),
            // Opened before every other box, with the highest id of all.
            fact(
                &record_id(8),
                "scan",
                &shift,
                ok_scan(11, &box_id(7), &instant(5, 0)),
            ),
        ],
    )
    .await;
    let (status, source) = export_source(&admin, &shift).await;
    assert_eq!(status, StatusCode::OK, "{source}");
    assert_eq!(
        source["codes"],
        json!([
            owned(11, &instant(5, 0)),
            owned(9, &instant(10, 0)),
            owned(3, &instant(30, 0)),
            owned_as(5, &instant(50, 0), "010460068200001321S000005\u{1d}93EARLY"),
        ])
    );
    // Live items: code 5 left box 2 for box 3; the duplicate added none.
    assert_eq!(
        source["items"],
        json!([
            { "boxId": box_id(1), "codeHash": code_hash(3) },
            { "boxId": box_id(1), "codeHash": code_hash(9) },
            { "boxId": box_id(3), "codeHash": code_hash(5) },
            { "boxId": box_id(7), "codeHash": code_hash(11) },
        ])
    );
    let boxes: Vec<Value> = source["boxes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|b| b["id"].clone())
        .collect();
    assert_eq!(
        boxes,
        [box_id(7), box_id(1), box_id(3), box_id(2)].map(Value::from)
    );
}

/// Every pallet of the shift is listed, in the order they opened, the one
/// taken apart too, and the boxes of a pallet keep it when it is taken apart.
/// A box that closed after its pallet did (it joined the closed pallet
/// late) names it all the same, and the instants that tell it are both in the
/// rows: the office flags such a box from them.
#[tokio::test]
async fn every_pallet_is_listed_in_the_order_it_opened_and_a_late_box_keeps_its_pallet() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_pallet_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let block = issue_block(&admin.app, &floor.key, BLOCK_REQUEST).await;
    let pallets = issue_pallet_block(&admin.app, &floor.key, PALLET_REQUEST).await;
    let shift = floor.shift.clone();
    let mut on_time = box_closed(
        &box_id(1),
        &block,
        1500,
        &[1],
        &instant(10, 0),
        &instant(50, 0),
    );
    on_time["palletId"] = json!(pallet_id(1));
    let mut late = box_closed(
        &box_id(2),
        &block,
        1501,
        &[2],
        &instant(85, 0),
        &instant(90, 0),
    );
    late["palletId"] = json!(pallet_id(1));
    let disassemble = json!({
        "exception": "disassemble", "palletId": pallet_id(1), "reasonCode": "other",
        "reasonText": "Перепутали товар", "occurredAt": instant(100, 0)
    });
    accept(
        &admin,
        &floor,
        &[
            fact(
                &record_id(1),
                "scan",
                &shift,
                ok_scan(1, &box_id(1), &instant(10, 0)),
            ),
            fact(&record_id(2), "box_closed", &shift, on_time),
            // Pallet 2 opens before pallet 1 but has the higher id; none of
            // its boxes reached the host.
            fact(
                &record_id(3),
                "pallet_closed",
                &shift,
                pallet_closed(
                    &pallet_id(2),
                    &pallets,
                    40,
                    1,
                    &instant(20, 0),
                    &instant(70, 0),
                ),
            ),
            fact(
                &record_id(4),
                "pallet_closed",
                &shift,
                pallet_closed(
                    &pallet_id(1),
                    &pallets,
                    41,
                    1,
                    &instant(40, 0),
                    &instant(80, 0),
                ),
            ),
            fact(
                &record_id(5),
                "scan",
                &shift,
                ok_scan(2, &box_id(2), &instant(85, 0)),
            ),
            fact(&record_id(6), "box_closed", &shift, late),
            fact(&record_id(7), "pallet_exception", &shift, disassemble),
        ],
    )
    .await;
    let (status, source) = export_source(&admin, &shift).await;
    assert_eq!(status, StatusCode::OK, "{source}");
    assert_eq!(
        source["pallets"],
        json!([
            {
                "id": pallet_id(2), "sscc": pallet_sscc(40), "openedAt": instant(20, 0),
                "closedAt": instant(70, 0), "disassembledAt": null,
            },
            {
                "id": pallet_id(1), "sscc": pallet_sscc(41), "openedAt": instant(40, 0),
                "closedAt": instant(80, 0), "disassembledAt": instant(100, 0),
            },
        ])
    );
    assert_eq!(
        source["boxes"],
        json!([
            {
                "id": box_id(1), "sscc": sscc(1500), "openedAt": instant(10, 0),
                "closedAt": instant(50, 0), "disassembledAt": null, "palletId": pallet_id(1),
            },
            {
                "id": box_id(2), "sscc": sscc(1501), "openedAt": instant(85, 0),
                "closedAt": instant(90, 0), "disassembledAt": null, "palletId": pallet_id(1),
            },
        ])
    );
}

/// Change the organization's name and INN as the administrator.
async fn rename_organization(admin: &Admin, name: &str, inn: Value) {
    let (status, current) = admin.call("GET", "/v1/office/org", None).await;
    assert_eq!(status, StatusCode::OK, "{current}");
    let mut update = current.clone();
    update.as_object_mut().unwrap().remove("rev");
    update["name"] = json!(name);
    update["inn"] = inn;
    update["expectedRev"] = current["rev"].clone();
    let (status, body) = admin.call("PUT", "/v1/office/org", Some(update)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
}

/// The source names the organization as it is now, with an INN of ten digits
/// or twelve (the host checks no more than its profile does) or none at all,
/// as `null`: the office's checks, not the host, refuse a missing or
/// malformed one. A shift a station planned carries the station's number.
#[tokio::test]
async fn the_source_names_the_organization_now_and_a_station_shifts_own_number() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let (status, moved) = admin
        .app
        .send(support::app::json(
            with_device(request("PUT", "/v1/device/line"), &admin.key),
            json!({ "lineId": setup.line }),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{moved}");
    let (status, created) = admin
        .app
        .send(support::app::json(
            with_device(request("POST", "/v1/device/shifts"), &admin.key),
            json!({
                "requestId": SHIFT_REQUEST, "productId": setup.product,
                "boxTemplateId": setup.template, "productionDate": "2026-10-09"
            }),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let id = created["id"].as_str().unwrap();
    assert!(created["number"].as_str().unwrap().ends_with("/S"));
    let (status, source) = export_source(&admin, id).await;
    assert_eq!(status, StatusCode::OK, "{source}");
    assert_eq!(source["shift"]["number"], created["number"]);
    assert_eq!(source["shift"]["status"], "planned");
    assert_eq!(source["shift"]["productionDate"], "2026-10-09");
    assert_eq!(
        source["organization"],
        json!({ "name": "ООО «Атолл»", "inn": "7701234567" })
    );
    rename_organization(&admin, "ИП Иванов", json!("770123456789")).await;
    let (_, source) = export_source(&admin, id).await;
    assert_eq!(
        source["organization"],
        json!({ "name": "ИП Иванов", "inn": "770123456789" })
    );
    rename_organization(&admin, "ООО «Без ИНН»", Value::Null).await;
    let (_, source) = export_source(&admin, id).await;
    assert_eq!(
        source["organization"],
        json!({ "name": "ООО «Без ИНН»", "inn": null })
    );
}

/// The six reads are one snapshot: whatever commits between them, on another
/// connection, is in no part of the answer. After each query a write lands
/// that the next query would show (the organization's name, a code's scan
/// instant, a box's opening, an item taken out, a pallet's opening); the
/// answer is the one read before any of them, and a plain read afterwards
/// shows all five.
#[tokio::test]
async fn the_rows_of_one_answer_are_one_snapshot_whatever_commits_between_the_reads() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_pallet_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let block = issue_block(&admin.app, &floor.key, BLOCK_REQUEST).await;
    let pallets = issue_pallet_block(&admin.app, &floor.key, PALLET_REQUEST).await;
    let shift = floor.shift.clone();
    let mut closed = box_closed(
        &box_id(1),
        &block,
        1500,
        &[1],
        &instant(10, 0),
        &instant(20, 0),
    );
    closed["palletId"] = json!(pallet_id(1));
    accept(
        &admin,
        &floor,
        &[
            fact(
                &record_id(1),
                "scan",
                &shift,
                ok_scan(1, &box_id(1), &instant(10, 0)),
            ),
            fact(&record_id(2), "box_closed", &shift, closed),
            fact(
                &record_id(3),
                "pallet_closed",
                &shift,
                pallet_closed(
                    &pallet_id(1),
                    &pallets,
                    40,
                    1,
                    &instant(20, 0),
                    &instant(30, 0),
                ),
            ),
        ],
    )
    .await;
    let (status, before) = export_source(&admin, &shift).await;
    assert_eq!(status, StatusCode::OK, "{before}");
    assert_eq!(before["codes"].as_array().map(Vec::len), Some(1));
    assert_eq!(before["items"].as_array().map(Vec::len), Some(1));

    let pool = admin.app.state.pool.clone();
    let writer = pool.clone();
    let steps = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let seen = steps.clone();
    let rows = markiro_host::routes::office_exports::read_rows(&pool, &shift, move |step| {
        let pool = writer.clone();
        seen.lock().unwrap().push(step);
        async move {
            let write = match step {
                "shift" => "UPDATE org_profile SET name = 'Переименована'",
                "organization" => "UPDATE code_owners SET scanned_at = '2026-10-08T09:00:00.000Z'",
                "codes" => "UPDATE boxes SET opened_at = '2026-10-08T09:00:00.000Z'",
                "boxes" => "UPDATE box_items SET removed_at = '2026-10-08T09:00:00.000Z'",
                "items" => "UPDATE pallets SET opened_at = '2026-10-08T09:00:00.000Z'",
                // Nothing is left to read after the last query.
                "pallets" => return,
                other => panic!("no write after {other}"),
            };
            let done = sqlx::query(write).execute(&pool).await.unwrap();
            assert_eq!(done.rows_affected(), 1, "{write}");
        }
    })
    .await
    .unwrap()
    .unwrap();
    // The hook ran after each of the six queries: the equality below holds
    // only if the writes really landed between the reads.
    assert_eq!(
        *steps.lock().unwrap(),
        [
            "shift",
            "organization",
            "codes",
            "boxes",
            "items",
            "pallets"
        ]
    );
    assert_eq!(serde_json::to_value(&rows).unwrap(), before);

    let (status, after) = export_source(&admin, &shift).await;
    assert_eq!(status, StatusCode::OK, "{after}");
    assert_eq!(after["organization"]["name"], "Переименована");
    assert_eq!(after["codes"][0]["scannedAt"], "2026-10-08T09:00:00.000Z");
    assert_eq!(after["boxes"][0]["openedAt"], "2026-10-08T09:00:00.000Z");
    assert_eq!(after["items"], json!([]));
    assert_eq!(after["pallets"][0]["openedAt"], "2026-10-08T09:00:00.000Z");
}

/// The plan of every query of the source for `shift`.
async fn plans(admin: &Admin, shift: &str) -> Vec<(&'static str, Vec<String>)> {
    use markiro_host::routes::office_exports::{
        BOXES_SQL, CODES_SQL, ITEMS_SQL, ORGANIZATION_SQL, PALLETS_SQL, SHIFT_SQL,
    };
    let mut plans = Vec::new();
    for (name, sql) in [
        ("shift", SHIFT_SQL),
        ("organization", ORGANIZATION_SQL),
        ("codes", CODES_SQL),
        ("boxes", BOXES_SQL),
        ("items", ITEMS_SQL),
        ("pallets", PALLETS_SQL),
    ] {
        let text = format!("EXPLAIN QUERY PLAN {sql}");
        let query = sqlx::query_as::<_, (i64, i64, i64, String)>(&text);
        let query = if name == "organization" {
            query
        } else {
            query.bind(shift.to_owned())
        };
        let rows = query.fetch_all(&admin.app.state.pool).await.unwrap();
        plans.push((name, rows.into_iter().map(|(_, _, _, step)| step).collect()));
    }
    plans
}

/// What each query of the source searches by, named: the plan of one is a
/// search through the index the host has for it, never a pass through a
/// table (`SCAN`), whatever else the host holds.
fn assert_each_query_uses_its_index(plans: &[(&str, Vec<String>)]) {
    let expected: [(&str, &[&str]); 6] = [
        (
            "shift",
            &[
                "sqlite_autoindex_shifts_1",
                "sqlite_autoindex_products_1",
                "shift_close_events_shift",
            ],
        ),
        ("organization", &["INTEGER PRIMARY KEY"]),
        ("codes", &["scans_shift", "sqlite_autoindex_code_owners_2"]),
        ("boxes", &["boxes_shift"]),
        ("items", &["boxes_shift", "box_items_live"]),
        ("pallets", &["pallets_shift"]),
    ];
    assert_eq!(plans.len(), expected.len());
    for ((name, steps), (expected_name, indexes)) in plans.iter().zip(expected) {
        assert_eq!(*name, expected_name);
        assert!(
            steps.iter().all(|step| !step.starts_with("SCAN")),
            "{name}: {steps:?}"
        );
        for index in indexes {
            assert!(
                steps
                    .iter()
                    .any(|step| step.starts_with("SEARCH") && step.contains(index)),
                "{name} without {index}: {steps:?}"
            );
        }
    }
}

/// `count` accepted scans of codes `base + 1..` into `box_id` of `shift`,
/// each owning its code and lying in the box live, written straight into the
/// tables (a shift of a day's output is far more than facts can send in a
/// test); scan `i` is `i` seconds after midnight of 9 October 2026.
async fn fill(admin: &Admin, floor: &Floor, box_id: &str, base: u64, count: u64, prefix: &str) {
    let pool = &admin.app.state.pool;
    sqlx::query(
        "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1) \
         INSERT INTO scans (id, record_id, device_id, shift_id, verdict, raw_kind, raw_length, \
           code_hash, gtin14, serial, canonical, box_id, scanned_at, received_at) \
         SELECT printf('%s-0000-4000-8000-%012d', ?2, i), printf('%s-0000-4000-8000-%012d', ?2, i), \
           ?3, ?4, 'ok', 'km', 38, printf('%064x', ?5 + i), '04600682000013', \
           printf('B%07d', i), printf('0104600682000013' || '21B%07d' || char(29) || '93Zz', i), \
           ?6, printf('2026-10-09T%02d:%02d:%02d.000Z', i / 3600, i / 60 % 60, i % 60), \
           '2026-10-09T12:00:00Z' FROM n",
    )
    .bind(i64::try_from(count).unwrap())
    .bind(prefix)
    .bind(&floor.station)
    .bind(&floor.shift)
    .bind(i64::try_from(base).unwrap())
    .bind(box_id)
    .execute(pool)
    .await
    .unwrap();
    for sql in [
        "INSERT INTO code_owners (code_hash, scan_id, shift_id, device_id, box_id, scanned_at) \
         SELECT code_hash, id, shift_id, device_id, box_id, scanned_at FROM scans WHERE id LIKE ?1 || '%'",
        "INSERT INTO box_items (scan_id, box_id, code_hash, added_at) \
         SELECT id, box_id, code_hash, scanned_at FROM scans WHERE id LIKE ?1 || '%'",
    ] {
        sqlx::query(sql).bind(prefix).execute(pool).await.unwrap();
    }
}

/// A shift of thousands of codes comes whole and in order, one answer, and
/// the colleague's shift of as many beside it is none of it, and with that
/// many rows in the tables the queries still search by their indexes (the
/// host gathers no statistics, so the plan is the one it has in production).
#[tokio::test]
async fn a_shift_of_thousands_of_codes_comes_whole_in_order_and_still_by_the_indexes() {
    const COUNT: u64 = 3000;
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let (_, colleague_key) = pair_device(&admin.app, "station").await;
    let colleague = open_floor(&admin, &setup, &colleague_key, &setup.other_line).await;
    accept(
        &admin,
        &floor,
        &[fact(
            &record_id(1),
            "scan",
            &floor.shift,
            ok_scan(1, &box_id(1), &instant(10, 0)),
        )],
    )
    .await;
    accept(
        &admin,
        &colleague,
        &[fact(
            &record_id(1),
            "scan",
            &colleague.shift,
            ok_scan(2, &box_id(11), &instant(10, 0)),
        )],
    )
    .await;
    fill(&admin, &floor, &box_id(1), 0x1000_0000, COUNT, "ffffff01").await;
    fill(
        &admin,
        &colleague,
        &box_id(11),
        0x2000_0000,
        COUNT,
        "ffffff02",
    )
    .await;

    let (status, source) = export_source(&admin, &floor.shift).await;
    assert_eq!(status, StatusCode::OK);
    let codes = source["codes"].as_array().unwrap();
    assert_eq!(codes.len() as u64, COUNT + 1);
    assert_eq!(source["items"].as_array().unwrap().len() as u64, COUNT + 1);
    assert_eq!(source["boxes"].as_array().unwrap().len(), 1);
    // The real scan is the earliest; the rest follow second by second.
    assert_eq!(codes[0], owned(1, &instant(10, 0)));
    let keys: Vec<(&str, &str)> = codes
        .iter()
        .map(|c| {
            (
                c["scannedAt"].as_str().unwrap(),
                c["codeHash"].as_str().unwrap(),
            )
        })
        .collect();
    assert!(keys.windows(2).all(|pair| pair[0] < pair[1]));
    let hash = |i: u64| format!("{:064x}", 0x1000_0000 + i);
    assert_eq!(
        codes[1000],
        json!({
            "codeHash": hash(1000),
            "scannedAt": "2026-10-09T00:16:40.000Z",
            "canonical": "010460068200001321B0001000\u{1d}93Zz",
        })
    );
    assert_eq!(codes[COUNT as usize]["codeHash"], hash(COUNT));
    let (_, theirs) = export_source(&admin, &colleague.shift).await;
    assert_eq!(theirs["codes"].as_array().unwrap().len() as u64, COUNT + 1);
    assert!(theirs["codes"]
        .as_array()
        .unwrap()
        .iter()
        .all(|c| !keys.iter().any(|(_, h)| c["codeHash"] == *h)));
    assert_each_query_uses_its_index(&plans(&admin, &floor.shift).await);
}

/// The plan of each query, named and pinned (the brief's own test above
/// only forbids a pass through a table).
#[tokio::test]
async fn each_query_of_the_source_uses_the_index_made_for_it() {
    let admin = admin().await;
    assert_each_query_uses_its_index(&plans(&admin, "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b").await);
}

/// An id of no form a shift has is `not_found`, not a failure of the host,
/// and a session the host does not know is refused like none.
#[tokio::test]
async fn an_id_of_no_shift_is_not_found_and_an_unknown_session_is_refused() {
    let admin = admin().await;
    let (status, body) = export_source(&admin, "not-a-shift").await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    assert_eq!(body["error"]["code"], "not_found");
    let path = "/v1/office/shifts/0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b/export-source";
    let (status, body) = admin
        .app
        .send(empty(support::app::with_session(
            request("GET", path),
            &admin.key,
            "not-a-session-token",
        )))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
    assert_eq!(body["error"]["details"]["credential"], "session");
}
