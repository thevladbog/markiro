//! Which copies a folder keeps (design §15): the newest 24, the newest copy
//! of each of the 14 newest days and of each of the 12 newest months that
//! have copies, days and months in UTC. One stream of copies serves all
//! three, so a copy may be kept for more than one reason. A copy made before
//! pending migrations (plan ОБН-1, `crate::upgrade`) stays besides for
//! `upgrade::KEEP_DAYS` days.

use std::collections::BTreeSet;

use time::OffsetDateTime;

pub const HOURLY: usize = 24;
pub const DAILY: usize = 14;
pub const MONTHLY: usize = 12;

/// The names to keep among `copies` (`(file, created at)`, any order).
pub fn keep(copies: &[(String, OffsetDateTime)]) -> BTreeSet<String> {
    let mut newest_first: Vec<&(String, OffsetDateTime)> = copies.iter().collect();
    // Newest first; the name breaks a tie, so the choice never depends on the
    // order a folder listed its files in.
    newest_first.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| b.0.cmp(&a.0)));
    let mut kept = BTreeSet::new();
    for (name, _) in newest_first.iter().take(HOURLY) {
        kept.insert(name.clone());
    }
    let mut days = Vec::new();
    let mut months = Vec::new();
    for (name, at) in &newest_first {
        let day = at.date();
        if days.len() < DAILY && !days.contains(&day) {
            days.push(day);
            kept.insert(name.clone());
        }
        let month = (at.year(), at.month());
        if months.len() < MONTHLY && !months.contains(&month) {
            months.push(month);
            kept.insert(name.clone());
        }
    }
    // A copy before an upgrade stays while it is no more than
    // `upgrade::KEEP_DAYS` days older than the folder's newest copy: the rule
    // has no clock of its own, and the newest copy is the one a run just made.
    if let Some(newest) = newest_first.first().map(|copy| copy.1) {
        let floor = newest - time::Duration::days(crate::upgrade::KEEP_DAYS);
        for (name, at) in &newest_first {
            if *at >= floor && crate::upgrade::is_pre_upgrade(name) {
                kept.insert(name.clone());
            }
        }
    }
    kept
}
