//! `close-races`: six devices close at the same instant, and the office's close of the whole
//! shift races a device's close of its part (host `routes/facts.rs`, `facts::close_part`,
//! `routes/office_shifts.rs::close_shift`: every close in `BEGIN IMMEDIATE`, every part close
//! stamping the shift's revision, the office's close over `expectedRev`).

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use serde_json::json;

use super::{
    already_closed, audit_count, close_fact, close_record, enter_all, error_code, part,
    part_closed, prefixed, scripted_work, Ctx, HostKind, Res, LOAD_S,
};
use crate::checks::Check;
use crate::gen;
use crate::profile::Profile;
use crate::report::ScenarioResult;
use crate::secret::Redactions;

pub const NAME: &str = "close-races";
/// Office-against-device races, each on a shift of its own.
const RACES: u32 = 4;
/// The line's limit: four stations and two handhelds.
const LIMIT: u32 = 6;

pub async fn run(kind: &HostKind, work_dir: &Path, base: &Profile) -> (ScenarioResult, Redactions) {
    let mut ctx = match Ctx::new(NAME, kind, work_dir, base, 4, 2).await {
        Ok(ctx) => ctx,
        Err(error) => return (super::broken(NAME, error), Redactions::default()),
    };
    let outcome = body(&mut ctx).await;
    ctx.finish(outcome).await
}

