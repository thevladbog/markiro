use std::{
    fmt,
    future::Future,
    io,
    pin::Pin,
    sync::{
        atomic::{AtomicU8, Ordering},
        Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use base64::Engine as _;
use futures_util::StreamExt;
use minisign_verify::{PublicKey, Signature};
use reqwest::{
    header::{HeaderValue, ACCEPT, CONTENT_LENGTH},
    ClientBuilder,
};
use serde::{Deserialize, Serialize};
use tauri::{ipc::Channel, AppHandle, Runtime, State};
use tauri_plugin_updater::{Update, UpdaterExt};
use url::Url;
use zeroize::Zeroizing;

const WINDOWS_TARGET: &str = "windows-x86_64";
const UPDATE_CHECK_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_CLOCK_SKEW_SECONDS: i64 = 5 * 60;
const MAX_SAFE_VERSION_COMPONENT: u64 = 9_007_199_254_740_991;
const MAX_PACKAGE_BYTES: usize = 512 * 1024 * 1024;
const UPDATER_USER_AGENT: &str = "tauri-plugin-updater/2.10.1";
pub(crate) const CANDIDATE_TTL: Duration = Duration::from_secs(15 * 60);

const BETA_YANDEX_ENDPOINT: &str = "https://releases.markiro.app/station/beta/latest.json";
const BETA_GITHUB_ENDPOINT: &str =
    "https://github.com/thevladbog/markiro/releases/download/station-beta-channel/latest.json";
const STABLE_YANDEX_ENDPOINT: &str = "https://releases.markiro.app/station/stable/latest.json";
const STABLE_GITHUB_ENDPOINT: &str =
    "https://github.com/thevladbog/markiro/releases/download/station-stable-channel/latest.json";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum StationReleaseOrigin {
    Yandex,
    Github,
}

impl StationReleaseOrigin {
    fn peer(self) -> Self {
        match self {
            Self::Yandex => Self::Github,
            Self::Github => Self::Yandex,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum StationReleaseChannel {
    Beta,
    Stable,
}

impl StationReleaseChannel {
    fn endpoints(self) -> [(&'static str, StationReleaseOrigin); 2] {
        match self {
            Self::Beta => [
                (BETA_YANDEX_ENDPOINT, StationReleaseOrigin::Yandex),
                (BETA_GITHUB_ENDPOINT, StationReleaseOrigin::Github),
            ],
            Self::Stable => [
                (STABLE_YANDEX_ENDPOINT, StationReleaseOrigin::Yandex),
                (STABLE_GITHUB_ENDPOINT, StationReleaseOrigin::Github),
            ],
        }
    }

    fn endpoint(self, origin: StationReleaseOrigin) -> &'static str {
        self.endpoints()
            .into_iter()
            .find_map(|(endpoint, candidate_origin)| {
                (candidate_origin == origin).then_some(endpoint)
            })
            .expect("closed release channel contains both origins")
    }

    fn from_compiled_endpoints(endpoints: &[&str]) -> Result<Self, StationUpdateError> {
        match endpoints {
            [BETA_YANDEX_ENDPOINT, BETA_GITHUB_ENDPOINT] => Ok(Self::Beta),
            [STABLE_YANDEX_ENDPOINT, STABLE_GITHUB_ENDPOINT] => Ok(Self::Stable),
            _ => Err(StationUpdateError::policy_denied()),
        }
    }

    fn accepts_version(self, version: &semver::Version) -> bool {
        if !version.build.is_empty()
            || [version.major, version.minor, version.patch]
                .into_iter()
                .any(|component| component > MAX_SAFE_VERSION_COMPONENT)
        {
            return false;
        }

        match self {
            Self::Beta => {
                let Some(number) = version.pre.as_str().strip_prefix("beta.") else {
                    return false;
                };
                number
                    .parse::<u64>()
                    .is_ok_and(|number| number > 0 && number <= MAX_SAFE_VERSION_COMPONENT)
            }
            Self::Stable => version.pre.is_empty(),
        }
    }

    fn expected_download_url(self, origin: StationReleaseOrigin, version: &str) -> String {
        let filename = format!("markiro-station-{version}-windows-x86_64.nsis.zip");
        match origin {
            StationReleaseOrigin::Yandex => {
                let channel = match self {
                    Self::Beta => "beta",
                    Self::Stable => "stable",
                };
                format!(
                    "https://releases.markiro.app/station/{channel}/releases/{version}/{filename}"
                )
            }
            StationReleaseOrigin::Github => format!(
                "https://github.com/thevladbog/markiro/releases/download/station-v{version}/{filename}"
            ),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum StationFallbackReason {
    PrimaryUnavailable,
    PrimaryMetadataInvalid,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CandidateMetadata {
    current_version: String,
    version: String,
    target: String,
    published_at: String,
    published_unix: i64,
    signature: String,
    download_url: String,
}

impl CandidateMetadata {
    fn has_same_signed_target(&self, peer: &Self) -> bool {
        self.current_version == peer.current_version
            && self.version == peer.version
            && self.target == peer.target
            && self.published_at == peer.published_at
            && self.published_unix == peer.published_unix
            && self.signature == peer.signature
    }
}

pub(crate) trait DiscoveryCandidate: Send {
    fn metadata(&self) -> &CandidateMetadata;
}

#[derive(Debug)]
pub(crate) enum DiscoveryFailure {
    Availability(String),
    MetadataInvalid(String),
    Integrity(String),
    SecurityPolicy(String),
}

type DiscoveryFuture<'a, C> =
    Pin<Box<dyn Future<Output = Result<Option<C>, DiscoveryFailure>> + Send + 'a>>;

pub(crate) trait DiscoveryTransport: Sync {
    type Candidate: DiscoveryCandidate;

    fn check(
        &self,
        origin: StationReleaseOrigin,
        endpoint: &'static str,
    ) -> DiscoveryFuture<'_, Self::Candidate>;
}

#[derive(Debug)]
pub(crate) struct DiscoveredCandidate<C> {
    candidate: C,
    metadata: CandidateMetadata,
    origin: StationReleaseOrigin,
    fallback_reason: Option<StationFallbackReason>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum StationUpdateErrorCode {
    OriginsUnavailable,
    OriginMismatch,
    IntegrityFailed,
    PolicyDenied,
    CheckSuperseded,
    CandidateInvalid,
    CandidateExpired,
    InstallationFailed,
    Internal,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StationUpdateError {
    code: StationUpdateErrorCode,
    retryable: bool,
}

impl StationUpdateError {
    fn origins_unavailable() -> Self {
        Self {
            code: StationUpdateErrorCode::OriginsUnavailable,
            retryable: true,
        }
    }

    fn origin_mismatch() -> Self {
        Self {
            code: StationUpdateErrorCode::OriginMismatch,
            retryable: false,
        }
    }

    fn integrity_failed() -> Self {
        Self {
            code: StationUpdateErrorCode::IntegrityFailed,
            retryable: false,
        }
    }

    fn policy_denied() -> Self {
        Self {
            code: StationUpdateErrorCode::PolicyDenied,
            retryable: false,
        }
    }

    fn check_superseded() -> Self {
        Self {
            code: StationUpdateErrorCode::CheckSuperseded,
            retryable: false,
        }
    }

    fn candidate_invalid() -> Self {
        Self {
            code: StationUpdateErrorCode::CandidateInvalid,
            retryable: false,
        }
    }

    fn candidate_expired() -> Self {
        Self {
            code: StationUpdateErrorCode::CandidateExpired,
            retryable: false,
        }
    }

    fn installation_failed() -> Self {
        Self {
            code: StationUpdateErrorCode::InstallationFailed,
            retryable: false,
        }
    }

    fn internal() -> Self {
        Self {
            code: StationUpdateErrorCode::Internal,
            retryable: false,
        }
    }
}

impl fmt::Display for StationUpdateError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("station update request failed")
    }
}

impl std::error::Error for StationUpdateError {}

fn terminal_failure(error: DiscoveryFailure) -> StationUpdateError {
    match error {
        DiscoveryFailure::Availability(_detail) | DiscoveryFailure::MetadataInvalid(_detail) => {
            StationUpdateError::origins_unavailable()
        }
        DiscoveryFailure::Integrity(_detail) | DiscoveryFailure::SecurityPolicy(_detail) => {
            StationUpdateError::policy_denied()
        }
    }
}

fn fallback_reason(error: DiscoveryFailure) -> Result<StationFallbackReason, StationUpdateError> {
    match error {
        DiscoveryFailure::Availability(_detail) => Ok(StationFallbackReason::PrimaryUnavailable),
        DiscoveryFailure::MetadataInvalid(_detail) => {
            Ok(StationFallbackReason::PrimaryMetadataInvalid)
        }
        DiscoveryFailure::Integrity(_detail) | DiscoveryFailure::SecurityPolicy(_detail) => {
            Err(StationUpdateError::policy_denied())
        }
    }
}

fn validate_candidate<C: DiscoveryCandidate>(
    candidate: C,
    channel: StationReleaseChannel,
    origin: StationReleaseOrigin,
    current_version: &str,
    now_unix: i64,
    fallback_reason: Option<StationFallbackReason>,
) -> Result<DiscoveredCandidate<C>, StationUpdateError> {
    let metadata = candidate.metadata().clone();
    let current = semver::Version::parse(current_version)
        .map_err(|_error| StationUpdateError::policy_denied())?;
    let version = semver::Version::parse(&metadata.version)
        .map_err(|_error| StationUpdateError::policy_denied())?;

    if metadata.current_version != current_version
        || !channel.accepts_version(&current)
        || !channel.accepts_version(&version)
        || version <= current
        || metadata.target != WINDOWS_TARGET
        || metadata.published_at.is_empty()
        || metadata.published_at.len() > 64
        || metadata.published_unix > now_unix.saturating_add(MAX_CLOCK_SKEW_SECONDS)
        || metadata.signature.is_empty()
        || metadata.signature.len() > 4096
        || metadata.download_url != channel.expected_download_url(origin, &metadata.version)
    {
        return Err(StationUpdateError::policy_denied());
    }

    Ok(DiscoveredCandidate {
        candidate,
        metadata,
        origin,
        fallback_reason,
    })
}

pub(crate) async fn discover_update<T: DiscoveryTransport>(
    transport: &T,
    channel: StationReleaseChannel,
    current_version: &str,
    now_unix: i64,
) -> Result<Option<DiscoveredCandidate<T::Candidate>>, StationUpdateError> {
    let [(primary_endpoint, primary_origin), (fallback_endpoint, fallback_origin)] =
        channel.endpoints();

    let reason = match transport.check(primary_origin, primary_endpoint).await {
        Ok(Some(candidate)) => {
            return validate_candidate(
                candidate,
                channel,
                primary_origin,
                current_version,
                now_unix,
                None,
            )
            .map(Some)
        }
        Ok(None) => return Ok(None),
        Err(error) => fallback_reason(error)?,
    };

    match transport.check(fallback_origin, fallback_endpoint).await {
        Ok(Some(candidate)) => validate_candidate(
            candidate,
            channel,
            fallback_origin,
            current_version,
            now_unix,
            Some(reason),
        )
        .map(Some),
        Ok(None) => Ok(None),
        Err(error) => Err(terminal_failure(error)),
    }
}

struct StoredCandidate<C> {
    id: String,
    candidate: C,
    checked_at: Instant,
}

struct CandidateState<C> {
    generation: u64,
    candidate: Option<StoredCandidate<C>>,
}

pub(crate) struct CandidateSlot<C> {
    state: Mutex<CandidateState<C>>,
}

impl<C> Default for CandidateSlot<C> {
    fn default() -> Self {
        Self {
            state: Mutex::new(CandidateState {
                generation: 0,
                candidate: None,
            }),
        }
    }
}

impl<C> CandidateSlot<C> {
    fn begin_check(&self) -> Result<u64, StationUpdateError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_error| StationUpdateError::internal())?;
        state.candidate.take();
        state.generation = state
            .generation
            .checked_add(1)
            .ok_or_else(StationUpdateError::internal)?;
        Ok(state.generation)
    }

    fn ensure_current(&self, generation: u64) -> Result<(), StationUpdateError> {
        let state = self
            .state
            .lock()
            .map_err(|_error| StationUpdateError::internal())?;
        if state.generation != generation {
            return Err(StationUpdateError::check_superseded());
        }
        Ok(())
    }

    fn replace(
        &self,
        generation: u64,
        id: String,
        candidate: C,
        checked_at: Instant,
    ) -> Result<(), StationUpdateError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_error| StationUpdateError::internal())?;
        if state.generation != generation {
            return Err(StationUpdateError::check_superseded());
        }
        state.candidate = Some(StoredCandidate {
            id,
            candidate,
            checked_at,
        });
        Ok(())
    }

    fn take(&self, id: &str, now: Instant) -> Result<C, StationUpdateError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_error| StationUpdateError::internal())?;
        let stored = state
            .candidate
            .as_ref()
            .ok_or_else(StationUpdateError::candidate_invalid)?;

        if now.saturating_duration_since(stored.checked_at) > CANDIDATE_TTL {
            state.candidate.take();
            return Err(StationUpdateError::candidate_expired());
        }
        if id.len() > 128 || stored.id != id {
            return Err(StationUpdateError::candidate_invalid());
        }

        Ok(state
            .candidate
            .take()
            .ok_or_else(StationUpdateError::candidate_invalid)?
            .candidate)
    }
}

struct PluginCandidate {
    update: Update,
    metadata: CandidateMetadata,
}

impl PluginCandidate {
    fn from_update(update: Update) -> Self {
        let published_at = update
            .raw_json
            .get("pub_date")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let published_unix = update
            .date
            .map(|date| date.unix_timestamp())
            .unwrap_or(i64::MAX);
        let metadata = CandidateMetadata {
            current_version: update.current_version.clone(),
            version: update.version.clone(),
            target: update.target.clone(),
            published_at,
            published_unix,
            signature: update.signature.clone(),
            download_url: update.download_url.as_str().to_owned(),
        };
        Self { update, metadata }
    }
}

impl DiscoveryCandidate for PluginCandidate {
    fn metadata(&self) -> &CandidateMetadata {
        &self.metadata
    }
}

struct PluginTransport<'a, R: Runtime> {
    app: &'a AppHandle<R>,
}

impl<R: Runtime> DiscoveryTransport for PluginTransport<'_, R> {
    type Candidate = PluginCandidate;

    fn check(
        &self,
        _origin: StationReleaseOrigin,
        endpoint: &'static str,
    ) -> DiscoveryFuture<'_, Self::Candidate> {
        Box::pin(async move {
            let endpoint = Url::parse(endpoint)
                .map_err(|error| DiscoveryFailure::SecurityPolicy(error.to_string()))?;
            let updater = self
                .app
                .updater_builder()
                .endpoints(vec![endpoint])
                .map_err(classify_plugin_error)?
                .target(WINDOWS_TARGET)
                .timeout(UPDATE_CHECK_TIMEOUT)
                .version_comparator(|current, release| release.version != current)
                .build()
                .map_err(classify_plugin_error)?;
            updater
                .check()
                .await
                .map(|candidate| candidate.map(PluginCandidate::from_update))
                .map_err(classify_plugin_error)
        })
    }
}

