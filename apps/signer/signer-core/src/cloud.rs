//! Client for the Markiro cloud half of the signer protocol.
//!
//! Route shapes are taken from the shipped controllers, not the design spec:
//! the agent-facing prefix is singular (`/signer-agent/…`), pairing answers
//! 201, report calls answer 204, and an idle long poll is `200 {"task": null}`.

use std::time::Duration;

use reqwest::{Client, StatusCode};

use crate::contracts::{NextTaskResponse, PairRequest, PairResponse, SignerTask, TaskComplete, TaskFail};
use crate::SignerError;

/// Long polls hold for up to 25 s server-side; allow headroom before the
/// transport gives up so a healthy idle poll is never mistaken for a failure.
const POLL_TIMEOUT_SLACK: Duration = Duration::from_secs(20);
const REPORT_TIMEOUT: Duration = Duration::from_secs(30);

/// The server rejects a larger `wait`, so the cap belongs here once: both the
/// query string and the client deadline derive from it.
const MAX_POLL_WAIT_MS: u32 = 25_000;

/// The client-side deadline for a long poll: the server holds for at most
/// `wait_ms` milliseconds (capped at 25 s), plus slack so a healthy idle poll
/// is never mistaken for a stuck connection.
fn poll_timeout(wait_ms: u32) -> Duration {
    Duration::from_millis(u64::from(wait_ms.min(MAX_POLL_WAIT_MS))) + POLL_TIMEOUT_SLACK
}

/// Pairing has exactly two outcomes worth distinguishing in the UI: the cloud
/// refused the code (wrong, expired, used, or rate-limited — it deliberately
/// does not say which), or we never reached it.
#[derive(Debug)]
pub enum PairError {
    Rejected,
    Network(String),
}

pub struct CloudClient {
    base_url: String,
    app_version: String,
    http: Client,
}

