//! Files the office saves on this computer (plan ЧЗ): the parts of an export,
//! a printed form's HTML (plan О-Ф) and the license's activation request
//! (plan ЛЦ-3). Everything goes under
//! `Документы\Markiro` (the system's documents folder, `document_dir`), in a
//! first folder of [`ROOTS`] and the segments the webview names: no file
//! dialog, so no plugin and no new dependency (pilot spec, question П16).
//! The last segment is a folder of its own for each call: one that exists
//! already gets « (2)», « (3)» and so on, so files are never written over
//! and an export never lands beside an older one's parts. Every name is
//! checked before anything is written, and a call that fails takes back
//! the folder it made. `open_office_folder` shows such a folder in Windows
//! Explorer, and `open_office_file` opens a form's `.html` there with the
//! program Windows has for it, the default browser (plan О-Ф). A failure is
//! logged by its code and the I/O error's kind, never by a path, which
//! names the Windows user.
//!
//! A name holds letters and digits of any script, spaces and `-_.()` only,
//! and a file's name ends in an extension the office writes: nothing that
//! Explorer's command line, a shell or the eye could misread, and nothing
//! that runs when it is opened.

#[cfg(any(windows, test))]
use std::ffi::{OsStr, OsString};
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::{Deserialize, Serialize};

/// The first folders under `Документы\Markiro` the office writes into:
/// exports (plan ЧЗ), forms (plan О-Ф) and the license's activation request
/// (plan ЛЦ-3, license spec §6.3).
pub const ROOTS: [&str; 3] = ["Выгрузки", "Формы", LICENSE_ROOT];

/// The root the activation request is saved under (plan ЛЦ-3). Nothing is
/// opened from it: `open_office_file` opens forms only.
pub const LICENSE_ROOT: &str = "Лицензия";

/// The root a form is opened from: `open_office_file` takes a file of no
/// other (the parts of an export are data, not documents to start).
pub const FORMS_ROOT: &str = "Формы";

/// The one extension `open_office_file` starts, in any case.
pub const FORM_EXTENSION: &str = "html";

/// The folder under the documents folder.
pub const APP_FOLDER: &str = "Markiro";

/// The folder under [`APP_FOLDER`] where an administrator puts update
/// packages (plan ОБН-2, spec §10.5). The office never writes into it, so it
/// is not one of [`ROOTS`]; `update_open_folder` makes it and shows it.
pub const UPDATES_ROOT: &str = "Обновления";

/// The most files one call writes, and their most bytes in all.
pub const MAX_FILES: usize = 100_000;
pub const MAX_TOTAL_BYTES: usize = 256 * 1024 * 1024;

/// The longest name of a folder or a file, in characters.
pub const MAX_NAME_CHARS: usize = 150;

/// The characters of the suffix a folder gets when its name is taken
/// (« (99)»): the last segment of a call leaves room for it, so a folder
/// the call made always has a name that can be opened.
const SUFFIX_CHARS: usize = 5;

/// The longest path of a file, in UTF-16 units, counted with the longest
/// suffix: under Windows' 260, so that Explorer, a browser's file dialog and
/// 1С can open what was written.
pub const MAX_PATH_UNITS: usize = 240;

/// The extensions of the files the office writes: the parts of an export,
/// a form's HTML and the license's activation request (`json`, plan ЛЦ-3).
/// A file of another kind (a script, a shortcut, a program) is never
/// written, whatever the webview asks.
pub const FILE_EXTENSIONS: [&str; 5] = ["csv", "txt", "xml", "html", "json"];

/// The most segments of one path, the root among them.
pub const MAX_SEGMENTS: usize = 8;

/// Why a call failed; the webview reads the bare code.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OfficeFilesError {
    /// A segment or a name that is no plain name, a root not in [`ROOTS`],
    /// two files of one name, no file, too many or too large, a payload that
    /// is no base64, or a folder to open that does not exist. Nothing was
    /// written.
    InvalidRequest,
    /// The system has no documents folder for this user.
    DocumentsUnavailable,
    /// Writing failed (a full disk, no access); what this call made is gone.
    Storage,
    /// Showing a folder or opening a file needs Windows Explorer.
    Unsupported,
}

impl OfficeFilesError {
    pub fn code(self) -> &'static str {
        match self {
            OfficeFilesError::InvalidRequest => "invalid_request",
            OfficeFilesError::DocumentsUnavailable => "documents_unavailable",
            OfficeFilesError::Storage => "storage",
            OfficeFilesError::Unsupported => "unsupported",
        }
    }
}

/// One file: its name and its bytes, base64-encoded (Tauri's IPC is JSON).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfficeFile {
    pub name: String,
    pub content_base64: String,
}

/// Where the files went: the segments as written (the last one perhaps with
/// « (2)»), the folder's full path to show, and the names in order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedFolder {
    pub segments: Vec<String>,
    pub path: String,
    pub files: Vec<String>,
}

/// The office's folder on this computer: `Документы\Markiro`, or none when
/// the system has no documents folder. `run` manages it from the app's path
/// resolver; tests manage one of a temporary directory.
#[derive(Debug, Clone)]
pub struct OfficeFilesState {
    root: Option<PathBuf>,
}

impl OfficeFilesState {
    /// The office's folder inside `documents`.
    pub fn from_documents(documents: Option<PathBuf>) -> Self {
        Self {
            root: documents.map(|documents| documents.join(APP_FOLDER)),
        }
    }

    /// Exactly `root` (tests).
    pub fn at(root: PathBuf) -> Self {
        Self { root: Some(root) }
    }

    /// No documents folder: every call is `documents_unavailable`.
    pub fn unavailable() -> Self {
        Self { root: None }
    }

    fn root(&self) -> Result<PathBuf, OfficeFilesError> {
        self.root
            .clone()
            .ok_or(OfficeFilesError::DocumentsUnavailable)
    }
}

/// A character a name may hold: a letter or a digit of any script (Cyrillic
/// among them), a space, and `-_.()`. Everything else is out: the characters
/// Windows forbids, those that split Explorer's command line (`,` `;`), those
/// the shell expands (`%` `&` `^` `~` `$`), and every one that hides or
/// reorders text (zero-width ones, line separators, bidirectional controls,
/// the byte order mark), none of which is a letter or a digit.
fn is_name_char(c: char) -> bool {
    c.is_alphabetic() || c.is_numeric() || matches!(c, ' ' | '-' | '_' | '.' | '(' | ')')
}

/// A name of one folder or file: not empty, at most [`MAX_NAME_CHARS`]
/// characters, only [`is_name_char`] characters, not `.` or `..`, not ending
/// in a dot or a space, and no Windows device name (`CON`, `PRN`, `AUX`,
/// `NUL`, `COM1`–`COM9` and `LPT1`–`LPT9`, the superscript digits `¹²³`
/// too), with an extension or without, and with spaces before the extension
/// or without.
pub fn is_plain_name(name: &str) -> bool {
    let reserved = |stem: &str| {
        let upper = stem.trim_end_matches(' ').to_ascii_uppercase();
        let chars: Vec<char> = upper.chars().collect();
        ["CON", "PRN", "AUX", "NUL"].contains(&upper.as_str())
            || (chars.len() == 4
                && (upper.starts_with("COM") || upper.starts_with("LPT"))
                && matches!(chars[3], '1'..='9' | '\u{b9}' | '\u{b2}' | '\u{b3}'))
    };
    !name.is_empty()
        && name.chars().count() <= MAX_NAME_CHARS
        && name.chars().all(is_name_char)
        && name != "."
        && name != ".."
        && !name.ends_with('.')
        && !name.ends_with(' ')
        && !reserved(name.split('.').next().unwrap_or(name))
}

/// The name of a file: a plain name with a stem and one of
/// [`FILE_EXTENSIONS`], in any case.
pub fn is_plain_file_name(name: &str) -> bool {
    is_plain_name(name)
        && name.rsplit_once('.').is_some_and(|(stem, extension)| {
            !stem.is_empty() && FILE_EXTENSIONS.contains(&extension.to_ascii_lowercase().as_str())
        })
}

fn check_segments(segments: &[String]) -> Result<(), OfficeFilesError> {
    let first = segments.first().ok_or(OfficeFilesError::InvalidRequest)?;
    if segments.len() < 2
        || segments.len() > MAX_SEGMENTS
        || !ROOTS.contains(&first.as_str())
        || !segments.iter().all(|segment| is_plain_name(segment))
    {
        return Err(OfficeFilesError::InvalidRequest);
    }
    Ok(())
}

