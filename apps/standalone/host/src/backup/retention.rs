//! Which copies a folder keeps (design §15): the newest 24, the newest copy
//! of each of the 14 newest days and of each of the 12 newest months that
//! have copies, days and months in UTC. One stream of copies serves all
//! three, so a copy may be kept for more than one reason.

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
    kept
}
