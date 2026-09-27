//! The paired device (spec §5.2): `device.json`, local pairing with the host
//! on this computer, and authenticated requests. The device key never leaves
//! this module: the webview sees `DeviceStatus`, never the key.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use markiro_proto::{
    codes, pairing, ClaimRequest, DeviceKind, ErrorBody, LocalPairRequest, PairResponse, Secret,
};
use serde::Serialize;
use serde_json::Value;

use crate::device_config::{self, DeviceConfig};
use crate::host_client::{Credentials, HostResponse, PinnedClient, RequestError};
use crate::host_probe::{self, HelloObservation, ProbeError};
use crate::secret_store;

/// What the webview may know about the pairing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceStatus {
    pub host_address: String,
    pub fingerprint: String,
    pub host_id: String,
    pub device_id: String,
    pub kind: DeviceKind,
    pub line_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeviceError {
    /// `device.json` exists but cannot be read, or its key cannot be unprotected.
    ConfigUnreadable,
    /// `device.json` could not be written or removed.
    Storage,
    /// A request needs a paired device and there is none.
    NotPaired,
    /// Local pairing was asked for a device that is already paired.
    AlreadyPaired,
    /// Discovering the host failed.
    Probe(ProbeError),
    /// Talking to the host failed.
    Request(RequestError),
    /// The host refused the pairing request.
    PairRejected,
    /// The host that answered the pairing is not the one `hello` described.
    HostChanged,
    /// The host refused the pairing code: unknown, used or out of attempts.
    CodeInvalid,
    /// The pairing code has expired.
    CodeExpired,
    /// Too many pairing attempts from this computer; wait a minute.
    RateLimited,
}

impl DeviceError {
    /// Stable codes the webview maps to text (`src/host/device.ts`).
    pub fn code(&self) -> &'static str {
        match self {
            DeviceError::ConfigUnreadable => "config_unreadable",
            DeviceError::Storage => "storage",
            DeviceError::NotPaired => "not_paired",
            DeviceError::AlreadyPaired => "already_paired",
            DeviceError::Probe(error) => error.code(),
            DeviceError::Request(error) => error.code(),
            DeviceError::PairRejected => "pair_rejected",
            DeviceError::HostChanged => "host_changed",
            DeviceError::CodeInvalid => codes::PAIRING_CODE_INVALID,
            DeviceError::CodeExpired => codes::PAIRING_CODE_EXPIRED,
            DeviceError::RateLimited => codes::RATE_LIMITED,
        }
    }
}

struct PairedDevice {
    config: DeviceConfig,
    key: Secret,
    client: PinnedClient,
}

impl PairedDevice {
    fn open(config: DeviceConfig) -> Result<Self, DeviceError> {
        let key = secret_store::unprotect(&config.device_key)
            .map_err(|_| DeviceError::ConfigUnreadable)?;
        let client = PinnedClient::new(&config.host_address, &config.fingerprint)
            .map_err(DeviceError::Request)?;
        Ok(Self {
            config,
            key: Secret::from(key),
            client,
        })
    }

    fn status(&self) -> DeviceStatus {
        DeviceStatus {
            host_address: self.config.host_address.clone(),
            fingerprint: self.config.fingerprint.clone(),
            host_id: self.config.host_id.clone(),
            device_id: self.config.device_id.clone(),
            kind: self.config.kind,
            line_id: self.config.line_id.clone(),
        }
    }
}

enum Current {
    Unpaired,
    Paired(Arc<PairedDevice>),
    Unreadable,
}

/// Tauri state: the pairing of this app installation.
pub struct DeviceState {
    dir: PathBuf,
    current: Mutex<Current>,
    pairing: tokio::sync::Mutex<()>,
}

impl DeviceState {
    /// Read `device.json` from the app's local data directory `dir`; an
    /// unreadable file is reported by `status` until `forget` removes it.
    pub fn load(dir: PathBuf) -> Self {
        let current = match device_config::load(&dir) {
            Ok(None) => Current::Unpaired,
            Ok(Some(config)) => match PairedDevice::open(config) {
                Ok(device) => Current::Paired(Arc::new(device)),
                Err(_) => Current::Unreadable,
            },
            Err(_) => Current::Unreadable,
        };
        Self {
            dir,
            current: Mutex::new(current),
            pairing: tokio::sync::Mutex::new(()),
        }
    }

    pub fn status(&self) -> Result<Option<DeviceStatus>, DeviceError> {
        match &*self.current.lock().expect("device lock") {
            Current::Unpaired => Ok(None),
            Current::Paired(device) => Ok(Some(device.status())),
            Current::Unreadable => Err(DeviceError::ConfigUnreadable),
        }
    }

