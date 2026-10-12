//! The import's checks that need no database (`markiro_host::cloud_import`,
//! plan IMP): the golden file passes, and each rule refuses its row with the
//! request's JSON path. Every case changes one value of the golden request.

mod support;

use markiro_host::cloud_import::check;
use markiro_proto::cloud_import::CloudImportRequest;
use serde_json::{json, Value};
use support::app::{cloud_import_request, IMPORT_ID};

fn request() -> Value {
    cloud_import_request(IMPORT_ID, false)
}

fn typed(body: Value) -> CloudImportRequest {
    serde_json::from_value(body).unwrap()
}

/// The `details.field` of the refusal of the golden request after `change`.
fn refused(change: impl FnOnce(&mut Value)) -> String {
    let mut body = request();
    change(&mut body);
    let error = match check(&typed(body)) {
        Ok(_) => panic!("the change was accepted"),
        Err(error) => error,
    };
    assert_eq!(error.code(), "validation_failed", "{}", error.message());
    error.details().unwrap()["field"]
        .as_str()
        .unwrap()
        .to_owned()
}

/// The PIN 4821 under 10 000 iterations: a PIN hash the host takes.
const PIN_10000: &str =
    "pbkdf2$sha256$10000$bWFya2lyby1zdGFuZGFsbw==$33q/nWS7HYqVkEapiJW+qfJkAK+dEw5JDvZadD5palE=";

#[test]
fn the_golden_file_passes_whole() {
    let valid = check(&typed(request())).unwrap();
    assert_eq!(valid.gln, "4600682000010");
    assert_eq!(valid.badge_salt.as_deref(), Some(&b"markiro-badge-01"[..]));
    assert_eq!(
        valid
            .lines
            .iter()
            .map(|line| (line.name.as_str(), line.name_key.as_str()))
            .collect::<Vec<_>>(),
        [
            ("Линия 1", "линия 1"),
            ("Упаковка", "упаковка"),
            ("линия 1 (2)", "линия 1 (2)")
        ]
    );
    assert_eq!(
        (
            valid.counterparties.len(),
            valid.templates.len(),
            valid.categories.len(),
            valid.products.len(),
            valid.operators.len(),
            valid.badges.len(),
            valid.sscc_counters.len(),
            valid.shift_number_counters.len(),
        ),
        (2, 5, 2, 3, 3, 3, 3, 3)
    );
    // The archived product keeps the GTIN of a product in use.
    assert_eq!(valid.products[0].gtin14, valid.products[2].gtin14);
    assert!(valid.products[2].archived);
    assert_eq!(
        valid.group_refs,
        [
            ("payload.templates.1.chzProductGroupCodes".to_owned(), 8),
            (
                "payload.templateDefaults.categories.0.chzProductGroupCode".to_owned(),
                8
            ),
            (
                "payload.templateDefaults.categories.1.chzProductGroupCode".to_owned(),
                8
            ),
            ("payload.products.0.chzProductGroupCode".to_owned(), 8),
            ("payload.products.1.chzProductGroupCode".to_owned(), 13),
            ("payload.products.2.chzProductGroupCode".to_owned(), 8),
        ]
    );
}

#[test]
fn the_envelope_is_checked() {
    assert_eq!(
        refused(|body| body["importId"] = json!("8F14E45F-CEEA-467A-9D9B-1C7E0B1A2D3E")),
        "importId"
    );
    assert_eq!(
        refused(|body| body["formatVersion"] = json!(2)),
        "formatVersion"
    );
    assert_eq!(
        refused(|body| body["exportedAt"] = json!("9 октября")),
        "exportedAt"
    );
    assert_eq!(
        refused(|body| body["source"]["tenantName"] = json!("\u{0}")),
        "source.tenantName"
    );
    assert_eq!(
        refused(|body| body["payload"]["organization"]["gln"] = json!("460068200001")),
        "payload.organization.gln"
    );
    assert_eq!(
        refused(|body| body["payload"]["badgeSalt"] = json!("bWFya2lyby1iYWRnZS0wMQ")),
        "payload.badgeSalt"
    );
    assert_eq!(
        refused(|body| body["payload"]["badgeSalt"] = json!("bWFya2lyby1iYWRnZS0w")),
        "payload.badgeSalt"
    );
}

