mod support;

use axum::http::StatusCode;
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde_json::{json, Value};
use support::app::{
    bootstrap, empty, pair_device, request, seed_office_user, tombstones, with_device, TestApp,
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
    // A wizard without stock templates leaves the three defaults unset.
    expected.push(json!({
        "entity": "org_profile", "id": "1", "rev": 1, "deleted": false,
        "data": {
            "name": "ООО «Атолл»", "inn": "7707083893", "gln": "4600682000010", "gs1Prefixes": ["4600682"], "timeZone": "Europe/Moscow",
            "defaultBoxTemplateId": null, "defaultPalletTemplateId": null, "defaultDuplicateTemplateId": null
        }
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

/// Take a new revision and write the tombstone of `entity`/`id` at it, as a
/// writer does when a record leaves the feed; returns the revision.
async fn remove_at_new_revision(app: &TestApp, entity: &str, id: &str) -> i64 {
    let mut tx = markiro_host::db::begin_write(&app.state.pool)
        .await
        .unwrap();
    let rev = markiro_host::db::next_revision(&mut tx).await.unwrap();
    markiro_host::feed::remove(&mut tx, entity, id, rev)
        .await
        .unwrap();
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
    // Another operator stays deactivated: its tombstone must survive the
    // first one's reactivation, so a `restore` that drops more than its own
    // key is caught.
    let (other, _) = add_operator(&app, "0043").await;
    let other_off = set_active(&app, &other, false).await;
    let off = set_active(&app, &operator, false).await;
    let mut both = vec![
        ("operators".to_owned(), operator.clone(), off),
        ("operators".to_owned(), other.clone(), other_off),
    ];
    both.sort();
    assert_eq!(tombstones(&app).await, both, "two operators are removed");
    let on = set_active(&app, &operator, true).await;

    assert_eq!(
        tombstones(&app).await,
        vec![("operators".to_owned(), other.clone(), other_off)],
        "re-creating a key drops its own tombstone and no other"
    );
    // A station that applied the tombstone gets the record back...
    let (_, body) = changes(&app, &key, &format!("?since={off}")).await;
    assert_eq!(body["items"], json!([operator_item(&operator, on)]));
    // ...and one syncing from zero sees only the record, never both, plus the
    // other operator's tombstone.
    let (_, body) = changes(&app, &key, "?since=1").await;
    assert_eq!(
        body["items"],
        json!([
            tombstone("operators", &other, other_off),
            operator_item(&operator, on)
        ])
    );
}

/// A key removed again, with no `restore` in between, keeps its one
/// tombstone and moves it up to the new revision: a station that applied the
/// first tombstone must still hear about the second removal, since the feed
/// sends only what is newer than its revision. Callers always pass their
/// transaction's newest revision, so `remove` needs no `MAX` guard against an
/// older one.
#[tokio::test]
async fn removing_a_key_again_moves_its_tombstone_up_to_the_new_revision() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "station").await;
    bootstrap(&app, &key).await;
    let gone = "0b7e7dcb-3f56-4c43-9a4b-1f0b3b3f8a21";

    let first = remove_at_new_revision(&app, "lines", gone).await;
    assert_eq!(
        tombstones(&app).await,
        vec![("lines".to_owned(), gone.to_owned(), first)]
    );
    let second = remove_at_new_revision(&app, "lines", gone).await;
    assert!(second > first, "the second removal takes a new revision");

    assert_eq!(
        tombstones(&app).await,
        vec![("lines".to_owned(), gone.to_owned(), second)],
        "one tombstone, moved up to the newer revision"
    );
    // A station that applied the first tombstone is told again.
    let (_, body) = changes(&app, &key, &format!("?since={first}")).await;
    assert_eq!(body["items"], json!([tombstone("lines", gone, second)]));
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

/// A small layout, stored as the host stores a spec: compact JSON.
const SPEC: &str = r#"{"dpi":203,"elements":[],"heightMm":40,"language":"zpl","widthMm":58}"#;

/// Items in the feed's order inside one revision: by entity, then by id.
fn in_feed_order(mut items: Vec<Value>) -> Value {
    items.sort_by(|a, b| {
        (a["entity"].as_str(), a["id"].as_str()).cmp(&(b["entity"].as_str(), b["id"].as_str()))
    });
    Value::Array(items)
}

#[tokio::test]
async fn catalog_records_ride_the_feed_with_their_flags() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "station").await;
    bootstrap(&app, &key).await;
    let universal = uuid::Uuid::new_v4().to_string();
    let milk = uuid::Uuid::new_v4().to_string();
    let active = uuid::Uuid::new_v4().to_string();
    let archived = uuid::Uuid::new_v4().to_string();
    let mut tx = markiro_host::db::begin_write(&app.state.pool)
        .await
        .unwrap();
    let rev = markiro_host::db::next_revision(&mut tx).await.unwrap();
    for (id, name, enabled, codes, stock) in [
        (&universal, "Коробка 58×40", true, None, true),
        (&milk, "Молоко 58×40", false, Some("[8]"), false),
    ] {
        sqlx::query(
            "INSERT INTO label_templates (id, name, purpose, enabled, category_codes, spec, stock, rev) \
             VALUES (?, ?, 'box', ?, ?, ?, ?, ?)",
        )
        .bind(id)
        .bind(name)
        .bind(enabled)
        .bind(codes)
        .bind(SPEC)
        .bind(stock)
        .bind(rev)
        .execute(&mut *tx)
        .await
        .unwrap();
    }
    sqlx::query("UPDATE org_profile SET default_box_template_id = ?, rev = ? WHERE id = 1")
        .bind(&universal)
        .bind(rev)
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO category_template_defaults (chz_group_code, purpose, template_id, rev) \
         VALUES (8, 'box', ?, ?)",
    )
    .bind(&universal)
    .bind(rev)
    .execute(&mut *tx)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO products (id, gtin14, name, print_name, chz_group_code, box_capacity, \
         pallet_box_capacity, shelf_life_days, default_box_template_id, archived, rev) \
         VALUES (?, '04600682000013', 'Молоко 3,2% 0,9 л', 'Молоко 3,2%', 8, 12, 40, 10, ?, 0, ?)",
    )
    .bind(&active)
    .bind(&milk)
    .bind(rev)
    .execute(&mut *tx)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO products (id, gtin14, name, archived, rev) \
         VALUES (?, '04600682000020', 'Кефир 1% 0,9 л', 1, ?)",
    )
    .bind(&archived)
    .bind(rev)
    .execute(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();

    let spec: Value = serde_json::from_str(SPEC).unwrap();
    let (status, body) = changes(&app, &key, "?since=1").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body["items"],
        in_feed_order(vec![
            json!({
                "entity": "label_templates", "id": universal, "rev": rev, "deleted": false,
                "data": { "name": "Коробка 58×40", "purpose": "box", "enabled": true, "chzProductGroupCodes": null, "stock": true, "spec": spec }
            }),
            // A disabled template stays, with its flag.
            json!({
                "entity": "label_templates", "id": milk, "rev": rev, "deleted": false,
                "data": { "name": "Молоко 58×40", "purpose": "box", "enabled": false, "chzProductGroupCodes": [8], "stock": false, "spec": spec }
            }),
            json!({
                "entity": "org_profile", "id": "1", "rev": rev, "deleted": false,
                "data": {
                    "name": "ООО «Атолл»", "inn": "7707083893", "gln": "4600682000010", "gs1Prefixes": ["4600682"], "timeZone": "Europe/Moscow",
                    "defaultBoxTemplateId": universal, "defaultPalletTemplateId": null, "defaultDuplicateTemplateId": null
                }
            }),
            json!({
                "entity": "category_template_defaults", "id": "8:box", "rev": rev, "deleted": false,
                "data": { "chzProductGroupCode": 8, "purpose": "box", "templateId": universal }
            }),
            json!({
                "entity": "products", "id": active, "rev": rev, "deleted": false,
                "data": {
                    "gtin14": "04600682000013", "name": "Молоко 3,2% 0,9 л", "printName": "Молоко 3,2%",
                    "chzProductGroupCode": 8, "boxCapacity": 12, "palletBoxCapacity": 40, "shelfLifeDays": 10,
                    "defaultBoxTemplateId": milk, "defaultPalletTemplateId": null, "archived": false, "status": "active",
                    "photoChecksum": null
                }
            }),
            // An archived product stays, with its flag; without a group and
            // capacities it is a draft.
            json!({
                "entity": "products", "id": archived, "rev": rev, "deleted": false,
                "data": {
                    "gtin14": "04600682000020", "name": "Кефир 1% 0,9 л", "printName": null,
                    "chzProductGroupCode": null, "boxCapacity": null, "palletBoxCapacity": null, "shelfLifeDays": null,
                    "defaultBoxTemplateId": null, "defaultPalletTemplateId": null, "archived": true, "status": "draft",
                    "photoChecksum": null
                }
            }),
        ])
    );
}

