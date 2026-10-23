//! Strict commit-marker discovery; provider child names are never local paths.
use crate::{
    client::{DiskClient, RemoteObject},
    envelope,
    model::{CompleteManifestV1, JSON_CAP},
    Error, Result,
};
use std::path::Path;
use uuid::Uuid;

pub async fn list(
    client: &DiskClient,
    client_id: &str,
    host: Option<Uuid>,
    workspace: &Path,
) -> Result<Vec<CompleteManifestV1>> {
    envelope::private_dir(workspace)?;
    let result = async {
        let hosts = match host {
            Some(id) => vec![id],
            None => client
                .list(None, None)
                .await?
                .into_iter()
                .filter(|r| r.kind == "dir")
                .filter_map(|r| Uuid::parse_str(&r.name).ok())
                .collect(),
        };
        let mut copies = Vec::new();
        let mut examined = 0usize;
        for host in hosts {
            for resource in client.list(Some(host), None).await? {
                if resource.kind != "dir" {
                    continue;
                }
                let Ok(id) = Uuid::parse_str(&resource.name) else {
                    continue;
                };
                examined += 1;
                if examined > 10_000 {
                    return Err(Error::SizeLimit);
                }
                let path = workspace.join(format!("{}.json", Uuid::new_v4()));
                match client
                    .get_stream(&RemoteObject::new(host, id, "complete.json")?, &path)
                    .await
                {
                    Err(Error::Provider("not_found")) => continue,
                    Err(error) => return Err(error),
                    Ok(()) => {}
                }
                let data = envelope::read_bounded(&path, JSON_CAP)?;
                let _ = std::fs::remove_file(path);
                let Ok(complete) = serde_json::from_slice::<CompleteManifestV1>(&data) else {
                    continue;
                };
                if complete.host_id != host
                    || complete.snapshot_id.0 != id
                    || complete.validate(client_id).is_err()
                {
                    continue;
                }
                copies.push(complete);
            }
        }
        Ok(copies)
    }
    .await;
    let _ = tokio::fs::remove_dir_all(workspace).await;
    result
}