/// The longest base64 text of a content of `bytes` bytes (padded groups of
/// four characters for each three bytes).
fn encoded_cap(bytes: usize) -> usize {
    bytes.div_ceil(3).saturating_mul(4)
}

/// Every file decoded, checked before the disk is touched.
fn decode(files: &[OfficeFile]) -> Result<Vec<(String, Vec<u8>)>, OfficeFilesError> {
    decode_with(files, MAX_FILES, MAX_TOTAL_BYTES)
}

/// [`decode`] with its caps given. A text longer than the cap lets in is
/// refused before it is decoded, so a huge payload costs no memory twice.
fn decode_with(
    files: &[OfficeFile],
    max_files: usize,
    max_total: usize,
) -> Result<Vec<(String, Vec<u8>)>, OfficeFilesError> {
    if files.is_empty() || files.len() > max_files {
        return Err(OfficeFilesError::InvalidRequest);
    }
    let mut seen = std::collections::HashSet::new();
    let mut total = 0usize;
    let mut decoded = Vec::with_capacity(files.len());
    for file in files {
        // Windows names differ only by case at most once in one folder.
        if !is_plain_file_name(&file.name)
            || !seen.insert(file.name.to_lowercase())
            || file.content_base64.len() > encoded_cap(max_total)
        {
            return Err(OfficeFilesError::InvalidRequest);
        }
        let bytes = STANDARD
            .decode(&file.content_base64)
            .map_err(|_| OfficeFilesError::InvalidRequest)?;
        total = total.saturating_add(bytes.len());
        if total > max_total {
            return Err(OfficeFilesError::InvalidRequest);
        }
        decoded.push((file.name.clone(), bytes));
    }
    Ok(decoded)
}

/// Whether the longest path this call can write fits [`MAX_PATH_UNITS`]:
/// the root, every segment, the longest suffix a folder gets and the longest
/// file name, with a separator before each, in UTF-16 units (the unit
/// Windows counts in; a character outside the basic plane is two).
fn path_fits(
    root: &Path,
    segments: &[String],
    files: &[(String, Vec<u8>)],
    max_units: usize,
) -> bool {
    let units = |text: &str| text.encode_utf16().count();
    let folders: usize = segments.iter().map(|segment| 1 + units(segment)).sum();
    let longest = files.iter().map(|(name, _)| units(name)).max().unwrap_or(0);
    units(&root.to_string_lossy()) + folders + SUFFIX_CHARS + 1 + longest <= max_units
}

/// Logs an I/O failure by its kind (a path names the Windows user) and says
/// `storage`.
fn storage(what: &str, error: &std::io::Error) -> OfficeFilesError {
    eprintln!("standalone: {what} storage: {:?}", error.kind());
    OfficeFilesError::Storage
}

/// What is at a path in the office's folders. A link (a symbolic link or a
/// junction) counts as `Other`, like a file: it is never followed.
enum Found {
    Missing,
    Folder,
    Other,
}

fn inspect(path: &Path, what: &str) -> Result<Found, OfficeFilesError> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() || !meta.is_dir() => Ok(Found::Other),
        Ok(_) => Ok(Found::Folder),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Found::Missing),
        Err(error) => Err(storage(what, &error)),
    }
}

/// The folder `root/parents…`, made as far as it does not exist yet. Every
/// folder on the way must be a real folder, not a link or a file: the files
/// could go anywhere through a link. (`root` itself is trusted: it may be a
/// redirected Documents folder.)
fn ensure_folders(root: &Path, parents: &[String]) -> Result<PathBuf, OfficeFilesError> {
    const WHAT: &str = "save_office_files";
    fs::create_dir_all(root).map_err(|error| storage(WHAT, &error))?;
    let mut path = root.to_path_buf();
    for segment in parents {
        path.push(segment);
        let found = match inspect(&path, WHAT)? {
            Found::Missing => match fs::create_dir(&path) {
                Ok(()) => Found::Folder,
                // Another call made it between the look and the make.
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    inspect(&path, WHAT)?
                }
                Err(error) => return Err(storage(WHAT, &error)),
            },
            found => found,
        };
        if !matches!(found, Found::Folder) {
            eprintln!("standalone: save_office_files storage: not a plain folder");
            return Err(OfficeFilesError::Storage);
        }
    }
    Ok(path)
}

/// The folder of this call, made new: `last`, or `last (2)` … `last (99)`.
fn new_folder(parent: &Path, last: &str) -> Result<(String, PathBuf), OfficeFilesError> {
    for n in 1..=99u32 {
        let name = if n == 1 {
            last.to_owned()
        } else {
            format!("{last} ({n})")
        };
        let path = parent.join(&name);
        match fs::create_dir(&path) {
            Ok(()) => return Ok((name, path)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(storage("save_office_files", &error)),
        }
    }
    eprintln!("standalone: save_office_files storage: 99 folders of one name");
    Err(OfficeFilesError::Storage)
}

/// Takes back the folder of a call that failed, with `remove`. When it
/// cannot (a lock held by an antivirus or a sync client), a partial export
/// stays where the user can find it: the kind of that failure is logged, and
/// returned.
fn take_back<R>(folder: &Path, remove: R) -> Option<std::io::ErrorKind>
where
    R: FnOnce(&Path) -> std::io::Result<()>,
{
    remove(folder).err().map(|error| {
        eprintln!(
            "standalone: save_office_files cleanup left a partial folder: {:?}",
            error.kind()
        );
        error.kind()
    })
}

/// A new file at `path`, which must not exist (a link there is not followed),
/// readable by its owner alone where the system has owners: a form holds the
/// organization's products and codes.
fn create_new_file(path: &Path) -> std::io::Result<File> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

/// Writes every file into `folder`, which this call made; on a failure the
/// folder goes, with whatever was written into it.
pub fn write_into(folder: &Path, files: &[(String, Vec<u8>)]) -> Result<(), OfficeFilesError> {
    let written = files.iter().try_for_each(|(name, bytes)| {
        let mut file = create_new_file(&folder.join(name))?;
        file.write_all(bytes)?;
        file.sync_all()
    });
    if let Err(error) = written {
        take_back(folder, |path: &Path| fs::remove_dir_all(path));
        return Err(storage("save_office_files", &error));
    }
    Ok(())
}

/// Saves `files` into a new folder `root/segments…` (see the module).
pub fn save_files(
    root: &Path,
    segments: &[String],
    files: &[OfficeFile],
) -> Result<SavedFolder, OfficeFilesError> {
    save_with(root, segments, files, write_into)
}

/// [`save_files`] with the writer of the new folder given (a test makes it
/// fail).
fn save_with<W>(
    root: &Path,
    segments: &[String],
    files: &[OfficeFile],
    write: W,
) -> Result<SavedFolder, OfficeFilesError>
where
    W: FnOnce(&Path, &[(String, Vec<u8>)]) -> Result<(), OfficeFilesError>,
{
    check_segments(segments)?;
    let decoded = decode(files)?;
    let (last, parents) = segments
        .split_last()
        .ok_or(OfficeFilesError::InvalidRequest)?;
    // The folder of this call may get « (99)»: its name must stay one that
    // `open_office_folder` takes, and its files' paths ones Windows opens.
    if last.chars().count() > MAX_NAME_CHARS - SUFFIX_CHARS
        || !path_fits(root, segments, &decoded, MAX_PATH_UNITS)
    {
        return Err(OfficeFilesError::InvalidRequest);
    }
    let parent = ensure_folders(root, parents)?;
    let (name, folder) = new_folder(&parent, last)?;
    write(&folder, &decoded)?;
    let mut saved = parents.to_vec();
    saved.push(name);
    Ok(SavedFolder {
        segments: saved,
        path: folder.display().to_string(),
        files: decoded.into_iter().map(|(name, _)| name).collect(),
    })
}

/// The folder `root/segments…`, which must exist, every folder on the way a
/// real one (not a link).
pub fn existing_folder(root: &Path, segments: &[String]) -> Result<PathBuf, OfficeFilesError> {
    check_segments(segments)?;
    let mut folder = root.to_path_buf();
    for segment in segments {
        folder.push(segment);
        match inspect(&folder, "open_office_folder") {
            Ok(Found::Folder) => {}
            Ok(_) => return Err(OfficeFilesError::InvalidRequest),
            Err(error) => return Err(error),
        }
    }
    Ok(folder)
}

/// The form `root/segments…/name` to open: a `.html` file of a plain name,
/// in a folder under [`FORMS_ROOT`] that `save_files` made. Nothing else is
/// opened, so no file the webview names can be started as a program: the
/// way and the name are checked whole before anything is looked at, every
/// folder on the way is a real folder (not a link), and the file itself is
/// a regular file (not a link, not a folder).
pub fn existing_form(
    root: &Path,
    segments: &[String],
    name: &str,
) -> Result<PathBuf, OfficeFilesError> {
    let is_html = is_plain_file_name(name)
        && name
            .rsplit_once('.')
            .is_some_and(|(_, extension)| extension.eq_ignore_ascii_case(FORM_EXTENSION));
    if segments.first().map(String::as_str) != Some(FORMS_ROOT) || !is_html {
        return Err(OfficeFilesError::InvalidRequest);
    }
    let file = existing_folder(root, segments)?.join(name);
    match fs::symlink_metadata(&file) {
        Ok(meta) if meta.file_type().is_file() => Ok(file),
        Ok(_) => Err(OfficeFilesError::InvalidRequest),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Err(OfficeFilesError::InvalidRequest)
        }
        Err(error) => Err(storage("open_office_file", &error)),
    }
}