async fn body(ctx: &mut Ctx) -> Res<()> {
    let line = ctx.site.line_ids[0].clone();
    // A wizard line allows one device: the line takes all six.
    let set = ctx.set_max_stations(&line, LIMIT).await?;
    ctx.same("limit_set", 200u16, set.status);
    // N closes at once.
    let shift = ctx.plan(&line, None).await?;
    let all: Vec<usize> = (0..ctx.site.devices.len()).collect();
    let prefix = enter_all(ctx, &shift, &all).await?;
    let work = ctx.load(1, &shift, &prefix, &all);
    tokio::time::sleep(Duration::from_secs(LOAD_S)).await;
    for device in &work.devices {
        device.seal(Duration::from_secs(60)).await?;
    }
    let barrier = Arc::new(tokio::sync::Barrier::new(work.devices.len()));
    let mut tasks = Vec::new();
    for device in &work.devices {
        let (device, barrier) = (device.clone(), barrier.clone());
        tasks.push(tokio::spawn(async move {
            barrier.wait().await;
            device.close_part_ledgered(None, None, None).await
        }));
    }
    let mut receipts = Vec::new();
    for task in tasks {
        receipts.push(task.await.map_err(|error| error.to_string())??);
    }
    let n = work.devices.len();
    ctx.same(
        "n_closes_at_once_exactly_one_closes_the_shift",
        1usize,
        receipts
            .iter()
            .filter(|receipt| receipt["outcome"] == "accepted" && !part_closed(receipt))
            .count(),
    );
    ctx.same(
        "n_closes_at_once_the_others_close_their_parts",
        n - 1,
        receipts
            .iter()
            .filter(|receipt| part_closed(receipt))
            .count(),
    );
    let office = ctx.office_shift(&shift).await?;
    ctx.same(
        "n_closes_at_once_status",
        "closed",
        office["status"].as_str().unwrap_or(""),
    );
    let pool = ctx.db().await?;
    let closes = audit_count(&pool, &shift, "shift.close").await;
    let parts = audit_count(&pool, &shift, "shift.part_closed").await;
    pool.close().await;
    ctx.same("n_closes_at_once_one_shift_close_row", Ok(1), closes);
    ctx.same("n_closes_at_once_part_rows", Ok(n as i64 - 1), parts);
    let (shared, devices, drained) = work.stop("").await;
    ctx.checks(drained);
    let found = super::reconcile(ctx, "", &shift, &shared, &devices).await;
    ctx.checks(found);
    // The office against a device, on fresh shifts of three participants.
    let mut orders: BTreeMap<&str, u32> = BTreeMap::new();
    let racer = ctx.device(1);
    for race in 0..RACES {
        let p = format!("race_{race}_");
        let shift = ctx.plan(&line, None).await?;
        let issuer = enter_all(ctx, &shift, &[0, 1, 2]).await?;
        scripted_work(ctx, &racer, &shift, &issuer, 10 + race, 2).await?;
        let rev = ctx.office_shift(&shift).await?["rev"].clone();
        let barrier = Arc::new(tokio::sync::Barrier::new(2));
        let office = ctx.site.office.clone();
        let close_path = format!("/v1/office/shifts/{shift}/close");
        let office_task = {
            let barrier = barrier.clone();
            tokio::spawn(async move {
                barrier.wait().await;
                office
                    .call(
                        "POST",
                        &close_path,
                        Some(json!({ "reason": "Нагрузочная проверка: гонка закрытий", "expectedRev": rev })),
                    )
                    .await
            })
        };
        let record = close_record(
            &shift,
            &racer,
            200 + u64::from(race),
            None,
            2,
            1,
            None,
            &gen::text_of(gen::now_ms()),
        );
        let api = ctx.site.office.api.clone();
        let key = racer.key.clone();
        let device_task = {
            let barrier = barrier.clone();
            tokio::spawn(async move {
                barrier.wait().await;
                api.facts(key.expose(), &[record]).await
            })
        };
        let office_reply = office_task.await.map_err(|error| error.to_string())??;
        let receipt = device_task
            .await
            .map_err(|error| error.to_string())??
            .remove(0);
        let view = ctx.office_shift(&shift).await?;
        let racer_part = part_close(&view, &racer.id);
        let order = match (
            office_reply.status,
            error_code(&office_reply),
            already_closed(&receipt),
            part_closed(&receipt),
        ) {
            (200, _, true, false) => "office-first",
            (409, Some("stale_revision"), false, true) => "device-first",
            _ => "neither",
        };
        *orders.entry(order).or_insert(0) += 1;
        ctx.check(Check::new(
            &format!("{p}one_of_the_two_orders"),
            order != "neither",
            format!(
                "office {} {}, device receipt {receipt}",
                office_reply.status, office_reply.body
            ),
        ));
        match order {
            "office-first" => {
                ctx.same(
                    &format!("{p}office_first_closes_the_racing_part_as_the_offices"),
                    Some(("closed".to_owned(), "office_user".to_owned())),
                    racer_part,
                );
                ctx.same(
                    &format!("{p}office_first_status"),
                    "closed",
                    view["status"].as_str().unwrap_or(""),
                );
            }
            "device-first" => {
                ctx.same(
                    &format!("{p}device_first_keeps_the_devices_own_close"),
                    Some(("closed".to_owned(), "device".to_owned())),
                    racer_part,
                );
                ctx.same(
                    &format!("{p}device_first_shift_stays_active"),
                    "active",
                    view["status"].as_str().unwrap_or(""),
                );
                let retried = ctx
                    .office_close(&shift, "Нагрузочная проверка: повтор после гонки")
                    .await?;
                ctx.same(
                    &format!("{p}device_first_the_office_retries"),
                    200u16,
                    retried.status,
                );
            }
            _ => {}
        }
        let pool = ctx.db().await?;
        let forced = audit_count(&pool, &shift, "shift.force_closed").await;
        let invariants = crate::dbcheck::participant_invariants(&pool, &shift).await;
        pool.close().await;
        if order != "neither" {
            ctx.same(&format!("{p}one_forced_close_row"), Ok(1), forced);
        }
        match invariants {
            Ok(checks) => ctx.checks(prefixed(&p, checks)),
            Err(error) => ctx.check(Check::new(&format!("{p}db_invariants"), false, error)),
        }
    }
    ctx.observe("orders", json!(orders));
    ctx.note.push_str(&order_note(&orders));
    // Each order once more, sequentially and so deterministically, on fresh shifts.
    office_then_device(ctx, &line).await?;
    device_then_office(ctx, &line).await?;
    Ok(())
}

