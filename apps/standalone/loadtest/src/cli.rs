//! The command line: `run` (one run, a report folder), `compare` (two
//! reports, exit 1 on a regression) and `summary` (a report as Markdown).

use std::path::{Path, PathBuf};

use crate::profile::{Profile, Thresholds};
use crate::report::{compare, redact, render_markdown, Report};
use crate::run::{execute_raw, HostChoice, RunOptions};
use crate::site::AttachCredentials;

pub const USAGE: &str = "usage:
  markiro-loadtest run --profile tiny|smoke|soak [--set field=value]... [--out DIR] [--keep-data]
        [--host spawn|in-process|attach] [--host-bin PATH] [--accept-network-exposure]
        [--attach-url URL --fingerprint HEX [--data-dir DIR] [--pid N]]
  markiro-loadtest compare OLD.json NEW.json
  markiro-loadtest summary REPORT.json

--set scenarios=all|none|NAME,NAME picks the multi-station scenarios run after the main run,
each on a fresh host (default: all for tiny and smoke, none for soak).
Attach reads MARKIRO_LOAD_OFFICE_DEVICE_KEY, MARKIRO_LOAD_ADMIN_LOGIN and
MARKIRO_LOAD_ADMIN_PASSWORD from the environment, never from the command line.
The default host is `spawn`: the markiro-host binary next to this one, or --host-bin.
The host has no bind option: a spawned one listens on 0.0.0.0 (every interface) for the
run's length, so `spawn` needs --accept-network-exposure. `in-process` listens on
127.0.0.1 only and needs nothing. Exit codes: 0 pass, 1 failed verdict or regression,
2 a run that could not be made or a bad line.";

/// Said before a spawned host starts, and the reason it needs the flag.
pub fn exposure_warning() -> String {
    "a spawned markiro-host listens on 0.0.0.0 (every network interface), not only on this \
     computer, for the whole run; its administrator password and device keys are throwaway \
     but the port is reachable from the network. Use --host in-process (127.0.0.1 only), or \
     add --accept-network-exposure to run it anyway on a trusted network"
        .to_owned()
}

#[derive(Debug, PartialEq)]
pub enum Command {
    Run(RunArgs),
    Compare { old: PathBuf, new: PathBuf },
    Summary { report: PathBuf },
}

#[derive(Debug, PartialEq)]
pub struct RunArgs {
    pub profile: Profile,
    pub out: Option<PathBuf>,
    pub keep_data: bool,
    pub host: HostArg,
    /// Agreed to a spawned host listening on every interface.
    pub accept_network_exposure: bool,
}

#[derive(Debug, PartialEq)]
pub enum HostArg {
    Spawn {
        bin: Option<PathBuf>,
    },
    InProcess,
    Attach {
        url: String,
        fingerprint: String,
        data_dir: Option<PathBuf>,
        pid: Option<u32>,
    },
}

pub fn parse(args: &[String]) -> Result<Command, String> {
    let (command, rest) = args.split_first().ok_or_else(|| USAGE.to_owned())?;
    match command.as_str() {
        "compare" => match rest {
            [old, new] => Ok(Command::Compare {
                old: old.into(),
                new: new.into(),
            }),
            _ => Err(USAGE.to_owned()),
        },
        "summary" => match rest {
            [report] => Ok(Command::Summary {
                report: report.into(),
            }),
            _ => Err(USAGE.to_owned()),
        },
        "run" => parse_run(rest).map(Command::Run),
        _ => Err(USAGE.to_owned()),
    }
}

