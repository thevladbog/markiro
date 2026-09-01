//! A short in-memory journal mirrored into the tray window.
//!
//! Credentials must never land here: the cloud holds the authoritative audit,
//! and this file is readable by anything running as the operator.

use std::collections::VecDeque;
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead as _, BufReader, Write as _};
use std::path::{Path, PathBuf};

use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;
use zip::write::SimpleFileOptions;

const DEFAULT_CAPACITY: usize = 200;
const DEFAULT_MAX_FILE_SIZE: u64 = 1024 * 1024;
const DEFAULT_MAX_FILES: usize = 7;
const LOG_FILE_NAME: &str = "signer.jsonl";

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalEntry {
    pub occurred_at: String,
    pub message: String,
    pub detail: Option<String>,
}

impl JournalEntry {
    pub fn new(message: impl Into<String>, detail: Option<&str>) -> Self {
        let occurred_at = OffsetDateTime::now_utc()
            .format(&Rfc3339)
            .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string());
        Self::new_at(message, detail, occurred_at)
    }

    pub fn new_at(
        message: impl Into<String>,
        detail: Option<&str>,
        occurred_at: impl Into<String>,
    ) -> Self {
        Self {
            occurred_at: occurred_at.into(),
            message: message.into(),
            detail: detail.map(redact),
        }
    }
}

/// Replaces JWT-shaped and long base64-ish runs, which is what a leaked token
/// or agent secret would look like in an error string.
///
/// Scans for qualifying runs *within* the string rather than splitting on
/// whitespace: the only untrusted text that reaches the journal is
/// `error.to_string()`, and `SignerError::TrueApi` embeds up to 1000 chars of
/// the raw True API JSON response body, where a token sits between
/// punctuation -- e.g. `{"token":"notarealheader.notarealpayload.notarealsig"}` -- not
/// between spaces. Any character that cannot appear in a base64url/JWT token
/// (including `{}"',:;()[]` and whitespace) ends the current run.
///
/// `pub(crate)` rather than private: `runtime::Runtime` applies the same
/// scrub to `AgentStatus.last_error` before it reaches the UI or a Windows
/// notification, which must never show a raw True API response body either.
pub(crate) fn redact(detail: &str) -> String {
    const MIN_LEN: usize = 24;

    fn flush(run: &mut String, out: &mut String) {
        if run.len() >= MIN_LEN {
            out.push_str("[redacted]");
        } else {
            out.push_str(run);
        }
        run.clear();
    }

    let mut out = String::with_capacity(detail.len());
    let mut run = String::new();
    for c in detail.chars() {
        let is_token_char =
            c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '+' | '/' | '=');
        if is_token_char {
            run.push(c);
        } else {
            flush(&mut run, &mut out);
            out.push(c);
        }
    }
    flush(&mut run, &mut out);
    out
}

#[derive(Debug)]
pub struct Journal {
    capacity: usize,
    entries: VecDeque<JournalEntry>,
    storage: Option<JournalStorage>,
}

