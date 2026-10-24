use markiro_backup_cloud::{
    envelope::{open_copy, seal_copy},
    model::{ClientProfile, NativeCopyPaths, SnapshotId},
};
use std::fs;

fn source(dir: &std::path::Path) -> NativeCopyPaths {
    let paths = NativeCopyPaths::beside(dir.join("markiro-host-test.db"));
    fs::write(&paths.database, b"synthetic sqlite bytes").unwrap();
    fs::write(
        &paths.identity,
        br#"{"format":1,"hostId":"74bb9674-19ed-4559-9b0f-87c55d8b525c","privateKey":"synthetic"}"#,
    )
    .unwrap();
    let hash = |path: &std::path::Path| {
        let bytes = fs::read(path).unwrap();
        let sha: String = aws_lc_rs::digest::digest(&aws_lc_rs::digest::SHA256, &bytes)
            .as_ref()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        (bytes.len(), sha)
    };
    let (size, sha) = hash(&paths.database);
    let (key_size, key_sha) = hash(&paths.identity);
    let manifest = serde_json::json!({"format":1,"hostId":"74bb9674-19ed-4559-9b0f-87c55d8b525c","createdAt":"2026-10-22T20:00:00Z","schemaVersion":46,"file":"markiro-host-test.db","sizeBytes":size,"sha256":sha,"identity":{"fingerprint":"a".repeat(64),"sizeBytes":key_size,"sha256":key_sha}});
    fs::write(&paths.manifest, serde_json::to_vec(&manifest).unwrap()).unwrap();
    paths
}

#[test]
fn roundtrip_preserves_native_three_files_and_needs_no_old_machine() {
    let tmp = tempfile::tempdir().unwrap();
    let paths = source(tmp.path());
    let stage = tmp.path().join("stage");
    let profile = ClientProfile::new("customer-client").unwrap();
    seal_copy(&paths, &profile, &stage, SnapshotId::new()).unwrap();
    let restored = open_copy(&stage, "customer-client", &tmp.path().join("restored")).unwrap();
    for (before, after) in [
        (&paths.database, &restored.database),
        (&paths.manifest, &restored.manifest),
        (&paths.identity, &restored.identity),
    ] {
        assert_eq!(fs::read(before).unwrap(), fs::read(after).unwrap());
    }
}

#[test]
fn missing_identity_is_not_publishable() {
    let tmp = tempfile::tempdir().unwrap();
    let paths = source(tmp.path());
    fs::remove_file(&paths.identity).unwrap();
    assert!(seal_copy(
        &paths,
        &ClientProfile::new("client").unwrap(),
        &tmp.path().join("stage"),
        SnapshotId::new()
    )
    .is_err());
    assert!(!tmp.path().join("stage/complete.json").exists());
}

#[test]
fn wrong_client_and_corruption_never_return_restore_paths() {
    for name in [
        "database.age",
        "manifest.age",
        "host-identity.age",
        "recovery-key.json",
    ] {
        let tmp = tempfile::tempdir().unwrap();
        let paths = source(tmp.path());
        let stage = tmp.path().join("stage");
        seal_copy(
            &paths,
            &ClientProfile::new("client").unwrap(),
            &stage,
            SnapshotId::new(),
        )
        .unwrap();
        assert!(open_copy(&stage, "other-client", &tmp.path().join("wrong")).is_err());
        let path = stage.join(name);
        let mut data = fs::read(&path).unwrap();
        data.truncate(data.len() - 1);
        fs::write(path, data).unwrap();
        let output = tmp.path().join("restored");
        assert!(open_copy(&stage, "client", &output).is_err(), "{name}");
        assert!(
            !output.exists(),
            "failed verification must leave no usable copy"
        );
    }
}

#[test]
fn client_profile_is_strict_and_contains_no_credentials() {
    let profile = ClientProfile::new("customer_client-1").unwrap();
    let bytes = profile.to_bytes().unwrap();
    assert_eq!(ClientProfile::from_bytes(&bytes).unwrap(), profile);
    let mut value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    value["clientSecret"] = "never-import-this".into();
    assert!(ClientProfile::from_bytes(&serde_json::to_vec(&value).unwrap()).is_err());
    for id in ["", "bad client", "https://evil.example", "клиент"] {
        assert!(ClientProfile::new(id).is_err());
    }
}

