//! The participant store and the shift totals (plan 2b): states move only along their rules, a
//! revoked device holds no slot, the office closes whatever is open, and the totals are the facts'.

mod support;

use markiro_host::{shift_participants as participants, shift_totals};
use markiro_proto::{DeviceKind, ParticipantClosedBy, ParticipantState};
use support::app::{
    accepted, admin, box_id, fact, instant, ok_scan, open_floor, pair_device, receipts, record_id,
    shift_setup,
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
