//! The installer's subcommands through the real binary: what the installer's
//! hooks read are the exit codes (`main.rs`). `install`, `uninstall` and
//! `stop-service` need the Windows service manager and are checked by
//! `standalone-windows-build`; `network-check` is driven here through a fake
//! `powershell.exe` found on `PATH` (Unix only; on Windows the real programs
//! are run by absolute path).

use std::process::{Command, Output};

fn host(args: &[&str], path: &str) -> Output {
    Command::new(env!("CARGO_BIN_EXE_markiro-host"))
        .args(args)
        .env("PATH", path)
        .output()
        .expect("the host binary runs")
}

fn code(output: &Output) -> Option<i32> {
    output.status.code()
}

#[test]
fn bad_installer_command_lines_are_usage_errors() {
    for args in [
        &["install", "now"][..],
        &["uninstall", "--data-dir", "x"][..],
        &["stop-service", "1"][..],
        &["network-check", "--private"][..],
    ] {
        let output = host(args, "");
        assert_eq!(code(&output), Some(2), "{args:?}");
        assert!(
            String::from_utf8_lossy(&output.stderr).contains("usage:"),
            "{args:?}"
        );
    }
}

#[cfg(not(windows))]
#[test]
fn the_service_commands_fail_with_a_plain_message_outside_windows() {
    for command in ["install", "uninstall", "stop-service"] {
        let output = host(&[command], "");
        assert_eq!(code(&output), Some(1), "{command}");
        let error = String::from_utf8_lossy(&output.stderr);
        assert!(
            error.contains(&format!("{command} is only available on Windows")),
            "{error}"
        );
    }
}

#[cfg(unix)]
mod network_check {
    use std::os::unix::fs::PermissionsExt;

    use super::*;

    /// A directory whose `powershell.exe` prints `stdout` and exits with `exit`.
    fn fake_powershell(stdout: &str, exit: i32) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("powershell.exe");
        std::fs::write(
            &script,
            format!("#!/bin/sh\ncat <<'END'\n{stdout}\nEND\nexit {exit}\n"),
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        dir
    }

    fn path_of(dir: &tempfile::TempDir) -> String {
        format!("{}:/usr/bin:/bin", dir.path().display())
    }

    const PUBLIC: &str = r#"[{"index":12,"alias":"Беспроводная сеть","category":"Public"},{"index":7,"alias":"Ethernet","category":"Private"}]"#;
    const PRIVATE: &str = r#"[{"index":7,"alias":"Ethernet","category":"Private"}]"#;

    #[test]
    fn a_public_network_is_exit_3_and_listed() {
        let dir = fake_powershell(PUBLIC, 0);
        let output = host(&["network-check"], &path_of(&dir));
        assert_eq!(code(&output), Some(3));
        assert_eq!(
            String::from_utf8_lossy(&output.stdout),
            "Беспроводная сеть: Public\nEthernet: Private\n"
        );
        assert!(String::from_utf8_lossy(&output.stderr).contains("public"));
    }

    #[test]
    fn no_public_network_is_exit_0() {
        let dir = fake_powershell(PRIVATE, 0);
        let output = host(&["network-check"], &path_of(&dir));
        assert_eq!(code(&output), Some(0));
        assert_eq!(
            String::from_utf8_lossy(&output.stdout),
            "Ethernet: Private\n"
        );
        assert!(output.stderr.is_empty());
    }

    #[test]
    fn make_private_that_leaves_a_public_network_is_still_exit_3() {
        // This fake cannot change anything: whatever it is told, it lists a
        // public network again.
        let dir = fake_powershell(PUBLIC, 0);
        let output = host(&["network-check", "--make-private"], &path_of(&dir));
        assert_eq!(code(&output), Some(3));
    }

    #[test]
    fn a_failing_powershell_is_exit_1_and_says_which_program() {
        let dir = fake_powershell("", 1);
        let output = host(&["network-check"], &path_of(&dir));
        assert_eq!(code(&output), Some(1));
        assert!(
            String::from_utf8_lossy(&output.stderr).contains("powershell.exe ended with code 1")
        );
    }

    #[test]
    fn a_missing_powershell_is_exit_1() {
        let output = host(&["network-check"], "");
        assert_eq!(code(&output), Some(1));
        assert!(String::from_utf8_lossy(&output.stderr).contains("powershell.exe could not start"));
    }
}
