//! A simulated device on the network: the engine's outbox flushed to the host
//! in batches, a code check before each scan online, blocks asked for by the
//! half rule, the shift's totals read now and then, a change stream held
//! open, and a link that drops and returns while scans go on. Four tasks
//! share one device: the scanner, the syncer, the link and the stream.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::api::{Api, Auth};
use crate::engine::{Block, Engine, EngineCfg, Offer, Queued};
use crate::gen::Code;
use crate::ledger::{FactMeta, Ledger};
use crate::metrics::{Metrics, Route};
use crate::profile::Profile;
use crate::rng::Rng;
use crate::site::DeviceSpec;

/// The station's own budget for the host's code check.
pub const CHECK_BUDGET: Duration = Duration::from_millis(300);
const DUP_POOL_CAP: usize = 4096;
const OFFER_WAIT: Duration = Duration::from_secs(10);

/// What the devices share: the shift, the ledger, the pools duplicates and
/// races are drawn from and the stop flag of the run.
pub struct Shared {
    pub profile: Profile,
    pub run: u32,
    pub shift_id: String,
    pub issuer_prefix: String,
    pub metrics: Arc<Metrics>,
    pub ledger: Mutex<Ledger>,
    pub stop: AtomicBool,
    pub pools: Mutex<Pools>,
    pub ranges: Mutex<Vec<(u8, u64, u64)>>,
    pub overlaps: AtomicU64,
    pub generated: AtomicU64,
}

#[derive(Default)]
pub struct Pools {
    /// Codes another device was told it owns, each to be scanned again once.
    pub dup: VecDeque<(u32, Code)>,
    /// Scans an offline device made that an online one may scan first.
    pub offers: Vec<Arc<Offer>>,
    /// Keys of every code ever offered: two devices scanned it and the host
    /// decides which was first, so it is not drawn as a duplicate (the owner
    /// of such a code may be the device that is told to scan it again).
    pub raced: std::collections::HashSet<u64>,
}

impl Shared {
    pub fn new(
        profile: Profile,
        run: u32,
        shift_id: &str,
        issuer_prefix: &str,
        metrics: Arc<Metrics>,
    ) -> Shared {
        Shared {
            profile,
            run,
            shift_id: shift_id.to_owned(),
            issuer_prefix: issuer_prefix.to_owned(),
            metrics,
            ledger: Mutex::new(Ledger::default()),
            stop: AtomicBool::new(false),
            pools: Mutex::new(Pools::default()),
            ranges: Mutex::new(Vec::new()),
            overlaps: AtomicU64::new(0),
            generated: AtomicU64::new(0),
        }
    }
}

/// What one scan will be.
pub enum Plan {
    Fresh { offer: bool },
    Race(Arc<Offer>),
    LateDup(Code),
    CheckedDup(Code),
}

