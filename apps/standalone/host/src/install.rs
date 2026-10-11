//! Installing `markiro-host` as the Windows service `MarkiroHost` (plan УСТ):
//! the data directory's permissions, the service with its restart policy,
//! the firewall rule for the host's port, and taking them away again. The
//! installer runs `markiro-host install`, `uninstall` and `stop-service`
//! (`src-tauri/windows/installer-hooks.nsh`).
//!
//! Everything here goes through two seams, so the order of the steps and the
//! exact command lines are tested on any OS: [`Services`] (the Windows
//! service manager: `install_windows::WindowsServices`) and [`Commands`]
//! (external programs: [`SystemCommands`]). Uninstalling never touches the
//! data directory.

use std::fmt;
use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;

/// The service name; `service.rs` dispatches under the same one.
pub const SERVICE_NAME: &str = "MarkiroHost";
/// The firewall rule's name (`Get-NetFirewallRule -Name MarkiroHost`).
pub const FIREWALL_RULE: &str = "MarkiroHost";
/// `NT AUTHORITY\LocalService`: no password, no administrator rights, and the
/// network as an anonymous user, which a host that only listens never needs.
pub const SERVICE_ACCOUNT: &str = r"NT AUTHORITY\LocalService";
/// How long `install` waits for the service to run, and any command for it to stop.
pub const WAIT_LIMIT: Duration = Duration::from_secs(30);
/// How often the state is read while waiting.
pub const POLL_EVERY: Duration = Duration::from_millis(500);

/// The data directory's access list: inheritance from `ProgramData` off
/// (users lose read access to the database and the TLS key), full control
/// for SYSTEM (`S-1-5-18`) and Administrators (`S-1-5-32-544`), modify for
/// the service's LocalService (`S-1-5-19`), inherited by everything inside.
/// SIDs, not names, because names are translated on a Russian Windows.
pub const DATA_DIR_GRANTS: [&str; 3] = [
    "*S-1-5-18:(OI)(CI)F",
    "*S-1-5-32-544:(OI)(CI)F",
    "*S-1-5-19:(OI)(CI)M",
];

/// What a service reports while `install` and `stop` wait for it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ServiceState {
    Stopped,
    StartPending,
    StopPending,
    Running,
    /// Paused, or a state this code has no use for.
    Other,
}

/// The service as `install` registers it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServiceSpec {
    pub name: &'static str,
    pub display_name: &'static str,
    pub description: &'static str,
    pub executable: PathBuf,
    pub arguments: Vec<String>,
    pub account: &'static str,
    /// Starts with Windows, before anybody signs in.
    pub automatic: bool,
    /// One restart per failure, after these delays; the last repeats.
    pub restart_delays: [Duration; 3],
    /// A day without failures starts the count again.
    pub reset_after: Duration,
    /// `sc failureflag MarkiroHost 1`: an exit with an error code
    /// (`service.rs` reports `ServiceSpecific(1)`) counts as a failure too,
    /// not only a crash.
    pub failure_actions_on_non_crash: bool,
}

/// The service `install` registers for the host binary at `executable`.
pub fn service_spec(executable: &Path) -> ServiceSpec {
    ServiceSpec {
        name: SERVICE_NAME,
        display_name: "Markiro Хост",
        description: "Главная база Markiro Автоном: станции и офис площадки подключаются к ней по HTTPS, порт 45710.",
        executable: executable.to_path_buf(),
        arguments: vec!["service".to_owned()],
        account: SERVICE_ACCOUNT,
        automatic: true,
        restart_delays: [
            Duration::from_secs(5),
            Duration::from_secs(30),
            Duration::from_secs(60),
        ],
        reset_after: Duration::from_secs(24 * 60 * 60),
        failure_actions_on_non_crash: true,
    }
}

/// The Windows service manager, as far as installing needs it.
pub trait Services {
    /// `None` when no service of this name is installed.
    fn state(&mut self) -> Result<Option<ServiceState>, InstallError>;
    /// Creates the service, or rewrites the whole configuration of an existing one.
    fn configure(&mut self, spec: &ServiceSpec) -> Result<(), InstallError>;
    /// Asks a stopped service to start; a running one stays as it is.
    fn start(&mut self) -> Result<(), InstallError>;
    /// Asks a running service to stop; a stopped one stays as it is.
    fn stop(&mut self) -> Result<(), InstallError>;
    /// Removes the registration; Windows finishes once the last handle closes.
    fn delete(&mut self) -> Result<(), InstallError>;
}

