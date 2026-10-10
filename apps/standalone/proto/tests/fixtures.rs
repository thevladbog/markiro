use markiro_proto::{
    category_default_id, certificate_fingerprint, codes, compatibility, compatibility_for,
    credentials, display_fingerprint, BadgeCreate, BadgeSalt, BlockSizesUpdate, BootstrapRequest,
    BootstrapResponse, BoxClosedFact, BoxExceptionFact, BoxLabelFact, CategoryTemplateDefault,
    ChangesResponse, ClaimRequest, CodeCheck, CodeOwner, Compatibility, CounterpartyCreate,
    CounterpartyRecord, CounterpartyUpdate, DeviceInfo, DeviceKind, DeviceLineRequest,
    DeviceRecord, DeviceShift, DeviceShiftCreate, DeviceShifts, DeviceUpdate, ErrorBody,
    ExceptionKind, FactBatch, FactKind, FactOutcome, FactReceipts, Hello, HelloEnvelope,
    LabelOutcome, LabelTemplate, LabelTemplateCreate, LabelTemplateRecord, LabelTemplateSummary,
    LabelTemplateUpdate, LineCreate, LineRecord, LineUpdate, LocalPairRequest, OfficeLine,
    OfficeLoginRequest, OfficeOperator, OfficeProduct, OfficeRole, OfficeSession, OfficeShift,
    OfficeUser, OfficeUserCreate, OfficeUserRecord, OfficeUserUpdate, OperatorBadgeRecord,
    OperatorCreate, OperatorRecord, OperatorUpdate, OrgProfile, OrgProfileUpdate, OrgRecord,
    PairResponse, PairingCode, PairingCodeRequest, PasswordChange, PasswordSet, ProductCreate,
    ProductGroup, ProductRecord, ProductStatus, ProductUpdate, ScanFact, ScanRawKind, ScanVerdict,
    ShiftClose, ShiftClosedFact, ShiftCreate, ShiftMode, ShiftOrigin, ShiftStatus, ShiftUpdate,
    SiteRecord, SsccBlock, SsccBlockRequest, SsccCounterUpdate, SsccState, TemplateDefaults,
    TemplateDefaultsUpdate, TemplatePurpose, HOST_PRODUCT, PROTOCOL_VERSION,
};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;

fn fixture(name: &str) -> Value {
    let path = format!("{}/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    let text =
        std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("read {path}: {error}"));
    serde_json::from_str(&text).unwrap_or_else(|error| panic!("parse {path}: {error}"))
}

/// The `site` item of `changes-response.json`, found by its entity: what the
/// tests read from it must not depend on where the fixture lists it.
fn site_item(feed: &Value) -> &Value {
    feed["items"]
        .as_array()
        .expect("the feed fixture lists its items")
        .iter()
        .find(|item| item["entity"] == "site")
        .expect("the feed fixture has a site item")
}

/// Deserialize into `T` and serialize back: the JSON must survive unchanged.
fn round_trip<T: DeserializeOwned + Serialize>(name: &str) -> T {
    let original = fixture(name);
    let typed: T =
        serde_json::from_value(original.clone()).unwrap_or_else(|error| panic!("{name}: {error}"));
    assert_eq!(
        serde_json::to_value(&typed).unwrap(),
        original,
        "{name} changed on round trip"
    );
    typed
}

#[test]
fn hello_fixture_round_trips() {
    let hello: Hello = round_trip("hello.json");
    assert_eq!(hello.product, HOST_PRODUCT);
    assert_eq!(hello.protocol, PROTOCOL_VERSION);
}

#[test]
fn error_fixtures_round_trip() {
    let not_found: ErrorBody = round_trip("error-not-found.json");
    assert_eq!(not_found.error.code, codes::NOT_FOUND);
    assert!(not_found.error.details.is_none());
    let unsupported: ErrorBody = round_trip("error-with-details.json");
    assert_eq!(unsupported.error.code, codes::PROTOCOL_UNSUPPORTED);
    let unauthorized: ErrorBody = round_trip("error-unauthorized.json");
    assert_eq!(unauthorized.error.code, codes::UNAUTHORIZED);
    assert_eq!(
        unauthorized.error.details.unwrap()["credential"],
        credentials::SESSION
    );
}

#[test]
fn hello_ignores_fields_added_by_newer_hosts() {
    let hello: Hello = serde_json::from_value(fixture("hello-future.json")).unwrap();
    assert_eq!(hello.protocol, 3);
    assert!(hello.initialized);
}

#[test]
fn envelope_decides_compatibility_before_the_rest() {
    let future: HelloEnvelope = serde_json::from_value(fixture("hello-future.json")).unwrap();
    assert_eq!(compatibility_for(1, &future), Compatibility::AppTooOld);
    assert_eq!(compatibility_for(2, &future), Compatibility::Compatible);
    assert_eq!(compatibility_for(4, &future), Compatibility::HostTooOld);
    let current: HelloEnvelope = serde_json::from_value(fixture("hello.json")).unwrap();
    assert_eq!(compatibility(&current), Compatibility::Compatible);
}

#[test]
fn display_fingerprint_groups_the_first_32_characters() {
    assert_eq!(
        display_fingerprint(&"0123456789abcdef".repeat(4)),
        "0123 4567 89AB CDEF 0123 4567 89AB CDEF"
    );
}