    /// Pair with the host at `address` over loopback (`POST /v1/local-pair`)
    /// and remember it. Calls are serialised: a second call waits for the
    /// first and then finds the device already paired.
    pub async fn local_pair(
        &self,
        address: &str,
        name: &str,
        app_version: &str,
    ) -> Result<DeviceStatus, DeviceError> {
        let _pairing = self.pairing.lock().await;
        self.ensure_unpaired()?;
        let observation = host_probe::observe_hello(address)
            .await
            .map_err(DeviceError::Probe)?;
        let client =
            PinnedClient::new(address, &observation.fingerprint).map_err(DeviceError::Request)?;
        let request = LocalPairRequest {
            kind: DeviceKind::Station,
            name: name.to_owned(),
            app_version: app_version.to_owned(),
            capabilities: Vec::new(),
        };
        let body = serde_json::to_value(&request).expect("LocalPairRequest serializes");
        let response = client
            .send(
                "POST",
                "/v1/local-pair",
                Some(&body),
                Credentials::default(),
            )
            .await
            .map_err(DeviceError::Request)?;
        if response.status != 200 {
            return Err(DeviceError::PairRejected);
        }
        self.remember(address, observation, client, response.body)
    }

    /// Pair with the host at `address` using a one-time `code` from the
    /// office (`POST /v1/pairing/claim`). `fingerprint` is the one in the
    /// scanned pairing code, or one a person compared with the office
    /// screen. A code that cannot be a code is refused before any I/O; a real
    /// one goes out in canonical form only after `hello` showed that
    /// certificate, and only through a client that pins it, so no other
    /// machine on the network ever receives it.
    pub async fn claim(
        &self,
        address: &str,
        fingerprint: &str,
        code: &str,
        name: &str,
        app_version: &str,
    ) -> Result<DeviceStatus, DeviceError> {
        if !is_fingerprint(fingerprint) {
            return Err(DeviceError::Request(RequestError::InvalidRequest));
        }
        // The host counts a wrong code against every live code: a typo must
        // not reach it.
        let Some(code) = pairing::normalize(code) else {
            return Err(DeviceError::CodeInvalid);
        };
        let _pairing = self.pairing.lock().await;
        self.ensure_unpaired()?;
        let observation = host_probe::observe_hello(address)
            .await
            .map_err(DeviceError::Probe)?;
        if observation.fingerprint != fingerprint {
            return Err(DeviceError::Request(RequestError::CertificateMismatch));
        }
        let client = PinnedClient::new(address, fingerprint).map_err(DeviceError::Request)?;
        let request = ClaimRequest {
            code: Secret::new(code),
            kind: DeviceKind::Station,
            name: name.to_owned(),
            app_version: app_version.to_owned(),
            capabilities: Vec::new(),
        };
        let body = serde_json::to_value(&request).expect("ClaimRequest serializes");
        let response = client
            .send(
                "POST",
                "/v1/pairing/claim",
                Some(&body),
                Credentials::default(),
            )
            .await
            .map_err(DeviceError::Request)?;
        if response.status != 200 {
            return Err(claim_refusal(response.body.as_ref()));
        }
        self.remember(address, observation, client, response.body)
    }

    fn ensure_unpaired(&self) -> Result<(), DeviceError> {
        match &*self.current.lock().expect("device lock") {
            Current::Unpaired => Ok(()),
            Current::Paired(_) => Err(DeviceError::AlreadyPaired),
            Current::Unreadable => Err(DeviceError::ConfigUnreadable),
        }
    }

    /// Save a pairing the host just granted and make it current. The host
    /// that answered must be the one `hello` described.
    fn remember(
        &self,
        address: &str,
        observation: HelloObservation,
        client: PinnedClient,
        body: Option<Value>,
    ) -> Result<DeviceStatus, DeviceError> {
        let pair: PairResponse = body
            .and_then(|body| serde_json::from_value(body).ok())
            .ok_or(DeviceError::Request(RequestError::InvalidResponse))?;
        if pair.host_id != observation.hello.host_id {
            return Err(DeviceError::HostChanged);
        }
        let config = DeviceConfig {
            host_address: address.trim_end_matches('/').to_owned(),
            fingerprint: observation.fingerprint,
            host_id: pair.host_id,
            device_id: pair.device_id,
            kind: DeviceKind::Station,
            line_id: None,
            device_key: secret_store::protect(pair.device_key.expose())
                .map_err(|_| DeviceError::Storage)?,
        };
        device_config::save(&self.dir, &config).map_err(|_| DeviceError::Storage)?;
        let device = Arc::new(PairedDevice {
            key: pair.device_key,
            client,
            config,
        });
        let status = device.status();
        *self.current.lock().expect("device lock") = Current::Paired(device);
        Ok(status)
    }

    /// Send a request to the paired host with this device's key and, for
    /// office routes, the session token.
    pub async fn request(
        &self,
        method: &str,
        path: &str,
        body: Option<&Value>,
        office_token: Option<&str>,
    ) -> Result<HostResponse, DeviceError> {
        if !webview_may_reach(path) {
            return Err(DeviceError::Request(RequestError::InvalidRequest));
        }
        let device = match &*self.current.lock().expect("device lock") {
            Current::Paired(device) => device.clone(),
            Current::Unpaired => return Err(DeviceError::NotPaired),
            Current::Unreadable => return Err(DeviceError::ConfigUnreadable),
        };
        device
            .client
            .send(
                method,
                path,
                body,
                Credentials {
                    device_key: Some(&device.key),
                    office_token,
                },
            )
            .await
            .map_err(DeviceError::Request)
    }

