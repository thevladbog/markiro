//! Authenticated calls to the paired host (spec §5.2). A connection is
//! accepted only when the host certificate's SHA-256 equals the fingerprint
//! pinned at pairing. No proxy, no redirects, short timeouts, and the
//! protocol header on every request, and the app's version (plan ОБН-1).
//! [`StreamClient`] holds the change stream
//! the same way, limited by silence instead of a total time.

use std::time::Duration;

use markiro_proto::{
    Secret, APP_VERSION_HEADER, OFFICE_SESSION_HEADER, PROTOCOL_HEADER, PROTOCOL_VERSION,
};
use reqwest::header::{HeaderMap, HeaderValue};
use reqwest::Method;
use serde::Serialize;
use serde_json::Value;

use crate::tls::{self, FingerprintMismatch, FingerprintPolicy};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_PATH_LENGTH: usize = 512;
/// How long a stream may stay silent before the link counts as lost: three
/// missed 15 s heartbeats.
pub const STREAM_SILENCE_LIMIT: Duration = Duration::from_secs(45);
/// How long a transfer of the installer may go without a byte before it
/// counts as lost (spec §10.11.4).
pub const TRANSFER_SILENCE_LIMIT: Duration = Duration::from_secs(60);

/// Any HTTP answer, error statuses included: the webview reads the error
/// body's code itself.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostResponse {
    pub status: u16,
    pub body: Option<Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RequestError {
    /// No connection, a TLS failure other than the pin, or one of the
    /// client's own time limits (its 2 s to connect, its 10 s per request).
    Unreachable,
    /// The host presented a certificate other than the pinned one.
    CertificateMismatch,
    /// The host answered with a body that is not JSON.
    InvalidResponse,
    /// The request cannot be sent as asked: the method or path is not
    /// allowed, the office token is not a valid header value, or the host
    /// address is not HTTPS.
    InvalidRequest,
    /// The host did not answer within the limit the caller set
    /// ([`PinnedClient::send_within`]); without one, a request that runs
    /// past the client's 10 s stays [`RequestError::Unreachable`].
    Timeout,
}

impl RequestError {
    /// Stable codes the webview maps to text (`src/host/client.ts`).
    pub fn code(self) -> &'static str {
        match self {
            RequestError::Unreachable => "unreachable",
            RequestError::CertificateMismatch => "certificate_mismatch",
            RequestError::InvalidResponse => "invalid_response",
            RequestError::InvalidRequest => "invalid_request",
            RequestError::Timeout => "timeout",
        }
    }
}

/// Credentials attached to one request. `Debug` never prints the key or the
/// office token: both are secrets that must not reach logs.
#[derive(Clone, Copy, Default)]
pub struct Credentials<'a> {
    pub device_key: Option<&'a Secret>,
    pub office_token: Option<&'a str>,
}

impl std::fmt::Debug for Credentials<'_> {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        fn redacted<T>(value: Option<T>) -> &'static str {
            if value.is_some() {
                "Some(***)"
            } else {
                "None"
            }
        }
        write!(
            formatter,
            "Credentials {{ device_key: {}, office_token: {} }}",
            redacted(self.device_key),
            redacted(self.office_token)
        )
    }
}

#[derive(Debug, Clone)]
pub struct PinnedClient {
    client: reqwest::Client,
    address: String,
}

impl PinnedClient {
    /// A client for `address` (`https://host:port`) that trusts only the
    /// certificate with this lower-case hex SHA-256 `fingerprint`.
    pub fn new(address: &str, fingerprint: &str) -> Result<Self, RequestError> {
        let client = pinned_builder(fingerprint)?
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|_| RequestError::Unreachable)?;
        Ok(Self {
            client,
            address: address.trim_end_matches('/').to_owned(),
        })
    }

    pub async fn send(
        &self,
        method: &str,
        path: &str,
        body: Option<&Value>,
        credentials: Credentials<'_>,
    ) -> Result<HostResponse, RequestError> {
        self.send_within(method, path, body, credentials, None)
            .await
    }

    /// [`Self::send`], limited to `limit` from connecting to the end of the
    /// body instead of the client's 10 s. A request that runs past `limit`
    /// is [`RequestError::Timeout`], so a caller that asked for a short
    /// answer (the station's 300 ms code check) can tell "too slow" from
    /// "unreachable".
    pub async fn send_within(
        &self,
        method: &str,
        path: &str,
        body: Option<&Value>,
        credentials: Credentials<'_>,
        limit: Option<Duration>,
    ) -> Result<HostResponse, RequestError> {
        let method = allowed_method(method)?;
        validate_path(path)?;
        let mut request = self
            .client
            .request(method, format!("{}{path}", self.address))
            .header(PROTOCOL_HEADER, PROTOCOL_VERSION.to_string());
        if let Some(limit) = limit {
            request = request.timeout(limit);
        }
        if let Some(key) = credentials.device_key {
            request = request.bearer_auth(key.expose());
        }
        if let Some(token) = credentials.office_token {
            request = request.header(OFFICE_SESSION_HEADER, token);
        }
        if let Some(body) = body {
            request = request.json(body);
        }
        let lost = |error: reqwest::Error| {
            // The client's own 2 s to connect also reads as a timeout, but it
            // is not the caller's limit: that is `unreachable`.
            if limit.is_some() && error.is_timeout() && !error.is_connect() {
                RequestError::Timeout
            } else {
                RequestError::Unreachable
            }
        };
        let response = match request.send().await {
            Ok(response) => response,
            Err(error) if error.is_builder() => return Err(RequestError::InvalidRequest),
            Err(error) if is_fingerprint_mismatch(&error) => {
                return Err(RequestError::CertificateMismatch)
            }
            Err(error) => return Err(lost(error)),
        };
        let status = response.status().as_u16();
        let bytes = response.bytes().await.map_err(lost)?;
        let body = if bytes.is_empty() {
            None
        } else {
            Some(serde_json::from_slice(&bytes).map_err(|_| RequestError::InvalidResponse)?)
        };
        Ok(HostResponse { status, body })
    }
}