#[test]
fn fingerprint_is_lower_case_hex_sha256() {
    assert_eq!(
        certificate_fingerprint(b""),
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
}

#[test]
fn error_details_must_be_an_object() {
    let mut value = fixture("error-with-details.json");
    value["error"]["details"] = Value::String("not an object".into());
    assert!(serde_json::from_value::<ErrorBody>(value).is_err());
}

#[test]
fn pairing_fixtures_round_trip() {
    let request: LocalPairRequest = round_trip("local-pair-request.json");
    assert_eq!(request.kind, DeviceKind::Station);
    let _: PairResponse = round_trip("pair-response.json");
    let info: DeviceInfo = round_trip("device-info.json");
    assert!(info.line_id.is_none());
}

#[test]
fn requests_reject_unknown_fields() {
    let mut value = fixture("local-pair-request.json");
    value["extra"] = Value::Bool(true);
    assert!(serde_json::from_value::<LocalPairRequest>(value).is_err());
}

#[test]
fn office_auth_fixtures_round_trip() {
    let _: OfficeLoginRequest = round_trip("office-login-request.json");
    let user: OfficeUser = round_trip("office-user.json");
    assert_eq!(user.role, OfficeRole::Admin);
    let session: OfficeSession = round_trip("office-session.json");
    assert_eq!(session.user, user);
}

#[test]
fn bootstrap_and_org_fixtures_round_trip() {
    let bootstrap: BootstrapRequest = round_trip("bootstrap-request.json");
    assert_eq!(bootstrap.sscc.pallet_next_serial, 0);
    assert_eq!(bootstrap.lines, vec!["Линия 1".to_owned()]);
    let response: BootstrapResponse = round_trip("bootstrap-response.json");
    assert_eq!(response.session.user.login, "admin");
    let _: OrgProfile = round_trip("org-profile.json");
    let update: OrgProfileUpdate = round_trip("org-profile-update.json");
    assert!(update.inn.is_none());
}

#[test]
fn sscc_and_user_admin_fixtures_round_trip() {
    let state: SsccState = round_trip("sscc-state.json");
    assert_eq!(state.counters[0].max_serial, 9_999_999);
    assert_eq!(state.current_issuer_prefix, "460068200");
    assert_eq!(state.block_sizes_rev, 1);
    let _: SsccCounterUpdate = round_trip("sscc-counter-update.json");
    let _: BlockSizesUpdate = round_trip("block-sizes-update.json");
    let record: OfficeUserRecord = round_trip("office-user-record.json");
    assert!(record.active);
    let _: OfficeUserCreate = round_trip("office-user-create.json");
    let _: OfficeUserUpdate = round_trip("office-user-update.json");
    let _: PasswordSet = round_trip("password-set.json");
}

#[test]
fn password_change_fixture_round_trips_without_leaking() {
    let change: PasswordChange = round_trip("password-change.json");
    assert_ne!(change.current_password, change.new_password);
    let debug = format!("{change:?}");
    assert!(!debug.contains(change.current_password.expose()));
    assert!(!debug.contains(change.new_password.expose()));
}

#[test]
fn pairing_code_fixture_round_trips_without_leaking() {
    let code: PairingCode = round_trip("pairing-code.json");
    assert_eq!(code.created_at, "2026-09-26T09:15:00Z");
    let debug = format!("{code:?}");
    assert!(!debug.contains(code.code.expose()), "{debug}");
    assert!(!debug.contains("markiro-host:1"), "{debug}");
}

#[test]
fn a_pairing_code_request_is_optional_and_strict() {
    let request: PairingCodeRequest = round_trip("pairing-code-request.json");
    let code: PairingCode = serde_json::from_value(fixture("pairing-code.json")).unwrap();
    assert_eq!(request.replaces, Some(code.id));
    let empty: PairingCodeRequest = serde_json::from_value(serde_json::json!({})).unwrap();
    assert_eq!(empty.replaces, None);
    assert_eq!(serde_json::to_value(&empty).unwrap(), serde_json::json!({}));
    let mut value = fixture("pairing-code-request.json");
    value["code"] = Value::String("7K3MQ9XV2D".into());
    assert!(serde_json::from_value::<PairingCodeRequest>(value).is_err());
}

#[test]
fn secrets_never_appear_in_debug_output() {
    let pair: PairResponse = serde_json::from_value(fixture("pair-response.json")).unwrap();
    let login: OfficeLoginRequest =
        serde_json::from_value(fixture("office-login-request.json")).unwrap();
    let session: OfficeSession = serde_json::from_value(fixture("office-session.json")).unwrap();
    let bootstrap: BootstrapRequest =
        serde_json::from_value(fixture("bootstrap-request.json")).unwrap();
    let create: OfficeUserCreate =
        serde_json::from_value(fixture("office-user-create.json")).unwrap();
    let password: PasswordSet = serde_json::from_value(fixture("password-set.json")).unwrap();
    let debug = format!("{pair:?} {login:?} {session:?} {bootstrap:?} {create:?} {password:?}");
    for secret in [
        pair.device_key.expose(),
        login.password.expose(),
        session.token.expose(),
        bootstrap.admin.password.expose(),
        create.password.expose(),
        password.password.expose(),
    ] {
        assert!(!debug.contains(secret), "Debug output leaks a secret");
    }
    assert_eq!(debug.matches("Secret(***)").count(), 6);
}

#[test]
fn claim_request_round_trips_rejects_unknown_fields_and_hides_the_code() {
    let request: ClaimRequest = round_trip("claim-request.json");
    assert!(!format!("{request:?}").contains("7K3MQ9XV2D"));
    let mut value = fixture("claim-request.json");
    value["extra"] = Value::Bool(true);
    assert!(serde_json::from_value::<ClaimRequest>(value).is_err());
}

#[test]
fn device_line_and_record_fixtures_round_trip() {
    let request: DeviceLineRequest = round_trip("device-line-request.json");
    assert_eq!(request.line_id, "5f0c6a52-6a3e-4b9f-9d3c-2b1a0e8f7d61");
    let mut value = fixture("device-line-request.json");
    value["extra"] = Value::Bool(true);
    assert!(serde_json::from_value::<DeviceLineRequest>(value).is_err());
    let record: DeviceRecord = round_trip("device-record.json");
    assert_eq!(record.kind, DeviceKind::Station);
    assert_eq!(record.revoked_at, None);
}

#[test]
fn the_change_feed_fixture_round_trips_with_typed_records() {
    let changes: ChangesResponse = round_trip("changes-response.json");
    assert_eq!(changes.items.len(), 4);
    let line: LineRecord = serde_json::from_value(changes.items[0].data.clone().unwrap()).unwrap();
    assert_eq!(
        line,
        LineRecord {
            name: "Линия 2".into(),
            archived: false
        }
    );
    let org: OrgRecord = serde_json::from_value(changes.items[1].data.clone().unwrap()).unwrap();
    assert_eq!(org.inn, None);
    let site: SiteRecord = serde_json::from_value(changes.items[2].data.clone().unwrap()).unwrap();
    assert_eq!(site.badge_salt.expose().len(), 24);
    assert!(changes.items[3].deleted && changes.items[3].data.is_none());
}

#[test]
fn the_people_feed_fixture_round_trips_without_leaking_hashes() {
    let changes: ChangesResponse = round_trip("changes-people.json");
    assert_eq!(changes.items.len(), 4);
    let operator: OperatorRecord =
        serde_json::from_value(changes.items[0].data.clone().unwrap()).unwrap();
    // The PIN hash is the one TypeScript computed for the PIN 4821.
    assert_eq!(
        operator.pin_phc.expose(),
        fixture("phc-password.json")["pinPhc"].as_str().unwrap()
    );
    let badge: OperatorBadgeRecord =
        serde_json::from_value(changes.items[1].data.clone().unwrap()).unwrap();
    assert_eq!(badge.operator_id, changes.items[0].id);
    assert_eq!(badge.label, None);
    // The badge is hashed with the site's badge salt: both sides must exist,
    // or two missing values would compare equal.
    let feed = fixture("changes-response.json");
    let salt = site_item(&feed)["data"]["badgeSalt"]
        .as_str()
        .expect("the site record carries a badge salt");
    assert_eq!(
        badge
            .badge_phc
            .expose()
            .split('$')
            .nth(3)
            .expect("a PHC string carries a salt"),
        salt
    );
    assert!(changes.items[2..]
        .iter()
        .all(|item| item.deleted && item.data.is_none()));
    let debug = format!("{operator:?} {badge:?}");
    assert!(!debug.contains("pbkdf2"), "{debug}");
}

/// The feed's envelope prints its entity, id and revision but never the
/// record: `data` carries `pinPhc` and `badgePhc` on the wire, and the site
/// record carries the badge salt, so a stray `{:?}` or a `tracing` field must
/// not leak them.
#[test]
fn the_feed_envelope_and_the_site_record_print_without_hashes_or_the_salt() {
    let people = fixture("changes-people.json");
    let feed = fixture("changes-response.json");
    let text = |value: &Value| value.as_str().expect("a string").to_owned();
    let pin = text(&people["items"][0]["data"]["pinPhc"]);
    let badge = text(&people["items"][1]["data"]["badgePhc"]);
    let salt = text(&site_item(&feed)["data"]["badgeSalt"]);

    let people: ChangesResponse = serde_json::from_value(people).unwrap();
    let feed: ChangesResponse = serde_json::from_value(feed).unwrap();
    let site: SiteRecord = serde_json::from_value(
        feed.items
            .iter()
            .find(|item| item.entity == "site")
            .and_then(|item| item.data.clone())
            .expect("the feed fixture has a site record"),
    )
    .unwrap();
    let debug = format!("{people:?}\n{feed:?}\n{site:?}");
    for (name, secret) in [
        ("PIN hash", &pin),
        ("badge hash", &badge),
        ("badge salt", &salt),
    ] {
        assert!(!debug.contains(secret.as_str()), "the {name} is printed");
    }
    assert!(!debug.contains("pbkdf2"), "a PHC string is printed");

    // What is printed still tells the items apart.
    for item in people.items.iter().chain(&feed.items) {
        for shown in [&item.entity, &item.id, &item.rev.to_string()] {
            assert!(debug.contains(shown.as_str()), "{shown} is not printed");
        }
    }
}

#[test]
fn counterparty_fixtures_round_trip_and_requests_reject_unknown_fields() {
    let record: CounterpartyRecord = round_trip("counterparty-record.json");
    assert!(!record.archived);
    let create: CounterpartyCreate = round_trip("counterparty-create.json");
    assert_eq!(create.inn, None);
    let update: CounterpartyUpdate = round_trip("counterparty-update.json");
    assert!(update.archived);
    let mut value = fixture("counterparty-create.json");
    value["notes"] = Value::Bool(true);
    assert!(serde_json::from_value::<CounterpartyCreate>(value).is_err());
    let mut value = fixture("counterparty-update.json");
    value["notes"] = Value::Bool(true);
    assert!(serde_json::from_value::<CounterpartyUpdate>(value).is_err());
}

#[test]
fn line_fixtures_round_trip_and_an_update_carries_only_what_changes() {
    let line: OfficeLine = round_trip("office-line.json");
    assert!(!line.archived);
    let create: LineCreate = round_trip("line-create.json");
    assert_eq!(create.name, "Линия 3");
    let update: LineUpdate = round_trip("line-update.json");
    assert_eq!((update.name, update.archived), (None, Some(true)));
    let mut value = fixture("line-update.json");
    value["rename"] = Value::Bool(true);
    assert!(serde_json::from_value::<LineUpdate>(value).is_err());
    // A line is created active: `archived` is an update's field, not a create's.
    let mut value = fixture("line-create.json");
    value["archived"] = Value::Bool(true);
    assert!(serde_json::from_value::<LineCreate>(value).is_err());
}

#[test]
fn operator_fixtures_round_trip_without_leaking_the_pin_hash() {
    let operator: OfficeOperator = round_trip("office-operator.json");
    assert!(operator.has_pin);
    // Oldest first, as the host lists them: the revoked badge, then the live one.
    assert_eq!(
        operator.badges[0].revoked_at.as_deref(),
        Some("2026-09-27T08:00:00Z")
    );
    let create: OperatorCreate = round_trip("operator-create.json");
    let update: OperatorUpdate = round_trip("operator-update.json");
    // `role: null` clears the role; an absent role keeps it.
    assert_eq!(
        (update.name.clone(), update.role.clone()),
        (None, Some(None))
    );
    let absent: OperatorUpdate =
        serde_json::from_value(serde_json::json!({ "expectedRev": 55 })).unwrap();
    assert_eq!(absent.role, None);
    assert_eq!(
        serde_json::to_value(&absent).unwrap(),
        serde_json::json!({ "expectedRev": 55 })
    );
    let debug = format!("{create:?} {update:?}");
    assert!(!debug.contains("pbkdf2"), "{debug}");
    // A raw PIN is not a field, and the personnel number never changes.
    let mut value = fixture("operator-create.json");
    value["pin"] = Value::String("4821".into());
    assert!(serde_json::from_value::<OperatorCreate>(value).is_err());
    let mut value = fixture("operator-update.json");
    value["login"] = Value::String("0043".into());
    assert!(serde_json::from_value::<OperatorUpdate>(value).is_err());
}

#[test]
fn badge_fixtures_round_trip_without_leaking() {
    let create: BadgeCreate = round_trip("badge-create.json");
    let salt: BadgeSalt = round_trip("badge-salt.json");
    // The badge is hashed with the salt the office read.
    assert_eq!(
        create.badge_phc.expose().split('$').nth(3),
        Some(salt.badge_salt.expose())
    );
    let debug = format!("{create:?} {salt:?}");
    assert!(!debug.contains("pbkdf2"), "{debug}");
    assert!(!debug.contains(salt.badge_salt.expose()), "{debug}");
    // The badge code itself is never a field.
    let mut value = fixture("badge-create.json");
    value["code"] = Value::String("MRK-000742".into());
    assert!(serde_json::from_value::<BadgeCreate>(value).is_err());
}

#[test]
fn a_device_update_tells_a_cleared_line_from_an_absent_one() {
    let update: DeviceUpdate = round_trip("device-update.json");
    assert_eq!(update.line_id, Some(None));
    let rename: DeviceUpdate =
        serde_json::from_value(serde_json::json!({ "name": "Станция" })).unwrap();
    assert_eq!(rename.line_id, None);
    let line = "5f0c6a52-6a3e-4b9f-9d3c-2b1a0e8f7d61";
    let assign: DeviceUpdate =
        serde_json::from_value(serde_json::json!({ "lineId": line })).unwrap();
    assert_eq!(assign.line_id, Some(Some(line.to_owned())));
    let mut value = fixture("device-update.json");
    value["kind"] = Value::String("office".into());
    assert!(serde_json::from_value::<DeviceUpdate>(value).is_err());
}

/// `value` read as `T` and written back unchanged: the typed record keeps
/// every field the feed sent.
fn typed<T: DeserializeOwned + Serialize>(value: &Value) -> T {
    let typed: T = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(&serde_json::to_value(&typed).unwrap(), value);
    typed
}

#[test]
fn the_catalog_feed_fixture_round_trips_with_typed_records() {
    let changes: ChangesResponse = round_trip("changes-catalog.json");
    assert_eq!(changes.items.len(), 8);
    let data = |index: usize| changes.items[index].data.clone().expect("a live record");
    let id = |index: usize| changes.items[index].id.as_str();

    let stock: LabelTemplateRecord = typed(&data(0));
    assert!(stock.stock && stock.enabled);
    assert_eq!(stock.chz_product_group_codes, None);
    let milk: LabelTemplateRecord = typed(&data(1));
    assert_eq!(
        (milk.purpose, milk.chz_product_group_codes),
        (TemplatePurpose::Box, Some(vec![8]))
    );
    // The organization's box default is the stock template, for every category.
    let org: OrgRecord = typed(&data(2));
    assert_eq!(org.default_box_template_id.as_deref(), Some(id(0)));
    assert_eq!(org.default_pallet_template_id, None);
    // A category default's id is its slot.
    let default: CategoryTemplateDefault = typed(&data(3));
    assert_eq!(
        id(3),
        category_default_id(default.chz_product_group_code, default.purpose)
    );
    assert_eq!(default.template_id, id(1));
    let product: ProductRecord = typed(&data(4));
    assert_eq!(
        (product.status, product.default_box_template_id.as_deref()),
        (ProductStatus::Active, Some(id(1)))
    );
    // An archived product rides the feed with its flag.
    let archived: ProductRecord = typed(&data(5));
    assert_eq!(
        (archived.archived, archived.status),
        (true, ProductStatus::Draft)
    );
    assert!(changes.items[6..]
        .iter()
        .all(|item| item.deleted && item.data.is_none()));

    // An organization record from before plan 1e1 reads as no defaults.
    let older: OrgRecord =
        serde_json::from_value(fixture("changes-response.json")["items"][1]["data"].clone())
            .unwrap();
    assert_eq!(
        (
            older.default_box_template_id,
            older.default_pallet_template_id,
            older.default_duplicate_template_id
        ),
        (None, None, None)
    );
}

#[test]
fn a_product_group_fixture_round_trips() {
    let group: ProductGroup = round_trip("product-group.json");
    assert_eq!((group.code, group.alias.as_str()), (8, "milk"));
}

#[test]
fn product_fixtures_round_trip_and_requests_reject_unknown_fields() {
    let product: OfficeProduct = round_trip("office-product.json");
    assert_eq!(product.status, ProductStatus::Active);
    let create: ProductCreate = round_trip("product-create.json");
    assert_eq!(create.gtin14, product.gtin14);
    let update: ProductUpdate = round_trip("product-update.json");
    assert_eq!((update.archived, update.print_name), (true, None));
    // Left out, an optional field reads as none.
    let bare: ProductCreate =
        serde_json::from_value(serde_json::json!({ "gtin14": "04600682000013", "name": "Молоко" }))
            .unwrap();
    assert_eq!(
        (
            bare.print_name,
            bare.chz_product_group_code,
            bare.box_capacity
        ),
        (None, None, None)
    );
    // A product is created in use, and nobody sends its status.
    let mut value = fixture("product-create.json");
    value["archived"] = Value::Bool(false);
    assert!(serde_json::from_value::<ProductCreate>(value).is_err());
    let mut value = fixture("product-update.json");
    value["status"] = Value::String("active".into());
    assert!(serde_json::from_value::<ProductUpdate>(value).is_err());
}

#[test]
fn template_fixtures_round_trip_and_a_purpose_is_never_an_update_field() {
    let summary: LabelTemplateSummary = round_trip("template-summary.json");
    assert_eq!(
        (summary.dpi, summary.language.as_deref()),
        (Some(203), Some("tspl"))
    );
    let template: LabelTemplate = round_trip("label-template.json");
    assert_eq!(template.id, summary.id);
    assert_eq!(
        template.spec["widthMm"],
        serde_json::to_value(&summary.width_mm).unwrap()
    );
    let create: LabelTemplateCreate = round_trip("template-create.json");
    assert_eq!(create.chz_product_group_codes, None);
    let update: LabelTemplateUpdate = round_trip("template-update.json");
    assert_eq!(update.chz_product_group_codes, Some(Some(vec![8, 15])));
    // `null` widens a template to every category; leaving the field out keeps
    // its categories.
    let widen: LabelTemplateUpdate = serde_json::from_value(
        serde_json::json!({ "chzProductGroupCodes": null, "expectedRev": 62 }),
    )
    .unwrap();
    assert_eq!(widen.chz_product_group_codes, Some(None));
    let keep: LabelTemplateUpdate =
        serde_json::from_value(serde_json::json!({ "enabled": false, "expectedRev": 62 })).unwrap();
    assert_eq!(keep.chz_product_group_codes, None);
    // A purpose never changes, and no request makes a stock template.
    let mut value = fixture("template-update.json");
    value["purpose"] = Value::String("pallet".into());
    assert!(serde_json::from_value::<LabelTemplateUpdate>(value).is_err());
    let mut value = fixture("template-create.json");
    value["stock"] = Value::Bool(true);
    assert!(serde_json::from_value::<LabelTemplateCreate>(value).is_err());
    // A refusal names the defaults that stand in the way.
    let refused: ErrorBody = round_trip("error-template-is-default.json");
    let details = refused.error.details.expect("details");
    assert_eq!(
        (
            details["constraint"].as_str(),
            details["organizationDefault"].as_bool()
        ),
        (Some("template_is_default"), Some(true))
    );
}

#[test]
fn template_defaults_fixtures_round_trip_as_one_document() {
    let document: TemplateDefaults = round_trip("template-defaults.json");
    let update: TemplateDefaultsUpdate = round_trip("template-defaults-update.json");
    assert_eq!(update.categories.len(), document.categories.len());
    let entry = &update.categories[0];
    assert_eq!(
        (
            entry.chz_product_group_code,
            entry.purpose,
            &entry.template_id
        ),
        (
            document.categories[0].chz_product_group_code,
            document.categories[0].purpose,
            &document.categories[0].template_id
        )
    );
    // A slot is the category and the purpose; nothing else is sent.
    let mut value = fixture("template-defaults-update.json");
    value["categories"][0]["rev"] = Value::from(64);
    assert!(serde_json::from_value::<TemplateDefaultsUpdate>(value).is_err());
    // The organization's defaults left out are none; the categories are
    // always the whole list.
    let bare: TemplateDefaultsUpdate =
        serde_json::from_value(serde_json::json!({ "categories": [], "expectedRev": 1 })).unwrap();
    assert_eq!(bare.default_box_template_id, None);
    assert!(serde_json::from_value::<TemplateDefaultsUpdate>(
        serde_json::json!({ "expectedRev": 1 })
    )
    .is_err());
}

#[test]
fn a_wizard_with_stock_templates_round_trips_and_an_older_one_still_reads() {
    let request: BootstrapRequest = round_trip("bootstrap-request-templates.json");
    assert_eq!(request.templates.len(), 3);
    let defaults: Vec<TemplatePurpose> = request
        .templates
        .iter()
        .filter(|template| template.org_default)
        .map(|template| template.purpose)
        .collect();
    assert_eq!(
        defaults,
        vec![TemplatePurpose::Box, TemplatePurpose::Pallet]
    );
    // A wizard from before plan 1e3 sends no templates.
    let older: BootstrapRequest = round_trip("bootstrap-request.json");
    assert!(older.templates.is_empty());
    // A stock template is enabled for every category: neither is a field.
    for field in ["enabled", "chzProductGroupCodes"] {
        let mut value = fixture("bootstrap-request-templates.json");
        value["templates"][0][field] = Value::Null;
        assert!(
            serde_json::from_value::<BootstrapRequest>(value).is_err(),
            "{field}"
        );
    }
}

#[test]
fn the_error_code_fixture_lists_every_code() {
    let listed = fixture("error-codes.json");
    let mut listed: Vec<&str> = listed["codes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|code| code.as_str().unwrap())
        .collect();
    listed.sort_unstable();
    let mut known = markiro_proto::codes::ALL.to_vec();
    known.sort_unstable();
    assert_eq!(listed, known);
}

#[test]
fn the_pairing_code_fixture_matches_normalize() {
    let fixture = fixture("pairing-codes.json");
    let cases = fixture["cases"].as_array().expect("cases");
    assert_eq!(cases.len(), 31);
    for case in cases {
        let input = case["input"].as_str().expect("input");
        assert_eq!(
            markiro_proto::pairing::normalize(input).as_deref(),
            case["normalized"].as_str(),
            "{input:?}"
        );
    }
}

#[test]
fn office_shift_fixtures_round_trip_and_a_plan_carries_no_number_or_status() {
    let shift: OfficeShift = round_trip("office-shift.json");
    assert_eq!(
        (shift.status, shift.mode, shift.created_from),
        (
            ShiftStatus::Active,
            ShiftMode::Aggregation,
            ShiftOrigin::Office
        )
    );
    let create: ShiftCreate = round_trip("shift-create.json");
    assert_eq!(
        (&create.product_id, &create.line_id, &create.box_template_id),
        (&shift.product_id, &shift.line_id, &shift.box_template_id)
    );
    // Left out, the mode is aggregation, pallets are off and the optional
    // fields are none.
    let bare: ShiftCreate = serde_json::from_value(serde_json::json!({
        "productId": create.product_id, "lineId": create.line_id,
        "productionDate": "2026-10-08", "boxTemplateId": create.box_template_id
    }))
    .unwrap();
    assert_eq!(
        (
            bare.mode,
            bare.pallets_enabled,
            bare.box_capacity,
            bare.planned_qty,
            bare.counterparty_id
        ),
        (ShiftMode::Aggregation, false, None, None, None)
    );
    // The host draws the number and owns the status.
    for field in ["number", "status"] {
        let mut value = fixture("shift-create.json");
        value[field] = Value::String("planned".into());
        assert!(
            serde_json::from_value::<ShiftCreate>(value).is_err(),
            "{field}"
        );
    }
}

#[test]
fn a_shift_update_carries_only_what_changes_and_never_the_product() {
    let update: ShiftUpdate = round_trip("shift-update.json");
    // `plannedQty: null` clears the plan; an absent counterparty stays.
    assert_eq!(
        (update.planned_qty, update.counterparty_id.clone()),
        (Some(None), None)
    );
    // `counterpartyId: null` clears the counterparty, which is not leaving it
    // out, and it goes back out as `null`.
    let cleared: ShiftUpdate =
        serde_json::from_value(serde_json::json!({ "counterpartyId": null, "expectedRev": 1 }))
            .unwrap();
    assert_eq!(cleared.counterparty_id, Some(None));
    assert_eq!(
        serde_json::to_value(&cleared).unwrap(),
        serde_json::json!({ "counterpartyId": null, "expectedRev": 1 })
    );
    let bare: ShiftUpdate =
        serde_json::from_value(serde_json::json!({ "expectedRev": 71 })).unwrap();
    assert_eq!(
        serde_json::to_value(&bare).unwrap(),
        serde_json::json!({ "expectedRev": 71 })
    );
    let mut value = fixture("shift-update.json");
    value["productId"] = Value::String("f1e2d3c4-b5a6-4978-8a6b-5c4d3e2f1a0b".into());
    assert!(serde_json::from_value::<ShiftUpdate>(value).is_err());
}

#[test]
fn device_shift_fixtures_round_trip_and_a_station_names_no_line() {
    let list: DeviceShifts = round_trip("device-shifts.json");
    let office: OfficeShift = serde_json::from_value(fixture("office-shift.json")).unwrap();
    // The station's view of the office's shift: the same number and owner.
    let open: &DeviceShift = &list.shifts[0];
    assert_eq!(
        (&open.id, &open.number, &open.owner_device_id),
        (&office.id, &office.number, &office.owner_device_id)
    );
    let planned = &list.shifts[1];
    assert_eq!(
        (
            planned.status,
            planned.created_from,
            planned.number.ends_with("/S")
        ),
        (ShiftStatus::Planned, ShiftOrigin::Station, true)
    );
    let create: DeviceShiftCreate = round_trip("device-shift-create.json");
    assert_eq!(create.production_date, planned.production_date);
    // A station creates on its own line and never says which.
    let mut value = fixture("device-shift-create.json");
    value["lineId"] = Value::String(office.line_id);
    assert!(serde_json::from_value::<DeviceShiftCreate>(value).is_err());
    let mut value = fixture("device-shift-create.json");
    value.as_object_mut().unwrap().remove("requestId");
    assert!(serde_json::from_value::<DeviceShiftCreate>(value).is_err());
}

#[test]
fn an_entered_shift_carries_its_snapshot_and_the_list_never_does() {
    let entered: DeviceShift = round_trip("device-shift-entered.json");
    let snapshot = entered
        .snapshot
        .clone()
        .expect("an entry carries the snapshot");
    // The snapshot is the product and the template as the office had them.
    let product: OfficeProduct = serde_json::from_value(fixture("office-product.json")).unwrap();
    let template: LabelTemplate = serde_json::from_value(fixture("label-template.json")).unwrap();
    assert_eq!(
        (
            &snapshot.product.id,
            &snapshot.product.gtin14,
            &snapshot.product.print_name
        ),
        (&product.id, &product.gtin14, &product.print_name)
    );
    assert_eq!(
        (
            &snapshot.box_template.id,
            snapshot.box_template.rev,
            &snapshot.box_template.spec
        ),
        (&template.id, template.rev, &template.spec)
    );
    let state: SsccState = serde_json::from_value(fixture("sscc-state.json")).unwrap();
    assert_eq!(snapshot.issuer_prefix, state.current_issuer_prefix);
    // The same shift in the list, without the snapshot.
    let list: DeviceShifts = serde_json::from_value(fixture("device-shifts.json")).unwrap();
    assert_eq!(
        DeviceShift {
            snapshot: None,
            ..entered
        },
        list.shifts[0]
    );
    assert!(list.shifts.iter().all(|shift| shift.snapshot.is_none()));
    let busy: ErrorBody = round_trip("error-shift-busy.json");
    assert_eq!(
        (
            busy.error.code.as_str(),
            busy.error.details.expect("details")["constraint"].as_str()
        ),
        (codes::CONFLICT, Some("shift_busy"))
    );
}

#[test]
fn a_shift_close_carries_the_reason_and_the_revision() {
    let close: ShiftClose = round_trip("shift-close.json");
    let office: OfficeShift = serde_json::from_value(fixture("office-shift.json")).unwrap();
    assert_eq!(close.expected_rev, office.rev);
    // The office's close names no reason code: the six codes are a
    // station's.
    let mut value = fixture("shift-close.json");
    value["reasonCode"] = Value::String("equipment_failure".into());
    assert!(serde_json::from_value::<ShiftClose>(value).is_err());
}

#[test]
fn sscc_block_fixtures_round_trip_and_a_station_never_names_the_size() {
    let request: SsccBlockRequest = round_trip("sscc-block-request.json");
    let block: SsccBlock = round_trip("sscc-block.json");
    let state: SsccState = serde_json::from_value(fixture("sscc-state.json")).unwrap();
    // The first block starts where the box counter stood.
    let counter = &state.counters[0];
    assert_eq!(
        (&request.issuer_prefix, request.extension, block.from_serial),
        (
            &counter.issuer_prefix,
            counter.extension,
            counter.next_serial
        )
    );
    assert_eq!(
        block.to_serial - block.from_serial + 1,
        u64::from(state.box_block_size)
    );
    let mut value = fixture("sscc-block-request.json");
    value["size"] = Value::from(10);
    assert!(serde_json::from_value::<SsccBlockRequest>(value).is_err());
    let exhausted: ErrorBody = round_trip("error-sscc-exhausted.json");
    assert_eq!(exhausted.error.code, codes::SSCC_EXHAUSTED);
}

/// The receipt codes and the reason codes, as the webview reads them from
/// the same fixtures: a code added on one side only fails here.
#[test]
fn the_fact_code_fixtures_list_every_receipt_and_reason_code() {
    let codes = fixture("fact-receipt-codes.json");
    assert_eq!(
        serde_json::from_value::<Vec<String>>(codes["codes"].clone()).unwrap(),
        markiro_proto::receipt_codes::ALL
    );
    let reasons = fixture("exception-reasons.json");
    assert_eq!(
        serde_json::from_value::<Vec<String>>(reasons["reprint"].clone()).unwrap(),
        markiro_proto::exception_reasons::REPRINT
    );
    assert_eq!(
        serde_json::from_value::<Vec<String>>(reasons["disassemble"].clone()).unwrap(),
        markiro_proto::exception_reasons::DISASSEMBLE
    );
    assert_eq!(reasons["other"], markiro_proto::exception_reasons::OTHER);
    assert_eq!(
        reasons["maxTextChars"],
        markiro_proto::exception_reasons::MAX_TEXT_CHARS
    );
    let close = fixture("shift-close-reasons.json");
    assert_eq!(
        serde_json::from_value::<Vec<String>>(close["codes"].clone()).unwrap(),
        markiro_proto::shift_close_reasons::ALL
    );
}

/// A batch of facts and its receipts. The records' `data` stays JSON in the
/// envelope (the host reads it by kind, record by record); each one reads
/// as its kind's type and writes back unchanged.
#[test]
fn fact_fixtures_round_trip_and_each_record_reads_as_its_kind() {
    let batch: FactBatch = round_trip("facts-request.json");
    let kinds: Vec<FactKind> = batch.records.iter().map(|record| record.kind).collect();
    assert_eq!(
        kinds,
        vec![
            FactKind::Scan,
            FactKind::Scan,
            FactKind::BoxClosed,
            FactKind::BoxLabel,
            FactKind::BoxException,
            FactKind::ShiftClosed
        ]
    );
    for record in &batch.records {
        let typed = match record.kind {
            FactKind::Scan => serde_json::to_value(typed::<ScanFact>(&record.data)).unwrap(),
            FactKind::BoxClosed => {
                serde_json::to_value(typed::<BoxClosedFact>(&record.data)).unwrap()
            }
            FactKind::BoxLabel => {
                serde_json::to_value(typed::<BoxLabelFact>(&record.data)).unwrap()
            }
            FactKind::BoxException => {
                serde_json::to_value(typed::<BoxExceptionFact>(&record.data)).unwrap()
            }
            FactKind::ShiftClosed => {
                serde_json::to_value(typed::<ShiftClosedFact>(&record.data)).unwrap()
            }
        };
        assert_eq!(typed, record.data, "{}", record.id);
    }
    let accepted: ScanFact = typed(&batch.records[0].data);
    let accepted_box = accepted.box_id.clone().unwrap();
    assert_eq!(
        (accepted.verdict, accepted.raw_kind),
        (ScanVerdict::Ok, ScanRawKind::Km)
    );
    assert!(accepted.code.unwrap().canonical.contains('\u{1d}'));
    let invalid: ScanFact = typed(&batch.records[1].data);
    assert_eq!(
        (invalid.verdict, invalid.code, invalid.box_id),
        (ScanVerdict::Invalid, None, None)
    );
    // The box the accepted scan went into, closed with the SSCC of the
    // first serial of `sscc-block.json`'s block.
    let closed: BoxClosedFact = typed(&batch.records[2].data);
    let block: SsccBlock = serde_json::from_value(fixture("sscc-block.json")).unwrap();
    assert_eq!(
        (&closed.box_id, &closed.block_id, closed.serial),
        (&accepted_box, &block.id, block.from_serial)
    );
    assert!(closed
        .sscc
        .starts_with(&format!("0{}", block.issuer_prefix)));
    // Its label checked, then printed again for a reason in words.
    let label: BoxLabelFact = typed(&batch.records[3].data);
    assert_eq!(
        (&label.box_id, label.outcome),
        (&accepted_box, LabelOutcome::Verified)
    );
    let reprint: BoxExceptionFact = typed(&batch.records[4].data);
    assert_eq!(
        (
            reprint.exception,
            &reprint.box_id,
            reprint.reason_code.as_deref()
        ),
        (
            ExceptionKind::Reprint,
            &accepted_box,
            Some(markiro_proto::exception_reasons::OTHER)
        )
    );
    // The shift closed with fewer units than planned, and a reason.
    let closed: ShiftClosedFact = typed(&batch.records[5].data);
    assert_eq!(
        (
            closed.planned_qty_snapshot,
            closed.actual_qty,
            closed.reason_code.as_deref()
        ),
        (Some(1200), 1188, Some("material_shortage"))
    );
    assert!(markiro_proto::shift_close_reasons::ALL.contains(&"material_shortage"));
    let receipts: FactReceipts = round_trip("facts-response.json");
    let outcomes: Vec<FactOutcome> = receipts.receipts.iter().map(|r| r.outcome).collect();
    assert_eq!(
        outcomes,
        vec![
            FactOutcome::Accepted,
            FactOutcome::Conflict,
            FactOutcome::Rejected,
            FactOutcome::Rejected,
            FactOutcome::Rejected,
            FactOutcome::Accepted
        ]
    );
    let winner: CodeOwner =
        typed(&Value::Object(receipts.receipts[1].details.clone().unwrap())["winner"]);
    assert!(!winner.same_device);
    // The close of a shift the office closed first.
    assert_eq!(
        receipts.receipts[5].details.clone().map(Value::Object),
        Some(serde_json::json!({ "alreadyClosed": true }))
    );
    for receipt in &receipts.receipts[2..5] {
        assert!(markiro_proto::receipt_codes::ALL.contains(&receipt.code.as_deref().unwrap()));
    }
    // A record names no field the host does not read, and a receipt of a
    // record without a readable id has `id: null`.
    let mut value = fixture("facts-request.json");
    value["records"][0]["deviceId"] = Value::String("anything".into());
    assert!(serde_json::from_value::<FactBatch>(value).is_err());
    assert_eq!(receipts.receipts[3].id, None);
}

/// A code is free, or taken by its owner; the owner a `conflict` receipt
/// names has the same shape.
#[test]
fn code_check_fixtures_round_trip_and_name_the_owner_as_a_conflict_does() {
    let free: CodeCheck = round_trip("code-check-free.json");
    assert_eq!(free, CodeCheck::Free);
    let taken: CodeCheck = round_trip("code-check-taken.json");
    let receipts: FactReceipts = serde_json::from_value(fixture("facts-response.json")).unwrap();
    let winner: CodeOwner =
        typed(&Value::Object(receipts.receipts[1].details.clone().unwrap())["winner"]);
    assert_eq!(taken, CodeCheck::Taken { owner: winner });
}
