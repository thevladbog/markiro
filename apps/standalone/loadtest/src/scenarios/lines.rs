//! `lines`: three lines with different limits, each with its shared shift under load at the same
//! time. Nothing leaks between them but what the host shares on purpose: the registry of codes is
//! the site's, the totals are each shift's (host `enter_shift`, `list_device_shifts`,
//! `facts::apply`, `facts/registry.rs::claim`, `shift_totals`).

use std::path::Path;
use std::time::Duration;

use markiro_proto::FactKind;
use serde_json::Value;

use super::{
    constraint, enter_all, part_closed, prefixed, scripted_scan, Ctx, HostKind, Load, Res, LOAD_S,
};
use crate::checks::Check;
use crate::gen;
use crate::metrics::Route;
use crate::profile::Profile;
use crate::report::ScenarioResult;
use crate::rng::Rng;
use crate::secret::Redactions;

pub const NAME: &str = "lines";
/// (line index, its limit, its devices).
const LAYOUT: [(usize, u32, &[usize]); 3] = [(0, 2, &[0, 1]), (1, 3, &[2, 3, 4]), (2, 1, &[5])];

pub async fn run(kind: &HostKind, work_dir: &Path, base: &Profile) -> (ScenarioResult, Redactions) {
    let mut ctx = match Ctx::new(NAME, kind, work_dir, base, 4, 2).await {
        Ok(ctx) => ctx,
        Err(error) => return (super::broken(NAME, error), Redactions::default()),
    };
    let outcome = body(&mut ctx).await;
    ctx.finish(outcome).await
}

/// A shift's accepted units as the office reads them.
async fn units(ctx: &Ctx, shift: &str) -> Res<u64> {
    ctx.office_shift(shift)
        .await?
        .pointer("/totals/acceptedUnits")
        .and_then(Value::as_u64)
        .ok_or_else(|| format!("no acceptedUnits for {shift}"))
}

