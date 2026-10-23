//! Disk calls are confined to app:/ and provider-owned HTTPS destinations.
use std::{net::IpAddr, path::Path, sync::Arc, time::Duration};

use reqwest::{Client, Method, Response, Url};
use serde::Deserialize;
use std::{future::Future, pin::Pin};
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

use crate::{
    envelope::{hash_file, private_file},
    model::*,
    Error, Result,
};

pub struct TransferUrl(Url);
impl std::fmt::Debug for TransferUrl {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("TransferUrl([REDACTED])")
    }
}
impl TransferUrl {
    pub fn parse(value: &str) -> Result<Self> {
        if value.len() > 16384 {
            return Err(Error::OriginDenied);
        }
        let url = Url::parse(value).map_err(|_| Error::OriginDenied)?;
        let host = url.host_str().ok_or(Error::OriginDenied)?;
        let upload = host.strip_suffix(".disk.yandex.net").is_some_and(|label| {
            label.starts_with("uploader")
                && label.len() <= 64
                && label
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        });
        // Yandex's documented direct-download storage nodes (one DNS label).
        let storage = host
            .strip_suffix(".storage.yandex.net")
            .is_some_and(|label| {
                !label.is_empty()
                    && label.len() <= 63
                    && label
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-')
                    && !label.starts_with('-')
                    && !label.ends_with('-')
            });
        if url.scheme() != "https"
            || url.port_or_known_default() != Some(443)
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
            || !(upload
                || storage
                || host == "downloader.disk.yandex.ru"
                || host == "downloader.disk.yandex.net")
        {
            return Err(Error::OriginDenied);
        }
        Ok(Self(url))
    }
}

pub fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => {
            let [a, b, _, _] = v.octets();
            !(v.is_private()
                || v.is_loopback()
                || v.is_link_local()
                || v.is_multicast()
                || v.is_unspecified()
                || a == 0
                || a >= 240
                || (a == 100 && (64..=127).contains(&b))
                || (a == 192 && b == 0)
                || (a == 198 && (b == 18 || b == 19))
                || v.is_documentation()
                || v.is_broadcast())
        }
        IpAddr::V6(v) => {
            if let Some(v4) = v.to_ipv4_mapped() {
                return public_ip(IpAddr::V4(v4));
            }
            // Public unicast only (2000::/3); excludes ULA, link local, ::/96,
            // multicast, NAT64 and future special-purpose allocations.
            (v.segments()[0] & 0xe000) == 0x2000
                && !(v.segments()[0] == 0x2001 && v.segments()[1] == 0xdb8)
        }
    }
}

pub struct PublicDns;
impl reqwest::dns::Resolve for PublicDns {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let host = name.as_str().to_owned();
        Box::pin(async move {
            let addresses: Vec<_> = tokio::net::lookup_host((host.as_str(), 443))
                .await?
                .filter(|a| public_ip(a.ip()))
                .collect();
            if addresses.is_empty() {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "public destination required",
                )
                .into());
            }
            Ok(Box::new(addresses.into_iter()) as reqwest::dns::Addrs)
        })
    }
}

#[derive(Debug, Clone)]
pub struct RemoteObject {
    host: Uuid,
    snapshot: Uuid,
    name: String,
}
impl RemoteObject {
    pub fn new(host: Uuid, snapshot: Uuid, name: &str) -> Result<Self> {
        if host.is_nil() || snapshot.is_nil() {
            return Err(Error::InvalidFormat);
        }
        object_cap(name)?;
        Ok(Self {
            host,
            snapshot,
            name: name.into(),
        })
    }
    pub fn path(&self) -> String {
        format!(
            "app:/backups/v1/{}/{}/{}",
            self.host, self.snapshot, self.name
        )
    }
}

#[derive(Debug, Deserialize)]
pub struct Resource {
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub size: Option<u64>,
    pub sha256: Option<String>,
}
#[derive(Debug, Deserialize)]
pub struct Account {
    pub id: String,
    pub display_name: Option<String>,
}

