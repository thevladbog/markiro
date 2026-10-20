//! The participant store and the shift totals (plan 2b): states move only along their rules, a
//! revoked device holds no slot, the office closes whatever is open, and the totals are the facts'.

mod support;

use markiro_host::{shift_participants as participants, shift_totals};
use markiro_proto::{DeviceKind, ParticipantClosedBy, ParticipantState};
use support::app::{
    accepted, admin, box_id, fact, instant, ok_scan, open_floor, open_validation_floor,
    pair_device, receipts, record_id, shift_setup,
};

#[tokio::test]
async fn a_participants_state_moves_along_its_rules() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_floor(&admin, &setup, &admin.key, &setup.line).await;
    let opened = admin.app.state.timestamp();
    let (other, _) = pair_device(&admin.app, "station").await;
    let mut conn = admin.app.state.pool.acquire().await.unwrap();
    let shift = floor.shift.as_str();
    assert_eq!(
        participants::state_of(&mut conn, shift, &floor.station)
            .await
            .unwrap(),
        Some(ParticipantState::Active)
    );
    assert_eq!(
        participants::state_of(&mut conn, shift, &other)
            .await
            .unwrap(),
        None
    );
    assert_eq!(
        participants::active_others(&mut conn, shift, &other)
            .await
            .unwrap(),
        1
    );
    participants::join(&mut conn, shift, &other, "2026-10-08T07:00:00Z")
        .await
        .unwrap();
    assert_eq!(participants::count_all(&mut conn, shift).await.unwrap(), 2);
    assert_eq!(
        participants::active_others(&mut conn, shift, &floor.station)
            .await
            .unwrap(),
        1
    );
    participants::leave(&mut conn, shift, &other, "2026-10-08T07:30:00Z")
        .await
        .unwrap();
    assert_eq!(
        participants::active_others(&mut conn, shift, &floor.station)
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        participants::open_others(&mut conn, shift, &floor.station)
            .await
            .unwrap(),
        1
    );
    // A second leave finds no active part: the writer refuses rather than invent one.
    assert!(
        participants::leave(&mut conn, shift, &other, "2026-10-08T07:31:00Z")
            .await
            .is_err()
    );
    participants::rejoin(&mut conn, shift, &other, "2026-10-08T08:00:00Z")
        .await
        .unwrap();
    participants::close_by_device(
        &mut conn,
        shift,
        &other,
        "2026-10-08T09:00:00Z",
        12,
        Some("equipment_stop"),
    )
    .await
    .unwrap();
    assert!(
        participants::mark_late(&mut conn, shift, &other, "2026-10-08T09:05:00Z")
            .await
            .unwrap()
    );
    assert!(
        !participants::mark_late(&mut conn, shift, &other, "2026-10-08T09:06:00Z")
            .await
            .unwrap()
    );
    assert!(
        !participants::mark_late(&mut conn, shift, &floor.station, "2026-10-08T09:06:00Z")
            .await
            .unwrap()
    );
    let list = participants::list(&mut conn, shift).await.unwrap();
    assert_eq!(list.len(), 2);
    let (first, second) = (&list[0], &list[1]);
    assert_eq!(
        (
            first.device_id.as_str(),
            first.device_kind,
            first.state,
            first.first_entered_at.as_str(),
            first.joined_at.as_str()
        ),
        (
            floor.station.as_str(),
            DeviceKind::Station,
            ParticipantState::Active,
            opened.as_str(),
            opened.as_str()
        )
    );
    assert_eq!(
        (
            second.device_id.as_str(),
            second.device_name.as_str(),
            second.state,
            second.first_entered_at.as_str(),
            second.joined_at.as_str(),
            second.left_at.as_deref(),
            second.closed_at.as_deref(),
            second.closed_by,
            second.closed_actual_qty,
            second.closed_reason_code.as_deref(),
            second.late_data_at.as_deref()
        ),
        (
            other.as_str(),
            "Тестовое устройство",
            ParticipantState::Closed,
            "2026-10-08T07:00:00Z",
            "2026-10-08T08:00:00Z",
            None,
            Some("2026-10-08T09:00:00Z"),
            Some(ParticipantClosedBy::Device),
            Some(12),
            Some("equipment_stop"),
            Some("2026-10-08T09:05:00Z")
        )
    );
    assert_eq!(
        participants::line_slots_in_use(&mut conn, &setup.line)
            .await
            .unwrap(),
        1
    );
    let closed = participants::close_open_by_office(&mut conn, shift, "2026-10-08T10:00:00Z")
        .await
        .unwrap();
    assert_eq!(
        closed,
        vec![(floor.station.clone(), ParticipantState::Active)]
    );
    let list = participants::list(&mut conn, shift).await.unwrap();
    assert_eq!(
        (list[0].state, list[0].closed_by, list[0].closed_actual_qty),
        (
            ParticipantState::Closed,
            Some(ParticipantClosedBy::OfficeUser),
            None
        )
    );
    assert!(
        participants::close_open_by_office(&mut conn, shift, "2026-10-08T10:01:00Z")
            .await
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn a_revoked_device_holds_no_slot() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_floor(&admin, &setup, &admin.key, &setup.line).await;
    let (other, _) = pair_device(&admin.app, "station").await;
    let mut conn = admin.app.state.pool.acquire().await.unwrap();
    participants::join(&mut conn, &floor.shift, &other, "2026-10-08T07:00:00Z")
        .await
        .unwrap();
    sqlx::query("UPDATE devices SET revoked_at = '2026-10-08T07:10:00Z' WHERE id = ?")
        .bind(&other)
        .execute(&mut *conn)
        .await
        .unwrap();
    assert_eq!(
        participants::active_others(&mut conn, &floor.shift, &floor.station)
            .await
            .unwrap(),
        0
    );
    // Its part is still open: only the office closes it.
    assert_eq!(
        participants::open_others(&mut conn, &floor.shift, &floor.station)
            .await
            .unwrap(),
        1
    );
}

