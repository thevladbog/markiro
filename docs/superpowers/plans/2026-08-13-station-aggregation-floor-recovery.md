# Station Aggregation Floor Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the approved aggregation work surface, make failed box-label printing durably recoverable, and start every fresh box SSCC allocation at serial `1` without rewriting issued history.

**Architecture:** Keep GS1 validity separate from allocation policy: historical serial zero remains parseable, while the API and station pool prevent a new box from consuming zero. Derive a display-only KM presentation from the existing journal, restore the production box-fill component, and persist a small local box-print state on `boxes_mirror` so `WorkScreen` can resume retry, setup, verification, or explicit skip after remount and restart.

**Tech Stack:** Node 24+, TypeScript, React 19, Vitest, Testing Library, Tauri 2, SQLite through `tauri-plugin-sql`, NestJS, Drizzle ORM, PostgreSQL, `@markiro/domain`, `@markiro/ui`.

**Spec:** `docs/superpowers/specs/2026-08-13-station-aggregation-floor-recovery-design.md`

## Global Constraints

- Target Station viewports are 1280×800, 1024×768, and 1280×1024 with no document scrolling.
- Every floor action remains at least 64 px and keyboard operable.
- Accepted scans update locally; invalid, wrong-GTIN, duplicate, and write-failure signals remain full-screen.
- Raw scanner payloads, GS control characters, credentials, and native printer errors never appear in UI or logs.
- Printer recovery applies only when `issuerPrefix !== null`; validation shifts keep their current no-box path.
- A box close and its local `pending` print state are one SQLite statement.
- Retry, reprint, setup, verification, and skip never allocate a second SSCC.
- Existing counters, blocks, boxes, and serial-zero history are never moved backwards or rewritten.
- No new runtime dependency, CDN asset, telemetry path, or automatic print skip.
- RU and EN user-facing copy change together through the existing i18n files.
- Automated browser tests do not count as Windows, scanner, printer, or packaged-Tauri acceptance.

---

## File structure

**SSCC allocation policy**

- `apps/api/src/modules/sscc/sscc.service.ts` — atomically allocates a fresh box block from serial `1`.
- `apps/api/src/modules/org-profile/dto.ts` — rejects box counter seeds below `1`.
- `apps/api/src/modules/org-profile/org-profile.service.ts` — reports `1` for an absent own counter.
- `apps/api/src/modules/counterparties/counterparties.service.ts` — reports `1` for an absent counterparty counter.
- `packages/db/src/schema/platform.ts` plus a new PostgreSQL migration — uses the new default and advances only untouched zero counters.
- `apps/station/src/lib/sscc-pool.ts` — skips unused zero from a legacy box block while preserving consumed cursors.

**Scan and box presentation**

- `apps/station/src/lib/scan-presentation.ts` — converts a parsed KM into safe labelled display facts.
- `apps/station/src/lib/journal.ts` — returns those facts for the bounded recent-operation list.
- `apps/station/src/ui/work/ScanResultInstrument.tsx` — renders the dominant latest-scan identity.
- `apps/station/src/ui/work/RecentOperations.tsx` — renders GTIN, serial, verdict, and time.
- `apps/station/src/ui/work/BoxFillInstrument.tsx` — renders exact or explicitly grouped box cells.
- `apps/station/src/lib/boxes.ts` — derives a stable terminal-local box ordinal.
- `apps/station/src/pages/WorkScreen.tsx` and `apps/station/src/station.css` — integrate signals and the fixed-viewport composition.

**Durable print recovery**

- `packages/db/src/sqlite/migrations.ts` and `packages/db/src/sqlite/schema.ts` — add local print state and sanitized failure category.
- `apps/station/src/lib/boxes.ts` — owns atomic close/pending, print outcome transitions, and unresolved-work reads.
- `apps/station/src/lib/box-printing.ts` — classifies template, configuration, rendering, and transport outcomes without logging raw errors.
- `apps/station/src/ui/BoxPrintRecovery.tsx` — persistent recovery and explicit skip confirmation.
- `apps/station/src/pages/WorkScreen.tsx` — blocks ordinary scans until the pending label resolves.
- `apps/station/src/App.tsx` — opens printer setup and returns to the same persisted recovery.

**Acceptance**

- `apps/station/src/dev/gallery-fixtures.ts`, `apps/station/src/dev/StationScreenGallery.tsx`, and Station gallery tests — cover long KM, 20-place fill, and every recovery category.
- `docs/hardware-acceptance-checklist.md` — records the exact Windows/scanner/printer checks without marking them complete prematurely.

---

### Task 1: Start Fresh Box SSCC Serials at One

**Files:**

- Modify: `apps/api/src/modules/sscc/sscc.service.ts`
- Modify: `apps/api/src/modules/org-profile/dto.ts`
- Modify: `apps/api/src/modules/org-profile/org-profile.service.ts`
- Modify: `apps/api/src/modules/counterparties/counterparties.service.ts`
- Modify: `packages/db/src/schema/platform.ts`
- Create: next generated file under `packages/db/migrations/`
- Modify: generated `packages/db/migrations/meta/_journal.json` and snapshot
- Modify: `apps/station/src/lib/sscc-pool.ts`
- Test: `apps/api/test/sscc.e2e.test.ts`
- Test: `apps/api/test/sscc-settings.e2e.test.ts`
- Test: `apps/station/test/sscc-pool.test.ts`
- Test: `packages/db/test/schema.test.ts`

**Interfaces:**

- Consumes: `SsccService.allocate(...)`, `ssccCounterSchema`, and `addRange(exec, range)`.
- Produces: fresh box blocks whose `fromSerial === 1`; absent box counter responses with `nextSerial: 1`; legacy box pool cursors clamped to at least `1`.

- [ ] **Step 1: Write the failing station legacy-range tests**

Add cases that distinguish an untouched zero block from a block whose server cursor already advanced:

```ts
it("skips unused serial zero in a legacy box block", async () => {
  await addRange(exec, {
    issuerPrefix: ISSUER_PREFIX,
    extensionDigit: 0,
    fromSerial: 0,
    toSerial: 3,
    consumedThroughSerial: null,
  });
  expect(await burnSerial(exec, ISSUER_PREFIX, 0)).toBe(1);
});

it("keeps a server-known consumed cursor ahead of the box minimum", async () => {
  await addRange(exec, {
    issuerPrefix: ISSUER_PREFIX,
    extensionDigit: 0,
    fromSerial: 0,
    toSerial: 9,
    consumedThroughSerial: 4,
  });
  expect(await burnSerial(exec, ISSUER_PREFIX, 0)).toBe(5);
});

it("does not apply the box minimum to another extension digit", async () => {
  await addRange(exec, {
    issuerPrefix: ISSUER_PREFIX,
    extensionDigit: 1,
    fromSerial: 0,
    toSerial: 2,
  });
  expect(await burnSerial(exec, ISSUER_PREFIX, 1)).toBe(0);
});
```

- [ ] **Step 2: Run the focused station test and verify RED**

Run:

```bash
pnpm --filter @markiro/station exec vitest run test/sscc-pool.test.ts
```

Expected: the untouched box block returns `0` instead of `1`; the existing replay and concurrency tests remain green.

Update the existing lost-local-database replay case so its first local burn is `1`, not `0`, and its restored `consumedThroughSerial` expectation still proves that no consumed value is reissued. Keep the adversarial zero-based server range in that test.

- [ ] **Step 3: Write the failing API allocation and settings tests**

Add an unused prefix to `sscc.e2e.test.ts` and assert the exact first block and SSCC:

```ts
it("starts a fresh box range at serial one", async () => {
  const deviceId = await registerDevice("First serial device");
  const block = await app!.get(SsccService).allocate(tenantId, "555555555", 0, deviceId, 3);

  expect(block).toMatchObject({ fromSerial: 1, toSerial: 3 });
  const sscc = buildSscc(0, "555555555", block.fromSerial);
  expect(sscc).toHaveLength(18);
  expect(sscc.slice(10, 17)).toBe("0000001");
});
```

Update settings tests so a tenant and counterparty with no counter return `1`, and add:

```ts
await agent.put("/org/profile/sscc").send({ extensionDigit: 0, nextSerial: 0 }).expect(400);
await agent
  .put(`/counterparties/${counterpartyId}/sscc`)
  .send({ extensionDigit: 0, nextSerial: 0 })
  .expect(400);
```

- [ ] **Step 4: Run the focused API tests and verify RED**

Run with the repository test environment loaded:

```bash
pnpm --filter @markiro/api exec vitest run test/sscc.e2e.test.ts test/sscc-settings.e2e.test.ts
```

Expected: fresh allocation and absent-counter assertions report zero; zero seeds return 200. If database variables are absent, record the explicit skip and rerun against the configured test database before completion.

- [ ] **Step 5: Implement the station pool minimum**

Compute one candidate cursor and retain the existing `MAX` replay protection:

```ts
const consumedCursor = r.consumedThroughSerial != null ? r.consumedThroughSerial + 1 : r.fromSerial;
const boxMinimum = r.extensionDigit === 0 ? 1 : r.fromSerial;
const nextSerial = Math.max(consumedCursor, boxMinimum);
```

Do not change `buildSscc`; serial-zero history remains valid domain input.

- [ ] **Step 6: Implement the atomic server allocation minimum**

In `allocate`, derive the first usable serial and use it on both insert and conflict paths:

```ts
const firstSerial = extensionDigit === 0 ? 1 : 0;

.values({
  tenantId,
  issuerPrefix,
  extensionDigit,
  nextSerial: firstSerial + size,
})
.onConflictDoUpdate({
  target: [
    schema.ssccCounters.tenantId,
    schema.ssccCounters.issuerPrefix,
    schema.ssccCounters.extensionDigit,
  ],
  set: {
    nextSerial: sql`GREATEST(${schema.ssccCounters.nextSerial}, ${firstSerial}) + ${size}`,
    updatedAt: sql`now()`,
  },
})
```

Keep `before = rawNext - size`, capacity clamping, transaction boundaries, and block recording unchanged.

Change absent own/counterparty responses to `nextSerial: 1`. Refine the shared DTO so extension digit zero rejects a serial below one:

```ts
export const ssccCounterSchema = z
  .object({
    extensionDigit: z.number().int().min(0).max(9),
    nextSerial: z.number().int().min(0).max(9_999_999),
  })
  .superRefine(({ extensionDigit, nextSerial }, ctx) => {
    if (extensionDigit === 0 && nextSerial < 1) {
      ctx.addIssue({
        code: "custom",
        path: ["nextSerial"],
        message: "box nextSerial must be at least 1",
      });
    }
  });
```

Update comments and exact assertions in `sscc.e2e.test.ts` and `sscc-settings.e2e.test.ts` that describe a fresh block or absent counter as starting at zero. Keep serial zero in domain parsing/building tests because historical validity is unchanged.

- [ ] **Step 7: Generate and inspect the PostgreSQL migration**

Change `ssccCounters.nextSerial` to `.default(1)`, then run:

```bash
pnpm --filter @markiro/db db:generate
```

Keep the generated default change and append this data correction to that new migration:

```sql
UPDATE "sscc_counters" AS c
SET "next_serial" = 1, "updated_at" = now()
WHERE c."extension_digit" = 0
  AND c."next_serial" = 0
  AND NOT EXISTS (
    SELECT 1
    FROM "sscc_blocks" AS b
    WHERE b."tenant_id" = c."tenant_id"
      AND b."issuer_prefix" = c."issuer_prefix"
      AND b."extension_digit" = c."extension_digit"
  );
```

