# plan О-Ф, Task 8 report — pallets in the shift planning form

Status: DONE (one equivalent mutant, one measured-vs-plan count difference, see Concerns).
Worktree `/tmp/claude/wt/chz`, branch `claude/office-chz`, base `dbaacb885`. One commit: `7ab1c89cd`
`feat(standalone): the office plans and changes a shift with pallets — capacity from the product, template by decision 7`
(one `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` line; `git status --short` empty afterwards).

## What was done

All 14 test fragments (Step 1) and all 30 implementation fragments (Step 3) of the brief were applied by a script that
checks "exactly once" per fragment, tests first. Every fragment matched exactly once: **no anchor adaptations**.

- `requests.ts`: `ShiftPallets`, `ShiftInput.pallets`, `ShiftChange.pallets`; `shiftCreate` names every field explicitly
  (`palletsEnabled:false` alone for a shift without pallets, so the body is byte-identical to the former one; with pallets
  `palletsEnabled/palletBoxCapacity/palletTemplateId`); `shiftUpdate` reads the three pallet fields of the shift and sends
  `palletsEnabled:false` alone when switching off (the host clears the fields; sending them is `validation_failed`), and
  only the pallet fields that changed otherwise. No spread anywhere.
- `box-template-choice.ts`: `suggestPalletTemplate` (+ `PalletTemplateProduct`, `PalletTemplateDefaults`), sharing
  `firstFitting`/`categoryDefault` with `suggestBoxTemplate`.
- `rules.ts`: `shiftPalletBoxCapacityRule` (1–10 000, `MAX_PALLET_BOX_CAPACITY`).
- `shift-form.ts`: three new fields, `superRefine` (capacity and template required only with pallets; capacity message
  `rules.shiftPalletBoxCapacity`), `toShiftInput` pallets, field order for focus (`palletsEnabled`, `palletBoxCapacity`,
  `palletTemplateId` between the box template and the counterparty, as in the DOM), host refusals `palletTemplateId` →
  under the pallet select, `palletBoxCapacity` → under its field.
