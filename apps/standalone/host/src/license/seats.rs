//! The license's seats (spec §4.7): what the site uses of each quota. A
//! quota refuses an addition beyond the file and never what runs: a device,
//! a user or a line over the limit keeps working, and only new ones are
//! refused until enough are revoked, turned off or archived.

use markiro_proto::DeviceKind;
use sqlx::SqliteConnection;

use super::state::Quotas;

/// What the site uses of each quota. `u64`, as the wire's `QuotaUse` and
/// the file's limits.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Usage {
    pub lines: u64,
    pub stations: u64,
    /// No kiosk in the standalone product yet: always 0.
    pub kiosks: u64,
    pub cabinet_users: u64,
}

/// Stations and handhelds not revoked (one pool, as in the cloud), active
/// office users (accounts, not PCs) and lines not archived.
pub async fn usage(conn: &mut SqliteConnection) -> Result<Usage, sqlx::Error> {
    let (stations, cabinet_users, lines): (i64, i64, i64) = sqlx::query_as(
        "SELECT \
         (SELECT COUNT(*) FROM devices WHERE revoked_at IS NULL AND kind IN ('station', 'handheld')), \
         (SELECT COUNT(*) FROM office_users WHERE active = 1), \
         (SELECT COUNT(*) FROM lines WHERE archived = 0)",
    )
    .fetch_one(conn)
    .await?;
    let count = |n: i64| u64::try_from(n).unwrap_or(0);
    Ok(Usage {
        lines: count(lines),
        stations: count(stations),
        kiosks: 0,
        cabinet_users: count(cabinet_users),
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Quota {
    Lines,
    Stations,
    Kiosks,
    CabinetUsers,
}

impl Quota {
    pub const ALL: [Quota; 4] = [
        Quota::Lines,
        Quota::Stations,
        Quota::Kiosks,
        Quota::CabinetUsers,
    ];

    /// The file's and the cloud's name.
    pub fn key(self) -> &'static str {
        match self {
            Quota::Lines => "lines",
            Quota::Stations => "stations",
            Quota::Kiosks => "kiosks",
            Quota::CabinetUsers => "cabinetUsers",
        }
    }

    pub fn limit(self, quotas: &Quotas) -> Option<u64> {
        match self {
            Quota::Lines => quotas.lines,
            Quota::Stations => quotas.stations,
            Quota::Kiosks => quotas.kiosks,
            Quota::CabinetUsers => quotas.cabinet_users,
        }
    }

    pub fn used(self, usage: &Usage) -> u64 {
        match self {
            Quota::Lines => usage.lines,
            Quota::Stations => usage.stations,
            Quota::Kiosks => usage.kiosks,
            Quota::CabinetUsers => usage.cabinet_users,
        }
    }
}

/// The quota a device of `kind` takes a seat of: stations and handhelds share
/// the cloud's `stations` pool (ЛО22); an office PC takes none, its seats are
/// its users.
pub fn seat_of(kind: DeviceKind) -> Option<Quota> {
    match kind {
        DeviceKind::Station | DeviceKind::Handheld => Some(Quota::Stations),
        DeviceKind::Office => None,
    }
}

/// The site uses more of `quota` than the file allows (a restore, a smaller file).
pub fn over(quota: Quota, quotas: &Quotas, usage: &Usage) -> bool {
    quota
        .limit(quotas)
        .is_some_and(|limit| quota.used(usage) > limit)
}

pub fn over_any(quotas: &Quotas, usage: &Usage) -> bool {
    Quota::ALL.iter().any(|quota| over(*quota, quotas, usage))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stations_and_handhelds_share_a_pool_and_an_office_pc_takes_no_seat() {
        assert_eq!(seat_of(DeviceKind::Station), Some(Quota::Stations));
        assert_eq!(seat_of(DeviceKind::Handheld), Some(Quota::Stations));
        assert_eq!(seat_of(DeviceKind::Office), None);
    }

    #[test]
    fn over_is_strictly_more_than_the_limit_and_no_limit_is_never_over() {
        let usage = Usage {
            lines: 2,
            stations: 3,
            kiosks: 0,
            cabinet_users: 1,
        };
        let at = Quotas {
            lines: Some(2),
            stations: Some(3),
            kiosks: Some(0),
            cabinet_users: Some(1),
        };
        assert!(!over_any(&at, &usage));
        assert!(!over_any(&Quotas::default(), &usage));
        for quota in Quota::ALL {
            let mut below = at;
            match quota {
                Quota::Lines => below.lines = Some(1),
                Quota::Stations => below.stations = Some(2),
                Quota::Kiosks => continue,
                Quota::CabinetUsers => below.cabinet_users = Some(0),
            }
            assert!(over(quota, &below, &usage), "{}", quota.key());
            assert!(over_any(&below, &usage), "{}", quota.key());
        }
    }
}
