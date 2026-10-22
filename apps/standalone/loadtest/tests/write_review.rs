//! The write review of spec §8, kept as a test: the host has one writer at a
//! time (SQLite's own lock), and every hot write path must take it up front.
//! A transaction that reads on a snapshot and then writes (a deferred
//! `BEGIN`, then an `INSERT`) fails with SQLITE_BUSY the moment another
//! writer commits in between, whatever `busy_timeout` says: `db::begin_write`
//! (`BEGIN IMMEDIATE`) is the rule for a transaction that writes. This test
//! reads the host's source; it is a heuristic, and a line it flags is read
//! by a person, not silenced.

use std::path::{Path, PathBuf};

fn host_src() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../host/src")
}

fn rust_files(dir: &Path, found: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            rust_files(&path, found);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            found.push(path);
        }
    }
}

fn starts_a_function(line: &str) -> bool {
    let line = line
        .trim_start_matches("pub(crate) ")
        .trim_start_matches("pub ");
    line.starts_with("fn ") || line.starts_with("async fn ")
}

/// A top-level item other than a function (a `const` of SQL between two
/// functions is not the code of the function before it).
fn starts_an_item(line: &str) -> bool {
    if line.starts_with(char::is_whitespace) {
        return false;
    }
    let line = line
        .trim_start_matches("pub(crate) ")
        .trim_start_matches("pub ");
    [
        "const ", "static ", "enum ", "struct ", "impl", "mod ", "type ", "trait ",
    ]
    .iter()
    .any(|word| line.starts_with(word))
}

/// The 1-based lines of `pool.begin()` (a deferred transaction) after which
/// the same function writes: from the call to the next function there is an
/// INSERT, UPDATE or DELETE.
fn deferred_then_write(text: &str) -> Vec<usize> {
    let lines: Vec<&str> = text.lines().collect();
    let mut flagged = Vec::new();
    for (at, line) in lines.iter().enumerate() {
        if !line.contains("pool.begin()") {
            continue;
        }
        let end = (at + 1..lines.len())
            .find(|next| starts_a_function(lines[*next]) || starts_an_item(lines[*next]))
            .unwrap_or(lines.len());
        let writes = lines[at..end].iter().any(|line| {
            let trimmed = line.trim_start();
            !trimmed.starts_with("//")
                && ["INSERT ", "UPDATE ", "DELETE "]
                    .iter()
                    .any(|word| line.contains(word))
        });
        if writes {
            flagged.push(at + 1);
        }
    }
    flagged
}

/// The text of the function called `name`, up to the next function.
fn function_text(text: &str, name: &str) -> Option<String> {
    let lines: Vec<&str> = text.lines().collect();
    let start = lines
        .iter()
        .position(|line| starts_a_function(line) && line.contains(&format!("fn {name}(")))?;
    let end = (start + 1..lines.len())
        .find(|next| starts_a_function(lines[*next]))
        .unwrap_or(lines.len());
    Some(lines[start..end].join("\n"))
}

#[test]
fn the_heuristic_flags_a_read_then_write_on_a_deferred_transaction() {
    let bad = "async fn a() {\n    let mut tx = state.pool.begin().await?;\n    sqlx::query(\"SELECT 1\");\n    sqlx::query(\"UPDATE t SET x = 1\");\n}\n";
    let good = "async fn a() {\n    let mut tx = state.pool.begin().await?;\n    sqlx::query(\"SELECT 1\");\n}\nasync fn b() {\n    sqlx::query(\"UPDATE t SET x = 1\");\n}\n";
    let sql_after = "async fn a() {\n    let mut tx = state.pool.begin().await?;\n    sqlx::query(\"SELECT 1\");\n}\nconst REMOVE: &[&str] = &[\"DELETE FROM t\"];\n";
    assert_eq!(deferred_then_write(bad), vec![2]);
    assert!(deferred_then_write(sql_after).is_empty());
    assert!(deferred_then_write(good).is_empty());
    assert!(function_text(good, "b").unwrap().contains("UPDATE"));
    assert!(!function_text(good, "b").unwrap().contains("SELECT"));
}

#[test]
fn no_route_reads_on_a_deferred_transaction_and_then_writes() {
    let mut files = Vec::new();
    rust_files(&host_src(), &mut files);
    assert!(files.len() > 50, "the host's source was not found");
    let mut flagged = Vec::new();
    for file in files {
        let text = std::fs::read_to_string(&file).unwrap();
        for line in deferred_then_write(&text) {
            flagged.push(format!("{}:{line}", file.display()));
        }
    }
    assert!(
        flagged.is_empty(),
        "read-then-write on a deferred transaction: {flagged:?}"
    );
}

#[test]
fn the_hot_write_paths_take_the_write_lock_up_front() {
    let src = host_src();
    for (file, name) in [
        ("routes/facts.rs", "receive_facts"),
        ("routes/sscc_blocks.rs", "issue_block"),
        ("routes/device_shifts.rs", "enter_shift"),
    ] {
        let text = std::fs::read_to_string(src.join(file)).unwrap();
        let function =
            function_text(&text, name).unwrap_or_else(|| panic!("{file} has no fn {name}"));
        assert!(
            function.contains("begin_write("),
            "{file} {name} must start with db::begin_write"
        );
        assert!(
            !function.contains("pool.begin()"),
            "{file} {name} must not begin a deferred transaction"
        );
    }
}

#[test]
fn the_code_check_reads_without_a_transaction_and_a_copy_is_one_statement() {
    let src = host_src();
    let check = std::fs::read_to_string(src.join("routes/codes.rs")).unwrap();
    assert!(check.contains("pool.acquire()"));
    assert!(
        !check.contains("begin"),
        "the code check must not open a transaction"
    );
    let copy = std::fs::read_to_string(src.join("backup/copy.rs")).unwrap();
    assert!(
        copy.contains("VACUUM INTO ?"),
        "a backup copies with one statement, holding no long read transaction"
    );
}

#[test]
fn a_facts_batch_is_one_short_transaction_of_at_most_a_hundred_records() {
    let src = host_src();
    let route = std::fs::read_to_string(src.join("routes/facts.rs")).unwrap();
    assert!(route.contains("pub const MAX_RECORDS: usize = 100;"));
    let function = function_text(&route, "receive_facts").unwrap();
    assert_eq!(
        function.matches("begin_write(").count(),
        1,
        "one transaction a batch"
    );
    assert!(
        !function.contains("reqwest") && !function.contains("sleep"),
        "no waiting inside the transaction"
    );
}
