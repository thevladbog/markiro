mod support;

use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{admin, empty, request, with_device, TestApp};

/// `(code, alias, name)` of every row the cloud's migration `0099` inserts: the
/// one source of the lookup, read here and not copied into a fixture, which
/// would be a third copy. `0099` is applied and frozen, so a later cloud change
/// can only arrive as a NEW migration, as long as no cloud runtime code writes
/// the table (none does today: checked in `apps/api/src` and `packages`);
/// `no_other_cloud_migration_writes_the_product_groups` fails when a migration
/// does.
fn cloud_groups() -> Vec<(i64, String, String)> {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../packages/db/migrations/0099_chz_product_groups.sql"
    );
    let sql = std::fs::read_to_string(path).unwrap_or_else(|error| panic!("read {path}: {error}"));
    sql.lines()
        .map(str::trim)
        .filter(|line| line.starts_with('('))
        .map(|line| {
            let row = line
                .trim_end_matches(',')
                .strip_prefix('(')
                .and_then(|row| row.strip_suffix(')'))
                .unwrap_or_else(|| panic!("not a row: {line}"));
            let (code, rest) = row.split_once(", '").unwrap();
            let (alias, name) = rest.split_once("', '").unwrap();
            let name = name.strip_suffix('\'').unwrap();
            (
                code.parse().unwrap(),
                alias.to_owned(),
                name.replace("''", "'"),
            )
        })
        .collect()
}

/// What a statement says right before the name of the table it writes. In the
/// normalized text (`normalized`) each phrase is followed by exactly one space.
const WRITE_PHRASES: &[&str] = &[
    "insert into",
    "update",
    "delete from",
    "truncate",
    "truncate table",
    "alter table",
    "create table",
    "create table if not exists",
    "drop table",
    "drop table if exists",
];

/// `sql` as one lower-case line: comments dropped (a block comment leaves a
/// space), double quotes, backticks and `public.` removed, every run of
/// whitespace one space.
fn normalized(sql: &str) -> String {
    let mut text = String::with_capacity(sql.len());
    let mut rest = sql;
    while !rest.is_empty() {
        if let Some(comment) = rest.strip_prefix("/*") {
            // A block comment ends at the first `*/`, or with the file.
            rest = comment.split_once("*/").map_or("", |(_, after)| after);
            text.push(' ');
        } else if let Some(comment) = rest.strip_prefix("--") {
            // A line comment ends before the line break.
            rest = comment.find('\n').map_or("", |end| &comment[end..]);
        } else {
            let mut chars = rest.chars();
            if let Some(character) = chars.next() {
                text.push(character);
            }
            rest = chars.as_str();
        }
    }
    text.to_lowercase()
        .replace(['"', '`'], "")
        .replace("public.", "")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Whether the normalized `sql` writes `chz_product_groups`: one of the
/// `WRITE_PHRASES` and a space come right before the name, and no identifier
/// character follows it (`chz_product_groups_archive` is another table).
fn writes_groups(sql: &str) -> bool {
    const TABLE: &str = "chz_product_groups";
    for (start, _) in sql.match_indices(TABLE) {
        let before = sql[..start].strip_suffix(' ').unwrap_or("");
        let after = sql[start + TABLE.len()..].chars().next();
        let named_by_a_write = WRITE_PHRASES.iter().any(|phrase| before.ends_with(phrase));
        let whole_name = after.is_none_or(|next| {
            !(next.is_ascii_lowercase() || next.is_ascii_digit() || next == '_')
        });
        if named_by_a_write && whole_name {
            return true;
        }
    }
    false
}

/// Names of the `.sql` files in `dir`, sorted: the migrations the guard reads.
fn sql_files(dir: &std::path::Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .unwrap_or_else(|error| panic!("read {}: {error}", dir.display()))
        .map(|entry| {
            let entry = entry.unwrap_or_else(|error| panic!("list {}: {error}", dir.display()));
            entry.file_name().to_string_lossy().into_owned()
        })
        .filter(|name| name.ends_with(".sql"))
        .collect();
    names.sort();
    names
}

/// Names of the `.sql` files in `dir` (sorted), other than `except`, that write
/// the `chz_product_groups` table: INSERT INTO, UPDATE, DELETE FROM, TRUNCATE,
/// ALTER/CREATE/DROP TABLE. Comments are ignored, quotes and a `public.` prefix
/// do not matter, and a mere REFERENCES from another table is not a write.
fn migrations_writing_groups(dir: &std::path::Path, except: &str) -> Vec<String> {
    sql_files(dir)
        .into_iter()
        .filter(|name| name != except)
        .filter(|name| {
            let path = dir.join(name);
            let sql = std::fs::read_to_string(&path)
                .unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
            writes_groups(&normalized(&sql))
        })
        .collect()
}

#[tokio::test]
async fn the_host_holds_the_clouds_product_groups_row_for_row() {
    let app = TestApp::new().await;
    let host: Vec<(i64, String, String)> =
        sqlx::query_as("SELECT code, alias, name FROM chz_product_groups ORDER BY code")
            .fetch_all(&app.state.pool)
            .await
            .unwrap();
    let cloud = cloud_groups();
    assert_eq!(cloud.len(), 51, "the cloud migration lists 51 groups");
    assert_eq!(host, cloud);
}

#[tokio::test]
async fn every_office_role_lists_the_product_groups_by_code() {
    let admin = admin().await;
    let tech = admin.technologist().await;
    let expected: Vec<Value> = cloud_groups()
        .into_iter()
        .map(|(code, alias, name)| json!({ "code": code, "alias": alias, "name": name }))
        .collect();
    for token in [admin.token.clone(), tech] {
        let (status, body) = admin
            .call_as(&token, "GET", "/v1/office/product-groups", None)
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body, Value::Array(expected.clone()));
    }
}

