mod support;

use axum::http::StatusCode;
use serde_json::{json, Value};
use sqlx::migrate::Migrator;
use sqlx::{Connection, SqliteConnection};
use support::app::{
    admin, audit_row, audit_rows, audit_trail, box_id, empty, host_revision, instant, record_id,
    request, sscc, with_device, Floor,
};
use support::conflicts::{conflict_id, conflict_scene};

/// Every migration before `0022`: a host of the integration branch before plan КНФ.
fn before_0022() -> Migrator {
    Migrator {
        migrations: markiro_host::db::MIGRATOR
            .iter()
            .filter(|migration| migration.version < 22)
            .cloned()
            .collect::<Vec<_>>()
            .into(),
        ..Migrator::DEFAULT
    }
}

/// Migration `0022` over a host that kept two conflicts of 2a: the loser of
/// one had been accepted (its item was displaced), the other's receipt said
/// `conflict`. Each takes its kind from the loser's receipt; nobody reviewed
/// either, and the new columns and indexes are there.
#[tokio::test]
async fn migration_0022_gives_old_conflicts_their_kind_and_adds_the_review() {
    let mut db = SqliteConnection::connect("sqlite::memory:").await.unwrap();
    before_0022().run(&mut db).await.unwrap();
    // The rows a conflict joins, without the rest of a host: the foreign keys
    // of `scans` are not what this test is about.
    sqlx::query("PRAGMA foreign_keys = OFF")
        .execute(&mut db)
        .await
        .unwrap();
    for (scan, record) in [
        ("s-winner", "r-w"),
        ("s-displaced", "r-d"),
        ("s-late", "r-l"),
        ("s-unreceipted", "r-u"),
    ] {
        sqlx::query(
            "INSERT INTO scans (id, record_id, device_id, shift_id, verdict, raw_kind, \
             raw_length, code_hash, gtin14, serial, canonical, box_id, scanned_at, received_at) \
             VALUES (?, ?, 'device-1', 'shift-1', 'ok', 'km', 38, ?, '04600682000013', 'S1', \
             'c', 'box-1', '2026-10-08T06:00:00.000Z', '2026-10-08T06:00:01Z')",
        )
        .bind(scan)
        .bind(record)
        .bind(format!("{:064x}", 7))
        .execute(&mut db)
        .await
        .unwrap();
    }
    for (record, outcome) in [
        ("r-w", "accepted"),
        ("r-d", "accepted"),
        ("r-l", "conflict"),
    ] {
        sqlx::query(
            "INSERT INTO fact_receipts (device_id, record_id, kind, shift_id, digest, outcome, \
             received_at) VALUES ('device-1', ?, 'scan', 'shift-1', ?, ?, '2026-10-08T06:00:01Z')",
        )
        .bind(record)
        .bind("0".repeat(64))
        .bind(outcome)
        .execute(&mut db)
        .await
        .unwrap();
    }
    // A loser without a receipt (none should exist) stays `late`.
    for (id, loser) in [
        ("c-displaced", "s-displaced"),
        ("c-late", "s-late"),
        ("c-unreceipted", "s-unreceipted"),
    ] {
        sqlx::query(
            "INSERT INTO code_conflicts (id, code_hash, winner_scan_id, loser_scan_id, \
             detected_at) VALUES (?, ?, 's-winner', ?, '2026-10-08T06:00:01Z')",
        )
        .bind(id)
        .bind(format!("{:064x}", 7))
        .bind(loser)
        .execute(&mut db)
        .await
        .unwrap();
    }
    sqlx::query("PRAGMA foreign_keys = ON")
        .execute(&mut db)
        .await
        .unwrap();

    markiro_host::db::MIGRATOR.run(&mut db).await.unwrap();

    let rows: Vec<(String, String, Option<String>, Option<String>)> =
        sqlx::query_as("SELECT id, kind, reviewed_at, reviewed_by FROM code_conflicts ORDER BY id")
            .fetch_all(&mut db)
            .await
            .unwrap();
    assert_eq!(
        rows,
        vec![
            ("c-displaced".into(), "displaced".into(), None, None),
            ("c-late".into(), "late".into(), None, None),
            ("c-unreceipted".into(), "late".into(), None, None),
        ]
    );
    let indexes: Vec<String> = sqlx::query_scalar(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name IN \
         ('code_conflicts_loser', 'code_conflicts_detected', 'fact_receipts_rejected', \
          'box_exceptions_shift', 'pallet_exceptions_shift') ORDER BY name",
    )
    .fetch_all(&mut db)
    .await
    .unwrap();
    assert_eq!(indexes.len(), 5, "{indexes:?}");
    // A review names its reviewer, and a reviewer names a review.
    let half = sqlx::query(
        "UPDATE code_conflicts SET reviewed_at = '2026-10-08T07:00:00Z' WHERE id = 'c-late'",
    )
    .execute(&mut db)
    .await;
    assert!(half.is_err(), "reviewed_at without reviewed_by must fail");
    let kind = sqlx::query("UPDATE code_conflicts SET kind = 'twice' WHERE id = 'c-late'")
        .execute(&mut db)
        .await;
    assert!(kind.is_err());
    let integrity: String = sqlx::query_scalar("PRAGMA integrity_check")
        .fetch_one(&mut db)
        .await
        .unwrap();
    assert_eq!(integrity, "ok");
}

