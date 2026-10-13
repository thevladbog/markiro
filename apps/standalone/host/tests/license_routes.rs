//! Every route of the host is in exactly one of the license's tables (plan
//! ЛЦ-2, spec §3.3, §12.1): closed by the license's state (`GATED`) or never
//! (`NEVER`). A route added to the router and to neither table fails here, so
//! none stays unclassified. The seats and features (§4.7), which refuse
//! additions beyond the file in any state, are their own axis (`LIMITED`).

use std::collections::BTreeSet;

use markiro_host::license::gate::{GATED, LIMITED, NEVER};

/// `(method, path)` of every `.route("<path>", <methods>)` in
/// `src/server.rs` (the path on the same line or the next): the method calls
/// (`get(`, `post(`, `put(`, `delete(`) up to the next route or the end of
/// the function, outside the unit tests.
fn routed() -> BTreeSet<(String, String)> {
    // The router only: the module of unit tests builds probe routes of its own.
    let source = include_str!("../src/server.rs")
        .split("#[cfg(test)]")
        .next()
        .expect("the source of the router");
    let mut found = BTreeSet::new();
    let mut rest = source;
    while let Some(start) = rest.find(".route(") {
        // `rustfmt` puts a long route's path on the next line.
        let after = rest[start + ".route(".len()..].trim_start();
        let after = after
            .strip_prefix('"')
            .expect("a route's path is a literal");
        let end = after.find('"').expect("a route's path ends");
        let path = &after[..end];
        let body = &after[end..];
        let stop = [body.find(".route("), body.find("\n}\n")]
            .into_iter()
            .flatten()
            .min()
            .unwrap_or(body.len());
        let segment = &body[..stop];
        for (method, call) in [
            ("GET", "get("),
            ("POST", "post("),
            ("PUT", "put("),
            ("DELETE", "delete("),
        ] {
            let mut search = segment;
            while let Some(at) = search.find(call) {
                let before = search[..at].chars().next_back();
                if !before.is_some_and(|c| c.is_alphanumeric() || c == '_') {
                    found.insert((method.to_owned(), path.to_owned()));
                }
                search = &search[at + call.len()..];
            }
        }
        rest = &after[end..];
    }
    found
}

fn pairs(table: &[(&str, &str, &str)]) -> BTreeSet<(String, String)> {
    table
        .iter()
        .map(|(method, path, _)| ((*method).to_owned(), (*path).to_owned()))
        .collect()
}

#[test]
fn every_route_is_closed_by_the_license_or_never_and_not_both() {
    let routed = routed();
    assert!(routed.len() > 80, "the router was not read: {routed:?}");
    let gated = pairs(GATED);
    let never: BTreeSet<(String, String)> = NEVER
        .iter()
        .map(|(method, path)| ((*method).to_owned(), (*path).to_owned()))
        .collect();
    assert_eq!(gated.len(), GATED.len(), "a route twice in GATED");
    assert_eq!(never.len(), NEVER.len(), "a route twice in NEVER");
    let both: Vec<_> = gated.intersection(&never).collect();
    assert!(both.is_empty(), "routes in both tables: {both:?}");
    let classified: BTreeSet<(String, String)> = gated.union(&never).cloned().collect();
    let unclassified: Vec<_> = routed.difference(&classified).collect();
    assert!(
        unclassified.is_empty(),
        "routes in neither table: {unclassified:?}"
    );
    let gone: Vec<_> = classified.difference(&routed).collect();
    assert!(
        gone.is_empty(),
        "classified routes the router does not have: {gone:?}"
    );
}

/// Spec §3.3: the state closes exactly a planned shift's opening (its first
/// entry) and a station's new shift; pairing, facts, closes, the license
/// itself and everything else never.
#[test]
fn the_gated_routes_are_the_ones_the_spec_names() {
    let gated: BTreeSet<(&str, &str)> = GATED
        .iter()
        .map(|(method, path, _)| (*method, *path))
        .collect();
    assert_eq!(
        gated,
        BTreeSet::from([
            ("POST", "/v1/device/shifts/{id}/enter"),
            ("POST", "/v1/device/shifts"),
        ])
    );
    for route in [
        ("POST", "/v1/local-pair"),
        ("POST", "/v1/pairing/claim"),
        ("POST", "/v1/office/shifts"),
        ("POST", "/v1/office/shifts/{id}/close"),
        ("POST", "/v1/device/facts"),
        ("PUT", "/v1/office/license"),
        ("POST", "/v1/office/license/emergency"),
    ] {
        assert!(NEVER.contains(&route), "{route:?}");
    }
}

/// Spec §4.7 (plan ЛЦ-2 tasks 10 and 11): the routes that ask a seat or a
/// feature for an addition beyond the file, in any state. Each is a route of
/// the router, in one of the two tables.
#[test]
fn the_limited_routes_are_the_additions_tasks_10_and_11_close() {
    let limited = pairs(LIMITED);
    assert_eq!(limited.len(), LIMITED.len(), "a route twice in LIMITED");
    let routed = routed();
    let missing: Vec<_> = limited.difference(&routed).collect();
    assert!(missing.is_empty(), "limits on no route: {missing:?}");
    let routes: BTreeSet<(&str, &str)> = LIMITED
        .iter()
        .map(|(method, path, _)| (*method, *path))
        .collect();
    assert_eq!(
        routes,
        BTreeSet::from([
            ("POST", "/v1/local-pair"),
            ("POST", "/v1/pairing/claim"),
            ("POST", "/v1/device/shifts"),
            ("POST", "/v1/office/users"),
            ("PUT", "/v1/office/users/{id}"),
            ("POST", "/v1/office/lines"),
            ("PUT", "/v1/office/lines/{id}"),
            ("POST", "/v1/office/import"),
            ("POST", "/v1/office/shifts"),
            ("PUT", "/v1/office/shifts/{id}"),
            ("POST", "/v1/office/templates"),
            ("PUT", "/v1/office/templates/{id}"),
        ])
    );
}
