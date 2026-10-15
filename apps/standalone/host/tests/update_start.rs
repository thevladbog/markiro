//! What the start of the service and the hourly pass write about the update
//! packages (plan ОБН-3, spec §10.11.2, §10.11.8): `update.package.promote`
//! `ok` for a promotion, `failed` for a staged package that does not check
//! out and, at the start, for a current one of another version or broken;
//! nothing for no package, a waiting or a stale one.

mod support;

use std::path::Path;
use std::sync::Arc;

use markiro_host::clock::ManualClock;
use markiro_host::updates::{worker, Serve, UpdateStore, CURRENT, STAGED};
use markiro_proto::update::distribution::PackageState;
use serde_json::{json, Value};
use sqlx::SqlitePool;
use support::app::START;
use support::update::{flip_byte, installer_name, keyset, write_package};

type Row = (
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    String,
    Value,
);

async fn promote_rows(pool: &SqlitePool) -> Vec<Row> {
    let rows: Vec<(
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        String,
        String,
    )> = sqlx::query_as(
        "SELECT actor_kind, actor_id, target_type, target_id, result, details \
             FROM audit_log WHERE action = 'update.package.promote' ORDER BY id",
    )
    .fetch_all(pool)
    .await
    .unwrap();
    rows.into_iter()
        .map(|(kind, id, target_type, target_id, result, details)| {
            (
                kind,
                id,
                target_type,
                target_id,
                result,
                serde_json::from_str(&details).unwrap(),
            )
        })
        .collect()
}

fn row(result: &str, version: Option<&str>, details: Value) -> Row {
    (
        "system".to_owned(),
        None,
        version.map(|_| "update_package".to_owned()),
        version.map(str::to_owned),
        result.to_owned(),
        details,
    )
}

async fn started(dir: &Path, host: &str) -> (SqlitePool, Arc<UpdateStore>) {
    let pool = markiro_host::db::open(&dir.join("host.db")).await.unwrap();
    let store = Arc::new(UpdateStore::new(dir.join("updates"), keyset(), host));
    let report = store.open_blocking().unwrap();
    worker::record_start(&pool, "2026-11-03T06:00:00Z", &report)
        .await
        .unwrap();
    (pool, store)
}

#[tokio::test]
async fn a_promotion_at_the_start_is_one_ok_row_of_the_host() {
    let dir = tempfile::tempdir().unwrap();
    write_package(&dir.path().join("updates"), STAGED, "0.3.0");
    write_package(&dir.path().join("updates"), CURRENT, "0.2.0");
    let (pool, _) = started(dir.path(), "0.3.0").await;
    assert_eq!(
        promote_rows(&pool).await,
        [row(
            "ok",
            Some("0.3.0"),
            json!({ "version": "0.3.0", "previous": "0.2.0" })
        )]
    );
}

#[tokio::test]
async fn a_staged_package_that_does_not_check_out_is_a_failed_row() {
    let dir = tempfile::tempdir().unwrap();
    let updates = dir.path().join("updates");
    write_package(&updates, STAGED, "0.3.0");
    flip_byte(&updates.join(STAGED).join(installer_name("0.3.0")), 10);
    let (pool, _) = started(dir.path(), "0.3.0").await;
    assert_eq!(
        promote_rows(&pool).await,
        [row(
            "failed",
            Some("0.3.0"),
            json!({ "version": "0.3.0", "previous": null, "reason": "invalid" })
        )]
    );
}

#[tokio::test]
async fn a_current_package_of_another_version_is_a_failed_row_at_the_start() {
    let dir = tempfile::tempdir().unwrap();
    write_package(&dir.path().join("updates"), CURRENT, "0.2.0");
    let (pool, _) = started(dir.path(), "0.3.0").await;
    assert_eq!(
        promote_rows(&pool).await,
        [row(
            "failed",
            Some("0.2.0"),
            json!({ "version": "0.2.0", "previous": null, "reason": "mismatch" })
        )]
    );
}

#[tokio::test]
async fn no_package_a_waiting_or_a_stale_one_writes_no_row() {
    for staged in [None, Some("0.4.0"), Some("0.2.0")] {
        let dir = tempfile::tempdir().unwrap();
        if let Some(version) = staged {
            write_package(&dir.path().join("updates"), STAGED, version);
        }
        let (pool, _) = started(dir.path(), "0.3.0").await;
        assert!(promote_rows(&pool).await.is_empty(), "{staged:?}");
    }
}

#[tokio::test]
async fn the_hourly_pass_promotes_what_the_start_could_not_and_serves_it() {
    let dir = tempfile::tempdir().unwrap();
    let (pool, store) = started(dir.path(), "0.3.0").await;
    // A staged package of the running version that a locked file kept back.
    write_package(&dir.path().join("updates"), STAGED, "0.3.0");
    let clock = ManualClock::new(time::OffsetDateTime::from_unix_timestamp(START).unwrap());
    worker::tick(&store, &pool, &clock).await;
    assert_eq!(
        promote_rows(&pool).await,
        [row(
            "ok",
            Some("0.3.0"),
            json!({ "version": "0.3.0", "previous": null })
        )]
    );
    assert!(matches!(store.serve_blocking(), Serve::Ready(_)));
    worker::tick(&store, &pool, &clock).await;
    assert_eq!(promote_rows(&pool).await.len(), 1, "nothing staged: no row");
}

#[test]
fn the_pass_runs_every_hour() {
    assert_eq!(worker::PROMOTE_EVERY, std::time::Duration::from_secs(3600));
    assert_eq!(markiro_host::HOST_VERSION, env!("CARGO_PKG_VERSION"));
}

#[tokio::test]
async fn the_hourly_pass_checks_a_bad_current_package_again_and_writes_no_row() {
    let dir = tempfile::tempdir().unwrap();
    let updates = dir.path().join("updates");
    write_package(&updates, CURRENT, "0.3.0");
    let installer = updates.join(CURRENT).join(installer_name("0.3.0"));
    // A file an antivirus held at the start reads as broken.
    flip_byte(&installer, 10);
    let (pool, store) = started(dir.path(), "0.3.0").await;
    assert!(matches!(
        store.serve_blocking(),
        Serve::Unavailable(PackageState::Invalid)
    ));
    let rows = promote_rows(&pool).await;
    assert_eq!(rows.len(), 1, "the start wrote its one failed row");
    // The file is readable again (the same flip undoes itself).
    flip_byte(&installer, 10);
    let clock = ManualClock::new(time::OffsetDateTime::from_unix_timestamp(START).unwrap());
    worker::tick(&store, &pool, &clock).await;
    assert!(matches!(store.serve_blocking(), Serve::Ready(_)));
    assert_eq!(
        promote_rows(&pool).await,
        rows,
        "a retry is no promotion: no row, recovered or not"
    );
    // Still broken on the next pass: the state is Invalid again, no new row.
    flip_byte(&installer, 10);
    assert!(matches!(store.serve_blocking(), Serve::Changed));
    worker::tick(&store, &pool, &clock).await;
    assert!(matches!(
        store.serve_blocking(),
        Serve::Unavailable(PackageState::Invalid)
    ));
    worker::tick(&store, &pool, &clock).await;
    assert_eq!(promote_rows(&pool).await, rows);
}
