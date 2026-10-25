"""Fixed Linux rename bridge; JSON stdin is trusted loader data, never shell text."""
import ctypes
import hashlib
import json
import os
import re
import stat
import sys


def metadata(info):
    return dict(dev=str(info.st_dev), ino=str(info.st_ino), uid=info.st_uid,
                gid=info.st_gid, mode=stat.S_IMODE(info.st_mode), size=str(info.st_size),
                mtimeNs=str(info.st_mtime_ns), ctimeNs=str(info.st_ctime_ns))


def private_chain(path):
    current = os.path.sep
    for part in path.split(os.path.sep)[1:]:
        current = os.path.join(current, part)
        info = os.lstat(current)
        assert stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode)
        assert info.st_uid in (0, os.getuid())
        assert not (stat.S_IMODE(info.st_mode) & 0o022) or (info.st_uid == 0 and info.st_mode & stat.S_ISVTX)
    info = os.lstat(path)
    assert info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o700


def main():
    assert sys.platform == "linux"
    raw = sys.stdin.buffer.read(8193)
    assert len(raw) <= 8192
    value = json.loads(raw)
    assert set(value) == {"root", "destination", "expected", "sha256"}
    root = value["root"]
    assert isinstance(root, str) and os.path.isabs(root) and os.path.normpath(root) == root
    assert re.fullmatch(r"forward-recovery-operations/[0-9a-f-]{36}/predecessor-index\.json", value["destination"])
    assert re.fullmatch(r"[0-9a-f]{64}", value["sha256"])
    source = os.path.join(root, "upgrade-index.json")
    destination = os.path.join(root, value["destination"])
    private_chain(root)
    private_chain(os.path.dirname(destination))
    before = os.lstat(source)
    assert stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_uid == os.getuid()
    assert stat.S_IMODE(before.st_mode) == 0o600 and metadata(before) == value["expected"]
    fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        assert metadata(os.fstat(fd)) == value["expected"]
        content = os.read(fd, 1048577)
        assert len(content) <= 1048576 and hashlib.sha256(content).hexdigest() == value["sha256"]
        assert metadata(os.fstat(fd)) == value["expected"]
    finally:
        os.close(fd)
    assert not os.path.lexists(destination)
    libc = ctypes.CDLL(None, use_errno=True)
    renameat2 = libc.renameat2
    renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    renameat2.restype = ctypes.c_int
    if renameat2(-100, os.fsencode(source), -100, os.fsencode(destination), 1) != 0:
        raise OSError(ctypes.get_errno())
    for parent in (root, os.path.dirname(destination)):
        handle = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(handle)
        finally:
            os.close(handle)
    assert not os.path.lexists(source)
    after = os.lstat(destination)
    assert stat.S_ISREG(after.st_mode) and after.st_nlink == 1
    actual = metadata(after)
    for key in value["expected"]:
        if key != "ctimeNs":
            assert actual[key] == value["expected"][key]
    handle = os.open(destination, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        assert metadata(os.fstat(handle)) == actual
        assert hashlib.sha256(os.read(handle, 1048577)).hexdigest() == value["sha256"]
    finally:
        os.close(handle)
    sys.stdout.write(json.dumps(actual, separators=(",", ":")) + "\n")


try:
    main()
except BaseException:
    sys.stderr.write("Forward ownership handoff failed.\n")
    sys.exit(1)
