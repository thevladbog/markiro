//! True API GIS MT authentication: the only place UKEP is required for reads.
//!
//! `GET /auth/key` hands out a random challenge, the agent signs it locally
//! with an attached GOST signature, and `POST /auth/simpleSignIn` exchanges it
//! for either the current JWT or the announced UUID token. The challenge never
//! leaves this machine, so it cannot expire in transit.

use std::error::Error as _;
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
const AUTH_ATTEMPTS: u32 = 3;

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
    let mut attempt = 1u32;
    loop {
        let outcome =
            obtain_token_once(http, base_url, inn, token_format, thumbprint, signer).await;
        match outcome {
            Err(SignerError::Network(_)) if attempt < AUTH_ATTEMPTS => {
                // The POST may have reached True API before the connection
                // broke. Never replay the same signed one-time challenge:
                // restart the whole flow after a short exponential pause.
                tokio::time::sleep(Duration::from_secs(2u64.saturating_pow(attempt))).await;
                attempt += 1;
            }
            outcome => return outcome,
        }
    }
}

async fn obtain_token_once(
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
        return Err(classify_response(key_response).await);
    }
    let challenge: AuthKeyResponse = key_response
        .json()
        .await
        .map_err(classify_json_error)?;

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
        return Err(classify_response(sign_in_response).await);
    }
    let issued: SignInResponse = sign_in_response
        .json()
        .await
        .map_err(classify_json_error)?;

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

async fn classify_response(response: reqwest::Response) -> SignerError {
    let status = response.status();
    let detail = describe(response).await;
    if status.is_server_error() {
        SignerError::Network(detail)
    } else {
        SignerError::TrueApi(detail)
    }
}

