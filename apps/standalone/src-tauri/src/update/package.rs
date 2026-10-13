//! Update packages on this computer (plan ОБН-2, spec §10.1, §10.4, §10.5):
//! a signed manifest `*.update.jws` and the installer it names, side by side.
//! [`scan`] looks in `Документы\Markiro\Обновления` and in the root and the
//! `Markiro\` folder of every removable drive, no deeper, and checks each
//! manifest's signature at once (milliseconds), so a version is shown only
//! for a signed one. [`verify`] reads the manifest again, and the installer
//! through [`open_installer`]'s handle, which the caller holds until Windows
//! has started that very file. A failure is logged by its kind, never by a
//! path: a path names the Windows user.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read};
use std::path::{Path, PathBuf};

use markiro_proto::trust::{self, Keyset, TrustError, UpdateManifestV1};
use markiro_proto::update::{self, AppVersion, HashError};
use serde::Serialize;
use serde_json::Value;

use crate::update::rules::Offered;

/// The end of a manifest's file name, in any case.
pub const MANIFEST_SUFFIX: &str = ".update.jws";
/// The largest manifest read (the host takes the same bound, spec §10.11.2).
pub const MAX_MANIFEST_BYTES: u64 = 64 * 1024;
/// The most packages one search lists.
pub const MAX_FOUND: usize = 32;
/// The folder of a removable drive looked into besides its root.
pub const DRIVE_FOLDER: &str = "Markiro";
/// `GetDriveTypeW`'s answer for a removable drive (`DRIVE_REMOVABLE` lives in
/// `Win32_System_WindowsProgramming`; one constant is no reason for a feature).
pub const DRIVE_REMOVABLE: u32 = 2;

/// `FILE_SHARE_READ`: others may only read the installer while it is held.
#[cfg(windows)]
const FILE_SHARE_READ: u32 = 0x0000_0001;
/// `FILE_FLAG_OPEN_REPARSE_POINT`: a link is opened as itself, never followed.
#[cfg(windows)]
const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;

/// The removable drives of this computer, behind a trait so tests name their own.
pub trait RemovableDrives: Send + Sync {
    fn roots(&self) -> Vec<PathBuf>;
}

/// This computer's removable drives (`GetLogicalDrives`, `GetDriveTypeW`).
pub struct SystemDrives;

impl RemovableDrives for SystemDrives {
    #[cfg(windows)]
    fn roots(&self) -> Vec<PathBuf> {
        use windows_sys::Win32::Storage::FileSystem::{GetDriveTypeW, GetLogicalDrives};
        // SAFETY: no arguments; the answer is a mask of the drive letters in use.
        let mask = unsafe { GetLogicalDrives() };
        removable_roots(mask, |root| {
            let wide: Vec<u16> = root.encode_utf16().chain(std::iter::once(0)).collect();
            // SAFETY: `wide` is a NUL-terminated `X:\`, alive for the call.
            unsafe { GetDriveTypeW(wide.as_ptr()) }
        })
    }

    /// Elsewhere (development) there are none.
    #[cfg(not(windows))]
    fn roots(&self) -> Vec<PathBuf> {
        Vec::new()
    }
}

/// Drives a test names.
pub struct FixedDrives(pub Vec<PathBuf>);

impl RemovableDrives for FixedDrives {
    fn roots(&self) -> Vec<PathBuf> {
        self.0.clone()
    }
}

/// `X:\` for every letter of a `GetLogicalDrives` mask whose type is
/// removable, from `C:` on: `A:` and `B:` are floppies, slow to wake.
pub fn removable_roots(mask: u32, drive_type: impl Fn(&str) -> u32) -> Vec<PathBuf> {
    (2u8..26)
        .filter(|bit| mask & (1u32 << bit) != 0)
        .filter_map(|bit| {
            let root = format!("{}:\\", char::from(b'A' + bit));
            (drive_type(&root) == DRIVE_REMOVABLE).then(|| PathBuf::from(root))
        })
        .collect()
}

/// Where a package was found.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PlaceKind {
    /// `Документы\Markiro\Обновления`.
    Documents,
    /// A removable drive's root or its `Markiro\` folder.
    Removable,
}

