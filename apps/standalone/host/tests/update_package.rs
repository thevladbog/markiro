//! Upload of an update package by an administrator (plan ОБН-3, spec
//! §10.11.2): the signed manifest opens the one upload, the installer comes
//! as a stream of exactly the manifest's size, and the package waits as
//! `staged\`. A refused upload leaves no folder and no audit row.

mod support;

use axum::body::{Body, Bytes};
use axum::http::StatusCode;
use futures_util::StreamExt;
use markiro_host::updates::{UpdateStore, CURRENT, STAGED};
use serde_json::{json, Value};
use support::app::{
    admin, audit_rows, audit_trail, json as json_request, request, with_device, with_session, Admin,
};
use support::backup::names;
use support::update::{
    installer_bytes, installer_name, keyset, manifest_payload, sha256_hex, signed_manifest,
    write_package,
};

async fn host_of(version: &str) -> Admin {
    let mut admin = admin().await;
    admin.app.keep_updates(version);
    admin
}

async fn post_manifest(admin: &Admin, token: &str, manifest: &str) -> (StatusCode, Value) {
    admin
        .call_as(
            token,
            "POST",
            "/v1/office/update-package/manifest",
            Some(json!({ "manifest": manifest })),
        )
        .await
}

/// `PUT …/installer` of `body` with `token`'s session, declaring `length`
/// (no `Content-Length` at all for `None`).
async fn put_installer(
    admin: &Admin,
    token: &str,
    upload_id: &str,
    body: Vec<u8>,
    length: Option<usize>,
) -> (StatusCode, Value) {
    put_body(admin, token, upload_id, Body::from(body), length).await
}

async fn put_body(
    admin: &Admin,
    token: &str,
    upload_id: &str,
    body: Body,
    length: Option<usize>,
) -> (StatusCode, Value) {
    let mut builder = with_session(
        request(
            "PUT",
            &format!("/v1/office/update-package/{upload_id}/installer"),
        ),
        &admin.key,
        token,
    )
    .header("content-type", "application/octet-stream");
    if let Some(length) = length {
        builder = builder.header("content-length", length.to_string());
    }
    admin.app.send(builder.body(body).unwrap()).await
}

fn updates(admin: &Admin) -> std::path::PathBuf {
    admin.app.dir().join("updates")
}

#[tokio::test]
async fn an_administrator_uploads_a_newer_package_and_it_waits_as_staged() {
    let admin = host_of("0.2.0").await;
    let bytes = installer_bytes("0.3.0");
    let (status, upload) =
        post_manifest(&admin, &admin.token, &signed_manifest("0.3.0", &bytes)).await;
    assert_eq!(status, StatusCode::OK, "{upload}");
    assert_eq!(
        (&upload["version"], &upload["sizeBytes"], &upload["sha256"]),
        (
            &json!("0.3.0"),
            &json!(bytes.len()),
            &json!(sha256_hex(&bytes))
        )
    );
    let id = upload["uploadId"].as_str().unwrap().to_owned();
    let (status, staged) =
        put_installer(&admin, &admin.token, &id, bytes.clone(), Some(bytes.len())).await;
    assert_eq!(status, StatusCode::OK, "{staged}");
    assert_eq!(
        staged,
        json!({ "version": "0.3.0", "sizeBytes": bytes.len(), "sha256": sha256_hex(&bytes) })
    );
    assert_eq!(names(&updates(&admin)), [STAGED]);
    assert_eq!(
        std::fs::read(updates(&admin).join(STAGED).join(installer_name("0.3.0"))).unwrap(),
        bytes
    );
    assert!(
        !updates(&admin).join(CURRENT).exists(),
        "a staged package is not served"
    );
    assert_eq!(
        audit_trail(&admin.app, "update.package.stage").await,
        [admin.row(
            "update.package.stage",
            "update_package",
            "0.3.0",
            json!({
                "version": "0.3.0", "sha256": sha256_hex(&bytes),
                "sizeBytes": bytes.len(), "kid": "test-upd-1"
            })
        )]
    );
}

