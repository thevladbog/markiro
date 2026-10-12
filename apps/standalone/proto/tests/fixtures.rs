use markiro_proto::{
    category_default_id, certificate_fingerprint, codes, compatibility, compatibility_for,
    credentials, display_fingerprint, BadgeCreate, BadgeSalt, BlockSizesUpdate, BootstrapRequest,
    BootstrapResponse, BoxClosedFact, BoxExceptionFact, BoxLabelFact, BoxReportRows,
    CategoryTemplateDefault, ChangesResponse, ClaimRequest, CodeCheck, CodeOwner, Compatibility,
    CounterpartyCreate, CounterpartyRecord, CounterpartyUpdate, DeviceInfo, DeviceKind,
    DeviceLineRequest, DeviceRecord, DeviceShift, DeviceShiftCreate, DeviceShifts, DeviceUpdate,
    ErrorBody, ExceptionKind, FactBatch, FactKind, FactOutcome, FactReceipts, Hello, HelloEnvelope,
    LabelOutcome, LabelTemplate, LabelTemplateCreate, LabelTemplateRecord, LabelTemplateSummary,
    LabelTemplateUpdate, LineCreate, LineRecord, LineUpdate, LocalPairRequest, OfficeBox,
    OfficeLine, OfficeLoginRequest, OfficeOperator, OfficePallet, OfficeProduct, OfficeRole,
    OfficeSession, OfficeShift, OfficeUser, OfficeUserCreate, OfficeUserRecord, OfficeUserUpdate,
    OperatorBadgeRecord, OperatorCreate, OperatorRecord, OperatorUpdate, OrgLogoPut, OrgLogoState,
    OrgProfile, OrgProfileUpdate, OrgRecord, PairResponse, PairingCode, PairingCodeRequest,
    PalletClosedFact, PalletExceptionFact, PalletExceptionKind, PalletLabelFact, PalletReportRows,
    PalletSheet, PalletSheetCreate, PalletSheetDefaultUpdate, PalletSheetUpdate, PalletSheets,
    PasswordChange, PasswordSet, ProductCreate, ProductGroup, ProductRecord, ProductStatus,
    ProductUpdate, ScanFact, ScanRawKind, ScanVerdict, ShiftClose, ShiftClosedFact, ShiftCreate,
    ShiftExportRecord, ShiftExportRows, ShiftMode, ShiftOrigin, ShiftStatus, ShiftUpdate,
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
    assert_eq!(hello.protocol, 4);
    assert!(hello.initialized);
}

