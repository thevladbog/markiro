use markiro_backup_cloud::{
    model::{ClientProfile, SnapshotId},
    publication::{publish, ObjectTransport},
    Error, Result,
};
use std::{
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    sync::Mutex,
};
struct Remote {
    files: PathBuf,
    events: Mutex<Vec<String>>,
    corrupt: bool,
}
impl ObjectTransport for Remote {
    fn put<'a>(
        &'a self,
        name: &'a str,
        source: &'a Path,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + 'a>> {
        Box::pin(async move {
            self.events.lock().unwrap().push(format!("put:{name}"));
            std::fs::copy(source, self.files.join(name))?;
            Ok(())
        })
    }
    fn get<'a>(
        &'a self,
        name: &'a str,
        target: &'a Path,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + 'a>> {
        Box::pin(async move {
            self.events.lock().unwrap().push(format!("get:{name}"));
            std::fs::copy(self.files.join(name), target)?;
            if self.corrupt && name == "database.age" {
                std::fs::write(target, b"corrupt")?;
            }
            Ok(())
        })
    }
}
#[tokio::test]
async fn complete_is_last_and_only_after_fresh_download_and_native_verification() {
    for corrupt in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let native = source(dir.path());
        let profile = ClientProfile::new("client").unwrap();
        let staged = markiro_backup_cloud::envelope::seal_copy(
            &native,
            &profile,
            &dir.path().join("stage"),
            SnapshotId::new(),
        )
        .unwrap();
        let files = dir.path().join("remote");
        std::fs::create_dir(&files).unwrap();
        let remote = Remote {
            files,
            events: Mutex::new(Vec::new()),
            corrupt,
        };
        let result = publish(
            &remote,
            &staged,
            &profile.client_id,
            &dir.path().join("verify"),
            |paths| async move {
                if std::fs::read(paths.database)? != b"synthetic sqlite bytes" {
                    return Err(Error::Integrity);
                }
                Ok(())
            },
        )
        .await;
        let events = remote.events.lock().unwrap();
        if corrupt {
            assert!(result.is_err());
            assert!(!events.iter().any(|e| e == "put:complete.json"));
        } else {
            result.unwrap();
            assert_eq!(
                &events[events.len() - 2..],
                ["put:complete.json", "get:complete.json"]
            );
            for name in markiro_backup_cloud::model::OBJECTS {
                assert!(
                    events
                        .iter()
                        .position(|e| e == &format!("get:{name}"))
                        .unwrap()
                        < events.len() - 2
                );
            }
        }
        assert!(!dir.path().join("verify").exists());
    }
}

fn source(dir: &Path) -> markiro_backup_cloud::model::NativeCopyPaths {
    use markiro_backup_cloud::{
        envelope::hash_file,
        model::{NativeCopyPaths, SMALL_FILE_CAP},
    };
    let paths = NativeCopyPaths::beside(dir.join("markiro-host-test.db"));
    std::fs::write(&paths.database, b"synthetic sqlite bytes").unwrap();
    let host = uuid::Uuid::new_v4();
    std::fs::write(
        &paths.identity,
        serde_json::to_vec(&serde_json::json!({"format":1,"hostId":host})).unwrap(),
    )
    .unwrap();
    let db = hash_file(&paths.database, SMALL_FILE_CAP).unwrap();
    let identity = hash_file(&paths.identity, SMALL_FILE_CAP).unwrap();
    std::fs::write(&paths.manifest,serde_json::to_vec(&serde_json::json!({"format":1,"file":"markiro-host-test.db","hostId":host,"createdAt":"2026-10-23T00:00:00Z","schemaVersion":1,"sizeBytes":db.size_bytes,"sha256":db.sha256,"identity":{"sizeBytes":identity.size_bytes,"sha256":identity.sha256,"fingerprint":"a".repeat(64)}})).unwrap()).unwrap();
    paths
}
