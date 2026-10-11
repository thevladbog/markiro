//! `markiro-host network-check` against a fake PowerShell: reading what
//! `Get-NetConnectionProfile` prints, and making a public network private.

use std::collections::VecDeque;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use markiro_host::install::{CommandOutput, Commands, InstallError};
use markiro_host::network_profile::{
    check, make_private_script, parse_profiles, NetworkProfile, LIST_SCRIPT,
};

fn profile(index: u32, alias: &str, category: &str) -> NetworkProfile {
    NetworkProfile {
        index,
        alias: alias.into(),
        category: category.into(),
    }
}

#[test]
fn reads_an_array_one_profile_or_nothing() {
    let wifi = profile(12, "Беспроводная сеть", "Public");
    let cable = profile(7, "Ethernet", "Private");
    assert_eq!(
        parse_profiles(
            r#"[{"index":12,"alias":"Беспроводная сеть","category":"Public"},{"index":7,"alias":"Ethernet","category":"Private"}]"#
                .as_bytes()
        ),
        Ok(vec![wifi.clone(), cable])
    );
    assert_eq!(
        parse_profiles(
            "\u{feff}{\"index\":12,\"alias\":\"Беспроводная сеть\",\"category\":\"Public\"}\r\n"
                .as_bytes()
        ),
        Ok(vec![wifi])
    );
    assert_eq!(parse_profiles(b""), Ok(vec![]));
    assert_eq!(parse_profiles(b"  \r\n"), Ok(vec![]));
    assert_eq!(parse_profiles(b"[]"), Ok(vec![]));
    assert_eq!(
        parse_profiles(b"Get-NetConnectionProfile : access denied"),
        Err(InstallError::Output {
            program: "Get-NetConnectionProfile".into()
        })
    );
}

#[test]
fn only_a_public_network_is_public() {
    assert!(profile(1, "Wi-Fi", "Public").is_public());
    assert!(!profile(1, "Wi-Fi", "Private").is_public());
    assert!(!profile(1, "Wi-Fi", "DomainAuthenticated").is_public());
}

/// PowerShell: answers each run with the next output, and keeps the scripts.
struct FakeShell {
    outputs: VecDeque<&'static str>,
    scripts: Vec<String>,
}

impl Commands for FakeShell {
    fn run(&mut self, program: &str, args: &[String]) -> Result<CommandOutput, InstallError> {
        assert_eq!(program, "powershell.exe");
        let bytes = STANDARD.decode(args.last().expect("a script")).unwrap();
        let units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        self.scripts.push(String::from_utf16(&units).unwrap());
        Ok(CommandOutput {
            code: Some(0),
            stdout: self.outputs.pop_front().unwrap_or_default().into(),
        })
    }
}

const PUBLIC_WIFI_AND_PRIVATE_CABLE: &str = r#"[{"index":12,"alias":"Wi-Fi","category":"Public"},{"index":7,"alias":"Ethernet","category":"Private"}]"#;

#[test]
fn make_private_changes_only_the_public_networks_and_reads_them_again() {
    let mut shell = FakeShell {
        outputs: [
            PUBLIC_WIFI_AND_PRIVATE_CABLE,
            "",
            r#"[{"index":12,"alias":"Wi-Fi","category":"Private"},{"index":7,"alias":"Ethernet","category":"Private"}]"#,
        ]
        .into(),
        scripts: Vec::new(),
    };
    let profiles = check(&mut shell, true).unwrap();
    assert_eq!(
        shell.scripts,
        [
            LIST_SCRIPT.to_owned(),
            make_private_script(12),
            LIST_SCRIPT.to_owned()
        ]
    );
    assert!(profiles.iter().all(|profile| !profile.is_public()));
    assert_eq!(
        make_private_script(12),
        "$ErrorActionPreference = 'Stop'; Set-NetConnectionProfile -InterfaceIndex 12 -NetworkCategory Private"
    );
}

#[test]
fn without_make_private_the_check_only_reads() {
    let mut shell = FakeShell {
        outputs: [PUBLIC_WIFI_AND_PRIVATE_CABLE].into(),
        scripts: Vec::new(),
    };
    let profiles = check(&mut shell, false).unwrap();
    assert_eq!(shell.scripts, [LIST_SCRIPT.to_owned()]);
    assert_eq!(
        profiles,
        vec![
            profile(12, "Wi-Fi", "Public"),
            profile(7, "Ethernet", "Private")
        ]
    );
}

#[test]
fn the_list_script_reports_the_category_as_text_in_utf8() {
    assert!(LIST_SCRIPT.contains("[Console]::OutputEncoding = [System.Text.Encoding]::UTF8"));
    assert!(LIST_SCRIPT.contains("category = [string]$_.NetworkCategory"));
    assert!(LIST_SCRIPT.contains("ConvertTo-Json -Compress -InputObject $profiles"));
}

// ---------------------------------------------------------------------------
// Beyond the plan's brief.
// ---------------------------------------------------------------------------

#[test]
fn make_private_leaves_a_list_without_a_public_network_alone() {
    let mut shell = FakeShell {
        outputs: [
            r#"[{"index":7,"alias":"Ethernet","category":"Private"},{"index":3,"alias":"Corp","category":"DomainAuthenticated"}]"#,
        ]
        .into(),
        scripts: Vec::new(),
    };
    let profiles = check(&mut shell, true).unwrap();
    assert_eq!(shell.scripts, [LIST_SCRIPT.to_owned()]);
    assert_eq!(profiles.len(), 2);
}

#[test]
fn every_public_network_is_made_private_not_only_the_first() {
    let mut shell = FakeShell {
        outputs: [
            r#"[{"index":12,"alias":"Wi-Fi","category":"Public"},{"index":9,"alias":"Ethernet 2","category":"Public"}]"#,
            "",
            "",
            "[]",
        ]
        .into(),
        scripts: Vec::new(),
    };
    check(&mut shell, true).unwrap();
    assert_eq!(
        shell.scripts,
        [
            LIST_SCRIPT.to_owned(),
            make_private_script(12),
            make_private_script(9),
            LIST_SCRIPT.to_owned()
        ]
    );
}

/// PowerShell that fails on its `fail_on`-th run (counting from 1).
struct FailingShell {
    runs: usize,
    fail_on: usize,
}

impl Commands for FailingShell {
    fn run(&mut self, _program: &str, _args: &[String]) -> Result<CommandOutput, InstallError> {
        self.runs += 1;
        Ok(CommandOutput {
            code: Some(if self.runs == self.fail_on { 1 } else { 0 }),
            stdout: if self.runs == 1 {
                PUBLIC_WIFI_AND_PRIVATE_CABLE.into()
            } else {
                Vec::new()
            },
        })
    }
}

#[test]
fn a_network_that_cannot_be_changed_is_an_error_and_is_not_read_again() {
    let mut shell = FailingShell {
        runs: 0,
        fail_on: 2,
    };
    assert_eq!(
        check(&mut shell, true),
        Err(InstallError::Command {
            program: "powershell.exe".into(),
            code: Some(1)
        })
    );
    assert_eq!(shell.runs, 2);
    let mut unreadable = FailingShell {
        runs: 0,
        fail_on: 1,
    };
    assert_eq!(
        check(&mut unreadable, false),
        Err(InstallError::Command {
            program: "powershell.exe".into(),
            code: Some(1)
        })
    );
}
