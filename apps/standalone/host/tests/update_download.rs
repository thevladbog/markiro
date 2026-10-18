//! Downloading the installer from the host (plan ОБН-3, spec §10.11.3): the
//! whole file or one range of it, `If-Range` against the package's SHA-256,
//! `416` for a range the file lacks; one download per device, three on the
//! host, 30 requests a minute; exactly one `update.download` row for a
//! download from byte 0 and none for a resumed one or a refusal.

mod support;

use axum::body::Body;
use axum::http::{HeaderMap, Request, Response, StatusCode};
use http_body_util::BodyExt;
use markiro_host::server::router;
use serde_json::{json, Value};
use support::app::{
    admin, audit_trail, empty, pair_device, request, with_device, Admin, AuditRow, TestApp,
};
use support::update::{flip_byte, installer_name, sha256_hex, write_package};
use tower::ServiceExt;

/// A host of 0.3.0 that serves its package; the administrator's station and
/// the installer's bytes.
async fn serving() -> (Admin, Vec<u8>) {
    let mut admin = admin().await;
    let (_, bytes) = write_package(&admin.app.dir().join("updates"), "current", "0.3.0");
    admin.app.keep_updates("0.3.0");
    (admin, bytes)
}

/// `GET /v1/device/update/installer` with `key`, protocol 1 and `headers`;
/// the body is not read, so a held answer holds its download's slot.
async fn open(app: &TestApp, key: &str, headers: &[(&str, &str)]) -> Response<Body> {
    open_with(app, "GET", key, headers).await
}

async fn open_with(
    app: &TestApp,
    method: &str,
    key: &str,
    headers: &[(&str, &str)],
) -> Response<Body> {
    let mut builder = Request::builder()
        .method(method)
        .uri("/v1/device/update/installer")
        .header("authorization", format!("Bearer {key}"))
        .header(markiro_proto::PROTOCOL_HEADER, "1");
    for (name, value) in headers {
        builder = builder.header(*name, *value);
    }
    router(app.state.clone())
        .oneshot(builder.body(Body::empty()).unwrap())
        .await
        .unwrap()
}

async fn read(response: Response<Body>) -> (StatusCode, HeaderMap, Vec<u8>) {
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = response
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes()
        .to_vec();
    (status, headers, bytes)
}

fn header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|value| value.to_str().ok())
}

async fn device_id(app: &TestApp, key: &str) -> String {
    let (_, device) = app
        .send(empty(with_device(request("GET", "/v1/device"), key)))
        .await;
    device["id"].as_str().unwrap().to_owned()
}

fn download_row(device: &str, bytes: &[u8]) -> AuditRow {
    (
        "device".to_owned(),
        Some(device.to_owned()),
        "update.download".to_owned(),
        Some("update_package".to_owned()),
        Some("0.3.0".to_owned()),
        "ok".to_owned(),
        json!({ "version": "0.3.0", "sha256": sha256_hex(bytes), "sizeBytes": bytes.len() }),
    )
}

#[tokio::test]
async fn the_whole_installer_comes_with_its_etag_and_one_audit_row() {
    let (admin, bytes) = serving().await;
    let device = device_id(&admin.app, &admin.key).await;
    let (status, headers, body) = read(open(&admin.app, &admin.key, &[]).await).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, bytes);
    let etag = format!("\"{}\"", sha256_hex(&bytes));
    assert_eq!(
        (
            header(&headers, "content-length"),
            header(&headers, "etag"),
            header(&headers, "accept-ranges"),
            header(&headers, "content-type"),
        ),
        (
            Some(bytes.len().to_string().as_str()),
            Some(etag.as_str()),
            Some("bytes"),
            Some("application/octet-stream"),
        )
    );
    assert_eq!(
        audit_trail(&admin.app, "update.download").await,
        [download_row(&device, &bytes)]
    );
}