fn side(floor: &Floor, name: &str, operator: Value, at: String, n: u32, sscc: Value) -> Value {
    json!({
        "shiftId": floor.shift, "shiftNumber": floor.number, "deviceId": floor.station,
        "deviceName": name, "operatorName": operator, "scannedAt": at,
        "boxId": box_id(n), "boxSscc": sscc
    })
}

#[tokio::test]
async fn the_list_names_both_sides_of_each_conflict_newest_first_without_the_full_code() {
    let s = conflict_scene().await;
    let (status, page) = s.admin.call("GET", "/v1/office/conflicts", None).await;
    assert_eq!(status, StatusCode::OK, "{page}");
    let late = conflict_id(&s.admin, &record_id(12)).await;
    let displaced = conflict_id(&s.admin, &record_id(2)).await;
    // One batch detected both: the later losing scan comes first.
    assert_eq!(
        page,
        json!({
            "items": [
                {
                    "id": late, "kind": "late", "codeHash": format!("{:064x}", 8),
                    "gtin14": "04600682000013", "serial": "S000008",
                    "loser": side(&s.b, "Станция Б", json!("Анна Кузнецова"), instant(200, 0), 2, Value::Null),
                    "winner": side(&s.a, "Станция А", Value::Null, instant(10, 0), 1, json!(sscc(1500))),
                    "detectedAt": s.detected_at, "reviewedAt": null, "reviewedByName": null
                },
                {
                    "id": displaced, "kind": "displaced", "codeHash": format!("{:064x}", 7),
                    "gtin14": "04600682000013", "serial": "S000007",
                    "loser": side(&s.a, "Станция А", Value::Null, instant(100, 0), 1, json!(sscc(1500))),
                    "winner": side(&s.b, "Станция Б", Value::Null, instant(50, 0), 2, Value::Null),
                    "detectedAt": s.detected_at, "reviewedAt": null, "reviewedByName": null
                }
            ],
            "page": 1, "pageCount": 1, "total": 2
        })
    );
    // The canonical text of the test codes ends with a crypto tail «93Tail<n>».
    assert!(!page.to_string().contains("93Tail"));
}

#[tokio::test]
async fn the_list_narrows_by_the_losing_shift_and_by_review_and_checks_its_parameters() {
    let s = conflict_scene().await;
    let late = conflict_id(&s.admin, &record_id(12)).await;
    let displaced = conflict_id(&s.admin, &record_id(2)).await;
    let list = |query: String| {
        let admin = &s.admin;
        async move {
            let (status, page) = admin
                .call("GET", &format!("/v1/office/conflicts{query}"), None)
                .await;
            assert_eq!(status, StatusCode::OK, "{query}: {page}");
            let ids: Vec<String> = page["items"]
                .as_array()
                .unwrap()
                .iter()
                .map(|c| c["id"].as_str().unwrap().to_owned())
                .collect();
            (page["total"].as_u64().unwrap(), ids)
        }
    };
    // The losing shift, not the winning one.
    assert_eq!(
        list(format!("?shift={}", s.b.shift)).await,
        (1, vec![late.clone()])
    );
    assert_eq!(
        list(format!("?shift={}", s.a.shift)).await,
        (1, vec![displaced.clone()])
    );
    // A shift the host does not have lists nothing (no `not_found`).
    assert_eq!(
        list("?shift=5a0c9e1e-3d4f-4b8a-9c2d-1e0f9a8b7c6d".to_owned()).await,
        (0, vec![])
    );
    assert_eq!(
        list("?reviewed=false".to_owned()).await,
        (2, vec![late.clone(), displaced.clone()])
    );
    assert_eq!(list("?reviewed=true".to_owned()).await, (0, vec![]));
    // Both criteria together, after B's conflict is reviewed.
    let (status, _) = s
        .admin
        .call("POST", &format!("/v1/office/conflicts/{late}/review"), None)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        list(format!("?shift={}&reviewed=true", s.b.shift)).await,
        (1, vec![late.clone()])
    );
    assert_eq!(
        list(format!("?shift={}&reviewed=false", s.b.shift)).await,
        (0, vec![])
    );
    assert_eq!(
        list(format!("?shift={}&reviewed=false", s.a.shift)).await,
        (1, vec![displaced.clone()])
    );
    let (_, beyond) = s
        .admin
        .call("GET", "/v1/office/conflicts?page=2", None)
        .await;
    assert_eq!(
        (beyond["page"].clone(), beyond["items"].clone()),
        (json!(2), json!([]))
    );
    for (query, field) in [
        ("shift=nonsense", "shift"),
        ("reviewed=maybe", "reviewed"),
        ("page=0", "page"),
        ("page=201", "page"),
        ("page=+1", "page"),
    ] {
        let (status, body) = s
            .admin
            .call("GET", &format!("/v1/office/conflicts?{query}"), None)
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{query}: {body}");
        assert_eq!(body["error"]["details"]["field"], field, "{query}");
    }
    let (status, body) = s
        .admin
        .call("GET", "/v1/office/conflicts?other=1", None)
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"]["code"], "validation_failed", "{body}");
}