#[test]
fn envelope_decides_compatibility_before_the_rest() {
    let future: HelloEnvelope = serde_json::from_value(fixture("hello-future.json")).unwrap();
    assert_eq!(compatibility_for(2, &future), Compatibility::AppTooOld);
    assert_eq!(compatibility_for(3, &future), Compatibility::Compatible);
    assert_eq!(compatibility_for(5, &future), Compatibility::HostTooOld);
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

/// The organization's print logo (plan А4): the answer and the `PUT` body.
#[test]
fn org_logo_fixtures_round_trip() {
    let state: OrgLogoState = round_trip("org-logo.json");
    let logo = state.logo.expect("the fixture has a logo");
    assert_eq!((logo.width, logo.height), (10, 2));
    let put: OrgLogoPut = round_trip("org-logo-put.json");
    assert_eq!(put.pixels_base64, logo.pixels_base64);
    let none: OrgLogoState = serde_json::from_value(serde_json::json!({ "logo": null })).unwrap();
    assert_eq!(none.logo, None);
    // The body is strict: a field the host does not know is a refusal, so a
    // client cannot smuggle an `updatedAt` of its own or a second picture.
    let extra = serde_json::json!({ "width": 10, "height": 2, "pixelsBase64": "8MAPQA==", "updatedAt": "x" });
    assert!(serde_json::from_value::<OrgLogoPut>(extra).is_err());
}

/// The A4 pallet sheets (plan А4): the list, a sheet and the three requests.
#[test]
fn pallet_sheet_fixtures_round_trip() {
    let list: PalletSheets = round_trip("pallet-sheets.json");
    let sheet: PalletSheet = round_trip("pallet-sheet.json");
    assert_eq!(list.sheets, vec![sheet.clone()]);
    assert_eq!(list.default_id.as_deref(), Some(sheet.id.as_str()));
    let create: PalletSheetCreate = round_trip("pallet-sheet-create.json");
    assert_eq!(create.preset_key.as_deref(), Some("pallet-a4-portrait"));
    let bare: PalletSheetCreate = serde_json::from_value(serde_json::json!({
        "name": "Свой лист", "spec": {}
    }))
    .unwrap();
    assert!(bare.enabled && bare.preset_key.is_none());
    let update: PalletSheetUpdate = round_trip("pallet-sheet-update.json");
    assert_eq!(update.expected_revision, 1);
    let default: PalletSheetDefaultUpdate = round_trip("pallet-sheet-default-update.json");
    assert_eq!(default.template_id.as_deref(), Some(sheet.id.as_str()));
    // The requests are strict, like the host's, so a client cannot smuggle a
    // layout into a rename or an id into a create.
    for extra in [
        serde_json::json!({ "name": "x", "spec": {}, "id": "x" }),
        serde_json::json!({ "name": "x", "spec": {}, "revision": 1 }),
    ] {
        assert!(serde_json::from_value::<PalletSheetCreate>(extra).is_err());
    }
    let layout = serde_json::json!({ "expectedRevision": 1, "spec": {} });
    assert!(serde_json::from_value::<PalletSheetUpdate>(layout).is_err());
    let extra = serde_json::json!({ "templateId": null, "enabled": true });
    assert!(serde_json::from_value::<PalletSheetDefaultUpdate>(extra).is_err());
    // `null` clears the default; a body without the field does not.
    let none: PalletSheetDefaultUpdate =
        serde_json::from_value(serde_json::json!({ "templateId": null })).unwrap();
    assert_eq!(none.template_id, None);
    assert!(serde_json::from_value::<PalletSheetDefaultUpdate>(serde_json::json!({})).is_err());
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
    // The owner entered it, so it is among the shift's devices.
    assert_eq!(
        shift.totals.device_ids,
        vec![shift.owner_device_id.clone().unwrap()]
    );
    // The card's two unit numbers are the cloud office's: the units the
    // facts accepted, and those of them in closed boxes (a full closed box
    // each here; the open box holds the rest).
    let totals = &fixture("office-shift.json")["totals"];
    assert_eq!(totals["acceptedUnits"], 547);
    assert_eq!(totals["unitsInClosedBoxes"], 540);
    assert_eq!(
        totals["unitsInClosedBoxes"].as_u64().unwrap(),
        totals["closedBoxes"].as_u64().unwrap() * u64::from(shift.box_capacity)
    );
    // A shift without facts still carries every field, the instant as `null`.
    let empty = serde_json::json!({
        "acceptedUnits": 0, "unitsInClosedBoxes": 0, "closedBoxes": 0, "openBoxes": 0,
        "lastFactAt": null, "deviceIds": [], "closedPallets": 0, "openPallets": 0
    });
    let read: markiro_proto::ShiftTotals = serde_json::from_value(empty.clone()).unwrap();
    assert_eq!(serde_json::to_value(&read).unwrap(), empty);
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
    // Without pallets the pallet fields are left out, and stay out.
    assert_eq!(
        (shift.pallet_box_capacity, shift.pallet_template_id.clone()),
        (None, None)
    );
    assert_eq!(
        (bare.pallet_box_capacity, bare.pallet_template_id.clone()),
        (None, None)
    );
    let pallets: ShiftCreate = round_trip("shift-create-pallets.json");
    assert_eq!(
        (
            pallets.pallets_enabled,
            pallets.pallet_box_capacity,
            pallets.pallet_template_id.as_deref()
        ),
        (true, Some(40), Some("c4d5e6f7-a8b9-4c0d-9e1f-2a3b4c5d6e7f"))
    );
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
    // Pallet fields go out only when sent.
    let pallets = serde_json::json!({
        "palletsEnabled": true, "palletBoxCapacity": 30,
        "palletTemplateId": "c4d5e6f7-a8b9-4c0d-9e1f-2a3b4c5d6e7f", "expectedRev": 71
    });
    let typed: ShiftUpdate = serde_json::from_value(pallets.clone()).unwrap();
    assert_eq!(serde_json::to_value(&typed).unwrap(), pallets);
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
    let too_large: ErrorBody = round_trip("error-snapshot-too-large.json");
    assert_eq!(
        (
            too_large.error.code.as_str(),
            too_large.error.details.expect("details")["constraint"].as_str()
        ),
        (codes::CONFLICT, Some("snapshot_too_large"))
    );
}

/// A station's shift with pallets names their capacity and template, and its
/// entry freezes the pallet template; a shift without pallets names none of
/// them, and a station of stage 2a sends no pallet field.
#[test]
fn a_shift_with_pallets_names_them_and_its_entry_freezes_the_pallet_template() {
    let entered: DeviceShift = round_trip("device-shift-entered-pallets.json");
    let snapshot = entered
        .snapshot
        .clone()
        .expect("an entry carries the snapshot");
    let pallet = snapshot
        .pallet_template
        .expect("a shift with pallets freezes its pallet template");
    assert_eq!(
        (
            entered.pallets_enabled,
            entered.pallet_box_capacity,
            entered.pallet_template_id.as_deref()
        ),
        (true, Some(40), Some(pallet.id.as_str()))
    );
    let plain: DeviceShift = serde_json::from_value(fixture("device-shift-entered.json")).unwrap();
    assert_eq!(
        (
            plain.pallet_box_capacity,
            plain.pallet_template_id,
            plain.snapshot.expect("snapshot").pallet_template
        ),
        (None, None, None)
    );
    let create: DeviceShiftCreate = round_trip("device-shift-create-pallets.json");
    assert_eq!(
        (
            create.pallets_enabled,
            create.pallet_box_capacity,
            create.pallet_template_id.as_deref()
        ),
        (true, Some(40), Some(pallet.id.as_str()))
    );
    let bare: DeviceShiftCreate = round_trip("device-shift-create.json");
    assert_eq!(
        (
            bare.pallets_enabled,
            bare.pallet_box_capacity,
            bare.pallet_template_id
        ),
        (false, None, None)
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

/// The receipt codes and the reason codes, as the webview will read them
/// from the same fixtures (plans 2a6 and 2a8): a code added on one side only
/// fails here.
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

/// The pallet facts of a shift with pallets (plan ПЛ-Х), in their own
/// fixture so a station of stage 2a reads `facts-request.json` as before: a
/// box closed on the station's pallet, the pallet's close with the SSCC of
/// the first serial of a pallet block, its label checked, then the pallet
/// taken apart for a reason in words.
#[test]
fn pallet_fact_fixtures_round_trip_and_each_record_reads_as_its_kind() {
    let batch: FactBatch = round_trip("facts-request-pallets.json");
    let kinds: Vec<FactKind> = batch.records.iter().map(|record| record.kind).collect();
    assert_eq!(
        kinds,
        vec![
            FactKind::BoxClosed,
            FactKind::PalletClosed,
            FactKind::PalletLabel,
            FactKind::PalletException
        ]
    );
    let boxed: BoxClosedFact = typed(&batch.records[0].data);
    assert_eq!(serde_json::to_value(&boxed).unwrap(), batch.records[0].data);
    let closed: PalletClosedFact = typed(&batch.records[1].data);
    assert_eq!(
        serde_json::to_value(&closed).unwrap(),
        batch.records[1].data
    );
    assert_eq!(boxed.pallet_id.as_deref(), Some(closed.pallet_id.as_str()));
    assert_eq!(closed.opened_at, boxed.closed_at);
    assert!(closed.sscc.starts_with("1460068200"));
    // A box of a shift without pallets names none, and writes none back.
    let plain: FactBatch = serde_json::from_value(fixture("facts-request.json")).unwrap();
    let plain_box: BoxClosedFact = typed(&plain.records[2].data);
    assert_eq!(plain_box.pallet_id, None);
    assert!(serde_json::to_value(&plain_box)
        .unwrap()
        .get("palletId")
        .is_none());
    // The pallet's close is read strictly, as every request.
    let mut extra = batch.records[1].data.clone();
    extra["boxes"] = serde_json::json!([]);
    assert!(serde_json::from_value::<PalletClosedFact>(extra).is_err());
    let checked: PalletLabelFact = typed(&batch.records[2].data);
    assert_eq!(
        (&checked.pallet_id, checked.outcome),
        (&closed.pallet_id, LabelOutcome::Verified)
    );
    let apart: PalletExceptionFact = typed(&batch.records[3].data);
    assert_eq!(
        (
            apart.exception,
            &apart.pallet_id,
            apart.reason_code.as_str(),
            apart.exception.as_str()
        ),
        (
            PalletExceptionKind::Disassemble,
            &closed.pallet_id,
            markiro_proto::exception_reasons::OTHER,
            "disassemble"
        )
    );
    // A pallet exception always names a reason; `undo` and `clear` are a
    // box's.
    let mut without = batch.records[3].data.clone();
    without.as_object_mut().unwrap().remove("reasonCode");
    assert!(serde_json::from_value::<PalletExceptionFact>(without).is_err());
    let mut undo = batch.records[3].data.clone();
    undo["exception"] = serde_json::json!("undo");
    assert!(serde_json::from_value::<PalletExceptionFact>(undo).is_err());
}

/// A pallet check and a pallet exception have exactly their own fields; the
/// exception's two kinds and the check's two outcomes read by their names,
/// and the two kinds of fact go by theirs.
#[test]
fn a_pallet_check_and_a_pallet_exception_have_exactly_their_fields() {
    let batch: FactBatch = round_trip("facts-request-pallets.json");
    let check = batch.records[2].data.clone();
    let apart = batch.records[3].data.clone();
    let mut extra_check = check.clone();
    extra_check["boxCount"] = serde_json::json!(1);
    assert!(serde_json::from_value::<PalletLabelFact>(extra_check).is_err());
    let mut extra_exception = apart.clone();
    extra_exception["boxId"] = serde_json::json!("x");
    assert!(serde_json::from_value::<PalletExceptionFact>(extra_exception).is_err());
    let mut skipped = check.clone();
    skipped["outcome"] = serde_json::json!("skipped");
    let skipped: PalletLabelFact = typed(&skipped);
    assert_eq!(skipped.outcome, LabelOutcome::Skipped);
    let mut seen = check;
    seen["outcome"] = serde_json::json!("seen");
    assert!(serde_json::from_value::<PalletLabelFact>(seen).is_err());
    let mut reprint = apart.clone();
    reprint["exception"] = serde_json::json!("reprint");
    let reprint: PalletExceptionFact = typed(&reprint);
    assert_eq!(
        (reprint.exception, reprint.exception.as_str()),
        (PalletExceptionKind::Reprint, "reprint")
    );
    let mut wordless = apart;
    wordless["reasonText"] = Value::Null;
    let wordless: PalletExceptionFact = typed(&wordless);
    assert_eq!(wordless.reason_text, None);
    for (kind, name) in [
        (FactKind::PalletLabel, "pallet_label"),
        (FactKind::PalletException, "pallet_exception"),
    ] {
        assert_eq!(kind.as_str(), name);
        assert_eq!(serde_json::to_value(kind).unwrap(), serde_json::json!(name));
        assert_eq!(name.parse::<FactKind>().unwrap(), kind);
    }
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
            FactKind::PalletClosed => {
                serde_json::to_value(typed::<PalletClosedFact>(&record.data)).unwrap()
            }
            FactKind::PalletLabel => {
                serde_json::to_value(typed::<PalletLabelFact>(&record.data)).unwrap()
            }
            FactKind::PalletException => {
                serde_json::to_value(typed::<PalletExceptionFact>(&record.data)).unwrap()
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

/// The export source of a shift (plan ЧЗ) round-trips, and its rows hang
/// together as the host writes them: every live item names a box and a code
/// of the source, a box names a pallet of the source, a closed box has its
/// SSCC and an open one none, the station's close keeps its milliseconds
/// beside the host's whole seconds, and a canonical code keeps its group
/// separator and crypto tail.
#[test]
fn shift_export_rows_round_trip_and_hang_together() {
    let rows: ShiftExportRows = round_trip("shift-export-rows.json");
    assert_eq!(rows.shift.status, ShiftStatus::Closed);
    for item in &rows.items {
        assert!(rows.boxes.iter().any(|b| b.id == item.box_id), "{item:?}");
        assert!(
            rows.codes.iter().any(|c| c.code_hash == item.code_hash),
            "{item:?}"
        );
    }
    for b in &rows.boxes {
        if let Some(pallet) = &b.pallet_id {
            assert!(rows.pallets.iter().any(|p| &p.id == pallet), "{b:?}");
        }
        assert_eq!(b.closed_at.is_some(), b.sscc.is_some(), "{b:?}");
    }
    assert_eq!(
        rows.shift.closed_at.as_deref(),
        Some("2026-10-08T14:00:07Z")
    );
    assert_eq!(
        rows.shift.station_closed_at.as_deref(),
        Some("2026-10-08T14:00:07.412Z")
    );
    assert!(rows.codes.iter().all(|c| c.canonical.contains('\u{1d}')));
}

/// The office's lists of a shift's boxes and pallets (plan ЧЗ) round-trip
/// and agree with the export source of the same shift: the same boxes and
/// pallets, a box's live units are its live items there, and a pallet's
/// boxes and units are those of its closed boxes not taken apart.
#[test]
fn office_box_and_pallet_lists_round_trip_and_agree_with_the_export_source() {
    let boxes: Vec<OfficeBox> = round_trip("office-boxes.json");
    let pallets: Vec<OfficePallet> = round_trip("office-pallets.json");
    let rows: ShiftExportRows = serde_json::from_value(fixture("shift-export-rows.json")).unwrap();
    assert_eq!(
        boxes.iter().map(|b| &b.id).collect::<Vec<_>>(),
        rows.boxes.iter().map(|b| &b.id).collect::<Vec<_>>()
    );
    for b in &boxes {
        let live = rows.items.iter().filter(|i| i.box_id == b.id).count();
        assert_eq!(usize::try_from(b.units).unwrap(), live, "{b:?}");
    }
    for p in &pallets {
        let on: Vec<&OfficeBox> = boxes
            .iter()
            .filter(|b| b.pallet_id.as_deref() == Some(&p.id) && b.disassembled_at.is_none())
            .collect();
        assert_eq!(usize::try_from(p.boxes).unwrap(), on.len(), "{p:?}");
        assert_eq!(
            p.units,
            on.iter().map(|b| u64::from(b.units)).sum::<u64>(),
            "{p:?}"
        );
    }
}

/// The record of an export (plan ЧЗ) round-trips and names a format of
/// `export-formats.json` with the counts of the rows of the same shift: the
/// pallets format over `shift-export-rows.json` writes its three codes, its
/// two closed boxes and its one pallet. A field the host does not read is
/// refused.
#[test]
fn shift_export_record_round_trips_and_counts_the_rows_of_its_shift() {
    let record: ShiftExportRecord = round_trip("shift-export-record.json");
    let formats = fixture("export-formats.json");
    assert!(formats["shift"]
        .as_array()
        .unwrap()
        .iter()
        .any(|f| f["id"] == record.format_id.as_str() && f["version"] == record.format_version));
    let rows: ShiftExportRows = serde_json::from_value(fixture("shift-export-rows.json")).unwrap();
    assert_eq!(record.code_count, u64::try_from(rows.items.len()).unwrap());
    assert_eq!(
        record.box_count,
        u32::try_from(rows.boxes.iter().filter(|b| b.sscc.is_some()).count()).unwrap()
    );
    assert_eq!(
        record.pallet_count,
        u32::try_from(rows.pallets.len()).unwrap()
    );
    let mut value = fixture("shift-export-record.json");
    value["folder"] = Value::String("C:\\Users".into());
    assert!(serde_json::from_value::<ShiftExportRecord>(value).is_err());
}

/// «Состав короба»'s data (plan О-Ф) round-trips and agrees with the export
/// source of the same shift: a box not taken apart prints exactly its live
/// codes there, ordered by GTIN and then serial, and each code's GTIN and
/// serial are the ones its canonical text carries.
#[test]
fn box_report_rows_round_trip_and_agree_with_the_export_source() {
    let report: BoxReportRows = round_trip("box-report-rows.json");
    let rows: ShiftExportRows = serde_json::from_value(fixture("shift-export-rows.json")).unwrap();
    assert_eq!(report.shift_id, rows.shift.id);
    assert_eq!(report.product_name, rows.shift.product_name);
    assert_eq!(report.organization, rows.organization);
    let source = rows.boxes.iter().find(|b| b.id == report.id).unwrap();
    assert_eq!(
        (
            &report.sscc,
            &report.opened_at,
            &report.closed_at,
            &report.disassembled_at
        ),
        (
            &source.sscc,
            &source.opened_at,
            &source.closed_at,
            &source.disassembled_at
        )
    );
    let mut live: Vec<&str> = rows
        .items
        .iter()
        .filter(|i| i.box_id == report.id)
        .map(|i| {
            rows.codes
                .iter()
                .find(|c| c.code_hash == i.code_hash)
                .unwrap()
                .canonical
                .as_str()
        })
        .collect();
    live.sort_unstable();
    let printed: Vec<&str> = report.items.iter().map(|i| i.canonical.as_str()).collect();
    assert_eq!(printed, live);
    let mut ordered = report.items.clone();
    ordered.sort_by(|a, b| (&a.gtin14, &a.serial).cmp(&(&b.gtin14, &b.serial)));
    assert_eq!(ordered, report.items);
    for item in &report.items {
        assert!(
            item.canonical
                .starts_with(&format!("01{}21{}\u{1d}", item.gtin14, item.serial)),
            "{item:?}"
        );
    }
}

/// The pallets' forms data (plan О-Ф) round-trips and agrees with the
/// office's lists and the export source of the same shift: the same pallets
/// opened first first, each box the export source puts on the pallet, closed
/// first first, with the live units the box list counts, and a pallet's
/// boxes and units not taken apart are the list's.
#[test]
fn pallet_report_rows_round_trip_and_agree_with_the_lists() {
    let report: PalletReportRows = round_trip("pallet-report-rows.json");
    let rows: ShiftExportRows = serde_json::from_value(fixture("shift-export-rows.json")).unwrap();
    let boxes: Vec<OfficeBox> = serde_json::from_value(fixture("office-boxes.json")).unwrap();
    let pallets: Vec<OfficePallet> =
        serde_json::from_value(fixture("office-pallets.json")).unwrap();
    assert_eq!(report.shift.id, rows.shift.id);
    assert_eq!(report.shift.number, rows.shift.number);
    assert_eq!(report.shift.production_date, rows.shift.production_date);
    assert_eq!(report.shift.product_name, rows.shift.product_name);
    assert_eq!(report.organization, rows.organization);
    assert_eq!(
        report.pallets.iter().map(|p| &p.id).collect::<Vec<_>>(),
        pallets.iter().map(|p| &p.id).collect::<Vec<_>>()
    );
    for (pallet, listed) in report.pallets.iter().zip(&pallets) {
        assert_eq!(
            (&pallet.sscc, &pallet.closed_at, &pallet.disassembled_at),
            (&listed.sscc, &listed.closed_at, &listed.disassembled_at)
        );
        let mut on: Vec<&OfficeBox> = boxes
            .iter()
            .filter(|b| b.pallet_id.as_deref() == Some(&pallet.id))
            .collect();
        on.sort_by(|a, b| (&a.closed_at, &a.id).cmp(&(&b.closed_at, &b.id)));
        assert_eq!(
            pallet.boxes.iter().map(|b| &b.id).collect::<Vec<_>>(),
            on.iter().map(|b| &b.id).collect::<Vec<_>>()
        );
        for (printed, listed_box) in pallet.boxes.iter().zip(&on) {
            assert_eq!(printed.units, listed_box.units, "{printed:?}");
            assert_eq!(Some(&printed.closed_at), listed_box.closed_at.as_ref());
        }
        let standing: Vec<_> = pallet
            .boxes
            .iter()
            .filter(|b| b.disassembled_at.is_none())
            .collect();
        assert_eq!(usize::try_from(listed.boxes).unwrap(), standing.len());
        assert_eq!(
            listed.units,
            standing.iter().map(|b| u64::from(b.units)).sum::<u64>()
        );
    }
}

/// A shift's totals carry both pallet counts (plan ПЛ-Х): each is required,
/// a whole non-negative number, and keeps its own name and place.
#[test]
fn a_shifts_totals_carry_both_pallet_counts_as_required_whole_numbers() {
    let totals = fixture("office-shift.json")["totals"].clone();
    let mut counted = totals.clone();
    counted["closedPallets"] = serde_json::json!(12);
    counted["openPallets"] = serde_json::json!(1);
    let read: markiro_proto::ShiftTotals = serde_json::from_value(counted.clone()).unwrap();
    assert_eq!((read.closed_pallets, read.open_pallets), (12, 1));
    assert_eq!(serde_json::to_value(&read).unwrap(), counted);
    for field in ["closedPallets", "openPallets"] {
        let mut without = totals.clone();
        without.as_object_mut().unwrap().remove(field);
        assert!(
            serde_json::from_value::<markiro_proto::ShiftTotals>(without).is_err(),
            "{field} left out"
        );
        for value in [
            serde_json::json!(-1),
            serde_json::json!(1.5),
            serde_json::json!("1"),
            serde_json::Value::Null,
        ] {
            let mut bad = totals.clone();
            bad[field] = value.clone();
            assert!(
                serde_json::from_value::<markiro_proto::ShiftTotals>(bad).is_err(),
                "{field}: {value}"
            );
        }
    }
}

/// A shift with an A4 sheet (plan А4): the office's request names it, and the
/// entry freezes the sheet with the organization.
#[test]
fn a_shift_with_a_sheet_freezes_it_with_the_organization() {
    let create: ShiftCreate = round_trip("shift-create-pallet-sheet.json");
    assert!(create.pallets_enabled && create.pallet_sheet_template_id.is_some());
    let entered: DeviceShift = round_trip("device-shift-entered-sheet.json");
    let snapshot = entered.snapshot.expect("an entry carries the snapshot");
    let sheet = snapshot.pallet_sheet.expect("the shift froze its sheet");
    assert_eq!(Some(sheet.id), create.pallet_sheet_template_id);
    let organization = snapshot
        .organization
        .expect("the shift froze the organization");
    assert_eq!(organization.logo.map(|logo| logo.width), Some(10));
    let plain: DeviceShift =
        serde_json::from_value(fixture("device-shift-entered-pallets.json")).unwrap();
    let plain = plain.snapshot.expect("snapshot");
    assert_eq!((plain.pallet_sheet, plain.organization), (None, None));
}

/// The sheet is optional in every request that carries it and is sent only
/// when set; a shift of the office always answers it (`null` for none).
#[test]
fn the_sheet_is_left_out_of_a_request_that_names_none() {
    let plain: ShiftCreate = round_trip("shift-create-pallets.json");
    assert_eq!(plain.pallet_sheet_template_id, None);
    let office: OfficeShift = round_trip("office-shift.json");
    assert_eq!(office.pallet_sheet_template_id, None);
    let named = serde_json::json!({ "palletSheetTemplateId": "6a3f0c5e-1b2d-4e8f-9a7b-0c1d2e3f4a5b", "expectedRev": 3 });
    let update: ShiftUpdate = serde_json::from_value(named.clone()).unwrap();
    assert_eq!(serde_json::to_value(&update).unwrap(), named);
    let none: ShiftUpdate =
        serde_json::from_value(serde_json::json!({ "expectedRev": 3 })).unwrap();
    assert_eq!(
        serde_json::to_value(&none).unwrap(),
        serde_json::json!({ "expectedRev": 3 })
    );
    let station: DeviceShiftCreate = serde_json::from_value(serde_json::json!({
        "requestId": "6a3f0c5e-1b2d-4e8f-9a7b-0c1d2e3f4a5c",
        "productId": "f1e2d3c4-b5a6-4978-8a6b-5c4d3e2f1a0b",
        "boxTemplateId": "a3b4c5d6-e7f8-4a9b-8c0d-1e2f3a4b5c6d",
        "productionDate": "2026-10-08",
        "palletSheetTemplateId": "6a3f0c5e-1b2d-4e8f-9a7b-0c1d2e3f4a5b"
    }))
    .unwrap();
    assert!(station.pallet_sheet_template_id.is_some());
    assert!(serde_json::to_value(&station).unwrap()["palletSheetTemplateId"].is_string());
}

/// A planned shift goes back to the organization's main sheet with
/// `palletSheetTemplateId: null`, which is neither leaving it out (keep) nor
/// an id, and goes back out as `null` (`shift-update-main-sheet.json`).
#[test]
fn a_shift_update_sends_the_main_sheet_as_null() {
    let main: ShiftUpdate = round_trip("shift-update-main-sheet.json");
    assert_eq!(main.pallet_sheet_template_id, Some(None));
    let named: ShiftUpdate = serde_json::from_value(serde_json::json!({
        "palletSheetTemplateId": "6a3f0c5e-1b2d-4e8f-9a7b-0c1d2e3f4a5b", "expectedRev": 72
    }))
    .unwrap();
    assert_eq!(
        named.pallet_sheet_template_id,
        Some(Some("6a3f0c5e-1b2d-4e8f-9a7b-0c1d2e3f4a5b".to_owned()))
    );
    let kept: ShiftUpdate =
        serde_json::from_value(serde_json::json!({ "expectedRev": 72 })).unwrap();
    assert_eq!(kept.pallet_sheet_template_id, None);
    assert!(serde_json::from_value::<ShiftUpdate>(
        serde_json::json!({ "palletSheetTemplateId": 7, "expectedRev": 72 })
    )
    .is_err());
}
