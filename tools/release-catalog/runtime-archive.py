"""Transfer compiled catalog contracts and pinned dependencies between isolated jobs."""

import hashlib
from itertools import chain
import os
from pathlib import Path
import posixpath
import re
import shutil
import stat
import sys
import tempfile
import zipfile


WORKSPACES = ("packages/domain", "packages/platform-contracts")
ROOTS = ("node_modules",) + tuple(
    f"{package}/{directory}"
    for package in WORKSPACES
    for directory in ("node_modules", "dist")
)
MAX_ARCHIVE_BYTES = 256 * 1024**2
MAX_RUNTIME_BYTES = 512 * 1024**2
MAX_ENTRIES = 60_000
MAX_PATH = 4096


def require(condition):
    if not condition:
        raise ValueError("invalid publisher runtime archive")


def clean_path(path):
    return 0 < len(path) <= MAX_PATH and not re.search(r"[\\\x00-\x1f\x7f]", path)


def check_workspace():
    for path in ("packages", *WORKSPACES):
        require(stat.S_ISDIR(Path(path).lstat().st_mode))


def source_entries(path):
    info = path.lstat()
    yield path.as_posix(), info
    if stat.S_ISDIR(info.st_mode):
        for child in path.iterdir():
            yield from source_entries(child)


def write_entry(archive, name, mode):
    if stat.S_ISLNK(mode):
        info = zipfile.ZipInfo(name)
        info.create_system = 3
        info.external_attr = mode << 16
        archive.writestr(info, os.readlink(name).encode("utf-8"))
    else:
        require(stat.S_ISREG(mode) or stat.S_ISDIR(mode))
        archive.write(name, name)


def inventory(archive):
    members = archive.infolist()
    require(len(members) <= MAX_ENTRIES)
    require(sum(info.file_size for info in members) <= MAX_RUNTIME_BYTES)
    entries = {}
    links = {}
    for info in members:
        name = info.filename.removesuffix("/")
        require(info.orig_filename == info.filename and clean_path(name))
        require(all(part not in ("", ".", "..") for part in name.split("/")))
        require(name not in entries)
        require(any(name == root or name.startswith(f"{root}/") for root in ROOTS))
        require(info.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED))
        require(not info.flag_bits & 1)
        mode = info.external_attr >> 16
        if info.is_dir():
            require(stat.S_ISDIR(mode) and info.file_size == 0)
        elif stat.S_ISLNK(mode):
            require(0 < info.file_size <= MAX_PATH)
            target = archive.read(info).decode("utf-8")
            require(clean_path(target) and not target.startswith("/"))
            parent = posixpath.dirname(name)
            resolved = posixpath.normpath(posixpath.join(parent, target))
            # Require pnpm's normalized relative link spelling. This excludes
            # paths whose interpretation depends on traversing an intermediate link.
            require(posixpath.relpath(resolved, parent) == target)
            links[name] = (target, resolved)
        else:
            require(stat.S_ISREG(mode))
        entries[name] = info

    for root in ROOTS:
        require(root in entries and entries[root].is_dir())
    for name in entries:
        if name not in ROOTS:
            parent = posixpath.dirname(name)
            require(parent in entries and entries[parent].is_dir())
    for _, target in links.values():
        require(target in entries or target in WORKSPACES)
    return entries, links


def digest(file):
    file.seek(0)
    info = os.fstat(file.fileno())
    require(stat.S_ISREG(info.st_mode) and 0 < info.st_size <= MAX_ARCHIVE_BYTES)
    return hashlib.file_digest(file, "sha256").hexdigest()


def pack(path):
    require(all(stat.S_ISDIR(Path(root).lstat().st_mode) for root in ROOTS))
    require(not any(path.resolve().is_relative_to(Path(root).resolve()) for root in ROOTS))
    with path.open("x+b") as file:
        try:
            with zipfile.ZipFile(file, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                total = 0
                entries = chain.from_iterable(source_entries(Path(root)) for root in ROOTS)
                for count, (name, info) in enumerate(entries, 1):
                    if not stat.S_ISDIR(info.st_mode):
                        total += info.st_size
                    require(count <= MAX_ENTRIES and total <= MAX_RUNTIME_BYTES)
                    write_entry(archive, name, info.st_mode)
            file.flush()
            checksum = digest(file)
            with zipfile.ZipFile(file) as archive:
                inventory(archive)
        except Exception:
            path.unlink()
            raise
    print(checksum)


def restore(path, expected_digest):
    require(re.fullmatch(r"[a-f0-9]{64}", expected_digest) is not None)
    require(stat.S_ISREG(path.lstat().st_mode))
    require(not any(os.path.lexists(root) for root in ROOTS))
    with path.open("rb") as file:
        require(digest(file) == expected_digest)
        with zipfile.ZipFile(file) as archive, tempfile.TemporaryDirectory(dir=".") as directory:
            entries, links = inventory(archive)
            stage = Path(directory)
            for workspace in WORKSPACES:
                (stage / workspace).mkdir(parents=True)
            for name, info in sorted(entries.items()):
                if info.is_dir():
                    (stage / name).mkdir()
            for name, info in entries.items():
                if not info.is_dir() and name not in links:
                    with archive.open(info) as source, (stage / name).open("xb") as output:
                        shutil.copyfileobj(source, output)
                        require(output.tell() == info.file_size)
                    (stage / name).chmod(0o755 if info.external_attr >> 16 & 0o111 else 0o644)
            for name, (target, _) in links.items():
                (stage / name).symlink_to(target)

            check_workspace()
            require(not any(os.path.lexists(root) for root in ROOTS))
            moved = []
            try:
                for root in ROOTS:
                    (stage / root).rename(root)
                    moved.append(root)
            except OSError:
                for root in reversed(moved):
                    Path(root).rename(stage / root)
                raise


def main(arguments):
    check_workspace()
    if len(arguments) == 2 and arguments[0] == "pack":
        pack(Path(arguments[1]))
    elif len(arguments) == 3 and arguments[0] == "restore":
        restore(Path(arguments[1]), arguments[2])
    else:
        raise ValueError("invalid publisher runtime archive operation")


try:
    main(sys.argv[1:])
except (OSError, ValueError, RuntimeError, zipfile.BadZipFile):
    sys.stderr.write("publisher runtime archive rejected\n")
    sys.exit(1)
