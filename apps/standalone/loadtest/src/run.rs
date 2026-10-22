//! A whole run: the host, the site, the devices, the load for the profile's
//! duration with a backup under it, the stop, the reconciliation against
//! what the host acknowledged, the closes, the drills, the last backup and
//! the restore, and the report with its verdict.

use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::Value;
use time::format_description::well_known::Rfc3339;
use tokio::sync::watch;

use crate::api::{pinned_client, Api};
use crate::checks::Check;
use crate::dbcheck;
use crate::device::{Shared, SimDevice};
use crate::drills;
use crate::host::Host;
use crate::metrics::Metrics;
use crate::probes;
use crate::profile::{Profile, Thresholds};
use crate::report::{
    evaluate, redact, summarize, BackupResult, Report, Throughput, Verdict, SCHEMA,
};
use crate::rng::Rng;
use crate::sampler;
use crate::scenarios::{self, HostKind};
use crate::secret::Redactions;
use crate::site::{provision, AttachCredentials, Office, Res};

pub enum HostChoice {
    InProcess,
    Spawn {
        bin: PathBuf,
    },
    Attach {
        base: String,
        fingerprint: String,
        data_dir: Option<PathBuf>,
        pid: Option<u32>,
        credentials: AttachCredentials,
    },
}

pub struct RunOptions {
    pub profile: Profile,
    pub thresholds: Thresholds,
    pub host: HostChoice,
    /// The folder the run keeps its data, host log and restore in.
    pub work_dir: PathBuf,
}

fn count_of(value: &Value, pointer: &str) -> Option<u64> {
    value.pointer(pointer).and_then(Value::as_u64)
}

async fn api_checks(
    devices: &[Arc<SimDevice>],
    office: &Office,
    shared: &Shared,
    shift: &str,
) -> Vec<Check> {
    let (expected, boxes_by_device, pallets_by_device, rejected, records) = {
        let ledger = shared.ledger.lock().expect("ledger");
        (
            ledger.expected(),
            ledger.boxes_closed.clone(),
            ledger.pallets_closed.clone(),
            ledger.rejected.clone(),
            ledger.records.values().sum::<u64>(),
        )
    };
    let mut checks = Vec::new();
    for device in devices {
        let index = device.spec.index;
        let Some(view) = device.view().await else {
            checks.push(Check::new(
                &format!("view_device_{index}"),
                false,
                "the shift is not in the device's list",
            ));
            continue;
        };
        checks.push(Check::same(
            &format!("totals_accepted_device_{index}"),
            Some(expected.distinct_accepted_codes),
            count_of(&view, "/totals/accepted"),
        ));
        checks.push(Check::same(
            &format!("totals_boxes_device_{index}"),
            Some(expected.boxes_closed),
            count_of(&view, "/totals/boxesClosed"),
        ));
        checks.push(Check::same(
            &format!("totals_pallets_device_{index}"),
            Some(expected.pallets_closed),
            count_of(&view, "/totals/pallets"),
        ));
        let parts = view
            .get("byDevice")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let sum: u64 = parts
            .iter()
            .filter_map(|part| count_of(part, "/accepted"))
            .sum();
        checks.push(Check::same(
            &format!("by_device_adds_up_device_{index}"),
            Some(sum),
            count_of(&view, "/totals/accepted"),
        ));
        for peer in devices {
            let part = parts
                .iter()
                .find(|part| part["deviceId"] == Value::String(peer.spec.id.clone()));
            let at = peer.spec.index;
            checks.push(Check::same(
                &format!("boxes_of_{at}_seen_by_{index}"),
                Some(boxes_by_device.get(&at).copied().unwrap_or(0)),
                part.and_then(|part| count_of(part, "/boxesClosed")),
            ));
            checks.push(Check::same(
                &format!("pallets_of_{at}_seen_by_{index}"),
                Some(pallets_by_device.get(&at).copied().unwrap_or(0)),
                part.and_then(|part| count_of(part, "/pallets")),
            ));
        }
        if index == 0 {
            let active = view
                .get("participants")
                .and_then(Value::as_array)
                .map(|parts| {
                    parts
                        .iter()
                        .filter(|part| part["state"] == "active")
                        .count()
                })
                .unwrap_or(0);
            checks.push(Check::same("participants_active", devices.len(), active));
        }
    }
    match office
        .ok("GET", &format!("/v1/office/shifts/{shift}"), None)
        .await
    {
        Ok(view) => {
            checks.push(Check::same(
                "office_units",
                Some(expected.distinct_accepted_codes),
                count_of(&view, "/totals/acceptedUnits"),
            ));
            checks.push(Check::same(
                "office_closed_boxes",
                Some(expected.boxes_closed),
                count_of(&view, "/totals/closedBoxes"),
            ));
            checks.push(Check::same(
                "office_closed_pallets",
                Some(expected.pallets_closed),
                count_of(&view, "/totals/closedPallets"),
            ));
        }
        Err(error) => checks.push(Check::new("office_view", false, error)),
    }
    let made: u64 = devices.iter().map(|device| device.records_made()).sum();
    checks.push(Check::same("every_record_acknowledged", made, records));
    // Every injected conflict must have happened: a duplicate sent without the
    // check is a `conflict`, an offered scan the other device took first is
    // a displacement (or, when the offering device came back too early, a conflict).
    let injected: u64 = devices
        .iter()
        .map(|device| {
            let stats = device.stats();
            stats.late_dups + stats.races_taken
        })
        .sum();
    let observed = expected.conflict_receipts + expected.displacements;
    checks.push(Check::new(
        "conflicts_injected_vs_observed",
        observed as f64 >= injected as f64 * 0.9 && observed <= injected,
        format!(
            "{injected} injected, {observed} observed ({} conflicts, {} displacements)",
            expected.conflict_receipts, expected.displacements
        ),
    ));
    checks.push(Check::same(
        "sscc_blocks_never_overlap",
        0,
        shared.overlaps.load(Ordering::SeqCst),
    ));
    checks.push(Check::new(
        "no_record_rejected",
        rejected.is_empty(),
        format!("{rejected:?}"),
    ));
    checks
}

