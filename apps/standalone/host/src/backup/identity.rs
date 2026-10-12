//! The host's identity beside a copy (plan I1): `host.json` and the TLS
//! certificate with its private key, in one file `<name>.identity` next to
//! `<name>.db`. A restore on a new computer puts it back, so every paired
//! device keeps its pairing: the same `hostId`, the same pinned certificate
//! and the same device keys in the copy.
//!
//! The file holds the host's PRIVATE KEY: whoever reads it can answer the
//! stations as their host on the network. It is written owner-only
//! (`0600`) and closed by a [`KeyFileGuard`] before it gets its name: on
//! Windows only SYSTEM, the administrators and the file's owner (the
//! service's account) keep access. The guard closes the still empty file
//! BEFORE the key is written into it, and the key goes through the handle
//! that created the file, never through its name: on Windows that handle
//! is unshared, so nobody can open the file, delete it or rename it while
//! the host writes it (`super::key_file`). A folder that cannot be closed (a
//! FAT32 or exFAT flash drive, a share that refuses ACLs) gets the copy
//! without the identity, and the manifest of that folder names none.
//! Nothing here logs a byte of the key: `Debug` prints the host id, the
//! port and the fingerprint only, and a file that does not parse is
//! reported by line and column, never by its contents.

use std::fs;
use std::io::{Read as _, Write as _};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};

use aws_lc_rs::digest::{digest, SHA256};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::{Deserialize, Serialize};

use super::copy::partial_path;
use super::key_file;
use crate::config::{HostConfig, HostPaths};
use crate::install::{run_checked, Commands};
use crate::tls::TlsIdentity;

/// The identity file format this build writes and reads.
pub const IDENTITY_FORMAT: u32 = 1;

/// The most an identity file may hold. A real one is about 2 KiB; a file
/// beside a copy is read from a folder others can write to, so it is never
/// read whole without this bound.
pub const MAX_IDENTITY_BYTES: u64 = 64 * 1024;

/// What a Windows key file grants once its inherited entries are gone:
/// SYSTEM, the administrators and OWNER RIGHTS (the account that wrote it,
/// the service's), each full control. Nobody else.
pub const KEY_FILE_GRANTS: [&str; 3] = ["*S-1-5-18:F", "*S-1-5-32-544:F", "*S-1-3-4:F"];

/// `<name>.identity` beside the copy `<name>.db`.
pub fn identity_path(db: &Path) -> PathBuf {
    db.with_extension("identity")
}

/// Lower-case hex SHA-256 of `bytes`.
pub fn sha256_hex(bytes: &[u8]) -> String {
    digest(&SHA256, bytes)
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[derive(Debug, thiserror::Error)]
pub enum IdentityError {
    /// A file could not be read; the text names the file, never its contents.
    #[error("{0}")]
    Unreadable(String),
    /// The files read, but they are no usable identity.
    #[error("{0}")]
    Invalid(String),
}

impl IdentityError {
    /// A stable code for the log and for the callers that map a refusal.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Unreadable(_) => "identity_unreadable",
            Self::Invalid(_) => "identity_invalid",
        }
    }
}

/// What a manifest says of the identity beside its copy: enough to check
/// the file before a restore trusts it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentityRef {
    /// SHA-256 of the certificate's DER: the fingerprint devices pin.
    pub fingerprint: String,
    /// Of the identity file.
    pub size_bytes: u64,
    /// Lower-case hex SHA-256 of the identity file.
    pub sha256: String,
}

/// A host identity, checked: a UUID `hostId`, a port, and a private key that
/// matches its certificate.
pub struct HostIdentity {
    host_id: String,
    port: u16,
    tls: TlsIdentity,
}

impl std::fmt::Debug for HostIdentity {
    // The private key must never reach a log.
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("HostIdentity")
            .field("host_id", &self.host_id)
            .field("port", &self.port)
            .field("fingerprint", &self.tls.fingerprint)
            .finish_non_exhaustive()
    }
}

/// The identity file: `host.json`'s two fields and the TLS files in base64.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IdentityFile {
    format: u32,
    host_id: String,
    port: u16,
    /// Base64 of the certificate's DER.
    certificate: String,
    /// Base64 of the PKCS#8 private key's DER.
    private_key: String,
}

impl HostIdentity {
    pub fn new(
        host_id: String,
        port: u16,
        cert_der: Vec<u8>,
        key_der: Vec<u8>,
    ) -> Result<Self, IdentityError> {
        if uuid::Uuid::parse_str(&host_id).is_err() {
            return Err(IdentityError::Invalid(
                "the identity's hostId is not a UUID".into(),
            ));
        }
        if port == 0 {
            return Err(IdentityError::Invalid("the identity's port is 0".into()));
        }
        let tls = TlsIdentity::from_der(cert_der, key_der).map_err(|error| {
            IdentityError::Invalid(format!("the identity's TLS key is unusable: {error}"))
        })?;
        Ok(Self { host_id, port, tls })
    }

