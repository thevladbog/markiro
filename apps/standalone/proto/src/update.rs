//! Updates of «Markiro Автоном» from a file (plan ОБН-2, spec §10): the
//! version rule every side shares, the installer's name, the SHA-256 of an
//! installer read to its exact size, and the report the office sends when it
//! starts one. The signed manifest itself is `trust::UpdateManifestV1`
//! (plan ЛЦ-1).

use std::fmt;
use std::io::{self, Read};
use std::str::FromStr;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Update distribution through the host (plan ОБН-3): `update/distribution.rs`.
pub mod distribution;

/// The product an update manifest names.
pub const PRODUCT: &str = "markiro-standalone";

/// A release version `MAJOR.MINOR.PATCH`, the form `prepare.mjs` accepts:
/// decimal numbers without leading zeros and nothing before, between or
/// after them. Ordered as numbers, `MAJOR` first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct AppVersion {
    pub major: u32,
    pub minor: u32,
    pub patch: u32,
}

/// A text that is not a version.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NotAVersion;

impl FromStr for AppVersion {
    type Err = NotAVersion;

    fn from_str(text: &str) -> Result<Self, Self::Err> {
        let mut parts = text.split('.');
        let mut next = || -> Result<u32, NotAVersion> {
            let part = parts.next().ok_or(NotAVersion)?;
            // `u32::from_str` takes a leading `+`: only ASCII digits pass here.
            let plain = !part.is_empty()
                && part.bytes().all(|byte| byte.is_ascii_digit())
                && (part == "0" || !part.starts_with('0'));
            if !plain {
                return Err(NotAVersion);
            }
            part.parse().map_err(|_| NotAVersion)
        };
        let version = AppVersion {
            major: next()?,
            minor: next()?,
            patch: next()?,
        };
        if parts.next().is_some() {
            return Err(NotAVersion);
        }
        Ok(version)
    }
}

impl fmt::Display for AppVersion {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)
    }
}

/// The installer's name `prepare.mjs` gives a version (`standaloneInstallerName`).
pub fn installer_name(version: &AppVersion) -> String {
    format!("markiro-standalone-{version}-windows-x86_64-setup.exe")
}

/// Where the installer of a started update came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UpdateSource {
    /// A package found on this computer (plan ОБН-2).
    File,
    /// A package downloaded from the host (plan ОБН-3).
    Host,
}

/// `POST /v1/office/updates/started` (spec §8.2, §10.4): the office starts
/// an installer on its PC. The device is the office session's own, never a
/// field; the host checks the versions and the hash's form.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateStarted {
    pub from: String,
    pub to: String,
    pub installer_sha256: String,
    pub source: UpdateSource,
}

/// Why [`hash_exact`] gave no hash.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HashError {
    /// The reader ended before `size` bytes.
    TooShort,
    /// The reader had a byte past `size`.
    TooLong,
    Io(io::ErrorKind),
}

/// The lower-case hex SHA-256 of exactly `size` bytes of `reader`, read in
/// 64 KiB pieces, never whole: fewer bytes is [`HashError::TooShort`], one
/// byte more is [`HashError::TooLong`], found as soon as it is read.
pub fn hash_exact<R: Read>(mut reader: R, size: u64) -> Result<String, HashError> {
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 64 * 1024];
    let mut read: u64 = 0;
    loop {
        let n = match reader.read(&mut buffer) {
            Ok(n) => n,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(HashError::Io(error.kind())),
        };
        if n == 0 {
            break;
        }
        read = read.saturating_add(u64::try_from(n).unwrap_or(u64::MAX));
        if read > size {
            return Err(HashError::TooLong);
        }
        hasher.update(&buffer[..n]);
    }
    if read < size {
        return Err(HashError::TooShort);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}
