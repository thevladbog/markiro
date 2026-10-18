//! The license's seats (spec §4.7): what the site uses of each quota. A
//! quota refuses an addition beyond the file and never what runs: a device,
//! a user or a line over the limit keeps working, and only new ones are
//! refused until enough are revoked, turned off or archived.

use markiro_proto::license::constraints;
use markiro_proto::DeviceKind;
use serde_json::json;
use sqlx::SqliteConnection;

use super::state::{Features, Quotas};
use crate::error::ApiError;
use crate::server::AppState;

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

/// `conflict` on `seat_limit`: every seat of `quota` is taken.
fn seat_limit(quota: Quota, used: u64, limit: u64) -> ApiError {
    ApiError::conflict(
        constraints::SEAT_LIMIT,
        "every seat of the license is taken",
    )
    .with_details(json!({
        "constraint": constraints::SEAT_LIMIT,
        "quota": quota.key(),
        "used": used,
        "limit": limit,
    }))
}

/// A seat of `quota` is free under the license (spec §4.7); else `conflict`
/// on `seat_limit` with the quota, what is used and the limit. Called inside
/// the writer's transaction (`BEGIN IMMEDIATE`), so two additions cannot both
/// take the last seat. A refusal writes no row; what is over the limit
/// already keeps working.
pub async fn require_seat(
    app: &AppState,
    conn: &mut SqliteConnection,
    quota: Quota,
) -> Result<(), ApiError> {
    let snapshot = app
        .license
        .snapshot(app, &mut *conn)
        .await
        .map_err(ApiError::internal)?;
    let Some(limit) = quota.limit(&snapshot.evaluation.quotas) else {
        return Ok(());
    };
    let used = quota.used(&usage(&mut *conn).await.map_err(ApiError::internal)?);
    if used < limit {
        return Ok(());
    }
    Err(seat_limit(quota, used, limit))
}

/// `added` seats of `quota` were just written in this writer's transaction
/// (the cloud's import, which adds lines in bulk): refused as by
/// [`require_seat`] when they take the site beyond the file, so the caller
/// rolls the whole write back. `used` names what the write would make the
/// site use (4 of 3), the same over-limit reading as `over` (spec §4.7). An
/// addition of none passes even a site already over the limit.
pub async fn require_added_seats(
    app: &AppState,
    conn: &mut SqliteConnection,
    quota: Quota,
    added: u64,
) -> Result<(), ApiError> {
    if added == 0 {
        return Ok(());
    }
    let snapshot = app
        .license
        .snapshot(app, &mut *conn)
        .await
        .map_err(ApiError::internal)?;
    let Some(limit) = quota.limit(&snapshot.evaluation.quotas) else {
        return Ok(());
    };
    let used = quota.used(&usage(&mut *conn).await.map_err(ApiError::internal)?);
    if used <= limit {
        return Ok(());
    }
    Err(seat_limit(quota, used, limit))
}

/// A feature of the file (spec §4.7).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Feature {
    LabelEditor,
    PublicApi,
    Pallets,
    ChzIntegration,
    Inventory,
    CommerceMl,
    Handheld,
}

impl Feature {
    pub const ALL: [Feature; 7] = [
        Feature::LabelEditor,
        Feature::PublicApi,
        Feature::Pallets,
        Feature::ChzIntegration,
        Feature::Inventory,
        Feature::CommerceMl,
        Feature::Handheld,
    ];

    /// The file's and the cloud's name.
    pub fn key(self) -> &'static str {
        match self {
            Feature::LabelEditor => "labelEditor",
            Feature::PublicApi => "publicApi",
            Feature::Pallets => "pallets",
            Feature::ChzIntegration => "chzIntegration",
            Feature::Inventory => "inventory",
            Feature::CommerceMl => "commerceMl",
            Feature::Handheld => "handheld",
        }
    }

    pub fn enabled(self, features: &Features) -> bool {
        match self {
            Feature::LabelEditor => features.label_editor,
            Feature::PublicApi => features.public_api,
            Feature::Pallets => features.pallets,
            Feature::ChzIntegration => features.chz_integration,
            Feature::Inventory => features.inventory,
            Feature::CommerceMl => features.commerce_ml,
            Feature::Handheld => features.handheld,
        }
    }
}

/// The license includes `feature` (the trial has every one); else
/// `conflict` on `feature_disabled` with its name. Only new actions ask
/// (ЛО23, plan Д8): what runs never does. Called inside the writer's
/// transaction, before any write: a refusal writes no row and takes no
/// revision.
pub async fn require_feature(
    app: &AppState,
    conn: &mut SqliteConnection,
    feature: Feature,
) -> Result<(), ApiError> {
    let snapshot = app
        .license
        .snapshot(app, conn)
        .await
        .map_err(ApiError::internal)?;
    if feature.enabled(&snapshot.evaluation.features) {
        return Ok(());
    }
    Err(ApiError::conflict(
        constraints::FEATURE_DISABLED,
        "the site's license does not include this feature",
    )
    .with_details(json!({
        "constraint": constraints::FEATURE_DISABLED,
        "feature": feature.key(),
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_feature_reads_its_own_flag_under_its_own_name() {
        let keys: Vec<&str> = Feature::ALL.iter().map(|feature| feature.key()).collect();
        assert_eq!(
            keys,
            [
                "labelEditor",
                "publicApi",
                "pallets",
                "chzIntegration",
                "inventory",
                "commerceMl",
                "handheld"
            ]
        );
        assert!(Feature::ALL
            .iter()
            .all(|feature| feature.enabled(&Features::ALL)));
        for (n, feature) in Feature::ALL.iter().enumerate() {
            // Only the flag of `feature` is off.
            let flags: Vec<bool> = (0..7).map(|i| i != n).collect();
            let only = Features {
                label_editor: flags[0],
                public_api: flags[1],
                pallets: flags[2],
                chz_integration: flags[3],
                inventory: flags[4],
                commerce_ml: flags[5],
                handheld: flags[6],
                custom_logo: true,
            };
            for other in Feature::ALL {
                assert_eq!(other.enabled(&only), other != *feature, "{}", other.key());
            }
        }
    }

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
