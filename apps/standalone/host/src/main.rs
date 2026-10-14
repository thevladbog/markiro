//! `markiro-host` command line:
//!   run [--data-dir <path>] [--port <port>]   serve in the foreground
//!   service                                   run under the Windows service manager
//!   print-fingerprint [--data-dir <path>]     print the certificate fingerprint
//!   restore <copy> [--data-dir <path>] [--without-manifest] [--keep-identity | --take-identity]
//!                                             put a copy back (the service stopped)
//!   verify-copy <copy> [--without-manifest]   check a copy
//!   install                                   register and start the service (Windows, administrator)
//!   uninstall                                 stop and remove it; the data stays (Windows, administrator)
//!   stop-service                              stop it and wait (Windows, administrator)
//!   network-check [--make-private]            list networks; exit 3 while one is public
//!   trust-keys                                print the kids of the keys this build trusts
//!
//! The installer's exit codes (`src-tauri/windows/installer-hooks.nsh`):
//! `install` 0 = running, 1 = failed, 4 = installed but not staying up (see
//! `failure_code`); `network-check` 0 = no public network, 3 = one remains,
//! 1 = failed; 2 = bad command line.

use std::path::PathBuf;
use std::process::ExitCode;

use markiro_host::config::{HostConfig, HostPaths};
use markiro_host::install::{InstallError, ServiceState, SystemCommands};
use markiro_host::network_profile::{self, PUBLIC_REMAINS};
use markiro_host::restore::{CopyIdentity, IdentityChoice, RestoreOptions};
use markiro_host::{BoxError, StartOptions};

#[derive(Debug, PartialEq, Eq)]
enum Command {
    Run {
        data_dir: PathBuf,
        port: Option<u16>,
    },
    Service,
    PrintFingerprint {
        data_dir: PathBuf,
    },
    Restore {
        data_dir: PathBuf,
        copy: PathBuf,
        without_manifest: bool,
        identity: IdentityChoice,
    },
    VerifyCopy {
        copy: PathBuf,
        without_manifest: bool,
    },
    Install,
    Uninstall,
    StopService,
    NetworkCheck {
        make_private: bool,
    },
    TrustKeys,
}

const USAGE: &str = "usage: markiro-host run [--data-dir <path>] [--port <port>]
       markiro-host service
       markiro-host print-fingerprint [--data-dir <path>]
       markiro-host restore <copy> [--data-dir <path>] [--without-manifest] [--keep-identity | --take-identity]
       markiro-host verify-copy <copy> [--without-manifest]
       markiro-host install | uninstall | stop-service
       markiro-host network-check [--make-private]
       markiro-host trust-keys";

