mod support;

use axum::http::StatusCode;
use markiro_host::secrets::verify_password;
use serde_json::{json, Value};
use support::app::{
    audit_rows, bootstrap, bootstrap_body, empty, host_revision, json as json_request, login,
    pair_device, request, seed_office_user, with_device, with_session, TestApp, LAN,
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
        json!({
            "adminLogin": "admin",
            "orgName": "ООО «Атолл»",
            "issuerPrefix": "460068200",
            "lineCount": 2,
            "boxNextSerial": 1500,
            "palletNextSerial": 40,
            "templateCount": 0
        })
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

/// A NUL first passes `trim` but fails the tables' CHECKs (SQLite's `length()`
/// stops at it), which used to answer 500 from inside the wizard's
/// transaction; every wizard text obeys the one control-character rule.
#[tokio::test]
async fn wizard_text_with_a_control_character_names_the_field_instead_of_failing() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "station").await;
    let cases: [(&str, &str, &str); 5] = [
        ("/org/name", "\u{0}ООО «Атолл»", "org.name"),
        ("/org/name", "ООО\t«Атолл»", "org.name"),
        ("/admin/name", "\u{0}Ирина Смирнова", "admin.name"),
        ("/lines/0", "\u{0}Линия 1", "lines.0"),
        ("/lines/1", "Линия\u{0}2", "lines.1"),
    ];
    for (pointer, text, field) in cases {
        let mut body = bootstrap_body();
        *body.pointer_mut(pointer).unwrap() = json!(text);
        let (status, response) = app
            .send(json_request(
                with_device(request("POST", "/v1/bootstrap"), &key),
                body,
            ))
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{field} {text:?}");
        assert_eq!(response["error"]["code"], "validation_failed", "{field}");
        assert_eq!(response["error"]["details"]["field"], field, "{field}");
    }
    let (_, hello) = app.send(empty(request("GET", "/v1/hello"))).await;
    assert_eq!(hello["initialized"], false);
    let users: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM office_users")
        .fetch_one(&app.state.pool)
        .await
        .unwrap();
    assert_eq!(users, 0);
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
        json!({
            "changed": ["name", "inn", "gln", "gs1Prefixes", "timeZone"],
            "name": { "from": "ООО «Атолл»", "to": "ООО «Атолл-Юг»" },
            "inn": { "from": "7701234567", "to": null },
            "gln": { "from": "4600682000010", "to": "4607091000017" },
            "gs1Prefixes": { "from": ["4600682"], "to": ["4600682", "4607091"] },
            "timeZone": { "from": "Europe/Moscow", "to": "Europe/Samara" }
        })
    );

    let (status, sscc) = app
        .send(empty(with_session(
            request("GET", "/v1/office/sscc"),
            &key,
            &admin_token,
        )))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(sscc["currentIssuerPrefix"], "460709100");

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

    let (status, sscc) = app
        .send(empty(with_session(
            request("GET", "/v1/office/sscc"),
            &key,
            &admin_token,
        )))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(sscc["currentIssuerPrefix"], "460068200");
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

/// A layout of the given width, as the domain's stock builders make one.
fn stock_spec(width: u32) -> Value {
    json!({ "widthMm": width, "heightMm": 40, "dpi": 203, "language": "zpl", "elements": [] })
}

/// A layout `levels` objects deep, the innermost one empty.
fn nested(levels: usize) -> Value {
    let mut spec = json!({});
    for _ in 1..levels {
        spec = json!({ "elements": spec });
    }
    spec
}

/// Run the wizard from loopback with `templates` added to the valid request.
async fn wizard_with(app: &TestApp, key: &str, templates: Value) -> (StatusCode, Value) {
    let mut body = bootstrap_body();
    body["templates"] = templates;
    app.send(json_request(
        with_device(request("POST", "/v1/bootstrap"), key),
        body,
    ))
    .await
}

/// The id of the template named `name`.
async fn template_id(app: &TestApp, name: &str) -> String {
    sqlx::query_scalar("SELECT id FROM label_templates WHERE name = ?")
        .bind(name)
        .fetch_one(&app.state.pool)
        .await
        .unwrap()
}

/// What a wizard writes, counted table by table.
async fn rows_the_wizard_writes(app: &TestApp) -> Vec<(&'static str, i64)> {
    let mut counts = Vec::new();
    for table in [
        "office_users",
        "office_sessions",
        "org_profile",
        "sscc_counters",
        "lines",
        "label_templates",
    ] {
        let count: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table}"))
            .fetch_one(&app.state.pool)
            .await
            .unwrap();
        counts.push((table, count));
    }
    counts
}