    /// The data folder's identity: `host.json` and both TLS files, checked.
    /// Creates nothing.
    pub fn read(paths: &HostPaths) -> Result<Self, IdentityError> {
        let config = HostConfig::load(paths)
            .map_err(|error| IdentityError::Unreadable(error.to_string()))?;
        let tls = TlsIdentity::load(&paths.tls_dir())
            .map_err(|error| IdentityError::Unreadable(error.to_string()))?;
        Ok(Self {
            host_id: config.host_id,
            port: config.port,
            tls,
        })
    }

    pub fn host_id(&self) -> &str {
        &self.host_id
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn fingerprint(&self) -> &str {
        &self.tls.fingerprint
    }

    pub fn cert_der(&self) -> &[u8] {
        &self.tls.cert_der
    }

    /// The private key's DER: only for the files of an identity, never for
    /// a log.
    pub fn key_der(&self) -> &[u8] {
        self.tls.private_der()
    }

    /// `host.json` of this identity.
    pub fn config(&self) -> HostConfig {
        HostConfig {
            host_id: self.host_id.clone(),
            port: self.port,
        }
    }

    /// The same host to a device: the same `hostId`, certificate and key.
    /// The port is no part of it.
    pub fn same_as(&self, other: &Self) -> bool {
        self.host_id == other.host_id
            && self.cert_der() == other.cert_der()
            && self.key_der() == other.key_der()
    }

    pub fn to_file_bytes(&self) -> Vec<u8> {
        let file = IdentityFile {
            format: IDENTITY_FORMAT,
            host_id: self.host_id.clone(),
            port: self.port,
            certificate: STANDARD.encode(self.cert_der()),
            private_key: STANDARD.encode(self.key_der()),
        };
        serde_json::to_vec_pretty(&file).expect("an identity file serializes")
    }

    pub fn from_file_bytes(bytes: &[u8]) -> Result<Self, IdentityError> {
        if bytes.len() as u64 > MAX_IDENTITY_BYTES {
            return Err(IdentityError::Invalid(
                "the identity file is too large".into(),
            ));
        }
        let file: IdentityFile = serde_json::from_slice(bytes).map_err(|error| {
            IdentityError::Invalid(format!(
                "the identity file is no identity (line {}, column {})",
                error.line(),
                error.column()
            ))
        })?;
        if file.format != IDENTITY_FORMAT {
            return Err(IdentityError::Invalid(format!(
                "identity format {} is not {IDENTITY_FORMAT}",
                file.format
            )));
        }
        let cert_der = STANDARD.decode(file.certificate.as_bytes()).map_err(|_| {
            IdentityError::Invalid("the identity's certificate is not base64".into())
        })?;
        let key_der = STANDARD.decode(file.private_key.as_bytes()).map_err(|_| {
            IdentityError::Invalid("the identity's private key is not base64".into())
        })?;
        Self::new(file.host_id, file.port, cert_der, key_der)
    }
}

/// Closes a file that holds the host's private key to everyone but its
/// owner, SYSTEM and the administrators.
pub trait KeyFileGuard: Send + Sync {
    /// Blocking. `Err` is a text for the process log.
    fn protect(&self, path: &Path) -> Result<(), String>;
}

/// Owner-only (`0600`) on Unix, whatever the file was created with; nothing
/// elsewhere.
pub struct OwnerOnly;

impl KeyFileGuard for OwnerOnly {
    fn protect(&self, path: &Path) -> Result<(), String> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(0o600))
                .map_err(|error| format!("{}: {error}", path.display()))?;
        }
        #[cfg(not(unix))]
        let _ = path;
        Ok(())
    }
}

/// Windows: `icacls <file> /inheritance:r /grant:r <KEY_FILE_GRANTS…>`
/// through [`Commands`]. A folder without ACLs (FAT32, exFAT) or a share that
/// refuses them makes icacls fail: the identity then stays out of that
/// folder.
pub struct IcaclsGuard<C> {
    commands: Mutex<C>,
}

impl<C> IcaclsGuard<C> {
    pub fn new(commands: C) -> Self {
        Self {
            commands: Mutex::new(commands),
        }
    }
}

impl<C: Commands + Send> KeyFileGuard for IcaclsGuard<C> {
    fn protect(&self, path: &Path) -> Result<(), String> {
        let mut commands = self.commands.lock().unwrap_or_else(PoisonError::into_inner);
        run_checked(&mut *commands, "icacls", &key_file_acl_args(path))
            .map(|_| ())
            .map_err(|error| error.to_string())
    }
}

/// `icacls <path> /inheritance:r /grant:r <KEY_FILE_GRANTS…>`.
pub fn key_file_acl_args(path: &Path) -> Vec<String> {
    let mut args = vec![
        path.display().to_string(),
        "/inheritance:r".to_owned(),
        "/grant:r".to_owned(),
    ];
    args.extend(KEY_FILE_GRANTS.iter().map(|grant| (*grant).to_owned()));
    args
}

