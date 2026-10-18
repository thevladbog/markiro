//! The owner's rule for products (beta feedback): a product that was ever in
//! production is never deleted (the office has no delete at all: it is
//! archived), and an ARCHIVED product is not checked for GTIN, so an old card
//! with a wrong GTIN can be archived and a correct new card made.
mod support;

use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{
    accepted, admin, box_id, fact, instant, ok_scan, open_floor, receipts, record_id, shift_setup,
    Admin,
};

/// A product written straight into its table: the host checks the shape of a
/// GTIN (14 digits), never its check digit, so this one is as the owner's
/// legacy cards were.
async fn insert_product(admin: &Admin, id: &str, gtin14: &str) {
    let mut tx = markiro_host::db::begin_write(&admin.app.state.pool)
        .await
        .unwrap();
    let rev = markiro_host::db::next_revision(&mut tx).await.unwrap();
    sqlx::query(
        "INSERT INTO products (id, gtin14, name, archived, rev) VALUES (?, ?, 'Старый', 0, ?)",
    )
    .bind(id)
    .bind(gtin14)
    .bind(rev)
    .execute(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();
}

async fn product(admin: &Admin, id: &str) -> Value {
    let (status, list) = admin.call("GET", "/v1/office/products", None).await;
    assert_eq!(status, StatusCode::OK, "{list}");
    list.as_array()
        .unwrap()
        .iter()
        .find(|each| each["id"] == id)
        .cloned()
        .unwrap()
}

fn put_body(record: &Value, archived: bool) -> Value {
    let mut body = record.clone();
    let fields = body.as_object_mut().unwrap();
    for computed in ["id", "status", "rev", "photoChecksum"] {
        fields.remove(computed);
    }
    fields.insert("expectedRev".to_owned(), record["rev"].clone());
    fields.insert("archived".to_owned(), json!(archived));
    body
}

/// The wrong-GTIN card is archived without a word about its GTIN, still
/// edited while archived, and a correct new card takes the place.
#[tokio::test]
async fn a_card_with_a_wrong_gtin_is_archived_and_a_correct_one_replaces_it() {
    let admin = admin().await;
    let id = "00000000-0000-4000-8000-0000000000a1";
    // Check digit wrong (…01 instead of …00 for this body).
    insert_product(&admin, id, "04600682000001").await;
    let record = product(&admin, id).await;
    let (status, archived) = admin
        .call(
            "PUT",
            &format!("/v1/office/products/{id}"),
            Some(put_body(&record, true)),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{archived}");
    assert_eq!(archived["archived"], json!(true));

    // Edited while archived: the name changes, the GTIN is not asked about.
    let mut rename = put_body(&archived, true);
    rename["name"] = json!("Старый (не использовать)");
    let (status, renamed) = admin
        .call("PUT", &format!("/v1/office/products/{id}"), Some(rename))
        .await;
    assert_eq!(status, StatusCode::OK, "{renamed}");

    // A new active card with the same GTIN is made: the archive does not reserve it.
    let (status, created) = admin
        .call(
            "POST",
            "/v1/office/products",
            Some(json!({ "gtin14": "04600682000001", "name": "Новый" })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    assert_eq!(created["archived"], json!(false));

    // The old one cannot come back while the new one holds the GTIN.
    let mut restore = put_body(&renamed, false);
    restore["name"] = json!("Старый");
    let (status, refused) = admin
        .call("PUT", &format!("/v1/office/products/{id}"), Some(restore))
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{refused}");
    assert_eq!(refused["error"]["details"]["constraint"], json!("gtin14"));
}

/// The office has no delete: a product is archived, never removed, so one
/// that was in production cannot vanish from its shifts and exports.
#[tokio::test]
async fn a_product_cannot_be_deleted() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let path = format!("/v1/office/products/{}", setup.product);
    let (status, body) = admin.call("DELETE", &path, None).await;
    assert!(
        status == StatusCode::METHOD_NOT_ALLOWED || status == StatusCode::NOT_FOUND,
        "{status} {body}"
    );
    let still: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM products WHERE id = ?")
        .bind(&setup.product)
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    assert_eq!(still, 1);
    // The database refuses it too: a shift keeps its product.
    let floor = open_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let direct = sqlx::query("DELETE FROM products WHERE id = ?")
        .bind(&setup.product)
        .execute(&admin.app.state.pool)
        .await;
    assert!(direct.is_err(), "a shift's product has to stay");
    drop(floor);
}

/// A station may still send the scans of a shift whose product was archived
/// meanwhile: traceability does not depend on the product's flag.
#[tokio::test]
async fn scans_of_a_product_archived_meanwhile_are_still_accepted() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let record = product(&admin, &setup.product).await;
    let (status, archived) = admin
        .call(
            "PUT",
            &format!("/v1/office/products/{}", setup.product),
            Some(put_body(&record, true)),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{archived}");
    let batch = vec![fact(
        &record_id(1),
        "scan",
        &floor.shift,
        ok_scan(1, &box_id(1), &instant(1, 0)),
    )];
    assert_eq!(
        receipts(&admin.app, &floor.key, &batch).await,
        vec![accepted(&record_id(1))]
    );
}