#[tokio::test]
async fn product_groups_need_an_office_session() {
    let admin = admin().await;
    let (status, body) = admin
        .app
        .send(empty(with_device(
            request("GET", "/v1/office/product-groups"),
            &admin.key,
        )))
        .await;
    assert_eq!(
        (status, body["error"]["details"]["credential"].clone()),
        (StatusCode::UNAUTHORIZED, json!("session"))
    );
}

/// A scratch directory in the system's temp directory, removed when dropped,
/// so also when an assertion fails.
struct Scratch(std::path::PathBuf);

impl Scratch {
    fn new(name: &str) -> Self {
        let path = std::env::temp_dir().join(format!("markiro-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path)
            .unwrap_or_else(|error| panic!("create {}: {error}", path.display()));
        Self(path)
    }

    fn file(&self, name: &str, sql: &str) {
        std::fs::write(self.0.join(name), sql)
            .unwrap_or_else(|error| panic!("write {name}: {error}"));
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn a_migration_that_writes_the_groups_is_found() {
    let dir = Scratch::new("a_migration_that_writes_the_groups_is_found");
    dir.file(
        "0001_other.sql",
        r#"CREATE TABLE "other" ("id" integer PRIMARY KEY NOT NULL);"#,
    );
    // Another table's foreign key to the lookup reads it, it does not write it.
    dir.file(
        "0002_reference.sql",
        r#"ALTER TABLE "products" ADD CONSTRAINT "x" FOREIGN KEY ("g") REFERENCES "public"."chz_product_groups"("code");"#,
    );
    // A statement inside a comment is never run.
    dir.file(
        "0003_comments.sql",
        "-- INSERT INTO chz_product_groups\n/* update chz_product_groups */\nSELECT 1;\n",
    );
    dir.file(
        "0004_insert.sql",
        r#"INSERT INTO "public"."chz_product_groups" ("code", "alias", "name") VALUES (60, 'x', 'y');"#,
    );
    // Runs of spaces and a line break between the words do not hide a write.
    dir.file(
        "0005_update.sql",
        "UPDATE   \n  chz_product_groups SET name = 'x';\n",
    );
    // Another table whose name only starts with the lookup's name.
    dir.file(
        "0006_suffix.sql",
        "ALTER TABLE chz_product_groups_archive ADD COLUMN a int;\n",
    );
    // The file the host's rows come from is exempt.
    dir.file(
        "0099_chz_product_groups.sql",
        "INSERT INTO chz_product_groups (code, alias, name) VALUES (1, 'lp', 'x');\n",
    );
    assert_eq!(
        migrations_writing_groups(&dir.0, "0099_chz_product_groups.sql"),
        ["0004_insert.sql", "0005_update.sql"]
    );

    // Every statement kind the guard names is found, however the file is
    // written, and a name that only continues the lookup's is not.
    let kinds = Scratch::new("a_migration_that_writes_the_groups_is_found-kinds");
    let writes = [
        (
            "10_delete.sql",
            "DELETE FROM chz_product_groups WHERE code = 8;\n",
        ),
        ("11_truncate.sql", "TRUNCATE chz_product_groups;\n"),
        (
            "12_truncate_table.sql",
            "TRUNCATE TABLE chz_product_groups;\n",
        ),
        (
            "13_alter.sql",
            "ALTER TABLE chz_product_groups ADD COLUMN a int;\n",
        ),
        (
            "14_create.sql",
            "CREATE TABLE chz_product_groups (code int);\n",
        ),
        (
            "15_create_if_not_exists.sql",
            "CREATE TABLE IF NOT EXISTS chz_product_groups (code int);\n",
        ),
        ("16_drop.sql", "DROP TABLE chz_product_groups;\n"),
        (
            "17_drop_if_exists.sql",
            "DROP TABLE IF EXISTS chz_product_groups;\n",
        ),
        // The name is the last thing in the file.
        ("18_end_of_text.sql", "DELETE FROM chz_product_groups"),
        (
            "19_backticks.sql",
            "UPDATE `chz_product_groups` SET name = 'x';\n",
        ),
        (
            "20_crlf.sql",
            "INSERT INTO\r\n  chz_product_groups\r\n  VALUES (60, 'x', 'y');\r\n",
        ),
        // A comment is as good as a space between the words of a statement.
        (
            "21_comments_inside.sql",
            "INSERT/* a note */INTO -- another\n  chz_product_groups VALUES (60, 'x', 'y');\n",
        ),
        (
            "22_line_comment_alone.sql",
            "DELETE FROM--all\nchz_product_groups;\n",
        ),
    ];
    let others = [
        (
            "30_digit.sql",
            "ALTER TABLE chz_product_groups2 ADD COLUMN a int;\n",
        ),
        (
            "31_letter.sql",
            "ALTER TABLE chz_product_groupsx ADD COLUMN a int;\n",
        ),
        // Only `.sql` files are migrations.
        (
            "32_notes.txt",
            "INSERT INTO chz_product_groups VALUES (60, 'x', 'y');\n",
        ),
    ];
    for (name, sql) in writes.iter().chain(&others) {
        kinds.file(name, sql);
    }
    assert_eq!(
        migrations_writing_groups(&kinds.0, "none.sql"),
        writes.map(|(name, _)| name)
    );
}

#[test]
fn no_other_cloud_migration_writes_the_product_groups() {
    let dir = std::path::Path::new(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../packages/db/migrations"
    ));
    // The scan must not pass for want of files to read: a directory without
    // the migrations (moved, renamed, or pointed at the wrong place) finds no
    // writer. Every entry of the cloud's own journal is a file the scan reads.
    let journal_path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../packages/db/migrations/meta/_journal.json"
    );
    let journal: Value = serde_json::from_str(
        &std::fs::read_to_string(journal_path)
            .unwrap_or_else(|error| panic!("read {journal_path}: {error}")),
    )
    .unwrap_or_else(|error| panic!("parse {journal_path}: {error}"));
    let tags: Vec<&str> = journal["entries"]
        .as_array()
        .expect("the journal's entries")
        .iter()
        .map(|entry| entry["tag"].as_str().expect("an entry's tag"))
        .collect();
    assert!(!tags.is_empty(), "the journal lists no migration");
    let scanned = sql_files(dir);
    let unread: Vec<&str> = tags
        .iter()
        .copied()
        .filter(|tag| !scanned.contains(&format!("{tag}.sql")))
        .collect();
    assert!(
        unread.is_empty(),
        "the journal lists migration(s) {unread:?} that the scan of {} does not read ({} files)",
        dir.display(),
        scanned.len()
    );
    let list = migrations_writing_groups(dir, "0099_chz_product_groups.sql");
    assert!(
        list.is_empty(),
        "cloud migration(s) {list:?} write chz_product_groups: the host keeps its own \
         copy — add a host migration with the same change and extend this test"
    );
}
