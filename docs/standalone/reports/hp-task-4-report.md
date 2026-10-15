# plan hp, Task 4 report — the TSPL import reads back the EAN128 SSCC

Status: DONE_WITH_CONCERNS (concern: pre-existing, unrelated placard-title snapshot failures, see below)
Commit: 4a6856785 `fix(domain): the TSPL import reads back the EAN128 SSCC the domain itself exports` (branch claude/m1, BASE a457f1a35)

## What was done

`packages/domain/src/labels/tspl-import.ts`: `BARCODE …,"EAN128",…` is read as `{kind:"barcode", format:"code128", data:"sscc"}` when the payload is `00` + valid SSCC (`isValidSscc`), `00{{sscc}}` or `{{sscc}}`; any other EAN128 payload is `LABEL_CODE_INVALID`. `128`/`EAN13`/other types go through the old path untouched (unknown types still refused). Code is the brief's verbatim (imports, `ean128Data`, `parseBarcode`).

## Tests (packages/domain/test/labels-import.test.ts)

The brief's two tests plus extras:

- property-style round trip: `generateTspl` of an SSCC code128 element for 45 valid SSCCs (extension 0/3/9 x prefix lengths 7/8/9 x serials 0..99999, via `buildSscc`) is re-imported as `sscc`, no warnings; asserts the writer emits `"EAN128"` and `"00<sscc>"`.
- refusals widened: wrong check digit, 19 digits, AI 01, `0000{{sscc}}`, `{{sscc}}00`, inner space, `{{product.gtin}}` forms, short payload.
- type case-insensitive (`ean128`).
- regression for the old forms: `128` with `{{product.gtin}}`, `{{sscc}}`, a literal; `EAN13` literal and field. Legacy `!1`: the pre-#692 export (`"128"`, `"!100<sscc>"`) still imports as a literal exactly as before (the #700 `allowLegacyBangOnePrefix` lives in `parseScannedSscc`, a scan helper not used by the import, so no import change is made for it; pinned by a test).
- unknown types (`39`,`93`,`EAN8`,`EAN128M`,`UPCA`) still refused.

RED (before the implementation): `/tmp/claude/impl-hp-t4-red.txt` — 3 failed (reads back, round-trips, type case-insensitive) | 26 passed; "refuses…" already passed, as the brief predicted.
GREEN: labels-import 29/29 (verbose, stderr empty).

## Mutants (restore proof: sha256 ef4cd1e8…3158 before and after, `cmp` identical, script /tmp/claude/impl-hp-t4/mut.py)

| Mutant (one line)                                     | Killed by                                               |
| ----------------------------------------------------- | ------------------------------------------------------- |
| M1 drop `isValidSscc` (only `startsWith("00")`)       | refuses an EAN128 that holds no SSCC                    |
| M2 `type === "EAN128"` removed from the format choice | reads back… / round-trips… / type case-insensitive      |
| M3 drop bare `{{sscc}}` alternative                   | reads back…                                             |
| M4 drop `00{{sscc}}` alternative                      | reads back…                                             |
| M5 EAN128 data branch disabled (literal path)         | reads back, round-trips, refuses, case-insensitive      |
| M6 `ean128Data` also applied to type `128`            | keeps reading 128/EAN13; leaves the 128 with literal !1 |
| M7 drop `startsWith("00")`                            | refuses (AI `01` + valid SSCC)                          |
| M8 `fail(...)` replaced by `return "sscc"`            | refuses                                                 |
| M9 drop `.toUpperCase()`                              | type case-insensitive                                   |

## Gates

- domain: typecheck 0, lint 0, build 0 (dist rebuilt with the change). `vitest run`: 1210 passed, 3 failed (88 files, 1 failed). The 3 failures are `test/print-forms-snapshot.test.ts` (pallet placard A4/A5, shift placards A5): rendered `ПАЛЕТА`, fixture `ПАЛЛЕТА`. Pre-existing at BASE and unrelated: print-forms do not import tspl-import; the placard source spelling came with the main merge (2c726efba) while the fixture predates it. The same spelling mismatch fails 3 tests in standalone `test/forms-parity.test.ts`. I did not touch it.
- standalone: typecheck 0; full Vitest `--testTimeout=60000 --hookTimeout=60000`: 4613 passed, 3 failed (149 files) — only the 3 forms-parity placard tests above (same ПАЛЕТА/ПАЛЛЕТА diff).
- admin (consumes the changed module through `import-analysis`): `labels-import-analysis` + `label-samples` 40/40 pass. standalone `domain-internal-errors` / import-analysis tests are in the full run (pass).
- api, station, saas-admin, kiosk: no import of the changed module (grep); public signature unchanged — typecheck not run. platform-contracts / ui unaffected (not touched, no dependency on the module).
- Prettier gate live: scratch file failed the check (exit 1) and was deleted; changed files pass (`labels-import.test.ts` needed `--write`, now clean). `git diff --check` clean. `\u04` grep: only `pairing-code.ts:66`. `git status --short` empty after the commit.

## Anchor adaptations

None; every fragment matched exactly once (line numbers differed, no semantic differences).

## Concerns

1. Pre-existing ПАЛЕТА/ПАЛЛЕТА mismatch (6 failing tests: 3 in domain print-forms-snapshot, 3 in standalone forms-parity) — fixtures/goldens or placard source need a decision outside this task.
2. A legacy `"128"` + `"!100<sscc>"` TSPL file still imports as a literal `!100…` code128 (unchanged by design, pinned by a test); say if it should be recognised as `sscc`.
3. Domain test file's counts: 29 tests in labels-import (brief did not state a plan number).