#[test]
fn lines_counterparties_and_templates_are_checked_row_by_row() {
    assert_eq!(
        refused(|body| body["payload"]["lines"][2]["name"] = json!(" УПАКОВКА ")),
        "payload.lines.2.name"
    );
    assert_eq!(
        refused(
            |body| body["payload"]["lines"][1]["id"] = body["payload"]["lines"][0]["id"].clone()
        ),
        "payload.lines.1.id"
    );
    assert_eq!(
        refused(|body| body["payload"]["lines"][0]["id"] = json!("line-1")),
        "payload.lines.0.id"
    );
    assert_eq!(
        refused(|body| body["payload"]["counterparties"][1]["gln"] = json!("46070000000")),
        "payload.counterparties.1.gln"
    );
    assert_eq!(
        refused(|body| body["payload"]["templates"][0]["spec"] = json!([])),
        "payload.templates.0.spec"
    );
    assert_eq!(
        refused(|body| body["payload"]["templates"][1]["chzProductGroupCodes"] = json!([])),
        "payload.templates.1.chzProductGroupCodes"
    );
    assert_eq!(
        refused(|body| body["payload"]["templates"][3]["name"] = json!(" ")),
        "payload.templates.3.name"
    );
}

#[test]
fn a_default_names_a_template_of_the_file_that_fits_its_slot() {
    let t1 = "0d0d0000-0000-4000-8000-000000000001";
    let t2 = "0d0d0000-0000-4000-8000-000000000002";
    let t5 = "0d0d0000-0000-4000-8000-000000000005";
    let default = |name: &'static str, value: Value| {
        move |body: &mut Value| body["payload"]["templateDefaults"][name] = value
    };
    let category = |index: usize, name: &'static str, value: Value| {
        move |body: &mut Value| {
            body["payload"]["templateDefaults"]["categories"][index][name] = value
        }
    };
    // T2 covers category 8 only, so it is no organization default.
    assert_eq!(
        refused(default("defaultBoxTemplateId", json!(t2))),
        "payload.templateDefaults.defaultBoxTemplateId"
    );
    assert_eq!(
        refused(default("defaultPalletTemplateId", json!(t1))),
        "payload.templateDefaults.defaultPalletTemplateId"
    );
    assert_eq!(
        refused(default(
            "defaultBoxTemplateId",
            json!("0d0d0000-0000-4000-8000-0000000000ff")
        )),
        "payload.templateDefaults.defaultBoxTemplateId"
    );
    // T5 is disabled; T2 does not cover category 13.
    assert_eq!(
        refused(category(0, "templateId", json!(t5))),
        "payload.templateDefaults.categories.0.templateId"
    );
    assert_eq!(
        refused(category(0, "chzProductGroupCode", json!(13))),
        "payload.templateDefaults.categories.0.templateId"
    );
    assert_eq!(
        refused(|body| {
            let second = &mut body["payload"]["templateDefaults"]["categories"][1];
            second["purpose"] = json!("box");
            second["templateId"] = json!(t2);
        }),
        "payload.templateDefaults.categories.1"
    );
}

#[test]
fn products_are_checked_up_to_the_hosts_bounds() {
    let product = |index: usize, name: &'static str, value: Value| {
        move |body: &mut Value| body["payload"]["products"][index][name] = value
    };
    assert_eq!(
        refused(|body| body["payload"]["products"][1]["gtin14"] = json!("04600682000013")),
        "payload.products.1.gtin14"
    );
    assert_eq!(
        refused(product(0, "gtin14", json!("4600682000013"))),
        "payload.products.0.gtin14"
    );
    assert_eq!(
        refused(product(0, "boxCapacity", json!(100_001))),
        "payload.products.0.boxCapacity"
    );
    assert_eq!(
        refused(product(0, "palletBoxCapacity", json!(10_001))),
        "payload.products.0.palletBoxCapacity"
    );
    assert_eq!(
        refused(product(0, "shelfLifeDays", json!(3_651))),
        "payload.products.0.shelfLifeDays"
    );
    assert_eq!(
        refused(product(0, "boxCapacity", json!(0))),
        "payload.products.0.boxCapacity"
    );
    // A pallet template, a product duplicate's and an unknown one are no box preference.
    for id in [
        "0d0d0000-0000-4000-8000-000000000003",
        "0d0d0000-0000-4000-8000-000000000004",
        "0d0d0000-0000-4000-8000-0000000000ff",
    ] {
        assert_eq!(
            refused(product(0, "defaultBoxTemplateId", json!(id))),
            "payload.products.0.defaultBoxTemplateId"
        );
    }
    assert_eq!(
        refused(product(
            1,
            "defaultPalletTemplateId",
            json!("0d0d0000-0000-4000-8000-000000000001")
        )),
        "payload.products.1.defaultPalletTemplateId"
    );
    let mut bounds = request();
    let first = &mut bounds["payload"]["products"][0];
    first["boxCapacity"] = json!(100_000);
    first["palletBoxCapacity"] = json!(10_000);
    first["shelfLifeDays"] = json!(3_650);
    assert!(check(&typed(bounds)).is_ok());
}

