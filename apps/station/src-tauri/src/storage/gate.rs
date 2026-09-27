use tokio::sync::watch;

use super::StationStorage;

type Resolution = Option<Result<StationStorage, String>>;

/// Commands wait here until the background thread has resolved storage.
#[derive(Clone)]
pub struct StorageGate(watch::Receiver<Resolution>);

pub struct StorageGateSender(watch::Sender<Resolution>);

pub fn storage_gate() -> (StorageGateSender, StorageGate) {
    let (sender, receiver) = watch::channel(None);
    (StorageGateSender(sender), StorageGate(receiver))
}

impl StorageGateSender {
    pub fn resolve(self, resolution: Result<StationStorage, String>) {
        let _ = self.0.send(Some(resolution));
    }
}

impl StorageGate {
    /// The resolved storage, or why the station must not start. A sender
    /// dropped without an answer (the resolving thread died) is an error too,
    /// never a fallback to the roaming folder.
    pub async fn ready(&self) -> Result<StationStorage, String> {
        let mut receiver = self.0.clone();
        let resolved = receiver
            .wait_for(Option::is_some)
            .await
            .map_err(|_| "station storage was not resolved".to_string())?;
        match &*resolved {
            Some(resolution) => resolution.clone(),
            None => Err("station storage was not resolved".to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::super::{StationStorage, StorageMode};
    use super::*;

    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
    }

    fn storage() -> StationStorage {
        StationStorage {
            dir: PathBuf::from("/tmp/local"),
            mode: StorageMode::Local,
            notices: Vec::new(),
        }
    }

    #[test]
    fn callers_wait_for_the_resolution_and_later_callers_get_it_at_once() {
        runtime().block_on(async {
            let (sender, gate) = storage_gate();
            let waiting = tokio::spawn({
                let gate = gate.clone();
                async move { gate.ready().await }
            });
            tokio::task::yield_now().await;
            assert!(!waiting.is_finished());
            sender.resolve(Ok(storage()));
            assert_eq!(waiting.await.unwrap(), Ok(storage()));
            assert_eq!(gate.ready().await, Ok(storage()));
        });
    }

    #[test]
    fn a_blocked_resolution_and_a_lost_sender_are_errors() {
        runtime().block_on(async {
            let (sender, gate) = storage_gate();
            sender.resolve(Err("blocked".into()));
            assert_eq!(gate.ready().await, Err("blocked".to_string()));

            let (sender, gate) = storage_gate();
            drop(sender);
            assert!(gate.ready().await.is_err());
        });
    }
}
