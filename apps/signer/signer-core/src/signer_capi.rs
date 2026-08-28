//! GOST signing through Win32 CryptoAPI.
//!
//! `CryptSignMessage` produces an attached PKCS#7/CMS blob using whichever CSP
//! holds the certificate's private key — CryptoPro, in practice — with no COM
//! and no .NET in the picture. If ГИС МТ ever rejects a plain CMS because it
//! wants CAdES-BES attributes, `signer_cades.rs` implements the same trait over
//! CAdESCOM and the runtime swaps one for the other.

use std::ffi::c_void;
use std::ptr;

use base64::Engine as _;
use windows_sys::Win32::Foundation::FILETIME;
use windows_sys::Win32::Security::Cryptography::*;

use crate::signer::{inn_from_subject, thumbprint_bytes, CertificateSummary, Signer};
use crate::SignerError;

const ENCODING: u32 = X509_ASN_ENCODING | PKCS_7_ASN_ENCODING;

/// GOST public-key OID -> the digest OID that must be used with it. Signing a
/// GOST key with any other digest yields a signature ГИС МТ will not verify.
pub fn hash_oid_for_public_key(public_key_oid: &str) -> Option<&'static str> {
    match public_key_oid {
        "1.2.643.7.1.1.1.1" => Some("1.2.643.7.1.1.2.2"),
        "1.2.643.7.1.1.1.2" => Some("1.2.643.7.1.1.2.3"),
        "1.2.643.2.2.19" => Some("1.2.643.2.2.9"),
        _ => None,
    }
}

pub fn format_thumbprint(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02X}")).collect()
}

pub fn filetime_to_rfc3339(low: u32, high: u32) -> String {
    let ticks = (u64::from(high) << 32) | u64::from(low);
    // FILETIME counts 100-ns intervals since 1601-01-01; Unix epoch is
    // 11_644_473_600 seconds later.
    let unix = ticks / 10_000_000;
    crate::trueapi::format_rfc3339_public(unix.saturating_sub(11_644_473_600))
}

pub struct CapiSigner;

impl CapiSigner {
    pub fn new() -> Self {
        Self
    }
}

impl Default for CapiSigner {
    fn default() -> Self {
        Self::new()
    }
}

impl Signer for CapiSigner {
    fn list_certificates(&self) -> Result<Vec<CertificateSummary>, SignerError> {
        let store = open_my_store()?;
        let mut out = Vec::new();
        let mut context: *mut CERT_CONTEXT = ptr::null_mut();
        loop {
            context = unsafe { CertEnumCertificatesInStore(store, context) };
            if context.is_null() {
                break;
            }
            if let Some(summary) = unsafe { summarize(context) } {
                out.push(summary);
            }
        }
        unsafe { CertCloseStore(store, 0) };
        Ok(out)
    }

    fn sign_attached(&self, thumbprint: &str, payload: &[u8]) -> Result<String, SignerError> {
        let store = open_my_store()?;
        let context = unsafe { find_by_thumbprint(store, thumbprint) };
        let context = match context {
            Some(context) => context,
            None => {
                unsafe { CertCloseStore(store, 0) };
                return Err(SignerError::CertNotFound(thumbprint.to_string()));
            }
        };

        let result = unsafe { sign_with_context(context, payload) };
        unsafe {
            CertFreeCertificateContext(context);
            CertCloseStore(store, 0);
        }
        result.map(|der| base64::engine::general_purpose::STANDARD.encode(der))
    }
}

fn open_my_store() -> Result<HCERTSTORE, SignerError> {
    let store = unsafe {
        CertOpenStore(
            CERT_STORE_PROV_SYSTEM_W,
            0,
            0,
            CERT_SYSTEM_STORE_CURRENT_USER | CERT_STORE_READONLY_FLAG,
            windows_sys::core::w!("MY") as *const c_void,
        )
    };
    if store.is_null() {
        let code = unsafe { windows_sys::Win32::Foundation::GetLastError() };
        return Err(SignerError::CryptoProviderMissing(format!(
            "the current user's certificate store could not be opened (0x{code:08X})"
        )));
    }
    Ok(store)
}

