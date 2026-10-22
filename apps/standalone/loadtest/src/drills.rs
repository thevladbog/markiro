//! The ways a shared shift ends, each on a shift of its own with a few
//! scans: the devices close their parts in each order, the office closes
//! the whole shift while one part is open (and the part's later scans are
//! late, not lost), and the last closer who gives no reason leaves the
//! office to give it; and a leave of an earlier stay (an old `joinedRev`)
//! never undoes a re-entry.

use std::sync::Arc;

use serde_json::{json, Value};

use crate::checks::Check;
use crate::engine::{Block, Engine, EngineCfg};
use crate::gen::{self, DeviceClock};
use crate::profile::{CloseOrder, Profile};
use crate::report::DrillResult;
use crate::rng::Rng;
use crate::site::{plan_and_enter, DeviceSpec, Res, ShiftInfo, Site};

/// Scans each device makes in a drill: two full boxes and one more.
fn scans_per_device(profile: &Profile) -> u32 {
    2 * profile.box_capacity + 1
}

/// The scans every drill makes together: the five drills that scan, of every
/// device, and the three late scans of the forced close (`stale-leave` makes
/// none).
pub fn scans_made(profile: &Profile, devices: usize) -> u64 {
    5 * devices as u64 * u64::from(scans_per_device(profile)) + 3
}

/// The indices of `devices` in the order they close in.
pub fn closing_order(devices: &[DeviceSpec], order: CloseOrder, rng: &mut Rng) -> Vec<usize> {
    let mut indices: Vec<usize> = (0..devices.len()).collect();
    match order {
        CloseOrder::StationsFirst => indices.sort_by_key(|at| (devices[*at].is_handheld(), *at)),
        CloseOrder::HandheldsFirst => indices.sort_by_key(|at| (!devices[*at].is_handheld(), *at)),
        CloseOrder::Shuffled => {
            for at in (1..indices.len()).rev() {
                indices.swap(at, rng.range(0, at as u64 + 1) as usize);
            }
        }
    }
    indices
}

/// What a device did in a drill.
struct Work {
    boxes: u32,
}

/// `scans` scans of fresh codes into boxes, the boxes and pallets closed,
/// everything sent in order. Every receipt must be `accepted`.
async fn work(
    site: &Site,
    device: &DeviceSpec,
    shift: &ShiftInfo,
    profile: &Profile,
    run: u32,
    scans: u32,
) -> Res<Work> {
    let cfg = EngineCfg {
        device: device.index,
        run,
        shift_id: shift.id.clone(),
        issuer_prefix: shift.issuer_prefix.clone(),
        box_capacity: profile.box_capacity,
        pallet_boxes: profile.pallet_boxes,
        box_block_size: profile.box_block_size,
        pallet_block_size: profile.pallet_block_size,
    };
    let mut engine = Engine::new(
        cfg,
        profile.seed ^ u64::from(run) ^ (u64::from(device.index) << 32),
    );
    let api = &site.office.api;
    for extension in [0u8, 1] {
        if extension == 1 && profile.pallet_boxes == 0 {
            continue;
        }
        let request_id = engine.fresh_id();
        let reply = api
            .send(
                crate::metrics::Route::SsccBlock,
                "POST",
                "/v1/device/sscc/blocks",
                crate::api::Auth { device_key: Some(&device.key), session: None },
                Some(&json!({ "requestId": request_id, "issuerPrefix": shift.issuer_prefix, "extension": extension })),
            )
            .await
            .map_err(|error| format!("sscc block: {error:?}"))?;
        let field = |name: &str| reply.body.get(name).and_then(Value::as_u64);
        let (Some(from), Some(to), Some(id)) = (
            field("fromSerial"),
            field("toSerial"),
            reply.body.get("id").and_then(Value::as_str),
        ) else {
            return Err(format!("sscc block: {} {}", reply.status, reply.body));
        };
        engine.add_block(extension, Block::new(id, from, to));
    }
    for _ in 0..scans {
        let code = engine.next_code();
        engine.scan_ok(&code, None);
    }
    if !engine.close_open() {
        return Err(
            "a drill's block ran out of serials: raise boxBlockSize or palletBlockSize".to_owned(),
        );
    }
    loop {
        let batch = engine.batch(100);
        if batch.is_empty() {
            break;
        }
        let records: Vec<Value> = batch.iter().map(|queued| queued.record.clone()).collect();
        let receipts = api.facts(&device.key, &records).await?;
        if let Some(bad) = receipts
            .iter()
            .find(|receipt| receipt["outcome"] != "accepted")
        {
            return Err(format!("a drill's fact was not accepted: {bad}"));
        }
        engine.ack(batch.len());
    }
    Ok(Work {
        boxes: engine.boxes_closed as u32,
    })
}