fn parse(args: &[String]) -> Result<Command, String> {
    let (command, rest) = args.split_first().ok_or_else(|| USAGE.to_owned())?;
    match (command.as_str(), rest) {
        ("install", []) => return Ok(Command::Install),
        ("uninstall", []) => return Ok(Command::Uninstall),
        ("stop-service", []) => return Ok(Command::StopService),
        ("network-check", []) => {
            return Ok(Command::NetworkCheck {
                make_private: false,
            })
        }
        ("network-check", [flag]) if flag == "--make-private" => {
            return Ok(Command::NetworkCheck { make_private: true })
        }
        ("trust-keys", []) => return Ok(Command::TrustKeys),
        ("install" | "uninstall" | "stop-service" | "network-check" | "trust-keys", _) => {
            return Err(USAGE.to_owned())
        }
        _ => {}
    }
    // `restore` and `verify-copy` take the copy first.
    let (copy, rest) = match command.as_str() {
        "restore" | "verify-copy" => match rest.split_first() {
            Some((copy, rest)) if !copy.starts_with("--") => (Some(PathBuf::from(copy)), rest),
            _ => return Err(USAGE.to_owned()),
        },
        _ => (None, rest),
    };
    let mut data_dir = None;
    let mut port = None;
    let mut without_manifest = false;
    let mut identity = IdentityChoice::Auto;
    let mut index = 0;
    while index < rest.len() {
        let value = rest.get(index + 1);
        match rest[index].as_str() {
            "--data-dir" => {
                data_dir = Some(PathBuf::from(value.ok_or("--data-dir needs a path")?));
                index += 2;
            }
            "--port" => {
                let text = value.ok_or("--port needs a number")?;
                port = Some(text.parse::<u16>().map_err(|_| "--port must be 1-65535")?);
                index += 2;
            }
            "--without-manifest" => {
                without_manifest = true;
                index += 1;
            }
            flag @ ("--keep-identity" | "--take-identity") => {
                let chosen = if flag == "--keep-identity" {
                    IdentityChoice::Keep
                } else {
                    IdentityChoice::Take
                };
                if identity != IdentityChoice::Auto && identity != chosen {
                    return Err(format!(
                        "--keep-identity and --take-identity exclude each other\n{USAGE}"
                    ));
                }
                identity = chosen;
                index += 1;
            }
            other => return Err(format!("unknown argument {other}\n{USAGE}")),
        }
    }
    let data_dir_or_default =
        |data_dir: Option<PathBuf>| data_dir.unwrap_or_else(HostPaths::default_data_dir);
    // The identity flags belong to `restore` alone.
    if identity != IdentityChoice::Auto && command.as_str() != "restore" {
        return Err(USAGE.to_owned());
    }
    match (command.as_str(), copy) {
        ("run", None) if !without_manifest => Ok(Command::Run {
            data_dir: data_dir_or_default(data_dir),
            port,
        }),
        ("service", None) if rest.is_empty() => Ok(Command::Service),
        ("print-fingerprint", None) if port.is_none() && !without_manifest => {
            Ok(Command::PrintFingerprint {
                data_dir: data_dir_or_default(data_dir),
            })
        }
        ("restore", Some(copy)) if port.is_none() => Ok(Command::Restore {
            data_dir: data_dir_or_default(data_dir),
            copy,
            without_manifest,
            identity,
        }),
        ("verify-copy", Some(copy)) if port.is_none() && data_dir.is_none() => {
            Ok(Command::VerifyCopy {
                copy,
                without_manifest,
            })
        }
        _ => Err(USAGE.to_owned()),
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let command = match parse(&args) {
        Ok(command) => command,
        Err(message) => {
            eprintln!("{message}");
            return ExitCode::from(2);
        }
    };
    let result = match command {
        Command::Run { data_dir, port } => run_foreground(data_dir, port),
        Command::Service => run_service(),
        Command::PrintFingerprint { data_dir } => print_fingerprint(data_dir),
        Command::Restore {
            data_dir,
            copy,
            without_manifest,
            identity,
        } => restore(data_dir, copy, without_manifest, identity),
        Command::VerifyCopy {
            copy,
            without_manifest,
        } => verify_copy(copy, without_manifest),
        Command::Install => install_service(),
        Command::Uninstall => uninstall_service(),
        Command::StopService => stop_service(),
        Command::TrustKeys => {
            for kid in trust_keys() {
                println!("{kid}");
            }
            Ok(())
        }
        Command::NetworkCheck { make_private } => {
            let result = network_check(make_private);
            match &result {
                Ok(true) => {
                    eprintln!("markiro-host: a network is public; the host's port is closed on it")
                }
                Err(error) => eprintln!("markiro-host: {error}"),
                Ok(false) => {}
            }
            return ExitCode::from(network_check_code(&result));
        }
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("markiro-host: {error}");
            ExitCode::from(failure_code(&error))
        }
    }
}

/// `install` exits with this when the service is registered but did not stay
/// up after its start, or is still starting after the wait (a big first
/// migration): the installer keeps it (and warns) instead of failing. The
/// usual cause of the first is a restore that was not finished
/// (`markiro-host restore` again); the service manager keeps retrying every
/// minute.
const SERVICE_DID_NOT_STAY_UP: u8 = 4;

/// The exit code of a failed command: 1, or [`SERVICE_DID_NOT_STAY_UP`].
fn failure_code(error: &BoxError) -> u8 {
    match error.downcast_ref::<InstallError>() {
        Some(
            InstallError::StoppedAfterStart
            | InstallError::Timeout {
                waiting_for: ServiceState::Running,
            },
        ) => SERVICE_DID_NOT_STAY_UP,
        _ => 1,
    }
}

/// `network-check`: 0 when no network is public, [`PUBLIC_REMAINS`] while one
/// is, 1 when the check failed.
fn network_check_code(result: &Result<bool, BoxError>) -> u8 {
    match result {
        Ok(false) => 0,
        Ok(true) => PUBLIC_REMAINS,
        Err(_) => 1,
    }
}

/// `trust-keys`: the kids of the license keyset, then of the release keyset,
/// one per line (spec 2026-10-13 §5.2). A release build lists no `test-` kid;
/// the Windows CI job checks the installer's host.
fn trust_keys() -> Vec<String> {
    let license = markiro_proto::trust::license_keyset();
    let update = markiro_proto::trust::update_keyset();
    license
        .keys
        .into_iter()
        .chain(update.keys)
        .map(|key| key.kid)
        .collect()
}

