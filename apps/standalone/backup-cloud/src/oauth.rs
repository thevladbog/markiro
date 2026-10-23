//! Fixed-origin OAuth. Requests containing credentials cannot follow redirects.
use std::{future::Future, pin::Pin, time::Duration};

use aws_lc_rs::{
    constant_time::verify_slices_are_equal,
    digest::{digest, SHA256},
    rand::{SecureRandom, SystemRandom},
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use reqwest::{Client, Url};
use serde::Deserialize;
use zeroize::Zeroizing;

use crate::{model::*, Error, Result};

const TOKEN_URL: &str = "https://oauth.yandex.ru/token";

pub struct ApiRequest {
    pub url: Url,
    pub form: Vec<(String, Secret)>,
}
impl std::fmt::Debug for ApiRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ApiRequest([REDACTED])")
    }
}
impl ApiRequest {
    pub fn token(url: &str, form: Vec<(String, Secret)>) -> Result<Self> {
        // Exact string protects against userinfo, query, custom ports and paths,
        // encoded aliases and all Markiro or arbitrary destinations before I/O.
        if url != TOKEN_URL {
            return Err(Error::OriginDenied);
        }
        Ok(Self {
            url: Url::parse(TOKEN_URL).map_err(|_| Error::OriginDenied)?,
            form,
        })
    }
    pub fn validate(&self) -> Result<()> {
        if self.url.as_str() != TOKEN_URL {
            return Err(Error::OriginDenied);
        }
        Ok(())
    }
}

pub struct ApiResponse {
    pub status: u16,
    pub body: Vec<u8>,
}
impl Drop for ApiResponse {
    fn drop(&mut self) {
        zeroize::Zeroize::zeroize(&mut self.body);
    }
}
pub trait Transport: Send + Sync {
    fn send(
        &self,
        request: ApiRequest,
    ) -> Pin<Box<dyn Future<Output = Result<ApiResponse>> + Send + '_>>;
}

impl<T: Transport + ?Sized> Transport for std::sync::Arc<T> {
    fn send(
        &self,
        request: ApiRequest,
    ) -> Pin<Box<dyn Future<Output = Result<ApiResponse>> + Send + '_>> {
        (**self).send(request)
    }
}

#[derive(Clone)]
pub struct DirectTransport {
    client: Client,
}
impl DirectTransport {
    pub fn new() -> Result<Self> {
        Ok(Self {
            client: Client::builder()
                .https_only(true)
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .dns_resolver(std::sync::Arc::new(crate::client::PublicDns))
                .connect_timeout(Duration::from_secs(10))
                .read_timeout(Duration::from_secs(60))
                .timeout(Duration::from_secs(120))
                .build()
                .map_err(|_| Error::Network)?,
        })
    }
}
impl Transport for DirectTransport {
    fn send(
        &self,
        request: ApiRequest,
    ) -> Pin<Box<dyn Future<Output = Result<ApiResponse>> + Send + '_>> {
        Box::pin(async move {
            request.validate()?;
            let form = request
                .form
                .iter()
                .map(|(key, secret)| (key.as_str(), secret.expose()))
                .collect::<Vec<_>>();
            let mut response = self
                .client
                .post(request.url.clone())
                .form(&form)
                .send()
                .await
                .map_err(|_| Error::Network)?;
            let status = response.status().as_u16();
            crate::retry::check(&response)?;
            let mut body = Zeroizing::new(Vec::new());
            while let Some(bytes) = response.chunk().await.map_err(|_| Error::Network)? {
                if body.len() + bytes.len() > JSON_CAP as usize {
                    return Err(Error::SizeLimit);
                }
                body.extend_from_slice(&bytes);
            }
            Ok(ApiResponse {
                status,
                body: std::mem::take(&mut *body),
            })
        })
    }
}

fn random_secret() -> Result<Secret> {
    let mut bytes = Zeroizing::new([0; 32]);
    SystemRandom::new()
        .fill(bytes.as_mut())
        .map_err(|_| Error::Crypto)?;
    Secret::new(URL_SAFE_NO_PAD.encode(&bytes[..]))
}

