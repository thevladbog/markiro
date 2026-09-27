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
        (json!(1), json!(false)),
        "revision 1 is whole and also the host's current revision: nothing more follows"
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

/// A regression to "rev of the last item" instead of the host's current
/// revision would still pass every other test in this file: they all happen
/// to end on a revision that also has a feed record.
#[tokio::test]
async fn the_last_page_carries_the_current_revision_past_its_items() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "station").await;
    bootstrap(&app, &key).await;
    let (a, rev_a) = add_lines(&app, &["Линия A"]).await;
    // Office users are not in the feed, but they still move the host's
    // revision forward past the last item the feed can return.
    seed_office_user(&app, "tech", "technologist", "technologist password").await;

    let (status, body) = changes(&app, &key, "?since=1").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(keys(&body), vec![("lines".to_owned(), a[0].clone(), rev_a)]);
    assert_eq!(
        (body["rev"].clone(), body["hasMore"].clone()),
        (json!(3), json!(false))
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

/// A key deleted and re-created in the same transaction (a tombstone and a
/// live row sharing entity, id and revision) must sort with the tombstone
/// first, so a station that applies items in order ends with the live row.
#[tokio::test]
async fn a_key_deleted_and_recreated_in_one_transaction_ends_live() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "station").await;
    bootstrap(&app, &key).await;
    let lines = line_ids_by_name(&app).await;
    let line_id = &lines[0];

    let mut tx = markiro_host::db::begin_write(&app.state.pool)
        .await
        .unwrap();
    let rev = markiro_host::db::next_revision(&mut tx).await.unwrap();
    // The line row survives unchanged apart from its revision: the net
    // effect of the transaction is that the key is still live.
    sqlx::query("UPDATE lines SET rev = ? WHERE id = ?")
        .bind(rev)
        .bind(line_id)
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("INSERT INTO tombstones (entity, id, rev) VALUES ('lines', ?, ?)")
        .bind(line_id)
        .bind(rev)
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();

    let (_, body) = changes(&app, &key, "?since=1").await;
    let items = body["items"].as_array().unwrap();
    assert_eq!(items.len(), 2, "{body}");
    assert_eq!(items[0]["id"], json!(line_id), "{body}");
    assert_eq!(
        items[0]["deleted"],
        json!(true),
        "the tombstone sorts first: {body}"
    );
    assert_eq!(items[1]["id"], json!(line_id), "{body}");
    assert_eq!(
        items[1]["deleted"],
        json!(false),
        "then the re-created live row: {body}"
    );
    assert_eq!(items[1]["data"]["name"], json!("Линия 1"), "{body}");
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

    // An unknown field is rejected by `deny_unknown_fields`, not silently
    // ignored.
    let (status, body) = changes(&app, &key, "?foo=1").await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(body["error"]["code"], "validation_failed");

    // The limit's boundary values are valid, not off-by-one rejections.
    for query in ["?limit=1", "?limit=1000"] {
        let (status, body) = changes(&app, &key, query).await;
        assert_eq!(status, StatusCode::OK, "{query}: {body}");
    }
}

#[tokio::test]
async fn the_feed_needs_a_device_key_but_no_office_session() {
    let app = TestApp::new().await;
    let (status, body) = app.send(empty(request("GET", "/v1/changes"))).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"]["details"]["credential"], "device");
}

/// `pinPhc` of `proto/fixtures/phc-password.json`: the PIN 4821.
const PIN_PHC: &str =
    "pbkdf2$sha256$100000$bWFya2lyby1waW4tc2FsdA==$3OKvrZ2+EfTB2zsCso90r5g8c6Ib6t+Bv+cGJOpgPmU=";
/// A badge verifier, stored as the office computed it.
const BADGE_PHC: &str =
    "pbkdf2$sha256$100000$AAECAwQFBgcICQoLDA0ODw==$LEcu0ewwRD5rBHrpCjvxni/q2cURiavbRlNRgDPb+n0=";