#[derive(Clone)]
pub struct DiskClient {
    client: Client,
    access: Secret,
    guard: Option<Arc<dyn RequestGuard>>,
}
pub trait RequestGuard: Send + Sync {
    fn check(&self) -> Pin<Box<dyn Future<Output = Result<()>> + Send + '_>>;
    fn cancelled(&self) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        Box::pin(std::future::pending())
    }
}
async fn cancel_on<T>(
    guard: Option<&dyn RequestGuard>,
    work: impl Future<Output = Result<T>>,
) -> Result<T> {
    let cancelled = async {
        if let Some(guard) = guard {
            guard.cancelled().await
        } else {
            std::future::pending::<()>().await
        }
    };
    tokio::select! {value=work=>value,_=cancelled=>Err(Error::InvalidAttempt)}
}
impl DiskClient {
    pub fn new(access: Secret) -> Result<Self> {
        let client = Client::builder()
            .https_only(true)
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .dns_resolver(Arc::new(PublicDns))
            .connect_timeout(Duration::from_secs(10))
            .read_timeout(Duration::from_secs(60))
            .timeout(Duration::from_secs(6 * 3600))
            .build()
            .map_err(|_| Error::Network)?;
        Ok(Self {
            client,
            access,
            guard: None,
        })
    }
    pub fn with_guard(mut self, guard: Arc<dyn RequestGuard>) -> Self {
        self.guard = Some(guard);
        self
    }
    async fn check(&self) -> Result<()> {
        if let Some(guard) = &self.guard {
            guard.check().await?;
        }
        Ok(())
    }

    fn api_url(endpoint: &str) -> Result<Url> {
        if !matches!(
            endpoint,
            "resources" | "resources/upload" | "resources/download"
        ) {
            return Err(Error::OriginDenied);
        }
        Url::parse(&format!("https://cloud-api.yandex.net/v1/disk/{endpoint}"))
            .map_err(|_| Error::OriginDenied)
    }
    fn authorized(&self, method: Method, url: Url) -> reqwest::RequestBuilder {
        let mut value =
            reqwest::header::HeaderValue::from_str(&format!("OAuth {}", self.access.expose()))
                .expect("credential is validated printable ASCII");
        value.set_sensitive(true);
        self.client
            .request(method, url)
            .header("Authorization", value)
    }
    async fn api(
        &self,
        method: Method,
        endpoint: &str,
        query: &[(&str, &str)],
    ) -> Result<Response> {
        let mut url = Self::api_url(endpoint)?;
        url.query_pairs_mut().extend_pairs(query.iter().copied());
        self.check().await?;
        let response = cancel_on(self.guard.as_deref(), async {
            self.authorized(method, url)
                .send()
                .await
                .map_err(|_| Error::Network)
        })
        .await?;
        crate::retry::check(&response)?;
        Ok(response)
    }

    pub async fn account(&self) -> Result<Account> {
        self.check().await?;
        let response = cancel_on(self.guard.as_deref(), async {
            self.authorized(
                Method::GET,
                Url::parse("https://login.yandex.ru/info?format=json")
                    .map_err(|_| Error::OriginDenied)?,
            )
            .send()
            .await
            .map_err(|_| Error::Network)
        })
        .await?;
        let account: Account = cancel_on(self.guard.as_deref(), json_response(response)).await?;
        if account.id.is_empty()
            || account.id.len() > 200
            || !account
                .id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            || account
                .display_name
                .as_ref()
                .is_some_and(|s| s.chars().count() > 200 || s.chars().any(char::is_control))
        {
            return Err(Error::InvalidFormat);
        }
        Ok(account)
    }
    pub async fn check_folder(&self) -> Result<()> {
        let value: serde_json::Value = json_response(
            self.api(
                Method::GET,
                "resources",
                &[("path", "app:/"), ("fields", "type")],
            )
            .await?,
        )
        .await?;
        if value.get("type").and_then(|v| v.as_str()) != Some("dir") {
            return Err(Error::InvalidFormat);
        }
        Ok(())
    }
    pub async fn ensure_snapshot_dir(&self, host: Uuid, snapshot: Uuid) -> Result<()> {
        if host.is_nil() || snapshot.is_nil() {
            return Err(Error::InvalidFormat);
        }
        for path in [
            "app:/backups".into(),
            "app:/backups/v1".into(),
            format!("app:/backups/v1/{host}"),
            format!("app:/backups/v1/{host}/{snapshot}"),
        ] {
            let response = self
                .api(Method::PUT, "resources", &[("path", &path)])
                .await?;
            if response.status().as_u16() == 409 {
                let existing: serde_json::Value = json_response(
                    self.api(
                        Method::GET,
                        "resources",
                        &[("path", &path), ("fields", "type")],
                    )
                    .await?,
                )
                .await?;
                if existing.get("type").and_then(|v| v.as_str()) != Some("dir") {
                    return Err(Error::Provider("remote_conflict"));
                }
            } else {
                self.finish_mutation(response).await?;
            }
        }
        Ok(())
    }