/// How Explorer is started to show a folder or open a file: its program,
/// the one argument and the directory it starts in.
#[cfg(any(windows, test))]
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct ExplorerLaunch {
    pub(crate) program: PathBuf,
    pub(crate) argument: OsString,
    pub(crate) current_dir: PathBuf,
}

/// The launch of Windows Explorer for `folder`, a folder to show or a file to
/// open with the program Windows has for its type. The program is
/// `%SystemRoot%\explorer.exe` by its place: started by name, the system would
/// look in the application's folder and the current directory first. The
/// argument is the path in double quotes, always: Explorer does not read
/// its command line by the usual rules but splits it at commas, so a folder
/// named `x,y` unquoted would be two arguments. It starts in the system
/// folder, not in the application's or in the folder it shows, which holds
/// what the webview wrote. A path with a double quote (no Windows path has)
/// is no launch.
#[cfg(any(windows, test))]
pub(crate) fn explorer_launch(
    target: &Path,
    system_root: Option<&OsStr>,
) -> Option<ExplorerLaunch> {
    if target.as_os_str().to_string_lossy().contains('"') {
        return None;
    }
    let system = system_root.map_or_else(|| PathBuf::from(r"C:\Windows"), PathBuf::from);
    let mut argument = OsString::from("\"");
    argument.push(target);
    argument.push("\"");
    Some(ExplorerLaunch {
        program: system.join("explorer.exe"),
        argument,
        current_dir: system,
    })
}

/// Hands `target` (a folder, or a file of a type Windows has a program for)
/// to Explorer, which shows the folder or starts the program; `what` names
/// the command in the log.
#[cfg(windows)]
fn launch_explorer(target: &Path, what: &str) -> Result<(), OfficeFilesError> {
    use std::os::windows::process::CommandExt;

    let launch = explorer_launch(target, std::env::var_os("SystemRoot").as_deref())
        .ok_or(OfficeFilesError::InvalidRequest)?;
    // Explorer answers 1 even when it did what was asked: only a failure to
    // start it counts. `raw_arg` hands the quoted text over as it is.
    std::process::Command::new(&launch.program)
        .raw_arg(&launch.argument)
        .current_dir(&launch.current_dir)
        .spawn()
        .map(|_| ())
        .map_err(|error| storage(what, &error))
}

#[cfg(not(windows))]
fn launch_explorer(_target: &Path, _what: &str) -> Result<(), OfficeFilesError> {
    Err(OfficeFilesError::Unsupported)
}

fn show_in_explorer(folder: &Path) -> Result<(), OfficeFilesError> {
    launch_explorer(folder, "open_office_folder")
}

/// Shows a folder of the app other than the office's (the updates folder,
/// plan ОБН-2) in Windows Explorer, started as for the office's folders.
pub(crate) fn show_folder(folder: &Path) -> Result<(), OfficeFilesError> {
    launch_explorer(folder, "update_open_folder")
}

/// Opens a form's `.html` (found by [`existing_form`]) with the program
/// Windows has for it: the default browser.
fn open_in_default_program(file: &Path) -> Result<(), OfficeFilesError> {
    launch_explorer(file, "open_office_file")
}

/// Saves the office's files (see the module); off the IPC thread.
#[tauri::command]
pub async fn save_office_files(
    state: tauri::State<'_, OfficeFilesState>,
    segments: Vec<String>,
    files: Vec<OfficeFile>,
) -> Result<SavedFolder, String> {
    let root = state.root().map_err(|error| error.code().to_owned())?;
    tauri::async_runtime::spawn_blocking(move || save_files(&root, &segments, &files))
        .await
        .map_err(|_| OfficeFilesError::Storage.code().to_owned())?
        .map_err(|error| error.code().to_owned())
}

/// Shows a folder `save_office_files` made in Windows Explorer.
#[tauri::command]
pub async fn open_office_folder(
    state: tauri::State<'_, OfficeFilesState>,
    segments: Vec<String>,
) -> Result<(), String> {
    let root = state.root().map_err(|error| error.code().to_owned())?;
    existing_folder(&root, &segments)
        .and_then(|folder| show_in_explorer(&folder))
        .map_err(|error| error.code().to_owned())
}