fn has_io_source(error: &(dyn std::error::Error + 'static)) -> bool {
    let mut source = Some(error);
    while let Some(error) = source {
        if error.downcast_ref::<io::Error>().is_some() {
            return true;
        }
        source = error.source();
    }
    false
}

fn classify_plugin_error(error: tauri_plugin_updater::Error) -> DiscoveryFailure {
    match error {
        tauri_plugin_updater::Error::Reqwest(source)
            if source.is_timeout()
                || source.is_connect()
                || source.is_request()
                || source.is_body()
                || source.is_status()
                || has_io_source(&source) =>
        {
            DiscoveryFailure::Availability(source.to_string())
        }
        tauri_plugin_updater::Error::Reqwest(source) if source.is_decode() => {
            DiscoveryFailure::MetadataInvalid(source.to_string())
        }
        tauri_plugin_updater::Error::Reqwest(source) => {
            DiscoveryFailure::SecurityPolicy(source.to_string())
        }
        tauri_plugin_updater::Error::Serialization(source) => {
            DiscoveryFailure::MetadataInvalid(source.to_string())
        }
        tauri_plugin_updater::Error::ReleaseNotFound => {
            DiscoveryFailure::Availability("release metadata unavailable".into())
        }
        tauri_plugin_updater::Error::Minisign(source) => {
            DiscoveryFailure::Integrity(source.to_string())
        }
        tauri_plugin_updater::Error::Base64(source) => {
            DiscoveryFailure::Integrity(source.to_string())
        }
        tauri_plugin_updater::Error::SignatureUtf8(source) => DiscoveryFailure::Integrity(source),
        source => DiscoveryFailure::SecurityPolicy(source.to_string()),
    }
}

#[derive(Debug)]
pub(crate) enum PackageDownloadFailure {
    Plugin {
        source: tauri_plugin_updater::Error,
        before_complete: bool,
    },
    PackageTooLarge,
    LengthMismatch,
    Cancelled,
    Local,
}

pub(crate) struct PackageBytes(Zeroizing<Vec<u8>>);

impl AsRef<[u8]> for PackageBytes {
    fn as_ref(&self) -> &[u8] {
        self.0.as_slice()
    }
}

pub(crate) struct PackageAccumulator {
    bytes: Zeroizing<Vec<u8>>,
    limit: usize,
}

impl PackageAccumulator {
    fn with_limit(limit: usize) -> Self {
        Self {
            bytes: Zeroizing::new(Vec::new()),
            limit,
        }
    }

    fn extend(&mut self, chunk: &[u8]) -> Result<(), PackageDownloadFailure> {
        let next_length = self
            .bytes
            .len()
            .checked_add(chunk.len())
            .ok_or(PackageDownloadFailure::PackageTooLarge)?;
        if next_length > self.limit {
            return Err(PackageDownloadFailure::PackageTooLarge);
        }
        self.bytes
            .try_reserve_exact(chunk.len())
            .map_err(|_error| PackageDownloadFailure::Local)?;
        self.bytes.extend_from_slice(chunk);
        Ok(())
    }

    fn len(&self) -> usize {
        self.bytes.len()
    }

    fn into_bytes(self) -> PackageBytes {
        PackageBytes(self.bytes)
    }
}

pub(crate) trait PackageProgress: Send {
    fn started(&mut self, content_length: Option<u64>) -> Result<(), PackageDownloadFailure>;

    fn advanced(&mut self, attempt_bytes: usize) -> Result<(), PackageDownloadFailure>;
}

pub(crate) trait ProgressSink: Send {
    fn send(&mut self, event: StationUpdateProgress) -> Result<(), PackageDownloadFailure>;
}

struct MonotonicProgress<'a, S> {
    sink: &'a mut S,
    started: bool,
    attempt_started: bool,
    attempt_bytes: usize,
    reported_bytes: usize,
}

impl<'a, S: ProgressSink> MonotonicProgress<'a, S> {
    fn new(sink: &'a mut S) -> Self {
        Self {
            sink,
            started: false,
            attempt_started: false,
            attempt_bytes: 0,
            reported_bytes: 0,
        }
    }

    fn finished(&mut self) -> Result<(), PackageDownloadFailure> {
        if !self.started {
            return Err(PackageDownloadFailure::Local);
        }
        self.sink.send(StationUpdateProgress::Finished)
    }
}

impl<S: ProgressSink> PackageProgress for MonotonicProgress<'_, S> {
    fn started(&mut self, content_length: Option<u64>) -> Result<(), PackageDownloadFailure> {
        self.attempt_started = true;
        self.attempt_bytes = 0;
        if !self.started {
            self.sink
                .send(StationUpdateProgress::Started { content_length })?;
            self.started = true;
        }
        Ok(())
    }

    fn advanced(&mut self, attempt_bytes: usize) -> Result<(), PackageDownloadFailure> {
        if !self.attempt_started || attempt_bytes < self.attempt_bytes {
            return Err(PackageDownloadFailure::Local);
        }
        self.attempt_bytes = attempt_bytes;
        if attempt_bytes > self.reported_bytes {
            let chunk_length = attempt_bytes - self.reported_bytes;
            self.sink
                .send(StationUpdateProgress::Progress { chunk_length })?;
            self.reported_bytes = attempt_bytes;
        }
        Ok(())
    }
}

pub(crate) trait PackageTransport<C>: Sync {
    fn download<'a>(
        &'a self,
        candidate: &'a C,
        progress: &'a mut dyn PackageProgress,
    ) -> Pin<Box<dyn Future<Output = Result<PackageBytes, PackageDownloadFailure>> + Send + 'a>>;

    fn install(&self, candidate: &C, bytes: &[u8]) -> Result<(), tauri_plugin_updater::Error>;
}

struct PluginPackageTransport {
    public_key: String,
}

impl PackageTransport<PluginCandidate> for PluginPackageTransport {
    fn download<'a>(
        &'a self,
        candidate: &'a PluginCandidate,
        progress: &'a mut dyn PackageProgress,
    ) -> Pin<Box<dyn Future<Output = Result<PackageBytes, PackageDownloadFailure>> + Send + 'a>>
    {
        Box::pin(download_plugin_package(
            &candidate.update,
            &self.public_key,
            progress,
        ))
    }

    fn install(
        &self,
        candidate: &PluginCandidate,
        bytes: &[u8],
    ) -> Result<(), tauri_plugin_updater::Error> {
        candidate.update.install(bytes)
    }
}

