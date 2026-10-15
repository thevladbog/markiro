//! The host's own work on its packages (plan ОБН-3, spec §10.11.2): the
//! start of the service opens the store (strays out, `staged\` promoted,
//! `current\` verified whole) and writes what it found to the audit log;
//! then every hour the promotion is tried again. The running version does
//! not change while the host runs, so the hourly pass only retries a
//! promotion a locked file held back.

use std::sync::Arc;
use std::time::Duration;

use markiro_proto::update::distribution::PackageState;
use serde_json::{json, Value};
use sqlx::SqlitePool;
use tokio::sync::watch;
use tokio::task::JoinHandle;

use super::{Promotion, StartReport, UpdateStore};
use crate::audit::{self, actions, Actor, Entry, Outcome};
use crate::clock::{format_timestamp, Clock};
use crate::db::begin_write;

/// How often the promotion is tried again.
pub const PROMOTE_EVERY: Duration = Duration::from_secs(3600);

type Row = (Outcome, Option<String>, Value);

/// The row of a promotion; none for no package, a waiting or a stale one.
fn promotion_row(promotion: &Promotion) -> Option<Row> {
    match promotion {
        Promotion::Promoted { version, previous } => Some((
            Outcome::Ok,
            Some(version.clone()),
            json!({ "version": version, "previous": previous }),
        )),
        Promotion::Failed { version } => Some((
            Outcome::Failed,
            version.clone(),
            json!({ "version": version, "previous": null, "reason": "invalid" }),
        )),
        Promotion::None | Promotion::Waiting { .. } | Promotion::Stale { .. } => None,
    }
}

/// The row of a start: the promotion's, else one `failed` row for a current
/// package of another version (`mismatch`: a restore from a copy of another
/// version) or one that does not check out (`invalid`).
fn start_row(report: &StartReport) -> Option<Row> {
    promotion_row(&report.promotion).or_else(|| {
        let reason = match report.current {
            PackageState::Mismatch => "mismatch",
            PackageState::Invalid => "invalid",
            _ => return None,
        };
        Some((
            Outcome::Failed,
            report.current_version.clone(),
            json!({ "version": report.current_version, "previous": null, "reason": reason }),
        ))
    })
}

async fn write(pool: &SqlitePool, at: &str, row: Option<Row>) -> Result<(), sqlx::Error> {
    let Some((outcome, version, details)) = row else {
        return Ok(());
    };
    let mut tx = begin_write(pool).await?;
    audit::record(
        &mut tx,
        at,
        Entry {
            actor: Actor::System,
            action: actions::UPDATE_PACKAGE_PROMOTE,
            target_type: version.as_ref().map(|_| "update_package"),
            target_id: version.as_deref(),
            outcome,
            details,
        },
    )
    .await?;
    tx.commit().await
}

/// What the start found, in the audit log.
pub async fn record_start(
    pool: &SqlitePool,
    at: &str,
    report: &StartReport,
) -> Result<(), sqlx::Error> {
    write(pool, at, start_row(report)).await
}

/// What a pass did, in the audit log.
pub async fn record_promotion(
    pool: &SqlitePool,
    at: &str,
    promotion: &Promotion,
) -> Result<(), sqlx::Error> {
    write(pool, at, promotion_row(promotion)).await
}

/// One pass: promote, verify what became current, write the row.
pub async fn tick(store: &Arc<UpdateStore>, pool: &SqlitePool, clock: &dyn Clock) {
    let promoting = store.clone();
    let Ok(promotion) = tokio::task::spawn_blocking(move || {
        let promotion = promoting.promote_blocking();
        if matches!(promotion, Promotion::Promoted { .. }) {
            promoting.reverify_blocking();
        }
        promotion
    })
    .await
    else {
        return;
    };
    if let Err(error) = record_promotion(pool, &format_timestamp(clock.now()), &promotion).await {
        tracing::error!(%error, "the promotion of an update package was not recorded");
    }
}

/// The hourly pass, until `stopping` turns `true`. The start made the first.
pub fn spawn(
    store: Arc<UpdateStore>,
    pool: SqlitePool,
    clock: Arc<dyn Clock>,
    mut stopping: watch::Receiver<bool>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut ticks = tokio::time::interval(PROMOTE_EVERY);
        ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        ticks.tick().await;
        loop {
            tokio::select! {
                // The `Ref` the wait answers is not `Send`: drop it inside.
                () = async {
                    let _ = stopping.wait_for(|stopping| *stopping).await;
                } => break,
                _ = ticks.tick() => tick(&store, &pool, &*clock).await,
            }
        }
    })
}