#[test]
fn operators_keep_their_hash_and_a_number_once() {
    let operator = |index: usize, name: &'static str, value: Value| {
        move |body: &mut Value| body["payload"]["operators"][index][name] = value
    };
    assert_eq!(
        refused(operator(0, "login", json!("12"))),
        "payload.operators.0.login"
    );
    assert_eq!(
        refused(operator(1, "login", json!("0042"))),
        "payload.operators.1.login"
    );
    assert_eq!(
        refused(operator(0, "pinPhc", json!(
            "pbkdf2$sha256$0100000$bWFya2lyby1waW4tc2FsdA==$3OKvrZ2+EfTB2zsCso90r5g8c6Ib6t+Bv+cGJOpgPmU="
        ))),
        "payload.operators.0.pinPhc"
    );
    assert_eq!(
        refused(operator(0, "name", json!("\t"))),
        "payload.operators.0.name"
    );
    let mut lower = request();
    lower["payload"]["operators"][0]["pinPhc"] = json!(PIN_10000);
    assert!(check(&typed(lower)).is_ok());
}

#[test]
fn badges_carry_the_files_salt_and_the_domains_count() {
    let badge = |index: usize, name: &'static str, value: Value| {
        move |body: &mut Value| body["payload"]["badges"][index][name] = value
    };
    assert_eq!(
        refused(badge(
            0,
            "operatorId",
            json!("0f0f0000-0000-4000-8000-000000000003")
        )),
        "payload.badges.0.operatorId"
    );
    // A PIN hash: another salt, then the right salt with 10 000 iterations.
    assert_eq!(
        refused(badge(0, "badgePhc", json!(PIN_10000))),
        "payload.badges.0.badgePhc"
    );
    assert_eq!(
        refused(badge(
            0,
            "badgePhc",
            json!("pbkdf2$sha256$10000$bWFya2lyby1iYWRnZS0wMQ==$CFQuvVuv7iz+ANkhgZVnO2k8iP67A2gex7JV7uWRayo=")
        )),
        "payload.badges.0.badgePhc"
    );
    assert_eq!(
        refused(|body| body["payload"]["badges"][2]["badgePhc"] =
            body["payload"]["badges"][0]["badgePhc"].clone()),
        "payload.badges.2.badgePhc"
    );
    assert_eq!(
        refused(|body| body["payload"]["badgeSalt"] = Value::Null),
        "payload.badgeSalt"
    );
    let mut none = request();
    none["payload"]["badges"] = json!([]);
    none["payload"]["badgeSalt"] = Value::Null;
    assert!(check(&typed(none)).is_ok());
}

#[test]
fn counters_are_checked_against_the_prefixs_serials() {
    let counter = |index: usize, name: &'static str, value: Value| {
        move |body: &mut Value| body["payload"]["ssccCounters"][index][name] = value
    };
    assert_eq!(
        refused(counter(0, "extension", json!(2))),
        "payload.ssccCounters.0.extension"
    );
    assert_eq!(
        refused(counter(0, "issuerPrefix", json!("46006820a"))),
        "payload.ssccCounters.0.issuerPrefix"
    );
    assert_eq!(
        refused(counter(0, "nextSerial", json!(10_000_000))),
        "payload.ssccCounters.0.nextSerial"
    );
    assert_eq!(
        refused(counter(0, "nextSerial", json!(0))),
        "payload.ssccCounters.0.nextSerial"
    );
    assert_eq!(
        refused(|body| body["payload"]["ssccCounters"][2]["issuerPrefix"] = json!("460068200")),
        "payload.ssccCounters.2"
    );
    let mut edges = request();
    edges["payload"]["ssccCounters"][0]["nextSerial"] = json!(9_999_999);
    edges["payload"]["ssccCounters"][1]["nextSerial"] = json!(0);
    assert!(check(&typed(edges)).is_ok());

    let month = |index: usize, name: &'static str, value: Value| {
        move |body: &mut Value| body["payload"]["shiftNumberCounters"][index][name] = value
    };
    for key in ["Oct26", "OCT2", "OCT266", "XYZ26", "OCT2a"] {
        assert_eq!(
            refused(month(0, "monthKey", json!(key))),
            "payload.shiftNumberCounters.0.monthKey",
            "{key}"
        );
    }
    assert_eq!(
        refused(month(0, "lastSeq", json!(0))),
        "payload.shiftNumberCounters.0.lastSeq"
    );
    assert_eq!(
        refused(month(1, "monthKey", json!("NOV26"))),
        "payload.shiftNumberCounters.1.monthKey"
    );
}

