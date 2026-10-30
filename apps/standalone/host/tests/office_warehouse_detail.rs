mod support;
use axum::http::StatusCode;
use serde_json::json;
use support::app::{
    admin, empty, instant, pair_handheld, request, shift_setup, with_device, Admin,
};
use support::handheld::{
    added, box_sscc, closed_boxes, event, opened, pallet_block, pallet_sscc, product_of,
    receipts_of, PALLET_A,
};
async fn pallet(admin: &Admin) -> String {
    let setup = shift_setup(admin).await;
    closed_boxes(admin, &setup, 2).await;
    let key = pair_handheld(admin).await;
    let block = pallet_block(admin, &key, "8f7e6d5c-4b3a-4f2e-8d1c-9b8a7f6e5d4c").await;
    receipts_of(admin, &key, &[
        opened(1, PALLET_A, product_of(&setup), &instant(100, 0)),
        added(2, PALLET_A, &box_sscc(1500), &instant(101, 0)),
        added(3, PALLET_A, &box_sscc(1501), &instant(102, 0)),
        event(4, "warehouse_pallet_closed", json!({"palletId":PALLET_A,"sscc":pallet_sscc(40),"blockId":block["id"],"serial":40,"openedAt":instant(100,0),"closedAt":instant(110,0),"boxCount":2}))
    ]).await;
    key
}
#[tokio::test]
async fn card_keeps_members_origin_and_removal_history() {
    let admin = admin().await;
    let key = pallet(&admin).await;
    sqlx::query("UPDATE warehouse_pallet_boxes SET removed_at=? WHERE box_sscc=?")
        .bind(instant(120, 0))
        .bind(box_sscc(1501))
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    let path = format!("/v1/office/warehouse-pallets/{PALLET_A}");
    let (status, card) = admin.call("GET", &path, None).await;
    assert_eq!(status, StatusCode::OK, "{card}");
    assert_eq!(card["source"], "device");
    assert_eq!(card["boxes"], 1);
    assert_eq!(card["units"], 1);
    let members = card["members"].as_array().unwrap();
    assert_eq!(members.len(), 2);
    assert_eq!(members[0]["sscc"], box_sscc(1500));
    for field in ["shiftId", "shiftNumber", "productionDate"] {
        assert!(members[0][field].is_string());
    }
    assert_eq!(members[1]["removedAt"], instant(120, 0));
    for field in ["shelfLifeDays", "createdByName", "disassembledAt"] {
        assert!(card.get(field).is_some());
    }
    let (status, _) = admin
        .app
        .send(empty(with_device(request("GET", &path), &key)))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = admin
        .app
        .send(empty(with_device(request("GET", &path), &admin.key)))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}
