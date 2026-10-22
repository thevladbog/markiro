//! What a run does (the profile) and what it must show to pass (the
//! thresholds). Three presets: `tiny` (a self-test of the harness, seconds),
//! `smoke` (the CI job, minutes) and `soak` (the owner's long run, hours).

use serde::{Deserialize, Serialize};

/// The order in which the devices close their parts at the end of the run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CloseOrder {
    StationsFirst,
    HandheldsFirst,
    Shuffled,
}

impl std::str::FromStr for CloseOrder {
    type Err = String;

    fn from_str(text: &str) -> Result<Self, String> {
        match text {
            "stations-first" => Ok(Self::StationsFirst),
            "handhelds-first" => Ok(Self::HandheldsFirst),
            "shuffled" => Ok(Self::Shuffled),
            other => Err(format!(
                "close order '{other}': stations-first, handhelds-first or shuffled"
            )),
        }
    }
}

/// The multi-station scenarios a run can take after its main run (plan
/// `2026-10-22-multi-station-load-test-scenarios.md`), in the order it takes them. Each scenario
/// task of that plan adds its name here.
pub const SCENARIOS: &[&str] = &["line-full"];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub name: String,
    pub stations: u32,
    pub handhelds: u32,
    /// Scans a second, of each device.
    pub scan_rate: f64,
    pub duration_s: u64,
    pub box_capacity: u32,
    /// Boxes on a pallet; 0 runs a shift without pallets.
    pub pallet_boxes: u32,
    pub box_block_size: u32,
    pub pallet_block_size: u32,
    /// How often a device sends its outbox, and the most it sends at once.
    pub flush_ms: u64,
    pub batch_max: usize,
    /// Mean seconds a device stays online and offline; 0 offline: never drops.
    pub mean_online_s: f64,
    pub mean_offline_s: f64,
    /// A scan of a code another device holds, sent without the host's check
    /// (the 300 ms ran out): the host answers `conflict`.
    pub late_dup_rate: f64,
    /// A scan of a code another device holds, after the host's check said
    /// taken: the station sends it as a `duplicate`.
    pub checked_dup_rate: f64,
    /// An offline device's scan that an online device scans first: the host
    /// takes the earlier one when the offline device comes back.
    pub race_rate: f64,
    /// A batch sent again after its answer was kept, to prove idempotency.
    pub resend_rate: f64,
    pub totals_poll_s: f64,
    /// Fractions of the run at which a backup is asked for under load.
    pub backup_at: Vec<f64>,
    pub sample_s: u64,
    pub seed: u64,
    pub close_order: CloseOrder,
    /// The scenarios run after the main run, each on a fresh host (`scenarios::run_all`); an
    /// older report has none.
    #[serde(default)]
    pub scenarios: Vec<String>,
}

impl Profile {
    pub fn devices(&self) -> u32 {
        self.stations + self.handhelds
    }

    pub fn preset(name: &str) -> Result<Profile, String> {
        let smoke = Profile {
            name: "smoke".to_owned(),
            stations: 4,
            handhelds: 2,
            scan_rate: 5.0,
            duration_s: 180,
            box_capacity: 12,
            pallet_boxes: 5,
            box_block_size: 40,
            pallet_block_size: 6,
            flush_ms: 300,
            batch_max: 100,
            mean_online_s: 45.0,
            mean_offline_s: 6.0,
            late_dup_rate: 0.005,
            checked_dup_rate: 0.01,
            race_rate: 0.2,
            resend_rate: 0.02,
            totals_poll_s: 5.0,
            backup_at: vec![0.5],
            sample_s: 5,
            seed: 20_261_020,
            close_order: CloseOrder::Shuffled,
            scenarios: SCENARIOS.iter().map(|name| (*name).to_owned()).collect(),
        };
        match name {
            "smoke" => Ok(smoke),
            "tiny" => Ok(Profile {
                name: "tiny".to_owned(),
                stations: 2,
                handhelds: 1,
                duration_s: 20,
                box_capacity: 6,
                pallet_boxes: 2,
                box_block_size: 12,
                pallet_block_size: 4,
                mean_online_s: 6.0,
                mean_offline_s: 2.0,
                late_dup_rate: 0.02,
                checked_dup_rate: 0.03,
                sample_s: 1,
                totals_poll_s: 2.0,
                ..smoke
            }),
            "soak" => Ok(Profile {
                name: "soak".to_owned(),
                scan_rate: 10.0,
                duration_s: 4 * 3600,
                box_block_size: 200,
                pallet_block_size: 20,
                pallet_boxes: 10,
                mean_online_s: 600.0,
                mean_offline_s: 20.0,
                race_rate: 0.05,
                backup_at: vec![0.25, 0.5, 0.75],
                sample_s: 15,
                scenarios: Vec::new(),
                ..smoke
            }),
            other => Err(format!("profile '{other}': tiny, smoke or soak")),
        }
    }

