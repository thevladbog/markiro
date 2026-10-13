//! The trial's mark outside the database (spec §3.4): on Windows, values in
//! `HKLM\SOFTWARE\Markiro\Standalone\Trial` that a reinstall and even a new
//! data folder do not take away (plan ЛЦ-2 task 12); elsewhere none. The
//! trial's start is the earlier of the database's and the mark's, with that
//! start's INN.

use std::sync::{Arc, Mutex};

use crate::install::{run_checked, Commands, InstallError};

/// The mark's key. `markiro-host install` makes it with administrator
/// rights and lets the service (LocalService) read and set values in it
/// only (`install::trial_key_script`); an uninstall leaves it.
pub const TRIAL_KEY_PATH: &str = r"HKLM\SOFTWARE\Markiro\Standalone\Trial";

/// `reg query <key> /reg:64`: every value of the key at once, in the 64-bit
/// view of the registry the installer made the key in (never
/// `WOW6432Node`).
pub fn query_args() -> Vec<String> {
    ["query", TRIAL_KEY_PATH, "/reg:64"]
        .iter()
        .map(|part| (*part).to_owned())
        .collect()
}

/// `reg add <key> /v <name> /t REG_SZ /d <value> /f /reg:64`.
pub fn add_args(name: &str, value: &str) -> Vec<String> {
    [
        "add",
        TRIAL_KEY_PATH,
        "/v",
        name,
        "/t",
        "REG_SZ",
        "/d",
        value,
        "/f",
        "/reg:64",
    ]
    .iter()
    .map(|part| (*part).to_owned())
    .collect()
}

/// The value of the `REG_SZ` line of `name` that `reg query` prints
/// (`    StartedAt    REG_SZ    2026-10-20T09:00:00Z`); an empty value is
/// none. The names are compared as Windows does, without case.
pub fn registry_value<'a>(text: &'a str, name: &str) -> Option<&'a str> {
    text.lines().find_map(|line| {
        let mut parts = line.split_whitespace();
        if !parts.next()?.eq_ignore_ascii_case(name) || parts.next()? != "REG_SZ" {
            return None;
        }
        parts.next()
    })
}

/// What the mark holds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Mark {
    /// ms UTC.
    pub started_at: i64,
    /// The host that wrote it (empty when the value is missing): a reinstall
    /// makes a new host, and its trial is still this one.
    pub host_id: String,
    /// The INN the trial started with.
    pub inn: Option<String>,
}

/// Where the mark lives. Calls block (an external program on Windows): the
/// service calls them off the async threads.
pub trait TrialMark: Send + Sync + 'static {
    /// The mark; `Ok(None)` when the key holds none (or a start that does
    /// not read); an error when the key could not be read at all, which is
    /// no reason to write one.
    fn read(&self) -> Result<Option<Mark>, String>;
    /// Write the mark's values. The caller writes only when there is none.
    fn write(&self, mark: &Mark) -> Result<(), String>;
}

/// No mark: other systems than Windows, and the tests that do not ask for one.
#[derive(Debug, Clone, Copy, Default)]
pub struct NoMark;

impl TrialMark for NoMark {
    fn read(&self) -> Result<Option<Mark>, String> {
        Ok(None)
    }

    fn write(&self, _mark: &Mark) -> Result<(), String> {
        Ok(())
    }
}

/// The registry's mark through `reg.exe` (`install::SystemCommands` runs it
/// by its absolute path under `%SystemRoot%` on Windows). Values are text a
/// person can read in `regedit`: `StartedAt` (RFC 3339 UTC), `HostId`, `Inn`
/// (empty without one).
pub struct RegistryMark<C> {
    commands: Mutex<C>,
}

impl<C> RegistryMark<C> {
    pub fn new(commands: C) -> Self {
        Self {
            commands: Mutex::new(commands),
        }
    }
}

