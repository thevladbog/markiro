//! The organization's print logo (plan А4, task 2): `GET`, `PUT` and `DELETE
//! /v1/office/org/logo`, and migration `0016` that holds it.

mod support;

use axum::http::StatusCode;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use support::app::{
    admin, audit_rows, audit_trail, empty, host_revision, login, request, seed_office_user,
    turn_the_user_off_at_the_next_activity, with_device, Admin,
};

const PATH: &str = "/v1/office/org/logo";

/// `proto/fixtures/org-logo-put.json`: 10 × 2 dots, bytes `F0 C0 0F 40`.
fn logo() -> Value {
    json!({ "width": 10, "height": 2, "pixelsBase64": "8MAPQA==" })
}

/// A blank logo of `width` × `height` dots: the right number of zero bytes.
fn blank(width: u32, height: u32) -> Value {
    let bytes = width.div_ceil(8) as usize * height as usize;
    json!({ "width": width, "height": height, "pixelsBase64": STANDARD.encode(vec![0u8; bytes]) })
}

/// What the table holds: `(width, height, pixels_base64, updated_at)`.
async fn stored(admin: &Admin) -> Option<(i64, i64, String, String)> {
    sqlx::query_as("SELECT width, height, pixels_base64, updated_at FROM org_logo WHERE id = 1")
        .fetch_optional(&admin.app.state.pool)
        .await
        .unwrap()
}

/// The `(status, code, field)` of a refused request.
fn refusal(status: StatusCode, body: &Value) -> (StatusCode, Value, Value) {
    (
        status,
        body["error"]["code"].clone(),
        body["error"]["details"]["field"].clone(),
    )
}

#[tokio::test]
async fn a_fresh_host_has_no_logo() {
    let admin = admin().await;
    let (status, body) = admin.call("GET", PATH, None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body, json!({ "logo": null }));
    assert_eq!(stored(&admin).await, None);
}

#[tokio::test]
async fn the_administrator_sets_replaces_and_clears_the_logo() {
    let admin = admin().await;
    let revision = host_revision(&admin.app).await;
    let (status, set) = admin.call("PUT", PATH, Some(logo())).await;
    assert_eq!(status, StatusCode::OK, "{set}");
    let updated_at = set["logo"]["updatedAt"].as_str().unwrap().to_owned();
    assert_eq!(
        set,
        json!({ "logo": {
            "width": 10, "height": 2, "pixelsBase64": "8MAPQA==", "updatedAt": updated_at
        } })
    );
    assert_eq!(
        stored(&admin).await,
        Some((10, 2, "8MAPQA==".to_owned(), updated_at.clone()))
    );
    let (_, read) = admin.call("GET", PATH, None).await;
    assert_eq!(read, set);
    // Every role reads it back, so does the technologist (below); the answer
    // is the same value, not a different projection.
    admin.app.clock.advance(time::Duration::seconds(5));
    let wider = json!({ "width": 16, "height": 1, "pixelsBase64": "/wA=" });
    let (status, replaced) = admin.call("PUT", PATH, Some(wider)).await;
    assert_eq!(status, StatusCode::OK, "{replaced}");
    assert_eq!(replaced["logo"]["width"], 16);
    assert_eq!(replaced["logo"]["height"], 1);
    assert_ne!(replaced["logo"]["updatedAt"], json!(updated_at));
    let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM org_logo")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    assert_eq!(rows, 1, "a replacement is the one row, rewritten");

    let (status, cleared) = admin.call("DELETE", PATH, None).await;
    assert_eq!(status, StatusCode::OK, "{cleared}");
    assert_eq!(cleared, json!({ "logo": null }));
    assert_eq!(stored(&admin).await, None);
    let (_, read) = admin.call("GET", PATH, None).await;
    assert_eq!(read, json!({ "logo": null }));

    // Audit: exact actor, target and details, sizes only.
    let set_row = |width: u32, height: u32| {
        admin.row(
            "org.logo.set",
            "org_profile",
            "1",
            json!({ "width": width, "height": height }),
        )
    };
    assert_eq!(
        audit_trail(&admin.app, "org.logo.set").await,
        vec![set_row(10, 2), set_row(16, 1)]
    );
    assert_eq!(
        audit_trail(&admin.app, "org.logo.clear").await,
        vec![admin.row("org.logo.clear", "org_profile", "1", json!({}))]
    );
    // A change of the logo takes no revision: it is not in the station feed.
    assert_eq!(host_revision(&admin.app).await, revision);
}

