use std::{
    fmt,
    future::Future,
    io,
    pin::Pin,
    sync::Mutex,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use tauri::{ipc::Channel, AppHandle, Runtime, State};
use tauri_plugin_updater::{Update, UpdaterExt};
use url::Url;

const WINDOWS_TARGET: &str = "windows-x86_64";
const UPDATE_CHECK_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_CLOCK_SKEW_SECONDS: i64 = 5 * 60;
const MAX_SAFE_VERSION_COMPONENT: u64 = 9_007_199_254_740_991;
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

fn compiled_channel<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<StationReleaseChannel, StationUpdateError> {
    let plugin_config = app
        .config()
        .plugins
        .0
        .get("updater")
        .cloned()
        .ok_or_else(StationUpdateError::policy_denied)?;
    let updater_config: tauri_plugin_updater::Config = serde_json::from_value(plugin_config)
        .map_err(|_error| StationUpdateError::policy_denied())?;
    let endpoints = updater_config
        .endpoints
        .iter()
        .map(Url::as_str)
        .collect::<Vec<_>>();
    StationReleaseChannel::from_compiled_endpoints(&endpoints)
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

#[derive(Clone, Copy, Debug, Serialize)]
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
    _app: AppHandle,
    state: State<'_, StationUpdaterState>,
    request: StationUpdateInstallRequest,
    progress: Channel<StationUpdateProgress>,
) -> Result<(), StationUpdateError> {
    let candidate = state
        .candidates
        .take(&request.candidate_id, Instant::now())?;
    let update = candidate.candidate.update;
    let mut started = false;
    let bytes = update
        .download(
            |chunk_length, content_length| {
                if !started {
                    started = true;
                    let _ = progress.send(StationUpdateProgress::Started { content_length });
                }
                let _ = progress.send(StationUpdateProgress::Progress { chunk_length });
            },
            || {},
        )
        .await
        .map_err(|_error| StationUpdateError::installation_failed())?;
    let _ = progress.send(StationUpdateProgress::Finished);
    update
        .install(bytes)
        .map_err(|_error| StationUpdateError::installation_failed())
}

#[cfg(test)]
mod tests {
    use std::{
        future::Future,
        io,
        pin::Pin,
        sync::{Arc, Mutex},
        task::{Context, Poll},
        time::{Duration, Instant},
    };

    use base64::Engine as _;
    use futures_core::Stream;

    use super::{
        classify_plugin_error, discover_update, execute_update_check, CandidateMetadata,
        CandidateSlot, DiscoveryCandidate, DiscoveryFailure, DiscoveryTransport,
        StartedUpdateCheck, StationFallbackReason, StationReleaseChannel, StationReleaseOrigin,
        StationUpdateErrorCode, CANDIDATE_TTL,
    };

    const CURRENT_VERSION: &str = "0.2.0-beta.6";
    const UPDATE_VERSION: &str = "0.2.0-beta.7";
    const PUBLISHED_AT: &str = "2026-08-24T10:00:00Z";
    const PUBLISHED_UNIX: i64 = 1_787_565_600;
    const NOW_UNIX: i64 = PUBLISHED_UNIX + 60;
    const BETA_YANDEX_ENDPOINT: &str = "https://releases.markiro.app/station/beta/latest.json";
    const BETA_GITHUB_ENDPOINT: &str =
        "https://github.com/thevladbog/markiro/releases/download/station-beta-channel/latest.json";

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
