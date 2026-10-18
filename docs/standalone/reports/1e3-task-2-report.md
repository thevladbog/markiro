# Plan 1e3, Task 2 — implementer's report

Implementer: Sonnet 5.5 subagent. Base `4f66edaf9`, commit `4a5d30b9b` refactor(standalone): общие модули каталога, тексты шаблонов и слияние ответа в сводку. Trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` exactly once (`git log -1 --format=%B | grep -c Co-Authored-By` = 1); `git status --short` empty after the commit; no stand or scratch file in the tree (my mutation harness lives in `/tmp/claude/t2-mut/`, outside it).

**Status: DONE.** Vitest 43 files / 982 tests (baseline 40 / 964 measured; plan 43 / 977; **+5 extra tests of mine**, see «Extra tests»). typecheck, lint, prettier, `git diff --check` clean. All 10 plan mutants killed with the messages the brief names; 73 mutants of my own, 11 of which the plan's tests did not kill: 10 now killed by the 5 extra tests, 1 equivalent. No cargo (plan changes no Rust), no build (no shell or dist change), no browser (no UI in this task).

## What was done

Plan applied in order. Step 1: three test files created verbatim. Step 3.1: `git mv` of `products/product-queries.ts` to `office/catalog-queries.ts` and `products/template-options.ts` to `office/template-options.ts`; git records both as renames in the commit (68 % and 52 % similarity; checked with `git diff --cached --stat -M` and `--summary`). 3.2–3.3: new contents (`useProductGroups`/`useTemplates`; `templateOptions` over any `TemplatePurpose`, texts from `office.templateChoice.*`). 3.4–3.7: the imports of `ProductsPage.tsx` and `ProductDialog.tsx`. 3.8–3.9: `office/templates/template-text.ts` and `template-list.ts`. 3.10–3.11: `ru.json` loses `office.products.{noTemplate,templateUnfit,templateId,templateMissing}` and gains `office.templates` and `office.templateChoice` with the same words. Step 6: no document changes (confirmed: `git grep` finds the old paths and keys only in the two historical plan files; `apps/standalone/AGENTS.md`, the spec and `docs/architecture.md` do not name them).

Anchors: each of the 6 non-mutation fragments (4 imports, 2 `ru.json`) matched exactly once (the Edit tool refuses otherwise); each of the 10 plan mutation fragments matched exactly once (my `apply.py` aborts on any other count; it never did).

## Evidence

- Baseline: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test` — 40 files / 964 passed, exit 0.
- RED (`exec vitest run test/template-text.test.ts test/template-list.test.ts test/template-options.test.ts`): `Test Files 3 failed (3), Tests no tests`, exit 1; `Failed to resolve import "../src/office/templates/template-text.js"`, `"../src/office/templates/template-list.js"` and `"../src/office/template-options.js"`, exactly as the brief predicts.
- GREEN (the three files plus `test/products-page.test.tsx test/product-dialog.test.tsx`, product tests untouched): 5 files / 55 passed (13 new + 20 + 22), exit 0. After my extras: 5 files / 60.
- `--reporter=verbose` on the three new files: 13 passed at first, 18 passed with the extras, stderr 0 bytes (stdout and stderr captured to separate files).
- Delayed-`setImmediate` stand (the two temporary files exactly as the constraints give them): new files 13 passed, then 18 passed after the extras, stderr 0 bytes; the two product suites under the stand: 42 passed, stderr 0. Stand files deleted after each run (`ls` confirms).
- Final gates on the committed tree: `typecheck` exit 0 (its `include` covers `src` and `test`), `lint` exit 0, full `test` 43 files / 982 passed (stderr is only pnpm's `$ vitest run` banner, 13 bytes, checked with `od -c`), `prettier --check` on the 10 paths clean (checked through `rtk proxy`, and against a deliberately mis-formatted file to prove the checker fails when it should), `git diff --check` and `git diff --cached --check` clean, `grep -rnF '\u04' apps/standalone/src apps/standalone/test` finds only `src/host/pairing-code.ts:66`, `grep -nF '\u0'` on `ru.json` finds nothing.

## Plan mutants (restore proof for every run: `cmp` silent, sha256 before == after, final hashes of the five source files equal the pre-mutation ones)

| #   | Mutant (file)                                               | Covering test             | Key failing line                                                                                            |
| --- | ----------------------------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 1   | `\|\|` to `&&` in `sizeText` (`template-text.ts`)           | "a size in millimetres"   | `expected '0 × 40 мм' to be '—'`                                                                            |
| 2   | `dpi === null ?` to `!dpi ?`                                | "resolution in dpi"       | `expected '—' to be '0 dpi'`                                                                                |
| 3   | `codes.length === 1` to `=== 0`                             | "describe the categories" | `expected { label: 'Категорий: 1', …(1) } to strictly equal { label: 'Упакованная вода', …(1) }`            |
| 4   | `organizationDefault === true` to `Boolean(...)`            | "names the defaults"      | `expected { organization: true, categories: [] } to strictly equal { organization: false, categories: [] }` |
| 5   | delete `error.code !== "conflict" \|\|`                     | "names the defaults"      | `expected { organization: false, categories: [] } to be null`                                               |
| 6   | delete `rev: template.rev,` (`template-list.ts`)            | "merges"                  | `expected [ { …(11) }, { …(11) }, { …(11) } ] to strictly equal [ … ]`                                      |
| 7   | add `...template,` after `...summary,`                      | "merges"                  | `expected [ { …(11) }, { …(12) }, { …(11) } ] to strictly equal [ … ]`                                      |
| 8   | drop the id tie-break                                       | "sorts by name"           | `expected [ …(4) ] to strictly equal [ …(4) ]`                                                              |
| 9   | duplicate slot offers box templates (`template-options.ts`) | both option tests         | `expected [ …(2) ] to strictly equal [ …(3) ]`; `expected [ …(5) ] to strictly equal [ …(5) ]`              |
| 10  | swap the duplicate and pallet tones                         | "tone them"               | `expected { box: 'violet', …(2) } to strictly equal { box: 'violet', …(2) }`                                |

## Own mutants: 73 (harness `/tmp/claude/t2-mut/battery.py`; one-line mutants, every file restored in a `finally` and hash-checked)

Series, all killed by the plan's tests unless listed under «Survivors»: `e01`–`e31` in `template-text.ts` (purposes order; box tone; `"ru"` to `"en"` so «58.5»; `maximumFractionDigits` 0/1/3; swapped sides; «—» replaced by `""` in `sizeText` and `dpiText`; `dpi + 1`; `groupName` find negated and fallback code; `title: ""`; both `join(",")`; count off by one; scope and conflict names ignoring the lookup; dropped `instanceof`; dropped constraint check; the three code refinements; always-true org and category branches; `join("")`; dropped hint; failure kind; negated ternary; zero-is-missing); `l01`–`l11` in `template-list.ts` (in-place sort, `numeric: false`, reversed tie-break, negated id match, each of the four merged fields dropped, merge of `purpose`, match on every summary, `rev + 1`); `o01`–`o13` in `template-options.ts` (no sort, `numeric: false`, no filter, group ignored, none value, value is name, kept id checks, `slice(0, 7)`, swapped id/missing keys, negated branches, sort before filter); `j01`–`j12` (one-character edits of every new `ru.json` text) and `j13`–`j15` (the same edits of the moved `templateChoice` words, covered by the UNCHANGED `product-dialog.test.tsx`); `c01`–`c03` (the 1e2 plan's mutants 3, 5 and 6 replayed on the new paths: dropping `staleTime: Infinity` from `useProductGroups` fails `products-page` «reads the product groups once» with `expected "vi.fn()" to be called 1 times, but got 2 times`; adding it to `useTemplates` fails `product-dialog` «stale change» with `to be called 2 times, but got 1 times`; the old filter fails «fit the product's group»), which shows the product pages and dialog really use the moved modules.

### Survivors of the plan's tests (11) and what kills them now

| Mutant                                                                                                    | Extra test that kills it                                                                                         | Key failing line                                                                                   |
| --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `e04` `maximumFractionDigits: 1`                                                                          | template-text «round a millimetre to two decimals…»                                                              | `expected '58,3 × 40,1 мм' to be '58,25 × 40,1 мм'`                                                |
| `e05` `maximumFractionDigits: 3`                                                                          | same                                                                                                             | `expected '58,254 × 40,1 мм' to be '58,25 × 40,1 мм'`                                              |
| `e31` `!template.widthMm \|\| !template.heightMm` (a zero side is «—»; the plan pins zero only for dpi)   | same                                                                                                             | `expected '—' to be '0 × 40 мм'`                                                                   |
| `e17` drop `!(error instanceof HostError) \|\|` (only a duck-typed object or `undefined` shows it)        | «takes only a HostError for a default conflict…»                                                                 | `expected { organization: false, categories: [] } to be null`                                      |
| `e19` drop `.int()`                                                                                       | «reads the category codes the way the host writes them…»                                                         | `expected { organization: false, …(1) } to strictly equal { organization: false, categories: [] }` |
| `e20` drop `.nonnegative()`                                                                               | same                                                                                                             | same                                                                                               |
| `e21` `.nonnegative()` to `.positive()`                                                                   | same                                                                                                             | `expected { organization: false, categories: [] } to strictly equal { organization: false, …(1) }` |
| `l09` merge also takes `purpose` from the answer (the plan's merge test uses the same purpose both sides) | template-list «never takes the purpose from the answer…»                                                         | `expected [ { …(11) } ] to strictly equal [ { …(11) } ]`                                           |
| `o02` `{ numeric: false }` in `template-options.ts` (10 < 58 both ways in the plan's names)               | template-options «put the numbers of a name by value…»                                                           | `expected [ 'Не выбран', …(2) ] to strictly equal [ 'Не выбран', 'Дубликат 58×40', …(1) ]`         |
| `o13` sort before filter, i.e. the cached list sorted in place                                            | same (a frozen list)                                                                                             | `TypeError: Cannot assign to read only property '0' of object '[object Array]'`                    |
| `o07` drop `id === ""`                                                                                    | none: EQUIVALENT (the first option always has value `""`, so `options.some(...)` already skips an empty kept id) | survives by construction                                                                           |

`e31` and `o13` were added after the extras existed, so I confirmed they survive the plan's tests alone by excluding the extras by name with `-t` (`p-e31`: 8 plan tests pass under the mutant; `p-o13`: 2 pass).

## Extra tests (count shift: 977 planned, 982 measured; passed on, not edited in the plan)

Five `it` blocks, each placed beside the plan's test so the plan's tests stay verbatim: `template-text.test.ts` +3 (round to two decimals and a zero side is a size; only a `HostError` is a default conflict; category codes are whole numbers from zero up, else none named), `template-list.test.ts` +1 (the purpose is never taken from the answer), `template-options.test.ts` +1 (numbers by value and the given list left alone). New tests in all: 18 (template-text 11, template-list 4, template-options 3). Later tasks' «Expected» totals in the plan will read 5 lower than measured.

## Files changed (10; `git show --stat -M HEAD`)

`apps/standalone/src/office/catalog-queries.ts` (renamed from `products/product-queries.ts`), `apps/standalone/src/office/template-options.ts` (renamed from `products/template-options.ts`), `apps/standalone/src/office/templates/template-text.ts` and `template-list.ts` (new), `apps/standalone/src/office/products/ProductsPage.tsx` and `ProductDialog.tsx` (imports only), `apps/standalone/src/i18n/ru.json`, `apps/standalone/test/template-text.test.ts`, `template-list.test.ts`, `template-options.test.ts` (new).

## Facts checked

- Cloud parity (read-only): `PURPOSE_TONE` equals `PURPOSE_TO_TONE` in `apps/admin/src/pages/labels/index.tsx:98` (box violet, duplicate teal, pallet magenta); `describeScope` follows `describeTemplateScope` (`apps/admin/src/pages/labels/scope.ts:11`) branch for branch; `describeDefaultConflict` follows the cloud's, except that the cloud filters unreadable category codes one by one and the plan's `defaultConflict` drops the whole list when any element is unreadable (host sends only ascending integers, so no difference today).
- The host stores no empty category list (`apps/standalone/host/src/validate.rs:459-466`: «None for every category, or a non-empty list»), so `describeScope([])` («Категорий: 0», empty title) cannot occur for real data.
- `src/i18n/index.ts` sets `interpolation: { escapeValue: false }`: group and template names with `/`, `&` or quotes are not HTML-escaped by `t()` (React escapes at render), which matters to Tasks 3–7.
- `CATEGORY_CODES` (`z.number().int().nonnegative()`) mirrors `groupCodeSchema` in `src/host/protocol.ts:76`.
- No local graphify graph in this worktree (no `graphify-out/`), so `graphify update` did not apply.

## Concerns (none blocking)

1. Test totals: +5 over the plan, as above; the controller's later count expectations need the same shift.
2. `id === ""` in `templateOptions` is dead code (equivalent mutant `o07`); plan-verbatim, harmless, left as is.
3. `defaultConflict` is stricter than the cloud's counterpart for a mixed array (see «Facts checked»); that is the plan's decision and its own test (`["8"]`), so no change.
4. Not exercised, by nature of the task: any browser, Windows or host run (pure modules, no screen); the new modules have no consumer until Tasks 3–7.

Self-review: code, tests and `ru.json` match the brief text; the only deviations are the 5 added tests; the moved words are checked twice (new `template-options` test and the unchanged product-dialog tests, mutants `j09`–`j15`).