    /// Lists fixed app-folder levels with complete pagination. Child names are
    /// untrusted labels; callers validate UUIDs before forming any next path.
    pub async fn list(&self, host: Option<Uuid>, snapshot: Option<Uuid>) -> Result<Vec<Resource>> {
        if snapshot.is_some() && host.is_none() {
            return Err(Error::InvalidFormat);
        }
        let path = match (host, snapshot) {
            (Some(h), Some(s)) => format!("app:/backups/v1/{h}/{s}"),
            (Some(h), None) => format!("app:/backups/v1/{h}"),
            _ => "app:/backups/v1".into(),
        };
        let mut result = Vec::new();
        let mut offset = 0u64;
        loop {
            let offset_text = offset.to_string();
            let response=self.api(Method::GET,"resources",&[("path",&path),("limit","100"),("offset",&offset_text),("fields","_embedded.items.name,_embedded.items.type,_embedded.items.size,_embedded.items.sha256,_embedded.offset,_embedded.total")]).await?;
            if response.status().as_u16() == 404 {
                return Ok(result);
            }
            #[derive(Deserialize)]
            struct Listing {
                _embedded: Page,
            }
            #[derive(Deserialize)]
            struct Page {
                items: Vec<Resource>,
                offset: u64,
                total: u64,
            }
            let page: Listing = json_response(response).await?;
            if page._embedded.offset != offset
                || page._embedded.items.len() > 100
                || page._embedded.total > 1_000_000
            {
                return Err(Error::SizeLimit);
            }
            let count = page._embedded.items.len() as u64;
            result.extend(page._embedded.items);
            offset += count;
            if offset >= page._embedded.total {
                return Ok(result);
            }
            if count == 0 {
                return Err(Error::InvalidFormat);
            }
        }
    }

    async fn transfer(&self, object: &RemoteObject, upload: bool) -> Result<TransferUrl> {
        let path = object.path();
        let mut query = vec![("path", path.as_str())];
        if upload {
            query.push(("overwrite", "false"));
        }
        let response = self
            .api(
                Method::GET,
                if upload {
                    "resources/upload"
                } else {
                    "resources/download"
                },
                &query,
            )
            .await?;
        #[derive(Deserialize)]
        struct Link {
            href: String,
            method: String,
            templated: bool,
        }
        let link: Link = json_response(response).await?;
        if link.templated || link.method != if upload { "PUT" } else { "GET" } {
            return Err(Error::InvalidFormat);
        }
        TransferUrl::parse(&link.href)
    }

    pub async fn get_stream(&self, object: &RemoteObject, target: &Path) -> Result<()> {
        let cap = object_cap(&object.name)?;
        for attempt in 0..2 {
            let url = self.transfer(object, false).await?;
            // This is deliberately NOT authorized(): signed transfers never
            // receive OAuth, cookies, application secrets or default auth.
            let mut response = download_response(url, |url| async move {
                self.check().await?;
                cancel_on(self.guard.as_deref(), async {
                    self.client
                        .get(url.0)
                        .send()
                        .await
                        .map_err(|_| Error::Network)
                })
                .await
            })
            .await?;
            if attempt == 0 && matches!(response.status().as_u16(), 401 | 403 | 404) {
                continue;
            }
            crate::retry::check(&response)?;
            require_success(response.status().as_u16())?;
            if response.content_length().is_some_and(|n| n > cap) {
                return Err(Error::SizeLimit);
            }
            let file = private_file(target)?;
            let result = async {
                let mut file = tokio::fs::File::from_std(file);
                let mut total = 0u64;
                loop {
                    let chunk = cancel_on(self.guard.as_deref(), async {
                        response.chunk().await.map_err(|_| Error::Network)
                    })
                    .await?;
                    let Some(bytes) = chunk else {
                        break;
                    };
                    total += bytes.len() as u64;
                    if total > cap {
                        return Err(Error::SizeLimit);
                    }
                    file.write_all(&bytes).await?;
                }
                file.sync_all().await?;
                Ok(())
            }
            .await;
            if result.is_err() {
                let _ = tokio::fs::remove_file(target).await;
            }
            return result;
        }
        Err(Error::Network)
    }

