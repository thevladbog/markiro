use serde::Serialize;

/// What the Windows profile says about how long `%LOCALAPPDATA%` survives.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ProfileFacts {
    pub temporary: bool,
    pub mandatory: bool,
    pub roaming: bool,
    pub delete_roaming_cache: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LessDurableReason {
    TemporaryProfile,
    MandatoryProfile,
    DeleteRoamingCache,
}

impl ProfileFacts {
    /// A temporary or mandatory profile is discarded at sign-out, and the
    /// "delete cached copies of roaming profiles" policy deletes the local
    /// profile copy, `%LOCALAPPDATA%` included. There the roaming copy is the
    /// only one that survives, so the station must not move into Local.
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

#[cfg(windows)]
pub fn profile_facts() -> ProfileFacts {
    use windows_sys::Win32::System::GroupPolicy::{
        PT_MANDATORY, PT_ROAMING, PT_ROAMING_PREEXISTING, PT_TEMPORARY,
    };
    use windows_sys::Win32::UI::Shell::GetProfileType;

    let mut flags = 0u32;
    let known = unsafe { GetProfileType(&mut flags) } != 0;
    ProfileFacts {
        temporary: known && flags & PT_TEMPORARY != 0,
        mandatory: known && flags & PT_MANDATORY != 0,
        // An unknown profile counts as roaming, so the delete-cache policy on
        // its own still keeps the station where it is.
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
    use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_DWORD};

    let key: Vec<u16> = key.encode_utf16().chain(once(0)).collect();
    let value: Vec<u16> = value.encode_utf16().chain(once(0)).collect();
    let mut data = 0u32;
    let mut size = std::mem::size_of::<u32>() as u32;
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

/// Outside Windows there are no roaming profiles.
#[cfg(not(windows))]
pub fn profile_facts() -> ProfileFacts {
    ProfileFacts::default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_profiles_that_lose_local_data_keep_the_roaming_folder() {
        let local = ProfileFacts::default();
        assert_eq!(local.local_less_durable(), None);
        let roaming = ProfileFacts { roaming: true, ..local };
        assert_eq!(roaming.local_less_durable(), None);
        let deleting = ProfileFacts { delete_roaming_cache: true, ..roaming };
        assert_eq!(
            deleting.local_less_durable(),
            Some(LessDurableReason::DeleteRoamingCache)
        );
        // The policy only deletes roaming profiles' local copies.
        let local_with_policy = ProfileFacts { delete_roaming_cache: true, ..local };
        assert_eq!(local_with_policy.local_less_durable(), None);
        assert_eq!(
            ProfileFacts { temporary: true, ..local }.local_less_durable(),
            Some(LessDurableReason::TemporaryProfile)
        );
        assert_eq!(
            ProfileFacts { mandatory: true, ..local }.local_less_durable(),
            Some(LessDurableReason::MandatoryProfile)
        );
    }

    /// The GitHub Windows runner signs in with an ordinary local profile.
    #[cfg(windows)]
    #[test]
    fn the_runner_profile_allows_the_move() {
        assert_eq!(profile_facts().local_less_durable(), None);
    }
}
