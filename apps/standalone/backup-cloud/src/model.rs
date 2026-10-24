use std::{collections::BTreeMap, fmt, path::PathBuf};

use serde::{Deserialize, Serialize};
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::{Error, Result};

pub const REDIRECT_URI: &str = "http://127.0.0.1:45711/oauth/yandex/callback";
pub const SCOPES: [&str; 2] = ["cloud_api:disk.app_folder", "login:info"];
pub const JSON_CAP: u64 = 64 * 1024;
pub const SMALL_FILE_CAP: u64 = 1024 * 1024;
pub const DATABASE_CAP: u64 = 64 * 1024 * 1024 * 1024;
pub const OBJECTS: [&str; 4] = [
    "database.age",
    "manifest.age",
    "host-identity.age",
    "recovery-key.json",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClientProfile {
    pub format: u32,
    pub provider: String,
    pub client_id: String,
    pub redirect_uri: String,
    pub scopes: Vec<String>,
}

impl ClientProfile {
    pub fn new(client_id: &str) -> Result<Self> {
        let profile = Self {
            format: 1,
            provider: "yandex_disk".into(),
            client_id: client_id.into(),
            redirect_uri: REDIRECT_URI.into(),
            scopes: SCOPES.map(String::from).to_vec(),
        };
        profile.validate()?;
        Ok(profile)
    }

    pub fn validate(&self) -> Result<()> {
        if self.format != 1
            || self.provider != "yandex_disk"
            || self.redirect_uri != REDIRECT_URI
            || self.scopes != SCOPES
            || self.client_id.is_empty()
            || self.client_id.len() > 128
            || !self
                .client_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        {
            return Err(Error::InvalidFormat);
        }
        Ok(())
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<Self> {
        if bytes.len() as u64 > JSON_CAP {
            return Err(Error::SizeLimit);
        }
        let profile: Self = serde_json::from_slice(bytes).map_err(|_| Error::InvalidFormat)?;
        profile.validate()?;
        Ok(profile)
    }

    pub fn to_bytes(&self) -> Result<Vec<u8>> {
        self.validate()?;
        serde_json::to_vec_pretty(self).map_err(|_| Error::InvalidFormat)
    }
}

/// Intentionally no Serialize/Display: credentials have only an explicit native boundary.
#[derive(Clone)]
pub struct Secret(Zeroizing<String>);

impl Secret {
    pub fn new(value: String) -> Result<Self> {
        let value = Zeroizing::new(value);
        if value.is_empty()
            || value.len() > 8192
            || !value.bytes().all(|b| (0x21..=0x7e).contains(&b))
        {
            return Err(Error::InvalidFormat);
        }
        Ok(Self(value))
    }
    pub fn client_secret(value: String) -> Result<Self> {
        if value.len() > 512 {
            return Err(Error::InvalidFormat);
        }
        Self::new(value)
    }
    pub fn expose(&self) -> &str {
        self.0.as_str()
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("[REDACTED]")
    }
}

#[derive(Debug, Clone)]
pub struct TokenSet {
    pub access: Secret,
    pub refresh: Secret,
    pub expires_at: i64,
}

#[derive(Debug, Clone)]
pub struct RuntimeCredentials {
    pub profile: ClientProfile,
    pub client_secret: Secret,
    pub tokens: TokenSet,
    pub account_id: String,
    pub host_id: Uuid,
    pub generation: Uuid,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SnapshotId(pub Uuid);
impl SnapshotId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}
impl Default for SnapshotId {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone)]
pub struct NativeCopyPaths {
    pub database: PathBuf,
    pub manifest: PathBuf,
    pub identity: PathBuf,
}
impl NativeCopyPaths {
    pub fn beside(database: PathBuf) -> Self {
        Self {
            manifest: database.with_extension("json"),
            identity: database.with_extension("identity"),
            database,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ObjectRef {
    pub size_bytes: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompleteManifestV1 {
    pub format: u32,
    pub host_id: Uuid,
    pub snapshot_id: SnapshotId,
    pub created_at: String,
    pub schema_version: i64,
    pub app_version: String,
    pub organization_label: String,
    pub inn: String,
    pub oauth_client_id: String,
    pub tls_fingerprint: String,
    pub native_db_sha256: String,
    #[serde(deserialize_with = "unique_objects")]
    pub objects: BTreeMap<String, ObjectRef>,
}

fn unique_objects<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<BTreeMap<String, ObjectRef>, D::Error> {
    struct Objects;
    impl<'de> serde::de::Visitor<'de> for Objects {
        type Value = BTreeMap<String, ObjectRef>;
        fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.write_str("four unique backup objects")
        }
        fn visit_map<A: serde::de::MapAccess<'de>>(
            self,
            mut map: A,
        ) -> std::result::Result<Self::Value, A::Error> {
            let mut objects = BTreeMap::new();
            while let Some((key, value)) = map.next_entry::<String, ObjectRef>()? {
                if objects.insert(key, value).is_some() {
                    return Err(serde::de::Error::custom("duplicate backup object"));
                }
                if objects.len() > 4 {
                    return Err(serde::de::Error::custom("unexpected backup object"));
                }
            }
            Ok(objects)
        }
    }
    deserializer.deserialize_map(Objects)
}

pub fn is_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

impl CompleteManifestV1 {
    pub fn validate(&self, client_id: &str) -> Result<()> {
        let timestamp = time::OffsetDateTime::parse(
            &self.created_at,
            &time::format_description::well_known::Rfc3339,
        )
        .map_err(|_| Error::InvalidFormat)?;
        if self.format != 1
            || self.host_id.is_nil()
            || self.snapshot_id.0.is_nil()
            || self.schema_version < 1
            || timestamp.offset() != time::UtcOffset::UTC
            || self.oauth_client_id != client_id
            || !is_hash(&self.tls_fingerprint)
            || !is_hash(&self.native_db_sha256)
            || [&self.app_version, &self.organization_label, &self.inn]
                .iter()
                .any(|s| s.chars().count() > 200 || s.chars().any(char::is_control))
            || self.objects.len() != 4
        {
            return Err(Error::InvalidFormat);
        }
        ClientProfile::new(client_id)?;
        for name in OBJECTS {
            let object = self.objects.get(name).ok_or(Error::InvalidFormat)?;
            if !is_hash(&object.sha256)
                || object.size_bytes == 0
                || object.size_bytes > object_cap(name)?
            {
                return Err(Error::InvalidFormat);
            }
        }
        Ok(())
    }

    pub fn remote_dir(&self) -> String {
        format!("app:/backups/v1/{}/{}/", self.host_id, self.snapshot_id.0)
    }
}

pub fn object_cap(name: &str) -> Result<u64> {
    match name {
        "database.age" => Ok(DATABASE_CAP + DATABASE_CAP / 65536 * 16 + SMALL_FILE_CAP),
        "manifest.age" | "host-identity.age" => Ok(SMALL_FILE_CAP * 2),
        "recovery-key.json" | "complete.json" => Ok(JSON_CAP),
        _ => Err(Error::InvalidFormat),
    }
}
