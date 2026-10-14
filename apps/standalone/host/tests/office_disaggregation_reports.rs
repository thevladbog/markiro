//! A disaggregation document's act and ЧЗ file in the office (plan ДЗГ-О):
//! `GET /v1/office/disaggregation/{id}/report-data` reads what «Акт
//! дезагрегации» prints, in one snapshot, and `POST …/exports` writes the
//! one audit row of the saved «Расформирование упаковки» file.

mod support;

use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{
    admin, box_closed, box_id, close_from_office, code, empty, fact, instant, issue_block, ok_scan,
    open_floor, pair_device, pallet_sscc, receipts, record_id, request, sscc, with_device, Admin,
};
use support::disaggregation::{
    add, apply, create, day, day_with_setup, line, pallet_day, station_disassembles, REASON,
};

const COLLEAGUE_BLOCK_REQUEST: &str = "7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d";

/// A document of `lines` (`(input, sscc)`, as the office sends them after
/// `parseScannedSscc`); applied when `apply_it`. Returns its id.
async fn document(admin: &Admin, lines: &[(&str, Option<&str>)], apply_it: bool) -> String {
    let created = create(
        admin,
        json!({ "reasonId": REASON, "comment": "Короба намокли" }),
    )
    .await;
    let id = created["document"]["id"].as_str().unwrap().to_owned();
    let wire: Vec<Value> = lines.iter().map(|(input, s)| line(input, *s)).collect();
    let (status, detail) = add(admin, &id, Value::Array(wire)).await;
    assert_eq!(status, StatusCode::OK, "{detail}");
    if apply_it {
        let (status, done) = apply(admin, &detail).await;
        assert_eq!(status, StatusCode::OK, "{done}");
    }
    id
}

async fn report(admin: &Admin, id: &str, query: &str) -> (StatusCode, Value) {
    admin
        .call(
            "GET",
            &format!("/v1/office/disaggregation/{id}/report-data{query}"),
            None,
        )
        .await
}

/// Code `n` as the act prints it.
fn printed(n: u32) -> Value {
    let code = code(n);
    json!({ "gtin14": code["gtin14"], "serial": code["serial"], "canonical": code["canonical"] })
}

async fn org_inn(admin: &Admin) -> Value {
    let (status, org) = admin.call("GET", "/v1/office/org", None).await;
    assert_eq!(status, StatusCode::OK, "{org}");
    org["inn"].clone()
}

#[tokio::test]
async fn the_boxes_act_names_the_document_and_its_lines_without_contents() {
    let admin = admin().await;
    day(&admin, true).await;
    let (a, b) = (sscc(1500), sscc(1501));
    let id = document(&admin, &[(&a, Some(&a)), (&b, Some(&b))], true).await;
    let (status, rows) = report(&admin, &id, "").await;
    assert_eq!(status, StatusCode::OK, "{rows}");
    assert_eq!(rows["variant"], "boxes");
    assert_eq!(rows["status"], "applied");
    assert!(rows["docNo"].as_str().unwrap().starts_with("DSG-"));
    assert_eq!(rows["organization"]["inn"], org_inn(&admin).await);
    assert_eq!(rows["reasonName"], "Повреждена упаковка");
    assert_eq!(rows["comment"], "Короба намокли");
    let lines = rows["lines"].as_array().unwrap();
    assert_eq!(
        lines.iter().map(|l| l["sscc"].clone()).collect::<Vec<_>>(),
        vec![json!(a), json!(b)]
    );
    assert_eq!(lines[0]["codeCount"], 3);
    assert_eq!(lines[1]["codeCount"], 1);
    assert!(lines
        .iter()
        .all(|l| l["items"] == json!([]) && l["boxes"] == json!([])));
    assert!(lines[0]["boxId"].is_string() && lines[0]["palletId"].is_null());
    assert_eq!(rows["createdByName"], rows["appliedByName"]);
    assert!(rows["appliedAt"].is_string());
    // The boxes variant is the default and an explicit one alike.
    let (_, explicit) = report(&admin, &id, "?variant=boxes").await;
    assert_eq!(explicit, rows);
}