/// One folder a search reads, not deeper.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Place {
    pub kind: PlaceKind,
    pub dir: PathBuf,
}

/// The updates folder first, then each drive's root and its `Markiro\`.
pub fn places(updates_dir: Option<&Path>, roots: &[PathBuf]) -> Vec<Place> {
    let mut places: Vec<Place> = updates_dir
        .map(|dir| Place {
            kind: PlaceKind::Documents,
            dir: dir.to_path_buf(),
        })
        .into_iter()
        .collect();
    for root in roots {
        places.push(Place {
            kind: PlaceKind::Removable,
            dir: root.clone(),
        });
        places.push(Place {
            kind: PlaceKind::Removable,
            dir: root.join(DRIVE_FOLDER),
        });
    }
    places
}

/// Why a package does not hold: the bare code the webview reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PackageError {
    /// Not a manifest of this product, too large, not text, a payload of
    /// another shape, another installer name, a link.
    ManifestMalformed,
    /// Signed with a key this build does not know (or a retired one).
    ManifestUnknownKey,
    /// The signature does not verify: changed after it was signed.
    ManifestSignature,
    /// No installer of the manifest's name beside it.
    InstallerMissing,
    /// The installer's size or SHA-256 is not the manifest's, or it is a link.
    InstallerMismatch,
    /// The disk refused (no access, a drive pulled out).
    Storage,
}

impl PackageError {
    pub fn code(self) -> &'static str {
        match self {
            Self::ManifestMalformed => "manifest_malformed",
            Self::ManifestUnknownKey => "manifest_unknown_key",
            Self::ManifestSignature => "manifest_signature",
            Self::InstallerMissing => "installer_missing",
            Self::InstallerMismatch => "installer_mismatch",
            Self::Storage => "storage",
        }
    }
}

fn storage(error: &io::Error) -> PackageError {
    eprintln!("standalone: update storage: {:?}", error.kind());
    PackageError::Storage
}

/// One package a search found. `path` is what the webview sends back;
/// `manifest` is the signed manifest (camelCase, as `@markiro/domain` reads
/// it) or `None` with `problem` naming why.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FoundPackage {
    pub path: String,
    pub place: PlaceKind,
    pub file_name: String,
    pub manifest: Option<Value>,
    pub problem: Option<&'static str>,
    #[serde(skip)]
    pub source: PathBuf,
}

/// A manifest whose signature verified, with its versions read.
pub struct Manifest {
    pub manifest: UpdateManifestV1,
    pub kid: String,
    pub version: AppVersion,
    pub min_upgrade_from: AppVersion,
}

impl Manifest {
    pub fn offered(&self) -> Offered<'_> {
        Offered {
            version: &self.version,
            min_upgrade_from: &self.min_upgrade_from,
            protocol: self.manifest.protocol,
        }
    }
}

/// A package that holds: its manifest and its installer, open and held.
pub struct Checked {
    pub manifest: Manifest,
    /// The installer beside the manifest, as the search named it (shown to
    /// the person for a manual install).
    pub installer_path: PathBuf,
    /// The path the installer is started by: on Windows the final path of
    /// the held handle (`GetFinalPathNameByHandleW`), so a junction among the
    /// folders above it, retargeted after the hash, cannot send the start to
    /// another file; every folder of a final path holds an open file and
    /// cannot be renamed. Elsewhere `installer_path`.
    pub launch_path: PathBuf,
    /// Keep it until the installer runs: on Windows nobody can change the
    /// file while this handle is open (`open_installer`).
    pub installer: File,
}

/// `\\?\C:\…` as `C:\…` and `\\?\UNC\server\…` as `\\server\…` when the
/// result is shorter than `MAX_PATH` (260), which the shell's start takes
/// as it is; a longer path keeps its verbatim prefix.
pub fn unverbatim(path: &str) -> String {
    let plain = if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = path.strip_prefix(r"\\?\") {
        rest.to_owned()
    } else {
        return path.to_owned();
    };
    if plain.encode_utf16().count() < 260 {
        plain
    } else {
        path.to_owned()
    }
}

