#[path = "support/history.rs"]
mod history;
mod support;
use axum::http::StatusCode;
use serde_json::{json, Value};

#[tokio::test]
async fn missing_close_uses_snapshot_operation_time_without_fabricating_close_metadata() {
    let fixture: Value =
        serde_json::from_str(include_str!("../../proto/fixtures/cloud-history-read.json")).unwrap();
    let mut r = fixture["request"].clone();
    r["part"]["payload"]["shifts"][0]["closedAt"] = Value::Null;
    history::seal(&mut r);
    let (a, _) = history::setup_request(r, true).await;
    let expected = &fixture["nullCloseExportSource"];
    let id = expected["shift"]["id"].as_str().unwrap();
    let (status, source) = a
        .call(
            "GET",
            &format!("/v1/office/cloud-shifts/{id}/export-source"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{source}");
    assert_eq!(source, *expected);
    assert!(source["shift"]["closedAt"].is_null());
    assert!(source["shift"]["stationClosedAt"].is_null());
    assert_eq!(
        source["shift"]["effectiveOperationDateTime"],
        fixture["request"]["manifest"]["exportedAt"]
    );
    let (_, card) = a
        .call("GET", &format!("/v1/office/cloud-shifts/{id}"), None)
        .await;
    assert!(card["shift"]["closedAt"].is_null());
}

#[tokio::test]
async fn cloud_list_paginates_stably_filters_and_keeps_closure_rows_out_of_list() {
    let mut r = history::request();
    let template = r["part"]["payload"]["shifts"][1].clone();
    for n in 20..=70 {
        let mut shift = template.clone();
        shift["id"] = json!(format!("10000000-0000-4000-8000-{n:012}"));
        shift["number"] = json!(format!("OCT26-{n:03}"));
        shift["numberSeq"] = json!(n);
        shift["inWindow"] = json!(n != 70);
        r["part"]["payload"]["shifts"]
            .as_array_mut()
            .unwrap()
            .push(shift);
    }
    history::seal(&mut r);
    let (a, _) = history::setup_request(r, true).await;
    let (status, first) = a.call("GET", "/v1/office/cloud-shifts", None).await;
    assert_eq!(status, StatusCode::OK, "{first}");
    assert_eq!(first["total"], 52);
    assert_eq!(first["pageCount"], 2);
    assert_eq!(first["items"].as_array().unwrap().len(), 50);
    let (_, second) = a.call("GET", "/v1/office/cloud-shifts?page=2", None).await;
    assert_eq!(second["items"].as_array().unwrap().len(), 2);
    assert_eq!(second["items"][1]["shift"]["number"], "OCT26-007/S");
    assert_eq!(
        a.call("GET", "/v1/office/cloud-shifts", None).await.1,
        first
    );
    let (_, filtered) = a
        .call(
            "GET",
            "/v1/office/cloud-shifts?mode=aggregation&from=2026-10-16&to=2026-10-16",
            None,
        )
        .await;
    assert_eq!(filtered["total"], 1);
    assert_eq!(
        a.call("GET", "/v1/office/cloud-shifts?page=0", None)
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        a.call(
            "GET",
            "/v1/office/cloud-shifts/10000000-0000-4000-8000-000000000070",
            None
        )
        .await
        .0,
        StatusCode::OK
    );
}

#[tokio::test]
async fn absent_dates_and_unavailable_original_composition_are_precise_refusals() {
    let mut r = history::request();
    r["part"]["payload"]["shifts"][0]["productionDate"] = Value::Null;
    r["part"]["payload"]["boxes"][0]["disassembledAt"] = json!("2026-10-16T12:00:00.000Z");
    // The cloud retains this original association after box disassembly.
    assert!(!r["part"]["payload"]["boxes"][0]["palletId"].is_null());
    r["part"]["payload"]["items"] = json!([]);
    r["part"]["payload"]["owners"][0]["boxId"] = Value::Null;
    history::seal(&mut r);
    let (a, r) = history::setup_request(r, true).await;
    let id = r["part"]["payload"]["shifts"][0]["id"].as_str().unwrap();
    let (status, error) = a
        .call(
            "GET",
            &format!("/v1/office/cloud-shifts/{id}/export-source"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{error}");
    assert_eq!(
        error["error"]["details"]["constraint"],
        "SHIFT_DATE_MISSING"
    );
    let id = r["part"]["payload"]["boxes"][0]["id"].as_str().unwrap();
    let (status, error) = a
        .call(
            "GET",
            &format!("/v1/office/cloud-boxes/{id}/report-data"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{error}");
    assert_eq!(
        error["error"]["details"]["constraint"],
        "history_composition_unavailable"
    );
}

#[tokio::test]
async fn warehouse_export_has_own_history_without_a_shift_identity() {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let fixture: Value =
        serde_json::from_str(include_str!("../../proto/fixtures/cloud-history-read.json")).unwrap();
    let (a, _) = history::setup_request(fixture["request"].clone(), true).await;
    let id = fixture["palletSources"][1]["pallet"]["id"]
        .as_str()
        .unwrap();
    let (token, user_id) = a.technologist_session().await;
    let file = "70000000-0000-4000-8000-000000000011";
    let batch = "70000000-0000-4000-8000-000000000012";
    let bytes = b"pallet XML fixture";
    let (status,body)=a.call_as(&token,"POST","/v1/office/export-files",Some(json!({"id":file,"batchId":batch,"partNo":1,"kind":"pallet_export","targetType":"pallet","targetId":id,"formatId":"pallet_xml_gismt_aggregation","formatVersion":1,"fileName":"pallet.xml","sizeBytes":bytes.len(),"sha256":markiro_host::cloud_history::validation::digest(bytes),"generator":"Task3 test","contentBase64":STANDARD.encode(bytes)}))).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let record = json!({"formatId":"pallet_xml_gismt_aggregation","formatVersion":1,"maxLines":null,"palletId":id,"documentId":batch,"partCount":1,"codeCount":0,"boxCount":2,"palletCount":1,"openPalletSuppressedBoxCount":0});
    let (status, body) = a
        .call_as(
            &token,
            "POST",
            &format!("/v1/office/cloud-pallets/{id}/exports"),
            Some(record.clone()),
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{body}");
    let (status, body) = a
        .call(
            "GET",
            &format!("/v1/office/cloud-pallets/{id}/exports"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["items"][0]["files"][0]["shiftId"], Value::Null);
    assert_eq!(body["items"][0]["files"][0]["targetId"], id);
    assert_eq!(
        support::app::audit_trail(&a.app, "shift.export").await,
        vec![(
            "office_user".to_owned(),
            Some(user_id),
            "shift.export".to_owned(),
            Some("pallet".to_owned()),
            Some(id.to_owned()),
            "ok".to_owned(),
            record
        )]
    );
}

#[tokio::test]
async fn real_route_matches_shared_browser_generation_fixture() {
    let fixture: Value =
        serde_json::from_str(include_str!("../../proto/fixtures/cloud-history-read.json")).unwrap();
    let (a, _) = history::setup_request(fixture["request"].clone(), true).await;
    // Frozen metadata survives edits to the local catalog and organization.
    sqlx::query("UPDATE products SET name='Edited local product'")
        .execute(&a.app.state.pool)
        .await
        .unwrap();
    sqlx::query(
        "UPDATE org_profile SET name='Edited local organization',time_zone='America/New_York'",
    )
    .execute(&a.app.state.pool)
    .await
    .unwrap();
    for expected in fixture["exportSources"].as_array().unwrap() {
        let id = expected["shift"]["id"].as_str().unwrap();
        let (status, rows) = a
            .call(
                "GET",
                &format!("/v1/office/cloud-shifts/{id}/export-source"),
                None,
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{rows}");
        assert_eq!(rows, *expected);
    }
    for expected in fixture["palletSources"].as_array().unwrap() {
        let id = expected["pallet"]["id"].as_str().unwrap();
        let (status, rows) = a
            .call("GET", &format!("/v1/office/cloud-pallets/{id}"), None)
            .await;
        assert_eq!(status, StatusCode::OK, "{rows}");
        assert_eq!(rows, *expected);
    }
    let token = a.technologist().await;
    assert_eq!(
        a.call_as(&token, "GET", "/v1/office/cloud-shifts", None)
            .await
            .0,
        StatusCode::OK
    );
}

#[tokio::test]
async fn saved_file_reads_back_unchanged_after_release_and_restore() {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use sqlx::Connection;
    let fixture: Value =
        serde_json::from_str(include_str!("../../proto/fixtures/cloud-history-read.json")).unwrap();
    let (mut a, r) = history::setup_request(fixture["request"].clone(), true).await;
    let shift = r["part"]["payload"]["shifts"][0]["id"].as_str().unwrap();
    let file = "70000000-0000-4000-8000-000000000001";
    let batch = "70000000-0000-4000-8000-000000000002";
    let bytes = include_bytes!("../../proto/fixtures/cloud-history-export.xml");
    let (status,body)=a.call("POST","/v1/office/export-files",Some(json!({"id":file,"batchId":batch,"partNo":1,"kind":"shift_export","targetType":"shift","targetId":shift,"formatId":"shift_xml_gismt_aggregation_pallets","formatVersion":1,"fileName":"history.xml","sizeBytes":bytes.len(),"sha256":markiro_host::cloud_history::validation::digest(bytes),"generator":"Task3 test","contentBase64":STANDARD.encode(bytes)}))).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status,body)=a.call("POST",&format!("/v1/office/shifts/{shift}/exports"),Some(json!({"formatId":"shift_xml_gismt_aggregation_pallets","formatVersion":1,"maxLines":null,"palletId":null,"documentId":batch,"partCount":1,"codeCount":3,"boxCount":3,"palletCount":2,"openPalletSuppressedBoxCount":0}))).await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{body}");
    let history = a
        .call("GET", &format!("/v1/office/shifts/{shift}/exports"), None)
        .await
        .1;
    assert_eq!(history["items"][0]["files"][0]["id"], file);
    let ssccs: Vec<String> = r["part"]["payload"]["boxes"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|b| b["shiftId"] == shift)
        .map(|b| b["sscc"].as_str().unwrap().to_owned())
        .collect();
    support::disaggregation::applied(&a, &ssccs).await;
    let (status, opened) = a
        .call(
            "POST",
            &format!("/v1/office/export-files/{file}/download"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{opened}");
    let (status, chunk) = a
        .call(
            "GET",
            &format!("/v1/office/export-files/{file}/chunks/0"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{chunk}");
    assert_eq!(
        STANDARD
            .decode(chunk["contentBase64"].as_str().unwrap())
            .unwrap(),
        bytes
    );
    let rows = a
        .call(
            "GET",
            &format!("/v1/office/cloud-shifts/{shift}/export-source"),
            None,
        )
        .await
        .1;
    assert_eq!(rows["codes"], json!([]));
    assert_eq!(rows["items"], json!([]));
    let box_id = r["part"]["payload"]["boxes"][0]["id"].as_str().unwrap();
    let report = a
        .call(
            "GET",
            &format!("/v1/office/cloud-boxes/{box_id}/report-data"),
            None,
        )
        .await
        .1;
    assert_eq!(report["items"].as_array().unwrap().len(), 1);
    let folder = a.app.dir().join("history-backup");
    std::fs::create_dir_all(&folder).unwrap();
    let mut conn = support::backup::worker_conn(&a.app).await;
    let manifest = markiro_host::backup::copy::make_copy(
        &mut conn,
        &folder,
        a.app.state.now(),
        markiro_proto::backup::BackupTrigger::Scheduled,
        &a.app.state.host_id,
    )
    .await
    .unwrap();
    conn.close().await.unwrap();
    let restored = tempfile::tempdir().unwrap();
    let paths = markiro_host::config::HostPaths::new(restored.path());
    markiro_host::restore::restore(
        &paths,
        &folder.join(manifest.file),
        false,
        a.app.state.now(),
    )
    .await
    .unwrap();
    let pool = markiro_host::db::open(&paths.database_file())
        .await
        .unwrap();
    let (size, hash): (i64, String) =
        sqlx::query_as("SELECT size_bytes,sha256 FROM export_files WHERE id=? AND state='ready'")
            .bind(file)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(size, bytes.len() as i64);
    assert_eq!(hash, markiro_host::cloud_history::validation::digest(bytes));
    let mut conn = pool.acquire().await.unwrap();
    assert_eq!(
        serde_json::to_value(
            markiro_host::cloud_history::read::export_rows(&mut conn, shift)
                .await
                .unwrap()
                .unwrap()
        )
        .unwrap(),
        rows
    );
    drop(conn);
    a.app.state.pool = pool;
    a.token = support::app::login(&a.app, &a.key, "admin", "correct horse battery").await;
    let (status, chunk) = a
        .call(
            "GET",
            &format!("/v1/office/export-files/{file}/chunks/0"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{chunk}");
    assert_eq!(
        STANDARD
            .decode(chunk["contentBase64"].as_str().unwrap())
            .unwrap(),
        bytes
    );
}

#[tokio::test]
async fn completed_history_has_typed_list_detail_and_frozen_export_source() {
    let (a, r) = history::setup(true).await;
    let shift = &r["part"]["payload"]["shifts"][0];
    let id = shift["id"].as_str().unwrap();
    let (status, list) = a.call("GET", "/v1/office/cloud-shifts", None).await;
    assert_eq!(status, StatusCode::OK, "{list}");
    assert_eq!(
        list["total"].as_u64().unwrap(),
        r["part"]["payload"]["shifts"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|s| s["inWindow"] == true)
            .count() as u64
    );
    let (status, detail) = a
        .call("GET", &format!("/v1/office/cloud-shifts/{id}"), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{detail}");
    assert_eq!(detail["shift"], *shift);
    let (status, rows) = a
        .call(
            "GET",
            &format!("/v1/office/cloud-shifts/{id}/export-source"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{rows}");
    assert_eq!(rows["shift"]["number"], shift["number"]);
    assert_eq!(
        rows["organization"]["name"],
        r["manifest"]["organization"]["name"]
    );
    assert_eq!(
        rows["codes"][0]["canonical"],
        r["part"]["payload"]["codes"][0]["canonical"]
    );
}

#[tokio::test]
async fn pending_history_is_not_reportable() {
    let (a, r) = history::setup(false).await;
    let id = r["part"]["payload"]["shifts"][0]["id"].as_str().unwrap();
    assert_eq!(
        a.call("GET", &format!("/v1/office/cloud-shifts/{id}"), None)
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    let (status, list) = a.call("GET", "/v1/office/cloud-shifts", None).await;
    assert_eq!(status, StatusCode::OK, "{list}");
    assert_eq!(list["total"], 0);
}