// ---------------------------------------------------------------------------
// Beyond the plan's cases: each test below kills a mutant the plan's cases
// let through (the report lists them) or pins a rule of the data's safety.
// ---------------------------------------------------------------------------

/// Everything a refusal can show a log or an operator: message, details and
/// the `Debug` form, in one string.
fn refusal_text(change: impl FnOnce(&mut Value)) -> String {
    let mut body = request();
    change(&mut body);
    let error = match check(&typed(body)) {
        Ok(_) => panic!("the change was accepted"),
        Err(error) => error,
    };
    format!("{} {:?} {:?}", error.message(), error.details(), error)
}

/// The same change must be accepted.
fn accepted(change: impl FnOnce(&mut Value)) {
    let mut body = request();
    change(&mut body);
    if let Err(error) = check(&typed(body)) {
        panic!("the change was refused: {}", error.message());
    }
}

#[test]
fn the_source_and_the_organization_are_checked_up_to_their_bounds() {
    let tenant = "t".repeat(100);
    accepted(|body| body["source"]["tenantId"] = json!(tenant));
    for bad in ["", " ", "\u{7}", &"t".repeat(101)] {
        assert_eq!(
            refused(|body| body["source"]["tenantId"] = json!(bad)),
            "source.tenantId"
        );
    }
    accepted(|body| body["source"]["tenantName"] = json!("н".repeat(200)));
    assert_eq!(
        refused(|body| body["source"]["tenantName"] = json!("н".repeat(201))),
        "source.tenantName"
    );
    for (name, value) in [
        ("name", json!(" ")),
        ("inn", json!("123")),
        ("timeZone", json!("Europe Moscow")),
        ("gs1Prefixes", json!(["12"])),
    ] {
        assert_eq!(
            refused(|body| body["payload"]["organization"][name] = value),
            format!("payload.organization.{name}")
        );
    }
}

#[test]
fn an_id_is_unique_in_its_own_list_only() {
    let first = |list: &'static str| {
        move |body: &mut Value| {
            let id = body["payload"][list][0]["id"].clone();
            body["payload"][list][1]["id"] = id;
        }
    };
    for list in [
        "counterparties",
        "templates",
        "products",
        "operators",
        "badges",
    ] {
        assert_eq!(refused(first(list)), format!("payload.{list}.1.id"));
    }
    // The same id in two different lists is no clash: the tables are apart.
    // The row changed is one nothing refers to (a template of a product
    // duplicate, an operator without a badge).
    let lists = [
        ("lines", 2),
        ("counterparties", 1),
        ("templates", 3),
        ("products", 2),
        ("operators", 2),
        ("badges", 2),
    ];
    for (other, _) in lists {
        for (list, index) in lists {
            if list != other {
                accepted(|body| {
                    let id = body["payload"][other][0]["id"].clone();
                    body["payload"][list][index]["id"] = id;
                });
            }
        }
    }
}

#[test]
fn a_gtin_is_compared_as_it_will_be_stored() {
    // Another product in use with the same GTIN behind spaces.
    assert_eq!(
        refused(|body| {
            let gtin = body["payload"]["products"][0]["gtin14"].as_str().unwrap();
            body["payload"]["products"][1]["gtin14"] = json!(format!(" {gtin} "));
        }),
        "payload.products.1.gtin14"
    );
    // Both in use: refused at the second.
    assert_eq!(
        refused(|body| body["payload"]["products"][2]["archived"] = json!(false)),
        "payload.products.2.gtin14"
    );
    // The archived one may come first, or be one of several.
    accepted(|body| {
        body["payload"]["products"][0]["archived"] = json!(true);
        body["payload"]["products"][2]["archived"] = json!(false);
    });
    accepted(|body| {
        let gtin = body["payload"]["products"][0]["gtin14"].clone();
        body["payload"]["products"][1]["gtin14"] = gtin;
        body["payload"]["products"][1]["archived"] = json!(true);
    });
}

