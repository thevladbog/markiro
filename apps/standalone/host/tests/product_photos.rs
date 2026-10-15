//! A product's photo (plan ТОВ, task 2): `GET`, `PUT` and `DELETE
//! /v1/office/products/{id}/photo`, and migration `0023` that holds it with
//! the product's EGAIS code and default counterparty.

mod support;

use axum::http::StatusCode;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use support::app::{
    admin, audit_rows, audit_trail, empty, host_revision, login, request, seed_office_user,
    turn_the_user_off_at_the_next_activity, with_device, Admin,
};

/// `proto/fixtures/product-photo-put.json`: 13 bytes that start with the
/// JPEG signature `FF D8 FF`.
fn photo() -> Value {
    json!({ "width": 2, "height": 1, "dataBase64": "/9j/4AAQSkZJRgABAQ==" })
}

/// SHA-256 of the fixture's 13 bytes (`product-photo-state.json`).
const CHECKSUM: &str = "ae0e381fa858d6782d6859eb9337b80e670dc0021361fdd55d49299f1b4c26fd";

/// A JPEG-looking photo of exactly `len` bytes.
fn jpeg_of(len: usize) -> Value {
    let mut bytes = vec![0u8; len];
    bytes[..3].copy_from_slice(&[0xFF, 0xD8, 0xFF]);
    json!({ "width": 640, "height": 480, "dataBase64": STANDARD.encode(bytes) })
}

