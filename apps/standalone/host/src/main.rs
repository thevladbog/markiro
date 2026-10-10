//! `markiro-host` command line:
//!   run [--data-dir <path>] [--port <port>]   serve in the foreground
//!   service                                   run under the Windows service manager
//!   print-fingerprint [--data-dir <path>]     print the certificate fingerprint
//!   restore <copy> [--data-dir <path>] [--without-manifest]
//!                                             put a copy back (the service stopped)
//!   verify-copy <copy> [--without-manifest]   check a copy

use std::path::PathBuf;
use std::process::ExitCode;

use markiro_host::config::{HostConfig, HostPaths};
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
    },
    VerifyCopy {
        copy: PathBuf,
        without_manifest: bool,
    },
}

const USAGE: &str = "usage: markiro-host run [--data-dir <path>] [--port <port>]
       markiro-host service
       markiro-host print-fingerprint [--data-dir <path>]
       markiro-host restore <copy> [--data-dir <path>] [--without-manifest]
       markiro-host verify-copy <copy> [--without-manifest]";

fn parse(args: &[String]) -> Result<Command, String> {
    let (command, rest) = args.split_first().ok_or_else(|| USAGE.to_owned())?;
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
            other => return Err(format!("unknown argument {other}\n{USAGE}")),
        }
    }
    let data_dir_or_default =
        |data_dir: Option<PathBuf>| data_dir.unwrap_or_else(HostPaths::default_data_dir);
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
        } => restore(data_dir, copy, without_manifest),
        Command::VerifyCopy {
            copy,
            without_manifest,
        } => verify_copy(copy, without_manifest),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("markiro-host: {error}");
            ExitCode::FAILURE
        }
    }
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

fn restore(data_dir: PathBuf, copy: PathBuf, without_manifest: bool) -> Result<(), BoxError> {
    let paths = HostPaths::new(data_dir);
    let runtime = tokio::runtime::Runtime::new()?;
    let result = runtime.block_on(markiro_host::restore::restore(
        &paths,
        &copy,
        without_manifest,
        time::OffsetDateTime::now_utc(),
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
            })
        );
        assert_eq!(
            parse(&args(&["restore", "a.db", "--without-manifest"])),
            Ok(Command::Restore {
                data_dir: HostPaths::default_data_dir(),
                copy: PathBuf::from("a.db"),
                without_manifest: true,
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
    fn restore_of_a_missing_copy_is_an_error_and_writes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let error = restore(
            dir.path().to_path_buf(),
            dir.path().join("no-such-copy.db"),
            true,
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("is not a file"), "{error}");
        assert!(error.contains("Nothing was changed"), "{error}");
        assert!(std::fs::read_dir(dir.path()).unwrap().next().is_none());
    }

    #[test]
    fn print_fingerprint_on_an_empty_dir_is_an_error_and_writes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        assert!(print_fingerprint(dir.path().to_path_buf()).is_err());
        assert!(std::fs::read_dir(dir.path()).unwrap().next().is_none());
    }
}