fn parse_run(args: &[String]) -> Result<RunArgs, String> {
    let (mut name, mut sets, mut out, mut keep_data) = (None, Vec::new(), None, false);
    let mut accept_network_exposure = false;
    let (mut host, mut host_bin, mut url, mut fingerprint, mut data_dir, mut pid) =
        (None, None, None, None, None, None);
    let mut index = 0;
    while index < args.len() {
        let flag = args[index].as_str();
        if flag == "--keep-data" {
            keep_data = true;
            index += 1;
            continue;
        }
        if flag == "--accept-network-exposure" {
            accept_network_exposure = true;
            index += 1;
            continue;
        }
        let value = args
            .get(index + 1)
            .ok_or_else(|| format!("{flag} needs a value\n{USAGE}"))?;
        match flag {
            "--profile" => name = Some(value.clone()),
            "--set" => sets.push(value.clone()),
            "--out" => out = Some(PathBuf::from(value)),
            "--host" => host = Some(value.clone()),
            "--host-bin" => host_bin = Some(PathBuf::from(value)),
            "--attach-url" => url = Some(value.clone()),
            "--fingerprint" => fingerprint = Some(value.clone()),
            "--data-dir" => data_dir = Some(PathBuf::from(value)),
            "--pid" => {
                pid = Some(
                    value
                        .parse::<u32>()
                        .map_err(|_| "--pid is a process id".to_owned())?,
                )
            }
            other => return Err(format!("unknown argument {other}\n{USAGE}")),
        }
        index += 2;
    }
    let mut profile =
        Profile::preset(&name.ok_or_else(|| format!("--profile is required\n{USAGE}"))?)?;
    for set in sets {
        let (key, value) = set
            .split_once('=')
            .ok_or_else(|| format!("--set {set}: field=value"))?;
        profile.set(key, value)?;
    }
    let host = match host.as_deref().unwrap_or("spawn") {
        "spawn" => HostArg::Spawn { bin: host_bin },
        "in-process" => HostArg::InProcess,
        "attach" => HostArg::Attach {
            url: url.ok_or("--attach-url is required to attach")?,
            fingerprint: fingerprint.ok_or("--fingerprint is required to attach")?,
            data_dir,
            pid,
        },
        other => return Err(format!("--host {other}: spawn, in-process or attach")),
    };
    Ok(RunArgs {
        profile,
        out,
        keep_data,
        host,
        accept_network_exposure,
    })
}

/// Whether `path` is inside a git checkout: reports belong outside the repository.
pub fn inside_checkout(path: &Path) -> bool {
    path.ancestors().any(|dir| dir.join(".git").exists())
}

fn default_out() -> PathBuf {
    if let Some(out) = std::env::var_os("MARKIRO_LOAD_OUT") {
        return PathBuf::from(out);
    }
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .unwrap_or_else(|| ".".into());
    PathBuf::from(home).join("markiro-load")
}

fn host_binary(given: Option<PathBuf>) -> Result<PathBuf, String> {
    if let Some(bin) = given {
        return Ok(bin);
    }
    let me = std::env::current_exe().map_err(|error| error.to_string())?;
    let name = if cfg!(windows) {
        "markiro-host.exe"
    } else {
        "markiro-host"
    };
    let sibling = me.with_file_name(name);
    sibling.exists().then_some(sibling).ok_or_else(|| {
        "no markiro-host next to this binary: build both (cargo build --release -p markiro-host -p markiro-loadtest) or give --host-bin".to_owned()
    })
}

fn env(name: &str) -> Result<String, String> {
    std::env::var(name).map_err(|_| format!("{name} is not set"))
}

fn folder_name(profile: &str) -> String {
    let now = time::OffsetDateTime::now_utc();
    format!(
        "{profile}-{:04}{:02}{:02}-{:02}{:02}{:02}",
        now.year(),
        u8::from(now.month()),
        now.day(),
        now.hour(),
        now.minute(),
        now.second()
    )
}

/// The exit code of an outcome: 0 a pass, 1 a failed verdict or a regression,
/// 2 a run that could not be made.
pub fn exit_code(outcome: &Result<bool, String>) -> u8 {
    match outcome {
        Ok(true) => 0,
        Ok(false) => 1,
        Err(_) => 2,
    }
}

