"""Read bounded ZIP members without ever using their names as filesystem paths."""
import json
import os
import stat
import struct
import sys
import zipfile
import zlib

NAMES = {"platform-manifest.json", "release-evidence.json"}
LIMIT = 256 * 1024


def read_member(source, info):
    # ZipExtFile clamps output to the declared file_size and can accept a forged
    # prefix CRC. Read the bounded compressed bytes and validate the actual end
    # of the deflate stream independently of that declared uncompressed size.
    source.seek(info.header_offset)
    header = source.read(30)
    if len(header) != 30:
        raise ValueError()
    (
        signature, _, flags, method, _, _, crc, compressed_size, size,
        name_size, extra_size,
    ) = struct.unpack("<4s5H3L2H", header)
    if (
        signature != b"PK\x03\x04"
        or flags != info.flag_bits
        or method != info.compress_type
        or (
            not flags & 8
            and (crc, compressed_size, size)
            != (info.CRC, info.compress_size, info.file_size)
        )
    ):
        raise ValueError()
    source.seek(name_size + extra_size, os.SEEK_CUR)
    compressed = source.read(info.compress_size)
    if len(compressed) != info.compress_size:
        raise ValueError()
    if method == zipfile.ZIP_DEFLATED:
        decompressor = zlib.decompressobj(-15)
        data = decompressor.decompress(compressed, LIMIT + 1)
        if (
            not decompressor.eof
            or decompressor.unconsumed_tail
            or decompressor.unused_data
        ):
            raise ValueError()
    else:
        data = compressed
    if len(data) > LIMIT or len(data) != info.file_size or zlib.crc32(data) != info.CRC:
        raise ValueError()
    return data


def read_archive(path):
    if not 0 < os.stat(path).st_size <= 1024 * 1024:
        raise ValueError()
    with zipfile.ZipFile(path) as archive, open(path, "rb") as source:
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
            # Retain zipfile's local-name, unsupported-flag and overlap checks,
            # but never rely on ZipExtFile's declared-size EOF or prefix CRC.
            with archive.open(info):
                data = read_member(source, info)
            result[info.filename] = data.decode("utf-8", errors="strict")
        return result


try:
    print(json.dumps(read_archive(sys.argv[1]), ensure_ascii=False))
except Exception:
    sys.stderr.write("invalid admission archive\n")
    sys.exit(1)
