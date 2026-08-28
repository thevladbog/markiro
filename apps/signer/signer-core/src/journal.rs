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
fn redact(detail: &str) -> String {
    let mut out = String::with_capacity(detail.len());
    for word in detail.split_whitespace() {
        let looks_secret = word.len() >= 24
            && word
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '+' | '/' | '='));
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(if looks_secret { "[redacted]" } else { word });
    }
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
        let entry = JournalEntry::new("token refreshed", Some("Bearer eyJhbGciOiJIUzI1NiJ9.abc.def"));
        assert!(!entry.detail.as_deref().unwrap_or_default().contains("eyJ"));
        assert!(entry.detail.as_deref().unwrap_or_default().contains("[redacted]"));
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