/// Write `report.json` and `report.md` into `dir`, every secret removed from
/// both first. Returns the two paths.
pub fn write_reports(
    report: &Report,
    dir: &Path,
    secrets: &[String],
) -> Result<(PathBuf, PathBuf), String> {
    let report = redact(report, secrets);
    let json = serde_json::to_string_pretty(&report).map_err(|error| error.to_string())?;
    let (json_path, md_path) = (dir.join("report.json"), dir.join("report.md"));
    std::fs::write(&json_path, json)
        .map_err(|error| format!("{}: {error}", json_path.display()))?;
    std::fs::write(&md_path, render_markdown(&report))
        .map_err(|error| format!("{}: {error}", md_path.display()))?;
    Ok((json_path, md_path))
}

/// Run, write the report and say how it went: `true` for a pass.
pub async fn run(args: RunArgs) -> Result<bool, String> {
    // The host choice is judged before anything is made or started.
    if matches!(args.host, HostArg::Spawn { .. }) {
        if !args.accept_network_exposure {
            return Err(format!("refused: {}", exposure_warning()));
        }
        eprintln!("warning: {}", exposure_warning());
    }
    let out = args.out.unwrap_or_else(default_out);
    if inside_checkout(&out) {
        return Err(format!(
            "{}: a report folder inside a git checkout; give --out outside it",
            out.display()
        ));
    }
    let work_dir = out.join(folder_name(&args.profile.name));
    let host = match args.host {
        HostArg::Spawn { bin } => HostChoice::Spawn {
            bin: host_binary(bin)?,
        },
        HostArg::InProcess => HostChoice::InProcess,
        HostArg::Attach {
            url,
            fingerprint,
            data_dir,
            pid,
        } => {
            eprintln!(
                "note: attaching makes a throwaway site (a line, a product, shifts) in {url}"
            );
            HostChoice::Attach {
                base: url,
                fingerprint,
                data_dir,
                pid,
                credentials: AttachCredentials {
                    office_device_key: env("MARKIRO_LOAD_OFFICE_DEVICE_KEY")?,
                    login: env("MARKIRO_LOAD_ADMIN_LOGIN")?,
                    password: env("MARKIRO_LOAD_ADMIN_PASSWORD")?,
                },
            }
        }
    };
    let thresholds = Thresholds::for_profile(&args.profile.name)?;
    let (report, secrets) = execute_raw(RunOptions {
        profile: args.profile,
        thresholds,
        host,
        work_dir: work_dir.clone(),
    })
    .await?;
    let (json_path, md_path) = write_reports(&report, &work_dir, &secrets)?;
    let summary = std::fs::read_to_string(&md_path).map_err(|error| error.to_string())?;
    println!("{summary}\nreport: {}", json_path.display());
    if report.verdict.pass && !args.keep_data {
        // The data of a passing run is a copy of a throwaway site: of no use and large.
        let _ = std::fs::remove_dir_all(work_dir.join("data"));
        let _ = std::fs::remove_dir_all(work_dir.join("restored"));
        let _ = std::fs::remove_dir_all(work_dir.join("scenarios"));
    }
    Ok(report.verdict.pass)
}

/// A report file this harness can read: its schema is checked first, so a report of a newer
/// harness is refused by name rather than by its first unknown field.
fn read_report(path: &Path) -> Result<Report, String> {
    let text =
        std::fs::read_to_string(path).map_err(|error| format!("{}: {error}", path.display()))?;
    let value: serde_json::Value =
        serde_json::from_str(&text).map_err(|error| format!("{}: {error}", path.display()))?;
    match value.get("schema").and_then(serde_json::Value::as_u64) {
        None => {
            return Err(format!(
                "{}: not a load-test report (no schema number)",
                path.display()
            ))
        }
        Some(schema) if schema > u64::from(crate::report::SCHEMA) => {
            return Err(format!(
                "{}: unsupported report schema {schema}: this markiro-loadtest reads schema {} and \
                 older; use the harness that wrote it",
                path.display(),
                crate::report::SCHEMA
            ))
        }
        Some(_) => {}
    }
    serde_json::from_value(value).map_err(|error| format!("{}: {error}", path.display()))
}

/// The regressions of `new` against `old`, one to a line; empty text: none.
pub fn compare_files(old: &Path, new: &Path) -> Result<Vec<String>, String> {
    Ok(compare(&read_report(old)?, &read_report(new)?)
        .into_iter()
        .map(|regression| regression.0)
        .collect())
}

