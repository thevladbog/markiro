//! The multi-station scenarios (plan `2026-10-22-multi-station-load-test-scenarios.md`): what
//! the main run does not exercise, each on a fresh host and a fresh site of its own, after the
//! main run, with metrics of its own. A scenario's checks are correctness checks (a failure is a
//! defect to report); its latencies and its deliberate refusals are recorded, never judged by
//! the profile's thresholds. A scenario that needs what the run's host mode lacks says so
//! (`judged: false`) instead of passing.

pub mod backup_mid_close;
pub mod capability;
pub mod close_races;
pub mod closed_part;
pub mod leave_reenter;
pub mod line_full;
pub mod lines;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Instant;

use markiro_proto::FactKind;
use serde_json::{json, Value};
use sqlx::SqlitePool;
use tokio::task::JoinHandle;

use crate::api::{pinned_client, Api, Auth, Reply, REQUEST_TIMEOUT};
use crate::checks::Check;
use crate::dbcheck;
use crate::device::{Shared, SimDevice};
use crate::engine::{Block, Engine, EngineCfg};
use crate::gen;
use crate::host::Host;
use crate::metrics::{Metrics, Route};
use crate::profile::Profile;
use crate::report::ScenarioResult;
use crate::rng::Rng;
use crate::site::{provision_site, DeviceSpec, Site};

pub type Res<T> = Result<T, String>;

/// The scenarios that need a host this harness spawned (a kill, a stop and a restart on the
/// same port and data folder); with another host they are not judged.
pub const SPAWN_ONLY: &[&str] = &["kill-restart", "outage"];

/// How long a scenario's devices scan between its steps, in seconds.
pub const LOAD_S: u64 = 3;

/// The host mode the run uses, and so every scenario's.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostKind {
    InProcess,
    Spawn { bin: PathBuf },
    Attach,
}

/// A scenario's load: no link drops, no injected duplicates and no races, so its ledger
/// reconciles exactly; resends are kept.
pub fn quiet(base: &Profile) -> Profile {
    let mut profile = base.clone();
    profile.mean_offline_s = 0.0;
    profile.late_dup_rate = 0.0;
    profile.checked_dup_rate = 0.0;
    profile.race_rate = 0.0;
    profile.backup_at = Vec::new();
    profile.scenarios = Vec::new();
    profile
}

fn result(name: &str, judged: bool, note: &str, checks: Vec<Check>) -> ScenarioResult {
    ScenarioResult {
        name: name.to_owned(),
        judged,
        note: note.to_owned(),
        duration_ms: 0,
        checks,
        observed: BTreeMap::new(),
        latency: BTreeMap::new(),
        errors: BTreeMap::new(),
    }
}

/// A scenario this run cannot judge, and why.
pub fn not_judged(name: &str, note: &str) -> ScenarioResult {
    result(name, false, note, Vec::new())
}

/// A scenario that could not even start: one failed check naming why.
pub fn broken(name: &str, error: String) -> ScenarioResult {
    result(
        name,
        true,
        "",
        vec![Check::new("scenario_ran", false, error)],
    )
}

/// One scenario's host, site and findings.
pub struct Ctx {
    pub name: String,
    pub host: Host,
    pub metrics: Arc<Metrics>,
    pub site: Site,
    /// The scenario's (quiet) profile; its devices are the scenario's.
    pub profile: Profile,
    /// `<work>/scenarios/<name>`: the host's data, its log, copies and restores.
    pub dir: PathBuf,
    pub kind: HostKind,
    /// A scenario that injects faults: requests without an answer and ERROR lines of the host's
    /// log are expected, and recorded instead of checked.
    pub faults: bool,
    /// Paths a judged run did not exercise this time, said in the report.
    pub note: String,
    checks: Vec<Check>,
    observed: BTreeMap<String, Value>,
}

