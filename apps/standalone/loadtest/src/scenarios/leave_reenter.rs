//! `leave-reenter`: devices pause (`leave` with their `joinedRev`) and return while the others
//! scan; the freed slot is taken by a spare; a leave of an earlier stay changes nothing; the
//! counts of joins and leaves, the states of the parts and the ledger stay exact (host
//! `routes/device_shifts.rs::leave_shift`, `shift_participants::decide_entry`).

use std::collections::BTreeMap;
use std::path::Path;
use std::time::Duration;

use super::{
    close_fact, constraint, joined_rev, my_state, part_closed, Ctx, HostKind, Res, LOAD_S,
};
use crate::checks::Check;
use crate::profile::Profile;
use crate::report::ScenarioResult;
use crate::secret::Redactions;

pub const NAME: &str = "leave-reenter";
/// Pause-and-return cycles, one device after another.
const CYCLES: usize = 3;
/// The line's limit: exactly the three working stations.
const LIMIT: u32 = 3;

pub async fn run(kind: &HostKind, work_dir: &Path, base: &Profile) -> (ScenarioResult, Redactions) {
    // Stations 0, 1 and 2 work; handheld 3 is the spare.
    let mut ctx = match Ctx::new(NAME, kind, work_dir, base, 3, 1).await {
        Ok(ctx) => ctx,
        Err(error) => return (super::broken(NAME, error), Redactions::default()),
    };
    let outcome = body(&mut ctx).await;
    ctx.finish(outcome).await
}

