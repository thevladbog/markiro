//! `closed-part`: a part closed while the shift stays active keeps sending (late facts, accepted,
//! counted, the part marked late, never reopened), and the last two open parts close at the same
//! instant (host `facts::{apply, mark_part_late, close_part}`, `facts/shift_closed.rs::apply`).

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use markiro_proto::FactKind;
use serde_json::{json, Value};

use super::{
    close_record, enter_all, part, part_closed, prefixed, reason_missing, scripted_work, shift_row,
    Ctx, HostKind, Res, LOAD_S,
};
use crate::checks::Check;
use crate::gen;
use crate::profile::Profile;
use crate::report::ScenarioResult;
use crate::secret::Redactions;
use crate::site::DeviceSpec;

pub const NAME: &str = "closed-part";
/// The host's plan of every shift here: never the shift's total, so a closer's reason matters.
const PLANNED: u32 = 9_999;
/// The reason the reasoned closer gives.
const REASON: &str = "production_order_changed";
/// Scripted repetitions of the two-closer race.
const RACES: u32 = 3;
/// The line's limit: the three stations and the handheld (a wizard line allows one by default).
const LIMIT: u32 = 4;

pub async fn run(kind: &HostKind, work_dir: &Path, base: &Profile) -> (ScenarioResult, Redactions) {
    let mut ctx = match Ctx::new(NAME, kind, work_dir, base, 3, 1).await {
        Ok(ctx) => ctx,
        Err(error) => return (super::broken(NAME, error), Redactions::default()),
    };
    let outcome = body(&mut ctx).await;
    ctx.finish(outcome).await
}

