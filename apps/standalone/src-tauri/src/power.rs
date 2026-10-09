//! Keeping the computer awake during a shift (stage 2a spec §5.2, decision
//! 34), ported from the cloud station (`apps/station/src-tauri/src/power.rs`).
//! `set_system_awake(true)` holds one Windows power request — display and
//! system required — until `set_system_awake(false)`; off Windows it holds
//! nothing. The webview asks while an operator is in a shift's work screen
//! (plan 2a7). Letting go never fails: not even a poisoned lock keeps a PC
//! awake after its shift, and a refusal is the bare `power_request_failed`.

use std::sync::{Mutex, PoisonError};

#[cfg(windows)]
mod windows;

/// Why `set_system_awake(true)` failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PowerError {
    /// Windows refused the power request; the computer may sleep.
    RequestFailed,
}

impl PowerError {
    pub fn code(self) -> &'static str {
        match self {
            PowerError::RequestFailed => "power_request_failed",
        }
    }
}

/// Where a lease comes from: Windows' power requests, or a test's fake.
trait PowerRequestBackend {
    /// Held while awake; dropping it lets the computer sleep again.
    type Lease: Send;

    fn acquire(&self) -> Result<Self::Lease, String>;
}

struct PowerRequestState<B: PowerRequestBackend> {
    backend: B,
    lease: Mutex<Option<B::Lease>>,
}

impl<B: PowerRequestBackend> PowerRequestState<B> {
    fn new(backend: B) -> Self {
        Self {
            backend,
            lease: Mutex::new(None),
        }
    }

    /// Holds exactly one lease while `awake`: asking twice acquires once, and
    /// `false` drops it, a poisoned lock included. A failed acquire leaves
    /// none, so the next `true` tries again.
    fn set_awake(&self, awake: bool) -> Result<(), PowerError> {
        let mut lease = self.lease.lock().unwrap_or_else(PoisonError::into_inner);
        if !awake {
            *lease = None;
            return Ok(());
        }
        if lease.is_none() {
            match self.backend.acquire() {
                Ok(acquired) => *lease = Some(acquired),
                Err(detail) => {
                    eprintln!("standalone: set_system_awake power_request_failed: {detail}");
                    return Err(PowerError::RequestFailed);
                }
            }
        }
        Ok(())
    }

    /// `set_awake` as the webview reads it: the bare code, never the
    /// system's words.
    fn answer(&self, awake: bool) -> Result<(), String> {
        self.set_awake(awake)
            .map_err(|error| error.code().to_owned())
    }

    /// Whether a lease is held now; a poisoned lock reads what it holds.
    fn is_awake(&self) -> bool {
        self.lease
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .is_some()
    }
}

struct PlatformBackend;

#[cfg(not(windows))]
impl PowerRequestBackend for PlatformBackend {
    type Lease = ();

    fn acquire(&self) -> Result<Self::Lease, String> {
        Ok(())
    }
}

#[cfg(windows)]
impl PowerRequestBackend for PlatformBackend {
    type Lease = windows::WindowsPowerRequest;

    fn acquire(&self) -> Result<Self::Lease, String> {
        windows::acquire()
    }
}

/// Tauri state: the power request this app holds, if any.
pub struct SystemAwakeState(PowerRequestState<PlatformBackend>);

impl Default for SystemAwakeState {
    fn default() -> Self {
        Self(PowerRequestState::new(PlatformBackend))
    }
}

impl SystemAwakeState {
    /// Whether this app holds a power request now (`tests/ipc.rs` reads it).
    pub fn is_awake(&self) -> bool {
        self.0.is_awake()
    }
}

