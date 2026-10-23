//! Bounded binary age streams. Only a fully verified set returns native paths.
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

use age::secrecy::ExposeSecret;
use aws_lc_rs::digest::{Context, SHA256};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::{model::*, Error, Result};

#[derive(Debug)]
pub struct StagedSnapshot {
    pub dir: PathBuf,
    pub complete: CompleteManifestV1,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeManifest {
    format: u32,
    file: String,
    host_id: Uuid,
    created_at: String,
    schema_version: i64,
    size_bytes: u64,
    sha256: String,
    identity: NativeIdentityRef,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeIdentityRef {
    fingerprint: String,
    size_bytes: u64,
    sha256: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RecoveryKeyV1 {
    format: u32,
    host_id: Uuid,
    snapshot_id: SnapshotId,
    identity: String,
}
impl Drop for RecoveryKeyV1 {
    fn drop(&mut self) {
        zeroize::Zeroize::zeroize(&mut self.identity);
    }
}

/// Create a new private directory. Never write a key before its ACL succeeds.
pub fn private_dir(path: &Path) -> Result<()> {
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)?;
    #[cfg(windows)]
    {
        let status = std::process::Command::new("icacls")
            .arg(path)
            .args([
                "/inheritance:r",
                "/grant:r",
                "*S-1-5-18:(OI)(CI)F",
                "*S-1-5-32-544:(OI)(CI)F",
                "*S-1-3-4:(OI)(CI)F",
            ])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()?;
        if !status.success() {
            let _ = fs::remove_dir(path);
            return Err(Error::SecretUnavailable);
        }
    }
    Ok(())
}

pub fn private_file(path: &Path) -> Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(0);
    }
    Ok(options.open(path)?)
}

pub fn read_bounded(path: &Path, cap: u64) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    File::open(path)?.take(cap + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > cap {
        return Err(Error::SizeLimit);
    }
    Ok(bytes)
}

pub fn hash_file(path: &Path, cap: u64) -> Result<ObjectRef> {
    let mut hash = Context::new(&SHA256);
    let mut reader = File::open(path)?;
    let mut buffer = [0u8; 64 * 1024];
    let mut size = 0u64;
    loop {
        let n = reader.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        size += n as u64;
        if size > cap {
            return Err(Error::SizeLimit);
        }
        hash.update(&buffer[..n]);
    }
    Ok(ObjectRef {
        size_bytes: size,
        sha256: hash
            .finish()
            .as_ref()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect(),
    })
}

fn copy_bounded(mut reader: impl Read, mut writer: impl Write, cap: u64) -> Result<()> {
    let mut buffer = Zeroizing::new([0u8; 64 * 1024]);
    let mut total = 0;
    loop {
        let n = reader.read(buffer.as_mut())?;
        if n == 0 {
            break;
        }
        total += n as u64;
        if total > cap {
            return Err(Error::SizeLimit);
        }
        writer.write_all(&buffer[..n])?;
    }
    Ok(())
}

fn write_json(path: &Path, value: &impl Serialize) -> Result<()> {
    let bytes = Zeroizing::new(serde_json::to_vec(value).map_err(|_| Error::InvalidFormat)?);
    if bytes.len() as u64 > JSON_CAP {
        return Err(Error::SizeLimit);
    }
    let mut file = private_file(path)?;
    file.write_all(&bytes)?;
    file.sync_all()?;
    Ok(())
}