/// Returns `None` for anything the agent cannot use: no private key, not a
/// GOST key, or an unreadable subject.
unsafe fn summarize(context: *const CERT_CONTEXT) -> Option<CertificateSummary> {
    let info = (*context).pCertInfo;
    if info.is_null() {
        return None;
    }
    let public_key_oid = cstr_to_string((*info).SubjectPublicKeyInfo.Algorithm.pszObjId)?;
    hash_oid_for_public_key(&public_key_oid)?;

    let has_private_key = has_key_prov_info(context);
    let subject = cert_name_string(context)?;
    let not_after: FILETIME = (*info).NotAfter;
    let thumbprint = cert_thumbprint(context)?;

    Some(CertificateSummary {
        inn: inn_from_subject(&subject),
        thumbprint,
        subject,
        not_after: filetime_to_rfc3339(not_after.dwLowDateTime, not_after.dwHighDateTime),
        has_private_key,
    })
}

unsafe fn has_key_prov_info(context: *const CERT_CONTEXT) -> bool {
    let mut size: u32 = 0;
    CertGetCertificateContextProperty(context, CERT_KEY_PROV_INFO_PROP_ID, ptr::null_mut(), &mut size)
        != 0
}

unsafe fn cert_thumbprint(context: *const CERT_CONTEXT) -> Option<String> {
    let mut size: u32 = 0;
    if CertGetCertificateContextProperty(context, CERT_HASH_PROP_ID, ptr::null_mut(), &mut size) == 0 {
        return None;
    }
    let mut buffer = vec![0u8; size as usize];
    if CertGetCertificateContextProperty(
        context,
        CERT_HASH_PROP_ID,
        buffer.as_mut_ptr().cast(),
        &mut size,
    ) == 0
    {
        return None;
    }
    buffer.truncate(size as usize);
    Some(format_thumbprint(&buffer))
}

unsafe fn cert_name_string(context: *const CERT_CONTEXT) -> Option<String> {
    // pvTypePara for CERT_NAME_RDN_TYPE is a *const u32 holding dwStrType.
    // NULL there selects CERT_SIMPLE_NAME_STR, which renders RDN values only
    // ("ООО Ромашка, 7712345678, Ромашка"). We need CERT_X500_NAME_STR so the
    // result carries attribute names ("CN=..., ИНН=..., O=...") — that is what
    // `inn_from_subject` searches for. `str_type` must outlive both calls
    // below since both pass a pointer into it.
    let str_type: u32 = CERT_X500_NAME_STR;
    let type_para = &str_type as *const u32 as *const c_void;

    let needed = CertGetNameStringW(
        context,
        CERT_NAME_RDN_TYPE,
        0,
        type_para,
        ptr::null_mut(),
        0,
    );
    if needed <= 1 {
        return None;
    }
    let mut buffer = vec![0u16; needed as usize];
    let written = CertGetNameStringW(
        context,
        CERT_NAME_RDN_TYPE,
        0,
        type_para,
        buffer.as_mut_ptr(),
        needed,
    );
    if written <= 1 {
        return None;
    }
    Some(String::from_utf16_lossy(&buffer[..(written as usize - 1)]))
}

