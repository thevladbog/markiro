//! Update distribution through the host (plan ОБН-3, spec §10.11): the state
//! of the host's package and the shapes of the office's upload, a device's
//! offer and the office's table of versions. The version rule, the
//! installer's name and the exact-size hash are the parent module's (plan
//! ОБН-2).
//!
//! `GET /v1/device/update` answers devices of any protocol version (it is
//! outside `protocol_guard`, like `hello`), so [`DeviceUpdateOffer`] is frozen
//! the same way: new fields only additive, read leniently, and a package
//! state this build does not know reads as [`PackageState::Unknown`].

use serde::{Deserialize, Serialize};

use crate::DeviceKind;

/// The longest manifest the host takes (spec §10.11.2).
pub const MAX_MANIFEST_BYTES: usize = 64 * 1024;
/// The largest installer the host takes and a device downloads (spec §10.11.2).
pub const MAX_INSTALLER_BYTES: u64 = 256 * 1024 * 1024;

/// `details.constraint` of a `conflict` on the distribution routes.
pub mod constraints {
    /// The uploaded manifest is not newer than the running host.
    pub const PACKAGE_NOT_NEWER: &str = "package_not_newer";
    /// The host has no package to serve (`missing`, `mismatch`, `invalid`).
    pub const PACKAGE_UNAVAILABLE: &str = "package_unavailable";
    /// No upload of this id waits for its installer: another replaced it, or
    /// the host restarted.
    pub const UPLOAD_UNKNOWN: &str = "upload_unknown";
    /// The host's disk is full; the current package is untouched.
    pub const DISK_FULL: &str = "disk_full";
}

/// `details.reason` of a `validation_failed` on `manifest` or `installer`.
pub mod reasons {
    pub const MANIFEST_MALFORMED: &str = "manifest_malformed";
    pub const MANIFEST_UNKNOWN_KEY: &str = "manifest_unknown_key";
    pub const MANIFEST_SIGNATURE: &str = "manifest_signature";
    pub const WRONG_PRODUCT: &str = "wrong_product";
    /// The manifest is over 64 KiB, or names an installer over the limit.
    pub const TOO_LARGE: &str = "too_large";
    /// No `Content-Length`, one other than `sizeBytes`, or a shorter body.
    pub const SIZE_MISMATCH: &str = "size_mismatch";
    /// A byte beyond `sizeBytes`: the upload was cut there.
    pub const TOO_LONG: &str = "too_long";
    pub const HASH_MISMATCH: &str = "hash_mismatch";
}

/// The state of the host's current package (spec §10.11.2); only `ok` is
/// served.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PackageState {
    Ok,
    Missing,
    /// The manifest's version is not the host's (a restore from a copy of
    /// another version, a package that was never promoted).
    Mismatch,
    /// The signature, the size or the SHA-256 does not check out.
    Invalid,
    /// The files changed since the last full check, which runs now.
    Verifying,
    /// A state of a newer host: a device reads it as «unavailable». Never
    /// written by this build.
    #[serde(other)]
    Unknown,
}

/// The package part of [`DeviceUpdateOffer`]; the fields beside `state` are
/// there only for `ok`, and only for showing before the device checked
/// `manifest` itself.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfferedPackage {
    pub state: PackageState,
    /// The signed manifest's text, as uploaded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub manifest: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
}

impl OfferedPackage {
    /// A package that is not served: the state alone.
    pub fn unavailable(state: PackageState) -> Self {
        Self {
            state,
            manifest: None,
            version: None,
            size_bytes: None,
            sha256: None,
        }
    }
}

/// `GET /v1/device/update` (spec §10.11.3).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceUpdateOffer {
    pub host_version: String,
    pub package: OfferedPackage,
}

/// `POST /v1/office/update-package/manifest`: the signed manifest's text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdatePackageManifestRequest {
    pub manifest: String,
}

/// The answer to the manifest: the upload the installer goes to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdatePackageUpload {
    pub upload_id: String,
    pub version: String,
    pub size_bytes: u64,
    pub sha256: String,
}

/// `PUT /v1/office/update-package/{uploadId}/installer`: the package is
/// `staged\` now.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdatePackageStaged {
    pub version: String,
    pub size_bytes: u64,
    pub sha256: String,
}

