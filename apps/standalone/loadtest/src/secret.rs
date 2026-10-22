//! A credential the harness holds: a device key, the office session, an administrator's
//! password, a pairing code. It has no `Display` and its `Debug` says only that it is redacted,
//! so it cannot reach a log line, a failed check's detail or a panic's text by being formatted;
//! `expose` hands the raw text to the one place that needs it (a request to the host, the
//! redaction of a report).

use std::fmt;

#[derive(Clone, PartialEq, Eq)]
pub struct Secret(String);

impl Secret {
    pub fn new(value: impl Into<String>) -> Secret {
        Secret(value.into())
    }

    /// The raw text: for the request that carries it and for `report::redact`, nothing else.
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl From<String> for Secret {
    fn from(value: String) -> Secret {
        Secret(value)
    }
}

impl From<&str> for Secret {
    fn from(value: &str) -> Secret {
        Secret(value.to_owned())
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secret([redacted])")
    }
}

/// Every secret a run made or was given (passwords, pairing codes, device keys, the office
/// session): what `report::redact` removes from a report before it is written. Its `Debug`
/// names only how many it holds.
#[derive(Clone, Default, PartialEq, Eq)]
pub struct Redactions(Vec<Secret>);

impl Redactions {
    pub fn push(&mut self, secret: Secret) {
        self.0.push(secret);
    }

    pub fn extend(&mut self, other: Redactions) {
        self.0.extend(other.0);
    }

    pub fn iter(&self) -> std::slice::Iter<'_, Secret> {
        self.0.iter()
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl FromIterator<Secret> for Redactions {
    fn from_iter<I: IntoIterator<Item = Secret>>(items: I) -> Redactions {
        Redactions(items.into_iter().collect())
    }
}

impl fmt::Debug for Redactions {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Redactions([{} redacted])", self.0.len())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_secret_is_printed_as_redacted_and_exposed_only_by_name() {
        // Fake values under plain names: an assertion's text is a log of its own.
        let held = Secret::new("Load-0123-4567");
        assert_eq!(format!("{held:?}"), "Secret([redacted])");
        assert_eq!(
            format!("{:?}", Some(held.clone())),
            "Some(Secret([redacted]))"
        );
        assert_eq!(held.expose(), "Load-0123-4567");
        assert_eq!(Secret::from("a"), Secret::new("a".to_owned()));
    }

    #[test]
    fn a_list_of_secrets_is_printed_as_a_count() {
        let mut list: Redactions = ["KEY-1", "Load-2"].into_iter().map(Secret::from).collect();
        list.push(Secret::from("123456"));
        list.extend(Redactions::default());
        assert_eq!(list.len(), 3);
        assert_eq!(format!("{list:?}"), "Redactions([3 redacted])");
        let raw: Vec<&str> = list.iter().map(Secret::expose).collect();
        assert_eq!(raw, ["KEY-1", "Load-2", "123456"]);
        assert!(Redactions::default().is_empty());
    }
}
