//! The change feed as one machine (plan 1e1, final review). Every catalog
//! writer — the wizard's stock templates, products, label templates, the
//! template defaults, the organization's record — takes its revision from one
//! counter and leaves its tombstones in one table, and a station reads the
//! result in pages. The per-writer suites pin each writer against the feed;
//! this one pins their composition with the paging: whatever its schedule and
//! page size, a station that applies the feed ends in the place a station that
//! syncs from zero ends, and that place is what the host holds.

mod support;

use std::collections::{BTreeMap, HashSet};

use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{
    bootstrap_body, empty, host_revision, json as json_request, pair_device, request, tombstones,
    with_device, Admin, TestApp,
};

/// A station's copy of the feed, filled by the rules of the station's
/// reference sync: a record replaces an older copy of its key, and a tombstone
/// removes only an older one. It checks each page against what the host
/// promises of one.
#[derive(Default)]
struct Station {
    /// The revision the last page said the station is at.
    rev: i64,
    /// `(entity, id)` of every record held, with its revision and data.
    rows: BTreeMap<(String, String), (i64, Value)>,
}

impl Station {
    /// Fetch pages of `limit` until the host says no more follow; returns how
    /// many items each page held.
    async fn sync(&mut self, admin: &Admin, limit: u32) -> Vec<usize> {
        let mut sizes = Vec::new();
        loop {
            let (status, page) = admin
                .app
                .send(empty(with_device(
                    request(
                        "GET",
                        &format!("/v1/changes?since={}&limit={limit}", self.rev),
                    ),
                    &admin.key,
                )))
                .await;
            assert_eq!(status, StatusCode::OK, "{page}");
            let items = page["items"].as_array().expect("items");
            let page_rev = page["rev"].as_i64().expect("rev");
            assert!(page_rev >= self.rev, "the feed went back from {}", self.rev);
            let mut in_this_page = HashSet::new();
            let mut previous: Option<(i64, String, String)> = None;
            for item in items {
                let entity = item["entity"].as_str().expect("entity").to_owned();
                let id = item["id"].as_str().expect("id").to_owned();
                let rev = item["rev"].as_i64().expect("rev");
                assert!(rev > self.rev, "an item at or below since: {item}");
                assert!(rev <= page_rev, "an item above the page's revision: {item}");
                // A key is a record or a tombstone, never both, and once.
                assert!(
                    in_this_page.insert((entity.clone(), id.clone())),
                    "a key twice in one page: {item}"
                );
                // Feed order: by revision, then entity, then id.
                let place = (rev, entity.clone(), id.clone());
                if let Some(earlier) = &previous {
                    assert!(
                        earlier < &place,
                        "out of feed order: {earlier:?}, {place:?}"
                    );
                }
                previous = Some(place);
                let key = (entity, id);
                let newer = self.rows.get(&key).is_none_or(|(held, _)| *held < rev);
                if item["deleted"] == true {
                    assert!(item.get("data").is_none(), "a tombstone with data: {item}");
                    if newer {
                        self.rows.remove(&key);
                    }
                } else if newer {
                    self.rows.insert(key, (rev, item["data"].clone()));
                }
            }
            self.rev = page_rev;
            sizes.push(items.len());
            if page["hasMore"] != true {
                return sizes;
            }
            assert!(!items.is_empty(), "hasMore on an empty page");
        }
    }
}

/// The `n`th stock template of the wizard: boxes, pallets and duplicates in
/// turn, the first two (a box and a pallet) the organization's defaults.
fn stock_template(n: usize) -> Value {
    let purpose = ["box", "pallet", "product_duplicate"][n % 3];
    json!({
        "name": format!("Типовой {n}"), "purpose": purpose, "orgDefault": n < 2,
        "spec": { "widthMm": 58 + n, "heightMm": 40, "dpi": 203, "language": "zpl", "elements": [] }
    })
}

