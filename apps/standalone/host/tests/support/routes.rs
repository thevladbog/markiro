//! The router's `.route("<path>", get(..).post(..))` calls, read from `src/server.rs`
//! (a copy of `license_routes.rs`'s parser: that guard stays untouched).

use std::collections::BTreeSet;

pub fn router_source() -> String {
    include_str!("../../src/server.rs")
        .split("#[cfg(test)]")
        .next()
        .expect("the source of the router")
        .replace("\r\n", "\n")
}

fn calls(text: &str, call: &str) -> usize {
    let mut count = 0;
    let mut search = text;
    while let Some(at) = search.find(call) {
        let before = search[..at].chars().next_back();
        if !before.is_some_and(|c| c.is_alphanumeric() || c == '_') {
            count += 1;
        }
        search = &search[at + call.len()..];
    }
    count
}

pub fn routed() -> BTreeSet<(String, String)> {
    let source = router_source();
    let mut found = BTreeSet::new();
    let mut rest = source.as_str();
    while let Some(start) = rest.find(".route(") {
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
            if calls(segment, call) > 0 {
                found.insert((method.to_owned(), path.to_owned()));
            }
        }
        rest = &after[end..];
    }
    found
}
