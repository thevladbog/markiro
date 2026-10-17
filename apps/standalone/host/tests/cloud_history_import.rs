mod support;

use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{
    admin, audit_trail, cloud_import_request, host_revision, login, seed_office_user, Admin,
    IMPORT_ID,
};

const IMPORT: &str = "/v1/office/import/history";
const COMPLETE: &str = "/v1/office/import/history/complete";

#[tokio::test]
async fn external_box_provenance_survives_owner_only_activation_and_retries() {
    let a = setup().await;
    let owner: Value = serde_json::from_str(include_str!(
        "../../proto/fixtures/cloud-history-external-owner.json"
    ))
    .unwrap();
    let mut r = request();
    for k in ["shifts", "codes", "boxes", "items", "pallets"] {
        r["part"]["payload"][k] = json!([]);
    }
    r["part"]["payload"]["owners"] = json!([owner]);
    seal(&mut r);
    let (status, body) = a.call("POST", IMPORT, Some(r.clone())).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let completion = json!({"batchId": r["manifest"]["checksum"]});
    let (status, completed) = a.call("POST", COMPLETE, Some(completion.clone())).await;
    assert_eq!(status, StatusCode::OK, "{completed}");
    assert_eq!(
        completed["counts"],
        json!({"shifts":0,"codes":0,"boxes":0,"items":0,"pallets":0,"owners":1})
    );
    let mut conn = a.app.state.pool.acquire().await.unwrap();
    let found =
        markiro_host::cloud_history::completed_owner(&mut conn, owner["hash"].as_str().unwrap())
            .await
            .unwrap()
            .unwrap();
    assert_eq!(found.shift_id, owner["shiftId"].as_str().unwrap());
    assert_eq!(found.number, owner["number"].as_str().unwrap());
    assert_eq!(found.scanned_at, owner["scannedAt"].as_str().unwrap());
    assert_eq!(found.box_id.as_deref(), owner["boxId"].as_str());
    drop(conn);
    let revision = host_revision(&a.app).await;
    let audits = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM audit_log")
        .fetch_one(&a.app.state.pool)
        .await
        .unwrap();
    assert_eq!(
        a.call("POST", IMPORT, Some(r)).await,
        (StatusCode::OK, completed.clone())
    );
    assert_eq!(
        a.call("POST", COMPLETE, Some(completion)).await,
        (StatusCode::OK, completed)
    );
    assert_eq!(host_revision(&a.app).await, revision);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM audit_log")
            .fetch_one(&a.app.state.pool)
            .await
            .unwrap(),
        audits
    );
}

#[tokio::test]
async fn owner_provenance_cannot_bypass_imported_shift_or_box_membership() {
    for case in ["missing_box", "missing_item", "foreign_owner"] {
        let a = setup().await;
        let mut r = request();
        // Remove the valid membership so the owner-to-item rule must reject it.
        r["part"]["payload"]["items"] = json!([]);
        if case == "missing_box" {
            r["part"]["payload"]["owners"][0]["boxId"] =
                json!("99999999-0000-4000-8000-000000000001");
        } else if case == "foreign_owner" {
            let mut external: Value = serde_json::from_str(include_str!(
                "../../proto/fixtures/cloud-history-external-owner.json"
            ))
            .unwrap();
            external["boxId"] = r["part"]["payload"]["boxes"][0]["id"].clone();
            r["part"]["payload"]["owners"][0]["boxId"] = Value::Null;
            r["part"]["payload"]["owners"]
                .as_array_mut()
                .unwrap()
                .push(external);
        }
        seal(&mut r);
        let (status, body) = a.call("POST", IMPORT, Some(r.clone())).await;
        assert_eq!(status, StatusCode::OK, "{case}: {body}");
        let (status, body) = a
            .call(
                "POST",
                COMPLETE,
                Some(json!({"batchId":r["manifest"]["checksum"]})),
            )
            .await;
        assert_eq!(status, StatusCode::CONFLICT, "{case}: {body}");
        assert_eq!(body["error"]["details"]["constraint"], "history_graph");
    }
}

#[tokio::test]
async fn history_state_requires_current_administrator_even_without_a_batch() {
    let a = setup().await;
    let token = a.technologist().await;
    for phase in ["empty", "pending", "complete"] {
        if phase == "pending" {
            assert_eq!(
                a.call("POST", IMPORT, Some(request())).await.0,
                StatusCode::OK
            );
        } else if phase == "complete" {
            assert_eq!(
                a.call(
                    "POST",
                    COMPLETE,
                    Some(json!({"batchId": request()["manifest"]["checksum"]}))
                )
                .await
                .0,
                StatusCode::OK
            );
        }
        let (status, body) = a.call_as(&token, "GET", IMPORT, None).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
        assert!(body.get("manifest").is_none());
        assert_eq!(a.call("GET", IMPORT, None).await.0, StatusCode::OK);
    }
    sqlx::query("UPDATE office_users SET role='technologist' WHERE role='admin'")
        .execute(&a.app.state.pool)
        .await
        .unwrap();
    assert_eq!(a.call("GET", IMPORT, None).await.0, StatusCode::FORBIDDEN);
}

