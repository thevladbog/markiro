# v-b.tech Private Web Executor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a protected Markiro-owned executor that can deploy one attested immutable v-b.tech static image on the existing production VM, keep contact submission disabled, preserve the v-b selector across ordinary Markiro releases, and report sanitized capacity evidence without changing DNS, cloud resources, databases, or the Markiro API lifecycle.

**Architecture:** Store the independent v-b lifecycle in append-only records under `/var/lib/markiro/vbtech/releases`, represent the image everywhere by an exact OCI digest reference, and let the v-b executor mutate only `vbtech-web` and the shared `edge`. A separate hosted wrapper uses the existing production SSH trust boundary, while ordinary Markiro deployment reads the latest valid healthy v-b selector and carries it forward. Runtime diagnostics advance to a strict version 3 schema with resource, network, and `vbtech-web` evidence.

**Tech Stack:** Node.js 24 ESM, Docker Compose, Caddy, GitHub Actions, `gh attestation verify`, OpenSSH, systemd transient units, Node test runner, `js-yaml`, Prettier.

**Spec:** `docs/superpowers/specs/2026-08-21-vbtech-private-web-executor-design.md`

## Fixed contracts for all tasks

Use these names and shapes consistently; do not retain a second tag-based v-b contract in parallel.

```js
const vbtechRepository = "ghcr.io/thevladbog/vbtech-web";

// Selector embedded in a Markiro release record and Compose environment.
{
  imageRef: "ghcr.io/thevladbog/vbtech-web@sha256:<64 lowercase hex>",
  imageDigest: "sha256:<64 lowercase hex>",
  releaseSha: "<40 lowercase hex>",
  functionPath: "",             // empty only while submissionState is disabled
  submissionState: "disabled"
}

// Append-only private v-b lifecycle record.
{
  releaseSha: "<40 lowercase hex>",
  imageRef: "ghcr.io/thevladbog/vbtech-web@sha256:<64 lowercase hex>",
  imageDigest: "sha256:<64 lowercase hex>",
  submissionState: "disabled",
  createdAt: "<canonical ISO timestamp>",
  state: "pending" | "healthy" | "failed"
}
```

The runtime environment keys are `VBTECH_IMAGE_REF`, `VBTECH_RELEASE_SHA`, `VBTECH_FUNCTION_PATH`, and `VBTECH_SUBMISSION_STATE`. `VBTECH_IMAGE_TAG` is removed. An enabled v-b configuration still requires an exact Yandex Cloud Functions path; this plan never creates or deploys such a configuration.

## Task 1: Convert the v-b Compose and preflight contract to immutable digest references

**Files:**

- Modify: `deploy/production/compose.vbtech.yml`
- Modify: `deploy/production/compose-files.mjs`
- Modify: `deploy/production/preflight.mjs`
- Modify: `deploy/production/test/compose-contract.test.mjs`
- Modify: `deploy/production/test/preflight.test.mjs`

- [ ] **Step 1: Write failing Compose contract assertions**

Replace test fixtures using `VBTECH_IMAGE_TAG` with an exact reference such as:

```js
const vbtechDigest = `sha256:${"d".repeat(64)}`;
const vbtechImageRef = `ghcr.io/thevladbog/vbtech-web@${vbtechDigest}`;
```

Assert that `vbtech-web.image` is `${VBTECH_IMAGE_REF:?VBTECH_IMAGE_REF is required}`, that the overlay is selected only when `VBTECH_IMAGE_REF` is present, and that disabled edge configuration accepts `VBTECH_FUNCTION_PATH: ""`.

- [ ] **Step 2: Write failing preflight tests for the exact boundary**

Cover all of these cases:

- exact digest reference plus matching `VBTECH_RELEASE_SHA` parses;
- disabled state parses when `VBTECH_FUNCTION_ORIGIN` is absent and emits `VBTECH_FUNCTION_PATH: ""`;
- enabled state still requires `https://functions.yandexcloud.net/<id>`;
- a tag, `latest`, an uppercase digest, a foreign repository, digest-only value, mismatched explicit digest, partial overlay, or unknown state is rejected;
- `validatedEnvironment` contains `VBTECH_IMAGE_REF` and does not contain `VBTECH_IMAGE_TAG`.

Run the RED gate:

```bash
node --test deploy/production/test/preflight.test.mjs deploy/production/test/compose-contract.test.mjs
```

Expected: failures because the implementation still accepts the SHA tag contract and always requires a function origin.

- [ ] **Step 3: Implement one strict parser**

Use these validations in `parseVbtechConfig`:

```js
const VBTECH_IMAGE_PATTERN = /^ghcr\.io\/thevladbog\/vbtech-web@(sha256:[0-9a-f]{64})$/;
const RELEASE_SHA_PATTERN = /^[0-9a-f]{40}$/;
```

Return `imageRef`, `imageDigest`, `releaseSha`, domains, `functionPath`, and `submissionState`. Require the explicit release SHA because an OCI digest cannot derive the source SHA. Parse a function origin only for `enabled`; for `disabled`, reject a supplied malformed origin but permit absence and return an empty path. Keep `composeQuiet` child environment allowlisted.

- [ ] **Step 4: Rename the Compose selector atomically**

Change the overlay image expression to `VBTECH_IMAGE_REF`; update `productionComposeFiles` and every Task 1 fixture. Do not add a host port or weaken the existing container hardening.

- [ ] **Step 5: Run the GREEN gate**

```bash
node --test deploy/production/test/preflight.test.mjs deploy/production/test/compose-contract.test.mjs
```

Expected: all selected tests pass.

- [ ] **Step 6: Commit the contract conversion**

```bash
git add deploy/production/compose.vbtech.yml deploy/production/compose-files.mjs deploy/production/preflight.mjs deploy/production/test/compose-contract.test.mjs deploy/production/test/preflight.test.mjs
git commit -m "refactor: bind v-b runtime to image digest"
```

## Task 2: Add strict append-only v-b release state

**Files:**

- Create: `deploy/production/vbtech-release-state.mjs`
- Create: `deploy/production/test/vbtech-release-state.test.mjs`

- [ ] **Step 1: Write state-validation and selection tests**

Test exported functions with temporary directories and injected time/UUID dependencies:

```js
validateVbtechSelector(value);
latestHealthyVbtechRelease(directory);
writePendingVbtechRelease(directory, selector, supplied);
markVbtechReleaseHealthy(directory, pending, supplied);
markVbtechReleaseFailed(directory, pending, supplied);
```

Required cases:

- exact keys and exact repository/digest relationship are accepted;
- additional keys, uppercase values, mutable tags, invalid ISO dates, enabled state, non-empty function paths in a disabled selector, and permissive file modes are rejected;
- records are created with directory mode `0700` and file mode `0600`;
- writes use exclusive temporary files, file sync, hard-link publication, directory sync, and bounded JSON;
- the newest effective healthy record is selected deterministically;
- a matching failed terminal record excludes its candidate from active selection;
- a repeated healthy SHA plus digest is rejected before a pending write;
- malformed `.json`, two different effective healthy records with the same newest timestamp, duplicate terminal transitions, or an unreadable record fail closed;
- absence of the state directory returns `undefined`.

Run the RED gate:

```bash
node --test deploy/production/test/vbtech-release-state.test.mjs
```

Expected: module-not-found failure.

- [ ] **Step 2: Implement bounded record parsing and exact filenames**

Use a filename derived only from validated values:

```js
`${createdAt.replace(/[:.]/g, "-")}-${releaseSha}-${imageDigest.slice(7)}.${state}.json`;
```

Limit each read to 16 KiB by checking `stat.size` before `readFile`. Treat every `.json` file as authoritative state input: malformed content, a mismatched filename, wrong permissions, or an invalid transition is an error, not a skippable record. Ignore only non-JSON temporary names.

- [ ] **Step 3: Implement immutable transitions**

`writePendingVbtechRelease` owns timestamp creation and rejects an already-effective identical release. Healthy/failed transitions must exactly match the pending identity and `createdAt`, publish a new immutable file, and never overwrite or rename a prior terminal file. Keep error messages stable and free of record contents.

- [ ] **Step 4: Run the GREEN gate and format**

```bash
node --test deploy/production/test/vbtech-release-state.test.mjs
pnpm exec prettier --write deploy/production/vbtech-release-state.mjs deploy/production/test/vbtech-release-state.test.mjs
```

Expected: all state tests pass and formatting is unchanged on a second check.

- [ ] **Step 5: Commit the state layer**

