//! One simulated device with no network: its outbox, its open box and pallet
//! and the SSCC blocks it works from. A station's rules, as the work screen
//! keeps them: a box closes when it is full and a serial is at hand, a pallet
//! when it holds its boxes; a full box that has no serial stops the scanning
//! until a block comes; a block is asked for when less than half of the
//! newest is left. Everything that can be decided without a request is
//! decided here, so it is tested without a host.

use std::collections::VecDeque;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use markiro_proto::FactKind;
use serde_json::Value;

use crate::gen::{self, Code, DeviceClock};
use crate::ledger::FactMeta;
use crate::rng::Rng;

/// A scan of an offline device that an online one may scan first.
#[derive(Debug)]
pub struct Offer {
    pub code: Code,
    pub from: u32,
    /// Set when the online device took it, and when its fact was acknowledged.
    pub taken: AtomicBool,
    pub acked: AtomicBool,
}

#[derive(Debug, Clone)]
pub struct Queued {
    pub id: String,
    pub record: Value,
    pub meta: FactMeta,
    /// The code of an accepted-verdict scan.
    pub code: Option<Code>,
    pub offer: Option<Arc<Offer>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Block {
    pub id: String,
    pub from: u64,
    pub to: u64,
    pub next: u64,
}

impl Block {
    pub fn new(id: &str, from: u64, to: u64) -> Block {
        Block {
            id: id.to_owned(),
            from,
            to,
            next: from,
        }
    }
}

#[derive(Debug)]
struct Supply {
    size: u32,
    blocks: VecDeque<Block>,
    pending: Option<String>,
}

impl Supply {
    fn new(size: u32) -> Self {
        Self {
            size,
            blocks: VecDeque::new(),
            pending: None,
        }
    }

    fn remaining(&self) -> u64 {
        self.blocks
            .iter()
            .map(|block| block.to + 1 - block.next)
            .sum()
    }

    fn take(&mut self) -> Option<(String, u64)> {
        while let Some(block) = self.blocks.front_mut() {
            if block.next <= block.to {
                let serial = block.next;
                block.next += 1;
                return Some((block.id.clone(), serial));
            }
            self.blocks.pop_front();
        }
        None
    }
}

#[derive(Debug, Clone)]
pub struct EngineCfg {
    pub device: u32,
    pub run: u32,
    pub shift_id: String,
    pub issuer_prefix: String,
    pub box_capacity: u32,
    /// 0: a shift without pallets.
    pub pallet_boxes: u32,
    pub box_block_size: u32,
    pub pallet_block_size: u32,
}

#[derive(Debug)]
struct OpenBox {
    id: String,
    opened_at: String,
    hashes: Vec<String>,
}

#[derive(Debug)]
struct OpenPallet {
    id: String,
    opened_at: String,
    boxes: u32,
}

pub struct Engine {
    cfg: EngineCfg,
    rng: Rng,
    clock: DeviceClock,
    queue: VecDeque<Queued>,
    next_n: u64,
    open_box: Option<OpenBox>,
    full_box_waits: bool,
    open_pallet: Option<OpenPallet>,
    full_pallet_waits: bool,
    boxes: Supply,
    pallets: Supply,
    pub boxes_closed: u64,
    pub pallets_closed: u64,
    pub scans: u64,
    /// Records made so far, whatever became of them.
    pub pushed: u64,
    pub items_in_open_box: u64,
}

impl Engine {
    pub fn new(cfg: EngineCfg, seed: u64) -> Engine {
        let boxes = Supply::new(cfg.box_block_size);
        let pallets = Supply::new(cfg.pallet_block_size);
        Engine {
            cfg,
            rng: Rng::new(seed),
            clock: DeviceClock::new(),
            queue: VecDeque::new(),
            next_n: 0,
            open_box: None,
            full_box_waits: false,
            open_pallet: None,
            full_pallet_waits: false,
            boxes,
            pallets,
            boxes_closed: 0,
            pallets_closed: 0,
            scans: 0,
            pushed: 0,
            items_in_open_box: 0,
        }
    }

