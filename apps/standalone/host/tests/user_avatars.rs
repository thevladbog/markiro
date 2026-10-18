//! An office user's photo (plan АВА): `GET`, `PUT` and `DELETE
//! /v1/office/users/{id}/avatar`, the raw image at `.../avatar/image`,
//! `avatarVersion` on the user and the session, and migration `0046`.

mod support;

use axum::body::Body;
use axum::extract::connect_info::MockConnectInfo;
use axum::http::{HeaderMap, Request, StatusCode};
use base64::{engine::general_purpose::STANDARD, Engine};
use http_body_util::BodyExt;
use markiro_host::server::router;
use serde_json::{json, Value};
use tower::ServiceExt;

use support::app::{
    admin, audit_rows, audit_trail, empty, host_revision, login, pair_device, pair_handheld,
    request, seed_office_user, turn_the_user_off_at_the_next_activity, with_device, with_session,
    Admin, LOOPBACK,
};

// ---- pictures: headers only, as the host reads them -------------------------------------

fn chunk(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
    let mut out = (data.len() as u32).to_be_bytes().to_vec();
    out.extend_from_slice(kind);
    out.extend_from_slice(data);
    out.extend_from_slice(&[0, 0, 0, 0]); // the host reads no checksum
    out
}

fn ihdr(width: u32, height: u32) -> Vec<u8> {
    let mut data = width.to_be_bytes().to_vec();
    data.extend_from_slice(&height.to_be_bytes());
    data.extend_from_slice(&[8, 2, 0, 0, 0]);
    chunk(b"IHDR", &data)
}

const PNG_SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];

/// A PNG of `width` × `height` dots whose pixel data is `idat` bytes of nothing.
fn png_with(width: u32, height: u32, idat: usize) -> Vec<u8> {
    let mut out = PNG_SIGNATURE.to_vec();
    out.extend(ihdr(width, height));
    out.extend(chunk(b"IDAT", &vec![0u8; idat]));
    out.extend(chunk(b"IEND", &[]));
    out
}

fn png(side: u32) -> Vec<u8> {
    png_with(side, side, 16)
}

fn apng(side: u32) -> Vec<u8> {
    let mut out = PNG_SIGNATURE.to_vec();
    out.extend(ihdr(side, side));
    out.extend(chunk(b"acTL", &[0, 0, 0, 2, 0, 0, 0, 0]));
    out.extend(chunk(b"IDAT", &[0u8; 8]));
    out.extend(chunk(b"IEND", &[]));
    out
}

/// A JPEG with a start-of-frame marker `sof`, 8 bits, `components`.
fn jpeg_with(sof: u8, width: u16, height: u16, components: u8, precision: u8) -> Vec<u8> {
    let mut out = vec![0xFF, 0xD8];
    // JFIF APP0, so the frame is not the first segment.
    out.extend([0xFF, 0xE0, 0, 16]);
    out.extend(b"JFIF\0");
    out.extend([1, 1, 0, 0, 1, 0, 1, 0, 0]);
    out.extend([0xFF, sof]);
    let length = 8 + 3 * u16::from(components);
    out.extend(length.to_be_bytes());
    out.push(precision);
    out.extend(height.to_be_bytes());
    out.extend(width.to_be_bytes());
    out.push(components);
    for index in 0..components {
        out.extend([index + 1, 0x11, 0]);
    }
    out.extend([0xFF, 0xDA, 0, 2, 0xFF, 0xD9]);
    out
}

fn jpeg(side: u16) -> Vec<u8> {
    jpeg_with(0xC0, side, side, 3, 8)
}

fn riff(chunks: &[u8]) -> Vec<u8> {
    let mut out = b"RIFF".to_vec();
    out.extend(((chunks.len() + 4) as u32).to_le_bytes());
    out.extend(b"WEBP");
    out.extend_from_slice(chunks);
    out
}

fn webp_lossy(width: u16, height: u16) -> Vec<u8> {
    let mut data = vec![0x10, 0x02, 0x00, 0x9D, 0x01, 0x2A];
    data.extend(width.to_le_bytes());
    data.extend(height.to_le_bytes());
    data.extend([0u8; 4]);
    let mut body = b"VP8 ".to_vec();
    body.extend((data.len() as u32).to_le_bytes());
    body.extend(data);
    riff(&body)
}

