//! A short in-memory journal mirrored into the tray window.
//!
//! Credentials must never land here: the cloud holds the authoritative audit,
//! and this file is readable by anything running as the operator.

use std::collections::VecDeque;

const DEFAULT_CAPACITY: usize = 200;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalEntry {
    pub message: String,
    pub detail: Option<String>,
}

impl JournalEntry {
    pub fn new(message: impl Into<String>, detail: Option<&str>) -> Self {
        Self {
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
}

impl Default for Journal {
    fn default() -> Self {
        Self::with_capacity(DEFAULT_CAPACITY)
    }
}

impl Journal {
    pub fn with_capacity(capacity: usize) -> Self {
        Self { capacity: capacity.max(1), entries: VecDeque::new() }
    }

    pub fn append(&mut self, entry: JournalEntry) {
        if self.entries.len() == self.capacity {
            self.entries.pop_front();
        }
        self.entries.push_back(entry);
    }

    pub fn entries(&self) -> Vec<JournalEntry> {
        self.entries.iter().cloned().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
