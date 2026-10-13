//! Links the webview hands to the system (the office's «Информация»): the
//! product's site and a support e-mail. The webview never navigates itself
//! (its content security policy has no other origin, and a link inside it
//! would load in the app's own window), so it asks the shell, which opens a
//! link only of the two shapes below in the program Windows has for it, the
//! default browser or mail client. Nothing else is opened, whatever the
//! webview asks: no other scheme, no other site, no characters that Explorer's
//! command line could misread. The shell makes no network request itself.

#[cfg(any(windows, test))]
use std::path::Path;

/// The one site a link may lead to.
pub const SITE_HOST: &str = "markiro.app";

/// The longest link accepted, in characters.
const MAX_LINK_CHARS: usize = 200;

/// Why a call failed; the webview reads the bare code.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExternalLinkError {
    /// A link that is neither the site nor a plain `mailto:` address.
    InvalidRequest,
    /// Opening a link needs Windows Explorer.
    Unsupported,
    /// Explorer did not start.
    Launch,
}

impl ExternalLinkError {
    pub fn code(self) -> &'static str {
        match self {
            ExternalLinkError::InvalidRequest => "invalid_request",
            ExternalLinkError::Unsupported => "unsupported",
            ExternalLinkError::Launch => "launch",
        }
    }
}

fn is_path_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '/' | '-' | '_' | '.')
}

fn is_local_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '+' | '-')
}

/// `https://markiro.app` with an optional plain path, or `mailto:` and one
/// plain address (letters, digits and `._+-` before the `@`, a dotted domain
/// after it): no query, no fragment, no quote, no percent sign.
pub fn is_allowed_link(link: &str) -> bool {
    if link.is_empty() || link.chars().count() > MAX_LINK_CHARS {
        return false;
    }
    if let Some(rest) = link.strip_prefix("https://") {
        let Some(path) = rest.strip_prefix(SITE_HOST) else {
            return false;
        };
        return path.is_empty() || (path.starts_with('/') && path.chars().all(is_path_char));
    }
    if let Some(address) = link.strip_prefix("mailto:") {
        let Some((local, domain)) = address.split_once('@') else {
            return false;
        };
        let labels: Vec<&str> = domain.split('.').collect();
        return !local.is_empty()
            && local.chars().all(is_local_char)
            && labels.len() >= 2
            && labels.iter().all(|label| {
                !label.is_empty()
                    && !label.starts_with('-')
                    && !label.ends_with('-')
                    && label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
            });
    }
    false
}

/// Explorer's launch for a link: the same as for a folder or a file
/// (`office_files::explorer_launch`), the link in double quotes.
#[cfg(any(windows, test))]
fn launch_for(
    link: &str,
    system_root: Option<&std::ffi::OsStr>,
) -> Option<crate::office_files::ExplorerLaunch> {
    crate::office_files::explorer_launch(Path::new(link), system_root)
}

#[cfg(windows)]
fn open(link: &str) -> Result<(), ExternalLinkError> {
    use std::os::windows::process::CommandExt;

    let launch = launch_for(link, std::env::var_os("SystemRoot").as_deref())
        .ok_or(ExternalLinkError::InvalidRequest)?;
    // Explorer answers 1 even when it did what was asked: only a failure to
    // start it counts. The failure is logged by its kind, never by the link.
    std::process::Command::new(&launch.program)
        .raw_arg(&launch.argument)
        .current_dir(&launch.current_dir)
        .spawn()
        .map(|_| ())
        .map_err(|error| {
            eprintln!("standalone: open_external_link failed: {:?}", error.kind());
            ExternalLinkError::Launch
        })
}

#[cfg(not(windows))]
fn open(_link: &str) -> Result<(), ExternalLinkError> {
    Err(ExternalLinkError::Unsupported)
}

/// Opens the product's site or a support e-mail in the system's program.
#[tauri::command]
pub async fn open_external_link(link: String) -> Result<(), String> {
    if !is_allowed_link(&link) {
        return Err(ExternalLinkError::InvalidRequest.code().to_owned());
    }
    open(&link).map_err(|error| error.code().to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;
    use std::path::PathBuf;

    #[test]
    fn the_site_and_a_plain_address_are_allowed() {
        for link in [
            "https://markiro.app",
            "https://markiro.app/",
            "https://markiro.app/kak-rabotaet/",
            "mailto:hello@markiro.app",
            "mailto:first.last+tag@sub.example.ru",
        ] {
            assert!(is_allowed_link(link), "{link}");
        }
    }

    #[test]
    fn anything_else_is_refused() {
        for link in [
            "",
            "http://markiro.app",
            "https://evil.example",
            "https://markiro.app.evil.example",
            "https://markiro.app@evil.example",
            "https://markiro.app/?a=1",
            "https://markiro.app/#x",
            "https://markiro.app/a b",
            "https://markiro.app/\"",
            "https://markiro.app/%2e",
            "file:///C:/Windows/System32/calc.exe",
            "javascript:alert(1)",
            "calc.exe",
            "C:\\Windows\\System32\\calc.exe",
            "mailto:",
            "mailto:@markiro.app",
            "mailto:a@markiro",
            "mailto:a@-markiro.app",
            "mailto:a b@markiro.app",
            "mailto:a@markiro.app?body=x",
            "mailto:a@markiro.app,b@markiro.app",
            "mailto:\"a\"@markiro.app",
            "mailto:a@markiro.app&calc",
        ] {
            assert!(!is_allowed_link(link), "{link}");
        }
        let long = format!("https://markiro.app/{}", "a".repeat(MAX_LINK_CHARS));
        assert!(!is_allowed_link(&long));
    }

    #[test]
    fn explorer_gets_the_link_quoted_from_the_system_folder() {
        let launch = launch_for("mailto:hello@markiro.app", Some(OsStr::new(r"D:\Win"))).unwrap();
        assert_eq!(
            launch.program,
            PathBuf::from(r"D:\Win").join("explorer.exe")
        );
        assert_eq!(launch.argument, OsStr::new("\"mailto:hello@markiro.app\""));
        assert_eq!(launch.current_dir, PathBuf::from(r"D:\Win"));
    }

    #[test]
    fn codes_are_the_words_the_webview_reads() {
        assert_eq!(ExternalLinkError::InvalidRequest.code(), "invalid_request");
        assert_eq!(ExternalLinkError::Unsupported.code(), "unsupported");
        assert_eq!(ExternalLinkError::Launch.code(), "launch");
    }
}
