use serde::Serialize;
use std::time::{SystemTime, UNIX_EPOCH};

const JS_MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ClockError {
    Unavailable,
    Untrusted,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrantClockSample {
    pub boot_id: String,
    pub monotonic_ms: u64,
    pub wall_ms: u64,
}

trait ClockSource {
    fn boot_id(&self) -> Result<String, ClockError>;
    fn monotonic_ms(&self) -> Result<u64, ClockError>;
    fn wall_ms(&self) -> Result<u64, ClockError>;
}

fn sample_from_source(source: &impl ClockSource) -> Result<GrantClockSample, ClockError> {
    let boot_id = source.boot_id()?;
    let monotonic_ms = source.monotonic_ms()?;
    let wall_ms = source.wall_ms()?;
    if boot_id.is_empty() || monotonic_ms > JS_MAX_SAFE_INTEGER || wall_ms > JS_MAX_SAFE_INTEGER {
        return Err(ClockError::Untrusted);
    }
    Ok(GrantClockSample {
        boot_id,
        monotonic_ms,
        wall_ms,
    })
}

struct PlatformClock;

impl ClockSource for PlatformClock {
    fn boot_id(&self) -> Result<String, ClockError> {
        platform::boot_id()
    }
    fn monotonic_ms(&self) -> Result<u64, ClockError> {
        platform::monotonic_ms()
    }
    fn wall_ms(&self) -> Result<u64, ClockError> {
        let millis = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| ClockError::Untrusted)?
            .as_millis();
        u64::try_from(millis).map_err(|_| ClockError::Untrusted)
    }
}

fn platform_sample() -> Result<GrantClockSample, ClockError> {
    sample_from_source(&PlatformClock)
}

#[tauri::command]
pub fn grant_clock_sample() -> Result<GrantClockSample, ClockError> {
    platform_sample()
}

#[cfg(target_os = "linux")]
mod platform {
    use super::ClockError;
    use std::fs;

    pub fn boot_id() -> Result<String, ClockError> {
        let value = fs::read_to_string("/proc/sys/kernel/random/boot_id")
            .map_err(|_| ClockError::Unavailable)?;
        let value = value.trim().to_owned();
        if value.is_empty() {
            Err(ClockError::Untrusted)
        } else {
            Ok(format!("linux:{value}"))
        }
    }

