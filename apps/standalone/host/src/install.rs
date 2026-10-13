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

use crate::config::{HostConfig, HostPaths};

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

/// The owner the data directory, everything in it and its `Markiro` folder
/// get: Administrators (`S-1-5-32-544`). A user may make the folder (or a file
/// in it) before the install, since `ProgramData` lets users create folders;
/// as its owner that user could grant themselves the database again.
pub const DATA_DIR_OWNER: &str = "*S-1-5-32-544";

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
    /// The account a new service runs as. `None` for a service that exists
    /// already: it keeps its account (IT may have given it one that writes to
    /// a share), and every update is a reinstall.
    pub account: Option<&'static str>,
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
        account: Some(SERVICE_ACCOUNT),
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
    /// Asks a running service to stop. A service that cannot take the request
    /// now (stopped, starting, already stopping) is no error: [`stop`] reads
    /// the state and asks again.
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
    // The owner first: an owner keeps the right to change the access list,
    // and taking ownership is what opens a folder whose list shuts the
    // administrators out.
    if let Some(markiro) = markiro_folder(data_dir) {
        run_checked(commands, "icacls", &owner_args(&markiro, false))?;
    }
    run_checked(
        commands,
        "icacls",
        &owner_args(&data_dir.display().to_string(), true),
    )?;
    run_checked(commands, "icacls", &icacls_args(data_dir))?;
    let existed = stop(services, sleep)?;
    if let Err(error) = register_and_start(existed, executable, port, services, commands) {
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

/// The warning of an install whose trial key (plan ЛЦ-2, spec §3.4) was not
/// prepared. It names no value of the failure: the console shows it as is.
pub const TRIAL_KEY_WARNING: &str =
    "the trial mark's registry key was not prepared; the trial is kept in the database only";

/// The `install` subcommand: creates the data directory (and the folders in
/// it), which `icacls` needs to exist, then [`install`] with the port the host
/// is configured for (`host.json`, else the default). Returns the warnings of
/// steps that failed without stopping the install, for the installer's
/// console (the command keeps no log).
pub fn install_host(
    paths: &HostPaths,
    executable: &Path,
    services: &mut dyn Services,
    commands: &mut dyn Commands,
    sleep: &mut dyn FnMut(Duration),
) -> Result<Vec<&'static str>, crate::BoxError> {
    paths.ensure()?;
    let mut warnings = Vec::new();
    // The trial's mark (plan ЛЦ-2, spec §3.4): a key the service may set
    // values in. A refusal does not stop the install: the database keeps the
    // trial too.
    if let Err(error) = run_checked(
        commands,
        "powershell.exe",
        &powershell_args(&trial_key_script()),
    ) {
        tracing::warn!(%error, "the trial mark's registry key was not prepared");
        warnings.push(TRIAL_KEY_WARNING);
    }
    install(
        &paths.data_dir,
        executable,
        configured_port(paths),
        services,
        commands,
        sleep,
    )?;
    Ok(warnings)
}

/// The host's port for the firewall: `host.json`'s when the host has started
/// before (a `--port` it was given), the default otherwise.
pub fn configured_port(paths: &HostPaths) -> u16 {
    HostConfig::load(paths)
        .map(|config| config.port)
        .unwrap_or(markiro_proto::DEFAULT_PORT)
}

