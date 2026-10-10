//! Spec §4.10: the process log never holds device keys, session tokens,
//! passwords, password, PIN and badge hashes, pairing codes, the badge salt
//! or the TLS private key. A label template's layout is no secret, but at
//! up to 256 KB it stays out of the log too, a shift's snapshot that carries
//! one included. Nor does a fact's code of marking, its crypto tail, its
//! hash, a box's SSCC or the words of a reason (stage 2a spec §4.11): a
//! rejected record is logged by its id and its receipt code alone. Its own
//! binary, because it installs the global tracing subscriber.

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

/// The GS1 group separator, between the groups of a code of marking.
const GS: char = '\u{1d}';

/// A code of marking as a line scans it: a 31-character key (`01`, the
/// GTIN, `21`, a serial of 13 characters), then the verification key (`91`)
/// and the crypto tail (`92`, 44 characters of base64), the groups divided
/// by the separator. `tag` opens the tail, so each code's tail tells it
/// apart in a log.
struct Marking {
    key: String,
    gtin14: String,
    serial: String,
    tail: String,
    canonical: String,
    hash: String,
}

impl Marking {
    fn new(gtin14: &str, serial: &str, tag: &str) -> Self {
        assert_eq!(serial.len(), 13);
        let key = format!("01{gtin14}21{serial}");
        assert_eq!(key.len(), 31);
        let tail: String = format!("{tag}Zm9vYmFyYmF6cXV4Y3J5cHRvdGFpbHN1ZmZpeFVLTFE9PQ")
            .chars()
            .take(44)
            .collect();
        let canonical = format!("{key}{GS}91EE11{GS}92{tail}");
        let hash = aws_lc_rs::digest::digest(&aws_lc_rs::digest::SHA256, canonical.as_bytes())
            .as_ref()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        Self {
            key,
            gtin14: gtin14.to_owned(),
            serial: serial.to_owned(),
            tail,
            canonical,
            hash,
        }
    }

    /// The `code` of a scan fact.
    fn code(&self) -> serde_json::Value {
        json!({
            "codeHash": self.hash, "gtin14": self.gtin14, "serial": self.serial,
            "canonical": self.canonical
        })
    }

    /// What the log must hold none of once the code is a fact's.
    fn needles(&self) -> Vec<String> {
        vec![
            self.canonical.clone(),
            self.key.clone(),
            self.serial.clone(),
            self.tail.clone(),
            self.hash.clone(),
        ]
    }
}

/// The `data` of a scan fact.
fn scan_data(
    verdict: &str,
    duplicate_source: Option<&str>,
    raw_length: u32,
    code: Option<serde_json::Value>,
    box_id: Option<&str>,
    scanned_at: &str,
) -> serde_json::Value {
    json!({
        "scannedAt": scanned_at, "verdict": verdict, "duplicateSource": duplicate_source,
        "rawKind": if code.is_some() { "km" } else { "unknown" },
        "rawLength": raw_length, "code": code, "boxId": box_id
    })
}

/// A record of `kind` in `shift`, by `operator`.
fn record(
    id: &str,
    kind: &str,
    shift: &str,
    operator: &str,
    data: serde_json::Value,
) -> serde_json::Value {
    json!({ "id": id, "kind": kind, "shiftId": shift, "operatorId": operator, "data": data })
}

/// A record id: a canonical UUID.
fn rid(n: u32) -> String {
    format!("a1b2c3d4-0000-4000-8000-{n:012}")
}

/// An instant of a device clock, as `Date.toISOString` writes it.
fn device_at(minute: u32, second: u32) -> String {
    format!("2026-10-08T06:{minute:02}:{second:02}.418Z")
}

/// The `data` of a box exception: `code` is the hash and scan instant an
/// undo names, `reason` the reason code and its words.
fn exception_data(
    kind: &str,
    box_id: &str,
    code: Option<(&str, &str)>,
    reason: Option<(&str, &str)>,
    occurred_at: &str,
) -> serde_json::Value {
    json!({
        "exception": kind, "boxId": box_id,
        "codeHash": code.map(|(hash, _)| hash), "targetScannedAt": code.map(|(_, scanned)| scanned),
        "reasonCode": reason.map(|(code, _)| code), "reasonText": reason.map(|(_, text)| text),
        "occurredAt": occurred_at
    })
}

