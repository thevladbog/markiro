# Plan 1d4 — delta re-review of fix round 2 (`34babfeed..4c57fd483`)

**Verdict: NEEDS FIXES** — Critical 0, Important 1, Minor 4.

Commits `4d428de50` (1/2) and `4c57fd483` (2/2). I-2, M-1…M-5 of the wave review are closed. I-1 is closed for the
case it named, with Caps Lock off, but the controller's case-sensitive decision rests on a premise that is false for 14
of the 95 printable characters. That includes `,` and `.`, and the round's own separator example «123,45678» with
Caps Lock on escapes the guard. My round-1 fix suggestion had the same gap.

Constraints honoured: no Rust file touched, no cargo run (the controller's workspace gate was running). The only file
mutated was `AddBadgeDialog.tsx`, restored byte-identically each time. Scratch tests were deleted, and the tree is
clean at the end.

## Findings

### Important

**W-I1. Caps Lock on, the same for both scans: a code holding `,` `.` `;` `'` `[` `]` `` ` `` (or their shifted
`<` `>` `:` `"` `{` `}` `~`) still reaches the host in the label.** `apps/standalone/src/office/operators/AddBadgeDialog.tsx:109-112`.

- **Mechanism.** Under ЙЦУКЕН those seven keys are letters (б ю ж э х ъ ё), so Caps Lock capitalizes them: the
  unshifted «,» key types «Б». `fromRussianLayout` maps «Б» back to the shifted «<». The US layout with Caps Lock
  types «,», because Caps Lock leaves punctuation alone. So the two forms stop matching although nothing changed
  between the two scans.
- **Table check** (the pairing-code tables replicated): with Caps Lock off, every printable ASCII character maps
  back exactly. With Caps Lock on, 14 do not: `" ' , . : ; < > [ ] ` { } ~`.
- **Probes** (scratch copy of `operator-badges.test.tsx` plus five tests; run, then deleted):
  - P1: label «ПРОПУСК 7» (Caps Lock), «123Б45678» into the label, then into the code field (layout hint), then
    «123,45678». `createBadge` is called with `label: "ПРОПУСК 7123Б45678"`; mapped, that is «GHJGECR 7123<45678».
  - P1b: a mixed code «ьклБ742» / «mrk,742» is sent.
  - P1c: a letter code «ькл-000742» / «mrk-000742» is refused, so the premise holds for letters only.
- **Why it is realistic.** A label typed in capitals leaves Caps Lock on through the scans, and separator codes are
  the round's own example (EM-Marine readers commonly type «123,45678»). The codebase already treats a Caps Lock
  scan under the Russian layout as real: `parsePairingPayload` retries with `withCyrillicCaseSwapped`
  (`src/host/pairing-code.ts:96-109`).
- **Docs.** `apps/standalone/AGENTS.md:785-787` says only a case or layout change «between the two scans» defeats
  the guard, and `:780-781` calls `fromRussianLayout` «the mapping the pairing scans use». The pairing also uses the
  case-swapped reading.
- **Fix:**
  - Also read the label with its Cyrillic case swapped before mapping, as `parsePairingPayload` does: export
    `withCyrillicCaseSwapped`, or add a helper that returns both readings.
  - Compare case-insensitively. A label holding the code in another case still gives it away. The swapped reading
    alone closes the digits-and-separator case; case-insensitivity also covers the mixed one.
  - Add Caps Lock rows to the `it.each` (P1 and P1b), with the mutant «drop the swapped reading».
  - Correct the two AGENTS sentences.

### Minor

**W-M1. The first clause is not pinned.** Dropping `values.label.includes(values.code)` (mutant C) passes all 25
tests. Yet that clause is what catches a separator code that lands verbatim, under the US layout, because the mapping
turns «,» into «?». My scratch test (label «Pass 7», «123,45678» into the label, then into the code field) passes on
HEAD and fails under mutant C (`Unable to find … В подписи есть код бейджа …`). _Fix:_ add a verbatim separator row,
for example an `it.each` over «MRK-000742» and «123,45678» in the existing guard test
(`test/operator-badges.test.tsx`, «refuses a label that holds the scanned code…»), with the mutant «drop the first
clause».

**W-M2. A scan into the code field after a guard refusal is glued to the kept code, and the label goes out.**
`AddBadgeDialog.tsx:113-114` keeps the code. Scenario:

- A person ignores the message under the label, clicks back into the masked code field and scans again.
- The code becomes «MRK-000742MRK-000742», and the guard no longer finds that string in «Пропуск №7MRK-000742».
- The label goes out with a hash no station matches (probe P2: `createBadge` called with that label and a hash
  that is not `BADGE_PHC`).

This needs a deliberate focus move against the message, so it is Minor. _Fix_ (controller or owner call): either
empty the code on a `labelHasCode` refusal as well (focus stays on the label; the table row becomes «emptied»), or
record it as a residual next to the straddle paragraph.

**W-M3. Spec row 9 still states the unqualified guarantee.** `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md:50`
says «Хост хранит только хеши и никогда не видит PIN и код бейджа». As a statement of what the protocol carries it is
true, and it is fine as a design statement. But `AGENTS.md:286-288` now qualifies the identical claim, so a spec reader
gets the stronger version. _Fix:_ the same pointer in the spec, e.g. «(код может попасть только в подпись бейджа по
ошибке; офис это ловит — см. `apps/standalone/AGENTS.md`)».

**W-M4 (nit). M-1's paragraph ties the salt boundary to the first opening.** `AGENTS.md:737` says «on the first
opening of the dialog». The same bullet (`:724`) says the salt is read again once the cache has dropped it (about five
minutes), so any opening that reads the salt has that boundary. _Fix:_ «on an opening that reads the salt (the first,
or one after the cache dropped it)».

## Item by item

### 1. I-1 (commit 1)

- **Guard.** `values.label.includes(values.code) || fromRussianLayout(values.label).includes(values.code)`
  (`AddBadgeDialog.tsx:109-112`). It sits after the validation and the salt check and before `hashBadge`, with the
  same `setError(…, { shouldFocus: true })`. The import follows the file's style. The comment says why the second
  clause exists.
- **New test.** The `it.each` (`test/operator-badges.test.tsx:447`), rows «MRK-000742»/«ЬКЛ-000742» and
  «123,45678»/«123б45678», walks every step of the scenario:
  - the first scan into the label is refused for the empty code, focus moves to the code field, the label holds
    «Пропуск №7» plus the Cyrillic form, and no request is sent;
  - the Cyrillic scan into the code field gets the layout hint, and the field is emptied and focused;
  - the Latin code is refused by the guard: message under the label (`aria-describedby`), focus on the label, code
    kept, no `deriveBits`, no `createBadge`.
- **Mutants I ran** (target `AddBadgeDialog.tsx`, sha256 `f77882cfc3e6e29b70ccbfcbea79f53fe1fa87307f6f15037345781d54ad6297`
  before = after for every run, byte comparison identical, `git status` clean after each batch):

| Mutant                                                                                            | Result                                                                                                          |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| A: second clause dropped                                                                          | exit 1, both new rows fail: `Unable to find an element with the text: В подписи есть код бейджа — уберите его…` |
| B: `values.label.includes(fromRussianLayout(values.code))` (the code mapped instead of the label) | exit 1, both rows fail, same message                                                                            |
| C: first clause dropped                                                                           | **exit 0, 25/25: survives** (W-M1); fails my scratch US-layout separator test                                   |
| D: `shouldFocusError: false` in `useForm` (M-2)                                                   | exit 1: «keeps the masked code when the form refuses only the label…» `expected <input …> to be <input …>`      |

- **Controller's case-sensitivity decision.** The premise holds for letters, digits and the layout-invariant symbols.
  It is false for the 14 characters on the seven ЙЦУКЕН-only letter keys (**W-I1**).
- **Other paths I checked and do not report:**
  - The table recovers all 95 printable ASCII characters with Caps Lock off, Shift and punctuation keys included.
  - Digits, `-`, `=`, space and `\` are layout-invariant.
  - Scanner prefixes (AIM `]C1`) come out the same in both scans.
  - A label deliberately edited to keep part of the code is beyond any substring guard.
  - A second, different card scanned into the label while a first card's code is kept needs two cards in hand.
  - The glue path is reported as **W-M2**.

### 2. Documents of commit 1

- The table row «The label has the code or its Russian-layout form (`labelHasCode`)» matches the code.
- The prose: «as typed and as the Russian layout types it», the two examples, «both are plain substring tests», and
  «the second test widens [the false positives] only by the mapped text» all match the code. «The guard catches the
  accidental forms only… Caps Lock toggled in between» overstates (**W-I1**).
- «Operators and badges» (`:286-288`): «the one field a code could reach is a badge's label, and the add dialog
  guards it as described» is accurate, since it points at the limits stated under «Бейджи».
- Spec row 9's host sentence: fine as a design statement, but inconsistent with AGENTS now (**W-M3**).

### 3. I-2 (commit 2)

- `git show -w` plus a padding-normalised comparison of the 20 changed table lines: beyond whitespace and the
  separator row's dashes, exactly two lines changed, row 9 and the VACUUM line (§5.2).
- New row 9: the PIN «кодом станции, как прежде», the badge «по правилам входа плана 1f из
  `apps/standalone/AGENTS.md`» (trimmed scan hashed once with the site's salt, whole-string compare, an ambiguous badge
  refused, a Cyrillic scan refused with the hint), «см. §5.6». Consistent with `AGENTS.md:329-339` and with §5.6. The
  rationale cell still cites `auth.ts` for the format only. Closed.

### 4. M-1…M-5 (commit 2) and M-2 (commit 1)

- **M-1** (`AGENTS.md:734-742`): the mechanism is true. The field is read-only while the salt is missing or
  `isSubmitting`; `scanAgain` empties and focuses the field inside the callback; `readOnly` drops at the render after
  `isSubmitting: false`. A straddling scan loses its head and its tail passes `badgeCodeRule`. The disabled default
  button blocks an Enter before the salt arrives, not after. One nit on «first opening» (**W-M4**).
- **M-2:** the assertion is at `:361-363`, and mutant D fails it.
- **M-3:** the `local_db.rs` doc comment is qualified and cites «"Local database" in `apps/standalone/AGENTS.md`»;
  the heading exists (`AGENTS.md:107`). Spec §5.2 now states the claim plainly. The Rust change is comment-only; I did
  not compile it (cargo was off-limits), and the fixer reports `cargo check` and `fmt` clean.
- **M-4** (`AGENTS.md:763-766`): «until the next submit the form accepts» matches `setFailure(null)` at the start of
  the valid branch, before the guard (`AddBadgeDialog.tsx:94`).
- **M-5** (`host/tests/badges.rs:191-192`): «the one badge refusal» is accurate. `revoke_badge` has no refusal after
  its `next_revision` (`operators.rs:433`), and `create_badge`'s conflict is the only one.

### 5. Scope and process

- Files per commit match the brief: 3 in commit 1 (`AddBadgeDialog.tsx`, the test, `AGENTS.md`), 4 in commit 2
  (`AGENTS.md`, the spec, `local_db.rs`, `badges.rs`).
- Subjects are byte-identical to the brief (checked by script). Each message has exactly one
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`, as its last line.
- Nothing under `apps/station`, `proto`, `packages/`, migrations, manifests, the lockfile, `.superpowers` or
  `docs/superpowers/plans`.
- `git diff --check 34babfeed..HEAD` is clean. `prettier --check` is clean on the changed TS/TSX/MD files. The `\u04`
  grep finds only `pairing-code.ts:66`.
- `test/operator-badges.test.tsx`: 25/25, stderr empty (my run). I did not rerun the full suite; the fixer reports
  37/810.

## Not verified

- Cargo, any Rust build or test: excluded by the controller for this round.
- WebView2 and a real wedge scanner under the Russian layout with Caps Lock: my probes simulate the typed text in
  jsdom, based on the Caps Lock behaviour `pairing-code.ts` documents and relies on.
- Windows, NVDA.
