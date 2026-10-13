//! The site's license (plan ЛЦ-2, spec 2026-10-13 §3, §4, §7, §8): the files
//! the office loads, the state the host computes from them and the time it
//! trusts, and the gates of new shifts, seats and features. Only the host
//! decides the state; devices read it (`GET /v1/device`).

pub mod clock;
pub mod gate;
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
    stopping: tokio::sync::watch::Receiver<bool>,
) -> tokio::task::JoinHandle<()> {
    spawn_ticker_every(app, stopping, TICK)
}

/// [`spawn_ticker`] every `period` (tests look more often than a minute:
/// the host's tokio has no paused time).
pub fn spawn_ticker_every(
    app: AppState,
    mut stopping: tokio::sync::watch::Receiver<bool>,
    period: std::time::Duration,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(period);
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
    /// Every stored file the host can use, by `sequence`.
    pub licenses: Vec<StoredLicense>,
    /// The stored row of the highest `sequence`, used or not
    /// ([`store::Files::newest`]).
    pub newest: Option<store::FileKey>,
    /// The issue of every stored row in range, used or not
    /// ([`store::Files::issued_at`]).
    pub issued_at: Vec<i64>,
    pub clock_row: store::ClockRow,
    pub org_inn: Option<String>,
    /// The INN of the trial's start in force: the database's or the
    /// registry's, whichever start is earlier (plan ЛЦ-2 task 12).
    pub trial_inn: Option<String>,
}

/// The license of this host: the keys it trusts, the trial's mark in the
/// registry, and the time it trusts, kept in memory between requests.
pub struct LicenseService {
    keyset: Keyset,
    mark: Arc<dyn trial_mark::TrialMark>,
    clock: Mutex<Option<clock::LicenseClock>>,
    /// The registry's mark of the trial as read at the start (plan ЛЦ-2
    /// task 12): `None` until it is read, then the mark or none.
    registry: Mutex<Option<Option<trial_mark::Mark>>>,
}

impl Snapshot {
    /// The stored files as read ([`store::Files`]).
    pub fn files(&self) -> store::Files {
        store::Files {
            usable: self.licenses.clone(),
            newest: self.newest.clone(),
            issued_at: self.issued_at.clone(),
        }
    }
}

