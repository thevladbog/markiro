//! `markiro-host address-check`: how this PC got the IPv4 addresses devices reach it by (plan ТСД-П,
//! task П4, spec 9.1). A device pins the host's certificate and remembers its address; an address by
//! DHCP changes with a lease, and the factory's handhelds then "lose the server". The installer
//! warns when one is by DHCP; the office shows the addresses with their MAC for the router's
//! reservation. Windows only: `Get-NetIPAddress`'s `PrefixOrigin` says `Dhcp` or `Manual`.

use std::net::Ipv4Addr;

use markiro_proto::{AddressMode, HostAddress};
use serde::Deserialize;

use crate::install::{powershell_args, run_checked, Commands, InstallError};

/// The exit code of `address-check` while an address is by DHCP.
pub const FROM_DHCP: u8 = 5;

/// One address as `Get-NetIPAddress` reports it, with its adapter's MAC.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AdapterAddress {
    pub index: u32,
    pub alias: String,
    pub address: String,
    /// `PrefixOrigin` as text: `Dhcp`, `Manual`, `WellKnown`, `RouterAdvertisement`, `Other`.
    pub origin: String,
    pub mac: String,
}

impl AdapterAddress {
    pub fn mode(&self) -> AddressMode {
        match self.origin.as_str() {
            "Dhcp" => AddressMode::Dhcp,
            "Manual" => AddressMode::Static,
            _ => AddressMode::Unknown,
        }
    }
}

/// Lists the IPv4 addresses as JSON in UTF-8, with the MAC of each one's adapter (the origin goes out
/// as text, not as Windows PowerShell's number for the enum; `-InputObject` keeps one row an array).
pub const LIST_SCRIPT: &str = "$ErrorActionPreference = 'Stop'; \
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; \
$rows = @(Get-NetIPAddress -AddressFamily IPv4 | ForEach-Object { \
$adapter = Get-NetAdapter -InterfaceIndex $_.InterfaceIndex -ErrorAction SilentlyContinue; \
[pscustomobject]@{ index = [int]$_.InterfaceIndex; alias = [string]$_.InterfaceAlias; \
address = [string]$_.IPAddress; origin = [string]$_.PrefixOrigin; \
mac = [string]$adapter.MacAddress } }); \
ConvertTo-Json -Compress -InputObject $rows";

/// Reads `LIST_SCRIPT`'s output: an array, one object, or nothing at all.
pub fn parse(stdout: &[u8]) -> Result<Vec<AdapterAddress>, InstallError> {
    let text = String::from_utf8_lossy(stdout);
    let text = text.trim().trim_start_matches('\u{feff}');
    if text.is_empty() {
        return Ok(Vec::new());
    }
    let unexpected = |_| InstallError::Output {
        program: "Get-NetIPAddress".to_owned(),
    };
    if text.starts_with('[') {
        serde_json::from_str(text).map_err(unexpected)
    } else {
        serde_json::from_str::<AdapterAddress>(text)
            .map(|row| vec![row])
            .map_err(unexpected)
    }
}

/// The addresses of this PC, from the system.
pub fn check(commands: &mut dyn Commands) -> Result<Vec<AdapterAddress>, InstallError> {
    let output = run_checked(commands, "powershell.exe", &powershell_args(LIST_SCRIPT))?;
    parse(&output.stdout)
}

/// The addresses devices can try (`lan`, listed in order) with what the shell said of each; an address the
/// shell did not list is `unknown`.
pub fn addresses_of(lan: &[Ipv4Addr], adapters: &[AdapterAddress]) -> Vec<HostAddress> {
    let mut sorted = lan.to_vec();
    sorted.sort();
    sorted
        .iter()
        .map(|ip| {
            let text = ip.to_string();
            match adapters.iter().find(|row| row.address == text) {
                Some(row) => HostAddress {
                    address: text,
                    mode: row.mode(),
                    mac: Some(row.mac.clone()).filter(|mac| !mac.is_empty()),
                    alias: Some(row.alias.clone()).filter(|alias| !alias.is_empty()),
                },
                None => HostAddress {
                    address: text,
                    mode: AddressMode::Unknown,
                    mac: None,
                    alias: None,
                },
            }
        })
        .collect()
}

/// Whether the office should ask for a reservation: some address is by DHCP.
pub fn reservation_needed(addresses: &[HostAddress]) -> bool {
    addresses
        .iter()
        .any(|address| address.mode == AddressMode::Dhcp)
}

/// This PC's addresses with how each was got (the office reads them live).
pub fn detect() -> Vec<HostAddress> {
    let lan = crate::network::lan_ipv4_addresses();
    #[cfg(windows)]
    let adapters = check(&mut crate::install::SystemCommands).unwrap_or_default();
    #[cfg(not(windows))]
    let adapters: Vec<AdapterAddress> = Vec::new();
    addresses_of(&lan, &adapters)
}
