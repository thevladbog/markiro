//! Spec §4.10: the process log never holds device keys, session tokens,
//! passwords, password, PIN and badge hashes, pairing codes, the badge salt
//! or the TLS private key. A label template's layout is no secret, but at
//! up to 256 KB it stays out of the log too, a shift's snapshot that carries
//! one included. Its own binary, because it installs the global tracing
//! subscriber.

mod support;

use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD, URL_SAFE_NO_PAD};
use base64::Engine;
use markiro_host::config::HostPaths;
use markiro_host::{start, StartOptions};
use serde_json::json;

/// `pinPhc` of `proto/fixtures/phc-password.json`: the PIN 4821.
const PIN_PHC: &str =
    "pbkdf2$sha256$100000$bWFya2lyby1waW4tc2FsdA==$3OKvrZ2+EfTB2zsCso90r5g8c6Ib6t+Bv+cGJOpgPmU=";

/// A layout whose only text is `marker`, so the log can be searched for it.
fn layout(marker: &str) -> serde_json::Value {
    json!({
        "widthMm": 58, "heightMm": 40, "dpi": 203, "language": "zpl",
        "elements": [{ "kind": "text", "id": "t", "xMm": 2, "yMm": 2, "text": marker, "fontSizePt": 8 }]
    })
}

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
    let wizard = client
        .post(format!("{base}/v1/bootstrap"))
        .header(protocol.0, &protocol.1)
        .bearer_auth(&key)
        .json(&json!({
            "admin": { "login": "admin", "name": "Ирина", "password": "correct horse battery" },
            "org": { "name": "ООО «Атолл»", "gln": "4600682000010", "gs1Prefixes": [], "timeZone": "Europe/Moscow" },
            "sscc": { "boxNextSerial": 1, "palletNextSerial": 0 },
            "lines": ["Линия 1"],
            "templates": [{
                "name": "Коробка 58×40", "purpose": "box",
                "spec": layout("layout-marker-stock"), "orgDefault": true
            }]
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(wizard.status(), 200);
    let session: serde_json::Value = wizard.json().await.unwrap();
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

    // A pairing code and a device paired with it: neither the code, the
    // payload carrying it, nor the new device key may reach the log.
    let pairing: serde_json::Value = client
        .post(format!("{base}/v1/office/pairing-codes"))
        .header(protocol.0, &protocol.1)
        .header(markiro_proto::OFFICE_SESSION_HEADER, &token)
        .bearer_auth(&key)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let pairing_code = pairing["code"].as_str().unwrap().to_owned();
    let pairing_payload = pairing["payload"].as_str().unwrap().to_owned();
    let claimed: serde_json::Value = client
        .post(format!("{base}/v1/pairing/claim"))
        .header(protocol.0, &protocol.1)
        .json(&json!({ "code": pairing_code, "kind": "station", "name": "Станция 2", "appVersion": "0.1.0" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let claimed_key = claimed["deviceKey"].as_str().unwrap().to_owned();

    // A refused claim is logged too, on the denied path: reusing the
    // already-claimed code produces a `code_used` refusal, and the code
    // itself is already a `secrets` needle below (an arbitrary wrong code,
    // such as "0000000000", would not be, so it would not prove anything).
    let refused_claim = client
        .post(format!("{base}/v1/pairing/claim"))
        .header(protocol.0, &protocol.1)
        .json(&json!({ "code": pairing_code, "kind": "station", "name": "Станция 3", "appVersion": "0.1.0" }))
        .send()
        .await
        .unwrap();
    assert_eq!(refused_claim.status(), 400);
    let refused_claim: serde_json::Value = refused_claim.json().await.unwrap();
    assert_eq!(refused_claim["error"]["code"], "pairing_code_invalid");

    // An operator with a PIN, a badge added and revoked, and the feed that
    // carries both hashes to stations: no hash may reach the log, and
    // neither may the badge salt the office reads. The refusals and the PIN
    // change go through the same handlers, so they are part of the flow.
    let operator: serde_json::Value = client
        .post(format!("{base}/v1/office/operators"))
        .header(protocol.0, &protocol.1)
        .header(markiro_proto::OFFICE_SESSION_HEADER, &token)
        .bearer_auth(&key)
        .json(&json!({ "login": "0042", "name": "Анна", "pinPhc": PIN_PHC }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let operator_id = operator["id"].as_str().unwrap().to_owned();
    let badge_salt: serde_json::Value = client
        .get(format!("{base}/v1/office/badge-salt"))
        .header(protocol.0, &protocol.1)
        .header(markiro_proto::OFFICE_SESSION_HEADER, &token)
        .bearer_auth(&key)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let badge_phc = format!(
        "pbkdf2$sha256$100000${}${}",
        badge_salt["badgeSalt"].as_str().unwrap(),
        STANDARD.encode([7u8; 32])
    );
    let badge: serde_json::Value = client
        .post(format!("{base}/v1/office/operators/{operator_id}/badges"))
        .header(protocol.0, &protocol.1)
        .header(markiro_proto::OFFICE_SESSION_HEADER, &token)
        .bearer_auth(&key)
        .json(&json!({ "badgePhc": badge_phc }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    // A hash with another salt is refused (`validation_failed`)...
    let wrong_salt_phc = format!(
        "pbkdf2$sha256$100000${}${}",
        STANDARD.encode([0xa5u8; 16]),
        STANDARD.encode([8u8; 32])
    );
    let wrong_salt = client
        .post(format!("{base}/v1/office/operators/{operator_id}/badges"))
        .header(protocol.0, &protocol.1)
        .header(markiro_proto::OFFICE_SESSION_HEADER, &token)
        .bearer_auth(&key)
        .json(&json!({ "badgePhc": wrong_salt_phc }))
        .send()
        .await
        .unwrap();
    assert_eq!(wrong_salt.status(), 400);
    let wrong_salt: serde_json::Value = wrong_salt.json().await.unwrap();
    assert_eq!(wrong_salt["error"]["code"], "validation_failed");
    assert_eq!(wrong_salt["error"]["details"]["field"], "badgePhc");
    // ...the same badge twice is a `conflict`, mapped from the database
    // error...
    let duplicate = client
        .post(format!("{base}/v1/office/operators/{operator_id}/badges"))
        .header(protocol.0, &protocol.1)
        .header(markiro_proto::OFFICE_SESSION_HEADER, &token)
        .bearer_auth(&key)
        .json(&json!({ "badgePhc": badge_phc }))
        .send()
        .await
        .unwrap();
    assert_eq!(duplicate.status(), 409);
    let duplicate: serde_json::Value = duplicate.json().await.unwrap();
    assert_eq!(duplicate["error"]["code"], "conflict");
    assert_eq!(duplicate["error"]["details"]["constraint"], "badge");
    // ...and a new PIN hash replaces the operator's.
    let new_pin_phc = format!(
        "pbkdf2$sha256$100000$bWFya2lyby1waW4tc2FsdA==${}",
        STANDARD.encode([9u8; 32])
    );
    let pin_changed = client
        .put(format!("{base}/v1/office/operators/{operator_id}"))
        .header(protocol.0, &protocol.1)
        .header(markiro_proto::OFFICE_SESSION_HEADER, &token)
        .bearer_auth(&key)
        .json(&json!({ "pinPhc": new_pin_phc, "expectedRev": operator["rev"] }))
        .send()
        .await
        .unwrap();
    assert_eq!(pin_changed.status(), 200);
    let feed = client
        .get(format!("{base}/v1/changes?since=0"))
        .header(protocol.0, &protocol.1)
        .bearer_auth(&key)
        .send()
        .await
        .unwrap();
    assert_eq!(feed.status(), 200);
    let revoked = client
        .delete(format!(
            "{base}/v1/office/operators/{operator_id}/badges/{}",
            badge["id"].as_str().unwrap()
        ))
        .header(protocol.0, &protocol.1)
        .header(markiro_proto::OFFICE_SESSION_HEADER, &token)
        .bearer_auth(&key)
        .send()
        .await
        .unwrap();
    assert_eq!(revoked.status(), 204);

    // The catalog: a template of the office's own and a new layout for it,
    // both read back (the list and the template), a product that prefers it,
    // the defaults that name it, a refused delete and the feed that carries
    // every layout: none may reach the log.
    let office_template = client
        .post(format!("{base}/v1/office/templates"))
        .header(protocol.0, &protocol.1)
        .header(markiro_proto::OFFICE_SESSION_HEADER, &token)
        .bearer_auth(&key)
        .json(&json!({
            "name": "Молоко 58×40", "purpose": "box", "enabled": true,
            "spec": layout("layout-marker-office-1")
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(office_template.status(), 200);
    let office_template: serde_json::Value = office_template.json().await.unwrap();
    let template_id = office_template["id"].as_str().unwrap().to_owned();
    let relaid = client
        .put(format!("{base}/v1/office/templates/{template_id}"))
        .header(protocol.0, &protocol.1)
        .header(markiro_proto::OFFICE_SESSION_HEADER, &token)
        .bearer_auth(&key)
        .json(&json!({ "spec": layout("layout-marker-office-2"), "expectedRev": office_template["rev"] }))
        .send()
        .await
        .unwrap();
    assert_eq!(relaid.status(), 200);
    // The routes that read templates back: the list holds summaries, one
    // template its layout (the office's second one by now), and a read could
    // log what it serves as well as a write.
    let template_list = client
        .get(format!("{base}/v1/office/templates"))
        .header(protocol.0, &protocol.1)
        .header(markiro_proto::OFFICE_SESSION_HEADER, &token)
        .bearer_auth(&key)
        .send()
        .await
        .unwrap();
    assert_eq!(template_list.status(), 200);
    let template_read = client
        .get(format!("{base}/v1/office/templates/{template_id}"))
        .header(protocol.0, &protocol.1)
        .header(markiro_proto::OFFICE_SESSION_HEADER, &token)
        .bearer_auth(&key)
        .send()
        .await
        .unwrap();
    assert_eq!(template_read.status(), 200);
    let template_read = template_read.text().await.unwrap();
    assert!(
        template_read.contains("layout-marker-office-2"),
        "the read route serves the layout it keeps"
    );
    let product = client
        .post(format!("{base}/v1/office/products"))
        .header(protocol.0, &protocol.1)
        .header(markiro_proto::OFFICE_SESSION_HEADER, &token)
        .bearer_auth(&key)
        .json(&json!({ "gtin14": "04600682000013", "name": "Молоко", "defaultBoxTemplateId": template_id }))
        .send()
        .await
        .unwrap();
    assert_eq!(product.status(), 200);
    let defaults = client
        .get(format!("{base}/v1/office/template-defaults"))
        .header(protocol.0, &protocol.1)
        .header(markiro_proto::OFFICE_SESSION_HEADER, &token)
        .bearer_auth(&key)
        .send()
        .await
        .unwrap();
    assert_eq!(defaults.status(), 200);
    let defaults: serde_json::Value = defaults.json().await.unwrap();
    let defaults_set = client
        .put(format!("{base}/v1/office/template-defaults"))
        .header(protocol.0, &protocol.1)
        .header(markiro_proto::OFFICE_SESSION_HEADER, &token)
        .bearer_auth(&key)
        .json(&json!({ "defaultBoxTemplateId": template_id, "categories": [], "expectedRev": defaults["rev"] }))
        .send()
        .await
        .unwrap();
    assert_eq!(defaults_set.status(), 200);
    let refused_delete = client
        .delete(format!("{base}/v1/office/templates/{template_id}"))
        .header(protocol.0, &protocol.1)
        .header(markiro_proto::OFFICE_SESSION_HEADER, &token)
        .bearer_auth(&key)
        .send()
        .await
        .unwrap();
    assert_eq!(refused_delete.status(), 409);
    let catalog_feed = client
        .get(format!("{base}/v1/changes?since=0"))
        .header(protocol.0, &protocol.1)
        .bearer_auth(&key)
        .send()
        .await
        .unwrap();
    assert_eq!(catalog_feed.status(), 200);

    // A shift (plan 2a1): planned with the office's template, opened by the
    // station, which gets the snapshot with the whole layout, read back in
    // its list, given an SSCC block, and closed by the office. The layout
    // is in the snapshot the host keeps, never in the log.
    let lines: serde_json::Value = client
        .get(format!("{base}/v1/office/lines"))
        .header(protocol.0, &protocol.1)
        .header(markiro_proto::OFFICE_SESSION_HEADER, &token)
        .bearer_auth(&key)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let line_id = lines[0]["id"].as_str().unwrap().to_owned();
    let on_line = client
        .put(format!("{base}/v1/device/line"))
        .header(protocol.0, &protocol.1)
        .bearer_auth(&key)
        .json(&json!({ "lineId": line_id }))
        .send()
        .await
        .unwrap();
    assert_eq!(on_line.status(), 200);
    let milk: serde_json::Value = client
        .post(format!("{base}/v1/office/products"))
        .header(protocol.0, &protocol.1)
        .header(markiro_proto::OFFICE_SESSION_HEADER, &token)
        .bearer_auth(&key)
        .json(&json!({
            "gtin14": "04600682000020", "name": "Кефир", "chzProductGroupCode": 8,
            "boxCapacity": 12, "palletBoxCapacity": 40
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let shift: serde_json::Value = client
        .post(format!("{base}/v1/office/shifts"))
        .header(protocol.0, &protocol.1)
        .header(markiro_proto::OFFICE_SESSION_HEADER, &token)
        .bearer_auth(&key)
        .json(&json!({
            "productId": milk["id"], "lineId": line_id, "productionDate": "2026-10-08",
            "boxTemplateId": template_id
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let shift_id = shift["id"].as_str().unwrap().to_owned();
    let entered = client
        .post(format!("{base}/v1/device/shifts/{shift_id}/enter"))
        .header(protocol.0, &protocol.1)
        .bearer_auth(&key)
        .send()
        .await
        .unwrap();
    assert_eq!(entered.status(), 200);
    let entered = entered.text().await.unwrap();
    assert!(
        entered.contains("layout-marker-office-2"),
        "the entry carries the snapshot with the layout"
    );
    // The owner enters again, the path that serves the stored snapshot
    // back: it carries the layout too, and no more than the first entry may
    // it reach the log.
    let reentered = client
        .post(format!("{base}/v1/device/shifts/{shift_id}/enter"))
        .header(protocol.0, &protocol.1)
        .bearer_auth(&key)
        .send()
        .await
        .unwrap();
    assert_eq!(reentered.status(), 200);
    assert!(
        reentered
            .text()
            .await
            .unwrap()
            .contains("layout-marker-office-2"),
        "the second entry carries the snapshot with the layout"
    );
    let device_shifts = client
        .get(format!("{base}/v1/device/shifts"))
        .header(protocol.0, &protocol.1)
        .bearer_auth(&key)
        .send()
        .await
        .unwrap();
    assert_eq!(device_shifts.status(), 200);
    let block = client
        .post(format!("{base}/v1/device/sscc/blocks"))
        .header(protocol.0, &protocol.1)
        .bearer_auth(&key)
        .json(&json!({
            "requestId": "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a",
            "issuerPrefix": "460068200", "extension": 0
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(block.status(), 200);
    let opened: serde_json::Value = client
        .get(format!("{base}/v1/office/shifts/{shift_id}"))
        .header(protocol.0, &protocol.1)
        .header(markiro_proto::OFFICE_SESSION_HEADER, &token)
        .bearer_auth(&key)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let closed = client
        .post(format!("{base}/v1/office/shifts/{shift_id}/close"))
        .header(protocol.0, &protocol.1)
        .header(markiro_proto::OFFICE_SESSION_HEADER, &token)
        .bearer_auth(&key)
        .json(&json!({ "reason": "Проверка журнала", "expectedRev": opened["rev"] }))
        .send()
        .await
        .unwrap();
    assert_eq!(closed.status(), 200);

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
    let device_key_hashes: Vec<String> = sqlx::query_scalar("SELECT key_hash FROM devices")
        .fetch_all(&pool)
        .await
        .unwrap();
    let pairing_code_hashes: Vec<String> =
        sqlx::query_scalar("SELECT code_hash FROM pairing_codes")
            .fetch_all(&pool)
            .await
            .unwrap();
    let salt: Vec<u8> = sqlx::query_scalar("SELECT badge_salt FROM site WHERE id = 1")
        .fetch_one(&pool)
        .await
        .unwrap();
    // The layouts the host kept: the stock one and the office's current one.
    // (The first office layout was replaced; the flows above were checked by
    // their statuses, this shows the markers really reached the host, or
    // their absence from the log would prove nothing.)
    let layouts: Vec<String> = sqlx::query_scalar("SELECT spec FROM label_templates")
        .fetch_all(&pool)
        .await
        .unwrap();
    let snapshots: Vec<String> =
        sqlx::query_scalar("SELECT snapshot FROM shifts WHERE snapshot IS NOT NULL")
            .fetch_all(&pool)
            .await
            .unwrap();
    let key_der = std::fs::read(paths.tls_dir().join("key.der")).unwrap();
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
    let key_der_base64 = STANDARD.encode(&key_der);
    let key_der_base64_first_line = key_der_base64
        .get(..64)
        .expect("a DER-encoded TLS key base64-encodes to more than 64 characters")
        .to_owned();
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
        pairing_code,
        pairing_payload,
        claimed_key,
        PIN_PHC.to_owned(),
        "3OKvrZ2+EfTB2zsCso90r5g8c6Ib6t+Bv+cGJOpgPmU=".to_owned(),
        badge_phc,
        STANDARD.encode([7u8; 32]),
        wrong_salt_phc,
        STANDARD.encode([8u8; 32]),
        new_pin_phc,
        STANDARD.encode([9u8; 32]),
        format!("{salt:?}"),
        salt_hex,
        salt_standard_base64,
        STANDARD_NO_PAD.encode(&salt),
        URL_SAFE_NO_PAD.encode(&salt),
        format!("{key_der:?}"),
        // A PEM dump wraps at 64 columns, so the full base64 string might
        // never appear contiguous in a formatted log; its first line would.
        key_der_base64_first_line,
        key_der_base64,
        key_der
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>(),
        "pbkdf2$".to_owned(),
    ];
    secrets.extend(hashes);
    secrets.extend(device_key_hashes);
    secrets.extend(pairing_code_hashes);
    for secret in secrets {
        assert!(!log.contains(&secret), "the process log contains a secret");
    }
    for layout in [
        "layout-marker-stock",
        "layout-marker-office-1",
        "layout-marker-office-2",
    ] {
        assert!(!log.contains(layout), "the process log contains {layout}");
    }
    for kept in ["layout-marker-stock", "layout-marker-office-2"] {
        assert!(
            layouts.iter().any(|spec| spec.contains(kept)),
            "the host never kept {kept}"
        );
    }
    assert!(
        snapshots
            .iter()
            .any(|snapshot| snapshot.contains("layout-marker-office-2")),
        "the shift never froze the layout"
    );
}
