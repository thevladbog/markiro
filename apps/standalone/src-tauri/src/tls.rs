//! TLS client configuration for talking to a host. Hosts use self-signed
//! certificates, so trust comes only from the certificate's SHA-256
//! fingerprint: `Observe` records it (discovery, before a person or a
//! pairing code confirms it), `Pin` accepts only the fingerprint saved at
//! pairing. The aws-lc-rs provider is always selected explicitly.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{verify_tls12_signature, verify_tls13_signature, CryptoProvider};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};

#[derive(Debug, Clone)]
pub enum FingerprintPolicy {
    /// Accept any certificate and record its fingerprint.
    Observe(Arc<Mutex<Option<String>>>),
    /// Accept only `expected`; set `mismatch` when another certificate is presented.
    Pin {
        expected: String,
        mismatch: Arc<AtomicBool>,
    },
}

pub fn client_config(policy: FingerprintPolicy) -> Result<rustls::ClientConfig, rustls::Error> {
    let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
    Ok(
        rustls::ClientConfig::builder_with_provider(provider.clone())
            .with_safe_default_protocol_versions()?
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(FingerprintVerifier { policy, provider }))
            .with_no_client_auth(),
    )
}

#[derive(Debug)]
struct FingerprintVerifier {
    policy: FingerprintPolicy,
    provider: Arc<CryptoProvider>,
}

impl ServerCertVerifier for FingerprintVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let fingerprint = markiro_proto::certificate_fingerprint(end_entity.as_ref());
        match &self.policy {
            FingerprintPolicy::Observe(seen) => {
                *seen.lock().expect("fingerprint lock") = Some(fingerprint);
                Ok(ServerCertVerified::assertion())
            }
            FingerprintPolicy::Pin { expected, mismatch } => {
                if &fingerprint == expected {
                    Ok(ServerCertVerified::assertion())
                } else {
                    mismatch.store(true, Ordering::SeqCst);
                    Err(rustls::Error::General(
                        "host certificate fingerprint mismatch".into(),
                    ))
                }
            }
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}
