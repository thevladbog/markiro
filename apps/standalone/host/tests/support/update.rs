//! Update packages of the distribution suites (plan ОБН-3): manifests signed
//! with the test release key, installers of a few hundred KiB so a stream
//! goes in several 64 KiB pieces.

use std::path::Path;

use markiro_proto::update::distribution::testing::sign_update_manifest;
use serde_json::{json, Value};

/// The bytes of a test installer of `version`: unlike any other version's.
pub fn installer_bytes(version: &str) -> Vec<u8> {
    format!("MZ markiro test installer {version}\n")
        .repeat(8_000)
        .into_bytes()
}

pub fn installer_name(version: &str) -> String {
    format!("markiro-standalone-{version}-windows-x86_64-setup.exe")
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    markiro_proto::update::hash_exact(bytes, bytes.len() as u64).unwrap()
}

/// The manifest of spec §10.2 for an installer of `bytes`.
pub fn manifest_payload(version: &str, bytes: &[u8]) -> Value {
    json!({
        "v": 1, "product": "markiro-standalone", "version": version, "channel": "stable",
        "releasedAt": "2026-11-02T10:00:00Z",
        "sourceSha": "0123456789abcdef0123456789abcdef01234567",
        "installer": {
            "name": installer_name(version), "sha256": sha256_hex(bytes), "sizeBytes": bytes.len()
        },
        "protocol": markiro_proto::PROTOCOL_VERSION,
        "minProtocol": markiro_proto::MIN_PROTOCOL_VERSION,
        "minUpgradeFrom": "0.1.0",
        "notes": ["Тестовый выпуск"]
    })
}

pub fn signed_manifest(version: &str, bytes: &[u8]) -> String {
    sign_update_manifest(&manifest_payload(version, bytes))
}

/// A package of `version` in `<updates>/<folder>`: its manifest and its
/// installer bytes.
pub fn write_package(updates: &Path, folder: &str, version: &str) -> (String, Vec<u8>) {
    let bytes = installer_bytes(version);
    let dir = updates.join(folder);
    std::fs::create_dir_all(&dir).unwrap();
    let manifest = signed_manifest(version, &bytes);
    std::fs::write(dir.join("manifest.update.jws"), &manifest).unwrap();
    std::fs::write(dir.join(installer_name(version)), &bytes).unwrap();
    (manifest, bytes)
}

/// Flip one byte of `path` in place (the size stays).
pub fn flip_byte(path: &Path, at: usize) {
    let mut bytes = std::fs::read(path).unwrap();
    bytes[at] ^= 0x01;
    std::fs::write(path, bytes).unwrap();
}

/// The keyset of the release key with the test key in it (`test-keys`).
pub fn keyset() -> markiro_proto::trust::Keyset {
    markiro_proto::trust::update_keyset()
}
