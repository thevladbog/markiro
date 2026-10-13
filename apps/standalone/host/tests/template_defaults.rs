mod support;

use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{admin, audit_row, audit_rows, audit_trail, host_revision, tombstones, Admin};
use support::app::{
    login, pair_device, seed_office_user, turn_the_user_off_at_the_next_activity, TestApp,
};

const DEFAULTS: &str = "/v1/office/template-defaults";

/// A template through the office; returns its id.
async fn template(admin: &Admin, purpose: &str, enabled: bool, codes: Value) -> String {
    let (status, created) = admin
        .call(
            "POST",
            "/v1/office/templates",
            Some(json!({
                "name": format!("Шаблон {purpose}"), "purpose": purpose, "enabled": enabled,
                "chzProductGroupCodes": codes, "spec": { "widthMm": 58, "heightMm": 40 }
            })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    created["id"].as_str().unwrap().to_owned()
}

/// The templates the tests choose among.
struct Templates {
    universal: String,
    milk: String,
    pallet: String,
    disabled: String,
}

async fn templates(admin: &Admin) -> Templates {
    Templates {
        universal: template(admin, "box", true, Value::Null).await,
        milk: template(admin, "box", true, json!([8])).await,
        pallet: template(admin, "pallet", true, Value::Null).await,
        disabled: template(admin, "box", false, Value::Null).await,
    }
}

fn slot(code: u32, purpose: &str, template_id: &str) -> Value {
    json!({ "chzProductGroupCode": code, "purpose": purpose, "templateId": template_id })
}

async fn document(admin: &Admin) -> Value {
    let (status, document) = admin.call("GET", DEFAULTS, None).await;
    assert_eq!(status, StatusCode::OK, "{document}");
    document
}

async fn put(admin: &Admin, body: Value) -> (StatusCode, Value) {
    admin.call("PUT", DEFAULTS, Some(body)).await
}

#[tokio::test]
async fn the_defaults_are_one_document_and_stations_get_them() {
    let admin = admin().await;
    let t = templates(&admin).await;
    // The organization's record is the only part yet: the wizard wrote it.
    assert_eq!(
        document(&admin).await,
        json!({
            "defaultBoxTemplateId": null, "defaultPalletTemplateId": null,
            "defaultDuplicateTemplateId": null, "categories": [], "defaultPalletSheetId": null, "palletSheetCategories": [],
            "rev": 1
        })
    );
    let before = host_revision(&admin.app).await;

    let (status, set) = put(
        &admin,
        json!({
            "defaultBoxTemplateId": t.universal, "defaultPalletTemplateId": t.pallet,
            "categories": [slot(15, "box", &t.universal), slot(8, "box", &t.milk), slot(8, "pallet", &t.pallet)],
            "expectedRev": 1
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{set}");
    let rev = before + 1;
    // Categories come back by code, then purpose.
    let categories = json!([
        slot(8, "box", &t.milk),
        slot(8, "pallet", &t.pallet),
        slot(15, "box", &t.universal)
    ]);
    assert_eq!(
        set,
        json!({
            "defaultBoxTemplateId": t.universal, "defaultPalletTemplateId": t.pallet,
            "defaultDuplicateTemplateId": null, "categories": categories, "defaultPalletSheetId": null, "palletSheetCategories": [],
            "rev": rev
        })
    );
    assert_eq!(
        audit_trail(&admin.app, "template_defaults.update").await,
        vec![admin.row(
            "template_defaults.update",
            "template_defaults",
            "1",
            json!({
                "changed": ["defaultBoxTemplateId", "defaultPalletTemplateId", "categories"],
                "defaultBoxTemplateId": { "from": null, "to": t.universal },
                "defaultPalletTemplateId": { "from": null, "to": t.pallet },
                "categories": { "from": [], "to": categories }
            })
        )]
    );
    // Every role reads the document.
    let tech = admin.technologist().await;
    let (status, read) = admin.call_as(&tech, "GET", DEFAULTS, None).await;
    assert_eq!((status, read), (StatusCode::OK, set));
    // Stations get each category default under its slot, and the
    // organization's defaults in its record.
    let item = |id: &str, data: Value| json!({ "entity": "category_template_defaults", "id": id, "rev": rev, "deleted": false, "data": data });
    assert_eq!(
        admin.feed(before).await,
        json!([
            item("15:box", slot(15, "box", &t.universal)),
            item("8:box", slot(8, "box", &t.milk)),
            item("8:pallet", slot(8, "pallet", &t.pallet)),
            {
                "entity": "org_profile", "id": "1", "rev": rev, "deleted": false,
                "data": {
                    "name": "ООО «Атолл»", "inn": "7701234567", "gln": "4600682000010",
                    "gs1Prefixes": ["4600682"], "timeZone": "Europe/Moscow",
                    "defaultBoxTemplateId": t.universal, "defaultPalletTemplateId": t.pallet,
                    "defaultDuplicateTemplateId": null
                }
            }
        ])
    );
}

#[tokio::test]
async fn a_cleared_category_default_leaves_a_tombstone_that_setting_it_again_drops() {
    let admin = admin().await;
    let t = templates(&admin).await;
    let (status, set) = put(
        &admin,
        json!({ "categories": [slot(8, "box", &t.milk)], "expectedRev": 1 }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{set}");
    let set_rev = set["rev"].as_i64().unwrap();

    let (status, cleared) = put(&admin, json!({ "categories": [], "expectedRev": set_rev })).await;
    assert_eq!(status, StatusCode::OK, "{cleared}");
    let cleared_rev = cleared["rev"].as_i64().unwrap();
    assert_eq!(cleared_rev, set_rev + 1);
    // Only the tombstone: the organization's record did not change.
    assert_eq!(
        admin.feed(set_rev).await,
        json!([{ "entity": "category_template_defaults", "id": "8:box", "rev": cleared_rev, "deleted": true }])
    );
    assert_eq!(
        tombstones(&admin.app).await,
        vec![(
            "category_template_defaults".to_owned(),
            "8:box".to_owned(),
            cleared_rev
        )]
    );

    let (status, again) = put(
        &admin,
        json!({ "categories": [slot(8, "box", &t.universal)], "expectedRev": cleared_rev }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{again}");
    let again_rev = again["rev"].as_i64().unwrap();
    assert!(tombstones(&admin.app).await.is_empty());
    assert_eq!(
        admin.feed(cleared_rev).await,
        json!([{
            "entity": "category_template_defaults", "id": "8:box", "rev": again_rev, "deleted": false,
            "data": slot(8, "box", &t.universal)
        }])
    );
    assert_eq!(
        audit_trail(&admin.app, "template_defaults.update")
            .await
            .len(),
        3
    );
}

#[tokio::test]
async fn every_default_must_fit_its_slot() {
    let admin = admin().await;
    let t = templates(&admin).await;
    let unknown = "9b2e4a6c-0000-4000-8000-000000000000";
    let revision = host_revision(&admin.app).await;
    let rows = audit_rows(&admin.app).await;
    for (body, field) in [
        // Another purpose, scoped (the organization's default covers every
        // category), disabled, unknown.
        (
            json!({ "defaultBoxTemplateId": t.pallet }),
            "defaultBoxTemplateId",
        ),
        (
            json!({ "defaultBoxTemplateId": t.milk }),
            "defaultBoxTemplateId",
        ),
        (
            json!({ "defaultBoxTemplateId": t.disabled }),
            "defaultBoxTemplateId",
        ),
        (
            json!({ "defaultDuplicateTemplateId": t.universal }),
            "defaultDuplicateTemplateId",
        ),
        (
            json!({ "defaultPalletTemplateId": unknown }),
            "defaultPalletTemplateId",
        ),
        // A category default must cover its category.
        (
            json!({ "categories": [slot(15, "box", &t.milk)] }),
            "categories.0.templateId",
        ),
        (
            json!({ "categories": [slot(8, "pallet", &t.universal)] }),
            "categories.0.templateId",
        ),
        (
            json!({ "categories": [slot(18, "box", &t.universal)] }),
            "categories.0.chzProductGroupCode",
        ),
        (
            json!({ "categories": [slot(8, "box", &t.universal), slot(8, "box", &t.milk)] }),
            "categories.1",
        ),
    ] {
        let mut body = body;
        if body.get("categories").is_none() {
            body["categories"] = json!([]);
        }
        body["expectedRev"] = json!(1);
        let (status, refused) = put(&admin, body.clone()).await;
        assert_eq!(
            (status, refused["error"]["details"]["field"].clone()),
            (StatusCode::BAD_REQUEST, json!(field)),
            "{body}"
        );
    }
    for body in [
        json!({ "categories": [{ "chzProductGroupCode": 8, "purpose": "label", "templateId": t.universal }], "expectedRev": 1 }),
        json!({ "categories": [], "expectedRev": 1, "defaultLabelTemplateId": t.universal }),
    ] {
        let (status, refused) = put(&admin, body).await;
        assert_eq!(
            (status, refused["error"]["code"].clone()),
            (StatusCode::BAD_REQUEST, json!("validation_failed"))
        );
    }
    assert_eq!(host_revision(&admin.app).await, revision);
    assert_eq!(audit_rows(&admin.app).await, rows);
}

#[tokio::test]
async fn an_older_document_is_refused_and_an_unchanged_one_writes_nothing() {
    let admin = admin().await;
    let t = templates(&admin).await;
    let body = |pallet: Option<&str>, expected_rev: i64| {
        json!({
            "defaultBoxTemplateId": t.universal, "defaultPalletTemplateId": pallet,
            "categories": [], "expectedRev": expected_rev
        })
    };
    let (status, set) = put(&admin, body(None, 1)).await;
    assert_eq!(status, StatusCode::OK, "{set}");
    let rev = set["rev"].as_i64().unwrap();
    let (status, refused) = put(&admin, body(Some(&t.pallet), 1)).await;
    assert_eq!(
        (
            status,
            refused["error"]["code"].clone(),
            refused["error"]["details"]["currentRev"].clone()
        ),
        (StatusCode::CONFLICT, json!("stale_revision"), json!(rev))
    );
    let (status, same) = put(&admin, body(None, rev)).await;
    assert_eq!((status, same), (StatusCode::OK, set));
    assert_eq!(host_revision(&admin.app).await, rev);
    assert_eq!(
        audit_trail(&admin.app, "template_defaults.update")
            .await
            .len(),
        1
    );

    // A change of the organization's record moves the document too.
    let (status, org) = admin.call("GET", "/v1/office/org", None).await;
    assert_eq!(status, StatusCode::OK);
    let (status, renamed) = admin
        .call(
            "PUT",
            "/v1/office/org",
            Some(json!({
                "name": "ООО «Атолл-Юг»", "inn": org["inn"], "gln": org["gln"],
                "gs1Prefixes": org["gs1Prefixes"], "timeZone": org["timeZone"], "expectedRev": org["rev"]
            })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{renamed}");
    assert_eq!(document(&admin).await["rev"], renamed["rev"]);
    let (status, refused) = put(&admin, body(Some(&t.pallet), rev)).await;
    assert_eq!(
        (status, refused["error"]["details"]["currentRev"].clone()),
        (StatusCode::CONFLICT, renamed["rev"].clone())
    );
}

#[tokio::test]
async fn a_default_set_here_keeps_its_template_from_being_disabled() {
    let admin = admin().await;
    let t = templates(&admin).await;
    let (status, _) = put(
        &admin,
        json!({ "defaultBoxTemplateId": t.universal, "categories": [], "expectedRev": 1 }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, refused) = admin
        .call(
            "PUT",
            &format!("/v1/office/templates/{}", t.universal),
            Some(json!({ "enabled": false, "expectedRev": 2 })),
        )
        .await;
    assert_eq!(
        (status, refused["error"]["details"]["constraint"].clone()),
        (StatusCode::CONFLICT, json!("template_is_default"))
    );
}

#[tokio::test]
async fn technologists_set_the_defaults() {
    let admin = admin().await;
    let t = templates(&admin).await;
    let (tech, tech_id) = admin.technologist_session().await;
    let (status, set) = admin
        .call_as(
            &tech,
            "PUT",
            DEFAULTS,
            Some(json!({ "categories": [slot(8, "box", &t.milk)], "expectedRev": 1 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{set}");
    assert_eq!(
        audit_trail(&admin.app, "template_defaults.update").await,
        vec![audit_row(
            &tech_id,
            "template_defaults.update",
            "template_defaults",
            "1",
            json!({
                "changed": ["categories"],
                "categories": { "from": [], "to": [slot(8, "box", &t.milk)] }
            })
        )]
    );
}

// Everything below goes beyond the plan's six tests. It pins the route's own
// guards (`require_catalog_in` inside the transaction, the session), both
// sides of the revision compare, and the paths the plan's tests leave
// unwalked: a duplicate default, an organization default cleared, a category
// default changed in place, and the order the comparison depends on.

/// The organization's record as a feed page carries it: its profile as the
/// office reads it now, and the three default template ids.
async fn org_item(admin: &Admin, rev: i64, defaults: [Value; 3]) -> Value {
    let (status, org) = admin.call("GET", "/v1/office/org", None).await;
    assert_eq!(status, StatusCode::OK, "{org}");
    let [box_id, pallet_id, duplicate_id] = defaults;
    json!({
        "entity": "org_profile", "id": "1", "rev": rev, "deleted": false,
        "data": {
            "name": org["name"], "inn": org["inn"], "gln": org["gln"],
            "gs1Prefixes": org["gs1Prefixes"], "timeZone": org["timeZone"],
            "defaultBoxTemplateId": box_id, "defaultPalletTemplateId": pallet_id,
            "defaultDuplicateTemplateId": duplicate_id
        }
    })
}

/// A category default as a feed page carries it.
fn category_item(rev: i64, entry: &Value) -> Value {
    json!({
        "entity": "category_template_defaults",
        "id": format!("{}:{}", entry["chzProductGroupCode"], entry["purpose"].as_str().unwrap()),
        "rev": rev, "deleted": false, "data": entry
    })
}

/// The route calls `require_catalog_in` itself, not only the helper
/// (`products.rs` proves the helper): a technologist is turned off after the
/// extractor read them as active and before the write transaction begins. A
/// trigger does it at the moment the extractor records the session's activity
/// (it does once a minute), so the order is the same on every run. A write is
/// refused as an ended session whether it would change the document or not.
/// The session is still there afterwards, which the extractor would not leave
/// behind a user it found turned off, so the refusal is the route's own, and
/// nothing changed.
#[tokio::test]
async fn template_defaults_writes_stop_a_user_turned_off_after_the_extractor_passed() {
    let admin = admin().await;
    let t = templates(&admin).await;
    let (tech, tech_id) = admin.technologist_session().await;
    let session_id: String = sqlx::query_scalar("SELECT id FROM office_sessions WHERE user_id = ?")
        .bind(&tech_id)
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    let read = document(&admin).await;
    let revision = host_revision(&admin.app).await;
    let rows = audit_rows(&admin.app).await;
    turn_the_user_off_at_the_next_activity(&admin.app, &tech_id).await;

    for (round, body) in [
        (
            "a change",
            json!({ "defaultBoxTemplateId": t.universal, "categories": [], "expectedRev": read["rev"] }),
        ),
        (
            "no change",
            json!({ "categories": [], "expectedRev": read["rev"] }),
        ),
    ] {
        // Let a minute pass, so that the extractor records activity, and turn
        // the user back on for this round.
        admin.app.clock.advance(time::Duration::minutes(2));
        sqlx::query("UPDATE office_users SET active = 1 WHERE id = ?")
            .bind(&tech_id)
            .execute(&admin.app.state.pool)
            .await
            .unwrap();
        let (status, error) = admin.call_as(&tech, "PUT", DEFAULTS, Some(body)).await;
        assert_eq!(
            (
                status,
                error["error"]["code"].clone(),
                error["error"]["details"]["credential"].clone()
            ),
            (
                StatusCode::UNAUTHORIZED,
                json!("unauthorized"),
                json!("session")
            ),
            "{round}"
        );
        let active: i64 = sqlx::query_scalar("SELECT active FROM office_users WHERE id = ?")
            .bind(&tech_id)
            .fetch_one(&admin.app.state.pool)
            .await
            .unwrap();
        assert_eq!(active, 0, "the trigger ran after the extractor: {round}");
        let sessions: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM office_sessions WHERE id = ?")
            .bind(&session_id)
            .fetch_one(&admin.app.state.pool)
            .await
            .unwrap();
        assert_eq!(
            sessions, 1,
            "the refusal is the route's, not the extractor's: {round}"
        );
        assert_eq!(host_revision(&admin.app).await, revision, "{round}");
        assert_eq!(audit_rows(&admin.app).await, rows, "{round}");
        assert_eq!(document(&admin).await, read, "{round}");
    }
}

/// A `PUT` over a revision that is not the document's is stale whichever side
/// it errs on: one older than the document (it changed since it was read) and
/// one ahead of it (a client that never read it). Each answers the document's
/// own revision and writes nothing; the same body over the right revision is
/// accepted, so the revision is the only thing wrong with it.
#[tokio::test]
async fn a_put_over_a_revision_older_or_ahead_of_the_document_is_stale() {
    let admin = admin().await;
    let t = templates(&admin).await;
    let (status, set) = put(
        &admin,
        json!({
            "defaultBoxTemplateId": t.universal,
            "categories": [slot(8, "box", &t.milk)],
            "expectedRev": 1
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{set}");
    let rev = set["rev"].as_i64().unwrap();
    assert!(rev > 2, "the document moved on from the wizard's revision");
    let revision = host_revision(&admin.app).await;
    let rows = audit_rows(&admin.app).await;
    let body = |expected_rev: i64| {
        json!({
            "defaultPalletTemplateId": t.pallet,
            "categories": [slot(8, "box", &t.milk)],
            "expectedRev": expected_rev
        })
    };
    for (side, expected_rev) in [("older", 1), ("just older", rev - 1), ("ahead", rev + 1)] {
        let (status, refused) = put(&admin, body(expected_rev)).await;
        assert_eq!(
            (
                status,
                refused["error"]["code"].clone(),
                refused["error"]["details"]["currentRev"].clone()
            ),
            (StatusCode::CONFLICT, json!("stale_revision"), json!(rev)),
            "{side}"
        );
        assert_eq!(host_revision(&admin.app).await, revision, "{side}");
        assert_eq!(audit_rows(&admin.app).await, rows, "{side}");
        assert_eq!(document(&admin).await, set, "{side}");
    }
    let (status, accepted) = put(&admin, body(rev)).await;
    assert_eq!(status, StatusCode::OK, "{accepted}");
    assert_eq!(accepted["rev"], json!(revision + 1));
    assert_eq!(accepted["defaultPalletTemplateId"], json!(t.pallet));
}

/// The document's revision is the newest of the organization's record, the
/// category defaults and the tombstones of cleared ones, so a form opened
/// before an edit of the organization's profile (`PUT /v1/office/org`) is
/// stale (the plan accepts this for the sake of one revision with no new
/// column): even a form that says what the document says now. The edit leaves
/// the defaults as they were.
#[tokio::test]
async fn an_edit_of_the_organization_profile_raises_the_documents_revision() {
    let admin = admin().await;
    let t = templates(&admin).await;
    let (status, set) = put(
        &admin,
        json!({
            "defaultBoxTemplateId": t.universal,
            "categories": [slot(8, "box", &t.milk)],
            "expectedRev": 1
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{set}");
    let opened = set["rev"].as_i64().unwrap();

    let (status, org) = admin.call("GET", "/v1/office/org", None).await;
    assert_eq!(status, StatusCode::OK, "{org}");
    let (status, renamed) = admin
        .call(
            "PUT",
            "/v1/office/org",
            Some(json!({
                "name": "ООО «Атолл-Юг»", "inn": org["inn"], "gln": org["gln"],
                "gs1Prefixes": org["gs1Prefixes"], "timeZone": org["timeZone"], "expectedRev": org["rev"]
            })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{renamed}");
    let raised = renamed["rev"].as_i64().unwrap();
    assert_eq!(raised, opened + 1);
    assert_eq!(
        document(&admin).await,
        json!({
            "defaultBoxTemplateId": t.universal, "defaultPalletTemplateId": null,
            "defaultDuplicateTemplateId": null,
            "categories": [slot(8, "box", &t.milk)], "defaultPalletSheetId": null, "palletSheetCategories": [],
            "rev": raised
        })
    );

    let revision = host_revision(&admin.app).await;
    let rows = audit_rows(&admin.app).await;
    for (form, body) in [
        (
            "one that changes the defaults",
            json!({ "categories": [], "expectedRev": opened }),
        ),
        (
            "one that says what the document says",
            json!({
                "defaultBoxTemplateId": t.universal,
                "categories": [slot(8, "box", &t.milk)],
                "expectedRev": opened
            }),
        ),
    ] {
        let (status, refused) = put(&admin, body).await;
        assert_eq!(
            (
                status,
                refused["error"]["code"].clone(),
                refused["error"]["details"]["currentRev"].clone()
            ),
            (StatusCode::CONFLICT, json!("stale_revision"), json!(raised)),
            "{form}"
        );
        assert_eq!(host_revision(&admin.app).await, revision, "{form}");
        assert_eq!(audit_rows(&admin.app).await, rows, "{form}");
    }
    // Read again, the form is accepted.
    let (status, cleared) = put(
        &admin,
        json!({ "defaultBoxTemplateId": t.universal, "categories": [], "expectedRev": raised }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{cleared}");
    assert_eq!(cleared["rev"], json!(revision + 1));
    assert_eq!(cleared["categories"], json!([]));
}

/// Only the tombstones of cleared category defaults count toward the
/// document's revision. A template that is no default, deleted, leaves a
/// tombstone of its own at a newer revision, and the document stays at the
/// revision a form read: the read says so, and a `PUT` over it is accepted,
/// where a revision that moved with every tombstone (an operator turned off,
/// a badge revoked, any template deleted) would make an open form stale for
/// a change nobody made to the defaults.
#[tokio::test]
async fn an_unrelated_tombstone_does_not_move_the_documents_revision() {
    let admin = admin().await;
    let t = templates(&admin).await;
    let (status, set) = put(
        &admin,
        json!({
            "defaultBoxTemplateId": t.universal,
            "categories": [slot(8, "box", &t.milk)],
            "expectedRev": 1
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{set}");
    let opened = set["rev"].as_i64().unwrap();

    // The disabled template is no default of any slot.
    let (status, _) = admin
        .call(
            "DELETE",
            &format!("/v1/office/templates/{}", t.disabled),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(
        tombstones(&admin.app).await,
        vec![("label_templates".to_owned(), t.disabled.clone(), opened + 1)],
        "the delete left a tombstone newer than the document"
    );
    assert_eq!(document(&admin).await, set);

    let revision = host_revision(&admin.app).await;
    let (status, cleared) = put(
        &admin,
        json!({ "defaultBoxTemplateId": t.universal, "categories": [], "expectedRev": opened }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{cleared}");
    assert_eq!(cleared["rev"], json!(revision + 1));
    assert_eq!(cleared["categories"], json!([]));
}

/// The duplicate slot takes a duplicate template, for the organization and for
/// a category, as the others take theirs (the plan's tests set the box and
/// pallet defaults and refuse a wrong template for the duplicate slot, but
/// never fill it): for every category in the organization's slot, covering the
/// category in a category's; nothing else.
#[tokio::test]
async fn the_duplicate_default_takes_a_duplicate_template() {
    let admin = admin().await;
    let t = templates(&admin).await;
    let duplicate = template(&admin, "product_duplicate", true, Value::Null).await;
    let duplicate_milk = template(&admin, "product_duplicate", true, json!([8])).await;
    let duplicate_off = template(&admin, "product_duplicate", false, Value::Null).await;
    let before = host_revision(&admin.app).await;
    let (status, set) = put(
        &admin,
        json!({
            "defaultDuplicateTemplateId": duplicate,
            "categories": [
                slot(15, "product_duplicate", &duplicate),
                slot(8, "product_duplicate", &duplicate_milk)
            ],
            "expectedRev": 1
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{set}");
    let rev = before + 1;
    let categories = json!([
        slot(8, "product_duplicate", &duplicate_milk),
        slot(15, "product_duplicate", &duplicate)
    ]);
    assert_eq!(
        set,
        json!({
            "defaultBoxTemplateId": null, "defaultPalletTemplateId": null,
            "defaultDuplicateTemplateId": duplicate, "categories": categories, "defaultPalletSheetId": null, "palletSheetCategories": [],
            "rev": rev
        })
    );
    assert_eq!(
        audit_trail(&admin.app, "template_defaults.update").await,
        vec![admin.row(
            "template_defaults.update",
            "template_defaults",
            "1",
            json!({
                "changed": ["defaultDuplicateTemplateId", "categories"],
                "defaultDuplicateTemplateId": { "from": null, "to": duplicate },
                "categories": { "from": [], "to": categories }
            })
        )]
    );
    // Under their own keys, with the organization's record after them.
    assert_eq!(
        admin.feed(before).await,
        json!([
            category_item(rev, &slot(15, "product_duplicate", &duplicate)),
            category_item(rev, &slot(8, "product_duplicate", &duplicate_milk)),
            org_item(&admin, rev, [Value::Null, Value::Null, json!(duplicate)]).await
        ])
    );

    // The other purposes' templates do not fit it, nor a scoped template in
    // the organization's slot, nor a disabled one; and a duplicate template
    // fits no other slot.
    let revision = host_revision(&admin.app).await;
    let rows = audit_rows(&admin.app).await;
    for (body, field) in [
        (
            json!({ "defaultDuplicateTemplateId": duplicate_milk }),
            "defaultDuplicateTemplateId",
        ),
        (
            json!({ "defaultDuplicateTemplateId": duplicate_off }),
            "defaultDuplicateTemplateId",
        ),
        (
            json!({ "defaultBoxTemplateId": duplicate }),
            "defaultBoxTemplateId",
        ),
        (
            json!({ "defaultPalletTemplateId": duplicate }),
            "defaultPalletTemplateId",
        ),
        (
            json!({ "categories": [slot(8, "product_duplicate", &t.universal)] }),
            "categories.0.templateId",
        ),
        (
            json!({ "categories": [slot(8, "box", &duplicate)] }),
            "categories.0.templateId",
        ),
        (
            json!({ "categories": [slot(8, "pallet", &duplicate)] }),
            "categories.0.templateId",
        ),
        (
            json!({ "categories": [slot(15, "product_duplicate", &duplicate_milk)] }),
            "categories.0.templateId",
        ),
        (
            json!({ "categories": [slot(8, "product_duplicate", &duplicate_off)] }),
            "categories.0.templateId",
        ),
    ] {
        let mut body = body;
        if body.get("categories").is_none() {
            body["categories"] = json!([]);
        }
        body["expectedRev"] = json!(rev);
        let (status, refused) = put(&admin, body.clone()).await;
        assert_eq!(
            (status, refused["error"]["details"]["field"].clone()),
            (StatusCode::BAD_REQUEST, json!(field)),
            "{body}"
        );
    }
    assert_eq!(host_revision(&admin.app).await, revision);
    assert_eq!(audit_rows(&admin.app).await, rows);
}

/// An organization default left out of the document, or sent as `null`, is
/// cleared (the plan's tests only ever set one): the record is rewritten at
/// the new revision and rides the feed, no tombstone is written for it (only
/// a category default leaves the feed), and the audit row names what went.
#[tokio::test]
async fn an_organization_default_left_out_or_null_is_cleared() {
    let admin = admin().await;
    let t = templates(&admin).await;
    let duplicate = template(&admin, "product_duplicate", true, Value::Null).await;
    let (status, all) = put(
        &admin,
        json!({
            "defaultBoxTemplateId": t.universal, "defaultPalletTemplateId": t.pallet,
            "defaultDuplicateTemplateId": duplicate, "categories": [], "expectedRev": 1
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{all}");
    let all_rev = all["rev"].as_i64().unwrap();

    // The pallet default is `null` and the duplicate default is left out: both
    // are none, and the box default, sent again, stays.
    let (status, partly) = put(
        &admin,
        json!({
            "defaultBoxTemplateId": t.universal, "defaultPalletTemplateId": null,
            "categories": [], "expectedRev": all_rev
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{partly}");
    let partly_rev = partly["rev"].as_i64().unwrap();
    assert_eq!(partly_rev, all_rev + 1);
    assert_eq!(
        partly,
        json!({
            "defaultBoxTemplateId": t.universal, "defaultPalletTemplateId": null,
            "defaultDuplicateTemplateId": null, "categories": [], "defaultPalletSheetId": null, "palletSheetCategories": [],
            "rev": partly_rev
        })
    );
    assert_eq!(
        admin.feed(all_rev).await,
        json!([org_item(
            &admin,
            partly_rev,
            [json!(t.universal), Value::Null, Value::Null]
        )
        .await])
    );

    // Everything left out: the box default goes too.
    let (status, none) = put(
        &admin,
        json!({ "categories": [], "expectedRev": partly_rev }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{none}");
    let none_rev = none["rev"].as_i64().unwrap();
    assert_eq!(none_rev, partly_rev + 1);
    assert_eq!(
        none,
        json!({
            "defaultBoxTemplateId": null, "defaultPalletTemplateId": null,
            "defaultDuplicateTemplateId": null, "categories": [], "defaultPalletSheetId": null, "palletSheetCategories": [],
            "rev": none_rev
        })
    );
    assert_eq!(document(&admin).await, none);
    assert!(tombstones(&admin.app).await.is_empty());
    assert_eq!(
        audit_trail(&admin.app, "template_defaults.update").await,
        vec![
            admin.row(
                "template_defaults.update",
                "template_defaults",
                "1",
                json!({
                    "changed": ["defaultBoxTemplateId", "defaultPalletTemplateId", "defaultDuplicateTemplateId"],
                    "defaultBoxTemplateId": { "from": null, "to": t.universal },
                    "defaultPalletTemplateId": { "from": null, "to": t.pallet },
                    "defaultDuplicateTemplateId": { "from": null, "to": duplicate }
                })
            ),
            admin.row(
                "template_defaults.update",
                "template_defaults",
                "1",
                json!({
                    "changed": ["defaultPalletTemplateId", "defaultDuplicateTemplateId"],
                    "defaultPalletTemplateId": { "from": t.pallet, "to": null },
                    "defaultDuplicateTemplateId": { "from": duplicate, "to": null }
                })
            ),
            admin.row(
                "template_defaults.update",
                "template_defaults",
                "1",
                json!({
                    "changed": ["defaultBoxTemplateId"],
                    "defaultBoxTemplateId": { "from": t.universal, "to": null }
                })
            ),
        ]
    );
}

/// Category defaults come back by code then purpose however they were added,
/// and the same document sent in any order is no change at all: the read's
/// order and the comparison's sort have to agree for that, and each is
/// caught by one of the two orders sent here. (A default added after one of
/// a greater code is the case where the order of insertion is not the order of
/// the codes.)
#[tokio::test]
async fn category_defaults_are_listed_by_code_and_the_same_document_in_any_order_is_no_change() {
    let admin = admin().await;
    let t = templates(&admin).await;
    let (status, first) = put(
        &admin,
        json!({ "categories": [slot(15, "box", &t.universal)], "expectedRev": 1 }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{first}");
    let (status, both) = put(
        &admin,
        json!({
            "categories": [slot(15, "box", &t.universal), slot(8, "box", &t.milk)],
            "expectedRev": first["rev"]
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{both}");
    let rev = both["rev"].as_i64().unwrap();
    let listed = json!([slot(8, "box", &t.milk), slot(15, "box", &t.universal)]);
    assert_eq!(both["categories"], listed);
    assert_eq!(document(&admin).await, both);

    let revision = host_revision(&admin.app).await;
    let rows = audit_rows(&admin.app).await;
    for (order, categories) in [
        ("by code", listed.clone()),
        (
            "reversed",
            json!([slot(15, "box", &t.universal), slot(8, "box", &t.milk)]),
        ),
    ] {
        let (status, same) = put(
            &admin,
            json!({ "categories": categories, "expectedRev": rev }),
        )
        .await;
        assert_eq!((status, same), (StatusCode::OK, both.clone()), "{order}");
        assert_eq!(host_revision(&admin.app).await, revision, "{order}");
        assert_eq!(audit_rows(&admin.app).await, rows, "{order}");
    }
}

/// A category default whose template changes is rewritten in place at the new
/// revision, and only that one rides the feed (the plan's tests never change
/// a default that is there); one cleared among others leaves its tombstone and
/// nothing else, and the document's revision is then the tombstone's. The
/// audit rows carry the whole lists, as they were and as they became.
#[tokio::test]
async fn a_category_default_changes_in_place_and_only_that_one_rides_the_feed() {
    let admin = admin().await;
    let t = templates(&admin).await;
    let (status, set) = put(
        &admin,
        json!({
            "categories": [slot(8, "box", &t.milk), slot(15, "box", &t.universal)],
            "expectedRev": 1
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{set}");
    let set_rev = set["rev"].as_i64().unwrap();

    // The milk default takes the template for every category.
    let (status, changed) = put(
        &admin,
        json!({
            "categories": [slot(8, "box", &t.universal), slot(15, "box", &t.universal)],
            "expectedRev": set_rev
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{changed}");
    let changed_rev = changed["rev"].as_i64().unwrap();
    assert_eq!(changed_rev, set_rev + 1);
    assert_eq!(
        changed,
        json!({
            "defaultBoxTemplateId": null, "defaultPalletTemplateId": null,
            "defaultDuplicateTemplateId": null,
            "categories": [slot(8, "box", &t.universal), slot(15, "box", &t.universal)],
            "defaultPalletSheetId": null, "palletSheetCategories": [],
            "rev": changed_rev
        })
    );
    assert_eq!(
        admin.feed(set_rev).await,
        json!([category_item(changed_rev, &slot(8, "box", &t.universal))])
    );
    assert!(tombstones(&admin.app).await.is_empty());

    // The other one cleared: its tombstone is all the feed gets.
    let (status, cleared) = put(
        &admin,
        json!({ "categories": [slot(15, "box", &t.universal)], "expectedRev": changed_rev }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{cleared}");
    let cleared_rev = cleared["rev"].as_i64().unwrap();
    assert_eq!(cleared_rev, changed_rev + 1);
    assert_eq!(
        cleared["categories"],
        json!([slot(15, "box", &t.universal)])
    );
    assert_eq!(document(&admin).await, cleared);
    assert_eq!(
        admin.feed(changed_rev).await,
        json!([{ "entity": "category_template_defaults", "id": "8:box", "rev": cleared_rev, "deleted": true }])
    );
    assert_eq!(
        tombstones(&admin.app).await,
        vec![(
            "category_template_defaults".to_owned(),
            "8:box".to_owned(),
            cleared_rev
        )]
    );
    let row = |from: Value, to: Value| {
        admin.row(
            "template_defaults.update",
            "template_defaults",
            "1",
            json!({ "changed": ["categories"], "categories": { "from": from, "to": to } }),
        )
    };
    assert_eq!(
        audit_trail(&admin.app, "template_defaults.update").await,
        vec![
            row(
                json!([]),
                json!([slot(8, "box", &t.milk), slot(15, "box", &t.universal)])
            ),
            row(
                json!([slot(8, "box", &t.milk), slot(15, "box", &t.universal)]),
                json!([slot(8, "box", &t.universal), slot(15, "box", &t.universal)])
            ),
            row(
                json!([slot(8, "box", &t.universal), slot(15, "box", &t.universal)]),
                json!([slot(15, "box", &t.universal)])
            ),
        ]
    );
}

/// A refusal names the entry that failed, not the first one: the plan's cases
/// all put the failing entry first except the repeated slot. The body is
/// refused as such over a revision that is not the document's, before the
/// revision is looked at.
#[tokio::test]
async fn a_refusal_names_the_entry_that_failed_and_comes_before_the_revision_compare() {
    let admin = admin().await;
    let t = templates(&admin).await;
    let revision = host_revision(&admin.app).await;
    let rows = audit_rows(&admin.app).await;
    for (categories, field) in [
        (
            json!([slot(8, "box", &t.universal), slot(15, "box", &t.milk)]),
            "categories.1.templateId",
        ),
        (
            json!([slot(8, "box", &t.universal), slot(18, "box", &t.universal)]),
            "categories.1.chzProductGroupCode",
        ),
        (
            json!([
                slot(8, "box", &t.universal),
                slot(15, "box", &t.universal),
                slot(8, "box", &t.milk)
            ]),
            "categories.2",
        ),
        // The first entry that fails is the one named.
        (
            json!([slot(15, "box", &t.milk), slot(18, "box", &t.universal)]),
            "categories.0.templateId",
        ),
    ] {
        let (status, refused) = put(
            &admin,
            json!({ "categories": categories, "expectedRev": 999 }),
        )
        .await;
        assert_eq!(
            (
                status,
                refused["error"]["code"].clone(),
                refused["error"]["details"]["field"].clone()
            ),
            (
                StatusCode::BAD_REQUEST,
                json!("validation_failed"),
                json!(field)
            ),
            "{categories}"
        );
    }
    assert_eq!(host_revision(&admin.app).await, revision);
    assert_eq!(audit_rows(&admin.app).await, rows);
}

/// Before the wizard there is no organization, so there is no document: the
/// read and the write answer `not_found` (the write after its body was
/// checked), and neither leaves a trace. The control is a host that has run
/// the wizard, which answers both.
#[tokio::test]
async fn before_the_wizard_there_is_no_document_to_read_or_write() {
    let wizard = admin().await;
    let read = document(&wizard).await;
    let (status, same) = put(
        &wizard,
        json!({ "categories": [], "expectedRev": read["rev"] }),
    )
    .await;
    assert_eq!((status, same), (StatusCode::OK, read));

    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "station").await;
    let id = seed_office_user(&app, "admin", "admin", "correct horse battery").await;
    let token = login(&app, &key, "admin", "correct horse battery").await;
    let admin = Admin {
        app,
        key,
        token,
        id,
    };
    let revision = host_revision(&admin.app).await;
    let rows = audit_rows(&admin.app).await;
    for (method, body) in [
        ("GET", None),
        ("PUT", Some(json!({ "categories": [], "expectedRev": 1 }))),
    ] {
        let (status, refused) = admin.call(method, DEFAULTS, body).await;
        assert_eq!(
            (status, refused["error"]["code"].clone()),
            (StatusCode::NOT_FOUND, json!("not_found")),
            "{method}"
        );
    }
    // The body comes first: a slot given twice, and a template that is not
    // there, are refused as such, not as a document that is not there.
    for (body, field) in [
        (
            json!({ "categories": [slot(8, "box", "a"), slot(8, "box", "b")], "expectedRev": 1 }),
            "categories.1",
        ),
        (
            json!({ "defaultBoxTemplateId": "a", "categories": [], "expectedRev": 1 }),
            "defaultBoxTemplateId",
        ),
    ] {
        let (status, refused) = admin.call("PUT", DEFAULTS, Some(body.clone())).await;
        assert_eq!(
            (status, refused["error"]["details"]["field"].clone()),
            (StatusCode::BAD_REQUEST, json!(field)),
            "{body}"
        );
    }
    assert_eq!(host_revision(&admin.app).await, revision);
    assert_eq!(audit_rows(&admin.app).await, rows);
}

/// Every office role reads the document; without an office session (a device
/// key alone, or nothing) neither the read nor the write is answered, and the
/// write changes nothing.
#[tokio::test]
async fn the_defaults_are_read_by_every_role_and_only_with_an_office_session() {
    let admin = admin().await;
    let tech = admin.technologist().await;
    let t = templates(&admin).await;
    let (status, set) = put(
        &admin,
        json!({
            "defaultBoxTemplateId": t.universal,
            "categories": [slot(8, "box", &t.milk)],
            "expectedRev": 1
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{set}");
    for token in [admin.token.clone(), tech] {
        let (status, read) = admin.call_as(&token, "GET", DEFAULTS, None).await;
        assert_eq!((status, read), (StatusCode::OK, set.clone()));
    }
    let revision = host_revision(&admin.app).await;
    let rows = audit_rows(&admin.app).await;
    let write = json!({ "categories": [], "expectedRev": set["rev"] });
    for (method, credential) in [
        ("GET", Some("session")),
        ("PUT", Some("session")),
        ("GET", None),
        ("PUT", None),
    ] {
        let builder = support::app::request(method, DEFAULTS);
        let builder = match credential {
            Some(_) => support::app::with_device(builder, &admin.key),
            None => builder,
        };
        let request = match method {
            "PUT" => support::app::json(builder, write.clone()),
            _ => support::app::empty(builder),
        };
        let (status, refused) = admin.app.send(request).await;
        assert_eq!(
            (status, refused["error"]["details"]["credential"].clone()),
            (
                StatusCode::UNAUTHORIZED,
                json!(credential.unwrap_or("device"))
            ),
            "{method} {credential:?}"
        );
    }
    assert_eq!(host_revision(&admin.app).await, revision);
    assert_eq!(audit_rows(&admin.app).await, rows);
}

/// A body that is not the document, a part left out or of the wrong kind or
/// one more than the document has, is refused whole as `validation_failed`
/// with no `field` (it could not be read), and writes nothing.
#[tokio::test]
async fn a_body_that_is_not_the_document_is_refused_whole() {
    let admin = admin().await;
    let t = templates(&admin).await;
    let revision = host_revision(&admin.app).await;
    let rows = audit_rows(&admin.app).await;
    for body in [
        // Parts left out: `categories` and `expectedRev` are the document's own.
        json!({ "expectedRev": 1 }),
        json!({ "categories": [] }),
        // The wrong kind.
        json!({ "categories": null, "expectedRev": 1 }),
        json!({ "categories": [], "expectedRev": "1" }),
        json!({ "defaultBoxTemplateId": 5, "categories": [], "expectedRev": 1 }),
        // One more than the document has: the document's own `rev` is read-only.
        json!({ "categories": [], "expectedRev": 1, "rev": 1 }),
        // An entry that is not a slot.
        json!({ "categories": [{ "chzProductGroupCode": 8, "purpose": "box" }], "expectedRev": 1 }),
        json!({ "categories": [{ "chzProductGroupCode": -8, "purpose": "box", "templateId": t.universal }], "expectedRev": 1 }),
        json!({ "categories": [{ "chzProductGroupCode": 8, "purpose": "box", "templateId": 5 }], "expectedRev": 1 }),
        json!({ "categories": [{ "chzProductGroupCode": 8, "purpose": "box", "templateId": t.universal, "rev": 1 }], "expectedRev": 1 }),
    ] {
        let (status, refused) = put(&admin, body.clone()).await;
        assert_eq!(
            (
                status,
                refused["error"]["code"].clone(),
                refused["error"]["details"].clone()
            ),
            (
                StatusCode::BAD_REQUEST,
                json!("validation_failed"),
                Value::Null
            ),
            "{body}"
        );
    }
    assert_eq!(host_revision(&admin.app).await, revision);
    assert_eq!(audit_rows(&admin.app).await, rows);
}
