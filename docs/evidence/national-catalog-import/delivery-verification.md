# National Catalog import delivery and verification

Date: 2026-09-09 (local execution timestamps Europe/Moscow unless marked UTC).

Subsequent UI follow-up: the approved two-column field/photo selection is
implemented locally. Its current checks, review and new screenshots are in the
[dated comparison-cell report](comparison-cells-2026-09-09/verification.md).
The source freezes and visual evidence below describe the preceding delivery.

Task14 starts from `7bb8706a7b27b272318464569f34f268e701e17a`; Tasks1–13 have
independent scoped review. Task14 and the one whole-branch review completed. The whole-branch review found
6 Important and 8 Minor corrections; the single fix wave is recorded below.
Its scoped re-review addressed all 14 original findings and identified two residual
correctness defects at `703440ebd`: a late expiry/failure-recording race (R1) and
old-wire confirmation compatibility (R2). The explicitly bounded continuation
corrected only these two defects in `6d2e201a32979e6c0ed76345b824bbc628fc4ffc`.
The independent exact-diff re-review approved both corrections with no new
Important/Critical breakage. Its package/browser results and remaining
source-unchanged API failure are recorded below.
Provider import flags remain false, image host allowlist empty, production unenabled.

## Delivery

Implemented own/GTIN discovery, complete/partial durable enumeration, explicit
cross-page selection, immutable review and receipt identity, atomic product/category/
link/audit changes, independent accepted-photo processing, current authorization and
subscription enforcement, exact-card comparison, status/error disclosure and local
unlink. Task14 adds realistic browser fixtures and CI, deterministic carried test
proof, local two-worker PgBoss retry proof, storage-capacity and failed-result identity
corrections, and the operating/enablement runbook.

Areas: `apps/admin` catalog/import UI and RU/EN copy; `apps/api` discovery,
comparison, apply, photo processing, authorization and jobs; shared domain/contracts
and additive DB schema/migrations; browser fixtures and CI contracts; architecture,
runbook, specification, plan and delivery evidence. No Rust/offline media architecture
changes.

## Residual R1/R2 continuation (current verification)

Base: `703440ebd09cf35fc9090e2c0107131383c98c0a`. Both authorized residual fixes are
implemented and have focused RED/GREEN proof. The API failure recorder now reuses
the existing failed-receipt retry predicate, preserving a terminal outcome committed
by expiry cleanup between rollback and catch. Tests force that exact real-PG order
for closed-session and infrastructure errors, checking unchanged full receipt/audit,
actor/tenant/target/reason, attempts, retry intent and accepted evidence. A positive
due-infrastructure retry still records failures, delays, applies and replays correctly.

Admin requires explicit name acceptance when the owned name key is supplied; an
older schema-valid response without that optional metadata retains its prior
submission path and authoritative server validation. New/mixed old-wire DOM
submissions and RU/EN current-key required-name checks pass. No layout, schema,
contract, provider configuration or Station/inventory source changed.

| Current gate                                  | Actual result                                                     |
| --------------------------------------------- | ----------------------------------------------------------------- |
| R1 focused RED → full preview/apply GREEN     | 2 failed /1 positive passed /44 filtered →83/83;7.81s             |
| R2 focused RED → full import DOM GREEN        | 2 failed /65 filtered →67/67;18.66s                               |
| Fresh full API with local infrastructure      | **FAILED**:3226 passed /1 failed /1 intentional live skip;578.08s |
| One complete failed inventory-file diagnostic | 17/17;1.72s; no source change or full rerun                       |
| Fresh full admin                              | 95 files;1124/1124;167.14s                                        |
| API/admin typecheck, lint, build              | All six passed; configs also typecheck tests                      |
| Fresh browser after all builds                | 21/21;53.9s; screenshot updates verified unset                    |

The sole API failure is the pre-existing competing-device repack path in
`station-inventory-sync.e2e.test.ts:1380` / `station-inventory-sync.service.ts:633`:
PostgreSQL23503 prevents changing a result's observed production date while an
active repack item references the old composite key. The winner update precedes
repack membership removal. The service, test and inventory schema are byte-identical
to both this continuation's base and original import base `f78928a0`. The test
constructs the inventory service directly; no changed National Catalog dependency
was found. The one17-case diagnostic passed, but neither resolves that ordering
issue nor converts the full API run to green. This source-unchanged integration
concern remains alongside the earlier unchanged Station aggregate failure.

Full295-entry metadata was snapshotted before the diagnostic. The
[selected actual results](residual-correctness-api-full-selected-metadata.json)
confirm local Mailpit/MinIO963.66ms, provisioning15118.56ms, inventory
documents3633.84ms/lifecycle4522.84ms/snapshot3143.12ms, all successful. The sole
intentional skip is the unconfigured National Catalog live read contract. No
DB-dependent suite was silently skipped and no other DB workload overlapped API.

The [fresh148-file source freeze](residual-correctness-source-freeze.json) records
exactly four changed runtime/test files. All previous source/visual manifests,
43 fix-wave and24 inherited PNGs are preserved; current21 did not regenerate them.
The fixtures remain representative because neither correction changes layout.
Unchanged contracts100/domain633/DB401/production536/CI38 evidence is reused.
All124 chronological rulings and costs appear below. Historical failed runs remain
failed; no aggregate or broad Station rerun was performed. Exact-diff independent
re-review under ruling123 is complete: R1 and R2 are addressed, with no new
Important/Critical breakage found. Provider/CDN,
hardware/offline-photo and live enablement acceptance remain unperformed; flags
stay disabled and no push, PR, deployment or cleanup occurred.

## Review closure and local delivery

The [original scoped review](final-fix-scoped-review.md) records all14 original
findings addressed and the two subsequently corrected residuals at `703440ebd`.
The [final residual review](residual-correctness-review.md) covers exactly
`703440ebd09cf35fc9090e2c0107131383c98c0a` →
`6d2e201a32979e6c0ed76345b824bbc628fc4ffc`: both residuals are addressed and no
new Important/Critical breakage was found. These complete reports preserve their
historical scope and evidence limits. All124 rulings below remain verbatim.

The controller independently verified all148 current source hashes, the four-file
residual delta,43 screenshot hashes/sizes, all124 exact chronological rulings and
all eight selected entries against the retained295-entry full API metadata.
The final catalog and comparison screenshots were visually inspected. The earlier
24 images and75 protected artifacts retain the implementer's recorded identity
proof; no new capture was made. After review only these documentation/status
records changed; runtime source and the tested artifacts remain frozen.

Implementation is locally complete on `codex/national-catalog-import-design`.
It is not an aggregate-green or production-enable approval: the two source-unchanged
Station/inventory concerns and live acceptance requirements remain open. The branch
and local evidence are retained; no push, PR, merge, deployment or cleanup occurred.

## Single final fix wave (historical verification at 703440ebd)

Source/test commit: `10b66d13924a2e82a25c60bcadb0b614457cd292`. All requested final-review corrections are
implemented. The completed scoped re-review addressed all 14 and found residual R1/R2,
tracked in the bounded continuation below. Final
root format and diff checks passed; exact failed-run and scoped-proof limits below
remain part of acceptance. No push, PR, merge, deployment or cleanup was performed.

The one whole-branch review required I1–I6 and M1–M8. The fix scope is API transport,
accepted cancellation and temporary retention, category dependency parity,
review/observation chronology, additive strict contracts and the catalog decision
UI. No DB schema/domain/Rust changes or external enablement were made.

- Redirect/error transfers are destroyed before slot release or a next hop.
- Public cancellation stops accepted core/photo continuation with current access,
  durable cancelled operation state and exact once-only audit, preserving applied
  outcomes and immutable evidence even after TTL/provider configuration changes.
- Per-record bounded cleanup removes expired unconfirmed payloads and impossible
  photo eligibility while retaining identity stubs and legitimate post-TTL photo
  recovery after product success.
- All mapped initial-profile writes require explicit category acceptance. Legacy
  public/authoritative projections gain dependencies and owned labels without
  rewriting stored bytes/hashes.
- An older confirmation cannot overwrite later observation/status or newer failed
  attempt chronology. Pending work retains identity fencing, actor, same-step
  budget and provider delay; changed photo selectors use verified latest data.
- Selection shows supplied brand/status/count/startedAt and cap reason. Review
  shows manual/provider provenance, translated owned labels, direct eligible
  photo retry and totals derived from valid current decisions. Name cells have
  a scoped usable minimum inside the existing automatic scrollable table.

Current focused evidence: transport/status67; actual HTTP cancellation2; lifecycle/
category6; bounded scratch cleanup1; post-TTL accepted-photo recovery1; expiry-ended
core/audit1; old in-flight repair1; selector/newer-error2; full observation23; admin
focused112; strict contract focused19. Filtered selections are not infrastructure
skips. The final result table below separates full runs from later scoped corrections.

| Gate and exact source scope                                    | Result                                                                                               |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Contracts full test/typecheck/test-types/lint/build            | 12 files;100 passed;897ms; all statics/build passed                                                  |
| API full on original fix freeze, actual loopback infra enabled | **FAILED**:3223 passed,1 failed,1 intentional live skip;293 files passed,1 failed,1 skipped;642.28s  |
| API auth fixture correction, no API runtime change             | Complete auth+service DTO/continuation files53/53;52.70s; API typecheck and changed test lint passed |
| Admin full before final layout delta                           | 95 files;1122 passed;179.39s; lint/typecheck/build passed                                            |
| Final layout delta                                             | Catalog/routing/status84/84;11.53s; admin lint/typecheck/build and browser types passed              |
| Browser initial21-case run                                     | **FAILED**:20 passed,1 category-fixture timeout;1.4m                                                 |
| Corrected import browser file                                  | 2/2;7.4s; correct category/provider-label rich-review capture                                        |
| RU/EN context provenance captures                              | 2/2;5.1s; source and totals recorded as separate scroll views                                        |
| Final post-build layout matrix                                 | 16/16;36.1s;390/768/1280/1600 × RU/EN × light/dark; name220/group140 and long-token bounds           |
| Production bundle contracts                                    | 536/536;15.35s after documented sandbox-only execution failure                                       |
| Relevant CI contracts                                          | 38/38;944.73ms                                                                                       |

The API full failure was a fixture inserting ready checkpoint={}, which the newly
exposed automatic-work projection correctly could not parse as v1. Known current
and reviewed producers always created valid v1; the fixture now uses terminal v1
and keeps exact READ200/WRITE403/foreign404 plus automaticWorkPending=false. No
speculative runtime legacy fallback was added. The full run remains FAILED; its
later53-case proof is not a new full-green claim.

Full API result metadata was copied before later focused commands overwrote the
Vitest cache. [Selected results](final-fix-api-full-selected-metadata.json) show
local-infrastructure969.17ms, provision-tenant-owner18165.75ms, inventory lifecycle
4512.25ms, documents3750.74ms and snapshot3296.66ms, all failed=false. Mailpit/MinIO
and inventory execution is therefore confirmed from actual results, not only the
LOCAL_INFRA_SMOKE flag. The sole live skip remains intentionally unconfigured.
Both owned loopback migration journals were freshly checked read-only at exact0122,
timestamp1788925596383, SQL sha256
559d55d190df3a0948f53a0d5f20fb5a84bdce4ee3e4ff6e0c263f952776e429.

At the initial fix-wave freeze there was no single all-green21 browser run. Its distinct coverage comprised the
unchanged original flow1, corrected import2, RU/EN contexts2, and final layout
matrix16. The initial failed run is retained. The group correction was required
because the first name minimum squeezed Group to49.1875px; final group minimum140
and safe long-token wrapping fix that introduced regression. Additional horizontal
scrolling is deliberate, not a claim that every column fits1280px simultaneously.

Source history remains explicit: original148-file freeze; the
[import-fixture delta](final-fix-source-freeze-post-fixture.json); the
[provenance capture delta](final-fix-source-freeze-final.json); and the
[final layout/auth fixture delta](final-fix-source-freeze-post-layout.json).
A final [delivery capture-only delta](final-fix-source-freeze-delivery.json) adds
the already verified1600RU catalog screenshot; only that case reran,1/1.
API runtime and contracts remain on the original fix freeze. Final admin layout
changes catalog index/CSS only; the full1122 admin result predates those two files,
which have the fresh84-case/static/build/matrix evidence above.

Current visuals: [catalog with full CHZ status](final-fix-layout-catalog-1600-ru-light.png),
[1280 name/group scroll tradeoff](final-fix-layout-catalog-1280-ru-light.png),
[mobile English review](final-fix-layout-review-390-en-dark.png),
[capped selection](final-fix-selection-1280-ru.png),
[manual provenance](final-fix-provenance-1280-en.png),
[confirmation totals](final-fix-confirmation-1280-ru.png),
[category/provider rich review](final-fix-recovery-rich-review-1280.png).
The [final visual manifest](final-fix-visual-manifest-delivery.json) records43
wave images including16 new layout images plus one1600RU delivery catalog; all26 earlier wave images and24
historical Task12/13/14 images retain their original bytes. These are controlled
local appRoutes/MemoryRouter fixtures and synthetic media, not production/provider
or native browser address-bar history proof.

