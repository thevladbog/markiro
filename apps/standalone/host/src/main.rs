//! `markiro-host` command line:
//!   run [--data-dir <path>] [--port <port>]   serve in the foreground
//!   service                                   run under the Windows service manager
//!   print-fingerprint [--data-dir <path>]     print the certificate fingerprint

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
}

const USAGE: &str = "usage: markiro-host run [--data-dir <path>] [--port <port>]
       markiro-host service
       markiro-host print-fingerprint [--data-dir <path>]";

fn parse(args: &[String]) -> Result<Command, String> {
    let (command, rest) = args.split_first().ok_or_else(|| USAGE.to_owned())?;
    let mut data_dir = None;
    let mut port = None;
    let mut index = 0;
    while index < rest.len() {
        let value = rest.get(index + 1);
        match rest[index].as_str() {
            "--data-dir" => {
                data_dir = Some(PathBuf::from(value.ok_or("--data-dir needs a path")?));
            }
            "--port" => {
                let text = value.ok_or("--port needs a number")?;
                port = Some(text.parse::<u16>().map_err(|_| "--port must be 1-65535")?);
            }
            other => return Err(format!("unknown argument {other}\n{USAGE}")),
        }
        index += 2;
    }
    match command.as_str() {
        "run" => Ok(Command::Run {
            data_dir: data_dir.unwrap_or_else(HostPaths::default_data_dir),
            port,
        }),
        "service" if rest.is_empty() => Ok(Command::Service),
        "print-fingerprint" if port.is_none() => Ok(Command::PrintFingerprint {
            data_dir: data_dir.unwrap_or_else(HostPaths::default_data_dir),
        }),
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
    runtime.block_on(async {
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
    })
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
    paths.ensure()?;
    let config = HostConfig::load_or_create(&paths, None)?;
    let identity =
        markiro_host::tls::TlsIdentity::load_or_create(&paths.tls_dir(), &config.host_id)?;
    println!("{}", identity.fingerprint);
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
}
