//! Warehouse label reprint of what the cloud history import brought (plan
//! СКЛ + ИМП): an imported unit, box and pallet are found by the same lookup
//! as a native one, answered from the `cloud_history_*` tables, and a record
//! of their reprint is kept with the imported marker. Reprinting writes no
//! code, box, pallet or SSCC and moves no counter.

#[path = "support/history.rs"]
mod history;
mod support;

use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{
    instant, json as json_request, pair_device, record_id, request, with_device, Admin,
};

const SESSION: &str = "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f";
const JOB: &str = "4d5e6f7a-8b9c-4d0e-9f1a-2b3c4d5e6f7a";
const CODE_HASH: &str = "001017f7cf0407aa8955fb37a72dbd63e7b57123800904d8a3544074d11d1d5d";
/// An owner whose shift the export did not carry (and a flat-only code of a
/// validation shift beside it).
const OWNER_ONLY_HASH: &str = "22e35770c8302c84137a6baaf9f1be8d81b13b360894e16d346a173b87e1d542";
const BOX_ID: &str = "20000000-0000-4000-8000-000000000001";
const BOX_SSCC: &str = "046006820000000013";
const PALLET_ID: &str = "30000000-0000-4000-8000-000000000001";
const PALLET_SSCC: &str = "146006820000000010";
const SHIFT_ID: &str = "10000000-0000-4000-8000-000000000001";