impl LicenseService {
    pub fn new(keyset: Keyset, mark: Arc<dyn trial_mark::TrialMark>) -> Self {
        Self {
            keyset,
            mark,
            clock: Mutex::new(None),
            registry: Mutex::new(None),
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
        let files = store::files(&mut *conn, &self.keyset).await?;
        let clock_row = store::clock_row(&mut *conn).await?;
        let org_inn = store::org_inn(&mut *conn).await?;
        let wall = to_ms(app.now());
        let mono = app.clock.monotonic();
        let reading = {
            let mut guard = self.clock.lock().expect("license clock lock");
            let clock = guard.get_or_insert_with(|| {
                // Loaded files prove the time is not before the latest issue
                // of any stored file less a day (§7).
                let floor = clock::issue_floor(files.issued_at.iter().copied());
                clock::LicenseClock::at_start(clock_row.max_seen_at, wall, mono, floor)
            });
            clock.observe(wall, mono)
        };
        Ok(self.evaluate_known(app, reading, files, clock_row, org_inn))
    }

    /// The state of data already read (`snapshot`'s, or a write's that just
    /// committed) at `reading`, without the database.
    pub fn evaluate_known(
        &self,
        app: &AppState,
        reading: clock::Reading,
        files: store::Files,
        clock_row: store::ClockRow,
        org_inn: Option<String>,
    ) -> Snapshot {
        let store::Files {
            usable: licenses,
            newest,
            issued_at,
        } = files;
        let registry = self
            .registry
            .lock()
            .expect("registry mark lock")
            .clone()
            .flatten();
        // The trial is the earlier start of the database's and the
        // registry's, with that start's INN (the database's on a tie): a
        // reinstall buys no trial, and the INN told is the one the trial
        // started with.
        let stored = clock_row
            .trial_started_at
            .map(|started_at| (started_at, clock_row.trial_inn.clone()));
        let marked = registry.map(|mark| (mark.started_at, mark.inn));
        let trial = match (stored, marked) {
            (Some(stored), Some(marked)) => Some(if marked.0 < stored.0 { marked } else { stored }),
            (stored, marked) => stored.or(marked),
        };
        let trial_inn = trial.as_ref().and_then(|(_, inn)| inn.clone());
        // A start after the time the host trusts (a PC's clock set ahead at
        // the wizard, then back) would make a longer trial: it counts from
        // now at the latest.
        let trial_started_at = trial.map(|(started_at, _)| started_at.min(reading.effective));
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
        Snapshot {
            evaluation,
            reading,
            licenses,
            newest,
            issued_at,
            clock_row,
            org_inn,
            trial_inn,
        }
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
        // A stored start after the trusted time is counted from it (above);
        // written, it no longer slides with the time.
        let mut wrote = store::clamp_trial_start(&mut tx, now).await?;
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
        self.mark_trial(app, true).await?;
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

    /// The registry's mark, read off the async threads. What the host could
    /// not have written is no mark: a start out of range ([`bounded_ms`]) is
    /// none at all, an INN that is no INN (`crate::inn::is_valid`) is none.
    /// The service log holds neither value.
    async fn read_mark(&self) -> Option<trial_mark::Mark> {
        let mark = self.mark.clone();
        let read = tokio::task::spawn_blocking(move || mark.read())
            .await
            .ok()
            .flatten()?;
        let Some(started_at) = bounded_ms(read.started_at) else {
            tracing::warn!("the trial mark in the registry holds a start out of range; not used");
            return None;
        };
        let inn = read.inn.filter(|inn| {
            let valid = crate::inn::is_valid(inn);
            if !valid {
                tracing::warn!("the trial mark in the registry holds no valid INN; not used");
            }
            valid
        });
        Some(trial_mark::Mark {
            started_at,
            inn,
            ..read
        })
    }

    /// Write the mark off the async threads; whether it was written.
    async fn write_mark(&self, mark: trial_mark::Mark) -> bool {
        let writer = self.mark.clone();
        match tokio::task::spawn_blocking(move || writer.write(&mark)).await {
            Ok(Ok(())) => true,
            Ok(Err(error)) => {
                tracing::warn!(%error, "the trial mark was not written");
                false
            }
            Err(_) => {
                tracing::warn!("the trial mark's writer did not finish");
                false
            }
        }
    }

    /// The registry's mark (spec §3.4, plan Д11): read once at a start
    /// (`at_start`) and kept; after the wizard, read only if no start has
    /// read it yet. When it has none, the database's trial (its start and
    /// INN) is written into it; a write that fails is logged and tried
    /// again at the next start.
    async fn mark_trial(&self, app: &AppState, at_start: bool) -> Result<(), sqlx::Error> {
        let known = self.registry.lock().expect("registry mark lock").clone();
        let registry = match known {
            Some(read) if !at_start => read,
            _ => {
                let read = self.read_mark().await;
                *self.registry.lock().expect("registry mark lock") = Some(read.clone());
                read
            }
        };
        if registry.is_some() {
            return Ok(());
        }
        let mut conn = app.pool.acquire().await?;
        let row = store::clock_row(&mut conn).await?;
        drop(conn);
        let Some(started_at) = row.trial_started_at else {
            return Ok(());
        };
        let mark = trial_mark::Mark {
            started_at,
            host_id: app.host_id.clone(),
            inn: row.trial_inn,
        };
        if self.write_mark(mark.clone()).await {
            *self.registry.lock().expect("registry mark lock") = Some(Some(mark));
        }
        Ok(())
    }

    /// After the wizard: the trial's mark (when the registry has none) and
    /// the license's first look.
    pub async fn after_bootstrap(&self, app: &AppState) {
        if let Err(error) = self.mark_trial(app, false).await {
            tracing::warn!(%error, "the trial mark was not checked");
        }
        self.refresh_after_write(app).await;
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