#[test]
fn product_and_person_text_is_bounded_like_the_offices_routes() {
    for (list, index, name, long) in [
        ("products", 0, "name", 201),
        ("products", 0, "printName", 201),
        ("operators", 0, "name", 101),
        ("operators", 0, "role", 121),
        ("badges", 0, "label", 101),
    ] {
        assert_eq!(
            refused(|body| body["payload"][list][index][name] = json!("я".repeat(long))),
            format!("payload.{list}.{index}.{name}")
        );
        accepted(|body| body["payload"][list][index][name] = json!("я".repeat(long - 1)));
    }
    assert_eq!(
        refused(|body| body["payload"]["products"][0]["name"] = json!("Мо\u{0}локо")),
        "payload.products.0.name"
    );
}

#[test]
fn the_golden_files_values_reach_the_import_as_written() {
    let golden = request();
    let valid = check(&typed(golden.clone())).unwrap();
    let payload = &golden["payload"];
    assert_eq!(
        valid
            .operators
            .iter()
            .map(|each| each.active)
            .collect::<Vec<_>>(),
        [true, false, false]
    );
    assert_eq!(
        valid
            .operators
            .iter()
            .map(|each| each.login.as_str())
            .collect::<Vec<_>>(),
        ["0042", "117", "205"]
    );
    assert_eq!(
        valid
            .operators
            .iter()
            .map(|each| each.role.as_deref())
            .collect::<Vec<_>>(),
        [Some("Оператор линии"), None, None]
    );
    for (index, each) in valid.operators.iter().enumerate() {
        assert_eq!(each.id, payload["operators"][index]["id"].as_str().unwrap());
        assert_eq!(
            each.pin_phc,
            payload["operators"][index]["pinPhc"].as_str().unwrap()
        );
    }
    for (index, each) in valid.badges.iter().enumerate() {
        let row = &payload["badges"][index];
        assert_eq!(each.id, row["id"].as_str().unwrap());
        assert_eq!(each.operator_id, row["operatorId"].as_str().unwrap());
        assert_eq!(each.badge_phc, row["badgePhc"].as_str().unwrap());
        assert_eq!(each.label.as_deref(), row["label"].as_str());
    }
    assert_eq!(
        valid
            .products
            .iter()
            .map(|each| each.archived)
            .collect::<Vec<_>>(),
        [false, false, true]
    );
    let first = &valid.products[0];
    assert_eq!(first.print_name.as_deref(), Some("Молоко 3,2%"));
    assert_eq!(
        (
            first.group,
            first.box_capacity,
            first.pallet_box_capacity,
            first.shelf_life_days
        ),
        (Some(8), Some(12), Some(40), Some(10))
    );
    assert_eq!(
        first.default_box_template_id.as_deref(),
        Some("0d0d0000-0000-4000-8000-000000000002")
    );
    assert_eq!(
        valid.products[1].default_pallet_template_id.as_deref(),
        Some("0d0d0000-0000-4000-8000-000000000003")
    );
    // The layout is stored as compact JSON of the same value.
    for (index, each) in valid.templates.iter().enumerate() {
        let stored: Value = serde_json::from_str(&each.spec).unwrap();
        assert_eq!(stored, payload["templates"][index]["spec"]);
        assert!(!each.spec.contains('\n'), "{}", each.spec);
        assert_eq!(
            each.enabled,
            payload["templates"][index]["enabled"] == json!(true)
        );
    }
    assert_eq!(
        valid
            .templates
            .iter()
            .map(|each| each.purpose.as_str())
            .collect::<Vec<_>>(),
        ["box", "box", "pallet", "product_duplicate", "box"]
    );
    assert_eq!(valid.templates[1].codes.as_deref(), Some(&[8][..]));
    assert_eq!(valid.templates[0].codes, None);
    assert_eq!(
        (
            valid.default_box_template_id.as_deref(),
            valid.default_pallet_template_id.as_deref()
        ),
        (
            Some("0d0d0000-0000-4000-8000-000000000001"),
            Some("0d0d0000-0000-4000-8000-000000000003")
        )
    );
    assert_eq!(
        valid
            .categories
            .iter()
            .map(|each| (each.code, each.purpose.as_str(), each.template_id.as_str()))
            .collect::<Vec<_>>(),
        [
            (8, "box", "0d0d0000-0000-4000-8000-000000000002"),
            (8, "pallet", "0d0d0000-0000-4000-8000-000000000003")
        ]
    );
    assert_eq!(
        valid
            .counterparties
            .iter()
            .map(|each| (each.company.gln.as_str(), each.company.inn.as_deref()))
            .collect::<Vec<_>>(),
        [
            ("4601234000017", Some("7812345678")),
            ("4607000000014", None)
        ]
    );
    assert_eq!(
        valid
            .sscc_counters
            .iter()
            .map(|each| (
                each.issuer_prefix.as_str(),
                each.extension,
                each.next_serial
            ))
            .collect::<Vec<_>>(),
        [
            ("460068200", 0, 30_000),
            ("460068200", 1, 10_000),
            ("460123400", 0, 1)
        ]
    );
    assert_eq!(
        valid
            .shift_number_counters
            .iter()
            .map(|each| (each.month_key.as_str(), each.last_seq))
            .collect::<Vec<_>>(),
        [("NOV26", 1), ("OCT26", 7), ("SEP26", 41)]
    );
}