    pub async fn put_new(&self, object: &RemoteObject, source: &Path) -> Result<()> {
        let path_to_hash = source.to_owned();
        let cap = object_cap(&object.name)?;
        let expected = tokio::task::spawn_blocking(move || hash_file(&path_to_hash, cap))
            .await
            .map_err(|_| Error::Integrity)??;
        let path = object.path();
        let metadata = self
            .api(
                Method::GET,
                "resources",
                &[("path", &path), ("fields", "type,size,sha256")],
            )
            .await?;
        if metadata.status().as_u16() != 404 {
            let value: serde_json::Value = json_response(metadata).await?;
            if value.get("type").and_then(|v| v.as_str()) == Some("file")
                && value.get("size").and_then(|v| v.as_u64()) == Some(expected.size_bytes)
                && value.get("sha256").and_then(|v| v.as_str()) == Some(&expected.sha256)
            {
                return Ok(());
            }
            return Err(Error::Provider("remote_conflict"));
        }
        for attempt in 0..2 {
            let url = self.transfer(object, true).await?;
            let response = self.upload_file(url, source, expected.size_bytes).await?;
            if attempt == 0 && matches!(response.status().as_u16(), 401 | 403 | 404) {
                continue;
            }
            return self.finish_mutation(response).await;
        }
        Err(Error::Network)
    }

    async fn upload_file(&self, url: TransferUrl, source: &Path, size: u64) -> Result<Response> {
        let file = tokio::fs::File::open(source).await?;
        let stream = tokio_util::io::ReaderStream::with_capacity(file, 64 * 1024);
        self.check().await?;
        cancel_on(self.guard.as_deref(), async {
            self.client
                .put(url.0)
                .header("Content-Length", size)
                .body(reqwest::Body::wrap_stream(stream))
                .send()
                .await
                .map_err(|_| Error::Network)
        })
        .await
    }

    pub async fn delete_owned(&self, object: &RemoteObject, owned_host: Uuid) -> Result<()> {
        if owned_host != object.host {
            return Err(Error::OriginDenied);
        }
        let response = self
            .api(
                Method::DELETE,
                "resources",
                &[("path", &object.path()), ("permanently", "true")],
            )
            .await?;
        if response.status().as_u16() == 404 {
            return Ok(());
        }
        self.finish_mutation(response).await
    }

    async fn finish_mutation(&self, response: Response) -> Result<()> {
        crate::retry::check(&response)?;
        if response.status().as_u16() == 202 {
            #[derive(Deserialize)]
            struct Operation {
                href: String,
            }
            let operation: Operation = json_body(response).await?;
            return self.wait_operation(&operation.href).await;
        }
        require_success(response.status().as_u16())
    }

    pub async fn wait_operation(&self, href: &str) -> Result<()> {
        let url = Url::parse(href).map_err(|_| Error::OriginDenied)?;
        if url.scheme() != "https"
            || url.host_str() != Some("cloud-api.yandex.net")
            || url.port_or_known_default() != Some(443)
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || !url
                .path()
                .strip_prefix("/v1/disk/operations/")
                .is_some_and(|id| {
                    !id.is_empty()
                        && id.len() <= 256
                        && id
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
                })
        {
            return Err(Error::OriginDenied);
        }
        poll_operation(|| async {
            self.check().await?;
            let response = self
                .authorized(Method::GET, url.clone())
                .send()
                .await
                .map_err(|_| Error::Network)?;
            let value: serde_json::Value = json_response(response).await?;
            value
                .get("status")
                .and_then(|v| v.as_str())
                .map(str::to_owned)
                .ok_or(Error::InvalidFormat)
        })
        .await
    }
}

