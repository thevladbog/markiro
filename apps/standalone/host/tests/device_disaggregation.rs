mod support;

use axum::http::StatusCode;
use serde_json::json;
use support::app::{add_operator, admin};

#[tokio::test]
async fn device_document_has_real_operator_and_device_and_is_readable_in_office_and_act() {
    let admin = admin().await;
    let (operator, _) = add_operator(&admin, "1001").await;
    let _key = support::app::pair_handheld(&admin).await;
    let device: String = sqlx::query_scalar("SELECT id FROM devices WHERE kind='handheld'")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE devices SET name='ТСД склада' WHERE id=?")
        .bind(&device)
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE operators SET name='Сергей' WHERE id=?")
        .bind(&operator)
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    let doc = uuid::Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO disaggregation_documents(id,seq,doc_no,status,reason_id,source,created_at,applied_at,updated_at,rev,device_id,operator_id,device_request_id,device_request_json) VALUES(?,1,'DSG-26-0001','applied',?,'manual','at','at','at',1,?,?,?,'{}')")
        .bind(&doc).bind(support::disaggregation::REASON).bind(&device).bind(&operator).bind(uuid::Uuid::new_v4().to_string())
        .execute(&admin.app.state.pool).await.unwrap();
    let (status, card) = admin
        .call("GET", &format!("/v1/office/disaggregation/{doc}"), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{card}");
    assert!(card["document"]["createdBy"].is_null());
    assert_eq!(card["document"]["createdByOperatorId"], json!(operator));
    assert_eq!(card["document"]["createdByDeviceId"], json!(device));
    assert_eq!(card["document"]["createdByName"], "Сергей · ТСД склада");
    assert_eq!(card["document"]["appliedByName"], "Сергей · ТСД склада");
    let (status, report) = admin
        .call(
            "GET",
            &format!("/v1/office/disaggregation/{doc}/report-data?variant=full"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{report}");
    assert_eq!(report["createdByName"], "Сергей · ТСД склада");
    assert_eq!(report["appliedByName"], "Сергей · ТСД склада");
    let (status, list) = admin.call("GET", "/v1/office/disaggregation", None).await;
    assert_eq!(status, StatusCode::OK, "{list}");
    assert_eq!(list[0]["id"], json!(doc));
}

async fn device_call(
    admin: &support::app::Admin,
    key: &str,
    path: &str,
    body: serde_json::Value,
) -> (StatusCode, serde_json::Value) {
    admin
        .app
        .send(support::app::json(
            support::app::with_device(support::app::request("POST", path), key),
            body,
        ))
        .await
}

#[tokio::test]
async fn handheld_takes_apart_another_devices_box_once_and_office_keeps_its_act_and_author() {
    let admin = admin().await;
    support::disaggregation::day(&admin, true).await;
    let (operator, _) = add_operator(&admin, "1001").await;
    let key = support::app::pair_handheld(&admin).await;
    let sscc = support::handheld::box_sscc(1500);
    let (status, look) = device_call(
        &admin,
        &key,
        "/v1/device/disaggregation/lookup",
        json!({"sscc":sscc,"operatorId":operator}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{look}");
    assert_eq!(look["kind"], "box");
    assert_eq!(look["units"], 3);
    assert_eq!(look["status"], "ok");
    let body = json!({"requestId":uuid::Uuid::new_v4().to_string(),"sscc":sscc,"operatorId":operator,"reasonId":support::disaggregation::REASON,"expectedToken":look["token"]});
    let before = support::app::host_revision(&admin.app).await;
    let (status, done) = device_call(
        &admin,
        &key,
        "/v1/device/disaggregation/apply",
        body.clone(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{done}");
    assert_eq!(done["codes"], 3);
    assert_eq!(support::app::host_revision(&admin.app).await, before + 1);
    let (status, again) = device_call(&admin, &key, "/v1/device/disaggregation/apply", body).await;
    assert_eq!(status, StatusCode::OK, "{again}");
    assert_eq!(again, done);
    assert_eq!(support::app::host_revision(&admin.app).await, before + 1);
    let id = done["documentId"].as_str().unwrap();
    let (status, card) = admin
        .call("GET", &format!("/v1/office/disaggregation/{id}"), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{card}");
    assert!(card["document"]["createdBy"].is_null());
    assert_eq!(card["document"]["createdByOperatorId"], json!(operator));
    assert_eq!(card["lines"][0]["boxId"], support::app::box_id(1));
    let shift: String = sqlx::query_scalar("SELECT shift_id FROM boxes WHERE id=?")
        .bind(support::app::box_id(1))
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    let (status, history) = admin
        .call(
            "GET",
            &format!("/v1/office/shifts/{shift}/exceptions"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{history}");
    assert_eq!(history["items"][0]["source"], "station");
    assert_eq!(
        history["items"][0]["deviceId"],
        card["document"]["createdByDeviceId"]
    );
    assert!(history["items"][0]["operatorName"].is_string());
    assert!(history["items"][0]["officeUserName"].is_null());

    let (status, report) = admin
        .call(
            "GET",
            &format!("/v1/office/disaggregation/{id}/report-data?variant=full"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{report}");
    assert_eq!(report["lines"][0]["items"].as_array().unwrap().len(), 3);
    let audits:Vec<(String,String,String,String,String)>=sqlx::query_as("SELECT actor_kind,actor_id,target_type,target_id,details FROM audit_log WHERE action='disaggregation.apply'").fetch_all(&admin.app.state.pool).await.unwrap();
    assert_eq!(audits.len(), 1);
    assert_eq!(audits[0].0, "device");
    assert_eq!(
        audits[0].1,
        card["document"]["createdByDeviceId"].as_str().unwrap()
    );
    assert_eq!(audits[0].2, "disaggregation_document");
    assert_eq!(audits[0].3, id);
    let detail: serde_json::Value = serde_json::from_str(&audits[0].4).unwrap();
    assert_eq!(
        detail,
        json!({"docNo":done["docNo"],"boxes":1,"pallets":0,"codes":3,"operatorId":operator})
    );
}

#[tokio::test]
async fn header_rebuild_preserves_existing_document_line_release_rowids_and_export_bytes() {
    let admin = admin().await;
    support::disaggregation::day(&admin, true).await;
    let done = support::disaggregation::applied(&admin, &[support::handheld::box_sscc(1500)]).await;
    let doc = done["document"]["id"].as_str().unwrap();
    let mut conn = admin.app.state.pool.acquire().await.unwrap();
    let before:(i64,i64,i64)=sqlx::query_as("SELECT d.rowid,l.rowid,r.rowid FROM disaggregation_documents d JOIN disaggregation_document_lines l ON l.document_id=d.id JOIN code_releases r ON r.document_id=d.id WHERE d.id=?").bind(doc).fetch_one(&mut *conn).await.unwrap();
    let file = uuid::Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO export_files(id,batch_id,part_no,kind,target_type,target_id,format_id,format_version,file_name,media_type,size_bytes,chunk_count,sha256,generator,state,stored_bytes,created_at,actor_id) VALUES(?,?,1,'form','disaggregation_document',?,'form_act',1,'act.html','text/html',3,1,?,'test','ready',3,'at',?)")
        .bind(&file).bind(uuid::Uuid::new_v4().to_string()).bind(doc).bind("0".repeat(64)).bind(&admin.id).execute(&mut *conn).await.unwrap();
    sqlx::query("INSERT INTO export_file_chunks(file_id,seq,encoding,sha256,content) VALUES(?,0,'identity',?,?)").bind(&file).bind("0".repeat(64)).bind(b"old".as_slice()).execute(&mut *conn).await.unwrap();
    sqlx::raw_sql("BEGIN IMMEDIATE; DROP VIEW disaggregation_authors;")
        .execute(&mut *conn)
        .await
        .unwrap();
    sqlx::raw_sql(include_str!("../migrations/0057_device_disaggregation.sql"))
        .execute(&mut *conn)
        .await
        .unwrap();
    sqlx::raw_sql("COMMIT;").execute(&mut *conn).await.unwrap();
    let after:(i64,i64,i64)=sqlx::query_as("SELECT d.rowid,l.rowid,r.rowid FROM disaggregation_documents d JOIN disaggregation_document_lines l ON l.document_id=d.id JOIN code_releases r ON r.document_id=d.id WHERE d.id=?").bind(doc).fetch_one(&mut *conn).await.unwrap();
    assert_eq!(before, after);
    let bytes: Vec<u8> =
        sqlx::query_scalar("SELECT content FROM export_file_chunks WHERE file_id=?")
            .bind(file)
            .fetch_one(&mut *conn)
            .await
            .unwrap();
    assert_eq!(bytes, b"old");
    assert!(sqlx::query("PRAGMA foreign_key_check")
        .fetch_all(&mut *conn)
        .await
        .unwrap()
        .is_empty());
}

fn checked(code: &str) -> String {
    let body = &code[..17];
    let sum: u32 = body
        .bytes()
        .enumerate()
        .map(|(i, b)| u32::from(b - b'0') * if i % 2 == 0 { 3 } else { 1 })
        .sum();
    format!("{body}{}", (10 - sum % 10) % 10)
}
#[tokio::test]
async fn office_pallet_and_production_pallet_can_be_disassembled_by_a_different_handheld_without_freeing_unit_codes(
) {
    for office in [true, false] {
        let admin = admin().await;
        let sscc = if office {
            support::disaggregation::day(&admin, true).await;
            let old = support::handheld::box_sscc(1500);
            let code = checked(&old);
            sqlx::query("UPDATE boxes SET sscc=? WHERE sscc=?")
                .bind(&code)
                .bind(old)
                .execute(&admin.app.state.pool)
                .await
                .unwrap();
            let (status, created) = admin
                .call(
                    "POST",
                    "/v1/office/warehouse-pallets",
                    Some(json!({"requestId":uuid::Uuid::new_v4().to_string(),"codes":[code]})),
                )
                .await;
            assert_eq!(status, StatusCode::OK, "{created}");
            created["sscc"].as_str().unwrap().to_owned()
        } else {
            support::disaggregation::pallet_day(&admin, true).await;
            support::handheld::pallet_sscc(40)
        };
        let (operator, _) = add_operator(&admin, "1001").await;
        let key = support::app::pair_handheld(&admin).await;
        let (_, look) = device_call(
            &admin,
            &key,
            "/v1/device/disaggregation/lookup",
            json!({"sscc":sscc,"operatorId":operator}),
        )
        .await;
        assert_eq!(look["kind"], "pallet", "{look}");
        let owners: i64 = sqlx::query_scalar("SELECT count(*) FROM code_owners")
            .fetch_one(&admin.app.state.pool)
            .await
            .unwrap();
        let body = json!({"requestId":uuid::Uuid::new_v4().to_string(),"sscc":sscc,"operatorId":operator,"reasonId":support::disaggregation::REASON,"expectedToken":look["token"]});
        let (status, done) =
            device_call(&admin, &key, "/v1/device/disaggregation/apply", body).await;
        assert_eq!(status, StatusCode::OK, "{done}");
        assert_eq!(done["codes"], 0);
        let after: i64 = sqlx::query_scalar("SELECT count(*) FROM code_owners")
            .fetch_one(&admin.app.state.pool)
            .await
            .unwrap();
        assert_eq!(owners, after);
        let intact: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM boxes WHERE closed_at IS NOT NULL AND disassembled_at IS NULL",
        )
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
        assert_eq!(intact, 2);
        if office {
            let live: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM warehouse_pallet_boxes WHERE removed_at IS NULL",
            )
            .fetch_one(&admin.app.state.pool)
            .await
            .unwrap();
            assert_eq!(live, 0);
        }
    }
}

#[tokio::test]
async fn stale_inspection_inactive_operator_restore_and_wrong_device_refuse_without_document_or_number(
) {
    let admin = admin().await;
    support::disaggregation::day(&admin, true).await;
    let (operator, _) = add_operator(&admin, "1001").await;
    let key = support::app::pair_handheld(&admin).await;
    let sscc = support::handheld::box_sscc(1500);
    let lookbody = json!({"sscc":sscc,"operatorId":operator});
    let (status, _) = device_call(
        &admin,
        &admin.key,
        "/v1/device/disaggregation/lookup",
        lookbody.clone(),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (_, look) = device_call(
        &admin,
        &key,
        "/v1/device/disaggregation/lookup",
        lookbody.clone(),
    )
    .await;
    let body = json!({"requestId":uuid::Uuid::new_v4().to_string(),"sscc":sscc,"operatorId":operator,"reasonId":support::disaggregation::REASON,"expectedToken":look["token"]});
    sqlx::query("UPDATE box_items SET displaced_at='2026-10-30T00:00:00Z' WHERE scan_id=(SELECT min(scan_id) FROM box_items WHERE box_id=?)").bind(support::app::box_id(1)).execute(&admin.app.state.pool).await.unwrap();
    let (status, refusal) = device_call(
        &admin,
        &key,
        "/v1/device/disaggregation/apply",
        body.clone(),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{refusal}");
    assert_eq!(refusal["error"]["details"]["constraint"], "pack_changed");
    sqlx::query("UPDATE operators SET active=0 WHERE id=?")
        .bind(&operator)
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    let (status, _) = device_call(
        &admin,
        &key,
        "/v1/device/disaggregation/apply",
        body.clone(),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    sqlx::query("UPDATE operators SET active=1 WHERE id=?")
        .bind(&operator)
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE site SET facts_held_since='at'")
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    let (status, _) = device_call(&admin, &key, "/v1/device/disaggregation/apply", body).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    let (docs,seq):(i64,i64)=sqlx::query_as("SELECT (SELECT count(*) FROM disaggregation_documents),last_seq FROM disaggregation_doc_counters").fetch_one(&admin.app.state.pool).await.unwrap();
    assert_eq!((docs, seq), (0, 0));
}

#[tokio::test]
async fn simultaneous_retries_and_request_id_reuse_never_spend_a_second_number() {
    let admin = admin().await;
    support::disaggregation::day(&admin, true).await;
    let (operator, _) = add_operator(&admin, "1001").await;
    let key = support::app::pair_handheld(&admin).await;
    let sscc = support::handheld::box_sscc(1500);
    let (_, look) = device_call(
        &admin,
        &key,
        "/v1/device/disaggregation/lookup",
        json!({"sscc":sscc,"operatorId":operator}),
    )
    .await;
    let body = json!({"requestId":uuid::Uuid::new_v4().to_string(),"sscc":sscc,"operatorId":operator,"reasonId":support::disaggregation::REASON,"expectedToken":look["token"]});
    let (a, b) = tokio::join!(
        device_call(
            &admin,
            &key,
            "/v1/device/disaggregation/apply",
            body.clone()
        ),
        device_call(
            &admin,
            &key,
            "/v1/device/disaggregation/apply",
            body.clone()
        )
    );
    assert_eq!(a.0, StatusCode::OK, "{:?}", a);
    assert_eq!(b.0, StatusCode::OK, "{:?}", b);
    assert_eq!(a.1, b.1);
    let mut different = body;
    different["reasonId"] = json!(support::disaggregation::OTHER_REASON);
    let (status, refusal) =
        device_call(&admin, &key, "/v1/device/disaggregation/apply", different).await;
    assert_eq!(status, StatusCode::CONFLICT, "{refusal}");
    assert_eq!(refusal["error"]["details"]["constraint"], "request_id");
    let (docs,seq,applies):(i64,i64,i64)=sqlx::query_as("SELECT (SELECT count(*) FROM disaggregation_documents),last_seq,(SELECT count(*) FROM audit_log WHERE action='disaggregation.apply') FROM disaggregation_doc_counters").fetch_one(&admin.app.state.pool).await.unwrap();
    assert_eq!((docs, seq, applies), (1, 1, 1));
}

#[tokio::test]
async fn a_device_revoked_after_authentication_cannot_apply_under_the_write_lock() {
    use axum::extract::State;
    use markiro_host::{auth::AuthDevice, error::ApiJson, routes::device_disaggregation};
    use markiro_proto::{device_disaggregation::PackDisassemble, DeviceKind};
    let admin = admin().await;
    support::disaggregation::day(&admin, true).await;
    let (operator, _) = add_operator(&admin, "1001").await;
    let key = support::app::pair_handheld(&admin).await;
    let sscc = support::handheld::box_sscc(1500);
    let (_, look) = device_call(
        &admin,
        &key,
        "/v1/device/disaggregation/lookup",
        json!({"sscc":sscc,"operatorId":operator}),
    )
    .await;
    let device: String = sqlx::query_scalar("SELECT id FROM devices WHERE kind='handheld'")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    let auth = AuthDevice {
        id: device.clone(),
        kind: DeviceKind::Handheld,
        key_hash: Some(markiro_host::secrets::key_hash(&key)),
        dataset_guard: None,
    };
    sqlx::query("UPDATE devices SET revoked_at='at' WHERE id=?")
        .bind(&device)
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    let result = device_disaggregation::apply(
        State(admin.app.state.clone()),
        auth,
        ApiJson(PackDisassemble {
            request_id: uuid::Uuid::new_v4().to_string(),
            sscc,
            operator_id: operator,
            reason_id: support::disaggregation::REASON.into(),
            expected_token: look["token"].as_str().unwrap().into(),
        }),
    )
    .await;
    assert!(result.is_err());
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM disaggregation_documents")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
}
