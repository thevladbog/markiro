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
   deployment-runner VM identity may read this container; the app VM identity
   must not. The runner passes only that validated two-entry envelope through
   the authenticated deployment SSH channel to the root helper.
5. Keep the runner-registration payload separate. It contains exactly
   `GITHUB_RUNNER_ADMIN_TOKEN`. Prefer a GitHub App installation token; use a
   repository-scoped fine-grained PAT only as the documented fallback. Never
   put it in a GitHub repository or environment secret. Only the protected
   controller identity may read it; the runner VM identity must not.
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
   `GHCR_USERNAME` and `GHCR_TOKEN`. The deployment runner retrieves the latest
   version at each deployment and sends only the validated two-entry envelope
   over the strict-host-key-checked SSH standard input. The app's root helper
   authenticates with `--password-stdin` under a root-owned transient
   `DOCKER_CONFIG`, then logs out and removes the directory on both success and
   failure. Never add these keys to `.env.production.example` or
   `/etc/markiro/production.env`.

## Verify names, modes, and runtime health without reading values

<!-- runbook-contract:secrets-mode-verification -->

1. Verify Lockbox contains the expected key names once, with no unknown,
   duplicate, blank, or multiline entry. Do not display values.
2. Verify the app can materialize `/etc/markiro/production.env` at mode `0600`
   and its parent directory at mode `0700`. Verify no registry `DOCKER_CONFIG`
   remains after deployment and that the app identity cannot read the registry
   container. Verify the runner receives only the bounded encoded JIT
   configuration and deletes its metadata key before the runner process starts;
   it must not be able to read the registration container.
3. Run the supported production preflight, which validates Compose quietly and
   does not render secret-expanded configuration.

```bash
set -euo pipefail
umask 077
cd /opt/markiro/active-release
node deploy/production/preflight.mjs
docker compose --project-name markiro-production --env-file /etc/markiro/production.env -f compose.production.yml -f deploy/production/compose.yandex.yml config --quiet
```

4. Check the sanitized readiness state. Treat a missing mandatory dependency as
   a stop. Record the health evidence ID only in the protected system.

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
5. For `GITHUB_RUNNER_ADMIN_TOKEN`, rotate the GitHub App token or fallback PAT
   in Lockbox, verify the controller generates one JIT configuration and the VM
   deletes it before startup, then revoke the previous token. The runner is
   normally stopped outside that window.
6. For `GHCR_TOKEN`, upload the new read-only token as a new registry Lockbox
   version, run one digest deployment, verify logout and transient-directory
   cleanup, then revoke the prior token.
7. Record rotation and verification evidence IDs only in the protected
   operational system. Remove temporary protected files, unset process values,
   and close descriptors before closing the change.