/// Opens a form's `.html` that `save_office_files` wrote under `Формы` in the
/// default browser, where the office prints it (plan О-Ф).
#[tauri::command]
pub async fn open_office_file(
    state: tauri::State<'_, OfficeFilesState>,
    segments: Vec<String>,
    name: String,
) -> Result<(), String> {
    let root = state.root().map_err(|error| error.code().to_owned())?;
    existing_form(&root, &segments, &name)
        .and_then(|file| open_in_default_program(&file))
        .map_err(|error| error.code().to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(name: &str, bytes: &[u8]) -> OfficeFile {
        OfficeFile {
            name: name.to_owned(),
            content_base64: STANDARD.encode(bytes),
        }
    }

    fn segments(names: &[&str]) -> Vec<String> {
        names.iter().map(|name| (*name).to_owned()).collect()
    }

    /// The CSV's BOM and CRLF, the TXT's LF and a Cyrillic name arrive byte
    /// for byte, in a new folder under the given segments.
    #[test]
    fn files_arrive_byte_for_byte_in_a_new_folder() {
        let root = tempfile::tempdir().unwrap();
        let csv = b"\xef\xbb\xbfcode\r\n0104600682000013215Ab\x1d93Zz\r\n";
        let txt = "Молоко\n".as_bytes();
        let saved = save_files(
            root.path(),
            &segments(&[
                "Выгрузки",
                "OCT26-004",
                "2026-10-08_18-30-00_shift_csv_flat",
            ]),
            &[
                file("Молоко_1pcs_2026-10-08.csv", csv),
                file("Молоко_1pcs_2026-10-08.txt", txt),
            ],
        )
        .unwrap();
        let folder = root
            .path()
            .join("Выгрузки")
            .join("OCT26-004")
            .join("2026-10-08_18-30-00_shift_csv_flat");
        assert_eq!(
            saved,
            SavedFolder {
                segments: segments(&[
                    "Выгрузки",
                    "OCT26-004",
                    "2026-10-08_18-30-00_shift_csv_flat"
                ]),
                path: folder.display().to_string(),
                files: vec![
                    "Молоко_1pcs_2026-10-08.csv".to_owned(),
                    "Молоко_1pcs_2026-10-08.txt".to_owned()
                ],
            }
        );
        assert_eq!(
            fs::read(folder.join("Молоко_1pcs_2026-10-08.csv")).unwrap(),
            csv
        );
        assert_eq!(
            fs::read(folder.join("Молоко_1pcs_2026-10-08.txt")).unwrap(),
            txt
        );
    }

    /// A folder that exists already is never written into: the next call
    /// gets « (2)», then « (3)», and the first folder keeps its file.
    #[test]
    fn an_existing_folder_is_never_written_into() {
        let root = tempfile::tempdir().unwrap();
        let path = segments(&["Выгрузки", "OCT26-004", "run"]);
        let first = save_files(root.path(), &path, &[file("a.xml", b"first")]).unwrap();
        let second = save_files(root.path(), &path, &[file("a.xml", b"second")]).unwrap();
        let third = save_files(root.path(), &path, &[file("a.xml", b"third")]).unwrap();
        assert_eq!(first.segments[2], "run");
        assert_eq!(second.segments[2], "run (2)");
        assert_eq!(third.segments[2], "run (3)");
        let read = |folder: &str| {
            fs::read(
                root.path()
                    .join("Выгрузки")
                    .join("OCT26-004")
                    .join(folder)
                    .join("a.xml"),
            )
            .unwrap()
        };
        assert_eq!(read("run"), b"first");
        assert_eq!(read("run (2)"), b"second");
    }

    /// What is refused writes nothing at all: a root outside the list, a
    /// segment or a name that is no plain Windows name, two names that differ
    /// only by case, no file, a payload that is no base64.
    #[test]
    fn a_refused_call_writes_nothing() {
        let root = tempfile::tempdir().unwrap();
        let ok = segments(&["Выгрузки", "OCT26-004", "run"]);
        let cases: Vec<(Vec<String>, Vec<OfficeFile>)> = vec![
            (segments(&["Документы", "run"]), vec![file("a.txt", b"x")]),
            (segments(&["Выгрузки"]), vec![file("a.txt", b"x")]),
            (
                segments(&["Выгрузки", "OCT26-004/S", "run"]),
                vec![file("a.txt", b"x")],
            ),
            (
                segments(&["Выгрузки", "..", "run"]),
                vec![file("a.txt", b"x")],
            ),
            (ok.clone(), vec![file("a.txt", b"x"), file("A.TXT", b"y")]),
            (ok.clone(), vec![file("con.txt", b"x")]),
            (ok.clone(), vec![file("a.txt ", b"x")]),
            (ok.clone(), vec![file("a\u{1d}.txt", b"x")]),
            (ok.clone(), vec![]),
            (
                ok.clone(),
                vec![OfficeFile {
                    name: "a.txt".to_owned(),
                    content_base64: "not base64!".to_owned(),
                }],
            ),
        ];
        for (path, files) in cases {
            assert_eq!(
                save_files(root.path(), &path, &files),
                Err(OfficeFilesError::InvalidRequest),
                "{path:?} {files:?}"
            );
        }
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
    }

    #[test]
    fn plain_names_are_what_windows_takes() {
        for name in [
            "OCT26-004",
            "Молоко_3_2_0_9_л_6pcs_2026-10-08.xml",
            "run (2)",
            "COM0",
            "CONSOLE.txt",
            "LPT10",
        ] {
            assert!(is_plain_name(name), "{name}");
        }
        for name in [
            "", ".", "..", "a.", "a ", "a/b", "a\\b", "a:b", "a*b", "a?b", "a\"b", "a<b", "a>b",
            "a|b", "CON", "nul.xml", "com1", "LPT9.txt", "a\tb",
        ] {
            assert!(!is_plain_name(name), "{name:?}");
        }
        assert!(is_plain_name(&"я".repeat(MAX_NAME_CHARS)));
        assert!(!is_plain_name(&"я".repeat(MAX_NAME_CHARS + 1)));
    }

    /// A write that fails takes back the folder the call made, with the
    /// files written into it before the failure.
    #[test]
    fn a_failed_write_takes_back_its_folder() {
        let root = tempfile::tempdir().unwrap();
        let folder = root.path().join("run");
        fs::create_dir(&folder).unwrap();
        // A directory where the second file must go: its create fails for
        // any user, root as well.
        fs::create_dir(folder.join("b.txt")).unwrap();
        assert_eq!(
            write_into(
                &folder,
                &[
                    ("a.txt".to_owned(), b"x".to_vec()),
                    ("b.txt".to_owned(), b"y".to_vec())
                ]
            ),
            Err(OfficeFilesError::Storage)
        );
        assert!(!folder.exists());
    }

    /// A folder to show must be one the office made; showing it needs Windows.
    #[test]
    fn only_an_existing_folder_of_the_office_is_shown() {
        let root = tempfile::tempdir().unwrap();
        let saved = save_files(
            root.path(),
            &segments(&["Выгрузки", "OCT26-004", "run"]),
            &[file("a.xml", b"x")],
        )
        .unwrap();
        assert!(existing_folder(root.path(), &saved.segments).is_ok());
        assert_eq!(
            existing_folder(root.path(), &segments(&["Выгрузки", "OCT26-004", "other"])),
            Err(OfficeFilesError::InvalidRequest)
        );
        assert_eq!(
            existing_folder(root.path(), &segments(&["Выгрузки", "..", "run"])),
            Err(OfficeFilesError::InvalidRequest)
        );
        // Shapes whose walk would succeed without the name check, each on a
        // folder that exists: only the guard refuses them.
        for shape in [
            &["Выгрузки", ".."][..],
            &["Выгрузки", "..", ".."],
            &["Выгрузки", "."],
            &["Выгрузки", "OCT26-004", "run", ".."],
            &["Выгрузки", "OCT26-004/.."],
            &["Выгрузки", "/"],
            &["Выгрузки", "OCT26-004", "run", "..", ".."],
            &["Выгрузки"],
            &["Формы", "OCT26-004"],
            &["Markiro", "Выгрузки"],
        ] {
            assert!(root.path().join("Выгрузки").join("..").is_dir());
            assert_eq!(
                existing_folder(root.path(), &segments(shape)),
                Err(OfficeFilesError::InvalidRequest),
                "{shape:?}"
            );
        }
        if !cfg!(windows) {
            assert_eq!(
                show_in_explorer(root.path()),
                Err(OfficeFilesError::Unsupported)
            );
        }
    }

    /// Names that Windows reads differently from how they look are refused:
    /// the superscript device names, `CONIN$`/`CONOUT$`, a device name
    /// followed by a space before the extension, and characters that reorder
    /// or hide text (a right-to-left override turns `a<RLO>txt.exe` into
    /// `aexe.txt` on screen).
    #[test]
    fn names_that_windows_or_the_eye_misread_are_refused() {
        for name in [
            "COM\u{b9}",
            "lpt\u{b2}.txt",
            "COM\u{b3}",
            "CONIN$",
            "conout$.log",
            "CON .txt",
            "nul  .xml",
            "a\u{202e}txt.exe",
            "a\u{200b}b",
            "a\u{feff}b",
            "a\u{2066}b",
            "a\u{7f}b",
            "a\u{85}b",
            "a\u{2028}b",
        ] {
            assert!(!is_plain_name(name), "{name:?}");
        }
        for name in ["CONSOLE", "COM12", "Молоко (2)", "a b.txt", " lead"] {
            assert!(is_plain_name(name), "{name:?}");
        }
    }

    /// Base64 is taken as the shell sends it, canonical and padded: not
    /// without its padding, not with a newline or a URL-safe alphabet; an
    /// empty content is an empty file.
    #[test]
    fn base64_is_taken_strictly() {
        let root = tempfile::tempdir().unwrap();
        let path = segments(&["Выгрузки", "OCT26-004", "run"]);
        for bad in ["YQ", "YQ==\n", " YQ==", "YQ=", "-_-_", "YR=="] {
            let files = [OfficeFile {
                name: "a.txt".to_owned(),
                content_base64: bad.to_owned(),
            }];
            assert_eq!(
                save_files(root.path(), &path, &files),
                Err(OfficeFilesError::InvalidRequest),
                "{bad:?}"
            );
        }
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
        let saved = save_files(root.path(), &path, &[file("empty.txt", b"")]).unwrap();
        assert_eq!(saved.files, vec!["empty.txt".to_owned()]);
        assert_eq!(
            fs::read(root.path().join("Выгрузки/OCT26-004/run/empty.txt")).unwrap(),
            b""
        );
    }

    /// The folder suffix runs « (2)» to « (99)»: with 98 taken the call still
    /// finds one, with all 99 taken it says `storage` and writes nothing.
    #[test]
    fn the_suffix_stops_at_ninety_nine() {
        let root = tempfile::tempdir().unwrap();
        let parent = root.path().join("Выгрузки").join("OCT26-004");
        fs::create_dir_all(&parent).unwrap();
        fs::create_dir(parent.join("run")).unwrap();
        for n in 2..=98 {
            fs::create_dir(parent.join(format!("run ({n})"))).unwrap();
        }
        let path = segments(&["Выгрузки", "OCT26-004", "run"]);
        let saved = save_files(root.path(), &path, &[file("a.xml", b"x")]).unwrap();
        assert_eq!(saved.segments[2], "run (99)");
        assert_eq!(
            save_files(root.path(), &path, &[file("a.xml", b"y")]),
            Err(OfficeFilesError::Storage)
        );
        assert_eq!(fs::read_dir(&parent).unwrap().count(), 99);
        assert_eq!(fs::read(parent.join("run (99)/a.xml")).unwrap(), b"x");
    }

    /// Calls that race for one folder name get folders of their own, none
    /// written over another.
    #[test]
    fn calls_racing_for_one_name_get_their_own_folders() {
        let root = tempfile::tempdir().unwrap();
        let path = segments(&["Выгрузки", "OCT26-004", "run"]);
        let saved: Vec<SavedFolder> = std::thread::scope(|scope| {
            let handles: Vec<_> = (0..8u8)
                .map(|n| {
                    let (root, path) = (root.path(), &path);
                    scope.spawn(move || save_files(root, path, &[file("a.xml", &[n; 64])]).unwrap())
                })
                .collect();
            handles.into_iter().map(|h| h.join().unwrap()).collect()
        });
        let mut names: Vec<_> = saved.iter().map(|s| s.segments[2].clone()).collect();
        names.sort();
        names.dedup();
        assert_eq!(names.len(), 8);
        for folder in &saved {
            let bytes = fs::read(Path::new(&folder.path).join("a.xml")).unwrap();
            assert_eq!(bytes.len(), 64);
            assert!(bytes.iter().all(|byte| *byte == bytes[0]));
        }
    }

    /// A call that fails after it made its folder takes back that folder
    /// only: an older folder of the same name keeps its files, and the
    /// parents stay. The writer here makes the second file clash with the
    /// first, which `create_new` refuses.
    #[test]
    fn a_failed_call_leaves_the_older_folder_alone() {
        let root = tempfile::tempdir().unwrap();
        let path = segments(&["Выгрузки", "OCT26-004", "run"]);
        save_files(root.path(), &path, &[file("a.xml", b"older")]).unwrap();
        let clashing = |folder: &Path, _: &[(String, Vec<u8>)]| {
            write_into(
                folder,
                &[
                    ("x.xml".to_owned(), b"1".to_vec()),
                    ("x.xml".to_owned(), b"2".to_vec()),
                ],
            )
        };
        assert_eq!(
            save_with(root.path(), &path, &[file("a.xml", b"x")], clashing),
            Err(OfficeFilesError::Storage)
        );
        let parent = root.path().join("Выгрузки").join("OCT26-004");
        assert_eq!(fs::read_dir(&parent).unwrap().count(), 1);
        assert_eq!(fs::read(parent.join("run/a.xml")).unwrap(), b"older");
    }

    /// A link where a folder of the office should be is never followed: the
    /// files would land outside `Документы\Markiro`. Nothing is written
    /// through it and nothing is shown through it.
    #[cfg(unix)]
    #[test]
    fn a_link_in_the_way_is_not_followed() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), root.path().join("Выгрузки")).unwrap();
        let path = segments(&["Выгрузки", "OCT26-004", "run"]);
        assert_eq!(
            save_files(root.path(), &path, &[file("a.xml", b"x")]),
            Err(OfficeFilesError::Storage)
        );
        assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
        // The folder behind the link exists, so only the link itself refuses.
        fs::create_dir(outside.path().join("OCT26-004")).unwrap();
        assert!(root.path().join("Выгрузки/OCT26-004").is_dir());
        assert_eq!(
            existing_folder(root.path(), &segments(&["Выгрузки", "OCT26-004"])),
            Err(OfficeFilesError::InvalidRequest)
        );
        fs::remove_dir(outside.path().join("OCT26-004")).unwrap();
        // A link in a deeper place, and a plain file where a folder goes.
        fs::remove_file(root.path().join("Выгрузки")).unwrap();
        fs::create_dir(root.path().join("Выгрузки")).unwrap();
        std::os::unix::fs::symlink(outside.path(), root.path().join("Выгрузки/OCT26-004")).unwrap();
        assert_eq!(
            save_files(root.path(), &path, &[file("a.xml", b"x")]),
            Err(OfficeFilesError::Storage)
        );
        assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
        fs::remove_file(root.path().join("Выгрузки/OCT26-004")).unwrap();
        fs::write(root.path().join("Выгрузки/OCT26-004"), b"a file").unwrap();
        assert_eq!(
            save_files(root.path(), &path, &[file("a.xml", b"x")]),
            Err(OfficeFilesError::Storage)
        );
    }

    #[test]
    fn every_refusal_has_its_own_code() {
        assert_eq!(OfficeFilesError::InvalidRequest.code(), "invalid_request");
        assert_eq!(
            OfficeFilesError::DocumentsUnavailable.code(),
            "documents_unavailable"
        );
        assert_eq!(OfficeFilesError::Storage.code(), "storage");
        assert_eq!(OfficeFilesError::Unsupported.code(), "unsupported");
    }

    /// A path is at most `MAX_SEGMENTS` folders deep.
    #[test]
    fn the_depth_of_the_segments_is_bounded() {
        let root = tempfile::tempdir().unwrap();
        let mut deep = vec!["Выгрузки".to_owned()];
        deep.extend((1..MAX_SEGMENTS).map(|n| format!("s{n}")));
        assert_eq!(deep.len(), MAX_SEGMENTS);
        assert!(save_files(root.path(), &deep, &[file("a.xml", b"x")]).is_ok());
        deep.push("one-more".to_owned());
        assert_eq!(
            save_files(root.path(), &deep, &[file("a.xml", b"x")]),
            Err(OfficeFilesError::InvalidRequest)
        );
    }

    /// The caps on the number of files and on their bytes in all hold at the
    /// bound and one past it, whatever the padding of the last group.
    #[test]
    fn the_caps_on_files_and_bytes_hold_at_the_bound() {
        let two = [file("a.txt", &[1; 3]), file("b.txt", &[2; 3])];
        assert!(decode_with(&two, 2, 6).is_ok());
        assert_eq!(
            decode_with(&two, 1, 6),
            Err(OfficeFilesError::InvalidRequest)
        );
        assert_eq!(
            decode_with(&two, 2, 5),
            Err(OfficeFilesError::InvalidRequest)
        );
        for size in 1..=7usize {
            let one = [file("a.txt", &vec![1; size])];
            assert!(decode_with(&one, 1, size).is_ok(), "{size}");
            assert_eq!(
                decode_with(&one, 1, size - 1),
                Err(OfficeFilesError::InvalidRequest),
                "{size}"
            );
        }
        assert_eq!(
            decode_with(&[], 2, 6),
            Err(OfficeFilesError::InvalidRequest)
        );
        // The longest content a cap lets in, in base64.
        for (bytes, encoded) in [(0, 0), (1, 4), (2, 4), (3, 4), (4, 8), (6, 8), (7, 12)] {
            assert_eq!(encoded_cap(bytes), encoded, "{bytes}");
        }
    }

    /// Explorer is started from the system folder with the folder in double
    /// quotes, always, so that a comma, a space or a Cyrillic letter in the
    /// path is no part of Explorer's own command line; it starts in the
    /// system folder; a path with a double quote is no launch.
    #[test]
    fn explorer_is_started_from_the_system_folder_with_a_quoted_path() {
        let folder = Path::new(r"C:\Users\Иван Петров\Документы\Markiro\Выгрузки\x,y (2)");
        let launch = explorer_launch(folder, Some(OsStr::new(r"D:\Win"))).unwrap();
        assert_eq!(
            launch,
            ExplorerLaunch {
                program: PathBuf::from(r"D:\Win").join("explorer.exe"),
                argument: OsString::from(
                    "\"C:\\Users\\Иван Петров\\Документы\\Markiro\\Выгрузки\\x,y (2)\""
                ),
                current_dir: PathBuf::from(r"D:\Win"),
            }
        );
        // No space in the path: quoted all the same.
        let plain = explorer_launch(Path::new(r"C:\a,b"), Some(OsStr::new("SYS"))).unwrap();
        assert_eq!(plain.argument, OsString::from("\"C:\\a,b\""));
        assert_eq!(plain.program.file_name().unwrap(), "explorer.exe");
        assert_eq!(plain.program.parent().unwrap(), Path::new("SYS"));
        assert_eq!(plain.current_dir, PathBuf::from("SYS"));
        let fallback = explorer_launch(Path::new("x"), None).unwrap();
        assert_eq!(
            fallback.program,
            PathBuf::from(r"C:\Windows").join("explorer.exe")
        );
        assert_eq!(fallback.current_dir, PathBuf::from(r"C:\Windows"));
        for quoted in [r#"C:\a"b"#, r#"C:\a" /root,C:\"#, "\"", "x\""] {
            assert_eq!(explorer_launch(Path::new(quoted), None), None, "{quoted}");
        }
    }

    /// Both roots the office writes into are open, and the folder is the
    /// documents folder's `Markiro`.
    #[test]
    fn both_roots_are_open_and_the_folder_is_markiro_under_documents() {
        // Plan ЛЦ-3 adds the license's root for the activation request.
        assert_eq!(ROOTS, ["Выгрузки", "Формы", "Лицензия"]);
        let root = tempfile::tempdir().unwrap();
        for first in ROOTS {
            let path = segments(&[first, "OCT26-004", "run"]);
            assert!(save_files(root.path(), &path, &[file("a.xml", b"x")]).is_ok());
        }
        let state = OfficeFilesState::from_documents(Some(PathBuf::from("docs")));
        assert_eq!(state.root(), Ok(Path::new("docs").join("Markiro")));
        assert_eq!(
            OfficeFilesState::from_documents(None).root(),
            Err(OfficeFilesError::DocumentsUnavailable)
        );
        assert_eq!(
            OfficeFilesState::at(PathBuf::from("x")).root(),
            Ok(PathBuf::from("x"))
        );
        assert_eq!(
            OfficeFilesState::unavailable().root(),
            Err(OfficeFilesError::DocumentsUnavailable)
        );
    }

    /// The activation request goes under `Лицензия` as JSON (plan ЛЦ-3), and
    /// nothing is opened from there: a form is opened from `Формы` only.
    #[test]
    fn the_license_root_takes_the_activation_request_and_opens_nothing() {
        let root = tempfile::tempdir().unwrap();
        let path = segments(&["Лицензия", "Запрос на активацию 2026-10-20_09-00-00"]);
        let saved = save_files(
            root.path(),
            &path,
            &[file("markiro-activation-request.json", b"{}\n")],
        )
        .unwrap();
        assert_eq!(saved.segments, path);
        assert_eq!(saved.files, ["markiro-activation-request.json"]);
        assert_eq!(
            fs::read(
                root.path()
                    .join("Лицензия")
                    .join("Запрос на активацию 2026-10-20_09-00-00")
                    .join("markiro-activation-request.json")
            )
            .unwrap(),
            b"{}\n"
        );
        assert!(existing_folder(root.path(), &saved.segments).is_ok());
        assert_eq!(
            existing_form(
                root.path(),
                &saved.segments,
                "markiro-activation-request.json"
            ),
            Err(OfficeFilesError::InvalidRequest)
        );
        assert_eq!(LICENSE_ROOT, "Лицензия");
    }

    /// The IPC shape is closed: a file with a field of another name is not a
    /// file, and the content is `contentBase64`.
    #[test]
    fn a_file_of_another_shape_is_not_taken() {
        let ok: OfficeFile =
            serde_json::from_str(r#"{"name":"a.txt","contentBase64":"YQ=="}"#).unwrap();
        assert_eq!(ok, file("a.txt", b"a"));
        for bad in [
            r#"{"name":"a.txt","contentBase64":"YQ==","path":"C:\\x"}"#,
            r#"{"name":"a.txt","content_base64":"YQ=="}"#,
            r#"{"name":"a.txt"}"#,
        ] {
            assert!(serde_json::from_str::<OfficeFile>(bad).is_err(), "{bad}");
        }
    }

    /// A name holds letters and digits of any script, spaces and `-_.()`
    /// and nothing else: not a character Explorer's command line, a shell or
    /// the eye misreads, whichever script, width or plane it comes from.
    #[test]
    fn a_name_holds_only_letters_digits_and_a_few_marks() {
        for name in [
            "Молоко",
            "Ёё",
            "漢字",
            "Ünï",
            "٣٤",
            "𠀀",
            "run.v1",
            "a (2)",
            "a-b_c",
        ] {
            assert!(is_plain_name(name), "{name:?}");
        }
        for c in [
            ',',
            ';',
            '&',
            '%',
            '~',
            '$',
            '!',
            '#',
            '\'',
            '@',
            '+',
            '=',
            '[',
            ']',
            '{',
            '}',
            '^',
            '`',
            '\u{a0}',
            '\u{3000}',
            '\u{200a}',
            '\u{180e}',
            '\u{34f}',
            '\u{e0041}',
            '\u{200b}',
            '\u{200f}',
            '\u{202e}',
            '\u{2028}',
            '\u{2066}',
            '\u{feff}',
            '\u{61c}',
            '\u{7f}',
            '\u{85}',
            '\u{1f600}',
            '\n',
            '\0',
        ] {
            assert!(!is_plain_name(&format!("a{c}b")), "{:x}", u32::from(c));
        }
        // A token that would split or expand in Explorer's command line.
        for name in ["x,C:\\Windows\\notepad.exe", "%ComSpec%", "a;b", "a&calc"] {
            assert!(!is_plain_name(name), "{name:?}");
        }
    }

    /// A file's name ends in an extension the office writes, in any case; a
    /// double extension counts by its last part, and a stem is needed.
    #[test]
    fn a_file_name_ends_in_an_extension_the_office_writes() {
        assert_eq!(FILE_EXTENSIONS, ["csv", "txt", "xml", "html", "json"]);
        for name in [
            "a.csv",
            "a.txt",
            "a.xml",
            "a.html",
            "a.json",
            "A.TXT",
            "A.JSON",
            "a.Xml",
            "Молоко (2).csv",
            "markiro-activation-request.json",
        ] {
            assert!(is_plain_file_name(name), "{name}");
        }
        for name in [
            "a",
            "a.bat",
            "a.exe",
            "a.lnk",
            "a.url",
            "a.hta",
            "a.js",
            "a.csv.bat",
            "Молоко.csv.exe",
            "a.json.exe",
            "a.jsonl",
            "a.txt.lnk",
            "a. txt",
            "a.htm",
            ".txt",
            "csv",
            "a.csv.",
            "con.txt",
            "a,b.txt",
        ] {
            assert!(!is_plain_file_name(name), "{name:?}");
        }
        // A folder segment is no file: it may have any dots it likes.
        assert!(is_plain_name("run.v1") && !is_plain_file_name("run.v1"));
        let root = tempfile::tempdir().unwrap();
        let path = segments(&["Выгрузки", "OCT26-004", "run"]);
        for bad in ["Молоко.csv.bat", "run", "x.exe", "a,b.csv"] {
            assert_eq!(
                save_files(root.path(), &path, &[file("ok.txt", b"1"), file(bad, b"x")]),
                Err(OfficeFilesError::InvalidRequest),
                "{bad}"
            );
        }
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
    }

    /// Every name the domain's exporters make is a name the shell takes:
    /// the file names of every format of the parity fixture (the cloud's own
    /// golden: every shift format, the pallet exports, parts and the pallets'
    /// SSCCs) and the folders the export dialog makes for
    /// each format (`exportFolder`: root, shift number, stamp and format).
    #[test]
    fn the_names_the_domain_makes_are_taken() {
        let golden: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../packages/domain/test/fixtures/shift-export-parity/golden.json"
        ))
        .unwrap();
        let mut names = std::collections::BTreeSet::new();
        let mut formats = std::collections::BTreeSet::new();
        for (key, outcome) in golden.as_object().unwrap() {
            // `case/format@version/run`
            let format = key.split('/').nth(1).unwrap().split('@').next().unwrap();
            formats.insert(format.to_owned());
            for part in outcome["parts"].as_array().into_iter().flatten() {
                names.insert(part["filename"].as_str().unwrap().to_owned());
            }
        }
        assert!(names.len() >= 80, "{}", names.len());
        assert!(formats.len() >= 11, "{formats:?}");
        for name in &names {
            assert!(is_plain_file_name(name), "{name}");
        }
        let root = tempfile::tempdir().unwrap();
        let all: Vec<OfficeFile> = names.iter().map(|name| file(name, b"x")).collect();
        for format in &formats {
            for number in ["OCT26-004", "OCT26-005_S", "Смена_7"] {
                let path =
                    segments(&["Выгрузки", number, &format!("2026-10-08_18-30-00_{format}")]);
                let saved = save_files(root.path(), &path, &all[..3]).unwrap();
                assert_eq!(saved.segments[..2], path[..2]);
                assert!(
                    existing_folder(root.path(), &saved.segments).is_ok(),
                    "{path:?}"
                );
            }
        }
    }

    /// The last segment leaves room for « (99)»: 145 characters are taken,
    /// 146 are not, and the folder made at the end of the suffix range has a
    /// name `open_office_folder` takes. The bound counts characters, not
    /// bytes: the longest name is half Cyrillic (two bytes each in UTF-8), yet
    /// it stays within the 255 bytes Linux allows a name, « (99)» and all, so
    /// the folders are real on every system the tests run on.
    #[test]
    fn the_last_segment_leaves_room_for_the_suffix() {
        let root = tempfile::tempdir().unwrap();
        let longest = format!("{}{}", "я".repeat(100), "a".repeat(45));
        assert_eq!(longest.chars().count(), MAX_NAME_CHARS - SUFFIX_CHARS);
        assert!(longest.len() > MAX_NAME_CHARS);
        assert!(longest.len() + " (99)".len() <= 255);
        let path = |last: &str| segments(&["Выгрузки", "OCT26-004", last]);
        assert_eq!(SUFFIX_CHARS, " (99)".chars().count());
        assert_eq!(
            save_files(
                root.path(),
                &path(&format!("{longest}я")),
                &[file("a.xml", b"x")]
            ),
            Err(OfficeFilesError::InvalidRequest)
        );
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
        let parent = root.path().join("Выгрузки").join("OCT26-004");
        fs::create_dir_all(&parent).unwrap();
        fs::create_dir(parent.join(&longest)).unwrap();
        for n in 2..=98 {
            fs::create_dir(parent.join(format!("{longest} ({n})"))).unwrap();
        }
        let saved = save_files(root.path(), &path(&longest), &[file("a.xml", b"x")]).unwrap();
        assert_eq!(saved.segments[2], format!("{longest} (99)"));
        assert_eq!(saved.segments[2].chars().count(), MAX_NAME_CHARS);
        assert!(existing_folder(root.path(), &saved.segments).is_ok());
    }

    /// The path of the longest file counts in UTF-16 units, root, separators,
    /// the longest suffix and all: the bound is exact, a character outside
    /// the basic plane is two units.
    #[test]
    fn a_path_is_counted_in_utf16_units_with_the_suffix() {
        let files = [
            ("c.txt".to_owned(), Vec::new()),
            ("b.t".to_owned(), Vec::new()),
        ];
        // "R" 1, "/Выгрузки" 9, "/𠀀" 3, " (99)" 5, "/c.txt" 6.
        let segs = segments(&["Выгрузки", "\u{20000}"]);
        assert!(path_fits(Path::new("R"), &segs, &files, 24));
        assert!(!path_fits(Path::new("R"), &segs, &files, 23));
        // The longest of several files counts, not the first or the last.
        let longer = [
            ("a.t".to_owned(), Vec::new()),
            ("longest.txt".to_owned(), Vec::new()),
            ("b.t".to_owned(), Vec::new()),
        ];
        assert!(path_fits(Path::new("R"), &segs, &longer, 30));
        assert!(!path_fits(Path::new("R"), &segs, &longer, 29));
        // A longer root costs its units.
        assert!(!path_fits(Path::new("RRR"), &segs, &files, 24));
        // The bound itself, with the real limit (Windows' 260 less room for
        // a prefix and a terminator): a path of exactly `MAX_PATH_UNITS`
        // units is written, one unit more is not.
        assert_eq!(MAX_PATH_UNITS, 240);
        let root = tempfile::tempdir().unwrap();
        let used = root.path().to_string_lossy().encode_utf16().count();
        // root + "/Выгрузки" (9) + "/" and 100 + "/" and `rest` + " (99)" (5)
        // + "/a.xml" (6)
        let rest = MAX_PATH_UNITS - used - 9 - 101 - 1 - SUFFIX_CHARS - 6;
        assert!(
            (1..=MAX_NAME_CHARS - SUFFIX_CHARS).contains(&rest),
            "{used}"
        );
        let at_bound = segments(&["Выгрузки", &"a".repeat(100), &"b".repeat(rest)]);
        assert!(save_files(root.path(), &at_bound, &[file("a.xml", b"x")]).is_ok());
        let past = segments(&["Выгрузки", &"a".repeat(100), &"b".repeat(rest + 1)]);
        assert_eq!(
            save_files(root.path(), &past, &[file("a.xml", b"x")]),
            Err(OfficeFilesError::InvalidRequest)
        );
        // A call whose path is far over the bound writes nothing.
        let root = tempfile::tempdir().unwrap();
        let deep = segments(&["Выгрузки", &"a".repeat(140), &"b".repeat(140)]);
        assert_eq!(
            save_files(root.path(), &deep, &[file("a.xml", b"x")]),
            Err(OfficeFilesError::InvalidRequest)
        );
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
    }

    /// A folder that cannot be taken back is logged by the kind of the
    /// failure and reported; one that goes is neither.
    #[test]
    fn a_folder_that_cannot_be_taken_back_is_reported() {
        let root = tempfile::tempdir().unwrap();
        let folder = root.path().join("run");
        fs::create_dir(&folder).unwrap();
        fn busy(_: &Path) -> std::io::Result<()> {
            Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied))
        }
        assert_eq!(
            take_back(&folder, busy),
            Some(std::io::ErrorKind::PermissionDenied)
        );
        assert!(folder.exists());
        assert_eq!(
            take_back(&folder, |path: &Path| fs::remove_dir_all(path)),
            None
        );
        assert!(!folder.exists());
    }

    const FORM_NAME: &str = "Состав короба 046006820000015000.html";

    /// A folder `Формы/OCT26-004/run` holding the form `FORM_NAME`.
    fn forms_root_with_a_form() -> (tempfile::TempDir, Vec<String>) {
        let root = tempfile::tempdir().unwrap();
        let saved = save_files(
            root.path(),
            &segments(&["Формы", "OCT26-004", "run"]),
            &[file(FORM_NAME, b"<!doctype html>")],
        )
        .unwrap();
        (root, saved.segments)
    }

    /// Only a form's `.html` the office wrote is opened: the same file by its
    /// name and by its path, whatever the case of its extension.
    #[test]
    fn a_form_of_the_office_is_found() {
        let (root, folder) = forms_root_with_a_form();
        let form = existing_form(root.path(), &folder, FORM_NAME).unwrap();
        assert_eq!(
            form,
            root.path()
                .join("Формы")
                .join("OCT26-004")
                .join("run")
                .join(FORM_NAME)
        );
        assert_eq!(fs::read(&form).unwrap(), b"<!doctype html>");
        fs::write(form.with_file_name("Бланк смены.HTML"), b"<p>").unwrap();
        assert!(existing_form(root.path(), &folder, "Бланк смены.HTML").is_ok());
        // The folder the second call of a name got.
        let again = save_files(
            root.path(),
            &segments(&["Формы", "OCT26-004", "run"]),
            &[file(FORM_NAME, b"<p>")],
        )
        .unwrap();
        assert_eq!(again.segments[2], "run (2)");
        assert!(existing_form(root.path(), &again.segments, FORM_NAME).is_ok());
    }

    /// A name that is no `.html` of a plain name is refused though a file of
    /// that name is there: another kind of file is never started, and no
    /// name leaves the folder or reads as something else.
    #[test]
    fn only_a_html_of_a_plain_name_is_opened() {
        let (root, folder) = forms_root_with_a_form();
        let dir = root.path().join("Формы").join("OCT26-004").join("run");
        for name in [
            "run.exe",
            "run.bat",
            "a.lnk",
            "a.url",
            "a.hta",
            "page.htm",
            "page.html.bat",
            "page.html.exe",
            "page.txt",
            "page",
            ".html",
            "a,b.html",
            "a;b.html",
            "a%b.html",
            "a&b.html",
            "a~1.html",
            "page.html.",
            "page.html ",
            "con.html",
            "CON.HTML",
            "nul.html",
            "com1.html",
            "page\u{200b}.html",
            "page\u{202e}.html",
        ] {
            // Best effort: some names cannot exist on every file system, and
            // on Windows a device name with any extension may open the device
            // (`com1` the serial port) instead of a file.
            let stem = name.split('.').next().unwrap_or_default();
            let device = ["con", "nul", "com1"].contains(&stem.to_ascii_lowercase().as_str());
            if !(cfg!(windows) && device) {
                let _ = fs::write(dir.join(name), b"x");
            }
            assert_eq!(
                existing_form(root.path(), &folder, name),
                Err(OfficeFilesError::InvalidRequest),
                "{name:?}"
            );
        }
        for name in [
            "",
            "..",
            ".",
            "a/b.html",
            "a\\b.html",
            "../run/page.html",
            FORM_NAME.trim_end_matches(".html"),
        ] {
            assert_eq!(
                existing_form(root.path(), &folder, name),
                Err(OfficeFilesError::InvalidRequest),
                "{name:?}"
            );
        }
        assert_eq!(
            existing_form(
                root.path(),
                &folder,
                &format!("{}.html", "я".repeat(MAX_NAME_CHARS - 4))
            ),
            Err(OfficeFilesError::InvalidRequest),
            "a name over the longest"
        );
    }

    /// A form must be there, and be a file: a missing one, a folder of a
    /// form's name and a link (even to a form) are not opened.
    #[test]
    fn a_form_that_is_not_there_or_not_a_file_is_not_opened() {
        let (root, folder) = forms_root_with_a_form();
        let dir = root.path().join("Формы").join("OCT26-004").join("run");
        assert_eq!(
            existing_form(root.path(), &folder, "Другая форма.html"),
            Err(OfficeFilesError::InvalidRequest)
        );
        fs::create_dir(dir.join("Папка.html")).unwrap();
        assert_eq!(
            existing_form(root.path(), &folder, "Папка.html"),
            Err(OfficeFilesError::InvalidRequest)
        );
        #[cfg(unix)]
        {
            let outside = tempfile::tempdir().unwrap();
            fs::write(outside.path().join("x.html"), b"<p>outside</p>").unwrap();
            std::os::unix::fs::symlink(outside.path().join("x.html"), dir.join("Внешняя.html"))
                .unwrap();
            assert_eq!(
                existing_form(root.path(), &folder, "Внешняя.html"),
                Err(OfficeFilesError::InvalidRequest)
            );
            // A link to a form of the folder itself is a link all the same.
            std::os::unix::fs::symlink(dir.join(FORM_NAME), dir.join("Ссылка.html")).unwrap();
            assert_eq!(
                existing_form(root.path(), &folder, "Ссылка.html"),
                Err(OfficeFilesError::InvalidRequest)
            );
            // A link where a folder of the way should be.
            std::os::unix::fs::symlink(outside.path(), root.path().join("Формы/Ссылка")).unwrap();
            fs::create_dir(outside.path().join("run")).unwrap();
            fs::write(outside.path().join("run").join(FORM_NAME), b"<p>").unwrap();
            assert_eq!(
                existing_form(
                    root.path(),
                    &segments(&["Формы", "Ссылка", "run"]),
                    FORM_NAME
                ),
                Err(OfficeFilesError::InvalidRequest)
            );
        }
    }

    /// Only the forms' root is opened from: an `.html` an export's folder
    /// holds, a way out of the office's folder and a way too short are refused
    /// though the file they lead to exists.
    #[test]
    fn a_form_is_opened_only_from_the_forms_root_by_a_plain_way() {
        let (root, folder) = forms_root_with_a_form();
        assert_eq!(FORMS_ROOT, "Формы");
        assert!(ROOTS.contains(&FORMS_ROOT));
        let exported = save_files(
            root.path(),
            &segments(&["Выгрузки", "OCT26-004", "run"]),
            &[file(FORM_NAME, b"<p>")],
        )
        .unwrap();
        assert!(existing_folder(root.path(), &exported.segments).is_ok());
        assert_eq!(
            existing_form(root.path(), &exported.segments, FORM_NAME),
            Err(OfficeFilesError::InvalidRequest)
        );
        for way in [
            segments(&["Формы", "OCT26-004", "..", "OCT26-004", "run"]),
            segments(&["Формы", "..", "Формы", "OCT26-004", "run"]),
            segments(&["Формы", "OCT26-004", "run", ".."]),
            segments(&["Формы", "OCT26-004/run"]),
            segments(&["Формы", "OCT26-004\\run"]),
            segments(&["Формы"]),
            segments(&["Формы", "OCT26-004", "run", ""]),
            segments(&["Markiro", "Формы", "OCT26-004", "run"]),
            vec![],
        ] {
            assert_eq!(
                existing_form(root.path(), &way, FORM_NAME),
                Err(OfficeFilesError::InvalidRequest),
                "{way:?}"
            );
        }
        // The folder the file is in, by itself: found.
        assert!(existing_form(root.path(), &folder, FORM_NAME).is_ok());
    }

    /// Opening a form needs Windows: anywhere else the launcher is
    /// `unsupported`, and it is the same launcher that shows a folder.
    #[test]
    fn opening_a_file_and_showing_a_folder_share_one_launcher() {
        let (root, folder) = forms_root_with_a_form();
        let form = existing_form(root.path(), &folder, FORM_NAME).unwrap();
        if !cfg!(windows) {
            assert_eq!(
                open_in_default_program(&form),
                Err(OfficeFilesError::Unsupported)
            );
            assert_eq!(
                show_in_explorer(form.parent().unwrap()),
                Err(OfficeFilesError::Unsupported)
            );
        }
    }

    /// What Explorer is given to open a form is the form's path in double
    /// quotes, the path `existing_form` found: a Cyrillic name with spaces and
    /// brackets arrives as one argument.
    #[test]
    fn explorer_opens_a_form_by_its_quoted_path() {
        let form = Path::new(
            r"C:\Users\Иван Петров\Документы\Markiro\Формы\OCT26-004\2026-10-08_18-30-00_placard (2)\Ярлык паллеты 146006820000000409 A5.html",
        );
        let launch = explorer_launch(form, Some(OsStr::new(r"C:\Windows"))).unwrap();
        assert_eq!(
            launch.argument,
            OsString::from(
                "\"C:\\Users\\Иван Петров\\Документы\\Markiro\\Формы\\OCT26-004\\2026-10-08_18-30-00_placard (2)\\Ярлык паллеты 146006820000000409 A5.html\""
            )
        );
        assert_eq!(
            launch.program,
            PathBuf::from(r"C:\Windows").join("explorer.exe")
        );
        assert_eq!(launch.current_dir, PathBuf::from(r"C:\Windows"));
        // Found on this machine, the path goes into the argument as it is.
        let (root, folder) = forms_root_with_a_form();
        let found = existing_form(root.path(), &folder, FORM_NAME).unwrap();
        let launch = explorer_launch(&found, None).unwrap();
        let mut quoted = OsString::from("\"");
        quoted.push(found.as_os_str());
        quoted.push("\"");
        assert_eq!(launch.argument, quoted);
    }

    /// Every name the forms of the office make (the file names of
    /// `render-form.ts` for the host's SSCC text, or none) is a name the
    /// shell takes, saved and found again; the webview's sanitiser keeps
    /// to the same allowlist.
    #[test]
    fn the_names_of_the_forms_are_taken() {
        let root = tempfile::tempdir().unwrap();
        let names = [
            "Состав короба 046006820000015000.html",
            "Состав короба без SSCC.html",
            "Состав паллеты 146006820000000409.html",
            "Состав паллеты без SSCC.html",
            "Ярлык паллеты 146006820000000409 A4.html",
            "Ярлык паллеты 146006820000000409 A5.html",
            "Ярлык паллеты  A5.html",
            "Ярлыки паллет смены A4.html",
            "Ярлыки паллет смены A5.html",
            "Бланк смены.html",
        ];
        for (n, name) in names.iter().enumerate() {
            let folder = segments(&[
                "Формы",
                "OCT26-005_S",
                &format!("2026-10-08_18-30-0{n}_task"),
            ]);
            let saved = save_files(root.path(), &folder, &[file(name, b"<p>")]).unwrap();
            assert!(
                existing_form(root.path(), &saved.segments, name).is_ok(),
                "{name:?}"
            );
        }
    }

    /// What the office writes is readable by its owner alone (Unix; Windows
    /// has its own access lists): the form of a tenant is not world-readable.
    #[cfg(unix)]
    #[test]
    fn a_file_is_written_for_its_owner_alone() {
        use std::os::unix::fs::PermissionsExt;

        let root = tempfile::tempdir().unwrap();
        let saved = save_files(
            root.path(),
            &segments(&["Формы", "OCT26-004", "run"]),
            &[file(FORM_NAME, b"<p>")],
        )
        .unwrap();
        let written = Path::new(&saved.path).join(FORM_NAME);
        let mode = fs::metadata(&written).unwrap().permissions().mode();
        assert_eq!(mode & 0o077, 0, "{mode:o}");
        assert_eq!(mode & 0o600, 0o600, "{mode:o}");
    }
}