/// The final path of the file behind `file` (Windows).
#[cfg(windows)]
fn final_path(file: &File) -> Result<PathBuf, PackageError> {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use std::os::windows::io::AsRawHandle;

    use windows_sys::Win32::Storage::FileSystem::{
        GetFinalPathNameByHandleW, FILE_NAME_NORMALIZED, VOLUME_NAME_DOS,
    };

    let mut buffer = vec![0u16; 512];
    loop {
        let capacity = u32::try_from(buffer.len()).unwrap_or(u32::MAX);
        // SAFETY: the handle is open for the call; `buffer` holds `capacity`
        // UTF-16 units, and the call writes at most that many.
        let written = unsafe {
            GetFinalPathNameByHandleW(
                file.as_raw_handle(),
                buffer.as_mut_ptr(),
                capacity,
                FILE_NAME_NORMALIZED | VOLUME_NAME_DOS,
            )
        };
        let written = usize::try_from(written).unwrap_or(usize::MAX);
        if written == 0 {
            return Err(storage(&io::Error::last_os_error()));
        }
        if written < buffer.len() {
            buffer.truncate(written);
            break;
        }
        // Too small: `written` is the size it needs, its NUL included.
        if written > 32_768 {
            return Err(PackageError::Storage);
        }
        buffer.resize(written, 0);
    }
    let text = OsString::from_wide(&buffer);
    Ok(PathBuf::from(unverbatim(&text.to_string_lossy())))
}

/// Opens `path` to read it, never through a link: on Windows a link is
/// opened as itself (`FILE_FLAG_OPEN_REPARSE_POINT`, and `share_read_only`
/// lets others only read while the handle lives); elsewhere a link or
/// another file put in its place between the look and the open is refused
/// by comparing the two. `None` when the path holds no regular file.
fn open_regular(path: &Path, share_read_only: bool) -> io::Result<Option<File>> {
    let before = fs::symlink_metadata(path)?;
    if !before.file_type().is_file() {
        return Ok(None);
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
        if share_read_only {
            options.share_mode(FILE_SHARE_READ);
        }
    }
    #[cfg(not(windows))]
    let _ = share_read_only;
    let file = options.open(path)?;
    let after = file.metadata()?;
    #[cfg(unix)]
    let same = {
        use std::os::unix::fs::MetadataExt;
        before.dev() == after.dev() && before.ino() == after.ino()
    };
    #[cfg(not(unix))]
    let same = true;
    Ok((after.is_file() && same).then_some(file))
}

/// Reads and verifies the manifest at `path`: a regular file (not a link) of
/// at most [`MAX_MANIFEST_BYTES`], signed by a key of `keyset`, of this
/// product, naming the installer of its own version and a `minUpgradeFrom`
/// no newer than it.
pub fn read_manifest(path: &Path, keyset: &Keyset) -> Result<Manifest, PackageError> {
    let file = open_regular(path, false)
        .map_err(|error| storage(&error))?
        .ok_or(PackageError::ManifestMalformed)?;
    // Read through the handle checked above, never more than the bound: a
    // file swapped or grown after the look is read no further.
    let mut bytes = Vec::new();
    (&file)
        .take(MAX_MANIFEST_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| storage(&error))?;
    if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > MAX_MANIFEST_BYTES {
        return Err(PackageError::ManifestMalformed);
    }
    let text = String::from_utf8(bytes).map_err(|_| PackageError::ManifestMalformed)?;
    let (manifest, kid) =
        trust::verify_update_manifest(text.trim(), keyset).map_err(|error| match error {
            TrustError::Malformed => PackageError::ManifestMalformed,
            TrustError::UnknownKey => PackageError::ManifestUnknownKey,
            TrustError::BadSignature => PackageError::ManifestSignature,
        })?;
    let version: AppVersion = manifest
        .version
        .parse()
        .map_err(|_| PackageError::ManifestMalformed)?;
    let min_upgrade_from: AppVersion = manifest
        .min_upgrade_from
        .parse()
        .map_err(|_| PackageError::ManifestMalformed)?;
    if manifest.product != update::PRODUCT
        || manifest.installer.name != update::installer_name(&version)
        || min_upgrade_from > version
    {
        return Err(PackageError::ManifestMalformed);
    }
    Ok(Manifest {
        manifest,
        kid,
        version,
        min_upgrade_from,
    })
}