fn read_native(paths: &NativeCopyPaths) -> Result<NativeManifest> {
    let manifest: NativeManifest =
        serde_json::from_slice(&read_bounded(&paths.manifest, SMALL_FILE_CAP)?)
            .map_err(|_| Error::InvalidFormat)?;
    // The old name must stay in the unchanged native manifest. It is a basename,
    // never a path from cloud metadata; restore_with checks it again.
    if manifest.format != 1
        || !manifest.file.starts_with("markiro-host-")
        || !manifest.file.ends_with(".db")
        || manifest.file.len() > 128
        || !manifest
            .file
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
        || manifest.file.contains("..")
        || paths.database.file_name().and_then(|s| s.to_str()) != Some(&manifest.file)
    {
        return Err(Error::InvalidFormat);
    }
    if hash_file(&paths.database, DATABASE_CAP)?
        != (ObjectRef {
            size_bytes: manifest.size_bytes,
            sha256: manifest.sha256.clone(),
        })
        || hash_file(&paths.identity, SMALL_FILE_CAP)?
            != (ObjectRef {
                size_bytes: manifest.identity.size_bytes,
                sha256: manifest.identity.sha256.clone(),
            })
    {
        return Err(Error::Integrity);
    }
    let identity: serde_json::Value =
        serde_json::from_slice(&read_bounded(&paths.identity, SMALL_FILE_CAP)?)
            .map_err(|_| Error::InvalidFormat)?;
    if identity.get("format").and_then(|v| v.as_u64()) != Some(1)
        || identity.get("hostId").and_then(|v| v.as_str()) != Some(&manifest.host_id.to_string())
    {
        return Err(Error::Integrity);
    }
    Ok(manifest)
}

pub fn seal_copy(
    source: &NativeCopyPaths,
    profile: &ClientProfile,
    stage: &Path,
    id: SnapshotId,
) -> Result<StagedSnapshot> {
    seal_copy_with_metadata(
        source,
        profile,
        stage,
        id,
        SnapshotMetadata {
            app_version: env!("CARGO_PKG_VERSION").into(),
            organization_label: String::new(),
            inn: String::new(),
        },
    )
}

pub struct SnapshotMetadata {
    pub app_version: String,
    pub organization_label: String,
    pub inn: String,
}