/// A refused or failed wizard leaves the host as it found it: nothing in any
/// table the wizard fills, the host not initialized, no revision taken and no
/// audit row written. `revision` and `audit` are the host's before the wizard.
async fn assert_untouched(app: &TestApp, revision: i64, audit: i64, case: &str) {
    assert_eq!(
        rows_the_wizard_writes(app).await,
        [
            ("office_users", 0),
            ("office_sessions", 0),
            ("org_profile", 0),
            ("sscc_counters", 0),
            ("lines", 0),
            ("label_templates", 0)
        ],
        "{case}"
    );
    let (status, hello) = app.send(empty(request("GET", "/v1/hello"))).await;
    assert_eq!(status, StatusCode::OK, "{case}: {hello}");
    assert_eq!(hello["initialized"], false, "{case}");
    assert_eq!(host_revision(app).await, revision, "{case}");
    assert_eq!(audit_rows(app).await, audit, "{case}");
}

#[tokio::test]
async fn the_wizard_keeps_the_stock_templates_and_the_organizations_defaults() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "station").await;
    let mut body = bootstrap_body();
    body["templates"] = json!([
        { "name": " Коробка 58×40 ", "purpose": "box", "spec": stock_spec(58), "orgDefault": true },
        { "name": "Коробка 100×150", "purpose": "box", "spec": stock_spec(100) },
        { "name": "Паллета 100×150", "purpose": "pallet", "spec": stock_spec(100), "orgDefault": true },
        { "name": "Дубликат 58×40", "purpose": "product_duplicate", "spec": stock_spec(58) }
    ]);
    let (status, response) = app
        .send(json_request(
            with_device(request("POST", "/v1/bootstrap"), &key),
            body,
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{response}");

    // Every template is a stock one, enabled for every category, at the
    // wizard's revision.
    let stored: Vec<(String, String, String, bool, Option<String>, bool, i64)> = sqlx::query_as(
        "SELECT id, name, purpose, enabled, category_codes, stock, rev FROM label_templates ORDER BY name",
    )
    .fetch_all(&app.state.pool)
    .await
    .unwrap();
    let id_of = |name: &str| {
        stored
            .iter()
            .find(|row| row.1 == name)
            .map(|row| row.0.clone())
            .unwrap_or_else(|| panic!("no template {name}"))
    };
    assert_eq!(
        stored
            .iter()
            .map(|(_, name, purpose, enabled, codes, stock, rev)| {
                (
                    name.as_str(),
                    purpose.as_str(),
                    *enabled,
                    codes.clone(),
                    *stock,
                    *rev,
                )
            })
            .collect::<Vec<_>>(),
        vec![
            ("Дубликат 58×40", "product_duplicate", true, None, true, 1),
            ("Коробка 100×150", "box", true, None, true, 1),
            ("Коробка 58×40", "box", true, None, true, 1),
            ("Паллета 100×150", "pallet", true, None, true, 1),
        ]
    );
    // The flagged ones are the organization's defaults; no duplicate default
    // was asked for.
    let token = response["session"]["token"].as_str().unwrap();
    let (status, defaults) = app
        .send(empty(with_session(
            request("GET", "/v1/office/template-defaults"),
            &key,
            token,
        )))
        .await;
    assert_eq!(status, StatusCode::OK, "{defaults}");
    assert_eq!(
        defaults,
        json!({
            "defaultBoxTemplateId": id_of("Коробка 58×40"),
            "defaultPalletTemplateId": id_of("Паллета 100×150"),
            "defaultDuplicateTemplateId": null,
            "categories": [],
            "rev": 1
        })
    );
    let details: String =
        sqlx::query_scalar("SELECT details FROM audit_log WHERE action = 'host.bootstrap'")
            .fetch_one(&app.state.pool)
            .await
            .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&details).unwrap()["templateCount"],
        4
    );
    // Stations get the templates with the wizard's revision, layouts included.
    let (status, feed) = app
        .send(empty(with_device(
            request("GET", "/v1/changes?since=0"),
            &key,
        )))
        .await;
    assert_eq!(status, StatusCode::OK, "{feed}");
    let templates: Vec<&Value> = feed["items"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|item| item["entity"] == "label_templates")
        .collect();
    assert_eq!(templates.len(), 4);
    assert!(templates
        .iter()
        .all(|item| item["rev"] == 1 && item["data"]["stock"] == true));
    assert!(templates
        .iter()
        .any(|item| item["data"]["spec"] == stock_spec(100)));
    // The organization's record rides the same feed with the defaults, and
    // each names a template the feed carries.
    let org = feed["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["entity"] == "org_profile")
        .expect("the organization is in the feed");
    assert_eq!(
        (
            org["data"]["defaultBoxTemplateId"].clone(),
            org["data"]["defaultPalletTemplateId"].clone(),
            org["data"]["defaultDuplicateTemplateId"].clone()
        ),
        (
            json!(id_of("Коробка 58×40")),
            json!(id_of("Паллета 100×150")),
            Value::Null
        )
    );
}