#[tokio::test]
async fn disaggregation_of_warehouse_pallet_releases_members_and_keeps_document() {
    let admin = admin().await;
    pallet(&admin).await;
    let doc = support::disaggregation::create(
        &admin,
        json!({"reasonId":support::disaggregation::REASON}),
    )
    .await;
    let id = doc["document"]["id"].as_str().unwrap();
    let sscc = pallet_sscc(40);
    let (status, added) = support::disaggregation::add(
        &admin,
        id,
        json!([support::disaggregation::line(&sscc, Some(&sscc))]),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{added}");
    assert_eq!(added["lines"][0]["status"], "ok");
    assert_eq!(added["lines"][0]["warehousePalletId"], PALLET_A);
    assert!(added["lines"][0]["shiftId"].is_null());
    let before = support::app::host_revision(&admin.app).await;
    admin.app.clock.advance(time::Duration::seconds(5));
    let (status, done) = support::disaggregation::apply(&admin, &added).await;
    assert_eq!(support::app::host_revision(&admin.app).await, before + 1);
    assert_eq!(
        support::app::audit_trail(&admin.app, "disaggregation.apply").await,
        [support::app::audit_row(
            &admin.id,
            "disaggregation.apply",
            "disaggregation_document",
            id,
            json!({"docNo":doc["document"]["docNo"],"boxes":0,"pallets":1,"codes":0})
        )]
    );
    let unchanged: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM boxes WHERE disassembled_at IS NULL")
            .fetch_one(&admin.app.state.pool)
            .await
            .unwrap();
    assert_eq!(unchanged, 2);
    let touched: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM boxes WHERE changed_at=?")
        .bind(admin.app.state.timestamp())
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    assert_eq!(touched, 2);

    assert_eq!(status, StatusCode::OK, "{done}");
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM warehouse_pallet_boxes WHERE pallet_id=? AND removed_at IS NULL",
    )
    .bind(PALLET_A)
    .fetch_one(&admin.app.state.pool)
    .await
    .unwrap();
    assert_eq!(count, 0);
    let (status, report) = admin
        .call(
            "GET",
            &format!("/v1/office/disaggregation/{id}/report-data?variant=full"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{report}");
    assert_eq!(report["lines"][0]["boxes"].as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn warehouse_documents_store_and_download_exact_bytes() {
    use aws_lc_rs::digest::{digest, SHA256};
    use base64::{engine::general_purpose::STANDARD, Engine};
    let admin = admin().await;
    pallet(&admin).await;
    let bytes = b"<aggregation>warehouse</aggregation>";
    let sha: String = digest(&SHA256, bytes)
        .as_ref()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let id = "7a1c2d3e-4f50-4a61-8b72-93a4b5c6d7e8";
    let (status,stored)=admin.call("POST","/v1/office/export-files",Some(json!({
        "id":id,"batchId":"5d6e7f80-9a1b-4c2d-8e3f-4a5b6c7d8e9f","partNo":1,"kind":"pallet_export",
        "targetType":"warehouse_pallet","targetId":PALLET_A,"formatId":"pallet_xml_gismt_aggregation","formatVersion":1,
        "fileName":"warehouse.xml","sizeBytes":bytes.len(),"sha256":sha,"generator":"markiro-autonom test","contentBase64":STANDARD.encode(bytes)
    }))).await;
    assert_eq!(status, StatusCode::OK, "{stored}");
    assert_eq!(stored["ready"], true);
    let (status, list) = admin
        .call(
            "GET",
            &format!("/v1/office/export-files?targetType=warehouse_pallet&targetId={PALLET_A}"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{list}");
    assert_eq!(list["items"][0]["shiftId"], json!(null));
    let (status, opened) = admin
        .call(
            "POST",
            &format!("/v1/office/export-files/{id}/download"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{opened}");
    let (status, chunk) = admin
        .call(
            "GET",
            &format!("/v1/office/export-files/{id}/chunks/0"),
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
async fn card_keeps_mixed_shift_dates_and_disassembled_members() {
    use support::app::{login, plan_shift, seed_office_user};
    let admin = admin().await;
    pallet(&admin).await;
    let (product, template, line): (String, String, String) =
        sqlx::query_as("SELECT product_id,box_template_id,line_id FROM shifts LIMIT 1")
            .fetch_one(&admin.app.state.pool)
            .await
            .unwrap();
    let shift=plan_shift(&admin,json!({"productId":product,"lineId":line,"boxTemplateId":template,"productionDate":"2026-09-20","plannedQty":null,"counterpartyId":null,"boxCapacity":12,"mode":"aggregation","palletsEnabled":false})).await;
    sqlx::query("UPDATE boxes SET shift_id=?,disassembled_at=? WHERE sscc=?")
        .bind(shift["id"].as_str().unwrap())
        .bind(instant(120, 0))
        .bind(box_sscc(1501))
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE warehouse_pallets SET source='cabinet',created_by_user_id=?,creation_request_id='5d6e7f80-9a1b-4c2d-8e3f-4a5b6c7d8e9f',creation_hash=printf('%064d',0),device_id=(SELECT device_id FROM office_sessions LIMIT 1) WHERE id=?")
        .bind(&admin.id)
        .bind(PALLET_A)
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    seed_office_user(&admin.app, "reader", "technologist", "ViewerPassword1!").await;
    let token = login(&admin.app, &admin.key, "reader", "ViewerPassword1!").await;
    let (status, card) = admin
        .call_as(
            &token,
            "GET",
            &format!("/v1/office/warehouse-pallets/{PALLET_A}"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{card}");
    assert_eq!(card["source"], "cabinet");
    assert!(card["createdByName"].is_string());
    assert_eq!(card["boxes"], 1);
    assert_eq!(card["units"], 1);
    assert_eq!(card["members"][1]["productionDate"], "2026-09-20");
    assert_eq!(card["members"][1]["shiftId"], shift["id"]);
    assert!(card["members"][1]["disassembledAt"].is_string());
    let (status, list) = admin
        .call("GET", "/v1/office/warehouse-pallets", None)
        .await;
    assert_eq!(status, StatusCode::OK, "{list}");
    assert_eq!(list["pallets"][0]["deviceName"], "Офис");
}

#[tokio::test]
async fn document_migration_preserves_existing_line_and_file_rowids_and_bytes() {
    use sqlx::{Connection, SqliteConnection};
    let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
    sqlx::query("PRAGMA foreign_keys=ON")
        .execute(&mut conn)
        .await
        .unwrap();
    for migration in markiro_host::db::MIGRATOR.iter().filter(|m| m.version < 56) {
        sqlx::raw_sql(&migration.sql)
            .execute(&mut conn)
            .await
            .unwrap();
    }
    sqlx::raw_sql("INSERT INTO office_users(id,login,name,role,password_phc,created_at,rev) VALUES('u','admin','Автор','admin','test','at',1);
        INSERT INTO disaggregation_documents(id,seq,doc_no,status,source,created_by,created_at,updated_at,rev) VALUES('d',1,'DSG-26-0001','draft','manual','u','at','at',1);
        INSERT INTO disaggregation_document_lines(rowid,id,document_id,position,sscc_input,status,validated_at,created_at,cloud_product_id,cloud_product_name) VALUES(51,'l','d',1,'unknown','not_found','at','at','historical-product','Исторический товар');").execute(&mut conn).await.unwrap();
    sqlx::raw_sql("INSERT INTO cloud_history_batches(id,singleton,manifest,status,created_at) VALUES('batch',1,'{}','complete','at');
        INSERT INTO cloud_history_boxes(id,batch_id,shift_id,sscc,opened_at,closed_at) VALUES('cloud-box','batch','source-shift','046006820000000013','at','at');
        INSERT INTO disaggregation_document_lines(rowid,id,document_id,position,sscc_input,sscc,cloud_box_id,cloud_product_id,cloud_product_name,status,code_count,validated_at,created_at) VALUES(55,'lc','d',2,'046006820000000013','046006820000000013','cloud-box','source-product','Imported milk','ok',3,'at','at');")
        .execute(&mut conn).await.unwrap();
    let file = "7a1c2d3e-4f50-4a61-8b72-93a4b5c6d7e8";
    sqlx::query("INSERT INTO export_files(rowid,id,batch_id,part_no,kind,target_type,target_id,format_id,format_version,file_name,media_type,size_bytes,chunk_count,sha256,generator,state,stored_bytes,created_at,actor_id) VALUES(71,?,?,1,'form','disaggregation_document','d','form_act',1,'act.html','text/html',3,1,?,'test','ready',3,'at','u')")
        .bind(file).bind("5d6e7f80-9a1b-4c2d-8e3f-4a5b6c7d8e9f").bind("0".repeat(64)).execute(&mut conn).await.unwrap();
    sqlx::query("INSERT INTO export_file_chunks(rowid,file_id,seq,encoding,sha256,content) VALUES(92,?,0,'identity',?,?)").bind(file).bind("0".repeat(64)).bind(b"old".as_slice()).execute(&mut conn).await.unwrap();
    sqlx::raw_sql(include_str!(
        "../migrations/0056_warehouse_pallet_documents.sql"
    ))
    .execute(&mut conn)
    .await
    .unwrap();
    let line:(i64,Option<String>,Option<String>,Option<String>)=sqlx::query_as("SELECT rowid,cloud_product_id,cloud_product_name,warehouse_pallet_id FROM disaggregation_document_lines WHERE id='l'").fetch_one(&mut conn).await.unwrap();
    assert_eq!(
        line,
        (
            51,
            Some("historical-product".into()),
            Some("Исторический товар".into()),
            None
        )
    );
    let imported:(i64,String,String,String,i64)=sqlx::query_as("SELECT rowid,cloud_box_id,cloud_product_id,cloud_product_name,code_count FROM disaggregation_document_lines WHERE id='lc'")
        .fetch_one(&mut conn).await.unwrap();
    assert_eq!(
        imported,
        (
            55,
            "cloud-box".into(),
            "source-product".into(),
            "Imported milk".into(),
            3
        )
    );
    let saved:(i64,i64,Vec<u8>)=sqlx::query_as("SELECT f.rowid,c.rowid,c.content FROM export_files f JOIN export_file_chunks c ON c.file_id=f.id").fetch_one(&mut conn).await.unwrap();
    assert_eq!(saved, (71, 92, b"old".to_vec()));
    let violations = sqlx::query("PRAGMA foreign_key_check")
        .fetch_all(&mut conn)
        .await
        .unwrap();
    assert!(violations.is_empty());
}

#[tokio::test]
async fn disaggregation_report_excludes_members_removed_before_apply() {
    let admin = admin().await;
    pallet(&admin).await;
    sqlx::query("UPDATE warehouse_pallet_boxes SET removed_at=? WHERE box_sscc=?")
        .bind(instant(120, 0))
        .bind(box_sscc(1501))
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    let doc = support::disaggregation::create(
        &admin,
        json!({"reasonId":support::disaggregation::REASON}),
    )
    .await;
    let id = doc["document"]["id"].as_str().unwrap();
    let sscc = pallet_sscc(40);
    let (status, detail) = support::disaggregation::add(
        &admin,
        id,
        json!([support::disaggregation::line(&sscc, Some(&sscc))]),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{detail}");
    assert_eq!(detail["lines"][0]["codeCount"], 1);
    let (status, done) = support::disaggregation::apply(&admin, &detail).await;
    assert_eq!(status, StatusCode::OK, "{done}");
    let (status, report) = admin
        .call(
            "GET",
            &format!("/v1/office/disaggregation/{id}/report-data?variant=full"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{report}");
    assert_eq!(report["lines"][0]["boxes"].as_array().unwrap().len(), 1);
    assert_eq!(report["lines"][0]["boxes"][0]["sscc"], box_sscc(1500));
}

#[tokio::test]
async fn demo_warehouse_card_blocks_gismt_but_keeps_forms_and_cleanup() {
    use aws_lc_rs::digest::{digest, SHA256};
    use base64::{engine::general_purpose::STANDARD, Engine};
    let admin = admin().await;
    pallet(&admin).await;
    let (product, shift): (String, String) =
        sqlx::query_as("SELECT product_id,id FROM shifts LIMIT 1")
            .fetch_one(&admin.app.state.pool)
            .await
            .unwrap();
    // Legacy handheld warehouse pallets already exist; product.demo is the authoritative flag.
    sqlx::query("UPDATE products SET demo=1 WHERE id=?")
        .bind(&product)
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    let (status, card) = admin
        .call(
            "GET",
            &format!("/v1/office/warehouse-pallets/{PALLET_A}"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{card}");
    assert_eq!(card["demo"], true);
    let bytes = b"<demo/>";
    let sha: String = digest(&SHA256, bytes)
        .as_ref()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let id = "7a1c2d3e-4f50-4a61-8b72-93a4b5c6d7e8";
    let mut body = json!({"id":id,"batchId":"5d6e7f80-9a1b-4c2d-8e3f-4a5b6c7d8e9f","partNo":1,"kind":"pallet_export","targetType":"warehouse_pallet","targetId":PALLET_A,"formatId":"pallet_xml_gismt_aggregation","formatVersion":1,"fileName":"DEMO.xml","sizeBytes":bytes.len(),"sha256":sha,"generator":"test","contentBase64":STANDARD.encode(bytes)});
    let (status, refused) = admin
        .call("POST", "/v1/office/export-files", Some(body.clone()))
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{refused}");
    assert_eq!(refused["error"]["details"]["constraint"], "demo_shift");
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM export_files")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    body["kind"] = json!("form");
    body["formatId"] = json!("form_pallet");
    body["fileName"] = json!("DEMO.html");
    let (status, stored) = admin
        .call("POST", "/v1/office/export-files", Some(body))
        .await;
    assert_eq!(status, StatusCode::OK, "{stored}");
    assert_eq!(stored["ready"], true);
    let doc = support::disaggregation::create(
        &admin,
        json!({"reasonId":support::disaggregation::REASON}),
    )
    .await;
    let document_id = doc["document"]["id"].as_str().unwrap();
    let (status, refused) = support::disaggregation::add(
        &admin,
        document_id,
        json!([support::disaggregation::line(
            &pallet_sscc(40),
            Some(&pallet_sscc(40))
        )]),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{refused}");
    assert_eq!(refused["error"]["details"]["constraint"], "demo_box");
    // Preserve cleanup even if a legacy/imported document already held this warehouse target.
    sqlx::query("INSERT INTO disaggregation_document_lines(id,document_id,position,sscc_input,sscc,warehouse_pallet_id,product_id,status,validated_at,created_at) VALUES('legacy-demo-line',?,1,?,?,?,?,'ok','at','at')")
        .bind(document_id).bind(pallet_sscc(40)).bind(pallet_sscc(40)).bind(PALLET_A).bind(&product).execute(&admin.app.state.pool).await.unwrap();
    support::app::close_from_office(&admin, &shift, "Демо завершено").await;
    let (status, removed) = admin.call("DELETE", "/v1/office/demo-data", None).await;
    assert_eq!(status, StatusCode::OK, "{removed}");
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM export_files")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM export_file_chunks")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM disaggregation_document_lines WHERE id='legacy-demo-line'",
    )
    .fetch_one(&admin.app.state.pool)
    .await
    .unwrap();
    assert_eq!(count, 0);
}

#[tokio::test]
async fn box_card_and_shift_list_follow_the_live_warehouse_parent() {
    let admin = admin().await;
    pallet(&admin).await;
    let (box_id, shift): (String, String) =
        sqlx::query_as("SELECT id,shift_id FROM boxes WHERE sscc=?")
            .bind(box_sscc(1500))
            .fetch_one(&admin.app.state.pool)
            .await
            .unwrap();
    let (status, card) = admin
        .call("GET", &format!("/v1/office/boxes/{box_id}"), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{card}");
    assert_eq!(card["pallet"]["id"], PALLET_A);
    assert_eq!(card["pallet"]["kind"], "warehouse");
    let (status, boxes) = admin
        .call("GET", &format!("/v1/office/shifts/{shift}/boxes"), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{boxes}");
    let row = boxes
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["id"] == box_id)
        .unwrap();
    assert_eq!(row["palletId"], PALLET_A);
    assert_eq!(row["palletKind"], "warehouse");
    sqlx::query("UPDATE warehouse_pallet_boxes SET removed_at=? WHERE box_sscc=?")
        .bind(instant(120, 0))
        .bind(box_sscc(1500))
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    let (status, card) = admin
        .call("GET", &format!("/v1/office/boxes/{box_id}"), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{card}");
    assert!(card["pallet"].is_null());
}

#[tokio::test]
async fn member_stays_have_unique_keys_when_a_box_returns() {
    let admin = admin().await;
    pallet(&admin).await;
    sqlx::query("UPDATE warehouse_pallet_boxes SET removed_at=? WHERE box_sscc=?")
        .bind(instant(120, 0))
        .bind(box_sscc(1500))
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO warehouse_pallet_boxes(pallet_id,box_sscc,added_at,record_id,device_id) SELECT pallet_id,box_sscc,?,record_id,device_id FROM warehouse_pallet_boxes WHERE box_sscc=?")
        .bind(instant(121,0)).bind(box_sscc(1500)).execute(&admin.app.state.pool).await.unwrap();
    let (status, card) = admin
        .call(
            "GET",
            &format!("/v1/office/warehouse-pallets/{PALLET_A}"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{card}");
    let members = card["members"].as_array().unwrap();
    assert_eq!(members.len(), 3);
    assert_eq!(members[0]["id"], members[2]["id"]);
    assert!(members[0]["membershipId"].is_string());
    assert!(members[2]["membershipId"].is_string());
    assert_ne!(members[0]["membershipId"], members[2]["membershipId"]);
}

#[tokio::test]
async fn office_pallet_overrides_retired_production_parent_without_losing_origin() {
    let admin = admin().await;
    let floor = support::disaggregation::pallet_day(&admin, true).await;
    support::disaggregation::applied(&admin, &[support::app::pallet_sscc(40)]).await;
    let (status,created)=admin.call("POST","/v1/office/warehouse-pallets",Some(json!({"requestId":"d1000000-0000-4000-8000-000000000001","codes":[support::app::sscc(1500),support::app::sscc(1501)]}))).await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let (status, card) = admin
        .call(
            "GET",
            &format!("/v1/office/boxes/{}", support::app::box_id(1)),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{card}");
    assert_eq!(card["pallet"]["id"], created["id"]);
    assert_eq!(card["pallet"]["sscc"], created["sscc"]);
    assert_eq!(card["pallet"]["kind"], "warehouse");
    assert_eq!(card["shift"]["id"], floor.shift);
    support::disaggregation::applied(&admin, &[created["sscc"].as_str().unwrap().to_owned()]).await;
    let (status, card) = admin
        .call(
            "GET",
            &format!("/v1/office/boxes/{}", support::app::box_id(1)),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{card}");
    assert_eq!(card["pallet"]["id"], support::app::pallet_id(1));
    assert!(card["pallet"].get("kind").is_none());
    assert!(card["pallet"]["disassembledAt"].is_string());
}

#[tokio::test]
async fn unit_search_and_registry_follow_new_office_warehouse_parent() {
    let admin = admin().await;
    let floor = support::disaggregation::day(&admin, true).await;
    let (status,created)=admin.call("POST","/v1/office/warehouse-pallets",Some(json!({"requestId":"d1000000-0000-4000-8000-000000000002","codes":[support::app::sscc(1500)]}))).await;
    assert_eq!(status, StatusCode::OK, "{created}");
    for suffix in ["codes", "code-registry"] {
        let (status, page) = admin
            .call(
                "GET",
                &format!(
                    "/v1/office/{suffix}?sscc={}",
                    created["sscc"].as_str().unwrap()
                ),
                None,
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{page}");
        assert_eq!(page["total"], 3, "{page}");
        let row = if suffix == "codes" {
            &page["items"][0]
        } else {
            &page["items"][0]["item"]
        };
        assert_eq!(row["palletId"], created["id"]);
        assert_eq!(row["palletKind"], "warehouse");
        assert_eq!(row["shiftId"], floor.shift);
    }
    let hash = support::app::code_hash(1);
    for suffix in ["codes", "code-registry"] {
        let (status, page) = admin
            .call(
                "GET",
                &format!(
                    "/v1/office/{suffix}?sscc={}&codeHash={hash}",
                    created["sscc"].as_str().unwrap()
                ),
                None,
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{page}");
        assert_eq!(page["total"], 1, "{page}");
    }
    for (path, list) in [
        (format!("/v1/office/codes?codeHash={hash}"), true),
        (format!("/v1/office/codes/{hash}"), false),
    ] {
        let (status, response) = admin.call("GET", &path, None).await;
        assert_eq!(status, StatusCode::OK, "{response}");
        let item = if list {
            &response["items"][0]
        } else {
            &response["placements"][0]
        };
        assert_eq!(item["palletId"], created["id"]);
        assert_eq!(item["palletSscc"], created["sscc"]);
        assert_eq!(item["palletKind"], "warehouse");
        assert_eq!(item["shiftId"], floor.shift);
    }
    let (status, response) = admin
        .call(
            "GET",
            &format!("/v1/office/code-registry?source=local&codeHash={hash}"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{response}");
    assert_eq!(response["items"][0]["source"], "local");
    assert_eq!(response["items"][0]["item"]["palletId"], created["id"]);
    assert_eq!(response["items"][0]["item"]["palletKind"], "warehouse");
    let (status, response) = admin
        .call(
            "GET",
            &format!("/v1/office/code-registry/{hash}?source=local"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{response}");
    assert_eq!(
        response["local"]["placements"][0]["palletId"],
        created["id"]
    );
    assert_eq!(
        response["local"]["placements"][0]["palletKind"],
        "warehouse"
    );
    support::disaggregation::applied(&admin, &[created["sscc"].as_str().unwrap().to_owned()]).await;
    for suffix in ["codes", "code-registry"] {
        let (status, page) = admin
            .call(
                "GET",
                &format!(
                    "/v1/office/{suffix}?sscc={}",
                    created["sscc"].as_str().unwrap()
                ),
                None,
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{page}");
        assert_eq!(page["total"], 0, "{page}");
    }
}