#[test]
fn text_is_stored_trimmed() {
    let mut body = request();
    body["payload"]["lines"][1]["name"] = json!("  Упаковка\t");
    body["payload"]["operators"][0]["name"] = json!(" Анна Кузнецова ");
    body["payload"]["products"][0]["name"] = json!(" Молоко ");
    body["payload"]["templates"][0]["name"] = json!(" Стандарт ");
    let valid = check(&typed(body)).unwrap();
    assert_eq!(valid.lines[1].name, "Упаковка");
    assert_eq!(valid.lines[1].name_key, "упаковка");
    assert_eq!(valid.operators[0].name, "Анна Кузнецова");
    assert_eq!(valid.products[0].name, "Молоко");
    assert_eq!(valid.templates[0].name, "Стандарт");
}

#[test]
fn defaults_may_be_absent_and_a_category_default_keeps_its_slot() {
    accepted(|body| {
        body["payload"]["templateDefaults"] = json!({
            "defaultBoxTemplateId": null,
            "defaultPalletTemplateId": null,
            "categories": []
        });
    });
    // A pallet slot filled with a box template.
    assert_eq!(
        refused(|body| {
            body["payload"]["templateDefaults"]["categories"][1]["templateId"] =
                json!("0d0d0000-0000-4000-8000-000000000002");
        }),
        "payload.templateDefaults.categories.1.templateId"
    );
    // The same category in the other slot is no repeat.
    accepted(|body| {
        body["payload"]["templateDefaults"]["categories"][1]["chzProductGroupCode"] = json!(8);
    });
}

#[test]
fn template_categories_and_layouts_follow_the_office_routes() {
    for codes in [json!([8, 8]), json!((1..=101).collect::<Vec<u32>>())] {
        assert_eq!(
            refused(|body| body["payload"]["templates"][1]["chzProductGroupCodes"] = codes),
            "payload.templates.1.chzProductGroupCodes"
        );
    }
    let mut deep = json!(1);
    for _ in 0..65 {
        deep = json!({ "a": deep });
    }
    assert_eq!(
        refused(|body| body["payload"]["templates"][0]["spec"] = deep),
        "payload.templates.0.spec"
    );
    assert_eq!(
        refused(
            |body| body["payload"]["templates"][0]["spec"] = json!({ "text": "я".repeat(300_000) })
        ),
        "payload.templates.0.spec"
    );
}

#[test]
fn an_a4_pallet_sheet_is_no_thermal_template_and_is_refused() {
    // The export leaves the cloud's A4 sheets out (`pallet_sheet_v2`); a file
    // that still carries one is damaged or made by hand: a shift that chose
    // it would stop at the station's entry.
    let sheet = json!({ "schemaVersion": 2, "kind": "pallet_sheet", "page": { "size": "A4" } });
    assert_eq!(
        refused(|body| body["payload"]["templates"][2]["spec"] = sheet.clone()),
        "payload.templates.2.spec"
    );
    assert_eq!(
        refused(|body| body["payload"]["templates"][0]["spec"]["kind"] = json!("pallet_sheet")),
        "payload.templates.0.spec"
    );
    // Only that kind: another `kind`, or a nested one, is a layout like any other.
    accepted(|body| body["payload"]["templates"][2]["spec"]["kind"] = json!("label"));
    accepted(|body| {
        body["payload"]["templates"][2]["spec"]["elements"] = json!([{ "kind": "pallet_sheet" }]);
    });
}

