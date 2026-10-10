//! Route handlers, one module per area; `server::router` wires them.

pub mod bootstrap;
pub mod changes;
pub mod codes;
pub mod counterparties;
pub mod device_shifts;
pub mod devices;
pub mod facts;
pub mod lines;
pub mod office_auth;
pub mod office_boxes;
pub mod office_exports;
pub mod office_shifts;
pub mod office_users;
pub mod operators;
pub mod org;
pub mod pairing;
pub mod products;
pub mod sscc;
pub mod sscc_blocks;
pub mod template_defaults;
pub mod templates;