fn webp_lossless(width: u32, height: u32) -> Vec<u8> {
    let bits = (width - 1) | ((height - 1) << 14);
    let mut data = vec![0x2F];
    data.extend(bits.to_le_bytes());
    data.extend([0u8; 4]);
    let mut body = b"VP8L".to_vec();
    body.extend((data.len() as u32).to_le_bytes());
    body.extend(data);
    riff(&body)
}

fn webp_extended(width: u32, height: u32, flags: u8, then: &[(&[u8; 4], usize)]) -> Vec<u8> {
    let mut data = vec![flags, 0, 0, 0];
    data.extend(&(width - 1).to_le_bytes()[..3]);
    data.extend(&(height - 1).to_le_bytes()[..3]);
    let mut body = b"VP8X".to_vec();
    body.extend(10u32.to_le_bytes());
    body.extend(data);
    for (kind, size) in then {
        body.extend(*kind);
        body.extend((*size as u32).to_le_bytes());
        body.extend(vec![0u8; *size + (*size & 1)]);
    }
    riff(&body)
}

/// An extended WebP of a `width` × `height` canvas holding `inner`, a whole chunk.
fn webp_canvas_with(
    width: u32,
    height: u32,
    before: &[(&[u8; 4], usize)],
    inner: &[u8],
) -> Vec<u8> {
    let mut data = vec![0u8, 0, 0, 0];
    data.extend(&(width - 1).to_le_bytes()[..3]);
    data.extend(&(height - 1).to_le_bytes()[..3]);
    let mut body = b"VP8X".to_vec();
    body.extend(10u32.to_le_bytes());
    body.extend(data);
    for (kind, size) in before {
        body.extend(*kind);
        body.extend((*size as u32).to_le_bytes());
        body.extend(vec![0u8; *size + (*size & 1)]);
    }
    body.extend_from_slice(inner);
    riff(&body)
}

// ---- harness ------------------------------------------------------------------------------

fn avatar_path(id: &str) -> String {
    format!("/v1/office/users/{id}/avatar")
}

fn put_body(bytes: &[u8]) -> Value {
    json!({ "dataBase64": STANDARD.encode(bytes) })
}

/// Seven seconds apart, so no run of calls meets the upload limiter.
async fn calm(admin: &Admin) {
    admin.app.clock.advance(time::Duration::seconds(7));
}

async fn put_as(admin: &Admin, token: &str, id: &str, bytes: &[u8]) -> (StatusCode, Value) {
    let answer = admin
        .call_as(token, "PUT", &avatar_path(id), Some(put_body(bytes)))
        .await;
    calm(admin).await;
    answer
}

async fn put(admin: &Admin, bytes: &[u8]) -> Value {
    let (status, body) = put_as(admin, &admin.token, &admin.id, bytes).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body
}

/// What a refused request answered: status and code.
fn refusal(answer: &(StatusCode, Value)) -> (StatusCode, Value) {
    (answer.0, answer.1["error"]["code"].clone())
}

async fn raw(
    admin: &Admin,
    token: Option<&str>,
    path: &str,
    headers: &[(&str, &str)],
) -> (StatusCode, HeaderMap, Vec<u8>) {
    let mut builder = with_device(request("GET", path), &admin.key);
    if let Some(token) = token {
        builder = builder.header(markiro_proto::OFFICE_SESSION_HEADER, token);
    }
    for (name, value) in headers {
        builder = builder.header(*name, *value);
    }
    send_raw(admin, builder.body(Body::empty()).unwrap()).await
}

async fn send_raw(admin: &Admin, request: Request<Body>) -> (StatusCode, HeaderMap, Vec<u8>) {
    let response = router(admin.app.state.clone())
        .layer(MockConnectInfo(std::net::SocketAddr::from(LOOPBACK)))
        .oneshot(request)
        .await
        .unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, headers, bytes.to_vec())
}

/// `(media_type, width, height, bytes, version)` of the stored row.
async fn stored(admin: &Admin, id: &str) -> Option<(String, i64, i64, Vec<u8>, i64)> {
    sqlx::query_as(
        "SELECT media_type, width, height, data, version FROM user_avatars WHERE user_id = ?",
    )
    .bind(id)
    .fetch_optional(&admin.app.state.pool)
    .await
    .unwrap()
}

fn now_ms(admin: &Admin) -> i64 {
    i64::try_from(admin.app.state.now().unix_timestamp_nanos() / 1_000_000).unwrap()
}

/// A technologist on the admin's station: `(token, id)`.
async fn technologist(admin: &Admin) -> (String, String) {
    admin.technologist_session().await
}

// ---- reading and writing ------------------------------------------------------------------