/// The host's packages as the office sees them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostPackage {
    pub state: PackageState,
    /// The current package's version (`ok`, `mismatch`).
    pub version: Option<String>,
    /// The waiting package's version, when one waits.
    pub staged: Option<String>,
    pub previous: Option<String>,
    /// What `updates\` takes on the host's disk.
    pub disk_bytes: u64,
}

/// A device's version against the host's (spec §10.11.7).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeviceVersionState {
    Current,
    /// Older, its protocol still taken: works, the update is offered.
    Behind,
    /// Its protocol is below the host's minimum: it does not connect.
    Incompatible,
    Newer,
    /// The device never sent its version (`version_seen_at` is empty).
    Unknown,
}

/// When and of which version a device's last download or installation began.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMark {
    pub at: String,
    pub version: Option<String>,
}

/// One row of «Устройства и версии».
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceVersion {
    pub id: String,
    pub kind: DeviceKind,
    pub name: String,
    pub line_id: Option<String>,
    pub line_name: Option<String>,
    pub app_version: String,
    pub protocol: u32,
    pub version_seen_at: Option<String>,
    pub last_seen_at: Option<String>,
    pub state: DeviceVersionState,
    pub downloaded: Option<UpdateMark>,
    pub install_started: Option<UpdateMark>,
}

/// One row of the update history: an audit row of the distribution, the
/// actor by name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateHistoryItem {
    pub at: String,
    pub action: String,
    pub result: String,
    pub actor: Option<String>,
    pub version: Option<String>,
    pub from: Option<String>,
    pub to: Option<String>,
}

/// `GET /v1/office/update-status` (every office role).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeUpdateStatus {
    pub host_version: String,
    pub protocol: u32,
    pub min_protocol: u32,
    pub package: HostPackage,
    pub devices: Vec<DeviceVersion>,
    pub history: Vec<UpdateHistoryItem>,
}

/// Update manifests signed during a test with the TEST release key of
/// `packages/domain/fixtures/standalone-license/test-private-keys.json`: the
/// host's and the shell's suites need packages of the running build's
/// version, which committed fixtures (plan ОБН-2) cannot know. Feature
/// `test-keys` only: a release build has neither the key nor this code.
#[cfg(feature = "test-keys")]
pub mod testing {
    use aws_lc_rs::rand::SystemRandom;
    use aws_lc_rs::signature::{EcdsaKeyPair, ECDSA_P256_SHA256_FIXED_SIGNING};
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine;
    use serde_json::{json, Value};

    const TEST_PRIVATE_KEYS: &str = include_str!(
        "../../../../../packages/domain/fixtures/standalone-license/test-private-keys.json"
    );

    /// `payload` (the manifest of spec §10.2) as a compact JWS of the update
    /// type, signed with the test release key.
    pub fn sign_update_manifest(payload: &Value) -> String {
        sign("markiro-standalone-update+jws", "update", payload)
    }

    fn sign(typ: &str, purpose: &str, payload: &Value) -> String {
        let keys: Value = serde_json::from_str(TEST_PRIVATE_KEYS).expect("the test keys read");
        let entry = &keys[purpose];
        let kid = entry["kid"].as_str().expect("a test key names its kid");
        let part = |name: &str| {
            URL_SAFE_NO_PAD
                .decode(entry["privateJwk"][name].as_str().expect("a JWK part"))
                .expect("base64url")
        };
        let mut public = vec![4u8];
        public.extend(part("x"));
        public.extend(part("y"));
        let pair = EcdsaKeyPair::from_private_key_and_public_key(
            &ECDSA_P256_SHA256_FIXED_SIGNING,
            &part("d"),
            &public,
        )
        .expect("the test key pair");
        let header = json!({ "typ": typ, "alg": "ES256", "kid": kid });
        let input = format!(
            "{}.{}",
            URL_SAFE_NO_PAD.encode(header.to_string()),
            URL_SAFE_NO_PAD.encode(payload.to_string())
        );
        let signature = pair
            .sign(&SystemRandom::new(), input.as_bytes())
            .expect("signing");
        format!("{input}.{}", URL_SAFE_NO_PAD.encode(signature.as_ref()))
    }
}