#[derive(Debug)]
struct JournalStorage {
    directory: PathBuf,
    max_file_size: u64,
    max_files: usize,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalExportMetadata {
    pub app_version: String,
    pub hostname: String,
    pub tenant_name: Option<String>,
}

impl Default for Journal {
    fn default() -> Self {
        Self::with_capacity(DEFAULT_CAPACITY)
    }
}

impl Journal {
    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            capacity: capacity.max(1),
            entries: VecDeque::new(),
            storage: None,
        }
    }

    pub fn open(directory: impl AsRef<Path>) -> io::Result<Self> {
        Self::open_with_limits(
            directory,
            DEFAULT_CAPACITY,
            DEFAULT_MAX_FILE_SIZE,
            DEFAULT_MAX_FILES,
        )
    }

    pub fn open_with_limits(
        directory: impl AsRef<Path>,
        capacity: usize,
        max_file_size: u64,
        max_files: usize,
    ) -> io::Result<Self> {
        let storage = JournalStorage {
            directory: directory.as_ref().to_path_buf(),
            max_file_size: max_file_size.max(1),
            max_files: max_files.max(1),
        };
        fs::create_dir_all(&storage.directory)?;
        let mut journal = Self {
            capacity: capacity.max(1),
            entries: VecDeque::new(),
            storage: Some(storage),
        };
        for entry in journal.read_persisted_entries()? {
            journal.append_in_memory(entry);
        }
        Ok(journal)
    }

    pub fn append(&mut self, entry: JournalEntry) {
        if let Err(error) = self.persist(&entry) {
            tracing::warn!(%error, "could not persist signer journal entry");
        }
        self.append_in_memory(entry);
    }

    pub fn entries(&self) -> Vec<JournalEntry> {
        self.entries.iter().cloned().collect()
    }

    pub fn export_zip(
        &self,
        destination: impl AsRef<Path>,
        metadata: &JournalExportMetadata,
    ) -> io::Result<()> {
        let entries = if self.storage.is_some() {
            self.read_persisted_entries()?
        } else {
            self.entries()
        };
        let file = File::create(destination)?;
        let mut archive = zip::ZipWriter::new(file);
        let options =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);

        archive.start_file("events.jsonl", options)?;
        for entry in &entries {
            serde_json::to_writer(&mut archive, entry).map_err(io::Error::other)?;
            archive.write_all(b"\n")?;
        }

        archive.start_file("events.txt", options)?;
        for entry in &entries {
            let detail = entry
                .detail
                .as_deref()
                .map(single_line)
                .filter(|value| !value.is_empty());
            write!(
                archive,
                "{}  {}",
                single_line(&entry.occurred_at),
                single_line(&entry.message)
            )?;
            if let Some(detail) = detail {
                write!(archive, "  {detail}")?;
            }
            archive.write_all(b"\n")?;
        }

        archive.start_file("metadata.json", options)?;
        serde_json::to_writer_pretty(
            &mut archive,
            &serde_json::json!({
                "exportedAt": OffsetDateTime::now_utc()
                    .format(&Rfc3339)
                    .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string()),
                "appVersion": metadata.app_version,
                "hostname": metadata.hostname,
                "tenantName": metadata.tenant_name,
            }),
        )
        .map_err(io::Error::other)?;
        archive.finish()?;
        Ok(())
    }

    fn append_in_memory(&mut self, entry: JournalEntry) {
        if self.entries.len() == self.capacity {
            self.entries.pop_front();
        }
        self.entries.push_back(entry);
    }

    fn persist(&self, entry: &JournalEntry) -> io::Result<()> {
        let Some(storage) = self.storage.as_ref() else {
            return Ok(());
        };
        let mut line = serde_json::to_vec(entry).map_err(io::Error::other)?;
        line.push(b'\n');
        let active = storage.path_for(0);
        let active_size = active
            .metadata()
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        if active_size > 0 && active_size.saturating_add(line.len() as u64) > storage.max_file_size
        {
            storage.rotate()?;
        }
        let mut file = OpenOptions::new().create(true).append(true).open(active)?;
        file.write_all(&line)
    }

    fn read_persisted_entries(&self) -> io::Result<Vec<JournalEntry>> {
        let Some(storage) = self.storage.as_ref() else {
            return Ok(self.entries());
        };
        let mut entries = Vec::new();
        for index in (0..storage.max_files).rev() {
            let path = storage.path_for(index);
            let file = match File::open(path) {
                Ok(file) => file,
                Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error),
            };
            for line in BufReader::new(file).lines() {
                let Ok(line) = line else {
                    continue;
                };
                if let Ok(entry) = serde_json::from_str::<JournalEntry>(&line) {
                    entries.push(entry);
                }
            }
        }
        Ok(entries)
    }
}

impl JournalStorage {
    fn path_for(&self, index: usize) -> PathBuf {
        if index == 0 {
            self.directory.join(LOG_FILE_NAME)
        } else {
            self.directory.join(format!("{LOG_FILE_NAME}.{index}"))
        }
    }

    fn rotate(&self) -> io::Result<()> {
        let oldest = self.path_for(self.max_files - 1);
        match fs::remove_file(oldest) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        for index in (1..self.max_files).rev() {
            let source = self.path_for(index - 1);
            let target = self.path_for(index);
            match fs::rename(source, target) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
        }
        Ok(())
    }
}