    /// A code this device has not scanned before; its serial is its own.
    pub fn next_code(&mut self) -> Code {
        self.next_n += 1;
        Code::new(self.cfg.run, self.cfg.device, self.next_n)
    }

    /// An id for a record built outside the engine.
    pub fn fresh_id(&mut self) -> String {
        self.rng.uuid()
    }

    /// The device's own clock, for a fact built outside the engine.
    pub fn tick(&mut self) -> String {
        self.clock.tick()
    }

    /// A full box or pallet that has no serial holds the scanner.
    pub fn can_scan(&self) -> bool {
        !self.full_box_waits && !self.full_pallet_waits
    }

    pub fn queue_len(&self) -> usize {
        self.queue.len()
    }

    fn push(
        &mut self,
        kind: FactKind,
        data: Value,
        code: Option<&Code>,
        offer: Option<Arc<Offer>>,
    ) {
        let id = self.rng.uuid();
        self.pushed += 1;
        let record = gen::record(&id, kind, &self.cfg.shift_id, data);
        self.queue.push_back(Queued {
            id,
            record,
            meta: FactMeta {
                kind,
                claims: code.map(|code| code.key),
            },
            code: code.cloned(),
            offer,
        });
    }

    /// An accepted-verdict scan of `code` into the open box.
    pub fn scan_ok(&mut self, code: &Code, offer: Option<Arc<Offer>>) {
        self.scans += 1;
        let at = self.clock.tick();
        if self.open_box.is_none() {
            self.open_box = Some(OpenBox {
                id: self.rng.uuid(),
                opened_at: at.clone(),
                hashes: Vec::new(),
            });
        }
        let open = self.open_box.as_mut().expect("a box is open");
        open.hashes.push(code.hash.clone());
        self.items_in_open_box = open.hashes.len() as u64;
        let data = gen::scan_ok(code, &open.id, &at);
        self.push(FactKind::Scan, data, Some(code), offer);
        self.progress();
    }

    /// A scan the host's check called taken: a journal row, no box.
    pub fn scan_duplicate(&mut self, code: &Code) {
        self.scans += 1;
        let at = self.clock.tick();
        self.push(FactKind::Scan, gen::scan_duplicate(code, &at), None, None);
    }

    /// Close what is full and has a serial; what has none waits.
    pub fn progress(&mut self) {
        loop {
            let full_box = self
                .open_box
                .as_ref()
                .is_some_and(|open| open.hashes.len() as u32 >= self.cfg.box_capacity);
            if full_box {
                if !self.close_box() {
                    self.full_box_waits = true;
                    break;
                }
                self.full_box_waits = false;
                continue;
            }
            let full_pallet = self.cfg.pallet_boxes > 0
                && self
                    .open_pallet
                    .as_ref()
                    .is_some_and(|open| open.boxes >= self.cfg.pallet_boxes);
            if full_pallet {
                if !self.close_pallet() {
                    self.full_pallet_waits = true;
                    break;
                }
                self.full_pallet_waits = false;
                continue;
            }
            self.full_box_waits = false;
            self.full_pallet_waits = false;
            break;
        }
    }

    fn close_box(&mut self) -> bool {
        let Some((block, serial)) = self.boxes.take() else {
            return false;
        };
        let open = self.open_box.take().expect("a box to close");
        let closed_at = self.clock.tick();
        let pallet_id = (self.cfg.pallet_boxes > 0).then(|| {
            let id = self.open_pallet.as_ref().map(|pallet| pallet.id.clone());
            id.unwrap_or_else(|| self.rng.uuid())
        });
        if let Some(id) = &pallet_id {
            let pallet = self.open_pallet.get_or_insert_with(|| OpenPallet {
                id: id.clone(),
                opened_at: closed_at.clone(),
                boxes: 0,
            });
            pallet.boxes += 1;
        }
        let sscc = gen::sscc(0, &self.cfg.issuer_prefix, serial);
        let data = gen::box_closed(
            &open.id,
            &sscc,
            &block,
            serial,
            &open.opened_at,
            &closed_at,
            &open.hashes,
            pallet_id.as_deref(),
        );
        self.push(FactKind::BoxClosed, data, None, None);
        self.boxes_closed += 1;
        self.items_in_open_box = 0;
        true
    }