/// 52 conflicts: a page holds 50, the second the rest, in one order across
/// the pages; the page count follows.
#[tokio::test]
async fn the_list_pages_by_fifty_in_one_order() {
    let s = conflict_scene().await;
    // Fifty more rows over the scene's scans, each detected later than the last.
    let (winner, loser): (String, String) = sqlx::query_as(
        "SELECT winner_scan_id, loser_scan_id FROM code_conflicts WHERE kind = 'late'",
    )
    .fetch_one(&s.admin.app.state.pool)
    .await
    .unwrap();
    for n in 0..50 {
        sqlx::query(
            "INSERT INTO code_conflicts (id, code_hash, winner_scan_id, loser_scan_id, kind, \
             detected_at) VALUES (?, ?, ?, ?, 'late', ?)",
        )
        .bind(format!("c0000000-0000-4000-8000-{n:012}"))
        .bind(format!("{:064x}", 8))
        .bind(&winner)
        .bind(&loser)
        .bind(format!("2099-01-01T00:00:{n:02}Z"))
        .execute(&s.admin.app.state.pool)
        .await
        .unwrap();
    }
    let read = |query: &'static str| {
        let admin = &s.admin;
        async move {
            let (status, page) = admin
                .call("GET", &format!("/v1/office/conflicts{query}"), None)
                .await;
            assert_eq!(status, StatusCode::OK, "{page}");
            page
        }
    };
    let first = read("").await;
    let second = read("?page=2").await;
    assert_eq!(
        (&first["page"], &first["pageCount"], &first["total"]),
        (&json!(1), &json!(2), &json!(52))
    );
    assert_eq!(
        (&second["page"], &second["pageCount"], &second["total"]),
        (&json!(2), &json!(2), &json!(52))
    );
    let ids = |page: &Value| -> Vec<String> {
        page["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["id"].as_str().unwrap().to_owned())
            .collect()
    };
    let (first, second) = (ids(&first), ids(&second));
    assert_eq!((first.len(), second.len()), (50, 2));
    // Newest detection first: the inserted rows 49…0, then the scene's two.
    let mut expected: Vec<String> = (0..50)
        .rev()
        .map(|n| format!("c0000000-0000-4000-8000-{n:012}"))
        .collect();
    expected.push(conflict_id(&s.admin, &record_id(12)).await);
    expected.push(conflict_id(&s.admin, &record_id(2)).await);
    assert_eq!([first, second].concat(), expected);
}

