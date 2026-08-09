# Load and rotate Yandex SaaS secrets

Create and rotate production payloads outside Terraform. Terraform creates
Lockbox containers and access bindings only. Handle values through standard
input, a protected file descriptor, or an approved broker; never through shell
arguments, tracing, GitHub variables, Git, chat, Terraform plans/state, or
rendered Compose output.

## Inventory the required secret boundaries

<!-- runbook-contract:secrets-inventory -->

1. Open the protected change record and assign two operators: one supplies the
   value and one verifies entry names, bindings, and evidence.
2. Inventory the runtime Lockbox payload against `.env.production.example`.
   Include PostgreSQL connection data, Better Auth secret and origins,
   pairing-code pepper, SMTP endpoint/credentials/sender/reply-to, mail-payload
   encryption key, and private S3 access values. Registry credentials are not
   runtime application configuration.
3. Keep the state-backend payload separate. It contains exactly
   `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` for the state identity.
4. Keep the deploy-only registry payload separate. It contains exactly
   `GHCR_USERNAME` and `GHCR_TOKEN` for a read-only package principal. Only the
   deployment-controller identity may read this container; the app VM identity
   must not. The GitHub-hosted deployment passes only that validated two-entry
   envelope through the authenticated deployment SSH channel to the root helper.
5. Keep `YC_APP_DEPLOY_SSH_PRIVATE_KEY` only as an environment secret in
   `production-deploy`; keep the matching `YC_APP_DEPLOY_SSH_PUBLIC_KEY` only as
   a non-secret variable in `production-infrastructure`. Compare their public
   `ssh-keygen -lf` fingerprint with the encrypted offline recovery record. The
   retained runner-registration Lockbox container is an inventory tombstone: it
   must have no current version or payload and no IAM reader.
6. Record entry names, Lockbox container IDs, access binding review IDs, and
   rotation due dates in the protected operational system. Record no values.

## Load runtime payloads through a protected input channel

<!-- runbook-contract:secrets-runtime-payload -->

1. Disable terminal recording and shell tracing. Set `umask 077`.
2. Use the approved Lockbox console or broker to read each value from standard
   input or a protected descriptor. For a protected file, create it on approved
   encrypted storage at mode `0600`, pass its descriptor to the broker, then
   remove that exact file after a successful write.
3. Populate the runtime Lockbox with every and only the keys from
   `.env.production.example`. Preserve single-line values. Do not make a local
   `.env` file, a Terraform variable, or a workflow input from the payload.
4. Populate S3 credentials only in the runtime payload and keep media, audit,
   and state credentials isolated. The shared media bucket remains private;
   controlled application access, not public object URLs, serves avatars and
   future product images.
5. Populate SMTP credentials directly in the runtime payload. Send no test
   mail until the first go-live gate authorizes it.
6. Populate the separate deploy-only registry container with exactly these
   GHCR credentials:
   `GHCR_USERNAME` and `GHCR_TOKEN`. The GitHub-hosted deployment retrieves the latest
   version at each deployment and sends only the validated two-entry envelope
   over the strict-host-key-checked SSH standard input. The app's root helper
   authenticates with `--password-stdin` under a root-owned transient
   `DOCKER_CONFIG`, then logs out and removes the directory on both success and
   failure. Never add these keys to `.env.production.example` or
   `/etc/markiro/production.env`.

## Verify names, modes, and runtime health without reading values

<!-- runbook-contract:secrets-mode-verification -->

1. Before the first deployment, verify Lockbox contains the expected key names
   once, with no unknown, duplicate, blank, or multiline entry. Do not display
   values.
2. Verify the installed root-owned materializer assets and unit, restart the
   enabled oneshot unit, and compare only generated environment key names with
   the installed inventory. The generated `/etc/markiro/production.env` must be
   a regular root-owned file at mode `0600`; its parent directory must be a
   root-owned directory at mode `0700`.