Inspect the generated SQL, snapshot, and journal timestamp. Do not edit an applied migration or modify unrelated schema output.

- [ ] **Step 8: Run Task 1 GREEN gates**

Run:

```bash
pnpm --filter @markiro/domain test
pnpm --filter @markiro/db build
pnpm --filter @markiro/db test
pnpm --filter @markiro/api exec vitest run test/sscc.e2e.test.ts test/sscc-settings.e2e.test.ts
pnpm --filter @markiro/station exec vitest run test/sscc-pool.test.ts test/close-box.test.ts
```

Expected: all commands pass; DB/API infrastructure skips are reported separately and are not treated as migration or e2e proof.

- [ ] **Step 9: Commit Task 1**

```bash
git add apps/api/src/modules/sscc/sscc.service.ts \
  apps/api/src/modules/org-profile apps/api/src/modules/counterparties \
  apps/api/test/sscc.e2e.test.ts apps/api/test/sscc-settings.e2e.test.ts \
  apps/station/src/lib/sscc-pool.ts apps/station/test/sscc-pool.test.ts \
  packages/db/src/schema/platform.ts packages/db/migrations packages/db/test/schema.test.ts
git commit -m "fix(sscc): start fresh box serials at one"
```

---

### Task 2: Present Accepted DataMatrix Codes Semantically

**Files:**

- Create: `apps/station/src/lib/scan-presentation.ts`
- Modify: `apps/station/src/lib/journal.ts`
- Modify: `apps/station/src/ui/work/ScanResultInstrument.tsx`
- Modify: `apps/station/src/ui/work/RecentOperations.tsx`
- Modify: `apps/station/src/pages/WorkScreen.tsx`
- Modify: `apps/station/src/i18n/ru.json`
- Modify: `apps/station/src/i18n/en.json`
- Modify: `apps/station/src/station.css`
- Test: `apps/station/test/journal.test.ts`
- Test: `apps/station/test/work-instruments.test.tsx`
- Test: `apps/station/test/work-screen.test.tsx`

**Interfaces:**

- Consumes: `ParsedKm` from `@markiro/domain` and captured `scan_events_mirror.raw`.
- Produces: `presentKm(km: ParsedKm): KmPresentation`; `RecentOperation.identity: KmPresentation | null`.

- [ ] **Step 1: Write the failing presentation and journal tests**

Define the expected safe model:

```ts
export interface KmPresentation {
  gtin14: string;
  serial: string;
  crypto: Array<{ ai: "91" | "92" | "93"; value: string }>;
  normalized: string;
}
```

Add a journal fixture containing real GS separators:

```ts
const km = "010460000000001521SERIAL-42\u001d91KEY\u001d92SIGNATURE\u001d93TAIL";
await appendScanEvent(exec, {
  shiftId: "s1",
  terminalId: "t1",
  raw: km,
  verdict: "ok",
  scannedAt: "2026-08-13T10:00:00.000Z",
  operatorId: "op1",
});

expect((await listRecentOperations(exec, "s1"))[0]?.identity).toEqual({
  gtin14: "04600000000015",
  serial: "SERIAL-42",
  crypto: [
    { ai: "91", value: "KEY" },
    { ai: "92", value: "SIGNATURE" },
    { ai: "93", value: "TAIL" },
  ],
  normalized: "(01)04600000000015 (21)SERIAL-42 (91)KEY (92)SIGNATURE (93)TAIL",
});
expect((await listRecentOperations(exec, "s1"))[0]?.identity?.normalized).not.toContain("\u001d");
```

Add malformed and rejected rows asserting `identity: null` and the existing bounded suffix behavior.

- [ ] **Step 2: Run the focused model tests and verify RED**

Run:

```bash
pnpm --filter @markiro/station exec vitest run test/journal.test.ts test/work-instruments.test.tsx
```

Expected: `RecentOperation` has no `identity`, and the UI cannot find the normalized code block.

- [ ] **Step 3: Implement the presentation boundary**

Create `scan-presentation.ts`:

```ts
import type { ParsedKm } from "@markiro/domain";

const CRYPTO_AIS = ["91", "92", "93"] as const;

export interface KmPresentation {
  gtin14: string;
  serial: string;
  crypto: Array<{ ai: (typeof CRYPTO_AIS)[number]; value: string }>;
  normalized: string;
}

export function presentKm(km: ParsedKm): KmPresentation {
  const crypto = CRYPTO_AIS.flatMap((ai) => {
    const value = km.ais[ai];
    return value === undefined ? [] : [{ ai, value }];
  });
  return {
    gtin14: km.gtin14,
    serial: km.serial,
    crypto,
    normalized: [
      `(01)${km.gtin14}`,
      `(21)${km.serial}`,
      ...crypto.map(({ ai, value }) => `(${ai})${value}`),
    ].join(" "),
  };
}
```

Change `RecentOperation` to carry `identity: KmPresentation | null`. Build it only when `classifyScan(row.raw).kind === "km"`; retain the safe suffix for rows that cannot be parsed.

- [ ] **Step 4: Render the semantic identity in both instruments**

In `ScanResultInstrument`, render the approved compact accepted state inside
the existing `role="status"`: a decorative check plus one normalized code
block. Do not duplicate it into verdict, GTIN, serial, or crypto fact rows:

```tsx
{
  operation?.verdict === "ok" && operation.identity ? (
    <>
      <span data-semantic="accepted-marker" aria-hidden="true">
        ✓
      </span>
      <code data-semantic="normalized-code">{operation.identity.normalized}</code>
    </>
  ) : operation?.codeSuffix ? (
    <span>{operation.codeSuffix}</span>
  ) : null;
}
```

Render GTIN and serial in each `RecentOperations` row; keep six rows and the existing safe time formatting. Add `work.gtin`, `work.serial`, and `work.crypto` in RU and EN.