fn plugin_download_failure(
    source: tauri_plugin_updater::Error,
    before_complete: bool,
) -> PackageDownloadFailure {
    PackageDownloadFailure::Plugin {
        source,
        before_complete,
    }
}

async fn download_plugin_package(
    update: &Update,
    public_key: &str,
    progress: &mut dyn PackageProgress,
) -> Result<PackageBytes, PackageDownloadFailure> {
    let mut headers = update.headers.clone();
    if !headers.contains_key(ACCEPT) {
        headers.insert(ACCEPT, HeaderValue::from_static("application/octet-stream"));
    }

    let mut request = ClientBuilder::new().user_agent(UPDATER_USER_AGENT);
    if let Some(timeout) = update.timeout {
        request = request.timeout(timeout);
    }
    if update.no_proxy {
        request = request.no_proxy();
    } else if let Some(proxy) = &update.proxy {
        let proxy = reqwest::Proxy::all(proxy.as_str()).map_err(|source| {
            plugin_download_failure(tauri_plugin_updater::Error::Reqwest(source), true)
        })?;
        request = request.proxy(proxy);
    }

    let response = request
        .build()
        .map_err(|source| {
            plugin_download_failure(tauri_plugin_updater::Error::Reqwest(source), true)
        })?
        .get(update.download_url.clone())
        .headers(headers)
        .send()
        .await
        .map_err(|source| {
            plugin_download_failure(tauri_plugin_updater::Error::Reqwest(source), true)
        })?;

    if !response.status().is_success() {
        return Err(plugin_download_failure(
            tauri_plugin_updater::Error::Network("package endpoint returned non-success".into()),
            true,
        ));
    }

    let content_length = match response.headers().get(CONTENT_LENGTH) {
        Some(value) => {
            let value = value
                .to_str()
                .ok()
                .and_then(|value| value.parse::<u64>().ok())
                .ok_or(PackageDownloadFailure::LengthMismatch)?;
            if value == 0 || value > MAX_PACKAGE_BYTES as u64 {
                return Err(PackageDownloadFailure::PackageTooLarge);
            }
            Some(value)
        }
        None => None,
    };

    progress.started(content_length)?;
    let mut accumulator = PackageAccumulator::with_limit(MAX_PACKAGE_BYTES);
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(chunk) => chunk,
            Err(source) => {
                let before_complete = content_length
                    .and_then(|length| usize::try_from(length).ok())
                    .is_none_or(|length| accumulator.len() < length);
                return Err(plugin_download_failure(
                    tauri_plugin_updater::Error::Reqwest(source),
                    before_complete,
                ));
            }
        };
        accumulator.extend(&chunk)?;
        progress.advanced(accumulator.len())?;
    }

    if accumulator.len() == 0
        || content_length
            .and_then(|length| usize::try_from(length).ok())
            .is_some_and(|length| length != accumulator.len())
    {
        return Err(PackageDownloadFailure::LengthMismatch);
    }

    let package = accumulator.into_bytes();
    verify_package_signature(package.as_ref(), &update.signature, public_key)
        .map_err(|source| plugin_download_failure(source, false))?;
    Ok(package)
}

fn base64_to_string(value: &str) -> Result<String, tauri_plugin_updater::Error> {
    let decoded = base64::engine::general_purpose::STANDARD.decode(value)?;
    std::str::from_utf8(&decoded)
        .map(str::to_owned)
        .map_err(|_error| tauri_plugin_updater::Error::SignatureUtf8(value.into()))
}

fn verify_package_signature(
    package: &[u8],
    release_signature: &str,
    public_key: &str,
) -> Result<(), tauri_plugin_updater::Error> {
    let decoded_public_key = base64_to_string(public_key)?;
    let public_key = PublicKey::decode(&decoded_public_key)?;
    let decoded_signature = base64_to_string(release_signature)?;
    let signature = Signature::decode(&decoded_signature)?;
    public_key.verify(package, &signature, true)?;
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PackageFailureClass {
    Availability,
    Integrity,
    Policy,
    Terminal,
}

fn classify_package_failure(failure: &PackageDownloadFailure) -> PackageFailureClass {
    match failure {
        PackageDownloadFailure::Plugin {
            source: tauri_plugin_updater::Error::Network(_),
            before_complete: true,
        } => PackageFailureClass::Availability,
        PackageDownloadFailure::Plugin {
            source: tauri_plugin_updater::Error::Reqwest(source),
            before_complete: true,
        } if source.is_timeout()
            || source.is_connect()
            || source.is_request()
            || source.is_body()
            || source.is_status()
            || has_io_source(source) =>
        {
            PackageFailureClass::Availability
        }
        PackageDownloadFailure::Plugin {
            source:
                tauri_plugin_updater::Error::Minisign(_)
                | tauri_plugin_updater::Error::Base64(_)
                | tauri_plugin_updater::Error::SignatureUtf8(_),
            ..
        } => PackageFailureClass::Integrity,
        PackageDownloadFailure::Plugin {
            source: tauri_plugin_updater::Error::InsecureTransportProtocol,
            ..
        } => PackageFailureClass::Policy,
        PackageDownloadFailure::Plugin { .. }
        | PackageDownloadFailure::PackageTooLarge
        | PackageDownloadFailure::LengthMismatch
        | PackageDownloadFailure::Cancelled
        | PackageDownloadFailure::Local => PackageFailureClass::Terminal,
    }
}

fn terminal_package_error(failure: PackageDownloadFailure) -> StationUpdateError {
    match classify_package_failure(&failure) {
        PackageFailureClass::Availability => StationUpdateError::origins_unavailable(),
        PackageFailureClass::Integrity => StationUpdateError::integrity_failed(),
        PackageFailureClass::Policy => StationUpdateError::policy_denied(),
        PackageFailureClass::Terminal => StationUpdateError::installation_failed(),
    }
}

fn recheck_failure(error: DiscoveryFailure) -> StationUpdateError {
    match error {
        DiscoveryFailure::Availability(_detail) => StationUpdateError::origins_unavailable(),
        DiscoveryFailure::MetadataInvalid(_detail) => StationUpdateError::origin_mismatch(),
        DiscoveryFailure::Integrity(_detail) => StationUpdateError::integrity_failed(),
        DiscoveryFailure::SecurityPolicy(_detail) => StationUpdateError::policy_denied(),
    }
}

async fn recheck_exact_candidate<T: DiscoveryTransport>(
    transport: &T,
    channel: StationReleaseChannel,
    origin: StationReleaseOrigin,
    accepted: &CandidateMetadata,
    now_unix: i64,
) -> Result<T::Candidate, StationUpdateError> {
    let candidate = transport
        .check(origin, channel.endpoint(origin))
        .await
        .map_err(recheck_failure)?
        .ok_or_else(StationUpdateError::origin_mismatch)?;
    let candidate = validate_candidate(
        candidate,
        channel,
        origin,
        &accepted.current_version,
        now_unix,
        None,
    )
    .map_err(|_error| StationUpdateError::origin_mismatch())?;
    if !accepted.has_same_signed_target(&candidate.metadata) {
        return Err(StationUpdateError::origin_mismatch());
    }
    Ok(candidate.candidate)
}

const INSTALL_IDLE: u8 = 0;
const INSTALL_PREPARING: u8 = 1;
const INSTALL_STARTED: u8 = 2;

#[derive(Default)]
pub(crate) struct InstallCoordinator {
    phase: AtomicU8,
}

impl InstallCoordinator {
    fn acquire(&self) -> Result<InstallPermit<'_>, StationUpdateError> {
        self.phase
            .compare_exchange(
                INSTALL_IDLE,
                INSTALL_PREPARING,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .map_err(|_phase| StationUpdateError::candidate_invalid())?;
        Ok(InstallPermit { coordinator: self })
    }
}

pub(crate) struct InstallPermit<'a> {
    coordinator: &'a InstallCoordinator,
}

impl InstallPermit<'_> {
    fn mark_started(&mut self) -> Result<(), StationUpdateError> {
        self.coordinator
            .phase
            .compare_exchange(
                INSTALL_PREPARING,
                INSTALL_STARTED,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .map(|_phase| ())
            .map_err(|_phase| StationUpdateError::internal())
    }
}

impl Drop for InstallPermit<'_> {
    fn drop(&mut self) {
        self.coordinator
            .phase
            .store(INSTALL_IDLE, Ordering::Release);
    }
}

pub(crate) async fn execute_candidate_install<T, P, S>(
    accepted: DiscoveredCandidate<T::Candidate>,
    discovery: &T,
    packages: &P,
    channel: StationReleaseChannel,
    now_unix: i64,
    progress: &mut S,
    mut permit: InstallPermit<'_>,
) -> Result<(), StationUpdateError>
where
    T: DiscoveryTransport,
    P: PackageTransport<T::Candidate>,
    S: ProgressSink,
{
    let DiscoveredCandidate {
        candidate: stale_handle,
        metadata,
        origin,
        fallback_reason: _fallback_reason,
    } = accepted;
    drop(stale_handle);

    let selected = recheck_exact_candidate(discovery, channel, origin, &metadata, now_unix).await?;
    let mut monotonic_progress = MonotonicProgress::new(progress);
    let selected_download = packages.download(&selected, &mut monotonic_progress).await;

    let (installer, package) = match selected_download {
        Ok(package) => (selected, package),
        Err(failure) if classify_package_failure(&failure) == PackageFailureClass::Availability => {
            drop(selected);
            let peer_origin = origin.peer();
            let peer =
                recheck_exact_candidate(discovery, channel, peer_origin, &metadata, now_unix)
                    .await?;
            let package = packages
                .download(&peer, &mut monotonic_progress)
                .await
                .map_err(terminal_package_error)?;
            (peer, package)
        }
        Err(failure) => return Err(terminal_package_error(failure)),
    };

    monotonic_progress
        .finished()
        .map_err(terminal_package_error)?;
    permit.mark_started()?;
    packages
        .install(&installer, package.as_ref())
        .map_err(|_error| StationUpdateError::installation_failed())
}

fn compiled_updater_config<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<tauri_plugin_updater::Config, StationUpdateError> {
    let plugin_config = app
        .config()
        .plugins
        .0
        .get("updater")
        .cloned()
        .ok_or_else(StationUpdateError::policy_denied)?;
    let updater_config: tauri_plugin_updater::Config = serde_json::from_value(plugin_config)
        .map_err(|_error| StationUpdateError::policy_denied())?;
    if updater_config.dangerous_insecure_transport_protocol
        || updater_config.dangerous_accept_invalid_certs
        || updater_config.dangerous_accept_invalid_hostnames
        || updater_config.pubkey.is_empty()
        || updater_config.pubkey.len() > 4096
    {
        return Err(StationUpdateError::policy_denied());
    }
    Ok(updater_config)
}

