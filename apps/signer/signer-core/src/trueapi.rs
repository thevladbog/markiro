//! True API GIS MT authentication: the only place UKEP is required for reads.
//!
//! `GET /auth/key` hands out a random challenge, the agent signs it locally
//! with an attached GOST signature, and `POST /auth/simpleSignIn` exchanges it
//! for either the current JWT or the announced UUID token. The challenge never
//! leaves this machine, so it cannot expire in transit.

use std::time::{Duration, SystemTime};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::Deserialize;

use crate::contracts::TokenFormat;
use crate::signer::Signer;
use crate::SignerError;

/// JWT fallback lifetime. The cloud refreshes 90 minutes before expiry;
/// reporting a slightly early expiry protects against clock skew with ГИС МТ.
const TOKEN_LIFETIME: Duration = Duration::from_secs(10 * 3600);
const TOKEN_SAFETY_MARGIN: Duration = Duration::from_secs(5 * 60);
const AUTH_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug)]
pub struct TrueApiToken {
    pub token: String,
    pub expires_at: String,
}

#[derive(Deserialize)]
struct AuthKeyResponse {
    uuid: String,
    data: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SignInResponse {
    #[serde(default)]
    token: Option<String>,
    #[serde(default)]
    uuid_token: Option<String>,
    #[serde(default)]
    expire_date: Option<String>,
}

#[derive(Deserialize)]
struct JwtClaims {
    exp: u64,
}

#[derive(serde::Serialize)]
struct SignInRequest<'a> {
    uuid: &'a str,
    data: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    inn: Option<&'a str>,
    #[serde(rename = "unitedToken", skip_serializing_if = "Option::is_none")]
    united_token: Option<bool>,
}

pub async fn obtain_token(
    http: &reqwest::Client,
    base_url: &str,
    inn: Option<&str>,
    token_format: TokenFormat,
    thumbprint: &str,
    signer: &dyn Signer,
) -> Result<TrueApiToken, SignerError> {
    let base = base_url.trim_end_matches('/');

    let key_response = http
        .get(format!("{base}/auth/key"))
        .timeout(AUTH_TIMEOUT)
        .send()
        .await
        .map_err(|e| SignerError::Network(e.to_string()))?;
    if !key_response.status().is_success() {
        return Err(SignerError::TrueApi(describe(key_response).await));
    }
    let challenge: AuthKeyResponse = key_response
        .json()
        .await
        .map_err(|e| SignerError::Protocol(e.to_string()))?;

    let signature = signer.sign_attached(thumbprint, challenge.data.as_bytes())?;

    let sign_in_response = http
        .post(format!("{base}/auth/simpleSignIn"))
        .timeout(AUTH_TIMEOUT)
        .json(&SignInRequest {
            uuid: &challenge.uuid,
            data: &signature,
            inn,
            united_token: (token_format == TokenFormat::Uuid).then_some(true),
        })
        .send()
        .await
        .map_err(|e| SignerError::Network(e.to_string()))?;
    if !sign_in_response.status().is_success() {
        return Err(SignerError::TrueApi(describe(sign_in_response).await));
    }
    let issued: SignInResponse = sign_in_response
        .json()
        .await
        .map_err(|e| SignerError::Protocol(e.to_string()))?;

    let (token, expires_at) = match token_format {
        TokenFormat::Jwt => {
            let token = required_field(issued.token, "token")?;
            let now = SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
            let expires_at = format_rfc3339(token_expiry_unix(&token, now));
            (token, expires_at)
        }
        TokenFormat::Uuid => (
            required_field(issued.uuid_token, "uuidToken")?,
            required_field(issued.expire_date, "expireDate")?,
        ),
    };

    Ok(TrueApiToken { token, expires_at })
}

fn required_field(value: Option<String>, name: &str) -> Result<String, SignerError> {
    match value.map(|value| value.trim().to_string()) {
        Some(value) if !value.is_empty() => Ok(value),
        _ => Err(SignerError::Protocol(format!(
            "True API response is missing {name}"
        ))),
    }
}

/// True API error bodies are passed through verbatim so the admin sees the real
/// cause (for example "нет действующего договора по товарной группе") instead
/// of a generic failure.
async fn describe(response: reqwest::Response) -> String {
    let status = response.status();
    match response.text().await {
        Ok(body) if !body.trim().is_empty() => {
            let trimmed: String = body.chars().take(1000).collect();
            format!("{status}: {trimmed}")
        }
        _ => status.to_string(),
    }
}

