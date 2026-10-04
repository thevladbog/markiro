//! Route handlers, one module per area; `server::router` wires them.

pub mod bootstrap;
pub mod changes;
pub mod counterparties;
pub mod devices;
pub mod lines;
pub mod office_auth;
pub mod office_users;
pub mod operators;
pub mod org;
pub mod pairing;
pub mod products;
pub mod sscc;
pub mod template_defaults;
pub mod templates;
