//! Which copies a folder keeps (design §15): the newest 24, the newest copy
//! of each of the 14 newest days and of each of the 12 newest months that
//! have copies, days and months in UTC. One stream of copies serves all
//! three, so a copy may be kept for more than one reason. A copy made before
//! pending migrations (plan ОБН-1, `crate::upgrade`) is also kept for
//! `upgrade::KEEP_DAYS` days.

use std::collections::BTreeSet;

use time::OffsetDateTime;

pub const HOURLY: usize = 24;
pub const DAILY: usize = 14;
pub const MONTHLY: usize = 12;

/// The names to keep among `copies` (`(file, created at)`, any order).
pub fn keep(copies: &[(String, OffsetDateTime)]) -> BTreeSet<String> {
    keep_anchored(copies, None)
}

/// [`keep`], counting the 14 days of a copy before an upgrade back from
/// `anchor` — the time of the copy a run just made — rather than from the
/// folder's newest copy: a copy dated years ahead by a clock once set forward
/// would otherwise put every copy made at the real time past the floor.
pub fn keep_anchored(
    copies: &[(String, OffsetDateTime)],
    anchor: Option<OffsetDateTime>,
) -> BTreeSet<String> {
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
    // `upgrade::KEEP_DAYS` days older than the copy a run just made (or,
    // without one, the folder's newest copy): the rule has no clock of its
    // own.
    if let Some(newest) = anchor.or_else(|| newest_first.first().map(|copy| copy.1)) {
        let floor = newest - time::Duration::days(crate::upgrade::KEEP_DAYS);
        for (name, at) in &newest_first {
            if *at >= floor && crate::upgrade::is_pre_upgrade(name) {
                kept.insert(name.clone());
            }
        }
    }
    kept
}
