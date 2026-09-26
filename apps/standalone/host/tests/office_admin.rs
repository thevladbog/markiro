mod support;

use std::time::Duration;

use axum::http::StatusCode;
use markiro_host::secrets::{key_hash, verify_password};
use serde_json::{json, Value};
use support::app::{
    bootstrap, empty, json as json_request, login, pair_device, request, with_session, TestApp,
};

struct Admin {
    app: TestApp,
    key: String,
    token: String,
    id: String,
}

async fn admin() -> Admin {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "station").await;
    let token = bootstrap(&app, &key).await;
    let (status, me) = app
        .send(empty(with_session(
            request("GET", "/v1/office/me"),
            &key,
            &token,
        )))
        .await;
    assert_eq!(status, StatusCode::OK, "{me}");
    let id = me["id"].as_str().unwrap().to_owned();
    Admin {
        app,
        key,
        token,
        id,
    }
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

/// The current global `host_revision.rev`.
async fn host_revision(admin: &Admin) -> i64 {
    sqlx::query_scalar("SELECT rev FROM host_revision WHERE id = 1")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap()
}

/// How many audit rows exist for `action`/`target_id`; used to prove a no-op
/// write did not add one.
async fn audit_count(admin: &Admin, action: &str, target_id: &str) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM audit_log WHERE action = ? AND target_id = ?")
        .bind(action)
        .bind(target_id)
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap()
}

/// Assert the single audit row for `action`/`target_id` matches exactly: the
/// signed-in administrator as actor, outcome "ok", the given target type, and
/// `details`. The repo rule and the plan constraint both require the exact
/// tuple, not just that a row exists.
async fn assert_audit(
    admin: &Admin,
    action: &str,
    target_type: &str,
    target_id: &str,
    details: Value,
) {
    assert_eq!(
        audit_count(admin, action, target_id).await,
        1,
        "expected exactly one audit row for {action}/{target_id}"
    );
    type Row = (
        String,
        Option<String>,
        String,
        Option<String>,
        Option<String>,
        String,
        String,
    );
    let (actor_kind, actor_id, action_col, target_type_col, target_id_col, result, details_text): Row =
        sqlx::query_as(
            "SELECT actor_kind, actor_id, action, target_type, target_id, result, details \
             FROM audit_log WHERE action = ? AND target_id = ?",
        )
        .bind(action)
        .bind(target_id)
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    let details_value: Value = serde_json::from_str(&details_text).unwrap();
    assert_eq!(
        (
            actor_kind.as_str(),
            actor_id.as_deref(),
            action_col.as_str(),
            target_type_col.as_deref(),
            target_id_col.as_deref(),
            result.as_str(),
            details_value,
        ),
        (
            "office_user",
            Some(admin.id.as_str()),
            action,
            Some(target_type),
            Some(target_id),
            "ok",
            details,
        ),
        "audit row for {action}/{target_id}"
    );
}