/// Decide the next scan of device `me`. Online: an offered scan of another
/// device half the time one is there, else sometimes a code another device
/// holds (sent without or after the check), else a fresh code. Offline: a
/// fresh code, offered to the others with the profile's race rate.
pub fn decide(rng: &mut Rng, profile: &Profile, me: u32, online: bool, pools: &mut Pools) -> Plan {
    if !online {
        let offer = profile.mean_offline_s > 0.0 && rng.chance(profile.race_rate);
        return Plan::Fresh { offer };
    }
    let takeable = pools
        .offers
        .iter()
        .position(|offer| offer.from != me && !offer.taken.load(Ordering::SeqCst));
    if let Some(at) = takeable {
        if rng.chance(0.5) {
            let offer = pools.offers.remove(at);
            offer.taken.store(true, Ordering::SeqCst);
            return Plan::Race(offer);
        }
    }
    let other = |pools: &mut Pools| {
        let at = pools.dup.iter().rposition(|(device, _)| *device != me)?;
        pools.dup.remove(at).map(|(_, code)| code)
    };
    if rng.chance(profile.late_dup_rate) {
        if let Some(code) = other(pools) {
            return Plan::LateDup(code);
        }
    }
    if rng.chance(profile.checked_dup_rate) {
        if let Some(code) = other(pools) {
            return Plan::CheckedDup(code);
        }
    }
    Plan::Fresh { offer: false }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceStats {
    pub index: u32,
    pub handheld: bool,
    pub scans: u64,
    pub late_dups: u64,
    pub checked_dups: u64,
    pub races_offered: u64,
    pub races_taken: u64,
    pub stalls: u64,
    pub checks: u64,
    pub check_timeouts: u64,
    /// A fresh code the host called taken, or a duplicate it called free.
    pub check_surprises: u64,
    pub flushes: u64,
    pub flush_errors: u64,
    pub resends: u64,
    pub resend_mismatches: u64,
    pub offline_periods: u64,
    pub offline_s: f64,
    pub queue_max: u64,
    pub polls: u64,
    pub poll_sum_mismatches: u64,
    pub totals_regressions: u64,
    pub stream_opens: u64,
    pub stream_events: u64,
    pub boxes_closed: u64,
    pub pallets_closed: u64,
    pub fatal: Option<String>,
}

enum Check {
    Free,
    Taken { same_device: bool },
    TimedOut,
    Failed,
}

pub struct SimDevice {
    pub spec: DeviceSpec,
    api: Api,
    shared: Arc<Shared>,
    engine: Mutex<Engine>,
    online: AtomicBool,
    quiesce: AtomicBool,
    /// Set by `pause`: the scanner makes nothing until `resume`.
    paused: AtomicBool,
    /// Set while the scanner is inside one scan, so `pause` can wait for it.
    scanning: AtomicBool,
    own_offers: Mutex<Vec<Arc<Offer>>>,
    last_total: AtomicU64,
    stats: Mutex<DeviceStats>,
}

impl SimDevice {
    pub fn new(spec: DeviceSpec, api: Api, shared: Arc<Shared>) -> Arc<SimDevice> {
        let profile = &shared.profile;
        let cfg = EngineCfg {
            device: spec.index,
            run: shared.run,
            shift_id: shared.shift_id.clone(),
            issuer_prefix: shared.issuer_prefix.clone(),
            box_capacity: profile.box_capacity,
            pallet_boxes: profile.pallet_boxes,
            box_block_size: profile.box_block_size,
            pallet_block_size: profile.pallet_block_size,
        };
        let seed = profile.seed ^ (u64::from(spec.index) + 1).wrapping_mul(0x9E37_79B9);
        let stats = DeviceStats {
            index: spec.index,
            handheld: spec.is_handheld(),
            ..DeviceStats::default()
        };
        Arc::new(SimDevice {
            spec,
            api,
            engine: Mutex::new(Engine::new(cfg, seed)),
            shared,
            online: AtomicBool::new(true),
            quiesce: AtomicBool::new(false),
            paused: AtomicBool::new(false),
            scanning: AtomicBool::new(false),
            own_offers: Mutex::new(Vec::new()),
            last_total: AtomicU64::new(0),
            stats: Mutex::new(stats),
        })
    }

    pub fn stats(&self) -> DeviceStats {
        let mut stats = self.stats.lock().expect("stats").clone();
        let engine = self.engine.lock().expect("engine");
        stats.boxes_closed = engine.boxes_closed;
        stats.pallets_closed = engine.pallets_closed;
        stats
    }

    fn with_stats(&self, change: impl FnOnce(&mut DeviceStats)) {
        change(&mut self.stats.lock().expect("stats"));
    }

    fn auth(&self) -> Auth<'_> {
        Auth {
            device_key: Some(&self.spec.key),
            session: None,
        }
    }

    /// The shift as this device reads it in `GET /v1/device/shifts`.
    pub async fn view(&self) -> Option<Value> {
        let reply = self
            .api
            .send(
                Route::DeviceShifts,
                "GET",
                "/v1/device/shifts",
                self.auth(),
                None,
            )
            .await
            .ok()?;
        reply
            .body
            .get("shifts")?
            .as_array()?
            .iter()
            .find(|shift| shift["id"] == json!(self.shared.shift_id))
            .cloned()
    }

    /// The device's close of its part of the shift: what it accepted, the
    /// boxes it closed, the plan's number and a reason when there is one.
    /// The answer is the receipt.
    pub async fn close_part(
        &self,
        planned: Option<u32>,
        reason: Option<&str>,
    ) -> Result<Value, String> {
        let actual = {
            let ledger = self.shared.ledger.lock().expect("ledger");
            ledger
                .accepted_scans
                .get(&self.spec.index)
                .copied()
                .unwrap_or(0)
        };
        let (id, at, boxes) = {
            let mut engine = self.engine.lock().expect("engine");
            (engine.fresh_id(), engine.tick(), engine.boxes_closed)
        };
        let data = crate::gen::shift_closed(planned, actual as u32, boxes as u32, reason, &at);
        let record = crate::gen::record(
            &id,
            markiro_proto::FactKind::ShiftClosed,
            &self.shared.shift_id,
            data,
        );
        let mut receipts = self.api.facts(&self.spec.key, &[record]).await?;
        Ok(receipts.remove(0))
    }

    /// Records made so far, sent or not.
    pub fn records_made(&self) -> u64 {
        self.engine.lock().expect("engine").pushed
    }

    pub fn quiesce(&self) {
        self.quiesce.store(true, Ordering::SeqCst);
    }

    pub fn is_online(&self) -> bool {
        self.online.load(Ordering::SeqCst)
    }

    /// Stop scanning, and wait until a scan in progress is queued. The syncer goes on.
    pub async fn pause(&self) {
        self.paused.store(true, Ordering::SeqCst);
        while self.scanning.load(Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    pub fn resume(&self) {
        self.paused.store(false, Ordering::SeqCst);
    }

    /// The link, set by a scenario (a profile that never drops leaves it to the scenario):
    /// offline, the scanner goes on and the syncer sends nothing.
    pub fn set_online(&self, online: bool) {
        self.online.store(online, Ordering::SeqCst);
    }

    pub fn queue_len(&self) -> usize {
        self.engine.lock().expect("engine").queue_len()
    }

    /// Wait until the syncer has every queued record acknowledged.
    pub async fn wait_drained(&self, limit: Duration) -> Result<(), String> {
        let deadline = Instant::now() + limit;
        while self.queue_len() > 0 {
            if Instant::now() > deadline {
                return Err(format!(
                    "device {}: {} records still queued after {} s",
                    self.spec.index,
                    self.queue_len(),
                    limit.as_secs()
                ));
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        Ok(())
    }

    /// What a station does before it closes its part: pause, close the open box and pallet, and
    /// wait until the syncer has sent everything. The device must be online.
    pub async fn seal(&self, limit: Duration) -> Result<(), String> {
        self.pause().await;
        let deadline = Instant::now() + limit;
        loop {
            let sealed = self.engine.lock().expect("engine").close_open();
            if sealed {
                break;
            }
            if Instant::now() > deadline {
                return Err(format!(
                    "device {}: no SSCC serial to close the open box or pallet",
                    self.spec.index
                ));
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        self.wait_drained(deadline.saturating_duration_since(Instant::now()))
            .await
    }

    /// A receipt of a record this device sent outside its outbox, applied once to the ledger.
    pub fn apply_receipt(&self, kind: markiro_proto::FactKind, receipt: &Value) {
        self.shared.ledger.lock().expect("ledger").apply(
            self.spec.index,
            &FactMeta { kind, claims: None },
            receipt,
        );
    }

    /// `close_part`, with the moment given (else the device's clock), and its receipt applied
    /// to the ledger, so the per-device receipt counts stay exact. Call it after `seal`, never
    /// while a flush of this device may run (the syncer only flushes a non-empty outbox).
    pub async fn close_part_ledgered(
        &self,
        planned: Option<u32>,
        reason: Option<&str>,
        closed_at: Option<String>,
    ) -> Result<Value, String> {
        let actual = {
            let ledger = self.shared.ledger.lock().expect("ledger");
            ledger
                .accepted_scans
                .get(&self.spec.index)
                .copied()
                .unwrap_or(0)
        };
        let (id, tick, boxes) = {
            let mut engine = self.engine.lock().expect("engine");
            (engine.fresh_id(), engine.tick(), engine.boxes_closed)
        };
        let at = closed_at.unwrap_or(tick);
        let data = crate::gen::shift_closed(planned, actual as u32, boxes as u32, reason, &at);
        let record = crate::gen::record(
            &id,
            markiro_proto::FactKind::ShiftClosed,
            &self.shared.shift_id,
            data,
        );
        let mut receipts = self.api.facts(&self.spec.key, &[record]).await?;
        let receipt = receipts.remove(0);
        self.apply_receipt(markiro_proto::FactKind::ShiftClosed, &receipt);
        Ok(receipt)
    }

    fn stopped(&self) -> bool {
        self.shared.stop.load(Ordering::SeqCst)
    }

    // ---- the scanner ----

    pub async fn scanner(self: Arc<Self>) {
        let profile = self.shared.profile.clone();
        let mut rng = Rng::new(profile.seed ^ 0xC0DE ^ u64::from(self.spec.index));
        let interval = Duration::from_secs_f64(1.0 / profile.scan_rate);
        let mut next = Instant::now();
        while !self.stopped() {
            if self.paused.load(Ordering::SeqCst) {
                tokio::time::sleep(Duration::from_millis(20)).await;
                next = Instant::now();
                continue;
            }
            let now = Instant::now();
            if now < next {
                tokio::time::sleep((next - now).min(Duration::from_millis(50))).await;
                continue;
            }
            // A scanner that fell behind (a stall, a slow host) does not catch up in a burst.
            let spacing = Duration::from_secs_f64(rng.jitter(interval.as_secs_f64(), 0.3));
            next = if now - next > Duration::from_secs(1) {
                now + spacing
            } else {
                next + spacing
            };
            if !self.engine.lock().expect("engine").can_scan() {
                self.with_stats(|stats| stats.stalls += 1);
                continue;
            }
            // A pause that came after the check above waits for this scan, or stops it here.
            self.scanning.store(true, Ordering::SeqCst);
            if self.paused.load(Ordering::SeqCst) {
                self.scanning.store(false, Ordering::SeqCst);
                continue;
            }
            self.scan_once(&mut rng).await;
            self.scanning.store(false, Ordering::SeqCst);
        }
    }

    async fn scan_once(&self, rng: &mut Rng) {
        let online = self.is_online();
        let plan = {
            let mut pools = self.shared.pools.lock().expect("pools");
            decide(
                rng,
                &self.shared.profile,
                self.spec.index,
                online,
                &mut pools,
            )
        };
        match plan {
            Plan::Fresh { offer } => {
                let code = self.engine.lock().expect("engine").next_code();
                if online {
                    self.check_fresh(&code).await;
                }
                self.engine.lock().expect("engine").scan_ok(&code, None);
                if offer {
                    let offered = Arc::new(Offer {
                        code,
                        from: self.spec.index,
                        taken: AtomicBool::new(false),
                        acked: AtomicBool::new(false),
                    });
                    if self.publish_offer(offered) {
                        self.with_stats(|stats| stats.races_offered += 1);
                    }
                }
            }
            Plan::Race(offer) => {
                self.check_fresh(&offer.code).await;
                self.engine
                    .lock()
                    .expect("engine")
                    .scan_ok(&offer.code, Some(offer.clone()));
                self.with_stats(|stats| stats.races_taken += 1);
            }
            Plan::LateDup(code) => {
                // The 300 ms ran out: the scan is accepted on the device's own copy.
                self.engine.lock().expect("engine").scan_ok(&code, None);
                self.with_stats(|stats| stats.late_dups += 1);
            }
            Plan::CheckedDup(code) => {
                match self.check(&code).await {
                    Check::Taken { same_device: false } => {
                        self.engine.lock().expect("engine").scan_duplicate(&code);
                    }
                    Check::Taken { same_device: true } | Check::Free => {
                        // The host did not know a code another device was told it owns.
                        self.with_stats(|stats| stats.check_surprises += 1);
                        self.engine.lock().expect("engine").scan_ok(&code, None);
                    }
                    Check::TimedOut | Check::Failed => {
                        self.engine.lock().expect("engine").scan_ok(&code, None);
                    }
                }
                self.with_stats(|stats| stats.checked_dups += 1);
            }
        }
        self.shared.generated.fetch_add(1, Ordering::SeqCst);
        self.with_stats(|stats| {
            stats.scans += 1;
            stats.queue_max = stats.queue_max.max(
                self.engine
                    .lock()
                    .map(|engine| engine.queue_len() as u64)
                    .unwrap_or(0),
            );
        });
    }

    /// Offer a scan made offline to the other devices: only while the link is
    /// still down, decided under the pools' lock the link takes when it comes
    /// back. A scan that straddled the link coming up is a scan like any other
    /// (its record may already be on the host, and no one can race it).
    fn publish_offer(&self, offered: Arc<Offer>) -> bool {
        let mut pools = self.shared.pools.lock().expect("pools");
        if self.is_online() {
            return false;
        }
        self.own_offers
            .lock()
            .expect("offers")
            .push(offered.clone());
        pools.raced.insert(offered.code.key);
        pools.offers.push(offered);
        true
    }

    async fn check_fresh(&self, code: &Code) {
        if let Check::Taken { .. } = self.check(code).await {
            self.with_stats(|stats| stats.check_surprises += 1);
        }
    }

    async fn check(&self, code: &Code) -> Check {
        self.with_stats(|stats| stats.checks += 1);
        let path = format!("/v1/device/codes/{}", code.hash);
        let sent = self
            .api
            .send(Route::CodeCheck, "GET", &path, self.auth(), None);
        match tokio::time::timeout(CHECK_BUDGET, sent).await {
            Err(_) => {
                self.shared
                    .metrics
                    .record(Route::CodeCheck, CHECK_BUDGET.as_micros() as u64);
                self.with_stats(|stats| stats.check_timeouts += 1);
                Check::TimedOut
            }
            Ok(Ok(reply)) if reply.ok() => match reply.body.get("status").and_then(Value::as_str) {
                Some("free") => Check::Free,
                Some("taken") => Check::Taken {
                    same_device: reply.body.pointer("/owner/sameDevice")
                        == Some(&Value::Bool(true)),
                },
                _ => Check::Failed,
            },
            Ok(_) => Check::Failed,
        }
    }

    // ---- the syncer ----

    /// Flush, top up and poll until the run ends; then the finish.
    pub async fn syncer(self: Arc<Self>) -> Result<(), String> {
        let profile = self.shared.profile.clone();
        let flush_every = Duration::from_millis(profile.flush_ms);
        let poll_every = Duration::from_secs_f64(profile.totals_poll_s);
        let mut last_flush = Instant::now();
        let mut last_poll = Instant::now();
        let mut backoff = Duration::from_millis(250);
        loop {
            if self.quiesce.load(Ordering::SeqCst) {
                return self.finish().await;
            }
            if self.is_online() {
                self.topup(0).await;
                self.topup(1).await;
                let queued = self.engine.lock().expect("engine").queue_len();
                if queued > 0
                    && (last_flush.elapsed() >= flush_every || queued >= profile.batch_max)
                {
                    match self.flush_once().await {
                        Flush::Failed => {
                            tokio::time::sleep(backoff).await;
                            backoff = (backoff * 2).min(Duration::from_secs(2));
                        }
                        Flush::Fatal(message) => return Err(message),
                        _ => backoff = Duration::from_millis(250),
                    }
                    last_flush = Instant::now();
                }
                if last_poll.elapsed() >= poll_every {
                    self.poll_totals().await;
                    last_poll = Instant::now();
                }
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    async fn topup(&self, extension: u8) {
        let Some(request_id) = self.engine.lock().expect("engine").topup_request(extension) else {
            return;
        };
        let body = json!({
            "requestId": request_id,
            "issuerPrefix": self.shared.issuer_prefix,
            "extension": extension
        });
        let Ok(reply) = self
            .api
            .send(
                Route::SsccBlock,
                "POST",
                "/v1/device/sscc/blocks",
                self.auth(),
                Some(&body),
            )
            .await
        else {
            return;
        };
        if !reply.ok() {
            return;
        }
        let (Some(id), Some(from), Some(to)) = (
            reply.body.get("id").and_then(Value::as_str),
            reply.body.get("fromSerial").and_then(Value::as_u64),
            reply.body.get("toSerial").and_then(Value::as_u64),
        ) else {
            return;
        };
        {
            let mut ranges = self.shared.ranges.lock().expect("ranges");
            if ranges
                .iter()
                .any(|(ext, low, high)| *ext == extension && *low <= to && from <= *high)
            {
                self.shared.overlaps.fetch_add(1, Ordering::SeqCst);
            }
            ranges.push((extension, from, to));
        }
        self.engine
            .lock()
            .expect("engine")
            .add_block(extension, Block::new(id, from, to));
    }

    async fn flush_once(&self) -> Flush {
        let batch: Vec<Queued> = self
            .engine
            .lock()
            .expect("engine")
            .batch(self.shared.profile.batch_max);
        if batch.is_empty() {
            return Flush::Empty;
        }
        let records: Vec<Value> = batch.iter().map(|queued| queued.record.clone()).collect();
        let body = json!({ "records": records });
        let reply = match self
            .api
            .send(
                Route::Facts,
                "POST",
                "/v1/device/facts",
                self.auth(),
                Some(&body),
            )
            .await
        {
            Ok(reply) => reply,
            Err(_) => {
                self.with_stats(|stats| stats.flush_errors += 1);
                return Flush::Failed;
            }
        };
        if reply.status >= 500 {
            self.with_stats(|stats| stats.flush_errors += 1);
            return Flush::Failed;
        }
        if reply.status != 200 {
            let message = format!("facts: {} {}", reply.status, reply.body);
            self.with_stats(|stats| stats.fatal = Some(message.clone()));
            return Flush::Fatal(message);
        }
        let receipts = reply
            .body
            .get("receipts")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let ids_match = receipts.len() == batch.len()
            && receipts.iter().zip(&batch).all(|(receipt, queued)| {
                receipt.get("id").and_then(Value::as_str) == Some(queued.id.as_str())
            });
        if !ids_match {
            let message = format!(
                "facts: {} receipts for {} records, or ids out of order",
                receipts.len(),
                batch.len()
            );
            self.with_stats(|stats| stats.fatal = Some(message.clone()));
            return Flush::Fatal(message);
        }
        {
            let mut ledger = self.shared.ledger.lock().expect("ledger");
            let mut pools = self.shared.pools.lock().expect("pools");
            for (queued, receipt) in batch.iter().zip(&receipts) {
                ledger.apply(self.spec.index, &queued.meta, receipt);
                if let Some(offer) = &queued.offer {
                    offer.acked.store(true, Ordering::SeqCst);
                }
                let accepted = receipt.get("outcome").and_then(Value::as_str) == Some("accepted");
                if let (Some(code), true) = (&queued.code, accepted) {
                    let accepted_scans = ledger
                        .accepted_scans
                        .get(&self.spec.index)
                        .copied()
                        .unwrap_or(0);
                    if accepted_scans % 8 == 0 && !pools.raced.contains(&code.key) {
                        pools.dup.push_back((self.spec.index, code.clone()));
                        if pools.dup.len() > DUP_POOL_CAP {
                            pools.dup.pop_front();
                        }
                    }
                }
            }
        }
        self.engine.lock().expect("engine").ack(batch.len());
        self.with_stats(|stats| stats.flushes += 1);
        if self.should_resend() {
            self.resend(&body, &receipts).await;
        }
        Flush::Sent
    }

    /// Whether to send the batch just acknowledged once more: a function of
    /// the device's own count of flushes, so a run with a seed repeats.
    fn should_resend(&self) -> bool {
        let flushes = self.stats.lock().expect("stats").flushes;
        let mut rng = Rng::new(
            self.shared.profile.seed ^ flushes.wrapping_mul(0xA5A5) ^ u64::from(self.spec.index),
        );
        rng.chance(self.shared.profile.resend_rate)
    }

    async fn resend(&self, body: &Value, first: &[Value]) {
        self.with_stats(|stats| stats.resends += 1);
        let again = self
            .api
            .send(
                Route::Facts,
                "POST",
                "/v1/device/facts",
                self.auth(),
                Some(body),
            )
            .await;
        let same = matches!(&again, Ok(reply) if reply.status == 200
            && reply.body.get("receipts").and_then(Value::as_array).map(Vec::as_slice) == Some(first));
        if !same {
            self.with_stats(|stats| stats.resend_mismatches += 1);
        }
    }

    async fn poll_totals(&self) {
        let Ok(reply) = self
            .api
            .send(
                Route::DeviceShifts,
                "GET",
                "/v1/device/shifts",
                self.auth(),
                None,
            )
            .await
        else {
            return;
        };
        let shift = reply
            .body
            .get("shifts")
            .and_then(Value::as_array)
            .and_then(|shifts| {
                shifts
                    .iter()
                    .find(|shift| shift["id"] == json!(self.shared.shift_id))
            });
        // The list carries `totals` for an active shift only (host `35020185a`): a poll of a
        // closed shift counts nothing, so neither a regression nor a mismatch can come of it.
        let Some(totals) = shift.and_then(|shift| shift.get("totals")) else {
            return;
        };
        let accepted = totals.get("accepted").and_then(Value::as_u64).unwrap_or(0);
        let sum: u64 = shift
            .and_then(|shift| shift.get("byDevice"))
            .and_then(Value::as_array)
            .map(|parts| {
                parts
                    .iter()
                    .filter_map(|part| part.get("accepted").and_then(Value::as_u64))
                    .sum()
            })
            .unwrap_or(0);
        self.with_stats(|stats| {
            stats.polls += 1;
            if sum != accepted {
                stats.poll_sum_mismatches += 1;
            }
        });
        let previous = self.last_total.swap(accepted, Ordering::SeqCst);
        if accepted < previous {
            self.with_stats(|stats| stats.totals_regressions += 1);
        }
    }

    // ---- the link ----

    /// Drop the link and bring it back at random: while it is down the
    /// scanner goes on and the outbox grows; when it returns the outbox is
    /// replayed, after the races this device offered were taken.
    pub async fn link(self: Arc<Self>) {
        let profile = self.shared.profile.clone();
        if profile.mean_offline_s <= 0.0 {
            return;
        }
        let mut rng = Rng::new(profile.seed ^ 0x11C ^ u64::from(self.spec.index));
        while !self.stopped() {
            let online_for = rng.exp(profile.mean_online_s).max(1.0);
            if self.sleep_unless_stopped(online_for).await {
                break;
            }
            self.online.store(false, Ordering::SeqCst);
            let offline_for = rng.exp(profile.mean_offline_s).max(1.0);
            let began = Instant::now();
            let stopped = self.sleep_unless_stopped(offline_for).await;
            self.wait_offers_resolved(OFFER_WAIT).await;
            self.with_stats(|stats| {
                stats.offline_periods += 1;
                stats.offline_s += began.elapsed().as_secs_f64();
            });
            if stopped {
                break;
            }
        }
        self.online.store(true, Ordering::SeqCst);
    }

    /// Sleep `seconds`; `true` if the run stopped first.
    async fn sleep_unless_stopped(&self, seconds: f64) -> bool {
        let until = Instant::now() + Duration::from_secs_f64(seconds);
        while Instant::now() < until {
            if self.stopped() {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        self.stopped()
    }

    /// Wait until every race this device offered was either not taken or its
    /// taker's fact was acknowledged (the host must see the later scan first).
    async fn wait_offers_resolved(&self, limit: Duration) {
        let began = Instant::now();
        loop {
            let pending = self.own_offers.lock().expect("offers").iter().any(|offer| {
                offer.taken.load(Ordering::SeqCst) && !offer.acked.load(Ordering::SeqCst)
            });
            if !pending || began.elapsed() >= limit {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        // What nobody took before the link came back is a scan like any other.
        // The link comes up in the same critical section: see `scan_once`.
        let mut pools = self.shared.pools.lock().expect("pools");
        pools.offers.retain(|offer| offer.from != self.spec.index);
        self.own_offers.lock().expect("offers").clear();
        self.online.store(true, Ordering::SeqCst);
    }

    // ---- the stream ----

    pub async fn stream(self: Arc<Self>) {
        while !self.stopped() {
            if !self.is_online() {
                tokio::time::sleep(Duration::from_millis(200)).await;
                continue;
            }
            let Ok(mut response) = self
                .api
                .open_stream("/v1/changes/stream", self.auth())
                .await
            else {
                tokio::time::sleep(Duration::from_secs(1)).await;
                continue;
            };
            self.with_stats(|stats| stats.stream_opens += 1);
            while !self.stopped() && self.is_online() {
                match tokio::time::timeout(Duration::from_secs(1), response.chunk()).await {
                    Ok(Ok(Some(chunk))) => {
                        let events = chunk
                            .split(|byte| *byte == b'\n')
                            .filter(|line| line.starts_with(b"data:"))
                            .count();
                        self.with_stats(|stats| stats.stream_events += events as u64);
                    }
                    Ok(Ok(None)) | Ok(Err(_)) => break,
                    Err(_) => {}
                }
            }
        }
    }

    // ---- the end ----

    /// Close what a station closes before its part: the open box and pallet;
    /// send everything; read the totals once more.
    async fn finish(&self) -> Result<(), String> {
        self.online.store(true, Ordering::SeqCst);
        self.wait_offers_resolved(Duration::from_secs(15)).await;
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            if self.engine.lock().expect("engine").close_open() {
                break;
            }
            if Instant::now() > deadline {
                return Err("no SSCC serial to close the last box or pallet".to_owned());
            }
            self.topup(0).await;
            self.topup(1).await;
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let deadline = Instant::now() + Duration::from_secs(120);
        loop {
            match self.flush_once().await {
                Flush::Empty => break,
                Flush::Sent => {}
                Flush::Failed => tokio::time::sleep(Duration::from_millis(500)).await,
                Flush::Fatal(message) => return Err(message),
            }
            if Instant::now() > deadline {
                return Err("the outbox did not drain in 120 s".to_owned());
            }
        }
        self.poll_totals().await;
        Ok(())
    }
}

enum Flush {
    Empty,
    Sent,
    Failed,
    Fatal(String),
}
#[cfg(test)]
mod tests {
    use super::*;

    fn offer(from: u32, n: u64) -> Arc<Offer> {
        Arc::new(Offer {
            code: Code::new(1, from, n),
            from,
            taken: AtomicBool::new(false),
            acked: AtomicBool::new(false),
        })
    }

    fn profile() -> Profile {
        let mut profile = Profile::preset("smoke").unwrap();
        profile.late_dup_rate = 0.0;
        profile.checked_dup_rate = 0.0;
        profile.race_rate = 0.0;
        profile
    }

    #[test]
    fn an_offline_device_scans_fresh_codes_and_offers_them_at_the_race_rate() {
        let mut pools = Pools::default();
        let mut rng = Rng::new(1);
        let mut offering = profile();
        offering.race_rate = 1.0;
        assert!(matches!(
            decide(&mut rng, &offering, 0, false, &mut pools),
            Plan::Fresh { offer: true }
        ));
        assert!(matches!(
            decide(&mut rng, &profile(), 0, false, &mut pools),
            Plan::Fresh { offer: false }
        ));
        offering.mean_offline_s = 0.0;
        assert!(
            matches!(
                decide(&mut rng, &offering, 0, false, &mut pools),
                Plan::Fresh { offer: false }
            ),
            "a device that never drops offers nothing"
        );
    }

    #[test]
    fn an_online_device_takes_an_offer_of_another_device_and_never_its_own() {
        let mut rng = Rng::new(2);
        let mut pools = Pools::default();
        pools.offers.push(offer(0, 1));
        for _ in 0..200 {
            assert!(matches!(
                decide(&mut rng, &profile(), 0, true, &mut pools),
                Plan::Fresh { offer: false }
            ));
        }
        assert_eq!(pools.offers.len(), 1);
        let mut taken = None;
        for _ in 0..200 {
            if let Plan::Race(offer) = decide(&mut rng, &profile(), 1, true, &mut pools) {
                taken = Some(offer);
                break;
            }
        }
        let taken = taken.expect("device 1 takes the offer within a few scans");
        assert_eq!(taken.from, 0);
        assert!(taken.taken.load(Ordering::SeqCst));
        assert!(pools.offers.is_empty(), "an offer is taken once");
    }

    #[test]
    fn a_duplicate_is_of_a_code_another_device_holds_and_is_used_once() {
        let mut rng = Rng::new(3);
        let mut late = profile();
        late.late_dup_rate = 1.0;
        let mut pools = Pools::default();
        pools.dup.push_back((0, Code::new(1, 0, 1)));
        pools.dup.push_back((1, Code::new(1, 1, 1)));
        match decide(&mut rng, &late, 0, true, &mut pools) {
            Plan::LateDup(code) => assert_eq!(code, Code::new(1, 1, 1)),
            _ => panic!("a late duplicate of the other device's code"),
        }
        assert!(
            matches!(
                decide(&mut rng, &late, 0, true, &mut pools),
                Plan::Fresh { .. }
            ),
            "only its own code is left: nothing to duplicate"
        );
        let mut checked = profile();
        checked.checked_dup_rate = 1.0;
        let mut pools = Pools::default();
        pools.dup.push_back((2, Code::new(1, 2, 9)));
        assert!(matches!(
            decide(&mut rng, &checked, 0, true, &mut pools),
            Plan::CheckedDup(_)
        ));
        assert!(pools.dup.is_empty());
    }

    // ---- end to end, against a real host in this process ----

    use crate::host::Host;
    use crate::site::{plan_and_enter, provision};

    struct Counts {
        receipts: i64,
        scans: i64,
        conflicts: i64,
        boxes: i64,
        pallets: i64,
        owners: i64,
    }

    async fn scalar(conn: &mut sqlx::SqliteConnection, sql: &str) -> i64 {
        sqlx::query_scalar::<_, i64>(sql)
            .fetch_one(conn)
            .await
            .expect("count")
    }

    async fn host_counts(dir: &std::path::Path) -> Counts {
        use sqlx::sqlite::SqliteConnectOptions;
        use sqlx::{ConnectOptions, Connection};
        let mut conn = SqliteConnectOptions::new()
            .filename(dir.join("host.db"))
            .read_only(true)
            .connect()
            .await
            .expect("open host.db");
        let counts = Counts {
            receipts: scalar(&mut conn, "SELECT count(*) FROM fact_receipts").await,
            scans: scalar(&mut conn, "SELECT count(*) FROM scans").await,
            conflicts: scalar(&mut conn, "SELECT count(*) FROM code_conflicts").await,
            boxes: scalar(
                &mut conn,
                "SELECT count(*) FROM boxes WHERE closed_at IS NOT NULL",
            )
            .await,
            pallets: scalar(
                &mut conn,
                "SELECT count(*) FROM pallets WHERE closed_at IS NOT NULL",
            )
            .await,
            owners: scalar(&mut conn, "SELECT count(*) FROM code_owners").await,
        };
        conn.close().await.ok();
        counts
    }

    async fn one_device_site(
        profile: &Profile,
    ) -> (tempfile::TempDir, Host, Arc<SimDevice>, Arc<Shared>) {
        let dir = tempfile::tempdir().unwrap();
        let host = Host::in_process(dir.path()).await.unwrap();
        let metrics = Arc::new(Metrics::new());
        let (site, _) = provision(&host, metrics.clone(), profile, None)
            .await
            .unwrap();
        let shift = plan_and_enter(&site, profile, None).await.unwrap();
        let shared = Arc::new(Shared::new(
            profile.clone(),
            1,
            &shift.id,
            &shift.issuer_prefix,
            metrics.clone(),
        ));
        let api = Api::new(&host.base, &host.fingerprint, metrics);
        let device = SimDevice::new(site.devices[0].clone(), api, shared.clone());
        (dir, host, device, shared)
    }

    fn quiet(mut profile: Profile) -> Profile {
        profile.stations = 1;
        profile.handhelds = 0;
        profile.mean_offline_s = 0.0;
        profile.late_dup_rate = 0.0;
        profile.checked_dup_rate = 0.0;
        profile.race_rate = 0.0;
        profile.resend_rate = 0.0;
        profile
    }

    #[tokio::test]
    async fn a_scan_that_straddles_the_link_coming_up_is_not_offered_and_raced_codes_are_no_duplicates(
    ) {
        let profile = quiet(Profile::preset("tiny").unwrap());
        let (_dir, mut host, device, shared) = one_device_site(&profile).await;
        // down: offered, and remembered as raced
        device.online.store(false, Ordering::SeqCst);
        let first = offer(0, 1);
        assert!(device.publish_offer(first.clone()));
        {
            let pools = shared.pools.lock().unwrap();
            assert_eq!(pools.offers.len(), 1);
            assert!(pools.raced.contains(&first.code.key));
        }
        // the link comes back: its offers are gone and it is up in one step
        device.wait_offers_resolved(Duration::from_millis(10)).await;
        assert!(device.is_online());
        assert!(shared.pools.lock().unwrap().offers.is_empty());
        // a scan decided while down but published after the link came up is not offered
        let late = offer(0, 2);
        assert!(!device.publish_offer(late.clone()));
        let pools = shared.pools.lock().unwrap();
        assert!(pools.offers.is_empty());
        assert!(!pools.raced.contains(&late.code.key));
        drop(pools);
        host.stop().await.unwrap();
    }

    #[tokio::test]
    async fn a_batch_the_host_kept_but_whose_answer_was_lost_is_counted_once() {
        let profile = quiet(Profile::preset("tiny").unwrap());
        let (dir, mut host, device, shared) = one_device_site(&profile).await;
        device.topup(0).await;
        device.topup(1).await;
        {
            let mut engine = device.engine.lock().unwrap();
            for _ in 0..8 {
                let code = engine.next_code();
                engine.scan_ok(&code, None);
            }
        }
        let made = device.records_made();
        assert!(made >= 8);
        // The answer to this send is lost: the device never reads the receipts.
        let lost: Vec<Value> = device
            .engine
            .lock()
            .unwrap()
            .batch(100)
            .iter()
            .map(|queued| queued.record.clone())
            .collect();
        let first = device.api.facts(&device.spec.key, &lost).await.unwrap();
        assert_eq!(first.len(), lost.len());
        assert_eq!(shared.ledger.lock().unwrap().expected().records, 0);
        // The device retries the same records: the stored receipts come back.
        assert!(matches!(device.flush_once().await, Flush::Sent));
        let expected = shared.ledger.lock().unwrap().expected();
        assert_eq!(expected.records, made);
        assert_eq!(expected.scan_rows, 8);
        assert_eq!(device.engine.lock().unwrap().queue_len(), 0);
        let counts = host_counts(dir.path()).await;
        assert_eq!(counts.receipts as u64, made);
        assert_eq!(counts.scans, 8);
        host.stop().await.unwrap();
    }

    #[tokio::test]
    async fn a_resend_of_an_acknowledged_batch_returns_the_same_receipts_and_counts_nothing() {
        let mut profile = quiet(Profile::preset("tiny").unwrap());
        profile.resend_rate = 1.0;
        let (dir, mut host, device, shared) = one_device_site(&profile).await;
        device.topup(0).await;
        {
            let mut engine = device.engine.lock().unwrap();
            for _ in 0..5 {
                let code = engine.next_code();
                engine.scan_ok(&code, None);
            }
        }
        let made = device.records_made();
        assert!(matches!(device.flush_once().await, Flush::Sent));
        let stats = device.stats();
        assert_eq!(stats.resends, 1);
        assert_eq!(stats.resend_mismatches, 0, "identical stored receipts");
        assert_eq!(shared.ledger.lock().unwrap().expected().records, made);
        let counts = host_counts(dir.path()).await;
        assert_eq!((counts.receipts as u64, counts.scans), (made, 5));
        host.stop().await.unwrap();
    }

    #[tokio::test]
    async fn an_unreadable_record_is_answered_rejected_and_leaves_the_outbox() {
        let profile = quiet(Profile::preset("tiny").unwrap());
        let (_dir, mut host, device, shared) = one_device_site(&profile).await;
        {
            let mut engine = device.engine.lock().unwrap();
            let code = engine.next_code();
            engine.scan_ok(&code, None);
            engine.corrupt_front_for_test();
        }
        assert!(matches!(device.flush_once().await, Flush::Sent));
        assert_eq!(
            device.engine.lock().unwrap().queue_len(),
            0,
            "never stuck in the outbox"
        );
        let ledger = shared.ledger.lock().unwrap();
        assert_eq!(ledger.expected().records, 1);
        assert_eq!(ledger.expected().rejected, 1);
        eprintln!(
            "OBSERVED unreadable record rejected as {:?}",
            ledger.rejected
        );
        drop(ledger);
        host.stop().await.unwrap();
    }

    #[tokio::test]
    async fn a_client_error_on_a_whole_batch_stops_the_device_and_keeps_the_outbox() {
        let profile = quiet(Profile::preset("tiny").unwrap());
        let (_dir, mut host, device, shared) = one_device_site(&profile).await;
        let mut spec = device.spec.clone();
        spec.key = "not-a-device-key".to_owned();
        let api = Api::new(&host.base, &host.fingerprint, shared.metrics.clone());
        let stranger = SimDevice::new(spec, api, shared.clone());
        {
            let mut engine = stranger.engine.lock().unwrap();
            let code = engine.next_code();
            engine.scan_ok(&code, None);
        }
        let message = match stranger.flush_once().await {
            Flush::Fatal(message) => message,
            _ => panic!("a 4xx on a batch is fatal"),
        };
        eprintln!("OBSERVED whole-batch refusal: {message}");
        assert_eq!(stranger.stats().fatal, Some(message.clone()));
        assert!(message.starts_with("facts: 401"), "{message}");
        assert_eq!(
            stranger.engine.lock().unwrap().queue_len(),
            1,
            "kept, not dropped"
        );
        assert_eq!(shared.ledger.lock().unwrap().expected().records, 0);
        host.stop().await.unwrap();
    }

    struct Observed {
        stats: Vec<DeviceStats>,
        counts: Counts,
        expected: crate::ledger::Expected,
        overlaps: u64,
        generated: u64,
        made: u64,
    }

    async fn run_site(profile: Profile, run_for: Duration) -> Observed {
        let dir = tempfile::tempdir().unwrap();
        let mut host = Host::in_process(dir.path()).await.unwrap();
        let metrics = Arc::new(Metrics::new());
        let (site, _) = provision(&host, metrics.clone(), &profile, None)
            .await
            .unwrap();
        let shift = plan_and_enter(&site, &profile, None).await.unwrap();
        let shared = Arc::new(Shared::new(
            profile.clone(),
            1,
            &shift.id,
            &shift.issuer_prefix,
            metrics.clone(),
        ));
        let mut devices = Vec::new();
        for spec in &site.devices {
            let api = Api::new(&host.base, &host.fingerprint, metrics.clone());
            devices.push(SimDevice::new(spec.clone(), api, shared.clone()));
        }
        let mut front = Vec::new();
        let mut syncers = Vec::new();
        for device in &devices {
            front.push(tokio::spawn(device.clone().scanner()));
            front.push(tokio::spawn(device.clone().link()));
            front.push(tokio::spawn(device.clone().stream()));
            syncers.push(tokio::spawn(device.clone().syncer()));
        }
        tokio::time::sleep(run_for).await;
        shared.stop.store(true, Ordering::SeqCst);
        for task in front {
            task.await.unwrap();
        }
        for device in &devices {
            device.quiesce();
        }
        for syncer in syncers {
            syncer.await.unwrap().expect("a device finishes");
        }
        let counts = host_counts(dir.path()).await;
        let expected = shared.ledger.lock().unwrap().expected();
        let observed = Observed {
            stats: devices.iter().map(|device| device.stats()).collect(),
            counts,
            expected,
            overlaps: shared.overlaps.load(Ordering::SeqCst),
            generated: shared.generated.load(Ordering::SeqCst),
            made: devices.iter().map(|device| device.records_made()).sum(),
        };
        host.stop().await.unwrap();
        observed
    }

    fn assert_reconciled(seen: &Observed) {
        let e = &seen.expected;
        assert_eq!(
            e.records, seen.made,
            "every record made was acknowledged once"
        );
        assert_eq!(seen.counts.receipts as u64, e.records, "host receipts");
        assert_eq!(seen.counts.scans as u64, e.scan_rows, "host scan rows");
        assert_eq!(
            seen.counts.conflicts as u64,
            e.conflict_receipts + e.displacements,
            "host code conflicts"
        );
        assert_eq!(
            seen.counts.boxes as u64, e.boxes_closed,
            "host closed boxes"
        );
        assert_eq!(
            seen.counts.pallets as u64, e.pallets_closed,
            "host closed pallets"
        );
        assert_eq!(e.rejected, 0, "no record is rejected");
        assert_eq!(seen.overlaps, 0, "SSCC ranges never overlap");
        for stats in &seen.stats {
            assert_eq!(stats.fatal, None);
            assert_eq!(stats.resend_mismatches, 0, "device {}", stats.index);
            assert_eq!(stats.poll_sum_mismatches, 0, "device {}", stats.index);
            assert_eq!(stats.totals_regressions, 0, "device {}", stats.index);
        }
    }

    #[tokio::test]
    async fn two_stations_and_a_handheld_reconcile_with_the_host_over_the_network() {
        let mut profile = Profile::preset("tiny").unwrap();
        profile.scan_rate = 20.0;
        profile.mean_online_s = 2.0;
        profile.mean_offline_s = 1.0;
        profile.late_dup_rate = 0.05;
        profile.checked_dup_rate = 0.05;
        profile.race_rate = 0.5;
        profile.resend_rate = 0.3;
        profile.flush_ms = 150;
        profile.totals_poll_s = 1.0;
        let seen = run_site(profile, Duration::from_secs(12)).await;
        eprintln!(
            "OBSERVED expected={:?} host(receipts={} scans={} conflicts={} boxes={} pallets={} owners={}) generated={} overlaps={}",
            seen.expected, seen.counts.receipts, seen.counts.scans, seen.counts.conflicts,
            seen.counts.boxes, seen.counts.pallets, seen.counts.owners, seen.generated, seen.overlaps
        );
        for stats in &seen.stats {
            eprintln!("OBSERVED {}", serde_json::to_string(stats).unwrap());
        }
        assert!(
            seen.generated > 100,
            "the devices scanned: {}",
            seen.generated
        );
        assert!(seen.expected.boxes_closed >= 6);
        assert!(seen.stats.iter().map(|s| s.stream_opens).sum::<u64>() >= 3);
        assert!(seen.stats.iter().map(|s| s.polls).sum::<u64>() >= 3);
        assert!(seen.stats.iter().map(|s| s.resends).sum::<u64>() >= 1);
        assert_reconciled(&seen);
    }

    #[tokio::test]
    async fn a_shift_without_pallets_and_without_drops_reconciles_too() {
        let mut profile = Profile::preset("tiny").unwrap();
        profile.stations = 2;
        profile.handhelds = 0;
        profile.pallet_boxes = 0;
        profile.scan_rate = 20.0;
        profile.mean_offline_s = 0.0;
        profile.flush_ms = 100;
        let seen = run_site(profile, Duration::from_secs(5)).await;
        eprintln!(
            "OBSERVED no-pallet expected={:?} host(receipts={} scans={} conflicts={} boxes={} pallets={})",
            seen.expected, seen.counts.receipts, seen.counts.scans, seen.counts.conflicts,
            seen.counts.boxes, seen.counts.pallets
        );
        assert_eq!(seen.expected.pallets_closed, 0);
        assert!(seen.expected.boxes_closed >= 6);
        assert_reconciled(&seen);
    }

    #[tokio::test]
    async fn a_paused_device_scans_nothing_and_a_sealed_one_has_sent_everything() {
        let profile = quiet(Profile::preset("tiny").unwrap());
        let (_dir, mut host, device, shared) = one_device_site(&profile).await;
        let scanner = tokio::spawn(device.clone().scanner());
        let syncer = tokio::spawn(device.clone().syncer());
        tokio::time::sleep(Duration::from_secs(1)).await;
        device.seal(Duration::from_secs(30)).await.unwrap();
        let made = device.records_made();
        assert!(made > 0, "the device scanned before the seal");
        assert_eq!(device.queue_len(), 0, "sealed: everything was sent");
        tokio::time::sleep(Duration::from_millis(600)).await;
        assert_eq!(device.records_made(), made, "a paused device makes nothing");
        device.resume();
        tokio::time::sleep(Duration::from_millis(800)).await;
        assert!(device.records_made() > made, "a resumed device scans again");
        shared.stop.store(true, Ordering::SeqCst);
        scanner.await.unwrap();
        device.quiesce();
        syncer.await.unwrap().unwrap();
        assert_eq!(
            shared.ledger.lock().unwrap().expected().records,
            device.records_made()
        );
        host.stop().await.unwrap();
    }

    #[tokio::test]
    async fn a_ledgered_close_counts_its_receipt_once() {
        let profile = quiet(Profile::preset("tiny").unwrap());
        let (dir, mut host, device, shared) = one_device_site(&profile).await;
        device.topup(0).await;
        device.topup(1).await;
        {
            let mut engine = device.engine.lock().unwrap();
            for _ in 0..3 {
                let code = engine.next_code();
                engine.scan_ok(&code, None);
            }
            assert!(engine.close_open());
        }
        assert!(matches!(device.flush_once().await, Flush::Sent));
        let made = device.records_made();
        let at = crate::gen::text_of(crate::gen::now_ms() + 5_000);
        let receipt = device
            .close_part_ledgered(None, None, Some(at))
            .await
            .unwrap();
        assert_eq!(receipt["outcome"], "accepted", "{receipt}");
        assert_eq!(shared.ledger.lock().unwrap().expected().records, made + 1);
        assert_eq!(host_counts(dir.path()).await.receipts as u64, made + 1);
        host.stop().await.unwrap();
    }
}