/// RFC3339 in UTC with a `Z` offset — the cloud's zod schema requires an
/// offset, and a naive timestamp is a 400. Computed without a date library:
/// the crate has no other need for one.
fn token_expiry_unix(token: &str, now: u64) -> u64 {
    let fallback = now + (TOKEN_LIFETIME - TOKEN_SAFETY_MARGIN).as_secs();
    let Some(payload) = token.split('.').nth(1) else {
        return fallback;
    };
    let Some(exp) = URL_SAFE_NO_PAD
        .decode(payload)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<JwtClaims>(&bytes).ok())
        .map(|claims| claims.exp)
    else {
        return fallback;
    };

    let safe_exp = exp.saturating_sub(TOKEN_SAFETY_MARGIN.as_secs()).max(now);
    safe_exp.min(fallback)
}

/// Shared with the Windows signer, which must render certificate validity in
/// the same RFC3339-with-offset shape the cloud contract requires.
pub fn format_rfc3339_public(unix_seconds: u64) -> String {
    format_rfc3339(unix_seconds)
}

fn format_rfc3339(unix_seconds: u64) -> String {
    let days = unix_seconds / 86_400;
    let rem = unix_seconds % 86_400;
    let (hour, minute, second) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let (year, month, day) = civil_from_days(days as i64);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.000Z")
}

