//! Customer-owned Yandex connection. All credentials belong to the service.
pub mod audit_outbox;
pub mod connection;
pub mod delivery;
pub mod queue;
pub mod recovery;
pub mod retention;
pub mod runtime;
pub mod secret_store;
pub mod state;
pub mod tokens;
