//! A line's limit of devices in one shift (plan 2b, spec §7 «Линия», §12.8): administrators set
//! 1–16, never below the devices working an active shift of the line; a change writes
//! `line.max_stations_changed`, and the stations' feed record of the line is unchanged.

mod support;

use axum::http::StatusCode;
use serde_json::json;
use support::app::{admin, audit_rows, audit_trail, host_revision, shift_setup};
use support::multi::shared;

#[tokio::test]
async fn an_administrator_sets_the_limit_never_below_the_devices_at_work() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    // Two devices work an active shift of the line (its limit is 2).
    let (_a, _b, _shift, _) = shared(&admin, &setup, None).await;
    let path = format!("/v1/office/lines/{}", setup.line);
    let current = |lines: &serde_json::Value| {
        lines
            .as_array()
            .unwrap()
            .iter()
            .find(|line| line["id"] == json!(setup.line))
            .unwrap()
            .clone()
    };
    let (_, lines) = admin.call("GET", "/v1/office/lines", None).await;
    let line = current(&lines);
    assert_eq!(line["maxStations"], json!(2));
    // Signed in before the counts: a sign-in writes its own audit row.
    let tech = admin.technologist().await;
    let revision = host_revision(&admin.app).await;
    let rows = audit_rows(&admin.app).await;
    let (status, refused) = admin
        .call(
            "PUT",
            &path,
            Some(json!({ "maxStations": 1, "expectedRev": line["rev"] })),
        )
        .await;
    assert_eq!(
        (status, refused["error"]["details"].clone()),
        (
            StatusCode::CONFLICT,
            json!({ "constraint": "line_stations_in_use", "active": 2 })
        )
    );
    for bad in [0, 17] {
        let (status, refused) = admin
            .call(
                "PUT",
                &path,
                Some(json!({ "maxStations": bad, "expectedRev": line["rev"] })),
            )
            .await;
        assert_eq!(
            (status, refused["error"]["details"]["field"].clone()),
            (StatusCode::BAD_REQUEST, json!("maxStations"))
        );
    }
    let (status, _) = admin
        .call_as(
            &tech,
            "PUT",
            &path,
            Some(json!({ "maxStations": 3, "expectedRev": line["rev"] })),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(
        (
            host_revision(&admin.app).await,
            audit_rows(&admin.app).await
        ),
        (revision, rows)
    );
    let (status, raised) = admin
        .call(
            "PUT",
            &path,
            Some(json!({ "maxStations": 3, "expectedRev": line["rev"] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{raised}");
    assert_eq!(
        (raised["maxStations"].clone(), raised["rev"].clone()),
        (json!(3), json!(revision + 1))
    );
    assert_eq!(
        audit_trail(&admin.app, "line.max_stations_changed").await,
        vec![admin.row(
            "line.max_stations_changed",
            "line",
            &setup.line,
            json!({ "from": 2, "to": 3 })
        )]
    );
    assert!(audit_trail(&admin.app, "line.update").await.is_empty());
    // The same limit again changes nothing.
    let (status, same) = admin
        .call(
            "PUT",
            &path,
            Some(json!({ "maxStations": 3, "expectedRev": raised["rev"] })),
        )
        .await;
    assert_eq!(
        (status, same["rev"].clone()),
        (StatusCode::OK, raised["rev"].clone())
    );
    assert_eq!(host_revision(&admin.app).await, revision + 1);
    // The stations' feed record of the line is the name and the flag, as before.
    let feed = admin.feed(revision).await;
    assert_eq!(
        feed,
        json!([{ "entity": "lines", "id": setup.line, "rev": revision + 1, "deleted": false,
                 "data": { "name": "Линия 1", "archived": false } }])
    );
}
