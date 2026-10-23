mod support;

use aws_lc_rs::digest::{digest, SHA256};
use axum::http::StatusCode;
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde_json::{json, Value};
use support::app::{
    admin, box_closed, box_id, code_hash, empty, fact, instant, issue_block, issue_pallet_block,
    ok_scan, open_pallet_floor, pallet_closed, pallet_id, receipts, record_id, request,
    shift_closed, shift_setup, with_device, Admin, Floor,
};

const BLOCK_REQUEST: &str = "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a";
const PALLET_REQUEST: &str = "5e4d3c2b-1a09-4f8e-9d7c-6b5a4f3e2d1c";
const BATCH: &str = "5d6e7f80-9a1b-4c2d-8e3f-4a5b6c7d8e9f";
const FILE: &str = "7a1c2d3e-4f50-4a61-8b72-93a4b5c6d7e8";
const FILE_2: &str = "8b2d3e4f-5061-4b72-9c83-a4b5c6d7e8f9";
const CHUNK: usize = 1_048_576;

fn sha(bytes: &[u8]) -> String {
    digest(&SHA256, bytes)
        .as_ref()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Bytes a deflate cannot shrink: a xorshift stream.
fn noise(len: usize) -> Vec<u8> {
    let mut x: u64 = 0x9E37_79B9_7F4A_7C15;
    (0..len)
        .map(|_| {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            (x >> 24) as u8
        })
        .collect()
}

/// A shift with two closed boxes on one closed pallet, closed by the station.
async fn pallet_shift(admin: &Admin) -> Floor {
    let setup = shift_setup(admin).await;
    let floor = open_pallet_floor(admin, &setup, &admin.key.clone(), &setup.line).await;
    let block = issue_block(&admin.app, &floor.key, BLOCK_REQUEST).await;
    let pallets = issue_pallet_block(&admin.app, &floor.key, PALLET_REQUEST).await;
    let shift = floor.shift.clone();
    let mut first = box_closed(
        &box_id(1),
        &block,
        1500,
        &[1],
        &instant(10, 0),
        &instant(11, 0),
    );
    first["palletId"] = json!(pallet_id(1));
    let records = [
        fact(
            &record_id(1),
            "scan",
            &shift,
            ok_scan(1, &box_id(1), &instant(10, 0)),
        ),
        fact(&record_id(2), "box_closed", &shift, first),
        fact(
            &record_id(3),
            "pallet_closed",
            &shift,
            pallet_closed(
                &pallet_id(1),
                &pallets,
                40,
                1,
                &instant(11, 0),
                &instant(12, 0),
            ),
        ),
        fact(
            &record_id(4),
            "shift_closed",
            &shift,
            shift_closed(None, 1, 1, None, &instant(30, 0)),
        ),
    ];
    let answered = receipts(&admin.app, &floor.key, &records).await;
    assert!(
        answered.iter().all(|r| r["outcome"] == "accepted"),
        "{answered:?}"
    );
    let _ = code_hash(1);
    floor
}

fn begin_of(id: &str, part: u32, shift: &str, name: &str, bytes: &[u8]) -> Value {
    json!({
        "id": id, "batchId": BATCH, "partNo": part, "kind": "shift_export",
        "targetType": "shift", "targetId": shift,
        "formatId": "shift_xml_gismt_aggregation_pallets", "formatVersion": 1,
        "fileName": name, "sizeBytes": bytes.len(), "sha256": sha(bytes),
        "generator": "markiro-autonom test",
    })
}

fn with_content(mut begin: Value, bytes: &[u8]) -> Value {
    begin["contentBase64"] = json!(STANDARD.encode(bytes));
    begin
}

async fn put_chunk(
    admin: &Admin,
    token: &str,
    id: &str,
    seq: usize,
    raw: &[u8],
) -> (StatusCode, Value) {
    admin
        .call_as(
            token,
            "PUT",
            &format!("/v1/office/export-files/{id}/chunks/{seq}"),
            Some(json!({ "contentBase64": STANDARD.encode(raw) })),
        )
        .await
}

/// Sends `bytes` by chunks as `token` and seals the file.
async fn upload(admin: &Admin, token: &str, begin: Value, bytes: &[u8]) -> Value {
    let id = begin["id"].as_str().unwrap().to_owned();
    let (status, body) = admin
        .call_as(token, "POST", "/v1/office/export-files", Some(begin))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    for (seq, chunk) in bytes.chunks(CHUNK).enumerate() {
        let (status, body) = put_chunk(admin, token, &id, seq, chunk).await;
        assert_eq!(status, StatusCode::OK, "{body}");
    }
    let (status, body) = admin
        .call_as(
            token,
            "POST",
            &format!("/v1/office/export-files/{id}/complete"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["ready"], true);
    body
}

/// The bytes of a stored file, as the office downloads them.
async fn download(admin: &Admin, token: &str, id: &str) -> (StatusCode, Vec<u8>, Value) {
    let (status, opened) = admin
        .call_as(
            token,
            "POST",
            &format!("/v1/office/export-files/{id}/download"),
            None,
        )
        .await;
    if status != StatusCode::OK {
        return (status, Vec::new(), opened);
    }
    let mut bytes = Vec::new();
    for seq in 0..opened["chunkCount"].as_u64().unwrap() {
        let (status, chunk) = admin
            .call_as(
                token,
                "GET",
                &format!("/v1/office/export-files/{id}/chunks/{seq}"),
                None,
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{chunk}");
        bytes.extend(
            STANDARD
                .decode(chunk["contentBase64"].as_str().unwrap())
                .unwrap(),
        );
    }
    (status, bytes, opened)
}

async fn planned_shift(admin: &Admin) -> String {
    let setup = shift_setup(admin).await;
    let shift = support::app::plan_shift(admin, support::app::shift_body(&setup)).await;
    shift["id"].as_str().unwrap().to_owned()
}

/// A part of one chunk is stored by one call, listed, and downloaded back
/// byte for byte; the store and the download each write one audit row naming
/// the file, never its bytes.
#[tokio::test]
async fn a_small_file_is_stored_by_one_call_and_comes_back_byte_for_byte() {
    let admin = admin().await;
    let shift = planned_shift(&admin).await;
    let bytes = "<?xml version=\"1.0\"?><a>Привет</a>\n".as_bytes();
    let begin = with_content(begin_of(FILE, 1, &shift, "Отчет_1.xml", bytes), bytes);
    let (status, body) = admin
        .call("POST", "/v1/office/export-files", Some(begin.clone()))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body,
        json!({ "id": FILE, "chunkCount": 1, "receivedChunks": 1, "ready": true })
    );
    // The same call again answers the same, and stores nothing twice.
    let (status, again) = admin
        .call("POST", "/v1/office/export-files", Some(begin))
        .await;
    assert_eq!((status, &again), (StatusCode::OK, &body));
    let (status, listed) = admin
        .call(
            "GET",
            &format!("/v1/office/export-files?shiftId={shift}"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{listed}");
    let items = listed["items"].as_array().unwrap();
    assert_eq!(items.len(), 1, "{listed}");
    assert_eq!(items[0]["fileName"], "Отчет_1.xml");
    assert_eq!(items[0]["mediaType"], "application/xml; charset=utf-8");
    assert_eq!(items[0]["sha256"], sha(bytes));
    assert_eq!(items[0]["sizeBytes"], bytes.len());
    assert_eq!(items[0]["shiftId"], shift.as_str());
    assert_eq!(items[0]["userName"].is_string(), true);
    let (status, got, opened) = download(&admin, &admin.token, FILE).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(got, bytes);
    assert_eq!(opened["file"]["sha256"], sha(bytes));
    let details = |extra: Value| {
        let mut base = json!({
            "fileId": FILE, "batchId": BATCH, "partNo": 1, "kind": "shift_export",
            "formatId": "shift_xml_gismt_aggregation_pallets", "formatVersion": 1,
            "fileName": "Отчет_1.xml", "sizeBytes": bytes.len(), "sha256": sha(bytes),
        });
        if let (Some(base), Some(extra)) = (base.as_object_mut(), extra.as_object()) {
            base.extend(extra.clone());
        }
        base
    };
    assert_eq!(
        support::app::audit_trail(&admin.app, "shift.export.store").await,
        vec![admin.row("shift.export.store", "shift", &shift, details(json!({})))]
    );
    assert_eq!(
        support::app::audit_trail(&admin.app, "shift.export.download").await,
        vec![admin.row("shift.export.download", "shift", &shift, details(json!({})))]
    );
}

/// A file of several chunks (noise a deflate cannot shrink beside text it
/// shrinks a lot) is sent in order, can resume where it stopped, and comes
/// back unchanged; the text is kept deflated.
#[tokio::test]
async fn a_large_file_is_sent_in_chunks_resumed_and_served_unchanged() {
    let admin = admin().await;
    let shift = planned_shift(&admin).await;
    let mut bytes = noise(CHUNK + 17);
    bytes.extend(
        "<cis>0104600682000010215abc</cis>\n"
            .repeat(40_000)
            .into_bytes(),
    );
    let begin = begin_of(FILE, 1, &shift, "Большой.xml", &bytes);
    let (status, started) = admin
        .call("POST", "/v1/office/export-files", Some(begin.clone()))
        .await;
    assert_eq!(status, StatusCode::OK, "{started}");
    let chunks = bytes.chunks(CHUNK).count();
    assert_eq!(started["chunkCount"], chunks);
    assert_eq!(started["receivedChunks"], 0);
    // Chunk 0, then the connection drops; the office begins again and is told.
    assert_eq!(
        put_chunk(&admin, &admin.token, FILE, 0, &bytes[..CHUNK])
            .await
            .0,
        StatusCode::OK
    );
    let (_, resumed) = admin
        .call("POST", "/v1/office/export-files", Some(begin))
        .await;
    assert_eq!(resumed["receivedChunks"], 1);
    // A chunk twice with the same bytes is fine; with others it is a conflict.
    assert_eq!(
        put_chunk(&admin, &admin.token, FILE, 0, &bytes[..CHUNK])
            .await
            .0,
        StatusCode::OK
    );
    let mut other = bytes[..CHUNK].to_vec();
    other[0] ^= 1;
    assert_eq!(
        put_chunk(&admin, &admin.token, FILE, 0, &other).await.0,
        StatusCode::CONFLICT
    );
    // Out of order, and of the wrong size.
    assert_eq!(
        put_chunk(&admin, &admin.token, FILE, 2, &bytes[2 * CHUNK..])
            .await
            .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        put_chunk(&admin, &admin.token, FILE, 1, &bytes[CHUNK..CHUNK + 5])
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    // Sealing before the last chunk is a conflict, and the file is not served.
    let complete = format!("/v1/office/export-files/{FILE}/complete");
    assert_eq!(
        admin.call("POST", &complete, None).await.0,
        StatusCode::CONFLICT
    );
    let (status, _, _) = download(&admin, &admin.token, FILE).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    for (seq, chunk) in bytes.chunks(CHUNK).enumerate().skip(1) {
        assert_eq!(
            put_chunk(&admin, &admin.token, FILE, seq, chunk).await.0,
            StatusCode::OK
        );
    }
    let (status, sealed) = admin.call("POST", &complete, None).await;
    assert_eq!(status, StatusCode::OK, "{sealed}");
    assert_eq!(sealed["ready"], true);
    let (status, got, _) = download(&admin, &admin.token, FILE).await;
    assert_eq!(status, StatusCode::OK);
    assert!(got == bytes, "the re-downloaded bytes differ");
    let (stored, original): (i64, i64) =
        sqlx::query_as("SELECT stored_bytes, size_bytes FROM export_files WHERE id = ?")
            .bind(FILE)
            .fetch_one(&admin.app.state.pool)
            .await
            .unwrap();
    assert!(stored < original / 2, "{stored} of {original}");
    // Sealing again is the same answer.
    assert_eq!(admin.call("POST", &complete, None).await.0, StatusCode::OK);
}

/// Bytes that are not the file that was declared never become a file: the
/// upload is deleted and the office starts again.
#[tokio::test]
async fn chunks_that_do_not_make_the_declared_file_are_deleted_at_the_seal() {
    let admin = admin().await;
    let shift = planned_shift(&admin).await;
    let bytes = noise(CHUNK + 5);
    let mut begin = begin_of(FILE, 1, &shift, "Подмена.xml", &bytes);
    begin["sha256"] = json!(sha(b"something else"));
    admin
        .call("POST", "/v1/office/export-files", Some(begin))
        .await;
    for (seq, chunk) in bytes.chunks(CHUNK).enumerate() {
        assert_eq!(
            put_chunk(&admin, &admin.token, FILE, seq, chunk).await.0,
            StatusCode::OK
        );
    }
    let (status, body) = admin
        .call(
            "POST",
            &format!("/v1/office/export-files/{FILE}/complete"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(body["error"]["details"]["field"], "sha256");
    let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM export_files")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    let chunks: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM export_file_chunks")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    assert_eq!((rows, chunks), (0, 0));
    assert_eq!(
        support::app::audit_trail(&admin.app, "shift.export.store").await,
        vec![]
    );
    // A whole file sent in the begin call that is not the declared one is refused too.
    let begin = with_content(begin_of(FILE, 1, &shift, "Подмена.xml", b"abc"), b"abd");
    let (status, _) = admin
        .call("POST", "/v1/office/export-files", Some(begin))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM export_files")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    assert_eq!(rows, 0);
}

/// Damage to a stored chunk is found before anything is served: the download
/// is refused with `export_file_corrupted`, one `failed` row says so, and the
/// chunk itself is not handed on either.
#[tokio::test]
async fn a_damaged_file_is_refused_with_its_own_code_and_a_failed_audit_row() {
    let admin = admin().await;
    let shift = planned_shift(&admin).await;
    let bytes = "<a>".repeat(200_000).into_bytes();
    upload(
        &admin,
        &admin.token,
        begin_of(FILE, 1, &shift, "Цел.xml", &bytes),
        &bytes,
    )
    .await;
    assert_eq!(download(&admin, &admin.token, FILE).await.0, StatusCode::OK);
    // One byte of the first chunk changes on disk (an identity chunk would be
    // changed the same way; the deflate stream here fails its own check).
    let (encoding, mut content): (String, Vec<u8>) = sqlx::query_as(
        "SELECT encoding, content FROM export_file_chunks WHERE file_id = ? AND seq = 0",
    )
    .bind(FILE)
    .fetch_one(&admin.app.state.pool)
    .await
    .unwrap();
    assert_eq!(encoding, "deflate");
    let middle = content.len() / 2;
    content[middle] ^= 0x55;
    sqlx::query("UPDATE export_file_chunks SET content = ? WHERE file_id = ? AND seq = 0")
        .bind(&content)
        .bind(FILE)
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    let (status, _, body) = download(&admin, &admin.token, FILE).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{body}");
    assert_eq!(body["error"]["code"], "export_file_corrupted");
    let (status, chunk) = admin
        .call(
            "GET",
            &format!("/v1/office/export-files/{FILE}/chunks/0"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{chunk}");
    assert_eq!(chunk["error"]["code"], "export_file_corrupted");
    let rows = support::app::audit_trail(&admin.app, "shift.export.download").await;
    assert_eq!(rows.len(), 2, "{rows:?}");
    assert_eq!(rows[0].5, "ok");
    assert_eq!(rows[1].5, "failed");
    assert_eq!(rows[1].6["reason"], "corrupted");
    assert_eq!(rows[1].6["fileId"], FILE);
    // A chunk whose bytes changed but still inflate is caught by its SHA-256.
    let other = noise(300);
    let begin = begin_of(FILE_2, 1, &shift, "Шум.xml", &other);
    let mut begin = begin;
    begin["batchId"] = json!("11111111-2222-4333-8444-555555555555");
    upload(&admin, &admin.token, begin, &other).await;
    sqlx::query("UPDATE export_file_chunks SET content = ? WHERE file_id = ? AND seq = 0")
        .bind(noise(300).iter().map(|b| b ^ 1).collect::<Vec<u8>>())
        .bind(FILE_2)
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    let (status, _, body) = download(&admin, &admin.token, FILE_2).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{body}");
    assert_eq!(body["error"]["code"], "export_file_corrupted");
}

/// Only a signed-in office user stores, lists and downloads: a device key, no
/// credential and an unknown token are `401`; another user's half-sent upload
/// is `403`; an unknown file is `404`; the retention is the administrator's.
#[tokio::test]
async fn only_an_office_session_reaches_the_files_and_the_retention_is_the_administrators() {
    let admin = admin().await;
    let shift = planned_shift(&admin).await;
    let bytes = b"abc";
    let begin = with_content(begin_of(FILE, 1, &shift, "Три.xml", bytes), bytes);
    for (method, path, body) in [
        (
            "POST",
            "/v1/office/export-files".to_owned(),
            Some(begin.clone()),
        ),
        (
            "GET",
            format!("/v1/office/export-files?shiftId={shift}"),
            None,
        ),
        (
            "POST",
            format!("/v1/office/export-files/{FILE}/download"),
            None,
        ),
        (
            "GET",
            format!("/v1/office/export-files/{FILE}/chunks/0"),
            None,
        ),
        ("GET", "/v1/office/export-files/settings".to_owned(), None),
    ] {
        let build = |builder: axum::http::request::Builder| match &body {
            Some(body) => support::app::json(builder, body.clone()),
            None => empty(builder),
        };
        let (status, answer) = admin.app.send(build(request(method, &path))).await;
        assert_eq!(
            status,
            StatusCode::UNAUTHORIZED,
            "{method} {path}: {answer}"
        );
        let (status, answer) = admin
            .app
            .send(build(with_device(request(method, &path), &admin.key)))
            .await;
        assert_eq!(
            status,
            StatusCode::UNAUTHORIZED,
            "device {method} {path}: {answer}"
        );
        let (status, answer) = admin
            .app
            .send(build(support::app::with_session(
                request(method, &path),
                &admin.key,
                "not-a-token",
            )))
            .await;
        assert_eq!(
            status,
            StatusCode::UNAUTHORIZED,
            "token {method} {path}: {answer}"
        );
    }
    let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM export_files")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    assert_eq!(rows, 0);
    // A half-sent upload of the administrator is not the technologist's to continue.
    let big = noise(CHUNK + 1);
    admin
        .call(
            "POST",
            "/v1/office/export-files",
            Some(begin_of(FILE, 1, &shift, "Два.xml", &big)),
        )
        .await;
    let technologist = admin.technologist().await;
    assert_eq!(
        put_chunk(&admin, &technologist, FILE, 0, &big[..CHUNK])
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        admin
            .call_as(
                &technologist,
                "POST",
                &format!("/v1/office/export-files/{FILE}/complete"),
                None
            )
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        admin
            .call(
                "POST",
                &format!("/v1/office/export-files/{FILE_2}/download"),
                None
            )
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    // The technologist reads the settings and cannot change them.
    let (status, settings) = admin
        .call_as(
            &technologist,
            "GET",
            "/v1/office/export-files/settings",
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{settings}");
    assert_eq!(settings["retentionDays"], Value::Null);
    let (status, _) = admin
        .call_as(
            &technologist,
            "PUT",
            "/v1/office/export-files/settings",
            Some(json!({ "retentionDays": 90 })),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

/// What the host refuses changes nothing: a format the office does not
/// generate, a kind against another target, a name with a separator or the
/// wrong extension, a part outside 1–1000, a size of nothing or past 256 MiB,
/// a digest that is no hex, a target that does not exist, a part stored twice.
#[tokio::test]
async fn a_begin_the_host_cannot_take_is_refused_and_stores_nothing() {
    let admin = admin().await;
    let shift = planned_shift(&admin).await;
    let bytes = b"abc";
    let good = begin_of(FILE, 1, &shift, "Три.xml", bytes);
    let cases: Vec<(&str, Value, StatusCode)> = vec![
        (
            "format",
            {
                let mut b = good.clone();
                b["formatId"] = json!("shift_xml_unknown");
                b
            },
            StatusCode::BAD_REQUEST,
        ),
        (
            "old version",
            {
                let mut b = good.clone();
                b["formatVersion"] = json!(9);
                b
            },
            StatusCode::BAD_REQUEST,
        ),
        (
            "kind against target",
            {
                let mut b = good.clone();
                b["kind"] = json!("pallet_export");
                b
            },
            StatusCode::BAD_REQUEST,
        ),
        (
            "separator",
            {
                let mut b = good.clone();
                b["fileName"] = json!("a/b.xml");
                b
            },
            StatusCode::BAD_REQUEST,
        ),
        (
            "extension",
            {
                let mut b = good.clone();
                b["fileName"] = json!("a.exe");
                b
            },
            StatusCode::BAD_REQUEST,
        ),
        (
            "html export",
            {
                let mut b = good.clone();
                b["fileName"] = json!("a.html");
                b
            },
            StatusCode::BAD_REQUEST,
        ),
        (
            "part 0",
            {
                let mut b = good.clone();
                b["partNo"] = json!(0);
                b
            },
            StatusCode::BAD_REQUEST,
        ),
        (
            "part 1001",
            {
                let mut b = good.clone();
                b["partNo"] = json!(1001);
                b
            },
            StatusCode::BAD_REQUEST,
        ),
        (
            "size 0",
            {
                let mut b = good.clone();
                b["sizeBytes"] = json!(0);
                b
            },
            StatusCode::BAD_REQUEST,
        ),
        (
            "too large",
            {
                let mut b = good.clone();
                b["sizeBytes"] = json!(268_435_457_u64);
                b
            },
            StatusCode::PAYLOAD_TOO_LARGE,
        ),
        (
            "digest",
            {
                let mut b = good.clone();
                b["sha256"] = json!("ABC");
                b
            },
            StatusCode::BAD_REQUEST,
        ),
        (
            "unknown target",
            {
                let mut b = good.clone();
                b["targetId"] = json!("0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b");
                b
            },
            StatusCode::BAD_REQUEST,
        ),
        (
            "not a uuid",
            {
                let mut b = good.clone();
                b["batchId"] = json!("nope");
                b
            },
            StatusCode::BAD_REQUEST,
        ),
        (
            "extra field",
            {
                let mut b = good.clone();
                b["extra"] = json!(1);
                b
            },
            StatusCode::BAD_REQUEST,
        ),
        (
            "whole file of many chunks",
            {
                let mut b = good.clone();
                b["sizeBytes"] = json!(CHUNK * 2);
                b["contentBase64"] = json!("YWJj");
                b
            },
            StatusCode::BAD_REQUEST,
        ),
    ];
    for (name, body, expected) in cases {
        let (status, answer) = admin
            .call("POST", "/v1/office/export-files", Some(body))
            .await;
        assert_eq!(status, expected, "{name}: {answer}");
    }
    let too_large = admin
        .call(
            "POST",
            "/v1/office/export-files",
            Some({
                let mut b = good.clone();
                b["sizeBytes"] = json!(268_435_457_u64);
                b
            }),
        )
        .await
        .1;
    assert_eq!(too_large["error"]["code"], "export_file_too_large");
    let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM export_files")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    assert_eq!(rows, 0);
    // The same part of the same export under another id is a conflict.
    let first = with_content(good.clone(), bytes);
    assert_eq!(
        admin
            .call("POST", "/v1/office/export-files", Some(first))
            .await
            .0,
        StatusCode::OK
    );
    let second = with_content(begin_of(FILE_2, 1, &shift, "Три.xml", bytes), bytes);
    assert_eq!(
        admin
            .call("POST", "/v1/office/export-files", Some(second))
            .await
            .0,
        StatusCode::CONFLICT
    );
    // The same id with another digest is a conflict too.
    let mut changed = with_content(good, b"abd");
    changed["sha256"] = json!(sha(b"abd"));
    assert_eq!(
        admin
            .call("POST", "/v1/office/export-files", Some(changed))
            .await
            .0,
        StatusCode::CONFLICT
    );
}

/// A full store refuses a new file with its own code and a number to say
/// why, and keeps what it holds; a half-sent file goes after an hour and
/// gives its room back.
#[tokio::test]
async fn a_full_store_refuses_with_its_code_and_a_stale_upload_gives_its_room_back() {
    let admin = admin().await;
    let shift = planned_shift(&admin).await;
    let full = sqlx::query(
        "INSERT INTO export_files (id, batch_id, part_no, kind, target_type, target_id, shift_id, \
         format_id, format_version, file_name, media_type, size_bytes, chunk_count, sha256, \
         generator, state, stored_bytes, created_at, actor_id) \
         VALUES ('ffffffff-0000-4000-8000-000000000001', 'ffffffff-0000-4000-8000-000000000002', \
         1, 'shift_export', 'shift', ?, ?, 'shift_txt_flat', 1, 'x.txt', 'text/plain', 1, 1, ?, \
         'g', 'ready', 2147483648, '2026-10-01T00:00:00Z', ?)",
    )
    .bind(&shift)
    .bind(&shift)
    .bind(sha(b"x"))
    .bind(&admin.id)
    .execute(&admin.app.state.pool)
    .await
    .unwrap();
    assert_eq!(full.rows_affected(), 1);
    let begin = with_content(begin_of(FILE, 1, &shift, "Три.xml", b"abc"), b"abc");
    let (status, body) = admin
        .call("POST", "/v1/office/export-files", Some(begin))
        .await;
    assert_eq!(status, StatusCode::INSUFFICIENT_STORAGE, "{body}");
    assert_eq!(body["error"]["code"], "export_store_full");
    assert_eq!(body["error"]["details"]["maxBytes"], 2_147_483_648_u64);
    // The administrator's settings say what the store holds.
    let (_, settings) = admin
        .call("GET", "/v1/office/export-files/settings", None)
        .await;
    assert_eq!(settings["storedBytes"], 2_147_483_648_u64);
    assert_eq!(settings["maxStoredBytes"], 2_147_483_648_u64);
    // Room again: a half-sent file is swept an hour on, before the next one starts.
    sqlx::query("UPDATE export_files SET stored_bytes = 100, state = 'uploading'")
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE export_files SET created_at = '2026-01-01T00:00:00Z'")
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    let begin = with_content(begin_of(FILE, 1, &shift, "Три.xml", b"abc"), b"abc");
    let (status, body) = admin
        .call("POST", "/v1/office/export-files", Some(begin))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let held: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM export_files")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    assert_eq!(held, 1);
}

/// Files of a box, a pallet and the shift are listed by shift and by card;
/// a form is a file of its kind; a disaggregation file needs the right role;
/// the shift's history of exports names the parts each export stored.
#[tokio::test]
async fn files_are_listed_by_shift_and_by_card_and_the_history_names_each_exports_parts() {
    let admin = admin().await;
    let floor = pallet_shift(&admin).await;
    let shift = floor.shift.clone();
    let box_target = box_id(1);
    let pallet_target = pallet_id(1);
    let html = b"<html>box</html>";
    let mut form = json!({
        "id": FILE, "batchId": "22222222-3333-4444-8555-666666666666", "partNo": 1,
        "kind": "form", "targetType": "box", "targetId": box_target,
        "formatId": "form_box", "formatVersion": 1, "fileName": "Состав короба 1.html",
        "sizeBytes": html.len(), "sha256": sha(html), "generator": "t",
    });
    form["contentBase64"] = json!(STANDARD.encode(html));
    assert_eq!(
        admin
            .call("POST", "/v1/office/export-files", Some(form.clone()))
            .await
            .0,
        StatusCode::OK
    );
    // A form against the wrong target is refused.
    let mut wrong = form.clone();
    wrong["id"] = json!(FILE_2);
    wrong["targetType"] = json!("pallet");
    wrong["targetId"] = json!(pallet_target);
    assert_eq!(
        admin
            .call("POST", "/v1/office/export-files", Some(wrong))
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    let xml = b"<pallet/>";
    let mut export = json!({
        "id": FILE_2, "batchId": BATCH, "partNo": 1, "kind": "pallet_export",
        "targetType": "pallet", "targetId": pallet_target,
        "formatId": "pallet_xml_gismt_aggregation", "formatVersion": 1,
        "fileName": "pallet.xml", "sizeBytes": xml.len(), "sha256": sha(xml), "generator": "t",
    });
    export["contentBase64"] = json!(STANDARD.encode(xml));
    assert_eq!(
        admin
            .call("POST", "/v1/office/export-files", Some(export))
            .await
            .0,
        StatusCode::OK
    );
    // The box's card sees its form; the pallet's its file; the shift both.
    let (_, by_box) = admin
        .call(
            "GET",
            &format!("/v1/office/export-files?targetType=box&targetId={box_target}"),
            None,
        )
        .await;
    assert_eq!(by_box["items"].as_array().unwrap().len(), 1);
    assert_eq!(by_box["items"][0]["shiftId"], shift.as_str());
    let (_, by_pallet) = admin
        .call(
            "GET",
            &format!("/v1/office/export-files?targetType=pallet&targetId={pallet_target}"),
            None,
        )
        .await;
    assert_eq!(by_pallet["items"][0]["kind"], "pallet_export");
    let (_, by_shift) = admin
        .call(
            "GET",
            &format!("/v1/office/export-files?shiftId={shift}"),
            None,
        )
        .await;
    assert_eq!(by_shift["items"].as_array().unwrap().len(), 2);
    let (_, forms) = admin
        .call(
            "GET",
            &format!("/v1/office/export-files?shiftId={shift}&kind=form"),
            None,
        )
        .await;
    assert_eq!(forms["items"].as_array().unwrap().len(), 1);
    assert_eq!(forms["items"][0]["formatId"], "form_box");
    // Queries that name no scope are refused.
    for path in [
        "/v1/office/export-files",
        "/v1/office/export-files?targetType=box",
        "/v1/office/export-files?shiftId=nope",
    ] {
        assert_eq!(
            admin.call("GET", path, None).await.0,
            StatusCode::BAD_REQUEST,
            "{path}"
        );
    }
    // The record of the pallet's export joins the file by its documentId.
    let (status, _) = admin
        .call(
            "POST",
            &format!("/v1/office/shifts/{shift}/exports"),
            Some(json!({
                "formatId": "pallet_xml_gismt_aggregation", "formatVersion": 1, "maxLines": null,
                "palletId": pallet_target, "documentId": BATCH, "partCount": 1, "codeCount": 0,
                "boxCount": 1, "palletCount": 1, "openPalletSuppressedBoxCount": 0,
            })),
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, history) = admin
        .call("GET", &format!("/v1/office/shifts/{shift}/exports"), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{history}");
    let files = history["items"][0]["files"].as_array().unwrap();
    assert_eq!(files.len(), 1, "{history}");
    assert_eq!(files[0]["id"], FILE_2);
    assert_eq!(files[0]["fileName"], "pallet.xml");
    // Another export, recorded before any file was stored, lists none.
    let (status, _) = admin
        .call(
            "POST",
            &format!("/v1/office/shifts/{shift}/exports"),
            Some(json!({
                "formatId": "shift_txt_flat", "formatVersion": 1, "maxLines": null,
                "palletId": null, "documentId": "99999999-9999-4999-8999-999999999999",
                "partCount": 1, "codeCount": 1, "boxCount": 0, "palletCount": 0,
                "openPalletSuppressedBoxCount": 0,
            })),
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (_, history) = admin
        .call("GET", &format!("/v1/office/shifts/{shift}/exports"), None)
        .await;
    assert_eq!(history["items"][0]["files"], json!([]));
    // The lists search by an index.
    for (sql, bind) in [
        (
            "EXPLAIN QUERY PLAN SELECT id FROM export_files WHERE shift_id = ?1 AND state = 'ready'",
            shift.clone(),
        ),
        (
            "EXPLAIN QUERY PLAN SELECT id FROM export_files WHERE target_type = 'box' AND target_id = ?1",
            box_target.clone(),
        ),
    ] {
        let plan: Vec<(i64, i64, i64, String)> = sqlx::query_as(sql)
            .bind(bind)
            .fetch_all(&admin.app.state.pool)
            .await
            .unwrap();
        assert!(
            plan.iter().all(|(_, _, _, step)| !step.starts_with("SCAN")),
            "{plan:?}"
        );
    }
}

/// The retention is «always» until an administrator names days; saving it
/// deletes what is older (and says how many); a new file stored later sweeps
/// too; changing it writes one row, repeating it none.
#[tokio::test]
async fn the_retention_keeps_always_by_default_and_purges_what_it_is_set_below() {
    let admin = admin().await;
    let shift = planned_shift(&admin).await;
    let old = with_content(begin_of(FILE, 1, &shift, "Старый.xml", b"abc"), b"abc");
    assert_eq!(
        admin
            .call("POST", "/v1/office/export-files", Some(old))
            .await
            .0,
        StatusCode::OK
    );
    sqlx::query("UPDATE export_files SET created_at = '2024-01-01T00:00:00Z'")
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    // Nothing is deleted while the retention is «always», however old.
    let mut newer = begin_of(FILE_2, 1, &shift, "Новый.xml", b"abd");
    newer["batchId"] = json!("11111111-2222-4333-8444-555555555555");
    assert_eq!(
        admin
            .call(
                "POST",
                "/v1/office/export-files",
                Some(with_content(newer, b"abd"))
            )
            .await
            .0,
        StatusCode::OK
    );
    let (_, settings) = admin
        .call("GET", "/v1/office/export-files/settings", None)
        .await;
    assert_eq!(settings["fileCount"], 2);
    assert_eq!(settings["retentionDays"], Value::Null);
    for days in [0, 29, 3651] {
        let (status, _) = admin
            .call(
                "PUT",
                "/v1/office/export-files/settings",
                Some(json!({ "retentionDays": days })),
            )
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{days}");
    }
    let (status, saved) = admin
        .call(
            "PUT",
            "/v1/office/export-files/settings",
            Some(json!({ "retentionDays": 365 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(saved["retentionDays"], 365);
    assert_eq!(saved["fileCount"], 1);
    assert_eq!(
        support::app::audit_trail(&admin.app, "shift.export.retention").await,
        vec![{
            let mut row = admin.row(
                "shift.export.retention",
                "x",
                "x",
                json!({ "from": null, "to": 365 }),
            );
            row.3 = None;
            row.4 = None;
            row
        }]
    );
    let purges = support::app::audit_trail(&admin.app, "shift.export.purge").await;
    assert_eq!(purges.len(), 1);
    assert_eq!(
        purges[0].6,
        json!({ "removedFiles": 1, "retentionDays": 365 })
    );
    // Saving the same retention again changes and purges nothing.
    admin
        .call(
            "PUT",
            "/v1/office/export-files/settings",
            Some(json!({ "retentionDays": 365 })),
        )
        .await;
    assert_eq!(
        support::app::audit_trail(&admin.app, "shift.export.retention")
            .await
            .len(),
        1
    );
    assert_eq!(
        support::app::audit_trail(&admin.app, "shift.export.purge")
            .await
            .len(),
        1
    );
    // The purged file is gone with its chunks.
    let chunks: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM export_file_chunks")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    assert_eq!(chunks, 1);
    // And «always» again.
    let (_, back) = admin
        .call(
            "PUT",
            "/v1/office/export-files/settings",
            Some(json!({ "retentionDays": null })),
        )
        .await;
    assert_eq!(back["retentionDays"], Value::Null);
}

/// The files are in the database, so a copy carries them and a restore puts
/// them back: a multi-chunk file stored before the copy is back byte for byte
/// with its metadata after `markiro-host restore`; a file stored after the
/// copy is not in it (it is in the database the restore set aside).
#[tokio::test]
async fn a_restore_keeps_the_files_the_copy_held_and_sets_aside_the_later_ones() {
    use markiro_host::backup::copy::make_copy;
    use markiro_host::restore::restore;
    use markiro_proto::backup::BackupTrigger;
    use sqlx::Connection;

    let admin = admin().await;
    let shift = planned_shift(&admin).await;
    let mut kept = noise(CHUNK + 100);
    kept.extend(
        "<cis>0104600682000010215abc</cis>\n"
            .repeat(30_000)
            .into_bytes(),
    );
    upload(
        &admin,
        &admin.token,
        begin_of(FILE, 1, &shift, "До копии.xml", &kept),
        &kept,
    )
    .await;
    let folder = admin.app.dir().join("backups");
    std::fs::create_dir_all(&folder).unwrap();
    let mut conn = support::backup::worker_conn(&admin.app).await;
    let manifest = make_copy(
        &mut conn,
        &folder,
        admin.app.state.now(),
        BackupTrigger::Scheduled,
        &admin.app.state.host_id,
    )
    .await
    .unwrap();
    conn.close().await.unwrap();
    let later = b"<later/>";
    let mut begin = with_content(begin_of(FILE_2, 1, &shift, "После.xml", later), later);
    begin["batchId"] = json!("11111111-2222-4333-8444-555555555555");
    assert_eq!(
        admin
            .call("POST", "/v1/office/export-files", Some(begin))
            .await
            .0,
        StatusCode::OK
    );
    // Stop the host (the database closes clean) and restore the copy.
    let paths = support::backup::stop(&admin.app).await;
    let report = restore(
        &paths,
        &folder.join(&manifest.file),
        false,
        support::backup::at("2026-10-09T15:00:00Z"),
    )
    .await
    .unwrap();
    let pool = markiro_host::db::open(&paths.database_file())
        .await
        .unwrap();
    let files: Vec<(String, String, i64, String)> =
        sqlx::query_as("SELECT id, file_name, size_bytes, sha256 FROM export_files ORDER BY id")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(
        files,
        vec![(
            FILE.to_owned(),
            "До копии.xml".to_owned(),
            kept.len() as i64,
            sha(&kept)
        )]
    );
    let chunks: Vec<(String, Vec<u8>)> = sqlx::query_as(
        "SELECT encoding, content FROM export_file_chunks WHERE file_id = ? ORDER BY seq",
    )
    .bind(FILE)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(chunks.len(), kept.chunks(CHUNK).count());
    // The chunks reassemble to the stored file: the digest of the whole is the declared one.
    use std::io::Read;
    let mut whole = Vec::new();
    for (encoding, content) in &chunks {
        if encoding == "deflate" {
            flate2::read::DeflateDecoder::new(content.as_slice())
                .read_to_end(&mut whole)
                .unwrap();
        } else {
            whole.extend(content);
        }
    }
    assert!(whole == kept, "the restored file differs");
    // The file stored after the copy is in the set-aside database.
    let aside = report.saved_as.expect("the previous database is set aside");
    let aside_pool = markiro_host::db::open(&aside.join("host.db"))
        .await
        .unwrap();
    let later_rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM export_files WHERE id = ?")
        .bind(FILE_2)
        .fetch_one(&aside_pool)
        .await
        .unwrap();
    assert_eq!(later_rows, 1);
}
