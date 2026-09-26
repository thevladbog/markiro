//! Per-address attempt limit for office login (and, from plan 1c, pairing
//! claims): at most `max` attempts within a sliding `window`.

use std::collections::{HashMap, VecDeque};
use std::net::IpAddr;
use std::sync::{Arc, Mutex};

use axum::http::StatusCode;
use time::{Duration, OffsetDateTime};

use crate::clock::Clock;
use crate::error::ApiError;

pub struct RateLimiter {
    max: usize,
    window: Duration,
    clock: Arc<dyn Clock>,
    attempts: Mutex<HashMap<IpAddr, VecDeque<OffsetDateTime>>>,
}

impl RateLimiter {
    pub fn new(max: usize, window: Duration, clock: Arc<dyn Clock>) -> Self {
        Self {
            max,
            window,
            clock,
            attempts: Mutex::new(HashMap::new()),
        }
    }

    /// Count one attempt from `ip`; refuse it when the window is already full.
    pub fn check(&self, ip: IpAddr) -> Result<(), ApiError> {
        let now = self.clock.now();
        let mut attempts = self.attempts.lock().expect("rate limiter lock");
        attempts.retain(|_, seen| {
            while seen.front().is_some_and(|at| *at <= now - self.window) {
                seen.pop_front();
            }
            !seen.is_empty()
        });
        let seen = attempts.entry(ip.to_canonical()).or_default();
        if seen.len() >= self.max {
            return Err(ApiError::new(
                StatusCode::TOO_MANY_REQUESTS,
                markiro_proto::codes::RATE_LIMITED,
                "too many attempts, try again later",
            ));
        }
        seen.push_back(now);
        Ok(())
    }
}