/// A spec of exactly `bytes` bytes of compact JSON.
fn spec_of(bytes: usize) -> String {
    format!(r#"{{"filler":"{}"}}"#, "x".repeat(bytes - 13))
}

/// Insert templates with the given specs in one transaction at a new
/// revision; returns their ids, sorted as the feed sorts them, and the
/// revision.
async fn add_templates(app: &TestApp, specs: &[String]) -> (Vec<String>, i64) {
    let mut tx = markiro_host::db::begin_write(&app.state.pool)
        .await
        .unwrap();
    let rev = markiro_host::db::next_revision(&mut tx).await.unwrap();
    let mut ids = Vec::new();
    for (index, spec) in specs.iter().enumerate() {
        let id = uuid::Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO label_templates (id, name, purpose, enabled, spec, rev) \
             VALUES (?, ?, 'box', 1, ?, ?)",
        )
        .bind(&id)
        .bind(format!("Шаблон {index}"))
        .bind(spec)
        .bind(rev)
        .execute(&mut *tx)
        .await
        .unwrap();
        ids.push(id);
    }
    tx.commit().await.unwrap();
    ids.sort();
    (ids, rev)
}

/// Five templates of 250 000 bytes each, one revision apiece: four fit in
/// a page of `MAX_PAGE_BYTES`, the fifth would pass it and waits for the
/// next page, although the count limit would take all five.
#[tokio::test]
async fn a_page_ends_before_the_revision_that_would_pass_the_byte_budget() {
    assert_eq!(markiro_host::routes::changes::MAX_PAGE_BYTES, 1024 * 1024);
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "station").await;
    bootstrap(&app, &key).await;
    let mut added = Vec::new();
    for _ in 0..5 {
        let (ids, rev) = add_templates(&app, &[spec_of(250_000)]).await;
        added.push(("label_templates".to_owned(), ids[0].clone(), rev));
    }

    let (status, body) = changes(&app, &key, "?since=1").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(keys(&body), added[..4].to_vec());
    assert_eq!(
        (body["rev"].clone(), body["hasMore"].clone()),
        (json!(added[3].2), json!(true))
    );
    let (_, body) = changes(&app, &key, &format!("?since={}", added[3].2)).await;
    assert_eq!(keys(&body), added[4..].to_vec());
    assert_eq!(
        (body["rev"].clone(), body["hasMore"].clone()),
        (json!(added[4].2), json!(false))
    );
}