#[tokio::test]
async fn the_full_act_prints_the_codes_the_document_took_out_by_gtin_and_serial() {
    let admin = admin().await;
    day(&admin, true).await;
    let (a, b) = (sscc(1500), sscc(1501));
    let id = document(&admin, &[(&a, Some(&a)), (&b, Some(&b))], true).await;
    let (status, rows) = report(&admin, &id, "?variant=full").await;
    assert_eq!(status, StatusCode::OK, "{rows}");
    assert_eq!(rows["variant"], "full");
    let lines = rows["lines"].as_array().unwrap();
    // Taken out by the document itself: the rule «removed_at = disassembled_at» finds them.
    assert_eq!(
        lines[0]["items"],
        json!([printed(1), printed(2), printed(3)])
    );
    assert_eq!(lines[1]["items"], json!([printed(4)]));
}

/// A code an operator took out of the box long before (an undo) is not one
/// the document took out: only the codes of the box's own disassembly print.
#[tokio::test]
async fn a_code_taken_out_earlier_is_not_on_the_act_of_the_box_taken_apart_later() {
    let admin = admin().await;
    day(&admin, true).await;
    let taken = sqlx::query(
        "UPDATE box_items SET removed_at = '2026-01-01T00:00:00.000Z' \
         WHERE code_hash = (SELECT code_hash FROM scans WHERE serial = ?)",
    )
    .bind(code(1)["serial"].as_str().unwrap())
    .execute(&admin.app.state.pool)
    .await
    .unwrap();
    assert_eq!(taken.rows_affected(), 1);
    let a = sscc(1500);
    let id = document(&admin, &[(&a, Some(&a))], true).await;
    let (_, rows) = report(&admin, &id, "?variant=full").await;
    assert_eq!(rows["lines"][0]["items"], json!([printed(2), printed(3)]));
}

#[tokio::test]
async fn a_draft_full_act_prints_the_live_codes() {
    let admin = admin().await;
    day(&admin, true).await;
    let a = sscc(1500);
    let id = document(&admin, &[(&a, Some(&a))], false).await;
    let (status, rows) = report(&admin, &id, "?variant=full").await;
    assert_eq!(status, StatusCode::OK, "{rows}");
    assert_eq!(rows["status"], "draft");
    assert_eq!(rows["appliedAt"], Value::Null);
    assert_eq!(rows["appliedByName"], Value::Null);
    assert_eq!(
        rows["lines"][0]["items"],
        json!([printed(1), printed(2), printed(3)])
    );
}

#[tokio::test]
async fn an_act_leaves_out_lines_without_an_sscc() {
    let admin = admin().await;
    day(&admin, true).await;
    let a = sscc(1500);
    // A repeat keeps `sscc = NULL`, and so does an input that is no SSCC.
    let id = document(
        &admin,
        &[(&a, Some(&a)), (&a, Some(&a)), ("MRK-000742", None)],
        false,
    )
    .await;
    let (status, rows) = report(&admin, &id, "?variant=full").await;
    assert_eq!(status, StatusCode::OK, "{rows}");
    let lines = rows["lines"].as_array().unwrap();
    assert_eq!(lines.len(), 1, "{rows}");
    assert_eq!(lines[0]["sscc"], json!(a));
    assert_eq!(lines[0]["items"].as_array().unwrap().len(), 3);
}

#[tokio::test]
async fn a_pallet_line_lists_its_boxes_not_taken_apart_closed_first() {
    let admin = admin().await;
    pallet_day(&admin, true).await;
    let pallet = pallet_sscc(40);
    let id = document(&admin, &[(&pallet, Some(&pallet))], true).await;
    let (status, rows) = report(&admin, &id, "?variant=full").await;
    assert_eq!(status, StatusCode::OK, "{rows}");
    let only = &rows["lines"][0];
    assert_eq!(only["boxId"], Value::Null);
    assert!(only["palletId"].is_string());
    assert_eq!(only["items"], json!([]));
    assert_eq!(
        only["boxes"],
        json!([
            { "sscc": sscc(1500), "units": 2 },
            { "sscc": sscc(1501), "units": 1 },
        ])
    );
    assert_eq!(only["codeCount"], 3);
    // The short variant leaves them out.
    let (_, short) = report(&admin, &id, "").await;
    assert_eq!(short["lines"][0]["boxes"], json!([]));
}

