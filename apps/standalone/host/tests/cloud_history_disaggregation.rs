#[path = "support/history.rs"]
mod history;
mod support;
use axum::http::StatusCode;
use serde_json::json;
use support::disaggregation::{add, apply, create, line, REASON};

#[tokio::test]
async fn imported_box_uses_normal_document_and_release_survives_import_retry() {
    let (a, r) = history::setup(true).await;
    let box_row = &r["part"]["payload"]["boxes"][0];
    let sscc = box_row["sscc"].as_str().unwrap();
    let doc = create(&a, json!({"reasonId":REASON})).await;
    let id = doc["document"]["id"].as_str().unwrap();
    let (status, detail) = add(&a, id, json!([line(sscc, Some(sscc))])).await;
    assert_eq!(status, StatusCode::OK, "{detail}");
    assert_eq!(detail["lines"][0]["status"], "ok", "{detail}");
    assert_eq!(detail["lines"][0]["boxId"], box_row["id"]);
    assert_eq!(detail["lines"][0]["cloudHistory"], true);
    let expected: serde_json::Value = serde_json::from_str(include_str!(
        "../../proto/fixtures/cloud-history-disaggregation-line.json"
    ))
    .unwrap();
    let mut actual = detail["lines"][0].clone();
    // Only the newly created local line id and validation instant are nondeterministic.
    actual["id"] = expected["id"].clone();
    actual["validatedAt"] = expected["validatedAt"].clone();
    assert_eq!(actual, expected);
    let (status, done) = apply(&a, &detail).await;
    assert_eq!(status, StatusCode::OK, "{done}");
    assert_eq!(
        support::app::audit_trail(&a.app, "disaggregation.apply").await,
        vec![(
            "office_user".to_owned(),
            Some(a.id.clone()),
            "disaggregation.apply".to_owned(),
            Some("disaggregation_document".to_owned()),
            Some(id.to_owned()),
            "ok".to_owned(),
            json!({"docNo":done["document"]["docNo"],"boxes":1,"pallets":0,"codes":1})
        )]
    );
    let (status, act) = a
        .call(
            "GET",
            &format!("/v1/office/disaggregation/{id}/report-data?variant=full"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{act}");
    assert_eq!(act["lines"][0]["items"].as_array().unwrap().len(), 1);
    let count = support::app::audit_trail(&a.app, "disaggregation.apply")
        .await
        .len();
    assert_eq!(apply(&a, &done).await.0, StatusCode::CONFLICT);
    assert_eq!(
        support::app::audit_trail(&a.app, "disaggregation.apply")
            .await
            .len(),
        count
    );
    let hash = r["part"]["payload"]["items"][0]["hash"].as_str().unwrap();
    let mut conn = a.app.state.pool.acquire().await.unwrap();
    assert!(
        markiro_host::cloud_history::completed_owner(&mut conn, hash)
            .await
            .unwrap()
            .is_none()
    );
    drop(conn);
    assert_eq!(
        a.call("POST", "/v1/office/import/history", Some(r.clone()))
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        a.call(
            "POST",
            "/v1/office/import/history/complete",
            Some(json!({"batchId":r["manifest"]["checksum"]}))
        )
        .await
        .0,
        StatusCode::OK
    );
    let mut conn = a.app.state.pool.acquire().await.unwrap();
    assert!(
        markiro_host::cloud_history::completed_owner(&mut conn, hash)
            .await
            .unwrap()
            .is_none()
    );
    assert!(sqlx::query("PRAGMA foreign_key_check")
        .fetch_all(&mut *conn)
        .await
        .unwrap()
        .is_empty());
    drop(conn);
    // Once released, a new real scan can own it; a batch retry cannot steal it back.
    sqlx::query("UPDATE products SET archived=1")
        .execute(&a.app.state.pool)
        .await
        .unwrap();
    let setup = support::app::shift_setup(&a).await;
    let floor = support::app::open_floor(&a, &setup, &a.key, &setup.line).await;
    let source = &r["part"]["payload"]["codes"][0];
    let mut scan =
        support::app::ok_scan(1, &support::app::box_id(44), &support::app::instant(2, 0));
    scan["code"] = json!({"codeHash":source["hash"],"canonical":source["canonical"],"gtin14":source["gtin14"],"serial":source["serial"]});
    let receipts = support::app::receipts(
        &a.app,
        &floor.key,
        &[support::app::fact(
            &support::app::record_id(44),
            "scan",
            &floor.shift,
            scan,
        )],
    )
    .await;
    assert_eq!(receipts[0]["outcome"], "accepted", "{receipts:?}");
    assert_eq!(
        a.call("POST", "/v1/office/import/history", Some(r.clone()))
            .await
            .0,
        StatusCode::OK
    );
    let owner: String = sqlx::query_scalar("SELECT shift_id FROM code_owners WHERE code_hash=?")
        .bind(hash)
        .fetch_one(&a.app.state.pool)
        .await
        .unwrap();
    assert_eq!(owner, floor.shift);
}

#[tokio::test]
async fn migration_preserves_legacy_line_rowids_and_constraints() {
    use sqlx::{migrate::Migrator, Connection};
    let mut conn = sqlx::SqliteConnection::connect("sqlite::memory:")
        .await
        .unwrap();
    let before = Migrator {
        migrations: markiro_host::db::MIGRATOR
            .iter()
            .filter(|m| m.version < 48)
            .cloned()
            .collect::<Vec<_>>()
            .into(),
        ..Migrator::DEFAULT
    };
    before.run(&mut conn).await.unwrap();
    sqlx::query("INSERT INTO office_users(id,login,name,role,password_phc,created_at,rev) VALUES('u','user','User','admin','test','at',1)").execute(&mut conn).await.unwrap();
    sqlx::query("INSERT INTO disaggregation_documents(id,seq,doc_no,status,source,created_by,created_at,updated_at,rev) VALUES('d',1,'DSG-26-0001','draft','manual','u','at','at',1)").execute(&mut conn).await.unwrap();
    sqlx::query("INSERT INTO disaggregation_document_lines(rowid,id,document_id,position,sscc_input,status,validated_at,created_at) VALUES(7,'l1','d',1,'unknown','not_found','at','at'),(19,'l2','d',2,'unknown2','not_found','at','at')").execute(&mut conn).await.unwrap();
    markiro_host::db::MIGRATOR.run(&mut conn).await.unwrap();
    let rows: Vec<(i64, String)> =
        sqlx::query_as("SELECT rowid,id FROM disaggregation_document_lines ORDER BY rowid")
            .fetch_all(&mut conn)
            .await
            .unwrap();
    assert_eq!(rows, vec![(7, "l1".to_owned()), (19, "l2".to_owned())]);
    assert!(sqlx::query("PRAGMA foreign_key_check")
        .fetch_all(&mut conn)
        .await
        .unwrap()
        .is_empty());
    assert!(
        sqlx::query("UPDATE disaggregation_document_lines SET status='ok' WHERE id='l1'")
            .execute(&mut conn)
            .await
            .is_err()
    );
    assert!(sqlx::query("UPDATE disaggregation_document_lines SET box_id='absent',status='ok',sscc='046006820000000013' WHERE id='l1'").execute(&mut conn).await.is_err());
}

#[tokio::test]
async fn changed_owner_and_technologist_cannot_release_imported_box() {
    let (a, r) = history::setup(true).await;
    let sscc = r["part"]["payload"]["boxes"][0]["sscc"].as_str().unwrap();
    let doc = create(&a, json!({"reasonId":REASON})).await;
    let id = doc["document"]["id"].as_str().unwrap();
    let token = a.technologist().await;
    let (status, body) = a
        .call_as(
            &token,
            "POST",
            &format!("/v1/office/disaggregation/{id}/lines"),
            Some(json!({"lines":[line(sscc,Some(sscc))],"import":false})),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    let (_, detail) = add(&a, id, json!([line(sscc, Some(sscc))])).await;
    let (status, body) = a
        .call_as(
            &token,
            "POST",
            &format!("/v1/office/disaggregation/{id}/apply"),
            Some(json!({"expectedRev":detail["document"]["rev"]})),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    let hash = r["part"]["payload"]["items"][0]["hash"].as_str().unwrap();
    sqlx::query("UPDATE cloud_history_owners SET box_id=NULL WHERE hash=?")
        .bind(hash)
        .execute(&a.app.state.pool)
        .await
        .unwrap();
    let (status, error) = apply(&a, &detail).await;
    assert_eq!(status, StatusCode::CONFLICT, "{error}");
    assert_eq!(
        error["error"]["details"]["constraint"],
        "history_owner_mismatch"
    );
    let released: Option<String> =
        sqlx::query_scalar("SELECT released_at FROM cloud_history_owners WHERE hash=?")
            .bind(hash)
            .fetch_one(&a.app.state.pool)
            .await
            .unwrap();
    assert!(released.is_none());
    assert!(support::app::audit_trail(&a.app, "disaggregation.apply")
        .await
        .is_empty());
}

#[tokio::test]
async fn warehouse_pallet_disassembly_keeps_box_ownership() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../../proto/fixtures/cloud-history-read.json")).unwrap();
    let (a, _) = history::setup_request(fixture["request"].clone(), true).await;
    let pallet = &fixture["palletSources"][1]["pallet"];
    let sscc = pallet["sscc"].as_str().unwrap().to_owned();
    let done = support::disaggregation::applied(&a, &[sscc]).await;
    assert_eq!(done["lines"][0]["palletId"], pallet["id"]);
    assert!(done["lines"][0]["shiftId"].is_null());
    assert_eq!(done["lines"][0]["productName"], "Frozen warehouse product");
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM cloud_history_owners WHERE released_at IS NOT NULL"
        )
        .fetch_one(&a.app.state.pool)
        .await
        .unwrap(),
        0
    );
    let id = done["document"]["id"].as_str().unwrap();
    let (status, act) = a
        .call(
            "GET",
            &format!("/v1/office/disaggregation/{id}/report-data?variant=full"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{act}");
    assert_eq!(act["lines"][0]["boxes"].as_array().unwrap().len(), 2);
}
