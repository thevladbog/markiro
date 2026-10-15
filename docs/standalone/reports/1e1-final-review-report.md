# Plan 1e1 — final whole-plan review (e2480a1ad..e02cac6d8)

Reviewer: final whole-plan reviewer (opus). Range: 8 commits, 39 files, +8272/−88.
HEAD at review: `e02cac6d8`; tree clean before and after (`git status --short` empty).

## Verdict

**WITH FIXES** — Critical 0, Important 0, Minor 7 new (F1–F7) + 4 notes (N7–N10).

The host side of the catalog works as one machine. I found no defect in the code. Every
issue is a test gap, a stale or overstated document line, or a contract note for plan
1e2. The queued minors were triaged: 17 FIX, the rest CLOSED / DROP / CARRY (table below).
I agree with the controller's leaning and add item 4 (FIX), item 1 (DROP) and three new
cheap test items: F2, F3 and F4.

## What I checked, seam by seam

1. **The change feed as one machine.**
   - Writers checked against `FEED_KEYS`/`record` (`routes/changes.rs:51-61, 257-399`):
     - product create and update;
     - template create, update and delete;
     - the defaults PUT;
     - `PUT /v1/office/org` (`routes/org.rs:85-96`, which leaves the three default ids alone);
     - the bootstrap.
   - Each writer calls `next_revision` exactly once per transaction and commits through
     `commit_with_revision`.
   - Tombstones:
     - a template DELETE writes `feed::remove` at the delete's revision, after the product
       pointers are cleared at that same revision (`routes/templates.rs:370-396`);
     - a cleared category default writes `feed::remove`;
     - a re-created category default calls `feed::restore` in the INSERT arm
       (`routes/template_defaults.rs:262-281`);
     - so a row and a tombstone of one key never coexist.
   - `ORDER BY rev, entity, id, deleted DESC` (`deleted` is decorative, since no key has
     both forms). Within one revision:
     - a template's tombstone comes before the products it cleared;
     - category defaults come before `org_profile`;
     - stock templates come before the org record that names them (bootstrap rev 1).
   - Paging: all four branches of `page()` plus the byte cut in `within_budget`, and
     `has_more`/`rev` on each branch, including "the last revision fills the page". The
     current code is correct.
   - **Machine probe** (scratch, removed afterwards). Four simulated stations applied pages
     in feed order with the station's rules (upsert only when newer; a tombstone deletes
     only an older row). The sequence:
     1. bootstrap with 22 stock templates and two `orgDefault`;
     2. two products, one preferring a stock box template;
     3. an office template and a product pointing at it;
     4. a category default `8:box`;
     5. delete of the office template;
     6. clear `8:box`, then set it again on another template;
     7. archive a product, disable and narrow a free stock template, rename the
        organization.

     The four schedules:
     - sync after every step at `limit=3`;
     - first sync after the delete and again at the end, at `limit=2`;
     - sync only at the end at `limit=1`, which exercises the "whole first revision" branch
       on rev 1 (26 keys) and on the delete revision;
     - sync from zero at `limit=1000`.

     All four ended identical: rev 12 and 29 rows, equal to the host's live keys. Every page
     held its invariants: feed order, no key twice, items in `(since, rev]`, no regress, and
     `hasMore` never set on an empty page. Nothing was lost or ambiguous. The org record
     names the stock defaults, the cleared product has `null`, and `8:box` names the
     re-chosen template.

   - Count cut combined with byte cut (minor 6): mutant M1 (below) survives all 20 feed
     tests, and the proposed test kills it.
2. **Rights.**
   - Every new route has `OfficeContext`.
   - The writes check `require_catalog()` first and `require_catalog_in` right after
     `begin_write`, before any reference check, lookup or `next_revision`:
     - `products.rs:251/256` and `:307/311`;
     - `templates.rs:167/175`, `:221/237` and `:343/346`;
     - `template_defaults.rs:95/107`.
   - Route-level proofs exist for products (POST, PUT), templates (POST, PUT, DELETE) and
     defaults (PUT, change and no-change).
   - `edits_catalog` has no wildcard arm. Spec §4.8 matches the code.
   - Reads without a session are refused in tests for templates, defaults and groups, **but
     not for products** (F2: mutant M4 survives).
