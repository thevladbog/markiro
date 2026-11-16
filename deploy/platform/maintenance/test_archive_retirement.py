import os
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest

sys.path.insert(0, str(Path(__file__).parent))
from archive_retirement import validate_receipt, unchanged_archive


class ArchiveRetirementTest(unittest.TestCase):
    def test_remote_readback_must_match_version_size_and_hash(self):
        receipt = {'object': {'version': 'v1', 'bytes': 42, 'sha256': 'a' * 64}}
        self.assertTrue(validate_receipt(receipt, dict(receipt['object'])))
        for field, value in [('version', 'v2'), ('bytes', 41), ('sha256', 'b' * 64)]:
            self.assertFalse(validate_receipt(receipt, {**receipt['object'], field: value}))

    def test_file_replaced_under_same_name_is_not_safe_to_remove(self):
        with TemporaryDirectory() as temp:
            path = Path(temp).resolve() / 'old-images.tar'
            path.write_bytes(b'archive')
            stationary = path.stat()
            self.assertTrue(unchanged_archive(path, stationary))
            replacement = path.with_suffix('.replacement')
            replacement.write_bytes(b'archive')
            os.replace(replacement, path)
            self.assertFalse(unchanged_archive(path, stationary))


if __name__ == '__main__':
    unittest.main()