    fn close_pallet(&mut self) -> bool {
        let Some((block, serial)) = self.pallets.take() else {
            return false;
        };
        let open = self.open_pallet.take().expect("a pallet to close");
        let closed_at = self.clock.tick();
        let sscc = gen::sscc(1, &self.cfg.issuer_prefix, serial);
        let data = gen::pallet_closed(
            &open.id,
            &sscc,
            &block,
            serial,
            &open.opened_at,
            &closed_at,
            open.boxes,
        );
        self.push(FactKind::PalletClosed, data, None, None);
        self.pallets_closed += 1;
        true
    }

    /// A block the host issued; closes what was waiting for one.
    pub fn add_block(&mut self, extension: u8, block: Block) {
        let supply = if extension == 0 {
            &mut self.boxes
        } else {
            &mut self.pallets
        };
        supply.pending = None;
        supply.blocks.push_back(block);
        self.progress();
    }

    /// The request to make now for `extension`, if the half rule says so: its
    /// id stays the same until [`Engine::add_block`] answers it.
    pub fn topup_request(&mut self, extension: u8) -> Option<String> {
        if extension == 1 && self.cfg.pallet_boxes == 0 {
            return None;
        }
        let new_id = self.rng.uuid();
        let supply = if extension == 0 {
            &mut self.boxes
        } else {
            &mut self.pallets
        };
        if supply.pending.is_none() && supply.remaining() * 2 < u64::from(supply.size) {
            supply.pending = Some(new_id);
        }
        supply.pending.clone()
    }

    pub fn remaining(&self, extension: u8) -> u64 {
        if extension == 0 {
            self.boxes.remaining()
        } else {
            self.pallets.remaining()
        }
    }

    /// The end of the run: the partial box and pallet are closed as a
    /// station closes them before it closes its part of the shift. `false`
    /// while a serial is missing for one of them.
    pub fn close_open(&mut self) -> bool {
        if self.open_box.is_some() && !self.close_box() {
            return false;
        }
        if self.cfg.pallet_boxes > 0
            && self
                .open_pallet
                .as_ref()
                .is_some_and(|pallet| pallet.boxes > 0)
            && !self.close_pallet()
        {
            return false;
        }
        self.full_box_waits = false;
        self.full_pallet_waits = false;
        true
    }

    /// Up to `max` records from the front of the outbox, left in place until
    /// their receipts come.
    pub fn batch(&self, max: usize) -> Vec<Queued> {
        self.queue.iter().take(max).cloned().collect()
    }

    /// Test aid: make the first queued record unreadable to the host.
    #[cfg(test)]
    pub fn corrupt_front_for_test(&mut self) {
        if let Some(front) = self.queue.front_mut() {
            front.record = serde_json::json!({ "id": front.id, "kind": 7 });
        }
    }

    /// The first `n` records of the outbox, their receipts kept.
    pub fn ack(&mut self, n: usize) -> Vec<Queued> {
        self.queue.drain(..n.min(self.queue.len())).collect()
    }
}

#[cfg(test)]
mod tests {
    use markiro_proto::{BoxClosedFact, PalletClosedFact};

    use super::*;
    use crate::rng::Rng;

    fn cfg(box_capacity: u32, pallet_boxes: u32) -> EngineCfg {
        EngineCfg {
            device: 2,
            run: 1,
            shift_id: "00000000-0000-4000-8000-0000000000aa".to_owned(),
            issuer_prefix: "460068200".to_owned(),
            box_capacity,
            pallet_boxes,
            box_block_size: 4,
            pallet_block_size: 2,
        }
    }

