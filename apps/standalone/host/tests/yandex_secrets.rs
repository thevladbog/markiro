use markiro_backup_cloud::{model::*, Error, Result};
use markiro_host::yandex::secret_store::{Protector, ServiceCredentialStore};

struct SyntheticCipher;
impl Protector for SyntheticCipher {
    fn protect(&self, bytes: &[u8]) -> Result<Vec<u8>> {
        Ok(bytes.iter().map(|b| b ^ 0xa5).collect())
    }
    fn unprotect(&self, bytes: &[u8]) -> Result<Vec<u8>> {
        self.protect(bytes)
    }
}
fn credentials() -> RuntimeCredentials {
    RuntimeCredentials {
        profile: ClientProfile::new("client").unwrap(),
        client_secret: Secret::client_secret("customer-secret".into()).unwrap(),
        tokens: TokenSet {
            access: Secret::new("access-token".into()).unwrap(),
            refresh: Secret::new("refresh-token".into()).unwrap(),
            expires_at: 4000,
        },
        account_id: "account".into(),
        host_id: uuid::Uuid::new_v4(),
        generation: uuid::Uuid::new_v4(),
    }
}

#[test]
fn only_ciphertext_survives_restart_and_clear_is_idempotent() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("cloud-private");
    let store = ServiceCredentialStore::with_protector(&path, SyntheticCipher).unwrap();
    let creds = credentials();
    store.replace(&creds).unwrap();
    let bytes = std::fs::read(path.join("credentials.dpapi")).unwrap();
    for secret in ["customer-secret", "access-token", "refresh-token"] {
        assert!(!bytes.windows(secret.len()).any(|w| w == secret.as_bytes()));
    }
    drop(store);
    let reopened = ServiceCredentialStore::with_protector(&path, SyntheticCipher).unwrap();
    let loaded = reopened.load().unwrap().unwrap();
    assert_eq!(loaded.tokens.refresh.expose(), "refresh-token");
    assert_eq!(loaded.generation, creds.generation);
    reopened.clear().unwrap();
    reopened.clear().unwrap();
    assert!(reopened.load().unwrap().is_none());
}

struct Refuse;
impl Protector for Refuse {
    fn protect(&self, _: &[u8]) -> Result<Vec<u8>> {
        Err(Error::SecretUnavailable)
    }
    fn unprotect(&self, _: &[u8]) -> Result<Vec<u8>> {
        Err(Error::SecretUnavailable)
    }
}
#[test]
fn protection_failure_preserves_previous_file_and_creates_no_plaintext() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("cloud-private");
    ServiceCredentialStore::with_protector(&path, SyntheticCipher)
        .unwrap()
        .replace(&credentials())
        .unwrap();
    let before = std::fs::read(path.join("credentials.dpapi")).unwrap();
    let refusing = ServiceCredentialStore::with_protector(&path, Refuse).unwrap();
    assert!(refusing.replace(&credentials()).is_err());
    assert_eq!(
        std::fs::read(path.join("credentials.dpapi")).unwrap(),
        before
    );
    assert_eq!(std::fs::read_dir(path).unwrap().count(), 1);
}

#[cfg(not(windows))]
#[test]
fn production_has_no_non_windows_plaintext_fallback() {
    let tmp = tempfile::tempdir().unwrap();
    let store = ServiceCredentialStore::new(&tmp.path().join("cloud-private")).unwrap();
    assert!(matches!(
        store.replace(&credentials()),
        Err(Error::SecretUnavailable)
    ));
}