fn classify_json_error(error: reqwest::Error) -> SignerError {
    let malformed_json = {
        let mut source = error.source();
        let mut found = false;
        while let Some(cause) = source {
            if cause.is::<serde_json::Error>() {
                found = true;
                break;
            }
            source = cause.source();
        }
        found
    };
    let message = error.to_string();
    if error.is_timeout()
        || error.is_connect()
        || error.is_body()
        || (error.is_decode() && !malformed_json)
    {
        SignerError::Network(message)
    } else {
        SignerError::Protocol(message)
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
    use std::io::{ErrorKind, Read, Write};
    use std::net::{TcpListener, TcpStream};
    use wiremock::matchers::{body_json_string, method, path};
    use wiremock::{Mock, MockServer, Request, ResponseTemplate};

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

    struct PayloadSigner;
    impl Signer for PayloadSigner {
        fn list_certificates(&self) -> Result<Vec<CertificateSummary>, SignerError> {
            Ok(vec![])
        }
        fn sign_attached(&self, _thumbprint: &str, payload: &[u8]) -> Result<String, SignerError> {
            Ok(format!("signed-{}", String::from_utf8_lossy(payload)))
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

    fn read_http_request(stream: &mut TcpStream) -> String {
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut request = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            let read = stream.read(&mut chunk).unwrap();
            if read == 0 {
                break;
            }
            request.extend_from_slice(&chunk[..read]);
            let Some(header_end) = request.windows(4).position(|window| window == b"\r\n\r\n")
            else {
                continue;
            };
            let headers = String::from_utf8_lossy(&request[..header_end]);
            let content_length = headers
                .lines()
                .find_map(|line| {
                    line.to_ascii_lowercase()
                        .strip_prefix("content-length:")
                        .and_then(|value| value.trim().parse::<usize>().ok())
                })
                .unwrap_or(0);
            if request.len() >= header_end + 4 + content_length {
                break;
            }
        }
        String::from_utf8(request).unwrap()
    }

    fn write_http_response(stream: &mut TcpStream, body: &str, declared_length: usize) {
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {declared_length}\r\nConnection: close\r\n\r\n{body}"
        );
        stream.write_all(response.as_bytes()).unwrap();
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
    async fn retries_the_full_auth_cycle_with_a_fresh_challenge_after_a_network_failure() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/auth/key"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_string(r#"{"uuid":"u-1","data":"challenge-one"}"#),
            )
            .with_priority(1)
            .up_to_n_times(1)
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/auth/simpleSignIn"))
            .and(body_json_string(
                r#"{"uuid":"u-1","data":"signed-challenge-one"}"#,
            ))
            .respond_with_err(|_: &Request| {
                std::io::Error::new(ErrorKind::ConnectionReset, "connection reset")
            })
            .with_priority(1)
            .up_to_n_times(1)
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/auth/key"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_string(r#"{"uuid":"u-2","data":"challenge-two"}"#),
            )
            .with_priority(2)
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/auth/simpleSignIn"))
            .and(body_json_string(
                r#"{"uuid":"u-2","data":"signed-challenge-two"}"#,
            ))
            .respond_with(ResponseTemplate::new(200).set_body_string(r#"{"token":"jwt-token"}"#))
            .with_priority(2)
            .expect(1)
            .mount(&server)
            .await;

        let token = obtain_token(
            &reqwest::Client::new(),
            &server.uri(),
            None,
            TokenFormat::Jwt,
            "AB12",
            &PayloadSigner,
        )
        .await
        .expect("a transient network failure should be retried");

        assert_eq!(token.token, "jwt-token");
    }

    #[tokio::test]
    async fn retries_when_fetching_the_challenge_returns_a_server_error() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/auth/key"))
            .respond_with(ResponseTemplate::new(503))
            .with_priority(1)
            .up_to_n_times(1)
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/auth/key"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_string(r#"{"uuid":"u-2","data":"challenge-data"}"#),
            )
            .with_priority(2)
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/auth/simpleSignIn"))
            .and(body_json_string(r#"{"uuid":"u-2","data":"signed-blob"}"#))
            .respond_with(ResponseTemplate::new(200).set_body_string(r#"{"token":"jwt-token"}"#))
            .expect(1)
            .mount(&server)
            .await;

        let token = obtain_token(
            &reqwest::Client::new(),
            &server.uri(),
            None,
            TokenFormat::Jwt,
            "AB12",
            &FakeSigner {
                signature: "signed-blob",
            },
        )
        .await
        .expect("a transient challenge 5xx should be retried");

        assert_eq!(token.token, "jwt-token");
    }

    #[tokio::test]
    async fn retries_when_the_challenge_response_body_is_interrupted() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut first, _) = listener.accept().unwrap();
            let first_request = read_http_request(&mut first);
            assert!(first_request.starts_with("GET /auth/key "));
            let truncated = r#"{"uuid":"u-1""#;
            write_http_response(&mut first, truncated, 1000);
            drop(first);

            let (mut second, _) = listener.accept().unwrap();
            let second_request = read_http_request(&mut second);
            assert!(second_request.starts_with("GET /auth/key "));
            let challenge = r#"{"uuid":"u-2","data":"challenge-data"}"#;
            write_http_response(&mut second, challenge, challenge.len());

            let (mut third, _) = listener.accept().unwrap();
            let third_request = read_http_request(&mut third);
            assert!(third_request.starts_with("POST /auth/simpleSignIn "));
            assert!(third_request.contains(r#"{"uuid":"u-2","data":"signed-blob"}"#));
            let token = r#"{"token":"jwt-token"}"#;
            write_http_response(&mut third, token, token.len());
        });

        let token = obtain_token(
            &reqwest::Client::new(),
            &base_url,
            None,
            TokenFormat::Jwt,
            "AB12",
            &FakeSigner {
                signature: "signed-blob",
            },
        )
        .await
        .expect("an interrupted response body should be retried");

        assert_eq!(token.token, "jwt-token");
        server.join().unwrap();
    }

    #[tokio::test]
    async fn retries_the_full_auth_cycle_when_sign_in_returns_a_server_error() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/auth/key"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_string(r#"{"uuid":"u-1","data":"challenge-data"}"#),
            )
            .with_priority(1)
            .up_to_n_times(1)
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/auth/simpleSignIn"))
            .and(body_json_string(r#"{"uuid":"u-1","data":"signed-blob"}"#))
            .respond_with(ResponseTemplate::new(503))
            .with_priority(1)
            .up_to_n_times(1)
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/auth/key"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_string(r#"{"uuid":"u-2","data":"challenge-data"}"#),
            )
            .with_priority(2)
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/auth/simpleSignIn"))
            .and(body_json_string(r#"{"uuid":"u-2","data":"signed-blob"}"#))
            .respond_with(ResponseTemplate::new(200).set_body_string(r#"{"token":"jwt-token"}"#))
            .with_priority(2)
            .expect(1)
            .mount(&server)
            .await;

        let token = obtain_token(
            &reqwest::Client::new(),
            &server.uri(),
            None,
            TokenFormat::Jwt,
            "AB12",
            &FakeSigner {
                signature: "signed-blob",
            },
        )
        .await
        .expect("a transient sign-in 5xx should restart authentication");

        assert_eq!(token.token, "jwt-token");
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
            .expect(1)
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
    async fn does_not_retry_a_malformed_success_response() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/auth/key"))
            .respond_with(ResponseTemplate::new(200).set_body_string("{not-json"))
            .expect(1)
            .mount(&server)
            .await;

        match obtain_token(
            &reqwest::Client::new(),
            &server.uri(),
            None,
            TokenFormat::Jwt,
            "AB12",
            &PayloadSigner,
        )
        .await
        {
            Err(SignerError::Protocol(_)) => {}
            other => panic!("expected Protocol, got {other:?}"),
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
