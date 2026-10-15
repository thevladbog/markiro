//! The disaggregation reasons' dictionary (plan ДЗГ): the defaults, a
//! technologist's changes with their audit rows, and what is refused.

mod support;

use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{
    admin, audit_row, audit_rows, audit_trail, empty, host_revision, request, with_device,
};

const PATH: &str = "/v1/office/disaggregation-reasons";

fn names(list: &Value) -> Vec<String> {
    list.as_array()
        .unwrap()
        .iter()
        .map(|reason| reason["name"].as_str().unwrap().to_owned())
        .collect()
}

#[tokio::test]
async fn the_list_holds_the_defaults_in_their_order() {
    let admin = admin().await;
    let (status, list) = admin.call("GET", PATH, None).await;
    assert_eq!(status, StatusCode::OK, "{list}");
    assert_eq!(
        names(&list),
        [
            "Не тот товар",
            "Неверное количество",
            "Повреждена упаковка",
            "Брак по качеству",
            "Другое"
        ]
    );
    assert_eq!(
        list[0],
        json!({
            "id": "d15a0000-0000-4000-8000-000000000001", "name": "Не тот товар",
            "sortOrder": 10, "archived": false, "rev": 0
        })
    );
}

#[tokio::test]
async fn a_technologist_adds_and_archives_a_reason_and_each_change_is_audited() {
    let admin = admin().await;
    let (tech, tech_id) = admin.technologist_session().await;
    let (status, created) = admin
        .call_as(
            &tech,
            "POST",
            PATH,
            Some(json!({ "name": "  Перепаковка по заказу ", "sortOrder": 50 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    assert_eq!(created["name"], "Перепаковка по заказу");
    assert_eq!(created["sortOrder"], 50);
    let id = created["id"].as_str().unwrap().to_owned();
    assert_eq!(
        audit_trail(&admin.app, "disaggregation_reason.create").await,
        [audit_row(
            &tech_id,
            "disaggregation_reason.create",
            "disaggregation_reason",
            &id,
            json!({ "name": "Перепаковка по заказу", "sortOrder": 50 })
        )]
    );
    // Between «Брак по качеству» (40) and «Другое» (90).
    let (_, list) = admin.call("GET", PATH, None).await;
    assert_eq!(names(&list)[4], "Перепаковка по заказу");

    let path = format!("{PATH}/{id}");
    let archive = |rev: &Value| {
        json!({ "name": "Перепаковка по заказу", "sortOrder": 50, "archived": true,
            "expectedRev": rev })
    };
    let (status, archived) = admin
        .call_as(&tech, "PUT", &path, Some(archive(&created["rev"])))
        .await;
    assert_eq!(status, StatusCode::OK, "{archived}");
    assert_eq!(archived["archived"], true);
    assert_eq!(
        archived["rev"].as_i64(),
        Some(created["rev"].as_i64().unwrap() + 1)
    );
    assert_eq!(
        audit_trail(&admin.app, "disaggregation_reason.update").await,
        [audit_row(
            &tech_id,
            "disaggregation_reason.update",
            "disaggregation_reason",
            &id,
            json!({ "changed": ["archived"], "archived": { "from": false, "to": true } })
        )]
    );
    // Archived reasons go after the live ones.
    let (_, list) = admin.call("GET", PATH, None).await;
    assert_eq!(names(&list).last().unwrap(), "Перепаковка по заказу");

    // The same change again over the new revision: the record as it is, no
    // revision, no audit row.
    let revision = host_revision(&admin.app).await;
    let rows = audit_rows(&admin.app).await;
    let (status, again) = admin
        .call_as(&tech, "PUT", &path, Some(archive(&archived["rev"])))
        .await;
    assert_eq!((status, &again), (StatusCode::OK, &archived));
    assert_eq!(host_revision(&admin.app).await, revision);
    assert_eq!(audit_rows(&admin.app).await, rows);
}

#[tokio::test]
async fn a_bad_name_a_stale_rev_an_unknown_reason_and_no_session_are_refused() {
    let admin = admin().await;
    let revision = host_revision(&admin.app).await;
    let rows = audit_rows(&admin.app).await;
    for (what, name) in [
        ("empty", String::new()),
        ("blank", "   ".to_owned()),
        ("long", "x".repeat(121)),
        ("control", "bad\u{7}name".to_owned()),
    ] {
        let (status, body) = admin
            .call("POST", PATH, Some(json!({ "name": name })))
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{what}: {body}");
        assert_eq!(body["error"]["details"]["field"], "name", "{what}");
    }
    let (status, body) = admin
        .call(
            "POST",
            PATH,
            Some(json!({ "name": "ok", "sortOrder": 1_000_001 })),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(body["error"]["details"]["field"], "sortOrder");

    let default = "d15a0000-0000-4000-8000-000000000005";
    let (status, body) = admin
        .call(
            "PUT",
            &format!("{PATH}/{default}"),
            Some(
                json!({ "name": "Другое", "sortOrder": 90, "archived": false,
                "expectedRev": 7 }),
            ),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"]["code"], "stale_revision");
    assert_eq!(body["error"]["details"]["currentRev"], 0);

    let (status, body) = admin
        .call(
            "PUT",
            &format!("{PATH}/d15a0000-0000-4000-8000-0000000000ff"),
            Some(json!({ "name": "x", "sortOrder": 1, "archived": false, "expectedRev": 0 })),
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    assert_eq!(host_revision(&admin.app).await, revision);
    assert_eq!(audit_rows(&admin.app).await, rows);

    // A station's key without an office session is not an office caller.
    for (method, path) in [("GET", PATH), ("POST", PATH)] {
        let builder = with_device(request(method, path), &admin.key);
        let request = if method == "POST" {
            support::app::json(builder, json!({ "name": "x" }))
        } else {
            empty(builder)
        };
        let (status, body) = admin.app.send(request).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{method}: {body}");
        assert_eq!(body["error"]["details"]["credential"], "session");
    }
}
