//! Immutable uploads become visible only after full fresh download and native
//! verification. No local acknowledgement is implied by a successful PUT.
use crate::{
    envelope::{self, StagedSnapshot},
    model::{NativeCopyPaths, JSON_CAP, OBJECTS},
    Error, Result,
};
use std::{
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    sync::Arc,
};

pub type TransferFuture<'a> = Pin<Box<dyn Future<Output = Result<()>> + Send + 'a>>;
pub trait ObjectTransport: Send + Sync {
    fn put<'a>(&'a self, name: &'a str, source: &'a Path) -> TransferFuture<'a>;
    fn get<'a>(&'a self, name: &'a str, target: &'a Path) -> TransferFuture<'a>;
}
struct Workspace(PathBuf);
impl Drop for Workspace {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

pub async fn publish<T, F, Fut>(
    remote: &T,
    staged: &StagedSnapshot,
    client_id: &str,
    verify_dir: &Path,
    verify_native: F,
) -> Result<()>
where
    T: ObjectTransport,
    F: FnOnce(NativeCopyPaths) -> Fut,
    Fut: Future<Output = Result<()>>,
{
    staged.complete.validate(client_id)?;
    envelope::private_dir(verify_dir)?;
    let workspace = Arc::new(Workspace(verify_dir.to_owned()));
    let downloaded = verify_dir.join("downloaded");
    envelope::private_dir(&downloaded)?;
    for name in OBJECTS {
        remote.put(name, &staged.dir.join(name)).await?;
    }
    for name in OBJECTS {
        remote.get(name, &downloaded.join(name)).await?;
    }
    // Trusted local commit describes exactly the uploaded immutable objects.
    // It is not published until their newly downloaded bytes pass validation.
    std::fs::copy(
        staged.dir.join("complete.json"),
        downloaded.join("complete.json"),
    )?;
    let client = client_id.to_owned();
    let held = workspace.clone();
    let native = tokio::task::spawn_blocking(move || {
        envelope::open_copy(&downloaded, &client, &held.0.join("native"))
    })
    .await
    .map_err(|_| Error::Integrity)??;
    verify_native(native).await?;
    remote
        .put("complete.json", &staged.dir.join("complete.json"))
        .await?;
    let marker = verify_dir.join("marker.json");
    remote.get("complete.json", &marker).await?;
    let expected = envelope::hash_file(&staged.dir.join("complete.json"), JSON_CAP)?;
    let actual = envelope::hash_file(&marker, JSON_CAP)?;
    if actual != expected {
        return Err(Error::Integrity);
    }
    Ok(())
}