async fn product(admin: &Admin) -> String {
    let (status, created) = admin
        .call(
            "POST",
            "/v1/office/products",
            Some(json!({ "gtin14": "04600682000013", "name": "Молоко 3,2% 0,9 л" })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    created["id"].as_str().unwrap().to_owned()
}

fn path(id: &str) -> String {
    format!("/v1/office/products/{id}/photo")
}

/// What the table holds: `(width, height, length, checksum)`.
async fn stored(admin: &Admin, id: &str) -> Option<(i64, i64, i64, String)> {
    sqlx::query_as(
        "SELECT width, height, length(data), checksum FROM product_photos WHERE product_id = ?",
    )
    .bind(id)
    .fetch_optional(&admin.app.state.pool)
    .await
    .unwrap()
}

/// The `(status, code, field)` of a refused request.
fn refusal(status: StatusCode, body: &Value) -> (StatusCode, Value, Value) {
    (
        status,
        body["error"]["code"].clone(),
        body["error"]["details"]["field"].clone(),
    )
}

#[tokio::test]
async fn a_product_without_a_photo_answers_none() {
    let admin = admin().await;
    let id = product(&admin).await;
    let (status, body) = admin.call("GET", &path(&id), None).await;
    assert_eq!((status, body), (StatusCode::OK, json!({ "photo": null })));
}

#[tokio::test]
async fn the_photo_is_kept_with_its_checksum_and_named_in_the_list() {
    let admin = admin().await;
    let id = product(&admin).await;
    let revision = host_revision(&admin.app).await;
    let (status, put) = admin.call("PUT", &path(&id), Some(photo())).await;
    assert_eq!(status, StatusCode::OK, "{put}");
    assert_eq!(put["photo"]["checksum"], CHECKSUM);
    assert_eq!(put["photo"]["dataBase64"], "/9j/4AAQSkZJRgABAQ==");
    assert_eq!(
        (
            put["photo"]["width"].clone(),
            put["photo"]["height"].clone()
        ),
        (json!(2), json!(1))
    );
    let (status, read) = admin.call("GET", &path(&id), None).await;
    assert_eq!((status, read), (StatusCode::OK, put.clone()));
    assert_eq!(
        stored(&admin, &id).await,
        Some((2, 1, 13, CHECKSUM.to_owned()))
    );
    let (status, list) = admin.call("GET", "/v1/office/products", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(list[0]["photoChecksum"], CHECKSUM);
    // A photo takes one host revision (the station shows it, beta 3) but
    // never the product's own `rev`: that is the office's `expectedRev`, and
    // the product dialog saves after it uploaded the photo.
    assert_eq!(host_revision(&admin.app).await, revision + 1);
    assert_eq!(list[0]["rev"], json!(revision));
}

#[tokio::test]
async fn a_photo_change_reaches_the_station_feed_with_its_checksum() {
    let admin = admin().await;
    let id = product(&admin).await;
    let created = host_revision(&admin.app).await;
    admin.call("PUT", &path(&id), Some(photo())).await;
    let set = host_revision(&admin.app).await;
    assert_eq!(set, created + 1);
    // The product comes again, at the photo's revision, with the checksum.
    let items = admin.feed(created).await;
    let items: Vec<&Value> = items
        .as_array()
        .unwrap()
        .iter()
        .filter(|item| item["entity"] == "products")
        .collect();
    assert_eq!(items.len(), 1, "{items:?}");
    assert_eq!(
        (items[0]["id"].as_str(), items[0]["rev"].clone()),
        (Some(id.as_str()), json!(set))
    );
    assert_eq!(items[0]["data"]["photoChecksum"], CHECKSUM);
    // The same photo again takes no revision.
    admin.call("PUT", &path(&id), Some(photo())).await;
    assert_eq!(host_revision(&admin.app).await, set);
    // Clearing takes one and the record says none; clearing none takes none.
    admin.call("DELETE", &path(&id), None).await;
    let cleared = host_revision(&admin.app).await;
    assert_eq!(cleared, set + 1);
    let items = admin.feed(set).await;
    assert_eq!(items[0]["rev"], json!(cleared));
    assert_eq!(items[0]["data"]["photoChecksum"], Value::Null);
    admin.call("DELETE", &path(&id), None).await;
    assert_eq!(host_revision(&admin.app).await, cleared);
}

#[tokio::test]
async fn the_product_dialog_can_save_after_it_uploaded_a_photo() {
    let admin = admin().await;
    let (_, created) = admin
        .call(
            "POST",
            "/v1/office/products",
            Some(json!({ "gtin14": "04600682000020", "name": "Кефир" })),
        )
        .await;
    let id = created["id"].as_str().unwrap().to_owned();
    let rev = created["rev"].clone();
    admin.call("PUT", &path(&id), Some(photo())).await;
    let (status, body) = admin
        .call(
            "PUT",
            &format!("/v1/office/products/{id}"),
            Some(json!({
                "gtin14": "04600682000020", "name": "Кефир 1%", "archived": false, "expectedRev": rev
            })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    // The edit's own revision is above the photo's: the feed sends it once more.
    let items = admin.feed(0).await;
    let record = items
        .as_array()
        .unwrap()
        .iter()
        .filter(|item| item["entity"] == "products")
        .last()
        .unwrap();
    assert_eq!(record["data"]["name"], "Кефир 1%");
    assert_eq!(record["data"]["photoChecksum"], CHECKSUM);
}

#[tokio::test]
async fn a_station_reads_the_photo_with_its_device_key_only() {
    let admin = admin().await;
    let id = product(&admin).await;
    let device_path = format!("/v1/device/products/{id}/photo");
    let (status, none) = admin
        .app
        .send(empty(with_device(request("GET", &device_path), &admin.key)))
        .await;
    assert_eq!((status, none), (StatusCode::OK, json!({ "photo": null })));
    admin.call("PUT", &path(&id), Some(photo())).await;
    let (status, read) = admin
        .app
        .send(empty(with_device(request("GET", &device_path), &admin.key)))
        .await;
    assert_eq!(status, StatusCode::OK, "{read}");
    assert_eq!(read["photo"]["checksum"], CHECKSUM);
    assert_eq!(read["photo"]["dataBase64"], "/9j/4AAQSkZJRgABAQ==");
    // No key: refused; an unknown product: not found.
    let (status, error) = admin.app.send(empty(request("GET", &device_path))).await;
    assert_eq!(
        (status, error["error"]["code"].clone()),
        (StatusCode::UNAUTHORIZED, json!("unauthorized"))
    );
    let (status, error) = admin
        .app
        .send(empty(with_device(
            request(
                "GET",
                "/v1/device/products/00000000-0000-4000-8000-000000000000/photo",
            ),
            &admin.key,
        )))
        .await;
    assert_eq!(
        (status, error["error"]["code"].clone()),
        (StatusCode::NOT_FOUND, json!("not_found"))
    );
}

#[tokio::test]
async fn setting_audits_the_size_without_the_bytes_and_clearing_audits_once() {
    let admin = admin().await;
    let id = product(&admin).await;
    admin.call("PUT", &path(&id), Some(photo())).await;
    let set = audit_trail(&admin.app, "product.photo.set").await;
    assert_eq!(
        set,
        vec![admin.row(
            "product.photo.set",
            "product",
            &id,
            json!({ "width": 2, "height": 1, "bytes": 13, "mediaType": "image/jpeg" })
        )]
    );
    let details: Vec<String> = sqlx::query_scalar("SELECT details FROM audit_log")
        .fetch_all(&admin.app.state.pool)
        .await
        .unwrap();
    assert!(
        details.iter().all(|text| !text.contains("/9j/")),
        "{details:?}"
    );

    let (status, cleared) = admin.call("DELETE", &path(&id), None).await;
    assert_eq!(
        (status, cleared),
        (StatusCode::OK, json!({ "photo": null }))
    );
    assert_eq!(stored(&admin, &id).await, None);
    let clear = audit_trail(&admin.app, "product.photo.clear").await;
    assert_eq!(
        clear,
        vec![admin.row("product.photo.clear", "product", &id, json!({}))]
    );
    // Clearing none answers the same and writes nothing.
    let rows = audit_rows(&admin.app).await;
    let (status, again) = admin.call("DELETE", &path(&id), None).await;
    assert_eq!((status, again), (StatusCode::OK, json!({ "photo": null })));
    assert_eq!(audit_rows(&admin.app).await, rows);
    let (status, list) = admin.call("GET", "/v1/office/products", None).await;
    assert_eq!(
        (status, list[0]["photoChecksum"].clone()),
        (StatusCode::OK, Value::Null)
    );
}

#[tokio::test]
async fn a_technologist_writes_the_photo() {
    let admin = admin().await;
    let id = product(&admin).await;
    let (token, tech_id) = admin.technologist_session().await;
    let (status, body) = admin
        .call_as(&token, "PUT", &path(&id), Some(photo()))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let set = audit_trail(&admin.app, "product.photo.set").await;
    assert_eq!(set.len(), 1);
    assert_eq!(set[0].1.as_deref(), Some(tech_id.as_str()));
    let (status, body) = admin.call_as(&token, "DELETE", &path(&id), None).await;
    assert_eq!((status, body), (StatusCode::OK, json!({ "photo": null })));
}

#[tokio::test]
async fn nobody_without_an_office_session_touches_the_photo() {
    let admin = admin().await;
    let id = product(&admin).await;
    admin.call("PUT", &path(&id), Some(photo())).await;
    let before = stored(&admin, &id).await;
    let rows = audit_rows(&admin.app).await;
    for method in ["GET", "PUT", "DELETE"] {
        let builder = with_device(request(method, &path(&id)), &admin.key);
        let device_only = match method {
            "PUT" => support::app::json(builder, photo()),
            _ => empty(builder),
        };
        let (status, error) = admin.app.send(device_only).await;
        assert_eq!(
            (status, error["error"]["code"].clone()),
            (StatusCode::UNAUTHORIZED, json!("unauthorized")),
            "{method}: {error}"
        );
    }
    assert_eq!(stored(&admin, &id).await, before);
    assert_eq!(audit_rows(&admin.app).await, rows);
}

#[tokio::test]
async fn a_refused_photo_changes_nothing_and_audits_nothing() {
    let admin = admin().await;
    let id = product(&admin).await;
    admin.call("PUT", &path(&id), Some(photo())).await;
    let before = stored(&admin, &id).await;
    let rows = audit_rows(&admin.app).await;
    let mut wide = photo();
    wide["width"] = json!(641);
    let mut tall = photo();
    tall["height"] = json!(0);
    let mut png = photo();
    png["dataBase64"] = json!("iVBORw0KGgo=");
    let mut crooked = photo();
    crooked["dataBase64"] = json!("/9j/4AAQ*kZJRgABAQ==");
    let mut short = photo();
    short["dataBase64"] = json!(STANDARD.encode([0xFF, 0xD8, 0xFF]));
    let mut not_jpeg = photo();
    not_jpeg["dataBase64"] = json!(STANDARD.encode([0xFF, 0xD8, 0x00, 0x00]));
    let mut long_text = photo();
    // 400 001 characters of the base64 alphabet: refused before decoding.
    long_text["dataBase64"] = json!("A".repeat(400_001));
    for (what, body, field) in [
        ("641 wide", wide, "width"),
        ("0 tall", tall, "height"),
        ("a PNG", png, "dataBase64"),
        ("crooked base64", crooked, "dataBase64"),
        ("three bytes", short, "dataBase64"),
        ("FF D8 00 00", not_jpeg, "dataBase64"),
        ("400 001 characters", long_text, "dataBase64"),
        ("300 001 bytes", jpeg_of(300_001), "dataBase64"),
    ] {
        let (status, error) = admin.call("PUT", &path(&id), Some(body)).await;
        assert_eq!(
            refusal(status, &error),
            (
                StatusCode::BAD_REQUEST,
                json!("validation_failed"),
                json!(field)
            ),
            "{what}: {error}"
        );
    }
    let (status, error) = admin
        .call(
            "PUT",
            &path(&uuid::Uuid::new_v4().to_string()),
            Some(photo()),
        )
        .await;
    assert_eq!(
        (status, error["error"]["code"].clone()),
        (StatusCode::NOT_FOUND, json!("not_found"))
    );
    let (status, _) = admin
        .call("GET", &path(&uuid::Uuid::new_v4().to_string()), None)
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(stored(&admin, &id).await, before);
    assert_eq!(audit_rows(&admin.app).await, rows);
}

#[tokio::test]
async fn the_largest_photo_is_kept() {
    let admin = admin().await;
    let id = product(&admin).await;
    let (status, body) = admin.call("PUT", &path(&id), Some(jpeg_of(300_000))).await;
    assert_eq!(status, StatusCode::OK, "{}", body["error"]);
    let stored = stored(&admin, &id).await.unwrap();
    assert_eq!((stored.0, stored.1, stored.2), (640, 480, 300_000));
}

/// What no row may break, whatever writes it.
#[tokio::test]
async fn the_table_holds_bounded_rows_of_existing_products() {
    let admin = admin().await;
    let id = product(&admin).await;
    let pool = &admin.app.state.pool;
    let insert = |product: String, width: i64, data: Vec<u8>, checksum: String| {
        sqlx::query(
            "INSERT INTO product_photos (product_id, width, height, data, checksum, updated_at) \
             VALUES (?, ?, 1, ?, ?, '2026-10-13T09:00:00.000Z')",
        )
        .bind(product)
        .bind(width)
        .bind(data)
        .bind(checksum)
        .execute(pool)
    };
    let sum = CHECKSUM.to_owned();
    for (what, result) in [
        (
            "width 0",
            insert(id.clone(), 0, vec![0; 4], sum.clone()).await,
        ),
        (
            "width 641",
            insert(id.clone(), 641, vec![0; 4], sum.clone()).await,
        ),
        (
            "three bytes",
            insert(id.clone(), 1, vec![0; 3], sum.clone()).await,
        ),
        (
            "300001 bytes",
            insert(id.clone(), 1, vec![0; 300_001], sum.clone()).await,
        ),
        (
            "an upper-case checksum",
            insert(id.clone(), 1, vec![0; 4], sum.to_uppercase()).await,
        ),
        (
            "a short checksum",
            insert(id.clone(), 1, vec![0; 4], "ab".to_owned()).await,
        ),
    ] {
        let error = result.expect_err(what);
        assert!(error.to_string().contains("CHECK"), "{what}: {error}");
    }
    insert(id.clone(), 640, vec![0; 300_000], sum.clone())
        .await
        .expect("300000 bytes fit");
    let violations: Vec<(String, i64, String, i64)> = sqlx::query_as("PRAGMA foreign_key_check")
        .fetch_all(pool)
        .await
        .unwrap();
    assert!(violations.is_empty(), "{violations:?}");
    // The product columns' checks.
    let error = sqlx::query("UPDATE products SET egais_code = ' ' WHERE id = ?")
        .bind(&id)
        .execute(pool)
        .await
        .unwrap_err();
    assert!(error.to_string().contains("CHECK"), "{error}");
    let error = sqlx::query("UPDATE products SET egais_code = ? WHERE id = ?")
        .bind("1".repeat(65))
        .bind(&id)
        .execute(pool)
        .await
        .unwrap_err();
    assert!(error.to_string().contains("CHECK"), "{error}");
}

/// `0023` on a database that holds products: the rows stay, the new columns
/// are none, and the photo table is empty.
#[tokio::test]
async fn migration_0023_keeps_the_products_of_an_older_database() {
    use sqlx::migrate::Migrator;
    use sqlx::{Connection, SqliteConnection};

    let before = Migrator {
        migrations: markiro_host::db::MIGRATOR
            .iter()
            .filter(|migration| migration.version < 23)
            .cloned()
            .collect::<Vec<_>>()
            .into(),
        ..Migrator::DEFAULT
    };
    let mut old = SqliteConnection::connect("sqlite::memory:").await.unwrap();
    before.run(&mut old).await.unwrap();
    sqlx::query(
        "INSERT INTO products (id, gtin14, name, archived, rev) \
         VALUES ('p1', '04600682000013', 'Молоко', 0, 1)",
    )
    .execute(&mut old)
    .await
    .unwrap();
    markiro_host::db::MIGRATOR.run(&mut old).await.unwrap();
    let columns: Vec<String> = sqlx::query_scalar("SELECT name FROM pragma_table_info('products')")
        .fetch_all(&mut old)
        .await
        .unwrap();
    assert!(
        columns.contains(&"egais_code".to_owned())
            && columns.contains(&"default_counterparty_id".to_owned()),
        "{columns:?}"
    );
    let row: (String, Option<String>, Option<String>) =
        sqlx::query_as("SELECT name, egais_code, default_counterparty_id FROM products")
            .fetch_one(&mut old)
            .await
            .unwrap();
    assert_eq!(row, ("Молоко".to_owned(), None, None));
    let photos: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM product_photos")
        .fetch_one(&mut old)
        .await
        .unwrap();
    assert_eq!(photos, 0);
}

#[tokio::test]
async fn the_same_photo_again_writes_nothing() {
    let admin = admin().await;
    let id = product(&admin).await;
    let (_, first) = admin.call("PUT", &path(&id), Some(photo())).await;
    let rows = audit_rows(&admin.app).await;
    admin.app.clock.advance(time::Duration::minutes(5));
    let (status, again) = admin.call("PUT", &path(&id), Some(photo())).await;
    assert_eq!((status, again), (StatusCode::OK, first));
    assert_eq!(audit_rows(&admin.app).await, rows);
}

/// A user turned off after the extractor passed must not write: the routes
/// read the role again inside their own write transaction.
#[tokio::test]
async fn a_technologist_turned_off_after_the_extractor_passed_writes_nothing() {
    let admin = admin().await;
    let id = product(&admin).await;
    admin.call("PUT", &path(&id), Some(photo())).await;
    let before = stored(&admin, &id).await;
    let mut other = jpeg_of(20);
    other["width"] = json!(4);
    for (method, body) in [("PUT", Some(other)), ("DELETE", None)] {
        let login_name = format!("tech-{}", method.to_lowercase());
        let user = seed_office_user(
            &admin.app,
            &login_name,
            "technologist",
            "technologist password",
        )
        .await;
        let token = login(&admin.app, &admin.key, &login_name, "technologist password").await;
        let rows = audit_rows(&admin.app).await;
        turn_the_user_off_at_the_next_activity(&admin.app, &user).await;
        admin.app.clock.advance(time::Duration::minutes(2));
        let (status, error) = admin.call_as(&token, method, &path(&id), body).await;
        assert_eq!(
            (status, error["error"]["code"].clone()),
            (StatusCode::UNAUTHORIZED, json!("unauthorized")),
            "{method}: {error}"
        );
        assert_eq!(stored(&admin, &id).await, before, "{method}");
        assert_eq!(audit_rows(&admin.app).await, rows, "{method}");
    }
}

#[tokio::test]
async fn the_same_bytes_with_other_sides_are_a_change() {
    let admin = admin().await;
    let id = product(&admin).await;
    admin.call("PUT", &path(&id), Some(photo())).await;
    let mut wider = photo();
    wider["width"] = json!(4);
    let (status, body) = admin.call("PUT", &path(&id), Some(wider)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["photo"]["width"], 4);
    assert_eq!(audit_trail(&admin.app, "product.photo.set").await.len(), 2);
    assert_eq!(stored(&admin, &id).await.map(|row| row.0), Some(4));
}

#[tokio::test]
async fn deleting_the_photo_of_an_unknown_product_is_not_found() {
    let admin = admin().await;
    let rows = audit_rows(&admin.app).await;
    let (status, error) = admin
        .call("DELETE", &path(&uuid::Uuid::new_v4().to_string()), None)
        .await;
    assert_eq!(
        (status, error["error"]["code"].clone()),
        (StatusCode::NOT_FOUND, json!("not_found"))
    );
    assert_eq!(audit_rows(&admin.app).await, rows);
}

/// A real 2 x 1 RGBA PNG: an opaque red pixel and a fully transparent one.
const TRANSPARENT_PNG: &str =
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAD0lEQVR4nGP4z8AARAwMAAz8Af9c/RSVAAAAAElFTkSuQmCC";

/// A real 1 x 1 lossless WebP.
const LOSSLESS_WEBP: &str = "UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==";

#[tokio::test]
async fn a_transparent_png_is_kept_byte_for_byte_with_its_media_type() {
    let admin = admin().await;
    let id = product(&admin).await;
    let put = json!({ "width": 2, "height": 1, "dataBase64": TRANSPARENT_PNG });
    let (status, body) = admin.call("PUT", &path(&id), Some(put)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["photo"]["mediaType"], "image/png");
    assert_eq!(body["photo"]["dataBase64"], TRANSPARENT_PNG);
    // The stored bytes are the sent bytes (the alpha channel is the PNG's own).
    let (status, read) = admin.call("GET", &path(&id), None).await;
    assert_eq!((status, read), (StatusCode::OK, body));
    let kept: (String, Vec<u8>) =
        sqlx::query_as("SELECT media_type, data FROM product_photos WHERE product_id = ?")
            .bind(&id)
            .fetch_one(&admin.app.state.pool)
            .await
            .unwrap();
    assert_eq!(kept.0, "image/png");
    assert_eq!(kept.1, STANDARD.decode(TRANSPARENT_PNG).unwrap());
    // The audit row names the type, never the bytes.
    let set = audit_trail(&admin.app, "product.photo.set").await;
    assert_eq!(set[0].6["mediaType"], "image/png");
    // A station reads the same type.
    let (status, read) = admin
        .app
        .send(empty(with_device(
            request("GET", &format!("/v1/device/products/{id}/photo")),
            &admin.key,
        )))
        .await;
    assert_eq!(status, StatusCode::OK, "{read}");
    assert_eq!(read["photo"]["mediaType"], "image/png");
}

#[tokio::test]
async fn a_webp_is_kept_and_a_jpeg_still_reads_as_jpeg() {
    let admin = admin().await;
    let id = product(&admin).await;
    let put = json!({ "width": 1, "height": 1, "dataBase64": LOSSLESS_WEBP });
    let (status, body) = admin.call("PUT", &path(&id), Some(put)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["photo"]["mediaType"], "image/webp");
    let (status, body) = admin.call("PUT", &path(&id), Some(photo())).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["photo"]["mediaType"], "image/jpeg");
}

#[tokio::test]
async fn pictures_that_are_not_a_photo_are_refused_by_their_own_header() {
    let admin = admin().await;
    let id = product(&admin).await;
    let svg = STANDARD.encode("<svg xmlns=\"http://www.w3.org/2000/svg\"/>");
    // The header's sides differ from the sent ones: a bomb hides behind a claim.
    let png = json!({ "width": 1, "height": 1, "dataBase64": TRANSPARENT_PNG });
    let mut huge = STANDARD.decode(TRANSPARENT_PNG).unwrap();
    huge[16..20].copy_from_slice(&60_000u32.to_be_bytes());
    let huge = json!({ "width": 2, "height": 1, "dataBase64": STANDARD.encode(huge) });
    let gif = json!({ "width": 1, "height": 1, "dataBase64": STANDARD.encode(b"GIF89a\x01\x00\x01\x00") });
    for (put, field) in [
        (
            json!({ "width": 1, "height": 1, "dataBase64": svg }),
            "dataBase64",
        ),
        (png, "dataBase64"),
        (huge, "dataBase64"),
        (gif, "dataBase64"),
    ] {
        let (status, body) = admin.call("PUT", &path(&id), Some(put)).await;
        assert_eq!(
            refusal(status, &body),
            (
                StatusCode::BAD_REQUEST,
                json!("validation_failed"),
                json!(field)
            ),
            "{body}"
        );
    }
    assert_eq!(stored(&admin, &id).await, None);
}
