//! The license state as a pure function (plan ЛЦ-2, spec 2026-10-13 §3.2,
//! §3.4, §3.5, §4.6–§4.9): the stored files, the trial's start, the time the
//! host trusts and the organization's INN in, the state out. No I/O and no
//! clock of its own, so a test moves the time instead of waiting.

use markiro_proto::license::states;
use serde::{Deserialize, Serialize};

/// One day in the file's unit (milliseconds).
pub const DAY_MS: i64 = 86_400_000;
/// The built-in trial: 14 days from the wizard, without grace (§3.4).
pub const TRIAL_DAYS: i64 = 14;
/// How long a file issued to another host keeps everything open (§4.6).
pub const WRONG_HOST_DAYS: i64 = 30;
/// The emergency extension: 72 hours, once per file and once for the trial (§3.5).
pub const EMERGENCY_MS: i64 = 72 * 60 * 60 * 1000;
/// The longest warning, whatever the term (§3.2).
pub const MAX_WARN_DAYS: i64 = 30;
/// What the emergency extension of the built-in trial is recorded under.
pub const TRIAL_KEY: &str = "trial";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Trial,
    Active,
    Expiring,
    Grace,
    Restricted,
    WrongHost,
    InnMismatch,
    TrialExpired,
}

impl Phase {
    pub fn as_str(self) -> &'static str {
        match self {
            Phase::Trial => states::TRIAL,
            Phase::Active => states::ACTIVE,
            Phase::Expiring => states::EXPIRING,
            Phase::Grace => states::GRACE,
            Phase::Restricted => states::RESTRICTED,
            Phase::WrongHost => states::WRONG_HOST,
            Phase::InnMismatch => states::INN_MISMATCH,
            Phase::TrialExpired => states::TRIAL_EXPIRED,
        }
    }

    /// New shifts open (a planned one entered for the first time, one a
    /// station creates) in every state but these three (§3.3).
    pub fn opens_new_shifts(self) -> bool {
        !matches!(
            self,
            Phase::Restricted | Phase::InnMismatch | Phase::TrialExpired
        )
    }
}

/// The file's quotas; `None` is no limit, as in the cloud. `u64`, as
/// `trust::LicenseQuotas` and the wire's `QuotaUse`: limits go up to 2^53 − 1.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Quotas {
    pub lines: Option<u64>,
    pub stations: Option<u64>,
    pub kiosks: Option<u64>,
    pub cabinet_users: Option<u64>,
}

/// The file's features.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Features {
    pub label_editor: bool,
    pub public_api: bool,
    pub pallets: bool,
    pub chz_integration: bool,
    pub inventory: bool,
    pub commerce_ml: bool,
    pub handheld: bool,
}

impl Features {
    /// The built-in trial's: every feature.
    pub const ALL: Features = Features {
        label_editor: true,
        public_api: true,
        pallets: true,
        chz_integration: true,
        inventory: true,
        commerce_ml: true,
        handheld: true,
    };
}

/// A stored license file: the verified payload's fields, times in ms UTC.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredLicense {
    pub license_id: String,
    pub sequence: i64,
    pub kid: String,
    pub host_id: String,
    pub issued_at: i64,
    pub valid_from: i64,
    /// Exclusive.
    pub valid_until: i64,
    pub grace_days: i64,
    /// `demo` or `subscription`.
    pub plan: String,
    pub plan_version_id: String,
    pub customer_name: String,
    pub customer_inn: String,
    pub quotas: Quotas,
    pub features: Features,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Trial {
    pub started_at: i64,
    pub ends_at: i64,
}

