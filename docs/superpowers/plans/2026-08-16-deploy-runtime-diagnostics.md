# Deploy Runtime Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make production deployment failures identify one bounded stage and reject Lockbox key-name drift read-only before host reconciliation, runtime materialization, migrations, image switching, or other service mutation.

**Architecture:** Keep remote stdout/stderr private. Convert every deployment boundary into a typed stage error, then let the top-level CLI emit exactly one allowlisted `MARKIRO_DEPLOY_FAILURE <stage>` line. Reuse the exact `.env.production.example` parser and Lockbox fetcher for a new inventory-only CLI mode executed from the transferred candidate release before any remote mutation.

**Tech Stack:** Node.js 24 ESM, `node:test`, SSH, systemd-run, Yandex Compute metadata, Yandex Lockbox, GitHub Actions, production Compose/Caddy contract suite.

**Spec:** `docs/superpowers/specs/2026-08-16-legal-docs-corrective-release-design.md`

## Global Constraints

- Diagnostics may expose only one allowlisted stage. Never print subprocess stderr, exception messages, secret IDs, environment values, key values, credentials, host paths, form data, or arbitrary remote output.
- The inventory probe compares sorted key names only. It must not materialize `/etc/markiro/production.env`, restart systemd units, reconcile host assets, run migrations, pull/start images, or alter a release record.
- Preserve strict SSH host-key authentication, the dedicated deploy login, job-scoped registry credentials, exact release-manifest binding, candidate rollback, and credential cleanup.
- Use focused TDD for each production change. Mutations in tests must execute exported behavior; source-regex assertions are supplemental only.
- Run the production bundle contract once after focused GREEN. Do not repeatedly rerun a Docker/Podman-heavy canonical suite after a product pass.
- This plan does not deploy, edit Lockbox, enable the public form, or change any provider state.

---

## Task 1: Add a closed deployment-stage error contract

**Interfaces**

```js
export const DEPLOYMENT_STAGES = Object.freeze([
  "configuration",
  "transfer",
  "reconcile-host",
  "runtime-inventory",
  "runtime-env",
  "prepare",
  "smoke",
  "finalize",
  "rollback",
]);

export class DeploymentStageError extends Error {
  constructor(stage, options = {}) {
    super("remote deployment failed", options);
    this.stage = assertDeploymentStage(stage);
  }
}

export async function atDeploymentStage(stage, operation) {
  try {
    return await operation();
  } catch (cause) {
    throw new DeploymentStageError(stage, { cause });
  }
}

export async function runRemoteDeployCli(options = {});
```

**Files**

- Modify: `deploy/yandex/remote-deploy.mjs`
- Modify: `deploy/yandex/test/remote-deploy.test.mjs`
- Modify: `deploy/yandex/test/hosted-deploy-workflow.test.mjs`

- [ ] Add failing table tests for all nine allowed stages and rejection of an arbitrary stage, whitespace, newline injection, secret-shaped text, and overlong values.
- [ ] Add failing CLI tests that inject a secret-bearing error at each boundary and assert stderr is exactly one line: `MARKIRO_DEPLOY_FAILURE <stage>\n`.
- [ ] Assert serialized errors, stdout, and stderr contain none of injected secret value, remote message, identity path, registry token, Lockbox identifier, environment value, or candidate JSON.
- [ ] Change stream-transfer tests to expect a private tagged cause rather than a direct diagnostic, preventing duplicate `MARKIRO_DEPLOY_FAILURE` lines.
- [ ] Run RED:

```bash
node --test deploy/yandex/test/remote-deploy.test.mjs deploy/yandex/test/hosted-deploy-workflow.test.mjs
```

Expected RED: `runRemoteDeployment` loses boundary identity, `streamArchive` logs internally, and the main block emits only generic `remote deployment failed`.

- [ ] Implement an immutable stage allowlist and a typed error whose public message is fixed. Preserve the original cause only as in-memory control-flow context.
- [ ] Move all user-facing diagnostic writing into `runRemoteDeployCli`; it catches typed errors, writes exactly one bounded line, and returns nonzero.
- [ ] Make configuration validation run inside the `configuration` boundary without weakening current pre-transfer validation.
- [ ] Remove direct diagnostic output from `streamArchive`; keep its detailed internal cause codes private for tests/debugger inspection only.
- [ ] Replace the module main block with `process.exitCode = await runRemoteDeployCli()` and no secondary catch/log path.
- [ ] Run GREEN:

```bash
node --test deploy/yandex/test/remote-deploy.test.mjs deploy/yandex/test/hosted-deploy-workflow.test.mjs
```

- [ ] Review every `writeDiagnostic`, `stderr.write`, and `console` call in the deploy adapter; prove no path can emit a second line or arbitrary text.
- [ ] Commit: `fix(deploy): report bounded failure stages`

