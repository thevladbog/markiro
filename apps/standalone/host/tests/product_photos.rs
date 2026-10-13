//! A product's photo (plan ТОВ, task 2): `GET`, `PUT` and `DELETE
//! /v1/office/products/{id}/photo`, and migration `0023` that holds it with
//! the product's EGAIS code and default counterparty.

mod support;

use axum::http::StatusCode;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use support::app::{
    admin, audit_rows, audit_trail, empty, host_revision, request, with_device, Admin,
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
    // A photo is not in the station feed: no revision is taken, and the
    // product's own revision stays.
    assert_eq!(host_revision(&admin.app).await, revision);
    assert_eq!(list[0]["rev"], json!(revision));
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
            json!({ "width": 2, "height": 1, "bytes": 13 })
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
    for (what, body, field) in [
        ("641 wide", wide, "width"),
        ("0 tall", tall, "height"),
        ("a PNG", png, "dataBase64"),
        ("crooked base64", crooked, "dataBase64"),
        ("three bytes", short, "dataBase64"),
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