#[tokio::test]
async fn the_totals_are_the_facts_of_the_whole_shift_and_of_each_device() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_floor(&admin, &setup, &admin.key, &setup.line).await;
    let (other, other_key) = pair_device(&admin.app, "station").await;
    {
        let mut conn = admin.app.state.pool.acquire().await.unwrap();
        participants::join(&mut conn, &floor.shift, &other, "2026-10-08T07:00:00Z")
            .await
            .unwrap();
    }
    let scan = |n: u32, record: u32, box_n: u32| {
        fact(
            &record_id(record),
            "scan",
            &floor.shift,
            ok_scan(n, &box_id(box_n), &instant(n, 0)),
        )
    };
    assert_eq!(
        receipts(&admin.app, &floor.key, &[scan(1, 1, 1), scan(2, 2, 1)]).await,
        vec![accepted(&record_id(1)), accepted(&record_id(2))]
    );
    assert_eq!(
        receipts(&admin.app, &other_key, &[scan(3, 1, 2)]).await,
        vec![accepted(&record_id(1))]
    );
    let mut conn = admin.app.state.pool.acquire().await.unwrap();
    let totals = shift_totals::totals(&mut conn, &floor.shift, "2026-10-08T07:30:00Z")
        .await
        .unwrap();
    assert_eq!(
        (
            totals.accepted,
            totals.boxes_closed,
            totals.pallets,
            totals.as_of.as_str()
        ),
        (3, 0, 0, "2026-10-08T07:30:00Z")
    );
    assert_eq!(
        shift_totals::shift_accepted(&mut conn, &floor.shift)
            .await
            .unwrap(),
        3
    );
    let parts: Vec<(String, u64, u32, u32)> = shift_totals::by_device(&mut conn, &floor.shift)
        .await
        .unwrap()
        .into_iter()
        .map(|part| {
            (
                part.device_id,
                part.accepted,
                part.boxes_closed,
                part.pallets,
            )
        })
        .collect();
    assert_eq!(
        parts,
        vec![(floor.station.clone(), 2, 0, 0), (other.clone(), 1, 0, 0)]
    );
}

/// Insert the rows the totals read straight into the facts' tables (the scans they would come
/// from are not the totals' business): foreign keys off for the connection, restored after.
struct Rows {
    n: u32,
}

impl Rows {
    fn new() -> Self {
        Self { n: 0 }
    }

    fn next(&mut self) -> u32 {
        self.n += 1;
        self.n
    }