#[derive(Debug)]
pub struct OAuthAttempt {
    profile: ClientProfile,
    state: Secret,
    verifier: Secret,
    expires_at: i64,
    consumed: bool,
}
impl OAuthAttempt {
    pub fn new(client_id: &str, now: i64) -> Result<Self> {
        Ok(Self {
            profile: ClientProfile::new(client_id)?,
            state: random_secret()?,
            verifier: random_secret()?,
            expires_at: now.checked_add(600).ok_or(Error::InvalidAttempt)?,
            consumed: false,
        })
    }
    pub fn authorization_url(&self) -> Result<Url> {
        let mut url =
            Url::parse("https://oauth.yandex.ru/authorize").map_err(|_| Error::OriginDenied)?;
        let challenge = URL_SAFE_NO_PAD.encode(digest(&SHA256, self.verifier.expose().as_bytes()));
        url.query_pairs_mut().extend_pairs([
            ("response_type", "code"),
            ("client_id", &self.profile.client_id),
            ("redirect_uri", REDIRECT_URI),
            ("scope", &SCOPES.join(" ")),
            ("state", self.state.expose()),
            ("code_challenge_method", "S256"),
            ("code_challenge", &challenge),
        ]);
        Ok(url)
    }
    pub fn cancel(&mut self) {
        self.consumed = true;
    }
}

pub struct OAuthClient<T: Transport> {
    transport: T,
    refresh_lock: tokio::sync::Mutex<()>,
}
impl<T: Transport> OAuthClient<T> {
    pub fn new(transport: T) -> Self {
        Self {
            transport,
            refresh_lock: tokio::sync::Mutex::new(()),
        }
    }

    pub async fn complete(
        &self,
        attempt: &mut OAuthAttempt,
        state: &str,
        code: &str,
        now: i64,
    ) -> Result<TokenSet> {
        if attempt.consumed
            || now >= attempt.expires_at
            || now < attempt.expires_at - 600
            || verify_slices_are_equal(state.as_bytes(), attempt.state.expose().as_bytes()).is_err()
        {
            return Err(Error::InvalidAttempt);
        }
        // Once a validated callback starts its exchange, do not replay a possibly
        // spent code after timeout or an ambiguous transport failure.
        attempt.consumed = true;
        let form = vec![
            field("grant_type", "authorization_code")?,
            field("client_id", &attempt.profile.client_id)?,
            field("code", code)?,
            field("code_verifier", attempt.verifier.expose())?,
            field("redirect_uri", REDIRECT_URI)?,
        ];
        let response = self
            .transport
            .send(ApiRequest::token(TOKEN_URL, form)?)
            .await?;
        parse_tokens(response, now)
    }

    pub async fn refresh(&self, credentials: &RuntimeCredentials, now: i64) -> Result<TokenSet> {
        credentials.profile.validate()?;
        let _guard = self.refresh_lock.lock().await;
        let request = ApiRequest::token(
            TOKEN_URL,
            vec![
                field("grant_type", "refresh_token")?,
                field("client_id", &credentials.profile.client_id)?,
                field("client_secret", credentials.client_secret.expose())?,
                field("refresh_token", credentials.tokens.refresh.expose())?,
            ],
        )?;
        parse_tokens(self.transport.send(request).await?, now)
    }
}

fn field(key: &str, value: &str) -> Result<(String, Secret)> {
    Ok((key.into(), Secret::new(value.into())?))
}

fn parse_tokens(response: ApiResponse, now: i64) -> Result<TokenSet> {
    if response.status >= 500 {
        return Err(Error::Network);
    }
    if response.status != 200 {
        let code = serde_json::from_slice::<serde_json::Value>(&response.body)
            .ok()
            .and_then(|v| v.get("error").and_then(|v| v.as_str()).map(str::to_owned));
        return Err(Error::Provider(match code.as_deref() {
            Some("invalid_client" | "unauthorized_client") => "client_credentials_invalid",
            Some("invalid_grant") => "reauth",
            _ if response.status == 429 => "rate_limited",
            _ => "access_denied",
        }));
    }
    #[derive(Deserialize)]
    struct Response {
        access_token: String,
        refresh_token: String,
        expires_in: i64,
        token_type: String,
    }
    let value: Response =
        serde_json::from_slice(&response.body).map_err(|_| Error::InvalidFormat)?;
    if value.expires_in <= 0
        || value.expires_in > 10 * 366 * 86400
        || !value.token_type.eq_ignore_ascii_case("bearer")
    {
        return Err(Error::InvalidFormat);
    }
    Ok(TokenSet {
        access: Secret::new(value.access_token)?,
        refresh: Secret::new(value.refresh_token)?,
        expires_at: now
            .checked_add(value.expires_in)
            .ok_or(Error::InvalidFormat)?,
    })
}
