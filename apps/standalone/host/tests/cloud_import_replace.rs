#[path = "support/history.rs"]
mod history;
mod support;

use axum::http::StatusCode;
use markiro_host::backup::{copy, Backups};
use serde_json::{json, Value};
use support::app::{admin, cloud_import_request, demo_admin, host_revision, Admin, IMPORT_ID};

fn backups(a: &mut Admin) {
    let local = a.app.dir().join("backups");
    std::fs::create_dir_all(&local).unwrap();
    let b = Backups::new(
        a.app.dir().to_path_buf(),
        local,
        a.app.dir().join("host.db"),
        a.app.state.host_id.clone(),
    );
    a.app.state = a.app.state.clone().with_backups(b);
}

fn replacement(dry_run: bool, revision: i64) -> Value {
    let mut r = cloud_import_request(IMPORT_ID, dry_run);
    r["replacement"] =
        json!({"expectedRevision":revision,"history":history::request()["manifest"]});
    r
}

#[tokio::test]
async fn replacement_backs_up_dirty_data_and_retains_identity_license_and_accounts() {
    let mut a = admin().await;
    backups(&mut a);
    support::license::load_ok(&a, &support::license::file(&a.app.state.host_id, |_| {})).await;
    assert_eq!(
        a.call(
            "POST",
            "/v1/office/import",
            Some(cloud_import_request(
                "10000000-0000-4000-8000-000000000090",
                false
            ))
        )
        .await
        .0,
        StatusCode::OK
    );
    let before = host_revision(&a.app).await;
    let devices: Vec<(String, String)> =
        sqlx::query_as("SELECT id,key_hash FROM devices ORDER BY id")
            .fetch_all(&a.app.state.pool)
            .await
            .unwrap();
    let clock: String = sqlx::query_scalar("SELECT json_object('first',trial_started_at,'emergency',emergency_until) FROM license_clock WHERE id=1").fetch_one(&a.app.state.pool).await.unwrap();
    let license: Vec<(String, String)> = sqlx::query_as("SELECT license_id,compact FROM licenses")
        .fetch_all(&a.app.state.pool)
        .await
        .unwrap();
    let users: Vec<(String, String)> = sqlx::query_as("SELECT id,password_phc FROM office_users")
        .fetch_all(&a.app.state.pool)
        .await
        .unwrap();
    let (code, trial) = a
        .call("POST", "/v1/office/import", Some(replacement(true, before)))
        .await;
    assert_eq!(code, StatusCode::OK, "{trial}");
    assert_eq!(trial["replacement"]["expectedRevision"], before);
    assert_eq!(host_revision(&a.app).await, before);
    assert!(!a.app.dir().join("backups/pre-import").exists());
    let (code, done) = a
        .call(
            "POST",
            "/v1/office/import",
            Some(replacement(false, before)),
        )
        .await;
    assert_eq!(code, StatusCode::OK, "{done}");
    let epoch = done["replacement"]["datasetEpoch"].as_str().unwrap();
    assert!(uuid::Uuid::parse_str(epoch).is_ok());
    let backup = a
        .app
        .dir()
        .join(done["replacement"]["backupFile"].as_str().unwrap());
    let manifest = copy::read_manifest(&backup).unwrap();
    assert_eq!(
        copy::sha256_file(&backup).unwrap(),
        (manifest.size_bytes, manifest.sha256.clone())
    );
    let old = sqlx::sqlite::SqlitePoolOptions::new()
        .connect_with(
            sqlx::sqlite::SqliteConnectOptions::new()
                .filename(&backup)
                .read_only(true),
        )
        .await
        .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM products")
            .fetch_one(&old)
            .await
            .unwrap(),
        4
    );
    old.close().await;
    let import_rows = support::app::audit_trail(&a.app, "import.cloud").await;
    assert_eq!(
        import_rows.last(),
        Some(&a.row(
            "import.cloud",
            "site",
            "1",
            json!({
                "importId":IMPORT_ID,"exportedAt":"2026-10-09T18:30:00.000Z","rehearsal":false,
                "sourceTenantId":"imp-test-atoll","summary":done,"datasetEpoch":epoch,
                "backup":{"file":done["replacement"]["backupFile"],"sha256":manifest.sha256}
            })
        ))
    );
    assert_eq!(
        sqlx::query_as::<_, (String, String)>("SELECT id,key_hash FROM devices ORDER BY id")
            .fetch_all(&a.app.state.pool)
            .await
            .unwrap(),
        devices
    );
    assert_eq!(
        sqlx::query_as::<_, (String, String)>("SELECT license_id,compact FROM licenses")
            .fetch_all(&a.app.state.pool)
            .await
            .unwrap(),
        license
    );
    assert_eq!(
        sqlx::query_as::<_, (String, String)>("SELECT id,password_phc FROM office_users")
            .fetch_all(&a.app.state.pool)
            .await
            .unwrap(),
        users
    );
    assert_eq!(sqlx::query_scalar::<_,String>("SELECT json_object('first',trial_started_at,'emergency',emergency_until) FROM license_clock WHERE id=1").fetch_one(&a.app.state.pool).await.unwrap(),clock);
    let (code, again) = a
        .call(
            "POST",
            "/v1/office/import",
            Some(replacement(false, before)),
        )
        .await;
    assert_eq!(code, StatusCode::OK, "{again}");
    assert_eq!(again["repeated"], true);
    assert_eq!(again["replacement"], done["replacement"]);
    assert!(markiro_host::cloud_history::require_ready(
        &mut a.app.state.pool.acquire().await.unwrap()
    )
    .await
    .is_err());
    let (_, state) = a.call("GET", "/v1/office/import/history", None).await;
    assert_eq!(state["status"], "pending");
    assert_eq!(state["receivedIndices"], json!([]));
}