#[tokio::test]
async fn the_audit_trail_never_holds_the_logo_bits() {
    let admin = admin().await;
    let pixels = STANDARD.encode([0xA5u8; 4]);
    let body = json!({ "width": 12, "height": 2, "pixelsBase64": pixels });
    // 12 dots leave four padding bits per row: 0xA5 would set them.
    let (status, _) = admin.call("PUT", PATH, Some(body)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let body = json!({ "width": 16, "height": 2, "pixelsBase64": pixels });
    let (status, set) = admin.call("PUT", PATH, Some(body)).await;
    assert_eq!(status, StatusCode::OK, "{set}");
    let (status, _) = admin.call("DELETE", PATH, None).await;
    assert_eq!(status, StatusCode::OK);
    let details: Vec<String> = sqlx::query_scalar("SELECT details FROM audit_log")
        .fetch_all(&admin.app.state.pool)
        .await
        .unwrap();
    assert!(!details.is_empty());
    for text in details {
        assert!(!text.contains(&pixels), "the audit row holds the bits");
        assert!(!text.contains("pixels"), "{text}");
    }
}

#[tokio::test]
async fn clearing_no_logo_is_a_quiet_no_op_and_clearing_twice_is_the_same() {
    let admin = admin().await;
    let rows = audit_rows(&admin.app).await;
    let (status, body) = admin.call("DELETE", PATH, None).await;
    assert_eq!((status, body), (StatusCode::OK, json!({ "logo": null })));
    assert_eq!(audit_rows(&admin.app).await, rows, "nothing was cleared");

    admin.call("PUT", PATH, Some(logo())).await;
    let (_, first) = admin.call("DELETE", PATH, None).await;
    let rows = audit_rows(&admin.app).await;
    let (status, second) = admin.call("DELETE", PATH, None).await;
    assert_eq!((status, &second), (StatusCode::OK, &first));
    assert_eq!(
        audit_rows(&admin.app).await,
        rows,
        "the second clear audits nothing"
    );
    assert_eq!(audit_trail(&admin.app, "org.logo.clear").await.len(), 1);
}

#[tokio::test]
async fn a_refused_logo_changes_nothing_and_audits_nothing() {
    let admin = admin().await;
    admin.call("PUT", PATH, Some(logo())).await;
    let before = stored(&admin).await;
    let rows = audit_rows(&admin.app).await;
    let svg = "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script>\
               <image href='http://evil.example/x.png'/></svg>";
    let png = STANDARD
        .encode(b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\0\x08\0\0\0\x08\x08\x02\0\0\0Tx\xd8\xe9");
    let url_safe = "-_-_-w==";
    let cases: Vec<(&str, Value, &str)> = vec![
        // The padding bit of the second row's last byte is set (F0 C0 0F 41).
        (
            "padding bit",
            json!({ "width": 10, "height": 2, "pixelsBase64": "8MAPQQ==" }),
            "pixelsBase64",
        ),
        (
            "padding bit in row 0",
            json!({ "width": 10, "height": 2, "pixelsBase64": "8MEPQA==" }),
            "pixelsBase64",
        ),
        (
            "too few rows",
            json!({ "width": 10, "height": 3, "pixelsBase64": "8MAPQA==" }),
            "pixelsBase64",
        ),
        (
            "too many rows",
            json!({ "width": 10, "height": 1, "pixelsBase64": "8MAPQA==" }),
            "pixelsBase64",
        ),
        (
            "zero width",
            json!({ "width": 0, "height": 2, "pixelsBase64": "8MAPQA==" }),
            "width",
        ),
        (
            "too wide",
            json!({ "width": 1025, "height": 1, "pixelsBase64": "AA==" }),
            "width",
        ),
        (
            "zero height",
            json!({ "width": 10, "height": 0, "pixelsBase64": "8MAPQA==" }),
            "height",
        ),
        ("too high", blank(8, 513), "height"),
        (
            "no padding characters",
            json!({ "width": 8, "height": 1, "pixelsBase64": "AA" }),
            "pixelsBase64",
        ),
        (
            "an empty string",
            json!({ "width": 8, "height": 1, "pixelsBase64": "" }),
            "pixelsBase64",
        ),
        (
            "not base64",
            json!({ "width": 8, "height": 1, "pixelsBase64": "not base64!" }),
            "pixelsBase64",
        ),
        (
            "url-safe alphabet",
            json!({ "width": 24, "height": 1, "pixelsBase64": url_safe }),
            "pixelsBase64",
        ),
        (
            "a line break",
            json!({ "width": 10, "height": 2, "pixelsBase64": "8MAP\nQA==" }),
            "pixelsBase64",
        ),
        (
            "an svg with a script and an external href",
            json!({ "width": 8, "height": 1, "pixelsBase64": svg }),
            "pixelsBase64",
        ),
        (
            "a png file as the picture",
            json!({ "width": 8, "height": 1, "pixelsBase64": png }),
            "pixelsBase64",
        ),
    ];
    for (name, body, field) in cases {
        let (status, error) = admin.call("PUT", PATH, Some(body)).await;
        assert_eq!(
            refusal(status, &error),
            (
                StatusCode::BAD_REQUEST,
                json!("validation_failed"),
                json!(field)
            ),
            "{name}: {error}"
        );
    }
    // Bodies that are not even the shape (no field is named).
    for (name, body) in [
        (
            "an unknown field",
            json!({ "width": 10, "height": 2, "pixelsBase64": "8MAPQA==", "updatedAt": "x" }),
        ),
        ("a missing field", json!({ "width": 10, "height": 2 })),
        (
            "a string width",
            json!({ "width": "10", "height": 2, "pixelsBase64": "8MAPQA==" }),
        ),
        (
            "a negative width",
            json!({ "width": -8, "height": 2, "pixelsBase64": "8MAPQA==" }),
        ),
        (
            "a fractional width",
            json!({ "width": 10.5, "height": 2, "pixelsBase64": "8MAPQA==" }),
        ),
        (
            "a null picture",
            json!({ "width": 10, "height": 2, "pixelsBase64": null }),
        ),
        ("an array", json!([])),
    ] {
        let (status, error) = admin.call("PUT", PATH, Some(body)).await;
        assert_eq!(
            (status, error["error"]["code"].clone()),
            (StatusCode::BAD_REQUEST, json!("validation_failed")),
            "{name}: {error}"
        );
    }
    assert_eq!(stored(&admin).await, before);
    assert_eq!(audit_rows(&admin.app).await, rows);
}

/// The size boundaries, exactly: the largest logo the host keeps goes in and
/// comes back whole; one more dot or one more character is refused.
#[tokio::test]
async fn the_largest_logo_is_kept_and_one_more_is_refused() {
    let admin = admin().await;
    let largest = blank(1024, 512);
    assert_eq!(largest["pixelsBase64"].as_str().unwrap().len(), 87_384);
    let (status, set) = admin.call("PUT", PATH, Some(largest.clone())).await;
    assert_eq!(status, StatusCode::OK, "{set}");
    let (status, read) = admin.call("GET", PATH, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        read["logo"]["pixelsBase64"], largest["pixelsBase64"],
        "kept whole"
    );
    assert_eq!(
        (
            read["logo"]["width"].clone(),
            read["logo"]["height"].clone()
        ),
        (json!(1024), json!(512))
    );
    let kept = stored(&admin).await;
    assert_eq!(kept.as_ref().map(|row| row.2.len()), Some(87_384));

    // A logo of 1 × 1 is the smallest.
    let (status, smallest) = admin.call("PUT", PATH, Some(blank(1, 1))).await;
    assert_eq!(status, StatusCode::OK, "{smallest}");
    let (status, _) = admin.call("PUT", PATH, Some(largest)).await;
    assert_eq!(status, StatusCode::OK);

    let (status, error) = admin.call("PUT", PATH, Some(blank(1025, 512))).await;
    assert_eq!(refusal(status, &error).2, json!("width"), "{error}");
    let (status, error) = admin.call("PUT", PATH, Some(blank(1024, 513))).await;
    assert_eq!(refusal(status, &error).2, json!("height"), "{error}");
    // One character over the text bound is refused before it is decoded.
    let over = "A".repeat(90_001);
    let (status, error) = admin
        .call(
            "PUT",
            PATH,
            Some(json!({ "width": 1024, "height": 512, "pixelsBase64": over })),
        )
        .await;
    assert_eq!(
        (
            refusal(status, &error),
            error["error"]["message"].as_str().unwrap()
        ),
        (
            (
                StatusCode::BAD_REQUEST,
                json!("validation_failed"),
                json!("pixelsBase64")
            ),
            "at most 90000 characters"
        )
    );
    assert_eq!(
        stored(&admin).await,
        kept,
        "the refusals left the big logo alone"
    );
}

/// The router's JSON ceiling (2 MiB) is far above a logo; a body past it is
/// refused outright and leaves the logo alone.
#[tokio::test]
async fn a_body_past_the_json_ceiling_is_refused_and_changes_nothing() {
    let admin = admin().await;
    admin.call("PUT", PATH, Some(logo())).await;
    let before = stored(&admin).await;
    let rows = audit_rows(&admin.app).await;
    let huge = "A".repeat(3 * 1024 * 1024);
    let (status, error) = admin
        .call(
            "PUT",
            PATH,
            Some(json!({ "width": 1024, "height": 512, "pixelsBase64": huge })),
        )
        .await;
    assert_eq!(
        (status, error["error"]["code"].clone()),
        (StatusCode::BAD_REQUEST, json!("validation_failed")),
        "{error}"
    );
    assert!(
        error["error"]["message"]
            .as_str()
            .unwrap()
            .contains("length limit"),
        "{error}"
    );
    // Under the ceiling a long text is refused by the logo's own bound, with
    // its own message: the ceiling does not cut a body short.
    let long = "A".repeat(1024 * 1024);
    let (status, error) = admin
        .call(
            "PUT",
            PATH,
            Some(json!({ "width": 1024, "height": 512, "pixelsBase64": long })),
        )
        .await;
    assert_eq!(
        (status, error["error"]["message"].clone()),
        (StatusCode::BAD_REQUEST, json!("at most 90000 characters")),
        "{error}"
    );
    assert_eq!(stored(&admin).await, before);
    assert_eq!(audit_rows(&admin.app).await, rows);
}

#[tokio::test]
async fn a_technologist_reads_but_does_not_change_the_logo() {
    let admin = admin().await;
    admin.call("PUT", PATH, Some(logo())).await;
    let before = stored(&admin).await;
    let token = admin.technologist().await;
    let rows = audit_rows(&admin.app).await;
    let (status, read) = admin.call_as(&token, "GET", PATH, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(read["logo"]["pixelsBase64"], "8MAPQA==");
    for (method, body) in [("PUT", Some(blank(8, 1))), ("DELETE", None)] {
        let (status, error) = admin.call_as(&token, method, PATH, body).await;
        assert_eq!(
            (status, error["error"]["code"].clone()),
            (StatusCode::FORBIDDEN, json!("forbidden")),
            "{method}: {error}"
        );
    }
    assert_eq!(stored(&admin).await, before);
    assert_eq!(audit_rows(&admin.app).await, rows);
}

#[tokio::test]
async fn nobody_without_an_office_session_touches_the_logo() {
    let admin = admin().await;
    admin.call("PUT", PATH, Some(logo())).await;
    let before = stored(&admin).await;
    let rows = audit_rows(&admin.app).await;
    for method in ["GET", "PUT", "DELETE"] {
        // A paired device without an office session.
        let builder = with_device(request(method, PATH), &admin.key);
        let with_device_only = match method {
            "PUT" => support::app::json(builder, blank(8, 1)),
            _ => empty(builder),
        };
        let (status, error) = admin.app.send(with_device_only).await;
        assert_eq!(
            (status, error["error"]["code"].clone()),
            (StatusCode::UNAUTHORIZED, json!("unauthorized")),
            "{method}: {error}"
        );
        // No device at all.
        let (status, error) = admin.app.send(empty(request(method, PATH))).await;
        assert_eq!(
            (status, error["error"]["details"]["credential"].clone()),
            (StatusCode::UNAUTHORIZED, json!("device")),
            "{method}: {error}"
        );
    }
    assert_eq!(stored(&admin).await, before);
    assert_eq!(audit_rows(&admin.app).await, rows);
}

/// An administrator turned off after the extractor passed must not write: the
/// route reads the role again inside its own write transaction.
#[tokio::test]
async fn an_administrator_turned_off_after_the_extractor_passed_writes_nothing() {
    let admin = admin().await;
    admin.call("PUT", PATH, Some(logo())).await;
    let before = stored(&admin).await;
    for (method, body) in [("PUT", Some(blank(8, 1))), ("DELETE", None)] {
        let login_name = format!("second-{}", method.to_lowercase());
        let id = seed_office_user(&admin.app, &login_name, "admin", "second admin password").await;
        let token = login(&admin.app, &admin.key, &login_name, "second admin password").await;
        let rows = audit_rows(&admin.app).await;
        turn_the_user_off_at_the_next_activity(&admin.app, &id).await;
        // Let a minute pass, so that the extractor records activity.
        admin.app.clock.advance(time::Duration::minutes(2));
        let (status, error) = admin.call_as(&token, method, PATH, body).await;
        assert_eq!(
            (status, error["error"]["code"].clone()),
            (StatusCode::UNAUTHORIZED, json!("unauthorized")),
            "{method}: {error}"
        );
        assert_eq!(stored(&admin).await, before, "{method}");
        assert_eq!(audit_rows(&admin.app).await, rows, "{method}");
    }
}

/// What no row may break, whatever writes it: one row, the size bounds, the
/// text bounds.
#[tokio::test]
async fn the_table_holds_one_bounded_row() {
    let admin = admin().await;
    let pool = &admin.app.state.pool;
    let insert = |id: i64, width: i64, height: i64, pixels: String| {
        sqlx::query(
            "INSERT INTO org_logo (id, width, height, pixels_base64, updated_at) \
             VALUES (?, ?, ?, ?, '2026-10-11T09:00:00.000Z')",
        )
        .bind(id)
        .bind(width)
        .bind(height)
        .bind(pixels)
        .execute(pool)
    };
    for (what, result) in [
        ("a second row", insert(2, 8, 1, "AA==".to_owned()).await),
        ("width 0", insert(1, 0, 1, "AA==".to_owned()).await),
        ("width 1025", insert(1, 1025, 1, "AA==".to_owned()).await),
        ("height 0", insert(1, 8, 0, "AA==".to_owned()).await),
        ("height 513", insert(1, 8, 513, "AA==".to_owned()).await),
        ("three characters", insert(1, 8, 1, "AAA".to_owned()).await),
        (
            "90001 characters",
            insert(1, 8, 1, "A".repeat(90_001)).await,
        ),
    ] {
        let error = result.expect_err(what);
        assert!(error.to_string().contains("CHECK"), "{what}: {error}");
    }
    insert(1, 1024, 512, "A".repeat(90_000))
        .await
        .expect("90000 characters fit");
}

/// `0016` is numbered by the plans' allocation: `0013` and `0014` belong to
/// other plans and may merge later (`0015`, plan СКЛ, is here), and `0011` is
/// missing on a database made before it. sqlx applies a missing lower number late, keeps what `0016`
/// stored and refuses only a migration that was applied and is gone, so a
/// host that took `0016` first takes the lower ones when they arrive.
#[tokio::test]
async fn a_database_with_0016_takes_a_lower_migration_late() {
    use sqlx::migrate::Migrator;
    use sqlx::{Connection, SqliteConnection};

    let without = |version: i64| Migrator {
        migrations: markiro_host::db::MIGRATOR
            .iter()
            .filter(|migration| migration.version != version)
            .cloned()
            .collect::<Vec<_>>()
            .into(),
        ..Migrator::DEFAULT
    };
    let all = markiro_host::db::MIGRATOR.iter().count();
    let mut old = SqliteConnection::connect("sqlite::memory:").await.unwrap();
    let partial = without(11);
    assert_eq!(partial.iter().count() + 1, all);
    partial.run(&mut old).await.unwrap();
    let versions: Vec<i64> =
        sqlx::query_scalar("SELECT version FROM _sqlx_migrations ORDER BY version")
            .fetch_all(&mut old)
            .await
            .unwrap();
    // 0016 is applied with a gap where 0013 and 0014 will be, and without 0011.
    assert!(
        versions.contains(&16)
            && versions.contains(&15)
            && versions.contains(&12)
            && !versions.contains(&11),
        "{versions:?}"
    );
    assert!(!versions.iter().any(|version| (13..=14).contains(version)));
    sqlx::query(
        "INSERT INTO org_logo (id, width, height, pixels_base64, updated_at) \
         VALUES (1, 10, 2, '8MAPQA==', '2026-10-11T09:00:00.000Z')",
    )
    .execute(&mut old)
    .await
    .unwrap();

    markiro_host::db::MIGRATOR.run(&mut old).await.unwrap();

    let applied: Vec<(i64, bool)> =
        sqlx::query_as("SELECT version, success FROM _sqlx_migrations ORDER BY version")
            .fetch_all(&mut old)
            .await
            .unwrap();
    assert!(
        applied.contains(&(11, true)) && applied.contains(&(16, true)),
        "{applied:?}"
    );
    assert_eq!(applied.len(), all);
    let logo: (i64, i64, String) =
        sqlx::query_as("SELECT width, height, pixels_base64 FROM org_logo WHERE id = 1")
            .fetch_one(&mut old)
            .await
            .unwrap();
    assert_eq!(logo, (10, 2, "8MAPQA==".to_owned()));
}

/// The other order: a database without `0016` (every host made before this
/// plan) takes it, and starts with no logo and no sheet.
#[tokio::test]
async fn a_database_without_0016_takes_it_and_starts_with_no_logo() {
    use sqlx::migrate::Migrator;
    use sqlx::{Connection, SqliteConnection};

    let before = Migrator {
        migrations: markiro_host::db::MIGRATOR
            .iter()
            .filter(|migration| migration.version != 16)
            .cloned()
            .collect::<Vec<_>>()
            .into(),
        ..Migrator::DEFAULT
    };
    let mut old = SqliteConnection::connect("sqlite::memory:").await.unwrap();
    before.run(&mut old).await.unwrap();
    markiro_host::db::MIGRATOR.run(&mut old).await.unwrap();
    let logos: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM org_logo")
        .fetch_one(&mut old)
        .await
        .unwrap();
    let sheets: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pallet_sheet_templates")
        .fetch_one(&mut old)
        .await
        .unwrap();
    assert_eq!((logos, sheets), (0, 0));
}

/// The wave's two host migrations, `0015` (plan СКЛ) and `0016` (plan А4),
/// both sit above the gap the allocation left at `0013` and `0014`. A host
/// made before both (through `0012`) takes them in one start; a host of the
/// СКЛ build (through `0015`) takes `0016` alone; and a `0013` or `0014` that
/// arrives later still applies on top of both and keeps what they stored.
#[tokio::test]
async fn a_host_takes_0015_and_0016_together_and_a_later_0013_and_0014_on_top() {
    use std::borrow::Cow;

    use sqlx::migrate::{Migration, MigrationType, Migrator};
    use sqlx::{Connection, SqliteConnection};

    let of = |migrations: Vec<Migration>| Migrator {
        migrations: migrations.into(),
        ..Migrator::DEFAULT
    };
    let only = |keep: &dyn Fn(i64) -> bool| {
        of(markiro_host::db::MIGRATOR
            .iter()
            .filter(|migration| keep(migration.version))
            .cloned()
            .collect())
    };
    let versions = |applied: &[(i64, bool)]| applied.iter().map(|(v, _)| *v).collect::<Vec<_>>();
    let all: Vec<i64> = markiro_host::db::MIGRATOR
        .iter()
        .map(|migration| migration.version)
        .collect();
    assert!(
        all.contains(&15) && all.contains(&16) && !all.contains(&13) && !all.contains(&14),
        "{all:?}"
    );
    async fn applied(connection: &mut SqliteConnection) -> Vec<(i64, bool)> {
        sqlx::query_as("SELECT version, success FROM _sqlx_migrations ORDER BY version")
            .fetch_all(connection)
            .await
            .unwrap()
    }
    async fn initialized(connection: &mut SqliteConnection) -> Option<String> {
        sqlx::query_scalar("SELECT initialized_at FROM site WHERE id = 1")
            .fetch_one(connection)
            .await
            .unwrap()
    }
    const AT: &str = "2026-10-09T15:00:00Z";

    // Through 0012, then both in one start.
    let mut early = SqliteConnection::connect("sqlite::memory:").await.unwrap();
    only(&|version| version <= 12)
        .run(&mut early)
        .await
        .unwrap();
    let before = versions(&applied(&mut early).await);
    assert!(!before.contains(&15) && !before.contains(&16), "{before:?}");
    sqlx::query("UPDATE site SET initialized_at = ? WHERE id = 1")
        .bind(AT)
        .execute(&mut early)
        .await
        .unwrap();
    markiro_host::db::MIGRATOR.run(&mut early).await.unwrap();
    let after = applied(&mut early).await;
    assert_eq!(versions(&after), all);
    assert!(after.iter().all(|(_, success)| *success), "{after:?}");
    assert_eq!(initialized(&mut early).await.as_deref(), Some(AT));
    for table in ["warehouse_reprints", "org_logo", "pallet_sheet_templates"] {
        let rows: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table}"))
            .fetch_one(&mut early)
            .await
            .unwrap();
        assert_eq!(rows, 0, "{table}");
    }

    // The СКЛ build (0015, no 0016) takes 0016 alone.
    let mut skl = SqliteConnection::connect("sqlite::memory:").await.unwrap();
    only(&|version| version != 16).run(&mut skl).await.unwrap();
    let before = versions(&applied(&mut skl).await);
    assert!(before.contains(&15) && !before.contains(&16), "{before:?}");
    sqlx::query("UPDATE site SET initialized_at = ? WHERE id = 1")
        .bind(AT)
        .execute(&mut skl)
        .await
        .unwrap();
    markiro_host::db::MIGRATOR.run(&mut skl).await.unwrap();
    assert_eq!(versions(&applied(&mut skl).await), all);
    assert_eq!(initialized(&mut skl).await.as_deref(), Some(AT));

    // A later 0013 and 0014 apply on top of 0015 and 0016 and keep their rows.
    sqlx::query(
        "INSERT INTO org_logo (id, width, height, pixels_base64, updated_at) \
         VALUES (1, 10, 2, '8MAPQA==', '2026-10-11T09:00:00.000Z')",
    )
    .execute(&mut skl)
    .await
    .unwrap();
    let late = |version: i64| {
        Migration::new(
            version,
            Cow::Owned(format!("late {version}")),
            MigrationType::Simple,
            Cow::Owned(format!(
                "CREATE TABLE late_{version} (id INTEGER PRIMARY KEY);"
            )),
            false,
        )
    };
    let mut later: Vec<Migration> = markiro_host::db::MIGRATOR.iter().cloned().collect();
    later.extend([late(13), late(14)]);
    later.sort_by_key(|migration| migration.version);
    of(later).run(&mut skl).await.unwrap();
    let now = applied(&mut skl).await;
    let mut expected = all.clone();
    expected.extend([13, 14]);
    expected.sort_unstable();
    assert_eq!(versions(&now), expected);
    assert!(now.iter().all(|(_, success)| *success), "{now:?}");
    let logo: (i64, i64, String) =
        sqlx::query_as("SELECT width, height, pixels_base64 FROM org_logo WHERE id = 1")
            .fetch_one(&mut skl)
            .await
            .unwrap();
    assert_eq!(logo, (10, 2, "8MAPQA==".to_owned()));
    assert_eq!(initialized(&mut skl).await.as_deref(), Some(AT));
}
