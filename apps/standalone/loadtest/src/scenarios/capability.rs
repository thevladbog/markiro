//! `capability`: what a build that does not name `multi-station-v1` meets (host
//! `shift_participants::decide_entry`, `routes/device_shifts.rs::{enter_shift, require_supports,
//! with_participation}`, `server.rs::protocol_guard`). No load: every step is one request and its
//! exact answer.

use std::path::Path;

use serde_json::{json, Value};

use super::{
    close_fact, constraint, error_code, issuer_prefix, joined_rev, my_state, part_closed,
    scripted_work, send_with_protocol, Ctx, HostKind, Res,
};
use crate::checks::Check;
use crate::metrics::Route;
use crate::profile::Profile;
use crate::report::ScenarioResult;

pub const NAME: &str = "capability";

pub async fn run(
    kind: &HostKind,
    work_dir: &Path,
    base: &Profile,
) -> (ScenarioResult, Vec<String>) {
    // Device 0 is the office station, 1 and 2 are stations, 3 is the handheld.
    let mut ctx = match Ctx::new(NAME, kind, work_dir, base, 3, 1).await {
        Ok(ctx) => ctx,
        Err(error) => return (super::broken(NAME, error), Vec::new()),
    };
    let outcome = body(&mut ctx).await;
    ctx.finish(outcome).await
}