#[tokio::test]
async fn failed_backup_or_stale_revision_never_changes_the_dataset() {
    let mut a = admin().await;
    backups(&mut a);
    let before = host_revision(&a.app).await;
    let (code, body) = a
        .call(
            "POST",
            "/v1/office/import",
            Some(replacement(false, before + 1)),
        )
        .await;
    assert_eq!(code, StatusCode::CONFLICT, "{body}");
    assert_eq!(
        body["error"]["details"]["constraint"],
        "replacement_changed"
    );
    std::fs::write(a.app.dir().join("backups/pre-import"), b"not a directory").unwrap();
    let (code, body) = a
        .call(
            "POST",
            "/v1/office/import",
            Some(replacement(false, before)),
        )
        .await;
    assert_eq!(code, StatusCode::CONFLICT, "{body}");
    assert_eq!(
        body["error"]["details"]["constraint"],
        "replacement_backup_failed"
    );
    assert_eq!(host_revision(&a.app).await, before);
    assert_eq!(
        sqlx::query_scalar::<_, Option<String>>("SELECT dataset_epoch FROM site WHERE id=1")
            .fetch_one(&a.app.state.pool)
            .await
            .unwrap(),
        None
    );
}

#[tokio::test]
async fn failed_catalog_write_rolls_back_and_keeps_the_verified_copy() {
    let mut a = admin().await;
    backups(&mut a);
    a.call(
        "POST",
        "/v1/office/import",
        Some(cloud_import_request(
            "10000000-0000-4000-8000-000000000090",
            false,
        )),
    )
    .await;
    let before = host_revision(&a.app).await;
    sqlx::query("CREATE TRIGGER reject_replacement BEFORE INSERT ON products BEGIN SELECT RAISE(ABORT,'replacement test'); END").execute(&a.app.state.pool).await.unwrap();
    let (status, _) = a
        .call(
            "POST",
            "/v1/office/import",
            Some(replacement(false, before)),
        )
        .await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM products")
            .fetch_one(&a.app.state.pool)
            .await
            .unwrap(),
        4
    );
    assert_eq!(host_revision(&a.app).await, before);
    assert_eq!(
        sqlx::query_scalar::<_, Option<String>>("SELECT dataset_epoch FROM site WHERE id=1")
            .fetch_one(&a.app.state.pool)
            .await
            .unwrap(),
        None
    );
    assert_eq!(
        std::fs::read_dir(a.app.dir().join("backups/pre-import"))
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| e.path().extension().is_some_and(|x| x == "db"))
            .count(),
        1
    );
}

