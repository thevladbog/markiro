//! The host's update packages on disk (plan ОБН-3, spec §10.11.2): the start
//! cleans `updates\`, promotes `staged\` of the running version, verifies
//! `current\` whole; a changed file is checked again before it is served;
//! one upload at a time goes through `incoming-<id>.partial\`.

mod support;

use std::path::Path;

use markiro_host::updates::{
    ManifestRefusal, Promotion, Serve, UpdateStore, UploadError, CURRENT, PREVIOUS, STAGED,
};
use markiro_proto::update::distribution::PackageState;
use support::backup::names;
use support::update::{
    flip_byte, installer_bytes, installer_name, keyset, manifest_payload, signed_manifest,
    write_package,
};

fn store(dir: &Path, host: &str) -> UpdateStore {
    UpdateStore::new(dir.join("updates"), keyset(), host)
}

#[test]
fn the_start_removes_strays_and_partial_uploads_and_keeps_the_three_folders() {
    let dir = tempfile::tempdir().unwrap();
    let updates = dir.path().join("updates");
    write_package(&updates, CURRENT, "0.3.0");
    write_package(&updates, PREVIOUS, "0.2.0");
    std::fs::create_dir_all(updates.join("incoming-1a2b.partial")).unwrap();
    std::fs::write(updates.join("incoming-1a2b.partial/x.partial"), b"half").unwrap();
    std::fs::write(updates.join("notes.txt"), b"stray").unwrap();
    std::fs::write(updates.join(STAGED), b"a file where a folder belongs").unwrap();
    let report = store(dir.path(), "0.3.0").open_blocking().unwrap();
    assert_eq!(names(&updates), [CURRENT, PREVIOUS]);
    assert_eq!(
        (
            report.promotion,
            report.current,
            report.current_version.as_deref()
        ),
        (Promotion::None, PackageState::Ok, Some("0.3.0"))
    );
}

#[test]
fn a_staged_package_of_the_running_version_becomes_current_and_the_current_previous() {
    let dir = tempfile::tempdir().unwrap();
    let updates = dir.path().join("updates");
    write_package(&updates, STAGED, "0.3.0");
    write_package(&updates, CURRENT, "0.2.0");
    write_package(&updates, PREVIOUS, "0.1.0");
    let store = store(dir.path(), "0.3.0");
    let report = store.open_blocking().unwrap();
    assert_eq!(
        report.promotion,
        Promotion::Promoted {
            version: "0.3.0".to_owned(),
            previous: Some("0.2.0".to_owned())
        }
    );
    assert_eq!(names(&updates), [CURRENT, PREVIOUS]);
    assert!(updates.join(CURRENT).join(installer_name("0.3.0")).exists());
    assert!(updates
        .join(PREVIOUS)
        .join(installer_name("0.2.0"))
        .exists());
    assert_eq!(report.current, PackageState::Ok);
    let status = store.status_blocking();
    assert_eq!(
        (
            status.version.as_deref(),
            status.staged,
            status.previous.as_deref()
        ),
        (Some("0.3.0"), None, Some("0.2.0"))
    );
    let expected = 2 * installer_bytes("0.3.0").len() as u64;
    assert!(status.disk_bytes >= expected, "{}", status.disk_bytes);
}

#[test]
fn a_staged_package_not_newer_than_the_host_goes_and_a_newer_one_waits() {
    let dir = tempfile::tempdir().unwrap();
    let updates = dir.path().join("updates");
    write_package(&updates, STAGED, "0.2.0");
    let report = store(dir.path(), "0.3.0").open_blocking().unwrap();
    assert_eq!(
        report.promotion,
        Promotion::Stale {
            version: "0.2.0".to_owned()
        }
    );
    assert!(!updates.join(STAGED).exists());

    write_package(&updates, STAGED, "0.4.0");
    let report = store(dir.path(), "0.3.0").open_blocking().unwrap();
    assert_eq!(
        report.promotion,
        Promotion::Waiting {
            version: "0.4.0".to_owned()
        }
    );
    assert!(updates.join(STAGED).exists());
}

#[test]
fn a_staged_package_that_does_not_check_out_is_removed_and_reported() {
    let dir = tempfile::tempdir().unwrap();
    let updates = dir.path().join("updates");
    write_package(&updates, STAGED, "0.3.0");
    flip_byte(&updates.join(STAGED).join(installer_name("0.3.0")), 10);
    let report = store(dir.path(), "0.3.0").open_blocking().unwrap();
    assert_eq!(
        report.promotion,
        Promotion::Failed {
            version: Some("0.3.0".to_owned())
        }
    );
    assert!(!updates.join(STAGED).exists());
    assert_eq!(report.current, PackageState::Missing);
}

#[test]
fn a_current_package_of_another_version_is_a_mismatch_and_a_broken_one_invalid() {
    let dir = tempfile::tempdir().unwrap();
    let updates = dir.path().join("updates");
    write_package(&updates, CURRENT, "0.2.0");
    let report = store(dir.path(), "0.3.0").open_blocking().unwrap();
    assert_eq!(
        (report.current, report.current_version.as_deref()),
        (PackageState::Mismatch, Some("0.2.0"))
    );
    flip_byte(&updates.join(CURRENT).join("manifest.update.jws"), 30);
    let report = store(dir.path(), "0.2.0").open_blocking().unwrap();
    assert_eq!(report.current, PackageState::Invalid);
}