    /// A box of `device`; `closed`/`disassembled` set the stamps the CHECKs tie together.
    async fn boxed(
        &mut self,
        conn: &mut sqlx::SqliteConnection,
        shift: &str,
        device: &str,
        closed: bool,
        disassembled: bool,
    ) -> String {
        let n = self.next();
        let id = format!("00000000-0000-4000-8000-{n:012}");
        let (closed_at, sscc, block, serial, digest) = if closed {
            (
                Some("2026-10-08T08:00:00Z"),
                Some(format!("0{n:017}")),
                Some("block"),
                Some(n),
                Some(1),
            )
        } else {
            (None, None, None, None, None)
        };
        sqlx::query(
            "INSERT INTO boxes (id, shift_id, device_id, opened_at, closed_at, sscc, block_id, \
             serial, digest_matches, disassembled_at, received_at) \
             VALUES (?, ?, ?, '2026-10-08T07:00:00Z', ?, ?, ?, ?, ?, ?, '2026-10-08T07:00:00Z')",
        )
        .bind(&id)
        .bind(shift)
        .bind(device)
        .bind(closed_at)
        .bind(sscc)
        .bind(block)
        .bind(serial)
        .bind(digest)
        .bind(disassembled.then_some("2026-10-08T08:30:00Z"))
        .execute(&mut *conn)
        .await
        .unwrap();
        id
    }

    async fn pallet(
        &mut self,
        conn: &mut sqlx::SqliteConnection,
        shift: &str,
        device: &str,
        closed: bool,
        disassembled: bool,
    ) {
        let n = self.next();
        let (closed_at, sscc, block, serial, reported) = if closed {
            (
                Some("2026-10-08T08:00:00Z"),
                Some(format!("1{n:017}")),
                Some("block"),
                Some(n),
                Some(2),
            )
        } else {
            (None, None, None, None, None)
        };
        sqlx::query(
            "INSERT INTO pallets (id, shift_id, device_id, opened_at, closed_at, sscc, block_id, \
             serial, box_count_reported, disassembled_at, received_at) \
             VALUES (?, ?, ?, '2026-10-08T07:00:00Z', ?, ?, ?, ?, ?, ?, '2026-10-08T07:00:00Z')",
        )
        .bind(format!("00000000-0000-4000-9000-{n:012}"))
        .bind(shift)
        .bind(device)
        .bind(closed_at)
        .bind(sscc)
        .bind(block)
        .bind(serial)
        .bind(reported)
        .bind(disassembled.then_some("2026-10-08T08:30:00Z"))
        .execute(&mut *conn)
        .await
        .unwrap();
    }

    /// An item of `box_id`; `removed`/`displaced` mark it out of the box.
    async fn item(
        &mut self,
        conn: &mut sqlx::SqliteConnection,
        box_id: &str,
        removed: bool,
        displaced: bool,
    ) -> u32 {
        let n = self.next();
        sqlx::query(
            "INSERT INTO box_items (scan_id, box_id, code_hash, added_at, removed_at, \
             displaced_at) VALUES (?, ?, ?, '2026-10-08T07:10:00Z', ?, ?)",
        )
        .bind(format!("scan-{n}"))
        .bind(box_id)
        .bind(format!("hash-{n}"))
        .bind(removed.then_some("2026-10-08T07:20:00Z"))
        .bind(displaced.then_some("2026-10-08T07:20:00Z"))
        .execute(&mut *conn)
        .await
        .unwrap();
        n
    }

    /// The owner of a code; `box_id` `None` is a validation scan, which no box lists.
    async fn owner(
        &mut self,
        conn: &mut sqlx::SqliteConnection,
        shift: &str,
        device: &str,
        box_id: Option<&str>,
        scan: Option<u32>,
    ) {
        let n = self.next();
        sqlx::query(
            "INSERT INTO code_owners (code_hash, scan_id, shift_id, device_id, box_id, \
             scanned_at) VALUES (?, ?, ?, ?, ?, '2026-10-08T07:10:00Z')",
        )
        .bind(format!("owner-hash-{n}"))
        .bind(scan.map_or_else(|| format!("owner-scan-{n}"), |scan| format!("scan-{scan}")))
        .bind(shift)
        .bind(device)
        .bind(box_id)
        .execute(&mut *conn)
        .await
        .unwrap();
    }
}

