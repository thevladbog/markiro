//! `markiro-host install`, `uninstall` and `stop-service` against fakes of
//! the service manager and of external programs: the order of the steps,
//! the exact command lines, the waits and their limits. The Windows side of
//! the seams (`install_windows.rs`) runs only in `standalone-windows-build`.

use std::cell::RefCell;
use std::collections::VecDeque;
use std::path::Path;
use std::rc::Rc;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use markiro_host::config::{HostConfig, HostPaths};
use markiro_host::install::{
    self, delete_refusal_is_harmless, encode_command, firewall_close_script, firewall_open_script,
    icacls_args, service_error_text, service_spec, start_refusal_is_harmless,
    stop_refusal_is_harmless, system_program, trusted_system_root, CommandOutput, Commands,
    InstallError, ServiceSpec, ServiceState, Services, POLL_EVERY,
};

type Log = Rc<RefCell<Vec<String>>>;

/// The service manager: `state` answers from `states` in order, the last
/// one repeating; every call is logged.
struct FakeServices {
    log: Log,
    states: VecDeque<Option<ServiceState>>,
    configured: Vec<ServiceSpec>,
    /// Calls (`configure`, `start`, `stop`, `delete`) the service manager refuses.
    refuses: Vec<&'static str>,
}

impl FakeServices {
    fn new(log: &Log, states: &[Option<ServiceState>]) -> Self {
        Self {
            log: log.clone(),
            states: states.iter().copied().collect(),
            configured: Vec::new(),
            refuses: Vec::new(),
        }
    }

    fn refusing(mut self, call: &'static str) -> Self {
        self.refuses.push(call);
        self
    }

    fn call(&mut self, name: &'static str) -> Result<(), InstallError> {
        self.log.borrow_mut().push(name.into());
        if self.refuses.contains(&name) {
            Err(InstallError::Service(format!("{name} refused")))
        } else {
            Ok(())
        }
    }
}

impl Services for FakeServices {
    fn state(&mut self) -> Result<Option<ServiceState>, InstallError> {
        self.log.borrow_mut().push("state".into());
        let state = if self.states.len() > 1 {
            self.states.pop_front().expect("a scripted state")
        } else {
            *self.states.front().expect("a scripted state")
        };
        Ok(state)
    }

    fn configure(&mut self, spec: &ServiceSpec) -> Result<(), InstallError> {
        self.configured.push(spec.clone());
        self.call("configure")
    }

    fn start(&mut self) -> Result<(), InstallError> {
        self.call("start")
    }

    fn stop(&mut self) -> Result<(), InstallError> {
        self.call("stop")
    }

    fn delete(&mut self) -> Result<(), InstallError> {
        self.call("delete")
    }
}