fn run_foreground(data_dir: PathBuf, port: Option<u16>) -> Result<(), BoxError> {
    let paths = HostPaths::new(data_dir);
    paths.ensure()?;
    let _log_guard = markiro_host::logging::init(&paths.logs_dir(), true)?;
    let runtime = tokio::runtime::Runtime::new()?;
    let result = runtime.block_on(async {
        let host = markiro_host::start(
            &paths,
            StartOptions {
                port_override: port,
                bind: None,
            },
        )
        .await?;
        let _ = tokio::signal::ctrl_c().await;
        host.stop().await
    });
    // A write to an unreachable share may still block a thread: do not wait
    // for it for ever.
    markiro_host::shutdown_runtime(runtime);
    result
}

#[cfg(windows)]
fn run_service() -> Result<(), BoxError> {
    markiro_host::service::dispatch()
}

#[cfg(not(windows))]
fn run_service() -> Result<(), BoxError> {
    Err("the service command is only available on Windows".into())
}

#[cfg(windows)]
fn install_service() -> Result<(), BoxError> {
    let paths = HostPaths::new(HostPaths::default_data_dir());
    let executable = std::env::current_exe()?;
    let mut services = markiro_host::install_windows::WindowsServices::connect()?;
    let mut sleep = std::thread::sleep;
    let warnings = markiro_host::install::install_host(
        &paths,
        &executable,
        &mut services,
        &mut SystemCommands,
        &mut sleep,
    )?;
    for warning in warnings {
        eprintln!("markiro-host: {warning}");
    }
    println!(
        "{} is running; its data is in {}",
        markiro_host::install::SERVICE_NAME,
        paths.data_dir.display()
    );
    Ok(())
}

#[cfg(windows)]
fn uninstall_service() -> Result<(), BoxError> {
    let mut services = markiro_host::install_windows::WindowsServices::connect()?;
    let mut sleep = std::thread::sleep;
    markiro_host::install::uninstall(&mut services, &mut SystemCommands, &mut sleep)?;
    println!(
        "the service is removed; the data stays in {}",
        HostPaths::default_data_dir().display()
    );
    Ok(())
}

#[cfg(windows)]
fn stop_service() -> Result<(), BoxError> {
    let mut services = markiro_host::install_windows::WindowsServices::connect()?;
    let mut sleep = std::thread::sleep;
    if markiro_host::install::stop(&mut services, &mut sleep)? {
        println!("{} is stopped", markiro_host::install::SERVICE_NAME);
    } else {
        println!("{} is not installed", markiro_host::install::SERVICE_NAME);
    }
    Ok(())
}

#[cfg(not(windows))]
fn install_service() -> Result<(), BoxError> {
    Err("install is only available on Windows".into())
}

#[cfg(not(windows))]
fn uninstall_service() -> Result<(), BoxError> {
    Err("uninstall is only available on Windows".into())
}

#[cfg(not(windows))]
fn stop_service() -> Result<(), BoxError> {
    Err("stop-service is only available on Windows".into())
}

/// Prints every network and whether any of them is still public.
fn network_check(make_private: bool) -> Result<bool, BoxError> {
    let profiles = network_profile::check(&mut SystemCommands, make_private)?;
    for profile in &profiles {
        println!("{}: {}", profile.alias, profile.category);
    }
    Ok(profiles
        .iter()
        .any(network_profile::NetworkProfile::is_public))
}

fn print_fingerprint(data_dir: PathBuf) -> Result<(), BoxError> {
    let paths = HostPaths::new(data_dir);
    // Proves the directory is an existing host: never creates a host.json or
    // a TLS identity that was not there already.
    HostConfig::load(&paths)?;
    let identity = markiro_host::tls::TlsIdentity::load(&paths.tls_dir())?;
    println!("{}", identity.fingerprint);
    println!(
        "{}",
        markiro_proto::display_fingerprint(&identity.fingerprint)
    );
    Ok(())
}

fn restore(
    data_dir: PathBuf,
    copy: PathBuf,
    without_manifest: bool,
    identity: IdentityChoice,
) -> Result<(), BoxError> {
    let paths = HostPaths::new(data_dir);
    let runtime = tokio::runtime::Runtime::new()?;
    let result = runtime.block_on(markiro_host::restore::restore_now(
        &paths,
        &copy,
        RestoreOptions {
            without_manifest,
            identity,
        },
    ));
    // Reading a copy from an unreachable share can block a thread that
    // nothing cancels.
    markiro_host::shutdown_runtime(runtime);
    for line in markiro_host::restore::summary(&result?) {
        println!("{line}");
    }
    Ok(())
}