fn channel_from_config(
    updater_config: &tauri_plugin_updater::Config,
) -> Result<StationReleaseChannel, StationUpdateError> {
    let endpoints = updater_config
        .endpoints
        .iter()
        .map(Url::as_str)
        .collect::<Vec<_>>();
    StationReleaseChannel::from_compiled_endpoints(&endpoints)
}

fn compiled_channel<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<StationReleaseChannel, StationUpdateError> {
    channel_from_config(&compiled_updater_config(app)?)
}

fn now_unix() -> Result<i64, StationUpdateError> {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_error| StationUpdateError::internal())?
        .as_secs();
    i64::try_from(seconds).map_err(|_error| StationUpdateError::internal())
}

type StoredPluginCandidate = DiscoveredCandidate<PluginCandidate>;

#[derive(Default)]
pub(crate) struct StationUpdaterState {
    candidates: CandidateSlot<StoredPluginCandidate>,
    installs: InstallCoordinator,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StationUpdate {
    candidate_id: String,
    current_version: String,
    version: String,
    published_at: String,
    selected_origin: StationReleaseOrigin,
    fallback_reason: Option<StationFallbackReason>,
}

struct StartedUpdateCheck<'a> {
    generation: u64,
    channel: StationReleaseChannel,
    current_version: &'a str,
    now_unix: i64,
    candidate_id: String,
    checked_at: Instant,
}

async fn execute_update_check<T: DiscoveryTransport>(
    candidates: &CandidateSlot<DiscoveredCandidate<T::Candidate>>,
    transport: &T,
    check: StartedUpdateCheck<'_>,
) -> Result<Option<StationUpdate>, StationUpdateError> {
    let discovery = discover_update(
        transport,
        check.channel,
        check.current_version,
        check.now_unix,
    )
    .await;
    candidates.ensure_current(check.generation)?;
    let Some(candidate) = discovery? else {
        return Ok(None);
    };

    let update = StationUpdate {
        candidate_id: check.candidate_id.clone(),
        current_version: candidate.metadata.current_version.clone(),
        version: candidate.metadata.version.clone(),
        published_at: candidate.metadata.published_at.clone(),
        selected_origin: candidate.origin,
        fallback_reason: candidate.fallback_reason,
    };
    candidates.replace(
        check.generation,
        check.candidate_id,
        candidate,
        check.checked_at,
    )?;
    Ok(Some(update))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct StationUpdateInstallRequest {
    candidate_id: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "event", content = "data")]
pub(crate) enum StationUpdateProgress {
    #[serde(rename_all = "camelCase")]
    Started {
        content_length: Option<u64>,
    },
    #[serde(rename_all = "camelCase")]
    Progress {
        chunk_length: usize,
    },
    Finished,
}

struct IpcProgress<'a>(&'a Channel<StationUpdateProgress>);

impl ProgressSink for IpcProgress<'_> {
    fn send(&mut self, event: StationUpdateProgress) -> Result<(), PackageDownloadFailure> {
        self.0
            .send(event)
            .map_err(|_error| PackageDownloadFailure::Cancelled)
    }
}

#[tauri::command]
pub(crate) async fn station_update_check(
    app: AppHandle,
    state: State<'_, StationUpdaterState>,
) -> Result<Option<StationUpdate>, StationUpdateError> {
    let generation = state.candidates.begin_check()?;
    let channel = compiled_channel(&app)?;
    let current_version = app.package_info().version.to_string();
    let transport = PluginTransport { app: &app };
    execute_update_check(
        &state.candidates,
        &transport,
        StartedUpdateCheck {
            generation,
            channel,
            current_version: &current_version,
            now_unix: now_unix()?,
            candidate_id: uuid::Uuid::new_v4().to_string(),
            checked_at: Instant::now(),
        },
    )
    .await
}

#[tauri::command]
pub(crate) async fn station_update_download_and_install(
    app: AppHandle,
    state: State<'_, StationUpdaterState>,
    request: StationUpdateInstallRequest,
    progress: Channel<StationUpdateProgress>,
) -> Result<(), StationUpdateError> {
    let updater_config = compiled_updater_config(&app)?;
    let channel = channel_from_config(&updater_config)?;
    let permit = state.installs.acquire()?;
    let candidate = state
        .candidates
        .take(&request.candidate_id, Instant::now())?;
    let discovery = PluginTransport { app: &app };
    let packages = PluginPackageTransport {
        public_key: updater_config.pubkey,
    };
    let mut progress = IpcProgress(&progress);
    execute_candidate_install(
        candidate,
        &discovery,
        &packages,
        channel,
        now_unix()?,
        &mut progress,
        permit,
    )
    .await
}

#[cfg(test)]
mod tests {
    use std::{
        future::Future,
        io,
        pin::Pin,
        sync::{
            atomic::{AtomicBool, Ordering},
            Arc, Barrier, Mutex,
        },
        task::{Context, Poll},
        time::{Duration, Instant},
    };

    use base64::Engine as _;
    use futures_core::Stream;

    use super::{
        classify_plugin_error, discover_update, execute_candidate_install, execute_update_check,
        verify_package_signature, CandidateMetadata, CandidateSlot, DiscoveredCandidate,
        DiscoveryCandidate, DiscoveryFailure, DiscoveryTransport, InstallCoordinator,
        PackageAccumulator, PackageBytes, PackageDownloadFailure, PackageProgress,
        PackageTransport, ProgressSink, StartedUpdateCheck, StationFallbackReason,
        StationReleaseChannel, StationReleaseOrigin, StationUpdateErrorCode, StationUpdateProgress,
        CANDIDATE_TTL,
    };

    const CURRENT_VERSION: &str = "0.2.0-beta.6";
    const UPDATE_VERSION: &str = "0.2.0-beta.7";
    const PUBLISHED_AT: &str = "2026-08-24T10:00:00Z";
    const PUBLISHED_UNIX: i64 = 1_787_565_600;
    const NOW_UNIX: i64 = PUBLISHED_UNIX + 60;
    const BETA_YANDEX_ENDPOINT: &str = "https://releases.markiro.app/station/beta/latest.json";
    const BETA_GITHUB_ENDPOINT: &str =
        "https://github.com/thevladbog/markiro/releases/download/station-beta-channel/latest.json";
    const MINISIGN_PUBLIC_KEY: &str = "untrusted comment: minisign public key E7620F1842B4E81F\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";
    const MINISIGN_SIGNATURE: &str = "untrusted comment: signature from minisign secret key\nRWQf6LRCGA9i59SLOFxz6NxvASXDJeRtuZykwQepbDEGt87ig1BNpWaVWuNrm73YiIiJbq71Wi+dP9eKL8OC351vwIasSSbXxwA=\ntrusted comment: timestamp:1555779966\tfile:test\nQtKMXWyYcwdpZAlPF7tE2ENJkRd1ujvKjlj1m9RtHTBnZPa5WKU5uWRs5GoP5M/VqE81QFuMKI5k/SfNQUaOAA==";

    #[derive(Clone, Debug, PartialEq, Eq)]
    struct FakeCandidate(CandidateMetadata);

    impl DiscoveryCandidate for FakeCandidate {
        fn metadata(&self) -> &CandidateMetadata {
            &self.0
        }
    }

    #[derive(Debug)]
    enum FakeOutcome {
        Update(FakeCandidate),
        NoUpdate,
        Failure(DiscoveryFailure),
    }

    struct FakeTransport {
        outcomes: Mutex<Vec<(StationReleaseOrigin, FakeOutcome)>>,
        calls: Arc<Mutex<Vec<(StationReleaseOrigin, &'static str)>>>,
    }

    impl FakeTransport {
        fn new(outcomes: Vec<(StationReleaseOrigin, FakeOutcome)>) -> Self {
            Self {
                outcomes: Mutex::new(outcomes.into_iter().rev().collect()),
                calls: Arc::new(Mutex::new(Vec::new())),
            }
        }

        fn calls(&self) -> Vec<(StationReleaseOrigin, &'static str)> {
            self.calls.lock().expect("calls lock").clone()
        }
    }

    impl DiscoveryTransport for FakeTransport {
        type Candidate = FakeCandidate;

        fn check(
            &self,
            origin: StationReleaseOrigin,
            endpoint: &'static str,
        ) -> Pin<
            Box<dyn Future<Output = Result<Option<Self::Candidate>, DiscoveryFailure>> + Send + '_>,
        > {
            Box::pin(async move {
                self.calls
                    .lock()
                    .expect("calls lock")
                    .push((origin, endpoint));
                let (expected_origin, outcome) = self
                    .outcomes
                    .lock()
                    .expect("outcomes lock")
                    .pop()
                    .expect("unexpected transport call");
                assert_eq!(origin, expected_origin);
                match outcome {
                    FakeOutcome::Update(candidate) => Ok(Some(candidate)),
                    FakeOutcome::NoUpdate => Ok(None),
                    FakeOutcome::Failure(error) => Err(error),
                }
            })
        }
    }

    struct ScheduledCheck {
        origin: StationReleaseOrigin,
        endpoint: &'static str,
        started: tauri::async_runtime::Sender<()>,
        response: tauri::async_runtime::Receiver<FakeOutcome>,
    }

    struct ControlledTransport {
        checks: Mutex<Vec<ScheduledCheck>>,
    }

    impl ControlledTransport {
        fn new(checks: Vec<ScheduledCheck>) -> Self {
            Self {
                checks: Mutex::new(checks.into_iter().rev().collect()),
            }
        }
    }

    impl DiscoveryTransport for ControlledTransport {
        type Candidate = FakeCandidate;

        fn check(
            &self,
            origin: StationReleaseOrigin,
            endpoint: &'static str,
        ) -> Pin<
            Box<dyn Future<Output = Result<Option<Self::Candidate>, DiscoveryFailure>> + Send + '_>,
        > {
            let mut check = self
                .checks
                .lock()
                .expect("controlled checks lock")
                .pop()
                .expect("unexpected controlled transport call");
            assert_eq!(origin, check.origin);
            assert_eq!(endpoint, check.endpoint);

            Box::pin(async move {
                check.started.send(()).await.expect("signal check start");
                match check.response.recv().await.expect("controlled response") {
                    FakeOutcome::Update(candidate) => Ok(Some(candidate)),
                    FakeOutcome::NoUpdate => Ok(None),
                    FakeOutcome::Failure(error) => Err(error),
                }
            })
        }
    }

    struct OneErrorStream(Option<io::Error>);

    impl Stream for OneErrorStream {
        type Item = Result<Vec<u8>, io::Error>;

