mod support;

use axum::http::StatusCode;
use serde_json::json;
use support::app::{admin, empty, request, with_device};

#[tokio::test]
async fn office_search_is_read_only_authenticated_and_validated() {
    let a = admin().await;
    let (status, _) = a
        .app
        .send(empty(with_device(
            request("POST", "/v1/office/search"),
            &a.key,
        )))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let before: i64 = sqlx::query_scalar("SELECT count(*) FROM audit_log")
        .fetch_one(&a.app.state.pool)
        .await
        .unwrap();
    let (status, body) = a
        .call(
            "POST",
            "/v1/office/search",
            Some(json!({"kind":"text","text":"нет такого результата"})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body, json!({"items":[],"truncated":false}));
    for query in [
        json!({"kind":"code","codeHash":"raw-code"}),
        json!({"kind":"text","text":"x"}),
        json!({"kind":"gtin","gtin14":"123"}),
        json!({"kind":"shift","id":"../../x"}),
        json!({"kind":"text","text":"valid","extra":true}),
    ] {
        let (status, body) = a.call("POST", "/v1/office/search", Some(query)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    }
    let after: i64 = sqlx::query_scalar("SELECT count(*) FROM audit_log")
        .fetch_one(&a.app.state.pool)
        .await
        .unwrap();
    assert_eq!(before, after);
}

#[tokio::test]
async fn finds_products_shifts_and_bounds_unicode_text_results() {
    let a = admin().await;
    for n in 0..55 {
        sqlx::query("INSERT INTO products(id,gtin14,name,archived,rev) VALUES(?,?,?,1,1)")
            .bind(format!("search-product-{n:02}"))
            .bind("04600682000013")
            .bind(format!("Молоко {n:02}"))
            .execute(&a.app.state.pool)
            .await
            .unwrap();
    }
    let (status, body) = a
        .call(
            "POST",
            "/v1/office/search",
            Some(json!({"kind":"text","text":"МОЛОКО"})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["items"].as_array().unwrap().len(), 50);
    assert_eq!(body["truncated"], true);
    assert_eq!(body["items"][0]["target"]["kind"], "product");
    let (status, body) = a
        .call(
            "POST",
            "/v1/office/search",
            Some(json!({"kind":"gtin","gtin14":"04600682000013"})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(body["items"]
        .as_array()
        .unwrap()
        .iter()
        .any(|i| i["target"]["kind"] == "product"));
    assert_eq!(body["truncated"], true);
}

#[tokio::test]
async fn resolves_task_shift_identifier_and_saved_document_owner() {
    let a = admin().await;
    let setup = support::app::shift_setup(&a).await;
    let floor = support::app::open_floor(&a, &setup, &a.key, &setup.line).await;
    let shift = &floor.shift;
    let (status, body) = a
        .call(
            "POST",
            "/v1/office/search",
            Some(json!({"kind":"shift","id":shift})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body["items"][0]["target"],
        json!({"kind":"shift","id":shift,"source":"local"})
    );
}

#[tokio::test]
async fn marking_code_search_returns_hash_target_without_code_bytes() {
    let a = admin().await;
    let setup = support::app::shift_setup(&a).await;
    let floor = support::app::open_floor(&a, &setup, &a.key, &setup.line).await;
    let record = support::app::fact(
        &support::app::record_id(1),
        "scan",
        &floor.shift,
        support::app::ok_scan(1, &support::app::box_id(1), &support::app::instant(1, 0)),
    );
    let receipt = support::app::receipts(&a.app, &floor.key, &[record]).await;
    assert_eq!(receipt[0]["outcome"], "accepted");
    let hash = support::app::code_hash(1);
    let (status, body) = a
        .call(
            "POST",
            "/v1/office/search",
            Some(json!({"kind":"code","codeHash":hash})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body["items"][0]["target"],
        json!({"kind":"code","codeHash":hash,"source":"local"})
    );
    assert!(!body
        .to_string()
        .contains(support::app::code(1)["canonical"].as_str().unwrap()));
}

#[tokio::test]
async fn saved_files_resolve_only_real_owners_and_literal_text_wildcards() {
    let a = admin().await;
    let setup = support::app::shift_setup(&a).await;
    let floor = support::app::open_floor(&a, &setup, &a.key, &setup.line).await;
    for (n, owner, state, name) in [
        (1, floor.shift.as_str(), "ready", "Отчёт_100%.xml"),
        (2, "missing", "ready", "Отчёт_100%.xml"),
        (3, floor.shift.as_str(), "uploading", "Отчёт_100%.xml"),
    ] {
        sqlx::query("INSERT INTO export_files(id,batch_id,part_no,kind,target_type,target_id,shift_id,format_id,format_version,file_name,media_type,size_bytes,chunk_count,sha256,generator,state,stored_bytes,created_at,actor_id) VALUES(?,?,1,'shift_export','shift',?,?,'test',1,?,'text/xml',1,1,?,'test',?,1,'2026-11-01T00:00:00Z',?)")
            .bind(format!("00000000-0000-4000-8000-{n:012}"))
            .bind(format!("10000000-0000-4000-8000-{n:012}"))
            .bind(owner).bind(owner).bind(name).bind("a".repeat(64)).bind(state).bind(&a.id)
            .execute(&a.app.state.pool).await.unwrap();
    }
    let (status, body) = a
        .call(
            "POST",
            "/v1/office/search",
            Some(json!({"kind":"text","text":"ОТЧЁТ_100%"})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["items"].as_array().unwrap().len(), 1, "{body}");
    assert_eq!(
        body["items"][0]["target"],
        json!({"kind":"document","id":"00000000-0000-4000-8000-000000000001","targetType":"shift","targetId":floor.shift,"source":"local"})
    );
    let (_, body) = a
        .call(
            "POST",
            "/v1/office/search",
            Some(json!({"kind":"text","text":"%_"})),
        )
        .await;
    assert_eq!(body["items"], json!([]));
    // Saved files predate an explicit source column. Do not invent provenance
    // when both identity spaces happen to contain their owner identifier.
    sqlx::query("INSERT INTO cloud_history_batches(id,singleton,manifest,status,created_at) VALUES('batch',1,'{}','complete','2026-11-01T00:00:00Z')").execute(&a.app.state.pool).await.unwrap();
    sqlx::query("INSERT INTO cloud_history_shifts(id,batch_id,number,mode,product_id,gtin14,in_window,source_json) VALUES(?,'batch','OCT26-001','aggregation','source-product','04600682000013',1,'{}')").bind(&floor.shift).execute(&a.app.state.pool).await.unwrap();
    let (_, body) = a
        .call(
            "POST",
            "/v1/office/search",
            Some(json!({"kind":"text","text":"ОТЧЁТ_100%"})),
        )
        .await;
    assert_eq!(
        body["items"],
        json!([]),
        "ambiguous saved-file provenance must not select an arbitrary owner"
    );
}

#[tokio::test]
async fn imported_owner_only_codes_keep_cloud_provenance_and_pending_is_hidden() {
    let a = admin().await;
    let hash = "b".repeat(64);
    sqlx::query("INSERT INTO cloud_history_batches(id,singleton,manifest,status,created_at) VALUES('batch',1,'{}','pending','2026-11-01T00:00:00Z')").execute(&a.app.state.pool).await.unwrap();
    sqlx::query("INSERT INTO cloud_history_owners(hash,batch_id,shift_id,number,scanned_at) VALUES(?,'batch','missing-history-shift','OCT26-001','2026-11-01T00:00:00Z')").bind(&hash).execute(&a.app.state.pool).await.unwrap();
    let (_, body) = a
        .call(
            "POST",
            "/v1/office/search",
            Some(json!({"kind":"code","codeHash":hash})),
        )
        .await;
    assert_eq!(body["items"], json!([]));
    sqlx::query("UPDATE cloud_history_batches SET status='complete'")
        .execute(&a.app.state.pool)
        .await
        .unwrap();
    let (status, body) = a
        .call(
            "POST",
            "/v1/office/search",
            Some(json!({"kind":"code","codeHash":hash})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["items"].as_array().unwrap().len(), 1);
    assert_eq!(
        body["items"][0]["target"],
        json!({"kind":"code","codeHash":hash,"source":"cloud"})
    );
}

#[tokio::test]
async fn exact_code_gtin_and_pack_reads_search_indexes() {
    use markiro_host::routes::office_search::{
        cloud_codes_sql, pack_match_sql, GTIN_PRODUCTS_SQL, LOCAL_CODE_SQL, LOCAL_GTIN_CODES_SQL,
    };
    use sqlx::Row;
    let a = admin().await;
    let mut queries = vec![
        LOCAL_CODE_SQL.to_owned(),
        LOCAL_GTIN_CODES_SQL.to_owned(),
        GTIN_PRODUCTS_SQL.to_owned(),
        cloud_codes_sql(false),
        cloud_codes_sql(true),
    ];
    for table in [
        "boxes",
        "pallets",
        "warehouse_pallets",
        "cloud_history_boxes",
        "cloud_history_pallets",
    ] {
        queries.push(pack_match_sql(table, table.starts_with("cloud_")));
    }
    for query in queries {
        let plan = sqlx::query(&format!("EXPLAIN QUERY PLAN {query} LIMIT ?2"))
            .bind("04600682000013")
            .bind(51i64)
            .fetch_all(&a.app.state.pool)
            .await
            .unwrap();
        let details = plan
            .iter()
            .map(|r| r.get::<String, _>("detail"))
            .collect::<Vec<_>>();
        assert!(
            details.iter().any(|d| d.contains("SEARCH")),
            "{query}: {details:?}"
        );
        assert!(
            !details.iter().any(|d| d.starts_with("SCAN scans")
                || d.starts_with("SCAN t")
                || d.starts_with("SCAN products")),
            "{query}: {details:?}"
        );
    }
}

#[tokio::test]
async fn post_search_remains_a_read_after_dataset_replacement() {
    let a = admin().await;
    sqlx::query("UPDATE site SET dataset_epoch='new-dataset',facts_held_since='2026-11-01T00:00:00Z' WHERE id=1").execute(&a.app.state.pool).await.unwrap();
    let (status, body) = a.call("GET", "/v1/office/products", None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let before: (i64, i64) = sqlx::query_as(
        "SELECT (SELECT rev FROM host_revision WHERE id=1),(SELECT count(*) FROM audit_log)",
    )
    .fetch_one(&a.app.state.pool)
    .await
    .unwrap();
    let (status, body) = a
        .call(
            "POST",
            "/v1/office/search",
            Some(json!({"kind":"text","text":"молоко"})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let req = support::app::with_session(request("POST", "/v1/office/search"), &a.key, &a.token)
        .header(markiro_proto::DATASET_EPOCH_HEADER, "old-dataset");
    let (status, body) = a
        .app
        .send(support::app::json(
            req,
            json!({"kind":"text","text":"молоко"}),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let after: (i64, i64) = sqlx::query_as(
        "SELECT (SELECT rev FROM host_revision WHERE id=1),(SELECT count(*) FROM audit_log)",
    )
    .fetch_one(&a.app.state.pool)
    .await
    .unwrap();
    assert_eq!(before, after);
}

#[tokio::test]
async fn technologist_can_search_but_handheld_device_cannot_use_office_credentials() {
    let a = admin().await;
    let tech = a.technologist().await;
    let (status, body) = a
        .call_as(
            &tech,
            "POST",
            "/v1/office/search",
            Some(json!({"kind":"text","text":"молоко"})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let handheld = support::app::pair_handheld(&a).await;
    let req = support::app::with_session(request("POST", "/v1/office/search"), &handheld, &a.token);
    let (status, body) = a
        .app
        .send(support::app::json(
            req,
            json!({"kind":"text","text":"молоко"}),
        ))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
}
