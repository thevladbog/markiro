//! The paired device (spec §5.2): `device.json`, local pairing with the host
//! on this computer, pairing by code, line selection, the line the office
//! assigns, and authenticated requests. The device key never leaves this
//! module: the webview sees `DeviceStatus`, never the key.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use markiro_proto::{
    codes, pairing, ClaimRequest, DeviceInfo, DeviceKind, DeviceLineRequest, ErrorBody,
    LocalPairRequest, PairResponse, Secret,
};
use serde::Serialize;
use serde_json::Value;
use tokio::sync::watch;

use crate::device_config::{self, DeviceConfig, RepairTarget};
use crate::host_client::{Credentials, HostResponse, PinnedClient, RequestError};
use crate::host_probe::{self, HelloObservation, ProbeError};
use crate::installation::InstallRole;
use crate::local_db::DatasetState;
use crate::secret_store;

/// A station's line (`PUT /v1/device/line`): only [`DeviceState::select_line`]
/// reaches it, so `device.json` always holds the line the host confirmed.
const LINE_ROUTE: &str = "/v1/device/line";

/// This device's own record (`GET /v1/device`), which [`DeviceState::refresh`]
/// reads for the line the office assigned and the name it gave the device.
const DEVICE_ROUTE: &str = "/v1/device";

/// The update's installer (plan ОБН-3): tens of MB, which only
/// `update_fetch` reads, straight to the disk; never through IPC.
const INSTALLER_ROUTE: &str = "/v1/device/update/installer";

/// The upload of an update package (plan ОБН-3): only `update_stage` sends
/// it, the installer streamed from the disk; never through IPC.
const UPDATE_PACKAGE_PREFIX: &str = "/v1/office/update-package/";

/// The bounds of `host_request`'s `timeoutMs` (stage 2a spec §5.2). A caller
/// may ask for a shorter answer than the client's 10 s (the scan pipeline's
/// 300 ms code check), never for a longer one.
pub const MIN_TIMEOUT_MS: u64 = 100;
pub const MAX_TIMEOUT_MS: u64 = 10_000;

/// The limit a `timeoutMs` asks for: none without one, the duration inside
/// the bounds, [`RequestError::InvalidRequest`] outside them.
pub fn request_limit(timeout_ms: Option<u64>) -> Result<Option<Duration>, DeviceError> {
    match timeout_ms {
        None => Ok(None),
        Some(ms) if (MIN_TIMEOUT_MS..=MAX_TIMEOUT_MS).contains(&ms) => {
            Ok(Some(Duration::from_millis(ms)))
        }
        Some(_) => Err(DeviceError::Request(RequestError::InvalidRequest)),
    }
}

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
    /// The name the host keeps for this device; `None` until a refresh brings
    /// it to a `device.json` written before plan 2a4.
    pub device_name: Option<String>,
}

/// What the connection task needs to reach the paired host. The key stays
/// in Rust: `Debug` hides it, and nothing serializes this type.
#[derive(Debug, Clone)]
pub struct HostLink {
    pub address: String,
    pub fingerprint: String,
    key: Secret,
    pub dataset_epoch: Option<String>,
    dataset: Arc<DatasetState>,
}

impl HostLink {
    pub fn new(address: String, fingerprint: String, key: Secret) -> Self {
        Self {
            address,
            fingerprint,
            key,
            dataset_epoch: None,
            dataset: Arc::default(),
        }
    }

    pub fn is_frozen(&self) -> bool {
        self.dataset.is_frozen()
    }

