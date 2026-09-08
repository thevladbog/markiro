//! Shares the installer's per-user Run entry. No cloud or pairing state is involved.

#[cfg(windows)]
mod windows {
    use std::io::{self, ErrorKind};
    use winreg::{enums::*, RegKey};

    const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
    const RUN_VALUE: &str = "MarkiroSigner";
    const SETTINGS_KEY: &str = r"Software\Markiro\Signer";
    const SETTINGS_VALUE: &str = "AutostartEnabled";

    fn enabled_at(root: &RegKey) -> io::Result<bool> {
        let result = root
            .open_subkey_with_flags(RUN_KEY, KEY_READ)
            .and_then(|key| key.get_value::<String, _>(RUN_VALUE));
        match result {
            Ok(command) => Ok(!command.trim().is_empty()),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
            Err(error) => Err(error),
        }
    }

    fn set_at(root: &RegKey, enabled: bool, executable: &std::ffi::OsStr) -> io::Result<()> {
        let (run, _) = root.create_subkey(RUN_KEY)?;
        let (settings, _) = root.create_subkey(SETTINGS_KEY)?;
        set_registration(&run, &settings, enabled, executable)
    }

    fn set_registration(
        run: &RegKey,
        settings: &RegKey,
        enabled: bool,
        executable: &std::ffi::OsStr,
    ) -> io::Result<()> {
        if enabled {
            // Preserve Unicode paths and quote the executable (including spaces).
            let mut command = std::ffi::OsString::from("\"");
            command.push(executable);
            command.push("\"");
            run.set_value(RUN_VALUE, &command)?;
            settings.set_value(SETTINGS_VALUE, &1u32)
        } else {
            // Persist the opt-out first: even if deletion is denied, NSIS must
            // not re-enable startup on the next update. The UI still reads Run.
            settings.set_value(SETTINGS_VALUE, &0u32)?;
            match run.delete_value(RUN_VALUE) {
                Ok(()) => Ok(()),
                Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
                Err(error) => Err(error),
            }
        }
    }

    pub fn enabled() -> io::Result<bool> {
        enabled_at(&RegKey::predef(HKEY_CURRENT_USER))
    }

    pub fn set_enabled(enabled: bool) -> io::Result<()> {
        let executable = std::env::current_exe()?;
        set_at(
            &RegKey::predef(HKEY_CURRENT_USER),
            enabled,
            executable.as_os_str(),
        )
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn disable_persists_opt_out_even_when_run_deletion_is_denied() {
            let hkcu = RegKey::predef(HKEY_CURRENT_USER);
            let path = format!(
                r"Software\MarkiroSignerTests\{}-delete-denied",
                std::process::id()
            );
            let (root, _) = hkcu.create_subkey(&path).unwrap();
            let executable = std::ffi::OsStr::new(r"C:\Apps\markiro-signer.exe");
            set_at(&root, true, executable).unwrap();
            let run = root.open_subkey_with_flags(RUN_KEY, KEY_READ).unwrap();
            let settings = root
                .open_subkey_with_flags(SETTINGS_KEY, KEY_ALL_ACCESS)
                .unwrap();

            // The read-only handle deterministically denies deletion without
            // changing ACLs or the user's real startup configuration.
            let error = set_registration(&run, &settings, false, executable).unwrap_err();
            assert_eq!(error.kind(), ErrorKind::PermissionDenied);
            assert_eq!(settings.get_value::<u32, _>(SETTINGS_VALUE).unwrap(), 0);
            assert!(enabled_at(&root).unwrap());
            drop(settings);
            drop(run);
            drop(root);
            hkcu.delete_subkey_all(path).unwrap();
        }

        #[test]
        fn registration_round_trip_preserves_opt_out_and_other_entries() {
            // Isolated disposable subtree: never touch the test user's actual Run key.
            let hkcu = RegKey::predef(HKEY_CURRENT_USER);
            let path = format!(r"Software\MarkiroSignerTests\{}", std::process::id());
            let (root, _) = hkcu.create_subkey(&path).unwrap();
            assert!(!enabled_at(&root).unwrap());
            let executable =
                std::ffi::OsStr::new(r"C:\Программы\Markiro Signer\Markiro Signer.exe");
            set_at(&root, true, executable).unwrap();
            assert!(enabled_at(&root).unwrap());
            let run = root
                .open_subkey_with_flags(RUN_KEY, KEY_ALL_ACCESS)
                .unwrap();
            let command: String = run.get_value(RUN_VALUE).unwrap();
            assert_eq!(command, format!("\"{}\"", executable.to_str().unwrap()));
            run.set_value("OtherApp", &"other.exe").unwrap();
            set_at(&root, false, executable).unwrap();
            set_at(&root, false, executable).unwrap();
            assert!(!enabled_at(&root).unwrap());
            assert_eq!(run.get_value::<String, _>("OtherApp").unwrap(), "other.exe");
            assert!(run.get_raw_value(RUN_VALUE).is_err());
            let settings = root.open_subkey(SETTINGS_KEY).unwrap();
            assert_eq!(settings.get_value::<u32, _>(SETTINGS_VALUE).unwrap(), 0);
            set_at(&root, true, executable).unwrap();
            assert_eq!(settings.get_value::<u32, _>(SETTINGS_VALUE).unwrap(), 1);
            drop(settings);
            drop(run);
            drop(root);
            hkcu.delete_subkey_all(path).unwrap();
        }
    }
}

pub fn enabled() -> Result<bool, String> {
    #[cfg(windows)]
    return windows::enabled().map_err(|error| error.to_string());
    #[cfg(not(windows))]
    Err("Windows only".into())
}

pub fn set_enabled(enabled: bool) -> Result<(), String> {
    #[cfg(windows)]
    return windows::set_enabled(enabled).map_err(|error| error.to_string());
    #[cfg(not(windows))]
    {
        let _ = enabled;
        Err("Windows only".into())
    }
}

#[cfg(all(test, not(windows)))]
mod tests {
    #[test]
    fn unsupported_platform_never_reports_fake_success() {
        assert!(super::enabled().is_err());
        assert!(super::set_enabled(true).is_err());
        assert!(super::set_enabled(false).is_err());
    }
}
