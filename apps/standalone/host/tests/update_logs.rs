//! The process log of the distribution (plan ОБН-3, spec §10.11.3 «Логи»):
//! a download names its device, range and ETag, a refused manifest its
//! reason; never the device key, the session token or a manifest's text.
//! A real host on 127.0.0.1: run outside the sandbox.

mod support;

use markiro_host::config::HostPaths;
use markiro_host::{start, StartOptions, HOST_VERSION};
use markiro_proto::update::AppVersion;
use serde_json::json;
use support::update::{installer_bytes, signed_manifest, write_package};

#[tokio::test]
async fn the_distribution_logs_no_key_token_or_manifest() {
    let dir = tempfile::tempdir().unwrap();
    let paths = HostPaths::new(dir.path());
    paths.ensure().unwrap();
    let (current_manifest, current) = write_package(&paths.updates_dir(), "current", HOST_VERSION);
    let guard = markiro_host::logging::init(&paths.logs_dir(), false).unwrap();
    let host = start(
        &paths,
        StartOptions {
            port_override: None,
            bind: Some("127.0.0.1:0".parse().unwrap()),
        },
    )
    .await
    .unwrap();
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
    let wizard: serde_json::Value = client
        .post(format!("{base}/v1/bootstrap"))
        .header(protocol.0, &protocol.1)
        .bearer_auth(&key)
        .json(&json!({
            "admin": { "login": "admin", "name": "Ирина", "password": "correct horse battery" },
            "org": { "name": "ООО «Атолл»", "inn": "7707083893", "gln": "4600682000010", "gs1Prefixes": [], "timeZone": "Europe/Moscow" },
            "sscc": { "boxNextSerial": 1, "palletNextSerial": 0 },
            "lines": ["Линия 1"]
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let token = wizard["session"]["token"].as_str().unwrap().to_owned();

    let whole = client
        .get(format!("{base}/v1/device/update/installer"))
        .header(protocol.0, &protocol.1)
        .bearer_auth(&key)
        .send()
        .await
        .unwrap();
    assert_eq!(whole.status(), 200);
    assert_eq!(whole.bytes().await.unwrap().to_vec(), current);
    let part = client
        .get(format!("{base}/v1/device/update/installer"))
        .header(protocol.0, &protocol.1)
        .header("range", "bytes=1000-")
        .bearer_auth(&key)
        .send()
        .await
        .unwrap();
    assert_eq!(part.status(), 206);
    assert_eq!(part.bytes().await.unwrap().len(), current.len() - 1000);

    let host_version: AppVersion = HOST_VERSION.parse().unwrap();
    let newer = AppVersion {
        minor: host_version.minor + 1,
        patch: 0,
        ..host_version
    }
    .to_string();
    let bytes = installer_bytes(&newer);
    let manifest = signed_manifest(&newer, &bytes);
    // The first character of the signature segment: all six of its bits count
    // (the last one may be padding, which would make the manifest malformed).
    let signature_at = manifest.rfind('.').unwrap() + 1;
    let mut tampered = manifest.clone();
    let first = tampered.remove(signature_at);
    tampered.insert(signature_at, if first == 'A' { 'B' } else { 'A' });
    let refused = client
        .post(format!("{base}/v1/office/update-package/manifest"))
        .header(protocol.0, &protocol.1)
        .header(markiro_proto::OFFICE_SESSION_HEADER, &token)
        .bearer_auth(&key)
        .json(&json!({ "manifest": tampered }))
        .send()
        .await
        .unwrap();
    assert_eq!(refused.status(), 400);
    let upload: serde_json::Value = client
        .post(format!("{base}/v1/office/update-package/manifest"))
        .header(protocol.0, &protocol.1)
        .header(markiro_proto::OFFICE_SESSION_HEADER, &token)
        .bearer_auth(&key)
        .json(&json!({ "manifest": manifest }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let staged = client
        .put(format!(
            "{base}/v1/office/update-package/{}/installer",
            upload["uploadId"].as_str().unwrap()
        ))
        .header(protocol.0, &protocol.1)
        .header(markiro_proto::OFFICE_SESSION_HEADER, &token)
        .bearer_auth(&key)
        .body(bytes.clone())
        .send()
        .await
        .unwrap();
    assert_eq!(staged.status(), 200);
    host.stop().await.unwrap();
    drop(guard);

    let mut log = String::new();
    for entry in std::fs::read_dir(paths.logs_dir()).unwrap() {
        log.push_str(&std::fs::read_to_string(entry.unwrap().path()).unwrap());
    }
    assert!(
        log.contains("an update download began"),
        "a download is logged"
    );
    assert!(
        log.contains("manifest_signature"),
        "a refused manifest names its reason"
    );
    for secret in [
        key.as_str(),
        token.as_str(),
        manifest.as_str(),
        current_manifest.as_str(),
        manifest.rsplit('.').next().unwrap(),
        tampered.as_str(),
    ] {
        assert!(!log.contains(secret), "the log holds {secret:?}");
    }
}