async fn totals_triple(conn: &mut sqlx::SqliteConnection, shift: &str) -> (u64, u32, u32) {
    let totals = shift_totals::totals(conn, shift, "2026-10-08T12:00:00Z")
        .await
        .unwrap();
    (totals.accepted, totals.boxes_closed, totals.pallets)
}

#[tokio::test]
async fn the_totals_count_closed_boxes_and_pallets_by_device_and_leave_out_the_taken_apart() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_floor(&admin, &setup, &admin.key, &setup.line).await;
    let (other, _) = pair_device(&admin.app, "station").await;
    let (idle, _) = pair_device(&admin.app, "station").await;
    let mut conn = admin.app.state.pool.acquire().await.unwrap();
    for (device, at) in [
        (&other, "2026-10-08T07:00:00Z"),
        (&idle, "2026-10-08T07:05:00Z"),
    ] {
        participants::join(&mut conn, &floor.shift, device, at)
            .await
            .unwrap();
    }
    sqlx::query("PRAGMA foreign_keys = OFF")
        .execute(&mut *conn)
        .await
        .unwrap();
    let (shift, a) = (floor.shift.as_str(), floor.station.as_str());
    let mut rows = Rows::new();
    // Device A: a closed box with live, removed and displaced items; an open box with live ones;
    // a taken-apart box whose items were removed; pallets closed, open and taken apart.
    let closed = rows.boxed(&mut conn, shift, a, true, false).await;
    for (removed, displaced) in [
        (false, false),
        (false, false),
        (false, false),
        (true, false),
        (false, true),
    ] {
        rows.item(&mut conn, &closed, removed, displaced).await;
    }
    let open = rows.boxed(&mut conn, shift, a, false, false).await;
    for _ in 0..2 {
        rows.item(&mut conn, &open, false, false).await;
    }
    let apart = rows.boxed(&mut conn, shift, a, true, true).await;
    rows.item(&mut conn, &apart, true, false).await;
    rows.pallet(&mut conn, shift, a, true, false).await;
    rows.pallet(&mut conn, shift, a, false, false).await;
    rows.pallet(&mut conn, shift, a, true, true).await;
    // Device B: one closed box of two live items and one closed pallet.
    let b_box = rows.boxed(&mut conn, shift, &other, true, false).await;
    for _ in 0..2 {
        rows.item(&mut conn, &b_box, false, false).await;
    }
    rows.pallet(&mut conn, shift, &other, true, false).await;

    assert_eq!(totals_triple(&mut conn, shift).await, (7, 2, 2));
    assert_eq!(
        shift_totals::shift_accepted(&mut conn, shift)
            .await
            .unwrap(),
        7
    );
    let parts = shift_totals::by_device(&mut conn, shift).await.unwrap();
    let got: Vec<(&str, u64, u32, u32)> = parts
        .iter()
        .map(|p| (p.device_id.as_str(), p.accepted, p.boxes_closed, p.pallets))
        .collect();
    // First entry first; the idle device counts zeros.
    assert_eq!(
        got,
        vec![
            (a, 5, 1, 1),
            (other.as_str(), 2, 1, 1),
            (idle.as_str(), 0, 0, 0)
        ]
    );
    let sum = parts.iter().fold((0, 0, 0), |acc, p| {
        (
            acc.0 + p.accepted,
            acc.1 + p.boxes_closed,
            acc.2 + p.pallets,
        )
    });
    assert_eq!(sum, totals_triple(&mut conn, shift).await);
    sqlx::query("PRAGMA foreign_keys = ON")
        .execute(&mut *conn)
        .await
        .unwrap();
}