---

## Task 2: Add a read-only exact runtime inventory verifier

**Interfaces**

```js
export function runtimeInventoryKeyNames(keys, entries) {
  // Returns the sorted exact key-name set or throws the fixed inventory error.
}

export async function verifyRuntimeInventory({
  inventoryText,
  secretId,
  fetchIamToken,
  fetchSecretPayload,
} = {});

export async function runInventoryCli({
  environment,
  inventoryPath,
  stderr,
  ...dependencies
} = {});
```

**Files**

- Modify: `deploy/yandex/runtime-env.mjs`
- Modify: `deploy/yandex/test/runtime-env.test.mjs`
- Modify: `deploy/yandex/reconcile-host.sh` only if the final installed CLI mode needs an explicit invocation contract; do not change materialization ordering

- [ ] Add failing pure tests that accept the exact 35-key inventory and reject one missing, one extra, duplicate expected key, duplicate payload key, malformed key, non-string value shape, empty inventory, and malformed Lockbox entry.
- [ ] Assert the verifier result exposes no values and that errors are the fixed string `runtime environment inventory is invalid`.
- [ ] Add failing integration-style CLI tests proving inventory mode reads the supplied candidate `.env.production.example`, fetches metadata/Lockbox once, writes no destination file, calls no filesystem mutation primitive, and emits only its fixed failure line.
- [ ] Preserve existing materialization tests unchanged as a regression contract.
- [ ] Run RED:

```bash
node --test deploy/yandex/test/runtime-env.test.mjs
```

Expected RED: runtime-env can only render and atomically write values; it has no independently callable read-only verification mode.

- [ ] Extract exact-set validation from `renderRuntimeEnvironment` so inventory verification and materialization share one key-name contract without sharing secret values in return data.
- [ ] Keep `environmentKeysFromExample` strict: only unique `^[A-Z][A-Z0-9_]*=$` inventory lines, comments/blank lines allowed, at least one key.
- [ ] Implement `verifyRuntimeInventory` using the existing 2-second bounded metadata and Lockbox fetchers. Iterate entries only to validate `{key, textValue}` structure and key uniqueness; never concatenate or return `textValue`.
- [ ] Implement explicit CLI dispatch: no argument retains materialization service behavior; `verify-inventory <absolute-inventory-path>` runs read-only verification. Reject every other argv shape before network access.
- [ ] Ensure inventory CLI stdout is empty and stderr is either empty success or one fixed line. The remote wrapper will suppress this line and map exit status to `runtime-inventory`.
- [ ] Run GREEN and mutation tests:

```bash
node --test deploy/yandex/test/runtime-env.test.mjs
```

- [ ] Inspect `git diff` for any code that serializes the Lockbox entries or includes a payload value in an error.
- [ ] Commit: `feat(deploy): verify runtime inventory read only`

---

## Task 3: Put inventory verification before every remote mutation

**Expected remote order**

```text
configuration
transfer
runtime-inventory  # candidate code + candidate inventory, read-only
reconcile-host
runtime-env
prepare
smoke
finalize
```

On post-prepare failure:

```text
original stage -> rollback once -> report original stage
original stage -> rollback fails -> report rollback
```

**Files**

- Modify: `deploy/yandex/remote-deploy.mjs`
- Modify: `deploy/yandex/test/remote-deploy.test.mjs`
- Modify: `deploy/yandex/test/hosted-deploy-workflow.test.mjs`
- Modify: `.github/workflows/deploy-production.yml` only if the bounded final event needs an explicit workflow annotation; do not add provider credentials or control-plane access
- Modify: `deploy/production/test/workflow-contract.test.mjs`

- [ ] Extend the `deployRelease` dependency contract with `verifyRuntimeInventory` between `transferBundle` and `reconcileHost`.
- [ ] Add failing order tests proving a mismatch stops after transfer and invokes none of reconcile, runtime refresh, prepare/migration, smoke, finalize, rollback, active-release replacement, or service commands.
- [ ] Add failing real-adapter argv tests for a candidate-release command equivalent to:

```text
sudo /usr/bin/systemd-run --quiet --wait --pipe --collect
  --property=EnvironmentFile=/etc/markiro/runtime-secret-id
  --working-directory=/opt/markiro/releases/<sha>
  /usr/bin/node deploy/yandex/runtime-env.mjs
  verify-inventory /opt/markiro/releases/<sha>/.env.production.example
```

- [ ] Assert no shell, `bash -c`, interpolation, stdout capture parsing, runtime-env destination, or registry credential input is used for the probe.
- [ ] Add failure matrix tests mapping each boundary to its exact stage and proving a prepared candidate rolls back exactly once.
- [ ] Add rollback-precedence tests: successful rollback preserves original stage; rollback failure reports only `rollback` while retaining the original typed error as its private cause.
- [ ] Run RED:

