//! Backups and restore (plan РК): the office's view of the host's copies
//! (`GET /v1/office/backups`), the second folder setting, and a station's
//! blocks of SSCC serials that it registers again after the host was
//! restored from a copy (`POST /v1/device/sscc/blocks/known`).

use serde::{Deserialize, Serialize};

/// Why a copy into one folder failed (`BackupAttempt::code`); the office
/// shows text by code.
pub mod failure {
    /// The folder is not there: an unplugged USB drive, a computer that is
    /// off, a share that is gone.
    pub const DESTINATION_UNAVAILABLE: &str = "destination_unavailable";
    /// The host's account may not write there.
    pub const ACCESS_DENIED: &str = "access_denied";
    pub const DISK_FULL: &str = "disk_full";
    /// Any other write failure.
    pub const WRITE_FAILED: &str = "write_failed";
    /// The copy was written but did not check out (`integrity_check`, size
    /// or SHA-256): it was deleted.
    pub const VERIFY_FAILED: &str = "verify_failed";
    /// The second folder got nothing because the local copy failed.
    pub const LOCAL_COPY_FAILED: &str = "local_copy_failed";
    /// The copy stopped on an error of the host itself.
    pub const INTERNAL: &str = "internal";

    pub const ALL: &[&str] = &[
        DESTINATION_UNAVAILABLE,
        ACCESS_DENIED,
        DISK_FULL,
        WRITE_FAILED,
        VERIFY_FAILED,
        LOCAL_COPY_FAILED,
        INTERNAL,
    ];
}

/// `details.reason` of a `conflict` on `backup_dir`: why the second folder
/// cannot be used. The host tries the folder before it saves it.
pub mod dir_problems {
    pub const MISSING: &str = "missing";
    pub const NOT_A_DIRECTORY: &str = "not_a_directory";
    pub const ACCESS_DENIED: &str = "access_denied";
    pub const UNWRITABLE: &str = "unwritable";
    /// The folder did not answer in time (a share on a computer that is off).
    pub const TIMEOUT: &str = "timeout";
    /// The folder is the host's data folder or inside it: a copy there dies
    /// with the data.
    pub const INSIDE_DATA_DIR: &str = "inside_data_dir";

    pub const ALL: &[&str] = &[
        MISSING,
        NOT_A_DIRECTORY,
        ACCESS_DENIED,
        UNWRITABLE,
        TIMEOUT,
        INSIDE_DATA_DIR,
    ];
}

/// What started a copy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BackupTrigger {
    /// The host's schedule: hourly while the data changes, at least daily.
    Scheduled,
    /// «Сделать копию сейчас» in the office.
    Manual,
}

/// One verified copy in a folder: the database file `file` and its manifest
/// beside it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupCopy {
    pub file: String,
    /// UTC RFC 3339.
    pub created_at: String,
    pub trigger: BackupTrigger,
    pub size_bytes: u64,
    /// Lower-case hex SHA-256 of the file.
    pub sha256: String,
}

/// The last copy the host tried to make in a folder since it started.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupAttempt {
    pub at: String,
    pub trigger: BackupTrigger,
    pub ok: bool,
    /// One of [`failure`] when `ok` is false.
    pub code: Option<String>,
}

/// One folder of copies.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupDestination {
    pub dir: String,
    /// `None` until the host tried this folder after it started.
    pub last_attempt: Option<BackupAttempt>,
    /// The verified copies in the folder, newest first.
    pub copies: Vec<BackupCopy>,
}

/// A copy in progress.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupRunning {
    pub trigger: BackupTrigger,
    pub started_at: String,
}

/// A station after a restore: whether it gave its blocks back yet.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreHoldStation {
    pub id: String,
    pub name: String,
    pub last_seen_at: Option<String>,
    /// It sent its blocks (`POST /v1/device/sscc/blocks/known`) since the
    /// restore.
    pub reconciled: bool,
}

/// The host holds the stations' facts since `markiro-host restore`: it
/// answers them `restore_pending` until an administrator resumes, so no
/// fact is refused for good against a copy that lacks its shift or block.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreHold {
    pub since: String,
    pub epoch: String,
    /// The unrevoked stations.
    pub stations: Vec<RestoreHoldStation>,
}

/// `GET /v1/office/backups`; `POST` (a copy now), `PUT …/settings` and
/// `POST …/resume` answer it too.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupState {
    /// The host's clock: how old the newest copy is.
    pub now: String,
    pub local: BackupDestination,
    /// `None` until an administrator names a second folder.
    pub second: Option<BackupDestination>,
    /// For `expectedRev` of the settings.
    pub settings_rev: i64,
    pub running: Option<BackupRunning>,
    /// `Some` from a restore until an administrator resumes the facts.
    pub restore_hold: Option<RestoreHold>,
}

/// `PUT /v1/office/backups/settings`: the second folder (an absolute path:
/// a folder on a USB drive or a share, `\\PC\Share\Markiro`), or `null` to
/// stop copying there. `secondDir` is required: a body without it must not
/// clear the folder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackupSettingsUpdate {
    #[serde(deserialize_with = "Option::deserialize")]
    pub second_dir: Option<String>,
    pub expected_rev: i64,
}

/// One block a station holds, as it got it from the host.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnownBlock {
    pub id: String,
    pub issuer_prefix: String,
    pub extension: u8,
    pub from_serial: u64,
    pub to_serial: u64,
}

/// `POST /v1/device/sscc/blocks/known`: after the host's `restoreEpoch`
/// changed, a station sends every block it holds; the host takes back those
/// a copy lost.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnownBlocksRequest {
    pub blocks: Vec<KnownBlock>,
}

/// What became of one block.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KnownBlockOutcome {
    /// The host had lost it and holds it again.
    Registered,
    /// The host has it already, exactly so.
    Known,
    /// The host cannot take it (`code`): the serials may never be used.
    Refused,
}

/// Codes of a refused block.
pub mod known_block_codes {
    /// The host has a block with this id, but another one.
    pub const BLOCK_MISMATCH: &str = "block_mismatch";
    /// Another block holds some of these serials.
    pub const BLOCK_OVERLAP: &str = "block_overlap";
    /// The host has no counter of this prefix and extension.
    pub const PREFIX_UNKNOWN: &str = "prefix_unknown";
    /// The serials are no range of this prefix.
    pub const RANGE_INVALID: &str = "range_invalid";

    pub const ALL: &[&str] = &[BLOCK_MISMATCH, BLOCK_OVERLAP, PREFIX_UNKNOWN, RANGE_INVALID];
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownBlockResult {
    pub id: String,
    pub outcome: KnownBlockOutcome,
    /// One of [`known_block_codes`] when refused.
    pub code: Option<String>,
}

/// The answer: one result per block, in the request's order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownBlocksResponse {
    pub results: Vec<KnownBlockResult>,
}