#[tokio::test]
async fn a_fresh_user_has_no_photo_and_no_version() {
    let admin = admin().await;
    let (status, state) = admin.call("GET", &avatar_path(&admin.id), None).await;
    assert_eq!((status, state), (StatusCode::OK, json!({ "avatar": null })));
    let (status, _, _) = raw(
        &admin,
        Some(&admin.token),
        &format!("{}/image", avatar_path(&admin.id)),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (_, me) = admin.call("GET", "/v1/office/me", None).await;
    assert_eq!(me["avatarVersion"], Value::Null);
    let (_, users) = admin.call("GET", "/v1/office/users", None).await;
    assert_eq!(users[0]["avatarVersion"], Value::Null);
    // An unknown user is no user, not a user without a photo.
    let (status, _) = admin
        .call(
            "GET",
            &avatar_path("00000000-0000-4000-8000-000000000001"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn the_owner_sets_replaces_and_clears_their_photo() {
    let admin = admin().await;
    let revision = host_revision(&admin.app).await;
    let first = png(128);
    let at = now_ms(&admin);
    let set = put(&admin, &first).await;
    let checksum = markiro_host::backup::identity::sha256_hex(&first);
    let avatar = &set["avatar"];
    assert_eq!(
        (
            avatar["width"].clone(),
            avatar["height"].clone(),
            avatar["mediaType"].clone(),
            avatar["checksum"].clone(),
            avatar["version"].clone(),
            avatar["dataBase64"].clone(),
        ),
        (
            json!(128),
            json!(128),
            json!("image/png"),
            json!(checksum),
            json!(at),
            json!(STANDARD.encode(&first)),
        )
    );
    assert_eq!(
        stored(&admin, &admin.id).await,
        Some(("image/png".to_owned(), 128, 128, first.clone(), at))
    );
    // The answer is the state a read gives, and the user and the session carry its version.
    let (_, read) = admin.call("GET", &avatar_path(&admin.id), None).await;
    assert_eq!(read, set);
    let (_, me) = admin.call("GET", "/v1/office/me", None).await;
    assert_eq!(me["avatarVersion"], json!(at));
    let (_, users) = admin.call("GET", "/v1/office/users", None).await;
    assert_eq!(users[0]["avatarVersion"], json!(at));

    // A replacement is the one row, rewritten, with a later version and the true media type.
    let second = jpeg(256);
    let replaced = put(&admin, &second).await;
    assert_eq!(replaced["avatar"]["mediaType"], json!("image/jpeg"));
    assert!(replaced["avatar"]["version"].as_i64().unwrap() > at);
    let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM user_avatars")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    assert_eq!(rows, 1);

    let (status, cleared) = admin.call("DELETE", &avatar_path(&admin.id), None).await;
    assert_eq!(
        (status, cleared),
        (StatusCode::OK, json!({ "avatar": null }))
    );
    assert_eq!(stored(&admin, &admin.id).await, None);
    let (_, me) = admin.call("GET", "/v1/office/me", None).await;
    assert_eq!(me["avatarVersion"], Value::Null);

    // Audit: exact actor, target and details, never the picture.
    assert_eq!(
        audit_trail(&admin.app, "office_user.avatar.set").await,
        vec![
            admin.row(
                "office_user.avatar.set",
                "office_user",
                &admin.id,
                json!({ "width": 128, "height": 128, "bytes": first.len(),
                        "mediaType": "image/png", "replaced": false }),
            ),
            admin.row(
                "office_user.avatar.set",
                "office_user",
                &admin.id,
                json!({ "width": 256, "height": 256, "bytes": second.len(),
                        "mediaType": "image/jpeg", "replaced": true }),
            ),
        ]
    );
    assert_eq!(
        audit_trail(&admin.app, "office_user.avatar.clear").await,
        vec![admin.row(
            "office_user.avatar.clear",
            "office_user",
            &admin.id,
            json!({})
        )]
    );
    // A photo is no feed item and takes no host revision: stations hear nothing of it.
    assert_eq!(host_revision(&admin.app).await, revision);
}

#[tokio::test]
async fn the_version_rises_even_when_the_clock_stands_or_goes_back() {
    let admin = admin().await;
    let first = put(&admin, &png(128)).await["avatar"]["version"]
        .as_i64()
        .unwrap();
    // The clock goes back an hour: a version that repeated would keep a stale picture cached.
    admin.app.clock.advance(time::Duration::hours(-1));
    let second = put(&admin, &jpeg(128)).await["avatar"]["version"]
        .as_i64()
        .unwrap();
    assert!(second > first, "{second} > {first}");
}

#[tokio::test]
async fn the_same_picture_again_writes_nothing() {
    let admin = admin().await;
    let bytes = png(160);
    let first = put(&admin, &bytes).await;
    let rows = audit_rows(&admin.app).await;
    let again = put(&admin, &bytes).await;
    assert_eq!(again, first);
    assert_eq!(audit_rows(&admin.app).await, rows);
    // Clearing none writes nothing either.
    admin.call("DELETE", &avatar_path(&admin.id), None).await;
    let rows = audit_rows(&admin.app).await;
    let (status, state) = admin.call("DELETE", &avatar_path(&admin.id), None).await;
    assert_eq!((status, state), (StatusCode::OK, json!({ "avatar": null })));
    assert_eq!(audit_rows(&admin.app).await, rows);
}

#[tokio::test]
async fn the_raw_image_carries_its_true_type_a_validator_and_no_sniffing() {
    let admin = admin().await;
    for (bytes, media_type) in [
        (png(128), "image/png"),
        (jpeg(128), "image/jpeg"),
        (webp_lossy(128, 128), "image/webp"),
    ] {
        let set = put(&admin, &bytes).await;
        let checksum = set["avatar"]["checksum"].as_str().unwrap().to_owned();
        let path = format!("{}/image", avatar_path(&admin.id));
        let (status, headers, body) = raw(&admin, Some(&admin.token), &path, &[]).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, bytes);
        let get = |name: &str| {
            headers
                .get(name)
                .and_then(|v| v.to_str().ok())
                .map(str::to_owned)
        };
        assert_eq!(get("content-type").as_deref(), Some(media_type));
        assert_eq!(get("x-content-type-options").as_deref(), Some("nosniff"));
        assert_eq!(get("etag"), Some(format!("\"{checksum}\"")));
        assert_eq!(get("cache-control").as_deref(), Some("private, no-cache"));
        assert_eq!(get("content-length"), Some(bytes.len().to_string()));
        assert_eq!(get("content-disposition").as_deref(), Some("inline"));

        // A validator the client holds: nothing is sent again, in every spelling.
        let etag = format!("\"{checksum}\"");
        for header_value in [
            etag.clone(),
            format!("W/{etag}"),
            format!("\"other\", {etag}"),
            "*".to_owned(),
        ] {
            let (status, headers, body) = raw(
                &admin,
                Some(&admin.token),
                &path,
                &[("if-none-match", &header_value)],
            )
            .await;
            assert_eq!(status, StatusCode::NOT_MODIFIED, "{header_value}");
            assert!(body.is_empty());
            assert_eq!(
                headers.get("etag").and_then(|v| v.to_str().ok()),
                Some(etag.as_str())
            );
        }
        let (status, _, body) = raw(
            &admin,
            Some(&admin.token),
            &path,
            &[("if-none-match", "\"stale\"")],
        )
        .await;
        assert_eq!((status, body), (StatusCode::OK, bytes));
    }
}

#[tokio::test]
async fn every_role_reads_every_photo_but_only_with_a_session() {
    let admin = admin().await;
    put(&admin, &png(128)).await;
    let (tech_token, tech_id) = technologist(&admin).await;
    let path = format!("{}/image", avatar_path(&admin.id));
    let (status, state) = admin
        .call_as(&tech_token, "GET", &avatar_path(&admin.id), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{state}");
    assert_eq!(state["avatar"]["width"], json!(128));
    assert_eq!(
        raw(&admin, Some(&tech_token), &path, &[]).await.0,
        StatusCode::OK
    );
    // The technologist's own state reads empty.
    let (_, own) = admin
        .call_as(&tech_token, "GET", &avatar_path(&tech_id), None)
        .await;
    assert_eq!(own, json!({ "avatar": null }));
    // No session, a garbage session: unauthorized; a device key alone opens nothing.
    for token in [None, Some("not-a-session")] {
        let (status, _, body) = raw(&admin, token, &path, &[]).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        let error: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(error["error"]["code"], json!("unauthorized"));
    }
    let (status, _) = admin
        .app
        .send(empty(request("GET", &avatar_path(&admin.id))))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

// ---- who may change what ------------------------------------------------------------------

#[tokio::test]
async fn nobody_replaces_another_users_photo_an_administrator_included() {
    let admin = admin().await;
    let (tech_token, tech_id) = technologist(&admin).await;
    let tech_photo = png(130);
    put_as(&admin, &tech_token, &tech_id, &tech_photo).await;
    let before = stored(&admin, &tech_id).await;
    let rows = audit_rows(&admin.app).await;
    let answer = put_as(&admin, &admin.token, &tech_id, &png(200)).await;
    assert_eq!(
        refusal(&answer),
        (StatusCode::FORBIDDEN, json!("forbidden_replace_other"))
    );
    // The other direction, and a user who does not exist: the same refusal, no hint.
    let answer = put_as(&admin, &tech_token, &admin.id, &png(200)).await;
    assert_eq!(
        refusal(&answer),
        (StatusCode::FORBIDDEN, json!("forbidden_replace_other"))
    );
    let answer = put_as(
        &admin,
        &admin.token,
        "00000000-0000-4000-8000-000000000001",
        &png(200),
    )
    .await;
    assert_eq!(
        refusal(&answer),
        (StatusCode::FORBIDDEN, json!("forbidden_replace_other"))
    );
    assert_eq!(stored(&admin, &tech_id).await, before);
    assert_eq!(stored(&admin, &admin.id).await, None);
    assert_eq!(audit_rows(&admin.app).await, rows);
}

#[tokio::test]
async fn an_administrator_deletes_another_users_photo_and_a_technologist_does_not() {
    let admin = admin().await;
    let (tech_token, tech_id) = technologist(&admin).await;
    let photo = png(144);
    put_as(&admin, &tech_token, &tech_id, &photo).await;
    put(&admin, &png(128)).await;

    // The technologist may not delete the administrator's photo.
    let rows = audit_rows(&admin.app).await;
    let (status, error) = admin
        .call_as(&tech_token, "DELETE", &avatar_path(&admin.id), None)
        .await;
    assert_eq!(
        refusal(&(status, error)),
        (StatusCode::FORBIDDEN, json!("forbidden"))
    );
    assert!(stored(&admin, &admin.id).await.is_some());
    assert_eq!(audit_rows(&admin.app).await, rows);

    // The administrator deletes the technologist's: the row names both.
    let (status, state) = admin.call("DELETE", &avatar_path(&tech_id), None).await;
    assert_eq!((status, state), (StatusCode::OK, json!({ "avatar": null })));
    assert_eq!(stored(&admin, &tech_id).await, None);
    assert_eq!(
        audit_trail(&admin.app, "office_user.avatar.clear").await,
        vec![admin.row(
            "office_user.avatar.clear",
            "office_user",
            &tech_id,
            json!({})
        )]
    );
    // The technologist may delete their own.
    put_as(&admin, &tech_token, &tech_id, &photo).await;
    let (status, _) = admin
        .call_as(&tech_token, "DELETE", &avatar_path(&tech_id), None)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(stored(&admin, &tech_id).await, None);
    // An administrator naming nobody gets not_found; a technologist naming nobody, forbidden.
    let nobody = avatar_path("00000000-0000-4000-8000-000000000001");
    assert_eq!(
        admin.call("DELETE", &nobody, None).await.0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        admin.call_as(&tech_token, "DELETE", &nobody, None).await.0,
        StatusCode::FORBIDDEN
    );
}

#[tokio::test]
async fn a_user_turned_off_after_the_extractor_passed_writes_nothing() {
    let admin = admin().await;
    put(&admin, &png(128)).await;
    let before = stored(&admin, &admin.id).await;
    for (method, body) in [("PUT", Some(put_body(&png(200)))), ("DELETE", None)] {
        let login_name = format!("second-{}", method.to_lowercase());
        let id = seed_office_user(&admin.app, &login_name, "admin", "second admin password").await;
        let token = login(&admin.app, &admin.key, &login_name, "second admin password").await;
        let rows = audit_rows(&admin.app).await;
        turn_the_user_off_at_the_next_activity(&admin.app, &id).await;
        admin.app.clock.advance(time::Duration::minutes(2));
        let (status, error) = admin.call_as(&token, method, &avatar_path(&id), body).await;
        assert_eq!(
            refusal(&(status, error)),
            (StatusCode::UNAUTHORIZED, json!("unauthorized")),
            "{method}"
        );
        assert_eq!(stored(&admin, &id).await, None, "{method}");
        assert_eq!(audit_rows(&admin.app).await, rows, "{method}");
    }
    assert_eq!(stored(&admin, &admin.id).await, before);
}

// ---- what the host refuses ------------------------------------------------------------------

#[tokio::test]
async fn the_host_judges_a_picture_by_its_bytes_and_its_header_only() {
    let admin = admin().await;
    let max = markiro_proto::avatar::MAX_BYTES;
    let cases: Vec<(&str, Vec<u8>, StatusCode, &str)> = vec![
        // Size: the limit is the picture's, not the JSON's.
        (
            "2 MiB + 1",
            png_with(128, 128, max),
            StatusCode::PAYLOAD_TOO_LARGE,
            "avatar_too_large",
        ),
        // Types: by the first bytes, whatever the client calls it.
        (
            "svg",
            b"<svg xmlns='http://www.w3.org/2000/svg' width='128' height='128'/>".to_vec(),
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "avatar_unsupported_type",
        ),
        (
            "gif",
            b"GIF89a\x80\x00\x80\x00\xf7\x00\x00".to_vec(),
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "avatar_unsupported_type",
        ),
        (
            "text",
            b"just some text, long enough".to_vec(),
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "avatar_unsupported_type",
        ),
        (
            "empty",
            Vec::new(),
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "avatar_unsupported_type",
        ),
        (
            "animated png",
            apng(128),
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "avatar_unsupported_type",
        ),
        (
            "animated webp",
            webp_extended(128, 128, 0x02, &[(b"ANIM", 6), (b"ANMF", 16)]),
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "avatar_unsupported_type",
        ),
        (
            "anmf without the flag",
            webp_extended(128, 128, 0x00, &[(b"ANMF", 16)]),
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "avatar_unsupported_type",
        ),
        (
            "lossless jpeg",
            jpeg_with(0xC3, 128, 128, 3, 8),
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "avatar_unsupported_type",
        ),
        (
            "arithmetic jpeg",
            jpeg_with(0xC9, 128, 128, 3, 8),
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "avatar_unsupported_type",
        ),
        (
            "cmyk jpeg",
            jpeg_with(0xC0, 128, 128, 4, 8),
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "avatar_unsupported_type",
        ),
        (
            "12-bit jpeg",
            jpeg_with(0xC1, 128, 128, 3, 12),
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "avatar_unsupported_type",
        ),
        // An extended canvas must be the bitstream's own sides.
        (
            "canvas 128 over a 16383 bitstream",
            webp_canvas_with(128, 128, &[], &webp_lossless(16_383, 16_383)[12..]),
            StatusCode::UNPROCESSABLE_ENTITY,
            "avatar_corrupt",
        ),
        (
            "canvas 128 over a 256 lossy bitstream",
            webp_canvas_with(128, 128, &[(b"ICCP", 4)], &webp_lossy(256, 256)[12..]),
            StatusCode::UNPROCESSABLE_ENTITY,
            "avatar_corrupt",
        ),
        (
            "canvas without a bitstream",
            webp_canvas_with(128, 128, &[(b"EXIF", 4)], &[]),
            StatusCode::UNPROCESSABLE_ENTITY,
            "avatar_corrupt",
        ),
        // Dimensions: read from the header, so a bomb costs nothing.
        (
            "png 127",
            png(127),
            StatusCode::UNPROCESSABLE_ENTITY,
            "avatar_too_small",
        ),
        (
            "jpeg 100 x 200",
            jpeg_with(0xC0, 100, 200, 3, 8),
            StatusCode::UNPROCESSABLE_ENTITY,
            "avatar_too_small",
        ),
        (
            "webp 64",
            webp_lossy(64, 64),
            StatusCode::UNPROCESSABLE_ENTITY,
            "avatar_too_small",
        ),
        (
            "png 4097",
            png(4097),
            StatusCode::UNPROCESSABLE_ENTITY,
            "avatar_dimensions_too_large",
        ),
        (
            "png bomb",
            png(60_000),
            StatusCode::UNPROCESSABLE_ENTITY,
            "avatar_dimensions_too_large",
        ),
        (
            "jpeg bomb",
            jpeg_with(0xC2, 65_535, 65_535, 3, 8),
            StatusCode::UNPROCESSABLE_ENTITY,
            "avatar_dimensions_too_large",
        ),
        (
            "webp bomb",
            webp_lossless(16_384, 16_384),
            StatusCode::UNPROCESSABLE_ENTITY,
            "avatar_dimensions_too_large",
        ),
        (
            "png 200 x 128",
            png_with(200, 128, 16),
            StatusCode::UNPROCESSABLE_ENTITY,
            "avatar_not_square",
        ),
        (
            "webp 256 x 128",
            webp_lossy(256, 128),
            StatusCode::UNPROCESSABLE_ENTITY,
            "avatar_not_square",
        ),
        // A signature and no picture behind it.
        (
            "cut jpeg",
            vec![0xFF, 0xD8, 0xFF, 0xE0, 0, 16, b'J'],
            StatusCode::UNPROCESSABLE_ENTITY,
            "avatar_corrupt",
        ),
        (
            "jpeg without a frame",
            vec![0xFF, 0xD8, 0xFF, 0xDA, 0, 2, 0xFF, 0xD9],
            StatusCode::UNPROCESSABLE_ENTITY,
            "avatar_corrupt",
        ),
        (
            "jpeg 0 x 0",
            jpeg_with(0xC0, 0, 0, 3, 8),
            StatusCode::UNPROCESSABLE_ENTITY,
            "avatar_corrupt",
        ),
        (
            "cut png",
            PNG_SIGNATURE.to_vec(),
            StatusCode::UNPROCESSABLE_ENTITY,
            "avatar_corrupt",
        ),
        (
            "png without pixels",
            {
                let mut out = PNG_SIGNATURE.to_vec();
                out.extend(ihdr(128, 128));
                out
            },
            StatusCode::UNPROCESSABLE_ENTITY,
            "avatar_corrupt",
        ),
        (
            "cut webp",
            webp_lossy(128, 128)[..20].to_vec(),
            StatusCode::UNPROCESSABLE_ENTITY,
            "avatar_corrupt",
        ),
    ];
    let rows = audit_rows(&admin.app).await;
    for (name, bytes, status, code) in cases {
        let answer = put_as(&admin, &admin.token, &admin.id, &bytes).await;
        assert_eq!(
            refusal(&answer),
            (status, json!(code)),
            "{name}: {}",
            answer.1
        );
        assert_eq!(stored(&admin, &admin.id).await, None, "{name}");
    }
    assert_eq!(
        audit_rows(&admin.app).await,
        rows,
        "a refusal writes no row"
    );
    // The largest the host takes: 2 MiB exactly, and 4096 × 4096 whose header is all it reads.
    let biggest = png_with(128, 128, max - (png_with(128, 128, 0).len()));
    assert_eq!(biggest.len(), max);
    put(&admin, &biggest).await;
    put(&admin, &png(4096)).await;
    // An extended WebP whose canvas and bitstream agree, behind a profile and a still alpha.
    let extended = webp_canvas_with(
        192,
        192,
        &[(b"ICCP", 4), (b"ALPH", 3)],
        &webp_lossless(192, 192)[12..],
    );
    let stored = put(&admin, &extended).await;
    assert_eq!(stored["avatar"]["mediaType"], json!("image/webp"));
}

#[tokio::test]
async fn a_body_that_is_not_the_contract_is_a_validation_failure() {
    let admin = admin().await;
    let path = avatar_path(&admin.id);
    for (name, body) in [
        ("not base64", json!({ "dataBase64": "***not base64***" })),
        ("missing", json!({})),
        (
            "a name of a file",
            json!({ "dataBase64": STANDARD.encode(png(128)), "fileName": "../../x.png" }),
        ),
        (
            "a declared type",
            json!({ "dataBase64": STANDARD.encode(png(128)), "mediaType": "image/png" }),
        ),
        ("not a string", json!({ "dataBase64": 5 })),
    ] {
        let (status, error) = admin.call("PUT", &path, Some(body)).await;
        assert_eq!(
            refusal(&(status, error)),
            (StatusCode::BAD_REQUEST, json!("validation_failed")),
            "{name}"
        );
        calm(&admin).await;
    }
    assert_eq!(stored(&admin, &admin.id).await, None);
}

#[tokio::test]
async fn the_route_takes_a_body_of_a_picture_of_2_mib_and_no_more() {
    let admin = admin().await;
    // Base64 of 2 MiB is 2 796 204 characters: past the router's 2 MiB JSON limit, so this route
    // has its own, and a body past THAT never reaches the handler.
    let wire = STANDARD
        .encode(png_with(128, 128, markiro_proto::avatar::MAX_BYTES))
        .len();
    assert!(wire > 2 * 1024 * 1024, "{wire}");
    let answer = admin
        .call(
            "PUT",
            &avatar_path(&admin.id),
            Some(json!({ "dataBase64": "A".repeat(3 * 1024 * 1024) })),
        )
        .await;
    assert_eq!(
        refusal(&answer),
        (StatusCode::PAYLOAD_TOO_LARGE, json!("avatar_too_large"))
    );
    assert_eq!(stored(&admin, &admin.id).await, None);
}

#[tokio::test]
async fn uploads_are_rate_limited_per_address_and_a_refusal_writes_nothing() {
    let admin = admin().await;
    let bytes = png(128);
    for attempt in 0..10 {
        let (status, body) = admin
            .call("PUT", &avatar_path(&admin.id), Some(put_body(&bytes)))
            .await;
        assert_eq!(status, StatusCode::OK, "{attempt}: {body}");
    }
    let rows = audit_rows(&admin.app).await;
    let (status, error) = admin
        .call("PUT", &avatar_path(&admin.id), Some(put_body(&jpeg(128))))
        .await;
    assert_eq!(
        refusal(&(status, error)),
        (StatusCode::TOO_MANY_REQUESTS, json!("rate_limited"))
    );
    assert_eq!(audit_rows(&admin.app).await, rows);
    assert_eq!(stored(&admin, &admin.id).await.unwrap().0, "image/png");
    admin.app.clock.advance(time::Duration::seconds(61));
    put(&admin, &jpeg(128)).await;
}

// ---- kinds of device and the license ------------------------------------------------------------------

#[tokio::test]
async fn a_handhelds_key_opens_no_photo_route_and_an_office_pc_opens_them_all() {
    let admin = admin().await;
    put(&admin, &png(128)).await;
    let handheld = pair_handheld(&admin).await;
    let (_, office_pc) = pair_device(&admin.app, "office").await;
    let rows = audit_rows(&admin.app).await;
    let image = format!("{}/image", avatar_path(&admin.id));
    for (method, path) in [
        ("GET", avatar_path(&admin.id)),
        ("GET", image.clone()),
        ("PUT", avatar_path(&admin.id)),
        ("DELETE", avatar_path(&admin.id)),
    ] {
        let builder = with_session(request(method, &path), &handheld, &admin.token);
        let request = if method == "PUT" {
            support::app::json(builder, put_body(&png(200)))
        } else {
            empty(builder)
        };
        let (status, _, _) = send_raw(&admin, request).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{method} {path}");
    }
    assert_eq!(audit_rows(&admin.app).await, rows);
    // An office PC reads with its own session.
    let token = login(&admin.app, &office_pc, "admin", "correct horse battery").await;
    let builder = with_session(request("GET", &image), &office_pc, &token);
    let (status, _, body) = send_raw(&admin, empty(builder)).await;
    assert_eq!((status, body), (StatusCode::OK, png(128)));
}

// ---- storage ------------------------------------------------------------------

#[tokio::test]
async fn the_table_holds_one_bounded_row_per_user() {
    let admin = admin().await;
    let pool = &admin.app.state.pool;
    let insert =
        |width: i64, height: i64, media: &str, data: Vec<u8>, version: i64, user: String| {
            let media = media.to_owned();
            async move {
                sqlx::query(
                    "INSERT INTO user_avatars \
                 (user_id, media_type, width, height, data, checksum, version, updated_at) \
                 VALUES (?, ?, ?, ?, ?, ?, ?, '2026-10-16T09:00:00.000Z')",
                )
                .bind(user)
                .bind(media)
                .bind(width)
                .bind(height)
                .bind(data)
                .bind("0".repeat(64))
                .bind(version)
                .execute(pool)
                .await
            }
        };
    let ok = || vec![1u8; 16];
    // The shape the host writes is accepted ...
    insert(128, 128, "image/png", ok(), 1, admin.id.clone())
        .await
        .unwrap();
    // ... the same user twice, and a user nobody made, are not ...
    assert!(insert(128, 128, "image/png", ok(), 1, admin.id.clone())
        .await
        .is_err());
    assert!(insert(128, 128, "image/png", ok(), 1, "ghost".to_owned())
        .await
        .is_err());
    // ... nor are sides, a type, a size or a version outside the contract.
    let (tech_id, _) = {
        let id = seed_office_user(&admin.app, "other", "technologist", "other password").await;
        (id, ())
    };
    for (width, height, media, data, version) in [
        (127, 128, "image/png", ok(), 1),
        (128, 4097, "image/png", ok(), 1),
        (128, 128, "image/gif", ok(), 1),
        (128, 128, "image/png", vec![1u8; 3], 1),
        (
            128,
            128,
            "image/png",
            vec![1u8; markiro_proto::avatar::MAX_BYTES + 1],
            1,
        ),
        (128, 128, "image/png", ok(), 0),
    ] {
        assert!(
            insert(width, height, media, data, version, tech_id.clone())
                .await
                .is_err(),
            "{width} {height} {media} {version}"
        );
    }
}