- [ ] **Step 5: Remove the full-screen accepted overlay but keep its sound**

Split success from blocking signals in `WorkScreen`:

```ts
function publishVerdict(verdict: ScanVerdict, title: string, detail?: string): void {
  const tone = toneOf(verdict);
  playSignalTone(tone, signalContext.current.sound);
  if (tone === "ok") return;
  showTimedSignal(tone, title, detail, { playSound: false });
}
```

Adjust `showTimedSignal` so its caller can avoid playing the same sound twice. Keep 1200 ms error and 900 ms duplicate overlays. Delete the 350 ms success overlay assertion and replace it with:

```ts
const playSignalToneSpy = vi.spyOn(signalSound, "playSignalTone");
expect(screen.queryByRole("alert")).toBeNull();
expect((await screen.findByRole("status")).textContent).toContain("ACCEPTED");
expect(playSignalToneSpy).toHaveBeenCalledWith("ok", expect.anything());
```

- [ ] **Step 6: Run Task 2 GREEN gates**

Run:

```bash
pnpm --filter @markiro/station exec vitest run \
  test/journal.test.ts test/work-instruments.test.tsx \
  test/work-screen.test.tsx test/signal-sound.test.ts test/signal-overlay.test.tsx
pnpm --filter @markiro/station typecheck
pnpm --filter @markiro/station lint
```

Expected: all selected tests and static checks pass; duplicate/error timing and sound assertions remain green.

- [ ] **Step 7: Commit Task 2**

```bash
git add apps/station/src/lib/scan-presentation.ts apps/station/src/lib/journal.ts \
  apps/station/src/ui/work/ScanResultInstrument.tsx \
  apps/station/src/ui/work/RecentOperations.tsx apps/station/src/pages/WorkScreen.tsx \
  apps/station/src/i18n apps/station/src/station.css \
  apps/station/test/journal.test.ts apps/station/test/work-instruments.test.tsx \
  apps/station/test/work-screen.test.tsx
git commit -m "feat(station): show readable scan identities"
```

---

### Task 3: Restore the Signature Box-Fill Grid

**Files:**

- Modify: `apps/station/src/ui/work/BoxFillInstrument.tsx`
- Modify: `apps/station/src/lib/boxes.ts`
- Modify: `apps/station/src/pages/WorkScreen.tsx`
- Modify: `apps/station/src/station.css`
- Modify: `apps/station/src/i18n/ru.json`
- Modify: `apps/station/src/i18n/en.json`
- Test: `apps/station/test/work-instruments.test.tsx`
- Test: `apps/station/test/boxes.test.ts`
- Test: `apps/station/test/work-screen.test.tsx`
- Test: `apps/station/test/fixed-viewport-source.test.tsx`

**Interfaces:**

- Consumes: `box.itemCount`, `boxCapacity`, `shiftId`, `terminalId`, and persisted box rows.
- Produces: `buildBoxCells(filled: number, capacity: number): BoxCell[]`; `boxOrdinal(exec, shiftId, terminalId, boxId): Promise<number>`.

- [ ] **Step 1: Write failing cell-model tests**

Export a pure cell builder and assert exact and grouped behavior:

```ts
expect(buildBoxCells(2, 20)).toHaveLength(20);
expect(buildBoxCells(2, 20).filter((cell) => cell.state === "filled")).toHaveLength(2);
expect(buildBoxCells(2, 20)[2]).toMatchObject({ state: "next", from: 3, to: 3 });

const grouped = buildBoxCells(37, 101);
expect(grouped.length).toBeLessThanOrEqual(100);
expect(grouped[0]).toEqual(expect.objectContaining({ from: 1, to: 2 }));
expect(grouped.at(-1)?.to).toBe(101);
```

Render capacity 20 and assert 20 grid cells, an accessible `2 / 20` progress value, and no old `.work-box-fill__track`.

- [ ] **Step 2: Write the failing stable-ordinal tests**

Seed two boxes for the same shift/terminal and one for another terminal:

```ts
expect(await boxOrdinal(exec, "s1", "t1", "box-1")).toBe(1);
expect(await boxOrdinal(exec, "s1", "t1", "box-2")).toBe(2);
expect(await boxOrdinal(exec, "s1", "t2", "other-terminal-box")).toBe(1);
```

Use `opened_at`, then `box_id`, as the deterministic order. The ordinal is display-only and does not modify SSCCs.

- [ ] **Step 3: Run the focused tests and verify RED**

Run:

```bash
pnpm --filter @markiro/station exec vitest run \
  test/work-instruments.test.tsx test/boxes.test.ts test/work-screen.test.tsx
```

Expected: cell and ordinal exports do not exist; the old progress track remains.

- [ ] **Step 4: Implement exact and grouped cells**

Use at most 100 cells and make grouping explicit:

```ts
export interface BoxCell {
  from: number;
  to: number;
  state: "filled" | "partial" | "next" | "empty";
}

export function buildBoxCells(filled: number, capacity: number): BoxCell[] {
  const size = capacity <= 100 ? 1 : Math.ceil(capacity / 100);
  const cells: BoxCell[] = [];
  for (let from = 1; from <= capacity; from += size) {
    const to = Math.min(capacity, from + size - 1);
    const state =
      filled >= to
        ? "filled"
        : filled >= from
          ? "partial"
          : filled + 1 >= from && filled + 1 <= to
            ? "next"
            : "empty";
    cells.push({ from, to, state });
  }
  return cells;
}
```

Render each cell with `data-state`, an accessible range label, and `aria-hidden="true"` because the parent progressbar already announces the exact value. Show the grouping note only when capacity exceeds 100.

- [ ] **Step 5: Implement and integrate the stable ordinal**

Add a tenant-local-safe SQLite query scoped to shift and terminal:

```sql
SELECT COUNT(*) AS ordinal
FROM boxes_mirror candidate
WHERE candidate.shift_id = ?
  AND candidate.terminal_id IS ?
  AND (
    candidate.opened_at < ?
    OR (candidate.opened_at = ? AND candidate.box_id <= ?)
  )
```

Load the current box and ordinal together on mount/open. Pass `ordinal` into `BoxFillInstrument` and render `Короб № {{number}}` / `Box no. {{number}}`.

- [ ] **Step 6: Replace the track and remove the action underlay**

Use `grid-template-columns: repeat(10, minmax(0, 1fr))` for the ordinary 20-place case and a `data-grouped` selector for denser grids. Keep all actions on the same `work-instrument` surface; remove any separate background from `.work-box-fill__actions` while retaining gaps and 64 px buttons.

Add source assertions that the grid exists, the obsolete track selector is absent, and actions do not introduce another background.

- [ ] **Step 7: Run Task 3 GREEN gates**

Run:

```bash
pnpm --filter @markiro/station exec vitest run \
  test/work-instruments.test.tsx test/boxes.test.ts \
  test/work-screen.test.tsx test/fixed-viewport-source.test.tsx
pnpm --filter @markiro/station typecheck
pnpm --filter @markiro/station lint
```

Expected: all selected tests and static checks pass at capacities 20, 100, and 101.

- [ ] **Step 8: Commit Task 3**

```bash
git add apps/station/src/ui/work/BoxFillInstrument.tsx apps/station/src/lib/boxes.ts \
  apps/station/src/pages/WorkScreen.tsx apps/station/src/station.css \
  apps/station/src/i18n apps/station/test/work-instruments.test.tsx \
  apps/station/test/boxes.test.ts apps/station/test/work-screen.test.tsx \
  apps/station/test/fixed-viewport-source.test.tsx
git commit -m "feat(station): restore box fill instrument"
```

---

### Task 4: Persist the Box Print Lifecycle

**Files:**

- Modify: `packages/db/src/sqlite/migrations.ts`
- Modify: `packages/db/src/sqlite/schema.ts`
- Modify: `packages/db/test/sqlite-schema.test.ts`
- Modify: `apps/station/src/lib/boxes.ts`
- Modify: `apps/station/src/lib/close-box.ts`
- Test: `apps/station/test/boxes.test.ts`
- Test: `apps/station/test/close-box.test.ts`

**Interfaces:**

- Consumes: the existing single-statement `closeBox` update.
- Produces: `BoxPrintState`, `BoxPrintErrorCode`, `UnresolvedBoxPrint`, `markBoxPrintFailed`, `markBoxPrinted`, `findUnresolvedBoxPrint(exec, shiftId, terminalId, includePrintedForVerification)`.

- [ ] **Step 1: Write failing SQLite migration tests**

Apply migrations twice and assert the new columns and defaults:

```ts
const columns = db.prepare("PRAGMA table_info(boxes_mirror)").all() as Array<{
  name: string;
  dflt_value: string | null;
}>;
expect(columns).toEqual(
  expect.arrayContaining([
    expect.objectContaining({ name: "print_state", dflt_value: "'legacy'" }),
    expect.objectContaining({ name: "print_error_code" }),
  ]),
);
```

Seed a historical closed row before the new `ALTER`s and confirm it migrates as `legacy`, not `pending`.

- [ ] **Step 2: Write failing box lifecycle tests**

Assert one close statement records the SSCC and pending state:

```ts
await closeBox(exec, "b1", SSCC, CLOSED_AT, "op1");
expect(
  await exec.all(
    `SELECT sscc, closed_at, print_state, print_error_code
     FROM boxes_mirror WHERE box_id = ?`,
    ["b1"],
  ),
).toEqual([
  {
    sscc: SSCC,
    closed_at: CLOSED_AT,
    print_state: "pending",
    print_error_code: null,
  },
]);
```

Add transitions for each sanitized error, printed, verification skip, and restart read. Assert every transition keeps `sscc` unchanged and `markPrintSkipped` clears `acked_at` exactly as it does today.

- [ ] **Step 3: Run the focused DB and Station tests and verify RED**

Run:

```bash
pnpm --filter @markiro/db exec vitest run test/sqlite-schema.test.ts
pnpm --filter @markiro/station exec vitest run test/boxes.test.ts test/close-box.test.ts
```

Expected: the columns, state types, and transition functions do not exist.

- [ ] **Step 4: Add the idempotent SQLite upgrade**

Append, rather than edit the original `CREATE TABLE`, so installed stations upgrade:

```ts
`ALTER TABLE boxes_mirror ADD COLUMN print_state TEXT NOT NULL DEFAULT 'legacy';`,
`ALTER TABLE boxes_mirror ADD COLUMN print_error_code TEXT;`,
```

Mirror both columns in `boxesMirror`. `applyMigrations` already swallows only duplicate-column errors, so the second boot remains idempotent.

- [ ] **Step 5: Implement one-owner lifecycle functions**

Use these exact state and error unions:

```ts
export type BoxPrintState = "legacy" | "pending" | "printed" | "skipped";
export type BoxPrintErrorCode =
  "template_missing" | "printer_unconfigured" | "render_failed" | "transport_failed";

export interface UnresolvedBoxPrint {
  boxId: string;
  sscc: string;
  itemCount: number;
  state: "pending" | "printed";
  errorCode: BoxPrintErrorCode | null;
}
```

Change `closeBox` to one update:

```sql
UPDATE boxes_mirror
SET sscc = ?, closed_at = ?, closed_by = ?,
    print_state = 'pending', print_error_code = NULL
WHERE box_id = ?
```

Implement transitions with bounded SQL values, never dynamic error text:

```ts
export async function markBoxPrintFailed(
  exec: SqlExecutor,
  boxId: string,
  code: BoxPrintErrorCode,
): Promise<void> {
  await exec.run(
    `UPDATE boxes_mirror
        SET print_state = 'pending', print_error_code = ?
      WHERE box_id = ? AND print_state = 'pending'`,
    [code, boxId],
  );
}
```