/// The packages in `places`, at most [`MAX_FOUND`], each folder's by name. A
/// folder that is missing or unreadable is skipped.
pub fn scan(places: &[Place], keyset: &Keyset) -> Vec<FoundPackage> {
    let _quiet = CriticalErrorsQuiet::new();
    let mut found = Vec::new();
    for place in places {
        let Ok(entries) = fs::read_dir(&place.dir) else {
            continue;
        };
        let mut manifests: Vec<(String, PathBuf)> = entries
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let name = entry.file_name().into_string().ok()?;
                name.to_lowercase()
                    .ends_with(MANIFEST_SUFFIX)
                    .then(|| (name, entry.path()))
            })
            .collect();
        manifests.sort();
        for (file_name, path) in manifests {
            if found.len() == MAX_FOUND {
                return found;
            }
            let (manifest, problem) = match read_manifest(&path, keyset) {
                Ok(read) => match serde_json::to_value(&read.manifest) {
                    Ok(value) => (Some(value), None),
                    Err(_) => (None, Some(PackageError::ManifestMalformed.code())),
                },
                Err(error) => (None, Some(error.code())),
            };
            found.push(FoundPackage {
                path: path.to_string_lossy().into_owned(),
                place: place.kind,
                file_name,
                manifest,
                problem,
                source: path,
            });
        }
    }
    found
}

/// Opens the installer for reading, never through a link ([`open_regular`]).
/// On Windows the handle shares reading only (`FILE_SHARE_READ`): while it
/// is open nobody can write, rename or delete the file, and the installer
/// Windows starts under the administrator prompt can still open it to read
/// and run it.
pub fn open_installer(path: &Path) -> Result<File, PackageError> {
    match open_regular(path, true) {
        Ok(Some(file)) => Ok(file),
        Ok(None) => Err(PackageError::InstallerMismatch),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            Err(PackageError::InstallerMissing)
        }
        Err(error) => Err(storage(&error)),
    }
}

/// While a search reads the drives, Windows shows no «there is no disk in
/// the drive» window of its own for an empty card reader (it would stand
/// over the kiosk): the read fails and the drive is skipped. Restored when
/// the search ends.
struct CriticalErrorsQuiet {
    #[cfg(windows)]
    previous: Option<u32>,
}

impl CriticalErrorsQuiet {
    #[cfg(windows)]
    fn new() -> Self {
        use windows_sys::Win32::System::Diagnostics::Debug::{
            SetThreadErrorMode, SEM_FAILCRITICALERRORS,
        };
        let mut previous = 0u32;
        // SAFETY: plain call; `previous` lives for it.
        let set = unsafe { SetThreadErrorMode(SEM_FAILCRITICALERRORS, &mut previous) };
        Self {
            previous: (set != 0).then_some(previous),
        }
    }

    #[cfg(not(windows))]
    fn new() -> Self {
        Self {}
    }
}

#[cfg(windows)]
impl Drop for CriticalErrorsQuiet {
    fn drop(&mut self) {
        use windows_sys::Win32::System::Diagnostics::Debug::SetThreadErrorMode;
        if let Some(previous) = self.previous {
            // SAFETY: plain call; the old mode is not asked for.
            unsafe { SetThreadErrorMode(previous, std::ptr::null_mut()) };
        }
    }
}