#[test]
fn authenticated_eof_and_wrong_key_are_checked_even_if_outer_hash_was_rewritten() {
    use markiro_backup_cloud::{
        envelope::{hash_file, read_complete},
        model::object_cap,
    };
    for wrong_key in [false, true] {
        let tmp = tempfile::tempdir().unwrap();
        let paths = source(tmp.path());
        let stage = tmp.path().join("stage");
        seal_copy(
            &paths,
            &ClientProfile::new("client").unwrap(),
            &stage,
            SnapshotId::new(),
        )
        .unwrap();
        let name = if wrong_key {
            "recovery-key.json"
        } else {
            "database.age"
        };
        if wrong_key {
            use age::secrecy::ExposeSecret;
            let mut value: serde_json::Value =
                serde_json::from_slice(&fs::read(stage.join(name)).unwrap()).unwrap();
            value["identity"] = age::x25519::Identity::generate()
                .to_string()
                .expose_secret()
                .to_owned()
                .into();
            fs::write(stage.join(name), serde_json::to_vec(&value).unwrap()).unwrap();
        } else {
            let mut bytes = fs::read(stage.join(name)).unwrap();
            bytes.pop();
            fs::write(stage.join(name), bytes).unwrap();
        }
        let mut complete = read_complete(&stage, "client").unwrap();
        complete.objects.insert(
            name.into(),
            hash_file(&stage.join(name), object_cap(name).unwrap()).unwrap(),
        );
        fs::write(
            stage.join("complete.json"),
            serde_json::to_vec(&complete).unwrap(),
        )
        .unwrap();
        assert!(open_copy(&stage, "client", &tmp.path().join("output")).is_err());
        assert!(!tmp.path().join("output").exists());
    }
}

#[test]
fn extra_files_mixed_host_and_unknown_format_are_refused() {
    for mode in ["extra", "host", "format", "objects"] {
        let tmp = tempfile::tempdir().unwrap();
        let paths = source(tmp.path());
        let stage = tmp.path().join("stage");
        seal_copy(
            &paths,
            &ClientProfile::new("client").unwrap(),
            &stage,
            SnapshotId::new(),
        )
        .unwrap();
        let mut complete: serde_json::Value =
            serde_json::from_slice(&fs::read(stage.join("complete.json")).unwrap()).unwrap();
        match mode {
            "extra" => fs::write(stage.join("unexpected"), b"extra").unwrap(),
            "host" => complete["hostId"] = uuid::Uuid::new_v4().to_string().into(),
            "format" => complete["format"] = 2.into(),
            _ => complete["objects"]["extra"] = complete["objects"]["database.age"].clone(),
        }
        fs::write(
            stage.join("complete.json"),
            serde_json::to_vec(&complete).unwrap(),
        )
        .unwrap();
        assert!(
            open_copy(&stage, "client", &tmp.path().join("output")).is_err(),
            "{mode}"
        );
    }
}

#[test]
fn duplicate_object_keys_are_refused_even_when_the_values_are_identical() {
    for different in [false, true] {
        let tmp = tempfile::tempdir().unwrap();
        let paths = source(tmp.path());
        let stage = tmp.path().join("stage");
        seal_copy(
            &paths,
            &ClientProfile::new("client").unwrap(),
            &stage,
            SnapshotId::new(),
        )
        .unwrap();
        let mut complete = markiro_backup_cloud::envelope::read_complete(&stage, "client").unwrap();
        if different {
            complete.objects.get_mut("database.age").unwrap().size_bytes += 1;
        }
        let duplicate = serde_json::to_string(&complete.objects["database.age"]).unwrap();
        let text = fs::read_to_string(stage.join("complete.json"))
            .unwrap()
            .replace(
                "\"objects\":{",
                &format!("\"objects\":{{\"database.age\":{duplicate},"),
            );
        fs::write(stage.join("complete.json"), text).unwrap();
        assert!(markiro_backup_cloud::envelope::read_complete(&stage, "client").is_err());
    }
}