fn request() -> Value {
    let mut lines = include_str!("../../proto/fixtures/cloud-history.jsonl").lines();
    let mut r = json!({"manifest": serde_json::from_str::<Value>(lines.next().unwrap()).unwrap(),
        "part": serde_json::from_str::<Value>(lines.next().unwrap()).unwrap(), "dryRun": false});
    r["manifest"]["source"]["tenantId"] = json!("imp-test-atoll");
    r["manifest"]["checksum"] =
        json!(markiro_host::cloud_history::validation::checksum(&r["manifest"]).unwrap());
    r
}

async fn setup() -> Admin {
    let a = admin().await;
    let (status, body) = a
        .call(
            "POST",
            "/v1/office/import",
            Some(cloud_import_request(IMPORT_ID, false)),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    a
}

#[tokio::test]
async fn empty_history_activates_and_known_block_recovery_waits_for_pending_import() {
    use support::app::{json as body, request as req, with_device};
    let a = setup().await;
    let mut r = request();
    for k in ["shifts", "codes", "boxes", "items", "pallets", "owners"] {
        r["part"]["payload"][k] = json!([]);
    }
    seal(&mut r);
    assert_eq!(
        a.call("POST", IMPORT, Some(r.clone())).await.0,
        StatusCode::OK
    );
    sqlx::query("UPDATE site SET restore_epoch='99999999-0000-4000-8000-000000000001'")
        .execute(&a.app.state.pool)
        .await
        .unwrap();
    let blocks = json!({"blocks":[{"id":"99999999-0000-4000-8000-000000000002","issuerPrefix":"460068200","extension":0,"fromSerial":30000,"toSerial":31999}]});
    let (status, result) = a
        .app
        .send(body(
            with_device(req("POST", "/v1/device/sscc/blocks/known"), &a.key),
            blocks.clone(),
        ))
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{result}");
    assert_eq!(
        result["error"]["details"]["constraint"],
        "cloud_history_pending"
    );
    assert_eq!(
        a.call(
            "POST",
            COMPLETE,
            Some(json!({"batchId":r["manifest"]["checksum"]}))
        )
        .await
        .0,
        StatusCode::OK
    );
    let (status, result) = a
        .app
        .send(body(
            with_device(req("POST", "/v1/device/sscc/blocks/known"), &a.key),
            blocks.clone(),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    let rev = host_revision(&a.app).await;
    assert_eq!(
        a.app
            .send(body(
                with_device(req("POST", "/v1/device/sscc/blocks/known"), &a.key),
                blocks
            ))
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(host_revision(&a.app).await, rev);
}

#[tokio::test]
async fn oversized_raw_body_is_sanitized_and_non_admin_is_refused_before_buffering() {
    use axum::body::Body;
    use support::app::{request as req, with_session};
    let a = setup().await;
    seed_office_user(&a.app, "bounded", "technologist", "correct horse battery").await;
    let token = login(&a.app, &a.key, "bounded", "correct horse battery").await;
    for (session, expected) in [
        (&a.token, StatusCode::BAD_REQUEST),
        (&token, StatusCode::FORBIDDEN),
    ] {
        let request = with_session(req("POST", IMPORT), &a.key, session)
            .header("content-type", "application/json")
            .body(Body::from("x".repeat(8 * 1048576 + 1)))
            .unwrap();
        let (status, result) = a.app.send(request).await;
        assert_eq!(status, expected, "{result}");
        assert!(result.to_string().len() < 500);
    }
}

#[tokio::test]
async fn cancel_recovers_invalid_staging_is_admin_only_and_repeats_without_changes() {
    let a = setup().await;
    let r = request();
    assert_eq!(
        a.call("POST", IMPORT, Some(r.clone())).await.0,
        StatusCode::OK
    );
    let cancel = "/v1/office/import/history/cancel";
    seed_office_user(&a.app, "reader", "technologist", "correct horse battery").await;
    let token = login(&a.app, &a.key, "reader", "correct horse battery").await;
    assert_eq!(
        a.call_as(&token, "GET", IMPORT, None).await.0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        a.call_as(&token, "POST", cancel, Some(json!({"garbage":true})))
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    let rev = host_revision(&a.app).await;
    assert_eq!(
        a.call(
            "POST",
            cancel,
            Some(json!({"batchId":format!("sha256:{}","0".repeat(64))}))
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(host_revision(&a.app).await, rev);
    let body = json!({"batchId":r["manifest"]["checksum"]});
    let (status, result) = a.call("POST", cancel, Some(body.clone())).await;
    assert_eq!((status, result), (StatusCode::OK, Value::Null));
    let rev = host_revision(&a.app).await;
    assert_eq!(
        a.call("POST", cancel, Some(body.clone())).await,
        (StatusCode::OK, Value::Null)
    );
    assert_eq!(host_revision(&a.app).await, rev);
    assert_eq!(a.call("GET", IMPORT, None).await.1, Value::Null);
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM cloud_history_owners")
        .fetch_one(&a.app.state.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    assert_eq!(
        a.call("POST", IMPORT, Some(r.clone())).await.0,
        StatusCode::CONFLICT
    );
    assert_eq!(audit_trail(&a.app,"import.cloud_history.cancel").await,[a.row("import.cloud_history.cancel","cloud_history",r["manifest"]["checksum"].as_str().unwrap(),json!({"sourceTenantId":"imp-test-atoll","receivedParts":1,"counts":r["manifest"]["counts"]}))]);
    let mut corrected = r.clone();
    corrected["manifest"]["exportedAt"] = json!("2026-10-18T00:00:00Z");
    seal(&mut corrected);
    assert_eq!(
        a.call("POST", IMPORT, Some(corrected.clone())).await.0,
        StatusCode::OK
    );
    let rev = host_revision(&a.app).await;
    assert_eq!(
        a.call(
            "POST",
            cancel,
            Some(json!({"batchId":r["manifest"]["checksum"]}))
        )
        .await,
        (StatusCode::OK, Value::Null)
    );
    assert_eq!(host_revision(&a.app).await, rev);
    let body = json!({"batchId":corrected["manifest"]["checksum"]});
    assert_eq!(
        a.call("POST", COMPLETE, Some(body.clone())).await.0,
        StatusCode::OK
    );
    assert_eq!(
        a.call("POST", cancel, Some(body)).await.0,
        StatusCode::CONFLICT
    );
    assert_eq!(a.call("GET", IMPORT, None).await.1["status"], "complete");
}

#[tokio::test]
async fn activation_advances_lagging_counters_and_keeps_higher_existing_values() {
    let a = setup().await;
    let r = request();
    // The owner-only JAN24 number must participate too.
    sqlx::query("UPDATE sscc_counters SET next_serial=0 WHERE extension=1")
        .execute(&a.app.state.pool)
        .await
        .unwrap();
    assert_eq!(
        a.call("POST", IMPORT, Some(r.clone())).await.0,
        StatusCode::OK
    );
    assert_eq!(
        a.call(
            "POST",
            COMPLETE,
            Some(json!({"batchId":r["manifest"]["checksum"]}))
        )
        .await
        .0,
        StatusCode::OK
    );
    for (month, expected) in [("OCT26", 8i64), ("JAN24", 1), ("SEP26", 41)] {
        let n: i64 =
            sqlx::query_scalar("SELECT last_seq FROM shift_number_counters WHERE month_key=?")
                .bind(month)
                .fetch_one(&a.app.state.pool)
                .await
                .unwrap();
        assert_eq!(n, expected, "{month}");
    }
    let n: i64 = sqlx::query_scalar(
        "SELECT next_serial FROM sscc_counters WHERE issuer_prefix='460068200' AND extension=1",
    )
    .fetch_one(&a.app.state.pool)
    .await
    .unwrap();
    assert_eq!(n, 2);
    let n: i64 = sqlx::query_scalar(
        "SELECT next_serial FROM sscc_counters WHERE issuer_prefix='460068200' AND extension=0",
    )
    .fetch_one(&a.app.state.pool)
    .await
    .unwrap();
    assert!(n >= 1500);
}

#[tokio::test]
async fn pending_import_blocks_planning_and_new_sscc_ranges_then_completion_reopens_them() {
    use support::app::{json as body, request as req, shift_body, with_device, ShiftSetup};
    let a = setup().await;
    let lines = a.call("GET", "/v1/office/lines", None).await.1;
    let line = lines.as_array().unwrap()[0]["id"].as_str().unwrap();
    let setup = ShiftSetup {
        product: "11111111-1111-4111-8111-111111111111".into(),
        template: "0d0d0000-0000-4000-8000-000000000001".into(),
        line: line.into(),
        other_line: line.into(),
    };
    let r = request();
    assert_eq!(
        a.call("POST", IMPORT, Some(r.clone())).await.0,
        StatusCode::OK
    );
    let (status, result) = a
        .call("POST", "/v1/office/shifts", Some(shift_body(&setup)))
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{result}");
    assert_eq!(
        result["error"]["details"]["constraint"],
        "cloud_history_pending"
    );
    let block = json!({"requestId":"99999999-0000-4000-8000-000000000001","issuerPrefix":"460068200","extension":0});
    let (status, result) = a
        .app
        .send(body(
            with_device(req("POST", "/v1/device/sscc/blocks"), &a.key),
            block.clone(),
        ))
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{result}");
    assert_eq!(
        result["error"]["details"]["constraint"],
        "cloud_history_pending"
    );
    let device_shift = json!({"requestId":"99999999-0000-4000-8000-000000000002","productId":setup.product,"boxTemplateId":setup.template,"productionDate":"2026-10-08"});
    let (status, result) = a
        .app
        .send(body(
            with_device(req("POST", "/v1/device/shifts"), &a.key),
            device_shift,
        ))
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{result}");
    assert_eq!(
        result["error"]["details"]["constraint"],
        "cloud_history_pending"
    );
    assert_eq!(
        a.call(
            "POST",
            COMPLETE,
            Some(json!({"batchId":r["manifest"]["checksum"]}))
        )
        .await
        .0,
        StatusCode::OK
    );
    let (status, result) = a
        .app
        .send(body(
            with_device(req("POST", "/v1/device/sscc/blocks"), &a.key),
            block.clone(),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    let rev = host_revision(&a.app).await;
    // An accepted part is still a no-op after local allocation has begun.
    assert_eq!(
        a.call("POST", IMPORT, Some(r.clone())).await.0,
        StatusCode::OK
    );
    assert_eq!(
        a.call(
            "POST",
            COMPLETE,
            Some(json!({"batchId":r["manifest"]["checksum"]}))
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(host_revision(&a.app).await, rev);
}

#[tokio::test]
async fn backup_restore_preserves_pending_and_completed_batches() {
    use sqlx::Connection;
    for complete in [false, true] {
        let a = setup().await;
        let r = request();
        assert_eq!(
            a.call("POST", IMPORT, Some(r.clone())).await.0,
            StatusCode::OK
        );
        if complete {
            assert_eq!(
                a.call(
                    "POST",
                    COMPLETE,
                    Some(json!({"batchId":r["manifest"]["checksum"]}))
                )
                .await
                .0,
                StatusCode::OK
            );
        }
        let expected = a.call("GET", IMPORT, None).await.1;
        let folder = a.app.dir().join("backups");
        std::fs::create_dir_all(&folder).unwrap();
        let mut conn = support::backup::worker_conn(&a.app).await;
        let manifest = markiro_host::backup::copy::make_copy(
            &mut conn,
            &folder,
            a.app.state.now(),
            markiro_proto::backup::BackupTrigger::Scheduled,
            &a.app.state.host_id,
        )
        .await
        .unwrap();
        conn.close().await.unwrap();
        assert_eq!(manifest.schema_version, 48);
        let restored = tempfile::tempdir().unwrap();
        let paths = markiro_host::config::HostPaths::new(restored.path());
        markiro_host::restore::restore(
            &paths,
            &folder.join(manifest.file),
            false,
            a.app.state.now(),
        )
        .await
        .unwrap();
        let pool = markiro_host::db::open(&paths.database_file())
            .await
            .unwrap();
        let mut conn = pool.acquire().await.unwrap();
        assert_eq!(
            serde_json::to_value(markiro_host::cloud_history::state(&mut conn).await.unwrap())
                .unwrap(),
            expected
        );
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM cloud_history_codes")
            .fetch_one(&mut *conn)
            .await
            .unwrap();
        assert_eq!(count, 2);
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM shifts")
            .fetch_one(&mut *conn)
            .await
            .unwrap();
        assert_eq!(count, 0);
        let canonical: String =
            sqlx::query_scalar("SELECT canonical FROM cloud_history_codes WHERE flat_only=0")
                .fetch_one(&mut *conn)
                .await
                .unwrap();
        assert!(canonical.contains('\u{1d}'));
    }
}

#[tokio::test]
async fn upgrade_from_0046_preserves_existing_state_and_adds_empty_history() {
    use sqlx::migrate::Migrator;
    use sqlx::ConnectOptions;
    let dir = tempfile::tempdir().unwrap();
    let mut conn = markiro_host::db::options(&dir.path().join("old.db"))
        .create_if_missing(true)
        .connect()
        .await
        .unwrap();
    let old = Migrator {
        migrations: markiro_host::db::MIGRATOR
            .iter()
            .filter(|m| m.version <= 46)
            .cloned()
            .collect::<Vec<_>>()
            .into(),
        ..Migrator::DEFAULT
    };
    old.run(&mut conn).await.unwrap();
    sqlx::query("UPDATE site SET initialized_at='2026-10-16T10:00:00Z' WHERE id=1")
        .execute(&mut conn)
        .await
        .unwrap();
    markiro_host::db::MIGRATOR.run(&mut conn).await.unwrap();
    let initialized: String = sqlx::query_scalar("SELECT initialized_at FROM site WHERE id=1")
        .fetch_one(&mut conn)
        .await
        .unwrap();
    assert_eq!(initialized, "2026-10-16T10:00:00Z");
    assert!(markiro_host::cloud_history::state(&mut conn)
        .await
        .unwrap()
        .is_none());
    let violations: Vec<(String, i64, String, i64)> = sqlx::query_as("PRAGMA foreign_key_check")
        .fetch_all(&mut conn)
        .await
        .unwrap();
    assert!(violations.is_empty());
}

#[tokio::test]
async fn duplicate_rows_are_atomic_and_bounded_requests_are_refused() {
    let a = setup().await;
    let mut r = request();
    let duplicate = r["part"]["payload"]["owners"][0].clone();
    r["part"]["payload"]["owners"]
        .as_array_mut()
        .unwrap()
        .push(duplicate);
    seal(&mut r);
    let (status, result) = a.call("POST", IMPORT, Some(r)).await;
    assert_eq!(status, StatusCode::CONFLICT, "{result}");
    assert_eq!(a.call("GET", IMPORT, None).await.1, Value::Null);
    let mut r = request();
    r["part"]["payload"]["codes"][0]["canonical"] = json!("x".repeat(4 * 1048576));
    seal(&mut r);
    assert_eq!(
        a.call("POST", IMPORT, Some(r)).await.0,
        StatusCode::BAD_REQUEST
    );
    let mut r = request();
    r["manifest"]["source"]["tenantName"] = json!("x".repeat(1048576));
    seal(&mut r);
    assert_eq!(
        a.call("POST", IMPORT, Some(r)).await.0,
        StatusCode::BAD_REQUEST
    );
    let mut r = request();
    r["manifest"]["counts"]["codes"] = json!(5001);
    r["manifest"]["checksum"] =
        json!(markiro_host::cloud_history::validation::checksum(&r["manifest"]).unwrap());
    assert_eq!(
        a.call("POST", IMPORT, Some(r)).await.0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(a.call("GET", IMPORT, None).await.1, Value::Null);
}

fn seal(r: &mut Value) {
    use markiro_host::cloud_history::validation::checksum;
    r["part"]["checksum"] = json!(checksum(&r["part"]).unwrap());
    let count = |payload: &Value| {
        json!({
            "shifts": payload["shifts"].as_array().unwrap().len(),
            "codes": payload["codes"].as_array().unwrap().len(),
            "boxes": payload["boxes"].as_array().unwrap().len(),
            "items": payload["items"].as_array().unwrap().len(),
            "pallets": payload["pallets"].as_array().unwrap().len(),
            "owners": payload["owners"].as_array().unwrap().len()
        })
    };
    r["manifest"]["parts"] = json!([{"index": 0, "checksum": r["part"]["checksum"], "counts": count(&r["part"]["payload"])}]);
    r["manifest"]["counts"] = count(&r["part"]["payload"]);
    r["manifest"]["checksum"] = json!(checksum(&r["manifest"]).unwrap());
}
fn split() -> (Value, Value) {
    use markiro_host::cloud_history::validation::checksum;
    let mut first = request();
    let mut second = request();
    for key in ["shifts", "codes", "boxes", "items", "pallets"] {
        second["part"]["payload"][key] = json!([]);
    }
    first["part"]["payload"]["owners"] = json!([]);
    seal(&mut first);
    seal(&mut second);
    second["part"]["index"] = json!(1);
    second["part"]["checksum"] = json!(checksum(&second["part"]).unwrap());
    let second_counts = second["manifest"]["counts"].clone();
    first["manifest"]["counts"]["owners"] = second_counts["owners"].clone();
    first["manifest"]["parts"]
        .as_array_mut()
        .unwrap()
        .push(json!({"index":1,"checksum":second["part"]["checksum"],"counts":second_counts}));
    first["manifest"]["checksum"] = json!(checksum(&first["manifest"]).unwrap());
    second["manifest"] = first["manifest"].clone();
    (first, second)
}

#[tokio::test]
async fn source_and_gln_are_bound_to_the_catalog_and_an_accepted_manifest_is_immutable() {
    let a = setup().await;
    for (field, value) in [("source", "foreign-tenant"), ("gln", "1234567890123")] {
        let mut r = request();
        if field == "source" {
            r["manifest"]["source"]["tenantId"] = json!(value);
        } else {
            r["manifest"]["organization"]["gln"] = json!(value);
        }
        seal(&mut r);
        let (status, body) = a.call("POST", IMPORT, Some(r)).await;
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
    }
    let r = request();
    assert_eq!(
        a.call("POST", IMPORT, Some(r.clone())).await.0,
        StatusCode::OK
    );
    let mut changed = r.clone();
    changed["manifest"]["exportedAt"] = json!("2026-10-18T00:00:00Z");
    seal(&mut changed);
    assert_eq!(
        a.call("POST", IMPORT, Some(changed)).await.0,
        StatusCode::CONFLICT
    );
    let mut changed = r.clone();
    changed["part"]["payload"]["codes"][0]["canonical"] =
        json!("010460068200001321SERIAL\u{001d}91CHANGED");
    seal(&mut changed);
    assert_eq!(
        a.call("POST", IMPORT, Some(changed)).await.0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        a.call("GET", IMPORT, None).await.1["batchId"],
        r["manifest"]["checksum"]
    );
}

#[tokio::test]
async fn interrupted_parts_survive_restart_and_are_invisible_until_complete() {
    let mut a = setup().await;
    let (first, second) = split();
    let hash = request()["part"]["payload"]["owners"][0]["hash"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        a.call("POST", IMPORT, Some(first.clone())).await.0,
        StatusCode::OK
    );
    let (status, body) = a
        .call(
            "POST",
            COMPLETE,
            Some(json!({"batchId":first["manifest"]["checksum"]})),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"]["details"]["constraint"], "history_incomplete");
    a.app.state.pool.close().await;
    let pool = markiro_host::db::open(&a.app.dir().join("host.db"))
        .await
        .unwrap();
    a.app.state =
        markiro_host::server::AppState::new(pool, a.app.state.host_id.clone(), a.app.clock.clone());
    assert_eq!(
        a.call("GET", IMPORT, None).await.1["receivedIndices"],
        json!([0])
    );
    assert_eq!(a.call("POST", IMPORT, Some(second)).await.0, StatusCode::OK);
    {
        let mut conn = a.app.state.pool.acquire().await.unwrap();
        assert!(
            markiro_host::cloud_history::completed_owner(&mut conn, &hash)
                .await
                .unwrap()
                .is_none()
        );
    }
    let (status, body) = a
        .call(
            "POST",
            COMPLETE,
            Some(json!({"batchId":first["manifest"]["checksum"]})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let mut conn = a.app.state.pool.acquire().await.unwrap();
    let owner = markiro_host::cloud_history::completed_owner(&mut conn, &hash)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(owner.number, "OCT26-007/S");
    assert_eq!(
        owner.box_id.as_deref(),
        Some("20000000-0000-4000-8000-000000000001")
    );
    let canonical: String =
        sqlx::query_scalar("SELECT canonical FROM cloud_history_codes WHERE hash=?")
            .bind(hash)
            .fetch_one(&mut *conn)
            .await
            .unwrap();
    assert_eq!(
        canonical,
        request()["part"]["payload"]["codes"][0]["canonical"]
            .as_str()
            .unwrap()
    );
    let source:String=sqlx::query_scalar("SELECT source_json FROM cloud_history_shifts WHERE id='10000000-0000-4000-8000-000000000001'").fetch_one(&mut *conn).await.unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&source).unwrap()["shelfLifeDays"],
        30
    );
}

#[tokio::test]
async fn semantic_checks_reject_resealed_bad_values_without_echoing_them() {
    let a = setup().await;
    for (pointer, value) in [
        ("/part/payload/shifts/0/id", json!("SENSITIVE_BAD_ID")),
        ("/part/payload/shifts/0/number", json!("OCT26-999/S")),
        ("/part/payload/shifts/0/numberMonthKey", json!("АБВГД")),
        ("/part/payload/shifts/0/mode", json!("SENSITIVE_BAD_MODE")),
        ("/part/payload/shifts/0/productionDate", json!("2026-02-30")),
        ("/part/payload/shifts/0/shelfLifeDays", json!(0)),
        (
            "/part/payload/shifts/0/plannedQty",
            json!(9007199254740992u64),
        ),
        ("/part/payload/codes/0/hash", json!("a".repeat(64))),
        (
            "/part/payload/codes/0/serial",
            json!("SENSITIVE_BAD_SERIAL"),
        ),
        (
            "/part/payload/codes/0/canonical",
            json!("010460068200001321SERIAL\u{001d}91TEST\u{001d}91REPEAT"),
        ),
        (
            "/part/payload/codes/0/scannedAt",
            json!("2026-99-01T00:00:00Z"),
        ),
        ("/part/payload/boxes/0/sscc", json!("046006820000000014")),
        ("/part/payload/pallets/0/kind", json!("warehouse")),
        ("/part/payload/owners/1/number", json!("BAD")),
        ("/manifest/organization/timeZone", json!("invalid zone")),
    ] {
        let mut r = request();
        *r.pointer_mut(pointer).unwrap() = value;
        seal(&mut r);
        let (status, body) = a.call("POST", IMPORT, Some(r)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{pointer}: {body}");
        assert!(!body.to_string().contains("SENSITIVE_"));
    }
    assert_eq!(a.call("GET", IMPORT, None).await.1, Value::Null);
}

#[tokio::test]
async fn graph_refuses_dangling_links_duplicate_sscc_and_inconsistent_final_membership() {
    for (pointer, value) in [
        (
            "/part/payload/boxes/0/palletId",
            json!("99999999-0000-4000-8000-000000000001"),
        ),
        ("/part/payload/owners/0/boxId", Value::Null),
        (
            "/part/payload/owners/0/scannedAt",
            json!("2026-10-16T10:02:00.000Z"),
        ),
        ("/part/payload/owners/0/number", json!("OCT26-009/S")),
        ("/part/payload/pallets/0/sscc", json!("046006820000000013")),
        ("/part/payload/codes/0/flatOnly", json!(true)),
    ] {
        let a = setup().await;
        let mut r = request();
        *r.pointer_mut(pointer).unwrap() = value;
        seal(&mut r);
        let (status, body) = a.call("POST", IMPORT, Some(r.clone())).await;
        assert_eq!(status, StatusCode::OK, "{pointer}: {body}");
        let (status, body) = a
            .call(
                "POST",
                COMPLETE,
                Some(json!({"batchId":r["manifest"]["checksum"]})),
            )
            .await;
        assert_eq!(status, StatusCode::CONFLICT, "{pointer}: {body}");
        assert_eq!(a.call("GET", IMPORT, None).await.1["status"], "pending");
    }
}

#[tokio::test]
async fn warehouse_pallets_keep_their_own_frozen_product_metadata() {
    let a = setup().await;
    let mut r = request();
    r["part"]["payload"]["pallets"][0]["kind"] = json!("warehouse");
    r["part"]["payload"]["pallets"][0]["shiftId"] = Value::Null;
    r["part"]["payload"]["pallets"][0]["productId"] =
        r["part"]["payload"]["shifts"][0]["productId"].clone();
    r["part"]["payload"]["pallets"][0]["productName"] = json!("Frozen warehouse name");
    r["part"]["payload"]["pallets"][0]["shelfLifeDays"] = json!(42);
    seal(&mut r);
    assert_eq!(
        a.call("POST", IMPORT, Some(r.clone())).await.0,
        StatusCode::OK
    );
    let (status, body) = a
        .call(
            "POST",
            COMPLETE,
            Some(json!({"batchId":r["manifest"]["checksum"]})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let frozen: (String, String, i64) =
        sqlx::query_as("SELECT product_name,gtin14,shelf_life_days FROM cloud_history_pallets")
            .fetch_one(&a.app.state.pool)
            .await
            .unwrap();
    assert_eq!(
        frozen,
        ("Frozen warehouse name".into(), "04600682000013".into(), 42)
    );
}

#[tokio::test]
async fn accepted_rows_do_not_reapply_released_ownership() {
    let a = setup().await;
    let r = request();
    assert_eq!(
        a.call("POST", IMPORT, Some(r.clone())).await.0,
        StatusCode::OK
    );
    assert_eq!(
        a.call(
            "POST",
            COMPLETE,
            Some(json!({"batchId":r["manifest"]["checksum"]}))
        )
        .await
        .0,
        StatusCode::OK
    );
    sqlx::query("UPDATE cloud_history_owners SET released_at='2026-10-18T00:00:00Z'")
        .execute(&a.app.state.pool)
        .await
        .unwrap();
    let rev = host_revision(&a.app).await;
    assert_eq!(
        a.call("POST", IMPORT, Some(r.clone())).await.0,
        StatusCode::OK
    );
    let mut conn = a.app.state.pool.acquire().await.unwrap();
    assert!(markiro_host::cloud_history::completed_owner(
        &mut conn,
        r["part"]["payload"]["owners"][0]["hash"].as_str().unwrap()
    )
    .await
    .unwrap()
    .is_none());
    assert_eq!(host_revision(&a.app).await, rev);
}

#[tokio::test]
async fn stages_then_activates_and_retries_without_a_revision_or_audit() {
    let a = setup().await;
    assert_eq!(
        a.call("GET", IMPORT, None).await,
        (StatusCode::OK, Value::Null)
    );
    let r = request();
    let (status, state) = a.call("POST", IMPORT, Some(r.clone())).await;
    assert_eq!(status, StatusCode::OK, "{state}");
    assert_eq!(state["status"], "pending");
    assert_eq!(state["receivedIndices"], json!([0]));
    let rev = host_revision(&a.app).await;
    assert_eq!(
        a.call("POST", IMPORT, Some(r.clone())).await,
        (StatusCode::OK, state.clone())
    );
    assert_eq!(host_revision(&a.app).await, rev);
    let (status, state) = a
        .call(
            "POST",
            COMPLETE,
            Some(json!({"batchId": r["manifest"]["checksum"]})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{state}");
    assert_eq!(state["status"], "complete");
    let rev = host_revision(&a.app).await;
    assert_eq!(
        a.call("POST", IMPORT, Some(r.clone())).await,
        (StatusCode::OK, state.clone())
    );
    assert_eq!(
        a.call(
            "POST",
            COMPLETE,
            Some(json!({"batchId": r["manifest"]["checksum"]}))
        )
        .await,
        (StatusCode::OK, state)
    );
    assert_eq!(host_revision(&a.app).await, rev);
    assert_eq!(audit_trail(&a.app, "import.cloud_history.part").await, [a.row("import.cloud_history.part", "cloud_history",r["manifest"]["checksum"].as_str().unwrap(),json!({"sourceTenantId":"imp-test-atoll","partIndex":0,"counts":r["manifest"]["counts"]}))]);
    assert_eq!(audit_trail(&a.app, "import.cloud_history.complete").await, [a.row("import.cloud_history.complete", "cloud_history",r["manifest"]["checksum"].as_str().unwrap(),json!({"sourceTenantId":"imp-test-atoll","totalParts":1,"counts":r["manifest"]["counts"]}))]);
}

#[tokio::test]
async fn dry_run_does_not_write_and_catalog_is_required() {
    let a = admin().await;
    assert_eq!(
        a.call("POST", IMPORT, Some(request())).await.0,
        StatusCode::CONFLICT
    );
    let a = setup().await;
    let mut r = request();
    r["dryRun"] = json!(true);
    let rev = host_revision(&a.app).await;
    let (status, body) = a.call("POST", IMPORT, Some(r)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(a.call("GET", IMPORT, None).await.1, Value::Null);
    assert_eq!(host_revision(&a.app).await, rev);
}

#[tokio::test]
async fn refuses_damaged_checksums_and_checks_admin_before_body() {
    let a = setup().await;
    let mut r = request();
    r["part"]["payload"]["codes"][0]["canonical"] = json!("SENSITIVE_INVALID_CODE");
    let (status, body) = a.call("POST", IMPORT, Some(r)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert!(!body.to_string().contains("SENSITIVE_INVALID_CODE"));
    seed_office_user(&a.app, "tech", "technologist", "correct horse battery").await;
    let token = login(&a.app, &a.key, "tech", "correct horse battery").await;
    assert_eq!(
        a.call_as(&token, "POST", IMPORT, Some(json!({"invalid": true})))
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        a.call_as(&token, "POST", COMPLETE, Some(json!({"invalid": true})))
            .await
            .0,
        StatusCode::FORBIDDEN
    );
}

#[tokio::test]
async fn state_and_cancel_interleave_without_torn_state_or_internal_error() {
    let a = setup().await;
    for round in 0..40 {
        let mut r = request();
        r["manifest"]["source"]["tenantName"] = json!(format!("Snapshot {round}"));
        seal(&mut r);
        assert_eq!(
            a.call("POST", IMPORT, Some(r.clone())).await.0,
            StatusCode::OK
        );
        let batch = r["manifest"]["checksum"].clone();
        let reads = async {
            for _ in 0..12 {
                let (status, result) = a.call("GET", IMPORT, None).await;
                assert_eq!(status, StatusCode::OK, "{result}");
                if !result.is_null() {
                    assert_eq!(result["batchId"], batch);
                    assert_eq!(result["status"], "pending");
                    assert_eq!(result["receivedIndices"], json!([0]));
                    assert_eq!(result["counts"], r["manifest"]["counts"]);
                }
            }
        };
        let cancel = async {
            tokio::task::yield_now().await;
            assert_eq!(
                a.call(
                    "POST",
                    "/v1/office/import/history/cancel",
                    Some(json!({"batchId":batch}))
                )
                .await
                .0,
                StatusCode::OK
            );
        };
        tokio::join!(reads, cancel);
        assert_eq!(
            a.call("GET", IMPORT, None).await,
            (StatusCode::OK, Value::Null)
        );
    }
}

#[test]
fn import_validation_accepts_the_domain_handheld_canonical_fixture_without_byte_changes() {
    // The JS fixture also contains deliberately unpaired UTF-16 surrogate raw
    // inputs (Rust JSON rightly refuses those). Decode only each expected object
    // in the parse section; successful canonicalRaw values remain exact bytes.
    let source = include_str!("../../../handheld/app/src/test/resources/km-fixtures.json");
    let parse = source.split("\n  ],").next().unwrap();
    let mut checked = 0;
    for expected in parse.split("\"expected\": {").skip(1) {
        let object = expected.split("\n      }").next().unwrap();
        let expected: Value = serde_json::from_str(&format!("{{{object}}}")).unwrap();
        if expected.get("canonicalRaw").is_none() {
            continue;
        }
        let mut r = request();
        let c = &mut r["part"]["payload"]["codes"][0];
        c["canonical"] = expected["canonicalRaw"].clone();
        c["hash"] = expected["hash"].clone();
        c["gtin14"] = expected["gtin14"].clone();
        c["serial"] = expected["serial"].clone();
        seal(&mut r);
        let typed: markiro_proto::cloud_history::CloudHistoryImportRequest =
            serde_json::from_value(r).unwrap();
        assert!(
            markiro_host::cloud_history::validation::check(&typed).is_ok(),
            "canonical case {checked}"
        );
        assert_eq!(
            typed.part.payload.codes[0].canonical.expose(),
            expected["canonicalRaw"].as_str().unwrap()
        );
        checked += 1;
    }
    assert_eq!(
        checked, 12,
        "complete successful canonical fixture inventory"
    );
}
