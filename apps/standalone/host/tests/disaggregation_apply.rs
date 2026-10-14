//! Applying a disaggregation document (plan ДЗГ, task 5): what a box and a
//! pallet get, the checks under the facts' lock, what is refused before
//! anything is touched and what late facts see afterwards.

mod support;

use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{
    admin, audit_row, audit_trail, box_closed, box_exception, box_id, close_from_office, code_hash,
    empty, fact, fact_rows, host_revision, instant, issue_block, login, ok_scan, open_floor,
    pair_device, pallet_id, pallet_sscc, receipts, record_id, request, seed_office_user, sscc,
    turn_the_user_off_at_the_next_activity, with_device, Admin,
};
use support::disaggregation::{
    add, applied, apply, create, day, day_with_setup, line, pallet_day, station_disassembles,
    BLOCK_REQUEST, OTHER_REASON, REASON,
};

async fn code_check(admin: &Admin, key: &str, n: u32) -> Value {
    let (status, body) = admin
        .app
        .send(empty(with_device(
            request("GET", &format!("/v1/device/codes/{}", code_hash(n))),
            key,
        )))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body
}

fn id_of(detail: &Value) -> String {
    detail["document"]["id"].as_str().unwrap().to_owned()
}

async fn count(admin: &Admin, sql: &str) -> i64 {
    sqlx::query_scalar(sql)
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn an_applied_box_frees_its_codes_and_keeps_its_contents_for_the_report() {
    let admin = admin().await;
    let floor = day(&admin, true).await;
    let doc = create(&admin, json!({ "reasonId": REASON })).await;
    let id = id_of(&doc);
    let (_, detail) = add(&admin, &id, json!([line(&sscc(1500), Some(&sscc(1500)))])).await;
    let rev_before = host_revision(&admin.app).await;

    let (status, done) = apply(&admin, &detail).await;

    assert_eq!(status, StatusCode::OK, "{done}");
    assert_eq!(done["document"]["status"], "applied");
    assert_eq!(done["document"]["appliedBy"], json!(admin.id));
    assert!(done["document"]["appliedAt"].is_string());
    assert_eq!(done["lines"][0]["status"], "ok");
    // Codes 1-3 are free; code 4 (box 2) still belongs to its scan.
    for n in [1, 2, 3] {
        assert_eq!(code_check(&admin, &floor.key, n).await["status"], "free");
    }
    assert_eq!(code_check(&admin, &floor.key, 4).await["status"], "taken");
    // The box's three items left it at the instant the box was taken apart.
    let pool = &admin.app.state.pool;
    let disassembled: String = sqlx::query_scalar("SELECT disassembled_at FROM boxes WHERE id = ?")
        .bind(box_id(1))
        .fetch_one(pool)
        .await
        .unwrap();
    let removed: Vec<String> =
        sqlx::query_scalar("SELECT removed_at FROM box_items WHERE box_id = ?")
            .bind(box_id(1))
            .fetch_all(pool)
            .await
            .unwrap();
    assert_eq!(disassembled.len(), 24, "a device-form instant");
    assert_eq!(removed, vec![disassembled.clone(); 3]);
    // The other box is untouched.
    let untouched: Option<String> =
        sqlx::query_scalar("SELECT disassembled_at FROM boxes WHERE id = ?")
            .bind(box_id(2))
            .fetch_one(pool)
            .await
            .unwrap();
    assert_eq!(untouched, None);
    // «Состав короба» still lists the three codes.
    let (status, report) = admin
        .call(
            "GET",
            &format!("/v1/office/boxes/{}/report-data", box_id(1)),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{report}");
    assert_eq!(
        report["items"].as_array().map(Vec::len),
        Some(3),
        "{report}"
    );
    // One revision for the whole apply, on the document and the release.
    let rev = host_revision(&admin.app).await;
    assert_eq!(rev, rev_before + 1);
    assert_eq!(done["document"]["rev"], json!(rev));
    let release: (String, String, i64, i64) = sqlx::query_as(
        "SELECT shift_id, document_id, code_count, rev FROM code_releases WHERE box_id = ?",
    )
    .bind(box_id(1))
    .fetch_one(pool)
    .await
    .unwrap();
    assert_eq!(release, (floor.shift.clone(), id.clone(), 3, rev));
    assert_eq!(
        audit_trail(&admin.app, "disaggregation.apply").await,
        [audit_row(
            &admin.id,
            "disaggregation.apply",
            "disaggregation_document",
            &id,
            json!({ "docNo": "DSG-26-0001", "boxes": 1, "pallets": 0, "codes": 3 })
        )]
    );
}

/// Both hosts get the same day; in the first the station takes box 1 apart
/// before the shift closes, in the second an office document does after.
/// The exports of ЧЗ read the two alike.
#[tokio::test]
async fn an_office_disassembly_reads_in_the_exports_as_a_station_one() {
    let by_station = admin().await;
    let floor = day(&by_station, false).await;
    let receipt = station_disassembles(&by_station, &floor, 8, 1, 20).await;
    assert_eq!(receipt["outcome"], "accepted", "{receipt}");
    close_from_office(&by_station, &floor.shift, "Конец смены").await;

    let by_office = admin().await;
    let other = day(&by_office, true).await;
    applied(&by_office, &[sscc(1500)]).await;

    let export = |source: Value| -> Value {
        let mut boxes = source["boxes"].clone();
        for entry in boxes.as_array_mut().unwrap() {
            if entry["disassembledAt"].is_string() {
                entry["disassembledAt"] = json!("<at>");
            }
        }
        json!({
            "codes": source["codes"], "items": source["items"], "boxes": boxes,
            "pallets": source["pallets"],
        })
    };
    let (status, left) = by_station
        .call(
            "GET",
            &format!("/v1/office/shifts/{}/export-source", floor.shift),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{left}");
    let (status, right) = by_office
        .call(
            "GET",
            &format!("/v1/office/shifts/{}/export-source", other.shift),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{right}");
    let (left, right) = (export(left), export(right));
    assert_eq!(left, right);
    // The freed codes are really gone from the export, the other box's stay.
    let codes = right["codes"].as_array().unwrap();
    assert_eq!(codes.len(), 2, "{right}");
    assert!(right["boxes"]
        .as_array()
        .unwrap()
        .iter()
        .any(|b| b["disassembledAt"] == "<at>"));
}

#[tokio::test]
async fn a_pallet_line_takes_the_pallet_apart_and_leaves_its_boxes() {
    let admin = admin().await;
    let floor = pallet_day(&admin, true).await;
    let done = applied(&admin, &[pallet_sscc(40)]).await;
    assert_eq!(done["lines"][0]["palletId"], json!(pallet_id(1)));
    let pool = &admin.app.state.pool;
    let pallet: Option<String> =
        sqlx::query_scalar("SELECT disassembled_at FROM pallets WHERE id = ?")
            .bind(pallet_id(1))
            .fetch_one(pool)
            .await
            .unwrap();
    assert!(pallet.is_some());
    let boxes: Vec<(Option<String>, Option<String>)> =
        sqlx::query_as("SELECT disassembled_at, pallet_id FROM boxes ORDER BY id")
            .fetch_all(pool)
            .await
            .unwrap();
    assert_eq!(boxes, vec![(None, Some(pallet_id(1))); 2]);
    // The codes stay taken and nothing is released.
    for n in [1, 2, 3] {
        assert_eq!(code_check(&admin, &floor.key, n).await["status"], "taken");
    }
    assert_eq!(count(&admin, "SELECT COUNT(*) FROM code_releases").await, 0);
    let (status, pallets) = admin
        .call(
            "GET",
            &format!("/v1/office/shifts/{}/pallets", floor.shift),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{pallets}");
    assert!(pallets.to_string().contains("disassembledAt"), "{pallets}");
    assert!(
        !pallets[0]["disassembledAt"].is_null(),
        "the pallet reads as taken apart: {pallets}"
    );
    let (status, listed) = admin
        .call(
            "GET",
            &format!("/v1/office/shifts/{}/boxes", floor.shift),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{listed}");
    assert_eq!(listed.as_array().map(Vec::len), Some(2), "{listed}");
}

#[tokio::test]
async fn a_box_and_its_pallet_in_one_document() {
    let admin = admin().await;
    pallet_day(&admin, true).await;
    let done = applied(&admin, &[sscc(1500), pallet_sscc(40)]).await;
    assert_eq!(done["document"]["status"], "applied");
    assert_eq!(count(&admin, "SELECT COUNT(*) FROM code_releases").await, 1);
    assert_eq!(
        count(
            &admin,
            "SELECT COUNT(*) FROM boxes WHERE disassembled_at IS NOT NULL"
        )
        .await,
        1
    );
    assert_eq!(
        count(
            &admin,
            "SELECT COUNT(*) FROM pallets WHERE disassembled_at IS NOT NULL"
        )
        .await,
        1
    );
    assert_eq!(
        audit_trail(&admin.app, "disaggregation.apply").await[0].6,
        json!({ "docNo": "DSG-26-0001", "boxes": 1, "pallets": 1, "codes": 2 })
    );
}

#[tokio::test]
async fn an_apply_rechecks_every_line_and_keeps_the_fresh_statuses() {
    // Lines added while the shift was open are `shift_open`; the shift closes;
    // the apply sees them as they are now.
    let admin = admin().await;
    let floor = day(&admin, false).await;
    let doc = create(&admin, json!({ "reasonId": REASON })).await;
    let (_, detail) = add(
        &admin,
        &id_of(&doc),
        json!([line(&sscc(1500), Some(&sscc(1500)))]),
    )
    .await;
    assert_eq!(detail["lines"][0]["status"], "shift_open");
    close_from_office(&admin, &floor.shift, "Конец смены").await;
    let (_, card) = admin
        .call(
            "GET",
            &format!("/v1/office/disaggregation/{}", id_of(&doc)),
            None,
        )
        .await;
    let (status, done) = apply(&admin, &card).await;
    assert_eq!(status, StatusCode::OK, "{done}");
    assert_eq!(done["lines"][0]["status"], "ok");
    assert_eq!(done["lines"][0]["codeCount"], 3);
}

#[tokio::test]
async fn a_line_that_stopped_being_ok_refuses_the_apply_and_keeps_the_fresh_status() {
    let admin = admin().await;
    let floor = day(&admin, true).await;
    let doc = create(&admin, json!({ "reasonId": REASON })).await;
    let id = id_of(&doc);
    let (_, detail) = add(
        &admin,
        &id,
        json!([
            line(&sscc(1500), Some(&sscc(1500))),
            line(&sscc(1501), Some(&sscc(1501)))
        ]),
    )
    .await;
    assert_eq!(detail["lines"][0]["status"], "ok");
    // A late station exception takes box 1 apart: a closed shift does not stop it.
    let receipt = station_disassembles(&admin, &floor, 9, 1, 30).await;
    assert_eq!(receipt["outcome"], "accepted", "{receipt}");
    let facts = fact_rows(&admin.app).await;
    let before = host_revision(&admin.app).await;

    let (status, refused) = apply(&admin, &detail).await;

    assert_eq!(status, StatusCode::CONFLICT, "{refused}");
    assert_eq!(
        refused["error"]["details"],
        json!({ "constraint": "invalid_lines", "invalidLines": 1 })
    );
    let (_, card) = admin
        .call("GET", &format!("/v1/office/disaggregation/{id}"), None)
        .await;
    assert_eq!(card["document"]["status"], "draft");
    assert_eq!(card["lines"][0]["status"], "already_disassembled");
    assert_eq!(card["lines"][1]["status"], "ok");
    assert_eq!(card["document"]["rev"], json!(before + 1));
    // Nothing of the apply was done: box 2 stays, nothing is released.
    assert_eq!(count(&admin, "SELECT COUNT(*) FROM code_releases").await, 0);
    assert_eq!(code_check(&admin, &floor.key, 4).await["status"], "taken");
    assert_eq!(fact_rows(&admin.app).await, facts);
    let mut failed = audit_row(
        &admin.id,
        "disaggregation.apply",
        "disaggregation_document",
        &id,
        json!({ "docNo": "DSG-26-0001", "invalidLines": 1 }),
    );
    failed.5 = "failed".to_owned();
    assert_eq!(
        audit_trail(&admin.app, "disaggregation.apply").await,
        [failed]
    );
    // The same box in two documents: the second one applied is refused.
    let first = create(&admin, json!({ "reasonId": REASON })).await;
    let second = create(&admin, json!({ "reasonId": REASON })).await;
    let (_, first) = add(
        &admin,
        &id_of(&first),
        json!([line(&sscc(1501), Some(&sscc(1501)))]),
    )
    .await;
    let (_, second) = add(
        &admin,
        &id_of(&second),
        json!([line(&sscc(1501), Some(&sscc(1501)))]),
    )
    .await;
    let (status, _) = apply(&admin, &first).await;
    assert_eq!(status, StatusCode::OK);
    let (status, refused) = apply(&admin, &second).await;
    assert_eq!(status, StatusCode::CONFLICT, "{refused}");
    assert_eq!(refused["error"]["details"]["constraint"], "invalid_lines");
}

#[tokio::test]
async fn what_an_apply_refuses_before_it_touches_anything() {
    let admin = admin().await;
    day(&admin, true).await;
    let facts = fact_rows(&admin.app).await;
    // Nothing is taken apart by any refusal below: the state to compare.
    let untouched = || async {
        (
            count(
                &admin,
                "SELECT COUNT(*) FROM boxes WHERE disassembled_at IS NOT NULL",
            )
            .await,
            count(
                &admin,
                "SELECT COUNT(*) FROM box_items WHERE removed_at IS NOT NULL",
            )
            .await,
            count(&admin, "SELECT COUNT(*) FROM code_owners").await,
            count(&admin, "SELECT COUNT(*) FROM code_releases").await,
        )
    };
    assert_eq!(untouched().await, (0, 0, 5, 0));
    let refuses = |label: &'static str, detail: Value, constraint: &'static str| {
        let admin = &admin;
        async move {
            let (status, body) = apply(admin, &detail).await;
            assert_eq!(status, StatusCode::CONFLICT, "{label}: {body}");
            assert_eq!(
                body["error"]["details"]["constraint"], constraint,
                "{label}"
            );
        }
    };
    // No reason.
    let no_reason = create(&admin, json!({})).await;
    let (_, no_reason) = add(
        &admin,
        &id_of(&no_reason),
        json!([line(&sscc(1500), Some(&sscc(1500)))]),
    )
    .await;
    refuses("no reason", no_reason, "reason_required").await;
    // No lines.
    let empty_doc = create(&admin, json!({ "reasonId": REASON })).await;
    refuses("no lines", empty_doc, "no_lines").await;
    // A line that is no box, and a repeat.
    let junk = create(&admin, json!({ "reasonId": REASON })).await;
    let (_, junk) = add(
        &admin,
        &id_of(&junk),
        json!([
            line(&sscc(1500), Some(&sscc(1500))),
            line("junk", None),
            line(&sscc(1500), Some(&sscc(1500))),
        ]),
    )
    .await;
    refuses("not found and a repeat", junk.clone(), "invalid_lines").await;
    let (_, junk) = admin
        .call(
            "GET",
            &format!("/v1/office/disaggregation/{}", id_of(&junk)),
            None,
        )
        .await;
    assert_eq!(junk["document"]["status"], "draft");
    // A stale revision.
    let stale = create(&admin, json!({ "reasonId": REASON })).await;
    let (_, stale) = add(
        &admin,
        &id_of(&stale),
        json!([line(&sscc(1500), Some(&sscc(1500)))]),
    )
    .await;
    let (status, body) = admin
        .call(
            "POST",
            &format!("/v1/office/disaggregation/{}/apply", id_of(&stale)),
            Some(json!({ "expectedRev": 1 })),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"]["code"], "stale_revision");
    // Cancelled and applied documents do not apply again.
    let (status, cancelled) = admin
        .call(
            "POST",
            &format!("/v1/office/disaggregation/{}/cancel", id_of(&stale)),
            Some(json!({ "expectedRev": stale["document"]["rev"] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{cancelled}");
    refuses("cancelled", cancelled, "document_not_draft").await;
    let done = applied(&admin, &[sscc(1500)]).await;
    refuses("applied", done, "document_not_draft").await;
    // Only the one good apply took anything apart: box 1, once.
    assert_eq!(
        count(
            &admin,
            "SELECT COUNT(*) FROM boxes WHERE disassembled_at IS NOT NULL"
        )
        .await,
        1
    );
    assert_eq!(
        count(
            &admin,
            "SELECT COUNT(*) FROM box_items WHERE removed_at IS NOT NULL"
        )
        .await,
        3
    );
    assert_eq!(count(&admin, "SELECT COUNT(*) FROM code_owners").await, 2);
    assert_eq!(count(&admin, "SELECT COUNT(*) FROM code_releases").await, 1);
    assert_eq!(
        fact_rows(&admin.app).await["fact_receipts"],
        facts["fact_receipts"]
    );
}

#[tokio::test]
async fn late_facts_after_an_apply_see_its_result() {
    let admin = admin().await;
    let (setup, floor) = day_with_setup(&admin, true).await;
    applied(&admin, &[sscc(1500)]).await;
    // A reprint of the box taken apart.
    let mut reprint = box_exception("reprint", &box_id(1), &instant(40, 0));
    reprint["reasonCode"] = json!("printer_jam");
    let answered = receipts(
        &admin.app,
        &floor.key,
        &[fact(&record_id(20), "box_exception", &floor.shift, reprint)],
    )
    .await;
    assert_eq!(
        answered,
        vec![support::app::rejected(
            Some(&record_id(20)),
            "box_state",
            None
        )]
    );
    // The same close sent again late changes nothing: the box stays apart.
    let block = issue_block(&admin.app, &floor.key, BLOCK_REQUEST).await;
    let again = fact(
        &record_id(21),
        "box_closed",
        &floor.shift,
        box_closed(
            &box_id(1),
            &block,
            1500,
            &[1, 2, 3],
            &instant(1, 0),
            &instant(10, 0),
        ),
    );
    let answered = receipts(&admin.app, &floor.key, &[again]).await;
    assert_eq!(answered, vec![support::app::accepted(&record_id(21))]);
    assert_eq!(
        count(
            &admin,
            "SELECT COUNT(*) FROM boxes WHERE disassembled_at IS NOT NULL"
        )
        .await,
        1
    );
    // Its items still left at the apply, and the freed code is free.
    assert_eq!(
        count(
            &admin,
            &format!(
                "SELECT COUNT(*) FROM box_items WHERE box_id = '{}' AND removed_at IS NOT NULL",
                box_id(1)
            )
        )
        .await,
        3
    );
    assert_eq!(code_check(&admin, &floor.key, 1).await["status"], "free");
    // Another station scans the freed code 1 in its own open shift.
    let (_, colleague_key) = pair_device(&admin.app, "station").await;
    let colleague = open_floor(&admin, &setup, &colleague_key, &setup.other_line).await;
    let conflicts = count(&admin, "SELECT COUNT(*) FROM code_conflicts").await;
    let answered = receipts(
        &admin.app,
        &colleague.key,
        &[fact(
            &record_id(1),
            "scan",
            &colleague.shift,
            ok_scan(1, &box_id(11), &instant(5, 0)),
        )],
    )
    .await;
    assert_eq!(answered, vec![support::app::accepted(&record_id(1))]);
    assert_eq!(
        code_check(&admin, &colleague.key, 1).await["status"],
        "taken"
    );
    assert_eq!(
        count(&admin, "SELECT COUNT(*) FROM code_conflicts").await,
        conflicts,
        "a freed code is no conflict"
    );
}

#[tokio::test]
async fn an_apply_waits_for_a_fact_batchs_write_lock() {
    let admin = admin().await;
    day(&admin, true).await;
    let doc = create(&admin, json!({ "reasonId": REASON })).await;
    let (_, detail) = add(
        &admin,
        &id_of(&doc),
        json!([line(&sscc(1500), Some(&sscc(1500)))]),
    )
    .await;
    let held = markiro_host::db::begin_write(&admin.app.state.pool)
        .await
        .unwrap();
    let applying = apply(&admin, &detail);
    tokio::pin!(applying);
    // The apply queues behind the held write transaction (BEGIN IMMEDIATE)…
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(300), &mut applying)
            .await
            .is_err()
    );
    held.rollback().await.unwrap();
    // …and goes through once it is released.
    let (status, done) = applying.await;
    assert_eq!(status, StatusCode::OK, "{done}");
}

/// What the batch it waited for committed is what the apply checks: the
/// reads come after the lock, not before it.
#[tokio::test]
async fn an_apply_reads_what_the_batch_it_waited_for_committed() {
    let admin = admin().await;
    day(&admin, true).await;
    let doc = create(&admin, json!({ "reasonId": REASON })).await;
    let (_, detail) = add(
        &admin,
        &id_of(&doc),
        json!([line(&sscc(1500), Some(&sscc(1500)))]),
    )
    .await;
    assert_eq!(detail["lines"][0]["status"], "ok");
    let mut held = markiro_host::db::begin_write(&admin.app.state.pool)
        .await
        .unwrap();
    let applying = apply(&admin, &detail);
    tokio::pin!(applying);
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(300), &mut applying)
            .await
            .is_err()
    );
    // A station's late disassembly of the same box lands first.
    sqlx::query("UPDATE boxes SET disassembled_at = '2026-10-08T07:00:00.000Z' WHERE id = ?")
        .bind(box_id(1))
        .execute(&mut *held)
        .await
        .unwrap();
    held.commit().await.unwrap();
    let (status, refused) = applying.await;
    assert_eq!(status, StatusCode::CONFLICT, "{refused}");
    assert_eq!(refused["error"]["details"]["constraint"], "invalid_lines");
    assert_eq!(count(&admin, "SELECT COUNT(*) FROM code_releases").await, 0);
}

#[tokio::test]
async fn a_technologist_applies() {
    let admin = admin().await;
    day(&admin, true).await;
    let (tech, tech_id) = admin.technologist_session().await;
    let (status, doc) = admin
        .call_as(
            &tech,
            "POST",
            "/v1/office/disaggregation",
            Some(json!({ "reasonId": OTHER_REASON })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{doc}");
    let (_, detail) = add(
        &admin,
        &id_of(&doc),
        json!([line(&sscc(1500), Some(&sscc(1500)))]),
    )
    .await;
    let id = id_of(&doc);
    let (status, done) = admin
        .call_as(
            &tech,
            "POST",
            &format!("/v1/office/disaggregation/{id}/apply"),
            Some(json!({ "expectedRev": detail["document"]["rev"] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{done}");
    assert_eq!(done["document"]["appliedBy"], json!(tech_id));
    assert_eq!(
        audit_trail(&admin.app, "disaggregation.apply").await,
        [audit_row(
            &tech_id,
            "disaggregation.apply",
            "disaggregation_document",
            &id,
            json!({ "docNo": "DSG-26-0001", "boxes": 1, "pallets": 0, "codes": 3 })
        )]
    );
}

/// Every shift whose boxes or pallets changed reads as having late data,
/// once, as a station's late exception marks it: a file saved before the
/// apply no longer describes the shift.
#[tokio::test]
async fn an_apply_marks_the_shift_late_once_and_with_the_applys_revision() {
    let admin = admin().await;
    let floor = day(&admin, true).await;
    let late = || async {
        sqlx::query_as::<_, (Option<String>, i64)>(
            "SELECT late_data_at, rev FROM shifts WHERE id = ?",
        )
        .bind(&floor.shift)
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap()
    };
    assert_eq!(late().await.0, None);
    let done = applied(&admin, &[sscc(1500)]).await;
    let (marked, rev) = late().await;
    assert_eq!(
        marked,
        done["document"]["appliedAt"].as_str().map(str::to_owned)
    );
    assert_eq!(rev, done["document"]["rev"].as_i64().unwrap());
    // A second apply on the same shift keeps the first mark.
    admin.app.clock.advance(time::Duration::minutes(5));
    applied(&admin, &[sscc(1501)]).await;
    assert_eq!(late().await.0, marked);
}

/// A failure while the second target is taken apart undoes the first: the
/// apply is all or nothing.
#[tokio::test]
async fn a_failing_apply_leaves_nothing_taken_apart() {
    let admin = admin().await;
    day(&admin, true).await;
    let doc = create(&admin, json!({ "reasonId": REASON })).await;
    let (_, detail) = add(
        &admin,
        &id_of(&doc),
        json!([
            line(&sscc(1500), Some(&sscc(1500))),
            line(&sscc(1501), Some(&sscc(1501)))
        ]),
    )
    .await;
    sqlx::query(&format!(
        "CREATE TRIGGER fail_the_second_release BEFORE INSERT ON code_releases \
         WHEN NEW.box_id = '{}' BEGIN SELECT RAISE(ABORT, 'no'); END",
        box_id(2)
    ))
    .execute(&admin.app.state.pool)
    .await
    .unwrap();
    let rows = support::app::audit_rows(&admin.app).await;
    let revision = host_revision(&admin.app).await;

    let (status, body) = apply(&admin, &detail).await;

    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{body}");
    for sql in [
        "SELECT COUNT(*) FROM boxes WHERE disassembled_at IS NOT NULL",
        "SELECT COUNT(*) FROM box_items WHERE removed_at IS NOT NULL",
        "SELECT COUNT(*) FROM code_releases",
        "SELECT COUNT(*) FROM shifts WHERE late_data_at IS NOT NULL",
    ] {
        assert_eq!(count(&admin, sql).await, 0, "{sql}");
    }
    assert_eq!(count(&admin, "SELECT COUNT(*) FROM code_owners").await, 5);
    assert_eq!(support::app::audit_rows(&admin.app).await, rows);
    assert_eq!(host_revision(&admin.app).await, revision);
    let (_, card) = admin
        .call(
            "GET",
            &format!("/v1/office/disaggregation/{}", id_of(&doc)),
            None,
        )
        .await;
    assert_eq!(card["document"]["status"], "draft");
    assert_eq!(card["document"]["rev"], detail["document"]["rev"]);
}

/// A user turned off after the extractor passed is found under the lock:
/// nothing is taken apart.
#[tokio::test]
async fn an_apply_by_a_user_turned_off_after_the_extractor_does_nothing() {
    let admin = admin().await;
    day(&admin, true).await;
    let doc = create(&admin, json!({ "reasonId": REASON })).await;
    let (_, detail) = add(
        &admin,
        &id_of(&doc),
        json!([line(&sscc(1500), Some(&sscc(1500)))]),
    )
    .await;
    let other = seed_office_user(&admin.app, "tech2", "technologist", "second tech password").await;
    let token = login(&admin.app, &admin.key, "tech2", "second tech password").await;
    turn_the_user_off_at_the_next_activity(&admin.app, &other).await;
    admin.app.clock.advance(time::Duration::minutes(2));
    let rows = support::app::audit_rows(&admin.app).await;
    let (status, body) = admin
        .call_as(
            &token,
            "POST",
            &format!("/v1/office/disaggregation/{}/apply", id_of(&doc)),
            Some(json!({ "expectedRev": detail["document"]["rev"] })),
        )
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
    assert_eq!(body["error"]["details"]["credential"], "session");
    assert_eq!(
        count(
            &admin,
            "SELECT COUNT(*) FROM boxes WHERE disassembled_at IS NOT NULL"
        )
        .await,
        0
    );
    assert_eq!(support::app::audit_rows(&admin.app).await, rows);
}