        fn poll_next(
            mut self: Pin<&mut Self>,
            _context: &mut Context<'_>,
        ) -> Poll<Option<Self::Item>> {
            Poll::Ready(self.0.take().map(Err))
        }
    }

    struct FakeDownload {
        started: Option<Option<u64>>,
        cumulative_bytes: Vec<usize>,
        result: Result<Vec<u8>, PackageDownloadFailure>,
        cleaned: Option<Arc<AtomicBool>>,
    }

    impl FakeDownload {
        fn success(content_length: u64, cumulative_bytes: Vec<usize>, bytes: &[u8]) -> Self {
            Self {
                started: Some(Some(content_length)),
                cumulative_bytes,
                result: Ok(bytes.to_vec()),
                cleaned: None,
            }
        }

        fn failure(
            started: Option<Option<u64>>,
            cumulative_bytes: Vec<usize>,
            failure: PackageDownloadFailure,
        ) -> Self {
            Self {
                started,
                cumulative_bytes,
                result: Err(failure),
                cleaned: None,
            }
        }
    }

    struct CleanupOnDrop(Option<Arc<AtomicBool>>);

    impl Drop for CleanupOnDrop {
        fn drop(&mut self) {
            if let Some(cleaned) = self.0.take() {
                cleaned.store(true, Ordering::SeqCst);
            }
        }
    }

    struct FakePackageTransport {
        downloads: Mutex<Vec<FakeDownload>>,
        download_calls: Arc<Mutex<Vec<String>>>,
        install_calls: Arc<Mutex<Vec<String>>>,
        install_error: Mutex<Option<tauri_plugin_updater::Error>>,
        install_phase: Mutex<Option<Arc<InstallCoordinator>>>,
    }

    impl FakePackageTransport {
        fn new(downloads: Vec<FakeDownload>) -> Self {
            Self {
                downloads: Mutex::new(downloads.into_iter().rev().collect()),
                download_calls: Arc::new(Mutex::new(Vec::new())),
                install_calls: Arc::new(Mutex::new(Vec::new())),
                install_error: Mutex::new(None),
                install_phase: Mutex::new(None),
            }
        }

        fn with_install_error(self, error: tauri_plugin_updater::Error) -> Self {
            self.install_error
                .lock()
                .expect("install error lock")
                .replace(error);
            self
        }

        fn observe_install_phase(&self, installs: Arc<InstallCoordinator>) {
            self.install_phase
                .lock()
                .expect("install phase lock")
                .replace(installs);
        }

        fn download_calls(&self) -> Vec<String> {
            self.download_calls
                .lock()
                .expect("download calls lock")
                .clone()
        }

        fn install_calls(&self) -> Vec<String> {
            self.install_calls
                .lock()
                .expect("install calls lock")
                .clone()
        }
    }

    impl PackageTransport<FakeCandidate> for FakePackageTransport {
        fn download<'a>(
            &'a self,
            candidate: &'a FakeCandidate,
            progress: &'a mut dyn PackageProgress,
        ) -> Pin<Box<dyn Future<Output = Result<PackageBytes, PackageDownloadFailure>> + Send + 'a>>
        {
            Box::pin(async move {
                self.download_calls
                    .lock()
                    .expect("download calls lock")
                    .push(candidate.0.download_url.clone());
                let download = self
                    .downloads
                    .lock()
                    .expect("downloads lock")
                    .pop()
                    .expect("unexpected package download");
                let _cleanup = CleanupOnDrop(download.cleaned);
                if let Some(content_length) = download.started {
                    progress.started(content_length)?;
                }
                for cumulative_bytes in download.cumulative_bytes {
                    progress.advanced(cumulative_bytes)?;
                }
                download.result.and_then(|bytes| {
                    let mut accumulator = PackageAccumulator::with_limit(bytes.len());
                    accumulator.extend(&bytes)?;
                    Ok(accumulator.into_bytes())
                })
            })
        }

        fn install(
            &self,
            candidate: &FakeCandidate,
            _bytes: &[u8],
        ) -> Result<(), tauri_plugin_updater::Error> {
            let install_phase = self
                .install_phase
                .lock()
                .expect("install phase lock")
                .clone()
                .expect("install coordinator was registered");
            assert_eq!(
                install_phase.phase.load(Ordering::Acquire),
                super::INSTALL_STARTED,
                "installer launched before install_started"
            );
            self.install_calls
                .lock()
                .expect("install calls lock")
                .push(candidate.0.download_url.clone());
            if let Some(error) = self
                .install_error
                .lock()
                .expect("install error lock")
                .take()
            {
                return Err(error);
            }
            Ok(())
        }
    }

    #[derive(Default)]
    struct RecordingProgress {
        events: Vec<StationUpdateProgress>,
        fail_after: Option<usize>,
    }

    impl ProgressSink for RecordingProgress {
        fn send(&mut self, event: StationUpdateProgress) -> Result<(), PackageDownloadFailure> {
            if self.fail_after == Some(self.events.len()) {
                return Err(PackageDownloadFailure::Cancelled);
            }
            self.events.push(event);
            Ok(())
        }
    }

    fn candidate(origin: StationReleaseOrigin) -> FakeCandidate {
        let download_url = match origin {
            StationReleaseOrigin::Yandex => format!(
                "https://releases.markiro.app/station/beta/releases/{UPDATE_VERSION}/markiro-station-{UPDATE_VERSION}-windows-x86_64.nsis.zip"
            ),
            StationReleaseOrigin::Github => format!(
                "https://github.com/thevladbog/markiro/releases/download/station-v{UPDATE_VERSION}/markiro-station-{UPDATE_VERSION}-windows-x86_64.nsis.zip"
            ),
        };
        FakeCandidate(CandidateMetadata {
            current_version: CURRENT_VERSION.into(),
            version: UPDATE_VERSION.into(),
            target: "windows-x86_64".into(),
            published_at: PUBLISHED_AT.into(),
            published_unix: PUBLISHED_UNIX,
            signature: "trusted-fixture-signature".into(),
            download_url,
        })
    }

    fn accepted_candidate(origin: StationReleaseOrigin) -> DiscoveredCandidate<FakeCandidate> {
        let candidate = candidate(origin);
        DiscoveredCandidate {
            metadata: candidate.0.clone(),
            candidate,
            origin,
            fallback_reason: None,
        }
    }

    fn encoded_minisign_fixture() -> (String, String) {
        (
            base64::engine::general_purpose::STANDARD.encode(MINISIGN_PUBLIC_KEY),
            base64::engine::general_purpose::STANDARD.encode(MINISIGN_SIGNATURE),
        )
    }

    fn run_candidate_install(
        accepted: DiscoveredCandidate<FakeCandidate>,
        discovery: &FakeTransport,
        packages: &FakePackageTransport,
        progress: &mut RecordingProgress,
    ) -> Result<(), super::StationUpdateError> {
        let installs = Arc::new(InstallCoordinator::default());
        packages.observe_install_phase(Arc::clone(&installs));
        let permit = installs.acquire()?;
        tauri::async_runtime::block_on(execute_candidate_install(
            accepted,
            discovery,
            packages,
            StationReleaseChannel::Beta,
            NOW_UNIX,
            progress,
            permit,
        ))
    }

    fn run(
        transport: &FakeTransport,
    ) -> Result<Option<super::DiscoveredCandidate<FakeCandidate>>, super::StationUpdateError> {
        tauri::async_runtime::block_on(discover_update(
            transport,
            StationReleaseChannel::Beta,
            CURRENT_VERSION,
            NOW_UNIX,
        ))
    }

    fn assert_plugin_error_falls_back(
        error: tauri_plugin_updater::Error,
        expected_reason: StationFallbackReason,
    ) {
        let transport = FakeTransport::new(vec![
            (
                StationReleaseOrigin::Yandex,
                FakeOutcome::Failure(classify_plugin_error(error)),
            ),
            (
                StationReleaseOrigin::Github,
                FakeOutcome::Update(candidate(StationReleaseOrigin::Github)),
            ),
        ]);

        let discovered = run(&transport)
            .expect("plugin failure is fallback eligible")
            .expect("GitHub fallback candidate");
        assert_eq!(discovered.origin, StationReleaseOrigin::Github);
        assert_eq!(discovered.fallback_reason, Some(expected_reason));
        assert_eq!(
            transport.calls(),
            vec![
                (StationReleaseOrigin::Yandex, BETA_YANDEX_ENDPOINT),
                (StationReleaseOrigin::Github, BETA_GITHUB_ENDPOINT),
            ]
        );
    }

    fn assert_plugin_error_is_terminal(error: tauri_plugin_updater::Error) {
        let transport = FakeTransport::new(vec![
            (
                StationReleaseOrigin::Yandex,
                FakeOutcome::Failure(classify_plugin_error(error)),
            ),
            (
                StationReleaseOrigin::Github,
                FakeOutcome::Update(candidate(StationReleaseOrigin::Github)),
            ),
        ]);

        let failure = run(&transport).expect_err("plugin failure is terminal");
        assert_eq!(failure.code, StationUpdateErrorCode::PolicyDenied);
        assert!(!failure.retryable);
        assert_eq!(
            transport.calls(),
            vec![(StationReleaseOrigin::Yandex, BETA_YANDEX_ENDPOINT)]
        );
    }

    #[test]
    fn yandex_update_is_authoritative_without_github_request() {
        let transport = FakeTransport::new(vec![(
            StationReleaseOrigin::Yandex,
            FakeOutcome::Update(candidate(StationReleaseOrigin::Yandex)),
        )]);

        let discovered = run(&transport)
            .expect("discovery succeeds")
            .expect("update");

        assert_eq!(discovered.origin, StationReleaseOrigin::Yandex);
        assert_eq!(discovered.fallback_reason, None);
        assert_eq!(
            transport.calls(),
            vec![(StationReleaseOrigin::Yandex, BETA_YANDEX_ENDPOINT)]
        );
    }

    #[test]
    fn yandex_no_update_is_authoritative_without_github_request() {
        let transport =
            FakeTransport::new(vec![(StationReleaseOrigin::Yandex, FakeOutcome::NoUpdate)]);

        assert!(run(&transport).expect("discovery succeeds").is_none());
        assert_eq!(
            transport.calls(),
            vec![(StationReleaseOrigin::Yandex, BETA_YANDEX_ENDPOINT)]
        );
    }

