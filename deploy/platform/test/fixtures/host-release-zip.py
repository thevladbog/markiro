"""Static test archive writer: inputs are file arguments, never generated code."""
import json
import sys
import zipfile
with open(sys.argv[1], encoding="utf-8") as source:
    entries = json.load(source)
with zipfile.ZipFile(sys.argv[2], "w", compression=zipfile.ZIP_DEFLATED) as archive:
    for name, text in entries.items():
        info = zipfile.ZipInfo(name)
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o100600 << 16
        archive.writestr(info, text)