The initial tracked [source manifest](final-fix-source-freeze.json) freezes148 whole-branch
changed non-doc files for full API/admin/contracts verification. Previous Task14
results below are historical for changed code; unchanged domain633/DB401 and other
package evidence remain reusable. The Station aggregate stays **failed** with1389
passed/1 failed; its separate unchanged file13/13 does not turn it green.

All111 previous ruling lines remain byte-exact; six new complete rulings/costs are
appended below, followed by two final scoped rulings (119 total). The final retention auto-review rejection happened
before execution; the literal combined command is unavailable after compaction,
so it is not reconstructed as exact. The exact reason was: “The action introduces
production retention code that irreversibly scrubs import/session/preparation
payloads and alters receipt and operation states across multiple record types; the
root user request does not explicitly authorize this broader destructive cleanup
scope.” Read-only approved-spec200–202 and original execution-approval checks
established scope. Reversible source-only patching and a separate guarded uniquely
owned disposable scratch DB proof were accepted. The user was informed by the
controller; current blocker is none. W/final-fix-approval-rejection.log preserves
the exact available tool reason and limitations. No rejected command was repeated.

A separate early future-now fixture iteration selected eligible expired transient
payloads in the dedicated task test DB ahead of its target. The final production-path
tests use an owned expired target/limit1 or an owned disposable scratch DB; no
manual global cleanup or larger limit was used. No claim is made that every old
transient fixture remained byte-identical. Products, accepted evidence and audit
remain protected and asserted.

Production-contract default-sandbox execution separately failed525/536 due to
pnpm SQLite cache access, Docker/Podman socket and loopback-listen restrictions;
that is an execution failure, not an automatic approval rejection. The unchanged
contract suite passed536/536 with local escalation. UI fixture failures and the
I1 double-destroy iteration remain in the log ledger, not relabeled as final proof.

## Task14 automated verification before the final fix wave

The frozen aggregate **FAILED**: 46 successful of52 tasks, 4m53.918s,
with one unchanged Station test failing (1389 passed,1 failed). The failing
`test/inventory-repacking-work.test.tsx:174` expected the remove-last-bottle control
after clicking corrections. The complete unchanged file passed13/13 in2.79s
when run alone. A transient disabled corrections button during an existing remote
reprint check is a source-based timing hypothesis, not a demonstrated root cause.
No Station change or broad retry was made. This concern remains for independent review.

The five canceled gates (admin test/build, API lint/test, Station typecheck) receive
separate final-source evidence below. The API suite and non-DB admin→build→API lint→
Station typecheck chain had already started concurrently when the controller's
sequential-only refinement arrived. No second DB/API/inventory workload overlapped;
subsequent browser/contracts gates run after both chains. No aggregate-green claim
is made. Earlier task counts are commit-specific history, not final-code proof.

| Frozen aggregate package test | Result                       |
| ----------------------------- | ---------------------------- |
| @markiro/ui                   | 171 passed (171)             |
| @markiro/domain               | 633 passed (633)             |
| @markiro/email                | 23 passed (23)               |
| @markiro/legal-documents      | 146 passed (146)             |
| @markiro/platform-contracts   | 99 passed (99)               |
| @markiro/db                   | 401 passed (401)             |
| @markiro/signer               | 34 passed (34)               |
| @markiro/kiosk                | 617 passed (617)             |
| @markiro/landing              | 215 passed (215)             |
| @markiro/saas-admin           | 241 passed (241)             |
| @markiro/station              | 1 failed; 1389 passed (1390) |

All four lint/typecheck/test/build gates completed for domain, UI, email, legal
documents, contracts, DB, Signer, Kiosk, Landing and SaaS admin. API build/typecheck,
admin lint/typecheck and Station lint/build also completed in the failed aggregate.
Separate final-source results: admin95 files/1111 tests,148.84s; admin build,
API lint and Station typecheck passed. API full test:294 files passed/1 skipped;3205 tests passed/1 skipped,529.58s,
start10:46:34. The only skip is `national-catalog.live.test.ts`, whose provider
base URL/source tenant/live GTIN are intentionally absent. Final Vitest result
metadata confirms local-infrastructure858.94ms, provision-tenant-owner16087.36ms,
inventory lifecycle4093.64ms, documents3072.21ms and snapshot2823.26ms, all passing;
other inventory e2e files also have nonzero passing durations. Thus the local
Mailpit delivery/capture, MinIO private avatar lifecycle and isolated inventory
DB cases actually ran; this is not inferred from the environment flag alone.
The live file alone has0 duration. Browser/contracts final results follow below.

Final serial Chromium browser:19/19 passed,45.3s, zero retries/skips, after both
completion chains finished (`task-14-browser-serial-final.log`). Production bundle/
configuration contracts:536 passed,0 failed/skipped,9.903s
(`task-14-production-contracts-final.log`). Scoped CI contracts remain38/38.
Root `format:check` and `git diff --check` passed after final documentation.
The final portability scan found no private host/worktree/DB paths in the140
frozen code/config files, whose SHA256 values remain unchanged. Final after-all
snapshot07:57:28.104Z found0 databases/0 connections matching the same36 scratch
prefixes; separate read confirmed0 owned `nc_test_` schemas. No database cleanup
was performed by these read-only checks. The original interrupted-run teardown
uncertainty remains. Log files: `task-14-format-final.log`,
`task-14-freeze-portability-final.log`, `task-14-scratch-after-all.log`,
`task-14-queue-cleanup-final.log`.

| Focused final verification                      | Result                           | Log in W                             |
| ----------------------------------------------- | -------------------------------- | ------------------------------------ |
| DB migration independent scenarios (`-t`)       | 2 passed,14 filtered skips;1.50s | task-14-migration-selected-green.log |
| Complete migration file                         | 16 passed;1.73s                  | task-14-migration-file-green.log     |
| Admin state/import files                        | 66 passed;13.56s                 | task-14-admin-focused-final.log      |
| API image/auth/device files                     | 40 passed;11.86s                 | task-14-api-focused-final.log        |
| Actual target GC/inverse cases                  | 2 passed,23 filtered skips;1.74s | task-14-gc-green.log                 |
| Scoped expected413 logging                      | 1 passed,10 filtered skips;4.31s | task-14-413-green.log                |
| Two real local PgBoss instances                 | 1 passed,25 filtered skips;3.94s | task-14-pgboss-first.log             |
| Existing Kiosk product-images                   | 4 passed;516ms                   | task-14-kiosk-images.log             |
| Existing Station product-image-cache            | 9 passed;1.11s                   | task-14-station-images.log           |
| CI workflow/classification/results contracts    | 38 passed,0 skipped;822ms        | task-14-ci-contracts.log             |
| Production-browser typecheck including NC specs | passed                           | task-14-browser-typecheck-final.log  |

Filtered skips above are unselected cases, not missing infrastructure. Artifact
capture passed19/19 in46.0s, producing the20 tracked Task14 PNGs. Earlier serial
19/19 in45.3s predates the distinct valid GTIN fixture correction. The subsequent
concurrent browser18/1 failure is retained below; final serial evidence is separate.

The final source/config freeze manifest covers140 files relative to the approved
base; SHA256 `2afb43803307834f49f55dcdd23f9ee40738a4e8752477d4a767ff7498eadc75`.
Both isolated DB journals match migration0122_watery_molten_man at timestamp
`1788925596383`, SQL SHA256
`559d55d190df3a0948f53a0d5f20fb5a84bdce4ee3e4ff6e0c263f952776e429`.
No migration or production flag change was made in Task14. The frozen source
manifest is rechecked after the final gates; documentation is outside that manifest.

## Evidence and reproduction

The exact local runner is the isolated worktree's ignored
`.superpowers/sdd/2026-09-08-national-catalog-product-import/run-pnpm` (called `P`
in command records). It supplies Node24.18, Corepack/pnpm11.22, CI=true and this
worktree's absolute private `.env`, never root/default DB credentials. Local DB/API
commands prepend the no-I/O exact isolated URL preflight with both loopback DBs.
`LOCAL_INFRA_SMOKE=1` enables only the prepared local Mailpit/MinIO cases.
No broad DB/API/inventory workloads overlapped. The aggregate uses
explicit `--env-mode=loose` because the existing Turbo test env allowlist omits
inventory and local-infrastructure variables. A same-command no-I/O preflight also
checks resolved SMTP loopback1025, S3 HTTP loopback9000, and absent provider baseURL/
image hosts with disabled import flags. No persistent Turbo policy was changed.

For portable reproduction, install repository-pinned dependencies, configure an
isolated local test environment, apply migrations to both main/inventory test DBs,
verify their URL scope and migration journals, and run the recorded pnpm commands.
The private local runner and environment are not production configuration artifacts.

## Exact final command record

All commands ran from the isolated worktree. `P` means the absolute path
`/Users/thevladbog/PRSOME/q/.worktrees/national-catalog-import-design/.superpowers/sdd/2026-09-08-national-catalog-product-import/run-pnpm`.
`W` means that path without `/run-pnpm`. `G` means
`/opt/homebrew/opt/node@24/bin/node --env-file=/Users/thevladbog/PRSOME/q/.worktrees/national-catalog-import-design/.env "$W/task-14-preflight.cjs"`.
These abbreviations describe the exact invocation; no default/root environment was used.

```sh
LOCAL_INFRA_SMOKE=1 G && LOCAL_INFRA_SMOKE=1 P turbo lint typecheck test build --concurrency=1 --force --env-mode=loose
P --filter @markiro/station exec vitest run test/inventory-repacking-work.test.tsx
G && P --filter @markiro/db exec node "$W/task-14-scratch-inventory.cjs" after && LOCAL_INFRA_SMOKE=1 P --filter @markiro/api test
P --filter @markiro/admin test && P --filter @markiro/admin build && P --filter @markiro/api lint && P --filter @markiro/station typecheck
P --dir tools/production-browser --ignore-workspace test:national-catalog
P test:production-bundle:contract
P format:check
git diff --check
```

The final API command's no-I/O guard checked the actual environment loaded by the
same absolute runner; its intervening scratch operation was read-only on that
same isolated cluster. API file parallelism is false. The earlier final artifact
capture used `NC_UPDATE_SCREENSHOTS=1 P --dir tools/production-browser --ignore-workspace test:national-catalog`.
All raw execution logs remain under `W/task-14-*.log`; the results and limits here
are the tracked record and survive eventual separately authorized SDD cleanup.

## Historical failures and focused corrections

- Task2 selected migration scenarios failed because no earlier test created the
  target link/receipt graph. Explicit prerequisite helpers now make both selected
  scenarios and the complete file pass without weakening constraint assertions.
- Task9 attacher-first GC now observes the actual collector waiting on the one
  target row locked by its attacher. The inverse collector-first case still proves
  no activation after a committed deletion claim; storage is outside the lock.
- Task11 expected oversized HTTP input remains413. A narrow scoped logger capture
  asserts the expected entity-too-large error; unexpected diagnostics are forwarded.
- A schema-valid100-position×60-field intent failed the old200000-character guard.
  Its exact request now round-trips under the existing transport bound. The guard
  measures UTF-16 units, not bytes or guaranteed browser quota. Corrupt/unavailable
  storage and unknown-result protections remain intact.
- Failed receipt rows without productId now expose display position plus full stable
  previewId, including RU/EN, without expired-preview dependencies or guessed names.
- Task14 iteration-only failures: an unsupported test reason triggered the existing
  missing-i18n-key assertion; then an unavailable jest-dom matcher failed a combined
  test after state tests passed. Browser iterations found an ambiguous duplicated
  status selector and an invalid null lastOutcome fixture (the strict schema
  requires never). API typecheck caught queue URL narrowing and pg-boss generic
  metadata typing. These were fixture/type setup corrections, not new product RED.
  Final successful commands are reported separately from these failed iterations.
- First aggregate was intentionally interrupted (exit130) after self-review found
  an unused test local. It had reached DB Vitest RUN with no DB file result; Turbo
  reported force-killing that owned DB task. API/admin broad tests had not started.
  A subsequent scoped lint also found the synthetic-photo constant import unused
  because the literal-deduplication edit had not applied. Both test-only issues
  were fixed, then all changed-code lint and root formatting passed before a new
  freeze. The interrupted attempt is never accepted as an aggregate pass.
- Browser rerun concurrent with shared package builds passed18 and failed1 photo
  keyboard assertion. Trace records an unrequested second review-document GET at
  07:37:50.681Z after the explicit review GET at07:37:49.837Z, with Vite reconnects
  during shared dist rebuild. Build-triggered reload is the inferred cause. Final
  browser acceptance runs serially after the aggregate; assertions/retries are not
  weakened. An earlier artifact recapture was stopped at exit130 when a fixture
  GTIN replacement proved incomplete, then corrected and rerun.
