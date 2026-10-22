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
    // Every scenario of the profile ran: a judged one held (the verdict says so), a spawn-only
    // one is not judged with a host in this process, and on Windows neither is backup-mid-close.
    assert_eq!(
        report.scenarios.len(),
        markiro_loadtest::profile::SCENARIOS.len()
    );
    for scenario in &report.scenarios {
        let judged = markiro_loadtest::scenarios::judged_in_process(&scenario.name, cfg!(windows));
        assert_eq!(scenario.judged, judged, "{}", scenario.name);
    }
    let capability = report
        .scenarios
        .iter()
        .find(|scenario| scenario.name == "capability")
        .expect("the capability scenario ran");
    assert!(
        capability.checks.iter().all(|check| check.ok),
        "{:#?}",
        capability.checks
    );
    assert!(capability
        .checks
        .iter()
        .any(|check| check.name == "legacy_is_busy_with_no_active_participant" && check.ok));
    let reenter = report
        .scenarios
        .iter()
        .find(|scenario| scenario.name == "leave-reenter")
        .expect("the leave-reenter scenario ran");
    assert!(
        reenter.checks.iter().all(|check| check.ok),
        "{:#?}",
        reenter.checks
    );
    for name in [
        "audit_joins",
        "audit_leaves",
        "cycle_2_stale_leave_is_a_no_op",
    ] {
        assert!(
            reenter
                .checks
                .iter()
                .any(|check| check.name == name && check.ok),
            "{name}"
        );
    }
    let closed = report
        .scenarios
        .iter()
        .find(|scenario| scenario.name == "closed-part")
        .expect("the closed-part scenario ran");
    assert!(
        closed.checks.iter().all(|check| check.ok),
        "{:#?}",
        closed.checks
    );
    for name in [
        "late_facts_of_a_closed_part_are_accepted",
        "shift_closes_at_the_latest_moment",
        "race_2_exactly_one_close_closes_the_shift",
    ] {
        assert!(
            closed
                .checks
                .iter()
                .any(|check| check.name == name && check.ok),
            "{name}"
        );
    }
    let races = report
        .scenarios
        .iter()
        .find(|scenario| scenario.name == "close-races")
        .expect("the close-races scenario ran");
    assert!(
        races.checks.iter().all(|check| check.ok),
        "{:#?}",
        races.checks
    );
    for name in [
        "n_closes_at_once_exactly_one_closes_the_shift",
        "race_0_one_of_the_two_orders",
        "race_3_close_events_match_device_closed_parts",
    ] {
        assert!(
            races
                .checks
                .iter()
                .any(|check| check.name == name && check.ok),
            "{name}"
        );
    }
    assert!(races.observed.contains_key("orders"));
    let lines = report
        .scenarios
        .iter()
        .find(|scenario| scenario.name == "lines")
        .expect("the lines scenario ran");
    assert!(
        lines.checks.iter().all(|check| check.ok),
        "{:#?}",
        lines.checks
    );
    for name in [
        "entry_into_another_lines_shift_is_refused",
        "line_0_limit_below_its_own_slots_is_refused",
        "a_later_scan_on_another_line_is_a_conflict_naming_the_owner_shift",
        "totals_follow_the_owner_shift",
        "shift_0_closed_by_its_last_part",
    ] {
        assert!(
            lines
                .checks
                .iter()
                .any(|check| check.name == name && check.ok),
            "{name}"
        );
    }
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
    profile.set("scenarios", "line-full").unwrap();
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
    // The messages name no secret, nor anything counted from them: a failing
    // assertion's text is a log of its own.
    assert!(secrets.len() >= 5, "the run made fewer than five secrets");
    assert!(secrets.iter().any(|secret| secret.starts_with("Load-")));
    // The scenario's own site made a second administrator password, and it is among them.
    assert!(
        secrets
            .iter()
            .filter(|secret| secret.starts_with("Load-"))
            .count()
            >= 2,
        "the scenario's secrets are not among the run's"
    );
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
                "a secret of the run is in {}",
                path.display()
            );
        }
    }
    // The host's own data folder is not a report file and is not scanned; it
    // stays in the temp folder, which is removed with it.
}
