//! Limits of the update routes (spec §10.11.3): one download per device at
//! a time (a second is `429 rate_limited`), at most [`HOST_DOWNLOADS`] on the
//! host (`503 update_busy` with `Retry-After`), and [`DEVICE_REQUESTS`]
//! requests a minute per device to both routes. Kept by device, not by
//! address (`crate::rate_limit` counts addresses). A refusal writes no row.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard};

use axum::http::StatusCode;
use time::{Duration, OffsetDateTime};

use crate::clock::Clock;
use crate::error::ApiError;

/// Downloads the host serves at once.
pub const HOST_DOWNLOADS: usize = 3;
/// Requests to the update routes a minute per device.
pub const DEVICE_REQUESTS: usize = 30;
/// `Retry-After` of a fourth download.
pub const BUSY_RETRY_AFTER_SECS: u64 = 30;

/// Why a download did not start.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Busy {
    Device,
    Host,
}

pub struct DownloadLimits {
    clock: Arc<dyn Clock>,
    requests: Mutex<HashMap<String, VecDeque<OffsetDateTime>>>,
    active: Mutex<HashSet<String>>,
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl DownloadLimits {
    pub fn new(clock: Arc<dyn Clock>) -> Self {
        Self {
            clock,
            requests: Mutex::new(HashMap::new()),
            active: Mutex::new(HashSet::new()),
        }
    }

    /// Count one request of `device`; refuse it when its minute is full.
    pub fn check_rate(&self, device: &str) -> Result<(), ApiError> {
        let now = self.clock.now();
        let window = Duration::minutes(1);
        let mut requests = locked(&self.requests);
        requests.retain(|_, seen| {
            while seen.front().is_some_and(|at| *at <= now - window) {
                seen.pop_front();
            }
            !seen.is_empty()
        });
        let seen = requests.entry(device.to_owned()).or_default();
        if seen.len() >= DEVICE_REQUESTS {
            return Err(ApiError::new(
                StatusCode::TOO_MANY_REQUESTS,
                markiro_proto::codes::RATE_LIMITED,
                "too many update requests from this device",
            ));
        }
        seen.push_back(now);
        Ok(())
    }

    /// A slot for one download of `device`, held until the slot is dropped.
    pub fn acquire(self: &Arc<Self>, device: &str) -> Result<DownloadSlot, Busy> {
        let mut active = locked(&self.active);
        if active.contains(device) {
            return Err(Busy::Device);
        }
        if active.len() >= HOST_DOWNLOADS {
            return Err(Busy::Host);
        }
        active.insert(device.to_owned());
        Ok(DownloadSlot {
            limits: self.clone(),
            device: device.to_owned(),
        })
    }
}

/// One download in progress; dropping it frees the slot.
pub struct DownloadSlot {
    limits: Arc<DownloadLimits>,
    device: String,
}

impl Drop for DownloadSlot {
    fn drop(&mut self) {
        locked(&self.limits.active).remove(&self.device);
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::clock::ManualClock;

    #[test]
    fn a_slot_is_one_per_device_three_per_host_and_free_again_when_dropped() {
        let clock = Arc::new(ManualClock::new(OffsetDateTime::UNIX_EPOCH));
        let limits = Arc::new(DownloadLimits::new(clock));
        let a = limits.acquire("a").unwrap();
        assert_eq!(limits.acquire("a").err(), Some(Busy::Device));
        let _b = limits.acquire("b").unwrap();
        let _c = limits.acquire("c").unwrap();
        assert_eq!(limits.acquire("d").err(), Some(Busy::Host));
        drop(a);
        assert!(limits.acquire("d").is_ok());
    }
}