```bash
git add deploy/production/vbtech-release-state.mjs deploy/production/test/vbtech-release-state.test.mjs
git commit -m "feat: add independent v-b release state"
```

## Task 3: Preserve the active v-b selector across ordinary Markiro releases

**Files:**

- Modify: `deploy/production/deploy.mjs`
- Modify: `deploy/production/test/deploy.test.mjs`
- Modify: `deploy/production/test/staged-deploy.test.mjs`

- [ ] **Step 1: Write preservation tests before changing deployment code**

Add cases proving that:

- `prepareRelease` with a valid healthy v-b state injects its selector into preflight, the Compose environment, the Markiro candidate record, `vbtech-web`, edge startup, and smoke options;
- a Markiro deployment with no v-b state remains Markiro-only;
- a malformed or ambiguous state stops before pull, migration, service, edge, or release-record mutation;
- caller environment cannot silently replace or remove the state-owned selector;
- rollback of a failing Markiro candidate restores the previous Markiro record with its exact v-b selector;
- Markiro release records accept the new exact selector keys and reject tag-based or partial legacy shapes.

Run the RED gate:

```bash
node --test deploy/production/test/deploy.test.mjs deploy/production/test/staged-deploy.test.mjs
```

Expected: preservation assertions fail because `prepareRelease` only uses preflight input and the old `imageTag` record shape.

- [ ] **Step 2: Centralize the selector shape**

Import `latestHealthyVbtechRelease` and `validateVbtechSelector` from the state module. Update `isVbtechRelease`, `vbtechReleaseFromPreflight`, `environmentWithVbtech`, record validation, equality, pull, inspect, and smoke plumbing to use `imageRef` plus `imageDigest`. The exact selector key set in a Markiro record is:

```text
functionPath,imageDigest,imageRef,releaseSha,submissionState
```

- [ ] **Step 3: Make remote state authoritative in `prepareRelease`**

Extend options with `vbtechReleaseDirectory`. Before any mutation:

```js
const preserved = options.vbtechReleaseDirectory
  ? await dependencies.latestHealthyVbtechRelease(options.vbtechReleaseDirectory)
  : undefined;
const effectiveEnvironment = environmentWithVbtech(options.environment, preserved);
```

For the CLI `prepare` mode, default the directory to `/var/lib/markiro/vbtech/releases`. Unit callers may omit it to preserve focused fixtures. Reject simultaneous caller-supplied v-b variables that do not exactly equal the preserved selector.

- [ ] **Step 4: Pull and verify the digest reference**

Replace the RepoTags check with the existing RepoDigests validation pattern. Pull `vbtech.imageRef`, inspect `.RepoDigests`, and require the exact reference. Do not resolve or persist a mutable tag.

- [ ] **Step 5: Run the GREEN and adjacent gates**

```bash
node --test deploy/production/test/deploy.test.mjs deploy/production/test/staged-deploy.test.mjs deploy/production/test/preflight.test.mjs deploy/production/test/compose-contract.test.mjs
```

Expected: all selected deployment tests pass.

- [ ] **Step 6: Commit preservation**

```bash
git add deploy/production/deploy.mjs deploy/production/test/deploy.test.mjs deploy/production/test/staged-deploy.test.mjs
git commit -m "feat: preserve v-b across Markiro releases"
```

## Task 4: Reuse the public smoke assertions through a private authority-aware transport

**Files:**

- Create: `deploy/production/vbtech-private-smoke.mjs`
- Create: `deploy/production/test/vbtech-private-smoke.test.mjs`
- Modify: `deploy/production/smoke.mjs`
- Modify: `deploy/production/test/smoke-route-table.test.mjs`

- [ ] **Step 1: Write private transport tests**

Define this public interface:

```js
export function privateVbtechRequestClient({
  transportOrigin,
  apexAuthority,
  wwwAuthority,
  request,
}) {}
export async function runPrivateVbtechSmoke(
  { transportOrigin, expectedVbtechReleaseSha },
  client,
) {}
```

Test that a logical request to `https://v-b.tech/legal/` is transported to the exact approved Markiro HTTPS origin while preserving the path and setting `Host: v-b.tech`; a logical `www` request must set `Host: www.v-b.tech`. The TLS URL must remain the Markiro authority so SNI and certificate validation cannot be disabled or replaced by an IP-only insecure request.