/// Two closes sent at the same instant, `(device, actual, closedAt ms, reason)` each; their
/// receipts in that order.
async fn race_two(
    ctx: &Ctx,
    shift: &str,
    closes: [(DeviceSpec, u32, i64, Option<&'static str>); 2],
    variant: u64,
) -> Res<Vec<Value>> {
    let barrier = Arc::new(tokio::sync::Barrier::new(2));
    let mut tasks = Vec::new();
    for (device, actual, at_ms, reason) in closes {
        let api = ctx.site.office.api.clone();
        let barrier = barrier.clone();
        let record = close_record(
            shift,
            &device,
            variant,
            Some(PLANNED),
            actual,
            0,
            reason,
            &gen::text_of(at_ms),
        );
        tasks.push(tokio::spawn(async move {
            barrier.wait().await;
            api.facts(device.key.expose(), &[record]).await
        }));
    }
    let mut receipts = Vec::new();
    for task in tasks {
        let mut answer = task.await.map_err(|error| error.to_string())??;
        receipts.push(answer.remove(0));
    }
    Ok(receipts)
}

/// The rules two closes at once must obey, whatever their order.
async fn judge_race(
    ctx: &mut Ctx,
    prefix: &str,
    shift: &str,
    devices: [&DeviceSpec; 2],
    reasons: [Option<&str>; 2],
    moments: [i64; 2],
    receipts: &[Value],
) -> Res<()> {
    let closing: Vec<usize> = (0..2)
        .filter(|at| receipts[*at]["outcome"] == "accepted" && !part_closed(&receipts[*at]))
        .collect();
    ctx.same(
        &format!("{prefix}exactly_one_close_closes_the_shift"),
        1usize,
        closing.len(),
    );
    ctx.same(
        &format!("{prefix}the_other_closes_only_its_part"),
        1usize,
        receipts
            .iter()
            .filter(|receipt| part_closed(receipt))
            .count(),
    );
    let Some(&closer) = closing.first() else {
        return Ok(());
    };
    ctx.observe(&format!("{prefix}closer"), json!(devices[closer].index));
    // The plan is never the shift's total here: a closer without a reason leaves it missing.
    let missing = reasons[closer].is_none();
    ctx.same(
        &format!("{prefix}reason_missing_iff_the_closer_gave_none"),
        missing,
        reason_missing(&receipts[closer]),
    );
    let pool = ctx.db().await?;
    let row = shift_row(&pool, shift).await;
    let invariants = crate::dbcheck::participant_invariants(&pool, shift).await;
    pool.close().await;
    let row = row?;
    let latest = moments.iter().copied().max().unwrap_or(0);
    let expected_at = markiro_host::clock::format_timestamp(
        time::OffsetDateTime::from_unix_timestamp(latest.div_euclid(1000))
            .map_err(|error| error.to_string())?,
    );
    ctx.same(
        &format!("{prefix}shift_closed_by_the_closer"),
        (
            "closed".to_owned(),
            Some("device".to_owned()),
            Some(devices[closer].id.clone()),
        ),
        (
            row.status.clone(),
            row.closed_by_kind.clone(),
            row.closed_by.clone(),
        ),
    );
    ctx.same(
        &format!("{prefix}shift_closes_at_the_latest_moment"),
        Some(expected_at),
        row.closed_at.clone(),
    );
    ctx.same(
        &format!("{prefix}reason_columns_follow_the_closer"),
        (missing, reasons[closer].map(str::to_owned)),
        (row.close_reason_missing, row.close_reason_code.clone()),
    );
    match invariants {
        Ok(checks) => ctx.checks(prefixed(prefix, checks)),
        Err(error) => ctx.check(Check::new(&format!("{prefix}db_invariants"), false, error)),
    }
    Ok(())
}

async fn body(ctx: &mut Ctx) -> Res<()> {
    let line = ctx.site.line_ids[0].clone();
    let set = ctx.set_max_stations(&line, LIMIT).await?;
    ctx.same("limit_set", 200u16, set.status);
    let shift = ctx.plan(&line, Some(PLANNED)).await?;
    let prefix = enter_all(ctx, &shift, &[0, 1, 2, 3]).await?;
    let work = ctx.load(1, &shift, &prefix, &[0, 1, 2, 3]);
    tokio::time::sleep(Duration::from_secs(LOAD_S)).await;
    // Device 1 closes its part; the shift stays active for the others.
    let closer = work.of(1).clone();
    closer.seal(Duration::from_secs(60)).await?;
    let first = closer
        .close_part_ledgered(Some(PLANNED), None, None)
        .await?;
    ctx.same(
        "own_close_closes_only_the_part",
        (Some("accepted"), true),
        (first["outcome"].as_str(), part_closed(&first)),
    );
    // Its device keeps scanning: late facts of a closed part.
    let made = closer.records_made();
    closer.resume();
    tokio::time::sleep(Duration::from_secs(2)).await;
    closer.seal(Duration::from_secs(60)).await?;
    let late = closer.records_made() - made;
    ctx.observe("lateRecords", json!(late));
    let rejected = work.shared.ledger.lock().expect("ledger").rejected.clone();
    ctx.check(Check::new(
        "late_facts_of_a_closed_part_are_accepted",
        late > 0 && rejected.is_empty(),
        format!("{late} late records, rejected {rejected:?}"),
    ));
    let office = ctx.office_shift(&shift).await?;
    let closed_id = closer.spec.id.clone();
    ctx.same(
        "a_closed_part_stays_closed_and_is_marked_late",
        (Some("closed"), true),
        (
            part(&office, &closed_id).and_then(|part| part["state"].as_str()),
            part(&office, &closed_id).is_some_and(|part| part["lateDataAt"].is_string()),
        ),
    );
    ctx.same(
        "late_facts_do_not_close_the_shift",
        "active",
        office["status"].as_str().unwrap_or(""),
    );
    let accepted = work
        .shared
        .ledger
        .lock()
        .expect("ledger")
        .accepted_scans
        .get(&1)
        .copied()
        .unwrap_or(0);
    let figure = office["byDevice"]
        .as_array()
        .and_then(|parts| {
            parts
                .iter()
                .find(|part| part["deviceId"] == json!(closed_id))
        })
        .and_then(|part| part["accepted"].as_u64());
    ctx.same(
        "late_scans_count_in_the_parts_figure",
        Some(accepted),
        figure,
    );
    // A second close of the closed part changes nothing and says so.
    let second = closer
        .close_part_ledgered(Some(PLANNED), None, None)
        .await?;
    ctx.same(
        "a_second_close_of_a_closed_part_says_part_closed",
        (Some("accepted"), true),
        (second["outcome"].as_str(), part_closed(&second)),
    );
    // Device 3 closes; devices 0 and 2 close at the same instant, 0 without a reason and with the
    // later moment, 2 with a reason. Both moments are ahead of every other part's.
    let third = work.of(3).clone();
    third.seal(Duration::from_secs(60)).await?;
    let receipt = third.close_part_ledgered(Some(PLANNED), None, None).await?;
    ctx.same(
        "third_close_closes_only_the_part",
        true,
        part_closed(&receipt),
    );
    for at in [0usize, 2] {
        work.of(at).seal(Duration::from_secs(60)).await?;
    }
    let actual = |at: u32| -> u32 {
        work.shared
            .ledger
            .lock()
            .expect("ledger")
            .accepted_scans
            .get(&at)
            .copied()
            .unwrap_or(0) as u32
    };
    let (a, b) = (ctx.device(0), ctx.device(2));
    let base_ms = gen::now_ms() + 60_000;
    let moments = [base_ms + 30_000, base_ms];
    let reasons: [Option<&'static str>; 2] = [None, Some(REASON)];
    let receipts = race_two(
        ctx,
        &shift,
        [
            (a.clone(), actual(0), moments[0], reasons[0]),
            (b.clone(), actual(2), moments[1], reasons[1]),
        ],
        1,
    )
    .await?;
    work.of(0)
        .apply_receipt(FactKind::ShiftClosed, &receipts[0]);
    work.of(2)
        .apply_receipt(FactKind::ShiftClosed, &receipts[1]);
    judge_race(ctx, "", &shift, [&a, &b], reasons, moments, &receipts).await?;
    let (shared, devices, drained) = work.stop("").await;
    ctx.checks(drained);
    let found = super::reconcile(ctx, "", &shift, &shared, &devices).await;
    ctx.checks(found);
    // The same race on small scripted shifts, moments and reasons swapped each time.
    for race in 0..RACES {
        let shift = ctx.plan(&line, Some(PLANNED)).await?;
        let issuer = enter_all(ctx, &shift, &[0, 2]).await?;
        scripted_work(ctx, &a, &shift, &issuer, 10 + race, 2).await?;
        scripted_work(ctx, &b, &shift, &issuer, 20 + race, 2).await?;
        let base_ms = gen::now_ms() + 60_000;
        let (moments, reasons): ([i64; 2], [Option<&'static str>; 2]) = if race % 2 == 0 {
            ([base_ms, base_ms + 30_000], [Some(REASON), None])
        } else {
            ([base_ms + 30_000, base_ms], [None, Some(REASON)])
        };
        let receipts = race_two(
            ctx,
            &shift,
            [
                (a.clone(), 2, moments[0], reasons[0]),
                (b.clone(), 2, moments[1], reasons[1]),
            ],
            100 + u64::from(race),
        )
        .await?;
        judge_race(
            ctx,
            &format!("race_{race}_"),
            &shift,
            [&a, &b],
            reasons,
            moments,
            &receipts,
        )
        .await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn the_closed_part_scenario_holds_against_a_host_in_this_process() {
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
            "limit_set",
            "own_close_closes_only_the_part",
            "late_facts_of_a_closed_part_are_accepted",
            "a_closed_part_stays_closed_and_is_marked_late",
            "late_scans_count_in_the_parts_figure",
            "a_second_close_of_a_closed_part_says_part_closed",
            "exactly_one_close_closes_the_shift",
            "shift_closes_at_the_latest_moment",
            "reason_columns_follow_the_closer",
            "race_2_exactly_one_close_closes_the_shift",
            "db_receipts_device_1",
        ] {
            assert!(
                result.checks.iter().any(|check| check.name == name),
                "no check {name}"
            );
        }
        assert!(result.observed.contains_key("closer"));
    }
}
