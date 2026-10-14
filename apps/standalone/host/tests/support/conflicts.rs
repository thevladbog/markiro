//! The scene of plan КНФ's conflicts: two stations, a displaced scan and a
//! late one, shared by the office's and the devices' tests.

use serde_json::json;

use super::app::{
    accepted, add_operator, admin, box_closed, box_id, fact, instant, issue_block, ok_scan,
    open_floor, pair_device, receipts, record_id, shift_setup, Admin, Floor,
};

const BLOCK_A: &str = "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a";

/// Two stations, each in its own shift on its own line. Station A scans code 8
/// at 10 s and code 7 at 100 s into box 1 and closes it with SSCC 1500. Then,
/// a minute later on the host's clock, station B sends what it scanned
/// offline: code 7 at 50 s takes the code from A's box (`displaced`, loser A),
/// code 8 at 200 s by its operator loses to A (`late`, loser B, box 2 open).
pub struct ConflictScene {
    pub admin: Admin,
    pub a: Floor,
    pub b: Floor,
    pub detected_at: String,
}

pub async fn conflict_scene() -> ConflictScene {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let a = open_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let (_, colleague) = pair_device(&admin.app, "station").await;
    let b = open_floor(&admin, &setup, &colleague, &setup.other_line).await;
    for (id, name) in [(&a.station, "Станция А"), (&b.station, "Станция Б")] {
        sqlx::query("UPDATE devices SET name = ? WHERE id = ?")
            .bind(name)
            .bind(id)
            .execute(&admin.app.state.pool)
            .await
            .unwrap();
    }
    let (operator, _) = add_operator(&admin, "1001").await;
    let block = issue_block(&admin.app, &a.key, BLOCK_A).await;
    let from_a = [
        fact(
            &record_id(1),
            "scan",
            &a.shift,
            ok_scan(8, &box_id(1), &instant(10, 0)),
        ),
        fact(
            &record_id(2),
            "scan",
            &a.shift,
            ok_scan(7, &box_id(1), &instant(100, 0)),
        ),
        fact(
            &record_id(3),
            "box_closed",
            &a.shift,
            box_closed(
                &box_id(1),
                &block,
                1500,
                &[8, 7],
                &instant(10, 0),
                &instant(110, 0),
            ),
        ),
    ];
    let answered = receipts(&admin.app, &a.key, &from_a).await;
    assert!(
        answered.iter().all(|r| r["outcome"] == "accepted"),
        "{answered:?}"
    );
    admin.app.clock.advance(time::Duration::minutes(1));
    let detected_at = admin.app.state.timestamp();
    let mut late = fact(
        &record_id(12),
        "scan",
        &b.shift,
        ok_scan(8, &box_id(2), &instant(200, 0)),
    );
    late["operatorId"] = json!(operator);
    let from_b = [
        fact(
            &record_id(11),
            "scan",
            &b.shift,
            ok_scan(7, &box_id(2), &instant(50, 0)),
        ),
        late,
    ];
    let answered = receipts(&admin.app, &b.key, &from_b).await;
    assert_eq!(answered[0], accepted(&record_id(11)));
    assert_eq!(answered[1]["outcome"], "conflict", "{answered:?}");
    ConflictScene {
        admin,
        a,
        b,
        detected_at,
    }
}

pub async fn conflict_id(admin: &Admin, loser_record: &str) -> String {
    sqlx::query_scalar(
        "SELECT c.id FROM code_conflicts c JOIN scans l ON l.id = c.loser_scan_id \
         WHERE l.record_id = ?",
    )
    .bind(loser_record)
    .fetch_one(&admin.app.state.pool)
    .await
    .unwrap()
}
