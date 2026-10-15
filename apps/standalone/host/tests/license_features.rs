//! The license's features (plan ЛЦ-2, spec §4.7, ЛО23, Д8): `handheld`,
//! `pallets` and `labelEditor` refuse new actions only, inside the writer's
//! transaction, without a row or a revision; what was planned, paired or
//! made before keeps working. The trial has every feature.

mod support;

use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{
    accepted, admin, audit_rows, box_closed, box_id, device_shift_body, empty, fact, host_revision,
    instant, issue_block, issue_pallet_block, json as json_request, office_template, ok_scan,
    pair_device, pallet_closed, pallet_id, pallet_shift_body, pallet_template, plan_shift,
    receipts, record_id, request, sheet_spec, shift_body, shift_setup, with_device, Admin,
};
use support::license::{claim_device, file, load_ok, pairing_code};

const REQUEST: &str = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const OTHER_REQUEST: &str = "1b2c3d4e-5f60-4718-8293-a4b5c6d7e8f9";
const BLOCK_REQUEST: &str = "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a";
const PALLET_REQUEST: &str = "5e4d3c2b-1a09-4f8e-9d7c-6b5a4f3e2d1c";

fn without(host: &str, feature: &str) -> String {
    file(host, |terms| terms["features"][feature] = json!(false))
}

fn disabled(feature: &str) -> (StatusCode, Value, Value) {
    (
        StatusCode::CONFLICT,
        json!("conflict"),
        json!({ "constraint": "feature_disabled", "feature": feature }),
    )
}

fn refused(answer: (StatusCode, Value)) -> (StatusCode, Value, Value) {
    (
        answer.0,
        answer.1["error"]["code"].clone(),
        answer.1["error"]["details"].clone(),
    )
}

/// Audit rows and the host's revision: a refusal moves neither.
async fn marks(admin: &Admin) -> (i64, i64) {
    (
        audit_rows(&admin.app).await,
        host_revision(&admin.app).await,
    )
}

async fn device_call(
    admin: &Admin,
    key: &str,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let builder = with_device(request(method, path), key);
    match body {
        Some(body) => admin.app.send(json_request(builder, body)).await,
        None => admin.app.send(empty(builder)).await,
    }
}

async fn count(admin: &Admin, table: &str) -> i64 {
    sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table}"))
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap()
}

/// The code's use and its failed attempts.
async fn code_row(admin: &Admin, code: &Value) -> (Option<String>, i64) {
    sqlx::query_as("SELECT used_at, failed_attempts FROM pairing_codes WHERE id = ?")
        .bind(code["id"].as_str().unwrap())
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn the_trial_has_every_feature() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let template = pallet_template(&admin).await;
    plan_shift(&admin, pallet_shift_body(&setup, &template)).await;
    let code = pairing_code(&admin).await;
    let (status, body) = claim_device(&admin, &code, "handheld").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (_, license) = admin.call("GET", "/v1/office/license", None).await;
    assert_eq!(
        (license["state"].clone(), license["features"].clone()),
        (
            json!("trial"),
            json!({
                "labelEditor": true, "publicApi": true, "pallets": true,
                "chzIntegration": true, "inventory": true, "commerceMl": true,
                "handheld": true, "customLogo": true
            })
        )
    );
}

#[tokio::test]
async fn a_handheld_pairs_only_with_the_feature_and_keeps_the_code() {
    let admin = admin().await;
    // A handheld paired before keeps working.
    let code = pairing_code(&admin).await;
    let (status, paired) = claim_device(&admin, &code, "handheld").await;
    assert_eq!(status, StatusCode::OK, "{paired}");
    let handheld_key = paired["deviceKey"].as_str().unwrap().to_owned();
    load_ok(&admin, &without(&admin.app.state.host_id, "handheld")).await;
    let code = pairing_code(&admin).await;
    let before = marks(&admin).await;
    let devices = count(&admin, "devices").await;
    assert_eq!(
        refused(claim_device(&admin, &code, "handheld").await),
        disabled("handheld")
    );
    assert_eq!(marks(&admin).await, before);
    assert_eq!(count(&admin, "devices").await, devices);
    assert_eq!(code_row(&admin, &code).await, (None, 0));
    // Checked after the code (Д9): a wrong code is the code's refusal, with
    // its row and its attempt counted.
    let wrong = json!({ "code": "0000-0000" });
    let (status, body) = claim_device(&admin, &wrong, "handheld").await;
    assert_eq!(
        (status, body["error"]["code"].clone()),
        (StatusCode::BAD_REQUEST, json!("pairing_code_invalid")),
        "{body}"
    );
    assert_eq!(audit_rows(&admin.app).await, before.0 + 1);
    assert_eq!(code_row(&admin, &code).await, (None, 1));
    // The refused handheld kept the code: a station pairs with it.
    let (status, body) = claim_device(&admin, &code, "station").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, device) = device_call(&admin, &handheld_key, "GET", "/v1/device", None).await;
    assert_eq!(status, StatusCode::OK, "{device}");
    // Only a handheld asks: an office PC pairs by code without the feature.
    let code = pairing_code(&admin).await;
    let (status, body) = claim_device(&admin, &code, "office").await;
    assert_eq!(status, StatusCode::OK, "{body}");
}

