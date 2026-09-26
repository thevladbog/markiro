mod support;

use axum::http::StatusCode;
use markiro_host::secrets::verify_password;
use serde_json::{json, Value};
use support::app::{
    bootstrap, bootstrap_body, empty, json as json_request, login, pair_device, request,
    seed_office_user, with_device, with_session, TestApp, LAN,
};

#[tokio::test]
async fn the_wizard_initializes_the_host_and_signs_the_admin_in() {
    let app = TestApp::new().await;
    let (device_id, key) = pair_device(&app, "station").await;
    let (status, body) = app
        .send(json_request(
            with_device(request("POST", "/v1/bootstrap"), &key),
            bootstrap_body(),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let session = &body["session"];
    assert_eq!(session["user"]["login"], "admin");
    assert_eq!(session["user"]["role"], "admin");
    let admin_id = session["user"]["id"].as_str().unwrap().to_owned();

    let (initialized_at, salt, site_rev): (Option<String>, Option<Vec<u8>>, i64) =
        sqlx::query_as("SELECT initialized_at, badge_salt, rev FROM site WHERE id = 1")
            .fetch_one(&app.state.pool)
            .await
            .unwrap();
    assert_eq!(initialized_at, Some(app.state.timestamp()));
    assert_eq!(salt.map(|salt| salt.len()), Some(16));
    assert_eq!(site_rev, 1);

    let org: (String, Option<String>, String, String, String, i64) = sqlx::query_as(
        "SELECT name, inn, gln, gs1_prefixes, time_zone, rev FROM org_profile WHERE id = 1",
    )
    .fetch_one(&app.state.pool)
    .await
    .unwrap();
    assert_eq!(
        org,
        (
            "ООО «Атолл»".into(),
            Some("7701234567".into()),
            "4600682000010".into(),
            r#"["4600682"]"#.into(),
            "Europe/Moscow".into(),
            1
        )
    );
    let counters: Vec<(String, i64, i64, i64)> = sqlx::query_as(
        "SELECT issuer_prefix, extension, next_serial, rev FROM sscc_counters ORDER BY extension",
    )
    .fetch_all(&app.state.pool)
    .await
    .unwrap();
    assert_eq!(
        counters,
        vec![
            ("460068200".into(), 0, 1500, 1),
            ("460068200".into(), 1, 40, 1)
        ]
    );
    let lines: Vec<(String, String, i64, i64)> =
        sqlx::query_as("SELECT name, name_key, archived, rev FROM lines ORDER BY name")
            .fetch_all(&app.state.pool)
            .await
            .unwrap();
    assert_eq!(
        lines,
        vec![
            ("Линия 1".into(), "линия 1".into(), 0, 1),
            ("Линия 2".into(), "линия 2".into(), 0, 1)
        ]
    );

    let (phc, role, admin_rev): (String, String, i64) =
        sqlx::query_as("SELECT password_phc, role, rev FROM office_users WHERE id = ?")
            .bind(&admin_id)
            .fetch_one(&app.state.pool)
            .await
            .unwrap();
    assert!(verify_password(&phc, "correct horse battery"));
    assert_eq!(role, "admin");
    assert_eq!(admin_rev, 1);

    let (actor_kind, actor_id, action, target_type, target_id, result, details): (String, Option<String>, String, Option<String>, Option<String>, String, String) =
        sqlx::query_as(
            "SELECT actor_kind, actor_id, action, target_type, target_id, result, details FROM audit_log WHERE action = 'host.bootstrap'",
        )
        .fetch_one(&app.state.pool)
        .await
        .unwrap();
    assert_eq!(
        (
            actor_kind.as_str(),
            actor_id.as_deref(),
            target_type.as_deref(),
            target_id.as_deref(),
            result.as_str()
        ),
        (
            "device",
            Some(device_id.as_str()),
            Some("office_user"),
            Some(admin_id.as_str()),
            "ok"
        )
    );
    assert_eq!(action, "host.bootstrap");
    assert_eq!(
        serde_json::from_str::<Value>(&details).unwrap(),
        json!({ "adminLogin": "admin", "orgName": "ООО «Атолл»", "issuerPrefix": "460068200", "lineCount": 2 })
    );

    let token = session["token"].as_str().unwrap();
    let (status, me) = app
        .send(empty(with_session(
            request("GET", "/v1/office/me"),
            &key,
            token,
        )))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(me["id"], admin_id);
    let (_, hello) = app.send(empty(request("GET", "/v1/hello"))).await;
    assert_eq!(hello["initialized"], true);
}

#[tokio::test]
async fn the_wizard_runs_once_from_loopback_with_a_device() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "station").await;

    let (status, body) = app
        .send_from(
            LAN,
            json_request(
                with_device(request("POST", "/v1/bootstrap"), &key),
                bootstrap_body(),
            ),
        )
        .await;
    assert_eq!(
        (status, body["error"]["code"].clone()),
        (StatusCode::FORBIDDEN, json!("loopback_only"))
    );
    let (status, _) = app
        .send(json_request(
            request("POST", "/v1/bootstrap"),
            bootstrap_body(),
        ))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    bootstrap(&app, &key).await;
    let (status, body) = app
        .send(json_request(
            with_device(request("POST", "/v1/bootstrap"), &key),
            bootstrap_body(),
        ))
        .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["error"]["code"], "already_initialized");
    let users: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM office_users")
        .fetch_one(&app.state.pool)
        .await
        .unwrap();
    assert_eq!(users, 1);
}

