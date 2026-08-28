//! CAdES-BES signing through CryptoPro's CAdESCOM automation objects.
//!
//! This exists because ГИС МТ's own examples produce CAdES-BES, and a plain
//! CMS blob from `CryptSignMessage` may be rejected by stricter endpoints. It
//! implements the same `Signer` trait, so switching costs one constructor.
//! Requires the CryptoPro CAdES SDK / browser plug-in in addition to the CSP.

use windows::core::BSTR;
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
        unsafe {
            let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
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
        let _ = call(store, "Close", &[]);
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
    );
    let _ = call(store, "Close", &[]);
    signature?.to_string_value()
}

/// Minimal late-bound IDispatch helpers. CAdESCOM ships no type library we can
/// bind statically, so every call goes through `GetIDsOfNames` + `Invoke`.
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
                .map_err(|e| SignerError::ContainerUnavailable(format!("{name}: {e}")))?;
        }
        Ok(result)
    }

    pub fn call(target: &IDispatch, name: &str, args: &[VARIANT]) -> Result<VARIANT, SignerError> {
        invoke(target, name, DISPATCH_METHOD, args)
    }

    pub fn get(target: &IDispatch, name: &str) -> Result<VARIANT, SignerError> {
        invoke(target, name, DISPATCH_PROPERTYGET, &[])
    }

    /// Combines PUT and PUTREF: CAdESCOM properties are a mix of plain values
    /// (`ContentEncoding`, `Content`) and object references (`Certificate`),
    /// and nothing here has a type library to tell them apart ahead of time.
    /// A scripting host would resolve that per-property; we just ask for
    /// both, which every property accepts one of.
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
                .map_err(|e| SignerError::ContainerUnavailable(format!("{name}: {e}")))?;
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