#[tokio::test]
async fn only_an_administrators_session_uploads() {
    let admin = host_of("0.2.0").await;
    let tech = admin.technologist().await;
    let bytes = installer_bytes("0.3.0");
    let manifest = signed_manifest("0.3.0", &bytes);
    let (status, body) = post_manifest(&admin, &tech, &manifest).await;
    assert_eq!(
        (status, &body["error"]["code"]),
        (StatusCode::FORBIDDEN, &json!("forbidden"))
    );
    // A device key alone never opens an office route.
    let (status, body) = admin
        .app
        .send(json_request(
            with_device(
                request("POST", "/v1/office/update-package/manifest"),
                &admin.key,
            ),
            json!({ "manifest": manifest }),
        ))
        .await;
    assert_eq!(
        (status, &body["error"]["details"]),
        (
            StatusCode::UNAUTHORIZED,
            &json!({ "credential": "session" })
        )
    );
    let (_, upload) = post_manifest(&admin, &admin.token, &manifest).await;
    let id = upload["uploadId"].as_str().unwrap().to_owned();
    let (status, _) = put_installer(&admin, &tech, &id, bytes.clone(), Some(bytes.len())).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(audit_trail(&admin.app, "update.package.stage")
        .await
        .is_empty());
}

#[tokio::test]
async fn a_package_not_newer_than_the_running_host_is_refused() {
    let mut admin = host_of("0.2.0").await;
    // A sound current package of the running version: it is no news.
    write_package(&updates(&admin), CURRENT, "0.2.0");
    admin.app.keep_updates("0.2.0");
    let rows = audit_rows(&admin.app).await;
    for version in ["0.2.0", "0.1.9"] {
        let bytes = installer_bytes(version);
        let (status, body) =
            post_manifest(&admin, &admin.token, &signed_manifest(version, &bytes)).await;
        assert_eq!(
            (status, &body["error"]["details"]),
            (
                StatusCode::CONFLICT,
                &json!({ "constraint": "package_not_newer", "hostVersion": "0.2.0" })
            ),
            "{version}"
        );
    }
    assert_eq!(names(&updates(&admin)), [CURRENT]);
    assert_eq!(audit_rows(&admin.app).await, rows);
}

#[tokio::test]
async fn the_package_of_the_running_version_repairs_a_missing_current_package() {
    let admin = host_of("0.2.0").await;
    let bytes = installer_bytes("0.2.0");
    let (status, upload) =
        post_manifest(&admin, &admin.token, &signed_manifest("0.2.0", &bytes)).await;
    assert_eq!(status, StatusCode::OK, "{upload}");
    let id = upload["uploadId"].as_str().unwrap().to_owned();
    let (status, staged) =
        put_installer(&admin, &admin.token, &id, bytes.clone(), Some(bytes.len())).await;
    assert_eq!(status, StatusCode::OK, "{staged}");
    // Current at once, not staged and not waiting for the next start.
    assert_eq!(names(&updates(&admin)), [CURRENT]);
    let (_, status) = admin.call("GET", "/v1/office/update-status", None).await;
    assert_eq!(status["package"]["state"], json!("ok"), "{status}");
    assert_eq!(status["package"]["version"], json!("0.2.0"));
    assert_eq!(
        audit_trail(&admin.app, "update.package.stage").await.len(),
        1
    );
    assert_eq!(
        audit_trail(&admin.app, "update.package.promote").await,
        [(
            "system".to_owned(),
            None,
            "update.package.promote".to_owned(),
            Some("update_package".to_owned()),
            Some("0.2.0".to_owned()),
            "ok".to_owned(),
            json!({ "version": "0.2.0", "previous": null })
        )]
    );
}

#[tokio::test]
async fn a_manifest_that_does_not_check_out_is_refused_by_its_reason() {
    let mut admin = admin().await;
    admin.app.keep_updates_with(
        UpdateStore::new(admin.app.dir().join("updates"), keyset(), "0.2.0")
            .with_max_installer(100_000),
    );
    let bytes = installer_bytes("0.3.0");
    let good = signed_manifest("0.3.0", &bytes);
    // A character in the middle of the signature (the last one carries
    // padding bits, which can make the text non-canonical instead).
    let mut tampered = good.clone().into_bytes();
    let at = good.rfind('.').unwrap() + 11;
    tampered[at] = if tampered[at] == b'A' { b'B' } else { b'A' };
    let tampered = String::from_utf8(tampered).unwrap();
    let mut station = manifest_payload("0.3.0", &bytes);
    station["product"] = json!("markiro-station");
    let station = markiro_proto::update::distribution::testing::sign_update_manifest(&station);
    for (manifest, reason) in [
        (tampered, "manifest_signature"),
        (station, "wrong_product"),
        ("not a manifest".to_owned(), "manifest_malformed"),
        ("x".repeat(64 * 1024 + 1), "too_large"),
        // The installer is a few hundred KiB, over this host's limit.
        (good, "too_large"),
    ] {
        let (status, body) = post_manifest(&admin, &admin.token, &manifest).await;
        assert_eq!(
            (status, &body["error"]["code"], &body["error"]["details"]),
            (
                StatusCode::BAD_REQUEST,
                &json!("validation_failed"),
                &json!({ "field": "manifest", "reason": reason })
            ),
            "{reason}"
        );
    }
    // Beyond the route's own body limit the request does not even read.
    let (status, body) = post_manifest(&admin, &admin.token, &"x".repeat(80 * 1024)).await;
    assert_eq!(
        (status, &body["error"]["code"]),
        (StatusCode::BAD_REQUEST, &json!("validation_failed"))
    );
    assert!(names(&updates(&admin)).is_empty());
}

