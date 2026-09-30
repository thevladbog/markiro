mod support;

use axum::http::StatusCode;
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde_json::{json, Value};
use support::app::{
    admin, audit_rows, audit_trail, empty, host_revision, request, with_device, Admin,
};

/// `pinPhc` of `proto/fixtures/phc-password.json`: the PIN 4821.
const PIN_4821: &str =
    "pbkdf2$sha256$100000$bWFya2lyby1waW4tc2FsdA==$3OKvrZ2+EfTB2zsCso90r5g8c6Ib6t+Bv+cGJOpgPmU=";

/// The site's badge salt, as the office reads it.
async fn site_salt(admin: &Admin) -> String {
    let (status, body) = admin.call("GET", "/v1/office/badge-salt", None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body["badgeSalt"].as_str().unwrap().to_owned()
}

/// A badge verifier with `salt` and `iterations`: the host checks both,
/// never the code behind it.
fn badge(salt: &str, iterations: u32, digest_byte: u8) -> String {
    format!(
        "pbkdf2$sha256${iterations}${salt}${}",
        STANDARD.encode([digest_byte; 32])
    )
}

/// A new operator with `login`; returns its id.
async fn operator(admin: &Admin, login: &str) -> String {
    let (status, created) = admin
        .call(
            "POST",
            "/v1/office/operators",
            Some(json!({ "login": login, "name": "Анна Кузнецова", "pinPhc": PIN_4821 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    created["id"].as_str().unwrap().to_owned()
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

#[tokio::test]
async fn the_badge_salt_is_the_sites_and_only_for_administrators() {
    let admin = admin().await;
    let stored: Vec<u8> = sqlx::query_scalar("SELECT badge_salt FROM site WHERE id = 1")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    assert_eq!(site_salt(&admin).await, STANDARD.encode(&stored));
    let tech = admin.technologist().await;
    let (status, body) = admin
        .call_as(&tech, "GET", "/v1/office/badge-salt", None)
        .await;
    assert_eq!(
        (status, body["error"]["code"].clone()),
        (StatusCode::FORBIDDEN, json!("forbidden"))
    );
}

#[tokio::test]
async fn a_badge_hashed_with_the_site_salt_is_added_and_rides_the_feed() {
    let admin = admin().await;
    let salt = site_salt(&admin).await;
    let id = operator(&admin, "0042").await;
    let badge_phc = badge(&salt, 100_000, 1);
    let (status, added) = admin
        .call(
            "POST",
            &format!("/v1/office/operators/{id}/badges"),
            Some(json!({ "badgePhc": badge_phc, "label": " Пропуск №7 " })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{added}");
    let badge_id = added["id"].as_str().unwrap().to_owned();
    assert_eq!(
        added,
        json!({
            "id": badge_id, "label": "Пропуск №7",
            "createdAt": admin.app.state.timestamp(), "revokedAt": null
        })
    );
    assert_eq!(host_revision(&admin.app).await, 3);
    assert_eq!(
        audit_trail(&admin.app, "operator_badge.create").await,
        vec![admin.row(
            "operator_badge.create",
            "operator_badge",
            &badge_id,
            json!({ "operatorId": id, "label": "Пропуск №7" })
        )]
    );
    let (_, list) = admin.call("GET", "/v1/office/operators", None).await;
    assert_eq!(list[0]["badges"], json!([added]));
    assert_eq!(list[0]["rev"], json!(2), "a badge is its own feed record");
    assert!(!list.to_string().contains("pbkdf2"));
    assert_eq!(
        feed(&admin, 2).await,
        json!([{
            "entity": "operator_badges", "id": badge_id, "rev": 3, "deleted": false,
            "data": { "operatorId": id, "badgePhc": badge_phc, "label": "Пропуск №7" }
        }])
    );
}

#[tokio::test]
async fn a_badge_hash_must_carry_the_site_salt_and_the_domain_iterations() {
    let admin = admin().await;
    let salt = site_salt(&admin).await;
    let id = operator(&admin, "0042").await;
    let path = format!("/v1/office/operators/{id}/badges");
    let revision = host_revision(&admin.app).await;
    let audit_rows_before = audit_rows(&admin.app).await;
    for badge_phc in [
        badge(&salt, 200_000, 1),
        badge(&salt, 10_000, 1),
        badge("bWFya2lyby1waW4tc2FsdA==", 100_000, 1),
        "MRK-000742".to_owned(),
    ] {
        let (status, body) = admin
            .call("POST", &path, Some(json!({ "badgePhc": badge_phc })))
            .await;
        assert_eq!(
            (status, body["error"]["details"]["field"].clone()),
            (StatusCode::BAD_REQUEST, json!("badgePhc")),
            "{badge_phc}"
        );
    }
    let (status, body) = admin
        .call(
            "POST",
            &path,
            Some(json!({ "badgePhc": badge(&salt, 100_000, 1), "label": "п".repeat(101) })),
        )
        .await;
    assert_eq!(
        (status, body["error"]["details"]["field"].clone()),
        (StatusCode::BAD_REQUEST, json!("label"))
    );
    assert!(audit_trail(&admin.app, "operator_badge.create")
        .await
        .is_empty());
    // The refusals wrote nothing: no revision and no audit row of any action.
    assert_eq!(host_revision(&admin.app).await, revision);
    assert_eq!(audit_rows(&admin.app).await, audit_rows_before);
    // A blank label is no label.
    let (status, added) = admin
        .call(
            "POST",
            &path,
            Some(json!({ "badgePhc": badge(&salt, 100_000, 1), "label": "  " })),
        )
        .await;
    assert_eq!(
        (status, added["label"].clone()),
        (StatusCode::OK, Value::Null)
    );
}

/// A badge code belongs to one operator at a time; the conflict names that
/// operator (`details.operatorId`), whoever asks for the same code again.
#[tokio::test]
async fn one_badge_code_belongs_to_one_operator_at_a_time() {
    let admin = admin().await;
    let salt = site_salt(&admin).await;
    let first = operator(&admin, "0042").await;
    let second = operator(&admin, "0043").await;
    let same = json!({ "badgePhc": badge(&salt, 100_000, 1) });
    let (status, added) = admin
        .call(
            "POST",
            &format!("/v1/office/operators/{first}/badges"),
            Some(same.clone()),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{added}");
    // A refused conflict writes nothing. It is the one refusal that takes a
    // revision before it fails, so the rollback has to give it back.
    let revision = host_revision(&admin.app).await;
    let audit_rows_before = audit_rows(&admin.app).await;
    for asker in [&second, &first] {
        let (status, body) = admin
            .call(
                "POST",
                &format!("/v1/office/operators/{asker}/badges"),
                Some(same.clone()),
            )
            .await;
        assert_eq!(
            (status, body["error"]["details"].clone()),
            (
                StatusCode::CONFLICT,
                json!({ "constraint": "badge", "operatorId": first })
            )
        );
    }
    assert_eq!(host_revision(&admin.app).await, revision);
    assert_eq!(audit_rows(&admin.app).await, audit_rows_before);
    // A revoked badge frees its code; the new badge gets a new id.
    let (status, _) = admin
        .call(
            "DELETE",
            &format!(
                "/v1/office/operators/{first}/badges/{}",
                added["id"].as_str().unwrap()
            ),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, again) = admin
        .call(
            "POST",
            &format!("/v1/office/operators/{second}/badges"),
            Some(same.clone()),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{again}");
    assert_ne!(again["id"], added["id"]);
    // The code is the second operator's now, and the conflict names the holder
    // it has today, not the earlier one whose revoked row the table still keeps.
    let revision = host_revision(&admin.app).await;
    let audit_rows_before = audit_rows(&admin.app).await;
    let (status, body) = admin
        .call(
            "POST",
            &format!("/v1/office/operators/{first}/badges"),
            Some(same),
        )
        .await;
    assert_eq!(
        (status, body["error"]["details"].clone()),
        (
            StatusCode::CONFLICT,
            json!({ "constraint": "badge", "operatorId": second })
        )
    );
    assert_eq!(host_revision(&admin.app).await, revision);
    assert_eq!(audit_rows(&admin.app).await, audit_rows_before);
}

#[tokio::test]
async fn a_zero_padded_copy_of_an_active_badge_is_refused_not_stored_twice() {
    let admin = admin().await;
    let salt = site_salt(&admin).await;
    let id = operator(&admin, "0042").await;
    let path = format!("/v1/office/operators/{id}/badges");
    let card = badge(&salt, 100_000, 1);
    let (status, added) = admin
        .call("POST", &path, Some(json!({ "badgePhc": card })))
        .await;
    assert_eq!(status, StatusCode::OK, "{added}");
    // The same card, salt and digest, with the count written `0100000`: a
    // station reads it as 100000, but the unique index compares the text and
    // would take it for another badge.
    let padded = card.replacen("$100000$", "$0100000$", 1);
    assert_ne!(padded, card);
    let revision = host_revision(&admin.app).await;
    let (_, before) = admin.call("GET", "/v1/office/operators", None).await;
    let (status, body) = admin
        .call("POST", &path, Some(json!({ "badgePhc": padded })))
        .await;
    assert_eq!(
        (
            status,
            body["error"]["code"].clone(),
            body["error"]["details"]["field"].clone()
        ),
        (
            StatusCode::BAD_REQUEST,
            json!("validation_failed"),
            json!("badgePhc")
        ),
        "{body}"
    );
    // No second badge: no revision, and the operator's badges are as before.
    assert_eq!(host_revision(&admin.app).await, revision);
    let (_, after) = admin.call("GET", "/v1/office/operators", None).await;
    assert_eq!(after, before);
    assert_eq!(after[0]["badges"], json!([added]));
    assert_eq!(
        audit_trail(&admin.app, "operator_badge.create").await.len(),
        1
    );
}

#[tokio::test]
async fn revoking_a_badge_writes_a_tombstone_and_the_badge_never_comes_back() {
    let admin = admin().await;
    let salt = site_salt(&admin).await;
    let id = operator(&admin, "0042").await;
    let (_, added) = admin
        .call(
            "POST",
            &format!("/v1/office/operators/{id}/badges"),
            Some(json!({ "badgePhc": badge(&salt, 100_000, 1) })),
        )
        .await;
    let badge_id = added["id"].as_str().unwrap().to_owned();
    let path = format!("/v1/office/operators/{id}/badges/{badge_id}");

    let (status, body) = admin.call("DELETE", &path, None).await;
    assert_eq!((status, body), (StatusCode::NO_CONTENT, Value::Null));
    let tombstone =
        json!({ "entity": "operator_badges", "id": badge_id, "rev": 4, "deleted": true });
    assert_eq!(feed(&admin, 3).await, json!([tombstone]));
    // From zero: the operator, and the badge only as its tombstone.
    assert_eq!(
        feed(&admin, 1).await,
        json!([
            {
                "entity": "operators", "id": id, "rev": 2, "deleted": false,
                "data": { "login": "0042", "name": "Анна Кузнецова", "role": null, "pinPhc": PIN_4821 }
            },
            tombstone
        ])
    );
    let (_, list) = admin.call("GET", "/v1/office/operators", None).await;
    assert_eq!(
        list[0]["badges"][0]["revokedAt"],
        json!(admin.app.state.timestamp())
    );
    assert_eq!(
        audit_trail(&admin.app, "operator_badge.revoke").await,
        vec![admin.row(
            "operator_badge.revoke",
            "operator_badge",
            &badge_id,
            json!({ "operatorId": id })
        )]
    );

    // Revoking it again, later, changes nothing: the revocation time the
    // office shows stays, and so does the tombstone's revision, which a
    // rewrite would move up. The clock moves first, so a rewritten time shows.
    let revoked_at = list[0]["badges"][0]["revokedAt"].clone();
    admin.app.clock.advance(time::Duration::minutes(5));
    let (status, _) = admin.call("DELETE", &path, None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(host_revision(&admin.app).await, 4);
    let (_, later) = admin.call("GET", "/v1/office/operators", None).await;
    assert_eq!(later[0]["badges"][0]["revokedAt"], revoked_at);
    assert_eq!(feed(&admin, 3).await, json!([tombstone]));
    assert_eq!(feed(&admin, 4).await, json!([]));
    assert_eq!(
        audit_trail(&admin.app, "operator_badge.revoke").await.len(),
        1
    );
}

#[tokio::test]
async fn a_badge_is_found_only_under_its_own_operator() {
    let admin = admin().await;
    let salt = site_salt(&admin).await;
    let owner = operator(&admin, "0042").await;
    let other = operator(&admin, "0043").await;
    let (_, added) = admin
        .call(
            "POST",
            &format!("/v1/office/operators/{owner}/badges"),
            Some(json!({ "badgePhc": badge(&salt, 100_000, 1) })),
        )
        .await;
    let badge_id = added["id"].as_str().unwrap();
    let revision = host_revision(&admin.app).await;
    for path in [
        format!("/v1/office/operators/{other}/badges/{badge_id}"),
        format!("/v1/office/operators/{owner}/badges/9b2e4a6c-0000-4000-8000-000000000000"),
    ] {
        let (status, body) = admin.call("DELETE", &path, None).await;
        assert_eq!(
            (status, body["error"]["code"].clone()),
            (StatusCode::NOT_FOUND, json!("not_found")),
            "{path}"
        );
    }
    let (status, body) = admin
        .call(
            "POST",
            "/v1/office/operators/9b2e4a6c-0000-4000-8000-000000000000/badges",
            Some(json!({ "badgePhc": badge(&salt, 100_000, 2) })),
        )
        .await;
    assert_eq!(
        (status, body["error"]["code"].clone()),
        (StatusCode::NOT_FOUND, json!("not_found"))
    );
    assert!(audit_trail(&admin.app, "operator_badge.revoke")
        .await
        .is_empty());
    // The refusals changed nothing: no revision was taken and the badge is
    // still active under its owner.
    assert_eq!(host_revision(&admin.app).await, revision);
    let (_, list) = admin.call("GET", "/v1/office/operators", None).await;
    assert_eq!(list[0]["badges"], json!([added]));
    assert_eq!(list[0]["badges"][0]["revokedAt"], Value::Null);
}

#[tokio::test]
async fn technologists_cannot_touch_badges() {
    let admin = admin().await;
    let salt = site_salt(&admin).await;
    let id = operator(&admin, "0042").await;
    let (_, added) = admin
        .call(
            "POST",
            &format!("/v1/office/operators/{id}/badges"),
            Some(json!({ "badgePhc": badge(&salt, 100_000, 1) })),
        )
        .await;
    let tech = admin.technologist().await;
    let (status, _) = admin
        .call_as(
            &tech,
            "POST",
            &format!("/v1/office/operators/{id}/badges"),
            Some(json!({ "badgePhc": badge(&salt, 100_000, 2) })),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = admin
        .call_as(
            &tech,
            "DELETE",
            &format!(
                "/v1/office/operators/{id}/badges/{}",
                added["id"].as_str().unwrap()
            ),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(
        audit_trail(&admin.app, "operator_badge.create").await.len(),
        1
    );
    assert!(audit_trail(&admin.app, "operator_badge.revoke")
        .await
        .is_empty());
}
