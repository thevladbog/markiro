//! `GET /v1/hello` against an address whose certificate is not pinned yet.
//! The verifier accepts any certificate and records its fingerprint, so this
//! module only *discovers* a host: the fingerprint is shown to a person or
//! compared with a scanned pairing code before anything is trusted.
//! Authenticated requests use a pinning verifier (plan 1c).

use std::sync::{Arc, Mutex};
use std::time::Duration;

use markiro_proto::{
    compatibility, Compatibility, Hello, HelloEnvelope, HOST_PRODUCT, PROTOCOL_HEADER,
    PROTOCOL_VERSION,
};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{verify_tls12_signature, verify_tls13_signature, CryptoProvider};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};
use serde::Serialize;

const PROBE_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HelloObservation {
    pub hello: Hello,
    /// Lower-case hex SHA-256 of the certificate the host presented.
    pub fingerprint: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProbeError {
    /// Nothing answered, or the TLS handshake failed.
    Unreachable,
    /// Something answered, but it is not a Markiro host.
    NotMarkiroHost,
    /// A Markiro host answered with a body this build cannot read.
    InvalidResponse,
    /// The host speaks an older protocol than this app: update the host.
    HostTooOld,
    /// This app is older than the host accepts: update the app.
    AppTooOld,
}

impl ProbeError {
    /// Stable codes the webview maps to text (`src/host/probe.ts`).
    pub fn code(self) -> &'static str {
        match self {
            ProbeError::Unreachable => "unreachable",
            ProbeError::NotMarkiroHost => "not_markiro_host",
            ProbeError::InvalidResponse => "invalid_response",
            ProbeError::HostTooOld => "host_too_old",
            ProbeError::AppTooOld => "app_too_old",
        }
    }
}

pub async fn observe_hello(address: &str) -> Result<HelloObservation, ProbeError> {
    let seen = Arc::new(Mutex::new(None::<String>));
    let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
    let config = rustls::ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .map_err(|_| ProbeError::Unreachable)?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(ObservingVerifier {
            seen: seen.clone(),
            provider,
        }))
        .with_no_client_auth();
    let client = reqwest::Client::builder()
        .use_preconfigured_tls(config)
        .timeout(PROBE_TIMEOUT)
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| ProbeError::Unreachable)?;
    let response = client
        .get(format!("{}/v1/hello", address.trim_end_matches('/')))
        .header(PROTOCOL_HEADER, PROTOCOL_VERSION.to_string())
        .send()
        .await
        .map_err(|_| ProbeError::Unreachable)?;
    if !response.status().is_success() {
        return Err(ProbeError::NotMarkiroHost);
    }
    let body: serde_json::Value = response
        .json()
        .await
        .map_err(|_| ProbeError::NotMarkiroHost)?;
    let hello = classify_hello(body)?;
    let fingerprint = seen
        .lock()
        .expect("fingerprint lock")
        .clone()
        .ok_or(ProbeError::Unreachable)?;
    Ok(HelloObservation { hello, fingerprint })
}

/// Classify a `/v1/hello` response body: foreign service, incompatible
/// protocol, unreadable body, or a usable `Hello`.
pub fn classify_hello(body: serde_json::Value) -> Result<Hello, ProbeError> {
    let envelope: HelloEnvelope =
        serde_json::from_value(body.clone()).map_err(|_| ProbeError::NotMarkiroHost)?;
    if envelope.product != HOST_PRODUCT {
        return Err(ProbeError::NotMarkiroHost);
    }
    match compatibility(&envelope) {
        Compatibility::Compatible => {}
        Compatibility::HostTooOld => return Err(ProbeError::HostTooOld),
        Compatibility::AppTooOld => return Err(ProbeError::AppTooOld),
    }
    serde_json::from_value(body).map_err(|_| ProbeError::InvalidResponse)
}

#[derive(Debug)]
struct ObservingVerifier {
    seen: Arc<Mutex<Option<String>>>,
    provider: Arc<CryptoProvider>,
}

impl ServerCertVerifier for ObservingVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let fingerprint = markiro_proto::certificate_fingerprint(end_entity.as_ref());
        *self.seen.lock().expect("fingerprint lock") = Some(fingerprint);
        Ok(ServerCertVerified::assertion())
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_foreign_body_is_not_a_markiro_host() {
        assert_eq!(
            classify_hello(json!({"status": "ok"})),
            Err(ProbeError::NotMarkiroHost)
        );
    }

    #[test]
    fn a_wrong_product_is_not_a_markiro_host() {
        assert_eq!(
            classify_hello(json!({"product": "other", "protocol": 1, "minProtocol": 1})),
            Err(ProbeError::NotMarkiroHost)
        );
    }

    #[test]
    fn a_host_older_than_this_app_is_rejected() {
        assert_eq!(
            classify_hello(json!({"product": HOST_PRODUCT, "protocol": 0, "minProtocol": 0})),
            Err(ProbeError::HostTooOld)
        );
    }

    #[test]
    fn an_app_older_than_the_host_accepts_is_rejected() {
        assert_eq!(
            classify_hello(json!({"product": HOST_PRODUCT, "protocol": 9, "minProtocol": 5})),
            Err(ProbeError::AppTooOld)
        );
    }

    #[test]
    fn a_compatible_envelope_with_an_unreadable_body_is_invalid() {
        assert_eq!(
            classify_hello(json!({"product": HOST_PRODUCT, "protocol": 1, "minProtocol": 1})),
            Err(ProbeError::InvalidResponse)
        );
    }

    #[test]
    fn a_compatible_hello_is_read() {
        let hello = classify_hello(json!({
            "product": "markiro-host",
            "protocol": 1,
            "minProtocol": 1,
            "hostId": "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
            "version": "0.1.0",
            "time": "2026-09-26T09:15:00Z",
            "initialized": false
        }))
        .unwrap();
        assert_eq!(hello.host_id, "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f");
    }
}