#[tokio::test]
async fn a_range_resumes_without_a_row_and_a_range_from_zero_writes_one() {
    let (admin, bytes) = serving().await;
    let device = device_id(&admin.app, &admin.key).await;
    let size = bytes.len();
    for (range, from, to) in [
        ("bytes=100-", 100, size - 1),
        ("bytes=100-199", 100, 199),
        ("bytes=100-99999999", 100, size - 1),
    ] {
        let (status, headers, body) =
            read(open(&admin.app, &admin.key, &[("range", range)]).await).await;
        assert_eq!(status, StatusCode::PARTIAL_CONTENT, "{range}");
        assert_eq!(body, bytes[from..=to], "{range}");
        assert_eq!(
            header(&headers, "content-range"),
            Some(format!("bytes {from}-{to}/{size}").as_str()),
            "{range}"
        );
    }
    assert!(audit_trail(&admin.app, "update.download").await.is_empty());
    let (status, _, body) =
        read(open(&admin.app, &admin.key, &[("range", "bytes=0-99")]).await).await;
    assert_eq!((status, body.len()), (StatusCode::PARTIAL_CONTENT, 100));
    assert_eq!(
        audit_trail(&admin.app, "update.download").await,
        [download_row(&device, &bytes)]
    );
}

#[tokio::test]
async fn if_range_with_another_etag_gives_the_whole_file_again() {
    let (admin, bytes) = serving().await;
    let etag = format!("\"{}\"", sha256_hex(&bytes));
    let (status, _, body) = read(
        open(
            &admin.app,
            &admin.key,
            &[("range", "bytes=100-"), ("if-range", "\"another\"")],
        )
        .await,
    )
    .await;
    assert_eq!((status, body.len()), (StatusCode::OK, bytes.len()));
    assert_eq!(audit_trail(&admin.app, "update.download").await.len(), 1);
    let (status, _, body) = read(
        open(
            &admin.app,
            &admin.key,
            &[("range", "bytes=100-"), ("if-range", etag.as_str())],
        )
        .await,
    )
    .await;
    assert_eq!(
        (status, body.len()),
        (StatusCode::PARTIAL_CONTENT, bytes.len() - 100)
    );
    assert_eq!(audit_trail(&admin.app, "update.download").await.len(), 1);
}

#[tokio::test]
async fn a_range_the_file_lacks_is_416_and_writes_nothing() {
    let (admin, bytes) = serving().await;
    let size = bytes.len();
    let beyond = format!("bytes={size}-");
    for range in [
        beyond.as_str(),
        "bytes=5-1",
        "bytes=0-1,5-6",
        "bytes=-100",
        "items=0-1",
        "bytes=x-",
        "bytes=",
    ] {
        let (status, headers, body) =
            read(open(&admin.app, &admin.key, &[("range", range)]).await).await;
        assert_eq!(status, StatusCode::RANGE_NOT_SATISFIABLE, "{range}");
        assert_eq!(
            header(&headers, "content-range"),
            Some(format!("bytes */{size}").as_str()),
            "{range}"
        );
        let body: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(
            body["error"]["details"],
            json!({ "field": "range" }),
            "{range}"
        );
    }
    assert!(audit_trail(&admin.app, "update.download").await.is_empty());
}

#[tokio::test]
async fn a_package_that_is_not_ok_is_not_served() {
    let mut admin = admin().await;
    admin.app.keep_updates("0.3.0");
    let (status, _, body) = read(open(&admin.app, &admin.key, &[]).await).await;
    let body: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(
        (status, &body["error"]["details"]),
        (
            StatusCode::CONFLICT,
            &json!({ "constraint": "package_unavailable" })
        )
    );

    let (admin, _) = serving().await;
    let current = admin.app.dir().join("updates/current");
    flip_byte(&current.join(installer_name("0.3.0")), 10);
    let (status, headers, body) = read(open(&admin.app, &admin.key, &[]).await).await;
    let body: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(
        (
            status,
            &body["error"]["code"],
            header(&headers, "retry-after")
        ),
        (
            StatusCode::SERVICE_UNAVAILABLE,
            &json!("package_verifying"),
            Some("5")
        )
    );
    assert!(audit_trail(&admin.app, "update.download").await.is_empty());
}