`markBoxPrinted` sets `print_state='printed'` and clears the error. `markPrintVerified` keeps printed state. `markPrintSkipped` sets `print_state='skipped'`, writes `print_skipped_at`, clears the error, and clears `acked_at` in the same statement.

`findUnresolvedBoxPrint(
  exec: SqlExecutor,
  shiftId: string,
  terminalId: string | null,
  includePrintedForVerification: boolean,
): Promise<UnresolvedBoxPrint | null>` returns the oldest non-disassembled closed row in `pending`, plus `printed` rows only when `includePrintedForVerification` is true and neither verification outcome is recorded.

- [ ] **Step 6: Run Task 4 GREEN gates**

Run:

```bash
pnpm --filter @markiro/db exec vitest run test/sqlite-schema.test.ts
pnpm --filter @markiro/db typecheck
pnpm --filter @markiro/db lint
pnpm --filter @markiro/db build
pnpm --filter @markiro/station exec vitest run test/boxes.test.ts test/close-box.test.ts
pnpm --filter @markiro/station typecheck
```

Expected: all selected tests and package checks pass; migration rerun and historical-row cases are green.

- [ ] **Step 7: Commit Task 4**

```bash
git add packages/db/src/sqlite packages/db/test/sqlite-schema.test.ts \
  apps/station/src/lib/boxes.ts apps/station/src/lib/close-box.ts \
  apps/station/test/boxes.test.ts apps/station/test/close-box.test.ts
git commit -m "feat(station): persist box print recovery"
```

---

### Task 5: Implement Retry, Setup, Verification, and Explicit Skip

**Files:**

- Create: `apps/station/src/lib/box-printing.ts`
- Create: `apps/station/src/ui/BoxPrintRecovery.tsx`
- Modify: `apps/station/src/pages/WorkScreen.tsx`
- Modify: `apps/station/src/App.tsx`
- Modify: `apps/station/src/i18n/ru.json`
- Modify: `apps/station/src/i18n/en.json`
- Modify: `apps/station/src/station.css`
- Test: `apps/station/test/box-printing.test.ts`
- Test: `apps/station/test/work-screen.test.tsx`
- Test: `apps/station/test/App.test.tsx`
- Test: `apps/station/test/fixed-viewport-source.test.tsx`

**Interfaces:**

- Consumes: Task 4 print state functions, `renderLabelBytes`, `printing.print`, and `verifyPrintedLabel`.
- Produces: `attemptBoxPrint(input): Promise<BoxPrintAttempt>` and `BoxPrintRecovery` callbacks for retry, setup, and skip.

- [ ] **Step 1: Write failing print-attempt classification tests**

Define a discriminated result with no raw error field:

```ts
export type BoxPrintAttempt =
  { kind: "printed"; bytes: Uint8Array } | { kind: "failed"; code: BoxPrintErrorCode };

export interface BoxPrintInput {
  template: LabelTemplateSpec | null;
  fields: Record<string, string>;
  printing: {
    target: PrintTarget;
    language: PrinterLanguage;
    print: (target: PrintTarget, bytes: Uint8Array) => Promise<void>;
  } | null;
  render: (
    template: LabelTemplateSpec,
    fields: Record<string, string>,
    language: PrinterLanguage,
  ) => Promise<Uint8Array>;
}
```

Test all boundaries independently:

```ts
const configuredPrinting = {
  target: PRINT_TARGET,
  language: "zpl" as const,
  print: vi.fn<(target: PrintTarget, bytes: Uint8Array) => Promise<void>>(),
};
const input: BoxPrintInput = {
  template: BOX_TEMPLATE,
  fields: { sscc: SSCC },
  printing: configuredPrinting,
  render: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
};

expect(await attemptBoxPrint({ ...input, template: null })).toEqual({
  kind: "failed",
  code: "template_missing",
});
expect(await attemptBoxPrint({ ...input, printing: null })).toEqual({
  kind: "failed",
  code: "printer_unconfigured",
});
await expect(
  attemptBoxPrint({
    ...input,
    render: vi.fn().mockRejectedValue(new Error("secret native detail")),
  }),
).resolves.toEqual({ kind: "failed", code: "render_failed" });
await expect(
  attemptBoxPrint({
    ...input,
    printing: {
      ...configuredPrinting,
      print: vi.fn().mockRejectedValue(new Error("COM3 access denied")),
    },
  }),
).resolves.toEqual({ kind: "failed", code: "transport_failed" });
```

Assert `console.error` receives a fixed category only and does not receive either raw message.

- [ ] **Step 2: Write failing WorkScreen recovery tests**

Cover these separate scenarios in `work-screen.test.tsx`:

1. close with no box template → persistent template message and complete SSCC;
2. close with no printer → `Принтер не настроен`;
3. transport rejection → persistent retry action;
4. retry prints the same SSCC and does not call `closeCurrentBox` again;
5. setup callback fires, remount reads the same pending box, and retry remains available;
6. skip opens a confirmation; cancel keeps scans blocked;
7. confirmed skip calls `markPrintSkipped`, opens exactly one next box, and admits scans;
8. successful print with verification off resolves immediately;
9. successful print with verification on retains the existing scan-back dialog;
10. remount with a pending row restores recovery before `source.start` can admit product input.
11. operator switching and ordinary window/update actions remain disabled while recovery is unresolved, while printer setup remains available.

Use a held source callback and assert a scan emitted during recovery adds no journal/outbox row.

- [ ] **Step 3: Run the focused tests and verify RED**

Run:

```bash
pnpm --filter @markiro/station exec vitest run \
  test/box-printing.test.ts test/work-screen.test.tsx test/App.test.tsx
```

Expected: the attempt module and recovery screen do not exist; current timed error disappears after 1200 ms and scanning is not durably sealed.

