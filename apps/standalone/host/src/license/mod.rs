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

use self::state::{Evaluation, Inputs, Phase, StoredLicense};
use crate::clock::format_timestamp;
use crate::error::ApiError;
use crate::server::AppState;

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
                // A loaded file proves the time is not before its issue less
                // a day (§7).
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