3. **Concurrency.**
   - `expectedRev` is compared inside the IMMEDIATE transaction after the lookup, on all
     three surfaces.
   - Both sides are tested for templates and defaults; products are tested on the older side
     only (minor 12).
   - A bad body (400) beats a stale revision (409): pinned for templates and defaults, true
     for products by code order but unpinned (F3: mutant M3 survives).
   - The defaults document is coupled to the organization's profile in both directions.
     Observed: a profile form opened before a defaults PUT that changes an organization slot
     gets 409 `stale_revision` with `currentRev` 3. Re-reading shows nothing visibly changed
     (minor 21).
   - The bootstrap is single-shot (`initialized_at` is checked inside the IMMEDIATE
     transaction).
   - New cross-task finding: F1.
4. **Data integrity.**
   - Every CHECK in 0008 checked against its validator: names (trim sets, `char` counts vs
     SQLite `length`, NUL and controls refused), `gtin14`, `print_name`, counts, `purpose`,
     `category_codes`, and `spec` (object, `json_valid`, ≤ 262 144 bytes). Serialized and
     stored bytes are measured alike.
   - No input path ends in a 500.
   - Deletion order: pointers are cleared before the DELETE, so `ON DELETE SET NULL` never
     fires. The org and category default FKs are guarded by the usage check, with a 500 as
     the last line.
   - The GTIN partial index is route-tested both ways.
   - Stock rules and their precedence:
     - DELETE of a stock default → `stock_template` (pinned);
     - PUT that renames and disables a stock default → `stock_template` (observed; unpinned,
       N8).
   - Hunt for a third Task-4-style breakage. Created templates with these layout numbers:
     `-0.0`, `5e-324`, `1e2` (stored `100.0`, so `dpi` is `null`), `"\u0000ru"` as the
     language, `f64::MAX`, `u64::MAX`, `i64::MIN`. The list, GET and the feed all answered 200
     with the numbers back.
   - Also reviewed by reading:
     - zero-width and format characters in names (cosmetic only);
     - huge `categories` lists (bounded by the 153 valid slots before any refusal);
     - `json_each` code checks;
     - SQLite `->` number rendering (the original text is kept; `spec_number` uses `.ok()`).
   - **No third case found.**
   - `serde_json` features across the workspace (`cargo tree -e features -i serde_json`):
     no `preserve_order`. `unbounded_depth` is enabled only by `cargo_metadata` (Tauri's
     build), and it is inert unless `disable_recursion_limit()` is called, so the
     127-level assumption holds.
5. **Secrets, logs, audit.**
   - The new routes have no `tracing`. `ApiError::internal` messages carry no spec content.
   - The log walk misses the read routes (minor 22).
   - Audit rows are exact per action:
     - `template.update` hides `spec`;
     - `template.delete` counts `productsCleared`;
     - the defaults update target is `template_defaults`/`1`;
     - `host.bootstrap` carries `templateCount`.
   - A product create refused by the unique index after `next_revision` is rolled back.
     The revision and audit are unchanged, and that is tested.
   - Every no-change path returns before `next_revision`.