Also prove:

- every existing `VBTECH_ROUTE_CHECKS` entry is exercised;
- disabled `POST /api/contact` expects the current 404 contract;
- canonical `www` redirect is checked at the authority layer;
- redirects are manual;
- response bodies are consumed only by existing assertions and are not logged;
- invalid transport origins, credentials, paths, ports, or authorities fail before network activity;
- the result labels evidence as private routing/content only, never public DNS or v-b TLS acceptance.

Run the RED gate:

```bash
node --test deploy/production/test/vbtech-private-smoke.test.mjs deploy/production/test/smoke-route-table.test.mjs
```

Expected: module-not-found or missing-client behavior.

- [ ] **Step 2: Make the existing request-client seam explicit**

Export only the minimum helper needed from `smoke.mjs`, or keep `runVbtechSmoke` as the sole assertion engine and inject a compatible `{ request(url, init) }` client. Do not duplicate `VBTECH_ROUTE_CHECKS`, header assertions, CSP, content identity, or contact-state logic.

- [ ] **Step 3: Implement the authority adapter**

Map logical URLs by exact origin equality, copy safe request options, replace only the transport URL and `Host` header, and use the normal certificate-verifying Node client. Reject any caller-provided conflicting `Host`. Do not set `rejectUnauthorized: false`, `--insecure`, custom CA bypasses, or public resolver overrides.

- [ ] **Step 4: Run the GREEN gate**

```bash
node --test deploy/production/test/vbtech-private-smoke.test.mjs deploy/production/test/smoke-route-table.test.mjs
```

Expected: all private and public smoke tests pass.

- [ ] **Step 5: Commit private smoke support**

```bash
git add deploy/production/vbtech-private-smoke.mjs deploy/production/test/vbtech-private-smoke.test.mjs deploy/production/smoke.mjs deploy/production/test/smoke-route-table.test.mjs
git commit -m "feat: add private v-b routing smoke"
```

## Task 5: Implement the VM-local v-b lifecycle and rollback executor

**Files:**

- Create: `deploy/production/vbtech-deploy.mjs`
- Create: `deploy/production/test/vbtech-deploy.test.mjs`

- [ ] **Step 1: Write a dependency-injected lifecycle fixture**

The module exports:

```js
export const VBTECH_EXECUTOR_CONTRACT_VERSION = 1;
export async function deployVbtechRelease(options, supplied = {}) {}
export async function runVbtechDeployCli(options = {}) {}
```

The fixture records commands, state writes, service health probes, smoke calls, and rollback events without Docker. Tests must prove the exact successful order:

```text
validate -> read-active-markiro -> read-vbtech-state -> pending -> pull -> inspect-digest
-> up-vbtech-web -> health-vbtech-web -> recreate-edge -> private-smoke -> healthy
```

- [ ] **Step 2: Write failure and ownership tests**

Cover each bounded stage and assert:

- invalid SHA, digest, image reference, state, domains, project name, active-release symlink, active Markiro record, or Compose network fails before mutation;
- only project `markiro-production` and services `vbtech-web` and `edge` appear in mutating commands;
- no `migrate`, `api`, database, DNS, Yandex CLI, Terraform, function, or generic shell command is allowed;
- first-install failure removes the failed v-b service and recreates the Markiro-only edge;
- replacement failure restores the previous exact selector, recreates edge, and runs the same private smoke against the restored SHA;
- an error after edge activation still rolls back;
- rollback failure preserves both stable stage labels without environment values or raw command output;
- candidate becomes healthy only after smoke;
- every command has a finite timeout and captured output is bounded;
- `contract-version` prints exactly `MARKIRO_VBTECH_EXECUTOR 1` and performs no mutation.

Run the RED gate:

```bash
node --test deploy/production/test/vbtech-deploy.test.mjs
```

Expected: module-not-found failure.

- [ ] **Step 3: Validate the active Markiro ownership boundary**

Resolve `/opt/markiro/active-release`, require an absolute target whose basename is a lowercase 40-character SHA, load exactly one matching healthy Markiro release from `/var/lib/markiro/releases`, and verify its API and edge RepoDigests before composing. Require the labeled Compose network to resolve to exactly one safe name and never accept a caller-supplied project name.

- [ ] **Step 4: Implement candidate activation**

