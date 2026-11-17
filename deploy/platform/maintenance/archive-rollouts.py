import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys

ROOT = Path('/opt/markiro-platform')
HOME = ROOT / 'maintenance'
STATE = ROOT / 'state'
API = '/usr/bin/docker'
OPENSSL = '/usr/bin/openssl'
PREFIX = 'ops/rollout-archive/v1'
SCOPE = (
    '23df39f9-70b4-4852-bfaa-30c22e08fd9e',
    '263bf69b-cb37-42f6-b7b3-a09a1b15f4ae',
)
NAMES = ('old-images.tar', 'edge-image.tar')
SHA256 = re.compile(r'[a-f0-9]{64}\Z')
CERTIFICATE = HOME / 'rollout-archive-recipient.pem'


def manifest(path):
    with path.open('rb') as source:
        before = os.fstat(source.fileno())
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or path.resolve(strict=True) != path:
            raise RuntimeError('archive path is not a canonical regular file')
        digest = hashlib.file_digest(source, 'sha256').hexdigest()
        after = os.fstat(source.fileno())
    if signature(before) != signature(after) or signature(after) != signature(path.lstat()):
        raise RuntimeError('archive changed during hashing')
    return digest, before


def signature(file_stat):
    return (file_stat.st_dev, file_stat.st_ino, file_stat.st_size, file_stat.st_mtime_ns,
            file_stat.st_ctime_ns, file_stat.st_mode, file_stat.st_uid, file_stat.st_gid)


def exec_s3(mode, key, *args):
    container_ids = subprocess.check_output(
        [API, 'ps', '--filter', 'label=com.docker.compose.service=api', '--format', '{{.ID}}'],
        text=True, timeout=10,
    ).splitlines()
    if len(container_ids) != 1 or not re.fullmatch('[a-f0-9]{12,64}', container_ids[0]):
        raise RuntimeError('could not identify the live S3 client')
    return [API, 'exec', '-i', '-w', '/app', container_ids[0], 'node', '-e',
            (HOME / 'archive-s3.cjs').read_text(), mode, key, *args]


def s3_json(mode, key, *args, body=None):
    return json.loads(subprocess.check_output(exec_s3(mode, key, *args), input=body, timeout=2800))


def canonical_json(value):
    return (json.dumps(value, sort_keys=True) + '\n').encode()


def archive_path(operation, name):
    if operation not in SCOPE or name not in NAMES:
        raise RuntimeError('file is outside the approved archival scope')
    return ROOT / 'manual-releases' / operation / name


def archive_key(operation, name, digest):
    if not SHA256.fullmatch(digest):
        raise RuntimeError('invalid hash')
    return f'{PREFIX}/{operation}/{name}.{digest}.cms'


def publish(path, operation, name):
    digest, info = manifest(path)
    key = archive_key(operation, name, digest)
    receipt = HOME / 'receipts' / f'{operation}-{name}.json'
    if receipt.exists():
        row = json.loads(receipt.read_bytes())
        if row['plainSha256'] != digest:
            raise RuntimeError('local archive differs from its receipt')
        if s3_json('verify', key, row['object']['version']) != row['object']:
            raise RuntimeError('archival readback differs from its receipt')
        return
    with path.open('rb') as source, subprocess.Popen(
        [OPENSSL, 'cms', '-encrypt', '-binary', '-stream', '-aes-256-gcm',
         '-outform', 'DER', str(CERTIFICATE)],
        stdin=source, stdout=subprocess.PIPE,
    ) as encrypt:
        row = subprocess.check_output(exec_s3('put', key), stdin=encrypt.stdout, timeout=2800)
        if encrypt.wait(timeout=15) != 0:
            raise RuntimeError('archive encryption failed')
    uploaded = json.loads(row)
    if s3_json('verify', key, uploaded['version']) != uploaded:
        raise RuntimeError('downloaded ciphertext differs')
    after_digest, after = manifest(path)
    if after_digest != digest or signature(after) != signature(info):
        raise RuntimeError('local archive changed before receipt')
    record = {
        'schemaVersion': 1, 'bucket': 'markiro-tmp-media', 'key': key, 'object': uploaded,
        'relativePath': str(path.relative_to(ROOT)), 'plainSha256': digest, 'plainBytes': info.st_size,
        'mode': stat.S_IMODE(info.st_mode), 'uid': info.st_uid, 'gid': info.st_gid,
        'mtimeNs': info.st_mtime_ns, 'sourceIdentity': signature(info),
        'recipientSha256': certificate_digest(),
    }
    body = canonical_json(record)
    s3_json('receipt', key + '.json', body=body)
    with receipt.open('xb') as target:
        target.write(body)
        target.flush()
        os.fsync(target.fileno())
    directory = os.open(receipt.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)
    print('ARCHIVED', json.dumps({**record, 'sourceIdentity': None}), flush=True)


def certificate_digest():
    cert = subprocess.check_output([OPENSSL, 'x509', '-in', CERTIFICATE, '-outform', 'DER'], timeout=10)
    return hashlib.sha256(cert).hexdigest()


def main():
    mode = sys.argv[1]
    if mode == 'copy':
        for operation in SCOPE:
            for name in NAMES:
                publish(archive_path(operation, name), operation, name)
    elif mode == 'download' and len(sys.argv) == 4:
        operation, name = sys.argv[2:4]
        archive_path(operation, name)
        stored = json.loads((HOME / 'receipts' / f'{operation}-{name}.json').read_bytes())
        args = exec_s3('download', stored['key'], stored['object']['version'])
        subprocess.run(args, check=True, timeout=2800)
    else:
        raise SystemExit('usage: archive-rollouts.py copy | download OPERATION NAME')


if __name__ == '__main__':
    main()