    fn kinds(engine: &Engine) -> Vec<FactKind> {
        engine
            .batch(1000)
            .iter()
            .map(|queued| queued.meta.kind)
            .collect()
    }

    #[test]
    fn a_full_box_closes_with_the_first_serial_of_its_block() {
        let mut engine = Engine::new(cfg(3, 0), 1);
        engine.add_block(0, Block::new("b1", 100, 103));
        for _ in 0..3 {
            let code = engine.next_code();
            engine.scan_ok(&code, None);
        }
        assert_eq!(
            kinds(&engine),
            vec![
                FactKind::Scan,
                FactKind::Scan,
                FactKind::Scan,
                FactKind::BoxClosed
            ]
        );
        let queued = engine.batch(10);
        let closed: BoxClosedFact =
            serde_json::from_value(queued[3].record["data"].clone()).unwrap();
        assert_eq!((closed.serial, closed.item_count), (100, 3));
        assert_eq!(closed.sscc, gen::sscc(0, "460068200", 100));
        assert_eq!(closed.pallet_id, None);
        assert_eq!(engine.boxes_closed, 1);
        assert_eq!(engine.items_in_open_box, 0);
    }

    #[test]
    fn a_full_box_without_a_serial_holds_the_scanner_until_a_block_comes() {
        let mut engine = Engine::new(cfg(2, 0), 1);
        for _ in 0..2 {
            let code = engine.next_code();
            engine.scan_ok(&code, None);
        }
        assert!(!engine.can_scan());
        assert_eq!(kinds(&engine), vec![FactKind::Scan, FactKind::Scan]);
        engine.add_block(0, Block::new("b1", 7, 10));
        assert!(engine.can_scan());
        assert_eq!(kinds(&engine).last(), Some(&FactKind::BoxClosed));
    }

    #[test]
    fn boxes_join_the_pallet_and_a_full_pallet_closes_after_its_last_box() {
        let mut engine = Engine::new(cfg(1, 2), 1);
        engine.add_block(0, Block::new("b1", 1, 4));
        engine.add_block(1, Block::new("p1", 40, 41));
        for _ in 0..2 {
            let code = engine.next_code();
            engine.scan_ok(&code, None);
        }
        assert_eq!(
            kinds(&engine),
            vec![
                FactKind::Scan,
                FactKind::BoxClosed,
                FactKind::Scan,
                FactKind::BoxClosed,
                FactKind::PalletClosed
            ]
        );
        let queued = engine.batch(10);
        let first: BoxClosedFact =
            serde_json::from_value(queued[1].record["data"].clone()).unwrap();
        let second: BoxClosedFact =
            serde_json::from_value(queued[3].record["data"].clone()).unwrap();
        let pallet: PalletClosedFact =
            serde_json::from_value(queued[4].record["data"].clone()).unwrap();
        assert_eq!(first.pallet_id, second.pallet_id);
        assert_eq!(Some(pallet.pallet_id.clone()), first.pallet_id);
        assert_eq!((pallet.box_count, pallet.serial), (2, 40));
        assert_eq!(pallet.sscc, gen::sscc(1, "460068200", 40));
    }

    #[test]
    fn a_block_is_asked_for_when_less_than_half_is_left_and_the_request_repeats() {
        let mut engine = Engine::new(cfg(1, 0), 1);
        let first = engine.topup_request(0).expect("no block yet");
        assert_eq!(engine.topup_request(0), Some(first.clone()));
        engine.add_block(0, Block::new("b1", 0, 3));
        assert_eq!(engine.topup_request(0), None, "4 left of 4");
        for _ in 0..2 {
            let code = engine.next_code();
            engine.scan_ok(&code, None);
        }
        assert_eq!(engine.remaining(0), 2);
        assert_eq!(engine.topup_request(0), None, "2 of 4 is half, not less");
        let code = engine.next_code();
        engine.scan_ok(&code, None);
        let second = engine.topup_request(0).expect("1 of 4 is less than half");
        assert_ne!(second, first);
        assert_eq!(engine.topup_request(0), Some(second));
        assert_eq!(
            engine.topup_request(1),
            None,
            "a shift without pallets asks for none"
        );
    }

