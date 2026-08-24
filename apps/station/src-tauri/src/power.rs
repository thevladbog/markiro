use std::sync::Mutex;

#[cfg(windows)]
mod windows;

trait PowerRequestBackend {
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

    fn set_awake(&self, awake: bool) -> Result<(), String> {
        let mut lease = self
            .lease
            .lock()
            .map_err(|_| "system power request state is unavailable".to_string())?;
        if awake && lease.is_none() {
            *lease = Some(self.backend.acquire()?);
        } else if !awake {
            *lease = None;
        }
        Ok(())
    }
}

struct PlatformPowerRequestBackend;

#[cfg(not(windows))]
impl PowerRequestBackend for PlatformPowerRequestBackend {
    type Lease = ();

    fn acquire(&self) -> Result<Self::Lease, String> {
        Ok(())
    }
}

#[cfg(windows)]
impl PowerRequestBackend for PlatformPowerRequestBackend {
    type Lease = windows::WindowsPowerRequest;

    fn acquire(&self) -> Result<Self::Lease, String> {
        windows::acquire()
    }
}

pub struct SystemAwakeState(PowerRequestState<PlatformPowerRequestBackend>);

impl Default for SystemAwakeState {
    fn default() -> Self {
        Self(PowerRequestState::new(PlatformPowerRequestBackend))
    }
}

#[tauri::command]
pub fn set_system_awake(
    state: tauri::State<'_, SystemAwakeState>,
    awake: bool,
) -> Result<(), String> {
    state.0.set_awake(awake)
}

#[cfg(test)]
mod tests {
    use super::{PowerRequestBackend, PowerRequestState};
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    struct FakeBackend {
        acquired: Arc<AtomicUsize>,
        released: Arc<AtomicUsize>,
    }

    struct FakeLease(Arc<AtomicUsize>);

    impl Drop for FakeLease {
        fn drop(&mut self) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }

    impl PowerRequestBackend for FakeBackend {
        type Lease = FakeLease;

        fn acquire(&self) -> Result<Self::Lease, String> {
            self.acquired.fetch_add(1, Ordering::SeqCst);
            Ok(FakeLease(Arc::clone(&self.released)))
        }
    }

    #[test]
    fn active_shift_holds_exactly_one_power_request_until_it_ends() {
        let acquired = Arc::new(AtomicUsize::new(0));
        let released = Arc::new(AtomicUsize::new(0));
        let state = PowerRequestState::new(FakeBackend {
            acquired: Arc::clone(&acquired),
            released: Arc::clone(&released),
        });

        state.set_awake(true).unwrap();
        state.set_awake(true).unwrap();
        assert_eq!(acquired.load(Ordering::SeqCst), 1);
        assert_eq!(released.load(Ordering::SeqCst), 0);

        state.set_awake(false).unwrap();
        state.set_awake(false).unwrap();
        assert_eq!(released.load(Ordering::SeqCst), 1);
    }
}
