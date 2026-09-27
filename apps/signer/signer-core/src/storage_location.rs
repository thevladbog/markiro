//! Where the agent keeps its state, and the one-time move of that state out of
//! the Windows roaming profile.
//!
//! Releases up to 0.1.4 kept `signer.json` and the journal in
//! `app_config_dir()`, which on Windows is the roaming `%APPDATA%`. A roaming
//! profile or AppData folder redirection carried that folder, agent secret
//! included, to every computer the same Windows user signed in to, and the
//! user's DPAPI keys went with it. The state now lives in
//! `app_local_data_dir()` (`%LOCALAPPDATA%`), which Windows neither roams nor
//! redirects. Design: `docs/superpowers/specs/2026-09-27-signer-local-storage-design.md`.
//!
//! One rule carries the move: without a committed record in the local folder
//! the legacy folder is authoritative; with one, the local folder is. The
//! record is a single atomic write, so an interruption at any point leaves
//! exactly one authoritative copy.
use serde::Serialize;

/// A storage fact the operator should know about. Each one reaches the
/// journal and `AgentStatus.storageNotices`; the webview words it
/// (`src/i18n`, keys under `storage`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum StorageNotice {
    /// The local folder would not survive sign-out, so the agent stays in the
    /// roaming one.
    LocalLessDurable { reason: LessDurableReason },
    /// The roaming folder could not be read, or the copy failed. This run uses
    /// the roaming folder; the next start tries again.
    MovePostponed,
    /// The moved roaming copy could not be removed yet. This computer no
    /// longer uses it.
    LegacyCleanupPending,
    /// Pairing data turned up in the roaming folder after the move. It is
    /// never loaded and never deleted. `same_agent`: it holds this agent's id,
    /// so a copy of this agent may be running on another computer.
    RoamedCopyPresent { same_agent: bool },
    /// DPAPI could not decrypt the saved credential. The file is kept and the
    /// agent asks for a new pairing (spec §7.6).
    CredentialUnreadable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LessDurableReason {
    TemporaryProfile,
    MandatoryProfile,
    DeleteRoamingCache,
}

impl StorageNotice {
    /// The journal line for this notice. English, like every journal message.
    pub fn journal_message(&self) -> &'static str {
        match self {
            Self::LocalLessDurable {
                reason: LessDurableReason::TemporaryProfile,
            } => "Temporary Windows profile: agent data stays in the roaming folder and is lost at sign-out",
            Self::LocalLessDurable {
                reason: LessDurableReason::MandatoryProfile,
            } => "Mandatory Windows profile: agent data stays in the roaming folder and is lost at sign-out",
            Self::LocalLessDurable {
                reason: LessDurableReason::DeleteRoamingCache,
            } => "Local profile copies are deleted at sign-out: agent data stays in the roaming folder",
            Self::MovePostponed => {
                "Agent data could not be moved out of the roaming folder yet; retrying at the next start"
            }
            Self::LegacyCleanupPending => {
                "The old roaming copy of the agent data could not be removed yet; it is no longer used"
            }
            Self::RoamedCopyPresent { same_agent: true } => {
                "A copy of this agent's pairing appeared in the roaming folder; the agent may also run on another computer"
            }
            Self::RoamedCopyPresent { same_agent: false } => {
                "Another pairing appeared in the roaming folder; it is not used"
            }
            Self::CredentialUnreadable => "Stored credential is unreadable",
        }
    }
}

/// What Windows says about the signed-in user's profile.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ProfileFacts {
    pub temporary: bool,
    pub mandatory: bool,
    pub roaming: bool,
    pub delete_roaming_cache: bool,
}

impl ProfileFacts {
    /// A temporary or mandatory profile is discarded at sign-out, and the
    /// "delete cached copies of roaming profiles" policy deletes the local
    /// profile copy, `%LOCALAPPDATA%` included. There the roaming folder is the
    /// only copy that survives, so the agent must not move into the local one
    /// (station decision D2, carried over as signer decision S2).
    pub fn local_less_durable(&self) -> Option<LessDurableReason> {
        if self.temporary {
            Some(LessDurableReason::TemporaryProfile)
        } else if self.mandatory {
            Some(LessDurableReason::MandatoryProfile)
        } else if self.roaming && self.delete_roaming_cache {
            Some(LessDurableReason::DeleteRoamingCache)
        } else {
            None
        }
    }
}

pub trait ProfileProbe {
    fn facts(&self) -> ProfileFacts;
}

/// `GetProfileType` and the `DeleteRoamingCache` policy on Windows; a local
/// profile everywhere else (the agent ships only for Windows).
pub struct SystemProfileProbe;

impl ProfileProbe for SystemProfileProbe {
    fn facts(&self) -> ProfileFacts {
        system_profile_facts()
    }
}

