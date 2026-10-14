//! The shift's own date (beta 3 feedback; migration `0027`): `plannedDate`,
//! the cloud's name, apart from the production date. The number keeps coming
//! from the production date.

mod support;

use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{
    admin, audit_trail, empty, json as json_request, plan_shift, request, shift_body, shift_setup,
    with_device, Admin,
};

async fn device_call(
    admin: &Admin,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let builder = with_device(request(method, path), &admin.key);
    match body {
        Some(body) => admin.app.send(json_request(builder, body)).await,
        None => admin.app.send(empty(builder)).await,
    }
}

#[tokio::test]
async fn a_plan_without_a_shift_date_takes_its_production_date() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let shift = plan_shift(&admin, shift_body(&setup)).await;
    assert_eq!(shift["productionDate"], json!("2026-10-08"));
    assert_eq!(shift["plannedDate"], json!("2026-10-08"));
    let id = shift["id"].as_str().unwrap();
    // One date: the audit row keeps its old shape.
    assert_eq!(
        audit_trail(&admin.app, "shift.create").await,
        vec![admin.row(
            "shift.create",
            "shift",
            id,
            json!({
                "number": "OCT26-001", "productId": setup.product, "lineId": setup.line,
                "productionDate": "2026-10-08"
            })
        )]
    );
}

