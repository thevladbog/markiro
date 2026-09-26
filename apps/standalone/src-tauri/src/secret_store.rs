//! Protection of the device key at rest (spec §5.2). On Windows the key is
//! encrypted with DPAPI for the current user; elsewhere it is kept as is and
//! the only protection is the owner-only (0600) `device.json`. The scheme is
//! stored next to the value, so a file copied between systems fails loudly
//! instead of yielding garbage.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Scheme {
    Dpapi,
    Plain,
}

/// A secret as stored in `device.json`.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProtectedSecret {
    pub scheme: Scheme,
    pub value: String,
}

impl std::fmt::Debug for ProtectedSecret {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ProtectedSecret")
            .field("scheme", &self.scheme)
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SecretStoreError {
    #[error("the operating system could not protect the secret")]
    Protect,
    #[error("the stored secret cannot be read on this computer")]
    Unprotect,
    #[error("the stored secret uses the {0:?} scheme, which this system cannot read")]
    WrongScheme(Scheme),
}

/// The scheme this build writes and reads.
#[cfg(windows)]
pub const NATIVE_SCHEME: Scheme = Scheme::Dpapi;
#[cfg(not(windows))]
pub const NATIVE_SCHEME: Scheme = Scheme::Plain;

pub fn protect(plaintext: &str) -> Result<ProtectedSecret, SecretStoreError> {
    Ok(ProtectedSecret {
        scheme: NATIVE_SCHEME,
        value: write_native(plaintext)?,
    })
}

pub fn unprotect(secret: &ProtectedSecret) -> Result<String, SecretStoreError> {
    if secret.scheme != NATIVE_SCHEME {
        return Err(SecretStoreError::WrongScheme(secret.scheme));
    }
    read_native(&secret.value)
}

#[cfg(windows)]
fn write_native(plaintext: &str) -> Result<String, SecretStoreError> {
    dpapi::protect(plaintext)
}

#[cfg(windows)]
fn read_native(value: &str) -> Result<String, SecretStoreError> {
    dpapi::unprotect(value)
}

#[cfg(not(windows))]
fn write_native(plaintext: &str) -> Result<String, SecretStoreError> {
    Ok(plaintext.to_owned())
}

#[cfg(not(windows))]
fn read_native(value: &str) -> Result<String, SecretStoreError> {
    Ok(value.to_owned())
}

#[cfg(windows)]
mod dpapi {
    //! Per-user DPAPI, as in `apps/signer/signer-core/src/storage_dpapi.rs`:
    //! the ciphertext is bound to the Windows account that paired the device.

    use std::ptr;

    use base64::Engine as _;
    use windows_sys::Win32::Foundation::{LocalFree, HLOCAL};
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB,
    };

    use super::SecretStoreError;

    pub fn protect(plaintext: &str) -> Result<String, SecretStoreError> {
        let input = CRYPT_INTEGER_BLOB {
            cbData: u32::try_from(plaintext.len()).map_err(|_| SecretStoreError::Protect)?,
            pbData: plaintext.as_ptr() as *mut u8,
        };
        let mut output = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: ptr::null_mut(),
        };
        // SAFETY: `input` borrows `plaintext` for the duration of the call;
        // DPAPI allocates `output` with LocalAlloc and it is freed below.
        let ok = unsafe {
            CryptProtectData(
                &input,
                ptr::null(),
                ptr::null_mut(),
                ptr::null_mut(),
                ptr::null_mut(),
                0,
                &mut output,
            )
        };
        if ok == 0 {
            return Err(SecretStoreError::Protect);
        }
        // SAFETY: DPAPI returned `cbData` initialized bytes at `pbData`.
        let blob = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) };
        let encoded = base64::engine::general_purpose::STANDARD.encode(blob);
        // SAFETY: `pbData` was allocated by DPAPI and is not used after this.
        unsafe { LocalFree(output.pbData as HLOCAL) };
        Ok(encoded)
    }

    pub fn unprotect(protected: &str) -> Result<String, SecretStoreError> {
        let mut blob = base64::engine::general_purpose::STANDARD
            .decode(protected)
            .map_err(|_| SecretStoreError::Unprotect)?;
        let input = CRYPT_INTEGER_BLOB {
            cbData: u32::try_from(blob.len()).map_err(|_| SecretStoreError::Unprotect)?,
            pbData: blob.as_mut_ptr(),
        };
        let mut output = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: ptr::null_mut(),
        };
        // SAFETY: as in `protect`.
        let ok = unsafe {
            CryptUnprotectData(
                &input,
                ptr::null_mut(),
                ptr::null_mut(),
                ptr::null_mut(),
                ptr::null_mut(),
                0,
                &mut output,
            )
        };
        if ok == 0 {
            return Err(SecretStoreError::Unprotect);
        }
        // SAFETY: as in `protect`.
        let plaintext =
            unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec();
        // SAFETY: as in `protect`.
        unsafe { LocalFree(output.pbData as HLOCAL) };
        String::from_utf8(plaintext).map_err(|_| SecretStoreError::Unprotect)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_with_the_native_scheme() {
        let protected = protect("device-key-value").unwrap();
        assert_eq!(protected.scheme, NATIVE_SCHEME);
        assert_eq!(unprotect(&protected).unwrap(), "device-key-value");
    }

    #[cfg(windows)]
    #[test]
    fn windows_never_stores_the_plaintext() {
        let protected = protect("device-key-value").unwrap();
        assert_ne!(protected.value, "device-key-value");
        let corrupted = ProtectedSecret {
            scheme: Scheme::Dpapi,
            value: "not-base64-!!".into(),
        };
        assert_eq!(unprotect(&corrupted), Err(SecretStoreError::Unprotect));
    }

    #[test]
    fn a_foreign_scheme_is_refused() {
        let foreign = if NATIVE_SCHEME == Scheme::Dpapi {
            Scheme::Plain
        } else {
            Scheme::Dpapi
        };
        let secret = ProtectedSecret {
            scheme: foreign,
            value: "device-key-value".into(),
        };
        assert_eq!(
            unprotect(&secret),
            Err(SecretStoreError::WrongScheme(foreign))
        );
    }

    #[test]
    fn debug_output_hides_the_value() {
        let secret = ProtectedSecret {
            scheme: Scheme::Plain,
            value: "device-key-value".into(),
        };
        assert!(!format!("{secret:?}").contains("device-key-value"));
    }
}