#[tokio::test]
async fn concurrent_wizards_initialize_exactly_once() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "station").await;
    let send = || {
        app.send(json_request(
            with_device(request("POST", "/v1/bootstrap"), &key),
            bootstrap_body(),
        ))
    };
    let (first, second) = tokio::join!(send(), send());
    let mut statuses = [first.0, second.0];
    statuses.sort();
    assert_eq!(statuses, [StatusCode::OK, StatusCode::CONFLICT]);
}

#[tokio::test]
async fn invalid_wizard_input_names_the_field() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "station").await;
    let cases: [(&str, Value, &str); 12] = [
        ("/admin/login", json!("ад"), "admin.login"),
        ("/admin/name", json!("  "), "admin.name"),
        ("/admin/password", json!("short"), "admin.password"),
        ("/org/name", json!(""), "org.name"),
        ("/org/inn", json!("12345"), "org.inn"),
        ("/org/gln", json!("460068200001"), "org.gln"),
        ("/org/gs1Prefixes", json!(["12"]), "org.gs1Prefixes"),
        ("/sscc/boxNextSerial", json!(0), "sscc.boxNextSerial"),
        (
            "/sscc/palletNextSerial",
            json!(10_000_000),
            "sscc.palletNextSerial",
        ),
        ("/lines", json!([]), "lines"),
        ("/lines", json!(["  "]), "lines.0"),
        ("/lines", json!(["Линия 1", " линия 1 "]), "lines.1"),
    ];
    for (pointer, value, field) in cases {
        let mut body = bootstrap_body();
        *body.pointer_mut(pointer).unwrap() = value;
        let (status, response) = app
            .send(json_request(
                with_device(request("POST", "/v1/bootstrap"), &key),
                body,
            ))
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{field}");
        assert_eq!(response["error"]["code"], "validation_failed", "{field}");
        assert_eq!(response["error"]["details"]["field"], field, "{field}");
    }
    let (_, hello) = app.send(empty(request("GET", "/v1/hello"))).await;
    assert_eq!(hello["initialized"], false);
}