    /// `key=value`, one of the profile's own fields (the CLI's `--set`).
    pub fn set(&mut self, key: &str, value: &str) -> Result<(), String> {
        fn number<T: std::str::FromStr>(key: &str, value: &str) -> Result<T, String> {
            value
                .parse()
                .map_err(|_| format!("{key}: '{value}' is not a number of the right kind"))
        }
        match key {
            "stations" => self.stations = number(key, value)?,
            "handhelds" => self.handhelds = number(key, value)?,
            "scanRate" => self.scan_rate = number(key, value)?,
            "durationS" => self.duration_s = number(key, value)?,
            "boxCapacity" => self.box_capacity = number(key, value)?,
            "palletBoxes" => self.pallet_boxes = number(key, value)?,
            "boxBlockSize" => self.box_block_size = number(key, value)?,
            "palletBlockSize" => self.pallet_block_size = number(key, value)?,
            "flushMs" => self.flush_ms = number(key, value)?,
            "batchMax" => self.batch_max = number(key, value)?,
            "meanOnlineS" => self.mean_online_s = number(key, value)?,
            "meanOfflineS" => self.mean_offline_s = number(key, value)?,
            "lateDupRate" => self.late_dup_rate = number(key, value)?,
            "checkedDupRate" => self.checked_dup_rate = number(key, value)?,
            "raceRate" => self.race_rate = number(key, value)?,
            "resendRate" => self.resend_rate = number(key, value)?,
            "totalsPollS" => self.totals_poll_s = number(key, value)?,
            "sampleS" => self.sample_s = number(key, value)?,
            "seed" => self.seed = number(key, value)?,
            "backupAt" => {
                self.backup_at = value
                    .split(',')
                    .filter(|part| !part.is_empty())
                    .map(|part| number::<f64>(key, part))
                    .collect::<Result<_, _>>()?
            }
            "closeOrder" => self.close_order = value.parse()?,
            "scenarios" => {
                self.scenarios = match value {
                    "all" => SCENARIOS.iter().map(|name| (*name).to_owned()).collect(),
                    "none" | "" => Vec::new(),
                    list => list
                        .split(',')
                        .filter(|name| !name.is_empty())
                        .map(str::to_owned)
                        .collect(),
                }
            }
            other => return Err(format!("unknown profile field '{other}'")),
        }
        self.validate()
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.stations == 0 {
            return Err("stations: at least one (the office station takes part)".into());
        }
        if self.devices() > 16 {
            return Err("stations + handhelds: at most 16 (the line's limit)".into());
        }
        if !(self.scan_rate > 0.0 && self.scan_rate <= 100.0) {
            return Err("scanRate: above 0 and at most 100 a second".into());
        }
        if self.duration_s == 0 || self.box_capacity == 0 || self.batch_max == 0 {
            return Err("durationS, boxCapacity and batchMax must be above 0".into());
        }
        if self.batch_max > 100 {
            return Err("batchMax: the host takes at most 100 records".into());
        }
        if self.box_block_size < 2 || (self.pallet_boxes > 0 && self.pallet_block_size < 2) {
            return Err("block sizes: at least 2 (the half rule needs a half)".into());
        }
        for (name, rate) in [
            ("lateDupRate", self.late_dup_rate),
            ("checkedDupRate", self.checked_dup_rate),
            ("raceRate", self.race_rate),
            ("resendRate", self.resend_rate),
        ] {
            if !(0.0..=1.0).contains(&rate) {
                return Err(format!("{name}: between 0 and 1"));
            }
        }
        if self.backup_at.iter().any(|at| !(0.0..1.0).contains(at)) {
            return Err("backupAt: fractions of the run, 0 up to 1".into());
        }
        for name in &self.scenarios {
            if !SCENARIOS.contains(&name.as_str()) {
                return Err(format!(
                    "scenarios: '{name}' is none of: all, none, {}",
                    SCENARIOS.join(", ")
                ));
            }
        }
        Ok(())
    }