impl Ctx {
    /// A fresh host in `kind`'s mode on `<work_dir>/scenarios/<name>/data` and a site of
    /// `stations` stations and `handhelds` handhelds, all on the first line, no shift.
    pub async fn new(
        name: &str,
        kind: &HostKind,
        work_dir: &Path,
        base: &Profile,
        stations: u32,
        handhelds: u32,
    ) -> Res<Ctx> {
        let dir = work_dir.join("scenarios").join(name);
        std::fs::create_dir_all(&dir).map_err(|error| format!("{}: {error}", dir.display()))?;
        let data = dir.join("data");
        let host = match kind {
            HostKind::InProcess => Host::in_process(&data).await,
            HostKind::Spawn { bin } => {
                Host::spawned(bin, &data, &dir.join("host-stdout.log")).await
            }
            HostKind::Attach => return Err("attach: no fresh host for a scenario".to_owned()),
        }
        .map_err(|error| error.to_string())?;
        let mut profile = quiet(base);
        profile.stations = stations;
        profile.handhelds = handhelds;
        let metrics = Arc::new(Metrics::new());
        let site = match provision_site(&host, metrics.clone(), &profile, None).await {
            Ok(site) => site,
            Err(error) => {
                let mut host = host;
                host.stop().await.ok();
                return Err(error);
            }
        };
        Ok(Ctx {
            name: name.to_owned(),
            host,
            metrics,
            site,
            profile,
            dir,
            kind: kind.clone(),
            faults: false,
            note: String::new(),
            checks: Vec::new(),
            observed: BTreeMap::new(),
        })
    }

    pub fn check(&mut self, check: Check) {
        self.checks.push(check);
    }

    pub fn checks(&mut self, checks: impl IntoIterator<Item = Check>) {
        self.checks.extend(checks);
    }

    pub fn same<T: PartialEq + std::fmt::Debug>(&mut self, name: &str, expected: T, actual: T) {
        self.checks.push(Check::same(name, expected, actual));
    }

    pub fn observe(&mut self, key: &str, value: Value) {
        self.observed.insert(key.to_owned(), value);
    }

    pub fn device(&self, index: usize) -> DeviceSpec {
        self.site.devices[index].clone()
    }

    /// One request of `device`, answered whatever its status.
    pub async fn send(
        &self,
        device: &DeviceSpec,
        route: Route,
        method: &str,
        path: &str,
        body: Option<Value>,
    ) -> Res<Reply> {
        send_raw(
            &self.site.office.api,
            &device.key,
            route,
            method,
            path,
            body,
        )
        .await
    }

    /// `POST …/enter` naming `supports` (`None`: no body, as a protocol 3 station sends).
    pub async fn enter(
        &self,
        device: &DeviceSpec,
        shift: &str,
        supports: Option<Vec<&'static str>>,
    ) -> Res<Reply> {
        let body = supports.map(|names| json!({ "supports": names }));
        let path = format!("/v1/device/shifts/{shift}/enter");
        self.send(device, Route::Enter, "POST", &path, body).await
    }

    /// `POST …/leave` with `{ joinedRev }` when a token is given, with no body otherwise.
    pub async fn leave(
        &self,
        device: &DeviceSpec,
        shift: &str,
        joined_rev: Option<u64>,
    ) -> Res<Reply> {
        let body = joined_rev.map(|rev| json!({ "joinedRev": rev }));
        let path = format!("/v1/device/shifts/{shift}/leave");
        self.send(device, Route::Other, "POST", &path, body).await
    }

    pub async fn office_shift(&self, shift: &str) -> Res<Value> {
        self.site
            .office
            .ok("GET", &format!("/v1/office/shifts/{shift}"), None)
            .await
    }

    /// The office's close of the whole shift over the revision it reads first.
    pub async fn office_close(&self, shift: &str, reason: &str) -> Res<Reply> {
        let view = self.office_shift(shift).await?;
        self.site
            .office
            .call(
                "POST",
                &format!("/v1/office/shifts/{shift}/close"),
                Some(json!({ "reason": reason, "expectedRev": view["rev"] })),
            )
            .await
    }

    /// A planned shift on `line_id`; nobody entered it.
    pub async fn plan(&self, line_id: &str, planned: Option<u32>) -> Res<String> {
        crate::site::plan_shift(&self.site, &self.profile, line_id, planned)
            .await
            .map(|(id, _)| id)
    }

    /// `PUT /v1/office/lines/{id}` with the limit, over the line's current revision.
    pub async fn set_max_stations(&self, line_id: &str, max: u32) -> Res<Reply> {
        let lines = self.site.office.ok("GET", "/v1/office/lines", None).await?;
        let rev = lines
            .as_array()
            .and_then(|lines| lines.iter().find(|line| line["id"] == json!(line_id)))
            .and_then(|line| line["rev"].as_i64())
            .ok_or_else(|| format!("no line {line_id}"))?;
        self.site
            .office
            .call(
                "PUT",
                &format!("/v1/office/lines/{line_id}"),
                Some(json!({ "maxStations": max, "expectedRev": rev })),
            )
            .await
    }

