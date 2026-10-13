//! Which copies a folder keeps (plan РК, design §15): 24 newest, the newest
//! of each of 14 days and of each of 12 months, in UTC.

use std::collections::BTreeSet;

use markiro_host::backup::retention::keep;
use time::OffsetDateTime;

fn copy(name: &str, created: &str) -> (String, OffsetDateTime) {
    (
        name.to_owned(),
        markiro_host::clock::parse_timestamp(created).unwrap(),
    )
}

fn kept(copies: &[(String, OffsetDateTime)]) -> Vec<String> {
    keep(copies).into_iter().collect()
}

#[test]
fn up_to_twenty_four_copies_are_all_kept() {
    let copies: Vec<_> = (0..24)
        .map(|hour| {
            copy(
                &format!("h{hour:02}"),
                &format!("2026-10-09T{hour:02}:00:00Z"),
            )
        })
        .collect();
    assert_eq!(keep(&copies).len(), 24);
    assert_eq!(keep(&[]), BTreeSet::new());
}

#[test]
fn a_copy_a_day_keeps_twenty_four_days_and_the_newest_of_each_older_month() {
    // One copy a day from 1 July to 9 October 2026 (101 days).
    let first = time::Date::from_calendar_date(2026, time::Month::July, 1).unwrap();
    let copies: Vec<_> = (0..101)
        .map(|day| {
            let date = first + time::Duration::days(day);
            copy(&format!("d{date}"), &format!("{date}T03:00:00Z"))
        })
        .collect();
    let mut expected: Vec<String> = (77..101)
        .map(|day| format!("d{}", first + time::Duration::days(day)))
        .collect();
    // 16 September (day 77) is the oldest of the 24 newest; months July,
    // August and September add their newest copies (the 31st, the 31st and
    // the 30th, which the 24 newest already hold).
    expected.push("d2026-07-31".to_owned());
    expected.push("d2026-08-31".to_owned());
    expected.sort();
    assert_eq!(kept(&copies), expected);
}

#[test]
fn many_copies_a_day_keep_the_newest_of_fourteen_days_beyond_the_newest_hours() {
    // Six copies a day, at 08:00 to 13:00, from 1 to 20 October.
    let mut copies = Vec::new();
    for day in 1..=20 {
        for hour in 8..14 {
            copies.push(copy(
                &format!("{day:02}-{hour:02}"),
                &format!("2026-10-{day:02}T{hour:02}:00:00Z"),
            ));
        }
    }
    let mut expected: Vec<String> = Vec::new();
    // The 24 newest: 17 October 08:00 … 20 October 13:00.
    for day in 17..=20 {
        for hour in 8..14 {
            expected.push(format!("{day:02}-{hour:02}"));
        }
    }
    // The newest of each of the 14 newest days: 7 … 20 October at 13:00.
    for day in 7..=16 {
        expected.push(format!("{day:02}-13"));
    }
    expected.sort();
    assert_eq!(kept(&copies), expected);
}

#[test]
fn the_order_of_the_listing_never_changes_the_choice() {
    let mut copies = vec![
        copy("b", "2026-10-09T10:00:00Z"),
        copy("a", "2026-10-09T10:00:00Z"),
        copy("c", "2026-09-30T10:00:00Z"),
    ];
    let forward = keep(&copies);
    copies.reverse();
    assert_eq!(keep(&copies), forward);
    // Of two copies of the same second the later name is the newer one.
    let mut many: Vec<_> = (0..24)
        .map(|hour| {
            copy(
                &format!("n{hour:02}"),
                &format!("2026-10-10T{hour:02}:00:00Z"),
            )
        })
        .collect();
    many.push(copy("tie-a", "2026-10-09T23:00:00Z"));
    many.push(copy("tie-b", "2026-10-09T23:00:00Z"));
    let chosen = keep(&many);
    assert!(chosen.contains("tie-b"), "the newest of 9 October");
    assert!(!chosen.contains("tie-a"));
}

/// A copy made before pending migrations (plan ОБН-1) stays at least 14 days
/// after it was made, counted back from the folder's newest copy, whatever
/// the hourly, daily and monthly rule says; nothing else the rule keeps
/// changes.
#[test]
fn a_copy_before_an_upgrade_stays_fourteen_days_whatever_the_rule_says() {
    use markiro_host::backup::copy::copy_name;

    let named = |created: &str, tag: &str| {
        copy(
            &copy_name(markiro_host::clock::parse_timestamp(created).unwrap(), tag),
            created,
        )
    };
    // One copy an hour from 1 to 20 October 2026; the newest is 20 October
    // 23:00, so the floor is 6 October 23:00.
    let mut copies = Vec::new();
    for day in 1..=20 {
        for hour in 0..24 {
            copies.push(named(
                &format!("2026-10-{day:02}T{hour:02}:00:00Z"),
                &format!("{day:02}{hour:02}0000"),
            ));
        }
    }
    let by_rule = kept(&copies);
    // 13 days 15 hours old, exactly 14 days old, 14 days 30 minutes old.
    let young = named("2026-10-07T08:00:30Z", "pre-upgrade-16-31");
    let boundary = named("2026-10-06T23:00:00Z", "pre-upgrade-12-16");
    let old = named("2026-10-06T22:30:00Z", "pre-upgrade-11-12");
    copies.extend([young.clone(), boundary.clone(), old.clone()]);
    let with = kept(&copies);
    assert!(with.contains(&young.0), "{with:?}");
    assert!(with.contains(&boundary.0), "{with:?}");
    assert!(!with.contains(&old.0), "{with:?}");
    let mut expected = by_rule;
    expected.extend([young.0, boundary.0]);
    expected.sort();
    assert_eq!(with, expected);
}