    /// Forget the pairing on this computer (the host no longer accepts it,
    /// or `device.json` is unreadable). The host keeps its record until the
    /// device is revoked in the office. Serialised with `local_pair` so a
    /// forget cannot interleave with a pairing in progress.
    pub async fn forget(&self) -> Result<(), DeviceError> {
        let _pairing = self.pairing.lock().await;
        device_config::clear(&self.dir).map_err(|_| DeviceError::Storage)?;
        *self.current.lock().expect("device lock") = Current::Unpaired;
        Ok(())
    }
}

/// Routes the webview may reach through `host_request`. Pairing routes are
/// excluded: their answers carry a new device key, which must never cross
/// IPC.
fn webview_may_reach(path: &str) -> bool {
    let route = path.split('?').next().unwrap_or(path);
    route == "/v1/device"
        || route.starts_with("/v1/device/")
        || route == "/v1/bootstrap"
        || route.starts_with("/v1/office/")
}

/// A SHA-256 fingerprint as the host prints it: 64 lower-case hex characters.
fn is_fingerprint(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

/// The error for a refused claim: the host's reason when it is one the
/// webview explains, a plain refusal otherwise.
fn claim_refusal(body: Option<&Value>) -> DeviceError {
    let code = body
        .and_then(|body| serde_json::from_value::<ErrorBody>(body.clone()).ok())
        .map(|body| body.error.code);
    match code.as_deref() {
        Some(codes::PAIRING_CODE_INVALID) => DeviceError::CodeInvalid,
        Some(codes::PAIRING_CODE_EXPIRED) => DeviceError::CodeExpired,
        Some(codes::RATE_LIMITED) => DeviceError::RateLimited,
        _ => DeviceError::PairRejected,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn webview_reachable_routes_exclude_pairing() {
        for route in [
            "/v1/device",
            "/v1/device/foo",
            "/v1/bootstrap",
            "/v1/office/me",
            "/v1/office/logout",
            "/v1/office/sscc/counters/460068200/0?since=1",
        ] {
            assert!(webview_may_reach(route), "{route}");
        }
        for route in [
            "/v1/local-pair",
            "/v1/pairing/claim",
            "/v1/hello",
            "/v1/devices",
            "/v1/bootstrap-status",
        ] {
            assert!(!webview_may_reach(route), "{route}");
        }
    }

    #[test]
    fn device_status_serializes_to_the_expected_camel_case_keys_only() {
        let status = DeviceStatus {
            host_address: "https://127.0.0.1:45710".into(),
            fingerprint: "ab".repeat(32),
            host_id: "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f".into(),
            device_id: "7c9e6679-7425-40de-944b-e07fc1f90ae7".into(),
            kind: DeviceKind::Station,
            line_id: None,
        };
        let value = serde_json::to_value(&status).expect("DeviceStatus serializes");
        let object = value.as_object().expect("DeviceStatus is a JSON object");
        let mut keys: Vec<&str> = object.keys().map(String::as_str).collect();
        keys.sort_unstable();
        let mut expected = vec![
            "hostAddress",
            "fingerprint",
            "hostId",
            "deviceId",
            "kind",
            "lineId",
        ];
        expected.sort_unstable();
        assert_eq!(keys, expected);
        assert!(!object.contains_key("key"));
    }

    #[test]
    fn claim_refusals_keep_the_reason_the_webview_explains() {
        let body = |code: &str| json!({ "error": { "code": code, "message": "refused" } });
        assert_eq!(
            claim_refusal(Some(&body("pairing_code_invalid"))),
            DeviceError::CodeInvalid
        );
        assert_eq!(
            claim_refusal(Some(&body("pairing_code_expired"))),
            DeviceError::CodeExpired
        );
        assert_eq!(
            claim_refusal(Some(&body("rate_limited"))),
            DeviceError::RateLimited
        );
        assert_eq!(
            claim_refusal(Some(&body("validation_failed"))),
            DeviceError::PairRejected
        );
        assert_eq!(
            claim_refusal(Some(&json!("not an error body"))),
            DeviceError::PairRejected
        );
        assert_eq!(claim_refusal(None), DeviceError::PairRejected);
    }

    #[test]
    fn claim_error_codes_match_the_hosts() {
        assert_eq!(DeviceError::CodeInvalid.code(), "pairing_code_invalid");
        assert_eq!(DeviceError::CodeExpired.code(), "pairing_code_expired");
        assert_eq!(DeviceError::RateLimited.code(), "rate_limited");
    }

    #[test]
    fn fingerprints_are_64_lower_case_hex_characters() {
        assert!(is_fingerprint(&"0123456789abcdef".repeat(4)));
        for value in [
            "",
            "AB".repeat(32).as_str(),
            "ab".repeat(33).as_str(),
            "gg".repeat(32).as_str(),
        ] {
            assert!(!is_fingerprint(value), "{value:?}");
        }
    }
}
