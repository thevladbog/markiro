//! Retry-After parsing without retaining provider-controlled header text.
use std::time::SystemTime;

pub fn parse(value: &str, now: SystemTime) -> Option<u64> {
    if value.is_empty() || value.len() > 128 {
        return None;
    }
    if value.bytes().all(|b| b.is_ascii_digit()) {
        return value.parse().ok();
    }
    let at = httpdate::parse_http_date(value).ok()?;
    Some(at.duration_since(now).map_or(0, |d| d.as_secs()))
}

pub fn check(response: &reqwest::Response) -> crate::Result<()> {
    let status = response.status().as_u16();
    if matches!(status, 429 | 503) {
        if let Some(seconds) = response
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|h| h.to_str().ok())
            .and_then(|h| parse(h, SystemTime::now()))
        {
            return Err(crate::Error::RetryAfter { seconds, status });
        }
    }
    Ok(())
}
