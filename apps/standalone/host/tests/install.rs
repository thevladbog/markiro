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
use markiro_host::install::{
    self, encode_command, firewall_close_script, firewall_open_script, icacls_args, service_spec,
    CommandOutput, Commands, InstallError, ServiceSpec, ServiceState, Services, POLL_EVERY,
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
        commands.runs[0],
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
    assert_eq!(commands.runs[1].0, "powershell.exe");
    assert_eq!(script_of(&commands.runs[1].1), firewall_open_script(45710));
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
            account: r"NT AUTHORITY\LocalService",
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
            "state",
            "configure",
            "run powershell.exe",
            "state",
            "delete",
            "run powershell.exe",
        ]
    );
    assert_eq!(script_of(&commands.runs[2].1), firewall_close_script());
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
        ["run icacls", "state", "configure", "run powershell.exe"]
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
    assert_eq!(log.borrow()[4..], ["state", "delete", "run powershell.exe"]);
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
