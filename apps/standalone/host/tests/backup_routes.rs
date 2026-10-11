//! Backups in the office (plan РК): the state for every role, a copy now for
//! administrators, and the second folder, tried before it is saved.

mod support;

use std::sync::Arc;

use axum::http::StatusCode;
use markiro_host::backup::{Backups, Worker};
use markiro_proto::backup::BackupTrigger;
use serde_json::{json, Value};
use support::app::{
    admin, audit_rows, audit_trail, empty, host_revision, login, pair_device, request,
    seed_office_user, turn_the_user_off_at_the_next_activity, with_device, Admin,
};

/// Give `admin`'s host its copies in `<data dir>/backups`.
fn with_backups(admin: &mut Admin) -> Arc<Backups> {
    let local = admin.app.dir().join("backups");
    std::fs::create_dir_all(&local).unwrap();
    let backups = Backups::new(
        admin.app.dir().to_path_buf(),
        local,
        admin.app.dir().join("host.db"),
        admin.app.state.host_id.clone(),
    );
    admin.app.state = admin.app.state.clone().with_backups(backups.clone());
    backups
}

fn refusal(body: &Value) -> (Value, Value) {
    (
        body["error"]["code"].clone(),
        body["error"]["details"].clone(),
    )
}

async fn settings(admin: &Admin) -> (Option<String>, i64) {
    sqlx::query_as("SELECT second_dir, rev FROM backup_settings WHERE id = 1")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn every_office_role_reads_the_state_and_a_device_key_alone_does_not() {
    let mut admin = admin().await;
    let (status, body) = admin.call("GET", "/v1/office/backups", None).await;
    assert_eq!(
        (status, body["error"]["code"].clone()),
        (StatusCode::NOT_FOUND, json!("not_found")),
        "a host without copies: {body}"
    );
    with_backups(&mut admin);
    let (status, body) = admin.call("GET", "/v1/office/backups", None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body,
        json!({
            "now": "2026-09-21T14:13:20Z",
            "local": {
                "dir": admin.app.dir().join("backups").display().to_string(),
                "lastAttempt": null,
                "copies": [],
            },
            "second": null,
            "settingsRev": 0,
            "running": null,
            "restoreHold": null,
        })
    );
    let tech = admin.technologist().await;
    let (status, read) = admin
        .call_as(&tech, "GET", "/v1/office/backups", None)
        .await;
    assert_eq!((status, read), (StatusCode::OK, body));
    let (status, body) = admin
        .app
        .send(empty(with_device(
            request("GET", "/v1/office/backups"),
            &admin.key,
        )))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
    assert_eq!(body["error"]["details"]["credential"], "session");
}

#[tokio::test]
async fn an_administrator_asks_for_a_copy_and_the_worker_makes_it() {
    let mut admin = admin().await;
    let backups = with_backups(&mut admin);
    let rows = audit_rows(&admin.app).await;
    let tech = admin.technologist().await;
    let (status, body) = admin
        .call_as(&tech, "POST", "/v1/office/backups", None)
        .await;
    assert_eq!(
        (status, body["error"]["code"].clone()),
        (StatusCode::FORBIDDEN, json!("forbidden"))
    );

    let (status, body) = admin.call("POST", "/v1/office/backups", None).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{body}");
    assert_eq!(
        body["running"],
        json!({ "trigger": "manual", "startedAt": "2026-09-21T14:13:20Z" })
    );
    let (status, again) = admin.call("POST", "/v1/office/backups", None).await;
    assert_eq!(
        (status, refusal(&again)),
        (
            StatusCode::CONFLICT,
            (json!("conflict"), json!({ "constraint": "backup_running" }))
        )
    );
    assert_eq!(
        audit_rows(&admin.app).await,
        rows + 1,
        "only the technologist's sign-in; asking writes no row"
    );

    let mut worker = Worker::new(backups.clone(), admin.app.clock.clone());
    let made = worker.run_manual().await.unwrap().local.unwrap();
    assert_eq!(made.trigger, BackupTrigger::Manual);
    let (status, body) = admin.call("GET", "/v1/office/backups", None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["running"], Value::Null);
    assert_eq!(body["local"]["copies"][0]["file"], json!(made.file));
    assert_eq!(
        body["local"]["lastAttempt"],
        json!({ "at": "2026-09-21T14:13:20Z", "trigger": "manual", "ok": true, "code": null })
    );
    let trail = audit_trail(&admin.app, "backup.create").await;
    assert_eq!(trail.len(), 1);
    assert_eq!(trail[0].0, "office_user");
    assert_eq!(trail[0].1.as_deref(), Some(admin.id.as_str()));
}

#[tokio::test]
async fn the_second_folder_is_tried_saved_audited_and_cleared() {
    let mut admin = admin().await;
    with_backups(&mut admin);
    let folder = tempfile::tempdir().unwrap();
    let dir = folder.path().display().to_string();
    let mut wake = admin.app.state.revisions.subscribe();
    let (status, body) = admin
        .call(
            "PUT",
            "/v1/office/backups/settings",
            Some(json!({ "secondDir": format!("  {dir} "), "expectedRev": 0 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let rev = host_revision(&admin.app).await;
    assert_eq!(body["settingsRev"], json!(rev));
    assert_eq!(
        body["second"],
        json!({ "dir": dir, "lastAttempt": null, "copies": [] })
    );
    assert_eq!(settings(&admin).await, (Some(dir.clone()), rev));
    assert!(wake.has_changed().unwrap(), "the change wakes the streams");
    assert_eq!(*wake.borrow_and_update(), rev);
    assert_eq!(
        audit_trail(&admin.app, "backup.settings.update").await,
        [admin.row(
            "backup.settings.update",
            "backup_settings",
            "1",
            json!({ "changed": ["secondDir"], "secondDir": { "from": null, "to": dir } }),
        )]
    );
    assert!(
        std::fs::read_dir(folder.path()).unwrap().next().is_none(),
        "the probe left nothing"
    );

    // The same folder again changes nothing.
    let rows = audit_rows(&admin.app).await;
    let (status, same) = admin
        .call(
            "PUT",
            "/v1/office/backups/settings",
            Some(json!({ "secondDir": dir, "expectedRev": rev })),
        )
        .await;
    assert_eq!(
        (status, same["settingsRev"].clone()),
        (StatusCode::OK, json!(rev))
    );
    assert_eq!(host_revision(&admin.app).await, rev);
    assert_eq!(audit_rows(&admin.app).await, rows);
    assert!(!wake.has_changed().unwrap());

    let (status, cleared) = admin
        .call(
            "PUT",
            "/v1/office/backups/settings",
            Some(json!({ "secondDir": null, "expectedRev": rev })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{cleared}");
    assert_eq!(cleared["second"], Value::Null);
    let cleared_rev = host_revision(&admin.app).await;
    assert_eq!(settings(&admin).await, (None, cleared_rev));
    let trail = audit_trail(&admin.app, "backup.settings.update").await;
    assert_eq!(
        trail.last().unwrap().6,
        json!({ "changed": ["secondDir"], "secondDir": { "from": dir, "to": null } })
    );
}

async fn refused_without_a_trace(admin: &Admin, body: Value) -> (StatusCode, Value) {
    let rows = audit_rows(&admin.app).await;
    let rev = host_revision(&admin.app).await;
    let before = settings(admin).await;
    let (status, answer) = admin
        .call("PUT", "/v1/office/backups/settings", Some(body))
        .await;
    assert_eq!(audit_rows(&admin.app).await, rows);
    assert_eq!(host_revision(&admin.app).await, rev);
    assert_eq!(settings(admin).await, before);
    (status, answer)
}

#[tokio::test]
async fn a_folder_that_cannot_take_copies_is_refused_before_anything_is_written() {
    let mut admin = admin().await;
    with_backups(&mut admin);
    let parent = tempfile::tempdir().unwrap();
    let file = parent.path().join("a-file");
    std::fs::write(&file, "x").unwrap();
    let inside = admin.app.dir().join("copies-too");
    std::fs::create_dir(&inside).unwrap();
    let cases = [
        (parent.path().join("unplugged"), "missing"),
        (file.clone(), "not_a_directory"),
        (inside.clone(), "inside_data_dir"),
        (admin.app.dir().join("backups"), "inside_data_dir"),
    ];
    for (dir, reason) in cases {
        let (status, body) = refused_without_a_trace(
            &admin,
            json!({ "secondDir": dir.display().to_string(), "expectedRev": 0 }),
        )
        .await;
        assert_eq!(
            (status, refusal(&body)),
            (
                StatusCode::CONFLICT,
                (
                    json!("conflict"),
                    json!({ "constraint": "backup_dir", "reason": reason })
                )
            ),
            "{}",
            dir.display()
        );
    }
    for text in [
        "copies",
        "   ",
        "/tmp/a\u{7}b",
        &format!("/{}", "x".repeat(260)),
    ] {
        let (status, body) =
            refused_without_a_trace(&admin, json!({ "secondDir": text, "expectedRev": 0 })).await;
        assert_eq!(
            (status, refusal(&body)),
            (
                StatusCode::BAD_REQUEST,
                (json!("validation_failed"), json!({ "field": "secondDir" }))
            ),
            "{text:?}"
        );
    }
    let (status, body) = refused_without_a_trace(&admin, json!({ "expectedRev": 0 })).await;
    assert_eq!(
        (status, body["error"]["code"].clone()),
        (StatusCode::BAD_REQUEST, json!("validation_failed")),
        "a body without secondDir clears nothing"
    );
}

#[tokio::test]
async fn a_stale_form_and_a_technologist_are_refused() {
    let mut admin = admin().await;
    with_backups(&mut admin);
    let folder = tempfile::tempdir().unwrap();
    let dir = folder.path().display().to_string();
    let (status, body) = refused_without_a_trace(
        &admin,
        json!({ "secondDir": dir.clone(), "expectedRev": 99 }),
    )
    .await;
    assert_eq!(
        (status, refusal(&body)),
        (
            StatusCode::CONFLICT,
            (json!("stale_revision"), json!({ "currentRev": 0 }))
        )
    );
    let tech = admin.technologist().await;
    let rows = audit_rows(&admin.app).await;
    let (status, body) = admin
        .call_as(
            &tech,
            "PUT",
            "/v1/office/backups/settings",
            Some(json!({ "secondDir": dir, "expectedRev": 0 })),
        )
        .await;
    assert_eq!(
        (status, body["error"]["code"].clone()),
        (StatusCode::FORBIDDEN, json!("forbidden"))
    );
    assert_eq!(audit_rows(&admin.app).await, rows);
    assert_eq!(settings(&admin).await, (None, 0));
}

#[tokio::test]
async fn an_administrator_turned_off_after_the_extractor_saves_nothing() {
    let mut admin = admin().await;
    with_backups(&mut admin);
    let other = seed_office_user(&admin.app, "admin2", "admin", "second admin password").await;
    let token = login(&admin.app, &admin.key, "admin2", "second admin password").await;
    let folder = tempfile::tempdir().unwrap();
    turn_the_user_off_at_the_next_activity(&admin.app, &other).await;
    admin.app.clock.advance(time::Duration::minutes(2));
    let rows = audit_rows(&admin.app).await;
    let (status, body) = admin
        .call_as(
            &token,
            "PUT",
            "/v1/office/backups/settings",
            Some(json!({ "secondDir": folder.path().display().to_string(), "expectedRev": 0 })),
        )
        .await;
    assert_eq!(
        (status, body["error"]["details"]["credential"].clone()),
        (StatusCode::UNAUTHORIZED, json!("session")),
        "{body}"
    );
    assert_eq!(settings(&admin).await, (None, 0));
    assert_eq!(audit_rows(&admin.app).await, rows);
}

#[tokio::test]
async fn a_held_host_lists_its_stations_and_which_gave_their_blocks_back() {
    let mut admin = admin().await;
    with_backups(&mut admin);
    let (status, device) = admin
        .app
        .send(empty(with_device(request("GET", "/v1/device"), &admin.key)))
        .await;
    assert_eq!(status, StatusCode::OK, "{device}");
    let own = device["id"].as_str().unwrap().to_owned();
    let (late, _) = pair_device(&admin.app, "station").await;
    let (revoked, _) = pair_device(&admin.app, "station").await;
    pair_device(&admin.app, "office").await;
    let epoch = "5d2c8e1a-7b3f-4c9d-a0e1-2f3a4b5c6d7e";
    let pool = &admin.app.state.pool;
    sqlx::query("UPDATE site SET restore_epoch = ?, facts_held_since = '2026-10-09T15:00:00Z'")
        .bind(epoch)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("UPDATE devices SET revoked_at = '2026-10-09T15:01:00Z' WHERE id = ?")
        .bind(&revoked)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("UPDATE devices SET known_blocks_epoch = ? WHERE id = ?")
        .bind(epoch)
        .bind(&own)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("UPDATE devices SET known_blocks_epoch = 'an older epoch' WHERE id = ?")
        .bind(&late)
        .execute(pool)
        .await
        .unwrap();
    let (status, body) = admin.call("GET", "/v1/office/backups", None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let mut stations = vec![
        json!({ "id": own, "name": "Тестовое устройство", "lastSeenAt": "2026-09-21T14:13:20Z", "reconciled": true }),
        json!({ "id": late, "name": "Тестовое устройство", "lastSeenAt": "2026-09-21T14:13:20Z", "reconciled": false }),
    ];
    stations.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
    assert_eq!(
        body["restoreHold"],
        json!({ "since": "2026-10-09T15:00:00Z", "epoch": epoch, "stations": stations })
    );
    // «Сделать копию сейчас» answers the same hold, read before the copy is
    // asked for.
    let (status, started) = admin.call("POST", "/v1/office/backups", None).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{started}");
    assert_eq!(started["restoreHold"], body["restoreHold"]);
}

// ---- Beyond the brief: the path is the administrator's text, the gates are
// ---- the same on every verb, and the state is the worker's own.

#[tokio::test]
async fn a_dot_dot_part_or_a_device_path_is_refused_even_when_the_folder_exists() {
    let mut admin = admin().await;
    with_backups(&mut admin);
    let folder = tempfile::tempdir().unwrap();
    std::fs::create_dir(folder.path().join("sub")).unwrap();
    let dir = folder.path().display().to_string();
    for text in [
        // A real folder, reached through `..`: it would pass the probe.
        format!("{dir}/sub/.."),
        format!("{dir}/sub/../sub"),
        format!("{dir}\\sub\\..\\sub"),
        format!("/{dir}/sub").replacen("//", "//?/", 1),
        "//./PhysicalDrive0".to_owned(),
    ] {
        let (status, body) =
            refused_without_a_trace(&admin, json!({ "secondDir": text, "expectedRev": 0 })).await;
        assert_eq!(
            (status, refusal(&body)),
            (
                StatusCode::BAD_REQUEST,
                (json!("validation_failed"), json!({ "field": "secondDir" }))
            ),
            "{text:?}"
        );
        assert!(
            !body.to_string().contains("PhysicalDrive") && !body.to_string().contains(&dir),
            "the answer does not echo the path: {body}"
        );
    }
}

#[tokio::test]
async fn a_host_without_copies_answers_not_found_to_every_verb_and_writes_nothing() {
    let admin = admin().await;
    let rows = audit_rows(&admin.app).await;
    let rev = host_revision(&admin.app).await;
    for (method, path, body) in [
        ("POST", "/v1/office/backups", None),
        (
            "PUT",
            "/v1/office/backups/settings",
            Some(json!({ "secondDir": null, "expectedRev": 0 })),
        ),
    ] {
        let (status, answer) = admin.call(method, path, body).await;
        assert_eq!(
            (status, answer["error"]["code"].clone()),
            (StatusCode::NOT_FOUND, json!("not_found")),
            "{method} {path}"
        );
    }
    assert_eq!(audit_rows(&admin.app).await, rows);
    assert_eq!(host_revision(&admin.app).await, rev);
}

#[tokio::test]
async fn a_device_key_without_an_office_session_reaches_no_verb() {
    let mut admin = admin().await;
    with_backups(&mut admin);
    let rows = audit_rows(&admin.app).await;
    for (method, path) in [
        ("POST", "/v1/office/backups"),
        ("PUT", "/v1/office/backups/settings"),
    ] {
        let (status, body) = admin
            .app
            .send(empty(with_device(request(method, path), &admin.key)))
            .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{method} {path}: {body}");
        assert_eq!(body["error"]["details"]["credential"], "session");
    }
    assert_eq!(audit_rows(&admin.app).await, rows);
    assert_eq!(settings(&admin).await, (None, 0));
}

#[tokio::test]
async fn a_second_ask_while_a_copy_runs_starts_nothing_and_keeps_the_first() {
    let mut admin = admin().await;
    let backups = with_backups(&mut admin);
    let (status, first) = admin.call("POST", "/v1/office/backups", None).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{first}");
    admin.app.clock.advance(time::Duration::seconds(5));
    for _ in 0..2 {
        let (status, again) = admin.call("POST", "/v1/office/backups", None).await;
        assert_eq!(status, StatusCode::CONFLICT, "{again}");
    }
    let (_, read) = admin.call("GET", "/v1/office/backups", None).await;
    assert_eq!(
        read["running"], first["running"],
        "the running copy is the first one, started at its own time"
    );
    // One request waits for the worker, not three.
    let mut worker = Worker::new(backups.clone(), admin.app.clock.clone());
    assert!(worker.run_manual().await.is_some());
    assert!(worker.run_manual().await.is_none(), "nothing else waited");
    let (status, next) = admin.call("POST", "/v1/office/backups", None).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{next}");
    assert_eq!(next["running"]["startedAt"], json!("2026-09-21T14:13:25Z"));
}

/// The state is read before the copy is asked for: a read that fails
/// answers 500 and leaves no copy waiting behind the answer.
#[tokio::test]
async fn a_failed_state_read_answers_internal_and_queues_no_copy() {
    let mut admin = admin().await;
    with_backups(&mut admin);
    sqlx::query("ALTER TABLE backup_settings RENAME TO backup_settings_gone")
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    let (status, body) = admin.call("POST", "/v1/office/backups", None).await;
    assert_eq!(
        (status, body["error"]["code"].clone()),
        (StatusCode::INTERNAL_SERVER_ERROR, json!("internal")),
        "{body}"
    );
    sqlx::query("ALTER TABLE backup_settings_gone RENAME TO backup_settings")
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    let (status, body) = admin.call("GET", "/v1/office/backups", None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["running"], Value::Null, "no copy waits: {body}");
    let (status, body) = admin.call("POST", "/v1/office/backups", None).await;
    assert_eq!(
        status,
        StatusCode::ACCEPTED,
        "the next ask is not refused: {body}"
    );
    assert_eq!(body["running"]["trigger"], json!("manual"), "{body}");
}

#[tokio::test]
async fn a_form_read_before_a_change_is_stale_after_it() {
    let mut admin = admin().await;
    with_backups(&mut admin);
    let folder = tempfile::tempdir().unwrap();
    let other = tempfile::tempdir().unwrap();
    let (status, _) = admin
        .call(
            "PUT",
            "/v1/office/backups/settings",
            Some(json!({ "secondDir": folder.path().display().to_string(), "expectedRev": 0 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let rev = host_revision(&admin.app).await;
    let (status, body) = refused_without_a_trace(
        &admin,
        json!({ "secondDir": other.path().display().to_string(), "expectedRev": 0 }),
    )
    .await;
    assert_eq!(
        (status, refusal(&body)),
        (
            StatusCode::CONFLICT,
            (json!("stale_revision"), json!({ "currentRev": rev }))
        )
    );
}

#[tokio::test]
async fn the_state_is_what_the_worker_did_in_each_folder() {
    let mut admin = admin().await;
    let backups = with_backups(&mut admin);
    let second = tempfile::tempdir().unwrap();
    let dir = second.path().display().to_string();
    let (status, _) = admin
        .call(
            "PUT",
            "/v1/office/backups/settings",
            Some(json!({ "secondDir": dir, "expectedRev": 0 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let mut worker = Worker::new(backups.clone(), admin.app.clock.clone());

    let (_, ask) = admin.call("POST", "/v1/office/backups", None).await;
    assert!(ask["running"].is_object());
    worker.run_manual().await.unwrap();
    let (_, state) = admin.call("GET", "/v1/office/backups", None).await;
    let attempt =
        json!({ "at": "2026-09-21T14:13:20Z", "trigger": "manual", "ok": true, "code": null });
    assert_eq!(state["running"], Value::Null);
    assert_eq!(state["local"]["lastAttempt"], attempt);
    assert_eq!(state["second"]["lastAttempt"], attempt);
    assert_eq!(state["second"]["copies"].as_array().unwrap().len(), 1);
    assert_eq!(state["second"]["copies"], state["local"]["copies"]);

    // The share goes away: the second folder shows its failure, the local one
    // keeps its copy, and the audit row says `failed`.
    std::fs::remove_dir_all(second.path()).unwrap();
    admin.app.clock.advance(time::Duration::minutes(3));
    admin.call("POST", "/v1/office/backups", None).await;
    worker.run_manual().await.unwrap();
    let (_, state) = admin.call("GET", "/v1/office/backups", None).await;
    assert_eq!(state["local"]["lastAttempt"]["ok"], json!(true));
    assert_eq!(state["local"]["copies"].as_array().unwrap().len(), 2);
    assert_eq!(state["second"]["lastAttempt"]["ok"], json!(false));
    assert_eq!(
        state["second"]["lastAttempt"]["code"],
        json!("destination_unavailable")
    );
    let trail = audit_trail(&admin.app, "backup.create").await;
    assert_eq!(trail.len(), 2);
    assert_eq!(trail[0].5, "ok");
    assert_eq!(trail[1].5, "failed");
    assert_eq!(
        trail[1].6["second"],
        json!({ "ok": false, "code": "destination_unavailable" })
    );
}