- [ ] **Step 4: Implement the print boundary**

In `box-printing.ts`, test template and printer before rendering. Catch render and transport separately:

```ts
if (!input.template) return { kind: "failed", code: "template_missing" };
if (!input.printing) return { kind: "failed", code: "printer_unconfigured" };

let bytes: Uint8Array;
try {
  bytes = await input.render(input.template, input.fields, input.printing.language);
} catch {
  console.error("station: box label render failed");
  return { kind: "failed", code: "render_failed" };
}
try {
  await input.printing.print(input.printing.target, bytes);
} catch {
  console.error("station: box label transport failed");
  return { kind: "failed", code: "transport_failed" };
}
return { kind: "printed", bytes };
```

Keep WorkScreen's existing serialized printer queue by passing a print callback that already routes through `serializePrint`.

- [ ] **Step 5: Implement the recovery component**

`BoxPrintRecovery` renders a `FullScreenDialog` with the complete SSCC, mapped error copy, and floor-sized actions. Its public contract is:

```ts
export interface BoxPrintRecoveryProps {
  sscc: string;
  errorCode: BoxPrintErrorCode;
  pending: boolean;
  onRetry: () => void;
  onSetup: () => void;
  onSkip: () => void;
}
```

Show `Настроить принтер` only for `printer_unconfigured` and `transport_failed`. The skip button opens a second explicit confirmation stating that the box is already closed and needs a later label. All buttons use `size="floor"`; pending disables every action.

- [ ] **Step 6: Integrate persisted recovery into WorkScreen**

On aggregation mount, load unresolved print work before opening/admitting the next box. Include recovery in both the render-time stale-callback guard and scan subscription guard:

```ts
ordinaryScanBlockedRef.current = Boolean(
  verification ||
  printRecovery ||
  confirmPrintSkip ||
  confirmClear ||
  boxActionPending ||
  showExceptions ||
  noSerials,
);
```

After `closeCurrentBox` returns `closed`, do not immediately open the next box. Attempt the print for that closed box:

- failure → persist the error and render recovery;
- success → persist `printed`; then open verification or resolve;
- retry → call only the print attempt for the persisted box;
- skip → persist skip and resolve;
- resolve → open one next box, refresh box state, and resume scans.

Delete `showDeferredError(t("box.printNotAvailable"))` and the tests that expect it to time out. Keep invalid-serial and serial-exhaustion behavior separate.

- [ ] **Step 7: Wire printer setup through App**

Add an optional `onOpenPrinterSetup` prop to `WorkScreen`. In production App pass:

```tsx
onOpenPrinterSetup={() => setShowSetup(true)}
```

Setup already remounts WorkScreen on return; the persisted pending box reopens recovery. Do not hold an in-memory native error or label bytes across setup.

Also add `onPrintRecoveryChange?: (blocked: boolean) => void`. WorkScreen publishes `true` while recovery, skip confirmation, or required verification is unresolved and publishes `false` on resolution/unmount. App combines this state with its existing retirement gates to disable operator switching, ordinary update/window actions, and shift exit. The printer-setup callback is the only navigation allowed from the recovery dialog.

- [ ] **Step 8: Add exact RU/EN copy and source guards**

Add keys for title, SSCC label, all four categories, retry, setup, continue, confirmation, cancel, and pending state. Remove `box.printNotAvailable` only after `rg` confirms no caller remains.

Extend fixed-viewport source tests to assert every recovery action is a floor button and the component has no scroll container or compact action.

- [ ] **Step 9: Run Task 5 GREEN gates**

Run:

```bash
pnpm --filter @markiro/station exec vitest run \
  test/box-printing.test.ts test/work-screen.test.tsx test/App.test.tsx \
  test/print-verification.test.tsx test/fixed-viewport-source.test.tsx
pnpm --filter @markiro/station test
pnpm --filter @markiro/station typecheck
pnpm --filter @markiro/station lint
pnpm --filter @markiro/station build
```

Expected: focused and full Station suites pass; no old timed print-unavailable path remains.

- [ ] **Step 10: Commit Task 5**

```bash
git add apps/station/src/lib/box-printing.ts apps/station/src/ui/BoxPrintRecovery.tsx \
  apps/station/src/pages/WorkScreen.tsx apps/station/src/App.tsx \
  apps/station/src/i18n apps/station/src/station.css \
  apps/station/test/box-printing.test.ts apps/station/test/work-screen.test.tsx \
  apps/station/test/App.test.tsx apps/station/test/fixed-viewport-source.test.tsx
git commit -m "feat(station): recover failed box printing"
```

---

### Task 6: Add Gallery and Fixed-Viewport Acceptance States

**Files:**

- Modify: `apps/station/src/ui/persistent-station-states.ts`
- Modify: `apps/station/src/dev/gallery-fixtures.ts`
- Modify: `apps/station/src/dev/StationScreenGallery.tsx`
- Modify: `apps/station/test/screen-gallery.test.tsx`
- Modify: `apps/station/test/fixed-viewport-source.test.tsx`
- Modify: `docs/acceptance/station-touch-workplace.md`
- Add/update: `docs/acceptance/station-touch-browser-matrix.json` and screenshots only when a real browser matrix is rerun

**Interfaces:**

- Consumes: production `ScanResultInstrument`, `BoxFillInstrument`, and `BoxPrintRecovery`.
- Produces: deterministic fixtures for aggregation and each persistent print failure.

- [ ] **Step 1: Write failing gallery inventory tests**

Add persistent state IDs:

```ts
"box-print-template-missing",
"box-print-printer-unconfigured",
"box-print-render-failed",
"box-print-transport-failed",
"box-print-skip-confirm",
```

Assert `work-aggregation` contains a 20-cell production `BoxFillInstrument`, a long KM identity, and six recent operations. Assert each recovery ID is present in `EXPECTED_GALLERY_STATE_IDS` and uses the production recovery component.