/// A device's close of its part, straight to the host.
async fn close(
    site: &Site,
    device: &DeviceSpec,
    shift: &str,
    planned: Option<u32>,
    actual: u32,
    boxes: u32,
    reason: Option<&str>,
) -> Res<Value> {
    // The record's id is the device's and the shift's own: a drill on another
    // shift must not meet this one's receipt (the same id with another payload
    // is a `payload_mismatch`).
    let seed = shift.bytes().fold(0xC105E_u64, |seed, byte| {
        seed.wrapping_mul(131).wrapping_add(u64::from(byte))
    });
    let mut rng = Rng::new(seed ^ u64::from(device.index));
    let mut clock = DeviceClock::new();
    let data = gen::shift_closed(planned, actual, boxes, reason, &clock.tick());
    let record = gen::record(
        &rng.uuid(),
        markiro_proto::FactKind::ShiftClosed,
        shift,
        data,
    );
    let mut receipts = site.office.api.facts(&device.key, &[record]).await?;
    Ok(receipts.remove(0))
}

async fn office_shift(site: &Site, shift: &str) -> Res<Value> {
    site.office
        .ok("GET", &format!("/v1/office/shifts/{shift}"), None)
        .await
}

fn states(office: &Value) -> Vec<String> {
    office
        .get("participants")
        .and_then(Value::as_array)
        .map(|parts| {
            parts
                .iter()
                .filter_map(|part| part["state"].as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

struct Drill<'a> {
    site: &'a Site,
    profile: &'a Profile,
    run: u32,
}

impl Drill<'_> {
    /// A fresh shift with every device's work done, and the shift's total checked.
    async fn start(&self, planned: Option<u32>) -> Res<(ShiftInfo, Vec<Work>, Vec<Check>)> {
        let shift = plan_and_enter(self.site, self.profile, planned).await?;
        let scans = scans_per_device(self.profile);
        let site = Arc::new(self.site.clone());
        let mut tasks = Vec::new();
        for device in &self.site.devices {
            let (site, device) = (site.clone(), device.clone());
            let (shift, profile, run) = (shift.clone(), self.profile.clone(), self.run);
            tasks.push(tokio::spawn(async move {
                work(&site, &device, &shift, &profile, run, scans).await
            }));
        }
        let mut works = Vec::new();
        for task in tasks {
            works.push(task.await.map_err(|error| error.to_string())??);
        }
        let expected = u64::from(scans) * works.len() as u64;
        let office = office_shift(self.site, &shift.id).await?;
        let checks = vec![
            Check::same(
                "units_of_the_shift",
                expected,
                office
                    .pointer("/totals/acceptedUnits")
                    .and_then(Value::as_u64)
                    .unwrap_or(0),
            ),
            Check::same(
                "participants_active",
                vec!["active".to_owned(); works.len()],
                states(&office),
            ),
        ];
        Ok((shift, works, checks))
    }
}

/// Every device closes its part, in `order`; the last closer closes the shift.
async fn order_drill(
    site: &Site,
    profile: &Profile,
    run: u32,
    name: &str,
    order: CloseOrder,
) -> DrillResult {
    let drill = Drill { site, profile, run };
    let outcome: Res<Vec<Check>> = async {
        let (shift, works, mut checks) = drill.start(None).await?;
        let scans = scans_per_device(profile);
        let mut rng = Rng::new(profile.seed ^ u64::from(run));
        let sequence = closing_order(&site.devices, order, &mut rng);
        for (position, at) in sequence.iter().enumerate() {
            let receipt = close(
                site,
                &site.devices[*at],
                &shift.id,
                None,
                scans,
                works[*at].boxes,
                None,
            )
            .await?;
            let last = position + 1 == sequence.len();
            let part_closed = receipt.pointer("/details/partClosed") == Some(&Value::Bool(true));
            checks.push(Check::same(
                &format!("close_{position}_outcome"),
                "accepted",
                receipt["outcome"].as_str().unwrap_or(""),
            ));
            checks.push(Check::same(
                &format!("close_{position}_closes_only_the_part"),
                !last,
                part_closed,
            ));
            let office = office_shift(site, &shift.id).await?;
            checks.push(Check::same(
                &format!("status_after_close_{position}"),
                if last { "closed" } else { "active" },
                office["status"].as_str().unwrap_or(""),
            ));
        }
        let office = office_shift(site, &shift.id).await?;
        checks.push(Check::same(
            "participants_closed",
            vec!["closed".to_owned(); works.len()],
            states(&office),
        ));
        Ok(checks)
    }
    .await;
    result(name, outcome)
}

/// The office closes the shift while the last device has not: its later scans are accepted as late.
async fn force_drill(site: &Site, profile: &Profile, run: u32) -> DrillResult {
    let drill = Drill { site, profile, run };
    let outcome: Res<Vec<Check>> = async {
        let (shift, works, mut checks) = drill.start(None).await?;
        let scans = scans_per_device(profile);
        let held = site.devices.len() - 1;
        for at in 0..held {
            close(site, &site.devices[at], &shift.id, None, scans, works[at].boxes, None).await?;
        }
        let office = office_shift(site, &shift.id).await?;
        checks.push(Check::same("status_before_the_forced_close", "active", office["status"].as_str().unwrap_or("")));
        let closed = site
            .office
            .ok(
                "POST",
                &format!("/v1/office/shifts/{}/close", shift.id),
                Some(json!({ "reason": "Нагрузочная проверка принудительного закрытия", "expectedRev": office["rev"] })),
            )
            .await?;
        checks.push(Check::same("status_after_the_forced_close", "closed", closed["status"].as_str().unwrap_or("")));
        checks.push(Check::same("participants_closed", vec!["closed".to_owned(); site.devices.len()], states(&closed)));
        // The part that was still open sends its codes: late, accepted, nothing reopens.
        let mut engine = Engine::new(
            EngineCfg {
                device: site.devices[held].index,
                run: run + 500,
                shift_id: shift.id.clone(),
                issuer_prefix: shift.issuer_prefix.clone(),
                box_capacity: profile.box_capacity,
                pallet_boxes: 0,
                box_block_size: profile.box_block_size,
                pallet_block_size: profile.pallet_block_size,
            },
            profile.seed ^ 0x1A7E,
        );
        for _ in 0..3 {
            let code = engine.next_code();
            engine.scan_ok(&code, None);
        }
        let records: Vec<Value> = engine.batch(10).iter().map(|queued| queued.record.clone()).collect();
        let receipts = site.office.api.facts(&site.devices[held].key, &records).await?;
        checks.push(Check::same("late_scans_accepted", 3usize, receipts.iter().filter(|r| r["outcome"] == "accepted").count()));
        let office = office_shift(site, &shift.id).await?;
        checks.push(Check::same("status_after_late_scans", "closed", office["status"].as_str().unwrap_or("")));
        Ok(checks)
    }
    .await;
    result("force-close", outcome)
}

/// The plan differs from what was made and the last closer gives no reason:
/// the shift closes, says so, and the office gives the reason afterwards.
async fn missing_reason_drill(site: &Site, profile: &Profile, run: u32) -> DrillResult {
    let drill = Drill { site, profile, run };
    let outcome: Res<Vec<Check>> = async {
        let scans = scans_per_device(profile);
        let total = scans * site.devices.len() as u32;
        let planned = total + 7;
        let (shift, works, mut checks) = drill.start(Some(planned)).await?;
        let last = site.devices.len() - 1;
        let mut receipts = Vec::new();
        for at in 0..site.devices.len() {
            receipts.push(close(site, &site.devices[at], &shift.id, Some(planned), scans, works[at].boxes, None).await?);
        }
        checks.push(Check::same(
            "last_receipt_says_the_reason_is_missing",
            true,
            receipts[last].pointer("/details/reasonMissing") == Some(&Value::Bool(true)),
        ));
        let office = office_shift(site, &shift.id).await?;
        checks.push(Check::same("status_closed", "closed", office["status"].as_str().unwrap_or("")));
        checks.push(Check::same("close_reason_missing_flag", true, office["closeReasonMissing"] == Value::Bool(true)));
        let given = site
            .office
            .ok(
                "PUT",
                &format!("/v1/office/shifts/{}/close-reason", shift.id),
                Some(json!({ "reasonCode": "production_order_changed", "expectedRev": office["rev"] })),
            )
            .await?;
        checks.push(Check::same("the_office_gave_the_reason", false, given["closeReasonMissing"] == Value::Bool(true)));
        Ok(checks)
    }
    .await;
    result("missing-reason", outcome)
}

/// A device's `POST` straight to the host: the body of a 2xx, else an error naming the answer.
async fn device_post(
    site: &Site,
    device: &DeviceSpec,
    route: crate::metrics::Route,
    path: &str,
    body: Option<Value>,
) -> Res<Value> {
    let reply = site
        .office
        .api
        .send(
            route,
            "POST",
            path,
            crate::api::Auth {
                device_key: Some(&device.key),
                session: None,
            },
            body.as_ref(),
        )
        .await
        .map_err(|error| format!("POST {path}: {error:?}"))?;
    if reply.ok() {
        Ok(reply.body)
    } else {
        Err(format!("POST {path}: {} {}", reply.status, reply.body))
    }
}

/// `device`'s leave token in a shift as an answer names it (`participants[].joinedRev`).
fn joined_rev(shift: &Value, device: &DeviceSpec) -> Option<u64> {
    shift
        .get("participants")
        .and_then(Value::as_array)?
        .iter()
        .find(|part| part["deviceId"] == Value::String(device.id.clone()))?
        .get("joinedRev")
        .and_then(Value::as_u64)
}

/// A leave of an earlier stay must not undo a re-entry (host D5 as amended): the
/// first device leaves with its token, enters again (a return from `left`
/// stamps a new token), and a leave carrying the first token is answered with
/// the part still `active`, no revision and nothing written. No scans; the
/// office closes the shift at the end, so the line is free again.
async fn stale_leave_drill(site: &Site, profile: &Profile) -> DrillResult {
    let outcome: Res<Vec<Check>> = async {
        let shift = plan_and_enter(site, profile, None).await?;
        let device = &site.devices[0];
        let enter = format!("/v1/device/shifts/{}/enter", shift.id);
        let leave = format!("/v1/device/shifts/{}/leave", shift.id);
        let mut checks = Vec::new();
        let first = joined_rev(&office_shift(site, &shift.id).await?, device)
            .ok_or("the participant names no joinedRev (a host before the leave token)")?;
        let left = device_post(
            site,
            device,
            crate::metrics::Route::Other,
            &leave,
            Some(json!({ "joinedRev": first })),
        )
        .await?;
        checks.push(Check::same("leave_with_the_current_token", "left", left["myState"].as_str().unwrap_or("")));
        let entered = device_post(
            site,
            device,
            crate::metrics::Route::Enter,
            &enter,
            Some(json!({ "supports": device.supports() })),
        )
        .await?;
        checks.push(Check::same("entered_again", "active", entered["myState"].as_str().unwrap_or("")));
        checks.push(Check::same(
            "a_return_stamps_a_new_token",
            true,
            joined_rev(&entered, device).is_some_and(|rev| rev > first),
        ));
        let before = office_shift(site, &shift.id).await?;
        let stale = device_post(
            site,
            device,
            crate::metrics::Route::Other,
            &leave,
            Some(json!({ "joinedRev": first })),
        )
        .await?;
        checks.push(Check::same("a_stale_leave_leaves_the_part_active", "active", stale["myState"].as_str().unwrap_or("")));
        let after = office_shift(site, &shift.id).await?;
        checks.push(Check::same("a_stale_leave_takes_no_revision", before["rev"].as_u64(), after["rev"].as_u64()));
        checks.push(Check::same(
            "participants_after_the_stale_leave",
            vec!["active".to_owned(); site.devices.len()],
            states(&after),
        ));
        let closed = site
            .office
            .ok(
                "POST",
                &format!("/v1/office/shifts/{}/close", shift.id),
                Some(json!({ "reason": "Нагрузочная проверка устаревшего выхода", "expectedRev": after["rev"] })),
            )
            .await?;
        checks.push(Check::same("status_after_the_drill", "closed", closed["status"].as_str().unwrap_or("")));
        Ok(checks)
    }
    .await;
    result("stale-leave", outcome)
}

fn result(name: &str, outcome: Res<Vec<Check>>) -> DrillResult {
    DrillResult {
        name: name.to_owned(),
        checks: outcome.unwrap_or_else(|error| vec![Check::new("drill_ran", false, error)]),
    }
}

/// Every drill, one after the other, each on a shift of its own. The run's
/// shift is closed by now, so the line is free.
pub async fn run_all(site: &Site, profile: &Profile, run: u32) -> Vec<DrillResult> {
    let mut results = Vec::new();
    results.push(
        order_drill(
            site,
            profile,
            run + 1,
            "close-stations-first",
            CloseOrder::StationsFirst,
        )
        .await,
    );
    results.push(
        order_drill(
            site,
            profile,
            run + 2,
            "close-handhelds-first",
            CloseOrder::HandheldsFirst,
        )
        .await,
    );
    results.push(
        order_drill(
            site,
            profile,
            run + 3,
            "close-shuffled",
            CloseOrder::Shuffled,
        )
        .await,
    );
    results.push(force_drill(site, profile, run + 4).await);
    results.push(missing_reason_drill(site, profile, run + 5).await);
    results.push(stale_leave_drill(site, profile).await);
    results
}

#[cfg(test)]
mod tests {
    use markiro_proto::DeviceKind;

    use super::*;

    fn devices() -> Vec<DeviceSpec> {
        [
            DeviceKind::Station,
            DeviceKind::Handheld,
            DeviceKind::Station,
            DeviceKind::Handheld,
        ]
        .into_iter()
        .enumerate()
        .map(|(index, kind)| DeviceSpec {
            index: index as u32,
            kind,
            id: format!("d{index}"),
            key: String::new(),
            name: String::new(),
        })
        .collect()
    }

    #[test]
    fn the_close_orders_put_stations_and_handhelds_where_they_say() {
        let devices = devices();
        let mut rng = Rng::new(1);
        assert_eq!(
            closing_order(&devices, CloseOrder::StationsFirst, &mut rng),
            vec![0, 2, 1, 3]
        );
        assert_eq!(
            closing_order(&devices, CloseOrder::HandheldsFirst, &mut rng),
            vec![1, 3, 0, 2]
        );
        let mut shuffled = closing_order(&devices, CloseOrder::Shuffled, &mut rng);
        shuffled.sort_unstable();
        assert_eq!(shuffled, vec![0, 1, 2, 3]);
        assert_eq!(
            closing_order(&devices, CloseOrder::Shuffled, &mut Rng::new(5)),
            closing_order(&devices, CloseOrder::Shuffled, &mut Rng::new(5))
        );
    }

    #[test]
    fn the_drills_scans_are_counted_for_the_last_backup() {
        let smoke = Profile::preset("smoke").unwrap();
        // 25 scans a device, six devices, five drills that scan (`stale-leave` makes none), and the three late ones.
        assert_eq!(scans_made(&smoke, 6), 5 * 6 * 25 + 3);
    }
}