/// Insert an active operator at a new revision; returns its id and the revision.
async fn add_operator(app: &TestApp, login: &str) -> (String, i64) {
    let mut tx = markiro_host::db::begin_write(&app.state.pool)
        .await
        .unwrap();
    let rev = markiro_host::db::next_revision(&mut tx).await.unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO operators (id, login, name, role, pin_phc, active, rev) \
         VALUES (?, ?, ?, NULL, ?, 1, ?)",
    )
    .bind(&id)
    .bind(login)
    .bind(format!("Оператор {login}"))
    .bind(PIN_PHC)
    .bind(rev)
    .execute(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();
    (id, rev)
}

/// Insert a badge of `operator_id` at a new revision; returns its id and the
/// revision, or the database's refusal.
async fn insert_badge(
    app: &TestApp,
    operator_id: &str,
    badge_phc: &str,
) -> Result<(String, i64), sqlx::Error> {
    let mut tx = markiro_host::db::begin_write(&app.state.pool).await?;
    let rev = markiro_host::db::next_revision(&mut tx).await?;
    let id = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO operator_badges (id, operator_id, badge_phc, label, created_at, rev) \
         VALUES (?, ?, ?, 'Пропуск 1', ?, ?)",
    )
    .bind(&id)
    .bind(operator_id)
    .bind(badge_phc)
    .bind(app.state.timestamp())
    .bind(rev)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok((id, rev))
}

/// Deactivate or reactivate an operator at a new revision the way the office
/// writers do: a deactivation writes the tombstone, a reactivation drops it.
/// Returns the revision.
async fn set_active(app: &TestApp, id: &str, active: bool) -> i64 {
    let mut tx = markiro_host::db::begin_write(&app.state.pool)
        .await
        .unwrap();
    let rev = markiro_host::db::next_revision(&mut tx).await.unwrap();
    sqlx::query("UPDATE operators SET active = ?, rev = ? WHERE id = ?")
        .bind(active)
        .bind(rev)
        .bind(id)
        .execute(&mut *tx)
        .await
        .unwrap();
    if active {
        markiro_host::feed::restore(&mut tx, "operators", id)
            .await
            .unwrap();
    } else {
        markiro_host::feed::remove(&mut tx, "operators", id, rev)
            .await
            .unwrap();
    }
    tx.commit().await.unwrap();
    rev
}

/// Revoke a badge at a new revision with its tombstone; returns the revision.
async fn revoke_badge(app: &TestApp, id: &str) -> i64 {
    let mut tx = markiro_host::db::begin_write(&app.state.pool)
        .await
        .unwrap();
    let rev = markiro_host::db::next_revision(&mut tx).await.unwrap();
    sqlx::query("UPDATE operator_badges SET revoked_at = ?, rev = ? WHERE id = ?")
        .bind(app.state.timestamp())
        .bind(rev)
        .bind(id)
        .execute(&mut *tx)
        .await
        .unwrap();
    markiro_host::feed::remove(&mut tx, "operator_badges", id, rev)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    rev
}

fn operator_item(id: &str, rev: i64) -> Value {
    json!({
        "entity": "operators", "id": id, "rev": rev, "deleted": false,
        "data": { "login": "0042", "name": "Оператор 0042", "role": null, "pinPhc": PIN_PHC }
    })
}

fn badge_item(id: &str, operator_id: &str, rev: i64) -> Value {
    json!({
        "entity": "operator_badges", "id": id, "rev": rev, "deleted": false,
        "data": { "operatorId": operator_id, "badgePhc": BADGE_PHC, "label": "Пропуск 1" }
    })
}

fn tombstone(entity: &str, id: &str, rev: i64) -> Value {
    json!({ "entity": entity, "id": id, "rev": rev, "deleted": true })
}