/// A long-lived request to the paired host — the change stream — with the
/// same pinned certificate, headers and path rules as [`PinnedClient`], but
/// no limit on the whole exchange: only on silence.
#[derive(Debug, Clone)]
pub struct StreamClient {
    client: reqwest::Client,
    address: String,
}

/// The answer to a stream request.
#[derive(Debug)]
pub enum StreamOpen {
    /// A 2xx answer: read it with [`HostStream::chunk`].
    Open(HostStream),
    /// Any other answer, read whole.
    Refused(HostResponse),
}

#[derive(Debug)]
pub struct HostStream {
    response: reqwest::Response,
}

impl StreamClient {
    pub fn new(address: &str, fingerprint: &str) -> Result<Self, RequestError> {
        let client = pinned_builder(fingerprint)?
            .read_timeout(STREAM_SILENCE_LIMIT)
            .build()
            .map_err(|_| RequestError::Unreachable)?;
        Ok(Self {
            client,
            address: address.trim_end_matches('/').to_owned(),
        })
    }

    /// `GET path` with the device key.
    pub async fn open(&self, path: &str, key: &Secret) -> Result<StreamOpen, RequestError> {
        validate_path(path)?;
        let sent = self
            .client
            .get(format!("{}{path}", self.address))
            .header(PROTOCOL_HEADER, PROTOCOL_VERSION.to_string())
            .bearer_auth(key.expose())
            .send()
            .await;
        let response = match sent {
            Ok(response) => response,
            Err(error) if is_fingerprint_mismatch(&error) => {
                return Err(RequestError::CertificateMismatch)
            }
            Err(_) => return Err(RequestError::Unreachable),
        };
        if response.status().is_success() {
            return Ok(StreamOpen::Open(HostStream { response }));
        }
        let status = response.status().as_u16();
        let bytes = response
            .bytes()
            .await
            .map_err(|_| RequestError::Unreachable)?;
        Ok(StreamOpen::Refused(HostResponse {
            status,
            body: serde_json::from_slice(&bytes).ok(),
        }))
    }
}

impl HostStream {
    /// The next bytes, `None` once the host closed the stream. Silence past
    /// [`STREAM_SILENCE_LIMIT`] is an error.
    pub async fn chunk(&mut self) -> Result<Option<Vec<u8>>, RequestError> {
        match self.response.chunk().await {
            Ok(chunk) => Ok(chunk.map(|bytes| bytes.to_vec())),
            Err(_) => Err(RequestError::Unreachable),
        }
    }
}

/// Long transfers with the paired host — the installer down
/// (`update_fetch`) and up (`update_stage`, plan ОБН-3) — with the same
/// pinned certificate, headers and path rules as [`PinnedClient`], no limit
/// on the whole exchange, and [`TRANSFER_SILENCE_LIMIT`] of silence.
#[derive(Debug, Clone)]
pub struct TransferClient {
    client: reqwest::Client,
    address: String,
}

/// An answer to a download: its status and headers at once, its body piece
/// by piece.
#[derive(Debug)]
pub struct Download {
    response: reqwest::Response,
}

impl TransferClient {
    pub fn new(address: &str, fingerprint: &str) -> Result<Self, RequestError> {
        let client = pinned_builder(fingerprint)?
            .read_timeout(TRANSFER_SILENCE_LIMIT)
            .build()
            .map_err(|_| RequestError::Unreachable)?;
        Ok(Self {
            client,
            address: address.trim_end_matches('/').to_owned(),
        })
    }

