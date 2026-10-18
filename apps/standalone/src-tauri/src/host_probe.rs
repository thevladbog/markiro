//! `GET /v1/hello` against an address whose certificate is not pinned yet.
//! The verifier accepts any certificate and records its fingerprint, so this
//! module only *discovers* a host: the fingerprint is shown to a person or
//! compared with a scanned pairing code before anything is trusted.
//! Authenticated requests use `host_client`, which pins the fingerprint saved
//! at pairing.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use markiro_proto::{
    compatibility, Compatibility, Hello, HelloEnvelope, HOST_PRODUCT, PROTOCOL_HEADER,
    PROTOCOL_VERSION,
};
use serde::Serialize;

use crate::tls::{self, FingerprintPolicy};

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

/// The protocol range and the version a Markiro host's `hello` names, read
/// whatever its protocol (plan ОБН-2): an update compares them with the
/// package, while [`observe_hello`] refuses a host this build cannot talk to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostVersions {
    pub version: Option<String>,
    pub protocol: u32,
    pub min_protocol: u32,
}

/// [`HostVersions`] of a `hello` body; another service is `NotMarkiroHost`.
pub fn read_versions(body: &serde_json::Value) -> Result<HostVersions, ProbeError> {
    let envelope: HelloEnvelope =
        serde_json::from_value(body.clone()).map_err(|_| ProbeError::NotMarkiroHost)?;
    if envelope.product != HOST_PRODUCT {
        return Err(ProbeError::NotMarkiroHost);
    }
    Ok(HostVersions {
        version: body
            .get("version")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
        protocol: envelope.protocol,
        min_protocol: envelope.min_protocol,
    })
}

/// The versions of the host at `address`, without trusting its certificate:
/// a number to compare, not a credential (spec §10.7).
pub async fn host_versions(address: &str) -> Result<HostVersions, ProbeError> {
    let (body, _) = fetch_hello(address).await?;
    read_versions(&body)
}

/// The versions of the host at `address` read through the connection pinned
/// to `fingerprint` (the paired host's certificate): a host that rolled back
/// cannot be told from the real one by a stranger on the LAN who answers
/// `hello`. A certificate that is not the paired one is `Unreachable`.
pub async fn pinned_host_versions(
    address: &str,
    fingerprint: &str,
) -> Result<HostVersions, ProbeError> {
    let client = crate::host_client::PinnedClient::new(address, fingerprint)
        .map_err(|_| ProbeError::Unreachable)?;
    let answer = client
        .send(
            "GET",
            "/v1/hello",
            None,
            crate::host_client::Credentials {
                device_key: None,
                office_token: None,
                dataset_epoch: None,
            },
        )
        .await
        .map_err(|_| ProbeError::Unreachable)?;
    match (answer.status, answer.body) {
        (200..=299, Some(body)) => read_versions(&body),
        _ => Err(ProbeError::NotMarkiroHost),
    }
}

pub async fn observe_hello(address: &str) -> Result<HelloObservation, ProbeError> {
    let (body, fingerprint) = fetch_hello(address).await?;
    let hello = classify_hello(body)?;
    let fingerprint = fingerprint.ok_or(ProbeError::Unreachable)?;
    Ok(HelloObservation { hello, fingerprint })
}

/// `GET /v1/hello` at `address` through the observing verifier: the body and
/// the fingerprint of the certificate the host presented.
async fn fetch_hello(address: &str) -> Result<(serde_json::Value, Option<String>), ProbeError> {
    let seen = Arc::new(Mutex::new(None::<String>));
    let config = tls::client_config(FingerprintPolicy::Observe(seen.clone()))
        .map_err(|_| ProbeError::Unreachable)?;
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
    let fingerprint = seen.lock().expect("fingerprint lock").clone();
    Ok((body, fingerprint))
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
        // A host of stage 1 speaks protocol 1 only, a host of stage 2a up to
        // 2, a host of pallets (plan ПЛ-Х) up to 3, a host of shift modes
        // (plan РЕЖ part A) up to 4: a station that knows the duplicate print
        // (protocol 5, part B) asks for an update of the host.
        assert_eq!(
            classify_hello(json!({"product": HOST_PRODUCT, "protocol": 1, "minProtocol": 1})),
            Err(ProbeError::HostTooOld)
        );
        assert_eq!(
            classify_hello(json!({"product": HOST_PRODUCT, "protocol": 2, "minProtocol": 1})),
            Err(ProbeError::HostTooOld)
        );
        assert_eq!(
            classify_hello(json!({"product": HOST_PRODUCT, "protocol": 3, "minProtocol": 1})),
            Err(ProbeError::HostTooOld)
        );
        assert_eq!(
            classify_hello(json!({"product": HOST_PRODUCT, "protocol": 4, "minProtocol": 1})),
            Err(ProbeError::HostTooOld)
        );
    }

    #[test]
    fn an_app_older_than_the_host_accepts_is_rejected() {
        assert_eq!(
            classify_hello(json!({"product": HOST_PRODUCT, "protocol": 9, "minProtocol": 7})),
            Err(ProbeError::AppTooOld)
        );
    }

    #[test]
    fn a_compatible_envelope_with_an_unreadable_body_is_invalid() {
        assert_eq!(
            classify_hello(
                json!({"product": HOST_PRODUCT, "protocol": PROTOCOL_VERSION, "minProtocol": 1})
            ),
            Err(ProbeError::InvalidResponse)
        );
    }

    #[test]
    fn the_versions_of_any_markiro_host_are_read() {
        // A host this build could not talk to still names its versions.
        assert_eq!(
            read_versions(&json!({
                "product": HOST_PRODUCT, "protocol": 9, "minProtocol": 6, "version": "0.9.0"
            })),
            Ok(HostVersions {
                version: Some("0.9.0".into()),
                protocol: 9,
                min_protocol: 6
            })
        );
        assert_eq!(
            read_versions(&json!({ "product": HOST_PRODUCT, "protocol": 3, "minProtocol": 1 })),
            Ok(HostVersions {
                version: None,
                protocol: 3,
                min_protocol: 1
            })
        );
        for body in [
            json!({ "product": "other", "protocol": 3, "minProtocol": 1 }),
            json!({ "status": "ok" }),
        ] {
            assert_eq!(read_versions(&body), Err(ProbeError::NotMarkiroHost));
        }
    }

    #[test]
    fn a_compatible_hello_is_read() {
        let hello = classify_hello(json!({
            "product": "markiro-host",
            "protocol": PROTOCOL_VERSION,
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
