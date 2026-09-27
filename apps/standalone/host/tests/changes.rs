mod support;

use axum::http::StatusCode;
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde_json::{json, Value};
use support::app::{
    bootstrap, empty, pair_device, request, seed_office_user, with_device, TestApp,
};

async fn changes(app: &TestApp, key: &str, query: &str) -> (StatusCode, Value) {
    app.send(empty(with_device(
        request("GET", &format!("/v1/changes{query}")),
        key,
    )))
    .await
}

/// `(entity, id, rev)` of each item, in the answer's order.
fn keys(body: &Value) -> Vec<(String, String, i64)> {
    body["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| {
            (
                item["entity"].as_str().unwrap().to_owned(),
                item["id"].as_str().unwrap().to_owned(),
                item["rev"].as_i64().unwrap(),
            )
        })
        .collect()
}

/// Insert lines in one transaction at a new revision; returns their ids (in
/// the given order) and the revision.
async fn add_lines(app: &TestApp, names: &[&str]) -> (Vec<String>, i64) {
    let mut tx = markiro_host::db::begin_write(&app.state.pool)
        .await
        .unwrap();
    let rev = markiro_host::db::next_revision(&mut tx).await.unwrap();
    let mut ids = Vec::new();
    for name in names {
        let id = uuid::Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO lines (id, name, name_key, archived, rev) VALUES (?, ?, ?, 0, ?)")
            .bind(&id)
            .bind(name)
            .bind(name.to_lowercase())
            .bind(rev)
            .execute(&mut *tx)
            .await
            .unwrap();
        ids.push(id);
    }
    tx.commit().await.unwrap();
    (ids, rev)
}

async fn line_ids_by_name(app: &TestApp) -> Vec<String> {
    sqlx::query_scalar("SELECT id FROM lines ORDER BY name")
        .fetch_all(&app.state.pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn a_fresh_host_has_an_empty_feed() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "station").await;
    let (status, body) = changes(&app, &key, "").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body,
        json!({ "hostId": app.state.host_id, "rev": 0, "hasMore": false, "items": [] })
    );
}

#[tokio::test]
async fn after_the_wizard_the_feed_holds_the_organization_the_site_and_the_lines() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "station").await;
    bootstrap(&app, &key).await;
    let salt: Vec<u8> = sqlx::query_scalar("SELECT badge_salt FROM site WHERE id = 1")
        .fetch_one(&app.state.pool)
        .await
        .unwrap();
    let mut lines: Vec<(String, String)> = sqlx::query_as("SELECT id, name FROM lines")
        .fetch_all(&app.state.pool)
        .await
        .unwrap();
    lines.sort();

    let (status, body) = changes(&app, &key, "?since=0").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let mut expected: Vec<Value> = lines
        .iter()
        .map(|(id, name)| {
            json!({ "entity": "lines", "id": id, "rev": 1, "deleted": false, "data": { "name": name, "archived": false } })
        })
        .collect();
    expected.push(json!({
        "entity": "org_profile", "id": "1", "rev": 1, "deleted": false,
        "data": { "name": "ООО «Атолл»", "inn": "7701234567", "gln": "4600682000010", "gs1Prefixes": ["4600682"], "timeZone": "Europe/Moscow" }
    }));
    expected.push(json!({
        "entity": "site", "id": "1", "rev": 1, "deleted": false,
        "data": { "badgeSalt": STANDARD.encode(&salt), "boxBlockSize": 2000, "palletBlockSize": 200 }
    }));
    assert_eq!(
        body,
        json!({ "hostId": app.state.host_id, "rev": 1, "hasMore": false, "items": expected })
    );
    assert_eq!(STANDARD.encode(&salt).len(), 24, "16 bytes, padded");

    let (_, again) = changes(&app, &key, "?since=1").await;
    assert_eq!(again["items"], json!([]));
    assert_eq!(again["rev"], 1);
}

#[tokio::test]
async fn revisions_without_station_records_still_move_the_device_forward() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "station").await;
    bootstrap(&app, &key).await;
    seed_office_user(&app, "tech", "technologist", "technologist password").await;

    let (status, body) = changes(&app, &key, "?since=1").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body,
        json!({ "hostId": app.state.host_id, "rev": 2, "hasMore": false, "items": [] })
    );
}

