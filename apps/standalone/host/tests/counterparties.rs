mod support;

use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{admin, audit_rows, audit_trail, empty, host_revision, request, with_device};

const BEREG: &str = "ООО «Северный берег»";

fn new_counterparty() -> Value {
    json!({
        "name": " ООО «Северный берег» ",
        "inn": " ",
        "gln": "4601234000017",
        "gs1Prefixes": ["4601234", " 4601234 ", "4609876"]
    })
}

fn full(inn: Value, archived: bool, expected_rev: i64) -> Value {
    json!({
        "name": BEREG,
        "inn": inn,
        "gln": "4601234000017",
        "gs1Prefixes": ["4601234", "4609876"],
        "archived": archived,
        "expectedRev": expected_rev
    })
}

#[tokio::test]
async fn an_administrator_creates_lists_and_updates_counterparties() {
    let admin = admin().await;
    let (status, created) = admin
        .call(
            "POST",
            "/v1/office/counterparties",
            Some(new_counterparty()),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let id = created["id"].as_str().unwrap().to_owned();
    // The wizard took revision 1.
    assert_eq!(host_revision(&admin.app).await, 2);
    assert_eq!(
        created,
        json!({
            "id": id, "name": BEREG, "inn": null, "gln": "4601234000017",
            "gs1Prefixes": ["4601234", "4609876"], "archived": false, "rev": 2
        })
    );
    assert_eq!(
        audit_trail(&admin.app, "counterparty.create").await,
        vec![admin.row(
            "counterparty.create",
            "counterparty",
            &id,
            json!({ "name": BEREG, "gln": "4601234000017" })
        )]
    );
    let (status, list) = admin.call("GET", "/v1/office/counterparties", None).await;
    assert_eq!((status, list), (StatusCode::OK, json!([created])));

    let path = format!("/v1/office/counterparties/{id}");
    let (status, archived) = admin
        .call("PUT", &path, Some(full(json!("7812345678"), true, 2)))
        .await;
    assert_eq!(status, StatusCode::OK, "{archived}");
    assert_eq!(
        (
            archived["inn"].clone(),
            archived["archived"].clone(),
            archived["rev"].clone()
        ),
        (json!("7812345678"), json!(true), json!(3))
    );
    assert_eq!(
        audit_trail(&admin.app, "counterparty.update").await,
        vec![admin.row(
            "counterparty.update",
            "counterparty",
            &id,
            json!({
                "changed": ["inn", "archived"],
                "inn": { "from": null, "to": "7812345678" },
                "archived": { "from": false, "to": true }
            })
        )]
    );

    // The same values again change nothing.
    let (status, unchanged) = admin
        .call("PUT", &path, Some(full(json!("7812345678"), true, 3)))
        .await;
    assert_eq!((status, unchanged), (StatusCode::OK, archived));
    assert_eq!(host_revision(&admin.app).await, 3);
    assert_eq!(
        audit_trail(&admin.app, "counterparty.update").await.len(),
        1
    );

    // An update over an old revision is refused, and changes nothing: no
    // revision and no audit row, of any action.
    let rows = audit_rows(&admin.app).await;
    let (status, body) = admin
        .call("PUT", &path, Some(full(Value::Null, false, 2)))
        .await;
    assert_eq!(
        (
            status,
            body["error"]["code"].clone(),
            body["error"]["details"]["currentRev"].clone()
        ),
        (StatusCode::CONFLICT, json!("stale_revision"), json!(3))
    );
    assert_eq!(host_revision(&admin.app).await, 3);
    assert_eq!(audit_rows(&admin.app).await, rows);
}

/// `inn` is part of the whole record a `PUT` carries, so leaving it out clears
/// it exactly as `null` does.
#[tokio::test]
async fn an_update_without_an_inn_clears_it_just_like_a_null() {
    let admin = admin().await;
    let mut body = new_counterparty();
    body["inn"] = json!("7812345678");
    let (status, created) = admin
        .call("POST", "/v1/office/counterparties", Some(body))
        .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    assert_eq!(created["inn"], json!("7812345678"));
    let id = created["id"].as_str().unwrap().to_owned();
    let path = format!("/v1/office/counterparties/{id}");

    // `inn: null` clears it...
    let (status, cleared) = admin
        .call("PUT", &path, Some(full(Value::Null, false, 2)))
        .await;
    assert_eq!(status, StatusCode::OK, "{cleared}");
    assert_eq!(
        (cleared["inn"].clone(), cleared["rev"].clone()),
        (Value::Null, json!(3))
    );
    // ...it can be set again...
    let (status, set) = admin
        .call("PUT", &path, Some(full(json!("7812345678"), false, 3)))
        .await;
    assert_eq!(status, StatusCode::OK, "{set}");
    assert_eq!(
        (set["inn"].clone(), set["rev"].clone()),
        (json!("7812345678"), json!(4))
    );
    // ...and leaving `inn` out clears it again.
    let mut without = full(Value::Null, false, 4);
    without.as_object_mut().unwrap().remove("inn");
    let (status, cleared_again) = admin.call("PUT", &path, Some(without)).await;
    assert_eq!(status, StatusCode::OK, "{cleared_again}");
    assert_eq!(
        (cleared_again["inn"].clone(), cleared_again["rev"].clone()),
        (Value::Null, json!(5))
    );

    let inn = |from: Value, to: Value| {
        admin.row(
            "counterparty.update",
            "counterparty",
            &id,
            json!({ "changed": ["inn"], "inn": { "from": from, "to": to } }),
        )
    };
    assert_eq!(
        audit_trail(&admin.app, "counterparty.update").await,
        vec![
            inn(json!("7812345678"), Value::Null),
            inn(Value::Null, json!("7812345678")),
            inn(json!("7812345678"), Value::Null),
        ]
    );
}

#[tokio::test]
async fn an_archived_counterparty_can_be_brought_back() {
    let admin = admin().await;
    let (_, created) = admin
        .call(
            "POST",
            "/v1/office/counterparties",
            Some(new_counterparty()),
        )
        .await;
    let id = created["id"].as_str().unwrap().to_owned();
    let path = format!("/v1/office/counterparties/{id}");
    let (status, archived) = admin
        .call("PUT", &path, Some(full(Value::Null, true, 2)))
        .await;
    assert_eq!(status, StatusCode::OK, "{archived}");
    assert_eq!(archived["archived"], json!(true));

    let (status, restored) = admin
        .call("PUT", &path, Some(full(Value::Null, false, 3)))
        .await;
    assert_eq!(status, StatusCode::OK, "{restored}");
    assert_eq!(
        (restored["archived"].clone(), restored["rev"].clone()),
        (json!(false), json!(4))
    );
    let (_, list) = admin.call("GET", "/v1/office/counterparties", None).await;
    assert_eq!(list, json!([restored]));
    let archive = |from: bool, to: bool| {
        admin.row(
            "counterparty.update",
            "counterparty",
            &id,
            json!({ "changed": ["archived"], "archived": { "from": from, "to": to } }),
        )
    };
    assert_eq!(
        audit_trail(&admin.app, "counterparty.update").await,
        vec![archive(false, true), archive(true, false)]
    );
}

/// The audit row of an update names each changed field, in the record's
/// order, with the stored old value and the stored (trimmed, de-duplicated)
/// new one.
#[tokio::test]
async fn an_update_records_a_changed_name_gln_and_prefixes_with_both_values() {
    let admin = admin().await;
    let (_, created) = admin
        .call(
            "POST",
            "/v1/office/counterparties",
            Some(new_counterparty()),
        )
        .await;
    let id = created["id"].as_str().unwrap().to_owned();
    let (status, updated) = admin
        .call(
            "PUT",
            &format!("/v1/office/counterparties/{id}"),
            Some(json!({
                "name": " ООО «Южный берег» ",
                "inn": null,
                "gln": "4601234000024",
                "gs1Prefixes": ["4601234", "4605555", " 4609876 ", "4605555"],
                "archived": false,
                "expectedRev": 2
            })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{updated}");
    assert_eq!(
        audit_trail(&admin.app, "counterparty.update").await,
        vec![admin.row(
            "counterparty.update",
            "counterparty",
            &id,
            json!({
                "changed": ["name", "gln", "gs1Prefixes"],
                "name": { "from": BEREG, "to": "ООО «Южный берег»" },
                "gln": { "from": "4601234000017", "to": "4601234000024" },
                "gs1Prefixes": {
                    "from": ["4601234", "4609876"],
                    "to": ["4601234", "4605555", "4609876"]
                }
            })
        )]
    );
}

#[tokio::test]
async fn counterparties_are_not_in_the_station_feed() {
    let admin = admin().await;
    let (status, _) = admin
        .call(
            "POST",
            "/v1/office/counterparties",
            Some(new_counterparty()),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let (status, feed) = admin
        .app
        .send(empty(with_device(
            request("GET", "/v1/changes?since=1"),
            &admin.key,
        )))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        feed,
        json!({ "hostId": admin.app.state.host_id, "rev": 2, "hasMore": false, "items": [] })
    );
}

#[tokio::test]
async fn counterparty_fields_follow_the_organization_rules() {
    let admin = admin().await;
    for (body, field) in [
        (
            json!({ "name": " ", "gln": "4601234000017", "gs1Prefixes": [] }),
            "name",
        ),
        (
            json!({ "name": "Берег", "inn": "12345", "gln": "4601234000017", "gs1Prefixes": [] }),
            "inn",
        ),
        (
            json!({ "name": "Берег", "gln": "460123400001", "gs1Prefixes": [] }),
            "gln",
        ),
        (
            json!({ "name": "Берег", "gln": "4601234000017", "gs1Prefixes": ["46"] }),
            "gs1Prefixes",
        ),
    ] {
        let (status, error) = admin
            .call("POST", "/v1/office/counterparties", Some(body))
            .await;
        assert_eq!(
            (status, error["error"]["details"]["field"].clone()),
            (StatusCode::BAD_REQUEST, json!(field))
        );
    }
    let (status, error) = admin
        .call(
            "POST",
            "/v1/office/counterparties",
            Some(
                json!({ "name": "Берег", "gln": "4601234000017", "gs1Prefixes": [], "notes": "" }),
            ),
        )
        .await;
    assert_eq!(
        (status, error["error"]["code"].clone()),
        (StatusCode::BAD_REQUEST, json!("validation_failed"))
    );
    // A body that cannot be read names no field: there is none to name.
    assert!(
        error["error"]["details"]["field"].is_null(),
        "an unknown field is not one field's error: {error}"
    );
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM counterparties")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    assert!(audit_trail(&admin.app, "counterparty.create")
        .await
        .is_empty());
}

/// A name is free text with one rule: no control character. A NUL first
/// used to pass `trim` but fail the table's CHECK (SQLite's `length()` stops
/// at a NUL) as a 500; a NUL inside passed the CHECK, so two names that look
/// the same could both be stored.
#[tokio::test]
async fn a_counterparty_name_with_a_control_character_is_refused() {
    let admin = admin().await;
    let refused = |body: &(StatusCode, Value), label: &str| {
        assert_eq!(
            (
                body.0,
                body.1["error"]["code"].clone(),
                body.1["error"]["details"]["field"].clone()
            ),
            (
                StatusCode::BAD_REQUEST,
                json!("validation_failed"),
                json!("name")
            ),
            "{label}"
        );
    };
    for name in ["\u{0}ООО «Берег»", "ООО\u{0} «Берег»", "ООО\t«Берег»"]
    {
        let created = admin
            .call(
                "POST",
                "/v1/office/counterparties",
                Some(json!({ "name": name, "gln": "4601234000017", "gs1Prefixes": [] })),
            )
            .await;
        refused(&created, &format!("create {name:?}"));
    }

    // The same on an update of an existing counterparty.
    let (_, existing) = admin
        .call(
            "POST",
            "/v1/office/counterparties",
            Some(new_counterparty()),
        )
        .await;
    let path = format!(
        "/v1/office/counterparties/{}",
        existing["id"].as_str().unwrap()
    );
    let revision = host_revision(&admin.app).await;
    for name in ["\u{0}ООО «Берег»", "ООО\u{0} «Берег»", "ООО\t«Берег»"]
    {
        let mut body = full(Value::Null, false, 2);
        body["name"] = json!(name);
        let updated = admin.call("PUT", &path, Some(body)).await;
        refused(&updated, &format!("update {name:?}"));
    }
    assert_eq!(host_revision(&admin.app).await, revision);
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM counterparties")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    assert_eq!(count, 1, "only the valid one exists");
    assert_eq!(
        audit_trail(&admin.app, "counterparty.create").await.len(),
        1
    );
    assert!(audit_trail(&admin.app, "counterparty.update")
        .await
        .is_empty());
}

#[tokio::test]
async fn technologists_read_counterparties_but_do_not_change_them() {
    let admin = admin().await;
    let (_, created) = admin
        .call(
            "POST",
            "/v1/office/counterparties",
            Some(new_counterparty()),
        )
        .await;
    let tech = admin.technologist().await;

    let (status, list) = admin
        .call_as(&tech, "GET", "/v1/office/counterparties", None)
        .await;
    assert_eq!((status, list), (StatusCode::OK, json!([created.clone()])));
    let (status, _) = admin
        .call_as(
            &tech,
            "POST",
            "/v1/office/counterparties",
            Some(new_counterparty()),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let path = format!(
        "/v1/office/counterparties/{}",
        created["id"].as_str().unwrap()
    );
    let (status, _) = admin
        .call_as(&tech, "PUT", &path, Some(full(Value::Null, true, 2)))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(
        audit_trail(&admin.app, "counterparty.create").await.len(),
        1
    );
    assert!(audit_trail(&admin.app, "counterparty.update")
        .await
        .is_empty());
}

#[tokio::test]
async fn an_unknown_counterparty_is_not_found_once_its_body_is_valid() {
    let admin = admin().await;
    let path = "/v1/office/counterparties/9b2e4a6c-0000-4000-8000-000000000000";
    let revision = host_revision(&admin.app).await;
    let rows = audit_rows(&admin.app).await;
    let mut invalid = full(Value::Null, false, 1);
    invalid["gln"] = json!("1");
    let (status, body) = admin.call("PUT", path, Some(invalid)).await;
    assert_eq!(
        (status, body["error"]["details"]["field"].clone()),
        (StatusCode::BAD_REQUEST, json!("gln"))
    );
    let (status, body) = admin
        .call("PUT", path, Some(full(Value::Null, false, 1)))
        .await;
    assert_eq!(
        (status, body["error"]["code"].clone()),
        (StatusCode::NOT_FOUND, json!("not_found"))
    );
    // Neither refusal wrote anything: no revision, no audit row of any action.
    assert_eq!(host_revision(&admin.app).await, revision);
    assert_eq!(audit_rows(&admin.app).await, rows);
}