#[test]
fn a_file_changed_after_the_check_is_checked_again_before_it_is_served() {
    let dir = tempfile::tempdir().unwrap();
    let updates = dir.path().join("updates");
    let (manifest, bytes) = write_package(&updates, CURRENT, "0.3.0");
    let store = store(dir.path(), "0.3.0");
    store.open_blocking().unwrap();
    match store.serve_blocking() {
        Serve::Ready(package) => {
            assert_eq!(package.manifest_text, manifest.trim());
            assert_eq!(package.size_bytes, bytes.len() as u64);
            assert_eq!(package.kid, "test-upd-1");
        }
        other => panic!("{other:?}"),
    }
    flip_byte(&updates.join(CURRENT).join(installer_name("0.3.0")), 10);
    assert!(matches!(store.serve_blocking(), Serve::Changed));
    assert!(matches!(
        store.serve_blocking(),
        Serve::Unavailable(PackageState::Verifying)
    ));
    store.reverify_blocking();
    assert!(matches!(
        store.serve_blocking(),
        Serve::Unavailable(PackageState::Invalid)
    ));
}

#[test]
fn a_manifest_is_refused_for_its_signature_product_size_and_form() {
    let dir = tempfile::tempdir().unwrap();
    let store = store(dir.path(), "0.3.0").with_max_installer(100_000);
    let bytes = installer_bytes("0.4.0");
    // Over the substitute limit: the installer is a few hundred KiB.
    assert_eq!(
        store
            .check_manifest(&signed_manifest("0.4.0", &bytes))
            .unwrap_err(),
        ManifestRefusal::TooLarge
    );
    let store = store_without_limit(dir.path());
    let good = signed_manifest("0.4.0", &bytes);
    // A character in the middle of the signature: the last one of a 64-byte
    // signature has unused bits, so changing it can leave the signature valid.
    let at = good.rfind('.').unwrap() + 11;
    let mut tampered = good.clone().into_bytes();
    tampered[at] = if tampered[at] == b'A' { b'B' } else { b'A' };
    let tampered = String::from_utf8(tampered).unwrap();
    assert_eq!(
        store.check_manifest(&tampered).unwrap_err(),
        ManifestRefusal::Signature
    );
    let mut other = manifest_payload("0.4.0", &bytes);
    other["product"] = serde_json::json!("markiro-station");
    let other = markiro_proto::update::distribution::testing::sign_update_manifest(&other);
    assert_eq!(
        store.check_manifest(&other).unwrap_err(),
        ManifestRefusal::WrongProduct
    );
    assert_eq!(
        store.check_manifest("not a manifest").unwrap_err(),
        ManifestRefusal::Malformed
    );
    assert_eq!(
        store
            .check_manifest(&"x".repeat(64 * 1024 + 1))
            .unwrap_err(),
        ManifestRefusal::TooLarge
    );
    // A trailing new line, as a file written by hand ends, is no refusal.
    assert!(store.check_manifest(&format!("{good}\n")).is_ok());
}

fn store_without_limit(dir: &Path) -> UpdateStore {
    store(dir, "0.3.0")
}

#[test]
fn one_upload_at_a_time_becomes_staged_and_a_package_not_newer_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let updates = dir.path().join("updates");
    let store = store(dir.path(), "0.3.0");
    store.open_blocking().unwrap();
    let bytes = installer_bytes("0.3.0");
    let same = store
        .check_manifest(&signed_manifest("0.3.0", &bytes))
        .unwrap();
    assert!(matches!(
        store.begin_upload_blocking(same),
        Err(UploadError::NotNewer)
    ));

    let bytes = installer_bytes("0.4.0");
    let first = store
        .begin_upload_blocking(
            store
                .check_manifest(&signed_manifest("0.4.0", &bytes))
                .unwrap(),
        )
        .unwrap();
    let second = store
        .begin_upload_blocking(
            store
                .check_manifest(&signed_manifest("0.4.0", &bytes))
                .unwrap(),
        )
        .unwrap();
    assert!(!first.dir.exists(), "a new upload replaces the one before");
    assert!(store.upload(&first.id).is_none());
    std::fs::write(second.partial(), &bytes).unwrap();
    store.finish_upload_blocking(&second.id).unwrap();
    assert_eq!(names(&updates), [STAGED]);
    assert_eq!(
        names(&updates.join(STAGED)),
        ["manifest.update.jws".to_owned(), installer_name("0.4.0")]
    );
    assert!(matches!(
        store.finish_upload_blocking(&second.id),
        Err(UploadError::Unknown)
    ));
    assert_eq!(store.status_blocking().staged.as_deref(), Some("0.4.0"));
}

#[test]
fn an_abandoned_upload_leaves_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let updates = dir.path().join("updates");
    let store = store(dir.path(), "0.3.0");
    store.open_blocking().unwrap();
    let bytes = installer_bytes("0.4.0");
    let upload = store
        .begin_upload_blocking(
            store
                .check_manifest(&signed_manifest("0.4.0", &bytes))
                .unwrap(),
        )
        .unwrap();
    std::fs::write(upload.partial(), &bytes[..100]).unwrap();
    store.abandon_upload_blocking(&upload.id);
    assert!(names(&updates).is_empty());
}

#[test]
fn the_data_folder_has_an_updates_folder_from_the_first_start() {
    let dir = tempfile::tempdir().unwrap();
    let paths = markiro_host::config::HostPaths::new(dir.path());
    paths.ensure().unwrap();
    assert_eq!(paths.updates_dir(), dir.path().join("updates"));
    assert!(paths.updates_dir().is_dir());
}