/// The package of the manifest at `manifest_path`: the manifest verified
/// again (it may have changed since the search), the installer beside it
/// opened by [`open_installer`], its size and SHA-256 the manifest's.
pub fn verify(manifest_path: &Path, keyset: &Keyset) -> Result<Checked, PackageError> {
    let manifest = read_manifest(manifest_path, keyset)?;
    let dir = manifest_path
        .parent()
        .ok_or(PackageError::InstallerMissing)?;
    let installer_path = dir.join(&manifest.manifest.installer.name);
    let installer = open_installer(&installer_path)?;
    let size = manifest.manifest.installer.size_bytes;
    let meta = installer.metadata().map_err(|error| storage(&error))?;
    if meta.len() != size {
        return Err(PackageError::InstallerMismatch);
    }
    let hash = update::hash_exact(&installer, size).map_err(|error| match error {
        HashError::Io(kind) => storage(&io::Error::from(kind)),
        HashError::TooShort | HashError::TooLong => PackageError::InstallerMismatch,
    })?;
    if !hash.eq_ignore_ascii_case(&manifest.manifest.installer.sha256) {
        return Err(PackageError::InstallerMismatch);
    }
    #[cfg(windows)]
    let launch_path = final_path(&installer)?;
    #[cfg(not(windows))]
    let launch_path = installer_path.clone();
    Ok(Checked {
        manifest,
        installer_path,
        launch_path,
        installer,
    })
}

