//! Explicit, optional release downloads. No site credentials or automatic checks.
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use markiro_proto::trust::{self, UpdateManifestV1};
use markiro_proto::update::distribution::MAX_INSTALLER_BYTES;
use markiro_proto::update::{hash_exact, AppVersion};
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Runtime};
use tokio::io::AsyncWriteExt;

use super::fetch::{self, DownloadsDir, FetchProgress, Fetched, ManifestView};

pub const ORIGIN: &str = "https://releases.markiro.app";
pub const DOWNLOADS: &str = "online-updates";
pub const PROGRESS_EVENT: &str = "standalone://online-update-progress";
const METADATA_LIMIT: usize = 64 * 1024;
static DOWNLOAD_GATE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OnlineError {
    InvalidRequest,
    Unreachable,
    Unavailable,
    Malformed,
    UnknownKey,
    Signature,
    NotNewer,
    NeedsIntermediate,
    OfferChanged,
    TooLong,
    HashMismatch,
    Interrupted,
    Storage,
    Busy,
}
impl OnlineError {
    pub fn code(self) -> &'static str {
        match self {
            Self::InvalidRequest => "invalid_request",
            Self::Unreachable => "unreachable",
            Self::Unavailable => "package_unavailable",
            Self::Malformed => "manifest_malformed",
            Self::UnknownKey => "manifest_unknown_key",
            Self::Signature => "manifest_signature",
            Self::NotNewer => "not_newer",
            Self::NeedsIntermediate => "needs_intermediate",
            Self::OfferChanged => "offer_changed",
            Self::TooLong => "too_long",
            Self::HashMismatch => "hash_mismatch",
            Self::Interrupted => "interrupted",
            Self::Storage => "storage",
            Self::Busy => "update_busy",
        }
    }
}
impl From<fetch::FetchError> for OnlineError {
    fn from(value: fetch::FetchError) -> Self {
        match value {
            fetch::FetchError::ManifestUnknownKey => Self::UnknownKey,
            fetch::FetchError::ManifestSignature => Self::Signature,
            _ => Self::Malformed,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Pointer {
    v: u8,
    product: String,
    channel: String,
    version: String,
    released_at: String,
    installer: PointerInstaller,
    manifest_url: String,
    notes: Vec<String>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PointerInstaller {
    url: String,
    sha256: String,
    size_bytes: u64,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Offer {
    pub manifest: ManifestView,
    pub newer: bool,
    pub compatible: bool,
}

fn channel_path(channel: &str) -> Result<String, OnlineError> {
    match channel {
        "stable" | "beta" => Ok(format!("{ORIGIN}/standalone/{channel}/latest.json")),
        _ => Err(OnlineError::InvalidRequest),
    }
}
fn pointer_of(text: &str, channel: &str) -> Result<Pointer, OnlineError> {
    channel_path(channel)?;
    if text.len() > METADATA_LIMIT {
        return Err(OnlineError::TooLong);
    }
    let p: Pointer = serde_json::from_str(text).map_err(|_| OnlineError::Malformed)?;
    let _: AppVersion = p.version.parse().map_err(|_| OnlineError::Malformed)?;
    let prefix = format!("{ORIGIN}/standalone/{channel}/{}", p.version);
    if p.v != 1
        || p.product != "markiro-standalone"
        || p.channel != channel
        || p.manifest_url != format!("{prefix}/markiro-standalone-{}.update.jws", p.version)
        || p.installer.url
            != format!(
                "{prefix}/markiro-standalone-{}-windows-x86_64-setup.exe",
                p.version
            )
        || p.installer.size_bytes == 0
        || p.installer.size_bytes > MAX_INSTALLER_BYTES
        || p.notes.len() > 30
    {
        return Err(OnlineError::Malformed);
    }
    Ok(p)
}
fn read_offer(pointer: &str, text: &str, channel: &str, own: &str) -> Result<Offer, OnlineError> {
    let p = pointer_of(pointer, channel)?;
    if text.len() > METADATA_LIMIT {
        return Err(OnlineError::TooLong);
    }
    let m = fetch::read_manifest(text, &trust::update_keyset())?;
    let view = ManifestView::of(&m);
    if m.version != p.version
        || view.channel != p.channel
        || m.released_at != p.released_at
        || m.installer.sha256 != p.installer.sha256
        || m.installer.size_bytes != p.installer.size_bytes
    {
        return Err(OnlineError::Malformed);
    }
    let own: AppVersion = own.parse().map_err(|_| OnlineError::InvalidRequest)?;
    let version: AppVersion = m.version.parse().map_err(|_| OnlineError::Malformed)?;
    let floor: AppVersion = m
        .min_upgrade_from
        .parse()
        .map_err(|_| OnlineError::Malformed)?;
    Ok(Offer {
        manifest: view,
        newer: version > own,
        compatible: own >= floor,
    })
}
fn client() -> Result<reqwest::Client, OnlineError> {
    reqwest::Client::builder()
        .https_only(true)
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .dns_resolver(Arc::new(markiro_backup_cloud::client::PublicDns))
        .connect_timeout(Duration::from_secs(10))
        .read_timeout(Duration::from_secs(60))
        .timeout(Duration::from_secs(30 * 60))
        .build()
        .map_err(|_| OnlineError::Unreachable)
}
async fn metadata(client: &reqwest::Client, url: &str) -> Result<String, OnlineError> {
    let mut response = client
        .get(url)
        .header(reqwest::header::CACHE_CONTROL, "no-cache")
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|_| OnlineError::Unreachable)?;
    if response.status() == 404 {
        return Err(OnlineError::Unavailable);
    }
    if response.status() != 200 {
        return Err(OnlineError::Unreachable);
    }
    if response
        .content_length()
        .is_some_and(|n| n > METADATA_LIMIT as u64)
    {
        return Err(OnlineError::TooLong);
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| OnlineError::Unreachable)?
    {
        if bytes.len() + chunk.len() > METADATA_LIMIT {
            return Err(OnlineError::TooLong);
        }
        bytes.extend_from_slice(&chunk);
    }
    String::from_utf8(bytes).map_err(|_| OnlineError::Malformed)
}
async fn checked(
    client: &reqwest::Client,
    channel: &str,
    own: &str,
) -> Result<(Pointer, String, UpdateManifestV1, Offer), OnlineError> {
    let pointer = metadata(client, &channel_path(channel)?).await?;
    let p = pointer_of(&pointer, channel)?;
    let text = metadata(client, &p.manifest_url).await?;
    let offer = read_offer(&pointer, &text, channel, own)?;
    let m = fetch::read_manifest(&text, &trust::update_keyset())?;
    Ok((p, text, m, offer))
}
async fn matches(path: &Path, m: &UpdateManifestV1) -> bool {
    let path = path.to_path_buf();
    let size = m.installer.size_bytes;
    let hash = m.installer.sha256.clone();
    matches!(tauri::async_runtime::spawn_blocking(move || {
        super::package::open_installer(&path).ok().and_then(|file|hash_exact(file,size).ok())
    }).await,Ok(Some(found)) if found==hash)
}
async fn remove(path: &Path) {
    let _ = tokio::fs::remove_file(path).await;
}
async fn download(
    client: &reqwest::Client,
    url: &str,
    partial: &Path,
    m: &UpdateManifestV1,
    progress: &(dyn Fn(u64, u64) + Send + Sync),
) -> Result<(), OnlineError> {
    let total = m.installer.size_bytes;
    let mut received = tokio::fs::metadata(partial)
        .await
        .map(|m| m.len())
        .unwrap_or(0);
    if received > total {
        remove(partial).await;
        received = 0;
    }
    if received == total {
        return Ok(());
    }
    let mut request = client.get(url);
    if received > 0 {
        request = request.header(reqwest::header::RANGE, format!("bytes={received}-"));
    }
    let mut response = request.send().await.map_err(|_| OnlineError::Interrupted)?;
    let mut file = match response.status().as_u16() {
        200 => {
            received = 0;
            tokio::fs::File::create(partial)
                .await
                .map_err(|_| OnlineError::Storage)?
        }
        206 if received > 0
            && response
                .headers()
                .get(reqwest::header::CONTENT_RANGE)
                .and_then(|v| v.to_str().ok())
                == Some(format!("bytes {received}-{}/{}", total - 1, total).as_str()) =>
        {
            tokio::fs::OpenOptions::new()
                .append(true)
                .open(partial)
                .await
                .map_err(|_| OnlineError::Storage)?
        }
        206 | 416 => {
            remove(partial).await;
            return Err(OnlineError::Interrupted);
        }
        _ => return Err(OnlineError::Unreachable),
    };
    progress(received, total);
    loop {
        let chunk = match response.chunk().await {
            Ok(Some(c)) => c,
            Ok(None) => break,
            Err(_) => {
                let _ = file.flush().await;
                return Err(OnlineError::Interrupted);
            }
        };
        if !fetch::fits(received, chunk.len(), total) {
            drop(file);
            remove(partial).await;
            return Err(OnlineError::TooLong);
        }
        file.write_all(&chunk)
            .await
            .map_err(|_| OnlineError::Storage)?;
        received += chunk.len() as u64;
        progress(received, total);
    }
    file.flush().await.map_err(|_| OnlineError::Storage)?;
    file.sync_all().await.map_err(|_| OnlineError::Storage)?;
    if received == total {
        Ok(())
    } else {
        Err(OnlineError::Interrupted)
    }
}

async fn fetch_package(
    client: &reqwest::Client,
    channel: &str,
    version: &str,
    own: &str,
    root: &Path,
    progress: &(dyn Fn(u64, u64) + Send + Sync),
) -> Result<Fetched, OnlineError> {
    let (p, text, m, offer) = checked(client, channel, own).await?;
    if m.version != version {
        return Err(OnlineError::OfferChanged);
    }
    if !offer.newer {
        return Err(OnlineError::NotNewer);
    }
    if !offer.compatible {
        return Err(OnlineError::NeedsIntermediate);
    }
    store_package(client, &p.installer.url, &text, &m, root, progress).await
}

async fn store_package(
    client: &reqwest::Client,
    url: &str,
    text: &str,
    m: &UpdateManifestV1,
    root: &Path,
    progress: &(dyn Fn(u64, u64) + Send + Sync),
) -> Result<Fetched, OnlineError> {
    let dir = root.join(&m.version);
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|_| OnlineError::Storage)?;
    let manifest = dir.join(format!("markiro-standalone-{}.update.jws", m.version));
    let target = dir.join(&m.installer.name);
    let partial = dir.join(format!("{}.partial", m.installer.name));
    let saved = tokio::fs::read_to_string(&manifest).await.ok();
    if saved.as_deref() != Some(text.trim()) {
        remove(&partial).await;
        remove(&target).await;
    }
    // Save the identity for safe resume. An incomplete package fails update_verify.
    tokio::fs::write(&manifest, text.trim())
        .await
        .map_err(|_| OnlineError::Storage)?;
    if !matches(&target, &m).await {
        remove(&target).await;
        download(client, url, &partial, m, progress).await?;
        if !matches(&partial, &m).await {
            remove(&partial).await;
            return Err(OnlineError::HashMismatch);
        }
        tokio::fs::rename(&partial, &target)
            .await
            .map_err(|_| OnlineError::Storage)?;
    }
    progress(m.installer.size_bytes, m.installer.size_bytes);
    Ok(Fetched {
        version: m.version.clone(),
        manifest_path: manifest.display().to_string(),
        size_bytes: m.installer.size_bytes,
    })
}

pub fn downloaded_manifest(data: &Path, path: &Path) -> bool {
    fetch::downloaded_manifest(&data.join(DOWNLOADS), path)
}
#[tauri::command]
pub async fn update_online_check<R: Runtime>(
    app: tauri::AppHandle<R>,
    channel: String,
) -> Result<Offer, String> {
    async {
        channel_path(&channel)?;
        let client = client()?;
        let (_, _, _, offer) =
            checked(&client, &channel, &app.package_info().version.to_string()).await?;
        Ok(offer)
    }
    .await
    .map_err(|e: OnlineError| e.code().to_owned())
}
#[tauri::command]
pub async fn update_online_download<R: Runtime>(
    app: tauri::AppHandle<R>,
    downloads: tauri::State<'_, DownloadsDir>,
    channel: String,
    version: String,
) -> Result<Fetched, String> {
    async {
        channel_path(&channel)?;
        let _: AppVersion = version.parse().map_err(|_| OnlineError::InvalidRequest)?;
        let _gate = DOWNLOAD_GATE.try_lock().map_err(|_| OnlineError::Busy)?;
        let root: PathBuf = downloads.0.with_file_name(DOWNLOADS);
        let own = app.package_info().version.to_string();
        let progress = move |received, total| {
            let _ = app.emit(PROGRESS_EVENT, FetchProgress { received, total });
        };
        fetch_package(&client()?, &channel, &version, &own, &root, &progress).await
    }
    .await
    .map_err(|e: OnlineError| e.code().to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use markiro_proto::update::distribution::testing::sign_update_manifest;
    use serde_json::json;

    fn fixture() -> (String, String) {
        let name = "markiro-standalone-1.2.0-windows-x86_64-setup.exe";
        let hash = markiro_proto::update::hash_exact(&b"MZ test"[..], 7).unwrap();
        let manifest = sign_update_manifest(&json!({
            "v":1,"product":"markiro-standalone","version":"1.2.0","channel":"stable",
            "releasedAt":"2026-10-30T10:00:00Z","sourceSha":"a".repeat(40),
            "installer":{"name":name,"sha256":hash,"sizeBytes":7},
            "protocol":3,"minProtocol":2,"minUpgradeFrom":"1.0.0","notes":["Signed changes"]
        }));
        let pointer = json!({"v":1,"product":"markiro-standalone","channel":"stable","version":"1.2.0",
            "releasedAt":"2026-10-30T10:00:00Z","notes":["Untrusted notes"],
            "installer":{"url":format!("{ORIGIN}/standalone/stable/1.2.0/{name}"),"sha256":hash,"sizeBytes":7},
            "manifestUrl":format!("{ORIGIN}/standalone/stable/1.2.0/markiro-standalone-1.2.0.update.jws")});
        (pointer.to_string(), manifest)
    }

    fn server(replies: Vec<String>) -> (String, std::thread::JoinHandle<Vec<String>>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = format!("http://{}", listener.local_addr().unwrap());
        let task = std::thread::spawn(move || {
            let mut requests = Vec::new();
            for reply in replies {
                let deadline = std::time::Instant::now() + Duration::from_secs(5);
                let (mut socket, _) = loop {
                    match listener.accept() {
                        Ok(value) => break value,
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                            assert!(
                                std::time::Instant::now() < deadline,
                                "client never requested"
                            );
                            std::thread::sleep(Duration::from_millis(5));
                        }
                        Err(e) => panic!("{e}"),
                    }
                };
                // BSD/macOS can inherit the listener's nonblocking mode.
                // Headers may arrive in several packets: read up to the existing deadline.
                socket.set_nonblocking(false).unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut bytes = Vec::new();
                let mut byte = [0u8; 1];
                while !bytes.ends_with(b"\r\n\r\n") {
                    socket.read_exact(&mut byte).unwrap();
                    bytes.push(byte[0]);
                }
                requests.push(String::from_utf8(bytes).unwrap());
                socket.write_all(reply.as_bytes()).unwrap();
            }
            requests
        });
        (address, task)
    }
    #[test]
    fn the_http_fixture_reads_a_request_arriving_in_separate_packets() {
        use std::io::{Read, Write};
        let (url, task) = server(vec![
            "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK".to_owned(),
        ]);
        let mut stream = std::net::TcpStream::connect(url.trim_start_matches("http://")).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        stream.write_all(b"GET / HTTP/1.1\r\n").unwrap();
        std::thread::sleep(Duration::from_millis(100));
        stream.write_all(b"Host: localhost\r\n\r\n").unwrap();
        let mut answer = String::new();
        stream.read_to_string(&mut answer).unwrap();
        assert!(answer.ends_with("OK"));
        assert_eq!(task.join().unwrap().len(), 1);
    }
    fn http_client() -> reqwest::Client {
        reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(3))
            .build()
            .unwrap()
    }
    #[tokio::test]
    async fn downloads_resume_then_hash_the_whole_file_and_never_accept_corruption() {
        let (_, text) = fixture();
        let manifest = fetch::read_manifest(&text, &trust::update_keyset()).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("installer.partial");
        let (url, task) = server(vec![
            "HTTP/1.1 200 OK\r\nContent-Length: 7\r\nConnection: close\r\n\r\nMZ ".to_owned(),
        ]);
        assert_eq!(
            download(&http_client(), &url, &path, &manifest, &|_, _| {}).await,
            Err(OnlineError::Interrupted)
        );
        task.join().unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"MZ ");
        let (url,task)=server(vec!["HTTP/1.1 206 Partial Content\r\nContent-Length: 4\r\nContent-Range: bytes 3-6/7\r\nConnection: close\r\n\r\ntest".to_owned()]);
        download(&http_client(), &url, &path, &manifest, &|_, _| {})
            .await
            .unwrap();
        assert!(task.join().unwrap()[0]
            .to_lowercase()
            .contains("range: bytes=3-"));
        assert!(matches(&path, &manifest).await);
        std::fs::write(&path, b"corrupt").unwrap();
        assert!(!matches(&path, &manifest).await);
    }
    #[tokio::test]
    async fn oversized_metadata_redirects_wrong_ranges_and_excess_installer_bytes_are_refused() {
        let (url, task) = server(vec![
            "HTTP/1.1 200 OK\r\nContent-Length: 65537\r\nConnection: close\r\n\r\n".to_owned(),
        ]);
        assert_eq!(
            metadata(&http_client(), &url).await,
            Err(OnlineError::TooLong)
        );
        task.join().unwrap();
        let (url,task)=server(vec!["HTTP/1.1 302 Found\r\nLocation: http://evil.test/x\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_owned()]);
        assert_eq!(
            metadata(&http_client(), &url).await,
            Err(OnlineError::Unreachable)
        );
        task.join().unwrap();
        let (_, text) = fixture();
        let m = fetch::read_manifest(&text, &trust::update_keyset()).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("x.partial");
        std::fs::write(&path, b"MZ ").unwrap();
        let (url,task)=server(vec!["HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 0-6/7\r\nContent-Length: 7\r\nConnection: close\r\n\r\nMZ test".to_owned()]);
        assert_eq!(
            download(&http_client(), &url, &path, &m, &|_, _| {}).await,
            Err(OnlineError::Interrupted)
        );
        assert!(!path.exists());
        task.join().unwrap();
        let (url, task) = server(vec![
            "HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\nMZ test!".to_owned(),
        ]);
        assert_eq!(
            download(&http_client(), &url, &path, &m, &|_, _| {}).await,
            Err(OnlineError::TooLong)
        );
        assert!(!path.exists());
        task.join().unwrap();
    }
    #[test]
    fn online_package_path_is_separate_from_the_hosts_package() {
        let data = Path::new("/data");
        let online = data
            .join(DOWNLOADS)
            .join("1.2.0")
            .join("markiro-standalone-1.2.0.update.jws");
        assert!(downloaded_manifest(data, &online));
        assert!(!fetch::downloaded_manifest(
            &data.join(fetch::DOWNLOADS),
            &online
        ));
        assert!(!downloaded_manifest(
            data,
            &data.join("other/1.2.0/markiro-standalone-1.2.0.update.jws")
        ));
    }

    #[tokio::test]
    async fn only_a_complete_verified_download_becomes_a_package_for_the_existing_installer() {
        let (_, text) = fixture();
        let m = fetch::read_manifest(&text, &trust::update_keyset()).unwrap();
        let root = tempfile::tempdir().unwrap();
        let (url, task) = server(vec![
            "HTTP/1.1 200 OK\r\nContent-Length: 7\r\nConnection: close\r\n\r\nMZ ".to_owned(),
        ]);
        assert_eq!(
            store_package(&http_client(), &url, &text, &m, root.path(), &|_, _| {}).await,
            Err(OnlineError::Interrupted)
        );
        task.join().unwrap();
        let target = root.path().join("1.2.0").join(&m.installer.name);
        assert!(!target.exists());
        let (url,task)=server(vec!["HTTP/1.1 206 Partial Content\r\nContent-Length: 4\r\nContent-Range: bytes 3-6/7\r\nConnection: close\r\n\r\ntest".to_owned()]);
        let fetched = store_package(&http_client(), &url, &text, &m, root.path(), &|_, _| {})
            .await
            .unwrap();
        task.join().unwrap();
        let checked = super::super::package::verify(
            Path::new(&fetched.manifest_path),
            &trust::update_keyset(),
        )
        .unwrap();
        assert_eq!(checked.manifest.manifest.version, "1.2.0");
        std::fs::remove_file(&target).unwrap();
        let (url, task) = server(vec![
            "HTTP/1.1 200 OK\r\nContent-Length: 7\r\nConnection: close\r\n\r\ncorrupt".to_owned(),
        ]);
        assert_eq!(
            store_package(&http_client(), &url, &text, &m, root.path(), &|_, _| {}).await,
            Err(OnlineError::HashMismatch)
        );
        task.join().unwrap();
        assert!(!target.exists());
    }

    #[tokio::test]
    async fn a_full_response_restarts_a_partial_and_a_changed_manifest_discards_it() {
        let (_, text) = fixture();
        let m = fetch::read_manifest(&text, &trust::update_keyset()).unwrap();
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("1.2.0");
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join(format!("{}.partial", m.installer.name));
        let manifest = dir.join("markiro-standalone-1.2.0.update.jws");
        std::fs::write(&manifest, &text).unwrap();
        std::fs::write(&path, b"MZ ").unwrap();
        let (url, task) = server(vec![
            "HTTP/1.1 200 OK\r\nContent-Length: 7\r\nConnection: close\r\n\r\nMZ test".to_owned(),
        ]);
        store_package(&http_client(), &url, &text, &m, root.path(), &|_, _| {})
            .await
            .unwrap();
        assert!(task.join().unwrap()[0]
            .to_lowercase()
            .contains("range: bytes=3-"));
        assert_eq!(
            std::fs::read(dir.join(&m.installer.name)).unwrap(),
            b"MZ test"
        );
        std::fs::write(&manifest, "a different previously signed manifest").unwrap();
        std::fs::write(&path, b"old").unwrap();
        let (url, task) = server(vec![
            "HTTP/1.1 200 OK\r\nContent-Length: 7\r\nConnection: close\r\n\r\nMZ test".to_owned(),
        ]);
        store_package(&http_client(), &url, &text, &m, root.path(), &|_, _| {})
            .await
            .unwrap();
        assert!(!task.join().unwrap()[0].to_lowercase().contains("range:"));
        assert!(!path.exists());
    }
    #[test]
    fn signed_notes_and_numeric_versions_decide_the_offer() {
        let (pointer, manifest) = fixture();
        let offer = read_offer(&pointer, &manifest, "stable", "1.1.2").unwrap();
        assert!(offer.newer && offer.compatible);
        assert_eq!(offer.manifest.notes, vec!["Signed changes"]);
        assert!(
            !read_offer(&pointer, &manifest, "stable", "1.10.0")
                .unwrap()
                .newer
        );
        assert!(
            !read_offer(&pointer, &manifest, "stable", "0.9.0")
                .unwrap()
                .compatible
        );
    }

    #[test]
    fn pointer_cannot_change_channel_hash_size_version_or_destination() {
        let (pointer, manifest) = fixture();
        assert!(read_offer(&pointer, &manifest, "beta", "1.1.2").is_err());
        for (field, value) in [
            ("version", json!("1.3.0")),
            ("product", json!("other")),
            ("manifestUrl", json!("https://evil.test/update.jws")),
        ] {
            let mut changed: serde_json::Value = serde_json::from_str(&pointer).unwrap();
            changed[field] = value;
            assert!(read_offer(&changed.to_string(), &manifest, "stable", "1.1.2").is_err());
        }
        for (field, value) in [
            ("sha256", json!("0".repeat(64))),
            ("sizeBytes", json!(8)),
            ("url", json!("https://releases.markiro.app@evil.test/x.exe")),
        ] {
            let mut changed: serde_json::Value = serde_json::from_str(&pointer).unwrap();
            changed["installer"][field] = value;
            assert!(read_offer(&changed.to_string(), &manifest, "stable", "1.1.2").is_err());
        }
        assert!(read_offer(&pointer, "not.a.signature", "stable", "1.1.2").is_err());
        assert!(channel_path("../../other").is_err());
    }
}