fn device_ids(devices: &[Arc<SimDevice>]) -> Vec<(u32, String)> {
    devices
        .iter()
        .map(|device| (device.spec.index, device.spec.id.clone()))
        .collect()
}

/// The database tier, read from outside and read-only. With the ledger's
/// snapshot the devices are quiet and their parts still active: every
/// structural and reconciling check, and the participants `active`. Without
/// it the closes are done: the participants must be `closed`. A database that
/// cannot be read is a failed check, not an aborted run.
async fn database_checks(
    dir: &std::path::Path,
    shift: &str,
    ids: &[(u32, String)],
    ledger: Option<&crate::ledger::Snapshot>,
) -> Vec<Check> {
    let path = markiro_host::config::HostPaths::new(dir).database_file();
    let live = match dbcheck::open_read_only(&path, false).await {
        Ok(live) => live,
        Err(error) => return vec![Check::new("db_open", false, error)],
    };
    let mut checks = Vec::new();
    let mut add = |name: &str, made: Result<Vec<Check>, String>| match made {
        Ok(found) => checks.extend(found),
        Err(error) => checks.push(Check::new(name, false, error)),
    };
    match ledger {
        Some(ledger) => {
            add("db_structural", dbcheck::structural(&live).await);
            add(
                "db_reconcile",
                dbcheck::reconcile(&live, shift, ids, ledger).await,
            );
            add(
                "db_participants",
                dbcheck::participants(&live, shift, ids, "active").await,
            );
        }
        None => add(
            "db_participants",
            dbcheck::participants(&live, shift, ids, "closed").await,
        ),
    }
    live.close().await;
    checks
}

fn progress(started: Instant, shared: &Shared, devices: &[Arc<SimDevice>]) {
    let online = devices.iter().filter(|device| device.is_online()).count();
    let records: u64 = shared.ledger.lock().expect("ledger").records.values().sum();
    let facts = shared
        .metrics
        .latency()
        .get("facts")
        .map(|histogram| histogram.summary());
    eprintln!(
        "[{:>6.0} s] scans {} acknowledged {} online {}/{} facts p99 {:.0} ms",
        started.elapsed().as_secs_f64(),
        shared.generated.load(Ordering::SeqCst),
        records,
        online,
        devices.len(),
        facts.map_or(0.0, |summary| summary.p99_ms)
    );
}