#[tokio::test]
async fn pallets_are_refused_to_new_plans_and_kept_by_the_plans_that_have_them() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let template = pallet_template(&admin).await;
    let planned = plan_shift(&admin, pallet_shift_body(&setup, &template)).await;
    let other = plan_shift(&admin, pallet_shift_body(&setup, &template)).await;
    let plain = plan_shift(&admin, shift_body(&setup)).await;
    load_ok(&admin, &without(&admin.app.state.host_id, "pallets")).await;
    let shifts = count(&admin, "shifts").await;
    let before = marks(&admin).await;
    assert_eq!(
        refused(
            admin
                .call(
                    "POST",
                    "/v1/office/shifts",
                    Some(pallet_shift_body(&setup, &template))
                )
                .await
        ),
        disabled("pallets")
    );
    let plain_path = format!("/v1/office/shifts/{}", plain["id"].as_str().unwrap());
    assert_eq!(
        refused(
            admin
                .call(
                    "PUT",
                    &plain_path,
                    Some(json!({
                        "palletsEnabled": true, "palletTemplateId": template,
                        "expectedRev": plain["rev"]
                    })),
                )
                .await
        ),
        disabled("pallets")
    );
    assert_eq!(
        (marks(&admin).await, count(&admin, "shifts").await),
        (before, shifts)
    );
    let (_, kept) = admin.call("GET", &plain_path, None).await;
    assert_eq!(kept["palletsEnabled"], false);
    // A plan without pallets and every other edit stay open.
    assert_eq!(
        admin
            .call("POST", "/v1/office/shifts", Some(shift_body(&setup)))
            .await
            .0,
        StatusCode::OK
    );
    // A plan without pallets keeps them off and is edited as before.
    let (status, edited) = admin
        .call(
            "PUT",
            &plain_path,
            Some(json!({ "plannedQty": 90, "expectedRev": plain["rev"] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{edited}");
    assert_eq!(
        (
            edited["plannedQty"].clone(),
            edited["palletsEnabled"].clone()
        ),
        (json!(90), json!(false))
    );
    let planned_path = format!("/v1/office/shifts/{}", planned["id"].as_str().unwrap());
    let (status, edited) = admin
        .call(
            "PUT",
            &planned_path,
            Some(json!({ "plannedQty": 120, "palletBoxCapacity": 30, "expectedRev": planned["rev"] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{edited}");
    assert_eq!(
        (
            edited["palletsEnabled"].clone(),
            edited["palletBoxCapacity"].clone()
        ),
        (json!(true), json!(30))
    );
    let other_path = format!("/v1/office/shifts/{}", other["id"].as_str().unwrap());
    let (status, off) = admin
        .call(
            "PUT",
            &other_path,
            Some(json!({ "palletsEnabled": false, "expectedRev": other["rev"] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{off}");
    // A station's new shift with pallets is refused; one without is made.
    let (status, moved) = device_call(
        &admin,
        &admin.key,
        "PUT",
        "/v1/device/line",
        Some(json!({ "lineId": setup.line })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{moved}");
    let mut create = device_shift_body(&setup, REQUEST);
    create["palletsEnabled"] = json!(true);
    create["palletTemplateId"] = json!(template);
    let shifts = count(&admin, "shifts").await;
    let before = marks(&admin).await;
    assert_eq!(
        refused(
            device_call(
                &admin,
                &admin.key,
                "POST",
                "/v1/device/shifts",
                Some(create)
            )
            .await
        ),
        disabled("pallets")
    );
    assert_eq!(
        (marks(&admin).await, count(&admin, "shifts").await),
        (before, shifts)
    );
    let (_, station_key) = pair_device(&admin.app, "station").await;
    let (status, moved) = device_call(
        &admin,
        &station_key,
        "PUT",
        "/v1/device/line",
        Some(json!({ "lineId": setup.other_line })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{moved}");
    let (status, made) = device_call(
        &admin,
        &station_key,
        "POST",
        "/v1/device/shifts",
        Some(device_shift_body(&setup, OTHER_REQUEST)),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{made}");
    // The planned shift with pallets opens.
    let enter = format!(
        "/v1/device/shifts/{}/enter",
        planned["id"].as_str().unwrap()
    );
    let (status, entered) = device_call(&admin, &admin.key, "POST", &enter, None).await;
    assert_eq!(status, StatusCode::OK, "{entered}");
    assert_eq!(entered["palletsEnabled"], true);
    // An open shift with pallets goes on (spec §4.7): its boxes open a
    // pallet and the pallet closes.
    let shift = planned["id"].as_str().unwrap();
    let block = issue_block(&admin.app, &admin.key, BLOCK_REQUEST).await;
    let pallets = issue_pallet_block(&admin.app, &admin.key, PALLET_REQUEST).await;
    let pallet = pallet_id(1);
    let mut closed = box_closed(
        &box_id(1),
        &block,
        1500,
        &[1],
        &instant(1, 0),
        &instant(2, 0),
    );
    closed["palletId"] = json!(pallet);
    let records = [
        fact(
            &record_id(1),
            "scan",
            shift,
            ok_scan(1, &box_id(1), &instant(1, 0)),
        ),
        fact(&record_id(2), "box_closed", shift, closed),
        fact(
            &record_id(3),
            "pallet_closed",
            shift,
            pallet_closed(&pallet, &pallets, 40, 1, &instant(2, 0), &instant(3, 0)),
        ),
    ];
    assert_eq!(
        receipts(&admin.app, &admin.key, &records).await,
        vec![
            accepted(&record_id(1)),
            accepted(&record_id(2)),
            accepted(&record_id(3))
        ]
    );
}

#[tokio::test]
async fn templates_are_made_and_edited_only_with_the_label_editor() {
    let admin = admin().await;
    let id = office_template(&admin, "pallet", true, Value::Null).await;
    let doomed = office_template(&admin, "box", true, Value::Null).await;
    load_ok(&admin, &without(&admin.app.state.host_id, "labelEditor")).await;
    let layout = json!({
        "widthMm": 100, "heightMm": 150, "dpi": 203, "language": "zpl", "elements": []
    });
    let templates = count(&admin, "label_templates").await;
    let before = marks(&admin).await;
    // A new template is refused: an import and a copy are new ones too.
    assert_eq!(
        refused(
            admin
                .call(
                    "POST",
                    "/v1/office/templates",
                    Some(json!({
                        "name": "Импорт", "purpose": "pallet", "enabled": true,
                        "chzProductGroupCodes": null, "spec": layout
                    })),
                )
                .await
        ),
        disabled("labelEditor")
    );
    let path = format!("/v1/office/templates/{id}");
    let (_, current) = admin.call("GET", &path, None).await;
    let mut other_layout = layout.clone();
    other_layout["heightMm"] = json!(100);
    for edit in [
        json!({ "name": "Другое имя", "expectedRev": current["rev"] }),
        json!({ "spec": other_layout, "expectedRev": current["rev"] }),
    ] {
        assert_eq!(
            refused(admin.call("PUT", &path, Some(edit.clone())).await),
            disabled("labelEditor"),
            "{edit}"
        );
    }
    assert_eq!(
        (marks(&admin).await, count(&admin, "label_templates").await),
        (before, templates)
    );
    let (_, kept) = admin.call("GET", &path, None).await;
    assert_eq!(kept, current);
    // The same name and layout sent again change nothing and pass.
    let (status, body) = admin
        .call(
            "PUT",
            &path,
            Some(json!({
                "name": current["name"], "spec": layout, "expectedRev": current["rev"]
            })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    // Turning it off, its categories and a delete are no edit of its layout.
    let (status, body) = admin
        .call(
            "PUT",
            &path,
            Some(json!({ "enabled": false, "expectedRev": current["rev"] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, body) = admin
        .call(
            "PUT",
            &path,
            Some(json!({ "chzProductGroupCodes": [8], "expectedRev": body["rev"] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, _) = admin
        .call("DELETE", &format!("/v1/office/templates/{doomed}"), None)
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    // A stock template keeps its name and layout whatever the license says:
    // its refusal is the stock rule's, not the feature's.
    let stock = uuid::Uuid::new_v4().to_string();
    let rev: i64 = {
        let mut tx = markiro_host::db::begin_write(&admin.app.state.pool)
            .await
            .unwrap();
        let rev = markiro_host::db::next_revision(&mut tx).await.unwrap();
        sqlx::query(
            "INSERT INTO label_templates (id, name, purpose, enabled, spec, stock, rev) \
             VALUES (?, 'Коробка 58×40', 'box', 1, ?, 1, ?)",
        )
        .bind(&stock)
        .bind(layout.to_string())
        .bind(rev)
        .execute(&mut *tx)
        .await
        .unwrap();
        tx.commit().await.unwrap();
        rev
    };
    let stock_path = format!("/v1/office/templates/{stock}");
    let before = marks(&admin).await;
    for edit in [
        json!({ "name": "Моя коробка", "expectedRev": rev }),
        json!({ "spec": other_layout, "expectedRev": rev }),
    ] {
        let (status, body) = admin.call("PUT", &stock_path, Some(edit.clone())).await;
        assert_eq!(
            (status, body["error"]["details"].clone()),
            (
                StatusCode::CONFLICT,
                json!({ "constraint": "stock_template" })
            ),
            "{edit} {body}"
        );
    }
    assert_eq!(marks(&admin).await, before);
    // An A4 sheet is no label template (Д8): the library takes it.
    let (status, sheet) = admin
        .call(
            "POST",
            "/v1/office/pallet-sheets",
            Some(json!({ "name": "Лист", "spec": sheet_spec("custom") })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{sheet}");
}