/// The record a station holds for `entity` and `id`.
fn record<'a>(station: &'a Station, entity: &str, id: &str) -> &'a Value {
    &station.rows[&(entity.to_owned(), id.to_owned())].1
}

/// The id of the template named `name`.
async fn template_id(app: &TestApp, name: &str) -> String {
    sqlx::query_scalar("SELECT id FROM label_templates WHERE name = ?")
        .bind(name)
        .fetch_one(&app.state.pool)
        .await
        .unwrap()
}

/// A box template of the office's own, through the office, for every category.
async fn office_template(admin: &Admin, name: &str, spec: Value) -> Value {
    let (status, created) = admin
        .call(
            "POST",
            "/v1/office/templates",
            Some(json!({ "name": name, "purpose": "box", "enabled": true, "spec": spec })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    created
}

/// A product through the office.
async fn product(admin: &Admin, body: Value) -> Value {
    let (status, created) = admin.call("POST", "/v1/office/products", Some(body)).await;
    assert_eq!(status, StatusCode::OK, "{created}");
    created
}

/// The template defaults document: the organization's box and pallet defaults,
/// and the box default of each category given as `(code, template id)`.
fn defaults(box_default: &Value, pallet_default: &Value, categories: &[(u32, &str)]) -> Value {
    json!({
        "defaultBoxTemplateId": box_default,
        "defaultPalletTemplateId": pallet_default,
        "categories": categories
            .iter()
            .map(|(code, template)| json!({
                "chzProductGroupCode": code, "purpose": "box", "templateId": template
            }))
            .collect::<Vec<_>>()
    })
}

/// The template defaults document, whole, over the revision `rev` read before.
async fn set_defaults(admin: &Admin, mut document: Value, rev: &Value) -> Value {
    document["expectedRev"] = rev.clone();
    let (status, set) = admin
        .call("PUT", "/v1/office/template-defaults", Some(document))
        .await;
    assert_eq!(status, StatusCode::OK, "{set}");
    set
}

#[tokio::test]
async fn stations_that_sync_on_any_schedule_end_where_the_host_stands() {
    // The wizard: 22 stock templates, so the first revision holds 26 records
    // (with the organization, the site and two lines).
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "station").await;
    let mut body = bootstrap_body();
    body["templates"] = Value::Array((0..22).map(stock_template).collect());
    let (status, wizard) = app
        .send(json_request(
            with_device(request("POST", "/v1/bootstrap"), &key),
            body,
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{wizard}");
    let admin = Admin {
        key,
        token: wizard["session"]["token"].as_str().unwrap().to_owned(),
        id: wizard["session"]["user"]["id"].as_str().unwrap().to_owned(),
        app,
    };

    // Three stations follow the host from early on, each on its own schedule
    // and page size: this one after every step by pages of three, the others
    // from the delete by twos and from the last step by fives. Two more join
    // at the end, by ones and from zero.
    let mut every_step = Station::default();
    let mut from_the_delete = Station::default();
    let mut late_by_fives = Station::default();
    every_step.sync(&admin, 3).await;

    let stock_box = template_id(&admin.app, "Типовой 12").await;
    let other_stock_box = template_id(&admin.app, "Типовой 15").await;
    let free_stock_box = template_id(&admin.app, "Типовой 18").await;

    // Two products: one plain, one that prefers a stock box template.
    let milk = product(
        &admin,
        json!({ "gtin14": "04600682000013", "name": "Молоко", "chzProductGroupCode": 8 }),
    )
    .await;
    let kefir = product(
        &admin,
        json!({
            "gtin14": "04600682000020", "name": "Кефир", "chzProductGroupCode": 8,
            "defaultBoxTemplateId": stock_box
        }),
    )
    .await;
    every_step.sync(&admin, 3).await;

    // A template of the office's own, and the plain product's preference
    // moves to it.
    let custom = office_template(&admin, "Молоко 58×40", json!({ "widthMm": 58 })).await;
    let custom_path = format!("/v1/office/templates/{}", custom["id"].as_str().unwrap());
    let (status, moved) = admin
        .call(
            "PUT",
            &format!("/v1/office/products/{}", milk["id"].as_str().unwrap()),
            Some(json!({
                "gtin14": "04600682000013", "name": "Молоко", "chzProductGroupCode": 8,
                "defaultBoxTemplateId": custom["id"], "archived": false,
                "expectedRev": milk["rev"]
            })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{moved}");
    every_step.sync(&admin, 3).await;

    // Box defaults of two categories on a stock template.
    let (status, document) = admin
        .call("GET", "/v1/office/template-defaults", None)
        .await;
    assert_eq!(status, StatusCode::OK, "{document}");
    let box_default = document["defaultBoxTemplateId"].clone();
    let pallet_default = document["defaultPalletTemplateId"].clone();
    let set = set_defaults(
        &admin,
        defaults(
            &box_default,
            &pallet_default,
            &[(8, &stock_box), (15, &stock_box)],
        ),
        &document["rev"],
    )
    .await;
    every_step.sync(&admin, 3).await;

    // The office's template is deleted: the product that preferred it is
    // cleared at the delete's own revision, and the template leaves as a
    // tombstone.
    let (status, _) = admin.call("DELETE", &custom_path, None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    every_step.sync(&admin, 3).await;
    from_the_delete.sync(&admin, 2).await;

    // Both category defaults are cleared (a tombstone each). Then the first
    // is set again on another template (its tombstone is dropped) while the
    // organization's pallet default moves to another stock template (its
    // record is rewritten at the new revision); the second stays cleared.
    let cleared = set_defaults(
        &admin,
        defaults(&box_default, &pallet_default, &[]),
        &set["rev"],
    )
    .await;
    every_step.sync(&admin, 3).await;
    let other_stock_pallet = template_id(&admin.app, "Типовой 4").await;
    set_defaults(
        &admin,
        defaults(
            &box_default,
            &json!(other_stock_pallet),
            &[(8, &other_stock_box)],
        ),
        &cleared["rev"],
    )
    .await;

    // A product archived; a stock template that is no default disabled and
    // narrowed; the organization renamed.
    let (status, archived) = admin
        .call(
            "PUT",
            &format!("/v1/office/products/{}", kefir["id"].as_str().unwrap()),
            Some(json!({
                "gtin14": "04600682000020", "name": "Кефир", "chzProductGroupCode": 8,
                "defaultBoxTemplateId": stock_box, "archived": true,
                "expectedRev": kefir["rev"]
            })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{archived}");
    let (status, free) = admin
        .call(
            "GET",
            &format!("/v1/office/templates/{free_stock_box}"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{free}");
    let (status, narrowed) = admin
        .call(
            "PUT",
            &format!("/v1/office/templates/{free_stock_box}"),
            Some(json!({ "enabled": false, "chzProductGroupCodes": [15], "expectedRev": free["rev"] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{narrowed}");
    let (status, org) = admin.call("GET", "/v1/office/org", None).await;
    assert_eq!(status, StatusCode::OK, "{org}");
    let (status, renamed) = admin
        .call(
            "PUT",
            "/v1/office/org",
            Some(json!({
                "name": "ООО «Атолл-Юг»", "inn": org["inn"], "gln": org["gln"],
                "gs1Prefixes": org["gs1Prefixes"], "timeZone": org["timeZone"],
                "expectedRev": org["rev"]
            })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{renamed}");
    every_step.sync(&admin, 3).await;
    from_the_delete.sync(&admin, 2).await;
    late_by_fives.sync(&admin, 5).await;

    // Six layouts of 250 000 bytes, a revision apiece: a page of five of them
    // is cut by the count and then by the byte budget, which holds four.
    let big = json!({ "filler": "x".repeat(250_000 - 13) });
    for n in 0..6 {
        office_template(&admin, &format!("Большой {n}"), big.clone()).await;
    }
    every_step.sync(&admin, 3).await;
    from_the_delete.sync(&admin, 2).await;
    assert_eq!(
        late_by_fives.sync(&admin, 5).await,
        [4, 2],
        "four layouts fit the budget, the next page holds the other two"
    );

    // Stations that sync only now: one revision per page, and all at once.
    // The wizard's revision still holds 21 templates, the two lines and the
    // site (the organization and the narrowed template have moved on), and it
    // comes whole, though the limit is one.
    let mut at_the_end_by_one = Station::default();
    let by_one = at_the_end_by_one.sync(&admin, 1).await;
    assert_eq!(by_one[0], 24, "the first revision comes whole");
    assert!(by_one.len() >= 10, "a page per revision: {by_one:?}");
    let mut from_zero = Station::default();
    from_zero.sync(&admin, 1000).await;

    // Every schedule ends where the one from zero ends.
    for (schedule, station) in [
        ("every step", &every_step),
        ("from the delete", &from_the_delete),
        ("late, by fives", &late_by_fives),
        ("at the end, by one", &at_the_end_by_one),
    ] {
        assert_eq!(station.rows, from_zero.rows, "{schedule}");
        assert_eq!(station.rev, from_zero.rev, "{schedule}");
    }
    assert_eq!(from_zero.rev, host_revision(&admin.app).await);

    // ...and that is the host's own state: every live key, no other. Two
    // tombstones are left: the deleted template's and the category default
    // that stayed cleared; the one cleared and set again has none.
    let mut live: Vec<(String, String)> = sqlx::query_as(
        "SELECT 'products', id FROM products \
         UNION ALL SELECT 'label_templates', id FROM label_templates \
         UNION ALL SELECT 'category_template_defaults', chz_group_code || ':' || purpose \
             FROM category_template_defaults \
         UNION ALL SELECT 'lines', id FROM lines \
         UNION ALL SELECT 'org_profile', '1' \
         UNION ALL SELECT 'site', '1'",
    )
    .fetch_all(&admin.app.state.pool)
    .await
    .unwrap();
    live.sort();
    let held: Vec<(String, String)> = from_zero.rows.keys().cloned().collect();
    assert_eq!(held, live);
    assert_eq!(
        tombstones(&admin.app)
            .await
            .into_iter()
            .map(|(entity, id, _)| (entity, id))
            .collect::<Vec<_>>(),
        [
            ("category_template_defaults".to_owned(), "15:box".to_owned()),
            (
                "label_templates".to_owned(),
                custom["id"].as_str().unwrap().to_owned()
            )
        ]
    );

    // What the copies say: the product that preferred the deleted template
    // no longer names it, the organization carries its stock box default, the
    // pallet default it moved to and its new name, and the category default
    // names the template chosen last.
    assert_eq!(
        record(&from_zero, "products", milk["id"].as_str().unwrap())["defaultBoxTemplateId"],
        Value::Null
    );
    let organization = record(&from_zero, "org_profile", "1");
    assert_eq!(
        (
            organization["name"].clone(),
            organization["defaultBoxTemplateId"].clone(),
            organization["defaultPalletTemplateId"].clone()
        ),
        (
            json!("ООО «Атолл-Юг»"),
            json!(template_id(&admin.app, "Типовой 0").await),
            json!(other_stock_pallet)
        )
    );
    assert_eq!(
        record(&from_zero, "category_template_defaults", "8:box")["templateId"],
        json!(other_stock_box)
    );
    let narrowed_copy = record(&from_zero, "label_templates", &free_stock_box);
    assert_eq!(
        (
            narrowed_copy["enabled"].clone(),
            narrowed_copy["chzProductGroupCodes"].clone()
        ),
        (json!(false), json!([15]))
    );
}