/// A finished external program.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandOutput {
    /// `None` when the program ended without a code.
    pub code: Option<i32>,
    pub stdout: Vec<u8>,
}

/// External programs (`icacls`, `powershell`).
pub trait Commands {
    fn run(&mut self, program: &str, args: &[String]) -> Result<CommandOutput, InstallError>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InstallError {
    /// The service manager refused; the text is the system's.
    Service(String),
    /// A program could not be started.
    Spawn { program: String, reason: String },
    /// A program ended with another code than 0.
    Command { program: String, code: Option<i32> },
    /// A program's output is not what it should print.
    Output { program: String },
    /// The service did not reach `waiting_for` within [`WAIT_LIMIT`].
    Timeout { waiting_for: ServiceState },
    /// The service stopped right after it was started: see the host's log.
    StoppedAfterStart,
}

impl fmt::Display for InstallError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            InstallError::Service(reason) => write!(formatter, "service manager: {reason}"),
            InstallError::Spawn { program, reason } => {
                write!(formatter, "{program} could not start: {reason}")
            }
            InstallError::Command { program, code } => match code {
                Some(code) => write!(formatter, "{program} ended with code {code}"),
                None => write!(formatter, "{program} ended without a code"),
            },
            InstallError::Output { program } => {
                write!(formatter, "{program} printed an unexpected answer")
            }
            InstallError::Timeout { waiting_for } => write!(
                formatter,
                "the service did not reach {waiting_for:?} in {} s",
                WAIT_LIMIT.as_secs()
            ),
            InstallError::StoppedAfterStart => write!(
                formatter,
                "the service stopped right after it started; see the logs in the host's data \
                 directory (a restore that was not finished keeps the host down: run \
                 markiro-host restore again)"
            ),
        }
    }
}

impl std::error::Error for InstallError {}

/// Register and start the host service (the installer's role «хост и станция»):
/// harden `data_dir`, stop a service an earlier version left running, write
/// the configuration, open `port` in the firewall, start, and wait until it
/// runs. Repeating it over an installed service converges on the same state.
/// A failed fresh install removes the service and the rule it made; a failed
/// upgrade, and a service that was started but does not come up, stay.
pub fn install(
    data_dir: &Path,
    executable: &Path,
    port: u16,
    services: &mut dyn Services,
    commands: &mut dyn Commands,
    sleep: &mut dyn FnMut(Duration),
) -> Result<(), InstallError> {
    run_checked(commands, "icacls", &icacls_args(data_dir))?;
    let existed = stop(services, sleep)?;
    if let Err(error) = register_and_start(executable, port, services, commands) {
        // A fresh install that failed halfway leaves nothing behind; an
        // upgrade keeps the service it found (running the install again
        // converges, deleting the customer's service would not).
        if !existed {
            undo_fresh_install(services, commands);
        }
        return Err(error);
    }
    // From here the service stays whatever happens: a slow start (a big
    // database to migrate) must not lose it, and a host that refuses to start
    // (an interrupted restore) keeps its restart policy until the restore is
    // finished.
    wait_until_running(services, sleep)
}

/// The steps that can leave a half-made registration behind.
fn register_and_start(
    executable: &Path,
    port: u16,
    services: &mut dyn Services,
    commands: &mut dyn Commands,
) -> Result<(), InstallError> {
    services.configure(&service_spec(executable))?;
    run_checked(
        commands,
        "powershell.exe",
        &powershell_args(&firewall_open_script(port)),
    )?;
    services.start()
}

/// Best effort, no waiting: whatever fails here must not hide the error that
/// made the install fail.
fn undo_fresh_install(services: &mut dyn Services, commands: &mut dyn Commands) {
    match services.state() {
        Ok(None) => {}
        Ok(Some(ServiceState::Stopped)) | Err(_) => {
            let _ = services.delete();
        }
        Ok(Some(_)) => {
            let _ = services.stop();
            let _ = services.delete();
        }
    }
    let _ = commands.run("powershell.exe", &powershell_args(&firewall_close_script()));
}

/// Stop and remove the host service and its firewall rule. The data
/// directory stays: the database, the TLS identity and the logs survive an
/// uninstall, so a reinstall brings back the same host for every paired device.
pub fn uninstall(
    services: &mut dyn Services,
    commands: &mut dyn Commands,
    sleep: &mut dyn FnMut(Duration),
) -> Result<(), InstallError> {
    if stop(services, sleep)? {
        services.delete()?;
    }
    run_checked(
        commands,
        "powershell.exe",
        &powershell_args(&firewall_close_script()),
    )?;
    Ok(())
}

