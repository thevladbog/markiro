# Multi-station shift: office implementation plan (milestone 2b, part 4 of 5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the office of «Markiro Автоном» run and read a shift that several stations and
handhelds work at once: a line's limit of devices, a shift's participants with each device's part of
the totals, a forced close of the whole shift with the list of who had not closed, the reason a shared
shift was closed without, the participation status on «Устройства» and «Обзор», and the blank's new
closing rule.

**Architecture:** Everything is read from the host's additive wire fields (`OfficeShift.participants`,
`byDevice`, `closeReasonMissing`, `OfficeLine.maxStations`) that the host plan delivers; nothing is
computed from facts in the webview. One pure module (`office/shifts/participation.ts`) holds every rule
about participants (state looks, silence, who works a shift, a device's presence), so the shift list,
the card, «Устройства» and «Обзор» agree. New screens are small components over the existing office
layer (`PagedTable`, `FormDialog`, `StatusChip`, `DefinitionGrid`, `RowActionBar`): no new table
column is added to the shift list or the device list, the new columns live in the card's new tab.
The blank's wording is a new optional field of `ShiftTaskFormData`, because the renderer is shared
with the cloud, where the old sentence is true.

**Tech Stack:** TypeScript (strict, `exactOptionalPropertyTypes`), React 19, react-hook-form + Zod 4,
TanStack Query, i18next (`ru.json` only), `@markiro/ui`, Vitest + Testing Library (jsdom), plain CSS in
`src/app/shell.css` and `src/office/overview/overview.css`.

**Spec:** `docs/superpowers/specs/2026-10-20-standalone-multi-station-shift-design.md` §7 (office,
reports, texts), §4 and §12. **Host plan (the contract this plan consumes exactly):**
`docs/superpowers/plans/2026-10-20-multi-station-host.md`, section «Host contract for the other plans»
and decisions D1–D18. Sibling plans: station, handheld, load/soak.

**Commands.** `$WT` is the absolute path of the executor's worktree (`/tmp/claude/wt/<NAME>`,
`docs/standalone/ledger/exec-rules.md`). Never `cd`. pnpm runs as
`pnpm --dir "$WT" --config.verifyDepsBeforeRun=false …`; one test file as
`pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/<file>`;
git as `git -C "$WT" …`. In a fresh worktree build the shared packages first:
`pnpm --dir "$WT" --config.verifyDepsBeforeRun=false turbo run build --filter='@markiro/standalone^...'`
(this also rebuilds `@markiro/domain`, which Task 12 changes). The test environment makes a missing
i18n key throw, so every text a test reaches must exist in `ru.json` first (Task 2 adds all of them).

## Global Constraints

From the spec (owner decisions of 2026-10-20, §1, §7, §12):

- Several stations and handhelds work one shift in parallel, one product, each device with its own boxes; each device has its own pallets; a handheld is a full participant, equal to a station.
- Each participant closes its own part; the shift closes when every participant closed; the office may close the whole shift.
- Counter and plan: «Моя станция: N · Всего в смене: K из M»; the plan is reached by the shift-wide total (the office shows the shift-wide `totals.acceptedUnits` against `plannedQty`).
- Free entry; the line has a limit of devices in one shift, 1–16, default 1 (`maxStations`).
- Office, line: field «Максимум станций» (default 1); a decrease below the number of active participants is refused; audited (the host writes `line.max_stations_changed`).
- Office, shift: «таблица участников (устройство, вид, вошёл, состояние, принято, коробов, паллет); итог по смене и разбивка по устройствам; «Закрыть смену целиком» с предупреждением «Не закрыли: …» и обязательной причиной».
- Office, devices and «Обзор»: «статус участия в смене; на карточке линии «станций в смене: N из M»; пункт «Требует внимания», если активный участник молчит дольше порога (10 минут)».
- Blank (`packages/domain/src/print-forms/shift-task-form.ts:204`): «Каждая станция закрывает свою часть; смена закрывается, когда закрыли все, или из офиса».
- Exports (ЧЗ, CSV/1C) are keyed by `shift_id`: check the formats with several devices.
- Open question §12.9: a station that closes offline closes without a reason; the shift then closes with «причина не указана» and a visible request in the office (the shift is not blocked, the office supplies the reason).
- `closed_by_kind = 'devices'` cannot be stored (host D6): the office reads who closed a part from `participants[].closedBy` (`device` | `office_user`).
- With `max_stations = 1` clients see no change (spec §4.3): a shift with one participant, a line with limit 1 and a host before protocol 7 (no `participants`) look exactly as today.
- Release order: host first, then station, office, handheld; each separately.

From the host contract (exact names, protocol 7, build 1.1.0):

- `OfficeShift` gains `participants?: ShiftParticipant[]`, `byDevice?: DeviceTotals[]` (same order as `participants`; the sum of `accepted` equals `totals.acceptedUnits`), `closeReasonMissing?: true` (absent when false). `ShiftParticipant`: `deviceId, deviceKind ("station"|"handheld"), deviceName, state ("active"|"left"|"closed"), firstEnteredAt, joinedAt, leftAt, closedAt, closedBy ("device"|"office_user"|null), closedActualQty, closedReasonCode, lateDataAt, lastSeenAt` (nullable ones are `null`, not absent), plus the optional `joinedRev` (a device's leave token, host post-review `651eb1c06`; absent from an older host; the office neither shows nor sends it). A shared shift's `closedAt` is the LATEST device close instant among its parts (host D6 as amended, `9a9d5b578`), whatever order the closes arrived in; `closedBy` is the last closer.
- `OfficeLine.maxStations?: 1..16` (absent from an older host = 1); `LineUpdate.maxStations?`; refusals `400 validation_failed` on `maxStations`, `409 conflict` `line_stations_in_use` `{ active }`, `409 conflict` `line_name`, `409 stale_revision`.
- `POST /v1/office/shifts/{id}/close` `{ reason (3–500 chars), expectedRev }` is unchanged in body; it closes every `active`/`left` participant as the office's and audits `shift.force_closed` `{ reason, notClosed }`, which replaces `shift.close` for EVERY office close, a single-device shift included (old rows keep `shift.close`). The «Не закрыли: …» preview is `participants.filter(state != "closed")` of the loaded shift; the loaded `rev` makes it exact (every participant change stamps the shift's `rev`).
- `PUT /v1/office/shifts/{id}/close-reason` `{ reasonCode, expectedRev }` → `OfficeShift`; errors `400 reasonCode`, `404`, `409 stale_revision`, `409 conflict` `close_reason_not_missing`.
- Fixtures the plan reads (all in `apps/standalone/proto/fixtures/`): `office-shift-participants.json`, `device-shifts-participants.json`, `office-line.json` (with `maxStations`), `line-update-max-stations.json`, `shift-close-reason-set.json`, `error-line-stations-in-use.json`.

From `apps/standalone/AGENTS.md` («Office pages») and the root `AGENTS.md`:

- Every office request goes through `session.call` with `session.api` (`useOfficeQuery`, `useOfficeMutation`); pages never call `invoke`, `HostClient` or `createHostApi`. React Query keeps one cache per session, no retries, no refetch on focus.
- Every update of a revisioned record sends the loaded record's `expectedRev`; on `stale_revision` the page offers to load the data again and never retries with `details.currentRev`.
- A dialog around one form is a `FormDialog`; its `onSubmit` never rejects: only the awaited write sits in the `try`, the callback after it runs after the `try/catch` whose `catch` ends with `return`. `writeFailure` sorts a refused write; anything else is a `WriteFailureAlert`. A success notice is an `Alert` that goes away when the next save starts.
- Request bodies are built field by field (`src/host/requests.ts`), never spread from form values.
- Lists of archivable records show active before archived (`activeFirstByName`). Whether a page shows a form or a read-only view comes from `useCan` (`src/office/access.ts`); the writes of shifts are `planShifts` (admin, technologist), of lines `editReference` (admin). Role visibility: «Устройства» is administrators only.
- Every user-visible text goes through i18n (`ru.json`, one language, `office.*`); never hard-code Russian in a component. A count that needs a plural uses the four forms `_one`, `_few`, `_many`, `_other`.
- TypeScript is strict with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`: no broad casts, no non-null assertions, no `any`; `import type` for type-only imports; Prettier (`printWidth` 100, double quotes, trailing commas) and the root ESLint.
- Accessibility: keyboard operation, visible focus, semantic controls, labels, useful errors; state is never colour alone (icon/glyph plus text: `StatusChip`).
- Print name through `shiftProductTitle`; a product's own full name only where the list already shows it.
- Tenant isolation does not apply (single site). Audit rows are the host's; the office writes none.
- Tests assert exact values; a pre-existing test changed because a product decision changed is named in the report; never weaken an assertion. Report automated checks separately from browser/Windows checks.
- Commits are scoped, stage explicit paths, and end with exactly one trailer line `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` (executor rules).

From the design kit (`docs/design-briefs/design-kit-2026-10.md`; the mock file `/tmp/claude/mocks/office-redesign/DESIGN.md` named in the brief does not exist on this machine, see Self-Review gap G1):

- One layer: a card or panel is one `surface` with a hairline; no container inside a container for decoration; sections inside a card are separated by spacing or hairlines; no shadows on cards (only overlays: modal, drawer, menu).
- Tokens only: no hex or `rgb()` literal, no gradient in new CSS; numbers, counters and codes are Plex Mono (`mono: true` columns, `font-mono`).
- State by icon and text: tags are `StatusChip` with a phase (glyph and tone derive from the phase only; grey is allowed only for `draft`, `retired`, `dismantled`, `none`).
- Office table rows are 56 px (`--table-row-h`), row actions 36–40 px, a row menu entry 40 px; a table is a keyboard-reachable scroll region with a name; a list sits in `ListCard`; a warning inside a table cell is a wrapping sentence, not a tall chip.
- Drawer (card of a shift) and dialog patterns exist: `SidePanel` `size="complex"` with `DataTabs`, `FormDialog` (modal 480 px default), `Modal`. Do not invent a parallel pattern.
- The office has to hold at its smallest window (960 × 600) and at 1280 × 690: the page never grows wider than the window, a table scrolls inside its card, nothing breaks letter by letter.

---

## Decisions taken by this plan (with reasons)

- **O1. No new column in the shift list or the device list.** At 1280 px both tables are already at their limit (the device list wraps «(при подключении)» so that «Доступ» and the actions stay in view). The shift list keeps its six data columns: the participants summary is one quiet line and the «Причина не указана» chip in the existing «Статус · режим» cell (`ShiftMarks`). The device list shows participation as a chip under the line name in the existing «Линия» column. The participants table, the spec's «таблица участников», is the card's new tab «Станции».
- **O2. A shift is «shared» when it names more than one participant** (`participants.length > 1`, `isSharedShift`). Only then does the office say «целиком» (title, button, row action). A one-participant shift and a shift from a host before protocol 7 keep every existing text, so every pre-existing test stays valid.
- **O3. The «Не закрыли: …» preview is computed from the loaded shift**, not from a new host field (the host contract has none): `participants.filter(state != "closed")`, shown whenever at least one participant is open, shared or not. The dialog sends the loaded `rev`, so a preview older than the host's state ends as `stale_revision` («Загрузить заново»), never as a wrong close.
- **O4. «Причина не указана»** is the host's `closeReasonMissing` (D7). The office action «Указать причину» (administrators and technologists, `planShifts`) opens a select of the six reason codes (`SHIFT_CLOSE_REASON_CODES`, the same words as a station's code in «Причина расхождения: …») and calls `PUT …/close-reason`. A repeated or raced write (`close_reason_not_missing`) is an «already set» alert with the list read again.
- **O5. Silence.** A participant is silent when it is `active` and the host last heard it (`lastSeenAt`, falling back to `joinedAt`) more than 10 minutes before «now». The card marks it (attention chip «Нет связи» plus the last time); «Обзор» lists it only for lines whose limit is above 1 (so a default site is unchanged) and then suppresses the plain `device_silent` row of the same device, so one problem is one row. «Now» is the host's clock in «Обзор» (as the rest of its ageing) and this PC's in the card.
- **O6. Line card: «станций в смене: N из M»** is shown only for a line whose limit is above 1 and whose active shift names participants (a deviation from the spec text, which shows it always: at limit 1 it would add a row of noise to every existing site, spec §4.3). N is the count of `active` participants, M the line's `maxStations`.
- **O7. Line form.** The limit is edited in the existing «Переименовать» dialog (kind `rename`); adding and restoring a line do not carry it (the host's `LineCreate` has no limit: a new line starts at 1). The form refuses a value below the busiest active shift's active participants as soon as the shift list is read (client-side hint), and maps the host's `line_stations_in_use` to the same field. The row action keeps its label «Переименовать» (see gap G5).
- **O8. «Устройства» and the owner-based helpers.** `stationShift` (device dialog) and `installWarnings` (update flow) find a device's active shift by `ownerDeviceId`, which in a shared shift is only «who opened it» (host D6, spec §4.1). Both move to `deviceWorksShift`: with participants, an `active` participant; without them (an older host), the owner as before.
- **O9. The blank.** `renderShiftTaskFormHtml` is also the cloud's renderer (`apps/api` `ShiftsController`), where the cloud's rule (`stationClosePolicy` `single_device` | `admin_only`) makes the old sentence true. So the new sentence is selected by a new optional `closingRule: "opener" | "each_part"` of `ShiftTaskFormData`; left out it is `"opener"` and every cloud byte stays; the standalone office passes `"each_part"`. The cloud's golden parity fixtures do not change; the standalone's parity test declares the one sentence it differs by.
- **O10. Nothing to regenerate in the production attestation.** `deploy/production/legal-artifacts-attestation.json` pins legal documents only; no file under `deploy`, `tools`, `.github` or `packages/legal-documents` names a print form or its fixtures (searched). Print-form fixtures are pinned by `print-forms-snapshot.test.ts` (`toMatchFileSnapshot`) and by the cloud/standalone parity golden. Consequences are listed in Task 12.

## File structure

| File                                                                                                                             | Responsibility                                                        | Tasks |
| -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ----- |
| `apps/standalone/src/host/requests.ts`                                                                                           | `lineUpdate` with the limit, `lineMaxStations`, `shiftCloseReasonSet` | 1     |
| `apps/standalone/src/host/api.ts`                                                                                                | `setShiftCloseReason`                                                 | 1     |
| `apps/standalone/test/support/office.tsx`, `test/support/shifts.ts`                                                              | fake API method; shared-shift fixtures                                | 1, 3  |
| `apps/standalone/src/i18n/ru.json`                                                                                               | every new text                                                        | 2     |
| `apps/standalone/src/office/shifts/participation.ts` (new)                                                                       | participant rules: looks, silence, works, presence                    | 3     |
| `apps/standalone/src/lib/rules.ts`                                                                                               | `maxStationsRule`                                                     | 4     |
| `apps/standalone/src/office/lines/line-form.ts` (new), `LineDialog.tsx`, `LinesPage.tsx`                                         | the line's limit                                                      | 4     |
| `apps/standalone/src/office/shifts/ShiftMarks.tsx` (new), `ShiftStations.tsx` (new), `ShiftDrawer.tsx`, `ShiftsPage.tsx`         | participants tab, marks                                               | 5     |
| `apps/standalone/src/office/shifts/ShiftTotalsDialog.tsx`                                                                        | per-device breakdown                                                  | 6     |
| `apps/standalone/src/office/shifts/CloseShiftDialog.tsx`                                                                         | whole-shift close with the preview                                    | 7     |
| `apps/standalone/src/office/shifts/CloseReasonDialog.tsx` (new)                                                                  | supplying the missing reason                                          | 8     |
| `apps/standalone/src/office/devices/DevicesPage.tsx`, `station-shift.ts`, `src/office/info/update-flow.ts`                       | presence, owner-free helpers                                          | 9     |
| `apps/standalone/src/office/overview/{overview-model,dashboard-model}.ts`, `LineCards.tsx`, `overview.css`, `OfficeOverview.tsx` | line card, attention                                                  | 10    |
| `apps/standalone/test/export-multi-station.test.ts` (new)                                                                        | export check with two devices                                         | 11    |
| `packages/domain/src/print-forms/shift-task-form.ts`, `apps/standalone/src/office/forms/form-data.ts`                            | the blank's closing rule                                              | 12    |
| `apps/standalone/src/app/shell.css`, tests `office-layout`, `overview-layout`                                                    | layout contract                                                       | 13    |
| `apps/standalone/AGENTS.md`                                                                                                      | docs                                                                  | 14    |

---

### Task 1: Client — `lineUpdate` with the limit, `shiftCloseReasonSet`, `setShiftCloseReason`

**Files:**

- Modify: `apps/standalone/src/host/requests.ts:125-144` (`LineChange`, `lineUpdate`), after `:596` (`shiftClose`)
- Modify: `apps/standalone/src/host/api.ts:217` (imports), `:449` (interface, after `closeShift`), `:1227-1232` (implementation, after `closeShift`)
- Modify: `apps/standalone/test/support/office.tsx:162` (fake API)
- Test: `apps/standalone/test/multi-station-requests.test.ts` (new)

**Interfaces:**

- Consumes (host plan Tasks 2 and 11, `src/host/protocol.ts`): `ShiftCloseReasonSet`, `shiftCloseReasonSetSchema`, `lineUpdateSchema` (with optional `maxStations`), `officeShiftSchema`, `OfficeLine.maxStations?`.
- Produces: `lineMaxStations(line: Pick<OfficeLine, "maxStations">): number`; `LineChange.maxStations?: number`; `lineUpdate(line: Pick<OfficeLine, "name" | "archived" | "rev" | "maxStations">, next: LineChange): LineUpdate`; `shiftCloseReasonSet(reasonCode: string, expectedRev: number): ShiftCloseReasonSet`; `HostApi.setShiftCloseReason(token: string, id: string, set: ShiftCloseReasonSet): Promise<OfficeShift>` (`PUT /v1/office/shifts/{id}/close-reason`).

- [ ] **Step 0: Pre-flight.** The host plan's Task 2 (Zod, fixtures) and Task 11 (`maxStations` on `OfficeLine`/`LineUpdate`) must be on the branch. Run `git -C "$WT" log --oneline -20 -- apps/standalone/src/host/protocol.ts` and `grep -n "shiftCloseReasonSetSchema\|maxStationsSchema\|closeReasonMissing" "$WT/apps/standalone/src/host/protocol.ts"`. Expected: all three names are found. If not, stop: this plan consumes that contract exactly and does not define it.

- [ ] **Step 1: Write the failing test** `apps/standalone/test/multi-station-requests.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { createHostApi, type HostApi } from "../src/host/api.js";
import type { HostClient, HttpMethod } from "../src/host/client.js";
import { lineUpdateSchema, shiftCloseReasonSetSchema } from "../src/host/protocol.js";
import { lineMaxStations, lineUpdate, shiftCloseReasonSet } from "../src/host/requests.js";
import { fixture } from "./support/proto-fixture.js";

const LINE = { name: "Линия 2", archived: false, rev: 40 } as const;
const TOKEN = "office-session-token";
const SHIFT_ID = "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b";

describe("the line's limit in a line update (plan 2b)", () => {
  it("reads a line of a host before protocol 7 as a line of one station", () => {
    expect(lineMaxStations(LINE)).toBe(1);
    expect(lineMaxStations({ ...LINE, maxStations: 3 })).toBe(3);
  });

  it("sends the limit only when it differs from the loaded one, with the loaded revision", () => {
    const same = { name: "Линия 2", archived: false };
    expect(lineUpdate({ ...LINE, maxStations: 2 }, { ...same, maxStations: 3 })).toEqual({
      expectedRev: 40,
      maxStations: 3,
    });
    expect(lineUpdate({ ...LINE, maxStations: 2 }, { ...same, maxStations: 2 })).toEqual({
      expectedRev: 40,
    });
    // A line with no limit is a line of one: typing 1 again changes nothing.
    expect(lineUpdate(LINE, { ...same, maxStations: 1 })).toEqual({ expectedRev: 40 });
    // A caller that says nothing of the limit never touches it.
    expect(lineUpdate({ ...LINE, maxStations: 2 }, same)).toEqual({ expectedRev: 40 });
  });

  it("builds exactly the body of the shared fixture", () => {
    expect(
      lineUpdate(
        { name: "Линия 2", archived: false, rev: 40, maxStations: 2 },
        { name: "Линия 2", archived: false, maxStations: 3 },
      ),
    ).toEqual(lineUpdateSchema.parse(fixture("line-update-max-stations.json")));
  });

  it("still sends a rename and an archive as before", () => {
    expect(lineUpdate(LINE, { name: "Линия 3", archived: true })).toEqual({
      expectedRev: 40,
      name: "Линия 3",
      archived: true,
    });
  });
});

describe("the reason of a shared shift (plan 2b)", () => {
  it("builds exactly the body of the shared fixture", () => {
    expect(shiftCloseReasonSet("equipment_stop", 88)).toEqual(
      shiftCloseReasonSetSchema.parse(fixture("shift-close-reason-set.json")),
    );
  });
});

interface Sent {
  method: HttpMethod;
  path: string;
  body: unknown;
  officeToken: string | undefined;
}

/** A client that records the request and answers `answer`, parsed by the caller's schema. */
function recording(answer: unknown): { api: HostApi; sent: Sent[] } {
  const sent: Sent[] = [];
  const client: HostClient = {
    request: async (method, path, options) => {
      sent.push({ method, path, body: options.body, officeToken: options.officeToken });
      return options.schema.parse(answer);
    },
  };
  return { api: createHostApi(client), sent };
}