    /// Put a device on another line: a station chooses it, a handheld is assigned by the office.
    pub async fn move_to_line(&self, device: &DeviceSpec, line_id: &str) -> Res<()> {
        let reply = if device.is_handheld() {
            self.site
                .office
                .call(
                    "PUT",
                    &format!("/v1/office/devices/{}", device.id),
                    Some(json!({ "name": device.name, "lineId": line_id })),
                )
                .await?
        } else {
            let body = json!({ "lineId": line_id });
            self.send(device, Route::Other, "PUT", "/v1/device/line", Some(body))
                .await?
        };
        if reply.ok() {
            Ok(())
        } else {
            Err(format!(
                "device {} to line {line_id}: {} {}",
                device.index, reply.status, reply.body
            ))
        }
    }

    /// The live database, read-only.
    pub async fn db(&self) -> Res<SqlitePool> {
        let dir = self
            .host
            .data_dir
            .as_ref()
            .ok_or("the scenario host has no data folder")?;
        dbcheck::open_read_only(
            &markiro_host::config::HostPaths::new(dir).database_file(),
            false,
        )
        .await
    }

    /// Simulated devices `indices` scanning into `shift` (run number `run` keeps their codes and
    /// record ids apart from any other load of this host).
    pub fn load(&self, run: u32, shift: &str, issuer_prefix: &str, indices: &[usize]) -> Load {
        let mut profile = self.profile.clone();
        profile.seed ^= u64::from(run).wrapping_mul(0x1_0000_0001);
        let shared = Arc::new(Shared::new(
            profile,
            run,
            shift,
            issuer_prefix,
            self.metrics.clone(),
        ));
        let devices: Vec<Arc<SimDevice>> = indices
            .iter()
            .map(|at| {
                SimDevice::new(
                    self.site.devices[*at].clone(),
                    Api::new(
                        &self.host.base,
                        &self.host.fingerprint,
                        self.metrics.clone(),
                    ),
                    shared.clone(),
                )
            })
            .collect();
        let scanners = devices
            .iter()
            .map(|device| tokio::spawn(device.clone().scanner()))
            .collect();
        let syncers = devices
            .iter()
            .map(|device| tokio::spawn(device.clone().syncer()))
            .collect();
        Load {
            shared,
            devices,
            scanners,
            syncers,
        }
    }

    /// The scenario's result and its site's secrets: the host stops; its log (a spawned host)
    /// must name no busy database, nor an ERROR unless the scenario injects faults; the
    /// scenario's own requests must have had no 5xx, nor a request without an answer unless it
    /// injects faults.
    pub async fn finish(mut self, outcome: Res<()>) -> (ScenarioResult, Vec<String>) {
        if let Err(error) = outcome {
            self.checks.push(Check::new("scenario_ran", false, error));
        }
        if let Err(error) = self.host.stop().await {
            self.checks
                .push(Check::new("host_stop", false, error.to_string()));
        }
        let log = self.host.log_scan();
        if log.available {
            self.checks
                .push(Check::at_most("host_log_busy_lines", 0, log.busy_lines));
            if self.faults {
                self.observed
                    .insert("hostLogErrorLines".to_owned(), json!(log.error_lines));
            } else {
                self.checks
                    .push(Check::at_most("host_log_error_lines", 0, log.error_lines));
            }
            if !log.first_errors.is_empty() {
                self.observed
                    .insert("hostLogFirstErrors".to_owned(), json!(log.first_errors));
            }
        }
        let errors = self.metrics.errors();
        let count = |tail: &str| -> u64 {
            errors
                .iter()
                .filter(|(class, _)| class.contains(tail))
                .map(|(_, count)| *count)
                .sum()
        };
        self.checks
            .push(Check::at_most("no_5xx_answer", 0, count(":http_5xx")));
        if !self.faults {
            self.checks.push(Check::at_most(
                "no_request_without_an_answer",
                0,
                count(":net_"),
            ));
        }
        let latency = self
            .metrics
            .latency()
            .into_iter()
            .map(|(route, histogram)| (route.to_owned(), histogram.summary()))
            .collect();
        (
            ScenarioResult {
                name: self.name,
                judged: true,
                note: self.note.trim().to_owned(),
                duration_ms: 0,
                checks: self.checks,
                observed: self.observed,
                latency,
                errors,
            },
            self.site.secrets,
        )
    }
}

/// Simulated devices working one shift: the scanners and syncers of `SimDevice`.
pub struct Load {
    pub shared: Arc<Shared>,
    pub devices: Vec<Arc<SimDevice>>,
    scanners: Vec<JoinHandle<()>>,
    syncers: Vec<JoinHandle<Result<(), String>>>,
}

