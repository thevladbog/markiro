//! Process log: daily-rotated files under `logs/` (14 kept), plus stdout for
//! console runs. Never log device keys, session tokens, pairing codes,
//! passwords, PINs, hashes or the TLS private key.

use std::path::Path;

use tracing_appender::non_blocking::WorkerGuard;
use tracing_appender::rolling::{Builder, Rotation};
use tracing_subscriber::filter::LevelFilter;
use tracing_subscriber::prelude::*;

pub fn init(logs_dir: &Path, also_stdout: bool) -> Result<WorkerGuard, crate::BoxError> {
    let appender = Builder::new()
        .rotation(Rotation::DAILY)
        .filename_prefix("host")
        .filename_suffix("log")
        .max_log_files(14)
        .build(logs_dir)?;
    let (file_writer, guard) = tracing_appender::non_blocking(appender);
    let file_layer = tracing_subscriber::fmt::layer()
        .with_ansi(false)
        .with_writer(file_writer);
    let stdout_layer = also_stdout.then(tracing_subscriber::fmt::layer);
    tracing_subscriber::registry()
        .with(LevelFilter::INFO)
        .with(file_layer)
        .with(stdout_layer)
        .try_init()?;
    Ok(guard)
}
