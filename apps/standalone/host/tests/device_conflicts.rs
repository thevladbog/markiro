mod support;

use axum::http::StatusCode;
use serde_json::json;
use support::app::{box_id, empty, instant, json, record_id, request, sscc, with_device};
use support::conflicts::{conflict_id, conflict_scene};

#[tokio::test]
async fn a_station_learns_which_of_its_conflicts_the_office_reviewed() {
    let s = conflict_scene().await;
    let status = |key: String, ids: Vec<String>| {
        let app = &s.admin.app;
        async move {
            app.send(json(
                with_device(request("POST", "/v1/device/conflicts/status"), &key),
                json!({ "recordIds": ids }),
            ))
            .await
        }
    };
    // Nothing reviewed yet: B asks after its late scan and A's record, which is not B's.
    let (code, body) = status(s.b.key.clone(), vec![record_id(12), record_id(2)]).await;
    assert_eq!((code, body), (StatusCode::OK, json!({ "reviewed": [] })));
    for loser in [record_id(12), record_id(2)] {
        let id = conflict_id(&s.admin, &loser).await;
        s.admin
            .call("POST", &format!("/v1/office/conflicts/{id}/review"), None)
            .await;
    }
    let reviewed_at = s.admin.app.state.timestamp();
    // Each station hears of its own losing records only, whatever it asks.
    let (_, of_b) = status(
        s.b.key.clone(),
        vec![record_id(12), record_id(2), record_id(11)],
    )
    .await;
    assert_eq!(
        of_b,
        json!({ "reviewed": [{ "recordId": record_id(12), "reviewedAt": reviewed_at }] })
    );
    let (_, of_a) = status(s.a.key.clone(), vec![record_id(2), record_id(12)]).await;
    assert_eq!(
        of_a,
        json!({ "reviewed": [{ "recordId": record_id(2), "reviewedAt": reviewed_at }] })
    );
    // 0 and 201 ids, a malformed id, an extra field: validation_failed on recordIds.
    let too_many: Vec<String> = (1..=201).map(record_id).collect();
    for body in [
        json!({ "recordIds": [] }),
        json!({ "recordIds": too_many }),
        json!({ "recordIds": ["x"] }),
        json!({ "recordIds": [record_id(1)], "x": 1 }),
    ] {
        let (code, answer) = s
            .admin
            .app
            .send(json(
                with_device(request("POST", "/v1/device/conflicts/status"), &s.b.key),
                body,
            ))
            .await;
        assert_eq!(code, StatusCode::BAD_REQUEST, "{answer}");
        assert_eq!(answer["error"]["code"], "validation_failed", "{answer}");
    }
    // 200 ids are the most one request names, and they pass.
    let most: Vec<String> = (1..=200).map(record_id).collect();
    let (code, answer) = status(s.b.key.clone(), most).await;
    assert_eq!(
        (code, answer),
        (
            StatusCode::OK,
            json!({ "reviewed": [{ "recordId": record_id(12), "reviewedAt": reviewed_at }] })
        )
    );
}