async fn lookup(admin: &Admin, key: &str, body: Value) -> Value {
    let (status, body) = admin
        .app
        .send(json_request(
            with_device(request("POST", "/v1/device/warehouse/lookup"), key),
            body,
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body
}

async fn station(admin: &Admin) -> String {
    pair_device(&admin.app, "station").await.1
}

async fn sql(admin: &Admin, text: &str) {
    sqlx::query(text)
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
}

#[tokio::test]
async fn an_imported_unit_is_found_with_its_full_code_and_its_own_facts() {
    let (admin, _) = history::setup(true).await;
    let key = station(&admin).await;
    let body = lookup(&admin, &key, json!({ "codeHash": CODE_HASH })).await;
    assert_eq!(body["status"], "found", "{body}");
    let source = &body["source"];
    assert_eq!(source["kind"], "unit");
    assert_eq!(source["identity"], CODE_HASH);
    assert_eq!(source["subjectId"], CODE_HASH);
    assert_eq!(source["canonical"], "010460068200001321SERIAL\u{1d}91TEST");
    assert_eq!(source["imported"], true);
    assert_eq!(source["shiftId"], SHIFT_ID);
    assert_eq!(source["shiftNumber"], "OCT26-007/S");
    assert_eq!(source["productionDate"], "2026-10-16");
    assert_eq!(source["at"], "2026-10-16T10:00:00.000Z");
    assert_eq!(source["itemCount"], 1);
    assert_eq!(source["operatorName"], Value::Null);
    assert_eq!(source["product"]["gtin14"], "04600682000013");
    assert_eq!(source["product"]["name"], "Milk");
    assert_eq!(source["product"]["chzProductGroupCode"], 8);
    assert!(source.get("sscc").is_none());
}

#[tokio::test]
async fn an_imported_box_and_pallet_are_found_by_their_sscc() {
    let (admin, _) = history::setup(true).await;
    let key = station(&admin).await;
    let body = lookup(&admin, &key, json!({ "sscc": BOX_SSCC })).await;
    assert_eq!(body["status"], "found", "{body}");
    let source = &body["source"];
    assert_eq!(
        (&source["kind"], &source["subjectId"], &source["sscc"]),
        (&json!("box"), &json!(BOX_ID), &json!(BOX_SSCC))
    );
    assert_eq!(source["identity"], BOX_SSCC);
    assert_eq!(source["imported"], true);
    assert_eq!(source["itemCount"], 1);
    assert_eq!(source["at"], "2026-10-16T10:00:00.000Z");
    assert_eq!(source["productionDate"], "2026-10-16");
    assert_eq!(source["shiftNumber"], "OCT26-007/S");
    let body = lookup(&admin, &key, json!({ "sscc": PALLET_SSCC })).await;
    assert_eq!(body["status"], "found", "{body}");
    let source = &body["source"];
    assert_eq!(
        (&source["kind"], &source["subjectId"], &source["sscc"]),
        (&json!("pallet"), &json!(PALLET_ID), &json!(PALLET_SSCC))
    );
    assert_eq!(source["imported"], true);
    assert_eq!(
        (&source["boxCount"], &source["itemCount"]),
        (&json!(1), &json!(1))
    );
    assert_eq!(source["shiftId"], SHIFT_ID);
}

#[tokio::test]
async fn an_unknown_code_and_sscc_stay_not_found() {
    let (admin, _) = history::setup(true).await;
    let key = station(&admin).await;
    for body in [
        json!({ "codeHash": "0".repeat(64) }),
        json!({ "sscc": "046006820000009999" }),
    ] {
        assert_eq!(
            lookup(&admin, &key, body).await,
            json!({ "status": "not_found" })
        );
    }
}

#[tokio::test]
async fn a_batch_still_pending_is_not_found() {
    let (admin, _) = history::setup(false).await;
    let key = station(&admin).await;
    assert_eq!(
        lookup(&admin, &key, json!({ "sscc": BOX_SSCC })).await,
        json!({ "status": "not_found" })
    );
    assert_eq!(
        lookup(&admin, &key, json!({ "codeHash": CODE_HASH })).await,
        json!({ "status": "not_found" })
    );
}

#[tokio::test]
async fn a_released_or_taken_apart_imported_record_is_unavailable() {
    let (admin, _) = history::setup(true).await;
    let key = station(&admin).await;
    sql(
        &admin,
        "UPDATE cloud_history_owners SET released_at = '2026-10-17T00:00:00.000Z'",
    )
    .await;
    assert_eq!(
        lookup(&admin, &key, json!({ "codeHash": CODE_HASH })).await,
        json!({ "status": "unavailable", "reason": "released" })
    );
    sql(
        &admin,
        "UPDATE cloud_history_boxes SET disassembled_at = '2026-10-17T00:00:00.000Z'",
    )
    .await;
    sql(
        &admin,
        "UPDATE cloud_history_pallets SET disassembled_at = '2026-10-17T00:00:00.000Z'",
    )
    .await;
    for sscc in [BOX_SSCC, PALLET_SSCC] {
        assert_eq!(
            lookup(&admin, &key, json!({ "sscc": sscc })).await,
            json!({ "status": "unavailable", "reason": "disassembled" })
        );
    }
}

#[tokio::test]
async fn an_owner_without_its_shift_in_the_export_is_refused_with_its_reason() {
    let (admin, _) = history::setup(true).await;
    let key = station(&admin).await;
    assert_eq!(
        lookup(&admin, &key, json!({ "codeHash": OWNER_ONLY_HASH })).await,
        json!({ "status": "unavailable", "reason": "imported_no_shift" })
    );
}

#[tokio::test]
async fn facts_a_label_needs_but_the_import_lacks_refuse_by_reason() {
    let (admin, _) = history::setup(true).await;
    let key = station(&admin).await;
    sql(
        &admin,
        "UPDATE cloud_history_shifts SET production_date = NULL",
    )
    .await;
    for body in [
        json!({ "codeHash": CODE_HASH }),
        json!({ "sscc": BOX_SSCC }),
        json!({ "sscc": PALLET_SSCC }),
    ] {
        assert_eq!(
            lookup(&admin, &key, body).await,
            json!({ "status": "unavailable", "reason": "imported_no_production_date" })
        );
    }
    sql(
        &admin,
        "UPDATE cloud_history_shifts SET production_date = '2026-10-16'",
    )
    .await;
    // The catalog does not know the product (neither by id nor by GTIN).
    sql(&admin, "UPDATE products SET archived = 1").await;
    for body in [
        json!({ "codeHash": CODE_HASH }),
        json!({ "sscc": BOX_SSCC }),
        json!({ "sscc": PALLET_SSCC }),
    ] {
        assert_eq!(
            lookup(&admin, &key, body).await,
            json!({ "status": "unavailable", "reason": "imported_product_unknown" })
        );
    }
}

fn reprint(n: u32, kind: &str, subject_id: &str, identity: &str) -> Value {
    json!({
        "id": record_id(n), "sessionId": SESSION, "jobId": JOB, "attempt": 1,
        "subjectKind": kind, "subjectId": subject_id, "identity": identity,
        "reasonCode": "damaged", "repair": null, "templateId": "template-1", "templateRev": 3,
        "outcome": "sent", "errorCode": null, "operatorId": null, "occurredAt": instant(20, 0)
    })
}

async fn counts(admin: &Admin) -> Vec<i64> {
    let mut all = Vec::new();
    for table in [
        "scans",
        "code_owners",
        "boxes",
        "pallets",
        "sscc_blocks",
        "shifts",
        "cloud_history_codes",
        "cloud_history_boxes",
        "cloud_history_pallets",
        "cloud_history_items",
        "cloud_history_owners",
    ] {
        all.push(
            sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table}"))
                .fetch_one(&admin.app.state.pool)
                .await
                .unwrap(),
        );
    }
    let next: Vec<(String, i64, i64, i64)> = sqlx::query_as(
        "SELECT issuer_prefix, extension, next_serial, rev FROM sscc_counters ORDER BY 1, 2",
    )
    .fetch_all(&admin.app.state.pool)
    .await
    .unwrap();
    all.extend(next.iter().flat_map(|row| [row.1, row.2, row.3]));
    all
}

#[tokio::test]
async fn reprint_records_of_imported_subjects_are_kept_marked_and_change_nothing() {
    let (admin, _) = history::setup(true).await;
    let key = station(&admin).await;
    let before = counts(&admin).await;
    let records = [
        reprint(1, "unit", CODE_HASH, CODE_HASH),
        reprint(2, "box", BOX_ID, BOX_SSCC),
        reprint(3, "pallet", PALLET_ID, PALLET_SSCC),
        // A native-looking subject the host has not got is still unknown.
        reprint(4, "box", "20000000-0000-4000-8000-0000000000ff", BOX_SSCC),
    ];
    let (status, body) = admin
        .app
        .send(json_request(
            with_device(request("POST", "/v1/device/warehouse/reprints"), &key),
            json!({ "records": records }),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let outcomes: Vec<(Value, Value)> = body["receipts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| (r["outcome"].clone(), r["code"].clone()))
        .collect();
    assert_eq!(
        outcomes,
        vec![
            (json!("accepted"), Value::Null),
            (json!("accepted"), Value::Null),
            (json!("accepted"), Value::Null),
            (json!("rejected"), json!("subject_unknown")),
        ]
    );
    let rows: Vec<(String, String, i64)> = sqlx::query_as(
        "SELECT record_id, subject_kind, imported FROM warehouse_reprints ORDER BY record_id",
    )
    .fetch_all(&admin.app.state.pool)
    .await
    .unwrap();
    assert_eq!(
        rows,
        vec![
            (record_id(1), "unit".to_owned(), 1),
            (record_id(2), "box".to_owned(), 1),
            (record_id(3), "pallet".to_owned(), 1),
        ]
    );
    assert_eq!(counts(&admin).await, before);
}

/// Every imported read is a seek by its key: only the one-row batch table may
/// be scanned.
#[tokio::test]
async fn the_imported_reads_seek_by_their_keys() {
    use markiro_host::cloud_history::warehouse as imported;
    let (admin, _) = history::setup(true).await;
    for (sql, binds) in [
        (imported::UNIT_SQL, 1),
        (imported::BOX_SQL, 1),
        (imported::PALLET_SQL, 1),
        (imported::SHIFT_SQL, 1),
        (imported::PRODUCT_BY_ID_SQL, 1),
        (imported::PRODUCT_BY_GTIN_SQL, 1),
        (imported::UNIT_EXISTS_SQL, 2),
        (imported::BOX_EXISTS_SQL, 2),
        (imported::PALLET_EXISTS_SQL, 2),
    ] {
        let text = format!("EXPLAIN QUERY PLAN {sql}");
        let mut query = sqlx::query_as::<_, (i64, i64, i64, String)>(&text);
        for _ in 0..binds {
            query = query.bind("x");
        }
        let steps: Vec<String> = query
            .fetch_all(&admin.app.state.pool)
            .await
            .unwrap()
            .into_iter()
            .map(|(_, _, _, step)| step)
            .collect();
        assert!(
            steps
                .iter()
                .all(|step| !step.starts_with("SCAN") || step.contains("cloud_history_batches")),
            "{sql}: {steps:?}"
        );
    }
}
