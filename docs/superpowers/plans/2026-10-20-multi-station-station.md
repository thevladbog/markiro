# Multi-station shift: station implementation plan (milestone 2b, part 2 of 5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a station of «Markiro Автоном» work one shift of its line together with other
stations and handhelds: join a shift another device works while the line has a free slot, see
«Моя станция: N · Всего в смене: K из M» with the age of the host's figures when offline, reach
the plan by the shift-wide total, close only its own part (the reason asked only of the last
closer, online), see what became of that close, and pause its part on «Выйти из смены» — all
offline-first.

**Architecture:** The station consumes the host contract of
`docs/superpowers/plans/2026-10-20-multi-station-host.md` (protocol 7, capability
`multi-station-v1`, `DeviceShift.maxStations/participants/myState/totals/byDevice`, the leave
route, the `shift_closed` receipt details). One new shell migration adds a disposable cache table
`floor_shift_participation` (the host's figures per shift, never recalculated, newest `asOf`
wins — or a read a minute later by the station's clock — plus this station's own pending pause); one module
(`src/floor/shifts/shift-participation.ts`) owns its statements, reads and the pure derivations
(shared or not, the others' part, last closer). The hub, the work screen and the close read that
cache; the link (`useHostLink`) sends pending pauses and refreshes the list on request. The
station's own records (`floor_shifts`, `floor_codes`, `floor_boxes`, the outbox) keep their
meaning; the close's part state is read from the receipt the outbox already stores.

**Tech Stack:** React 19 + TypeScript (strict, `exactOptionalPropertyTypes`,
`noUncheckedIndexedAccess`), Zod 4, react-i18next (RU), Vitest + Testing Library + jsdom,
`node:sqlite` test executor (`test/support/local-db.ts`), Tauri 2 shell (Rust, sqlx SQLite
migrations), Playwright-core measuring guard (`test/station-fit.browser.test.ts`).

**Spec:** `docs/superpowers/specs/2026-10-20-standalone-multi-station-shift-design.md` §5 (station),
§2 (current state), §12.9 (offline last closer). **Host contract:** the section «Host contract for
the other plans» and decisions D1–D18 of the host plan. **This plan is part 2 of 5** (host,
station, office, handheld, load/soak).

**Commands.** `$WT` is the absolute path of the executor's worktree (`/tmp/claude/wt/<NAME>`,
`docs/standalone/ledger/exec-rules.md`). Never `cd`. Vitest runs as
`pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run <files>`;
cargo as `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" …`. The
shell's (`markiro-standalone`) Cargo tests need `apps/standalone/dist`: build it once with
`pnpm --dir "$WT" --config.verifyDepsBeforeRun=false turbo build --filter '@markiro/standalone...'`.
Line numbers below are those of `main` at 3dc8df952 **before** the host plan; the host plan moves
`src/host/protocol.ts`, `test/protocol.test.ts` and `apps/standalone/AGENTS.md`, so those three
are anchored by quoted text, not by line.

## Global Constraints

From the spec (owner decisions of 2026-10-20, §1, §5, §12.9) and the host contract:

- Several stations and handhelds work one shift of one line in parallel, one product; each station has its own boxes and its own pallets.
- Each participant closes its own part; the shift closes when every participant closed; the office may close the whole shift.
- Counter and plan: «Моя станция: N · Всего в смене: K из M»; the plan is reached by the shift-wide total.
- K comes from the host's `totals`; without the link the last known value is shown with the mark «данные от ЧЧ:ММ»; the plan-reached notice comes at the next refresh.
- Card: «Присоединиться» when a slot is free; on `shift_line_full` «Линия занята: N из N» with no action; the participants listed (device name, kind).
- Close: «Закрыть мою часть»; blockers unchanged (own open box, labels, open pallet); the reason only of the last closer; the others are told «Смена закроется, когда закроют остальные».
- Offline last closer (spec §12.9, host D7): the station closes its part without a reason; the host closes the shift with `reasonMissing` and the office supplies the code.
- «Выйти из смены» stays a pause (`left`).
- Offline: entry offline only into a shift this station already knows; the part's close is queued and confirmed idempotently; SSCC blocks and duplicates as today; conflicts visible and recoverable (`conflict-notices.ts`).
- Local tables `floor_shifts`, `floor_boxes`, `floor_codes` keep their meaning; only a cache of the shift's totals is added.
- With `max_stations = 1` and no other device a station sees no change.
- Protocol 7, capability `multi-station-v1` sent on every entry (`shift-enter-multi.json`), build 1.1.0 — all delivered by the host plan, which is released first.

From `apps/standalone/AGENTS.md` and the root `AGENTS.md`:

- Offline-first: no queued local operation is replaced by an online-only action; journals and outboxes survive restart; sync is retry-safe and idempotent; device sequence and instants stay as written (`Date.toISOString` on the station, the host's own format for its instants).
- Never recalculate persisted history: the cache keeps the host's figures as sent; an older read never replaces a newer one; stored receipts and close records are not rewritten.
- DDL lives only in `src-tauri/migrations`; an applied migration is never edited; the new one takes the next free number: **`0021`** today (highest `0020_dataset_epochs.sql`; `0011` was never used) — re-check before Task 2.
- A migration that adds a table adds it to `TABLE_CLASSES` (`src-tauri/src/local_db.rs`) in the same change; no foreign keys; every row carries `host_id`, `device_id`.
- Webview statements: one `SELECT`/`WITH` per query, ≤ 32 statements per transaction, ≤ 64 KB and ≤ 256 values each, no `;`, `--`, `/*`, no DDL/PRAGMA words, never a leading `END` (`checkStatement`).
- `SYNC_SCHEMA_VERSION` stays 5: no feed record schema or copy-table meaning changes (host D13: the feed's `lines` record is unchanged).
- Wire types: the Zod schemas of `src/host/protocol.ts` are the host plan's; response types tolerate unknown fields, requests are `z.strictObject` / `.strict()`; every shared fixture is parsed by Vitest.
- Station kit: every control ≥ 64 px both ways; the floor's primary 72 px (84 px in a window ≥ 900 px high; the hub card's action may be 64 px in a window ≤ 700 px high, `measure-fit.ts`); one layer (no modal over a modal); tokens of `@markiro/ui` only; nothing scrolls the page; the short-window matrix 1024×640, 1024×700, 1024×768, 1024×820, 1280×700, 1280×800, 1280×1024, both themes, is guarded by `test/station-fit.browser.test.ts` through `test/harness/*`.
- Every user-visible string goes through `src/i18n/ru.json` (a missing key throws in tests); a product's name on the floor is `shiftProductTitle` (print name).
- TypeScript strict, no `any`, no broad casts, no non-null assertions; `import type` for types only.
- TDD: a failing test first, then the code; never weaken an existing assertion; a pre-existing test changed because a product decision changed is named in the report (Task 1 names five).
- Commits are scoped, stage explicit paths, and end with exactly one trailer line `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` (executor rules).
- Not verifiable here (state it in the report): real Windows WebView2, real stations and handhelds on a LAN, real scanners and printers, the load/soak acceptance (spec §8, separate plan).

---

## Decisions taken by this plan (with reasons)

- **S1. A separate cache table, migration `0021_floor_shift_participation.sql`, `TableClass::Disposable`.**
  The figures are the host's, not this device's records: a forget may empty them and the next read
  brings them back. Columns added to `floor_shifts` would also break the pinned schema snapshots
  of `src-tauri/tests/local_db.rs` (`without_0016`) for no gain. One row per (pairing, shift); every
  list read deletes rows of shifts the pairing no longer keeps.
- **S2. The capability is always sent.** `STATION_SHIFT_ENTER` becomes `shift-enter-multi.json`
  (`validation-v1`, `validation-dm-duplicate-v1`, `multi-station-v1`). A protocol-7 station never
  talks to a protocol-6 host (`host_too_old`, host D12), so `shift_busy` is kept only as a
  defensive mapping, and a shift with no participation in the cache keeps stage 2a's «Занята
  другой станцией».
- **S3. "Shared" means `maxStations > 1` or more than one participant ever** (`sharedParticipation`).
  A solo station on a line of one sees exactly stage 2a (strip, labels, close). The participants
  line on a card appears only when another device works the shift.
- **S4. Card actions.** `join` (a slot free, enabled online), `line_full` (no action, «Линия занята:
  N из M»), `part_closed` (the host says this station's part is closed and the station kept no
  close: no action), `continue` for an active participant or a left one with a free slot, `busy`
  only without participation. Slots are counted from the cache; the host counts revoked devices
  as free (host D3), which the cache cannot see — the host's answer decides, the card is a hint
  (gap G1).
- **S5. The strip.** The band's large counter becomes «Всего в смене» K with «/ M» and the bar by K,
  a small counter «Моя станция» N stands beside it, and the counters' group is named
  «Моя станция: N · Всего в смене: K из M» (the owner's phrase, also what a screen reader says).
  K = the others' part by the host (`totals.accepted − byDevice[me].accepted`) + this station's
  own local count, so the total never lags behind the station's own scans and never shows less
  than «Моя станция». «данные от ЧЧ:ММ» (the host's `asOf`, local clock) shows only without the
  link. The work screen asks the link to read the list every 15 s while a shared shift is open and
  the link is up (host D11: a scan takes no revision).
- **S6. Plan reached by the shift-wide total**, derived in render (no effect): the notice shows when a
  read or a scan brings K ≥ M, once, until dismissed or the close opens.
- **S7. The reason** (`stationReasonRequired`, mirror of host `reason_need`, pinned by
  `shift-close-reason-shared.json`): a shift that only ever had this station keeps stage 2a's rule
  with or without the link (the host refuses such a close without a reason); a shared shift asks it
  only online, only of the last non-closed participant, by K against the plan; offline never.
- **S8. «Закрыть мою часть».** Only a shared shift's labels change (footer «Закрыть мою часть»,
  confirm «Подтвердить закрытие части», «Закрыть паллету и мою часть»); blockers, the transaction and
  its guards are stage 2a's. The summary's equality ignores K (it moves with the other stations
  every refresh; only `closesShift`, `online` and `reasonRequired` decide).
- **S9. The part's state** (`queued`, `waiting`, `shift_closed`, `reason_missing`, `refused`) is read
  from the `shift_closed` record's stored outcome and details (`outbox.outcome_details`, written by
  `sendFactBatch` already) and the copy's status — no new storage, idempotent replays included.
- **S10. The pause.** Only the operator's «Выйти из смены» (`Leave.kind === "list"`) and a line
  change pause the part; a sign-out (own, idle, removed) does not — another operator usually
  continues at the same station. The pause is written locally (`leave_requested_at`) after the work
  drained, sent by the link when online (`sendPendingLeaves`, retried like the other reads), and
  dropped by any entry, online or offline, so a late pause never undoes a re-entry (host D5). A
  `shift_not_entered` or `not_found` answer clears it. Known limit: a pause already in flight when
  the operator re-enters may land after the entry; the host then lists the station `left` while it
  works (its facts are still accepted; gap G4).
- **S11. Refusals.** `shift_line_full` → `line_full` with the refusal's `{ active, maxStations }`;
  an entry answered with `myState: "closed"` (host D2, a station that lost its database) →
  `part_closed`, nothing kept.
- **S12. Untouched:** the shell's IPC and `host_client.rs` (the leave goes through the generic
  `host_request`), the feed and `SYNC_SCHEMA_VERSION`, retention, SSCC blocks, conflict notices, the
  protocol constant and the build version (host plan Task 14).
- **S13. Wording.** The queue screen's kind `shift_closed` becomes «Закрытие смены станцией» (true for a
  part and for a whole shift).
- **S14. Out of scope:** the office UI, the handheld, a shared pallet, a timeout for `left`
  participants (spec §12.6, host D18).

## File structure

| File                                                                                                                                                                    | Responsibility                                          | Tasks           |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | --------------- |
| `apps/standalone/src/host/requests.ts`                                                                                                                                  | `STATION_SHIFT_ENTER` names `multi-station-v1`          | 1               |
| `apps/standalone/src/host/api.ts`                                                                                                                                       | `HostApi.leaveShift`                                    | 1               |
| `apps/standalone/src/floor/close/shared-reason.ts` (new)                                                                                                                | `reasonNeed`, `stationReasonRequired`                   | 1               |
| `apps/standalone/src-tauri/migrations/0021_floor_shift_participation.sql` (new)                                                                                         | the cache table                                         | 2               |
| `apps/standalone/src-tauri/src/local_db.rs`                                                                                                                             | `TABLE_CLASSES` row                                     | 2               |
| `apps/standalone/src/floor/shifts/shift-participation.ts` (new)                                                                                                         | cache statements, reads, derivations, pause mark        | 3, 7            |
| `apps/standalone/src/floor/shifts/shift-copies.ts`                                                                                                                      | list and entry write the cache                          | 3               |
| `apps/standalone/src/floor/shifts/shift-entry.ts`                                                                                                                       | `line_full`, `part_closed`, offline entry drops a pause | 5               |
| `apps/standalone/src/floor/shifts/ShiftList.tsx`, `ShiftHub.tsx`, `ShiftCard.tsx`, `shift-hub.css`                                                                      | hub and card                                            | 4, 5            |
| `apps/standalone/src/local/leave-sender.ts` (new)                                                                                                                       | sends pending pauses                                    | 7               |
| `apps/standalone/src/app/host-link.ts`, `src/app/App.tsx`                                                                                                               | leave sender, `requestShifts`, `requestLeaves`          | 7               |
| `apps/standalone/src/floor/FloorApp.tsx`                                                                                                                                | pause on leave, work screen props                       | 7, 8            |
| `apps/standalone/src/floor/work/use-shift-participation.ts` (new)                                                                                                       | read and poll the cache                                 | 8               |
| `apps/standalone/src/floor/work/WorkInstruments.tsx`, `work-screen.css`, `WorkScreen.tsx`                                                                               | strip, plan, close labels, part state                   | 8, 10, 11       |
| `apps/standalone/src/floor/shifts/shift-text.ts`                                                                                                                        | `formatClock`                                           | 8               |
| `apps/standalone/src/floor/close/shift-close.ts`, `ShiftClosePanel.tsx`                                                                                                 | part close, part state                                  | 10, 11          |
| `apps/standalone/src/i18n/ru.json`                                                                                                                                      | strings                                                 | 4, 5, 8, 10, 11 |
| `apps/standalone/test/harness/hub-header/main.tsx`, `work-fit/main.tsx`, `station-fit/screens.tsx`, `station-fit/measure-others.mjs`, `station-fit/measure-screens.mjs` | measuring guard states                                  | 6, 9, 12        |
| `apps/standalone/test/support/multi-station.ts`, `test/support/multi-host.ts` (new)                                                                                     | fixtures and a fake shared host                         | 3, 13           |
| `apps/standalone/AGENTS.md`                                                                                                                                             | the station's part of plan 2b                           | 14              |

---

### Task 1: The station speaks the multi-station contract (capability, leave client, reason rule)

**Files:**

- Modify: `apps/standalone/src/host/requests.ts:636-643` (`STATION_SHIFT_ENTER`)
- Modify: `apps/standalone/src/host/api.ts:636-645` (`HostApi`, after `enterShift`), `:1179-1183` (implementation, after `enterShift`)
- Create: `apps/standalone/src/floor/close/shared-reason.ts`
- Test: `apps/standalone/test/floor-shared-reason.test.ts` (new); `apps/standalone/test/protocol.test.ts` (the two lines after «// The station of part A works validation, and says so on every entry.»); `apps/standalone/test/api.test.ts` (describe «HostApi device shifts», `:1039-1135`)
- Modify (product decision changed — the entry names `multi-station-v1`; name them in the report): `apps/standalone/test/app.test.tsx:73`, `test/floor-app.test.tsx:52`, `test/floor-new-shift.test.tsx:50`, `test/floor-shift-list.test.tsx:209-211`, `test/unit-label-screen.test.tsx:1157-1161`

**Interfaces:**

- Consumes (host plan Tasks 2, 3, 14): `SHIFT_SUPPORTS.multiStation`, `PROTOCOL_VERSION === 7`, `deviceShiftSchema`, fixtures `shift-enter-multi.json`, `device-shifts-participants.json`, `shift-close-reason-shared.json`.
- Produces:
  - `STATION_SHIFT_ENTER: ShiftEnter` = `{ supports: ["validation-v1", "validation-dm-duplicate-v1", "multi-station-v1"] }`
  - `HostApi.leaveShift(id: string): Promise<DeviceShift>` (`POST /v1/device/shifts/{id}/leave`, no body)
  - `type ReasonNeed = "none" | "required" | "shared"`; `interface ReasonCase { closesShift: boolean; participantsEver: number; factPlanned: number | null; actualQty: number; hostPlanned: number | null; shiftAccepted: number }`; `reasonNeed(rule: ReasonCase): ReasonNeed`
  - `interface StationReasonInput { plannedQty: number | null; actualQty: number; participantsEver: number; closesShift: boolean; online: boolean; total: number }`; `stationReasonRequired(input: StationReasonInput): boolean`

- [ ] **Step 1: Check that the host contract is in this worktree.**

Run:

```bash
grep -n 'export const PROTOCOL_VERSION = 7' "$WT/apps/standalone/src/host/protocol.ts"
grep -n 'multiStation: "multi-station-v1"' "$WT/apps/standalone/src/host/protocol.ts"
grep -n -E 'export const (shiftParticipantSchema|deviceShiftTotalsSchema|deviceTotalsSchema|maxStationsSchema|participantStateSchema)' "$WT/apps/standalone/src/host/protocol.ts"
ls "$WT/apps/standalone/proto/fixtures" | grep -E 'device-shifts-participants|shift-enter-multi|error-shift-line-full|facts-response-part-close|shift-close-reason-shared'
```

Expected: every line found (5 schemas, 5 fixtures). If any is missing, STOP: the host plan
(`docs/superpowers/plans/2026-10-20-multi-station-host.md`, Tasks 2, 3 and 14) must be merged into
the base first; record it in the report.

- [ ] **Step 2: Write the failing tests.**

In `apps/standalone/test/protocol.test.ts` replace the comment and the line under it:

```ts
// The station of part A works validation, and says so on every entry.
expect(STATION_SHIFT_ENTER).toStrictEqual(fixture("shift-enter.json"));
```

with:

```ts
// The station works validation, prints its duplicate and, since plan 2b, joins a shift
// another device works (`multi-station-v1`), and says so on every entry.
expect(STATION_SHIFT_ENTER).toStrictEqual(fixture("shift-enter-multi.json"));
```

In `apps/standalone/test/api.test.ts`, inside `describe("HostApi device shifts", …)`, append as its
last test (after the test that uses `overShell`, so the helper is in scope):

```ts
it("pauses this station's part with the device key only and no body, and reads the shift back (plan 2b)", async () => {
  const shared = (
    fixture("device-shifts-participants.json") as { shifts: Record<string, unknown>[] }
  ).shifts[0];
  const left = { ...shared, myState: "left" };
  const leaving = recording(left);
  await expect(leaving.api.leaveShift(SHIFT_ID)).resolves.toMatchObject({
    myState: "left",
    maxStations: 2,
  });
  expect(leaving.sent).toEqual([
    {
      method: "POST",
      path: `/v1/device/shifts/${SHIFT_ID}/leave`,
      body: undefined,
      officeToken: undefined,
    },
  ]);
  const shell = overShell(200, left);
  await shell.api.leaveShift(SHIFT_ID);
  expect(shell.call).toHaveBeenCalledWith("host_request", {
    method: "POST",
    path: `/v1/device/shifts/${SHIFT_ID}/leave`,
    body: null,
    officeToken: null,
  });
  // An answer that is no shift is refused, as every device answer.
  await expect(recording({ shifts: [] }).api.leaveShift(SHIFT_ID)).rejects.toThrow();
});
```

Create `apps/standalone/test/floor-shared-reason.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { reasonNeed, stationReasonRequired } from "../src/floor/close/shared-reason.js";
import { fixture } from "./support/proto-fixture.js";

const CASES = z
  .object({
    cases: z.array(
      z.object({
        closesShift: z.boolean(),
        participantsEver: z.number().int(),
        factPlanned: z.number().int().nullable(),
        actualQty: z.number().int(),
        hostPlanned: z.number().int().nullable(),
        shiftAccepted: z.number().int(),
        need: z.enum(["none", "required", "shared"]),
      }),
    ),
  })
  .parse(fixture("shift-close-reason-shared.json")).cases;

describe("the reason a close needs (plan 2b, host D7)", () => {
  it("is the host's rule, case for case of the shared fixture", () => {
    expect(CASES.length).toBeGreaterThanOrEqual(8);
    for (const { need, ...rule } of CASES) {
      expect(reasonNeed(rule), JSON.stringify(rule)).toBe(need);
    }
  });

  it("is asked of a station alone in its shift exactly as stage 2a did, with the link or without", () => {
    const alone = { participantsEver: 1, closesShift: true, total: 99 };
    expect(stationReasonRequired({ ...alone, plannedQty: 100, actualQty: 99, online: false })).toBe(
      true,
    );
    expect(stationReasonRequired({ ...alone, plannedQty: 100, actualQty: 100, online: true })).toBe(
      false,
    );
    expect(stationReasonRequired({ ...alone, plannedQty: null, actualQty: 5, online: true })).toBe(
      false,
    );
  });

  it("is asked of a shared close only online, of the last closer, by the whole shift against the plan", () => {
    const shared = { plannedQty: 1200, actualQty: 427, participantsEver: 2 };
    expect(stationReasonRequired({ ...shared, closesShift: true, online: true, total: 547 })).toBe(
      true,
    );
    expect(stationReasonRequired({ ...shared, closesShift: true, online: true, total: 1200 })).toBe(
      false,
    );
    expect(stationReasonRequired({ ...shared, closesShift: false, online: true, total: 547 })).toBe(
      false,
    );
    // Offline the station cannot know it is last (spec §12.9): the host marks the reason missing.
    expect(stationReasonRequired({ ...shared, closesShift: true, online: false, total: 547 })).toBe(
      false,
    );
    expect(
      stationReasonRequired({
        ...shared,
        plannedQty: null,
        closesShift: true,
        online: true,
        total: 547,
      }),
    ).toBe(false);
  });
});
```

- [ ] **Step 3: Run them to verify they fail.**

Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/protocol.test.ts test/api.test.ts test/floor-shared-reason.test.ts`
Expected: FAIL — `STATION_SHIFT_ENTER` lacks `multi-station-v1`; `api.leaveShift is not a function`; `Failed to resolve import "../src/floor/close/shared-reason.js"`.

- [ ] **Step 4: Implement.**

`apps/standalone/src/host/requests.ts` — replace `:636-643` (the doc comment and the constant):

```ts
/**
 * The body of every shift entry this station sends (`shift-enter-multi.json`, plan 2b): it works
 * validation shifts and prints their Data Matrix duplicate (plan РЕЖ, part B), and it joins a shift
 * another device works while the line has a free slot (`multi-station-v1`, protocol 7).
 */
export const STATION_SHIFT_ENTER: ShiftEnter = {
  supports: [
    SHIFT_SUPPORTS.validation,
    SHIFT_SUPPORTS.validationDmDuplicate,
    SHIFT_SUPPORTS.multiStation,
  ],
};
```

`apps/standalone/src/host/api.ts` — in `interface HostApi`, right after the `enterShift` member
(`:645`):

```ts
/**
 * Pauses this station's part of a shift it works (plan 2b, protocol 7): the host frees its slot
 * of the line (`left`) and answers the shift as this station sees it, without the snapshot.
 * Repeating it changes nothing; `conflict` `shift_not_entered` for a shift it never entered.
 */
leaveShift: (id: string) => Promise<DeviceShift>;
```

and in the implementation object, right after the `enterShift` entry (`:1179-1183`):

```ts
    leaveShift: (id) =>
      client.request("POST", `/v1/device/shifts/${id}/leave`, { schema: deviceShiftSchema }),
```

Create `apps/standalone/src/floor/close/shared-reason.ts`:

```ts
import { shiftCloseReasonRequired } from "@markiro/domain";

/**
 * What a part's close needs (host `shift_participants::ReasonNeed`, plan 2b D7): nothing; stage
 * 2a's reason, which the host refuses to do without (a shift that only ever had this device); or
 * the shared reason, which the host does without and marks missing for the office.
 */
export type ReasonNeed = "none" | "required" | "shared";

/** One case of `proto/fixtures/shift-close-reason-shared.json`, as the host reads it. */
export interface ReasonCase {
  /** No other participant stays active or left: this close closes the shift. */
  closesShift: boolean;
  /** Every participant the shift had, this one included. */
  participantsEver: number;
  /** The plan this device saw (its record's `plannedQtySnapshot`). */
  factPlanned: number | null;
  /** This device's own count (its record's `actualQty`). */
  actualQty: number;
  /** The shift's plan on the host now. */
  hostPlanned: number | null;
  /** The whole shift's accepted units. */
  shiftAccepted: number;
}

/** The host's rule, mirrored and pinned case for case by the shared fixture. */
export function reasonNeed(rule: ReasonCase): ReasonNeed {
  if (!rule.closesShift) return "none";
  if (rule.participantsEver <= 1) {
    return shiftCloseReasonRequired(rule.factPlanned, rule.actualQty) ? "required" : "none";
  }
  return rule.hostPlanned !== null && rule.hostPlanned !== rule.shiftAccepted ? "shared" : "none";
}

/** What the station knows when it closes its part. */
export interface StationReasonInput {
  /** The shift's plan as this station's copy has it now (the host's, by its last list). */
  plannedQty: number | null;
  /** This station's own codes in the shift. */
  actualQty: number;
  /** The participants of the station's last read, itself included (at least 1). */
  participantsEver: number;
  /** By the station's last read, no other participant stays active or left. */
  closesShift: boolean;
  /** The link is up now. */
  online: boolean;
  /** The whole shift's count as the station knows it (`sharedCount`). */
  total: number;
}

/**
 * Whether the close panel asks for one of the six reasons (spec §5 «Закрытие», §12.9): a shift
 * that only ever had this station by its last read keeps stage 2a's rule with or without the link
 * (the host would refuse the close without it, and a second device joining since only makes the
 * reason optional); a shared shift asks it only online, of the last closer, by the whole shift's
 * count against the plan; offline it never asks — the host marks the reason missing.
 */
export function stationReasonRequired(input: StationReasonInput): boolean {
  if (input.participantsEver <= 1) {
    return shiftCloseReasonRequired(input.plannedQty, input.actualQty);
  }
  if (!input.online) return false;
  return (
    reasonNeed({
      closesShift: input.closesShift,
      participantsEver: input.participantsEver,
      factPlanned: input.plannedQty,
      actualQty: input.actualQty,
      hostPlanned: input.plannedQty,
      shiftAccepted: input.total,
    }) !== "none"
  );
}
```

Update the five pinned entry bodies (the product decision changed: every entry names
`multi-station-v1`):

- `test/app.test.tsx:73` and `test/floor-app.test.tsx:52`: `const STATION_ENTRY = { supports: ["validation-v1", "validation-dm-duplicate-v1", "multi-station-v1"] };`
- `test/floor-new-shift.test.tsx:50`: `const ENTRY = { supports: ["validation-v1", "validation-dm-duplicate-v1", "multi-station-v1"] };`
- `test/floor-shift-list.test.tsx:209-211`: `expect(handlers.enter).toHaveBeenCalledWith(PLANNED.id, { supports: ["validation-v1", "validation-dm-duplicate-v1", "multi-station-v1"] });`
- `test/unit-label-screen.test.tsx:1158-1160`: `expect(STATION_SHIFT_ENTER).toEqual({ supports: ["validation-v1", "validation-dm-duplicate-v1", "multi-station-v1"] });` and rename the test to `"names the duplicate print and several devices in one shift among what this station works"`.

- [ ] **Step 5: Run the tests to verify they pass.**

Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/protocol.test.ts test/api.test.ts test/floor-shared-reason.test.ts test/app.test.tsx test/floor-app.test.tsx test/floor-new-shift.test.tsx test/floor-shift-list.test.tsx test/unit-label-screen.test.tsx`
Expected: PASS. Then `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck` — no errors.

- [ ] **Step 6: Commit.**

```bash
git -C "$WT" add apps/standalone/src/host/requests.ts apps/standalone/src/host/api.ts \
  apps/standalone/src/floor/close/shared-reason.ts apps/standalone/test/floor-shared-reason.test.ts \
  apps/standalone/test/protocol.test.ts apps/standalone/test/api.test.ts apps/standalone/test/app.test.tsx \
  apps/standalone/test/floor-app.test.tsx apps/standalone/test/floor-new-shift.test.tsx \
  apps/standalone/test/floor-shift-list.test.tsx apps/standalone/test/unit-label-screen.test.tsx
git -C "$WT" commit -m "feat(standalone): station names multi-station-v1, leaves a shift, mirrors the shared reason rule

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Shell migration `0021` — the participation cache table

**Files:**

- Create: `apps/standalone/src-tauri/migrations/0021_floor_shift_participation.sql`
- Modify: `apps/standalone/src-tauri/src/local_db.rs:101` (`TABLE_CLASSES`, after `("floor_scans", TableClass::DeviceData),`)
- Modify tests: `apps/standalone/src-tauri/tests/local_db.rs:78-81` (table list), `:879-889` (`without_0016`), `:1886-1891` (forget seeds), new test at the end of the file
- Create test: `apps/standalone/test/floor-shift-participation-migration.test.ts`
- Modify test: `apps/standalone/test/floor-schema.test.ts:280-296`

**Interfaces:**

- Consumes: nothing.
- Produces: table `floor_shift_participation (host_id, device_id, shift_id, max_stations, my_state, participants, totals, by_device, as_of, seen_at, leave_requested_at)`, PK `(host_id, device_id, shift_id)`, `TableClass::Disposable`; the Rust constant text of the upsert that Task 3's `UPSERT_PARTICIPATION_SQL` must equal byte for byte.

- [ ] **Step 1: Re-check the number.** Run `ls "$WT/apps/standalone/src-tauri/migrations" | tail -3`. Expected: the last is `0020_dataset_epochs.sql`. If a later file exists, use the next free number everywhere below and record it.

- [ ] **Step 2: Write the failing tests.**

Create `apps/standalone/test/floor-shift-participation-migration.test.ts`:

```ts
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { DEVICE_ID, HOST_ID } from "./support/fixtures.js";

// See test/protocol.test.ts: bind import.meta.url before building a URL from it.
const testModuleUrl = import.meta.url;
const MIGRATIONS = new URL("../src-tauri/migrations/", testModuleUrl);

function migrate(db: DatabaseSync, from: string, to: string): void {
  const files = readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith(".sql") && name >= from && name <= to)
    .sort();
  for (const name of files) db.exec(readFileSync(new URL(name, MIGRATIONS), "utf8"));
}

const INSERT =
  "INSERT INTO floor_shift_participation (host_id, device_id, shift_id, max_stations, my_state, " +
  "participants, totals, by_device, as_of, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)";
const TOTALS = '{"accepted":5,"boxesClosed":0,"pallets":0,"asOf":"2026-10-08T09:41:07Z"}';