#[tokio::test]
async fn a_page_never_splits_a_revision() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "station").await;
    bootstrap(&app, &key).await;

    // Revision 1 has four records (two lines, the organization, the site),
    // more than a page of two: it comes whole.
    let (_, body) = changes(&app, &key, "?since=0&limit=2").await;
    assert_eq!(keys(&body).len(), 4);
    assert_eq!(
        (body["rev"].clone(), body["hasMore"].clone()),
        (json!(1), json!(true))
    );
    let (_, body) = changes(&app, &key, "?since=1&limit=2").await;
    assert_eq!(
        (
            body["items"].clone(),
            body["rev"].clone(),
            body["hasMore"].clone()
        ),
        (json!([]), json!(1), json!(false))
    );

    let (a, rev_a) = add_lines(&app, &["Линия A"]).await;
    let (bc, rev_bc) = add_lines(&app, &["Линия B", "Линия C"]).await;
    let mut bc_sorted = bc.clone();
    bc_sorted.sort();

    // A page boundary inside revision `rev_bc` stops before it.
    let (_, body) = changes(&app, &key, "?since=1&limit=2").await;
    assert_eq!(keys(&body), vec![("lines".to_owned(), a[0].clone(), rev_a)]);
    assert_eq!(
        (body["rev"].clone(), body["hasMore"].clone()),
        (json!(rev_a), json!(true))
    );
    // A boundary between revisions keeps the page full.
    let (_, body) = changes(&app, &key, "?since=1&limit=1").await;
    assert_eq!(keys(&body), vec![("lines".to_owned(), a[0].clone(), rev_a)]);
    assert_eq!(
        (body["rev"].clone(), body["hasMore"].clone()),
        (json!(rev_a), json!(true))
    );
    // The rest fits: no more pages, and `rev` is the host's current revision.
    let (_, body) = changes(&app, &key, &format!("?since={rev_a}&limit=2")).await;
    assert_eq!(
        keys(&body),
        bc_sorted
            .iter()
            .map(|id| ("lines".to_owned(), id.clone(), rev_bc))
            .collect::<Vec<_>>()
    );
    assert_eq!(
        (body["rev"].clone(), body["hasMore"].clone()),
        (json!(rev_bc), json!(false))
    );
}

#[tokio::test]
async fn archived_lines_stay_and_deleted_records_come_as_tombstones() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "station").await;
    bootstrap(&app, &key).await;
    let lines = line_ids_by_name(&app).await;

    let mut tx = markiro_host::db::begin_write(&app.state.pool)
        .await
        .unwrap();
    let rev = markiro_host::db::next_revision(&mut tx).await.unwrap();
    sqlx::query("UPDATE lines SET archived = 1, rev = ? WHERE id = ?")
        .bind(rev)
        .bind(&lines[0])
        .execute(&mut *tx)
        .await
        .unwrap();
    let gone = "0b7e7dcb-3f56-4c43-9a4b-1f0b3b3f8a21";
    sqlx::query("INSERT INTO tombstones (entity, id, rev) VALUES ('lines', ?, ?)")
        .bind(gone)
        .bind(rev)
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();

    let (_, body) = changes(&app, &key, "?since=1").await;
    let mut expected = vec![
        json!({ "entity": "lines", "id": lines[0], "rev": rev, "deleted": false, "data": { "name": "Линия 1", "archived": true } }),
        json!({ "entity": "lines", "id": gone, "rev": rev, "deleted": true }),
    ];
    expected.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
    assert_eq!(body["items"], Value::Array(expected));
}

#[tokio::test]
async fn the_feed_checks_its_query() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "station").await;
    for (query, field) in [
        ("?since=-1", "since"),
        ("?limit=0", "limit"),
        ("?limit=1001", "limit"),
    ] {
        let (status, body) = changes(&app, &key, query).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{query}");
        assert_eq!(body["error"]["code"], "validation_failed");
        assert_eq!(body["error"]["details"]["field"], field, "{query}");
    }
    let (status, body) = changes(&app, &key, "?since=abc").await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"]["code"], "validation_failed");
}

#[tokio::test]
async fn the_feed_needs_a_device_key_but_no_office_session() {
    let app = TestApp::new().await;
    let (status, body) = app.send(empty(request("GET", "/v1/changes"))).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"]["details"]["credential"], "device");
}
