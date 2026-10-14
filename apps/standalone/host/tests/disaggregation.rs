//! Office disaggregation documents (plan ДЗГ, tasks 4): numbering, the
//! cloud's line statuses, the header, lines, cancel, the list and the roles.

mod support;

use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{
    admin, audit_row, audit_rows, audit_trail, box_id, close_from_office, empty, host_revision,
    pallet_sscc, request, sscc, with_device, Admin,
};
use support::disaggregation::{
    add, create, day, line, pallet_day, station_disassembles, OTHER_REASON, REASON,
};

const ROOT: &str = "/v1/office/disaggregation";

fn id_of(detail: &Value) -> String {
    detail["document"]["id"].as_str().unwrap().to_owned()
}

fn statuses(detail: &Value) -> Vec<String> {
    detail["lines"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| l["status"].as_str().unwrap().to_owned())
        .collect()
}

async fn me_name(admin: &Admin) -> String {
    let (status, me) = admin.call("GET", "/v1/office/me", None).await;
    assert_eq!(status, StatusCode::OK, "{me}");
    me["name"].as_str().unwrap().to_owned()
}

#[tokio::test]
async fn documents_are_numbered_by_one_counter_with_the_year() {
    let admin = admin().await;
    let first = create(&admin, json!({ "reasonId": REASON })).await;
    let second = create(&admin, json!({})).await;
    assert_eq!(first["document"]["docNo"], "DSG-26-0001");
    assert_eq!(second["document"]["docNo"], "DSG-26-0002");
    assert_eq!(first["document"]["status"], "draft");
    assert_eq!(first["document"]["reasonName"], "Повреждена упаковка");
    assert_eq!(first["document"]["createdBy"], json!(admin.id));
    assert_eq!(
        first["document"]["createdByName"],
        json!(me_name(&admin).await)
    );
    assert_eq!(first["document"]["source"], "manual");
    assert_eq!(first["lines"], json!([]));
    assert_eq!(second["document"]["reasonId"], Value::Null);
    let id = id_of(&first);
    assert_eq!(
        audit_trail(&admin.app, "disaggregation.create").await[0],
        audit_row(
            &admin.id,
            "disaggregation.create",
            "disaggregation_document",
            &id,
            json!({ "docNo": "DSG-26-0001", "reasonId": REASON, "comment": null })
        )
    );
    // The card reads back as the write answered.
    let (status, read) = admin.call("GET", &format!("{ROOT}/{id}"), None).await;
    assert_eq!((status, &read), (StatusCode::OK, &first));
    let (status, missing) = admin
        .call(
            "GET",
            &format!("{ROOT}/6a1f3c5e-7b9d-4e2f-8a4c-1d3e5f7a9b0c"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{missing}");
}

#[tokio::test]
async fn each_line_gets_the_clouds_status() {
    let admin = admin().await;
    let floor = day(&admin, false).await;
    let doc = create(&admin, json!({ "reasonId": REASON })).await;
    let id = id_of(&doc);
    // The shift is still open: its closed box is `shift_open`.
    let (status, detail) = add(
        &admin,
        &id,
        json!([
            line(&sscc(1500), Some(&sscc(1500))),
            line(&format!("(00){}", sscc(1500)), Some(&sscc(1500))), // a repeat
            line("MRK-000742", None),                                // not an SSCC
            line(&sscc(1999), Some(&sscc(1999))),                    // nobody's
            line("  spaced  ", None),
        ]),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{detail}");
    assert_eq!(
        statuses(&detail),
        [
            "shift_open",
            "duplicate",
            "not_found",
            "not_found",
            "not_found"
        ]
    );
    assert_eq!(detail["lines"][0]["boxId"], box_id(1));
    assert_eq!(detail["lines"][0]["palletId"], Value::Null);
    assert_eq!(detail["lines"][0]["codeCount"], 3);
    assert_eq!(detail["lines"][0]["shiftId"], json!(floor.shift));
    assert_eq!(detail["lines"][0]["shiftNumber"], json!(floor.number));
    assert_eq!(detail["lines"][0]["sscc"], json!(sscc(1500)));
    assert_eq!(detail["lines"][1]["sscc"], Value::Null);
    assert_eq!(detail["lines"][1]["boxId"], Value::Null);
    assert_eq!(
        detail["lines"][1]["ssccInput"],
        json!(format!("(00){}", sscc(1500)))
    );
    // A trimmed input; the SSCC the domain read is the webview's word.
    assert_eq!(detail["lines"][4]["ssccInput"], "spaced");
    assert_eq!(detail["lines"][3]["sscc"], json!(sscc(1999)));
    assert_eq!(detail["document"]["lineCount"], 5);
    assert_eq!(detail["document"]["codeCount"], 3);
    assert_eq!(
        detail["lines"][0]["productName"],
        json!("Молоко 3,2% 0,9 л")
    );

    // The station takes box 2 apart before the shift ends; the office closes it.
    let receipt = station_disassembles(&admin, &floor, 8, 2, 12).await;
    assert_eq!(receipt["outcome"], "accepted", "{receipt}");
    close_from_office(&admin, &floor.shift, "Конец смены").await;
    let second = create(&admin, json!({})).await;
    let (status, detail) = add(
        &admin,
        &id_of(&second),
        json!([
            line(&sscc(1500), Some(&sscc(1500))),
            line(&sscc(1501), Some(&sscc(1501))),
        ]),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{detail}");
    assert_eq!(statuses(&detail), ["ok", "already_disassembled"]);
    assert_eq!(detail["document"]["codeCount"], 3);
}

#[tokio::test]
async fn a_pallet_line_names_the_pallet_and_counts_its_boxes_codes() {
    let admin = admin().await;
    let floor = pallet_day(&admin, true).await;
    let doc = create(&admin, json!({ "reasonId": OTHER_REASON })).await;
    let (status, detail) = add(
        &admin,
        &id_of(&doc),
        json!([line(&pallet_sscc(40), Some(&pallet_sscc(40)))]),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{detail}");
    assert_eq!(statuses(&detail), ["ok"]);
    assert_eq!(detail["lines"][0]["boxId"], Value::Null);
    assert_eq!(
        detail["lines"][0]["palletId"],
        json!(support::app::pallet_id(1))
    );
    assert_eq!(detail["lines"][0]["codeCount"], 3);
    assert_eq!(detail["lines"][0]["shiftNumber"], json!(floor.number));
    // A box on the pallet is a box line of its own.
    let (_, detail) = add(
        &admin,
        &id_of(&doc),
        json!([line(&sscc(1500), Some(&sscc(1500)))]),
    )
    .await;
    assert_eq!(statuses(&detail), ["ok", "ok"]);
    assert_eq!(detail["document"]["codeCount"], 5);
}

#[tokio::test]
async fn a_header_is_changed_only_on_a_draft_over_its_rev() {
    let admin = admin().await;
    let doc = create(&admin, json!({ "reasonId": REASON, "comment": " первая " })).await;
    let id = id_of(&doc);
    assert_eq!(doc["document"]["comment"], "первая");
    let path = format!("{ROOT}/{id}");
    let rev = &doc["document"]["rev"];
    let (status, changed) = admin
        .call(
            "PUT",
            &path,
            Some(json!({ "reasonId": OTHER_REASON, "comment": "первая", "expectedRev": rev })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{changed}");
    assert_eq!(changed["document"]["reasonName"], "Другое");
    assert_eq!(
        changed["document"]["rev"].as_i64(),
        Some(rev.as_i64().unwrap() + 1)
    );
    assert_eq!(
        audit_trail(&admin.app, "disaggregation.update").await,
        [audit_row(
            &admin.id,
            "disaggregation.update",
            "disaggregation_document",
            &id,
            json!({ "changed": ["reasonId"], "reasonId": { "from": REASON, "to": OTHER_REASON } })
        )]
    );
    // The same header again: the card as it is, no row.
    let rows = audit_rows(&admin.app).await;
    let revision = host_revision(&admin.app).await;
    let (status, again) = admin
        .call(
            "PUT",
            &path,
            Some(json!({ "reasonId": OTHER_REASON, "comment": "первая",
                "expectedRev": changed["document"]["rev"] })),
        )
        .await;
    assert_eq!((status, &again), (StatusCode::OK, &changed));
    assert_eq!(audit_rows(&admin.app).await, rows);
    assert_eq!(host_revision(&admin.app).await, revision);

    let current = &changed["document"]["rev"];
    let archived = "d15a0000-0000-4000-8000-0000000000aa";
    // Archive a reason and try to name it.
    let (status, created) = admin
        .call(
            "POST",
            "/v1/office/disaggregation-reasons",
            Some(json!({ "name": "Старая" })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let (status, _) = admin
        .call(
            "PUT",
            &format!(
                "/v1/office/disaggregation-reasons/{}",
                created["id"].as_str().unwrap()
            ),
            Some(json!({ "name": "Старая", "sortOrder": 0, "archived": true,
                "expectedRev": created["rev"] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let current = current.clone();
    for (what, body, field) in [
        (
            "an archived reason",
            json!({ "reasonId": created["id"], "comment": null, "expectedRev": current }),
            "reasonId",
        ),
        (
            "an unknown reason",
            json!({ "reasonId": archived, "comment": null, "expectedRev": current }),
            "reasonId",
        ),
        (
            "a reason that is no UUID",
            json!({ "reasonId": "nope", "comment": null, "expectedRev": current }),
            "reasonId",
        ),
        (
            "a long comment",
            json!({ "reasonId": null, "comment": "x".repeat(501), "expectedRev": current }),
            "comment",
        ),
    ] {
        let (status, body) = admin.call("PUT", &path, Some(body)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{what}: {body}");
        assert_eq!(body["error"]["details"]["field"], field, "{what}");
    }
    // A stale revision.
    let (status, stale) = admin
        .call(
            "PUT",
            &path,
            Some(json!({ "reasonId": REASON, "comment": null, "expectedRev": 1 })),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{stale}");
    assert_eq!(stale["error"]["code"], "stale_revision");
    // An empty comment is kept as none.
    let (status, cleared) = admin
        .call(
            "PUT",
            &path,
            Some(json!({ "reasonId": OTHER_REASON, "comment": "   ", "expectedRev": current })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{cleared}");
    assert_eq!(cleared["document"]["comment"], Value::Null);
}

#[tokio::test]
async fn lines_are_added_and_deleted_on_a_draft_only() {
    let admin = admin().await;
    day(&admin, true).await;
    let doc = create(&admin, json!({ "reasonId": REASON })).await;
    let id = id_of(&doc);
    let (_, detail) = add(
        &admin,
        &id,
        json!([line(&sscc(1500), Some(&sscc(1500))), line("MRK-1", None)]),
    )
    .await;
    assert_eq!(detail["document"]["lineCount"], 2);
    let first = detail["lines"][0]["id"].as_str().unwrap().to_owned();
    let second = detail["lines"][1]["id"].as_str().unwrap().to_owned();

    let (status, deleted) = admin
        .call("DELETE", &format!("{ROOT}/{id}/lines/{second}"), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{deleted}");
    assert_eq!(deleted["lines"].as_array().map(Vec::len), Some(1));
    assert_eq!(deleted["lines"][0]["id"], json!(first));
    assert!(
        deleted["document"]["rev"].as_i64().unwrap() > detail["document"]["rev"].as_i64().unwrap()
    );
    assert_eq!(
        audit_trail(&admin.app, "disaggregation.lines.delete").await,
        [audit_row(
            &admin.id,
            "disaggregation.lines.delete",
            "disaggregation_document",
            &id,
            json!({ "docNo": "DSG-26-0001", "lineId": second, "ssccInput": "MRK-1" })
        )]
    );
    let (status, unknown) = admin
        .call("DELETE", &format!("{ROOT}/{id}/lines/{second}"), None)
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{unknown}");
    // A line of another document is no line of this one.
    let other = create(&admin, json!({})).await;
    let (status, foreign) = admin
        .call(
            "DELETE",
            &format!("{ROOT}/{}/lines/{first}", id_of(&other)),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{foreign}");

    // Cancel it.
    let (status, cancelled) = admin
        .call(
            "POST",
            &format!("{ROOT}/{id}/cancel"),
            Some(json!({ "expectedRev": deleted["document"]["rev"] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{cancelled}");
    assert_eq!(cancelled["document"]["status"], "cancelled");
    assert_eq!(cancelled["document"]["cancelledBy"], json!(admin.id));
    assert!(cancelled["document"]["cancelledAt"].is_string());
    assert_eq!(
        audit_trail(&admin.app, "disaggregation.cancel").await,
        [audit_row(
            &admin.id,
            "disaggregation.cancel",
            "disaggregation_document",
            &id,
            json!({ "docNo": "DSG-26-0001" })
        )]
    );
    // Nothing changes on a cancelled document.
    let rows = audit_rows(&admin.app).await;
    let attempts: Vec<(&str, String, Option<Value>)> = vec![
        (
            "POST",
            format!("{ROOT}/{id}/lines"),
            Some(json!({ "lines": [line("x", None)], "import": false })),
        ),
        ("DELETE", format!("{ROOT}/{id}/lines/{first}"), None),
        (
            "PUT",
            format!("{ROOT}/{id}"),
            Some(json!({ "reasonId": null, "comment": null,
                "expectedRev": cancelled["document"]["rev"] })),
        ),
        (
            "POST",
            format!("{ROOT}/{id}/cancel"),
            Some(json!({ "expectedRev": cancelled["document"]["rev"] })),
        ),
    ];
    for (method, path, body) in attempts {
        let (status, refused) = admin.call(method, &path, body).await;
        assert_eq!(status, StatusCode::CONFLICT, "{method} {path}: {refused}");
        assert_eq!(
            refused["error"]["details"]["constraint"], "document_not_draft",
            "{method} {path}"
        );
    }
    assert_eq!(audit_rows(&admin.app).await, rows);
}

#[tokio::test]
async fn the_limits_of_a_request_and_a_document() {
    let admin = admin().await;
    let doc = create(&admin, json!({})).await;
    let id = id_of(&doc);
    let many: Vec<Value> = (0..501)
        .map(|n| line(&sscc(20_000 + n), Some(&sscc(20_000 + n))))
        .collect();
    for (what, lines, field) in [
        ("501 lines", Value::Array(many), "lines"),
        ("no lines", json!([]), "lines"),
        (
            "a 65-character input",
            json!([line(&"x".repeat(65), None)]),
            "lines.0.input",
        ),
        (
            "an empty input",
            json!([line("   ", None)]),
            "lines.0.input",
        ),
        (
            "a 17-digit SSCC",
            json!([line("a", Some("46006820000150000"))]),
            "lines.0.sscc",
        ),
        (
            "an SSCC with a letter",
            json!([line("a", Some("04600682000015000x"))]),
            "lines.0.sscc",
        ),
        (
            "the second line bad",
            json!([line("a", None), line(&"y".repeat(65), None)]),
            "lines.1.input",
        ),
    ] {
        let (status, body) = add(&admin, &id, lines).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{what}: {body}");
        assert_eq!(body["error"]["details"]["field"], field, "{what}");
    }
    // Nothing was written by the refusals.
    let (_, read) = admin.call("GET", &format!("{ROOT}/{id}"), None).await;
    assert_eq!(read["lines"], json!([]));
    // 10 000 lines fill a document; the next one is refused.
    for batch in 0..20u64 {
        let lines: Vec<Value> = (0..500u64)
            .map(|n| {
                let serial = 20_000 + batch * 500 + n;
                line(&sscc(serial), Some(&sscc(serial)))
            })
            .collect();
        let (status, detail) = add(&admin, &id, Value::Array(lines)).await;
        assert_eq!(status, StatusCode::OK, "{batch}: {detail}");
    }
    let (_, full) = admin.call("GET", &format!("{ROOT}/{id}"), None).await;
    assert_eq!(full["document"]["lineCount"], 10_000);
    let (status, refused) = add(&admin, &id, json!([line("one more", None)])).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{refused}");
    assert_eq!(refused["error"]["details"]["field"], "lines");
}

#[tokio::test]
async fn import_marks_the_source() {
    let admin = admin().await;
    let doc = create(&admin, json!({})).await;
    let id = id_of(&doc);
    let (status, detail) = admin
        .call(
            "POST",
            &format!("{ROOT}/{id}/lines"),
            Some(json!({ "lines": [line("a", None), line("b", None)], "import": true })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{detail}");
    assert_eq!(detail["document"]["source"], "import");
    assert_eq!(
        audit_trail(&admin.app, "disaggregation.lines.add").await,
        [audit_row(
            &admin.id,
            "disaggregation.lines.add",
            "disaggregation_document",
            &id,
            json!({ "docNo": "DSG-26-0001", "added": 2, "import": true })
        )]
    );
    // A typed batch afterwards keeps the document an import.
    let (_, detail) = add(&admin, &id, json!([line("c", None)])).await;
    assert_eq!(detail["document"]["source"], "import");
}

#[tokio::test]
async fn the_list_filters_by_status_reason_period_and_number() {
    let admin = admin().await;
    let a = create(&admin, json!({ "reasonId": REASON })).await;
    admin.app.clock.advance(time::Duration::minutes(5));
    let b = create(&admin, json!({ "reasonId": OTHER_REASON })).await;
    admin.app.clock.advance(time::Duration::minutes(5));
    let c = create(&admin, json!({ "reasonId": REASON })).await;
    let (status, _) = admin
        .call(
            "POST",
            &format!("{ROOT}/{}/cancel", id_of(&b)),
            Some(json!({ "expectedRev": b["document"]["rev"] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);

    let list = |query: &'static str| {
        let admin = &admin;
        async move {
            let (status, body) = admin.call("GET", &format!("{ROOT}{query}"), None).await;
            (status, body)
        }
    };
    let numbers = |body: &Value| -> Vec<String> {
        body.as_array()
            .unwrap()
            .iter()
            .map(|d| d["docNo"].as_str().unwrap().to_owned())
            .collect()
    };
    let (status, all) = list("").await;
    assert_eq!(status, StatusCode::OK, "{all}");
    // Newest first.
    assert_eq!(numbers(&all), ["DSG-26-0003", "DSG-26-0002", "DSG-26-0001"]);
    let (_, cancelled) = list("?status=cancelled").await;
    assert_eq!(numbers(&cancelled), ["DSG-26-0002"]);
    let (_, drafts) = list("?status=draft").await;
    assert_eq!(numbers(&drafts), ["DSG-26-0003", "DSG-26-0001"]);
    let (_, by_reason) = list("?reasonId=d15a0000-0000-4000-8000-000000000003").await;
    assert_eq!(numbers(&by_reason), ["DSG-26-0003", "DSG-26-0001"]);
    let (_, by_number) = list("?q=0002").await;
    assert_eq!(numbers(&by_number), ["DSG-26-0002"]);
    let (_, by_wild) = list("?q=%25").await;
    assert_eq!(numbers(&by_wild), Vec::<String>::new());
    let created_b = b["document"]["createdAt"].as_str().unwrap().to_owned();
    let (status, from_b) = admin
        .call("GET", &format!("{ROOT}?from={created_b}"), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{from_b}");
    assert_eq!(numbers(&from_b), ["DSG-26-0003", "DSG-26-0002"]);
    let (_, to_b) = admin
        .call("GET", &format!("{ROOT}?to={created_b}"), None)
        .await;
    assert_eq!(numbers(&to_b), ["DSG-26-0002", "DSG-26-0001"]);
    let (_, later) = list("?from=2030-01-01T00:00:00Z").await;
    assert_eq!(numbers(&later), Vec::<String>::new());
    // The list rows are the cards' documents.
    assert_eq!(all[2], a["document"]);
    assert_eq!(all[0], c["document"]);
    for (what, query, field) in [
        ("a status", "?status=bogus", "status"),
        ("a date, not an instant", "?from=2026-10-13", "from"),
        ("a bad to", "?to=yesterday", "to"),
        ("a bad reason", "?reasonId=nope", "reasonId"),
    ] {
        let (status, body) = list(query).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{what}: {body}");
        assert_eq!(body["error"]["details"]["field"], field, "{what}");
    }
}

#[tokio::test]
async fn every_office_role_reads_and_writes_and_a_device_alone_does_not() {
    let admin = admin().await;
    day(&admin, true).await;
    let (tech, tech_id) = admin.technologist_session().await;
    let (status, doc) = admin
        .call_as(&tech, "POST", ROOT, Some(json!({ "reasonId": REASON })))
        .await;
    assert_eq!(status, StatusCode::OK, "{doc}");
    assert_eq!(doc["document"]["createdBy"], json!(tech_id));
    let (status, added) = admin
        .call_as(
            &tech,
            "POST",
            &format!("{ROOT}/{}/lines", id_of(&doc)),
            Some(json!({ "lines": [line(&sscc(1500), Some(&sscc(1500)))], "import": false })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{added}");
    assert_eq!(statuses(&added), ["ok"]);
    assert_eq!(
        audit_trail(&admin.app, "disaggregation.create").await,
        [audit_row(
            &tech_id,
            "disaggregation.create",
            "disaggregation_document",
            &id_of(&doc),
            json!({ "docNo": "DSG-26-0001", "reasonId": REASON, "comment": null })
        )]
    );
    // A station's key without an office session is no office caller.
    let id = id_of(&doc);
    for (method, path) in [
        ("GET", ROOT.to_owned()),
        ("POST", ROOT.to_owned()),
        ("GET", format!("{ROOT}/{id}")),
        ("PUT", format!("{ROOT}/{id}")),
        ("POST", format!("{ROOT}/{id}/lines")),
        ("DELETE", format!("{ROOT}/{id}/lines/x")),
        ("POST", format!("{ROOT}/{id}/apply")),
        ("POST", format!("{ROOT}/{id}/cancel")),
    ] {
        let builder = with_device(request(method, &path), &admin.key);
        let request = if method == "POST" || method == "PUT" {
            support::app::json(builder, json!({}))
        } else {
            empty(builder)
        };
        let (status, body) = admin.app.send(request).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{method} {path}: {body}");
        assert_eq!(
            body["error"]["details"]["credential"], "session",
            "{method} {path}"
        );
    }
}
