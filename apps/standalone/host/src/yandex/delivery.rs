//! Native backup adapter. Local rotation pins never span provider I/O.
use super::{
    connection::YandexService,
    queue::SourcePin,
    state::{CloudAuditAction, CloudAuditEvent, Phase, SourceContext},
};
use crate::{
    restore::{self, CopyIdentity},
    server::AppState,
};
use markiro_backup_cloud::{
    client::{DiskClient, RemoteObject, RequestGuard},
    envelope::{self, SnapshotMetadata, StagedSnapshot},
    model::{ClientProfile, NativeCopyPaths, SnapshotId},
    publication::{ObjectTransport, TransferFuture},
    Error, Result,
};
use sqlx::{ConnectOptions, Connection};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
use uuid::Uuid;

pub fn check_budget(available: u64, needed: u64) -> Result<()> {
    if needed
        .checked_add(512 * 1024 * 1024)
        .is_none_or(|budget| available < budget)
    {
        return Err(Error::Provider("local_space"));
    }
    Ok(())
}
#[cfg(unix)]
pub(crate) fn available_space(path: &Path) -> Result<u64> {
    use std::os::unix::ffi::OsStrExt;
    let path =
        std::ffi::CString::new(path.as_os_str().as_bytes()).map_err(|_| Error::InvalidFormat)?;
    let mut stat = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    // Valid NUL-terminated path and writable statvfs structure; read only on success.
    if unsafe { libc::statvfs(path.as_ptr(), stat.as_mut_ptr()) } != 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    let stat = unsafe { stat.assume_init() };
    u64::try_from(u128::from(stat.f_bavail) * u128::from(stat.f_frsize))
        .map_err(|_| Error::SizeLimit)
}
#[cfg(windows)]
pub(crate) fn available_space(path: &Path) -> Result<u64> {
    use std::os::windows::ffi::OsStrExt;
    let path: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut available = 0;
    if unsafe {
        windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW(
            path.as_ptr(),
            &mut available,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(available)
}
#[cfg(not(any(unix, windows)))]
fn available_space(_path: &Path) -> Result<u64> {
    Err(Error::SecretUnavailable)
}
pub fn workspace_bytes(size: u64, staged: bool) -> Result<u64> {
    // Stage + fresh download + native output, excluding bytes already on disk.
    size.checked_mul(if staged { 2 } else { 3 })
        .and_then(|n| n.checked_add(64 * 1024 * 1024))
        .ok_or(Error::SizeLimit)
}
fn reserve(path: &Path, size: u64, staged: bool) -> Result<()> {
    check_budget(available_space(path)?, workspace_bytes(size, staged)?)
}

pub fn clean_workspaces(root: &Path, active: Option<&str>) -> Result<()> {
    fn uuid(value: &str) -> bool {
        Uuid::parse_str(value).is_ok_and(|id| id.to_string() == value)
    }
    fn owned(name: &str) -> bool {
        if let Some(id) = name.strip_prefix("verify-") {
            return uuid(id);
        }
        let Some(name) = name.strip_prefix("snapshot-") else {
            return false;
        };
        let (base, partial) = name
            .split_once(".partial-")
            .map_or((name, None), |(base, id)| (base, Some(id)));
        base.len() == 73
            && base.is_ascii()
            && base.as_bytes().get(36) == Some(&b'-')
            && uuid(&base[..36])
            && uuid(&base[37..])
            && partial.is_none_or(uuid)
    }
    for entry in std::fs::read_dir(root)? {
        let entry = entry?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if active == Some(name) || !owned(name) || !entry.file_type()?.is_dir() {
            continue;
        }
        std::fs::remove_dir_all(entry.path())?;
    }
    Ok(())
}

pub async fn verify_native(paths: NativeCopyPaths) -> Result<()> {
    let native =
        crate::backup::copy::read_manifest(&paths.database).map_err(|_| Error::Integrity)?;
    if native.schema_version
        > crate::db::MIGRATOR
            .iter()
            .map(|m| m.version)
            .max()
            .unwrap_or(0)
    {
        return Err(Error::Provider("incompatible_version"));
    }
    let copy = restore::verify_copy(&paths.database, false)
        .await
        .map_err(|_| Error::Integrity)?;
    if !matches!(copy.identity, CopyIdentity::Present(_)) {
        return Err(Error::Provider("identity_missing"));
    }
    Ok(())
}

pub async fn stage_native(
    source: NativeCopyPaths,
    profile: ClientProfile,
    stage: PathBuf,
    id: SnapshotId,
    pin: Option<SourcePin>,
    expected: Option<SourceContext>,
) -> Result<StagedSnapshot> {
    reserve(
        stage.parent().ok_or(Error::InvalidFormat)?,
        std::fs::metadata(&source.database)?.len(),
        false,
    )?;
    verify_native(source.clone()).await?;
    let mut conn = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(&source.database)
        .read_only(true)
        .immutable(true)
        .connect()
        .await
        .map_err(|_| Error::Integrity)?;
    let actual = SourceContext::read(&mut conn)
        .await
        .map_err(|_| Error::Integrity)?;
    if expected.is_some_and(|source| source != actual) {
        return Err(Error::Provider("source_mismatch"));
    }
    let organization: Option<(String, Option<String>)> =
        sqlx::query_as("SELECT name,inn FROM org_profile WHERE id=1")
            .fetch_optional(&mut conn)
            .await
            .map_err(|_| Error::Integrity)?;
    conn.close().await.map_err(|_| Error::Integrity)?;
    let (organization_label, inn) = organization.unwrap_or_default();
    let metadata = SnapshotMetadata {
        app_version: env!("CARGO_PKG_VERSION").into(),
        organization_label,
        inn: inn.unwrap_or_default(),
    };
    // A cancelled caller cannot release the pin while the blocking age writer
    // still reads the source. Errors leave the queue's own pin for retry.
    tokio::task::spawn_blocking(move || {
        let _pin = pin;
        let partial = stage.with_extension(format!("partial-{}", Uuid::new_v4()));
        let mut staged =
            envelope::seal_copy_with_metadata(&source, &profile, &partial, id, metadata)?;
        if let Err(error) = std::fs::rename(&partial, &stage) {
            let _ = std::fs::remove_dir_all(partial);
            return Err(error.into());
        }
        staged.dir = stage;
        Ok(staged)
    })
    .await
    .map_err(|_| Error::Integrity)?
}

struct Guard {
    state: AppState,
    service: Arc<YandexService>,
    generation: Uuid,
}
impl RequestGuard for Guard {
    fn check(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<()>> + Send + '_>> {
        Box::pin(async move {
            if *self.state.stopping.borrow()
                || !self.service.journal.is_current(self.generation).await?
            {
                return Err(Error::InvalidAttempt);
            }
            let source = {
                let mut conn = self
                    .state
                    .pool
                    .acquire()
                    .await
                    .map_err(|_| Error::Network)?;
                SourceContext::read(&mut conn)
                    .await
                    .map_err(|_| Error::Integrity)?
            };
            if self
                .service
                .journal
                .observe_source(self.generation, &source)
                .await?
            {
                return Err(Error::InvalidAttempt);
            }
            Ok(())
        })
    }
}
struct Remote {
    client: DiskClient,
    host: Uuid,
    snapshot: Uuid,
}
impl ObjectTransport for Remote {
    fn put<'a>(&'a self, name: &'a str, source: &'a Path) -> TransferFuture<'a> {
        Box::pin(async move {
            self.client
                .put_new(&RemoteObject::new(self.host, self.snapshot, name)?, source)
                .await
        })
    }
    fn get<'a>(&'a self, name: &'a str, target: &'a Path) -> TransferFuture<'a> {
        Box::pin(async move {
            self.client
                .get_stream(&RemoteObject::new(self.host, self.snapshot, name)?, target)
                .await
        })
    }
}