    #[test]
    fn closing_the_open_box_and_pallet_sends_what_a_station_sends_before_its_close() {
        let mut engine = Engine::new(cfg(5, 3), 1);
        engine.add_block(0, Block::new("b1", 1, 4));
        engine.add_block(1, Block::new("p1", 9, 10));
        for _ in 0..2 {
            let code = engine.next_code();
            engine.scan_ok(&code, None);
        }
        assert!(engine.close_open());
        assert_eq!(
            kinds(&engine),
            vec![
                FactKind::Scan,
                FactKind::Scan,
                FactKind::BoxClosed,
                FactKind::PalletClosed
            ]
        );
        let queued = engine.batch(10);
        let closed: BoxClosedFact =
            serde_json::from_value(queued[2].record["data"].clone()).unwrap();
        assert_eq!(closed.item_count, 2);
        let pallet: PalletClosedFact =
            serde_json::from_value(queued[3].record["data"].clone()).unwrap();
        assert_eq!(pallet.box_count, 1);
        assert!(engine.close_open(), "nothing is left to close");
    }

    #[test]
    fn the_outbox_keeps_a_batch_until_its_receipts_come() {
        let mut engine = Engine::new(cfg(9, 0), 1);
        for _ in 0..5 {
            let code = engine.next_code();
            engine.scan_ok(&code, None);
        }
        assert_eq!(engine.batch(3).len(), 3);
        assert_eq!(engine.queue_len(), 5);
        let popped = engine.ack(3);
        assert_eq!(popped.len(), 3);
        assert_eq!(engine.queue_len(), 2);
        assert_eq!(engine.ack(10).len(), 2);
        let ids: std::collections::HashSet<_> =
            popped.iter().map(|queued| queued.id.clone()).collect();
        assert_eq!(ids.len(), 3);
    }

    #[test]
    fn a_duplicate_scan_is_a_journal_row_and_claims_nothing() {
        let mut engine = Engine::new(cfg(9, 0), 1);
        let code = Code::new(1, 0, 1);
        engine.scan_duplicate(&code);
        let queued = engine.batch(1);
        assert_eq!(queued[0].meta.claims, None);
        assert_eq!(queued[0].record["data"]["verdict"], "duplicate");
        assert_eq!(engine.items_in_open_box, 0);
    }

    fn data<T: serde::de::DeserializeOwned>(queued: &Queued) -> T {
        serde_json::from_value(queued.record["data"].clone()).unwrap()
    }

    #[test]
    fn a_full_pallet_without_a_serial_holds_the_scanner_until_its_block_comes() {
        let mut engine = Engine::new(cfg(1, 2), 1);
        engine.add_block(0, Block::new("b1", 1, 4));
        for _ in 0..2 {
            let code = engine.next_code();
            engine.scan_ok(&code, None);
        }
        assert!(!engine.can_scan(), "two boxes, no pallet serial");
        assert_eq!(engine.pallets_closed, 0);
        engine.add_block(1, Block::new("p1", 5, 6));
        assert!(engine.can_scan());
        assert_eq!(engine.pallets_closed, 1);
        assert_eq!(kinds(&engine).last(), Some(&FactKind::PalletClosed));
    }

