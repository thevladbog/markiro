//! The site's license (plan ЛЦ-2, spec 2026-10-13 §3, §4, §7, §8): the files
//! the office loads, the state the host computes from them and the time it
//! trusts, and the gates of new shifts, seats and features. Only the host
//! decides the state; devices read it (`GET /v1/device`).

pub mod clock;
pub mod routes;
pub mod seats;
pub mod state;
pub mod store;
pub mod trial_mark;
pub mod verify;

use std::sync::{Arc, Mutex};

use markiro_proto::license::OfficeLicense;
use markiro_proto::trust::Keyset;
use sqlx::SqliteConnection;
use time::OffsetDateTime;

use serde_json::json;

use self::state::{Evaluation, Inputs, Phase, StoredLicense};
use crate::audit::{self, actions, Actor, Entry, Outcome};
use crate::clock::format_timestamp;
use crate::db::{begin_write, commit_with_revision, next_revision};
use crate::error::ApiError;
use crate::server::AppState;

/// How often the host looks at the state: a phase that ends by time (the
/// grace at midnight) gets its row and wakes the stations within a minute.
pub const TICK: std::time::Duration = std::time::Duration::from_secs(60);

/// The minute's look, until the host stops (`stopping` turns true). A look
/// in progress finishes first: it is one short write.
pub fn spawn_ticker(
    app: AppState,
    mut stopping: tokio::sync::watch::Receiver<bool>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(TICK);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        // The first tick is at once: the start looked already.
        interval.tick().await;
        loop {
            tokio::select! {
                // The `Ref` the wait answers is not `Send`: drop it inside.
                () = async {
                    let _ = stopping.wait_for(|stopping| *stopping).await;
                } => break,
                _ = interval.tick() => app.license.refresh_after_write(&app).await,
            }
        }
    })
}

/// `Number.MAX_SAFE_INTEGER`: the latest instant the file, the wire and the
/// domain count, in ms.
pub const MAX_MS: i64 = 9_007_199_254_740_991;

/// `ms` when it is an instant the file can count (`0..=MAX_MS`), else none.
/// Every time read back from the database (and the registry's mark, plan
/// ЛЦ-2 task 12) goes through it: a value outside was never written by the
/// host, and the caller picks the safe reading of its absence.
pub fn bounded_ms(ms: i64) -> Option<i64> {
    (0..=MAX_MS).contains(&ms).then_some(ms)
}

/// Milliseconds since the Unix epoch, as the file counts time.
pub fn to_ms(at: OffsetDateTime) -> i64 {
    i64::try_from(at.unix_timestamp_nanos() / 1_000_000).unwrap_or(i64::MAX)
}

/// The host's timestamp text of `ms` (UTC, whole seconds).
pub fn ms_text(ms: i64) -> String {
    let at = OffsetDateTime::from_unix_timestamp_nanos(i128::from(ms) * 1_000_000)
        .unwrap_or(OffsetDateTime::UNIX_EPOCH);
    format_timestamp(at)
}

/// What the host knows of its license at one moment.
#[derive(Debug, Clone)]
pub struct Snapshot {
    pub evaluation: Evaluation,
    pub reading: clock::Reading,
    /// Every stored file, by `sequence`.
    pub licenses: Vec<StoredLicense>,
    pub clock_row: store::ClockRow,
    pub org_inn: Option<String>,
}

/// The license of this host: the keys it trusts, the trial's mark in the
/// registry, and the time it trusts, kept in memory between requests.
pub struct LicenseService {
    keyset: Keyset,
    #[allow(dead_code)] // read by plan ЛЦ-2 task 12 (the registry's mark)
    mark: Arc<dyn trial_mark::TrialMark>,
    clock: Mutex<Option<clock::LicenseClock>>,
    /// The registry's start of the trial, read once at a start.
    registry_started_at: Mutex<Option<i64>>,
}

impl LicenseService {
    pub fn new(keyset: Keyset, mark: Arc<dyn trial_mark::TrialMark>) -> Self {
        Self {
            keyset,
            mark,
            clock: Mutex::new(None),
            registry_started_at: Mutex::new(None),
        }
    }

