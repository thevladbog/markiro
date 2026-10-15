//! The host's update packages (plan ОБН-3, spec §10.11.2) in `updates\` of
//! the data folder: at most `staged\` (newer than the running host),
//! `current\` (the running host's version: the one devices get),
//! `previous\` (the current before it, for a rollback of the host) and one
//! `incoming-<id>.partial\` upload. Each package folder holds
//! `manifest.update.jws` and the installer under the manifest's name. None of
//! it goes into a copy of the database, and `markiro-host restore` never
//! touches it: the package is no data of the site, and its authenticity
//! rests on its signature, which every device checks itself.

pub mod limits;
pub mod store;
pub mod stream;
pub mod worker;

pub use store::{
    check_manifest, CheckedManifest, FileStamp, ManifestRefusal, Package, Promotion, Serve,
    StartReport, UpdateStore, Upload, UploadError, Verification, CURRENT, MANIFEST_FILE, PREVIOUS,
    STAGED,
};

use std::sync::Arc;

use markiro_proto::update::distribution::PackageState;

/// [`UpdateStore::serve_blocking`] for an async handler: a package whose
/// files changed is checked again in the background, and this answer is
/// `verifying` (spec §10.11.2).
pub async fn serve(store: &Arc<UpdateStore>) -> Result<Package, PackageState> {
    let checking = store.clone();
    match tokio::task::spawn_blocking(move || checking.serve_blocking()).await {
        Ok(Serve::Ready(package)) => Ok(package),
        Ok(Serve::Changed) => {
            let verifying = store.clone();
            let check = tokio::task::spawn_blocking(move || verifying.reverify_blocking());
            // A check that panicked must not leave `verifying` for good.
            let store = store.clone();
            tokio::spawn(async move {
                if check.await.is_err() {
                    store.fail_verifying();
                }
            });
            Err(PackageState::Verifying)
        }
        Ok(Serve::Unavailable(state)) => Err(state),
        Err(_) => Err(PackageState::Invalid),
    }
}
