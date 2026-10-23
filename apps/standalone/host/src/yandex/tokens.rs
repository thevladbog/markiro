//! Token lifetime belongs to the host, independently of an office window.
use super::{
    secret_store::{Protector, ServiceCredentialStore},
    state::{Binding, CloudAuditEvent, DeliveryStore, SourceContext},
};
use markiro_backup_cloud::{
    model::RuntimeCredentials,
    oauth::{OAuthClient, Transport},
    Error, Result,
};
use std::sync::Arc;
use tokio::sync::Mutex;
use uuid::Uuid;

/// All service credential mutations share this coordinator. Network awaits do
/// not hold mutation: disconnect can fence an in-flight refresh immediately.
pub struct TokenSupervisor<T: Transport, P: Protector> {
    store: Arc<ServiceCredentialStore<P>>,
    journal: Arc<DeliveryStore>,
    host_id: Uuid,
    oauth: OAuthClient<T>,
    mutation: Mutex<()>,
    refresh: Mutex<()>,
}
impl<T: Transport + 'static, P: Protector + 'static> TokenSupervisor<T, P> {
    pub fn new(
        store: Arc<ServiceCredentialStore<P>>,
        journal: Arc<DeliveryStore>,
        host_id: Uuid,
        oauth: OAuthClient<T>,
    ) -> Self {
        Self {
            store,
            journal,
            host_id,
            oauth,
            mutation: Mutex::new(()),
            refresh: Mutex::new(()),
        }
    }

    async fn load(&self) -> Result<Option<RuntimeCredentials>> {
        let store = self.store.clone();
        tokio::task::spawn_blocking(move || store.load())
            .await
            .map_err(|_| Error::SecretUnavailable)?
    }
    async fn save(&self, credentials: RuntimeCredentials) -> Result<()> {
        let store = self.store.clone();
        tokio::task::spawn_blocking(move || store.replace(&credentials))
            .await
            .map_err(|_| Error::SecretUnavailable)?
    }
    async fn clear(&self) -> Result<()> {
        let store = self.store.clone();
        tokio::task::spawn_blocking(move || store.clear())
            .await
            .map_err(|_| Error::SecretUnavailable)?
    }

    /// Completes only the generation against which the native attempt began.
    /// Native connect/handoff must first validate grant, account and app folder.
    /// Caller cancellation never releases an in-progress credential mutation.
    pub async fn replace_if_current(
        self: &Arc<Self>,
        credentials: RuntimeCredentials,
        expected: Option<Uuid>,
    ) -> Result<()> {
        self.replace_with_event(credentials, expected, None).await
    }

    pub async fn replace_with_event(
        self: &Arc<Self>,
        credentials: RuntimeCredentials,
        expected: Option<Uuid>,
        event: Option<CloudAuditEvent>,
    ) -> Result<()> {
        self.replace_for_source(credentials, expected, event, SourceContext::default())
            .await
    }
    pub async fn replace_for_source(
        self: &Arc<Self>,
        credentials: RuntimeCredentials,
        expected: Option<Uuid>,
        event: Option<CloudAuditEvent>,
        source: SourceContext,
    ) -> Result<()> {
        let owner = self.clone();
        tokio::spawn(async move {
            owner
                .replace_inner(credentials, expected, event, source)
                .await
        })
        .await
        .map_err(|_| Error::SecretUnavailable)?
    }

    async fn replace_inner(
        &self,
        credentials: RuntimeCredentials,
        expected: Option<Uuid>,
        event: Option<CloudAuditEvent>,
        source: SourceContext,
    ) -> Result<()> {
        if credentials.host_id != self.host_id {
            return Err(Error::InvalidAttempt);
        }
        credentials.profile.validate()?;
        let binding = Binding {
            generation: credentials.generation,
            client_id: credentials.profile.client_id.clone(),
            account_id: credentials.account_id.clone(),
            host_id: self.host_id,
            source,
        };
        let _mutation = self.mutation.lock().await;
        if self.journal.status().await?.connection_generation != expected {
            return Err(Error::InvalidAttempt);
        }
        let store = self.store.clone();
        let previous = tokio::task::spawn_blocking(move || store.snapshot_ciphertext())
            .await
            .map_err(|_| Error::SecretUnavailable)??;
        self.save(credentials).await?;
        if let Err(error) = self.journal.connect_with_event(&binding, event).await {
            // Roll back the file if the journal commit failed. A crash between
            // these commits leaves a mismatched binding, which tick refuses.
            let store = self.store.clone();
            tokio::task::spawn_blocking(move || store.restore_ciphertext(previous))
                .await
                .map_err(|_| Error::SecretUnavailable)??;
            return Err(error);
        }
        Ok(())
    }

    pub async fn disconnect(self: &Arc<Self>, generation: Uuid) -> Result<()> {
        self.disconnect_with_event(generation, None).await
    }
    pub async fn disconnect_with_event(
        self: &Arc<Self>,
        generation: Uuid,
        event: Option<CloudAuditEvent>,
    ) -> Result<()> {
        let owner = self.clone();
        tokio::spawn(async move {
            let _mutation = owner.mutation.lock().await;
            owner
                .journal
                .disconnect_with_event(generation, event)
                .await?;
            owner.clear().await
        })
        .await
        .map_err(|_| Error::SecretUnavailable)?
    }

    pub async fn current_credentials(&self) -> Result<Option<RuntimeCredentials>> {
        let _mutation = self.mutation.lock().await;
        let state = self.journal.status().await?;
        if state.paused {
            return Err(Error::Provider("client_secret_required"));
        }
        super::runtime::require_refresh_allowed(state.connection_error)?;
        let Some(binding) = state.binding else {
            return Ok(None);
        };
        let credentials = self.load().await?.ok_or(Error::SecretUnavailable)?;
        if credentials.host_id != self.host_id
            || credentials.generation != binding.generation
            || credentials.profile.client_id != binding.client_id
            || credentials.account_id != binding.account_id
        {
            return Err(Error::SecretUnavailable);
        }
        Ok(Some(credentials))
    }

    /// One refresh at a time per coordinator. Caller owns scheduling/backoff;
    /// no office/session/browser is needed by this operation.
    pub async fn tick(self: &Arc<Self>, now: i64) -> Result<bool> {
        let _refresh = self.refresh.lock().await;
        let credentials = {
            let _mutation = self.mutation.lock().await;
            let state = self.journal.status().await?;
            if state.paused {
                return Err(Error::Provider("client_secret_required"));
            }
            super::runtime::require_refresh_allowed(state.connection_error)?;
            let Some(binding) = state.binding else {
                return Ok(false);
            };
            let credentials = self.load().await?.ok_or(Error::SecretUnavailable)?;
            if credentials.host_id != self.host_id
                || credentials.generation != binding.generation
                || credentials.profile.client_id != binding.client_id
                || credentials.account_id != binding.account_id
            {
                return Err(Error::SecretUnavailable);
            }
            if credentials.tokens.expires_at > now.saturating_add(300) {
                return Ok(false);
            }
            credentials
        };
        let tokens = self.oauth.refresh(&credentials, now).await?;
        let owner = self.clone();
        tokio::spawn(async move {
            let _mutation = owner.mutation.lock().await;
            if !owner.journal.is_current(credentials.generation).await? {
                return Err(Error::InvalidAttempt);
            }
            owner
                .save(RuntimeCredentials {
                    tokens,
                    ..credentials
                })
                .await
        })
        .await
        .map_err(|_| Error::SecretUnavailable)??;
        Ok(true)
    }
}
