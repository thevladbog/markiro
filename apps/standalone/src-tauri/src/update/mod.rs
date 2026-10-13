//! Updates from a file (plan ОБН-2, spec §10.1–§10.5): the shell finds the
//! packages, checks the signed manifest and the installer beside it, and
//! starts that very installer with Windows' administrator prompt. The
//! webview names a package only by a path this module found itself; the
//! keys, the installer's bytes and the launch stay here.
//!
//! - [`package`] finds `*.update.jws` in `Документы\Markiro\Обновления` and on
//!   removable drives, and reads an installer through a handle that lets
//!   nobody write, rename or delete it while the app holds it;
//! - [`rules`] decides what the version rules of spec §10.7–§10.8 allow.

pub mod package;
pub mod rules;