    pub fn key(&self) -> &Secret {
        &self.key
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeviceError {
    /// `device.json` exists but cannot be read, or its key cannot be unprotected.
    ConfigUnreadable,
    /// `device.json` could not be written or removed.
    Storage,
    /// A request needs a paired device and there is none.
    NotPaired,
    /// Pairing was asked for a device that is already paired.
    AlreadyPaired,
    /// Discovering the host failed.
    Probe(ProbeError),
    /// Talking to the host failed.
    Request(RequestError),
    /// The host refused the pairing request.
    PairRejected,
    /// The host that answered the pairing is not the one `hello` described.
    HostChanged,
    /// The code cannot be a code, or the host refused it: unknown, used or
    /// out of attempts.
    CodeInvalid,
    /// The pairing code has expired.
    CodeExpired,
    /// Too many pairing attempts from this computer; wait a minute.
    RateLimited,
    /// The host refused the chosen line: it is archived or does not exist.
    LineRejected,
    /// The host no longer accepts this device's key (for example, it was
    /// revoked in the office): the device needs a new pairing.
    KeyRejected,
    /// The host answered a device request with another error.
    RequestFailed,
    /// The address given for the paired host answers with another
    /// certificate: another host lives there.
    AddressOtherHost,
    /// The site's license has no seat left for this device (`conflict` on
    /// `seat_limit`, license spec §4.7): an administrator frees one in the
    /// office or extends the license. The pairing code is not spent.
    SeatLimit,
    /// The site's license does not include this kind of device (`conflict`
    /// on `feature_disabled`: a handheld without `handheld`).
    FeatureDisabled,
    DatasetResetRequired,
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
            DeviceError::LineRejected => "line_rejected",
            DeviceError::KeyRejected => "key_rejected",
            DeviceError::RequestFailed => "request_failed",
            DeviceError::AddressOtherHost => "address_other_host",
            DeviceError::SeatLimit => "seat_limit",
            DeviceError::FeatureDisabled => "feature_disabled",
            DeviceError::DatasetResetRequired => "dataset_reset_required",
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
            device_name: self.config.device_name.clone(),
        }
    }

    fn link(&self, dataset: Arc<DatasetState>) -> Arc<HostLink> {
        let mut link = HostLink::new(
            self.config.host_address.clone(),
            self.config.fingerprint.clone(),
            self.key.clone(),
        );
        link.dataset_epoch = dataset.epoch(&self.config.host_id).map(str::to_owned);
        link.dataset = dataset;
        Arc::new(link)
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
    /// The host the connection task should hold a stream to; `None` while
    /// unpaired. Replaced on pairing, forgetting and a new host address.
    link: watch::Sender<Option<Arc<HostLink>>>,
    /// The installer's role for this computer (`installation.rs`); `None`
    /// in a development build.
    role: Option<InstallRole>,
    dataset: Arc<DatasetState>,
}

impl DeviceState {
    pub(crate) fn yandex_context(&self) -> Result<YandexHost, DeviceError> {
        Ok(YandexHost {
            device: self.paired()?,
            dataset: self.dataset.clone(),
        })
    }
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
        let link = match &current {
            Current::Paired(device) => Some(device.link(Arc::default())),
            _ => None,
        };
        Self {
            dir,
            current: Mutex::new(current),
            pairing: tokio::sync::Mutex::new(()),
            link: watch::channel(link).0,
            role: None,
            dataset: Arc::default(),
        }
    }

    pub fn with_dataset(mut self, dataset: Arc<DatasetState>) -> Self {
        self.dataset = dataset;
        if let Current::Paired(device) = &*self.current.lock().expect("device lock") {
            self.link
                .send_replace(Some(device.link(self.dataset.clone())));
        }
        self
    }

    pub fn dataset(&self) -> Arc<DatasetState> {
        self.dataset.clone()
    }

    fn require_mutations(&self) -> Result<(), DeviceError> {
        if self.dataset.is_frozen() {
            Err(DeviceError::DatasetResetRequired)
        } else {
            Ok(())
        }
    }

    /// This computer's role from the installer: an office PC pairs by code
    /// as a device of kind `office` (pilot spec §9.4), every other one as a
    /// station.
    pub fn with_install_role(mut self, role: Option<InstallRole>) -> Self {
        self.role = role;
        self
    }

    pub fn install_role(&self) -> Option<InstallRole> {
        self.role
    }

    /// The kind `claim` pairs as.
    fn claim_kind(&self) -> DeviceKind {
        match self.role {
            Some(InstallRole::Office) => DeviceKind::Office,
            Some(InstallRole::Host | InstallRole::Station) | None => DeviceKind::Station,
        }
    }

    pub fn status(&self) -> Result<Option<DeviceStatus>, DeviceError> {
        match &*self.current.lock().expect("device lock") {
            Current::Unpaired => Ok(None),
            Current::Paired(device) => Ok(Some(device.status())),
            Current::Unreadable => Err(DeviceError::ConfigUnreadable),
        }
    }