```bash
set -euo pipefail
umask 077

test "$(stat -c '%U:%G:%a' /usr/local/lib/markiro/runtime-env.mjs)" = root:root:700
test "$(stat -c '%U:%G:%a' /usr/local/lib/markiro/.env.production.example)" = root:root:644
test "$(stat -c '%U:%G:%a' /etc/systemd/system/markiro-runtime-env.service)" = root:root:644
test "$(stat -c '%U:%G:%a' /etc/markiro)" = root:root:700
test "$(stat -c '%U:%G:%a' /etc/markiro/runtime-secret-id)" = root:root:600

systemctl is-enabled --quiet markiro-runtime-env.service
systemctl restart markiro-runtime-env.service
test "$(systemctl show --property=Result --value markiro-runtime-env.service)" = success
test -f /etc/markiro/production.env
test ! -L /etc/markiro/production.env
test "$(stat -c '%U:%G:%a' /etc/markiro/production.env)" = root:root:600

node - /usr/local/lib/markiro/.env.production.example /etc/markiro/production.env <<'NODE'
const { readFileSync } = require("node:fs");

function keys(path, inventory) {
  const names = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line === "" || line.startsWith("#")) continue;
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!match || (inventory && match[2] !== "")) {
      throw new Error("runtime environment inventory is invalid");
    }
    names.push(match[1]);
  }
  if (new Set(names).size !== names.length) {
    throw new Error("runtime environment inventory is invalid");
  }
  return names.sort();
}

const expected = keys(process.argv[2], true);
const actual = keys(process.argv[3], false);
if (JSON.stringify(actual) !== JSON.stringify(expected)) {
  throw new Error("runtime environment inventory is invalid");
}
console.log("exact generated environment inventory verified");
NODE

readiness_result="$(mktemp)"
trap 'rm -f "$readiness_result"' EXIT
if /usr/bin/node /usr/local/lib/markiro/readiness-observer.mjs > "$readiness_result"; then
  readiness_status=0
else
  readiness_status=$?
fi
test "$readiness_status" = 1
test "$(cat "$readiness_result")" = required_unavailable
```

3. The `required_unavailable` sanitized readiness state is expected before the
   first candidate exists; it proves that the observer fails closed without
   disclosing a response body. Do not treat it as candidate health evidence.
   The deployment workflow's candidate-bound production preflight after bundle
   transfer is the authority for the first release's exact Compose model and
   non-secret release inputs. Do not run a release preflight from this pre-first
   procedure.
4. Verify no registry `DOCKER_CONFIG` remains after deployment and that the app
   identity cannot read the registry container. Verify the hosted job removes
   its temporary mode-`0600` SSH key and context files on both success and
   failure. Confirm the runner-registration tombstone still has no version,
   payload, or reader. Record only sanitized evidence IDs in the protected
   system.

## Verify the active path only after first activation

<!-- runbook-contract:secrets-post-activation-verification -->

1. Run this check only after the protected workflow has produced authenticated
   evidence for a successful finalized first deployment. Obtain the exact
   successful first-release SHA from that evidence; do not infer it from a
   mutable tag.
2. Verify the live symlink resolves to that immutable transferred directory.
   This is an identity check, not a second manual preflight.

```bash
set -euo pipefail
read -r -p 'Successful finalized first-release 40-character SHA: ' SUCCESSFUL_FIRST_RELEASE_SHA
[[ "$SUCCESSFUL_FIRST_RELEASE_SHA" =~ ^[0-9a-f]{40}$ ]]
expected_release="/opt/markiro/releases/$SUCCESSFUL_FIRST_RELEASE_SHA"
active_release="$(readlink -e /opt/markiro/active-release)"
test "$active_release" = "$expected_release"
test -f "$active_release/compose.production.yml"
test -f "$active_release/deploy/production/preflight.mjs"
```

3. Use `/opt/markiro/active-release` only for post-activation operator checks.
   Candidate-bound preflight remains the workflow authority after every
   immutable bundle transfer.

## Rotate a secret without logging it

<!-- runbook-contract:secrets-rotation -->

1. Open an approved rotation record and identify every consumer before changing
   a value. Schedule a rollback window for values that cannot overlap.
2. Write the replacement through standard input or a protected descriptor.
   Confirm the new Lockbox version and entry name without reading the value.
3. Restart or redeploy only the affected bounded consumer. Verify readiness and
   one authorized operation using sanitized evidence.
4. Revoke the previous credential only after the new consumer succeeds. Rotate
   PostgreSQL access before retiring the prior database role; rotate state HMAC
   only through a separately reviewed backend migration procedure.
5. For `YC_APP_DEPLOY_SSH_PRIVATE_KEY`, first generate a new Ed25519 pair in a
   protected child shell. Compare `ssh-keygen -lf` fingerprints, update
   `YC_APP_DEPLOY_SSH_PUBLIC_KEY`, apply the reviewed app-VM replacement while
   DNS remains false, and only then update `YC_APP_DEPLOY_SSH_PRIVATE_KEY`.
   Complete one approved deployment before revoking and deleting the old key;
   preserve the new encrypted offline recovery copy.
6. For `GHCR_TOKEN`, upload the new read-only token as a new registry Lockbox
   version, run one digest deployment, verify logout and transient-directory
   cleanup, then revoke the prior token.
7. Record rotation and verification evidence IDs only in the protected
   operational system. Remove temporary protected files, unset process values,
   and close descriptors before closing the change.