Build the environment from the active Markiro record, fixed public domains, `/etc/markiro/production.env`, and the candidate selector. Run:

```text
docker compose <base files> pull vbtech-web
docker image inspect --format {{json .RepoDigests}} <exact image ref>
docker compose <base files> up -d --no-deps vbtech-web
docker inspect --format {{json .State.Health}} <the one validated vbtech-web container ID>
docker compose <base files> up -d --no-deps --force-recreate edge
```

Poll the image-provided health check until it reports `healthy`, with the configured service deadline and interval; reject missing, malformed, or `unhealthy` state. Use the repository's committed base Compose path discovered through `productionComposeArgs`; do not invent an external Compose file. The edge environment must retain the active Markiro digests and add only the candidate v-b selector.

- [ ] **Step 5: Implement compensating rollback**

Track whether service and edge activation occurred. On failure, select only the previously effective healthy v-b record captured before the pending write. Restore that exact selector or remove `vbtech-web` for the first deployment, then recreate edge with the prior model and run bounded readiness plus private smoke when a previous v-b existed. Mark the candidate failed after rollback attempts, without invalidating the prior healthy record.

- [ ] **Step 6: Run the GREEN and ownership gates**

```bash
node --test deploy/production/test/vbtech-deploy.test.mjs deploy/production/test/vbtech-release-state.test.mjs deploy/production/test/vbtech-private-smoke.test.mjs
```

Expected: all lifecycle, state, and smoke tests pass.

- [ ] **Step 7: Commit the local executor**

```bash
git add deploy/production/vbtech-deploy.mjs deploy/production/test/vbtech-deploy.test.mjs
git commit -m "feat: add private v-b deployment executor"
```

## Task 6: Add the hosted SSH wrapper without duplicating production credentials

**Files:**

- Create: `deploy/yandex/remote-vbtech-deploy.mjs`
- Create: `deploy/yandex/test/remote-vbtech-deploy.test.mjs`
- Modify: `deploy/yandex/remote-deploy.mjs`
- Modify: `deploy/yandex/test/remote-deploy.test.mjs`

- [ ] **Step 1: Write wrapper contract tests**

Reuse these exported helpers from `remote-deploy.mjs`:

```js
authenticatedKnownHosts;
publicIpv4;
runCommand;
validateHostedPrivateKey;
```

Test exact allowlisted environment input, private-key mode validation, authenticated known-host creation, temporary directory cleanup, fixed login `markiro-deploy`, batch SSH options, no agent forwarding, no host-key bypass, and bounded error messages.

The remote sequence must:

1. run `/opt/markiro/active-release/deploy/production/vbtech-deploy.mjs contract-version` and require `MARKIRO_VBTECH_EXECUTOR 1`;
2. run the same active-release entrypoint in a fresh `systemd-run` unit;
3. pass only the candidate SHA, digest, exact image ref, disabled state, fixed domains, and the existing production runtime ordering as allowlisted environment values;
4. pass registry credentials through the existing bounded `registry-auth.mjs run-stdin` JSON channel, never an argument or printed environment value;
5. collect no remote environment dump and print only stable stage output.

Run the RED gate:

```bash
node --test deploy/yandex/test/remote-vbtech-deploy.test.mjs deploy/yandex/test/remote-deploy.test.mjs
```

Expected: new module missing and/or helper exports missing.

- [ ] **Step 2: Extract only safe shared SSH helpers**

Export the already-tested helpers without changing their behavior. Do not share the whole Markiro release-transfer orchestration and do not copy private-key validation or known-host parsing.

- [ ] **Step 3: Implement the hosted wrapper**

Define:

```js
export async function runHostedVbtechDeploy(environment = process.env, supplied = {}) {}
export async function runRemoteVbtechDeployCli(options = {}) {}
```

Construct `VBTECH_IMAGE_REF` from the independently validated repository constant and `VBTECH_IMAGE_DIGEST`; reject a supplied conflicting reference. The active executor bootstrap check must fail closed with an operator-facing message that an executor-bearing Markiro release must be deployed first.

- [ ] **Step 4: Run the GREEN gate**

```bash
node --test deploy/yandex/test/remote-vbtech-deploy.test.mjs deploy/yandex/test/remote-deploy.test.mjs
```

Expected: all hosted wrapper and existing remote-deploy tests pass.

