# Plan 1d4 — final delta check of fix round 3 (`4c57fd483..ca81752ec`)

**Verdict: APPROVED** — Critical 0, Important 0, Minor 0.

One commit, `ca81752ec`. It closes W-I1 and W-M1…W-M4. No remaining plausible path lets a code reach `label` while the
layout and Caps Lock are in the same state for both scans. The new readings add no realistic false positive on ordinary
labels.

Rules followed: I ran no cargo and touched no Rust file. The only file I mutated was `AddBadgeDialog.tsx`, restored
byte-identically each time. Scratch tests were deleted, and the tree is clean.

## 1. W-I1 — the guard

- **Code.** `withCyrillicCaseSwapped` is exported (`src/host/pairing-code.ts:88`); that one keyword is the file's only
  change. `labelReadings(label)` (`AddBadgeDialog.tsx:39-41`) returns three readings of the label: as typed,
  `fromRussianLayout`, and `fromRussianLayout(withCyrillicCaseSwapped(…))`. The guard (`:129-134`) lowercases the code
  and each reading before comparing. It sits after the validation and the salt check (`:109`) and before `hashBadge`
  (`:138`), with the same `setError("label", …, { shouldFocus: true })`.
- **My probes, now refused.** Each walks label → Cyrillic scan into the label → Cyrillic scan into the code field →
  Latin code. The last step shows the `labelHasCode` message, sends no request and leaves the code field empty.
  - P1: «ПРОПУСК 7», «123Б45678», then «123,45678».
  - P1b: «ьклБ742», then «mrk,742».
  - Shifted symbols, Caps Lock off: «Э№;Б», then `"#$<`.
  - The shifted digit row, Caps Lock on: `"№;:?`, then `@#$^&`.
  - A code with `#`, Caps Lock off: «№123», then «#123».
  - The two `№` probes: `№` is outside the Cyrillic block, so the code field gives the general message instead of the
    layout hint. The guard still refuses the label.
- **The glue path is gone.** Probe P2 (after the refusal, a scan into the code field) is refused again. The field was
  emptied, so the re-scan is the clean code, which the label still holds.
- **Mutants** (sha256 `f447dcdcd3a43fda17bf0c63d97fcef3a6d57cff1db0edb1b08c8431ecf8f702` before = after for every
  run, byte comparison identical, `git status` clean after the batch):

| Mutant                                           | Result                                                                            |
| ------------------------------------------------ | --------------------------------------------------------------------------------- |
| swapped reading dropped                          | exit 1: the two Caps Lock rows fail                                               |
| case-sensitive comparison                        | exit 1: the mixed Caps Lock row fails («mrk,742»)                                 |
| as-typed reading dropped (W-M1)                  | exit 1: the verbatim «123,45678» row fails                                        |
| code kept (`setValue("code", "")` dropped, W-M2) | exit 1: six rows fail, `expected 'MRK-000742' / '123,45678' / 'mrk,742' to be ''` |
| plain mapped reading dropped (extra)             | exit 1: the Caps-off separator row fails                                          |

- **Coverage check.** I simulated all 95 printable ASCII characters under ЙЦУКЕН, with Caps Lock off and on, and with
  scanners that do and do not correct for Caps Lock. In each of the four cases one reading recovers every character:
  the plain mapping with Caps Lock off, the case-swapped one with Caps Lock on. So a code of any printable characters
  is found when the state is the same for both scans. That covers Shift-state symbols, the digit row, `№` → `#`, and
  spaces, which pass through unchanged and are trimmed only at the ends. A scanner prefix or suffix (AIM `]C1`, Enter)
  is typed the same in both scans.
- **False positives.**
  - The readings of ordinary labels are gibberish or digits: «Пропуск №7» → «Ghjgecr #7» / «gHJGECR #7», «Смена 2» →
    «Cvtyf 2», «Карта 1042» → «Rfhnf 1042».
  - Across 200,000 random pairs of ordinary labels and realistic codes (10 digits, «ddd,ddddd», hex with colons,
    «MRK-dddddd», eight characters): 0 false positives.
  - In the UI, five ordinary labels with realistic codes were taken normally, e.g. «Бригада Ж, участок ЮБ» with
    «A.12/7».
  - Only the documented costs remain: a label that repeats the printed number, and a very short code matching by
    coincidence.