    #[test]
    fn availability_failure_falls_back_to_github() {
        let transport = FakeTransport::new(vec![
            (
                StationReleaseOrigin::Yandex,
                FakeOutcome::Failure(DiscoveryFailure::Availability("timeout".into())),
            ),
            (
                StationReleaseOrigin::Github,
                FakeOutcome::Update(candidate(StationReleaseOrigin::Github)),
            ),
        ]);

        let discovered = run(&transport)
            .expect("discovery succeeds")
            .expect("update");

        assert_eq!(discovered.origin, StationReleaseOrigin::Github);
        assert_eq!(
            discovered.fallback_reason,
            Some(StationFallbackReason::PrimaryUnavailable)
        );
        assert_eq!(
            transport.calls(),
            vec![
                (StationReleaseOrigin::Yandex, BETA_YANDEX_ENDPOINT),
                (StationReleaseOrigin::Github, BETA_GITHUB_ENDPOINT),
            ]
        );
    }

    #[test]
    fn malformed_primary_metadata_falls_back_to_github() {
        let transport = FakeTransport::new(vec![
            (
                StationReleaseOrigin::Yandex,
                FakeOutcome::Failure(DiscoveryFailure::MetadataInvalid("invalid json".into())),
            ),
            (
                StationReleaseOrigin::Github,
                FakeOutcome::Update(candidate(StationReleaseOrigin::Github)),
            ),
        ]);

        let discovered = run(&transport)
            .expect("discovery succeeds")
            .expect("update");

        assert_eq!(discovered.origin, StationReleaseOrigin::Github);
        assert_eq!(
            discovered.fallback_reason,
            Some(StationFallbackReason::PrimaryMetadataInvalid)
        );
        assert_eq!(
            transport.calls(),
            vec![
                (StationReleaseOrigin::Yandex, BETA_YANDEX_ENDPOINT),
                (StationReleaseOrigin::Github, BETA_GITHUB_ENDPOINT),
            ]
        );
    }

    #[test]
    fn timeout_is_an_availability_fallback_class() {
        let transport = FakeTransport::new(vec![
            (
                StationReleaseOrigin::Yandex,
                FakeOutcome::Failure(DiscoveryFailure::Availability("request timed out".into())),
            ),
            (StationReleaseOrigin::Github, FakeOutcome::NoUpdate),
        ]);

        assert!(run(&transport).expect("fallback succeeds").is_none());
        assert_eq!(
            transport.calls(),
            vec![
                (StationReleaseOrigin::Yandex, BETA_YANDEX_ENDPOINT),
                (StationReleaseOrigin::Github, BETA_GITHUB_ENDPOINT),
            ]
        );
    }

    #[test]
    fn pinned_plugin_error_variants_map_to_closed_fallback_classes() {
        let malformed_json = tauri::async_runtime::block_on(async {
            let response = reqwest::Response::from(
                http::Response::builder()
                    .status(200)
                    .body("not-json")
                    .expect("malformed JSON response fixture"),
            );
            response
                .json::<serde_json::Value>()
                .await
                .expect_err("JSON decode must fail")
        });
        assert!(malformed_json.is_decode());
        assert_plugin_error_falls_back(
            tauri_plugin_updater::Error::Reqwest(malformed_json),
            StationFallbackReason::PrimaryMetadataInvalid,
        );

        let invalid_manifest =
            serde_json::from_value::<tauri_plugin_updater::RemoteRelease>(serde_json::json!({
                "version": "not-semver",
                "platforms": {}
            }))
            .expect_err("invalid pinned manifest shape");
        assert_plugin_error_falls_back(
            tauri_plugin_updater::Error::Serialization(invalid_manifest),
            StationFallbackReason::PrimaryMetadataInvalid,
        );

        for kind in [io::ErrorKind::TimedOut, io::ErrorKind::ConnectionReset] {
            let request_error = tauri::async_runtime::block_on(async {
                let body = reqwest::Body::wrap_stream(OneErrorStream(Some(io::Error::new(
                    kind,
                    "controlled body failure",
                ))));
                let response = reqwest::Response::from(
                    http::Response::builder()
                        .status(200)
                        .body(body)
                        .expect("transport response fixture"),
                );
                response
                    .json::<serde_json::Value>()
                    .await
                    .expect_err("body transport failure")
            });
            assert!(request_error.is_decode());
            assert_eq!(request_error.is_timeout(), kind == io::ErrorKind::TimedOut);
            assert_plugin_error_falls_back(
                tauri_plugin_updater::Error::Reqwest(request_error),
                StationFallbackReason::PrimaryUnavailable,
            );
        }

        assert_plugin_error_falls_back(
            tauri_plugin_updater::Error::ReleaseNotFound,
            StationFallbackReason::PrimaryUnavailable,
        );

        let http_status = reqwest::Response::from(
            http::Response::builder()
                .status(503)
                .body("")
                .expect("HTTP status fixture"),
        )
        .error_for_status()
        .expect_err("HTTP 503 must fail");
        assert!(http_status.is_status());
        assert_plugin_error_falls_back(
            tauri_plugin_updater::Error::Reqwest(http_status),
            StationFallbackReason::PrimaryUnavailable,
        );

        let invalid_signature = base64::engine::general_purpose::STANDARD
            .decode("not!base64")
            .expect_err("invalid signature fixture");
        assert_plugin_error_is_terminal(tauri_plugin_updater::Error::Base64(invalid_signature));

        for error in [
            tauri_plugin_updater::Error::InsecureTransportProtocol,
            tauri_plugin_updater::Error::TargetNotFound("windows-x86_64".into()),
        ] {
            assert_plugin_error_is_terminal(error);
        }
    }

    #[test]
    fn both_origins_unavailable_returns_retryable_sanitized_error() {
        let transport = FakeTransport::new(vec![
            (
                StationReleaseOrigin::Yandex,
                FakeOutcome::Failure(DiscoveryFailure::Availability(
                    "https://releases.markiro.app/?token=secret".into(),
                )),
            ),
            (
                StationReleaseOrigin::Github,
                FakeOutcome::Failure(DiscoveryFailure::Availability(
                    "https://github.com/private/path".into(),
                )),
            ),
        ]);

        let error = run(&transport).expect_err("both origins fail");
        let serialized = serde_json::to_string(&error).expect("serialize error");

        assert_eq!(error.code, StationUpdateErrorCode::OriginsUnavailable);
        assert!(error.retryable);
        assert_eq!(
            serialized,
            r#"{"code":"origins-unavailable","retryable":true}"#
        );
        assert!(!serialized.contains("http"));
        assert!(!serialized.contains("secret"));
    }

    #[test]
    fn integrity_or_security_failure_never_falls_back() {
        for failure in [
            DiscoveryFailure::Integrity("bad signature from https://primary".into()),
            DiscoveryFailure::SecurityPolicy("insecure endpoint https://primary".into()),
        ] {
            let transport = FakeTransport::new(vec![
                (StationReleaseOrigin::Yandex, FakeOutcome::Failure(failure)),
                (
                    StationReleaseOrigin::Github,
                    FakeOutcome::Update(candidate(StationReleaseOrigin::Github)),
                ),
            ]);

            let error = run(&transport).expect_err("failure is terminal");

            assert_eq!(error.code, StationUpdateErrorCode::PolicyDenied);
            assert!(!error.retryable);
            assert_eq!(
                transport.calls(),
                vec![(StationReleaseOrigin::Yandex, BETA_YANDEX_ENDPOINT)]
            );
        }
    }

    #[test]
    fn wrong_channel_version_target_future_date_and_downgrade_are_denied() {
        let cases = [
            {
                let mut value = candidate(StationReleaseOrigin::Yandex);
                value.0.download_url = value.0.download_url.replace("/beta/", "/stable/");
                value
            },
            {
                let mut value = candidate(StationReleaseOrigin::Yandex);
                value.0.version = "0.2.0".into();
                value.0.download_url = value.0.download_url.replace(UPDATE_VERSION, "0.2.0");
                value
            },
            {
                let mut value = candidate(StationReleaseOrigin::Yandex);
                value.0.target = "windows-aarch64".into();
                value
            },
            {
                let mut value = candidate(StationReleaseOrigin::Yandex);
                value.0.published_unix = NOW_UNIX + 301;
                value.0.published_at = "2026-08-24T10:06:01Z".into();
                value
            },
            {
                let mut value = candidate(StationReleaseOrigin::Yandex);
                value.0.version = "0.2.0-beta.5".into();
                value.0.download_url = value.0.download_url.replace(UPDATE_VERSION, "0.2.0-beta.5");
                value
            },
            {
                let mut value = candidate(StationReleaseOrigin::Yandex);
                value.0.signature.clear();
                value
            },
            {
                let mut value = candidate(StationReleaseOrigin::Yandex);
                value.0.version = "9007199254740992.0.0-beta.1".into();
                value.0.download_url = value
                    .0
                    .download_url
                    .replace(UPDATE_VERSION, "9007199254740992.0.0-beta.1");
                value
            },
        ];

        for value in cases {
            let transport = FakeTransport::new(vec![(
                StationReleaseOrigin::Yandex,
                FakeOutcome::Update(value),
            )]);

            let error = run(&transport).expect_err("invalid candidate is denied");

            assert_eq!(error.code, StationUpdateErrorCode::PolicyDenied);
            assert!(!error.retryable);
            assert_eq!(
                transport.calls(),
                vec![(StationReleaseOrigin::Yandex, BETA_YANDEX_ENDPOINT)]
            );
        }
    }

    #[test]
    fn compiled_channel_requires_the_exact_ordered_endpoint_pair() {
        let beta = [
            "https://releases.markiro.app/station/beta/latest.json",
            "https://github.com/thevladbog/markiro/releases/download/station-beta-channel/latest.json",
        ];
        let reversed = [beta[1], beta[0]];

        assert_eq!(
            StationReleaseChannel::from_compiled_endpoints(&beta).expect("beta config"),
            StationReleaseChannel::Beta
        );
        assert!(StationReleaseChannel::from_compiled_endpoints(&reversed).is_err());
        assert!(StationReleaseChannel::from_compiled_endpoints(&["https://example.com"]).is_err());
    }

    #[test]
    fn candidate_slot_is_one_item_expiring_and_consumed_after_use() {
        let slot = CandidateSlot::default();
        let now = Instant::now();

        let first_check = slot.begin_check().expect("begin first check");
        slot.replace(first_check, "first".into(), 1_u8, now)
            .expect("store first");
        let second_check = slot.begin_check().expect("begin second check");
        assert_eq!(
            slot.take("first", now).expect_err("first invalidated").code,
            StationUpdateErrorCode::CandidateInvalid
        );
        slot.replace(second_check, "second".into(), 2_u8, now)
            .expect("store second");
        assert_eq!(slot.take("second", now).expect("consume second"), 2);
        assert_eq!(
            slot.take("second", now)
                .expect_err("candidate is one use")
                .code,
            StationUpdateErrorCode::CandidateInvalid
        );

        let expiry_check = slot.begin_check().expect("begin expiry check");
        slot.replace(expiry_check, "expired".into(), 3_u8, now)
            .expect("store expiring candidate");
        assert_eq!(
            slot.take("expired", now + CANDIDATE_TTL + Duration::from_millis(1))
                .expect_err("candidate expired")
                .code,
            StationUpdateErrorCode::CandidateExpired
        );
    }