#[tokio::test]
async fn an_installer_of_another_size_or_hash_is_refused_and_leaves_nothing() {
    let admin = host_of("0.2.0").await;
    let bytes = installer_bytes("0.3.0");
    let manifest = signed_manifest("0.3.0", &bytes);
    let mut longer = bytes.clone();
    longer.push(b'!');
    let mut other = bytes.clone();
    other[100] ^= 0x01;
    let rows = audit_rows(&admin.app).await;
    for (body, length, reason) in [
        (bytes.clone(), None, "size_mismatch"),
        (bytes.clone(), Some(bytes.len() - 1), "size_mismatch"),
        (
            bytes[..bytes.len() - 1].to_vec(),
            Some(bytes.len()),
            "size_mismatch",
        ),
        (longer, Some(bytes.len()), "too_long"),
        (other, Some(bytes.len()), "hash_mismatch"),
    ] {
        let (_, upload) = post_manifest(&admin, &admin.token, &manifest).await;
        let id = upload["uploadId"].as_str().unwrap().to_owned();
        let (status, answer) = put_installer(&admin, &admin.token, &id, body, length).await;
        assert_eq!(
            (status, &answer["error"]["details"]),
            (
                StatusCode::BAD_REQUEST,
                &json!({ "field": "installer", "reason": reason })
            ),
            "{reason}"
        );
        assert!(
            names(&updates(&admin)).is_empty(),
            "{reason}: the folder went"
        );
        let (status, answer) =
            put_installer(&admin, &admin.token, &id, bytes.clone(), Some(bytes.len())).await;
        assert_eq!(
            (status, &answer["error"]["details"]["constraint"]),
            (StatusCode::CONFLICT, &json!("upload_unknown")),
            "{reason}: the refused upload is gone"
        );
    }
    assert_eq!(audit_rows(&admin.app).await, rows);
}

