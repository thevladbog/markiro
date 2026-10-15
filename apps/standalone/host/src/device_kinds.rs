//! Which kind of device may call which route (plan ТСД-Х, spec 6.2, decision Д7). The one source:
//! `auth::authenticate` checks it right after it knows the kind, before a handler reads the body.
//! A route that authenticates a device and has no row here is `forbidden` for everybody, so a new
//! route is closed until its row is written (`tests/device_kind_routes.rs` fails first).
//!
//! The office's routes (`/v1/office/*`, `/v1/bootstrap`) are one rule, not a row each: they take a
//! station or an office PC. A handheld's key never opens them, whatever password follows (three
//! identities, `apps/standalone/AGENTS.md`).

use markiro_proto::DeviceKind::{self, Handheld, Office, Station};

use crate::error::ApiError;

/// `(method, route as the router writes it, the kinds that may call it)`.
///
/// A handheld reads and enters its line's shift and gets SSCC blocks (task Х2); it creates no
/// shift and chooses no line: the office assigns a handheld its line.
pub const ROUTE_KINDS: &[(&str, &str, &[DeviceKind])] = &[
    ("GET", "/v1/device", &[Station, Handheld, Office]),
    ("PUT", "/v1/device/line", &[Station]),
    ("GET", "/v1/device/shifts", &[Station, Handheld]),
    ("POST", "/v1/device/shifts", &[Station]),
    ("POST", "/v1/device/shifts/{id}/enter", &[Station, Handheld]),
    ("POST", "/v1/device/sscc/blocks", &[Station, Handheld]),
    ("POST", "/v1/device/sscc/blocks/known", &[Station, Handheld]),
    ("POST", "/v1/device/facts", &[Station, Handheld]),
    ("POST", "/v1/device/pallet-events", &[Handheld]),
    (
        "GET",
        "/v1/device/codes/{code_hash}",
        &[Station, Handheld, Office],
    ),
    ("POST", "/v1/device/conflicts/status", &[Station, Handheld]),
    ("GET", "/v1/device/displacements", &[Station, Handheld]),
    ("GET", "/v1/device/products/{id}/photo", &[Station]),
    ("GET", "/v1/device/pallet-sheets", &[Station]),
    ("POST", "/v1/device/warehouse/lookup", &[Station]),
    ("POST", "/v1/device/warehouse/reprints", &[Station]),
    ("GET", "/v1/changes", &[Station, Handheld, Office]),
    ("GET", "/v1/changes/stream", &[Station, Handheld, Office]),
];

/// Kinds that may call the office's routes.
pub const OFFICE_KINDS: &[DeviceKind] = &[Station, Office];

/// The kinds allowed on `route` with `method`, or `None` for a route with no rule.
pub fn allowed_kinds(method: &str, route: &str) -> Option<&'static [DeviceKind]> {
    if let Some((_, _, kinds)) = ROUTE_KINDS
        .iter()
        .find(|(m, path, _)| *m == method && *path == route)
    {
        return Some(kinds);
    }
    (route.starts_with("/v1/office/") || route == "/v1/bootstrap").then_some(OFFICE_KINDS)
}

/// `Ok` when `kind` may call `route`; `forbidden` otherwise, with no detail about the table.
pub fn check(method: &str, route: &str, kind: DeviceKind) -> Result<(), ApiError> {
    match allowed_kinds(method, route) {
        Some(kinds) if kinds.contains(&kind) => Ok(()),
        _ => Err(ApiError::forbidden(
            "this kind of device does not call this route",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_route_without_a_rule_is_closed_to_every_kind() {
        for kind in [Station, Office, Handheld] {
            assert!(check("GET", "/v1/device/unheard-of", kind).is_err());
        }
    }

    #[test]
    fn the_office_rule_takes_a_station_and_an_office_pc_only() {
        assert!(check("POST", "/v1/office/login", Station).is_ok());
        assert!(check("GET", "/v1/office/me", Office).is_ok());
        assert!(check("POST", "/v1/office/login", Handheld).is_err());
        assert!(check("POST", "/v1/bootstrap", Handheld).is_err());
    }

    #[test]
    fn a_row_names_the_method_too() {
        assert!(check("GET", "/v1/device/facts", Handheld).is_err());
        assert!(check("POST", "/v1/device/facts", Handheld).is_ok());
    }
}
