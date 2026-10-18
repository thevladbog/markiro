#[path = "support/history.rs"]
mod history;
mod support;

use axum::http::StatusCode;
use serde_json::{json, Value};

#[tokio::test]
async fn gtin_search_includes_canonical_identity_of_flat_only_occurrences() {
    let (a, r) = history::setup(true).await;
    let codes = r["part"]["payload"]["codes"].as_array().unwrap();
    let flat = codes.iter().find(|code| code["flatOnly"] == true).unwrap();
    let gtin = codes[0]["gtin14"].as_str().unwrap();
    let hash = flat["hash"].as_str().unwrap();
    let expected: std::collections::HashSet<_> = codes
        .iter()
        .map(|code| code["hash"].as_str().unwrap())
        .collect();
    let (status, page) = a
        .call(
            "GET",
            &format!("/v1/office/code-registry?source=cloud&gtin={gtin}"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert_eq!(
        page["total"], 2,
        "every validated canonical GTIN must match: {page}"
    );
    let actual: std::collections::HashSet<_> = page["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["item"]["codeHash"].as_str().unwrap())
        .collect();
    assert_eq!(actual, expected);
    for criteria in [
        format!("gtin={gtin}&codeHash={hash}"),
        format!(
            "gtin={gtin}&shift={}",
            r["part"]["payload"]["shifts"][1]["number"]
                .as_str()
                .unwrap()
        ),
    ] {
        let (status, page) = a
            .call(
                "GET",
                &format!("/v1/office/code-registry?source=all&{criteria}"),
                None,
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{page}");
        assert_eq!(page["total"], 1, "{criteria}: {page}");
        let item = &page["items"][0]["item"];
        assert_eq!(item["codeHash"], hash);
        assert!(
            item["gtin14"].is_null(),
            "read projection must preserve source metadata"
        );
        assert!(item["serial"].is_null());
    }
}

#[tokio::test]
async fn registry_reads_completed_cloud_occurrences_without_changing_legacy_search() {
    let (a, r) = history::setup(false).await;
    let hash = r["part"]["payload"]["codes"][0]["hash"].as_str().unwrap();
    let path = format!("/v1/office/code-registry?codeHash={hash}");
    let (status, pending) = a.call("GET", &path, None).await;
    assert_eq!(status, StatusCode::OK, "{pending}");
    assert_eq!(pending["total"], 0);
    assert_eq!(
        a.call(
            "POST",
            "/v1/office/import/history/complete",
            Some(json!({"batchId":r["manifest"]["checksum"]}))
        )
        .await
        .0,
        StatusCode::OK
    );
    for (source, total) in [("all", 1), ("cloud", 1), ("local", 0)] {
        let (status, page) = a
            .call("GET", &format!("{path}&source={source}"), None)
            .await;
        assert_eq!(status, StatusCode::OK, "{page}");
        assert_eq!(page["total"], total, "{page}");
        if total == 1 {
            let item = &page["items"][0];
            assert_eq!(item["source"], "cloud");
            assert_eq!(item["item"]["state"], "owned");
            assert_eq!(item["item"]["sourceTimeZone"], "Europe/Moscow");
            assert_eq!(item["item"]["shiftAvailable"], true);
            assert!(item["item"].get("scanId").is_none());
        }
    }
    assert_eq!(
        a.call("GET", &format!("/v1/office/codes?codeHash={hash}"), None)
            .await
            .1["total"],
        0
    );
    let (status, card) = a
        .call(
            "GET",
            &format!("/v1/office/code-registry/{hash}?source=local"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{card}");
    assert_eq!(card["currentOwner"]["source"], "cloud");
    assert!(card["local"].is_null());
}

#[tokio::test]
async fn owner_only_provenance_is_searchable_outside_window_without_invented_identity_or_links() {
    let owner: Value = serde_json::from_str(include_str!(
        "../../proto/fixtures/cloud-history-external-owner.json"
    ))
    .unwrap();
    let mut r = history::request();
    r["part"]["payload"]["owners"]
        .as_array_mut()
        .unwrap()
        .push(owner.clone());
    history::seal(&mut r);
    let (a, _) = history::setup_request(r, true).await;
    let owner_at = time::OffsetDateTime::parse(
        owner["scannedAt"].as_str().unwrap(),
        &time::format_description::well_known::Rfc3339,
    )
    .unwrap()
    .unix_timestamp_nanos()
        / 1_000_000;
    for query in [
        format!("fromMs={owner_at}&toMs={}", owner_at + 1),
        format!("codeHash={}", owner["hash"].as_str().unwrap()),
        format!("shift={}", owner["number"].as_str().unwrap()),
    ] {
        let (status, page) = a
            .call("GET", &format!("/v1/office/code-registry?{query}"), None)
            .await;
        assert_eq!(status, StatusCode::OK, "{page}");
        assert_eq!(page["total"], 1, "{page}");
        let item = &page["items"][0]["item"];
        assert_eq!(item["shiftAvailable"], false);
        assert_eq!(item["boxAvailable"], false);
        assert_eq!(item["boxId"], owner["boxId"]);
        for field in [
            "canonical",
            "gtin14",
            "serial",
            "productionDate",
            "productName",
            "lineName",
        ] {
            assert!(item[field].is_null(), "{field}: {item}");
        }
    }
    let (_, page) = a
        .call(
            "GET",
            &format!(
                "/v1/office/code-registry?codeHash={}&gtin=04600682000013",
                owner["hash"].as_str().unwrap()
            ),
            None,
        )
        .await;
    assert_eq!(page["total"], 0);
}

#[tokio::test]
async fn every_cloud_driver_uses_fact_indexes_including_sscc_membership() {
    let a = support::app::admin().await;
    for owner in [false, true] {
        for driver in ["code", "gtin", "shift", "sscc", "period"] {
            if owner && driver == "gtin" {
                continue;
            }
            let sql=format!("EXPLAIN QUERY PLAN WITH parameters AS (SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11) {}",markiro_host::routes::office_codes::registry::cloud_match_sql(owner,driver));
            let plan: Vec<(i64, i64, i64, String)> = sqlx::query_as(&sql)
                .bind("a".repeat(64))
                .bind("04600682000013")
                .bind(Option::<String>::None)
                .bind(Option::<String>::None)
                .bind(Option::<String>::None)
                .bind("2024-01-01T00:00:00.000Z")
                .bind("2026-12-01T00:00:00.000Z")
                .bind(0)
                .bind(0)
                .bind("OCT26-007/S")
                .bind("046006820000015000")
                .fetch_all(&a.app.state.pool)
                .await
                .unwrap();
            let steps: Vec<_> = plan.into_iter().map(|(_, _, _, step)| step).collect();
            for table in ["c", "o", "i", "b"] {
                assert!(
                    !steps
                        .iter()
                        .any(|s| s.starts_with(&format!("SCAN {table} "))
                            || s == &format!("SCAN {table}")),
                    "{owner} {driver}: {steps:?}"
                );
            }
        }
    }
}

#[tokio::test]
async fn criteria_resolve_each_source_independently_and_compare_original_instants() {
    let (a, r) = history::setup(true).await;
    let code = &r["part"]["payload"]["codes"][0];
    let shift = r["part"]["payload"]["shifts"][0]["number"]
        .as_str()
        .unwrap();
    let sscc = r["part"]["payload"]["boxes"][0]["sscc"].as_str().unwrap();
    for query in [
        format!("shift={shift}"),
        format!("sscc={sscc}"),
        format!("gtin={}", code["gtin14"].as_str().unwrap()),
        format!(
            "shift={shift}&sscc={sscc}&gtin={}&codeHash={}",
            code["gtin14"].as_str().unwrap(),
            code["hash"].as_str().unwrap()
        ),
    ] {
        let (status, page) = a
            .call("GET", &format!("/v1/office/code-registry?{query}"), None)
            .await;
        assert_eq!(status, StatusCode::OK, "{page}");
        assert!(page["total"].as_u64().unwrap() > 0, "{query}: {page}");
    }
    sqlx::query("UPDATE cloud_history_codes SET scanned_at='2024-01-02T13:00:00+03:00'")
        .execute(&a.app.state.pool)
        .await
        .unwrap();
    let (_, page) = a
        .call(
            "GET",
            "/v1/office/code-registry?fromMs=1704189600000&toMs=1704189600001",
            None,
        )
        .await;
    assert_eq!(page["total"], 2, "{page}");
}

#[tokio::test]
async fn mixed_pages_are_stable_compact_and_capped_globally() {
    use support::app::*;
    let (a, _) = history::setup(true).await;
    sqlx::query("UPDATE products SET archived=1")
        .execute(&a.app.state.pool)
        .await
        .unwrap();
    let setup = shift_setup(&a).await;
    let floor = open_floor(&a, &setup, &a.key, &setup.line).await;
    let records: Vec<_> = (1..=55)
        .map(|n| {
            fact(
                &record_id(n),
                "scan",
                &floor.shift,
                ok_scan(n, &box_id(1), &instant(10, 0)),
            )
        })
        .collect();
    assert!(receipts(&a.app, &floor.key, &records)
        .await
        .iter()
        .all(|r| r["outcome"] == "accepted"));
    sqlx::query("UPDATE cloud_history_codes SET scanned_at=?")
        .bind(instant(10, 0))
        .execute(&a.app.state.pool)
        .await
        .unwrap();
    let mut keys = Vec::new();
    for page in 1..=2 {
        let (status, p) = a
            .call(
                "GET",
                &format!("/v1/office/code-registry?fromMs=1&page={page}"),
                None,
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{p}");
        assert_eq!(p["total"], 57);
        assert_eq!(
            p["items"].as_array().unwrap().len(),
            if page == 1 { 50 } else { 7 }
        );
        for row in p["items"].as_array().unwrap() {
            keys.push(format!(
                "{}:{}",
                row["source"],
                row["item"]["scanId"]
                    .as_str()
                    .or_else(|| row["item"]["id"].as_str())
                    .unwrap()
            ));
        }
        assert_eq!(
            a.call(
                "GET",
                &format!("/v1/office/code-registry?fromMs=1&page={page}"),
                None
            )
            .await
            .1,
            p
        );
    }
    let unique = keys.iter().collect::<std::collections::HashSet<_>>();
    assert_eq!(unique.len(), 57);
    sqlx::query("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<10010) INSERT INTO cloud_history_codes(batch_id,shift_id,hash,canonical,scanned_at,gtin14,serial,flat_only) SELECT c.batch_id,c.shift_id,printf('%064x',n.x+100000),'opaque',c.scanned_at,c.gtin14,NULL,1 FROM n CROSS JOIN (SELECT * FROM cloud_history_codes LIMIT 1)c").execute(&a.app.state.pool).await.unwrap();
    let (status, p) = a
        .call("GET", "/v1/office/code-registry?fromMs=1&page=200", None)
        .await;
    assert_eq!(status, StatusCode::OK, "{p}");
    assert_eq!(p["total"], 10000);
    assert_eq!(p["capped"], true);
    assert_eq!(p["pageCount"], 200);
    assert_eq!(p["items"].as_array().unwrap().len(), 50);
}

#[tokio::test]
async fn released_import_and_flat_repeats_never_override_the_new_native_owner() {
    use support::app::*;
    use support::disaggregation::{add, apply, create, line, REASON};
    let mut r = history::request();
    let mut repeated = r["part"]["payload"]["codes"][0].clone();
    repeated["shiftId"] = r["part"]["payload"]["shifts"][1]["id"].clone();
    repeated["flatOnly"] = json!(true);
    r["part"]["payload"]["codes"]
        .as_array_mut()
        .unwrap()
        .push(repeated);
    history::seal(&mut r);
    let (a, r) = history::setup_request(r, true).await;
    let hash = r["part"]["payload"]["codes"][0]["hash"].as_str().unwrap();
    sqlx::query("UPDATE products SET archived=1")
        .execute(&a.app.state.pool)
        .await
        .unwrap();
    let setup = shift_setup(&a).await;
    let floor = open_floor(&a, &setup, &a.key, &setup.line).await;
    let mut scan = ok_scan(800, &box_id(800), &instant(20, 0));
    scan["code"]["codeHash"] = json!(hash);
    let duplicate = fact(&record_id(800), "scan", &floor.shift, scan.clone());
    assert_eq!(
        receipts(&a.app, &floor.key, &[duplicate]).await[0]["outcome"],
        "conflict"
    );
    let (_, card) = a
        .call(
            "GET",
            &format!("/v1/office/code-registry/{hash}?source=local"),
            None,
        )
        .await;
    assert!(card["local"]["ownerScanId"].is_null());
    assert_eq!(card["currentOwner"]["source"], "cloud");
    let sscc = r["part"]["payload"]["boxes"][0]["sscc"].as_str().unwrap();
    let doc = create(&a, json!({"reasonId":REASON})).await;
    let (_, detail) = add(
        &a,
        doc["document"]["id"].as_str().unwrap(),
        json!([line(sscc, Some(sscc))]),
    )
    .await;
    assert_eq!(apply(&a, &detail).await.0, StatusCode::OK);
    scan["scannedAt"] = json!(instant(21, 0));
    let accepted = fact(&record_id(801), "scan", &floor.shift, scan);
    assert_eq!(
        receipts(&a.app, &floor.key, &[accepted]).await[0]["outcome"],
        "accepted"
    );
    let (status, card) = a
        .call(
            "GET",
            &format!("/v1/office/code-registry/{hash}?source=cloud"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{card}");
    assert_eq!(card["currentOwner"]["source"], "local");
    let states: Vec<_> = card["cloud"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x["state"].as_str().unwrap())
        .collect();
    assert_eq!(states.len(), 2);
    assert!(states.contains(&"released"));
    assert!(states.contains(&"historical"));
}

#[tokio::test]
async fn registry_validates_criteria_and_preserves_office_authentication() {
    use support::app::*;
    let (a, r) = history::setup(true).await;
    let hash = r["part"]["payload"]["codes"][0]["hash"].as_str().unwrap();
    for query in [
        "source=invalid&fromMs=1",
        "source=all",
        "gtin=abc",
        "sscc=123",
        "shift=BAD",
        "codeHash=ABC",
        "fromMs=2&toMs=1",
        "fromMs=1&page=201",
        "fromMs=1&extra=1",
    ] {
        assert_eq!(
            a.call("GET", &format!("/v1/office/code-registry?{query}"), None)
                .await
                .0,
            StatusCode::BAD_REQUEST,
            "{query}"
        );
    }
    let tech = a.technologist().await;
    for path in [
        "/v1/office/code-registry?fromMs=1".to_owned(),
        format!("/v1/office/code-registry/{hash}"),
    ] {
        assert_eq!(a.call_as(&tech, "GET", &path, None).await.0, StatusCode::OK);
        assert_eq!(
            a.app
                .send(empty(with_device(request("GET", &path), &a.key)))
                .await
                .0,
            StatusCode::UNAUTHORIZED
        );
        let handheld = pair_handheld(&a).await;
        assert_eq!(
            a.app
                .send(empty(with_session(request("GET", &path), &handheld, &tech)))
                .await
                .0,
            StatusCode::FORBIDDEN
        );
    }
}

#[tokio::test]
async fn cloud_shift_numbers_accept_unpadded_sequences_and_card_filters_keep_global_owner() {
    let (a, r) = history::setup(true).await;
    let hash = r["part"]["payload"]["codes"][0]["hash"].as_str().unwrap();
    let (_, p) = a
        .call("GET", "/v1/office/code-registry?shift=OCT26-7/S", None)
        .await;
    assert_eq!(p["total"], 1, "{p}");
    let (_, card) = a
        .call(
            "GET",
            &format!("/v1/office/code-registry/{hash}?source=local"),
            None,
        )
        .await;
    assert_eq!(card["cloud"], json!([]));
    assert_eq!(card["currentOwner"]["source"], "cloud");
}

#[tokio::test]
async fn card_caps_cloud_history_without_losing_an_owner_outside_the_window() {
    let (a, r) = history::setup(true).await;
    let hash = r["part"]["payload"]["codes"][0]["hash"].as_str().unwrap();
    sqlx::query("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1001) INSERT INTO cloud_history_shifts(id,batch_id,number,mode,production_date,closed_at,product_id,gtin14,in_window,shelf_life_days,source_json) SELECT printf('70000000-0000-4000-8000-%012d',n.x),s.batch_id,printf('NOV26-%06d',n.x),s.mode,s.production_date,s.closed_at,s.product_id,s.gtin14,s.in_window,s.shelf_life_days,s.source_json FROM n CROSS JOIN (SELECT * FROM cloud_history_shifts LIMIT 1)s").execute(&a.app.state.pool).await.unwrap();
    sqlx::query("INSERT INTO cloud_history_codes(batch_id,shift_id,hash,canonical,scanned_at,gtin14,serial,flat_only) SELECT s.batch_id,s.id,c.hash,c.canonical,'2026-11-01T00:00:00Z',c.gtin14,c.serial,1 FROM cloud_history_shifts s CROSS JOIN (SELECT * FROM cloud_history_codes WHERE hash=? LIMIT 1)c WHERE s.id LIKE '70000000-%'").bind(hash).execute(&a.app.state.pool).await.unwrap();
    let (status, card) = a
        .call("GET", &format!("/v1/office/code-registry/{hash}"), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{card}");
    assert_eq!(card["cloudCapped"], true);
    assert_eq!(card["cloud"].as_array().unwrap().len(), 1000);
    assert!(card["cloud"]
        .as_array()
        .unwrap()
        .iter()
        .all(|i| i["state"] == "historical"));
    assert_eq!(card["currentOwner"]["item"]["state"], "owned");
    assert_eq!(
        card["currentOwner"]["item"]["shiftId"],
        r["part"]["payload"]["codes"][0]["shiftId"]
    );
}

#[tokio::test]
async fn revoked_office_sessions_cannot_read_registry_or_cards() {
    let (a, r) = history::setup(true).await;
    let tech = a.technologist().await;
    assert_eq!(
        a.call_as(&tech, "POST", "/v1/office/logout", None).await.0,
        StatusCode::NO_CONTENT
    );
    let hash = r["part"]["payload"]["codes"][0]["hash"].as_str().unwrap();
    for path in [
        "/v1/office/code-registry?fromMs=1".to_owned(),
        format!("/v1/office/code-registry/{hash}"),
    ] {
        assert_eq!(
            a.call_as(&tech, "GET", &path, None).await.0,
            StatusCode::UNAUTHORIZED
        );
    }
}
