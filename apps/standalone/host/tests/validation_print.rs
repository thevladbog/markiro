//! The print policy of a validation shift on the host (plan РЕЖ, task B3):
//! the office plans and edits it (`validationPrint`, a `product_duplicate`
//! template that fits the product), a planned shift alone changes it, a
//! station enters a shift that prints only when it names both capabilities,
//! and the snapshot freezes the duplicate template whole.

mod support;

use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{
    admin, audit_rows, audit_trail, empty, host_revision, json as json_request, office_template,
    plan_shift, request, shift_body, shift_setup, with_device, Admin, ShiftSetup,
};

const BOTH: [&str; 2] = ["validation-v1", "validation-dm-duplicate-v1"];

fn path(shift: &Value) -> String {
    format!("/v1/office/shifts/{}", shift["id"].as_str().unwrap())
}

fn refusal(body: &Value) -> (Value, Value) {
    (
        body["error"]["code"].clone(),
        body["error"]["details"].clone(),
    )
}

fn field(name: &str) -> (Value, Value) {
    (json!("validation_failed"), json!({ "field": name }))
}

fn printing(template: &str, verification: &str) -> Value {
    json!({ "mode": "duplicate_dm", "verification": verification, "templateId": template })
}

/// `shift_body(setup)` as a validation shift with `policy`.
fn validation_body(setup: &ShiftSetup, policy: Option<Value>) -> Value {
    let mut body = shift_body(setup);
    body["mode"] = json!("validation");
    if let Some(policy) = policy {
        body["validationPrint"] = policy;
    }
    body
}

/// The policy columns of shift `id`, as stored.
async fn columns(admin: &Admin, id: &str) -> (String, String, Option<String>, Option<String>) {
    sqlx::query_as(
        "SELECT mode, validation_print_mode, validation_print_verification, \
         validation_print_template_id FROM shifts WHERE id = ?",
    )
    .bind(id)
    .fetch_one(&admin.app.state.pool)
    .await
    .unwrap()
}

/// How many shifts the host holds.
async fn shift_count(admin: &Admin) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM shifts")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap()
}

/// What a refused office request must leave as it was.
async fn untouched(admin: &Admin) -> (i64, i64, i64, Value) {
    type PolicyRow = (String, i64, String, Option<String>, Option<String>);
    let rows: Vec<PolicyRow> = sqlx::query_as(
        "SELECT id, rev, validation_print_mode, validation_print_verification, \
         validation_print_template_id FROM shifts ORDER BY id",
    )
    .fetch_all(&admin.app.state.pool)
    .await
    .unwrap();
    (
        audit_rows(&admin.app).await,
        host_revision(&admin.app).await,
        shift_count(admin).await,
        json!(rows),
    )
}

