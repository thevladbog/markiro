//! An office disassembly is visible where the stations' exceptions are (plan
//! ДЗГ-О, the stitch plan ДЗГ left undone): a shift's «Исключения» list and
//! the code card show a box or pallet an applied document took apart, with
//! the document and the office user instead of a station and an operator.

mod support;

use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{admin, code_hash, pallet_sscc, sscc, Admin};
use support::disaggregation::{
    add, applied, create, day, line, pallet_day, station_disassembles, REASON,
};

async fn exceptions(admin: &Admin, shift: &str) -> Value {
    let (status, body) = admin
        .call(
            "GET",
            &format!("/v1/office/shifts/{shift}/exceptions"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body
}

async fn card(admin: &Admin, n: u32) -> Value {
    let (status, body) = admin
        .call("GET", &format!("/v1/office/codes/{}", code_hash(n)), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body
}

#[tokio::test]
async fn a_box_an_applied_document_took_apart_is_in_the_shifts_exceptions() {
    let admin = admin().await;
    let floor = day(&admin, true).await;
    let done = applied(&admin, &[sscc(1500)]).await;
    let (id, doc_no) = (
        done["document"]["id"].as_str().unwrap(),
        done["document"]["docNo"].as_str().unwrap(),
    );
    let body = exceptions(&admin, &floor.shift).await;
    assert_eq!(body["total"], 1);
    let item = &body["items"][0];
    assert_eq!(item["source"], "office");
    assert_eq!(item["subject"], "box");
    assert_eq!(item["kind"], "disassemble");
    assert_eq!(item["sscc"], json!(sscc(1500)));
    assert_eq!(item["subjectId"], done["lines"][0]["boxId"]);
    assert_eq!(item["id"], done["lines"][0]["id"]);
    assert_eq!(item["reasonCode"], Value::Null);
    assert_eq!(item["reasonText"], "Повреждена упаковка");
    assert_eq!(item["documentId"], json!(id));
    assert_eq!(item["documentNo"], json!(doc_no));
    assert_eq!(item["officeUserName"], "Ирина Смирнова");
    // No station, no operator.
    assert_eq!(item["deviceId"], Value::Null);
    assert_eq!(item["deviceName"], Value::Null);
    assert_eq!(item["operatorName"], Value::Null);
    // The instant the document took it apart at, and the document's apply.
    let disassembled: String =
        sqlx::query_scalar("SELECT disassembled_at FROM boxes WHERE sscc = ?")
            .bind(sscc(1500))
            .fetch_one(&admin.app.state.pool)
            .await
            .unwrap();
    assert_eq!(item["occurredAt"], json!(disassembled));
    assert_eq!(item["receivedAt"], done["document"]["appliedAt"]);
}

#[tokio::test]
async fn a_draft_or_cancelled_document_and_another_shift_are_not_in_it() {
    let admin = admin().await;
    let floor = day(&admin, true).await;
    // A draft, then a cancelled one, of the box.
    let draft = create(&admin, json!({ "reasonId": REASON })).await;
    let (_, detail) = add(
        &admin,
        draft["document"]["id"].as_str().unwrap(),
        json!([line(&sscc(1500), Some(&sscc(1500)))]),
    )
    .await;
    assert_eq!(exceptions(&admin, &floor.shift).await["total"], 0);
    let (status, cancelled) = admin
        .call(
            "POST",
            &format!(
                "/v1/office/disaggregation/{}/cancel",
                draft["document"]["id"].as_str().unwrap()
            ),
            Some(json!({ "expectedRev": detail["document"]["rev"] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{cancelled}");
    assert_eq!(exceptions(&admin, &floor.shift).await["total"], 0);
    // An applied one is in its own shift only.
    applied(&admin, &[sscc(1501)]).await;
    assert_eq!(exceptions(&admin, &floor.shift).await["total"], 1);
    let other = "7d1e2f3a-4b5c-4d6e-8f70-8192a3b4c5d6";
    let (status, _) = admin
        .call(
            "GET",
            &format!("/v1/office/shifts/{other}/exceptions"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn stations_and_the_office_share_one_list_newest_first() {
    let admin = admin().await;
    let floor = pallet_day(&admin, false).await;
    // The station takes box 2 apart at second 50; the office takes the pallet apart later.
    let receipt = station_disassembles(&admin, &floor, 20, 2, 50).await;
    assert_eq!(receipt["outcome"], "accepted", "{receipt}");
    support::app::close_from_office(&admin, &floor.shift, "Конец смены").await;
    let done = applied(&admin, &[pallet_sscc(40)]).await;
    let body = exceptions(&admin, &floor.shift).await;
    assert_eq!(body["total"], 2);
    let items = body["items"].as_array().unwrap();
    assert_eq!(items.len(), 2);
    // Newest first, whoever made them (the instants are the station's own
    // and the host's clock, so the test pins the order, not which is later).
    let at: Vec<&str> = items
        .iter()
        .map(|item| item["occurredAt"].as_str().unwrap())
        .collect();
    assert!(at[0] >= at[1], "{at:?}");
    let office = items.iter().find(|i| i["source"] == "office").unwrap();
    let station = items.iter().find(|i| i["source"] == "station").unwrap();
    assert_eq!(office["subject"], "pallet");
    assert_eq!(office["sscc"], json!(pallet_sscc(40)));
    assert_eq!(office["documentNo"], done["document"]["docNo"]);
    assert_eq!(station["subject"], "box");
    assert_eq!(station["deviceName"], "Тестовое устройство");
    assert_eq!(station["documentId"], Value::Null);
    assert_eq!(station["officeUserName"], Value::Null);
}

#[tokio::test]
async fn the_code_card_shows_the_document_that_freed_the_code() {
    let admin = admin().await;
    day(&admin, true).await;
    let done = applied(&admin, &[sscc(1500)]).await;
    let card = card(&admin, 1).await;
    let removed: Vec<&Value> = card["events"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|event| event["type"] == "removed")
        .collect();
    assert_eq!(removed.len(), 1, "{card}");
    let event = removed[0];
    assert_eq!(event["exception"], "disassemble");
    assert_eq!(event["documentId"], done["document"]["id"]);
    assert_eq!(event["documentNo"], done["document"]["docNo"]);
    assert_eq!(event["officeUserName"], "Ирина Смирнова");
    assert_eq!(event["reasonText"], "Повреждена упаковка");
    assert_eq!(event["reasonCode"], Value::Null);
    assert_eq!(event["operatorName"], Value::Null);
    assert_eq!(event["boxSscc"], json!(sscc(1500)));
    // A code of a box nobody took apart has no such event.
    assert!(card["events"]
        .as_array()
        .unwrap()
        .iter()
        .all(|e| e["type"] != "removed" || e["documentId"].is_string()));
    let untouched = self::card(&admin, 4).await;
    assert!(untouched["events"]
        .as_array()
        .unwrap()
        .iter()
        .all(|e| e["type"] != "removed"));
}

#[tokio::test]
async fn a_station_disassembly_has_no_document() {
    let admin = admin().await;
    let floor = day(&admin, false).await;
    let receipt = station_disassembles(&admin, &floor, 20, 1, 50).await;
    assert_eq!(receipt["outcome"], "accepted", "{receipt}");
    let card = card(&admin, 1).await;
    let event = card["events"]
        .as_array()
        .unwrap()
        .iter()
        .find(|event| event["type"] == "removed")
        .unwrap();
    assert_eq!(event["exception"], "disassemble");
    assert_eq!(event["documentId"], Value::Null);
    assert_eq!(event["documentNo"], Value::Null);
    assert_eq!(event["officeUserName"], Value::Null);
    assert_eq!(event["reasonCode"], "damaged_package");
}