/// The guard of this system: icacls on Windows, owner-only elsewhere.
pub fn platform_guard() -> Arc<dyn KeyFileGuard> {
    #[cfg(windows)]
    {
        Arc::new(IcaclsGuard::new(crate::install::SystemCommands))
    }
    #[cfg(not(windows))]
    {
        Arc::new(OwnerOnly)
    }
}

/// Read `path` whole, but never more than [`MAX_IDENTITY_BYTES`]: a longer
/// file is refused without reading the rest. Blocking.
fn read_bounded(path: &Path) -> Result<Vec<u8>, IdentityError> {
    let text =
        |error: std::io::Error| IdentityError::Unreadable(format!("{}: {error}", path.display()));
    let file = fs::File::open(path).map_err(text)?;
    let mut bytes = Vec::new();
    file.take(MAX_IDENTITY_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(text)?;
    if bytes.len() as u64 > MAX_IDENTITY_BYTES {
        return Err(IdentityError::Invalid(format!(
            "{} is too large for an identity",
            path.display()
        )));
    }
    Ok(bytes)
}

/// Write `bytes` to `<target>.partial`, close it with `guard` while it is
/// still empty, then fill it (synced) through the handle that created it and
/// rename it to `target`. A stale `.partial` (or a link planted under its
/// name) is removed first and the file is created exclusively (unshared on
/// Windows), so nothing is ever written through a link or into a file the
/// guard did not close. A file moved away and replaced while the guard ran
/// (Unix) is wiped, and nothing gets the identity's name.
/// `None`, with nothing of it left, when a step fails; the reason goes to
/// the process log only. Blocking.
fn put_file(target: &Path, bytes: &[u8], guard: &dyn KeyFileGuard) -> Option<()> {
    let partial = partial_path(target);
    let written = (|| -> Result<(), String> {
        let text = |error: std::io::Error| format!("{}: {error}", partial.display());
        match fs::remove_file(&partial) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(text(error)),
        }
        // The handle created here is the only one the key goes through:
        // nothing reopens the file by its name after the guard ran.
        let mut file = key_file::create(&partial).map_err(text)?;
        guard.protect(&partial)?;
        file.write_all(bytes).map_err(text)?;
        file.sync_all().map_err(text)?;
        if !key_file::still_named(&file, &partial).unwrap_or(false) {
            // Moved away and something else put under its name while the
            // guard ran: the key is wiped from this file, wherever it went,
            // and the identity's name is never given to what is there now.
            let _ = file.set_len(0);
            let _ = file.sync_all();
            return Err(format!(
                "{} was moved or replaced while it was closed",
                partial.display()
            ));
        }
        drop(file);
        fs::rename(&partial, target).map_err(text)
    })();
    match written {
        Ok(()) => Some(()),
        Err(reason) => {
            let _ = fs::remove_file(&partial);
            tracing::warn!(
                %reason,
                "the host identity was not put beside the copy: the copy goes without it"
            );
            None
        }
    }
}

/// Put `identity` beside the copy `db`. `None` when the file could not be
/// written or closed: the copy is good without it. Blocking.
pub fn attach(db: &Path, identity: &HostIdentity, guard: &dyn KeyFileGuard) -> Option<IdentityRef> {
    let bytes = identity.to_file_bytes();
    let reference = IdentityRef {
        fingerprint: identity.fingerprint().to_owned(),
        size_bytes: bytes.len() as u64,
        sha256: sha256_hex(&bytes),
    };
    put_file(&identity_path(db), &bytes, guard).map(|()| reference)
}

/// Copy the identity beside `source_db` beside `target_db`, checked against
/// `reference` (the manifest's) and closed by `guard`. `None` when it is
/// missing, differs, or could not be written or closed there. Blocking.
pub fn replicate(
    source_db: &Path,
    target_db: &Path,
    reference: &IdentityRef,
    guard: &dyn KeyFileGuard,
) -> Option<IdentityRef> {
    let source = identity_path(source_db);
    let bytes = match read_bounded(&source) {
        Ok(bytes) => bytes,
        Err(reason) => {
            tracing::warn!(
                %reason,
                "the host identity beside the copy did not read: the second folder gets the copy without it"
            );
            return None;
        }
    };
    if bytes.len() as u64 != reference.size_bytes || sha256_hex(&bytes) != reference.sha256 {
        tracing::warn!(
            file = %source.display(),
            "the host identity beside the copy differs from its manifest: the second folder gets the copy without it"
        );
        return None;
    }
    put_file(&identity_path(target_db), &bytes, guard).map(|()| reference.clone())
}

/// Read the identity beside the copy `db` and check it against its
/// manifest: the size and SHA-256 of `reference`, the copy's `host_id`, the
/// certificate `reference` names. Blocking.
pub fn read_beside(
    db: &Path,
    host_id: &str,
    reference: &IdentityRef,
) -> Result<HostIdentity, String> {
    read_beside_coded(db, host_id, reference).map_err(|error| error.to_string())
}

