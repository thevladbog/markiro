//! CAdES-BES signing through CryptoPro's CAdESCOM automation objects.
//!
//! This exists because ГИС МТ's own examples produce CAdES-BES, and a plain
//! CMS blob from `CryptSignMessage` may be rejected by stricter endpoints. It
//! implements the same `Signer` trait, so switching costs one constructor.
//! Requires the CryptoPro CAdES SDK / browser plug-in in addition to the CSP.

use windows::core::BSTR;
use windows::Win32::Foundation::{RPC_E_CHANGED_MODE, S_FALSE, S_OK};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, IDispatch,
};
use windows::Win32::System::Variant::VARIANT;

use crate::signer::{CertificateSummary, Signer};
use crate::SignerError;

pub struct CadesSigner;

impl Signer for CadesSigner {
    fn list_certificates(&self) -> Result<Vec<CertificateSummary>, SignerError> {
        // Enumeration stays on CryptoAPI: it needs no COM and returns exactly
        // the same thumbprints CAdESCOM would.
        crate::signer_capi::CapiSigner::new().list_certificates()
    }

    fn sign_attached(&self, thumbprint: &str, payload: &[u8]) -> Result<String, SignerError> {
        // `sign_attached` runs synchronously on a tokio worker thread, which
        // may already be MTA-initialised by something else on the runtime;
        // that yields RPC_E_CHANGED_MODE here rather than a fresh apartment.
        // The apartment-model object still gets created (marshalled through
        // the host's STA), so treat it as proceed-able. S_OK/S_FALSE are the
        // ordinary "initialised" / "already initialised, same mode" results.
        // Anything else means COM init genuinely failed, and letting that
        // fall through to `CoCreateInstance` would misreport as "CAdESCOM.Store
        // is not registered" — a truthful error here sends the operator to
        // the right place instead of a reinstall they don't need.
        let hr = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
        if hr == RPC_E_CHANGED_MODE {
            tracing::warn!(
                hresult = %hr,
                "CoInitializeEx returned RPC_E_CHANGED_MODE: this thread was already \
                 COM-initialised in a different apartment model; continuing with it"
            );
        } else if hr != S_OK && hr != S_FALSE {
            return Err(SignerError::CryptoProviderMissing(format!(
                "CoInitializeEx failed ({hr})"
            )));
        }
        let store = create_object("CAdESCOM.Store")?;
        let signer = create_object("CAdESCOM.CPSigner")?;
        let signed_data = create_object("CAdESCOM.CadesSignedData")?;
        sign_via_cadescom(&store, &signer, &signed_data, thumbprint, payload)
    }
}

fn create_object(prog_id: &str) -> Result<IDispatch, SignerError> {
    let clsid = unsafe { windows::Win32::System::Com::CLSIDFromProgID(&BSTR::from(prog_id)) }
        .map_err(|e| {
            SignerError::CryptoProviderMissing(format!("{prog_id} is not registered: {e}"))
        })?;
    unsafe { CoCreateInstance(&clsid, None, CLSCTX_INPROC_SERVER) }
        .map_err(|e| SignerError::CryptoProviderMissing(format!("{prog_id}: {e}")))
}

// CAPICOM / CAdESCOM constants, from the CryptoPro SDK headers.
const CAPICOM_CURRENT_USER_STORE: i32 = 2;
const CAPICOM_STORE_OPEN_MAXIMUM_ALLOWED: i32 = 2;
const CAPICOM_CERTIFICATE_FIND_SHA1_HASH: i32 = 0;
/// `Content` is fed base64 text rather than raw bytes.
const CADESCOM_BASE64_TO_BINARY: i32 = 1;
const CADESCOM_CADES_BES: i32 = 1;