#[tokio::test]
async fn a_canceled_history_stays_held_and_a_new_replacement_can_reuse_its_file() {
    let mut a = admin().await;
    backups(&mut a);
    let before = host_revision(&a.app).await;
    let (status, done) = a
        .call(
            "POST",
            "/v1/office/import",
            Some(replacement(false, before)),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{done}");
    let history = history::request();
    let (status, value) = a
        .call(
            "POST",
            "/v1/office/import/history/cancel",
            Some(json!({"batchId":history["manifest"]["checksum"]})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{value}");
    assert!(markiro_host::cloud_history::require_ready(
        &mut a.app.state.pool.acquire().await.unwrap()
    )
    .await
    .is_err());
    let mut next = replacement(false, host_revision(&a.app).await);
    next["importId"] = json!("10000000-0000-4000-8000-000000000091");
    let (status, second) = a.call("POST", "/v1/office/import", Some(next)).await;
    assert_eq!(status, StatusCode::OK, "{second}");
    assert_ne!(
        done["replacement"]["datasetEpoch"],
        second["replacement"]["datasetEpoch"]
    );
    let (status, value) = a
        .call("POST", "/v1/office/import/history", Some(history.clone()))
        .await;
    assert_eq!(status, StatusCode::OK, "{value}");
    let (status, value) = a
        .call(
            "POST",
            "/v1/office/import/history/complete",
            Some(json!({"batchId":history["manifest"]["checksum"]})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{value}");
    markiro_host::cloud_history::require_ready(&mut a.app.state.pool.acquire().await.unwrap())
        .await
        .unwrap();
}

#[tokio::test]
async fn every_host_table_has_an_explicit_replacement_ownership_decision() {
    let a = admin().await;
    let preserved = [
        "_sqlx_migrations",
        "audit_log",
        "backup_settings",
        "chz_product_groups",
        "devices",
        "disaggregation_doc_counters",
        "disaggregation_reasons",
        "host_revision",
        "label_templates",
        "license_clock",
        "licenses",
        "office_sessions",
        "office_users",
        "org_profile",
        "pairing_codes",
        "pallet_sheet_templates",
        "shift_number_counters",
        "site",
        "sscc_counters",
        "sqlite_sequence",
        "user_avatars",
    ];
    let tables: Vec<String> =
        sqlx::query_scalar("SELECT name FROM sqlite_master WHERE type='table'")
            .fetch_all(&a.app.state.pool)
            .await
            .unwrap();
    for table in tables {
        assert!(
            preserved.contains(&table.as_str())
                || markiro_host::import_replace::BUSINESS_TABLES.contains(&table.as_str()),
            "classify {table} before replacing data"
        );
    }
}

#[tokio::test]
async fn issued_sscc_ranges_and_shift_number_floors_survive_the_business_wipe() {
    let mut a = admin().await;
    backups(&mut a);
    let (prefix,extension):(String,i64)=sqlx::query_as("SELECT issuer_prefix,extension FROM sscc_counters ORDER BY issuer_prefix,extension LIMIT 1").fetch_one(&a.app.state.pool).await.unwrap();
    sqlx::query("INSERT INTO sscc_blocks(id,issuer_prefix,extension,device_id,request_id,from_serial,to_serial,issued_at) VALUES('c0000000-0000-4000-8000-000000000001',?,?,(SELECT id FROM devices LIMIT 1),'test-range',0,200000,'2026-09-21T14:00:00Z')")
        .bind(&prefix).bind(extension).execute(&a.app.state.pool).await.unwrap();
    sqlx::query("INSERT INTO shift_number_counters(month_key,last_seq) VALUES('OCT26',999)")
        .execute(&a.app.state.pool)
        .await
        .unwrap();
    let (status, value) = a
        .call(
            "POST",
            "/v1/office/import",
            Some(replacement(false, host_revision(&a.app).await)),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{value}");
    assert!(
        sqlx::query_scalar::<_, i64>(
            "SELECT next_serial FROM sscc_counters WHERE issuer_prefix=? AND extension=?"
        )
        .bind(prefix)
        .bind(extension)
        .fetch_one(&a.app.state.pool)
        .await
        .unwrap()
            >= 200001
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT last_seq FROM shift_number_counters WHERE month_key='OCT26'"
        )
        .fetch_one(&a.app.state.pool)
        .await
        .unwrap(),
        999
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM sscc_blocks")
            .fetch_one(&a.app.state.pool)
            .await
            .unwrap(),
        0
    );
}

#[tokio::test]
async fn replacement_removes_real_floor_facts_and_reassigns_preserved_devices_by_line_name() {
    use support::app::{
        accepted, box_id, fact, instant, ok_scan, open_floor, receipts, record_id, shift_setup,
    };
    let mut a = admin().await;
    backups(&mut a);
    let setup = shift_setup(&a).await;
    let floor = open_floor(&a, &setup, &a.key, &setup.line).await;
    let scan = fact(
        &record_id(1),
        "scan",
        &floor.shift,
        ok_scan(1, &box_id(1), &instant(1, 0)),
    );
    assert_eq!(
        receipts(&a.app, &a.key, &[scan.clone()]).await,
        vec![accepted(&record_id(1))]
    );
    let before = host_revision(&a.app).await;
    let (status, done) = a
        .call(
            "POST",
            "/v1/office/import",
            Some(replacement(false, before)),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{done}");
    for table in [
        "shifts",
        "scans",
        "code_owners",
        "boxes",
        "fact_receipts",
        "sscc_blocks",
    ] {
        assert_eq!(
            sqlx::query_scalar::<_, i64>(&format!("SELECT count(*) FROM {table}"))
                .fetch_one(&a.app.state.pool)
                .await
                .unwrap(),
            0,
            "test data remains in {table}"
        );
    }
    let backup = a
        .app
        .dir()
        .join(done["replacement"]["backupFile"].as_str().unwrap());
    let old = sqlx::sqlite::SqlitePoolOptions::new()
        .connect_with(
            sqlx::sqlite::SqliteConnectOptions::new()
                .filename(backup)
                .read_only(true),
        )
        .await
        .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM scans")
            .fetch_one(&old)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT id FROM shifts")
            .fetch_one(&old)
            .await
            .unwrap(),
        floor.shift
    );
    old.close().await;
    let assigned: String = sqlx::query_scalar("SELECT line_id FROM devices WHERE id=?")
        .bind(&floor.station)
        .fetch_one(&a.app.state.pool)
        .await
        .unwrap();
    assert_ne!(assigned, setup.line);
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT name_key FROM lines WHERE id=?")
            .bind(assigned)
            .fetch_one(&a.app.state.pool)
            .await
            .unwrap(),
        "линия 1"
    );
    assert_eq!(
        support::app::send_facts(&a.app, &a.key, &[scan]).await.0,
        StatusCode::CONFLICT
    );
}

#[tokio::test]
async fn replacement_supersedes_the_test_datasets_old_restore_hold() {
    let mut a = admin().await;
    backups(&mut a);
    sqlx::query("UPDATE site SET restore_epoch='e0000000-0000-4000-8000-000000000001',facts_held_since='2026-09-21T13:00:00Z' WHERE id=1").execute(&a.app.state.pool).await.unwrap();
    let (status, value) = a
        .call(
            "POST",
            "/v1/office/import",
            Some(replacement(false, host_revision(&a.app).await)),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{value}");
    let state: (Option<String>, Option<String>, i64) = sqlx::query_as(
        "SELECT restore_epoch,facts_held_since,replacement_pending FROM site WHERE id=1",
    )
    .fetch_one(&a.app.state.pool)
    .await
    .unwrap();
    assert_eq!(
        state,
        (None, None, 1),
        "only the new history hold should remain"
    );
}

/// A replacement over the wizard's demo data (spec 2026-10-21) takes the demo prefix's counters
/// and the `DEMO` shift counter with the demo product: nothing of it is left orphaned.
#[tokio::test]
async fn replacement_over_demo_data_leaves_none_of_its_counters() {
    let mut a = demo_admin().await;
    backups(&mut a);
    let before = host_revision(&a.app).await;
    let (code, done) = a
        .call(
            "POST",
            "/v1/office/import",
            Some(replacement(false, before)),
        )
        .await;
    assert_eq!(code, StatusCode::OK, "{done}");
    let left: (i64, i64, i64) = sqlx::query_as(
        "SELECT (SELECT COUNT(*) FROM sscc_counters WHERE issuer_prefix = '290000000'), \
         (SELECT COUNT(*) FROM shift_number_counters WHERE month_key = 'DEMO'), \
         (SELECT COUNT(*) FROM products WHERE demo = 1)",
    )
    .fetch_one(&a.app.state.pool)
    .await
    .unwrap();
    assert_eq!(left, (0, 0, 0));
}