    /// The scans the devices would make with no stall: what the harness's own
    /// speed is judged against.
    pub fn ideal_scans(&self) -> f64 {
        f64::from(self.devices()) * self.scan_rate * self.duration_s as f64
    }
}

/// What a run must show. Every number is the most the run may show, except
/// the ratio named `min`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Thresholds {
    pub facts_p95_ms: f64,
    pub facts_p99_ms: f64,
    pub facts_max_ms: f64,
    /// The facts route while a backup runs.
    pub facts_backup_p99_ms: f64,
    pub code_check_p99_ms: f64,
    /// Checks slower than the station's 300 ms, as a share of all.
    pub code_check_over_300ms_share: f64,
    pub other_p99_ms: f64,
    /// Requests the host answered with a 5xx and ERROR lines of its log.
    pub server_errors: u64,
    /// Lines of the host's log that say SQLite refused to wait for a lock.
    pub busy_errors: u64,
    /// Requests that got no answer (a timeout, a refused connection).
    pub net_errors: u64,
    /// Requests the host refused with a 4xx: the harness sends nothing it should refuse.
    pub client_errors: u64,
    pub wal_backlog_max_frames: u64,
    pub wal_file_max_mib: u64,
    pub rss_slope_mib_per_hour: f64,
    /// The slope is judged only for runs at least this long.
    pub slope_min_duration_s: u64,
    /// The host holds at most `fd_fixed + fd_per_device * devices` descriptors,
    /// and no more than `fd_growth_max` more at the end than after the warm-up.
    pub fd_fixed: u64,
    pub fd_per_device: u64,
    pub fd_growth_max: u64,
    /// Scans made, as a share of the ideal; below it the harness itself lagged.
    pub generated_share_min: f64,
}

