# Plan 1e2 — final whole-plan review (c4c410998..f65920873)

**Verdict: WITH FIXES** — Critical 0, Important 0, Minor 6 new (F1, F3–F7), plus the 26 queued
minors triaged below (minor 5's VERIFY resolved as F2). Nothing blocks; the one fix wave should
land the FIX/DOC rows below, then the controller writes the deviations section.

Reviewer: opus, final whole-plan review. Read in full: the brief, `1e2-design.md` (D1–D10),
`1e2-constraints.md`, `1e2-minors.md`, the ledger from «2026-10-04 … after plan 1e1» to the end,
`apps/standalone/AGENTS.md` (whole), the spec §4.3–§4.6, §5.3–§5.5, §6, §8, the plan's «Итоговая
проверка» and «Перенесено», and the whole 300 KB diff. Cross-checked against host and domain source:
`proto/src/lib.rs` (catalog types), `host/src/server.rs` (router), `routes/{products,templates,changes,bootstrap}.rs`,
`validate.rs`, `templates.rs`, host migration `0008` (51 groups, none with code 0),
`packages/domain/src/gs1/gtin.ts`, `labels/eligibility.ts`, `src/host/client.ts` (`HostError.field`),
`form-errors.ts`, `records.tsx`, `reference-sync.ts` (whole), `test/support/local-db.ts`.

## Gates seen by this review

- Controller's webview gates (ledger): Vitest 40 / 958, stderr 0; typecheck, lint, build clean.
- Cargo gate (controller, running in this worktree): fmt 0, check 0, `--no-run` 0, **chunk A 19 suites /
  244 tests passed** (host 198, proto 34, shell 12 — exactly the plan's numbers, counted by a script over
  `/tmp/claude/1e2-gate-chunkA.log`). Chunk B and the doc stage were still running when this report was
  written; their result is the controller's (ledger).
- My own runs (all inside the sandbox, Vitest only, no cargo):
  - machine probe (below): 41/41 passed;
  - delayed-`setImmediate` stand on `product-dialog`, `products-page`, `form-errors`: 53/53, stderr 0 bytes;
  - three spot mutants (below), each restored byte-identically (`cmp` silent, sha256 equal);
  - scope: `git diff --stat c4c410998..HEAD -- apps/standalone/host apps/standalone/proto apps/station packages`
    empty; 32 files, all allowed; six trailers exact once each; `git diff --check` clean; tree clean
    after every probe/mutant/stand run.

## (a) Findings, most severe first

All are Minor. None changes data on the host or a station today.

**F1 — Minor (test teeth). An archived draft's state is unpinned.**
`src/office/products/product-list.ts:9` (`productState`: archived wins). My mutant
`product.status === "draft" ? "draft" : product.archived ? "archived" : product.status` passes
`products-page.test.tsx` + `product-dialog.test.tsx` 42/42. Scenario: a refactor that reads the status
first labels an archived draft «Черновик», keeps it under the «Черновик» filter and drops it from
«В архиве». Archived drafts are real (the feed fixture's KEFIR is exactly one). Every archived product in
the page tests (`AYRAN`) is `active`. Fix (count unchanged): in `test/products-page.test.tsx` make `AYRAN`
an archived **draft** (`boxCapacity: null`, `status: "draft"`); the existing filter test (`draft` →
`["Вода 2"]`, `archived` → `["Айран"]`) and the chip test («В архиве», `mk-chip--retired`) then fail on
the mutant. Check its other uses in that file first (names order and the «Код 99»/«—» cells are unaffected).

**F2 — Minor 5 resolved (test teeth). `rules.productGroup` is rendered by no test.**
Seven of the eight new `rules.*` texts are rendered by `product-dialog.test.tsx` (verified by grep of the
Russian text). «Выберите группу из списка» is unreachable from the UI (the select offers only `""` and
valid codes) and `test/rules.test.ts:503` pins only the key string, so a typo in the `ru.json` key would
not throw anywhere (the missing-key throw needs a render). Fix: in that test,
`expect(i18n.t("rules.productGroup")).toBe("Выберите группу из списка")` with the singleton from
`src/i18n/index.js` (already initialized by `test/setup.ts`), or loop all eight keys through `i18n.exists`.

**F3 — Minor (doc, now false about what exists).** Spec §5.5 `:690-691`: «Формы проверяют поля
правилами `@markiro/domain` (`normalizeToGtin14`, `gtinMatchesPrefix`, `labelTemplateSpecSchema`) до
отправки на хост.» Plan 1e2 implemented `gtinMatchesPrefix` as an owner hint that never blocks a save
(AGENTS «Office pages», `ProductDialog`), and `labelTemplateSpecSchema` is plan 1e3's. Fix, e.g.:
«Формы проверяют поля правилами `@markiro/domain` до отправки на хост (`normalizeToGtin14`; макет —
`labelTemplateSpecSchema` экранов шаблонов плана 1e3); `gtinMatchesPrefix` только подсказывает владельца
GTIN и сохранению не мешает.»

**F4 — Minor (doc, overstated).** AGENTS `:541-542`: «Zod schemas and request builders for every catalog
shape». The wizard's `templates` have no builder (typed by the strict `bootstrapRequestSchema`; the 1e3
wizard builds its body inline — AGENTS «Protocol» says so). Fix: «Zod schemas for every catalog shape and
a builder for every office request body of the catalog».

**F5 — Minor (doc, tense; pre-existing sentence that the new copies make read as fact).** AGENTS
`:436-441`: «…is the domain's rule, which the office applies when it offers templates and the station
before it uses one». The office part is now true; the station part is plan 2a's. Same in spec §4.3
(products bullet: «…проверяют интерфейс при выборе и станция перед печатью»). Fix: «…and the station
will before it uses one (plan 2a)» / «…и станция будет проверять перед печатью (план 2a)».

**F6 — Minor (doc wording).** AGENTS `:670`: «typed by the strict `bootstrapRequestSchema`, which reads
`bootstrap-request-templates.json`» — a schema reads nothing. Fix: «…`bootstrapRequestSchema`, against
which `test/protocol.test.ts` parses `bootstrap-request-templates.json`».

**F7 — Minor (doc + carry; pre-existing mechanism that now covers the catalog).** AGENTS «Reference
sync» `:602-608`: «The same late page … moves `last_rev` back to its own revision, so the next sync
fetches that tombstone again and deletes the record anew.» True for ONE late page. My probe's
deterministic case shows two late pages of one station (two `device_forget` + re-pair cycles with the
same host while two fetches are in flight), landing oldest first: the older puts back a template the new
run deleted by tombstone; the newer, started after the tombstone was applied, carries no tombstone and
moves `last_rev` past it; no later sync ever deletes the template. The same holds for a turned-off
operator or a revoked badge (which is why plan 1f's precondition exists) and, since 1e2, for a deleted
template or a cleared category default that plan 2a will read. Needs two forgets within one request
window (`PinnedClient` gives up after 10 s), so it is practically negligible; the pairing-scoped
`hostGuard` (plan 1f precondition) closes one and two late pages alike. Fix: DOC — append «(one late
page; two late pages landing oldest first can keep the record for good, which only the pairing-scoped
guard of plan 1f closes)»; CARRY — extend the plan's «Перенесено» 1f item: the same guard protects the
catalog copies plan 2a reads.

Notes that are not findings: (1) a product whose stored GTIN fails the check digit (the host checks
shape only; no current writer creates one) cannot be saved from the dialog until its GTIN is fixed — fine
today, worth remembering when an importer (1С) lands; (2) a copy's `spec` loses integers beyond 2^53
through `JSON.parse` (canonicalizing does not restore them) — irrelevant for real layouts, one clause for
plan 2a's digest item if wanted; (3) an office read whose list holds an unknown enum value (a newer
host's `purpose` or `status`) fails as a whole — the existing protocol policy, carried to plan 5.

## What I checked per seam

1. **Wire layer as one contract.** Every catalog Zod schema against `proto` field by field: nullable vs
   absent (`OrgRecord`, `ProductRecord`, `LabelTemplateSummary`, `TemplateDefaults` always serialize their
   `Option`s as `null`; `orgRecordSchema` takes them `.nullish()` for a pre-1e1 host; `StockTemplate.orgDefault`
   and `BootstrapRequest.templates` skip when empty → `.optional()`; serde refuses `null` there, Zod too).
   Host ids are `Uuid::new_v4()` everywhere (products, templates incl. the wizard's) → `z.uuid()` is safe;
   the host trims and stores 14 digits → the feed's `^[0-9]{14}$` holds; `widthMm`/`heightMm` are
   `serde_json::Number` (fractional, even 1e19/1e23 in host tests) → `z.number()`; `dpi` `u32` → int ≥ 0.
   Builders: `productCreate`/`productUpdate` name every key (TS requires them; the «whole bodies» test pins
   the schema) — a PUT can never clear a field by omission; `templateUpdate` never sends `null` for
   name/enabled/spec (host: `Option` without `nullable` = keep) and keeps the tri-state categories with an
   order-sensitive compare, matching the host's `Vec` compare and stored order. `HostApi`: all 11 paths and
   methods equal `server.rs`; `deleteTemplate` parses the 204 with `NO_CONTENT`; `template_is_default`
   details reach `HostError.details` through `errorBodySchema`. Fixtures: 13 by `protocol.test.ts`
   (incl. `changes-catalog.json` there and in `reference-sync.test.ts`), the 14th by
   `template-eligibility.test.ts`; five request fixtures produced exactly by their builders. No mismatch.
2. **Station copies as one machine — the probe.** A scratch Vitest file (kept at
   `/tmp/claude/1e2-final-review/zz-1e2-machine-probe.test.ts`; copied into `apps/standalone/test/` only for
   each run and deleted right after) models the host's feed exactly as `routes/changes.rs` builds it
   (keys by `rev, entity, id, deleted DESC`; `limit` cut only between revisions, a revision that fills the
   page sent whole; byte budget cut before the revision that would pass it, the first revision whole) and
   drives four stations per seed through the real `syncReferences` on `test/support/local-db.ts`, with a
   JSON round trip per page (as IPC does). Random host operations obey the host's rules: the wizard (three
   stock templates and the org defaults in one revision), template create/update/delete (delete clears
   product preferences at its revision and leaves a tombstone; defaults are never deleted or broken),
   product create/update and 40-product revisions, whole-document defaults (set, change, clear → tombstone,
   re-set → tombstone dropped, org defaults rewrite the org record), org edits, records a newer host could
   send that this build cannot read (unknown purpose/status, a non-UUID id, the org's default id `"7"`) and
   their later repair, late batches (a fetch answered now, committed later) and a replay from `last_rev` 0. After every full sync a station's copies must equal the host's readable state column by column
   (`spec` = `JSON.stringify` of the parsed layout) and `sync_quarantine` must equal the set of unreadable
   records. **40 seeds × 300 steps: 1 398 checked full syncs, 307 late batches, then a final sync and a
   replay per station — all converge** (26 233 pages: 24 208 with `hasMore`, 3 603 whose first revision
   exceeded the byte budget and came whole, 2 998 with a template tombstone before products of its own
   revision). Batches never exceeded 32 statements (the harness enforces it). The probe has teeth: mutant
   M1 (below) fails all 10 seeds it ran. With more than one late batch per station allowed, convergence
   breaks — that is F7, reproduced deterministically. Answers to the brief's questions: no sequence within
   one late batch per pairing leaves a product naming an unresolvable template other than by design (a
   template waiting in quarantine), a stale layout, or a lost org default; no record the schemas accept is
   refused by SQLite (NOT NULL columns are exactly the schema-required fields, `->>` yields 0/1, JSON text
   or NULL, no FK/UNIQUE/CHECK). `SYNC_SCHEMA_VERSION` 4 is enough: an old station skips the catalog
   entities and drops the org's new keys (lenient); a new station on a pre-1e1 host reads the org record
   with NULL defaults; the first v4 sync drops old copies only with its first committed page.
3. **Office flows end to end.** Sorting (`activeFirstByName` at render), in-place replace and append
   (`withRecord`), archive moving a row, search/filter/pager with page reset and clamp; groups static and
   shared by page and dialog; templates read at every dialog open; org/counterparties share keys and data
   shapes with their pages. Write path: body built before the `try` from the resolver's output, every field
   re-trimmed by `toProductInput`, the OPENED record's `rev` (the dialog keeps its own snapshot); hint and
   submit both use `toGtin14` on the same trimmed input. Nothing sends what the user did not intend: a
   failed or pending template read keeps the ids (Controller value, disabled `<select>` only, kept ids
   always among the options); a failed or pending group lookup keeps the group the same way. D9:
   `HostError.field` exists only for `validation_failed`, `check_references` runs before the revision, a
   wrong-purpose id cannot come from the filtered options → only a deleted template triggers it. Roles:
   both, D10 gate tested with both. Accessibility: labels, live GTIN notes, words for states and marks;
   the pager label is not live (minor 15).
4. **Rules mirror.** `gtinRule` = the domain's shape (ASCII digits, 8/12/13/14) + `isValidGtin`
   (`normalizeToGtin14` uses ASCII `\d` too); caps and messages agree with `validate.rs` (100 000 /
   10 000 / 3 650 / 200 characters, code points, control characters); `templateFitsSlot` ≡ domain ≡
   host `templates::fits` on every input (12 shared cases plus the duplicate tests; minor 1 for teeth).
5. **Secrets, logs, data.** No `console`, storage or record body in the new webview code; quarantine
   reasons are paths and codes only (`spec: custom`, `gtin14: invalid_format`, indexes, never values);
   `clear_copies` empties the three new tables (Rust test) and the org row with its new columns; `0004`
   is `ALTER TABLE ADD COLUMN` + new tables, `0001`–`0003` untouched.
6. **Documents as wholes.** Read AGENTS whole and the spec sections after the plan: every `1e2` mention
   describes finished work (AGENTS 328, 541, 657; spec 302, 382, 404, 622, 726, 827, 877); new findings
   F3–F7 beyond the queued 3, 10, 20, 21, 23.
7. **Tests as a suite.** Count arithmetic: 813 + 28 + 52 + 22 + 20 + 16 + 7 = 958, files 37 → 40. Stand
   clean. Titles: the queued 4, 7, 9, 20, 21, 22; none else misleading. Spot mutants (below): one new
   survivor (F1).
8. **Scope and process.** As listed under «Gates».

### Spot mutants (copy-first, restored byte-identically)

| Mutant                                                                           | Files run                         | Result                                        |
| -------------------------------------------------------------------------------- | --------------------------------- | --------------------------------------------- |
| D: `productState` reads the status before the archive flag                       | products-page, product-dialog     | **survives 42/42** → F1                       |
| M1: products upsert stops updating `default_box_template_id` on a newer revision | reference-sync + probe (10 seeds) | killed (Task 3's added test; all probe seeds) |
| (probe-teeth) many late batches per station                                      | probe                             | breaks convergence → F7 (pre-existing)        |

## (b) Triage of the queued minors

| #   | Decision  | Reason                                                                                                                                                                                                                                                          |
| --- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | FIX       | duplicate-branch survivors; the shared fixture has no such case until a plan changes `proto`; two assertions                                                                                                                                                    |
| 2   | FIX       | doc comment of `toGtin14`: «throws `DomainError` (`GTIN_INVALID`) for anything `gtinRule` refuses; call it on the rule's output» (both callers comply today)                                                                                                    |
| 3   | DOC       | wording false/loose (`MAX_PRODUCT_NAME` is no host constant; group existence stays the host's)                                                                                                                                                                  |
| 4   | FIX       | title false until `productNameRule`/`printNameRule` join the lone-surrogate loop                                                                                                                                                                                |
| 5   | FIX       | resolved as F2: seven keys rendered, `rules.productGroup` needs one assertion                                                                                                                                                                                   |
| 6   | CARRY     | hygiene outside the diff; invisible (the first issue is the one shown either way) — next plan touching `rules.ts`                                                                                                                                               |
| 7   | FIX       | factually wrong title (the deviations section records the plan's error)                                                                                                                                                                                         |
| 8   | FIX       | cheap: `schema.parse(fixture(name))` instead of the cast at `protocol.test.ts:1035`                                                                                                                                                                             |
| 9   | FIX       | title omits the negative-`dpi` assertion                                                                                                                                                                                                                        |
| 10  | DOC       | AGENTS attributes the GTIN reason to the migration; never edit `0004`                                                                                                                                                                                           |
| 11  | FIX       | one comment: the purpose/stock transitions are synthetic, pinning «every column is assigned»                                                                                                                                                                    |
| 12  | CARRY     | already in «Перенесено» 2a (WebView2); add «a large-`values` case in `tests/ipc.rs`» to that item                                                                                                                                                               |
| 13  | FIX       | GTIN search with two space runs — one assertion                                                                                                                                                                                                                 |
| 14  | FIX       | one alert and one «Повторить» when both reads fail; `LoadError` retries the groups too; a test (new or inside «explains a failed load and loads again»)                                                                                                         |
| 15  | FIX       | `aria-live="polite"` on the page label + one-line comment why not the shared `Pager`                                                                                                                                                                            |
| 16  | FIX       | reword the T20 comment (the FOUND list shrinks, not the cached one)                                                                                                                                                                                             |
| 17  | DROP      | absorbed by 20                                                                                                                                                                                                                                                  |
| 18  | FIX       | multi-prefix counterparty — owner silently wrong on regression; no count change                                                                                                                                                                                 |
| 19  | FIX       | pin `setFailure(null)` in the product dialog (siblings: pattern-wide, leave)                                                                                                                                                                                    |
| 20  | FIX + DOC | UI copy + AGENTS + spec + test title all say what the code does (group OR either capacity). Suggested copy, unambiguous: «Пока не указаны все три — товарная группа, вместимость короба и число коробов на паллете, — товар остаётся черновиком.»               |
| 21  | DOC       | parity overstated in AGENTS, spec §5.5, `product-form.ts` docstring, test title («…except that counterparties go active first, by name»)                                                                                                                        |
| 22  | FIX       | four titles + use `PALLET`                                                                                                                                                                                                                                      |
| 23  | DOC       | the short-id labels («Шаблон a3b4c5d6…», «… — нет в списке»)                                                                                                                                                                                                    |
| 24  | DROP      | rated IGNORE: D9, not cache policy, is the guarantee                                                                                                                                                                                                            |
| 25  | FIX       | «Не выбран» value unpinned; a regression sends a bogus id disguised by D9 as «Данные изменились…»                                                                                                                                                               |
| 26  | CARRY     | owner/UX question. Nuance: a loss-free route exists (the form stays editable: choose another template or «Не выбран» and add again), but nothing names the deleted template and the alert offers only «Загрузить заново». Options for the owner in «Перенесено» |

New: F1 FIX, F2 = minor 5, F3–F6 DOC, F7 DOC + CARRY.

I agree with the controller's leanings throughout; the only shifts are 6 (CARRY, effectively droppable),
26's nuance, and 2 counted as a doc comment.

**Proposed fix wave (one fixer, three commits; Vitest count stays 958 unless 14 gets its own test):**

1. _Tests and titles (no behaviour change):_ 1, 4, 5/F2, 7, 8, 9, 11, 13, 16, 18, 19, 21 (title only),
   22, 25, F1.
2. _«Товары» behaviour with its tests:_ 14, 15, 20 (`ru.json` copy, the test's hint string and title).
3. _Documents and doc comments:_ 2, 3, 10, 20 (AGENTS, spec), 21 (AGENTS, spec, `product-form.ts`
   docstring), 23, F3, F4, F5, F6, F7 (AGENTS sentence). Then the controller: «Отклонения при исполнении»
   and the «Перенесено» additions (draft below).

## (c) Deviations to record — Russian draft for «Отклонения при исполнении»

- **Счёт тестов.** План заканчивается на Vitest 40 файлов / 937 тестов, сборка — на 40 / 958 (+21).
  Задача 1 — +28, как в плане (внутрь теста добавлено `toHaveLength(1)`: проверки Zod 4 идут дальше
  первой ошибки). Задача 2 — +52 вместо +43: 34 из 148 мутантов исполнителя пережили тесты плана, девять
  новых тестов их закрыли. Задача 3 — +22 вместо +17: пять новых тестов (столбцы upsert, которые не
  обновлялись на более новой ревизии; `null` в шаблоне короба организации). Задача 4 — +20 вместо +13:
  семь новых тестов (13 из 47 мутантов выжили). Задачи 5 и 6 — +16 и +7, как в плане: утверждения
  добавлены внутрь 10 и 4 тестов. Поэтому в «Итоговой проверке» весь набор — 958 тестов, девять файлов —
  453, а не 432. Cargo — как в плане: 41 набор, 453 теста (хост 307, `proto` 39, оболочка 107).
  Ни одно утверждение плана не ослаблено (проверило ревью каждой задачи); тексты тестов задач 2–6
  отличаются от плана добавками.
- **Ошибка плана про `null` в правке шаблона.** Вступление задачи 2 и заголовок теста «refuse null where
  the host does not take it…» утверждают, что хост отвергает `null` в `name`, `enabled` и `spec` тела
  `PUT /v1/office/templates/{id}`. На деле хост читает там `null` как «поле не прислано» и оставляет
  значение (`routes/templates.rs`, `update_template`: поля `Option` без `nullable`); `null` у
  `chzProductGroupCodes` расширяет шаблон на все категории, а `null` в `orgDefault` и `templates` мастера
  хост отвергает. Закреплённое поведение верно — схема отвергает `null` в трёх полях, сборщик его не шлёт;
  docstring, AGENTS «Protocol» и сообщение коммита говорят верно; заголовок теста исправлен волной правок.
- **D9 — по уточнению планировщика.** «Загрузить заново» сразу перечитывает список товаров, а список
  шаблонов перечитывается при следующем открытии диалога (`staleTime` 0) без явного сброса кэша; тест
  закрепляет второе чтение. В режиме добавления то же предложение закрывает окно и теряет введённый товар
  (на хосте ничего не записано) — перенесено вопросом владельцу.
- **Свой пейджер.** Страница «Товары» листает своим `ProductsPager`, а не общим `Pager` из `@markiro/ui`:
  у общего кнопки размера `floor` во всю ширину и нет параметра размера, а `packages/*` план не меняет
  (у страницы каталога облака тоже свой пейджер). Ревью задачи 4 это приняло; волна правок добавила
  `aria-live` подписи страницы и комментарий.
- **Волна правок итогового ревью** (заполнить хешами после волны): тесты и заголовки (миноры 1, 4, 5, 7,
  8, 9, 11, 13, 16, 18, 19, 21, 22, 25 и состояние архивного черновика); поведение «Товаров» (14 — одно
  сообщение и одна кнопка «Повторить», когда не загрузились ни товары, ни группы; 15; 20 — текст про
  черновик); документы (2, 3, 10, 20, 21, 23 и пять правок формулировок итогового ревью).

«Перенесено» — добавить:

- План 1f: `hostGuard`, привязанный к подключению, защищает и копии каталога. Две поздние порции одной
  станции (две отвязки с повторной привязкой к тому же хосту, пока в полёте два запроса), пришедшие
  старшая первой, оставляют навсегда шаблон, удалённый надгробием, или снятое умолчание категории
  (проба итогового ревью); одну позднюю порцию следующая синхронизация исправляет. План 2a читает эти
  копии.
- План 2a: к пункту о параметре в несколько МиБ — ещё случай с большим `values` в `tests/ipc.rs`
  (мок-рантайм Tauri) рядом с проверкой на WebView2.
- Решение владельца: в режиме добавления отказ по удалённому шаблону (D9) предлагает только «Загрузить
  заново», которое закрывает окно и теряет введённый товар. Варианты: отказ под выбором шаблона
  («шаблон удалён — выберите другой») с перечитыванием списка шаблонов; или перечитать шаблоны, пометить
  удалённый «— нет в списке» и оставить форму открытой.
- Гигиена правил: у `glnRule` та же короткая схема, что у GTIN, без закрепления «одна проблема»
  (`toHaveLength(1)`) — следующему плану, который трогает `rules.ts`.

## (d) What could not be verified

- A real Tauri webview/WebView2: layout, focus order, the `Select native` rendering, CSS of the page and
  dialog (jsdom only; the 500 kB chunk notice untouched).
- A multi-MiB revision through real IPC (`invoke` → `local_transaction`): pinned only at `LocalDb` level
  (Rust) and in node:sqlite (Vitest).
- Windows, a live host and station pair over the LAN, two office PCs editing the same product or deleting
  a template mid-edit (D9 in the real app), a station upgraded from a v3 database in place.
- Screen readers (live regions are asserted by attribute only).
- Cargo chunk B and the doc stage: still running at writing time (chunk A green); the controller's ledger
  carries the result.
