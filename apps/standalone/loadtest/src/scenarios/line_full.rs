//! `line-full`: a line allows N devices in a shift and N + 1 enter at the same instant while
//! another line's shift is under load. Exactly N get in and the other is told `shift_line_full`
//! with the limit and the slots held; a leave frees a slot; a revoked device holds none, but its
//! open part keeps the shift open until the office closes it (host
//! `shift_participants::{decide_entry, active_others, open_others, line_slots_in_use}`).

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use super::{
    constraint, issuer_prefix, joined_rev, my_state, part, part_closed, send_raw, Ctx, HostKind,
    Res, LOAD_S,
};
use crate::checks::Check;
use crate::metrics::Route;
use crate::profile::Profile;
use crate::report::ScenarioResult;
use crate::secret::Redactions;

pub const NAME: &str = "line-full";
/// The line's limit; one device more than this enters at once.
const LIMIT: u32 = 3;

pub async fn run(kind: &HostKind, work_dir: &Path, base: &Profile) -> (ScenarioResult, Redactions) {
    // Five stations and a handheld: three stations and the handheld contend on line 1; the
    // office station (0) and station 4 scan on line 2 meanwhile.
    let mut ctx = match Ctx::new(NAME, kind, work_dir, base, 5, 1).await {
        Ok(ctx) => ctx,
        Err(error) => return (super::broken(NAME, error), Redactions::default()),
    };
    let outcome = body(&mut ctx).await;
    ctx.finish(outcome).await
}

