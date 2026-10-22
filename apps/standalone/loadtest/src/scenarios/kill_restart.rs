//! `kill-restart`: a spawned host killed (`SIGKILL`) while devices write, restarted on the same
//! data folder and port. SQLite recovers its log; no acknowledged record is lost; the devices'
//! resends of batches they never had answered get the stored receipts and write nothing twice.
//! A kill is a process crash, not a power cut (`synchronous=FULL` keeps what was committed
//! either way); a power cut is not simulated.

use std::collections::BTreeMap;
use std::path::Path;
use std::time::Duration;

use serde_json::json;

use super::{enter_all, part_closed, prefixed, Ctx, HostKind, Res, LOAD_S};
use crate::checks::Check;
use crate::profile::Profile;
use crate::report::ScenarioResult;

pub const NAME: &str = "kill-restart";

pub async fn run(
    kind: &HostKind,
    work_dir: &Path,
    base: &Profile,
) -> (ScenarioResult, Vec<String>) {
    let HostKind::Spawn { bin } = kind else {
        return (
            super::not_judged(
                NAME,
                "needs a host this harness spawned (--host spawn): a host in this process or an attached one cannot be killed and restarted",
            ),
            Vec::new(),
        );
    };
    let mut ctx = match Ctx::new(NAME, kind, work_dir, base, 3, 1).await {
        Ok(ctx) => ctx,
        Err(error) => return (super::broken(NAME, error), Vec::new()),
    };
    ctx.faults = true;
    let outcome = body(&mut ctx, bin).await;
    ctx.finish(outcome).await
}

async fn body(ctx: &mut Ctx, bin: &Path) -> Res<()> {
    let line = ctx.site.line_ids[0].clone();
    let shift = ctx.plan(&line, None).await?;
    let all = [0usize, 1, 2, 3];
    let prefix = enter_all(ctx, &shift, &all).await?;
    let work = ctx.load(1, &shift, &prefix, &all);
    tokio::time::sleep(Duration::from_secs(LOAD_S)).await;
    let data_dir = ctx
        .host
        .data_dir
        .clone()
        .ok_or("the scenario host has no data folder")?;
    let at_kill = crate::sampler::take(0.0, Some(data_dir.as_path()), None);
    let running = ctx.host.kill_hard().map_err(|error| error.to_string())?;
    ctx.same("the_host_was_running_when_killed", true, running);
    ctx.observe("walBacklogAtKill", json!(at_kill.wal_backlog_frames));
    ctx.observe("walBytesAtKill", json!(at_kill.wal_bytes));
    for device in &work.devices {
        device.set_online(false);
    }
    // The requests in flight at the kill fail now; nothing more can be acknowledged.
    tokio::time::sleep(Duration::from_millis(500)).await;
    let acked: BTreeMap<u32, u64> = work.shared.ledger.lock().expect("ledger").records.clone();
    let before = ctx.host.pid;
    ctx.host
        .restart(bin)
        .await
        .map_err(|error| error.to_string())?;
    ctx.check(Check::new(
        "the_host_restarted_on_the_same_data",
        ctx.host.pid != before,
        format!("pid {before:?} then {:?}", ctx.host.pid),
    ));
    // Before any device returns: the recovered database, read-only.
    let pool = ctx.db().await?;
    let rows: Result<Vec<(String, i64)>, String> = sqlx::query_as(
        "SELECT device_id, COUNT(*) FROM fact_receipts WHERE shift_id = ? GROUP BY device_id",
    )
    .bind(&shift)
    .fetch_all(&pool)
    .await
    .map_err(|error| error.to_string());
    let structural = crate::dbcheck::structural(&pool).await;
    pool.close().await;
    let kept: BTreeMap<String, i64> = rows?.into_iter().collect();
    let mut swallowed = 0u64;
    for device in &work.devices {
        let index = device.spec.index;
        let acknowledged = acked.get(&index).copied().unwrap_or(0);
        let in_db = kept.get(&device.spec.id).copied().unwrap_or(0) as u64;
        ctx.check(Check::new(
            &format!("no_acknowledged_record_lost_device_{index}"),
            in_db >= acknowledged,
            format!("{acknowledged} acknowledged, {in_db} in the database after the restart"),
        ));
        swallowed += in_db.saturating_sub(acknowledged);
    }
    match structural {
        Ok(checks) => ctx.checks(prefixed("after_the_crash_", checks)),
        Err(error) => ctx.check(Check::new("after_the_crash_db_structural", false, error)),
    }
    ctx.observe("committedButUnacknowledged", json!(swallowed));
    if swallowed == 0 {
        ctx.note.push_str(
            "the kill swallowed no committed batch's answer this run, so no resend met a stored \
             receipt after the crash (the logic has its unit test \
             device::tests::a_batch_the_host_kept_but_whose_answer_was_lost_is_counted_once). ",
        );
    }
    if at_kill.wal_backlog_frames.is_none_or(|frames| frames == 0) {
        ctx.note.push_str(
            "the WAL held no un-checkpointed frame at the kill (or it could not be read): the \
             recovery of such frames was not exercised this run. ",
        );
    }
    // The devices come back, resend and go on.
    for device in &work.devices {
        device.set_online(true);
    }
    tokio::time::sleep(Duration::from_secs(LOAD_S)).await;
    let (shared, devices, drained) = work.stop("").await;
    ctx.checks(drained);
    let flush_errors: u64 = devices
        .iter()
        .map(|device| device.stats().flush_errors)
        .sum();
    ctx.observe("flushErrors", json!(flush_errors));
    let found = super::reconcile(ctx, "", &shift, &shared, &devices).await;
    ctx.checks(found);
    let mut last = None;
    for device in &devices {
        last = Some(device.close_part_ledgered(None, None, None).await?);
    }
    ctx.same(
        "the_last_part_closes_the_shift_after_the_restart",
        Some(false),
        last.as_ref().map(part_closed),
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn the_kill_restart_scenario_is_not_judged_in_this_process() {
        let work = tempfile::tempdir().unwrap();
        let profile = Profile::preset("tiny").unwrap();
        let (result, secrets) = run(&HostKind::InProcess, work.path(), &profile).await;
        assert!(!result.judged);
        assert!(result.note.contains("--host spawn"), "{}", result.note);
        assert!(secrets.is_empty());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    #[ignore = "spawns markiro-host, kills it and restarts it on its port; run with --ignored"]
    async fn the_kill_restart_scenario_holds_against_a_spawned_host() {
        let work = tempfile::tempdir().unwrap();
        let profile = Profile::preset("tiny").unwrap();
        let bin = crate::host::test_host_binary();
        let (result, _) = run(&HostKind::Spawn { bin }, work.path(), &profile).await;
        for check in &result.checks {
            eprintln!("OBSERVED {} {} {}", check.name, check.ok, check.detail);
        }
        eprintln!("OBSERVED {:?} note: {}", result.observed, result.note);
        assert!(result.judged);
        assert!(
            result.checks.iter().all(|check| check.ok),
            "{:#?}",
            result.checks
        );
        for name in [
            "the_host_was_running_when_killed",
            "the_host_restarted_on_the_same_data",
            "after_the_crash_db_integrity",
            "no_acknowledged_record_lost_device_0",
            "db_receipts_device_3",
            "the_last_part_closes_the_shift_after_the_restart",
        ] {
            assert!(
                result.checks.iter().any(|check| check.name == name),
                "no check {name}"
            );
        }
        for key in ["walBacklogAtKill", "committedButUnacknowledged"] {
            assert!(result.observed.contains_key(key), "{key}");
        }
    }
}