    /// Follow the pairing: the connection task holds a stream while this is
    /// `Some` and stays offline while it is `None`.
    pub fn watch_link(&self) -> watch::Receiver<Option<Arc<HostLink>>> {
        self.link.subscribe()
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
        // The loopback pairing grants a station on the host's own computer; an
        // office PC is paired by code, as an office device (`claim`).
        if self.role == Some(InstallRole::Office) {
            return Err(DeviceError::Request(RequestError::InvalidRequest));
        }
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
            return Err(
                license_refusal(response.body.as_ref()).unwrap_or(DeviceError::PairRejected)
            );
        }
        self.remember(
            address,
            observation,
            client,
            name,
            response.body,
            DeviceKind::Station,
        )
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
        self.claim_intent(address, fingerprint, code, name, app_version, true)
            .await
    }

    /// [`Self::claim`] that ignores a pending repair: the code is an ordinary
    /// one and makes a new device (the person chose «новое устройство» on the
    /// pairing screen). A code made for one device is then refused by the host.
    pub async fn claim_as_new_device(
        &self,
        address: &str,
        fingerprint: &str,
        code: &str,
        name: &str,
        app_version: &str,
    ) -> Result<DeviceStatus, DeviceError> {
        self.claim_intent(address, fingerprint, code, name, app_version, false)
            .await
    }

    /// The device this station was when a repair forget removed its pairing,
    /// while no new pairing has replaced it (`repair.json`).
    pub fn repair_target(&self) -> Result<Option<RepairTarget>, DeviceError> {
        Ok(device_config::load_repair(&self.dir))
    }

    async fn claim_intent(
        &self,
        address: &str,
        fingerprint: &str,
        code: &str,
        name: &str,
        app_version: &str,
        recover: bool,
    ) -> Result<DeviceStatus, DeviceError> {
        if !is_fingerprint(fingerprint) {
            return Err(DeviceError::Request(RequestError::InvalidRequest));
        }
        // The host counts a wrong code against every live code; `normalize`
        // only stops a code of the wrong length or with a symbol outside the
        // alphabet before it reaches the host, not a typo that keeps the
        // code's shape.
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
        let kind = self.claim_kind();
        // A repair forget left the device this station was; the host re-keys
        // that device only when the claim names it, and only a code made for
        // it is accepted then. Another host's hint names nobody here.
        let recover_device_id = recover
            .then(|| device_config::load_repair(&self.dir))
            .flatten()
            .filter(|target| target.host_id == observation.hello.host_id)
            .map(|target| target.device_id);
        let request = ClaimRequest {
            code: Secret::new(code),
            kind,
            name: name.to_owned(),
            app_version: app_version.to_owned(),
            capabilities: Vec::new(),
            recover_device_id,
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
        self.remember(address, observation, client, name, response.body, kind)
    }

    /// Reach the paired host at another `address` (it got another IP
    /// address), keeping the pairing: the key, the line and the local
    /// copies. The new address is kept only when it presents the pinned
    /// certificate — the same host, since nobody else holds its private
    /// key — and the host still accepts this device's key (`GET
    /// /v1/device`); the pin stops the key before it could reach any other
    /// machine. Another certificate is `address_other_host` and changes
    /// nothing: the device stays paired with its old address. The address
    /// must be a plain `https://host[:port]` (`host_origin`): it is checked
    /// before the key goes anywhere and is kept in that plain form.
    /// Serialised with pairing, forgetting and line changes.
    pub async fn change_address(&self, address: &str) -> Result<DeviceStatus, DeviceError> {
        let _pairing = self.pairing.lock().await;
        let device = self.paired()?;
        let address = host_origin(address).map_err(DeviceError::Request)?;
        let client = PinnedClient::new(&address, &device.config.fingerprint)
            .map_err(DeviceError::Request)?;
        let response = match client
            .send(
                "GET",
                DEVICE_ROUTE,
                None,
                Credentials {
                    device_key: Some(&device.key),
                    office_token: None,
                    dataset_epoch: self.dataset.epoch(&device.config.host_id),
                },
            )
            .await
        {
            Ok(response) => response,
            Err(RequestError::CertificateMismatch) => return Err(DeviceError::AddressOtherHost),
            Err(error) => return Err(DeviceError::Request(error)),
        };
        match response.status {
            200 => {}
            401 => return Err(DeviceError::KeyRejected),
            _ => return Err(DeviceError::RequestFailed),
        }
        let config = DeviceConfig {
            host_address: address,
            ..device.config.clone()
        };
        device_config::save(&self.dir, &config).map_err(|_| DeviceError::Storage)?;
        let updated = Arc::new(PairedDevice {
            config,
            key: device.key.clone(),
            client,
        });
        let status = updated.status();
        let link = updated.link(self.dataset.clone());
        *self.current.lock().expect("device lock") = Current::Paired(updated);
        self.link.send_replace(Some(link));
        Ok(status)
    }

    /// Choose the line this station works on (`PUT /v1/device/line`) and
    /// keep the host's answer in `device.json`, so the station opens on its
    /// line even while the host is away. Serialised with pairing and
    /// forgetting, so it never writes over a pairing that changed meanwhile.
    pub async fn select_line(&self, line_id: &str) -> Result<DeviceStatus, DeviceError> {
        self.require_mutations()?;
        let _pairing = self.pairing.lock().await;
        let device = self.paired()?;
        let body = serde_json::to_value(DeviceLineRequest {
            line_id: line_id.to_owned(),
        })
        .expect("DeviceLineRequest serializes");
        let response = device
            .client
            .send(
                "PUT",
                LINE_ROUTE,
                Some(&body),
                Credentials {
                    device_key: Some(&device.key),
                    office_token: None,
                    dataset_epoch: self.dataset.epoch(&device.config.host_id),
                },
            )
            .await
            .map_err(DeviceError::Request)?;
        match response.status {
            200 => {}
            400 => return Err(line_refusal(response.body.as_ref())),
            401 => return Err(DeviceError::KeyRejected),
            _ => return Err(DeviceError::RequestFailed),
        }
        self.keep_record(&device, response.body)
    }

    /// Read this device's record again (`GET /v1/device`) and keep the line
    /// and the name the host has for it, so a line an administrator set or
    /// cleared in the office reaches the station (plan 1d3), and a rename
    /// reaches its status bar (plan 2a4). `device.json` is written only when
    /// the line or the name differs. Serialised with pairing, forgetting and
    /// [`Self::select_line`] through the same lock, so an answer never
    /// writes over a pairing or a line choice that changed meanwhile. A host
    /// that cannot be reached changes nothing: the station keeps working on
    /// its line (offline first).
    pub async fn refresh(&self) -> Result<DeviceStatus, DeviceError> {
        let _pairing = self.pairing.lock().await;
        let device = self.paired()?;
        let response = device
            .client
            .send(
                "GET",
                DEVICE_ROUTE,
                None,
                Credentials {
                    device_key: Some(&device.key),
                    office_token: None,
                    dataset_epoch: self.dataset.epoch(&device.config.host_id),
                },
            )
            .await
            .map_err(DeviceError::Request)?;
        match response.status {
            200 => {}
            401 => return Err(DeviceError::KeyRejected),
            _ => return Err(DeviceError::RequestFailed),
        }
        self.keep_record(&device, response.body)
    }

    /// Make the line and the name in the host's answer (`DeviceInfo`) this
    /// device's: `device.json` first, then the pairing in memory, and neither
    /// when both are already the ones kept. Called with the pairing lock held.
    fn keep_record(
        &self,
        device: &PairedDevice,
        body: Option<Value>,
    ) -> Result<DeviceStatus, DeviceError> {
        let info: DeviceInfo = body
            .and_then(|body| serde_json::from_value(body).ok())
            .ok_or(DeviceError::Request(RequestError::InvalidResponse))?;
        let name = Some(info.name);
        if info.line_id == device.config.line_id && name == device.config.device_name {
            return Ok(device.status());
        }
        let config = DeviceConfig {
            line_id: info.line_id,
            device_name: name,
            ..device.config.clone()
        };
        device_config::save(&self.dir, &config).map_err(|_| DeviceError::Storage)?;
        let updated = Arc::new(PairedDevice {
            config,
            key: device.key.clone(),
            client: device.client.clone(),
        });
        let status = updated.status();
        *self.current.lock().expect("device lock") = Current::Paired(updated);
        Ok(status)
    }

    fn paired(&self) -> Result<Arc<PairedDevice>, DeviceError> {
        match &*self.current.lock().expect("device lock") {
            Current::Paired(device) => Ok(device.clone()),
            Current::Unpaired => Err(DeviceError::NotPaired),
            Current::Unreadable => Err(DeviceError::ConfigUnreadable),
        }
    }

    fn ensure_unpaired(&self) -> Result<(), DeviceError> {
        match &*self.current.lock().expect("device lock") {
            Current::Unpaired => Ok(()),
            Current::Paired(_) => Err(DeviceError::AlreadyPaired),
            Current::Unreadable => Err(DeviceError::ConfigUnreadable),
        }
    }

    /// Save a pairing the host just granted and make it current. The host
    /// that answered must be the one `hello` described. The device's name is
    /// the one it paired under, trimmed as the host keeps it; a refresh
    /// replaces it with whatever the office renames it to.
    fn remember(
        &self,
        address: &str,
        observation: HelloObservation,
        client: PinnedClient,
        name: &str,
        body: Option<Value>,
        kind: DeviceKind,
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
            kind,
            line_id: None,
            device_name: Some(name.trim().to_owned()),
            device_key: secret_store::protect(pair.device_key.expose())
                .map_err(|_| DeviceError::Storage)?,
        };
        device_config::save(&self.dir, &config).map_err(|_| DeviceError::Storage)?;
        // The pairing the hint waited for exists now; a stale hint must not
        // name a device in a later claim.
        let _ = device_config::clear_repair(&self.dir);
        let device = Arc::new(PairedDevice {
            key: pair.device_key,
            client,
            config,
        });
        let status = device.status();
        let link = device.link(self.dataset.clone());
        *self.current.lock().expect("device lock") = Current::Paired(device);
        self.link.send_replace(Some(link));
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
        self.request_within(method, path, body, office_token, None)
            .await
    }

    /// [`Self::request`] with `host_request`'s `timeoutMs`: a limit outside
    /// [`MIN_TIMEOUT_MS`]..=[`MAX_TIMEOUT_MS`] is refused before any I/O,
    /// like a route the webview may not reach, and a request that runs past
    /// the limit fails with [`RequestError::Timeout`].
    pub async fn request_within(
        &self,
        method: &str,
        path: &str,
        body: Option<&Value>,
        office_token: Option<&str>,
        timeout_ms: Option<u64>,
    ) -> Result<HostResponse, DeviceError> {
        if !webview_may_reach(path) {
            return Err(DeviceError::Request(RequestError::InvalidRequest));
        }
        if method != "GET" {
            self.require_mutations()?;
        }
        let limit = request_limit(timeout_ms)?;
        let device = self.paired()?;
        device
            .client
            .send_within(
                method,
                path,
                body,
                Credentials {
                    device_key: Some(&device.key),
                    office_token,
                    dataset_epoch: self.dataset.epoch(&device.config.host_id),
                },
                limit,
            )
            .await
            .map_err(DeviceError::Request)
    }

    /// Forget the pairing on this computer (the host no longer accepts it,
    /// or `device.json` is unreadable). The host keeps its record until the
    /// device is revoked in the office. Serialised with `local_pair` so a
    /// forget cannot interleave with a pairing in progress.
    pub async fn forget(&self) -> Result<(), DeviceError> {
        self.forget_keeping(false).await
    }

    /// [`Self::forget`] of a device the host refused or whose host changed
    /// («Подключить заново»): this station keeps the ids of the device it was
    /// (`repair.json`), so the code the office makes for that device
    /// (`POST /v1/office/devices/{id}/pairing-code`) re-pairs the same device
    /// instead of making a new one, and the records this PC kept for the
    /// pairing stay its own. Without a readable pairing there is nothing to
    /// keep and the forget is the plain one.
    pub async fn forget_for_repair(&self) -> Result<(), DeviceError> {
        self.forget_keeping(true).await
    }

    async fn forget_keeping(&self, repair: bool) -> Result<(), DeviceError> {
        let _pairing = self.pairing.lock().await;
        let target = match &*self.current.lock().expect("device lock") {
            Current::Paired(device) if repair => Some(RepairTarget {
                host_id: device.config.host_id.clone(),
                device_id: device.config.device_id.clone(),
            }),
            _ => None,
        };
        // The hint first: a failure after it leaves a station still paired and
        // a hint no claim reads (the claim needs an unpaired station).
        match &target {
            Some(target) => {
                device_config::save_repair(&self.dir, target).map_err(|_| DeviceError::Storage)?
            }
            None => device_config::clear_repair(&self.dir).map_err(|_| DeviceError::Storage)?,
        }
        device_config::clear(&self.dir).map_err(|_| DeviceError::Storage)?;
        *self.current.lock().expect("device lock") = Current::Unpaired;
        self.link.send_replace(None);
        Ok(())
    }
}

