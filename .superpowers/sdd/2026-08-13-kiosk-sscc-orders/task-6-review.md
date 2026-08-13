# Task 6 review findings and fix disposition

Review target: initial Task 6 implementation at `739495a5`.

Status: **CHANGES REQUESTED at the reviewed commit; implementation fix complete and awaiting independent re-review.**

## Confirmed Important findings

1. Concurrent full refreshes shared one staging namespace. Interleaved initial cuts could replace one another's staged rows, a losing discard could erase a winner, and an older full cut could overwrite a newer active revision.
2. Registry freshness used the tablet fetch clock. A skewed device clock could make an otherwise valid server cut look incorrectly fresh or stale, and there was no single registry freshness verdict aligned with the bootstrap warn/block thresholds.
3. Page count guards did not bound string allocation. Very large strings and aggregate multi-byte content could be cloned into IndexedDB before rejection; server UUID-shaped identifiers were also only checked as non-empty strings.
4. Active, staging, and metadata rows were not bound to the installed kiosk. Re-pairing or revocation could expose or retain a previous tenant's registry, and a new kiosk could incorrectly start from a prior kiosk's higher revision.

## Fix disposition

- Every staging cut now carries canonical `serverUrl + kioskId`, a unique owner, `since`, and `until`. Stage, discard, and activation require the exact owner tuple. Full activation is strictly monotonic; delta activation requires the exact active base and preserves unaffected active rows.
- Registry storage operations share the config store transaction boundary. Begin, stage, and activation verify the currently paired binding and token; config writes atomically clear only registry stores on binding change or revocation while preserving queue and journal. A stale old-binding caller cannot clear or activate the new binding.
- The worker additionally single-flights refresh by installation binding. This reduces redundant foreground work, while the IndexedDB ownership/CAS checks remain the independent correctness boundary.
- Activated metadata stores the successful bootstrap's server `generatedAt`. `boxRegistryAge` applies the same corrected server clock and warn/block thresholds as the bootstrap snapshot.
- Untrusted pages are preflighted before durable copying/deduplication: at most 500 changes, 1,000 member keys, 1,024 UTF-8 bytes per string, one MiB aggregate UTF-8, valid SSCC checksum, bounded revisions, UUID box/product IDs, and cursor/page limits. Stored rows are revalidated before lookup.

## Fix verification

- RED: 3 files failed, 12 expected assertions failed, 108 existing assertions passed.
- Focused GREEN after binding-storage CAS: 4 files / 146 tests passed.
- Full kiosk GREEN: 21 files / 485 tests passed.
- Kiosk typecheck, full ESLint, Vite PWA production build, explicit changed-file Prettier check, and diff check passed.

No Task 7 visual/touch flow was implemented in this fix round.