    /// The license keys this build trusts (`markiro_proto::trust`).
    pub fn keyset(&self) -> &Keyset {
        &self.keyset
    }

    /// Files just stored prove the time is not before `floor`
    /// ([`clock::issue_floor`], §7). It never lowers the time.
    pub fn raise_floor(&self, app: &AppState, floor: i64) {
        let mono = app.clock.monotonic();
        if let Some(clock) = self.clock.lock().expect("license clock lock").as_mut() {
            clock.raise_floor(floor, mono);
        }
    }

    /// The state now, read on `conn` (a writer's transaction or a reader's).
    /// It writes nothing: only the time in memory moves.
    pub async fn snapshot(
        &self,
        app: &AppState,
        conn: &mut SqliteConnection,
    ) -> Result<Snapshot, sqlx::Error> {
        let licenses = store::licenses(&mut *conn).await?;
        let clock_row = store::clock_row(&mut *conn).await?;
        let org_inn = store::org_inn(&mut *conn).await?;
        let wall = to_ms(app.now());
        let mono = app.clock.monotonic();
        let reading = {
            let mut guard = self.clock.lock().expect("license clock lock");
            let clock = guard.get_or_insert_with(|| {
                // Loaded files prove the time is not before the latest issue
                // of any stored file less a day (§7).
                let floor = clock::issue_floor(licenses.iter().map(|license| license.issued_at));
                clock::LicenseClock::at_start(clock_row.max_seen_at, wall, mono, floor)
            });
            clock.observe(wall, mono)
        };
        let registry = *self.registry_started_at.lock().expect("registry mark lock");
        let trial_started_at = match (clock_row.trial_started_at, registry) {
            (Some(stored), Some(marked)) => Some(stored.min(marked)),
            (stored, marked) => stored.or(marked),
        };
        let inn_mismatch_since = clock_row
            .last_state
            .as_deref()
            .filter(|last| *last == Phase::InnMismatch.as_str())
            .and(clock_row.last_state_at);
        let evaluation = state::evaluate(&Inputs {
            now: reading.effective,
            host_id: &app.host_id,
            org_inn: org_inn.as_deref(),
            licenses: &licenses,
            trial_started_at,
            wrong_host_since: clock_row.wrong_host_since,
            inn_mismatch_since,
            emergency: clock_row
                .emergency_used_for
                .as_deref()
                .zip(clock_row.emergency_until),
        });
        Ok(Snapshot {
            evaluation,
            reading,
            licenses,
            clock_row,
            org_inn,
        })
    }

    /// Write what changed since the last look (spec §8.2): a new state with
    /// one `license.state` row of the host and one revision, so open streams
    /// wake and stations read `GET /v1/device` again; the first look sets
    /// the state to compare with and writes no row and no revision (plan
    /// Д7); the time's mark at most once an hour and with every change; when
    /// a file of another host was first seen. Only the state's word is
    /// compared: its `since` may move (a trial before the wizard counts from
    /// now) without being a change.
    pub async fn refresh(&self, app: &AppState) -> Result<(), sqlx::Error> {
        let mut tx = begin_write(&app.pool).await?;
        let snapshot = self.snapshot(app, &mut tx).await?;
        let now = snapshot.reading.effective;
        let evaluation = &snapshot.evaluation;
        let phase = evaluation.phase.as_str();
        let row = &snapshot.clock_row;
        let mut wrote = false;
        if evaluation.wrong_host_since != row.wrong_host_since {
            store::set_wrong_host_since(&mut tx, evaluation.wrong_host_since).await?;
            wrote = true;
        }
        match row.last_state.as_deref() {
            None => {
                store::set_state(&mut tx, phase, now).await?;
                tx.commit().await?;
            }
            Some(last) if last == phase => {
                let due = row
                    .max_seen_at
                    .is_none_or(|seen| now.saturating_sub(seen) >= clock::PERSIST_EVERY_MS);
                if due {
                    store::persist_mark(&mut tx, now).await?;
                }
                if due || wrote {
                    tx.commit().await?;
                }
            }
            Some(last) => {
                let rev = next_revision(&mut tx).await?;
                store::set_state(&mut tx, phase, now).await?;
                let license_id = evaluation
                    .license
                    .as_ref()
                    .map(|license| license.license_id.as_str());
                audit::record(
                    &mut tx,
                    &app.timestamp(),
                    Entry {
                        actor: Actor::System,
                        action: actions::LICENSE_STATE,
                        target_type: Some("license"),
                        target_id: license_id,
                        outcome: Outcome::Ok,
                        details: json!({
                            "from": last,
                            "to": phase,
                            "licenseId": license_id,
                            "effectiveAt": ms_text(now),
                            "clockBehindDays": snapshot.reading.behind_days(),
                            "clockAhead": snapshot.reading.ahead,
                        }),
                    },
                )
                .await?;
                commit_with_revision(tx, &app.revisions, rev).await?;
                tracing::info!(from = last, to = phase, "license state changed");
            }
        }
        Ok(())
    }