/// Looks the certificate up directly by hash instead of walking the store
/// with `CertEnumCertificatesInStore`. The enumeration-then-duplicate
/// approach leaked: `CertEnumCertificatesInStore` only frees its own
/// enumeration reference when the walk is run to exhaustion, so returning
/// early on a match after `CertDuplicateCertificateContext` left the
/// enumeration's reference outstanding on every signing call.
/// `CertFindCertificateInStore` returns a single owned context (the caller
/// must still free it, same as before) and is indexed rather than O(n).
unsafe fn find_by_thumbprint(store: HCERTSTORE, thumbprint: &str) -> Option<*mut CERT_CONTEXT> {
    let bytes = thumbprint_bytes(thumbprint)?;
    let hash_blob = CRYPT_INTEGER_BLOB {
        cbData: bytes.len() as u32,
        pbData: bytes.as_ptr() as *mut u8,
    };
    let context = CertFindCertificateInStore(
        store,
        ENCODING,
        0,
        CERT_FIND_HASH,
        &hash_blob as *const CRYPT_INTEGER_BLOB as *const c_void,
        ptr::null(),
    );
    if context.is_null() {
        None
    } else {
        Some(context)
    }
}

unsafe fn sign_with_context(
    context: *mut CERT_CONTEXT,
    payload: &[u8],
) -> Result<Vec<u8>, SignerError> {
    let info = (*context).pCertInfo;
    if info.is_null() {
        return Err(SignerError::CertNotFound("certificate has no info".into()));
    }
    let public_key_oid = cstr_to_string((*info).SubjectPublicKeyInfo.Algorithm.pszObjId)
        .ok_or_else(|| SignerError::CertNotFound("unreadable public key algorithm".into()))?;
    let hash_oid = hash_oid_for_public_key(&public_key_oid).ok_or_else(|| {
        SignerError::CertNotFound(format!("{public_key_oid} is not a GOST key"))
    })?;
    let hash_oid_c = std::ffi::CString::new(hash_oid)
        .map_err(|e| SignerError::Protocol(e.to_string()))?;

    let mut certs: [*mut CERT_CONTEXT; 1] = [context];
    let params = CRYPT_SIGN_MESSAGE_PARA {
        cbSize: std::mem::size_of::<CRYPT_SIGN_MESSAGE_PARA>() as u32,
        dwMsgEncodingType: ENCODING,
        pSigningCert: context,
        HashAlgorithm: CRYPT_ALGORITHM_IDENTIFIER {
            pszObjId: hash_oid_c.as_ptr() as *mut u8,
            Parameters: CRYPT_INTEGER_BLOB { cbData: 0, pbData: ptr::null_mut() },
        },
        pvHashAuxInfo: ptr::null_mut(),
        // Ship the signer certificate inside the blob so ГИС МТ can verify
        // without a separate lookup.
        cMsgCert: 1,
        rgpMsgCert: certs.as_mut_ptr(),
        cMsgCrl: 0,
        rgpMsgCrl: ptr::null_mut(),
        cAuthAttr: 0,
        rgAuthAttr: ptr::null_mut(),
        cUnauthAttr: 0,
        rgUnauthAttr: ptr::null_mut(),
        dwFlags: 0,
        dwInnerContentType: 0,
    };

    let to_be_signed: [*const u8; 1] = [payload.as_ptr()];
    let sizes: [u32; 1] = [payload.len() as u32];
    let mut blob_size: u32 = 0;

    // fDetachedSignature = FALSE: True API wants the challenge embedded.
    if CryptSignMessage(
        &params,
        0,
        1,
        to_be_signed.as_ptr(),
        sizes.as_ptr(),
        ptr::null_mut(),
        &mut blob_size,
    ) == 0
    {
        return Err(classify_last_error());
    }
    let mut blob = vec![0u8; blob_size as usize];
    if CryptSignMessage(
        &params,
        0,
        1,
        to_be_signed.as_ptr(),
        sizes.as_ptr(),
        blob.as_mut_ptr(),
        &mut blob_size,
    ) == 0
    {
        return Err(classify_last_error());
    }
    blob.truncate(blob_size as usize);
    Ok(blob)
}

/// Maps the CryptoAPI failure onto the wire error codes the cloud understands,
/// so the admin journal says "insert the token" rather than a bare hex code.
fn classify_last_error() -> SignerError {
    let code = unsafe { windows_sys::Win32::Foundation::GetLastError() };
    classify_hresult(code)
}