#[tokio::test]
async fn a_new_manifest_replaces_the_upload_in_progress() {
    let admin = host_of("0.2.0").await;
    let bytes = installer_bytes("0.3.0");
    let manifest = signed_manifest("0.3.0", &bytes);
    let (_, first) = post_manifest(&admin, &admin.token, &manifest).await;
    let (_, second) = post_manifest(&admin, &admin.token, &manifest).await;
    let first = first["uploadId"].as_str().unwrap();
    let second = second["uploadId"].as_str().unwrap();
    let (status, _) = put_installer(
        &admin,
        &admin.token,
        first,
        bytes.clone(),
        Some(bytes.len()),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    let (status, _) = put_installer(
        &admin,
        &admin.token,
        second,
        bytes.clone(),
        Some(bytes.len()),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(names(&updates(&admin)), [STAGED]);
}

#[tokio::test]
async fn a_host_without_packages_answers_not_found() {
    let admin = admin().await;
    let (status, body) = post_manifest(&admin, &admin.token, "x").await;
    assert_eq!(
        (status, &body["error"]["code"]),
        (StatusCode::NOT_FOUND, &json!("not_found"))
    );
}

#[tokio::test]
async fn a_non_administrator_put_is_refused_before_the_body_and_keeps_the_upload() {
    let admin = host_of("0.2.0").await;
    let tech = admin.technologist().await;
    let bytes = installer_bytes("0.3.0");
    let (_, upload) = post_manifest(&admin, &admin.token, &signed_manifest("0.3.0", &bytes)).await;
    let id = upload["uploadId"].as_str().unwrap().to_owned();
    // A well-formed body: only the early check keeps it from being consumed
    // (and the administrator's upload from being abandoned by the late one).
    let (status, body) = put_installer(&admin, &tech, &id, bytes.clone(), Some(bytes.len())).await;
    assert_eq!(
        (status, &body["error"]["code"]),
        (StatusCode::FORBIDDEN, &json!("forbidden"))
    );
    let (status, staged) =
        put_installer(&admin, &admin.token, &id, bytes.clone(), Some(bytes.len())).await;
    assert_eq!(
        status,
        StatusCode::OK,
        "the administrator still finishes: {staged}"
    );
    assert_eq!(names(&updates(&admin)), [STAGED]);
}

#[tokio::test]
async fn a_second_put_of_the_same_upload_is_refused_and_the_first_finishes() {
    let admin = host_of("0.2.0").await;
    let bytes = installer_bytes("0.3.0");
    let (_, upload) = post_manifest(&admin, &admin.token, &signed_manifest("0.3.0", &bytes)).await;
    let id = upload["uploadId"].as_str().unwrap().to_owned();
    let (sender, receiver) =
        tokio::sync::mpsc::channel::<Result<Bytes, std::convert::Infallible>>(1);
    let body = Body::from_stream(futures_util::stream::unfold(
        receiver,
        |mut receiver| async move { receiver.recv().await.map(|item| (item, receiver)) },
    ));
    let (head, tail) = bytes.split_at(bytes.len() / 2);
    let first = put_body(&admin, &admin.token, &id, body, Some(bytes.len()));
    let second = async {
        sender.send(Ok(Bytes::copy_from_slice(head))).await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        let answer =
            put_installer(&admin, &admin.token, &id, bytes.clone(), Some(bytes.len())).await;
        sender.send(Ok(Bytes::copy_from_slice(tail))).await.unwrap();
        drop(sender);
        answer
    };
    let ((status, staged), (refused, answer)) = tokio::join!(first, second);
    assert_eq!(
        (refused, &answer["error"]["details"]["constraint"]),
        (StatusCode::CONFLICT, &json!("upload_unknown")),
        "{answer}"
    );
    assert_eq!(
        status,
        StatusCode::OK,
        "the first PUT was not cut: {staged}"
    );
    assert_eq!(names(&updates(&admin)), [STAGED]);
}

#[tokio::test]
async fn an_upload_that_sends_nothing_for_the_idle_limit_is_dropped() {
    let mut admin = host_of("0.2.0").await;
    admin.app.state = admin
        .app
        .state
        .clone()
        .with_upload_idle(std::time::Duration::from_millis(150));
    let bytes = installer_bytes("0.3.0");
    let (_, upload) = post_manifest(&admin, &admin.token, &signed_manifest("0.3.0", &bytes)).await;
    let id = upload["uploadId"].as_str().unwrap().to_owned();
    let stalled =
        futures_util::stream::once(futures_util::future::ready(
            Ok::<_, std::convert::Infallible>(Bytes::copy_from_slice(&bytes[..1000])),
        ))
        .chain(futures_util::stream::pending());
    let rows = audit_rows(&admin.app).await;
    let (status, answer) = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        put_body(
            &admin,
            &admin.token,
            &id,
            Body::from_stream(stalled),
            Some(bytes.len()),
        ),
    )
    .await
    .expect("the host gave up on a stalled upload");
    assert_eq!(
        (status, &answer["error"]["details"]),
        (
            StatusCode::BAD_REQUEST,
            &json!({ "field": "installer", "reason": "size_mismatch" })
        )
    );
    assert!(names(&updates(&admin)).is_empty(), "the folder went");
    assert_eq!(audit_rows(&admin.app).await, rows);
}

#[cfg(unix)]
#[tokio::test]
async fn a_package_that_could_not_move_to_staged_leaves_its_row_and_a_failed_one() {
    use std::os::unix::fs::PermissionsExt;
    let admin = host_of("0.2.0").await;
    let bytes = installer_bytes("0.3.0");
    let (_, upload) = post_manifest(&admin, &admin.token, &signed_manifest("0.3.0", &bytes)).await;
    let id = upload["uploadId"].as_str().unwrap().to_owned();
    // The folder may not be renamed any more: the audit row is already in.
    let folder = updates(&admin);
    std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o555)).unwrap();
    let (status, _) =
        put_installer(&admin, &admin.token, &id, bytes.clone(), Some(bytes.len())).await;
    std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(!status.is_success(), "{status}");
    assert!(!folder.join(STAGED).exists());
    let rows = audit_trail(&admin.app, "update.package.stage").await;
    assert_eq!(
        rows.iter().map(|row| row.5.as_str()).collect::<Vec<_>>(),
        ["ok", "failed"]
    );
    assert_eq!(rows[1].6["reason"], json!("not_staged"));
}