/// Drives the CAdESCOM object graph through IDispatch:
/// `Store.Open` → `Store.Certificates.Find(SHA1_HASH, thumbprint)` →
/// `Item(1)` → `Signer.Certificate = cert` → `SignedData.ContentEncoding` +
/// `SignedData.Content = base64(payload)` →
/// `SignedData.SignCades(Signer, CADES_BES, false)`, which returns the
/// attached signature already base64-encoded.
///
/// `Store.Close` must run on every path once `Open` has succeeded, not just
/// the ones the original code happened to return from explicitly. The body
/// after `Open` runs in a closure so there is exactly one `Close` call,
/// reached whether the closure returns `Ok` or any `Err`.
fn sign_via_cadescom(
    store: &IDispatch,
    signer: &IDispatch,
    signed_data: &IDispatch,
    thumbprint: &str,
    payload: &[u8],
) -> Result<String, SignerError> {
    use base64::Engine as _;

    call(
        store,
        "Open",
        &[
            VARIANT::from(CAPICOM_STORE_OPEN_MAXIMUM_ALLOWED),
            VARIANT::from(BSTR::from("My")),
            VARIANT::from(CAPICOM_CURRENT_USER_STORE),
        ],
    )?;

    let result = (|| -> Result<String, SignerError> {
        let certificates = get(store, "Certificates")?.to_dispatch()?;
        let found = call(
            &certificates,
            "Find",
            &[
                VARIANT::from(BSTR::from(thumbprint)),
                VARIANT::from(CAPICOM_CERTIFICATE_FIND_SHA1_HASH),
            ],
        )?
        .to_dispatch()?;
        let count = get(&found, "Count")?.to_i32()?;
        if count < 1 {
            return Err(SignerError::CertNotFound(thumbprint.to_string()));
        }
        // CAPICOM collections are 1-based.
        let certificate = call(&found, "Item", &[VARIANT::from(1i32)])?.to_dispatch()?;

        put(signer, "Certificate", VARIANT::from(certificate))?;
        put(
            signed_data,
            "ContentEncoding",
            VARIANT::from(CADESCOM_BASE64_TO_BINARY),
        )?;
        put(
            signed_data,
            "Content",
            VARIANT::from(BSTR::from(
                base64::engine::general_purpose::STANDARD.encode(payload),
            )),
        )?;

        let signature = call(
            signed_data,
            "SignCades",
            &[
                // Arguments are passed right-to-left by IDispatch convention.
                VARIANT::from(false),
                VARIANT::from(CADESCOM_CADES_BES),
                VARIANT::from(signer.clone()),
            ],
        )?;
        signature.to_string_value()
    })();

    let _ = call(store, "Close", &[]);

    // CAdESCOM's base64 comes out CryptBinaryToString-style, wrapped every 64
    // characters with CR/LF; the CryptoAPI backend returns one unbroken line,
    // so normalise here to keep the two `Signer` implementations shaped the
    // same for `trueapi.rs`.
    result.map(|signature| crate::signer_backend::strip_base64_line_breaks(&signature))
}

/// Minimal late-bound IDispatch helpers. CAdESCOM.dll does embed a type
/// library — that is how VBScript early-binds against it — but `windows-rs`
/// statically binds against Windows metadata (`.winmd`), not COM type
/// libraries, and CAdESCOM does not publish `.winmd`. Late binding through
/// `GetIDsOfNames` + `Invoke` is the pragmatic route from Rust as a result.
mod dispatch {
    use super::*;
    use windows::Win32::System::Com::{
        DISPATCH_FLAGS, DISPATCH_METHOD, DISPATCH_PROPERTYGET, DISPATCH_PROPERTYPUT,
        DISPATCH_PROPERTYPUTREF, DISPPARAMS,
    };
    use windows::Win32::System::Ole::DISPID_PROPERTYPUT;

    fn dispid(target: &IDispatch, name: &str) -> Result<i32, SignerError> {
        let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
        let names = [windows::core::PCWSTR(wide.as_ptr())];
        let mut id = 0i32;
        unsafe {
            target
                .GetIDsOfNames(&windows::core::GUID::zeroed(), names.as_ptr(), 1, 0, &mut id)
                .map_err(|e| SignerError::CryptoProviderMissing(format!("{name}: {e}")))?;
        }
        Ok(id)
    }