async fn poll_operation<F, Fut>(mut read: F) -> Result<()>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<String>>,
{
    for _ in 0..300 {
        match read().await?.as_str() {
            "success" => return Ok(()),
            "in-progress" => tokio::time::sleep(Duration::from_secs(2)).await,
            _ => return Err(Error::Provider("operation_failed")),
        }
    }
    Err(Error::Network)
}

async fn download_response<F, Fut>(mut url: TransferUrl, mut get: F) -> Result<Response>
where
    F: FnMut(TransferUrl) -> Fut,
    Fut: Future<Output = Result<Response>>,
{
    for hop in 0..=3 {
        let response = get(url).await?;
        if !response.status().is_redirection() {
            return Ok(response);
        }
        if hop == 3 || !matches!(response.status().as_u16(), 301 | 302 | 303 | 307 | 308) {
            return Err(Error::OriginDenied);
        }
        let location = response
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|v| v.to_str().ok())
            .ok_or(Error::OriginDenied)?;
        url = TransferUrl::parse(location)?;
        let host = url.0.host_str().ok_or(Error::OriginDenied)?;
        if host != "downloader.disk.yandex.ru"
            && host != "downloader.disk.yandex.net"
            && !host.ends_with(".storage.yandex.net")
        {
            return Err(Error::OriginDenied);
        }
    }
    Err(Error::OriginDenied)
}