    #[test]
    fn serials_run_on_through_the_next_block_and_never_repeat() {
        let mut engine = Engine::new(cfg(1, 0), 1);
        engine.add_block(0, Block::new("b1", 10, 11));
        engine.add_block(0, Block::new("b2", 50, 51));
        for _ in 0..4 {
            let code = engine.next_code();
            engine.scan_ok(&code, None);
        }
        let closes: Vec<BoxClosedFact> = engine
            .batch(100)
            .iter()
            .filter(|queued| queued.meta.kind == FactKind::BoxClosed)
            .map(data)
            .collect();
        let serials: Vec<_> = closes.iter().map(|closed| closed.serial).collect();
        assert_eq!(serials, vec![10, 11, 50, 51]);
        assert_eq!(closes[1].block_id, "b1");
        assert_eq!(closes[2].block_id, "b2");
        assert_eq!(engine.remaining(0), 0);
    }

    #[test]
    fn an_answered_request_is_replaced_by_a_new_one_when_the_block_runs_low_again() {
        let mut engine = Engine::new(cfg(1, 0), 1);
        let first = engine.topup_request(0).unwrap();
        engine.add_block(0, Block::new("b1", 0, 3));
        assert_eq!(engine.topup_request(0), None);
        for _ in 0..3 {
            let code = engine.next_code();
            engine.scan_ok(&code, None);
        }
        let second = engine.topup_request(0).unwrap();
        engine.add_block(0, Block::new("b2", 4, 7));
        assert_eq!(engine.topup_request(0), None, "5 of 4 is not low");
        for _ in 0..4 {
            let code = engine.next_code();
            engine.scan_ok(&code, None);
        }
        let third = engine.topup_request(0).unwrap();
        assert_ne!(second, third);
        assert_ne!(first, third);
        assert!(engine.topup_request(1).is_none());
    }

    #[test]
    fn a_shift_with_pallets_asks_for_pallet_blocks_with_their_own_request_id() {
        let mut engine = Engine::new(cfg(1, 2), 1);
        let boxes = engine.topup_request(0).unwrap();
        let pallets = engine.topup_request(1).unwrap();
        assert_ne!(boxes, pallets);
        engine.add_block(1, Block::new("p1", 1, 2));
        assert_eq!(engine.topup_request(1), None);
        assert_eq!(engine.topup_request(0), Some(boxes));
        assert_eq!(engine.remaining(1), 2);
    }

    #[test]
    fn a_shift_without_pallets_puts_no_pallet_on_its_boxes() {
        let mut engine = Engine::new(cfg(1, 0), 1);
        engine.add_block(0, Block::new("b1", 1, 4));
        let code = engine.next_code();
        engine.scan_ok(&code, None);
        let queued = engine.batch(10);
        let closed: BoxClosedFact = data(&queued[1]);
        assert_eq!(closed.pallet_id, None);
        assert_eq!(engine.pallets_closed, 0);
        assert!(engine.close_open());
        assert_eq!(engine.queue_len(), 2);
    }

    #[test]
    fn close_open_waits_for_a_serial_and_then_finishes() {
        let mut engine = Engine::new(cfg(5, 3), 1);
        let code = engine.next_code();
        engine.scan_ok(&code, None);
        assert!(!engine.close_open(), "no box serial");
        engine.add_block(0, Block::new("b1", 1, 2));
        assert!(!engine.close_open(), "box closed, no pallet serial");
        assert_eq!(engine.boxes_closed, 1);
        engine.add_block(1, Block::new("p1", 9, 9));
        assert!(engine.close_open());
        assert_eq!(engine.pallets_closed, 1);
        assert_eq!(
            kinds(&engine),
            vec![FactKind::Scan, FactKind::BoxClosed, FactKind::PalletClosed]
        );
    }

    #[test]
    fn a_box_after_a_closed_pallet_opens_a_new_pallet() {
        let mut engine = Engine::new(cfg(1, 1), 1);
        engine.add_block(0, Block::new("b1", 1, 4));
        engine.add_block(1, Block::new("p1", 1, 4));
        for _ in 0..2 {
            let code = engine.next_code();
            engine.scan_ok(&code, None);
        }
        let queued = engine.batch(10);
        let first: BoxClosedFact = data(&queued[1]);
        let second: BoxClosedFact = data(&queued[4]);
        assert_ne!(first.pallet_id, second.pallet_id);
        assert_eq!(engine.pallets_closed, 2);
    }

