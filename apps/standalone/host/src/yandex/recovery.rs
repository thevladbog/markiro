//! Elevated helper: fixed installed target, full re-verification, empty-only swap.
use crate::{config::HostPaths, BoxError};
use std::path::Path;
#[cfg(any(windows, test))]
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Job {
    workspace: uuid::Uuid,
    file: String,
    sha: String,
    at: String,
    complete: bool,
    snapshot: uuid::Uuid,
}
#[cfg(windows)]
fn save_job(paths: &HostPaths, job: &Job) -> Result<(), BoxError> {
    use std::io::Write;
    let temp = paths.data_dir.join("yandex-recovery-job.partial");
    let _ = std::fs::remove_file(&temp);
    let mut file = markiro_backup_cloud::envelope::private_file(&temp)?;
    file.write_all(&serde_json::to_vec(job)?)?;
    file.sync_all()?;
    drop(file);
    // MoveFileEx provides atomic replacement on Windows as in the credential store.
    use std::os::windows::ffi::OsStrExt;
    let target = paths.data_dir.join("yandex-recovery-job.json");
    let wide = |p: &Path| {
        p.as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>()
    };
    let from = wide(&temp);
    let to = wide(&target);
    if unsafe {
        windows_sys::Win32::Storage::FileSystem::MoveFileExW(from.as_ptr(), to.as_ptr(), 9)
    } == 0
    {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(())
}
#[cfg(windows)]
fn execute(paths: &HostPaths, mut job: Job) -> Result<(), BoxError> {
    use crate::install::Services;
    if !super::state::source_name(&job.file) || job.sha.len() != 64 {
        return Err("invalid_recovery_job".into());
    }
    let source = paths
        .data_dir
        .join(format!("recovery-helper-{}", job.workspace))
        .join("native")
        .join(&job.file);
    let mut services = crate::install_windows::WindowsServices::connect()?;
    crate::install::stop(&mut services, &mut std::thread::sleep)?;
    let runtime = tokio::runtime::Runtime::new()?;
    let result = runtime.block_on(async {
        if crate::restore::resume_empty_with_receipt(paths, &job.sha, &job.at).await? {
            return Ok::<(), BoxError>(());
        }
        let copy = crate::restore::verify_copy(&source, false).await?;
        if copy.sha256 != job.sha {
            return Err("invalid_recovery_job".into());
        }
        crate::restore::restore_empty_with(paths, &source, crate::clock::parse_timestamp(&job.at)?)
            .await?;
        Ok(())
    });
    if result.is_ok() {
        use sqlx::ConnectOptions;
        runtime.block_on(async{let mut conn=sqlx::sqlite::SqliteConnectOptions::new().filename(paths.database_file()).connect().await?;sqlx::query("UPDATE audit_log SET details=json_set(details,'$.source','yandex_disk','$.snapshotId',?) WHERE action='host.restore' AND at=? AND json_extract(details,'$.sha256')=?").bind(job.snapshot.to_string()).bind(&job.at).bind(&job.sha).execute(&mut conn).await?;Ok::<(),BoxError>(())})?;
        job.complete = true;
        save_job(paths, &job)?;
        let _ = std::fs::remove_dir_all(
            paths
                .data_dir
                .join(format!("recovery-helper-{}", job.workspace)),
        );
    }
    let started = services.start();
    crate::shutdown_runtime(runtime);
    result?;
    started?;
    Ok(())
}
#[cfg(windows)]
fn exclusive(paths: &HostPaths) -> Result<std::fs::File, BoxError> {
    use std::os::windows::fs::OpenOptionsExt;
    Ok(std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .share_mode(0)
        .open(paths.data_dir.join("yandex-recovery.lock"))?)
}
#[cfg(windows)]
pub fn resume() -> Result<(), BoxError> {
    let binary = std::env::current_exe()?;
    let role: serde_json::Value = serde_json::from_slice(&std::fs::read(
        binary
            .parent()
            .ok_or("installation_missing")?
            .join("installation.json"),
    )?)?;
    if role.get("role").and_then(|v| v.as_str()) != Some("host") {
        return Err("host_role_required".into());
    }
    let paths = HostPaths::new(HostPaths::default_data_dir());
    let _exclusive = exclusive(&paths)?;
    let job: Job = serde_json::from_slice(&markiro_backup_cloud::envelope::read_bounded(
        &paths.data_dir.join("yandex-recovery-job.json"),
        65536,
    )?)?;
    require_unfinished(&job)?;
    execute(&paths, job)
}
#[cfg(not(windows))]
pub fn resume() -> Result<(), BoxError> {
    Err("unsupported".into())
}
#[cfg(windows)]
pub fn run(stage: &Path) -> Result<(), BoxError> {
    let binary = std::env::current_exe()?;
    let installed = binary.parent().ok_or("installation_missing")?;
    let role: serde_json::Value =
        serde_json::from_slice(&std::fs::read(installed.join("installation.json"))?)?;
    if role.get("role").and_then(|v| v.as_str()) != Some("host") {
        return Err("host_role_required".into());
    }
    let stage = std::fs::canonicalize(stage)?;
    let profile = markiro_backup_cloud::model::ClientProfile::from_bytes(
        &markiro_backup_cloud::envelope::read_bounded(&stage.join("profile.json"), 65536)?,
    )?;
    let paths = HostPaths::new(HostPaths::default_data_dir());
    let _exclusive = exclusive(&paths)?;
    let runtime = tokio::runtime::Runtime::new()?;
    let complete = markiro_backup_cloud::envelope::read_complete(
        &stage.join("downloaded"),
        &profile.client_id,
    )?;
    let total = complete
        .objects
        .values()
        .try_fold(0u64, |sum, o| sum.checked_add(o.size_bytes))
        .ok_or("size_limit")?;
    super::delivery::check_budget(
        super::delivery::available_space(&paths.data_dir)?,
        total.checked_mul(3).ok_or("size_limit")?,
    )?;
    let workspace_id = uuid::Uuid::new_v4();
    let workspace = paths
        .data_dir
        .join(format!("recovery-helper-{workspace_id}"));
    markiro_backup_cloud::envelope::private_dir(&workspace)?;
    struct Cleanup(std::path::PathBuf);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    let cleanup = Cleanup(workspace.clone());
    let encrypted = workspace.join("downloaded");
    markiro_backup_cloud::envelope::private_dir(&encrypted)?;
    for name in std::iter::once("complete.json").chain(markiro_backup_cloud::model::OBJECTS) {
        let input = stage.join("downloaded").join(name);
        let cap = if name == "complete.json" {
            65536
        } else {
            complete
                .objects
                .get(name)
                .ok_or("invalid_format")?
                .size_bytes
        };
        use std::io::{Read, Write};
        let mut from = std::fs::File::open(input)?.take(cap + 1);
        let mut to = markiro_backup_cloud::envelope::private_file(&encrypted.join(name))?;
        let copied = std::io::copy(&mut from, &mut to)?;
        if copied > cap {
            return Err("size_limit".into());
        }
        to.flush()?;
        to.sync_all()?;
    }
    let output = workspace.join("native");
    let native =
        markiro_backup_cloud::envelope::open_copy(&encrypted, &profile.client_id, &output)?;
    runtime.block_on(super::delivery::verify_native(native.clone()))?;
    runtime.block_on(crate::restore::require_empty_target(&paths))?;
    let copy = runtime.block_on(crate::restore::verify_copy(&native.database, false))?;
    let job = Job {
        workspace: workspace_id,
        file: native
            .database
            .file_name()
            .ok_or("invalid_source")?
            .to_str()
            .ok_or("invalid_source")?
            .into(),
        sha: copy.sha256.clone(),
        at: crate::clock::format_timestamp(time::OffsetDateTime::now_utc()),
        complete: false,
        snapshot: complete.snapshot_id.0,
    };
    save_job(&paths, &job)?;
    std::mem::forget(cleanup);
    crate::shutdown_runtime(runtime);
    execute(&paths, job)
}
#[cfg(not(windows))]
pub fn run(_stage: &Path) -> Result<(), BoxError> {
    let _ = HostPaths::default_data_dir();
    Err("unsupported".into())
}

#[cfg(any(windows, test))]
fn require_unfinished(job: &Job) -> Result<(), BoxError> {
    if job.complete {
        return Err("recovery_already_complete".into());
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn completed_jobs_cannot_restart_services_or_trigger_repairing() {
        let mut job = Job {
            workspace: uuid::Uuid::new_v4(),
            file: String::new(),
            sha: String::new(),
            at: String::new(),
            complete: false,
            snapshot: uuid::Uuid::new_v4(),
        };
        assert!(require_unfinished(&job).is_ok());
        job.complete = true;
        assert_eq!(
            require_unfinished(&job).unwrap_err().to_string(),
            "recovery_already_complete"
        );
    }
}
