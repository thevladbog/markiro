//! A delivery journal separate from host.db (never part of its VACUUM copy).
use markiro_backup_cloud::{
    model::{ClientProfile, SnapshotId, JSON_CAP},
    Error, Result,
};
use serde::{Deserialize, Serialize};
use sqlx::{
    sqlite::{SqliteConnectOptions, SqliteJournalMode},
    ConnectOptions, Connection, SqliteConnection,
};
use std::{path::Path, time::Duration};
use tokio::sync::Mutex;
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceContext {
    pub restore_epoch: Option<String>,
    pub dataset_epoch: Option<String>,
}
impl SourceContext {
    pub async fn read(
        conn: &mut SqliteConnection,
    ) -> std::result::Result<Self, crate::error::ApiError> {
        let row: Option<(Option<String>, Option<String>)> =
            sqlx::query_as("SELECT restore_epoch,dataset_epoch FROM site WHERE id=1")
                .fetch_optional(conn)
                .await
                .map_err(crate::error::ApiError::internal)?;
        let (restore_epoch, dataset_epoch) = row.unwrap_or_default();
        if [&restore_epoch, &dataset_epoch]
            .into_iter()
            .flatten()
            .any(|s| s.len() > 200 || s.chars().any(char::is_control))
        {
            return Err(crate::error::ApiError::conflict(
                "dataset_changed",
                "invalid source context",
            ));
        }
        Ok(Self {
            restore_epoch,
            dataset_epoch,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Binding {
    pub generation: Uuid,
    pub client_id: String,
    pub account_id: String,
    pub host_id: Uuid,
    #[serde(default)]
    pub source: SourceContext,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Queued,
    Staging,
    Uploading,
    Verifying,
    Publishing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CloudAuditAction {
    Connect,
    Disconnect,
    Upload,
    Purge,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloudAuditEvent {
    pub event_id: Uuid,
    pub at: String,
    pub actor_user_id: Option<Uuid>,
    pub action: CloudAuditAction,
    pub target_id: Uuid,
    pub client_id: String,
    pub account_id: String,
    pub host_id: Uuid,
    pub snapshot_id: Option<SnapshotId>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PurgeIntent {
    pub binding: Binding,
    pub snapshot: SnapshotId,
    pub event: CloudAuditEvent,
    pub marker_removed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Job {
    pub snapshot_id: SnapshotId,
    pub source_file: String,
    pub phase: Phase,
    pub failures: u32,
    pub retry_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeliveryStatus {
    #[serde(default)]
    pub retention_retry_at: i64,
    #[serde(default)]
    pub retention_error: Option<markiro_proto::yandex_backups::ErrorCode>,
    #[serde(default)]
    pub purges: Vec<PurgeIntent>,
    #[serde(default)]
    pub retention_due: bool,
    pub format: u32,
    #[serde(default)]
    pub connection_generation: Option<Uuid>,
    #[serde(default)]
    pub paused: bool,
    #[serde(default)]
    pub connection_error: Option<markiro_proto::yandex_backups::ErrorCode>,
    #[serde(default)]
    pub refresh_retry_at: i64,
    #[serde(default)]
    pub refresh_failures: u32,
    pub binding: Option<Binding>,
    pub active: Option<Job>,
    pub pending: Option<String>,
    pub last_snapshot: Option<SnapshotId>,
    #[serde(default)]
    pub last_source_file: Option<String>,
    #[serde(default)]
    pub rejected_source: Option<String>,
    pub last_copy_at: Option<String>,
    pub last_upload_at: Option<String>,
    pub error: Option<String>,
    #[serde(default)]
    pub outbox: Vec<CloudAuditEvent>,
}
impl Default for DeliveryStatus {
    fn default() -> Self {
        Self {
            retention_retry_at: 0,
            retention_error: None,
            purges: Vec::new(),
            retention_due: false,
            format: 1,
            connection_generation: None,
            paused: false,
            connection_error: None,
            refresh_retry_at: 0,
            refresh_failures: 0,
            binding: None,
            active: None,
            pending: None,
            last_snapshot: None,
            last_source_file: None,
            rejected_source: None,
            last_copy_at: None,
            last_upload_at: None,
            error: None,
            outbox: Vec::new(),
        }
    }
}

pub(super) fn source_name(name: &str) -> bool {
    name.starts_with("markiro-host-")
        && name.ends_with(".db")
        && name.len() <= 128
        && !name.contains("..")
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
}
fn validate(state: &DeliveryStatus) -> Result<()> {
    if state
        .binding
        .as_ref()
        .is_some_and(|b| Some(b.generation) != state.connection_generation)
    {
        return Err(Error::InvalidFormat);
    }
    if state.outbox.len() > 32 {
        return Err(Error::SizeLimit);
    }
    for event in &state.outbox {
        ClientProfile::new(&event.client_id)?;
        time::OffsetDateTime::parse(&event.at, &time::format_description::well_known::Rfc3339)
            .map_err(|_| Error::InvalidFormat)?;
        if event.event_id.is_nil()
            || event.target_id.is_nil()
            || event.host_id.is_nil()
            || event.account_id.is_empty()
            || event.account_id.len() > 200
        {
            return Err(Error::InvalidFormat);
        }
    }
    if state.format != 1 {
        return Err(Error::InvalidFormat);
    }
    if let Some(binding) = &state.binding {
        ClientProfile::new(&binding.client_id)?;
        if binding.generation.is_nil()
            || binding.host_id.is_nil()
            || binding.account_id.is_empty()
            || binding.account_id.len() > 200
        {
            return Err(Error::InvalidFormat);
        }
    }
    if state
        .active
        .as_ref()
        .is_some_and(|j| j.snapshot_id.0.is_nil() || !source_name(&j.source_file))
        || state.pending.as_ref().is_some_and(|s| !source_name(s))
    {
        return Err(Error::InvalidFormat);
    }
    Ok(())
}

pub struct DeliveryStore {
    connection: Mutex<SqliteConnection>,
}
impl DeliveryStore {
    pub async fn open(path: &Path) -> Result<Self> {
        let mut connection = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .busy_timeout(Duration::from_secs(5))
            .connect()
            .await
            .map_err(|_| Error::Provider("journal_unavailable"))?;
        let version: i64 = sqlx::query_scalar("PRAGMA user_version")
            .fetch_one(&mut connection)
            .await
            .map_err(db_error)?;
        if version > 1 {
            return Err(Error::InvalidFormat);
        }
        let mut tx = connection
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(db_error)?;
        sqlx::query("CREATE TABLE IF NOT EXISTS delivery (id INTEGER PRIMARY KEY CHECK(id=1), state TEXT NOT NULL)").execute(&mut *tx).await.map_err(db_error)?;
        sqlx::query("INSERT OR IGNORE INTO delivery(id,state) VALUES(1,?)")
            .bind(
                serde_json::to_string(&DeliveryStatus::default())
                    .map_err(|_| Error::InvalidFormat)?,
            )
            .execute(&mut *tx)
            .await
            .map_err(db_error)?;
        sqlx::query("PRAGMA user_version=1")
            .execute(&mut *tx)
            .await
            .map_err(db_error)?;
        tx.commit().await.map_err(db_error)?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    async fn mutate<T>(&self, change: impl FnOnce(&mut DeliveryStatus) -> Result<T>) -> Result<T> {
        let mut conn = self.connection.lock().await;
        let mut tx = conn.begin_with("BEGIN IMMEDIATE").await.map_err(db_error)?;
        let bytes: String = sqlx::query_scalar("SELECT state FROM delivery WHERE id=1")
            .fetch_one(&mut *tx)
            .await
            .map_err(db_error)?;
        if bytes.len() as u64 > JSON_CAP {
            return Err(Error::SizeLimit);
        }
        let mut state: DeliveryStatus =
            serde_json::from_str(&bytes).map_err(|_| Error::InvalidFormat)?;
        // Upgrade the initial private journal representation without losing its
        // live binding. Disconnected tombstones remain distinct from initial None.
        if state.connection_generation.is_none() {
            state.connection_generation = state.binding.as_ref().map(|b| b.generation);
        }
        validate(&state)?;
        let result = change(&mut state)?;
        validate(&state)?;
        let bytes = serde_json::to_string(&state).map_err(|_| Error::InvalidFormat)?;
        if bytes.len() > JSON_CAP as usize {
            return Err(Error::SizeLimit);
        }
        sqlx::query("UPDATE delivery SET state=? WHERE id=1")
            .bind(bytes)
            .execute(&mut *tx)
            .await
            .map_err(db_error)?;
        tx.commit().await.map_err(db_error)?;
        Ok(result)
    }

    pub async fn status(&self) -> Result<DeliveryStatus> {
        self.mutate(|s| Ok(s.clone())).await
    }
    pub async fn is_current(&self, generation: Uuid) -> Result<bool> {
        Ok(self
            .status()
            .await?
            .binding
            .is_some_and(|b| b.generation == generation))
    }
    pub async fn connect(&self, binding: &Binding) -> Result<()> {
        self.connect_with_event(binding, None).await
    }
    pub async fn connect_with_event(
        &self,
        binding: &Binding,
        event: Option<CloudAuditEvent>,
    ) -> Result<()> {
        self.mutate(|s| {
            if s.binding.as_ref() == Some(binding) {
                return Ok(());
            }
            if s.connection_generation == Some(binding.generation) {
                return Err(Error::InvalidAttempt);
            }
            let outbox = std::mem::take(&mut s.outbox);
            let purges = std::mem::take(&mut s.purges);
            *s = DeliveryStatus {
                binding: Some(binding.clone()),
                connection_generation: Some(binding.generation),
                outbox,
                purges,
                ..Default::default()
            };
            if let Some(event) = event {
                append_event(s, event)?;
            }
            Ok(())
        })
        .await
    }
    pub async fn disconnect(&self, generation: Uuid) -> Result<()> {
        self.disconnect_with_event(generation, None).await
    }
    pub async fn disconnect_with_event(
        &self,
        generation: Uuid,
        event: Option<CloudAuditEvent>,
    ) -> Result<()> {
        self.mutate(|s| {
            if s.binding.is_none() {
                return Ok(());
            }
            current(s, generation)?;
            let outbox = std::mem::take(&mut s.outbox);
            let purges = std::mem::take(&mut s.purges);
            *s = DeliveryStatus {
                outbox,
                purges,
                connection_generation: Some(Uuid::new_v4()),
                ..Default::default()
            };
            if let Some(event) = event {
                append_event(s, event)?;
            }
            Ok(())
        })
        .await
    }
    pub async fn events(&self) -> Result<Vec<CloudAuditEvent>> {
        Ok(self.status().await?.outbox)
    }
    pub async fn begin_purge(
        &self,
        generation: Uuid,
        snapshot: SnapshotId,
        event: CloudAuditEvent,
    ) -> Result<PurgeIntent> {
        self.mutate(|s| {
            current(s, generation)?;
            if s.last_snapshot.is_none_or(|id| id == snapshot) {
                return Err(Error::InvalidAttempt);
            }
            if let Some(intent) = s
                .purges
                .iter()
                .find(|p| p.binding.generation == generation && p.snapshot == snapshot)
            {
                return Ok(intent.clone());
            }
            let binding = s.binding.clone().ok_or(Error::InvalidAttempt)?;
            if s.purges.len() >= 32
                || event.action != CloudAuditAction::Purge
                || event.snapshot_id != Some(snapshot)
                || event.target_id != snapshot.0
                || event.client_id != binding.client_id
                || event.account_id != binding.account_id
                || event.host_id != binding.host_id
            {
                return Err(Error::InvalidFormat);
            }
            let intent = PurgeIntent {
                binding,
                snapshot,
                event,
                marker_removed: false,
            };
            s.purges.push(intent.clone());
            Ok(intent)
        })
        .await
    }
    pub async fn marker_removed(&self, event_id: Uuid) -> Result<()> {
        self.mutate(|s| {
            let p = s
                .purges
                .iter_mut()
                .find(|p| p.event.event_id == event_id)
                .ok_or(Error::InvalidAttempt)?;
            p.marker_removed = true;
            let event = p.event.clone();
            append_event(s, event)
        })
        .await
    }
    pub async fn finish_purge(&self, event_id: Uuid) -> Result<()> {
        self.mutate(|s| {
            s.purges.retain(|p| p.event.event_id != event_id);
            Ok(())
        })
        .await
    }
    pub async fn retention_done(&self, generation: Uuid) -> Result<()> {
        self.mutate(|s| {
            current(s, generation)?;
            s.retention_due = false;
            Ok(())
        })
        .await
    }
    pub async fn retention_result(
        &self,
        generation: Uuid,
        error: Option<markiro_proto::yandex_backups::ErrorCode>,
        retry_at: i64,
    ) -> Result<()> {
        self.mutate(|s| {
            current(s, generation)?;
            s.retention_error = error;
            s.retention_retry_at = retry_at;
            Ok(())
        })
        .await
    }
    pub async fn ack_event(&self, id: Uuid) -> Result<()> {
        self.mutate(|s| {
            s.outbox.retain(|e| e.event_id != id);
            Ok(())
        })
        .await
    }
    pub async fn enqueue_latest(&self, generation: Uuid, file: &str) -> Result<()> {
        if !source_name(file) {
            return Err(Error::InvalidFormat);
        }
        self.mutate(|s| {
            current(s, generation)?;
            if s.active.as_ref().is_some_and(|j| j.source_file == file) {
                return Ok(());
            }
            s.pending = Some(file.into());
            Ok(())
        })
        .await
    }
    pub async fn retry(&self, generation: Uuid) -> Result<()> {
        self.mutate(|s| {
            current(s, generation)?;
            if let Some(job) = &mut s.active {
                job.retry_at = 0;
            }
            s.refresh_retry_at = 0;
            s.retention_retry_at = 0;
            s.retention_error = None;
            s.error = None;
            Ok(())
        })
        .await
    }
    pub async fn observe_source(&self, generation: Uuid, source: &SourceContext) -> Result<bool> {
        self.mutate(|s| {
            current(s, generation)?;
            if s.binding.as_ref().is_some_and(|b| b.source != *source) {
                s.paused = true;
                s.connection_error =
                    Some(markiro_proto::yandex_backups::ErrorCode::ClientSecretRequired);
            }
            Ok(s.paused)
        })
        .await
    }
    pub async fn refresh_result(
        &self,
        generation: Uuid,
        error: Option<markiro_proto::yandex_backups::ErrorCode>,
        retry_at: i64,
    ) -> Result<()> {
        self.mutate(|s| {
            current(s, generation)?;
            if s.paused {
                return Err(Error::InvalidAttempt);
            }
            s.connection_error = error;
            s.refresh_retry_at = retry_at;
            s.refresh_failures = if error.is_some() {
                s.refresh_failures.saturating_add(1)
            } else {
                0
            };
            Ok(())
        })
        .await
    }
    pub async fn claim(&self, generation: Uuid) -> Result<Option<Job>> {
        self.mutate(|s| {
            current(s, generation)?;
            if s.active.is_none() {
                s.active = s.pending.take().map(|file| Job {
                    snapshot_id: SnapshotId::new(),
                    source_file: file,
                    phase: Phase::Queued,
                    failures: 0,
                    retry_at: 0,
                });
            }
            Ok(s.active.clone())
        })
        .await
    }
    pub async fn advance(&self, generation: Uuid, id: SnapshotId, phase: Phase) -> Result<()> {
        self.mutate(|s| {
            current(s, generation)?;
            let job = s
                .active
                .as_mut()
                .filter(|j| j.snapshot_id == id)
                .ok_or(Error::InvalidAttempt)?;
            job.phase = phase;
            s.error = None;
            Ok(())
        })
        .await
    }
    pub async fn fail(
        &self,
        generation: Uuid,
        id: SnapshotId,
        code: &str,
        retry_at: i64,
    ) -> Result<()> {
        if !matches!(
            code,
            "network"
                | "rate_limited"
                | "quota"
                | "access_denied"
                | "reauth"
                | "identity_missing"
                | "integrity"
                | "unsupported_format"
                | "incompatible_version"
                | "local_space"
                | "remote_conflict"
                | "cancelled"
                | "client_credentials_invalid"
                | "secret_unavailable"
                | "client_secret_required"
        ) {
            return Err(Error::InvalidFormat);
        }
        self.mutate(|s| {
            current(s, generation)?;
            let job = s
                .active
                .as_mut()
                .filter(|j| j.snapshot_id == id)
                .ok_or(Error::InvalidAttempt)?;
            job.failures = job.failures.saturating_add(1);
            job.retry_at = retry_at;
            s.error = Some(code.into());
            Ok(())
        })
        .await
    }
    pub async fn reject(&self, generation: Uuid, id: SnapshotId, code: &str) -> Result<()> {
        if !matches!(
            code,
            "integrity" | "identity_missing" | "unsupported_format" | "remote_conflict"
        ) {
            return Err(Error::InvalidFormat);
        }
        self.mutate(|s| {
            current(s, generation)?;
            let job = s
                .active
                .as_ref()
                .filter(|j| j.snapshot_id == id)
                .ok_or(Error::InvalidAttempt)?;
            s.rejected_source = Some(job.source_file.clone());
            s.active = None;
            s.error = Some(code.into());
            Ok(())
        })
        .await
    }
    pub async fn confirm(
        &self,
        generation: Uuid,
        id: SnapshotId,
        upload_at: &str,
        copy_at: &str,
    ) -> Result<()> {
        self.confirm_with_event(generation, id, upload_at, copy_at, None)
            .await
    }
    pub async fn confirm_with_event(
        &self,
        generation: Uuid,
        id: SnapshotId,
        upload_at: &str,
        copy_at: &str,
        event: Option<CloudAuditEvent>,
    ) -> Result<()> {
        for at in [upload_at, copy_at] {
            time::OffsetDateTime::parse(at, &time::format_description::well_known::Rfc3339)
                .map_err(|_| Error::InvalidFormat)?;
        }
        self.mutate(|s| {
            current(s, generation)?;
            if s.last_snapshot == Some(id) {
                return Ok(());
            }
            if s.active.as_ref().is_none_or(|j| j.snapshot_id != id) {
                return Err(Error::InvalidAttempt);
            }
            s.last_snapshot = Some(id);
            s.retention_due = true;
            s.last_source_file = s.active.as_ref().map(|j| j.source_file.clone());
            s.last_upload_at = Some(upload_at.into());
            s.last_copy_at = Some(copy_at.into());
            if let Some(event) = event {
                append_event(s, event)?;
            }
            s.active = None;
            s.error = None;
            Ok(())
        })
        .await
    }
}
fn append_event(state: &mut DeliveryStatus, event: CloudAuditEvent) -> Result<()> {
    if let Some(existing) = state.outbox.iter().find(|e| e.event_id == event.event_id) {
        if existing != &event {
            return Err(Error::InvalidAttempt);
        }
        return Ok(());
    }
    if state.outbox.len() >= 32 {
        return Err(Error::SizeLimit);
    }
    state.outbox.push(event);
    Ok(())
}
fn current(state: &DeliveryStatus, generation: Uuid) -> Result<()> {
    if state
        .binding
        .as_ref()
        .is_none_or(|b| b.generation != generation)
    {
        return Err(Error::InvalidAttempt);
    }
    Ok(())
}
fn db_error(_: sqlx::Error) -> Error {
    Error::Provider("journal_unavailable")
}