/// The run, its report with every secret of the run removed.
pub async fn execute(options: RunOptions) -> Res<Report> {
    let (report, secrets) = execute_raw(options).await?;
    Ok(redact(&report, &secrets))
}

/// The run and the secrets it made or was given. The report is NOT
/// redacted: whoever writes it calls `report::redact` with the secrets
/// first (`cli::write_reports` does).
pub async fn execute_raw(options: RunOptions) -> Res<(Report, Redactions)> {
    let RunOptions {
        profile,
        thresholds,
        host: choice,
        work_dir,
    } = options;
    profile.validate()?;
    std::fs::create_dir_all(&work_dir)
        .map_err(|error| format!("{}: {error}", work_dir.display()))?;
    let started_at = time::OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_default();
    let metrics = Arc::new(Metrics::new());
    let data_dir = work_dir.join("data");
    let (mut host, kind, attach, scenario_host) = match choice {
        HostChoice::InProcess => (
            Host::in_process(&data_dir)
                .await
                .map_err(|e| e.to_string())?,
            "in-process",
            None,
            HostKind::InProcess,
        ),
        HostChoice::Spawn { bin } => (
            Host::spawned(&bin, &data_dir, &work_dir.join("host-stdout.log"))
                .await
                .map_err(|e| e.to_string())?,
            "spawn",
            None,
            HostKind::Spawn { bin },
        ),
        HostChoice::Attach {
            base,
            fingerprint,
            data_dir,
            pid,
            credentials,
        } => (
            Host::attached(&base, &fingerprint, data_dir, pid),
            "attach",
            Some(credentials),
            HostKind::Attach,
        ),
    };
    let hello = pinned_client(&host.fingerprint, Duration::from_secs(5))
        .get(format!("{}/v1/hello", host.base))
        .send()
        .await;
    let hello = match hello {
        Ok(response) => response.json::<Value>().await.map_err(|e| e.to_string()),
        Err(error) => Err(error.to_string()),
    };
    let hello = match hello {
        Ok(hello) => hello,
        Err(error) => {
            host.stop().await.ok();
            return Err(format!("hello: {error}"));
        }
    };
    let (site, shift) = match provision(&host, metrics.clone(), &profile, attach).await {
        Ok(made) => made,
        Err(error) => {
            host.stop().await.ok();
            return Err(error);
        }
    };
    let run_id = (profile.seed % 0xF000) as u32 + 1;
    let shared = Arc::new(Shared::new(
        profile.clone(),
        run_id,
        &shift.id,
        &shift.issuer_prefix,
        metrics.clone(),
    ));
    let devices: Vec<Arc<SimDevice>> = site
        .devices
        .iter()
        .map(|spec| {
            SimDevice::new(
                spec.clone(),
                Api::new(&host.base, &host.fingerprint, metrics.clone()),
                shared.clone(),
            )
        })
        .collect();
    let started = Instant::now();
    let (sampler_stop, sampler_watch) = watch::channel(false);
    let wal_task = host.data_dir.clone().map(|dir| {
        tokio::spawn(crate::wal_watch::run(
            dir,
            crate::wal_watch::EVERY,
            sampler_watch.clone(),
        ))
    });
    let sampler = tokio::spawn(sampler::run(
        host.data_dir.clone(),
        host.pid,
        Duration::from_secs(profile.sample_s),
        sampler_watch,
    ));
    let (mut scanners, mut links, mut streams, mut syncers) =
        (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    for device in &devices {
        scanners.push(tokio::spawn(device.clone().scanner()));
        links.push(tokio::spawn(device.clone().link()));
        streams.push(tokio::spawn(device.clone().stream()));
        syncers.push(tokio::spawn(device.clone().syncer()));
    }
    let backups = {
        let (office, shared, dir) = (site.office.clone(), shared.clone(), host.data_dir.clone());
        let fractions = profile.backup_at.clone();
        let duration = profile.duration_s as f64;
        tokio::spawn(async move {
            let mut done: Vec<BackupResult> = Vec::new();
            let Some(dir) = dir else { return done };
            for fraction in fractions {
                tokio::time::sleep_until(tokio::time::Instant::from_std(
                    started + Duration::from_secs_f64(duration * fraction),
                ))
                .await;
                match probes::backup(&office, &dir, &shared, fraction, 0).await {
                    Ok((result, _)) => done.push(result),
                    Err(error) => done.push(BackupResult {
                        at_fraction: fraction,
                        duration_ms: 0,
                        file: String::new(),
                        size_bytes: 0,
                        scans_in_copy: -1,
                        acked_before: 0,
                        acked_after_with_slack: 0,
                        checks: vec![Check::new("backup_ran", false, error)],
                    }),
                }
            }
            done
        })
    };
    let end = started + Duration::from_secs(profile.duration_s);
    while Instant::now() < end {
        tokio::time::sleep((end - Instant::now()).min(Duration::from_secs(30))).await;
        progress(started, &shared, &devices);
    }
    // The end of the load: the scanners stop, the links come back, the outboxes drain.
    shared.stop.store(true, Ordering::SeqCst);
    for task in scanners.into_iter().chain(links).chain(streams) {
        let _ = task.await;
    }
    for device in &devices {
        device.quiesce();
    }
    let mut checks = Vec::new();
    for (index, task) in syncers.into_iter().enumerate() {
        let outcome = task
            .await
            .map_err(|error| error.to_string())
            .and_then(|result| result);
        checks.push(Check::new(
            &format!("device_{index}_drained"),
            outcome.is_ok(),
            format!("{outcome:?}"),
        ));
    }
    let backups = backups.await.unwrap_or_default();
    let load_ended = started.elapsed().as_secs_f64();
    // Reconcile while the shift is still open and the devices are quiet.
    checks.extend(api_checks(&devices, &site.office, &shared, &shift.id).await);
    if let Some(dir) = &host.data_dir {
        let ids = device_ids(&devices);
        let ledger = shared.ledger.lock().expect("ledger").snapshot();
        checks.extend(database_checks(dir, &shift.id, &ids, Some(&ledger)).await);
    }
    // The closes, in the profile's order.
    let mut rng = Rng::new(profile.seed ^ 0xC10);
    let order = drills::closing_order(&site.devices, profile.close_order, &mut rng);
    for (position, at) in order.iter().enumerate() {
        let last = position + 1 == order.len();
        match devices[*at].close_part(None, None).await {
            Ok(receipt) => {
                let part_only = receipt.pointer("/details/partClosed") == Some(&Value::Bool(true));
                checks.push(Check::same(
                    &format!("close_{position}_closes_only_the_part"),
                    !last,
                    part_only,
                ));
            }
            Err(error) => checks.push(Check::new(&format!("close_{position}"), false, error)),
        }
    }
    match site
        .office
        .ok("GET", &format!("/v1/office/shifts/{}", shift.id), None)
        .await
    {
        Ok(view) => checks.push(Check::same(
            "shift_closed_by_its_last_part",
            "closed",
            view["status"].as_str().unwrap_or(""),
        )),
        Err(error) => checks.push(Check::new("shift_closed_by_its_last_part", false, error)),
    }
    // The device list names the closed shift with its participants and this device's state, but
    // without live figures (host `35020185a`: totals for active shifts only).
    match devices[0].view().await {
        Some(view) => {
            checks.push(Check::same(
                "closed_shift_list_my_state",
                "closed",
                view["myState"].as_str().unwrap_or(""),
            ));
            checks.push(Check::same(
                "closed_shift_list_carries_no_totals",
                true,
                view.get("totals").is_none() && view.get("byDevice").is_none(),
            ));
        }
        None => checks.push(Check::new(
            "closed_shift_in_the_list",
            false,
            "the closed shift is not in the device's list",
        )),
    }
    // After the closes the ledger says every part is closed: so does the host database.
    if let Some(dir) = &host.data_dir {
        let ids = device_ids(&devices);
        checks.extend(database_checks(dir, &shift.id, &ids, None).await);
    }
    let drills = drills::run_all(&site, &profile, run_id).await;
    // The last copy, then the host stops and the copy is put back.
    let mut backups = backups;
    let mut last_copy = None;
    if let Some(dir) = host.data_dir.clone() {
        match probes::backup(
            &site.office,
            &dir,
            &shared,
            1.0,
            drills::scans_made(&profile, site.devices.len()),
        )
        .await
        {
            Ok((result, path)) => {
                last_copy = (!result.file.is_empty()).then_some(path);
                backups.push(result);
            }
            Err(error) => checks.push(Check::new("last_backup", false, error)),
        }
    }
    sampler_stop.send_replace(true);
    let series = sampler.await.unwrap_or_default();
    let wal_points = match wal_task {
        Some(task) => task.await.unwrap_or_default(),
        None => Vec::new(),
    };
    let wal_watch = (!wal_points.is_empty()).then(|| {
        crate::wal_watch::summarize(&wal_points, crate::wal_watch::EVERY.as_millis() as u64)
    });
    let graceful = match host.stop().await {
        Ok(graceful) => (kind == "spawn" && cfg!(unix)).then_some(graceful),
        Err(error) => {
            checks.push(Check::new("host_stop", false, error.to_string()));
            None
        }
    };
    let restore = match (&host.data_dir, last_copy) {
        (Some(dir), Some(copy)) if kind != "attach" => {
            let expected = shared
                .ledger
                .lock()
                .expect("ledger")
                .expected()
                .distinct_accepted_codes;
            Some(
                probes::restore_roundtrip(
                    dir,
                    &copy,
                    &work_dir,
                    site.devices[0].key.expose(),
                    &shift.id,
                    expected,
                    metrics.clone(),
                )
                .await
                .unwrap_or_else(|error| crate::report::RestoreResult {
                    copy: copy.display().to_string(),
                    counts: Default::default(),
                    checks: vec![Check::new("restore_ran", false, error)],
                }),
            )
        }
        _ => None,
    };
    // The scenarios, each on a fresh host of the same mode: the main host is stopped by now and
    // nothing of theirs reaches the main run's metrics, series or log.
    let (scenario_results, scenario_redactions) =
        scenarios::run_all(&scenario_host, &work_dir, &profile).await;
    let latency = metrics
        .latency()
        .into_iter()
        .map(|(route, histogram)| (route.to_owned(), histogram.summary()))
        .collect();
    let (expected, records_acked) = {
        let ledger = shared.ledger.lock().expect("ledger");
        (ledger.expected(), ledger.records.values().sum::<u64>())
    };
    let generated = shared.generated.load(Ordering::SeqCst);
    let mut report = Report {
        schema: SCHEMA,
        started_at,
        host_kind: kind.to_owned(),
        host_version: hello["version"].as_str().unwrap_or("?").to_owned(),
        host_protocol: hello["protocol"].as_u64().unwrap_or(0),
        os: std::env::consts::OS.to_owned(),
        thresholds,
        latency,
        errors: metrics.errors(),
        throughput: Throughput {
            scans_generated: generated,
            scans_per_s: generated as f64 / profile.duration_s as f64,
            ideal_scans: profile.ideal_scans(),
            generated_share: generated as f64 / profile.ideal_scans(),
            records_acked,
            duration_s: load_ended,
        },
        devices: devices.iter().map(|device| device.stats()).collect(),
        expected,
        resources: summarize(
            &series,
            (profile.duration_s as f64 * 0.1).max(30.0).min(load_ended),
        ),
        checks,
        drills,
        backups,
        restore,
        scenarios: scenario_results,
        wal_watch,
        log: host.log_scan(),
        graceful_stop: graceful,
        verdict: Verdict::default(),
        series,
        profile,
    };
    report.verdict = evaluate(&report);
    let mut redactions = site.redactions.clone();
    redactions.extend(scenario_redactions);
    Ok((report, redactions))
}