- `ShiftDialog.tsx`: "С паллетами" checkbox (disabled for a product without pallet capacity unless already on, so a
  shift's own pallets can always be turned off; disabled while submitting and while templates are not loaded), capacity
  from the product, template by the rule, recomputed on a new product, product without pallet capacity switches pallets
  off, refusal of `palletTemplateId` re-reads the templates, errors cleared when values are re-taken.
- `shift-list.ts`: `OpenBlocker` + `pallet_template_unfit` (purpose, switch and product group; box template named first).
- `ru.json`: the new texts only.

What an ACTIVE shift may change: the host refuses any pallet change (`fixed_changed` → `shift_status`); the office edits
an active shift only in `ShiftPlanDialog` (`plannedQty` alone), so `ShiftDialog` (planned shifts only) needs no active
branch. Host rules mirrored, none loosened: pallets need a template (required in the form), capacity 1–10 000 (the form
always sends it; the host would default it — tighter, deliberate: the brief says both are required and explicit),
template eligibility by `templateFitsSlot` through `templateOptions`/`suggestPalletTemplate` (purpose `pallet`, enabled,
group scope); the dialog always sends `mode: "aggregation"`, which pallets require.

## RED / GREEN

RED (tests only, `vitest run` of the six files, `--testTimeout=60000`): `Tests 14 failed | 417 passed (431)`
(plan: `14 failed | 331 passed (345)`; same 14: `suggestPalletTemplate is not a function` ×2, protocol ×2, shift-form ×4,
shift-list ×1, shift-dialog ×4, shift-edit ×1). Output: `/tmp/claude/impl-pof-t8/out/red.txt`.

GREEN after the implementation: `Tests 431 passed (431)` (6 files; plan 345 — the base has more tests than the plan's
scratch copy). After my extra tests, seven files incl. `shifts-page`: `475 passed (475)`, `--reporter=verbose` stderr 0
bytes. Under the delayed-`setImmediate` stand (3 ms; proved live by a scratch test that observed `timeout0` before
`immediate`, deleted): `shift-dialog`+`shift-edit`+`shifts-page` 135 passed. Gates: `typecheck` 0, `lint` 0, `build` 0,
prettier gate on all 14 files clean (proved live: a mis-formatted scratch file made it print `[warn]`, deleted),
`git diff --check` clean, `grep -rnF '\u04'` only `pairing-code.ts:66`. Rust untouched, so no cargo run.
Whole package `vitest run`: `105 files, 3217 tests`: 104 files pass, 3215 pass, **2 fail** — both in
`template-editor.test.tsx` (5 s timeouts at load ~130, a file this task does not touch); alone with
`--testTimeout=60000`: 97/97 pass.

## Tests beyond the brief (the brief's tests let mutants survive or had no test)

- `protocol`: a shift without pallets keeps the exact key list and `JSON.stringify` of `shift-create.json`; the with-pallets
  body equals `shift-create-pallets.json`; both builders' bodies parse through `shiftCreateSchema`/`shiftUpdateSchema`
  unchanged; an edit of the plan alone names no pallet field, with or without pallets.
- `box-template-choice`: a pallet preference/default scoped to another group is skipped.
- `shift-list`: a pallet template is judged by purpose, switch and group, after the box template; unknown template or no
  pallets claim nothing; an active shift claims nothing.
- `shifts-page`: the list shows «Не откроется: шаблон паллеты…» for the shift with an off pallet template and nothing for
  a fitting one.
- `shift-dialog`: new product re-takes capacity/template (and a product without pallets switches them off); refusals are
  cleared by re-choosing the pallets and by a new product; pallet select offers only templates fitting the group;
  every pallet control is held while the write is on its way.
- `shift-edit`: a shift with pallets can turn them off though its product lost its pallet capacity (and cannot turn them
  back on); only the changed capacity is sent and a host refusal of `palletBoxCapacity` lands under its field; a plan-only
  edit names no pallet field; the pallet select is off with a hint when templates do not load.

## Deliberately changed 2a3 tests (from the brief)

`protocol.test.ts` "a shift to plan, one moved to another line…" (builders now get `pallets: null`), the second
`shiftCreate` input and the `office-shift` shift fields (`palletsEnabled/palletBoxCapacity/palletTemplateId`);
`shift-form.test.ts` "loads a planned shift's own values…" and "turns the form's text into the host's numbers and nulls,
trimmed" (new fields, `pallets`); `shift-list.test.ts` "claims nothing for a shift that is not planned…" (+ pallet
cases). No other existing assertion was touched.

## Mutants (script `/tmp/claude/impl-pof-t8/mutants.py`; each applied exactly once, run, restored by copy; sha256 before/after equal and `cmp` silent for every row; final `cmp` of all six source files against the saved copies: identical)