#[tokio::test]
async fn a_displaced_station_learns_of_its_displacements_after_its_cursor() {
    let s = conflict_scene().await;
    let list = |key: String, query: String| {
        let app = &s.admin.app;
        async move {
            app.send(empty(with_device(
                request("GET", &format!("/v1/device/displacements{query}")),
                &key,
            )))
            .await
        }
    };
    let (code, body) = list(s.a.key.clone(), String::new()).await;
    assert_eq!(code, StatusCode::OK, "{body}");
    let conflict = conflict_id(&s.admin, &record_id(2)).await;
    assert_eq!(
        body,
        json!({ "items": [{
            "conflictId": conflict, "recordId": record_id(2), "shiftId": s.a.shift,
            "shiftNumber": s.a.number, "codeHash": format!("{:064x}", 7), "boxId": box_id(1),
            "boxSscc": sscc(1500), "detectedAt": s.detected_at,
            "winner": { "shiftId": s.b.shift, "shiftNumber": s.b.number, "deviceId": s.b.station,
                        "scannedAt": instant(50, 0), "sameDevice": false },
            "reviewedAt": null
        }], "more": false })
    );
    // B lost late, not by displacement: nothing for it.
    let (_, of_b) = list(s.b.key.clone(), String::new()).await;
    assert_eq!(of_b, json!({ "items": [], "more": false }));
    // After the cursor of the one A holds: nothing more.
    let (_, after) = list(
        s.a.key.clone(),
        format!("?afterAt={}&afterId={conflict}", s.detected_at),
    )
    .await;
    assert_eq!(after["items"], json!([]));
    // From the start of that second (the nil id): the station reads its newest second again.
    let (_, second) = list(
        s.a.key.clone(),
        format!(
            "?afterAt={}&afterId=00000000-0000-0000-0000-000000000000",
            s.detected_at
        ),
    )
    .await;
    assert_eq!(second["items"][0]["conflictId"], conflict);
    // One end of the cursor without the other, or either end malformed: an instant the host
    // never writes (its text would not order with `detected_at`), an id that is no UUID.
    let upper = conflict.to_uppercase();
    let millis = s.detected_at.replace('Z', ".000Z");
    for query in [
        format!("?afterAt={}", s.detected_at),
        format!("?afterId={conflict}"),
        format!("?afterAt=yesterday&afterId={conflict}"),
        format!("?afterAt={millis}&afterId={conflict}"),
        format!("?afterAt={}&afterId=x", s.detected_at),
        format!("?afterAt={}&afterId={upper}", s.detected_at),
    ] {
        let (code, body) = list(s.a.key.clone(), query.clone()).await;
        assert_eq!(code, StatusCode::BAD_REQUEST, "{query}: {body}");
    }
    // The office reviews the displacement: A hears it as reviewed when it reads it.
    let (status, _) = s
        .admin
        .call(
            "POST",
            &format!("/v1/office/conflicts/{conflict}/review"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let reviewed_at = s.admin.app.state.timestamp();
    let (_, again) = list(s.a.key.clone(), String::new()).await;
    assert_eq!(again["items"][0]["reviewedAt"], reviewed_at);
    // An office session alone (no device key) is refused like any device route.
    let (code, _) = s
        .admin
        .app
        .send(empty(request("GET", "/v1/device/displacements")))
        .await;
    assert_eq!(code, StatusCode::UNAUTHORIZED);
}

/// More displacements than a page: the first page says `more`, the cursor of
/// its last row reads the rest, oldest first.
#[tokio::test]
async fn displacements_come_a_page_at_a_time_after_the_cursor() {
    let s = conflict_scene().await;
    let (winner, loser): (String, String) = sqlx::query_as(
        "SELECT winner_scan_id, loser_scan_id FROM code_conflicts WHERE kind = 'displaced'",
    )
    .fetch_one(&s.admin.app.state.pool)
    .await
    .unwrap();
    // 120 more displacements of A's scan, detected together after the scene's.
    for n in 0..120 {
        sqlx::query(
            "INSERT INTO code_conflicts (id, code_hash, winner_scan_id, loser_scan_id, kind, \
             detected_at) VALUES (?, ?, ?, ?, 'displaced', ?)",
        )
        .bind(format!("d0000000-0000-4000-8000-{n:012}"))
        .bind(format!("{:064x}", 7))
        .bind(&winner)
        .bind(&loser)
        // One batch detects many at one instant: the id orders them.
        .bind("2099-01-01T00:00:00Z")
        .execute(&s.admin.app.state.pool)
        .await
        .unwrap();
    }
    let read = |query: String| {
        let app = &s.admin.app;
        let key = s.a.key.clone();
        async move {
            let (code, body) = app
                .send(empty(with_device(
                    request("GET", &format!("/v1/device/displacements{query}")),
                    &key,
                )))
                .await;
            assert_eq!(code, StatusCode::OK, "{body}");
            body
        }
    };
    let first = read(String::new()).await;
    let items = first["items"].as_array().unwrap();
    assert_eq!((items.len(), first["more"].clone()), (100, json!(true)));
    // Oldest first: the scene's own, then the inserted ones in order.
    assert_eq!(items[0]["detectedAt"], s.detected_at);
    assert_eq!(
        items[1]["conflictId"],
        "d0000000-0000-4000-8000-000000000000"
    );
    let last = &items[99];
    let second = read(format!(
        "?afterAt={}&afterId={}",
        last["detectedAt"].as_str().unwrap(),
        last["conflictId"].as_str().unwrap()
    ))
    .await;
    let rest = second["items"].as_array().unwrap();
    assert_eq!((rest.len(), second["more"].clone()), (21, json!(false)));
    assert_eq!(
        rest[0]["conflictId"],
        "d0000000-0000-4000-8000-000000000099"
    );
    assert_eq!(
        rest[20]["conflictId"],
        "d0000000-0000-4000-8000-000000000119"
    );
}

/// Both reads find a device's rows by its scans' index and the conflicts'
/// indexes of migration 0022, never by reading the journal of scans.
#[tokio::test]
async fn the_devices_reads_search_by_index() {
    let s = conflict_scene().await;
    for (name, sql) in [
        ("status", markiro_host::routes::device_conflicts::STATUS_SQL),
        (
            "displacements",
            markiro_host::routes::device_conflicts::DISPLACEMENTS_SQL,
        ),
    ] {
        let plan: Vec<(i64, i64, i64, String)> =
            sqlx::query_as(&format!("EXPLAIN QUERY PLAN {sql}"))
                .fetch_all(&s.admin.app.state.pool)
                .await
                .unwrap();
        let steps: Vec<&str> = plan.iter().map(|(_, _, _, step)| step.as_str()).collect();
        assert!(
            !steps.iter().any(|step| step.starts_with("SCAN l")
                || step.starts_with("SCAN w")
                || step.starts_with("SCAN c")),
            "{name}: {steps:?}"
        );
        if name == "status" {
            assert!(
                steps
                    .iter()
                    .any(|step| step.contains("code_conflicts_loser")),
                "{steps:?}"
            );
            assert!(
                steps
                    .iter()
                    .any(|step| step.contains("scans_record (device_id=? AND record_id=?)")),
                "{steps:?}"
            );
        } else {
            // The conflicts after the cursor, in their order: never the device's scans first.
            assert!(steps[0].contains("code_conflicts_detected"), "{steps:?}");
            assert!(
                !steps.iter().any(|step| step.contains("TEMP B-TREE")),
                "{steps:?}"
            );
        }
    }
}