describe("HostApi.setShiftCloseReason (plan 2b)", () => {
  it("puts the code with the loaded revision on the shift's close-reason route", async () => {
    const { api, sent } = recording(fixture("office-shift-participants.json"));
    const body = shiftCloseReasonSetSchema.parse(fixture("shift-close-reason-set.json"));
    const shift = await api.setShiftCloseReason(TOKEN, SHIFT_ID, body);
    expect(sent).toEqual([
      {
        method: "PUT",
        path: `/v1/office/shifts/${SHIFT_ID}/close-reason`,
        body,
        officeToken: TOKEN,
      },
    ]);
    expect(shift.closeReasonMissing).toBe(true);
    expect(shift.participants?.map((participant) => participant.state)).toEqual([
      "closed",
      "closed",
    ]);
  });

  it("refuses an answer that is no shift", async () => {
    const { api } = recording({
      ...(fixture("office-shift-participants.json") as object),
      status: "open",
    });
    await expect(
      api.setShiftCloseReason(TOKEN, SHIFT_ID, { reasonCode: "equipment_stop", expectedRev: 88 }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run it to verify it fails.**
      Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/multi-station-requests.test.ts`
      Expected: FAIL (`lineMaxStations`, `shiftCloseReasonSet` are not exported; `setShiftCloseReason` is not a function).

- [ ] **Step 3: Implement the builders.** In `apps/standalone/src/host/requests.ts` replace `LineChange` and `lineUpdate` (`:125-144`) with:

```ts
/**
 * What a line is to become; `lineUpdate` sends what differs from the loaded
 * line. `name` is the trimmed value `lineNameRule` accepted. `maxStations` is
 * the line's limit of devices in one shift (plan 2b), the number
 * `maxStationsRule` accepted; left out, the limit is not touched.
 */
export interface LineChange {
  name: string;
  archived: boolean;
  maxStations?: number;
}

/** A line's limit of devices in one shift; a host before protocol 7 sends none, which is one. */
export function lineMaxStations(line: Pick<OfficeLine, "maxStations">): number {
  return line.maxStations ?? 1;
}

/**
 * `PUT /v1/office/lines/{id}` (`line-update.json`, `line-update-max-stations.json`):
 * only the fields that change, with the loaded revision.
 */
export function lineUpdate(
  line: Pick<OfficeLine, "name" | "archived" | "rev" | "maxStations">,
  next: LineChange,
): LineUpdate {
  const update: LineUpdate = { expectedRev: line.rev };
  if (next.name !== line.name) update.name = next.name;
  if (next.archived !== line.archived) update.archived = next.archived;
  if (next.maxStations !== undefined && next.maxStations !== lineMaxStations(line)) {
    update.maxStations = next.maxStations;
  }
  return update;
}
```

Add `OfficeLine` and `ShiftCloseReasonSet` to the type imports of the file if they are not there (`OfficeLine` is already imported at the top for `Pick<OfficeLine, …>`; check with `grep -n "OfficeLine\|ShiftCloseReasonSet" "$WT/apps/standalone/src/host/requests.ts"` and add the missing name in alphabetical order). After `shiftClose` (`:594-596`) add:

```ts
/**
 * `PUT /v1/office/shifts/{id}/close-reason` (`shift-close-reason-set.json`, plan 2b): one of the
 * six reason codes for a shared shift its devices closed without one, over the loaded revision.
 */
export function shiftCloseReasonSet(reasonCode: string, expectedRev: number): ShiftCloseReasonSet {
  return { reasonCode, expectedRev };
}
```

- [ ] **Step 4: Implement the API method.** In `apps/standalone/src/host/api.ts` add `type ShiftCloseReasonSet,` to the protocol import list next to `type ShiftClose,` (`:217`). In the `HostApi` interface after `closeShift` (`:449`):

```ts
/**
 * `PUT …/close-reason` (plan 2b): the reason of a shared shift its devices closed without one;
 * `conflict` on `close_reason_not_missing` once it is set. Administrators and technologists.
 */
setShiftCloseReason: (token: string, id: string, set: ShiftCloseReasonSet) => Promise<OfficeShift>;
```

In `createHostApi` after the `closeShift` implementation (`:1227-1232`):

```ts
    setShiftCloseReason: (token, id, set) =>
      client.request("PUT", `/v1/office/shifts/${id}/close-reason`, {
        body: set,
        officeToken: token,
        schema: officeShiftSchema,
      }),
```

In `apps/standalone/test/support/office.tsx` after the `closeShift` line (`:162`) add:

```tsx
    setShiftCloseReason: vi.fn<HostApi["setShiftCloseReason"]>(() =>
      unexpected("setShiftCloseReason"),
    ),
```

- [ ] **Step 5: Run the test and the typecheck to verify they pass.**
      Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/multi-station-requests.test.ts test/api.test.ts test/protocol.test.ts` then `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`.
      Expected: PASS, no type errors (every `FakeHostApi` is exhaustive over `HostApi`, so the support edit above is required).

- [ ] **Step 6: Format and commit.**
      Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false exec prettier --write apps/standalone/src/host/requests.ts apps/standalone/src/host/api.ts apps/standalone/test/support/office.tsx apps/standalone/test/multi-station-requests.test.ts`

```bash
git -C "$WT" add apps/standalone/src/host/requests.ts apps/standalone/src/host/api.ts \
  apps/standalone/test/support/office.tsx apps/standalone/test/multi-station-requests.test.ts
git -C "$WT" commit -m "feat(standalone): office client — a line's limit and the missing close reason (plan 2b)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Russian texts of the multi-station office, pinned

**Files:**

- Modify: `apps/standalone/src/i18n/ru.json` (anchors below; every anchor was unique when this plan was written, `grep -cF` gave 1 — re-check before each edit and widen the anchor if a later change made it ambiguous)
- Test: `apps/standalone/test/multi-station-strings.test.ts` (new)

**Interfaces:**

- Consumes: nothing.
- Produces: the keys listed in the test below, used verbatim by Tasks 4–10. Plural families `office.lines.fields.maxStationsInUse` and `office.lines.errors.stationsInUse` have `_one`, `_few`, `_many`, `_other`.

- [ ] **Step 1: Write the failing test** `apps/standalone/test/multi-station-strings.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import ru from "../src/i18n/ru.json";

/** The text at a dotted path of `ru.json`; a missing path or a non-text throws, naming it. */
function text(path: string): string {
  let node: unknown = ru;
  for (const part of path.split(".")) {
    if (typeof node !== "object" || node === null || !(part in node)) {
      throw new Error(`no key ${path}`);
    }
    node = Reflect.get(node, part);
  }
  if (typeof node !== "string") throw new Error(`${path} is not a text`);
  return node;
}

const KEYS = [
  "rules.maxStations",
  "office.lines.table.maxStations",
  "office.lines.fields.maxStations",
  "office.lines.fields.maxStationsHint",
  "office.shifts.closeAll",
  "office.shifts.closeAllNamed",
  "office.shifts.closeAllTitle",
  "office.shifts.closeAllSubmit",
  "office.shifts.closeAllIntro",
  "office.shifts.notClosed",
  "office.shifts.notClosedItem",
  "office.shifts.notClosedState.active",
  "office.shifts.notClosedState.left",
  "office.shifts.stationsLine",
  "office.shifts.reasonMissing",
  "office.shifts.supplyReason",
  "office.shifts.supplyReasonNamed",
  "office.shifts.reasonTitle",
  "office.shifts.reasonIntro",
  "office.shifts.reasonSubmit",
  "office.shifts.reasonSaved",
  "office.shifts.fields.reasonCode",
  "office.shifts.fields.reasonCodePlaceholder",
  "office.shifts.errors.reasonRequired",
  "office.shifts.errors.reasonAlreadySet",
  "office.shifts.totals.byDevice",
  "office.shifts.totals.byDeviceValue",
  "office.shifts.totals.byDeviceUnits",
  "office.shiftCard.tabs.stations",
  "office.shiftCard.participants.title",
  "office.shiftCard.participants.summary",
  "office.shiftCard.participants.table",
  "office.shiftCard.participants.pager",
  "office.shiftCard.participants.device",
  "office.shiftCard.participants.joined",
  "office.shiftCard.participants.state",
  "office.shiftCard.participants.accepted",
  "office.shiftCard.participants.boxes",
  "office.shiftCard.participants.pallets",
  "office.shiftCard.participants.closedAt",
  "office.shiftCard.participants.closedQty",
  "office.shiftCard.participants.lastSeen",
  "office.shiftCard.participants.states.active",
  "office.shiftCard.participants.states.silent",
  "office.shiftCard.participants.states.left",
  "office.shiftCard.participants.states.closedDevice",
  "office.shiftCard.participants.states.closedOffice",
  "office.devices.presence.active",
  "office.devices.presence.left",
  "office.devices.presence.closed",
  "office.overview.lines.stations",
  "office.overview.attention.participant.title",
  "office.overview.attention.participant.detail",
  "office.overview.attention.participant.action",
  "office.overview.attention.closeReason.title",
  "office.overview.attention.closeReason.detail",
  "office.overview.attention.closeReason.action",
] as const;

const PLURALS = [
  "office.lines.fields.maxStationsInUse",
  "office.lines.errors.stationsInUse",
] as const;

describe("the texts of the multi-station office (plan 2b)", () => {
  it.each(KEYS)("has %s", (key) => {
    expect(text(key).trim()).not.toBe("");
  });

  it.each(PLURALS)("has the four plural forms of %s, each with the count", (base) => {
    for (const form of ["one", "few", "many", "other"]) {
      expect(text(`${base}_${form}`)).toContain("{{count}}");
    }
  });

  it("pins the owner's words", () => {
    expect(text("office.lines.fields.maxStations")).toBe("Максимум станций в смене");
    expect(text("office.shifts.closeAllSubmit")).toBe("Закрыть смену целиком");
    expect(text("office.shifts.notClosed")).toBe("Не закрыли: {{devices}}.");
    expect(text("office.shifts.reasonMissing")).toBe("Причина не указана");
    expect(text("office.overview.lines.stations")).toBe("станций в смене: {{active}} из {{max}}");
  });

  it("keeps the placeholders the components pass", () => {
    expect(text("office.shifts.notClosedItem")).toBe("{{name}} ({{state}})");
    expect(text("office.shifts.totals.byDeviceValue")).toContain("{{units}}");
    expect(text("office.shifts.totals.byDeviceValue")).toContain("{{boxes}}");
    expect(text("office.shifts.totals.byDeviceValue")).toContain("{{pallets}}");
    expect(text("office.shifts.reasonIntro")).toContain("{{plan}}");
    expect(text("office.shifts.reasonIntro")).toContain("{{accepted}}");
    expect(text("office.devices.presence.active")).toContain("{{number}}");
    expect(text("office.overview.attention.participant.title")).toContain("{{duration}}");
  });
});
```

- [ ] **Step 2: Run it to verify it fails.**
      Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/multi-station-strings.test.ts`
      Expected: FAIL (`no key rules.maxStations`, and the rest).

- [ ] **Step 3: Add the texts.** Each edit is `old_string` → `new_string` in `apps/standalone/src/i18n/ru.json` (the file is pretty-printed with two-space indentation; keep it).

3a. `rules` (before `closeReason`, `:2114`):

old:

```
    "closeReason": "Опишите причину: от 3 до 500 символов"
```

new:

```
    "maxStations": "Укажите целое число от 1 до 16",
    "closeReason": "Опишите причину: от 3 до 500 символов"
```

3b. `office.lines.table` (`:3331-3336`):

old:

```
        "status": "Состояние",
        "actions": "Действия"
      },
      "rename": "Переименовать",
```

new:

```
        "maxStations": "Макс. станций",
        "status": "Состояние",
        "actions": "Действия"
      },
      "rename": "Переименовать",
```

3c. `office.lines.fields` (`:3351-3353`):

old:

```
        "name": "Название линии"
      },
```

new:

```
        "name": "Название линии",
        "maxStations": "Максимум станций в смене",
        "maxStationsHint": "От 1 до 16: станции и ТСД считаются вместе. Каждое устройство закрывает свою часть смены.",
        "maxStationsInUse_one": "Сейчас в смене работает {{count}} устройство: меньше поставить нельзя.",
        "maxStationsInUse_few": "Сейчас в смене работают {{count}} устройства: меньше поставить нельзя.",
        "maxStationsInUse_many": "Сейчас в смене работают {{count}} устройств: меньше поставить нельзя.",
        "maxStationsInUse_other": "Сейчас в смене работают {{count}} устройств: меньше поставить нельзя."
      },
```

3d. `office.lines.errors`:

old:

```
        "nameTaken": "Активная линия с таким названием уже есть"
```

new:

```
        "nameTaken": "Активная линия с таким названием уже есть",
        "stationsInUse_one": "В смене этой линии работает {{count}} устройство: максимум не может быть меньше.",
        "stationsInUse_few": "В смене этой линии работают {{count}} устройства: максимум не может быть меньше.",
        "stationsInUse_many": "В смене этой линии работают {{count}} устройств: максимум не может быть меньше.",
        "stationsInUse_other": "В смене этой линии работают {{count}} устройств: максимум не может быть меньше."
```

3e. `office.shifts` — texts of closing and of the reason (after `closed`, `:3498`):

old:

```
      "closed": "Смена {{number}} закрыта.",
      "totals": {
```

new:

```
      "closed": "Смена {{number}} закрыта.",
      "closeAll": "Закрыть целиком",
      "closeAllNamed": "Закрыть смену {{number}} целиком",
      "closeAllTitle": "Закрыть смену {{number}} целиком",
      "closeAllSubmit": "Закрыть смену целиком",
      "closeAllIntro": "Закрытие в офисе закрывает смену для всех устройств сразу: каждое устройство, которое ещё не закрыло свою часть, закрывается вместе с ней. Причина обязательна, она попадёт в журнал действий. Данные, которые устройства пришлют позже, будут приняты и отмечены; смену они не откроют.",
      "notClosed": "Не закрыли: {{devices}}.",
      "notClosedItem": "{{name}} ({{state}})",
      "notClosedState": {
        "active": "работает",
        "left": "на паузе"
      },
      "stationsLine": "Устройств: {{total}}, закрыли часть: {{closed}}",
      "reasonMissing": "Причина не указана",
      "supplyReason": "Указать причину",
      "supplyReasonNamed": "Указать причину смены {{number}}",
      "reasonTitle": "Причина смены {{number}}",
      "reasonIntro": "План смены — {{plan}} шт, принято {{accepted}} шт. Устройства закрыли смену, не назвав причину расхождения с планом. Выберите её из списка: она попадёт в журнал действий.",
      "reasonSubmit": "Сохранить причину",
      "reasonSaved": "Причина смены {{number}} указана.",
      "totals": {
```

3f. `office.shifts.fields` (the form fields object ends with `reasonHint`, `:3566-3568`):

old:

```
        "reasonHint": "От 3 до 500 символов, одной строкой. Её увидят в списке смен и в журнале действий."
      },
```

new:

```
        "reasonHint": "От 3 до 500 символов, одной строкой. Её увидят в списке смен и в журнале действий.",
        "reasonCode": "Причина расхождения",
        "reasonCodePlaceholder": "Выберите причину"
      },
```

3g. `office.shifts.errors`:

old:

```
        "notOpen": "Смена ещё не открыта на станции. Список смен обновлён."
      },
```

new:

```
        "notOpen": "Смена ещё не открыта на станции. Список смен обновлён.",
        "reasonRequired": "Выберите причину из списка",
        "reasonAlreadySet": "Причина уже указана. Список смен обновлён."
      },
```

3h. `office.shifts.totals` (before `unknownDevice`, `:3510`):

old:

```
        "unknownDevice": "Устройство {{id}}…",
```

new:

```
        "byDevice": "По устройствам",
        "byDeviceValue": "{{units}} шт · {{boxes}} кор. · {{pallets}} пал.",
        "byDeviceUnits": "{{units}} шт",
        "unknownDevice": "Устройство {{id}}…",
```

3i. `office.shiftCard` tabs and the participants section (`:3737-3748`):

old:

```
        "exports": "Выгрузки"
      },
```

new:

```
        "exports": "Выгрузки",
        "stations": "Станции"
      },
      "participants": {
        "title": "Станции смены",
        "summary": "Принято в смене: {{accepted}} · План: {{plan}} · Часть закрыли: {{closed}} из {{total}}",
        "table": "Участники смены",
        "pager": "Страницы списка участников",
        "device": "Устройство",
        "joined": "Вход",
        "state": "Состояние",
        "accepted": "Принято",
        "boxes": "Коробов",
        "pallets": "Паллет",
        "closedAt": "Закрыто {{at}}",
        "closedQty": "Принято при закрытии: {{units}}",
        "lastSeen": "Слышали: {{at}}",
        "states": {
          "active": "Работает",
          "silent": "Нет связи",
          "left": "На паузе",
          "closedDevice": "Часть закрыта",
          "closedOffice": "Закрыто из офиса"
        }
      },
```

3j. `office.devices.presence` (after `link`, `:4337-4343`):

old:

```
        "heard": "Слышали: {{at}}"
      }
    },
```

new:

```
        "heard": "Слышали: {{at}}"
      },
      "presence": {
        "active": "В смене {{number}}",
        "left": "На паузе в смене {{number}}",
        "closed": "Часть закрыта в смене {{number}}"
      }
    },
```

3k. `office.overview.lines` (after `noScans`, `:4925`):

old:

```
        "noScans": "нет сканов {{duration}}",
```

new:

```
        "noScans": "нет сканов {{duration}}",
        "stations": "станций в смене: {{active}} из {{max}}",
```

3l. `office.overview.attention` (after `lineIdle`, `:4989-4994`):

old:

```
        "lineIdle": {
          "title": "Простой: {{line}}",
          "detail": "Нет сканов {{duration}}",
          "action": "Смена"
        }
      },
```

new:

```
        "lineIdle": {
          "title": "Простой: {{line}}",
          "detail": "Нет сканов {{duration}}",
          "action": "Смена"
        },
        "participant": {
          "title": "{{name}}: нет связи {{duration}}",
          "detail": "Смена {{shift}}, линия «{{line}}»",
          "action": "Станции"
        },
        "closeReason": {
          "title": "Смена {{number}} закрыта без причины",
          "detail": "Устройства не назвали причину расхождения с планом",
          "action": "Указать"
        }
      },
```

- [ ] **Step 4: Run the test and format.**
      Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/multi-station-strings.test.ts` — Expected: PASS.
      Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false exec prettier --check apps/standalone/src/i18n/ru.json apps/standalone/test/multi-station-strings.test.ts` — Expected: clean (`--write` on the test if not).
      Run the rest of the suite that reads `ru.json` (`rules.test.ts`, `office-shell.test.tsx`): `… exec vitest run test/rules.test.ts test/office-shell.test.tsx` — Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git -C "$WT" add apps/standalone/src/i18n/ru.json apps/standalone/test/multi-station-strings.test.ts
git -C "$WT" commit -m "feat(standalone): Russian texts of the multi-station office (plan 2b)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Participation rules (pure) and the shared-shift test fixtures

**Files:**

- Create: `apps/standalone/src/office/shifts/participation.ts`
- Modify: `apps/standalone/test/support/shifts.ts` (imports at `:1-17`; new exports after `CLOSED`, `:240`)
- Test: `apps/standalone/test/shift-participation.test.ts` (new)

**Interfaces:**

- Consumes: `OfficeShift`, `ShiftParticipant`, `ParticipantState` (host plan Task 2); `TagPhase` from `@markiro/ui`.
- Produces (src): `PARTICIPANT_SILENT_MS = 600_000`; `participantsOf(shift): readonly ShiftParticipant[]`; `isSharedShift(shift): boolean`; `activeParticipants(shift)`, `notClosedParticipants(shift)`, `closedParticipants(shift)`; `isSilent(participant, nowMs): boolean`; `lastSign(participant): string`; `type ParticipantLook = "active" | "silent" | "left" | "closedDevice" | "closedOffice"`; `participantLook(participant, nowMs): ParticipantLook`; `LOOK_PHASE: Record<ParticipantLook, TagPhase>`; `deviceWorksShift(shift, deviceId): boolean`; `type Presence = { shiftId: string; number: string; state: ParticipantState }`; `presenceOf(shifts, deviceId): Presence | null`.
- Produces (tests): from `test/support/shifts.ts`: `STATION_ID`, `HANDHELD_ID`, `participant(overrides?)`, `PARTICIPANT_A`, `PARTICIPANT_B`, `SHARED` (the active shift two devices work, 547 units: 427 + 120), `SHARED_NO_REASON` (the same, closed by its last device with `closeReasonMissing`).

- [ ] **Step 1: Write the failing test** `apps/standalone/test/shift-participation.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  activeParticipants,
  closedParticipants,
  deviceWorksShift,
  isSharedShift,
  isSilent,
  LOOK_PHASE,
  notClosedParticipants,
  participantLook,
  PARTICIPANT_SILENT_MS,
  participantsOf,
  presenceOf,
} from "../src/office/shifts/participation.js";
import {
  ACTIVE,
  CLOSED,
  HANDHELD_ID,
  participant,
  PARTICIPANT_A,
  PARTICIPANT_B,
  PLANNED,
  SHARED,
  SHARED_NO_REASON,
  STATION_ID,
} from "./support/shifts.js";

const NOW = Date.parse("2026-10-08T10:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe("the participants of a shift (plan 2b)", () => {
  it("reads a shift of a host before protocol 7 as one with no participants", () => {
    expect(participantsOf(ACTIVE)).toEqual([]);
    expect(isSharedShift(ACTIVE)).toBe(false);
    expect(isSharedShift({ participants: [PARTICIPANT_A] })).toBe(false);
    expect(isSharedShift(SHARED)).toBe(true);
  });

  it("splits participants by state", () => {
    const shift = {
      participants: [
        PARTICIPANT_A,
        participant({ deviceId: HANDHELD_ID, state: "left" }),
        participant({ deviceId: "0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e", state: "closed" }),
      ],
    };
    expect(activeParticipants(shift).map((each) => each.deviceId)).toEqual([STATION_ID]);
    expect(notClosedParticipants(shift).map((each) => each.state)).toEqual(["active", "left"]);
    expect(closedParticipants(shift).map((each) => each.state)).toEqual(["closed"]);
  });
});

describe("a silent participant (the owner's ten minutes)", () => {
  it("is an active one the host has not heard for more than ten minutes", () => {
    expect(PARTICIPANT_SILENT_MS).toBe(10 * 60 * 1000);
    const heard = (lastSeenAt: string | null, state: "active" | "left" | "closed" = "active") =>
      participant({ lastSeenAt, state });
    expect(isSilent(heard(ago(10 * 60_000)), NOW)).toBe(false);
    expect(isSilent(heard(ago(10 * 60_000 + 1)), NOW)).toBe(true);
    expect(isSilent(heard(ago(60_000)), NOW)).toBe(false);
  });

  it("is never one that left or closed, and falls back to the entry when never heard", () => {
    expect(isSilent(participant({ state: "left", lastSeenAt: ago(3_600_000) }), NOW)).toBe(false);
    expect(isSilent(participant({ state: "closed", lastSeenAt: ago(3_600_000) }), NOW)).toBe(false);
    expect(isSilent(participant({ lastSeenAt: null, joinedAt: ago(60_000) }), NOW)).toBe(false);
    expect(isSilent(participant({ lastSeenAt: null, joinedAt: ago(30 * 60_000) }), NOW)).toBe(true);
  });
});

describe("how a participant looks (state by glyph and word, never by colour alone)", () => {
  it("tells work, silence, pause and the two kinds of close apart", () => {
    const fresh = ago(60_000);
    expect(participantLook(participant({ lastSeenAt: fresh }), NOW)).toBe("active");
    expect(participantLook(participant({ lastSeenAt: ago(20 * 60_000) }), NOW)).toBe("silent");
    expect(participantLook(participant({ state: "left" }), NOW)).toBe("left");
    expect(participantLook(participant({ state: "closed", closedBy: "device" }), NOW)).toBe(
      "closedDevice",
    );
    expect(participantLook(participant({ state: "closed", closedBy: "office_user" }), NOW)).toBe(
      "closedOffice",
    );
  });

  it("maps each look to a phase of the kit's vocabulary", () => {
    expect(LOOK_PHASE).toEqual({
      active: "active",
      silent: "attention",
      left: "none",
      closedDevice: "done",
      closedOffice: "done",
    });
  });
});

describe("the shift a device works (the owner is only who opened it)", () => {
  it("is, with participants, the active shift where the device is an active participant", () => {
    expect(deviceWorksShift(SHARED, HANDHELD_ID)).toBe(true);
    // The owner opened it, then left: it no longer works it.
    const ownerLeft = {
      ...SHARED,
      participants: [{ ...PARTICIPANT_A, state: "left" as const }, PARTICIPANT_B],
    };
    expect(deviceWorksShift(ownerLeft, STATION_ID)).toBe(false);
    expect(deviceWorksShift(ownerLeft, HANDHELD_ID)).toBe(true);
    expect(deviceWorksShift(SHARED, "5e1a7c3b-9d2f-4b6a-8c4e-0f3d5b7a9c1e")).toBe(false);
  });

  it("is, without participants (an older host), the owner's active shift as before", () => {
    expect(deviceWorksShift(ACTIVE, STATION_ID)).toBe(true);
    expect(deviceWorksShift(ACTIVE, HANDHELD_ID)).toBe(false);
    expect(deviceWorksShift({ ...PLANNED, ownerDeviceId: STATION_ID }, STATION_ID)).toBe(false);
    expect(deviceWorksShift({ ...CLOSED, ownerDeviceId: STATION_ID }, STATION_ID)).toBe(false);
  });

  it("is never a closed shift's", () => {
    expect(deviceWorksShift(SHARED_NO_REASON, STATION_ID)).toBe(false);
  });
});

describe("a device's presence in the shifts", () => {
  it("is its state in an active shift, an active part before a paused one before a closed one", () => {
    const otherShift = {
      ...SHARED,
      id: "7e1f0a2b-3c4d-4e5f-8a6b-7c8d9e0f1a2b",
      number: "OCT26-006",
      participants: [{ ...PARTICIPANT_B, state: "left" as const }],
    };
    expect(presenceOf([SHARED], HANDHELD_ID)).toEqual({
      shiftId: SHARED.id,
      number: "OCT26-004",
      state: "active",
    });
    expect(presenceOf([otherShift, SHARED], HANDHELD_ID)?.state).toBe("active");
    expect(presenceOf([otherShift], HANDHELD_ID)?.state).toBe("left");
  });

  it("is none for a closed or planned shift, an unlisted device or an unread list", () => {
    expect(presenceOf([SHARED_NO_REASON, PLANNED], STATION_ID)).toBeNull();
    expect(presenceOf([SHARED], "5e1a7c3b-9d2f-4b6a-8c4e-0f3d5b7a9c1e")).toBeNull();
    expect(presenceOf(undefined, STATION_ID)).toBeNull();
    // A shift of an older host names no participants, so the page claims nothing.
    expect(presenceOf([ACTIVE], STATION_ID)).toBeNull();
  });
});
```

- [ ] **Step 2: Add the fixtures to `test/support/shifts.ts`.** In the type import block at the top (`:6-17`) add `ShiftParticipant,` (alphabetical, after `PalletSheets,`). After the `CLOSED` constant (`:240`) insert:

```ts
/** The station that opened `ACTIVE`, and a handheld that joined it (ids as `device-shifts-participants.json`). */
export const STATION_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
export const HANDHELD_ID = "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d";

/** A participant, the opening station by default; every field the host sends is present. */
export function participant(overrides: Partial<ShiftParticipant> = {}): ShiftParticipant {
  return {
    deviceId: STATION_ID,
    deviceKind: "station",
    deviceName: "Станция линии 1",
    state: "active",
    firstEnteredAt: "2026-10-08T06:02:00Z",
    joinedAt: "2026-10-08T06:02:00Z",
    leftAt: null,
    closedAt: null,
    closedBy: null,
    closedActualQty: null,
    closedReasonCode: null,
    lateDataAt: null,
    lastSeenAt: "2026-10-08T09:41:00Z",
    ...overrides,
  };
}

export const PARTICIPANT_A: ShiftParticipant = participant();
export const PARTICIPANT_B: ShiftParticipant = participant({
  deviceId: HANDHELD_ID,
  deviceKind: "handheld",
  deviceName: "ТСД 1",
  firstEnteredAt: "2026-10-08T06:30:00Z",
  joinedAt: "2026-10-08T07:10:00Z",
});

/**
 * `ACTIVE` worked by two devices, 547 accepted units between them (427 and 120), as
 * `device-shifts-participants.json` has it; the plan (1 200) is not met.
 */
export const SHARED: OfficeShift = {
  ...ACTIVE,
  participants: [PARTICIPANT_A, PARTICIPANT_B],
  byDevice: [
    { deviceId: STATION_ID, accepted: 427, boxesClosed: 35, pallets: 0 },
    { deviceId: HANDHELD_ID, accepted: 120, boxesClosed: 10, pallets: 0 },
  ],
  totals: { ...ACTIVE.totals, deviceIds: [STATION_ID, HANDHELD_ID] },
};

/** `SHARED` after its last device closed it without the reason the plan's gap needed (`office-shift-participants.json`). */
export const SHARED_NO_REASON: OfficeShift = {
  ...SHARED,
  status: "closed",
  closedAt: "2026-10-08T14:10:00Z",
  closeReasonMissing: true,
  rev: 88,
  participants: [
    participant({
      state: "closed",
      closedAt: "2026-10-08T14:10:00Z",
      closedBy: "device",
      closedActualQty: 427,
      lastSeenAt: "2026-10-08T14:10:02Z",
    }),
    participant({
      deviceId: HANDHELD_ID,
      deviceKind: "handheld",
      deviceName: "ТСД 1",
      joinedAt: "2026-10-08T07:10:00Z",
      firstEnteredAt: "2026-10-08T06:30:00Z",
      state: "closed",
      closedAt: "2026-10-08T13:00:00Z",
      closedBy: "device",
      closedActualQty: 120,
      lastSeenAt: "2026-10-08T13:00:01Z",
    }),
  ],
};
```

- [ ] **Step 3: Run the test to verify it fails.**
      Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shift-participation.test.ts`
      Expected: FAIL (`Cannot find module …/participation.js`).

- [ ] **Step 4: Write the module** `apps/standalone/src/office/shifts/participation.ts`:

```ts
import type { TagPhase } from "@markiro/ui";

import type { OfficeShift, ParticipantState, ShiftParticipant } from "../../host/protocol.js";

/**
 * Participation in a shift (plan 2b, spec §7): who is in it, in what state, who is silent, and
 * which shift a device works. One module, so the list, the card, «Устройства» and «Обзор» agree.
 * A shift of a host before protocol 7 names no participants (`participants` absent), and every
 * rule here then says «none»: the office looks as it did.
 */

/** An active participant the host has not heard for longer than this is silent (the owner's ten minutes). */
export const PARTICIPANT_SILENT_MS = 10 * 60 * 1000;

type WithParticipants = Pick<OfficeShift, "participants">;

/** The devices that entered the shift, first entry first; none for a host before protocol 7 or a planned shift. */
export function participantsOf(shift: WithParticipants): readonly ShiftParticipant[] {
  return shift.participants ?? [];
}

/** A shift several devices entered: only then does the office say «целиком». */
export function isSharedShift(shift: WithParticipants): boolean {
  return participantsOf(shift).length > 1;
}

/** Participants that hold a slot of the line now. */
export function activeParticipants(shift: WithParticipants): ShiftParticipant[] {
  return participantsOf(shift).filter((each) => each.state === "active");
}

/** Participants that have not closed their part (`active` and `left`): what a forced close would close. */
export function notClosedParticipants(shift: WithParticipants): ShiftParticipant[] {
  return participantsOf(shift).filter((each) => each.state !== "closed");
}

export function closedParticipants(shift: WithParticipants): ShiftParticipant[] {
  return participantsOf(shift).filter((each) => each.state === "closed");
}

/** The latest sign of life the host has: its last hearing, else the entry. */
export function lastSign(participant: ShiftParticipant): string {
  return participant.lastSeenAt ?? participant.joinedAt;
}

/** An active participant not heard for more than `PARTICIPANT_SILENT_MS` before `nowMs`. */
export function isSilent(participant: ShiftParticipant, nowMs: number): boolean {
  if (participant.state !== "active") return false;
  return nowMs - Date.parse(lastSign(participant)) > PARTICIPANT_SILENT_MS;
}

/** What a participant looks like: the word and the glyph of a phase, never a colour alone. */
export type ParticipantLook = "active" | "silent" | "left" | "closedDevice" | "closedOffice";

export function participantLook(participant: ShiftParticipant, nowMs: number): ParticipantLook {
  if (participant.state === "closed") {
    return participant.closedBy === "office_user" ? "closedOffice" : "closedDevice";
  }
  if (participant.state === "left") return "left";
  return isSilent(participant, nowMs) ? "silent" : "active";
}

/** The kit's phase of each look (glyph and tone derive from the phase only; grey is one of its four). */
export const LOOK_PHASE = {
  active: "active",
  silent: "attention",
  left: "none",
  closedDevice: "done",
  closedOffice: "done",
} as const satisfies Record<ParticipantLook, TagPhase>;

/**
 * Whether a device works the shift now. With participants: an active one (the owner is only
 * «who opened it», and may have left). A host before protocol 7 names none, and the owner of an
 * active shift is the one device that works it, as in stage 2a.
 */
export function deviceWorksShift(
  shift: Pick<OfficeShift, "status" | "ownerDeviceId" | "participants">,
  deviceId: string,
): boolean {
  if (shift.status !== "active") return false;
  if (shift.participants === undefined) return shift.ownerDeviceId === deviceId;
  return shift.participants.some((each) => each.deviceId === deviceId && each.state === "active");
}

/** A device's place in an active shift. */
export interface Presence {
  shiftId: string;
  number: string;
  state: ParticipantState;
}

const STATE_RANK: Record<ParticipantState, number> = { active: 0, left: 1, closed: 2 };

/**
 * The device's part in the active shifts of `shifts`: an active part wins over a paused one over a
 * closed one, the latest entry within a state. `null` when it is in none, and while the list is
 * not read (`undefined`); a shift without participants (an older host) claims nothing.
 */
export function presenceOf(
  shifts: readonly OfficeShift[] | undefined,
  deviceId: string,
): Presence | null {
  let best: { presence: Presence; joinedMs: number } | null = null;
  for (const shift of shifts ?? []) {
    if (shift.status !== "active") continue;
    for (const each of participantsOf(shift)) {
      if (each.deviceId !== deviceId) continue;
      const candidate = {
        presence: { shiftId: shift.id, number: shift.number, state: each.state },
        joinedMs: Date.parse(each.joinedAt),
      };
      if (
        best === null ||
        STATE_RANK[candidate.presence.state] < STATE_RANK[best.presence.state] ||
        (candidate.presence.state === best.presence.state && candidate.joinedMs > best.joinedMs)
      ) {
        best = candidate;
      }
    }
  }
  return best?.presence ?? null;
}
```

- [ ] **Step 5: Run the test and the typecheck.**
      Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shift-participation.test.ts` then `… typecheck`. Expected: PASS.

- [ ] **Step 6: Format and commit.**
      Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false exec prettier --write apps/standalone/src/office/shifts/participation.ts apps/standalone/test/support/shifts.ts apps/standalone/test/shift-participation.test.ts`

```bash
git -C "$WT" add apps/standalone/src/office/shifts/participation.ts apps/standalone/test/support/shifts.ts apps/standalone/test/shift-participation.test.ts
git -C "$WT" commit -m "feat(standalone): participation rules of a shift for the office (plan 2b)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The line's limit — rule, form, list

**Files:**

- Modify: `apps/standalone/src/lib/rules.ts:5` (import), after `:345` (`shiftPalletBoxCapacityRule`)
- Create: `apps/standalone/src/office/lines/line-form.ts`
- Modify: `apps/standalone/src/office/lines/LineDialog.tsx` (whole file, 124 lines)
- Modify: `apps/standalone/src/office/lines/LinesPage.tsx:57-64` (columns)
- Test: `apps/standalone/test/line-form.test.ts` (new), `apps/standalone/test/lines-max-stations.test.tsx` (new)

**Interfaces:**

- Consumes: Task 1 `lineMaxStations`, `lineUpdate(line, { name, archived, maxStations? })`; Task 2 texts; Task 3 `activeParticipants`; `MAX_STATIONS` of `src/host/protocol.ts` (host plan Task 2); `officeKeys.shiftList(null)`.
- Produces: `maxStationsRule` (a `requiredCountRule(MAX_STATIONS, "rules.maxStations")`); `lineFieldsSchema(inUse: number | null)`, `type LineFields = { name: string; maxStations: string }`; `activeStationsOnLine(shifts: readonly OfficeShift[] | undefined, lineId: string): number | null`; `stationsInUse(error: unknown): number | null`; `STATIONS_IN_USE = "office.lines.errors.stationsInUse"`.

- [ ] **Step 1: Write the failing pure test** `apps/standalone/test/line-form.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { z } from "zod";

import { HostError } from "../src/host/client.js";
import { MAX_STATIONS } from "../src/host/protocol.js";
import { maxStationsRule } from "../src/lib/rules.js";
import {
  activeStationsOnLine,
  lineFieldsSchema,
  stationsInUse,
} from "../src/office/lines/line-form.js";
import {
  participant,
  PARTICIPANT_B,
  SHARED,
  ACTIVE,
  CLOSED,
  LINE_2,
  LINE_10,
} from "./support/shifts.js";

const message = (rule: z.ZodType, text: string) => rule.safeParse(text).error?.issues[0]?.message;

describe("the line's limit rule (plan 2b)", () => {
  it("takes a whole number from 1 to 16 and nothing else", () => {
    expect(MAX_STATIONS).toBe(16);
    for (const text of ["1", " 2 ", "16"])
      expect(message(maxStationsRule, text), text).toBeUndefined();
    for (const text of ["", " ", "0", "17", "1e1", "2.0", "-1", "012", "много"]) {
      expect(message(maxStationsRule, text), text).toBe("rules.maxStations");
    }
  });
});

describe("the busiest active shift of a line", () => {
  it("counts the active participants of the line's active shifts, the most of them", () => {
    const quiet = {
      ...SHARED,
      id: "a1",
      participants: [participant({ state: "left" }), PARTICIPANT_B],
    };
    expect(activeStationsOnLine([SHARED], LINE_2.id)).toBe(2);
    expect(activeStationsOnLine([quiet, SHARED], LINE_2.id)).toBe(2);
    expect(activeStationsOnLine([quiet], LINE_2.id)).toBe(1);
  });

  it("is zero for a line with no active shift or with one of an older host, null while unread", () => {
    expect(activeStationsOnLine([SHARED], LINE_10.id)).toBe(0);
    expect(activeStationsOnLine([ACTIVE, CLOSED], LINE_2.id)).toBe(0);
    expect(activeStationsOnLine([{ ...SHARED, status: "closed" }], LINE_2.id)).toBe(0);
    expect(activeStationsOnLine(undefined, LINE_2.id)).toBeNull();
  });
});

describe("the form's schema", () => {
  const values = { name: "Линия 2", maxStations: "2" };

  it("takes any limit while the shifts are unread", () => {
    expect(lineFieldsSchema(null).safeParse({ ...values, maxStations: "1" }).success).toBe(true);
  });

  it("refuses a limit below the devices at work, with the text that counts them", () => {
    const schema = lineFieldsSchema(2);
    expect(schema.safeParse(values).success).toBe(true);
    expect(schema.safeParse({ ...values, maxStations: "3" }).success).toBe(true);
    const refused = schema.safeParse({ ...values, maxStations: "1" });
    expect(refused.error?.issues[0]?.message).toBe("office.lines.errors.stationsInUse");
    // A malformed number is the rule's message, not the count's.
    expect(schema.safeParse({ ...values, maxStations: "x" }).error?.issues[0]?.message).toBe(
      "rules.maxStations",
    );
  });
});

describe("the host's refusal of a lower limit", () => {
  it("carries the number of devices at work", () => {
    const refusal = new HostError({
      kind: "api",
      code: "conflict",
      status: 409,
      message: "more devices work a shift of this line than the new limit",
      details: { constraint: "line_stations_in_use", active: 3 },
    });
    expect(stationsInUse(refusal)).toBe(3);
  });

  it("is nothing for any other failure", () => {
    const other = new HostError({
      kind: "api",
      code: "conflict",
      status: 409,
      message: "x",
      details: { constraint: "line_name" },
    });
    expect(stationsInUse(other)).toBeNull();
    expect(stationsInUse(new Error("x"))).toBeNull();
  });
});
```

(`LINE_2`, `LINE_10`, `ACTIVE`, `CLOSED`, `SHARED`, `PARTICIPANT_B`, `participant` are exports of `test/support/shifts.ts` after Task 3; `ACTIVE.lineId` is `LINE_2.id`.)

- [ ] **Step 2: Run it to verify it fails.**
      Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/line-form.test.ts`
      Expected: FAIL (`maxStationsRule`, `line-form.js` do not exist).

- [ ] **Step 3: Add the rule.** `apps/standalone/src/lib/rules.ts:5`: change `import type { OrgProfileInput } from "../host/protocol.js";` to

```ts
import { MAX_STATIONS, type OrgProfileInput } from "../host/protocol.js";
```

After `shiftPalletBoxCapacityRule` (`:345`) add:

```ts
/** A line's limit of devices in one shift (plan 2b): 1 to `MAX_STATIONS`, always sent. */
export const maxStationsRule = requiredCountRule(MAX_STATIONS, "rules.maxStations");
```

- [ ] **Step 4: Write `apps/standalone/src/office/lines/line-form.ts`:**

```ts
import { z } from "zod";

import { HostError } from "../../host/client.js";
import type { OfficeShift } from "../../host/protocol.js";
import { lineNameRule, maxStationsRule } from "../../lib/rules.js";
import { activeParticipants } from "../shifts/participation.js";

/** The text under the limit when it is lower than the devices at work (`{{count}}` says how many). */
export const STATIONS_IN_USE = "office.lines.errors.stationsInUse";

/**
 * The line form's fields: the name and the limit of devices in one shift, as typed. `inUse` is
 * how many devices the busiest active shift of the line has at work, once the shifts are read
 * (`activeStationsOnLine`); the limit cannot go below it, which the host refuses too
 * (`line_stations_in_use`).
 */
export function lineFieldsSchema(inUse: number | null) {
  return z.object({
    name: lineNameRule,
    maxStations: maxStationsRule.refine(
      (text) => inUse === null || Number(text) >= inUse,
      STATIONS_IN_USE,
    ),
  });
}
export type LineFields = z.input<ReturnType<typeof lineFieldsSchema>>;

/**
 * The most active participants of any active shift of the line (the host counts the same: «the
 * busiest active shift's live slots»); `0` for a line nobody works, `null` while the shifts are not
 * read, so the form claims nothing.
 */
export function activeStationsOnLine(
  shifts: readonly OfficeShift[] | undefined,
  lineId: string,
): number | null {
  if (shifts === undefined) return null;
  let busiest = 0;
  for (const shift of shifts) {
    if (shift.lineId !== lineId || shift.status !== "active") continue;
    busiest = Math.max(busiest, activeParticipants(shift).length);
  }
  return busiest;
}

/** How many devices work a shift of the line, when the host refused a lower limit; `null` for any other failure. */
export function stationsInUse(error: unknown): number | null {
  if (
    error instanceof HostError &&
    error.code === "conflict" &&
    error.details.constraint === "line_stations_in_use"
  ) {
    const active = error.details.active;
    return typeof active === "number" ? active : null;
  }
  return null;
}
```

- [ ] **Step 5: Run the pure test to verify it passes.**
      Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/line-form.test.ts`
      Expected: PASS.

- [ ] **Step 6: Write the failing component test** `apps/standalone/test/lines-max-stations.test.tsx`:

```tsx
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { HostError } from "../src/host/client.js";
import type { OfficeLine } from "../src/host/protocol.js";
import {
  fakeOfficeSession,
  renderOffice,
  TECHNOLOGIST,
  type FakeOfficeSession,
} from "./support/office.js";
import { pressRowAction } from "./support/row-menu.js";
import { LINE_10, LINE_2, SHARED } from "./support/shifts.js";

const TOKEN = "office-session-token";
const THREE: OfficeLine = { ...LINE_2, maxStations: 3 };
const LABEL = "Максимум станций в смене";
const IN_USE = "Сейчас в смене работают 2 устройства: меньше поставить нельзя.";
const BELOW = "В смене этой линии работают 2 устройства: максимум не может быть меньше.";

function session(): FakeOfficeSession {
  const fake = fakeOfficeSession();
  // Line 2 allows three devices and two work its shift; line 10 is a line of an older host.
  fake.api.listLines.mockResolvedValue([LINE_10, THREE]);
  fake.api.listShifts.mockResolvedValue([SHARED]);
  return fake;
}

async function openLines(fake: FakeOfficeSession): Promise<void> {
  renderOffice(fake, { initialPath: "/lines" });
  await screen.findByRole("link", { name: "Линии" });
  await screen.findByText("Линия 10");
}

async function openRename(fake: FakeOfficeSession): Promise<HTMLElement> {
  await openLines(fake);
  pressRowAction(screen, "Переименовать линию «Линия 2»");
  return screen.findByRole("dialog");
}

function typeLimit(value: string): void {
  fireEvent.change(screen.getByLabelText(LABEL), { target: { value } });
}