pub fn summary_of(path: &Path) -> Result<String, String> {
    Ok(render_markdown(&read_report(path)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(text: &str) -> Vec<String> {
        text.split_whitespace().map(str::to_owned).collect()
    }

    #[test]
    fn a_run_takes_a_profile_overrides_and_a_host() {
        let parsed = parse(&args(
            "run --profile smoke --set scanRate=7 --set durationS=60 --out /tmp/x --keep-data",
        ))
        .unwrap();
        let Command::Run(run) = parsed else {
            panic!("a run")
        };
        assert_eq!((run.profile.scan_rate, run.profile.duration_s), (7.0, 60));
        assert_eq!(run.out, Some(PathBuf::from("/tmp/x")));
        assert!(run.keep_data);
        assert_eq!(run.host, HostArg::Spawn { bin: None });
        let Command::Run(run) = parse(&args("run --profile tiny --host in-process")).unwrap()
        else {
            panic!()
        };
        assert_eq!(run.host, HostArg::InProcess);
    }

    #[test]
    fn attach_needs_its_address_and_fingerprint() {
        assert!(parse(&args("run --profile tiny --host attach")).is_err());
        let ok = parse(&args("run --profile tiny --host attach --attach-url https://10.0.0.5:45710 --fingerprint ab --pid 7")).unwrap();
        let Command::Run(run) = ok else { panic!() };
        assert_eq!(
            run.host,
            HostArg::Attach {
                url: "https://10.0.0.5:45710".into(),
                fingerprint: "ab".into(),
                data_dir: None,
                pid: Some(7)
            }
        );
    }

    #[test]
    fn bad_lines_are_refused_with_the_usage() {
        for line in [
            "",
            "run",
            "run --profile huge",
            "run --profile smoke --set nonsense=1",
            "run --profile smoke --set noequals",
            "compare a",
            "frob",
        ] {
            assert!(parse(&args(line)).is_err(), "{line}");
        }
        assert!(matches!(
            parse(&args("compare a.json b.json")),
            Ok(Command::Compare { .. })
        ));
        assert!(matches!(
            parse(&args("summary r.json")),
            Ok(Command::Summary { .. })
        ));
    }

    #[test]
    fn a_folder_inside_a_checkout_is_refused_and_one_outside_is_not() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!inside_checkout(dir.path()));
        std::fs::create_dir(dir.path().join(".git")).unwrap();
        assert!(inside_checkout(&dir.path().join("reports")));
    }

    #[test]
    fn two_report_files_are_compared_and_a_summary_is_read() {
        let dir = tempfile::tempdir().unwrap();
        let mut old = crate::report::sample_passing();
        old.verdict.pass = true;
        let mut new = old.clone();
        new.throughput.scans_per_s = 1.0;
        let (old_path, new_path) = (dir.path().join("old.json"), dir.path().join("new.json"));
        std::fs::write(&old_path, serde_json::to_string(&old).unwrap()).unwrap();
        std::fs::write(&new_path, serde_json::to_string(&new).unwrap()).unwrap();
        assert!(compare_files(&old_path, &old_path).unwrap().is_empty());
        let found = compare_files(&old_path, &new_path).unwrap();
        assert!(
            found.iter().any(|line| line.contains("scans per second")),
            "{found:?}"
        );
        assert!(summary_of(&new_path)
            .unwrap()
            .starts_with("# Load run `smoke`"));
        assert!(compare_files(&old_path, &dir.path().join("none.json")).is_err());
    }

    #[test]
    fn a_report_of_a_newer_schema_is_refused_by_name() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("newer.json");
        let mut value = serde_json::to_value(crate::report::sample_passing()).unwrap();
        value["schema"] = serde_json::json!(crate::report::SCHEMA + 1);
        value["fieldOfTheFuture"] = serde_json::json!(1);
        std::fs::write(&path, value.to_string()).unwrap();
        let error = summary_of(&path).unwrap_err();
        assert!(error.contains("unsupported report schema"), "{error}");
        assert!(
            error.contains(&format!("schema {}", crate::report::SCHEMA + 1)),
            "{error}"
        );
        // Not a report at all: said so, not a field-by-field complaint.
        std::fs::write(&path, "{\"hello\": 1}").unwrap();
        let error = summary_of(&path).unwrap_err();
        assert!(error.contains("not a load-test report"), "{error}");
    }

    // --- added: network exposure, redaction of the written files, exit codes ---

    #[test]
    fn the_exposure_flag_is_parsed_and_off_by_default() {
        let Command::Run(run) = parse(&args("run --profile tiny")).unwrap() else {
            panic!()
        };
        assert!(!run.accept_network_exposure);
        let Command::Run(run) =
            parse(&args("run --profile tiny --accept-network-exposure")).unwrap()
        else {
            panic!()
        };
        assert!(run.accept_network_exposure);
    }

    fn run_args(host: HostArg, accept: bool, out: &Path) -> RunArgs {
        RunArgs {
            profile: Profile::preset("tiny").unwrap(),
            out: Some(out.to_path_buf()),
            keep_data: false,
            host,
            accept_network_exposure: accept,
        }
    }

    #[tokio::test]
    async fn a_spawned_host_listens_on_every_interface_and_is_refused_without_the_flag() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("no-such-host");
        let refused = run(run_args(
            HostArg::Spawn {
                bin: Some(bin.clone()),
            },
            false,
            dir.path(),
        ))
        .await
        .unwrap_err();
        assert!(refused.contains("0.0.0.0"), "{refused}");
        assert!(refused.contains("--accept-network-exposure"), "{refused}");
        assert!(refused.contains("in-process"), "{refused}");
        // nothing was made in the results folder
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
        // with the flag it gets as far as the host binary, which does not exist
        let next = run(run_args(
            HostArg::Spawn { bin: Some(bin) },
            true,
            dir.path(),
        ))
        .await;
        assert!(next.is_err());
        assert!(!next.unwrap_err().contains("0.0.0.0"));
    }

    #[test]
    fn the_exposure_warning_names_the_address_and_the_alternative() {
        let text = exposure_warning();
        assert!(
            text.contains("0.0.0.0") && text.contains("in-process"),
            "{text}"
        );
    }

    #[test]
    fn written_reports_carry_none_of_the_secrets() {
        let dir = tempfile::tempdir().unwrap();
        let secrets = ["Load-0123456789abcdef-pw", "KEY-deadbeefcafe", "123456"];
        let mut report = crate::report::sample_passing();
        report.log.first_errors = vec![format!("ERROR login {} failed", secrets[0])];
        report.checks.push(crate::checks::Check::new(
            "leak",
            false,
            format!("key {}", secrets[1]),
        ));
        report
            .errors
            .insert(format!("pairing code {}", secrets[2]), 3);
        report
            .verdict
            .failures
            .push(format!("detail {}", secrets[1]));
        let secrets: Vec<String> = secrets.iter().map(|s| (*s).to_owned()).collect();
        let (json, markdown) = write_reports(&report, dir.path(), &secrets).unwrap();
        for path in [json, markdown] {
            let text = std::fs::read_to_string(&path).unwrap();
            // The messages name no secret: a failing assertion's text is a log of its own.
            for secret in &secrets {
                assert!(
                    !text.contains(secret.as_str()),
                    "a planted secret is in {}",
                    path.display()
                );
            }
            assert!(text.contains("[redacted]"), "{}", path.display());
        }
        // and the unredacted report really did carry them (the test can fail)
        let raw = serde_json::to_string(&report).unwrap();
        assert!(secrets.iter().all(|secret| raw.contains(secret.as_str())));
    }

    #[test]
    fn the_exit_code_follows_the_verdict() {
        assert_eq!(exit_code(&Ok(true)), 0);
        assert_eq!(exit_code(&Ok(false)), 1);
        assert_eq!(exit_code(&Err("no".to_owned())), 2);
    }
}
