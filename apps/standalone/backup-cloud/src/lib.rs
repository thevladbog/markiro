//! Direct Yandex backup transport and portable encrypted envelopes.
//! No product server, host database, UI, or Windows service dependency.
pub mod callback;
pub mod catalog;
pub mod client;
pub mod envelope;
pub mod model;
pub mod oauth;
pub mod publication;
pub mod retry;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("invalid cloud backup format")]
    InvalidFormat,
    #[error("cloud backup integrity check failed")]
    Integrity,
    #[error("cloud backup exceeds a size limit")]
    SizeLimit,
    #[error("cloud backup I/O failed")]
    Io(#[from] std::io::Error),
    #[error("cloud backup encryption failed")]
    Crypto,
    #[error("network destination refused")]
    OriginDenied,
    #[error("Yandex request failed")]
    Network,
    #[error("Yandex requested a retry")]
    RetryAfter { seconds: u64, status: u16 },
    #[error("Yandex request refused ({0})")]
    Provider(&'static str),
    #[error("OAuth attempt refused")]
    InvalidAttempt,
    #[error("operating system secret protection unavailable")]
    SecretUnavailable,
}

pub type Result<T> = std::result::Result<T, Error>;
