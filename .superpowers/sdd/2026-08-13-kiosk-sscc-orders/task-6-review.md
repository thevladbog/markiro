# Task 6 final re-review

Initial implementation: `739495a5`

Fix round 1: `739495a5..e6277324`

Fix round 2: `e6277324..3d35ea38`

Verdict: **APPROVED**. The residual same-binding token-rotation Important is
addressed. No Critical or Important finding remains in the bounded Task 6 scope.

## Residual Important: addressed

### Registry cuts are owned by the current persisted credential generation

- `writeConfig` stores a random, non-secret UUID `credentialGeneration`. It
  rotates whenever the paired token changes, including a re-pair to the same
  canonical server and kiosk, and is preserved only for the same token/binding.
- `BoxRegistryCut` and active metadata carry the canonical binding plus that
  generation, never token plaintext or reversible token-derived material.
- Begin, stage, activation, and discard read config in the same IndexedDB
  transaction as their registry work and compare the exact current credential
  owner. Old-generation begin/stage/activation abort; old-generation discard is
  a no-op and cannot clear the new cut.
- Token rotation clears active, staging, and registry metadata atomically with
  the config update. Queue, journal, quarantine, and snapshot stores are outside
  that transaction and remain intact.
- The worker single-flight key includes canonical server URL, kiosk ID, and
  credential generation. A new credential refresh therefore does not wait on or
  reuse a held old-credential refresh.

The end-to-end regression holds token-A before staging, writes token B for the
same server/kiosk, activates token-B revision 2, then releases token A. The old
client publishes no row and does not erase or overwrite the new active cut. A
storage-boundary regression also begins an old cut before rotation, requires its
later activation to fail, and successfully activates the new owner.

## Upgrade and secret handling

- Existing version-3 paired config without a valid generation is upgraded on
  `readConfig` through the normal atomic config/registry transaction. It receives
  a fresh generation; incompatible old metadata is cleared rather than trusted.
- IndexedDB remains version 3; no queue or journal migration is introduced.
- The generation is random ownership metadata, not a badge, device token, token
  hash, or credential usable against the API. No new token logging or registry
  persistence path was added.

## Earlier findings remain addressed

- Concurrent initial full cuts have exact owner/CAS isolation; loser discard
  cannot erase winner staging and an older full cut cannot regress active.
- Registry freshness uses trusted bootstrap server `generatedAt` and the shared
  corrected fresh/warn/blocked verdict.
- Runtime validation retains per-string 1,024-byte UTF-8, aggregate one-MiB,
  member-count, UUID, SSCC, revision, cursor, and page bounds.
- Changing server/kiosk or revoking a token clears only registry stores; legacy
  queues, scrub compatibility, journal custody, and exact order wire payloads are
  unchanged.

## Verification

- Focused registry/store/sync/pairing tests: **4 files, 148 tests passed**.
- Kiosk TypeScript typecheck: **passed**.
- `git diff --check e6277324..3d35ea38`: **passed**.
- Implementer report additionally records full kiosk **21 files / 487 tests**,
  lint, and Vite PWA build passing; this review independently reran only the
  bounded gates above.
- No browser, physical scanner, tablet, or live-service check was run or claimed.

## Classification

- Critical: 0
- Important: 0
- Minor: 0
- Approval: **APPROVED**