/// Stop the service and wait until it has stopped; `Ok(false)` when there is
/// no such service. The installer calls it before it replaces the binary.
pub fn stop(
    services: &mut dyn Services,
    sleep: &mut dyn FnMut(Duration),
) -> Result<bool, InstallError> {
    match services.state()? {
        None => return Ok(false),
        Some(ServiceState::Stopped) => return Ok(true),
        Some(_) => services.stop()?,
    }
    for _ in 0..polls() {
        match services.state()? {
            None | Some(ServiceState::Stopped) => return Ok(true),
            Some(_) => sleep(POLL_EVERY),
        }
    }
    Err(InstallError::Timeout {
        waiting_for: ServiceState::Stopped,
    })
}

fn wait_until_running(
    services: &mut dyn Services,
    sleep: &mut dyn FnMut(Duration),
) -> Result<(), InstallError> {
    for _ in 0..polls() {
        match services.state()? {
            Some(ServiceState::Running) => return Ok(()),
            Some(ServiceState::Stopped) | None => return Err(InstallError::StoppedAfterStart),
            Some(_) => sleep(POLL_EVERY),
        }
    }
    Err(InstallError::Timeout {
        waiting_for: ServiceState::Running,
    })
}

fn polls() -> u32 {
    (WAIT_LIMIT.as_millis() / POLL_EVERY.as_millis()) as u32
}

/// Runs `program` and requires exit code 0.
pub fn run_checked(
    commands: &mut dyn Commands,
    program: &str,
    args: &[String],
) -> Result<CommandOutput, InstallError> {
    let output = commands.run(program, args)?;
    if output.code == Some(0) {
        Ok(output)
    } else {
        Err(InstallError::Command {
            program: program.to_owned(),
            code: output.code,
        })
    }
}

/// `icacls <dir> /inheritance:r /grant:r <DATA_DIR_GRANTS…>`.
pub fn icacls_args(data_dir: &Path) -> Vec<String> {
    let mut args = vec![
        data_dir.display().to_string(),
        "/inheritance:r".to_owned(),
        "/grant:r".to_owned(),
    ];
    args.extend(DATA_DIR_GRANTS.iter().map(|grant| (*grant).to_owned()));
    args
}

/// Windows PowerShell with a script passed as `-EncodedCommand`, so no
/// quoting rule of the command line can change it.
pub fn powershell_args(script: &str) -> Vec<String> {
    vec![
        "-NoProfile".to_owned(),
        "-NonInteractive".to_owned(),
        "-ExecutionPolicy".to_owned(),
        "Bypass".to_owned(),
        "-EncodedCommand".to_owned(),
        encode_command(script),
    ]
}

/// `-EncodedCommand`'s form: base64 of the script in UTF-16LE.
pub fn encode_command(script: &str) -> String {
    let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    STANDARD.encode(bytes)
}

/// The inbound rule for the host's port: TCP only, private and domain
/// networks only, and only from the local subnet. A Wi-Fi network Windows
/// counts as public is left closed; `network-check` offers to change that.
pub fn firewall_open_script(port: u16) -> String {
    format!(
        "$ErrorActionPreference = 'Stop'; \
Remove-NetFirewallRule -Name '{FIREWALL_RULE}' -ErrorAction SilentlyContinue; \
New-NetFirewallRule -Name '{FIREWALL_RULE}' -DisplayName 'Markiro Хост (TCP {port})' \
-Direction Inbound -Action Allow -Protocol TCP -LocalPort {port} \
-Profile Private,Domain -RemoteAddress LocalSubnet | Out-Null"
    )
}

/// Removes the rule; a rule that is already gone is no error.
pub fn firewall_close_script() -> String {
    format!("Remove-NetFirewallRule -Name '{FIREWALL_RULE}' -ErrorAction SilentlyContinue; exit 0")
}

/// External programs through `std::process::Command`, without a console
/// window on Windows (the installer is a window of its own).
pub struct SystemCommands;

impl Commands for SystemCommands {
    fn run(&mut self, program: &str, args: &[String]) -> Result<CommandOutput, InstallError> {
        let mut command = std::process::Command::new(program);
        command.args(args);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // `CREATE_NO_WINDOW`.
            const NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(NO_WINDOW);
        }
        let output = command.output().map_err(|error| InstallError::Spawn {
            program: program.to_owned(),
            reason: error.to_string(),
        })?;
        Ok(CommandOutput {
            code: output.status.code(),
            stdout: output.stdout,
        })
    }
}