async fn body(ctx: &mut Ctx) -> Res<()> {
    let line = ctx.site.line_ids[0].clone();
    // The wizard's lines allow one device; this scenario needs free slots to show that they
    // do not matter to a build that names nothing.
    let widened = ctx.set_max_stations(&line, 4).await?;
    ctx.same("line_widened", 200u16, widened.status);
    let (multi, legacy, other, handheld) =
        (ctx.device(0), ctx.device(1), ctx.device(2), ctx.device(3));
    let shift = ctx.plan(&line, None).await?;
    // A build that names nothing opens a planned shift alone, as in stage 2a.
    let opened = ctx.enter(&legacy, &shift, Some(Vec::new())).await?;
    ctx.same(
        "legacy_opens_a_planned_shift",
        (200u16, "active"),
        (opened.status, my_state(&opened.body)),
    );
    let prefix = issuer_prefix(&opened.body).ok_or("the opening answered no snapshot")?;
    // Another build that names nothing meets a shift somebody works. No body at all (a
    // protocol 3 station) reads the same.
    let busy = ctx.enter(&other, &shift, None).await?;
    ctx.same(
        "legacy_entry_into_a_worked_shift_is_busy",
        (409u16, Some("conflict"), Some("shift_busy")),
        (busy.status, error_code(&busy), constraint(&busy)),
    );
    // A build that names the capability joins the shift a legacy build opened.
    let joined = ctx.enter(&multi, &shift, Some(multi.supports())).await?;
    ctx.same(
        "multi_device_joins_a_shift_a_legacy_device_opened",
        (200u16, "active"),
        (joined.status, my_state(&joined.body)),
    );
    // Still busy with two of the line's four slots free: the capability decides, not the slots.
    let busy = ctx.enter(&other, &shift, Some(Vec::new())).await?;
    ctx.same(
        "legacy_stays_busy_while_slots_are_free",
        (409u16, Some("shift_busy")),
        (busy.status, constraint(&busy)),
    );
    // Reads are not gated by the capability: a device of the line that never entered sees the
    // shared shift's participants and totals.
    let list = ctx
        .send(
            &other,
            Route::DeviceShifts,
            "GET",
            "/v1/device/shifts",
            None,
        )
        .await?;
    let seen = list.body["shifts"]
        .as_array()
        .and_then(|shifts| shifts.iter().find(|item| item["id"] == json!(shift)))
        .cloned()
        .unwrap_or(Value::Null);
    ctx.same(
        "a_non_participant_reads_the_shared_shift",
        (2usize, true, true),
        (
            super::states(&seen).len(),
            seen.get("totals").is_some_and(Value::is_object),
            seen.get("myState").map_or(true, Value::is_null),
        ),
    );
    // A handheld names its host capability whatever else it names.
    let update = ctx
        .enter(&handheld, &shift, Some(vec!["multi-station-v1"]))
        .await?;
    ctx.same(
        "a_handheld_without_its_host_capability_is_told_to_update",
        (409u16, Some("station_update")),
        (update.status, constraint(&update)),
    );
    // A legacy participant's facts are taken like anyone's.
    let made = scripted_work(ctx, &legacy, &shift, &prefix, 1, 3).await?;
    ctx.same(
        "a_legacy_participants_facts_are_accepted",
        vec!["accepted"; made.receipts.len()],
        made.receipts
            .iter()
            .map(|receipt| receipt["outcome"].as_str().unwrap_or(""))
            .collect::<Vec<_>>(),
    );
    // Nobody active at all: a legacy device that never entered is still busy.
    let left = ctx
        .leave(&legacy, &shift, joined_rev(&opened.body, &legacy.id))
        .await?;
    let left_multi = ctx
        .leave(&multi, &shift, joined_rev(&joined.body, &multi.id))
        .await?;
    ctx.same(
        "both_parts_left",
        ("left", "left"),
        (my_state(&left.body), my_state(&left_multi.body)),
    );
    let busy = ctx.enter(&other, &shift, Some(Vec::new())).await?;
    ctx.same(
        "legacy_is_busy_with_no_active_participant",
        (409u16, Some("shift_busy")),
        (busy.status, constraint(&busy)),
    );
    // A legacy participant that left comes back naming nothing: the capability guards a first
    // entry only.
    let back = ctx.enter(&legacy, &shift, Some(Vec::new())).await?;
    ctx.same(
        "a_legacy_participant_that_left_rejoins",
        (200u16, "active"),
        (back.status, my_state(&back.body)),
    );
    let back_multi = ctx.enter(&multi, &shift, Some(multi.supports())).await?;
    ctx.same(
        "the_multi_participant_rejoins",
        (200u16, "active"),
        (back_multi.status, my_state(&back_multi.body)),
    );
    // The legacy part closes; the other keeps the shift open.
    let receipt = close_fact(ctx, &legacy, &shift, 1, None, 3, made.boxes, None, None).await?;
    ctx.same(
        "legacy_close_closes_only_its_part",
        (Some("accepted"), true),
        (receipt["outcome"].as_str(), part_closed(&receipt)),
    );
    // Its legacy build entering again is told the shift is closed while it is active: every
    // older build shows `shift_status` as «закрыта».
    let again = ctx.enter(&legacy, &shift, Some(Vec::new())).await?;
    ctx.same(
        "a_legacy_device_with_a_closed_part_is_told_the_shift_is_closed",
        (409u16, Some("shift_status"), Some("closed")),
        (
            again.status,
            constraint(&again),
            again
                .body
                .pointer("/error/details/status")
                .and_then(Value::as_str),
        ),
    );
    let office = ctx.office_shift(&shift).await?;
    ctx.same(
        "the_shift_stays_active",
        "active",
        office["status"].as_str().unwrap_or(""),
    );
    // The same device naming the capability reads its closed part back.
    let read = ctx.enter(&legacy, &shift, Some(legacy.supports())).await?;
    ctx.same(
        "a_multi_entry_reads_its_closed_part",
        (200u16, "closed"),
        (read.status, my_state(&read.body)),
    );
    // `protocol_unsupported` is about the protocol header, never a capability.
    let unknown = send_with_protocol(ctx, &multi, "GET", "/v1/device/shifts", 99, None).await?;
    ctx.same(
        "an_unknown_protocol_is_protocol_unsupported",
        (
            400u16,
            Some("protocol_unsupported"),
            Some(u64::from(markiro_proto::PROTOCOL_VERSION)),
        ),
        (
            unknown.status,
            error_code(&unknown),
            unknown
                .body
                .pointer("/error/details/maxProtocol")
                .and_then(Value::as_u64),
        ),
    );
    let old = send_with_protocol(
        ctx,
        &other,
        "POST",
        &format!("/v1/device/shifts/{shift}/enter"),
        3,
        None,
    )
    .await?;
    ctx.same(
        "an_old_protocol_is_accepted_and_judged_by_the_capability",
        (409u16, Some("shift_busy")),
        (old.status, constraint(&old)),
    );
    // The last open part closes the shift.
    let last = close_fact(ctx, &multi, &shift, 1, None, 0, 0, None, None).await?;
    ctx.same(
        "the_last_part_closes_the_shift",
        (Some("accepted"), false),
        (last["outcome"].as_str(), part_closed(&last)),
    );
    let pool = ctx.db().await?;
    let invariants = crate::dbcheck::participant_invariants(&pool, &shift).await;
    let states = crate::dbcheck::participants_in(
        &pool,
        &shift,
        &[
            (legacy.index, legacy.id.clone(), "closed"),
            (multi.index, multi.id.clone(), "closed"),
        ],
    )
    .await;
    pool.close().await;
    for (name, found) in [("db_invariants", invariants), ("db_participants", states)] {
        match found {
            Ok(checks) => ctx.checks(checks),
            Err(error) => ctx.check(Check::new(name, false, error)),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn the_capability_scenario_holds_against_a_host_in_this_process() {
        let work = tempfile::tempdir().unwrap();
        let profile = Profile::preset("tiny").unwrap();
        let (result, _) = run(&HostKind::InProcess, work.path(), &profile).await;
        for check in &result.checks {
            eprintln!("OBSERVED {} {} {}", check.name, check.ok, check.detail);
        }
        assert!(result.judged);
        assert!(
            result.checks.iter().all(|check| check.ok),
            "{:#?}",
            result.checks
        );
        for name in [
            "legacy_opens_a_planned_shift",
            "legacy_entry_into_a_worked_shift_is_busy",
            "legacy_is_busy_with_no_active_participant",
            "a_legacy_participant_that_left_rejoins",
            "a_legacy_device_with_a_closed_part_is_told_the_shift_is_closed",
            "a_multi_entry_reads_its_closed_part",
            "a_non_participant_reads_the_shared_shift",
            "an_unknown_protocol_is_protocol_unsupported",
            "an_old_protocol_is_accepted_and_judged_by_the_capability",
            "the_last_part_closes_the_shift",
            "closed_shift_has_no_open_part",
        ] {
            assert!(
                result.checks.iter().any(|check| check.name == name),
                "no check {name}"
            );
        }
    }
}