#[tokio::test]
async fn active_operators_and_their_badges_ride_the_feed() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "station").await;
    bootstrap(&app, &key).await;
    let (operator, operator_rev) = add_operator(&app, "0042").await;
    let (badge, badge_rev) = insert_badge(&app, &operator, BADGE_PHC).await.unwrap();

    let (status, body) = changes(&app, &key, "?since=1").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body["items"],
        json!([
            operator_item(&operator, operator_rev),
            badge_item(&badge, &operator, badge_rev)
        ])
    );
}

#[tokio::test]
async fn a_deactivated_operator_leaves_the_feed_as_a_tombstone() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "station").await;
    bootstrap(&app, &key).await;
    let (operator, _) = add_operator(&app, "0042").await;
    let (badge, badge_rev) = insert_badge(&app, &operator, BADGE_PHC).await.unwrap();
    let off = set_active(&app, &operator, false).await;

    // A station that has the operator learns that it is gone...
    let (_, body) = changes(&app, &key, &format!("?since={badge_rev}")).await;
    assert_eq!(
        body["items"],
        json!([tombstone("operators", &operator, off)])
    );
    // ...and one syncing from zero never gets the record: only the badge,
    // which grants nothing without it, and the tombstone.
    let (_, body) = changes(&app, &key, "?since=1").await;
    assert_eq!(
        body["items"],
        json!([
            badge_item(&badge, &operator, badge_rev),
            tombstone("operators", &operator, off)
        ])
    );
}

#[tokio::test]
async fn a_reactivated_operator_comes_back_without_its_tombstone() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "station").await;
    bootstrap(&app, &key).await;
    let (operator, _) = add_operator(&app, "0042").await;
    let off = set_active(&app, &operator, false).await;
    let on = set_active(&app, &operator, true).await;

    let tombstones: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM tombstones")
        .fetch_one(&app.state.pool)
        .await
        .unwrap();
    assert_eq!(tombstones, 0, "re-creating a key drops its tombstone");
    // A station that applied the tombstone gets the record back...
    let (_, body) = changes(&app, &key, &format!("?since={off}")).await;
    assert_eq!(body["items"], json!([operator_item(&operator, on)]));
    // ...and one syncing from zero sees only the record, never both.
    let (_, body) = changes(&app, &key, "?since=1").await;
    assert_eq!(body["items"], json!([operator_item(&operator, on)]));
}

#[tokio::test]
async fn a_revoked_badge_leaves_the_feed_as_a_tombstone() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "station").await;
    bootstrap(&app, &key).await;
    let (operator, operator_rev) = add_operator(&app, "0042").await;
    let (badge, badge_rev) = insert_badge(&app, &operator, BADGE_PHC).await.unwrap();
    let revoked = revoke_badge(&app, &badge).await;

    let (_, body) = changes(&app, &key, &format!("?since={badge_rev}")).await;
    assert_eq!(
        body["items"],
        json!([tombstone("operator_badges", &badge, revoked)])
    );
    let (_, body) = changes(&app, &key, "?since=1").await;
    assert_eq!(
        body["items"],
        json!([
            operator_item(&operator, operator_rev),
            tombstone("operator_badges", &badge, revoked)
        ])
    );
}

#[tokio::test]
async fn one_badge_is_active_for_one_operator_at_a_time() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "station").await;
    bootstrap(&app, &key).await;
    let (first, _) = add_operator(&app, "0042").await;
    let (second, _) = add_operator(&app, "0043").await;
    let (badge, _) = insert_badge(&app, &first, BADGE_PHC).await.unwrap();

    let error = insert_badge(&app, &second, BADGE_PHC).await.unwrap_err();
    assert!(
        error
            .as_database_error()
            .is_some_and(|error| error.is_unique_violation()),
        "{error}"
    );
    // A revoked badge frees its code for another operator.
    revoke_badge(&app, &badge).await;
    insert_badge(&app, &second, BADGE_PHC).await.unwrap();
}