/// The steps that can leave a half-made registration behind.
fn register_and_start(
    existed: bool,
    executable: &Path,
    port: u16,
    services: &mut dyn Services,
    commands: &mut dyn Commands,
) -> Result<(), InstallError> {
    let mut spec = service_spec(executable);
    if existed {
        // An update keeps the account the service runs as.
        spec.account = None;
    }
    services.configure(&spec)?;
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
/// no such service. The installer calls it before it replaces the binary. A
/// service that is still starting refuses the stop, so it is asked again at
/// every read until it is stopping.
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
            Some(ServiceState::StopPending) => sleep(POLL_EVERY),
            // The host's status accepts no control while it starts
            // (`service.rs`), and the service manager then refuses the stop;
            // `WindowsServices::stop` reports that as no error. So the ask is
            // repeated until the service has come up and takes it.
            Some(_) => {
                services.stop()?;
                sleep(POLL_EVERY);
            }
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

/// The data directory's parent when it is the `Markiro` folder (as in
/// `%ProgramData%\Markiro\Host`), never another folder: an unusual data
/// directory must not change the owner of a drive or of `ProgramData`. Both
/// separators count, so a Windows path reads the same on every system.
pub fn markiro_folder(data_dir: &Path) -> Option<String> {
    let dir = data_dir.display().to_string();
    let dir = dir.trim_end_matches(['\\', '/']);
    let (parent, _) = dir.rsplit_once(['\\', '/'])?;
    let name = parent.rsplit(['\\', '/']).next()?;
    name.eq_ignore_ascii_case("Markiro")
        .then(|| parent.to_owned())
}

/// `icacls <dir> /setowner <DATA_DIR_OWNER>`, with `/T /C` for everything in
/// it when `recursive`.
pub fn owner_args(dir: &str, recursive: bool) -> Vec<String> {
    let mut args = vec![
        dir.to_owned(),
        "/setowner".to_owned(),
        DATA_DIR_OWNER.to_owned(),
    ];
    if recursive {
        args.extend(["/T".to_owned(), "/C".to_owned()]);
    }
    args
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

/// The key of the trial's mark (plan ЛЦ-2, spec §3.4), made with the
/// installer's administrator rights; LocalService (`*S-1-5-19`) may read it
/// and set values in this key only (no inheritance to subkeys). An existing
/// key keeps its values, and an uninstall leaves it.
pub fn trial_key_script() -> String {
    "$ErrorActionPreference = 'Stop'; \
$path = 'HKLM:\\SOFTWARE\\Markiro\\Standalone\\Trial'; \
if (-not (Test-Path -LiteralPath $path)) { New-Item -Path $path -Force | Out-Null }; \
$acl = Get-Acl -LiteralPath $path; \
$sid = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-19'); \
$rule = New-Object System.Security.AccessControl.RegistryAccessRule($sid, 'ReadKey, SetValue', 'None', 'None', 'Allow'); \
$acl.SetAccessRule($rule); \
Set-Acl -LiteralPath $path -AclObject $acl"
        .to_owned()
}

/// Removes the rule; a rule that is already gone is no error.
pub fn firewall_close_script() -> String {
    format!("Remove-NetFirewallRule -Name '{FIREWALL_RULE}' -ErrorAction SilentlyContinue; exit 0")
}

/// `winerror.h`: the service manager's answers `WindowsServices` has to tell
/// apart. Numbers, not text: the text is translated on a Russian Windows.
pub const ERROR_ACCESS_DENIED: i32 = 5;
pub const ERROR_SERVICE_DOES_NOT_EXIST: i32 = 1060;
pub const ERROR_SERVICE_CANNOT_ACCEPT_CTRL: i32 = 1061;
pub const ERROR_SERVICE_NOT_ACTIVE: i32 = 1062;
pub const ERROR_SERVICE_ALREADY_RUNNING: i32 = 1056;
pub const ERROR_SERVICE_MARKED_FOR_DELETE: i32 = 1072;

/// A refused stop that leaves nothing to do: the service is not running, or it
/// is changing state right now (it refuses a stop while it starts or stops;
/// [`stop`] asks again until the service is stopping).
pub fn stop_refusal_is_harmless(code: i32) -> bool {
    code == ERROR_SERVICE_NOT_ACTIVE || code == ERROR_SERVICE_CANNOT_ACCEPT_CTRL
}

/// A refused start that leaves nothing to do: the service already runs.
pub fn start_refusal_is_harmless(code: i32) -> bool {
    code == ERROR_SERVICE_ALREADY_RUNNING
}

/// A refused delete that leaves nothing to do: the service is already going.
pub fn delete_refusal_is_harmless(code: i32) -> bool {
    code == ERROR_SERVICE_MARKED_FOR_DELETE
}

/// The service manager's own text for a refusal, and for the two that a person
/// can fix, what to do about it.
pub fn service_error_text(text: String, code: Option<i32>) -> String {
    match code {
        Some(ERROR_ACCESS_DENIED) => format!(
            "{text} (run the command from an administrator session: right-click, \
             \"Run as administrator\")"
        ),
        Some(ERROR_SERVICE_MARKED_FOR_DELETE) => format!(
            "{text} (an earlier removal is not finished because a program still has the service \
             open: close the Services and Event Viewer windows, or restart the computer, and \
             run the command again)"
        ),
        _ => text,
    }
}

/// Where Windows keeps its own programs when the environment does not say, or
/// says something that is not a plain absolute directory.
const DEFAULT_SYSTEM_ROOT: &str = r"C:\Windows";

/// `%SystemRoot%` as given (`None` when unset), when it is a plain absolute
/// path with a drive letter: no `..`, no characters a path cannot hold, no
/// relative or UNC form. Otherwise `C:\Windows`. The installer runs elevated,
/// so a program found through a changed `PATH` or a changed variable would run
/// with administrator rights.
pub fn trusted_system_root(value: Option<&str>) -> String {
    let Some(value) = value else {
        return DEFAULT_SYSTEM_ROOT.to_owned();
    };
    let bytes = value.as_bytes();
    let absolute =
        bytes.len() > 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'\\';
    let clean = !value.contains(['"', '<', '>', '|', '?', '*', ';', '/'])
        && !value.chars().any(char::is_control)
        && !value.split('\\').any(|part| part == "..");
    if absolute && clean {
        value.trim_end_matches('\\').to_owned()
    } else {
        DEFAULT_SYSTEM_ROOT.to_owned()
    }
}

/// The absolute path of the Windows program the installer means by `program`
/// (`icacls`, `powershell.exe`, and the service's `reg.exe`), under
/// `system_root`; `None` for any other
/// name, which is then run as given.
pub fn system_program(program: &str, system_root: &str) -> Option<String> {
    match program {
        "icacls" => Some(format!(r"{system_root}\System32\icacls.exe")),
        "powershell.exe" => Some(format!(
            r"{system_root}\System32\WindowsPowerShell\v1.0\powershell.exe"
        )),
        // The trial's mark (plan ЛЦ-2, `license::trial_mark`).
        "reg.exe" => Some(format!(r"{system_root}\System32\reg.exe")),
        _ => None,
    }
}

/// External programs through `std::process::Command`, without a console
/// window on Windows (the installer is a window of its own). On Windows the
/// installer's own programs run from `%SystemRoot%\System32` by absolute path.
pub struct SystemCommands;

impl Commands for SystemCommands {
    fn run(&mut self, program: &str, args: &[String]) -> Result<CommandOutput, InstallError> {
        #[cfg(windows)]
        let resolved = system_program(
            program,
            &trusted_system_root(std::env::var("SystemRoot").ok().as_deref()),
        )
        .unwrap_or_else(|| program.to_owned());
        #[cfg(not(windows))]
        let resolved = program.to_owned();
        let mut command = std::process::Command::new(resolved);
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