#[tokio::test]
async fn a_shift_date_is_planned_edited_audited_and_does_not_move_the_number() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let mut body = shift_body(&setup);
    body["plannedDate"] = json!("2026-11-02");
    let shift = plan_shift(&admin, body).await;
    // The number's month is the production date's.
    assert_eq!(shift["number"], json!("OCT26-001"));
    assert_eq!(shift["productionDate"], json!("2026-10-08"));
    assert_eq!(shift["plannedDate"], json!("2026-11-02"));
    let id = shift["id"].as_str().unwrap().to_owned();
    let path = format!("/v1/office/shifts/{id}");
    assert_eq!(
        audit_trail(&admin.app, "shift.create").await,
        vec![admin.row(
            "shift.create",
            "shift",
            &id,
            json!({
                "number": "OCT26-001", "productId": setup.product, "lineId": setup.line,
                "productionDate": "2026-10-08", "plannedDate": "2026-11-02"
            })
        )]
    );

    let (status, edited) = admin
        .call(
            "PUT",
            &path,
            Some(json!({ "plannedDate": "2026-10-09", "expectedRev": shift["rev"] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{edited}");
    assert_eq!(edited["plannedDate"], json!("2026-10-09"));
    assert_eq!(edited["productionDate"], json!("2026-10-08"));
    assert_eq!(edited["number"], json!("OCT26-001"));
    assert_eq!(
        audit_trail(&admin.app, "shift.update").await,
        vec![admin.row(
            "shift.update",
            "shift",
            &id,
            json!({
                "changed": ["plannedDate"],
                "plannedDate": { "from": "2026-11-02", "to": "2026-10-09" }
            })
        )]
    );
    // The same date again changes nothing and takes no revision.
    let (status, same) = admin
        .call(
            "PUT",
            &path,
            Some(json!({ "plannedDate": "2026-10-09", "expectedRev": edited["rev"] })),
        )
        .await;
    assert_eq!((status, &same), (StatusCode::OK, &edited));
    // An edit that names no shift date keeps it.
    let (status, kept) = admin
        .call(
            "PUT",
            &path,
            Some(json!({ "plannedQty": 100, "expectedRev": edited["rev"] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{kept}");
    assert_eq!(kept["plannedDate"], json!("2026-10-09"));
}

#[tokio::test]
async fn a_shift_date_must_be_a_real_calendar_date() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    for bad in ["2026-02-30", "26-10-01", "", "2026-10-08T00:00:00Z"] {
        let mut body = shift_body(&setup);
        body["plannedDate"] = json!(bad);
        let (status, refused) = admin.call("POST", "/v1/office/shifts", Some(body)).await;
        assert_eq!(
            (status, refused["error"]["details"]["field"].as_str()),
            (StatusCode::BAD_REQUEST, Some("plannedDate")),
            "{bad}"
        );
    }
    let shift = plan_shift(&admin, shift_body(&setup)).await;
    let (status, refused) = admin
        .call(
            "PUT",
            &format!("/v1/office/shifts/{}", shift["id"].as_str().unwrap()),
            Some(json!({ "plannedDate": "2026-13-01", "expectedRev": shift["rev"] })),
        )
        .await;
    assert_eq!(
        (status, refused["error"]["details"]["field"].as_str()),
        (StatusCode::BAD_REQUEST, Some("plannedDate"))
    );
}

#[tokio::test]
async fn the_list_filters_by_the_shift_date_and_the_production_date_together() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let mut ids = Vec::new();
    for (production, planned) in [
        ("2026-10-01", "2026-10-01"),
        ("2026-10-01", "2026-10-05"),
        ("2026-10-02", "2026-10-05"),
        ("2026-10-03", "2026-10-09"),
    ] {
        let mut body = shift_body(&setup);
        body["productionDate"] = json!(production);
        body["plannedDate"] = json!(planned);
        ids.push(plan_shift(&admin, body).await["id"].clone());
    }
    let list = |query: &'static str| {
        let admin = &admin;
        async move {
            let (status, list) = admin
                .call("GET", &format!("/v1/office/shifts?{query}"), None)
                .await;
            assert_eq!(status, StatusCode::OK, "{list}");
            let mut found: Vec<Value> = list
                .as_array()
                .unwrap()
                .iter()
                .map(|shift| shift["id"].clone())
                .collect();
            found.sort_by_key(|id| id.to_string());
            found
        }
    };
    let sorted = |picks: &[usize]| {
        let mut picked: Vec<Value> = picks.iter().map(|at| ids[*at].clone()).collect();
        picked.sort_by_key(|id| id.to_string());
        picked
    };
    assert_eq!(
        list("plannedFrom=2026-10-05&plannedTo=2026-10-05").await,
        sorted(&[1, 2])
    );
    assert_eq!(list("plannedFrom=2026-10-06").await, sorted(&[3]));
    assert_eq!(list("plannedTo=2026-10-01").await, sorted(&[0]));
    // Both periods narrow each other.
    assert_eq!(
        list("plannedFrom=2026-10-05&plannedTo=2026-10-09&from=2026-10-02&to=2026-10-02").await,
        sorted(&[2])
    );
    for (query, field) in [
        ("plannedFrom=2026-02-30", "plannedFrom"),
        ("plannedTo=nonsense", "plannedTo"),
        ("plannedFrom=2026-10-09&plannedTo=2026-10-01", "plannedTo"),
    ] {
        let (status, refused) = admin
            .call("GET", &format!("/v1/office/shifts?{query}"), None)
            .await;
        assert_eq!(
            (status, refused["error"]["details"]["field"].as_str()),
            (StatusCode::BAD_REQUEST, Some(field)),
            "{query}"
        );
    }
}

#[tokio::test]
async fn a_station_creates_a_shift_with_its_shift_date_or_without() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let (status, body) = device_call(
        &admin,
        "PUT",
        "/v1/device/line",
        Some(json!({ "lineId": setup.line })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let mut with_date =
        support::app::device_shift_body(&setup, "6b0b6c4c-6b52-4a2c-9f3e-1d2a3b4c5d6e");
    with_date["productionDate"] = json!("2026-10-09");
    with_date["plannedDate"] = json!("2026-10-10");
    let (status, created) = device_call(&admin, "POST", "/v1/device/shifts", Some(with_date)).await;
    assert_eq!(status, StatusCode::OK, "{created}");
    assert_eq!(created["productionDate"], json!("2026-10-09"));
    assert_eq!(created["plannedDate"], json!("2026-10-10"));
    // A station of an earlier build sends none: the production date.
    let old = support::app::device_shift_body(&setup, "7c1c7d5d-7c63-4b3d-8a4f-2e3b4c5d6e7f");
    let (status, created) = device_call(&admin, "POST", "/v1/device/shifts", Some(old)).await;
    assert_eq!(status, StatusCode::OK, "{created}");
    assert_eq!(created["plannedDate"], json!("2026-10-09"));
    // And the list the station reads carries it.
    let (status, list) = device_call(&admin, "GET", "/v1/device/shifts", None).await;
    assert_eq!(status, StatusCode::OK, "{list}");
    let mut dates: Vec<String> = list["shifts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|shift| shift["plannedDate"].as_str().unwrap().to_owned())
        .collect();
    dates.sort();
    assert_eq!(dates, ["2026-10-09", "2026-10-10"]);
    let (status, refused) = device_call(
        &admin,
        "POST",
        "/v1/device/shifts",
        Some({
            let mut bad =
                support::app::device_shift_body(&setup, "8d2d8e6e-8d74-4c4e-9b5a-3f4c5d6e7f80");
            bad["plannedDate"] = json!("2026-02-30");
            bad
        }),
    )
    .await;
    assert_eq!(
        (status, refused["error"]["details"]["field"].as_str()),
        (StatusCode::BAD_REQUEST, Some("plannedDate"))
    );
}

#[tokio::test]
async fn migration_0027_gives_every_old_shift_its_production_date() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let shift = plan_shift(&admin, shift_body(&setup)).await;
    let id = shift["id"].as_str().unwrap();
    // A row written by a build that does not know the column: the trigger.
    sqlx::query("UPDATE shifts SET planned_date = NULL WHERE id = ?")
        .bind(id)
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    let (status, read) = admin
        .call("GET", &format!("/v1/office/shifts/{id}"), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{read}");
    assert_eq!(
        read["plannedDate"],
        json!("2026-10-08"),
        "the answer falls back"
    );
    let planned: Option<String> =
        sqlx::query_scalar("SELECT planned_date FROM shifts WHERE id = ?")
            .bind(id)
            .fetch_one(&admin.app.state.pool)
            .await
            .unwrap();
    assert_eq!(planned, None);
}