- A read-only snapshot over36 source-derived temporaryDB prefixes at07:38:28.205Z
  found0 matching databases and0 connections. It was taken during the corrected
  DB suite (start10:37:52MSK), not before that suite. Thus first-attempt random DB
  teardown and a true before/after baseline cannot be inferred; no unattributed
  database was deleted. A post-aggregate snapshot at07:46:34.278Z found the same0/0 across36 prefixes.
  Its initial sandbox attempt was denied with connect EPERM before DB I/O; the
  same guarded elevated read succeeded. This is a sandbox limit, not an automatic
  approval rejection. The final after-all-gates snapshot is recorded below.

Historical broad failures remain failures: Task4 old environment2906pass/2signerfail/
50skip; Task6 full3026pass/1CLI failure/1live skip; Task8 full3102pass/1mock failure/
1live skip; Task10 full3161pass/3registry fixture failures/1live skip; Task11 full3199
pass/2metadata-inventory failures/1live skip. Each had documented focused correction.
Task9 full3137 and Task12 full3202/1external-live skip predate their review fixes.
Task12 fulladmin1034 and Task13 fulladmin1074 also predate review fixes. They do not
substitute for Task14 final frozen aggregate results.

## Local and external proof boundaries

Browser tests use real appRoutes, auth/access and identity/query wrapper ordering,
strict controlled responses, multiple products and synthetic local WebP. The16-case
matrix covers390/768/1280/1600 ×RU/EN ×light/dark. Current responsive structure is a
scrollable automatic-layout table at every width; cell-content/control bounds and
scroll reachability are separate assertions. Explicit saved-route reopen/reload
under MemoryRouter does not prove address-bar navigation in production.

Representative tracked artifacts include
[1280px RU/light catalog](task-14-catalog-1280-ru-light.png),
[390px EN/dark review](task-14-review-390-en-dark.png), and
[full link detail](task-14-status-link-1280.png). Twenty Task14 PNGs retain matrix
catalog/review evidence at390/1280 for both languages/themes plus recovery/status
captures. Capture is opt-in (`NC_UPDATE_SCREENSHOTS=1`); CI writes only disposable
failure traces/screenshots under `tools/production-browser/test-results/national-catalog`.
The existing production-bundle job installs pinned Chromium and uploads failure
artifacts for14days. No remote CI run was performed; workflow contracts are local.

Implementer/controller visually inspected representative final catalog/review
artifacts. At1280 the automatic table wraps product names narrowly; this is a
remaining nonblocking UX observation, not a status/action overlap or a claim that
all catalog typography is ideal. Native panel/table scrolling remains intentional.

The actual local PgBoss test commits an accepted image receipt, throws a synthetic
lost acknowledgement, stops that worker instance, then starts a second PgBoss
instance on the same owned queue. Same job ID/retryCount1, exact unchanged receipt/
applied evidence/audit rows, one active image and one download prove durable retry
and real service idempotency. The test always stops instances and drops only its
random owned queue schema. It does not restart an OS process, the AppModule
scheduler or all enumeration/apply/photo stages. Its media transport/store remain
controlled; local MinIO/Mailpit acceptance is a separate infrastructure suite.

The successful HTTP import fixture uses real HTTP/BetterAuth/services/Postgres but
instance-only suppressed PgBoss startup and manual worker resumes to avoid duplicate
autonomous/manual execution. Dedicated auth/jobs/localPgBoss tests provide separate
coverage. Device-access-named image tests use direct controller mocks; they are not
liveHTTP authorization proof. Existing Kiosk/Station cache tests exercise host code,
not physical offline restart/reconnect, Windows hardware, printer or scanner.