## 2. W-M2 — the code is emptied on a `labelHasCode` refusal

- **Code.** `setValue("code", "")` follows the `setError(…, { shouldFocus: true })` (`AddBadgeDialog.tsx:131-132`).
  It uses no `scanAgain`, so the focus stays on the label. The comment above `refused` (`:99-101`) and the guard
  comment match this.
- **Test.** The guard test (`test/operator-badges.test.tsx:411-462`, rows «MRK-000742» and «123,45678») walks the
  whole flow:
  - the refusal empties the code and focuses the label;
  - the label is corrected and the code scanned again;
  - exactly one request is sent, with the label «Пропуск №8»;
  - `deriveBits` is called once, and `verifyPhc(code, sentHash(session, 0))` passes.
- **Docs agree with the code.**
  - `AGENTS.md:762`: table row «emptied / label / under the label».
  - `:767-770`: a label refusal by the form or the host keeps the code.
  - `:771-785`: the guard empties it, keeps the focus on the label, and says why.
  - `:786-809`: the three readings and the limits.
  - Spec §5.5 (`:587-590`) says the same.
  - Searching both files for «keeps the code», «kept», «не стирает» and «labelHasCode» finds only the two legitimate
    label rows. The code comments (`AddBadgeDialog.tsx:100`, `:150`) refer to those rows too.
- **The fixer's open observation** (a deliberate click into the masked code field and a re-scan after the form or the
  host refused the label): an acceptable residual, not a finding. There is no leak, because the label either has no
  code or is refused again. The worst case is a dead badge. It needs a rare label refusal plus a deliberate re-scan
  into a masked field. If the owner prefers one rule, emptying the code on every refusal costs one extra scan after
  such a refusal, two table rows and the two «keeps the masked code when …» tests.

## 3. W-M3, W-M4 and the spec diff

- **W-M3:** row 9 now carries «(код может попасть на хост только в подписи бейджа, по ошибке; диалог добавления это
  перехватывает — см. `apps/standalone/AGENTS.md`)». The new row minus that clause equals the old row byte for byte,
  after whitespace normalisation.
- **W-M4:** `AGENTS.md:737-738` now reads «on an opening that reads the salt (the first, or one after the cache
  dropped it, see above)».
- **Spec diff:** `git show -w` plus a padding-normalised comparison of the changed lines show that, beyond whitespace
  and the separator row's dashes, only row 9 and the three §5.5 lines changed.

## 4. Scope and process

- One commit, five files: `AGENTS.md`, `pairing-code.ts`, `AddBadgeDialog.tsx`, the test, the spec.
- The subject is byte-identical to the brief (checked by script), with exactly one
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` as its last line.
- Nothing under `apps/station`, `proto`, `packages/`, Rust, migrations, manifests, the lockfile, `.superpowers` or
  `docs/superpowers/plans`.
- `git diff --check 4c57fd483..HEAD` is clean. The `\u04` grep finds only `pairing-code.ts:66`.
- `test/operator-badges.test.tsx`: 28/28, stderr empty (my run). The controller's full gates are green: 37/813.

## Residuals to record

1. **Two rows still keep the code.** After the form or the host refuses the label, a deliberate click into the masked
   code field and a re-scan glue the scan to the kept code. The result is a dead badge, not a leak. The alternative is
   to empty the code on every refusal (cost in §2).
2. **Guard limits already listed in `AGENTS.md:806-809`.** A layout or Caps Lock state changed between the two scans,
   any other layout, a label edited after the scan. If an example of «any other layout» helps plan 1f: Ukrainian or
   Kazakh ЙЦУКЕН variants, and «Русская (машинопись)», whose digit row types punctuation without Shift.
3. **`#` gets no layout hint** (already carried): a code containing `#` scanned under the Russian layout gets the
   general code message, not the hint. The guard still catches it in the label.

## Not verified

WebView2, a real wedge scanner under ЙЦУКЕН with Caps Lock (the probes simulate the typed text in jsdom, from the Caps
Lock behaviour `pairing-code.ts` documents), Windows, NVDA. Cargo was not needed: the round changed no Rust file.