| id  | mutant (one line)                                           | killed by                                                                                                                                                                                             |
| --- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | `shiftUpdate` switch-off without `&& shift.palletsEnabled`  | protocol "turns a shift's pallets on…"                                                                                                                                                                |
| F2  | template required `=== ""` → `=== "-"`                      | shift-form requires…, shift-dialog refuses pallets… (3 tests)                                                                                                                                         |
| F3  | drop "product without pallet capacity switches pallets off" | shift-dialog "offers no pallets…"                                                                                                                                                                     |
| F4  | category default read for purpose `box`                     | box-template-choice "takes the product's pallet preference…"                                                                                                                                          |
| F5  | `pallet_template_unfit` never returned                      | shift-list "claims nothing…" (2)                                                                                                                                                                      |
| G1  | pallets-null create body also names `palletBoxCapacity`     | protocol "a shift planned with no plan…", my byte-identical test (3)                                                                                                                                  |
| G2  | `palletsEnabled:true` always sent                           | protocol "turns a shift's pallets on…"                                                                                                                                                                |
| G3  | pallet capacity always sent on edit                         | same                                                                                                                                                                                                  |
| G4  | pallet template always sent on edit                         | same                                                                                                                                                                                                  |
| G5  | pallet capacity bound = `MAX_BOX_CAPACITY`                  | shift-form "requires the pallets' capacity…"                                                                                                                                                          |
| G6  | `superRefine` runs without pallets                          | same                                                                                                                                                                                                  |
| G7  | capacity issue never added                                  | same                                                                                                                                                                                                  |
| G8  | `toShiftInput` pallets always on                            | shift-form "loads…", "turns the form's text…" (2)                                                                                                                                                     |
| G9  | refused pallet template mapped to the box message           | shift-form "puts a refused pallet template…"                                                                                                                                                          |
| G10 | refused pallet capacity mapped to `boxCapacity`             | same                                                                                                                                                                                                  |
| G11 | `shiftFields` palletsEnabled always false                   | shift-form "loads a planned shift's own values…"                                                                                                                                                      |
| G12 | `openBlocker` pallet purpose → `box`                        | shift-list (2)                                                                                                                                                                                        |
| G13 | `openBlocker` pallet group → `null`                         | shift-list "judges a pallet template…" (mine)                                                                                                                                                         |
| G14 | `firstFitting` ignores the group                            | box-template-choice (2)                                                                                                                                                                               |
| G15 | organization pallet default dropped                         | box-template-choice "never takes a box template…" (3)                                                                                                                                                 |
| G16 | new product does not re-take pallets                        | shift-dialog "does not keep a refusal…" (mine, 2)                                                                                                                                                     |
| G17 | `palletsPossible` ignores the product's capacity            | shift-dialog "offers no pallets…"                                                                                                                                                                     |
| G18 | checkbox off even when on, if product lacks capacity        | shift-edit "lets a shift with pallets turn them off…" (mine)                                                                                                                                          |
| G19 | no `clearErrors` when pallets are switched off              | **SURVIVED — equivalent**: the fields unmount, the resolver re-validates on submit, and switching on again runs `palletsFrom` (G20 covers that clear); no observable difference. Kept as in the brief |
| G20 | `palletsFrom` does not clear errors                         | shift-dialog "does not keep a refusal…" (mine)                                                                                                                                                        |
| G21 | refused `palletTemplateId` does not re-read templates       | shift-dialog "puts a pallet template the host refused…"                                                                                                                                               |
| G22 | pallet select lists box templates                           | shift-dialog "offers only the pallet templates that fit…" (mine, 3)                                                                                                                                   |
| G23 | pallet select ignores the product's group                   | same (mine)                                                                                                                                                                                           |
| G24 | capacity input not held while saving                        | shift-dialog "holds the pallet controls too…" (mine)                                                                                                                                                  |
| G25 | pallet select not held while saving                         | same                                                                                                                                                                                                  |
| G26 | checkbox not held while saving                              | same                                                                                                                                                                                                  |
| G27 | capacity taken from the product's box capacity              | shift-dialog "does not keep a refusal…" (4)                                                                                                                                                           |
| G28 | focus order: template before capacity                       | shift-dialog "refuses pallets without a capacity or a template…"                                                                                                                                      |
| G29 | create names `palletTemplateId: ""`                         | protocol fixtures test (2)                                                                                                                                                                            |
| G31 | pallet select enabled when templates did not load           | shift-edit "leaves the pallet template off…" (mine)                                                                                                                                                   |

Mutants G1/G13/G16–G18/G20/G22–G27/G31 were killed only because of the tests I added; G31 first survived and was killed
after adding the templates-do-not-load test. Logs: `/tmp/claude/impl-pof-t8/out/mut-*.log`.

## Self-review

- Request builders name every field; no spread; protocol-2-compatible body for a shift without pallets pinned by key list
  and JSON text; fixtures parsed both ways (existing fixture/schema test plus builder-to-schema round trips).
- Russian texts only via `ru.json`; checkbox is a labelled `role=checkbox` with a hint; refusals use `aria-describedby`;
  focus goes to the first refused field in DOM order; all pallet controls are held while saving.
- Not exercised: browser/visual check of the dialog, the host (cargo not run: no Rust touched), a real station entering a
  pallet shift (`pallet_template_not_fit`), Windows.

## Concerns

1. Counts differ from the plan only because the base has more tests: plan 345 → measured 431 for the six files (+44 of
   mine → 475 with `shifts-page`); plan whole-package 2581 → measured 3217 (base).
2. Two `template-editor` tests time out at 5 s in the whole-package run under load ~130 (untouched file; 97/97 alone).
3. G19 is an equivalent mutant (documented above).
4. Active-shift behaviour was derived from the host code (`fixed_changed`) and the dialog split (`ShiftPlanDialog`), not
   from a new test of the host refusal; the office never offers pallet changes for an active shift.
5. `graphify update .` could not rebuild in the sandbox (`Operation not permitted`); graph not refreshed.