    /// `GET path` with the device key. `resume` asks for the bytes from an
    /// offset, only if the file is still the one of that ETag (`Range`,
    /// `If-Range`); the host answers the whole file otherwise.
    pub async fn download(
        &self,
        path: &str,
        key: &Secret,
        resume: Option<(u64, &str)>,
    ) -> Result<Download, RequestError> {
        validate_path(path)?;
        let mut request = self
            .client
            .get(format!("{}{path}", self.address))
            .header(PROTOCOL_HEADER, PROTOCOL_VERSION.to_string())
            .bearer_auth(key.expose());
        if let Some((from, etag)) = resume {
            request = request
                .header(reqwest::header::RANGE, format!("bytes={from}-"))
                .header(reqwest::header::IF_RANGE, etag);
        }
        match request.send().await {
            Ok(response) => Ok(Download { response }),
            Err(error) if is_fingerprint_mismatch(&error) => Err(RequestError::CertificateMismatch),
            Err(_) => Err(RequestError::Unreachable),
        }
    }
}

impl Download {
    pub fn status(&self) -> u16 {
        self.response.status().as_u16()
    }

    /// Where a `206` begins (`Content-Range: bytes N-M/S`).
    pub fn range_start(&self) -> Option<u64> {
        self.response
            .headers()
            .get(reqwest::header::CONTENT_RANGE)?
            .to_str()
            .ok()?
            .strip_prefix("bytes ")?
            .split_once('-')?
            .0
            .parse()
            .ok()
    }

    /// The next bytes, `None` at the end. Silence past
    /// [`TRANSFER_SILENCE_LIMIT`] or a dropped connection is an error.
    pub async fn chunk(&mut self) -> Result<Option<Vec<u8>>, RequestError> {
        match self.response.chunk().await {
            Ok(chunk) => Ok(chunk.map(|bytes| bytes.to_vec())),
            Err(_) => Err(RequestError::Unreachable),
        }
    }

    /// An answer that is not the file: the host's error, read whole.
    pub async fn into_error(self) -> HostResponse {
        let status = self.status();
        let bytes = self.response.bytes().await.unwrap_or_default();
        HostResponse {
            status,
            body: serde_json::from_slice(&bytes).ok(),
        }
    }
}

/// The headers every request to the host carries besides the protocol (plan
/// ОБН-1): the app's own version, which the host records on the device
/// (`devices.app_version`, spec §10.11.7).
fn default_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        APP_VERSION_HEADER,
        HeaderValue::from_static(env!("CARGO_PKG_VERSION")),
    );
    headers
}

/// A client builder that trusts only the certificate with `fingerprint`:
/// no proxy, no redirects, HTTPS only, 2 s to connect, and the app's version
/// on every request ([`default_headers`]).
fn pinned_builder(fingerprint: &str) -> Result<reqwest::ClientBuilder, RequestError> {
    let config = tls::client_config(FingerprintPolicy::Pin {
        expected: fingerprint.to_owned(),
    })
    .map_err(|_| RequestError::Unreachable)?;
    Ok(reqwest::Client::builder()
        .default_headers(default_headers())
        .use_preconfigured_tls(config)
        .connect_timeout(CONNECT_TIMEOUT)
        .no_proxy()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none()))
}

fn allowed_method(method: &str) -> Result<Method, RequestError> {
    match method {
        "GET" => Ok(Method::GET),
        "POST" => Ok(Method::POST),
        "PUT" => Ok(Method::PUT),
        "DELETE" => Ok(Method::DELETE),
        _ => Err(RequestError::InvalidRequest),
    }
}

/// Only host API paths: `/v1/…` of plain URL characters, no traversal. `%` is
/// excluded: none of our routes need percent-encoding, and allowing it would
/// let an encoded `..` or `/` reach the host after the `url` crate normalizes
/// it, bypassing the checks above. A `.` path segment is refused for the same
/// reason: `url` collapses `/v1/device/./line` to `/v1/device/line`, which
/// would reach a route that a caller-side check, such as
/// `device::webview_may_reach`'s `LINE_ROUTE` exclusion, meant to stop. A
/// route ending in `/` is refused too: no host route has a trailing slash, so
/// `/v1/device/line/` can only be an attempt to reach `/v1/device/line` past
/// such a caller-side check — today it is harmless only because the host
/// does not normalize a trailing slash away, but nothing guarantees that.
fn validate_path(path: &str) -> Result<(), RequestError> {
    let route = path.split('?').next().unwrap_or(path);
    let safe = path.starts_with("/v1/")
        && path.len() <= MAX_PATH_LENGTH
        && !path.contains("..")
        && !path.contains("//")
        && !route.ends_with('/')
        && !route.split('/').any(|segment| segment == ".")
        && path
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"/_.~?=&-".contains(&byte));
    if safe {
        Ok(())
    } else {
        Err(RequestError::InvalidRequest)
    }
}

