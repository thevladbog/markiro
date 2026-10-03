use markiro_proto::{
    certificate_fingerprint, codes, compatibility, compatibility_for, credentials,
    display_fingerprint, BadgeCreate, BadgeSalt, BlockSizesUpdate, BootstrapRequest,
    BootstrapResponse, ChangesResponse, ClaimRequest, Compatibility, CounterpartyCreate,
    CounterpartyRecord, CounterpartyUpdate, DeviceInfo, DeviceKind, DeviceLineRequest,
    DeviceRecord, DeviceUpdate, ErrorBody, Hello, HelloEnvelope, LineCreate, LineRecord,
    LineUpdate, LocalPairRequest, OfficeLine, OfficeLoginRequest, OfficeOperator, OfficeRole,
    OfficeSession, OfficeUser, OfficeUserCreate, OfficeUserRecord, OfficeUserUpdate,
    OperatorBadgeRecord, OperatorCreate, OperatorRecord, OperatorUpdate, OrgProfile,
    OrgProfileUpdate, OrgRecord, PairResponse, PairingCode, PairingCodeRequest, PasswordChange,
    PasswordSet, ProductGroup, SiteRecord, SsccCounterUpdate, SsccState, HOST_PRODUCT,
    PROTOCOL_VERSION,
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

#[test]
fn a_product_group_fixture_round_trips() {
    let group: ProductGroup = round_trip("product-group.json");
    assert_eq!((group.code, group.alias.as_str()), (8, "milk"));
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
