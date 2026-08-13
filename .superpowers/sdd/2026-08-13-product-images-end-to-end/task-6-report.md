# Task 6 report: kiosk immutable product-image store and sync

## Implemented

- Added optional nullable product image descriptors to the kiosk bootstrap contract.
- Added authenticated, bounded raw-blob download with the kiosk request timeout/error semantics.
- Bumped IndexedDB schema to version 3 with immutable checksum-keyed blobs and product pointer stores.
- Added blob-first/pointer-second publication, pointer reads, explicit deletion, allowlist pruning, and orphan blob cleanup.
- Added independent bounded-concurrency media reconciliation. `undefined` retains legacy/local state; `null` removes the pointer; failed download, validation, or write retains the old pointer and never rejects the sync aggregate.
- Wired refresh to publish the operational bootstrap first and run image reconciliation independently.

## Verification

- `pnpm --filter @markiro/kiosk exec vitest run test/product-images.test.ts test/api-client.test.ts test/store.test.ts` — passed.
- `pnpm --filter @markiro/kiosk typecheck` — passed.
- `pnpm --filter @markiro/kiosk lint` — passed.
- `git diff --check` — passed.

No browser, real object-storage, or physical kiosk acceptance was run in this worktree.