    #[test]
    fn records_have_unique_ids_and_the_device_clock_only_moves_forward() {
        let mut engine = Engine::new(cfg(2, 0), 9);
        engine.add_block(0, Block::new("b1", 1, 9));
        for _ in 0..6 {
            let code = engine.next_code();
            engine.scan_ok(&code, None);
        }
        let queued = engine.batch(100);
        let ids: std::collections::HashSet<_> = queued.iter().map(|q| q.id.clone()).collect();
        assert_eq!(ids.len(), queued.len());
        assert_eq!(engine.pushed as usize, queued.len());
        let mut last = String::new();
        for _ in 0..50 {
            let at = engine.tick();
            assert!(at > last);
            last = at;
        }
        assert_ne!(engine.fresh_id(), engine.fresh_id());
    }

    #[test]
    fn the_same_seed_makes_the_same_ids_and_other_seeds_other_ones() {
        let run = |seed| {
            let mut engine = Engine::new(cfg(2, 0), seed);
            engine.add_block(0, Block::new("b1", 1, 9));
            for _ in 0..4 {
                let code = engine.next_code();
                engine.scan_ok(&code, None);
            }
            engine
                .batch(100)
                .iter()
                .map(|queued| (queued.id.clone(), queued.meta.kind))
                .collect::<Vec<_>>()
        };
        assert_eq!(run(5), run(5));
        assert_ne!(run(5), run(6));
    }

    #[test]
    fn an_accepted_scan_claims_its_code_and_carries_its_offer() {
        let mut engine = Engine::new(cfg(9, 0), 1);
        let code = engine.next_code();
        let offer = Arc::new(Offer {
            code: code.clone(),
            from: 2,
            taken: AtomicBool::new(false),
            acked: AtomicBool::new(false),
        });
        engine.scan_ok(&code, Some(offer.clone()));
        let queued = engine.batch(1);
        assert_eq!(queued[0].meta.claims, Some(code.key));
        assert_eq!(queued[0].code.as_ref(), Some(&code));
        assert!(Arc::ptr_eq(queued[0].offer.as_ref().unwrap(), &offer));
        assert_eq!(engine.scans, 1);
        assert_eq!(engine.items_in_open_box, 1);
    }

    #[test]
    fn codes_of_one_device_are_distinct_and_carry_its_number() {
        let mut engine = Engine::new(cfg(9, 0), 1);
        let a = engine.next_code();
        let b = engine.next_code();
        assert_ne!(a, b);
        assert_eq!(a, Code::new(1, 2, 1));
        assert_eq!(b, Code::new(1, 2, 2));
    }

    fn supply(engine: &mut Engine, config: &EngineCfg, extension: u8, state: &mut (u64, u64, u32)) {
        let (size, next) = if extension == 0 {
            (config.box_block_size, &mut state.0)
        } else {
            (config.pallet_block_size, &mut state.1)
        };
        state.2 += 1;
        let from = *next;
        *next += u64::from(size);
        engine.add_block(
            extension,
            Block::new(&format!("blk{}", state.2), from, from + u64::from(size) - 1),
        );
    }