#[tokio::test]
async fn a_box_a_station_took_apart_before_is_not_on_the_pallets_act() {
    let admin = admin().await;
    let floor = pallet_day(&admin, false).await;
    let receipt = station_disassembles(&admin, &floor, 20, 2, 50).await;
    assert_eq!(receipt["outcome"], "accepted", "{receipt}");
    close_from_office(&admin, &floor.shift, "Конец смены").await;
    let pallet = pallet_sscc(40);
    let id = document(&admin, &[(&pallet, Some(&pallet))], false).await;
    let (_, rows) = report(&admin, &id, "?variant=full").await;
    assert_eq!(
        rows["lines"][0]["boxes"],
        json!([{ "sscc": sscc(1500), "units": 2 }])
    );
}

#[tokio::test]
async fn two_shifts_of_one_document_are_both_read() {
    let admin = admin().await;
    let (setup, _) = day_with_setup(&admin, true).await;
    let (_, colleague_key) = pair_device(&admin.app, "station").await;
    let colleague = open_floor(&admin, &setup, &colleague_key, &setup.other_line).await;
    let block = issue_block(&admin.app, &colleague.key, COLLEAGUE_BLOCK_REQUEST).await;
    let answered = receipts(
        &admin.app,
        &colleague.key,
        &[
            fact(
                &record_id(1),
                "scan",
                &colleague.shift,
                ok_scan(11, &box_id(11), &instant(5, 0)),
            ),
            fact(
                &record_id(2),
                "box_closed",
                &colleague.shift,
                box_closed(
                    &box_id(11),
                    &block,
                    3500,
                    &[11],
                    &instant(5, 0),
                    &instant(6, 0),
                ),
            ),
        ],
    )
    .await;
    assert!(
        answered.iter().all(|r| r["outcome"] == "accepted"),
        "{answered:?}"
    );
    close_from_office(&admin, &colleague.shift, "Конец смены").await;
    let (a, b) = (sscc(1500), sscc(3500));
    let id = document(&admin, &[(&a, Some(&a)), (&b, Some(&b))], true).await;
    let (status, rows) = report(&admin, &id, "?variant=full").await;
    assert_eq!(status, StatusCode::OK, "{rows}");
    assert_eq!(
        rows["lines"][0]["items"],
        json!([printed(1), printed(2), printed(3)])
    );
    assert_eq!(rows["lines"][1]["items"], json!([printed(11)]));
}

#[tokio::test]
async fn an_unknown_document_is_not_found_and_a_bad_variant_is_a_validation_error() {
    let admin = admin().await;
    day(&admin, true).await;
    let a = sscc(1500);
    let id = document(&admin, &[(&a, Some(&a))], false).await;
    let (status, body) = report(&admin, "7d1e2f3a-4b5c-4d6e-8f70-8192a3b4c5d6", "").await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    assert_eq!(body["error"]["code"], "not_found");
    for query in ["?variant=all", "?variant=full&x=1"] {
        let (status, body) = report(&admin, &id, query).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{query}: {body}");
        assert_eq!(body["error"]["code"], "validation_failed", "{query}");
    }
}

#[tokio::test]
async fn every_office_role_reads_and_a_device_without_a_session_does_not() {
    let admin = admin().await;
    day(&admin, true).await;
    let a = sscc(1500);
    let id = document(&admin, &[(&a, Some(&a))], false).await;
    let path = format!("/v1/office/disaggregation/{id}/report-data");
    let technologist = admin.technologist().await;
    let (status, body) = admin.call_as(&technologist, "GET", &path, None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, body) = admin
        .app
        .send(empty(with_device(request("GET", &path), &admin.key)))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
    assert_eq!(body["error"]["details"]["credential"], "session");
}

