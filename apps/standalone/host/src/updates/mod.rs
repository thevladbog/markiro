//! The host's update packages (plan ОБН-3, spec §10.11.2) in `updates\` of
//! the data folder: at most `staged\` (newer than the running host),
//! `current\` (the running host's version: the one devices get),
//! `previous\` (the current before it, for a rollback of the host) and one
//! `incoming-<id>.partial\` upload. Each package folder holds
//! `manifest.update.jws` and the installer under the manifest's name. None of
//! it goes into a copy of the database, and `markiro-host restore` never
//! touches it: the package is no data of the site, and its authenticity
//! rests on its signature, which every device checks itself.

pub mod store;

pub use store::{
    check_manifest, CheckedManifest, FileStamp, ManifestRefusal, Package, Promotion, Serve,
    StartReport, UpdateStore, Upload, UploadError, CURRENT, MANIFEST_FILE, PREVIOUS, STAGED,
};
