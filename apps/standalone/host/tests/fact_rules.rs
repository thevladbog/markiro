use markiro_host::facts::rules::{
    box_membership_digest, close_reason_required, device_instant, is_code_hash, record_digest,
};
use serde_json::{json, Value};

/// A fixture of `proto/fixtures`, which the webview's
/// `test/fact-rules.test.ts` reads too.
fn fixture(name: &str) -> Value {
    let path = format!("{}/../proto/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    let text =
        std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("read {path}: {error}"));
    serde_json::from_str(&text).unwrap()
}

#[test]
fn every_box_digest_of_the_fixture_matches() {
    let fixture = fixture("box-digest.json");
    let cases = fixture["cases"].as_array().expect("cases");
    assert_eq!(cases.len(), 5);
    for case in cases {
        let hashes: Vec<String> = serde_json::from_value(case["hashes"].clone()).unwrap();
        assert_eq!(
            box_membership_digest(&hashes),
            case["digest"].as_str().unwrap(),
            "{case}"
        );
    }
}

#[test]
fn a_device_instant_is_exactly_what_to_iso_string_writes() {
    let fixture = fixture("device-instants.json");
    let valid = fixture["valid"].as_array().expect("valid");
    let invalid = fixture["invalid"].as_array().expect("invalid");
    assert_eq!((valid.len(), invalid.len()), (5, 17));
    for text in valid {
        let text = text.as_str().unwrap();
        assert!(device_instant(text).is_some(), "{text:?}");
    }
    for text in invalid {
        let text = text.as_str().unwrap();
        assert_eq!(device_instant(text), None, "{text:?}");
    }
    // The instant itself, milliseconds included.
    let at = device_instant("2026-10-08T06:02:00.123Z").unwrap();
    assert_eq!(
        (at.unix_timestamp(), at.millisecond()),
        (1_791_439_320, 123)
    );
}

#[test]
fn every_close_reason_case_of_the_fixture_matches() {
    let fixture = fixture("shift-close-reasons.json");
    let cases = fixture["required"].as_array().expect("required");
    assert_eq!(cases.len(), 6);
    for case in cases {
        let planned: Option<u32> = serde_json::from_value(case["plannedQty"].clone()).unwrap();
        let actual: u32 = serde_json::from_value(case["actualQty"].clone()).unwrap();
        assert_eq!(
            close_reason_required(planned, actual),
            case["required"].as_bool().unwrap(),
            "{case}"
        );
    }
}

/// The digest of a record does not depend on the order of its keys: the
/// same record sent again by another serializer keeps its receipt.
#[test]
fn a_record_digest_ignores_the_order_of_keys_and_sees_every_value() {
    let record: Value = serde_json::from_str(
        r#"{"id":"0d1c2b3a-4f5e-4a6b-8c7d-9e0f1a2b3c4d","kind":"scan","data":{"b":1,"a":[2,3]}}"#,
    )
    .unwrap();
    let reordered: Value = serde_json::from_str(
        r#"{"data":{"a":[2,3],"b":1},"kind":"scan","id":"0d1c2b3a-4f5e-4a6b-8c7d-9e0f1a2b3c4d"}"#,
    )
    .unwrap();
    assert_eq!(record_digest(&record), record_digest(&reordered));
    assert_eq!(record_digest(&record).len(), 64);
    let mut changed = record.clone();
    changed["data"]["a"] = json!([3, 2]);
    assert_ne!(record_digest(&record), record_digest(&changed));
    // SHA-256 of the compact text with the keys in byte order.
    assert_eq!(
        record_digest(&json!({ "b": 1, "a": "x" })),
        "cdab067e9f3beb32d1252cfd63e492592fecbf591b0d08cadb24bb17f3864246"
    );
}

#[test]
fn a_code_hash_is_64_lower_case_hex_digits() {
    assert!(is_code_hash(&"0a".repeat(32)));
    assert!(is_code_hash(&"9f".repeat(32)));
    for text in [
        "0A".repeat(32),
        "0a".repeat(31),
        format!("{}0", "0a".repeat(32)),
        format!("{}g", "0".repeat(63)),
        format!("{}é", "0".repeat(62)),
        String::new(),
    ] {
        assert!(!is_code_hash(&text), "{text:?}");
    }
}

// Cases the shared fixtures do not hold. The reference values were computed
// outside Rust (Python's `hashlib`, `datetime` and `json` with sorted keys and
// compact separators), and `test/fact-rules.test.ts` asserts the same box
// digests against the domain.

