//! Plan IMP: the import carries PIN and badge hashes and the badge salt, and
//! none of them reaches the process log, whether the import is refused,
//! tried (`dryRun`), done or repeated. Its own binary, because it installs
//! the global tracing subscriber; it listens on 127.0.0.1, so it runs
//! outside the sandbox.

mod support;

use markiro_host::config::HostPaths;
use markiro_host::{start, StartOptions};
use serde_json::{json, Value};
use support::app::{cloud_import_request, IMPORT_ID};

#[tokio::test]
async fn the_imports_hashes_and_salt_never_reach_the_process_log() {
    let dir = tempfile::tempdir().unwrap();
    let paths = HostPaths::new(dir.path());
    paths.ensure().unwrap();
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
    let pair: Value = client
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
    let wizard: Value = client
        .post(format!("{base}/v1/bootstrap"))
        .header(protocol.0, &protocol.1)
        .bearer_auth(&key)
        .json(&support::app::bootstrap_body())
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let token = wizard["session"]["token"].as_str().unwrap().to_owned();
    let import = |body: Value| {
        client
            .post(format!("{base}/v1/office/import"))
            .header(protocol.0, &protocol.1)
            .header(markiro_proto::OFFICE_SESSION_HEADER, &token)
            .bearer_auth(&key)
            .json(&body)
            .send()
    };

    // Refused: a badge under another salt; then tried, done and repeated.
    let mut refused = cloud_import_request(IMPORT_ID, false);
    refused["payload"]["badges"][0]["badgePhc"] = json!(
        "pbkdf2$sha256$100000$bWFya2lyby1waW4tc2FsdA==$3OKvrZ2+EfTB2zsCso90r5g8c6Ib6t+Bv+cGJOpgPmU="
    );
    assert_eq!(import(refused).await.unwrap().status(), 400);
    for dry_run in [true, false, false] {
        let answer = import(cloud_import_request(IMPORT_ID, dry_run))
            .await
            .unwrap();
        assert_eq!(answer.status(), 200);
    }

    let request = cloud_import_request(IMPORT_ID, false);
    let mut secrets: Vec<String> = vec![
        "pbkdf2$".to_owned(),
        request["payload"]["badgeSalt"].as_str().unwrap().to_owned(),
        hex(b"markiro-badge-01"),
        format!("{:?}", b"markiro-badge-01"),
    ];
    for operator in request["payload"]["operators"].as_array().unwrap() {
        secrets.push(operator["pinPhc"].as_str().unwrap().to_owned());
    }
    for badge in request["payload"]["badges"].as_array().unwrap() {
        let phc = badge["badgePhc"].as_str().unwrap();
        secrets.push(phc.to_owned());
        secrets.push(phc.rsplit('$').next().unwrap().to_owned());
    }
    secrets.push(key);
    secrets.push(token);

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
    for secret in secrets {
        assert!(!log.contains(&secret), "the process log contains a secret");
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