/// External programs: each run is logged as `run <program>` and its
/// arguments kept; `codes` answers per program (0 when not named), and
/// `stdout` answers in order.
struct FakeCommands {
    log: Log,
    runs: Vec<(String, Vec<String>)>,
    codes: Vec<(&'static str, i32)>,
    stdout: VecDeque<Vec<u8>>,
}

impl FakeCommands {
    fn new(log: &Log) -> Self {
        Self {
            log: log.clone(),
            runs: Vec::new(),
            codes: Vec::new(),
            stdout: VecDeque::new(),
        }
    }
}

impl Commands for FakeCommands {
    fn run(&mut self, program: &str, args: &[String]) -> Result<CommandOutput, InstallError> {
        self.log.borrow_mut().push(format!("run {program}"));
        self.runs.push((program.to_owned(), args.to_vec()));
        let code = self
            .codes
            .iter()
            .find(|(name, _)| *name == program)
            .map_or(0, |(_, code)| *code);
        Ok(CommandOutput {
            code: Some(code),
            stdout: self.stdout.pop_front().unwrap_or_default(),
        })
    }
}

/// The script inside `powershell.exe … -EncodedCommand <base64>`.
fn script_of(args: &[String]) -> String {
    assert_eq!(
        args[..5],
        [
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-EncodedCommand"
        ]
    );
    assert_eq!(args.len(), 6);
    let bytes = STANDARD.decode(&args[5]).expect("base64");
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect();
    String::from_utf16(&units).expect("UTF-16LE")
}

const DATA_DIR: &str = r"C:\ProgramData\Markiro\Host";
const EXE: &str = r"C:\Program Files\Markiro Standalone\markiro-host.exe";

/// The waits' sleeps, counted.
fn counting_sleep(count: &Rc<RefCell<Vec<Duration>>>) -> impl FnMut(Duration) {
    let count = count.clone();
    move |delay| count.borrow_mut().push(delay)
}

#[test]
fn install_hardens_the_data_dir_registers_the_service_opens_the_port_and_waits_until_it_runs() {
    let log = Log::default();
    let mut services = FakeServices::new(
        &log,
        &[
            None,
            Some(ServiceState::StartPending),
            Some(ServiceState::StartPending),
            Some(ServiceState::Running),
        ],
    );
    let mut commands = FakeCommands::new(&log);
    let sleeps = Rc::new(RefCell::new(Vec::new()));
    install::install(
        Path::new(DATA_DIR),
        Path::new(EXE),
        45710,
        &mut services,
        &mut commands,
        &mut counting_sleep(&sleeps),
    )
    .unwrap();

    assert_eq!(
        *log.borrow(),
        [
            "run icacls",
            "run icacls",
            "run icacls",
            "state",
            "configure",
            "run powershell.exe",
            "start",
            "state",
            "state",
            "state",
        ]
    );
    assert_eq!(*sleeps.borrow(), [POLL_EVERY, POLL_EVERY]);
    assert_eq!(services.configured, [service_spec(Path::new(EXE))]);
    assert_eq!(
        commands.runs[2],
        (
            "icacls".to_owned(),
            vec![
                DATA_DIR.to_owned(),
                "/inheritance:r".to_owned(),
                "/grant:r".to_owned(),
                "*S-1-5-18:(OI)(CI)F".to_owned(),
                "*S-1-5-32-544:(OI)(CI)F".to_owned(),
                "*S-1-5-19:(OI)(CI)M".to_owned(),
            ]
        )
    );
    assert_eq!(commands.runs[3].0, "powershell.exe");
    assert_eq!(script_of(&commands.runs[3].1), firewall_open_script(45710));
}

/// A user may make `%ProgramData%\Markiro\Host` (or a file in it) before the
/// install: that user would stay its owner and could grant themselves the
/// database again. Administrators own the folder, everything in it and its
/// Markiro folder before the access list is set.
#[test]
fn install_makes_administrators_the_owner_of_the_data_dir_and_its_parent_before_the_access_list() {
    let log = Log::default();
    let mut services = FakeServices::new(&log, &[None, Some(ServiceState::Running)]);
    let mut commands = FakeCommands::new(&log);
    install::install(
        Path::new(DATA_DIR),
        Path::new(EXE),
        45710,
        &mut services,
        &mut commands,
        &mut |_| (),
    )
    .unwrap();
    let icacls: Vec<&Vec<String>> = commands
        .runs
        .iter()
        .filter(|(program, _)| program == "icacls")
        .map(|(_, args)| args)
        .collect();
    assert_eq!(
        icacls,
        [
            &vec![
                r"C:\ProgramData\Markiro".to_owned(),
                "/setowner".to_owned(),
                "*S-1-5-32-544".to_owned(),
            ],
            &vec![
                DATA_DIR.to_owned(),
                "/setowner".to_owned(),
                "*S-1-5-32-544".to_owned(),
                "/T".to_owned(),
                "/C".to_owned(),
            ],
            &icacls_args(Path::new(DATA_DIR)),
        ]
    );
    assert_eq!(
        log.borrow()[..4],
        ["run icacls", "run icacls", "run icacls", "state"]
    );
}

#[test]
fn the_service_runs_as_local_service_at_boot_and_restarts_after_any_failure() {
    let spec = service_spec(Path::new(EXE));
    assert_eq!(
        spec,
        ServiceSpec {
            name: "MarkiroHost",
            display_name: "Markiro Хост",
            description: "Главная база Markiro Автоном: станции и офис площадки подключаются к ней по HTTPS, порт 45710.",
            executable: EXE.into(),
            arguments: vec!["service".to_owned()],
            account: Some(r"NT AUTHORITY\LocalService"),
            automatic: true,
            restart_delays: [
                Duration::from_secs(5),
                Duration::from_secs(30),
                Duration::from_secs(60),
            ],
            reset_after: Duration::from_secs(86_400),
            failure_actions_on_non_crash: true,
        }
    );
}

#[test]
fn install_over_a_running_service_stops_it_first_and_starts_it_again() {
    let log = Log::default();
    let mut services = FakeServices::new(
        &log,
        &[
            Some(ServiceState::Running),
            Some(ServiceState::StopPending),
            Some(ServiceState::Stopped),
            Some(ServiceState::Running),
        ],
    );
    let mut commands = FakeCommands::new(&log);
    let sleeps = Rc::new(RefCell::new(Vec::new()));
    install::install(
        Path::new(DATA_DIR),
        Path::new(EXE),
        45710,
        &mut services,
        &mut commands,
        &mut counting_sleep(&sleeps),
    )
    .unwrap();
    assert_eq!(
        *log.borrow(),
        [
            "run icacls",
            "run icacls",
            "run icacls",
            "state",
            "stop",
            "state",
            "state",
            "configure",
            "run powershell.exe",
            "start",
            "state",
        ]
    );
    assert_eq!(sleeps.borrow().len(), 1);
    // An upgrade (by reinstall, the only one) keeps the account IT gave the
    // service, e.g. one that can write to a share; a fresh install sets
    // LocalService.
    assert_eq!(
        services.configured,
        [ServiceSpec {
            account: None,
            ..service_spec(Path::new(EXE))
        }]
    );
}

#[test]
fn a_refused_access_list_registers_nothing() {
    let log = Log::default();
    let mut services = FakeServices::new(&log, &[None]);
    let mut commands = FakeCommands::new(&log);
    commands.codes.push(("icacls", 5));
    let result = install::install(
        Path::new(DATA_DIR),
        Path::new(EXE),
        45710,
        &mut services,
        &mut commands,
        &mut |_| panic!("nothing waits"),
    );
    assert_eq!(
        result,
        Err(InstallError::Command {
            program: "icacls".into(),
            code: Some(5)
        })
    );
    assert_eq!(*log.borrow(), ["run icacls"]);
}

#[test]
fn a_service_that_stops_right_after_its_start_fails_the_install() {
    let log = Log::default();
    let mut services = FakeServices::new(
        &log,
        &[
            None,
            Some(ServiceState::StartPending),
            Some(ServiceState::Stopped),
        ],
    );
    let mut commands = FakeCommands::new(&log);
    let sleeps = Rc::new(RefCell::new(Vec::new()));
    let result = install::install(
        Path::new(DATA_DIR),
        Path::new(EXE),
        45710,
        &mut services,
        &mut commands,
        &mut counting_sleep(&sleeps),
    );
    assert_eq!(result, Err(InstallError::StoppedAfterStart));
}

#[test]
fn a_service_that_never_runs_fails_after_the_wait_limit_instead_of_hanging() {
    let log = Log::default();
    let mut services = FakeServices::new(&log, &[None, Some(ServiceState::StartPending)]);
    let mut commands = FakeCommands::new(&log);
    let sleeps = Rc::new(RefCell::new(Vec::new()));
    let result = install::install(
        Path::new(DATA_DIR),
        Path::new(EXE),
        45710,
        &mut services,
        &mut commands,
        &mut counting_sleep(&sleeps),
    );
    assert_eq!(
        result,
        Err(InstallError::Timeout {
            waiting_for: ServiceState::Running
        })
    );
    // 30 s in steps of 0.5 s: sixty reads, a sleep after each.
    assert_eq!(sleeps.borrow().len(), 60);
}

#[test]
fn uninstall_stops_and_removes_the_service_and_the_rule_and_never_touches_the_data() {
    let log = Log::default();
    let mut services = FakeServices::new(
        &log,
        &[Some(ServiceState::Running), Some(ServiceState::Stopped)],
    );
    let mut commands = FakeCommands::new(&log);
    let sleeps = Rc::new(RefCell::new(Vec::new()));
    install::uninstall(&mut services, &mut commands, &mut counting_sleep(&sleeps)).unwrap();
    assert_eq!(
        *log.borrow(),
        ["state", "stop", "state", "delete", "run powershell.exe"]
    );
    assert_eq!(script_of(&commands.runs[0].1), firewall_close_script());
    assert!(commands.runs.iter().all(|(program, _)| program != "icacls"));
}

#[test]
fn uninstall_without_a_service_still_removes_the_rule() {
    let log = Log::default();
    let mut services = FakeServices::new(&log, &[None]);
    let mut commands = FakeCommands::new(&log);
    install::uninstall(&mut services, &mut commands, &mut |_| {
        panic!("nothing waits")
    })
    .unwrap();
    assert_eq!(*log.borrow(), ["state", "run powershell.exe"]);
}

#[test]
fn stop_answers_whether_there_was_a_service_and_waits_for_it_to_stop() {
    let log = Log::default();
    let mut missing = FakeServices::new(&log, &[None]);
    assert_eq!(install::stop(&mut missing, &mut |_| ()), Ok(false));
    let mut stopped = FakeServices::new(&log, &[Some(ServiceState::Stopped)]);
    assert_eq!(install::stop(&mut stopped, &mut |_| ()), Ok(true));
    assert_eq!(
        *log.borrow(),
        ["state", "state"],
        "nothing was asked to stop"
    );

    let mut stuck = FakeServices::new(&log, &[Some(ServiceState::StopPending)]);
    let sleeps = Rc::new(RefCell::new(Vec::new()));
    assert_eq!(
        install::stop(&mut stuck, &mut counting_sleep(&sleeps)),
        Err(InstallError::Timeout {
            waiting_for: ServiceState::Stopped
        })
    );
    assert_eq!(sleeps.borrow().len(), 60);
}

#[test]
fn the_firewall_rule_opens_the_port_on_private_and_domain_networks_from_the_local_subnet_only() {
    assert_eq!(
        firewall_open_script(45710),
        "$ErrorActionPreference = 'Stop'; \
Remove-NetFirewallRule -Name 'MarkiroHost' -ErrorAction SilentlyContinue; \
New-NetFirewallRule -Name 'MarkiroHost' -DisplayName 'Markiro Хост (TCP 45710)' \
-Direction Inbound -Action Allow -Protocol TCP -LocalPort 45710 \
-Profile Private,Domain -RemoteAddress LocalSubnet | Out-Null"
    );
    assert_eq!(
        firewall_close_script(),
        "Remove-NetFirewallRule -Name 'MarkiroHost' -ErrorAction SilentlyContinue; exit 0"
    );
}

#[test]
fn an_encoded_command_is_base64_of_utf16le() {
    // `powershell -EncodedCommand ZABpAHIA` runs `dir` (Microsoft's own example).
    assert_eq!(encode_command("dir"), "ZABpAHIA");
    assert_eq!(
        icacls_args(Path::new(DATA_DIR))[..3],
        [DATA_DIR, "/inheritance:r", "/grant:r"]
    );
}

// ---------------------------------------------------------------------------
// Beyond the plan's brief: a partial install is taken back, a second install
// converges, nothing is quoted by hand.
// ---------------------------------------------------------------------------

fn run_install(
    services: &mut FakeServices,
    commands: &mut FakeCommands,
    sleeps: &Rc<RefCell<Vec<Duration>>>,
) -> Result<(), InstallError> {
    install::install(
        Path::new(DATA_DIR),
        Path::new(EXE),
        45710,
        services,
        commands,
        &mut counting_sleep(sleeps),
    )
}

fn firewall_refused() -> InstallError {
    InstallError::Command {
        program: "powershell.exe".into(),
        code: Some(1),
    }
}

#[test]
fn a_fresh_install_whose_firewall_rule_fails_takes_the_service_and_the_rule_away_again() {
    let log = Log::default();
    // Nothing installed; after `configure` the service exists, stopped.
    let mut services = FakeServices::new(&log, &[None, Some(ServiceState::Stopped)]);
    let mut commands = FakeCommands::new(&log);
    commands.codes.push(("powershell.exe", 1));
    let sleeps = Rc::new(RefCell::new(Vec::new()));
    assert_eq!(
        run_install(&mut services, &mut commands, &sleeps),
        Err(firewall_refused())
    );
    assert_eq!(
        *log.borrow(),
        [
            "run icacls",
            "run icacls",
            "run icacls",
            "state",
            "configure",
            "run powershell.exe",
            "state",
            "delete",
            "run powershell.exe",
        ]
    );
    assert_eq!(script_of(&commands.runs[4].1), firewall_close_script());
    assert!(sleeps.borrow().is_empty(), "the undo waits for nothing");
}

#[test]
fn a_fresh_install_whose_start_is_refused_is_taken_back_and_a_pending_service_is_stopped_first() {
    let log = Log::default();
    let mut services =
        FakeServices::new(&log, &[None, Some(ServiceState::StartPending)]).refusing("start");
    let mut commands = FakeCommands::new(&log);
    let sleeps = Rc::new(RefCell::new(Vec::new()));
    assert_eq!(
        run_install(&mut services, &mut commands, &sleeps),
        Err(InstallError::Service("start refused".into()))
    );
    assert_eq!(
        *log.borrow(),
        [
            "run icacls",
            "run icacls",
            "run icacls",
            "state",
            "configure",
            "run powershell.exe",
            "start",
            "state",
            "stop",
            "delete",
            "run powershell.exe",
        ]
    );
}

#[test]
fn a_fresh_install_whose_configuration_stops_half_way_removes_what_was_created() {
    let log = Log::default();
    let mut services =
        FakeServices::new(&log, &[None, Some(ServiceState::Stopped)]).refusing("configure");
    let mut commands = FakeCommands::new(&log);
    let sleeps = Rc::new(RefCell::new(Vec::new()));
    assert_eq!(
        run_install(&mut services, &mut commands, &sleeps),
        Err(InstallError::Service("configure refused".into()))
    );
    assert_eq!(
        *log.borrow(),
        [
            "run icacls",
            "run icacls",
            "run icacls",
            "state",
            "configure",
            "state",
            "delete",
            "run powershell.exe",
        ]
    );
}

#[test]
fn an_upgrade_that_fails_leaves_the_installed_service_registered_and_the_rule_alone() {
    let log = Log::default();
    let mut services = FakeServices::new(&log, &[Some(ServiceState::Stopped)]);
    let mut commands = FakeCommands::new(&log);
    commands.codes.push(("powershell.exe", 1));
    let sleeps = Rc::new(RefCell::new(Vec::new()));
    assert_eq!(
        run_install(&mut services, &mut commands, &sleeps),
        Err(firewall_refused())
    );
    // A second run converges; deleting the customer's service would not.
    assert_eq!(
        *log.borrow(),
        [
            "run icacls",
            "run icacls",
            "run icacls",
            "state",
            "configure",
            "run powershell.exe"
        ]
    );
}

#[test]
fn a_failed_undo_never_hides_the_error_that_caused_it() {
    let log = Log::default();
    let mut services =
        FakeServices::new(&log, &[None, Some(ServiceState::Stopped)]).refusing("delete");
    let mut commands = FakeCommands::new(&log);
    commands.codes.push(("powershell.exe", 1));
    let sleeps = Rc::new(RefCell::new(Vec::new()));
    assert_eq!(
        run_install(&mut services, &mut commands, &sleeps),
        Err(firewall_refused())
    );
    // Both undo steps were tried although the first one failed.
    assert_eq!(log.borrow()[6..], ["state", "delete", "run powershell.exe"]);
}

#[test]
fn a_service_that_started_is_never_taken_back_when_the_wait_fails() {
    // A slow start (a big database to migrate) must not lose the service, and
    // a host that refuses to start (an interrupted restore) stays installed
    // with its restart policy so that finishing the restore brings it up.
    for scripted in [
        [None, Some(ServiceState::StartPending)],
        [None, Some(ServiceState::Stopped)],
    ] {
        let log = Log::default();
        let mut services = FakeServices::new(&log, &scripted);
        let mut commands = FakeCommands::new(&log);
        let sleeps = Rc::new(RefCell::new(Vec::new()));
        let result = run_install(&mut services, &mut commands, &sleeps);
        assert!(result.is_err());
        let log = log.borrow();
        assert!(!log.contains(&"delete".to_owned()), "{log:?}");
        assert!(!log.contains(&"stop".to_owned()), "{log:?}");
        assert_eq!(
            log.iter()
                .filter(|call| *call == "run powershell.exe")
                .count(),
            1,
            "the rule stays"
        );
    }
}

#[test]
fn a_second_install_over_a_stopped_service_asks_it_to_stop_nothing_and_ends_the_same() {
    let log = Log::default();
    let mut services = FakeServices::new(
        &log,
        &[Some(ServiceState::Stopped), Some(ServiceState::Running)],
    );
    let mut commands = FakeCommands::new(&log);
    let sleeps = Rc::new(RefCell::new(Vec::new()));
    run_install(&mut services, &mut commands, &sleeps).unwrap();
    assert_eq!(
        *log.borrow(),
        [
            "run icacls",
            "run icacls",
            "run icacls",
            "state",
            "configure",
            "run powershell.exe",
            "start",
            "state",
        ]
    );
    assert_eq!(services.configured, [service_spec(Path::new(EXE))]);
    assert!(sleeps.borrow().is_empty());
}

#[test]
fn a_path_with_spaces_and_cyrillic_is_one_plain_argument_with_no_quotes_of_ours() {
    let path = r"D:\Данные Markiro\Хост";
    let args = icacls_args(Path::new(path));
    assert_eq!(args[0], path);
    assert!(args.iter().all(|arg| !arg.contains('"')), "{args:?}");
    // The service's program and its arguments stay separate, for the service
    // manager's own quoting.
    let spec = service_spec(Path::new(
        r"C:\Program Files\Markiro Автоном\markiro-host.exe",
    ));
    assert_eq!(
        spec.executable,
        Path::new(r"C:\Program Files\Markiro Автоном\markiro-host.exe")
    );
    assert_eq!(spec.arguments, ["service"]);
}

#[test]
fn a_start_that_fails_after_the_wait_points_at_a_restore_that_was_not_finished() {
    let text = InstallError::StoppedAfterStart.to_string();
    assert!(text.contains("markiro-host restore"), "{text}");
    assert!(text.contains("logs"), "{text}");
}

// ---------------------------------------------------------------------------
// Task 2: what the Windows adapter and the `install` subcommand rely on, kept
// in code that runs on every OS (the adapter itself compiles only on Windows).
// ---------------------------------------------------------------------------

#[test]
fn windows_own_programs_are_run_by_their_absolute_path() {
    assert_eq!(
        system_program("icacls", r"C:\Windows"),
        Some(r"C:\Windows\System32\icacls.exe".to_owned())
    );
    assert_eq!(
        system_program("powershell.exe", r"D:\WINNT"),
        Some(r"D:\WINNT\System32\WindowsPowerShell\v1.0\powershell.exe".to_owned())
    );
    // Whatever else is asked for is not ours to resolve.
    assert_eq!(system_program("cmd.exe", r"C:\Windows"), None);
    assert_eq!(system_program("icacls.exe.bak", r"C:\Windows"), None);
}

#[test]
fn only_a_plain_absolute_windows_directory_is_trusted() {
    assert_eq!(trusted_system_root(Some(r"D:\WINDOWS")), r"D:\WINDOWS");
    assert_eq!(trusted_system_root(Some(r"C:\Windows\")), r"C:\Windows");
    assert_eq!(trusted_system_root(Some(r"c:\Win dows")), r"c:\Win dows");
    for untrusted in [
        None,
        Some(""),
        Some("Windows"),
        Some(r"C:Windows"),
        Some(r"1:\Windows"),
        Some(r"\\server\share\Windows"),
        Some(r"C:\Windows\..\Temp"),
        Some(r"C:\..\Windows"),
        Some(r"C:\"),
        Some("C:\\Win\x07dows"),
    ] {
        assert_eq!(
            trusted_system_root(untrusted),
            r"C:\Windows",
            "{untrusted:?}"
        );
    }
    // Every character a path cannot hold, or that joins two paths, on its own.
    for forbidden in ['"', '<', '>', '|', '?', '*', ';', '/'] {
        let root = format!(r"C:\Win{forbidden}dows");
        assert_eq!(trusted_system_root(Some(&root)), r"C:\Windows", "{root}");
    }
    // A name that only contains dots is no parent directory.
    assert_eq!(trusted_system_root(Some(r"C:\Win..dows")), r"C:\Win..dows");
}

#[test]
fn the_service_managers_refusals_are_told_apart_by_their_number() {
    // A stop for a service that is not running, or one that is changing state
    // right now (a service refuses a stop while it is starting).
    assert!(stop_refusal_is_harmless(1062));
    assert!(stop_refusal_is_harmless(1061));
    assert!(!stop_refusal_is_harmless(5));
    assert!(!stop_refusal_is_harmless(1060));
    assert!(start_refusal_is_harmless(1056));
    assert!(!start_refusal_is_harmless(1062));
    assert!(!start_refusal_is_harmless(5));
    assert!(delete_refusal_is_harmless(1072));
    assert!(!delete_refusal_is_harmless(1060));
    assert!(!delete_refusal_is_harmless(5));
}

#[test]
fn a_refusal_a_person_can_act_on_says_what_to_do() {
    let denied = service_error_text("OpenSCManager failed".to_owned(), Some(5));
    assert!(denied.starts_with("OpenSCManager failed"), "{denied}");
    assert!(denied.contains("administrator"), "{denied}");
    let marked = service_error_text("CreateService failed".to_owned(), Some(1072));
    assert!(marked.contains("Services"), "{marked}");
    assert!(marked.contains("restart the computer"), "{marked}");
    assert_eq!(
        service_error_text("something else".to_owned(), Some(2)),
        "something else"
    );
    assert_eq!(
        service_error_text("no number".to_owned(), None),
        "no number"
    );
}

/// A stop the service refuses while it is starting (its status accepts no
/// control until it runs) is sent again until it is accepted.
#[test]
fn a_stop_refused_while_the_service_starts_is_asked_again_until_it_is_accepted() {
    let log = Log::default();
    let mut services = FakeServices::new(
        &log,
        &[
            Some(ServiceState::StartPending),
            Some(ServiceState::StartPending),
            Some(ServiceState::Running),
            Some(ServiceState::StopPending),
            Some(ServiceState::Stopped),
        ],
    );
    let sleeps = Rc::new(RefCell::new(Vec::new()));
    assert_eq!(
        install::stop(&mut services, &mut counting_sleep(&sleeps)),
        Ok(true)
    );
    assert_eq!(
        *log.borrow(),
        [
            "state", "stop", // the first ask: refused quietly while it starts
            "state", "stop", // still starting
            "state", "stop",  // now running: this one is accepted
            "state", // stopping: wait, do not ask again
            "state", // stopped
        ]
    );
    assert_eq!(sleeps.borrow().len(), 3);
}

/// The data directory must exist when `icacls` runs, and the firewall gets the
/// port the host will listen on.
struct IcaclsSeesTheDirectory {
    inner: FakeCommands,
    directory_existed: Vec<bool>,
}

impl Commands for IcaclsSeesTheDirectory {
    fn run(&mut self, program: &str, args: &[String]) -> Result<CommandOutput, InstallError> {
        if program == "icacls" {
            self.directory_existed.push(Path::new(&args[0]).is_dir());
        }
        self.inner.run(program, args)
    }
}

fn install_host_in(
    paths: &HostPaths,
    log: &Log,
) -> (Result<(), markiro_host::BoxError>, IcaclsSeesTheDirectory) {
    let mut services = FakeServices::new(log, &[None, Some(ServiceState::Running)]);
    let mut commands = IcaclsSeesTheDirectory {
        inner: FakeCommands::new(log),
        directory_existed: Vec::new(),
    };
    let result = install::install_host(
        paths,
        Path::new(EXE),
        &mut services,
        &mut commands,
        &mut |_| (),
    );
    (result, commands)
}

#[test]
fn install_creates_the_data_directory_before_icacls_reads_it_and_opens_the_default_port() {
    let root = tempfile::tempdir().unwrap();
    let paths = HostPaths::new(root.path().join("ProgramData").join("Markiro").join("Host"));
    assert!(!paths.data_dir.exists());
    let log = Log::default();
    let (result, commands) = install_host_in(&paths, &log);
    result.unwrap();
    assert_eq!(commands.directory_existed, [true, true, true]);
    assert!(paths.logs_dir().is_dir() && paths.tls_dir().is_dir());
    assert_eq!(
        commands.inner.runs[2].1[0],
        paths.data_dir.display().to_string()
    );
    assert_eq!(
        script_of(&commands.inner.runs[3].1),
        firewall_open_script(45710)
    );
}

#[test]
fn install_opens_the_port_the_host_was_configured_with() {
    let root = tempfile::tempdir().unwrap();
    let paths = HostPaths::new(root.path().join("Host"));
    paths.ensure().unwrap();
    HostConfig::load_or_create(&paths, Some(46123)).unwrap();
    let log = Log::default();
    let (result, commands) = install_host_in(&paths, &log);
    result.unwrap();
    assert_eq!(
        script_of(&commands.inner.runs[2].1),
        firewall_open_script(46123)
    );
}
