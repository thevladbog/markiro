# Plan 1e2, Task 6 — report

Status: DONE_WITH_CONCERNS (concerns are notes for the controller, none blocks).

Commit: `f65920873` feat(standalone): шаблоны по умолчанию в диалоге товара и отказ по удалённому шаблону
(base `9d3363a81`; one commit; the message ends with exactly one `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; `git status --short` empty after it).

Tests: Vitest 40 files / **958** tests (951 + 7), as the controller predicted. The brief's «937 (930 + 7)» differs by the +21 earlier tasks added beyond the plan. Brief's Step 4 «33 (11 and 22)» holds exactly: `form-errors.test.ts` 11, `product-dialog.test.tsx` 22.

## What I did

1. Read the three guides, recorded HEAD (`9d3363a81`), reproduced the baseline: 40 files / 951 tests, exit 0.
2. To avoid any transcription error in Cyrillic text and whitespace I applied the brief mechanically: a small parser (`/tmp/claude/t6/apply.py`, outside the repo) extracts every «фрагмент … заменить на …» pair and the `Create` block from the brief, checks that each fragment matches exactly once in the file as it stands at that moment, and only then writes. Dry run first: **all 21 fragments of Steps 1, 3 and 6 matched exactly once** (4 + 12 + 5) and the `Create` target did not exist. The 7 mutation fragments matched exactly once after Step 3 (before it they cannot, as the controller said).
3. Step 1 (tests) → Step 2 RED → Step 3 (implementation) → Step 4 GREEN, verbose, stand → Step 5 mutations → Step 6 documents and reconciliation → Step 7 checks and commit.
4. Beyond the plan: my own mutants found six holes in the plan's tests; I closed them with assertions inside existing tests (count unchanged). Details below.

## RED (Step 2)

`pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/form-errors.test.ts test/product-dialog.test.tsx` → `Tests 7 failed | 26 passed (33)`, exactly as the plan says:

- `form-errors.test.ts` 1 of 11: `AssertionError: expected { kind: 'alert', …(1) } to deeply equal { kind: 'stale' }`.
- `product-dialog.test.tsx` 6 of 22: five `TestingLibraryElementError: Unable to find a label with the text of: Шаблон короба`; one (`keeps the template choices off while the templates do not load…`) `Unable to find an element with the text: Список шаблонов не загрузился: шаблоны останутся как есть.`

## GREEN (Step 4)

- Same command → `Test Files 2 passed (2)`, `Tests 33 passed (33)`, exit 0.
- `--reporter=verbose`: stdout/stderr captured separately; **stderr 0 bytes**; no `act(`, `Warning:`, `Unhandled` or `Error:`; per file 11 and 22.
- Delayed-`setImmediate` stand (the two files from `1e2-constraints.md`, created, run, deleted): 33 passed, stderr 0 bytes, files removed (`git status` shows neither).
- Repeated 6 times: 6 × 33 passed. Because I changed the tests after the first hygiene runs, verbose and stand were run again on the **final** test files (results above are from that second pass; the first pass was identical).

## Mutants (Step 5)

Driver scripts: `/tmp/claude/t6/mutate.sh` (plan's mutants, fragments taken from the brief by the parser) and `/tmp/claude/t6/xmut.sh` (mine). For every run: pre-mutation copy under `/tmp/claude/t6/before-*` / `xbefore-*`, `shasum -a 256` before, after the mutation (differs in all runs) and after the restore, `cmp` against the copy (silent every time). File hashes (identical before and after every mutation of that file; they are also the hashes of the committed files):

- `form-errors.ts` `92c8e9404a025dacf5bd5ecc419f20aa1430a848c075841fdca8c025dc9c03fc`
- `ProductDialog.tsx` `434b2dd8f812d8fa86de444841bf97c40df359d8b1beea763bb1a9d08a001202`
- `product-queries.ts` `b3dd726ff8633e81a002a63be862bec0a8b34b3b3c2fb9b78a7bf2f68e3a82d0`
- `template-options.ts` `1deadb93cc73f096046fc1759f667594e31503c4935a19da2d70affe626fefb3`
- `product-form.ts` `cc3e29ae66264dd1a7b8d20a3ced086e5b7a97a155aa9649c3c229ddff47cabb`

### The plan's seven (run against the FINAL tests; messages identical to the plan's)

| #   | Mutant (the brief's fragment)                                                   | Command filter                 | Failed test(s)                                                                                                                               | Key line                                                                                                                                                                                                                               |
| --- | ------------------------------------------------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `form-errors.ts`: drop the `staleFields` line                                   | `-t "stale"`                   | form-errors «reads a refusal of a field the form names as out of date…»; dialog «reads a refused template preference… as a stale change» (2) | `expected { kind: 'alert', …(1) } to deeply equal { kind: 'stale' }`; `Unable to find an element with the text: Данные изменились, пока вы их редактировали…`                                                                          |
| 2   | `ProductDialog.tsx`: no `PRODUCT_STALE_FIELDS` argument                         | `-t "stale change"`            | dialog «…as a stale change» (1)                                                                                                              | `Unable to find an element with the text: Данные изменились…`                                                                                                                                                                          |
| 3   | `ProductDialog.tsx`: `kept` = `[]`                                              | `-t "preference"`              | «keeps a preference that no longer fits…», «names a preference the template list does not have», «keeps the template choices off while…» (3) | `expected [ 'Не выбран', 'Коробка 58×40', …(1) ] to deeply equal [ …(2) ]`; `expected [ 'Не выбран', 'Паллета 100×150' ] to deeply equal [ Array(3) ]`; `expected [ 'Не выбран' ] to deeply equal [ 'Не выбран', 'Шаблон a3b4c5d6…' ]` |
| 4   | `ProductDialog.tsx`: drop `disabled={!templates.isSuccess}`                     | `-t "do not load"`             | «keeps the template choices off while…» (1)                                                                                                  | `expected <select …> to have property "disabled" with value true`                                                                                                                                                                      |
| 5   | `product-queries.ts`: `staleTime: Infinity`                                     | `-t "stale change"`            | «…as a stale change» (1)                                                                                                                     | `expected "vi.fn()" to be called 2 times, but got 1 times`                                                                                                                                                                             |
| 6   | `template-options.ts`: filter without categories                                | `-t "fit the product's group"` | «offers in each slot the templates that fit…» (1)                                                                                            | `expected [ 'Не выбран', 'Вода 58×40', …(2) ] to deeply equal [ 'Не выбран', 'Коробка 58×40' ]`                                                                                                                                        |
| 7   | `ProductDialog.tsx`: `product?.chzProductGroupCode` instead of the form's group | `-t "group changes"`           | «keeps a chosen template as a marked choice when the group changes…» (1)                                                                     | `expected [ 'Не выбран', 'Коробка 58×40', …(1) ] to deeply equal [ 'Не выбран', 'Вода 58×40', …(2) ]`                                                                                                                                  |

(All seven were also run once against the plan-verbatim tests: same results.)

### My own fifteen (both test files, no filter)

The plan's seven replace whole expressions, so finer mutants of the same new code were run. Seven survived the plan's tests (X3, X6, X7, X8, X10, X11 are real holes; X15 is equivalent). I strengthened tests (below) and re-ran all six: all killed.

| #   | One-line mutant                                                                       | Against plan's tests                               | Against final tests (failing test, key line)                                                                                                          |
| --- | ------------------------------------------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| X1  | `form-errors.ts`: `if (path !== null) return { kind: "stale" };` (any field is stale) | killed (6 failed)                                  | killed: «puts a validation failure under the form field…» etc.: `expected { kind: 'stale' } to deeply equal { kind: 'field', field: 'gln', … }`       |
| X2  | `form-errors.ts`: default `staleFields = ["defaultBoxTemplateId"]`                    | killed                                             | killed: «reads a refusal of a field…»: `expected { kind: 'stale' } to deeply equal { kind: 'alert', …(1) }`                                           |
| X3  | `product-form.ts`: `PRODUCT_STALE_FIELDS` without `defaultPalletTemplateId`           | **survived** (33 passed)                           | killed: «…as a stale change»: `Unable to find an element with the text: Данные изменились…` (pallet refusal added to that test)                       |
| X4  | `PRODUCT_STALE_FIELDS` without `defaultBoxTemplateId`                                 | killed                                             | killed: same test, same line                                                                                                                          |
| X5  | `template-options.ts`: drop `.sort(…)`                                                | killed (2)                                         | killed: `expected [ 'Не выбран', 'Молоко 58×40', …(1) ] to deeply equal [ 'Не выбран', 'Коробка 58×40', …(1) ]`                                       |
| X6  | `new Intl.Collator("ru")` (no `numeric`)                                              | **survived**                                       | killed: «offers in each slot…»: `expected [ Array(3) ] to deeply equal [ 'Не выбран', 'Паллета 80×120', …(1) ]`                                       |
| X7  | `ProductDialog.tsx`: `kept` = `[field.value]` (drops the product's own preference)    | **survived**                                       | killed: «keeps a preference that no longer fits…»: `expected [ 'Не выбран', 'Коробка 58×40', …(1) ] to deeply equal [ …(2) ]`                         |
| X8  | `kept` = `[product?.[name] ?? ""]` (drops the form's own choice)                      | **survived**                                       | killed: «offers in each slot…»: `expected [ 'Не выбран', 'Вода 58×40', …(1) ] to deeply equal [ …(2) ]`                                               |
| X9  | `disabled={templates.isError}` (enabled while loading)                                | killed (2, indirectly: `openEdit` no longer waits) | killed (3), now also directly: «keeps the template choices off while…»: `expected <select …> to have property "disabled" with value true` (slow tail) |
| X10 | loading hint text replaced by the «не загрузился» text                                | **survived**                                       | killed: «keeps the template choices off while…»: `Unable to find an element with the text: Загружаем шаблоны…`                                        |
| X11 | loaded hint replaced by the loading text                                              | **survived**                                       | killed: «offers in each slot…»: `Unable to find an element with the text: Необязательно: станция возьмёт этот шаблон первым…`                         |
| X12 | pallet slot asks purpose `"box"`                                                      | killed                                             | killed: `expected [ 'Не выбран', 'Коробка 58×40' ] to deeply equal [ 'Не выбран', 'Паллета 100×150' ]`                                                |
| X13 | drop the `options.some(…)` duplicate guard                                            | killed (4)                                         | killed (4)                                                                                                                                            |
| X14 | `id.slice(0, 7)`                                                                      | killed (2)                                         | killed (2)                                                                                                                                            |
| X15 | drop `id === ""` from the skip in `templateOptions`                                   | survives                                           | **equivalent mutant**: the «Не выбран» option always has value `""`, so `options.some((o) => o.value === "")` already skips it; not killable          |

## Strengthening of the plan's tests (all inside existing tests, counts unchanged)

Diff against the plan-verbatim file is only these four places in `test/product-dialog.test.tsx` (I kept a copy of the plan-verbatim file at `/tmp/claude/t6/product-dialog.plan-verbatim.tsx` and diffed it):

- «offers in each slot…» (kills X6, X8, X11): that test lists one more pallet template, «Паллета 80×120», so the order «80 before 100» fixes `numeric`; it asserts the loaded hint appears under both selects; and, in create mode (no own preference), it picks «Молоко 58×40», changes the group to 13, expects «Молоко 58×40 — не подходит» with value kept, then returns the group to 8. One plan assertion changed accordingly: `["Не выбран", "Паллета 100×150"]` → `["Не выбран", "Паллета 80×120", "Паллета 100×150"]`.
- «keeps a preference that no longer fits…» (kills X7): after the plan's asserts it chooses another template and expects the same option list (the old preference stays offered), then chooses the old one again.
- «keeps the template choices off while the templates do not load…» (kills X10): a slow tail like the group select's: while `listTemplates` never answers, both selects are off, «Загружаем шаблоны…» shows under both, and the failure text is absent.
- «reads a refused template preference… as a stale change…» (kills X3): after the plan's last assertion, a refusal on `defaultPalletTemplateId` is refused and read the same way.

## Documents (Step 6) and reconciliation

The five edits were applied verbatim. Then I re-read whole: `AGENTS.md` «Catalog and label templates», «Reference sync», «Local database», «Protocol», «Office pages» (plus «Change feed» around line 328 and «Verification» because they carry `1e2`/commands), and spec §4.3 (the product/template schema text), §4.4, §4.5, §5.3, §5.4, §5.5, §6. Checked against the code:

- «Zod schemas for every catalog shape are there»: every fixture plan 1e1 added (`git log --diff-filter=A` on `proto/fixtures`) except `template-eligibility.json` is named in `test/protocol.test.ts`; that one is read by `test/template-eligibility.test.ts` — the new AGENTS paragraph is true. Nothing anywhere still says the 1e1 fixtures are Rust-only (grep «host-only|only Rust|Rust types» finds nothing after the edit), except the wizard's `templates`, which is plan 1e3's and said so (AGENTS «Protocol», spec §4.5/§6).
- «The slot rule is read by both sides»: AGENTS lines ~489-495 and spec §4.5 (`host/tests/templates.rs` and `test/template-eligibility.test.ts` both read the fixture) — true.
- «A refusal on a deleted template leads to «Загрузить заново»»: AGENTS «Catalog» paragraph, «Office pages» (`writeFailure` bullet and «Товары» bullet), spec §5.5 — true; the host's names `defaultBoxTemplateId` / `defaultPalletTemplateId` are the ones in `host/src/routes/products.rs` (`check_references`, create and update paths), and `HostError.field` is non-null only for `validation_failed`, so the new check cannot misread another code.
- `ENTITY_SET`/`SYNC_SCHEMA_VERSION` (`…;v4`), the 3E+6 / 30-of-32 figure, `notQuarantinedNewer` on operators, badges, products, templates and defaults: match `src/local/reference-sync.ts`.
- `grep -n "1e2"` on both documents: 3 + 7 lines (spec line 877 is the plan table's row 1e, which names 1e2 as a plan), each about finished work (AGENTS 328, 541, 657; spec 302, 382, 404, 622, 726, 827, 877), none about the future.

No sentence needed a correction beyond the plan's five edits.

## Step 7 checks

- `node_modules/.bin/prettier --check` on the 11 changed files: clean. `git diff --check` and `git diff --cached --check`: clean. `grep -rnF '\u04' apps/standalone/src apps/standalone/test` → only `src/host/pairing-code.ts:66`; `grep -nF '\u0' apps/standalone/src/i18n/ru.json` → nothing.
- `typecheck` exit 0, `lint` exit 0, no warnings (run with no stand files present).
- Full suite 40 files / 958 tests, exit 0, no failure, no `act(`/unhandled output.
- `git diff --stat 9d3363a81 HEAD` over `apps/station packages apps/standalone/{host,proto,src-tauri} package.json pnpm-lock.yaml .superpowers docs/superpowers/plans`: empty.
- Not run, by design: `build`, `cargo *`, the plan's «Итоговая проверка плана» (controller's); `graphify update .` (this worktree has no `graphify-out`). No browser, Windows or hardware check applies to this task; the dialog was exercised only in Vitest/jsdom, not in a live browser.

## Files changed (11)

`apps/standalone/src/office/products/template-options.ts` (new), `ProductDialog.tsx`, `product-form.ts`, `product-queries.ts`, `apps/standalone/src/office/office-query.ts`, `form-errors.ts`, `apps/standalone/src/i18n/ru.json`, `apps/standalone/test/product-dialog.test.tsx`, `form-errors.test.ts`, `apps/standalone/AGENTS.md`, `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`.

## Self-review

- Code, texts and documents are the plan's, verbatim; the only additions are test assertions (above). Task 5's lines (including its local `palletTemplate`) are untouched, as instructed.
- Rules followed: no `cd`, no `git stash`, no `pnpm install`, one commit via `-F`, explicit `git add` paths, no new dependency, nothing outside the brief's files, helper scripts and logs only under `/tmp/claude/t6`; the stand files were created and deleted twice and are not in the tree.
- Hygiene: no new test asserts effect-driven state right after `findBy*`; the stand and six repeated runs agree.

## Concerns (notes, none blocks)

1. **Plan tests were strengthened** (four places, counts unchanged), because six one-line mutants of the new code passed the plan's tests (X3, X6, X7, X8, X10, X11; table above). The controller should expect the product-dialog test file to differ from the plan text there. The plan's seven mutants still fail on the plan's exact messages.
2. **Documentation gap (an omission, not an error).** The plan's AGENTS/spec text does not say that an id the template list lacks is shown by its first eight characters («Шаблон a3b4c5d6… — нет в списке», or without the suffix while the list has not loaded). I kept the plan's text verbatim; a clause in AGENTS «Office pages» («Товары») would close it if wanted.
3. **Re-open behaviour worth knowing.** The cached list counts as loaded on a re-open: the selects are enabled while the background read runs, so a template deleted since the previous open can still be offered until the answer arrives; saving it is then refused and read as stale (D9). If that re-read fails, the selects go off («не загрузился») but keep the options of the old list. Not covered by a test (it follows from the plan's design; flagging it so a reviewer is not surprised).
4. `PALLET` (module level, from the plan) equals Task 5's local `palletTemplate`; left for the controller's queued tidy-up.
5. The `id === ""` skip in `templateOptions` is redundant (X15, equivalent); left as the plan has it.

Evidence logs (not in the repo): `/tmp/claude/t6/` (`red.log`, `green*.log`, `verbose*.out/err`, `delay*.out/err`, `mut-*.log`, `xmut-*.log`, `full.log`, `commit-msg.txt`).
