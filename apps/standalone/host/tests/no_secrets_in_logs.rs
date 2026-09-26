//! Spec §4.10: the process log never holds device keys, session tokens,
//! passwords, password hashes or the badge salt. Its own binary, because it
//! installs the global tracing subscriber.

mod support;

use base64::Engine;
use markiro_host::config::HostPaths;
use markiro_host::{start, StartOptions};
use serde_json::json;

#[tokio::test]
async fn secrets_never_reach_the_process_log() {
    let dir = tempfile::tempdir().unwrap();
    let paths = HostPaths::new(dir.path());
    paths.ensure().unwrap();
    let guard = markiro_host::logging::init(&paths.logs_dir(), false).unwrap();
    let options = StartOptions {
        port_override: None,
        bind: Some("127.0.0.1:0".parse().unwrap()),
    };
    let host = start(&paths, options).await.unwrap();
    let base = format!("https://{}", host.addr);
    let client = support::pinned_client(&host.fingerprint);
    let protocol = (
        markiro_proto::PROTOCOL_HEADER,
        markiro_proto::PROTOCOL_VERSION.to_string(),
    );

    let pair: serde_json::Value = client
        .post(format!("{base}/v1/local-pair"))
        .header(protocol.0, &protocol.1)
        .json(&json!({ "kind": "station", "name": "Станция", "appVersion": "0.1.0" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let key = pair["deviceKey"].as_str().unwrap().to_owned();
    let session: serde_json::Value = client
        .post(format!("{base}/v1/bootstrap"))
        .header(protocol.0, &protocol.1)
        .bearer_auth(&key)
        .json(&json!({
            "admin": { "login": "admin", "name": "Ирина", "password": "correct horse battery" },
            "org": { "name": "ООО «Атолл»", "gln": "4600682000010", "gs1Prefixes": [], "timeZone": "Europe/Moscow" },
            "sscc": { "boxNextSerial": 1, "palletNextSerial": 0 },
            "lines": ["Линия 1"]
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let token = session["session"]["token"].as_str().unwrap().to_owned();
    let wrong = client
        .post(format!("{base}/v1/office/login"))
        .header(protocol.0, &protocol.1)
        .bearer_auth(&key)
        .json(&json!({ "login": "admin", "password": "not the password" }))
        .send()
        .await
        .unwrap();
    assert_eq!(wrong.status(), 401);
    let created = client
        .post(format!("{base}/v1/office/users"))
        .header(protocol.0, &protocol.1)
        .header(markiro_proto::OFFICE_SESSION_HEADER, &token)
        .bearer_auth(&key)
        .json(&json!({ "login": "tech", "name": "Павел", "role": "technologist", "password": "technologist password" }))
        .send()
        .await
        .unwrap();
    assert_eq!(created.status(), 200);
    let created: serde_json::Value = created.json().await.unwrap();
    let tech_id = created["id"].as_str().unwrap().to_owned();

    // The technologist can log in with the password just set...
    let tech_session: serde_json::Value = client
        .post(format!("{base}/v1/office/login"))
        .header(protocol.0, &protocol.1)
        .bearer_auth(&key)
        .json(&json!({ "login": "tech", "password": "technologist password" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let tech_token = tech_session["token"].as_str().unwrap().to_owned();

    // ...and the administrator can rotate that password.
    let tech_new_password = "another long technologist password";
    let password_changed = client
        .put(format!("{base}/v1/office/users/{tech_id}/password"))
        .header(protocol.0, &protocol.1)
        .header(markiro_proto::OFFICE_SESSION_HEADER, &token)
        .bearer_auth(&key)
        .json(&json!({ "password": tech_new_password }))
        .send()
        .await
        .unwrap();
    assert_eq!(password_changed.status(), 204);

    // The admin's reset ended the technologist's session, so they log back in
    // with the password just set...
    let tech_relogin: serde_json::Value = client
        .post(format!("{base}/v1/office/login"))
        .header(protocol.0, &protocol.1)
        .bearer_auth(&key)
        .json(&json!({ "login": "tech", "password": tech_new_password }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let tech_new_token = tech_relogin["token"].as_str().unwrap().to_owned();

    // ...and changes their own password: first rejected with the wrong
    // current password...
    let wrong_current_password = "wrong technologist current password";
    let third_password = "third long technologist password";
    let self_change_wrong = client
        .put(format!("{base}/v1/office/me/password"))
        .header(protocol.0, &protocol.1)
        .header(markiro_proto::OFFICE_SESSION_HEADER, &tech_new_token)
        .bearer_auth(&key)
        .json(&json!({ "currentPassword": wrong_current_password, "newPassword": third_password }))
        .send()
        .await
        .unwrap();
    assert_eq!(self_change_wrong.status(), 401);

    // ...then accepted with the right one.
    let self_change = client
        .put(format!("{base}/v1/office/me/password"))
        .header(protocol.0, &protocol.1)
        .header(markiro_proto::OFFICE_SESSION_HEADER, &tech_new_token)
        .bearer_auth(&key)
        .json(&json!({ "currentPassword": tech_new_password, "newPassword": third_password }))
        .send()
        .await
        .unwrap();
    assert_eq!(self_change.status(), 204);

    // A wrong device key and a wrong session token are both rejected...
    let wrong_device_key = "not-a-real-device-key";
    let wrong_device = client
        .get(format!("{base}/v1/office/me"))
        .header(protocol.0, &protocol.1)
        .header(markiro_proto::OFFICE_SESSION_HEADER, &token)
        .bearer_auth(wrong_device_key)
        .send()
        .await
        .unwrap();
    assert_eq!(wrong_device.status(), 401);
    let wrong_session_token = "not-a-real-session-token";
    let wrong_session = client
        .get(format!("{base}/v1/office/me"))
        .header(protocol.0, &protocol.1)
        .header(markiro_proto::OFFICE_SESSION_HEADER, wrong_session_token)
        .bearer_auth(&key)
        .send()
        .await
        .unwrap();
    assert_eq!(wrong_session.status(), 401);

    let pool = markiro_host::db::open(&paths.database_file())
        .await
        .unwrap();
    let hashes: Vec<String> = sqlx::query_scalar("SELECT password_phc FROM office_users")
        .fetch_all(&pool)
        .await
        .unwrap();
    let salt: Vec<u8> = sqlx::query_scalar("SELECT badge_salt FROM site WHERE id = 1")
        .fetch_one(&pool)
        .await
        .unwrap();
    pool.close().await;

    drop(client);
    host.stop().await.unwrap();
    drop(guard);

    let mut log = String::new();
    for entry in std::fs::read_dir(paths.logs_dir()).unwrap() {
        log.push_str(&std::fs::read_to_string(entry.unwrap().path()).unwrap());
    }
    assert!(
        log.contains("markiro-host listening"),
        "the log must not be empty"
    );
    let salt_hex: String = salt.iter().map(|byte| format!("{byte:02x}")).collect();
    let salt_standard_base64 = base64::engine::general_purpose::STANDARD.encode(&salt);
    let mut secrets = vec![
        key,
        token,
        tech_token,
        tech_new_token,
        "correct horse battery".to_owned(),
        "not the password".to_owned(),
        "technologist password".to_owned(),
        tech_new_password.to_owned(),
        wrong_current_password.to_owned(),
        third_password.to_owned(),
        wrong_device_key.to_owned(),
        wrong_session_token.to_owned(),
        salt_hex,
        salt_standard_base64,
        "pbkdf2$".to_owned(),
    ];
    secrets.extend(hashes);
    for secret in secrets {
        assert!(!log.contains(&secret), "the process log contains a secret");
    }
}