/// A page can be cut twice, by the count and then by the byte budget: six
/// templates of 250 000 bytes, one revision apiece (revisions 2-7), read with
/// `limit=5`. The count cut would end the page after revision 6; the budget
/// holds four of them, so the page ends after revision 5, and its `rev` has to
/// say so. A page that took the count cut's revision would tell the station it
/// holds revision 6, which it never got, and the station would not ask again.
#[tokio::test]
async fn a_byte_cut_inside_a_count_cut_ends_the_page_at_the_last_revision_it_holds() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "station").await;
    bootstrap(&app, &key).await;
    let mut added = Vec::new();
    for _ in 0..6 {
        let (ids, rev) = add_templates(&app, &[spec_of(250_000)]).await;
        added.push(("label_templates".to_owned(), ids[0].clone(), rev));
    }
    assert_eq!(
        added.iter().map(|key| key.2).collect::<Vec<_>>(),
        [2, 3, 4, 5, 6, 7]
    );

    let (status, body) = changes(&app, &key, "?since=1&limit=5").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(keys(&body), added[..4].to_vec());
    assert_eq!(
        (body["rev"].clone(), body["hasMore"].clone()),
        (json!(5), json!(true))
    );
    let (_, body) = changes(&app, &key, "?since=5&limit=5").await;
    assert_eq!(keys(&body), added[4..].to_vec());
    assert_eq!(
        (body["rev"].clone(), body["hasMore"].clone()),
        (json!(7), json!(false))
    );
}

