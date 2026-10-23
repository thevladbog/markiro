use markiro_backup_cloud::retry::parse;
use std::time::{Duration, SystemTime};
#[test]
fn retry_after_accepts_seconds_and_http_date_without_echoing_header_text() {
    let now = SystemTime::UNIX_EPOCH + Duration::from_secs(60);
    assert_eq!(parse("120", now), Some(120));
    assert_eq!(parse("Thu, 01 Jan 1970 00:02:00 GMT", now), Some(60));
    assert_eq!(parse("Thu, 01 Jan 1970 00:00:00 GMT", now), Some(0));
    for value in ["-1", "wrong", ""] {
        assert_eq!(parse(value, now), None);
    }
}