/// The `data` of a box closed with serial `serial` of `block_id`, holding
/// the codes `members`.
fn box_closed_data(
    box_id: &str,
    block_id: &serde_json::Value,
    serial: u64,
    members: &[&Marking],
    closed_at: &str,
) -> serde_json::Value {
    let hashes: Vec<String> = members.iter().map(|code| code.hash.clone()).collect();
    json!({
        "boxId": box_id, "sscc": support::app::sscc_under("460068200", serial),
        "blockId": block_id, "serial": serial,
        "openedAt": device_at(15, 2), "closedAt": closed_at, "itemCount": hashes.len().max(1),
        "membershipDigest": markiro_host::facts::rules::box_membership_digest(&hashes)
    })
}

/// The `data` of a box closed with an SSCC under another issuer `prefix`
/// than the shift's: the host refuses it by its form.
fn box_closed_data_under(
    box_id: &str,
    block_id: &serde_json::Value,
    prefix: &str,
    serial: u64,
    closed_at: &str,
) -> serde_json::Value {
    let mut data = box_closed_data(box_id, block_id, serial, &[], closed_at);
    data["sscc"] = json!(support::app::sscc_under(prefix, serial));
    data
}

/// A batch of facts sent as the station of `key`; answers its receipts.
async fn send_facts(
    client: &reqwest::Client,
    base: &str,
    protocol: &(&str, String),
    key: &str,
    records: &[serde_json::Value],
) -> Vec<serde_json::Value> {
    let sent = client
        .post(format!("{base}/v1/device/facts"))
        .header(protocol.0, &protocol.1)
        .bearer_auth(key)
        .json(&json!({ "records": records }))
        .send()
        .await
        .unwrap();
    assert_eq!(sent.status(), 200);
    let body: serde_json::Value = sent.json().await.unwrap();
    body["receipts"].as_array().unwrap().clone()
}