#[test]
fn a_device_instant_names_its_exact_instant_over_the_whole_year_range() {
    for (text, seconds, millis) in [
        ("1970-01-01T00:00:00.000Z", 0, 0),
        ("0000-01-01T00:00:00.000Z", -62_167_219_200, 0),
        ("0001-01-01T00:00:00.000Z", -62_135_596_800, 0),
        ("2024-02-29T12:00:00.001Z", 1_709_208_000, 1),
        ("2028-02-29T23:59:59.999Z", 1_835_481_599, 999),
        ("9999-12-31T23:59:59.999Z", 253_402_300_799, 999),
    ] {
        let at = device_instant(text).unwrap_or_else(|| panic!("{text:?}"));
        assert_eq!((at.unix_timestamp(), at.millisecond()), (seconds, millis));
    }
}

/// The stored text orders the instants: for instants of this form the
/// order of the texts is the order of the moments, and the digits of every
/// field keep their width.
#[test]
fn comparing_the_texts_of_instants_orders_the_instants() {
    let texts = [
        "0000-01-01T00:00:00.000Z",
        "0001-01-01T00:00:00.000Z",
        "0999-12-31T23:59:59.999Z",
        "1970-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
        "2026-10-08T00:00:00.000Z",
        "2026-10-08T00:00:00.001Z",
        "2026-10-08T00:00:00.010Z",
        "2026-10-08T00:00:00.100Z",
        "2026-10-08T00:00:01.000Z",
        "2026-10-08T00:01:00.000Z",
        "2026-10-08T01:00:00.000Z",
        "2026-10-09T00:00:00.000Z",
        "2026-11-01T00:00:00.000Z",
        "2026-12-31T23:59:59.999Z",
        "9999-12-31T23:59:59.999Z",
    ];
    let mut previous = None;
    for text in texts {
        let at = device_instant(text).unwrap_or_else(|| panic!("{text:?}"));
        if let Some((before_text, before_at)) = previous {
            assert!(before_text < text, "{before_text} < {text}");
            assert!(before_at < at, "{before_text} < {text}");
        }
        previous = Some((text, at));
    }
}

/// Spellings the fixture lacks: a real leap second, longer fractions, other
/// separators and digits, an impossible calendar day, a stray character.
#[test]
fn a_device_instant_refuses_every_other_spelling() {
    for text in [
        "2016-12-31T23:59:60.000Z",
        "2016-12-31T23:59:60Z",
        "2026-10-08T06:02:00.123456Z",
        "2026-10-08T06:02:00.123456789Z",
        "2026-10-08T06:02:00.123z",
        "2026-10-08t06:02:00.123Z",
        "2026-10-08T06:02:00.123+00:00",
        "2026-10-08T06:02:00.123-00:00",
        "2026-10-08T06:02:00.123 Z",
        "2026-10-08T06:02:00,123Z",
        "2026-10-08T06:02Z",
        "20261008T060200.123Z",
        "2026-10-08T6:02:00.123Z",
        "2026-1-08T06:02:00.123Z",
        "-000001-10-08T06:02:00.123Z",
        "+010000-10-08T06:02:00.123Z",
        "２０２６-10-08T06:02:00.123Z",
        "2026-10-08T06:02:00.١٢٣Z",
        "2026-10-08T06:02:00.123Z\n",
        "2026-10-08T06:02:00.123Z\0",
        "2026-02-29T06:02:00.123Z",
        "2100-02-29T06:02:00.123Z",
        "1900-02-29T06:02:00.123Z",
        "2026-04-31T06:02:00.123Z",
        "2026-00-10T06:02:00.123Z",
        "2026-10-00T06:02:00.123Z",
        "2026-10-08T06:02:60.123Z",
    ] {
        assert_eq!(device_instant(text), None, "{text:?}");
    }
    // The real days next to them are fine.
    for text in [
        "2024-02-29T06:02:00.123Z",
        "2000-02-29T06:02:00.123Z",
        "2026-04-30T06:02:00.123Z",
        "2026-10-08T23:59:59.999Z",
    ] {
        assert!(device_instant(text).is_some(), "{text:?}");
    }
}

/// Digests computed outside Rust: the empty list and the single member
/// (nothing after the prefix line, no trailing line feed), the order of the
/// input, digits before letters, duplicates kept (the host checks that the
/// members are distinct before it digests them).
#[test]
fn a_box_digest_matches_values_computed_outside_rust() {
    let hash = |pair: &str| pair.repeat(32);
    let zeros = |lead: &str| format!("{lead}{}", "0".repeat(63));
    assert_eq!(
        box_membership_digest(&[hash("a1"), hash("a1")]),
        "087cf136d03b517da872722ab2bff14376a71031d1ee2d94ef1af2d0b97a2535"
    );
    assert_ne!(
        box_membership_digest(&[hash("a1"), hash("a1")]),
        box_membership_digest(&[hash("a1")])
    );
    for members in [vec![hash("0f"), hash("a1")], vec![hash("a1"), hash("0f")]] {
        assert_eq!(
            box_membership_digest(&members),
            "1d1624cccee200f0b1330457d822e12ec006e3d7fccff4567df9e6e812251d5d"
        );
    }
    for members in [
        vec![zeros("9"), zeros("a"), zeros("0")],
        vec![zeros("a"), zeros("0"), zeros("9")],
    ] {
        assert_eq!(
            box_membership_digest(&members),
            "30785ba5ff8995a049fedd3d6a47c68f2abc3aa8f8df94f09e30ccb7c2cc9da9"
        );
    }
    // Order is by bytes, so an upper-case letter sorts before a lower-case
    // one (the host never digests one, the rule still is the domain's).
    assert_eq!(
        box_membership_digest(&["a".repeat(64), "B".repeat(64)]),
        "8a811d28e1e1c61a7ce2dded64588b1593df08549255813a3e7f30afc88de419"
    );
}

