//! Migration `0030` (plan ЛЦ-2): the site's license files, append-only, and
//! the one row of the license clock.

mod support;

use support::app::TestApp;

const INSERT: &str = "INSERT INTO licenses (license_id, sequence, compact, kid, host_id, \
     issued_at, valid_from, valid_until, grace_days, plan, plan_version_id, customer_name, \
     customer_inn, quotas, features, loaded_at, loaded_by) \
     VALUES (?, ?, 'a.b.c', 'test-lic-1', '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f', 1, 1, ?, ?, ?, \
     '0b7c2d9e-1f3a-4b5c-8d6e-7f8091a2b3c4', 'ООО «Атолл»', '7707083893', '{}', '{}', \
     '2026-10-13T09:00:00Z', NULL)";

async fn insert(
    app: &TestApp,
    id: &str,
    sequence: i64,
    valid_until: i64,
    grace_days: i64,
    plan: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(INSERT)
        .bind(id)
        .bind(sequence)
        .bind(valid_until)
        .bind(grace_days)
        .bind(plan)
        .execute(&app.state.pool)
        .await
        .map(|_| ())
}

#[tokio::test]
async fn a_new_host_has_no_license_and_an_empty_clock() {
    let app = TestApp::new().await;
    let files: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM licenses")
        .fetch_one(&app.state.pool)
        .await
        .unwrap();
    assert_eq!(files, 0);
    #[allow(clippy::type_complexity)]
    let clock: (
        Option<i64>,
        Option<i64>,
        Option<String>,
        Option<String>,
        Option<i64>,
        Option<i64>,
        Option<String>,
        Option<i64>,
    ) = sqlx::query_as(
        "SELECT max_seen_at, trial_started_at, trial_inn, emergency_used_for, emergency_until, \
         wrong_host_since, last_state, last_state_at FROM license_clock WHERE id = 1",
    )
    .fetch_one(&app.state.pool)
    .await
    .unwrap();
    assert_eq!(clock, (None, None, None, None, None, None, None, None));
}

#[tokio::test]
async fn the_tables_refuse_what_no_verified_file_holds() {
    let app = TestApp::new().await;
    let id = "6d1f0a52-3c4b-4e8f-9a1d-000000000001";
    insert(&app, id, 1, 2, 14, "subscription").await.unwrap();
    for (name, result) in [
        ("a second clock row", {
            sqlx::query("INSERT INTO license_clock (id) VALUES (2)")
                .execute(&app.state.pool)
                .await
                .map(|_| ())
        }),
        (
            "a sequence of 0",
            insert(
                &app,
                "6d1f0a52-3c4b-4e8f-9a1d-000000000002",
                0,
                2,
                14,
                "demo",
            )
            .await,
        ),
        (
            "61 days of grace",
            insert(
                &app,
                "6d1f0a52-3c4b-4e8f-9a1d-000000000003",
                3,
                2,
                61,
                "demo",
            )
            .await,
        ),
        (
            "an unknown plan",
            insert(
                &app,
                "6d1f0a52-3c4b-4e8f-9a1d-000000000004",
                4,
                2,
                0,
                "trial",
            )
            .await,
        ),
        (
            "an end before the start",
            insert(
                &app,
                "6d1f0a52-3c4b-4e8f-9a1d-000000000005",
                5,
                1,
                0,
                "demo",
            )
            .await,
        ),
    ] {
        let error = result.expect_err(name);
        assert!(error.to_string().contains("CHECK"), "{name}: {error}");
    }
    for (name, result) in [
        (
            "the same sequence",
            insert(
                &app,
                "6d1f0a52-3c4b-4e8f-9a1d-000000000006",
                1,
                2,
                0,
                "demo",
            )
            .await,
        ),
        ("the same file", insert(&app, id, 7, 2, 0, "demo").await),
    ] {
        let error = result.expect_err(name);
        assert!(error.to_string().contains("UNIQUE"), "{name}: {error}");
    }
}

#[test]
fn the_audit_names_the_license_and_its_refusals() {
    use markiro_host::audit::{actions, reasons};
    use markiro_proto::license::refusals;
    assert_eq!(
        [
            actions::LICENSE_LOAD,
            actions::LICENSE_STATE,
            actions::LICENSE_EMERGENCY
        ],
        ["license.load", "license.state", "license.emergency"]
    );
    assert_eq!(
        [
            reasons::LICENSE_MALFORMED,
            reasons::LICENSE_UNKNOWN_KEY,
            reasons::LICENSE_SIGNATURE,
            reasons::LICENSE_WRONG_HOST,
            reasons::LICENSE_INN_MISMATCH,
            reasons::LICENSE_INN_MISSING,
            reasons::LICENSE_OLDER,
        ],
        refusals::ALL
    );
}