/// A revision larger than the budget is never split: it waits behind a
/// smaller one, then comes whole as a page of its own.
#[tokio::test]
async fn a_revision_larger_than_the_byte_budget_still_comes_whole() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "station").await;
    bootstrap(&app, &key).await;
    let (line, line_rev) = add_lines(&app, &["Линия A"]).await;
    let (templates, big) = add_templates(&app, &vec![spec_of(250_000); 5]).await;

    let (_, body) = changes(&app, &key, "?since=1").await;
    assert_eq!(
        keys(&body),
        vec![("lines".to_owned(), line[0].clone(), line_rev)]
    );
    assert_eq!(
        (body["rev"].clone(), body["hasMore"].clone()),
        (json!(line_rev), json!(true))
    );
    let (_, body) = changes(&app, &key, &format!("?since={line_rev}")).await;
    assert_eq!(
        keys(&body),
        templates
            .iter()
            .map(|id| ("label_templates".to_owned(), id.clone(), big))
            .collect::<Vec<_>>()
    );
    assert_eq!(
        (body["rev"].clone(), body["hasMore"].clone()),
        (json!(big), json!(false))
    );
}

/// A page whose items come to exactly `MAX_PAGE_BYTES` is full, not over: the
/// budget is passed only by a revision that takes the total a byte beyond it.
/// The second revision is sized to land on the budget, or one byte past it.
#[tokio::test]
async fn a_page_may_end_exactly_on_the_byte_budget() {
    let budget = markiro_host::routes::changes::MAX_PAGE_BYTES;
    // What an item adds to a page, counted as the host counts it.
    let size = |item: &Value| serde_json::to_vec(item).unwrap().len();
    let total =
        |body: &Value| -> usize { body["items"].as_array().unwrap().iter().map(size).sum() };
    let of = |ids: &[String], rev: i64| -> Vec<(String, String, i64)> {
        ids.iter()
            .map(|id| ("label_templates".to_owned(), id.clone(), rev))
            .collect()
    };
    for over in [0, 1] {
        let app = TestApp::new().await;
        let (_, key) = pair_device(&app, "station").await;
        bootstrap(&app, &key).await;
        let (first, first_rev) = add_templates(&app, &vec![spec_of(250_000); 4]).await;
        let (_, body) = changes(&app, &key, "?since=1").await;
        assert_eq!(keys(&body), of(&first, first_rev));
        // An item is its spec and a frame that is the same for every template
        // `add_templates` writes at a one-digit revision.
        let frame = size(&body["items"][0]) - 250_000;
        let (second, second_rev) =
            add_templates(&app, &[spec_of(budget - total(&body) - frame + over)]).await;

        let (_, body) = changes(&app, &key, "?since=1").await;
        if over == 0 {
            // Exactly the budget: the two revisions are one page.
            assert_eq!(total(&body), budget);
            assert_eq!(
                keys(&body),
                [of(&first, first_rev), of(&second, second_rev)].concat()
            );
            assert_eq!(
                (body["rev"].clone(), body["hasMore"].clone()),
                (json!(second_rev), json!(false))
            );
        } else {
            // One byte over: the second revision waits for the next page.
            assert_eq!(keys(&body), of(&first, first_rev));
            assert_eq!(
                (body["rev"].clone(), body["hasMore"].clone()),
                (json!(first_rev), json!(true))
            );
            let (_, rest) = changes(&app, &key, &format!("?since={first_rev}")).await;
            assert_eq!(keys(&rest), of(&second, second_rev));
            assert_eq!(total(&body) + total(&rest), budget + 1);
        }
    }
}