/// Every query of the act searches by an index: none reads through every
/// scan, box or line of the host.
#[tokio::test]
async fn every_query_of_the_act_searches_by_an_index() {
    use markiro_host::routes::office_disaggregation_reports as act;
    let admin = admin().await;
    for (name, sql, binds) in [
        ("document", act::DOCUMENT_SQL, 1),
        ("lines", act::LINES_SQL, 1),
        ("line shifts", act::LINE_SHIFTS_SQL, 1),
        ("shift items", act::SHIFT_ITEMS_SQL, 2),
        ("pallet boxes", act::PALLET_BOXES_SQL, 1),
        ("packings", act::PACKINGS_SQL, 1),
    ] {
        let explain = format!("EXPLAIN QUERY PLAN {sql}");
        let mut query = sqlx::query_as::<_, (i64, i64, i64, String)>(&explain);
        for n in 0..binds {
            query = query.bind(format!("b0000000-0000-4000-8000-00000000000{n}"));
        }
        let plan = query.fetch_all(&admin.app.state.pool).await.unwrap();
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

/// Five reads, one snapshot: writes that commit between them (the
/// organization renamed after the document was read, the box's codes taken
/// out after its lines were read), by a second connection and past the
/// routes, are in no part of the answer. Each write is one a LATER query of
/// the same read would see, so a read on separate connections fails here.
#[tokio::test]
async fn the_act_reads_one_snapshot() {
    let admin = admin().await;
    day(&admin, true).await;
    let a = sscc(1500);
    let id = document(&admin, &[(&a, Some(&a))], false).await;
    let (_, before) = report(&admin, &id, "?variant=full").await;
    assert_eq!(before["lines"][0]["items"].as_array().unwrap().len(), 3);
    let pool = admin.app.state.pool.clone();
    let writer = pool.clone();
    let steps = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let seen = steps.clone();
    let rows = markiro_host::routes::office_disaggregation_reports::read_report_rows(
        &pool,
        &id,
        markiro_proto::disaggregation::DisaggregationReportVariant::Full,
        move |step| {
            let pool = writer.clone();
            seen.lock().unwrap().push(step);
            async move {
                let write = match step {
                    "document" => "UPDATE org_profile SET name = 'Переименована'",
                    "lines" => "UPDATE box_items SET removed_at = '2026-10-08T09:00:00.000Z'",
                    _ => return,
                };
                let done = sqlx::query(write).execute(&pool).await.unwrap();
                assert!(done.rows_affected() >= 1, "{write}");
            }
        },
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(
        *steps.lock().unwrap(),
        ["document", "organization", "lines", "items", "boxes"]
    );
    assert_eq!(serde_json::to_value(&rows).unwrap(), before);
    let (_, after) = report(&admin, &id, "?variant=full").await;
    assert_eq!(after["organization"]["name"], "Переименована");
    assert_eq!(after["lines"][0]["items"], json!([]));
}

async fn record(admin: &Admin, token: &str, id: &str, body: Value) -> (StatusCode, Value) {
    admin
        .call_as(
            token,
            "POST",
            &format!("/v1/office/disaggregation/{id}/exports"),
            Some(body),
        )
        .await
}

fn record_of(packings: u32) -> Value {
    json!({ "formatId": "disaggregation_xml_gismt", "formatVersion": 1, "packingCount": packings })
}

#[tokio::test]
async fn the_file_of_an_applied_document_writes_one_audit_row_and_no_revision() {
    let admin = admin().await;
    day(&admin, true).await;
    let (a, b) = (sscc(1500), sscc(1501));
    let id = document(&admin, &[(&a, Some(&a)), (&b, Some(&b))], true).await;
    let (technologist, technologist_id) = admin.technologist_session().await;
    let revision = support::app::host_revision(&admin.app).await;
    let (status, body) = record(&admin, &admin.token, &id, record_of(2)).await;
    assert_eq!((status, &body), (StatusCode::NO_CONTENT, &Value::Null));
    let (status, _) = record(&admin, &technologist, &id, record_of(2)).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(support::app::host_revision(&admin.app).await, revision);
    let details = json!({
        "formatId": "disaggregation_xml_gismt", "formatVersion": 1, "packingCount": 2
    });
    assert_eq!(
        support::app::audit_trail(&admin.app, "disaggregation.export").await,
        vec![
            admin.row(
                "disaggregation.export",
                "disaggregation_document",
                &id,
                details.clone()
            ),
            support::app::audit_row(
                &technologist_id,
                "disaggregation.export",
                "disaggregation_document",
                &id,
                details,
            ),
        ]
    );
}

#[tokio::test]
async fn what_the_host_refuses_writes_no_row() {
    let admin = admin().await;
    day(&admin, true).await;
    let (a, b) = (sscc(1500), sscc(1501));
    let draft = document(&admin, &[(&a, Some(&a))], false).await;
    let applied = document(&admin, &[(&b, Some(&b))], true).await;
    for (id, body, status) in [
        (draft.as_str(), record_of(1), StatusCode::CONFLICT),
        (applied.as_str(), record_of(2), StatusCode::BAD_REQUEST),
        (
            applied.as_str(),
            json!({ "formatId": "shift_xml_gismt_aggregation", "formatVersion": 1, "packingCount": 1 }),
            StatusCode::BAD_REQUEST,
        ),
        (
            applied.as_str(),
            json!({ "formatId": "disaggregation_xml_gismt", "formatVersion": 2, "packingCount": 1 }),
            StatusCode::BAD_REQUEST,
        ),
        (
            applied.as_str(),
            json!({ "formatId": "disaggregation_xml_gismt", "formatVersion": 1, "packingCount": 1, "fileName": "x.xml" }),
            StatusCode::BAD_REQUEST,
        ),
        (
            "7d1e2f3a-4b5c-4d6e-8f70-8192a3b4c5d6",
            record_of(1),
            StatusCode::NOT_FOUND,
        ),
    ] {
        let (answered, body) = record(&admin, &admin.token, id, body).await;
        assert_eq!(answered, status, "{body}");
    }
    assert!(
        support::app::audit_trail(&admin.app, "disaggregation.export")
            .await
            .is_empty()
    );
}

#[tokio::test]
async fn a_file_record_needs_a_session() {
    let admin = admin().await;
    day(&admin, true).await;
    let a = sscc(1500);
    let id = document(&admin, &[(&a, Some(&a))], true).await;
    let (status, body) = admin
        .app
        .send(support::app::json(
            with_device(
                request("POST", &format!("/v1/office/disaggregation/{id}/exports")),
                &admin.key,
            ),
            record_of(1),
        ))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
    assert_eq!(body["error"]["details"]["credential"], "session");
}

#[tokio::test]
async fn a_cancelled_document_has_no_file() {
    let admin = admin().await;
    day(&admin, true).await;
    let a = sscc(1500);
    let id = document(&admin, &[(&a, Some(&a))], false).await;
    let (_, card) = admin
        .call("GET", &format!("/v1/office/disaggregation/{id}"), None)
        .await;
    let (status, cancelled) = admin
        .call(
            "POST",
            &format!("/v1/office/disaggregation/{id}/cancel"),
            Some(json!({ "expectedRev": card["document"]["rev"] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{cancelled}");
    let (status, body) = record(&admin, &admin.token, &id, record_of(1)).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(
        body["error"]["details"]["constraint"],
        "document_not_applied"
    );
    assert!(
        support::app::audit_trail(&admin.app, "disaggregation.export")
            .await
            .is_empty()
    );
}

#[tokio::test]
async fn a_pallet_document_names_the_pallet_once_in_its_file() {
    let admin = admin().await;
    pallet_day(&admin, true).await;
    let pallet = pallet_sscc(40);
    let id = document(&admin, &[(&pallet, Some(&pallet))], true).await;
    let (status, body) = record(&admin, &admin.token, &id, record_of(1)).await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{body}");
}
