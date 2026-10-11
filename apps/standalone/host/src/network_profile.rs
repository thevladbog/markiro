//! `markiro-host network-check`: which networks Windows counts as public.
//! The firewall rule `install` adds opens the host's port only on private
//! and domain networks (spec §9.1), and Windows often files a new Wi-Fi
//! network as public, so the station would stay unreachable from the office
//! PC. The installer runs this check after `install` and offers to make a
//! public network private (`--make-private`, pilot spec §9.4).

use serde::Deserialize;

use crate::install::{powershell_args, run_checked, Commands, InstallError};

/// The exit code of `network-check` while a public network remains.
pub const PUBLIC_REMAINS: u8 = 3;

/// One connection profile as `Get-NetConnectionProfile` reports it.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct NetworkProfile {
    /// `InterfaceIndex`: what `Set-NetConnectionProfile` takes.
    pub index: u32,
    /// `InterfaceAlias` («Беспроводная сеть»), for the installer's log only.
    pub alias: String,
    /// `NetworkCategory` as text: `Public`, `Private` or `DomainAuthenticated`.
    pub category: String,
}

impl NetworkProfile {
    pub fn is_public(&self) -> bool {
        self.category == "Public"
    }
}

/// Lists the profiles as JSON in UTF-8. The category goes out as text, not
/// as Windows PowerShell's number for the enum, and `-InputObject` keeps one
/// profile an array.
pub const LIST_SCRIPT: &str = "$ErrorActionPreference = 'Stop'; \
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; \
$profiles = @(Get-NetConnectionProfile | ForEach-Object { [pscustomobject]@{ \
index = [int]$_.InterfaceIndex; alias = [string]$_.InterfaceAlias; \
category = [string]$_.NetworkCategory } }); \
ConvertTo-Json -Compress -InputObject $profiles";

/// Makes the network on interface `index` private.
pub fn make_private_script(index: u32) -> String {
    format!(
        "$ErrorActionPreference = 'Stop'; \
Set-NetConnectionProfile -InterfaceIndex {index} -NetworkCategory Private"
    )
}

/// Reads `LIST_SCRIPT`'s output: an array, one object (an older shell that
/// unrolled the array), or nothing at all when there is no connection.
pub fn parse_profiles(stdout: &[u8]) -> Result<Vec<NetworkProfile>, InstallError> {
    let text = String::from_utf8_lossy(stdout);
    let text = text.trim().trim_start_matches('\u{feff}');
    if text.is_empty() {
        return Ok(Vec::new());
    }
    let unexpected = |_| InstallError::Output {
        program: "Get-NetConnectionProfile".to_owned(),
    };
    if text.starts_with('[') {
        serde_json::from_str(text).map_err(unexpected)
    } else {
        serde_json::from_str::<NetworkProfile>(text)
            .map(|profile| vec![profile])
            .map_err(unexpected)
    }
}

/// The profiles after the check: with `make_private`, every public one is
/// made private first, and the list is read again.
pub fn check(
    commands: &mut dyn Commands,
    make_private: bool,
) -> Result<Vec<NetworkProfile>, InstallError> {
    let profiles = list(commands)?;
    if !make_private || !profiles.iter().any(NetworkProfile::is_public) {
        return Ok(profiles);
    }
    for profile in profiles.iter().filter(|profile| profile.is_public()) {
        run_checked(
            commands,
            "powershell.exe",
            &powershell_args(&make_private_script(profile.index)),
        )?;
    }
    list(commands)
}

fn list(commands: &mut dyn Commands) -> Result<Vec<NetworkProfile>, InstallError> {
    let output = run_checked(commands, "powershell.exe", &powershell_args(LIST_SCRIPT))?;
    parse_profiles(&output.stdout)
}