#[tauri::command]
pub fn set_system_awake(
    state: tauri::State<'_, SystemAwakeState>,
    awake: bool,
) -> Result<(), String> {
    state.0.answer(awake)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    /// Counts acquired and released leases; `fail` makes the next acquires
    /// fail. Clones share the counters, so a test keeps one to read them.
    #[derive(Clone, Default)]
    struct Fake {
        acquired: Arc<AtomicUsize>,
        released: Arc<AtomicUsize>,
        fail: Arc<std::sync::atomic::AtomicBool>,
    }

    struct FakeLease(Arc<AtomicUsize>);

    impl Drop for FakeLease {
        fn drop(&mut self) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }

    impl PowerRequestBackend for Fake {
        type Lease = FakeLease;

        fn acquire(&self) -> Result<Self::Lease, String> {
            if self.fail.load(Ordering::SeqCst) {
                return Err("refused".to_owned());
            }
            self.acquired.fetch_add(1, Ordering::SeqCst);
            Ok(FakeLease(Arc::clone(&self.released)))
        }
    }

    fn counts(fake: &Fake) -> (usize, usize) {
        (
            fake.acquired.load(Ordering::SeqCst),
            fake.released.load(Ordering::SeqCst),
        )
    }

    #[test]
    fn a_shift_holds_exactly_one_request_until_it_ends() {
        let probe = Fake::default();
        let fake = probe.clone();
        let state = PowerRequestState::new(fake);

        assert!(!state.is_awake());
        state.set_awake(true).unwrap();
        state.set_awake(true).unwrap();
        assert_eq!(counts(&probe), (1, 0));
        assert!(state.is_awake());
        state.set_awake(false).unwrap();
        state.set_awake(false).unwrap();
        assert_eq!(counts(&probe), (1, 1));
        assert!(!state.is_awake());
    }

    /// The app closing (or its state dropping for any reason) lets the
    /// computer sleep: the lease is never leaked past the state that owns it.
    #[test]
    fn dropping_the_state_lets_the_computer_sleep() {
        let probe = Fake::default();
        let fake = probe.clone();
        let state = PowerRequestState::new(fake);
        state.set_awake(true).unwrap();
        assert_eq!(counts(&probe), (1, 0));

        drop(state);
        assert_eq!(counts(&probe), (1, 1));
    }

    #[test]
    fn a_refused_request_holds_nothing_and_the_next_one_tries_again() {
        let probe = Fake::default();
        let fake = probe.clone();
        let state = PowerRequestState::new(fake);
        probe.fail.store(true, Ordering::SeqCst);

        assert_eq!(state.set_awake(true), Err(PowerError::RequestFailed));
        assert_eq!(state.set_awake(false), Ok(()));
        probe.fail.store(false, Ordering::SeqCst);
        assert_eq!(state.set_awake(true), Ok(()));
        assert_eq!(counts(&probe), (1, 0));
        assert_eq!(PowerError::RequestFailed.code(), "power_request_failed");
    }

    /// The webview reads the bare code of a refusal, and `null` otherwise
    /// (`Ok(())`), whether the system's refusal text was long or not.
    #[test]
    fn the_webview_reads_the_bare_code_of_a_refusal() {
        let probe = Fake::default();
        let fake = probe.clone();
        let state = PowerRequestState::new(fake);
        probe.fail.store(true, Ordering::SeqCst);

        assert_eq!(state.answer(true), Err("power_request_failed".to_owned()));
        assert_eq!(state.answer(false), Ok(()));
        probe.fail.store(false, Ordering::SeqCst);
        assert_eq!(state.answer(true), Ok(()));
    }

    /// A thread that panicked holding the lock must not keep the computer
    /// awake after the shift: `false` still drops the lease.
    #[test]
    fn letting_go_works_even_after_a_poisoned_lock() {
        let probe = Fake::default();
        let fake = probe.clone();
        let state = Arc::new(PowerRequestState::new(fake));
        state.set_awake(true).unwrap();
        let poisoner = Arc::clone(&state);
        let panicked = std::thread::spawn(move || {
            let _held = poisoner.lease.lock().unwrap();
            panic!("a thread dies holding the lock");
        })
        .join();
        assert!(panicked.is_err());
        assert!(state.lease.is_poisoned());

        assert!(state.is_awake(), "a poisoned lock still reads what is held");
        assert_eq!(state.set_awake(false), Ok(()));
        assert!(!state.is_awake());
        assert_eq!(counts(&probe), (1, 1));
        assert_eq!(state.set_awake(true), Ok(()));
        assert_eq!(counts(&probe), (2, 1));
    }
}