/// The office closes the shift, then a participant's close of its part arrives: the shift took
/// the part as the office's, so the device's close is `accepted` with `alreadyClosed` and kept in
/// `shift_close_events` as `already_closed` (host `facts/shift_closed.rs`, `Closing::ShiftClosed`).
async fn office_then_device(ctx: &mut Ctx, line: &str) -> Res<()> {
    let p = "office_then_device_";
    let device = ctx.device(1);
    let shift = ctx.plan(line, None).await?;
    let issuer = enter_all(ctx, &shift, &[0, 1, 2]).await?;
    scripted_work(ctx, &device, &shift, &issuer, 20, 2).await?;
    let closed = ctx
        .office_close(&shift, "Нагрузочная проверка: офис закрывает первым")
        .await?;
    ctx.same(&format!("{p}the_office_closes"), 200u16, closed.status);
    let receipt = close_fact(ctx, &device, &shift, 300, None, 2, 1, None, None).await?;
    ctx.check(Check::new(
        &format!("{p}answers_already_closed"),
        receipt["outcome"] == "accepted" && already_closed(&receipt) && !part_closed(&receipt),
        receipt.to_string(),
    ));
    let view = ctx.office_shift(&shift).await?;
    ctx.same(
        &format!("{p}part_is_the_offices"),
        Some(("closed".to_owned(), "office_user".to_owned())),
        part_close(&view, &device.id),
    );
    ctx.same(
        &format!("{p}status"),
        "closed",
        view["status"].as_str().unwrap_or(""),
    );
    let events = close_outcomes(ctx, &shift, &device.id).await;
    ctx.same(
        &format!("{p}event_recorded_already_closed"),
        Ok(vec!["already_closed".to_owned()]),
        events,
    );
    invariants(ctx, p, &shift).await
}

/// A participant closes its part (not the last), then the office closes the shift over the
/// revision it read before: the part's close stamped the shift's revision, so the office gets
/// `409 stale_revision`, and its retry over the fresh revision closes the shift
/// (host `routes/office_shifts.rs::close_shift`).
async fn device_then_office(ctx: &mut Ctx, line: &str) -> Res<()> {
    let p = "device_then_office_";
    let device = ctx.device(1);
    let shift = ctx.plan(line, None).await?;
    let issuer = enter_all(ctx, &shift, &[0, 1, 2]).await?;
    scripted_work(ctx, &device, &shift, &issuer, 21, 2).await?;
    let stale = ctx.office_shift(&shift).await?["rev"].clone();
    let receipt = close_fact(ctx, &device, &shift, 301, None, 2, 1, None, None).await?;
    ctx.check(Check::new(
        &format!("{p}part_closed"),
        receipt["outcome"] == "accepted" && part_closed(&receipt) && !already_closed(&receipt),
        receipt.to_string(),
    ));
    let events = close_outcomes(ctx, &shift, &device.id).await;
    ctx.same(
        &format!("{p}event_recorded_accepted"),
        Ok(vec!["accepted".to_owned()]),
        events,
    );
    let refused = ctx
        .site
        .office
        .call(
            "POST",
            &format!("/v1/office/shifts/{shift}/close"),
            Some(json!({
                "reason": "Нагрузочная проверка: офис по устаревшей ревизии",
                "expectedRev": stale
            })),
        )
        .await?;
    ctx.same(
        &format!("{p}stale_revision"),
        (409u16, Some("stale_revision")),
        (refused.status, error_code(&refused)),
    );
    let retried = ctx
        .office_close(&shift, "Нагрузочная проверка: повтор по свежей ревизии")
        .await?;
    ctx.same(
        &format!("{p}retry_with_the_fresh_revision"),
        200u16,
        retried.status,
    );
    let view = ctx.office_shift(&shift).await?;
    ctx.same(
        &format!("{p}keeps_the_devices_own_close"),
        Some(("closed".to_owned(), "device".to_owned())),
        part_close(&view, &device.id),
    );
    ctx.same(
        &format!("{p}status"),
        "closed",
        view["status"].as_str().unwrap_or(""),
    );
    invariants(ctx, p, &shift).await
}