/// Makes `folder` (`Документы\Markiro\Обновления`) when it is missing; a
/// file or a link in its place is refused.
pub fn ensure_folder(folder: &Path) -> Result<(), PackageError> {
    if let Some(parent) = folder.parent() {
        fs::create_dir_all(parent).map_err(|error| storage(&error))?;
    }
    match fs::create_dir(folder) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(storage(&error)),
    }
    match fs::symlink_metadata(folder) {
        Ok(meta) if meta.file_type().is_dir() => Ok(()),
        Ok(_) => Err(PackageError::Storage),
        Err(error) => Err(storage(&error)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/update");
    const LICENSE: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../packages/domain/fixtures/standalone-license/license-subscription.jws"
    );

    fn keyset() -> Keyset {
        markiro_proto::trust::update_keyset()
    }

    /// The bytes the generator signed for `version`'s test installer.
    fn test_installer(version: &str) -> Vec<u8> {
        format!("markiro test installer {version}\n").into_bytes()
    }

    fn installer_file(version: &str) -> String {
        format!("markiro-standalone-{version}-windows-x86_64-setup.exe")
    }

    /// The signed test manifest of `version` in `dir`, its installer beside it.
    fn put_package(dir: &Path, version: &str) -> PathBuf {
        let name = format!("markiro-standalone-{version}.update.jws");
        fs::copy(Path::new(FIXTURES).join(&name), dir.join(&name)).unwrap();
        fs::write(dir.join(installer_file(version)), test_installer(version)).unwrap();
        dir.join(name)
    }

    #[test]
    fn removable_roots_are_the_removable_letters_from_c() {
        // A, C, E and F in use; A and E removable.
        let mask = 1 | (1 << 2) | (1 << 4) | (1 << 5);
        // `GetDriveTypeW`'s numbers: 2 removable, 3 fixed.
        let kind = |root: &str| match root {
            "A:\\" | "E:\\" => 2,
            _ => 3,
        };
        assert_eq!(removable_roots(mask, kind), vec![PathBuf::from("E:\\")]);
        assert_eq!(removable_roots(0, kind), Vec::<PathBuf>::new());
    }

    #[test]
    fn places_are_the_updates_folder_then_each_drive_and_its_markiro_folder() {
        let roots = [PathBuf::from("E"), PathBuf::from("F")];
        let place = |kind, dir: PathBuf| Place { kind, dir };
        assert_eq!(
            places(Some(Path::new("docs")), &roots),
            vec![
                place(PlaceKind::Documents, PathBuf::from("docs")),
                place(PlaceKind::Removable, PathBuf::from("E")),
                place(PlaceKind::Removable, Path::new("E").join("Markiro")),
                place(PlaceKind::Removable, PathBuf::from("F")),
                place(PlaceKind::Removable, Path::new("F").join("Markiro")),
            ]
        );
        assert_eq!(places(None, &[]), vec![]);
    }

    #[test]
    fn a_search_shows_signed_packages_with_their_versions_and_others_with_a_reason() {
        let dir = tempfile::tempdir().unwrap();
        put_package(dir.path(), "0.2.0");
        fs::copy(
            Path::new(FIXTURES).join("markiro-standalone-0.3.0.update.jws"),
            dir.path().join("UPPER.UPDATE.JWS"),
        )
        .unwrap();
        fs::copy(
            Path::new(FIXTURES).join("tampered/markiro-standalone-0.2.0.update.jws"),
            dir.path().join("broken.update.jws"),
        )
        .unwrap();
        // A license is signed too, but it is no update manifest (another `typ`).
        fs::copy(LICENSE, dir.path().join("license.update.jws")).unwrap();
        fs::write(
            dir.path().join("big.update.jws"),
            vec![b'a'; usize::try_from(MAX_MANIFEST_BYTES).unwrap() + 1],
        )
        .unwrap();
        fs::write(dir.path().join("notes.txt"), "не пакет").unwrap();
        let found = scan(&places(Some(dir.path()), &[]), &keyset());
        let seen: Vec<(String, Option<String>, Option<&str>)> = found
            .iter()
            .map(|package| {
                (
                    package.file_name.clone(),
                    package
                        .manifest
                        .as_ref()
                        .map(|manifest| manifest["version"].as_str().unwrap().to_owned()),
                    package.problem,
                )
            })
            .collect();
        assert_eq!(
            seen,
            vec![
                (
                    "UPPER.UPDATE.JWS".to_owned(),
                    Some("0.3.0".to_owned()),
                    None
                ),
                (
                    "big.update.jws".to_owned(),
                    None,
                    Some("manifest_malformed")
                ),
                (
                    "broken.update.jws".to_owned(),
                    None,
                    Some("manifest_signature")
                ),
                (
                    "license.update.jws".to_owned(),
                    None,
                    Some("manifest_malformed")
                ),
                (
                    "markiro-standalone-0.2.0.update.jws".to_owned(),
                    Some("0.2.0".to_owned()),
                    None
                ),
            ]
        );
        assert!(found
            .iter()
            .all(|package| package.place == PlaceKind::Documents));
        assert_eq!(
            found[4].path,
            dir.path()
                .join("markiro-standalone-0.2.0.update.jws")
                .to_string_lossy()
        );
        // The source stays in Rust: the webview sees the path and nothing else of it.
        let json = serde_json::to_value(&found[4]).unwrap();
        let mut keys: Vec<&String> = json.as_object().unwrap().keys().collect();
        keys.sort();
        assert_eq!(keys, ["fileName", "manifest", "path", "place", "problem"]);
    }

    #[test]
    fn a_drive_is_read_in_its_root_and_its_markiro_folder_only() {
        let drive = tempfile::tempdir().unwrap();
        let markiro = drive.path().join("Markiro");
        let deeper = markiro.join("old");
        fs::create_dir_all(&deeper).unwrap();
        put_package(drive.path(), "0.2.0");
        put_package(&markiro, "0.3.0");
        put_package(&deeper, "0.2.0");
        let found = scan(&places(None, &[drive.path().to_path_buf()]), &keyset());
        let versions: Vec<&str> = found
            .iter()
            .map(|package| {
                package.manifest.as_ref().unwrap()["version"]
                    .as_str()
                    .unwrap()
            })
            .collect();
        assert_eq!(versions, ["0.2.0", "0.3.0"]);
        assert!(found
            .iter()
            .all(|package| package.place == PlaceKind::Removable));
        // A missing folder is no error: nothing there.
        let none = drive.path().join("none");
        assert_eq!(scan(&places(Some(none.as_path()), &[]), &keyset()), vec![]);
    }

    #[test]
    fn a_package_holds_only_with_its_own_installer_byte_for_byte() {
        let dir = tempfile::tempdir().unwrap();
        let manifest = put_package(dir.path(), "0.2.0");
        let checked = verify(&manifest, &keyset()).unwrap();
        assert_eq!(checked.manifest.kid, "test-upd-1");
        assert_eq!(checked.manifest.version.to_string(), "0.2.0");
        assert_eq!(checked.manifest.min_upgrade_from.to_string(), "0.1.0");
        assert_eq!(
            checked.installer_path,
            dir.path().join(installer_file("0.2.0"))
        );
        drop(checked);
        let installer = dir.path().join(installer_file("0.2.0"));
        // One byte more, the same size with another byte, no installer.
        let mut longer = test_installer("0.2.0");
        longer.push(b'!');
        fs::write(&installer, &longer).unwrap();
        assert_eq!(
            verify(&manifest, &keyset()).err(),
            Some(PackageError::InstallerMismatch)
        );
        let mut changed = test_installer("0.2.0");
        changed[0] = b'M';
        fs::write(&installer, &changed).unwrap();
        assert_eq!(
            verify(&manifest, &keyset()).err(),
            Some(PackageError::InstallerMismatch)
        );
        fs::remove_file(&installer).unwrap();
        assert_eq!(
            verify(&manifest, &keyset()).err(),
            Some(PackageError::InstallerMissing)
        );
        // A manifest changed after signing.
        let tampered = tempfile::tempdir().unwrap();
        let path = tampered.path().join("markiro-standalone-0.2.0.update.jws");
        fs::copy(
            Path::new(FIXTURES).join("tampered/markiro-standalone-0.2.0.update.jws"),
            &path,
        )
        .unwrap();
        fs::write(
            tampered.path().join(installer_file("0.2.0")),
            test_installer("0.2.0"),
        )
        .unwrap();
        assert_eq!(
            verify(&path, &keyset()).err(),
            Some(PackageError::ManifestSignature)
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_link_in_place_of_the_installer_or_the_manifest_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        let manifest = put_package(dir.path(), "0.2.0");
        let installer = dir.path().join(installer_file("0.2.0"));
        let real = elsewhere.path().join("real.exe");
        fs::rename(&installer, &real).unwrap();
        std::os::unix::fs::symlink(&real, &installer).unwrap();
        assert_eq!(
            verify(&manifest, &keyset()).err(),
            Some(PackageError::InstallerMismatch)
        );
        let linked = dir.path().join("linked.update.jws");
        std::os::unix::fs::symlink(&manifest, &linked).unwrap();
        assert_eq!(
            read_manifest(&linked, &keyset()).err(),
            Some(PackageError::ManifestMalformed)
        );
    }

    #[test]
    fn the_updates_folder_is_made_when_missing_and_a_file_in_its_place_is_refused() {
        let documents = tempfile::tempdir().unwrap();
        let folder = documents.path().join("Markiro").join("Обновления");
        assert_eq!(ensure_folder(&folder), Ok(()));
        assert!(folder.is_dir());
        assert_eq!(ensure_folder(&folder), Ok(()));
        let file = documents.path().join("Markiro").join("file");
        fs::write(&file, b"x").unwrap();
        assert_eq!(ensure_folder(&file), Err(PackageError::Storage));
    }

    #[test]
    fn a_search_lists_at_most_max_found_packages() {
        let dir = tempfile::tempdir().unwrap();
        for index in 0..=MAX_FOUND {
            fs::write(dir.path().join(format!("{index:03}.update.jws")), "x").unwrap();
        }
        let found = scan(&places(Some(dir.path()), &[]), &keyset());
        assert_eq!(found.len(), MAX_FOUND);
        assert_eq!(found[0].file_name, "000.update.jws");
    }

    #[test]
    fn a_manifest_is_read_to_its_bound_and_no_further() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("big.update.jws");
        // Within the bound the signature decides; past it the size does.
        let within = vec![b'a'; usize::try_from(MAX_MANIFEST_BYTES).unwrap()];
        fs::write(&path, &within).unwrap();
        assert_eq!(
            read_manifest(&path, &keyset()).err(),
            Some(PackageError::ManifestMalformed)
        );
        // Not text at all.
        fs::write(&path, [0xff, 0xfe, 0x00]).unwrap();
        assert_eq!(
            read_manifest(&path, &keyset()).err(),
            Some(PackageError::ManifestMalformed)
        );
        // A folder in a manifest's place.
        let folder = dir.path().join("folder.update.jws");
        fs::create_dir(&folder).unwrap();
        assert_eq!(
            read_manifest(&folder, &keyset()).err(),
            Some(PackageError::ManifestMalformed)
        );
    }

    #[test]
    fn a_verbatim_final_path_is_started_as_a_plain_one() {
        assert_eq!(
            unverbatim(r"\\?\C:\Users\Анна\setup.exe"),
            r"C:\Users\Анна\setup.exe"
        );
        assert_eq!(
            unverbatim(r"\\?\UNC\server\share\setup.exe"),
            r"\\server\share\setup.exe"
        );
        assert_eq!(unverbatim(r"C:\plain\setup.exe"), r"C:\plain\setup.exe");
        let long = format!(r"\\?\C:\{}\setup.exe", "п".repeat(300));
        assert_eq!(
            unverbatim(&long),
            long,
            "too long for the shell without its prefix"
        );
    }

    #[test]
    fn the_installer_is_started_by_the_path_it_was_checked_at_outside_windows() {
        let dir = tempfile::tempdir().unwrap();
        let manifest = put_package(dir.path(), "0.2.0");
        let checked = verify(&manifest, &keyset()).unwrap();
        if cfg!(not(windows)) {
            assert_eq!(checked.launch_path, checked.installer_path);
        }
    }

    #[test]
    fn every_refusal_has_its_own_code() {
        let codes = [
            PackageError::ManifestMalformed,
            PackageError::ManifestUnknownKey,
            PackageError::ManifestSignature,
            PackageError::InstallerMissing,
            PackageError::InstallerMismatch,
            PackageError::Storage,
        ]
        .map(PackageError::code);
        assert_eq!(
            codes,
            [
                "manifest_malformed",
                "manifest_unknown_key",
                "manifest_signature",
                "installer_missing",
                "installer_mismatch",
                "storage"
            ]
        );
    }
}

