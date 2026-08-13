# Task 6 implementation report

## Outcome

The kiosk now downloads the tenant box registry into IndexedDB through an isolated staging cut and exposes only the last completely activated cut to offline lookup. Loose/box order bodies, enqueue-time bottle estimates, structured terminal box verdicts, and old `badgeCode` queue records survive restart and bundle upgrades without exposing box member KMs.

## Registry persistence and refresh

- IndexedDB v3 adds active, staging, and metadata stores without replacing v2 config, snapshot, queue, journal, or quarantine records.
- Full snapshots replace active rows only on the final page; deltas preserve unaffected rows and atomically apply named upserts/removes with the version metadata.
- An incomplete, failed, cyclic, oversized, or superseded page cut never changes active lookup. A restarted 409 cut first disowns prior staging.
- Refresh uses the active revision as `since`, binds follow-up pages to `until`, retries exact `registry_snapshot_changed` at most three times with 250/500 ms waits, and caps one attempt at 10,000 pages.
- Registry failure leaves a successful bootstrap installed and the prior active registry intact. A 401 between bootstrap and registry is rethrown so device revocation is not hidden.
- Untrusted pages and stored rows validate revision, kind, SSCC checksum, timestamp, bottle count, unique content keys, field allowlists, 500 page entries, 1,000 page member keys, cursor length/cycles, and aggregate page count.

## Queue and error compatibility

- `CreateOrderDto` uses exact digest-or-legacy-code identity and adds optional canonical `boxes`.
- `QueuedOrder.estimatedBottleCount` stays outside the wire body. Valid 0..1500 estimates drive local day counts; old/corrupt records fall back to `body.items.length`.
- 413 joins the narrow terminal order allowlist. `KioskApiError.details` retains the parsed response in memory, while quarantine copies only validated `{sscc,bottleCount,reason}` box tuples and never the raw response, loose conflict KMs, or box members.
- Existing badge scrubbing changes only badge identity. Focused coverage proves `boxes`, SSCC, estimate, admission state, and empty member-free body remain unchanged in queue/quarantine custody.

## Verification

- RED: 5 files failed; 7 expected assertions plus missing box-registry module; 162 existing tests passed.
- Focused GREEN: 6 files / 191 tests passed.
- Full kiosk: 21 files / 478 tests passed.
- Kiosk TypeScript typecheck, full ESLint, Vite production build, scoped Prettier check, and `git diff --check` passed.
- Commands used direct installed package binaries because the pnpm wrapper stalled in this worktree.
- No visual/touch cart flow from the later plan was implemented in this task.