#[tokio::test]
async fn stock_templates_are_checked_and_a_refused_wizard_creates_nothing() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "station").await;
    let revision = host_revision(&app).await;
    let audit = audit_rows(&app).await;
    let template = |purpose: &str, org_default: bool| json!({ "name": "Коробка 58×40", "purpose": purpose, "spec": stock_spec(58), "orgDefault": org_default });
    let too_many: Vec<Value> = (0..33).map(|_| template("box", false)).collect();
    let mut blank = template("box", false);
    blank["name"] = json!(" ");
    let mut not_an_object = template("box", false);
    not_an_object["spec"] = json!([]);
    for (templates, field) in [
        (json!(too_many), "templates"),
        (json!([blank]), "templates.0.name"),
        (json!([not_an_object]), "templates.0.spec"),
        (
            json!([
                template("box", true),
                template("pallet", true),
                template("box", true)
            ]),
            "templates.2.orgDefault",
        ),
    ] {
        let mut body = bootstrap_body();
        body["templates"] = templates;
        let (status, response) = app
            .send(json_request(
                with_device(request("POST", "/v1/bootstrap"), &key),
                body,
            ))
            .await;
        assert_eq!(
            (status, response["error"]["details"]["field"].clone()),
            (StatusCode::BAD_REQUEST, json!(field)),
            "{field}"
        );
    }
    let mut enabled = template("box", false);
    enabled["enabled"] = json!(true);
    for templates in [json!([template("label", false)]), json!([enabled])] {
        let mut body = bootstrap_body();
        body["templates"] = templates;
        let (status, response) = app
            .send(json_request(
                with_device(request("POST", "/v1/bootstrap"), &key),
                body,
            ))
            .await;
        assert_eq!(
            (status, response["error"]["code"].clone()),
            (StatusCode::BAD_REQUEST, json!("validation_failed"))
        );
    }
    let (status, hello) = app.send(empty(request("GET", "/v1/hello"))).await;
    assert_eq!(status, StatusCode::OK, "{hello}");
    assert_eq!(hello["initialized"], false);
    let templates: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM label_templates")
        .fetch_one(&app.state.pool)
        .await
        .unwrap();
    assert_eq!(templates, 0);
    // Not only the templates: no administrator, organization, line, counter
    // or session, no revision and no audit row.
    assert_untouched(&app, revision, audit, "refused").await;
}

/// The wizard checks a stock layout as every template's is
/// (`validate::template_spec`), so one nested deeper than 64 levels
/// (`MAX_SPEC_DEPTH`: a feed page could not carry it to the stations) refuses
/// the whole wizard as `templates.{i}.spec`, and a refused wizard writes
/// nothing. Exactly 64 levels are kept. (Literals, not the constant, so that
/// this pins the bound itself.)
#[tokio::test]
async fn a_stock_layout_nested_64_levels_is_kept_and_one_level_more_refuses_the_wizard() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "station").await;
    let revision = host_revision(&app).await;
    let audit = audit_rows(&app).await;
    let box_template =
        |name: &str, spec: Value| json!({ "name": name, "purpose": "box", "spec": spec });

    let (status, refused) = wizard_with(
        &app,
        &key,
        json!([
            box_template("Коробка 58×40", stock_spec(58)),
            box_template("Коробка глубже", nested(65))
        ]),
    )
    .await;
    assert_eq!(
        (
            status,
            refused["error"]["code"].clone(),
            refused["error"]["details"]["field"].clone()
        ),
        (
            StatusCode::BAD_REQUEST,
            json!("validation_failed"),
            json!("templates.1.spec")
        )
    );
    assert_untouched(&app, revision, audit, "65 levels").await;

    let (status, response) = wizard_with(
        &app,
        &key,
        json!([
            box_template("Коробка 58×40", stock_spec(58)),
            box_template("Коробка на 64 уровня", nested(64))
        ]),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{response}");
    let stored: String =
        sqlx::query_scalar("SELECT spec FROM label_templates WHERE name = 'Коробка на 64 уровня'")
            .fetch_one(&app.state.pool)
            .await
            .unwrap();
    assert_eq!(serde_json::from_str::<Value>(&stored).unwrap(), nested(64));
}