#[tokio::test]
async fn a_validation_shift_counts_the_unboxed_codes_once_each_by_their_owner() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_validation_floor(&admin, &setup, &admin.key, &setup.line).await;
    let (other, _) = pair_device(&admin.app, "station").await;
    let mut conn = admin.app.state.pool.acquire().await.unwrap();
    participants::join(&mut conn, &floor.shift, &other, "2026-10-08T07:00:00Z")
        .await
        .unwrap();
    sqlx::query("PRAGMA foreign_keys = OFF")
        .execute(&mut *conn)
        .await
        .unwrap();
    let (shift, a) = (floor.shift.as_str(), floor.station.as_str());
    let mut rows = Rows::new();
    // A box with a live item the validation total must not add on top of the owners.
    let boxed = rows.boxed(&mut conn, shift, a, true, false).await;
    let listed = rows.item(&mut conn, &boxed, false, false).await;
    rows.owner(&mut conn, shift, a, None, None).await;
    rows.owner(&mut conn, shift, a, None, None).await;
    rows.owner(&mut conn, shift, &other, None, None).await;
    // An owner that is also an item of a box (a boxed code): not a validation scan.
    rows.owner(&mut conn, shift, a, Some(&boxed), Some(listed))
        .await;

    assert_eq!(totals_triple(&mut conn, shift).await, (3, 1, 0));
    let parts = shift_totals::by_device(&mut conn, shift).await.unwrap();
    let got: Vec<(&str, u64, u32)> = parts
        .iter()
        .map(|p| (p.device_id.as_str(), p.accepted, p.boxes_closed))
        .collect();
    assert_eq!(got, vec![(a, 2, 1), (other.as_str(), 1, 0)]);
    sqlx::query("PRAGMA foreign_keys = ON")
        .execute(&mut *conn)
        .await
        .unwrap();
}

#[tokio::test]
async fn the_totals_of_an_unknown_shift_are_not_found() {
    let admin = admin().await;
    let mut conn = admin.app.state.pool.acquire().await.unwrap();
    let unknown = "00000000-0000-4000-8000-00000000dead";
    let error = shift_totals::totals(&mut conn, unknown, "2026-10-08T12:00:00Z")
        .await
        .unwrap_err();
    assert_eq!(error.status().as_u16(), 404);
    let error = shift_totals::shift_accepted(&mut conn, unknown)
        .await
        .unwrap_err();
    assert_eq!(error.status().as_u16(), 404);
}

#[tokio::test]
async fn the_guarded_writers_refuse_a_participant_not_in_their_state() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_floor(&admin, &setup, &admin.key, &setup.line).await;
    let mut conn = admin.app.state.pool.acquire().await.unwrap();
    let (shift, a) = (floor.shift.as_str(), floor.station.as_str());
    // The reference refusal: a second leave.
    participants::leave(&mut conn, shift, a, "2026-10-08T07:30:00Z")
        .await
        .unwrap();
    let reference = participants::leave(&mut conn, shift, a, "2026-10-08T07:31:00Z")
        .await
        .unwrap_err();
    // A left participant is not touched (not active).
    let touch = participants::touch(&mut conn, shift, a, "2026-10-08T07:32:00Z")
        .await
        .unwrap_err();
    assert_eq!(touch.code(), reference.code());
    assert_eq!(touch.status(), reference.status());
    // Rejoin, then rejoin again: the row is active, not left.
    participants::rejoin(&mut conn, shift, a, "2026-10-08T08:00:00Z")
        .await
        .unwrap();
    let rejoin = participants::rejoin(&mut conn, shift, a, "2026-10-08T08:01:00Z")
        .await
        .unwrap_err();
    assert_eq!(rejoin.code(), reference.code());
    assert_eq!(rejoin.status(), reference.status());
    // A device that never entered is no participant at all.
    let missing = participants::touch(&mut conn, shift, "no-such-device", "2026-10-08T08:02:00Z")
        .await
        .unwrap_err();
    assert_eq!(missing.code(), reference.code());
    // Close, then close again.
    participants::close_by_device(&mut conn, shift, a, "2026-10-08T09:00:00Z", 1, None)
        .await
        .unwrap();
    let close = participants::close_by_device(&mut conn, shift, a, "2026-10-08T09:01:00Z", 2, None)
        .await
        .unwrap_err();
    assert_eq!(close.code(), reference.code());
    assert_eq!(close.status(), reference.status());
    // The refused close changed nothing.
    let list = participants::list(&mut conn, shift).await.unwrap();
    assert_eq!(
        (list[0].closed_at.as_deref(), list[0].closed_actual_qty),
        (Some("2026-10-08T09:00:00Z"), Some(1))
    );
}