/// [`read_beside`] with the kind of refusal: [`IdentityError::Unreadable`]
/// for a file that cannot be read, [`IdentityError::Invalid`] for one that
/// reads but is too large, differs from the manifest, is no identity or is
/// of another host. The text never holds a byte of the key.
pub fn read_beside_coded(
    db: &Path,
    host_id: &str,
    reference: &IdentityRef,
) -> Result<HostIdentity, IdentityError> {
    let path = identity_path(db);
    let bytes = read_bounded(&path)?;
    if bytes.len() as u64 != reference.size_bytes || sha256_hex(&bytes) != reference.sha256 {
        return Err(IdentityError::Invalid(format!(
            "{} does not match the manifest (size or SHA-256)",
            path.display()
        )));
    }
    let identity = HostIdentity::from_file_bytes(&bytes)?;
    if identity.host_id() != host_id {
        return Err(IdentityError::Invalid(format!(
            "{} is the identity of another host than the copy's",
            path.display()
        )));
    }
    if identity.fingerprint() != reference.fingerprint {
        return Err(IdentityError::Invalid(format!(
            "{} holds another certificate than the manifest names",
            path.display()
        )));
    }
    Ok(identity)
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;
    use crate::install::{CommandOutput, InstallError};

    const HOST: &str = "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
    const OTHER: &str = "0b7a6c5d-4e3f-4a2b-9c1d-8e7f6a5b4c3d";
    const COPY: &str = "markiro-host-20261009T140000Z-7c1e2a9b.db";

    /// A fresh identity of `host_id`, as a host makes it on its first start.
    fn made(dir: &Path, host_id: &str) -> HostIdentity {
        let tls = TlsIdentity::load_or_create(dir, host_id).unwrap();
        HostIdentity::new(
            host_id.to_owned(),
            45710,
            tls.cert_der.clone(),
            tls.private_der().to_vec(),
        )
        .unwrap()
    }

    /// A folder that cannot be closed: a FAT32 flash drive, a share that
    /// refuses ACLs.
    struct Refusing;

    impl KeyFileGuard for Refusing {
        fn protect(&self, _path: &Path) -> Result<(), String> {
            Err("icacls ended with code 5".to_owned())
        }
    }

    /// Records how long the file was when it was closed.
    #[derive(Default)]
    struct Measuring {
        sizes: Mutex<Vec<u64>>,
    }

    impl KeyFileGuard for Measuring {
        fn protect(&self, path: &Path) -> Result<(), String> {
            self.sizes
                .lock()
                .unwrap()
                .push(fs::metadata(path).unwrap().len());
            Ok(())
        }
    }

    type Calls = Arc<Mutex<Vec<(String, Vec<String>)>>>;

    struct Recorded {
        code: i32,
        calls: Calls,
    }

    impl Commands for Recorded {
        fn run(&mut self, program: &str, args: &[String]) -> Result<CommandOutput, InstallError> {
            self.calls
                .lock()
                .unwrap()
                .push((program.to_owned(), args.to_vec()));
            Ok(CommandOutput {
                code: Some(self.code),
                stdout: Vec::new(),
            })
        }
    }

    /// The identity file with one JSON member replaced.
    fn with_member(identity: &HostIdentity, name: &str, value: serde_json::Value) -> Vec<u8> {
        let mut json: serde_json::Value =
            serde_json::from_slice(&identity.to_file_bytes()).unwrap();
        json[name] = value;
        serde_json::to_vec(&json).unwrap()
    }

    /// The identity file padded with trailing blanks to `len` bytes.
    fn padded(identity: &HostIdentity, len: u64) -> Vec<u8> {
        let mut bytes = identity.to_file_bytes();
        assert!((bytes.len() as u64) < len);
        bytes.resize(len as usize, b' ');
        bytes
    }

    fn reference_of(bytes: &[u8], identity: &HostIdentity) -> IdentityRef {
        IdentityRef {
            fingerprint: identity.fingerprint().to_owned(),
            size_bytes: bytes.len() as u64,
            sha256: sha256_hex(bytes),
        }
    }

    #[test]
    fn the_hash_a_manifest_names_is_lower_case_hex_sha256() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn an_identity_file_reads_back_as_the_same_host() {
        let dir = tempfile::tempdir().unwrap();
        let identity = made(dir.path(), HOST);
        let read = HostIdentity::from_file_bytes(&identity.to_file_bytes()).unwrap();
        assert!(read.same_as(&identity));
        assert_eq!(
            (read.host_id(), read.port(), read.fingerprint()),
            (HOST, 45710, identity.fingerprint())
        );
        assert_eq!(
            read.config(),
            HostConfig {
                host_id: HOST.to_owned(),
                port: 45710
            }
        );
    }

    #[test]
    fn a_key_of_another_certificate_or_a_bad_host_id_is_no_identity() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let first = made(a.path(), HOST);
        let second = made(b.path(), OTHER);
        let new = |host_id: &str, port: u16, key: &[u8]| {
            HostIdentity::new(
                host_id.to_owned(),
                port,
                first.cert_der().to_vec(),
                key.to_vec(),
            )
        };
        assert!(matches!(
            new(HOST, 45710, second.key_der()),
            Err(IdentityError::Invalid(_))
        ));
        assert!(matches!(
            new("host-1", 45710, first.key_der()),
            Err(IdentityError::Invalid(_))
        ));
        assert!(matches!(
            new(HOST, 0, first.key_der()),
            Err(IdentityError::Invalid(_))
        ));
        assert!(!first.same_as(&second));
    }

    #[test]
    fn nothing_prints_the_private_key() {
        let dir = tempfile::tempdir().unwrap();
        let identity = made(dir.path(), HOST);
        let key = STANDARD.encode(identity.key_der());
        let printed = format!("{identity:?}");
        assert!(
            printed.contains(identity.fingerprint()) && !printed.contains(&key),
            "{printed}"
        );
        let mut damaged = identity.to_file_bytes();
        damaged.truncate(damaged.len() / 2);
        let error = HostIdentity::from_file_bytes(&damaged)
            .unwrap_err()
            .to_string();
        assert!(!error.contains(&key[..16]), "{error}");
    }

    #[test]
    fn a_refusal_names_no_part_of_the_key_and_has_a_stable_code() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let first = made(a.path(), HOST);
        let second = made(b.path(), OTHER);
        let key = STANDARD.encode(first.key_der());
        let other_key = STANDARD.encode(second.key_der());
        let refusals = [
            HostIdentity::new(
                HOST.to_owned(),
                45710,
                first.cert_der().to_vec(),
                second.key_der().to_vec(),
            )
            .unwrap_err(),
            HostIdentity::from_file_bytes(&with_member(&first, "privateKey", "!!!".into()))
                .unwrap_err(),
            HostIdentity::from_file_bytes(&with_member(&first, "certificate", "!!!".into()))
                .unwrap_err(),
            HostIdentity::from_file_bytes(&with_member(&first, "format", 2.into())).unwrap_err(),
            HostIdentity::from_file_bytes(&with_member(&first, "extra", key.clone().into()))
                .unwrap_err(),
            HostIdentity::from_file_bytes(&with_member(&first, "port", key.clone().into()))
                .unwrap_err(),
        ];
        for error in &refusals {
            let text = error.to_string();
            assert!(
                !text.contains(&key[..16]) && !text.contains(&other_key[..16]),
                "{text}"
            );
            assert_eq!(error.code(), "identity_invalid", "{text}");
        }
        assert_eq!(
            IdentityError::Unreadable(String::new()).code(),
            "identity_unreadable"
        );
    }

    #[test]
    fn a_file_of_another_format_or_with_foreign_members_or_bad_base64_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let identity = made(dir.path(), HOST);
        let format = HostIdentity::from_file_bytes(&with_member(&identity, "format", 2.into()))
            .unwrap_err()
            .to_string();
        assert!(format.contains("format 2"), "{format}");
        let extra = HostIdentity::from_file_bytes(&with_member(&identity, "extra", 1.into()))
            .unwrap_err()
            .to_string();
        assert!(extra.contains("line"), "{extra}");
        let key =
            HostIdentity::from_file_bytes(&with_member(&identity, "privateKey", "!!!".into()))
                .unwrap_err()
                .to_string();
        assert!(key.contains("private key is not base64"), "{key}");
        let certificate =
            HostIdentity::from_file_bytes(&with_member(&identity, "certificate", "!!!".into()))
                .unwrap_err()
                .to_string();
        assert!(
            certificate.contains("certificate is not base64"),
            "{certificate}"
        );
    }

    #[test]
    fn two_hosts_are_the_same_only_by_host_id_certificate_and_key() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let first = made(a.path(), HOST);
        // Same host id, another certificate and key.
        let reissued = made(b.path(), HOST);
        assert!(!first.same_as(&reissued));
        // Same certificate and key, another host id.
        let renamed = HostIdentity::new(
            OTHER.to_owned(),
            45710,
            first.cert_der().to_vec(),
            first.key_der().to_vec(),
        )
        .unwrap();
        assert!(!first.same_as(&renamed));
        // Same host id and key, another certificate over that key.
        let key_pair = rcgen::KeyPair::try_from(first.key_der()).unwrap();
        let reissued_cert = rcgen::CertificateParams::new(vec!["reissued.example".to_owned()])
            .unwrap()
            .self_signed(&key_pair)
            .unwrap();
        let recertified = HostIdentity::new(
            HOST.to_owned(),
            45710,
            reissued_cert.der().to_vec(),
            first.key_der().to_vec(),
        )
        .unwrap();
        assert_ne!(recertified.fingerprint(), first.fingerprint());
        assert!(!first.same_as(&recertified));
        // The port is no part of it.
        let moved = HostIdentity::new(
            HOST.to_owned(),
            45711,
            first.cert_der().to_vec(),
            first.key_der().to_vec(),
        )
        .unwrap();
        assert!(first.same_as(&moved));
    }

    #[test]
    fn the_data_folders_identity_is_read_without_creating_anything() {
        let dir = tempfile::tempdir().unwrap();
        let paths = HostPaths::new(dir.path());
        assert!(matches!(
            HostIdentity::read(&paths),
            Err(IdentityError::Unreadable(_))
        ));
        assert!(
            fs::read_dir(dir.path()).unwrap().next().is_none(),
            "nothing was created"
        );
        paths.ensure().unwrap();
        let config = HostConfig::load_or_create(&paths, None).unwrap();
        assert!(
            matches!(
                HostIdentity::read(&paths),
                Err(IdentityError::Unreadable(_))
            ),
            "no TLS files yet"
        );
        let tls = TlsIdentity::load_or_create(&paths.tls_dir(), &config.host_id).unwrap();
        let read = HostIdentity::read(&paths).unwrap();
        assert_eq!(
            (read.host_id(), read.fingerprint()),
            (config.host_id.as_str(), tls.fingerprint.as_str())
        );
    }

    #[test]
    fn an_identity_goes_beside_its_copy_only_when_it_could_be_closed() {
        let keys = tempfile::tempdir().unwrap();
        let identity = made(keys.path(), HOST);
        let copies = tempfile::tempdir().unwrap();
        let db = copies.path().join(COPY);
        assert_eq!(attach(&db, &identity, &Refusing), None);
        assert!(
            fs::read_dir(copies.path()).unwrap().next().is_none(),
            "nothing of it is left"
        );
        let reference = attach(&db, &identity, &OwnerOnly).expect("written and closed");
        assert_eq!(reference.fingerprint, identity.fingerprint());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(identity_path(&db))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        assert!(read_beside(&db, HOST, &reference)
            .unwrap()
            .same_as(&identity));
        assert!(read_beside(&db, OTHER, &reference)
            .unwrap_err()
            .contains("another host"));
        let mut bytes = fs::read(identity_path(&db)).unwrap();
        bytes[10] ^= 1;
        fs::write(identity_path(&db), &bytes).unwrap();
        assert!(read_beside(&db, HOST, &reference)
            .unwrap_err()
            .contains("does not match the manifest"));
    }

    #[test]
    fn the_second_folder_gets_the_identity_only_as_the_manifest_names_it() {
        let keys = tempfile::tempdir().unwrap();
        let local = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let identity = made(keys.path(), HOST);
        let source = local.path().join(COPY);
        let target = second.path().join(COPY);
        let reference = attach(&source, &identity, &OwnerOnly).unwrap();
        assert_eq!(replicate(&source, &target, &reference, &Refusing), None);
        assert!(!identity_path(&target).exists());
        assert_eq!(
            replicate(&source, &target, &reference, &OwnerOnly),
            Some(reference.clone())
        );
        assert_eq!(
            fs::read(identity_path(&target)).unwrap(),
            fs::read(identity_path(&source)).unwrap()
        );
        let changed = IdentityRef {
            sha256: "0".repeat(64),
            ..reference
        };
        let elsewhere = second
            .path()
            .join("markiro-host-20261009T150000Z-0d4f6b21.db");
        assert_eq!(replicate(&source, &elsewhere, &changed, &OwnerOnly), None);
        assert!(!identity_path(&elsewhere).exists());
    }

    #[test]
    fn a_size_or_a_hash_that_differs_from_the_manifest_refuses_the_file() {
        let keys = tempfile::tempdir().unwrap();
        let identity = made(keys.path(), HOST);
        let copies = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let db = copies.path().join(COPY);
        let target = second.path().join(COPY);
        let good = attach(&db, &identity, &OwnerOnly).unwrap();
        let wrong_size = IdentityRef {
            size_bytes: good.size_bytes + 1,
            ..good.clone()
        };
        let wrong_hash = IdentityRef {
            sha256: "0".repeat(64),
            ..good.clone()
        };
        for reference in [&wrong_size, &wrong_hash] {
            assert!(read_beside(&db, HOST, reference)
                .unwrap_err()
                .contains("does not match the manifest"));
            assert_eq!(replicate(&db, &target, reference, &OwnerOnly), None);
            assert!(!identity_path(&target).exists());
        }
        let other_certificate = IdentityRef {
            fingerprint: "0".repeat(64),
            ..good.clone()
        };
        assert!(read_beside(&db, HOST, &other_certificate)
            .unwrap_err()
            .contains("another certificate"));
        assert!(read_beside(&db, HOST, &good).is_ok());
    }

    #[test]
    fn a_missing_identity_file_is_no_identity_for_either_reader() {
        let keys = tempfile::tempdir().unwrap();
        let identity = made(keys.path(), HOST);
        let copies = tempfile::tempdir().unwrap();
        let db = copies.path().join(COPY);
        let reference = attach(&db, &identity, &OwnerOnly).unwrap();
        fs::remove_file(identity_path(&db)).unwrap();
        assert!(read_beside(&db, HOST, &reference).is_err());
        let target = copies
            .path()
            .join("markiro-host-20261009T150000Z-0d4f6b21.db");
        assert_eq!(replicate(&db, &target, &reference, &OwnerOnly), None);
        assert!(!identity_path(&target).exists());
    }

    #[test]
    fn a_file_beyond_the_bound_is_never_read_whole_nor_parsed() {
        let keys = tempfile::tempdir().unwrap();
        let identity = made(keys.path(), HOST);
        // Exactly at the bound the identity still reads; one byte more does not.
        let at_bound = padded(&identity, MAX_IDENTITY_BYTES);
        assert!(HostIdentity::from_file_bytes(&at_bound).is_ok());
        let beyond = padded(&identity, MAX_IDENTITY_BYTES + 1);
        assert!(HostIdentity::from_file_bytes(&beyond)
            .unwrap_err()
            .to_string()
            .contains("too large"));
        // On disk, with a manifest that vouches for every byte of it: the
        // reader still refuses to read it.
        let copies = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let db = copies.path().join(COPY);
        fs::write(identity_path(&db), &beyond).unwrap();
        let reference = reference_of(&beyond, &identity);
        let error = read_beside(&db, HOST, &reference).unwrap_err();
        assert!(error.contains("too large"), "{error}");
        let target = second.path().join(COPY);
        assert_eq!(replicate(&db, &target, &reference, &OwnerOnly), None);
        assert!(!identity_path(&target).exists());
        fs::write(identity_path(&db), &at_bound).unwrap();
        let reference = reference_of(&at_bound, &identity);
        assert!(read_beside(&db, HOST, &reference).is_ok());
        assert!(replicate(&db, &target, &reference, &OwnerOnly).is_some());
    }

    #[test]
    fn the_key_is_never_in_the_file_before_the_file_is_closed() {
        let keys = tempfile::tempdir().unwrap();
        let identity = made(keys.path(), HOST);
        let copies = tempfile::tempdir().unwrap();
        let db = copies.path().join(COPY);
        let guard = Measuring::default();
        let reference = attach(&db, &identity, &guard).expect("written");
        assert_eq!(*guard.sizes.lock().unwrap(), [0], "closed while empty");
        assert_eq!(
            fs::metadata(identity_path(&db)).unwrap().len(),
            reference.size_bytes
        );
        assert!(read_beside(&db, HOST, &reference)
            .unwrap()
            .same_as(&identity));
    }

    #[test]
    fn a_refused_identity_leaves_the_one_beside_the_copy_as_it_was() {
        let keys = tempfile::tempdir().unwrap();
        let first = made(keys.path(), HOST);
        let other_keys = tempfile::tempdir().unwrap();
        let second = made(other_keys.path(), OTHER);
        let copies = tempfile::tempdir().unwrap();
        let db = copies.path().join(COPY);
        let reference = attach(&db, &first, &OwnerOnly).unwrap();
        let before = fs::read(identity_path(&db)).unwrap();
        assert_eq!(attach(&db, &second, &Refusing), None);
        assert_eq!(fs::read(identity_path(&db)).unwrap(), before);
        assert!(!partial_path(&identity_path(&db)).exists());
        // A good write replaces it whole.
        let replaced = attach(&db, &second, &OwnerOnly).unwrap();
        assert_ne!(replaced, reference);
        assert!(read_beside(&db, OTHER, &replaced).unwrap().same_as(&second));
    }

    #[cfg(unix)]
    #[test]
    fn a_stale_or_planted_partial_is_never_written_through() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let keys = tempfile::tempdir().unwrap();
        let identity = made(keys.path(), HOST);
        let copies = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        let victim = elsewhere.path().join("victim.txt");
        fs::write(&victim, b"untouched").unwrap();
        let db = copies.path().join(COPY);
        let partial = partial_path(&identity_path(&db));
        symlink(&victim, &partial).unwrap();
        let reference = attach(&db, &identity, &OwnerOnly).expect("written");
        assert_eq!(fs::read(&victim).unwrap(), b"untouched");
        assert!(read_beside(&db, HOST, &reference)
            .unwrap()
            .same_as(&identity));
        // A stale open-mode partial is replaced, not reused.
        fs::write(&partial, b"stale").unwrap();
        fs::set_permissions(&partial, fs::Permissions::from_mode(0o644)).unwrap();
        attach(&db, &identity, &OwnerOnly).expect("written again");
        assert!(!partial.exists());
        let mode = fs::metadata(identity_path(&db))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    /// Someone with rights on the folder moves the empty partial away while
    /// the guard closes it, puts a file of their own under its name and
    /// keeps it open to read whatever the host writes into it.
    #[derive(Default)]
    struct Swapping {
        aside: Mutex<Option<PathBuf>>,
        planted: Mutex<Option<fs::File>>,
    }

    impl KeyFileGuard for Swapping {
        fn protect(&self, path: &Path) -> Result<(), String> {
            let aside = path.with_file_name("moved-away");
            // On Windows the host's unshared handle refuses the move.
            if fs::rename(path, &aside).is_ok() {
                fs::write(path, b"planted").unwrap();
                *self.planted.lock().unwrap() = Some(fs::File::open(path).unwrap());
                *self.aside.lock().unwrap() = Some(aside);
            }
            Ok(())
        }
    }

    #[test]
    fn a_partial_swapped_while_it_is_closed_never_gets_the_key_nor_the_identitys_name() {
        let keys = tempfile::tempdir().unwrap();
        let identity = made(keys.path(), HOST);
        let copies = tempfile::tempdir().unwrap();
        let db = copies.path().join(COPY);
        let guard = Swapping::default();
        let reference = attach(&db, &identity, &guard);
        let aside = guard.aside.lock().unwrap().take();
        assert_eq!(aside.is_none(), cfg!(windows), "{aside:?}");
        match aside {
            None => {
                let reference = reference.expect("written");
                assert!(read_beside(&db, HOST, &reference)
                    .unwrap()
                    .same_as(&identity));
            }
            Some(aside) => {
                assert_eq!(reference, None);
                let mut planted = Vec::new();
                guard
                    .planted
                    .lock()
                    .unwrap()
                    .take()
                    .unwrap()
                    .read_to_end(&mut planted)
                    .unwrap();
                // Compared without printing: a failure must not show a key.
                assert!(
                    planted == b"planted",
                    "no key byte reached the planted file"
                );
                assert!(
                    fs::symlink_metadata(identity_path(&db)).is_err(),
                    "nothing took the identity's name"
                );
                assert_eq!(
                    fs::metadata(&aside).unwrap().len(),
                    0,
                    "the key is wiped from the file moved away"
                );
            }
        }
    }

    /// Moves the empty partial away while the guard closes it and puts a
    /// link to a file in another folder under its name.
    #[cfg(unix)]
    struct Linking {
        victim: PathBuf,
    }

    #[cfg(unix)]
    impl KeyFileGuard for Linking {
        fn protect(&self, path: &Path) -> Result<(), String> {
            fs::rename(path, path.with_file_name("moved-away")).unwrap();
            std::os::unix::fs::symlink(&self.victim, path).unwrap();
            Ok(())
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_partial_swapped_for_a_link_while_it_is_closed_writes_nothing_through_it() {
        let keys = tempfile::tempdir().unwrap();
        let identity = made(keys.path(), HOST);
        let copies = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        let victim = elsewhere.path().join("victim.txt");
        fs::write(&victim, b"untouched").unwrap();
        let db = copies.path().join(COPY);
        let guard = Linking {
            victim: victim.clone(),
        };
        assert_eq!(attach(&db, &identity, &guard), None);
        // Compared without printing: a failure must not show a key.
        assert!(fs::read(&victim).unwrap() == b"untouched");
        assert!(fs::symlink_metadata(identity_path(&db)).is_err());
        let left: Vec<_> = fs::read_dir(copies.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(left, ["moved-away"], "the planted link went");
        assert_eq!(
            fs::metadata(copies.path().join("moved-away"))
                .unwrap()
                .len(),
            0
        );
    }

    #[cfg(unix)]
    #[test]
    fn owner_only_takes_every_right_from_group_and_others_whatever_the_file_had() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("key.identity");
        fs::write(&file, b"x").unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap();
        OwnerOnly.protect(&file).unwrap();
        assert_eq!(
            fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
        fs::set_permissions(&file, fs::Permissions::from_mode(0o666)).unwrap();
        platform_guard().protect(&file).unwrap();
        assert_eq!(
            fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert!(OwnerOnly.protect(&dir.path().join("missing")).is_err());
    }

    #[test]
    fn windows_closes_the_key_file_to_all_but_system_the_administrators_and_its_owner() {
        let path = Path::new(
            r"\\ADMIN-PC\MarkiroCopies\markiro-host-20261009T140000Z-7c1e2a9b.identity.partial",
        );
        assert_eq!(
            key_file_acl_args(path),
            [
                path.display().to_string(),
                "/inheritance:r".to_owned(),
                "/grant:r".to_owned(),
                "*S-1-5-18:F".to_owned(),
                "*S-1-5-32-544:F".to_owned(),
                "*S-1-3-4:F".to_owned(),
            ]
        );
        let calls: Calls = Arc::default();
        let guard = IcaclsGuard::new(Recorded {
            code: 0,
            calls: calls.clone(),
        });
        guard.protect(path).unwrap();
        assert_eq!(
            *calls.lock().unwrap(),
            [("icacls".to_owned(), key_file_acl_args(path))]
        );
        let refused = IcaclsGuard::new(Recorded {
            code: 1332,
            calls: Arc::default(),
        });
        assert_eq!(
            refused.protect(path).unwrap_err(),
            "icacls ended with code 1332"
        );
    }
}
