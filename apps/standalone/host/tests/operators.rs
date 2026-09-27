mod support;

use axum::http::StatusCode;
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde_json::{json, Value};
use support::app::{admin, audit_trail, empty, host_revision, request, with_device, Admin};

/// `pinPhc` of `proto/fixtures/phc-password.json`: the PIN 4821.
const PIN_4821: &str =
    "pbkdf2$sha256$100000$bWFya2lyby1waW4tc2FsdA==$3OKvrZ2+EfTB2zsCso90r5g8c6Ib6t+Bv+cGJOpgPmU=";

/// A PIN verifier in the domain format: the host checks only its shape and
/// its iteration count, never which PIN it hides.
fn pin(iterations: u32, digest_byte: u8) -> String {
    format!(
        "pbkdf2$sha256${iterations}$bWFya2lyby1waW4tc2FsdA==${}",
        STANDARD.encode([digest_byte; 32])
    )
}

fn new_operator(login: &str) -> Value {
    json!({ "login": login, "name": " Анна Кузнецова ", "role": " Упаковщик ", "pinPhc": PIN_4821 })
}

fn field(body: &Value) -> Value {
    body["error"]["details"]["field"].clone()
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

/// A new operator `0042`; returns its id.
async fn create(admin: &Admin) -> String {
    let (status, created) = admin
        .call("POST", "/v1/office/operators", Some(new_operator("0042")))
        .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    created["id"].as_str().unwrap().to_owned()
}

#[tokio::test]
async fn an_administrator_creates_an_operator_and_never_gets_a_hash_back() {
    let admin = admin().await;
    let (status, created) = admin
        .call("POST", "/v1/office/operators", Some(new_operator(" 0042 ")))
        .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let id = created["id"].as_str().unwrap().to_owned();
    assert_eq!(
        created,
        json!({
            "id": id, "login": "0042", "name": "Анна Кузнецова", "role": "Упаковщик",
            "active": true, "hasPin": true, "badges": [], "rev": 2
        })
    );
    assert_eq!(
        audit_trail(&admin.app, "operator.create").await,
        vec![admin.row(
            "operator.create",
            "operator",
            &id,
            json!({ "login": "0042", "role": "Упаковщик" })
        )]
    );
    let (status, list) = admin.call("GET", "/v1/office/operators", None).await;
    assert_eq!((status, list.clone()), (StatusCode::OK, json!([created])));
    assert!(
        !list.to_string().contains("pbkdf2"),
        "the office never gets a hash back"
    );
    // The station gets the operator with the PIN hash.
    assert_eq!(
        feed(&admin, 1).await,
        json!([{
            "entity": "operators", "id": id, "rev": 2, "deleted": false,
            "data": { "login": "0042", "name": "Анна Кузнецова", "role": "Упаковщик", "pinPhc": PIN_4821 }
        }])
    );
}

#[tokio::test]
async fn operator_fields_are_checked() {
    let admin = admin().await;
    for login in ["12", "1234567890123", "12a4", "٠١٢٣"] {
        let (status, body) = admin
            .call("POST", "/v1/office/operators", Some(new_operator(login)))
            .await;
        assert_eq!(
            (status, field(&body)),
            (StatusCode::BAD_REQUEST, json!("login")),
            "{login}"
        );
    }
    let mut blank_name = new_operator("0042");
    blank_name["name"] = json!(" ");
    let mut long_role = new_operator("0042");
    long_role["role"] = json!("м".repeat(121));
    for (body, expected) in [(blank_name, "name"), (long_role, "role")] {
        let (status, error) = admin.call("POST", "/v1/office/operators", Some(body)).await;
        assert_eq!(
            (status, field(&error)),
            (StatusCode::BAD_REQUEST, json!(expected))
        );
    }
    let mut raw_pin = new_operator("0042");
    raw_pin["pin"] = json!("4821");
    let (status, error) = admin
        .call("POST", "/v1/office/operators", Some(raw_pin))
        .await;
    assert_eq!(
        (status, error["error"]["code"].clone()),
        (StatusCode::BAD_REQUEST, json!("validation_failed"))
    );
    assert!(audit_trail(&admin.app, "operator.create").await.is_empty());

    // A blank role is no role.
    let mut blank_role = new_operator("0042");
    blank_role["role"] = json!("  ");
    let (status, created) = admin
        .call("POST", "/v1/office/operators", Some(blank_role))
        .await;
    assert_eq!(
        (status, created["role"].clone()),
        (StatusCode::OK, Value::Null)
    );
}

#[tokio::test]
async fn pin_hashes_must_be_domain_phc_strings_within_the_iteration_bounds() {
    let admin = admin().await;
    for pin_phc in [
        "4821".to_owned(),
        pin(9_999, 1),
        pin(1_000_001, 1),
        PIN_4821.replace("==", "="),
        format!("{PIN_4821}$x"),
    ] {
        let mut body = new_operator("0042");
        body["pinPhc"] = json!(pin_phc);
        let (status, error) = admin.call("POST", "/v1/office/operators", Some(body)).await;
        assert_eq!(
            (status, field(&error)),
            (StatusCode::BAD_REQUEST, json!("pinPhc")),
            "{pin_phc}"
        );
    }
    let mut body = new_operator("0042");
    body["pinPhc"] = json!(pin(1_000_000, 1));
    let (status, created) = admin.call("POST", "/v1/office/operators", Some(body)).await;
    assert_eq!(status, StatusCode::OK, "{created}");
    // A new PIN meets the same bounds.
    let (status, error) = admin
        .call(
            "PUT",
            &format!("/v1/office/operators/{}", created["id"].as_str().unwrap()),
            Some(json!({ "pinPhc": pin(1_000_001, 2), "expectedRev": 2 })),
        )
        .await;
    assert_eq!(
        (status, field(&error)),
        (StatusCode::BAD_REQUEST, json!("pinPhc"))
    );
}

#[tokio::test]
async fn personnel_numbers_are_unique_with_their_leading_zeros() {
    let admin = admin().await;
    create(&admin).await;
    let (status, body) = admin
        .call("POST", "/v1/office/operators", Some(new_operator("0042")))
        .await;
    assert_eq!(
        (status, body["error"]["details"]["constraint"].clone()),
        (StatusCode::CONFLICT, json!("login"))
    );
    assert_eq!(host_revision(&admin.app).await, 2);
    // Leading zeros are part of the number: 042 is another operator.
    let (status, other) = admin
        .call("POST", "/v1/office/operators", Some(new_operator("042")))
        .await;
    assert_eq!(status, StatusCode::OK, "{other}");
    assert_eq!(audit_trail(&admin.app, "operator.create").await.len(), 2);
}

#[tokio::test]
async fn an_update_names_the_changed_fields_and_never_the_pin_hash() {
    let admin = admin().await;
    let id = create(&admin).await;
    let path = format!("/v1/office/operators/{id}");
    let new_pin = pin(100_000, 7);
    let (status, updated) = admin
        .call(
            "PUT",
            &path,
            Some(json!({ "name": "Анна Петрова", "role": null, "pinPhc": new_pin, "expectedRev": 2 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{updated}");
    assert_eq!(
        updated,
        json!({
            "id": id, "login": "0042", "name": "Анна Петрова", "role": null,
            "active": true, "hasPin": true, "badges": [], "rev": 3
        })
    );
    assert_eq!(
        audit_trail(&admin.app, "operator.update").await,
        vec![admin.row(
            "operator.update",
            "operator",
            &id,
            json!({
                "changed": ["name", "role", "pinPhc"],
                "name": { "from": "Анна Кузнецова", "to": "Анна Петрова" },
                "role": { "from": "Упаковщик", "to": null }
            })
        )]
    );
    // The station replaces the hash, so the old PIN stops working there.
    assert_eq!(
        feed(&admin, 2).await,
        json!([{
            "entity": "operators", "id": id, "rev": 3, "deleted": false,
            "data": { "login": "0042", "name": "Анна Петрова", "role": null, "pinPhc": new_pin }
        }])
    );

    // An absent field keeps its value; the same values change nothing.
    let (status, same) = admin
        .call(
            "PUT",
            &path,
            Some(json!({ "name": "Анна Петрова", "pinPhc": new_pin, "expectedRev": 3 })),
        )
        .await;
    assert_eq!((status, same), (StatusCode::OK, updated));
    assert_eq!(host_revision(&admin.app).await, 3);
    assert_eq!(audit_trail(&admin.app, "operator.update").await.len(), 1);
    // An old revision is refused.
    let (status, body) = admin
        .call(
            "PUT",
            &path,
            Some(json!({ "role": "Мастер", "expectedRev": 2 })),
        )
        .await;
    assert_eq!(
        (
            status,
            body["error"]["code"].clone(),
            body["error"]["details"]["currentRev"].clone()
        ),
        (StatusCode::CONFLICT, json!("stale_revision"), json!(3))
    );
}

#[tokio::test]
async fn deactivation_sends_a_tombstone_and_reactivation_the_record_again() {
    let admin = admin().await;
    let id = create(&admin).await;
    let path = format!("/v1/office/operators/{id}");
    let (status, off) = admin
        .call(
            "PUT",
            &path,
            Some(json!({ "active": false, "expectedRev": 2 })),
        )
        .await;
    assert_eq!(
        (status, off["active"].clone(), off["rev"].clone()),
        (StatusCode::OK, json!(false), json!(3))
    );
    let gone = json!([{ "entity": "operators", "id": id, "rev": 3, "deleted": true }]);
    assert_eq!(feed(&admin, 2).await, gone);
    // A station syncing from zero never gets the record.
    assert_eq!(feed(&admin, 1).await, gone);
    // The office still lists the operator, inactive.
    let (_, list) = admin.call("GET", "/v1/office/operators", None).await;
    assert_eq!(list, json!([off]));

    let (status, on) = admin
        .call(
            "PUT",
            &path,
            Some(json!({ "active": true, "expectedRev": 3 })),
        )
        .await;
    assert_eq!(
        (status, on["active"].clone(), on["rev"].clone()),
        (StatusCode::OK, json!(true), json!(4))
    );
    let back = json!([{
        "entity": "operators", "id": id, "rev": 4, "deleted": false,
        "data": { "login": "0042", "name": "Анна Кузнецова", "role": "Упаковщик", "pinPhc": PIN_4821 }
    }]);
    assert_eq!(feed(&admin, 3).await, back);
    assert_eq!(feed(&admin, 1).await, back, "the tombstone is gone");
    assert_eq!(
        audit_trail(&admin.app, "operator.update").await,
        vec![
            admin.row(
                "operator.update",
                "operator",
                &id,
                json!({ "changed": ["active"], "active": { "from": true, "to": false } })
            ),
            admin.row(
                "operator.update",
                "operator",
                &id,
                json!({ "changed": ["active"], "active": { "from": false, "to": true } })
            ),
        ]
    );
}

#[tokio::test]
async fn technologists_have_no_access_to_operators() {
    let admin = admin().await;
    let id = create(&admin).await;
    let tech = admin.technologist().await;
    for (method, path, body) in [
        ("GET", "/v1/office/operators".to_owned(), None),
        (
            "POST",
            "/v1/office/operators".to_owned(),
            Some(new_operator("0043")),
        ),
        (
            "PUT",
            format!("/v1/office/operators/{id}"),
            Some(json!({ "active": false, "expectedRev": 2 })),
        ),
    ] {
        let (status, error) = admin.call_as(&tech, method, &path, body).await;
        assert_eq!(
            (status, error["error"]["code"].clone()),
            (StatusCode::FORBIDDEN, json!("forbidden")),
            "{method} {path}"
        );
    }
    assert_eq!(audit_trail(&admin.app, "operator.create").await.len(), 1);
    assert!(audit_trail(&admin.app, "operator.update").await.is_empty());
}

#[tokio::test]
async fn an_unknown_operator_is_not_found_once_its_body_is_valid() {
    let admin = admin().await;
    let path = "/v1/office/operators/9b2e4a6c-0000-4000-8000-000000000000";
    let (status, body) = admin
        .call("PUT", path, Some(json!({ "name": " ", "expectedRev": 1 })))
        .await;
    assert_eq!(
        (status, field(&body)),
        (StatusCode::BAD_REQUEST, json!("name"))
    );
    let (status, body) = admin
        .call(
            "PUT",
            path,
            Some(json!({ "active": false, "expectedRev": 1 })),
        )
        .await;
    assert_eq!(
        (status, body["error"]["code"].clone()),
        (StatusCode::NOT_FOUND, json!("not_found"))
    );
}
