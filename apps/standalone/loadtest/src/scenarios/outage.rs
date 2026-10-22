//! `outage`: the host stopped on request under load and started again. The devices keep
//! scanning, their sends fail (connection refused), each backs off (`device.rs`: 250 ms doubling
//! to 2 s) and none gives up; after the restart the outboxes drain and nothing is written twice.
//! The back-off exercised is the harness's device model: the station's and the handheld's own
//! clients are not exercised here. A host 5xx is not induced (E9).

use std::path::Path;
use std::time::{Duration, Instant};

use serde_json::json;

use super::{enter_all, part_closed, Ctx, HostKind, Res, LOAD_S};
use crate::checks::Check;
use crate::metrics::Metrics;
use crate::profile::Profile;
use crate::report::ScenarioResult;

pub const NAME: &str = "outage";
/// How long the host stays down, in seconds.
const OUTAGE_S: u64 = 6;

pub async fn run(
    kind: &HostKind,
    work_dir: &Path,
    base: &Profile,
) -> (ScenarioResult, Vec<String>) {
    if let Some(skipped) = super::skip_on_windows(NAME) {
        return (skipped, Vec::new());
    }
    let HostKind::Spawn { bin } = kind else {
        return (
            super::not_judged(
                NAME,
                "needs a host this harness spawned (--host spawn): a host in this process or an attached one cannot be stopped and restarted on its port",
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

/// Facts requests that got no answer so far.
fn facts_without_an_answer(metrics: &Metrics) -> u64 {
    metrics
        .errors()
        .iter()
        .filter(|(class, _)| class.starts_with("facts:net_"))
        .map(|(_, count)| *count)
        .sum()
}

async fn body(ctx: &mut Ctx, bin: &Path) -> Res<()> {
    let line = ctx.site.line_ids[0].clone();
    let shift = ctx.plan(&line, None).await?;
    let all = [0usize, 1, 2, 3];
    let prefix = enter_all(ctx, &shift, &all).await?;
    let work = ctx.load(1, &shift, &prefix, &all);
    tokio::time::sleep(Duration::from_secs(LOAD_S)).await;
    let failed_before: Vec<u64> = work
        .devices
        .iter()
        .map(|device| device.stats().flush_errors)
        .collect();
    let unanswered_before = facts_without_an_answer(&ctx.metrics);
    let errors_before = ctx.metrics.errors();
    let began = Instant::now();
    let graceful = ctx.host.stop().await.map_err(|error| error.to_string())?;
    ctx.same("the_host_stopped_on_request", cfg!(unix), graceful);
    tokio::time::sleep(Duration::from_secs(OUTAGE_S)).await;
    let window_s = began.elapsed().as_secs_f64();
    let unanswered = facts_without_an_answer(&ctx.metrics) - unanswered_before;
    let by_route: std::collections::BTreeMap<String, u64> = ctx
        .metrics
        .errors()
        .into_iter()
        .filter(|(class, _)| class.contains(":net_"))
        .map(|(class, count)| {
            let before = errors_before.get(&class).copied().unwrap_or(0);
            (class, count - before)
        })
        .filter(|(_, count)| *count > 0)
        .collect();
    ctx.observe("unansweredByRoute", json!(by_route));
    let retried: Vec<u64> = work
        .devices
        .iter()
        .zip(&failed_before)
        .map(|(device, before)| device.stats().flush_errors - before)
        .collect();
    ctx.observe("failedSendsPerDevice", json!(retried));
    ctx.observe("outageS", json!(window_s));
    ctx.check(Check::new(
        "every_device_kept_retrying",
        retried.iter().all(|count| *count > 0),
        format!("{retried:?} failed sends per device in {window_s:.1} s"),
    ));
    // Without the back-off a device would retry every flush interval; with it, the model's
    // schedule (both derived from `flushMs`). Two more per device leave room for the request in
    // flight at the stop and one at the window's edge. Only the facts route is backed off: the
    // scanner's code checks, and the SSCC top-ups and the totals poll of the syncer's loop, have
    // no back-off in the device model, so their requests without an answer are recorded
    // (`unansweredByRoute`), never bounded.
    let window_ms = (window_s * 1000.0) as u64;
    let flush_ms = ctx.profile.flush_ms;
    let devices = work.devices.len() as u64;
    let per_device = backed_off_attempts(window_ms, flush_ms) + 2;
    let bound = devices * per_device;
    let unbacked = unbacked_attempts(window_ms, flush_ms);
    ctx.observe("backOffBoundPerDevice", json!(per_device));
    ctx.observe("unbackedAttemptsPerDevice", json!(unbacked));
    ctx.check(Check::new(
        "the_back_off_caps_the_retries",
        unanswered <= bound,
        format!(
            "{unanswered} facts requests without an answer from {devices} devices in \
             {window_s:.1} s, at most {bound} ({per_device} each with the back-off, {unbacked} \
             each without it at flushMs {flush_ms})"
        ),
    ));
    if per_device * 2 > unbacked {
        ctx.note.push_str(&format!(
            "at flushMs {flush_ms} an outage of {window_s:.1} s cannot tell the back-off from none \
             ({per_device} attempts allowed per device, {unbacked} without a back-off): the cap \
             check is weak this run. "
        ));
    }
    ctx.check(Check::new(
        "no_device_gave_up",
        work.devices
            .iter()
            .all(|device| device.stats().fatal.is_none()),
        format!(
            "{:?}",
            work.devices
                .iter()
                .map(|device| device.stats().fatal)
                .collect::<Vec<_>>()
        ),
    ));
    let restarted = ctx
        .host
        .restart(bin)
        .await
        .map_err(|error| error.to_string());
    ctx.check(Check::new(
        "the_host_came_back",
        restarted.is_ok(),
        format!("{restarted:?}"),
    ));
    restarted?;
    // The outage's window ends here: the host answers again, and its log and the requests from
    // now on are judged.
    ctx.end_faults().await;
    tokio::time::sleep(Duration::from_secs(LOAD_S)).await;
    let (shared, devices, drained) = work.stop("").await;
    ctx.checks(drained);
    let found = super::reconcile(ctx, "", &shift, &shared, &devices).await;
    ctx.checks(found);
    let mut last = None;
    for device in &devices {
        last = Some(device.close_part_ledgered(None, None, None).await?);
    }
    ctx.same(
        "the_last_part_closes_the_shift_after_the_outage",
        Some(false),
        last.as_ref().map(part_closed),
    );
    Ok(())
}

/// The facts sends a device of the model makes in `window_ms` while every send fails: one at
/// once, then each after its back-off (250 ms doubling to 2 s) and the flush interval.
fn backed_off_attempts(window_ms: u64, flush_ms: u64) -> u64 {
    let (mut at, mut backoff, mut attempts) = (0u64, 250u64, 0u64);
    while at <= window_ms {
        attempts += 1;
        at += backoff + flush_ms;
        backoff = (backoff * 2).min(2_000);
    }
    attempts
}

/// The facts sends a device would make in `window_ms` with no back-off: one per flush interval.
fn unbacked_attempts(window_ms: u64, flush_ms: u64) -> u64 {
    window_ms / flush_ms.max(1) + 1
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_back_off_bound_follows_the_flush_interval() {
        // The device model (`device.rs` syncer): a failed flush sleeps 250 ms doubling to 2 s,
        // then waits the flush interval again. 300 ms in 6.1 s: at 0, 0.55, 1.35, 2.65, 4.95 s.
        assert_eq!(backed_off_attempts(6_100, 300), 5);
        assert_eq!(unbacked_attempts(6_100, 300), 21);
        // A longer interval: fewer attempts either way.
        assert_eq!(backed_off_attempts(6_100, 1_000), 4);
        assert_eq!(unbacked_attempts(6_100, 1_000), 7);
        assert_eq!(backed_off_attempts(0, 300), 1);
    }

    #[tokio::test]
    async fn the_outage_scenario_is_not_judged_in_this_process() {
        let work = tempfile::tempdir().unwrap();
        let profile = Profile::preset("tiny").unwrap();
        let (result, _) = run(&HostKind::InProcess, work.path(), &profile).await;
        assert!(!result.judged);
        // On Windows the restart is unverified, so the scenario says that before it reads the
        // host mode; elsewhere it names the host mode it needs.
        let expected =
            crate::scenarios::restart_unverified_note(cfg!(windows)).unwrap_or("--host spawn");
        assert!(result.note.contains(expected), "{}", result.note);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    #[ignore = "spawns markiro-host, stops it under load and restarts it; run with --ignored"]
    async fn the_outage_scenario_holds_against_a_spawned_host() {
        let work = tempfile::tempdir().unwrap();
        let profile = Profile::preset("tiny").unwrap();
        let bin = crate::host::test_host_binary();
        let (result, _) = run(&HostKind::Spawn { bin }, work.path(), &profile).await;
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
            "the_host_stopped_on_request",
            "every_device_kept_retrying",
            "the_back_off_caps_the_retries",
            "no_device_gave_up",
            "the_host_came_back",
            "db_scans_device_0",
            "host_log_error_lines_after_the_faults",
            "no_request_without_an_answer_after_the_faults",
        ] {
            assert!(
                result.checks.iter().any(|check| check.name == name),
                "no check {name}"
            );
        }
    }
}