impl<C: Commands + Send + 'static> TrialMark for RegistryMark<C> {
    /// A key without `StartedAt` (the installer made it empty) is no mark.
    /// `reg.exe` ends with 1 on any failure (a missing key and a refused one
    /// alike), so every code but 0 is a failed read: the service could not
    /// make a missing key anyway (it may only set values in this one).
    fn read(&self) -> Result<Option<Mark>, String> {
        let mut commands = self
            .commands
            .lock()
            .map_err(|_| "the mark's lock is poisoned".to_owned())?;
        let output = commands
            .run("reg.exe", &query_args())
            .map_err(|error| error.to_string())?;
        if output.code != Some(0) {
            return Err(InstallError::Command {
                program: "reg.exe".to_owned(),
                code: output.code,
            }
            .to_string());
        }
        let text = String::from_utf8_lossy(&output.stdout);
        let Some(started_at) = registry_value(&text, "StartedAt")
            .and_then(|value| crate::clock::parse_timestamp(value).ok())
            .map(super::to_ms)
        else {
            return Ok(None);
        };
        Ok(Some(Mark {
            started_at,
            host_id: registry_value(&text, "HostId")
                .unwrap_or_default()
                .to_owned(),
            inn: registry_value(&text, "Inn").map(str::to_owned),
        }))
    }

    /// `HostId` and `Inn` first and `StartedAt` last: a mark is there once
    /// its start is, so a write stopped halfway leaves no start with another
    /// trial's INN, and the next start writes it again.
    fn write(&self, mark: &Mark) -> Result<(), String> {
        let mut commands = self
            .commands
            .lock()
            .map_err(|_| "the mark's lock is poisoned".to_owned())?;
        let values = [
            ("HostId", mark.host_id.clone()),
            ("Inn", mark.inn.clone().unwrap_or_default()),
            ("StartedAt", super::ms_text(mark.started_at)),
        ];
        for (name, value) in values {
            run_checked(&mut *commands, "reg.exe", &add_args(name, &value))
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    }
}

