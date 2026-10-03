mod support;

use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{admin, empty, request, with_device, TestApp};

/// `(code, alias, name)` of every row the cloud's migration inserts: the one
/// source of the lookup, read here so the host's copy cannot drift from it.
fn cloud_groups() -> Vec<(i64, String, String)> {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../packages/db/migrations/0099_chz_product_groups.sql"
    );
    let sql = std::fs::read_to_string(path).unwrap_or_else(|error| panic!("read {path}: {error}"));
    sql.lines()
        .map(str::trim)
        .filter(|line| line.starts_with('('))
        .map(|line| {
            let row = line
                .trim_end_matches(',')
                .strip_prefix('(')
                .and_then(|row| row.strip_suffix(')'))
                .unwrap_or_else(|| panic!("not a row: {line}"));
            let (code, rest) = row.split_once(", '").unwrap();
            let (alias, name) = rest.split_once("', '").unwrap();
            let name = name.strip_suffix('\'').unwrap();
            (
                code.parse().unwrap(),
                alias.to_owned(),
                name.replace("''", "'"),
            )
        })
        .collect()
}

#[tokio::test]
async fn the_host_holds_the_clouds_product_groups_row_for_row() {
    let app = TestApp::new().await;
    let host: Vec<(i64, String, String)> =
        sqlx::query_as("SELECT code, alias, name FROM chz_product_groups ORDER BY code")
            .fetch_all(&app.state.pool)
            .await
            .unwrap();
    let cloud = cloud_groups();
    assert_eq!(cloud.len(), 51, "the cloud migration lists 51 groups");
    assert_eq!(host, cloud);
}

#[tokio::test]
async fn every_office_role_lists_the_product_groups_by_code() {
    let admin = admin().await;
    let tech = admin.technologist().await;
    let expected: Vec<Value> = cloud_groups()
        .into_iter()
        .map(|(code, alias, name)| json!({ "code": code, "alias": alias, "name": name }))
        .collect();
    for token in [admin.token.clone(), tech] {
        let (status, body) = admin
            .call_as(&token, "GET", "/v1/office/product-groups", None)
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body, Value::Array(expected.clone()));
    }
}

#[tokio::test]
async fn product_groups_need_an_office_session() {
    let admin = admin().await;
    let (status, body) = admin
        .app
        .send(empty(with_device(
            request("GET", "/v1/office/product-groups"),
            &admin.key,
        )))
        .await;
    assert_eq!(
        (status, body["error"]["details"]["credential"].clone()),
        (StatusCode::UNAUTHORIZED, json!("session"))
    );
}