async fn body(ctx: &mut Ctx) -> Res<()> {
    let line = ctx.site.line_ids[0].clone();
    let set = ctx.set_max_stations(&line, LIMIT).await?;
    ctx.same("limit_set", 200u16, set.status);
    let shift = ctx.plan(&line, None).await?;
    let mut tokens: BTreeMap<usize, Option<u64>> = BTreeMap::new();
    let mut prefix = None;
    for at in [0usize, 1, 2] {
        let device = ctx.device(at);
        let entered = ctx.enter(&device, &shift, Some(device.supports())).await?;
        if !entered.ok() {
            return Err(format!(
                "entry of device {at}: {} {}",
                entered.status, entered.body
            ));
        }
        tokens.insert(at, joined_rev(&entered.body, &device.id));
        prefix = prefix.or_else(|| super::issuer_prefix(&entered.body));
    }
    let prefix = prefix.ok_or("no entry answered a snapshot")?;
    let spare = ctx.device(3);
    let work = ctx.load(1, &shift, &prefix, &[0, 1, 2]);
    tokio::time::sleep(Duration::from_secs(LOAD_S)).await;
    for cycle in 0..CYCLES {
        let at = cycle % 3;
        let device = ctx.device(at);
        let sim = work.of(at).clone();
        sim.pause().await;
        sim.wait_drained(Duration::from_secs(30)).await?;
        let before = tokens.get(&at).copied().flatten();
        let left = ctx.leave(&device, &shift, before).await?;
        ctx.same(
            &format!("cycle_{cycle}_leave"),
            "left",
            my_state(&left.body),
        );
        if cycle == 0 {
            // A left part's facts are taken like an active one's.
            let made = sim.records_made();
            sim.resume();
            tokio::time::sleep(Duration::from_secs(1)).await;
            sim.pause().await;
            sim.wait_drained(Duration::from_secs(30)).await?;
            let rejected = work.shared.ledger.lock().expect("ledger").rejected.clone();
            ctx.check(Check::new(
                "facts_of_a_left_part_are_accepted",
                sim.records_made() > made && rejected.is_empty(),
                format!(
                    "{} records made while left, rejected {rejected:?}",
                    sim.records_made() - made
                ),
            ));
        }
        // The slot is free: the spare takes it.
        let spare_in = ctx.enter(&spare, &shift, Some(spare.supports())).await?;
        ctx.same(
            &format!("cycle_{cycle}_spare_takes_the_freed_slot"),
            (200u16, "active"),
            (spare_in.status, my_state(&spare_in.body)),
        );
        let spare_token = joined_rev(&spare_in.body, &spare.id);
        // While the spare holds it, the device that left meets a full line.
        let full = ctx.enter(&device, &shift, Some(device.supports())).await?;
        ctx.same(
            &format!("cycle_{cycle}_full_while_the_spare_holds_the_slot"),
            (409u16, Some("shift_line_full")),
            (full.status, constraint(&full)),
        );
        let spare_out = ctx.leave(&spare, &shift, spare_token).await?;
        ctx.same(
            &format!("cycle_{cycle}_spare_leaves"),
            "left",
            my_state(&spare_out.body),
        );
        // The return: a new token.
        let back = ctx.enter(&device, &shift, Some(device.supports())).await?;
        let after = joined_rev(&back.body, &device.id);
        ctx.same(
            &format!("cycle_{cycle}_reenters_with_a_new_token"),
            (200u16, "active", true),
            (back.status, my_state(&back.body), after > before),
        );
        tokens.insert(at, after);
        // A leave carrying the first stay's token: the part stays active and nothing is written.
        let rev_before = ctx.office_shift(&shift).await?["rev"].as_i64();
        let stale = ctx.leave(&device, &shift, before).await?;
        let rev_after = ctx.office_shift(&shift).await?["rev"].as_i64();
        ctx.same(
            &format!("cycle_{cycle}_stale_leave_is_a_no_op"),
            ("active", rev_before),
            (my_state(&stale.body), rev_after),
        );
        sim.resume();
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    let (shared, devices, drained) = work.stop("").await;
    ctx.checks(drained);
    let office = ctx.office_shift(&shift).await?;
    ctx.same(
        "participants_after_the_cycles",
        4usize,
        super::states(&office).len(),
    );
    let mut expected: Vec<(u32, String, &str)> = (0..3)
        .map(|at| {
            let device = ctx.device(at);
            (device.index, device.id, "active")
        })
        .collect();
    expected.push((spare.index, spare.id.clone(), "left"));
    let pool = ctx.db().await?;
    let joins = super::audit_count(&pool, &shift, "shift.join").await;
    let leaves = super::audit_count(&pool, &shift, "shift.leave").await;
    let states = crate::dbcheck::participants_in(&pool, &shift, &expected).await;
    pool.close().await;
    // The opener's entry is `shift.open`; the two other first entries, the spare's first entry
    // and every return are `shift.join`; a refused entry and a stale leave write nothing.
    ctx.same("audit_joins", Ok(2 + 2 * CYCLES as i64), joins);
    ctx.same("audit_leaves", Ok(2 * CYCLES as i64), leaves);
    match states {
        Ok(checks) => ctx.checks(checks),
        Err(error) => ctx.check(Check::new("db_participants", false, error)),
    }
    // The working parts close first: the spare's left part keeps the shift open.
    let mut receipts = Vec::new();
    for device in &devices {
        receipts.push(device.close_part_ledgered(None, None, None).await?);
    }
    ctx.same(
        "closes_of_the_working_parts_leave_the_left_part_open",
        vec![true; devices.len()],
        receipts.iter().map(part_closed).collect::<Vec<_>>(),
    );
    let last = close_fact(ctx, &spare, &shift, 1, None, 0, 0, None, None).await?;
    ctx.same(
        "the_left_part_closes_the_shift",
        (Some("accepted"), false),
        (last["outcome"].as_str(), part_closed(&last)),
    );
    let found = super::reconcile(ctx, "", &shift, &shared, &devices).await;
    ctx.checks(found);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn the_leave_reenter_scenario_holds_against_a_host_in_this_process() {
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
            "cycle_0_leave",
            "facts_of_a_left_part_are_accepted",
            "cycle_2_spare_takes_the_freed_slot",
            "cycle_2_full_while_the_spare_holds_the_slot",
            "cycle_2_reenters_with_a_new_token",
            "cycle_2_stale_leave_is_a_no_op",
            "audit_joins",
            "audit_leaves",
            "participant_state_device_3",
            "the_left_part_closes_the_shift",
            "db_receipts_device_0",
        ] {
            assert!(
                result.checks.iter().any(|check| check.name == name),
                "no check {name}"
            );
        }
    }
}
