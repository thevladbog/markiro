//! A folder of copies: what it holds, what is left of a broken copy, which
//! copies it keeps, how a copy reaches the second folder, and whether a
//! folder can take copies at all. Only names that start with
//! [`COPY_PREFIX`] are ever touched: a folder may hold other files. All
//! blocking.

use std::fs;
use std::path::Path;

use markiro_proto::backup::{dir_problems, failure};

use super::copy::{
    classify_io, create_private, is_copy_file_name, manifest_path, partial_path, read_manifest,
    sha256_file, write_synced, Failure, Manifest, COPY_PREFIX,
};
use super::retention;
use crate::clock::parse_timestamp;

fn ours(name: &str) -> bool {
    name.starts_with(COPY_PREFIX)
}

/// The verified copies in `dir`, newest first: a `<name>.db` whose
/// manifest reads and names it, with the size the manifest says. A copy
/// without them is no copy.
pub fn list(dir: &Path) -> std::io::Result<Vec<Manifest>> {
    let mut copies = Vec::new();
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !ours(name) || !name.ends_with(".db") {
            continue;
        }
        let path = entry.path();
        let Ok(manifest) = read_manifest(&path) else {
            continue;
        };
        let Ok(metadata) = fs::metadata(&path) else {
            continue;
        };
        if metadata.len() != manifest.size_bytes || parse_timestamp(&manifest.created_at).is_err() {
            continue;
        }
        copies.push(manifest);
    }
    copies.sort_by(|a, b| {
        b.created_at
            .cmp(&a.created_at)
            .then_with(|| b.file.cmp(&a.file))
    });
    Ok(copies)
}

/// Remove what broken copies left in `dir`: `.partial` files and a `.db`
/// without its manifest. Returns how many files went. Only for a moment when
/// no copy is being written into `dir`: a copy in flight looks the same.
pub fn clean(dir: &Path) -> std::io::Result<usize> {
    let mut removed = 0;
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !ours(name) {
            continue;
        }
        let path = entry.path();
        let broken =
            name.ends_with(".partial") || (name.ends_with(".db") && !manifest_path(&path).exists());
        if broken {
            fs::remove_file(&path)?;
            removed += 1;
        }
    }
    Ok(removed)
}

/// Delete the copies of `dir` that [`retention::keep`] does not keep: the
/// manifest first, so a copy half deleted is a `.db` without one, which
/// [`clean`] removes. Returns the copies that stay, newest first.
pub fn rotate(dir: &Path) -> std::io::Result<Vec<Manifest>> {
    let copies = list(dir)?;
    let dated: Vec<(String, time::OffsetDateTime)> = copies
        .iter()
        .filter_map(|copy| {
            parse_timestamp(&copy.created_at)
                .ok()
                .map(|at| (copy.file.clone(), at))
        })
        .collect();
    let kept = retention::keep(&dated);
    let mut staying = Vec::new();
    for copy in copies {
        if kept.contains(&copy.file) {
            staying.push(copy);
            continue;
        }
        let db = dir.join(&copy.file);
        fs::remove_file(manifest_path(&db))?;
        fs::remove_file(&db)?;
    }
    Ok(staying)
}

/// Put the verified copy `manifest` of `source_dir` into `dest_dir`:
/// `<name>.db.partial`, synced, read back and hashed, compared with the
/// manifest, renamed, and the same manifest beside it. A folder that is not
/// there is `destination_unavailable`; nothing is created in its place. A
/// failure removes what this call wrote, and never a copy of that name that
/// was already in `dest_dir`. The copy in `source_dir` is left alone, and a
/// source that cannot be read is `local_copy_failed`.
pub fn replicate(source_dir: &Path, manifest: &Manifest, dest_dir: &Path) -> Result<(), Failure> {
    if !is_copy_file_name(&manifest.file) {
        return Err(Failure::new(
            failure::INTERNAL,
            "the manifest names no copy file",
        ));
    }
    match fs::metadata(dest_dir) {
        Ok(metadata) if metadata.is_dir() => {}
        Ok(_) => {
            return Err(Failure::new(
                failure::DESTINATION_UNAVAILABLE,
                format!("{} is not a folder", dest_dir.display()),
            ))
        }
        Err(error) => return Err(Failure::new(classify_io(&error), error.to_string())),
    }
    let source = source_dir.join(&manifest.file);
    let target = dest_dir.join(&manifest.file);
    let partial = partial_path(&target);
    let was_there = target.exists();
    let mut renamed = false;
    let copied = copy_and_check(&source, &partial, &target, manifest, &mut renamed);
    if copied.is_err() {
        let _ = fs::remove_file(&partial);
        let _ = fs::remove_file(partial_path(&manifest_path(&target)));
        if renamed && !was_there {
            let _ = fs::remove_file(&target);
        }
    }
    copied
}

fn copy_and_check(
    source: &Path,
    partial: &Path,
    target: &Path,
    manifest: &Manifest,
    renamed: &mut bool,
) -> Result<(), Failure> {
    let io = |error: std::io::Error| Failure::new(classify_io(&error), error.to_string());
    let mut from = fs::File::open(source)
        .map_err(|error| Failure::new(failure::LOCAL_COPY_FAILED, error.to_string()))?;
    let mut to = create_private(partial, false).map_err(io)?;
    std::io::copy(&mut from, &mut to).map_err(io)?;
    to.sync_all().map_err(io)?;
    drop(to);
    let (size, sha256) = sha256_file(partial).map_err(io)?;
    if size != manifest.size_bytes || sha256 != manifest.sha256 {
        return Err(Failure::new(
            failure::VERIFY_FAILED,
            format!("{} differs from its source", partial.display()),
        ));
    }
    fs::rename(partial, target).map_err(io)?;
    *renamed = true;
    let bytes = serde_json::to_vec_pretty(manifest)
        .map_err(|error| Failure::new(failure::INTERNAL, error.to_string()))?;
    write_synced(&manifest_path(target), &bytes).map_err(io)
}

/// Whether `dir` can take copies: it is there, is a folder, and the host
/// can create and remove a file in it. `data_dir` is the host's data
/// folder: a folder inside it dies with the data. `Err` is one of
/// `markiro_proto::backup::dir_problems`.
pub fn probe(dir: &Path, data_dir: &Path) -> Result<(), &'static str> {
    let metadata = match fs::metadata(dir) {
        Ok(metadata) => metadata,
        Err(error) => {
            return Err(match classify_io(&error) {
                failure::ACCESS_DENIED => dir_problems::ACCESS_DENIED,
                _ => dir_problems::MISSING,
            })
        }
    };
    if !metadata.is_dir() {
        return Err(dir_problems::NOT_A_DIRECTORY);
    }
    if let (Ok(dir), Ok(data_dir)) = (fs::canonicalize(dir), fs::canonicalize(data_dir)) {
        if dir.starts_with(&data_dir) {
            return Err(dir_problems::INSIDE_DATA_DIR);
        }
    }
    let probe = dir.join(format!(".markiro-probe-{}", uuid::Uuid::new_v4().simple()));
    match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe)
    {
        Ok(file) => {
            drop(file);
            fs::remove_file(&probe).map_err(|_| dir_problems::UNWRITABLE)
        }
        Err(error) => Err(match classify_io(&error) {
            failure::ACCESS_DENIED => dir_problems::ACCESS_DENIED,
            _ => dir_problems::UNWRITABLE,
        }),
    }
}