/// Maps a raw HRESULT (or, for `ERROR_CANCELLED`, a plain Win32 error code —
/// `GetLastError` returns both shapes depending on the failing call) onto the
/// wire error codes the cloud understands. Shared with `signer_cades.rs`:
/// CryptoPro reports the same underlying codes whether the private-key
/// operation goes through raw CryptoAPI (`GetLastError`) or through CAdESCOM
/// over COM (`windows::core::Error::code()`), so both backends classify a
/// dismissed PIN dialog as `SignerError::PinRequired` instead of the generic
/// "check the token" fallback.
pub(crate) fn classify_hresult(code: u32) -> SignerError {
    match code {
        // NTE_BAD_KEYSET / NTE_KEYSET_NOT_DEF / SCARD_W_REMOVED_CARD
        0x8009_0016 | 0x8009_0019 | 0x8010_0069 => SignerError::ContainerUnavailable(format!(
            "the key container is unavailable (0x{code:08X})"
        )),
        // NTE_BAD_KEY_STATE / SCARD_W_WRONG_CHV — the container wants a PIN.
        // SCARD_W_CANCELLED_BY_USER / ERROR_CANCELLED / NTE_SILENT_CONTEXT —
        // the operator dismissed the PIN prompt instead of entering a wrong
        // PIN, but the required action is the same: retry and answer it. Map
        // these here too rather than letting them fall into the catch-all,
        // which would tell the admin to check the token for no reason.
        0x8009_000B | 0x8010_006B | 0x8010_006E | 1223 | 0x8009_0022 => SignerError::PinRequired,
        // CRYPT_E_NOT_FOUND
        0x8009_2004 => SignerError::CertNotFound(format!("0x{code:08X}")),
        // NTE_PROVIDER_DLL_FAIL / NTE_PROV_TYPE_NOT_DEF
        0x8009_001F | 0x8009_0017 => SignerError::CryptoProviderMissing(format!(
            "the GOST provider is not installed (0x{code:08X})"
        )),
        _ => SignerError::ContainerUnavailable(format!("signing failed (0x{code:08X})")),
    }
}

unsafe fn cstr_to_string(pointer: *const u8) -> Option<String> {
    if pointer.is_null() {
        return None;
    }
    let mut length = 0usize;
    while *pointer.add(length) != 0 {
        length += 1;
    }
    let slice = std::slice::from_raw_parts(pointer, length);
    std::str::from_utf8(slice).ok().map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_gost_public_key_oids_to_their_hash_oids() {
        // GOST R 34.10-2012, 256-bit key -> GOST R 34.11-2012, 256-bit hash
        assert_eq!(hash_oid_for_public_key("1.2.643.7.1.1.1.1"), Some("1.2.643.7.1.1.2.2"));
        // GOST R 34.10-2012, 512-bit
        assert_eq!(hash_oid_for_public_key("1.2.643.7.1.1.1.2"), Some("1.2.643.7.1.1.2.3"));
        // Legacy GOST R 34.10-2001, still issued by some CAs
        assert_eq!(hash_oid_for_public_key("1.2.643.2.2.19"), Some("1.2.643.2.2.9"));
        // An RSA certificate is not a GOST certificate: refuse rather than sign
        // with an algorithm ГИС МТ will not accept.
        assert_eq!(hash_oid_for_public_key("1.2.840.113549.1.1.1"), None);
    }

    #[test]
    fn formats_a_thumbprint_as_uppercase_hex() {
        assert_eq!(format_thumbprint(&[0xab, 0x12, 0x0f]), "AB120F");
    }

    #[test]
    fn converts_a_filetime_to_rfc3339_with_offset() {
        // 2026-08-28T12:00:00Z in FILETIME 100-ns ticks since 1601-01-01.
        let ticks: u64 = (1_787_918_400 + 11_644_473_600) * 10_000_000;
        assert_eq!(
            filetime_to_rfc3339(ticks as u32, (ticks >> 32) as u32),
            "2026-08-28T12:00:00.000Z"
        );
    }
}