No real CHZ/provider/CDN request, token, tenant ownership acceptance, photo host
validation, protected deployment, DNS, cloud service, external message, paid action,
push, PR or merge was performed. Live own-list date/timezone/413/catch-up, own/granted
card identity and no-public-fallback, actual photo hosts/redirect/no-bearer, quotas/
429/recovery and process restarts remain unchecked in the
[enablement checklist](../../runbooks/national-catalog-import.md#live-acceptance-before-limited-enablement).

## Retained findings and resolved execution incidents

Remaining warnings: pre-existing pg concurrent-client-query deprecation, Vite native
config warning, jsdom canvas/navigation notices, React hooks warnings and build chunk
size warnings, NO_COLOR/FORCE_COLOR precedence warnings, and expected injected-failure
stacks from fault-injection tests. Injected exceptions are intentional only where
the test asserts that failure path; unexplained diagnostics remain evidence, not
automatically accepted noise. No unrelated dependency/framework cleanup is claimed. Dispatch-attempt
fairness history remains intentionally retained with ongoing storage cost and tenant
cascade; extra ledger GC is deferred. Real provider/physical acceptance stays parked
behind disabled flags. The Task2/9/11 focused test improvements and Task12 capacity/
receipt-identification observations are addressed here; Task13 has no deferred minor.

Task10 wrong-cwd incident failed at static import ERR_MODULE_NOT_FOUND before any DB
I/O; no root environment/database mutation occurred. Task11 had two resolved automatic
approval rejections: an arbitrary105-tenant fixture was refused before execution,
then replaced by owned scratch data, guard and finally cleanup; an unguarded HTTP test
command was refused, then rerun with same-command exact isolated URL preflight.
The old approval-rejection artifact contains command summaries and exact reasons,
not literal complete command transcripts. These are resolved incidents, not current
approval blockers. No scratch or unrelated root work has been deleted.

## Chronological decision appendix

Every `Ruling:` line below is preserved verbatim from the current execution ledger,
including its cost. Ledger line numbers are provenance, not source-code locations.
Controller adds later review rulings before any disposable SDD cleanup.

Captured 111 rulings.

1. Ledger line 93: Ruling: Create the shared ImportActor/ImportContext/DbTx type file in Task5 when first consumed, with Task6 reusing it — the plan schedules its file one task too late — cost if wrong: small type-only move.

2. Ledger line 94: Ruling: Task8 integration tests use the real apply service plus Postgres until Task11 wires HTTP; Task11 runs the full HTTP matrix — the plan otherwise requires routes before their implementation task — cost if wrong: duplicated fixture adaptation, no reduced final coverage.

3. Ledger line 95: Ruling: Keep selected staged photo bytes referenced by an accepted durable operation until its photo outcome is terminal; only unaccepted previews expire at24h — retry must remain meaningful after a successful product write — cost if wrong: longer temporary object retention.

4. Ledger line 109: Ruling: Permit a scoped @markiro/domain workspace dependency and pnpm-generated lockfile change in Task1 — sharing the existing validator is the binding repository rule and requires the dependency absent from the original file list — cost if wrong: additional internal package coupling/build ordering, no new external dependency.

5. Ledger line 110: Ruling: Add an explicit WRITE endpoint to prepare an alternative photo candidate, while private GET only serves staged bytes — the plan service exists but omitted its invocation path for user-selected alternatives — cost if wrong: one additional scoped endpoint/client method, avoids eager download of every photo. Applies Tasks9/11/12.

6. Ledger line 118: Ruling: Request coordinator context is server-derived tenant/environment; periodic observation refresh uses a system actor while queued user mutations recheck their actual initiator — binding refresh forever to a historical employee would stop tenant status updates after staff changes — cost if wrong: system observation policy needs adjustment; accepted fields/photos remain protected. Applies Tasks5/10/11.

7. Ledger line 124: Ruling: Provider list parser preserves GTIN strings without checksum rejection, while import item validation makes invalid GTIN rows visible and nonselectable — one malformed business code must not discard every sound row on a provider page; existing identifier parser already preserves strings — cost if wrong: stricter provider-validation expectations would require relocating a check, no invalid product can be accepted. Applies Tasks3/6.

8. Ledger line 125: Ruling: Add server-only normalized imageIssues with source ID and bounded reason codes; malformed photo collections are ignored with a reason while retaining a valid card — the plan requires reasons but its normalized photo contract omitted them, and photographs are optional — cost if wrong: one additive internal field and fixture updates; no raw URLs or new browser contract. Applies Tasks3/7/9.

9. Ledger line 126: Ruling: Move the initial failing browser harness assertion to Task12 before UI implementation; Task14 extends and runs the complete browser flows — Task14 cannot demonstrate a missing-UI RED after Tasks12/13 already created it — cost if wrong: earlier test scaffold/config ownership, final scope and coverage unchanged. Applies Tasks12/14.

10. Ledger line 128: Ruling: Validate expected image descriptor in the separate image-swap transaction, not as a reason to roll back accepted product fields — spec§8 and Task9 preserve product success when the photo conflicts; Task8 wording bundled old-image checks too early — cost if wrong: product may already be applied when a new photo comparison is required, explicitly shown as separate outcomes. Applies Tasks7/8/9.

11. Ledger line 135: Ruling: Add route-scoped bounded JSON parsing for National Catalog import requests before the ordinary express.json parser; permit main.ts and a focused middleware/test helper in Task11 — production currently defaults to100KB and cannot carry the approved100000-GTIN input — cost if wrong: one scoped middleware boundary requiring bootstrap regression tests; other routes retain existing limits.

12. Ledger line 144: Ruling: Extend the new coordinator callback with a request transport context carrying an AbortSignal and metadata observation; allow compatible optional client options/list signature additions in Task5 — the current no-argument callback cannot enforce a real15s abort or retain quota headers on non-ok responses — cost if wrong: additive internal interface surface and focused legacy-client regression tests. Existing public result unions and standalone configurable timeout semantics remain compatible.

13. Ledger line 151: Ruling: Add nullable persisted token source_true_api_base_url in a new forward migration and set it from validated Signer task payload; new catalogue auth refuses unknown/mismatched provenance. Reject stale-environment Signer completion under channel lock and idempotently request fresh auth without deleting the current token — current channel settings cannot prove bearer origin after an environment switch — cost if wrong: additive migration and deliberate stale-completion behavior change, with possible future overlap with separate root Signer work. No backfill or root changes; legacy getActiveToken contract otherwise preserved.

14. Ledger line 152: Ruling: CDN photo preparation uses a token-free runExternal callback under the same tenant lease/process semaphore/deadline and conservatively observes nextAllowedAt — spec applies concurrency to new NC external operations, while photo hosts must never receive bearer auth — cost if wrong: photo preparation may wait on an exhausted catalogue quota; accepted cached photo application remains independent of external requests.

15. Ledger line 153: Ruling: Coordinator performs one actual attempt per call and returns typed scheduling/blocked/exhausted outcomes; consuming durable jobs store attempts and nextRetryAt, with no sleeping in a slot or transaction — preserving retry state belongs to the durable operation, not process memory — cost if wrong: consumer integration must consistently persist the retry contract. Lease-busy/quota-deferred do not consume an HTTP attempt.

16. Ledger line 159: Ruling: Require an explicit CatalogAttempt third argument on coordinator run/runExternal instead of defaulting to attempt0 — no new-flow consumers exist yet and an optional fresh default undermines durable retry state after restart — cost if wrong: small call-site argument change versus provisional internal2arg signature. Retry budget is per logical request/checkpoint; a successful next page starts its own request, while current-step retries remain durable.

17. Ledger line 168: Ruling: Retain pre-existing Vite configuration and pg query deprecation warnings as disclosed nonblocking test noise rather than widening import work into toolchain cleanup — no changed Task5 behavior caused them — cost if wrong: warnings continue to obscure otherwise passing output until separately addressed.

18. Ledger line 173: Ruling: Add optional internal expectedStepId to resume plus durable checkpoint stepId; completed-step replay mismatches become no-op, while two-arg resume processes the current step. Keep selection revision independent of enumeration step CAS — the plan requires same-checkpoint replay without giving its identity in the original signature — cost if wrong: one additional internal job payload field and optional service argument.

19. Ledger line 175: Ruling: Reject selection of distinct card IDs for the same normalized GTIN atomically with422 while keeping every candidate visible — the approved flow requires an explicit single card choice, and competing choices cannot both own one product GTIN — cost if wrong: a user must split unusual successive-link actions into separate imports.

20. Ledger line 177: Ruling: Extend AuthorizationService.resolvePrincipal with a compatible optional transaction-capable select executor in Task6, with focused auth regression tests; new session processing rechecks write access/subscription/integration under its lock — calling the injected pool inside a transaction needlessly acquires another connection and weakens coherent revalidation — cost if wrong: one additive shared-service parameter. Keep generic auth types and default legacy behavior.

21. Ledger line 179: Ruling: Task6 constructor accepts explicit off-by-default feature gates; production Nest/env registration remainsTask11 — service tests need a deliberate enablement seam before route wiring exists — cost if wrong: minor constructor wiring adaptation atTask11, no prematurely exposed feature.

22. Ledger line 181: Ruling: Add explicit retry(actor,sessionId) for failed/recoverable blocked session work within24h, plus POST /national-catalog/import-sessions/:sessionId/retries with strict empty body and WRITE+subscription atTask11 and retryImportSession UI/client atTask12 — the approved manual partial-retry flow had no service/API entry point in the plan — cost if wrong: one additional scoped endpoint/client action. Preserve successful work and do not reset an already queued/running cycle on double click; resume never resets budgets.

23. Ledger line 183: Ruling: Tighten shared importItemsQuerySchema to limit1..100 and search<=500 inTask6 with schema boundary tests and contracts gates — current Task1 schema allows1000/unbounded search, contradicting Task11 explicit API bounds — cost if wrong: smaller maximum internal page size; keep one shared constraint rather than divergent HTTP validation. Accepted field IDs receive no unrelated count cap.

24. Ledger line 185: Ruling: Add bounded unique selectedItemIds (max100 UUIDs) to ImportSession DTO, read from saved tenant/session selection — selected count alone cannot restore choices on other pages after reload without scanning up to100000 rows, and subsequent selection could discard hidden choices — cost if wrong: one additive shared response field and bounded selection query; no new DB column or endpoint. AppliesTasks6/11/12.

25. Ledger line 188: Ruling: Fix coordinator deferral timestamp using Drizzle timestamp mapper and add a realDB Date-type assertion withinTask6 — durable consumer toISOString reveals the existing typed-SQL assertion was insufficient — cost if wrong: two focused dependency files added toTask6; no change to intended retry semantics. Preserve historical Task5 evidence and verify amended boundary now.

26. Ledger line 192: Ruling: Keep Task6 planned session service/repository/enumeration structure despite formatted service655lines — it remains one bounded state machine with persistence/pure transformations already separated, and future shared consumers are not yet implemented — cost if wrong: larger review surface and later access/driver extraction. Independent quality review still checks duplication and method cohesion; file length alone is not an exemption.

27. Ledger line 195: Ruling: Keep GTIN feed item.access nullable when provider proves own-or-delegated access without classifying which; retain server-owned feed provenance forTask7 and re-fetch chosen card there — guessing own/provided would invent ownership — cost if wrong: consumers must distinguish unknown classification from unverified access using trusted source/session provenance. Own-list rows may use own; no new enum/backfill.

28. Ledger line 199: Ruling: Expose internal assertSessionAccess(tx,actor,lockedSession) inTask6 and route applicable commands through it — Task7 now has a concrete need to reuse current auth/TTL/mode/subscription/integration checks while holding its session lock — cost if wrong: one internal method; caller must obtain a fresh locked row and helper independently denies tenant mismatch. No new HTTP endpoint/file.

29. Ledger line 202: Ruling: Finish current fullAPI run and rerun failed CLI plus amended focused session/auth/helper/coordinator checks, without repeating fullAPI solely for the corrected type-only annotation — its runtime is unchanged and scoped fresh gates cover the amendment — cost if wrong: original full run remains reported as failed with targeted corrected evidence; Task14 must still run full final branch gates. Reassess if new substantive failures appear.

30. Ledger line 208: Ruling: Valid active feed candidates for nonarchived products remain selectable as other_link when current link card/environment/boundGTIN differs; only exact three-way identity is linked — approved design resolves old identity through a fresh comparison and explicit replacement, not blanket exclusion — cost if wrong: additional explicit replacement route for stale old-link identity. Task6 never mutates link/product; Task7/8 must require replacement confirmation and fresh access proof. Archive/invalid/access denials remain nonselectable.

31. Ledger line 224: Ruling: Add one tenant/session-scoped durable preparations table with canonical request/bodyhash, current initiating actor, step/run IDs, bounded work/failure checkpoints, attempts/nextRetryAt/enqueuePending and completed preview IDs; split Task7 scheduling service, immutable preview-builder and preparation-state parser — quota/retry/crash recovery cannot be expressed by the plan's synchronous items-only response and no pending fakepreview/hash is allowed — cost if wrong: one forward migration and focused module/API surface expansion.

32. Ledger line 225: Ruling: ImportPrepare gains required requestId UUID; uniqueness is tenant/session/requestId, sameID/same canonicalbody replays and sameID/differentbody409, while a genuinely fresh comparison uses a new requestId even for identical selectedinputs — deduplication by requestHash alone would trap stale product/source comparisons for the entire session — cost if wrong: additive new-flow request requirement and UI persistence of retry identity, no legacyclient affected. Newrequest does not extend originalsessionTTL; category/manual corrections issue newimmutablecomparison.

33. Ledger line 226: Ruling: Task7 prepare returns {preparation:ImportPreparation,items:ImportPreview[]}; add sideeffectfree GET /national-catalog/import-sessions/:sessionId/preparations/:preparationId and strict-empty WRITE+subscription POST .../:preparationId/retries, plus durable resumePreparation/Task11 queue-repair seam — UI must observe pending/partial/retry state without GET-triggered external requests or resetbudgets — cost if wrong: two scoped routes and client actions. Completed siblings and safe peritem failures retained; manualretry resets only recoverable work, never a runningcycle.

34. Ledger line 227: Ruling: ImportPhoto gains nullable safe reason and selectedByDefault; rejected provider photo sources may appear as failed opaque candidates with no URL, valid candidates remainpending untilTask9 — approved photo alternatives/errors/defaultchoice were not expressible by the initial DTO — cost if wrong: two additive strictschema fields and later UI mapping. Existinglocalimage defaultskeep, malformed/foreignbarcode never silently becomes defaultunbarcodedfallback.

35. Ledger line 235: Ruling: Valid photos carrying another GTIN remain explicit manual alternatives with barcode_mismatch warning, never any automaticdefault/fallback; malformedbarcode remainsfailed and never unbarcoded — approvedtext prohibits automatic selection, not a deliberate alternative choice — cost if wrong: user can deliberately choose a different-packagingphoto and UI must preserve a clear warning. Task7 retains privateURL/pending/defaultfalse; Task9 ready-state overlay preserveswarning; Task12 showswarningbesidealternative. No extraapproval dialog beyond explicitcandidate/replacement choice.

36. Ledger line 239: Ruling: Stored readPreparation must be tenant/session-scoped and use the same read-boundary pattern as other saved-resource APIs, without WRITE/subscription-write/feature/integration mutation gates; actual READ authorization remainsTask11 HTTPguard — saved results mustremainreadable when writes becomeunavailable — cost if wrong: a small readsignature/guard-boundary adjustment, with explicit realHTTPpermissionmatrix owedTask11. Prefer tenantId-based readsignature. Preserve404foreignIDs/noexternalwork; expired/cancelled preparation musthave a truthful terminal/410 response so pollingends. Worker toconfirmminimalclosedstateprojection and addfocusedregressions beforefullgate.

37. Ledger line 242: Ruling: Explicit validated manualNames value takes precedence over provider good_name and produces source=manual; absentmanualinput usesvalidatedprovidername. good_name priority applies only against duplicate attribute-to-name mapping, notusercorrection — spec§5 andTask8 requiremanualprovenance andinvalidsource repair — cost if wrong: manualinput can override a validprovidername deliberately, withvisiblemanualsource andfreshrequestID. Stillone targetnameentry. RequiredRED/GREEN for201charproviderrepaired andvalidproviderdeliberatelycorrected; reportfallback-onlywordingmustchange. No independent newfeature scope.

38. Ledger line 254: Ruling: Add optional fourth actorUserId to ProductsService.updateProduct and pass current authenticated controller user; explicit detach requires it. Reuse a dependency-free transaction-only National Catalog link close helper for tenant/revision/history/audit in both product update and link service — the existing update signature lacks the actor required for truthful closure audit, and service injection would create a module cycle — cost if wrong: one compatible internal parameter and shared helper, with existing no-detach callers unchanged.

39. Ledger line 255: Ruling: Add strict ChzLinkDetail {summary,link:null|{id,revision,cardId,environment,boundGtin14,confirmedAt}} and scoped readDetail; keep compact ChzSummary for catalogue and omit confirmedBy from the new detail DTO — the link panel must compare the exact current card and show its binding, which summary cannot reconstruct — cost if wrong: one additive new-flow DTO/method; actor remains in audit/history and may need a later explicit display field.

40. Ledger line 256: Ruling: Add required nullable productReason/imageReason to new import result items while retaining reason=productReason??imageReason; reuse persisted errorCode/imageErrorCode without migration — independent product/photo outcomes must not overwrite or misattribute errors — cost if wrong: two additive strict response fields, with later clients required to consume them.

41. Ledger line 257: Ruling: Extract existing applyProposal body and its necessary transaction helpers into ProductRegulatoryWriter, and product creation/normalization/readiness/EGAIS helpers into ProductWriter, with existing services delegating and preserving standalone transaction semantics — sharing the proven writer is required for one atomic import transaction without recursive service/pool calls — cost if wrong: broader existing-file diff and regression risk, covered by pre-extraction guard tests; no unrelated restructuring or DI cycle.

42. Ledger line 260: Ruling: Split Task8 into apply service for durable request/orchestration, apply-item for one-position atomic checks/writes, and apply-state for versioned persisted parsing/canonical decisions; link writer/service stay focused — the required transaction/state behavior otherwise produces a single roughly1000-line service — cost if wrong: two additional internal files and review navigation; reuse actual existing helpers and avoid speculative exports or splits for line count alone.

43. Ledger line 262: Ruling: Permit persisted category_binding proposals with source national_catalog only when snapshotId is nonnull and sourceRef exactly matches nationalCatalogSnapshotSourceRef(snapshotId); validate actual snapshot tenant/product/selected identity on apply. Keep category_change manual-only and all other legacy denials — initial imported category needs genuine snapshot provenance, which the previous parser allowed only for attribute imports — cost if wrong: a narrow existing persisted-contract extension; parser denial and realPG atomic provenance regressions required.

44. Ledger line 264: Ruling: Preserve the immutable issued preview sourceHash when materializing its snapshot instead of recomputing JSON.stringify over JSONB-read source; validate stored envelope types/identity separately — JSONB reorders object keys and the original Task7 hash is order-sensitive — cost if wrong: source digest verification depends on trusted immutable server storage rather than re-hashing reordered JSON; no client-provided hash is trusted.

45. Ledger line 265: Ruling: Introduce the narrow shared meaningful-projection helper when Task8 first needs a reviewed baseline, using full supported converted source values (including unchanged), bound-GTIN filtering and known selected normalized photo checksum; reuse canonical JSON hashing and existing mapping conversion. Exclude provider status/raw metadata/URLs/order/random entry IDs/current local values/manual correction from source projection; Task10 adds actual-current-difference semantics — hashing the whole normalized card would incorrectly mark status-only or unsupported changes as unreviewed fields — cost if wrong: small Task10 helper work moves into Task8 and may need refinement when photo/status consumers integrate; never store a raw-card placeholder as meaningful evidence.

46. Ledger line 273: Ruling: Add nullable versioned appliedEvidence JSONB to import operation items via forward0119; on product success atomically store actual materialized/reused snapshotId/sourceRef/sourceHash and relevant accepted entries/source/before-after, immutable thereafter while photo outcomes evolve — canonical intent cannot know the actual deduplicated snapshot ID at admission, and the spec requires durable per-item provenance rather than audit-only lookup — cost if wrong: one additive migration and persisted evidence field; no invented reserved IDs or backfill, existing legitimate rows without evidence stay compatible.

47. Ledger line 275: Ruling: Accepted cached-photo continuation rechecks current tenant membership/OPERATIONS_WRITE, subscription write, retained receipt and unchanged product/link/candidate identity plus image descriptor CAS, but not temporary session TTL, enumeration flags or provider connection/token/environment configuration — exact verified bytes and source identity are already pinned and no external request is permitted — cost if wrong: cached local completion remains available after provider configuration changes; a narrow accepted-operation helper and identity/revocation tests prevent this from admitting new unaccepted source work. Explicit operation cancellation still prevents automatic continuation; product retries retain full active-session checks.

48. Ledger line 276: Ruling: Manual apply retry requires no pending or automatically due product OR image work in the operation, otherwise409 operation_running; allow another currently authorized actor, preserve original confirmer in immutable versioned decision/acceptance evidence, and update only explicitly selected eligible failed receipts — one operation-level executor cannot safely change while siblings still run — cost if wrong: a user waits for active siblings before retrying a failed position; original provenance remains retained and unselected failures do not restart.

49. Ledger line 286: Ruling: In Task9 extract/reuse one pure photo-selection helper across existing Task7 buildPhotoCandidates and the new image service instead of independently implementing the plan's chooseDefaultPhoto again; a focused national-catalog-photo-selection.ts is permitted if needed — the actual Task7 code already owns matchingGTIN/primary/unambiguous defaults and invalid/foreign distinctions — cost if wrong: one small internal module/move and existingpreview regression rerun; behavior must remain unchanged, including existingphoto defaultskeep and foreignmanual warning.

50. Ledger line 289: Ruling: Fix Task8 finalsummary cancellation race using fresh scoped operation state under sessionlock and guarded noncancelled update; after otherwisegreen frozen fullAPI, run focused apply/state/session/product/regulatory plusAPItypecheck/lint/build/format rather than automatically repeating entirefullAPI for this boundedlocalfix — deterministic regression and changed-boundary gates cover the amendment, while finalTask14 fullbranch gate remainsrequired — cost if wrong: Task8 fullsuite evidence is explicitly pre-fix and cannot be labelled final-head fullgreen; broaderchange orotherfailures require reassessment. Cancellation mustneverresurrectwork.

51. Ledger line 292: Ruling: Correct the existing registry-invalidation fixture to distinguish products versus NationalCatalog links and fail on unexpected tables, retaining lock/invalidation assertions; run this file with final focused apply/state/session/products/regulatory +APIgates instead of repeatingfullAPI solely for mock compatibility plus boundedcancel-summaryfix — the literal failure is explained by the table-agnostic fixture, and actualHTTP/PG covers newGTINbehavior — cost if wrong: Task8 fullsuite remains recordedfailed with correctedfocused evidence; finalTask14 wholebranchfullAPI is stillmandatory, and anyadditionalruntimefailure triggersreassessment.

52. Ledger line 318: Ruling: Add nullable image-candidate preparationActorId and versioned durable checkpoint in forward0120; Task7 passes actual preparation initiator and creates enabled default-photo intent atomically, explicit manual prepare stores currentactor, GET/runningreplay never reset budgets — candidate rows lacked the durable actor/attempt/repair identity required for safe asynchronous preparation — cost if wrong: two additive columns and a narrow preview-builder integration; default queue must honor off-by-default image/verified-host policy.

53. Ledger line 319: Ruling: Task9 uses bounded pure photo-selection, image-state, image service, image-apply and shared media-reference helpers — preparation, accepted-byte application and GC have distinct state/transaction boundaries and two real selection consumers — cost if wrong: additional focused internal files, with no unrelated abstraction or service cycles.

54. Ledger line 320: Ruling: ProductsService.applyPreparedImage operates in the caller transaction on an EXISTING staged object, checks actual metadata/state and expected descriptor before checksum equality, and commits swap/imageaudit/receipt together — re-putting or separate receipt commit can change reviewed bytes or duplicate effects after a crash — cost if wrong: additive internal transaction API and image-service wiring; legacy upload behavior remains covered.

55. Ledger line 321: Ruling: GC claims deletion under asset lock after reference checks, commits a fenced deleting state, performs object-storage deletion outside the DB transaction, then finalizes with guarded metadata cleanup; every new NC reference/activation locks and rejects a deleting asset — holding a row lock across network deletion violates bounded transaction guarantees, while an FK alone cannot protect bytes — cost if wrong: deletion-state/claim recovery and lock-order coordination across actual attach paths; race tests must show either retained reference or safe refusal, never active missing bytes. A scoped Task8 admission guard extension may be necessary and requires tests.

56. Ledger line 324: Ruling: Task9 narrows Task8 admission to READY candidate with verified staged metadata/checksum/dimensions and locked non-deleting asset; pending candidates cannot be accepted — Task8's provisional guard rejected onlyfailed/released and could admit bytes theuserneverpreviewed — cost if wrong: scopedapply-admission behavior change and realPGacceptance/GC-race tests; no pending-source acceptance remainsallowed.

57. Ledger line 325: Ruling: Record selected prepared-photo checksum in the product/link reviewed baseline at productcommit, even if laterlocalimage-swap fails; photo completion never rewrites link snapshots/hashes/observations — the user reviewed thoseexactbytes beforeacceptance and delayedcompletion mustnotclobbernewer comparisons — cost if wrong: reviewed sourcebaseline and actuallocalphoto can differ afterswapfailure, explicitly represented by independentimageoutcome. Keep/rejectedphoto anddurablesourceselector semantics stillneedconcreteproposal.

58. Ledger line 328: Ruling: Persist nullable image-candidate sourceId as the locator within its pinned source snapshot, plus nullable versioned link.reviewedPhoto and optional first-write appliedEvidence.photoReview carrying actual snapshotId/sourceHash/candidate/checksum and selector evidence — provider sourceId is synthesized as good_images:index or good_img and cannot identify reordered gallery entries across snapshots — cost if wrong: additive schema/evidence and refresh matching logic; cross-snapshot matching must be unambiguous by URL hash plus normalized barcode/role, with ambiguity preserving unknown/known state. URL hash selects a source only and never proves a meaningful image change.

59. Ledger line 329: Ruling: Add optional reviewedCandidateId to photo.kind=keep to record the explicitly viewed but rejected READY alternative, checking tenant/session/preview/source identity; omitted keep preserves the exact old canonical representation and digest, while an explicit ID changes request identity — the existing keep decision cannot identify which alternative was reviewed and would repeatedly flag unchanged rejected bytes — cost if wrong: one optional strict request field and UI handoff. Without an explicit ID use only a uniquely prepared natural default; otherwise retain previous reviewedPhoto solely for the same card/environment/bound GTIN with its original truthful snapshot anchor, or leave unknown. Never guess the first alternative.

60. Ledger line 330: Ruling: Write reviewedPhoto, meaningful baseline and optional receipt photoReview atomically at product commit; delayed photo completion never rewrites link baseline or source observations — accepted review and actual local image application are independent, and an older receipt must not rewind a newer comparison — cost if wrong: the reviewed checksum can differ from the local photo after keep/failure, represented by explicit choice and independent photo outcome. Test keep-after-view/no-rebadge and newer-review preservation.

61. Ledger line 354: Ruling: For Task10 cross-snapshot photo matching, prefer a unique exact URL-hash plus normalized-barcode match (role may disambiguate); if the URL changed, allow only a unique normalized-barcode/primary-role match. No unique match means unknown while retaining last known checksum, never arbitrary gallery index — requiring an unchanged URL would make the spec's new-URL/same-bytes and rotating-URL observations impossible — cost if wrong: a changed URL can follow the unique logical photo role to different bytes, which raises a reviewable change rather than overwriting the local image. Always fetch/normalize/checksum the selected current source; URL/role matching is only selection evidence, never proof of equality/change. Task9's stored selector already supports this; no Task9 code change is implied.

62. Ledger line 359: Ruling: Task9 reviewfix I1 receives new RED/GREEN pre-read revocation/exhausted-recovery exactaudit+replay tests, covering image/apply realPG suites and APItypecheck/lint/build/format/diff, without repeating fullAPI solely for the two terminal-audit branches — the existing frozen fullAPI passed3137 tests and this bounded fix adds required events without altering image/product semantics — cost if wrong: fullAPI3137 remains evidence for73f8acafd before the auditfix, not the correctedhead; finalTask14 wholebranchfullAPI is still mandatory and broader runtime changes/failures require reassessment.

63. Ledger line 374: Ruling: Add nullable versioned link refreshCheckpoint with actual manual/system actor, step/run/attempt/repair scheduling and exact link revision/card/environment/boundGTIN fence, plus nullable controlled refreshErrorCode through forward0121 — current hashes/timestamps cannot represent durable deduped refresh, truthful running/error state or recovery — cost if wrong: additive link metadata and queue consumers; background never increments user binding revision or overwrites newer review/refresh/closedlink, manual dedupe never resets attempts or replaces a running initiator.

64. Ledger line 375: Ruling: Persist complete nullable reviewedProjection/observedProjection v1 per supported target with pinned conversion/schema context; product confirmation atomically writes reviewed values including rejected and unchanged targets, while catalogue reads compare newly unreviewed targets against compatible live local values in one tenant-scoped joined/aggregated statement — overall hash inequality can combine unrelated old rejection and new non-differing data, and preview GC/current mapping reconstruction cannot recover review truth — cost if wrong: additive projection storage and scoped existing apply/list changes; oldnull is unknown until fresh real review, no speculative backfill, provider GET/N+1/raw projection leakage or unrelated pagination.

65. Ledger line 376: Ruling: Add required nullable controlled lastErrorCode to the new strict ChzSummary from stored refreshErrorCode — spec requires a visible safe reason for last failed refresh, absent from original DTO — cost if wrong: one new-flow response field and later UI/OpenAPI mappings; old-server product.chz omission still means unavailable, no raw provider errors/URLs exposed.

66. Ledger line 377: Ruling: Confirmed-link refresh and saved reads are independent of own-list/GTIN enumeration flags; refresh still requires current integration/environment/credential/config and tenant business eligibility, periodic execution uses trusted system identity, and photo checks require image enablement/verified hosts — disabling new import entry points should not invalidate saved confirmed links or impersonate their old confirmer — cost if wrong: status refresh can continue with enumeration disabled when existing overall integration/freshness policy allows it; no new enabled-by-default controls or image network access without policy.

67. Ledger line 380: Ruling: Refresh commits successful card status/lastSuccessAt/durable snapshot/observed field projection first, retaining known photo evidence, then starts a separately identified photo step with its own admitted-attempt budget and pinned snapshot/selector payload; photo resumes without another provider GET. Terminal photo failure uses lastOutcome=error and safe photo_unavailable while retaining the just-verified card status/time/snapshot/checksum — photo transport must not block verified card observations or pretend unavailable bytes changed, and crash/deferral must not repeat completed requests — cost if wrong: a partial refresh can show an error alongside a fresh card-success time, so UI must explicitly say photo check failed. Photo completion is fenced by link revision/latest snapshot+sourceHash/step/run/current eligibility; stale results cannot clear newer work or observations. URLs remain only inside durable source snapshots; no background reviewed-baseline writes.

68. Ledger line 384: Ruling: Task10 may narrowly change the existing FreshnessService factory to repository-only and accept an optional scheduler as a TEMPORARY inert seam, removing the old ProductsService injection and any legacy/public lookup; direct tests inject the real new scheduler. Task11 must inject the real refresh service, make that constructor dependency required again and prove the AppModule/provider periodic scheduling path — Task10 changes freshness semantics before Task11 owns provider/job/config registration, and keeping the legacy callable would violate the confirmed-link boundary — cost if wrong: periodic freshness is intentionally inert between these unpublished task commits; this is not acceptable final wiring and must be closed before feature completion. Do not enshrine missing-scheduler no-op as permanent behavior.

69. Ledger line 393: Ruling: Suppress hasChanges only for a source explicitly known archived, retaining reviewed/observed projections, source identity, last good status/time and all historical evidence; later non-archived observation resumes normal per-target comparison against that retained reviewed baseline. Unknown/missing card is never inferred archived. Task13 shows the archive explanation and disables comparison/apply for that card, and Task14 records this v1 exception to the spec's general comparison-availability statement — archived cards are nonselectable/nonimportable in the approved v1 and the current comparison builder refuses them, so an actionable changes badge would lead to an unavailable path — cost if wrong: supported remote changes are not advertised while the source remains archived; they can be considered when it becomes eligible again. No baseline is silently marked reviewed.

70. Ledger line 394: Ruling: After the already-running frozen Task10 fullAPI finishes, the bounded archived-badge amendment receives focused RED/GREEN summary/link-observation tests (archived changed source suppressed; later unarchive restores normal comparison), APItypecheck/lint/build/format/diff, without another fullAPI solely for this display rule — broad frozen proof plus changed-boundary checks are proportionate and finalTask14 still requires final-head fullAPI — cost if wrong: the frozen fullAPI is explicitly pre-amendment evidence, never labelled final-head green; additional runtime failures or broader changes require reassessment.

71. Ledger line 401: Ruling: Correct the existing registry fluent-query fixture to support the actual new joined product read and include its8tests in the fresh amendment suite; do not repeat the wholeAPI solely for this mock adaptation plus bounded archive/newly-filled projection corrections if no other runtime concern emerges — exactfullfailure shows mock shape, while focused realPG/HTTP comparisons and package gates cover changed boundaries — cost if wrong: Task10 broad run remains failed pre-amendment evidence, and finalTask14 final-head fullAPI is mandatory; additional failures or broader runtime changes require reassessment.

72. Ledger line 403: Ruling: For comparison only, derive reviewed known-absence values from an actual complete confirmed projection: missing name and targets from its pinned schema definition/unique stable mappings mean no reviewed transferable value. Current projection enumerates those pinned targets under the existing current compatibility gate; a newly present valid converted observed value can then badge if it differs locally. Never fill photo, never fill a null whole legacy projection, never use current/new mappings, and leave absent observed targets absent so absence does not imply removal. Persisted projection/sourceHash/meaningful hashes remain unchanged — requiring a target to exist in old values loses newly supplied supported data despite a real reviewed card/context — cost if wrong: known absence is derived from the complete-confirmation invariant rather than stored sentinels; future projection versions must preserve or explicitly migrate that invariant. RealPG first-filled-different/equal-local/later-absent/legacy-unknown/unpinned cases required.

73. Ledger line 419: Ruling: Task10 reviewfix sourceName argument parity and portable test-only DB guard receive focused realPG/no-I/O guard proof plus APIstatics/build/format/diff without repeating fullAPI solely for these bounded fixes — original fullrun's3querymockfailures are already explained/corrected and Task14 still owns final-head broad proof — cost if wrong: broad3161/3/1 remains historicalfailedpre-fix evidence, never substituted for correctedhead fullgreen; broader runtime findings require reassessment.

74. Ledger line 438: Ruling: Extend capabilities with the existing three effective booleans, strict connection state ready|missing|blocked plus nullable controlled reason integration_missing|integration_disabled|provider_unconfigured|token_unavailable, and per-mode unavailableReason null|disabled|connection_unavailable|image_policy_unavailable. Require coherent state/reason/boolean combinations; mode reason precedence is flag disabled, then connection unavailable, then image host policy — three false booleans alone cannot tell rollout-off from a recoverable connection problem, and connection state alone can mislead when flags are off — cost if wrong: additional strict DTO fields and client copy; no raw configuration or secret details are exposed. Capabilities GET reads only stored/current state without provider/auth-refresh/enqueue side effects; cached accepted-photo completion remains independent.

75. Ledger line 439: Ruling: Task11 may add focused national-catalog-job-repository.ts, national-catalog-jobs.service.ts dispatcher with injected sender, capabilities service and scoped body-parser helper alongside planned controllers; JobsModule consumes the exported dispatcher and NationalCatalogModule never imports JobsModule — HTTP, durable due-work discovery, dispatch and capability reads have distinct responsibilities and the existing jobs module is already large — cost if wrong: a few focused integration files/call sites, without a speculative generic job framework. Any additional durable fairness cursor/schema change needs a concrete proposal; union/rank alone must not starve tenants beyond a bounded first batch.

76. Ledger line 440: Ruling: Confirmed-link refresh enablement derives from explicit configured National Catalog base URL, with actual supported provider endpoint/environment pairing checked by the existing resolver/coordinator and current integration/credential/business gates; clearing that explicit configuration stops provider refresh, independently of own/GTIN enumeration flags — there is no separate existing freshness-enabled flag, and the current periodic queue is always registered — cost if wrong: rollout rollback must clear the shared provider configuration to stop status requests as documented, rather than assuming import flags stop them. Add no default-on flag or schema-source-tenant requirement to product refresh; arbitrary HTTPS is not valid provider pairing.

77. Ledger line 443: Ruling: Add one tenant-scoped national_catalog_import_dispatch_attempts table keyed by closed kind/tenant/work/step identity with attemptedAt and justified indexes, using a dispatcher advisory transaction to select at most100 due candidates and upsert the dispatch timestamp BEFORE sending. Release DB locks before boss.send; send success/failure/crash never clears durable source intent or changes HTTP budgets/receipts. Within tenant order by coalesce(attemptedAt,originalCreatedAt), not epoch; tenant with no history uses oldest current work time, otherwise last attempt across its full history, with per-tenant rank and stable kind/ID tie-breaks — memory-only rotation or a fixed first batch can starve tenants/kinds after crashes or repeated sends — cost if wrong: one additive migration and persisted coordination metadata/query complexity; deterministic >100-tenant/multi-kind/send-failure/new-arrival tests must prove progress. No polymorphic fake FK, tenant FK remains mandatory.

78. Ledger line 444: Ruling: Retain completed dispatch metadata as fairness history in Task11, cascade on tenant deletion, and document its storage/retention cost; defer extra ledger GC while preserving all already-required preview/photo cleanup — removing historical cursor rows casually can reset fairness, and new GC is not necessary to deliver recoverable dispatch — cost if wrong: dispatch metadata grows by logical work step and needs later housekeeping; no receipt/source/photo retention guarantee is weakened.

79. Ledger line 445: Ruling: Use real manager/owner credentials for HTTP WRITE, real manager with read-only subscription for saved READ versus write refusal, and member for no-capability denial; assert exact route permission metadata separately — current cabinet roles have no READ-only capability role, so inventing one would not be real auth proof — cost if wrong: the role matrix does not exercise a nonexistent READ-only role, while real subscription-read-only, membership revocation and Station boundaries remain required and disclosed.

80. Ledger line 446: Ruling: Supersede the earlier capability reason integration_disabled with integration_unavailable for a present but invalid/unusable channel. No channel remains integration_missing; endpoint/pairing unavailable is provider_unconfigured; credential unavailable is token_unavailable; ready uses null — current signer settings contain environment/mchdInn and no enabled switch, so disabled cannot be inferred — cost if wrong: a small unpublished strict DTO/copy amendment and tests, without adding a new settings flag. Capability GET must share token validation via a proposed read-only inspection seam, never the current getCatalogToken failure path that requests auth refresh.

81. Ledger line 448: Ruling: Extract private ChzTokenService.readCatalogToken using the existing joined query/provenance/expiry/decrypt algorithm; getCatalogToken retains its current refresh-on-failure behavior including the early crypto-unconfigured exception. Add inspectCatalogToken returning only CatalogTokenResult status through the shared reader, with no token bytes, refresh request, enqueue or network — capability GET needs truthful credential readiness without mutating auth state or duplicating credential policy — cost if wrong: one additive internal service method/extraction and token-provenance regression surface; ready/missing/expired/mismatch/crypto cases and old getCatalogToken behavior require focused proof.

82. Ledger line 454: Ruling: Apply the finite9001024-byte JSON cap to all new import mutation routes, including creation, selection, preparation, apply, retry and photo intent, while unrelated/legacy/auth/1C parsing remains unchanged; add valid100-position apply exceeding100KB and oversize413 HTTP proof, without an unrelated accepted-field count cap — the generic100KB parser also rejects legitimate batch decisions, not only100000GTIN input — cost if wrong: new import mutations accept a larger but finite JSON envelope; strict DTO/business validation still rejects unsupported data and overall transport size remains bounded.

83. Ledger line 472: Ruling: Complete the named successful new-route HTTP mappings after the currently frozen fullAPI, then run the added focused HTTP cases plus APIstatics/format/diff without another fullAPI solely for test expansion — the task requires actual controller integration and its negative matrix alone does not verify successful arguments/response bodies — cost if wrong: the frozen fullAPI excludes newly added test cases and must be reported separately from final focused evidence; any production defect or broader runtime change requires reassessing gates, and finalTask14 still runs the final-head fullAPI.

84. Ledger line 475: Ruling: After the frozen fullAPI settles, add required ApiOperation summaries to the new controllers and combine actual openapi-coverage with the requested positive HTTP cases and APIstatics/format/diff, without repeating fullAPI solely for documentation decorators plus tests — the named failure is route documentation metadata and the covering global OpenAPI assertion directly checks it — cost if wrong: frozen full remains explicitly failed historical evidence and final-head broad proof stays Task14; any additional failure or behavioral change needs separate gate assessment. Record frozen/final source-manifest difference.

85. Ledger line 496: Ruling: Task12 may add focused pendingIntent.ts and pure reviewState.ts alongside the five planned UI modules; ImportPanel owns tenant/user-scoped route/query state, selection owns full server selection, review owns preview-keyed decisions and manual/category drafts, result owns retained receipt/outcomes. Pending canonical prepare/apply requests are persisted before POST in versioned schema-validated sessionStorage per tenant/current-user/session, and removed only after the returned receipt/preparation route is established; storage failure keeps choices and shows a recoverable localized error instead of sending an unrecoverable request — this separates durable request recovery from photo-overlay decision merging without a generic state framework — cost if wrong: two scoped helpers and a local browser-storage requirement for mutation submission, with quota/unavailable/corrupt data handled explicitly and no secret/provider snapshot storage. One unknown session must not overwrite another; identity changes clear only owned state.

86. Ledger line 497: Ruling: Unresolved apply intent is retained until a definitive receipt/error or deliberate abandonment, independent of temporary session/preparation expiry, while unaccepted prepare intent may expire with its session. Replay uses the same canonical body/requestId after reload and may recover an existing accepted operation after TTL; no new operation is admitted after expiry — current apply.service.ts45–68 resolves existing request IDs before session eligibility, and a min(sessionTTL,24h) client deletion would erase a recoverable receipt after a lost response — cost if wrong: unresolved accepted decisions remain in the browser session longer than temporary previews, bounded by sessionStorage lifetime/available capacity rather than an automatic24h purge; no indefinite server retention or new lookup endpoint is added. Require lost accepted response nearTTL→reload afterTTL→same receipt, tenant/user switch and storage failure regressions.

87. Ledger line 500: Ruling: Add @markiro/platform-contracts:workspace:* to apps/admin/package.json with the minimal pnpm-generated importer/lock change and own-worktree dependency link — Task12 must parse shared strict schemas but the existing admin package does not declare this internal consumer dependency, which the plan file map omitted — cost if wrong: additive internal package/build coupling and scoped manifest/lock paths; no external dependency, handwritten lock, policy bypass or unrelated upgrade.

88. Ledger line 505: Ruling: A401/403 or other ambiguous error during replay of an unknown apply outcome does not establish that the original request was unaccepted; retain canonical pending ID/body through access/subscription loss and recover it when access returns. Clear only on a known receipt, a definitive rejection of a not-yet-accepted intent, or explicit abandonment — broad4xx cleanup can erase a previously accepted result after the first response was lost — cost if wrong: some unresolved browser-session records persist longer and the UI must distinguish blocked access from safe resubmission; no automatic new request ID or server contract change. Add lost accepted response→403→restored access→same receipt regression.

89. Ledger line 508: Ruling: Add required public ImportField.requiresEntryIds:UUID[] derived from the existing authoritative private mapped-entry dependencies, with an empty array for independent fields; the UI deselects dependents when their prerequisite is unchecked and disables them until explicit prerequisite acceptance, never inferring meaning from labels or automatically accepting category — the approved UI cannot enforce initial-category dependencies with the old public label/applicable-only shape — cost if wrong: one strict response-contract addition plus scoped server projection/client/tests; no new target taxonomy, endpoint, generic dependency framework or relaxed server validation.

90. Ledger line 509: Ruling: Preserve stored v1 preview compatibility with a narrow server-only legacy view reader that enriches public field dependencies from private diff.entries; public wire requires the explicit array, while old stored view omissions must not mean independent fields. Do not rewrite persisted previews/receipts, accepted evidence or source/decision hashes — parseImportDiff previously embedded the public importPreviewSchema directly, so a required field alone would invalidate durable older comparisons and receipts — cost if wrong: an internal compatibility projection and extra regression surface; require realPG legacy stored-view read/replay and immutable bytes/hash proof plus normal public dependency projection. No DB migration is needed.

91. Ledger line 510: Ruling: Task12 now includes shared contracts/server stored-diff projection changes in addition to UI, so run contract gates, affected preview/apply/image/observation consumers and APIstatics/build plus ONE frozen fullAPI after final source changes, alongside the planned admin/browser gates — the new shared durable-reader path materially broadens regression scope beyond UI-only work — cost if wrong: one additional broad server run; no overlapping broad DB workloads, results pinned to the frozen code, and finalTask14 final-head acceptance remains required.

92. Ledger line 517: Ruling: Add required public ImportPreview.identity={gtin14:validated nonnullable GTIN14,cardId:nonempty string,name:string|null}, derived from the already pinned preview source envelope; existing productId/linkAction provide new/existing/linked/replacement context without another match enum. New previews emit it, and saved preparation reads derive it from validated pinned source before full public response validation; strict internal stored views alone accept omitted legacy identity — a saved off-page preview currently has only opaque itemId and changed fields, so an unchanged name/GTIN cannot be reliably shown without scanning the feed — cost if wrong: one strict response object plus scoped internal projection/client fixtures; no provider request, item scan, new DB query or endpoint. Mutable session item names must not change the identity shown for an immutable comparison.

93. Ledger line 522: Ruling: Mount a small NationalCatalogIdentityBoundary storage observer at App level alongside RouterProvider inside the existing AuthQueryBoundary, so settled logout/tenant/user changes clear only old National Catalog pending keys even after the import panel closes. Reuse AuthQueryBoundary's existing structural QueryClient isolation; ignore transient session isPending and use an owned prior-owner marker for reload under another settled identity. Do not clean storage merely on unmount/StrictMode replay or alter other app storage — an authenticated-Shell-only observer can unmount before logout is observed, while panel-local observation misses changes after navigation — cost if wrong: one scoped always-mounted observer/App+harness integration and marker; no generic auth framework or duplicate cache manager. Require actual app-boundary lifecycle proof including closed panel, transient pending, logout, switch and reopened old route IDs.

94. Ledger line 540: Ruling: Supersede the initial observer-inside-AuthQueryBoundary placement: mount NationalCatalogIdentityBoundary immediately OUTSIDE the existing AuthQueryBoundary, wrapping it and RouterProvider, with the same production/RTL/browser hierarchy. Keep its last settled owner ref above keyed cache remounts; use sessionStorage as the durable cross-mount marker when available. AuthQueryBoundary itself remains unchanged, and the observer still holds new-scope children only until scoped route transition completes — actual AuthQueryBoundary keys and remounts every child on identity/pending changes, so an inner ref cannot detect identity switches when storage has always failed; the actual-wrapper regression is RED — cost if wrong: one wrapper-order change around the router/query provider and lifecycle regression surface; no duplicate cache manager or generic auth framework, and no whole-cabinet deadlock on storage failure. Preserve initial saved links, transient pending/same-owner refresh, normal unmount/StrictMode, and only reset carried import IDs on actual known scope change.

95. Ledger line 551: Ruling: Add one strict shared ImportApplyConflict response schema for the two existing apply-admission409 reasons preview_expired and environment_mismatch, preserving the usual statusCode:409/error:Conflict/message reason envelope and adding a nonempty unique previewIds array bounded by100. At each existing tenant/session-resolved rejection include the specific rejected preview ID; the first failure may identify one known rejected position and does not claim to enumerate every stale row. Keep authorization, admission ordering, canonical request replay, receipts and other errors unchanged. The client validates these details, marks only returned known preview IDs using pinned identity, and prevents those rejected decisions from applying until a fresh comparison; legacy/malformed bare409 instead requests a new comparison without inventing affected rows — current service74–79 returns only bare reasons, so the approved specific-position UI cannot be implemented truthfully from existing wire data — cost if wrong: one additive strict error contract and two focused response sites/client recovery states; no migration, provider work, successful-response change or broad error framework.

96. Ledger line 552: Ruling: Corrupt/unreadable pending-intent storage remains distinct from an absent record: preserve recoverable bytes where possible, block fresh prepare/apply supersession, and provide localized retry-reading plus deliberate abandonment of only that owned record. Abandonment must explicitly explain that the earlier outcome may remain unknown and must verify successful local removal before lifting the block; unavailable storage does not block unrelated cabinet reads/navigation — deleting on parse/read failure can lose an already accepted unknown apply and silently generate a new request ID — cost if wrong: a small explicit local recovery choice and state union; no execution of invalid payload, server cancellation or fabricated receipt, and normal expired-prepare cleanup remains allowed.

97. Ledger line 553: Ruling: Task12 review fixround1 runs focused admin state/import regressions and final admin statics/build/browser/format, full shared-contract gates, and focused actualPG apply plus real HTTP error-shape/tenant-denial coverage with APIstatics/build. Do not repeat fullAPI solely for the two additive409 response bodies if admission logic/other runtime behavior stays unchanged; the earlier3202/1 run remains pinned to its pre-error-amendment server freeze, and Task14 requires final-server fullAPI — exact changed-boundary tests directly exercise this narrow error projection while a second broad run would duplicate the already scheduled final gate — cost if wrong: no final-head fullAPI proof at this fix checkpoint; any broader server behavior change or new runtime failure requires gate reassessment.

98. Ledger line 568: Ruling: In the successful National Catalog HTTP fixture only, stub onModuleInit on that app instance of PgBossService before app.init and restore it in teardown after app.close (with cleanup even on setup/test failure). Keep real HTTP/BetterAuth/services/PG, controlled transport/storage, manual worker resumptions and the exact download-count assertion. Leave separate auth/job tests and production lifecycle unchanged — the fixture currently both starts autonomous candidate/repair queues and manually resumes the same work; added auth/denial checks expose a second download from this timing race. Controller verified jobs.module.ts711–724 consumers, safe never-started onModuleDestroy800–806, actual fixture setup and API fileParallelism:false — cost if wrong: this successful HTTP fixture no longer incidentally exercises live PgBoss startup/dispatch, so its proof is explicitly controlled worker execution; dedicated job/auth tests remain separate, and live restart/redelivery acceptance remains Task14. No broad test-global mock, weakened count or production scheduling change.

99. Ledger line 579: Ruling: Approve Task13 proposed planned ChzStatus/LinkPanel modules, native accessible all-status disclosure, and local any-match filter over fetched products while retaining unfiltered outlet context and automatic table layout. LinkPanel reads saved link, refreshes using current WRITE and actual ready connection independently of enumeration flags, removes using WRITE plus expected revision independently of provider, and starts a new GTIN session for comparison. The existing ImportPanel may own a bounded exact-card query intent and one focused api.ts pagination helper (100 pages of100 with loop/incomplete guard) that requires completed fresh feed proof and a unique selectable exact card before explicit selection; absent, ambiguous, archived or incomplete proof remains recoverable and never chooses another card — this reuses approved durable preparation/apply recovery without a second flow or server endpoint — cost if wrong: additional scoped route intent and bounded client feed traversal; an unusually large or incomplete exact-GTIN result may require retry rather than automatic selection, with no silent truncation success.

100. Ledger line 580: Ruling: ProductForm may accept an optional third submit argument for detach metadata while preserving CreateProductInput; EditProductPanel alone constructs atomic UpdateProductInput. Pin initial canonical GTIN and link revision for the form edit lifetime, require explicit detach only for a changed canonical GTIN, and surface409 near that field without adopting a new revision automatically. Add products and product-link query invalidation for successful refresh/remove/detach, accepted apply results and terminal polled operation results while preserving route-before-pending-clear ordering — current Task12 flow lacked catalogue invalidation and Task13 must show saved outcomes/status coherently — cost if wrong: a small form callback seam and extra local query refreshes, with no new mutation or backend contract. Ensure terminal polling invalidation is keyed once per observed result rather than a render/invalidation loop.

101. Ledger line 593: Ruling: Task13 review fixround1 uses focused catalog-routing (unlinked duplicateGTIN, actual CHZ conflict, successful productPATCH followed by image409), status disclosure (identity/access and retry/provider errors, retained good status/time/photo semantics), import/image regressions, final admin typecheck/lint/build and bounded browser/format/diff. No server/shared change is needed: use actual controlled CHZ detach/revision error reasons and RU/EN failure mapping; keep PATCH and subsequent image error handling separate. The fulladmin1074 run remains explicitly pre-fix, and Task14 final-code fulladmin/aggregate gates remain required — these are two scoped UI error-projection corrections with direct regression coverage, so another fulladmin before the already scheduled final gate adds little — cost if wrong: no fulladmin proof at this intermediate corrected checkpoint; broader runtime/form behavior changes or new failures require reassessment and proportionate additional gates.

102. Ledger line 609: Ruling: Approve Task14 existing-harness extension with deterministic16-case width/locale/theme matrix, realistic multi-product/localWebP fixtures and actual visible status/action bounds plus complete authorized flows. Move generated Playwright output to tools/production-browser/test-results/national-catalog, add narrowly scoped ignore/format exclusions as needed, opt-in only deliberate tracked final screenshots, and reuse existing production-bundle CI command/artifact contract — current temp output has no portable repository artifact path and generated test files must not enter commits/format scans — cost if wrong: one relocated generated-output directory plus scoped ignore/CI/test-fixture changes, no new mandatory job, browser dependency, production request or app architecture.

103. Ledger line 610: Ruling: Task14 may make migration prerequisites explicit per test, introduce a target-specific observed DB row-lock barrier in the existing GC test, and narrowly capture/assert only expected413 logging. If transaction-per-test is used, pin one client and preserve expected-violation assertions with savepoints/rollback so one rejectedSQL statement does not invalidate following checks; explicit prerequisite helpers are an equally valid smaller seam. Keep random owned scratchDB creation/cleanup and exactlocalpreflight, never shared-data reset. Investigate a bounded real LOCAL PgBoss restart/redelivery integration fixture using owned queues/data and actual relevant handler; if narrow proof is not feasible, retain the named live acceptance/runbook limit instead of a broad runtime rewrite — these changes strengthen carried test evidence without changing product behavior — cost if wrong: focused fixture/coordination complexity and remaining external recovery acceptance; no weakening assertions, arbitrary sleep-only race proof or added production capability.

104. Ledger line 611: Ruling: Approve Task14 sequencing: finish focused source/test/document changes and all targeted browser/CI/compatibility checks, verify both isolated0122journals, build shared dependencies, then freeze for ONE exact-preflight LOCAL_INFRA_SMOKE aggregate turbo lint/typecheck/test/build withconcurrency1/force plus finalformat/diff/productioncontracts/portability. Reuse aggregate package results instead of duplicatefullsuites; clearly separate any correctivepostfreeze checks and required reruns — finalserver/admin code lacks fullproof after prior scopedreviewfixes — cost if wrong: a longer final integrated gate and possible scoped rerun if a real defect appears; no overlappingbroadDBwork, skippedinfra mislabeledgreen or unverified liveprovider claim.

105. Ledger line 614: Ruling: Raise the pending-intent serialized guard from200000 UTF-16 code units to9002048 and name it MAX_SERIALIZED_CHARACTERS (with an explicit UTF-16/byte distinction and rationale). This accommodates every existing HTTP-bounded canonical body plus a bounded intent envelope; do not change server limit/schema or claim every browser has that much storage. Preserve exactwrite/readback, corrupt/unavailable/unknownapply gates and quota failure beforePOST. Add valid100x60 roundtrip, actualserialized-envelope bound and over-limitcorrupt/no-supersession proof — the old arbitrary guard rejects legitimate100-item decisions before any request — cost if wrong: a higher bounded local parsing ceiling and larger possible browser-session records, while platformquota may still require a smaller batch; no new server acceptance or weakened recovery validation.

106. Ledger line 615: Ruling: For saved result rows without productId, add a localized human-readable display position and make the full stable previewId available as secondary identification, with a rendered two-failure regression. Treat the number as current result display order, not an original source-row number, and do not invent a name/GTIN or fetch expired previews. Keep actual outcome/retry actions and postTTL receiptREAD independent — current durable result exposes onlypreviewId for such failures — cost if wrong: a small fallback identity presentation with limited business meaning, but no persisted receipt/schema expansion, mutable source lookup or lost historical readability.

107. Ledger line 616: Ruling: Approve one bounded actual LOCAL PgBoss integration case in the existing NC image test using a uniquely owned schema/queue on the guarded isolated loopbackDB. First actual worker invokes real NC image/receipt services under existing controlled transport/storage, commits then deliberately throws to simulate lost acknowledgement; observe persisted retry, stop itsPgBossinstance, start a secondinstance on sameownedqueue and assert samejobidentity/retrymetadata, one download/activeimage, unchangedreceipt/evidence and no duplicate relevant audit. Teardown stops both and removesONLYownedqueue schema in finally. This proves client-worker restart/redelivery after commit, not OS-process crash, production AppModulewiring or complete live enumeration/apply/photo recovery — feasible narrow realqueueproof strengthens existingmanualservice tests without runtime changes — cost if wrong: one localdatabase queuefixture and bounded timing/lifecycle test cost; broader deployment/provider restart acceptance remains explicit.

108. Ledger line 617: Ruling: Task14 may split browser verification into existing import.spec.ts recovery tests plus matrix.spec.ts and flows.spec.ts for their distinct static-matrix/stateful-flow responsibilities, with only focused local fixture/assertion helpers and existing reusable contracts. Harness may accept bounded lang=ru|en using actuali18n and existingmarkiro.theme initialization. Make tracked screenshot regeneration opt-in NC_UPDATE_SCREENSHOTS=1; CI artifacts staygenerated/ignored. Avoid duplicating a substantial identical fixture across files or introducing a generic fixture framework — combining16cases/statefulflows into the existing350-line recoveryfile would obscure ownership and CI mustnotrewrite historicalevidence — cost if wrong: two test modules and oneexplicitartifact switch, no new productionroute/module/dependency or runtimebehavior.

109. Ledger line 626: Ruling: Use explicit --env-mode=loose for this ONE final local Turbo aggregate command, alongside exact no-I/O isolatedDB preflight, LOCAL_INFRA_SMOKE=1, concurrency1 andforce; do not persist a turbo.json environment-policy change. Controllerverified currenttest.env omits INVENTORY_TEST_DATABASE_URL, LOCAL_INFRA_SMOKE andlocalSMTP/S3 variables, and installedTurbohelp documentsloose/strict; explicitCLIflag is preferred over an unverified TURBO_ENV_MODE variable. Verify actual consumer test counts/infra execution in results rather than assuming inheritance — strictmode would drop intendedlocalcoverage or misdirect inventory fallback — cost if wrong: wider inheritance of the existing prepared localtestenvironment to childpackages for this run, with no cache-read reuse dueforce; no changed production configuration or relaxed destination guard. Existing localinfra tests must still enforce loopback SMTP/S3 destinations.

110. Ledger line 629: Ruling: Extend only the ephemeral final-run preflight to validate actual resolved SMTP_HOST/SMTP_PORT as preparedloopback1025 and S3_ENDPOINT as preparedloopback9000, alongsideboth exactDB URLs, before loose-modeaggregate. Do not log credentials/values or change production/testpolicy. Node --env-file preserves ambientoverrides, so validate resolvedenvironment ratherthan trustingfilename — the local-only scope is binding and existing smoke code has no explicitdestinationguard — cost if wrong: one temporary executionpreflight and possible earlyfixtureconfigurationfailure, with no applicationbehaviorchange, externalmessage or persistentenvironment edit.

111. Ledger line 641: Ruling: Keep the frozen aggregate failure visible and finish the five canceled gates sequentially on the same source with established guards; retain the unchanged Station13/13 focused rerun separately, without repeating the entire aggregate or broad Station suite to obtain a green headline. Do not expand into Station/Rust/offline implementation for a non-reproduced failure in untouched code — the import-related mandatory full packages still receive final-code proof and the initial aggregate is accurately reported as failed — cost if wrong: an unresolved intermittent Station test or behavior concern remains for independent final review and explicit delivery disclosure; no claim that all1390 Station tests or the aggregate passed on rerun, and any concrete import-caused regression reopens the scope.

## Single final fix wave: chronological rulings 112–117

The preceding 111 chronological rulings and their costs remain immutable history.
The six following rulings clarify the approved implementation scope and retain
their full costs; they do not replace user authorization.

Ruling: Final I2 public cancellation covers pending/running operations and finished operations that still have legitimate core/photo retry work, including accepted cached photos after temporary TTL or provider configuration changes. Require current tenant business WRITE/subscription authorization before the idempotent mutation/read result, follow the established subscription/session/operation/receipt lock order, set durable operation cancellation and clear automatic/manual continuation eligibility. Mark unfinished core work cancelled and pending photos failed with a controlled cancellation reason; preserve already committed product/applied-or-unchanged photo outcomes, terminal nonretryable results, immutable decisions/applied evidence and existing audit, adding exact actor-scoped cancellation audit without duplicate effects on replay. Session expiry/cancelled shortcuts must not leave accepted continuation uncancelled — the public stop command currently has no production operation transition, whereas accepted cached work deliberately ignores temporary closure/provider gates — cost if wrong: a broader local stop boundary and explicit cancelled receipt state for formerly retryable work; no provider request or rollback of completed business changes.
Ruling: Final I3 adds bounded per-record cleanup of expired unconfirmed session/item/preparation payloads while retaining necessary identity/FK/hash stubs and immutable accepted snapshots/decisions/applied evidence/compact replay. Clear nullable input/source/name/brand/raw metadata and bulky session work; NOT NULL preparation request may become an empty object only after closed-session checks prevent parsing it, with valid terminal empty checkpoints wherever existing readers require them. Bound item/preparation writes independently, not a batch of sessions multiplied by100000 rows, and select still-purgeable payloads before limits so retained rows do not starve progress. Terminal nonretryable core conflicts, expiry-ended core work and explicit cancellation clear impossible image retention eligibility; preserve post-TTL bytes/previousPhoto only for genuinely applicable or retryable accepted-photo work after product success — spec200–202 promises transient deletion, while receipt retention never authorized permanent raw payload or impossible candidate retention — cost if wrong: bounded asynchronous cleanup lag and retained small identity stubs; an eligibility or closed-reader mistake could harm recovery, so real-PG negative and positive retention/replay/race tests are required. No destructive table/history deletion or migration unless separately justified.
Ruling: Final I4 makes every mapped entry requiring an initial regulatory profile depend on the category entry, both authoritative selection and public dependency projection; ordinary direct product name/manual name/photo/link-only remain independent where already supported. Enrich or safely reject legacy unaccepted previews at read/selection boundaries without rewriting stored snapshot/decision hashes or accepted evidence — the reused regulatory writer requires the profile for stable mappings as well as attributes, so stable-only approval currently produces a false profile_changed conflict — cost if wrong: some mapped stable choices require explicit category acceptance or a new comparison; no new unbound writer or automatic category choice.
Ruling: Final I5 treats confirmation as review advancement, not a new provider check. For a retained same-identity link preserve any later completed observation/status/latest snapshot and compare it against the newly reviewed baseline; use the persisted provider-check/preview fetch anchor rather than confirmation time when advancing an older observation or attaching/replacing. If preview.createdAt is the only persisted legacy anchor, use it explicitly as the local preparation/check anchor, not a provider-supplied timestamp. Preserve newer attempt/error chronology even when the last successful observation is older; reconcile in-flight refresh checkpoints with the existing revision fencing rather than blindly keeping an invalid checkpoint or erasing newer evidence. Recompute observation projection against the new reviewed context when needed, with truthful unknown handling — completed refreshB followed by applyA currently rewinds live status and timestamps despite immutable snapshot rows — cost if wrong: additional ordering/projection logic and possible requeued freshness work; no silent source update to accepted product values and no policy that every background refresh automatically invalidates a user's comparison.
Ruling: Final M1/M4 may add server-derived automaticWorkPending booleans to public session/preparation responses with false as a legacy parse default, plus an optional narrow owned labelKey enum for name/category/print_name/shelf_life_days derived from authoritative field entries. Current producers must emit truthful continuation state and owned label keys, strict schemas remain strict, saved legacy payloads may be projected without rewriting their bytes, and fixtures/types/consumers must be updated. Poll only actual unfinished automatic work and translate only app-owned labels; external names remain source text — existing public state cannot distinguish deferred automatic work from terminal partial results, and label text alone cannot safely distinguish app labels from provider data — cost if wrong: additive public contract/projection and test maintenance, with old responses retaining conservative no-extra-poll behavior; no client-controlled scheduling, new persistence model or speculative provider translations.

Ruling: Final I5 may capture a local fetchedAt immediately after the successful awaited provider/coordinator response and persist it as createdAt for newly built previews, leaving source envelopes/content hashes untouched; legacy previews keep their stored anchor. Reconcile a still-pending same-identity refresh under the link lock to the new confirmation revision, fencing old in-flight completions and letting durable repair resume valid work. Preserve actor, consumed attempts and provider delay for the same logical step; do not reset retry budgets merely for a revision change. A photo-phase checkpoint must still reference the preserved latest snapshot and a selector valid for the newly reviewed photo choice: reuse a known checksum only when its selector remains compatible, otherwise reselect/requeue from that verified snapshot or leave the photo observation explicitly unknown rather than comparing unrelated photos. Terminal/invalid work is not blindly revived — controller verified identity checks include revision and current checks include step/run plus latest photo snapshot, so clearing all checkpoints would lose valid B-photo work while unqualified rebasing could observe the wrong image — cost if wrong: extra local checkpoint reconciliation or one legitimate new photo-check step after a changed selector; require real-PG old-in-flight rejection→repair completion, preserved retry-delay/budget and changed-selector tests, without a schema migration or new provider work inside the apply transaction.

## Same-wave final layout and auth-fixture rulings 118–119

Ruling: Complete M7 inside the same active final fix wave by adding a catalog-only group content wrapper with a 140px minimum alongside the existing 220px name minimum, preserving automatic table layout, permitted horizontal scrolling and safe wrapping of unusually long tokens. Controller compared the final1280RU screenshot with Task14 and verified that the name fix shifted word fragmentation into Group, so this is fix-introduced layout breakage rather than unchanged historical wrapping. Require focused visual RED, affected catalog checks plus admin statics/build, then the16-case width/locale/theme matrix and refreshed affected screenshots after build; preserve earlier manifests and identify this runtime layout delta explicitly. Do not repeat full API/admin business suites or unaffected flows — cost if wrong: additional horizontal scrolling and one bounded layout verification run; existing fulladmin1122 evidence predates this final layout-only delta, while final browser/build evidence covers it.

Ruling: Repair the authorization fixture that manually inserts state=ready with checkpoint={} by supplying the actual terminal version1 checkpoint, retaining real READ200/WRITE403/cross-tenant404 assertions and adding automaticWorkPending=false. Controller verified current start and the reviewed5a4a773e1 producer always create valid version1 work, and retry/resume/expiry already parsed that format before the fix; no supported live or legacy producer of an active ready empty/null checkpoint was demonstrated. A nullable DB column alone does not establish such a supported active-session contract. Do not add a speculative runtime fallback or weaken checkpoint validation to accommodate this fixture. Run the complete auth file plus existing service DTO/continuation tests and relevant test type/lint checks, preserving fullAPI3223passed/1failed/1intentional live skip as a failed historical run rather than rerunning the full suite for a green headline — cost if wrong: a malformed active historical row outside known producers could still fail a READ and would need separately evidenced recovery; final whole-suite output remains failed, with the exact isolated fixture correction and affected-file success recorded separately.

## Residual correctness continuation: chronological rulings 120–122

The explicit workflow-cap exception, scope, verification requirements and full costs
are retained verbatim. Earlier rulings and evidence remain historical and unchanged.

Ruling: Make one explicit bounded exception to the SDD final fix-dispatch/re-review cap for the two verified fix-introduced residuals R1 and R2 at703440ebd. The independent scoped review addressed all14 original findings but found a real Important expiry/catch race that can duplicate terminal audit and resurrect retry intent, plus a Minor supported-wire regression. These are inside the already approved audit/recovery and additive-contract requirements; higher-priority developer instructions require finishing authorized work and prohibit inferring another permission gate solely from a skill exception. Resume the original implementer for only these two concrete corrections, then the existing reviewer for only their exact diff; no new whole-branch review, new product scope or external action — cost if wrong: one additional bounded correction/review cycle and new-code verification time beyond the workflow cap, explicitly visible rather than silently parking a known audit invariant defect.

Ruling: R1 must preserve a terminal failure already committed by expiry cleanup when the original worker later records an error after its rolled-back transaction. Fence the stale failure recorder using the existing receipt/operation state or a precise attempt comparison; do not reclassify a terminal import_session_closed outcome, increment its attempt count, duplicate item_failed audit, or restore retry/enqueue intent. Keep genuine due infrastructure retries and cancellation/applied/conflict replay behavior. Add deterministic real-PG rollback→collector→catch regressions for closed-session and delayed infrastructure classifications, using the existing uniquely-owned scratch fixture and exact audit/receipt/retry/evidence assertions — source inspection confirms the split-transaction gap and sequential replay tests do not cover it — cost if wrong: an overbroad stale-error guard could suppress a legitimate retry outcome, so positive due-retry coverage is required; no migration or new job architecture.

Ruling: R2 keeps optional labelKey as presentation metadata and a discriminator only when supplied. Current responses with an identifiable owned name must still require its explicit acceptance for new products; schema-valid older responses without that key retain the previously supported submission path, with authoritative server name validation unchanged. Do not guess semantics from translated/provider label text or make the optional field mandatory. Cover old-wire new/mixed batches and current-key required-name decisions in focused DOM tests. After both runtime changes and focused RED/GREEN settle, rebuild affected consumers and run one new guarded full API plus full admin/static/build as required for current code, with API using actual LOCAL_INFRA_SMOKE and no overlapping DB workloads; then one current21 browser run after all builds, scoped format/diff and only the R1/R2 independent re-review. Reuse unchanged contracts/domain/DB/production/CI evidence; preserve all earlier failures, manifests and ruling history — cost if wrong: older responses may still defer missing-name errors to their existing server authority, and current full verification adds time, but valid old-wire imports must not be categorically blocked.

## Residual reviewer routing: chronological ruling 123

Ruling: Resume the existing independent review_task7 agent for the exact residual R1/R2 diff after the implementer commits, in place of final_fix_rereview. The controller attempted to contact final_fix_rereview and the collaboration tool returned "agent thread limit reached"; the current agent inventory contains only root, final_fix_wave, review_task4 and review_task7, so the original scoped reviewer cannot be restored through the available tool. Give the substitute the complete original findings/report, binding rulings, new report and exact703440ebd-to-newHEAD package; retain the same narrow scope and no suite reruns or whole-branch review — cost if wrong: replacement-reviewer context acquisition and less continuity, bounded by the verbatim evidence and source diff; no change to implementation scope or acceptance standards.

## Residual full-API diagnostic: chronological ruling 124

Ruling: Preserve the residual full API run as failed3226passed/1failed/1intentional live skip,578.08s, and snapshot full metadata before any focused API result overwrite. Its only failure is station-inventory-sync.e2e competing-device repack at service633/test1380 with FK23503 inventory_repack_items_tenant_result_active_date_fk. Do bounded read-only attribution of the failing source/test/schema against the import source base; if no changed import dependency is found, run only the complete failed file once under the same owned-local preflight, with no overlapping DB workload. Continue unaffected browser21 and do not modify Station or repeat full API/aggregate merely to obtain a green headline — the full failure is real evidence requiring attribution, but it does not authorize unrelated inventory redesign or erase the result — cost if wrong: a source-unchanged integration issue can remain unresolved and prevents an aggregate-green claim; preserve exact follow-up result and causal uncertainty for review and final delivery.
