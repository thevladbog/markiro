mod support;

use axum::http::StatusCode;
use markiro_host::secrets::verify_password;
use serde_json::{json, Value};
use support::app::{
    bootstrap, empty, json as json_request, login, pair_device, request, with_session, TestApp,
};

struct Admin {
    app: TestApp,
    key: String,
    token: String,
}

async fn admin() -> Admin {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "station").await;
    let token = bootstrap(&app, &key).await;
    Admin { app, key, token }
}

impl Admin {
    async fn call(&self, method: &str, path: &str, body: Option<Value>) -> (StatusCode, Value) {
        let builder = with_session(request(method, path), &self.key, &self.token);
        match body {
            Some(body) => self.app.send(json_request(builder, body)).await,
            None => self.app.send(empty(builder)).await,
        }
    }
}

#[tokio::test]
async fn sscc_counters_move_only_forward_within_capacity() {
    let admin = admin().await;
    let (status, state) = admin.call("GET", "/v1/office/sscc", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(state["boxBlockSize"], 2000);
    assert_eq!(state["palletBlockSize"], 200);
    let counter = &state["counters"][0];
    assert_eq!(counter["issuerPrefix"], "460068200");
    assert_eq!(counter["extension"], 0);
    assert_eq!(counter["nextSerial"], 1500);
    assert_eq!(counter["maxSerial"], 9_999_999);
    let rev = counter["rev"].as_i64().unwrap();

    let path = "/v1/office/sscc/counters/460068200/0";
    let (status, body) = admin
        .call(
            "PUT",
            path,
            Some(json!({ "nextSerial": 1499, "expectedRev": rev })),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["error"]["code"], "sscc_below_floor");
    assert_eq!(body["error"]["details"]["currentNextSerial"], 1500);
    let (status, body) = admin
        .call(
            "PUT",
            path,
            Some(json!({ "nextSerial": 10_000_000, "expectedRev": rev })),
        )
        .await;
    assert_eq!(
        (status, body["error"]["details"]["field"].clone()),
        (StatusCode::BAD_REQUEST, json!("nextSerial"))
    );
    let (status, body) = admin
        .call(
            "PUT",
            path,
            Some(json!({ "nextSerial": 2000, "expectedRev": rev - 1 })),
        )
        .await;
    assert_eq!(
        (status, body["error"]["code"].clone()),
        (StatusCode::CONFLICT, json!("stale_revision"))
    );

    let (status, body) = admin
        .call(
            "PUT",
            path,
            Some(json!({ "nextSerial": 2000, "expectedRev": rev })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["nextSerial"], 2000);
    assert!(body["rev"].as_i64().unwrap() > rev);
    let details: String = sqlx::query_scalar(
        "SELECT details FROM audit_log WHERE action = 'sscc.counter.update' AND target_id = '460068200/0'",
    )
    .fetch_one(&admin.app.state.pool)
    .await
    .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&details).unwrap(),
        json!({ "from": 1500, "to": 2000 })
    );

    let (status, body) = admin
        .call(
            "PUT",
            "/v1/office/sscc/counters/999999999/0",
            Some(json!({ "nextSerial": 5, "expectedRev": 1 })),
        )
        .await;
    assert_eq!(
        (status, body["error"]["code"].clone()),
        (StatusCode::NOT_FOUND, json!("not_found"))
    );
    let (status, _) = admin
        .call(
            "PUT",
            "/v1/office/sscc/counters/460068200/x",
            Some(json!({ "nextSerial": 5, "expectedRev": 1 })),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn block_sizes_are_validated_and_versioned() {
    let admin = admin().await;
    let (_, state) = admin.call("GET", "/v1/office/sscc", None).await;
    let rev = state["rev"].as_i64().unwrap();
    let (status, body) = admin
        .call(
            "PUT",
            "/v1/office/sscc/block-sizes",
            Some(json!({ "boxBlockSize": 0, "palletBlockSize": 200, "expectedRev": rev })),
        )
        .await;
    assert_eq!(
        (status, body["error"]["details"]["field"].clone()),
        (StatusCode::BAD_REQUEST, json!("boxBlockSize"))
    );
    let (status, body) = admin
        .call(
            "PUT",
            "/v1/office/sscc/block-sizes",
            Some(json!({ "boxBlockSize": 5000, "palletBlockSize": 500, "expectedRev": rev })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        (
            body["boxBlockSize"].clone(),
            body["palletBlockSize"].clone()
        ),
        (json!(5000), json!(500))
    );
    assert!(body["rev"].as_i64().unwrap() > rev);
}

#[tokio::test]
async fn technologists_cannot_administer() {
    let admin = admin().await;
    let (status, created) = admin
        .call(
            "POST",
            "/v1/office/users",
            Some(
                json!({ "login": "tech", "name": "Павел", "role": "technologist", "password": "correct horse battery" }),
            ),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let tech_token = login(&admin.app, &admin.key, "tech", "correct horse battery").await;
    let tech =
        |method: &str, path: &str| with_session(request(method, path), &admin.key, &tech_token);

    assert_eq!(
        admin
            .app
            .send(empty(tech("GET", "/v1/office/sscc")))
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        admin
            .app
            .send(empty(tech("GET", "/v1/office/users")))
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    let (status, body) = admin
        .app
        .send(json_request(
            tech("PUT", "/v1/office/sscc/counters/460068200/0"),
            json!({ "nextSerial": 9000, "expectedRev": 1 }),
        ))
        .await;
    assert_eq!(
        (status, body["error"]["code"].clone()),
        (StatusCode::FORBIDDEN, json!("forbidden"))
    );
}

#[tokio::test]
async fn users_are_created_updated_and_the_last_admin_is_protected() {
    let admin = admin().await;
    let (status, created) = admin
        .call(
            "POST",
            "/v1/office/users",
            Some(
                json!({ "login": "Tech", "name": " Павел Орлов ", "role": "technologist", "password": "correct horse battery" }),
            ),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    assert_eq!(created["login"], "Tech");
    assert_eq!(created["name"], "Павел Орлов");
    assert_eq!(created["active"], true);
    let tech_id = created["id"].as_str().unwrap().to_owned();

    let (status, body) = admin
        .call(
            "POST",
            "/v1/office/users",
            Some(
                json!({ "login": "tech", "name": "Двойник", "role": "technologist", "password": "correct horse battery" }),
            ),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["error"]["details"]["constraint"], "login");

    let (_, list) = admin.call("GET", "/v1/office/users", None).await;
    let logins: Vec<&str> = list
        .as_array()
        .unwrap()
        .iter()
        .map(|user| user["login"].as_str().unwrap())
        .collect();
    assert_eq!(logins, vec!["admin", "Tech"]);
    let admin_record = list
        .as_array()
        .unwrap()
        .iter()
        .find(|user| user["login"] == "admin")
        .unwrap()
        .clone();

    let admin_path = format!("/v1/office/users/{}", admin_record["id"].as_str().unwrap());
    let (status, body) = admin
        .call(
            "PUT",
            &admin_path,
            Some(
                json!({ "name": "Ирина", "role": "technologist", "active": true, "expectedRev": admin_record["rev"] }),
            ),
        )
        .await;
    assert_eq!(
        (status, body["error"]["code"].clone()),
        (StatusCode::CONFLICT, json!("last_admin"))
    );

    let tech_path = format!("/v1/office/users/{tech_id}");
    let (status, promoted) = admin
        .call(
            "PUT",
            &tech_path,
            Some(
                json!({ "name": "Павел Орлов", "role": "admin", "active": true, "expectedRev": created["rev"] }),
            ),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{promoted}");
    assert_eq!(promoted["role"], "admin");
    let (status, _) = admin
        .call(
            "PUT",
            &admin_path,
            Some(
                json!({ "name": "Ирина", "role": "technologist", "active": true, "expectedRev": admin_record["rev"] }),
            ),
        )
        .await;
    assert_eq!(status, StatusCode::OK);

    let details: String = sqlx::query_scalar(
        "SELECT details FROM audit_log WHERE action = 'office_user.create' AND target_id = ?",
    )
    .bind(&tech_id)
    .fetch_one(&admin.app.state.pool)
    .await
    .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&details).unwrap(),
        json!({ "login": "Tech", "role": "technologist" })
    );
}

#[tokio::test]
async fn deactivation_and_password_changes_end_the_users_sessions() {
    let admin = admin().await;
    let (_, created) = admin
        .call(
            "POST",
            "/v1/office/users",
            Some(
                json!({ "login": "tech", "name": "Павел", "role": "technologist", "password": "correct horse battery" }),
            ),
        )
        .await;
    let tech_id = created["id"].as_str().unwrap().to_owned();
    let tech_token = login(&admin.app, &admin.key, "tech", "correct horse battery").await;

    let (status, _) = admin
        .call(
            "PUT",
            &format!("/v1/office/users/{tech_id}/password"),
            Some(json!({ "password": "short" })),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, body) = admin
        .call(
            "PUT",
            &format!("/v1/office/users/{tech_id}/password"),
            Some(json!({ "password": "another long password" })),
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(body, Value::Null);
    let phc: String = sqlx::query_scalar("SELECT password_phc FROM office_users WHERE id = ?")
        .bind(&tech_id)
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    assert!(verify_password(&phc, "another long password"));
    let (status, _) = admin
        .app
        .send(empty(with_session(
            request("GET", "/v1/office/me"),
            &admin.key,
            &tech_token,
        )))
        .await;
    assert_eq!(
        status,
        StatusCode::UNAUTHORIZED,
        "the password change ends the session"
    );
    let details: String = sqlx::query_scalar(
        "SELECT details FROM audit_log WHERE action = 'office_user.password' AND target_id = ?",
    )
    .bind(&tech_id)
    .fetch_one(&admin.app.state.pool)
    .await
    .unwrap();
    assert_eq!(details, "{}");

    let tech_token = login(&admin.app, &admin.key, "tech", "another long password").await;
    let (_, list) = admin.call("GET", "/v1/office/users", None).await;
    let rev = list
        .as_array()
        .unwrap()
        .iter()
        .find(|user| user["id"] == tech_id)
        .unwrap()["rev"]
        .clone();
    let (status, _) = admin
        .call(
            "PUT",
            &format!("/v1/office/users/{tech_id}"),
            Some(
                json!({ "name": "Павел", "role": "technologist", "active": false, "expectedRev": rev }),
            ),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = admin
        .app
        .send(empty(with_session(
            request("GET", "/v1/office/me"),
            &admin.key,
            &tech_token,
        )))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}