pub(crate) struct YandexHost {
    device: Arc<PairedDevice>,
    dataset: Arc<DatasetState>,
}
impl YandexHost {
    pub(crate) async fn request(
        &self,
        current: &DeviceState,
        method: &str,
        path: &str,
        body: Option<&Value>,
        token: &str,
    ) -> Result<HostResponse, DeviceError> {
        if !Arc::ptr_eq(&self.device, &current.paired()?) {
            return Err(DeviceError::HostChanged);
        }
        if path != "/v1/office/me" && !path.starts_with("/v1/office/backups/yandex") {
            return Err(DeviceError::Request(RequestError::InvalidRequest));
        }
        if method != "GET" {
            current.require_mutations()?;
        }
        self.device
            .client
            .send_within(
                method,
                path,
                body,
                Credentials {
                    device_key: Some(&self.device.key),
                    office_token: Some(token),
                    dataset_epoch: self.dataset.epoch(&self.device.config.host_id),
                },
                Some(Duration::from_secs(600)),
            )
            .await
            .map_err(DeviceError::Request)
    }
}

/// Routes the webview may reach through `host_request`. Pairing routes are
/// excluded: their answers carry a new device key, which must never cross
/// IPC. The line goes through [`DeviceState::select_line`], which also keeps
/// it in `device.json` (as [`DeviceState::refresh`] keeps the line the
/// office assigns); the change stream belongs to the connection task.
/// This string-level exclusion of `LINE_ROUTE` only holds because
/// `host_client::validate_path` separately refuses a `.` path segment: it
/// stops a spelling such as `/v1/device/./line`, which a URL parser would
/// otherwise normalize past this check, from ever reaching the host.
/// The installer of an update goes through `update_fetch` only (plan ОБН-3).
fn webview_may_reach(path: &str) -> bool {
    let route = path.split('?').next().unwrap_or(path);
    let device_route = route == "/v1/device"
        || (route.starts_with("/v1/device/") && route != LINE_ROUTE && route != INSTALLER_ROUTE);
    device_route
        || route == "/v1/bootstrap"
        || route == "/v1/changes"
        || (route.starts_with("/v1/office/")
            && !route.starts_with(UPDATE_PACKAGE_PREFIX)
            && route != "/v1/office/backups/yandex/auth"
            && !route.starts_with("/v1/office/backups/yandex/auth/"))
}

