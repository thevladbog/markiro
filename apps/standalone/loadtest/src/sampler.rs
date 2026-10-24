//! The host's vital signs over the run, one sample every few seconds: its
//! memory and descriptors (a host the harness started, or one whose pid it
//! was given), the size of the database and of its write-ahead log, and the
//! log's backlog of frames no checkpoint has copied yet.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::sync::watch;

use crate::procstat;
use crate::wal;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sample {
    pub t_s: f64,
    pub rss_bytes: Option<u64>,
    pub fds: Option<u64>,
    pub db_bytes: Option<u64>,
    pub wal_bytes: Option<u64>,
    pub wal_backlog_frames: Option<u64>,
}

fn size(path: &Path) -> Option<u64> {
    std::fs::metadata(path).ok().map(|meta| meta.len())
}

/// A sample now. The backlog is read twice at most: a torn read is read again.
pub fn take(t_s: f64, data_dir: Option<&Path>, pid: Option<u32>) -> Sample {
    let process = pid.and_then(procstat::sample);
    let (db_bytes, wal_bytes, backlog) = match data_dir {
        Some(dir) => {
            let db = dir.join("host.db");
            let shm = dir.join("host.db-shm");
            let read = || {
                std::fs::read(&shm)
                    .ok()
                    .and_then(|bytes| wal::backlog(&bytes))
            };
            (
                size(&db),
                size(&dir.join("host.db-wal")),
                read().or_else(read),
            )
        }
        None => (None, None, None),
    };
    Sample {
        t_s,
        rss_bytes: process.map(|sample| sample.rss_bytes),
        fds: process.map(|sample| sample.fds),
        db_bytes,
        wal_bytes,
        wal_backlog_frames: backlog,
    }
}

/// Sample every `every` until `stop` turns true; the first sample is taken at
/// once and the last after the stop, so a series always has both ends.
pub async fn run(
    data_dir: Option<PathBuf>,
    pid: Option<u32>,
    every: Duration,
    mut stop: watch::Receiver<bool>,
) -> Vec<Sample> {
    let started = Instant::now();
    let mut series = Vec::new();
    loop {
        let (dir, at) = (data_dir.clone(), started.elapsed().as_secs_f64());
        // `ps`, `lsof` and a file read block a little: not on the async threads.
        if let Ok(sample) = tokio::task::spawn_blocking(move || take(at, dir.as_deref(), pid)).await
        {
            series.push(sample);
        }
        tokio::select! {
            _ = tokio::time::sleep(every) => {}
            _ = stop.changed() => break,
        }
        if *stop.borrow() {
            break;
        }
    }
    let (dir, at) = (data_dir, started.elapsed().as_secs_f64());
    if let Ok(sample) = tokio::task::spawn_blocking(move || take(at, dir.as_deref(), pid)).await {
        series.push(sample);
    }
    series
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_sample_of_a_folder_reads_sizes_and_the_backlog() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("host.db"), vec![0u8; 4096]).unwrap();
        std::fs::write(dir.path().join("host.db-wal"), vec![0u8; 8192]).unwrap();
        let mut shm = vec![0u8; 136];
        shm[12] = 1;
        shm[16..20].copy_from_slice(&30u32.to_ne_bytes());
        let copy: Vec<u8> = shm[..48].to_vec();
        shm[48..96].copy_from_slice(&copy);
        shm[96..100].copy_from_slice(&10u32.to_ne_bytes());
        std::fs::write(dir.path().join("host.db-shm"), shm).unwrap();
        let sample = take(1.5, Some(dir.path()), None);
        assert_eq!(
            (sample.db_bytes, sample.wal_bytes, sample.wal_backlog_frames),
            (Some(4096), Some(8192), Some(20))
        );
        assert_eq!((sample.rss_bytes, sample.fds), (None, None));
    }

    #[tokio::test]
    async fn the_series_has_both_ends_and_stops_on_request() {
        let (stop, watching) = watch::channel(false);
        let task = tokio::spawn(run(None, None, Duration::from_millis(20), watching));
        tokio::time::sleep(Duration::from_millis(70)).await;
        stop.send_replace(true);
        let series = task.await.unwrap();
        assert!(series.len() >= 3, "{}", series.len());
        assert!(series.windows(2).all(|pair| pair[0].t_s <= pair[1].t_s));
    }
}
