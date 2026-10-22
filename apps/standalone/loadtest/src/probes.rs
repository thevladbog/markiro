//! The two probes of the host's own safety nets: a copy made while the
//! devices work, and a restore that brings the whole database back.

use std::path::Path;
use std::time::{Duration, Instant};

use markiro_host::config::HostPaths;
use markiro_host::restore::{restore_now, IdentityChoice, RestoreOptions};
use serde_json::Value;

use crate::api::{Api, Auth};
use crate::checks::Check;
use crate::dbcheck;
use crate::device::Shared;
use crate::host::Host;
use crate::metrics::Route;
use crate::report::{BackupResult, RestoreResult};
use crate::site::{Office, Res};

const BACKUP_WAIT: Duration = Duration::from_secs(180);

fn copies_of(state: &Value) -> Vec<(String, String, u64)> {
    state
        .pointer("/local/copies")
        .and_then(Value::as_array)
        .map(|copies| {
            copies
                .iter()
                .filter_map(|copy| {
                    Some((
                        copy.get("file")?.as_str()?.to_owned(),
                        copy.get("createdAt")?.as_str()?.to_owned(),
                        copy.get("sizeBytes")?.as_u64()?,
                    ))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Ask for a copy now, wait for it, open it and judge it. While it runs the
/// facts route is also counted apart (`facts_during_backup`). Returns the
/// result and the copy's path. `outside_the_ledger` is the scans the harness
/// made that the ledger does not hold (the drills'): the copy may hold them.
pub async fn backup(
    office: &Office,
    data_dir: &Path,
    shared: &Shared,
    at_fraction: f64,
    outside_the_ledger: u64,
) -> Res<(BackupResult, std::path::PathBuf)> {
    let known: Vec<String> = copies_of(&office.ok("GET", "/v1/office/backups", None).await?)
        .into_iter()
        .map(|(file, _, _)| file)
        .collect();
    let scans = |shared: &Shared| {
        shared
            .ledger
            .lock()
            .expect("ledger")
            .scan_rows
            .values()
            .sum::<u64>()
    };
    let acked_before = scans(shared);
    shared.metrics.set_backup_running(true);
    let began = Instant::now();
    let asked = office.call("POST", "/v1/office/backups", None).await;
    let mut checks = Vec::new();
    let mut found = None;
    match &asked {
        Ok(reply) if reply.status == 202 => {
            checks.push(Check::same("backup_accepted", 202u16, reply.status));
            while began.elapsed() < BACKUP_WAIT {
                tokio::time::sleep(Duration::from_millis(250)).await;
                let Ok(state) = office.ok("GET", "/v1/office/backups", None).await else {
                    continue;
                };
                let fresh = copies_of(&state)
                    .into_iter()
                    .find(|(file, _, _)| !known.contains(file));
                if state.get("running").map_or(true, Value::is_null) && fresh.is_some() {
                    found = fresh;
                    break;
                }
            }
        }
        Ok(reply) => checks.push(Check::new(
            "backup_accepted",
            false,
            format!("{} {}", reply.status, reply.body),
        )),
        Err(error) => checks.push(Check::new("backup_accepted", false, error.clone())),
    }
    shared.metrics.set_backup_running(false);
    let duration_ms = began.elapsed().as_millis() as u64;
    let slack = u64::from(shared.profile.devices()) * shared.profile.batch_max as u64;
    let acked_after = scans(shared) + slack + outside_the_ledger;
    let Some((file, _, size_bytes)) = found else {
        checks.push(Check::new(
            "backup_completed",
            false,
            format!("no copy in {} s", BACKUP_WAIT.as_secs()),
        ));
        return Ok((
            BackupResult {
                at_fraction,
                duration_ms,
                file: String::new(),
                size_bytes: 0,
                scans_in_copy: -1,
                acked_before,
                acked_after_with_slack: acked_after,
                checks,
            },
            std::path::PathBuf::new(),
        ));
    };
    checks.push(Check::new(
        "backup_completed",
        true,
        format!("{duration_ms} ms"),
    ));
    let path = HostPaths::new(data_dir).backups_dir().join(&file);
    let pool = dbcheck::open_read_only(&path, true).await?;
    checks.extend(dbcheck::structural(&pool).await?);
    let in_copy = dbcheck::scan_count(&pool).await?;
    pool.close().await;
    // Everything acknowledged before the copy was asked for is in it, and
    // nothing the devices had not sent by the time it was done.
    checks.push(Check::new(
        "backup_scans_between_the_acknowledged_and_the_sent",
        (acked_before as i64..=acked_after as i64).contains(&in_copy),
        format!("{in_copy} scans in the copy, between {acked_before} and {acked_after}"),
    ));
    Ok((
        BackupResult {
            at_fraction,
            duration_ms,
            file,
            size_bytes,
            scans_in_copy: in_copy,
            acked_before,
            acked_after_with_slack: acked_after,
            checks,
        },
        path,
    ))
}

/// Put `copy` into a folder of its own, compare it with the live database
/// (the host is stopped: nothing writes to either) and start a host on it
/// that answers the shift's total to a device whose key the copy kept. The
/// run's shift is closed by then, and the device list carries no figures for
/// a closed shift (host `35020185a`): the total is read from the one-shift
/// answer of a leave with no body, which carries them for any non-planned
/// status and writes nothing for a closed shift.
pub async fn restore_roundtrip(
    live_dir: &Path,
    copy: &Path,
    work: &Path,
    device_key: &str,
    shift_id: &str,
    expected_total: u64,
    metrics: std::sync::Arc<crate::metrics::Metrics>,
) -> Res<RestoreResult> {
    let live = dbcheck::open_read_only(&HostPaths::new(live_dir).database_file(), false).await?;
    let live_counts = dbcheck::table_counts(&live).await?;
    live.close().await;
    let restored_dir = work.join("restored");
    let report = restore_now(
        &HostPaths::new(&restored_dir),
        copy,
        RestoreOptions {
            without_manifest: false,
            identity: IdentityChoice::Auto,
        },
    )
    .await;
    let mut checks = vec![Check::new(
        "restore_done",
        report.is_ok(),
        format!("{:?}", report.as_ref().err().map(ToString::to_string)),
    )];
    if report.is_err() {
        return Ok(RestoreResult {
            copy: copy.display().to_string(),
            counts: live_counts,
            checks,
        });
    }
    let restored =
        dbcheck::open_read_only(&HostPaths::new(&restored_dir).database_file(), true).await?;
    let restored_counts = dbcheck::table_counts(&restored).await?;
    restored.close().await;
    for (table, count) in &live_counts {
        checks.push(Check::same(
            &format!("restore_rows_{table}"),
            *count,
            restored_counts[table],
        ));
    }
    let mut host = Host::in_process(&restored_dir)
        .await
        .map_err(|error| error.to_string())?;
    let api = Api::new(&host.base, &host.fingerprint, metrics);
    let reply = api
        .send(
            Route::Other,
            "POST",
            &format!("/v1/device/shifts/{shift_id}/leave"),
            Auth {
                device_key: Some(device_key),
                session: None,
            },
            None,
        )
        .await;
    let total = reply.ok().and_then(|reply| {
        (reply.body["id"] == serde_json::json!(shift_id))
            .then(|| {
                reply
                    .body
                    .pointer("/totals/accepted")
                    .and_then(Value::as_u64)
            })
            .flatten()
    });
    checks.push(Check::new(
        "restore_host_answers_the_shift_total",
        total == Some(expected_total),
        format!("expected {expected_total}, got {total:?}"),
    ));
    host.stop().await.map_err(|error| error.to_string())?;
    Ok(RestoreResult {
        copy: copy.display().to_string(),
        counts: live_counts,
        checks,
    })
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::Ordering;
    use std::sync::Arc;

    use serde_json::json;

    use crate::device::SimDevice;
    use crate::drills;
    use crate::profile::Profile;

    use super::*;

    /// The whole of both probes and the six drills against a real host in this
    /// process: a copy under load, the drills, a last copy, a restore.
    #[tokio::test]
    async fn a_copy_under_load_the_drills_and_a_restore_all_judge_clean() {
        let mut profile = Profile::preset("tiny").unwrap();
        profile.scan_rate = 15.0;
        profile.mean_online_s = 3.0;
        profile.mean_offline_s = 1.0;
        profile.flush_ms = 150;
        profile.totals_poll_s = 1.0;
        let dir = tempfile::tempdir().unwrap();
        let mut host = Host::in_process(dir.path()).await.unwrap();
        let metrics = Arc::new(crate::metrics::Metrics::new());
        let (site, _) = crate::site::provision(&host, metrics.clone(), &profile, None)
            .await
            .unwrap();
        let shift = crate::site::plan_and_enter(&site, &profile, None)
            .await
            .unwrap();
        let shared = Arc::new(Shared::new(
            profile.clone(),
            1,
            &shift.id,
            &shift.issuer_prefix,
            metrics.clone(),
        ));
        let mut devices = Vec::new();
        for spec in &site.devices {
            let api = Api::new(&host.base, &host.fingerprint, metrics.clone());
            devices.push(SimDevice::new(spec.clone(), api, shared.clone()));
        }
        let mut front = Vec::new();
        let mut syncers = Vec::new();
        for device in &devices {
            front.push(tokio::spawn(device.clone().scanner()));
            front.push(tokio::spawn(device.clone().link()));
            front.push(tokio::spawn(device.clone().stream()));
            syncers.push(tokio::spawn(device.clone().syncer()));
        }
        tokio::time::sleep(Duration::from_secs(4)).await;
        let (mid, _) = backup(&site.office, dir.path(), &shared, 0.5, 0)
            .await
            .unwrap();
        eprintln!("OBSERVED mid backup {mid:?}");
        for check in &mid.checks {
            assert!(check.ok, "{check:?}");
        }
        assert!(mid.scans_in_copy > 0);
        tokio::time::sleep(Duration::from_secs(2)).await;
        shared.stop.store(true, Ordering::SeqCst);
        for task in front {
            task.await.unwrap();
        }
        for device in &devices {
            device.quiesce();
        }
        for syncer in syncers {
            syncer.await.unwrap().expect("a device finishes");
        }
        // The run's shift is closed by the office, then the drills run.
        let office = site
            .office
            .ok("GET", &format!("/v1/office/shifts/{}", shift.id), None)
            .await
            .unwrap();
        let expected_total = office
            .pointer("/totals/acceptedUnits")
            .and_then(Value::as_u64)
            .unwrap();
        site.office
            .ok(
                "POST",
                &format!("/v1/office/shifts/{}/close", shift.id),
                Some(json!({ "reason": "self-test", "expectedRev": office["rev"] })),
            )
            .await
            .unwrap();
        let drilled = drills::run_all(&site, &profile, 1).await;
        for drill in &drilled {
            eprintln!("OBSERVED drill {} {:?}", drill.name, drill.checks);
            for check in &drill.checks {
                assert!(check.ok, "{}: {check:?}", drill.name);
            }
        }
        assert_eq!(drilled.len(), 6);
        let outside = drills::scans_made(&profile, site.devices.len());
        let (last, copy) = backup(&site.office, dir.path(), &shared, 1.0, outside)
            .await
            .unwrap();
        eprintln!("OBSERVED last backup {last:?}");
        for check in &last.checks {
            assert!(check.ok, "{check:?}");
        }
        host.stop().await.unwrap();
        let work = tempfile::tempdir().unwrap();
        let restored = restore_roundtrip(
            dir.path(),
            &copy,
            work.path(),
            site.devices[0].key.expose(),
            &shift.id,
            expected_total,
            metrics.clone(),
        )
        .await
        .unwrap();
        eprintln!("OBSERVED restore {restored:?}");
        for check in &restored.checks {
            assert!(check.ok, "{check:?}");
        }
        assert!(restored.checks.len() > 5);
    }
}