impl CloudClient {
    pub fn new(base_url: &str, app_version: &str) -> Result<Self, SignerError> {
        let http = Client::builder()
            .user_agent(format!("markiro-signer/{app_version}"))
            .build()
            .map_err(|e| SignerError::Network(e.to_string()))?;
        Ok(Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            app_version: app_version.to_string(),
            http,
        })
    }

    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base_url)
    }

    pub async fn pair(&self, code: &str, hostname: &str) -> Result<PairResponse, PairError> {
        let body = PairRequest {
            pairing_code: code.to_string(),
            hostname: hostname.to_string(),
            app_version: self.app_version.clone(),
        };
        let response = self
            .http
            .post(self.url("/signer-agent/pair"))
            .timeout(REPORT_TIMEOUT)
            .json(&body)
            .send()
            .await
            .map_err(|e| PairError::Network(e.to_string()))?;
        if !response.status().is_success() {
            // 400 and 401 are both "this code will not work"; the cloud does not
            // distinguish wrong from expired from rate-limited on purpose.
            match response.status() {
                StatusCode::BAD_REQUEST | StatusCode::UNAUTHORIZED => return Err(PairError::Rejected),
                status => return Err(PairError::Network(format!("server returned {status}"))),
            }
        }
        response
            .json::<PairResponse>()
            .await
            .map_err(|e| PairError::Network(e.to_string()))
    }

    pub async fn poll(&self, secret: &str, wait_ms: u32) -> Result<Option<SignerTask>, SignerError> {
        let wait_capped = wait_ms.min(MAX_POLL_WAIT_MS);
        let url = format!("{}?wait={}", self.url("/signer-agent/tasks/next"), wait_capped);
        let response = self
            .http
            .get(&url)
            .header("x-signer-token", secret)
            .timeout(poll_timeout(wait_capped))
            .send()
            .await
            .map_err(|e| SignerError::Network(e.to_string()))?;
        match response.status() {
            StatusCode::UNAUTHORIZED => Err(SignerError::Revoked),
            status if status.is_success() => response
                .json::<NextTaskResponse>()
                .await
                .map(|body| body.task)
                .map_err(|e| SignerError::Protocol(e.to_string())),
            status => Err(SignerError::Protocol(format!("poll answered {status}"))),
        }
    }

    pub async fn complete(
        &self,
        secret: &str,
        task_id: &str,
        body: &TaskComplete,
    ) -> Result<(), SignerError> {
        self.report(secret, &format!("/signer-agent/tasks/{task_id}/complete"), body)
            .await
    }

    pub async fn fail(
        &self,
        secret: &str,
        task_id: &str,
        body: &TaskFail,
    ) -> Result<(), SignerError> {
        self.report(secret, &format!("/signer-agent/tasks/{task_id}/fail"), body)
            .await
    }

    async fn report<T: serde::Serialize>(
        &self,
        secret: &str,
        path: &str,
        body: &T,
    ) -> Result<(), SignerError> {
        let response = self
            .http
            .post(self.url(path))
            .header("x-signer-token", secret)
            .timeout(REPORT_TIMEOUT)
            .json(body)
            .send()
            .await
            .map_err(|e| SignerError::Network(e.to_string()))?;
        match response.status() {
            StatusCode::UNAUTHORIZED => Err(SignerError::Revoked),
            // 404 means the claim is gone: expired past the 30-minute deadline,
            // already reported, or claimed by another agent. Nothing to retry.
            StatusCode::NOT_FOUND => Err(SignerError::Protocol(
                "the task is no longer claimed by this agent".to_string(),
            )),
            // 503 means the cloud has no encryption key configured; it will also
            // stop enqueueing, so backing off is the only sane response.
            StatusCode::SERVICE_UNAVAILABLE => Err(SignerError::Network(
                "the cloud cannot store tokens right now".to_string(),
            )),
            status if status.is_success() => Ok(()),
            status => Err(SignerError::Protocol(format!("report answered {status}"))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts::SignerErrorCode;
    use wiremock::matchers::{body_json_string, header, method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn pairs_and_returns_the_one_time_secret() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/signer-agent/pair"))
            .and(body_json_string(
                r#"{"pairingCode":"01234567","hostname":"BUH-PC","appVersion":"0.1.0"}"#,
            ))
            .respond_with(ResponseTemplate::new(201).set_body_string(
                r#"{"agentId":"3f0e0f5e-8d1c-4d7a-9b1a-111111111111",
                    "agentSecret":"example-agent-secret-not-a-real-credential",
                    "tenantName":"ООО Ромашка"}"#,
            ))
            .mount(&server)
            .await;

        let client = CloudClient::new(&server.uri(), "0.1.0").unwrap();
        let res = client.pair("01234567", "BUH-PC").await.unwrap();
        assert_eq!(res.tenant_name, "ООО Ромашка");
    }

    #[tokio::test]
    async fn maps_a_rejected_pairing_to_rejected_not_network() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/signer-agent/pair"))
            .respond_with(ResponseTemplate::new(401))
            .mount(&server)
            .await;
        let client = CloudClient::new(&server.uri(), "0.1.0").unwrap();
        assert!(matches!(
            client.pair("00000000", "PC").await,
            Err(PairError::Rejected)
        ));
    }

    #[tokio::test]
    async fn poll_sends_the_raw_secret_header_and_decodes_a_task() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/signer-agent/tasks/next"))
            .and(query_param("wait", "25000"))
            .and(header("x-signer-token", "s3cret"))
            .respond_with(ResponseTemplate::new(200).set_body_string(
                r#"{"task":{"id":"3f0e0f5e-8d1c-4d7a-9b1a-222222222222",
                    "type":"true_api_auth",
                    "payload":{"trueApiBaseUrl":"https://markirovka.sandbox.crptech.ru/api/v3/true-api"}}}"#,
            ))
            .mount(&server)
            .await;
        let client = CloudClient::new(&server.uri(), "0.1.0").unwrap();
        let task = client.poll("s3cret", 25_000).await.unwrap().unwrap();
        assert_eq!(task.task_type, "true_api_auth");
    }

    #[tokio::test]
    async fn an_idle_poll_is_none_not_an_error() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/signer-agent/tasks/next"))
            .respond_with(ResponseTemplate::new(200).set_body_string(r#"{"task":null}"#))
            .mount(&server)
            .await;
        let client = CloudClient::new(&server.uri(), "0.1.0").unwrap();
        assert!(client.poll("s3cret", 0).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn a_401_on_poll_is_revocation() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/signer-agent/tasks/next"))
            .respond_with(ResponseTemplate::new(401))
            .mount(&server)
            .await;
        let client = CloudClient::new(&server.uri(), "0.1.0").unwrap();
        assert!(matches!(client.poll("s3cret", 0).await, Err(SignerError::Revoked)));
    }

    #[tokio::test]
    async fn complete_accepts_204_and_reports_404_as_protocol() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/signer-agent/tasks/t1/complete"))
            .respond_with(ResponseTemplate::new(204))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/signer-agent/tasks/t2/complete"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;
        let client = CloudClient::new(&server.uri(), "0.1.0").unwrap();
        let body = TaskComplete {
            token: "t".into(),
            expires_at: "2026-08-28T20:00:00.000Z".into(),
            cert_thumbprint: "AB".into(),
            cert_subject: None,
            cert_inn: None,
            cert_not_after: None,
        };
        assert!(client.complete("s", "t1", &body).await.is_ok());
        assert!(matches!(
            client.complete("s", "t2", &body).await,
            Err(SignerError::Protocol(_))
        ));
    }

    #[tokio::test]
    async fn fail_posts_the_error_envelope() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/signer-agent/tasks/t1/fail"))
            .and(body_json_string(
                r#"{"errorCode":"CRYPTO_PIN_REQUIRED","message":"PIN prompt pending"}"#,
            ))
            .respond_with(ResponseTemplate::new(204))
            .mount(&server)
            .await;
        let client = CloudClient::new(&server.uri(), "0.1.0").unwrap();
        let body = TaskFail::new(SignerErrorCode::CryptoPinRequired, "  PIN prompt pending  ");
        assert!(client.fail("s", "t1", &body).await.is_ok());
    }

    #[tokio::test]
    async fn poll_with_large_wait_ms_caps_to_25000_in_query_string() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/signer-agent/tasks/next"))
            .and(query_param("wait", "25000"))
            .respond_with(ResponseTemplate::new(200).set_body_string(r#"{"task":null}"#))
            .mount(&server)
            .await;
        let client = CloudClient::new(&server.uri(), "0.1.0").unwrap();
        assert!(client.poll("s3cret", 60_000).await.unwrap().is_none());
    }

    #[test]
    fn the_poll_timeout_never_exceeds_the_server_hold_plus_slack() {
        // Under the cap the deadline tracks the requested wait.
        assert_eq!(
            poll_timeout(5_000),
            Duration::from_millis(5_000) + POLL_TIMEOUT_SLACK
        );
        // Over the cap it must clamp to the 25 s the server actually holds --
        // this is the case the earlier bug got wrong.
        assert_eq!(
            poll_timeout(60_000),
            Duration::from_millis(25_000) + POLL_TIMEOUT_SLACK
        );
    }

    #[tokio::test]
    async fn pair_against_500_returns_network_error() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/signer-agent/pair"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&server)
            .await;
        let client = CloudClient::new(&server.uri(), "0.1.0").unwrap();
        assert!(matches!(
            client.pair("00000000", "PC").await,
            Err(PairError::Network(_))
        ));
    }
}