async fn body(ctx: &mut Ctx) -> Res<()> {
    let line_1 = ctx.site.line_ids[0].clone();
    let line_2 = ctx.site.line_ids[1].clone();
    // The background: devices 0 and 4 work a shift of line 2 for the whole scenario. The wizard's
    // lines allow one device; line 2 takes two.
    for at in [0usize, 4] {
        let device = ctx.device(at);
        ctx.move_to_line(&device, &line_2).await?;
    }
    let widened = ctx.set_max_stations(&line_2, 2).await?;
    ctx.same("background_limit_set", 200u16, widened.status);
    let busy = ctx.plan(&line_2, None).await?;
    let busy_prefix = super::enter_all(ctx, &busy, &[0, 4]).await?;
    let background = ctx.load(1, &busy, &busy_prefix, &[0, 4]);
    // The limit, with no active shift on line 1: always taken.
    let set = ctx.set_max_stations(&line_1, LIMIT).await?;
    ctx.same("limit_set", 200u16, set.status);
    let shift = ctx.plan(&line_1, None).await?;
    // N + 1 first entries at the same instant.
    let contenders = [1usize, 2, 3, 5];
    let barrier = Arc::new(tokio::sync::Barrier::new(contenders.len()));
    let mut tasks = Vec::new();
    for at in contenders {
        let device = ctx.device(at);
        let api = ctx.site.office.api.clone();
        let barrier = barrier.clone();
        let path = format!("/v1/device/shifts/{shift}/enter");
        tasks.push(tokio::spawn(async move {
            barrier.wait().await;
            let body = json!({ "supports": device.supports() });
            let reply = send_raw(
                &api,
                device.key.expose(),
                Route::Enter,
                "POST",
                &path,
                Some(body),
            )
            .await;
            (at, reply)
        }));
    }
    let mut entries = BTreeMap::new();
    for task in tasks {
        let (at, reply) = task.await.map_err(|error| error.to_string())?;
        entries.insert(at, reply?);
    }
    let admitted: Vec<usize> = entries
        .iter()
        .filter(|(_, reply)| reply.ok())
        .map(|(at, _)| *at)
        .collect();
    let refused: Vec<usize> = entries
        .iter()
        .filter(|(_, reply)| !reply.ok())
        .map(|(at, _)| *at)
        .collect();
    ctx.observe("admitted", json!(admitted));
    ctx.observe("refused", json!(refused));
    ctx.same("entries_admitted", LIMIT as usize, admitted.len());
    ctx.same("entries_refused", 1usize, refused.len());
    let Some(&refused_at) = refused.first() else {
        return Err(format!("no entry was refused: {admitted:?} admitted"));
    };
    let refusal = entries[&refused_at].clone();
    ctx.same(
        "refusal_is_shift_line_full",
        (409u16, Some("shift_line_full")),
        (refusal.status, constraint(&refusal)),
    );
    ctx.same(
        "refusal_names_the_limit",
        Some(u64::from(LIMIT)),
        refusal
            .body
            .pointer("/error/details/maxStations")
            .and_then(Value::as_u64),
    );
    ctx.same(
        "refusal_names_the_slots_held",
        Some(u64::from(LIMIT)),
        refusal
            .body
            .pointer("/error/details/active")
            .and_then(Value::as_u64),
    );
    let office = ctx.office_shift(&shift).await?;
    ctx.same(
        "participants_after_the_burst",
        LIMIT as usize,
        super::states(&office).len(),
    );
    let prefix = admitted
        .iter()
        .find_map(|at| issuer_prefix(&entries[at].body))
        .ok_or("no admitted entry answered a snapshot")?;
    let work = ctx.load(2, &shift, &prefix, &admitted);
    tokio::time::sleep(Duration::from_secs(LOAD_S)).await;
    // A leave frees a slot: the first admitted device pauses and leaves with its token.
    let leaver_at = admitted[0];
    let leaver = ctx.device(leaver_at);
    work.of(leaver_at).pause().await;
    let token = joined_rev(&entries[&leaver_at].body, &leaver.id);
    let left = ctx.leave(&leaver, &shift, token).await?;
    ctx.same("leave_frees_the_slot", "left", my_state(&left.body));
    let late = ctx.device(refused_at);
    let entered = ctx.enter(&late, &shift, Some(late.supports())).await?;
    ctx.same(
        "a_refused_device_enters_after_a_leave",
        (200u16, "active"),
        (entered.status, my_state(&entered.body)),
    );
    let back = ctx.enter(&leaver, &shift, Some(leaver.supports())).await?;
    ctx.same(
        "the_device_that_left_meets_a_full_line",
        (409u16, Some("shift_line_full")),
        (back.status, constraint(&back)),
    );
    // A limit below the slots held is refused and names them.
    let lower = ctx.set_max_stations(&line_1, LIMIT - 1).await?;
    ctx.same(
        "a_limit_below_the_slots_held_is_refused",
        (409u16, Some("line_stations_in_use"), Some(u64::from(LIMIT))),
        (
            lower.status,
            constraint(&lower),
            lower
                .body
                .pointer("/error/details/active")
                .and_then(Value::as_u64),
        ),
    );
    // A revoked device holds no slot. The device that entered last runs no load: revoke it.
    let revoked = ctx
        .site
        .office
        .call(
            "POST",
            &format!("/v1/office/devices/{}/revoke", late.id),
            None,
        )
        .await?;
    ctx.same("revoke_answered", 200u16, revoked.status);
    let refused_key = ctx.enter(&late, &shift, Some(late.supports())).await?;
    ctx.same("a_revoked_key_is_refused", 401u16, refused_key.status);
    let back = ctx.enter(&leaver, &shift, Some(leaver.supports())).await?;
    ctx.same(
        "a_revoked_device_holds_no_slot",
        (200u16, "active"),
        (back.status, my_state(&back.body)),
    );
    work.of(leaver_at).resume();
    let office = ctx.office_shift(&shift).await?;
    ctx.same(
        "a_revoked_part_stays_open",
        Some("active"),
        part(&office, &late.id).and_then(|part| part["state"].as_str()),
    );
    tokio::time::sleep(Duration::from_secs(LOAD_S)).await;
    let (shared, devices, drained) = work.stop("").await;
    ctx.checks(drained);
    // Every working part closes; the revoked part is open, so none of them closes the shift.
    let mut receipts = Vec::new();
    for device in &devices {
        receipts.push(device.close_part_ledgered(None, None, None).await?);
    }
    ctx.same(
        "closes_leave_the_shift_open_while_a_revoked_part_is_open",
        vec![true; devices.len()],
        receipts.iter().map(part_closed).collect::<Vec<_>>(),
    );
    let office = ctx.office_shift(&shift).await?;
    ctx.same(
        "status_after_the_working_parts_closed",
        "active",
        office["status"].as_str().unwrap_or(""),
    );
    let closed = ctx
        .office_close(&shift, "Нагрузочная проверка: отозванное устройство")
        .await?;
    ctx.same("the_office_closes_the_shift", 200u16, closed.status);
    ctx.same(
        "the_office_closes_the_revoked_part",
        (Some("closed"), Some("office_user")),
        part(&closed.body, &late.id).map_or((None, None), |part| {
            (part["state"].as_str(), part["closedBy"].as_str())
        }),
    );
    let found = super::reconcile(ctx, "", &shift, &shared, &devices).await;
    ctx.checks(found);
    let mut expected: Vec<(u32, String, &str)> = devices
        .iter()
        .map(|device| (device.spec.index, device.spec.id.clone(), "closed"))
        .collect();
    expected.push((late.index, late.id.clone(), "closed"));
    let pool = ctx.db().await?;
    let found = crate::dbcheck::participants_in(&pool, &shift, &expected).await;
    pool.close().await;
    match found {
        Ok(checks) => ctx.checks(checks),
        Err(error) => ctx.check(Check::new("db_participants", false, error)),
    }
    // The background shift: closed by its last part, and exact.
    let (bg_shared, bg_devices, drained) = background.stop("background_").await;
    ctx.checks(drained);
    let mut last = None;
    for device in &bg_devices {
        last = Some(device.close_part_ledgered(None, None, None).await?);
    }
    ctx.same(
        "background_shift_closed_by_its_last_part",
        Some(false),
        last.as_ref().map(part_closed),
    );
    let found = super::reconcile(ctx, "background_", &busy, &bg_shared, &bg_devices).await;
    ctx.checks(found);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn the_line_full_scenario_holds_against_a_host_in_this_process() {
        let work = tempfile::tempdir().unwrap();
        let profile = Profile::preset("tiny").unwrap();
        let (result, secrets) = run(&HostKind::InProcess, work.path(), &profile).await;
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
            "entries_admitted",
            "refusal_names_the_limit",
            "a_refused_device_enters_after_a_leave",
            "a_limit_below_the_slots_held_is_refused",
            "a_revoked_key_is_refused",
            "a_revoked_device_holds_no_slot",
            "closes_leave_the_shift_open_while_a_revoked_part_is_open",
            "the_office_closes_the_revoked_part",
            "db_code_owners",
            "background_db_code_owners",
        ] {
            assert!(
                result.checks.iter().any(|check| check.name == name),
                "no check {name}"
            );
        }
        assert!(!secrets.is_empty());
    }
}
