use markiro_backup_cloud::{
    client::{DiskClient, RequestGuard},
    model::Secret,
    Error, Result,
};
use std::{
    future::Future,
    pin::Pin,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
};
struct Deny(AtomicUsize);
impl RequestGuard for Deny {
    fn check(&self) -> Pin<Box<dyn Future<Output = Result<()>> + Send + '_>> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Err(Error::InvalidAttempt) })
    }
}
#[tokio::test]
async fn cancelled_generation_is_denied_before_any_provider_request() {
    let guard = Arc::new(Deny(AtomicUsize::new(0)));
    let client = DiskClient::new(Secret::new("synthetic".into()).unwrap())
        .unwrap()
        .with_guard(guard.clone());
    assert!(matches!(client.account().await, Err(Error::InvalidAttempt)));
    assert!(matches!(
        client
            .ensure_snapshot_dir(uuid::Uuid::new_v4(), uuid::Uuid::new_v4())
            .await,
        Err(Error::InvalidAttempt)
    ));
    assert_eq!(guard.0.load(Ordering::SeqCst), 2);
}
