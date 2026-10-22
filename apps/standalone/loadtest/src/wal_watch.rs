//! A fine observer of SQLite's write-ahead log, from outside and from files only (plan
//! `2026-10-22-multi-station-load-test-scenarios.md`, E10): the log's header (`host.db-wal`, big
//! endian: its page size, and its checkpoint sequence, which goes up each time the log starts
//! again from its beginning) and the wal-index (`host.db-shm`, native order: the last frame
//! written, the frames a checkpoint copied, the frames a checkpoint set out to copy), every
//! 100 ms. It says how close to SQLite's automatic checkpoint the backlog sits, how often the
//! log restarts and how large its file grows. It never checkpoints: a read-only connection
//! cannot, and a checkpoint writes the database file, which the harness never does.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::sync::watch;

/// SQLite runs a checkpoint after a commit leaves this many frames or more in the log
/// (`wal_autocheckpoint`'s default; the host sets no other, `host/src/db.rs`).
pub const AUTOCHECKPOINT_FRAMES: u64 = 1000;
/// How often the run samples the log.
pub const EVERY: Duration = Duration::from_millis(100);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WalHeader {
    pub page_size: u32,
    pub checkpoint_seq: u32,
}

/// The first 32 bytes of `host.db-wal`: magic, version, page size, checkpoint sequence, salts.
pub fn wal_header(bytes: &[u8]) -> Option<WalHeader> {
    if bytes.len() < 32 {
        return None;
    }
    let word = |at: usize| u32::from_be_bytes(bytes[at..at + 4].try_into().expect("four bytes"));
    if !matches!(word(0), 0x377f_0682 | 0x377f_0683) {
        return None;
    }
    Some(WalHeader {
        page_size: word(8),
        checkpoint_seq: word(12),
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ShmPoint {
    pub mx_frame: u32,
    pub backfill: u32,
    pub backfill_attempted: u32,
}

impl ShmPoint {
    /// Frames written that no checkpoint has copied yet.
    pub fn backlog(&self) -> u64 {
        u64::from(self.mx_frame.saturating_sub(self.backfill))
    }
}

/// The wal-index header (`mxFrame` at 16, written twice) and the checkpoint info (`nBackfill`
/// at 96, `nBackfillAttempted` at 128); a torn, short or unset header is no point.
pub fn shm_point(bytes: &[u8]) -> Option<ShmPoint> {
    if bytes.len() < 132 || bytes[12] == 0 || bytes[..48] != bytes[48..96] {
        return None;
    }
    let word = |at: usize| u32::from_ne_bytes(bytes[at..at + 4].try_into().expect("four bytes"));
    Some(ShmPoint {
        mx_frame: word(16),
        backfill: word(96),
        backfill_attempted: word(128),
    })
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Point {
    pub t_s: f64,
    pub wal_bytes: Option<u64>,
    pub header: Option<WalHeader>,
    pub shm: Option<ShmPoint>,
}

fn head(path: &Path, n: usize) -> Option<Vec<u8>> {
    let mut file = std::fs::File::open(path).ok()?;
    let mut bytes = vec![0u8; n];
    file.read_exact(&mut bytes).ok()?;
    Some(bytes)
}

/// One sample of the data folder `dir`; the wal-index is read twice at most.
pub fn read_point(t_s: f64, dir: &Path) -> Point {
    let wal = dir.join("host.db-wal");
    let shm = dir.join("host.db-shm");
    let read_shm = || std::fs::read(&shm).ok().and_then(|bytes| shm_point(&bytes));
    Point {
        t_s,
        wal_bytes: std::fs::metadata(&wal).ok().map(|meta| meta.len()),
        header: head(&wal, 32).and_then(|bytes| wal_header(&bytes)),
        shm: read_shm().or_else(read_shm),
    }
}

/// Sample `dir` every `every` until `stop` turns true.
pub async fn run(dir: PathBuf, every: Duration, mut stop: watch::Receiver<bool>) -> Vec<Point> {
    let started = Instant::now();
    let mut points = Vec::new();
    loop {
        let (path, at) = (dir.clone(), started.elapsed().as_secs_f64());
        if let Ok(point) = tokio::task::spawn_blocking(move || read_point(at, &path)).await {
            points.push(point);
        }
        tokio::select! {
            _ = tokio::time::sleep(every) => {}
            _ = stop.changed() => break,
        }
        if *stop.borrow() {
            break;
        }
    }
    points
}

/// What the samples say, with plain findings; nothing here is a threshold.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WalWatch {
    pub every_ms: u64,
    pub points: usize,
    pub readable_points: usize,
    pub duration_s: f64,
    pub page_size: Option<u32>,
    /// The highest frame the log reached before it started again.
    pub frames_max: Option<u64>,
    pub backlog_p50: Option<u64>,
    pub backlog_p90: Option<u64>,
    pub backlog_p99: Option<u64>,
    pub backlog_max: Option<u64>,
    /// Samples whose backlog was above the automatic checkpoint's trigger, as a share.
    pub share_over_autocheckpoint: Option<f64>,
    /// Times the log started again from its beginning (its checkpoint sequence went up).
    pub restarts: u64,
    /// The longest stretch between two observed restarts (or an end of the watch), in seconds.
    pub longest_without_restart_s: f64,
    /// Samples that caught a checkpoint which had not reached the end it set out for.
    pub checkpoint_short_points: u64,
    pub wal_file_max_bytes: Option<u64>,
    /// The file's largest size in frames: (bytes - 32) / (page size + 24).
    pub wal_file_max_frames: Option<u64>,
    pub findings: Vec<String>,
}

fn quantile(sorted: &[u64], q: f64) -> Option<u64> {
    (!sorted.is_empty())
        .then(|| sorted[((sorted.len() as f64 * q).ceil() as usize).clamp(1, sorted.len()) - 1])
}

pub fn summarize(points: &[Point], every_ms: u64) -> WalWatch {
    let readable: Vec<ShmPoint> = points.iter().filter_map(|point| point.shm).collect();
    let mut backlog: Vec<u64> = readable.iter().map(ShmPoint::backlog).collect();
    backlog.sort_unstable();
    let page_size = points
        .iter()
        .rev()
        .find_map(|point| point.header.map(|header| header.page_size));
    let mut restarts = 0u64;
    let first = points.first().map_or(0.0, |point| point.t_s);
    let last = points.last().map_or(0.0, |point| point.t_s);
    let mut marks = vec![first];
    let mut previous: Option<u32> = None;
    for point in points {
        if let Some(header) = point.header {
            if let Some(seen) = previous {
                if header.checkpoint_seq > seen {
                    restarts += u64::from(header.checkpoint_seq - seen);
                    marks.push(point.t_s);
                }
            }
            previous = Some(header.checkpoint_seq);
        }
    }
    marks.push(last);
    let longest = marks
        .windows(2)
        .map(|pair| pair[1] - pair[0])
        .fold(0.0_f64, f64::max);
    let wal_file_max_bytes = points.iter().filter_map(|point| point.wal_bytes).max();
    let over = backlog
        .iter()
        .filter(|frames| **frames > AUTOCHECKPOINT_FRAMES)
        .count();
    let mut watch = WalWatch {
        every_ms,
        points: points.len(),
        readable_points: readable.len(),
        duration_s: last - first,
        page_size,
        frames_max: readable.iter().map(|shm| u64::from(shm.mx_frame)).max(),
        backlog_p50: quantile(&backlog, 0.5),
        backlog_p90: quantile(&backlog, 0.9),
        backlog_p99: quantile(&backlog, 0.99),
        backlog_max: backlog.last().copied(),
        share_over_autocheckpoint: (!backlog.is_empty())
            .then(|| over as f64 / backlog.len() as f64),
        restarts,
        longest_without_restart_s: longest,
        checkpoint_short_points: readable
            .iter()
            .filter(|shm| shm.backfill_attempted > shm.backfill)
            .count() as u64,
        wal_file_max_bytes,
        wal_file_max_frames: match (wal_file_max_bytes, page_size) {
            (Some(bytes), Some(page)) if page > 0 => {
                Some(bytes.saturating_sub(32) / (u64::from(page) + 24))
            }
            _ => None,
        },
        findings: Vec::new(),
    };
    watch.findings = findings(&watch);
    watch
}

/// The summary in plain sentences: what was seen, not what it should be.
pub fn findings(watch: &WalWatch) -> Vec<String> {
    let mut found = Vec::new();
    if watch.readable_points == 0 {
        found.push(
            "the wal-index was never readable: nothing is known of the checkpoints".to_owned(),
        );
        return found;
    }
    found.push(format!(
        "{} of {} samples (every {} ms over {:.0} s) read the wal-index",
        watch.readable_points, watch.points, watch.every_ms, watch.duration_s
    ));
    if let (Some(p50), Some(p99), Some(max)) =
        (watch.backlog_p50, watch.backlog_p99, watch.backlog_max)
    {
        found.push(format!(
            "backlog (frames written, not yet copied by a checkpoint): p50 {p50}, p99 {p99}, max {max}; \
             SQLite checkpoints after a commit leaves {AUTOCHECKPOINT_FRAMES} frames or more; \
             {:.1} % of samples were above that",
            watch.share_over_autocheckpoint.unwrap_or(0.0) * 100.0
        ));
    }
    if watch.restarts == 0 {
        found.push(format!(
            "the log never started again from its beginning in {:.0} s",
            watch.duration_s
        ));
    } else {
        found.push(format!(
            "the log started again from its beginning {} times; the longest stretch without a restart was {:.0} s",
            watch.restarts, watch.longest_without_restart_s
        ));
    }
    if let Some(frames) = watch.frames_max {
        found.push(format!("the highest frame written: {frames}"));
    }
    if let (Some(bytes), Some(frames)) = (watch.wal_file_max_bytes, watch.wal_file_max_frames) {
        found.push(format!(
            "the log file reached {bytes} bytes ({frames} frames); SQLite reuses it from its start and never shrinks it"
        ));
    }
    if watch.checkpoint_short_points > 0 {
        found.push(format!(
            "{} samples caught a checkpoint that had not reached the end it set out for (a reader held the log)",
            watch.checkpoint_short_points
        ));
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    fn header_bytes(page_size: u32, seq: u32) -> Vec<u8> {
        let mut bytes = vec![0u8; 32];
        bytes[0..4].copy_from_slice(&0x377f_0682u32.to_be_bytes());
        bytes[4..8].copy_from_slice(&3_007_000u32.to_be_bytes());
        bytes[8..12].copy_from_slice(&page_size.to_be_bytes());
        bytes[12..16].copy_from_slice(&seq.to_be_bytes());
        bytes
    }

    fn shm_bytes(frames: u32, copied: u32, attempted: u32) -> Vec<u8> {
        let mut bytes = vec![0u8; 136];
        bytes[12] = 1;
        bytes[16..20].copy_from_slice(&frames.to_ne_bytes());
        let copy: Vec<u8> = bytes[..48].to_vec();
        bytes[48..96].copy_from_slice(&copy);
        bytes[96..100].copy_from_slice(&copied.to_ne_bytes());
        bytes[128..132].copy_from_slice(&attempted.to_ne_bytes());
        bytes
    }

    #[test]
    fn the_wal_header_and_the_wal_index_are_read_or_refused() {
        assert_eq!(
            wal_header(&header_bytes(4096, 7)),
            Some(WalHeader {
                page_size: 4096,
                checkpoint_seq: 7
            })
        );
        let mut bad = header_bytes(4096, 7);
        bad[0] = 0;
        assert_eq!(wal_header(&bad), None, "not a WAL magic");
        assert_eq!(wal_header(&[0u8; 10]), None);
        let point = shm_point(&shm_bytes(1200, 1000, 1200)).unwrap();
        assert_eq!(
            (
                point.mx_frame,
                point.backfill,
                point.backfill_attempted,
                point.backlog()
            ),
            (1200, 1000, 1200, 200)
        );
        let mut torn = shm_bytes(1200, 1000, 1200);
        torn[16] ^= 0xFF;
        assert_eq!(shm_point(&torn), None, "a torn read");
        assert_eq!(shm_point(&shm_bytes(1, 0, 0)[..100]), None, "too short");
    }

    fn point(t_s: f64, seq: u32, frames: u32, copied: u32) -> Point {
        Point {
            t_s,
            wal_bytes: Some(32 + 4120 * 1004),
            header: Some(WalHeader {
                page_size: 4096,
                checkpoint_seq: seq,
            }),
            shm: Some(ShmPoint {
                mx_frame: frames,
                backfill: copied,
                backfill_attempted: copied,
            }),
        }
    }

    #[test]
    fn a_sawtooth_is_summarised_with_its_restarts_and_quantiles() {
        let points = vec![
            point(0.0, 3, 10, 0),
            point(1.0, 3, 990, 0),
            point(2.0, 3, 1004, 1004),
            point(3.0, 4, 12, 0),
            point(4.0, 4, 600, 0),
        ];
        let watch = summarize(&points, 1000);
        assert_eq!(watch.restarts, 1);
        assert_eq!(watch.backlog_max, Some(990));
        assert_eq!(watch.backlog_p50, Some(12));
        assert_eq!(watch.frames_max, Some(1004));
        assert_eq!(watch.wal_file_max_frames, Some(1004));
        assert_eq!(watch.longest_without_restart_s, 3.0);
        assert_eq!(watch.share_over_autocheckpoint, Some(0.0));
        assert_eq!(watch.duration_s, 4.0);
        assert!(
            watch
                .findings
                .iter()
                .any(|line| line.contains("started again from its beginning 1 times")),
            "{:?}",
            watch.findings
        );
        let blind: Vec<Point> = points
            .iter()
            .map(|point| Point {
                shm: None,
                ..*point
            })
            .collect();
        let watch = summarize(&blind, 1000);
        assert_eq!(watch.readable_points, 0);
        assert!(watch.findings[0].contains("never readable"));
    }

    /// The parser against files SQLite itself wrote (a scratch database, not the host's): the
    /// page size is the database's, `mxFrame` agrees with the log file's length, and the
    /// checkpoint sequence goes up by one when a checkpoint restarts the log.
    #[cfg_attr(
        windows,
        ignore = "Windows -shm read unverified: reading the wal-index of a live database there is untested"
    )]
    #[tokio::test]
    async fn the_parser_agrees_with_real_files_of_a_scratch_database() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("host.db");
        let writer = markiro_host::db::open(&path).await.unwrap();
        sqlx::query("CREATE TABLE IF NOT EXISTS scratch_wal (id INTEGER PRIMARY KEY, v BLOB)")
            .execute(&writer)
            .await
            .unwrap();
        for _ in 0..40 {
            sqlx::query("INSERT INTO scratch_wal (v) VALUES (randomblob(3000))")
                .execute(&writer)
                .await
                .unwrap();
        }
        let before = read_point(0.0, dir.path());
        let (page,): (i64,) = sqlx::query_as("PRAGMA page_size")
            .fetch_one(&writer)
            .await
            .unwrap();
        let header = before.header.expect("the real WAL header parses");
        assert_eq!(i64::from(header.page_size), page);
        // The salts that follow are random, so a wrong offset reads a huge number here.
        assert!(header.checkpoint_seq < 100, "{header:?}");
        let shm = before.shm.expect("the real wal-index parses");
        let frames_in_file = (before.wal_bytes.unwrap() - 32) / (u64::from(header.page_size) + 24);
        assert!(shm.mx_frame >= 40, "{shm:?}");
        assert_eq!(u64::from(shm.mx_frame), frames_in_file, "{shm:?}");
        // Only the scratch database is ever checkpointed, and only here, to see the sequence move.
        sqlx::query("PRAGMA wal_checkpoint(RESTART)")
            .fetch_all(&writer)
            .await
            .unwrap();
        let copied = read_point(0.5, dir.path()).shm.unwrap();
        assert!(copied.backfill >= 40, "{copied:?}");
        assert_eq!(
            copied.backfill, copied.mx_frame,
            "everything was copied: {copied:?}"
        );
        assert_eq!(copied.backfill_attempted, copied.backfill, "{copied:?}");
        sqlx::query("INSERT INTO scratch_wal (v) VALUES (randomblob(10))")
            .execute(&writer)
            .await
            .unwrap();
        let after = read_point(1.0, dir.path());
        assert_eq!(
            after.header.unwrap().checkpoint_seq,
            header.checkpoint_seq + 1,
            "{before:?} {after:?}"
        );
        assert!(
            after.shm.unwrap().mx_frame < shm.mx_frame,
            "the log started again"
        );
        writer.close().await;
    }

    /// E10: an observer that only reads cannot checkpoint, and so the harness never tries.
    #[tokio::test]
    async fn a_read_only_observer_cannot_checkpoint_the_log() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("host.db");
        let writer = markiro_host::db::open(&path).await.unwrap();
        let reader = crate::dbcheck::open_read_only(&path, false).await.unwrap();
        let outcome: Result<(i64, i64, i64), sqlx::Error> =
            sqlx::query_as("PRAGMA wal_checkpoint(PASSIVE)")
                .fetch_one(&reader)
                .await;
        eprintln!("OBSERVED read-only wal_checkpoint: {outcome:?}");
        assert!(
            outcome.is_err(),
            "a read-only connection checkpointed: {outcome:?}"
        );
        reader.close().await;
        writer.close().await;
    }

    #[cfg_attr(
        windows,
        ignore = "Windows -shm read unverified: reading the wal-index of a live database there is untested"
    )]
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_host_in_this_process_is_watched_while_devices_write() {
        use crate::scenarios::{enter_all, Ctx, HostKind};
        let work = tempfile::tempdir().unwrap();
        let profile = crate::profile::Profile::preset("tiny").unwrap();
        let ctx = Ctx::new("wal", &HostKind::InProcess, work.path(), &profile, 2, 1)
            .await
            .unwrap();
        let dir = ctx.host.data_dir.clone().unwrap();
        let (stop, watching) = watch::channel(false);
        let task = tokio::spawn(run(dir, Duration::from_millis(50), watching));
        let line = ctx.site.line_ids[0].clone();
        let shift = ctx.plan(&line, None).await.unwrap();
        let prefix = enter_all(&ctx, &shift, &[0, 1, 2]).await.unwrap();
        let load = ctx.load(1, &shift, &prefix, &[0, 1, 2]);
        tokio::time::sleep(Duration::from_secs(3)).await;
        let _ = load.stop("").await;
        stop.send_replace(true);
        let points = task.await.unwrap();
        let summary = summarize(&points, 50);
        eprintln!("OBSERVED {summary:#?}");
        assert!(summary.readable_points > 0, "the wal-index was never read");
        assert!(summary.frames_max.is_some_and(|frames| frames > 0));
        assert!(summary.page_size.is_some(), "the WAL header was never read");
        let _ = ctx.finish(Ok(())).await;
    }
}
