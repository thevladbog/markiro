//! `update-pending.json` in the app's data folder (plan ОБН-2, spec
//! §10.11.4): written right before the installer starts, read at the next
//! start. This version is the one the update went to — «обновлено», and the
//! mark goes; it is still the one it came from — «не завершилось», and the
//! mark stays until the person hides the message or starts again; anything
//! else is a stale mark and goes. The time is milliseconds since the epoch:
//! the shell has no calendar crate.

use std::fs::{self, File};
use std::io::{self, Write};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

pub const FILE_NAME: &str = "update-pending.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Pending {
    pub from: String,
    pub to: String,
    pub started_at_ms: u64,
}

/// What the last update came to, as the next start found it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum UpdateOutcome {
    Updated {
        from: String,
        to: String,
    },
    NotFinished {
        from: String,
        to: String,
        #[serde(rename = "startedAtMs")]
        started_at_ms: u64,
    },
}

/// Milliseconds since the epoch on this computer's clock.
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

/// Writes the mark whole: a partial file, flushed, then renamed over the name.
pub fn write(dir: &Path, pending: &Pending) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    let partial = dir.join(format!("{FILE_NAME}.partial"));
    let bytes = serde_json::to_vec(pending).map_err(io::Error::other)?;
    {
        let mut file = File::create(&partial)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
    }
    fs::rename(&partial, dir.join(FILE_NAME))
}

/// Removes the mark; none is no error.
pub fn remove(dir: &Path) -> io::Result<()> {
    match fs::remove_file(dir.join(FILE_NAME)) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

/// The outcome of the mark in `dir` for this app's version `installed`; the
/// mark is removed unless the update did not finish.
pub fn take_outcome(dir: &Path, installed: &str) -> Option<UpdateOutcome> {
    let text = fs::read_to_string(dir.join(FILE_NAME)).ok()?;
    let Ok(pending) = serde_json::from_str::<Pending>(&text) else {
        let _ = remove(dir);
        return None;
    };
    if pending.to == installed {
        let _ = remove(dir);
        Some(UpdateOutcome::Updated {
            from: pending.from,
            to: pending.to,
        })
    } else if pending.from == installed {
        Some(UpdateOutcome::NotFinished {
            from: pending.from,
            to: pending.to,
            started_at_ms: pending.started_at_ms,
        })
    } else {
        let _ = remove(dir);
        None
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn mark(dir: &Path) {
        write(
            dir,
            &Pending {
                from: "0.1.0".into(),
                to: "0.2.0".into(),
                started_at_ms: 1_760_000_000_000,
            },
        )
        .unwrap();
    }

    #[test]
    fn the_new_version_says_updated_and_the_mark_goes() {
        let dir = tempfile::tempdir().unwrap();
        mark(dir.path());
        assert!(!dir.path().join("update-pending.json.partial").exists());
        assert_eq!(
            take_outcome(dir.path(), "0.2.0"),
            Some(UpdateOutcome::Updated {
                from: "0.1.0".into(),
                to: "0.2.0".into()
            })
        );
        assert!(!dir.path().join(FILE_NAME).exists());
        assert_eq!(take_outcome(dir.path(), "0.2.0"), None);
    }

    #[test]
    fn the_old_version_says_not_finished_and_the_mark_stays() {
        let dir = tempfile::tempdir().unwrap();
        mark(dir.path());
        for _ in 0..2 {
            assert_eq!(
                take_outcome(dir.path(), "0.1.0"),
                Some(UpdateOutcome::NotFinished {
                    from: "0.1.0".into(),
                    to: "0.2.0".into(),
                    started_at_ms: 1_760_000_000_000
                })
            );
        }
        remove(dir.path()).unwrap();
        remove(dir.path()).unwrap();
        assert_eq!(take_outcome(dir.path(), "0.1.0"), None);
    }

    #[test]
    fn a_stale_or_unreadable_mark_goes_with_nothing_to_say() {
        let dir = tempfile::tempdir().unwrap();
        mark(dir.path());
        assert_eq!(take_outcome(dir.path(), "0.3.0"), None);
        assert!(!dir.path().join(FILE_NAME).exists());
        for text in [
            "{",
            r#"{"from":"0.1.0","to":"0.2.0","startedAtMs":1,"extra":true}"#,
            r#"{"from":"0.1.0","to":"0.2.0"}"#,
        ] {
            fs::write(dir.path().join(FILE_NAME), text).unwrap();
            assert_eq!(take_outcome(dir.path(), "0.1.0"), None, "{text}");
            assert!(!dir.path().join(FILE_NAME).exists());
        }
    }

    #[test]
    fn the_outcome_crosses_ipc_in_the_webviews_words() {
        assert_eq!(
            serde_json::to_value(UpdateOutcome::NotFinished {
                from: "0.1.0".into(),
                to: "0.2.0".into(),
                started_at_ms: 1
            })
            .unwrap(),
            json!({ "kind": "not_finished", "from": "0.1.0", "to": "0.2.0", "startedAtMs": 1 })
        );
        assert_eq!(
            serde_json::to_value(UpdateOutcome::Updated {
                from: "0.1.0".into(),
                to: "0.2.0".into()
            })
            .unwrap(),
            json!({ "kind": "updated", "from": "0.1.0", "to": "0.2.0" })
        );
        assert!(now_ms() > 1_700_000_000_000);
    }
}