#[cfg(windows)]
fn system_profile_facts() -> ProfileFacts {
    use windows_sys::Win32::System::GroupPolicy::{
        PT_MANDATORY, PT_ROAMING, PT_ROAMING_PREEXISTING, PT_TEMPORARY,
    };
    use windows_sys::Win32::UI::Shell::GetProfileType;

    let mut flags = 0u32;
    // SAFETY: `flags` is a valid, writable u32 for the duration of the call.
    let known = unsafe { GetProfileType(&mut flags) } != 0;
    ProfileFacts {
        temporary: known && flags & PT_TEMPORARY != 0,
        mandatory: known && flags & PT_MANDATORY != 0,
        // An unknown profile counts as roaming, so the delete-cache policy on
        // its own still keeps the agent where it is.
        roaming: !known || flags & (PT_ROAMING | PT_ROAMING_PREEXISTING) != 0,
        delete_roaming_cache: policy_dword(
            r"SOFTWARE\Policies\Microsoft\Windows\System",
            "DeleteRoamingCache",
        ) == Some(1),
    }
}

#[cfg(windows)]
fn policy_dword(key: &str, value: &str) -> Option<u32> {
    use std::iter::once;
    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{
        RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_DWORD,
    };

    let key: Vec<u16> = key.encode_utf16().chain(once(0)).collect();
    let value: Vec<u16> = value.encode_utf16().chain(once(0)).collect();
    let mut data = 0u32;
    let mut size = std::mem::size_of::<u32>() as u32;
    // SAFETY: both names are NUL-terminated UTF-16 buffers that outlive the
    // call; `data` and `size` describe one writable u32, which is what
    // RRF_RT_REG_DWORD returns.
    let status = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            key.as_ptr(),
            value.as_ptr(),
            RRF_RT_REG_DWORD,
            std::ptr::null_mut(),
            (&mut data as *mut u32).cast(),
            &mut size,
        )
    };
    (status == ERROR_SUCCESS).then_some(data)
}

#[cfg(not(windows))]
fn system_profile_facts() -> ProfileFacts {
    ProfileFacts::default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notices_serialize_for_the_webview() {
        assert_eq!(
            serde_json::to_value(StorageNotice::RoamedCopyPresent { same_agent: true }).unwrap(),
            serde_json::json!({ "kind": "roamedCopyPresent", "sameAgent": true })
        );
        assert_eq!(
            serde_json::to_value(StorageNotice::LocalLessDurable {
                reason: LessDurableReason::TemporaryProfile
            })
            .unwrap(),
            serde_json::json!({ "kind": "localLessDurable", "reason": "temporaryProfile" })
        );
        assert_eq!(
            serde_json::to_value(StorageNotice::MovePostponed).unwrap(),
            serde_json::json!({ "kind": "movePostponed" })
        );
    }

    #[test]
    fn only_profiles_that_discard_the_local_folder_are_less_durable() {
        let facts = |temporary, mandatory, roaming, delete_roaming_cache| ProfileFacts {
            temporary,
            mandatory,
            roaming,
            delete_roaming_cache,
        };
        assert_eq!(facts(false, false, false, false).local_less_durable(), None);
        assert_eq!(facts(false, false, true, false).local_less_durable(), None);
        assert_eq!(facts(false, false, false, true).local_less_durable(), None);
        assert_eq!(
            facts(true, false, false, false).local_less_durable(),
            Some(LessDurableReason::TemporaryProfile)
        );
        assert_eq!(
            facts(false, true, false, false).local_less_durable(),
            Some(LessDurableReason::MandatoryProfile)
        );
        assert_eq!(
            facts(false, false, true, true).local_less_durable(),
            Some(LessDurableReason::DeleteRoamingCache)
        );
        // A temporary profile loses everything at sign-out, so it wins.
        assert_eq!(
            facts(true, true, true, true).local_less_durable(),
            Some(LessDurableReason::TemporaryProfile)
        );
    }

    #[test]
    fn every_notice_has_its_own_journal_line() {
        let notices = [
            StorageNotice::LocalLessDurable { reason: LessDurableReason::TemporaryProfile },
            StorageNotice::LocalLessDurable { reason: LessDurableReason::MandatoryProfile },
            StorageNotice::LocalLessDurable { reason: LessDurableReason::DeleteRoamingCache },
            StorageNotice::MovePostponed,
            StorageNotice::LegacyCleanupPending,
            StorageNotice::RoamedCopyPresent { same_agent: true },
            StorageNotice::RoamedCopyPresent { same_agent: false },
            StorageNotice::CredentialUnreadable,
        ];
        let mut lines: Vec<&str> = notices.iter().map(StorageNotice::journal_message).collect();
        assert!(lines.iter().all(|line| !line.is_empty()));
        lines.sort_unstable();
        lines.dedup();
        assert_eq!(lines.len(), notices.len());
    }

    #[cfg(windows)]
    #[test]
    fn the_runner_profile_is_local() {
        let facts = SystemProfileProbe.facts();
        assert!(!facts.temporary && !facts.mandatory, "{facts:?}");
        assert_eq!(facts.local_less_durable(), None, "{facts:?}");
    }
}