pub fn seal_copy_with_metadata(
    source: &NativeCopyPaths,
    profile: &ClientProfile,
    stage: &Path,
    id: SnapshotId,
    metadata: SnapshotMetadata,
) -> Result<StagedSnapshot> {
    profile.validate()?;
    let native = read_native(source)?;
    private_dir(stage)?;
    let result = (|| {
        let key = age::x25519::Identity::generate();
        let recipient = key.to_public();
        for (name, path, cap) in [
            ("database.age", &source.database, DATABASE_CAP),
            ("manifest.age", &source.manifest, SMALL_FILE_CAP),
            ("host-identity.age", &source.identity, SMALL_FILE_CAP),
        ] {
            let encryptor =
                age::Encryptor::with_recipients(std::iter::once(&recipient as &dyn age::Recipient))
                    .map_err(|_| Error::Crypto)?;
            let mut file = private_file(&stage.join(name))?;
            let mut stream = encryptor
                .wrap_output(&mut file)
                .map_err(|_| Error::Crypto)?;
            copy_bounded(File::open(path)?, &mut stream, cap)?;
            stream.finish().map_err(|_| Error::Crypto)?;
            file.sync_all()?;
        }
        write_json(
            &stage.join("recovery-key.json"),
            &RecoveryKeyV1 {
                format: 1,
                host_id: native.host_id,
                snapshot_id: id,
                identity: key.to_string().expose_secret().to_owned(),
            },
        )?;
        let mut objects = BTreeMap::new();
        for name in OBJECTS {
            objects.insert(
                name.into(),
                hash_file(&stage.join(name), object_cap(name)?)?,
            );
        }
        let complete = CompleteManifestV1 {
            format: 1,
            host_id: native.host_id,
            snapshot_id: id,
            created_at: native.created_at,
            schema_version: native.schema_version,
            app_version: metadata.app_version,
            organization_label: metadata.organization_label,
            inn: metadata.inn,
            oauth_client_id: profile.client_id.clone(),
            tls_fingerprint: native.identity.fingerprint,
            native_db_sha256: native.sha256,
            objects,
        };
        complete.validate(&profile.client_id)?;
        write_json(&stage.join("complete.json"), &complete)?;
        Ok(StagedSnapshot {
            dir: stage.to_owned(),
            complete,
        })
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(stage);
    }
    result
}

pub fn read_complete(stage: &Path, client_id: &str) -> Result<CompleteManifestV1> {
    let complete: CompleteManifestV1 =
        serde_json::from_slice(&read_bounded(&stage.join("complete.json"), JSON_CAP)?)
            .map_err(|_| Error::InvalidFormat)?;
    complete.validate(client_id)?;
    Ok(complete)
}

/// The caller must still run the host's native verify_copy (SQLite migrations,
/// integrity and TLS identity). This crate never opens a business database.
pub fn open_copy(stage: &Path, expected_client_id: &str, output: &Path) -> Result<NativeCopyPaths> {
    let metadata = fs::symlink_metadata(stage)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(Error::InvalidFormat);
    }
    let mut count = 0;
    for entry in fs::read_dir(stage)? {
        let entry = entry?;
        let name = entry.file_name();
        let kind = entry.file_type()?;
        if !kind.is_file()
            || !name
                .to_str()
                .is_some_and(|s| OBJECTS.contains(&s) || s == "complete.json")
        {
            return Err(Error::InvalidFormat);
        }
        count += 1;
    }
    if count != 5 {
        return Err(Error::InvalidFormat);
    }
    let complete = read_complete(stage, expected_client_id)?;
    for name in OBJECTS {
        if hash_file(&stage.join(name), object_cap(name)?)? != complete.objects[name] {
            return Err(Error::Integrity);
        }
    }
    let bytes = Zeroizing::new(read_bounded(&stage.join("recovery-key.json"), JSON_CAP)?);
    let recovery: RecoveryKeyV1 =
        serde_json::from_slice(&bytes).map_err(|_| Error::InvalidFormat)?;
    if recovery.format != 1
        || recovery.host_id != complete.host_id
        || recovery.snapshot_id != complete.snapshot_id
    {
        return Err(Error::Integrity);
    }
    let key: age::x25519::Identity = recovery.identity.parse().map_err(|_| Error::Crypto)?;
    // Never leave a partial plaintext copy at the destination a restore uses.
    let temporary = output.with_file_name(format!("cloud-verify-{}", Uuid::new_v4()));
    private_dir(&temporary)?;
    let result = (|| {
        for (name, target, cap) in [
            ("database.age", "database.db", DATABASE_CAP),
            ("manifest.age", "database.json", SMALL_FILE_CAP),
            ("host-identity.age", "database.identity", SMALL_FILE_CAP),
        ] {
            let stream =
                age::Decryptor::new(File::open(stage.join(name))?).map_err(|_| Error::Crypto)?;
            let mut reader = stream
                .decrypt(std::iter::once(&key as &dyn age::Identity))
                .map_err(|_| Error::Crypto)?;
            let mut file = private_file(&temporary.join(target))?;
            copy_bounded(&mut reader, &mut file, cap)?; // Must consume authenticated EOF.
            file.sync_all()?;
        }
        let native: NativeManifest = serde_json::from_slice(&read_bounded(
            &temporary.join("database.json"),
            SMALL_FILE_CAP,
        )?)
        .map_err(|_| Error::InvalidFormat)?;
        // Validate the basename before any rename using it.
        if !native.file.starts_with("markiro-host-")
            || !native.file.ends_with(".db")
            || native.file.len() > 128
            || native.file.contains("..")
            || !native
                .file
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
        {
            return Err(Error::InvalidFormat);
        }
        let paths = NativeCopyPaths::beside(temporary.join(&native.file));
        for (from, to) in [
            ("database.db", &paths.database),
            ("database.json", &paths.manifest),
            ("database.identity", &paths.identity),
        ] {
            fs::rename(temporary.join(from), to)?;
        }
        let verified = read_native(&paths)?;
        if verified.host_id != complete.host_id
            || verified.created_at != complete.created_at
            || verified.schema_version != complete.schema_version
            || verified.sha256 != complete.native_db_sha256
            || verified.identity.fingerprint != complete.tls_fingerprint
        {
            return Err(Error::Integrity);
        }
        // output must not exist, including an empty folder, on all platforms.
        if output.try_exists()? {
            return Err(Error::InvalidFormat);
        }
        fs::rename(&temporary, output)?;
        Ok(NativeCopyPaths::beside(output.join(native.file)))
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&temporary);
    }
    result
}
