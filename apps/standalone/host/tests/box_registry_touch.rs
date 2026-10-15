//! Every statement that writes the `boxes` table is known (plan ТСД-Х, task Х4): the registry the
//! handhelds mirror is derived from `boxes.changed_at`, so a writer that changes a closed box and
//! does not touch it would leave a handheld with a stale box until the next full walk.

use std::path::{Path, PathBuf};

fn sources(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            sources(&path, out);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            out.push(path);
        }
    }
}

/// `(file under src/, the statement, how many times)`: each with the reason it is allowed.
const WRITERS: &[(&str, &str, usize)] = &[
    // An open box has no SSCC and is not in the registry.
    ("facts/scan.rs", "INSERT INTO boxes", 1),
    // Closing: touches the box (`registry_touch::box_by_id`).
    ("facts/box_closed.rs", "UPDATE boxes SET", 1),
    // A label check changes print columns the registry does not carry.
    ("facts/box_label.rs", "UPDATE boxes SET", 1),
    // A box taken apart by a station's exception: touches the box.
    ("facts/exception.rs", "UPDATE boxes SET", 1),
    // A box taken apart by a disaggregation document: touches the box.
    ("disaggregation.rs", "UPDATE boxes SET", 1),
    // `registry_touch` itself.
    ("facts/registry_touch.rs", "UPDATE boxes SET", 4),
    // A unit-test fixture of the restore module, not a writer.
    ("restore.rs", "INSERT INTO boxes", 1),
];

#[test]
fn every_writer_of_boxes_is_known() {
    let mut files = Vec::new();
    sources(
        &Path::new(env!("CARGO_MANIFEST_DIR")).join("src"),
        &mut files,
    );
    let mut found: Vec<(String, &str, usize)> = Vec::new();
    for file in files {
        let text = std::fs::read_to_string(&file).unwrap();
        let relative = file
            .strip_prefix(Path::new(env!("CARGO_MANIFEST_DIR")).join("src"))
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        for statement in ["UPDATE boxes SET", "INSERT INTO boxes"] {
            let count = text.matches(statement).count();
            if count > 0 {
                found.push((relative.clone(), statement, count));
            }
        }
    }
    found.sort();
    let mut known: Vec<(String, &str, usize)> = WRITERS
        .iter()
        .map(|(file, statement, count)| ((*file).to_owned(), *statement, *count))
        .collect();
    known.sort();
    assert_eq!(
        found, known,
        "a new writer of `boxes`: decide whether it touches the registry"
    );
}