/// Put the station of `key` on `line`.
async fn select_line(admin: &Admin, key: &str, line: &str) {
    let (status, body) = admin
        .app
        .send(json_request(
            with_device(request("PUT", "/v1/device/line"), key),
            json!({ "lineId": line }),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
}

/// The station of `key` enters `shift` naming `supports`.
async fn enter(admin: &Admin, key: &str, shift: &Value, supports: &[&str]) -> (StatusCode, Value) {
    let path = format!("/v1/device/shifts/{}/enter", shift["id"].as_str().unwrap());
    admin
        .app
        .send(json_request(
            with_device(request("POST", &path), key),
            json!({ "supports": supports }),
        ))
        .await
}

/// A template of `purpose` for every group whose layout carries `filler`
/// bytes of text in one element.
async fn heavy_template(admin: &Admin, purpose: &str, filler: usize) -> String {
    let (status, template) = admin
        .call(
            "POST",
            "/v1/office/templates",
            Some(json!({
                "name": "Макет с запасом", "purpose": purpose, "enabled": true,
                "spec": {
                    "widthMm": 100, "heightMm": 150, "dpi": 203, "language": "zpl",
                    "elements": [{ "kind": "text", "value": "x".repeat(filler) }]
                }
            })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{}", template["error"]);
    template["id"].as_str().unwrap().to_owned()
}

/// Change template `id` with `patch` over its current revision.
async fn patch_template(admin: &Admin, id: &str, mut patch: Value) {
    let path = format!("/v1/office/templates/{id}");
    let (_, current) = admin.call("GET", &path, None).await;
    patch["expectedRev"] = current["rev"].clone();
    let (status, changed) = admin.call("PUT", &path, Some(patch)).await;
    assert_eq!(status, StatusCode::OK, "{changed}");
}

/// What a planned shift that nobody entered keeps: its status, snapshot and
/// participants.
async fn unopened(admin: &Admin, shift: &Value) -> (String, Option<String>, i64) {
    let id = shift["id"].as_str().unwrap();
    let (status, snapshot): (String, Option<String>) =
        sqlx::query_as("SELECT status, snapshot FROM shifts WHERE id = ?")
            .bind(id)
            .fetch_one(&admin.app.state.pool)
            .await
            .unwrap();
    let participants: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM shift_participants WHERE shift_id = ?")
            .bind(id)
            .fetch_one(&admin.app.state.pool)
            .await
            .unwrap();
    (status, snapshot, participants)
}

/// Open a shift straight in its table, as if this station had entered it.
async fn open_directly(admin: &Admin, shift: &Value) {
    let (status, device) = admin
        .app
        .send(empty(with_device(request("GET", "/v1/device"), &admin.key)))
        .await;
    assert_eq!(status, StatusCode::OK, "{device}");
    sqlx::query(
        "UPDATE shifts SET status = 'active', snapshot = '{}', opened_at = ?, \
         owner_device_id = ? WHERE id = ?",
    )
    .bind(admin.app.state.timestamp())
    .bind(device["id"].as_str().unwrap())
    .bind(shift["id"].as_str().unwrap())
    .execute(&admin.app.state.pool)
    .await
    .unwrap();
}

/// The office plans a validation shift that prints its duplicates: stored in
/// the four columns, read back by the office and by the station's list,
/// audited with its mode and policy. `verification` is stored as sent.
#[tokio::test]
async fn the_office_plans_a_validation_shift_that_prints_its_duplicates() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let duplicate = office_template(&admin, "product_duplicate", true, json!([8])).await;
    let shift = plan_shift(
        &admin,
        validation_body(&setup, Some(printing(&duplicate, "none"))),
    )
    .await;
    let id = shift["id"].as_str().unwrap().to_owned();
    assert_eq!(shift["mode"], "validation");
    assert_eq!(shift["validationPrint"], printing(&duplicate, "none"));
    let (status, read_back) = admin.call("GET", &path(&shift), None).await;
    assert_eq!((status, read_back), (StatusCode::OK, shift.clone()));
    assert_eq!(
        columns(&admin, &id).await,
        (
            "validation".to_owned(),
            "duplicate_dm".to_owned(),
            Some("none".to_owned()),
            Some(duplicate.clone())
        )
    );
    assert_eq!(
        audit_trail(&admin.app, "shift.create").await,
        vec![admin.row(
            "shift.create",
            "shift",
            &id,
            json!({
                "number": "OCT26-001", "productId": setup.product, "lineId": setup.line,
                "productionDate": "2026-10-08", "mode": "validation",
                "validationPrint": printing(&duplicate, "none")
            })
        )]
    );
    let required = plan_shift(
        &admin,
        validation_body(&setup, Some(printing(&duplicate, "required"))),
    )
    .await;
    assert_eq!(
        required["validationPrint"],
        printing(&duplicate, "required")
    );
    // A validation shift without a duplicate, `none` sent or left out, and
    // `null` (read as left out, as every optional field of a plan), stores
    // no policy, is audited without one and is read back without the field.
    for policy in [Some(json!({ "mode": "none" })), None, Some(Value::Null)] {
        let plain = plan_shift(&admin, validation_body(&setup, policy.clone())).await;
        assert!(plain.get("validationPrint").is_none(), "{plain}");
        let plain_id = plain["id"].as_str().unwrap();
        assert_eq!(
            columns(&admin, plain_id).await,
            ("validation".to_owned(), "none".to_owned(), None, None),
            "{policy:?}"
        );
        let row = audit_trail(&admin.app, "shift.create").await.pop().unwrap();
        assert!(
            row.6.get("validationPrint").is_none(),
            "{policy:?}: {:?}",
            row.6
        );
    }
    // The station's list carries the policy too.
    select_line(&admin, &admin.key, &setup.line).await;
    let (status, listed) = admin
        .app
        .send(empty(with_device(
            request("GET", "/v1/device/shifts"),
            &admin.key,
        )))
        .await;
    assert_eq!(status, StatusCode::OK, "{listed}");
    let listed: Vec<&Value> = listed["shifts"].as_array().unwrap().iter().collect();
    let of = |id: &str| listed.iter().find(|shift| shift["id"] == id).copied();
    assert_eq!(
        of(&id).map(|shift| shift["validationPrint"].clone()),
        Some(printing(&duplicate, "none"))
    );
}

/// A duplicate is planned only for a validation shift (`validationPrint`),
/// with a template that exists, is of the `product_duplicate` purpose, is
/// enabled and covers the product's group (`validationPrint.templateId`).
/// Each refusal writes nothing.
#[tokio::test]
async fn a_planned_duplicate_needs_a_validation_shift_and_a_fitting_template() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let duplicate = office_template(&admin, "product_duplicate", true, Value::Null).await;
    let disabled = office_template(&admin, "product_duplicate", false, Value::Null).await;
    let other_group = office_template(&admin, "product_duplicate", true, json!([5])).await;
    let pallet = office_template(&admin, "pallet", true, Value::Null).await;
    let before = untouched(&admin).await;
    let mut aggregation = shift_body(&setup);
    aggregation["mode"] = json!("aggregation");
    aggregation["validationPrint"] = printing(&duplicate, "none");
    let mut no_mode = shift_body(&setup);
    no_mode["validationPrint"] = printing(&duplicate, "required");
    let unknown = "00000000-0000-4000-8000-0000000000aa";
    for (body, expected) in [
        (aggregation, field("validationPrint")),
        (no_mode, field("validationPrint")),
        (
            validation_body(&setup, Some(printing(unknown, "none"))),
            field("validationPrint.templateId"),
        ),
        (
            validation_body(&setup, Some(printing(&disabled, "none"))),
            field("validationPrint.templateId"),
        ),
        (
            validation_body(&setup, Some(printing(&other_group, "none"))),
            field("validationPrint.templateId"),
        ),
        (
            validation_body(&setup, Some(printing(&setup.template, "none"))),
            field("validationPrint.templateId"),
        ),
        (
            validation_body(&setup, Some(printing(&pallet, "none"))),
            field("validationPrint.templateId"),
        ),
    ] {
        let (status, refused) = admin
            .call("POST", "/v1/office/shifts", Some(body.clone()))
            .await;
        assert_eq!(
            (status, refusal(&refused)),
            (StatusCode::BAD_REQUEST, expected),
            "{body}"
        );
    }
    assert_eq!(untouched(&admin).await, before);
    // A policy of neither shape is the body's own refusal.
    let (status, refused) = admin
        .call(
            "POST",
            "/v1/office/shifts",
            Some(validation_body(
                &setup,
                Some(json!({ "mode": "duplicate_dm", "verification": "none" })),
            )),
        )
        .await;
    assert_eq!(
        (status, refused["error"]["code"].clone()),
        (StatusCode::BAD_REQUEST, json!("validation_failed"))
    );
    assert_eq!(untouched(&admin).await, before);
}

/// A planned shift changes its policy (Р1): stored in one write of the four
/// columns, audited with its `{ from, to }`; the same policy again, or `none`
/// of a shift that prints nothing, changes nothing (no revision, no row). A
/// changed template is checked as at planning; one that stays is kept even if
/// it was switched off since (the entry then refuses it). Back to
/// aggregation, the same edit must turn the duplicate off; an active shift
/// keeps its policy (`shift_status`), and still takes its plan.
#[tokio::test]
async fn a_planned_shift_changes_its_policy_and_an_active_one_keeps_it() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let duplicate = office_template(&admin, "product_duplicate", true, Value::Null).await;
    let second = office_template(&admin, "product_duplicate", true, json!([8])).await;
    let disabled = office_template(&admin, "product_duplicate", false, Value::Null).await;
    let shift = plan_shift(&admin, validation_body(&setup, None)).await;
    let id = shift["id"].as_str().unwrap().to_owned();
    let put = |body: Value| {
        let admin = &admin;
        let path = path(&shift);
        async move { admin.call("PUT", &path, Some(body)).await }
    };
    // `none` of a shift that prints nothing is no change (B1 review).
    let before = untouched(&admin).await;
    let (status, same) = put(json!({
        "validationPrint": { "mode": "none" }, "expectedRev": shift["rev"]
    }))
    .await;
    assert_eq!((status, &same), (StatusCode::OK, &shift));
    assert_eq!(untouched(&admin).await, before);
    // A template that does not fit is refused, and writes nothing.
    let (status, refused) = put(json!({
        "validationPrint": printing(&disabled, "none"), "expectedRev": shift["rev"]
    }))
    .await;
    assert_eq!(
        (status, refusal(&refused)),
        (StatusCode::BAD_REQUEST, field("validationPrint.templateId"))
    );
    assert_eq!(untouched(&admin).await, before);
    // Printing turned on.
    let (status, on) = put(json!({
        "validationPrint": printing(&duplicate, "none"), "expectedRev": shift["rev"]
    }))
    .await;
    assert_eq!(status, StatusCode::OK, "{on}");
    assert_eq!(on["validationPrint"], printing(&duplicate, "none"));
    assert_eq!(
        audit_trail(&admin.app, "shift.update").await,
        vec![admin.row(
            "shift.update",
            "shift",
            &id,
            json!({
                "changed": ["validationPrint"],
                "validationPrint": {
                    "from": { "mode": "none" }, "to": printing(&duplicate, "none")
                }
            })
        )]
    );
    // The same policy again: nothing.
    let before = untouched(&admin).await;
    let (status, same) = put(json!({
        "validationPrint": printing(&duplicate, "none"), "expectedRev": on["rev"]
    }))
    .await;
    assert_eq!((status, &same), (StatusCode::OK, &on));
    assert_eq!(untouched(&admin).await, before);
    // Another template and the check required.
    let (status, changed) = put(json!({
        "validationPrint": printing(&second, "required"), "expectedRev": on["rev"]
    }))
    .await;
    assert_eq!(status, StatusCode::OK, "{changed}");
    assert_eq!(
        columns(&admin, &id).await,
        (
            "validation".to_owned(),
            "duplicate_dm".to_owned(),
            Some("required".to_owned()),
            Some(second.clone())
        )
    );
    // The kept template, switched off since, stays while the check changes.
    patch_template(&admin, &second, json!({ "enabled": false })).await;
    let (status, kept) = put(json!({
        "validationPrint": printing(&second, "none"), "expectedRev": changed["rev"]
    }))
    .await;
    assert_eq!(status, StatusCode::OK, "{kept}");
    assert_eq!(kept["validationPrint"], printing(&second, "none"));
    // Aggregation with the duplicate kept: refused on the policy, nothing
    // written; turned off in the same edit, every column goes.
    let before = untouched(&admin).await;
    for body in [
        json!({ "mode": "aggregation", "expectedRev": kept["rev"] }),
        json!({
            "mode": "aggregation", "validationPrint": printing(&duplicate, "none"),
            "expectedRev": kept["rev"]
        }),
    ] {
        let (status, refused) = put(body.clone()).await;
        assert_eq!(
            (status, refusal(&refused)),
            (StatusCode::BAD_REQUEST, field("validationPrint")),
            "{body}"
        );
    }
    assert_eq!(untouched(&admin).await, before);
    let (status, aggregation) = put(json!({
        "mode": "aggregation", "validationPrint": { "mode": "none" }, "expectedRev": kept["rev"]
    }))
    .await;
    assert_eq!(status, StatusCode::OK, "{aggregation}");
    assert!(
        aggregation.get("validationPrint").is_none(),
        "{aggregation}"
    );
    assert_eq!(
        columns(&admin, &id).await,
        ("aggregation".to_owned(), "none".to_owned(), None, None)
    );
    assert_eq!(
        audit_trail(&admin.app, "shift.update")
            .await
            .pop()
            .unwrap()
            .6,
        json!({
            "changed": ["mode", "validationPrint"],
            "mode": { "from": "validation", "to": "aggregation" },
            "validationPrint": { "from": printing(&second, "none"), "to": { "mode": "none" } }
        })
    );
    // An aggregation shift takes no duplicate by an edit.
    let (status, refused) = put(json!({
        "validationPrint": printing(&duplicate, "none"), "expectedRev": aggregation["rev"]
    }))
    .await;
    assert_eq!(
        (status, refusal(&refused)),
        (StatusCode::BAD_REQUEST, field("validationPrint"))
    );
    // Back to validation with a duplicate in one edit.
    let (status, back) = put(json!({
        "mode": "validation", "validationPrint": printing(&duplicate, "required"),
        "expectedRev": aggregation["rev"]
    }))
    .await;
    assert_eq!(status, StatusCode::OK, "{back}");

    // Open, the policy is fixed: a change is `shift_status`, before the rules
    // of the policy it would have; the same policy with a new plan passes.
    open_directly(&admin, &back).await;
    let status_conflict = (
        json!("conflict"),
        json!({ "constraint": "shift_status", "status": "active" }),
    );
    let before = untouched(&admin).await;
    for policy in [
        json!({ "mode": "none" }),
        printing(&duplicate, "none"),
        printing(&disabled, "required"),
    ] {
        let (status, refused) = put(json!({
            "validationPrint": policy, "expectedRev": back["rev"]
        }))
        .await;
        assert_eq!(
            (status, refusal(&refused)),
            (StatusCode::CONFLICT, status_conflict.clone()),
            "{policy}"
        );
    }
    assert_eq!(untouched(&admin).await, before);
    let (status, planned_more) = put(json!({
        "validationPrint": printing(&duplicate, "required"), "plannedQty": 10,
        "expectedRev": back["rev"]
    }))
    .await;
    assert_eq!(status, StatusCode::OK, "{planned_more}");
    assert_eq!(planned_more["plannedQty"], 10);
    assert_eq!(
        planned_more["validationPrint"],
        printing(&duplicate, "required")
    );
}

/// A template a planned shift prints its duplicates with is not deleted
/// (`template_in_use`, beside the box and pallet templates); once the shift
/// is open its layout is in the snapshot and the template may go.
#[tokio::test]
async fn a_template_a_planned_shift_prints_its_duplicates_with_is_not_deleted() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let duplicate = office_template(&admin, "product_duplicate", true, Value::Null).await;
    let shift = plan_shift(
        &admin,
        validation_body(&setup, Some(printing(&duplicate, "none"))),
    )
    .await;
    let template_path = format!("/v1/office/templates/{duplicate}");
    let rows = audit_rows(&admin.app).await;
    let (status, refused) = admin.call("DELETE", &template_path, None).await;
    assert_eq!(
        (status, refusal(&refused)),
        (
            StatusCode::CONFLICT,
            (
                json!("conflict"),
                json!({ "constraint": "template_in_use", "shiftIds": [shift["id"]] })
            )
        )
    );
    assert_eq!(audit_rows(&admin.app).await, rows);
    select_line(&admin, &admin.key, &setup.line).await;
    let (status, entered) = enter(&admin, &admin.key, &shift, &BOTH).await;
    assert_eq!(status, StatusCode::OK, "{entered}");
    let (status, _) = admin.call("DELETE", &template_path, None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
}

/// A shift that prints is entered only by a station that names both
/// `validation-v1` and `validation-dm-duplicate-v1` (Р5), on its opening and
/// on every entry again; otherwise `station_update`, writing nothing. The
/// snapshot freezes the policy with the duplicate template whole (its name,
/// revision and layout), the opening is audited with the template, and an
/// entry again answers the stored snapshot byte for byte.
#[tokio::test]
async fn a_shift_that_prints_is_entered_by_a_station_that_prints_and_freezes_its_template() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let duplicate = office_template(&admin, "product_duplicate", true, Value::Null).await;
    let shift = plan_shift(
        &admin,
        validation_body(&setup, Some(printing(&duplicate, "required"))),
    )
    .await;
    select_line(&admin, &admin.key, &setup.line).await;
    let station_update = (json!("conflict"), json!({ "constraint": "station_update" }));
    let before = untouched(&admin).await;
    for supports in [
        &[][..],
        &["validation-v1"][..],
        &["validation-dm-duplicate-v1"][..],
    ] {
        let (status, refused) = enter(&admin, &admin.key, &shift, supports).await;
        assert_eq!(
            (status, refusal(&refused)),
            (StatusCode::CONFLICT, station_update.clone()),
            "{supports:?}"
        );
    }
    assert_eq!(untouched(&admin).await, before);
    assert_eq!(
        unopened(&admin, &shift).await,
        ("planned".to_owned(), None, 0)
    );
    let (status, entered) = enter(&admin, &admin.key, &shift, &BOTH).await;
    assert_eq!(status, StatusCode::OK, "{entered}");
    let (status, template) = admin
        .call("GET", &format!("/v1/office/templates/{duplicate}"), None)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(entered["validationPrint"], printing(&duplicate, "required"));
    assert_eq!(
        entered["snapshot"]["validationPrint"],
        json!({
            "verification": "required",
            "template": {
                "id": duplicate, "name": template["name"], "rev": template["rev"],
                "spec": template["spec"]
            }
        })
    );
    let opened = audit_trail(&admin.app, "shift.open").await.pop().unwrap().6;
    assert_eq!(
        [
            opened["validationPrintTemplateId"].clone(),
            opened["validationPrintTemplateRev"].clone()
        ],
        [json!(duplicate), template["rev"].clone()]
    );
    let stored: String = sqlx::query_scalar("SELECT snapshot FROM shifts WHERE id = ?")
        .bind(shift["id"].as_str().unwrap())
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    // Entering again: the stored snapshot, whatever the template is now, and
    // only with both capabilities.
    patch_template(&admin, &duplicate, json!({ "name": "Дубликат 2" })).await;
    let (status, again) = enter(&admin, &admin.key, &shift, &BOTH).await;
    assert_eq!(status, StatusCode::OK, "{again}");
    assert_eq!(again["snapshot"], entered["snapshot"]);
    assert_eq!(
        serde_json::to_string(&again["snapshot"]).unwrap().len(),
        stored.len()
    );
    let (status, refused) = enter(&admin, &admin.key, &shift, &["validation-v1"]).await;
    assert_eq!(
        (status, refusal(&refused)),
        (StatusCode::CONFLICT, station_update)
    );
    // A validation shift that prints nothing still needs `validation-v1`
    // alone, and freezes no policy.
    let plain = plan_shift(&admin, validation_body(&setup, None)).await;
    let (status, entered) = enter(&admin, &admin.key, &plain, &["validation-v1"]).await;
    assert_eq!(status, StatusCode::OK, "{entered}");
    assert!(entered.get("validationPrint").is_none(), "{entered}");
    assert!(
        entered["snapshot"].get("validationPrint").is_none(),
        "{entered}"
    );
}