    #[test]
    fn older_overlapping_check_cannot_replace_or_invalidate_the_newer_candidate() {
        tauri::async_runtime::block_on(async {
            let candidates = Arc::new(CandidateSlot::default());
            let (a_started_sender, mut a_started) = tauri::async_runtime::channel(1);
            let (a_response, a_receiver) = tauri::async_runtime::channel(1);
            let (b_started_sender, mut b_started) = tauri::async_runtime::channel(1);
            let (b_response, b_receiver) = tauri::async_runtime::channel(1);
            let transport = Arc::new(ControlledTransport::new(vec![
                ScheduledCheck {
                    origin: StationReleaseOrigin::Yandex,
                    endpoint: BETA_YANDEX_ENDPOINT,
                    started: a_started_sender,
                    response: a_receiver,
                },
                ScheduledCheck {
                    origin: StationReleaseOrigin::Yandex,
                    endpoint: BETA_YANDEX_ENDPOINT,
                    started: b_started_sender,
                    response: b_receiver,
                },
            ]));
            let checked_at = Instant::now();

            let a_candidates = Arc::clone(&candidates);
            let a_transport = Arc::clone(&transport);
            let check_a = tauri::async_runtime::spawn(async move {
                let generation = a_candidates.begin_check()?;
                execute_update_check(
                    &a_candidates,
                    &*a_transport,
                    StartedUpdateCheck {
                        generation,
                        channel: StationReleaseChannel::Beta,
                        current_version: CURRENT_VERSION,
                        now_unix: NOW_UNIX,
                        candidate_id: "candidate-a".into(),
                        checked_at,
                    },
                )
                .await
            });
            a_started.recv().await.expect("check A started");

            let b_candidates = Arc::clone(&candidates);
            let b_transport = Arc::clone(&transport);
            let check_b = tauri::async_runtime::spawn(async move {
                let generation = b_candidates.begin_check()?;
                execute_update_check(
                    &b_candidates,
                    &*b_transport,
                    StartedUpdateCheck {
                        generation,
                        channel: StationReleaseChannel::Beta,
                        current_version: CURRENT_VERSION,
                        now_unix: NOW_UNIX,
                        candidate_id: "candidate-b".into(),
                        checked_at,
                    },
                )
                .await
            });
            b_started.recv().await.expect("check B started");

            b_response
                .send(FakeOutcome::Update(candidate(StationReleaseOrigin::Yandex)))
                .await
                .expect("finish check B first");
            let update_b = check_b
                .await
                .expect("join check B")
                .expect("check B succeeds")
                .expect("check B update");
            assert_eq!(update_b.candidate_id, "candidate-b");

            a_response
                .send(FakeOutcome::Update(candidate(StationReleaseOrigin::Yandex)))
                .await
                .expect("finish check A late");
            let error_a = check_a
                .await
                .expect("join check A")
                .expect_err("check A is superseded");
            assert_eq!(error_a.code, StationUpdateErrorCode::CheckSuperseded);
            assert!(!error_a.retryable);
            assert_eq!(
                serde_json::to_string(&error_a).expect("serialize superseded error"),
                r#"{"code":"check-superseded","retryable":false}"#
            );

            assert_eq!(
                candidates
                    .take("candidate-a", checked_at)
                    .expect_err("stale candidate ID was never published")
                    .code,
                StationUpdateErrorCode::CandidateInvalid
            );
            assert_eq!(
                candidates
                    .take("candidate-b", checked_at)
                    .expect("B remains the current candidate")
                    .metadata
                    .version,
                UPDATE_VERSION
            );
        });
    }

    #[test]
    fn download_rechecks_the_exact_selected_target_and_installs_primary_once() {
        let discovery = FakeTransport::new(vec![(
            StationReleaseOrigin::Yandex,
            FakeOutcome::Update(candidate(StationReleaseOrigin::Yandex)),
        )]);
        let packages =
            FakePackageTransport::new(vec![FakeDownload::success(9, vec![4, 9], b"package-1")]);
        let mut progress = RecordingProgress::default();

        run_candidate_install(
            accepted_candidate(StationReleaseOrigin::Yandex),
            &discovery,
            &packages,
            &mut progress,
        )
        .expect("verified primary install");

        assert_eq!(
            discovery.calls(),
            vec![(StationReleaseOrigin::Yandex, BETA_YANDEX_ENDPOINT)]
        );
        assert_eq!(
            packages.download_calls(),
            vec![candidate(StationReleaseOrigin::Yandex).0.download_url]
        );
        assert_eq!(
            packages.install_calls(),
            vec![candidate(StationReleaseOrigin::Yandex).0.download_url]
        );
        assert_eq!(
            progress.events,
            vec![
                StationUpdateProgress::Started {
                    content_length: Some(9),
                },
                StationUpdateProgress::Progress { chunk_length: 4 },
                StationUpdateProgress::Progress { chunk_length: 5 },
                StationUpdateProgress::Finished,
            ]
        );
    }

    #[test]
    fn download_recheck_begins_with_the_selected_github_origin() {
        let discovery = FakeTransport::new(vec![(
            StationReleaseOrigin::Github,
            FakeOutcome::Update(candidate(StationReleaseOrigin::Github)),
        )]);
        let packages =
            FakePackageTransport::new(vec![FakeDownload::success(9, vec![9], b"package-1")]);
        let mut progress = RecordingProgress::default();
        let mut accepted = accepted_candidate(StationReleaseOrigin::Github);
        accepted.fallback_reason = Some(StationFallbackReason::PrimaryUnavailable);

        run_candidate_install(accepted, &discovery, &packages, &mut progress)
            .expect("selected GitHub install");

        assert_eq!(
            discovery.calls(),
            vec![(StationReleaseOrigin::Github, BETA_GITHUB_ENDPOINT)]
        );
        assert_eq!(
            packages.install_calls(),
            vec![candidate(StationReleaseOrigin::Github).0.download_url]
        );
    }

    #[test]
    fn download_transport_failure_uses_equal_peer_with_monotonic_progress() {
        let discovery = FakeTransport::new(vec![
            (
                StationReleaseOrigin::Yandex,
                FakeOutcome::Update(candidate(StationReleaseOrigin::Yandex)),
            ),
            (
                StationReleaseOrigin::Github,
                FakeOutcome::Update(candidate(StationReleaseOrigin::Github)),
            ),
        ]);
        let packages = FakePackageTransport::new(vec![
            FakeDownload::failure(
                Some(Some(9)),
                vec![4, 7],
                PackageDownloadFailure::Plugin {
                    source: tauri_plugin_updater::Error::Network("HTTP 503 fixture".into()),
                    before_complete: true,
                },
            ),
            FakeDownload::success(9, vec![3, 6, 9], b"package-1"),
        ]);
        let mut progress = RecordingProgress::default();

        run_candidate_install(
            accepted_candidate(StationReleaseOrigin::Yandex),
            &discovery,
            &packages,
            &mut progress,
        )
        .expect("equal peer package install");

        assert_eq!(
            discovery.calls(),
            vec![
                (StationReleaseOrigin::Yandex, BETA_YANDEX_ENDPOINT),
                (StationReleaseOrigin::Github, BETA_GITHUB_ENDPOINT),
            ]
        );
        assert_eq!(
            packages.download_calls(),
            vec![
                candidate(StationReleaseOrigin::Yandex).0.download_url,
                candidate(StationReleaseOrigin::Github).0.download_url,
            ]
        );
        assert_eq!(
            packages.install_calls(),
            vec![candidate(StationReleaseOrigin::Github).0.download_url]
        );
        assert_eq!(
            progress.events,
            vec![
                StationUpdateProgress::Started {
                    content_length: Some(9),
                },
                StationUpdateProgress::Progress { chunk_length: 4 },
                StationUpdateProgress::Progress { chunk_length: 3 },
                StationUpdateProgress::Progress { chunk_length: 2 },
                StationUpdateProgress::Finished,
            ]
        );
    }

    #[test]
    fn download_peer_metadata_mismatch_is_terminal_for_every_signed_field() {
        let mismatches = [
            {
                let mut peer = candidate(StationReleaseOrigin::Github);
                peer.0.version = "0.2.0-beta.8".into();
                peer.0.download_url = StationReleaseChannel::Beta
                    .expected_download_url(StationReleaseOrigin::Github, "0.2.0-beta.8");
                peer
            },
            {
                let mut peer = candidate(StationReleaseOrigin::Github);
                peer.0.target = "windows-aarch64".into();
                peer
            },
            {
                let mut peer = candidate(StationReleaseOrigin::Github);
                peer.0.published_at = "2026-08-24T10:00:01Z".into();
                peer.0.published_unix += 1;
                peer
            },
            {
                let mut peer = candidate(StationReleaseOrigin::Github);
                peer.0.signature = "different-signature".into();
                peer
            },
        ];

        for peer in mismatches {
            let discovery = FakeTransport::new(vec![
                (
                    StationReleaseOrigin::Yandex,
                    FakeOutcome::Update(candidate(StationReleaseOrigin::Yandex)),
                ),
                (StationReleaseOrigin::Github, FakeOutcome::Update(peer)),
            ]);
            let packages = FakePackageTransport::new(vec![FakeDownload::failure(
                None,
                vec![],
                PackageDownloadFailure::Plugin {
                    source: tauri_plugin_updater::Error::Network("HTTP 503 fixture".into()),
                    before_complete: true,
                },
            )]);
            let mut progress = RecordingProgress::default();

            let error = run_candidate_install(
                accepted_candidate(StationReleaseOrigin::Yandex),
                &discovery,
                &packages,
                &mut progress,
            )
            .expect_err("peer mismatch denied");

            assert_eq!(error.code, StationUpdateErrorCode::OriginMismatch);
            assert!(!error.retryable);
            assert_eq!(packages.download_calls().len(), 1);
            assert!(packages.install_calls().is_empty());
        }
    }