#[test]
fn a_badge_salt_is_sixteen_bytes_in_canonical_standard_base64() {
    for salt in [
        "",
        "bWFya2lyby1iYWRnZS0wMQ==\n",
        " bWFya2lyby1iYWRnZS0wMQ==",
        "bWFya2lyby1iYWRnZS0wMR==",
        "bWFya2lyby1iYWRnZS0wMQ==bWFya2lyby1iYWRnZS0wMQ==",
        "bWFya2lyby1iYWRnZS0wMQ-_",
        "bWFya2lyby1iYWRnZS0wMTI=",
    ] {
        assert_eq!(
            refused(|body| body["payload"]["badgeSalt"] = json!(salt)),
            "payload.badgeSalt",
            "{salt:?}"
        );
    }
}

#[test]
fn a_badge_hash_needs_the_files_salt_and_the_badge_iteration_count() {
    // Same salt, 99 999 iterations; and the same salt, 100 001.
    for iterations in ["99999", "100001", "0100000"] {
        let phc = format!(
            "pbkdf2$sha256${iterations}$bWFya2lyby1iYWRnZS0wMQ==$CFQuvVuv7iz+ANkhgZVnO2k8iP67A2gex7JV7uWRayo="
        );
        assert_eq!(
            refused(|body| body["payload"]["badges"][0]["badgePhc"] = json!(phc)),
            "payload.badges.0.badgePhc",
            "{iterations}"
        );
    }
    // Not a verifier at all.
    for phc in ["", "plain", "pbkdf2$sha256$100000$AAAA$BBBB"] {
        assert_eq!(
            refused(|body| body["payload"]["badges"][1]["badgePhc"] = json!(phc)),
            "payload.badges.1.badgePhc"
        );
    }
}

#[test]
fn a_pin_hash_is_any_well_formed_verifier_in_the_hosts_range() {
    let digest = "33q/nWS7HYqVkEapiJW+qfJkAK+dEw5JDvZadD5palE=";
    let salt = "bWFya2lyby1zdGFuZGFsbw==";
    for iterations in ["9999", "0", "10000000000"] {
        let phc = format!("pbkdf2$sha256${iterations}${salt}${digest}");
        assert_eq!(
            refused(|body| body["payload"]["operators"][1]["pinPhc"] = json!(phc)),
            "payload.operators.1.pinPhc",
            "{iterations}"
        );
    }
    for phc in [
        "",
        "pbkdf2$sha1$600000$bWFya2lyby1zdGFuZGFsbw==$33q/nWS7HYqVkEapiJW+qfJkAK+dEw5JDvZadD5palE=",
        "pbkdf2$sha256$600000$AAAA$33q/nWS7HYqVkEapiJW+qfJkAK+dEw5JDvZadD5palE=",
        "pbkdf2$sha256$600000$bWFya2lyby1zdGFuZGFsbw==$AAAA",
    ] {
        assert_eq!(
            refused(|body| body["payload"]["operators"][1]["pinPhc"] = json!(phc)),
            "payload.operators.1.pinPhc"
        );
    }
}

