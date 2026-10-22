//! What the clients measure: a latency histogram per route and a count of
//! errors by class. A class is the route and what went wrong, so a run's
//! report says `facts:http_5xx` or `facts:net_timeout`, never just "errors".

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde_json::Value;

use crate::histogram::Histogram;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Route {
    Facts,
    CodeCheck,
    DeviceShifts,
    SsccBlock,
    Enter,
    Other,
}

impl Route {
    pub fn label(self) -> &'static str {
        match self {
            Route::Facts => "facts",
            Route::CodeCheck => "code_check",
            Route::DeviceShifts => "device_shifts",
            Route::SsccBlock => "sscc_block",
            Route::Enter => "enter",
            Route::Other => "other",
        }
    }
}

/// What went wrong with one request, or `None` when nothing did: a 5xx, a 4xx
/// with the code the host named, or a failure to get an answer at all.
pub fn error_class(status: Option<u16>, body: &Value, net: Option<&str>) -> Option<String> {
    if let Some(net) = net {
        return Some(format!("net_{net}"));
    }
    match status {
        Some(200..=299) | None => None,
        Some(500..=599) => Some("http_5xx".to_owned()),
        Some(_) => {
            let code = body
                .pointer("/error/code")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            Some(format!("http_4xx:{code}"))
        }
    }
}

#[derive(Default)]
pub struct Metrics {
    latency: Mutex<BTreeMap<&'static str, Histogram>>,
    errors: Mutex<BTreeMap<String, u64>>,
    during_backup: AtomicBool,
}

impl Metrics {
    pub fn new() -> Self {
        Self::default()
    }

    /// While set, the facts route is also counted under `facts_during_backup`.
    pub fn set_backup_running(&self, on: bool) {
        self.during_backup.store(on, Ordering::SeqCst);
    }

    pub fn record(&self, route: Route, micros: u64) {
        let mut latency = self.latency.lock().expect("metrics lock");
        latency.entry(route.label()).or_default().record(micros);
        if route == Route::Facts && self.during_backup.load(Ordering::SeqCst) {
            latency
                .entry("facts_during_backup")
                .or_default()
                .record(micros);
        }
    }

    pub fn error(&self, route: Route, class: &str) {
        let mut errors = self.errors.lock().expect("metrics lock");
        *errors
            .entry(format!("{}:{class}", route.label()))
            .or_default() += 1;
    }

    pub fn latency(&self) -> BTreeMap<&'static str, Histogram> {
        self.latency.lock().expect("metrics lock").clone()
    }

    pub fn errors(&self) -> BTreeMap<String, u64> {
        self.errors.lock().expect("metrics lock").clone()
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn a_class_names_the_status_the_code_or_the_network() {
        let none = Value::Null;
        assert_eq!(error_class(Some(200), &none, None), None);
        assert_eq!(
            error_class(Some(500), &none, None).as_deref(),
            Some("http_5xx")
        );
        assert_eq!(
            error_class(Some(409), &json!({"error": {"code": "conflict"}}), None).as_deref(),
            Some("http_4xx:conflict")
        );
        assert_eq!(
            error_class(Some(400), &none, None).as_deref(),
            Some("http_4xx:unknown")
        );
        assert_eq!(
            error_class(None, &none, Some("timeout")).as_deref(),
            Some("net_timeout")
        );
    }

    #[test]
    fn facts_during_a_backup_are_counted_twice_and_others_once() {
        let metrics = Metrics::new();
        metrics.record(Route::Facts, 1000);
        metrics.set_backup_running(true);
        metrics.record(Route::Facts, 2000);
        metrics.record(Route::CodeCheck, 500);
        metrics.set_backup_running(false);
        let latency = metrics.latency();
        assert_eq!(latency["facts"].count(), 2);
        assert_eq!(latency["facts_during_backup"].count(), 1);
        assert_eq!(latency["code_check"].count(), 1);
        assert!(!latency.contains_key("sscc_block"));
    }

    #[test]
    fn errors_are_kept_by_route_and_class() {
        let metrics = Metrics::new();
        metrics.error(Route::Facts, "http_5xx");
        metrics.error(Route::Facts, "http_5xx");
        metrics.error(Route::Enter, "http_5xx");
        metrics.error(Route::Facts, "net_timeout");
        assert_eq!(metrics.errors()["facts:http_5xx"], 2);
    }
}