async fn body(ctx: &mut Ctx) -> Res<()> {
    for (line_at, max, members) in LAYOUT {
        let line = ctx.site.line_ids[line_at].clone();
        if line_at != 0 {
            for at in members {
                let device = ctx.device(*at);
                ctx.move_to_line(&device, &line).await?;
            }
        }
        let set = ctx.set_max_stations(&line, max).await?;
        ctx.same(&format!("line_{line_at}_limit_set"), 200u16, set.status);
    }
    let mut shifts: Vec<String> = Vec::new();
    let mut loads: Vec<Load> = Vec::new();
    for (k, (line_at, _, members)) in LAYOUT.into_iter().enumerate() {
        let line = ctx.site.line_ids[line_at].clone();
        let shift = ctx.plan(&line, None).await?;
        let prefix = enter_all(ctx, &shift, members).await?;
        loads.push(ctx.load(1 + k as u32, &shift, &prefix, members));
        shifts.push(shift);
    }
    tokio::time::sleep(Duration::from_secs(LOAD_S)).await;
    // While the three loads run: nothing crosses a line.
    let first = ctx.device(0);
    let foreign = ctx
        .enter(&first, &shifts[1], Some(first.supports()))
        .await?;
    ctx.same(
        "entry_into_another_lines_shift_is_refused",
        (409u16, Some("shift_line")),
        (foreign.status, constraint(&foreign)),
    );
    let lone = ctx.device(5);
    let list = ctx
        .send(&lone, Route::Other, "GET", "/v1/device/shifts", None)
        .await?;
    let listed: Vec<String> = list.body["shifts"]
        .as_array()
        .map(|all| {
            all.iter()
                .filter(|item| item["status"] != "closed")
                .filter_map(|item| item["id"].as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    ctx.same(
        "a_device_lists_only_its_lines_open_shifts",
        vec![shifts[2].clone()],
        listed,
    );
    let mut rng = Rng::new(ctx.profile.seed ^ 0x11E5);
    let stray = gen::record(
        &rng.uuid(),
        FactKind::Scan,
        &shifts[1],
        gen::scan_ok(
            &gen::Code::new(900, 0, 1),
            &rng.uuid(),
            &gen::text_of(gen::now_ms()),
        ),
    );
    let receipts = ctx
        .site
        .office
        .api
        .facts(first.key.expose(), &[stray])
        .await?;
    ctx.same(
        "a_fact_for_a_shift_not_entered_is_rejected",
        (Some("rejected"), Some("not_entered")),
        (
            receipts[0]["outcome"].as_str(),
            receipts[0]["code"].as_str(),
        ),
    );
    // A line's limit is held against its own slots only: line 1 (2 of 2 held) is told 2, line 2
    // (3 of 3 held) is told 3, whatever the busiest shift of another line holds.
    for (line_at, max, _) in LAYOUT.into_iter().take(2) {
        let line = ctx.site.line_ids[line_at].clone();
        let lower = ctx.set_max_stations(&line, max - 1).await?;
        ctx.same(
            &format!("line_{line_at}_limit_below_its_own_slots_is_refused"),
            (409u16, Some("line_stations_in_use"), Some(u64::from(max))),
            (
                lower.status,
                constraint(&lower),
                lower
                    .body
                    .pointer("/error/details/active")
                    .and_then(Value::as_u64),
            ),
        );
    }
    tokio::time::sleep(Duration::from_secs(LOAD_S)).await;
    // Each shift is its own: exact against its own ledger, its totals and parts its own.
    let mut stopped = Vec::new();
    for (k, load) in loads.into_iter().enumerate() {
        let (shared, devices, drained) = load.stop(&format!("shift_{k}_")).await;
        ctx.checks(drained);
        stopped.push((shared, devices));
    }
    for (k, (shared, devices)) in stopped.iter().enumerate() {
        let p = format!("shift_{k}_");
        let found = super::reconcile(ctx, &p, &shifts[k], shared, devices).await;
        ctx.checks(found);
        let view = ctx.office_shift(&shifts[k]).await?;
        let expected = shared
            .ledger
            .lock()
            .expect("ledger")
            .expected()
            .distinct_accepted_codes;
        ctx.same(
            &format!("{p}office_units_are_this_shifts_own"),
            Some(expected),
            view.pointer("/totals/acceptedUnits")
                .and_then(Value::as_u64),
        );
        let mut named: Vec<String> = view["byDevice"]
            .as_array()
            .map(|parts| {
                parts
                    .iter()
                    .filter_map(|part| part["deviceId"].as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default();
        named.sort();
        let mut own: Vec<String> = devices
            .iter()
            .map(|device| device.spec.id.clone())
            .collect();
        own.sort();
        ctx.same(&format!("{p}by_device_names_only_its_devices"), own, named);
    }
    // The registry is the site's: scripted scans of two fresh codes across lines 1 and 2.
    let other = ctx.device(2);
    let before = (units(ctx, &shifts[0]).await?, units(ctx, &shifts[1]).await?);
    let at = gen::now_ms() - 120_000;
    let late = gen::Code::new(901, 0, 1);
    let owner = scripted_scan(ctx, &first, &shifts[0], &late, at, 1).await?;
    let loser = scripted_scan(ctx, &other, &shifts[1], &late, at + 10_000, 2).await?;
    ctx.same(
        "the_first_scan_owns_the_code",
        Some("accepted"),
        owner["outcome"].as_str(),
    );
    ctx.same(
        "a_later_scan_on_another_line_is_a_conflict_naming_the_owner_shift",
        (Some("conflict"), Some(shifts[0].as_str())),
        (
            loser["outcome"].as_str(),
            loser
                .pointer("/details/winner/shiftId")
                .and_then(Value::as_str),
        ),
    );
    let early = gen::Code::new(901, 0, 2);
    let owner = scripted_scan(ctx, &first, &shifts[0], &early, at + 20_000, 3).await?;
    let taker = scripted_scan(ctx, &other, &shifts[1], &early, at, 4).await?;
    ctx.same(
        "an_earlier_scan_on_another_line_takes_the_code",
        (Some("accepted"), Some("accepted")),
        (owner["outcome"].as_str(), taker["outcome"].as_str()),
    );
    let after = (units(ctx, &shifts[0]).await?, units(ctx, &shifts[1]).await?);
    // Line 1's shift gained `late` and gained then lost `early`; line 2's gained `early`.
    ctx.same(
        "totals_follow_the_owner_shift",
        (before.0 + 1, before.1 + 1),
        after,
    );
    let pool = ctx.db().await?;
    let owned: Result<Option<String>, String> =
        sqlx::query_scalar("SELECT shift_id FROM code_owners WHERE code_hash = ?")
            .bind(&early.hash)
            .fetch_optional(&pool)
            .await
            .map_err(|error| error.to_string());
    pool.close().await;
    ctx.same(
        "the_code_moved_to_the_earlier_scans_shift",
        Ok(Some(shifts[1].clone())),
        owned,
    );
    // Each shift closed by its own devices, line 3's first: the others stay active.
    for k in (0..shifts.len()).rev() {
        let (_, devices) = &stopped[k];
        let mut last = None;
        for device in devices {
            last = Some(device.close_part_ledgered(None, None, None).await?);
        }
        ctx.same(
            &format!("shift_{k}_closed_by_its_last_part"),
            Some(false),
            last.as_ref().map(part_closed),
        );
        for (j, other_shift) in shifts.iter().enumerate().take(k) {
            let view = ctx.office_shift(other_shift).await?;
            ctx.same(
                &format!("closing_shift_{k}_leaves_shift_{j}_active"),
                "active",
                view["status"].as_str().unwrap_or(""),
            );
        }
        let pool = ctx.db().await?;
        let invariants = crate::dbcheck::participant_invariants(&pool, &shifts[k]).await;
        pool.close().await;
        match invariants {
            Ok(checks) => ctx.checks(prefixed(&format!("shift_{k}_closed_"), checks)),
            Err(error) => ctx.check(Check::new(
                &format!("shift_{k}_db_invariants"),
                false,
                error,
            )),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn the_lines_scenario_holds_against_a_host_in_this_process() {
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
            "entry_into_another_lines_shift_is_refused",
            "a_device_lists_only_its_lines_open_shifts",
            "a_fact_for_a_shift_not_entered_is_rejected",
            "shift_0_db_code_owners",
            "shift_1_by_device_names_only_its_devices",
            "shift_2_office_units_are_this_shifts_own",
            "a_later_scan_on_another_line_is_a_conflict_naming_the_owner_shift",
            "totals_follow_the_owner_shift",
            "the_code_moved_to_the_earlier_scans_shift",
            "closing_shift_2_leaves_shift_0_active",
            "shift_0_closed_by_its_last_part",
        ] {
            assert!(
                result.checks.iter().any(|check| check.name == name),
                "no check {name}"
            );
        }
    }
}