    /// For any shape of shift, supplying blocks the way the half rule asks,
    /// the facts the engine makes are what the host reads alike: distinct
    /// serials of the right extension, boxes within capacity, pallets that
    /// count the boxes that named them, and every scan in exactly one box.
    #[test]
    fn any_run_makes_facts_the_host_reads_alike() {
        use markiro_host::facts::rules;
        for seed in 0..60u64 {
            let mut rng = Rng::new(seed);
            let box_capacity = rng.range(1, 6) as u32;
            let pallet_boxes = rng.range(0, 4) as u32;
            let mut config = cfg(box_capacity, pallet_boxes);
            config.box_block_size = rng.range(1, 6) as u32;
            config.pallet_block_size = rng.range(1, 4) as u32;
            let mut engine = Engine::new(config.clone(), seed);
            let mut state = (1000u64, 5000u64, 0u32);
            let mut hashes = Vec::new();
            let mut guard = 0;
            while hashes.len() < 40 && guard < 10_000 {
                guard += 1;
                for extension in [0u8, 1] {
                    if engine.topup_request(extension).is_some() {
                        supply(&mut engine, &config, extension, &mut state);
                    }
                }
                if engine.can_scan() {
                    let code = engine.next_code();
                    hashes.push(code.hash.clone());
                    engine.scan_ok(&code, None);
                }
            }
            assert_eq!(
                hashes.len(),
                40,
                "seed {seed}: the scanner never stalls for good"
            );
            let mut guard = 0;
            while !engine.close_open() {
                guard += 1;
                assert!(guard < 100, "seed {seed}: close_open never finishes");
                for extension in [0u8, 1] {
                    if engine.topup_request(extension).is_some() {
                        supply(&mut engine, &config, extension, &mut state);
                    }
                }
            }
            let queued = engine.batch(usize::MAX);
            let mut box_serials = std::collections::HashSet::new();
            let mut pallet_serials = std::collections::HashSet::new();
            let mut items = 0u32;
            let mut seen_boxes = std::collections::HashSet::new();
            let mut per_pallet: std::collections::HashMap<String, u32> = Default::default();
            let mut scan_hashes = Vec::new();
            for item in &queued {
                match item.meta.kind {
                    FactKind::Scan => {
                        let scan: markiro_proto::ScanFact = data(item);
                        scan_hashes.push(scan.code.unwrap().code_hash);
                    }
                    FactKind::BoxClosed => {
                        let closed: BoxClosedFact = data(item);
                        assert!(box_serials.insert(closed.serial), "seed {seed}");
                        assert!(rules::names_serial(
                            &closed.sscc,
                            0,
                            &config.issuer_prefix,
                            closed.serial
                        ));
                        assert!(closed.item_count >= 1 && closed.item_count <= box_capacity);
                        assert!(seen_boxes.insert(closed.box_id.clone()));
                        items += closed.item_count;
                        assert_eq!(closed.pallet_id.is_some(), pallet_boxes > 0);
                        if let Some(id) = closed.pallet_id {
                            *per_pallet.entry(id).or_default() += 1;
                        }
                    }
                    FactKind::PalletClosed => {
                        let closed: PalletClosedFact = data(item);
                        assert!(pallet_boxes > 0);
                        assert!(pallet_serials.insert(closed.serial), "seed {seed}");
                        assert!(rules::names_serial(
                            &closed.sscc,
                            1,
                            &config.issuer_prefix,
                            closed.serial
                        ));
                        assert_eq!(
                            per_pallet.get(&closed.pallet_id).copied(),
                            Some(closed.box_count),
                            "seed {seed}: a pallet counts the boxes that named it"
                        );
                        assert!(closed.box_count >= 1 && closed.box_count <= pallet_boxes);
                    }
                    other => panic!("unexpected {other:?}"),
                }
            }
            assert_eq!(items, 40, "seed {seed}: every scan is in a box");
            assert_eq!(scan_hashes, hashes);
            assert_eq!(engine.boxes_closed as usize, seen_boxes.len());
            assert_eq!(engine.pallets_closed as usize, pallet_serials.len());
            assert_eq!(engine.items_in_open_box, 0);
            if pallet_boxes > 0 {
                assert_eq!(per_pallet.values().sum::<u32>() as usize, seen_boxes.len());
                assert_eq!(per_pallet.len(), pallet_serials.len());
            }
        }
    }
}