/// What the state is computed from.
pub struct Inputs<'a> {
    /// The effective time (`clock.rs`), ms UTC.
    pub now: i64,
    pub host_id: &'a str,
    /// `org_profile.inn` as stored; `None` without one.
    pub org_inn: Option<&'a str>,
    pub licenses: &'a [StoredLicense],
    /// The earlier of the database's and the registry's start (§3.4).
    pub trial_started_at: Option<i64>,
    /// When a file of another host was first seen in force.
    pub wrong_host_since: Option<i64>,
    /// When the INN stopped matching, as the last `license.state` row says.
    pub inn_mismatch_since: Option<i64>,
    /// `license_clock.emergency_used_for` and `emergency_until`.
    pub emergency: Option<(&'a str, i64)>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Evaluation {
    pub phase: Phase,
    /// When this state began, as far as the host knows.
    pub since: i64,
    /// When it ends by time; `None` for a state that only a file or an INN ends.
    pub phase_ends_at: Option<i64>,
    /// Whole days, rounded up, until the file's or the trial's end (or the
    /// end of the grace or of the wrong host's window).
    pub days_left: Option<u32>,
    pub warn_days: u32,
    /// The file in force: the highest `sequence` whose start came.
    pub license: Option<StoredLicense>,
    pub trial: Option<Trial>,
    pub quotas: Quotas,
    pub features: Features,
    /// Whether the organization's INN is the file's; `None` without a file.
    pub inn_matches: Option<bool>,
    /// The file's id, or [`TRIAL_KEY`].
    pub emergency_key: String,
    pub emergency_used: bool,
    /// The end of an emergency extension that runs now.
    pub emergency_until: Option<i64>,
    pub emergency_available: bool,
    pub opens_new_shifts: bool,
    /// What `license_clock.wrong_host_since` should hold now.
    pub wrong_host_since: Option<i64>,
}

/// `min(30, ⌊term in days / 3⌋)` (§3.2, the owner's ЛО2).
pub fn warn_days(term_ms: i64) -> i64 {
    (term_ms.max(0) / DAY_MS / 3).min(MAX_WARN_DAYS)
}

/// Whole days until `end`, rounded up; 0 once it passed.
pub fn days_until(end: i64, now: i64) -> u32 {
    if end <= now {
        return 0;
    }
    u32::try_from((end - now + DAY_MS - 1) / DAY_MS).unwrap_or(u32::MAX)
}

/// The file in force at `now`: the highest `sequence` among those that began.
pub fn effective(licenses: &[StoredLicense], now: i64) -> Option<&StoredLicense> {
    licenses
        .iter()
        .filter(|license| license.valid_from <= now)
        .max_by_key(|license| license.sequence)
}

/// Both INNs normalized and checked by their check digit, then compared as
/// text (§4.9): an INN whose check digit fails equals nothing.
pub fn inn_matches(org: Option<&str>, file: &str) -> bool {
    match (
        org.and_then(crate::inn::normalize),
        crate::inn::normalize(file),
    ) {
        (Some(org), Some(file)) => org == file,
        _ => false,
    }
}

struct Phased {
    phase: Phase,
    since: i64,
    ends: Option<i64>,
    days_left: Option<u32>,
}

fn of_trial(trial: Trial, now: i64) -> Phased {
    if now < trial.ends_at {
        Phased {
            phase: Phase::Trial,
            since: trial.started_at,
            ends: Some(trial.ends_at),
            days_left: Some(days_until(trial.ends_at, now)),
        }
    } else {
        Phased {
            phase: Phase::TrialExpired,
            since: trial.ends_at,
            ends: None,
            days_left: None,
        }
    }
}

fn of_term(file: &StoredLicense, warn: i64, now: i64) -> Phased {
    let expiring_from = file.valid_until - warn * DAY_MS;
    let grace_end = file.valid_until + file.grace_days * DAY_MS;
    if now < expiring_from {
        Phased {
            phase: Phase::Active,
            since: file.valid_from,
            ends: Some(expiring_from),
            days_left: Some(days_until(file.valid_until, now)),
        }
    } else if now < file.valid_until {
        Phased {
            phase: Phase::Expiring,
            since: expiring_from.max(file.valid_from),
            ends: Some(file.valid_until),
            days_left: Some(days_until(file.valid_until, now)),
        }
    } else if now < grace_end {
        Phased {
            phase: Phase::Grace,
            since: file.valid_until,
            ends: Some(grace_end),
            days_left: Some(days_until(grace_end, now)),
        }
    } else {
        Phased {
            phase: Phase::Restricted,
            since: grace_end,
            ends: None,
            days_left: None,
        }
    }
}