fn verify_copy(copy: PathBuf, without_manifest: bool) -> Result<(), BoxError> {
    let runtime = tokio::runtime::Runtime::new()?;
    let result = runtime.block_on(markiro_host::restore::verify_copy(&copy, without_manifest));
    markiro_host::shutdown_runtime(runtime);
    let verified = result?;
    let mut made = verified.manifest.as_ref().map_or_else(
        || "the manifest was not checked".to_owned(),
        |manifest| format!("made {}", manifest.created_at),
    );
    if verified.wal_folded {
        made.push_str(", the WAL beside it folded in");
    }
    println!(
        "{}: ok ({} bytes, sha256 {}, migration {}, {made})",
        verified.path.display(),
        verified.size_bytes,
        verified.sha256,
        verified.schema_version
    );
    match &verified.identity {
        CopyIdentity::Present(identity) => println!(
            "host identity: host {} (certificate {})",
            identity.host_id(),
            markiro_proto::display_fingerprint(identity.fingerprint())
        ),
        CopyIdentity::Absent => {
            println!("host identity: none (restored on a new computer, every device pairs again)");
        }
        CopyIdentity::Damaged(damage) => {
            return Err(format!(
                "host identity: DAMAGED ({}: {}); restore this copy only with --keep-identity, or take another copy",
                damage.code, damage.reason
            )
            .into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| (*item).to_owned()).collect()
    }

    #[test]
    fn run_accepts_a_data_dir_and_a_port() {
        assert_eq!(
            parse(&args(&["run", "--data-dir", "/tmp/h", "--port", "46000"])),
            Ok(Command::Run {
                data_dir: PathBuf::from("/tmp/h"),
                port: Some(46000)
            })
        );
    }

    #[test]
    fn invalid_invocations_are_rejected() {
        assert!(parse(&args(&[])).is_err());
        assert!(parse(&args(&["run", "--port", "70000"])).is_err());
        assert!(parse(&args(&["run", "--verbose"])).is_err());
        assert!(parse(&args(&["service", "--port", "1"])).is_err());
        assert!(parse(&args(&["print-fingerprint", "--port", "1"])).is_err());
        assert!(parse(&args(&["serve"])).is_err());
    }

    #[test]
    fn restore_and_verify_copy_take_the_copy_first() {
        assert_eq!(
            parse(&args(&[
                "restore",
                "C:/copies/a.db",
                "--data-dir",
                "/tmp/h"
            ])),
            Ok(Command::Restore {
                data_dir: PathBuf::from("/tmp/h"),
                copy: PathBuf::from("C:/copies/a.db"),
                without_manifest: false,
                identity: IdentityChoice::Auto,
            })
        );
        assert_eq!(
            parse(&args(&["restore", "a.db", "--without-manifest"])),
            Ok(Command::Restore {
                data_dir: HostPaths::default_data_dir(),
                copy: PathBuf::from("a.db"),
                without_manifest: true,
                identity: IdentityChoice::Auto,
            })
        );
        assert_eq!(
            parse(&args(&["verify-copy", "a.db", "--without-manifest"])),
            Ok(Command::VerifyCopy {
                copy: PathBuf::from("a.db"),
                without_manifest: true,
            })
        );
        assert!(parse(&args(&["restore"])).is_err());
        assert!(parse(&args(&["restore", "--data-dir", "/tmp/h"])).is_err());
        assert!(parse(&args(&["restore", "a.db", "--port", "1"])).is_err());
        assert!(parse(&args(&["verify-copy", "a.db", "--data-dir", "/tmp/h"])).is_err());
        assert!(parse(&args(&["run", "--without-manifest"])).is_err());
        assert!(parse(&args(&["print-fingerprint", "--without-manifest"])).is_err());
    }

    #[test]
    fn restore_takes_one_identity_flag_and_no_other_command_takes_one() {
        assert_eq!(
            parse(&args(&["restore", "a.db", "--take-identity"])),
            Ok(Command::Restore {
                data_dir: HostPaths::default_data_dir(),
                copy: PathBuf::from("a.db"),
                without_manifest: false,
                identity: IdentityChoice::Take,
            })
        );
        assert_eq!(
            parse(&args(&[
                "restore",
                "a.db",
                "--keep-identity",
                "--keep-identity"
            ])),
            Ok(Command::Restore {
                data_dir: HostPaths::default_data_dir(),
                copy: PathBuf::from("a.db"),
                without_manifest: false,
                identity: IdentityChoice::Keep,
            })
        );
        assert!(parse(&args(&[
            "restore",
            "a.db",
            "--keep-identity",
            "--take-identity"
        ]))
        .is_err());
        assert!(parse(&args(&["verify-copy", "a.db", "--take-identity"])).is_err());
        assert!(parse(&args(&["run", "--keep-identity"])).is_err());
    }

    #[test]
    fn trust_keys_takes_no_argument() {
        assert_eq!(parse(&args(&["trust-keys"])), Ok(Command::TrustKeys));
        assert!(parse(&args(&["trust-keys", "--data-dir", "/tmp/h"])).is_err());
        assert!(parse(&args(&["trust-keys", "license"])).is_err());
    }

    /// A test build trusts the domain's test keys (the `test-keys` feature of
    /// the host's dev-dependency): the license kids first, then the release's.
    #[test]
    fn trust_keys_lists_the_license_kids_then_the_release_kids() {
        let kids = trust_keys();
        let license: Vec<String> = markiro_proto::trust::license_keyset()
            .keys
            .into_iter()
            .map(|key| key.kid)
            .collect();
        assert!(license.contains(&"test-lic-1".to_owned()), "{license:?}");
        assert_eq!(kids[..license.len()], license[..]);
        assert!(
            kids[license.len()..].contains(&"test-upd-1".to_owned()),
            "{kids:?}"
        );
    }

    #[test]
    fn restore_of_a_missing_copy_is_an_error_and_writes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let error = restore(
            dir.path().to_path_buf(),
            dir.path().join("no-such-copy.db"),
            true,
            IdentityChoice::Auto,
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("is not a file"), "{error}");
        assert!(error.contains("Nothing was changed"), "{error}");
        assert!(std::fs::read_dir(dir.path()).unwrap().next().is_none());
    }

    #[test]
    fn the_installer_commands_take_no_arguments_but_the_network_flag() {
        assert_eq!(parse(&args(&["install"])), Ok(Command::Install));
        assert_eq!(parse(&args(&["uninstall"])), Ok(Command::Uninstall));
        assert_eq!(parse(&args(&["stop-service"])), Ok(Command::StopService));
        assert_eq!(
            parse(&args(&["network-check"])),
            Ok(Command::NetworkCheck {
                make_private: false
            })
        );
        assert_eq!(
            parse(&args(&["network-check", "--make-private"])),
            Ok(Command::NetworkCheck { make_private: true })
        );
        for invalid in [
            &["install", "--data-dir", "/tmp/h"][..],
            &["uninstall", "now"][..],
            &["stop-service", "--port", "1"][..],
            &["network-check", "--private"][..],
            &["network-check", "--make-private", "--make-private"][..],
        ] {
            assert!(parse(&args(invalid)).is_err(), "{invalid:?}");
        }
    }

    #[cfg(not(windows))]
    #[test]
    fn the_service_commands_refuse_outside_windows() {
        assert!(install_service().is_err());
        assert!(uninstall_service().is_err());
        assert!(stop_service().is_err());
    }

    /// The installer's hooks read these codes (plan УСТ, task 5).
    #[test]
    fn the_installers_exit_codes_are_the_documented_ones() {
        let stayed_down: BoxError = Box::new(InstallError::StoppedAfterStart);
        let refused: BoxError = Box::new(InstallError::Command {
            program: "icacls".into(),
            code: Some(5),
        });
        let plain: BoxError = "no".into();
        // A start that is still under way after the wait (a big first
        // migration) leaves the service registered as well: a warning.
        let still_starting: BoxError = Box::new(InstallError::Timeout {
            waiting_for: markiro_host::install::ServiceState::Running,
        });
        let never_stopped: BoxError = Box::new(InstallError::Timeout {
            waiting_for: markiro_host::install::ServiceState::Stopped,
        });
        assert_eq!(failure_code(&still_starting), 4);
        assert_eq!(failure_code(&never_stopped), 1);
        assert_eq!(failure_code(&stayed_down), 4);
        assert_eq!(failure_code(&refused), 1);
        assert_eq!(failure_code(&plain), 1);
        assert_eq!(network_check_code(&Ok(false)), 0);
        assert_eq!(network_check_code(&Ok(true)), 3);
        assert_eq!(network_check_code(&Err("no".into())), 1);
    }

    #[test]
    fn print_fingerprint_on_an_empty_dir_is_an_error_and_writes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        assert!(print_fingerprint(dir.path().to_path_buf()).is_err());
        assert!(std::fs::read_dir(dir.path()).unwrap().next().is_none());
    }
}
