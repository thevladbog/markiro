#![allow(dead_code)]
use crate::support::app::{admin, cloud_import_request, Admin, IMPORT_ID};
use axum::http::StatusCode;
use serde_json::{json, Value};

pub fn request() -> Value {
    let mut lines = include_str!("../../../proto/fixtures/cloud-history.jsonl").lines();
    let mut r = json!({"manifest":serde_json::from_str::<Value>(lines.next().unwrap()).unwrap(),
        "part":serde_json::from_str::<Value>(lines.next().unwrap()).unwrap(),"dryRun":false});
    r["manifest"]["source"]["tenantId"] = json!("imp-test-atoll");
    r["manifest"].as_object_mut().unwrap().remove("checksum");
    r["manifest"]["checksum"] =
        json!(markiro_host::cloud_history::validation::checksum(&r["manifest"]).unwrap());
    r
}

pub fn seal(r: &mut Value) {
    let mut counts = json!({});
    for key in ["shifts", "codes", "boxes", "items", "pallets", "owners"] {
        counts[key] = json!(r["part"]["payload"][key].as_array().unwrap().len());
    }
    r["part"]["checksum"] =
        json!(markiro_host::cloud_history::validation::checksum(&r["part"]).unwrap());
    r["manifest"]["counts"] = counts.clone();
    r["manifest"]["parts"][0]["counts"] = counts;
    r["manifest"]["parts"][0]["checksum"] = r["part"]["checksum"].clone();
    r["manifest"]["checksum"] =
        json!(markiro_host::cloud_history::validation::checksum(&r["manifest"]).unwrap());
}

pub async fn setup(complete: bool) -> (Admin, Value) {
    setup_request(request(), complete).await
}
pub async fn setup_request(r: Value, complete: bool) -> (Admin, Value) {
    let a = admin().await;
    assert_eq!(
        a.call(
            "POST",
            "/v1/office/import",
            Some(cloud_import_request(IMPORT_ID, false))
        )
        .await
        .0,
        StatusCode::OK
    );
    let (status, body) = a
        .call("POST", "/v1/office/import/history", Some(r.clone()))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    if complete {
        let (status, body) = a
            .call(
                "POST",
                "/v1/office/import/history/complete",
                Some(json!({"batchId":r["manifest"]["checksum"]})),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
    }
    (a, r)
}