/// Howard Hinnant's days-from-civil inverse, the standard branch-free
/// conversion used when pulling in chrono is not worth it.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts::TokenFormat;
    use crate::signer::{CertificateSummary, Signer};
    use wiremock::matchers::{body_json_string, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    struct FakeSigner {
        signature: &'static str,
    }

    impl Signer for FakeSigner {
        fn list_certificates(&self) -> Result<Vec<CertificateSummary>, SignerError> {
            Ok(vec![])
        }
        fn sign_attached(&self, _thumbprint: &str, payload: &[u8]) -> Result<String, SignerError> {
            assert_eq!(payload, b"challenge-data");
            Ok(self.signature.to_string())
        }
    }

    struct FailingSigner;
    impl Signer for FailingSigner {
        fn list_certificates(&self) -> Result<Vec<CertificateSummary>, SignerError> {
            Ok(vec![])
        }
        fn sign_attached(&self, _t: &str, _p: &[u8]) -> Result<String, SignerError> {
            Err(SignerError::PinRequired)
        }
    }

    async fn mount_auth(server: &MockServer, expected_body: &str) {
        mount_auth_response(server, expected_body, r#"{"token":"jwt-token"}"#).await;
    }

    async fn mount_auth_response(server: &MockServer, expected_body: &str, response_body: &str) {
        Mock::given(method("GET"))
            .and(path("/auth/key"))
            .respond_with(ResponseTemplate::new(200).set_body_string(
                r#"{"uuid":"u-1","data":"challenge-data"}"#,
            ))
            .mount(server)
            .await;
        Mock::given(method("POST"))
            .and(path("/auth/simpleSignIn"))
            .and(body_json_string(expected_body))
            .respond_with(ResponseTemplate::new(200).set_body_string(response_body.to_string()))
            .mount(server)
            .await;
    }

    #[tokio::test]
    async fn signs_the_challenge_and_returns_a_ten_hour_token() {
        let server = MockServer::start().await;
        mount_auth(&server, r#"{"uuid":"u-1","data":"signed-blob"}"#).await;
        let http = reqwest::Client::new();
        let signer = FakeSigner { signature: "signed-blob" };
        let token = obtain_token(&http, &server.uri(), None, TokenFormat::Jwt, "AB12", &signer)
            .await
            .unwrap();
        assert_eq!(token.token, "jwt-token");
        // Ten hours minus the safety margin, serialized with an offset because
        // the cloud's zod schema demands one.
        assert!(token.expires_at.ends_with('Z'), "got {}", token.expires_at);
    }

    #[tokio::test]
    async fn includes_the_inn_when_the_tenant_uses_an_mchd() {
        let server = MockServer::start().await;
        mount_auth(
            &server,
            r#"{"uuid":"u-1","data":"signed-blob","inn":"7712345678"}"#,
        )
        .await;
        let http = reqwest::Client::new();
        let signer = FakeSigner { signature: "signed-blob" };
        assert!(obtain_token(
            &http,
            &server.uri(),
            Some("7712345678"),
            TokenFormat::Jwt,
            "AB12",
            &signer,
        )
        .await
        .is_ok());
    }

    #[tokio::test]
    async fn surfaces_true_api_errors_verbatim() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/auth/key"))
            .respond_with(ResponseTemplate::new(403).set_body_string(
                r#"{"error_message":"Отсутствует действующий договор"}"#,
            ))
            .mount(&server)
            .await;
        let http = reqwest::Client::new();
        let signer = FakeSigner { signature: "x" };
        match obtain_token(&http, &server.uri(), None, TokenFormat::Jwt, "AB12", &signer).await {
            Err(SignerError::TrueApi(message)) => {
                assert!(message.contains("договор"), "got {message}");
            }
            other => panic!("expected a TrueApi error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn propagates_signing_failures_without_calling_sign_in() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/auth/key"))
            .respond_with(ResponseTemplate::new(200).set_body_string(
                r#"{"uuid":"u-1","data":"challenge-data"}"#,
            ))
            .mount(&server)
            .await;
        let http = reqwest::Client::new();
        match obtain_token(&http, &server.uri(), None, TokenFormat::Jwt, "AB12", &FailingSigner)
            .await
        {
            Err(SignerError::PinRequired) => {}
            other => panic!("expected PinRequired, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn requests_and_returns_a_uuid_token_with_the_provider_expiry() {
        let server = MockServer::start().await;
        mount_auth_response(
            &server,
            r#"{"uuid":"u-1","data":"signed-blob","inn":"7712345678","unitedToken":true}"#,
            r#"{"uuidToken":"uuid-token","expireDate":"2026-10-10T12:00:00.000Z"}"#,
        )
        .await;

        let token = obtain_token(
            &reqwest::Client::new(),
            &server.uri(),
            Some("7712345678"),
            TokenFormat::Uuid,
            "AB12",
            &FakeSigner {
                signature: "signed-blob",
            },
        )
        .await
        .unwrap();

        assert_eq!(token.token, "uuid-token");
        assert_eq!(token.expires_at, "2026-10-10T12:00:00.000Z");
    }

    #[tokio::test]
    async fn rejects_a_uuid_token_without_the_provider_expiry() {
        let server = MockServer::start().await;
        mount_auth_response(
            &server,
            r#"{"uuid":"u-1","data":"signed-blob","unitedToken":true}"#,
            r#"{"uuidToken":"uuid-token"}"#,
        )
        .await;

        match obtain_token(
            &reqwest::Client::new(),
            &server.uri(),
            None,
            TokenFormat::Uuid,
            "AB12",
            &FakeSigner {
                signature: "signed-blob",
            },
        )
        .await
        {
            Err(SignerError::Protocol(message)) => assert!(message.contains("expireDate")),
            other => panic!("expected Protocol, got {other:?}"),
        }
    }

    #[test]
    fn formats_a_known_instant_as_rfc3339_with_offset() {
        // 2026-08-28T12:00:00Z
        assert_eq!(format_rfc3339(1_787_918_400), "2026-08-28T12:00:00.000Z");
    }

    #[test]
    fn derives_expiry_from_the_jwt_exp_claim_with_a_safety_margin() {
        use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};

        let payload = URL_SAFE_NO_PAD.encode(r#"{"exp":1787950800}"#);
        let token = format!("e30.{payload}.signature");

        assert_eq!(token_expiry_unix(&token, 1_787_918_400), 1_787_950_500);
    }

    #[test]
    fn caps_an_implausibly_long_jwt_and_falls_back_for_an_opaque_token() {
        use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};

        let now = 1_787_918_400;
        let payload = URL_SAFE_NO_PAD.encode(r#"{"exp":1999999999}"#);
        let jwt = format!("e30.{payload}.signature");
        let fallback = now + (TOKEN_LIFETIME - TOKEN_SAFETY_MARGIN).as_secs();

        assert_eq!(token_expiry_unix(&jwt, now), fallback);
        assert_eq!(token_expiry_unix("opaque-future-token", now), fallback);
    }
}
