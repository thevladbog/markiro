import argparse
import contextlib
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path('/opt/markiro-platform')
STATE = ROOT / 'state'
LOCK = STATE / '.deploy.lock'
DOCKER = ('/usr/bin/docker', '--host', 'unix:///var/run/docker.sock')
SERVICES = ('api', 'edge', 'postgres')
REPOSITORIES = {
    'api': 'thevladbog/markiro-api',
    'edge': 'thevladbog/markiro-platform-edge',
}
DIGEST = re.compile(r'sha256:[0-9a-f]{64}\Z')
UUID = re.compile(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\Z')
HEALTHY = 'platform-healthy-forward-rollout-index'
ANCHOR = 'platform-forward-recovery-index'
TARGET_FREE = 12 * 1024**3
MAX_IMAGES = 4


class Busy(Exception):
    pass


def candidates(history, in_use, present):
    if len(history) < 3:
        return {}
    retained = set(history[0]) | set(history[1]) | in_use
    result = {}
    for rollout in reversed(history[2:]):
        for image, ref in rollout.items():
            if image in retained or image not in present:
                continue
            local = present[image]
            if not local.get('RepoTags') and set(local.get('RepoDigests') or ()) <= {ref}:
                result[image] = ref
    return result


def confirmed_manifest(manifest, image):
    return (
        manifest.get('schemaVersion') == 2
        and manifest.get('config', {}).get('digest') == image
        and bool(manifest.get('layers'))
        and all(DIGEST.fullmatch(layer.get('digest', '')) for layer in manifest['layers'])
    )


def pinned_document(path, expected=None):
    info = path.lstat()
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1
            or info.st_mode & 0o022 or path.resolve(strict=True) != path or info.st_size > 2**21):
        raise ValueError('unsafe deployment evidence file')
    data = path.read_bytes()
    actual = hashlib.sha256(data).hexdigest()
    if expected is not None and actual != expected:
        raise ValueError('deployment evidence hash mismatch')
    return json.loads(data), actual


def registry(record, operation):
    admission = record['operation']['admission']['identity']
    if record['kind'] != 'platform-healthy-forward-rollout-host-operation' or admission['operationId'] != operation:
        raise ValueError('wrong rollout operation')
    result = {}
    for service, repository in REPOSITORIES.items():
        entry = admission['admission']['registry'][service]
        image, ref = entry['imageId'], entry['reference']
        prefix = f'ghcr.io/{repository}@'
        if not (entry['platform'] == 'linux/amd64' and DIGEST.fullmatch(image)
                and ref.startswith(prefix) and DIGEST.fullmatch(ref.removeprefix(prefix))):
            raise ValueError('unrecognized rollout image')
        result[image] = ref
    return result


def deployment_history():
    index, fingerprint = pinned_document(STATE / 'upgrade-index.json')
    history = []
    used_operations = set()
    active = None
    while index['kind'] == HEALTHY:
        operation = index['operationId']
        if not UUID.fullmatch(operation) or operation in used_operations or len(history) >= 128:
            raise ValueError('invalid rollout history')
        used_operations.add(operation)
        base = STATE / 'healthy-forward-rollouts' / operation
        state, _ = pinned_document(base / 'state.json', index['stateSha256'])
        if (state['phase'] != 'healthy' or state['sequence'] != 9 or state['operationId'] != operation
                or state['predecessorIndexSha256'] != index['predecessorIndexSha256']):
            raise ValueError('rollout is not healthy')
        if active is None:
            active = {service: state[service] for service in SERVICES}
        record, _ = pinned_document(
            ROOT / 'upgrade-operations' / operation / 'healthy-forward-rollout/operation.json',
            state['operationSha256'],
        )
        history.append(registry(record, operation))
        index, _ = pinned_document(base / 'predecessor-index.json', index['predecessorIndexSha256'])
        if state['predecessorOperationId'] != index['operationId']:
            raise ValueError('rollout predecessor mismatch')
    if active is None or index['kind'] != ANCHOR:
        raise ValueError('unrecognized deployment history anchor')
    reserved = set()
    for path in (ROOT / 'upgrade-operations').glob('*/healthy-forward-rollout/operation.json'):
        if path.parent.parent.name not in used_operations:
            record, _ = pinned_document(path)
            reserved.update(registry(record, path.parent.parent.name))
            reserved.update(
                row['imageId'] for row in record['operation']['runtime']['containers'].values()
            )
    return history, active, reserved, fingerprint


def command(*args):
    return subprocess.check_output([*DOCKER, *args], text=True, timeout=25)