/// A wizard sends up to 32 stock templates (`MAX_STOCK_TEMPLATES`; the domain
/// builds 20 today) and may flag one of each purpose, the duplicate's too, as
/// the organization's default: each slot takes the flagged template of its own
/// purpose, not the first or the last of them. (Literals, not the constant, so
/// that this pins the bound itself.)
#[tokio::test]
async fn a_wizard_takes_32_stock_templates_and_a_default_of_every_purpose() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "station").await;
    let revision = host_revision(&app).await;
    let audit = audit_rows(&app).await;
    let template = |name: &str, purpose: &str, org_default: bool| json!({ "name": name, "purpose": purpose, "spec": stock_spec(58), "orgDefault": org_default });
    // A plain template of each purpose first, then the flagged one of each,
    // then plain ones up to 32.
    let mut templates = vec![
        template("Коробка первая", "box", false),
        template("Паллета первая", "pallet", false),
        template("Дубликат первый", "product_duplicate", false),
        template("Коробка по умолчанию", "box", true),
        template("Паллета по умолчанию", "pallet", true),
        template("Дубликат по умолчанию", "product_duplicate", true),
    ];
    for number in templates.len()..32 {
        let purpose = ["box", "pallet", "product_duplicate"][number % 3];
        templates.push(template(&format!("Типовой {number}"), purpose, false));
    }
    assert_eq!(templates.len(), 32);

    // One more is refused, and the wizard writes nothing...
    let mut one_too_many = templates.clone();
    one_too_many.push(template("Лишний", "box", false));
    let (status, refused) = wizard_with(&app, &key, json!(one_too_many)).await;
    assert_eq!(
        (status, refused["error"]["details"]["field"].clone()),
        (StatusCode::BAD_REQUEST, json!("templates"))
    );
    assert_untouched(&app, revision, audit, "33 templates").await;

    // ...and exactly 32 are kept.
    let (status, response) = wizard_with(&app, &key, json!(templates)).await;
    assert_eq!(status, StatusCode::OK, "{response}");
    let kept: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM label_templates \
         WHERE enabled = 1 AND stock = 1 AND category_codes IS NULL AND rev = 1",
    )
    .fetch_one(&app.state.pool)
    .await
    .unwrap();
    assert_eq!(kept, 32);
    let token = response["session"]["token"].as_str().unwrap();
    let (status, defaults) = app
        .send(empty(with_session(
            request("GET", "/v1/office/template-defaults"),
            &key,
            token,
        )))
        .await;
    assert_eq!(status, StatusCode::OK, "{defaults}");
    assert_eq!(
        defaults,
        json!({
            "defaultBoxTemplateId": template_id(&app, "Коробка по умолчанию").await,
            "defaultPalletTemplateId": template_id(&app, "Паллета по умолчанию").await,
            "defaultDuplicateTemplateId": template_id(&app, "Дубликат по умолчанию").await,
            "categories": [],
            "rev": 1
        })
    );
    let details: String =
        sqlx::query_scalar("SELECT details FROM audit_log WHERE action = 'host.bootstrap'")
            .fetch_one(&app.state.pool)
            .await
            .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&details).unwrap()["templateCount"],
        32
    );
}

/// The wizard writes its stock templates in the one transaction of the rest,
/// so a failure after they are written leaves nothing behind. A trigger
/// refuses the wizard's audit row, the last thing it writes; the answer is an
/// internal error, not one row stays, and the same request then runs from
/// scratch once the trigger is gone.
#[tokio::test]
async fn a_wizard_that_fails_after_writing_the_templates_leaves_nothing() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "station").await;
    let revision = host_revision(&app).await;
    let audit = audit_rows(&app).await;
    let templates = json!([
        { "name": "Коробка 58×40", "purpose": "box", "spec": stock_spec(58), "orgDefault": true },
        { "name": "Паллета 100×150", "purpose": "pallet", "spec": stock_spec(100), "orgDefault": true },
        { "name": "Дубликат 58×40", "purpose": "product_duplicate", "spec": stock_spec(58) }
    ]);
    sqlx::query(
        "CREATE TRIGGER refuse_the_wizards_audit_row BEFORE INSERT ON audit_log \
         WHEN NEW.action = 'host.bootstrap' \
         BEGIN SELECT RAISE(ABORT, 'no audit row for the wizard'); END",
    )
    .execute(&app.state.pool)
    .await
    .unwrap();

    let (status, failed) = wizard_with(&app, &key, templates.clone()).await;
    assert_eq!(
        (status, failed["error"]["code"].clone()),
        (StatusCode::INTERNAL_SERVER_ERROR, json!("internal")),
        "{failed}"
    );
    assert_untouched(&app, revision, audit, "failed after the templates").await;

    sqlx::query("DROP TRIGGER refuse_the_wizards_audit_row")
        .execute(&app.state.pool)
        .await
        .unwrap();
    let (status, response) = wizard_with(&app, &key, templates).await;
    assert_eq!(status, StatusCode::OK, "{response}");
    assert_eq!(
        rows_the_wizard_writes(&app).await,
        [
            ("office_users", 1),
            ("office_sessions", 1),
            ("org_profile", 1),
            ("sscc_counters", 2),
            ("lines", 2),
            ("label_templates", 3)
        ]
    );
}
