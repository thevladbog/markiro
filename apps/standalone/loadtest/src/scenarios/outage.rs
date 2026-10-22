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
    let began = Instant::now();
    let graceful = ctx.host.stop().await.map_err(|error| error.to_string())?;
    ctx.same("the_host_stopped_on_request", cfg!(unix), graceful);
    tokio::time::sleep(Duration::from_secs(OUTAGE_S)).await;
    let window_s = began.elapsed().as_secs_f64();
    let unanswered = facts_without_an_answer(&ctx.metrics) - unanswered_before;
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
    // Without the back-off a device would retry every flush interval (300 ms): about 20 times in
    // 6 s. With it: 0, 0.3, 0.8, 1.8, 3.8, 5.8 s — six. The bound leaves room for the stop itself.
    let bound = work.devices.len() as u64 * (3 + window_s.ceil() as u64);
    ctx.check(Check::new(
        "the_back_off_caps_the_retries",
        unanswered <= bound,
        format!(
            "{unanswered} facts requests without an answer from {} devices in {window_s:.1} s, at most {bound}",
            work.devices.len()
        ),
    ));
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

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn the_outage_scenario_is_not_judged_in_this_process() {
        let work = tempfile::tempdir().unwrap();
        let profile = Profile::preset("tiny").unwrap();
        let (result, _) = run(&HostKind::InProcess, work.path(), &profile).await;
        assert!(!result.judged);
        assert!(result.note.contains("--host spawn"), "{}", result.note);
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
        ] {
            assert!(
                result.checks.iter().any(|check| check.name == name),
                "no check {name}"
            );
        }
    }
}