describe("migration 0021 over a database of 0020 (plan 2b, the station's participation cache)", () => {
  it("adds an empty cache that keeps the host's figures whole and refuses what the host never sends", () => {
    const db = new DatabaseSync(":memory:");
    migrate(db, "0001", "0020_zzz");
    migrate(db, "0021", "0021_zzz");
    expect(db.prepare("SELECT count(*) AS n FROM floor_shift_participation").get()).toEqual({
      n: 0,
    });
    const columns = db
      .prepare(
        "SELECT name, \"notnull\" AS required, pk FROM pragma_table_info('floor_shift_participation') ORDER BY cid",
      )
      .all()
      .map((row) => ({ ...row }));
    expect(columns).toEqual([
      { name: "host_id", required: 1, pk: 1 },
      { name: "device_id", required: 1, pk: 2 },
      { name: "shift_id", required: 1, pk: 3 },
      { name: "max_stations", required: 1, pk: 0 },
      { name: "my_state", required: 0, pk: 0 },
      { name: "participants", required: 1, pk: 0 },
      { name: "totals", required: 1, pk: 0 },
      { name: "by_device", required: 1, pk: 0 },
      { name: "as_of", required: 1, pk: 0 },
      { name: "seen_at", required: 1, pk: 0 },
      { name: "leave_requested_at", required: 0, pk: 0 },
    ]);
    const insert = db.prepare(INSERT);
    insert.run(HOST_ID, DEVICE_ID, "s1", 2, "active", "[]", TOTALS, "[]", "2026-10-08T09:41:07Z");
    insert.run(HOST_ID, DEVICE_ID, "s2", 1, null, "[]", TOTALS, "[]", "2026-10-08T09:41:07Z");
    expect(() =>
      insert.run(HOST_ID, DEVICE_ID, "s3", 17, null, "[]", TOTALS, "[]", "2026-10-08T09:41:07Z"),
    ).toThrow(/CHECK/);
    expect(() =>
      insert.run(HOST_ID, DEVICE_ID, "s4", 2, "paused", "[]", TOTALS, "[]", "2026-10-08T09:41:07Z"),
    ).toThrow(/CHECK/);
    expect(() =>
      insert.run(HOST_ID, DEVICE_ID, "s5", 2, null, "{}", TOTALS, "[]", "2026-10-08T09:41:07Z"),
    ).toThrow(/CHECK/);
    expect(() =>
      insert.run(HOST_ID, DEVICE_ID, "s6", 2, null, "[]", "[]", "[]", "2026-10-08T09:41:07Z"),
    ).toThrow(/CHECK/);
    expect(() =>
      insert.run(HOST_ID, DEVICE_ID, "s1", 2, null, "[]", TOTALS, "[]", "2026-10-08T09:41:07Z"),
    ).toThrow(/UNIQUE|PRIMARY/);
    // No foreign key, as every table of the station (`0006`).
    expect(
      db
        .prepare("SELECT count(*) AS n FROM pragma_foreign_key_list('floor_shift_participation')")
        .get(),
    ).toEqual({ n: 0 });
  });
});
```

In `apps/standalone/test/floor-schema.test.ts:280-296` replace the comment and the list head:

```ts
    // `floor_restore_epochs` (migration `0009`) is a pairing's own
    // bookkeeping that a forget empties, tagged the same way.
    // Installation generation metadata is retained per host, independently of pairing.
    expect(columns).toEqual(
      [...DEVICE_TABLES, ...WAREHOUSE_TABLES, "floor_restore_epochs", "installation_dataset_epochs"]
```

with:

```ts
    // `floor_restore_epochs` (migration `0009`) is a pairing's own
    // bookkeeping that a forget empties, tagged the same way; so is the cache of
    // a shared shift's participants and totals (`floor_shift_participation`,
    // migration `0021`, plan 2b). Installation generation metadata is retained
    // per host, independently of pairing.
    expect(columns).toEqual(
      [
        ...DEVICE_TABLES,
        ...WAREHOUSE_TABLES,
        "floor_restore_epochs",
        "floor_shift_participation",
        "installation_dataset_epochs",
      ]
```

In `apps/standalone/src-tauri/tests/local_db.rs`:

(a) In the table list of `opening_creates_the_reference_tables_in_wal_mode_and_keeps_data` replace

```rust
            "floor_scans",
            "floor_shifts",
            "floor_sign_in_failures",
```

with

```rust
            "floor_scans",
            "floor_shift_participation",
            "floor_shifts",
            "floor_sign_in_failures",
```

(b) In `without_0016` add, after `.filter(|row| row["tbl_name"] != "installation_dataset_epochs")`:

```rust
        .filter(|row| row["tbl_name"] != "floor_shift_participation")
```

and replace its doc's last line (the sentence on the native generation table of `0020`) with:

```rust
/// The independent native generation table of `0020` is pinned by the dataset tests, and the
/// participation cache of `0021` (plan 2b) by `the_participation_cache_takes_a_newer_read_only`.
```

(c) In the forget test's seeds, after the `floor_restore_epochs` statement (`:1886-1891`), add:

```rust
        // What the host's list said of a shared shift (plan 2b, `0021`): a copy of the host's
        // figures, emptied with the others.
        statement(
            "INSERT INTO floor_shift_participation (host_id, device_id, shift_id, max_stations, \
             my_state, participants, totals, by_device, as_of, seen_at) VALUES (?, ?, 'shift-1', \
             2, 'active', '[]', ?, '[]', '2026-10-08T09:41:07Z', 1790000000000)",
            json!([
                HOST,
                DEVICE,
                r#"{"accepted":0,"boxesClosed":0,"pallets":0,"asOf":"2026-10-08T09:41:07Z"}"#
            ]),
        ),
```

(d) Append at the end of the file:

```rust
/// The webview's upsert of a shared shift's participation (plan 2b, migration `0021`,
/// `UPSERT_PARTICIPATION_SQL` in `src/floor/shifts/shift-participation.ts`, which
/// `test/floor-shift-participation.test.ts` finds in this file): `->` and `->>` chained on the
/// shell's bundled SQLite, a shift without the fields kept out, and an older read never over a
/// newer one.
const UPSERT_PARTICIPATION: &str = "INSERT INTO floor_shift_participation (host_id, device_id, \
    shift_id, max_stations, my_state, participants, totals, by_device, as_of, seen_at) SELECT ?, ?, \
    value ->> 'id', value ->> 'maxStations', value ->> 'myState', value -> 'participants', \
    value -> 'totals', value -> 'byDevice', value -> 'totals' ->> 'asOf', ? FROM json_each(?) \
    WHERE value ->> 'maxStations' IS NOT NULL AND value -> 'participants' IS NOT NULL \
    AND value -> 'totals' IS NOT NULL AND value -> 'byDevice' IS NOT NULL \
    ON CONFLICT (host_id, device_id, shift_id) DO UPDATE SET max_stations = excluded.max_stations, \
    my_state = excluded.my_state, participants = excluded.participants, totals = excluded.totals, \
    by_device = excluded.by_device, as_of = excluded.as_of, seen_at = excluded.seen_at \
    WHERE excluded.as_of >= floor_shift_participation.as_of \
    OR excluded.seen_at >= floor_shift_participation.seen_at + 60000";

#[tokio::test]
async fn the_participation_cache_takes_a_newer_read_only() {
    let (_dir, db) = open().await;
    let list = |as_of: &str, accepted: u32| {
        json!([
            {
                "id": "shift-1",
                "maxStations": 2,
                "myState": "active",
                "participants": [],
                "totals": { "accepted": accepted, "boxesClosed": 0, "pallets": 0, "asOf": as_of },
                "byDevice": []
            },
            { "id": "planned-1" }
        ])
        .to_string()
    };
    for (seen, as_of, accepted) in [
        (1, "2026-10-08T09:41:07Z", 5),
        (2, "2026-10-08T09:40:00Z", 3),
    ] {
        db.transaction(vec![statement(
            UPSERT_PARTICIPATION,
            json!(["host", "device", seen, list(as_of, accepted)]),
        )])
        .await
        .unwrap();
    }
    let rows = db
        .query(
            "SELECT shift_id, max_stations, my_state, totals ->> 'accepted' AS accepted, as_of, \
             seen_at FROM floor_shift_participation",
            vec![],
        )
        .await
        .unwrap();
    assert_eq!(
        Value::Array(rows.into_iter().map(Value::Object).collect()),
        json!([{
            "shift_id": "shift-1",
            "max_stations": 2,
            "my_state": "active",
            "accepted": 5,
            "as_of": "2026-10-08T09:41:07Z",
            "seen_at": 1
        }])
    );
    assert_eq!(
        table_class("floor_shift_participation"),
        Some(TableClass::Disposable)
    );
}
```

- [ ] **Step 3: Run them to verify they fail.**

Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-shift-participation-migration.test.ts test/floor-schema.test.ts`
Expected: FAIL — `no such table: floor_shift_participation`; the column list lacks the table.
Run: `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-standalone --test local_db participation opening_creates`
Expected: FAIL — `no such table: floor_shift_participation` / the table list differs.

- [ ] **Step 4: Implement.**

Create `apps/standalone/src-tauri/migrations/0021_floor_shift_participation.sql`:

```sql
-- Plan 2b (several devices in one shift), the station's part: what the host's
-- list (`GET /v1/device/shifts`) and the answers of an entry and a leave say of
-- a shift several devices may work — the line's limit, every participant, this
-- station's own state, the whole shift's totals and each device's part — as the
-- last read saw it, one row per shift of the pairing; and this station's own
-- pending pause («Выйти из смены» while the host was away, or not yet answered).
--
-- A cache of the host's figures, never recalculated here: a read whose `as_of`
-- (the host's time of the read, `totals.asOf`) is older than the row's replaces
-- nothing, so two overlapping refreshes never take the figures back — unless
-- this computer saw the row more than a minute before (`seen_at`), so a host
-- clock set back cannot freeze the figures. The
-- station's own counts stay in `floor_codes` and `floor_boxes`; the screens add
-- them to the others' part (`sharedCount`). A planned shift and a host before
-- protocol 7 carry none of these fields: no row, and the floor is stage 2a's.
--
-- `TableClass::Disposable`: a forget empties it with the copies (the next pairing
-- reads its own), and every list read deletes the rows of shifts the pairing no
-- longer keeps. The JSON columns hold the host's arrays and object as sent.
-- `as_of` is the host's instant, `leave_requested_at` this computer's
-- (`Date.toISOString`), `seen_at` Unix milliseconds of this computer, as
-- `floor_shifts.seen_at`. No foreign key (see `0006`).
CREATE TABLE floor_shift_participation (
  host_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  shift_id TEXT NOT NULL,
  max_stations INTEGER NOT NULL CHECK (max_stations BETWEEN 1 AND 16),
  my_state TEXT CHECK (my_state IS NULL OR my_state IN ('active', 'left', 'closed')),
  participants TEXT NOT NULL
    CHECK (json_valid(participants) AND json_type(participants) = 'array'),
  totals TEXT NOT NULL CHECK (json_valid(totals) AND json_type(totals) = 'object'),
  by_device TEXT NOT NULL CHECK (json_valid(by_device) AND json_type(by_device) = 'array'),
  as_of TEXT NOT NULL,
  seen_at INTEGER NOT NULL,
  leave_requested_at TEXT,
  PRIMARY KEY (host_id, device_id, shift_id)
);
```

In `apps/standalone/src-tauri/src/local_db.rs`, `TABLE_CLASSES`, after `("floor_scans", TableClass::DeviceData),`:

```rust
    // A shared shift's participants and totals as the host's last read said them (plan 2b,
    // migration `0021`): a copy of the host's figures, emptied by a forget.
    ("floor_shift_participation", TableClass::Disposable),
```

- [ ] **Step 5: Run the tests to verify they pass.**

Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-shift-participation-migration.test.ts test/floor-schema.test.ts test/floor-conflict-notices-migration.test.ts test/floor-shift-planned-date-migration.test.ts`
Expected: PASS.
Run: `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-standalone --test local_db`
Expected: PASS (the whole file: table list, forget classes, `without_0016` comparisons, the new test). Then `cargo fmt --manifest-path "$WT/apps/standalone/Cargo.toml" --all -- --check` — clean.

- [ ] **Step 6: Commit.**

```bash
git -C "$WT" add apps/standalone/src-tauri/migrations/0021_floor_shift_participation.sql \
  apps/standalone/src-tauri/src/local_db.rs apps/standalone/src-tauri/tests/local_db.rs \
  apps/standalone/test/floor-shift-participation-migration.test.ts apps/standalone/test/floor-schema.test.ts
git -C "$WT" commit -m "feat(standalone): station migration 0021 — the cache of a shared shift's participants and totals

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The participation store — written by every list and entry, read by the floor

**Files:**

- Create: `apps/standalone/src/floor/shifts/shift-participation.ts`
- Modify: `apps/standalone/src/floor/shifts/shift-copies.ts:1-19` (imports), `:181-199` (`replaceShiftCopies`), `:213-248` (`keepEnteredShift`)
- Create test support: `apps/standalone/test/support/multi-station.ts`
- Test: `apps/standalone/test/floor-shift-participation.test.ts` (new)

**Interfaces:**

- Consumes: Task 2's table; host plan's `deviceShiftSchema`, `enteredShiftSchema`, `shiftParticipantSchema`, `deviceShiftTotalsSchema`, `deviceTotalsSchema`, `maxStationsSchema`, `participantStateSchema` and their types.
- Produces (`src/floor/shifts/shift-participation.ts`):
  - `interface Participation { shiftId: string; maxStations: number; myState: ParticipantState | null; participants: ShiftParticipant[]; totals: DeviceShiftTotals; byDevice: DeviceTotals[]; asOf: string; leaveRequestedAt: string | null }`
  - `UPSERT_PARTICIPATION_SQL`, `DROP_ORPHAN_PARTICIPATION_SQL`, `CLEAR_LEAVE_SQL` (string constants)
  - `participationStatement(pairing: Pairing, shifts: readonly DeviceShift[], seenAt: number): LocalStatement`
  - `dropOrphanParticipationStatement(pairing: Pairing): LocalStatement`
  - `clearLeaveStatement(pairing: Pairing, shiftId: string): LocalStatement`
  - `readParticipations(local: LocalExecutor, pairing: Pairing): Promise<Map<string, Participation>>`
  - `readParticipation(local: LocalExecutor, pairing: Pairing, shiftId: string): Promise<Participation | null>`
  - `participationFromShift(shift: DeviceShift): Participation | null`
  - `sharedParticipation(participation: Participation | null): Participation | null`
  - `activeOthers(participation: Participation, deviceId: string): ShiftParticipant[]`
  - `closesShift(participation: Participation, deviceId: string): boolean`
  - `participantsEver(participation: Participation | null): number`
  - `interface SharedCount { mine: number; total: number; asOf: string }`; `sharedCount(participation: Participation, deviceId: string, mine: number): SharedCount`
- Produces (`test/support/multi-station.ts`): `OTHER_STATION`, `THIRD_STATION`, `HANDHELD`, `SHARED: DeviceShift`, `SHARED_ENTERED: EnteredShift`, `STATION_ROW: ShiftParticipant`, `participant(deviceId, name, state, kind?)`, `sharedShift(input)`, `enteredOf(shift)`.

- [ ] **Step 1: Write the test support.** Create `apps/standalone/test/support/multi-station.ts`:

```ts
import {
  deviceShiftSchema,
  deviceShiftsSchema,
  enteredShiftSchema,
  type DeviceShift,
  type EnteredShift,
  type ShiftParticipant,
} from "../../src/host/protocol.js";
import { fixture } from "./proto-fixture.js";

/** Another station of the line, a third one, and the handheld of the host's fixture. */
export const OTHER_STATION = "0e2b1f7a-6c1d-4b8e-9f3a-2d4c5b6a7e8f";
export const THIRD_STATION = "1f3c2e4d-5a6b-4c7d-8e9f-a0b1c2d3e4f5";
export const HANDHELD = "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d";

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`the fixture has no ${what}`);
  return value;
}

/**
 * The host's shared shift (`device-shifts-participants.json`): this station (`DEVICE_ID`) active
 * with 427 accepted, the handheld closed with 120, two to the line, 547 in all at 09:41:07Z.
 * Same id, number and product as `device-shift-entered.json`.
 */
export const SHARED: DeviceShift = must(
  deviceShiftsSchema.parse(fixture("device-shifts-participants.json")).shifts[0],
  "shared shift",
);
const ENTERED = enteredShiftSchema.parse(fixture("device-shift-entered.json"));

/** `shift` as the answer of an entry: the same fields and `device-shift-entered.json`'s snapshot. */
export function enteredOf(shift: DeviceShift): EnteredShift {
  return enteredShiftSchema.parse({ ...shift, snapshot: ENTERED.snapshot });
}

/** The shared shift entered by this station. */
export const SHARED_ENTERED: EnteredShift = enteredOf(SHARED);

/** This station's row of the fixture: the model of every participant row below. */
export const STATION_ROW: ShiftParticipant = must(SHARED.participants?.[0], "station row");

/** A participant row of `deviceId` in `state`. */
export function participant(
  deviceId: string,
  deviceName: string,
  state: ShiftParticipant["state"],
  deviceKind: ShiftParticipant["deviceKind"] = "station",
): ShiftParticipant {
  return {
    ...STATION_ROW,
    deviceId,
    deviceName,
    deviceKind,
    state,
    leftAt: state === "left" ? "2026-10-08T08:00:00Z" : null,
    closedAt: state === "closed" ? "2026-10-08T09:00:00Z" : null,
    closedBy: state === "closed" ? "device" : null,
  };
}

/**
 * The shared shift with `participants` and their accepted units (the totals add them up, at
 * `asOf`), `maxStations` to the line (2 by default) and this station's `myState` (left out when
 * `null` or absent: it never entered).
 */
export function sharedShift(input: {
  participants: readonly { row: ShiftParticipant; accepted: number }[];
  maxStations?: number;
  myState?: ShiftParticipant["state"] | null;
  asOf?: string;
  ownerDeviceId?: string;
  plannedQty?: number | null;
}): DeviceShift {
  const accepted = input.participants.reduce((sum, part) => sum + part.accepted, 0);
  const shift = deviceShiftSchema.parse({
    ...SHARED,
    ownerDeviceId: input.ownerDeviceId ?? SHARED.ownerDeviceId,
    plannedQty: input.plannedQty === undefined ? SHARED.plannedQty : input.plannedQty,
    maxStations: input.maxStations ?? 2,
    participants: input.participants.map((part) => part.row),
    totals: {
      accepted,
      boxesClosed: 0,
      pallets: 0,
      asOf: input.asOf ?? "2026-10-08T09:41:07Z",
    },
    byDevice: input.participants.map((part) => ({
      deviceId: part.row.deviceId,
      accepted: part.accepted,
      boxesClosed: 0,
      pallets: 0,
    })),
  });
  if (input.myState === undefined || input.myState === null) delete shift.myState;
  else shift.myState = input.myState;
  return shift;
}
```

- [ ] **Step 2: Write the failing test.** Create `apps/standalone/test/floor-shift-participation.test.ts`:

```ts
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { keepEnteredShift, replaceShiftCopies } from "../src/floor/shifts/shift-copies.js";
import {
  activeOthers,
  closesShift,
  participantsEver,
  participationFromShift,
  readParticipation,
  readParticipations,
  sharedCount,
  sharedParticipation,
  UPSERT_PARTICIPATION_SQL,
} from "../src/floor/shifts/shift-participation.js";
import { deviceShiftsSchema } from "../src/host/protocol.js";
import { DEVICE_ID, HOST_ID } from "./support/fixtures.js";
import { openLocalDb } from "./support/local-db.js";
import {
  HANDHELD,
  OTHER_STATION,
  participant,
  SHARED,
  SHARED_ENTERED,
  sharedShift,
  STATION_ROW,
} from "./support/multi-station.js";
import { fixture } from "./support/proto-fixture.js";

const PAIRING = { hostId: HOST_ID, deviceId: DEVICE_ID };
const SEEN = 1_790_000_000_000;
const testModuleUrl = import.meta.url;

describe("the participation cache (plan 2b, migration 0021)", () => {
  it("keeps what the host's list says of a shared shift and reads it back as sent", async () => {
    const { executor } = openLocalDb();
    await replaceShiftCopies(executor, PAIRING, [SHARED], SEEN);
    const read = await readParticipation(executor, PAIRING, SHARED.id);
    expect(read).toEqual(participationFromShift(SHARED));
    expect(read).toMatchObject({
      maxStations: 2,
      myState: "active",
      asOf: "2026-10-08T09:41:07Z",
      leaveRequestedAt: null,
    });
    expect(read?.participants.map((row) => row.deviceId)).toEqual([DEVICE_ID, HANDHELD]);
  });

  it("keeps nothing of a planned shift or of a host before protocol 7", async () => {
    const { executor } = openLocalDb();
    const old = deviceShiftsSchema.parse(fixture("device-shifts.json")).shifts;
    await replaceShiftCopies(executor, PAIRING, old, SEEN);
    expect((await readParticipations(executor, PAIRING)).size).toBe(0);
    expect(participationFromShift(old[0] ?? SHARED)).toBeNull();
  });

  it("never takes an older read over a newer one, and takes a newer one", async () => {
    const { executor } = openLocalDb();
    await replaceShiftCopies(executor, PAIRING, [SHARED], SEEN);
    const older = sharedShift({
      participants: [{ row: STATION_ROW, accepted: 1 }],
      asOf: "2026-10-08T09:40:00Z",
      myState: "active",
    });
    await replaceShiftCopies(executor, PAIRING, [older], SEEN + 1);
    expect((await readParticipation(executor, PAIRING, SHARED.id))?.totals.accepted).toBe(547);
    const newer = sharedShift({
      participants: [{ row: STATION_ROW, accepted: 600 }],
      asOf: "2026-10-08T09:42:00Z",
      myState: "active",
    });
    await replaceShiftCopies(executor, PAIRING, [newer], SEEN + 2);
    expect(await readParticipation(executor, PAIRING, SHARED.id)).toMatchObject({
      asOf: "2026-10-08T09:42:00Z",
      totals: { accepted: 600 },
    });
    // A host clock set back cannot freeze the figures: a read a minute later by this computer's
    // clock is taken whatever its `asOf`.
    const setBack = sharedShift({
      participants: [{ row: STATION_ROW, accepted: 7 }],
      asOf: "2026-10-08T08:00:00Z",
      myState: "active",
    });
    await replaceShiftCopies(executor, PAIRING, [setBack], SEEN + 2 + 60_000);
    expect(await readParticipation(executor, PAIRING, SHARED.id)).toMatchObject({
      asOf: "2026-10-08T08:00:00Z",
      totals: { accepted: 7 },
    });
  });

  it("drops the figures of a shift the station no longer keeps", async () => {
    const { executor } = openLocalDb();
    const joinable = sharedShift({
      participants: [{ row: participant(OTHER_STATION, "Станция линии 2", "active"), accepted: 9 }],
      ownerDeviceId: OTHER_STATION,
    });
    await replaceShiftCopies(executor, PAIRING, [joinable], SEEN);
    expect((await readParticipations(executor, PAIRING)).size).toBe(1);
    await replaceShiftCopies(executor, PAIRING, [], SEEN + 1);
    expect((await readParticipations(executor, PAIRING)).size).toBe(0);
  });

  it("takes an entry's figures and drops a pause the station asked for, so a late pause never undoes it", async () => {
    const { db, executor } = openLocalDb();
    await keepEnteredShift(executor, PAIRING, SHARED_ENTERED, "2026-10-08T06:02:00.000Z", SEEN);
    db.prepare("UPDATE floor_shift_participation SET leave_requested_at = ?").run(
      "2026-10-08T10:00:00.000Z",
    );
    expect((await readParticipation(executor, PAIRING, SHARED.id))?.leaveRequestedAt).toBe(
      "2026-10-08T10:00:00.000Z",
    );
    await keepEnteredShift(executor, PAIRING, SHARED_ENTERED, "2026-10-08T10:01:00.000Z", SEEN + 1);
    expect(await readParticipation(executor, PAIRING, SHARED.id)).toMatchObject({
      myState: "active",
      leaveRequestedAt: null,
    });
  });

  it("reads an unreadable row as none, never as a guess", async () => {
    const { db, executor } = openLocalDb();
    await replaceShiftCopies(executor, PAIRING, [SHARED], SEEN);
    db.prepare("UPDATE floor_shift_participation SET participants = '[{\"deviceId\":1}]'").run();
    expect(await readParticipation(executor, PAIRING, SHARED.id)).toBeNull();
    expect((await readParticipations(executor, PAIRING)).size).toBe(0);
  });

  it("derives who works the shift, whether this close is the last, and the whole shift's count", () => {
    const shared = participationFromShift(SHARED);
    expect(shared).not.toBeNull();
    if (shared === null) return;
    expect(sharedParticipation(shared)).toBe(shared);
    expect(activeOthers(shared, DEVICE_ID)).toEqual([]);
    expect(closesShift(shared, DEVICE_ID)).toBe(true);
    expect(participantsEver(shared)).toBe(2);
    // The others' part by the host (547 − 427) and this station's own 430 codes.
    expect(sharedCount(shared, DEVICE_ID, 430)).toEqual({
      mine: 430,
      total: 550,
      asOf: "2026-10-08T09:41:07Z",
    });
    const busy = participationFromShift(
      sharedShift({
        participants: [
          { row: STATION_ROW, accepted: 5 },
          { row: participant(OTHER_STATION, "Станция линии 2", "active"), accepted: 7 },
        ],
        myState: "active",
      }),
    );
    expect(busy === null ? null : closesShift(busy, DEVICE_ID)).toBe(false);
    expect(busy === null ? [] : activeOthers(busy, DEVICE_ID).map((row) => row.deviceId)).toEqual([
      OTHER_STATION,
    ]);
    // A line of one with this station alone is no shared shift (stage 2a's floor).
    const solo = participationFromShift(
      sharedShift({
        participants: [{ row: STATION_ROW, accepted: 5 }],
        maxStations: 1,
        myState: "active",
      }),
    );
    expect(sharedParticipation(solo)).toBeNull();
    expect(participantsEver(null)).toBe(1);
  });

  it("is the very statement the shell's own SQLite runs in src-tauri/tests/local_db.rs", () => {
    const source = readFileSync(new URL("../src-tauri/tests/local_db.rs", testModuleUrl), "utf8")
      // A line continuation of a Rust string drops the newline and the next line's indent.
      .replace(/\\\n\s*/g, "");
    expect(source).toContain(UPSERT_PARTICIPATION_SQL);
  });
});
```

- [ ] **Step 3: Run it to verify it fails.**

Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-shift-participation.test.ts`
Expected: FAIL — `Failed to resolve import "../src/floor/shifts/shift-participation.js"`.

- [ ] **Step 4: Implement the store.** Create `apps/standalone/src/floor/shifts/shift-participation.ts`:

```ts
import { z } from "zod";

import {
  deviceShiftTotalsSchema,
  deviceTotalsSchema,
  maxStationsSchema,
  participantStateSchema,
  shiftParticipantSchema,
  type DeviceShift,
  type DeviceShiftTotals,
  type DeviceTotals,
  type ParticipantState,
  type ShiftParticipant,
} from "../../host/protocol.js";
import type { LocalExecutor, LocalStatement } from "../../local/executor.js";
import type { Pairing } from "../../local/reference-sync.js";

/**
 * A shift several devices may work, as the host's last read of it said (plan 2b, migration
 * `0021`): the line's limit, every device that entered it (first entry first), this station's own
 * state (`null`: it never entered), the whole shift's totals and each device's part at `asOf`, the
 * host's time; and the pause this station asked for and the host has not answered yet.
 */
export interface Participation {
  shiftId: string;
  maxStations: number;
  myState: ParticipantState | null;
  participants: ShiftParticipant[];
  totals: DeviceShiftTotals;
  byDevice: DeviceTotals[];
  asOf: string;
  leaveRequestedAt: string | null;
}

/**
 * The host's figures of every shift in the JSON array parameter that carries them (an open or
 * closed shift of a host of protocol 7), as this pairing's: a read older than the stored one
 * (`as_of`) changes nothing, so two overlapping refreshes never take the figures back, unless this
 * computer saw the stored one more than a minute before (`seen_at`: a host clock set back must
 * not freeze the figures); the
 * station's own pause (`leave_requested_at`) is never touched. Parameters: host id, device id,
 * seen at, the array. Pinned with this exact text on the shell's SQLite in
 * `src-tauri/tests/local_db.rs`.
 */
export const UPSERT_PARTICIPATION_SQL =
  "INSERT INTO floor_shift_participation (host_id, device_id, shift_id, max_stations, my_state, " +
  "participants, totals, by_device, as_of, seen_at) SELECT ?, ?, value ->> 'id', " +
  "value ->> 'maxStations', value ->> 'myState', value -> 'participants', value -> 'totals', " +
  "value -> 'byDevice', value -> 'totals' ->> 'asOf', ? FROM json_each(?) " +
  "WHERE value ->> 'maxStations' IS NOT NULL AND value -> 'participants' IS NOT NULL " +
  "AND value -> 'totals' IS NOT NULL AND value -> 'byDevice' IS NOT NULL " +
  "ON CONFLICT (host_id, device_id, shift_id) DO UPDATE SET max_stations = excluded.max_stations, " +
  "my_state = excluded.my_state, participants = excluded.participants, totals = excluded.totals, " +
  "by_device = excluded.by_device, as_of = excluded.as_of, seen_at = excluded.seen_at " +
  "WHERE excluded.as_of >= floor_shift_participation.as_of " +
  "OR excluded.seen_at >= floor_shift_participation.seen_at + 60000";

/**
 * The figures of shifts this pairing no longer keeps a copy of (a list dropped them, the
 * retention purged them). Parameters: host id, device id, host id, device id.
 */
export const DROP_ORPHAN_PARTICIPATION_SQL =
  "DELETE FROM floor_shift_participation WHERE host_id = ? AND device_id = ? AND shift_id NOT IN " +
  "(SELECT id FROM floor_shifts WHERE host_id = ? AND device_id = ?)";

/**
 * An entry drops the pause this station asked for (host D5): a late pause must never undo the
 * entry. Parameters: host id, device id, shift id.
 */
export const CLEAR_LEAVE_SQL =
  "UPDATE floor_shift_participation SET leave_requested_at = NULL " +
  "WHERE host_id = ? AND device_id = ? AND shift_id = ?";

export function participationStatement(
  pairing: Pairing,
  shifts: readonly DeviceShift[],
  seenAt: number,
): LocalStatement {
  return {
    sql: UPSERT_PARTICIPATION_SQL,
    values: [pairing.hostId, pairing.deviceId, seenAt, JSON.stringify(shifts)],
  };
}

export function dropOrphanParticipationStatement(pairing: Pairing): LocalStatement {
  return {
    sql: DROP_ORPHAN_PARTICIPATION_SQL,
    values: [pairing.hostId, pairing.deviceId, pairing.hostId, pairing.deviceId],
  };
}

export function clearLeaveStatement(pairing: Pairing, shiftId: string): LocalStatement {
  return { sql: CLEAR_LEAVE_SQL, values: [pairing.hostId, pairing.deviceId, shiftId] };
}

const COLUMNS =
  "shift_id, max_stations, my_state, participants, totals, by_device, as_of, leave_requested_at";

const rowSchema = z.object({
  shift_id: z.string(),
  max_stations: z.number().int(),
  my_state: z.string().nullable(),
  participants: z.string(),
  totals: z.string(),
  by_device: z.string(),
  as_of: z.string(),
  leave_requested_at: z.string().nullable(),
});

const storedSchema = z.object({
  maxStations: maxStationsSchema,
  myState: participantStateSchema.nullable(),
  participants: z.array(shiftParticipantSchema),
  totals: deviceShiftTotalsSchema,
  byDevice: z.array(deviceTotalsSchema),
});

/** A stored row as the floor reads it; a row this build cannot read is none, never a guess. */
function toParticipation(row: z.infer<typeof rowSchema>): Participation | null {
  let participants: unknown;
  let totals: unknown;
  let byDevice: unknown;
  try {
    participants = JSON.parse(row.participants);
    totals = JSON.parse(row.totals);
    byDevice = JSON.parse(row.by_device);
  } catch {
    return null;
  }
  const parsed = storedSchema.safeParse({
    maxStations: row.max_stations,
    myState: row.my_state,
    participants,
    totals,
    byDevice,
  });
  if (!parsed.success) return null;
  return {
    shiftId: row.shift_id,
    ...parsed.data,
    asOf: row.as_of,
    leaveRequestedAt: row.leave_requested_at,
  };
}

/** Every shift's figures this pairing keeps, by shift id (the hub's cards). */
export async function readParticipations(
  local: LocalExecutor,
  pairing: Pairing,
): Promise<Map<string, Participation>> {
  const rows = await local.query(
    `SELECT ${COLUMNS} FROM floor_shift_participation WHERE host_id = ? AND device_id = ?`,
    [pairing.hostId, pairing.deviceId],
    rowSchema,
  );
  const read = new Map<string, Participation>();
  for (const row of rows) {
    const participation = toParticipation(row);
    if (participation !== null) read.set(participation.shiftId, participation);
  }
  return read;
}

/** One shift's figures, or `null` (none kept, or unreadable). */
export async function readParticipation(
  local: LocalExecutor,
  pairing: Pairing,
  shiftId: string,
): Promise<Participation | null> {
  const [row] = await local.query(
    `SELECT ${COLUMNS} FROM floor_shift_participation ` +
      "WHERE host_id = ? AND device_id = ? AND shift_id = ?",
    [pairing.hostId, pairing.deviceId, shiftId],
    rowSchema,
  );
  return row === undefined ? null : toParticipation(row);
}

/** A host answer's figures as the cache would read them; `null` for a shift that carries none. */
export function participationFromShift(shift: DeviceShift): Participation | null {
  const { maxStations, participants, totals, byDevice } = shift;
  if (
    maxStations === undefined ||
    participants === undefined ||
    totals === undefined ||
    byDevice === undefined
  ) {
    return null;
  }
  return {
    shiftId: shift.id,
    maxStations,
    myState: shift.myState ?? null,
    participants,
    totals,
    byDevice,
    asOf: totals.asOf,
    leaveRequestedAt: null,
  };
}

/**
 * The participation of a shift several devices may work (a line of more than one, or more than
 * one participant ever), else `null`: a station alone on a line of one sees stage 2a's floor.
 */
export function sharedParticipation(participation: Participation | null): Participation | null {
  if (participation === null) return null;
  return participation.maxStations > 1 || participation.participants.length > 1
    ? participation
    : null;
}

/** The other devices that hold a slot now (`active`), as the cache saw them. */
export function activeOthers(participation: Participation, deviceId: string): ShiftParticipant[] {
  return participation.participants.filter(
    (row) => row.state === "active" && row.deviceId !== deviceId,
  );
}

/** By the cache, no other participant stays active or left: this station's close closes the shift. */
export function closesShift(participation: Participation, deviceId: string): boolean {
  return participation.participants.every(
    (row) => row.deviceId === deviceId || row.state === "closed",
  );
}

/** Every participant the shift had by the cache, this station counted (at least 1). */
export function participantsEver(participation: Participation | null): number {
  return Math.max(1, participation?.participants.length ?? 1);
}

/** «Моя станция: N · Всего в смене: K» and the age of the host's part of K. */
export interface SharedCount {
  mine: number;
  total: number;
  asOf: string;
}

/**
 * The whole shift's count as this station knows it: the others' part by the host
 * (`totals.accepted` less this station's own part on the host) and this station's own `mine`
 * codes, which are never behind its own scans (spec §11 «Расхождение числа»: the host's count wins
 * at the next read).
 */
export function sharedCount(
  participation: Participation,
  deviceId: string,
  mine: number,
): SharedCount {
  const hostMine = participation.byDevice.find((part) => part.deviceId === deviceId)?.accepted ?? 0;
  return {
    mine,
    total: Math.max(0, participation.totals.accepted - hostMine) + mine,
    asOf: participation.asOf,
  };
}
```

- [ ] **Step 5: Write the cache with every list and entry.** In `apps/standalone/src/floor/shifts/shift-copies.ts` add to the imports (after the `../../local/reference-sync.js` import):

```ts
import {
  clearLeaveStatement,
  dropOrphanParticipationStatement,
  participationStatement,
} from "./shift-participation.js";
```

Replace the body of `replaceShiftCopies` (`:194-198`) with:

```ts
const listed = JSON.stringify(shifts);
await local.transaction([
  { sql: DROP_UNLISTED, values: [pairing.hostId, pairing.deviceId, listed] },
  { sql: UPSERT, values: [pairing.hostId, pairing.deviceId, seenAt, listed] },
  // Plan 2b: the host's figures of a shared shift with the copy, in the same transaction, and
  // none of a shift this pairing no longer keeps.
  participationStatement(pairing, shifts, seenAt),
  dropOrphanParticipationStatement(pairing),
]);
```

and extend its doc comment (`:181-187`) with the sentence: «The host's figures of a shift several devices work (plan 2b) go into `floor_shift_participation` in the same transaction (`participationStatement`), an older read never over a newer one, and the figures of a shift no longer kept go.»

Replace the last line of `keepEnteredShift` (`:247`, `await local.transaction([statement]);`) with:

```ts
// Plan 2b: the answer's figures, and no pause left that a late send could turn against this
// entry (host D5).
await local.transaction([
  statement,
  participationStatement(pairing, [fields], seenAt),
  clearLeaveStatement(pairing, shift.id),
]);
```

- [ ] **Step 6: Run the tests to verify they pass.**

Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-shift-participation.test.ts test/floor-shift-list.test.tsx test/floor-app.test.tsx test/host-link-shifts.test.ts test/shift-copies.test.ts`
Expected: PASS. Then typecheck and lint the package — no errors.

- [ ] **Step 7: Commit.**

```bash
git -C "$WT" add apps/standalone/src/floor/shifts/shift-participation.ts apps/standalone/src/floor/shifts/shift-copies.ts \
  apps/standalone/test/support/multi-station.ts apps/standalone/test/floor-shift-participation.test.ts
git -C "$WT" commit -m "feat(standalone): station keeps a shared shift's participants and totals from every list and entry

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The hub card — «Присоединиться», «Линия занята: N из M», who works the shift

**Files:**

- Modify (rewrite): `apps/standalone/src/floor/shifts/ShiftCard.tsx:1-253`
- Modify: `apps/standalone/src/floor/shifts/ShiftHub.tsx:1-13` (imports), `:16-25` (`HubCopies`), `:125-143` (the grid)
- Modify: `apps/standalone/src/floor/shifts/ShiftList.tsx:1-16` (imports), `:110-135` (the read)
- Modify: `apps/standalone/src/floor/shifts/shift-hub.css:564-567` (after `.shift-hub .shift-card__hint`), `:654-720` (`@media (max-height: 700px)`)
- Modify: `apps/standalone/src/i18n/ru.json:1262` (after `"needsLink"` of `floor.shifts`), `:1284-1288` (`floor.shifts.action`)
- Test: `apps/standalone/test/card-action.test.ts` (new describe), `apps/standalone/test/floor-shift-list.test.tsx` (new describe at the end)

**Interfaces:**

- Consumes: Task 3 `Participation`, `readParticipations`, `sharedParticipation`, `sharedCount`, `activeOthers`; test support `sharedShift`, `participant`, `enteredOf`, `SHARED`, `SHARED_ENTERED`, `STATION_ROW`, `OTHER_STATION`, `HANDHELD`.
- Produces:
  - `type CardAction = { kind: "open"; enabled: boolean } | { kind: "continue"; enabled: boolean } | { kind: "join"; enabled: boolean } | { kind: "finish" } | { kind: "busy" } | { kind: "line_full"; active: number; maxStations: number } | { kind: "part_closed" } | { kind: "closing" } | { kind: "blocked"; refusal: LicenseRefusal }`
  - `cardAction(copy: ShiftCopy, deviceId: string, online: boolean, blocked?: LicenseRefusal | null, participation?: Participation | null): CardAction`
  - `ShiftCardProps` gains `deviceId?: string`, `participation?: Participation | null`
  - `HubCopies` (`ready`) gains `participation?: ReadonlyMap<string, Participation>`

- [ ] **Step 1: Write the failing tests.**

Append to `apps/standalone/test/card-action.test.ts` (add the imports at the top of the file):

```ts
import type { ShiftParticipant } from "../src/host/protocol.js";
import {
  participationFromShift,
  type Participation,
} from "../src/floor/shifts/shift-participation.js";
import { HANDHELD, participant, sharedShift } from "./support/multi-station.js";
```

```ts
describe("a shift card's action on a shift several devices work (plan 2b)", () => {
  const working = (deviceId: string, state: ShiftParticipant["state"] = "active") => ({
    row: participant(deviceId, deviceId === DEVICE ? "Эта станция" : "Станция линии 2", state),
    accepted: 10,
  });
  const figures = (
    rows: { row: ShiftParticipant; accepted: number }[],
    maxStations = 2,
    myState: ShiftParticipant["state"] | null = null,
  ): Participation | null =>
    participationFromShift(sharedShift({ participants: rows, maxStations, myState }));
  const active = (patch: Partial<ShiftCopy> = {}) =>
    copy({ status: "active", ownerDeviceId: OTHER, ...patch });

  it("offers to join while a slot is free, needs the link for it, and is no new shift for the license", () => {
    const one = figures([working(OTHER)]);
    expect(cardAction(active(), DEVICE, true, null, one)).toEqual({ kind: "join", enabled: true });
    expect(cardAction(active(), DEVICE, false, null, one)).toEqual({
      kind: "join",
      enabled: false,
    });
    expect(cardAction(active(), DEVICE, true, "license_restricted", one)).toEqual({
      kind: "join",
      enabled: true,
    });
  });

  it("says the line is full when every slot is held by the other devices", () => {
    const full = figures([
      working(OTHER),
      { row: participant(HANDHELD, "ТСД 1", "active", "handheld"), accepted: 3 },
    ]);
    expect(cardAction(active(), DEVICE, true, null, full)).toEqual({
      kind: "line_full",
      active: 2,
      maxStations: 2,
    });
    // A line of one that another station works: full at 1 of 1 (stage 2a's «занята»).
    expect(cardAction(active(), DEVICE, true, null, figures([working(OTHER)], 1))).toEqual({
      kind: "line_full",
      active: 1,
      maxStations: 1,
    });
    // A closed or paused participant holds no slot.
    expect(
      cardAction(
        active(),
        DEVICE,
        true,
        null,
        figures([working(OTHER, "closed"), working(OTHER, "left")]),
      ),
    ).toEqual({ kind: "join", enabled: true });
  });

  it("continues this station's own part, and a paused one while a slot is free", () => {
    const mine = figures([working(DEVICE), working(OTHER)], 2, "active");
    expect(cardAction(active(), DEVICE, false, null, mine)).toEqual({
      kind: "continue",
      enabled: false,
    });
    expect(cardAction(active({ entered: true }), DEVICE, false, null, mine)).toEqual({
      kind: "continue",
      enabled: true,
    });
    const paused = figures([working(DEVICE, "left"), working(OTHER)], 2, "left");
    expect(cardAction(active({ entered: true }), DEVICE, true, null, paused)).toEqual({
      kind: "continue",
      enabled: true,
    });
    const pausedFull = figures(
      [
        working(DEVICE, "left"),
        working(OTHER),
        { row: participant(HANDHELD, "ТСД 1", "active"), accepted: 1 },
      ],
      2,
      "left",
    );
    expect(cardAction(active({ entered: true }), DEVICE, true, null, pausedFull)).toEqual({
      kind: "line_full",
      active: 2,
      maxStations: 2,
    });
  });

  it("offers nothing on a part the host says is closed, and finishes a shift the office closed", () => {
    const closed = figures([working(DEVICE, "closed"), working(OTHER)], 2, "closed");
    expect(cardAction(active(), DEVICE, true, null, closed)).toEqual({ kind: "part_closed" });
    expect(
      cardAction(active({ status: "closed", entered: true }), DEVICE, true, null, closed),
    ).toEqual({ kind: "finish" });
  });

  it("keeps stage 2a's answer without figures: another station's shift is busy", () => {
    expect(cardAction(active(), DEVICE, true, null, null)).toEqual({ kind: "busy" });
  });
});
```

Append to `apps/standalone/test/floor-shift-list.test.tsx` (add to its imports
`import { readParticipation } from "../src/floor/shifts/shift-participation.js";`,
`import { formatQuantity } from "../src/floor/shifts/shift-text.js";` and
`import { enteredOf, HANDHELD, participant, SHARED, SHARED_ENTERED, sharedShift, STATION_ROW } from "./support/multi-station.js";`;
`OTHER_STATION` already exists in the file with the same value):

```ts
describe("the shifts several devices work (plan 2b)", () => {
  const OTHER_ROW = () => participant(OTHER_STATION, "Станция линии 2", "active");
  const joinable = () =>
    sharedShift({
      participants: [{ row: OTHER_ROW(), accepted: 300 }],
      ownerDeviceId: OTHER_STATION,
    });
  const MULTI_ENTRY = {
    supports: ["validation-v1", "validation-dm-duplicate-v1", "multi-station-v1"],
  };

  it("offers to join a shift another station works while a slot is free, and names who works it", async () => {
    const shift = joinable();
    const { executor } = await copiesOf([shift]);
    renderList(executor);
    await screen.findByText(shift.number);
    const joining = card(shift.number);
    expect(within(joining).getByRole("button", { name: "Присоединиться" })).toHaveProperty(
      "disabled",
      false,
    );
    const who = within(joining).getByText("В смене 1 из 2: Станция линии 2 · станция");
    expect(who.getAttribute("title")).toBe("В смене 1 из 2: Станция линии 2 · станция");
    expect(within(joining).queryByRole("button", { name: "Занята другой станцией" })).toBeNull();
  });

  it("joins through the host naming the capability, and keeps the answer's figures", async () => {
    const shift = joinable();
    const { executor } = await copiesOf([shift]);
    const answer = enteredOf(
      sharedShift({
        participants: [
          { row: OTHER_ROW(), accepted: 300 },
          { row: STATION_ROW, accepted: 0 },
        ],
        ownerDeviceId: OTHER_STATION,
        myState: "active",
        asOf: "2026-10-08T09:45:00Z",
      }),
    );
    const enter = vi.fn(async () => answer);
    const { handlers } = renderList(executor, { enter });
    fireEvent.click(await screen.findByRole("button", { name: "Присоединиться" }));
    await waitFor(() => expect(handlers.onEntered).toHaveBeenCalledTimes(1));
    expect(enter).toHaveBeenCalledWith(shift.id, MULTI_ENTRY);
    expect(await readParticipation(executor, PAIRING, shift.id)).toMatchObject({
      myState: "active",
      participants: [{ deviceId: OTHER_STATION }, { deviceId: DEVICE_ID }],
    });
  });

  it("cannot join without the link, and says why", async () => {
    const shift = joinable();
    const { executor } = await copiesOf([shift]);
    renderList(executor, { online: false });
    await screen.findByText(shift.number);
    const joining = card(shift.number);
    expect(within(joining).getByRole("button", { name: "Присоединиться" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(within(joining).getByText("Нужна связь с хостом")).toBeTruthy();
  });

  it("says the line is full, with no action, when every slot is held", async () => {
    const shift = sharedShift({
      participants: [
        { row: OTHER_ROW(), accepted: 300 },
        { row: participant(HANDHELD, "ТСД 1", "active", "handheld"), accepted: 20 },
      ],
      ownerDeviceId: OTHER_STATION,
    });
    const { executor } = await copiesOf([shift]);
    renderList(executor);
    await screen.findByText(shift.number);
    const full = card(shift.number);
    expect(within(full).getByText("Линия занята: 2 из 2")).toBeTruthy();
    expect(
      within(full).getByText("В смене 2 из 2: Станция линии 2 · станция, ТСД 1 · ТСД"),
    ).toBeTruthy();
    expect(within(full).queryAllByRole("button")).toEqual([]);
  });

  it("says this station's part is closed when the host says so, with no action", async () => {
    const shift = sharedShift({
      participants: [
        { row: participant(DEVICE_ID, "Станция линии 1", "closed"), accepted: 40 },
        { row: OTHER_ROW(), accepted: 300 },
      ],
      ownerDeviceId: OTHER_STATION,
      myState: "closed",
    });
    const { executor } = await copiesOf([shift]);
    renderList(executor);
    await screen.findByText(shift.number);
    const closed = card(shift.number);
    expect(
      within(closed).getByText(
        "Ваша часть этой смены закрыта. Смена закроется, когда закроют остальные.",
      ),
    ).toBeTruthy();
    expect(within(closed).queryAllByRole("button")).toEqual([]);
  });

  it("shows a shared shift's progress as the whole shift's, and names this station among who works it", async () => {
    const both = sharedShift({
      participants: [
        { row: STATION_ROW, accepted: 427 },
        { row: OTHER_ROW(), accepted: 120 },
      ],
      myState: "active",
    });
    const { executor } = await copiesOf([both], [enteredOf(both)]);
    renderList(executor);
    await screen.findByText(both.number);
    const mine = card(both.number);
    // The others' part by the host (120) and this station's own codes (none stored here).
    expect(within(mine).getByText(`120 из ${formatQuantity(1200)}`)).toBeTruthy();
    expect(
      within(mine).getByText("В смене 2 из 2: эта станция, Станция линии 2 · станция"),
    ).toBeTruthy();
    expect(within(mine).getByRole("button", { name: "Продолжить" })).toBeTruthy();
  });

  it("keeps a solo station's card as it was on a line of one", async () => {
    const solo = sharedShift({
      participants: [{ row: STATION_ROW, accepted: 5 }],
      maxStations: 1,
      myState: "active",
    });
    const { executor } = await copiesOf([solo], [enteredOf(solo)]);
    renderList(executor);
    await screen.findByText(solo.number);
    expect(within(card(solo.number)).queryByText(/В смене/)).toBeNull();
    expect(within(card(solo.number)).getByRole("button", { name: "Продолжить" })).toBeTruthy();
  });

  it("reads the shared shift of the host's fixture as a card this station continues", async () => {
    const { executor } = await copiesOf([SHARED], [SHARED_ENTERED]);
    renderList(executor);
    await screen.findByText(SHARED.number);
    // The handheld closed its part: only this station works the shift now, so no line names others.
    expect(within(card(SHARED.number)).queryByText(/В смене/)).toBeNull();
  });
});
```

- [ ] **Step 2: Run them to verify they fail.**

Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/card-action.test.ts test/floor-shift-list.test.tsx`
Expected: FAIL — `cardAction` returns `busy`/`continue` where `join`, `line_full`, `part_closed` are expected; «Присоединиться» not found; i18n keys missing.

- [ ] **Step 3: Add the strings.** In `apps/standalone/src/i18n/ru.json`, in `floor.shifts`, replace

```json
      "needsLink": "Нужна связь с хостом",
      "new": "Новая смена",
```

with

```json
      "needsLink": "Нужна связь с хостом",
      "participants": "В смене {{active}} из {{max}}: {{names}}",
      "participant": "{{name}} · {{kind}}",
      "thisStation": "эта станция",
      "deviceKind": {
        "station": "станция",
        "handheld": "ТСД",
        "office": "офис"
      },
      "lineFull": "Линия занята: {{active}} из {{max}}",
      "partClosed": "Ваша часть этой смены закрыта. Смена закроется, когда закроют остальные.",
      "new": "Новая смена",
```

and in `floor.shifts.action` replace

```json
        "busy": "Занята другой станцией",
        "closing": "Закрывается"
      },
      "refused": {
```

with

```json
        "busy": "Занята другой станцией",
        "join": "Присоединиться",
        "closing": "Закрывается"
      },
      "refused": {
```

- [ ] **Step 4: Rewrite the card.** Replace the whole of `apps/standalone/src/floor/shifts/ShiftCard.tsx` with:

```tsx
import { useTranslation } from "react-i18next";

import { Badge, Button, Card, StatusChip, type TagPhase } from "@markiro/ui";

import { shiftProductTitle } from "../../lib/shift-product.js";
import type { LocalExecutor } from "../../local/executor.js";
import type { LicenseRefusal } from "../license.js";
import { Glyph } from "../kit/StatusIcons.js";
import { ProductPanel } from "./ProductPhoto.js";
import type { ShiftCopy } from "./shift-copies.js";
import { activeOthers, type Participation } from "./shift-participation.js";
import { productMonogram } from "./product-accent.js";
import { shiftProgress } from "./hub-layout.js";
import { formatCivilDate, formatQuantity } from "./shift-text.js";

/**
 * What the card offers: open a planned shift, continue this station's own part of an active one,
 * join one another device works while the line has a free slot (plan 2b), finish one the office
 * closed after this station entered it (plan 2a8; no host needed), or nothing — a line whose every
 * slot is held (plan 2b), a part the host says is closed, a shift of a host that names no
 * participants (stage 2a's «занята»), one this station is closing. `enabled` is false where the
 * host is needed and away.
 */
export type CardAction =
  | { kind: "open"; enabled: boolean }
  | { kind: "continue"; enabled: boolean }
  | { kind: "join"; enabled: boolean }
  | { kind: "finish" }
  | { kind: "busy" }
  | { kind: "line_full"; active: number; maxStations: number }
  | { kind: "part_closed" }
  | { kind: "closing" }
  /** A planned shift the site's license does not let open (plan ЛЦ-3): words in place of «Открыть». */
  | { kind: "blocked"; refusal: LicenseRefusal };

/** «Линия занята: N из M» when the other devices hold every slot, by the cache; else `null`. */
function lineFull(participation: Participation, deviceId: string): CardAction | null {
  const active = activeOthers(participation, deviceId).length;
  return active >= participation.maxStations
    ? { kind: "line_full", active, maxStations: participation.maxStations }
    : null;
}

/**
 * The action of `copy` on this station (`deviceId`) with the link `online` or not, and with what
 * the host's last read said of its participants (`participation`, plan 2b; `null`: none — a
 * planned shift, or a host that names none). Opening a planned shift needs the host (it freezes
 * the snapshot); continuing needs it only when this station keeps no snapshot; joining always
 * needs it (the host gives the slot and the snapshot). The license guards openings only (host D17).
 * The slots are counted from the cache: the host's answer decides (it frees a revoked device's
 * slot, which the cache cannot see).
 */
export function cardAction(
  copy: ShiftCopy,
  deviceId: string,
  online: boolean,
  blocked: LicenseRefusal | null = null,
  participation: Participation | null = null,
): CardAction {
  if (copy.localState === "closing") return { kind: "closing" };
  if (copy.status === "closed") return { kind: "finish" };
  if (copy.status === "active") {
    const mine = participation?.myState ?? null;
    if (mine === "closed") return { kind: "part_closed" };
    const resumes = online || copy.entered;
    if (mine === "left") {
      // A paused part takes a slot again: only while one is free.
      return (
        (participation === null ? null : lineFull(participation, deviceId)) ?? {
          kind: "continue",
          enabled: resumes,
        }
      );
    }
    // Never closed by the license: the station's own shift goes on (spec §3.3).
    if (mine === "active" || copy.entered || copy.ownerDeviceId === deviceId) {
      return { kind: "continue", enabled: resumes };
    }
    if (participation === null) return { kind: "busy" };
    return lineFull(participation, deviceId) ?? { kind: "join", enabled: online };
  }
  if (blocked !== null) return { kind: "blocked", refusal: blocked };
  return { kind: "open", enabled: online };
}

const PHASE: Record<"planned" | "active" | "closing" | "office_closed", TagPhase> = {
  planned: "planned",
  active: "active",
  closing: "running",
  // Closed in the office, to be finished here: the done tone, as the board draws it (✓).
  office_closed: "done",
};

export interface ShiftCardProps {
  copy: ShiftCopy;
  /** The host refused this station's close of the shift, with the refusal's code (plan 2a8). */
  refusal?: { code: string | null } | null;
  action: CardAction;
  /** Another entry runs, or this one: every card waits. */
  busy: boolean;
  onAction: () => void;
  /** The station's database, for the product's photo; without it the monogram stands. */
  local?: LocalExecutor;
  /**
   * The codes the progress row counts («Принято N из M»): this station's own, or the whole
   * shift's for a shift several devices work (plan 2b); `null` (the default): no count was read,
   * and the progress row is not drawn.
   */
  accepted?: number | null;
  /** This station's device id: the participants line names it «эта станция» (plan 2b). */
  deviceId?: string;
  /** What the host's last read said of the shift's participants (plan 2b); `null`: none. */
  participation?: Participation | null;
}

/**
 * One shift of the line, as the owner-approved «Смены линии» board draws it (2026-10, kit): the
 * left half is the product's panel the full height of the card, on the kit's one brand gradient
 * (a transparent or unknown photo) or with the photo's own background, the photo fitted whole
 * and the tags (mode, pallets) as chips on it; on the right the status chip and the shift's
 * number, the product's print name, who it is for, the dates and the plan as label and value,
 * the progress where both counters exist locally, and the 84 px action pinned to the bottom.
 * What the standalone adds — a shift that needs the host, one the office closed, a close the
 * host refused, who else works a shared shift and a line whose slots are all held (plan 2b) — is
 * said in the free row above the action; a full line or a closed part has no action.
 */
export function ShiftCard({
  copy,
  refusal = null,
  action,
  busy,
  onAction,
  local,
  accepted = null,
  deviceId = "",
  participation = null,
}: ShiftCardProps) {
  const { t } = useTranslation();
  const phase =
    copy.localState === "closing"
      ? "closing"
      : copy.status === "active"
        ? "active"
        : copy.status === "closed"
          ? "office_closed"
          : "planned";
  const title = shiftProductTitle({ name: copy.productName, printName: copy.productPrintName });
  const takesAction =
    action.kind === "open" || action.kind === "continue" || action.kind === "join";
  const enabled = action.kind === "finish" || (takesAction && action.enabled);
  const needsLink = takesAction && !action.enabled;
  const hasButton =
    action.kind !== "blocked" && action.kind !== "line_full" && action.kind !== "part_closed";
  const progress = shiftProgress({
    plannedQty: copy.plannedQty,
    accepted,
    entered: copy.entered,
  });
  // Who works a shared shift now (plan 2b): said only when another device is among them, so a
  // station alone on its line sees its card as before.
  const working = participation?.participants.filter((row) => row.state === "active") ?? [];
  const participantsLine =
    participation === null || !working.some((row) => row.deviceId !== deviceId)
      ? null
      : t("floor.shifts.participants", {
          active: formatQuantity(working.length),
          max: formatQuantity(participation.maxStations),
          names: working
            .map((row) =>
              row.deviceId === deviceId
                ? t("floor.shifts.thisStation")
                : t("floor.shifts.participant", {
                    name: row.deviceName,
                    kind: t(`floor.shifts.deviceKind.${row.deviceKind}`),
                  }),
            )
            .join(", "),
        });
  return (
    <Card className="shift-card" padding={0} data-phase={phase}>
      <div className="shift-card__body">
        <ProductPanel
          local={local}
          productId={copy.productId}
          className="shift-card__photo"
          faceAlways
          fallback={
            <span className="shift-card__photo-monogram" aria-hidden="true">
              {productMonogram(title)}
            </span>
          }
          overlay={
            <div className="shift-card__tags">
              <Badge
                className="shift-card__mode-badge"
                size="floor"
                tone={copy.mode === "aggregation" ? "violet" : "steel"}
              >
                {t(`floor.shifts.mode.${copy.mode}`)}
              </Badge>
              {copy.mode === "aggregation" && copy.palletsEnabled ? (
                <Badge className="shift-card__pallets" size="floor" tone="teal">
                  {t("floor.shifts.withPallets")}
                </Badge>
              ) : null}
            </div>
          }
        />
        <div className="shift-card__details">
          <div className="shift-card__heading">
            <StatusChip
              className="shift-card__status"
              size="floor"
              phase={PHASE[phase]}
              label={t(`floor.shifts.status.${phase}`)}
            />
            <span className="shift-card__number">{copy.number}</span>
          </div>
          <div className="shift-card__product shift-card__product--only" title={title}>
            {title}
          </div>
          <div
            className="shift-card__counterparty"
            {...(copy.counterpartyName === null
              ? {}
              : { title: t("floor.shifts.counterparty", { name: copy.counterpartyName }) })}
          >
            {copy.counterpartyName === null
              ? null
              : t("floor.shifts.counterparty", { name: copy.counterpartyName })}
          </div>
          <dl className="shift-card__facts">
            <div className="shift-card__fact">
              <dt>{t("floor.shifts.fact.productionDate")}</dt>
              <dd>{formatCivilDate(copy.productionDate)}</dd>
            </div>
            {copy.plannedDate === null ? null : (
              <div className="shift-card__fact">
                <dt>{t("floor.shifts.fact.plannedDate")}</dt>
                <dd>{formatCivilDate(copy.plannedDate)}</dd>
              </div>
            )}
            <div className="shift-card__fact">
              <dt>{t("floor.shifts.fact.plan")}</dt>
              <dd className={copy.plannedQty === null ? "shift-card__plan--none" : undefined}>
                {copy.plannedQty === null
                  ? t("floor.shifts.fact.planNone")
                  : t("floor.shifts.fact.planValue", { quantity: formatQuantity(copy.plannedQty) })}
              </dd>
            </div>
          </dl>
          {progress === null ? null : (
            <div className="shift-card__progress">
              <div className="shift-card__progress-line">
                <span>{t("floor.shifts.progress.label")}</span>
                <span className="shift-card__progress-count">
                  {t("floor.shifts.progress.count", {
                    accepted: formatQuantity(progress.accepted),
                    planned: formatQuantity(progress.planned),
                  })}
                </span>
              </div>
              <div
                className="shift-card__progress-bar"
                role="progressbar"
                aria-label={t("floor.shifts.progress.label")}
                aria-valuemin={0}
                aria-valuemax={progress.planned}
                aria-valuenow={Math.min(progress.accepted, progress.planned)}
                aria-valuetext={t("floor.shifts.progress.count", {
                  accepted: formatQuantity(progress.accepted),
                  planned: formatQuantity(progress.planned),
                })}
              >
                <span style={{ width: `${(progress.ratio * 100).toFixed(1)}%` }} />
              </div>
            </div>
          )}
          <div className="shift-card__notes">
            {participantsLine !== null && (
              <p className="shift-card__participants" title={participantsLine}>
                {participantsLine}
              </p>
            )}
            {needsLink && <p className="shift-card__hint">{t("floor.shifts.needsLink")}</p>}
            {action.kind === "blocked" && (
              // In place of «Открыть» (spec §9.6): the host would refuse, and the operator is told why.
              <p className="shift-card__hint">{t(`floor.shifts.refused.${action.refusal}`)}</p>
            )}
            {action.kind === "line_full" && (
              // In place of an action (plan 2b): the host would refuse with `shift_line_full`.
              <p className="shift-card__hint">
                {t("floor.shifts.lineFull", {
                  active: formatQuantity(action.active),
                  max: formatQuantity(action.maxStations),
                })}
              </p>
            )}
            {action.kind === "part_closed" && (
              <p className="shift-card__hint">{t("floor.shifts.partClosed")}</p>
            )}
            {action.kind === "finish" && (
              <p className="shift-card__hint">{t("floor.shifts.finishHint")}</p>
            )}
            {refusal !== null && (
              <p className="shift-card__hint">
                {t("floor.shifts.closeRefused", { code: refusal.code ?? "—" })}
              </p>
            )}
          </div>
          {hasButton && (
            <Button
              className="shift-card__action floor-primary"
              size="floor"
              fullWidth
              variant={
                action.kind === "continue" || action.kind === "join" ? "primary" : "secondary"
              }
              disabled={busy || !enabled}
              onClick={onAction}
              {...(action.kind === "continue" || action.kind === "join"
                ? { icon: <Glyph name="arrow-right" size={26} /> }
                : action.kind === "finish"
                  ? { icon: <Glyph name="check" size={26} /> }
                  : {})}
            >
              {t(`floor.shifts.action.${action.kind}`)}
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}
```

- [ ] **Step 5: Wire the hub.** In `apps/standalone/src/floor/shifts/ShiftHub.tsx` add
      `import type { Participation } from "./shift-participation.js";` after the `ShiftCopy` import, add
      to the `ready` member of `HubCopies` (after `accepted: Map<string, number>;`):

```ts
      /** What the host's last read said of each shift's participants (plan 2b), by shift id. */
      participation?: ReadonlyMap<string, Participation>;
```

and replace the `<ShiftCard … />` element of the grid (`:128-141`) with:

```tsx
<ShiftCard
  key={copy.id}
  copy={copy}
  {...(local === undefined ? {} : { local })}
  accepted={copies.accepted.get(copy.id) ?? null}
  refusal={
    copies.refused.has(copy.id) && copy.localState === "closing"
      ? { code: copies.refused.get(copy.id) ?? null }
      : null
  }
  deviceId={deviceId}
  participation={copies.participation?.get(copy.id) ?? null}
  action={cardAction(copy, deviceId, online, blocked, copies.participation?.get(copy.id) ?? null)}
  busy={busy}
  onAction={() => onChoose(copy)}
/>
```

In `apps/standalone/src/floor/shifts/ShiftList.tsx` add the imports

```ts
import {
  readParticipations,
  sharedCount,
  sharedParticipation,
  type Participation,
} from "./shift-participation.js";
```

and replace the read effect's chain (`:113-131`) with:

```ts
Promise.all([
  readShiftCopies(local, pairing, lineId),
  readRefusedCloses(local, pairing),
  // Plan 2b: an unreadable cache leaves the cards as in stage 2a, never the list unread.
  readParticipations(local, pairing).catch(() => new Map<string, Participation>()),
])
  .then(async ([read, refused, participation]) => {
    // Only a shift this station entered and that has a plan can show «Принято N из M».
    const counted = read.filter((copy) => copy.entered && (copy.plannedQty ?? 0) > 0);
    const accepted = await readAcceptedCounts(
      local,
      pairing,
      counted.map((copy) => copy.id),
    );
    // A shared shift's progress is the whole shift's: the others' part by the host and this
    // station's own codes (plan 2b, the plan is reached by the shift-wide total).
    for (const [id, own] of accepted) {
      const shared = sharedParticipation(participation.get(id) ?? null);
      if (shared !== null) accepted.set(id, sharedCount(shared, deviceId, own).total);
    }
    return { read, refused, accepted, participation };
  })
  .then(
    ({ read, refused, accepted, participation }) => {
      if (!cancelled) {
        setCopies({ kind: "ready", copies: read, refused, accepted, participation });
      }
    },
    () => {
      if (!cancelled) setCopies({ kind: "failed" });
    },
  );
```

- [ ] **Step 6: Style the participants line.** In `apps/standalone/src/floor/shifts/shift-hub.css`, after the `.shift-hub .shift-card__hint { … }` rule (`:564-567`):

```css
/* Plan 2b: who works a shared shift, on one line; the full list is the line's title. */
.shift-hub .shift-card__participants {
  min-width: 0;
  margin: 0;
  overflow: hidden;
  color: var(--fg-2);
  font: var(--floor-body);
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

and inside `@media (max-height: 700px)` (after its `.shift-hub .shift-card__counterparty { display: none; }`):

```css
.shift-hub .shift-card__participants {
  font-size: 15px;
  line-height: 18px;
}
```

- [ ] **Step 7: Run the tests to verify they pass.**

Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/card-action.test.ts test/floor-shift-list.test.tsx test/product-photos.test.tsx test/floor-hub-layout.test.ts test/floor-fit-css.test.ts`
Expected: PASS. Typecheck and lint the package: no errors.

- [ ] **Step 8: Commit.**

```bash
git -C "$WT" add apps/standalone/src/floor/shifts/ShiftCard.tsx apps/standalone/src/floor/shifts/ShiftHub.tsx \
  apps/standalone/src/floor/shifts/ShiftList.tsx apps/standalone/src/floor/shifts/shift-hub.css \
  apps/standalone/src/i18n/ru.json apps/standalone/test/card-action.test.ts apps/standalone/test/floor-shift-list.test.tsx
git -C "$WT" commit -m "feat(standalone): hub card joins a shared shift, says a full line and who works the shift

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Entry results — `shift_line_full` with its numbers, a closed part, offline entry drops a pause

**Files:**

- Modify: `apps/standalone/src/floor/shifts/shift-entry.ts:1-14` (imports), `:16-48` (`EntryRefusal`, `EntryResult`), `:78-94` (`storedWork`), `:110-146` (`enterShift`)
- Modify: `apps/standalone/src/floor/shifts/ShiftList.tsx:12` (import), `:87` (state), `:178` (`setRefusal`), `:190-195` (`standing`)
- Modify: `apps/standalone/src/i18n/ru.json:1300` (`floor.shifts.refused`), `floor.shifts` (after `"partClosed"`)
- Test: `apps/standalone/test/floor-shift-list.test.tsx` (new describe at the end)

**Interfaces:**

- Consumes: Task 3 `clearLeaveStatement`, `readParticipation`; Task 4 the join card.
- Produces:
  - `EntryRefusal` gains `"line_full"` and `"part_closed"`
  - `interface LineSlots { active: number; maxStations: number }`
  - `EntryResult` `refused` member: `{ kind: "refused"; reason: EntryRefusal; line?: LineSlots }`

- [ ] **Step 1: Write the failing tests.** Append to `apps/standalone/test/floor-shift-list.test.tsx`:

```ts
describe("what an entry into a shared shift comes to (plan 2b)", () => {
  const OTHER_ROW = () => participant(OTHER_STATION, "Станция линии 2", "active");
  const joinable = () =>
    sharedShift({
      participants: [{ row: OTHER_ROW(), accepted: 300 }],
      ownerDeviceId: OTHER_STATION,
    });

  it("says the line is full with the host's numbers, and keeps the list", async () => {
    const shift = joinable();
    const { executor } = await copiesOf([shift]);
    const full = new HostError({
      kind: "api",
      code: "conflict",
      status: 409,
      message: "every slot of this line is taken in this shift",
      details: { constraint: "shift_line_full", maxStations: 2, active: 2 },
    });
    const { handlers } = renderList(executor, { enter: vi.fn(async () => Promise.reject(full)) });
    fireEvent.click(await screen.findByRole("button", { name: "Присоединиться" }));
    expect(
      await screen.findByText(
        "Линия занята: 2 из 2. Присоединиться можно, когда одна из станций выйдет из смены или закроет свою часть.",
      ),
    ).toBeTruthy();
    expect(handlers.onEntered).not.toHaveBeenCalled();
    expect(screen.getByText(shift.number)).toBeTruthy();
  });

  it("says the line is full in words when the refusal names no numbers", async () => {
    const shift = joinable();
    const { executor } = await copiesOf([shift]);
    const full = new HostError({
      kind: "api",
      code: "conflict",
      status: 409,
      message: "full",
      details: { constraint: "shift_line_full" },
    });
    renderList(executor, { enter: vi.fn(async () => Promise.reject(full)) });
    fireEvent.click(await screen.findByRole("button", { name: "Присоединиться" }));
    expect(
      await screen.findByText(
        "Линия занята: все места этой смены заняты. Присоединиться можно, когда одна из станций выйдет из смены или закроет свою часть.",
      ),
    ).toBeTruthy();
  });

  it("works nothing of a part the host says is closed, and keeps nothing of the answer", async () => {
    const shift = sharedShift({
      participants: [
        { row: participant(DEVICE_ID, "Станция линии 1", "active"), accepted: 40 },
        { row: OTHER_ROW(), accepted: 300 },
      ],
      myState: "active",
    });
    const { executor } = await copiesOf([shift]);
    const closed = enteredOf(
      sharedShift({
        participants: [
          { row: participant(DEVICE_ID, "Станция линии 1", "closed"), accepted: 40 },
          { row: OTHER_ROW(), accepted: 300 },
        ],
        myState: "closed",
      }),
    );
    const { handlers } = renderList(executor, { enter: vi.fn(async () => closed) });
    fireEvent.click(await screen.findByRole("button", { name: "Продолжить" }));
    expect(
      await screen.findByText("Ваша часть этой смены уже закрыта: войти в неё снова нельзя."),
    ).toBeTruthy();
    expect(handlers.onEntered).not.toHaveBeenCalled();
    expect((await readShiftCopy(executor, PAIRING, shift.id))?.entered).toBe(false);
  });

  it("enters a known shift without the link and drops the pause the host has not heard", async () => {
    const { db, executor } = await copiesOf([SHARED], [SHARED_ENTERED]);
    db.prepare("UPDATE floor_shift_participation SET leave_requested_at = ?").run(
      "2026-10-08T10:00:00.000Z",
    );
    const context: EntryContext = {
      local: executor,
      pairing: PAIRING,
      online: false,
      enter: vi.fn(async () => SHARED_ENTERED),
      now: () => new Date("2026-10-08T10:05:00.000Z"),
    };
    const copy = await readShiftCopy(executor, PAIRING, SHARED.id);
    if (copy === null) throw new Error("the shared shift is not kept");
    expect(await enterShift(context, copy)).toMatchObject({ kind: "entered", offline: true });
    expect((await readParticipation(executor, PAIRING, SHARED.id))?.leaveRequestedAt).toBeNull();
    expect(context.enter).not.toHaveBeenCalled();
  });

  it("still says stage 2a's «занята» for `shift_busy`", async () => {
    const shift = joinable();
    const { executor } = await copiesOf([shift]);
    const busy = new HostError({
      kind: "api",
      code: "conflict",
      status: 409,
      message: "busy",
      details: { constraint: "shift_busy" },
    });
    renderList(executor, { enter: vi.fn(async () => Promise.reject(busy)) });
    fireEvent.click(await screen.findByRole("button", { name: "Присоединиться" }));
    expect(await screen.findByText("Эту смену уже открыла другая станция.")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run them to verify they fail.**

Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-shift-list.test.tsx -t "what an entry into a shared shift"`
Expected: FAIL — «Не удалось открыть смену» instead of the full line; the closed part is entered; the pause stays.

- [ ] **Step 3: Add the strings.** In `apps/standalone/src/i18n/ru.json`, in `floor.shifts.refused`, replace

```json
        "station_update": "Эту смену приложение этой станции открыть не может. Обновите приложение станции.",
```

with

```json
        "station_update": "Эту смену приложение этой станции открыть не может. Обновите приложение станции.",
        "line_full": "Линия занята: все места этой смены заняты. Присоединиться можно, когда одна из станций выйдет из смены или закроет свою часть.",
        "part_closed": "Ваша часть этой смены уже закрыта: войти в неё снова нельзя.",
```

and in `floor.shifts`, after the `"partClosed"` line added by Task 4:

```json
      "lineFullRefused": "Линия занята: {{active}} из {{max}}. Присоединиться можно, когда одна из станций выйдет из смены или закроет свою часть.",
```

- [ ] **Step 4: Implement the entry.** In `apps/standalone/src/floor/shifts/shift-entry.ts`:

Add the import `import { clearLeaveStatement } from "./shift-participation.js";` after the `./shift-snapshot.js` import.

In the doc of `EntryRefusal` (`:16-26`) add after «`station_update`: …, plan РЕЖ);» the words «`line_full`: every slot of the line is held, plan 2b; `part_closed`: this station's part of the shift is closed on the host, plan 2b;», and add to the union after `| "station_update"`:

```ts
  | "line_full"
  | "part_closed"
```

Replace `EntryResult` (`:44-48`) with:

```ts
/** The line's limit and the devices that hold its slots, as `shift_line_full` names them (plan 2b). */
export interface LineSlots {
  active: number;
  maxStations: number;
}

export type EntryResult =
  | { kind: "entered"; shift: WorkShift; offline: boolean }
  | { kind: "refused"; reason: EntryRefusal; line?: LineSlots }
  /** The host refused this device's key or showed another certificate: the shell's to handle. */
  | { kind: "rejected"; error: unknown };

/** The numbers of a `shift_line_full` refusal, or `null` when it names none. */
function lineSlotsOf(details: Readonly<Record<string, unknown>>): LineSlots | null {
  const { active, maxStations } = details;
  return typeof active === "number" && typeof maxStations === "number"
    ? { active, maxStations }
    : null;
}
```

Replace the `ready` case of `storedWork` (`:81-88`) with:

```ts
    case "ready":
      if (
        (stored.shift.copy.status !== "active" && stored.shift.copy.status !== "closed") ||
        stored.shift.copy.localState !== null
      ) {
        return { kind: "refused", reason: "closed" };
      }
      // Plan 2b (host D5): an entry drops the pause this station asked for and the host has not
      // heard, so a late pause never undoes it. A failed write keeps the entry going: the line
      // does not stop for it, and the host takes the facts of a paused part all the same.
      await context.local
        .transaction([clearLeaveStatement(context.pairing, shiftId)])
        .catch(() => undefined);
      return { kind: "entered", shift: stored.shift, offline: true };
```

In `enterShift`, replace the lines from `const constraint = error.details["constraint"];` to the
end of the `catch` block (`:127-132`) with:

```ts
const constraint = error.details["constraint"];
if (error.code === "conflict" && constraint === "shift_line_full") {
  const line = lineSlotsOf(error.details);
  return line === null
    ? { kind: "refused", reason: "line_full" }
    : { kind: "refused", reason: "line_full", line };
}
const refusal =
  error.code === "conflict" && typeof constraint === "string" ? CONFLICTS[constraint] : undefined;
return { kind: "refused", reason: refusal ?? "failed" };
```

and after the snapshot check (`:134-136`) insert:

```ts
// A device whose part is closed reads the shift back (plan 2b, host D2: a station that lost
// its database): there is nothing to work, and nothing of the answer is kept.
if (answer.myState === "closed") return { kind: "refused", reason: "part_closed" };
```

Extend the doc of `enterShift` with: «Since plan 2b the host gives a slot of the line (`shift_line_full` when every slot is held, with its numbers), and an entry — online or not — drops a pause this station asked for.»

- [ ] **Step 5: Say it on the list.** In `apps/standalone/src/floor/shifts/ShiftList.tsx` change the import to `import { enterShift, type EntryRefusal, type LineSlots } from "./shift-entry.js";`, the state (`:87`) to

```ts
const [refusal, setRefusal] = useState<{ reason: EntryRefusal; line: LineSlots | null } | null>(
  null,
);
```

`setRefusal(result.reason);` (`:178`) to `setRefusal({ reason: result.reason, line: result.line ?? null });`, and the `standing` element (`:190-195`) to:

```tsx
const standing =
  refusal !== null ? (
    <Alert tone="error" role="presentation">
      {refusal.line === null
        ? t(`floor.shifts.refused.${refusal.reason}`)
        : t("floor.shifts.lineFullRefused", {
            active: refusal.line.active,
            max: refusal.line.maxStations,
          })}
    </Alert>
  ) : null;
```

- [ ] **Step 6: Run the tests to verify they pass.**

Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-shift-list.test.tsx test/floor-new-shift.test.tsx test/floor-app.test.tsx`
Expected: PASS (the new-shift form shows `floor.shifts.refused.line_full` words if ever refused so). Typecheck: no errors.

- [ ] **Step 7: Commit.**

```bash
git -C "$WT" add apps/standalone/src/floor/shifts/shift-entry.ts apps/standalone/src/floor/shifts/ShiftList.tsx \
  apps/standalone/src/i18n/ru.json apps/standalone/test/floor-shift-list.test.tsx
git -C "$WT" commit -m "feat(standalone): station says a full line with its numbers, refuses a closed part, offline entry drops a pause

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The hub's measuring guard — join, full line, participants, closed part at the whole matrix

**Files:**

- Modify: `apps/standalone/test/harness/hub-header/main.tsx:11-19` (imports), `:20-37` (doc and query), `:194-208` (the copies)
- Modify: `apps/standalone/test/harness/station-fit/measure-others.mjs:62-69` (`HUB_CASES`)
- Test: `apps/standalone/test/floor-station-audit.test.ts` (new describe at the end)

**Interfaces:**

- Consumes: Task 4 `HubCopies.participation`, `Participation`; host types `ShiftParticipant`.
- Produces: harness query `multi=join|full|mine|closed` (the first card's participation).

- [ ] **Step 1: Write the failing audit pin.** Append to `apps/standalone/test/floor-station-audit.test.ts`:

```ts
describe("the shared shift's card (plan 2b)", () => {
  const hub = rulesOf("src/floor/shifts/shift-hub.css");

  it("keeps who works the shift on one line, cut with an ellipsis, the full list in its title", () => {
    const line = rule(hub, ".shift-hub .shift-card__participants");
    expect([line["white-space"], line["text-overflow"], line["overflow"]]).toEqual([
      "nowrap",
      "ellipsis",
      "hidden",
    ]);
    expect(textOf("src/floor/shifts/ShiftCard.tsx")).toContain(
      'className="shift-card__participants" title={participantsLine}',
    );
  });

  it("measures the shared cards on the hub's whole matrix", () => {
    const cases = textOf("test/harness/station-fit/measure-others.mjs");
    for (const multi of ["join", "full", "mine", "closed"]) {
      expect(cases).toContain(`multi=${multi}`);
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails.**

Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-station-audit.test.ts -t "shared shift's card"`
Expected: FAIL on the second test (no `multi=` case yet; the first passes after Task 4).

- [ ] **Step 3: Give the harness shared cards.** In `apps/standalone/test/harness/hub-header/main.tsx`:

Add to the imports:

```ts
import type { ShiftParticipant } from "../../../src/host/protocol.js";
import type { Participation } from "../../../src/floor/shifts/shift-participation.js";
```

Extend the doc's query list with «, `multi` (join | full | mine | closed: the first card as a shift several devices work, plan 2b)» and add after `const photoKind = …;`:

```ts
const multi = query.get("multi") ?? "";
```

Replace `const shown = ALL.slice(0, shiftCount).map(…);` through the end of `const copies: HubCopies = { … };` (`:196-208`) with:

```ts
/** A participant row of the shared first card. */
function row(
  deviceId: string,
  deviceName: string,
  state: ShiftParticipant["state"],
  deviceKind: ShiftParticipant["deviceKind"] = "station",
): ShiftParticipant {
  return {
    deviceId,
    deviceKind,
    deviceName,
    state,
    firstEnteredAt: "2026-10-08T06:02:00Z",
    joinedAt: "2026-10-08T06:02:00Z",
    leftAt: null,
    closedAt: state === "closed" ? "2026-10-08T09:00:00Z" : null,
    closedBy: state === "closed" ? "device" : null,
    closedActualQty: null,
    closedReasonCode: null,
    lateDataAt: null,
    lastSeenAt: "2026-10-08T09:41:00Z",
  };
}

/** The first card's participants for `multi`, or `null` (stage 2a's card). */
function sharedFirst(kind: string): Participation | null {
  const other = row(
    "other",
    long ? "Станция упаковки № 3 · Линия розлива сидра (цех 2)" : "Станция 2",
    "active",
  );
  const handheld = row(
    "tsd",
    long ? "ТСД Urovo DT50 у паллетной зоны склада" : "ТСД 1",
    "active",
    "handheld",
  );
  const rows =
    kind === "join"
      ? [other]
      : kind === "full"
        ? [other, handheld]
        : kind === "mine"
          ? [row("dev", "Станция 1", "active"), other, handheld]
          : kind === "closed"
            ? [row("dev", "Станция 1", "closed"), other]
            : null;
  if (rows === null) return null;
  return {
    shiftId: "ОКТ26-004",
    maxStations: kind === "mine" ? 3 : 2,
    myState: kind === "mine" ? "active" : kind === "closed" ? "closed" : null,
    participants: rows,
    totals: { accepted: 840, boxesClosed: 70, pallets: 0, asOf: "2026-10-08T09:41:07Z" },
    byDevice: rows.map((one) => ({
      deviceId: one.deviceId,
      accepted: 280,
      boxesClosed: 23,
      pallets: 0,
    })),
    asOf: "2026-10-08T09:41:07Z",
    leaveRequestedAt: null,
  };
}
const first = sharedFirst(multi);
// Joining or a full line: the first card is another station's shift this station never entered.
const foreign = multi === "join" || multi === "full" || multi === "closed";
const shown = ALL.slice(0, shiftCount).map((c, i) => {
  const named = long && i === 0 ? { ...c, productName: LONG_NAME } : c;
  return foreign && i === 0 ? { ...named, ownerDeviceId: "other", entered: false } : named;
});
const accepted = new Map<string, number>([
  ["ОКТ26-004", 840],
  ["ОКТ26-003", 2400],
]);
const copies: HubCopies = {
  kind: "ready",
  copies: shown,
  refused: new Map(),
  accepted,
  participation: first === null ? new Map() : new Map([["ОКТ26-004", first]]),
};
```

In `apps/standalone/test/harness/station-fit/measure-others.mjs`, add to `HUB_CASES` after
`"view=hub&shifts=0&offline=1",`:

```js
  // Plan 2b: a shift several devices work — join, a full line, this station among three with long
  // names offline, a closed part; and a join without the link (the tallest notes: who, link).
  "view=hub&shifts=2&multi=join&photo=png",
  "view=hub&shifts=2&multi=join&offline=1&long=1",
  "view=hub&shifts=1&multi=full&long=1&photo=jpeg",
  "view=hub&shifts=2&multi=mine&long=1&offline=1&photo=transparent",
  "view=hub&shifts=3&multi=closed",
```

- [ ] **Step 4: Run the pin and the guard.**

Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-station-audit.test.ts`
Expected: PASS.
Run (needs Chromium; macOS: sandbox off): `PLAYWRIGHT_CORE=<path to playwright-core> pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/station-fit.browser.test.ts`
Expected: PASS — no problem at any of the 7 sizes × 2 themes. If it reports `.shift-card__notes` or `.shift-card__participants` clipped vertically at 1024×640 or 1024×700 for `multi=join&offline=1&long=1`, add inside `@media (max-height: 700px)` of `shift-hub.css`:

```css
/* Plan 2b: who works the shift says why the card waits; the link's hint gives its line up. */
.shift-hub .shift-card__participants + .shift-card__hint {
  display: none;
}
```

and run the guard again (the disabled «Присоединиться» still says it needs the host through the
page's banner «Нет связи с хостом…»). If `PLAYWRIGHT_CORE` is not available, record «station-fit
guard not run» in the report.

- [ ] **Step 5: Commit.**

```bash
git -C "$WT" add apps/standalone/test/harness/hub-header/main.tsx apps/standalone/test/harness/station-fit/measure-others.mjs \
  apps/standalone/test/floor-station-audit.test.ts apps/standalone/src/floor/shifts/shift-hub.css
git -C "$WT" commit -m "test(standalone): hub guard measures shared shift cards on the whole matrix

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

(Stage `shift-hub.css` only if Step 4 changed it.)

---

### Task 7: The pause — «Выйти из смены» frees the slot; the link sends it and reads the list on request

**Files:**

- Modify: `apps/standalone/src/floor/shifts/shift-participation.ts` (append `MARK_LEAVE_SQL`, `markLeave`)
- Create: `apps/standalone/src/local/leave-sender.ts`
- Modify: `apps/standalone/src/app/host-link.ts:1-27` (imports), `:86-127` (options, controls), `:169-185` (destructure, refs), `:255-261` (after the notices' counters), `:296-312` (`stopAll`), before `:523` (`// One batch of the outbox …`), `:658-674` (`everything`, refs), `:681-713` (`onStatus`), `:750-768` (deps, return)
- Modify: `apps/standalone/src/app/App.tsx:393-407` (`useHostLink`), `:1091-1118` (`FloorApp`)
- Modify: `apps/standalone/src/floor/FloorApp.tsx:1-60` (imports), `:89-147` (props), `:164-192` (destructure), `:214-217` (`current`), `:248-280` (`leave`)
- Test: `apps/standalone/test/leave-sender.test.ts` (new), `apps/standalone/test/host-link-leave.test.ts` (new), `apps/standalone/test/floor-app.test.tsx` (`handlersOf` `:180-212`, `floorOf` `:143-178`, new describe at the end)

**Interfaces:**

- Consumes: Task 1 `HostApi.leaveShift`; Task 3 `participationStatement`, `readParticipation`, the table's `leave_requested_at`.
- Produces:
  - `MARK_LEAVE_SQL`; `markLeave(local: LocalExecutor, pairing: Pairing, shiftId: string, at: string): Promise<boolean>`
  - `PENDING_LEAVES_SQL`, `SETTLE_LEAVE_SQL`; `sendPendingLeaves(local: LocalExecutor, pairing: Pairing, leave: (shiftId: string) => Promise<DeviceShift>, now: () => Date): Promise<{ sent: number }>`
  - `HostLinkOptions.leaveShift?: (shiftId: string) => Promise<DeviceShift>`; `HostLinkControls.requestShifts: () => void`, `HostLinkControls.requestLeaves: () => void`
  - `FloorAppProps.requestShifts?: () => void`, `FloorAppProps.requestLeaves?: () => void`

- [ ] **Step 1: Write the failing tests.**

Create `apps/standalone/test/leave-sender.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { keepEnteredShift } from "../src/floor/shifts/shift-copies.js";
import { markLeave } from "../src/floor/shifts/shift-participation.js";
import { HostError } from "../src/host/client.js";
import { deviceShiftSchema, type DeviceShift } from "../src/host/protocol.js";
import { sendPendingLeaves } from "../src/local/leave-sender.js";
import { DEVICE_ID, HOST_ID } from "./support/fixtures.js";
import { openLocalDb } from "./support/local-db.js";
import { SHARED, SHARED_ENTERED } from "./support/multi-station.js";

const PAIRING = { hostId: HOST_ID, deviceId: DEVICE_ID };
const AT = "2026-10-08T10:00:00.000Z";
const NOW = () => new Date("2026-10-08T10:00:05.000Z");
const pauseRow = z.object({
  leave_requested_at: z.string().nullable(),
  my_state: z.string().nullable(),
});
/** The host's answer to the leave: this station `left`, read at 10:00:06. */
const LEFT: DeviceShift = deviceShiftSchema.parse({
  ...SHARED,
  myState: "left",
  totals: { accepted: 547, boxesClosed: 45, pallets: 0, asOf: "2026-10-08T10:00:06Z" },
});

async function paused() {
  const opened = openLocalDb();
  await keepEnteredShift(opened.executor, PAIRING, SHARED_ENTERED, "2026-10-08T06:02:00.000Z", 1);
  expect(await markLeave(opened.executor, PAIRING, SHARED.id, AT)).toBe(true);
  const row = () =>
    opened.executor.query(
      "SELECT leave_requested_at, my_state FROM floor_shift_participation",
      [],
      pauseRow,
    );
  return { ...opened, row };
}

describe("this station's pause of a shared shift (plan 2b, host D5)", () => {
  it("is asked only of a part that is active here and of a shift open and not closing here", async () => {
    const { db, executor } = await paused();
    db.prepare("UPDATE floor_shift_participation SET leave_requested_at = NULL").run();
    db.prepare("UPDATE floor_shifts SET local_state = 'closing' WHERE id = ?").run(SHARED.id);
    expect(await markLeave(executor, PAIRING, SHARED.id, AT)).toBe(false);
    db.prepare("UPDATE floor_shifts SET local_state = NULL WHERE id = ?").run(SHARED.id);
    db.prepare("UPDATE floor_shift_participation SET my_state = 'left'").run();
    expect(await markLeave(executor, PAIRING, SHARED.id, AT)).toBe(false);
    // A shift with no figures (a planned one, a host before protocol 7) owes the host no pause.
    expect(await markLeave(executor, PAIRING, "4e7a1c9d-2b5f-4d8e-a3c6-9f0b1e2d3c4a", AT)).toBe(
      false,
    );
  });

  it("is sent, the host's answer kept, and settled", async () => {
    const { executor, row } = await paused();
    const leave = vi.fn(async () => LEFT);
    expect(await sendPendingLeaves(executor, PAIRING, leave, NOW)).toEqual({ sent: 1 });
    expect(leave).toHaveBeenCalledWith(SHARED.id);
    expect(await row()).toEqual([{ leave_requested_at: null, my_state: "left" }]);
    // Nothing is owed any more: nothing goes again.
    expect(await sendPendingLeaves(executor, PAIRING, leave, NOW)).toEqual({ sent: 0 });
    expect(leave).toHaveBeenCalledTimes(1);
  });

  it("is settled without an answer when the host owes nothing: never entered, or no such shift", async () => {
    for (const refusal of [
      new HostError({
        kind: "api",
        code: "conflict",
        status: 409,
        message: "no",
        details: { constraint: "shift_not_entered" },
      }),
      new HostError({ kind: "api", code: "not_found", status: 404, message: "no such shift" }),
    ]) {
      const { executor, row } = await paused();
      expect(
        await sendPendingLeaves(
          executor,
          PAIRING,
          vi.fn(async () => Promise.reject(refusal)),
          NOW,
        ),
      ).toEqual({ sent: 0 });
      expect(await row()).toEqual([{ leave_requested_at: null, my_state: "active" }]);
    }
  });

  it("is kept when the host did not hear it, for the link's next try", async () => {
    const { executor, row } = await paused();
    const away = new HostError({ kind: "transport", code: "unreachable", message: "down" });
    await expect(
      sendPendingLeaves(
        executor,
        PAIRING,
        vi.fn(async () => Promise.reject(away)),
        NOW,
      ),
    ).rejects.toBe(away);
    expect(await row()).toEqual([{ leave_requested_at: AT, my_state: "active" }]);
  });

  it("is not settled by the answer of an older request when a newer one was asked meanwhile", async () => {
    const { db, executor, row } = await paused();
    const leave = vi.fn(async () => {
      db.prepare("UPDATE floor_shift_participation SET leave_requested_at = ?").run(
        "2026-10-08T10:00:03.000Z",
      );
      return LEFT;
    });
    await sendPendingLeaves(executor, PAIRING, leave, NOW);
    expect(await row()).toEqual([
      { leave_requested_at: "2026-10-08T10:00:03.000Z", my_state: "left" },
    ]);
  });
});
```

Create `apps/standalone/test/host-link-leave.test.ts`:

```ts
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { useHostLink } from "../src/app/host-link.js";
import type { ShellAction } from "../src/app/shell.js";
import { keepEnteredShift } from "../src/floor/shifts/shift-copies.js";
import { markLeave } from "../src/floor/shifts/shift-participation.js";
import type { ConnectionApi, ConnectionHandlers } from "../src/host/connection.js";
import {
  deviceShiftSchema,
  type ChangesResponse,
  type DeviceShift,
  type DeviceStatus,
  type HostStatus,
} from "../src/host/protocol.js";
import type { LocalExecutor } from "../src/local/executor.js";
import { DEVICE_ID, DEVICE_STATUS, HOST_ID } from "./support/fixtures.js";
import { openLocalDb } from "./support/local-db.js";
import { SHARED, SHARED_ENTERED } from "./support/multi-station.js";

const ONLINE: HostStatus = { state: "online", lastContactAt: 1, lastError: null, seq: 1 };
const PAIRING = { hostId: HOST_ID, deviceId: DEVICE_ID };
const pauseRow = z.object({ leave_requested_at: z.string().nullable() });
const LEFT: DeviceShift = deviceShiftSchema.parse({
  ...SHARED,
  myState: "left",
  totals: { accepted: 547, boxesClosed: 45, pallets: 0, asOf: "2026-10-08T10:00:06Z" },
});

async function pausedStation(): Promise<LocalExecutor> {
  const { executor } = openLocalDb();
  await keepEnteredShift(executor, PAIRING, SHARED_ENTERED, "2026-10-08T06:02:00.000Z", 1);
  expect(await markLeave(executor, PAIRING, SHARED.id, "2026-10-08T10:00:00.000Z")).toBe(true);
  return executor;
}

function link(local: LocalExecutor, leaveShift: (shiftId: string) => Promise<DeviceShift>) {
  const connection: ConnectionApi = {
    watch: vi.fn(async (next: ConnectionHandlers) => {
      next.onStatus(ONLINE);
      return () => undefined;
    }),
  };
  const deviceShifts = vi.fn(async (): Promise<DeviceShift[]> => [SHARED]);
  const dispatch = vi.fn<(action: ShellAction) => void>();
  const changes = async (): Promise<ChangesResponse> => ({
    hostId: HOST_ID,
    rev: 1,
    hasMore: false,
    items: [],
  });
  const refresh = async (): Promise<DeviceStatus> => DEVICE_STATUS;
  const hook = renderHook(() =>
    useHostLink({
      hostId: HOST_ID,
      deviceId: DEVICE_ID,
      connection,
      local,
      changes,
      refresh,
      deviceShifts,
      sendFacts: async () => [],
      registerKnownBlocks: async () => ({ results: [] }),
      leaveShift,
      dispatch,
    }),
  );
  return { hook, deviceShifts };
}

const pauses = (local: LocalExecutor) =>
  local.query("SELECT leave_requested_at FROM floor_shift_participation", [], pauseRow);

describe("the pauses and the list on the link (plan 2b)", () => {
  it("sends a pause the station owes once the link is online, and reads the list again after it", async () => {
    const local = await pausedStation();
    const leaveShift = vi.fn(async () => LEFT);
    const { hook, deviceShifts } = link(local, leaveShift);
    await waitFor(() => expect(leaveShift).toHaveBeenCalledWith(SHARED.id));
    await waitFor(async () => expect(await pauses(local)).toEqual([{ leave_requested_at: null }]));
    // The everything() read, then the one the settled pause asked for.
    await waitFor(() => expect(deviceShifts.mock.calls.length).toBeGreaterThanOrEqual(2));
    hook.unmount();
  });

  it("reads the list and sends a pause at once when a screen asks", async () => {
    const local = await pausedStation();
    const leaveShift = vi.fn(async () => LEFT);
    const { hook, deviceShifts } = link(local, leaveShift);
    await waitFor(() => expect(leaveShift).toHaveBeenCalledTimes(1));
    await waitFor(async () => expect(await pauses(local)).toEqual([{ leave_requested_at: null }]));
    const reads = deviceShifts.mock.calls.length;
    await act(async () => {
      hook.result.current.requestShifts();
    });
    await waitFor(() => expect(deviceShifts.mock.calls.length).toBeGreaterThan(reads));
    // The station enters again (the host's newer answer: active) and leaves again: the screen
    // asks, and the pause goes at once.
    await keepEnteredShift(local, PAIRING, REENTERED, "2026-10-08T10:11:00.000Z", 2);
    expect(await markLeave(local, PAIRING, SHARED.id, "2026-10-08T10:12:00.000Z")).toBe(true);
    await act(async () => {
      hook.result.current.requestLeaves();
    });
    await waitFor(() => expect(leaveShift).toHaveBeenCalledTimes(2));
    hook.unmount();
  });
});
```

For the second test, add to the file's imports
`import { enteredOf, HANDHELD, participant, sharedShift, STATION_ROW } from "./support/multi-station.js";`
(merged with the `SHARED, SHARED_ENTERED` import) and, after `LEFT`:

```ts
/** The host's answer to an entry after the pause: this station active again, read at 10:11. */
const REENTERED = enteredOf(
  sharedShift({
    participants: [
      { row: STATION_ROW, accepted: 427 },
      { row: participant(HANDHELD, "ТСД 1", "closed", "handheld"), accepted: 120 },
    ],
    myState: "active",
    asOf: "2026-10-08T10:11:00Z",
  }),
);
```

In `apps/standalone/test/floor-app.test.tsx`: in `handlersOf` add `requestLeaves: vi.fn(),` after
`requestFacts: vi.fn(),`; in `floorOf` add `requestLeaves={handlers.requestLeaves}` after
`requestFacts={handlers.requestFacts}`; add the import
`import { SHARED_ENTERED } from "./support/multi-station.js";`; append:

```tsx
describe("leaving a shared shift (plan 2b)", () => {
  const pauseRow = z.object({ leave_requested_at: z.string().nullable() });

  it("pauses this station's part on «Выйти из смены» and asks the link to tell the host", async () => {
    const local = await floorCopies();
    await keepEnteredShift(local, PAIRING, SHARED_ENTERED, "2026-10-08T06:02:00.000Z", SEEN);
    const handlers = handlersOf({ enter: async () => SHARED_ENTERED });
    render(floorOf(local, handlers, { workScreen: IdleWork }));
    fireEvent.click(await screen.findByRole("button", { name: "Продолжить" }));
    fireEvent.click(await screen.findByRole("button", { name: "Выйти из смены" }));
    await waitFor(() => expect(handlers.requestLeaves).toHaveBeenCalledTimes(1));
    const [row] = await local.query(
      "SELECT leave_requested_at FROM floor_shift_participation",
      [],
      pauseRow,
    );
    expect(row?.leave_requested_at).not.toBeNull();
  });

  it("does not pause the part on a change of operator: the next one goes on at this station", async () => {
    const local = await floorCopies();
    await keepEnteredShift(local, PAIRING, SHARED_ENTERED, "2026-10-08T06:02:00.000Z", SEEN);
    const handlers = handlersOf({ enter: async () => SHARED_ENTERED });
    render(floorOf(local, handlers, { workScreen: IdleWork }));
    fireEvent.click(await screen.findByRole("button", { name: "Продолжить" }));
    await screen.findByText(`Смена ${SHARED_ENTERED.number}`);
    act(() => handlers.switchOperator.current?.());
    await waitFor(() => expect(handlers.onSignOut).toHaveBeenCalledWith(null));
    await settle();
    expect(handlers.requestLeaves).not.toHaveBeenCalled();
    const [row] = await local.query(
      "SELECT leave_requested_at FROM floor_shift_participation",
      [],
      pauseRow,
    );
    expect(row?.leave_requested_at).toBeNull();
  });
});
```

(`z` — add `import { z } from "zod";` to the file's imports if it is not there.)

- [ ] **Step 2: Run them to verify they fail.**

Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/leave-sender.test.ts test/host-link-leave.test.ts test/floor-app.test.tsx -t "pause|leaving a shared shift|pauses and the list"`
Expected: FAIL — `markLeave` / `sendPendingLeaves` not exported; `requestShifts` undefined; `requestLeaves` never called.

- [ ] **Step 3: Mark a pause.** Append to `apps/standalone/src/floor/shifts/shift-participation.ts`:

```ts
/**
 * The pause this station asks for on «Выйти из смены» (plan 2b, spec §5 «Выход из смены»): marked
 * only while the cache says its part is active, the shift is active and this station is not
 * closing it; the link sends it (`sendPendingLeaves`). Parameters: the instant, host id, device
 * id, shift id.
 */
export const MARK_LEAVE_SQL =
  "UPDATE floor_shift_participation SET leave_requested_at = ? WHERE host_id = ? AND device_id = ? " +
  "AND shift_id = ? AND my_state = 'active' AND EXISTS (SELECT 1 FROM floor_shifts s " +
  "WHERE s.host_id = floor_shift_participation.host_id " +
  "AND s.device_id = floor_shift_participation.device_id " +
  "AND s.id = floor_shift_participation.shift_id AND s.status = 'active' AND s.local_state IS NULL)";

/** Marks the pause; `true` when there was a part to pause. */
export async function markLeave(
  local: LocalExecutor,
  pairing: Pairing,
  shiftId: string,
  at: string,
): Promise<boolean> {
  const [changed] = await local.transaction([
    { sql: MARK_LEAVE_SQL, values: [at, pairing.hostId, pairing.deviceId, shiftId] },
  ]);
  return changed === 1;
}
```

- [ ] **Step 4: Send the pauses.** Create `apps/standalone/src/local/leave-sender.ts`:

```ts
import { z } from "zod";

import { participationStatement } from "../floor/shifts/shift-participation.js";
import { HostError } from "../host/client.js";
import type { DeviceShift } from "../host/protocol.js";
import type { LocalExecutor, LocalStatement } from "./executor.js";
import type { Pairing } from "./reference-sync.js";

/** This pairing's pauses the host has not answered; parameters: host id, device id. */
export const PENDING_LEAVES_SQL =
  "SELECT shift_id, leave_requested_at FROM floor_shift_participation " +
  "WHERE host_id = ? AND device_id = ? AND leave_requested_at IS NOT NULL " +
  "ORDER BY leave_requested_at, shift_id";

/**
 * A pause settled: only the request that was sent, so a newer one asked meanwhile stays.
 * Parameters: host id, device id, shift id, the instant of the request sent.
 */
export const SETTLE_LEAVE_SQL =
  "UPDATE floor_shift_participation SET leave_requested_at = NULL " +
  "WHERE host_id = ? AND device_id = ? AND shift_id = ? AND leave_requested_at = ?";

const pendingRow = z.object({ shift_id: z.string(), leave_requested_at: z.string() });

/** The host owes nothing for this pause: the device never entered, or the shift is gone. */
function moot(error: unknown): boolean {
  return (
    error instanceof HostError &&
    error.kind === "api" &&
    (error.code === "not_found" ||
      (error.code === "conflict" && error.details["constraint"] === "shift_not_entered"))
  );
}

/**
 * Sends this pairing's pauses (plan 2b, `POST /v1/device/shifts/{id}/leave`, host D5), oldest
 * first: each answer's figures go into the cache with the pause settled in one transaction; a
 * pause the host owes nothing for is settled without figures; any other failure — the host away,
 * a refused key — goes back to the link, which retries it and keeps the rest for then. A pause
 * an entry dropped meanwhile is not sent (the read is fresh), and one asked again after the send
 * is not settled by the older answer. Answers how many the host took.
 */
export async function sendPendingLeaves(
  local: LocalExecutor,
  pairing: Pairing,
  leave: (shiftId: string) => Promise<DeviceShift>,
  now: () => Date,
): Promise<{ sent: number }> {
  const pending = await local.query(
    PENDING_LEAVES_SQL,
    [pairing.hostId, pairing.deviceId],
    pendingRow,
  );
  let sent = 0;
  for (const row of pending) {
    const settle: LocalStatement = {
      sql: SETTLE_LEAVE_SQL,
      values: [pairing.hostId, pairing.deviceId, row.shift_id, row.leave_requested_at],
    };
    let answer: DeviceShift;
    try {
      answer = await leave(row.shift_id);
    } catch (error) {
      if (!moot(error)) throw error;
      await local.transaction([settle]);
      continue;
    }
    await local.transaction([participationStatement(pairing, [answer], now().getTime()), settle]);
    sent += 1;
  }
  return { sent };
}
```

- [ ] **Step 5: Give the link the pauses and the two requests.** In `apps/standalone/src/app/host-link.ts`:

Add the import `import { sendPendingLeaves } from "../local/leave-sender.js";` after the
`sendWarehouseBatch` import.

In `HostLinkOptions`, after `deviceProductPhoto?: …;`:

```ts
  /**
   * `HostApi.leaveShift` (plan 2b): the pauses this station owes the host go when the link is
   * online, retried like the reads; none — they wait.
   */
  leaveShift?: (shiftId: string) => Promise<DeviceShift>;
```

Replace `HostLinkControls` (`:122-127`) with:

```ts
/** What the link offers the screens: a sync and every read now, the outbox, the list and the pauses now. */
export interface HostLinkControls {
  requestSync: () => void;
  /** Sends the outbox now (after a local write); nothing goes while the link is stopped or not online, or while a failed send's pause runs (its end sends). */
  requestFacts: () => void;
  /** Reads the station's shifts now (plan 2b: a shared shift's totals, which no revision announces). */
  requestShifts: () => void;
  /** Sends the pauses this station owes now (plan 2b, after «Выйти из смены»). */
  requestLeaves: () => void;
}
```

Add `leaveShift,` to the destructured options after `deviceProductPhoto,`, and after
`const factsNow = useRef<() => void>(() => undefined);`:

```ts
const shiftsNow = useRef<() => void>(() => undefined);
const leavesNow = useRef<() => void>(() => undefined);
```

After the notices' `cancelNoticeRetry` definition (`:255-261`):

```ts
// And for the pauses this station owes the host (plan 2b).
let leaveFailures = 0;
let leaveRetry: ReturnType<typeof setTimeout> | null = null;
const cancelLeaveRetry = () => {
  if (leaveRetry === null) return;
  clearTimeout(leaveRetry);
  leaveRetry = null;
};
```

In `stopAll` add `leaveSender.stop();` after `noticeReader.stop();` and `cancelLeaveRetry();`
after `cancelNoticeRetry();`.

Insert before the comment `// One batch of the outbox at a time, retried like the reads above. A`:

```ts
// One sending of the pauses at a time (plan 2b), retried like the reads above, only with the
// link online (or without events at all, as the outbox); a settled pause took a revision on
// the host, and the list is read again for the figures. A refused key ends the link.
const leaveSender = createSyncScheduler(async () => {
  if (!active || leaveShift === undefined) return;
  if (!online && !watchFailed) return;
  cancelLeaveRetry();
  try {
    const { sent } = await sendPendingLeaves(local, pairing, leaveShift, () => new Date());
    if (!active) return;
    leaveFailures = 0;
    if (sent > 0) shiftReader.trigger();
  } catch (error) {
    if (!active) return;
    const action = shellActionFor(error, null);
    if (action) {
      stopAll();
      dispatch(action);
      return;
    }
    if (error instanceof HostError && error.code === "not_paired") return;
    leaveFailures += 1;
    if (online) {
      leaveRetry = setTimeout(() => {
        leaveRetry = null;
        leaveSender.trigger();
      }, nextSyncRetryMs(leaveFailures));
    }
  }
});
```

In `everything` add `leaveSender.trigger();` after `noticeReader.trigger();`, and after
`syncNow.current = everything;`:

```ts
shiftsNow.current = () => shiftReader.trigger();
leavesNow.current = () => leaveSender.trigger();
```

In `onStatus`: in the offline branch add `cancelLeaveRetry();` after `cancelNoticeRetry();`; after
`if (noticeFailures > 0 && noticeRetry === null) noticeReader.trigger();` add:

```ts
// The pauses wait for the link, as the outbox: going online sends them.
if ((watching && !wasOnline) || (leaveFailures > 0 && leaveRetry === null)) {
  leaveSender.trigger();
}
```

In the cleanup add `shiftsNow.current = () => undefined;` and `leavesNow.current = () => undefined;`
after `factsNow.current = () => undefined;`; add `leaveShift,` to the dependency list after
`deviceProductPhoto,`; and replace the hook's last three lines with:

```ts
const requestSync = useCallback(() => syncNow.current(), []);
const requestFacts = useCallback(() => factsNow.current(), []);
const requestShifts = useCallback(() => shiftsNow.current(), []);
const requestLeaves = useCallback(() => leavesNow.current(), []);
return useMemo(
  () => ({ requestSync, requestFacts, requestShifts, requestLeaves }),
  [requestSync, requestFacts, requestShifts, requestLeaves],
);
```

Extend the hook's doc comment with: «The pauses this station owes (plan 2b) go at the same moments
and on request (`requestLeaves`), retried with a count of their own; a screen may ask the shifts
again (`requestShifts`): a shared shift's totals change with every scan of another device, which
takes no revision.»

In `apps/standalone/src/app/App.tsx` replace `const { requestSync, requestFacts } = useHostLink({`
with `const { requestSync, requestFacts, requestShifts, requestLeaves } = useHostLink({`, add
`leaveShift: hostApi.leaveShift,` after `deviceProductPhoto: hostApi.getDeviceProductPhoto,`, and
pass to `<FloorApp …>` after `requestFacts={requestFacts}`:

```tsx
requestShifts = { requestShifts };
requestLeaves = { requestLeaves };
```

- [ ] **Step 6: Pause on «Выйти из смены».** In `apps/standalone/src/floor/FloorApp.tsx`:

Add the import `import { markLeave } from "./shifts/shift-participation.js";`.

In `FloorAppProps`, after `requestFacts: () => void;`:

```ts
  /** The link's read of the shifts, asked by the work screen of a shared shift (plan 2b); none — not asked. */
  requestShifts?: () => void;
  /** The link's sending of the pauses (plan 2b), asked after «Выйти из смены»; none — they wait. */
  requestLeaves?: () => void;
```

Add `requestShifts,` and `requestLeaves,` to the destructured props after `requestFacts,`.

Replace the `current` ref (`:214-217`) with:

```ts
const current = useRef({ view, onSignOut, dispatch, requestLeaves });
useLayoutEffect(() => {
  current.current = { view, onSignOut, dispatch, requestLeaves };
});
```

In `leave` (`:248-280`) add, after `const from = current.current.view.kind;`:

```ts
// The shift whose part «Выйти из смены» or a move to another line pauses (plan 2b).
const leaving = current.current.view;
const pausedShift = leaving.kind === "work" ? leaving.shift.copy.id : null;
```

and replace the drain's continuation

```ts
void gate.drain().then(() => {
  const ending = standing.current ?? reason;
  standing.current = null;
  if (!alive.current) return;
  if (from === "work") current.current.dispatch({ type: "work_left", sessionId });
  finish(ending);
});
```

with

```ts
void gate.drain().then(() => {
  const ending = standing.current ?? reason;
  standing.current = null;
  // Plan 2b (spec §5 «Выход из смены»): the operator's own exit and a move to another line
  // free this station's slot; a sign-out does not — the next operator goes on here. The
  // pause is written after the work drained and goes when the link can.
  if (pausedShift !== null && (ending.kind === "list" || ending.kind === "line_changed")) {
    void markLeave(local, { hostId, deviceId }, pausedShift, new Date().toISOString()).then(
      (marked) => {
        if (marked) current.current.requestLeaves?.();
      },
      // The slot stays held until the next exit or the office's close; nothing else waits on it.
      () => undefined,
    );
  }
  if (!alive.current) return;
  if (from === "work") current.current.dispatch({ type: "work_left", sessionId });
  finish(ending);
});
```

and add `local, hostId, deviceId` to `leave`'s dependency list (`[finish, gate, sessionId, local, hostId, deviceId]`).

- [ ] **Step 7: Run the tests to verify they pass.**

Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/leave-sender.test.ts test/host-link-leave.test.ts test/host-link-shifts.test.ts test/host-link-facts.test.ts test/host-link-notices.test.ts test/host-link-restore.test.ts test/floor-app.test.tsx test/app.test.tsx test/shell.test.ts`
Expected: PASS. Typecheck and lint: no errors.

- [ ] **Step 8: Commit.**

```bash
git -C "$WT" add apps/standalone/src/floor/shifts/shift-participation.ts apps/standalone/src/local/leave-sender.ts \
  apps/standalone/src/app/host-link.ts apps/standalone/src/app/App.tsx apps/standalone/src/floor/FloorApp.tsx \
  apps/standalone/test/leave-sender.test.ts apps/standalone/test/host-link-leave.test.ts apps/standalone/test/floor-app.test.tsx
git -C "$WT" commit -m "feat(standalone): «Выйти из смены» pauses a shared part; the link sends pauses and reads the list on request

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: The work screen's strip — «Моя станция: N · Всего в смене: K из M», its age offline, the plan by K

**Files:**

- Create: `apps/standalone/src/floor/work/use-shift-participation.ts`
- Modify: `apps/standalone/src/floor/shifts/shift-text.ts` (append `formatClock`)
- Modify: `apps/standalone/src/floor/work/WorkInstruments.tsx:1-12` (imports), `:30-139` (`ShiftBandProps`, `ShiftBand`)
- Modify: `apps/standalone/src/floor/work/work-screen.css:337-340` (after `.work-shift-band__bar > span`), `:1045-1048` (the compact `@media (max-height: 780px)`, after `.work-shift-band__bar, .work-shift-band__meta { display: none; }`)
- Modify: `apps/standalone/src/floor/work/WorkScreen.tsx:202-274` (props), `:811` (state), `:834` (after `plannedQty`), `:1967-1975` (`openClose`), `:2318` (render prelude), `:2401-2422` (band), `:2589-2596` (footer close), `:2666-2694` (plan notice)
- Modify: `apps/standalone/src/floor/FloorApp.tsx:477-503` (the work screen's props)
- Modify: `apps/standalone/src/i18n/ru.json:356` (`floor.work`), `:812` (`floor.close`)
- Test: `apps/standalone/test/floor-shared-strip.test.tsx` (new), `apps/standalone/test/use-shift-participation.test.tsx` (new), `apps/standalone/test/floor-shift-text.test.ts`

**Interfaces:**

- Consumes: Task 3 `readParticipation`, `sharedParticipation`, `sharedCount`, `Participation`; Task 7 `FloorAppProps.requestShifts`.
- Produces:
  - `formatClock(instant: string): string`
  - `SHIFT_TOTALS_POLL_MS = 15_000`; `useShiftParticipation(input: { local: LocalExecutor; pairing: Pairing; shiftId: string; shiftReads: number; online: boolean; onRefresh?: () => void }): Participation | null`
  - `ShiftBandProps.shared?: { mine: number; total: number; asOf: string; stale: boolean }` (DOM: `.work-shift-band__small--mine`, `.work-shift-band__stale`)
  - `WorkScreenProps.shiftReads?: number`, `WorkScreenProps.onRefreshShifts?: () => void`
  - i18n `floor.work.shared.{total,mine,summary,summaryNoPlan,asOf}`, `floor.close.openPart`

- [ ] **Step 1: Write the failing tests.**

Append to `apps/standalone/test/floor-shift-text.test.ts` (and add `formatClock` to its import):

```ts
it("says an instant as «ЧЧ:ММ» on this computer's clock, and an unreadable one as it is (plan 2b)", () => {
  const at = "2026-10-08T09:41:07Z";
  const local = new Date(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  expect(formatClock(at)).toBe(`${pad(local.getHours())}:${pad(local.getMinutes())}`);
  expect(formatClock("вчера")).toBe("вчера");
});
```

Create `apps/standalone/test/use-shift-participation.test.tsx`:

```tsx
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { keepEnteredShift } from "../src/floor/shifts/shift-copies.js";
import {
  SHIFT_TOTALS_POLL_MS,
  useShiftParticipation,
} from "../src/floor/work/use-shift-participation.js";
import type { EnteredShift } from "../src/host/protocol.js";
import type { LocalExecutor } from "../src/local/executor.js";
import { DEVICE_ID, HOST_ID } from "./support/fixtures.js";
import { openLocalDb } from "./support/local-db.js";
import {
  enteredOf,
  SHARED,
  SHARED_ENTERED,
  sharedShift,
  STATION_ROW,
} from "./support/multi-station.js";

const PAIRING = { hostId: HOST_ID, deviceId: DEVICE_ID };

async function stationWith(entered: EnteredShift = SHARED_ENTERED): Promise<LocalExecutor> {
  const { executor } = openLocalDb();
  await keepEnteredShift(executor, PAIRING, entered, "2026-10-08T06:02:00.000Z", 1);
  return executor;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the work screen's figures of a shared shift (plan 2b)", () => {
  it("reads the cache, and reads it again after every read of the host's list", async () => {
    const local = await stationWith();
    const { result, rerender } = renderHook(
      (props: { reads: number }) =>
        useShiftParticipation({
          local,
          pairing: PAIRING,
          shiftId: SHARED.id,
          shiftReads: props.reads,
          online: false,
        }),
      { initialProps: { reads: 0 } },
    );
    await waitFor(() => expect(result.current?.totals.accepted).toBe(547));
    const later = enteredOf(
      sharedShift({
        participants: [{ row: STATION_ROW, accepted: 600 }],
        myState: "active",
        asOf: "2026-10-08T09:50:00Z",
      }),
    );
    await keepEnteredShift(local, PAIRING, later, "2026-10-08T09:50:00.000Z", 2);
    rerender({ reads: 1 });
    await waitFor(() => expect(result.current?.totals.accepted).toBe(600));
  });

  it("asks the link for the list every 15 s while the shift is shared and the link is up, and not without the link", async () => {
    const local = await stationWith();
    const onRefresh = vi.fn();
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { result, rerender, unmount } = renderHook(
      (props: { online: boolean }) =>
        useShiftParticipation({
          local,
          pairing: PAIRING,
          shiftId: SHARED.id,
          shiftReads: 0,
          online: props.online,
          onRefresh,
        }),
      { initialProps: { online: true } },
    );
    await waitFor(() => expect(result.current).not.toBeNull());
    act(() => {
      vi.advanceTimersByTime(SHIFT_TOTALS_POLL_MS * 2);
    });
    expect(onRefresh).toHaveBeenCalledTimes(2);
    rerender({ online: false });
    act(() => {
      vi.advanceTimersByTime(SHIFT_TOTALS_POLL_MS * 2);
    });
    expect(onRefresh).toHaveBeenCalledTimes(2);
    unmount();
  });

  it("never asks for a solo shift on a line of one", async () => {
    const solo = enteredOf(
      sharedShift({
        participants: [{ row: STATION_ROW, accepted: 5 }],
        maxStations: 1,
        myState: "active",
      }),
    );
    const local = await stationWith(solo);
    const onRefresh = vi.fn();
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { result } = renderHook(() =>
      useShiftParticipation({
        local,
        pairing: PAIRING,
        shiftId: solo.id,
        shiftReads: 0,
        online: true,
        onRefresh,
      }),
    );
    await waitFor(() => expect(result.current?.maxStations).toBe(1));
    act(() => {
      vi.advanceTimersByTime(SHIFT_TOTALS_POLL_MS * 3);
    });
    expect(onRefresh).not.toHaveBeenCalled();
  });
});
```

Create `apps/standalone/test/floor-shared-strip.test.tsx`:

```tsx
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import { formatClock, formatQuantity } from "../src/floor/shifts/shift-text.js";
import { ShiftBand } from "../src/floor/work/WorkInstruments.js";
import { enteredShift, km } from "./support/floor-work.js";
import { openLocalDb } from "./support/local-db.js";
import {
  enteredOf,
  HANDHELD,
  participant,
  SHARED_ENTERED,
  sharedShift,
  STATION_ROW,
} from "./support/multi-station.js";
import { renderWork } from "./support/work-screen.js";

const count = () => document.querySelector(".work-shift-band__count")?.textContent ?? null;
const mine = () =>
  document.querySelector(".work-shift-band__small--mine .work-shift-band__small-count")
    ?.textContent ?? null;

function band(
  shared: { mine: number; total: number; asOf: string; stale: boolean },
  plannedQty: number | null,
) {
  render(
    <ThemeProvider>
      <ShiftBand
        productName="Молоко 3,2% 0,9 л"
        gtin="04600682000013"
        number="OCT26-004"
        counterpartyName={null}
        accepted={shared.mine}
        plannedQty={plannedQty}
        modeLabel="Агрегация"
        shared={shared}
      />
    </ThemeProvider>,
  );
}

describe("the strip of a shared shift (plan 2b, spec §5 «Рабочий экран»)", () => {
  it("says this station's count and the whole shift's against the plan, and names them in the owner's words", () => {
    band({ mine: 427, total: 547, asOf: "2026-10-08T09:41:07Z", stale: false }, 1200);
    expect(screen.getByText("Всего в смене")).toBeTruthy();
    expect(screen.getByText("Моя станция")).toBeTruthy();
    expect([count(), mine()]).toEqual(["547", "427"]);
    expect(screen.getByText(`/ ${formatQuantity(1200)}`)).toBeTruthy();
    expect(
      screen.getByRole("group", {
        name: `Моя станция: 427 · Всего в смене: 547 из ${formatQuantity(1200)}`,
      }),
    ).toBeTruthy();
    expect(screen.queryByText(/данные от/)).toBeNull();
  });

  it("says how old the host's part is when the link is down", () => {
    band({ mine: 3, total: 5, asOf: "2026-10-08T09:41:07Z", stale: true }, 1200);
    expect(screen.getByText(`данные от ${formatClock("2026-10-08T09:41:07Z")}`)).toBeTruthy();
  });

  it("names the counts of a shift without a plan", () => {
    band({ mine: 3, total: 5, asOf: "2026-10-08T09:41:07Z", stale: false }, null);
    expect(screen.getByRole("group", { name: "Моя станция: 3 · Всего в смене: 5" })).toBeTruthy();
  });
});

describe("the work screen of a shared shift (plan 2b)", () => {
  it("counts the whole shift with this station's own scans at once, and closes «мою часть»", async () => {
    const { executor } = openLocalDb();
    const shift = await enteredShift(executor, SHARED_ENTERED);
    const work = renderWork(
      { local: executor, shift },
      { overrides: { online: true, shiftReads: 1 } },
    );
    // The others' part by the host (547 − 427 = 120); this station holds no code of it here.
    await waitFor(() => expect(count()).toBe("120"));
    expect(mine()).toBe("0");
    await work.scanner.listening();
    await work.scan(km("A1"));
    await waitFor(() => expect(count()).toBe("121"));
    expect(mine()).toBe("1");
    expect(screen.getByRole("button", { name: "Закрыть мою часть" })).toBeTruthy();
    expect(screen.queryByText(/данные от/)).toBeNull();
  });

  it("marks the host's figures with their time when the link is down", async () => {
    const { executor } = openLocalDb();
    const shift = await enteredShift(executor, SHARED_ENTERED);
    renderWork({ local: executor, shift }, { overrides: { online: false } });
    expect(
      await screen.findByText(`данные от ${formatClock("2026-10-08T09:41:07Z")}`),
    ).toBeTruthy();
  });

  it("reaches the plan by the whole shift, once, until it is dismissed", async () => {
    const near = enteredOf(
      sharedShift({
        participants: [
          { row: STATION_ROW, accepted: 0 },
          { row: participant(HANDHELD, "ТСД 1", "active", "handheld"), accepted: 1199 },
        ],
        myState: "active",
      }),
    );
    const { executor } = openLocalDb();
    const shift = await enteredShift(executor, near);
    const work = renderWork({ local: executor, shift }, { overrides: { online: true } });
    await waitFor(() => expect(count()).toBe(formatQuantity(1199)));
    expect(screen.queryByText(/План выполнен/)).toBeNull();
    await work.scanner.listening();
    await work.scan(km("A1"));
    expect(
      await screen.findByText(
        `План выполнен: принято ${formatQuantity(1200)} из ${formatQuantity(1200)}.`,
      ),
    ).toBeTruthy();
    await work.press("Продолжить");
    expect(screen.queryByText(/План выполнен/)).toBeNull();
    await work.scan(km("A2"));
    await waitFor(() => expect(count()).toBe(formatQuantity(1201)));
    expect(screen.queryByText(/План выполнен/)).toBeNull();
  });

  it("keeps a solo station's screen as it was on a line of one", async () => {
    const solo = enteredOf(
      sharedShift({
        participants: [{ row: STATION_ROW, accepted: 5 }],
        maxStations: 1,
        myState: "active",
      }),
    );
    const { executor } = openLocalDb();
    const shift = await enteredShift(executor, solo);
    renderWork({ local: executor, shift }, { overrides: { online: true } });
    expect(await screen.findByText("Принято в смене")).toBeTruthy();
    expect(screen.queryByText("Всего в смене")).toBeNull();
    expect(screen.getByRole("button", { name: "Закрыть смену" })).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run them to verify they fail.**

Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-shift-text.test.ts test/use-shift-participation.test.tsx test/floor-shared-strip.test.tsx`
Expected: FAIL — `formatClock` / `use-shift-participation.js` missing; the band ignores `shared`.

- [ ] **Step 3: Add the strings.** In `apps/standalone/src/i18n/ru.json` replace

```json
      "accepted": "Принято в смене",
      "closedBoxes": "Коробов закрыто",
```

with

```json
      "accepted": "Принято в смене",
      "shared": {
        "total": "Всего в смене",
        "mine": "Моя станция",
        "summary": "Моя станция: {{mine}} · Всего в смене: {{total}} из {{planned}}",
        "summaryNoPlan": "Моя станция: {{mine}} · Всего в смене: {{total}}",
        "asOf": "данные от {{time}}"
      },
      "closedBoxes": "Коробов закрыто",
```

and

```json
    "close": {
      "open": "Закрыть смену",
```

with

```json
    "close": {
      "open": "Закрыть смену",
      "openPart": "Закрыть мою часть",
```

- [ ] **Step 4: Implement the clock and the hook.** Append to `apps/standalone/src/floor/shifts/shift-text.ts`:

```ts
const CLOCK = new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" });

/**
 * An instant as the floor's «ЧЧ:ММ» on this computer's clock (plan 2b: «данные от ЧЧ:ММ», the
 * host's time of a shared shift's figures); text that is no instant is said as it is.
 */
export function formatClock(instant: string): string {
  const at = new Date(instant);
  return Number.isNaN(at.getTime()) ? instant : CLOCK.format(at);
}
```

Create `apps/standalone/src/floor/work/use-shift-participation.ts`:

```ts
import { useEffect, useState } from "react";

import type { LocalExecutor } from "../../local/executor.js";
import type { Pairing } from "../../local/reference-sync.js";
import {
  readParticipation,
  sharedParticipation,
  type Participation,
} from "../shifts/shift-participation.js";

/** How often the work screen of a shared shift asks the link for the list (plan 2b, host D11). */
export const SHIFT_TOTALS_POLL_MS = 15_000;

export interface ShiftParticipationInput {
  local: LocalExecutor;
  pairing: Pairing;
  shiftId: string;
  /** `ShellState.shiftReads.done`: the cache is read again after every read of the host's list. */
  shiftReads: number;
  /** The link is up: only then is the list asked for. */
  online: boolean;
  /** Asks the link to read the list now (`HostLinkControls.requestShifts`); none — never asked. */
  onRefresh?: () => void;
}

/**
 * What the host's last read said of the work screen's shift (plan 2b): read from the cache when
 * the screen opens and after every read of the host's list; while the shift is shared and the link
 * is up, the link is asked to read the list every `SHIFT_TOTALS_POLL_MS` — another device's scan
 * takes no revision on the host, so nothing else would bring its count. It only reads and asks:
 * nothing here writes or sends, so nothing is handed to the work gate. A failed read keeps what was
 * read before.
 */
export function useShiftParticipation(input: ShiftParticipationInput): Participation | null {
  const { local, shiftId, shiftReads, online, onRefresh } = input;
  const { hostId, deviceId } = input.pairing;
  const [participation, setParticipation] = useState<Participation | null>(null);
  useEffect(() => {
    let cancelled = false;
    readParticipation(local, { hostId, deviceId }, shiftId).then(
      (read) => {
        if (!cancelled) setParticipation(read);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
    // `shiftReads` is the trigger: every read of the host's list brings figures to read again.
  }, [local, hostId, deviceId, shiftId, shiftReads]);
  const shared = sharedParticipation(participation) !== null;
  useEffect(() => {
    if (!online || !shared || onRefresh === undefined) return undefined;
    const timer = setInterval(onRefresh, SHIFT_TOTALS_POLL_MS);
    return () => clearInterval(timer);
  }, [online, shared, onRefresh]);
  return participation;
}
```

- [ ] **Step 5: Draw the strip.** In `apps/standalone/src/floor/work/WorkInstruments.tsx` change the import of `shift-text.js` to `import { formatClock, formatQuantity } from "../shifts/shift-text.js";`, add to `ShiftBandProps` after `productId?: string;`:

```ts
  /**
   * A shift several devices work (plan 2b): this station's own count (`mine`), the whole shift's
   * (`total`: the others' part by the host and `mine`), the host's time of its part (`asOf`), and
   * whether the link is down, when that time is said («данные от ЧЧ:ММ»).
   */
  shared?: { mine: number; total: number; asOf: string; stale: boolean };
```

add `shared,` to the destructured props of `ShiftBand`, and replace from
`const ratio = plannedQty === null …` (`:69`) to the end of the counters' `div` (`:136`) so that
the counters read:

```tsx
// A shared shift counts and plans by the whole shift (plan 2b); a solo one by its own codes.
const counted = shared === undefined ? accepted : shared.total;
const ratio = plannedQty === null || plannedQty <= 0 ? null : Math.min(1, counted / plannedQty);
const totalLabel = t(shared === undefined ? "floor.work.accepted" : "floor.work.shared.total");
const summary =
  shared === undefined
    ? null
    : plannedQty === null
      ? t("floor.work.shared.summaryNoPlan", {
          mine: formatQuantity(shared.mine),
          total: formatQuantity(shared.total),
        })
      : t("floor.work.shared.summary", {
          mine: formatQuantity(shared.mine),
          total: formatQuantity(shared.total),
          planned: formatQuantity(plannedQty),
        });
```

(this block replaces the single `const ratio …` line, before `return (`), and the counters
`div` becomes:

```tsx
<div
  className="work-shift-band__counters"
  {...(summary === null ? {} : { role: "group", "aria-label": summary })}
>
  <div className="work-shift-band__total">
    <p className="work-shift-band__label">{totalLabel}</p>
    <p className="work-shift-band__count">{formatQuantity(counted)}</p>
    {plannedQty !== null && ratio !== null && (
      <>
        <p className="work-shift-band__planned">{`/ ${formatQuantity(plannedQty)}`}</p>
        <div
          className="work-shift-band__bar"
          role="progressbar"
          aria-label={totalLabel}
          aria-valuemin={0}
          aria-valuemax={plannedQty}
          aria-valuenow={Math.min(counted, plannedQty)}
          aria-valuetext={`${formatQuantity(counted)} / ${formatQuantity(plannedQty)}`}
        >
          <span style={{ width: `${Math.round(ratio * 1000) / 10}%` }} />
        </div>
        <p className="work-shift-band__meta">
          {t("floor.work.layout.planPercent", {
            percent: PERCENT.format(counted / plannedQty),
          })}
        </p>
      </>
    )}
    {shared?.stale === true && (
      <p className="work-shift-band__stale">
        {t("floor.work.shared.asOf", { time: formatClock(shared.asOf) })}
      </p>
    )}
  </div>
  {shared !== undefined && (
    <div className="work-shift-band__small work-shift-band__small--mine">
      <p className="work-shift-band__label">{t("floor.work.shared.mine")}</p>
      <p className="work-shift-band__small-count">{formatQuantity(shared.mine)}</p>
    </div>
  )}
  {refused !== undefined && (
    <>
      <div className="work-shift-band__small">
        <p className="work-shift-band__label">{t("floor.validation.duplicates")}</p>
        <p className="work-shift-band__small-count">{formatQuantity(refused.duplicates)}</p>
      </div>
      <div className="work-shift-band__small">
        <p className="work-shift-band__label">{t("floor.validation.errors")}</p>
        <p className="work-shift-band__small-count">{formatQuantity(refused.errors)}</p>
      </div>
    </>
  )}
</div>
```

Extend the component's doc comment with: «A shift several devices work (plan 2b) shows the whole
shift's count in the large counter («Всего в смене», the plan by it) and this station's own in a
small one beside it («Моя станция»), the group named «Моя станция: N · Всего в смене: K из M»; the
time of the host's figures is said under the total while the link is down.»

In `apps/standalone/src/floor/work/work-screen.css`, after the `.work-shift-band__bar > span { … }` rule:

```css
/* Plan 2b: the age of the host's part of a shared total, said only without the link. It stays on a
   short window, where the plan's bar and percent give their line up. */
.work-shift-band__stale {
  margin: 0;
  font: 600 13px/16px var(--font-ui);
  white-space: nowrap;
}
```

and inside `@media (max-height: 780px)`, after `.work-shift-band__bar, .work-shift-band__meta { display: none; }`:

```css
.work-shift-band__stale {
  font: 600 12px/14px var(--font-ui);
}
```

- [ ] **Step 6: Wire the work screen.** In `apps/standalone/src/floor/work/WorkScreen.tsx`:

Add the imports:

```ts
import { sharedCount, sharedParticipation } from "../shifts/shift-participation.js";
import { useShiftParticipation } from "./use-shift-participation.js";
```

In `WorkScreenProps`, after `officeClosed?: boolean;`:

```ts
  /**
   * `ShellState.shiftReads.done` (plan 2b): what the host's last read said of a shared shift is
   * read again after every read of the list. Absent: read once.
   */
  shiftReads?: number;
  /**
   * Asks the link to read the host's list now (`HostLinkControls.requestShifts`, plan 2b): a
   * shared shift's totals are asked every `SHIFT_TOTALS_POLL_MS` while the link is up.
   */
  onRefreshShifts?: () => void;
```

After `const [planReached, setPlanReached] = useState(false);` (`:811`):

```ts
// A shared shift's plan notice was dismissed (plan 2b): it is derived from the whole shift's
// count, and comes back no more.
const [planDismissed, setPlanDismissed] = useState(false);
```

After `const plannedQty = shift.copy.plannedQty;` (`:834`):

```ts
// Plan 2b: what the host's last read said of a shift several devices may work; `null` for a
// solo shift, whose screen is stage 2a's.
const participation = useShiftParticipation({
  local: props.local,
  pairing: props.pairing,
  shiftId: shift.copy.id,
  shiftReads: props.shiftReads ?? 0,
  online: props.online,
  ...(props.onRefreshShifts === undefined ? {} : { onRefresh: props.onRefreshShifts }),
});
const sharedPart = sharedParticipation(participation);
```

In `openClose` (`:1967-1975`) add `setPlanDismissed(true);` after `setPlanReached(false);`.

After `const canClose = items > 0 && stop === null && !leaving;` (render prelude, `:2318`):

```ts
// Plan 2b: the whole shift's count — the others' part by the host and this station's own codes —
// and the plan reached by it, said once until dismissed or the close opens.
const shared =
  sharedPart === null
    ? null
    : sharedCount(sharedPart, props.pairing.deviceId, totals?.accepted ?? 0);
const sharedReached =
  shared !== null &&
  plannedQty !== null &&
  plannedQty > 0 &&
  shared.total >= plannedQty &&
  !planDismissed &&
  stop?.kind !== "close" &&
  stop?.kind !== "closed";
const planShowing = planReached || sharedReached;
const closeLabel = t(shared === null ? "floor.close.open" : "floor.close.openPart");
```

In the `<ShiftBand …>` element (`:2401-2422`) add, after `productId={shift.copy.productId}`:

```tsx
            {...(shared === null
              ? {}
              : {
                  shared: {
                    mine: shared.mine,
                    total: shared.total,
                    asOf: shared.asOf,
                    stale: !props.online,
                  },
                })}
```

In the footer's close action (`:2589-2596`) replace `{t("floor.close.open")}` with `{closeLabel}`.

Replace the plan notice (`:2666-2694`) with:

```tsx
{
  planShowing &&
    card(
      "ok",
      t("floor.work.planReached", {
        quantity: formatQuantity(shared?.total ?? totals?.accepted ?? 0),
        planned: formatQuantity(plannedQty ?? 0),
      }),
      null,
      <>
        {/* A validation shift is offered its close at the plan, as at the cloud station. */}
        {validation && (
          <Button
            size="floor"
            aria-disabled={leaving || stop !== null ? true : undefined}
            style={leaving || stop !== null ? WAITING_STYLE : undefined}
            onClick={openClose}
          >
            {closeLabel}
          </Button>
        )}
        <Button
          size="floor"
          variant="secondary"
          onClick={() =>
            dismiss(() => {
              setPlanReached(false);
              setPlanDismissed(true);
            })
          }
        >
          {t("floor.work.continue")}
        </Button>
      </>,
    );
}
```

In `apps/standalone/src/floor/FloorApp.tsx`, in the `<Work …>` element (`:477-503`), after
`officeClosed={view.officeClosed}`:

```tsx
        shiftReads={shiftReads.done}
        {...(requestShifts === undefined ? {} : { onRefreshShifts: requestShifts })}
```

- [ ] **Step 7: Run the tests to verify they pass.**

Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-shift-text.test.ts test/use-shift-participation.test.tsx test/floor-shared-strip.test.tsx test/floor-work-screen.test.tsx test/validation-screen.test.tsx test/work-screen-fit.test.tsx test/floor-app.test.tsx test/unit-label-screen.test.tsx test/floor-product-photo-path.test.tsx`
Expected: PASS (a solo shift's band and labels are unchanged). Typecheck and lint: no errors.

- [ ] **Step 8: Commit.**

```bash
git -C "$WT" add apps/standalone/src/floor/work/use-shift-participation.ts apps/standalone/src/floor/shifts/shift-text.ts \
  apps/standalone/src/floor/work/WorkInstruments.tsx apps/standalone/src/floor/work/work-screen.css \
  apps/standalone/src/floor/work/WorkScreen.tsx apps/standalone/src/floor/FloorApp.tsx apps/standalone/src/i18n/ru.json \
  apps/standalone/test/floor-shift-text.test.ts apps/standalone/test/use-shift-participation.test.tsx \
  apps/standalone/test/floor-shared-strip.test.tsx
git -C "$WT" commit -m "feat(standalone): work screen counts my station and the whole shift, marks old figures, plans by the total

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 9: The strip's measuring guard at the whole matrix

**Files:**

- Modify: `apps/standalone/test/harness/work-fit/main.tsx:34-42` (query), `:175-188` (`ShiftBand`)
- Modify: `apps/standalone/test/harness/station-fit/measure-others.mjs:49-61` (`WORK_CASES`)
- Test: `apps/standalone/test/floor-station-audit.test.ts` (new describe at the end)

**Interfaces:**

- Consumes: Task 8 `ShiftBandProps.shared`.
- Produces: harness query `shared=1` (with `stale=1`).

- [ ] **Step 1: Write the failing audit pin.** Append to `apps/standalone/test/floor-station-audit.test.ts`:

```ts
describe("the shared shift's strip (plan 2b)", () => {
  const work = rulesOf("src/floor/work/work-screen.css");

  it("keeps the age of the host's figures on a short window, where the plan's bar and percent go", () => {
    expect(rule(work, ".work-shift-band__stale")["white-space"]).toBe("nowrap");
    expect(
      rule(work, ".work-shift-band__stale", "@media (max-height: 780px)")["display"],
    ).toBeUndefined();
    expect(rule(work, ".work-shift-band__meta", "@media (max-height: 780px)")["display"]).toBe(
      "none",
    );
  });

  it("measures the shared strip on the whole matrix, stale and big", () => {
    const cases = textOf("test/harness/station-fit/measure-others.mjs");
    expect(cases).toContain("shared=1");
    expect(cases).toContain("shared=1&stale=1");
  });
});
```

- [ ] **Step 2: Run it to verify it fails.**

Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-station-audit.test.ts -t "shared shift's strip"`
Expected: FAIL on the second test.

- [ ] **Step 3: Give the harness a shared band.** In `apps/standalone/test/harness/work-fit/main.tsx`, after `const longName = query.get("long") === "1";`:

```ts
// Plan 2b: the band of a shift several devices work, its figures old without the link.
const shared = query.get("shared") === "1";
const stale = query.get("stale") === "1";
```

and in the `<ShiftBand …>` element, after `modeLabel={…}`:

```tsx
                  {...(shared
                    ? {
                        shared: {
                          mine: big ? 61728 : items,
                          total: big ? 123456 : items * 3,
                          asOf: "2026-10-08T09:41:07Z",
                          stale,
                        },
                      }
                    : {})}
```

In `apps/standalone/test/harness/station-fit/measure-others.mjs` add to `WORK_CASES` after `"mode=check&rows=0",`:

```js
  // Plan 2b: the strip of a shared shift — plain, with pallets big and stale with long names,
  // a validation band with its three small counters, stale.
  "mode=plain&capacity=12&items=5&shared=1",
  "mode=pallets&capacity=6&items=4&big=1&long=1&photo=jpeg&shared=1&stale=1",
  "mode=check&rows=3&big=1&shared=1&stale=1",
  "mode=check&rows=0&shared=1",
```

- [ ] **Step 4: Run the pin and the guards.**

Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-station-audit.test.ts`
Expected: PASS.
Run (Chromium; macOS sandbox off): `PLAYWRIGHT_CORE=<path> pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/station-fit.browser.test.ts test/work-screen-fit.browser.test.ts`
Expected: PASS. If the guard reports the band's counters overflowing at 1024 wide for `mode=check…&shared=1&stale=1` (four counters and the stale line), add inside `@media (max-height: 880px)` of `work-screen.css`:

```css
/* Plan 2b: a validation band of a shared shift holds four counters; the small ones narrow. */
.work-shift-band__small--mine,
.work-shift-band__counters:has(.work-shift-band__small--mine) .work-shift-band__small {
  min-width: 64px;
}
```

and run the guards again. If `PLAYWRIGHT_CORE` is unavailable, record «guards not run» in the report.

- [ ] **Step 5: Commit.**

```bash
git -C "$WT" add apps/standalone/test/harness/work-fit/main.tsx apps/standalone/test/harness/station-fit/measure-others.mjs \
  apps/standalone/test/floor-station-audit.test.ts apps/standalone/src/floor/work/work-screen.css
git -C "$WT" commit -m "test(standalone): guard measures the shared strip on the whole matrix

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

(Stage `work-screen.css` only if Step 4 changed it.)

---

### Task 10: «Закрыть мою часть» — the same blockers, the reason only of the last closer online

**Files:**

- Modify: `apps/standalone/src/floor/close/shift-close.ts:1-16` (imports), `:37-48` (`CloseSummary`), `:127-178` (`readCloseSummary`), `:224-235` (`closeShift`)
- Modify: `apps/standalone/src/floor/close/ShiftClosePanel.tsx:46-63` (`sameSummary`), `:135-163` (props), `:181-392` (`ShiftClosePanel`)
- Modify: `apps/standalone/src/floor/close/shift-close.css` (append)
- Modify: `apps/standalone/src/floor/work/WorkScreen.tsx:1338-1341` (`readSummaryNow`), `:1381` (`closeShift` call), `:1957-1965` (`readSummary`), `:2781-2797` (`<ShiftClosePanel>`)
- Modify: `apps/standalone/src/i18n/ru.json:864-868` (`floor.close`, after `done`)
- Test: `apps/standalone/test/floor-close-part.test.tsx` (new)

**Interfaces:**

- Consumes: Task 1 `stationReasonRequired`; Task 3 `readParticipation`, `sharedParticipation`, `closesShift`, `participantsEver`, `sharedCount`; Task 8 `sharedPart` in the work screen.
- Produces:
  - `interface PartClose { closesShift: boolean; total: number; online: boolean }`; `CloseSummary.part?: PartClose`
  - `readCloseSummary(local, pairing, shiftId, online?: boolean): Promise<CloseSummary>` (default `false`)
  - `closeShift(context, reasonCode, guards?, online?: boolean): Promise<CloseResult>` (default `false`)
  - `ShiftClosePanelProps.ownPart?: boolean`
  - i18n `floor.close.part.*` (incl. `done.*`, used by Task 11)

- [ ] **Step 1: Write the failing tests.** Create `apps/standalone/test/floor-close-part.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import { ShiftClosePanel } from "../src/floor/close/ShiftClosePanel.js";
import { closeShift, readCloseSummary, type CloseSummary } from "../src/floor/close/shift-close.js";
import type { WorkShift } from "../src/floor/shifts/shift-copies.js";
import { formatQuantity } from "../src/floor/shifts/shift-text.js";
import type { ShiftParticipant } from "../src/host/protocol.js";
import { enteredShift, PAIRING, rows, scanContext } from "./support/floor-work.js";
import { openLocalDb } from "./support/local-db.js";
import {
  enteredOf,
  OTHER_STATION,
  participant,
  sharedShift,
  STATION_ROW,
} from "./support/multi-station.js";

/**
 * This station (no code yet) and another station in `other` state (`"none"`: this station alone),
 * 2 to the line, 1 200 planned.
 */
async function sharedStation(other: ShiftParticipant["state"] | "none", maxStations = 2) {
  const opened = openLocalDb();
  const rowsOf =
    other === "none"
      ? [{ row: STATION_ROW, accepted: 0 }]
      : [
          { row: STATION_ROW, accepted: 0 },
          { row: participant(OTHER_STATION, "Станция линии 2", other), accepted: 300 },
        ];
  const shift: WorkShift = await enteredShift(
    opened.executor,
    enteredOf(sharedShift({ participants: rowsOf, maxStations, myState: "active" })),
  );
  return { ...opened, shift };
}

describe("the summary of this station's part of a shared shift (plan 2b)", () => {
  it("names the whole shift's count and that the shift waits for the others; no reason asked", async () => {
    const { executor, shift } = await sharedStation("active");
    expect(await readCloseSummary(executor, PAIRING, shift.copy.id, true)).toMatchObject({
      plannedQty: 1200,
      actualQty: 0,
      reasonRequired: false,
      blocker: null,
      part: { closesShift: false, total: 300, online: true },
    });
  });

  it("asks the last closer for the reason online, and never offline (spec §12.9)", async () => {
    const { executor, shift } = await sharedStation("closed");
    expect(await readCloseSummary(executor, PAIRING, shift.copy.id, true)).toMatchObject({
      reasonRequired: true,
      part: { closesShift: true, total: 300, online: true },
    });
    expect(await readCloseSummary(executor, PAIRING, shift.copy.id, false)).toMatchObject({
      reasonRequired: false,
      part: { closesShift: true, online: false },
    });
  });

  it("keeps stage 2a's reason, offline too, for a shift only this station ever worked", async () => {
    const { executor, shift } = await sharedStation("none");
    expect(await readCloseSummary(executor, PAIRING, shift.copy.id, false)).toMatchObject({
      reasonRequired: true,
      part: { closesShift: true, total: 0, online: false },
    });
  });

  it("closes the last part offline without a reason: the record carries none, the host marks it", async () => {
    const { db, executor, shift } = await sharedStation("closed");
    const result = await closeShift(scanContext(executor, shift), null, [], false);
    expect(result).toMatchObject({ kind: "closed", record: { reasonCode: null, actualQty: 0 } });
    expect(rows(db, "SELECT kind FROM outbox WHERE shift_id = ?", shift.copy.id)).toEqual([
      { kind: "shift_closed" },
    ]);
  });

  it("refuses the last close online without the reason the panel asks for", async () => {
    const { executor, shift } = await sharedStation("closed");
    expect(await closeShift(scanContext(executor, shift), null, [], true)).toEqual({
      kind: "reason_required",
    });
    expect(
      await closeShift(scanContext(executor, shift), "equipment_stop", [], true),
    ).toMatchObject({ kind: "closed", record: { reasonCode: "equipment_stop" } });
  });
});

/** The panel over `summary`; `pause()` lets the guard after a change of view pass, as an operator's pause does. */
function panel(summary: CloseSummary) {
  const onClose = vi.fn();
  const clock = { now: 0 };
  render(
    <ThemeProvider>
      <ShiftClosePanel
        number="OCT26-004"
        productName="Молоко 3,2% 0,9 л"
        summary={summary}
        note={null}
        attempt={0}
        waitingSscc={null}
        busy={false}
        onClose={onClose}
        onBack={vi.fn()}
        onLabel={vi.fn()}
        ownPart
        clock={() => clock.now}
      />
    </ThemeProvider>,
  );
  return {
    onClose,
    pause: () => {
      clock.now += 1_000;
    },
  };
}

const PART: CloseSummary = {
  plannedQty: 600,
  actualQty: 280,
  closedBoxes: 23,
  reasonRequired: false,
  blocker: null,
  part: { closesShift: false, total: 560, online: true },
};

describe("the close panel of a part (plan 2b)", () => {
  it("names the part, both counts, the whole shift against the plan, and that the others close later", () => {
    const { onClose, pause } = panel(PART);
    expect(
      screen.getByRole("heading", { name: "Закрытие моей части смены OCT26-004" }),
    ).toBeTruthy();
    expect(screen.getByText("Моя станция")).toBeTruthy();
    expect(screen.getByText("Всего в смене")).toBeTruthy();
    expect(screen.getByText("План смены")).toBeTruthy();
    expect(screen.getByText("−40")).toBeTruthy();
    expect(screen.getByText("План не выполнен: не хватает 40 шт.")).toBeTruthy();
    expect(screen.getByText("Смена закроется, когда закроют остальные.")).toBeTruthy();
    expect(
      screen.queryByRole("group", { name: "Факт не совпадает с планом. Выберите причину:" }),
    ).toBeNull();
    pause();
    fireEvent.click(screen.getByRole("button", { name: "Подтвердить закрытие части" }));
    expect(onClose).toHaveBeenCalledWith(null);
  });

  it("asks the last closer online for one of the six reasons before the close", () => {
    const { onClose, pause } = panel({
      ...PART,
      reasonRequired: true,
      part: { closesShift: true, total: 560, online: true },
    });
    expect(
      screen.getByText("Остальные уже закрыли свои части: смена закроется вместе с вашей."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Подтвердить закрытие части" })).toHaveProperty(
      "disabled",
      true,
    );
    pause();
    fireEvent.click(screen.getByRole("button", { name: "Остановка оборудования" }));
    fireEvent.click(screen.getByRole("button", { name: "Подтвердить закрытие части" }));
    expect(onClose).toHaveBeenCalledWith("equipment_stop");
  });

  it("says what an offline close leaves to the host and the office", () => {
    panel({ ...PART, part: { closesShift: true, total: 560, online: false } });
    expect(
      screen.getByText(
        "Нет связи с хостом: ваша часть закроется сейчас, итог смены посчитает хост. Если понадобится причина расхождения, её укажет офис.",
      ),
    ).toBeTruthy();
    expect(screen.getByText(formatQuantity(560))).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run them to verify they fail.**

Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-close-part.test.tsx`
Expected: FAIL — the summary has no `part`, the reason follows stage 2a's rule, the panel's words are a solo shift's.

- [ ] **Step 3: Add the strings.** In `apps/standalone/src/i18n/ru.json` replace

```json
        "toList": "К списку смен"
      }
    },
    "setup": {
```

with

```json
        "toList": "К списку смен"
      },
      "part": {
        "title": "Закрытие моей части смены {{number}}",
        "planShift": "План смены",
        "mine": "Моя станция",
        "total": "Всего в смене",
        "boxes": "Коробов закрыто этой станцией",
        "othersOpen": "Смена закроется, когда закроют остальные.",
        "last": "Остальные уже закрыли свои части: смена закроется вместе с вашей.",
        "offline": "Нет связи с хостом: ваша часть закроется сейчас, итог смены посчитает хост. Если понадобится причина расхождения, её укажет офис.",
        "irreversible": "Закрытие части нельзя отменить: эта станция больше не сканирует в смену.",
        "palletIrreversible": "Паллета закроется с этими коробами, её этикетка уйдёт на печать, а ваша часть смены закроется. Отменить это нельзя.",
        "confirm": "Подтвердить закрытие части",
        "confirmPallet": "Закрыть паллету и мою часть",
        "closing": "Закрываем вашу часть…",
        "done": {
          "title": "Ваша часть смены {{number}} закрыта",
          "queued": "Ваша часть закрыта на этой станции. Данные будут отправлены автоматически.",
          "waiting": "Хост принял закрытие вашей части. Смена закроется, когда закроют остальные.",
          "shift_closed": "Смена закрыта: все её части закрыты.",
          "reason_missing": "Смена закрыта, но без причины расхождения с планом: её укажет офис.",
          "refused": "Хост не принял закрытие вашей части. Откройте «Очередь отправки»: там видно, что делать."
        }
      }
    },
    "setup": {
```

- [ ] **Step 4: Implement the summary and the close.** In `apps/standalone/src/floor/close/shift-close.ts`:

Add to the imports:

```ts
import {
  closesShift,
  participantsEver,
  readParticipation,
  sharedCount,
  sharedParticipation,
} from "../shifts/shift-participation.js";
import { stationReasonRequired } from "./shared-reason.js";
```

and remove `shiftCloseReasonRequired` from the `@markiro/domain` import (it moves to `shared-reason.ts`).

Add after `CloseBlocker`, and add the member to `CloseSummary` after `blocker: CloseBlocker | null;`:

```ts
/** What a part's close of a shared shift does (plan 2b), as the station knows it. */
export interface PartClose {
  /** By the last read, no other participant stays active or left: this close closes the shift. */
  closesShift: boolean;
  /** The whole shift's count: the others' part by the host and this station's own codes. */
  total: number;
  /** The link was up when the summary was read: only then can a shared close ask for a reason. */
  online: boolean;
}
```

```ts
  /** A shift several devices may work (plan 2b): this station closes only its part. Absent: a solo shift. */
  part?: PartClose;
```

Replace the signature and the tail of `readCloseSummary` (`:134-178`) with:

```ts
export async function readCloseSummary(
  local: LocalExecutor,
  pairing: Pairing,
  shiftId: string,
  online = false,
): Promise<CloseSummary> {
  const copy = await readShiftCopy(local, pairing, shiftId);
  const [row] = await local.query(
    CLOSE_SUMMARY_SQL,
    [pairing.hostId, pairing.deviceId, shiftId],
    summaryRow,
  );
  const [unresolved] = await local.query(
    SHIFT_UNRESOLVED_UNIT_LABEL_SQL,
    [pairing.hostId, pairing.deviceId, shiftId],
    unresolvedRow,
  );
  if (copy === null || row === undefined) {
    return {
      plannedQty: null,
      actualQty: 0,
      closedBoxes: 0,
      reasonRequired: false,
      blocker: { kind: "closed" },
    };
  }
  const blocker: CloseBlocker | null =
    row.local_state !== null
      ? { kind: "closed" }
      : row.open_items > 0
        ? { kind: "open_box", items: row.open_items }
        : row.waiting > 0
          ? { kind: "label" }
          : (unresolved?.n ?? 0) > 0
            ? { kind: "label_unresolved" }
            : row.pallet_boxes > 0
              ? { kind: "open_pallet", boxes: row.pallet_boxes }
              : null;
  // Plan 2b: what the host's last read said of the shift; unreadable, the shift is a solo one.
  const participation = await readParticipation(local, pairing, shiftId).catch(() => null);
  const shared = sharedParticipation(participation);
  const part: PartClose | null =
    shared === null
      ? null
      : {
          closesShift: closesShift(shared, pairing.deviceId),
          total: sharedCount(shared, pairing.deviceId, row.actual).total,
          online,
        };
  return {
    plannedQty: copy.plannedQty,
    actualQty: row.actual,
    closedBoxes: row.closed,
    reasonRequired: stationReasonRequired({
      plannedQty: copy.plannedQty,
      actualQty: row.actual,
      participantsEver: participantsEver(participation),
      closesShift: part?.closesShift ?? true,
      online,
      total: part?.total ?? row.actual,
    }),
    blocker,
    ...(part === null ? {} : { part }),
  };
}
```

and extend its doc: «Since plan 2b it also reads what the host's last read said of a shift several devices may work: the part's close (`part`) — whether it closes the shift and the whole shift's count — and the reason by `stationReasonRequired`, so a shared close asks it only online (`online`) of the last closer.»

Change `closeShift`'s signature (`:224-228`) and first line (`:230`) to:

```ts
export async function closeShift(
  context: BoxContext,
  reasonCode: ShiftCloseReasonCode | null,
  guards: readonly LocalStatement[] = [],
  online = false,
): Promise<CloseResult> {
  const { local, pairing, shift } = context;
  const summary = await readCloseSummary(local, pairing, shift.copy.id, online);
```

and add to its doc: «`online` is the link's state for a shared shift's reason (plan 2b): the record is the same — it closes this station's part — and the host closes the shift with the last part.»

- [ ] **Step 5: Implement the panel.** In `apps/standalone/src/floor/close/ShiftClosePanel.tsx`:

Replace `sameSummary`'s `return` (`:56-62`) with:

```ts
// Plan 2b: whether the part closes the shift and the link decide the words and the reason; the
// whole shift's count moves with the other devices at every read and is not compared.
const samePart =
  shown.part === undefined || read.part === undefined
    ? shown.part === read.part
    : shown.part.closesShift === read.part.closesShift && shown.part.online === read.part.online;
return (
  shown.plannedQty === read.plannedQty &&
  shown.actualQty === read.actualQty &&
  shown.closedBoxes === read.closedBoxes &&
  shown.reasonRequired === read.reasonRequired &&
  sameBlocker &&
  samePart
);
```

Add to `ShiftClosePanelProps` after `boxless?: boolean;`:

```ts
  /** A shift several devices may work (plan 2b): this station closes only its part, said so from the first view. */
  ownPart?: boolean;
```

Add `ownPart = false,` to the destructured props after `boxless = false,`. Replace the body's
summary branch — from `const average = averagePerBox(summary.actualQty, summary.closedBoxes);`
(`:246`) to the end of its `return ( … );` (`:362`) — with:

```tsx
const average = averagePerBox(summary.actualQty, summary.closedBoxes);
const chosen = summary.reasonRequired ? reason : null;
// Plan 2b: a part of a shared shift is judged by the whole shift's count against the plan.
const part = summary.part ?? null;
const judged = part === null ? summary.actualQty : part.total;
const planned = summary.plannedQty;
return (
  <>
    <div className="shift-close__body">
      <dl className="shift-close__facts">
        <div>
          <dt>{t("floor.close.product")}</dt>
          <dd>{productName}</dd>
        </div>
        <div>
          <dt>{t(part === null ? "floor.close.plan" : "floor.close.part.planShift")}</dt>
          <dd>{planned === null ? t("floor.close.noPlan") : formatQuantity(planned)}</dd>
        </div>
        <div>
          <dt>{t(part === null ? "floor.close.actual" : "floor.close.part.mine")}</dt>
          <dd>{formatQuantity(summary.actualQty)}</dd>
        </div>
        {part !== null && (
          <div>
            <dt>{t("floor.close.part.total")}</dt>
            <dd>{formatQuantity(part.total)}</dd>
          </div>
        )}
        {planned !== null && (
          <div>
            <dt>{t("floor.close.deviation")}</dt>
            <dd>{deviation(planned, judged)}</dd>
          </div>
        )}
        {!boxless && (
          <>
            <div>
              <dt>{t(part === null ? "floor.close.boxes" : "floor.close.part.boxes")}</dt>
              <dd>{formatQuantity(summary.closedBoxes)}</dd>
            </div>
            <div>
              <dt>{t("floor.close.average")}</dt>
              <dd>{average ?? t("floor.close.none")}</dd>
            </div>
          </>
        )}
      </dl>
      {planned !== null && (
        <p
          className="shift-close__result"
          data-tone={judged === planned ? "ok" : judged < planned ? "warn" : "info"}
        >
          {judged === planned
            ? t("floor.close.result.met")
            : judged < planned
              ? t("floor.close.result.short", { quantity: formatQuantity(planned - judged) })
              : t("floor.close.result.over", { quantity: formatQuantity(judged - planned) })}
        </p>
      )}
      {part !== null && (
        <p className="shift-close__part">
          {t(
            !part.online
              ? "floor.close.part.offline"
              : part.closesShift
                ? "floor.close.part.last"
                : "floor.close.part.othersOpen",
          )}
        </p>
      )}
      {summary.reasonRequired && (
        <div
          className="shift-close__reasons"
          role="group"
          aria-label={t("floor.close.reasonTitle")}
        >
          <p className="shift-close__reasons-title">{t("floor.close.reasonTitle")}</p>
          {/* The cloud's floor choices: every reason a visible 64 px target, two to a row. */}
          <div className="floor-choice-group">
            {SHIFT_CLOSE_REASON_CODES.map((code) => (
              <Button
                key={code}
                size="floor"
                variant="secondary"
                className="floor-choice"
                data-checked={reason === code ? "true" : undefined}
                aria-pressed={reason === code}
                {...press(() => setReason(code))}
              >
                {/* The chosen reason is marked by a sign too, not by its colour alone. */}
                <span aria-hidden="true" className="floor-choice__mark">
                  {reason === code ? "✓" : ""}
                </span>
                <span className="floor-choice__label">{t(`floor.close.reasons.${code}`)}</span>
              </Button>
            ))}
          </div>
        </div>
      )}
      <p className="shift-close__note">
        {t(part === null ? "floor.close.irreversible" : "floor.close.part.irreversible")}
      </p>
      {palletAsked && (
        <Alert
          tone="warn"
          role="presentation"
          title={t("floor.close.palletOpen", {
            quantity: formatQuantity(openPallet.boxes),
            capacity: formatQuantity(palletCapacity),
          })}
        >
          <p>
            {t(
              part === null
                ? "floor.close.palletIrreversible"
                : "floor.close.part.palletIrreversible",
            )}
          </p>
        </Alert>
      )}
    </div>
    <div className="shift-close__actions">
      {back}
      <Button
        size="floor"
        disabled={summary.reasonRequired && chosen === null}
        {...press(() => (palletAsked ? onClosePallet(chosen) : onClose(chosen)))}
      >
        {t(
          palletAsked
            ? part === null
              ? "floor.close.confirmPallet"
              : "floor.close.part.confirmPallet"
            : part === null
              ? "floor.close.confirm"
              : "floor.close.part.confirm",
        )}
      </Button>
    </div>
  </>
);
```

Replace the section's title and busy line (`:365-388`) so that they read:

```tsx
const title = t(ownPart ? "floor.close.part.title" : "floor.close.title", { number });
return (
  <section className="shift-close" aria-label={title} tabIndex={-1} ref={viewRef}>
    <h3>{title}</h3>
    {note !== null && (
      <Alert
        tone={note === "failed" ? "error" : "warn"}
        role="presentation"
        title={t(`floor.close.notes.${note}`)}
      />
    )}
    {busy && (
      <p className="work-screen__waiting">
        {t(
          summary?.blocker?.kind === "open_pallet"
            ? "floor.close.closingPallet"
            : ownPart
              ? "floor.close.part.closing"
              : "floor.close.closing",
        )}
      </p>
    )}
    {body()}
  </section>
);
```

Append to `apps/standalone/src/floor/close/shift-close.css`:

```css
/* Plan 2b: what the close of a part does to the shift, under the result. */
.shift-close__part {
  margin: 0;
  color: var(--fg);
  font: var(--floor-body);
}
```

- [ ] **Step 6: Wire the work screen.** In `apps/standalone/src/floor/work/WorkScreen.tsx`:
      `readSummaryNow` (`:1340`) → `return readCloseSummary(now.local, pairingOf(now), now.shift.copy.id, now.online);`;
      the call in `finishClose` (`:1381`) → `const result = await closeShift(boxContextOf(live), reason, guards, live.current.online);`;
      `readSummary` (`:1963`) → `await showSummary(await readCloseSummary(now.local, pairingOf(now), now.shift.copy.id, now.online), null);`;
      in `<ShiftClosePanel …>` (`:2781-2797`) add `ownPart={sharedPart !== null}` after `boxless={validation}`.

- [ ] **Step 7: Run the tests to verify they pass.**

Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-close-part.test.tsx test/floor-shift-close.test.ts test/floor-work-close-pallets.test.tsx test/floor-work-screen.test.tsx test/validation-screen.test.tsx test/unit-label-screen.test.tsx test/floor-schema.test.ts`
Expected: PASS (solo closes, plans of `CLOSE_SUMMARY_SQL` and `MARK_CLOSING_SQL` unchanged). Typecheck and lint: no errors.

- [ ] **Step 8: Commit.**

```bash
git -C "$WT" add apps/standalone/src/floor/close/shift-close.ts apps/standalone/src/floor/close/ShiftClosePanel.tsx \
  apps/standalone/src/floor/close/shift-close.css apps/standalone/src/floor/work/WorkScreen.tsx \
  apps/standalone/src/i18n/ru.json apps/standalone/test/floor-close-part.test.tsx
git -C "$WT" commit -m "feat(standalone): station closes its part of a shared shift; the reason only of the last closer online

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 11: What became of the part's close — queued, waiting for the others, shift closed, reason missing, refused

**Files:**

- Modify: `apps/standalone/src/floor/close/shift-close.ts` (append `PartState`, `PART_STATE_SQL`, `readPartState`)
- Modify: `apps/standalone/src/floor/close/ShiftClosePanel.tsx:1-11` (imports), `:394-455` (`ShiftClosedPanel`)
- Modify: `apps/standalone/src/floor/work/WorkScreen.tsx:202-274` (props), the close's state near `:811`, `:2799-2810` (`<ShiftClosedPanel>`)
- Modify: `apps/standalone/src/floor/FloorApp.tsx:477-503` (`outboxVersion` to the work screen)
- Modify: `apps/standalone/src/i18n/ru.json:1388` (`floor.queue.kind.shift_closed`)
- Test: `apps/standalone/test/floor-close-part.test.tsx` (new describes), `apps/standalone/test/floor-queue-screen.test.tsx` (only if it pins «Закрытие смены» — see Step 6)

**Interfaces:**

- Consumes: Task 10 `closeShift`, `floor.close.part.done.*`; `receiptStatements` (`src/local/facts-sender.ts`); Task 3 `replaceShiftCopies`.
- Produces:
  - `type PartState = "queued" | "waiting" | "shift_closed" | "reason_missing" | "refused"`
  - `PART_STATE_SQL`; `readPartState(local: LocalExecutor, pairing: Pairing, shiftId: string): Promise<PartState | null>`
  - `ShiftClosedPanelProps.part?: PartState | null`
  - `WorkScreenProps.outboxVersion?: number`

- [ ] **Step 1: Write the failing tests.** Append to `apps/standalone/test/floor-close-part.test.tsx`
      (add to the imports `ShiftClosedPanel` from `../src/floor/close/ShiftClosePanel.js`,
      `readPartState` from `../src/floor/close/shift-close.js`,
      `import { replaceShiftCopies } from "../src/floor/shifts/shift-copies.js";`,
      `import { receiptStatements } from "../src/local/facts-sender.js";`):

```tsx
/** The part's close record answered `outcome` with `details`, as `sendFactBatch` stores a receipt. */
async function answer(
  executor: Awaited<ReturnType<typeof sharedStation>>["executor"],
  db: Awaited<ReturnType<typeof sharedStation>>["db"],
  outcome: "accepted" | "rejected",
  details?: Record<string, unknown>,
) {
  const [record] = rows(db, "SELECT id FROM outbox WHERE kind = 'shift_closed'");
  const id = String(record?.["id"]);
  await executor.transaction(
    receiptStatements(
      PAIRING,
      JSON.stringify([
        {
          id,
          kind: "shift_closed",
          outcome,
          ...(outcome === "rejected" ? { code: "invalid_record" } : {}),
          ...(details === undefined ? {} : { details }),
        },
      ]),
      "2026-10-08T10:00:00.000Z",
    ),
  );
}

describe("what became of the part's close (plan 2b, host D8)", () => {
  it("waits in the outbox, then waits for the others, then says the shift closed", async () => {
    const { db, executor, shift } = await sharedStation("active");
    await closeShift(scanContext(executor, shift), null, [], false);
    expect(await readPartState(executor, PAIRING, shift.copy.id)).toBe("queued");
    await answer(executor, db, "accepted", { partClosed: true });
    expect(await readPartState(executor, PAIRING, shift.copy.id)).toBe("waiting");
    // The same record sent again after a lost answer gets the same receipt: nothing else changes.
    await answer(executor, db, "accepted", { partClosed: true });
    expect(await readPartState(executor, PAIRING, shift.copy.id)).toBe("waiting");
    const closed = sharedShift({
      participants: [
        { row: participant(STATION_ROW.deviceId, "Станция линии 1", "closed"), accepted: 0 },
        { row: participant(OTHER_STATION, "Станция линии 2", "closed"), accepted: 300 },
      ],
      myState: "closed",
      asOf: "2026-10-08T14:10:05Z",
    });
    await replaceShiftCopies(
      executor,
      PAIRING,
      [{ ...closed, status: "closed", closedAt: "2026-10-08T14:10:00Z" }],
      1_790_000_100_000,
    );
    expect(await readPartState(executor, PAIRING, shift.copy.id)).toBe("shift_closed");
  });

  it("says a last part closed the shift, without the reason it needed, or before it (already closed)", async () => {
    for (const [details, state] of [
      [undefined, "shift_closed"],
      [{ reasonMissing: true }, "reason_missing"],
      [{ alreadyClosed: true }, "shift_closed"],
    ] as const) {
      const { db, executor, shift } = await sharedStation("closed");
      await closeShift(scanContext(executor, shift), null, [], false);
      await answer(executor, db, "accepted", details);
      expect(await readPartState(executor, PAIRING, shift.copy.id)).toBe(state);
    }
  });

  it("says a refused close, and nothing for a shift this station did not close", async () => {
    const { db, executor, shift } = await sharedStation("active");
    expect(await readPartState(executor, PAIRING, shift.copy.id)).toBeNull();
    await closeShift(scanContext(executor, shift), null, [], false);
    await answer(executor, db, "rejected");
    expect(await readPartState(executor, PAIRING, shift.copy.id)).toBe("refused");
  });
});

describe("the closed part's panel (plan 2b)", () => {
  it.each([
    ["queued", "Ваша часть закрыта на этой станции. Данные будут отправлены автоматически."],
    ["waiting", "Хост принял закрытие вашей части. Смена закроется, когда закроют остальные."],
    ["shift_closed", "Смена закрыта: все её части закрыты."],
    ["reason_missing", "Смена закрыта, но без причины расхождения с планом: её укажет офис."],
    [
      "refused",
      "Хост не принял закрытие вашей части. Откройте «Очередь отправки»: там видно, что делать.",
    ],
  ] as const)("says %s in its words", (part, words) => {
    render(
      <ThemeProvider>
        <ShiftClosedPanel
          number="OCT26-004"
          record={{ actualQty: 280, closedBoxCount: 23 }}
          linkHeld={false}
          leaving={false}
          onDone={vi.fn()}
          part={part}
        />
      </ThemeProvider>,
    );
    expect(screen.getByRole("group", { name: "Ваша часть смены OCT26-004 закрыта" })).toBeTruthy();
    expect(screen.getByText(words)).toBeTruthy();
    expect(screen.getByText("Принято: 280 шт., коробов: 23.")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run them to verify they fail.**

Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-close-part.test.tsx`
Expected: FAIL — `readPartState` not exported; the closed panel has no `part`.

- [ ] **Step 3: Implement the state.** Append to `apps/standalone/src/floor/close/shift-close.ts`:

```ts
/**
 * What became of this station's close of its part of a shared shift (plan 2b, host D8): the record
 * waits for the host (`queued`); the host closed the part and the shift waits for the others
 * (`waiting`); the shift is closed — by this record, by an earlier close, or later by the others
 * or the office (`shift_closed`); the shift closed without the reason it needed, which the office
 * gives (`reason_missing`); or the host refused the record (`refused`, the queue screen's to
 * resolve).
 */
export type PartState = "queued" | "waiting" | "shift_closed" | "reason_missing" | "refused";

/**
 * The shift's last `shift_closed` record of this pairing with its stored outcome and details
 * (`sendFactBatch` keeps both) and the copy's status by the last list. Parameters: shift id, host
 * id, device id. Searches `outbox_shift`.
 */
export const PART_STATE_SQL =
  "SELECT o.outcome AS outcome, o.outcome_details ->> 'partClosed' AS part_closed, " +
  "o.outcome_details ->> 'reasonMissing' AS reason_missing, s.status AS status FROM outbox o " +
  "JOIN floor_shifts s ON s.host_id = o.host_id AND s.device_id = o.device_id " +
  "AND s.id = o.shift_id WHERE o.shift_id = ? AND o.host_id = ? AND o.device_id = ? " +
  "AND o.kind = 'shift_closed' ORDER BY o.seq DESC LIMIT 1";

const partRow = z.object({
  outcome: z.string().nullable(),
  part_closed: z.number().nullable(),
  reason_missing: z.number().nullable(),
  status: z.string(),
});

/** The part's state; `null` when this station wrote no close of the shift. */
export async function readPartState(
  local: LocalExecutor,
  pairing: Pairing,
  shiftId: string,
): Promise<PartState | null> {
  const [row] = await local.query(
    PART_STATE_SQL,
    [shiftId, pairing.hostId, pairing.deviceId],
    partRow,
  );
  if (row === undefined) return null;
  if (row.outcome === null) return "queued";
  if (row.outcome !== "accepted") return "refused";
  if (row.reason_missing === 1) return "reason_missing";
  if (row.part_closed === 1) return row.status === "closed" ? "shift_closed" : "waiting";
  return "shift_closed";
}
```

- [ ] **Step 4: Say it on the closed panel.** In `apps/standalone/src/floor/close/ShiftClosePanel.tsx`
      change the type import to `import type { CloseBlocker, CloseSummary, PartState } from "./shift-close.js";`,
      add to `ShiftClosedPanelProps` after `boxless?: boolean;`:

```ts
  /**
   * What became of the close of this station's part of a shared shift (plan 2b); `null` or absent:
   * a solo shift's close, said as before.
   */
  part?: PartState | null;
```

add `part = null,` to the destructured props, and replace the title and the body line:

```tsx
const title =
  part === null
    ? t("floor.close.done.title", { number })
    : t("floor.close.part.done.title", { number });
```

```tsx
<p>{part === null ? t("floor.close.done.body") : t(`floor.close.part.done.${part}`)}</p>
```

(in place of `const title = t("floor.close.done.title", { number });` and
`<p>{t("floor.close.done.body")}</p>`). Extend the doc: «A part of a shared shift (plan 2b) says
what became of its close: waiting in the outbox, waiting for the others, the shift closed (with or
without the reason it needed), or refused.»

- [ ] **Step 5: Read it on the work screen.** In `apps/standalone/src/floor/work/WorkScreen.tsx`:

Add `readPartState` and `type PartState` to the import from `../close/shift-close.js`. Add to
`WorkScreenProps` after `onRefreshShifts?: () => void;`:

```ts
  /**
   * `ShellState.outboxVersion` (plan 2b): the closed part's state is read again after every batch
   * of receipts.
   */
  outboxVersion?: number;
```

After the `planDismissed` state (Task 8):

```ts
// What became of the close of this station's part of a shared shift (plan 2b).
const [partState, setPartState] = useState<PartState | null>(null);
```

After the `useShiftParticipation` call and `const sharedPart = …;` (Task 8):

```ts
// Read when the part is closed here, and again after every batch of receipts and every list.
const closedHere = stop?.kind === "closed";
const sharedHere = sharedPart !== null;
const { hostId: partHost, deviceId: partDevice } = props.pairing;
useEffect(() => {
  if (!closedHere || !sharedHere) return undefined;
  let cancelled = false;
  readPartState(props.local, { hostId: partHost, deviceId: partDevice }, shift.copy.id).then(
    (state) => {
      if (!cancelled) setPartState(state);
    },
    () => undefined,
  );
  return () => {
    cancelled = true;
  };
}, [
  closedHere,
  sharedHere,
  props.local,
  partHost,
  partDevice,
  shift.copy.id,
  props.outboxVersion,
  props.shiftReads,
]);
```

`stop` is declared above this point (`useState<Stop | null>`, `:810`); place the block after it.

In `<ShiftClosedPanel …>` (`:2799-2810`) add after `boxless={validation}`:

```tsx
              part={sharedPart === null ? null : (partState ?? "queued")}
```

In `apps/standalone/src/floor/FloorApp.tsx`, in the `<Work …>` element, after the `shiftReads` prop (Task 8):

```tsx
outboxVersion = { outboxVersion };
```

- [ ] **Step 6: The queue's wording.** In `apps/standalone/src/i18n/ru.json` replace
      `"shift_closed": "Закрытие смены",` (in `floor.queue.kind`, `:1388`) with
      `"shift_closed": "Закрытие смены станцией",`. Run
      `grep -rn '"Закрытие смены"' "$WT/apps/standalone/test"` and change every assertion found on the
      queue screen to `"Закрытие смены станцией"` (a product wording decision: name the test in the report).

- [ ] **Step 7: Run the tests to verify they pass.**

Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-close-part.test.tsx test/floor-queue-screen.test.tsx test/floor-work-screen.test.tsx test/floor-app.test.tsx test/floor-shift-close.test.ts`
Expected: PASS. Typecheck and lint: no errors.

- [ ] **Step 8: Commit.**

```bash
git -C "$WT" add apps/standalone/src/floor/close/shift-close.ts apps/standalone/src/floor/close/ShiftClosePanel.tsx \
  apps/standalone/src/floor/work/WorkScreen.tsx apps/standalone/src/floor/FloorApp.tsx apps/standalone/src/i18n/ru.json \
  apps/standalone/test/floor-close-part.test.tsx
git -C "$WT" commit -m "feat(standalone): station says what became of its part's close — queued, waiting, shift closed, reason missing

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

(Add the queue test file to `git add` if Step 6 changed it.)

---

### Task 12: The close panels' measuring guard — a part, the last part with its reason, offline, what became of it

**Files:**

- Modify: `apps/standalone/test/harness/station-fit/screens.tsx:1-25` (imports), `:114-160` (`SUMMARIES`), `:208-231` (the close and closed views)
- Modify: `apps/standalone/test/harness/station-fit/measure-screens.mjs:54-120` (`CASES`)
- Modify: `apps/standalone/src/floor/close/shift-close.css:214-320` (`@media (max-height: 860px)`)
- Test: `apps/standalone/test/floor-station-audit.test.ts` (new describe at the end)

**Interfaces:**

- Consumes: Task 10 `CloseSummary.part`, `ShiftClosePanelProps.ownPart`; Task 11 `PartState`, `ShiftClosedPanelProps.part`.
- Produces: harness variants `view=close&variant=part|part-last|part-offline|part-pallet`, `view=closed&variant=queued|waiting|shift_closed|reason_missing|refused`.

- [ ] **Step 1: Write the failing audit pin.** Append to `apps/standalone/test/floor-station-audit.test.ts`:

```ts
describe("the close of a part (plan 2b)", () => {
  const close = rulesOf("src/floor/close/shift-close.css");

  it("sets the part's line in the floor's body face, smaller on a short window", () => {
    expect(rule(close, ".shift-close__part")["font"]).toBe("var(--floor-body)");
    expect(rule(close, ".shift-close__part", "@media (max-height: 860px)")["font"]).toBe(
      "400 15px/20px var(--font-ui)",
    );
  });

  it("measures every part panel on the whole matrix", () => {
    const cases = textOf("test/harness/station-fit/measure-screens.mjs");
    for (const variant of [
      "part",
      "part-last",
      "part-offline",
      "part-pallet",
      "queued",
      "waiting",
      "shift_closed",
      "reason_missing",
      "refused",
    ]) {
      expect(cases).toContain(`variant=${variant}"`);
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails.**

Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-station-audit.test.ts -t "close of a part"`
Expected: FAIL — no compact rule, no cases.

- [ ] **Step 3: The compact line.** Inside `@media (max-height: 860px)` of `apps/standalone/src/floor/close/shift-close.css`, after `.shift-close__note { font: 400 14px/18px var(--font-ui) !important; }`:

```css
.shift-close__part {
  font: 400 15px/20px var(--font-ui);
}
```

- [ ] **Step 4: Give the harness the part panels.** In `apps/standalone/test/harness/station-fit/screens.tsx`:

Add `import type { PartState } from "../../../src/floor/close/shift-close.js";` (merge with the existing
`CloseSummary` type import from the same module if there is one), and after the `SUMMARIES` map's
last entry add (inside the object):

```ts
  // Plan 2b: a part of a shared shift — the others still open, the last one with its reason,
  // offline, and the last one with an open pallet.
  part: {
    ...PLAIN,
    actualQty: 280,
    closedBoxes: 23,
    part: { closesShift: false, total: 560, online: true },
  },
  "part-last": {
    ...PLAIN,
    actualQty: 280,
    closedBoxes: 23,
    reasonRequired: true,
    part: { closesShift: true, total: 560, online: true },
  },
  "part-offline": {
    ...PLAIN,
    actualQty: 280,
    closedBoxes: 23,
    part: { closesShift: true, total: 560, online: false },
  },
  "part-pallet": {
    ...PLAIN,
    actualQty: 280,
    closedBoxes: 23,
    reasonRequired: true,
    blocker: { kind: "open_pallet", boxes: 1 },
    part: { closesShift: true, total: 560, online: true },
  },
```

After the `SUMMARIES` declaration:

```ts
/** The closed part's states (plan 2b), by the closed view's variant. */
const PART_STATES: readonly PartState[] = [
  "queued",
  "waiting",
  "shift_closed",
  "reason_missing",
  "refused",
];
const closedPart = PART_STATES.find((state) => state === variant) ?? null;
```

In the close view's `<ShiftClosePanel …>` replace
`palletCapacity={variant === "pallet" || variant === "reason" ? 2 : null}` with
`palletCapacity={variant === "pallet" || variant === "reason" || variant === "part-pallet" ? 2 : null}`
and add `ownPart={variant.startsWith("part")}`; in the closed view's `<ShiftClosedPanel …>` add
`part={closedPart}`.

In `apps/standalone/test/harness/station-fit/measure-screens.mjs` add to `CASES` after
`{ name: "closed-held", query: "view=closed&variant=held" },`:

```js
  // Plan 2b: the close of a part of a shared shift, and what became of it.
  { name: "close-part", query: "view=close&variant=part" },
  { name: "close-part-last", query: "view=close&variant=part-last" },
  { name: "close-part-offline", query: "view=close&variant=part-offline" },
  { name: "close-part-pallet", query: "view=close&variant=part-pallet" },
  { name: "closed-part-queued", query: "view=closed&variant=queued" },
  { name: "closed-part-waiting", query: "view=closed&variant=waiting" },
  { name: "closed-part-shift", query: "view=closed&variant=shift_closed" },
  { name: "closed-part-reason", query: "view=closed&variant=reason_missing" },
  { name: "closed-part-refused", query: "view=closed&variant=refused" },
```

- [ ] **Step 5: Run the pin and the guard.**

Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-station-audit.test.ts`
Expected: PASS.
Run (Chromium; macOS sandbox off): `PLAYWRIGHT_CORE=<path> pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/station-fit.browser.test.ts`
Expected: PASS. If `close-part-last` or `close-part-pallet` reports a control below the fold or a
scrolling body at 1024×640/1024×700, add inside the same `@media (max-height: 860px)`:

```css
/* Plan 2b: with the reasons to choose, the last closer's line gives its place up: the reasons'
     title says what the close is waiting for. */
.shift-close__body:has(> .shift-close__reasons) > .shift-close__part {
  display: none;
}
```

and run the guard again. If `PLAYWRIGHT_CORE` is unavailable, record «guard not run».

- [ ] **Step 6: Commit.**

```bash
git -C "$WT" add apps/standalone/src/floor/close/shift-close.css apps/standalone/test/harness/station-fit/screens.tsx \
  apps/standalone/test/harness/station-fit/measure-screens.mjs apps/standalone/test/floor-station-audit.test.ts
git -C "$WT" commit -m "test(standalone): guard measures the part close panels on the whole matrix

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Two stations in one shift at the webview level (fake shared host)

**Files:**

- Create: `apps/standalone/test/support/multi-host.ts`
- Create: `apps/standalone/test/floor-multi-station.test.tsx`

**Interfaces:**

- Consumes: everything above; `FloorApp`, `WorkScreen`, `replaceShiftCopies`, `sendFactBatch`, `sendPendingLeaves`, `reasonNeed`; `VALIDATION_ENTERED`, `km`, `OPERATOR_ID` (`test/support/floor-work.ts`); `fakeSource`, `PRESS_PAUSE_MS` (`test/support/work-screen.tsx`); `fakeHardware` (`test/support/hardware.ts`).
- Produces: `multiHost(base: EnteredShift, maxStations: number, names: Readonly<Record<string, string>>)` with `open`, `list`, `enter`, `leave`, `checkCode`, `facts`, `state`; `type MultiHost`.

- [ ] **Step 1: Write the fake shared host.** Create `apps/standalone/test/support/multi-host.ts`:

```ts
import { z } from "zod";

import { reasonNeed } from "../../src/floor/close/shared-reason.js";
import { HostError } from "../../src/host/client.js";
import {
  deviceShiftSchema,
  enteredShiftSchema,
  type CodeCheck,
  type DeviceShift,
  type EnteredShift,
  type FactReceipt,
  type ShiftEnter,
  type ShiftParticipant,
} from "../../src/host/protocol.js";

interface Part {
  row: ShiftParticipant;
  accepted: number;
}

const recordSchema = z.object({
  id: z.string(),
  kind: z.string(),
  data: z.record(z.string(), z.unknown()),
});

export type MultiHost = ReturnType<typeof multiHost>;

/**
 * A host of one shared shift for the webview tests of plan 2b, in memory: the host contract's
 * entry (a slot by `maxStations`, `shift_line_full` with its numbers, `shift_busy` without the
 * capability, a closed part read back), leave (`left`, `shift_not_entered`), list (participants,
 * `myState`, totals by device at an `asOf` that moves on with every answer) and facts (an accepted
 * scan counts; a `shift_closed` closes the sender's part and the shift with the last one, the
 * reason by `reasonNeed`, the receipts `partClosed`, `reasonMissing`, `alreadyClosed`). Not the
 * host: what the stations must see of it.
 */
export function multiHost(
  base: EnteredShift,
  maxStations: number,
  names: Readonly<Record<string, string>>,
) {
  const { snapshot, ...fields } = base;
  const parts = new Map<string, Part>();
  let status: "active" | "closed" = "active";
  let closedAt: string | null = null;
  let reasonMissing = false;
  let seconds = 0;
  const instant = () => {
    seconds += 1;
    return new Date(Date.parse("2026-10-08T07:00:00Z") + seconds * 1000)
      .toISOString()
      .replace(".000Z", "Z");
  };
  const refused = (
    code: string,
    constraint: string | null,
    details: Record<string, unknown> = {},
  ) =>
    new HostError({
      kind: "api",
      code,
      status: code === "not_found" ? 404 : 409,
      message: constraint ?? code,
      details: constraint === null ? details : { constraint, ...details },
    });
  const row = (deviceId: string, at: string): ShiftParticipant => ({
    deviceId,
    deviceKind: "station",
    deviceName: names[deviceId] ?? deviceId,
    state: "active",
    firstEnteredAt: at,
    joinedAt: at,
    leftAt: null,
    closedAt: null,
    closedBy: null,
    closedActualQty: null,
    closedReasonCode: null,
    lateDataAt: null,
    lastSeenAt: at,
  });
  const accepted = () => [...parts.values()].reduce((sum, part) => sum + part.accepted, 0);
  const shiftFor = (deviceId: string): DeviceShift => {
    const list = [...parts.values()];
    const mine = parts.get(deviceId);
    return deviceShiftSchema.parse({
      ...fields,
      status,
      closedAt,
      maxStations,
      participants: list.map((part) => part.row),
      ...(mine === undefined ? {} : { myState: mine.row.state }),
      totals: { accepted: accepted(), boxesClosed: 0, pallets: 0, asOf: instant() },
      byDevice: list.map((part) => ({
        deviceId: part.row.deviceId,
        accepted: part.accepted,
        boxesClosed: 0,
        pallets: 0,
      })),
    });
  };
  const closePart = (deviceId: string, id: string, data: Record<string, unknown>): FactReceipt => {
    if (status === "closed") return { id, outcome: "accepted", details: { alreadyClosed: true } };
    const mine = parts.get(deviceId);
    if (mine === undefined) return { id, outcome: "rejected", code: "invalid_record" };
    if (mine.row.state === "closed")
      return { id, outcome: "accepted", details: { partClosed: true } };
    const planned = data["plannedQtySnapshot"];
    const actual = typeof data["actualQty"] === "number" ? data["actualQty"] : 0;
    const reasonCode = typeof data["reasonCode"] === "string" ? data["reasonCode"] : null;
    const closesShift = [...parts.values()].every(
      (part) => part.row.deviceId === deviceId || part.row.state === "closed",
    );
    const need = reasonNeed({
      closesShift,
      participantsEver: parts.size,
      factPlanned: typeof planned === "number" ? planned : null,
      actualQty: actual,
      hostPlanned: fields.plannedQty,
      shiftAccepted: accepted(),
    });
    if (need === "required" && reasonCode === null) {
      return { id, outcome: "rejected", code: "invalid_record" };
    }
    const at = instant();
    mine.row = {
      ...mine.row,
      state: "closed",
      closedAt: at,
      closedBy: "device",
      closedActualQty: actual,
      closedReasonCode: reasonCode,
    };
    if (!closesShift) return { id, outcome: "accepted", details: { partClosed: true } };
    status = "closed";
    closedAt = at;
    if (need === "shared" && reasonCode === null) {
      reasonMissing = true;
      return { id, outcome: "accepted", details: { reasonMissing: true } };
    }
    return { id, outcome: "accepted" };
  };
  return {
    /** The office's planned shift opened by this device's first entry. */
    open(deviceId: string): void {
      parts.set(deviceId, { row: row(deviceId, instant()), accepted: 0 });
    },
    list: async (deviceId: string): Promise<DeviceShift[]> => [shiftFor(deviceId)],
    enter:
      (deviceId: string) =>
      async (shiftId: string, enter: ShiftEnter): Promise<EnteredShift> => {
        if (shiftId !== base.id) throw refused("not_found", null);
        if (status === "closed") throw refused("conflict", "shift_status");
        const mine = parts.get(deviceId);
        if (mine === undefined || mine.row.state === "left") {
          if (mine === undefined && !enter.supports.includes("multi-station-v1")) {
            throw refused("conflict", "shift_busy");
          }
          const active = [...parts.values()].filter(
            (part) => part.row.deviceId !== deviceId && part.row.state === "active",
          ).length;
          if (active >= maxStations) {
            throw refused("conflict", "shift_line_full", { maxStations, active });
          }
          const at = instant();
          if (mine === undefined) parts.set(deviceId, { row: row(deviceId, at), accepted: 0 });
          else mine.row = { ...mine.row, state: "active", joinedAt: at, leftAt: null };
        }
        return enteredShiftSchema.parse({ ...shiftFor(deviceId), snapshot });
      },
    leave:
      (deviceId: string) =>
      async (shiftId: string): Promise<DeviceShift> => {
        if (shiftId !== base.id) throw refused("not_found", null);
        const mine = parts.get(deviceId);
        if (mine === undefined) throw refused("conflict", "shift_not_entered");
        if (mine.row.state === "active") {
          mine.row = { ...mine.row, state: "left", leftAt: instant() };
        }
        return shiftFor(deviceId);
      },
    checkCode: async (): Promise<CodeCheck> => ({ status: "free" }),
    facts:
      (deviceId: string) =>
      async (records: readonly unknown[]): Promise<FactReceipt[]> =>
        records.map((raw): FactReceipt => {
          const record = recordSchema.parse(raw);
          if (record.kind === "shift_closed") return closePart(deviceId, record.id, record.data);
          const mine = parts.get(deviceId);
          if (record.kind === "scan" && mine !== undefined && record.data["verdict"] === "ok") {
            mine.accepted += 1;
          }
          return { id: record.id, outcome: "accepted" };
        }),
    state: () => ({ status, reasonMissing, parts: new Map(parts) }),
  };
}
```

- [ ] **Step 2: Write the scenarios.** Create `apps/standalone/test/floor-multi-station.test.tsx`:

```tsx
import { act, fireEvent, render, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import type { FloorSession, SyncState } from "../src/app/shell.js";
import { FloorApp } from "../src/floor/FloorApp.js";
import { createPrintRuntime } from "../src/floor/print/print-runtime.js";
import { replaceShiftCopies } from "../src/floor/shifts/shift-copies.js";
import { WorkScreen, type WorkScreenProps } from "../src/floor/work/WorkScreen.js";
import { createSystemAwake } from "../src/hardware/awake.js";
import type { DeviceStatus, HostStatus } from "../src/host/protocol.js";
import { sendFactBatch } from "../src/local/facts-sender.js";
import { sendPendingLeaves } from "../src/local/leave-sender.js";
import { DEVICE_ID, DEVICE_STATUS, HOST_ID } from "./support/fixtures.js";
import { km, OPERATOR_ID, VALIDATION_ENTERED } from "./support/floor-work.js";
import { fakeHardware } from "./support/hardware.js";
import { openLocalDb } from "./support/local-db.js";
import { multiHost, type MultiHost } from "./support/multi-host.js";
import { OTHER_STATION, THIRD_STATION } from "./support/multi-station.js";
import { fakeSource, PRESS_PAUSE_MS } from "./support/work-screen.js";

// The tones are the work screen's; nothing is heard here.
vi.mock("../src/floor/work/signal-sound.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  playSignalTone: vi.fn(),
}));

const SESSION: FloorSession = {
  id: OPERATOR_ID,
  login: "0042",
  name: "Анна Кузнецова",
  role: null,
  sessionId: 1,
};
const ONLINE: HostStatus = { state: "online", lastContactAt: 1, lastError: null, seq: 1 };
const OFFLINE: HostStatus = {
  state: "offline",
  lastContactAt: 1,
  lastError: "unreachable",
  seq: 2,
};
// No sync ran: the floor checks no operator against copies this test does not keep.
const NOT_SYNCED: SyncState = { kind: "idle", synced: 0, failure: null, quarantined: 0 };
const NAMES = {
  [DEVICE_ID]: "Станция линии 1",
  [OTHER_STATION]: "Станция линии 2",
  [THIRD_STATION]: "Станция линии 3",
};

/** One station's floor over its own database, driven as the shell's link would drive it. */
function station(host: MultiHost, deviceId: string) {
  const { executor: local } = openLocalDb();
  const pairing = { hostId: HOST_ID, deviceId };
  const device: DeviceStatus = {
    ...DEVICE_STATUS,
    deviceId,
    deviceName: NAMES[deviceId] ?? deviceId,
  };
  const scanner = fakeSource();
  const { hardware } = fakeHardware();
  const printing = createPrintRuntime(hardware.printBytes);
  const awake = createSystemAwake(vi.fn(async () => undefined));
  const enter = host.enter(deviceId);
  const clock = { now: 0 };
  const requestLeaves = vi.fn<() => void>();
  const state: { link: HostStatus; reads: number; outbox: number } = {
    link: ONLINE,
    reads: 0,
    outbox: 0,
  };
  function Work(props: WorkScreenProps) {
    return <WorkScreen {...props} labelClock={() => clock.now} />;
  }
  const element = () => (
    <ThemeProvider>
      <FloorApp
        operator={SESSION}
        local={local}
        device={device}
        link={state.link}
        sync={NOT_SYNCED}
        shiftReads={{ done: state.reads, failed: false }}
        outboxVersion={state.outbox}
        lineChangePending={false}
        rejectionPending={false}
        enter={enter}
        create={async () => {
          throw new Error("no new shift in this test");
        }}
        checkCode={host.checkCode}
        requestBlock={async () => {
          throw new Error("a validation shift asks for no serials");
        }}
        requestFacts={() => undefined}
        requestLeaves={requestLeaves}
        source={scanner.source}
        printing={printing}
        hardware={hardware}
        awake={awake}
        workScreen={Work}
        dispatch={() => undefined}
        onSignOut={() => undefined}
      />
    </ThemeProvider>
  );
  const view = render(element());
  const update = () => view.rerender(element());
  const screen = () => within(view.container);
  return {
    local,
    scanner,
    requestLeaves,
    screen,
    /** The host's list into the copies, as the link's read does after a revision. */
    readShifts: () =>
      act(async () => {
        await replaceShiftCopies(local, pairing, await host.list(deviceId), Date.now());
        state.reads += 1;
        update();
      }),
    /** One batch of the outbox to the host and its receipts, as the link's delivery does. */
    deliver: () =>
      act(async () => {
        await sendFactBatch(local, pairing, host.facts(deviceId), () => new Date());
        state.outbox += 1;
        update();
      }),
    /** The pauses this station owes, as the link sends them. */
    sendLeaves: () =>
      act(async () => {
        await sendPendingLeaves(local, pairing, host.leave(deviceId), () => new Date());
        state.reads += 1;
        update();
      }),
    goOffline: () =>
      act(() => {
        state.link = OFFLINE;
        update();
      }),
    goOnline: () =>
      act(() => {
        state.link = ONLINE;
        update();
      }),
    scan: (raw: string) =>
      act(async () => {
        scanner.emit(raw);
      }),
    /** A press after an operator's pause (the panels' guard), and what it started. */
    press: async (name: string) => {
      const button = await screen().findByRole("button", { name });
      clock.now += PRESS_PAUSE_MS;
      await act(async () => {
        fireEvent.click(button);
      });
    },
    total: () => view.container.querySelector(".work-shift-band__count")?.textContent ?? null,
    mine: () =>
      view.container.querySelector(".work-shift-band__small--mine .work-shift-band__small-count")
        ?.textContent ?? null,
  };
}

describe("two stations in one shift (plan 2b, spec §9.6)", () => {
  it("join, count the whole shift, close each part, and the last closer gives the reason", async () => {
    const host = multiHost(VALIDATION_ENTERED, 2, NAMES);
    host.open(DEVICE_ID);
    const a = station(host, DEVICE_ID);
    const b = station(host, OTHER_STATION);
    const c = station(host, THIRD_STATION);
    for (const one of [a, b, c]) await one.readShifts();

    // A continues the shift it opened; B joins; C finds the line full.
    await a.press("Продолжить");
    await b.press("Присоединиться");
    await c.readShifts();
    expect(await c.screen().findByText("Линия занята: 2 из 2")).toBeTruthy();
    expect(c.screen().queryByRole("button", { name: "Присоединиться" })).toBeNull();

    // Both scan; the host takes their facts; each band says its own and the whole shift's.
    await a.scanner.listening();
    await b.scanner.listening();
    await a.scan(km("A1"));
    await waitFor(() => expect(a.mine()).toBe("1"));
    await a.scan(km("A2"));
    await waitFor(() => expect(a.mine()).toBe("2"));
    await b.scan(km("B1"));
    await waitFor(() => expect(b.mine()).toBe("1"));
    await a.deliver();
    await b.deliver();
    await a.readShifts();
    await b.readShifts();
    await waitFor(() => expect(a.total()).toBe("3"));
    await waitFor(() => expect(b.total()).toBe("3"));

    // A closes its part: not the last, so no reason; the shift waits for B.
    await a.press("Закрыть мою часть");
    expect(await a.screen().findByText("Смена закроется, когда закроют остальные.")).toBeTruthy();
    expect(a.screen().queryByText("Факт не совпадает с планом. Выберите причину:")).toBeNull();
    await a.press("Подтвердить закрытие части");
    expect(
      await a
        .screen()
        .findByText("Ваша часть закрыта на этой станции. Данные будут отправлены автоматически."),
    ).toBeTruthy();
    await a.deliver();
    expect(
      await a
        .screen()
        .findByText("Хост принял закрытие вашей части. Смена закроется, когда закроют остальные."),
    ).toBeTruthy();

    // A's closed part holds no slot: C may join now.
    await c.readShifts();
    expect(await c.screen().findByRole("button", { name: "Присоединиться" })).toBeTruthy();

    // B closes last with the link: the whole shift (3) missed the plan (1 200), so it gives a reason.
    await b.readShifts();
    await b.press("Закрыть мою часть");
    expect(
      await b
        .screen()
        .findByText("Остальные уже закрыли свои части: смена закроется вместе с вашей."),
    ).toBeTruthy();
    await b.press("Остановка оборудования");
    await b.press("Подтвердить закрытие части");
    await b.deliver();
    expect(await b.screen().findByText("Смена закрыта: все её части закрыты.")).toBeTruthy();
    expect(host.state()).toMatchObject({ status: "closed", reasonMissing: false });
    await a.readShifts();
    expect(await a.screen().findByText("Смена закрыта: все её части закрыты.")).toBeTruthy();
  });

  it("the last closer without the link gives no reason; the host marks it missing (spec §12.9)", async () => {
    const host = multiHost(VALIDATION_ENTERED, 2, NAMES);
    host.open(DEVICE_ID);
    const a = station(host, DEVICE_ID);
    const b = station(host, OTHER_STATION);
    await a.readShifts();
    await b.readShifts();
    await a.press("Продолжить");
    await b.press("Присоединиться");
    await a.press("Закрыть мою часть");
    await a.press("Подтвердить закрытие части");
    await a.deliver();
    await b.readShifts();
    await b.goOffline();
    await b.press("Закрыть мою часть");
    expect(
      await b
        .screen()
        .findByText(
          "Нет связи с хостом: ваша часть закроется сейчас, итог смены посчитает хост. Если понадобится причина расхождения, её укажет офис.",
        ),
    ).toBeTruthy();
    expect(b.screen().queryByText("Факт не совпадает с планом. Выберите причину:")).toBeNull();
    await b.press("Подтвердить закрытие части");
    await b.goOnline();
    await b.deliver();
    expect(
      await b
        .screen()
        .findByText("Смена закрыта, но без причины расхождения с планом: её укажет офис."),
    ).toBeTruthy();
    expect(host.state()).toMatchObject({ status: "closed", reasonMissing: true });
  });

  it("«Выйти из смены» frees the slot; an entry before the pause reaches the host drops it", async () => {
    const host = multiHost(VALIDATION_ENTERED, 2, NAMES);
    host.open(DEVICE_ID);
    const a = station(host, DEVICE_ID);
    const b = station(host, OTHER_STATION);
    const c = station(host, THIRD_STATION);
    for (const one of [a, b, c]) await one.readShifts();
    await a.press("Продолжить");
    await b.press("Присоединиться");

    await b.press("Выйти из смены");
    await waitFor(() => expect(b.requestLeaves).toHaveBeenCalledTimes(1));
    await b.sendLeaves();
    expect(host.state().parts.get(OTHER_STATION)?.row.state).toBe("left");
    await c.readShifts();
    expect(await c.screen().findByRole("button", { name: "Присоединиться" })).toBeTruthy();

    // A leaves while the host is away and comes back before the pause reaches it.
    await a.goOffline();
    await a.press("Выйти из смены");
    await waitFor(() => expect(a.requestLeaves).toHaveBeenCalledTimes(1));
    await a.press("Продолжить");
    await a.goOnline();
    await a.sendLeaves();
    expect(host.state().parts.get(DEVICE_ID)?.row.state).toBe("active");
  });
});
```

- [ ] **Step 3: Run it.**

Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-multi-station.test.tsx`
Expected: PASS (three scenarios). A failure here is a defect of Tasks 3–11 at their seams (the
fake host follows the host contract); fix the product code, never the fake's rules, and record
what was found.

- [ ] **Step 4: Commit.**

```bash
git -C "$WT" add apps/standalone/test/support/multi-host.ts apps/standalone/test/floor-multi-station.test.tsx
git -C "$WT" commit -m "test(standalone): two stations in one shift at the webview level over a fake shared host

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 14: The scoped guide and the final gates

**Files:**

- Modify: `apps/standalone/AGENTS.md` — a new subsection right after «### Several devices in one shift (plan 2b)» (added by the host plan's Task 15 after «### Handhelds on the host»); «## Local database» (the table list sentence on classes, if it enumerates disposable tables)

**Interfaces:**

- Consumes: Decisions S1–S14 and Tasks 1–13.
- Produces: the station's part of the scoped guide.

- [ ] **Step 1: Add the subsection.** Insert after the host's «### Several devices in one shift (plan 2b)» block:

```markdown
### Several devices in one shift: the station (plan 2b)

`docs/superpowers/plans/2026-10-20-multi-station-station.md`. Every entry names
`multi-station-v1` (`STATION_SHIFT_ENTER`, `shift-enter-multi.json`). What the host's list and the
answers of an entry and a leave say of a shared shift — `maxStations`, `participants`, `myState`,
`totals`, `byDevice` — is kept in `floor_shift_participation` (shell migration `0021`,
`TableClass::Disposable`; `src/floor/shifts/shift-participation.ts`): one row per shift, written
with the copy in the same transaction, never recalculated, a read older than the row's `as_of`
ignored unless the station saw the row more than a minute before (a host clock set back); every
list read drops the rows of shifts the pairing no longer keeps. A shift is shared when
`maxStations > 1` or more than one device ever entered (`sharedParticipation`); a solo station on a
line of one sees stage 2a. The hub card joins («Присоединиться», online only) while the other
devices hold fewer slots than the limit, says «Линия занята: N из M» with no action, names who
works the shift when another device does, and says a part the host reports closed; a refusal
`shift_line_full` is said with its numbers, an entry answered `myState: "closed"` is `part_closed`
and keeps nothing; a shared shift's progress is the whole shift's. The work screen's band shows
«Всего в смене» K — the others' part by the host plus this station's own codes (`sharedCount`) —
against the plan and «Моя станция» N, the group named «Моя станция: N · Всего в смене: K из M»,
and «данные от ЧЧ:ММ» while the link is down; it asks the link for the list every 15 s while
shared and online (`useShiftParticipation`, `HostLinkControls.requestShifts`: another device's
scan takes no revision). The plan notice comes when K reaches the plan. «Закрыть мою часть» keeps
stage 2a's blockers and transaction; the reason follows `stationReasonRequired` (the host's
`reason_need`, fixture `shift-close-reason-shared.json`): a shift only this station ever worked
keeps stage 2a's rule, offline too; a shared close asks it only online of the last closer, never
offline (the host marks it missing). The closed panel says the part's state from the stored
receipt (`readPartState`: `queued`, `waiting`, `shift_closed`, `reason_missing`, `refused`).
«Выйти из смены» and a move to another line pause the part (`markLeave`, `leave_requested_at`; a
sign-out does not); the link sends pauses when online (`sendPendingLeaves`,
`HostLinkControls.requestLeaves`), a `shift_not_entered` or `not_found` answer settles one, and any
entry, online or offline, drops a pending one. Known limit: a pause in flight when the operator
enters again may reach the host after the entry. The queue screen calls a `shift_closed` record
«Закрытие смены станцией». `SYNC_SCHEMA_VERSION` stays 5.
```

If «## Local database» lists the disposable tables by name, add `floor_shift_participation` there
with «(plan 2b, `0021`: a shared shift's figures)».

- [ ] **Step 2: Check and commit the guide.**

Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false exec prettier --check apps/standalone/AGENTS.md` and `git -C "$WT" diff --check`. Expected: clean.

```bash
git -C "$WT" add apps/standalone/AGENTS.md
git -C "$WT" commit -m "docs(standalone): several devices in one shift on the station (plan 2b)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 3: Final gates** (record each result in the report):
  - `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone test` (the whole Vitest of the package, both projects)
  - `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck` and `… lint`
  - `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false exec prettier --check` over every touched file (`git -C "$WT" diff --name-only <base>...HEAD`)
  - `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false turbo build --filter '@markiro/standalone...'`, then `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-standalone --test local_db` and `cargo fmt --manifest-path "$WT/apps/standalone/Cargo.toml" --all -- --check`
  - with Chromium: `PLAYWRIGHT_CORE=<path> … vitest run test/station-fit.browser.test.ts test/work-screen-fit.browser.test.ts`
  - `git -C "$WT" diff --check`; `graphify update .` if `graphify-out/graph.json` exists in the worktree.
  - Not verifiable here (state it): Windows WebView2 and the Tauri shell on Windows, real stations and handhelds on a LAN, the host's real totals under load (load/soak plan), real scanners and printers.

---

## End-to-end checklist (manual, real Windows, after the host plan is deployed)

Host 1.1.0 (protocol 7) first, then two stations (1.1.0) and a handheld on one line; line limit
set to 2 in the office.

1. Station A opens a planned shift. Station B's hub shows the card with «Присоединиться» and «В смене 1 из 2: Станция A · станция»; B joins.
2. The handheld tries to enter: refused, the line is full (handheld plan). A third station's card says «Линия занята: 2 из 2» with no button.
3. A and B scan for a minute: each band shows «Моя станция» its own count and «Всего в смене» the sum within 15 s; the card progress on the hub of a station back on the list shows the whole shift.
4. Pull B's network cable: B goes on scanning; its band shows «данные от ЧЧ:ММ»; A's total stops counting B's new scans until B's link returns, then catches up.
5. With a plan of N, scan past N across both stations: the plan notice appears on each station at its next refresh, once.
6. A presses «Выйти из смены»: the office shows A `left`; the third station's card offers «Присоединиться». A enters again (link up): A takes the slot back if free.
7. A closes its part with the plan unmet: no reason asked; panel «Смена закроется, когда закроют остальные», after delivery «Хост принял закрытие вашей части…». The office shows A `closed`.
8. B, with its cable out, closes its part: no reason; plug the cable back: «Смена закрыта, но без причины расхождения с планом: её укажет офис.»; the office shows the shift closed and asks for the reason.
9. Repeat 7 with B online last: B is asked for one of the six reasons; the shift closes with it.
10. Office force-closes a shift while A still works: A's work screen shows «Смену закрыли в офисе», A finishes and closes as before.
11. A station with `max_stations = 1` and no other device: hub, band and close look exactly as in 1.0.0.
12. Restart a station in the middle of steps 4, 6 and 8: its pause, its queued close and its cached figures are still there after the restart.

---

## Self-Review

**1. Spec coverage**

| Spec item                                                                                                   | Where                                                                                               |
| ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| §5 Card: «Присоединиться» at a free slot                                                                    | Task 4 (`cardAction` `join`, card), Task 6 (guard)                                                  |
| §5 Card: `shift_line_full` → «Линия занята: N из N», no action                                              | Task 4 (`line_full` from the cache), Task 5 (refusal with the host's numbers), Task 6               |
| §5 Card: participants listed (name, kind)                                                                   | Task 4 (participants line), Task 6                                                                  |
| §5 Work screen: «Моя станция: N · Всего в смене: K из M»                                                    | Task 8 (band, group name), Task 9 (guard)                                                           |
| §5 K from host `totals`; offline last value «данные от ЧЧ:ММ»                                               | Task 3 (cache, `asOf`), Task 8 (`sharedCount`, stale mark, 15 s poll), Task 7 (`requestShifts`)     |
| §5 Plan reached by the total; notice at the next refresh                                                    | Task 8 (`sharedReached`), Task 4 (hub progress by the total)                                        |
| §5 «Закрыть мою часть», blockers unchanged                                                                  | Task 8 (footer label), Task 10 (summary, panel, same transaction)                                   |
| §5 Reason only of the last closer; others «Смена закроется, когда закроют остальные»                        | Task 1 (`stationReasonRequired`), Task 10                                                           |
| §5 Exit stays a pause (`left`)                                                                              | Task 7 (`markLeave`, `sendPendingLeaves`, FloorApp), Task 13                                        |
| §5 Offline: entry only into a known shift                                                                   | Task 4 (`join` needs the link), Task 5 (offline entry from the snapshot drops a pause)              |
| §5 Offline: part close queued, confirmed idempotently                                                       | Task 10 (local write), Task 11 (`readPartState` from the stored receipt; repeated receipt), Task 13 |
| §5 SSCC blocks, duplicates as now; conflicts visible (`conflict-notices.ts`)                                | unchanged by design (S12); the registry's earliest-scan rule is the host's (host Task 13)           |
| §5 Local tables keep their meaning; only a totals cache added                                               | Task 2 (`0021`, separate disposable table), Task 3                                                  |
| §2 «Принято N из M» only from own rows                                                                      | Task 4 (hub progress), Task 8 (band) now use the shift-wide total for shared shifts                 |
| §2 owner-only entry (`shift_busy`)                                                                          | Task 1 (capability), Task 4 (`busy` only without figures), Task 5 (`shift_busy` still mapped)       |
| §12.9 offline last closer: no reason, host marks missing                                                    | Task 1, Task 10, Task 11 (`reason_missing`), Task 13 scenario 2                                     |
| §12.7 handheld as a participant                                                                             | Task 4 (kind «ТСД» in the participants line; slots counted for any kind)                            |
| §12.5 revoked opener frees the slot                                                                         | host D3; station limitation recorded (gap G1)                                                       |
| §12.6 timeout of `left`                                                                                     | out of scope (S14, host D18)                                                                        |
| §12.1–12.4, §12.8                                                                                           | host/office plans; nothing on the station                                                           |
| Host contract: protocol 7, `multi-station-v1`, leave route, DeviceShift fields, receipts, `shift_line_full` | Tasks 1, 3, 5, 7, 11                                                                                |

**2. Placeholder scan.** Searched the plan for «TBD», «TODO», «implement later», «fill in», «similar to Task», «add appropriate», «handle edge cases»: none. The conditional CSS steps (Tasks 6 and 9 Step 4, Task 12 Step 5) carry the exact rule to add and the exact guard report that triggers it. Line numbers are of `main` 3dc8df952 before the host plan; files the host plan moves are anchored by quoted text.

**3. Type consistency.** `Participation` (Task 3) is used with the same fields in Tasks 4, 7, 8, 10 and the harnesses (Tasks 6); `participationStatement`, `dropOrphanParticipationStatement`, `clearLeaveStatement` (Task 3) are called with `(pairing, …)` in Tasks 3, 5, 7; `sharedParticipation`, `activeOthers`, `closesShift`, `participantsEver`, `sharedCount(participation, deviceId, mine)` match their callers in Tasks 4, 8, 10; `markLeave(local, pairing, shiftId, at)` (Task 7) matches FloorApp and the tests; `sendPendingLeaves(local, pairing, leave, now)` matches host-link and Task 13; `stationReasonRequired({ plannedQty, actualQty, participantsEver, closesShift, online, total })` (Task 1) matches Task 10; `reasonNeed(ReasonCase)` matches Task 13's fake host; `CardAction` kinds `join`, `line_full { active, maxStations }`, `part_closed` (Task 4) match the card and tests; `EntryResult.refused.line?: LineSlots` (Task 5) matches `ShiftList`; `CloseSummary.part?: PartClose { closesShift, total, online }` (Task 10) matches the panel, `sameSummary` and the harness (Task 12); `PartState` (Task 11) matches `ShiftClosedPanel.part`, the work screen and the harness; `WorkScreenProps.shiftReads`, `onRefreshShifts` (Task 8) and `outboxVersion` (Task 11) match FloorApp; `HostLinkControls.requestShifts`/`requestLeaves` and `HostLinkOptions.leaveShift` (Task 7) match App and FloorApp; i18n keys `floor.shifts.{participants,participant,thisStation,deviceKind.*,lineFull,partClosed,lineFullRefused,action.join,refused.line_full,refused.part_closed}`, `floor.work.shared.*`, `floor.close.openPart`, `floor.close.part.*` are added before first use. The DOM classes `.work-shift-band__small--mine`, `.work-shift-band__stale`, `.shift-card__participants`, `.shift-close__part` are the same in code, CSS, audit pins and Task 13's helpers.

**Contract assumptions made by this plan:**

- A1. The leave answer is a `DeviceShift` with `myState`, `participants`, `totals` and `byDevice` (host Task 7 `read_for`); the station stores it like a list item.
- A2. `shift_line_full` details carry numeric `maxStations` and `active` (fixture `error-shift-line-full.json`); without them the station says the full line in words.
- A3. Receipt details are JSON `true` (`partClosed`, `reasonMissing`, `alreadyClosed`), read with `->>` as 1.
- A4. `totals.asOf` is the host's clock and moves forward; a clock set back is tolerated after a minute (S1).
- A5. `myState` absent means the station never entered; `shift_busy` is never answered to an entry naming `multi-station-v1`, but stays mapped.
- A6. The shared `plannedQty` the host judges by is the one the station's copy holds from the last list (host D7 uses `shifts.planned_qty`).

**Spec / host-plan gaps found (for the owner):**

- G1. `participants[]` does not say a device is revoked, but the host frees a revoked device's slot (host D3): the card may say «Линия занята» where the host would let the station in. Suggest a `revoked` flag on `ShiftParticipant`, or that the host lists a revoked active participant with a distinct state.
- G2. Totals have no push (host D11): the station polls `GET /v1/device/shifts` every 15 s while a shared shift is open; the load/soak plan should include N stations × one list read per 15 s with the totals queries.
- G3. The spec does not say whether a sign-out (operator change, idle lock) pauses the part; this plan pauses only on «Выйти из смены» and a line change (S10). Owner to confirm.
- G4. A pause in flight can reach the host after a re-entry (no ordering between leave and entry on the host): the host then shows the station `left` while it works. Suggest the host ignore a leave older than the participant's last `joinedAt` if the station sends its request instant.
- G5. The spec's offline rule (§12.9) does not apply to a shift that only ever had one participant: the host refuses such a close without a reason (host D7), so the station keeps stage 2a's rule there, offline too.
- G6. After a station closed its part and left the closed panel, the hub hides the shift (stage 2a's `local_state = 'closed'`), so «waiting for the others» is seen only on the closed panel and in the office. The spec is silent; a hub card for a closed part is a possible follow-up.
- G7. Spec «K из totals хоста»: the station adds its own codes not yet sent to the others' part by the host (S5), so K never trails «Моя станция»; the host's count wins at the next read.
- G8. §12.2 (A4 pallet sheet, disaggregation, regrouping per device) has nothing on the station side in this milestone; the station's pallets stay its own.
