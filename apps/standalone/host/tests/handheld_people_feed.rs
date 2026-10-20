//! The people a handheld signs operators in with (owner report: after a pairing the handheld found nobody). The handheld reads them from
//! the same `GET /v1/changes` feed as a station, with its own device key, right after its claim: operators with the personnel number, name,
//! role and PIN verifier, and badges with their verifier under the site salt. A person the office adds after the claim arrives on the next
//! read from the revision the handheld holds, and nothing earlier is sent again.

mod support;

use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{admin, empty, pair_handheld, request, with_device, Admin};

/// `pinPhc` of `proto/fixtures/phc-password.json`: the PIN 4821.
const PIN_4821: &str =
    "pbkdf2$sha256$100000$bWFya2lyby1waW4tc2FsdA==$3OKvrZ2+EfTB2zsCso90r5g8c6Ib6t+Bv+cGJOpgPmU=";

async fn operator(admin: &Admin, login: &str, name: &str) -> String {
    let (status, created) = admin
        .call(
            "POST",
            "/v1/office/operators",
            Some(json!({ "login": login, "name": name, "pinPhc": PIN_4821 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    created["id"].as_str().unwrap().to_owned()
}

async fn salt(admin: &Admin) -> String {
    let (status, body) = admin.call("GET", "/v1/office/badge-salt", None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body["badgeSalt"].as_str().unwrap().to_owned()
}

/// The feed as the handheld with `key` reads it.
async fn feed(admin: &Admin, key: &str, since: i64) -> Value {
    let (status, body) = admin
        .app
        .send(empty(with_device(
            request("GET", &format!("/v1/changes?since={since}&limit=500")),
            key,
        )))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body
}

fn people<'a>(page: &'a Value, entity: &str) -> Vec<&'a Value> {
    page["items"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|item| item["entity"] == entity)
        .collect()
}

#[tokio::test]
async fn a_handheld_reads_operators_and_badges_in_its_first_feed_read() {
    let admin = admin().await;
    let id = operator(&admin, "0042", "Анна Кузнецова").await;
    let badge_phc = format!("pbkdf2$sha256$100000${}${}", salt(&admin).await, {
        use base64::engine::general_purpose::STANDARD;
        use base64::Engine;
        STANDARD.encode([7u8; 32])
    });
    let (status, added) = admin
        .call(
            "POST",
            &format!("/v1/office/operators/{id}/badges"),
            Some(json!({ "badgePhc": badge_phc, "label": "Пропуск" })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{added}");

    // The key a handheld gets from its claim, and its very first read from revision 0.
    let key = pair_handheld(&admin).await;
    let page = feed(&admin, &key, 0).await;

    let operators = people(&page, "operators");
    assert_eq!(operators.len(), 1, "{page}");
    assert_eq!(operators[0]["id"], json!(id));
    assert_eq!(
        operators[0]["data"],
        json!({ "login": "0042", "name": "Анна Кузнецова", "role": null, "pinPhc": PIN_4821 })
    );
    let badges = people(&page, "operator_badges");
    assert_eq!(badges.len(), 1, "{page}");
    assert_eq!(
        badges[0]["data"],
        json!({ "operatorId": id, "badgePhc": badge_phc, "label": "Пропуск" })
    );
}

#[tokio::test]
async fn an_operator_added_after_the_claim_comes_on_the_next_read_from_the_held_revision() {
    let admin = admin().await;
    operator(&admin, "0042", "Анна Кузнецова").await;
    let key = pair_handheld(&admin).await;
    let first = feed(&admin, &key, 0).await;
    let held = first["rev"].as_i64().unwrap();
    assert_eq!(people(&first, "operators").len(), 1, "{first}");

    let late = operator(&admin, "0077", "Пётр Сидоров").await;
    let second = feed(&admin, &key, held).await;
    let operators = people(&second, "operators");
    assert_eq!(operators.len(), 1, "only the new one: {second}");
    assert_eq!(operators[0]["id"], json!(late));
    assert_eq!(operators[0]["data"]["login"], json!("0077"));
    assert!(second["rev"].as_i64().unwrap() > held);
}
