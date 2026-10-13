//! `POST /v1/office/updates/started` (plan ОБН-2): one `app.update.start` row
//! by the administrator with the session's device as its target, no
//! revision; every refusal writes nothing.

mod support;

use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{
    admin, audit_rows, audit_trail, empty, host_revision, json as json_request, request,
    with_device, with_session, Admin,
};

const PATH: &str = "/v1/office/updates/started";
const SHA: &str = "9f2b5c0e6d1a4b8c7e3f2a1d0c9b8a7f6e5d4c3b2a1f0e9d8c7b6a5f4e3d2c1b";

fn started(from: &str, to: &str) -> Value {
    json!({ "from": from, "to": to, "installerSha256": SHA, "source": "file" })
}

/// The station the administrator's session is bound to.
async fn session_device(admin: &Admin) -> String {
    let (status, device) = admin
        .app
        .send(empty(with_device(request("GET", "/v1/device"), &admin.key)))
        .await;
    assert_eq!(status, StatusCode::OK, "{device}");
    device["id"].as_str().unwrap().to_owned()
}

#[tokio::test]
async fn an_administrator_records_the_start_of_an_update_of_the_sessions_device() {
    let admin = admin().await;
    let device = session_device(&admin).await;
    let rev = host_revision(&admin.app).await;
    let (status, body) = admin
        .call("POST", PATH, Some(started("0.1.0", "0.2.0")))
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{body}");
    // A reinstall of the same version is an update too (spec §10.8), and a
    // package from the host is reported the same way (plan ОБН-3).
    let mut from_host = started("0.2.0", "0.2.0");
    from_host["source"] = json!("host");
    let (status, body) = admin.call("POST", PATH, Some(from_host)).await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{body}");
    assert_eq!(
        audit_trail(&admin.app, "app.update.start").await,
        vec![
            admin.row(
                "app.update.start",
                "device",
                &device,
                json!({ "from": "0.1.0", "to": "0.2.0", "installerSha256": SHA, "source": "file" }),
            ),
            admin.row(
                "app.update.start",
                "device",
                &device,
                json!({ "from": "0.2.0", "to": "0.2.0", "installerSha256": SHA, "source": "host" }),
            ),
        ]
    );
    assert_eq!(
        host_revision(&admin.app).await,
        rev,
        "nothing changed, no revision"
    );
}

#[tokio::test]
async fn only_an_administrators_session_records_and_a_refusal_writes_nothing() {
    let admin = admin().await;
    let body = started("0.1.0", "0.2.0");
    let (status, answer) = admin
        .app
        .send(json_request(request("POST", PATH), body.clone()))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "no credential {answer}");
    let (status, answer) = admin
        .app
        .send(json_request(
            with_device(request("POST", PATH), &admin.key),
            body.clone(),
        ))
        .await;
    assert_eq!(
        status,
        StatusCode::UNAUTHORIZED,
        "a device key alone {answer}"
    );
    let (status, answer) = admin
        .app
        .send(json_request(
            with_session(request("POST", PATH), &admin.key, "not-a-token"),
            body.clone(),
        ))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "unknown token {answer}");
    let technologist = admin.technologist().await;
    let rows = audit_rows(&admin.app).await;
    let (status, answer) = admin.call_as(&technologist, "POST", PATH, Some(body)).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{answer}");
    // The role is checked before the body: a technologist's malformed report
    // is refused for the role, not for its fields.
    let (status, answer) = admin
        .call_as(&technologist, "POST", PATH, Some(started("0.1", "0.2.0")))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{answer}");
    assert_eq!(audit_trail(&admin.app, "app.update.start").await, vec![]);
    assert_eq!(audit_rows(&admin.app).await, rows, "no row of any kind");
}

#[tokio::test]
async fn a_body_that_is_not_the_report_is_refused_and_writes_nothing() {
    let admin = admin().await;
    let rows = audit_rows(&admin.app).await;
    let mut cases: Vec<(&str, Value)> = vec![
        ("from", started("0.1", "0.2.0")),
        ("from", started("v0.1.0", "0.2.0")),
        ("to", started("0.1.0", "0.2.0-beta.1")),
        ("to", started("0.2.0", "0.1.0")),
        ("to", started("0.10.0", "0.9.0")),
    ];
    for sha in [
        SHA.to_uppercase(),
        SHA[1..].to_owned(),
        format!("{SHA}0"),
        "g".repeat(64),
    ] {
        let mut body = started("0.1.0", "0.2.0");
        body["installerSha256"] = json!(sha);
        cases.push(("installerSha256", body));
    }
    let mut device = started("0.1.0", "0.2.0");
    device["deviceId"] = json!("7c9e6679-7425-40de-944b-e07fc1f90ae7");
    cases.push(("deviceId", device));
    let mut usb = started("0.1.0", "0.2.0");
    usb["source"] = json!("usb");
    cases.push(("source", usb));
    let mut missing = started("0.1.0", "0.2.0");
    missing.as_object_mut().unwrap().remove("from");
    cases.push(("missing from", missing));
    for (what, body) in cases {
        let (status, answer) = admin.call("POST", PATH, Some(body.clone())).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{what} {body} {answer}");
        assert_eq!(answer["error"]["code"], "validation_failed", "{what}");
    }
    let mut short = started("0.1.0", "0.2.0");
    short["installerSha256"] = json!("ab");
    for (field, body) in [
        ("from", started("0.1", "0.2.0")),
        ("to", started("0.2.0", "0.1.0")),
        ("installerSha256", short),
    ] {
        let (_, answer) = admin.call("POST", PATH, Some(body)).await;
        assert_eq!(answer["error"]["details"]["field"], field);
    }
    assert_eq!(audit_rows(&admin.app).await, rows);
}
