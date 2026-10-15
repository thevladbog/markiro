//! `markiro-host address-check` against a fake PowerShell (plan ТСД-П, task П4, spec 9.1): reading how
//! `Get-NetIPAddress` says each address was got, and what the host tells devices about it.

use std::collections::VecDeque;
use std::net::Ipv4Addr;

use markiro_host::address_check::{
    addresses_of, check, parse, reservation_needed, AdapterAddress, LIST_SCRIPT,
};
use markiro_host::install::{CommandOutput, Commands, InstallError};
use markiro_proto::{AddressMode, HostAddress};

fn adapter(address: &str, origin: &str) -> AdapterAddress {
    AdapterAddress {
        index: 12,
        alias: "Беспроводная сеть".into(),
        address: address.into(),
        origin: origin.into(),
        mac: "AA-BB-CC-DD-EE-FF".into(),
    }
}

#[test]
fn reads_an_array_one_row_or_nothing() {
    let wifi = adapter("192.168.1.10", "Dhcp");
    assert_eq!(
        parse(
            r#"[{"index":12,"alias":"Беспроводная сеть","address":"192.168.1.10","origin":"Dhcp","mac":"AA-BB-CC-DD-EE-FF"}]"#
                .as_bytes()
        ),
        Ok(vec![wifi.clone()])
    );
    assert_eq!(
        parse(
            "\u{feff}{\"index\":12,\"alias\":\"Беспроводная сеть\",\"address\":\"192.168.1.10\",\"origin\":\"Dhcp\",\"mac\":\"AA-BB-CC-DD-EE-FF\"}\r\n"
                .as_bytes()
        ),
        Ok(vec![wifi])
    );
    assert_eq!(parse(b""), Ok(vec![]));
    assert_eq!(parse(b"[]"), Ok(vec![]));
    assert_eq!(
        parse(b"Get-NetIPAddress : access denied"),
        Err(InstallError::Output {
            program: "Get-NetIPAddress".into()
        })
    );
}

#[test]
fn an_address_is_by_dhcp_static_or_unknown_as_its_prefix_origin_says() {
    let lan = [
        Ipv4Addr::new(10, 0, 0, 5),
        Ipv4Addr::new(192, 168, 1, 10),
        Ipv4Addr::new(172, 16, 0, 9),
    ];
    let adapters = [
        adapter("10.0.0.5", "Manual"),
        adapter("192.168.1.10", "Dhcp"),
        // 172.16.0.9 is not among the shell's rows: nothing is known of it.
    ];
    let listed = addresses_of(&lan, &adapters);
    assert_eq!(
        listed,
        vec![
            HostAddress {
                address: "10.0.0.5".into(),
                mode: AddressMode::Static,
                mac: Some("AA-BB-CC-DD-EE-FF".into()),
                alias: Some("Беспроводная сеть".into())
            },
            HostAddress {
                address: "172.16.0.9".into(),
                mode: AddressMode::Unknown,
                mac: None,
                alias: None
            },
            HostAddress {
                address: "192.168.1.10".into(),
                mode: AddressMode::Dhcp,
                mac: Some("AA-BB-CC-DD-EE-FF".into()),
                alias: Some("Беспроводная сеть".into())
            },
        ]
    );
    assert!(reservation_needed(&listed));
    assert!(!reservation_needed(&listed[..1]));
    assert!(!reservation_needed(&[]));
}

/// PowerShell: answers each run with the next output, and keeps the scripts.
struct FakeShell {
    outputs: VecDeque<&'static str>,
    scripts: Vec<String>,
}

impl Commands for FakeShell {
    fn run(&mut self, program: &str, args: &[String]) -> Result<CommandOutput, InstallError> {
        assert_eq!(program, "powershell.exe");
        let encoded = args.last().expect("-EncodedCommand carries the script");
        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .unwrap();
        let units: Vec<u16> = bytes
            .chunks(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        self.scripts.push(String::from_utf16(&units).unwrap());
        Ok(CommandOutput {
            code: Some(0),
            stdout: self.outputs.pop_front().unwrap().as_bytes().to_vec(),
        })
    }
}

#[test]
fn the_check_asks_powershell_once_and_returns_its_rows() {
    let mut shell = FakeShell {
        outputs: VecDeque::from([
            r#"[{"index":7,"alias":"Ethernet","address":"10.0.0.5","origin":"Manual","mac":"11-22-33-44-55-66"}]"#,
        ]),
        scripts: Vec::new(),
    };
    let rows = check(&mut shell).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(shell.scripts, vec![LIST_SCRIPT.to_owned()]);
}
