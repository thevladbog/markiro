//! Copies of the master database and their folders (plan РК): `copy` makes
//! and checks one copy, `folder` lists, cleans, rotates and replicates the
//! copies of a folder, `retention` decides which stay.

pub mod copy;
pub mod folder;
pub mod retention;
