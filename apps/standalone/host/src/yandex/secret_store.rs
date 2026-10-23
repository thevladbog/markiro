//! Service-account DPAPI, deliberately unavailable on non-Windows production.
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

use markiro_backup_cloud::{
    envelope::{private_dir, private_file, read_bounded},
    model::*,
    Error, Result,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use zeroize::Zeroizing;

pub trait Protector: Send + Sync {
    fn protect(&self, plaintext: &[u8]) -> Result<Vec<u8>>;
    fn unprotect(&self, ciphertext: &[u8]) -> Result<Vec<u8>>;
}
impl<P: Protector + ?Sized> Protector for Box<P> {
    fn protect(&self, plaintext: &[u8]) -> Result<Vec<u8>> {
        (**self).protect(plaintext)
    }
    fn unprotect(&self, ciphertext: &[u8]) -> Result<Vec<u8>> {
        (**self).unprotect(ciphertext)
    }
}

pub struct ServiceDpapi;
#[cfg(not(windows))]
impl Protector for ServiceDpapi {
    fn protect(&self, _: &[u8]) -> Result<Vec<u8>> {
        Err(Error::SecretUnavailable)
    }
    fn unprotect(&self, _: &[u8]) -> Result<Vec<u8>> {
        Err(Error::SecretUnavailable)
    }
}

#[cfg(windows)]
impl Protector for ServiceDpapi {
    fn protect(&self, plaintext: &[u8]) -> Result<Vec<u8>> {
        dpapi(plaintext, false)
    }
    fn unprotect(&self, ciphertext: &[u8]) -> Result<Vec<u8>> {
        dpapi(ciphertext, true)
    }
}

#[cfg(windows)]
fn dpapi(bytes: &[u8], decrypt: bool) -> Result<Vec<u8>> {
    use std::ptr;
    use windows_sys::Win32::{
        Foundation::{LocalFree, HLOCAL},
        Security::Cryptography::{
            CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
        },
    };
    let input = CRYPT_INTEGER_BLOB {
        cbData: u32::try_from(bytes.len()).map_err(|_| Error::SizeLimit)?,
        pbData: bytes.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: ptr::null_mut(),
    };
    // SAFETY: input borrows live bytes, output is allocated by DPAPI and freed
    // below. No impersonation or LOCAL_MACHINE: the caller is the service.
    let ok = unsafe {
        if decrypt {
            CryptUnprotectData(
                &input,
                ptr::null_mut(),
                ptr::null(),
                ptr::null(),
                ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptProtectData(
                &input,
                ptr::null(),
                ptr::null(),
                ptr::null(),
                ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        }
    };
    if ok == 0 {
        return Err(Error::SecretUnavailable);
    }
    // SAFETY: successful DPAPI call returns cbData bytes and LocalAlloc memory.
    let slice = unsafe { std::slice::from_raw_parts_mut(output.pbData, output.cbData as usize) };
    let result = slice.to_vec();
    zeroize::Zeroize::zeroize(slice);
    unsafe {
        LocalFree(output.pbData as HLOCAL);
    }
    Ok(result)
}

/// Private wire representation used only inside the DPAPI boundary, never IPC.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Stored {
    format: u32,
    profile: ClientProfile,
    client_secret: String,
    access: String,
    refresh: String,
    expires_at: i64,
    account_id: String,
    host_id: Uuid,
    generation: Uuid,
}
impl Drop for Stored {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        self.client_secret.zeroize();
        self.access.zeroize();
        self.refresh.zeroize();
    }
}

pub struct ServiceCredentialStore<P = ServiceDpapi> {
    dir: PathBuf,
    protector: P,
}
impl ServiceCredentialStore<ServiceDpapi> {
    pub fn new(dir: &Path) -> Result<Self> {
        Self::with_protector(dir, ServiceDpapi)
    }
}

impl<P: Protector> ServiceCredentialStore<P> {
    /// Injection is for tests/platform adapters; production always constructs new.
    pub fn with_protector(dir: &Path, protector: P) -> Result<Self> {
        if !dir.try_exists()? {
            private_dir(dir)?;
        }
        let metadata = fs::symlink_metadata(dir)?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(Error::SecretUnavailable);
        }
        #[cfg(windows)]
        crate::backup::identity::platform_guard()
            .protect(dir)
            .map_err(|_| Error::SecretUnavailable)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
        }
        Ok(Self {
            dir: dir.into(),
            protector,
        })
    }

    pub fn load(&self) -> Result<Option<RuntimeCredentials>> {
        let Some(ciphertext) = self.snapshot_ciphertext()? else {
            return Ok(None);
        };
        let plaintext = Zeroizing::new(self.protector.unprotect(&ciphertext)?);
        if plaintext.len() as u64 > JSON_CAP {
            return Err(Error::SizeLimit);
        }
        let stored: Stored =
            serde_json::from_slice(&plaintext).map_err(|_| Error::SecretUnavailable)?;
        if stored.format != 1
            || stored.host_id.is_nil()
            || stored.generation.is_nil()
            || stored.account_id.is_empty()
            || stored.account_id.len() > 200
        {
            return Err(Error::SecretUnavailable);
        }
        stored.profile.validate()?;
        Ok(Some(RuntimeCredentials {
            profile: stored.profile.clone(),
            client_secret: Secret::client_secret(stored.client_secret.clone())?,
            tokens: TokenSet {
                access: Secret::new(stored.access.clone())?,
                refresh: Secret::new(stored.refresh.clone())?,
                expires_at: stored.expires_at,
            },
            account_id: stored.account_id.clone(),
            host_id: stored.host_id,
            generation: stored.generation,
        }))
    }

    pub fn replace(&self, credentials: &RuntimeCredentials) -> Result<()> {
        credentials.profile.validate()?;
        if credentials.host_id.is_nil()
            || credentials.generation.is_nil()
            || credentials.account_id.is_empty()
            || credentials.account_id.len() > 200
        {
            return Err(Error::InvalidFormat);
        }
        let stored = Stored {
            format: 1,
            profile: credentials.profile.clone(),
            client_secret: credentials.client_secret.expose().into(),
            access: credentials.tokens.access.expose().into(),
            refresh: credentials.tokens.refresh.expose().into(),
            expires_at: credentials.tokens.expires_at,
            account_id: credentials.account_id.clone(),
            host_id: credentials.host_id,
            generation: credentials.generation,
        };
        let plaintext =
            Zeroizing::new(serde_json::to_vec(&stored).map_err(|_| Error::InvalidFormat)?);
        if plaintext.len() as u64 > JSON_CAP {
            return Err(Error::SizeLimit);
        }
        // Protect first; no plaintext file exists even if DPAPI fails.
        let ciphertext = self.protector.protect(&plaintext)?;
        self.write_ciphertext(&ciphertext)
    }

    pub(super) fn snapshot_ciphertext(&self) -> Result<Option<Vec<u8>>> {
        let path = self.dir.join("credentials.dpapi");
        if !path.try_exists()? {
            return Ok(None);
        }
        read_bounded(&path, JSON_CAP * 4).map(Some)
    }

    pub(super) fn restore_ciphertext(&self, previous: Option<Vec<u8>>) -> Result<()> {
        match previous {
            Some(bytes) => self.write_ciphertext(&bytes),
            None => self.clear(),
        }
    }

    fn write_ciphertext(&self, ciphertext: &[u8]) -> Result<()> {
        if ciphertext.len() as u64 > JSON_CAP * 4 {
            return Err(Error::SizeLimit);
        }
        let temporary = self
            .dir
            .join(format!("credentials-{}.partial", Uuid::new_v4()));
        let result = (|| {
            let mut file = private_file(&temporary)?;
            crate::backup::identity::platform_guard()
                .protect(&temporary)
                .map_err(|_| Error::SecretUnavailable)?;
            file.write_all(ciphertext)?;
            file.sync_all()?;
            drop(file);
            replace_file(&temporary, &self.dir.join("credentials.dpapi"))?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(temporary);
        }
        result
    }

    pub fn clear(&self) -> Result<()> {
        match fs::remove_file(self.dir.join("credentials.dpapi")) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.into()),
        }
    }
}

#[cfg(not(windows))]
fn replace_file(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::rename(from, to)
}
#[cfg(windows)]
fn replace_file(from: &Path, to: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let from: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
    let to: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
    // SAFETY: both are terminated UTF-16 path buffers valid through the call.
    if unsafe {
        MoveFileExW(
            from.as_ptr(),
            to.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}