    /// [`Self::refresh`] after a write that may change the state (a file,
    /// the organization's INN, an import, the wizard) and for the minute's
    /// look: its failure is logged and left to the next look, never to the
    /// write that is done.
    pub async fn refresh_after_write(&self, app: &AppState) {
        if let Err(error) = self.refresh(app).await {
            tracing::warn!(%error, "the license state was not refreshed");
        }
    }

    /// At the service's start (spec §3.4, §4.9): a site whose wizard ran
    /// before the build with the license starts its trial now (with the
    /// organization's INN); then the state, with the INN, is looked at and
    /// logged by its word and the file's id only.
    pub async fn startup(&self, app: &AppState) {
        if let Err(error) = self.start_inner(app).await {
            tracing::warn!(%error, "the license could not be checked at start");
        }
    }

    async fn start_inner(&self, app: &AppState) -> Result<(), sqlx::Error> {
        let at = to_ms(app.now());
        let mut tx = begin_write(&app.pool).await?;
        sqlx::query(
            "UPDATE license_clock SET trial_started_at = ?, \
             trial_inn = (SELECT inn FROM org_profile WHERE id = 1) \
             WHERE id = 1 AND trial_started_at IS NULL \
             AND (SELECT initialized_at FROM site WHERE id = 1) IS NOT NULL",
        )
        .bind(at)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        self.refresh(app).await?;
        let mut tx = app.pool.begin().await?;
        let snapshot = self.snapshot(app, &mut tx).await?;
        tx.rollback().await?;
        tracing::info!(
            state = snapshot.evaluation.phase.as_str(),
            license_id = snapshot
                .evaluation
                .license
                .as_ref()
                .map_or("none", |license| license.license_id.as_str()),
            "license state"
        );
        Ok(())
    }

    /// `GET /v1/office/license` as of now, read in one transaction.
    pub async fn office_license_now(&self, app: &AppState) -> Result<OfficeLicense, ApiError> {
        let mut tx = app.pool.begin().await.map_err(ApiError::internal)?;
        let snapshot = self
            .snapshot(app, &mut tx)
            .await
            .map_err(ApiError::internal)?;
        let usage = seats::usage(&mut tx).await.map_err(ApiError::internal)?;
        tx.rollback().await.map_err(ApiError::internal)?;
        Ok(routes::office_license(app, &snapshot, &usage))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_time_is_bounded_by_the_epoch_and_the_largest_safe_integer() {
        assert_eq!(bounded_ms(0), Some(0));
        assert_eq!(bounded_ms(-1), None);
        assert_eq!(bounded_ms(9_007_199_254_740_991), Some(MAX_MS));
        assert_eq!(bounded_ms(9_007_199_254_740_992), None);
        assert_eq!(bounded_ms(i64::MIN), None);
        assert_eq!(bounded_ms(i64::MAX), None);
    }
}
