use std::path::Path;

fn main() {
    // `sqlx::migrate!` embeds src-tauri/migrations at compile time; rebuild
    // when a migration is added or changed (mirrors `host/build.rs`).
    println!("cargo:rerun-if-changed=migrations");

    let mut attributes = tauri_build::Attributes::new();
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_env = std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    if target_os == "windows" && target_env == "msvc" {
        // Tauri links its application manifest (Common Controls v6) through
        // a resource that only the binaries get; a test executable without it
        // loads Common Controls v5 and dies before `main` with
        // STATUS_ENTRYPOINT_NOT_FOUND. The linker embeds the same manifest
        // (tauri-build's own, copied here) into every target instead.
        attributes = attributes
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR")).join("windows-app-manifest.xml");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    }
    // As `tauri_build::build()` reports a failure.
    if let Err(error) = tauri_build::try_build(attributes) {
        println!("{error:#}");
        std::process::exit(1);
    }
}