impl Load {
    /// The device of site index `index`.
    pub fn of(&self, index: usize) -> &Arc<SimDevice> {
        self.devices
            .iter()
            .find(|device| device.spec.index as usize == index)
            .expect("a device of this load")
    }

    /// Stop scanning, drain every outbox (each syncer closes its open box and pallet first), and
    /// say whether each device drained and answered its resends alike.
    pub async fn stop(self, prefix: &str) -> (Arc<Shared>, Vec<Arc<SimDevice>>, Vec<Check>) {
        self.shared.stop.store(true, Ordering::SeqCst);
        for task in self.scanners {
            let _ = task.await;
        }
        for device in &self.devices {
            device.quiesce();
        }
        let mut checks = Vec::new();
        for (device, task) in self.devices.iter().zip(self.syncers) {
            let index = device.spec.index;
            let outcome = task
                .await
                .map_err(|error| error.to_string())
                .and_then(|result| result);
            checks.push(Check::new(
                &format!("{prefix}device_{index}_drained"),
                outcome.is_ok(),
                format!("{outcome:?}"),
            ));
            checks.push(Check::same(
                &format!("{prefix}device_{index}_resends_answered_alike"),
                0,
                device.stats().resend_mismatches,
            ));
        }
        (self.shared, self.devices, checks)
    }
}

/// One request with a device key, answered whatever its status; no answer is an error.
pub async fn send_raw(
    api: &Api,
    key: &str,
    route: Route,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> Res<Reply> {
    let auth = Auth {
        device_key: Some(key),
        session: None,
    };
    api.send(route, method, path, auth, body.as_ref())
        .await
        .map_err(|error| format!("{method} {path}: {error:?}"))
}

/// A request with a protocol version of the caller's choice (the harness's own client always
/// names the current one).
pub async fn send_with_protocol(
    ctx: &Ctx,
    device: &DeviceSpec,
    method: &str,
    path: &str,
    protocol: u32,
    body: Option<Value>,
) -> Res<Reply> {
    let client = pinned_client(&ctx.host.fingerprint, REQUEST_TIMEOUT);
    let verb = reqwest::Method::from_bytes(method.as_bytes()).map_err(|error| error.to_string())?;
    let mut request = client
        .request(verb, format!("{}{path}", ctx.host.base))
        .header(markiro_proto::PROTOCOL_HEADER, protocol.to_string())
        .header("authorization", format!("Bearer {}", device.key));
    if let Some(body) = &body {
        request = request.json(body);
    }
    let response = request
        .send()
        .await
        .map_err(|error| format!("{method} {path}: {}", error.without_url()))?;
    let status = response.status().as_u16();
    let bytes = response
        .bytes()
        .await
        .map_err(|error| error.without_url().to_string())?;
    let body = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    };
    Ok(Reply {
        status,
        body,
        micros: 0,
    })
}

/// `details.constraint` of a refusal.
pub fn constraint(reply: &Reply) -> Option<&str> {
    reply
        .body
        .pointer("/error/details/constraint")
        .and_then(Value::as_str)
}

/// `error.code` of a refusal.
pub fn error_code(reply: &Reply) -> Option<&str> {
    reply.body.pointer("/error/code").and_then(Value::as_str)
}

/// The asking device's state in a shift answer (`""` when absent).
pub fn my_state(shift: &Value) -> &str {
    shift["myState"].as_str().unwrap_or("")
}

/// A participant of a shift answer.
pub fn part<'a>(shift: &'a Value, device_id: &str) -> Option<&'a Value> {
    shift
        .get("participants")
        .and_then(Value::as_array)?
        .iter()
        .find(|part| part["deviceId"] == json!(device_id))
}

/// A participant's leave token in a shift answer.
pub fn joined_rev(shift: &Value, device_id: &str) -> Option<u64> {
    part(shift, device_id)?
        .get("joinedRev")
        .and_then(Value::as_u64)
}