    fn invoke(
        target: &IDispatch,
        name: &str,
        flags: DISPATCH_FLAGS,
        args: &[VARIANT],
    ) -> Result<VARIANT, SignerError> {
        let id = dispid(target, name)?;
        let mut arguments: Vec<VARIANT> = args.to_vec();
        let params = DISPPARAMS {
            rgvarg: if arguments.is_empty() {
                std::ptr::null_mut()
            } else {
                arguments.as_mut_ptr()
            },
            cArgs: arguments.len() as u32,
            ..Default::default()
        };
        let mut result = VARIANT::default();
        unsafe {
            target
                .Invoke(
                    id,
                    &windows::core::GUID::zeroed(),
                    0,
                    flags,
                    &params,
                    Some(&mut result),
                    None,
                    None,
                )
                // Reuse `signer_capi`'s CryptoAPI classification table rather
                // than a second copy: `windows::core::Error::code()` is the
                // same HRESULT shape CryptoPro reports through `GetLastError`,
                // so a dismissed PIN dialog (NTE_BAD_KEY_STATE,
                // SCARD_W_CANCELLED_BY_USER, ...) still surfaces as
                // `SignerError::PinRequired` here instead of the generic
                // "check the token" fallback.
                .map_err(|e| crate::signer_capi::classify_hresult(e.code().0 as u32))?;
        }
        Ok(result)
    }

    /// CAPICOM/CAdESCOM collections and object accessors that read like
    /// properties (`Item`, `Find`, ...) are declared `[propget, id(...)]` in
    /// the type library, so `ITypeInfo::Invoke` needs `DISPATCH_PROPERTYGET`
    /// in the flag mask to resolve them; `DISPATCH_METHOD` alone finds no
    /// `INVOKE_FUNC` funcdesc for that DISPID and fails with
    /// `DISP_E_MEMBERNOTFOUND`. Asking for both is harmless for genuine
    /// methods (`Open`/`Close`/`Find`/`SignCades`) and matches the same "ask
    /// for both, let the object pick" reasoning `put` below already uses for
    /// PUT vs. PUTREF.
    pub fn call(target: &IDispatch, name: &str, args: &[VARIANT]) -> Result<VARIANT, SignerError> {
        invoke(target, name, DISPATCH_METHOD | DISPATCH_PROPERTYGET, args)
    }

    pub fn get(target: &IDispatch, name: &str) -> Result<VARIANT, SignerError> {
        invoke(target, name, DISPATCH_PROPERTYGET, &[])
    }

    /// Combines PUT and PUTREF: CAdESCOM properties are a mix of plain values
    /// (`ContentEncoding`, `Content`) and object references (`Certificate`),
    /// and this late-bound path does not consume CAdESCOM's type library to
    /// tell them apart ahead of time the way an early-bound scripting host
    /// would. We just ask for both, which every property accepts one of.
    pub fn put(target: &IDispatch, name: &str, value: VARIANT) -> Result<(), SignerError> {
        let id = dispid(target, name)?;
        let mut arguments = [value];
        let mut named = [DISPID_PROPERTYPUT];
        let params = DISPPARAMS {
            rgvarg: arguments.as_mut_ptr(),
            rgdispidNamedArgs: named.as_mut_ptr(),
            cArgs: 1,
            cNamedArgs: 1,
        };
        unsafe {
            target
                .Invoke(
                    id,
                    &windows::core::GUID::zeroed(),
                    0,
                    DISPATCH_PROPERTYPUT | DISPATCH_PROPERTYPUTREF,
                    &params,
                    None,
                    None,
                    None,
                )
                // Same reasoning as the Invoke failure mapping in `invoke`
                // above: this is a raw `Invoke` call too (it bypasses that
                // helper only to attach the named PUT argument), so it can
                // fail with the same PIN-related HRESULTs — e.g. assigning
                // `Certificate` can touch the key container.
                .map_err(|e| crate::signer_capi::classify_hresult(e.code().0 as u32))?;
        }
        Ok(())
    }

    pub trait VariantExt {
        fn to_dispatch(&self) -> Result<IDispatch, SignerError>;
        fn to_i32(&self) -> Result<i32, SignerError>;
        fn to_string_value(&self) -> Result<String, SignerError>;
    }

    impl VariantExt for VARIANT {
        fn to_dispatch(&self) -> Result<IDispatch, SignerError> {
            IDispatch::try_from(self)
                .map_err(|e| SignerError::CryptoProviderMissing(format!("expected an object: {e}")))
        }
        fn to_i32(&self) -> Result<i32, SignerError> {
            i32::try_from(self)
                .map_err(|e| SignerError::CryptoProviderMissing(format!("expected a number: {e}")))
        }
        fn to_string_value(&self) -> Result<String, SignerError> {
            BSTR::try_from(self)
                .map(|value| value.to_string())
                .map_err(|e| SignerError::CryptoProviderMissing(format!("expected a string: {e}")))
        }
    }
}

use dispatch::{call, get, put, VariantExt as _};
