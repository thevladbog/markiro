//! The version rules of an update from a file (spec §10.7, §10.8): never an
//! older version; the same one only as a confirmed reinstall; not past a
//! version it must not skip (`minUpgradeFrom`); on a PC that is not the
//! host's, not ahead of the host's protocol, and only with a confirmation
//! while the host does not answer. Pure: the inputs are read elsewhere.

use std::cmp::Ordering;

use markiro_proto::update::AppVersion;
use serde::Serialize;

use crate::host_probe::HostVersions;

/// The package's version against this app's.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Comparison {
    Newer,
    Same,
    Older,
}

/// Why the package may not be installed here, with what the text names.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum Refusal {
    /// The package is older than this app: never a downgrade (§10.8).
    Older { installed: String },
    /// This app is older than the package's `minUpgradeFrom` (§10.2).
    MinUpgrade {
        #[serde(rename = "minUpgradeFrom")]
        min_upgrade_from: String,
    },
    /// The package speaks a newer protocol than the host: the host first (§10.7).
    HostFirst {
        #[serde(rename = "hostProtocol")]
        host_protocol: u32,
        protocol: u32,
    },
}

/// A warning a person confirms before the install (the webview sends its code back).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Confirmation {
    /// The same version again: a repair (§10.8).
    Reinstall,
    /// The host did not answer: this PC may end up ahead of it (§10.7, ЛО12).
    HostUnreachable,
}

impl Confirmation {
    /// The confirmation of a code the webview sends; `None` for any other text.
    pub fn from_code(code: &str) -> Option<Self> {
        match code {
            "reinstall" => Some(Self::Reinstall),
            "host_unreachable" => Some(Self::HostUnreachable),
            _ => None,
        }
    }
}

/// What is known of the host this PC answers to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostCheck {
    /// This is the host's own PC: the same installer updates the host.
    NotNeeded,
    /// The host answered `hello`.
    Seen(HostVersions),
    /// The host did not answer.
    Silent,
}

/// What the signed manifest offers.
#[derive(Debug, Clone, Copy)]
pub struct Offered<'a> {
    pub version: &'a AppVersion,
    pub min_upgrade_from: &'a AppVersion,
    pub protocol: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Decision {
    pub comparison: Comparison,
    pub refusal: Option<Refusal>,
    pub confirmations: Vec<Confirmation>,
}