def local_inventory(active):
    ids = command('container', 'ls', '-aq', '--no-trunc').splitlines()
    containers = json.loads(command('container', 'inspect', *ids)) if ids else []
    running = {container['Id'] for container in containers if container['State']['Running']}
    if not set(active.values()) <= running:
        raise ValueError('healthy deployment is not running')
    used = {container['Image'] for container in containers}
    image_ids = set(command('image', 'ls', '-q', '--no-trunc').splitlines())
    local = json.loads(command('image', 'inspect', *sorted(image_ids))) if image_ids else []
    local_by_id = {image['Id']: image for image in local}
    return used, local_by_id


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def registry_has(ref, image):
    repository, digest = ref.removeprefix('ghcr.io/').split('@')
    if repository not in REPOSITORIES.values() or not DIGEST.fullmatch(digest):
        return False
    opener = urllib.request.build_opener(NoRedirect())
    args = urllib.parse.urlencode({'service': 'ghcr.io', 'scope': f'repository:{repository}:pull'})
    try:
        with opener.open('https://ghcr.io/token?' + args, timeout=5) as response:
            token = json.loads(response.read(256 * 1024))['token']
        headers = {'Authorization': 'Bearer ' + token}
        base = f'https://ghcr.io/v2/{repository}'
        request = urllib.request.Request(
            base + '/manifests/' + digest,
            headers={**headers, 'Accept': 'application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json'},
        )
        with opener.open(request, timeout=5) as response:
            data = response.read(1024 * 1024 + 1)
        if len(data) > 1024 * 1024 or 'sha256:' + hashlib.sha256(data).hexdigest() != digest:
            return False
        manifest = json.loads(data)
        if not confirmed_manifest(manifest, image) or len(manifest['layers']) > 32:
            return False
        assets = [image] + [layer['digest'] for layer in manifest['layers']]
        for blob in assets:
            request = urllib.request.Request(base + '/blobs/' + blob, headers=headers, method='HEAD')
            try:
                with opener.open(request, timeout=5) as response:
                    if response.status != 200:
                        return False
            except urllib.error.HTTPError as error:
                # GHCR issues a signed redirect only for an available blob.
                with error:
                    destination = urllib.parse.urlsplit(error.headers.get('Location', ''))
                    if error.code not in (302, 307) or destination.scheme != 'https' or (
                        destination.hostname != 'pkg-containers.githubusercontent.com'
                        and not (destination.hostname or '').endswith('.githubusercontent.com')
                    ):
                        return False
                    # Never forward the GHCR token to blob storage.
                    with opener.open(urllib.request.Request(destination.geturl(), method='HEAD'), timeout=5) as redirected:
                        if redirected.status != 200:
                            return False
        return True
    except (OSError, ValueError, KeyError, TypeError):
        return False


@contextlib.contextmanager
def deployment_lock():
    try:
        handle = os.open(LOCK, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    except FileExistsError as exc:
        raise Busy from exc
    try:
        owner = os.fstat(handle)
        os.write(handle, b'markiro-image-retention\n')
        os.fsync(handle)
        yield
    finally:
        os.close(handle)
        current = LOCK.lstat()
        if (owner.st_dev, owner.st_ino) != (current.st_dev, current.st_ino):
            raise RuntimeError('deployment lock owner changed')
        LOCK.unlink()


def free_bytes():
    engine = Path(command('info', '--format', '{{.DockerRootDir}}').strip())
    if not engine.is_absolute() or not engine.is_dir():
        raise ValueError('invalid Docker root')
    fs = os.statvfs(engine)
    return fs.f_bavail * fs.f_frsize


def run(apply):
    if LOCK.exists():
        raise Busy
    history, active, extra, revision = deployment_history()
    used, local = local_inventory(active)
    selected = candidates(history, used | extra, local)
    free_before = free_bytes()
    removed = []
    if apply and free_before < TARGET_FREE:
        for image, ref in list(selected.items())[:MAX_IMAGES]:
            if not registry_has(ref, image):
                print(json.dumps({'registryUnavailable': ref}), flush=True)
                continue
            with deployment_lock():
                latest, current, reserved, fresh = deployment_history()
                if fresh != revision:
                    raise Busy
                used, local = local_inventory(current)
                if (set(latest[0]) | set(latest[1])) <= set(local) and (
                    candidates(latest, used | reserved, local).get(image) == ref
                ):
                    command('image', 'rm', '--no-prune', image)
                    removed.append(image)
            if free_bytes() >= TARGET_FREE:
                break
    final_free = free_bytes()
    print(json.dumps({
        'apply': apply, 'rollouts': len(history), 'protectedContainerImages': len(used),
        'candidates': list(selected), 'removed': removed, 'freeBefore': free_before,
        'freeAfter': final_free, 'belowTarget': final_free < TARGET_FREE,
    }), flush=True)


def terminated(_signum, _frame):
    raise SystemExit(143)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--apply', action='store_true')
    options = parser.parse_args()
    signal.signal(signal.SIGTERM, terminated)
    try:
        run(options.apply)
    except Busy:
        print(json.dumps({'skipped': 'deployment or recovery in progress'}))