fn single_line(value: &str) -> String {
    value.replace(['\r', '\n'], " ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read as _;

    #[test]
    fn redacts_anything_that_looks_like_a_credential() {
        let entry = JournalEntry::new("token refreshed", Some("Bearer notarealheader.notarealpayload.notarealsig"));
        assert!(!entry.detail.as_deref().unwrap_or_default().contains("notarealheader"));
        assert!(entry.detail.as_deref().unwrap_or_default().contains("[redacted]"));
    }

    #[test]
    fn redacts_a_token_embedded_in_a_raw_true_api_json_body() {
        // This is the shape `SignerError::TrueApi` actually produces: the raw
        // response body, punctuation and all -- not whitespace-delimited
        // words. A prior version only split on whitespace and let this
        // through verbatim.
        let entry = JournalEntry::new(
            "True API rejected the request",
            Some(r#"{"token":"notarealheader.notarealpayload.notarealsig","status":"ok"}"#),
        );
        let detail = entry.detail.as_deref().unwrap_or_default();
        assert!(!detail.contains("notarealheader.notarealpayload.notarealsig"));
        assert!(detail.contains("[redacted]"));
        // Surrounding structure and short fields survive untouched.
        assert!(detail.contains(r#""token":"#));
        assert!(detail.contains(r#""status":"ok""#));
    }

    #[test]
    fn keeps_only_the_most_recent_entries() {
        let mut journal = Journal::with_capacity(2);
        journal.append(JournalEntry::new("one", None));
        journal.append(JournalEntry::new("two", None));
        journal.append(JournalEntry::new("three", None));
        let entries = journal.entries();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].message, "two");
    }

    #[test]
    fn entries_record_when_the_event_happened() {
        let entry = JournalEntry::new_at("paired", None, "2026-09-01T10:20:30Z");

        assert_eq!(entry.occurred_at, "2026-09-01T10:20:30Z");
        assert_eq!(
            serde_json::to_value(entry).unwrap()["occurredAt"],
            "2026-09-01T10:20:30Z"
        );
    }

    #[test]
    fn persistent_journal_survives_restart_and_skips_a_corrupt_line() {
        let temp = tempfile::tempdir().unwrap();
        {
            let mut journal = Journal::open_with_limits(temp.path(), 200, 1024, 7).unwrap();
            journal.append(JournalEntry::new_at(
                "one",
                Some("safe detail"),
                "2026-09-01T10:00:00Z",
            ));
        }
        std::fs::write(
            temp.path().join("signer.jsonl"),
            concat!(
                "not-json\n",
                "{\"occurredAt\":\"2026-09-01T10:01:00Z\",\"message\":\"two\",\"detail\":null}\n"
            ),
        )
        .unwrap();

        let journal = Journal::open_with_limits(temp.path(), 200, 1024, 7).unwrap();
        let entries = journal.entries();

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].message, "two");
    }

    #[test]
    fn rotates_persistent_files_without_exceeding_the_file_limit() {
        let temp = tempfile::tempdir().unwrap();
        let mut journal = Journal::open_with_limits(temp.path(), 200, 160, 3).unwrap();

        for index in 0..8 {
            journal.append(JournalEntry::new_at(
                format!("event-{index}"),
                Some("a detail long enough to force rotation"),
                "2026-09-01T10:00:00Z",
            ));
        }

        let file_count = std::fs::read_dir(temp.path())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("signer.jsonl")
            })
            .count();
        assert_eq!(file_count, 3);

        let reopened = Journal::open_with_limits(temp.path(), 200, 160, 3).unwrap();
        assert_eq!(reopened.entries().last().unwrap().message, "event-7");
    }

    #[test]
    fn exports_machine_readable_and_human_readable_logs_in_one_archive() {
        let temp = tempfile::tempdir().unwrap();
        let mut journal =
            Journal::open_with_limits(temp.path().join("logs"), 200, 1024, 7).unwrap();
        journal.append(JournalEntry::new_at(
            "Token refreshed",
            Some("safe detail"),
            "2026-09-01T10:20:30Z",
        ));
        let archive_path = temp.path().join("markiro-signer-logs.zip");

        journal
            .export_zip(
                &archive_path,
                &JournalExportMetadata {
                    app_version: "0.1.3".into(),
                    hostname: "BUH-PC".into(),
                    tenant_name: Some("ООО Ромашка".into()),
                },
            )
            .unwrap();

        let file = std::fs::File::open(archive_path).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        let mut jsonl = String::new();
        archive
            .by_name("events.jsonl")
            .unwrap()
            .read_to_string(&mut jsonl)
            .unwrap();
        assert!(jsonl.contains("Token refreshed"));
        assert!(jsonl.contains("2026-09-01T10:20:30Z"));

        let mut text = String::new();
        archive
            .by_name("events.txt")
            .unwrap()
            .read_to_string(&mut text)
            .unwrap();
        assert!(text.contains("2026-09-01T10:20:30Z  Token refreshed  safe detail"));

        let mut metadata = String::new();
        archive
            .by_name("metadata.json")
            .unwrap()
            .read_to_string(&mut metadata)
            .unwrap();
        assert!(metadata.contains("BUH-PC"));
        assert!(!metadata.contains("token\":"));
    }
}