#[test]
fn a_refusal_never_shows_a_verifier_or_the_salt() {
    let golden = request();
    let mut secrets: Vec<String> = Vec::new();
    for row in golden["payload"]["operators"].as_array().unwrap() {
        secrets.push(row["pinPhc"].as_str().unwrap().to_owned());
    }
    for row in golden["payload"]["badges"].as_array().unwrap() {
        secrets.push(row["badgePhc"].as_str().unwrap().to_owned());
    }
    secrets.push(golden["payload"]["badgeSalt"].as_str().unwrap().to_owned());
    let offered_pin = "pbkdf2$sha256$0100000$bWFya2lyby1waW4tc2FsdA==$3OKvrZ2+EfTB2zsCso90r5g8c6Ib6t+Bv+cGJOpgPmU=";
    let offered_badge = "pbkdf2$sha256$100000$b2ZmZXJlZC1iYWRnZS1zYWw=$Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm8=";
    let offered_salt = "b2ZmZXJlZC1zYWx0LW5vdC1va2F5";
    secrets.extend([offered_pin, offered_badge, offered_salt].map(str::to_owned));
    let texts = [
        refusal_text(|body| body["payload"]["operators"][0]["pinPhc"] = json!(offered_pin)),
        refusal_text(|body| body["payload"]["badges"][0]["badgePhc"] = json!(offered_badge)),
        refusal_text(|body| body["payload"]["badgeSalt"] = json!(offered_salt)),
        refusal_text(|body| {
            body["payload"]["badges"][2]["badgePhc"] =
                body["payload"]["badges"][0]["badgePhc"].clone()
        }),
        refusal_text(|body| body["payload"]["badgeSalt"] = Value::Null),
        refusal_text(|body| {
            body["payload"]["badges"][0]["operatorId"] =
                json!("0f0f0000-0000-4000-8000-000000000003")
        }),
    ];
    for text in &texts {
        for secret in &secrets {
            assert!(!text.contains(secret.as_str()), "a refusal shows a secret");
            // No part of a verifier either: iterations aside, its salt and digest.
            for part in secret.split('$').filter(|part| part.len() >= 12) {
                assert!(!text.contains(part), "a refusal shows part of a secret");
            }
        }
    }
}

#[test]
fn an_sscc_counter_is_bounded_by_its_prefixs_serial_width() {
    let counter = |index: usize, prefix: &str, extension: u8, next: u64| {
        let prefix = prefix.to_owned();
        move |body: &mut Value| {
            body["payload"]["ssccCounters"][index] = json!({
                "issuerPrefix": prefix, "extension": extension, "nextSerial": next
            });
        }
    };
    // 4 digits: 12 serial digits; 12 digits: 4 serial digits.
    accepted(counter(2, "4601", 0, 999_999_999_999));
    assert_eq!(
        refused(counter(2, "4601", 0, 1_000_000_000_000)),
        "payload.ssccCounters.2.nextSerial"
    );
    accepted(counter(2, "460123400123", 1, 9_999));
    assert_eq!(
        refused(counter(2, "460123400123", 1, 10_000)),
        "payload.ssccCounters.2.nextSerial"
    );
    for prefix in ["460", "4601234001234", "", "４６０１２３４０", "46012340é"] {
        assert_eq!(
            refused(counter(2, prefix, 0, 1)),
            "payload.ssccCounters.2.issuerPrefix",
            "{prefix}"
        );
    }
    // The same prefix under the other extension is no repeat; the same
    // extension is, whatever the number.
    accepted(|body| {
        counter(2, "460068200", 1, 10_000)(body);
        body["payload"]["ssccCounters"][1] = json!({
            "issuerPrefix": "460123400", "extension": 1, "nextSerial": 0
        });
    });
    assert_eq!(
        refused(counter(2, "460068200", 0, 99)),
        "payload.ssccCounters.2"
    );
    accepted(|body| body["payload"]["ssccCounters"] = json!([]));
}

#[test]
fn a_month_key_is_three_capitals_of_a_month_and_two_digits() {
    // Every month the shifts write is a key the import reads.
    for month in 1..=12u8 {
        let date =
            time::Date::from_calendar_date(2027, time::Month::try_from(month).unwrap(), 1).unwrap();
        let key = markiro_host::shifts::month_key(date);
        accepted(|body| body["payload"]["shiftNumberCounters"][0]["monthKey"] = json!(key));
    }
    accepted(|body| body["payload"]["shiftNumberCounters"][0]["monthKey"] = json!("JAN00"));
    // A text cut inside a character must be refused, not panic the host.
    for key in [
        "AB\u{c0}1",
        "OCT\u{c0}",
        "\u{c0}\u{c0}1",
        "ОКТ26",
        "oct26",
        "OCT 6",
        "OCT-6",
        "",
    ] {
        assert_eq!(
            refused(|body| body["payload"]["shiftNumberCounters"][0]["monthKey"] = json!(key)),
            "payload.shiftNumberCounters.0.monthKey",
            "{key:?}"
        );
    }
    assert_eq!(
        refused(|body| body["payload"]["shiftNumberCounters"][2]["monthKey"] = json!("NOV26")),
        "payload.shiftNumberCounters.2.monthKey"
    );
    accepted(|body| {
        body["payload"]["shiftNumberCounters"][0]["lastSeq"] = json!(u32::MAX);
    });
    accepted(|body| body["payload"]["shiftNumberCounters"] = json!([]));
}