#[tokio::test]
async fn the_org_profile_is_read_by_all_and_changed_by_admins_with_revisions() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "station").await;
    let admin_token = bootstrap(&app, &key).await;
    let (_, me) = app
        .send(empty(with_session(
            request("GET", "/v1/office/me"),
            &key,
            &admin_token,
        )))
        .await;
    let admin_id = me["id"].as_str().unwrap().to_owned();
    seed_office_user(&app, "tech", "technologist", "correct horse battery").await;
    let tech_token = login(&app, &key, "tech", "correct horse battery").await;

    let (status, org) = app
        .send(empty(with_session(
            request("GET", "/v1/office/org"),
            &key,
            &tech_token,
        )))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(org["gln"], "4600682000010");
    let rev = org["rev"].as_i64().unwrap();

    let update = |expected_rev: i64, gln: &str| {
        json!({
            "name": "ООО «Атолл-Юг»",
            "inn": null,
            "gln": gln,
            "gs1Prefixes": ["4600682", "4607091"],
            "timeZone": "Europe/Samara",
            "expectedRev": expected_rev
        })
    };
    let (status, _) = app
        .send(json_request(
            with_session(request("PUT", "/v1/office/org"), &key, &tech_token),
            update(rev, "4600682000010"),
        ))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, body) = app
        .send(json_request(
            with_session(request("PUT", "/v1/office/org"), &key, &admin_token),
            update(rev - 1, "4600682000010"),
        ))
        .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["error"]["code"], "stale_revision");
    assert_eq!(body["error"]["details"]["currentRev"], rev);

    let global_before: i64 = sqlx::query_scalar("SELECT rev FROM host_revision WHERE id = 1")
        .fetch_one(&app.state.pool)
        .await
        .unwrap();
    let (status, body) = app
        .send(json_request(
            with_session(request("PUT", "/v1/office/org"), &key, &admin_token),
            update(rev, "4607091000017"),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["name"], "ООО «Атолл-Юг»");
    assert_eq!(body["inn"], Value::Null);
    let new_rev = body["rev"].as_i64().unwrap();
    assert_eq!(new_rev, global_before + 1);
    let global: i64 = sqlx::query_scalar("SELECT rev FROM host_revision WHERE id = 1")
        .fetch_one(&app.state.pool)
        .await
        .unwrap();
    assert_eq!(new_rev, global);

    let counters: Vec<(String, i64, i64, i64)> = sqlx::query_as(
        "SELECT issuer_prefix, extension, next_serial, rev FROM sscc_counters ORDER BY issuer_prefix, extension",
    )
    .fetch_all(&app.state.pool)
    .await
    .unwrap();
    assert_eq!(
        counters,
        vec![
            ("460068200".into(), 0, 1500, 1),
            ("460068200".into(), 1, 40, 1),
            ("460709100".into(), 0, 1, new_rev),
            ("460709100".into(), 1, 0, new_rev),
        ]
    );
    let (actor_kind, actor_id, action, target_type, target_id, result, details): (
        String,
        Option<String>,
        String,
        Option<String>,
        Option<String>,
        String,
        String,
    ) = sqlx::query_as(
        "SELECT actor_kind, actor_id, action, target_type, target_id, result, details FROM audit_log WHERE action = 'org.update' ORDER BY id DESC LIMIT 1",
    )
    .fetch_one(&app.state.pool)
    .await
    .unwrap();
    assert_eq!(
        (
            actor_kind.as_str(),
            actor_id.as_deref(),
            action.as_str(),
            target_type.as_deref(),
            target_id.as_deref(),
            result.as_str()
        ),
        (
            "office_user",
            Some(admin_id.as_str()),
            "org.update",
            Some("org_profile"),
            Some("1"),
            "ok"
        )
    );
    assert_eq!(
        serde_json::from_str::<Value>(&details).unwrap(),
        json!({ "changed": ["name", "inn", "gln", "gs1Prefixes", "timeZone"] })
    );

    // Switching back onto a prefix that already has counters (the original
    // 460068200) must not reset or duplicate them: `ON CONFLICT DO NOTHING`
    // leaves the existing rows exactly as they were.
    let (status, body) = app
        .send(json_request(
            with_session(request("PUT", "/v1/office/org"), &key, &admin_token),
            update(new_rev, "4600682000010"),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");

    let counters_after_switch_back: Vec<(String, i64, i64, i64)> = sqlx::query_as(
        "SELECT issuer_prefix, extension, next_serial, rev FROM sscc_counters ORDER BY issuer_prefix, extension",
    )
    .fetch_all(&app.state.pool)
    .await
    .unwrap();
    assert_eq!(
        counters_after_switch_back.len(),
        4,
        "switching back onto an existing prefix must not duplicate its counters"
    );
    assert_eq!(
        counters_after_switch_back[0],
        ("460068200".into(), 0, 1500, 1),
        "the original prefix's box counter must be untouched by ON CONFLICT DO NOTHING"
    );
    assert_eq!(
        counters_after_switch_back[1],
        ("460068200".into(), 1, 40, 1),
        "the original prefix's pallet counter must be untouched by ON CONFLICT DO NOTHING"
    );
}

#[tokio::test]
async fn putting_the_org_profile_unchanged_is_a_no_op() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "station").await;
    let admin_token = bootstrap(&app, &key).await;

    let (status, org) = app
        .send(empty(with_session(
            request("GET", "/v1/office/org"),
            &key,
            &admin_token,
        )))
        .await;
    assert_eq!(status, StatusCode::OK);
    let rev = org["rev"].as_i64().unwrap();
    let global_before: i64 = sqlx::query_scalar("SELECT rev FROM host_revision WHERE id = 1")
        .fetch_one(&app.state.pool)
        .await
        .unwrap();
    let audit_count_before: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM audit_log WHERE action = 'org.update'")
            .fetch_one(&app.state.pool)
            .await
            .unwrap();

    // Exactly the org fields `bootstrap_body()` set, unchanged.
    let unchanged = json!({
        "name": "ООО «Атолл»",
        "inn": "7701234567",
        "gln": "4600682000010",
        "gs1Prefixes": ["4600682"],
        "timeZone": "Europe/Moscow",
        "expectedRev": rev
    });
    let (status, body) = app
        .send(json_request(
            with_session(request("PUT", "/v1/office/org"), &key, &admin_token),
            unchanged,
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["rev"].as_i64().unwrap(), rev);

    let global_after: i64 = sqlx::query_scalar("SELECT rev FROM host_revision WHERE id = 1")
        .fetch_one(&app.state.pool)
        .await
        .unwrap();
    assert_eq!(global_after, global_before);
    let audit_count_after: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM audit_log WHERE action = 'org.update'")
            .fetch_one(&app.state.pool)
            .await
            .unwrap();
    assert_eq!(audit_count_after, audit_count_before);
}
