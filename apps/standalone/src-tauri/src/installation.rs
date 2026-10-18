//! The role the installer gave this computer (plan УСТ): `installation.json`
//! next to the app's executable, which only the installer writes
//! (`src-tauri/windows/installer-hooks.nsh`). The install directory is under
//! `Program Files`, writable by administrators only, so a person at the
//! station cannot make it an office PC and leave kiosk mode that way. A
//! development build has no such file.
//!
//! An administrator may add `"kiosk": false` to the file by hand: the manual
//! recovery of a station that must not lock (owner decision 2026-10-13, see
//! `window_policy`). The installer rewrites the file, so a reinstall or an
//! update brings kiosk mode back.

use std::path::Path;

use serde::{Deserialize, Serialize};

pub const FILE_NAME: &str = "installation.json";

/// «хост и станция», «только станция», «только офис».
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InstallRole {
    Host,
    Station,
    Office,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Installation {
    role: InstallRole,
    #[serde(default)]
    kiosk: Option<bool>,
}

/// What `installation.json` says: the role, and whether kiosk mode may lock
/// this PC at all (`true` unless the file says `"kiosk": false`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InstallationFile {
    pub role: InstallRole,
    pub kiosk: bool,
}

/// The role in `dir/installation.json`; `None` when there is no file, or a
/// file this build cannot read (logged): such a computer works as a station,
/// kiosk mode included, which is the safe side for the floor.
pub fn read(dir: &Path) -> Option<InstallRole> {
    read_file(dir).map(|file| file.role)
}

/// The whole file, as `read` reads it; `None` in the same cases.
pub fn read_file(dir: &Path) -> Option<InstallationFile> {
    let text = match std::fs::read_to_string(dir.join(FILE_NAME)) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
        Err(_) => {
            eprintln!("standalone: {FILE_NAME} is unreadable; working as a station");
            return None;
        }
    };
    match serde_json::from_str::<Installation>(text.trim_start_matches('\u{feff}')) {
        Ok(installation) => Some(InstallationFile {
            role: installation.role,
            kiosk: installation.kiosk.unwrap_or(true),
        }),
        Err(_) => {
            eprintln!("standalone: {FILE_NAME} is not a known role; working as a station");
            None
        }
    }
}

/// The directory of the running executable, where the installer puts the file.
pub fn read_beside_executable() -> Option<InstallRole> {
    read_file_beside_executable().map(|file| file.role)
}

/// The whole file beside the executable, as `read_file` reads it.
pub fn read_file_beside_executable() -> Option<InstallationFile> {
    let executable = std::env::current_exe().ok()?;
    read_file(executable.parent()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &Path, text: &str) {
        std::fs::write(dir.join(FILE_NAME), text).unwrap();
    }

    #[test]
    fn reads_the_three_roles_the_installer_writes() {
        let dir = tempfile::tempdir().unwrap();
        for (text, role) in [
            ("{\"role\":\"host\"}\r\n", InstallRole::Host),
            ("{\"role\":\"station\"}\r\n", InstallRole::Station),
            ("{\"role\":\"office\"}\r\n", InstallRole::Office),
        ] {
            write(dir.path(), text);
            assert_eq!(read(dir.path()), Some(role), "{text}");
        }
    }

    #[test]
    fn no_file_or_an_unknown_one_means_no_role() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read(dir.path()), None);
        for text in [
            "",
            "{",
            "{\"role\":\"Office\"}",
            "{\"role\":\"admin\"}",
            "{\"role\":\"station\",\"kiosk\":\"no\"}",
            "{\"role\":\"station\",\"windowed\":true}",
            "\"office\"",
        ] {
            write(dir.path(), text);
            assert_eq!(read(dir.path()), None, "{text:?}");
        }
    }

    #[test]
    fn kiosk_mode_may_lock_unless_the_file_says_kiosk_false() {
        let dir = tempfile::tempdir().unwrap();
        for (text, kiosk) in [
            ("{\"role\":\"station\"}", true),
            ("{\"role\":\"station\",\"kiosk\":true}", true),
            ("{\"role\":\"station\",\"kiosk\":false}", false),
            ("{\"kiosk\":false,\"role\":\"host\"}", false),
        ] {
            write(dir.path(), text);
            let file = read_file(dir.path()).expect(text);
            assert_eq!(file.kiosk, kiosk, "{text}");
        }
        write(dir.path(), "{\"role\":\"office\",\"kiosk\":false}");
        assert_eq!(read(dir.path()), Some(InstallRole::Office));
    }

    #[test]
    fn a_byte_order_mark_is_no_reason_to_refuse_the_file() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "\u{feff}{\"role\":\"office\"}");
        assert_eq!(read(dir.path()), Some(InstallRole::Office));
    }

    #[test]
    fn the_role_crosses_ipc_in_snake_case() {
        assert_eq!(
            serde_json::to_value(InstallRole::Host).unwrap(),
            serde_json::json!("host")
        );
        assert_eq!(
            serde_json::to_value(InstallRole::Office).unwrap(),
            serde_json::json!("office")
        );
    }
}
