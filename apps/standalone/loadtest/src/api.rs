//! The HTTPS client of a simulated device or of the office: one TLS session
//! each, trusting exactly the host's certificate fingerprint as a paired
//! device does (the same pin as `src-tauri/src/tls.rs`: self-signed host,
//! trust only by SHA-256 fingerprint, aws-lc-rs selected explicitly), a 10 s
//! timeout as the station shell's client has, and every answer counted in
//! the run's metrics.

use std::sync::Arc;
use std::time::{Duration, Instant};

use reqwest::Method;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{verify_tls12_signature, verify_tls13_signature, CryptoProvider};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};
use serde_json::Value;

use crate::metrics::{error_class, Metrics, Route};

/// The station shell's own limit for a request to the host.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug)]
struct PinnedVerifier {
    expected: String,
    provider: Arc<CryptoProvider>,
}

impl ServerCertVerifier for PinnedVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        if markiro_proto::certificate_fingerprint(end_entity.as_ref()) == self.expected {
            Ok(ServerCertVerified::assertion())
        } else {
            Err(rustls::Error::General(
                "host certificate fingerprint mismatch".into(),
            ))
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

pub fn pinned_client(fingerprint: &str, timeout: Duration) -> reqwest::Client {
    let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
    let config = rustls::ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .expect("the default protocol versions")
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(PinnedVerifier {
            expected: fingerprint.to_owned(),
            provider,
        }))
        .with_no_client_auth();
    reqwest::Client::builder()
        .use_preconfigured_tls(config)
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(timeout)
        .build()
        .expect("a client")
}

/// A request that got no answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NetError {
    Timeout,
    Connect,
    Other(String),
}

impl NetError {
    pub fn class(&self) -> &'static str {
        match self {
            NetError::Timeout => "timeout",
            NetError::Connect => "connect",
            NetError::Other(_) => "other",
        }
    }
}

#[derive(Debug, Clone)]
pub struct Reply {
    pub status: u16,
    pub body: Value,
    pub micros: u64,
}

impl Reply {
    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }
}

/// The credentials of a request: a device key, and the office session when
/// the route is the office's.
#[derive(Debug, Clone, Copy, Default)]
pub struct Auth<'a> {
    pub device_key: Option<&'a str>,
    pub session: Option<&'a str>,
}

#[derive(Clone)]
pub struct Api {
    client: reqwest::Client,
    base: String,
    metrics: Arc<Metrics>,
}

impl Api {
    pub fn new(base: &str, fingerprint: &str, metrics: Arc<Metrics>) -> Api {
        Api {
            client: pinned_client(fingerprint, REQUEST_TIMEOUT),
            base: base.trim_end_matches('/').to_owned(),
            metrics,
        }
    }

    pub fn metrics(&self) -> &Arc<Metrics> {
        &self.metrics
    }

    /// `POST /v1/device/facts` with `records`: the receipts, in order. Any
    /// answer but a 200 with a receipt for each record is an error.
    pub async fn facts(&self, key: &str, records: &[Value]) -> Result<Vec<Value>, String> {
        let auth = Auth {
            device_key: Some(key),
            session: None,
        };
        let body = serde_json::json!({ "records": records });
        let reply = self
            .send(Route::Facts, "POST", "/v1/device/facts", auth, Some(&body))
            .await
            .map_err(|error| format!("facts: {error:?}"))?;
        let receipts = reply
            .body
            .get("receipts")
            .and_then(Value::as_array)
            .cloned();
        match receipts {
            Some(receipts) if reply.status == 200 && receipts.len() == records.len() => {
                Ok(receipts)
            }
            _ => Err(format!("facts: {} {}", reply.status, reply.body)),
        }
    }

    /// A long GET (the change stream): no 10 s limit, nothing counted.
    pub async fn open_stream(
        &self,
        path: &str,
        auth: Auth<'_>,
    ) -> Result<reqwest::Response, NetError> {
        let mut request = self
            .client
            .get(format!("{}{path}", self.base))
            .timeout(Duration::from_secs(24 * 3600))
            .header(
                markiro_proto::PROTOCOL_HEADER,
                markiro_proto::PROTOCOL_VERSION.to_string(),
            );
        if let Some(key) = auth.device_key {
            request = request.header("authorization", format!("Bearer {key}"));
        }
        request.send().await.map_err(|error| {
            if error.is_connect() {
                NetError::Connect
            } else {
                NetError::Other(error.without_url().to_string())
            }
        })
    }

    /// One request. A network failure is counted and returned; an answer of
    /// any status is counted by class and returned for the caller to judge.
    pub async fn send(
        &self,
        route: Route,
        method: &str,
        path: &str,
        auth: Auth<'_>,
        body: Option<&Value>,
    ) -> Result<Reply, NetError> {
        let method = Method::from_bytes(method.as_bytes()).expect("an HTTP method");
        let mut request = self
            .client
            .request(method, format!("{}{path}", self.base))
            .header(
                markiro_proto::PROTOCOL_HEADER,
                markiro_proto::PROTOCOL_VERSION.to_string(),
            );
        if let Some(key) = auth.device_key {
            request = request.header("authorization", format!("Bearer {key}"));
        }
        if let Some(session) = auth.session {
            request = request.header(markiro_proto::OFFICE_SESSION_HEADER, session);
        }
        if let Some(body) = body {
            request = request.json(body);
        }
        let started = Instant::now();
        let outcome = async {
            let response = request.send().await?;
            let status = response.status().as_u16();
            let bytes = response.bytes().await?;
            Ok::<_, reqwest::Error>((status, bytes))
        }
        .await;
        let micros = started.elapsed().as_micros() as u64;
        match outcome {
            Ok((status, bytes)) => {
                let body = if bytes.is_empty() {
                    Value::Null
                } else {
                    serde_json::from_slice(&bytes).unwrap_or(Value::Null)
                };
                self.metrics.record(route, micros);
                if let Some(class) = error_class(Some(status), &body, None) {
                    self.metrics.error(route, &class);
                }
                Ok(Reply {
                    status,
                    body,
                    micros,
                })
            }
            Err(error) => {
                let net = if error.is_timeout() {
                    NetError::Timeout
                } else if error.is_connect() {
                    NetError::Connect
                } else {
                    NetError::Other(error.without_url().to_string())
                };
                if net == NetError::Timeout {
                    // A timeout is a latency of the whole limit, or p99 would hide it.
                    self.metrics.record(route, micros);
                }
                self.metrics.error(route, net.class());
                Err(net)
            }
        }
    }
}
