//! DPAPI-backed secret storage (per-user scope).
//!
//! `CryptProtectData` ties the ciphertext to the Windows account, which is
//! exactly the boundary we want: the agent runs as the operator who owns the
//! UKEP, and nobody else — including another account on the same machine —
//! can recover the agent secret from the config file.

use std::ptr;

use base64::Engine as _;
use windows_sys::Win32::Foundation::{LocalFree, HLOCAL};
use windows_sys::Win32::Security::Cryptography::{
    CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB,
};

use crate::storage::SecretStore;
use crate::SignerError;

pub struct DpapiStore;

impl SecretStore for DpapiStore {
    fn protect(&self, plaintext: &str) -> Result<String, SignerError> {
        let input = CRYPT_INTEGER_BLOB {
            cbData: plaintext.len() as u32,
            pbData: plaintext.as_ptr() as *mut u8,
        };
        let mut output = CRYPT_INTEGER_BLOB { cbData: 0, pbData: ptr::null_mut() };
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
            return Err(SignerError::Storage("DPAPI could not protect the secret".into()));
        }
        let blob = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) };
        let encoded = base64::engine::general_purpose::STANDARD.encode(blob);
        unsafe { LocalFree(output.pbData as HLOCAL) };
        Ok(encoded)
    }

    fn unprotect(&self, protected: &str) -> Result<String, SignerError> {
        let mut blob = base64::engine::general_purpose::STANDARD
            .decode(protected)
            .map_err(|e| SignerError::Storage(e.to_string()))?;
        let input = CRYPT_INTEGER_BLOB {
            cbData: blob.len() as u32,
            pbData: blob.as_mut_ptr(),
        };
        let mut output = CRYPT_INTEGER_BLOB { cbData: 0, pbData: ptr::null_mut() };
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
            return Err(SignerError::Storage(
                "DPAPI could not read the stored secret; re-pair this agent".into(),
            ));
        }
        let plaintext =
            unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec();
        unsafe { LocalFree(output.pbData as HLOCAL) };
        String::from_utf8(plaintext).map_err(|e| SignerError::Storage(e.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::SecretStore;

    #[test]
    fn round_trips_a_secret_through_dpapi() {
        let store = DpapiStore;
        let protected = store.protect("example-agent-secret").unwrap();
        assert_ne!(protected, "example-agent-secret", "must not be plaintext");
        assert_eq!(store.unprotect(&protected).unwrap(), "example-agent-secret");
    }

    #[test]
    fn refuses_a_corrupted_blob() {
        let store = DpapiStore;
        assert!(store.unprotect("not-base64-!!").is_err());
    }
}
