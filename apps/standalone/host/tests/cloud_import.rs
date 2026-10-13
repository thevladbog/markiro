//! `POST /v1/office/import` (plan IMP): the golden file of the export tool
//! moved into a site after the wizard (`support::app::admin`, whose
//! organization has the file's GLN and whose lines include «Линия 1»).

mod support;

use axum::body::Body;
use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{
    add_operator, admin, audit_rows, audit_trail, cloud_import_request, empty, host_revision,
    json as with_body, login, pair_device, plan_shift, request, seed_office_user, shift_body,
    shift_setup, turn_the_user_off_at_the_next_activity, with_device, with_session, Admin,
    IMPORT_ID, LAN,
};

const IMPORT: &str = "/v1/office/import";
const FILE_SALT: &str = "bWFya2lyby1iYWRnZS0wMQ==";

fn fixture(name: &str) -> Value {
    let path = format!("{}/../proto/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

async fn scalar_i64(admin: &Admin, query: &str) -> i64 {
    sqlx::query_scalar(query)
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap()
}

/// How many rows the import writes, table by table; all zero before it.
async fn imported_rows(admin: &Admin) -> [i64; 6] {
    [
        scalar_i64(admin, "SELECT COUNT(*) FROM products").await,
        scalar_i64(admin, "SELECT COUNT(*) FROM operators").await,
        scalar_i64(admin, "SELECT COUNT(*) FROM operator_badges").await,
        scalar_i64(admin, "SELECT COUNT(*) FROM counterparties").await,
        scalar_i64(
            admin,
            "SELECT COUNT(*) FROM label_templates WHERE stock = 0",
        )
        .await,
        scalar_i64(admin, "SELECT COUNT(*) FROM category_template_defaults").await,
    ]
}

async fn site_salt(admin: &Admin) -> String {
    let (status, body) = admin.call("GET", "/v1/office/badge-salt", None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body["badgeSalt"].as_str().unwrap().to_owned()
}

#[tokio::test]
async fn the_import_writes_every_row_at_one_revision_and_writes_one_audit_row() {
    let admin = admin().await;
    let before = host_revision(&admin.app).await;
    let mut wake = admin.app.state.revisions.subscribe();
    assert!(!wake.has_changed().unwrap());

    let (status, summary) = admin
        .call("POST", IMPORT, Some(cloud_import_request(IMPORT_ID, false)))
        .await;
    assert_eq!(status, StatusCode::OK, "{summary}");
    assert_eq!(summary, fixture("cloud-import-summary.json"));
    assert_eq!(host_revision(&admin.app).await, before + 1);
    assert!(wake.has_changed().unwrap(), "the import wakes the streams");
    assert_eq!(*wake.borrow_and_update(), before + 1);
    assert_eq!(
        audit_trail(&admin.app, "import.cloud").await,
        [admin.row(
            "import.cloud",
            "site",
            "1",
            json!({
                "importId": IMPORT_ID,
                "exportedAt": "2026-10-09T18:30:00.000Z",
                "rehearsal": false,
                "sourceTenantId": "imp-test-atoll",
                "summary": fixture("cloud-import-summary.json"),
            }),
        )]
    );
    assert_eq!(imported_rows(&admin).await, [3, 3, 3, 2, 5, 2]);
    assert_eq!(site_salt(&admin).await, FILE_SALT);

    let (_, lines) = admin.call("GET", "/v1/office/lines", None).await;
    let mut names: Vec<&str> = lines
        .as_array()
        .unwrap()
        .iter()
        .map(|line| line["name"].as_str().unwrap())
        .collect();
    names.sort_unstable();
    assert_eq!(names, ["Линия 1", "Линия 2", "Упаковка", "линия 1 (2)"]);

    let (_, defaults) = admin
        .call("GET", "/v1/office/template-defaults", None)
        .await;
    assert_eq!(
        (
            defaults["defaultBoxTemplateId"].clone(),
            defaults["defaultPalletTemplateId"].clone(),
            defaults["categories"].clone(),
        ),
        (
            json!("0d0d0000-0000-4000-8000-000000000001"),
            json!("0d0d0000-0000-4000-8000-000000000003"),
            json!([
                { "chzProductGroupCode": 8, "purpose": "box", "templateId": "0d0d0000-0000-4000-8000-000000000002" },
                { "chzProductGroupCode": 8, "purpose": "pallet", "templateId": "0d0d0000-0000-4000-8000-000000000003" },
            ]),
        )
    );

    let (_, operators) = admin.call("GET", "/v1/office/operators", None).await;
    assert_eq!(
        operators
            .as_array()
            .unwrap()
            .iter()
            .map(|operator| (
                operator["login"].as_str().unwrap(),
                operator["active"].as_bool().unwrap(),
                operator["badges"].as_array().unwrap().len(),
            ))
            .collect::<Vec<_>>(),
        [("0042", true, 2), ("117", false, 1), ("205", false, 0)]
    );

    let months: Vec<(String, i64)> =
        sqlx::query_as("SELECT month_key, last_seq FROM shift_number_counters ORDER BY month_key")
            .fetch_all(&admin.app.state.pool)
            .await
            .unwrap();
    assert_eq!(
        months,
        [
            ("NOV26".to_owned(), 1),
            ("OCT26".to_owned(), 7),
            ("SEP26".to_owned(), 41)
        ]
    );
}

/// The PIN hash and the badge hashes moved as they were: the operator signs
/// in with the cloud's PIN, and a badge code hashed under the site's salt
/// finds its badge (spec §8.3).
#[tokio::test]
async fn an_imported_operator_keeps_the_clouds_pin_and_badges() {
    let admin = admin().await;
    let (status, body) = admin
        .call("POST", IMPORT, Some(cloud_import_request(IMPORT_ID, false)))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let pin: String = sqlx::query_scalar("SELECT pin_phc FROM operators WHERE login = '0042'")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    assert!(markiro_host::secrets::verify_password(&pin, "4821"));
    let badges: Vec<String> = sqlx::query_scalar(
        "SELECT badge_phc FROM operator_badges WHERE revoked_at IS NULL ORDER BY id",
    )
    .fetch_all(&admin.app.state.pool)
    .await
    .unwrap();
    for (phc, code) in badges
        .iter()
        .zip(["MRK-000742", "MRK-000743", "MRK-000744"])
    {
        assert!(markiro_host::secrets::verify_password(phc, code), "{code}");
        assert_eq!(
            markiro_host::secrets::parse_phc(phc).unwrap().salt(),
            b"markiro-badge-01"
        );
    }
}

#[tokio::test]
async fn the_feed_carries_every_imported_record_at_the_import_revision() {
    let admin = admin().await;
    let before = host_revision(&admin.app).await;
    let (status, body) = admin
        .call("POST", IMPORT, Some(cloud_import_request(IMPORT_ID, false)))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let items = admin.feed(before).await;
    let mut keys: Vec<(String, String, i64, bool)> = items
        .as_array()
        .unwrap()
        .iter()
        .map(|item| {
            (
                item["entity"].as_str().unwrap().to_owned(),
                item["id"].as_str().unwrap().to_owned(),
                item["rev"].as_i64().unwrap(),
                item["deleted"].as_bool().unwrap(),
            )
        })
        .collect();
    keys.sort();
    let at = |entity: &str, id: &str| (entity.to_owned(), id.to_owned(), before + 1, false);
    let mut expected = vec![
        at("category_template_defaults", "8:box"),
        at("category_template_defaults", "8:pallet"),
        at("label_templates", "0d0d0000-0000-4000-8000-000000000001"),
        at("label_templates", "0d0d0000-0000-4000-8000-000000000002"),
        at("label_templates", "0d0d0000-0000-4000-8000-000000000003"),
        at("label_templates", "0d0d0000-0000-4000-8000-000000000004"),
        at("label_templates", "0d0d0000-0000-4000-8000-000000000005"),
        at("lines", "0a0a0000-0000-4000-8000-000000000002"),
        at("lines", "0a0a0000-0000-4000-8000-000000000003"),
        at("operator_badges", "0b0b0000-0000-4000-8000-000000000001"),
        at("operator_badges", "0b0b0000-0000-4000-8000-000000000002"),
        at("operator_badges", "0b0b0000-0000-4000-8000-000000000003"),
        // Only the active operator: the feed leaves turned-off ones out.
        at("operators", "0f0f0000-0000-4000-8000-000000000001"),
        at("org_profile", "1"),
        at("products", "0e0e0000-0000-4000-8000-000000000001"),
        at("products", "0e0e0000-0000-4000-8000-000000000002"),
        at("products", "0e0e0000-0000-4000-8000-000000000003"),
        at("site", "1"),
    ];
    expected.sort();
    assert_eq!(keys, expected);
    let site = items
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["entity"] == "site")
        .unwrap();
    assert_eq!(site["data"]["badgeSalt"], FILE_SALT);
}

#[tokio::test]
async fn a_dry_run_checks_everything_and_writes_nothing() {
    let admin = admin().await;
    let before = host_revision(&admin.app).await;
    let salt = site_salt(&admin).await;
    let audits = audit_rows(&admin.app).await;
    let wake = admin.app.state.revisions.subscribe();

    let (status, summary) = admin
        .call("POST", IMPORT, Some(cloud_import_request(IMPORT_ID, true)))
        .await;
    assert_eq!(status, StatusCode::OK, "{summary}");
    let mut expected = fixture("cloud-import-summary.json");
    expected["dryRun"] = json!(true);
    assert_eq!(summary, expected);
    assert_eq!(host_revision(&admin.app).await, before);
    assert!(!wake.has_changed().unwrap(), "a dry run wakes nobody");
    assert_eq!(audit_rows(&admin.app).await, audits);
    assert_eq!(imported_rows(&admin).await, [0; 6]);
    assert_eq!(site_salt(&admin).await, salt);
    assert_eq!(
        scalar_i64(&admin, "SELECT COUNT(*) FROM shift_number_counters").await,
        0
    );

    // A dry run is no import: the same id imports afterwards.
    let (status, summary) = admin
        .call("POST", IMPORT, Some(cloud_import_request(IMPORT_ID, false)))
        .await;
    assert_eq!(status, StatusCode::OK, "{summary}");
    assert_eq!(summary, fixture("cloud-import-summary.json"));
}

#[tokio::test]
async fn the_same_import_again_answers_its_summary_and_another_is_refused() {
    let admin = admin().await;
    let (status, first) = admin
        .call("POST", IMPORT, Some(cloud_import_request(IMPORT_ID, false)))
        .await;
    assert_eq!(status, StatusCode::OK, "{first}");
    let after = host_revision(&admin.app).await;
    let audits = audit_rows(&admin.app).await;
    let wake = admin.app.state.revisions.subscribe();

    let (status, again) = admin
        .call("POST", IMPORT, Some(cloud_import_request(IMPORT_ID, false)))
        .await;
    assert_eq!(status, StatusCode::OK, "{again}");
    let mut expected = fixture("cloud-import-summary.json");
    expected["repeated"] = json!(true);
    assert_eq!(again, expected);
    assert_eq!(host_revision(&admin.app).await, after);
    assert_eq!(audit_rows(&admin.app).await, audits);
    assert!(!wake.has_changed().unwrap());

    // A dry run of an import already done is no dry run: it answers what the
    // import did, marked as a repeat.
    let (status, dry) = admin
        .call("POST", IMPORT, Some(cloud_import_request(IMPORT_ID, true)))
        .await;
    assert_eq!(status, StatusCode::OK, "{dry}");
    assert_eq!(dry, expected);
    assert_eq!(host_revision(&admin.app).await, after);
    assert_eq!(audit_rows(&admin.app).await, audits);

    let imported_at: String =
        sqlx::query_scalar("SELECT at FROM audit_log WHERE action = 'import.cloud'")
            .fetch_one(&admin.app.state.pool)
            .await
            .unwrap();
    let other = "5f2b8c1e-9a7d-4e3f-8b6a-0c1d2e3f4a5b";
    for dry_run in [false, true] {
        let (status, error) = admin
            .call("POST", IMPORT, Some(cloud_import_request(other, dry_run)))
            .await;
        assert_eq!(status, StatusCode::CONFLICT, "{error}");
        assert_eq!(error["error"]["code"], "conflict");
        assert_eq!(
            error["error"]["details"],
            json!({ "constraint": "already_imported", "importedAt": imported_at })
        );
    }
    assert_eq!(host_revision(&admin.app).await, after);
    assert_eq!(audit_rows(&admin.app).await, audits);
}

#[tokio::test]
async fn a_site_that_holds_data_is_refused_and_named() {
    for entity in [
        "shifts",
        "sscc_blocks",
        "category_template_defaults",
        "products",
        "label_templates",
        "employees",
        "operators",
        "counterparties",
    ] {
        let admin = admin().await;
        let pool = &admin.app.state.pool;
        match entity {
            "shifts" => {
                let setup = shift_setup(&admin).await;
                plan_shift(&admin, shift_body(&setup)).await;
            }
            "sscc_blocks" => {
                sqlx::query(
                    "INSERT INTO sscc_blocks (id, issuer_prefix, extension, device_id, request_id, \
                     from_serial, to_serial, issued_at) SELECT 'b1', '460068200', 0, id, 'r1', 1500, 3499, \
                     '2026-10-09T00:00:00Z' FROM devices LIMIT 1",
                )
                .execute(pool)
                .await
                .unwrap();
            }
            "category_template_defaults" => {
                sqlx::query(
                    "INSERT INTO label_templates (id, name, purpose, enabled, category_codes, spec, stock, rev) \
                     VALUES ('stock-1', 'Типовой', 'box', 1, NULL, '{}', 1, 1)",
                )
                .execute(pool)
                .await
                .unwrap();
                sqlx::query(
                    "INSERT INTO category_template_defaults (chz_group_code, purpose, template_id, rev) \
                     VALUES (8, 'box', 'stock-1', 1)",
                )
                .execute(pool)
                .await
                .unwrap();
            }
            "products" => {
                let (status, body) = admin
                    .call(
                        "POST",
                        "/v1/office/products",
                        Some(json!({ "gtin14": "04600682000099", "name": "Сметана" })),
                    )
                    .await;
                assert_eq!(status, StatusCode::OK, "{body}");
            }
            "label_templates" => {
                let (status, body) = admin
                    .call(
                        "POST",
                        "/v1/office/templates",
                        Some(json!({ "name": "Свой", "purpose": "box", "enabled": true, "spec": {} })),
                    )
                    .await;
                assert_eq!(status, StatusCode::OK, "{body}");
            }
            "operators" => {
                add_operator(&admin, "777").await;
            }
            "employees" => {
                let (status, body) = admin
                    .call(
                        "POST",
                        "/v1/office/employees",
                        Some(json!({ "name": "Анна Кузнецова" })),
                    )
                    .await;
                assert_eq!(status, StatusCode::OK, "{body}");
            }
            _ => {
                let (status, body) = admin
                    .call(
                        "POST",
                        "/v1/office/counterparties",
                        Some(json!({ "name": "ООО «Ранний»", "gln": "4601234000017", "gs1Prefixes": [] })),
                    )
                    .await;
                assert_eq!(status, StatusCode::OK, "{body}");
            }
        }
        let before = host_revision(&admin.app).await;
        let audits = audit_rows(&admin.app).await;
        let (status, error) = admin
            .call("POST", IMPORT, Some(cloud_import_request(IMPORT_ID, true)))
            .await;
        assert_eq!(status, StatusCode::CONFLICT, "{entity}: {error}");
        assert_eq!(
            error["error"]["details"],
            json!({ "constraint": "site_not_empty", "entity": entity }),
            "{entity}"
        );
        assert_eq!(host_revision(&admin.app).await, before, "{entity}");
        assert_eq!(audit_rows(&admin.app).await, audits, "{entity}");
        assert_eq!(
            scalar_i64(&admin, "SELECT COUNT(*) FROM operator_badges").await,
            0,
            "{entity}"
        );
    }
}

#[tokio::test]
async fn the_organization_must_have_the_files_gln() {
    let admin = admin().await;
    let (_, org) = admin.call("GET", "/v1/office/org", None).await;
    let (status, body) = admin
        .call(
            "PUT",
            "/v1/office/org",
            Some(json!({
                "name": org["name"], "inn": org["inn"], "gln": "4600682000027",
                "gs1Prefixes": org["gs1Prefixes"], "timeZone": org["timeZone"], "expectedRev": org["rev"],
            })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let before = host_revision(&admin.app).await;
    let (status, error) = admin
        .call("POST", IMPORT, Some(cloud_import_request(IMPORT_ID, false)))
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{error}");
    assert_eq!(
        error["error"]["details"],
        json!({ "constraint": "org_gln", "siteGln": "4600682000027", "fileGln": "4600682000010" })
    );
    assert_eq!(host_revision(&admin.app).await, before);
    assert_eq!(imported_rows(&admin).await, [0; 6]);
}

#[tokio::test]
async fn counters_only_move_forward() {
    let admin = admin().await;
    let (_, sscc) = admin.call("GET", "/v1/office/sscc", None).await;
    let rev = sscc["counters"]
        .as_array()
        .unwrap()
        .iter()
        .find(|counter| counter["extension"] == 0)
        .unwrap()["rev"]
        .clone();
    let (status, body) = admin
        .call(
            "PUT",
            "/v1/office/sscc/counters/460068200/0",
            Some(json!({ "nextSerial": 50_000, "expectedRev": rev })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let moved_rev = scalar_i64(
        &admin,
        "SELECT rev FROM sscc_counters WHERE issuer_prefix = '460068200' AND extension = 0",
    )
    .await;
    sqlx::query("INSERT INTO shift_number_counters (month_key, last_seq) VALUES ('OCT26', 9)")
        .execute(&admin.app.state.pool)
        .await
        .unwrap();

    let (status, summary) = admin
        .call("POST", IMPORT, Some(cloud_import_request(IMPORT_ID, false)))
        .await;
    assert_eq!(status, StatusCode::OK, "{summary}");
    assert_eq!(
        summary["ssccCounters"],
        json!([
            { "issuerPrefix": "460068200", "extension": 0, "nextSerial": 50_000 },
            { "issuerPrefix": "460068200", "extension": 1, "nextSerial": 10_000 },
            { "issuerPrefix": "460123400", "extension": 0, "nextSerial": 1 },
            { "issuerPrefix": "460999900", "extension": 0, "nextSerial": 10_000 },
        ])
    );
    assert_eq!(
        summary["shiftNumberCounters"],
        json!([
            { "monthKey": "NOV26", "lastSeq": 1 },
            { "monthKey": "OCT26", "lastSeq": 9 },
            { "monthKey": "SEP26", "lastSeq": 41 },
        ])
    );
    // A counter the import raised carries the import's revision (a form read
    // before the import is then stale); the one it kept keeps its own.
    let import_rev = host_revision(&admin.app).await;
    let revs: Vec<(String, i64, i64)> =
        sqlx::query_as("SELECT issuer_prefix, extension, rev FROM sscc_counters ORDER BY 1, 2")
            .fetch_all(&admin.app.state.pool)
            .await
            .unwrap();
    assert_eq!(
        revs,
        [
            ("460068200".to_owned(), 0, moved_rev),
            ("460068200".to_owned(), 1, import_rev),
            ("460123400".to_owned(), 0, import_rev),
            ("460999900".to_owned(), 0, import_rev),
        ]
    );
    let (_, sscc) = admin.call("GET", "/v1/office/sscc", None).await;
    let stands: Vec<(String, u64, u64)> = sscc["counters"]
        .as_array()
        .unwrap()
        .iter()
        .map(|counter| {
            (
                counter["issuerPrefix"].as_str().unwrap().to_owned(),
                counter["extension"].as_u64().unwrap(),
                counter["nextSerial"].as_u64().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        stands,
        [
            ("460068200".to_owned(), 0, 50_000),
            ("460068200".to_owned(), 1, 10_000),
            ("460123400".to_owned(), 0, 1),
            ("460999900".to_owned(), 0, 10_000),
        ]
    );
}

/// The forward-only boundary of the import's SSCC counters: a site counter
/// equal to the file's start is left as it is (value and revision), and one
/// a single serial above the file's start is never lowered by one.
#[tokio::test]
async fn a_counter_at_or_one_above_the_files_start_is_kept_with_its_revision() {
    let admin = admin().await;
    // The file starts boxes at 30 000 and pallets at 10 000.
    for (extension, next) in [(0, 30_000), (1, 10_001)] {
        let (_, sscc) = admin.call("GET", "/v1/office/sscc", None).await;
        let rev = sscc["counters"]
            .as_array()
            .unwrap()
            .iter()
            .find(|counter| {
                counter["issuerPrefix"] == "460068200" && counter["extension"] == extension
            })
            .unwrap()["rev"]
            .clone();
        let (status, body) = admin
            .call(
                "PUT",
                &format!("/v1/office/sscc/counters/460068200/{extension}"),
                Some(json!({ "nextSerial": next, "expectedRev": rev })),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
    }
    let before: Vec<(i64, i64, i64)> = sqlx::query_as(
        "SELECT extension, next_serial, rev FROM sscc_counters \
         WHERE issuer_prefix = '460068200' ORDER BY extension",
    )
    .fetch_all(&admin.app.state.pool)
    .await
    .unwrap();
    assert_eq!(
        before.iter().map(|row| (row.0, row.1)).collect::<Vec<_>>(),
        [(0, 30_000), (1, 10_001)]
    );

    let (status, summary) = admin
        .call("POST", IMPORT, Some(cloud_import_request(IMPORT_ID, false)))
        .await;
    assert_eq!(status, StatusCode::OK, "{summary}");
    assert_eq!(
        summary["ssccCounters"][0],
        json!({ "issuerPrefix": "460068200", "extension": 0, "nextSerial": 30_000 })
    );
    assert_eq!(
        summary["ssccCounters"][1],
        json!({ "issuerPrefix": "460068200", "extension": 1, "nextSerial": 10_001 })
    );
    let after: Vec<(i64, i64, i64)> = sqlx::query_as(
        "SELECT extension, next_serial, rev FROM sscc_counters \
         WHERE issuer_prefix = '460068200' ORDER BY extension",
    )
    .fetch_all(&admin.app.state.pool)
    .await
    .unwrap();
    assert_eq!(after, before, "the import rewrote a counter it had to keep");
}

#[tokio::test]
async fn only_an_administrator_imports_and_the_role_is_read_again_in_the_write() {
    let admin = admin().await;
    let tech = admin.technologist().await;
    let (status, error) = admin
        .call_as(
            &tech,
            "POST",
            IMPORT,
            Some(cloud_import_request(IMPORT_ID, false)),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{error}");
    // The refusal comes before the file is looked at: a technologist learns
    // nothing about the file's rows.
    let mut invalid = cloud_import_request(IMPORT_ID, false);
    invalid["importId"] = json!("not-a-uuid");
    let (status, error) = admin.call_as(&tech, "POST", IMPORT, Some(invalid)).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{error}");

    let second = seed_office_user(&admin.app, "admin2", "admin", "second admin password").await;
    let token = login(&admin.app, &admin.key, "admin2", "second admin password").await;
    turn_the_user_off_at_the_next_activity(&admin.app, &second).await;
    admin.app.clock.advance(time::Duration::minutes(2));
    let before = host_revision(&admin.app).await;
    let (status, error) = admin
        .call_as(
            &token,
            "POST",
            IMPORT,
            Some(cloud_import_request(IMPORT_ID, false)),
        )
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{error}");
    assert_eq!(error["error"]["details"]["credential"], "session");
    assert_eq!(host_revision(&admin.app).await, before);
    assert_eq!(imported_rows(&admin).await, [0; 6]);
    assert!(audit_trail(&admin.app, "import.cloud").await.is_empty());
}

#[tokio::test]
async fn a_row_the_database_refuses_refuses_the_whole_import() {
    let admin = admin().await;
    let before = host_revision(&admin.app).await;
    for (pointer, value, field) in [
        // 18 is no ЧЗ product group (the cloud's list skips it).
        (
            "/payload/templates/1/chzProductGroupCodes",
            json!([18]),
            "payload.templates.1.chzProductGroupCodes",
        ),
        (
            "/payload/products/1/chzProductGroupCode",
            json!(99),
            "payload.products.1.chzProductGroupCode",
        ),
    ] {
        let mut body = cloud_import_request(IMPORT_ID, false);
        *body.pointer_mut(pointer).unwrap() = value;
        if field.starts_with("payload.templates") {
            // Keep the category default on T2 valid for the file's rules.
            body["payload"]["templateDefaults"]["categories"] = json!([]);
        }
        let (status, error) = admin.call("POST", IMPORT, Some(body)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{error}");
        assert_eq!(error["error"]["code"], "validation_failed");
        assert_eq!(error["error"]["details"]["field"], field);
    }
    assert_eq!(host_revision(&admin.app).await, before);
    assert_eq!(imported_rows(&admin).await, [0; 6]);
}

#[tokio::test]
async fn the_route_takes_a_body_past_axums_default_up_to_32_mib() {
    let admin = admin().await;
    let mut body = cloud_import_request(IMPORT_ID, true);
    let templates = body["payload"]["templates"].as_array_mut().unwrap();
    for index in 0..12 {
        templates.push(json!({
            "id": format!("0d0d0000-0000-4000-8000-0000000001{index:02}"),
            "name": format!("Большой {index}"),
            "purpose": "box",
            "enabled": true,
            "chzProductGroupCodes": null,
            "spec": { "widthMm": 58, "text": "я".repeat(120_000) },
        }));
    }
    assert!(body.to_string().len() > 2 * 1024 * 1024);
    let (status, summary) = admin.call("POST", IMPORT, Some(body)).await;
    assert_eq!(status, StatusCode::OK, "{summary}");
    assert_eq!(summary["templates"], 17);

    let mut huge = cloud_import_request(IMPORT_ID, true);
    huge["source"]["tenantName"] = json!("я".repeat(17 * 1024 * 1024));
    let (status, error) = admin.call("POST", IMPORT, Some(huge)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{error}");
    assert_eq!(error["error"]["code"], "validation_failed");
    assert_eq!(error["error"]["details"], Value::Null);
    assert_eq!(
        error["error"]["message"],
        "the body could not be read or is larger than 32 MiB"
    );
}

/// Nothing the import writes, and nothing it logs, appears after a refused
/// call: the revision, the rows, the salt and the audit trail as they were.
async fn assert_untouched(admin: &Admin, label: &str, before: i64, audits: i64, salt: &str) {
    assert_eq!(host_revision(&admin.app).await, before, "{label}");
    assert_eq!(imported_rows(admin).await, [0; 6], "{label}");
    assert_eq!(audit_rows(&admin.app).await, audits, "{label}");
    assert_eq!(site_salt(admin).await, salt, "{label}");
}

/// A handheld paired with a code from the office (it cannot pair locally);
/// returns its key.
async fn pair_handheld(admin: &Admin) -> String {
    let (status, code) = admin.call("POST", "/v1/office/pairing-codes", None).await;
    assert_eq!(status, StatusCode::OK, "{code}");
    let (status, claimed) = admin
        .app
        .send_from(
            LAN,
            with_body(
                request("POST", "/v1/pairing/claim"),
                json!({ "code": code["code"], "kind": "handheld", "name": "ТСД 1", "appVersion": "1.2.0", "capabilities": ["scanner"] }),
            ),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{claimed}");
    claimed["deviceKey"].as_str().unwrap().to_owned()
}

/// Only a signed-in office session of the very device the request comes
/// from reaches the route: no key, a wrong key, a station or a handheld key
/// without a session, and the administrator's token on another device are
/// all refused before anything is read.
#[tokio::test]
async fn nobody_without_an_office_session_of_their_own_device_imports() {
    let admin = admin().await;
    let handheld = pair_handheld(&admin).await;
    let (_, other_station) = pair_device(&admin.app, "station").await;
    let before = host_revision(&admin.app).await;
    let audits = audit_rows(&admin.app).await;
    let salt = site_salt(&admin).await;
    let body = || cloud_import_request(IMPORT_ID, false);

    let attempts = [
        (
            "no credentials",
            with_body(request("POST", IMPORT), body()),
            "device",
        ),
        (
            "an unknown device key",
            with_body(
                with_device(request("POST", IMPORT), "not-a-device-key"),
                body(),
            ),
            "device",
        ),
        (
            "the station's key without a session",
            with_body(with_device(request("POST", IMPORT), &admin.key), body()),
            "session",
        ),
        (
            "a handheld's key without a session",
            with_body(with_device(request("POST", IMPORT), &handheld), body()),
            "session",
        ),
        (
            "a handheld with the administrator's token",
            with_body(
                with_session(request("POST", IMPORT), &handheld, &admin.token),
                body(),
            ),
            "session",
        ),
        (
            "another station with the administrator's token",
            with_body(
                with_session(request("POST", IMPORT), &other_station, &admin.token),
                body(),
            ),
            "session",
        ),
        (
            "the station with a made-up token",
            with_body(
                with_session(request("POST", IMPORT), &admin.key, "not-a-session-token"),
                body(),
            ),
            "session",
        ),
        (
            "no body at all, no credentials",
            empty(request("POST", IMPORT)),
            "device",
        ),
    ];
    for (label, call, credential) in attempts {
        let (status, error) = admin.app.send(call).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{label}: {error}");
        assert_eq!(
            error["error"]["details"]["credential"], credential,
            "{label}"
        );
        assert_untouched(&admin, label, before, audits, &salt).await;
    }
    // A GET is no import either.
    let (status, _) = admin.call("GET", IMPORT, None).await;
    assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
}

/// A write that fails after most rows are in leaves the site as it was, and
/// the same file imports once the cause is gone: the transaction is the only
/// thing between a half-moved site and an empty one.
#[tokio::test]
async fn a_failure_in_the_middle_of_the_write_leaves_the_site_untouched() {
    let admin = admin().await;
    let before = host_revision(&admin.app).await;
    let audits = audit_rows(&admin.app).await;
    let salt = site_salt(&admin).await;
    let (_, lines_before) = admin.call("GET", "/v1/office/lines", None).await;
    let (_, defaults_before) = admin
        .call("GET", "/v1/office/template-defaults", None)
        .await;
    let wake = admin.app.state.revisions.subscribe();
    // Badges are written after the salt, lines, counterparties, templates,
    // defaults, products and operators, and before the counters.
    sqlx::query(
        "CREATE TRIGGER refuse_the_badges BEFORE INSERT ON operator_badges \
         BEGIN SELECT RAISE(ABORT, 'refused'); END",
    )
    .execute(&admin.app.state.pool)
    .await
    .unwrap();

    let (status, error) = admin
        .call("POST", IMPORT, Some(cloud_import_request(IMPORT_ID, false)))
        .await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{error}");
    assert_eq!(error["error"]["code"], "internal");
    assert!(!error.to_string().contains("refused"), "{error}");
    assert_untouched(&admin, "failed write", before, audits, &salt).await;
    assert!(!wake.has_changed().unwrap());
    for table in ["shift_number_counters", "operators"] {
        assert_eq!(
            scalar_i64(&admin, &format!("SELECT COUNT(*) FROM {table}")).await,
            0,
            "{table}"
        );
    }
    let (_, lines) = admin.call("GET", "/v1/office/lines", None).await;
    assert_eq!(lines, lines_before);
    let (_, defaults) = admin
        .call("GET", "/v1/office/template-defaults", None)
        .await;
    assert_eq!(defaults, defaults_before);
    let counters: i64 = scalar_i64(
        &admin,
        "SELECT COUNT(*) FROM sscc_counters WHERE next_serial >= 10000 \
         AND issuer_prefix = '460123400'",
    )
    .await;
    assert_eq!(counters, 0, "no counter of the file stayed");

    sqlx::query("DROP TRIGGER refuse_the_badges")
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    let (status, summary) = admin
        .call("POST", IMPORT, Some(cloud_import_request(IMPORT_ID, false)))
        .await;
    assert_eq!(status, StatusCode::OK, "{summary}");
    assert_eq!(summary, fixture("cloud-import-summary.json"));
    assert_eq!(host_revision(&admin.app).await, before + 1);
}

/// The salt is the site's unless the file brings another: a file without one
/// (`null`, no badges) or with the site's own changes nothing and tells no
/// station about a new `site` record.
#[tokio::test]
async fn the_sites_salt_stays_when_the_file_has_none_or_the_same() {
    for same in [false, true] {
        let admin = admin().await;
        let before = host_revision(&admin.app).await;
        let salt = site_salt(&admin).await;
        let mut body = cloud_import_request(IMPORT_ID, false);
        body["payload"]["badges"] = json!([]);
        body["payload"]["badgeSalt"] = if same { json!(salt) } else { Value::Null };
        let (status, summary) = admin.call("POST", IMPORT, Some(body)).await;
        assert_eq!(status, StatusCode::OK, "{same}: {summary}");
        assert_eq!(summary["badgeSaltReplaced"], false, "{same}");
        assert_eq!(summary["badges"], 0, "{same}");
        assert_eq!(summary["operators"], 3, "{same}");
        assert_eq!(site_salt(&admin).await, salt, "{same}");
        let items = admin.feed(before).await;
        assert!(
            items
                .as_array()
                .unwrap()
                .iter()
                .all(|item| item["entity"] != "site"),
            "{same}: the salt did not change, so no site record"
        );
        assert_eq!(host_revision(&admin.app).await, before + 1, "{same}");
    }
}

/// What the wizard leaves on a site that has stock templates, as the
/// wizard's own writes would: a box and a pallet template with
/// `stock = 1`, both the organization's defaults.
async fn wizard_stock_templates(admin: &Admin) {
    for (id, purpose) in [("stock-box", "box"), ("stock-pallet", "pallet")] {
        sqlx::query(
            "INSERT INTO label_templates (id, name, purpose, enabled, category_codes, spec, stock, rev) \
             VALUES (?, ?, ?, 1, NULL, '{}', 1, 1)",
        )
        .bind(id)
        .bind(format!("Типовой {purpose}"))
        .bind(purpose)
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    }
    sqlx::query(
        "UPDATE org_profile SET default_box_template_id = 'stock-box', \
         default_pallet_template_id = 'stock-pallet' WHERE id = 1",
    )
    .execute(&admin.app.state.pool)
    .await
    .unwrap();
}

/// A default the file leaves out stays the wizard's; a file that names none
/// leaves the organization record alone. The wizard's stock templates are
/// no data of the site (the import goes through them).
#[tokio::test]
async fn a_default_the_file_leaves_out_stays_the_wizards() {
    for (box_left_out, pallet_left_out) in [(false, true), (true, false), (true, true)] {
        let label = format!("box left out {box_left_out}, pallet left out {pallet_left_out}");
        let admin = admin().await;
        wizard_stock_templates(&admin).await;
        let before = host_revision(&admin.app).await;
        let (_, wizard) = admin
            .call("GET", "/v1/office/template-defaults", None)
            .await;
        let mut body = cloud_import_request(IMPORT_ID, false);
        if box_left_out {
            body["payload"]["templateDefaults"]["defaultBoxTemplateId"] = Value::Null;
        }
        if pallet_left_out {
            body["payload"]["templateDefaults"]["defaultPalletTemplateId"] = Value::Null;
        }
        let (status, summary) = admin.call("POST", IMPORT, Some(body)).await;
        assert_eq!(status, StatusCode::OK, "{label}: {summary}");
        assert_eq!(
            summary["orgDefaults"],
            u32::from(!box_left_out) + u32::from(!pallet_left_out),
            "{label}"
        );
        let (_, defaults) = admin
            .call("GET", "/v1/office/template-defaults", None)
            .await;
        for (key, left_out, files) in [
            (
                "defaultBoxTemplateId",
                box_left_out,
                "0d0d0000-0000-4000-8000-000000000001",
            ),
            (
                "defaultPalletTemplateId",
                pallet_left_out,
                "0d0d0000-0000-4000-8000-000000000003",
            ),
        ] {
            let expected = if left_out {
                wizard[key].clone()
            } else {
                json!(files)
            };
            assert_ne!(wizard[key], Value::Null, "{label}: {key} of the wizard");
            assert_eq!(defaults[key], expected, "{label}: {key}");
        }
        let items = admin.feed(before).await;
        let org_record = items
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["entity"] == "org_profile");
        assert_eq!(
            org_record,
            !(box_left_out && pallet_left_out),
            "{label}: the organization record rides only when a default is named"
        );
    }
}

/// A line the wizard archived does not hold its name: the file's line of
/// that name is created next to it.
#[tokio::test]
async fn an_archived_line_does_not_count_as_present() {
    let admin = admin().await;
    let (_, lines) = admin.call("GET", "/v1/office/lines", None).await;
    let first = lines
        .as_array()
        .unwrap()
        .iter()
        .find(|line| line["name"] == "Линия 1")
        .unwrap();
    let (status, body) = admin
        .call(
            "PUT",
            &format!("/v1/office/lines/{}", first["id"].as_str().unwrap()),
            Some(json!({ "archived": true, "expectedRev": first["rev"] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, summary) = admin
        .call("POST", IMPORT, Some(cloud_import_request(IMPORT_ID, false)))
        .await;
    assert_eq!(status, StatusCode::OK, "{summary}");
    // «Линия 2» is the wizard's active one; the file's «Линия 1» is new.
    assert_eq!(summary["linesCreated"], 3);
    assert_eq!(summary["linesPresent"], 0);
}

/// Neither the answer nor any audit row holds a verifier, the salt or a
/// checksum-sized piece of the file.
#[tokio::test]
async fn neither_the_answer_nor_the_audit_trail_holds_a_verifier() {
    let admin = admin().await;
    let request = cloud_import_request(IMPORT_ID, false);
    let (status, summary) = admin.call("POST", IMPORT, Some(request.clone())).await;
    assert_eq!(status, StatusCode::OK, "{summary}");
    let (status, again) = admin.call("POST", IMPORT, Some(request.clone())).await;
    assert_eq!(status, StatusCode::OK, "{again}");
    let details: Vec<String> = sqlx::query_scalar("SELECT details FROM audit_log")
        .fetch_all(&admin.app.state.pool)
        .await
        .unwrap();
    let mut seen = details.join("\n");
    seen.push_str(&summary.to_string());
    seen.push_str(&again.to_string());
    let mut secrets = vec![
        request["payload"]["badgeSalt"].as_str().unwrap().to_owned(),
        "pbkdf2".to_owned(),
    ];
    for operator in request["payload"]["operators"].as_array().unwrap() {
        secrets.push(operator["pinPhc"].as_str().unwrap().to_owned());
    }
    for badge in request["payload"]["badges"].as_array().unwrap() {
        let phc = badge["badgePhc"].as_str().unwrap();
        secrets.push(phc.to_owned());
        secrets.push(phc.rsplit('$').next().unwrap().to_owned());
    }
    for secret in secrets {
        assert!(!seen.contains(&secret), "a verifier reached the record");
    }
}

/// A stored value differs from the file's. Names the field only: the fields
/// compared this way are verifiers, and a failure must not print them.
fn same(field: &str, stored: &str, file: &str) {
    assert!(stored == file, "{field} is not the file's value");
}

/// `json(true|false)` for a 0/1 column.
fn flag(column: &str) -> String {
    format!("json(CASE WHEN {column} = 1 THEN 'true' ELSE 'false' END)")
}

/// One stored row spelled as the file spells it: `json_object` over
/// `(file key, SQL expression)` pairs.
async fn stored_row(admin: &Admin, table: &str, key: &str, columns: &[(&str, String)]) -> Value {
    let pairs: Vec<String> = columns
        .iter()
        .map(|(name, sql)| format!("'{name}', {sql}"))
        .collect();
    let text: Option<String> = sqlx::query_scalar(&format!(
        "SELECT json_object({}) FROM {table} WHERE {key}",
        pairs.join(", ")
    ))
    .fetch_optional(&admin.app.state.pool)
    .await
    .unwrap();
    serde_json::from_str(&text.unwrap_or_else(|| panic!("{table} {key} was not written"))).unwrap()
}

/// Every row of `file_rows` is in `table` with each field the file gives it
/// (`columns`: file key and SQL expression; `fixed` overrides what the file
/// does not say: the revision, the flags the import sets), the table holds
/// no other row of `filter`, and each `secrets` column (file key, column)
/// equals the file's without a value reaching a failure message.
async fn assert_rows_are_the_files(
    admin: &Admin,
    table: &str,
    filter: &str,
    file_rows: &[Value],
    columns: &[(&str, String)],
    fixed: &Value,
    secrets: &[(&str, &str)],
) {
    let mut ids: Vec<String> = sqlx::query_scalar(&format!(
        "SELECT id FROM {table} WHERE {filter} ORDER BY id"
    ))
    .fetch_all(&admin.app.state.pool)
    .await
    .unwrap();
    let mut file_ids: Vec<String> = file_rows
        .iter()
        .map(|row| row["id"].as_str().unwrap().to_owned())
        .collect();
    ids.sort();
    file_ids.sort();
    assert_eq!(ids, file_ids, "{table}: the rows are not the file's");
    for row in file_rows {
        let id = row["id"].as_str().unwrap();
        let expected: serde_json::Map<String, Value> = columns
            .iter()
            .map(|(name, _)| {
                let value = fixed.get(*name).unwrap_or(&row[*name]);
                ((*name).to_owned(), value.clone())
            })
            .collect();
        let stored = stored_row(admin, table, &format!("id = '{id}'"), columns).await;
        assert_eq!(stored, Value::Object(expected), "{table} {id}");
        for (name, column) in secrets {
            let stored: String =
                sqlx::query_scalar(&format!("SELECT {column} FROM {table} WHERE id = ?"))
                    .bind(id)
                    .fetch_one(&admin.app.state.pool)
                    .await
                    .unwrap();
            same(
                &format!("{table} {id} {name}"),
                &stored,
                row[*name].as_str().unwrap(),
            );
        }
    }
}

fn col(name: &str) -> (&str, String) {
    (name, name.to_owned())
}

/// Every field of every row of the file reaches its own column (a swapped
/// bind, a value lost to NULL or a default would corrupt the catalog for
/// good). Table-driven from the golden transfer file; nothing is retyped.
#[tokio::test]
async fn every_field_of_the_file_reaches_its_own_column() {
    let admin = admin().await;
    let file = fixture("cloud-export-file.json");
    let payload = &file["payload"];
    let pool = &admin.app.state.pool;

    let present: Vec<String> = sqlx::query_scalar("SELECT name_key FROM lines WHERE archived = 0")
        .fetch_all(pool)
        .await
        .unwrap();
    let sscc_before: Vec<(String, i64, i64, i64)> =
        sqlx::query_as("SELECT issuer_prefix, extension, next_serial, rev FROM sscc_counters")
            .fetch_all(pool)
            .await
            .unwrap();
    let shifts_before: Vec<(String, i64)> =
        sqlx::query_as("SELECT month_key, last_seq FROM shift_number_counters")
            .fetch_all(pool)
            .await
            .unwrap();
    let before = host_revision(&admin.app).await;

    let (status, summary) = admin
        .call("POST", IMPORT, Some(cloud_import_request(IMPORT_ID, false)))
        .await;
    assert_eq!(status, StatusCode::OK, "{summary}");
    let rev = before + 1;
    let at: String = sqlx::query_scalar("SELECT at FROM audit_log WHERE action = 'import.cloud'")
        .fetch_one(pool)
        .await
        .unwrap();
    let rows = |key: &str| payload[key].as_array().unwrap().clone();

    // Lines: the wizard's «Линия 1» stays; the others are created, active.
    let created: Vec<Value> = rows("lines")
        .into_iter()
        .filter(|line| !present.contains(&line["name"].as_str().unwrap().to_lowercase()))
        .collect();
    assert!(!created.is_empty() && created.len() < rows("lines").len());
    let mut line_columns = vec![col("id"), col("name"), ("nameKey", "name_key".to_owned())];
    line_columns.push(("archived", flag("archived")));
    line_columns.push(("rev", "rev".to_owned()));
    let created_ids: Vec<String> = created
        .iter()
        .map(|line| format!("'{}'", line["id"].as_str().unwrap()))
        .collect();
    let with_keys: Vec<Value> = created
        .iter()
        .map(|line| {
            let mut line = line.clone();
            line["nameKey"] = json!(line["name"].as_str().unwrap().to_lowercase());
            line
        })
        .collect();
    assert_rows_are_the_files(
        &admin,
        "lines",
        &format!("id IN ({})", created_ids.join(", ")),
        &with_keys,
        &line_columns,
        &json!({ "archived": false, "rev": rev }),
        &[],
    )
    .await;
    assert_eq!(
        scalar_i64(&admin, "SELECT COUNT(*) FROM lines").await,
        i64::try_from(present.len() + created.len()).unwrap(),
        "lines: a row the file does not name"
    );

    assert_rows_are_the_files(
        &admin,
        "counterparties",
        "1 = 1",
        &rows("counterparties"),
        &[
            col("id"),
            col("name"),
            col("inn"),
            col("gln"),
            ("gs1Prefixes", "json(gs1_prefixes)".to_owned()),
            ("archived", flag("archived")),
            col("rev"),
        ],
        &json!({ "archived": false, "rev": rev }),
        &[],
    )
    .await;

    assert_rows_are_the_files(
        &admin,
        "label_templates",
        "stock = 0",
        &rows("templates"),
        &[
            col("id"),
            col("name"),
            col("purpose"),
            ("enabled", flag("enabled")),
            ("chzProductGroupCodes", "json(category_codes)".to_owned()),
            ("spec", "json(spec)".to_owned()),
            col("stock"),
            col("rev"),
        ],
        &json!({ "stock": 0, "rev": rev }),
        &[],
    )
    .await;

    assert_rows_are_the_files(
        &admin,
        "products",
        "1 = 1",
        &rows("products"),
        &[
            col("id"),
            col("gtin14"),
            col("name"),
            ("printName", "print_name".to_owned()),
            ("chzProductGroupCode", "chz_group_code".to_owned()),
            ("boxCapacity", "box_capacity".to_owned()),
            ("palletBoxCapacity", "pallet_box_capacity".to_owned()),
            ("shelfLifeDays", "shelf_life_days".to_owned()),
            ("defaultBoxTemplateId", "default_box_template_id".to_owned()),
            (
                "defaultPalletTemplateId",
                "default_pallet_template_id".to_owned(),
            ),
            ("archived", flag("archived")),
            col("rev"),
        ],
        &json!({ "rev": rev }),
        &[],
    )
    .await;

    assert_rows_are_the_files(
        &admin,
        "operators",
        "1 = 1",
        &rows("operators"),
        &[
            col("id"),
            col("login"),
            col("name"),
            col("role"),
            ("active", flag("active")),
            col("rev"),
        ],
        &json!({ "rev": rev }),
        &[("pinPhc", "pin_phc")],
    )
    .await;

    assert_rows_are_the_files(
        &admin,
        "operator_badges",
        "1 = 1",
        &rows("badges"),
        &[
            col("id"),
            ("operatorId", "operator_id".to_owned()),
            col("label"),
            ("createdAt", "created_at".to_owned()),
            ("revokedAt", "revoked_at".to_owned()),
            col("rev"),
        ],
        &json!({ "createdAt": at, "revokedAt": null, "rev": rev }),
        &[("badgePhc", "badge_phc")],
    )
    .await;

    // The salt: the file's, with the revision the feed carries.
    same(
        "the badge salt",
        &site_salt(&admin).await,
        payload["badgeSalt"].as_str().unwrap(),
    );
    assert_eq!(
        scalar_i64(&admin, "SELECT rev FROM site WHERE id = 1").await,
        rev
    );

    // The organization's defaults and the categories'.
    let defaults = &payload["templateDefaults"];
    let stored = stored_row(
        &admin,
        "org_profile",
        "id = 1",
        &[
            ("defaultBoxTemplateId", "default_box_template_id".to_owned()),
            (
                "defaultPalletTemplateId",
                "default_pallet_template_id".to_owned(),
            ),
            ("rev", "rev".to_owned()),
        ],
    )
    .await;
    assert_eq!(
        stored,
        json!({
            "defaultBoxTemplateId": defaults["defaultBoxTemplateId"],
            "defaultPalletTemplateId": defaults["defaultPalletTemplateId"],
            "rev": rev,
        })
    );
    let stored: Vec<String> = sqlx::query_scalar(
        "SELECT json_object('chzProductGroupCode', chz_group_code, 'purpose', purpose, \
         'templateId', template_id, 'rev', rev) FROM category_template_defaults \
         ORDER BY chz_group_code, purpose",
    )
    .fetch_all(pool)
    .await
    .unwrap();
    let stored: Vec<Value> = stored
        .iter()
        .map(|row| serde_json::from_str(row).unwrap())
        .collect();
    let mut expected: Vec<Value> = defaults["categories"]
        .as_array()
        .unwrap()
        .iter()
        .map(|each| {
            let mut each = each.clone();
            each["rev"] = json!(rev);
            each
        })
        .collect();
    expected.sort_by_key(|each| {
        (
            each["chzProductGroupCode"].as_u64().unwrap(),
            each["purpose"].as_str().unwrap().to_owned(),
        )
    });
    assert_eq!(stored, expected);

    // The counters: the larger of the site's and the file's, with the import's
    // revision on the ones the file raised.
    let mut stored: Vec<(String, i64, i64, i64)> = sqlx::query_as(
        "SELECT issuer_prefix, extension, next_serial, rev FROM sscc_counters \
         ORDER BY issuer_prefix, extension",
    )
    .fetch_all(pool)
    .await
    .unwrap();
    let mut expected: Vec<(String, i64, i64, i64)> = sscc_before.clone();
    for each in payload["ssccCounters"].as_array().unwrap() {
        let prefix = each["issuerPrefix"].as_str().unwrap().to_owned();
        let extension = each["extension"].as_i64().unwrap();
        let next = i64::try_from(each["nextSerial"].as_u64().unwrap()).unwrap();
        match expected
            .iter_mut()
            .find(|row| row.0 == prefix && row.1 == extension)
        {
            Some(row) if next > row.2 => {
                row.2 = next;
                row.3 = rev;
            }
            Some(_) => {}
            None => expected.push((prefix, extension, next, rev)),
        }
    }
    stored.sort();
    expected.sort();
    assert_eq!(stored, expected, "sscc_counters");
    let mut stored: Vec<(String, i64)> =
        sqlx::query_as("SELECT month_key, last_seq FROM shift_number_counters")
            .fetch_all(pool)
            .await
            .unwrap();
    let mut expected = shifts_before.clone();
    for each in payload["shiftNumberCounters"].as_array().unwrap() {
        let key = each["monthKey"].as_str().unwrap().to_owned();
        let seq = each["lastSeq"].as_i64().unwrap();
        match expected.iter_mut().find(|row| row.0 == key) {
            Some(row) => row.1 = row.1.max(seq),
            None => expected.push((key, seq)),
        }
    }
    stored.sort();
    expected.sort();
    assert_eq!(stored, expected, "shift_number_counters");
}

/// A request that could not be read answers a fixed text. serde's own texts
/// quote the offending value, and a file edited by hand may hold a verifier
/// or the salt where a number belongs.
#[tokio::test]
async fn an_unreadable_body_is_answered_with_a_fixed_text_that_quotes_nothing() {
    let admin = admin().await;
    let file = fixture("cloud-export-file.json");
    let secrets = [
        file["payload"]["operators"][0]["pinPhc"].as_str().unwrap(),
        file["payload"]["badges"][0]["badgePhc"].as_str().unwrap(),
        file["payload"]["badgeSalt"].as_str().unwrap(),
    ];
    const READ: &str = "the body is not a transfer file this host reads";
    let tech = admin.technologist().await;
    let before = host_revision(&admin.app).await;
    for secret in secrets {
        // A verifier in a number, a flag and a text-or-null position, and as
        // an unknown field's name.
        for pointer in [
            "/payload/products/0/boxCapacity",
            "/payload/products/0/archived",
            "/payload/operators/0/active",
            "/payload/templates/0/chzProductGroupCodes",
            "/payload/ssccCounters/0/extension",
            "/formatVersion",
        ] {
            let mut body = cloud_import_request(IMPORT_ID, false);
            *body.pointer_mut(pointer).unwrap() = json!(secret);
            let (status, error) = admin.call("POST", IMPORT, Some(body)).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{pointer}");
            assert!(
                !error.to_string().contains(secret),
                "the answer to {pointer} quotes a verifier"
            );
            assert_eq!(error["error"]["code"], "validation_failed", "{pointer}");
            assert_eq!(error["error"]["message"], READ, "{pointer}");
            assert_eq!(error["error"]["details"], Value::Null, "{pointer}");
        }
        let mut body = cloud_import_request(IMPORT_ID, false);
        body["payload"][secret] = json!(1);
        let (status, error) = admin.call("POST", IMPORT, Some(body)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(
            !error.to_string().contains(secret),
            "the answer to an unknown field quotes a verifier"
        );
        assert_eq!(error["error"]["message"], READ);
    }

    // Not JSON at all, and no JSON content type.
    let builder = || with_session(request("POST", IMPORT), &admin.key, &admin.token);
    let (status, error) = admin
        .app
        .send(
            builder()
                .header("content-type", "application/json")
                .body(Body::from(r#"{"importId": "#))
                .unwrap(),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error["error"]["message"], READ);
    let (status, error) = admin
        .app
        .send(
            builder()
                .body(Body::from(
                    cloud_import_request(IMPORT_ID, false).to_string(),
                ))
                .unwrap(),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        error["error"]["message"],
        "Content-Type application/json is required"
    );

    // The role is checked before the body is read: a technologist who sends
    // an unreadable body is refused, not told what is wrong with it.
    let mut body = cloud_import_request(IMPORT_ID, false);
    body["payload"]["products"][0]["boxCapacity"] = json!("not a number");
    let (status, error) = admin.call_as(&tech, "POST", IMPORT, Some(body)).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{error}");
    let (status, error) = admin
        .app
        .send(
            with_session(request("POST", IMPORT), &admin.key, &tech)
                .header("content-type", "application/json")
                .body(Body::from("{"))
                .unwrap(),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{error}");
    assert_eq!(host_revision(&admin.app).await, before);
    assert_eq!(imported_rows(&admin).await, [0; 6]);
}

/// The golden file's two category defaults share a group (8), so a group the
/// import wrote for every row would pass there: three defaults over two
/// groups and both purposes, read back as the file names them.
#[tokio::test]
async fn category_defaults_keep_their_own_group_and_purpose() {
    let admin = admin().await;
    let mut request = cloud_import_request(IMPORT_ID, false);
    let templates = |index: usize| {
        request["payload"]["templates"][index]["id"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    let (box_any, box_milk, pallet) = (templates(0), templates(1), templates(2));
    let categories = json!([
        { "chzProductGroupCode": 13, "purpose": "box", "templateId": box_any },
        { "chzProductGroupCode": 8, "purpose": "box", "templateId": box_milk },
        { "chzProductGroupCode": 13, "purpose": "pallet", "templateId": pallet },
    ]);
    request["payload"]["templateDefaults"]["categories"] = categories.clone();
    let before = host_revision(&admin.app).await;
    let (status, summary) = admin.call("POST", IMPORT, Some(request)).await;
    assert_eq!(status, StatusCode::OK, "{summary}");
    let stored: Vec<String> = sqlx::query_scalar(
        "SELECT json_object('chzProductGroupCode', chz_group_code, 'purpose', purpose, \
         'templateId', template_id, 'rev', rev) FROM category_template_defaults \
         ORDER BY chz_group_code, purpose",
    )
    .fetch_all(&admin.app.state.pool)
    .await
    .unwrap();
    let stored: Vec<Value> = stored
        .iter()
        .map(|row| serde_json::from_str(row).unwrap())
        .collect();
    let mut expected: Vec<Value> = categories.as_array().unwrap().clone();
    for each in &mut expected {
        each["rev"] = json!(before + 1);
    }
    expected.sort_by_key(|each| {
        (
            each["chzProductGroupCode"].as_u64().unwrap(),
            each["purpose"].as_str().unwrap().to_owned(),
        )
    });
    assert_eq!(stored, expected);
}
