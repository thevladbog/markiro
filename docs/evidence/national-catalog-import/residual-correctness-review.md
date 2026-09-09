# Bounded residual R1/R2 re-review

Scope: `703440ebd09cf35fc9090e2c0107131383c98c0a` → `6d2e201a32979e6c0ed76345b824bbc628fc4ffc`, in the National Catalog task worktree. Replacement reviewer under Ruling123; this is neither Task7 nor a whole-branch review.

## R1 — ADDRESSED

`apps/api/src/modules/national-catalog/national-catalog-import-apply.service.ts:257` now fences the separate failure recorder when the locked receipt is already failed and is not a genuine due, scheduled, nonexhausted infrastructure retry. Therefore the collector's `failed/import_session_closed` result returns before attempt changes, retry scheduling or audit insertion at `:265`–`:302`. Existing cancellation/applied/conflict guards remain. Finalization at `:312` derives no pending core retry from the collector's cleared `nextAttemptAt`.

The deterministic real-PG cases at `apps/api/test/national-catalog-import-preview.test.ts:691` await the actual rejected repository transaction, assert that the transaction's marker rolled back while its receipt remained pending, call the actual `sessions.releaseExpired`, capture its committed terminal receipt/audit, and only then rethrow into the production catch. This covers both the real closed-session classification and an injected stale infrastructure classification. The exact full-row comparisons at `:812`–`:813` retain receipt timestamps/attempts/decision/evidence and the single audit; actor, tenant, action, target, result and reason are explicitly asserted. The operation remains finished without enqueue and no product is created.

The adjacent positive regression records two genuine infrastructure failures with increasing due delays, refuses premature execution, then applies and preserves terminal replay with exactly two correctly attributed failure audits. The complete preview/apply GREEN is **83/83** (`residual-correctness-r1-green.log`). The retained RED proves both original failures: duplicate audit/attempt mutation and, for stale infrastructure, reason/retry/enqueue resurrection (`residual-correctness-r1-red.log`).

## R2 — ADDRESSED

`apps/admin/src/pages/catalog/national-catalog/ImportReview.tsx:104` permits the legacy path only when no owned `name` key is supplied. If that key exists, the following accepted-ID condition still requires its explicit acceptance. The correction does not inspect translated/provider labels or alter backend/contracts.

`apps/admin/test/national-catalog-import.test.tsx:144` adds both new-only and mixed-batch cases: omit `labelKey`, use an opaque label, parse the real strict response schema, click enabled Apply and assert exact accepted IDs. Existing RU/EN current-key cases still deselect the new-product name and assert disabled Apply/incomplete totals at `:1694`. The retained RED shows both old-wire confirmations blocked; the complete import DOM GREEN is **67/67** (`residual-correctness-r2-red.log`, `residual-correctness-r2-green.log`).

## New Breakage in Fix Diff

None found. Both original residuals are addressed without new Important/Critical breakage in the two runtime guards and their tests. No new architecture, migration, contract, layout or provider behavior is introduced.

## Out-of-Scope Observations

The fresh full API gate remains **FAILED: 3226 passed / 1 failed / 1 intentional live skip**, 578.08s. Its sole failure is the Station inventory competing-device repack FK23503 at `apps/api/src/modules/inventories/station-inventory-sync.service.ts:633` / `apps/api/test/station-inventory-sync.e2e.test.ts:1380`. The exact log and preserved metadata agree. The single unchanged complete-file diagnostic is **17/17**, which neither resolves the ordering concern nor makes the aggregate green. This is outside the residual diff; the worker's historical byte/source attribution is retained, not expanded into a new Station audit here. The earlier Station aggregate failure also remains historical and unresolved.

Existing Vite/pg, canvas, color-precedence, bundle-size and five unrelated admin hook warnings remain visible; they are not new residual findings or pristine-output claims. No live CHZ/CDN/production, process-kill, Windows or hardware acceptance is established.

## Checks and evidence read

- Read the complete original scoped report, exact residual findings, binding rulings/global constraints, final worker report and exact supplied residual diff. Read changed production/test hunks fully; inspected manifest headers/deltas and verified arrays programmatically.
- Focused dependency checks: catch-hunk continuation and existing admission/finalization predicate; actual collector terminal write; repository transaction wrapper proving the test awaits real rollback; existing current-key RU/EN required-name regression. No unrelated source exploration.
- Read exact RED/GREEN logs; fresh full API failure/summary; full admin summary (**1124/1124**); six static/build logs and recorded exit0 command metadata; complete post-build browser log (**21/21**, 53.9s); inventory diagnostic; format output; routing and identity records. Root diff-check success is retained from the worker's completion record, not independently rerun.
- Independently recomputed all **148** current source hashes; all match the fresh freeze, whose delta against the previous delivery manifest is exactly the four runtime/test files. Recomputed **43** current-wave PNG hashes and sizes with no mismatch. The **24** inherited images and **75** protected-artifact historical preservation claims remain supplied identity evidence, not a new historical Git comparison.
- Recomputed the preserved full-API metadata SHA256: matches `e9510c1d0d1b62ac4fb594742c2a762438e80021feb0e61cba8ba7666f16ea38`. All eight selected entries exactly match the preserved **295** entries, including real successful local infrastructure/provisioning/inventory and import suites; the only failed entry is Station inventory sync. Confirmed **124** ruling lines and all supplied binding ruling texts in the delivery record.
- No tests, DB operations, browser/network execution, Git/source/index changes or subagents. Only this review was written.

## Final verdict

**R1 ADDRESSED; R2 ADDRESSED. Bounded residual correction approved, with no new Important/Critical breakage found.** This verdict does not assert an all-green aggregate: the source-unchanged full-API inventory failure and external acceptance limits remain explicit.
