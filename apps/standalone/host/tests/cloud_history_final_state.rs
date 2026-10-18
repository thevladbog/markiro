//! Final cloud states cross independent clocks and retain historical pack links.
#[path = "support/history.rs"]
mod history;
mod support;

use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::pair_handheld;
use support::handheld::{accepted, events, opened, receipts_of, PALLET_A};

#[tokio::test]
async fn retained_links_allow_pre_disassembled_boxes_and_pallets() {
    for kind in ["box", "pallet"] {
        let mut r = history::request();
        if kind == "box" {
            r["part"]["payload"]["boxes"][0]["disassembledAt"] = json!("2026-10-17T12:00:00Z");
            r["part"]["payload"]["items"] = json!([]);
            r["part"]["payload"]["owners"][0]["boxId"] = Value::Null;
        } else {
            r["part"]["payload"]["pallets"][0]["disassembledAt"] = json!("2026-10-17T12:00:00Z");
        }
        assert!(!r["part"]["payload"]["boxes"][0]["palletId"].is_null());
        history::seal(&mut r);
        history::setup_request(r, true).await;
    }
}

#[tokio::test]
async fn retained_provenance_does_not_allow_invalid_endpoints_or_live_items_in_a_retired_box() {
    for case in [
        "missing_pallet",
        "wrong_shift",
        "wrong_product",
        "live_items",
    ] {
        let mut r = history::request();
        r["part"]["payload"]["pallets"][0]["disassembledAt"] = json!("2026-10-17T12:00:00Z");
        match case {
            "missing_pallet" => {
                r["part"]["payload"]["boxes"][0]["palletId"] =
                    json!("99999999-0000-4000-8000-000000000001")
            }
            "wrong_shift" => {
                r["part"]["payload"]["pallets"][0]["shiftId"] =
                    r["part"]["payload"]["shifts"][1]["id"].clone()
            }
            "wrong_product" => {
                let pallet = &mut r["part"]["payload"]["pallets"][0];
                pallet["kind"] = json!("warehouse");
                pallet["shiftId"] = Value::Null;
                pallet["productId"] = json!("99999999-0000-4000-8000-000000000002");
            }
            "live_items" => {
                r["part"]["payload"]["boxes"][0]["disassembledAt"] = json!("2026-10-17T12:00:00Z")
            }
            _ => unreachable!(),
        }
        history::seal(&mut r);
        let (a, r) = history::setup_request(r, false).await;
        let (status, body) = a
            .call(
                "POST",
                "/v1/office/import/history/complete",
                Some(json!({"batchId":r["manifest"]["checksum"]})),
            )
            .await;
        assert_eq!(status, StatusCode::CONFLICT, "{case}: {body}");
        assert_eq!(body["error"]["details"]["constraint"], "history_graph");
    }
}

#[tokio::test]
async fn source_instants_are_validated_without_cross_clock_ordering() {
    for (table, field, value) in [
        ("boxes", "closedAt", "2026-01-01T12:00:00Z"),
        ("boxes", "disassembledAt", "2026-01-01T12:00:00Z"),
        ("pallets", "closedAt", "2026-01-01T12:00:00Z"),
        ("pallets", "disassembledAt", "2026-01-01T12:00:00Z"),
        ("shifts", "openedAt", "2026-01-01T12:00:00Z"),
        ("shifts", "closedAt", "2026-01-01T12:00:00Z"),
    ] {
        let mut r = history::request();
        r["part"]["payload"][table][0][field] = json!(value);
        history::seal(&mut r);
        let request = serde_json::from_value(r).unwrap();
        assert!(
            markiro_host::cloud_history::validation::check(&request).is_ok(),
            "{table}.{field}"
        );
    }
    let mut r = history::request();
    r["part"]["payload"]["shifts"][0]["openedAt"] = Value::Null;
    r["part"]["payload"]["shifts"][0]["closedAt"] = json!("2026-01-01T12:00:00Z");
    history::seal(&mut r);
    assert!(
        markiro_host::cloud_history::validation::check(&serde_json::from_value(r).unwrap()).is_ok()
    );
}

#[tokio::test]
async fn malformed_source_instants_and_inconsistent_pack_states_still_fail() {
    for (table, field, value) in [
        ("boxes", "openedAt", json!("yesterday")),
        ("boxes", "closedAt", json!("2026-99-99T12:00:00Z")),
        ("pallets", "disassembledAt", json!("not-an-instant")),
        ("shifts", "createdAt", json!("2026-10-17")),
        ("shifts", "openedAt", json!("2026-10-17T12:00:00")),
        ("shifts", "closedAt", json!("invalid")),
        ("boxes", "closedAt", Value::Null),
    ] {
        let mut r = history::request();
        r["part"]["payload"][table][0][field] = value;
        history::seal(&mut r);
        assert!(
            markiro_host::cloud_history::validation::check(&serde_json::from_value(r).unwrap())
                .is_err(),
            "{table}.{field}"
        );
    }
    let mut r = history::request();
    let pack = &mut r["part"]["payload"]["pallets"][0];
    pack["closedAt"] = Value::Null;
    pack["sscc"] = Value::Null;
    pack["disassembledAt"] = json!("2026-10-17T12:00:00Z");
    history::seal(&mut r);
    assert!(
        markiro_host::cloud_history::validation::check(&serde_json::from_value(r).unwrap())
            .is_err()
    );
}

#[tokio::test]
async fn pending_history_retries_handheld_open_without_consuming_a_receipt() {
    let (a, r) = history::setup(false).await;
    let key = pair_handheld(&a).await;
    let product: String = sqlx::query_scalar("SELECT id FROM products LIMIT 1")
        .fetch_one(&a.app.state.pool)
        .await
        .unwrap();
    let batch = [opened(
        901,
        PALLET_A,
        &product,
        &support::app::instant(100, 0),
    )];
    for _ in 0..2 {
        let (status, body) = events(&a, &key, &batch).await;
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        assert_eq!(
            body["error"]["details"]["constraint"],
            "cloud_history_pending"
        );
        for table in ["warehouse_pallets", "device_event_receipts"] {
            let count: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table}"))
                .fetch_one(&a.app.state.pool)
                .await
                .unwrap();
            assert_eq!(count, 0, "{table}");
        }
    }
    let (status, body) = a
        .call(
            "POST",
            "/v1/office/import/history/complete",
            Some(json!({"batchId":r["manifest"]["checksum"]})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    for _ in 0..2 {
        assert_eq!(receipts_of(&a, &key, &batch).await, vec![accepted(901)]);
    }
    for table in ["warehouse_pallets", "device_event_receipts"] {
        let count: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table}"))
            .fetch_one(&a.app.state.pool)
            .await
            .unwrap();
        assert_eq!(count, 1, "{table}");
    }
    // A retained acceptance is checked before any pending-state gate. Seed only the
    // gate state to exercise that replay boundary; a real new import is impossible here.
    sqlx::query("UPDATE cloud_history_batches SET status='pending'")
        .execute(&a.app.state.pool)
        .await
        .unwrap();
    assert_eq!(receipts_of(&a, &key, &batch).await, vec![accepted(901)]);
    assert_eq!(
        receipts_of(
            &a,
            &key,
            &[opened(
                902,
                PALLET_A,
                &product,
                &support::app::instant(100, 0)
            )]
        )
        .await,
        vec![accepted(902)]
    );
}