async fn json_response<T: serde::de::DeserializeOwned>(response: Response) -> Result<T> {
    crate::retry::check(&response)?;
    require_success(response.status().as_u16())?;
    json_body(response).await
}
async fn json_body<T: serde::de::DeserializeOwned>(mut response: Response) -> Result<T> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| Error::Network)? {
        if bytes.len() + chunk.len() > JSON_CAP as usize {
            return Err(Error::SizeLimit);
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| Error::InvalidFormat)
}
fn require_success(status: u16) -> Result<()> {
    if status == 202 {
        return Err(Error::Provider("operation_pending"));
    }
    if (200..300).contains(&status) {
        return Ok(());
    }
    Err(Error::Provider(match status {
        401 => "reauth",
        403 => "access_denied",
        404 => "not_found",
        409 => "remote_conflict",
        429 => "rate_limited",
        507 => "quota",
        _ => "network",
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn download_redirects_are_bounded_and_checked_before_the_next_send() {
        let first =
            || TransferUrl::parse("https://downloader.disk.yandex.ru/disk/synthetic").unwrap();
        let mut calls = 0;
        let response = download_response(first(), |url| {
            calls += 1;
            let response: Response = if calls == 1 {
                http::Response::builder()
                    .status(302)
                    .header(
                        "Location",
                        "https://s123nrg.storage.yandex.net/file?signature=synthetic",
                    )
                    .body("")
                    .unwrap()
                    .into()
            } else {
                assert_eq!(url.0.host_str(), Some("s123nrg.storage.yandex.net"));
                http::Response::builder()
                    .status(200)
                    .body("synthetic bytes")
                    .unwrap()
                    .into()
            };
            std::future::ready(Ok(response))
        })
        .await
        .unwrap();
        assert_eq!(response.status().as_u16(), 200);
        assert_eq!(calls, 2);
        for forbidden in [
            "https://api.markiro.ru/steal",
            "http://s123nrg.storage.yandex.net/file",
            "https://127.0.0.1/file",
            "https://user:pass@s123nrg.storage.yandex.net/file",
            "https://uploader.disk.yandex.net/file",
        ] {
            let mut calls = 0;
            let result = download_response(first(), |_| {
                calls += 1;
                std::future::ready(Ok(http::Response::builder()
                    .status(302)
                    .header("Location", forbidden)
                    .body("")
                    .unwrap()
                    .into()))
            })
            .await;
            assert!(matches!(result, Err(Error::OriginDenied)));
            assert_eq!(calls, 1, "refuse before any foreign request");
        }
        let mut calls = 0;
        let result = download_response(first(), |_| {
            calls += 1;
            std::future::ready(Ok(http::Response::builder()
                .status(302)
                .header("Location", "https://downloader.disk.yandex.ru/loop")
                .body("")
                .unwrap()
                .into()))
        })
        .await;
        assert!(matches!(result, Err(Error::OriginDenied)));
        assert_eq!(calls, 4);
    }
    #[tokio::test]
    async fn disconnect_cancels_an_upload_while_the_server_stalls() {
        struct Guard(tokio::sync::watch::Receiver<bool>);
        impl RequestGuard for Guard {
            fn check(&self) -> Pin<Box<dyn Future<Output = Result<()>> + Send + '_>> {
                Box::pin(async { Ok(()) })
            }
            fn cancelled(&self) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
                let mut receiver = self.0.clone();
                Box::pin(async move {
                    let _ = receiver.wait_for(|value| *value).await;
                })
            }
        }
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (cancel, receiver) = tokio::sync::watch::channel(false);
        let mut disk = DiskClient::new(Secret::new("synthetic".into()).unwrap())
            .unwrap()
            .with_guard(Arc::new(Guard(receiver)));
        // Exercise cancellation with a local server, bypassing only the
        // production resolver that correctly refuses loopback transfer hosts.
        disk.client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("database.age");
        std::fs::write(&source, vec![0; 1024 * 1024]).unwrap();
        // Only this unit test constructs a loopback transfer URL; provider URLs
        // still go through TransferUrl::parse and the public-address resolver.
        let url = TransferUrl(reqwest::Url::parse(&format!("http://{address}/upload")).unwrap());
        let server = async {
            let (_socket, _) = listener.accept().await.unwrap();
            cancel.send(true).unwrap();
            std::future::pending::<()>().await;
        };
        let upload = disk.upload_file(url, &source, 1024 * 1024);
        let result = tokio::time::timeout(Duration::from_secs(2), async {
            tokio::select! { result = upload => result, _ = server => unreachable!() }
        })
        .await
        .expect("disconnect must drop an in-flight upload");
        assert!(matches!(result, Err(Error::InvalidAttempt)));
    }
    #[tokio::test]
    async fn cancellation_interrupts_a_hung_network_future() {
        struct Cancelled;
        impl RequestGuard for Cancelled {
            fn check(&self) -> Pin<Box<dyn Future<Output = Result<()>> + Send + '_>> {
                Box::pin(async { Ok(()) })
            }
            fn cancelled(&self) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
                Box::pin(async {})
            }
        }
        let result = tokio::time::timeout(
            Duration::from_millis(50),
            cancel_on(Some(&Cancelled), std::future::pending::<Result<()>>()),
        )
        .await
        .unwrap();
        assert!(matches!(result, Err(Error::InvalidAttempt)));
    }
    #[test]
    fn accepted_is_not_completed() {
        assert!(require_success(201).is_ok());
        assert!(require_success(204).is_ok());
        assert!(require_success(202).is_err());
    }
    #[tokio::test]
    async fn foreign_operation_origin_is_refused_before_sending() {
        let client = DiskClient::new(Secret::new("synthetic-token".into()).unwrap()).unwrap();
        assert!(matches!(
            client
                .wait_operation("https://api.markiro.ru/v1/disk/operations/one")
                .await,
            Err(Error::OriginDenied)
        ));
    }
    #[tokio::test]
    async fn accepted_response_validates_operation_origin_before_poll() {
        let client = DiskClient::new(Secret::new("synthetic-token".into()).unwrap()).unwrap();
        let response: Response = http::Response::builder()
            .status(202)
            .body(r#"{"href":"https://api.markiro.ru/v1/disk/operations/one"}"#)
            .unwrap()
            .into();
        assert!(matches!(
            client.finish_mutation(response).await,
            Err(Error::OriginDenied)
        ));
    }
    #[tokio::test(start_paused = true)]
    async fn operation_is_polled_until_success_and_failure_is_not_success() {
        let mut statuses =
            std::collections::VecDeque::from(["in-progress", "in-progress", "success"]);
        let mut calls = 0;
        poll_operation(|| {
            calls += 1;
            let value = statuses.pop_front().unwrap().to_owned();
            async move { Ok(value) }
        })
        .await
        .unwrap();
        assert_eq!(calls, 3);
        assert!(matches!(
            poll_operation(|| async { Ok("failed".into()) }).await,
            Err(Error::Provider("operation_failed"))
        ));
    }
}
