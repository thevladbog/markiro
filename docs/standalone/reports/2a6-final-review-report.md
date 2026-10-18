# Plan 2a6 — final whole-part review (floor scanning, station side)

Worktree `/tmp/claude/wt/2a6`, branch `claude/2a6-scanning`, HEAD `32b25f879`, base `84c056f80` (12 commits, 45 files, +13 238 / −180). Reviewer: final whole-part reviewer (opus). Date 2026-10-10.

## Verdict

**WITH FIXES** — Critical 0, Important 1, Minor 9.

The floor holds together as one machine. Trap analysis passes: the operator always has a way out, and no reachable state loses or doubles a record. The single Important finding is a test file that fails the real Prettier gate (`pnpm format:check` would go red). The Minors are stale comments, a stale plan pin, a duplicated one-line rule that the 2a7 and ПЛ-Ц fragments anchor on, and things to carry forward. A single fixer can do the fix wave in three small commits.

## What I checked, and how

- Read all production sources of the part in the worktree, not only the diff package: `scan-pipeline.ts`, `box-close.ts`, `block-supply.ts`, `work-reads.ts`, `work-queue.ts`, `WorkScreen.tsx`, `outbox-status.ts`, `FloorStatusBar.tsx`, `facts.ts`, `facts-sender.ts`, `protocol.ts`/`api.ts` (diff), `scan-source.ts`, `App.tsx`, `FloorApp.tsx`, `host-link.ts`, `shell.ts` (diff), and the `tests/local_db.rs` and `floor-schema.test.ts` hunks.
- Read the integration host (`/tmp/claude/wt/integ`, 91bfdbbba): `facts/scan.rs`, `facts/box_closed.rs`, `facts/mod.rs`, `routes/sscc_blocks.rs` (diff), `error.rs`, `proto/fixtures/fact-receipt-codes.json`. Read the domain's `classifyScan`/`canonicalizeKm`.
- Scope: `git diff --stat 84c056f80..HEAD` shows no change to the host, `proto`, migrations, `src-tauri/src`, manifests or the lockfile. The only Rust change is a test (`src-tauri/tests/local_db.rs`). `git diff --check` is clean. Each commit has exactly one `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and no other co-author line. `\u04` matches only `src/host/pairing-code.ts:66`. There is no `floor.work.stub`, and no `console.` in `src/floor`, `facts-sender.ts` or `host-link.ts`.
- PRETTIER GATE, run live: `node_modules/.bin/prettier --ignore-path /tmp/claude/wt/2a6/.prettierignore --check <44 changed md/ts/tsx/json/css, repo-relative>` from the worktree root. It printed "Checking formatting…" and **failed on one file** (I-1). `--file-info` shows the md/json/css/tsx files as `ignored:false`. The real failure proves the gate is live.
- Typecheck: 0. Lint: 0.
- Test count, verified with `vitest list` redirected to files: **101 files, 3010 tests**, matching the ledger. That is +12 files and +374 tests over 84c056f80 (89/2636).
- Delayed-`setImmediate` stand (3 ms) on `floor-work-screen`, `floor-status-bar` and `floor-offline-line`: 3 files, 96 passed, stderr 0 bytes. I removed the stand files afterwards.
- Cargo: `cargo test --offline --locked -p markiro-standalone --test local_db the_floors_repeating_reads` passed 1/1 on SQLite 3.46, so the shell's list of 30 plans holds.
- My own mutants: 9 one-line mutants across Tasks 3–8. All were killed (table below). Each file was backed up to `/tmp/claude/rev-2a6-final/mutants/`, then restored with `cmp` silent and the same sha256. `git status --short` is empty. `--ignored` shows only `src-tauri/gen/` and `graphify-out/`, and there are no stray stand, scratch or `.before` files.
- N24 divergence: I ran 9 cases through a scratch Vitest file (deleted afterwards). Table below.
- Query plans and latency on a synthetic database: a node:sqlite 3.53 script, not committed (`/tmp/claude/rev-2a6-final/bench.mjs`). It uses the 0006 schema with two pairings × 200 000 codes, scans and outbox records, 10 000 closed boxes per pairing, and no ANALYZE (the shell forbids it). Numbers below.

## (a) Findings, most severe first

### I-1 (Important). A committed test file fails Prettier, so `pnpm format:check` is red

- Where: `apps/standalone/test/floor-scan-source.test.ts:267`, from Task 2 (`2de9d510d`, which had no separate review).
- The line `expect(scans).toEqual(["010460068200001321MRK-1\u001d93dGVz", "010460068200001321MRK-1\u001d93dGVz"]);` must wrap into a four-line array.
- The Task 2 "prettier clean" claim was vacuous: this is the absolute-path trap recorded in the ledger. It is the same class as the Task 3 review's I2.
- Fix: `node_modules/.bin/prettier --ignore-path <root>/.prettierignore --write apps/standalone/test/floor-scan-source.test.ts`. Then re-run the gate on all 44 files.

### m1 (Minor, N20, final wave). Code comments contradict the documents about the host's over-limit answer, and one test hole remains

- The host sets no `DefaultBodyLimit`. `ApiJson` maps the length rejection to **400 `validation_failed`** (`host/src/error.rs:158-173`). `AGENTS.md` "Floor work" and spec §18 now say so, but three comments still say 413:
  - `src/local/facts-sender.ts:19` («over 2 MiB (413)»);
  - `src/app/shell.ts:53` («a 500, a 413»);
  - `src/floor/facts.ts:65-66` («past which the host answers 413»).
- Test labels:
  - `test/host-link-facts.test.ts:302` names the row «a 413»;
  - `:264` uses `payload_too_large`/413. Keep it, but label it hypothetical, or switch it to 400 `validation_failed`.
- N20 m2: in «reports nothing once the link is gone, though the batch is still on its way» (`host-link-facts.test.ts:484`), add `await waitFor(() => expect(station.unsent()).toBe(0))`. The Task 6 mutant Mk survives without it.
- N20 m6:
  - `facts-sender.ts:116` runs 105 columns; rewrap it.
  - `facts-sender.ts:30-31`: «it can only be refused, never pass over» should say what follows. A single record over the body limit would be refused with 400 on every send and block the queue. That cannot happen, because `outboxStatement` caps a record at 16 KiB.

### m2 (Minor, final wave). Two copies of the full-box rule, and the screen does not call `closeIfFull`

- Where: `WorkScreen.tsx:326` (`if (full && open.itemCount < now.shift.copy.boxCapacity)`) and `box-close.ts:291` (`closeIfFull`: `box.itemCount < context.shift.copy.boxCapacity`).
- The pipeline and box-close tests drive `closeIfFull`. The screen's copy is proved only by the screen tests; my M8 (`<` → `<=` in the screen) failed 32 screen tests.
- Today both copies agree.
- Risk: the 2a7 plan (lines 6620/6636) and the ПЛ-Ц plan (5149/5158) put their steps into `closeBox` by the anchor `const close = () => (full ? closeIfFull(context, steps) : closeOpenBox(context, steps));`. That line does not exist in the executed code, which uses `attemptClose` → `closeSettled` → `closeOpenBox(…, live.current.closeSteps)`. An executor who "restores" `closeIfFull` in one place and not the other, or who changes the rule for pallets in one copy, splits the rule.
- Fix (small): export one predicate from `box-close.ts`, e.g. `boxIsFull(itemCount: number, capacity: number): boolean`. Use it in `closeIfFull` and in `attemptClose`. A one-line mutant of the predicate must then fail both `floor-box-close`/`floor-scan-pipeline` and `floor-work-screen`.
- Record in the deviations that the screen closes through `attemptClose` and that `closeSteps` already reaches every close. 2a7 and ПЛ-Ц pass their steps through the `closeSteps` prop, not through `closeIfFull`.

### m3 (Minor, N18 m1, final wave doc). The `failed` result's doc is false for the dropped cases, and the overlap drop is silent

- `block-supply.ts:29-31` says «`failed` — no answer, or one this station does not keep: a request the host may have answered stays in `floor_block_requests`». That is true only for a missing answer. For another prefix or extension, an inverted range, an overlap and any `validation_failed`, the request is **dropped** (`:252-256`, `:262-271`).
- The `createBlockSupply` doc (`:226-236`) does not mention the overlap drop.
- Fix: reword it, e.g. «`failed` — no answer: the request stays and is repeated whole; or an answer this station does not keep (another prefix or extension, a range that shares serials with a kept block, `validation_failed`): the request is dropped», and add the overlap drop to the module doc.
- Reporting the overlap as an alarm (a host whose counter went back) belongs with the queue screen ОЧ or plan 2b. CARRY.

### m4 (Minor, final wave). A stale plan pin for a statement no code runs

- `test/floor-schema.test.ts:736-741` pins `SELECT coalesce(sum(to_serial + 1 - next_serial), 0) AS n FROM floor_sscc_blocks …` under the comment «the serials the pairing has left». That is the pre-Task-7 text of `remainingSerials`.
- The real statement, `BLOCKS_WITH_ROOM_SQL`, is pinned at `:53-55` and in the parity test, and the shell list has no copy of the old text.
- A reader takes the stale pin for the status bar's read.
- Fix: delete the assertion.

### m5 (Minor, CARRY to 2a8 / owner). The accepted-count read inside every scan's queue job grows with the shift

- `settle` → `refreshQuietly` → `readWorkTotals` (`WorkScreen.tsx:584`, `work-reads.ts:58-62`) runs `SELECT count(*) … FROM floor_codes WHERE host_id = ? AND device_id = ? AND shift_id = ?` in the queue, after every accepted scan.
- It uses an index (`SEARCH … USING COVERING INDEX floor_codes_shift`), but `count(*)` walks every entry of the shift.
- Measured at 200 000 codes in one shift: **22–24 ms median, 50–60 ms max on this loaded machine**. `lastSscc` adds 3 ms (temp B-tree for `serial DESC`) and `closedBoxes` 0.7 ms.
- That caps the in-queue work at roughly 30 scans/s at 200k. It is fine for 3–5/s, but it is linear in the shift's size and sits in front of the next scan.
- The status bar's `UNSENT_COUNT_SQL` is likewise 22 ms with 200 000 unsent records (hours offline), but it runs outside the queue.
- Suggestion for 2a8, whose close summary reads the same count:
  - keep the accepted count incrementally in the screen (the queue owns every box writer);
  - or refresh the totals after the queue job rather than inside it;
  - and measure on the factory PC.

### m6 (Minor, CARRY to 2a8). A stop on an incomplete box offers only «Повторить», though the box has room

- Where: `WorkScreen.tsx:818-861`.
- Scenario: the operator confirms closing a box of 5/12 while offline with no serials. The stop `{ no_serials, full: false }` refuses every scan, and its only button repeats the close. The same holds for `close_failed` with `full: false`.
- Way out: leave the shift and enter again. The entry's `closeBox(true)` leaves a partial box open, so scanning resumes. Not a trap, but the line stops needlessly.
- Fix (2a8's stops): when `!stop.full`, add «Продолжить сборку» (`dismiss(() => setStop(null))`).

### m7 (Minor, N24, doc). `remainingSerials` and the close agree in every reachable state; two unreachable states diverge

- Table from the scratch test (prefix `460068200`, last serial 9 999 999):

  | case                                                                          | bar (`remainingSerials`) | boxes the close labels | serials the close loses (`invalid_serial`)    |
  | ----------------------------------------------------------------------------- | ------------------------ | ---------------------- | --------------------------------------------- |
  | one block 1–20                                                                | 20                       | 20                     | 0                                             |
  | two disjoint blocks (5 + 5)                                                   | 10                       | 10                     | 0                                             |
  | used-up block + half-used block                                               | 6                        | 6                      | 0                                             |
  | blocks of extension 1, another prefix, another pairing                        | 5 (own only)             | 5                      | 0                                             |
  | block straddling the capacity (5 inside, 5 past)                              | 5                        | 5                      | 5                                             |
  | block wholly past the capacity                                                | **0**                    | 0                      | **10** (stop «serial» ×10, then «no serials») |
  | good block 1–3 + block past the capacity                                      | 3                        | 3                      | 3                                             |
  | overlapping blocks (A 1–20 next 11, B 5–30) without boxes on A's used serials | 26                       | 26                     | 10                                            |
  | SSCCs 1–3 held by a former pairing's boxes, block 1–10                        | **10**                   | **7**                  | 3                                             |

- The last case's divergence: the bar counts serials whose SSCC another box already holds. A forget keeps the boxes, and a host reinstalled with a reset counter on the same GLN would re-issue those serials. In the overlap case with real boxes on A's 1–10, the bar says 26 while 20 can be used.
- The host never issues past the capacity (2a1), and `sharesSerials` refuses overlaps since Task 5. Only "host restored or reinstalled with the same GLN" reaches the last row, and that is plan 2b/РК.
- Fix: one sentence in the `remainingSerials` comment («a serial whose SSCC another box already holds — a former pairing's — is counted here and lost by the close»). The 100 threshold and the wording remain the owner's.

### m8 (Minor, CARRY to ОЧ). Offline, every local write fires a send, so the attempts counter counts scans

- `host-link.ts:247-280`: the fact sender has no `online` check. Every `requestFacts` after a scan runs a send that fails on transport and increments `attempts` on up to 100 head records (`attemptStatement`).
- After hours offline, the bar's «попыток отправки: N» (`floor.status.stuck`) counts scans, not retries. Each one is also a local write and an HTTP attempt.
- On a LAN with the host on the same PC this is harmless. It is plan-mandated N22 behaviour, already in AGENTS and §18.
- Suggestion for ОЧ: skip the send while the link's state is not `online` (the watch triggers it on return anyway), or say in words that attempts count sends.

### m9 (Minor, cosmetic, DROP)

- `floor.status.serialsLow` takes `{ n: serialsLeft }`, unformatted and named `n` against the Global Constraints' named variables. It reads the same at ≤ 100.
- `floor-app.test.tsx` keeps a describe title «the work screen of plan 2a5».
- The project has many >100-column comment lines; this is the codebase's style.

### Note (no change, ledger correction)

- The Task 8 review's trap row «office closes the shift → the host rejects them (bar «Отклонено хостом»)» is wrong.
- The host **accepts** every fact of a shift the office closed and marks the shift `late_data_at` once (`host/src/facts/mod.rs:348-356`). Scans and closes made between the office's close and the floor noticing it (one shift read when online, never when offline) are delivered as late data, and nothing is rejected.
- With 2a7, a label printed in that window is for a box the host accepts.
- Record this for 2a7/2a8 (owner: late data after an office close is visible on the shift card).

## Seams

### (1) The floor as one machine

Path: scan source → pipeline → close → supply → delivery → bar → screen and gate.

- **Source.** `mergeScanSources(createKeyboardWedgeSource(), createComScanSource(hardware.onScan))` (`App.tsx:150-156`). Both sources pass the group separator through. The COM source drops frames while text entry is on and drops empty frames. A subscription that answers after `stop` is released.
  - A scan landing between two screens' subscriptions is lost silently (Task 2 concern 1, the cloud's window too). No screen exists then to accept it into.
- **Pipeline.** `readScan` refuses a serial over 64 bytes or with a Cc character. The canonical-text limits (≤ 1024 bytes, no NUL) are already enforced by `canonicalizeKm` (`km.ts:141-164`), so every code the station accepts passes `facts/scan.rs::check`.
  - A badge scan is `unknown` or `gtin`, with no text.
  - Local duplicate before the host. The host check is skipped offline, on failure or on its own device's scan.
  - One transaction holds `floor_boxes`, `floor_codes` (key, `expectedChanges: 1`), `floor_scans` and `outbox`.
- **Close.** Earliest block with room → `buildSscc` → `SSCC_RANGE`/held check → one transaction: CAS cursor, close guarded by `item_count`, `box_closed`, steps. `stale` ×3 → `close_failed`.
  - A lost answer is set as `unsure`, read back first on the next close, and reported once.
- **Supply.** Half rule, a kept request repeated whole, one supply per screen (N17 pinned by tests at `floor-work-screen.test.tsx:1025` and `:1318`), the block filed with its request's removal.
- **Delivery.** One batch at a time, receipts by count and position, one `json_each` transaction, retries forever by design.
- **Bar.** Three counts, the serials, and the stuck age while `factsFailure` is set.
- **Screen.** Every write is in `queue.run` and handed to `track` before it starts. The stop is checked and `closeBox(true)` runs in the same job before every scan (N11). `isLeaving` refuses scans synchronously.

Trap analysis (additions to the Task 8 table):

| state / event                                                | result                                                                                                                                           | way out / data                                                                      |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| office closes the shift while the floor works (online)       | scans keep being recorded until the next shift read (revision → `shiftReader` → `office_closed` leave, drained)                                  | the host accepts them as late data (`late_data_at`); nothing lost, nothing rejected |
| office closes the shift while the floor is offline for hours | the floor never notices until the link returns; scans and closes continue under the closed shift                                                 | delivered as late data on return; owner note                                        |
| crash after the scan's transaction, before `onRecorded`      | records in the outbox; on start the link sends after `watch` subscribes                                                                          | ✓                                                                                   |
| crash between the filling scan and its close                 | entry job `closeBox(true)` closes it first                                                                                                       | ✓ (pinned `:608`, App restart test)                                                 |
| crash after the close commit, before `onClosed`              | the box is closed in the DB with its record; `onClosed` is not told                                                                              | 2a7 print recovery from `floor_boxes` (documented in the JSDoc and AGENTS)          |
| crash after `keepRequest`, before or after `requestBlock`    | the waiting request is repeated with the same id; the host answers the same block                                                                | ✓ (`floor-offline-line`)                                                            |
| crash after the host committed a batch, before receipts      | resend → the host returns the stored receipts by digest                                                                                          | ✓                                                                                   |
| offline for hours, then reconnect                            | backlog drained 100 at a time, `more` → immediate next; the bar re-counts per batch                                                              | ✓; 22 ms per count at 200k unsent (m5)                                              |
| `no_serials` on a partial box                                | scans refused, only «Повторить»                                                                                                                  | leave and re-enter (m6)                                                             |
| `exhausted`                                                  | «Повторить» loops on `exhausted`                                                                                                                 | leave; administrator (words say so)                                                 |
| other host / probe answer during work                        | held (`pendingOtherHost`/`pendingProbe`), link stopped, applied by `endWork` after the drain or by `operator_signed_out` (which calls `endWork`) | ✓ (my M6 killed 2 shell tests)                                                      |

- Outbox order: `seq` is a rowid alias (monotonic for the remaining rows even if 2a8's retention deletes the newest acked row).
- Ids:
  - a scan's record id is its `floor_scans.id` (the receipt marks the scan by it);
  - `box_closed` has its own id;
  - `boxId` is made at the first accepted scan, and the host opens the box at its first accepted `ok` scan;
  - `requestId` is kept before the send.

Data model vs migration 0006 and the host:

- Every insert satisfies the 0006 CHECKs (verdict/raw_kind/code/box_id couplings; closed box ⇔ sscc/block/serial).
- `box_closed` carries 18 digits, `itemCount > 0`, a 64-hex digest and extension 0, which is what `box_closed.rs::check` and `rules::names_serial(…, 0, …)` require.

Against the pallet-aware host (protocol 3, ПЛ-Х), the station sends extension 0 only. Nothing in 2a6 breaks at runtime:

- `box_closed` without `palletId` is accepted even for a pallet shift (`box_closed.rs:62-64`, `pallet_id` `None`). So a 2a6 station on a pallet shift produces boxes without pallets, silently. ПЛ-Х's own AGENTS paragraph rules it out by installation.
- New receipt codes parse, because `factReceiptSchema.code` is a plain string.
- `sscc_blocks.rs` keeps separate counters per prefix and extension, and repeating a `requestId` with another extension is `validation_failed` on `requestId`, which the station already handles as «new request once».
- What must change (ПЛ-Ц):
  - `FACT_RECEIPT_CODES` gets the four pallet codes (the merge; see the checklist);
  - `BlockContext` gets an `extension` (it is hard-coded `BOX_EXTENSION` in `blockWanted`, `waitingRequest`, `keepRequest`), with one supply **per extension** per screen;
  - `boxClosedFactSchema` admits `palletId`;
  - the pallet step goes through `closeSteps`.

### (2) N24 — `remainingSerials` vs `closeOpenBox`

See m7. There is no divergence in any state the host can produce. The two divergences need a host past capacity or overlapping, or a former pairing's SSCCs re-issued.

### (3) The duplicated full-box rule

See m2. The risk today is low (one comparison, both copies tested). It rises with 2a7/ПЛ-Ц, whose fragments name `closeIfFull` inside `closeBox`. **Unify in the final wave** with a shared predicate; do not rewrite `attemptClose`.

### (4) The outbox and receipt machine

- Order: `UNSENT_SQL … ORDER BY seq LIMIT 100` on `outbox_unsent`.
- The batch cap of 1.75 MiB (1 835 008) sits above 100 × 16 KiB (1 638 400). It never cuts a batch of valid records, and the body (≈ +113 bytes of wrapper and commas) stays under axum's 2 MiB. Re-serializing the parsed payload yields the same bytes.
- Unary-plus fix: plans verified on 3.53 (my bench: `SEARCH outbox USING INDEX sqlite_autoindex_outbox_1 (id=?)`, the scans and boxes by their keys, 0.2–0.5 ms per 100) and on 3.46 (cargo test).
  - My M9 removed the `+` on `outbox.host_id/device_id` only. Only the text-parity test failed: `+acked_at` alone keeps the outbox statement on the id key on 3.53, so the two pluses there are belt and braces.
- `conflict` marks the scan and its box. `rejected` marks nothing (N21, owner).
- A stuck batch is retried forever, and the bar says how long.
- Restart: the replay gets the stored receipts by digest.
- A stray receipt id fails the batch as a host failure (by design).

### (5) Identity and trust

- Every read and write carries `(host_id, device_id)`, or goes by a key read under it: the CAS on `block_id`, the request delete by `request_id`, the close by `id` plus pairing.
- The global `SELECT 1 FROM floor_boxes WHERE sscc = ?` is intentionally cross-pairing.
- The screen reads the pairing through `live` at the job's turn, and `FloorApp` is keyed by pairing and session.
- The fact sender reads only the current pairing's rows, and stops with `linked = null` while a refusal or other host is held.
- No console output. An invalid scan keeps only kind and length. Status-bar texts hold counts only.
- `pendingOtherHost`/`pendingProbe` vs the forget flow: the other-host and forget screens come only through `endWork`, at `work_left` after `gate.drain()` or at `operator_signed_out`, which applies `endWork` first. So the `lib.rs:163-167` premise ("forget offered only with no open shift and with the fact writer stopped") holds.
  - The link's receipts can still land after a probe answer shows another screen. They only acknowledge records (`acked_at`) and never add unsent ones, so the forget's count cannot be undercut.

### (6) Query plans at 200 000 codes (node:sqlite 3.53, no ANALYZE)

| read (path)                            | plan                                                           | median / max                                     |
| -------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------ |
| `readLocalOwner` (scan)                | `sqlite_autoindex_floor_codes_1 (host_id,device_id,code_hash)` | 0.002 / 0.009 ms                                 |
| `readOpenBox` (scan, close, every job) | `floor_boxes_shift (…, closed_at=?)`                           | 0.002 / 0.005 ms                                 |
| scan transaction (4 writes)            | —                                                              | 0.03–0.08 / 0.25 ms                              |
| `BOX_CODES_SQL` (close)                | covering `floor_codes_box`                                     | 0.001 ms                                         |
| held SSCC (close)                      | covering `floor_boxes_sscc`                                    | 0.001 ms                                         |
| `BLOCKS_WITH_ROOM_SQL` (bar)           | `floor_sscc_blocks_prefix`                                     | 0.001 ms                                         |
| `HEAD_RECORD_SQL` (bar while failing)  | `outbox_unsent`                                                | 0.001 ms                                         |
| `UNSENT_SQL` LIMIT 100 (send)          | `outbox_unsent`                                                | 0.006–0.05 / 1.5 ms                              |
| rejected / conflict counts (bar)       | covering `outbox_settled`                                      | 0.001–0.06 ms                                    |
| **unsent count (bar)**                 | `outbox_unsent`, all entries                                   | 0.001 ms online; **22 / 59 ms with 200k unsent** |
| **accepted count (in the queue)**      | covering `floor_codes_shift`, all entries                      | **22–24 / 50–60 ms** (m5)                        |
| last SSCC (in the queue)               | `floor_boxes_shift` + temp B-tree                              | 3 / 25–74 ms                                     |
| attempt / receipts ×3 (send)           | by key (see (4))                                               | 0.1–0.5 ms per 100                               |

- The scan path proper is sub-millisecond.
- Both lists hold the same plans; the shell list passed on 3.46. I could not time 3.46.

### (7) Tests as a suite

- No sleeps used as synchronization in 2a6's files. The `setTimeout(0)` uses in the status bar's "late read" tests come after a deterministic held-read release (node:sqlite is synchronous). The 30 ms sleep in `app.test.tsx:2563` predates 2a6 (04baef8ad).
- The App restart tests rely on `waitFor`'s 1 s default under load, the same as the rest of `app.test.tsx`. Under load the full suite needs `--testTimeout=60000`, a pre-existing condition.
- `floor-offline-line.test.ts` is one long scenario: real modules, a database file, a strict fake host, restarts.
- Titles are faithful. «lets nothing close a box by hand while the operator leaves» is now backed by `:1357-1402`.
- My mutants:

| id  | file:line            | mutation                                | killed by                                            |
| --- | -------------------- | --------------------------------------- | ---------------------------------------------------- |
| M1  | scan-pipeline.ts:102 | drop `\|\| check.owner.sameDevice`      | 2 pipeline tests                                     |
| M2  | box-close.ts:224     | `false &&` held-SSCC check              | «is lost like a serial past the range…»              |
| M3  | block-supply.ts:75   | overlap counted twice                   | «counts a serial that two kept blocks cover once…»   |
| M4  | facts-sender.ts:38   | drop `kept.length > 0 &&`               | «carries a record larger than the budget alone…»     |
| M5  | WorkScreen.tsx:656   | `leavingNow()` → `live.current.leaving` | «refuses a scan once the floor knows it is leaving…» |
| M6  | shell.ts:398         | probe never held                        | 2 shell tests                                        |
| M7  | host-link.ts:326     | no immediate next batch                 | 2 host-link-facts tests                              |
| M8  | WorkScreen.tsx:326   | `<` → `<=` (full rule copy)             | 32 screen tests                                      |
| M9  | facts-sender.ts:91   | drop `+` on outbox host/device          | the parity test only (plan held by `+acked_at`)      |

- All files were restored (`cmp` silent, same sha256), and the tree is clean.

### (8) Documents

- `AGENTS.md` "Floor work", the corrected «Two windows», «Hardware», «Shifts» and «App shell» sentences, and spec §18 (with the §17 «Закрыто и перенесено в 2a6» rewrite) match the final code. I checked:
  - the hold semantics and the `endWork` order;
  - `isLeaving`/`linkHeld`;
  - `CUE_MS` 350 / `SIGNAL_MS` 700 and `pointer-events: none`;
  - the lost-answer readback;
  - the 400 for an over-limit body;
  - `MAX_RECORD_BYTES`;
  - `SERIALS_LOW` 100 and `REFRESH_MS` 10 s;
  - one supply;
  - N21/N22.
- Only the code comments of m1 contradict them.
- «`closeIfFull` is the same rule for a caller outside the screen» is honest about the duplicate (m2 removes it).
- After the merge, «with a new field of `box_closed` that raises `PROTOCOL_VERSION`» is stale: ПЛ-Х already made it 3 (merge checklist).

### (9) Scope and process

All clean (see "What I checked"), except I-1.

### (10) Merge readiness into `claude/integration` (91bfdbbba)

`git merge-tree --write-tree HEAD 91bfdbbba` gives a clean tree `88cf4c68725ac19a4cdb206fcab20be461e12e41`, exit 0. There is no textual conflict in `AGENTS.md`, the specs, `protocol.ts`, `api.ts`, `ru.json`, `test/support/*`, the shell migrations or `TABLE_CLASSES`. Spec numbering:

- the 2a spec's §18 is 2a6's (reserved);
- ПЛ-Х's §18 is in the **pilot** spec;
- 2a spec §19 is 2a2's and §20 is 2a5's.

So nothing clashes now. 2a8's §20 and О-Ф's §21 will clash later.

One test breaks semantically: `protocol.test.ts:1772` «know every receipt code of the host». The merged fixture lists 15 codes; `FACT_RECEIPT_CODES` lists 11. The ПЛ-Ц plan's Task 1 confirms it fixes this (its note at line 104 and Task 1 text at 244). **Recommendation: fix it in the merge** by appending `"no_pallets", "pallet_unknown", "pallet_already_closed", "pallet_state"` in the fixture's order, so integration stays green. ПЛ-Ц Task 1 then applies its fragment by meaning. No other 2a6 test reads a fixture or schema field that ПЛ-Х changed: 2a6's `protocol.test` reads `code-check-taken`, `fact-receipt-codes`, `facts-request`, `facts-response`, `sscc-block(-request)`, and only `fact-receipt-codes` changed.

## (b) Triage

| item                                            | decision                                                 | reason                                                                                                                                                                                                                                             |
| ----------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 three outbox counts                           | DONE                                                     | `outbox-status.ts:27-51`, pinned in both lists                                                                                                                                                                                                     |
| 2 unary plus in the receipt transaction         | DONE                                                     | `facts-sender.ts:80-110`, pinned in both lists plus text parity (M9)                                                                                                                                                                               |
| 3 SSCC already held → lose the serial           | DONE                                                     | `box-close.ts:215-224` (M2 killed)                                                                                                                                                                                                                 |
| 5 both query-plan lists                         | DONE                                                     | 30 shell entries (cargo passed on 3.46) plus Node lists and two parity tests                                                                                                                                                                       |
| 26 / N3 other host and probe behind the gate    | DONE                                                     | `pendingOtherHost`/`pendingProbe`, `endWork` (M6 killed)                                                                                                                                                                                           |
| 27 `countUnsentRecords` text                    | N/A                                                      | called once per forget (`App.tsx:323`); documented                                                                                                                                                                                                 |
| N16 m3 `codes.length === itemCount` guard       | DROP; CARRY an invariant test to 2a8                     | a runtime guard turns a mismatch into a permanent stop («Повторить» forever), whereas today the host records `digest_matches = false`; the invariant belongs to 2a8's exceptions (each keeps `item_count = count(floor_codes)` in one transaction) |
| N16 m6 `codeHashes` doc                         | DONE                                                     | `box-close.ts:29`                                                                                                                                                                                                                                  |
| N18 m1 silent overlap drop and the `failed` doc | FIX doc (m3); CARRY reporting to ОЧ/2b                   | doc is false now; the alarm needs a screen                                                                                                                                                                                                         |
| N18 m2 «≤ 1 row» comments                       | DROP; CARRY cleanup to 2a8 retention                     | the comments say «per pairing and prefix», true per key; old rows are already in «Перенесено» (2a8)                                                                                                                                                |
| N20 m1/m2/m6                                    | FIX (m1)                                                 | comments contradict the docs; one test hole                                                                                                                                                                                                        |
| N21 `rejected` flags nothing                    | CARRY to owner (pilot review)                            | default kept and documented (AGENTS, §18)                                                                                                                                                                                                          |
| N22 a screen request skips the backoff          | DOC in the plan deviations; CARRY m8 to ОЧ               | plan-mandated                                                                                                                                                                                                                                      |
| N24 `remainingSerials`                          | DOC (m7)                                                 | no reachable divergence; one sentence                                                                                                                                                                                                              |
| T4 m2 a step's own mismatch reads `stale`       | CARRY to 2a7/ПЛ-Ц dispatch                               | steps check preconditions themselves; no `expectedChanges` unless transient                                                                                                                                                                        |
| T4 m7, T3 m4                                    | DROP                                                     | report evidence only                                                                                                                                                                                                                               |
| T5 m3 / N17                                     | DONE                                                     | tests `:1025`, `:1318`                                                                                                                                                                                                                             |
| T6 4 (stuck batch forever)                      | DONE (by design, documented; bar shows age and attempts) | —                                                                                                                                                                                                                                                  |
| T8 m1–m8                                        | DONE                                                     | 7e2af8be7 / 5da8eb892 (tests `:1318-1493`)                                                                                                                                                                                                         |
| T9 concern 1 (`closeIfFull` copy)               | FIX (m2)                                                 | anchors of 2a7/ПЛ-Ц                                                                                                                                                                                                                                |
| T9 concerns 2, 3                                | ACCEPT                                                   | §18 placement is fine; the extra AGENTS hunks are true                                                                                                                                                                                             |
| new I-1 prettier                                | FIX                                                      | CI red                                                                                                                                                                                                                                             |
| new m4 stale pin                                | FIX                                                      | misleads                                                                                                                                                                                                                                           |
| new m5 accepted count in queue                  | CARRY to 2a8 / owner                                     | measure on the factory PC                                                                                                                                                                                                                          |
| new m6 partial-box stop                         | CARRY to 2a8                                             | stops UX                                                                                                                                                                                                                                           |
| new m8 offline attempts                         | CARRY to ОЧ                                              | —                                                                                                                                                                                                                                                  |
| new m9 cosmetic                                 | DROP                                                     | —                                                                                                                                                                                                                                                  |
| merge: receipt codes                            | FIX at the merge                                         | keeps integration green                                                                                                                                                                                                                            |

**Fix wave (one fixer, three commits; tests apart from production):**

1. `test(standalone): …` (tests only):
   - `prettier --write test/floor-scan-source.test.ts` (I-1);
   - delete the stale `coalesce(sum…)` pin, `floor-schema.test.ts:736-741` (m4);
   - in `host-link-facts.test.ts`, `waitFor(unsent 0)` at `:484`, and relabel the «a 413» row (`:302`, and `:264` as hypothetical, or use 400 `validation_failed`) (m1/N20).
2. `fix(standalone): …` (production comments only):
   - 413 → «400 `validation_failed`» in `facts-sender.ts:19`, `shell.ts:53`, `facts.ts:65-66`;
   - `facts-sender.ts:30-31` wording and the `:116` rewrap;
   - the `block-supply.ts` `failed` doc and the overlap drop in the module doc (m3);
   - the `remainingSerials` sentence (m7).
3. `refactor(standalone): …` (production): `boxIsFull(itemCount, capacity)` exported from `box-close.ts` and used by `closeIfFull` and `WorkScreen.attemptClose` (m2). Show one predicate mutant failing both `floor-box-close` (or `floor-scan-pipeline`) and `floor-work-screen`.

Then:

- the PRETTIER GATE run live on every changed file (repo-relative, from the root, one deliberate failure first);
- typecheck and lint;
- focused Vitest: `floor-scan-source`, `floor-schema`, `host-link-facts`, `facts-sender`, `floor-block-supply`, `floor-box-close`, `floor-scan-pipeline`, `floor-work-screen`;
- `git diff --check`, one trailer per commit.

The plan's «Отклонения при исполнении» (below) is the controller's commit.

## (c) DEVIATIONS TO RECORD — draft for «Отклонения при исполнении»

- **Задача 1.** Схемы и построители — по тексту плана. `FACT_RECEIPT_CODES` — 11 кодов плана 2a2. После слияния с ПЛ-Х фикстура знает 15 кодов: четыре кода паллет добавляются при слиянии, задача 1 плана ПЛ-Ц применяется по смыслу.
- **Задача 2.** По тексту плана. Один тестовый файл (`test/floor-scan-source.test.ts:267`) не проходил prettier, хотя в отчёте значился чистым (ловушка абсолютных путей); исправлено волной итогового ревью.
- **Задача 3.** Сверх плана `readScan` отклоняет серию с управляющим символом категории Cc, включая C1 (U+0080–U+009F), как хост (`char::is_control`). Ошибка обработчика `onHostError` не решает судьбу скана: она перехватывается.
- **Задача 4.** Сверх плана: проверка `SELECT 1 FROM floor_boxes WHERE sscc = ?` до записи — номер, чей SSCC уже стоит на коробе (прежнего подключения), списывается как `invalid_serial` (дополнение 3). `readClosedBox` читает короб, чьё закрытие записалось, а ответ потерян (N12). `codeHashes` — в порядке хеша.
- **Задача 5.** Сверх плана: блок, чьи номера пересекаются с уже сохранённым, не сохраняется, а запрос выбрасывается (`sharesSerials`). Значения теста 2 плана (3500–5499 против 4001–6000) изменены: такой ответ хост дать не может. Запись блока — `ON CONFLICT (block_id) DO NOTHING` (N15).
- **Задача 6.**
  - В транзакции квитанций условия подключения записаны с унарным плюсом (`+host_id`, `+device_id`, `+acked_at`). Текст плана шёл по префиксу `outbox_unsent`, `floor_scans_shift` и `floor_boxes_shift` — 9 с на пачку при 100 000 неотправленных; план задачи 1 закреплял медленный план.
  - Пачка ограничена ещё и `MAX_BATCH_BYTES` (1,75 МиБ).
  - Тело больше предела хост отвечает 400 `validation_failed`, не 413: документы исправлены, комментарии кода — волной итогового ревью.
  - Просьба экрана после записи обходит паузу (N22): допустимо в локальной сети; без связи каждая запись запускает попытку, и счётчик попыток растёт со сканами (перенесено в ОЧ).
- **Задача 7.**
  - `remainingSerials` (файл задачи 5) переопределён: считает номера так, как их берёт закрытие — блоки с местом, не дальше последнего номера префикса, пересечения один раз.
  - Порог предупреждения — 100 номеров, тексты — исполнителя (владелец может поправить).
  - «Застряла доставка» — возраст самой старой неотправленной записи, попытки, время последней.
  - Тесты написаны после кода; красная фаза восстановлена откатом исходников.
- **Задача 8.**
  - Принятый скан — тон и подсветка строки последнего скана на 350 мс (`CUE_MS`), без вспышки на весь экран. Решение контролёра по ревью: вспышка плана закрывала счётчики и кнопки на темпе линии и расходилась с облачной станцией.
  - Отказ и дубль — вспышка 700 мс в обёртке `pointer-events: none`.
  - Добавлены свойства `isLeaving`, `linkHeld`, `closeSteps`, `onClosed`.
  - `other_host` и любой `host_probed` во время смены удерживаются (`pendingOtherHost`, `pendingProbe`) и применяются `endWork` после ворот (дополнения 26, N3). Заменён тест 2a5, закреплявший обратное.
  - Закрытие на экране идёт через `attemptClose`, а не через `closeIfFull`: фрагменты планов 2a7 и ПЛ-Ц с якорем `full ? closeIfFull(context, steps) : closeOpenBox(context, steps)` применяются по смыслу. Шаги закрытия передаются свойством `closeSteps`, которое уже доходит до каждого закрытия. Правило полного короба после волны итогового ревью — одна функция `boxIsFull`.
- **Задача 9.**
  - Раздел спецификации «Уточнения плана 2a6» — §18 (номер был оставлен за планом), вставлен между §17 и §19.
  - В `AGENTS.md` сверх трёх правок исправлены предложения «Hardware» и «Two windows stay by design»: они противоречили готовому коду.
- **Счёт тестов.** Vitest на настоящем дереве — 101 файл, 3010 тестов (на копии плана — 96 и 2323). Cargo: изменён только тест `src-tauri/tests/local_db.rs` (список планов — 30 чтений; на SQLite 3.46 зелёный).
- **Не сделано в 2a6, перенесено:**
  - сигнал о пересекающемся блоке (ОЧ/2b);
  - проверка `item_count = count(floor_codes)` — инвариант исключений 2a8, тестом;
  - «Продолжить сборку» при остановке неполного короба (2a8);
  - инкрементальный счёт принятых или обновление итогов вне очереди при больших сменах (2a8, замер на ПК завода);
  - отправка при связи не `online` (ОЧ);
  - решение владельца по N21 (пометка короба при `rejected`).

## (d) What could not be verified

- CI. No `standalone-*` jobs were run, `pnpm format:check` was not run repo-wide, and the full Vitest was not re-run (by instruction; the count was verified with `vitest list`).
- Windows 10/11 and WebView2: the shell's `standalone://scan` channel, the real `HardwareApi.onScan`, sound on real speakers, touch-panel taps through the flash, the 1024 × 768 and 1280 × 800 layout, and screen-reader behaviour.
- Real scanners: a keyboard wedge with RU/EN layouts and Caps Lock, a COM scanner with and without `]d2`, both at once, and 3–5 scans/s on a factory PC.
- A real host. Its receipts (`conflict`, `sscc_not_issued`, late data after an office close) were checked by reading the host code, not by running it; every test uses a fake `HostApi`.
- SQLite 3.46 latency: only the plans (cargo test); the timings are node:sqlite 3.53 on a heavily loaded machine.
- The merged tree's tests: predicted by `merge-tree` and by reading fixtures and tests, not run.

## (e) What plans 2a7, 2a8 and ПЛ-Ц must know

- The real `WorkScreen` differs from 2a6's plan text:
  - there is no `scanRef`: the queue job calls the `scan` callback;
  - `closeBox(full)` = `settleUnsure` + `attemptClose(env, full)` (with `closeSettled`, `CLOSE_TRIES = 3`), and the `full ? closeIfFull(…) : closeOpenBox(…)` line does not exist;
  - pass steps through the `closeSteps` prop, start printing in `onClosed`;
  - an accepted scan has no flash (`CUE_MS`), so 2a7's `show("ok"…)` fragment adapts.
- `onClosed` is told in the queue's turn after the write. A box whose answer was lost and whose screen left before the readback is never told, so 2a7's print recovery must read `floor_boxes` (or `floor_print_jobs 'prepared'`).
- Every box writer stays in the screen's queue and is handed to `track` before it starts (N13). A step's statement whose `expectedChanges` cannot hold is reported as `stale`, three times, then `close_failed`. Steps must check their preconditions by query (T4 m2).
- The `Stop` union is `system_error{write|read}`, `confirm_close`, `no_serials{reason, full}` and `close_failed{full, cause}`. A stop on an incomplete box has no «continue» (m6, 2a8).
- 2a8:
  - the fourth receipt UPDATE (`local_state` on an accepted `shift_closed`) goes into `receiptStatements` with the unary-plus pattern and a line in both query-plan lists plus the text-parity test;
  - exceptions keep `item_count = count(floor_codes)` in one transaction (test it);
  - the accepted count is O(shift) (m5);
  - after an office close, the host accepts the floor's later facts as late data; offline the floor notices only on return.
- ПЛ-Ц:
  - `BlockContext` needs `extension` (it is hard-coded `BOX_EXTENSION` in `blockWanted`, `waitingRequest`, `keepRequest`);
  - one supply per extension per screen (two supplies of one extension break the save, N17);
  - `remainingSerials(…, extension)` is already parameterized;
  - `boxClosedFactSchema` is strict: `palletId` passes only after its change; the record's own fields win over `CloseAddition.data`;
  - the pallet-aware host accepts `box_closed` without `palletId` on a pallet shift, so a 2a6-only station must never work pallet shifts;
  - the AGENTS sentence about `box_closed` raising `PROTOCOL_VERSION` needs rewording (already 3).
- The status bar re-reads on `outboxVersion`. Any new writer of the outbox or of blocks dispatches `outbox_changed` (via `onRecorded`).

## (f) Merge checklist (2a6 → `claude/integration` 91bfdbbba)

1. Land the 2a6 fix wave first (I-1, m1–m4, m7), then merge. The textual merge is clean (`merge-tree` tree `88cf4c687…`).
2. In the merge commit, add the four pallet receipt codes to `FACT_RECEIPT_CODES` (`src/host/protocol.ts`), in the fixture's order. Otherwise `test/protocol.test.ts` «know every receipt code of the host» fails. Note it for ПЛ-Ц Task 1 («по смыслу»).
3. Reword `AGENTS.md` "Floor work": «with a new field of `box_closed` that raises `PROTOCOL_VERSION`» → «… with `box_closed.palletId`, which protocol 3 (plan ПЛ-Х) already carries». Or leave it to ПЛ-Ц Task 10, but record it.
4. Specs: 2a spec §18 = 2a6 and pilot spec §18 = ПЛ-Х, so there is no clash. Keep the note that 2a8's §20 and О-Ф's §21 must be renumbered at their merges.
5. After the merge, run on the merged tree:
   - focused Vitest: `protocol`, `api`, `floor-facts`, `facts-sender`, `floor-box-close`, `floor-block-supply`, `floor-schema`, `floor-status-bar`, `floor-work-screen`, `floor-app`, `app` (App with `--testTimeout=60000` under load);
   - typecheck, lint, and the live PRETTIER GATE on every file the merge touches;
   - `cargo test --offline --locked … --test local_db the_floors_repeating_reads` (and the workspace gate in parts, as before).
6. Do not cut a pilot build from integration after this merge until ПЛ-Ц and О-Ф land. The webview announces protocol 3 without knowing pallets, and a pallet shift would produce boxes without pallets.
7. Cleanup per the authorized scope only. `/tmp/claude/rev-2a6-final/` holds this review's scratch (bench, mutant logs); it is outside the repository.