/// The mark this build keeps: the registry on Windows, none elsewhere.
pub fn system() -> Arc<dyn TrialMark> {
    #[cfg(windows)]
    {
        Arc::new(RegistryMark::new(crate::install::SystemCommands))
    }
    #[cfg(not(windows))]
    {
        Arc::new(NoMark)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::install::CommandOutput;

    /// `reg.exe` answering `code` and `stdout`; from run number `fail_from`
    /// on (counting from 1), code 1.
    #[derive(Default)]
    struct Fake {
        runs: Vec<(String, Vec<String>)>,
        code: i32,
        stdout: Vec<u8>,
        fail_from: Option<usize>,
    }

    impl Commands for Fake {
        fn run(&mut self, program: &str, args: &[String]) -> Result<CommandOutput, InstallError> {
            self.runs.push((program.to_owned(), args.to_vec()));
            if self.code == SPAWN_FAILS {
                return Err(InstallError::Spawn {
                    program: program.to_owned(),
                    reason: "not found".to_owned(),
                });
            }
            let failing = self.fail_from.is_some_and(|from| self.runs.len() >= from);
            Ok(CommandOutput {
                code: Some(if failing { 1 } else { self.code }),
                stdout: self.stdout.clone(),
            })
        }
    }

    fn strings(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| (*item).to_owned()).collect()
    }

    fn ms(text: &str) -> i64 {
        super::super::to_ms(crate::clock::parse_timestamp(text).unwrap())
    }

    const HOST: &str = "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
    /// The fake's code that stands for a `reg.exe` that could not start.
    const SPAWN_FAILS: i32 = -1;

    #[test]
    fn the_mark_is_the_values_reg_query_prints() {
        let stdout = b"\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Markiro\\Standalone\\Trial\r\n    \
HostId    REG_SZ    3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f\r\n    \
Inn    REG_SZ    7707083893\r\n    \
StartedAt    REG_SZ    2026-10-20T09:00:00Z\r\n\r\n"
            .to_vec();
        let mark = RegistryMark::new(Fake {
            stdout,
            ..Fake::default()
        });
        assert_eq!(
            mark.read(),
            Ok(Some(Mark {
                started_at: ms("2026-10-20T09:00:00Z"),
                host_id: HOST.to_owned(),
                inn: Some("7707083893".to_owned()),
            }))
        );
        assert_eq!(
            mark.commands.lock().unwrap().runs,
            [(
                "reg.exe".to_owned(),
                strings(&["query", TRIAL_KEY_PATH, "/reg:64"])
            )]
        );
    }

    #[test]
    fn a_mark_without_an_inn_or_a_host_reads_without_them() {
        let mark = RegistryMark::new(Fake {
            stdout: b"    Inn    REG_SZ    \r\n    StartedAt    REG_SZ    2026-10-20T09:00:00Z\r\n"
                .to_vec(),
            ..Fake::default()
        });
        assert_eq!(
            mark.read(),
            Ok(Some(Mark {
                started_at: ms("2026-10-20T09:00:00Z"),
                host_id: String::new(),
                inn: None,
            }))
        );
    }

    /// Windows compares value names without case, and so does the host.
    #[test]
    fn the_values_names_are_read_without_case() {
        let text = "    startedat    REG_SZ    2026-10-20T09:00:00Z\r\n    INN    REG_SZ    7707083893\r\n";
        assert_eq!(
            registry_value(text, "StartedAt"),
            Some("2026-10-20T09:00:00Z")
        );
        assert_eq!(registry_value(text, "Inn"), Some("7707083893"));
        let mark = RegistryMark::new(Fake {
            stdout: text.as_bytes().to_vec(),
            ..Fake::default()
        });
        assert_eq!(
            mark.read().map(|mark| mark.map(|mark| mark.started_at)),
            Ok(Some(ms("2026-10-20T09:00:00Z")))
        );
    }

    #[test]
    fn no_start_or_one_that_does_not_read_is_no_mark() {
        let empty_key = RegistryMark::new(Fake {
            stdout: b"\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Markiro\\Standalone\\Trial\r\n\r\n"
                .to_vec(),
            ..Fake::default()
        });
        assert_eq!(empty_key.read(), Ok(None));
        let garbled = RegistryMark::new(Fake {
            stdout: b"    StartedAt    REG_SZ    yesterday\r\n".to_vec(),
            ..Fake::default()
        });
        assert_eq!(garbled.read(), Ok(None));
        // A start of another type, or only the INN, is no start.
        let other_type = RegistryMark::new(Fake {
            stdout: b"    StartedAt    REG_DWORD    0x1\r\n    Inn    REG_SZ    7707083893\r\n"
                .to_vec(),
            ..Fake::default()
        });
        assert_eq!(other_type.read(), Ok(None));
    }

    /// A `reg.exe` that fails (any code but 0: it has no code of its own for
    /// a missing key), or that cannot start, is a read that failed, not a
    /// missing mark: the caller writes nothing over what it could not see.
    #[test]
    fn a_query_that_fails_or_cannot_start_is_no_reading() {
        for code in [1, 2, SPAWN_FAILS] {
            let failing = RegistryMark::new(Fake {
                code,
                stdout: b"    StartedAt    REG_SZ    2026-10-20T09:00:00Z\r\n".to_vec(),
                ..Fake::default()
            });
            assert!(failing.read().is_err(), "{code}");
        }
    }

    #[test]
    fn the_mark_writes_its_start_last_and_stops_at_a_refusal() {
        let mark = RegistryMark::new(Fake::default());
        let written = Mark {
            started_at: ms("2026-10-20T09:00:00Z"),
            host_id: HOST.to_owned(),
            inn: Some("7707083893".to_owned()),
        };
        mark.write(&written).unwrap();
        let add = |name: &str, value: &str| ("reg.exe".to_owned(), add_args(name, value));
        assert_eq!(
            mark.commands.lock().unwrap().runs,
            [
                add("HostId", HOST),
                add("Inn", "7707083893"),
                add("StartedAt", "2026-10-20T09:00:00Z"),
            ]
        );
        assert_eq!(
            add_args("Inn", "7707083893"),
            strings(&[
                "add",
                TRIAL_KEY_PATH,
                "/v",
                "Inn",
                "/t",
                "REG_SZ",
                "/d",
                "7707083893",
                "/f",
                "/reg:64"
            ])
        );
        // Without an INN the value is emptied, never left from another trial.
        let without_inn = RegistryMark::new(Fake::default());
        without_inn
            .write(&Mark {
                inn: None,
                ..written.clone()
            })
            .unwrap();
        assert_eq!(without_inn.commands.lock().unwrap().runs[1], add("Inn", ""));
        let refusing = RegistryMark::new(Fake {
            fail_from: Some(2),
            ..Fake::default()
        });
        assert!(refusing.write(&written).is_err());
        assert_eq!(refusing.commands.lock().unwrap().runs.len(), 2);
    }
}