impl Thresholds {
    pub fn for_profile(name: &str) -> Result<Thresholds, String> {
        let smoke = Thresholds {
            facts_p95_ms: 100.0,
            facts_p99_ms: 250.0,
            facts_max_ms: 2000.0,
            facts_backup_p99_ms: 500.0,
            code_check_p99_ms: 150.0,
            code_check_over_300ms_share: 0.001,
            other_p99_ms: 500.0,
            server_errors: 0,
            busy_errors: 0,
            net_errors: 0,
            client_errors: 0,
            wal_backlog_max_frames: 8000,
            wal_file_max_mib: 256,
            rss_slope_mib_per_hour: 20.0,
            slope_min_duration_s: 1800,
            fd_fixed: 64,
            fd_per_device: 4,
            fd_growth_max: 8,
            generated_share_min: 0.9,
        };
        match name {
            "smoke" => Ok(smoke),
            // The same rules four times as loose where a number is a latency,
            // since a self-test runs on whatever machine the developer has.
            "tiny" => Ok(Thresholds {
                facts_p95_ms: smoke.facts_p95_ms * 4.0,
                facts_p99_ms: smoke.facts_p99_ms * 4.0,
                facts_max_ms: smoke.facts_max_ms * 2.0,
                facts_backup_p99_ms: smoke.facts_backup_p99_ms * 4.0,
                code_check_p99_ms: smoke.code_check_p99_ms * 4.0,
                code_check_over_300ms_share: 0.02,
                other_p99_ms: smoke.other_p99_ms * 4.0,
                generated_share_min: 0.6,
                ..smoke
            }),
            // Six times the facts of a smoke run: the p99 may be a little higher.
            "soak" => Ok(Thresholds {
                facts_p95_ms: 150.0,
                facts_p99_ms: 400.0,
                facts_backup_p99_ms: 800.0,
                ..smoke
            }),
            other => Err(format!("thresholds of '{other}': tiny, smoke or soak")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_smoke_and_soak_presets_are_the_documented_ones() {
        let smoke = Profile::preset("smoke").unwrap();
        assert_eq!(
            (
                smoke.stations,
                smoke.handhelds,
                smoke.scan_rate,
                smoke.duration_s
            ),
            (4, 2, 5.0, 180)
        );
        let soak = Profile::preset("soak").unwrap();
        assert_eq!(
            (
                soak.stations,
                soak.handhelds,
                soak.scan_rate,
                soak.duration_s
            ),
            (4, 2, 10.0, 14_400)
        );
        assert_eq!(soak.backup_at, vec![0.25, 0.5, 0.75]);
        assert_eq!(smoke.ideal_scans(), 6.0 * 5.0 * 180.0);
        for name in ["tiny", "smoke", "soak"] {
            Profile::preset(name).unwrap().validate().unwrap();
            Thresholds::for_profile(name).unwrap();
        }
        assert!(Profile::preset("huge").is_err());
    }

    #[test]
    fn set_changes_one_field_and_refuses_what_cannot_run() {
        let mut profile = Profile::preset("smoke").unwrap();
        profile.set("scanRate", "7.5").unwrap();
        profile.set("backupAt", "0.3,0.6").unwrap();
        profile.set("closeOrder", "handhelds-first").unwrap();
        assert_eq!(profile.scan_rate, 7.5);
        assert_eq!(profile.backup_at, vec![0.3, 0.6]);
        assert_eq!(profile.close_order, CloseOrder::HandheldsFirst);
        assert!(profile.set("scanRate", "fast").is_err());
        assert!(profile.set("nonsense", "1").is_err());
        assert!(profile.set("batchMax", "101").is_err());
        assert!(profile.set("stations", "17").is_err());
        assert!(profile.set("raceRate", "1.5").is_err());
        assert!(profile.set("backupAt", "1.0").is_err());
    }

    #[test]
    fn the_tiny_thresholds_are_looser_only_where_a_machine_decides() {
        let tiny = Thresholds::for_profile("tiny").unwrap();
        let smoke = Thresholds::for_profile("smoke").unwrap();
        assert_eq!((tiny.busy_errors, tiny.server_errors), (0, 0));
        assert_eq!(tiny.facts_p99_ms, smoke.facts_p99_ms * 4.0);
        assert_eq!(tiny.wal_backlog_max_frames, smoke.wal_backlog_max_frames);
    }

    #[test]
    fn the_scenarios_are_all_by_default_none_for_soak_and_named_ones_only() {
        let all: Vec<String> = SCENARIOS.iter().map(|name| (*name).to_owned()).collect();
        assert_eq!(Profile::preset("smoke").unwrap().scenarios, all);
        assert_eq!(Profile::preset("tiny").unwrap().scenarios, all);
        assert!(Profile::preset("soak").unwrap().scenarios.is_empty());
        let mut profile = Profile::preset("smoke").unwrap();
        profile.set("scenarios", "none").unwrap();
        assert!(profile.scenarios.is_empty());
        profile.set("scenarios", "all").unwrap();
        assert_eq!(profile.scenarios, all);
        let refused = profile.set("scenarios", "no-such-scenario").unwrap_err();
        assert!(refused.contains("no-such-scenario"), "{refused}");
        profile.scenarios.clear();
        let mut value = serde_json::to_value(&profile).unwrap();
        value.as_object_mut().unwrap().remove("scenarios");
        let back: Profile = serde_json::from_value(value).unwrap();
        assert!(
            back.scenarios.is_empty(),
            "a profile of an older report reads with no scenario"
        );
    }
}