#[tokio::test]
async fn sscc_counters_move_only_forward_within_capacity() {
    let admin = admin().await;
    let (status, state) = admin.call("GET", "/v1/office/sscc", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(state["boxBlockSize"], 2000);
    assert_eq!(state["palletBlockSize"], 200);
    assert_eq!(state["currentIssuerPrefix"], "460068200");
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
    assert_eq!(body["error"]["details"]["minSerial"], 1500);
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
    assert_eq!(body["error"]["details"]["currentRev"], rev);

    // None of the failed attempts above touched anything: the global
    // revision is still exactly what bootstrap left it at.
    let rev_before_move = host_revision(&admin).await;
    assert_eq!(
        rev_before_move, 1,
        "the conflict, validation and stale-revision attempts above must not bump the global revision"
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
    let moved_rev = body["rev"].as_i64().unwrap();
    assert_eq!(moved_rev, rev_before_move + 1);
    assert_eq!(host_revision(&admin).await, moved_rev);
    assert_audit(
        &admin,
        "sscc.counter.update",
        "sscc_counter",
        "460068200/0",
        json!({ "from": 1500, "to": 2000 }),
    )
    .await;

    // Read back through GET: the moved counter and the global revision agree.
    let (status, state_after) = admin.call("GET", "/v1/office/sscc", None).await;
    assert_eq!(status, StatusCode::OK);
    let moved_counter = state_after["counters"]
        .as_array()
        .unwrap()
        .iter()
        .find(|counter| counter["extension"] == 0)
        .unwrap();
    assert_eq!(moved_counter["nextSerial"], 2000);
    assert_eq!(
        moved_counter["rev"].as_i64().unwrap(),
        host_revision(&admin).await
    );

    // A no-op PUT (the same next serial) changes nothing.
    let audit_rows_before_noop = audit_count(&admin, "sscc.counter.update", "460068200/0").await;
    let (status, body) = admin
        .call(
            "PUT",
            path,
            Some(json!({ "nextSerial": 2000, "expectedRev": moved_rev })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["rev"].as_i64().unwrap(), moved_rev);
    assert_eq!(
        host_revision(&admin).await,
        moved_rev,
        "a no-op must not bump the revision"
    );
    assert_eq!(
        audit_count(&admin, "sscc.counter.update", "460068200/0").await,
        audit_rows_before_noop,
        "a no-op must not write a new audit row"
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

    // The top of the valid range for this 9-digit prefix is still accepted.
    let (status, body) = admin
        .call(
            "PUT",
            path,
            Some(json!({ "nextSerial": 9_999_999, "expectedRev": moved_rev })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["nextSerial"], 9_999_999);
}

#[tokio::test]
async fn block_sizes_are_validated_and_versioned() {
    let admin = admin().await;
    let (_, state) = admin.call("GET", "/v1/office/sscc", None).await;
    let rev = state["blockSizesRev"].as_i64().unwrap();
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

    let rev_before = host_revision(&admin).await;
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
    let new_rev = body["blockSizesRev"].as_i64().unwrap();
    assert_eq!(new_rev, rev_before + 1);
    assert_eq!(host_revision(&admin).await, new_rev);
    assert_audit(
        &admin,
        "sscc.block_sizes.update",
        "site",
        "1",
        json!({ "boxBlockSize": 5000, "palletBlockSize": 500 }),
    )
    .await;

    // A no-op PUT (the same sizes) changes nothing.
    let audit_rows_before_noop = audit_count(&admin, "sscc.block_sizes.update", "1").await;
    let (status, body) = admin
        .call(
            "PUT",
            "/v1/office/sscc/block-sizes",
            Some(json!({ "boxBlockSize": 5000, "palletBlockSize": 500, "expectedRev": new_rev })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["blockSizesRev"].as_i64().unwrap(), new_rev);
    assert_eq!(
        host_revision(&admin).await,
        new_rev,
        "a no-op must not bump the revision"
    );
    assert_eq!(
        audit_count(&admin, "sscc.block_sizes.update", "1").await,
        audit_rows_before_noop,
        "a no-op must not write a new audit row"
    );
}

/// Regression for the pool-exhaustion bug: `put_block_sizes` must read its
/// response through the open write transaction, never by taking a second
/// connection from `state.pool`. The pool has 4 connections; holding 3 here
/// leaves exactly one spare, which the request's own write transaction takes.
/// The old no-op path additionally called `state.pool.acquire()` for its
/// read and would then wait behind the held connections until they were
/// released — past the 5-second timeout used here.
#[tokio::test]
async fn block_size_updates_do_not_wait_on_a_second_pooled_connection() {
    let admin = admin().await;
    let (_, state) = admin.call("GET", "/v1/office/sscc", None).await;
    let rev = state["blockSizesRev"].as_i64().unwrap();

    let held = [
        admin.app.state.pool.acquire().await.unwrap(),
        admin.app.state.pool.acquire().await.unwrap(),
        admin.app.state.pool.acquire().await.unwrap(),
    ];

    let (status, body) = tokio::time::timeout(
        Duration::from_secs(5),
        admin.call(
            "PUT",
            "/v1/office/sscc/block-sizes",
            Some(json!({ "boxBlockSize": 2000, "palletBlockSize": 200, "expectedRev": rev })),
        ),
    )
    .await
    .expect("a no-op block-size update must not wait for a pooled connection");
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["blockSizesRev"].as_i64().unwrap(), rev);

    let (status, body) = tokio::time::timeout(
        Duration::from_secs(5),
        admin.call(
            "PUT",
            "/v1/office/sscc/block-sizes",
            Some(json!({ "boxBlockSize": 3000, "palletBlockSize": 300, "expectedRev": rev })),
        ),
    )
    .await
    .expect("a changing block-size update must not wait for a pooled connection");
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["boxBlockSize"], 3000);

    drop(held);
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
    let tech_id = created["id"].as_str().unwrap().to_owned();
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

    let (status, body) = admin
        .app
        .send(json_request(
            tech("POST", "/v1/office/users"),
            json!({ "login": "another", "name": "Ещё", "role": "technologist", "password": "correct horse battery" }),
        ))
        .await;
    assert_eq!(
        (status, body["error"]["code"].clone()),
        (StatusCode::FORBIDDEN, json!("forbidden"))
    );

    let (status, body) = admin
        .app
        .send(json_request(
            tech("PUT", &format!("/v1/office/users/{tech_id}")),
            json!({ "name": "Павел", "role": "technologist", "active": true, "expectedRev": 1 }),
        ))
        .await;
    assert_eq!(
        (status, body["error"]["code"].clone()),
        (StatusCode::FORBIDDEN, json!("forbidden"))
    );

    let (status, body) = admin
        .app
        .send(json_request(
            tech("PUT", &format!("/v1/office/users/{tech_id}/password")),
            json!({ "password": "another long password" }),
        ))
        .await;
    assert_eq!(
        (status, body["error"]["code"].clone()),
        (StatusCode::FORBIDDEN, json!("forbidden"))
    );

    let (status, body) = admin
        .app
        .send(json_request(
            tech("PUT", "/v1/office/sscc/block-sizes"),
            json!({ "boxBlockSize": 2000, "palletBlockSize": 200, "expectedRev": 1 }),
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
    assert_audit(
        &admin,
        "office_user.create",
        "office_user",
        &tech_id,
        json!({ "login": "Tech", "role": "technologist" }),
    )
    .await;

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

    // Deactivating the sole admin (role unchanged) is blocked the same way,
    // and the user must stay active.
    let (status, body) = admin
        .call(
            "PUT",
            &admin_path,
            Some(
                json!({ "name": "Ирина", "role": "admin", "active": false, "expectedRev": admin_record["rev"] }),
            ),
        )
        .await;
    assert_eq!(
        (status, body["error"]["code"].clone()),
        (StatusCode::CONFLICT, json!("last_admin"))
    );
    let (_, list_after_guard) = admin.call("GET", "/v1/office/users", None).await;
    let admin_still = list_after_guard
        .as_array()
        .unwrap()
        .iter()
        .find(|user| user["login"] == "admin")
        .unwrap()
        .clone();
    assert_eq!(
        admin_still["active"], true,
        "the last admin must stay active"
    );
    assert_eq!(
        admin_still["rev"], admin_record["rev"],
        "a blocked update must not bump the revision"
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
    assert_audit(
        &admin,
        "office_user.update",
        "office_user",
        &tech_id,
        json!({ "changed": ["role"] }),
    )
    .await;

    // A no-op PUT (identical values) changes nothing.
    let promoted_rev = promoted["rev"].as_i64().unwrap();
    let host_rev_before_noop = host_revision(&admin).await;
    let audit_rows_before_noop = audit_count(&admin, "office_user.update", &tech_id).await;
    let (status, unchanged) = admin
        .call(
            "PUT",
            &tech_path,
            Some(
                json!({ "name": "Павел Орлов", "role": "admin", "active": true, "expectedRev": promoted_rev }),
            ),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{unchanged}");
    assert_eq!(unchanged["rev"].as_i64().unwrap(), promoted_rev);
    assert_eq!(
        host_revision(&admin).await,
        host_rev_before_noop,
        "a no-op must not bump the revision"
    );
    assert_eq!(
        audit_count(&admin, "office_user.update", &tech_id).await,
        audit_rows_before_noop,
        "a no-op must not write a new audit row"
    );

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

    // A bystander: a second technologist, unrelated to `tech`. Neither the
    // password change nor the deactivation below must touch their session.
    let (_, second) = admin
        .call(
            "POST",
            "/v1/office/users",
            Some(
                json!({ "login": "second", "name": "Ольга", "role": "technologist", "password": "correct horse battery" }),
            ),
        )
        .await;
    let second_id = second["id"].as_str().unwrap().to_owned();
    let second_token = login(&admin.app, &admin.key, "second", "correct horse battery").await;

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
    assert_audit(
        &admin,
        "office_user.password",
        "office_user",
        &tech_id,
        json!({}),
    )
    .await;

    // The bystander's session is untouched by tech's password change.
    let (status, _) = admin
        .app
        .send(empty(with_session(
            request("GET", "/v1/office/me"),
            &admin.key,
            &second_token,
        )))
        .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "an unrelated user's session must survive another user's password change"
    );
    let bystander_sessions_after_password_change: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM office_sessions WHERE user_id = ?")
            .bind(&second_id)
            .fetch_one(&admin.app.state.pool)
            .await
            .unwrap();
    assert_eq!(bystander_sessions_after_password_change, 1);

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

    // The deactivation itself must delete the sessions, not merely rely on
    // `OfficeContext`'s lazy expiry check the next time someone uses one.
    let remaining_sessions: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM office_sessions WHERE user_id = ?")
            .bind(&tech_id)
            .fetch_one(&admin.app.state.pool)
            .await
            .unwrap();
    assert_eq!(
        remaining_sessions, 0,
        "deactivation must delete the user's sessions directly"
    );

    let (status, _) = admin
        .app
        .send(empty(with_session(
            request("GET", "/v1/office/me"),
            &admin.key,
            &tech_token,
        )))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    // The bystander's session also survives tech's deactivation.
    let (status, _) = admin
        .app
        .send(empty(with_session(
            request("GET", "/v1/office/me"),
            &admin.key,
            &second_token,
        )))
        .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "an unrelated user's session must survive another user's deactivation"
    );
    let bystander_sessions_after_deactivation: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM office_sessions WHERE user_id = ?")
            .bind(&second_id)
            .fetch_one(&admin.app.state.pool)
            .await
            .unwrap();
    assert_eq!(bystander_sessions_after_deactivation, 1);
}

#[tokio::test]
async fn admin_changing_their_own_password_keeps_the_callers_session() {
    let admin = admin().await;
    // A second device, signed in as the same administrator.
    let (_, second_device_key) = pair_device(&admin.app, "office").await;
    let second_token = login(
        &admin.app,
        &second_device_key,
        "admin",
        "correct horse battery",
    )
    .await;

    let (status, _) = admin
        .call(
            "PUT",
            &format!("/v1/office/users/{}/password", admin.id),
            Some(json!({ "password": "a brand new admin password" })),
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    let (status, _) = admin.call("GET", "/v1/office/me", None).await;
    assert_eq!(
        status,
        StatusCode::OK,
        "the caller's own session must survive"
    );

    let (status, _) = admin
        .app
        .send(empty(with_session(
            request("GET", "/v1/office/me"),
            &second_device_key,
            &second_token,
        )))
        .await;
    assert_eq!(
        status,
        StatusCode::UNAUTHORIZED,
        "the other device's session must end"
    );
    let remaining: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM office_sessions WHERE token_hash = ?")
            .bind(key_hash(&second_token))
            .fetch_one(&admin.app.state.pool)
            .await
            .unwrap();
    assert_eq!(remaining, 0, "the other device's session row must be gone");
}

/// `require_admin_in` re-reads the caller's session and role inside the
/// transaction, not the (possibly stale) values the `OfficeContext` extractor
/// captured before the request began hashing a password. Built directly
/// against the auth API, bypassing HTTP, so the scenario is deterministic:
/// no race against a concurrent hashing request is needed to prove the
/// recheck runs.
#[tokio::test]
async fn require_admin_in_rechecks_role_and_session_inside_the_transaction() {
    use axum::response::IntoResponse;
    use http_body_util::BodyExt;
    use markiro_host::auth::OfficeContext;
    use markiro_proto::{OfficeRole, OfficeUser};

    async fn error_body(error: markiro_host::error::ApiError) -> (StatusCode, Value) {
        let response = error.into_response();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (status, serde_json::from_slice(&bytes).unwrap())
    }

    let admin = admin().await;
    let session_id: String = sqlx::query_scalar("SELECT id FROM office_sessions WHERE user_id = ?")
        .bind(&admin.id)
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    let context = OfficeContext {
        device_id: "unused-by-require-admin-in".to_owned(),
        session_id: session_id.clone(),
        user: OfficeUser {
            id: admin.id.clone(),
            login: "admin".to_owned(),
            name: "Ирина Смирнова".to_owned(),
            role: OfficeRole::Admin,
        },
    };

    // 1. The user was demoted after the extractor ran (e.g. by another admin,
    //    while this request was still hashing a password): the transaction
    //    must see the fresh role and refuse the write with 403, not the
    //    "still an admin" the extractor captured.
    sqlx::query("UPDATE office_users SET role = 'technologist' WHERE id = ?")
        .bind(&admin.id)
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    let mut tx = markiro_host::db::begin_write(&admin.app.state.pool)
        .await
        .unwrap();
    let error = context.require_admin_in(&mut tx).await.unwrap_err();
    tx.rollback().await.unwrap();
    let (status, body) = error_body(error).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["error"]["code"], "forbidden");

    sqlx::query("UPDATE office_users SET role = 'admin' WHERE id = ?")
        .bind(&admin.id)
        .execute(&admin.app.state.pool)
        .await
        .unwrap();

    // 2. The user was deactivated after the extractor ran; the session row
    //    itself still exists, so the join finds it, but the fresh `active =
    //    0` must still refuse with the same session-credential 401 an
    //    inactive user gets anywhere else.
    sqlx::query("UPDATE office_users SET active = 0 WHERE id = ?")
        .bind(&admin.id)
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    let mut tx = markiro_host::db::begin_write(&admin.app.state.pool)
        .await
        .unwrap();
    let error = context.require_admin_in(&mut tx).await.unwrap_err();
    tx.rollback().await.unwrap();
    let (status, body) = error_body(error).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"]["code"], "unauthorized");
    assert_eq!(body["error"]["details"]["credential"], "session");

    sqlx::query("UPDATE office_users SET active = 1 WHERE id = ?")
        .bind(&admin.id)
        .execute(&admin.app.state.pool)
        .await
        .unwrap();

    // 3. The session was ended after the extractor ran (e.g. a logout from
    //    another request racing this one): the transaction finds no row and
    //    refuses with a session-credential 401.
    sqlx::query("DELETE FROM office_sessions WHERE id = ?")
        .bind(&session_id)
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    let mut tx = markiro_host::db::begin_write(&admin.app.state.pool)
        .await
        .unwrap();
    let error = context.require_admin_in(&mut tx).await.unwrap_err();
    tx.rollback().await.unwrap();
    let (status, body) = error_body(error).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"]["code"], "unauthorized");
    assert_eq!(body["error"]["details"]["credential"], "session");
}
