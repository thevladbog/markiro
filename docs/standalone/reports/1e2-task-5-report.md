# Plan 1e2, Task 5 — report: product dialog (add, change, archive, GTIN hints)

Status: **DONE_WITH_CONCERNS** (no blocker; the concerns are a deliberate, reported deviation in the test file and one ambiguous sentence in the plan's doc text, see «Concerns»).

Commit: `9d3363a81` — `feat(standalone): диалог товара — добавление, правка, архив, подсказки о GTIN` (base `a00d132ff`). The message ends with exactly one `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` line (verified with `git log -1 --format=%B`). `git status --short` is empty after the commit; no scratch file is left (the delayed-`setImmediate` stand files, a stand probe, a scratch copy of the plan's verbatim test and the mutation runner were all removed or kept under `/tmp/claude/t5`, outside the tree).

## 1. What changed (behaviour)

- `ProductDialog` (new): one `FormDialog` for adding and changing a product, built on the counterparties pattern. A change sends the WHOLE record with the opened record's `expectedRev`; archiving is the «В архиве» box (edit only); there is no delete. Fields: GTIN, name, print name, product group (optional select), box capacity, boxes per pallet, shelf life. The GTIN goes out as `toGtin14`. The default template ids go out exactly as they came with the product (their selects are Task 6).
- Hints: for a valid GTIN the dialog shows «Сохранится как …» when the 14 digits differ from what was typed, and whose prefix it has (organization, else the first counterparty — active first, by name — else nobody); both disappear when the organization or the counterparties do not load, and never block a save. The «остаётся черновиком» line shows while there is no group or one capacity is missing.
- Group select: by name; the product's own group stays a choice («Код 99 — нет в справочнике» when the lookup lacks it, «Код 8» when the lookup did not load), and with an unloaded lookup the select is off with a hint and the group goes out unchanged.
- Host refusals via `writeFailure`: `validation_failed` on a product field under that field, `conflict` `gtin14` under the GTIN, `stale_revision` → «Загрузить заново».
- `ProductsPage`: «Добавить товар» and «Изменить» (`aria-label` «Изменить товар «…»») gated by `useCan("editCatalog")`; the saved record replaces its row in place (`useStoreRecord`), a new one is appended; the notice names the added product.
- `product-form.ts` (new): `productFieldsSchema`, `PRODUCT_FIELDS`, `PRODUCT_CONFLICTS`, `productFields`, `toProductInput`, `staysDraft`, `GtinOwner`, `gtinOwner`.
- `shell.css`, `ru.json`, `apps/standalone/AGENTS.md` («Office pages», two edits) and the spec §5.5 — applied from the brief verbatim.
- The host, `proto`, the shell, migrations, manifests, the lockfile and the plan are untouched.

All plan fragments applied verbatim: the six `ProductsPage.tsx` fragments, the CSS and `ru.json` fragments each matched exactly once (an `Edit` fails otherwise), and so did the two `AGENTS.md` and the spec fragments; the nine mutation fragments matched exactly once each when run.

## 2. Counts: as the plan states them / as measured

| Check                                                | Plan says                      | Measured                           | Why                                                                        |
| ---------------------------------------------------- | ------------------------------ | ---------------------------------- | -------------------------------------------------------------------------- |
| `product-dialog.test.tsx` + `products-page.test.tsx` | 29 (16 and 13)                 | **36 (16 and 20)**                 | Task 4's implementer added 7 tests to `products-page.test.tsx` (20 now)    |
| Whole Vitest suite                                   | 40 files, 930 tests (914 + 16) | **40 files, 951 tests (935 + 16)** | +21 from Tasks 2–4; baseline measured before editing: 39 files / 935 tests |
| `product-dialog.test.tsx` alone                      | 16                             | **16**                             | kept: every strengthening below is inside an existing test                 |

For Task 6: its Step 4 «33 тестов (11 и 22)» is unaffected by the +21 shift: `form-errors.test.ts` has 10 tests today (11 after Task 6) and `product-dialog.test.tsx` has 16 (22 after Task 6).

## 3. Deviation from the plan's text: the test file

The plan's test file was written first, verbatim (hash `8b1108060e530fe4531c977837d9adef3895bc9caef082d21d157167aa179b84`), and it gave the plan's RED and GREEN. The evidence rules require a mutant for every new guard, and a surviving mutant is a finding that must be fixed by strengthening the test. 27 of my 55 own mutants (not counting the two documented survivors) passed the plan's tests, so I strengthened. The rules I kept: the test count stays 16; only assertions were added inside existing test bodies (plus `cleanup` in the first import line); no module-level name was added (Task 6 adds `PALLET`, `BOX_58`, `TEMPLATES`, `summary`, `choices` at module level); and I parsed every «фрагмент … заменить на» of Task 6 out of the plan and checked on the committed tree that each of its 21 anchors still matches exactly once (in my files: `product-dialog.test.tsx` ×3, `ProductDialog.tsx` ×5, `product-form.ts` ×1, `ru.json` ×2; the rest are `AGENTS.md` ×4, the spec ×1 and the untouched `form-errors`, `office-query` and `product-queries` files).

What was added, by test (each line says which survivor it pins):

1. «adds a product…»: dialog named «Новый товар» (title swap); «Добавить» enabled in a pristine form (create gated by `isDirty`).
2. «checks the fields like the host…»: each of the six messages is tied to its own field by `aria-describedby` (swap of the two capacity rules in the schema).
3. «shows the 14 digits…»: the note sits in an `aria-live="polite"` region; spaces around 14 digits show no note (comparison without `trim`).
4. «leaves the owner out…»: a second phase with the counterparties failing and the organization alone able to answer (the plan's test only failed the organization), after two scheduler passes so the absence check is not vacuous.
5. «…stays a draft»: each of the three conditions brings the line back on its own, and spaces count as no capacity (`.trim()` of both capacities).
6. «saves a change as the whole record…»: the product carries a pallet template (a local `palletTemplate`, and the expected body now has it instead of `null`) so a builder that drops it is caught; the dialog is named «Товар «…»»; the page notice goes when another dialog opens.
7. «puts the host's refusal of a field under that field»: a loop over the other six host fields, one refusal after the other, each checked under its own field through `aria-describedby` (only `shelfLifeDays` was pinned).
8. «sends one request for a double click…»: the one request body is the draft with every blank field `null`.
9. «offers the groups by name…»: no «группы не загрузился» hint while the lookup is fine; «Отмена» closes; a product whose group the lookup has gets exactly the lookup's options, not a second copy (the list override now includes `AYRAN`).
10. «keeps the product's group when the lookup does not load…»: option labels are `["Без группы", "Код 8"]` (no claim about the lookup), and a second phase with a lookup that is still on its way: the select is off but no failure is claimed.

If the controller prefers the plan's verbatim test, those additions can be dropped without touching the source, but then 27 guards are unpinned (list in §5).

## 4. Evidence (automated)

Commands run from the repository root; every pnpm call used `--config.verifyDepsBeforeRun=false --filter @markiro/standalone`.

- **Baseline** (`test`): 39 files, 935 tests passed.
- **RED** (Step 2, `exec vitest run test/product-dialog.test.tsx`): 0 tests, exit 1, `Error: Failed to resolve import "../src/office/products/product-form.js" from "test/product-dialog.test.tsx". Does the file exist?` — as the brief expects.
- **GREEN** (Step 4, both files): 2 files, 36 tests passed (16 + 20) on the plan's version of the test and on the final one. No existing test in `products-page.test.tsx` failed because of the new buttons (so no NEEDS_CONTEXT).
- **`--reporter=verbose`**: 36 ✓, stderr 0 bytes (final file). Under the stand with verbose: 36 ✓, stderr 0 bytes.
- **Delayed-`setImmediate` stand** (the two temporary files from the constraints, created and deleted each time): both files 36 passed, stderr 0 bytes. Proof that the stand is live: a scratch probe test (since deleted) fails on the plain config (`['immediate','timeout']`) and passes under the stand (`['timeout','immediate']`).
- **Flake hunt on the final file**: `product-dialog.test.tsx` 6 times plain (16/16 each) and both files 5 times under the stand (36/36 each).
- **Whole suite** (`test`): 40 files, 951 tests passed — before the commit and again on the committed state. (The 13 bytes of stderr are pnpm's `$ vitest run` banner.)
- `prettier --check` on the eight files, run through `rtk proxy` (the wrapper has misreported it before): clean. `git diff --check` and `git diff --cached --check`: clean.
- `grep -rnF '\u04' apps/standalone/src apps/standalone/test`: only `src/host/pairing-code.ts:66`. `grep -nF '\u0' apps/standalone/src/i18n/ru.json`: nothing; `ru.json` parses.
- `typecheck`: exit 0. `lint`: exit 0 (run with the stand files absent). `build` (vite): exit 0; its only message is the chunk-size advisory (`index` 775 kB, `PairingDataMatrix` 926 kB), which I did not compare with the pre-change bundle.

## 5. Mutants

Method: a scratch runner outside the tree (`/tmp/claude/t5/run_mutants.py`) keeps a byte copy of the file, checks the fragment matches exactly once, writes the one-line mutant, runs Vitest, restores the bytes in a `finally`, then proves the restore with a byte comparison and sha256. 66 of 66 mutants report `restored=True`. At the end the four files were also compared with `cmp` against copies taken before the final pass and their sha256 matched:

```
0017ac97ab765674c0b97b3d5df763f87fac559b86d7b6cf4f6c571a78d35169  ProductDialog.tsx
aea6058fcb0024f7260303baebab70a2ecb4aea07f304287447f717a7443433f  product-form.ts
2adb1018adda1bad9726a1413475d411d7bed751cb05fe907d712bf6fb733a93  ProductsPage.tsx
29f2f1ecf6a6b08d21b653f5b1365a5f85552a1af49b5ca1fb19c741919ac9d8  product-dialog.test.tsx (final)
```

### 5.1 The brief's nine, with the brief's commands (all killed; messages match the brief)

| #   | Mutant (one line)                                                                      | Test(s) that failed                                                                      | Key line                                                                                                            |
| --- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 1   | `useCan("editCatalog")` → `useCan("editReference")`                                    | lets both office roles add and change products                                           | `Unable to find role="button" and name "Изменить товар «Молоко 3,2% 0,9 л»"`                                        |
| 2   | `toGtin14(values.gtin14)` → `values.gtin14.trim()`                                     | adds a product…                                                                          | `expected [ Array(1) ] to strictly equal [ Array(1) ]` (`- "04600682000013"`, `+ "4600682000013"`)                  |
| 3   | `activeFirstByName(counterparties).find` → `counterparties.find`                       | finds a GTIN's owner the cloud's way…                                                    | `expected { kind: 'counterparty', …(1) } to deeply equal …` (`- "Альфа-2"`, `+ "ООО «Северный берег»"`)             |
| 4   | `writeFailure(error, PRODUCT_FIELDS, PRODUCT_CONFLICTS)` → without `PRODUCT_CONFLICTS` | puts a taken GTIN under the GTIN…                                                        | `Unable to find an element with the text: Этот GTIN уже у товара в работе`                                          |
| 5   | own group no longer kept (`if (false && …)`)                                           | offers the groups by name…; keeps the product's group when the lookup does not load… (2) | `expected [ 'Без группы', …(2) ] to deeply equal [ 'Без группы', …(3) ]`; `to have property "value" with value '8'` |
| 6   | drop `disabled={!groups.isSuccess}`                                                    | keeps the product's group when the lookup does not load…                                 | `to have property "disabled" with value true`                                                                       |
| 7   | drop the `.sort(...)` by name                                                          | offers the groups by name…                                                               | `expected [ 'Без группы', …(3) ] to deeply equal [ 'Без группы', …(3) ]`                                            |
| 8   | draft hint without the pallet capacity                                                 | says a product without a group or both capacities stays a draft                          | `Unable to find an element with the text: Без группы и вместимостей товар остаётся черновиком.`                     |
| 9   | `productUpdate(input, false, product.rev)`                                             | saves a change as the whole record…                                                      | `expected [ [ 'office-session-token', …(2) ] ] to strictly equal …`                                                 |

### 5.2 My own mutants (57: 55 killed, 2 documented survivors)

«Plan's test» is the verbatim file, «final» the committed one. Every mutant below that survived the plan's test is killed in the final run, by the tests named.

| Id        | Mutant                                                                                              | Plan's test                         | Final: killed by (key line)                                                                                                              |
| --------- | --------------------------------------------------------------------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| E1        | org check in `gtinOwner` dropped                                                                    | killed                              | cloud's-way unit test (`to deeply equal { kind: 'own' }`); whose-prefix test                                                             |
| E2        | `unknown` answered as `own`                                                                         | killed                              | same two                                                                                                                                 |
| E3        | blank print name sent as `""`                                                                       | killed                              | adds a product; double-click draft body                                                                                                  |
| E4        | blank group → `Number("")` (0)                                                                      | **survived**                        | double-click draft body (`toStrictEqual`)                                                                                                |
| E5a/b/c   | blank box / pallet / shelf life → `Number("")`                                                      | **survived** (3)                    | double-click draft body                                                                                                                  |
| E6a/b     | template `""` sent instead of `null` (box / pallet)                                                 | killed                              | adds a product; double-click draft body                                                                                                  |
| E7a       | box template not carried on edit                                                                    | killed                              | whole-record test                                                                                                                        |
| E7b       | pallet template not carried on edit                                                                 | **survived**                        | whole-record test (pallet template added to the fixture)                                                                                 |
| E8a / E8b | draft hint without the group / box term                                                             | **survived**                        | stays-a-draft test (`Unable to find … черновиком`)                                                                                       |
| T1 / T2   | draft hint: `.trim()` of box / pallet dropped                                                       | **survived**                        | stays-a-draft test (spaces are no capacity)                                                                                              |
| E9a       | failed organization read as no prefixes                                                             | killed                              | leaves-the-owner-out (`expected <p class="office-note"> to be null`)                                                                     |
| E9b       | failed counterparties read as none                                                                  | **survived**                        | leaves-the-owner-out, counterparties phase                                                                                               |
| E10       | «Сохранится как» compared with the untrimmed text                                                   | **survived**                        | shows-the-14-digits (padded 14 digits show no note)                                                                                      |
| E11       | note shown for every valid GTIN                                                                     | killed                              | shows-the-14-digits                                                                                                                      |
| E12       | `aria-live="polite"` removed                                                                        | **survived**                        | shows-the-14-digits (`expected undefined to be 'polite'`)                                                                                |
| E13       | create button gated by `isDirty`                                                                    | **survived**                        | adds a product (`to have property "disabled" with value false`)                                                                          |
| E14       | archive box shown on create                                                                         | killed                              | adds a product                                                                                                                           |
| E15a      | group hint always shown                                                                             | **survived**                        | offers-the-groups; keeps-the-group (`expected <span> to be null`)                                                                        |
| E15b      | group hint shown while the lookup loads                                                             | **survived**                        | keeps-the-group, loading phase                                                                                                           |
| E16       | kept group labelled «нет в справочнике» when the lookup failed                                      | **survived**                        | keeps-the-group (`expected [ 'Без группы', …(1) ] to deeply equal [ 'Без группы', 'Код 8' ]`)                                            |
| E17       | own group pushed even when the lookup has it                                                        | **survived**                        | offers-the-groups, second phase                                                                                                          |
| E18       | `onReload` not given to the alert                                                                   | killed                              | stale-change test (`Unable to find role="button" and name "Загрузить заново"`)                                                           |
| E19       | reload does not refetch the list                                                                    | killed                              | stale-change test (`called 2 times, but got 1 times`)                                                                                    |
| E20       | reload does not close the dialog                                                                    | killed                              | stale-change test                                                                                                                        |
| E21       | saved record not stored                                                                             | killed                              | adds a product; whole-record                                                                                                             |
| E22       | notice text swapped                                                                                 | killed                              | 5 tests                                                                                                                                  |
| E23       | opening a dialog does not clear the notice                                                          | **survived**                        | whole-record test, last step                                                                                                             |
| E24       | edit button without its `aria-label`                                                                | killed                              | 6 tests                                                                                                                                  |
| E25       | dialog titles swapped                                                                               | **survived**                        | adds a product; whole-record (`Unable to find … role "dialog" and name …`)                                                               |
| E26       | the two capacity rules swapped in the schema                                                        | **survived**                        | checks-the-fields (`expected 'mk-input-…-error' to be 'mk-input-…-error'`)                                                               |
| E27       | `expectedRev` + 1                                                                                   | killed                              | whole-record                                                                                                                             |
| E28 ×7    | one entry dropped from `PRODUCT_FIELDS` (gtin14, name, printName, group, box, pallet, shelf life)   | six **survived**, shelf life killed | host-refusal loop (each under its own field)                                                                                             |
| E29       | saved record does not close the dialog                                                              | killed                              | adds a product                                                                                                                           |
| E30       | `onClose` does nothing                                                                              | **survived**                        | offers-the-groups («Отмена»)                                                                                                             |
| E31       | `PRODUCT_CONFLICTS.gtin14.field` = `"name"`                                                         | killed                              | taken-GTIN test                                                                                                                          |
| F1–F8     | each `productFields` field (gtin, name, print name, group, box, pallet, shelf life, archived) blank | killed (8)                          | whole-record, taken-GTIN, keeps-the-group tests                                                                                          |
| F9        | `numberText(null)` → `"0"`                                                                          | killed                              | 4 tests                                                                                                                                  |
| X1        | `name: values.name.trim()` → `values.name`                                                          | survives (kept)                     | equivalent: the schema output is already trimmed (the add test types « Молоко 2,5% 1 л » and passes either way)                          |
| X2        | `Intl.Collator("ru", { numeric: true })` → `("ru")` in the group list                               | survives (kept)                     | inert: none of the 51 names in host migration `0008_catalog.sql` contains a digit; the same flag in `activeFirstByName` has its own test |

Unreachable by design (no mutant run): the `canEdit` false branch of the page and its dialog render, since no role lacks `editCatalog` (D10).

## 6. Files

- `/Users/thevladbog/PRSOME/q/.claude/worktrees/ecstatic-swirles-7f0ae8/apps/standalone/src/office/products/ProductDialog.tsx` (new)
- `/Users/thevladbog/PRSOME/q/.claude/worktrees/ecstatic-swirles-7f0ae8/apps/standalone/src/office/products/product-form.ts` (new)
- `/Users/thevladbog/PRSOME/q/.claude/worktrees/ecstatic-swirles-7f0ae8/apps/standalone/src/office/products/ProductsPage.tsx`
- `/Users/thevladbog/PRSOME/q/.claude/worktrees/ecstatic-swirles-7f0ae8/apps/standalone/src/app/shell.css`
- `/Users/thevladbog/PRSOME/q/.claude/worktrees/ecstatic-swirles-7f0ae8/apps/standalone/src/i18n/ru.json`
- `/Users/thevladbog/PRSOME/q/.claude/worktrees/ecstatic-swirles-7f0ae8/apps/standalone/test/product-dialog.test.tsx` (new)
- `/Users/thevladbog/PRSOME/q/.claude/worktrees/ecstatic-swirles-7f0ae8/apps/standalone/AGENTS.md`
- `/Users/thevladbog/PRSOME/q/.claude/worktrees/ecstatic-swirles-7f0ae8/docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`

## 7. Self-review

- Source files are the plan's code byte for byte (their hashes did not change from the first write to the end); only the test file differs from the plan, as described in §3.
- The doc re-read the plan asks for was done: «Office pages» (whole section) and §5.5 (whole section) agree with what the dialog does; nothing else in `AGENTS.md` or the spec still calls products read-only. The two `AGENTS.md` anchors that Task 6 expects from this task's text (`…badge`, `gtin14`…) and `lookup lacks it; while the lookup does not load it is off…`) match once.
- The dialog opens two extra reads at every opening (organization, counterparties; `staleTime` 0), as the plan intends. I did not exercise load against a slow host.
- Orientation: this worktree has no graph, so I used the parent graph only to confirm `gtinMatchesPrefix` (`packages/domain/src/gs1/gtin.ts`) and the cloud's `checkGtinOwner`; I did not run `graphify update` (no local graph).

## 8. Concerns

1. **Test file deviates from the plan's text** (additive assertions in 10 of the 16 tests, one extra import name, same count of 16). Reason: 27 guards were unpinned by the plan's tests (§5.2). It is easy to revert if the controller wants the plan's text exactly; Task 6's anchors were verified against the committed version.
2. **Doc wording to settle in Task 6's reconciliation**: the plan's `AGENTS.md` sentence «A product without a group or both capacities gets a note that it stays a draft» can be read as «lacks the group, or lacks both capacities». The dialog shows the note when the group OR EITHER capacity is missing (the brief's own text and test say so). I applied the plan's sentence verbatim and did not rephrase it.
3. **Not exercised** (automated jsdom tests against a mocked `HostApi` only): a real browser or the Tauri webview (layout of `.product-gtin`, focus, keyboard, screen-reader announcement of the live region), the real host over IPC, Windows and any hardware. The Rust workspace and migrations are untouched, so no cargo run was needed or made.
4. The two surviving mutants (X1, X2) are equivalent or inert, as explained in §5.2.
