"""Read bounded ZIP members without ever using their names as filesystem paths."""
import json
import os
import stat
import sys
import zipfile

NAMES = {"platform-manifest.json", "release-evidence.json"}
LIMIT = 256 * 1024


def read_archive(path):
    if not 0 < os.stat(path).st_size <= 1024 * 1024:
        raise ValueError()
    with zipfile.ZipFile(path) as archive:
        members = archive.infolist()
        if len(members) != 2 or {info.filename for info in members} != NAMES:
            raise ValueError()
        result = {}
        for info in members:
            mode = info.external_attr >> 16
            if (
                info.orig_filename != info.filename
                or info.is_dir()
                or (stat.S_IFMT(mode) not in (0, stat.S_IFREG))
                or info.external_attr & 0x10
                or info.flag_bits & 1
                or info.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED)
                or not 0 < info.file_size <= LIMIT
                or not 0 < info.compress_size <= 1024 * 1024
            ):
                raise ValueError()
            # zipfile validates local headers, overlaps, truncation and CRC as read reaches EOF.
            with archive.open(info) as member:
                data = member.read(LIMIT + 1)
                if len(data) != info.file_size or len(data) > LIMIT or member.read(1):
                    raise ValueError()
            result[info.filename] = data.decode("utf-8", errors="strict")
        return result


try:
    print(json.dumps(read_archive(sys.argv[1]), ensure_ascii=False))
except Exception:
    sys.stderr.write("invalid admission archive\n")
    sys.exit(1)
