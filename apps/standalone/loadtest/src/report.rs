//! What a run leaves behind: a JSON report (everything, for comparing runs
//! and for tools) and a short Markdown summary (for a person), both written
//! to a folder outside the repository, and the verdict that turns the numbers
//! into pass or fail by the profile's thresholds.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::checks::Check;
use crate::device::DeviceStats;
use crate::histogram::LatencySummary;
use crate::host::LogScan;
use crate::ledger::Expected;
use crate::procstat::slope_per_hour;
use crate::profile::{Profile, Thresholds};
use crate::sampler::Sample;

pub const SCHEMA: u32 = 2;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Throughput {
    pub scans_generated: u64,
    pub scans_per_s: f64,
    pub ideal_scans: f64,
    pub generated_share: f64,
    pub records_acked: u64,
    pub duration_s: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Resources {
    pub samples: usize,
    pub rss_start_mib: Option<f64>,
    pub rss_max_mib: Option<f64>,
    pub rss_end_mib: Option<f64>,
    pub rss_slope_mib_per_hour: Option<f64>,
    pub fds_after_warmup: Option<u64>,
    pub fds_max: Option<u64>,
    pub fds_end: Option<u64>,
    pub wal_file_max_mib: Option<f64>,
    pub wal_backlog_max_frames: Option<u64>,
    pub wal_backlog_p99_frames: Option<u64>,
    pub wal_backlog_end_frames: Option<u64>,
    pub db_end_mib: Option<f64>,
}

const MIB: f64 = 1024.0 * 1024.0;

/// The figures of a series. `warmup_s` is the time before which a sample is
/// the host settling down: the slope and the descriptor baseline start after it.
pub fn summarize(series: &[Sample], warmup_s: f64) -> Resources {
    let mib = |bytes: u64| bytes as f64 / MIB;
    let rss: Vec<(f64, u64)> = series
        .iter()
        .filter_map(|s| s.rss_bytes.map(|b| (s.t_s, b)))
        .collect();
    let steady: Vec<(f64, f64)> = rss
        .iter()
        .filter(|(t, _)| *t >= warmup_s)
        .map(|(t, b)| (*t, mib(*b)))
        .collect();
    let fds: Vec<(f64, u64)> = series
        .iter()
        .filter_map(|s| s.fds.map(|f| (s.t_s, f)))
        .collect();
    let mut backlog: Vec<u64> = series.iter().filter_map(|s| s.wal_backlog_frames).collect();
    backlog.sort_unstable();
    let p99 = (!backlog.is_empty()).then(|| {
        backlog[((backlog.len() as f64 * 0.99).ceil() as usize).clamp(1, backlog.len()) - 1]
    });
    Resources {
        samples: series.len(),
        rss_start_mib: rss.first().map(|(_, b)| mib(*b)),
        rss_max_mib: rss
            .iter()
            .map(|(_, b)| mib(*b))
            .fold(None, |m: Option<f64>, v| Some(m.map_or(v, |m| m.max(v)))),
        rss_end_mib: rss.last().map(|(_, b)| mib(*b)),
        rss_slope_mib_per_hour: (steady.len() >= 3).then(|| slope_per_hour(&steady)),
        fds_after_warmup: fds
            .iter()
            .find(|(t, _)| *t >= warmup_s)
            .or(fds.first())
            .map(|(_, f)| *f),
        fds_max: fds.iter().map(|(_, f)| *f).max(),
        fds_end: fds.last().map(|(_, f)| *f),
        wal_file_max_mib: series.iter().filter_map(|s| s.wal_bytes).max().map(mib),
        wal_backlog_max_frames: backlog.last().copied(),
        wal_backlog_p99_frames: p99,
        wal_backlog_end_frames: series.iter().rev().find_map(|s| s.wal_backlog_frames),
        db_end_mib: series.iter().rev().find_map(|s| s.db_bytes).map(mib),
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DrillResult {
    pub name: String,
    pub checks: Vec<Check>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackupResult {
    pub at_fraction: f64,
    pub duration_ms: u64,
    pub file: String,
    pub size_bytes: u64,
    pub scans_in_copy: i64,
    pub acked_before: u64,
    pub acked_after_with_slack: u64,
    pub checks: Vec<Check>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RestoreResult {
    pub copy: String,
    pub counts: BTreeMap<String, i64>,
    pub checks: Vec<Check>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Verdict {
    pub pass: bool,
    pub failures: Vec<String>,
    pub warnings: Vec<String>,
}

/// A multi-station scenario (plan `2026-10-22-multi-station-load-test-scenarios.md`): its checks,
/// what it observed, and whether it was judged at all with this run's host.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScenarioResult {
    pub name: String,
    /// `false`: the scenario needs what this host mode lacks (a spawned host); `note` says why.
    pub judged: bool,
    /// Why it was not judged, or which path a judged run did not exercise this time.
    pub note: String,
    pub duration_ms: u64,
    pub checks: Vec<Check>,
    /// What the scenario saw that is recorded, not judged (which order a race took, ...).
    pub observed: BTreeMap<String, serde_json::Value>,
    /// Latency of the scenario's own requests by route: recorded, never judged.
    pub latency: BTreeMap<String, LatencySummary>,
    /// The scenario's own error classes: its refusals are deliberate.
    pub errors: BTreeMap<String, u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Report {
    pub schema: u32,
    pub started_at: String,
    pub host_kind: String,
    pub host_version: String,
    pub host_protocol: u64,
    pub os: String,
    pub profile: Profile,
    pub thresholds: Thresholds,
    pub latency: BTreeMap<String, LatencySummary>,
    pub errors: BTreeMap<String, u64>,
    pub throughput: Throughput,
    pub devices: Vec<DeviceStats>,
    pub expected: Expected,
    pub resources: Resources,
    pub checks: Vec<Check>,
    pub drills: Vec<DrillResult>,
    pub backups: Vec<BackupResult>,
    pub restore: Option<RestoreResult>,
    /// The multi-station scenarios, each on a fresh host after the main run; a schema-1 report
    /// has none.
    #[serde(default)]
    pub scenarios: Vec<ScenarioResult>,
    /// The fine WAL watch of the main run (`wal_watch.rs`); a schema-1 report has none.
    #[serde(default)]
    pub wal_watch: Option<crate::wal_watch::WalWatch>,
    pub log: LogScan,
    /// `None` where a stop on request is not possible (Windows, in-process).
    pub graceful_stop: Option<bool>,
    pub verdict: Verdict,
    pub series: Vec<Sample>,
}

fn latency_of<'a>(report: &'a Report, route: &str) -> Option<&'a LatencySummary> {
    report
        .latency
        .get(route)
        .filter(|summary| summary.count > 0)
}

fn over(name: &str, limit: f64, actual: f64, unit: &str) -> Option<String> {
    (actual > limit).then(|| format!("{name}: {actual:.1} {unit} is above {limit:.1} {unit}"))
}

/// Every threshold and every check, turned into the list of what failed.
pub fn evaluate(report: &Report) -> Verdict {
    let t = &report.thresholds;
    let mut failures = Vec::new();
    let mut warnings = Vec::new();
    if let Some(facts) = latency_of(report, "facts") {
        failures.extend(over("facts p95", t.facts_p95_ms, facts.p95_ms, "ms"));
        failures.extend(over("facts p99", t.facts_p99_ms, facts.p99_ms, "ms"));
        failures.extend(over("facts max", t.facts_max_ms, facts.max_ms, "ms"));
    } else {
        failures.push("facts: no request was measured".to_owned());
    }
    if let Some(backup) = latency_of(report, "facts_during_backup") {
        failures.extend(over(
            "facts p99 during a backup",
            t.facts_backup_p99_ms,
            backup.p99_ms,
            "ms",
        ));
    }
    if let Some(check) = latency_of(report, "code_check") {
        failures.extend(over(
            "code check p99",
            t.code_check_p99_ms,
            check.p99_ms,
            "ms",
        ));
    }
    let checks: u64 = report.devices.iter().map(|device| device.checks).sum();
    let timeouts: u64 = report
        .devices
        .iter()
        .map(|device| device.check_timeouts)
        .sum();
    if checks > 0 {
        failures.extend(over(
            "code checks over 300 ms",
            t.code_check_over_300ms_share * 100.0,
            timeouts as f64 / checks as f64 * 100.0,
            "% of checks",
        ));
    }
    for route in ["device_shifts", "sscc_block", "enter"] {
        if let Some(summary) = latency_of(report, route) {
            failures.extend(over(
                &format!("{route} p99"),
                t.other_p99_ms,
                summary.p99_ms,
                "ms",
            ));
        }
    }
    let by_class = |tail: &str| -> u64 {
        report
            .errors
            .iter()
            .filter(|(key, _)| key.contains(&format!(":{tail}")))
            .map(|(_, count)| count)
            .sum()
    };
    if !report.log.available {
        warnings.push(
            "the host log is unavailable: its ERROR and busy lines were not counted".to_owned(),
        );
    }
    let server = by_class("http_5xx") + report.log.error_lines;
    if server > t.server_errors {
        failures.push(format!(
            "server errors: {server} (5xx answers and ERROR lines of the log), at most {}",
            t.server_errors
        ));
    }
    if report.log.busy_lines > t.busy_errors {
        failures.push(format!(
            "busy database: {} log lines, at most {}",
            report.log.busy_lines, t.busy_errors
        ));
    }
    let net = by_class("net_");
    if net > t.net_errors {
        failures.push(format!(
            "requests without an answer: {net}, at most {}",
            t.net_errors
        ));
    }
    let client = by_class("http_4xx");
    if client > t.client_errors {
        failures.push(format!(
            "requests the host refused: {client}, at most {}",
            t.client_errors
        ));
    }
    let r = &report.resources;
    if let Some(max) = r.wal_backlog_max_frames {
        if max > t.wal_backlog_max_frames {
            failures.push(format!(
                "WAL backlog: {max} frames, at most {}",
                t.wal_backlog_max_frames
            ));
        }
    } else if report.host_kind != "attach" {
        warnings.push("the WAL backlog could not be read".to_owned());
    }
    if let Some(mib) = r.wal_file_max_mib {
        failures.extend(over("WAL file", t.wal_file_max_mib as f64, mib, "MiB"));
    } else if report.host_kind != "attach" {
        warnings.push("the WAL file size is unavailable: it was not judged".to_owned());
    }
    if report.profile.duration_s >= t.slope_min_duration_s {
        match r.rss_slope_mib_per_hour {
            Some(slope) => failures.extend(over(
                "host memory growth",
                t.rss_slope_mib_per_hour,
                slope,
                "MiB/h",
            )),
            None => warnings.push("memory growth is unavailable: it was not judged".to_owned()),
        }
    }
    if let Some(watch) = &report.wal_watch {
        if watch.readable_points == 0 {
            warnings.push(
                "the WAL watch never read the wal-index: checkpoints were not observed".to_owned(),
            );
        } else if watch.restarts == 0 && watch.duration_s >= 60.0 {
            warnings.push(format!(
                "the WAL never started again in {:.0} s: the automatic checkpoint never caught up with the end of the log (see walWatch.findings)",
                watch.duration_s
            ));
        }
    }
    if r.fds_max.is_none() || r.fds_after_warmup.is_none() || r.fds_end.is_none() {
        warnings.push("the descriptor count is unavailable: it was not judged".to_owned());
    }
    if let (Some(max), Some(base), Some(end)) = (r.fds_max, r.fds_after_warmup, r.fds_end) {
        let allowed = t.fd_fixed + t.fd_per_device * u64::from(report.profile.devices());
        if max > allowed {
            failures.push(format!(
                "descriptors: {max} at most open, {allowed} allowed"
            ));
        }
        if end > base + t.fd_growth_max {
            failures.push(format!(
                "descriptors grew from {base} to {end}, by at most {}",
                t.fd_growth_max
            ));
        }
    }
    if report.throughput.generated_share < t.generated_share_min {
        failures.push(format!(
            "the devices made {:.0} % of the ideal scans, at least {:.0} % expected",
            report.throughput.generated_share * 100.0,
            t.generated_share_min * 100.0
        ));
    }
    for device in &report.devices {
        if let Some(fatal) = &device.fatal {
            failures.push(format!("device {} stopped: {fatal}", device.index));
        }
        if device.resend_mismatches > 0 {
            failures.push(format!(
                "device {}: {} resent batches were not answered alike",
                device.index, device.resend_mismatches
            ));
        }
        if device.check_surprises > 0 {
            failures.push(format!(
                "device {}: {} code checks answered against the registry",
                device.index, device.check_surprises
            ));
        }
        if device.totals_regressions > 0 {
            failures.push(format!(
                "device {}: the shift's total went down {} times",
                device.index, device.totals_regressions
            ));
        }
        if device.poll_sum_mismatches > 0 {
            warnings.push(format!(
                "device {}: {} totals polls where byDevice did not add up (the host reads them in separate queries?)",
                device.index, device.poll_sum_mismatches
            ));
        }
    }
    if report.devices.iter().any(|device| device.stalls > 0) {
        warnings
            .push("a scanner waited for an SSCC serial: the half rule did not keep up".to_owned());
    }
    if report.graceful_stop == Some(false) {
        failures.push("the host did not stop on request".to_owned());
    }
    if report.checks.is_empty() {
        failures.push("no check ran: the reconciliation was not done".to_owned());
    }
    let mut failed = |scope: &str, checks: &[Check]| {
        for check in checks.iter().filter(|check| !check.ok) {
            failures.push(format!("{scope} {}: {}", check.name, check.detail));
        }
    };
    failed("check", &report.checks);
    for drill in &report.drills {
        failed(&format!("drill {}", drill.name), &drill.checks);
    }
    for backup in &report.backups {
        failed(
            &format!("backup at {:.0} %", backup.at_fraction * 100.0),
            &backup.checks,
        );
    }
    if let Some(restore) = &report.restore {
        failed("restore", &restore.checks);
    }
    for scenario in report.scenarios.iter().filter(|scenario| scenario.judged) {
        failed(&format!("scenario {}", scenario.name), &scenario.checks);
    }
    for scenario in &report.scenarios {
        if !scenario.judged {
            warnings.push(format!(
                "scenario {} not judged: {}",
                scenario.name, scenario.note
            ));
        } else if scenario.checks.is_empty() {
            failures.push(format!("scenario {}: no check ran", scenario.name));
        }
    }
    Verdict {
        pass: failures.is_empty(),
        failures,
        warnings,
    }
}

pub fn render_markdown(report: &Report) -> String {
    use std::fmt::Write;
    let mut out = String::new();
    let verdict = if report.verdict.pass { "PASS" } else { "FAIL" };
    let profile = &report.profile;
    let _ = writeln!(out, "# Load run `{}`: {verdict}\n", profile.name);
    let _ = writeln!(
        out,
        "{} stations + {} handhelds, {} scans/s each, {} s. Host {} (protocol {}), {}, {}.\n",
        profile.stations,
        profile.handhelds,
        profile.scan_rate,
        profile.duration_s,
        report.host_version,
        report.host_protocol,
        report.host_kind,
        report.os
    );
    if !report.verdict.failures.is_empty() {
        let _ = writeln!(out, "## Failures\n");
        for failure in &report.verdict.failures {
            let _ = writeln!(out, "- {failure}");
        }
        out.push('\n');
    }
    if !report.verdict.warnings.is_empty() {
        let _ = writeln!(out, "## Warnings\n");
        for warning in &report.verdict.warnings {
            let _ = writeln!(out, "- {warning}");
        }
        out.push('\n');
    }
    let _ = writeln!(out, "## Latency (ms)\n\n| route | count | p50 | p95 | p99 | max |\n|---|---:|---:|---:|---:|---:|");
    for (route, s) in &report.latency {
        let _ = writeln!(
            out,
            "| {route} | {} | {:.1} | {:.1} | {:.1} | {:.1} |",
            s.count, s.p50_ms, s.p95_ms, s.p99_ms, s.max_ms
        );
    }
    let t = &report.throughput;
    let _ = writeln!(
        out,
        "\n## Throughput\n\n{} scans made ({:.1}/s, {:.0} % of the ideal), {} records acknowledged.\n",
        t.scans_generated, t.scans_per_s, t.generated_share * 100.0, t.records_acked
    );
    let e = &report.expected;
    let _ = writeln!(
        out,
        "## Reconciliation\n\n{} distinct codes accepted, {} conflicts, {} displacements, {} boxes and {} pallets closed; {} of {} checks held.\n",
        e.distinct_accepted_codes, e.conflict_receipts, e.displacements, e.boxes_closed, e.pallets_closed,
        report.checks.iter().filter(|check| check.ok).count(), report.checks.len()
    );
    let r = &report.resources;
    let fmt = |value: Option<f64>| value.map_or("n/a".to_owned(), |v| format!("{v:.1}"));
    let fmt_u = |value: Option<u64>| value.map_or("n/a".to_owned(), |v| v.to_string());
    let _ = writeln!(
        out,
        "## Host\n\nMemory {} / {} / {} MiB (start / max / end), slope {} MiB/h; descriptors max {}, end {}; \
         WAL file max {} MiB, backlog max {} frames (p99 {}, end {}); database {} MiB.\n",
        fmt(r.rss_start_mib), fmt(r.rss_max_mib), fmt(r.rss_end_mib), fmt(r.rss_slope_mib_per_hour),
        fmt_u(r.fds_max), fmt_u(r.fds_end), fmt(r.wal_file_max_mib),
        fmt_u(r.wal_backlog_max_frames), fmt_u(r.wal_backlog_p99_frames), fmt_u(r.wal_backlog_end_frames), fmt(r.db_end_mib)
    );
    if let Some(watch) = &report.wal_watch {
        let _ = writeln!(out, "## WAL watch\n");
        for finding in &watch.findings {
            let _ = writeln!(out, "- {finding}");
        }
        out.push('\n');
    }
    let _ = writeln!(out, "## Under load and at the end\n");
    for backup in &report.backups {
        let _ = writeln!(
            out,
            "- backup at {:.0} %: {} ms, {} bytes, {} scans in the copy (acknowledged before: {}), {}",
            backup.at_fraction * 100.0, backup.duration_ms, backup.size_bytes, backup.scans_in_copy, backup.acked_before,
            if backup.checks.iter().all(|check| check.ok) { "held" } else { "FAILED" }
        );
    }
    if let Some(restore) = &report.restore {
        let _ = writeln!(
            out,
            "- restore round-trip: {}",
            if restore.checks.iter().all(|check| check.ok) {
                "counts equal"
            } else {
                "FAILED"
            }
        );
    }
    for drill in &report.drills {
        let _ = writeln!(
            out,
            "- drill {}: {}",
            drill.name,
            if drill.checks.iter().all(|check| check.ok) {
                "held"
            } else {
                "FAILED"
            }
        );
    }
    if !report.scenarios.is_empty() {
        let _ = writeln!(out, "\n## Scenarios\n");
        for scenario in &report.scenarios {
            let failed = scenario.checks.iter().filter(|check| !check.ok).count();
            let state = if !scenario.judged {
                format!("not judged ({})", scenario.note)
            } else if failed == 0 && !scenario.checks.is_empty() {
                format!("held ({} checks)", scenario.checks.len())
            } else {
                format!("FAILED ({} checks, {failed} failed)", scenario.checks.len())
            };
            if scenario.judged && !scenario.note.is_empty() {
                let _ = writeln!(
                    out,
                    "- scenario {}: {state}; note: {}",
                    scenario.name, scenario.note
                );
            } else {
                let _ = writeln!(out, "- scenario {}: {state}", scenario.name);
            }
        }
    }
    out
}

/// A change from the older report to the newer that a person must look at.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Regression(pub String);

/// The rules of «better or worse» between two runs of one profile.
pub fn compare(old: &Report, new: &Report) -> Vec<Regression> {
    let mut found = Vec::new();
    if old.profile.name != new.profile.name {
        found.push(Regression(format!(
            "the profiles differ: {} and {}",
            old.profile.name, new.profile.name
        )));
    }
    if old.verdict.pass && !new.verdict.pass {
        found.push(Regression("the verdict went from pass to fail".to_owned()));
    }
    for (route, factor, slack) in [
        ("facts", 1.5, 20.0),
        ("code_check", 1.5, 10.0),
        ("device_shifts", 1.5, 20.0),
    ] {
        if let (Some(a), Some(b)) = (latency_of(old, route), latency_of(new, route)) {
            for (name, before, after) in [("p95", a.p95_ms, b.p95_ms), ("p99", a.p99_ms, b.p99_ms)]
            {
                if after > before * factor + slack {
                    found.push(Regression(format!(
                        "{route} {name}: {before:.1} ms to {after:.1} ms"
                    )));
                }
            }
        }
    }
    if new.throughput.scans_per_s < old.throughput.scans_per_s * 0.9 {
        found.push(Regression(format!(
            "scans per second: {:.1} to {:.1}",
            old.throughput.scans_per_s, new.throughput.scans_per_s
        )));
    }
    if let (Some(a), Some(b)) = (old.resources.rss_max_mib, new.resources.rss_max_mib) {
        if b > a * 1.25 + 16.0 {
            found.push(Regression(format!(
                "host memory at most: {a:.0} MiB to {b:.0} MiB"
            )));
        }
    }
    if let (Some(a), Some(b)) = (
        old.resources.wal_backlog_max_frames,
        new.resources.wal_backlog_max_frames,
    ) {
        if b as f64 > a as f64 * 1.5 + 1000.0 {
            found.push(Regression(format!(
                "WAL backlog at most: {a} to {b} frames"
            )));
        }
    }
    for class in new.errors.keys() {
        if !old.errors.contains_key(class) {
            found.push(Regression(format!("a new class of error: {class}")));
        }
    }
    found
}

/// The report with every given secret replaced by `[redacted]` in every string
/// (log lines, check details, file names), so a host that logs a credential
/// does not carry it into the file a run leaves behind.
pub fn redact(report: &Report, secrets: &[String]) -> Report {
    fn clean(text: &str, secrets: &[String]) -> String {
        let mut text = text.to_owned();
        for secret in secrets.iter().filter(|secret| !secret.is_empty()) {
            text = text.replace(secret.as_str(), "[redacted]");
        }
        text
    }
    fn walk(value: &mut serde_json::Value, secrets: &[String]) {
        match value {
            serde_json::Value::String(text) => *text = clean(text, secrets),
            serde_json::Value::Array(items) => items.iter_mut().for_each(|v| walk(v, secrets)),
            serde_json::Value::Object(map) => {
                // Keys too: the error classes are map keys.
                let old = std::mem::take(map);
                for (key, mut item) in old {
                    walk(&mut item, secrets);
                    let key = clean(&key, secrets);
                    let merged = match (map.remove(&key), &item) {
                        (Some(serde_json::Value::Number(a)), serde_json::Value::Number(b)) => {
                            serde_json::json!(a.as_u64().unwrap_or(0) + b.as_u64().unwrap_or(0))
                        }
                        _ => item,
                    };
                    map.insert(key, merged);
                }
            }
            _ => {}
        }
    }
    let mut value = serde_json::to_value(report).expect("a report is serializable");
    walk(&mut value, secrets);
    serde_json::from_value(value).expect("a redacted report is still a report")
}

#[cfg(test)]
pub fn sample_passing() -> Report {
    let profile = Profile::preset("smoke").unwrap();
    let summary = |p50: f64, p99: f64| LatencySummary {
        count: 1000,
        p50_ms: p50,
        p95_ms: p99 / 2.0,
        p99_ms: p99,
        max_ms: p99 * 2.0,
        mean_ms: p50,
    };
    let mut latency = BTreeMap::new();
    latency.insert("facts".to_owned(), summary(5.0, 40.0));
    latency.insert("code_check".to_owned(), summary(1.0, 8.0));
    latency.insert("device_shifts".to_owned(), summary(3.0, 30.0));
    let devices = (0..profile.devices())
        .map(|index| DeviceStats {
            index,
            checks: 100,
            ..DeviceStats::default()
        })
        .collect();
    Report {
        schema: SCHEMA,
        started_at: "2026-10-20T10:00:00Z".to_owned(),
        host_kind: "spawn".to_owned(),
        host_version: "1.1.0".to_owned(),
        host_protocol: 7,
        os: "linux".to_owned(),
        thresholds: Thresholds::for_profile("smoke").unwrap(),
        latency,
        errors: BTreeMap::new(),
        throughput: Throughput {
            scans_generated: 5400,
            scans_per_s: 30.0,
            ideal_scans: profile.ideal_scans(),
            generated_share: 1.0,
            records_acked: 5800,
            duration_s: 180.0,
        },
        devices,
        expected: Expected::default(),
        resources: Resources {
            samples: 36,
            rss_max_mib: Some(60.0),
            fds_after_warmup: Some(30),
            fds_max: Some(34),
            fds_end: Some(31),
            wal_file_max_mib: Some(8.0),
            wal_backlog_max_frames: Some(900),
            ..Resources::default()
        },
        checks: vec![Check::new("reconcile", true, "ok")],
        drills: vec![],
        backups: vec![],
        restore: None,
        scenarios: vec![],
        wal_watch: None,
        log: LogScan {
            available: true,
            ..LogScan::default()
        },
        graceful_stop: Some(true),
        verdict: Verdict::default(),
        series: vec![],
        profile,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_clean_run_passes() {
        let verdict = evaluate(&sample_passing());
        assert!(verdict.pass, "{verdict:?}");
        assert!(verdict.failures.is_empty());
    }

    #[test]
    fn every_threshold_turns_into_a_failure_that_names_it() {
        let cases: Vec<(&str, Box<dyn Fn(&mut Report)>)> = vec![
            (
                "facts p99",
                Box::new(|r| r.latency.get_mut("facts").unwrap().p99_ms = 251.0),
            ),
            (
                "facts p95",
                Box::new(|r| r.latency.get_mut("facts").unwrap().p95_ms = 101.0),
            ),
            (
                "facts max",
                Box::new(|r| r.latency.get_mut("facts").unwrap().max_ms = 2001.0),
            ),
            (
                "code check p99",
                Box::new(|r| r.latency.get_mut("code_check").unwrap().p99_ms = 151.0),
            ),
            (
                "device_shifts p99",
                Box::new(|r| r.latency.get_mut("device_shifts").unwrap().p99_ms = 501.0),
            ),
            (
                "server errors",
                Box::new(|r| {
                    r.errors.insert("facts:http_5xx".to_owned(), 1);
                }),
            ),
            ("server errors", Box::new(|r| r.log.error_lines = 1)),
            ("busy database", Box::new(|r| r.log.busy_lines = 1)),
            (
                "requests without an answer",
                Box::new(|r| {
                    r.errors.insert("facts:net_timeout".to_owned(), 1);
                }),
            ),
            (
                "requests the host refused",
                Box::new(|r| {
                    r.errors.insert("enter:http_4xx:conflict".to_owned(), 1);
                }),
            ),
            (
                "WAL backlog",
                Box::new(|r| r.resources.wal_backlog_max_frames = Some(8001)),
            ),
            (
                "WAL file",
                Box::new(|r| r.resources.wal_file_max_mib = Some(257.0)),
            ),
            ("descriptors", Box::new(|r| r.resources.fds_max = Some(89))),
            (
                "descriptors grew",
                Box::new(|r| r.resources.fds_end = Some(39)),
            ),
            (
                "ideal scans",
                Box::new(|r| r.throughput.generated_share = 0.89),
            ),
            (
                "device 2 stopped",
                Box::new(|r| r.devices[2].fatal = Some("x".to_owned())),
            ),
            (
                "resent batches",
                Box::new(|r| r.devices[0].resend_mismatches = 1),
            ),
            (
                "host did not stop",
                Box::new(|r| r.graceful_stop = Some(false)),
            ),
            (
                "check reconcile",
                Box::new(|r| {
                    r.checks
                        .push(Check::new("reconcile", false, "expected 1, got 2"))
                }),
            ),
        ];
        for (needle, mutate) in cases {
            let mut report = sample_passing();
            mutate(&mut report);
            let verdict = evaluate(&report);
            assert!(!verdict.pass, "{needle}");
            assert!(
                verdict
                    .failures
                    .iter()
                    .any(|failure| failure.contains(needle)),
                "{needle}: {:?}",
                verdict.failures
            );
        }
    }

    #[test]
    fn memory_growth_is_judged_only_for_a_long_run() {
        let mut report = sample_passing();
        report.resources.rss_slope_mib_per_hour = Some(50.0);
        assert!(
            evaluate(&report).pass,
            "a three minute run has no slope to judge"
        );
        report.profile.duration_s = 4 * 3600;
        let verdict = evaluate(&report);
        assert!(
            verdict.failures.iter().any(|f| f.contains("memory growth")),
            "{verdict:?}"
        );
        report.resources.rss_slope_mib_per_hour = Some(19.0);
        assert!(evaluate(&report).pass);
    }

    #[test]
    fn a_summary_reads_memory_descriptors_and_the_wal_from_the_series() {
        let sample = |t_s: f64, rss_mib: u64, fds: u64, backlog: u64| Sample {
            t_s,
            rss_bytes: Some(rss_mib * 1024 * 1024),
            fds: Some(fds),
            db_bytes: Some(10 * 1024 * 1024),
            wal_bytes: Some(2 * 1024 * 1024),
            wal_backlog_frames: Some(backlog),
        };
        let series = vec![
            sample(0.0, 30, 20, 10),
            sample(600.0, 40, 30, 500),
            sample(1200.0, 50, 30, 700),
            sample(1800.0, 60, 31, 100),
        ];
        let resources = summarize(&series, 600.0);
        assert_eq!(resources.rss_start_mib, Some(30.0));
        assert_eq!(resources.rss_max_mib, Some(60.0));
        assert_eq!(resources.fds_after_warmup, Some(30));
        assert_eq!((resources.fds_max, resources.fds_end), (Some(31), Some(31)));
        assert_eq!(
            (
                resources.wal_backlog_max_frames,
                resources.wal_backlog_end_frames
            ),
            (Some(700), Some(100))
        );
        assert_eq!(resources.wal_backlog_p99_frames, Some(700));
        // 10 MiB in each ten minutes after the warm-up.
        assert!((resources.rss_slope_mib_per_hour.unwrap() - 60.0).abs() < 1e-6);
        assert_eq!(summarize(&[], 0.0).samples, 0);
    }

    #[test]
    fn two_runs_are_compared_by_the_rules_of_the_runbook() {
        let mut old = sample_passing();
        old.verdict.pass = true;
        assert!(compare(&old, &old).is_empty());
        let mut new = sample_passing();
        new.latency.get_mut("facts").unwrap().p99_ms = 40.0 * 1.5 + 21.0;
        new.throughput.scans_per_s = 26.0;
        new.resources.rss_max_mib = Some(60.0 * 1.25 + 17.0);
        new.errors.insert("facts:net_timeout".to_owned(), 1);
        new.verdict.pass = false;
        let found: Vec<String> = compare(&old, &new)
            .into_iter()
            .map(|Regression(text)| text)
            .collect();
        for needle in [
            "facts p99",
            "scans per second",
            "host memory",
            "new class of error",
            "pass to fail",
        ] {
            assert!(
                found.iter().any(|text| text.contains(needle)),
                "{needle}: {found:?}"
            );
        }
        let mut other = sample_passing();
        other.profile.name = "soak".to_owned();
        assert!(compare(&old, &other)
            .iter()
            .any(|r| r.0.contains("profiles differ")));
    }

    #[test]
    fn the_markdown_says_the_verdict_and_lists_the_failures() {
        let mut report = sample_passing();
        report.latency.get_mut("facts").unwrap().p99_ms = 900.0;
        report.verdict = evaluate(&report);
        let text = render_markdown(&report);
        assert!(text.starts_with("# Load run `smoke`: FAIL"));
        assert!(text.contains("## Failures"));
        assert!(text.contains("facts p99"));
        assert!(text.contains("| facts | 1000 |"));
    }

    #[test]
    fn a_report_survives_its_own_json() {
        let mut report = sample_passing();
        report.verdict = evaluate(&report);
        let text = serde_json::to_string_pretty(&report).unwrap();
        let back: Report = serde_json::from_str(&text).unwrap();
        assert_eq!(back, report);
    }

    fn warned(report: &Report, needle: &str) -> bool {
        evaluate(report).warnings.iter().any(|w| w.contains(needle))
    }

    #[test]
    fn an_unavailable_vital_is_reported_and_never_counted_as_passing() {
        let mut report = sample_passing();
        report.resources = Resources::default();
        report.log.available = false;
        let verdict = evaluate(&report);
        // Not judged is not failed (an attached or Windows host may have no probe),
        // but each blind spot is named in the verdict, never silently green.
        assert!(verdict.pass, "{verdict:?}");
        for needle in [
            "WAL backlog could not be read",
            "WAL file size is unavailable",
            "descriptor count is unavailable",
            "host log is unavailable",
        ] {
            assert!(warned(&report, needle), "{needle}: {:?}", verdict.warnings);
        }
        report.profile.duration_s = 4 * 3600;
        assert!(warned(&report, "memory growth is unavailable"));
        // On an attached host the host-side probes are not expected.
        let mut attach = sample_passing();
        attach.host_kind = "attach".to_owned();
        attach.resources = Resources::default();
        assert!(!warned(&attach, "WAL"));
    }

    #[test]
    fn a_run_without_any_check_or_a_facts_request_does_not_pass() {
        let mut report = sample_passing();
        report.checks.clear();
        let verdict = evaluate(&report);
        assert!(!verdict.pass);
        assert!(verdict.failures.iter().any(|f| f.contains("no check ran")));
        let mut report = sample_passing();
        report.latency.clear();
        let verdict = evaluate(&report);
        assert!(!verdict.pass);
        assert!(verdict
            .failures
            .iter()
            .any(|f| f.contains("facts: no request")));
    }

    #[test]
    fn a_failed_check_of_a_drill_a_backup_or_the_restore_fails_the_verdict() {
        let bad = || vec![Check::new("db-check", false, "malformed page")];
        let cases: Vec<(&str, Box<dyn Fn(&mut Report)>)> = vec![
            (
                "drill crash",
                Box::new(|r| {
                    r.drills.push(DrillResult {
                        name: "crash".to_owned(),
                        checks: bad(),
                    })
                }),
            ),
            (
                "backup at 50 %",
                Box::new(|r| {
                    r.backups.push(BackupResult {
                        at_fraction: 0.5,
                        duration_ms: 1,
                        file: "b".to_owned(),
                        size_bytes: 1,
                        scans_in_copy: 1,
                        acked_before: 1,
                        acked_after_with_slack: 2,
                        checks: bad(),
                    })
                }),
            ),
            (
                "restore db-check",
                Box::new(|r| {
                    r.restore = Some(RestoreResult {
                        copy: "c".to_owned(),
                        counts: BTreeMap::new(),
                        checks: bad(),
                    })
                }),
            ),
        ];
        for (needle, mutate) in cases {
            let mut report = sample_passing();
            mutate(&mut report);
            let verdict = evaluate(&report);
            assert!(!verdict.pass, "{needle}");
            assert!(
                verdict
                    .failures
                    .iter()
                    .any(|f| f.contains(needle) && f.contains("malformed page")),
                "{needle}: {:?}",
                verdict.failures
            );
        }
    }

    #[test]
    fn the_remaining_thresholds_fail_only_above_their_limit() {
        // (needle, set above the limit, set at the limit)
        type Set = Box<dyn Fn(&mut Report)>;
        let cases: Vec<(&str, Set, Set)> = vec![
            (
                "code checks over 300 ms",
                Box::new(|r| r.devices[0].check_timeouts = 1),
                Box::new(|r| r.devices[0].check_timeouts = 0),
            ),
            (
                "facts p99 during a backup",
                Box::new(|r| {
                    r.latency.insert(
                        "facts_during_backup".to_owned(),
                        LatencySummary {
                            count: 10,
                            p99_ms: 501.0,
                            ..LatencySummary::default()
                        },
                    );
                }),
                Box::new(|r| {
                    r.latency.insert(
                        "facts_during_backup".to_owned(),
                        LatencySummary {
                            count: 10,
                            p99_ms: 500.0,
                            ..LatencySummary::default()
                        },
                    );
                }),
            ),
            (
                "WAL backlog",
                Box::new(|r| r.resources.wal_backlog_max_frames = Some(8001)),
                Box::new(|r| r.resources.wal_backlog_max_frames = Some(8000)),
            ),
            (
                "check 1 answered against the registry",
                Box::new(|r| r.devices[1].check_surprises = 1),
                Box::new(|r| r.devices[1].check_surprises = 0),
            ),
            (
                "total went down",
                Box::new(|r| r.devices[1].totals_regressions = 1),
                Box::new(|r| r.devices[1].totals_regressions = 0),
            ),
        ];
        for (needle, above, at) in cases {
            let mut report = sample_passing();
            at(&mut report);
            assert!(evaluate(&report).pass, "{needle} at its limit");
            above(&mut report);
            let verdict = evaluate(&report);
            assert!(!verdict.pass, "{needle}");
            // Naming: a failure sentence carries the words of the needle that matter.
            let key = needle.split(' ').next().unwrap();
            assert!(
                verdict.failures.iter().any(|f| f.contains(key)),
                "{needle}: {:?}",
                verdict.failures
            );
        }
    }

    #[test]
    fn a_report_read_back_refuses_unknown_fields() {
        let report = sample_passing();
        let mut value = serde_json::to_value(&report).unwrap();
        value["token"] = serde_json::json!("x");
        assert!(serde_json::from_value::<Report>(value).is_err());
        let mut value = serde_json::to_value(&report).unwrap();
        value["resources"]["extra"] = serde_json::json!(1);
        assert!(serde_json::from_value::<Report>(value).is_err());
    }

    #[test]
    fn a_report_carries_no_secret_of_the_run() {
        let secrets: Vec<String> = [
            "pairing-code-ABCD-1234",
            "device-key-9f8e7d6c5b4a",
            "Bearer office-token-0011223344",
            "hunter2-password",
        ]
        .iter()
        .map(|s| (*s).to_owned())
        .collect();
        let mut report = sample_passing();
        // A host log may echo anything; a failing device may quote a request.
        report.log.first_errors = vec![format!("ERROR login {} {}", secrets[3], secrets[2])];
        report.devices[0].fatal = Some(format!("claim with {} failed", secrets[0]));
        report
            .checks
            .push(Check::new("x", false, format!("key {}", secrets[1])));
        report.errors.insert(format!("enter:{}", secrets[1]), 1);
        report.backups.push(BackupResult {
            at_fraction: 0.5,
            duration_ms: 1,
            file: format!("/tmp/{}/copy.db", secrets[0]),
            size_bytes: 1,
            scans_in_copy: 1,
            acked_before: 1,
            acked_after_with_slack: 1,
            checks: vec![],
        });
        report.verdict = evaluate(&report);
        let raw = serde_json::to_string(&report).unwrap();
        for secret in &secrets {
            // The messages name no secret: a failing assertion's text is a log of its own.
            assert!(
                raw.contains(secret.as_str()),
                "the probe must be able to see every planted secret"
            );
        }
        let clean = redact(&report, &secrets);
        let text = serde_json::to_string_pretty(&clean).unwrap() + &render_markdown(&clean);
        for secret in &secrets {
            assert!(!text.contains(secret.as_str()), "a planted secret leaked");
        }
        assert!(text.contains("[redacted]"));
        // The redaction changes nothing else.
        assert_eq!(clean.throughput, report.throughput);
        assert_eq!(clean.checks.len(), report.checks.len());
    }

    #[test]
    fn compare_does_not_flag_a_change_within_the_slack() {
        let old = sample_passing();
        let mut new = sample_passing();
        new.latency.get_mut("facts").unwrap().p99_ms = 40.0 * 1.5 + 19.0;
        new.throughput.scans_per_s = 28.0;
        new.resources.rss_max_mib = Some(60.0 * 1.25 + 15.0);
        new.resources.wal_backlog_max_frames = Some(900);
        assert!(compare(&old, &new).is_empty(), "{:?}", compare(&old, &new));
        new.resources.wal_backlog_max_frames = Some((900.0 * 1.5 + 1001.0) as u64);
        assert!(compare(&old, &new)
            .iter()
            .any(|r| r.0.contains("WAL backlog")));
    }

    fn scenario(name: &str, judged: bool, checks: Vec<Check>) -> ScenarioResult {
        ScenarioResult {
            name: name.to_owned(),
            judged,
            note: if judged {
                String::new()
            } else {
                "needs a spawned host".to_owned()
            },
            duration_ms: 1,
            checks,
            observed: BTreeMap::new(),
            latency: BTreeMap::new(),
            errors: BTreeMap::new(),
        }
    }

    #[test]
    fn a_failed_scenario_check_fails_the_verdict_and_an_unjudged_scenario_warns() {
        let mut report = sample_passing();
        report.scenarios.push(scenario(
            "line-full",
            true,
            vec![Check::new("entries_admitted", true, "ok")],
        ));
        report
            .scenarios
            .push(scenario("kill-restart", false, vec![]));
        let verdict = evaluate(&report);
        assert!(verdict.pass, "{verdict:?}");
        assert!(
            verdict
                .warnings
                .iter()
                .any(|w| w.contains("scenario kill-restart not judged") && w.contains("spawned")),
            "{:?}",
            verdict.warnings
        );
        report.scenarios[0].checks.push(Check::new(
            "refusal_names_the_limit",
            false,
            "expected Some(3), got Some(4)",
        ));
        let verdict = evaluate(&report);
        assert!(!verdict.pass);
        assert!(
            verdict.failures.iter().any(|f| f
                == "scenario line-full refusal_names_the_limit: expected Some(3), got Some(4)"),
            "{:?}",
            verdict.failures
        );
    }

    #[test]
    fn a_judged_scenario_without_a_check_fails() {
        let mut report = sample_passing();
        report.scenarios.push(scenario("lines", true, vec![]));
        let verdict = evaluate(&report);
        assert!(!verdict.pass);
        assert!(
            verdict
                .failures
                .iter()
                .any(|f| f.contains("scenario lines: no check ran")),
            "{:?}",
            verdict.failures
        );
    }

    #[test]
    fn a_report_of_schema_1_without_scenarios_still_reads() {
        assert_eq!(SCHEMA, 2);
        let mut value = serde_json::to_value(sample_passing()).unwrap();
        value.as_object_mut().unwrap().remove("scenarios");
        value["profile"]
            .as_object_mut()
            .unwrap()
            .remove("scenarios");
        value["schema"] = serde_json::json!(1);
        let back: Report = serde_json::from_value(value).unwrap();
        assert!(back.scenarios.is_empty());
        assert!(back.profile.scenarios.is_empty());
    }

    /// A real report written by the previous report format (schema 1, base 55359a671).
    #[test]
    fn a_real_report_file_of_schema_1_still_reads() {
        let text = include_str!("../tests/fixtures/report-schema-1.json");
        let back: Report = serde_json::from_str(text).expect("a schema-1 report reads");
        assert_eq!(back.schema, 1);
        assert!(back.scenarios.is_empty());
        assert!(back.profile.scenarios.is_empty());
        assert!(render_markdown(&back).contains("# Load run"));
    }

    #[test]
    fn the_markdown_lists_each_scenario_and_redaction_reaches_its_checks() {
        let mut report = sample_passing();
        report.scenarios.push(scenario(
            "line-full",
            true,
            vec![Check::new("x", false, "key SECRET-KEY-1")],
        ));
        report.scenarios.push(scenario("outage", false, vec![]));
        report.verdict = evaluate(&report);
        let text = render_markdown(&report);
        assert!(text.contains("## Scenarios"), "{text}");
        assert!(
            text.contains("- scenario line-full: FAILED (1 checks, 1 failed)"),
            "{text}"
        );
        assert!(
            text.contains("- scenario outage: not judged (needs a spawned host)"),
            "{text}"
        );
        // A judged scenario's note (a path this run did not exercise) is shown with its line.
        let mut held = scenario("close-races", true, vec![Check::new("x", true, "")]);
        held.note = "no race ran office-first this run.".to_owned();
        report.scenarios.push(held);
        let text = render_markdown(&report);
        assert!(
            text.contains(
                "- scenario close-races: held (1 checks); note: no race ran office-first this run."
            ),
            "{text}"
        );
        let clean = redact(&report, &["SECRET-KEY-1".to_owned()]);
        let all = serde_json::to_string(&clean).unwrap() + &render_markdown(&clean);
        assert!(
            !all.contains("SECRET-KEY-1"),
            "a scenario's check leaked a secret"
        );
    }

    #[test]
    fn redaction_covers_every_scenario_string_and_map_key() {
        let mut report = sample_passing();
        let mut s = scenario(
            "lines-SECRET-A",
            false,
            vec![Check::new("c-SECRET-B", true, "d SECRET-C")],
        );
        s.note = "note SECRET-D".to_owned();
        s.observed
            .insert("key-SECRET-E".to_owned(), serde_json::json!("v SECRET-F"));
        s.observed.insert(
            "nested".to_owned(),
            serde_json::json!({"k-SECRET-G": ["x SECRET-H"]}),
        );
        s.errors.insert("err SECRET-I".to_owned(), 2);
        s.latency.insert(
            "route SECRET-J".to_owned(),
            report
                .latency
                .values()
                .next()
                .cloned()
                .expect("a latency summary"),
        );
        report.scenarios.push(s);
        let secrets: Vec<String> = "ABCDEFGHIJ"
            .chars()
            .map(|c| format!("SECRET-{c}"))
            .collect();
        let clean = redact(&report, &secrets);
        let all = serde_json::to_string(&clean).unwrap();
        assert!(!all.contains("SECRET-"), "{all}");
        assert_eq!(clean.scenarios[0].errors.values().sum::<u64>(), 2);
        assert_eq!(clean.scenarios[0].checks.len(), 1);
    }

    #[test]
    fn the_wal_watch_warns_when_the_log_never_restarted_and_reads_back() {
        let mut report = sample_passing();
        report.wal_watch = Some(crate::wal_watch::WalWatch {
            every_ms: 100,
            points: 1800,
            readable_points: 1800,
            duration_s: 180.0,
            restarts: 0,
            ..Default::default()
        });
        let verdict = evaluate(&report);
        assert!(verdict.pass, "a WAL finding is a warning, not a failure");
        assert!(
            verdict
                .warnings
                .iter()
                .any(|w| w.contains("never started again")),
            "{:?}",
            verdict.warnings
        );
        report.wal_watch.as_mut().unwrap().restarts = 12;
        assert!(!evaluate(&report)
            .warnings
            .iter()
            .any(|w| w.contains("never started again")));
        let text = serde_json::to_string(&report).unwrap();
        let back: Report = serde_json::from_str(&text).unwrap();
        assert_eq!(back.wal_watch, report.wal_watch);
        let mut value = serde_json::to_value(&report).unwrap();
        value.as_object_mut().unwrap().remove("walWatch");
        let old: Report = serde_json::from_value(value).unwrap();
        assert!(old.wal_watch.is_none());
    }
}