/// The duplicate template must still fit when a station opens the shift: one
/// switched off or narrowed out of the product's group since the plan is
/// `duplicate_template_not_fit`, after the box template's own refusal, and
/// writes nothing.
#[tokio::test]
async fn a_duplicate_template_that_no_longer_fits_keeps_the_shift_planned() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let duplicate = office_template(&admin, "product_duplicate", true, Value::Null).await;
    let shift = plan_shift(
        &admin,
        validation_body(&setup, Some(printing(&duplicate, "none"))),
    )
    .await;
    select_line(&admin, &admin.key, &setup.line).await;
    let not_fit = |constraint: &str| (json!("conflict"), json!({ "constraint": constraint }));
    for patch in [
        json!({ "enabled": false }),
        json!({ "enabled": true, "chzProductGroupCodes": [5] }),
    ] {
        patch_template(&admin, &duplicate, patch.clone()).await;
        let before = untouched(&admin).await;
        let (status, refused) = enter(&admin, &admin.key, &shift, &BOTH).await;
        assert_eq!(
            (status, refusal(&refused)),
            (StatusCode::CONFLICT, not_fit("duplicate_template_not_fit")),
            "{patch}"
        );
        assert_eq!(untouched(&admin).await, before);
        assert_eq!(
            unopened(&admin, &shift).await,
            ("planned".to_owned(), None, 0)
        );
    }
    // The box template is named first.
    patch_template(&admin, &setup.template, json!({ "enabled": false })).await;
    let (status, refused) = enter(&admin, &admin.key, &shift, &BOTH).await;
    assert_eq!(
        (status, refusal(&refused)),
        (StatusCode::CONFLICT, not_fit("template_not_fit"))
    );
    patch_template(&admin, &setup.template, json!({ "enabled": true })).await;
    patch_template(&admin, &duplicate, json!({ "chzProductGroupCodes": [8] })).await;
    let (status, entered) = enter(&admin, &admin.key, &shift, &BOTH).await;
    assert_eq!(status, StatusCode::OK, "{entered}");
}