/// The state at `inputs.now` (§3.2): another host's file first, then the
/// INN, then the file's term; without a file in force, the trial.
pub fn evaluate(inputs: &Inputs<'_>) -> Evaluation {
    let now = inputs.now;
    let trial = inputs.trial_started_at.map(|started_at| Trial {
        started_at,
        ends_at: started_at + TRIAL_DAYS * DAY_MS,
    });
    let license = effective(inputs.licenses, now).cloned();
    let mut wrong_host_since = None;
    let (phased, warn, matched) = match &license {
        // Before the wizard there is no start yet: the trial counts from now.
        None => {
            let trial = trial.unwrap_or(Trial {
                started_at: now,
                ends_at: now + TRIAL_DAYS * DAY_MS,
            });
            (of_trial(trial, now), warn_days(TRIAL_DAYS * DAY_MS), None)
        }
        Some(file) => {
            let warn = warn_days(file.valid_until - file.valid_from);
            let matches = inn_matches(inputs.org_inn, &file.customer_inn);
            let phased = if file.host_id != inputs.host_id {
                let seen = inputs.wrong_host_since.unwrap_or(now);
                wrong_host_since = Some(seen);
                let ends = seen + WRONG_HOST_DAYS * DAY_MS;
                if now < ends {
                    Phased {
                        phase: Phase::WrongHost,
                        since: seen,
                        ends: Some(ends),
                        days_left: Some(days_until(ends, now)),
                    }
                } else {
                    Phased {
                        phase: Phase::Restricted,
                        since: ends,
                        ends: None,
                        days_left: None,
                    }
                }
            } else if !matches {
                Phased {
                    phase: Phase::InnMismatch,
                    since: inputs.inn_mismatch_since.unwrap_or(now),
                    ends: None,
                    days_left: None,
                }
            } else {
                of_term(file, warn, now)
            };
            (phased, warn, Some(matches))
        }
    };
    let emergency_key = license
        .as_ref()
        .map_or_else(|| TRIAL_KEY.to_owned(), |file| file.license_id.clone());
    let (emergency_used, emergency_until) = match inputs.emergency {
        Some((used_for, until)) if used_for == emergency_key => {
            (true, (now < until).then_some(until))
        }
        _ => (false, None),
    };
    let phase = phased.phase;
    Evaluation {
        phase,
        since: phased.since,
        phase_ends_at: phased.ends,
        days_left: phased.days_left,
        warn_days: u32::try_from(warn).unwrap_or(0),
        quotas: license
            .as_ref()
            .map_or_else(Quotas::default, |file| file.quotas),
        features: license.as_ref().map_or(Features::ALL, |file| file.features),
        license,
        trial,
        inn_matches: matched,
        emergency_key,
        emergency_used,
        emergency_until,
        emergency_available: !emergency_used && !phase.opens_new_shifts(),
        opens_new_shifts: phase.opens_new_shifts() || emergency_until.is_some(),
        wrong_host_since,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOST: &str = "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
    const OTHER_HOST: &str = "9b2e4f60-1a3c-4d5e-8f70-1a2b3c4d5e6f";
    /// A valid INN: its check digit holds.
    const INN: &str = "7707083893";
    /// 2026-09-21T14:13:20Z, the manual clock's start in the host's tests.
    const T0: i64 = 1_790_000_000_000;

    fn day(n: i64) -> i64 {
        T0 + n * DAY_MS
    }

    fn file(sequence: i64, from: i64, until: i64, grace: i64) -> StoredLicense {
        StoredLicense {
            license_id: format!("6d1f0a52-3c4b-4e8f-9a1d-{sequence:012}"),
            sequence,
            kid: "test-lic-1".to_owned(),
            host_id: HOST.to_owned(),
            issued_at: from,
            valid_from: from,
            valid_until: until,
            grace_days: grace,
            plan: "subscription".to_owned(),
            plan_version_id: "0b7c2d9e-1f3a-4b5c-8d6e-7f8091a2b3c4".to_owned(),
            customer_name: "ООО «Атолл»".to_owned(),
            customer_inn: INN.to_owned(),
            quotas: Quotas {
                stations: Some(3),
                ..Quotas::default()
            },
            features: Features {
                pallets: false,
                ..Features::ALL
            },
        }
    }

    fn inputs<'a>(now: i64, licenses: &'a [StoredLicense]) -> Inputs<'a> {
        Inputs {
            now,
            host_id: HOST,
            org_inn: Some(INN),
            licenses,
            trial_started_at: Some(T0),
            wrong_host_since: None,
            inn_mismatch_since: None,
            emergency: None,
        }
    }

    fn at(now: i64, licenses: &[StoredLicense]) -> Evaluation {
        evaluate(&inputs(now, licenses))
    }

    #[test]
    fn the_trial_runs_fourteen_days_from_the_wizard_without_grace() {
        let first = at(day(0), &[]);
        assert_eq!(
            (
                first.phase,
                first.since,
                first.phase_ends_at,
                first.days_left,
                first.warn_days
            ),
            (Phase::Trial, T0, Some(day(14)), Some(14), 4)
        );
        assert_eq!(
            first.trial,
            Some(Trial {
                started_at: T0,
                ends_at: day(14)
            })
        );
        assert_eq!(
            (first.quotas, first.features),
            (Quotas::default(), Features::ALL)
        );
        assert!(first.opens_new_shifts && first.license.is_none() && first.inn_matches.is_none());
        assert_eq!(at(day(14) - 1, &[]).days_left, Some(1));
        let over = at(day(14), &[]);
        assert_eq!(
            (over.phase, over.since, over.phase_ends_at),
            (Phase::TrialExpired, day(14), None)
        );
        assert!(!over.opens_new_shifts && over.emergency_available);
        assert_eq!(over.emergency_key, TRIAL_KEY);
    }

    #[test]
    fn the_warning_is_a_third_of_the_term_and_at_most_thirty_days() {
        assert_eq!(warn_days(365 * DAY_MS), 30);
        assert_eq!(warn_days(30 * DAY_MS), 10);
        assert_eq!(warn_days(14 * DAY_MS), 4);
        assert_eq!(warn_days(2 * DAY_MS), 0);
    }

    #[test]
    fn a_year_runs_active_then_expiring_then_grace_then_restricted() {
        let files = [file(1, day(0), day(365), 14)];
        let steps = [
            (day(0), Phase::Active, day(0), Some(day(335)), Some(365)),
            (
                day(335) - 1,
                Phase::Active,
                day(0),
                Some(day(335)),
                Some(31),
            ),
            (
                day(335),
                Phase::Expiring,
                day(335),
                Some(day(365)),
                Some(30),
            ),
            (
                day(365) - 1,
                Phase::Expiring,
                day(335),
                Some(day(365)),
                Some(1),
            ),
            // `validUntil` is exclusive.
            (day(365), Phase::Grace, day(365), Some(day(379)), Some(14)),
            (day(379), Phase::Restricted, day(379), None, None),
        ];
        for (now, phase, since, ends, days_left) in steps {
            let evaluation = at(now, &files);
            assert_eq!(
                (
                    evaluation.phase,
                    evaluation.since,
                    evaluation.phase_ends_at,
                    evaluation.days_left
                ),
                (phase, since, ends, days_left),
                "at {now}"
            );
            assert_eq!(evaluation.quotas.stations, Some(3));
            assert!(!evaluation.features.pallets);
            assert_eq!(evaluation.inn_matches, Some(true));
            assert_eq!(evaluation.opens_new_shifts, phase != Phase::Restricted);
        }
    }

    #[test]
    fn without_grace_the_end_restricts_at_once() {
        let demo = [file(1, day(0), day(14), 0)];
        assert_eq!(at(day(9), &demo).phase, Phase::Active);
        assert_eq!(at(day(10), &demo).phase, Phase::Expiring);
        let ended = at(day(14), &demo);
        assert_eq!((ended.phase, ended.since), (Phase::Restricted, day(14)));
    }

    #[test]
    fn a_file_waits_for_its_start_and_the_highest_sequence_that_began_wins() {
        let waiting = [file(1, day(5), day(365), 14)];
        assert_eq!(at(day(1), &waiting).phase, Phase::Trial);
        assert_eq!(at(day(5), &waiting).phase, Phase::Active);
        let both = [file(1, day(0), day(365), 14), file(2, day(30), day(60), 0)];
        assert_eq!(
            at(day(10), &both).license.map(|license| license.sequence),
            Some(1)
        );
        assert_eq!(
            at(day(30), &both).license.map(|license| license.sequence),
            Some(2)
        );
        // A newer, shorter file ends the site's term, though the older one runs.
        assert_eq!(at(day(60), &both).phase, Phase::Restricted);
    }

    #[test]
    fn a_file_of_another_host_keeps_thirty_days_from_when_it_was_seen() {
        let mut foreign = file(1, day(0), day(365), 14);
        foreign.host_id = OTHER_HOST.to_owned();
        let files = [foreign];
        let seen = at(day(3), &files);
        assert_eq!(
            (
                seen.phase,
                seen.since,
                seen.phase_ends_at,
                seen.wrong_host_since
            ),
            (Phase::WrongHost, day(3), Some(day(33)), Some(day(3)))
        );
        assert!(seen.opens_new_shifts);
        let later = evaluate(&Inputs {
            wrong_host_since: Some(day(3)),
            ..inputs(day(33), &files)
        });
        assert_eq!(
            (later.phase, later.since, later.wrong_host_since),
            (Phase::Restricted, day(33), Some(day(3)))
        );
        assert_eq!(
            at(day(3), &[file(1, day(0), day(365), 14)]).wrong_host_since,
            None
        );
    }

    #[test]
    fn an_inn_that_differs_fails_its_check_digit_or_is_missing_restricts() {
        let files = [file(1, day(0), day(365), 14)];
        for org in [Some("7701234560"), Some("7707083894"), Some(""), None] {
            let evaluation = evaluate(&Inputs {
                org_inn: org,
                ..inputs(day(1), &files)
            });
            assert_eq!(
                (evaluation.phase, evaluation.since, evaluation.inn_matches),
                (Phase::InnMismatch, day(1), Some(false)),
                "{org:?}"
            );
            assert!(!evaluation.opens_new_shifts);
        }
        let since = evaluate(&Inputs {
            org_inn: Some("7701234560"),
            inn_mismatch_since: Some(day(0)),
            ..inputs(day(1), &files)
        });
        assert_eq!(since.since, day(0));
        let spaced = evaluate(&Inputs {
            org_inn: Some(" 7707083893 "),
            ..inputs(day(1), &files)
        });
        assert_eq!(spaced.phase, Phase::Active);
    }

    #[test]
    fn another_host_comes_before_the_inn_and_the_inn_before_the_term() {
        let mut foreign = file(1, day(0), day(365), 14);
        foreign.host_id = OTHER_HOST.to_owned();
        fn wrong_inn(now: i64, files: &[StoredLicense]) -> Evaluation {
            evaluate(&Inputs {
                org_inn: Some("7701234560"),
                ..inputs(now, files)
            })
        }
        let both = wrong_inn(day(1), &[foreign]);
        assert_eq!(
            (both.phase, both.inn_matches),
            (Phase::WrongHost, Some(false))
        );
        // A file past its grace with an INN that differs: the INN is named.
        let ended = wrong_inn(day(400), &[file(1, day(0), day(365), 14)]);
        assert_eq!((ended.phase, ended.since), (Phase::InnMismatch, day(400)));
    }

    #[test]
    fn the_emergency_opens_new_shifts_for_72_hours_once_per_file() {
        let files = [file(1, day(0), day(10), 0)];
        let key = files[0].license_id.clone();
        let restricted = at(day(11), &files);
        assert!(restricted.emergency_available && !restricted.emergency_used);
        let running = evaluate(&Inputs {
            emergency: Some((key.as_str(), day(11) + EMERGENCY_MS)),
            ..inputs(day(11), &files)
        });
        assert_eq!(running.phase, Phase::Restricted);
        assert!(running.opens_new_shifts && running.emergency_used && !running.emergency_available);
        assert_eq!(running.emergency_until, Some(day(11) + EMERGENCY_MS));
        let spent = evaluate(&Inputs {
            emergency: Some((key.as_str(), day(11) + EMERGENCY_MS)),
            ..inputs(day(11) + EMERGENCY_MS, &files)
        });
        assert!(!spent.opens_new_shifts && spent.emergency_used && !spent.emergency_available);
        // The trial's emergency is not the file's.
        let trial_used = evaluate(&Inputs {
            emergency: Some((TRIAL_KEY, day(12))),
            ..inputs(day(11), &files)
        });
        assert!(!trial_used.emergency_used && trial_used.emergency_available);
        // A state that opens new shifts needs none.
        assert!(!at(day(1), &files).emergency_available);
    }
}
