//! The memory and the open descriptors of the host process, and the slope of
//! a series: how fast a number grows over a run (a leak shows as a slope, a
//! warm-up as a step).

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProcSample {
    pub rss_bytes: u64,
    pub fds: u64,
}

/// The resident memory in bytes from the text of `/proc/<pid>/status`.
pub fn rss_from_proc_status(text: &str) -> Option<u64> {
    let line = text.lines().find(|line| line.starts_with("VmRSS:"))?;
    let kib: u64 = line.split_whitespace().nth(1)?.parse().ok()?;
    Some(kib * 1024)
}

/// The resident memory in bytes from `ps -o rss=` (KiB).
pub fn rss_from_ps(text: &str) -> Option<u64> {
    text.trim().parse::<u64>().ok().map(|kib| kib * 1024)
}

#[cfg(target_os = "linux")]
pub fn sample(pid: u32) -> Option<ProcSample> {
    let status = std::fs::read_to_string(format!("/proc/{pid}/status")).ok()?;
    let fds = std::fs::read_dir(format!("/proc/{pid}/fd")).ok()?.count() as u64;
    Some(ProcSample {
        rss_bytes: rss_from_proc_status(&status)?,
        fds,
    })
}

#[cfg(target_os = "macos")]
pub fn sample(pid: u32) -> Option<ProcSample> {
    let run = |program: &str, args: &[&str]| {
        let output = std::process::Command::new(program)
            .args(args)
            .output()
            .ok()?;
        output
            .status
            .success()
            .then(|| String::from_utf8_lossy(&output.stdout).into_owned())
    };
    let pid_text = pid.to_string();
    let rss = rss_from_ps(&run("ps", &["-o", "rss=", "-p", &pid_text])?)?;
    let listing = run("lsof", &["-p", &pid_text])?;
    // The first line names the columns.
    let fds = listing.lines().count().saturating_sub(1) as u64;
    Some(ProcSample {
        rss_bytes: rss,
        fds,
    })
}

#[cfg(windows)]
pub fn sample(pid: u32) -> Option<ProcSample> {
    let script = format!("$p = Get-Process -Id {pid}; \"$($p.WorkingSet64) $($p.HandleCount)\"");
    let output = std::process::Command::new("powershell")
        .args(["-NoProfile", "-Command", &script])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout).into_owned();
    let mut parts = text.split_whitespace();
    Some(ProcSample {
        rss_bytes: parts.next()?.parse().ok()?,
        fds: parts.next()?.parse().ok()?,
    })
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
pub fn sample(_pid: u32) -> Option<ProcSample> {
    None
}

/// The least-squares slope of `points` (seconds, value) in value units per
/// hour; 0 for fewer than two points or no spread in time.
pub fn slope_per_hour(points: &[(f64, f64)]) -> f64 {
    if points.len() < 2 {
        return 0.0;
    }
    let n = points.len() as f64;
    let mean_t = points.iter().map(|(t, _)| t).sum::<f64>() / n;
    let mean_v = points.iter().map(|(_, v)| v).sum::<f64>() / n;
    let spread: f64 = points.iter().map(|(t, _)| (t - mean_t).powi(2)).sum();
    if spread == 0.0 {
        return 0.0;
    }
    let covariance: f64 = points
        .iter()
        .map(|(t, v)| (t - mean_t) * (v - mean_v))
        .sum();
    covariance / spread * 3600.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_is_read_from_the_text_of_the_platform() {
        let status = "Name:\tmarkiro-host\nVmPeak:\t  900 kB\nVmRSS:\t  20480 kB\nThreads:\t9\n";
        assert_eq!(rss_from_proc_status(status), Some(20_480 * 1024));
        assert_eq!(rss_from_proc_status("Name:\tx\n"), None);
        assert_eq!(rss_from_ps("  51200\n"), Some(51_200 * 1024));
        assert_eq!(rss_from_ps("nope"), None);
    }

    #[test]
    fn a_slope_is_per_hour_and_flat_for_a_flat_series() {
        // 10 MiB every ten minutes: 60 MiB an hour.
        let growing: Vec<(f64, f64)> = (0..7)
            .map(|i| (i as f64 * 600.0, i as f64 * 10.0))
            .collect();
        assert!((slope_per_hour(&growing) - 60.0).abs() < 1e-9);
        let flat: Vec<(f64, f64)> = (0..7).map(|i| (i as f64 * 600.0, 42.0)).collect();
        assert_eq!(slope_per_hour(&flat), 0.0);
        assert_eq!(slope_per_hour(&[(1.0, 5.0)]), 0.0);
        assert_eq!(slope_per_hour(&[(1.0, 5.0), (1.0, 9.0)]), 0.0);
    }

    #[test]
    fn this_process_can_be_sampled_where_the_platform_allows_it() {
        match sample(std::process::id()) {
            Some(sample) => {
                assert!(sample.rss_bytes > 1024 * 1024);
                assert!(sample.fds > 2);
            }
            // `ps` and `lsof` may be refused (a sandbox); `/proc` and
            // PowerShell are not.
            None if cfg!(any(target_os = "linux", windows)) => panic!("no sample of this process"),
            None => eprintln!("skipped: ps or lsof refused on this machine"),
        }
    }
}
