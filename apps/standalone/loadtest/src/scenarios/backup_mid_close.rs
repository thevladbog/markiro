//! `backup-mid-close`: a copy asked for while six parts close one after another is a consistent
//! snapshot of the closes (the backup worker's `VACUUM INTO` on its own connection, one read
//! transaction of a WAL database); restored, it passes the same checks and a host on it answers
//! the same states. A last copy at rest restores whole. Which close the snapshot fell between is
//! timing, recorded and never judged.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use markiro_host::config::HostPaths;
use markiro_host::restore::{restore_now, IdentityChoice, RestoreOptions};
use serde_json::{json, Value};
use sqlx::SqlitePool;

use super::{enter_all, part_closed, prefixed, Ctx, HostKind, Res, LOAD_S};
use crate::checks::Check;
use crate::dbcheck;
use crate::device::SimDevice;
use crate::host::Host;
use crate::metrics::Route;
use crate::profile::Profile;
use crate::report::ScenarioResult;

pub const NAME: &str = "backup-mid-close";
/// The line's limit: the four stations and the two handhelds (a wizard line allows one).
const LIMIT: u32 = 6;

pub async fn run(
    kind: &HostKind,
    work_dir: &Path,
    base: &Profile,
) -> (ScenarioResult, Vec<String>) {
    // Restoring a copy the backup worker may still hold (`os error 32`) is unverified on Windows.
    if cfg!(windows) {
        return (
            super::not_judged(
                NAME,
                "windows: restoring a copy the backup worker may hold (os error 32) is unverified",
            ),
            Vec::new(),
        );
    }
    let mut ctx = match Ctx::new(NAME, kind, work_dir, base, 4, 2).await {
        Ok(ctx) => ctx,
        Err(error) => return (super::broken(NAME, error), Vec::new()),
    };
    let outcome = body(&mut ctx).await;
    ctx.finish(outcome).await
}

/// The devices whose close the copy holds as an accepted close event of `shift`.
async fn devices_with_a_close_event(pool: &SqlitePool, shift: &str) -> Res<BTreeSet<String>> {
    let rows: Vec<String> = sqlx::query_scalar(
        "SELECT device_id FROM shift_close_events WHERE shift_id = ? AND outcome = 'accepted'",
    )
    .bind(shift)
    .fetch_all(pool)
    .await
    .map_err(|error| format!("shift_close_events: {error}"))?;
    Ok(rows.into_iter().collect())
}

/// What a copy of the database says of `shift`'s parts, and the rules any consistent snapshot of
/// the closes obeys: every part `active` or `closed`, the closed ones exactly the devices that
/// have an accepted close event in the same copy, and the participant invariants.
async fn judge_copy(
    ctx: &mut Ctx,
    prefix: &str,
    db: &Path,
    shift: &str,
    devices: usize,
) -> Res<BTreeMap<String, String>> {
    let pool = dbcheck::open_read_only(db, true).await?;
    let states = dbcheck::participant_states(&pool, shift).await;
    let events = devices_with_a_close_event(&pool, shift).await;
    let invariants = dbcheck::participant_invariants(&pool, shift).await;
    pool.close().await;
    let states = states?;
    ctx.check(Check::new(
        &format!("{prefix}states_are_active_or_closed"),
        states.len() == devices
            && states
                .values()
                .all(|state| state == "active" || state == "closed"),
        format!("{states:?}"),
    ));
    let closed: BTreeSet<String> = states
        .iter()
        .filter(|(_, state)| *state == "closed")
        .map(|(id, _)| id.clone())
        .collect();
    match events {
        Ok(events) => ctx.check(Check::new(
            &format!("{prefix}closed_parts_are_the_close_events"),
            closed == events,
            format!("closed parts {closed:?}, accepted close events {events:?}"),
        )),
        Err(error) => ctx.check(Check::new(
            &format!("{prefix}closed_parts_are_the_close_events"),
            false,
            error,
        )),
    }
    match invariants {
        Ok(checks) => ctx.checks(prefixed(prefix, checks)),
        Err(error) => ctx.check(Check::new(&format!("{prefix}db_invariants"), false, error)),
    }
    Ok(states)
}