pub fn decide(offered: Offered<'_>, installed: &AppVersion, host: &HostCheck) -> Decision {
    let comparison = match offered.version.cmp(installed) {
        Ordering::Greater => Comparison::Newer,
        Ordering::Equal => Comparison::Same,
        Ordering::Less => Comparison::Older,
    };
    let mut confirmations = Vec::new();
    if comparison == Comparison::Same {
        confirmations.push(Confirmation::Reinstall);
    }
    let refusal = if comparison == Comparison::Older {
        Some(Refusal::Older {
            installed: installed.to_string(),
        })
    } else if installed < offered.min_upgrade_from {
        Some(Refusal::MinUpgrade {
            min_upgrade_from: offered.min_upgrade_from.to_string(),
        })
    } else {
        match host {
            HostCheck::NotNeeded => None,
            HostCheck::Silent => {
                confirmations.push(Confirmation::HostUnreachable);
                None
            }
            HostCheck::Seen(seen) if offered.protocol > seen.protocol => Some(Refusal::HostFirst {
                host_protocol: seen.protocol,
                protocol: offered.protocol,
            }),
            HostCheck::Seen(_) => None,
        }
    };
    Decision {
        comparison,
        refusal,
        confirmations,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn v(text: &str) -> AppVersion {
        text.parse().unwrap()
    }

    fn seen(protocol: u32) -> HostCheck {
        HostCheck::Seen(HostVersions {
            version: Some("0.2.0".into()),
            protocol,
            min_protocol: 1,
        })
    }

    fn offered<'a>(version: &'a AppVersion, min: &'a AppVersion, protocol: u32) -> Offered<'a> {
        Offered {
            version,
            min_upgrade_from: min,
            protocol,
        }
    }

    #[test]
    fn a_newer_package_installs_without_a_question() {
        let (version, min) = (v("0.2.0"), v("0.1.0"));
        let expected = Decision {
            comparison: Comparison::Newer,
            refusal: None,
            confirmations: vec![],
        };
        assert_eq!(
            decide(
                offered(&version, &min, 3),
                &v("0.1.0"),
                &HostCheck::NotNeeded
            ),
            expected
        );
        assert_eq!(
            decide(offered(&version, &min, 3), &v("0.1.0"), &seen(3)),
            expected
        );
    }

    #[test]
    fn an_older_package_is_refused_and_the_same_one_asks_first() {
        let (version, min) = (v("0.2.0"), v("0.1.0"));
        let older = decide(offered(&version, &min, 3), &v("0.3.0"), &HostCheck::Silent);
        assert_eq!(older.comparison, Comparison::Older);
        assert_eq!(
            older.refusal,
            Some(Refusal::Older {
                installed: "0.3.0".into()
            })
        );
        assert_eq!(older.confirmations, vec![]);
        let same = decide(
            offered(&version, &min, 3),
            &v("0.2.0"),
            &HostCheck::NotNeeded,
        );
        assert_eq!(
            (same.comparison, same.refusal, same.confirmations),
            (Comparison::Same, None, vec![Confirmation::Reinstall])
        );
        let same_alone = decide(offered(&version, &min, 3), &v("0.2.0"), &HostCheck::Silent);
        assert_eq!(
            same_alone.confirmations,
            vec![Confirmation::Reinstall, Confirmation::HostUnreachable]
        );
    }

    #[test]
    fn a_package_that_skips_a_needed_version_is_refused() {
        let (version, min) = (v("0.3.0"), v("0.2.0"));
        assert_eq!(
            decide(
                offered(&version, &min, 3),
                &v("0.1.0"),
                &HostCheck::NotNeeded
            )
            .refusal,
            Some(Refusal::MinUpgrade {
                min_upgrade_from: "0.2.0".into()
            })
        );
        assert_eq!(
            decide(
                offered(&version, &min, 3),
                &v("0.2.0"),
                &HostCheck::NotNeeded
            )
            .refusal,
            None
        );
    }

    #[test]
    fn a_pc_that_is_not_the_hosts_waits_for_its_host() {
        let (version, min) = (v("0.3.0"), v("0.2.0"));
        assert_eq!(
            decide(offered(&version, &min, 4), &v("0.2.0"), &seen(3)).refusal,
            Some(Refusal::HostFirst {
                host_protocol: 3,
                protocol: 4
            })
        );
        assert_eq!(
            decide(offered(&version, &min, 4), &v("0.2.0"), &seen(4)).refusal,
            None
        );
        let silent = decide(offered(&version, &min, 4), &v("0.2.0"), &HostCheck::Silent);
        assert_eq!(
            (silent.refusal, silent.confirmations),
            (None, vec![Confirmation::HostUnreachable])
        );
        // The host's own PC is updated by the same installer: no host is asked.
        assert_eq!(
            decide(
                offered(&version, &min, 4),
                &v("0.2.0"),
                &HostCheck::NotNeeded
            )
            .refusal,
            None
        );
    }

    #[test]
    fn the_reasons_cross_ipc_in_the_webviews_words() {
        assert_eq!(
            serde_json::to_value(Refusal::MinUpgrade {
                min_upgrade_from: "0.2.0".into()
            })
            .unwrap(),
            json!({ "code": "min_upgrade", "minUpgradeFrom": "0.2.0" })
        );
        assert_eq!(
            serde_json::to_value(Refusal::HostFirst {
                host_protocol: 3,
                protocol: 4
            })
            .unwrap(),
            json!({ "code": "host_first", "hostProtocol": 3, "protocol": 4 })
        );
        assert_eq!(
            serde_json::to_value(Refusal::Older {
                installed: "0.3.0".into()
            })
            .unwrap(),
            json!({ "code": "older", "installed": "0.3.0" })
        );
        assert_eq!(
            serde_json::to_value(Confirmation::HostUnreachable).unwrap(),
            json!("host_unreachable")
        );
        assert_eq!(
            serde_json::to_value(Comparison::Newer).unwrap(),
            json!("newer")
        );
        for confirmation in [Confirmation::Reinstall, Confirmation::HostUnreachable] {
            let code = serde_json::to_value(confirmation).unwrap();
            assert_eq!(
                Confirmation::from_code(code.as_str().unwrap()),
                Some(confirmation)
            );
        }
        assert_eq!(Confirmation::from_code("yes"), None);
    }
}