/// Whether a failed request's error chain contains the pin verifier's
/// [`FingerprintMismatch`]. A `rustls::Error` returned by the certificate
/// verifier is not directly visible through `std::error::Error::source()`:
/// `tokio-rustls` reports the TLS failure as a nested `std::io::Error`, and
/// `io::Error::source()` skips the error it wraps (it delegates straight to
/// that error's own source), so the wrapped error is only reachable through
/// `io::Error::get_ref()`, followed recursively.
fn is_fingerprint_mismatch(error: &reqwest::Error) -> bool {
    let mut current: &(dyn std::error::Error + 'static) = error;
    loop {
        if wraps_fingerprint_mismatch(current) {
            return true;
        }
        match current.source() {
            Some(source) => current = source,
            None => return false,
        }
    }
}

fn wraps_fingerprint_mismatch(error: &(dyn std::error::Error + 'static)) -> bool {
    if let Some(rustls::Error::InvalidCertificate(rustls::CertificateError::Other(other))) =
        error.downcast_ref::<rustls::Error>()
    {
        return other.0.downcast_ref::<FingerprintMismatch>().is_some();
    }
    if let Some(io_error) = error.downcast_ref::<std::io::Error>() {
        if let Some(inner) = io_error.get_ref() {
            return wraps_fingerprint_mismatch(inner);
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_host_api_paths_pass() {
        for path in [
            "/v1/device",
            "/v1/office/sscc/counters/460068200/0",
            "/v1/changes?since=5&limit=100",
            // The query part is never split into path segments (`route`
            // stops at `?`), so a `.` there is unaffected by the `.` segment
            // check — whether it stands alone or, as in the second case,
            // forms what would look like a `/.` segment inside a path.
            "/v1/device?x=1.5",
            "/v1/device?x=/.",
        ] {
            assert_eq!(validate_path(path), Ok(()), "{path}");
        }
        let too_long = format!("/v1/{}", "a".repeat(MAX_PATH_LENGTH));
        for path in [
            "/other",
            "v1/device",
            "https://example.com/v1/device",
            "/v1/../etc",
            "/v1//device",
            "/v1/device name",
            "/v1/device\n",
            "/v1/%2e%2e/x",
            "/v1/.%2E/x",
            "/v1/office%2Fx",
            too_long.as_str(),
            // A `.` segment: the `url` crate collapses this to
            // `/v1/device/line`, which would reach the host's line route
            // even though `device::webview_may_reach` refused `LINE_ROUTE`.
            "/v1/device/./line",
            "/v1/office/./users",
            "/v1/device/line/.",
            // No host route ends with `/`; a caller-side exclusion like
            // `LINE_ROUTE` compares the route string exactly, so a trailing
            // slash must not be allowed to slip past it either.
            "/v1/device/line/",
            "/v1/office/",
        ] {
            assert_eq!(
                validate_path(path),
                Err(RequestError::InvalidRequest),
                "{path}"
            );
        }
    }

    #[test]
    fn only_known_methods_pass() {
        for method in ["GET", "POST", "PUT", "DELETE"] {
            assert!(allowed_method(method).is_ok(), "{method}");
        }
        for method in ["PATCH", "get", "CONNECT", ""] {
            assert_eq!(
                allowed_method(method),
                Err(RequestError::InvalidRequest),
                "{method}"
            );
        }
    }

    /// Every request to the host names the app's version (plan ОБН-1): the
    /// host records it on the device. Both clients take these headers from
    /// `pinned_builder`.
    #[test]
    fn every_request_names_the_apps_version() {
        let headers = default_headers();
        assert_eq!(headers.len(), 1);
        assert_eq!(
            headers
                .get(markiro_proto::APP_VERSION_HEADER)
                .and_then(|value| value.to_str().ok()),
            Some(env!("CARGO_PKG_VERSION"))
        );
    }

    #[test]
    fn credentials_debug_output_hides_the_key_and_the_token() {
        let key = Secret::from("device-key-value".to_owned());
        let credentials = Credentials {
            device_key: Some(&key),
            office_token: Some("office-token-value"),
        };
        let debug = format!("{credentials:?}");
        assert!(!debug.contains("device-key-value"), "{debug}");
        assert!(!debug.contains("office-token-value"), "{debug}");
        assert_eq!(
            debug,
            "Credentials { device_key: Some(***), office_token: Some(***) }"
        );

        let empty = format!("{:?}", Credentials::default());
        assert_eq!(
            empty,
            "Credentials { device_key: None, office_token: None }"
        );
    }
}