/// The receipt answers record `id` with `outcome`, and `code` when refused.
fn assert_receipt(
    receipt: &serde_json::Value,
    id: Option<&str>,
    outcome: &str,
    code: Option<&str>,
) {
    assert_eq!(receipt["id"], json!(id), "{receipt}");
    assert_eq!(receipt["outcome"], outcome, "{receipt}");
    assert_eq!(
        receipt.get("code").and_then(|code| code.as_str()),
        code,
        "{receipt}"
    );
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
    let block: serde_json::Value = block.json().await.unwrap();

    // Facts (plan 2a2): every kind, accepted and refused, through the real
    // server with production-like values: codes of marking with a crypto
    // tail and group separators, 18-digit SSCCs, reasons in words. None of
    // the codes, tails, hashes, SSCCs or words reaches the log; a refusal
    // is logged by its record's id and its receipt code.
    let from_serial = block["fromSerial"].as_u64().unwrap();
    let to_serial = block["toSerial"].as_u64().unwrap();
    let sh = shift_id.as_str();
    let op = operator_id.as_str();
    let (box1, box2, ghost_box) = (
        "8e1f2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b",
        "9f2a3b4c-5d6e-4f70-8b9c-1d2e3f4a5b6c",
        "a03b4c5d-6e7f-4081-8c9d-2e3f4a5b6c7d",
    );
    let km_a = Marking::new("04600682000020", "5Kp9sQxLm2w7R", "Tl7Kq2");
    let km_b = Marking::new("04600682000020", "7Tz3mHd8Vc1Nq", "Vb4Wn9");
    let km_foreign = Marking::new("04600682000106", "5Rf2wLzQp8s1D", "Zc6Hj3");
    let km_broken = Marking::new("04600682000020", "9Xc4vBn6Mk3Ed", "Qe8Ls5");
    let km_late_in_box = Marking::new("04600682000020", "3Ga6yJt2Wd9Pf", "Hn3Rx7");
    let km_unreadable = Marking::new("04600682000020", "4Lm8zKc5Sb7Ue", "Dy2Mp6");
    let km_unknown_kind = Marking::new("04600682000020", "6Nh1qVw9Xa4Tg", "Fk9Bs4");
    let km_unknown_shift = Marking::new("04600682000020", "8Pj5rZe3Yc6Vh", "Gm5Cw8");
    let reprint_words = "Этикетка смята на аппликаторе, reason-marker-reprint";
    let disassemble_words = "Короб собран не на ту продукцию, reason-marker-disassemble";
    let refused_state_words = "Разбираю открытый короб, reason-marker-refused-state";
    let overlong_words = format!("reason-marker-overlong-{}", "я".repeat(200));
    let raw_length = |code: &Marking| u32::try_from(code.canonical.chars().count()).unwrap();
    let scan_ok = |n: u32, code: &Marking, box_id: &str, second: u32| {
        record(
            &rid(n),
            "scan",
            sh,
            op,
            scan_data(
                "ok",
                None,
                raw_length(code),
                Some(code.code()),
                Some(box_id),
                &device_at(15, second),
            ),
        )
    };
    let mut broken_code = km_broken.code();
    broken_code["canonical"] = json!(format!("{}\0", km_broken.canonical));
    let sscc_one = support::app::sscc_under("460068200", from_serial);
    let sscc_two = support::app::sscc_under("460068200", from_serial + 1);
    let sscc_beyond = support::app::sscc_under("460068200", to_serial + 1);
    let mut unreadable = scan_ok(21, &km_unreadable, box1, 40);
    unreadable["id"] = json!("not-a-record-id");
    let mut unknown_kind = scan_ok(22, &km_unknown_kind, box1, 41);
    unknown_kind["kind"] = json!("pallet_closed");
    let mut unknown_shift = scan_ok(23, &km_unknown_shift, box1, 42);
    unknown_shift["shiftId"] = json!("c14d5e6f-7a8b-4c9d-8e0f-3a4b5c6d7e8f");
    let facts = vec![
        scan_ok(1, &km_a, box1, 2),
        scan_ok(2, &km_b, box1, 5),
        scan_ok(3, &km_foreign, box1, 7),
        record(
            &rid(4),
            "scan",
            sh,
            op,
            scan_data(
                "wrong_gtin",
                None,
                raw_length(&km_foreign),
                Some(km_foreign.code()),
                None,
                &device_at(15, 9),
            ),
        ),
        record(
            &rid(5),
            "scan",
            sh,
            op,
            scan_data(
                "duplicate",
                Some("local"),
                raw_length(&km_a),
                Some(km_a.code()),
                None,
                &device_at(15, 11),
            ),
        ),
        record(
            &rid(6),
            "scan",
            sh,
            op,
            scan_data("invalid", None, 21, None, None, &device_at(15, 13)),
        ),
        record(
            &rid(7),
            "scan",
            sh,
            op,
            scan_data(
                "ok",
                None,
                raw_length(&km_broken),
                Some(broken_code),
                Some(box1),
                &device_at(15, 15),
            ),
        ),
        scan_ok(8, &km_a, box2, 20),
        record(
            &rid(9),
            "box_exception",
            sh,
            op,
            exception_data(
                "undo",
                box1,
                Some((&km_b.hash, &device_at(15, 5))),
                None,
                &device_at(15, 25),
            ),
        ),
        record(
            &rid(10),
            "box_exception",
            sh,
            op,
            exception_data(
                "undo",
                ghost_box,
                Some((&km_b.hash, &device_at(15, 5))),
                None,
                &device_at(15, 26),
            ),
        ),
        record(
            &rid(11),
            "box_exception",
            sh,
            op,
            exception_data(
                "disassemble",
                box1,
                None,
                Some(("other", refused_state_words)),
                &device_at(15, 27),
            ),
        ),
        record(
            &rid(12),
            "box_exception",
            sh,
            op,
            exception_data(
                "reprint",
                box1,
                None,
                Some(("other", refused_state_words)),
                &device_at(15, 28),
            ),
        ),
        record(
            &rid(13),
            "box_exception",
            sh,
            op,
            exception_data(
                "reprint",
                box1,
                None,
                Some(("other", &overlong_words)),
                &device_at(15, 29),
            ),
        ),
        record(
            &rid(14),
            "box_closed",
            sh,
            op,
            box_closed_data(
                box1,
                &block["id"],
                from_serial,
                &[&km_a],
                &device_at(21, 47),
            ),
        ),
        record(
            &rid(15),
            "box_closed",
            sh,
            op,
            box_closed_data(
                box1,
                &block["id"],
                from_serial + 1,
                &[&km_a],
                &device_at(21, 48),
            ),
        ),
        record(
            &rid(16),
            "box_closed",
            sh,
            op,
            box_closed_data(box2, &block["id"], to_serial + 1, &[], &device_at(22, 1)),
        ),
        record(
            &rid(25),
            "box_closed",
            sh,
            op,
            box_closed_data_under(
                box2,
                &block["id"],
                "999999999",
                from_serial + 1,
                &device_at(22, 1),
            ),
        ),
        record(
            &rid(17),
            "box_closed",
            sh,
            op,
            box_closed_data(box2, &block["id"], from_serial + 1, &[], &device_at(22, 2)),
        ),
        record(
            &rid(18),
            "box_label",
            sh,
            op,
            json!({ "boxId": box1, "outcome": "verified", "at": device_at(21, 55) }),
        ),
        record(
            &rid(19),
            "box_exception",
            sh,
            op,
            exception_data(
                "reprint",
                box1,
                None,
                Some(("other", reprint_words)),
                &device_at(24, 10),
            ),
        ),
        record(
            &rid(20),
            "box_exception",
            sh,
            op,
            exception_data(
                "disassemble",
                box2,
                None,
                Some(("other", disassemble_words)),
                &device_at(24, 30),
            ),
        ),
        unreadable,
        unknown_kind,
        unknown_shift,
        scan_ok(24, &km_late_in_box, box1, 50),
    ];
    // (outcome, code) of each record's receipt.
    let expected = [
        ("accepted", None),
        ("accepted", None),
        ("rejected", Some("gtin_mismatch")),
        ("accepted", None),
        ("accepted", None),
        ("accepted", None),
        ("rejected", Some("invalid_record")),
        ("conflict", None),
        ("accepted", None),
        ("rejected", Some("box_unknown")),
        ("rejected", Some("box_state")),
        ("rejected", Some("box_state")),
        ("rejected", Some("invalid_record")),
        ("accepted", None),
        ("rejected", Some("box_already_closed")),
        ("rejected", Some("sscc_not_issued")),
        ("rejected", Some("sscc_not_issued")),
        ("accepted", None),
        ("accepted", None),
        ("accepted", None),
        ("accepted", None),
        ("rejected", Some("invalid_record")),
        ("rejected", Some("invalid_record")),
        ("rejected", Some("unknown_shift")),
        ("rejected", Some("box_closed")),
    ];
    assert_eq!(facts.len(), expected.len());
    let receipts = send_facts(&client, &base, &protocol, &key, &facts).await;
    assert_eq!(receipts.len(), facts.len());
    for ((receipt, record), (outcome, code)) in receipts.iter().zip(&facts).zip(expected) {
        // The record with no readable id is answered with no id.
        let id = record["id"].as_str().filter(|id| *id != "not-a-record-id");
        assert_receipt(receipt, id, outcome, code);
    }
    assert_eq!(receipts[7]["details"]["winner"]["sameDevice"], true);

    // The same batch again answers the stored receipts (and the refused
    // ones the same, each by its record's id); the same ids with other
    // content are `payload_mismatch`.
    let again = send_facts(&client, &base, &protocol, &key, &facts).await;
    assert_eq!(again.len(), receipts.len());
    for (before, after) in receipts.iter().zip(&again) {
        assert_eq!(before, after);
    }
    let sent = |n: u32| {
        facts
            .iter()
            .find(|fact| fact["id"] == json!(rid(n)))
            .unwrap()
            .clone()
    };
    let mut changed_scan = sent(1);
    changed_scan["data"]["rawLength"] = json!(58);
    let mut changed_reprint = sent(19);
    changed_reprint["data"]["reasonText"] = json!("reason-marker-reprint-changed");
    let mut changed_close = sent(14);
    changed_close["data"]["itemCount"] = json!(2);
    let mismatched = send_facts(
        &client,
        &base,
        &protocol,
        &key,
        &[changed_scan, changed_reprint, changed_close],
    )
    .await;
    for (receipt, n) in mismatched.iter().zip([1, 19, 14]) {
        assert_receipt(receipt, Some(&rid(n)), "rejected", Some("payload_mismatch"));
    }

    // The code check: a code the host holds, one it does not (the undone
    // one), and a hash that is no hash.
    let taken = client
        .get(format!("{base}/v1/device/codes/{}", km_a.hash))
        .header(protocol.0, &protocol.1)
        .bearer_auth(&key)
        .send()
        .await
        .unwrap();
    assert_eq!(taken.status(), 200);
    let taken: serde_json::Value = taken.json().await.unwrap();
    assert_eq!(taken["status"], "taken", "{taken}");
    let free = client
        .get(format!("{base}/v1/device/codes/{}", km_b.hash))
        .header(protocol.0, &protocol.1)
        .bearer_auth(&key)
        .send()
        .await
        .unwrap();
    assert_eq!(free.status(), 200);
    let free: serde_json::Value = free.json().await.unwrap();
    assert_eq!(free["status"], "free", "{free}");
    let malformed_hash = km_a.hash.to_uppercase();
    let malformed = client
        .get(format!("{base}/v1/device/codes/{malformed_hash}"))
        .header(protocol.0, &protocol.1)
        .bearer_auth(&key)
        .send()
        .await
        .unwrap();
    assert_eq!(malformed.status(), 400);

    // The totals the facts gave: one shift read, and the list.
    let totals_of_shift: serde_json::Value = client
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
    assert_eq!(
        totals_of_shift["totals"]["acceptedUnits"], 1,
        "{totals_of_shift}"
    );
    assert_eq!(
        totals_of_shift["totals"]["closedBoxes"], 1,
        "{totals_of_shift}"
    );
    let shift_list = client
        .get(format!("{base}/v1/office/shifts"))
        .header(protocol.0, &protocol.1)
        .header(markiro_proto::OFFICE_SESSION_HEADER, &token)
        .bearer_auth(&key)
        .send()
        .await
        .unwrap();
    assert_eq!(shift_list.status(), 200);
    assert!(shift_list.text().await.unwrap().contains("totals"));

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

    // The office closed the shift, and the station's facts still come: a
    // late scan marks the shift, and the station's own close of it answers
    // `alreadyClosed`.
    let km_late = Marking::new("04600682000020", "2Bd7nKs4Ht9Gw", "Jr6Ae2");
    let box_late = "b14c5d6e-7f80-4192-8da0-4b5c6d7e8f90";
    let late = send_facts(
        &client,
        &base,
        &protocol,
        &key,
        &[
            record(
                &rid(30),
                "scan",
                sh,
                op,
                scan_data(
                    "ok",
                    None,
                    raw_length(&km_late),
                    Some(km_late.code()),
                    Some(box_late),
                    &device_at(30, 5),
                ),
            ),
            record(
                &rid(31),
                "shift_closed",
                sh,
                op,
                json!({
                    "plannedQtySnapshot": 1200, "actualQty": 1188, "closedBoxCount": 99,
                    "reasonCode": "material_shortage", "closedAt": device_at(31, 10)
                }),
            ),
        ],
    )
    .await;
    assert_receipt(&late[0], Some(&rid(30)), "accepted", None);
    assert_receipt(&late[1], Some(&rid(31)), "accepted", None);
    assert_eq!(late[1]["details"]["alreadyClosed"], true, "{}", late[1]);

    // A batch the host cannot write: the journal row of its record exists
    // without a receipt (a state no route leaves), so the scan's insert
    // breaks the unique index and the batch is a server error. The
    // database's own words are logged; the record's are not.
    let pool = markiro_host::db::open(&paths.database_file())
        .await
        .unwrap();
    let station_id = pair["deviceId"].as_str().unwrap().to_owned();
    sqlx::query(
        "INSERT INTO scans (id, record_id, device_id, shift_id, verdict, raw_kind, raw_length, \
         scanned_at, received_at) VALUES (?, ?, ?, ?, 'invalid', 'unknown', 0, ?, ?)",
    )
    .bind("d25e6f70-8192-4a3b-8c4d-5e6f708192a3")
    .bind(rid(40))
    .bind(&station_id)
    .bind(&shift_id)
    .bind(device_at(32, 0))
    .bind(device_at(32, 0))
    .execute(&pool)
    .await
    .unwrap();
    let km_failing = Marking::new("04600682000020", "1Cd5mHt8Jp3Qs", "Lw4Yt9");
    let failed = client
        .post(format!("{base}/v1/device/facts"))
        .header(protocol.0, &protocol.1)
        .bearer_auth(&key)
        .json(&json!({ "records": [scan_ok(40, &km_failing, "c36f7081-92a3-4b4c-8d5e-6f708192a3b4", 33)] }))
        .send()
        .await
        .unwrap();
    assert_eq!(failed.status(), 500);
    let failed: serde_json::Value = failed.json().await.unwrap();
    assert_eq!(failed["error"]["code"], "internal", "{failed}");
    sqlx::query("DELETE FROM scans WHERE record_id = ?")
        .bind(rid(40))
        .execute(&pool)
        .await
        .unwrap();

    // A second shift, closed by the station itself: its scan, its box, its
    // close, and a late scan after it.
    let shift_two: serde_json::Value = client
        .post(format!("{base}/v1/office/shifts"))
        .header(protocol.0, &protocol.1)
        .header(markiro_proto::OFFICE_SESSION_HEADER, &token)
        .bearer_auth(&key)
        .json(&json!({
            "productId": milk["id"], "lineId": line_id, "productionDate": "2026-10-09",
            "boxTemplateId": template_id
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let shift_two_id = shift_two["id"].as_str().unwrap().to_owned();
    let entered_two = client
        .post(format!("{base}/v1/device/shifts/{shift_two_id}/enter"))
        .header(protocol.0, &protocol.1)
        .bearer_auth(&key)
        .send()
        .await
        .unwrap();
    assert_eq!(entered_two.status(), 200);
    let km_two = Marking::new("04600682000020", "5Wq2vNx7Bd4Kc", "Mt7Zh3");
    let km_two_late = Marking::new("04600682000020", "8Ye3sPf6Lg1Hj", "Nu2Ak8");
    let (box_two, box_two_late) = (
        "d47a8192-a3b4-4c5d-8e6f-708192a3b4c5",
        "e58b92a3-b4c5-4d6e-8f70-8192a3b4c5d6",
    );
    let two_scan = |n: u32, code: &Marking, box_id: &str, second: u32| {
        record(
            &rid(n),
            "scan",
            &shift_two_id,
            op,
            scan_data(
                "ok",
                None,
                raw_length(code),
                Some(code.code()),
                Some(box_id),
                &device_at(40, second),
            ),
        )
    };
    let station_closed = |n: u32| {
        record(
            &rid(n),
            "shift_closed",
            &shift_two_id,
            op,
            json!({
                "plannedQtySnapshot": null, "actualQty": 1, "closedBoxCount": 1,
                "reasonCode": "equipment_stop", "closedAt": device_at(45, 0)
            }),
        )
    };
    let two = send_facts(
        &client,
        &base,
        &protocol,
        &key,
        &[
            two_scan(50, &km_two, box_two, 2),
            record(
                &rid(51),
                "box_closed",
                &shift_two_id,
                op,
                box_closed_data(
                    box_two,
                    &block["id"],
                    from_serial + 2,
                    &[&km_two],
                    &device_at(44, 0),
                ),
            ),
            station_closed(52),
            two_scan(53, &km_two_late, box_two_late, 50),
            station_closed(54),
        ],
    )
    .await;
    for (receipt, n) in two.iter().zip(50..) {
        assert_receipt(receipt, Some(&rid(n)), "accepted", None);
    }
    assert_eq!(two[4]["details"]["alreadyClosed"], true, "{}", two[4]);
    let shift_two_read: serde_json::Value = client
        .get(format!("{base}/v1/office/shifts/{shift_two_id}"))
        .header(protocol.0, &protocol.1)
        .header(markiro_proto::OFFICE_SESSION_HEADER, &token)
        .bearer_auth(&key)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(shift_two_read["status"], "closed", "{shift_two_read}");
    assert_eq!(shift_two_read["closeReasonCode"], "equipment_stop");
    assert!(shift_two_read["lateDataAt"].is_string(), "{shift_two_read}");
    assert_eq!(
        shift_two_read["totals"]["closedBoxes"], 1,
        "{shift_two_read}"
    );

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
    let kept_codes: Vec<String> =
        sqlx::query_scalar("SELECT canonical FROM scans WHERE canonical IS NOT NULL")
            .fetch_all(&pool)
            .await
            .unwrap();
    let kept_ssccs: Vec<String> =
        sqlx::query_scalar("SELECT sscc FROM boxes WHERE sscc IS NOT NULL")
            .fetch_all(&pool)
            .await
            .unwrap();
    let receipt_digests: Vec<String> = sqlx::query_scalar("SELECT digest FROM fact_receipts")
        .fetch_all(&pool)
        .await
        .unwrap();
    assert!(receipt_digests.len() > 30);
    let kept_words: Vec<String> =
        sqlx::query_scalar("SELECT reason_text FROM box_exceptions WHERE reason_text IS NOT NULL")
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

    // The host kept what it accepted and logged the refusals by their
    // receipt codes: the absence of codes, SSCCs and words from the log
    // proves something.
    for kept in [&km_a, &km_b, &km_foreign, &km_late, &km_two, &km_two_late] {
        assert!(
            kept_codes.contains(&kept.canonical),
            "the host never kept {}",
            kept.key
        );
    }
    for refused in [
        &km_broken,
        &km_late_in_box,
        &km_unreadable,
        &km_unknown_kind,
        &km_unknown_shift,
        &km_failing,
    ] {
        assert!(
            !kept_codes.contains(&refused.canonical),
            "the host kept the refused {}",
            refused.key
        );
    }
    for kept in [
        &sscc_one,
        &sscc_two,
        &support::app::sscc_under("460068200", from_serial + 2),
    ] {
        assert!(kept_ssccs.contains(kept), "the host never kept an SSCC");
    }
    assert_eq!(kept_ssccs.len(), 3);
    for kept in [reprint_words, disassemble_words] {
        assert!(kept_words.iter().any(|words| words == kept));
    }
    for rejected in [
        "gtin_mismatch",
        "payload_mismatch",
        "invalid_record",
        "box_unknown",
        "box_state",
        "box_closed",
        "box_already_closed",
        "sscc_not_issued",
        "unknown_shift",
    ] {
        assert!(log.contains(rejected), "the log never named {rejected}");
    }
    for refused in [3, 7, 10, 11, 13, 15, 16, 22, 23, 24] {
        assert!(
            log.contains(&rid(refused)),
            "the log never named the refused record {refused}"
        );
    }
    // The 500 names the database's own failure.
    assert!(log.contains("request failed") && log.contains("UNIQUE constraint failed"));
    let mut needles: Vec<String> = Vec::new();
    for code in [
        &km_a,
        &km_b,
        &km_foreign,
        &km_broken,
        &km_late_in_box,
        &km_unreadable,
        &km_unknown_kind,
        &km_unknown_shift,
        &km_late,
        &km_failing,
        &km_two,
        &km_two_late,
    ] {
        needles.extend(code.needles());
    }
    needles.push(format!("{}\0", km_broken.canonical));
    for sscc in [&sscc_one, &sscc_two, &sscc_beyond] {
        needles.push(sscc.clone());
        needles.push(sscc[..17].to_owned());
    }
    needles.push(support::app::sscc_under("460068200", from_serial + 2));
    // The refused SSCC of another issuer, and the hash a device sent in the
    // wrong case to the code check.
    needles.push(support::app::sscc_under("999999999", from_serial + 1));
    needles.push(malformed_hash.clone());
    // Any hash: the hash of each record the host kept a receipt by, and
    // the traces of a record dumped whole, whatever it holds: a device's
    // instant (`...418Z`; the host writes none with milliseconds) and the
    // names of the fields of a fact's data.
    needles.extend(receipt_digests);
    needles.push(".418Z".to_owned());
    for field in [
        "membershipDigest",
        "closedBoxCount",
        "plannedQtySnapshot",
        "targetScannedAt",
        "duplicateSource",
        "reasonText",
        "rawLength",
    ] {
        needles.push(field.to_owned());
    }
    needles.push(markiro_host::facts::rules::box_membership_digest(&[km_a
        .hash
        .clone()]));
    needles.push(markiro_host::facts::rules::box_membership_digest(&[]));
    for words in [
        reprint_words,
        disassemble_words,
        refused_state_words,
        "reason-marker",
        &overlong_words,
    ] {
        needles.push(words.to_owned());
    }
    for needle in needles {
        assert!(
            !log.contains(&needle),
            "the process log contains {needle:?}"
        );
    }
}

/// Every `.rs` file under `dir`.
fn rust_files(dir: &std::path::Path, found: &mut Vec<std::path::PathBuf>) {
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            rust_files(&path, found);
        } else if path.extension().is_some_and(|extension| extension == "rs") {
            found.push(path);
        }
    }
}

/// The walk above reads the process log, which holds what `tracing` writes
/// at `info` and above. What it cannot see is written elsewhere (`println!`
/// and `eprintln!` go to the console, not the log file) or below its level
/// (`debug!` and `trace!` are filtered, so a payload in one would show only
/// when someone lowers the filter). So the source holds the line: the
/// host's library prints nothing, and the facts path (the facts, the codes
/// and the totals) has exactly the two `warn!` calls `facts::receive` makes
/// for a refusal, by the record's id and the receipt's code. A new logging
/// call there is a decision for this test and the walk, not a quiet line.
#[test]
fn the_host_prints_nothing_and_the_facts_path_logs_only_its_two_audited_lines() {
    let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    rust_files(&src, &mut files);
    assert!(files.len() > 20, "the source was not found");
    let facts_path = [
        "routes/facts.rs",
        "routes/codes.rs",
        "routes/office_shifts.rs",
    ];
    let mut facts_files = 0;
    for file in &files {
        let relative = file
            .strip_prefix(&src)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        let text = std::fs::read_to_string(file).unwrap();
        // The command line prints its own answers.
        if relative != "main.rs" {
            for print in ["print!", "println!", "eprint!", "eprintln!", "dbg!"] {
                assert!(
                    !text.contains(print),
                    "{relative} writes past the log with {print}"
                );
            }
        }
        if relative.starts_with("facts/") || facts_path.contains(&relative.as_str()) {
            facts_files += 1;
            let audited = if relative == "facts/mod.rs" { 2 } else { 0 };
            assert_eq!(
                text.matches("tracing::").count(),
                audited,
                "{relative} has a logging call this test does not know"
            );
        }
    }
    assert_eq!(facts_files, 12);
}