/// The duplicate layout counts against the snapshot's bound (327 680 bytes)
/// like the box layout: a box layout that fits alone and a duplicate layout
/// that together exceed it are `snapshot_too_large` and write nothing; a
/// small duplicate template brings the shift under the bound.
#[tokio::test]
async fn a_duplicate_layout_counts_against_the_snapshot_bound() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    select_line(&admin, &admin.key, &setup.line).await;
    let box_template = heavy_template(&admin, "box", 170_000).await;
    let heavy = heavy_template(&admin, "product_duplicate", 170_000).await;
    let mut body = validation_body(&setup, Some(printing(&heavy, "none")));
    body["boxTemplateId"] = json!(box_template);
    let shift = plan_shift(&admin, body.clone()).await;
    let before = untouched(&admin).await;
    let (status, refused) = enter(&admin, &admin.key, &shift, &BOTH).await;
    assert_eq!(
        (status, refusal(&refused)),
        (
            StatusCode::CONFLICT,
            (
                json!("conflict"),
                json!({ "constraint": "snapshot_too_large" })
            )
        )
    );
    assert_eq!(untouched(&admin).await, before);
    assert_eq!(
        unopened(&admin, &shift).await,
        ("planned".to_owned(), None, 0)
    );
    // The box layout alone fits.
    let mut alone = body.clone();
    alone["validationPrint"] = json!({ "mode": "none" });
    let plain = plan_shift(&admin, alone).await;
    let (status, entered) = enter(&admin, &admin.key, &plain, &BOTH).await;
    assert_eq!(status, StatusCode::OK, "{}", entered["error"]);
    // A small duplicate template opens the heavy plan.
    let small = office_template(&admin, "product_duplicate", true, Value::Null).await;
    let (status, pointed) = admin
        .call(
            "PUT",
            &path(&shift),
            Some(json!({
                "validationPrint": printing(&small, "none"), "expectedRev": shift["rev"]
            })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{pointed}");
    let (status, entered) = enter(&admin, &admin.key, &shift, &BOTH).await;
    assert_eq!(status, StatusCode::OK, "{}", entered["error"]);
    assert_eq!(
        entered["snapshot"]["validationPrint"]["template"]["id"],
        json!(small)
    );
}
