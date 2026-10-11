//! Copies of the master database and their folders (plan РК): `copy` makes
//! and checks one copy, `folder` lists, cleans, rotates and replicates the
//! copies of a folder, `retention` decides which stay, `worker` makes them
//! on a schedule and on request. `crate::restore` puts one back.

pub mod copy;
pub mod folder;
pub mod retention;
pub mod worker;

pub use worker::{Backups, Worker};