    pub fn monotonic_ms() -> Result<u64, ClockError> {
        let uptime = fs::read_to_string("/proc/uptime").map_err(|_| ClockError::Unavailable)?;
        let seconds = uptime
            .split_whitespace()
            .next()
            .ok_or(ClockError::Untrusted)?
            .parse::<f64>()
            .map_err(|_| ClockError::Untrusted)?;
        if !seconds.is_finite() || seconds < 0.0 {
            return Err(ClockError::Untrusted);
        }
        Ok((seconds * 1000.0).floor() as u64)
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::ClockError;
    use std::ffi::{c_char, c_int, c_void, CString};

    #[repr(C)]
    struct MachTimebaseInfo {
        numer: u32,
        denom: u32,
    }
    unsafe extern "C" {
        fn sysctlbyname(
            name: *const c_char,
            oldp: *mut c_void,
            oldlenp: *mut usize,
            newp: *mut c_void,
            newlen: usize,
        ) -> c_int;
        fn mach_continuous_time() -> u64;
        fn mach_timebase_info(info: *mut MachTimebaseInfo) -> c_int;
    }

    pub fn boot_id() -> Result<String, ClockError> {
        const MAX_BOOT_SESSION_UUID_BYTES: usize = 64;
        let name = CString::new("kern.bootsessionuuid").map_err(|_| ClockError::Unavailable)?;
        let mut length = 0usize;
        if unsafe {
            sysctlbyname(
                name.as_ptr(),
                std::ptr::null_mut(),
                &mut length,
                std::ptr::null_mut(),
                0,
            )
        } != 0
            || length == 0
            || length > MAX_BOOT_SESSION_UUID_BYTES
        {
            return Err(ClockError::Unavailable);
        }
        let mut bytes = vec![0u8; length];
        if unsafe {
            sysctlbyname(
                name.as_ptr(),
                bytes.as_mut_ptr().cast(),
                &mut length,
                std::ptr::null_mut(),
                0,
            )
        } != 0
            || length == 0
            || length > bytes.len()
        {
            return Err(ClockError::Unavailable);
        }
        bytes.truncate(length);
        decode_boot_session_uuid(&bytes)
    }

    pub(crate) fn decode_boot_session_uuid(bytes: &[u8]) -> Result<String, ClockError> {
        if bytes.len() != 37 || bytes.last() != Some(&0) || bytes[..bytes.len() - 1].contains(&0) {
            return Err(ClockError::Untrusted);
        }
        let text = std::str::from_utf8(&bytes[..36]).map_err(|_| ClockError::Untrusted)?;
        let uuid = uuid::Uuid::parse_str(text).map_err(|_| ClockError::Untrusted)?;
        if !uuid.hyphenated().to_string().eq_ignore_ascii_case(text) {
            return Err(ClockError::Untrusted);
        }
        Ok(format!("macos:{}", uuid.hyphenated()))
    }

    pub fn monotonic_ms() -> Result<u64, ClockError> {
        let mut info = MachTimebaseInfo { numer: 0, denom: 0 };
        if unsafe { mach_timebase_info(&mut info) } != 0 || info.denom == 0 {
            return Err(ClockError::Unavailable);
        }
        let ticks = unsafe { mach_continuous_time() } as u128;
        let nanos = ticks
            .checked_mul(info.numer as u128)
            .ok_or(ClockError::Untrusted)?
            / info.denom as u128;
        u64::try_from(nanos / 1_000_000).map_err(|_| ClockError::Untrusted)
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use super::ClockError;

    #[repr(C)]
    struct Guid {
        data1: u32,
        data2: u16,
        data3: u16,
        data4: [u8; 8],
    }
    #[repr(C)]
    struct BootEnvironment {
        boot_identifier: Guid,
        firmware_type: u32,
        boot_flags: u64,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetTickCount64() -> u64;
    }
    #[link(name = "ntdll")]
    unsafe extern "system" {
        fn NtQuerySystemInformation(
            class: u32,
            info: *mut BootEnvironment,
            length: u32,
            returned: *mut u32,
        ) -> i32;
    }

    pub fn boot_id() -> Result<String, ClockError> {
        let mut value = BootEnvironment {
            boot_identifier: Guid {
                data1: 0,
                data2: 0,
                data3: 0,
                data4: [0; 8],
            },
            firmware_type: 0,
            boot_flags: 0,
        };
        let mut returned = 0;
        let status = unsafe {
            NtQuerySystemInformation(
                90,
                &mut value,
                std::mem::size_of::<BootEnvironment>() as u32,
                &mut returned,
            )
        };
        if status < 0 || returned < 16 {
            return Err(ClockError::Unavailable);
        }
        let id = value.boot_identifier;
        Ok(format!(
            "windows:{:08x}-{:04x}-{:04x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
            id.data1,
            id.data2,
            id.data3,
            id.data4[0],
            id.data4[1],
            id.data4[2],
            id.data4[3],
            id.data4[4],
            id.data4[5],
            id.data4[6],
            id.data4[7]
        ))
    }

    pub fn monotonic_ms() -> Result<u64, ClockError> {
        Ok(unsafe { GetTickCount64() })
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
mod platform {
    use super::ClockError;
    pub fn boot_id() -> Result<String, ClockError> {
        Err(ClockError::Unavailable)
    }
    pub fn monotonic_ms() -> Result<u64, ClockError> {
        Err(ClockError::Unavailable)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FakeSource {
        boot_id: Result<String, ClockError>,
        monotonic_ms: Result<u64, ClockError>,
        wall_ms: Result<u64, ClockError>,
    }

    impl ClockSource for FakeSource {
        fn boot_id(&self) -> Result<String, ClockError> {
            self.boot_id.clone()
        }
        fn monotonic_ms(&self) -> Result<u64, ClockError> {
            self.monotonic_ms.clone()
        }
        fn wall_ms(&self) -> Result<u64, ClockError> {
            self.wall_ms.clone()
        }
    }

    fn source(boot_id: &str, monotonic_ms: u64, wall_ms: u64) -> FakeSource {
        FakeSource {
            boot_id: Ok(boot_id.into()),
            monotonic_ms: Ok(monotonic_ms),
            wall_ms: Ok(wall_ms),
        }
    }

    #[test]
    fn preserves_boot_identity_and_boot_relative_monotonic_time_across_calls() {
        let sample = sample_from_source(&source("boot-a", 10, 100)).unwrap();
        assert_eq!(
            sample,
            GrantClockSample {
                boot_id: "boot-a".into(),
                monotonic_ms: 10,
                wall_ms: 100
            }
        );
        assert_eq!(
            serde_json::to_value(sample).unwrap(),
            serde_json::json!({ "bootId": "boot-a", "monotonicMs": 10, "wallMs": 100 })
        );
        assert_eq!(
            sample_from_source(&source("boot-a", 20, 110))
                .unwrap()
                .boot_id,
            "boot-a"
        );
    }

    #[test]
    fn rejects_missing_identity_source_errors_and_javascript_overflow() {
        assert_eq!(
            sample_from_source(&source("", 10, 100)),
            Err(ClockError::Untrusted)
        );
        assert_eq!(
            sample_from_source(&source("boot", JS_MAX_SAFE_INTEGER + 1, 100)),
            Err(ClockError::Untrusted)
        );
        let unavailable = FakeSource {
            boot_id: Err(ClockError::Unavailable),
            monotonic_ms: Ok(10),
            wall_ms: Ok(100),
        };
        assert_eq!(
            sample_from_source(&unavailable),
            Err(ClockError::Unavailable)
        );
    }

    #[test]
    fn wall_samples_may_move_in_either_direction_without_changing_boot_trust() {
        let forward = sample_from_source(&source("boot", 20, 200)).unwrap();
        let backward = sample_from_source(&source("boot", 30, 100)).unwrap();
        assert_eq!(forward.boot_id, backward.boot_id);
        assert!(backward.monotonic_ms > forward.monotonic_ms);
        assert!(backward.wall_ms < forward.wall_ms);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn parses_only_bounded_nul_terminated_boot_session_uuids() {
        let uuid = b"7D9D7397-03D5-432D-B704-1E7A9556678F\0";
        assert_eq!(
            platform::decode_boot_session_uuid(uuid).unwrap(),
            "macos:7d9d7397-03d5-432d-b704-1e7a9556678f"
        );
        assert_eq!(
            platform::decode_boot_session_uuid(&uuid[..uuid.len() - 1]),
            Err(ClockError::Untrusted)
        );
        assert_eq!(
            platform::decode_boot_session_uuid(b"not-a-uuid\0"),
            Err(ClockError::Untrusted)
        );
        assert_eq!(
            platform::decode_boot_session_uuid(b"7D9D7397-03D5-432D-B704-1E7A9556678F\0extra"),
            Err(ClockError::Untrusted)
        );
    }

    #[test]
    fn real_host_sample_is_non_decreasing_with_the_same_boot_identity() {
        assert!(
            platform::boot_id().is_ok(),
            "boot identity: {:?}",
            platform::boot_id()
        );
        assert!(
            platform::monotonic_ms().is_ok(),
            "monotonic clock: {:?}",
            platform::monotonic_ms()
        );
        let first = platform_sample().expect("host clock source should be available");
        let second = platform_sample().expect("host clock source should remain available");
        assert_eq!(first.boot_id, second.boot_id);
        assert!(second.monotonic_ms >= first.monotonic_ms);
        assert!(first.wall_ms <= JS_MAX_SAFE_INTEGER && second.wall_ms <= JS_MAX_SAFE_INTEGER);
    }
}
