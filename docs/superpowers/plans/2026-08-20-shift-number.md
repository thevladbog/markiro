# Shift Number (`AUG26-003`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every shift an immutable human-readable number `<MON><YY>-<NNN>` (e.g. `AUG26-003`, station-created: `AUG26-003/S`), shown in admin and station, with the admin list sorted by real date.

**Architecture:** A per-`(tenant, month)` counter table hands out sequence numbers atomically inside the shift-create transaction. Two NOT NULL columns on `shifts` (`number_month_key`, `number_seq`) persist the number forever; the display string is composed by a `packages/domain` helper used by the API DTO. Station mirrors the composed string into SQLite and prints it on box labels (`shift.no`).

**Tech Stack:** Drizzle ORM (Postgres + SQLite), NestJS, React (admin + station/Tauri), Vitest, pnpm + turbo monorepo.

**Spec:** `docs/superpowers/specs/2026-08-20-shift-number-design.md`

## Global Constraints

- Number format: 3-letter uppercase English month + 2-digit year + `-` + zero-padded 3-digit sequence: `AUG26-003`. Seq ≥ 1000 renders with more digits, never truncated.
- Suffix `/S` if and only if `createdFrom === "station"`.
- Month source: `plannedDate` at creation time; if absent — the creation date. The number NEVER changes afterwards (updates to `plannedDate` don't touch it).
- Sequence is shared across admin- and station-created shifts within one `(tenant, month)`.
- Admin `GET /shifts` order: `coalesce(planned_date, created_at::date) DESC, created_at DESC`.
- Existing rows are backfilled in the migration; both new `shifts` columns end up NOT NULL.
- Monorepo commands: `pnpm --filter <pkg> <script>`. Tests are Vitest (`pnpm --filter <pkg> exec vitest run <file>`). API e2e tests need `DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` env (they self-skip otherwise) and a migrated Postgres (`pnpm --filter @markiro/db db:migrate`).
- Commit after every task (conventional commits, e.g. `feat(api): ...`).

---

### Task 1: Domain helpers `shiftMonthKey` + `formatShiftNumber`

**Files:**
- Create: `packages/domain/src/shift-number.ts`
- Modify: `packages/domain/src/index.ts` (add exports)
- Test: `packages/domain/test/shift-number.test.ts`

**Interfaces:**
- Consumes: `DomainError` from `packages/domain/src/errors.ts` (existing; constructor takes a string code, e.g. `new DomainError("SSCC_FORMAT")` — follow that pattern).
- Produces (used by Tasks 3, 5):
  - `shiftMonthKey(isoDate: string): string` — `"2026-08-20"` → `"AUG26"`; throws `DomainError("SHIFT_DATE_FORMAT")` on malformed input.
  - `formatShiftNumber(input: { monthKey: string; seq: number; createdFrom: "admin" | "station" }): string` → `"AUG26-003"` / `"AUG26-003/S"`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/domain/test/shift-number.test.ts
import { describe, expect, it } from "vitest";
import { DomainError, formatShiftNumber, shiftMonthKey } from "../src/index.js";

describe("shiftMonthKey", () => {
  it("maps an ISO calendar date to MONYY", () => {
    expect(shiftMonthKey("2026-08-20")).toBe("AUG26");
    expect(shiftMonthKey("2026-01-01")).toBe("JAN26");
    expect(shiftMonthKey("2029-12-31")).toBe("DEC29");
  });

  it("rejects malformed dates", () => {
    expect(() => shiftMonthKey("2026-13-01")).toThrow(DomainError);
    expect(() => shiftMonthKey("2026-8-1")).toThrow(DomainError);
    expect(() => shiftMonthKey("garbage")).toThrow(DomainError);
  });
});

describe("formatShiftNumber", () => {
  it("pads the sequence to three digits", () => {
    expect(formatShiftNumber({ monthKey: "AUG26", seq: 3, createdFrom: "admin" })).toBe(
      "AUG26-003",
    );
    expect(formatShiftNumber({ monthKey: "JAN27", seq: 42, createdFrom: "admin" })).toBe(
      "JAN27-042",
    );
  });

  it("appends /S for station-created shifts", () => {
    expect(formatShiftNumber({ monthKey: "AUG26", seq: 4, createdFrom: "station" })).toBe(
      "AUG26-004/S",
    );
  });

  it("never truncates a sequence past 999", () => {
    expect(formatShiftNumber({ monthKey: "AUG26", seq: 1234, createdFrom: "admin" })).toBe(
      "AUG26-1234",
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @markiro/domain exec vitest run test/shift-number.test.ts`
Expected: FAIL — `formatShiftNumber`/`shiftMonthKey` are not exported.

- [ ] **Step 3: Write the implementation**

```ts
// packages/domain/src/shift-number.ts
import { DomainError } from "./errors.js";

const MONTH_KEYS = [
  "JAN", "FEB", "MAR", "APR", "MAY", "JUN",
  "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
] as const;

/**
 * The month bucket a shift number is drawn from, as `MONYY` (`AUG26`).
 * Month names are a fixed English table, NOT `toLocaleString` — the number
 * is a stable identifier and must not depend on the server's locale.
 */
export function shiftMonthKey(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-\d{2}$/.exec(isoDate);
  if (!match) throw new DomainError("SHIFT_DATE_FORMAT");
  const month = Number(match[2]);
  if (month < 1 || month > 12) throw new DomainError("SHIFT_DATE_FORMAT");
  return `${MONTH_KEYS[month - 1]}${match[1].slice(2)}`;
}

/**
 * The display form of a shift number. `/S` marks a shift created at a
 * station ("Новая смена") — fixed at creation, exactly like the sequence.
 */
export function formatShiftNumber(input: {
  monthKey: string;
  seq: number;
  createdFrom: "admin" | "station";
}): string {
  const seq = String(input.seq).padStart(3, "0");
  return `${input.monthKey}-${seq}${input.createdFrom === "station" ? "/S" : ""}`;
}
```

Add to `packages/domain/src/index.ts` (alphabetically among the existing export lines):

```ts
export { formatShiftNumber, shiftMonthKey } from "./shift-number.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @markiro/domain exec vitest run test/shift-number.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm --filter @markiro/domain typecheck
git add packages/domain/src/shift-number.ts packages/domain/src/index.ts packages/domain/test/shift-number.test.ts
git commit -m "feat(domain): shift number helpers (AUG26-003, /S suffix)"
```

---

### Task 2: Postgres schema + migration with backfill

**Files:**
- Modify: `packages/db/src/schema/platform.ts` (shifts table ~line 136-220; new table after `ssccCounters` pattern at line 580)
- Create: `packages/db/migrations/0046_*.sql` (via `db:generate`, then hand-edit)
- Test: `packages/db/test/schema.test.ts`

**Interfaces:**
- Produces (used by Task 3):
  - `schema.shifts.numberMonthKey` (`number_month_key text NOT NULL`), `schema.shifts.numberSeq` (`number_seq integer NOT NULL`).
  - `schema.shiftNumberCounters` table: `{ tenantId, monthKey, lastSeq }`, PK `(tenant_id, month_key)`.

- [ ] **Step 1: Write the failing schema test**

Append to `packages/db/test/schema.test.ts` inside `describe("platform schema", ...)` (import `shiftNumberCounters` from `../src/schema/platform.js` alongside the existing imports):

```ts
it("gives shifts a NOT NULL month key and sequence for the shift number", () => {
  expect(shifts.numberMonthKey).toBeDefined();
  expect(shifts.numberMonthKey.notNull).toBe(true);
  expect(shifts.numberSeq).toBeDefined();
  expect(shifts.numberSeq.notNull).toBe(true);

  const uq = getTableConfig(shifts).indexes.find(
    (item) => item.config.name === "shifts_tenant_month_seq_uq",
  );
  expect(uq, "missing shifts (tenant, month, seq) unique index").toBeDefined();
  expect(uq!.config.unique).toBe(true);
});

it("keys the shift number counter by tenant and month", () => {
  expect(getTableName(shiftNumberCounters)).toBe("shift_number_counters");
  const cols = Object.keys(shiftNumberCounters);
  expect(cols).toEqual(expect.arrayContaining(["tenantId", "monthKey", "lastSeq"]));
  const pk = getTableConfig(shiftNumberCounters).primaryKeys[0];
  expect(pk).toBeDefined();
  expect(pk!.columns.map((column) => column.name)).toEqual(["tenant_id", "month_key"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @markiro/db exec vitest run test/schema.test.ts`
Expected: FAIL — `shiftNumberCounters` doesn't exist.

- [ ] **Step 3: Add schema**

In `packages/db/src/schema/platform.ts`, add to the `shifts` table columns (after `createdFrom`, line ~161):

```ts
    /**
     * The shift's human number, split into its immutable parts: `AUG26` +
     * `3` render as `AUG26-003` (`/S` appended for station-created shifts).
     * Assigned once at creation from `shift_number_counters` and NEVER
     * recomputed — a printed number must survive a planned-date move.
     */
    numberMonthKey: text("number_month_key").notNull(),
    numberSeq: integer("number_seq").notNull(),
```

Add to the `shifts` table's constraint array (line ~183, next to `shifts_tenant_id_uq`):

```ts
    uniqueIndex("shifts_tenant_month_seq_uq").on(t.tenantId, t.numberMonthKey, t.numberSeq),
```

Add a new table right after `ssccCounters` (line ~590), mirroring its style:

```ts
/**
 * Hands out per-(tenant, month) shift sequence numbers. `month_key` is the
 * `MONYY` bucket (`AUG26`) the shift's number was drawn from. Incremented
 * atomically (INSERT .. ON CONFLICT DO UPDATE .. RETURNING) inside the same
 * transaction as the shift insert, so concurrent creates cannot collide and
 * numbers have no gaps.
 */
export const shiftNumberCounters = pgTable(
  "shift_number_counters",
  {
    tenantId: tenantId(),
    monthKey: text("month_key").notNull(),
    lastSeq: integer("last_seq").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.monthKey] })],
);
```

- [ ] **Step 4: Run schema test to verify it passes**

Run: `pnpm --filter @markiro/db exec vitest run test/schema.test.ts`
Expected: PASS.

- [ ] **Step 5: Generate the migration and replace its body with a backfilling version**

Run: `pnpm --filter @markiro/db db:generate`

This creates `packages/db/migrations/0046_<generated-name>.sql` plus a snapshot in `migrations/meta/`. Do NOT rename the file (the journal references it). Replace the generated SQL **file content** with (keep drizzle's `--> statement-breakpoint` separators between statements):

```sql
CREATE TABLE "shift_number_counters" (
	"tenant_id" text NOT NULL,
	"month_key" text NOT NULL,
	"last_seq" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "shift_number_counters_tenant_id_month_key_pk" PRIMARY KEY("tenant_id","month_key")
);
--> statement-breakpoint
ALTER TABLE "shift_number_counters" ADD CONSTRAINT "shift_number_counters_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD COLUMN "number_month_key" text;--> statement-breakpoint
ALTER TABLE "shifts" ADD COLUMN "number_seq" integer;--> statement-breakpoint
WITH numbered AS (
	SELECT id,
		to_char(coalesce(planned_date, created_at::date), 'MONYY') AS mk,
		row_number() OVER (
			PARTITION BY tenant_id, to_char(coalesce(planned_date, created_at::date), 'MONYY')
			ORDER BY created_at, id
		) AS seq
	FROM shifts
)
UPDATE shifts s
SET number_month_key = n.mk, number_seq = n.seq
FROM numbered n
WHERE n.id = s.id;--> statement-breakpoint
INSERT INTO shift_number_counters (tenant_id, month_key, last_seq)
SELECT tenant_id, number_month_key, max(number_seq)
FROM shifts
GROUP BY tenant_id, number_month_key;--> statement-breakpoint
ALTER TABLE "shifts" ALTER COLUMN "number_month_key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "shifts" ALTER COLUMN "number_seq" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "shifts_tenant_month_seq_uq" ON "shifts" USING btree ("tenant_id","number_month_key","number_seq");
```

Notes for the implementer:
- Compare against what drizzle actually generated: keep drizzle's exact constraint/FK names and any statements it emitted that are missing above (adjust names above to the generated ones if they differ). The functional change you're making by hand: columns are added NULLABLE, backfilled, then `SET NOT NULL` — drizzle's generated `ADD COLUMN ... NOT NULL` would fail on non-empty tables.
- Postgres `to_char(date, 'MONYY')` yields uppercase English month abbreviations (`AUG26`) regardless of locale — it matches `shiftMonthKey` exactly.
- `created_at::date` uses the DB session timezone; that is acceptable for the backfill fallback (only shifts with no planned date).

- [ ] **Step 6: Apply the migration**

Run: `pnpm --filter @markiro/db db:migrate`
Expected: applies `0046_*` cleanly. If the shared dev Postgres has existing shifts, spot-check: `SELECT number_month_key, number_seq FROM shifts LIMIT 5;` — all non-null.

- [ ] **Step 7: Typecheck, build, commit**

```bash
pnpm --filter @markiro/db typecheck && pnpm --filter @markiro/db build
git add packages/db/src/schema/platform.ts packages/db/migrations packages/db/test/schema.test.ts
git commit -m "feat(db): shift number columns + per-month counters with backfill"
```

---

### Task 3: API — assign numbers, expose `number`, sort by real date

**Files:**
- Modify: `apps/api/src/modules/shifts/shifts.service.ts` (imports; `CURRENT_SHIFT_STORAGE_SELECTION` line ~52; `JoinedShiftRow` line ~42; `listShifts` orderBy line ~150; `createShift` line ~226-256; `joinedSelection()` line ~855; `mapShiftRow()` line ~888)
- Modify: `apps/api/src/modules/shifts/dto.ts` (`ShiftDto` line ~90)
- Modify: `apps/api/test/shifts.service.test.ts` (insert stub, line ~156)
- Test: `apps/api/test/shifts.e2e.test.ts`

**Interfaces:**
- Consumes: `shiftMonthKey`, `formatShiftNumber` from `@markiro/domain` (Task 1); `schema.shiftNumberCounters`, `schema.shifts.numberMonthKey/.numberSeq` (Task 2).
- Produces (used by Tasks 4, 5): `ShiftDto.number: string` on every shifts endpoint (`GET /shifts`, `GET /shifts/:id`, `POST /shifts`, `PATCH`, `/bundle`, `/reference-bundle`).

- [ ] **Step 1: Write the failing e2e tests**

Append a `describe` block inside the existing `describe.skipIf(!ready)("lines + shifts e2e", ...)` in `apps/api/test/shifts.e2e.test.ts`, using the file's existing helpers (`signUpWithActiveOrg`-style setup, `createTestStationDevice` — mirror the surrounding tests' establishment of an agent + productId; reuse whatever helper the station-origin test at ~line 1225 uses to POST as a device). Import `formatShiftNumber, shiftMonthKey` from `@markiro/domain`:

```ts
describe("shift numbers", () => {
  it("assigns sequential per-month numbers and restarts across months", async () => {
    // agent + productId prepared like the neighbouring tests
    const a = await agent.post("/shifts")
      .send({ productId, mode: "validation", plannedDate: "2031-08-05" }).expect(201);
    const b = await agent.post("/shifts")
      .send({ productId, mode: "validation", plannedDate: "2031-08-20" }).expect(201);
    const c = await agent.post("/shifts")
      .send({ productId, mode: "validation", plannedDate: "2031-09-01" }).expect(201);

    expect(a.body.number).toBe("AUG31-001");
    expect(b.body.number).toBe("AUG31-002");
    expect(c.body.number).toBe("SEP31-001");
  });

  it("suffixes /S for station-created shifts and shares the month sequence", async () => {
    const first = await agent.post("/shifts")
      .send({ productId, mode: "validation", plannedDate: "2031-10-01" }).expect(201);
    // stationAgent: request authorized with the device api-key, as in the
    // createdFrom test at ~line 1225
    const second = await stationAgent.post("/shifts")
      .send({ productId, mode: "validation", plannedDate: "2031-10-02" }).expect(201);

    expect(first.body.number).toBe("OCT31-001");
    expect(second.body.number).toBe("OCT31-002/S");
  });

  it("keeps the number when plannedDate moves to another month", async () => {
    const created = await agent.post("/shifts")
      .send({ productId, mode: "validation", plannedDate: "2031-11-05" }).expect(201);
    expect(created.body.number).toBe("NOV31-001");

    const updated = await agent.patch(`/shifts/${created.body.id}`)
      .send({ plannedDate: "2031-12-05" }).expect(200);
    expect(updated.body.number).toBe("NOV31-001");
  });

  it("falls back to the creation month when plannedDate is omitted", async () => {
    const created = await agent.post("/shifts")
      .send({ productId, mode: "validation" }).expect(201);
    const todayKey = shiftMonthKey(new Date().toISOString().slice(0, 10));
    expect(created.body.number.startsWith(`${todayKey}-`)).toBe(true);
  });

  it("lists shifts by real date, newest first", async () => {
    // fresh org/agent so only these three shifts exist
    const early = await agent.post("/shifts")
      .send({ productId, mode: "validation", plannedDate: "2031-01-01" }).expect(201);
    const late = await agent.post("/shifts")
      .send({ productId, mode: "validation", plannedDate: "2031-03-01" }).expect(201);
    const dateless = await agent.post("/shifts")
      .send({ productId, mode: "validation" }).expect(201); // real date = today

    const list = await agent.get("/shifts").expect(200);
    const ids = list.body.items.map((item: { id: string }) => item.id);
    expect(ids).toEqual([dateless.body.id, late.body.id, early.body.id]);
  });
});
```

Adapt the scaffolding (org signup, product creation, station device) to the file's existing helpers — copy the setup used by the nearest `describe`. Use a **fresh organization** for these tests so counters start at 001 deterministically.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @markiro/api exec vitest run test/shifts.e2e.test.ts`
Expected: new tests FAIL (`number` undefined); pre-existing tests still pass.

- [ ] **Step 3: Implement in `shifts.service.ts`**

Imports: add `desc`, `sql` to the `drizzle-orm` import; add `import { formatShiftNumber, shiftMonthKey } from "@markiro/domain";` (note the file already imports a *type* from `@markiro/domain` — add a value import line).

`JoinedShiftRow` (line ~42): the selection carries the parts, not the composed string:

```ts
type JoinedShiftRow = Omit<ShiftDto, "image" | "number"> & {
  numberMonthKey: string;
  numberSeq: number;
  imageChecksum: string | null;
  imageByteSize: number | null;
  imageWidth: number | null;
  imageHeight: number | null;
  stationClosePolicy: "single_device" | "admin_only";
  stationCloseOwnerDeviceId: string | null;
};
```

`CURRENT_SHIFT_STORAGE_SELECTION` (line ~52): add

```ts
  numberMonthKey: schema.shifts.numberMonthKey,
  numberSeq: schema.shifts.numberSeq,
```

`listShifts` orderBy (line ~150):

```ts
      .orderBy(
        sql`coalesce(${schema.shifts.plannedDate}, ${schema.shifts.createdAt}::date) desc`,
        desc(schema.shifts.createdAt),
      );
```

`createShift` (replace the try-block insert, lines ~226-247) — the counter bump and the shift insert share one transaction:

```ts
    const monthKey = shiftMonthKey(data.plannedDate ?? new Date().toISOString().slice(0, 10));

    try {
      const [row] = await this.db.transaction(async (tx) => {
        const [counter] = await tx
          .insert(schema.shiftNumberCounters)
          .values({ tenantId, monthKey, lastSeq: 1 })
          .onConflictDoUpdate({
            target: [schema.shiftNumberCounters.tenantId, schema.shiftNumberCounters.monthKey],
            set: { lastSeq: sql`${schema.shiftNumberCounters.lastSeq} + 1` },
          })
          .returning({ lastSeq: schema.shiftNumberCounters.lastSeq });
        if (!counter) {
          throw new InternalServerErrorException("Failed to allocate a shift number");
        }
        return tx
          .insert(schema.shifts)
          .values({
            tenantId,
            productId: data.productId,
            lineId: data.lineId ?? null,
            counterpartyId: counterpartyId ?? null,
            // The issuer is always explicit (unlike the org-defaulted box
            // template resolved above), so an omitted value is null ("our
            // organisation").
            ssccIssuerCounterpartyId: data.ssccIssuerCounterpartyId ?? null,
            boxLabelTemplateId,
            mode: data.mode,
            plannedQty: data.plannedQty ?? null,
            plannedDate: data.plannedDate ?? null,
            boxCapacity: boxCapacity ?? null,
            palletCapacity: palletCapacity ?? null,
            palletsEnabled,
            createdFrom,
            numberMonthKey: monthKey,
            numberSeq: counter.lastSeq,
          })
          .returning({ id: schema.shifts.id });
      });
```

(The values list is the current one from lines 229-246 verbatim, plus the two number fields. The `if (!row)` check and the catch → `handleWriteError` after the transaction stay as-is.)

`joinedSelection()` (line ~855): add

```ts
      numberMonthKey: schema.shifts.numberMonthKey,
      numberSeq: schema.shifts.numberSeq,
```

`mapShiftRow()` (line ~888): destructure the parts out and compose:

```ts
    const {
      numberMonthKey,
      numberSeq,
      imageChecksum,
      imageByteSize,
      imageWidth,
      imageHeight,
      stationClosePolicy,
      stationCloseOwnerDeviceId,
      ...shift
    } = row;
    const access =
      stationClosePolicy === "admin_only"
        ? ({ kind: "admin_only" } as const)
        : stationCloseOwnerDeviceId
          ? ({ kind: "single_device", ownerDeviceId: stationCloseOwnerDeviceId } as const)
          : undefined;
    return {
      ...shift,
      number: formatShiftNumber({
        monthKey: numberMonthKey,
        seq: numberSeq,
        createdFrom: shift.createdFrom,
      }),
      ...(access ? { stationCloseAccess: access } : {}),
      image: imageChecksum
        ? {
            checksum: imageChecksum,
            contentType: "image/webp",
            byteSize: imageByteSize ?? 0,
            width: imageWidth ?? 0,
            height: imageHeight ?? 0,
          }
        : null,
    };
```

`dto.ts` `ShiftDto` (line ~90), right after `id`:

```ts
  /** Human-readable immutable number, e.g. `AUG26-003` (`/S` = station-created). */
  number: string;
```

- [ ] **Step 4: Fix the service unit-test stub**

`apps/api/test/shifts.service.test.ts` mocks `db.insert` per table (line ~156) and already routes `transaction` through the same stub (line 47). Extend the insert stub so inserting into `schema.shiftNumberCounters` supports the new chain:

```ts
      insert: (table: unknown) => ({
        values: (values: Record<string, unknown>) =>
          table === schema.shiftNumberCounters
            ? {
                onConflictDoUpdate: () => ({
                  returning: async () => [{ lastSeq: 1 }],
                }),
              }
            : {
                // existing shifts-insert branch unchanged
              },
      }),
```

(Match the file's actual stub shape; the essential part is `values().onConflictDoUpdate().returning()` resolving `[{ lastSeq: 1 }]`.) Any fixture typed as `ShiftDto` needs a `number` field — add e.g. `number: "AUG26-001"`.

- [ ] **Step 5: Run tests**

```bash
pnpm --filter @markiro/api exec vitest run test/shifts.service.test.ts test/shifts.e2e.test.ts test/shifts.controller.test.ts test/shifts-bundle.e2e.test.ts
```
Expected: PASS. The bundle e2e should show `shift.number` flowing through untouched (`StationBundleShiftDto` extends `ShiftDto`). If other API test files construct `ShiftDto` literals, add `number` there too (`pnpm --filter @markiro/api typecheck` finds them all).

- [ ] **Step 6: Typecheck + commit**

```bash
pnpm --filter @markiro/api typecheck
git add apps/api
git commit -m "feat(api): assign immutable shift numbers, expose number, sort list by real date"
```

---

### Task 4: Admin — number column, dialog/panel labels, i18n

**Files:**
- Modify: `apps/admin/src/pages/shifts/api.ts` (ShiftDto, line ~22)
- Modify: `apps/admin/src/pages/shifts/index.tsx` (columns line ~276; dialog entity lines 130/134/208)
- Modify: `apps/admin/src/pages/shifts/ShiftPanelRoute.tsx` (edit panel title, line ~203)
- Modify: `apps/admin/src/i18n/ru.json`, `apps/admin/src/i18n/en.json` (`pages.shifts.table`, line ~803)
- Test: `apps/admin/test/shifts.test.tsx`

**Interfaces:**
- Consumes: `ShiftDto.number: string` from the API (Task 3).
- Produces: nothing consumed downstream.

- [ ] **Step 1: Write the failing test**

In `apps/admin/test/shifts.test.tsx`, first add `number` to the shift fixtures (they're typed as the client `ShiftDto`, so typecheck forces this anyway) — e.g. `number: "AUG26-001"` / `"AUG26-002/S"`. Then add a test alongside the existing table assertions, following the file's established render helpers:

```tsx
it("shows the shift number in the first table column", async () => {
  renderShiftsPage(); // the file's existing helper + fixtures
  expect(await screen.findByText("AUG26-001")).toBeInTheDocument();
  expect(screen.getByText("AUG26-002/S")).toBeInTheDocument();
  const headers = screen.getAllByRole("columnheader");
  expect(headers[0]).toHaveTextContent("Номер");
});
```

(Adapt helper names and the expected header language to what the file already uses — check whether its i18n renders ru or en and assert accordingly.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @markiro/admin exec vitest run test/shifts.test.tsx`
Expected: new test FAILS; possibly TS errors on fixtures until `number` is added to the DTO.

- [ ] **Step 3: Implement**

`api.ts` `ShiftDto` — after `id: string;`:

```ts
  /** Human-readable immutable number, e.g. `AUG26-003` (`/S` = station-created). */
  number: string;
```

`index.tsx` columns array (line ~277) — new first entry:

```tsx
      {
        key: "number",
        title: t("pages.shifts.table.number"),
        mono: true,
        render: (row) => row.number,
      },
```

Dialog labels — replace `shift.productName ?? shift.id` at lines 134 and 208 with:

```tsx
        entity={shift.productName ? `${shift.number} · ${shift.productName}` : shift.number}
```

and line 130's body param with:

```tsx
            <p>{t("pages.shifts.deleteConfirmBody", { name: shift.productName ?? shift.number })}</p>
```

`ShiftPanelRoute.tsx` line ~203 (the loaded edit panel, where the fetched shift is in scope — NOT the loading/error `PanelState`):

```tsx
        title={`${t("pages.shifts.form.editTitle")} · ${shift.number}`}
```

i18n — in both `ru.json` and `en.json`, inside `pages.shifts.table` add as the first key:

```json
        "number": "Номер",
```
(en: `"number": "Number",`)

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @markiro/admin exec vitest run test/shifts.test.tsx test/shifts-routing.test.tsx test/shift-exports-dialog.test.tsx test/dashboard.test.tsx test/conflicts.test.tsx test/boxes.test.tsx
```
Expected: PASS (fixtures in the other files may also need `number` — typecheck will list them).

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm --filter @markiro/admin typecheck
git add apps/admin
git commit -m "feat(admin): shift number column and labels"
```

---

### Task 5: Station data plumbing — bundle type, SQLite mirror, contexts

**Files:**
- Modify: `packages/db/src/sqlite/schema.ts` (`shiftMirror`, line ~60)
- Modify: `packages/db/src/sqlite/migrations.ts` (trailing `ALTER TABLE` list, line ~197)
- Modify: `apps/station/src/lib/mirror.ts` (`StationBundle.shift` line ~11; `upsertBundleBody` line ~159; `ShiftContextRow` + `readShiftContext` lines ~483-545)
- Test: `packages/db/test/sqlite-schema.test.ts`, `apps/station/test/shift-bundle.test.ts` (extend existing)

**Interfaces:**
- Consumes: bundle JSON now carries `shift.number: string` (Task 3).
- Produces (used by Task 6): `ShiftContextRow.number: string | null` from `readShiftContext`; `shift_mirror.number` column.

- [ ] **Step 1: Write the failing tests**

`packages/db/test/sqlite-schema.test.ts` — follow the file's existing column assertions style:

```ts
it("mirrors the shift number", () => {
  expect(shiftMirror.number).toBeDefined();
  expect(shiftMirror.number.notNull).toBe(false);
});
```

`apps/station/test/shift-bundle.test.ts` — find the existing test that runs `upsertBundle` (or `mirrorShiftBundle`) against an in-memory executor and asserts mirrored columns; extend its bundle fixture with `number: "AUG26-003/S"` on `bundle.shift`, and assert `readShiftContext` returns it:

```ts
const context = await readShiftContext(exec, bundle.shift.id);
expect(context?.number).toBe("AUG26-003/S");
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm --filter @markiro/db exec vitest run test/sqlite-schema.test.ts
pnpm --filter @markiro/station exec vitest run test/shift-bundle.test.ts
```
Expected: FAIL (no `number` column / field).

- [ ] **Step 3: Implement**

`packages/db/src/sqlite/schema.ts` — add at the END of `shiftMirror`'s columns (trailing, like `issuerPrefix`; see the comment there about why late columns trail):

```ts
  // Human-readable shift number (`AUG26-003`, `/S` = station-created) --
  // composed server-side; see migrations.ts's trailing ALTER.
  number: text("number"),
```

`packages/db/src/sqlite/migrations.ts` — append to the trailing ALTER list (after line ~197):

```ts
  `ALTER TABLE shift_mirror ADD COLUMN number TEXT;`,
```

`apps/station/src/lib/mirror.ts`:

1. `StationBundle.shift` (line ~30, after `openedAt`) — optional, tolerant of an older server during a rolling deploy:

```ts
    /** Human-readable shift number; absent from bundles served by pre-upgrade servers. */
    number?: string | null;
```

2. `upsertBundleBody` (line ~165): add `number` to the INSERT column list (after `box_label_template_spec`), one more `?` placeholder, `number=excluded.number` to the UPDATE SET, and `s.number ?? null` at the end of the params array.

3. `ShiftContextRow` (line ~483) — add:

```ts
  /** Human-readable shift number (`AUG26-003/S`); null until a post-upgrade bundle sync. */
  number: string | null;
```

4. `readShiftContext` (line ~497): add `s.number` to the SELECT (`s.number AS number` alongside `s.counterparty_name`), `number: string | null` to the row generic, and `number: row.number ?? null` to the returned object.

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @markiro/db exec vitest run test/sqlite-schema.test.ts && pnpm --filter @markiro/db build
pnpm --filter @markiro/station exec vitest run test/shift-bundle.test.ts
```
Expected: PASS. (`@markiro/db build` first — station consumes the built package.)

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm --filter @markiro/db typecheck && pnpm --filter @markiro/station typecheck
git add packages/db apps/station/src/lib/mirror.ts apps/station/test
git commit -m "feat(station): mirror the shift number into SQLite and the shift context"
```

---

### Task 6: Station UI — selection card, status bar, box label

**Files:**
- Modify: `apps/station/src/pages/ShiftSelection.tsx` (`ShiftListItem` line ~19; `ShiftCard` render line ~291)
- Modify: `apps/station/src/ui/ShiftCard.tsx` (props line ~5; render line ~61)
- Modify: `apps/station/src/App.tsx` (`shiftLabel` line ~1300; `<WorkScreen>` props line ~1388)
- Modify: `apps/station/src/pages/WorkScreen.tsx` (props line ~59; `fieldsForClosedBox` line ~808)
- Modify: `apps/station/src/lib/box-label.ts`
- Test: `apps/station/test/shift-selection.test.tsx`, `apps/station/test/status-bar.test.tsx`, `apps/station/test/close-box.test.ts`

**Interfaces:**
- Consumes: `ShiftDto.number` on `GET /shifts` items (Task 3); `ShiftContextRow.number` (Task 5).
- Produces: `boxLabelFields` input gains `shiftNumber: string | null`; `"shift.no"` renders it.

- [ ] **Step 1: Write the failing tests**

`apps/station/test/shift-selection.test.tsx` — in the mocked `GET /shifts` fixtures add `number: "AUG26-001"`, then assert (using the file's render helpers):

```tsx
expect(await screen.findByText(/AUG26-001/)).toBeInTheDocument();
```

`apps/station/test/status-bar.test.tsx` — the StatusBar takes `shiftLabel` verbatim; add/extend a case rendering `shiftLabel="AUG26-003/S · Вода"` and assert both the number and product appear.

`apps/station/test/close-box.test.ts` (lines ~182-197 currently assert `"shift.no": ""`): update the `boxLabelFields` call in the test to pass `shiftNumber: "AUG26-003/S"` and expect:

```ts
expect(fields["shift.no"]).toBe("AUG26-003/S");
```

Also keep one case with `shiftNumber: null` expecting `""` (old mirrors before the first sync).

- [ ] **Step 2: Run to verify failure**

```bash
pnpm --filter @markiro/station exec vitest run test/shift-selection.test.tsx test/status-bar.test.tsx test/close-box.test.ts
```
Expected: FAIL (missing field/props).

- [ ] **Step 3: Implement**

`box-label.ts` — extend the input and stop hardcoding the empty string:

```ts
export interface BoxLabelInput {
  sscc: string;
  itemCount: number;
  productName: string;
  gtin14: string;
  operatorName: string | null;
  counterpartyName: string | null;
  closedAt: string;
  /** `AUG26-003/S`; null when the mirror predates the shift-number sync. */
  shiftNumber: string | null;
}
```

and in the returned record: `"shift.no": input.shiftNumber ?? "",`.

`WorkScreen.tsx` — add to `WorkScreenProps` (after `counterpartyName`):

```ts
  /** Human-readable shift number for the box label's `shift.no` field. */
  shiftNumber?: string | null;
```

destructure it in the component signature, and in `fieldsForClosedBox` (line ~808) add `shiftNumber: shiftNumber ?? null,` to the `boxLabelFields` input.

`App.tsx` line ~1388 — pass it next to `counterpartyName`:

```tsx
            shiftNumber={shiftContext.number}
```

`App.tsx` line ~1300 — the status bar label becomes `«номер · продукт»`:

```tsx
      shiftLabel={
        shift
          ? shiftContext
            ? shiftContext.number
              ? `${shiftContext.number} · ${shiftContext.productName}`
              : shiftContext.productName
            : shift.id
          : null
      }
```

`ShiftSelection.tsx` — `ShiftListItem` gains `number?: string | null;` (after `id`), and the `<ShiftCard>` render (line ~293) passes `number={shift.number ?? null}`.

`ShiftCard.tsx` — add `number?: string | null;` to `ShiftCardProps`, destructure it, and prefix the product line (line 61):

```tsx
        <div className="shift-card__product">
          {number ? `${number} · ` : ""}
          {productName ?? "—"}
        </div>
```

- [ ] **Step 4: Run station tests**

```bash
pnpm --filter @markiro/station exec vitest run
```
Expected: PASS. If `screen-gallery.test.tsx` / `gallery-fixtures.ts` snapshots break, add plausible `number` values (e.g. `"AUG26-001"`) to the gallery's shift fixtures rather than weakening assertions.

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm --filter @markiro/station typecheck
git add apps/station
git commit -m "feat(station): show the shift number on cards, status bar and box labels"
```

---

### Task 7: Full-repo verification

**Files:** none new — verification only.

- [ ] **Step 1: Run the workspace gates**

```bash
pnpm typecheck
pnpm lint
pnpm test
```
Expected: all green. (API e2e suites self-skip without `DATABASE_URL`/`BETTER_AUTH_*`; if the shared dev Postgres is available, export them so the shift-number e2e actually runs — see the memory note about the shared Postgres in local env.)

- [ ] **Step 2: Fix any stragglers**

Typical fallout: `ShiftDto`-typed fixtures in tests not touched above (`dashboard.test.tsx`, `boxes.test.tsx`, station `new-shift.test.tsx`) missing `number`. Add realistic values; do not loosen types.

- [ ] **Step 3: Commit any fixes**

```bash
git add -A
git commit -m "test: align shift fixtures with the new number field"
```
(Skip if nothing changed.)
