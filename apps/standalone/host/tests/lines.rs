mod support;

use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{
    admin, audit_rows, audit_trail, empty, host_revision, json as json_request, request,
    with_device, Admin,
};

/// The office list of lines.
async fn lines(admin: &Admin) -> Vec<Value> {
    let (status, body) = admin.call("GET", "/v1/office/lines", None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body.as_array().unwrap().clone()
}

/// The feed items a station gets after `since`.
async fn feed(admin: &Admin, since: i64) -> Value {
    let (status, body) = admin
        .app
        .send(empty(with_device(
            request("GET", &format!("/v1/changes?since={since}")),
            &admin.key,
        )))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body["items"].clone()
}

fn constraint(body: &Value) -> Value {
    body["error"]["details"]["constraint"].clone()
}

#[tokio::test]
async fn an_administrator_creates_renames_and_archives_lines() {
    let admin = admin().await;
    let (status, created) = admin
        .call(
            "POST",
            "/v1/office/lines",
            Some(json!({ "name": "  Линия 3  " })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let id = created["id"].as_str().unwrap().to_owned();
    assert_eq!(
        created,
        json!({ "id": id, "name": "Линия 3", "archived": false, "rev": 2 })
    );
    assert_eq!(
        audit_trail(&admin.app, "line.create").await,
        vec![admin.row("line.create", "line", &id, json!({ "name": "Линия 3" }))]
    );
    // Stations get the new line.
    assert_eq!(
        feed(&admin, 1).await,
        json!([{ "entity": "lines", "id": id, "rev": 2, "deleted": false, "data": { "name": "Линия 3", "archived": false } }])
    );

    let path = format!("/v1/office/lines/{id}");
    let (status, renamed) = admin
        .call(
            "PUT",
            &path,
            Some(json!({ "name": "Упаковка", "expectedRev": 2 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{renamed}");
    assert_eq!(
        renamed,
        json!({ "id": id, "name": "Упаковка", "archived": false, "rev": 3 })
    );
    let (status, archived) = admin
        .call(
            "PUT",
            &path,
            Some(json!({ "archived": true, "expectedRev": 3 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{archived}");
    assert_eq!(
        archived,
        json!({ "id": id, "name": "Упаковка", "archived": true, "rev": 4 })
    );
    assert_eq!(
        audit_trail(&admin.app, "line.update").await,
        vec![
            admin.row(
                "line.update",
                "line",
                &id,
                json!({ "changed": ["name"], "name": { "from": "Линия 3", "to": "Упаковка" } })
            ),
            admin.row(
                "line.update",
                "line",
                &id,
                json!({ "changed": ["archived"], "archived": { "from": false, "to": true } })
            ),
        ]
    );
    // An archived line stays in the feed and in the office list, marked.
    assert_eq!(
        feed(&admin, 3).await,
        json!([{ "entity": "lines", "id": id, "rev": 4, "deleted": false, "data": { "name": "Упаковка", "archived": true } }])
    );
    let listed: Vec<(Value, Value)> = lines(&admin)
        .await
        .iter()
        .map(|line| (line["name"].clone(), line["archived"].clone()))
        .collect();
    assert_eq!(
        listed,
        vec![
            (json!("Линия 1"), json!(false)),
            (json!("Линия 2"), json!(false)),
            (json!("Упаковка"), json!(true)),
        ]
    );

    // Nothing to change: no revision, no row.
    let (status, same) = admin
        .call(
            "PUT",
            &path,
            Some(json!({ "name": " Упаковка ", "archived": true, "expectedRev": 4 })),
        )
        .await;
    assert_eq!((status, same), (StatusCode::OK, archived));
    assert_eq!(host_revision(&admin.app).await, 4);
    assert_eq!(audit_trail(&admin.app, "line.update").await.len(), 2);
    // An old revision is refused, and changes nothing: no revision and no
    // audit row, of any action.
    let rows = audit_rows(&admin.app).await;
    let (status, body) = admin
        .call(
            "PUT",
            &path,
            Some(json!({ "archived": false, "expectedRev": 3 })),
        )
        .await;
    assert_eq!(
        (
            status,
            body["error"]["code"].clone(),
            body["error"]["details"]["currentRev"].clone()
        ),
        (StatusCode::CONFLICT, json!("stale_revision"), json!(4))
    );
    assert_eq!(host_revision(&admin.app).await, 4);
    assert_eq!(audit_rows(&admin.app).await, rows);
}

/// A rename to a spelling that differs only in case keeps the uniqueness key,
/// and the line does not clash with itself.
#[tokio::test]
async fn a_line_may_be_renamed_to_a_case_variant_of_its_own_name() {
    let admin = admin().await;
    let first = lines(&admin).await[0].clone();
    assert_eq!(first["name"], json!("Линия 1"));
    let id = first["id"].as_str().unwrap().to_owned();

    let (status, renamed) = admin
        .call(
            "PUT",
            &format!("/v1/office/lines/{id}"),
            Some(json!({ "name": "ЛИНИЯ 1", "expectedRev": 1 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{renamed}");
    assert_eq!(
        renamed,
        json!({ "id": id, "name": "ЛИНИЯ 1", "archived": false, "rev": 2 })
    );
    assert_eq!(
        audit_trail(&admin.app, "line.update").await,
        vec![admin.row(
            "line.update",
            "line",
            &id,
            json!({ "changed": ["name"], "name": { "from": "Линия 1", "to": "ЛИНИЯ 1" } })
        )]
    );
    // Stations get the new spelling.
    assert_eq!(
        feed(&admin, 1).await,
        json!([{ "entity": "lines", "id": id, "rev": 2, "deleted": false, "data": { "name": "ЛИНИЯ 1", "archived": false } }])
    );
}

#[tokio::test]
async fn an_archived_line_comes_back_when_its_name_is_free() {
    let admin = admin().await;
    let id = lines(&admin).await[0]["id"].as_str().unwrap().to_owned();
    let path = format!("/v1/office/lines/{id}");
    let (status, archived) = admin
        .call(
            "PUT",
            &path,
            Some(json!({ "archived": true, "expectedRev": 1 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{archived}");

    let (status, restored) = admin
        .call(
            "PUT",
            &path,
            Some(json!({ "archived": false, "expectedRev": 2 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{restored}");
    assert_eq!(
        restored,
        json!({ "id": id, "name": "Линия 1", "archived": false, "rev": 3 })
    );
    assert!(lines(&admin).await.contains(&restored));
    let archive = |from: bool, to: bool| {
        admin.row(
            "line.update",
            "line",
            &id,
            json!({ "changed": ["archived"], "archived": { "from": from, "to": to } }),
        )
    };
    assert_eq!(
        audit_trail(&admin.app, "line.update").await,
        vec![archive(false, true), archive(true, false)]
    );
    // Stations get the line active again.
    assert_eq!(
        feed(&admin, 2).await,
        json!([{ "entity": "lines", "id": id, "rev": 3, "deleted": false, "data": { "name": "Линия 1", "archived": false } }])
    );
}

/// The uniqueness index covers active lines only, so an archived line may
/// take the name of an active one (it cannot come back while that holds: see
/// `line_names_are_unique_among_active_lines_regardless_of_case`).
#[tokio::test]
async fn an_archived_line_may_take_the_name_of_an_active_one() {
    let admin = admin().await;
    let wizard = lines(&admin).await;
    let first = wizard[0]["id"].as_str().unwrap().to_owned();
    assert_eq!(wizard[1]["name"], json!("Линия 2"), "the active line");
    let path = format!("/v1/office/lines/{first}");
    let (status, _) = admin
        .call(
            "PUT",
            &path,
            Some(json!({ "archived": true, "expectedRev": 1 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);

    let (status, renamed) = admin
        .call(
            "PUT",
            &path,
            Some(json!({ "name": "линия 2", "expectedRev": 2 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{renamed}");
    assert_eq!(
        renamed,
        json!({ "id": first, "name": "линия 2", "archived": true, "rev": 3 })
    );
    // Two lines now share the name: the active one and the archived one.
    let sharing: Vec<bool> = sqlx::query_scalar(
        "SELECT archived FROM lines WHERE name_key = 'линия 2' ORDER BY archived",
    )
    .fetch_all(&admin.app.state.pool)
    .await
    .unwrap();
    assert_eq!(sharing, vec![false, true]);
}

#[tokio::test]
async fn line_names_are_unique_among_active_lines_regardless_of_case() {
    let admin = admin().await;
    let wizard = lines(&admin).await;
    let first = format!("/v1/office/lines/{}", wizard[0]["id"].as_str().unwrap());
    let second = format!("/v1/office/lines/{}", wizard[1]["id"].as_str().unwrap());

    let (status, body) = admin
        .call(
            "POST",
            "/v1/office/lines",
            Some(json!({ "name": "ЛИНИЯ 1" })),
        )
        .await;
    assert_eq!(
        (status, constraint(&body)),
        (StatusCode::CONFLICT, json!("line_name"))
    );
    let (status, body) = admin
        .call(
            "PUT",
            &second,
            Some(json!({ "name": "линия 1", "expectedRev": 1 })),
        )
        .await;
    assert_eq!(
        (status, constraint(&body)),
        (StatusCode::CONFLICT, json!("line_name"))
    );
    assert_eq!(
        host_revision(&admin.app).await,
        1,
        "a refused write takes no revision"
    );

    // Once «Линия 1» is archived, its name is free...
    let (status, _) = admin
        .call(
            "PUT",
            &first,
            Some(json!({ "archived": true, "expectedRev": 1 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let (status, reused) = admin
        .call(
            "POST",
            "/v1/office/lines",
            Some(json!({ "name": "линия 1" })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{reused}");
    // ...and the archived line cannot come back while the name is taken.
    let (status, body) = admin
        .call(
            "PUT",
            &first,
            Some(json!({ "archived": false, "expectedRev": 2 })),
        )
        .await;
    assert_eq!(
        (status, constraint(&body)),
        (StatusCode::CONFLICT, json!("line_name"))
    );
    assert_eq!(audit_trail(&admin.app, "line.create").await.len(), 1);
    assert_eq!(audit_trail(&admin.app, "line.update").await.len(), 1);
}

#[tokio::test]
async fn line_names_are_checked() {
    let admin = admin().await;
    for name in [" ".to_owned(), "л".repeat(101)] {
        let (status, body) = admin
            .call("POST", "/v1/office/lines", Some(json!({ "name": name })))
            .await;
        assert_eq!(
            (status, body["error"]["details"]["field"].clone()),
            (StatusCode::BAD_REQUEST, json!("name"))
        );
    }
    let path = format!(
        "/v1/office/lines/{}",
        lines(&admin).await[0]["id"].as_str().unwrap()
    );
    let (status, body) = admin
        .call("PUT", &path, Some(json!({ "name": "", "expectedRev": 1 })))
        .await;
    assert_eq!(
        (status, body["error"]["details"]["field"].clone()),
        (StatusCode::BAD_REQUEST, json!("name"))
    );
    let (status, body) = admin
        .call(
            "PUT",
            &path,
            Some(json!({ "rename": "Упаковка", "expectedRev": 1 })),
        )
        .await;
    assert_eq!(
        (status, body["error"]["code"].clone()),
        (StatusCode::BAD_REQUEST, json!("validation_failed"))
    );
    assert!(audit_trail(&admin.app, "line.create").await.is_empty());
    assert!(audit_trail(&admin.app, "line.update").await.is_empty());
}

#[tokio::test]
async fn technologists_read_lines_but_do_not_change_them() {
    let admin = admin().await;
    let tech = admin.technologist().await;
    let (status, list) = admin.call_as(&tech, "GET", "/v1/office/lines", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(list, Value::Array(lines(&admin).await));
    let (status, _) = admin
        .call_as(
            &tech,
            "POST",
            "/v1/office/lines",
            Some(json!({ "name": "Линия 3" })),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let path = format!("/v1/office/lines/{}", list[0]["id"].as_str().unwrap());
    let (status, _) = admin
        .call_as(
            &tech,
            "PUT",
            &path,
            Some(json!({ "archived": true, "expectedRev": 1 })),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(audit_trail(&admin.app, "line.create").await.is_empty());
    assert!(audit_trail(&admin.app, "line.update").await.is_empty());
}

#[tokio::test]
async fn archiving_a_line_leaves_its_stations_on_it() {
    let admin = admin().await;
    let line = lines(&admin).await[0]["id"].as_str().unwrap().to_owned();
    let (status, _) = admin
        .app
        .send(json_request(
            with_device(request("PUT", "/v1/device/line"), &admin.key),
            json!({ "lineId": line }),
        ))
        .await;
    assert_eq!(status, StatusCode::OK);

    let (status, _) = admin
        .call(
            "PUT",
            &format!("/v1/office/lines/{line}"),
            Some(json!({ "archived": true, "expectedRev": 1 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let (_, device) = admin
        .app
        .send(empty(with_device(request("GET", "/v1/device"), &admin.key)))
        .await;
    assert_eq!(device["lineId"], json!(line));
}

#[tokio::test]
async fn an_unknown_line_is_not_found_once_its_body_is_valid() {
    let admin = admin().await;
    let path = "/v1/office/lines/9b2e4a6c-0000-4000-8000-000000000000";
    let revision = host_revision(&admin.app).await;
    let rows = audit_rows(&admin.app).await;
    let (status, body) = admin
        .call("PUT", path, Some(json!({ "name": " ", "expectedRev": 1 })))
        .await;
    assert_eq!(
        (status, body["error"]["details"]["field"].clone()),
        (StatusCode::BAD_REQUEST, json!("name"))
    );
    let (status, body) = admin
        .call(
            "PUT",
            path,
            Some(json!({ "archived": true, "expectedRev": 1 })),
        )
        .await;
    assert_eq!(
        (status, body["error"]["code"].clone()),
        (StatusCode::NOT_FOUND, json!("not_found"))
    );
    // Neither refusal wrote anything: no revision, no audit row of any action.
    assert_eq!(host_revision(&admin.app).await, revision);
    assert_eq!(audit_rows(&admin.app).await, rows);
}
