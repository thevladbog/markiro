# Platform protected transport verification — 2026-10-19

This record covers Task 3 on `codex/timeweb-host-execution`, based on
`5c6924db4db09d1bc6851f8d006f0bd498d109c3`. It does not certify a deployed target.

## Implemented boundary

- Main-only manual `deploy-platform.yml` uses `production-deploy`, pinned actions,
  serialized non-cancelling deployment and read-only job permissions. Product
  publisher/run/attempt/artifact and executor CI/SHA remain separate identities.
- Local exact CI/admission/Git-blob gates precede SSH. Pinned host/identity,
  no user config/agent/proxy/password/TOFU, bounded process/stdin/output and clean
  Node startup are explicit. Static loader poison does not execute in the actual
  workflow shell startup test. Secrets travel through stdin, never OS argv.
- The fixed independently trusted receiver compares the entire allowlist to an
  independently installed receipt before exclusive private bundle creation. It
  rejects duplicate JSON keys, extra/missing files, hash/identity mismatch,
  unsafe paths, symlinks, active locks and an existing bundle. It cannot install
  or replace the receipt or operation. It rechecks source before evaluating the
  transferred CLI. Only the policy HBA file uses0644; private inputs use0600.
- The minimal `runHostProcess` extension accepts optional Buffer stdin up to1MiB;
  default stdin remains ignored. Real static subprocess tests cover full input
  digest, backpressure/timeout, early exit/EPIPE and invalid input.
- Private GHCR read authentication uses a strictly validated actor and short-lived
  read-only job token in an exclusive0600 temporary local Docker config. Only exact
  manifest reads receive its path; success/failure cleanup preserves preexisting
  directories and no credential appears in child argv/environment/artifacts.
- Exact successful healthy response plus confirmed CLI group exit permits token
  unlink/fsync. Every nonzero/malformed/lost/uncertain result preserves remote
  token/source/state and blocks blind execute retry. No rollback or lock cleanup
  is automated. Task2 JSON `terminationConfirmed:null` is never a cleanup proof.

## Test evidence

Node24 via `PATH=/opt/homebrew/opt/node@24/bin:$PATH`, repository Corepack pnpm.

- Initial transport test failed because the module did not exist. Protected
  workflow test failed before the workflow existed. Pre-execution tampering,
  duplicate JSON keys and absent/ambiguous host pins each failed before its
  corresponding gate was added, then passed.
- Focused final transport: **50 passed,0 failed,0 skipped**. Tests use static fake
  SSH processes and private host fixtures. They do not exercise a real SSH server.
- CI policy: **65 passed,0 failed,0 skipped**, including explicit workflow event
  inventory and an actual shell/Node startup with hostile ambient NODE_OPTIONS.
- Production bundle contracts: **591 passed,0 failed,0 skipped** (26.28s).
- Final complete platform suite: **428 passed,0 failed,0 skipped** (134.07s),
  including all50 transport cases and existing Task2 coordinator integration.
- Scoped ESLint for all8 affected JS modules/test files, Prettier for all12 changed
  files and git diff --check passed. No shared database, `.env`, server or provider
  was changed.

## External prerequisites and limits

No live SSH handshake/host-key rejection, protected workflow dispatch, Linux AMD64
host execution, real GitHub+target combined flow or published API-image probe was
run here. Task2's existing integration covers the real coordinator with synthetic
GitHub/Docker boundaries; prior real Docker PostgreSQL/restore runs were ARM64.
New tests do not turn these into live acceptance.

The operator must independently install the reviewed bootstrap/import closure,
receipt, private operation/config, real PG/TLS/roles and candidate API image.
Source→target import/mapping and the production target-local backup producer with
an independently enforced writer fence are separate prerequisites. No fabricated
backup/prepared record is delivered. Actual retained-work suppression, key
continuity, off-host recovery, DNS/TLS, S3 delta, SMTP, memory/disk/CPU headroom,
final source freeze, rollback ownership and shutdown require their own evidence.

The latest controller-provided inventory/CI/pricing observations are dated in the
[migration checklist](../runbooks/timeweb-migration.md#delivery-readiness-update-2026-10-19).
Budget is pending and no VM is provisioned. Release CDN/S3 and authoritative DNS
remain Yandex dependencies; public MX absence is not repaired by a staged mailbox.
Preserve the stopped CRM disk because the October11 backup cannot prove equality.
No resource deletion is authorized by this record.