- [ ] **Step 5: Commit the hosted wrapper**

```bash
git add deploy/yandex/remote-vbtech-deploy.mjs deploy/yandex/test/remote-vbtech-deploy.test.mjs deploy/yandex/remote-deploy.mjs deploy/yandex/test/remote-deploy.test.mjs
git commit -m "feat: add hosted v-b deployment wrapper"
```

## Task 7: Upgrade sanitized runtime diagnostics to version 3

**Files:**

- Modify: `deploy/yandex/runtime-diagnostics-probe.mjs`
- Modify: `deploy/yandex/runtime-diagnostics.mjs`
- Modify: `deploy/yandex/test/runtime-diagnostics.test.mjs`

- [ ] **Step 1: Write the version 3 schema tests**

The exact top-level result is:

```js
{
  version: 3,
  docker,
  runtimeEnv,
  activeRelease,
  candidateRelease,
  composeNetwork,
  resources: {
    cpuBusyBasisPoints,
    memoryTotalBytes,
    memoryAvailableBytes,
    rootFilesystemTotalBytes,
    rootFilesystemAvailableBytes
  },
  activeVbtech: { releaseSha, imageDigest } | null,
  api,
  edge,
  vbtechWeb
}
```

Add fixtures for two CPU samples, memory, root filesystem, network listing, v-b state, and three services. Assert integer/range relationships: CPU `0..10000`, totals positive, available `0..total`, and safe integer byte counts.

- [ ] **Step 2: Add fail-closed diagnostic cases**

Prove that validation rejects version 2, extra/missing keys, unsafe or multiple Compose network names, invalid resource bounds, invalid v-b digest/SHA, non-allowlisted service identities, and malformed v-b state. Keep the remote response parser strict.

For classification, test that edge `ECONNREFUSED` yields `upstream_connectivity`, while API PostgreSQL evidence still yields `database_connection`. Add `upstream_connectivity` to the frozen ordered error-class inventory.

Run the RED gate:

```bash
node --test deploy/yandex/test/runtime-diagnostics.test.mjs
```

Expected: version and schema assertions fail.

- [ ] **Step 3: Add sanitized resource collectors to the standalone probe**

Because the probe source is streamed over SSH, keep it self-contained. Add injected defaults with stable names:

```js
sampleCpu;
readMemory;
readRootFilesystem;
sleep;
```

Use `node:os` CPU counters for two samples separated by a fixed short interval, `os.totalmem()`/`os.freemem()`, and `statfs("/")`. Convert to safe integer bytes and emit no process lists, IPs, mount inventory, or arguments.

- [ ] **Step 4: Validate the Compose network and v-b service**

Query Docker networks only by `com.docker.compose.project=markiro-production`, require exactly one validated name, and inspect `vbtech-web` through the same service-label allowlist as API/edge. Extend digest parsing so `vbtech-web` accepts only `ghcr.io/thevladbog/vbtech-web@sha256:<64 hex>` and maps release identity from strict private v-b state.

- [ ] **Step 5: Make error classification service-aware**

Change the internal signature to `classifyEvidence(service, logs, state)`. For `edge`, connection-refused/name-resolution/upstream dial evidence becomes `upstream_connectivity`; database-specific phrases remain `database_connection` only for API. Preserve ordering and all existing configuration, schema, resource, health, and crash rules.

- [ ] **Step 6: Run the GREEN diagnostic gates**

```bash
node --test deploy/yandex/test/runtime-diagnostics.test.mjs
pnpm test:yandex-runtime
```

Expected: all diagnostic and Yandex runtime tests pass.

- [ ] **Step 7: Commit diagnostic version 3**

```bash
git add deploy/yandex/runtime-diagnostics-probe.mjs deploy/yandex/runtime-diagnostics.mjs deploy/yandex/test/runtime-diagnostics.test.mjs
git commit -m "feat: add v-b capacity diagnostics"
```

## Task 8: Add the protected manual GitHub Actions executor

**Files:**

- Create: `.github/workflows/deploy-vbtech-production.yml`
- Modify: `deploy/production/test/workflow-contract.test.mjs`
- Modify: `deploy/yandex/test/hosted-deploy-workflow.test.mjs`

- [ ] **Step 1: Write the workflow contract test first**

Parse the new workflow and assert:

- only `workflow_dispatch` exists;
- the exact inputs, in order, are `vbtech_release_sha`, `vbtech_image_digest`, and `confirm_private_deploy`;
- confirmation is required boolean and is actually consumed by a job condition or a preflight rejection;
- top-level permissions are empty; job permissions are exactly `attestations: read`, `contents: read`, and `packages: read`;
- environment is `production-deploy`;
- concurrency is `markiro-production-deployment` with cancellation disabled;
- timeout is finite;
- checkout and all other actions are pinned to full commit SHAs;
- image repository and signer workflow are hard-coded, not dispatch inputs;
- submission state is hard-coded disabled;
- SHA and digest are lowercase and exact;
- attestation verification binds repository, signer workflow, source digest, source ref `refs/heads/main`, and the exact OCI subject;
- the hosted wrapper runs only after verification;
- no DNS, Yandex CLI, Terraform, PostgreSQL, function, VPC, Lockbox, bucket, service-account, or external form command appears.

Run the RED gate:

```bash
node --test deploy/production/test/workflow-contract.test.mjs deploy/yandex/test/hosted-deploy-workflow.test.mjs
```

Expected: workflow-not-found assertions fail.

- [ ] **Step 2: Implement pre-SSH verification**

Use an exact image subject:

```bash
image_ref="ghcr.io/thevladbog/vbtech-web@$VBTECH_IMAGE_DIGEST"
gh attestation verify "oci://$image_ref" \
  --repo thevladbog/v-b \
  --signer-workflow thevladbog/v-b/.github/workflows/publish.yml \
  --source-digest "$VBTECH_RELEASE_SHA" \
  --source-ref refs/heads/main
docker manifest inspect "$image_ref" > /dev/null
```

Validate `confirm_private_deploy == true`, the 40-character SHA, and the `sha256:` digest before creating the SSH key file. Do not echo the attestation payload or credentials.

- [ ] **Step 3: Add before/deploy/after diagnostic steps**

Call the existing hosted diagnostic CLI before and after `remote-vbtech-deploy.mjs run`. Validate both as version 3. Emit one bounded JSON capacity delta containing only CPU basis-point delta and available memory/root-disk byte deltas plus release identities. Do not encode a resize threshold or an automatic capacity decision.

- [ ] **Step 4: Add credential cleanup and bootstrap failure behavior**

Use the existing environment SSH secret and known-host variable. Ensure cleanup runs under `if: always()`. The workflow must surface the fixed contract-version failure when the active Markiro release predates this executor; it must not transfer unchecked workflow code to bypass bootstrap.

- [ ] **Step 5: Run the GREEN workflow gates**

```bash
node --test deploy/production/test/workflow-contract.test.mjs deploy/yandex/test/hosted-deploy-workflow.test.mjs
```

Expected: all workflow contracts pass.

- [ ] **Step 6: Commit the workflow**

```bash
git add .github/workflows/deploy-vbtech-production.yml deploy/production/test/workflow-contract.test.mjs deploy/yandex/test/hosted-deploy-workflow.test.mjs
git commit -m "ci: add protected v-b private deploy"
```

## Task 9: Document bootstrap, evidence, rollback, and approval boundaries

**Files:**

- Modify: `docs/runbooks/saas-production-deploy.md`
- Modify: `deploy/production/test/runbook-contract.test.mjs`

- [ ] **Step 1: Write runbook contract assertions**

Require the runbook to state all of the following literally enough for stable matching:

- an executor-bearing Markiro release must already be the active validated release;
- deploying that Markiro release is a separate protected production approval;
- the v-b workflow requires the exact source SHA and OCI digest;
- before and after diagnostics must both be version 3;
- submission remains disabled and no function origin is needed;
- the operation owns only `vbtech-web`, shared edge recreation, and private v-b records;
- it excludes API/migrations, database, IAM, Lockbox, buckets, VPC, DNS, TLS issuance, public exposure, and form activation;
- private smoke proves routing/content, not public DNS or v-b TLS;
- first-install and replacement rollback procedures are distinct;
- a live dispatch requires a new approval naming the exact SHA and digest.

Run the RED gate:

```bash
node --test deploy/production/test/runbook-contract.test.mjs
```

Expected: new contractual phrases are absent.

- [ ] **Step 2: Add the operator sequence**