#[tokio::test]
async fn one_download_per_device_and_three_on_the_host() {
    let (admin, _) = serving().await;
    let first = open(&admin.app, &admin.key, &[]).await;
    assert_eq!(first.status(), StatusCode::OK);
    let (status, _, body) = read(open(&admin.app, &admin.key, &[]).await).await;
    let body: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(
        (status, &body["error"]["code"]),
        (StatusCode::TOO_MANY_REQUESTS, &json!("rate_limited"))
    );
    let mut held = vec![first];
    for _ in 0..2 {
        let (_, key) = pair_device(&admin.app, "station").await;
        let answer = open(&admin.app, &key, &[]).await;
        assert_eq!(answer.status(), StatusCode::OK);
        held.push(answer);
    }
    let (_, fourth) = pair_device(&admin.app, "station").await;
    let (status, headers, body) = read(open(&admin.app, &fourth, &[]).await).await;
    let body: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(
        (
            status,
            &body["error"]["code"],
            header(&headers, "retry-after")
        ),
        (
            StatusCode::SERVICE_UNAVAILABLE,
            &json!("update_busy"),
            Some("30")
        )
    );
    // A device that went away frees its slot.
    drop(held.remove(0));
    let mut status = StatusCode::SERVICE_UNAVAILABLE;
    for _ in 0..100 {
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        admin.app.clock.advance(time::Duration::seconds(3));
        status = open(&admin.app, &fourth, &[]).await.status();
        if status == StatusCode::OK {
            break;
        }
    }
    assert_eq!(status, StatusCode::OK);
}

async fn offer_status(app: &TestApp, key: &str) -> StatusCode {
    app.send(empty(with_device(request("GET", "/v1/device/update"), key)))
        .await
        .0
}

#[tokio::test]
async fn thirty_update_requests_a_minute_per_device() {
    let (admin, _) = serving().await;
    for _ in 0..30 {
        assert_eq!(offer_status(&admin.app, &admin.key).await, StatusCode::OK);
    }
    assert_eq!(
        offer_status(&admin.app, &admin.key).await,
        StatusCode::TOO_MANY_REQUESTS
    );
    let (status, _, _) = read(open(&admin.app, &admin.key, &[]).await).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "both routes count");
    admin.app.clock.advance(time::Duration::seconds(61));
    assert_eq!(offer_status(&admin.app, &admin.key).await, StatusCode::OK);
    assert!(audit_trail(&admin.app, "update.download").await.is_empty());
}

#[tokio::test]
async fn the_download_answers_any_protocol_but_only_a_device_key() {
    let (admin, bytes) = serving().await;
    let answer = router(admin.app.state.clone())
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/v1/device/update/installer")
                .header("authorization", format!("Bearer {}", admin.key))
                .header(markiro_proto::PROTOCOL_HEADER, "7")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let (status, _, body) = read(answer).await;
    assert_eq!((status, body.len()), (StatusCode::OK, bytes.len()));
    let (status, _, _) = read(
        router(admin.app.state.clone())
            .oneshot(
                request("GET", "/v1/device/update/installer")
                    .header(markiro_proto::OFFICE_SESSION_HEADER, &admin.token)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn a_head_gives_the_headers_only_without_a_slot_or_a_row() {
    let (admin, bytes) = serving().await;
    // A download in progress holds this device's only slot.
    let held = open(&admin.app, &admin.key, &[]).await;
    assert_eq!(held.status(), StatusCode::OK);
    let rows = audit_trail(&admin.app, "update.download").await;
    assert_eq!(rows.len(), 1);
    let (status, headers, body) = read(open_with(&admin.app, "HEAD", &admin.key, &[]).await).await;
    assert_eq!(status, StatusCode::OK);
    assert!(body.is_empty());
    let etag = format!("\"{}\"", sha256_hex(&bytes));
    assert_eq!(
        (
            header(&headers, "content-length"),
            header(&headers, "etag"),
            header(&headers, "accept-ranges"),
        ),
        (
            Some(bytes.len().to_string().as_str()),
            Some(etag.as_str()),
            Some("bytes"),
        )
    );
    assert_eq!(audit_trail(&admin.app, "update.download").await, rows);
    drop(held);
}