/// Every purpose keeps its own place in the feed: a template's own purpose,
/// each of the organization's three defaults, a category default's key and
/// record, and a product's two template defaults. The test above puts only
/// box defaults on the feed, where a swapped pallet or duplicate would not show.
#[tokio::test]
async fn each_purpose_rides_the_feed_in_its_own_place() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "station").await;
    bootstrap(&app, &key).await;
    let purposes = ["box", "pallet", "product_duplicate"];
    let ids: Vec<String> = purposes
        .iter()
        .map(|_| uuid::Uuid::new_v4().to_string())
        .collect();
    let product = uuid::Uuid::new_v4().to_string();
    let mut tx = markiro_host::db::begin_write(&app.state.pool)
        .await
        .unwrap();
    let rev = markiro_host::db::next_revision(&mut tx).await.unwrap();
    for (id, purpose) in ids.iter().zip(purposes) {
        sqlx::query(
            "INSERT INTO label_templates (id, name, purpose, enabled, spec, rev) \
             VALUES (?, ?, ?, 1, ?, ?)",
        )
        .bind(id)
        .bind(format!("Шаблон {purpose}"))
        .bind(purpose)
        .bind(SPEC)
        .bind(rev)
        .execute(&mut *tx)
        .await
        .unwrap();
    }
    sqlx::query(
        "UPDATE org_profile SET default_box_template_id = ?, default_pallet_template_id = ?, \
         default_duplicate_template_id = ?, rev = ? WHERE id = 1",
    )
    .bind(&ids[0])
    .bind(&ids[1])
    .bind(&ids[2])
    .bind(rev)
    .execute(&mut *tx)
    .await
    .unwrap();
    for (code, purpose, template) in [(8, "pallet", &ids[1]), (15, "product_duplicate", &ids[2])] {
        sqlx::query(
            "INSERT INTO category_template_defaults (chz_group_code, purpose, template_id, rev) \
             VALUES (?, ?, ?, ?)",
        )
        .bind(code)
        .bind(purpose)
        .bind(template)
        .bind(rev)
        .execute(&mut *tx)
        .await
        .unwrap();
    }
    sqlx::query(
        "INSERT INTO products (id, gtin14, name, default_box_template_id, \
         default_pallet_template_id, archived, rev) \
         VALUES (?, '04600682000013', 'Молоко 3,2% 0,9 л', ?, ?, 0, ?)",
    )
    .bind(&product)
    .bind(&ids[0])
    .bind(&ids[1])
    .bind(rev)
    .execute(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();

    let (status, body) = changes(&app, &key, "?since=1").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let data = |entity: &str, id: &str| -> Value {
        body["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["entity"] == entity && item["id"] == id)
            .unwrap_or_else(|| panic!("no {entity} {id} in {body}"))["data"]
            .clone()
    };
    for (id, purpose) in ids.iter().zip(purposes) {
        assert_eq!(data("label_templates", id)["purpose"], purpose);
    }
    // These templates are enabled and not stock: the two flags are not the
    // same column read twice, nor each other's.
    for id in &ids {
        let template = data("label_templates", id);
        assert_eq!(
            (template["enabled"].clone(), template["stock"].clone()),
            (json!(true), json!(false))
        );
    }
    let org = data("org_profile", "1");
    assert_eq!(org["defaultBoxTemplateId"], json!(ids[0]));
    assert_eq!(org["defaultPalletTemplateId"], json!(ids[1]));
    assert_eq!(org["defaultDuplicateTemplateId"], json!(ids[2]));
    assert_eq!(
        data("category_template_defaults", "8:pallet"),
        json!({ "chzProductGroupCode": 8, "purpose": "pallet", "templateId": ids[1] })
    );
    assert_eq!(
        data("category_template_defaults", "15:product_duplicate"),
        json!({ "chzProductGroupCode": 15, "purpose": "product_duplicate", "templateId": ids[2] })
    );
    let product = data("products", &product);
    assert_eq!(product["defaultBoxTemplateId"], json!(ids[0]));
    assert_eq!(product["defaultPalletTemplateId"], json!(ids[1]));
}