Document these phases in order:

1. merge and publish the Markiro executor code;
2. separately approve and deploy an executor-bearing Markiro release;
3. collect/read-only version 3 baseline;
4. separately approve the exact v-b SHA and digest;
5. dispatch `Deploy v-b.tech private web` with confirmation;
6. verify private smoke and before/after capacity evidence;
7. stop before DNS, v-b certificate, backend, or contact activation.

Include rollback interpretation and sanitized evidence fields. Do not include real secret values, SSH commands for ad-hoc mutation, or public DNS records in this Markiro runbook.

- [ ] **Step 3: Run the GREEN documentation gate**

```bash
node --test deploy/production/test/runbook-contract.test.mjs
pnpm exec prettier --write docs/runbooks/saas-production-deploy.md deploy/production/test/runbook-contract.test.mjs
```

Expected: the runbook contract passes.

- [ ] **Step 4: Commit the runbook**

```bash
git add docs/runbooks/saas-production-deploy.md deploy/production/test/runbook-contract.test.mjs
git commit -m "docs: add private v-b deployment runbook"
```

## Task 10: Reconcile the complete production contract and repository graph

**Files:**

- Modify as required by verified failures only: files already listed in Tasks 1–9
- Regenerate: `graphify-out/graph.json` and other tracked Graphify outputs produced by `graphify update .`

- [ ] **Step 1: Scan for retired and forbidden contracts**

```bash
rg -n "VBTECH_IMAGE_TAG|ghcr\.io/thevladbog/vbtech-web:[0-9a-f]|rejectUnauthorized:\s*false|--insecure|confirm_private_deploy|VBTECH_EXECUTOR_CONTRACT_VERSION" deploy .github docs
```

Expected: no tag-based runtime selector or TLS bypass remains; confirmation and executor-version references exist only in the intended workflow, tests, executor, and runbook.

- [ ] **Step 2: Run focused full contract suites**

```bash
pnpm test:production-bundle:contract
pnpm test:yandex-runtime
pnpm test:yandex-runbooks:contract
```

Expected: all suites pass. Fix only failures caused by this implementation; do not widen the task into unrelated application work.

- [ ] **Step 3: Run formatting and static repository checks**

```bash
pnpm format:check
git diff --check
```

Expected: both commands exit successfully.

- [ ] **Step 4: Refresh the code graph after code changes**

```bash
graphify update .
git status --short
```

Review generated changes and keep only repository-standard Graphify outputs. Re-run `git diff --check` after regeneration.

- [ ] **Step 5: Perform an independent spec-to-diff review**

Read the approved spec and inspect the complete diff. Explicitly verify:

- no new VM or cloud resource exists;
- no DNS or public exposure action exists;
- no form/backend activation exists;
- ordinary Markiro release preservation fails closed;
- the executor never owns API or migration lifecycle;
- first-install and replacement rollback are both covered;
- version 3 evidence contains resources, network, v-b state, and corrected edge classification;
- the workflow verifies the exact external repository attestation before SSH;
- live deployment still requires a new exact approval.

- [ ] **Step 6: Commit reconciliation outputs if needed**

```bash
git add graphify-out
git commit -m "chore: refresh deployment code graph"
```

Skip this commit when Graphify produces no tracked change. Any small verified test/format reconciliation should be committed with a narrow message and only its affected files.

## Task 11: Prepare review evidence without performing a live deployment

**Files:**

- No required source changes

- [ ] **Step 1: Record the implementation boundary**

Prepare a handoff containing:

- branch name and commit list;
- exact automated commands and results;
- the executor contract version;
- the required bootstrap Markiro release step;
- the still-unrun live v-b dispatch;
- the still-unrun public DNS, v-b TLS, Cloud Functions, PostgreSQL, Postbox, SmartCaptcha, and real contact-form gates.

- [ ] **Step 2: Request code review**

Use the repository's review workflow after all local checks pass. Treat findings as untrusted input: verify each against current code, make only still-valid minimal fixes, and rerun the affected and full contract gates.

- [ ] **Step 3: Stop at the external-state boundary**

Do not dispatch a Markiro deployment, the new v-b workflow, or any infrastructure/DNS action. The next live action requires a separate user approval naming the exact Markiro bootstrap release when needed, then another approval naming the exact v-b source SHA and OCI digest.