#[tokio::test]
async fn a_review_is_kept_once_with_its_reviewer_audit_row_and_revision() {
    let s = conflict_scene().await;
    let displaced = conflict_id(&s.admin, &record_id(2)).await;
    let path = format!("/v1/office/conflicts/{displaced}/review");
    let rev = host_revision(&s.admin.app).await;
    let reviewed_at = s.admin.app.state.timestamp();
    let admin_name: String = sqlx::query_scalar("SELECT name FROM office_users WHERE id = ?")
        .bind(&s.admin.id)
        .fetch_one(&s.admin.app.state.pool)
        .await
        .unwrap();
    let (status, body) = s.admin.call("POST", &path, None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        (body["reviewedAt"].clone(), body["reviewedByName"].clone()),
        (json!(reviewed_at), json!(admin_name))
    );
    assert_eq!(host_revision(&s.admin.app).await, rev + 1);
    let row = s.admin.row(
        "conflict.review",
        "code_conflict",
        &displaced,
        json!({ "kind": "displaced", "loserShiftId": s.a.shift, "loserDeviceId": s.a.station, "winnerShiftId": s.b.shift }),
    );
    assert_eq!(
        audit_trail(&s.admin.app, "conflict.review").await,
        vec![row.clone()]
    );
    // The same review again, by a technologist: the conflict as it is, nothing written.
    // (Seeding the technologist takes a revision of its own.)
    let (tech, tech_id) = s.admin.technologist_session().await;
    let audit_before = audit_rows(&s.admin.app).await;
    let rev_before = host_revision(&s.admin.app).await;
    let (status, again) = s.admin.call_as(&tech, "POST", &path, None).await;
    assert_eq!((status, again.clone()), (StatusCode::OK, body));
    assert_eq!(host_revision(&s.admin.app).await, rev_before);
    assert_eq!(audit_rows(&s.admin.app).await, audit_before);
    // A technologist reviews the other one: their own row.
    let late = conflict_id(&s.admin, &record_id(12)).await;
    let (status, _) = s
        .admin
        .call_as(
            &tech,
            "POST",
            &format!("/v1/office/conflicts/{late}/review"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        audit_trail(&s.admin.app, "conflict.review").await,
        vec![
            row,
            audit_row(
                &tech_id,
                "conflict.review",
                "code_conflict",
                &late,
                json!({ "kind": "late", "loserShiftId": s.b.shift, "loserDeviceId": s.b.station, "winnerShiftId": s.a.shift }),
            ),
        ]
    );
    let (_, done) = s
        .admin
        .call("GET", "/v1/office/conflicts?reviewed=true", None)
        .await;
    assert_eq!(done["total"], 2);
}

#[tokio::test]
async fn an_unknown_conflict_and_a_request_without_a_session_change_nothing() {
    let s = conflict_scene().await;
    let audit_before = audit_rows(&s.admin.app).await;
    let rev = host_revision(&s.admin.app).await;
    let (status, body) = s
        .admin
        .call(
            "POST",
            "/v1/office/conflicts/c0000000-0000-4000-8000-000000000099/review",
            None,
        )
        .await;
    assert_eq!(
        (status, body["error"]["code"].clone()),
        (StatusCode::NOT_FOUND, json!("not_found"))
    );
    let displaced = conflict_id(&s.admin, &record_id(2)).await;
    // A device key alone is no office session.
    let (status, _) = s
        .admin
        .app
        .send(empty(with_device(
            request("POST", &format!("/v1/office/conflicts/{displaced}/review")),
            &s.b.key,
        )))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = s
        .admin
        .app
        .send(empty(with_device(
            request("GET", "/v1/office/conflicts"),
            &s.b.key,
        )))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(audit_rows(&s.admin.app).await, audit_before);
    assert_eq!(host_revision(&s.admin.app).await, rev);
}

/// Both office roles review (spec §5.2): no role is refused today; a role
/// added later does not compile until `reviews_conflicts` names it.
#[test]
fn both_office_roles_review_conflicts() {
    use markiro_host::auth::reviews_conflicts;
    use markiro_proto::OfficeRole;
    assert!(reviews_conflicts(OfficeRole::Admin));
    assert!(reviews_conflicts(OfficeRole::Technologist));
}

/// The count of the list reaches the loser's scan by its key, never through
/// the journal of scans (a host keeps every scan for good).
#[tokio::test]
async fn the_lists_count_reads_the_losing_scan_by_its_key() {
    let admin = admin().await;
    let plan: Vec<(i64, i64, i64, String)> = sqlx::query_as(&format!(
        "EXPLAIN QUERY PLAN {}",
        markiro_host::routes::office_conflicts::COUNT
    ))
    .fetch_all(&admin.app.state.pool)
    .await
    .unwrap();
    let steps: Vec<&str> = plan.iter().map(|(_, _, _, step)| step.as_str()).collect();
    assert!(
        steps.iter().any(|step| step.starts_with("SEARCH l USING")
            && (step.contains("PRIMARY KEY") || step.contains("sqlite_autoindex_scans_1"))),
        "{steps:?}"
    );
    assert!(
        !steps.iter().any(|step| step.starts_with("SCAN l")),
        "{steps:?}"
    );
}
