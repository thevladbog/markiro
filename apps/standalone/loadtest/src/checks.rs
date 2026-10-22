//! A check is a named yes or no with the numbers behind it: what a run's
//! report lists, and what a threshold turns into when it is crossed.

use std::fmt::Debug;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    pub name: String,
    pub ok: bool,
    pub detail: String,
}

impl Check {
    pub fn new(name: &str, ok: bool, detail: impl Into<String>) -> Check {
        Check {
            name: name.to_owned(),
            ok,
            detail: detail.into(),
        }
    }

    /// `actual` is what `expected` says it must be.
    pub fn same<T: PartialEq + Debug>(name: &str, expected: T, actual: T) -> Check {
        Check::new(
            name,
            expected == actual,
            format!("expected {expected:?}, got {actual:?}"),
        )
    }

    /// `actual` is no more than `limit`.
    pub fn at_most(name: &str, limit: u64, actual: u64) -> Check {
        Check::new(
            name,
            actual <= limit,
            format!("at most {limit}, got {actual}"),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_check_says_what_it_expected_and_what_it_got() {
        let ok = Check::same("scans", 10u64, 10);
        assert!(ok.ok);
        let bad = Check::same("scans", 10u64, 9);
        assert!(!bad.ok);
        assert_eq!(bad.detail, "expected 10, got 9");
        assert!(Check::at_most("busy", 0, 0).ok);
        assert!(!Check::at_most("busy", 0, 2).ok);
    }
}