describe("the line's limit in the office (plan 2b)", () => {
  it("lists it in its own column, and one for a line of an older host", async () => {
    await openLines(session());
    expect(
      within(screen.getByRole("table"))
        .getAllByRole("columnheader")
        .map((head) => head.textContent),
    ).toEqual(["Название", "Макс. станций", "Состояние", "Действия"]);
    const rows = within(screen.getByRole("table")).getAllByRole("row").slice(1);
    expect(
      rows.map((row) =>
        within(row)
          .getAllByRole("cell")
          .slice(0, 2)
          .map((cell) => cell.textContent),
      ),
    ).toEqual([
      ["Линия 2", "3"],
      ["Линия 10", "1"],
    ]);
  });

  it("changes only the limit and sends it with the loaded revision", async () => {
    const fake = session();
    fake.api.updateLine.mockResolvedValue({ ...THREE, maxStations: 4, rev: 41 });
    const dialog = await openRename(fake);
    expect((within(dialog).getByLabelText(LABEL) as HTMLInputElement).value).toBe("3");
    typeLimit("4");
    fireEvent.click(within(dialog).getByRole("button", { name: "Сохранить" }));
    await waitFor(() =>
      expect(fake.api.updateLine).toHaveBeenCalledWith(TOKEN, THREE.id, {
        maxStations: 4,
        expectedRev: 40,
      }),
    );
    expect(await screen.findByText("Изменения сохранены.")).toBeTruthy();
  });

  it("says how many devices work the line and refuses a limit below them before asking the host", async () => {
    const fake = session();
    const dialog = await openRename(fake);
    expect(await within(dialog).findByText(IN_USE)).toBeTruthy();
    typeLimit("1");
    fireEvent.click(within(dialog).getByRole("button", { name: "Сохранить" }));
    expect(await within(dialog).findByText(BELOW)).toBeTruthy();
    expect(fake.api.updateLine).not.toHaveBeenCalled();
    // Two is exactly the devices at work: allowed.
    typeLimit("2");
    fake.api.updateLine.mockResolvedValue({ ...THREE, maxStations: 2, rev: 41 });
    fireEvent.click(within(dialog).getByRole("button", { name: "Сохранить" }));
    await waitFor(() =>
      expect(fake.api.updateLine).toHaveBeenCalledWith(TOKEN, THREE.id, {
        maxStations: 2,
        expectedRev: 40,
      }),
    );
  });

  it("puts the host's refusal under the field with the host's count", async () => {
    const fake = session();
    // The shifts did not load, so the form could not know; the host did.
    fake.api.listShifts.mockRejectedValue(new Error("down"));
    fake.api.updateLine.mockRejectedValue(
      new HostError({
        kind: "api",
        code: "conflict",
        status: 409,
        message: "more devices work a shift of this line than the new limit",
        details: { constraint: "line_stations_in_use", active: 3 },
      }),
    );
    const dialog = await openRename(fake);
    typeLimit("2");
    fireEvent.click(within(dialog).getByRole("button", { name: "Сохранить" }));
    expect(
      await within(dialog).findByText(
        "В смене этой линии работают 3 устройства: максимум не может быть меньше.",
      ),
    ).toBeTruthy();
    expect(within(dialog).getByLabelText(LABEL).getAttribute("aria-invalid")).toBe("true");
  });

  it("refuses a limit that is not a whole number from 1 to 16", async () => {
    const fake = session();
    const dialog = await openRename(fake);
    for (const value of ["0", "17", "1.5", ""]) {
      typeLimit(value);
      fireEvent.click(within(dialog).getByRole("button", { name: "Сохранить" }));
      expect(await within(dialog).findByText("Укажите целое число от 1 до 16"), value).toBeTruthy();
    }
    expect(fake.api.updateLine).not.toHaveBeenCalled();
  });

  it("offers no limit when a line is added", async () => {
    await openLines(session());
    fireEvent.click(screen.getByRole("button", { name: "Добавить линию" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByLabelText(LABEL)).toBeNull();
  });

  it("shows a technologist the limit and no way to change it", async () => {
    const readOnly = fakeOfficeSession({ user: TECHNOLOGIST });
    readOnly.api.listLines.mockResolvedValue([THREE]);
    renderOffice(readOnly, { initialPath: "/lines" });
    await screen.findByText("Линия 2");
    const row = screen.getByText("Линия 2").closest("tr");
    expect(within(row as HTMLElement).getAllByRole("cell")[1]?.textContent).toBe("3");
    expect(screen.queryByRole("button", { name: /Переименовать/ })).toBeNull();
  });
});
```

- [ ] **Step 7: Run it to verify it fails.**
      Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/lines-max-stations.test.tsx`
      Expected: FAIL (no «Макс. станций» column, no field «Максимум станций в смене»).

- [ ] **Step 8: Rewrite `apps/standalone/src/office/lines/LineDialog.tsx`:**

```tsx
import { zodResolver } from "@hookform/resolvers/zod";
import { useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";

import { Input } from "@markiro/ui";

import type { OfficeLine } from "../../host/protocol.js";
import { lineCreate, lineMaxStations, lineUpdate } from "../../host/requests.js";
import { useFieldError, writeFailure, type AlertFailure } from "../form-errors.js";
import { FormDialog } from "../FormDialog.js";
import { officeKeys, useOfficeMutation, useOfficeQuery } from "../office-query.js";
import { WriteFailureAlert } from "../page-state.js";
import {
  activeStationsOnLine,
  lineFieldsSchema,
  STATIONS_IN_USE,
  stationsInUse,
  type LineFields,
} from "./line-form.js";

const LINE_FIELDS = { name: "name", maxStations: "maxStations" } as const;
/**
 * An active line already has the name, compared without case (`lines_active_name_key`); or more
 * devices work a shift of the line than the new limit (`line_stations_in_use`, plan 2b).
 */
const LINE_CONFLICTS = {
  line_name: { field: "name", message: "office.lines.errors.nameTaken" },
  line_stations_in_use: { field: "maxStations", message: STATIONS_IN_USE },
} as const;

/** What the dialog does: add a line, change an active one, or bring one back from the archive. */
export type LineDialogMode =
  { kind: "create" } | { kind: "rename"; line: OfficeLine } | { kind: "restore"; line: OfficeLine };

export interface LineDialogProps {
  mode: LineDialogMode;
  onClose: () => void;
  onSaved: (line: OfficeLine) => void;
  /** The line changed on the host: close and load the lines again. */
  onReload: () => void;
}

/**
 * A line's name and, for an active line, its limit of devices in one shift (plan 2b). A name an
 * active line already has (without case) comes back as `conflict` on `line_name` on every path
 * here — adding, changing and bringing a line back — and goes under the name, so bringing a line
 * back can give it a new name in the same dialog. The limit is not offered when a line is added
 * (it starts at one) or brought back; changing it below the devices at work is refused here as
 * soon as the shifts are read, and by the host (`line_stations_in_use`) whatever the page knew.
 */
export function LineDialog({ mode, onClose, onSaved, onReload }: LineDialogProps) {
  const { t } = useTranslation();
  const fieldError = useFieldError();
  const [failure, setFailure] = useState<AlertFailure | null>(null);
  // How many devices work the line, as the host last said when it refused a lower limit.
  const [hostInUse, setHostInUse] = useState<number | null>(null);
  const editsLimit = mode.kind === "rename";
  const shifts = useOfficeQuery(officeKeys.shiftList(null), (api, token) => api.listShifts(token), {
    enabled: editsLimit,
  });
  const inUse = mode.kind === "rename" ? activeStationsOnLine(shifts.data, mode.line.id) : null;
  const schema = useMemo(() => lineFieldsSchema(inUse), [inUse]);
  const save = useOfficeMutation((api, token, values: LineFields) => {
    switch (mode.kind) {
      case "create":
        return api.createLine(token, lineCreate(values.name));
      case "rename":
        return api.updateLine(
          token,
          mode.line.id,
          lineUpdate(mode.line, {
            name: values.name,
            archived: mode.line.archived,
            maxStations: Number(values.maxStations),
          }),
        );
      case "restore":
        return api.updateLine(
          token,
          mode.line.id,
          lineUpdate(mode.line, { name: values.name, archived: false }),
        );
    }
  });
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isDirty },
  } = useForm<LineFields>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: mode.kind === "create" ? "" : mode.line.name,
      maxStations: mode.kind === "create" ? "1" : String(lineMaxStations(mode.line)),
    },
  });

  const submit = handleSubmit(async (values) => {
    setFailure(null);
    setHostInUse(null);
    let saved: OfficeLine;
    try {
      saved = await save.mutateAsync(values);
    } catch (error) {
      setHostInUse(stationsInUse(error));
      const outcome = writeFailure(error, LINE_FIELDS, LINE_CONFLICTS);
      if (outcome.kind === "field") {
        setError(outcome.field, { type: "server", message: outcome.message });
      } else {
        setFailure(outcome);
      }
      return;
    }
    onSaved(saved);
  });

  const title =
    mode.kind === "create"
      ? t("office.lines.createTitle")
      : mode.kind === "rename"
        ? t("office.lines.renameTitle", { name: mode.line.name })
        : t("office.lines.restoreTitle", { name: mode.line.name });
  const submitLabel =
    mode.kind === "create"
      ? t("office.lines.create")
      : mode.kind === "rename"
        ? t("office.common.save")
        : t("office.lines.restoreSubmit");
  const limitMessage = errors.maxStations?.message;

  return (
    <FormDialog
      errorCount={Object.keys(errors).length}
      title={title}
      submitLabel={submitLabel}
      submitDisabled={mode.kind === "rename" && !isDirty}
      onSubmit={submit}
      onClose={onClose}
      alert={<WriteFailureAlert failure={failure} onReload={onReload} />}
    >
      {mode.kind === "restore" && <p>{t("office.lines.restoreIntro")}</p>}
      <Input
        label={t("office.lines.fields.name")}
        {...fieldError(errors.name?.message)}
        {...register("name")}
      />
      {editsLimit && (
        <Input
          label={t("office.lines.fields.maxStations")}
          hint={
            inUse !== null && inUse > 0
              ? t("office.lines.fields.maxStationsInUse", { count: inUse })
              : t("office.lines.fields.maxStationsHint")
          }
          inputMode="numeric"
          mono
          {...fieldError(
            limitMessage,
            limitMessage === STATIONS_IN_USE ? { count: hostInUse ?? inUse ?? 1 } : undefined,
          )}
          {...register("maxStations")}
        />
      )}
    </FormDialog>
  );
}
```

- [ ] **Step 9: Add the column.** `apps/standalone/src/office/lines/LinesPage.tsx`: add `lineMaxStations` to a new import `import { lineMaxStations } from "../../host/requests.js";` (after the `protocol.js` import at `:12`), and between the `name` and `status` columns (`:58-59`):

```tsx
    {
      key: "maxStations",
      title: t("office.lines.table.maxStations"),
      mono: true,
      align: "right",
      render: (line) => lineMaxStations(line),
    },
```

- [ ] **Step 10: Run the component test, the old line tests and the typecheck.**
      Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/lines-max-stations.test.tsx test/lines-page.test.tsx test/line-form.test.ts` then `… typecheck` and `… lint`.
      Expected: PASS. `lines-page.test.tsx` is unchanged and must still pass: its rename tests send no limit (`Number("1")` equals the line's limit of one), and `listShifts` is unstubbed there, so the dialog's read fails quietly.

- [ ] **Step 11: Format and commit.**
      Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false exec prettier --write apps/standalone/src/lib/rules.ts apps/standalone/src/office/lines/line-form.ts apps/standalone/src/office/lines/LineDialog.tsx apps/standalone/src/office/lines/LinesPage.tsx apps/standalone/test/line-form.test.ts apps/standalone/test/lines-max-stations.test.tsx`

```bash
git -C "$WT" add apps/standalone/src/lib/rules.ts apps/standalone/src/office/lines/line-form.ts \
  apps/standalone/src/office/lines/LineDialog.tsx apps/standalone/src/office/lines/LinesPage.tsx \
  apps/standalone/test/line-form.test.ts apps/standalone/test/lines-max-stations.test.tsx
git -C "$WT" commit -m "feat(standalone): the line's limit of devices in one shift in the office (plan 2b)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The card's «Станции» tab, and the marks in the list and the card

**Files:**

- Create: `apps/standalone/src/office/shifts/ShiftMarks.tsx`, `apps/standalone/src/office/shifts/ShiftStations.tsx`
- Modify: `apps/standalone/src/office/shifts/ShiftDrawer.tsx:41-58` (imports), `:89-116` (`DRAWER_TABS`, `drawerTabs`), `:400-411` (tab panel), `:673-705` (`ShiftStatusLine`)
- Modify: `apps/standalone/src/office/shifts/ShiftsPage.tsx:49-57` (imports), `:390-392` (status cell)
- Test: `apps/standalone/test/shift-participants.test.tsx` (new)

**Interfaces:**

- Consumes: Task 3 (`participantsOf`, `participantLook`, `LOOK_PHASE`, `closedParticipants`, `SHARED`, `SHARED_NO_REASON`, `participant`), Task 2 texts; `officeKeys`; `PagedTable`; `StatusChip`; `isShiftCloseReasonCode`.
- Produces: `<ShiftMarks shift />` (a fragment of cell parts: the participants line for a shared shift, the «Причина не указана» chip); `<ShiftStations shift at />` (the tab's section, region «Станции смены»); `DrawerTab` gains `"stations"`; `drawerTabs(shift)` includes it only when `participants` is non-empty.

- [ ] **Step 1: Write the failing test** `apps/standalone/test/shift-participants.test.tsx`:

```tsx
import { fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { drawerTabs } from "../src/office/shifts/ShiftDrawer.js";
import {
  ACTIVE,
  openShifts,
  PLANNED,
  shiftRow,
  shiftsSession,
  SHARED,
  SHARED_NO_REASON,
  participant,
  HANDHELD_ID,
  PARTICIPANT_B,
} from "./support/shifts.js";
import type { FakeOfficeSession } from "./support/office.js";

const UNITS = new Intl.NumberFormat("ru");
/** Four minutes after the station last spoke (09:41); the handheld spoke at the same time. */
const NOW = new Date("2026-10-08T09:45:00Z");

async function openCard(session: FakeOfficeSession, number: string, tab?: string): Promise<void> {
  await openShifts(session);
  fireEvent.click(screen.getByRole("link", { name: `Карточка смены ${number}` }));
  await screen.findByRole("heading", { name: `Смена ${number}` });
  if (tab !== undefined) fireEvent.click(screen.getByRole("tab", { name: tab }));
}

function stationsRows(): string[][] {
  const region = screen.getByRole("region", { name: "Станции смены" });
  return within(region)
    .getAllByRole("row")
    .slice(1)
    .map((row) =>
      within(row)
        .getAllByRole("cell")
        .map((cell) => cell.textContent ?? ""),
    );
}

describe("the card's tab of a shift's participants (plan 2b)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is a tab only for a shift that names participants", () => {
    expect(drawerTabs(SHARED).slice(0, 2)).toEqual(["summary", "stations"]);
    expect(drawerTabs(SHARED_NO_REASON)).toContain("stations");
    expect(drawerTabs(ACTIVE)).not.toContain("stations");
    expect(drawerTabs({ ...ACTIVE, participants: [] })).not.toContain("stations");
    expect(drawerTabs(PLANNED)).toEqual(["summary"]);
  });

  it("lists each device with its entry, state and its part of the totals", async () => {
    await openCard(shiftsSession([SHARED]), "OCT26-004", "Станции");
    expect(stationsRows()).toEqual([
      ["Станция линии 1Станция", "08.10.2026, 09:02", "▸Работает", "427", "35"],
      ["ТСД 1ТСД", "08.10.2026, 10:10", "▸Работает", "120", "10"],
    ]);
    expect(
      screen.getByText(
        `Принято в смене: 547 · План: ${UNITS.format(1200)} · Часть закрыли: 0 из 2`,
      ),
    ).toBeTruthy();
  });

  it("names the columns the spec lists: device and kind, entry, state, accepted, boxes (pallets only when the shift has them)", async () => {
    await openCard(shiftsSession([SHARED]), "OCT26-004", "Станции");
    const region = screen.getByRole("region", { name: "Станции смены" });
    expect(
      within(region)
        .getAllByRole("columnheader")
        .map((head) => head.textContent),
    ).toEqual(["Устройство", "Вход", "Состояние", "Принято", "Коробов"]);
  });

  it("adds the pallets column for a shift with pallets", async () => {
    const withPallets = { ...SHARED, palletsEnabled: true, palletBoxCapacity: 40 };
    const session = shiftsSession([withPallets]);
    session.api.listShiftPallets.mockResolvedValue([]);
    await openCard(session, "OCT26-004", "Станции");
    const region = screen.getByRole("region", { name: "Станции смены" });
    expect(within(region).getAllByRole("columnheader").at(-1)?.textContent).toBe("Паллет");
  });

  it("marks a participant the host has not heard for more than ten minutes, with the time it last did", async () => {
    vi.setSystemTime(new Date("2026-10-08T10:00:00Z"));
    await openCard(shiftsSession([SHARED]), "OCT26-004", "Станции");
    expect(stationsRows().map((row) => row[2])).toEqual([
      "!Нет связиСлышали: 08.10.2026, 12:41",
      "!Нет связиСлышали: 08.10.2026, 12:41",
    ]);
  });

  it("says a paused device is paused, and shows no silence for it", async () => {
    vi.setSystemTime(new Date("2026-10-08T10:00:00Z"));
    const paused = {
      ...SHARED,
      participants: [
        participant({
          deviceId: HANDHELD_ID,
          state: "left",
          deviceKind: "handheld",
          deviceName: "ТСД 1",
        }),
      ],
    };
    await openCard(shiftsSession([paused]), "OCT26-004", "Станции");
    expect(stationsRows()[0]?.[2]).toBe("·На паузе");
  });

  it("says who closed each part, when, with how many units, and any data that came after", async () => {
    const closed = {
      ...SHARED_NO_REASON,
      participants: [
        participant({
          state: "closed",
          closedBy: "device",
          closedAt: "2026-10-08T14:10:00Z",
          closedActualQty: 427,
          closedReasonCode: "equipment_stop",
          lateDataAt: "2026-10-08T14:20:00Z",
        }),
        {
          ...PARTICIPANT_B,
          state: "closed" as const,
          closedBy: "office_user" as const,
          closedAt: "2026-10-08T14:10:00Z",
        },
      ],
    };
    await openCard(shiftsSession([closed]), "OCT26-004", "Станции");
    expect(stationsRows().map((row) => row[2])).toEqual([
      "✓Часть закрытаЗакрыто 08.10.2026, 17:10Принято при закрытии: 427Причина расхождения: Остановка оборудования!Данные после закрытия",
      "✓Закрыто из офисаЗакрыто 08.10.2026, 17:10",
    ]);
  });
});

describe("the participants in the list of shifts (plan 2b)", () => {
  it("adds one quiet line to a shared shift's status: how many devices, how many closed their part", async () => {
    const other = {
      ...SHARED_NO_REASON,
      id: "7e1f0a2b-3c4d-4e5f-8a6b-7c8d9e0f1a2b",
      number: "OCT26-007",
    };
    await openShifts(shiftsSession([SHARED, other]));
    expect(
      within(shiftRow("OCT26-004")).getAllByText("Устройств: 2, закрыли часть: 0"),
    ).toHaveLength(1);
    expect(within(shiftRow("OCT26-007")).getByText("Устройств: 2, закрыли часть: 2")).toBeTruthy();
  });

  it("marks a shift closed without its reason, in a word as well as a glyph", async () => {
    const other = {
      ...SHARED_NO_REASON,
      id: "7e1f0a2b-3c4d-4e5f-8a6b-7c8d9e0f1a2b",
      number: "OCT26-007",
    };
    await openShifts(shiftsSession([SHARED, other]));
    expect(within(shiftRow("OCT26-007")).getByText("Причина не указана")).toBeTruthy();
    expect(within(shiftRow("OCT26-004")).queryByText("Причина не указана")).toBeNull();
  });

  it("shows a shift of a host before protocol 7 as it was", async () => {
    await openShifts(shiftsSession([ACTIVE]));
    expect(within(shiftRow("OCT26-004")).queryByText(/^Устройств:/)).toBeNull();
    expect(within(shiftRow("OCT26-004")).queryByText("Причина не указана")).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails.**
      Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shift-participants.test.tsx`
      Expected: FAIL (`drawerTabs(SHARED)` has no `"stations"`; no tab «Станции»; no marks).

- [ ] **Step 3: Write `ShiftMarks.tsx`:**

```tsx
import { useTranslation } from "react-i18next";

import { StatusChip } from "@markiro/ui";

import type { OfficeShift } from "../../host/protocol.js";
import { closedParticipants, participantsOf } from "./participation.js";

/**
 * What a shift's status cell and the card's status line add for several devices (plan 2b): one
 * quiet line for a shared shift (how many devices, how many closed their part), and the attention
 * tag of a shift its devices closed without the reason the plan's gap needed. Nothing for a shift
 * of one device or of a host before protocol 7.
 */
export function ShiftMarks({ shift }: { shift: OfficeShift }) {
  const { t } = useTranslation();
  const total = participantsOf(shift).length;
  return (
    <>
      {total > 1 && (
        <span className="shift-cell__quiet">
          {t("office.shifts.stationsLine", { total, closed: closedParticipants(shift).length })}
        </span>
      )}
      {shift.closeReasonMissing === true && (
        <StatusChip phase="attention" wrap label={t("office.shifts.reasonMissing")} />
      )}
    </>
  );
}
```

- [ ] **Step 4: Write `ShiftStations.tsx`:**

```tsx
import { isShiftCloseReasonCode } from "@markiro/domain";
import { useId } from "react";
import { useTranslation } from "react-i18next";

import { Card, StatusChip, type TableColumn } from "@markiro/ui";

import type { OfficeShift, ShiftParticipant } from "../../host/protocol.js";
import { PagedTable } from "../paging/PagedTable.js";
import {
  closedParticipants,
  LOOK_PHASE,
  participantLook,
  participantsOf,
} from "./participation.js";

/** Counts with the thousands apart by a no-break space, as Russian writes them: «1 200». */
const UNITS = new Intl.NumberFormat("ru");

export interface ShiftStationsProps {
  shift: OfficeShift;
  /** An instant in the organization's zone, or «—» (the card's own). */
  at: (instant: string | null) => string;
}

/**
 * «Станции смены» (plan 2b, spec §7): the devices that entered the shift, each with its kind, its
 * entry, its state and its part of the totals; above them the shift-wide figures against the plan
 * and how many parts are closed. A participant the host has not heard for more than ten minutes is
 * marked, in a word and a glyph. Read from the shift the card already holds: no request of its own.
 */
export function ShiftStations({ shift, at }: ShiftStationsProps) {
  const { t } = useTranslation();
  const titleId = useId();
  // One reading of the clock for the whole table, as «Устройства» takes it.
  const nowMs = Date.now();
  const participants = participantsOf(shift);
  const parts = new Map((shift.byDevice ?? []).map((part) => [part.deviceId, part]));
  const figure = (value: number | undefined) =>
    value === undefined ? t("office.common.none") : UNITS.format(value);
  const validation = shift.mode === "validation";

  const columns: TableColumn<ShiftParticipant>[] = [
    {
      key: "device",
      title: t("office.shiftCard.participants.device"),
      wrap: true,
      minWidth: 150,
      render: (each) => (
        <span className="shift-cell">
          <span className="shift-cell__name">{each.deviceName}</span>
          <span className="shift-cell__quiet">{t(`office.devices.kinds.${each.deviceKind}`)}</span>
        </span>
      ),
    },
    {
      key: "joined",
      title: t("office.shiftCard.participants.joined"),
      wrap: true,
      minWidth: 130,
      render: (each) => at(each.joinedAt),
    },
    {
      key: "state",
      title: t("office.shiftCard.participants.state"),
      wrap: true,
      minWidth: 190,
      render: (each) => <ParticipantState participant={each} nowMs={nowMs} at={at} />,
    },
    {
      key: "accepted",
      title: t("office.shiftCard.participants.accepted"),
      mono: true,
      align: "right",
      render: (each) => figure(parts.get(each.deviceId)?.accepted),
    },
    // A validation shift puts its codes in no box and on no pallet (plan РЕЖ, Р11).
    ...(validation
      ? []
      : [
          {
            key: "boxes",
            title: t("office.shiftCard.participants.boxes"),
            mono: true,
            align: "right" as const,
            render: (each: ShiftParticipant) => figure(parts.get(each.deviceId)?.boxesClosed),
          },
        ]),
    ...(validation || !shift.palletsEnabled
      ? []
      : [
          {
            key: "pallets",
            title: t("office.shiftCard.participants.pallets"),
            mono: true,
            align: "right" as const,
            render: (each: ShiftParticipant) => figure(parts.get(each.deviceId)?.pallets),
          },
        ]),
  ];

  return (
    <section className="shift-card__section" aria-labelledby={titleId}>
      <h2 id={titleId}>{t("office.shiftCard.participants.title")}</h2>
      <Card>
        <p className="office-note" aria-live="polite">
          {t("office.shiftCard.participants.summary", {
            accepted: UNITS.format(shift.totals.acceptedUnits),
            plan:
              shift.plannedQty === null ? t("office.common.none") : UNITS.format(shift.plannedQty),
            closed: closedParticipants(shift).length,
            total: participants.length,
          })}
        </p>
        <PagedTable
          tableId="shift-participants"
          pagerLabel={t("office.shiftCard.participants.pager")}
          columns={columns}
          rows={[...participants]}
          getRowKey={(each) => each.deviceId}
          empty={t("office.common.none")}
          scrollLabel={t("office.shiftCard.participants.table")}
        />
      </Card>
    </section>
  );
}

/** A participant's state: the phase tag with its word, and under it what the host knows of the close. */
function ParticipantState({
  participant,
  nowMs,
  at,
}: {
  participant: ShiftParticipant;
  nowMs: number;
  at: (instant: string | null) => string;
}) {
  const { t } = useTranslation();
  const look = participantLook(participant, nowMs);
  const reason = participant.closedReasonCode;
  return (
    <span className="shift-cell">
      <StatusChip
        phase={LOOK_PHASE[look]}
        label={t(`office.shiftCard.participants.states.${look}`)}
      />
      {participant.closedAt !== null && (
        <span className="shift-cell__quiet">
          {t("office.shiftCard.participants.closedAt", { at: at(participant.closedAt) })}
        </span>
      )}
      {participant.closedActualQty !== null && (
        <span className="shift-cell__quiet">
          {t("office.shiftCard.participants.closedQty", {
            units: UNITS.format(participant.closedActualQty),
          })}
        </span>
      )}
      {reason !== null && (
        <span className="shift-cell__quiet">
          {t("office.shifts.closeReason", {
            // A code a newer host adds is shown as it is.
            reason: isShiftCloseReasonCode(reason)
              ? t(`office.shifts.closeReasons.${reason}`)
              : reason,
          })}
        </span>
      )}
      {look === "silent" && participant.lastSeenAt !== null && (
        <span className="shift-cell__quiet">
          {t("office.shiftCard.participants.lastSeen", { at: at(participant.lastSeenAt) })}
        </span>
      )}
      {participant.lateDataAt !== null && (
        <StatusChip phase="attention" label={t("office.shifts.lateData")} />
      )}
    </span>
  );
}
```

- [ ] **Step 5: Wire the drawer.** In `ShiftDrawer.tsx`:

(a) imports (after `import { PalletCountTag } …`, `:58`):

```tsx
import { ShiftMarks } from "./ShiftMarks.js";
import { ShiftStations } from "./ShiftStations.js";
```

(b) `DRAWER_TABS` (`:89-98`): insert `"stations",` after `"summary",`. In `drawerTabs` (`:109-115`) add before `return true;`:

```ts
// The devices of a shared shift (plan 2b); a host before protocol 7 names none.
if (tab === "stations") return (shift.participants?.length ?? 0) > 0;
```

(c) the tab panel (`:401-411`): after the `{active === "summary" && (…)}` block add

```tsx
{
  active === "stations" && <ShiftStations key={`stations-${current.id}`} shift={current} at={at} />;
}
```

(d) `ShiftStatusLine` (`:673-705`): after the `closeReasonCode` block, before the closing `</div>`, add `<ShiftMarks shift={shift} />`.

- [ ] **Step 6: Wire the list.** In `ShiftsPage.tsx` add `import { ShiftMarks } from "./ShiftMarks.js";` after `import { shiftOutput } …` (`:57`), and in the status cell after the `lateData` chip (`:390-392`):

```tsx
<ShiftMarks shift={shift} />
```

- [ ] **Step 7: Run the new test and the neighbours.**
      Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shift-participants.test.tsx test/shift-card.test.tsx test/shifts-page.test.tsx test/shift-list.test.ts`
      Expected: PASS. If a cell's `textContent` differs from the strings above by a no-break space or a glyph, fix the expected string in the test to what the page renders, after confirming it is the same words; never loosen an assertion to `toContain` to hide a difference.

- [ ] **Step 8: Typecheck, lint, format, commit.**
      Run: `… typecheck`, `… lint`, `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false exec prettier --write apps/standalone/src/office/shifts/ShiftMarks.tsx apps/standalone/src/office/shifts/ShiftStations.tsx apps/standalone/src/office/shifts/ShiftDrawer.tsx apps/standalone/src/office/shifts/ShiftsPage.tsx apps/standalone/test/shift-participants.test.tsx`

```bash
git -C "$WT" add apps/standalone/src/office/shifts/ShiftMarks.tsx apps/standalone/src/office/shifts/ShiftStations.tsx \
  apps/standalone/src/office/shifts/ShiftDrawer.tsx apps/standalone/src/office/shifts/ShiftsPage.tsx \
  apps/standalone/test/shift-participants.test.tsx
git -C "$WT" commit -m "feat(standalone): a shift's participants in its card and in the list (plan 2b)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Totals with a breakdown by device

**Files:**

- Modify: `apps/standalone/src/office/shifts/ShiftTotalsDialog.tsx:1-8` (imports), after `:102` (`deviceLabel`), `:193-199` (after the notes)
- Test: `apps/standalone/test/shift-totals-by-device.test.tsx` (new)

**Interfaces:**

- Consumes: `OfficeShift.byDevice`, `OfficeShift.participants` (names); Task 2 texts `office.shifts.totals.byDevice*`; `DeviceTotals` type.
- Produces: a section «По устройствам» inside `ShiftTotalsBody` (so the dialog «Итоги» and the card's «Итоги» block both show it) for a shift whose `byDevice` has more than one device; CSS class `shift-breakdown__title` (defined in Task 13).

- [ ] **Step 1: Write the failing test** `apps/standalone/test/shift-totals-by-device.test.tsx`:

```tsx
import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { TECHNOLOGIST } from "./support/office.js";
import { ACTIVE, openShifts, shiftsSession, SHARED, STATION_ID } from "./support/shifts.js";

async function openTotals(session: ReturnType<typeof shiftsSession>): Promise<HTMLElement> {
  await openShifts(session);
  fireEvent.click(screen.getByRole("button", { name: "Итоги смены OCT26-004" }));
  return screen.findByRole("dialog", { name: "Итоги смены OCT26-004" });
}

/** The «По устройствам» block as device → figures. */
function breakdown(dialog: HTMLElement): Record<string, string | null> {
  const section = within(dialog).getByRole("region", { name: "По устройствам" });
  return Object.fromEntries(
    within(section)
      .getAllByRole("term")
      .map((term) => [term.textContent ?? "", term.nextElementSibling?.textContent ?? null]),
  );
}

describe("a shift's totals with each device's part (plan 2b)", () => {
  it("lists each device with the codes it accepted, its closed boxes and pallets, in the order of the participants", async () => {
    const dialog = await openTotals(shiftsSession([SHARED]));
    expect(breakdown(dialog)).toEqual({
      "Станция линии 1": "427 шт · 35 кор. · 0 пал.",
      "ТСД 1": "120 шт · 10 кор. · 0 пал.",
    });
    // The shift-wide figures stay the shift's.
    expect(within(dialog).getByText("Принято кодов").nextElementSibling?.textContent).toBe("547");
  });

  it("names the devices from the participants, so a technologist sees names too", async () => {
    const dialog = await openTotals(shiftsSession([SHARED], TECHNOLOGIST));
    expect(Object.keys(breakdown(dialog))).toEqual(["Станция линии 1", "ТСД 1"]);
  });

  it("gives a validation shift only the codes", async () => {
    const validation = { ...SHARED, mode: "validation" as const };
    const dialog = await openTotals(shiftsSession([validation]));
    expect(breakdown(dialog)).toEqual({ "Станция линии 1": "427 шт", "ТСД 1": "120 шт" });
  });

  it("adds nothing for a shift of one device", async () => {
    const single = {
      ...ACTIVE,
      byDevice: [{ deviceId: STATION_ID, accepted: 547, boxesClosed: 45, pallets: 0 }],
    };
    const dialog = await openTotals(shiftsSession([single]));
    expect(within(dialog).queryByRole("region", { name: "По устройствам" })).toBeNull();
  });

  it("adds nothing for a shift of a host before protocol 7", async () => {
    const dialog = await openTotals(shiftsSession([ACTIVE]));
    expect(within(dialog).queryByRole("region", { name: "По устройствам" })).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails.**
      Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shift-totals-by-device.test.tsx`
      Expected: FAIL (no region «По устройствам»).

- [ ] **Step 3: Implement.** In `ShiftTotalsDialog.tsx` change the imports: `import { useState } from "react";` → `import { useId, useState } from "react";`; `import type { DeviceRecord, OfficeShift } from "../../host/protocol.js";` → `import type { DeviceRecord, DeviceTotals, OfficeShift } from "../../host/protocol.js";`. After `deviceLabel` (`:96-102`) add:

```tsx
/**
 * «По устройствам» (plan 2b, spec §7): each device's part of the shift's totals, in the order of
 * the participants. A device is named by the host's own record of the participant (so a technologist
 * sees names), else as `deviceLabel` names it. A validation shift puts its codes in no box.
 */
function DeviceBreakdown({
  shift,
  devices,
}: {
  shift: OfficeShift;
  devices: readonly DeviceRecord[] | undefined;
}) {
  const { t } = useTranslation();
  const titleId = useId();
  const named = (id: string) =>
    shift.participants?.find((each) => each.deviceId === id)?.deviceName ??
    deviceLabel(id, devices, t);
  const value = (part: DeviceTotals) =>
    shift.mode === "validation"
      ? t("office.shifts.totals.byDeviceUnits", { units: UNITS.format(part.accepted) })
      : t("office.shifts.totals.byDeviceValue", {
          units: UNITS.format(part.accepted),
          boxes: UNITS.format(part.boxesClosed),
          pallets: UNITS.format(part.pallets),
        });
  return (
    <section aria-labelledby={titleId}>
      <h3 id={titleId} className="shift-breakdown__title">
        {t("office.shifts.totals.byDevice")}
      </h3>
      <DefinitionGrid
        items={(shift.byDevice ?? []).map((part) => ({
          id: part.deviceId,
          term: named(part.deviceId),
          description: value(part),
          mono: true,
        }))}
      />
    </section>
  );
}
```

In `ShiftFigures`, after the `devicesNote` paragraph (`:196-198`), before the closing `</>`:

```tsx
{
  shift.byDevice !== undefined && shift.byDevice.length > 1 && (
    <DeviceBreakdown shift={shift} devices={devices} />
  );
}
```

- [ ] **Step 4: Run the new test and the old totals tests.**
      Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shift-totals-by-device.test.tsx test/shift-totals.test.tsx test/shift-card.test.tsx`
      Expected: PASS (`shift-totals.test.tsx` is unchanged: its shifts carry no `byDevice`, so no extra term appears).

- [ ] **Step 5: Typecheck, format, commit.**
      Run: `… typecheck`, `… lint`, `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false exec prettier --write apps/standalone/src/office/shifts/ShiftTotalsDialog.tsx apps/standalone/test/shift-totals-by-device.test.tsx`

```bash
git -C "$WT" add apps/standalone/src/office/shifts/ShiftTotalsDialog.tsx apps/standalone/test/shift-totals-by-device.test.tsx
git -C "$WT" commit -m "feat(standalone): a shift's totals broken down by device (plan 2b)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: «Закрыть смену целиком» — the forced close with the list of who had not closed

**Files:**

- Modify: `apps/standalone/src/office/shifts/CloseShiftDialog.tsx:7-17` (imports), `:41-62` (doc and hooks), `:104-119` (title, submit, intro, preview)
- Modify: `apps/standalone/src/office/shifts/ShiftsPage.tsx:49-57` (imports), `:471-480` (the close action)
- Modify: `apps/standalone/src/office/shifts/ShiftDrawer.tsx:41-58` (imports), `:365-369` (the close button)
- Test: `apps/standalone/test/shift-force-close.test.tsx` (new)

**Interfaces:**

- Consumes: Task 3 `isSharedShift`, `notClosedParticipants`, fixtures `SHARED`, `participant`, `PARTICIPANT_A`, `PARTICIPANT_B`, `HANDHELD_ID`; Task 2 texts; `shiftClose(reason, expectedRev)` (unchanged); `api.closeShift`.
- Produces: for a shift with more than one participant the dialog, the row action and the card button say «целиком»; for any shift with an open participant the dialog shows «Не закрыли: …». The request is unchanged: `closeShift(token, id, { reason, expectedRev: shift.rev })`.

- [ ] **Step 1: Write the failing test** `apps/standalone/test/shift-force-close.test.tsx`:

```tsx
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { HostError } from "../src/host/client.js";
import type { OfficeShift } from "../src/host/protocol.js";
import type { FakeOfficeSession } from "./support/office.js";
import { hasRowAction, pressRowAction } from "./support/row-menu.js";
import {
  ACTIVE,
  expectFocusedNotice,
  HANDHELD_ID,
  openShifts,
  participant,
  PARTICIPANT_A,
  PARTICIPANT_B,
  SHARED,
  shiftsSession,
} from "./support/shifts.js";

const TOKEN = "office-session-token";
const WHOLE = "Закрыть смену OCT26-004 целиком";
const PLAIN = "Закрыть смену OCT26-004";
const CLOSED_SHARED: OfficeShift = {
  ...SHARED,
  status: "closed",
  closedAt: "2026-10-08T14:10:00Z",
  rev: 72,
};

async function openWhole(session: FakeOfficeSession): Promise<HTMLElement> {
  await openShifts(session);
  pressRowAction(screen, WHOLE);
  return screen.findByRole("dialog", { name: WHOLE });
}

function giveReason(dialog: HTMLElement, text: string): void {
  fireEvent.change(within(dialog).getByLabelText("Причина закрытия"), { target: { value: text } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Закрыть смену целиком" }));
}

describe("closing a shared shift from the office (plan 2b)", () => {
  it("offers «целиком» for a shift two devices entered", async () => {
    await openShifts(shiftsSession([SHARED]));
    expect(hasRowAction(screen, WHOLE)).toBe(true);
    expect(hasRowAction(screen, PLAIN)).toBe(false);
  });

  it("keeps the usual close for a shift that is not shared", async () => {
    await openShifts(shiftsSession([ACTIVE]));
    expect(hasRowAction(screen, PLAIN)).toBe(true);
    expect(hasRowAction(screen, WHOLE)).toBe(false);
  });

  it("says it closes the shift for every device and names those that had not closed", async () => {
    const dialog = await openWhole(shiftsSession([SHARED]));
    expect(
      within(dialog).getByText(/^Закрытие в офисе закрывает смену для всех устройств сразу/),
    ).toBeTruthy();
    expect(
      within(dialog).getByText("Не закрыли: Станция линии 1 (работает), ТСД 1 (работает)."),
    ).toBeTruthy();
  });

  it("says a paused device is paused, and leaves out a part that is already closed", async () => {
    const shift: OfficeShift = {
      ...SHARED,
      participants: [
        participant({ state: "closed", closedBy: "device", closedAt: "2026-10-08T09:00:00Z" }),
        { ...PARTICIPANT_B, state: "left" },
        participant({ deviceId: "0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e", deviceName: "Станция 2" }),
      ],
    };
    const dialog = await openWhole(shiftsSession([shift]));
    expect(
      within(dialog).getByText("Не закрыли: ТСД 1 (на паузе), Станция 2 (работает)."),
    ).toBeTruthy();
  });

  it("shows a device's name as text, never as markup", async () => {
    const shift: OfficeShift = {
      ...SHARED,
      participants: [PARTICIPANT_A, { ...PARTICIPANT_B, deviceName: "<b>ТСД</b> 1" }],
    };
    const dialog = await openWhole(shiftsSession([shift]));
    expect(
      within(dialog).getByText("Не закрыли: Станция линии 1 (работает), <b>ТСД</b> 1 (работает)."),
    ).toBeTruthy();
    expect(dialog.querySelector("b")).toBeNull();
  });

  it("still asks for the reason in words, and sends nothing without it", async () => {
    const session = shiftsSession([SHARED]);
    const dialog = await openWhole(session);
    giveReason(dialog, "  ");
    expect(await within(dialog).findByText("Опишите причину: от 3 до 500 символов")).toBeTruthy();
    expect(session.api.closeShift).not.toHaveBeenCalled();
  });

  it("sends the trimmed reason with the revision the shift was loaded at, and says the shift is closed", async () => {
    const session = shiftsSession([SHARED]);
    session.api.closeShift.mockResolvedValue(CLOSED_SHARED);
    const dialog = await openWhole(session);
    giveReason(dialog, "  Станция Б сломалась ");
    await waitFor(() =>
      expect(session.api.closeShift).toHaveBeenCalledWith(TOKEN, SHARED.id, {
        reason: "Станция Б сломалась",
        expectedRev: SHARED.rev,
      }),
    );
    await expectFocusedNotice("Смена OCT26-004 закрыта.");
  });

  it("offers to load the data again when a device closed or joined since, and never retries with the host's revision", async () => {
    const session = shiftsSession([SHARED]);
    session.api.closeShift.mockRejectedValue(
      new HostError({
        kind: "api",
        code: "stale_revision",
        status: 409,
        message: "stale",
        details: { currentRev: 80 },
      }),
    );
    const dialog = await openWhole(session);
    giveReason(dialog, "Станция Б сломалась");
    fireEvent.click(await within(dialog).findByRole("button", { name: "Загрузить заново" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(session.api.closeShift).toHaveBeenCalledTimes(1);
  });

  it("opens from the card too, under the same name", async () => {
    const session = shiftsSession([SHARED]);
    await openShifts(session);
    fireEvent.click(screen.getByRole("link", { name: "Карточка смены OCT26-004" }));
    await screen.findByRole("heading", { name: "Смена OCT26-004" });
    fireEvent.click(screen.getByRole("button", { name: "Закрыть целиком" }));
    expect(await screen.findByRole("dialog", { name: WHOLE })).toBeTruthy();
  });
});

describe("the preview for a shift one device entered (plan 2b)", () => {
  it("keeps the usual title and still names the device that has not closed", async () => {
    const single: OfficeShift = { ...SHARED, participants: [PARTICIPANT_A] };
    await openShifts(shiftsSession([single]));
    pressRowAction(screen, PLAIN);
    const dialog = await screen.findByRole("dialog", { name: PLAIN });
    expect(within(dialog).getByText("Не закрыли: Станция линии 1 (работает).")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Закрыть смену" })).toBeTruthy();
  });

  it("shows no preview for a shift of a host before protocol 7", async () => {
    await openShifts(shiftsSession([ACTIVE]));
    pressRowAction(screen, PLAIN);
    const dialog = await screen.findByRole("dialog", { name: PLAIN });
    expect(within(dialog).queryByText(/^Не закрыли/)).toBeNull();
  });
});

// A handheld that is not the shift's opener is a full participant: the dialog names it by its own record.
it("names a device that did not open the shift", async () => {
  const shift: OfficeShift = {
    ...SHARED,
    participants: [{ ...PARTICIPANT_A, state: "closed", closedBy: "device" }, PARTICIPANT_B],
  };
  expect(shift.participants?.[1]?.deviceId).toBe(HANDHELD_ID);
  const dialog = await openWhole(shiftsSession([shift]));
  expect(within(dialog).getByText("Не закрыли: ТСД 1 (работает).")).toBeTruthy();
});
```

- [ ] **Step 2: Run it to verify it fails.**
      Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shift-force-close.test.tsx`
      Expected: FAIL (no row action «Закрыть смену OCT26-004 целиком»; no «Не закрыли»).

- [ ] **Step 3: Change the dialog.** In `CloseShiftDialog.tsx`:

(a) imports: `import { Textarea } from "@markiro/ui";` → `import { Alert, Textarea } from "@markiro/ui";`; after `import { useRereadShiftsOnLostAnswer } from "./shift-reread.js";` add `import { isSharedShift, notClosedParticipants } from "./participation.js";`.

(b) replace the doc comment of the component (`:41-46`) with:

```tsx
/**
 * Closes an active shift from the office, with the reason in words (3 to 500
 * characters, counted as the host counts them, with no line break or other
 * control character: the rule says so under the field), over the revision the
 * dialog was opened on: for a station that died or a shift nobody will finish.
 * A shift several devices entered is closed «целиком» (plan 2b): every device that
 * has not closed its part is closed with it. The dialog says so and, whenever a
 * participant is still open, names them («Не закрыли: …») from the shift it holds;
 * the loaded revision makes that list exact, since every participant change moves
 * the shift's revision and a close over an old one is refused as stale.
 */
```

(c) after `const rereadIfLost = useRereadShiftsOnLostAnswer();` (`:60`) add:

```tsx
const shared = isSharedShift(shift);
const open = notClosedParticipants(shift);
```

(d) replace the `FormDialog` head and intro. `title={t("office.shifts.closeTitle", { number: shift.number })}` → `title={t(shared ? "office.shifts.closeAllTitle" : "office.shifts.closeTitle", { number: shift.number })}`; `submitLabel={t("office.shifts.closeSubmit")}` → `submitLabel={t(shared ? "office.shifts.closeAllSubmit" : "office.shifts.closeSubmit")}`; replace `<p>{t("office.shifts.closeIntro")}</p>` with:

```tsx
<p>{t(shared ? "office.shifts.closeAllIntro" : "office.shifts.closeIntro")}</p>;
{
  open.length > 0 && (
    <Alert tone="warn">
      {t("office.shifts.notClosed", {
        devices: open
          .map((each) =>
            t("office.shifts.notClosedItem", {
              name: each.deviceName,
              state: t(`office.shifts.notClosedState.${each.state}`),
            }),
          )
          .join(", "),
      })}
    </Alert>
  );
}
```

- [ ] **Step 4: The list's action.** In `ShiftsPage.tsx` add `import { isSharedShift } from "./participation.js";` after the `ShiftMarks` import, and replace the close item (`:471-480`):

```tsx
if (canPlan && shift.status === "active") {
  // A shift several devices entered is closed whole: the office says so.
  const whole = isSharedShift(shift);
  items.push({
    key: "close",
    label: t(whole ? "office.shifts.closeAll" : "office.shifts.close"),
    ariaLabel: t(whole ? "office.shifts.closeAllNamed" : "office.shifts.closeNamed", named),
    icon: "stop",
    destructive: true,
    onSelect: () => open({ kind: "close", shift }),
  });
}
```

- [ ] **Step 5: The card's button.** In `ShiftDrawer.tsx` add `import { isSharedShift } from "./participation.js";` (next to the `ShiftMarks` import) and replace the close button (`:365-369`):

```tsx
{
  canPlan && current.status === "active" && (
    <Button variant="secondary" onClick={() => setDialog("close")}>
      {t(isSharedShift(current) ? "office.shifts.closeAll" : "office.shifts.close")}
    </Button>
  );
}
```

- [ ] **Step 6: Run the new test and the old close tests.**
      Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shift-force-close.test.tsx test/shift-delete-close.test.tsx test/shift-card.test.tsx test/shifts-page.test.tsx`
      Expected: PASS (the old suites use shifts with no participants: every old name and text is unchanged).

- [ ] **Step 7: Typecheck, format, commit.**
      Run: `… typecheck`, `… lint`, `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false exec prettier --write apps/standalone/src/office/shifts/CloseShiftDialog.tsx apps/standalone/src/office/shifts/ShiftsPage.tsx apps/standalone/src/office/shifts/ShiftDrawer.tsx apps/standalone/test/shift-force-close.test.tsx`

```bash
git -C "$WT" add apps/standalone/src/office/shifts/CloseShiftDialog.tsx apps/standalone/src/office/shifts/ShiftsPage.tsx \
  apps/standalone/src/office/shifts/ShiftDrawer.tsx apps/standalone/test/shift-force-close.test.tsx
git -C "$WT" commit -m "feat(standalone): close a shared shift whole from the office, naming who had not closed (plan 2b)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: «Причина не указана» — the office supplies the reason

**Files:**

- Create: `apps/standalone/src/office/shifts/CloseReasonDialog.tsx`
- Modify: `apps/standalone/src/office/shifts/ShiftsPage.tsx:49-57` (imports), `:85-91` (`ShiftsDialog`), before `:481` (a row action), after `:749` (dialog)
- Modify: `apps/standalone/src/office/shifts/ShiftDrawer.tsx:41-58` (imports), `:86` (`CardDialog`), `:365-369` (a card button), after `:472` (dialog)
- Test: `apps/standalone/test/shift-close-reason.test.tsx` (new)

**Interfaces:**

- Consumes: Task 1 `api.setShiftCloseReason`, `shiftCloseReasonSet`; Task 5 `ShiftMarks` (already shows the tag); Task 3 `SHARED_NO_REASON`; Task 2 texts; `SHIFT_CLOSE_REASON_CODES`, `isShiftCloseReasonCode` from `@markiro/domain`; `shiftWriteFailure`, `useRereadShiftsOnLostAnswer`, `FormDialog`, `StaleAlert`, `WriteFailureAlert`.
- Produces: `<CloseReasonDialog shift onClose onSaved(shift: OfficeShift) onReload onOutdated />`; the row action «Указать причину смены {number}» and the card button «Указать причину» for a closed shift with `closeReasonMissing === true`, for `planShifts`.

- [ ] **Step 1: Write the failing test** `apps/standalone/test/shift-close-reason.test.tsx`:

```tsx
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { HostError } from "../src/host/client.js";
import type { OfficeShift } from "../src/host/protocol.js";
import type { FakeOfficeSession } from "./support/office.js";
import { hasRowAction, pressRowAction } from "./support/row-menu.js";
import { chooseValue, optionTexts } from "./support/select.js";
import {
  ACTIVE,
  CLOSED,
  expectFocusedNotice,
  openShifts,
  SHARED,
  SHARED_NO_REASON,
  shiftsSession,
} from "./support/shifts.js";

const TOKEN = "office-session-token";
const ACTION = "Указать причину смены OCT26-004";
const TITLE = "Причина смены OCT26-004";
const UNITS = new Intl.NumberFormat("ru");
const SUPPLIED: OfficeShift = {
  ...SHARED_NO_REASON,
  closeReasonMissing: undefined,
  closeReasonCode: "equipment_stop",
  rev: 89,
};

function api(code: string, details: Record<string, unknown> = {}, status = 409): HostError {
  return new HostError({ kind: "api", code, status, message: code, details });
}

async function openReason(session: FakeOfficeSession): Promise<HTMLElement> {
  await openShifts(session);
  pressRowAction(screen, ACTION);
  return screen.findByRole("dialog", { name: TITLE });
}

function save(dialog: HTMLElement): void {
  fireEvent.click(within(dialog).getByRole("button", { name: "Сохранить причину" }));
}

describe("the shift closed without its reason (plan 2b, spec §12.9)", () => {
  it("is marked in the list, with the action to give the reason", async () => {
    await openShifts(shiftsSession([SHARED_NO_REASON]));
    expect(screen.getByText("Причина не указана")).toBeTruthy();
    expect(hasRowAction(screen, ACTION)).toBe(true);
  });

  it("offers the action for a closed shift that lacks the reason only", async () => {
    await openShifts(shiftsSession([SHARED, CLOSED]));
    expect(hasRowAction(screen, ACTION)).toBe(false);
    expect(hasRowAction(screen, "Указать причину смены OCT26-001/S")).toBe(false);
    expect(screen.queryByText("Причина не указана")).toBeNull();
  });

  it("offers it on the card too", async () => {
    await openShifts(shiftsSession([SHARED_NO_REASON]));
    fireEvent.click(screen.getByRole("link", { name: "Карточка смены OCT26-004" }));
    await screen.findByRole("heading", { name: "Смена OCT26-004" });
    fireEvent.click(screen.getByRole("button", { name: "Указать причину" }));
    expect(await screen.findByRole("dialog", { name: TITLE })).toBeTruthy();
  });

  it("says the plan and what was accepted, and lists the six reasons in the station's words", async () => {
    const dialog = await openReason(shiftsSession([SHARED_NO_REASON]));
    expect(
      within(dialog).getByText(
        `План смены — ${UNITS.format(1200)} шт, принято 547 шт. Устройства закрыли смену, не назвав причину расхождения с планом. Выберите её из списка: она попадёт в журнал действий.`,
      ),
    ).toBeTruthy();
    expect(optionTexts("Причина расхождения")).toEqual([
      "Производственный брак",
      "Недостаток сырья",
      "Остановка оборудования",
      "Изменение производственного задания",
      "Ошибка в плановом количестве",
      "Другое производственное отклонение",
    ]);
  });

  it("asks for a choice and sends nothing without one", async () => {
    const session = shiftsSession([SHARED_NO_REASON]);
    const dialog = await openReason(session);
    save(dialog);
    expect(await within(dialog).findByText("Выберите причину из списка")).toBeTruthy();
    expect(session.api.setShiftCloseReason).not.toHaveBeenCalled();
  });

  it("sends the code over the loaded revision, says so and reads the list again", async () => {
    const session = shiftsSession([SHARED_NO_REASON]);
    session.api.setShiftCloseReason.mockResolvedValue(SUPPLIED);
    const dialog = await openReason(session);
    chooseValue("Причина расхождения", "equipment_stop");
    save(dialog);
    await waitFor(() =>
      expect(session.api.setShiftCloseReason).toHaveBeenCalledWith(TOKEN, SHARED_NO_REASON.id, {
        reasonCode: "equipment_stop",
        expectedRev: 88,
      }),
    );
    await expectFocusedNotice("Причина смены OCT26-004 указана.");
    await waitFor(() => expect(session.api.listShifts).toHaveBeenCalledTimes(2));
  });

  it("says it is already set when the office or another PC gave it first, and reads the list again", async () => {
    const session = shiftsSession([SHARED_NO_REASON]);
    session.api.setShiftCloseReason.mockRejectedValue(
      api("conflict", { constraint: "close_reason_not_missing" }),
    );
    const dialog = await openReason(session);
    chooseValue("Причина расхождения", "equipment_stop");
    save(dialog);
    expect(
      await within(dialog).findByText("Причина уже указана. Список смен обновлён."),
    ).toBeTruthy();
    await waitFor(() => expect(session.api.listShifts).toHaveBeenCalledTimes(2));
    expect(within(dialog).getByRole("button", { name: "Сохранить причину" })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("offers to load the data again after a stale write and never retries with the host's revision", async () => {
    const session = shiftsSession([SHARED_NO_REASON]);
    session.api.setShiftCloseReason.mockRejectedValue(api("stale_revision", { currentRev: 90 }));
    const dialog = await openReason(session);
    chooseValue("Причина расхождения", "equipment_stop");
    save(dialog);
    fireEvent.click(await within(dialog).findByRole("button", { name: "Загрузить заново" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(session.api.setShiftCloseReason).toHaveBeenCalledTimes(1);
  });

  it("puts a code the host did not take under the field", async () => {
    const session = shiftsSession([SHARED_NO_REASON]);
    session.api.setShiftCloseReason.mockRejectedValue(
      api("validation_failed", { field: "reasonCode" }, 400),
    );
    const dialog = await openReason(session);
    chooseValue("Причина расхождения", "equipment_stop");
    save(dialog);
    expect(
      await within(dialog).findByText("Хост не принял это значение. Проверьте его."),
    ).toBeTruthy();
  });

  it("is not offered for an active shift", async () => {
    await openShifts(shiftsSession([ACTIVE]));
    expect(hasRowAction(screen, ACTION)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails.**
      Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shift-close-reason.test.tsx`
      Expected: FAIL (no action «Указать причину смены OCT26-004»).

- [ ] **Step 3: Write `CloseReasonDialog.tsx`:**

```tsx
import { zodResolver } from "@hookform/resolvers/zod";
import { isShiftCloseReasonCode, SHIFT_CLOSE_REASON_CODES } from "@markiro/domain";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { Select } from "@markiro/ui";

import { HostError } from "../../host/client.js";
import type { OfficeShift } from "../../host/protocol.js";
import { shiftCloseReasonSet } from "../../host/requests.js";
import { useFieldError, type AlertFailure } from "../form-errors.js";
import { FormDialog } from "../FormDialog.js";
import { useOfficeMutation } from "../office-query.js";
import { StaleAlert, WriteFailureAlert } from "../page-state.js";
import { shiftWriteFailure } from "./shift-form.js";
import { useRereadShiftsOnLostAnswer } from "./shift-reread.js";

/** Counts with the thousands apart by a no-break space, as Russian writes them: «1 200». */
const UNITS = new Intl.NumberFormat("ru");

const reasonSchema = z.object({
  reasonCode: z.string().refine(isShiftCloseReasonCode, "office.shifts.errors.reasonRequired"),
});
type ReasonValues = z.input<typeof reasonSchema>;

export interface CloseReasonDialogProps {
  /** A closed shift whose devices closed it without the reason (`closeReasonMissing`). */
  shift: OfficeShift;
  onClose: () => void;
  onSaved: (shift: OfficeShift) => void;
  /** The shift changed on the host: close and load the list again. */
  onReload: () => void;
  /** The shift was given its reason or deleted meanwhile: the page reads the list again. */
  onOutdated: () => void;
}

/**
 * The reason of a shared shift its last device closed without one (plan 2b, spec §12.9): one of
 * the six codes a station would have given, over the revision the dialog was opened on. A shift
 * that already has its reason (`close_reason_not_missing`: another PC, or a race) is an alert in
 * words of its own that follows with a read of the list, as every shift dialog treats a shift that
 * moved.
 */
export function CloseReasonDialog({
  shift,
  onClose,
  onSaved,
  onReload,
  onOutdated,
}: CloseReasonDialogProps) {
  const { t } = useTranslation();
  const fieldError = useFieldError();
  const [failure, setFailure] = useState<AlertFailure | null>(null);
  // The key of the text that says the shift moved: a resend would be refused the same way, so
  // «Сохранить причину» stays off and the alert offers to load the list.
  const [outdatedMessage, setOutdatedMessage] = useState<string | null>(null);
  const rereadIfLost = useRereadShiftsOnLostAnswer();
  const save = useOfficeMutation((api, token, reasonCode: string) =>
    api.setShiftCloseReason(token, shift.id, shiftCloseReasonSet(reasonCode, shift.rev)),
  );
  const {
    control,
    handleSubmit,
    setError,
    formState: { errors },
  } = useForm<ReasonValues>({
    resolver: zodResolver(reasonSchema),
    defaultValues: { reasonCode: "" },
  });

  const submit = handleSubmit(async (values) => {
    setFailure(null);
    let saved: OfficeShift;
    try {
      saved = await save.mutateAsync(values.reasonCode);
    } catch (error) {
      if (
        error instanceof HostError &&
        error.code === "conflict" &&
        error.details.constraint === "close_reason_not_missing"
      ) {
        setOutdatedMessage("office.shifts.errors.reasonAlreadySet");
        onOutdated();
        return;
      }
      const { failure: outcome, outdated } = shiftWriteFailure(error, {
        reasonCode: "reasonCode",
      });
      if (outcome.kind === "field") {
        setError(
          outcome.field,
          { type: "server", message: outcome.message },
          { shouldFocus: true },
        );
      } else if (outdated && outcome.kind === "alert") {
        setOutdatedMessage(outcome.message);
      } else {
        setFailure(outcome);
        rereadIfLost(error);
      }
      if (outdated) onOutdated();
      return;
    }
    onSaved(saved);
  });

  const options = SHIFT_CLOSE_REASON_CODES.map((code) => ({
    value: code,
    label: t(`office.shifts.closeReasons.${code}`),
  }));

  return (
    <FormDialog
      errorCount={Object.keys(errors).length}
      title={t("office.shifts.reasonTitle", { number: shift.number })}
      submitLabel={t("office.shifts.reasonSubmit")}
      submitDisabled={outdatedMessage !== null}
      onSubmit={submit}
      onClose={onClose}
      alert={
        outdatedMessage !== null ? (
          <StaleAlert onReload={onReload} message={outdatedMessage} />
        ) : (
          <WriteFailureAlert failure={failure} onReload={onReload} />
        )
      }
    >
      <p>
        {t("office.shifts.reasonIntro", {
          plan:
            shift.plannedQty === null ? t("office.common.none") : UNITS.format(shift.plannedQty),
          accepted: UNITS.format(shift.totals.acceptedUnits),
        })}
      </p>
      <Controller
        control={control}
        name="reasonCode"
        render={({ field }) => (
          <Select
            label={t("office.shifts.fields.reasonCode")}
            placeholder={t("office.shifts.fields.reasonCodePlaceholder")}
            options={options}
            value={field.value}
            onValueChange={field.onChange}
            {...fieldError(errors.reasonCode?.message)}
          />
        )}
      />
    </FormDialog>
  );
}
```

- [ ] **Step 4: Wire the list.** In `ShiftsPage.tsx`: add `import { CloseReasonDialog } from "./CloseReasonDialog.js";` after the `CloseShiftDialog` import (`:51`); extend `ShiftsDialog` (`:85-91`) with `| { kind: "reason"; shift: OfficeShift }`; before the delete item (`:481`) add:

```tsx
// A shared shift its devices closed without the reason the plan's gap needed (spec §12.9).
if (canPlan && shift.status === "closed" && shift.closeReasonMissing === true) {
  items.push({
    key: "reason",
    label: t("office.shifts.supplyReason"),
    ariaLabel: t("office.shifts.supplyReasonNamed", named),
    icon: "pencil",
    onSelect: () => open({ kind: "reason", shift }),
  });
}
```

after the `close` dialog block (`:741-749`) add:

```tsx
{
  canPlan && dialog?.kind === "reason" && (
    <CloseReasonDialog
      shift={dialog.shift}
      onClose={() => setDialog(null)}
      onSaved={(shift) => saved(t("office.shifts.reasonSaved", { number: shift.number }))}
      onReload={reload}
      onOutdated={readAgain}
    />
  );
}
```

- [ ] **Step 5: Wire the card.** In `ShiftDrawer.tsx`: add `import { CloseReasonDialog } from "./CloseReasonDialog.js";` after the `CloseShiftDialog` import; `type CardDialog = "export" | "close";` (`:86`) → `type CardDialog = "export" | "close" | "reason";`; after the close button (Task 7) add:

```tsx
{
  canPlan && current.status === "closed" && current.closeReasonMissing === true && (
    <Button variant="secondary" onClick={() => setDialog("reason")}>
      {t("office.shifts.supplyReason")}
    </Button>
  );
}
```

after the close-dialog block (`:457-472`) add:

```tsx
{
  canPlan && dialog === "reason" && (
    <CloseReasonDialog
      shift={current}
      onClose={() => setDialog(null)}
      onSaved={(saved) => {
        setDialog(null);
        setNotice(t("office.shifts.reasonSaved", { number: saved.number }));
        readAgain();
      }}
      onReload={() => {
        setDialog(null);
        readAgain();
      }}
      onOutdated={readAgain}
    />
  );
}
```

- [ ] **Step 6: Run the new test and the neighbours.**
      Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shift-close-reason.test.tsx test/shift-force-close.test.tsx test/shift-delete-close.test.tsx test/shift-card.test.tsx`
      Expected: PASS.

- [ ] **Step 7: Typecheck, format, commit.**
      Run: `… typecheck`, `… lint`, `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false exec prettier --write apps/standalone/src/office/shifts/CloseReasonDialog.tsx apps/standalone/src/office/shifts/ShiftsPage.tsx apps/standalone/src/office/shifts/ShiftDrawer.tsx apps/standalone/test/shift-close-reason.test.tsx`

```bash
git -C "$WT" add apps/standalone/src/office/shifts/CloseReasonDialog.tsx apps/standalone/src/office/shifts/ShiftsPage.tsx \
  apps/standalone/src/office/shifts/ShiftDrawer.tsx apps/standalone/test/shift-close-reason.test.tsx
git -C "$WT" commit -m "feat(standalone): the office supplies the reason of a shift closed without one (plan 2b)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 9: «Устройства» — participation, and the owner-free helpers

**Files:**

- Modify: `apps/standalone/src/office/devices/DevicesPage.tsx:5` (imports), `:14-24`, `:56-58` (queries), `:177-181` (the «Линия» column)
- Modify: `apps/standalone/src/office/devices/station-shift.ts` (whole file)
- Modify: `apps/standalone/src/office/info/update-flow.ts:80-86`
- Modify (existing tests, product decision O1/O8): `apps/standalone/test/devices-page.test.tsx:299-308`, `:314-322`
- Test: `apps/standalone/test/devices-presence.test.tsx` (new), `apps/standalone/test/update-flow-multi-station.test.ts` (new)

**Interfaces:**

- Consumes: Task 3 `presenceOf`, `deviceWorksShift`, `Presence`, `SHARED`, `STATION_ID`, `HANDHELD_ID`, `PARTICIPANT_A`, `PARTICIPANT_B`, `participant`; Task 2 texts `office.devices.presence.*`; `officeKeys.shiftList(null)`; `StatusChip`.
- Produces: the «Линия» cell of a device carries a participation chip; `stationShift(shifts, deviceId)` finds the active shift the device works (participants first, owner for an older host); `installWarnings` names this PC's shift by `deviceWorksShift`.

- [ ] **Step 1: Write the failing test** `apps/standalone/test/devices-presence.test.tsx`:

```tsx
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { DeviceRecord } from "../src/host/protocol.js";
import { stationShift } from "../src/office/devices/station-shift.js";
import { fakeOfficeSession, renderOffice, type FakeOfficeSession } from "./support/office.js";
import { chooseValue } from "./support/select.js";
import {
  ACTIVE,
  HANDHELD_ID,
  LINE_10,
  LINE_2,
  participant,
  PARTICIPANT_A,
  PARTICIPANT_B,
  SHARED,
  STATION_ID,
} from "./support/shifts.js";

const STATION: DeviceRecord = {
  id: STATION_ID,
  kind: "station",
  name: "Станция линии 1",
  lineId: LINE_2.id,
  appVersion: "1.1.0",
  pairedAt: "2026-09-26T09:15:00Z",
  lastSeenAt: "2026-10-08T09:41:00Z",
  revokedAt: null,
};
const HANDHELD: DeviceRecord = {
  ...STATION,
  id: HANDHELD_ID,
  kind: "handheld",
  name: "ТСД 1",
  lineId: null,
};
const SECOND_ID = "0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e";
const SECOND: DeviceRecord = { ...STATION, id: SECOND_ID, name: "Станция 2" };
const IDLE: DeviceRecord = {
  ...STATION,
  id: "5e1a7c3b-9d2f-4b6a-8c4e-0f3d5b7a9c1e",
  name: "Станция упаковки",
  lineId: LINE_10.id,
};

function session(shifts = [SHARED], devices = [STATION, HANDHELD, IDLE]): FakeOfficeSession {
  const fake = fakeOfficeSession();
  fake.api.listDevices.mockResolvedValue(devices);
  fake.api.listLines.mockResolvedValue([{ ...LINE_2, maxStations: 3 }, LINE_10]);
  fake.api.listShifts.mockResolvedValue(shifts);
  return fake;
}

async function openDevices(fake: FakeOfficeSession): Promise<void> {
  renderOffice(fake, { initialPath: "/devices" });
  await screen.findByRole("link", { name: "Устройства" });
  await screen.findByText("Станция линии 1");
}

function rowOf(name: string): HTMLElement {
  const row = screen.getByText(name).closest("tr");
  if (!row) throw new Error(`no row for ${name}`);
  return row;
}

describe("the devices' participation in a shift (plan 2b)", () => {
  it("says under a device's line that it works the shift, for a station and a handheld alike", async () => {
    await openDevices(session());
    await waitFor(() => expect(within(rowOf("ТСД 1")).getByText("В смене OCT26-004")).toBeTruthy());
    expect(within(rowOf("Станция линии 1")).getByText("В смене OCT26-004")).toBeTruthy();
    expect(within(rowOf("Станция линии 1")).getByText("Линия 2")).toBeTruthy();
    expect(within(rowOf("Станция упаковки")).queryByText(/смене/)).toBeNull();
  });

  it("tells a paused device and one that closed its part from one at work, in a word and a glyph", async () => {
    const shift = {
      ...SHARED,
      participants: [
        participant({ state: "left" }),
        { ...PARTICIPANT_B, state: "closed" as const, closedBy: "device" as const },
      ],
    };
    await openDevices(session([shift]));
    await waitFor(() =>
      expect(within(rowOf("Станция линии 1")).getByText("На паузе в смене OCT26-004")).toBeTruthy(),
    );
    expect(within(rowOf("ТСД 1")).getByText("Часть закрыта в смене OCT26-004")).toBeTruthy();
    expect(within(rowOf("Станция линии 1")).getByText("·")).toBeTruthy();
    expect(within(rowOf("ТСД 1")).getByText("✓")).toBeTruthy();
  });

  it("lists the devices as before when the shifts did not load, and claims nothing", async () => {
    const fake = session();
    fake.api.listShifts.mockRejectedValue(new Error("down"));
    await openDevices(fake);
    expect(within(rowOf("Станция линии 1")).queryByText(/смене/)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("adds no column: the table keeps its eight, so «Доступ» and the actions stay in view at 1280 px", async () => {
    await openDevices(session());
    expect(
      within(screen.getByRole("table"))
        .getAllByRole("columnheader")
        .map((head) => head.textContent),
    ).toEqual(["Имя", "Вид", "Линия", "Версия", "Подключено", "Связь", "Доступ", "Действия"]);
  });

  it("claims nothing for a shift of a host before protocol 7", async () => {
    await openDevices(session([{ ...ACTIVE, ownerDeviceId: STATION_ID }]));
    expect(within(rowOf("Станция линии 1")).queryByText(/смене/)).toBeNull();
  });
});

describe("the warning before a station moves, by the shift it works (plan 2b)", () => {
  const warning = /^На станции идёт смена OCT26-004\./;

  /** Opens a station's dialog once the table shows what the shifts say of it, and picks another line. */
  async function openMove(
    fake: FakeOfficeSession,
    name: string,
    settled: () => Promise<unknown>,
  ): Promise<HTMLElement> {
    await openDevices(fake);
    await settled();
    fireEvent.click(screen.getByRole("button", { name: `Изменить устройство «${name}»` }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(fake.api.listShifts).toHaveBeenCalled());
    chooseValue("Линия", LINE_10.id);
    return dialog;
  }

  it("warns the station that joined a shift it did not open", async () => {
    const shift = {
      ...SHARED,
      participants: [PARTICIPANT_A, participant({ deviceId: SECOND_ID, deviceName: "Станция 2" })],
    };
    const dialog = await openMove(session([shift], [STATION, SECOND]), "Станция 2", () =>
      within(rowOf("Станция 2")).findByText("В смене OCT26-004"),
    );
    expect(await within(dialog).findByText(warning)).toBeTruthy();
  });

  it("does not warn the opener once it left and another device works the shift", async () => {
    const shift = {
      ...SHARED,
      participants: [{ ...PARTICIPANT_A, state: "left" as const }, PARTICIPANT_B],
    };
    const dialog = await openMove(session([shift]), "Станция линии 1", () =>
      within(rowOf("Станция линии 1")).findByText("На паузе в смене OCT26-004"),
    );
    expect(within(dialog).queryByText(warning)).toBeNull();
  });
});

describe("the shift a station works", () => {
  it("is found by its participation, and by ownership for a host before protocol 7", () => {
    const joined = {
      ...SHARED,
      participants: [PARTICIPANT_A, participant({ deviceId: SECOND_ID })],
    };
    expect(stationShift([joined], SECOND_ID)).toBe(joined);
    expect(stationShift([joined], HANDHELD_ID)).toBeUndefined();
    const older = { ...ACTIVE, ownerDeviceId: STATION_ID };
    expect(stationShift([older], STATION_ID)).toBe(older);
    expect(stationShift(undefined, STATION_ID)).toBeUndefined();
  });
});
```

and `apps/standalone/test/update-flow-multi-station.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { installWarnings } from "../src/office/info/update-flow.js";
import type { VerifiedReport } from "../src/office/info/update-shell.js";
import { DEVICE_ID } from "./support/fixtures.js";
import { ACTIVE, HANDHELD_ID, PARTICIPANT_B, participant, SHARED } from "./support/shifts.js";

const SHA = "9f2b5c0e6d1a4b8c7e3f2a1d0c9b8a7f6e5d4c3b2a1f0e9d8c7b6a5f4e3d2c1b";

const REPORT: VerifiedReport = {
  path: "C:\\Updates\\markiro-standalone-0.2.0.update.jws",
  kid: "test-upd-1",
  manifest: {
    v: 1,
    product: "markiro-standalone",
    version: "0.2.0",
    channel: "stable",
    releasedAt: "2026-11-02T10:00:00Z",
    sourceSha: "a".repeat(40),
    installer: {
      name: "markiro-standalone-0.2.0-windows-x86_64-setup.exe",
      sha256: SHA,
      sizeBytes: 29,
    },
    protocol: 3,
    minProtocol: 2,
    minUpgradeFrom: "0.1.0",
    notes: ["Тестовый выпуск 0.2.0"],
  },
  installed: "0.1.0",
  installerPath: "C:\\Updates\\markiro-standalone-0.2.0-windows-x86_64-setup.exe",
  comparison: "newer",
  refusal: null,
  confirmations: [],
  host: null,
};

function warnings(shifts: Parameters<typeof installWarnings>[0]["shifts"], thisDeviceId: string) {
  return installWarnings({ report: REPORT, role: "station", devices: [], shifts, thisDeviceId });
}

describe("the shift of this PC before an update (plan 2b)", () => {
  it("is the shift this PC works as a participant, though it did not open it", () => {
    expect(warnings([SHARED], HANDHELD_ID).openShift).toBe("OCT26-004");
  });

  it("is none once this PC left the shift, even if it opened it", () => {
    const shift = { ...SHARED, participants: [participant({ state: "left" }), PARTICIPANT_B] };
    expect(warnings([shift], DEVICE_ID).openShift).toBeNull();
    expect(warnings([shift], HANDHELD_ID).openShift).toBe("OCT26-004");
  });

  it("is the owner's for a host before protocol 7, as before", () => {
    expect(warnings([ACTIVE], DEVICE_ID).openShift).toBe("OCT26-004");
    expect(warnings([ACTIVE], HANDHELD_ID).openShift).toBeNull();
  });
});
```

(`DEVICE_ID` of `support/fixtures.ts` is `STATION_ID`, the opener.)

- [ ] **Step 2: Run them to verify they fail.**
      Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/devices-presence.test.tsx test/update-flow-multi-station.test.ts`
      Expected: FAIL (no participation chip; a non-owner joined station has no warning; `installWarnings` names no shift for a handheld).

- [ ] **Step 3: Rewrite `station-shift.ts`:**

```ts
import type { OfficeShift } from "../../host/protocol.js";
import { deviceWorksShift } from "../shifts/participation.js";

/**
 * The shift a device works: the active one where it is an active participant (plan 2b: several
 * devices work one shift, and `ownerDeviceId` is only who opened it), or, for a host before
 * protocol 7 that names no participants, the active one it opened. A planned shift is nobody's
 * yet and a closed one is over; `undefined` while the list is not loaded.
 */
export function stationShift(
  shifts: readonly OfficeShift[] | undefined,
  deviceId: string,
): OfficeShift | undefined {
  return shifts?.find((shift) => deviceWorksShift(shift, deviceId));
}
```

- [ ] **Step 4: The update flow.** `update-flow.ts:80-86`:

```ts
    openShift:
      own === null
        ? null
        : (input.shifts.find((shift) => deviceWorksShift(shift, own))?.number ?? null),
```

with `const own = input.thisDeviceId;` added as the first statement of `installWarnings` (a `const` keeps its narrowing inside the callback, which the property `input.thisDeviceId` would not) and `import { deviceWorksShift } from "../shifts/participation.js";` added to the imports.

- [ ] **Step 5: The page.** `DevicesPage.tsx`: add `StatusChip` is already imported; add imports `import { presenceOf, type Presence } from "../shifts/participation.js";` and `import type { TagPhase } from "@markiro/ui";` merged into the `@markiro/ui` import (`:5`) as `type TagPhase`. After the `lines` query (`:57`) add:

```tsx
// Who works which shift (plan 2b): read for the «Линия» column; a list that does not load claims
// nothing, and the page lists the devices as it always did.
const shifts = useOfficeQuery(officeKeys.shiftList(null), (api, token) => api.listShifts(token));
```

Above the component add:

```tsx
/** A device's participation as a phase: at work ▸, paused ·, its part closed ✓. */
const PRESENCE_PHASE = {
  active: "active",
  left: "none",
  closed: "done",
} as const satisfies Record<Presence["state"], TagPhase>;
```

Replace the «Линия» column (`:177-181`):

```tsx
    {
      key: "line",
      title: t("office.devices.table.line"),
      wrap: true,
      minWidth: 140,
      // The line, and under it the shift the device works, in a word and a glyph (plan 2b): one
      // column, not two, so the table's other columns keep their room at 1280 px.
      render: (device) => {
        const presence = presenceOf(shifts.data, device.id);
        return (
          <span className="shift-cell">
            <span>{lineLabel(lines.data ?? [], device.lineId, t)}</span>
            {presence !== null && (
              <StatusChip
                phase={PRESENCE_PHASE[presence.state]}
                wrap
                label={t(`office.devices.presence.${presence.state}`, { number: presence.number })}
              />
            )}
          </span>
        );
      },
    },
```

- [ ] **Step 6: Adapt the two existing tests.** In `apps/standalone/test/devices-page.test.tsx`:

`:299-308` (the page now reads the shifts once for its table, so the old «not at all» no longer holds; what the test pins is that a non-station's dialog adds no read of its own):

old:

```ts
  it("reads the shifts for a station only", async () => {
```

new:

```ts
  it("reads the shifts once for the table, and a non-station's dialog adds none of its own", async () => {
```

old (last line of that test):

```ts
expect(session.api.listShifts).not.toHaveBeenCalled();
```

new:

```ts
expect(session.api.listShifts).toHaveBeenCalledTimes(1);
```

`:314-322` (page and dialog share one query; the dialog's mount reads an unread list again):

old:

```ts
await waitFor(() => expect(session.api.listShifts).toHaveBeenCalledTimes(1));
chooseValue("Линия", other.id);
```

new:

```ts
await waitFor(() => expect(session.api.listShifts).toHaveBeenCalled());
chooseValue("Линия", other.id);
```

Name both changes in the report: the product decision is that «Устройства» reads the shifts for the participation chip.

- [ ] **Step 7: Run the whole device suite and the update suite.**
      Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/devices-presence.test.tsx test/devices-page.test.tsx test/devices-repair.test.tsx test/update-flow-multi-station.test.ts test/update-flow.test.ts test/update-section.test.tsx`
      Expected: PASS.

- [ ] **Step 8: Typecheck, format, commit.**
      Run: `… typecheck`, `… lint`, `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false exec prettier --write apps/standalone/src/office/devices/DevicesPage.tsx apps/standalone/src/office/devices/station-shift.ts apps/standalone/src/office/info/update-flow.ts apps/standalone/test/devices-presence.test.tsx apps/standalone/test/update-flow-multi-station.test.ts apps/standalone/test/devices-page.test.tsx`

```bash
git -C "$WT" add apps/standalone/src/office/devices/DevicesPage.tsx apps/standalone/src/office/devices/station-shift.ts \
  apps/standalone/src/office/info/update-flow.ts apps/standalone/test/devices-presence.test.tsx \
  apps/standalone/test/update-flow-multi-station.test.ts apps/standalone/test/devices-page.test.tsx
git -C "$WT" commit -m "feat(standalone): devices show their participation in a shift; owner-free shift lookups (plan 2b)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 10: «Обзор» — stations on a line's card, a silent participant, a shift closed without its reason

**Files:**

- Modify: `apps/standalone/src/office/overview/overview-model.ts:1-3` (imports), after `:91` (`deviceSummary`)
- Modify: `apps/standalone/src/office/overview/dashboard-model.ts:3-23` (imports), `:119-138` (`LineCard`), `:168-182` and `:197-211` (`cardFor`), `:273-274` (`AttentionKind`), `:292-306` (`AttentionInput`), `:336-372` (devices), after `:372`
- Modify: `apps/standalone/src/office/overview/LineCards.tsx:142-168` (after the idle/pace block)
- Modify: `apps/standalone/src/office/overview/overview.css` (after `.ov-line__idle`, `:570-575`)
- Modify: `apps/standalone/src/office/OfficeOverview.tsx:21-28` and `:100-104`
- Test: `apps/standalone/test/overview-multi-station.test.ts` (model), `apps/standalone/test/overview-multi-station.test.tsx` (page) — both new

**Interfaces:**

- Consumes: Task 3 `participantsOf`, `activeParticipants`, `isSilent`, `lastSign`; Task 1 `lineMaxStations`; Task 2 texts; `OfficeLine.maxStations?`; `OfficeShift.closeReasonMissing?`.
- Produces: `LineCard.stations: { active: number; max: number } | null`; `silentParticipants(shifts, lines, nowMs): SilentParticipant[]` and `reasonMissingShifts(shifts): ReasonMissingShift[]` (both in `overview-model.ts`); `AttentionKind` gains `"participant_silent" | "close_reason_missing"`; `AttentionInput` gains optional `silentParticipants?` and `reasonMissing?`; the line card draws «станций в смене: N из M» (class `ov-line__stations`).

- [ ] **Step 1: Write the failing model test** `apps/standalone/test/overview-multi-station.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import type { DeviceRecord, OfficeShift } from "../src/host/protocol.js";
import {
  attentionItems,
  lineCards,
  type AttentionInput,
} from "../src/office/overview/dashboard-model.js";
import { reasonMissingShifts, silentParticipants } from "../src/office/overview/overview-model.js";
import {
  ACTIVE,
  HANDHELD_ID,
  LINE_10,
  LINE_2,
  MILK,
  participant,
  PARTICIPANT_B,
  SHARED,
  SHARED_NO_REASON,
  STATION_ID,
} from "./support/shifts.js";

const NOW = Date.parse("2026-10-08T10:00:00Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const THREE = { ...LINE_2, maxStations: 3 };

/** `SHARED` with the station silent for 19 minutes and the handheld heard three minutes ago. */
const WORKING: OfficeShift = {
  ...SHARED,
  participants: [participant({ lastSeenAt: ago(19) }), { ...PARTICIPANT_B, lastSeenAt: ago(3) }],
};

const CALM: AttentionInput = {
  conflicts: null,
  devices: null,
  backups: null,
  license: null,
  settings: null,
  idleLines: [],
  nowMs: NOW,
  pcNowMs: NOW,
};

function device(id: string, name: string, lastSeenAt: string | null): DeviceRecord {
  return {
    id,
    kind: "station",
    name,
    lineId: null,
    appVersion: "1.1.0",
    pairedAt: "2026-09-26T09:15:00Z",
    lastSeenAt,
    revokedAt: null,
  };
}

describe("the devices at work on a line's card (plan 2b)", () => {
  it("counts the active participants of the line's shift against the line's limit", () => {
    const card = lineCards([WORKING], [THREE], [MILK], NOW, "2026-10-08").cards[0];
    expect(card?.stations).toEqual({ active: 2, max: 3 });
  });

  it("counts only those that hold a slot: a paused or closed device does not", () => {
    const shift: OfficeShift = {
      ...WORKING,
      participants: [
        participant({ state: "left" }),
        { ...PARTICIPANT_B, state: "closed", closedBy: "device" },
        participant({ deviceId: "0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e" }),
      ],
    };
    expect(lineCards([shift], [THREE], [MILK], NOW, "2026-10-08").cards[0]?.stations).toEqual({
      active: 1,
      max: 3,
    });
  });

  it("claims nothing for a line of one, a shift of a host before protocol 7, or a line with no shift", () => {
    expect(lineCards([WORKING], [LINE_2], [MILK], NOW, "2026-10-08").cards[0]?.stations).toBeNull();
    expect(lineCards([ACTIVE], [THREE], [MILK], NOW, "2026-10-08").cards[0]?.stations).toBeNull();
    expect(lineCards([], [THREE], [MILK], NOW, "2026-10-08").cards[0]?.stations).toBeNull();
    expect(
      lineCards([WORKING], [LINE_10], [MILK], NOW, "2026-10-08").cards[0]?.stations,
    ).toBeNull();
  });
});

describe("a participant that has gone silent (the owner's ten minutes)", () => {
  it("lists the active participants of a line of several devices not heard for more than ten minutes, longest first", () => {
    const shift: OfficeShift = {
      ...WORKING,
      participants: [
        participant({ lastSeenAt: ago(19) }),
        { ...PARTICIPANT_B, lastSeenAt: ago(31) },
      ],
    };
    expect(silentParticipants([shift], [THREE], NOW)).toEqual([
      {
        deviceId: HANDHELD_ID,
        name: "ТСД 1",
        shiftId: SHARED.id,
        shiftNumber: "OCT26-004",
        lineName: "Линия 2",
        since: ago(31),
      },
      {
        deviceId: STATION_ID,
        name: "Станция линии 1",
        shiftId: SHARED.id,
        shiftNumber: "OCT26-004",
        lineName: "Линия 2",
        since: ago(19),
      },
    ]);
  });

  it("takes exactly ten minutes as heard, and a millisecond more as silent", () => {
    const inside = { ...WORKING, participants: [participant({ lastSeenAt: ago(10) })] };
    const outside = {
      ...WORKING,
      participants: [participant({ lastSeenAt: new Date(NOW - 600_001).toISOString() })],
    };
    expect(silentParticipants([inside], [THREE], NOW)).toEqual([]);
    expect(silentParticipants([outside], [THREE], NOW)).toHaveLength(1);
  });

  it("leaves out a device that is paused or closed, a closed shift, and a line of one", () => {
    const paused = {
      ...WORKING,
      participants: [participant({ state: "left", lastSeenAt: ago(60) })],
    };
    expect(silentParticipants([paused], [THREE], NOW)).toEqual([]);
    expect(silentParticipants([{ ...WORKING, status: "closed" }], [THREE], NOW)).toEqual([]);
    // A line of one is the old behaviour: its silent station is the device row's, as before.
    expect(silentParticipants([WORKING], [LINE_2], NOW)).toEqual([]);
    expect(silentParticipants([ACTIVE], [THREE], NOW)).toEqual([]);
  });
});

describe("a shift closed without its reason", () => {
  it("lists closed shifts the host marked, and nothing else", () => {
    expect(reasonMissingShifts([SHARED_NO_REASON, SHARED, ACTIVE])).toEqual([
      { shiftId: SHARED_NO_REASON.id, number: "OCT26-004" },
    ]);
    expect(reasonMissingShifts([{ ...SHARED_NO_REASON, status: "active" }])).toEqual([]);
  });
});

describe("«Требует внимания» with several devices (plan 2b)", () => {
  it("lists a silent participant once, in place of the plain silent-device row of the same device, and keeps the others", () => {
    const silent = silentParticipants([WORKING], [THREE], NOW);
    const items = attentionItems({
      ...CALM,
      devices: [
        device(STATION_ID, "Станция линии 1", ago(19)),
        device("5e1a7c3b-9d2f-4b6a-8c4e-0f3d5b7a9c1e", "Склад", ago(47)),
      ],
      silentParticipants: silent,
    });
    expect(items.map((item) => item.id)).toEqual([
      "device-5e1a7c3b-9d2f-4b6a-8c4e-0f3d5b7a9c1e",
      `participant-${SHARED.id}-${STATION_ID}`,
    ]);
    expect(items[1]).toMatchObject({
      kind: "participant_silent",
      severity: "warn",
      to: `/shifts?shift=${SHARED.id}&tab=stations`,
      titleValues: { name: "Станция линии 1", unit: "minutes", count: 19 },
      detailValues: { shift: "OCT26-004", line: "Линия 2" },
    });
  });

  it("lists it for a role that cannot read devices too", () => {
    const items = attentionItems({
      ...CALM,
      devices: null,
      silentParticipants: silentParticipants([WORKING], [THREE], NOW),
    });
    expect(items.map((item) => item.kind)).toEqual(["participant_silent"]);
  });

  it("asks for the reason of a shift closed without one, with the way to its card", () => {
    const [item] = attentionItems({
      ...CALM,
      reasonMissing: reasonMissingShifts([SHARED_NO_REASON]),
    });
    expect(item).toMatchObject({
      kind: "close_reason_missing",
      severity: "warn",
      to: `/shifts?shift=${SHARED_NO_REASON.id}`,
      titleValues: { number: "OCT26-004" },
    });
  });

  it("is as calm as before when it is given neither", () => {
    expect(attentionItems(CALM)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails.**
      Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/overview-multi-station.test.ts`
      Expected: FAIL (`silentParticipants`, `reasonMissingShifts` are not exported; `stations` undefined).

- [ ] **Step 3: `overview-model.ts`.** Change the import (`:2`) to `import type { DeviceKind, DeviceRecord, OfficeLine, OfficeShift } from "../../host/protocol.js";`, add after `:3`:

```ts
import { lineMaxStations } from "../../host/requests.js";
import { isSilent, lastSign, participantsOf } from "../shifts/participation.js";
```

and after `deviceSummary` (`:91`):

```ts
/** An active participant of a shift of a line of several devices that the host has not heard for too long. */
export interface SilentParticipant {
  deviceId: string;
  name: string;
  shiftId: string;
  shiftNumber: string;
  lineName: string;
  /** The host's last sign of it (its last hearing, else its entry), an instant. */
  since: string;
}

/**
 * The silent participants of the active shifts, the longest silent first (plan 2b, spec §7: «активный
 * участник молчит дольше порога», ten minutes — `PARTICIPANT_SILENT_MS`). Only a line whose limit is above
 * one counts: on a line of one the silent station is the plain device row's, as before, so a site that
 * did not turn several devices on sees no new row.
 */
export function silentParticipants(
  shifts: readonly OfficeShift[],
  lines: readonly OfficeLine[],
  nowMs: number,
): SilentParticipant[] {
  const found: SilentParticipant[] = [];
  for (const shift of shifts) {
    if (shift.status !== "active") continue;
    const line = lines.find((each) => each.id === shift.lineId);
    if (line === undefined || lineMaxStations(line) <= 1) continue;
    for (const each of participantsOf(shift)) {
      if (!isSilent(each, nowMs)) continue;
      found.push({
        deviceId: each.deviceId,
        name: each.deviceName,
        shiftId: shift.id,
        shiftNumber: shift.number,
        lineName: line.name,
        since: lastSign(each),
      });
    }
  }
  return found.sort((a, b) => Date.parse(a.since) - Date.parse(b.since));
}

/** A closed shift its devices closed without the reason the plan's gap needed. */
export interface ReasonMissingShift {
  shiftId: string;
  number: string;
}

/** The shifts of the list the host marked `closeReasonMissing`, in the list's order. */
export function reasonMissingShifts(shifts: readonly OfficeShift[]): ReasonMissingShift[] {
  return shifts
    .filter((shift) => shift.status === "closed" && shift.closeReasonMissing === true)
    .map((shift) => ({ shiftId: shift.id, number: shift.number }));
}
```

- [ ] **Step 4: `dashboard-model.ts`.**

(a) imports: after `import { shiftUnits } from "../shifts/shift-list.js";` (`:14`) add `import { lineMaxStations } from "../../host/requests.js";` and `import { activeParticipants } from "../shifts/participation.js";`; extend the `./overview-model.js` import (`:16-22`) with `type ReasonMissingShift,` and `type SilentParticipant,`.

(b) `LineCard` (`:119-138`): after `idleMinutes: number | null;` add

```ts
  /**
   * The devices at work in the shift against the line's limit (plan 2b); `null` for a line of one, a
   * line with no shift and a host before protocol 7, which name no participants.
   */
  stations: { active: number; max: number } | null;
```

(c) `cardFor`: in the no-shift return (`:169-182`) add `stations: null,` after `idleMinutes: null,`; before the final `return {` (`:198`) add

```ts
const limit = lineMaxStations(line);
const stations =
  shift.participants === undefined || limit <= 1
    ? null
    : { active: activeParticipants(shift).length, max: limit };
```

and in the final return after `idleMinutes: idle ? Math.floor(silent / 60_000) : null,` add `stations,`.

(d) `AttentionKind` (`:273-274`) becomes:

```ts
export type AttentionKind =
  | "conflicts"
  | "device_silent"
  | "backup"
  | "license"
  | "clock_skew"
  | "store_full"
  | "line_idle"
  | "participant_silent"
  | "close_reason_missing";
```

(e) `AttentionInput` (`:292-306`): after `idleLines` add

```ts
  /**
   * Active participants of a line of several devices not heard for ten minutes (plan 2b): each is one
   * row, and takes the place of the plain silent-device row of the same device.
   */
  silentParticipants?: readonly SilentParticipant[];
  /** Closed shifts the host marked as closed without the reason (plan 2b). */
  reasonMissing?: readonly ReasonMissingShift[];
```

(f) `attentionItems`: before the `if (input.devices !== null)` block (`:336`) add `const covered = new Set((input.silentParticipants ?? []).map((each) => each.deviceId));` and extend the filter (`:338`):

```ts
      .filter(
        (device) =>
          device.revokedAt === null && !isOnline(device, input.nowMs) && !covered.has(device.id),
      )
```

After the devices block (`:372`) add:

```ts
for (const each of input.silentParticipants ?? []) {
  const span = formatDuration(input.nowMs - Date.parse(each.since));
  items.push({
    id: `participant-${each.shiftId}-${each.deviceId}`,
    kind: "participant_silent",
    severity: "warn",
    titleKey: "office.overview.attention.participant.title",
    titleValues: { name: each.name, unit: span.unit, count: span.count },
    detailKey: "office.overview.attention.participant.detail",
    detailValues: { shift: each.shiftNumber, line: each.lineName },
    to: `/shifts?shift=${encodeURIComponent(each.shiftId)}&tab=stations`,
    actionKey: "office.overview.attention.participant.action",
  });
}
for (const each of input.reasonMissing ?? []) {
  items.push({
    id: `close-reason-${each.shiftId}`,
    kind: "close_reason_missing",
    severity: "warn",
    titleKey: "office.overview.attention.closeReason.title",
    titleValues: { number: each.number },
    detailKey: "office.overview.attention.closeReason.detail",
    detailValues: {},
    to: `/shifts?shift=${encodeURIComponent(each.shiftId)}`,
    actionKey: "office.overview.attention.closeReason.action",
  });
}
```

Update the doc comment of `attentionItems` (`:310-314`) by adding «, a participant of a shared shift silent for ten minutes, a shift closed without its reason» to the list of what needs a person.

- [ ] **Step 5: Run the model test.**
      Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/overview-multi-station.test.ts test/overview-dashboard-model.test.ts`
      Expected: PASS (the old suite builds `AttentionInput` without the new optional fields and `LineCard` is only read with `toMatchObject`).

- [ ] **Step 6: Write the failing page test** `apps/standalone/test/overview-multi-station.test.tsx`:

```tsx
import { fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DeviceRecord, OfficeLine, OfficeShift } from "../src/host/protocol.js";
import { backupCopy, HEALTHY_BACKUPS } from "./support/backups.js";
import {
  fakeOfficeSession,
  ORG_PROFILE,
  renderOffice,
  type FakeOfficeSession,
} from "./support/office.js";
import {
  LINE_10,
  LINE_2,
  MILK,
  participant,
  PARTICIPANT_B,
  SHARED,
  SHARED_NO_REASON,
  STATION_ID,
} from "./support/shifts.js";

const NOW = new Date("2026-10-10T09:00:00.000Z");
const MIN = 60_000;
const agoIso = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const THREE: OfficeLine = { ...LINE_2, maxStations: 3 };

/** Line 2 allows three devices; two work its shift, the station not heard for 19 minutes. */
const RUNNING: OfficeShift = {
  ...SHARED,
  id: "11111111-1111-4111-8111-111111111111",
  number: "OCT26-004",
  productId: MILK.id,
  plannedDate: "2026-10-10",
  openedAt: agoIso(8 * 60 * MIN),
  totals: { ...SHARED.totals, lastFactAt: agoIso(2 * MIN) },
  participants: [
    participant({ lastSeenAt: agoIso(19 * MIN) }),
    { ...PARTICIPANT_B, lastSeenAt: agoIso(3 * MIN) },
  ],
};
/** Yesterday's shared shift, closed by its last device without the reason. */
const NO_REASON: OfficeShift = {
  ...SHARED_NO_REASON,
  id: "33333333-3333-4333-8333-333333333333",
  number: "OCT26-003",
  plannedDate: "2026-10-09",
  closedAt: agoIso(20 * 60 * MIN),
};
const STATION: DeviceRecord = {
  id: STATION_ID,
  kind: "station",
  name: "Станция линии 1",
  lineId: THREE.id,
  appVersion: "1.1.0",
  pairedAt: "2026-09-26T09:15:00Z",
  lastSeenAt: agoIso(19 * MIN),
  revokedAt: null,
};

function overviewSession(): FakeOfficeSession {
  const session = fakeOfficeSession();
  session.api.getOrg.mockResolvedValue(ORG_PROFILE);
  session.api.listShifts.mockResolvedValue([RUNNING, NO_REASON]);
  // «Указать» leads to the shift's card, which reads the shift.
  session.api.getShift.mockResolvedValue(NO_REASON);
  session.api.listProducts.mockResolvedValue([MILK]);
  session.api.listLines.mockResolvedValue([THREE, LINE_10]);
  session.api.listConflicts.mockResolvedValue({ items: [], page: 1, pageCount: 1, total: 0 });
  session.api.listDevices.mockResolvedValue([STATION]);
  session.api.getBackups.mockResolvedValue({
    ...HEALTHY_BACKUPS,
    now: NOW.toISOString(),
    local: { ...HEALTHY_BACKUPS.local, copies: [backupCopy(agoIso(3 * 60 * MIN))] },
    second: { ...HEALTHY_BACKUPS.local, copies: [backupCopy(agoIso(3 * 60 * MIN))] },
  });
  session.api.getHostNetwork.mockResolvedValue({
    addresses: [
      { address: "10.0.0.5", mode: "static", mac: "AA-BB-CC-DD-EE-FF", alias: "Ethernet" },
    ],
    port: 45710,
    confirmedAt: null,
  });
  return session;
}

describe("«Обзор» with several devices on a line (plan 2b)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    window.innerWidth = 1440;
  });
  afterEach(() => {
    vi.useRealTimers();
    window.innerWidth = 1024;
  });

  it("says on a line's card how many of its devices are at work, and says nothing on a line of one", async () => {
    renderOffice(overviewSession());
    const lines = await screen.findByRole("region", { name: "Линии" });
    const card = await within(lines).findByRole("article", { name: "Линия 2" });
    expect(within(card).getByText("станций в смене: 2 из 3")).toBeTruthy();
    expect(within(lines).getAllByText(/станций в смене/)).toHaveLength(1);
  });

  it("lists the silent participant once, with its shift and line, in the warn tone, and not again as a silent device", async () => {
    renderOffice(overviewSession());
    const attention = await screen.findByRole("region", { name: "Требует внимания" });
    const title = await within(attention).findByText("Станция линии 1: нет связи 19 мин");
    const row = title.closest("li") as HTMLElement;
    expect(row.className).toContain("ov-attn__row--warn");
    expect(within(row).getByText("Смена OCT26-004, линия «Линия 2»")).toBeTruthy();
    expect(within(attention).getAllByText(/Станция линии 1: нет связи/)).toHaveLength(1);
  });

  it("asks for the reason of a shift closed without one, and goes to its card", async () => {
    renderOffice(overviewSession());
    const attention = await screen.findByRole("region", { name: "Требует внимания" });
    const row = (await within(attention).findByText("Смена OCT26-003 закрыта без причины")).closest(
      "li",
    ) as HTMLElement;
    expect(
      within(row).getByText("Устройства не назвали причину расхождения с планом"),
    ).toBeTruthy();
    fireEvent.click(within(row).getByRole("button", { name: /Указать/ }));
    expect(await screen.findByRole("heading", { name: "Смены", level: 1 })).toBeTruthy();
    expect(await screen.findByRole("dialog", { name: "Смена OCT26-003" })).toBeTruthy();
  });
});
```

- [ ] **Step 7: Run it to verify it fails.**
      Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/overview-multi-station.test.tsx`
      Expected: FAIL (no «станций в смене», no participant row).

- [ ] **Step 8: The card, the CSS and the page.**

`LineCards.tsx` — after the idle/pace ternary (the `)}` that closes it at `:168`, before `</article>`):

```tsx
{
  card.stations !== null && (
    <p className="ov-line__stations">
      <Glyph name="users" size={16} />
      <span>
        {t("office.overview.lines.stations", {
          active: card.stations.active,
          max: card.stations.max,
        })}
      </span>
    </p>
  );
}
```

`overview.css` — after the `.ov-line__idle` rule (`:570-575`):

```css
/* «станций в смене: N из M» of a line of several devices: an icon and a sentence, wrapping by words. */
.ov-line__stations {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  color: var(--fg-2);
  font: var(--text-meta);
  white-space: normal;
}
```

`OfficeOverview.tsx` — extend the import of `./overview/overview-model.js` (`:28`) to `import { deviceSummary, reasonMissingShifts, silentParticipants } from "./overview/overview-model.js";` and in the `attentionItems({...})` call after `idleLines: …,` (`:100-104`) add:

```tsx
    silentParticipants: silentParticipants(shifts, data.lines.data ?? [], nowMs),
    reasonMissing: reasonMissingShifts(shifts),
```

- [ ] **Step 9: Run both overview suites and the typecheck.**
      Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/overview-multi-station.test.tsx test/overview-multi-station.test.ts test/office-overview.test.tsx test/overview-dashboard-model.test.ts test/overview-layout.test.ts` then `… typecheck`, `… lint`.
      Expected: PASS.

- [ ] **Step 10: Format and commit.**
      Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false exec prettier --write apps/standalone/src/office/overview/overview-model.ts apps/standalone/src/office/overview/dashboard-model.ts apps/standalone/src/office/overview/LineCards.tsx apps/standalone/src/office/overview/overview.css apps/standalone/src/office/OfficeOverview.tsx apps/standalone/test/overview-multi-station.test.ts apps/standalone/test/overview-multi-station.test.tsx`

```bash
git -C "$WT" add apps/standalone/src/office/overview apps/standalone/src/office/OfficeOverview.tsx \
  apps/standalone/test/overview-multi-station.test.ts apps/standalone/test/overview-multi-station.test.tsx
git -C "$WT" commit -m "feat(standalone): «Обзор» — devices at work on a line, a silent participant, a shift without its reason (plan 2b)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Exports with several devices — verification test

The export source is keyed by `shift_id` and holds no device column (`ShiftExportRows` boxes, items, pallets, codes), so a shared shift needs no change in the office. The host plan fixes the operation date (D16 as implemented, `9a9d5b578`: `stationClosedAt` is the LATEST of the shift's accepted device close instants, whatever order they arrived in; `null` for an office-closed shift). This task pins what the office does with such rows, so a later change cannot break it unseen. No source file changes.

**Files:**

- Test: `apps/standalone/test/export-multi-station.test.ts` (new)

**Interfaces:**

- Consumes: `shiftExportSnapshot(rows, format, formedAt)`, `shiftOperationDateTime(shift, formedAt)` (`src/office/exports/export-source.ts`), `shiftExportRowsSchema` (`src/host/protocol.ts`).
- Produces: nothing for later tasks.

- [ ] **Step 1: Write the test** `apps/standalone/test/export-multi-station.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { shiftExportRowsSchema, type ShiftExportRows } from "../src/host/protocol.js";
import {
  shiftExportSnapshot,
  shiftOperationDateTime,
} from "../src/office/exports/export-source.js";

/**
 * A shift two stations worked (plan 2b, spec §7 «Экспорты … проверить формат при нескольких
 * устройствах»): the rows carry no device, codes of both stations interleave by their scan instants, each
 * station's boxes are its own, and the document's operation time is the latest device close the host
 * reports (host D16 as implemented: the MAX of the accepted close instants), never an early part's.
 */

const FORMED_AT = "2026-10-08T15:30:00.123Z";
const SHIFT_ID = "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b";
const FLAT_TXT = { boxMode: "flat", extension: "txt" } as const;
const BOXES_TXT = { boxMode: "boxes", extension: "txt" } as const;
const day = (time: string): string => `2026-10-08T${time}Z`;
const hash = (n: number): string => n.toString(16).padStart(64, "0");
const sscc = (n: number): string => `04600682000001${String(n).padStart(4, "0")}`;
const boxId = (n: number): string => `b0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/**
 * Station A scanned KM-1 and KM-3 into box 1, station B KM-2 and KM-4 into box 2, one second apart in turn;
 * the latest device close is station B's, at 14:10:00.250 by its own clock (the host's whole second is
 * 14:10:07), which the host reports whichever close reached it last.
 */
function sharedRows(shift: Partial<ShiftExportRows["shift"]> = {}): ShiftExportRows {
  const scanned = ["06:00:00.000", "06:00:01.000", "06:00:02.000", "06:00:03.000"];
  return shiftExportRowsSchema.parse({
    shift: {
      id: SHIFT_ID,
      number: "OCT26-004",
      status: "closed",
      productionDate: "2026-10-08",
      productName: "Молоко",
      palletsEnabled: false,
      closedAt: day("14:10:07"),
      stationClosedAt: "2026-10-08T14:10:00.250Z",
      lateDataAt: null,
      ...shift,
    },
    organization: { name: "ООО «Атолл»", inn: "7701234567" },
    codes: scanned.map((time, index) => ({
      codeHash: hash(index + 1),
      scannedAt: day(time),
      canonical: `KM-${String(index + 1)}`,
    })),
    boxes: [1, 2].map((n) => ({
      id: boxId(n),
      sscc: sscc(n),
      openedAt: day("06:00:00.000"),
      closedAt: day(`06:0${String(n)}:00.000`),
      disassembledAt: null,
      palletId: null,
    })),
    items: [
      { boxId: boxId(1), codeHash: hash(1) },
      { boxId: boxId(2), codeHash: hash(2) },
      { boxId: boxId(1), codeHash: hash(3) },
      { boxId: boxId(2), codeHash: hash(4) },
    ],
    pallets: [],
  });
}

function snapshotOf(rows: ShiftExportRows, format: typeof FLAT_TXT | typeof BOXES_TXT) {
  const snapshot = shiftExportSnapshot(rows, format, FORMED_AT);
  if (!snapshot.ok) throw new Error(snapshot.refusal);
  return snapshot.value;
}

describe("the export of a shift two devices worked (plan 2b)", () => {
  it("orders the codes of both devices by their scan instants in the flat formats", () => {
    expect(snapshotOf(sharedRows(), FLAT_TXT).source).toEqual({
      mode: "flat",
      codes: ["KM-1", "KM-2", "KM-3", "KM-4"],
    });
  });

  it("lists each device's boxes by SSCC, each with its own codes in scan order", () => {
    expect(snapshotOf(sharedRows(), BOXES_TXT).source).toEqual({
      mode: "boxes",
      boxes: [
        { sscc: sscc(1), codes: ["KM-1", "KM-3"] },
        { sscc: sscc(2), codes: ["KM-2", "KM-4"] },
      ],
    });
  });

  it("takes the operation time from the latest device close the host reports", () => {
    expect(snapshotOf(sharedRows(), FLAT_TXT).operationDateTime).toBe("2026-10-08T14:10:00.250Z");
  });

  it("takes the host's own instant for a shift the office closed whole, which has no device close", () => {
    const rows = sharedRows({ stationClosedAt: null });
    expect(shiftOperationDateTime(rows.shift, FORMED_AT)).toBe("2026-10-08T14:10:07.000Z");
    expect(snapshotOf(rows, FLAT_TXT).operationDateTime).toBe("2026-10-08T14:10:07.000Z");
  });

  it("refuses a shift that is not closed, as before", () => {
    const snapshot = shiftExportSnapshot(
      sharedRows({ status: "active", closedAt: null }),
      FLAT_TXT,
      FORMED_AT,
    );
    expect(snapshot).toEqual({ ok: false, refusal: "SHIFT_NOT_CLOSED" });
  });
});
```

- [ ] **Step 2: Run it.**
      Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/export-multi-station.test.ts test/export-source-rules.test.ts test/export-source.test.ts test/export-parity.test.ts`
      Expected: PASS at once: this is a characterization of existing behaviour, not new behaviour, so there is no failing step. If it fails, the failure is a finding: stop and report which assumption (scan-order, box order, operation instant) differs from the host plan's D16 (as amended) before changing any source.

- [ ] **Step 3: Check the formats against several devices in the ЧЗ dialog.** Run `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/export-dialog.test.tsx test/export-checks.test.ts test/export-plan.test.ts`. Expected: PASS (they do not read `participants`). This is the whole of the verification the spec asks for in the office; a real export of a shared shift is a Windows/host check listed in Task 14.

- [ ] **Step 4: Format and commit.**
      Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false exec prettier --write apps/standalone/test/export-multi-station.test.ts`

```bash
git -C "$WT" add apps/standalone/test/export-multi-station.test.ts
git -C "$WT" commit -m "test(standalone): export source of a shift two devices worked (plan 2b)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 12: The blank's closing rule — `closingRule`, fixtures, parity

**Files:**

- Modify: `packages/domain/src/print-forms/shift-task-form.ts:51-52` (`ShiftTaskFormData`), `:204` (the rule)
- Modify: `apps/standalone/src/office/forms/form-data.ts:186-231` (`taskFormData`, doc and field)
- Modify (existing tests, product decision O9): `apps/standalone/test/form-data-rules.test.ts:316-340`, `apps/standalone/test/forms-parity.test.ts:136-150`, `:237`, `:286`
- Test: `packages/domain/test/shift-task-form.test.ts` (two `it`s at the end of the first `describe`, before the `});` at `:242`), `packages/domain/test/print-forms-snapshot.test.ts` (two `it`s after `:176-180`, before the `});` at `:181`)
- Create (generated by the snapshot test, reviewed): `packages/domain/test/fixtures/print-forms/shift-task-form-aggregation-each-part.html`, `…/shift-task-form-validation-each-part.html`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces: `ShiftTaskFormData.closingRule?: "opener" | "each_part"` (left out = `"opener"`, the cloud's bytes); the standalone's `taskFormData` returns `closingRule: "each_part"`.

**Consequences, in full (spec §7 said «меняются эталонные фикстуры … и хеши аттестации»):**

1. The cloud's golden parity (`packages/domain/test/fixtures/print-forms-parity/golden.json`, written by the cloud's own controller in `apps/api/test/standalone-forms-parity.test.ts`) does not change: the renderer's default bytes are unchanged. The cloud's rule is true there (`stationClosePolicy` `single_device` | `admin_only`, `apps/api/src/modules/shifts/shifts.service.ts:140`), so changing its sentence would be wrong, not just wide.
2. `packages/domain/test/fixtures/print-forms/shift-task-form-{aggregation,validation}.html` do not change; two new fixtures pin the new variant.
3. `apps/standalone/test/forms-parity.test.ts` compares the office's bytes with the cloud's golden: it now declares the one sentence they differ by (an exact single replacement; sha256 of the replaced bytes).
4. Production attestation: `deploy/production/legal-artifacts-attestation.json` and `verify-legal-artifacts.mjs` pin the legal documents only; no file under `deploy`, `tools`, `.github` or `packages/legal-documents` names a print form (searched with `grep -rIn "shift-task\|print-form\|Бланк смены"`: none). `pnpm test:production-bundle:contract` is run to prove it, and nothing is regenerated.
5. CI: a change of `packages/domain` makes the affected-consumer jobs run (`tools/ci/affected.mjs`): api, admin, kiosk, station, standalone. `@markiro/domain` is consumed through its `dist`: rebuild it before any consumer test (`turbo run build --filter=@markiro/domain`).

- [ ] **Step 1: Write the failing domain tests.** Insert at the end of `describe("renderShiftTaskFormHtml", …)` of `packages/domain/test/shift-task-form.test.ts`, just before the `});` that closes it (`:242`, above `describe("the blank's header logo", …)`):

```ts
it("prints the cloud's closing rule unless the form says each device closes its part", () => {
  const cloud = renderShiftTaskFormHtml(fixture());
  expect(cloud).toContain(
    "<li>Смену закрывает станция, которая её открыла. Вторая станция — только через админку.</li>",
  );
  expect(renderShiftTaskFormHtml(fixture({ closingRule: "opener" }))).toBe(cloud);
});

it("prints «каждая станция закрывает свою часть» for the autonomous product, and no other line changes", () => {
  const cloud = renderShiftTaskFormHtml(fixture());
  const each = renderShiftTaskFormHtml(fixture({ closingRule: "each_part" }));
  const old =
    "<li>Смену закрывает станция, которая её открыла. Вторая станция — только через админку.</li>";
  const next =
    "<li>Каждая станция закрывает свою часть; смена закрывается, когда закрыли все, или из офиса.</li>";
  expect(each).toContain(next);
  expect(each).not.toContain("Вторая станция");
  expect(each).toBe(cloud.replace(old, next));
  // The pause rule that follows it is kept.
  expect(each).toContain(
    "Чтобы поставить работу на паузу, выйдите из смены: она останется активной.",
  );
});
```

and in `packages/domain/test/print-forms-snapshot.test.ts`, after the existing `it("validation shift task form with a duplicate Data Matrix", …)` (`:176-180`) and before the `});` of «printable forms characterisation lock» (`:181`), add (the constants `TASK` and `VALIDATION_TASK` are the file's own):

```ts
it("freezes the shift blank of the autonomous product, where each device closes its part (aggregation)", async () => {
  await expect(renderShiftTaskFormHtml({ ...TASK, closingRule: "each_part" })).toMatchFileSnapshot(
    "fixtures/print-forms/shift-task-form-aggregation-each-part.html",
  );
});

it("freezes the shift blank of the autonomous product, where each device closes its part (validation)", async () => {
  await expect(
    renderShiftTaskFormHtml({ ...VALIDATION_TASK, closingRule: "each_part" }),
  ).toMatchFileSnapshot("fixtures/print-forms/shift-task-form-validation-each-part.html");
});
```

- [ ] **Step 2: Run them to verify they fail.**
      Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/domain exec vitest run test/shift-task-form.test.ts test/print-forms-snapshot.test.ts`
      Expected: FAIL (`closingRule` is not a property of `ShiftTaskFormData`; the sentence is not printed).

- [ ] **Step 3: Implement in the domain.** In `packages/domain/src/print-forms/shift-task-form.ts`, after `allowPreviouslyAcceptedCodes: boolean;` (`:51`) add:

```ts
  /**
   * Who closes the shift, for the rule printed on the blank. `"opener"` (left out): the station that
   * opened it, a second one only through the admin — the cloud's rule (`stationClosePolicy`).
   * `"each_part"`: «Markiro Автоном» with several devices in one shift — each closes its own part and
   * the shift closes with the last, or from the office. The renderer is shared with the cloud, so the
   * default keeps every byte of the cloud's blank.
   */
  closingRule?: "opener" | "each_part";
```

Replace the rule line (`:204`):

```ts
    data.closingRule === "each_part"
      ? "<li>Каждая станция закрывает свою часть; смена закрывается, когда закрыли все, или из офиса.</li>"
      : "<li>Смену закрывает станция, которая её открыла. Вторая станция — только через админку.</li>",
```

- [ ] **Step 4: Generate the two fixtures and review them.**
      Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/domain exec vitest run -u test/print-forms-snapshot.test.ts`
      Then prove that only the rule differs from the existing fixtures:
      `diff "$WT/packages/domain/test/fixtures/print-forms/shift-task-form-aggregation.html" "$WT/packages/domain/test/fixtures/print-forms/shift-task-form-aggregation-each-part.html"` and the same for `validation`. Expected: each diff shows exactly one changed line (the `<li>` of the rule inside the `rules` list, line 114). Also `git -C "$WT" status --short packages/domain/test/fixtures`: only the two new files are untracked, no existing fixture is modified.

- [ ] **Step 5: Run the domain package and rebuild it.**
      Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/domain test` then `… typecheck`, `… lint`, `… build`. Expected: PASS.

- [ ] **Step 6: Write the failing standalone changes' tests.** In `apps/standalone/test/form-data-rules.test.ts`, the first test of «the blank's data» (`:316-340`) lists every field with `toEqual`: add `closingRule: "each_part",` after `allowPreviouslyAcceptedCodes: false,` (`:338`). In `apps/standalone/test/forms-parity.test.ts`:

(a) add above `describe("printed forms parity with the cloud (plan О-Ф)"` (`:130`):

```ts
/**
 * The one difference between the cloud's blank and the office's (plan 2b): the rule on closing a shift.
 * The cloud's golden says «Смену закрывает станция, которая её открыла…»; the autonomous product, where
 * several devices work one shift, says each device closes its part. Every other byte is the cloud's.
 */
const CLOUD_RULE =
  "<li>Смену закрывает станция, которая её открыла. Вторая станция — только через админку.</li>";
const AUTONOMOUS_RULE =
  "<li>Каждая станция закрывает свою часть; смена закрывается, когда закрыли все, или из офиса.</li>";

/** The bytes the office draws for a case whose cloud bytes are `html`: only a blank differs, by that one sentence. */
function officeBytes(form: ParityCase["form"], html: string): string {
  if (form !== "task") return html;
  expect(html.split(CLOUD_RULE)).toHaveLength(2);
  return html.replace(CLOUD_RULE, AUTONOMOUS_RULE);
}

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
```

(b) replace the body of the first parity `it.each` (`:136-150`):

```ts
    (name, parityCase) => {
      const drawn = renderForm(requestOf(parityCase));
      const expected = golden[name];
      expect(drawn?.kind).toBe(parityCase.form);
      const bytes = officeBytes(parityCase.form, expected?.html ?? "");
      expect(drawn?.html).toBe(bytes);
      expect(sha256(drawn?.html ?? "")).toBe(
        parityCase.form === "task" ? sha256(bytes) : expected?.sha256,
      );
    },
```

and add after that `it.each`, inside the same `describe`:

```ts
it("leaves the cloud's own golden alone: every blank in it still says the cloud's rule, once", () => {
  for (const [name, entry] of Object.entries(golden)) {
    if (cases.find((each) => each.name === name)?.form !== "task") continue;
    expect(entry.html.split(CLOUD_RULE), name).toHaveLength(2);
    expect(entry.html, name).not.toContain("Каждая станция закрывает свою часть");
  }
});
```

(c) at `:237` and `:286` (both are `const expected = renderShiftTaskFormHtml(cloudData);`) replace with `const expected = renderShiftTaskFormHtml({ ...cloudData, closingRule: "each_part" });` — in both places: the office draws the same blank as the cloud's renderer given the autonomous rule.

- [ ] **Step 7: Run them to verify they fail.**
      Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/form-data-rules.test.ts test/forms-parity.test.ts`
      Expected: FAIL (`taskFormData` returns no `closingRule`; the office's blank still says the cloud's rule).

- [ ] **Step 8: Implement in the office.** `apps/standalone/src/office/forms/form-data.ts` — in `taskFormData` (`:194-231`) add `closingRule: "each_part",` after `allowPreviouslyAcceptedCodes: false,` and add to the function's doc comment (`:188-195`) the sentence: «The blank's closing rule is the autonomous product's own (`closingRule: "each_part"`): the cloud's renderer is shared, and says the opener closes.»

- [ ] **Step 9: Run the standalone forms suites and the cloud's parity.**
      Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false turbo run build --filter=@markiro/domain` then
      `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/form-data-rules.test.ts test/form-data.test.ts test/forms-parity.test.ts test/print-form-dialog.test.tsx test/print-form.test.ts test/prepare-form.test.ts` and
      `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/api exec vitest run test/standalone-forms-parity.test.ts`.
      Expected: PASS everywhere, and the cloud's parity test passes without regenerating its golden (`FORMS_PARITY_WRITE` is not set: a change of the cloud's bytes would fail here).

- [ ] **Step 10: The production gate.**
      Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false test:production-bundle:contract`. Expected: PASS with `deploy/production/legal-artifacts-attestation.json` untouched (`git -C "$WT" status --short deploy` shows nothing). If it fails, the failure is not about this change (the attestation pins legal PDFs); report it, do not edit the attestation.

- [ ] **Step 11: Format and commit.**
      Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false exec prettier --write packages/domain/src/print-forms/shift-task-form.ts packages/domain/test/shift-task-form.test.ts packages/domain/test/print-forms-snapshot.test.ts apps/standalone/src/office/forms/form-data.ts apps/standalone/test/form-data-rules.test.ts apps/standalone/test/forms-parity.test.ts` (the `fixtures/print-forms/` folder is in `.prettierignore` and `.gitattributes` keeps it out of whitespace checks: never format it).

```bash
git -C "$WT" add packages/domain/src/print-forms/shift-task-form.ts packages/domain/test/shift-task-form.test.ts \
  packages/domain/test/print-forms-snapshot.test.ts \
  packages/domain/test/fixtures/print-forms/shift-task-form-aggregation-each-part.html \
  packages/domain/test/fixtures/print-forms/shift-task-form-validation-each-part.html \
  apps/standalone/src/office/forms/form-data.ts apps/standalone/test/form-data-rules.test.ts \
  apps/standalone/test/forms-parity.test.ts
git -C "$WT" commit -m "feat(domain): the shift blank's closing rule for the autonomous product — each device closes its part (plan 2b)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Layout contract of the new rows and the short window

The office is CSS that jsdom does not compute. This task adds the two small rules the previous tasks named (`shift-breakdown__title`, defined here so it is reviewed with its test), pins them and the column budget of the lists with a contract test, and writes down the browser measurement that no automated check here can make (there is no office browser harness; `station-fit.browser.test.ts` measures the station floor only).

**Files:**

- Modify: `apps/standalone/src/app/shell.css` (after `.shift-note--error`, `:1314-1316`)
- Test: `apps/standalone/test/multi-station-layout.test.ts` (new)

**Interfaces:**

- Consumes: Task 6 (`shift-breakdown__title` class), Task 10 (`ov-line__stations` class and its rule in `overview.css`), `test/support/css-rules.ts` (`cssRules`, `CssRule`), `test/support/shifts.ts` (`openShifts`, `shiftsSession`, `SHARED`).
- Produces: nothing for later tasks.

- [ ] **Step 1: Write the failing test** `apps/standalone/test/multi-station-layout.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { cssRules, type CssRule } from "./support/css-rules.js";
import { openShifts, SHARED, shiftsSession } from "./support/shifts.js";

/**
 * The layout contract of what plan 2b adds to the office (design kit §3, §7): one layer, tokens only,
 * state by icon and text, no new column in the lists that are already at their limit at 1280 px. The
 * look at 1280 x 690 and 1280 x 800, dark and light, is a browser check (the plan's last task lists it).
 */
const shell = cssRules(readFileSync(join(__dirname, "../src/app/shell.css"), "utf8"));
const overview = cssRules(
  readFileSync(join(__dirname, "../src/office/overview/overview.css"), "utf8"),
);

const DENSE = "@media (max-height: 799px), (max-width: 1365px)";

/** The declarations of the rules listing `selector`; `inside` is the at-rule they sit in, `null` for none. */
function declarations(rules: readonly CssRule[], selector: string, inside: string | null): string {
  const found = rules.filter(
    (rule) =>
      rule.selector.split(",").some((each) => each.trim() === selector) &&
      (inside === null ? rule.within.length === 0 : rule.within[0] === inside),
  );
  if (found.length === 0) throw new Error(`no rule for ${selector}`);
  return found.map((rule) => rule.body).join("\n");
}

const LITERAL_COLOUR = /#[0-9a-fA-F]{3,8}\b|\b(?:rgb|rgba|hsl|hsla)\(/;

describe("the multi-station office's own rules", () => {
  it("titles a shift's per-device figures quietly, in the kit's tokens", () => {
    const title = declarations(shell, ".shift-breakdown__title", null);
    expect(title).toContain("font: var(--text-body-sm)");
    expect(title).toContain("color: var(--fg-2)");
    expect(title).toContain("font-weight: 600");
  });

  it("draws a line card's stations as one icon-and-text row that wraps by words", () => {
    const stations = declarations(overview, ".ov-line__stations", null);
    expect(stations).toContain("display: inline-flex");
    expect(stations).toContain("align-items: center");
    expect(stations).toContain("color: var(--fg-2)");
    expect(stations).toContain("font: var(--text-meta)");
    expect(stations).toContain("white-space: normal");
  });

  it("adds no colour literal, gradient, shadow or animation", () => {
    for (const body of [
      declarations(shell, ".shift-breakdown__title", null),
      declarations(overview, ".ov-line__stations", null),
    ]) {
      expect(body).not.toMatch(LITERAL_COLOUR);
      expect(body).not.toMatch(/gradient\(|box-shadow|animation|transition/);
    }
  });

  it("keeps the line cards' dense spacing, so the extra row costs one line and a 4 px gap in a low window", () => {
    const dense = declarations(overview, ".ov-line", DENSE);
    expect(dense).toContain("gap: var(--sp-1)");
    expect(dense).toContain("padding: var(--sp-3) var(--sp-4)");
  });
});

describe("the column budget of the lists at 1280 px (plan 2b adds none)", () => {
  it("keeps the shift list at its seven columns: the participants are one quiet line in the status cell", async () => {
    await openShifts(shiftsSession([SHARED]));
    expect(screen.getAllByRole("columnheader")).toHaveLength(7);
  });
});
```

(The device list's eight columns and the participants table's five are pinned by `devices-presence.test.tsx` and `shift-participants.test.tsx`.)

- [ ] **Step 2: Run it to verify it fails.**
      Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/multi-station-layout.test.ts`
      Expected: FAIL (`no rule for .shift-breakdown__title`; the `.ov-line__stations` assertions pass since Task 10 added that rule, the dense and column ones pass too).

- [ ] **Step 3: Add the rule.** In `apps/standalone/src/app/shell.css`, after `.shift-note--error { … }` (`:1314-1316`):

```css
/* «По устройствам» under a shift's figures (plan 2b): a quiet title over the devices' own definition list. */
.shift-breakdown__title {
  margin: 16px 0 8px;
  color: var(--fg-2);
  font: var(--text-body-sm);
  font-weight: 600;
}
```

- [ ] **Step 4: Run it, and the neighbouring layout contracts.**
      Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/multi-station-layout.test.ts test/office-layout.test.ts test/office-list-layout.test.ts test/overview-layout.test.ts test/shift-totals-by-device.test.tsx`
      Expected: PASS.

- [ ] **Step 5: Format and commit.**
      Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false exec prettier --write apps/standalone/src/app/shell.css apps/standalone/test/multi-station-layout.test.ts`

```bash
git -C "$WT" add apps/standalone/src/app/shell.css apps/standalone/test/multi-station-layout.test.ts
git -C "$WT" commit -m "test(standalone): layout contract of the multi-station office rows (plan 2b)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: The browser measurement (not automatable here; do it on a Windows PC or a Chromium over the built app, and record the result in the report).** With the host from the host plan and a site holding a line with `maxStations 3` and a shift two devices work, at 1280 × 690, 1280 × 800 and 960 × 600, dark and light:
  - «Смены»: the status cell with the new line and the «Причина не указана» tag wraps by words, no row grows past the viewport, «Действия» stays in view (it is `stickyEnd`), the table scrolls inside its card.
  - The card, tab «Станции»: five columns (six with pallets) inside the drawer, scroll inside the table region, the state cell of a closed part (up to five short lines) keeps the row readable, the «Нет связи» tag has its word and glyph.
  - «Итоги» dialog and the card's «Итоги»: «По устройствам» with two to six devices does not push the buttons out of the dialog.
  - «Устройства»: the chip under the line name does not push «Доступ» or the actions out of the 1280 px window (the table already wraps «(при подключении)»).
  - «Обзор» at 1280 × 690: three line cards with the extra row, no page scroll that the previous build did not have, the attention list's three dense rows. If a scroll the previous build lacked appears, report the measured overflow in pixels and stop: the fix (hide the row in the dense layout, or move N/M into the card's head) is a design choice for the owner, not a refactor to improvise.
  - Keyboard: the tab «Станции», «Закрыть целиком» and «Указать причину» are reachable and show the 3 px focus ring.
    State plainly in the report that these are browser/Windows checks and were or were not performed.

---

### Task 14: Documentation, the whole-office gates and the checklist

**Files:**

- Modify: `apps/standalone/AGENTS.md` — the `stationShift` sentence in the «Устройства» bullet (`:3046-3047`), and a new subsection before «## License in the office and on the floor» (`:3596`)

**Interfaces:**

- Consumes: Tasks 1–13.
- Produces: the scoped guide the station, handheld and load plans read for the office's behaviour.

- [ ] **Step 1: Correct the one sentence that is no longer true.** In `apps/standalone/AGENTS.md`:

old:

```
  for a station only, finds the active shift the station opened
  (`stationShift`: `ownerDeviceId`), and once another line is chosen, an
```

new:

```
  for a station only, finds the active shift the station works
  (`stationShift`: an active participant, since plan 2b; `ownerDeviceId` only
  for a host before protocol 7), and once another line is chosen, an
```

- [ ] **Step 2: Add the subsection** immediately before `## License in the office and on the floor`:

```markdown
### Several devices in one shift (office, plan 2b)

- The office reads participation from `OfficeShift.participants`, `byDevice`
  and `closeReasonMissing` and from `OfficeLine.maxStations` (protocol 7). All
  are optional, so a host before it shows the office as it was: a shift with no
  participants has no «Станции» tab, no marks, no «целиком», and a line with no
  limit is a line of one. Every rule about participants lives in
  `src/office/shifts/participation.ts` (`isSharedShift`, `participantLook`,
  `isSilent`, `deviceWorksShift`, `presenceOf`); `ownerDeviceId` is only «who
  opened it» and is never used to find the shift a device works
  (`stationShift`, `installWarnings` use `deviceWorksShift`).
- «Линии»: an active line's «Переименовать» dialog also edits «Максимум станций
  в смене» (`maxStationsRule`, 1–16, `lineUpdate` sends it only when it
  differs from `lineMaxStations(line)`); adding and bringing a line back do not
  carry it. The form refuses a value below the busiest active shift's active
  participants as soon as the shifts are read (`activeStationsOnLine`), and
  maps the host's `conflict` `line_stations_in_use` `{ active }` to the same
  field. The list has a column «Макс. станций».
- «Смены»: the list gains no column. A shared shift's status cell adds one quiet
  line («Устройств: N, закрыли часть: K») and a shift closed without its reason
  the tag «Причина не указана» (`ShiftMarks`). The card gains the tab
  «Станции» (`ShiftStations`) when the shift names participants: device and
  kind, entry, state (a phase tag: working, silent, paused, part closed, closed
  from the office), the units, boxes and pallets of each device from `byDevice`.
  A participant is silent when it is `active` and the host last heard it more
  than ten minutes before this PC's «now». «Итоги» adds «По устройствам»
  (names from `participants`, so a technologist sees them).
- «Закрыть смену целиком» (row action, card button, dialog title and submit)
  replaces «Закрыть» for a shift with more than one participant; the dialog
  names `participants.filter(state != "closed")` («Не закрыли: …») from the
  loaded shift and sends the unchanged `{ reason, expectedRev }`: the host
  closes every open part as the office's and audits `shift.force_closed`; a
  preview older than the host's state ends as `stale_revision`.
- «Указать причину» (`planShifts`; row action and card button) is for a closed
  shift with `closeReasonMissing`: a select of the six
  `SHIFT_CLOSE_REASON_CODES` and `PUT …/close-reason`; a reason set meanwhile
  (`close_reason_not_missing`) is an alert in words of its own and a re-read of
  the list. «Обзор» lists such a shift under «Требует внимания».
- «Устройства»: the «Линия» cell carries a participation tag under the line's
  name (working, paused, part closed; `presenceOf`); the page reads the shifts
  for it and claims nothing when they do not load. No column was added.
- «Обзор»: a line's card says «станций в смене: N из M» only for a line whose
  limit is above one and whose shift names participants (N the active ones); a
  participant of such a line silent for ten minutes is one attention row and
  takes the place of the plain silent-device row of the same device; a shift
  closed without its reason is one row with the way to its card.
- The blank: `ShiftTaskFormData.closingRule` is `"each_part"` for the office
  («Каждая станция закрывает свою часть; смена закрывается, когда закрыли все,
  или из офиса.») and absent for the cloud, whose rule (the opener closes) is
  true there. The cloud's golden parity is untouched; the office's parity test
  declares that one sentence.
- Exports are keyed by `shift_id` and carry no device: nothing changed, pinned
  by `export-multi-station.test.ts` (codes of both devices in scan order, boxes
  by SSCC, the operation time is the latest device close the host reports).
```

- [ ] **Step 3: Format.**
      Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false exec prettier --check apps/standalone/AGENTS.md` — Expected: clean (`--write` on the file if the new lines need rewrapping).

- [ ] **Step 4: Commit the docs.**

```bash
git -C "$WT" add apps/standalone/AGENTS.md
git -C "$WT" commit -m "docs(standalone): several devices in one shift in the office (plan 2b)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 5: Final gates** (record each result in the report, with skips named):
  - `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false turbo run build --filter='@markiro/standalone^...'`
  - `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone test` (the whole Vitest project of the office, floor and host client), `… typecheck`, `… lint`
  - `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/domain test`, `… typecheck`, `… lint`, `… build`
  - `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/api exec vitest run test/standalone-forms-parity.test.ts` (the cloud's parity, golden untouched)
  - `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false test:production-bundle:contract` (nothing pins print forms; proves it)
  - `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false exec prettier --check` on every file this plan touched (the fixtures folder is ignored by design), `git -C "$WT" diff --check`, and `graphify update .` if `graphify-out/graph.json` exists in the worktree
  - `cargo` is not needed: this plan changes no Rust.

- [ ] **Step 6: The checklist** (tick each in the report):
  - [ ] The host plan's Tasks 2, 9, 10, 11 were on the branch before Task 1 (Step 0 passed).
  - [ ] A host before protocol 7 (fixtures `office-shift.json`, no `participants`) shows no tab «Станции», no «целиком», no marks, no «Макс. станций» other than 1, no new overview row: every pre-existing test passed unchanged except those named in the next item.
  - [ ] Pre-existing tests changed because a product decision changed, named in the report: `devices-page.test.tsx` (two: the page now reads the shifts), `form-data-rules.test.ts` (one: `closingRule`), `forms-parity.test.ts` (three places: the declared sentence), nothing else.
  - [ ] No new column in «Смены» (seven) or «Устройства» (eight); the participants table has five (six with pallets).
  - [ ] Every new state is a phase tag with glyph and word; no new colour literal, gradient, shadow or animation.
  - [ ] Every new text is in `ru.json` and pinned by `multi-station-strings.test.ts`; no Russian in a component.
  - [ ] No new request path other than `PUT …/close-reason`; every write sends the loaded `expectedRev`.
  - [ ] The cloud's golden parity passes untouched; `legal-artifacts-attestation.json` untouched.
  - [ ] Browser/Windows measurements of Task 13 Step 6 performed or listed as not performed; a real forced close and a real «Указать причину» against a running host with two stations and a handheld (the sibling plans' end-to-end) performed or listed as not performed.
  - [ ] Not verifiable here and stated as such: the Windows service and LAN with real devices, the office on a real Windows WebView2 at 1280 × 690, a real ЧЗ export of a shared shift.

---

## Self-Review

**1. Spec coverage** (spec §7, §4, §12 → tasks)

| Spec item                                                                                   | Where                                                                                                                               |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| §7 Линия: поле «Максимум станций» (по умолчанию 1)                                          | Task 4 (field in the dialog, column, default 1 for an older host)                                                                   |
| §7 Линия: уменьшение ниже числа активных участников отклоняется                             | Task 4 (client-side from `activeStationsOnLine`, the host's `line_stations_in_use` mapped)                                          |
| §7 Линия: аудит                                                                             | host (`line.max_stations_changed`); the office writes none; named in Task 14 docs                                                   |
| §7 Смена: таблица участников (устройство, вид, вошёл, состояние, принято, коробов, паллет)  | Task 5 (tab «Станции»; kind under the device name, pallets only when the shift has them)                                            |
| §7 Смена: итог по смене и разбивка по устройствам                                           | Tasks 5 (summary line), 6 («По устройствам»)                                                                                        |
| §7 «Закрыть смену целиком», «Не закрыли: …», обязательная причина                           | Task 7                                                                                                                              |
| §7/§12.9 состояние «причина не указана» и действие офиса                                    | Task 8 (action, dialog, `PUT close-reason`), Task 10 (attention)                                                                    |
| §7 Устройства: статус участия в смене                                                       | Task 9                                                                                                                              |
| §7 Обзор: «станций в смене: N из M»                                                         | Task 10 (deviation O6: only for a limit above one)                                                                                  |
| §7 Обзор: пункт внимания, если активный участник молчит > 10 мин                            | Task 10 (`silentParticipants`, `participant_silent`, de-duplicated with `device_silent`)                                            |
| §7 Бланк смены: новая формулировка, фикстуры, аттестация                                    | Task 12 (shared renderer → `closingRule`; no attestation pin exists: consequences listed)                                           |
| §7 Экспорты: проверить формат при нескольких устройствах                                    | Task 11 (characterization test; the operation-date fix is the host's D16)                                                           |
| §7 `src/host` (Zod, клиент, фикстуры)                                                       | Task 1 (client; Zod and fixtures are the host plan's Task 2 and 11, consumed)                                                       |
| §4.2 «Принудительное закрытие … предупреждение со списком незакрывших; причина обязательна» | Task 7                                                                                                                              |
| §4.2 «План и причина … у офиса при принудительном закрытии»                                 | Tasks 7 (reason stays mandatory), 8 (missing reason)                                                                                |
| §4.2 «Итоги станциям … asOf»                                                                | station plan (devices); the office reads `totals` of its own shift list                                                             |
| §4.3 при `max_stations = 1` поведение прежнее                                               | O2, O6; Tasks 5, 7, 9, 10 tests for «host before protocol 7» and «line of one»                                                      |
| §12.2 допущения одного устройства                                                           | office: `stationShift`, `installWarnings` (O8, Task 9); `owner_device_id` readers searched in `apps/standalone/src` (the two found) |
| §12.4 аудит `shift.enter`                                                                   | the host names it `shift.join` (host Task 6, 15); the office writes no audit and has no audit screen, see gap G12                   |
| §12.5 отзыв устройства-«открывшего»                                                         | host D3; the office shows `deviceWorksShift` by participation, never by owner                                                       |
| §12.6 таймаут `left`                                                                        | open (host D18): the office shows «На паузе» and offers the forced close                                                            |
| §12.7 ТСД — участник                                                                        | Tasks 5, 9 (kind shown, handheld presence), tests with a handheld                                                                   |
| §12.8 предел 16 и кто меняет                                                                | Task 4 (administrators only: `useCan("editReference")` unchanged; the rule is 1–16)                                                 |
| §12.9 офлайн-станция закрывает без причины, запрос в офисе                                  | Tasks 8, 10                                                                                                                         |
| Global: i18n RU, role visibility, layout 1280×690                                           | Tasks 2, 4–10 (`useCan`), 13                                                                                                        |

**2. Placeholder scan.** Searched the plan for «TBD», «TODO», «implement later», «fill in», «similar to», «add appropriate», «handle edge cases»: none. Every code step carries code. The `ru.json` edits are exact old/new strings with anchors checked unique when written; Task 5's expected cell strings are derived from the components' text and the host plan's fixtures, and the step says to correct a string only after confirming the words are the same.

**3. Type consistency.** `participantsOf`, `isSharedShift`, `activeParticipants`, `notClosedParticipants`, `closedParticipants`, `isSilent`, `lastSign`, `participantLook`, `LOOK_PHASE`, `deviceWorksShift`, `presenceOf`/`Presence` (Task 3) are used with the same names in Tasks 4 (`activeParticipants`), 5 (`participantsOf`, `closedParticipants`, `participantLook`, `LOOK_PHASE`), 7 (`isSharedShift`, `notClosedParticipants`), 9 (`presenceOf`, `deviceWorksShift`), 10 (`participantsOf`, `activeParticipants`, `isSilent`, `lastSign`). `lineMaxStations`, `lineUpdate(line, { name, archived, maxStations? })`, `shiftCloseReasonSet`, `HostApi.setShiftCloseReason` (Task 1) match Tasks 4, 8, 10. `lineFieldsSchema(inUse)`, `LineFields`, `activeStationsOnLine`, `stationsInUse`, `STATIONS_IN_USE` (Task 4) match `LineDialog`. `SilentParticipant`, `ReasonMissingShift`, `silentParticipants`, `reasonMissingShifts`, `LineCard.stations` (Task 10) match `OfficeOverview`, `LineCards` and the tests. Fixtures `STATION_ID`, `HANDHELD_ID`, `participant`, `PARTICIPANT_A`, `PARTICIPANT_B`, `SHARED`, `SHARED_NO_REASON` (Task 3) match every later test. Text keys used in components equal those pinned in Task 2 (checked one by one). The wire names (`participants`, `byDevice`, `closeReasonMissing`, `maxStations`, `closedBy`, `closedActualQty`, `closedReasonCode`, `lateDataAt`, `lastSeenAt`) equal the host contract.

**Gaps found (for the owner and the other plans):**

- **G1.** `/tmp/claude/mocks/office-redesign/DESIGN.md`, named in the brief, does not exist on this machine; the design rules were taken from `docs/design-briefs/design-kit-2026-10.md` and the existing office layer. If that file holds a rule the kit lacks (a participants-table pattern, say), it is not applied.
- **G2.** The spec says the blank's new wording and «хеши аттестации» change. In fact the renderer is the cloud's too (`apps/api` `ShiftsController`), where the old sentence is true (`stationClosePolicy`), and no production attestation pins a print form. The plan adds `closingRule` instead of changing the shared sentence (O9, O10, Task 12). Owner to confirm that the cloud keeps its sentence, and (spec §12.1) that the cloud's rule is as implemented.
- **G3.** `stationShift` and `installWarnings` found a device's shift by `ownerDeviceId`: wrong once several devices share a shift (O8).
- **G4.** «Устройства» now reads the shifts for the participation tag, which breaks two pre-existing «reads the shifts for a station only»-style assertions (named, Task 9); the tag appears only when the shifts load.
- **G5.** The line row action stays «Переименовать» although its dialog now also edits the limit; renaming it to «Изменить» touches many existing tests and texts: left for the owner.
- **G6.** The host's `LineCreate` has no limit (`line-create.json`): a new line starts at 1 and the limit is set by editing it. If the owner wants it at creation, the host contract changes first.
- **G7.** No office browser harness exists: the 1280 × 690 fit of the overview with the extra card row, of the shift list's status cell and of the new tab is only contract-tested; Task 13 Step 6 is the manual protocol, and the extra row may need an owner's design choice.
- **G8.** The silence of a participant is by the host's last hearing (`lastSeenAt`, written at most once a minute, by a stream only when it opens): it measures reachability, not scanning, and is compared with this PC's clock in the card and the host's in «Обзор»; the existing clock-skew warning covers the difference.
- **G9.** «Обзор» reads the last seven days of shifts, so a shift closed without its reason older than that is not listed there (it stays marked in «Смены»).
- **G10.** Spec §7 says «станций в смене: N из M» for every line card; shown only for a limit above one (O6), to keep default sites unchanged (§4.3).
- **G11.** The blank says «станция» although a handheld is a full participant: the spec fixes the wording.
- **G12.** The office has no audit screen today; the host plan says «the audit screen translates both» `shift.close` and `shift.force_closed`. If an audit page lands later it needs the new action names (`shift.join`, `shift.leave`, `shift.part_closed`, `shift.force_closed`, `shift.close_reason`, `line.max_stations_changed`).
- **G13.** The office plan relies on the host's `participants[].deviceName` (so technologists, who cannot read devices, see names); if the host omitted it for revoked devices, the card would show the host's value as sent.
- **G14.** `apps/standalone/CHANGELOG.md` 1.1.0 is the host plan's entry and names the office only in one sentence; the office items (Станции, «Закрыть целиком», «Указать причину») are release notes for the owner to add when releasing 1.1.0.