- [ ] **Step 2: Run gallery tests and verify RED**

Run:

```bash
pnpm --filter @markiro/station exec vitest run test/screen-gallery.test.tsx test/fixed-viewport-source.test.tsx
```

Expected: the new IDs are missing and the synthetic aggregation screen still uses simplified cards.

- [ ] **Step 3: Replace synthetic approximations with production components**

Use a production-shaped accepted KM fixture with long AI 92 data and `filled=2`, `capacity=20`, `ordinal=1`. Render all recovery categories with a fixed valid SSCC. Do not make fixtures call SQLite, printer, network, or Tauri APIs.

The accepted fixture must render the production compact green check plus one
complete normalized GS1 block and a local success edge. It must not add a
separate accepted verdict or GTIN/serial/crypto fact rows. The `next` box cell
must have a visible shape/border marker in addition to colour so the next
physical position remains identifiable without colour perception.

- [ ] **Step 4: Run the automated gallery matrix**

Run the repository's acceptance commands from `docs/acceptance/station-touch-workplace.md` at all three required viewports. Record:

- exact document width/height;
- zero document or nested scroll regions;
- zero clipped visible interactives;
- zero missing, mismatched, or clipped required semantic content; for the
  accepted aggregation state this means the compact check and exact
  `data-semantic="normalized-code"` value;
- zero actions below 64 px;
- loaded bundled font;
- screenshot paths for long KM, 20-place grid, and transport recovery.

If the browser environment cannot run, leave the prior matrix untouched and record the gate as not run with the exact blocker.

- [ ] **Step 5: Run Task 6 checks**

Run:

```bash
pnpm --filter @markiro/station exec vitest run test/screen-gallery.test.tsx test/fixed-viewport-source.test.tsx
pnpm --filter @markiro/station typecheck
pnpm --filter @markiro/station lint
pnpm --filter @markiro/station build
```

Expected: all checks pass; browser acceptance is reported separately from source/component checks.

- [ ] **Step 6: Commit Task 6**

Stage only acceptance artifacts actually regenerated:

```bash
git add apps/station/src/ui/persistent-station-states.ts \
  apps/station/src/dev apps/station/test/screen-gallery.test.tsx \
  apps/station/test/fixed-viewport-source.test.tsx docs/acceptance
git commit -m "test(station): cover aggregation recovery views"
```

---

### Task 7: Run Cross-Package Gates and Record Hardware Acceptance

**Files:**

- Modify: `docs/hardware-acceptance-checklist.md`
- Modify: `docs/runbooks/station-beta-release.md` only if the release checklist lacks the affected aggregation checks

**Interfaces:**

- Consumes: the completed implementation and existing release workflow.
- Produces: an honest automated gate record and unchecked external acceptance steps for the next beta.

- [ ] **Step 1: Run final automated package gates**

Run with required test infrastructure loaded:

```bash
pnpm --filter @markiro/domain test
pnpm --filter @markiro/domain typecheck
pnpm --filter @markiro/domain lint
pnpm --filter @markiro/domain build
pnpm --filter @markiro/db test
pnpm --filter @markiro/db typecheck
pnpm --filter @markiro/db lint
pnpm --filter @markiro/db build
pnpm --filter @markiro/api test
pnpm --filter @markiro/api typecheck
pnpm --filter @markiro/api lint
pnpm --filter @markiro/api build
pnpm --filter @markiro/station test
pnpm --filter @markiro/station typecheck
pnpm --filter @markiro/station lint
pnpm --filter @markiro/station build
cargo test --manifest-path apps/station/src-tauri/Cargo.toml
pnpm format:check
git diff --check
```

Expected: every command passes. Report skipped DB/e2e tests and environment failures explicitly; do not convert them to pass.

- [ ] **Step 2: Add the unchecked Windows and hardware checklist**

Record these concrete beta steps without checking them until performed:

```markdown
- [ ] Start a fresh issuer prefix and confirm the first printed box uses serial `0000001` plus a valid final check digit.
- [ ] Scan production-like EAN-13 and KM DataMatrix; verify GTIN, serial, and AI 91/92/93 presentation.
- [ ] Fill a 20-place box and confirm each cell, auto-close, and reset after print resolution.
- [ ] Disconnect the printer during close; confirm the exact persistent category survives restart.
- [ ] Retry after restoring the printer and confirm the same 18-digit SSCC prints once.
- [ ] Repeat the failure and explicitly continue without a label; confirm the skip is synchronized and the next box accepts scans.
- [ ] Enable scan-back verification and scan GS1-128 `(00)` plus the expected SSCC.
- [ ] Repeat at packaged Windows 1280×800 and 1024×768 with the taskbar hidden in lockdown.
```

- [ ] **Step 3: Review the final diff against the spec**

Verify by search and staged diff that:

```bash
rg -n "printNotAvailable|work-box-fill__track" apps/station/src
rg -n "nextSerial: 0|nextSerial.*min\(0\)" apps/api/src/modules
git diff --check
git diff --stat origin/main...HEAD
```

Expected: the first two searches have no obsolete production match relevant to box allocation/printing; diff checks are clean and every changed file belongs to this spec.

- [ ] **Step 4: Commit the acceptance documentation**

```bash
git add docs/hardware-acceptance-checklist.md docs/runbooks/station-beta-release.md
git commit -m "docs(station): add aggregation beta acceptance"
```

- [ ] **Step 5: Request final code and operational review**

Reviewers must separately inspect:

- SSCC concurrency, migration, tenant scoping, and legacy range behavior;
- restart/operator-switch scan sealing around pending print work;
- retry/skip audit behavior and absence of duplicate serial burns;
- 1280×800 and 1024×768 layout bounds;
- the distinction between automated results and actual Windows/printer checks.

Resolve only verified findings, rerun affected focused checks, then rerun the final package gates before release.
