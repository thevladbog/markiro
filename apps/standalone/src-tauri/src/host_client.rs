//! Authenticated calls to the paired host (spec §5.2). A connection is
//! accepted only when the host certificate's SHA-256 equals the fingerprint
//! pinned at pairing. No proxy, no redirects, short timeouts, and the
//! protocol header on every request.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use markiro_proto::{OFFICE_SESSION_HEADER, PROTOCOL_HEADER, PROTOCOL_VERSION};
use reqwest::Method;
use serde::Serialize;
use serde_json::Value;

use crate::tls::{self, FingerprintPolicy};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_PATH_LENGTH: usize = 512;

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
    /// No connection, a TLS failure other than the pin, or a timeout.
    Unreachable,
    /// The host presented a certificate other than the pinned one.
    CertificateMismatch,
    /// The host answered with a body that is not JSON.
    InvalidResponse,
    /// The method or path is not allowed.
    InvalidRequest,
}

impl RequestError {
    /// Stable codes the webview maps to text (`src/host/client.ts`).
    pub fn code(self) -> &'static str {
        match self {
            RequestError::Unreachable => "unreachable",
            RequestError::CertificateMismatch => "certificate_mismatch",
            RequestError::InvalidResponse => "invalid_response",
            RequestError::InvalidRequest => "invalid_request",
        }
    }
}

/// Credentials attached to one request.
#[derive(Debug, Clone, Copy, Default)]
pub struct Credentials<'a> {
    pub device_key: Option<&'a str>,
    pub office_token: Option<&'a str>,
}

#[derive(Debug, Clone)]
pub struct PinnedClient {
    client: reqwest::Client,
    address: String,
    mismatch: Arc<AtomicBool>,
}

impl PinnedClient {
    /// A client for `address` (`https://host:port`) that trusts only the
    /// certificate with this lower-case hex SHA-256 `fingerprint`.
    pub fn new(address: &str, fingerprint: &str) -> Result<Self, RequestError> {
        let mismatch = Arc::new(AtomicBool::new(false));
        let config = tls::client_config(FingerprintPolicy::Pin {
            expected: fingerprint.to_owned(),
            mismatch: mismatch.clone(),
        })
        .map_err(|_| RequestError::Unreachable)?;
        let client = reqwest::Client::builder()
            .use_preconfigured_tls(config)
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(REQUEST_TIMEOUT)
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| RequestError::Unreachable)?;
        Ok(Self {
            client,
            address: address.trim_end_matches('/').to_owned(),
            mismatch,
        })
    }

    pub async fn send(
        &self,
        method: &str,
        path: &str,
        body: Option<&Value>,
        credentials: Credentials<'_>,
    ) -> Result<HostResponse, RequestError> {
        let method = allowed_method(method)?;
        validate_path(path)?;
        let mut request = self
            .client
            .request(method, format!("{}{path}", self.address))
            .header(PROTOCOL_HEADER, PROTOCOL_VERSION.to_string());
        if let Some(key) = credentials.device_key {
            request = request.bearer_auth(key);
        }
        if let Some(token) = credentials.office_token {
            request = request.header(OFFICE_SESSION_HEADER, token);
        }
        if let Some(body) = body {
            request = request.json(body);
        }
        let response = match request.send().await {
            Ok(response) => response,
            Err(_) if self.mismatch.swap(false, Ordering::SeqCst) => {
                return Err(RequestError::CertificateMismatch)
            }
            Err(_) => return Err(RequestError::Unreachable),
        };
        let status = response.status().as_u16();
        let bytes = response
            .bytes()
            .await
            .map_err(|_| RequestError::Unreachable)?;
        let body = if bytes.is_empty() {
            None
        } else {
            Some(serde_json::from_slice(&bytes).map_err(|_| RequestError::InvalidResponse)?)
        };
        Ok(HostResponse { status, body })
    }
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

/// Only host API paths: `/v1/…` of plain URL characters, no traversal.
fn validate_path(path: &str) -> Result<(), RequestError> {
    let safe = path.starts_with("/v1/")
        && path.len() <= MAX_PATH_LENGTH
        && !path.contains("..")
        && !path.contains("//")
        && path
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"/_.~?=&%-".contains(&byte));
    if safe {
        Ok(())
    } else {
        Err(RequestError::InvalidRequest)
    }
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
            too_long.as_str(),
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
}
