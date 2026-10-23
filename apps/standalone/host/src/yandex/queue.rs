//! Native-source pins end after private staging, before network delivery.
use super::state::{DeliveryStore, Job};
use markiro_backup_cloud::{Error, Result};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};
use tokio::sync::Mutex as AsyncMutex;
use uuid::Uuid;

#[derive(Default)]
pub struct SnapshotPins(Mutex<BTreeMap<String, usize>>);
impl SnapshotPins {
    fn pin(self: &Arc<Self>, name: &str) -> SourcePin {
        *self
            .0
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .entry(name.into())
            .or_default() += 1;
        SourcePin {
            registry: self.clone(),
            name: name.into(),
        }
    }
    pub fn names(&self) -> Vec<String> {
        self.0
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .keys()
            .cloned()
            .collect()
    }
    /// Hold the registry lock throughout local deletion: acquisition of a new
    /// pin and a rotation cannot cross between their check and file removal.
    pub fn while_pinned<T>(&self, f: impl FnOnce(&[String]) -> T) -> T {
        let pins = self.0.lock().unwrap_or_else(|p| p.into_inner());
        f(&pins.keys().cloned().collect::<Vec<_>>())
    }
}
pub struct SourcePin {
    registry: Arc<SnapshotPins>,
    name: String,
}
impl Clone for SourcePin {
    fn clone(&self) -> Self {
        self.registry.pin(&self.name)
    }
}
impl Drop for SourcePin {
    fn drop(&mut self) {
        let mut pins = self.registry.0.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(n) = pins.get_mut(&self.name) {
            *n -= 1;
            if *n == 0 {
                pins.remove(&self.name);
            }
        }
    }
}
struct QueuedPins {
    pending: Option<SourcePin>,
    active: Option<SourcePin>,
}
pub struct CloudQueue {
    pub pins: Arc<SnapshotPins>,
    journal: Arc<DeliveryStore>,
    queued: AsyncMutex<QueuedPins>,
}
impl CloudQueue {
    pub async fn open(journal: Arc<DeliveryStore>) -> Result<Arc<Self>> {
        let state = journal.status().await?;
        let pins = Arc::new(SnapshotPins::default());
        let pending = state.pending.as_deref().map(|name| pins.pin(name));
        let active = state.active.as_ref().map(|job| pins.pin(&job.source_file));
        Ok(Arc::new(Self {
            pins,
            journal,
            queued: AsyncMutex::new(QueuedPins { pending, active }),
        }))
    }
    pub async fn offer(&self, file: &str) -> Result<()> {
        if !super::state::source_name(file) {
            return Err(Error::InvalidFormat);
        }
        let mut queued = self.queued.lock().await;
        let state = self.journal.status().await?;
        let Some(binding) = state.binding else {
            queued.pending = None;
            queued.active = None;
            return Ok(());
        };
        if state.paused
            || state.active.as_ref().is_some_and(|j| j.source_file == file)
            || state.last_source_file.as_deref() == Some(file)
            || state.rejected_source.as_deref() == Some(file)
        {
            return Ok(());
        }
        let pin = self.pins.pin(file);
        self.journal
            .enqueue_latest(binding.generation, file)
            .await?;
        queued.pending = Some(pin);
        Ok(())
    }
    pub async fn claim(&self, generation: Uuid) -> Result<Option<(Job, SourcePin)>> {
        let mut queued = self.queued.lock().await;
        let Some(job) = self.journal.claim(generation).await? else {
            return Ok(None);
        };
        let pin = if queued
            .active
            .as_ref()
            .is_some_and(|p| p.name == job.source_file)
        {
            queued.active.take()
        } else if queued
            .pending
            .as_ref()
            .is_some_and(|p| p.name == job.source_file)
        {
            queued.pending.take()
        } else {
            None
        }
        .unwrap_or_else(|| self.pins.pin(&job.source_file));
        queued.active = Some(pin.clone());
        Ok(Some((job, pin)))
    }
    pub async fn staged(&self, file: &str) {
        let mut queued = self.queued.lock().await;
        if queued.active.as_ref().is_some_and(|p| p.name == file) {
            queued.active = None;
        }
    }
    pub async fn clear(&self) {
        let mut queued = self.queued.lock().await;
        queued.pending = None;
        queued.active = None;
    }
    pub async fn transition(
        &self,
        change: impl std::future::Future<Output = Result<()>>,
    ) -> Result<()> {
        let mut queued = self.queued.lock().await;
        change.await?;
        queued.pending = None;
        queued.active = None;
        Ok(())
    }
}
