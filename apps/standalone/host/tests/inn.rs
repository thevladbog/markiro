//! The host's INN port against the domain's shared cases
//! (`packages/domain/fixtures/inn-cases.json`, read by `test/inn.test.ts`
//! too): the same input gives the same answer on both sides.

use markiro_host::inn;
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Case {
    input: String,
    normalized: Option<String>,
}

fn cases() -> Vec<Case> {
    let path = format!(
        "{}/../../../packages/domain/fixtures/inn-cases.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let text =
        std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("read {path}: {error}"));
    serde_json::from_str(&text).unwrap_or_else(|error| panic!("parse {path}: {error}"))
}

#[test]
fn the_host_answers_the_shared_inn_cases_as_the_domain_does() {
    let cases = cases();
    assert!(cases.len() >= 25, "{}", cases.len());
    for case in &cases {
        assert_eq!(
            inn::normalize(&case.input),
            case.normalized,
            "{:?}",
            case.input
        );
        assert_eq!(
            inn::is_valid(&case.input),
            case.normalized.as_deref() == Some(case.input.as_str()),
            "{:?}",
            case.input
        );
    }
}

#[test]
fn the_cases_hold_what_rust_and_javascript_trim_differently() {
    let inputs: Vec<String> = cases().into_iter().map(|case| case.input).collect();
    assert!(inputs.iter().any(|input| input.starts_with('\u{feff}')));
    assert!(inputs.iter().any(|input| input.starts_with('\u{85}')));
}