/// Every participant's state in a shift answer, by device id.
pub fn states(shift: &Value) -> BTreeMap<String, String> {
    shift
        .get("participants")
        .and_then(Value::as_array)
        .map(|parts| {
            parts
                .iter()
                .filter_map(|part| {
                    Some((
                        part["deviceId"].as_str()?.to_owned(),
                        part["state"].as_str()?.to_owned(),
                    ))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The issuer prefix an entry's snapshot froze.
pub fn issuer_prefix(entered: &Value) -> Option<String> {
    entered
        .pointer("/snapshot/issuerPrefix")
        .and_then(Value::as_str)
        .map(str::to_owned)
}

pub fn part_closed(receipt: &Value) -> bool {
    receipt.pointer("/details/partClosed") == Some(&Value::Bool(true))
}

pub fn already_closed(receipt: &Value) -> bool {
    receipt.pointer("/details/alreadyClosed") == Some(&Value::Bool(true))
}

pub fn reason_missing(receipt: &Value) -> bool {
    receipt.pointer("/details/reasonMissing") == Some(&Value::Bool(true))
}

/// The checks with `prefix` before each name.
pub fn prefixed(prefix: &str, checks: Vec<Check>) -> Vec<Check> {
    checks
        .into_iter()
        .map(|mut check| {
            check.name = format!("{prefix}{}", check.name);
            check
        })
        .collect()
}

/// Every device of `indices` enters `shift` naming what it supports; the issuer prefix of the
/// first answer that carries a snapshot. Any refusal is an error.
pub async fn enter_all(ctx: &Ctx, shift: &str, indices: &[usize]) -> Res<String> {
    let mut prefix = None;
    for at in indices {
        let device = ctx.device(*at);
        let entered = ctx.enter(&device, shift, Some(device.supports())).await?;
        if !entered.ok() {
            return Err(format!(
                "entry of device {at}: {} {}",
                entered.status, entered.body
            ));
        }
        prefix = prefix.or_else(|| issuer_prefix(&entered.body));
    }
    prefix.ok_or_else(|| "no entry answered a snapshot".to_owned())
}

/// What a scripted device did: the boxes it closed and every receipt, in order.
pub struct Scripted {
    pub boxes: u32,
    pub receipts: Vec<Value>,
}

/// `scans` fresh codes of run `run` into boxes, the boxes and pallets closed, everything sent
/// in order (the drills' `work`, keeping every receipt instead of requiring `accepted`).
pub async fn scripted_work(
    ctx: &Ctx,
    device: &DeviceSpec,
    shift: &str,
    issuer_prefix: &str,
    run: u32,
    scans: u32,
) -> Res<Scripted> {
    let profile = &ctx.profile;
    let cfg = EngineCfg {
        device: device.index,
        run,
        shift_id: shift.to_owned(),
        issuer_prefix: issuer_prefix.to_owned(),
        box_capacity: profile.box_capacity,
        pallet_boxes: profile.pallet_boxes,
        box_block_size: profile.box_block_size,
        pallet_block_size: profile.pallet_block_size,
    };
    let mut engine = Engine::new(
        cfg,
        profile.seed ^ u64::from(run) ^ (u64::from(device.index) << 32),
    );
    for extension in [0u8, 1] {
        if extension == 1 && profile.pallet_boxes == 0 {
            continue;
        }
        let body = json!({
            "requestId": engine.fresh_id(), "issuerPrefix": issuer_prefix, "extension": extension
        });
        let reply = ctx
            .send(
                device,
                Route::SsccBlock,
                "POST",
                "/v1/device/sscc/blocks",
                Some(body),
            )
            .await?;
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
        return Err("a scripted device's block ran out of serials".to_owned());
    }
    let mut receipts = Vec::new();
    loop {
        let batch = engine.batch(100);
        if batch.is_empty() {
            break;
        }
        let records: Vec<Value> = batch.iter().map(|queued| queued.record.clone()).collect();
        receipts.extend(ctx.site.office.api.facts(&device.key, &records).await?);
        engine.ack(batch.len());
    }
    Ok(Scripted {
        boxes: engine.boxes_closed as u32,
        receipts,
    })
}

/// One accepted-verdict scan of `code` at `at_ms` into a new box of `shift`; its receipt. `salt`
/// keeps the record id apart from any other scripted record of the device.
pub async fn scripted_scan(
    ctx: &Ctx,
    device: &DeviceSpec,
    shift: &str,
    code: &gen::Code,
    at_ms: i64,
    salt: u64,
) -> Res<Value> {
    let mut rng = Rng::new(
        ctx.profile.seed ^ salt.wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ u64::from(device.index),
    );
    let record = gen::record(
        &rng.uuid(),
        FactKind::Scan,
        shift,
        gen::scan_ok(code, &rng.uuid(), &gen::text_of(at_ms)),
    );
    let mut receipts = ctx.site.office.api.facts(&device.key, &[record]).await?;
    Ok(receipts.remove(0))
}

/// A `shift_closed` record of `device` for `shift`; its id is the device's, the shift's and
/// `salt`'s own, so a second close (another salt) is a new record, not a `payload_mismatch`.
#[allow(clippy::too_many_arguments)]
pub fn close_record(
    shift: &str,
    device: &DeviceSpec,
    salt: u64,
    planned: Option<u32>,
    actual: u32,
    boxes: u32,
    reason: Option<&str>,
    closed_at: &str,
) -> Value {
    let seed = shift.bytes().fold(0xC105E_u64 ^ salt, |seed, byte| {
        seed.wrapping_mul(131).wrapping_add(u64::from(byte))
    });
    let mut rng = Rng::new(seed ^ u64::from(device.index));
    gen::record(
        &rng.uuid(),
        FactKind::ShiftClosed,
        shift,
        gen::shift_closed(planned, actual, boxes, reason, closed_at),
    )
}

/// A scripted device's close of its part (no ledger); its receipt.
#[allow(clippy::too_many_arguments)]
pub async fn close_fact(
    ctx: &Ctx,
    device: &DeviceSpec,
    shift: &str,
    salt: u64,
    planned: Option<u32>,
    actual: u32,
    boxes: u32,
    reason: Option<&str>,
    closed_at: Option<String>,
) -> Res<Value> {
    let at = closed_at.unwrap_or_else(|| gen::text_of(gen::now_ms()));
    let record = close_record(shift, device, salt, planned, actual, boxes, reason, &at);
    let mut receipts = ctx.site.office.api.facts(&device.key, &[record]).await?;
    Ok(receipts.remove(0))
}

/// Rows of the audit log for `shift` with `action`.
pub async fn audit_count(pool: &SqlitePool, shift: &str, action: &str) -> Res<i64> {
    sqlx::query_scalar(
        "SELECT COUNT(*) FROM audit_log WHERE target_type = 'shift' AND target_id = ? AND action = ?",
    )
    .bind(shift)
    .bind(action)
    .fetch_one(pool)
    .await
    .map_err(|error| format!("audit_log {action}: {error}"))
}

/// The close columns of a shift's row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShiftRow {
    pub status: String,
    pub closed_at: Option<String>,
    pub closed_by: Option<String>,
    pub closed_by_kind: Option<String>,
    pub close_reason_code: Option<String>,
    pub close_reason_missing: bool,
}

pub async fn shift_row(pool: &SqlitePool, shift: &str) -> Res<ShiftRow> {
    type Row = (
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        bool,
    );
    let row: Option<Row> = sqlx::query_as(
        "SELECT status, closed_at, closed_by, closed_by_kind, close_reason_code, \
         close_reason_missing FROM shifts WHERE id = ?",
    )
    .bind(shift)
    .fetch_optional(pool)
    .await
    .map_err(|error| format!("shifts: {error}"))?;
    let (status, closed_at, closed_by, closed_by_kind, close_reason_code, close_reason_missing) =
        row.ok_or_else(|| format!("no shift {shift}"))?;
    Ok(ShiftRow {
        status,
        closed_at,
        closed_by,
        closed_by_kind,
        close_reason_code,
        close_reason_missing,
    })
}

/// The database tier of one shift of a load, prefixed: the structural checks, the
/// reconciliation with the load's ledger (every scripted close went through
/// `close_part_ledgered` or `apply_receipt`), the participant invariants, and no rejected record.
pub async fn reconcile(
    ctx: &Ctx,
    prefix: &str,
    shift: &str,
    shared: &Shared,
    devices: &[Arc<SimDevice>],
) -> Vec<Check> {
    let ids: Vec<(u32, String)> = devices
        .iter()
        .map(|device| (device.spec.index, device.spec.id.clone()))
        .collect();
    let snapshot = shared.ledger.lock().expect("ledger").snapshot();
    let pool = match ctx.db().await {
        Ok(pool) => pool,
        Err(error) => return vec![Check::new(&format!("{prefix}db_open"), false, error)],
    };
    let found = [
        ("db_structural", dbcheck::structural(&pool).await),
        (
            "db_reconcile",
            dbcheck::reconcile(&pool, shift, &ids, &snapshot).await,
        ),
        (
            "db_invariants",
            dbcheck::participant_invariants(&pool, shift).await,
        ),
    ];
    pool.close().await;
    let mut checks = Vec::new();
    for (name, made) in found {
        match made {
            Ok(found) => checks.extend(prefixed(prefix, found)),
            Err(error) => checks.push(Check::new(&format!("{prefix}{name}"), false, error)),
        }
    }
    let rejected = shared.ledger.lock().expect("ledger").rejected.clone();
    checks.push(Check::new(
        &format!("{prefix}no_record_rejected"),
        rejected.is_empty(),
        format!("{rejected:?}"),
    ));
    checks
}

/// One scenario by name. Each scenario task adds its arm.
async fn run_one(
    name: &str,
    kind: &HostKind,
    work_dir: &Path,
    profile: &Profile,
) -> (ScenarioResult, Vec<String>) {
    match name {
        line_full::NAME => line_full::run(kind, work_dir, profile).await,
        capability::NAME => capability::run(kind, work_dir, profile).await,
        leave_reenter::NAME => leave_reenter::run(kind, work_dir, profile).await,
        closed_part::NAME => closed_part::run(kind, work_dir, profile).await,
        close_races::NAME => close_races::run(kind, work_dir, profile).await,
        lines::NAME => lines::run(kind, work_dir, profile).await,
        backup_mid_close::NAME => backup_mid_close::run(kind, work_dir, profile).await,
        other => (
            broken(other, format!("no scenario is named {other}")),
            Vec::new(),
        ),
    }
}

/// Every scenario of `profile`, in order, each on a fresh host of `kind`'s mode under
/// `<work_dir>/scenarios/`; their results and every secret their sites made.
pub async fn run_all(
    kind: &HostKind,
    work_dir: &Path,
    profile: &Profile,
) -> (Vec<ScenarioResult>, Vec<String>) {
    let mut results = Vec::new();
    let mut secrets = Vec::new();
    for name in &profile.scenarios {
        let started = Instant::now();
        let (mut done, found) = if *kind == HostKind::Attach {
            (
                not_judged(
                    name,
                    "attach: the harness makes a fresh host for each scenario and cannot make one beside an attached host",
                ),
                Vec::new(),
            )
        } else {
            run_one(name, kind, work_dir, profile).await
        };
        done.duration_ms = started.elapsed().as_millis() as u64;
        let failed = done.checks.iter().filter(|check| !check.ok).count();
        eprintln!(
            "[scenario {name}] {} ({} checks, {failed} failed, {:.0} s)",
            if !done.judged {
                "not judged"
            } else if failed == 0 {
                "held"
            } else {
                "FAILED"
            },
            done.checks.len(),
            started.elapsed().as_secs_f64()
        );
        results.push(done);
        secrets.extend(found);
    }
    (results, secrets)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn tiny() -> Profile {
        Profile::preset("tiny").unwrap()
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_context_makes_a_site_of_three_lines_and_no_shift_and_finishes_clean() {
        let work = tempfile::tempdir().unwrap();
        let ctx = Ctx::new("probe", &HostKind::InProcess, work.path(), &tiny(), 2, 1)
            .await
            .unwrap();
        assert_eq!(ctx.site.line_ids.len(), 3);
        assert_eq!(ctx.site.devices.len(), 3);
        let shifts = ctx
            .site
            .office
            .ok("GET", "/v1/office/shifts", None)
            .await
            .unwrap();
        assert_eq!(shifts.as_array().map(Vec::len), Some(0));
        assert!(work.path().join("scenarios/probe/data/host.db").exists());
        let (result, secrets) = ctx.finish(Ok(())).await;
        assert!(result.judged);
        assert!(
            result.checks.iter().all(|check| check.ok),
            "{:?}",
            result.checks
        );
        assert!(result
            .checks
            .iter()
            .any(|check| check.name == "no_5xx_answer"));
        assert!(
            secrets.iter().any(|secret| secret.starts_with("Load-")),
            "the scenario site's password is among its secrets"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_quiet_load_on_a_scenario_shift_reconciles_exactly() {
        let work = tempfile::tempdir().unwrap();
        let mut ctx = Ctx::new("load", &HostKind::InProcess, work.path(), &tiny(), 2, 1)
            .await
            .unwrap();
        let line = ctx.site.line_ids[0].clone();
        let shift = ctx.plan(&line, None).await.unwrap();
        let prefix = enter_all(&ctx, &shift, &[0, 1, 2]).await.unwrap();
        let load = ctx.load(1, &shift, &prefix, &[0, 1, 2]);
        tokio::time::sleep(Duration::from_secs(3)).await;
        let (shared, devices, drained) = load.stop("").await;
        assert!(drained.iter().all(|check| check.ok), "{drained:?}");
        let expected = shared.ledger.lock().unwrap().expected();
        assert!(expected.distinct_accepted_codes > 20, "{expected:?}");
        let found = reconcile(&ctx, "", &shift, &shared, &devices).await;
        assert!(found.iter().all(|check| check.ok), "{found:?}");
        for name in ["db_code_owners", "db_integrity", "shift_closed_once"] {
            assert!(found.iter().any(|check| check.name == name), "{name}");
        }
        ctx.check(Check::new("probe", true, ""));
        let (result, _) = ctx.finish(Ok(())).await;
        assert!(
            result.checks.iter().all(|check| check.ok),
            "{:?}",
            result.checks
        );
        assert!(result.latency.contains_key("facts"));
    }

    #[tokio::test]
    async fn an_attached_host_judges_no_scenario_and_an_unknown_name_fails() {
        let work = tempfile::tempdir().unwrap();
        let mut profile = tiny();
        profile.scenarios = vec!["anything".to_owned()];
        let (results, secrets) = run_all(&HostKind::Attach, work.path(), &profile).await;
        assert_eq!(results.len(), 1);
        assert!(!results[0].judged && results[0].note.contains("attach"));
        assert!(secrets.is_empty());
        let (results, _) = run_all(&HostKind::InProcess, work.path(), &profile).await;
        assert!(results[0].judged);
        assert!(results[0]
            .checks
            .iter()
            .any(|check| !check.ok && check.detail.contains("anything")));
    }

    #[test]
    fn the_answer_readers_find_what_the_host_names() {
        let full = Reply {
            status: 409,
            body: json!({ "error": { "code": "conflict", "message": "",
                "details": { "constraint": "shift_line_full", "maxStations": 3, "active": 3 } } }),
            micros: 0,
        };
        assert_eq!(constraint(&full), Some("shift_line_full"));
        assert_eq!(error_code(&full), Some("conflict"));
        let shift = json!({
            "myState": "active",
            "snapshot": { "issuerPrefix": "460068200" },
            "participants": [
                { "deviceId": "a", "state": "active", "joinedRev": 7 },
                { "deviceId": "b", "state": "left" }
            ]
        });
        assert_eq!(my_state(&shift), "active");
        assert_eq!(joined_rev(&shift, "a"), Some(7));
        assert_eq!(joined_rev(&shift, "b"), None);
        assert_eq!(issuer_prefix(&shift).as_deref(), Some("460068200"));
        assert_eq!(states(&shift).get("b").map(String::as_str), Some("left"));
        assert!(part(&shift, "c").is_none());
        assert!(part_closed(
            &json!({ "outcome": "accepted", "details": { "partClosed": true } })
        ));
        assert!(!part_closed(&json!({ "outcome": "accepted" })));
        assert!(already_closed(
            &json!({ "details": { "alreadyClosed": true } })
        ));
        assert!(reason_missing(
            &json!({ "details": { "reasonMissing": true } })
        ));
        let renamed = prefixed("race_0_", vec![Check::new("x", true, "")]);
        assert_eq!(renamed[0].name, "race_0_x");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_scenario_sites_secrets_never_reach_the_written_reports() {
        let work = tempfile::tempdir().unwrap();
        let ctx = Ctx::new("leak", &HostKind::InProcess, work.path(), &tiny(), 2, 1)
            .await
            .unwrap();
        let (mut result, secrets) = ctx.finish(Ok(())).await;
        assert!(secrets.len() >= 2, "a password and device keys at least");
        // A scenario's findings carry the site's secrets everywhere text can go.
        let (first, second) = (secrets[0].clone(), secrets[1].clone());
        result.note = format!("note {first}");
        result.checks.push(Check::new(
            "leak",
            false,
            format!("detail {first} and {second}"),
        ));
        result.observed.insert(
            format!("seen {second}"),
            json!({ "text": first, "list": [second] }),
        );
        result.errors.insert(format!("class {first}"), 2);
        let mut report = crate::report::sample_passing();
        report.scenarios = vec![result];
        let (json_path, md_path) =
            crate::cli::write_reports(&report, work.path(), &secrets).unwrap();
        for path in [json_path, md_path] {
            let text = std::fs::read_to_string(&path).unwrap();
            for secret in &secrets {
                assert!(
                    !text.contains(secret.as_str()),
                    "a scenario secret is in {}",
                    path.display()
                );
            }
        }
        let text = std::fs::read_to_string(work.path().join("report.json")).unwrap();
        assert!(text.contains("[redacted]"));
        // The unredacted report did carry them: the scan can fail.
        let raw = serde_json::to_string(&report).unwrap();
        assert!(secrets
            .iter()
            .take(2)
            .all(|secret| raw.contains(secret.as_str())));
    }
}