    #[test]
    fn download_peer_transport_failure_returns_retryable_availability_error() {
        let discovery = FakeTransport::new(vec![
            (
                StationReleaseOrigin::Yandex,
                FakeOutcome::Update(candidate(StationReleaseOrigin::Yandex)),
            ),
            (
                StationReleaseOrigin::Github,
                FakeOutcome::Update(candidate(StationReleaseOrigin::Github)),
            ),
        ]);
        let request_error = tauri::async_runtime::block_on(async {
            let body = reqwest::Body::wrap_stream(OneErrorStream(Some(io::Error::new(
                io::ErrorKind::ConnectionReset,
                "controlled package body failure",
            ))));
            let response = reqwest::Response::from(
                http::Response::builder()
                    .status(200)
                    .body(body)
                    .expect("package response"),
            );
            response.bytes().await.expect_err("package body fails")
        });
        let packages = FakePackageTransport::new(vec![
            FakeDownload::failure(
                None,
                vec![],
                PackageDownloadFailure::Plugin {
                    source: tauri_plugin_updater::Error::Network("HTTP 503 fixture".into()),
                    before_complete: true,
                },
            ),
            FakeDownload::failure(
                None,
                vec![],
                PackageDownloadFailure::Plugin {
                    source: tauri_plugin_updater::Error::Reqwest(request_error),
                    before_complete: true,
                },
            ),
        ]);
        let mut progress = RecordingProgress::default();

        let error = run_candidate_install(
            accepted_candidate(StationReleaseOrigin::Yandex),
            &discovery,
            &packages,
            &mut progress,
        )
        .expect_err("both packages unavailable");

        assert_eq!(error.code, StationUpdateErrorCode::OriginsUnavailable);
        assert!(error.retryable);
        assert_eq!(packages.download_calls().len(), 2);
        assert!(packages.install_calls().is_empty());
    }

    #[test]
    fn download_integrity_failure_never_fetches_the_peer() {
        let invalid_signature = base64::engine::general_purpose::STANDARD
            .decode("not!base64")
            .expect_err("invalid signature fixture");
        let (public_key, signature) = encoded_minisign_fixture();
        let invalid_package = verify_package_signature(b"Test", &signature, &public_key)
            .expect_err("corrupt package fixture");

        for source in [
            tauri_plugin_updater::Error::Base64(invalid_signature),
            invalid_package,
        ] {
            let discovery = FakeTransport::new(vec![(
                StationReleaseOrigin::Yandex,
                FakeOutcome::Update(candidate(StationReleaseOrigin::Yandex)),
            )]);
            let packages = FakePackageTransport::new(vec![FakeDownload::failure(
                Some(Some(9)),
                vec![9],
                PackageDownloadFailure::Plugin {
                    source,
                    before_complete: false,
                },
            )]);
            let mut progress = RecordingProgress::default();

            let error = run_candidate_install(
                accepted_candidate(StationReleaseOrigin::Yandex),
                &discovery,
                &packages,
                &mut progress,
            )
            .expect_err("integrity failure denied");

            assert_eq!(error.code, StationUpdateErrorCode::IntegrityFailed);
            assert!(!error.retryable);
            assert_eq!(
                discovery.calls(),
                vec![(StationReleaseOrigin::Yandex, BETA_YANDEX_ENDPOINT)]
            );
            assert_eq!(packages.download_calls().len(), 1);
            assert!(packages.install_calls().is_empty());
            assert!(!progress.events.contains(&StationUpdateProgress::Finished));
        }
    }

    #[test]
    fn download_transport_error_after_complete_bytes_never_falls_back() {
        let discovery = FakeTransport::new(vec![(
            StationReleaseOrigin::Yandex,
            FakeOutcome::Update(candidate(StationReleaseOrigin::Yandex)),
        )]);
        let packages = FakePackageTransport::new(vec![FakeDownload::failure(
            Some(Some(9)),
            vec![9],
            PackageDownloadFailure::Plugin {
                source: tauri_plugin_updater::Error::Network("late transport error".into()),
                before_complete: false,
            },
        )]);
        let mut progress = RecordingProgress::default();

        let error = run_candidate_install(
            accepted_candidate(StationReleaseOrigin::Yandex),
            &discovery,
            &packages,
            &mut progress,
        )
        .expect_err("late transport error is terminal");

        assert_eq!(error.code, StationUpdateErrorCode::InstallationFailed);
        assert_eq!(packages.download_calls().len(), 1);
        assert!(packages.install_calls().is_empty());
    }

    #[test]
    fn download_installer_local_failure_launches_once_and_never_falls_back() {
        let discovery = FakeTransport::new(vec![(
            StationReleaseOrigin::Yandex,
            FakeOutcome::Update(candidate(StationReleaseOrigin::Yandex)),
        )]);
        let packages =
            FakePackageTransport::new(vec![FakeDownload::success(9, vec![9], b"package-1")])
                .with_install_error(tauri_plugin_updater::Error::Io(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "controlled local write failure",
                )));
        let mut progress = RecordingProgress::default();

        let error = run_candidate_install(
            accepted_candidate(StationReleaseOrigin::Yandex),
            &discovery,
            &packages,
            &mut progress,
        )
        .expect_err("installer local failure");

        assert_eq!(error.code, StationUpdateErrorCode::InstallationFailed);
        assert_eq!(packages.download_calls().len(), 1);
        assert_eq!(packages.install_calls().len(), 1);
        assert_eq!(
            discovery.calls(),
            vec![(StationReleaseOrigin::Yandex, BETA_YANDEX_ENDPOINT)]
        );
        assert_eq!(
            progress.events.last(),
            Some(&StationUpdateProgress::Finished)
        );
    }

    #[test]
    fn download_recheck_version_change_is_denied_before_package_bytes() {
        let mut changed = candidate(StationReleaseOrigin::Yandex);
        changed.0.version = "0.2.0-beta.8".into();
        changed.0.download_url = StationReleaseChannel::Beta
            .expected_download_url(StationReleaseOrigin::Yandex, "0.2.0-beta.8");
        let discovery = FakeTransport::new(vec![(
            StationReleaseOrigin::Yandex,
            FakeOutcome::Update(changed),
        )]);
        let packages = FakePackageTransport::new(vec![]);
        let mut progress = RecordingProgress::default();

        let error = run_candidate_install(
            accepted_candidate(StationReleaseOrigin::Yandex),
            &discovery,
            &packages,
            &mut progress,
        )
        .expect_err("version change denied");

        assert_eq!(error.code, StationUpdateErrorCode::OriginMismatch);
        assert!(packages.download_calls().is_empty());
        assert!(packages.install_calls().is_empty());
    }

    #[test]
    fn download_closed_progress_channel_cancels_and_cleans_without_fallback() {
        let discovery = FakeTransport::new(vec![(
            StationReleaseOrigin::Yandex,
            FakeOutcome::Update(candidate(StationReleaseOrigin::Yandex)),
        )]);
        let cleaned = Arc::new(AtomicBool::new(false));
        let packages = FakePackageTransport::new(vec![FakeDownload {
            started: Some(Some(9)),
            cumulative_bytes: vec![4, 9],
            result: Ok(b"package-1".to_vec()),
            cleaned: Some(Arc::clone(&cleaned)),
        }]);
        let mut progress = RecordingProgress {
            events: Vec::new(),
            fail_after: Some(1),
        };

        let error = run_candidate_install(
            accepted_candidate(StationReleaseOrigin::Yandex),
            &discovery,
            &packages,
            &mut progress,
        )
        .expect_err("closed progress channel cancels");

        assert_eq!(error.code, StationUpdateErrorCode::InstallationFailed);
        assert!(cleaned.load(Ordering::SeqCst));
        assert_eq!(packages.download_calls().len(), 1);
        assert!(packages.install_calls().is_empty());
        assert_eq!(
            discovery.calls(),
            vec![(StationReleaseOrigin::Yandex, BETA_YANDEX_ENDPOINT)]
        );
    }

    #[test]
    fn download_candidate_consumption_has_no_concurrent_replay_hole() {
        let slot = Arc::new(CandidateSlot::default());
        let now = Instant::now();
        let generation = slot.begin_check().expect("begin candidate check");
        slot.replace(
            generation,
            "one-use".into(),
            accepted_candidate(StationReleaseOrigin::Yandex),
            now,
        )
        .expect("store candidate");
        let barrier = Arc::new(Barrier::new(3));
        let mut workers = Vec::new();
        for _ in 0..2 {
            let slot = Arc::clone(&slot);
            let barrier = Arc::clone(&barrier);
            workers.push(std::thread::spawn(move || {
                barrier.wait();
                slot.take("one-use", now)
            }));
        }
        barrier.wait();
        let outcomes = workers
            .into_iter()
            .map(|worker| worker.join().expect("candidate worker"))
            .collect::<Vec<_>>();

        assert_eq!(outcomes.iter().filter(|outcome| outcome.is_ok()).count(), 1);
        assert_eq!(
            outcomes
                .iter()
                .filter_map(|outcome| outcome.as_ref().err())
                .map(|error| error.code)
                .collect::<Vec<_>>(),
            vec![StationUpdateErrorCode::CandidateInvalid]
        );

        let installs = Arc::new(InstallCoordinator::default());
        let start = Arc::new(Barrier::new(3));
        let attempted = Arc::new(Barrier::new(3));
        let mut workers = Vec::new();
        for _ in 0..2 {
            let installs = Arc::clone(&installs);
            let start = Arc::clone(&start);
            let attempted = Arc::clone(&attempted);
            workers.push(std::thread::spawn(move || {
                start.wait();
                let permit = installs.acquire();
                attempted.wait();
                permit.is_ok()
            }));
        }
        start.wait();
        attempted.wait();
        assert_eq!(
            workers
                .into_iter()
                .map(|worker| worker.join().expect("install worker"))
                .filter(|acquired| *acquired)
                .count(),
            1
        );
    }

    #[test]
    fn download_buffer_is_bounded_before_appending_excess_bytes() {
        let mut accumulator = PackageAccumulator::with_limit(4);
        accumulator.extend(b"abc").expect("first bounded chunk");
        let error = accumulator.extend(b"de").expect_err("oversized package");

        assert!(matches!(error, PackageDownloadFailure::PackageTooLarge));
        assert_eq!(accumulator.len(), 3);
    }

    #[test]
    fn download_uses_the_pinned_tauri_minisign_verifier_behavior() {
        let (public_key, signature) = encoded_minisign_fixture();

        verify_package_signature(b"test", &signature, &public_key)
            .expect("pinned Tauri fixture verifies");
        assert!(matches!(
            verify_package_signature(b"Test", &signature, &public_key),
            Err(tauri_plugin_updater::Error::Minisign(_))
        ));
    }

    #[test]
    fn install_request_accepts_only_an_opaque_candidate_id() {
        let request = serde_json::from_value::<super::StationUpdateInstallRequest>(
            serde_json::json!({ "candidateId": "opaque-id" }),
        )
        .expect("candidate-only request");
        assert_eq!(request.candidate_id, "opaque-id");

        for caller_owned_field in ["url", "channel", "version", "signature"] {
            let mut value = serde_json::json!({ "candidateId": "opaque-id" });
            value
                .as_object_mut()
                .expect("request object")
                .insert(caller_owned_field.into(), serde_json::json!("injected"));
            assert!(
                serde_json::from_value::<super::StationUpdateInstallRequest>(value).is_err(),
                "accepted caller-owned {caller_owned_field}"
            );
        }
    }
}
