mod support;

use aws_lc_rs::digest::{digest, SHA256};
use axum::http::StatusCode;
use serde_json::{json, Value};
use support::{
    app::{
        add_operator, admin, box_closed, box_id, fact, instant, issue_block, ok_scan, open_floor,
        pair_device, receipts, record_id, request, shift_closed, shift_setup, with_device, Admin,
    },
    disaggregation::BLOCK_REQUEST,
};

const UNIT: &str = "04607123456804";
const SET: &str = "04607123456781";

fn mark(gtin: &str, serial: &str) -> Value {
    let key = format!("01{gtin}21{serial}");
    let hash: String = digest(&SHA256, key.as_bytes())
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    json!({
        "gtin14": gtin, "serial": serial,
        "canonical": format!("{key}\u{1d}93Ab12"),
        "codeHash": hash,
    })
}

async fn create_product(admin: &Admin, body: Value) -> String {
    let (status, response) = admin.call("POST", "/v1/office/products", Some(body)).await;
    assert_eq!(status, StatusCode::OK, "{response}");
    response["id"].as_str().unwrap().to_owned()
}

#[tokio::test]
async fn accepts_a_set_and_dismantles_its_whole_source_box_once() {
    let admin = admin().await;
    let mut setup = shift_setup(&admin).await;
    setup.product = create_product(
        &admin,
        json!({
            "gtin14": UNIT, "name": "Крем", "chzProductGroupCode": 35,
            "boxCapacity": 3, "palletBoxCapacity": 40
        }),
    )
    .await;
    let set_product = create_product(
        &admin,
        json!({
            "gtin14": SET, "name": "Набор", "chzProductGroupCode": 35,
            "setItems": [{"gtin14": UNIT, "productName": "Крем", "quantity": 2}]
        }),
    )
    .await;
    let floor = open_floor(&admin, &setup, &admin.key, &setup.line).await;
    let block = issue_block(&admin.app, &floor.key, BLOCK_REQUEST).await;
    let id = box_id(1);
    let marks = [
        mark(UNIT, "ITEM001"),
        mark(UNIT, "ITEM002"),
        mark(UNIT, "ITEM003"),
    ];
    let mut source_records: Vec<_> = marks
        .iter()
        .enumerate()
        .map(|(i, mark)| {
            let n = u32::try_from(i).unwrap() + 1;
            let mut scan = ok_scan(n, &id, &instant(n, 0));
            scan["code"] = mark.clone();
            fact(&record_id(n), "scan", &floor.shift, scan)
        })
        .collect();
    let mut close = box_closed(
        &id,
        &block,
        1500,
        &[1, 2, 3],
        &instant(1, 0),
        &instant(4, 0),
    );
    close["membershipDigest"] = json!(markiro_host::facts::rules::box_membership_digest(
        &marks
            .iter()
            .map(|mark| mark["codeHash"].as_str().unwrap().to_owned())
            .collect::<Vec<_>>()
    ));
    source_records.push(fact(&record_id(4), "box_closed", &floor.shift, close));
    let original = receipts(&admin.app, &floor.key, &source_records).await;
    assert!(
        original.iter().all(|entry| entry["outcome"] == "accepted"),
        "{original:?}"
    );

    let (_, set_key) = pair_device(&admin.app, "station").await;
    let (status, _) = admin
        .app
        .send(support::app::json(
            with_device(request("PUT", "/v1/device/line"), &set_key),
            json!({"lineId": setup.other_line}),
        ))
        .await;
    assert_eq!(status, StatusCode::OK);
    let (status, shift) = admin.call("POST", "/v1/office/shifts", Some(json!({
        "productId": set_product, "lineId": setup.other_line, "productionDate": "2026-10-08",
        "mode": "validation",
    }))).await;
    assert_eq!(status, StatusCode::OK, "{shift}");
    let set_shift = shift["id"].as_str().unwrap();
    let (status, entered) = admin
        .app
        .send(support::app::json(
            with_device(
                request("POST", &format!("/v1/device/shifts/{set_shift}/enter")),
                &set_key,
            ),
            json!({"supports": ["validation-v1", "set-assembly-v1"]}),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{entered}");
    let (operator, _) = add_operator(&admin, "0042").await;
    let assembly = |n, items: &[Value]| {
        let mut value = fact(
            &record_id(n),
            "set_assembled",
            set_shift,
            json!({
                "assembledAt": instant(n, 0), "items": items, "setCode": mark(SET, "SET0001"),
            }),
        );
        value["operatorId"] = json!(operator);
        value
    };

    let blocked = receipts(&admin.app, &set_key, &[assembly(10, &marks[..2])]).await;
    assert_eq!(blocked[0]["outcome"], "rejected", "{blocked:?}");
    assert_eq!(blocked[0]["details"]["constraint"], "source_shift_open");
    let end = fact(
        &record_id(5),
        "shift_closed",
        &floor.shift,
        shift_closed(None, 3, 1, None, &instant(5, 0)),
    );
    assert_eq!(
        receipts(&admin.app, &floor.key, &[end]).await[0]["outcome"],
        "accepted"
    );
    let incomplete = receipts(&admin.app, &set_key, &[assembly(11, &marks[..1])]).await;
    assert_eq!(incomplete[0]["outcome"], "rejected");
    let (_, before) = admin.call("GET", "/v1/office/disaggregation", None).await;
    assert_eq!(before, json!([]));

    let complete = assembly(12, &marks[..2]);
    let accepted = receipts(&admin.app, &set_key, &[complete.clone()]).await;
    assert_eq!(accepted[0]["outcome"], "accepted", "{accepted:?}");
    let document_id = accepted[0]["details"]["disaggregationDocumentId"]
        .as_str()
        .unwrap();
    let (status, detail) = admin
        .call(
            "GET",
            &format!("/v1/office/disaggregation/{document_id}"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{detail}");
    assert_eq!(detail["document"]["status"], "applied");
    assert_eq!(detail["document"]["reasonName"], "Сборка набора");
    assert_eq!(detail["document"]["createdByOperatorId"], operator);
    assert_eq!(detail["lines"].as_array().unwrap().len(), 1);
    assert_eq!(detail["lines"][0]["boxId"], id);
    assert_eq!(detail["lines"][0]["codeCount"], 3);
    for shift in [&floor.shift, set_shift] {
        let (status, aggregate) = admin
            .call(
                "GET",
                &format!("/v1/office/shifts/{shift}/disaggregation-report?variant=full"),
                None,
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{aggregate}");
        assert_eq!(aggregate["lines"].as_array().unwrap().len(), 1);
        assert_eq!(aggregate["lines"][0]["id"], detail["lines"][0]["id"]);
        assert_eq!(aggregate["lines"][0]["items"].as_array().unwrap().len(), 3);
    }
    assert_eq!(receipts(&admin.app, &set_key, &[complete]).await, accepted);
    let (_, after) = admin.call("GET", "/v1/office/disaggregation", None).await;
    assert_eq!(after.as_array().unwrap().len(), 1);
}
