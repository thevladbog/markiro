import json
import os
from pathlib import Path
import runpy
import sys

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from image_retention import deployment_history, deployment_lock

# The archive CLI is installed on the server as archive-rollouts.py.
helpers = runpy.run_path(str(HERE / 'archive-rollouts.py'))
ROOT = helpers['ROOT']


def validate_receipt(receipt, readback):
    return readback == receipt['object']


def unchanged_archive(path, info):
    return path.resolve(strict=True) == path and (
        helpers['signature'](path.lstat()) == helpers['signature'](info)
    )


def verify_local_and_remote():
    verified = {}
    cert_sha = helpers['certificate_digest']()
    for operation in helpers['SCOPE']:
        for name in helpers['NAMES']:
            path = helpers['archive_path'](operation, name)
            receipt = json.loads((HERE / 'receipts' / f'{operation}-{name}.json').read_bytes())
            source_hash = receipt['plainSha256']
            key = helpers['archive_key'](operation, name, source_hash)
            if (receipt['schemaVersion'] != 1 or receipt['bucket'] != 'markiro-tmp-media'
                    or receipt['relativePath'] != str(path.relative_to(ROOT))
                    or receipt['key'] != key or receipt['recipientSha256'] != cert_sha):
                raise RuntimeError('archive receipt does not match the approved path and key')
            readback = helpers['s3_json']('verify', key, receipt['object']['version'])
            if not validate_receipt(receipt, readback):
                raise RuntimeError('exact S3 version failed final readback')
            if path.exists() or path.is_symlink():
                digest, info = helpers['manifest'](path)
                if (digest != source_hash or info.st_size != receipt['plainBytes']
                        or list(helpers['signature'](info)) != receipt['sourceIdentity']):
                    raise RuntimeError('original archive changed after upload')
                verified[path] = info
            print('RECOVERY_OBJECT_VERIFIED', str(path.relative_to(ROOT)), flush=True)
    return verified


def available_bytes():
    filesystem = os.statvfs(ROOT)
    return filesystem.f_bavail * filesystem.f_frsize


def retire():
    _, _, _, revision = deployment_history()
    verified = verify_local_and_remote()
    before = available_bytes()
    removed = []
    with deployment_lock():
        if deployment_history()[3] != revision:
            raise RuntimeError('deployment changed while verifying archives')
        if any(not unchanged_archive(path, info) for path, info in verified.items()):
            raise RuntimeError('archive changed before unlink')
        for path in verified:
            path.unlink()
            parent = os.open(path.parent, os.O_DIRECTORY)
            try:
                os.fsync(parent)
            finally:
                os.close(parent)
            removed.append(str(path.relative_to(ROOT)))
    after = available_bytes()
    print(json.dumps({
        'removedLocal': removed, 's3VersionsVerified': 4, 'freeBefore': before,
        'freeAfter': after, 'bytesFreed': after - before,
    }), flush=True)


if __name__ == '__main__':
    retire()