async fn body(ctx: &mut Ctx) -> Res<()> {
    let line = ctx.site.line_ids[0].clone();
    // A wizard line allows one device: the line takes all six.
    let set = ctx.set_max_stations(&line, LIMIT).await?;
    ctx.same("limit_set", 200u16, set.status);
    let shift = ctx.plan(&line, None).await?;
    let all: Vec<usize> = (0..ctx.site.devices.len()).collect();
    let prefix = enter_all(ctx, &shift, &all).await?;
    let work = ctx.load(1, &shift, &prefix, &all);
    tokio::time::sleep(Duration::from_secs(LOAD_S)).await;
    for device in &work.devices {
        device.seal(Duration::from_secs(60)).await?;
    }
    let data_dir = ctx
        .host
        .data_dir
        .clone()
        .ok_or("the scenario host has no data folder")?;
    // The closes go out one after another while a copy is asked for.
    let closers: Vec<Arc<SimDevice>> = work.devices.clone();
    let closing = tokio::spawn(async move {
        let mut receipts = Vec::new();
        for device in closers {
            receipts.push(device.close_part_ledgered(None, None, None).await);
            tokio::time::sleep(Duration::from_millis(40)).await;
        }
        receipts
    });
    let copy = crate::probes::backup(&ctx.site.office, &data_dir, &work.shared, 0.5, 0).await;
    let receipts: Vec<Value> = closing
        .await
        .map_err(|error| error.to_string())?
        .into_iter()
        .collect::<Res<Vec<Value>>>()?;
    ctx.same(
        "exactly_one_close_closes_the_shift",
        1usize,
        receipts
            .iter()
            .filter(|receipt| receipt["outcome"] == "accepted" && !part_closed(receipt))
            .count(),
    );
    let (result, path) = copy?;
    ctx.checks(prefixed("copy_", result.checks.clone()));
    if !result.file.is_empty() {
        let states = judge_copy(ctx, "copy_", &path, &shift, work.devices.len()).await?;
        let closed = states.values().filter(|state| *state == "closed").count();
        ctx.observe("partsClosedInTheCopy", json!(closed));
        // The copy restored into a folder of its own, and a host started on it.
        let restored = ctx.dir.join("restored-mid-close");
        let done = match restore_now(
            &HostPaths::new(&restored),
            &path,
            RestoreOptions {
                without_manifest: false,
                identity: IdentityChoice::Auto,
            },
        )
        .await
        {
            Ok(_) => Ok(()),
            Err(error) => Err(error.to_string()),
        };
        ctx.check(Check::new(
            "mid_close_copy_restores",
            done.is_ok(),
            format!("{done:?}"),
        ));
        if done.is_ok() {
            let again = judge_copy(
                ctx,
                "restored_",
                &HostPaths::new(&restored).database_file(),
                &shift,
                work.devices.len(),
            )
            .await?;
            ctx.same("restored_states_are_the_copys", states, again.clone());
            let mut host = Host::in_process(&restored)
                .await
                .map_err(|error| error.to_string())?;
            let api = crate::api::Api::new(&host.base, &host.fingerprint, ctx.metrics.clone());
            let device = ctx.device(0);
            let listed = api
                .send(
                    Route::Other,
                    "GET",
                    "/v1/device/shifts",
                    crate::api::Auth {
                        device_key: Some(&device.key),
                        session: None,
                    },
                    None,
                )
                .await;
            host.stop().await.map_err(|error| error.to_string())?;
            let answered: BTreeMap<String, String> = listed
                .ok()
                .and_then(|reply| {
                    reply.body["shifts"]
                        .as_array()
                        .and_then(|all| all.iter().find(|item| item["id"] == json!(shift)).cloned())
                })
                .map(|seen| super::states(&seen))
                .unwrap_or_default();
            ctx.same(
                "restored_host_answers_the_copys_participant_states",
                again,
                answered,
            );
        }
    }
    let (shared, devices, drained) = work.stop("").await;
    ctx.checks(drained);
    let found = super::reconcile(ctx, "", &shift, &shared, &devices).await;
    ctx.checks(found);
    // A last copy at rest, restored whole.
    let expected = shared
        .ledger
        .lock()
        .expect("ledger")
        .expected()
        .distinct_accepted_codes;
    let (last, last_path) =
        crate::probes::backup(&ctx.site.office, &data_dir, &shared, 1.0, 0).await?;
    ctx.checks(prefixed("last_copy_", last.checks.clone()));
    ctx.host.stop().await.map_err(|error| error.to_string())?;
    if !last.file.is_empty() {
        let key = ctx.device(0).key;
        let restored = crate::probes::restore_roundtrip(
            &data_dir,
            &last_path,
            &ctx.dir,
            &key,
            &shift,
            expected,
            ctx.metrics.clone(),
        )
        .await?;
        ctx.checks(prefixed("restore_", restored.checks));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Restoring a copy the backup worker may still hold (`os error 32`) is unverified on Windows
    // (runbook §14).
    #[cfg_attr(
        windows,
        ignore = "os error 32 on a held copy is unverified on Windows"
    )]
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn the_backup_mid_close_scenario_holds_against_a_host_in_this_process() {
        let work = tempfile::tempdir().unwrap();
        let profile = Profile::preset("tiny").unwrap();
        let (result, _) = run(&HostKind::InProcess, work.path(), &profile).await;
        for check in &result.checks {
            eprintln!("OBSERVED {} {} {}", check.name, check.ok, check.detail);
        }
        eprintln!("OBSERVED {:?}", result.observed);
        assert!(result.judged);
        assert!(
            result.checks.iter().all(|check| check.ok),
            "{:#?}",
            result.checks
        );
        for name in [
            "exactly_one_close_closes_the_shift",
            "copy_backup_scans_between_the_acknowledged_and_the_sent",
            "copy_states_are_active_or_closed",
            "copy_closed_shift_has_no_open_part",
            "copy_db_integrity",
            "mid_close_copy_restores",
            "restored_states_are_the_copys",
            "restored_host_answers_the_copys_participant_states",
            "restore_restore_rows_scans",
            "restore_restore_host_answers_the_shift_total",
        ] {
            assert!(
                result.checks.iter().any(|check| check.name == name),
                "no check {name}"
            );
        }
        assert!(result.observed.contains_key("partsClosedInTheCopy"));
    }
}