/// The handle's sharing on NTFS, which only Windows shows (the
/// `standalone-windows-build` job runs it).
#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;

    /// ERROR_SHARING_VIOLATION.
    const SHARING_VIOLATION: i32 = 32;

    #[test]
    fn while_the_shell_holds_the_installer_nobody_can_write_rename_or_delete_it_but_anybody_can_read_it(
    ) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir
            .path()
            .join("markiro-standalone-0.2.0-windows-x86_64-setup.exe");
        fs::write(&path, b"markiro test installer 0.2.0\n").unwrap();
        let held = open_installer(&path).unwrap();
        let write = OpenOptions::new().write(true).open(&path).unwrap_err();
        assert_eq!(write.raw_os_error(), Some(SHARING_VIOLATION), "{write}");
        assert!(fs::rename(&path, dir.path().join("moved.exe")).is_err());
        assert!(fs::remove_file(&path).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"markiro test installer 0.2.0\n");
        drop(held);
        fs::remove_file(&path).unwrap();
    }

    /// The claim the update path rests on: Windows starts a process from a
    /// file this handle holds (the loader opens it to execute, which a
    /// read-only share allows).
    #[test]
    fn a_held_installer_can_still_be_started() {
        let dir = tempfile::tempdir().unwrap();
        let system = std::env::var_os("SystemRoot").expect("SystemRoot");
        let path = dir.path().join("held-whoami.exe");
        fs::copy(
            std::path::Path::new(&system)
                .join("System32")
                .join("whoami.exe"),
            &path,
        )
        .unwrap();
        let held = open_installer(&path).unwrap();
        let status = std::process::Command::new(&path)
            .stdout(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(status.success());
        drop(held);
    }

    #[test]
    fn the_final_path_of_a_held_file_is_its_real_path() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir
            .path()
            .join("markiro-standalone-0.2.0-windows-x86_64-setup.exe");
        fs::write(&path, b"x").unwrap();
        let held = open_installer(&path).unwrap();
        let real = fs::canonicalize(&path).unwrap();
        assert_eq!(
            final_path(&held).unwrap().to_string_lossy().to_lowercase(),
            unverbatim(&real.to_string_lossy()).to_lowercase()
        );
    }
}