6. **Documents as wholes.**
   - Read in full:
     - AGENTS «Audit», «Writes», «Change feed», «Catalog and label templates», «Reference
       sync», «Protocol», «Logs» and «Verification»;
     - spec §1, §2, §4.3–4.10, §5.3–5.5, §6–8.
   - The queued minors 13, 19, 21, 23 and 26 are confirmed as still open.
   - Minor 5 is mostly closed already (see triage).
   - New: F5 (an immutable migration comment) and F6 (spec §5.3, plus the eligibility
     fixture's "both sides").
7. **Proto and fixtures.**
   - Naming is consistent: `chzProductGroupCode(s)`, `printName`, `templateId`,
     `default…TemplateId`, `organizationDefault`, `categoryDefaults`.
   - Every request type is `deny_unknown_fields`; no response type is.
   - `OrgRecord` reads an old record as three `None` (serde's missing-`Option` rule; tested).
   - `git diff --diff-filter=MDR` shows no existing fixture touched. The 14 new fixtures all
     round-trip, and `template-eligibility.json` is read by `host/tests/templates.rs`.
   - Zod traps for plan 1e2 are in N9.
8. **Tests as a suite.**
   - Swept every `let (_, …)` in the plan's test files:
     - in `changes.rs` the status is checked indirectly (`keys()` unwraps `items`);
     - `templates.rs:1003-1004` is vacuous (F4);
     - the rest compare whole bodies.
   - Duplicated helpers: minor 25, plus the trigger SQL copied three times (F7).
   - No order or time dependence: each test has its own database, a manual clock and sorted
     keys.
   - Mutant tables: the by-design survivors are as stated. I ran four mutants of my own and
     restored each byte-identically:

| Mutant | Change                                                                                 | Committed suites                                                | Proposed test                                                               |
| ------ | -------------------------------------------------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------- |
| M1     | `routes/changes.rs:177` `let last = page.more_after.or(items.last().map(…))`           | changes 20/20 pass (survives)                                   | killed: `rev` 6 instead of 5 → the station would never get revision 6       |
| M2     | `routes/template_defaults.rs:36` drop `WHERE entity = 'category_template_defaults'`    | template_defaults 17/17 pass (survives)                         | killed: document rev moved 4 → 5 after deleting a non-default template      |
| M3     | `routes/products.rs:312` move `check_references` after the stale compare (`:316`)      | products 14, templates 26, template_defaults 17 pass (survives) | killed: 409 instead of 400 on `chzProductGroupCode` over a stale rev        |
| M4     | `routes/products.rs:234` `list_products` takes `AuthDevice` instead of `OfficeContext` | same suites pass (survives)                                     | killed: GET products with a device key alone → 200 instead of 401 `session` |

Restore check: sha256 of `changes.rs` `e9a6e96a…`, `template_defaults.rs` `4c710321…`
and `products.rs` `8937d4d7…` are equal before and after, and `cmp` is identical. The
scratch probe file (10 probes, all green on the real code) was removed; a copy is at
`/tmp/claude-501/final-review-mutants/zz_final_review_probe.rs` for the fixer. 9. **Scope and process.**

- All 39 paths are under `apps/standalone/{host,proto}`, `apps/standalone/AGENTS.md` and
  the spec.
- Only migration 0008 was added. No manifest or lockfile changed (an empty `*Cargo.*` /
  `package.json` / lockfile diff).
- Each of the 8 commits ends with exactly one
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- `git diff --check e2480a1ad..HEAD` is clean.
- Vitest is not affected: there is no webview change, and Vitest reads only named
  fixtures, none of them changed.
- Test counts re-listed with `cargo test -p markiro-host -p markiro-proto --tests --list`:
  331 (host 292 + proto 39), matching the ledger.

## (a) Findings (new; most severe first)

**F1 (Minor, cross-task: Task 3's check order × Task 4's delete; carry to plan 1e2).**

- Where: `routes/products.rs:312` (`check_references`) runs before `:316` (the stale
  compare), and `routes/templates.rs:374-388` clears the product pointers.
- Scenario:
  1. A product form is opened with `defaultBoxTemplateId: T` at rev r.
  2. T is deleted. The host clears the pointer at the delete's revision, so the product is
     now at r' > r.
  3. The form is saved: it sends T back with `expectedRev: r`.
  4. The answer is **400 `validation_failed` on `defaultBoxTemplateId`, «a box template is
     required»** (observed), not `stale_revision`.
- Nothing is written. But the user sees an error on a field they never touched. If they
  change it, the next save gets 409 and they have to reload and redo the edit.
- Fix: no host change. «Body before record» is the plan's rule for every catalog route.
  Instead, record for plan 1e2 that the product form should treat `validation_failed` on
  `defaultBoxTemplateId`/`defaultPalletTemplateId` as "the template is gone": re-read the
  product and the template list.

**F2 (Minor, test gap; rights).**

- Where: `routes/products.rs:232-235`.
- No test proves that `GET /v1/office/products` needs an office session. Templates
  (`templates_are_read_by_every_role_and_only_with_an_office_session`), defaults and groups
  each have such a test.
- Mutant M4 (the handler takes `AuthDevice`) passes every suite. A station or handheld key
  alone would then read an office route, against «Three identities».
- Products ride the feed today, so nothing leaks now. Office-only product fields would,
  later.
- Fix: one case in `host/tests/products.rs`: a device key only → 401 with `credential:
session`.

**F3 (Minor, test gap; concurrency).**

- Products' «a bad body (400) wins over a stale revision (409)» is unpinned. Mutant M3
  passes the products, templates and defaults suites. Templates and defaults pin it.
- Fix: fold into minor 12's products test. Over `expectedRev` rev−1 and rev+1, a
  `chzProductGroupCode: 18` and an unknown `defaultBoxTemplateId` each answer 400 on the
  field.

**F4 (Minor, test teeth).**

- Where: `host/tests/templates.rs:1003-1004`.
- `let (_, list) = admin.call("GET", "/v1/office/templates", None)` is followed by
  `assert_eq!(list[0]["chzProductGroupCodes"], Value::Null)`.
- Indexing an error object yields `Null`, so the assertion passes even if the list answers 500. That is the same shape that hid Task 4's I1.
- Fix: assert the status is 200, and that `list[0]["id"]` is the template's id.

**F5 (Minor, doc; immutable migration).**

- Where: `host/migrations/0008_catalog.sql:112-114` says the station resolves «its
  category's default, then the organization's, then none».
- This contradicts the product preferences the same migration defines, and the order in the
  plan's «Перенесено» (plan 2a): the product's preference if it still fits, then the
  category default, then the organization's, then the operator's choice.
- 0008 is applied and checksummed, so it cannot be edited.
- Fix: record it in «Отклонения при исполнении» (draft below). Optionally add one AGENTS
  sentence saying the 0008 comment predates the product preferences.

**F6 (Minor, doc; fold into minor 26).** Two passages are false in the present tense:

- Spec §5.3 (`:601-602`): «Таблицы товаров и шаблонов добавит план 1e вместе со своими
  сущностями ленты». The feed entities landed in 1e1; the station tables come in 1e2.
- AGENTS `:446-448` (and spec §4.5 `:385-386`): `template-eligibility.json` «holds the cases
  both sides answer alike». Only the host reads it today; plan 1e2 adds the Vitest side.

**F7 (Minor, helper duplication; fold into minor 25).**

- The trigger that turns the technologist off at the next activity write is copied verbatim
  three times: `tests/products.rs:630-637`, `tests/templates.rs:792-799` and
  `tests/template_defaults.rs:422-429`.
- AGENTS «Verification» says to add a helper to `support/app.rs` before copying one.
- Fix: one `support/app.rs` helper, alongside `nested`.

Notes (no fix needed in the wave):

- **N7.** `changes-catalog.json` puts a category-default tombstone and a template tombstone
  in the same revision (67). No host writer produces that pair in one revision: a template
  that is a default cannot be deleted, and a defaults PUT deletes no template. This is
  harmless as a shape contract. Do not rely on it for revision semantics. Leave the fixture
  as it is.
- **N8.** The PUT precedence on a stock template that is also a default (rename plus
  disable → `stock_template`, by code order) is unpinned; the DELETE precedence is pinned.
  Optional; DROP.
- **N9 (contract notes for plan 1e2 / 1e3).** Request nullability differs field by field:
  - `LabelTemplateUpdate.chzProductGroupCodes` is tri-state (absent = keep, `null` = every
    category), while `null` in `name`/`enabled`/`spec` means keep. A builder that sends
    `null` for "unchanged" would widen a template.
  - `BootstrapRequest.templates` and `StockTemplate.orgDefault` refuse `null` (400 without a
    field).
  - In responses: the org record's three `default…TemplateId` keys are absent from a
    pre-1e1 host. A Zod schema that makes them required would quarantine an older host's
    org record and delete the local copy fail-closed. Use `.nullish()`.
  - `spec` is arbitrary JSON. Parse it as opaque, or with a fixed-key schema, never a
    dynamic-key `z.record`: AGENTS «Reference sync» keeps Zod issue paths in the quarantine
    `reason`.
- **N10 (optional).** The machine probe could be committed as the only test that pins the
  composition of all catalog writers with paging. It caught nothing today. Controller's
  call.

## (b) TRIAGE of the queued minors

| Item                                | Decision        | Reason                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 DDL guards without tests          | DROP            | The route half is closed by Task 3 (`a_gtin_is_unique_among_products_in_use`, `archived_products_may_share_a_gtin_and_come_back_one_at_a_time` kill the full and the `(gtin14, archived)` index). The remaining CHECKs and `SET NULL` are unobservable last lines behind validators and the explicit clearing; dropping `SET NULL` would even fail louder. Carry note: a migration that rebuilds `products`/`label_templates` must keep them. |
| 2 groups shape/order                | CARRY (1e2)     | Bare array by code vs the cloud's `{ items }` by name: 1e2 must not reuse the cloud client.                                                                                                                                                                                                                                                                                                                                                   |
| 3 `reverse_unordered_selects`       | DROP            | Polish; M2c is equivalent.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 4 vacuous scan dir                  | FIX (cheap)     | Assert that every `meta/_journal.json` entry (176 today = 176 `.sql`) has its `<tag>.sql` in the scanned directory.                                                                                                                                                                                                                                                                                                                           |
| 5 wording                           | FIX (remainder) | The AGENTS/spec parts were already closed by the Task 3 brief patch (verified: «the groups»; «не отправляет packages/db/** в задания standalone»). Left: the `host/tests/product_groups.rs:9-10` comment («can only arrive as a NEW migration») holds only while no cloud code writes the table at runtime (none does today: checked `apps/api/src`, `packages`). Say so.                                                                     |
| 6 count cut + byte cut              | FIX             | M1 survives 20/20 and silently loses a revision for a station; the proposed test kills it (scenario verified).                                                                                                                                                                                                                                                                                                                                |
| 7 enabled/stock swap                | FIX (cheap)     | Assert `enabled: true` and `stock: false` in `each_purpose_rides_the_feed_in_its_own_place` (its rows are `enabled 1`, `stock 0`).                                                                                                                                                                                                                                                                                                            |
| 8 `LabelTemplateRecord.stock` doc   | CLOSED          | Reworded in Task 4 (`proto/src/lib.rs`: «…never deleted; it may be disabled or narrowed»).                                                                                                                                                                                                                                                                                                                                                    |
| 9 reviewer notes                    | CLOSED / DROP   | The writers exist now. The DELETE tombstone is pinned through the feed. The Zod deferral is minor 26. The double serialization and early exit are optional performance work (DROP).                                                                                                                                                                                                                                                           |
| 10 `error.rs:110` `gtin`            | FIX             | Trivial comment: `gtin14`.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 11 route-level proofs for Tasks 4/5 | CLOSED          | `template_writes_stop_…` and `template_defaults_writes_stop_…` exist.                                                                                                                                                                                                                                                                                                                                                                         |
| 12 stale ahead side                 | FIX             | Products in the main test commit, together with F3. The siblings (counterparties, lines, operators, org, SSCC counter) in a separate test-only commit, one ahead case each. Pre-existing and wider: office users' PUT and SSCC block sizes have no stale case at all. Include them only if the wave may widen; otherwise CARRY as a hygiene task.                                                                                             |
| 13 doc precision                    | FIX             | AGENTS `:390`, `:392`; `proto/src/lib.rs:1083-1084`.                                                                                                                                                                                                                                                                                                                                                                                          |
| 14 session-row assertion            | FIX (cheap)     | Products' trigger test (`tests/products.rs:623-678`), as templates and defaults already do.                                                                                                                                                                                                                                                                                                                                                   |
| 15 reviewer notes                   | CLOSED          | The forward references came true in Task 4. The present-tense 1e2 rule (AGENTS `:406-411`) is normative and covered by minor 26's sentence.                                                                                                                                                                                                                                                                                                   |
| 16 reordered codes are a change     | DROP            | Cloud parity. Carry a note to 1e3: send codes sorted or as read, because a reorder re-sends a layout of up to 256 KB to every station.                                                                                                                                                                                                                                                                                                        |
| 17 notes                            | DROP            | Carry to 1e2: add a duplicate category-branch case to `template-eligibility.json` when the duplicate rule is written. `58` vs `58.0` fails closed, and JS clients round-trip stably.                                                                                                                                                                                                                                                          |
| 18 shallow-branch depth             | FIX             | Guards the fix of Important I2. One deep-beside-shallow case per arm in the `validate.rs` unit tests, plus one route case.                                                                                                                                                                                                                                                                                                                    |
| 19 four levels naming               | FIX             | «the page object, `items`, the item, `data`» in AGENTS `:428` (names three), `validate.rs:400-401` (lists the layout itself as a fourth) and `validate.rs:1206-1207` (lists `spec` as a fourth). The test docs in `templates.rs` and spec §4.3 say only «four more» and are fine.                                                                                                                                                             |
| 20 `DOCUMENT_REV` filter            | FIX             | M2 survives 17/17; the proposed test kills it.                                                                                                                                                                                                                                                                                                                                                                                                |
| 21 reverse staleness                | FIX             | Observed 409; one clause in the AGENTS defaults paragraph (`:467-469`), optionally the spec §4.3 sentence `:257-259`.                                                                                                                                                                                                                                                                                                                         |
| 22 log walk misses GET              | FIX             | Add `GET …/templates/{id}` (200, body holds `layout-marker-office-2`) and the list. The test needs to run outside the sandbox.                                                                                                                                                                                                                                                                                                                |
| 23 2 MiB body cap                   | FIX (docs)      | AGENTS `:477-479` and spec §4.5 row `:322`. The `DefaultBodyLimit` decision is a CARRY for the owner / plan 1e3.                                                                                                                                                                                                                                                                                                                              |
| 24 wizard audit row                 | FIX (cheap)     | Compare the whole `host.bootstrap` row in test A.                                                                                                                                                                                                                                                                                                                                                                                             |
| 25 `nested` duplicated              | FIX             | Move it to `support/app.rs`, together with the trigger helper (F7).                                                                                                                                                                                                                                                                                                                                                                           |
| 26 what 1e1 leaves to 1e2/1e3       | FIX             | One AGENTS sentence and a spec §6 parenthesis, plus F6 (spec §5.3; the eligibility fixture's "both sides").                                                                                                                                                                                                                                                                                                                                   |
| 27 measurements                     | DROP            | Informational; used in the deviations below.                                                                                                                                                                                                                                                                                                                                                                                                  |

Proposed fix wave (one fixer):

1. **test(standalone): общие помощники тестов хоста.** Covers minor 25 and F7: `nested` and
   the "turn the user off at the next activity" trigger move into `host/tests/support/app.rs`,
   and the three suites use them. No behaviour change. It goes first so that the new tests
   can use the helpers.
2. **test(standalone): итоговая волна 1e1 — зубы тестов каталога и ленты.** Covers minors 4,
   6, 7, 12 (products), 14, 18, 20, 22 and 24, plus F2, F3 and F4; optionally N10.
   - Paths: host tests only, plus the `validate.rs` `mod tests`.
   - The `no_secrets_in_logs` suite and the whole host package must run outside the sandbox.
3. **test(standalone): устаревшая ревизия «впереди записи» на маршрутах с expectedRev.**
   Covers minor 12's siblings. It is test-only and separable, and may be dropped from the
   wave.
4. **docs(standalone): итоговая волна 1e1 — документы и комментарии.**
   - Covers the minor 5 remainder, minors 10, 13, 19, 21, 23 and 26, plus F6; optionally the
     F5 sentence.
   - Paths: AGENTS.md, the spec, `proto/src/lib.rs`, `error.rs`, the `validate.rs` doc
     comments (the constant and the unit test) and the `product_groups.rs` comment.
   - Run prettier on the MD files.
5. (Controller) «Отклонения при исполнении» in the plan, as its own commit (draft below).

## (c) DEVIATIONS TO RECORD (Russian draft for «Отклонения при исполнении»)

- **Числа тестов.**
  - План: хост+proto после задач — 246 / 251 / 263 / 276 / 283 / 286, воркспейс — 40 наборов
    и 392 теста (хост 247, proto 39, оболочка 106).
  - Факт: 248 / 255 / 273 / 301 (307 после правки ревью задачи 4) / 325 / 331, воркспейс —
    40 наборов и 437 тестов (хост 292, proto 39, оболочка 106), без предупреждений
    компилятора.
  - Сверх плана — 45 тестов:
    - задача 1 — 2: защита от расхождения справочника групп;
    - задача 2 — 2: порция ровно в бюджет байтов; у каждого назначения своё место в ленте;
    - задача 3 — 6: архивные товары делят GTIN и возвращаются по одному; порядок списка;
      границы полей; `PUT` всех десяти полей; запись целиком; `require_catalog_in` на
      маршруте;
    - задача 4 — 15, и ещё 6 в правке ревью;
    - задача 5 — 11;
    - задача 6 — 3.
  - Итоговая волна добавит своё.
  - `cargo test --workspace` не уложился в одно фоновое окно: два прогона убиты на
    15 минутах. Гейт прогнан частями после `--no-run`.
- **Задача 1, правка ревью (a87028fe1).**
  - Тест справочника групп не только сверяет строки с `0099`, но и падает, если другая
    облачная миграция пишет в `chz_product_groups` (`migrations_writing_groups`, ещё два
    теста).
  - Фраза плана «копии не разойдутся» / «the copies cannot drift» в AGENTS, в §4.3 и в
    комментарии теста заменена тем, что доказано. Тест идёт в заданиях standalone, а
    `tools/ci/affected.mjs` не отправляет туда `packages/db/**`, поэтому такую миграцию
    поймает следующий запуск заданий standalone.
  - Маршрутизация CI не менялась (см. «Перенесено»).
- **Задача 3: бриф поправлен до исполнения.** Исходные фрагменты шага 5 — первый абзац AGENTS
  «Catalog and label templates» и пункт §4.3 о группах — несут текст правки задачи 1, а
  итоговые — уточнённую формулировку («the groups», «не отправляет packages/db/** в задания
  standalone»).
- **Задача 4, правка ревью (d4a05d6c4).**
  - Разрешение в сводке списка читается текстом JSON (`spec -> '$.dpi'`, когда
    `json_type = 'integer'`) и разбирается как `u32`, иначе `null`. План читал его через
    `json_extract` в `Option<i64>`, и целое больше `i64::MAX` роняло список для всех ролей.
  - Макет — не глубже `MAX_SPEC_DEPTH` = 64 уровней (`validation_failed` на `spec`, у
    мастера — на `templates.{i}.spec`). Страница ленты добавляет к макету четыре уровня, а
    оболочка станции разбирает ответ `serde_json` с пределом 127. Макет глубже 123 уровней
    хост сохранил бы, но страница с ним не разобралась бы, и лента встала бы у всех станций.
  - Ограничение 1 плана глубину не называет; AGENTS и §4.3 называют.
- **Комментарии применённой миграции 0008 неполны; миграция не правится.**
  - Про `spec` сказано только «не больше 256 КБ», без глубины.
  - Порядок выбора шаблона станцией указан как «категория, затем организация, затем ничего»
    — без пожелания товара.
  - Верен порядок из «Перенесено» (план 2a): пожелание товара, если подходит, затем умолчание
    категории, затем организации, затем выбор оператора.
- **Пункт ревью задачи 2 закрыт в задаче 4.** Комментарий `LabelTemplateRecord.stock`
  («never changes») переписан: у типового шаблона не меняются имя, назначение и макет, а
  выключить и сузить его можно.
- **`expectedRev`.**
  - Шаблоны и умолчания проверены с обеих сторон: ревизия старше записи и новее неё. Товары —
    в итоговой волне.
  - Закреплено сверх текста плана:
    - тело запроса (400) проверяется раньше ревизии (409);
    - правка профиля организации делает устаревшей открытую форму умолчаний, даже если та
      повторяет документ;
    - и наоборот: `PUT` умолчаний, который меняет умолчание организации, делает устаревшей
      открытую форму профиля, хотя `GET /v1/office/org` умолчаний не показывает.
- **Типовые шаблоны.**
  - Макет сравнивается как разобранный JSON: `58` и `58.0` — разные значения, и такой отказ
    закрыт. `PUT` с его же именем и макетом принимается.
  - Удаление типового шаблона, который стоит по умолчанию, — `stock_template` раньше
    `template_is_default`. `PUT` с новым именем и выключением такого шаблона — тоже
    `stock_template` (по порядку кода).
- **Мастер.**
  - `templates` — до 32, но тело запроса ограничено 2 МиБ axum по умолчанию. Это около
    восьми макетов предельного размера; тело больше — `validation_failed` без поля.
  - Настоящий набор домена — 20 шаблонов (16 коробов, 2 паллеты, 2 дубликата), 31 КБ списком,
    3 уровня.
  - Хост принимает `orgDefault` у шаблона любого назначения, дубликата тоже. Решение
    контроллера (5) касается только того, что пошлёт мастер плана 1e3.
- **Решения контроллера по вопросам планировщика** (владелец может пересмотреть):
  - шаблоны товара по умолчанию остаются;
  - умолчания дубликата у организации и категорий остаются;
  - потолки 100 000 / 10 000 / 3 650;
  - ревизия документа умолчаний — самая новая из записи организации, умолчаний категорий и
    их надгробий;
  - мастер 1e3 назначает умолчания короба и паллеты.
- **Процесс.** Сообщение коммита задачи 4 называет 118/116 мутантов, а отчёт — 119/117:
  мутант R75 запускали после коммита. История не переписывалась.
- **Дополнить «Перенесено».**
  - CI: отправлять `packages/db/migrations/**` в `standalone_rust` (или завести защитный
    тест на облачной стороне) — решение по CI (задача 1).
  - План 1e2:
    - форма товара, открытая до удаления её шаблона, получает `validation_failed` на
      `defaultBoxTemplateId`/`defaultPalletTemplateId`, а не `stale_revision` — перечитать
      товар и список шаблонов;
    - схема Zod записи организации: три `default…TemplateId` — `nullish`, потому что запись
      старого хоста их не несёт;
    - `spec` — непрозрачный JSON или схема с фиксированными ключами, не `z.record`: причина
      карантина хранит пути Zod;
    - в `PUT` шаблона `chzProductGroupCodes: null` расширяет его на все категории, а `null`
      в `name`, `enabled` и `spec` значит «оставить»;
    - `templates` и `orgDefault` мастера не принимают `null`;
    - справочник групп хоста — массив по коду, а не облачный `{ items }` по имени;
    - фикстуру `template-eligibility.json` дополнить случаем категории для дубликата, когда
      появится правило дубликата.
  - План 1e3:
    - коды категорий шаблона слать отсортированными: переставленный список — изменение, то
      есть новая ревизия и макет до 256 КБ по ленте всем станциям;
    - граница тела мастера (2 МиБ по умолчанию или `DefaultBodyLimit` на `/v1/bootstrap`) —
      решение владельца или плана 1e3.

## (d) Not verified

- Windows (`standalone-windows-build` needs a push).
- The full `cargo test --workspace` and Vitest were not re-run by me, per the brief. The
  controller's chunked gate reported 437 passed and 0 failed; the Task 6 implementer reported
  Vitest 813.
- What I ran myself:
  - focused suites under the mutants: changes 20, template_defaults 17, products 14,
    templates 26, all green;
  - 10 scratch probes;
  - `--list` (331 tests).
- `no_secrets_in_logs` was not run by me: it binds loopback and needs to run outside the
  sandbox.
- A live station: the machine probe models the upsert and tombstone rules only — not the
  real `reference-sync`, the quarantine, `local_transaction` limits or IPC sizes.
- An older station build reading the new feed: checked by code reading only. It skips
  unknown entities, and `orgRecordSchema` is `z.object`.
- Real 20-template domain sets through the wizard: only their sizes were measured, by the
  Task 6 reviewer.
- TLS body streaming near 2 MiB (an early 400 while the client is still sending) was checked
  in-process only.
- Behaviour at scale was not measured:
  - a template list with many 256 KiB layouts;
  - the feed's per-item record reads;
  - a template delete that clears thousands of products in one revision.
- Real concurrent writers: argued only from `BEGIN IMMEDIATE` serialization.
