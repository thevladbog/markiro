//! Helpers of the backup suites (plan РК).

use std::path::Path;

use markiro_host::backup::copy::{copy_name, manifest_path, sha256_file, Manifest};
use markiro_host::backup::identity::HostIdentity;
use markiro_host::config::HostPaths;
use markiro_proto::backup::BackupTrigger;
use sqlx::{ConnectOptions, SqliteConnection};
use time::OffsetDateTime;

use super::app::TestApp;

/// A connection like the backup worker's: the app's database, no
/// migrations.
pub async fn worker_conn(app: &TestApp) -> SqliteConnection {
    markiro_host::db::options(&app.dir().join("host.db"))
        .connect()
        .await
        .unwrap()
}

/// The newest migration this build applies: what a copy's manifest names
/// as its `schemaVersion`.
pub fn latest_migration() -> i64 {
    markiro_host::db::MIGRATOR
        .iter()
        .map(|migration| migration.version)
        .max()
        .unwrap()
}

/// A UTC instant from RFC 3339 text.
pub fn at(text: &str) -> OffsetDateTime {
    markiro_host::clock::parse_timestamp(text).unwrap()
}

/// The file names in `dir`, sorted.
pub fn names(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect();
    names.sort();
    names
}

/// A copy that is no database, with a manifest that fits it: enough for the
/// listing, the retention rule and the second folder, which never open a
/// copy.
pub fn fake_copy(dir: &Path, created: &str, tag: &str) -> Manifest {
    let name = copy_name(at(created), tag);
    let db = dir.join(&name);
    std::fs::write(&db, format!("copy {tag}")).unwrap();
    let (size_bytes, sha256) = sha256_file(&db).unwrap();
    let manifest = Manifest {
        format: 1,
        file: name,
        created_at: created.to_owned(),
        trigger: BackupTrigger::Scheduled,
        host_id: "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f".to_owned(),
        schema_version: latest_migration(),
        size_bytes,
        sha256,
        identity: None,
    };
    std::fs::write(
        manifest_path(&db),
        serde_json::to_vec_pretty(&manifest).unwrap(),
    )
    .unwrap();
    manifest
}

/// The host identity of the data folder `dir` as a host that started there
/// has it (plan I1): `host.json` (port 45710) and `tls/`.
pub fn write_identity(dir: &Path, host_id: &str) -> HostIdentity {
    let paths = HostPaths::new(dir);
    paths.ensure().unwrap();
    std::fs::write(
        paths.config_file(),
        serde_json::json!({ "hostId": host_id, "port": 45710 }).to_string(),
    )
    .unwrap();
    markiro_host::tls::TlsIdentity::load_or_create(&paths.tls_dir(), host_id).unwrap();
    HostIdentity::read(&paths).unwrap()
}