pub async fn tick(state: &AppState, service: &Arc<YandexService>) -> Result<()> {
    let status = service.journal.status().await?;
    let Some(binding) = status.binding else {
        return Ok(());
    };
    let generation = binding.generation;
    let guard = Arc::new(Guard {
        state: state.clone(),
        service: service.clone(),
        generation,
    });
    guard.check().await?;
    let now = state.now().unix_timestamp();
    if status.paused
        || super::runtime::require_refresh_allowed(status.connection_error).is_err()
        || status.refresh_retry_at > now
    {
        return Ok(());
    }
    if status.active.as_ref().is_some_and(|j| j.retry_at > now) {
        return Ok(());
    }
    let Some((job, pin)) = service.queue.claim(generation).await? else {
        return Ok(());
    };
    let result = async {
        let credentials = service
            .tokens
            .current_credentials()
            .await?
            .ok_or(Error::SecretUnavailable)?;
        if credentials.generation != generation {
            return Err(Error::InvalidAttempt);
        }
        let staged_dir = service
            .private_dir
            .join(format!("snapshot-{generation}-{}", job.snapshot_id.0));
        service
            .journal
            .advance(generation, job.snapshot_id, Phase::Staging)
            .await?;
        let staged = if staged_dir.exists() {
            let complete = envelope::read_complete(&staged_dir, &binding.client_id)?;
            if complete.snapshot_id != job.snapshot_id || complete.host_id != binding.host_id {
                return Err(Error::Integrity);
            }
            drop(pin);
            StagedSnapshot {
                dir: staged_dir.clone(),
                complete,
            }
        } else {
            let backups = state.backups.as_ref().ok_or(Error::InvalidFormat)?;
            stage_native(
                NativeCopyPaths::beside(backups.local_dir.join(&job.source_file)),
                credentials.profile.clone(),
                staged_dir.clone(),
                job.snapshot_id,
                Some(pin),
                Some(binding.source.clone()),
            )
            .await?
        };
        service.queue.staged(&job.source_file).await;
        guard.check().await?;
        let client = DiskClient::new(credentials.tokens.access)?.with_guard(guard.clone());
        client
            .ensure_snapshot_dir(binding.host_id, job.snapshot_id.0)
            .await?;
        service
            .journal
            .advance(generation, job.snapshot_id, Phase::Uploading)
            .await?;
        let remote = Remote {
            client,
            host: binding.host_id,
            snapshot: job.snapshot_id.0,
        };
        let verify_dir = service
            .private_dir
            .join(format!("verify-{}", Uuid::new_v4()));
        reserve(
            &service.private_dir,
            staged
                .complete
                .objects
                .get("database.age")
                .ok_or(Error::InvalidFormat)?
                .size_bytes,
            true,
        )?;
        markiro_backup_cloud::publication::publish(
            &remote,
            &staged,
            &binding.client_id,
            &verify_dir,
            |paths| async {
                service
                    .journal
                    .advance(generation, job.snapshot_id, Phase::Verifying)
                    .await?;
                verify_native(paths).await?;
                guard.check().await?;
                service
                    .journal
                    .advance(generation, job.snapshot_id, Phase::Publishing)
                    .await
            },
        )
        .await?;
        guard.check().await?;
        let at = state.timestamp();
        let event = CloudAuditEvent {
            event_id: job.snapshot_id.0,
            at: at.clone(),
            actor_user_id: None,
            action: CloudAuditAction::Upload,
            target_id: job.snapshot_id.0,
            client_id: binding.client_id.clone(),
            account_id: binding.account_id.clone(),
            host_id: binding.host_id,
            snapshot_id: Some(job.snapshot_id),
        };
        service
            .journal
            .confirm_with_event(
                generation,
                job.snapshot_id,
                &at,
                &staged.complete.created_at,
                Some(event),
            )
            .await?;
        super::audit_outbox::flush_events(&state.pool, &service.journal).await?;
        let _ = tokio::fs::remove_dir_all(staged_dir).await;
        Ok(())
    }
    .await;
    if let Err(error) = result {
        if matches!(error, Error::InvalidAttempt) {
            return Ok(());
        }
        if matches!(
            error,
            Error::Integrity
                | Error::Crypto
                | Error::InvalidFormat
                | Error::SizeLimit
                | Error::Provider("identity_missing" | "source_mismatch" | "remote_conflict")
        ) || matches!(&error,Error::Io(e) if e.kind()==std::io::ErrorKind::NotFound)
        {
            let code = if matches!(error, Error::Provider("remote_conflict")) {
                "remote_conflict"
            } else if matches!(error, Error::Provider("identity_missing")) {
                "identity_missing"
            } else {
                "integrity"
            };
            service
                .journal
                .reject(generation, job.snapshot_id, code)
                .await?;
            service.queue.staged(&job.source_file).await;
            return Ok(());
        }
        let code = super::connection::error_code(&error);
        let seconds = match &error {
            Error::RetryAfter { seconds, .. } => *seconds,
            _ => [30u64, 120, 600, 3600][(job.failures as usize).min(3)],
        };
        let retry_at = state
            .now()
            .unix_timestamp()
            .saturating_add(i64::try_from(seconds).unwrap_or(i64::MAX))
            .min(253402300799);
        let code = match code {
            markiro_proto::yandex_backups::ErrorCode::RateLimited => "rate_limited",
            markiro_proto::yandex_backups::ErrorCode::IntegrityFailed => "integrity",
            markiro_proto::yandex_backups::ErrorCode::IdentityMissing => "identity_missing",
            markiro_proto::yandex_backups::ErrorCode::AccessDenied => "access_denied",
            markiro_proto::yandex_backups::ErrorCode::QuotaExceeded => "quota",
            markiro_proto::yandex_backups::ErrorCode::ReauthRequired => "reauth",
            markiro_proto::yandex_backups::ErrorCode::RemoteConflict => "remote_conflict",
            markiro_proto::yandex_backups::ErrorCode::LocalSpace => "local_space",
            _ => "network",
        };
        match service
            .journal
            .fail(generation, job.snapshot_id, code, retry_at)
            .await
        {
            Ok(()) | Err(Error::InvalidAttempt) => {}
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

pub async fn run(
    state: AppState,
    service: Arc<YandexService>,
    mut stopping: tokio::sync::watch::Receiver<bool>,
) {
    loop {
        if *stopping.borrow() {
            break;
        }
        let pass = async {
            // Reconcile an existing native copy after installation/reconnect;
            // ordinary successful copies are offered by the local producer.
            let status = service.journal.status().await?;
            let active =
                status
                    .binding
                    .as_ref()
                    .zip(status.active.as_ref())
                    .map(|(binding, job)| {
                        format!("snapshot-{}-{}", binding.generation, job.snapshot_id.0)
                    });
            let root = service.private_dir.clone();
            tokio::task::spawn_blocking(move || clean_workspaces(&root, active.as_deref()))
                .await
                .map_err(|_| Error::Integrity)??;
            if status.binding.is_some()
                && !status.paused
                && status.active.is_none()
                && status.pending.is_none()
            {
                if let Some(backups) = &state.backups {
                    let dir = backups.local_dir.clone();
                    let latest =
                        tokio::task::spawn_blocking(move || crate::backup::folder::list(&dir))
                            .await
                            .map_err(|_| Error::Integrity)??;
                    if let Some(copy) = latest.first() {
                        service.queue.offer(&copy.file).await?;
                    }
                }
            }
            tick(&state, &service).await?;
            retention_tick(&state, &service).await
        };
        tokio::select! {result=pass=>if result.is_err(){tracing::warn!("Yandex backup delivery pass failed");},_=stopping.wait_for(|s|*s)=>break}
        tokio::select! {_=tokio::time::sleep(std::time::Duration::from_secs(30))=>{},_=service.wake.notified()=>{},_=stopping.wait_for(|s|*s)=>break}
    }
}

struct RetentionRemote {
    client: DiskClient,
    binding: super::state::Binding,
    workspace: PathBuf,
}
impl super::retention::Remote for RetentionRemote {
    fn copies(
        &self,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<Vec<super::retention::CopyStamp>>> + Send + '_>,
    > {
        Box::pin(async {
            let copies = markiro_backup_cloud::catalog::list(
                &self.client,
                &self.binding.client_id,
                Some(self.binding.host_id),
                &self.workspace,
            )
            .await?;
            copies
                .into_iter()
                .map(|c| {
                    Ok(super::retention::CopyStamp {
                        host_id: c.host_id,
                        id: c.snapshot_id,
                        at: crate::clock::parse_timestamp(&c.created_at)
                            .map_err(|_| Error::InvalidFormat)?,
                    })
                })
                .collect()
        })
    }
    fn delete<'a>(
        &'a self,
        id: SnapshotId,
        name: &'a str,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<()>> + Send + 'a>> {
        Box::pin(async move {
            self.client
                .delete_owned(
                    &RemoteObject::new(self.binding.host_id, id.0, name)?,
                    self.binding.host_id,
                )
                .await
        })
    }
}
async fn retention_tick(state: &AppState, service: &Arc<YandexService>) -> Result<()> {
    let status = service.journal.status().await?;
    if !status.retention_due || status.paused {
        return Ok(());
    }
    let Some(binding) = status.binding else {
        return Ok(());
    };
    let guard = Arc::new(Guard {
        state: state.clone(),
        service: service.clone(),
        generation: binding.generation,
    });
    guard.check().await?;
    let credentials = service
        .tokens
        .current_credentials()
        .await?
        .ok_or(Error::SecretUnavailable)?;
    if credentials.generation != binding.generation {
        return Err(Error::InvalidAttempt);
    }
    let remote = RetentionRemote {
        client: DiskClient::new(credentials.tokens.access)?.with_guard(guard),
        binding: binding.clone(),
        workspace: service
            .private_dir
            .join(format!("verify-{}", Uuid::new_v4())),
    };
    super::retention::rotate_due(&remote, &service.journal, &binding, || state.now()).await?;
    super::audit_outbox::flush_events(&state.pool, &service.journal).await
}
