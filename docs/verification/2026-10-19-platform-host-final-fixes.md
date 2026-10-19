# Platform host final review fixes — 2026-10-19

Scope: one combined final fix wave on `codex/timeweb-host-execution`, from
`fadb46a751a90582bff40dabc68fbbc63fc98dc6`. No push, PR, server, provider, DNS,
shared database, configuration secret or production change belongs to this wave.

## Findings and dispositions

1. **Addressed:** Docker image inspection no longer expects a tagged pull
   reference verbatim in `RepoDigests`. It compares canonical repository plus
   exact SHA256 digest, including Docker Hub familiar-name aliases. Exact image
   ID and Linux AMD64 checks are unchanged. The PostgreSQL fixture now returns
   real tagless metadata; its independent lookup references only model Docker's
   ability to inspect an image using the original tagged pull reference. Positive
   aliases and wrong repository, deceptive registry, wrong namespace and wrong
   digest cases exercise the observer through the real fake-Docker subprocess.
2. **Addressed:** the probe uses trusted executor `process.getuid():process.getgid()` and
   requires all three bound source inodes to pass the existing private-file
   checks before create: actual owner UID, exact mode 0600, regular single-link file,
   private parents and no symlink. Inspected `Config.User` must match. Read-only
   mounts/root, dropped ALL capabilities and no-new-privileges are preserved.
   UID/GID never comes from operation JSON or environment. Root and Docker-enabled
   non-root executors retain the same documented bootstrap contract.

## Reproduction and commands

All commands run from this worktree with
`PATH=/opt/homebrew/opt/node@24/bin:$PATH`; package tools use Corepack pnpm.

- RED: `node --test deploy/platform/test/host-observe.test.mjs` failed for tagless
  PostgreSQL digests/aliases, user 0:0 versus 501:20, and a public worker file reaching
  create. Log: `/private/tmp/markiro-final-observe-red.log`.
- Focused GREEN: `node --test deploy/platform/test/host-observe.test.mjs deploy/platform/test/host-command.test.mjs`
  passed 57/57, zero skips (15.08s). Log: `/private/tmp/markiro-final-focused.log`.
- Command/coordinator integration: `node --test deploy/platform/test/host-command-integration.test.mjs`.
  Passed 3/3, zero skips (186.43s); log `/private/tmp/markiro-final-integration.log`.
- Final platform suite: `node --test deploy/platform/test/*.test.mjs`.
  Passed 442/442, zero failures/skips (166.05s), one final-tree run; log
  `/private/tmp/markiro-final-platform.log`.
- Scoped `corepack pnpm exec eslint` covers both changed host modules, observer
  test/fixture, fake Docker fixture, Linux harness and its two static ESM fixtures.
  Scoped `corepack pnpm exec prettier --check` covers these and both changed docs;
  `git diff --check` checks the complete patch. The initial CommonJS setup fixture
  was converted to ESM after the repository lint policy rejected require imports.

Exact scoped quality-gate commands (ESLint 8 source/test files, Prettier 10 files):
all passed, together with complete patch whitespace validation.

```sh
files=(
  deploy/platform/host/observe.mjs
  deploy/platform/host/probe.mjs
  deploy/platform/test/host-observe.test.mjs
  deploy/platform/test/host-observe-fixture.mjs
  deploy/platform/test/fixtures/host-docker.mjs
  deploy/platform/test/host-probe-linux.mjs
  deploy/platform/test/fixtures/host-probe-permissions-worker.mjs
  deploy/platform/test/fixtures/host-probe-permissions-setup.mjs
)
corepack pnpm exec eslint "${files[@]}"
corepack pnpm exec prettier --check "${files[@]}" \
  docs/runbooks/timeweb-platform-preparation.md \
  docs/verification/2026-10-19-platform-host-final-fixes.md
git diff --check
```

Read-only local `docker image inspect postgres:17-alpine --format '{{json .RepoDigests}} {{.Os}}/{{.Architecture}}'`
returned Linux ARM64 and tagless `docker.io/library/postgres@sha256:...` entries,
independently confirming the fixture's corrected metadata shape.

The separate real Linux regression command is:

```sh
PATH=/opt/homebrew/opt/node@24/bin:$PATH \
MARKIRO_TEST_DOCKER=/opt/homebrew/bin/docker \
MARKIRO_TEST_DOCKER_HOST=unix:///var/folders/1t/vr4lx9_x5zj65f1bhlk6q5b40000gn/T/podman/podman-machine-default-api.sock \
node deploy/platform/test/host-probe-linux.mjs
```

RED reproduced `EACCES` opening `/probe/worker.mjs` with the production user 0:0
and dropped capabilities. Final GREEN read all three mode-0600 files as 501:20; root 0:0
and a foreign UID remained negative controls. Logs:
`/private/tmp/markiro-final-linux-red.log`,
`/private/tmp/markiro-final-linux-accepted.log`.

The harness captures the real production probe's create argv, security flags,
mount destinations and synthetic input bytes. It copies those bytes into a
labelled disposable Linux volume, sets actual ownership 501:20 / mode 0600, remaps
only source paths to that Linux volume and runs a static reading worker. The
worker performs real stat/read calls for source, connection JSON and CA. Setup
and worker are static ESM files; JSON stdin is data, never generated code. Every
container has network none, no published port and no external DB connection;
no image is pulled. Cleanup checks labels before removing exact owned resources,
then verifies no labelled containers/volumes remain.

Local image: `node:24.18.0-bookworm-slim`, Linux ARM64,
`sha256:9be410e06dadc1794f44aa4c0fd107a7ecb2edb5cb6bcc6a71c7888caf3cfa12`.
This proves Linux DAC and the selected numeric identity, not the production API
worker, PostgreSQL/TLS, full host Docker lifecycle or target AMD64 execution.
Unit/process integration covers those command boundaries with synthetic adapters;
the isolated permission harness deliberately replaces the network with none.

## Acceptance limits

No live SSH handshake, protected deployment, target AMD64 execution, source import,
actual target backup/fence, production API image probe, capacity, off-host/key
recovery, SMTP/S3/DNS/TLS, source freeze or cutover was run. Those remain separate
mandatory operational gates. Full CI-policy and production-bundle suites were
not rerun in this two-module fix wave: no workflow, transport, Compose or production
bundle contract changed. Their earlier recorded results are not fresh evidence
for this patch. No local Graphify graph exists; no graph update was applicable.
