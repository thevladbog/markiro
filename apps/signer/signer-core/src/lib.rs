//! Core of the Chestny ZNAK signer agent: everything that is testable without
//! a desktop shell. OS- and network-touching capabilities sit behind traits so
//! the runtime loop can be exercised on any platform.

pub mod contracts;
pub mod cloud;
pub mod signer;
pub mod trueapi;

use thiserror::Error;

/// One error type for the whole crate. Variants map to the wire error codes the
/// cloud understands (`contracts::SignerErrorCode`) plus internal failures that
/// never reach the cloud.
#[derive(Debug, Error)]
pub enum SignerError {
    #[error("cryptographic provider is unavailable: {0}")]
    CryptoProviderMissing(String),
    #[error("certificate not found: {0}")]
    CertNotFound(String),
    #[error("certificate expired: {0}")]
    CertExpired(String),
    #[error("key container unavailable: {0}")]
    ContainerUnavailable(String),
    #[error("PIN required for the key container")]
    PinRequired,
    #[error("network failure: {0}")]
    Network(String),
    #[error("True API rejected the request: {0}")]
    TrueApi(String),
    /// The cloud answered 401 — this agent was revoked.
    #[error("agent credentials were revoked")]
    Revoked,
    #[error("local storage failure: {0}")]
    Storage(String),
    #[error("protocol violation: {0}")]
    Protocol(String),
}