/// The address of a host as it is kept in `device.json`: `https://host[:port]`
/// and nothing more. A user name or a password, a path, a query or a fragment
/// would end up in the status the webview reads and in the requests the
/// shell builds from it, and an address with white space or a control
/// character is not one a person meant. Anything else is `InvalidRequest`,
/// like an address that is not HTTPS. The kept form is the origin
/// (`scheme://host[:port]`, host in lower case, no trailing `/`).
fn host_origin(address: &str) -> Result<String, RequestError> {
    if address
        .chars()
        .any(|character| character.is_whitespace() || character.is_control())
    {
        return Err(RequestError::InvalidRequest);
    }
    let url = reqwest::Url::parse(address).map_err(|_| RequestError::InvalidRequest)?;
    let plain = url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.path() == "/"
        && url.query().is_none()
        && url.fragment().is_none();
    if plain {
        Ok(url.origin().ascii_serialization())
    } else {
        Err(RequestError::InvalidRequest)
    }
}

/// A SHA-256 fingerprint as the host prints it: 64 lower-case hex characters.
fn is_fingerprint(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

/// The license's refusal of a pairing (license spec §4.7): `conflict` with
/// `details.constraint` `seat_limit` (no seat left in the pool of stations
/// and handhelds) or `feature_disabled`; `None` for any other answer. The
/// host refuses before it spends the code (plan ЛЦ-2, Д9): the code stays good.
fn license_refusal(body: Option<&Value>) -> Option<DeviceError> {
    let body = serde_json::from_value::<ErrorBody>(body?.clone()).ok()?;
    if body.error.code != codes::CONFLICT {
        return None;
    }
    match body.error.details.as_ref()?.get("constraint")?.as_str()? {
        "seat_limit" => Some(DeviceError::SeatLimit),
        "feature_disabled" => Some(DeviceError::FeatureDisabled),
        _ => None,
    }
}

/// The error for a refused claim: the license's refusal, the host's reason
/// when it is one the webview explains, a plain refusal otherwise.
fn claim_refusal(body: Option<&Value>) -> DeviceError {
    if let Some(refusal) = license_refusal(body) {
        return refusal;
    }
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

/// The error for a refused line selection: a `validation_failed` naming the
/// `lineId` field means the host rejected the chosen line itself; any other
/// 400 — `protocol_unsupported` after a host upgrade, a malformed body's own
/// `validation_failed` on some other field, or anything else — is the
/// host's to explain, like any other unexpected refusal.
fn line_refusal(body: Option<&Value>) -> DeviceError {
    let field = body
        .and_then(|body| serde_json::from_value::<ErrorBody>(body.clone()).ok())
        .filter(|body| body.error.code == codes::VALIDATION_FAILED)
        .and_then(|body| body.error.details)
        .and_then(|details| {
            details
                .get("field")
                .and_then(Value::as_str)
                .map(str::to_owned)
        });
    if field.as_deref() == Some("lineId") {
        DeviceError::LineRejected
    } else {
        DeviceError::RequestFailed
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn webview_reachable_routes_exclude_pairing_the_line_and_the_stream() {
        for route in [
            "/v1/device",
            "/v1/device/foo",
            "/v1/bootstrap",
            "/v1/changes",
            "/v1/changes?since=5&limit=100",
            "/v1/office/me",
            "/v1/office/logout",
            "/v1/office/sscc/counters/460068200/0?since=1",
            // The offer and the office's table are small JSON (plan ОБН-3).
            "/v1/device/update",
            "/v1/office/update-status",
        ] {
            assert!(webview_may_reach(route), "{route}");
        }
        for route in [
            "/v1/local-pair",
            "/v1/pairing/claim",
            "/v1/hello",
            "/v1/devices",
            "/v1/bootstrap-status",
            "/v1/device/line",
            "/v1/device/line?lineId=1",
            "/v1/changes/stream",
            "/v1/changes/",
            "/v1/changesx",
            // Tens of MB never cross IPC: only `update_fetch` reads it (plan ОБН-3).
            "/v1/device/update/installer",
            "/v1/device/update/installer?x=1",
            // The upload goes through `update_stage` only.
            "/v1/office/update-package/manifest",
            "/v1/office/backups/yandex/auth/begin",
            "/v1/office/backups/yandex/auth/complete",
            "/v1/office/backups/yandex/auth/attempt/123?x=1",
            "/v1/office/update-package/6b1f2a3c-4d5e-4f60-8a7b-9c0d1e2f3a4b/installer",
        ] {
            assert!(!webview_may_reach(route), "{route}");
        }
    }

    #[test]
    fn a_timeout_must_lie_between_100_ms_and_10_s() {
        // The spec's numbers, not the constants: moving a bound must fail here.
        assert_eq!((MIN_TIMEOUT_MS, MAX_TIMEOUT_MS), (100, 10_000));
        assert_eq!(request_limit(None), Ok(None));
        for ms in [100, 101, 300, 9_999, 10_000] {
            assert_eq!(
                request_limit(Some(ms)),
                Ok(Some(Duration::from_millis(ms))),
                "{ms}"
            );
        }
        for ms in [0, 1, 99, 10_001, u64::MAX] {
            assert_eq!(
                request_limit(Some(ms)),
                Err(DeviceError::Request(RequestError::InvalidRequest)),
                "{ms}"
            );
        }
        assert_eq!(
            DeviceError::Request(RequestError::Timeout).code(),
            "timeout"
        );
    }

    #[test]
    fn line_and_key_error_codes_are_stable() {
        assert_eq!(DeviceError::LineRejected.code(), "line_rejected");
        assert_eq!(DeviceError::KeyRejected.code(), "key_rejected");
        assert_eq!(DeviceError::RequestFailed.code(), "request_failed");
        assert_eq!(DeviceError::AddressOtherHost.code(), "address_other_host");
    }

    #[test]
    fn only_an_office_pc_pairs_by_code_as_an_office_device() {
        let dir = tempfile::tempdir().unwrap();
        let state = |role| DeviceState::load(dir.path().to_path_buf()).with_install_role(role);
        assert_eq!(state(None).claim_kind(), DeviceKind::Station);
        assert_eq!(
            state(Some(InstallRole::Host)).claim_kind(),
            DeviceKind::Station
        );
        assert_eq!(
            state(Some(InstallRole::Station)).claim_kind(),
            DeviceKind::Station
        );
        assert_eq!(
            state(Some(InstallRole::Office)).claim_kind(),
            DeviceKind::Office
        );
        assert_eq!(
            state(Some(InstallRole::Office)).install_role(),
            Some(InstallRole::Office)
        );
    }

    #[test]
    fn a_host_address_is_a_https_origin_and_nothing_else() {
        for (typed, kept) in [
            ("https://192.168.1.20:45710", "https://192.168.1.20:45710"),
            ("https://192.168.1.20:45710/", "https://192.168.1.20:45710"),
            ("HTTPS://Host-PC.local:45710", "https://host-pc.local:45710"),
            ("https://[fd00::20]:45710", "https://[fd00::20]:45710"),
            ("https://host-pc", "https://host-pc"),
        ] {
            assert_eq!(host_origin(typed), Ok(kept.to_owned()), "{typed}");
        }
        for typed in [
            "",
            "192.168.1.20:45710",
            "http://192.168.1.20:45710",
            "ftp://192.168.1.20:45710",
            "https://",
            "https://user@192.168.1.20:45710",
            "https://:secret@192.168.1.20:45710",
            "https://192.168.1.20:45710/v1/hello",
            "https://192.168.1.20:45710//",
            "https://192.168.1.20:45710?a=1",
            "https://192.168.1.20:45710#a",
            " https://192.168.1.20:45710",
            "https://192.168.1.20:45710\t",
            "https://192.168.1.20:45710\u{0}",
            "https://192.168.1.20:99999",
        ] {
            assert_eq!(
                host_origin(typed),
                Err(RequestError::InvalidRequest),
                "{typed:?}"
            );
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
            device_name: Some("Станция на линии 1".into()),
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
            "deviceName",
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
    fn license_refusals_of_a_pairing_keep_their_reason() {
        let conflict = |constraint: &str| {
            json!({ "error": { "code": "conflict", "message": "refused", "details": {
                "constraint": constraint, "quota": "stations", "used": 3, "limit": 3
            } } })
        };
        assert_eq!(
            claim_refusal(Some(&conflict("seat_limit"))),
            DeviceError::SeatLimit
        );
        assert_eq!(
            claim_refusal(Some(&conflict("feature_disabled"))),
            DeviceError::FeatureDisabled
        );
        assert_eq!(
            claim_refusal(Some(&conflict("license_restricted"))),
            DeviceError::PairRejected
        );
        assert_eq!(
            license_refusal(Some(&conflict("seat_limit"))),
            Some(DeviceError::SeatLimit)
        );
        // A constraint under another code is no license refusal.
        assert_eq!(
            license_refusal(Some(&json!({ "error": { "code": "validation_failed",
                "message": "", "details": { "constraint": "seat_limit" } } }))),
            None
        );
        assert_eq!(
            license_refusal(Some(
                &json!({ "error": { "code": "conflict", "message": "" } })
            )),
            None
        );
        assert_eq!(license_refusal(None), None);
        assert_eq!(DeviceError::SeatLimit.code(), "seat_limit");
        assert_eq!(DeviceError::FeatureDisabled.code(), "feature_disabled");
    }

    #[test]
    fn line_refusals_keep_the_reason_the_webview_explains() {
        let validation = |field: &str| json!({ "error": { "code": "validation_failed", "message": "refused", "details": { "field": field } } });
        assert_eq!(
            line_refusal(Some(&validation("lineId"))),
            DeviceError::LineRejected
        );
        // `validation_failed` on some other field is not about the chosen
        // line: the webview should not be told to try a different line.
        assert_eq!(
            line_refusal(Some(&validation("name"))),
            DeviceError::RequestFailed
        );
        assert_eq!(
            line_refusal(Some(
                &json!({ "error": { "code": "validation_failed", "message": "malformed body" } })
            )),
            DeviceError::RequestFailed
        );
        assert_eq!(
            line_refusal(Some(
                &json!({ "error": { "code": "protocol_unsupported", "message": "" } })
            )),
            DeviceError::RequestFailed
        );
        assert_eq!(
            line_refusal(Some(&json!("not an error body"))),
            DeviceError::RequestFailed
        );
        assert_eq!(line_refusal(None), DeviceError::RequestFailed);
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
