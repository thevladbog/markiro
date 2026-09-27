fn main() {
    // `sqlx::migrate!` embeds src-tauri/migrations at compile time; rebuild
    // when a migration is added or changed (mirrors `host/build.rs`).
    println!("cargo:rerun-if-changed=migrations");
    tauri_build::build();
}