```bash
node --test deploy/yandex/test/remote-deploy.test.mjs deploy/yandex/test/hosted-deploy-workflow.test.mjs deploy/production/test/workflow-contract.test.mjs
```

Expected RED: current order is transfer, reconcile, runtime, prepare; there is no pre-mutation inventory stage or bounded rollback precedence.

- [ ] Wire candidate inventory verification immediately after the archive transfer. Its systemd transient unit may read `/etc/markiro/runtime-secret-id` but must not require the installed candidate runtime service.
- [ ] Wrap each boundary with `atDeploymentStage`. Keep preparation candidate parsing private and fixed-message on malformed output.
- [ ] Preserve the current registry credential envelope only for prepare/finalize/rollback. Do not pass GHCR credentials to inventory verification.
- [ ] If workflow annotation is added, derive it only from the exact bounded line; never upload raw remote logs or secrets as an artifact.
- [ ] Run GREEN:

```bash
node --test deploy/yandex/test/runtime-env.test.mjs deploy/yandex/test/remote-deploy.test.mjs deploy/yandex/test/hosted-deploy-workflow.test.mjs deploy/production/test/workflow-contract.test.mjs
```

- [ ] Run a mutation audit that injects failures before and after each awaited operation and proves the stage code, call order, and rollback count.
- [ ] Commit: `fix(deploy): reject runtime drift before mutation`

---

## Task 4: Verify the deploy bundle and document operator recovery

**Files**

- Modify: `docs/runbooks/landing-publication.md`
- Modify: `deploy/production/test/runbook-contract.test.mjs`
- Create or modify the scoped review report under `docs/reviews/`

- [ ] Add runbook RED assertions for all nine stage codes, exact inventory-before-mutation behavior, and bounded operator actions for `runtime-inventory`.
- [ ] Document recovery: compare only names from `.env.production.example` and the active Lockbox version, create a recoverable new version, rerun the same failed deployment, and never copy secret values into logs or issue text.
- [ ] Document that `runtime-inventory` proves only name-set agreement, not SMTP delivery, captcha validity, database connectivity, or application health.
- [ ] Run focused GREEN:

```bash
node --test deploy/production/test/runbook-contract.test.mjs deploy/yandex/test/runtime-env.test.mjs deploy/yandex/test/remote-deploy.test.mjs deploy/yandex/test/hosted-deploy-workflow.test.mjs deploy/production/test/workflow-contract.test.mjs
```

- [ ] Run the production bundle contract exactly once outside the sandbox if the Caddy/Podman socket requires it:

```bash
corepack pnpm test:production-bundle:contract
```

- [ ] If the canonical command fails before product tests because of the known nested pnpm mismatch, record the exact primary error and run the repository-established direct script exactly once. Do not report the wrapper as passing.
- [ ] Run static hygiene:

```bash
corepack pnpm format:check
git diff --check
git status --short
```

- [ ] Request independent review focused on secret non-disclosure, pre-mutation ordering, duplicate diagnostics, rollback precedence, argv safety, and service-account scope. Fix every verified blocker with a separate RED/GREEN cycle.
- [ ] Record exact test counts, skipped/infrastructure cases, and the fact that no live deploy or Lockbox mutation was performed.
- [ ] Commit: `docs: explain bounded deploy recovery`

---

## Task 5: Prepare a separately reviewable deploy-diagnostics candidate

**Files**

- No production changes expected

- [ ] Inspect the branch diff against its base and verify it contains only deploy adapter, runtime inventory, workflow contract, runbook, tests, and report changes from this plan.
- [ ] Prove no `.env`, SSH key, credential path, Lockbox payload, token, remote stderr, or generated runtime environment is tracked.
- [ ] Confirm the legal corrective release can merge independently if deploy diagnostics needs another review cycle.
- [ ] Do not push, merge, release, rerun a failed production deployment, or mutate Lockbox until the user explicitly authorizes that external action.

## Plan Self-Review Checklist

- [ ] Every possible final failure produces exactly one allowlisted stage line.
- [ ] Inventory runs after immutable transfer but before the first remote mutation.
- [ ] Missing, extra, duplicate, malformed keys fail closed without values.
- [ ] Rollback runs once only after candidate preparation and has explicit precedence.
- [ ] Registry credentials never reach inventory verification.
- [ ] Existing SSH, release-manifest, cleanup, and form-disabled contracts remain unchanged.
- [ ] Search the plan for placeholders and unresolved choices:

```bash
rg -n 'TODO|TBD|FIXME|\.\.\.|similar to|as above|decide later' docs/superpowers/plans/2026-08-16-deploy-runtime-diagnostics.md
```

- [ ] Confirm all paths, exports, commands, systemd argv, and expected RED failures match the current checkout.
