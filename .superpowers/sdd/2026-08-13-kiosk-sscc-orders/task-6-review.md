# Task 6 re-review

Initial implementation: `739495a5`

Fix round 1: `739495a5..e6277324`

Verdict: **CHANGES REQUESTED**. Three of the four original Important findings are
addressed. Installation isolation is improved, but the required current-token
ownership check is still absent, leaving one Important same-binding re-pair race.

## Remaining Important finding

### A refresh is not owned by the current persisted token

`BoxRegistryCut` and `BoxRegistryMeta` carry only canonicalized
`{serverUrl,kioskId}`. `beginBoxRegistryStage`, `stageBoxRegistryPage`, and
`activateBoxRegistryPage` atomically verify that the persisted config has the same
binding and merely contains some non-empty token. They do not verify that the
token which authenticated the refresh is still the persisted token. The
single-flight key is also binding-only.

Consequently, this sequence is still possible:

1. Client A starts a registry refresh under token A for server S and kiosk K.
2. The device is re-paired to the same S/K and `writeConfig` installs token B.
   Because the binding is unchanged, the implementation deliberately preserves
   active and staging registry stores.
3. Client A resumes. Its cut still passes every binding/current-token-presence
   check and can stage or activate after token B became authoritative.

This violates the required invariant that an activation belongs to both the
current persisted binding and credential. It can publish a response authenticated
under a revoked/replaced credential after re-pairing. Bind each cut to a
credential generation or non-reversible token fingerprint and compare it with the
current config in the same IndexedDB transactions; do not persist another badge or
reusable credential. Add a regression that holds token-A refresh, re-pairs the
same server/kiosk with token B, requires the old stage/activation to fail, then
allows a token-B refresh. Queue and journal must remain intact.

## Addressed original findings

### Concurrent initial snapshots — addressed

- Staging metadata has a unique owner and exact cut tuple.
- Stage, discard, and activation require that exact owner; a losing discard cannot
  clear the winner's staging rows.
- Full activation rejects `until <= active.version`, so an older full snapshot
  cannot regress the active cut.
- The regression interleaves two `since=null` cuts and proves no row mixing,
  winner erasure, or active-version regression.

### Trusted freshness — addressed for the Task 6 persistence contract

- Activated metadata receives `bootstrap.generatedAt`, the server timestamp from
  the successful refresh, rather than the tablet fetch time.
- `boxRegistryAge` uses the bootstrap snapshot's corrected server clock and the
  same fresh/warn/blocked thresholds, failing closed when either half is missing
  or unmeasurable.
- UI consumption of this single verdict belongs to the later cart/touch-flow
  task; Task 6 now exposes the required trusted verdict rather than claiming the
  device timestamp is authoritative.

### Runtime and allocation bounds — addressed

- Page preflight runs before copying/deduplication and enforces 500 changes,
  1,000 member keys, 1,024 UTF-8 bytes per string, and one MiB aggregate string
  bytes.
- Box/product identifiers must be UUID-shaped; SSCC, revision, timestamp, field
  allowlists, bottle count, duplicate keys, cursor length/cycles, and total pages
  remain bounded.
- Active rows are revalidated, including the same string budgets, before lookup.

### Cross-installation binding and lifecycle clearing — partially addressed

- Metadata and storage operations are bound to normalized `serverUrl+kioskId`.
- Changing server or kiosk and revoking the token atomically clear only registry
  stores; queue and journal are preserved.
- Stale callers for another binding cannot read, clear, stage, or activate the
  current binding.
- The same-binding token-rotation race above remains open.

## Compatibility review

- IndexedDB remains version 3 and the v2-to-v3 upgrade creates only the new
  registry stores; existing snapshot and legacy queue records are retained.
- Registry clearing transactions do not include queue, journal, quarantine, or
  snapshot stores.
- No new badge plaintext path was introduced, and Task 6 queue/scrub wire
  compatibility is unchanged from the initial implementation.

## Verification

- Focused registry/store/sync/pairing tests: **4 files, 146 tests passed**.
- Kiosk TypeScript typecheck: **passed**.
- `git diff --check 739495a5..e6277324`: **passed**.
- No browser, physical scanner, tablet, or live-service check was run or claimed.

## Classification

- Critical: 0
- Important: 1
- Minor: 0
- Approval: **CHANGES REQUESTED**
