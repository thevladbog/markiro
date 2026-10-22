//! The harness run against a host in this process: two stations and a
//! handheld in one shift for twenty seconds, and every check of the report
//! must hold. It needs the host of plan 2b (shared shifts), a loopback
//! socket and about a minute, so it is `ignored` in the ordinary gate:
//! `cargo test -p markiro-loadtest --test self_run -- --ignored`.

use markiro_loadtest::profile::{Profile, Thresholds};
use markiro_loadtest::run::{execute, execute_raw, HostChoice, RunOptions};

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "runs a host and twenty seconds of load; run it with --ignored"]
async fn the_tiny_profile_passes_every_check_against_a_host_in_this_process() {
    let profile = Profile::preset("tiny").unwrap();
    let dir = tempfile::tempdir().unwrap();
    let report = execute(RunOptions {
        thresholds: Thresholds::for_profile("tiny").unwrap(),
        profile,
        host: HostChoice::InProcess,
        work_dir: dir.path().to_path_buf(),
    })
    .await
    .unwrap();
    assert!(report.verdict.pass, "{:#?}", report.verdict);
    assert_eq!(report.devices.len(), 3);
    assert!(report.devices.iter().any(|device| device.handheld));
    // The load did what it says: every kind of injection happened, and the
    // host's own numbers say so.
    assert!(
        report.expected.distinct_accepted_codes > 100,
        "{:?}",
        report.expected
    );
    assert!(
        report.expected.conflict_receipts + report.expected.displacements > 0,
        "{:?}",
        report.expected
    );
    assert!(
        report.expected.boxes_closed > 10 && report.expected.pallets_closed > 3,
        "{:?}",
        report.expected
    );
    assert!(
        report
            .devices
            .iter()
            .map(|device| device.resends)
            .sum::<u64>()
            > 0
    );
    assert!(
        report
            .devices
            .iter()
            .map(|device| device.offline_periods)
            .sum::<u64>()
            > 0
    );
    assert_eq!(report.drills.len(), 6);
    assert!(report.backups.len() >= 2, "one under load, one at the end");
    assert!(report.restore.is_some());
    let first = &report.latency["facts"];
    assert!(first.count > 100);
    // The participants' states in the host database agree with the ledger.
    assert!(
        report
            .checks
            .iter()
            .any(|check| check.name == "participant_state_device_0" && check.ok),
        "{:#?}",
        report.checks
    );
    // `execute` hands back a report with the run's secrets already removed.
    let text = serde_json::to_string(&report).unwrap();
    assert!(!text.contains("Load-"), "the administrator password leaked");
}

/// The files a run leaves behind carry none of its secrets: the report is
/// written exactly as the command line writes it and every secret the run
/// made (administrator password, pairing codes, device keys, session token)
/// is looked for in both files.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "runs a host and ten seconds of load; run it with --ignored"]
async fn the_written_files_carry_none_of_the_runs_secrets() {
    let mut profile = Profile::preset("tiny").unwrap();
    profile.set("durationS", "10").unwrap();
    let dir = tempfile::tempdir().unwrap();
    let (mut raw, secrets) = execute_raw(RunOptions {
        thresholds: Thresholds::for_profile("tiny").unwrap(),
        profile,
        host: HostChoice::InProcess,
        work_dir: dir.path().to_path_buf(),
    })
    .await
    .unwrap();
    // The run really made secrets: a password, three device keys, a token.
    assert!(secrets.len() >= 5, "{}", secrets.len());
    assert!(secrets.iter().any(|secret| secret.starts_with("Load-")));
    // A clean run leaks nothing by itself, so plant every real secret of this run
    // where a host's log line or an error text would carry one: the scan below
    // then proves the writer removes them (it fails when redaction is skipped).
    raw.log.first_errors = secrets
        .iter()
        .map(|secret| format!("ERROR the host logged {secret}"))
        .collect();
    let out = dir.path().join("out");
    std::fs::create_dir_all(&out).unwrap();
    let (json, markdown) = markiro_loadtest::cli::write_reports(&raw, &out, &secrets).unwrap();
    for path in [json, markdown] {
        let text = std::fs::read_to_string(&path).unwrap();
        for secret in &secrets {
            assert!(
                !text.contains(secret.as_str()),
                "a secret of {} characters is in {}",
                secret.len(),
                path.display()
            );
        }
    }
    // The host's own data folder is not a report file and is not scanned; it
    // stays in the temp folder, which is removed with it.
}