/// Digests computed outside Rust over the compact JSON with the keys in
/// byte order: nesting, arrays kept in order, `null`, booleans, negative and
/// 64-bit integers, characters the writer escapes and those it leaves, and
/// keys outside ASCII.
#[test]
fn a_record_digest_matches_values_computed_outside_rust() {
    assert_eq!(
        record_digest(&json!({})),
        "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"
    );
    assert_eq!(
        record_digest(&json!([3, 1, 2])),
        "51bda7ab4e44726cde71fcb6e4b515357059bb6b6dd5146d1fc50f73f11678c6"
    );
    let nested: Value =
        serde_json::from_str(r#"{"b":{"y":1,"x":[{"d":1,"c":2}]},"a":null}"#).unwrap();
    assert_eq!(
        record_digest(&nested),
        "e556690acb504b6841677b670317be13fd27630288eecfc57f45570a6a9427eb"
    );
    let unicode: Value =
        serde_json::from_str(r#"{"имя":"Ёж","é":1,"z":[null,true,false,-5,18446744073709551615]}"#)
            .unwrap();
    assert_eq!(
        record_digest(&unicode),
        "c9c87fbc517793ef9131b143e7a4bf8d0accdfd7d602d752f2a4176a2780d79e"
    );
    let escapes = json!({ "s": "q\"b\\n\n\r\t\u{1}\u{1f}\u{7f} /" });
    assert_eq!(
        record_digest(&escapes),
        "ac2d568bf7fc3663df53c5a595e827d78e6a0fc3c2bb880fe45cee8dde6f12e8"
    );
    // Line and paragraph separators and an astral character stay as written.
    assert_eq!(
        record_digest(&json!({ "s": "a\u{2028}b\u{2029}c\u{1F600}" })),
        "4151b149552640e7b09a1488810a19728f94f2d8a355a1b98218b13affdc565c"
    );
    // The same value spelt as another JSON type is another record.
    assert_ne!(
        record_digest(&json!({ "n": 1 })),
        record_digest(&json!({ "n": "1" }))
    );
    assert_ne!(
        record_digest(&json!({ "n": 1 })),
        record_digest(&json!({ "n": 1.0 }))
    );
}

/// The characters next to the hex ranges in ASCII, and the lengths next to 64.
#[test]
fn a_code_hash_refuses_the_characters_and_lengths_next_to_its_own() {
    let with_last = |last: char| format!("{}{last}", "7".repeat(63));
    for ok in ['0', '9', 'a', 'f'] {
        assert!(is_code_hash(&with_last(ok)), "{ok:?}");
    }
    for bad in [
        '/', ':', '@', 'A', 'F', 'G', '`', 'g', '{', ' ', '-', '\u{0660}',
    ] {
        assert!(!is_code_hash(&with_last(bad)), "{bad:?}");
    }
    // The first character takes the same range.
    assert!(!is_code_hash(&format!("`{}", "7".repeat(63))));
    assert!(!is_code_hash(&"7".repeat(63)));
    assert!(!is_code_hash(&"7".repeat(65)));
    assert!(!is_code_hash(&"7".repeat(128)));
    // 64 bytes that are 63 characters: one multibyte character.
    assert!(!is_code_hash(&format!("{}é", "7".repeat(62))));
}

/// The domain's `shiftCloseReasonRequired` over the edges of the quantities.
#[test]
fn a_close_reason_is_needed_exactly_when_a_plan_differs_from_the_fact() {
    for (planned, actual, required) in [
        (None, 0, false),
        (None, u32::MAX, false),
        (Some(0), 0, false),
        (Some(0), 1, true),
        (Some(1), 1, false),
        (Some(1), 2, true),
        (Some(10_000_000), 10_000_000, false),
        (Some(10_000_000), 9_999_999, true),
        (Some(10_000_000), 10_000_001, true),
        (Some(u32::MAX), u32::MAX, false),
        (Some(u32::MAX), u32::MAX - 1, true),
    ] {
        assert_eq!(
            close_reason_required(planned, actual),
            required,
            "{planned:?} {actual}"
        );
    }
}