/// A participant's state and who closed it, in a shift answer.
fn part_close(view: &serde_json::Value, device_id: &str) -> Option<(String, String)> {
    part(view, device_id).map(|part| {
        (
            part["state"].as_str().unwrap_or("").to_owned(),
            part["closedBy"].as_str().unwrap_or("").to_owned(),
        )
    })
}

/// The outcomes `shift_close_events` kept for `device_id`'s closes of `shift`, in order.
async fn close_outcomes(ctx: &Ctx, shift: &str, device_id: &str) -> Res<Vec<String>> {
    let pool = ctx.db().await?;
    let rows = sqlx::query_scalar(
        "SELECT outcome FROM shift_close_events WHERE shift_id = ? AND device_id = ? \
         ORDER BY received_at, rowid",
    )
    .bind(shift)
    .bind(device_id)
    .fetch_all(&pool)
    .await
    .map_err(|error| format!("shift_close_events: {error}"));
    pool.close().await;
    rows
}

/// The participant invariants of `shift`, prefixed.
async fn invariants(ctx: &mut Ctx, p: &str, shift: &str) -> Res<()> {
    let pool = ctx.db().await?;
    let found = crate::dbcheck::participant_invariants(&pool, shift).await;
    pool.close().await;
    match found {
        Ok(checks) => ctx.checks(prefixed(p, checks)),
        Err(error) => ctx.check(Check::new(&format!("{p}db_invariants"), false, error)),
    }
    Ok(())
}

/// What the office-against-device races did not exercise this run: an order no race took. Its
/// checks then did not run in a race; the sequential cases still cover both orders' outcomes.
fn order_note(orders: &BTreeMap<&str, u32>) -> String {
    let mut note = String::new();
    for order in ["office-first", "device-first"] {
        if orders.get(order).copied().unwrap_or(0) == 0 {
            note.push_str(&format!(
                "no office-against-device race ran {order} this run, so that order's race checks \
                 did not run (the sequential office_then_device_/device_then_office_ cases still \
                 check its outcome). "
            ));
        }
    }
    note
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn the_close_races_scenario_holds_against_a_host_in_this_process() {
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
            "n_closes_at_once_exactly_one_closes_the_shift",
            "n_closes_at_once_one_shift_close_row",
            "n_closes_at_once_part_rows",
            "race_0_one_of_the_two_orders",
            "race_3_one_of_the_two_orders",
            "race_3_one_forced_close_row",
            "race_3_close_events_match_device_closed_parts",
            "close_events_match_device_closed_parts",
            "office_then_device_the_office_closes",
            "office_then_device_answers_already_closed",
            "office_then_device_part_is_the_offices",
            "office_then_device_status",
            "office_then_device_event_recorded_already_closed",
            "office_then_device_shift_closed_once",
            "device_then_office_part_closed",
            "device_then_office_event_recorded_accepted",
            "device_then_office_stale_revision",
            "device_then_office_retry_with_the_fresh_revision",
            "device_then_office_keeps_the_devices_own_close",
            "device_then_office_status",
            "device_then_office_shift_closed_once",
        ] {
            assert!(
                result.checks.iter().any(|check| check.name == name),
                "no check {name}"
            );
        }
        assert!(result.observed.contains_key("orders"));
        let orders = &result.observed["orders"];
        for order in ["office-first", "device-first"] {
            let ran = orders
                .get(order)
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(0);
            assert_eq!(
                ran == 0,
                result.note.contains(order),
                "{order}: {}",
                result.note
            );
        }
    }

    #[test]
    fn a_race_order_that_never_happened_is_said_in_the_note() {
        let mut orders = BTreeMap::new();
        orders.insert("device-first", 4);
        let note = order_note(&orders);
        assert!(note.contains("office-first"), "{note}");
        assert!(!note.contains("device-first"), "{note}");
        orders.insert("office-first", 0);
        assert_eq!(order_note(&orders), note);
        orders.insert("device-first", 0);
        let both = order_note(&orders);
        assert!(
            both.contains("office-first") && both.contains("device-first"),
            "{both}"
        );
        orders.insert("office-first", 1);
        orders.insert("device-first", 3);
        assert_eq!(order_note(&orders), "");
    }
}
