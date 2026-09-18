# Open-pallet box removal — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** an operator can take any box off an open warehouse pallet on the handheld, whatever its sync status, and an emptied open pallet disappears on both sides without burning a serial.

**Architecture:** a new optional sync record kind `palletMembershipRemovals[]` on `POST /station/scans`, applied before memberships and clearing `boxes.pallet_id` for the device's own open warehouse pallet, followed by pruning emptied draft pallets; on the handheld a Room 19 removal queue table drained by `SyncEngine` beside memberships, `WarehousePallets.remove` accepting every status, and the member row offering «Убрать» for every non-rejected box.

**Tech Stack:** NestJS + Drizzle + zod (API), Postgres migrations (packages/db), Kotlin/Room/Compose + MockWebServer/Robolectric (handheld), vitest / JUnit.

**Spec:** `docs/superpowers/specs/2026-09-18-open-pallet-box-removal-design.md`. Read it once before starting; each task below cites its section.

## Global Constraints

- Record kind name: `pallet_membership_removal` (quarantine CHECK, `DeniedStationRecordDto.recordKind`, quarantine payload map, OpenAPI enum) — all four must agree (spec §2).
- Batch field: `palletMembershipRemovals`, element `{ palletId, boxSscc, removedAt, operatorId }`; response field `membershipRemovals`, element `{ palletId, boxSscc, status }` with `status ∈ removed | replayed | not_found | pallet_closed | subscription_read_only` (spec §2).
- Cap: `MAX_PALLET_MEMBERSHIPS_PER_SYNC_BATCH` (existing, 100) on both sides; no new domain constant; `SyncEngine.MAX_PALLET_MEMBERSHIP_REMOVALS = 100` (spec Decisions, §3.3).
- Ingest order: items → box closures → pre-pass → **removals** → memberships → **prune** → pallet closures → box exceptions → pallet exceptions (spec §2).
- `payloadDigest` folds `palletMembershipRemovals` only when non-empty (spec §2).
- Prune deletes `pallet_membership_rejections` for the pallet, then the pallet row, only when `kind = 'warehouse' AND closed_at IS NULL AND disassembled_at IS NULL` and no box has `pallet_id` = it (spec §2).
- Handheld table `pallet_membership_removals(id AUTOINCREMENT, palletId, sscc, removedAt, operatorId, status)`, index `(status, id)`; Room version 19; `MIGRATION_18_19` (spec §3.1).
- Removal queue rule: reuse a `pending` row for the same `(palletId, sscc)`, otherwise insert (even beside a `sent` one) (spec §3.1).
- `remove` refuses only a missing or `rejected` membership; deletes the membership row; `release` + `clearPallet` on the mirror; deletes the pallet when `countOnPallet == 0` and it is open (spec §3.2).
- `attach` skips the null-SSCC `OnAnotherPallet` refusal while a removal for that SSCC is queued (`pending` or `sent`) (spec §3.2).
- Sync: response guard one outcome per removal row in order; on any terminal status delete the removal row; on `removed`/`replayed`/`not_found` call `clearPallet(sscc)` (spec §3.3).
- Strings: none new. Russian and English README/CHANGELOG wording as in the repo.
- Every commit: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` trailer. Run git as `/usr/bin/git`, one plain command per invocation.

---

### Task 1: DB — widen the quarantine record-kind CHECK

**Files:**

- Modify: `packages/db/src/schema/platform.ts` (the `station_sync_quarantine_record_kind_check` list, ~line 655)
- Create (generated): `packages/db/migrations/0165_*.sql` + journal/snapshot via `db:generate`
- Test: `packages/db/test/warehouse-pallets-migration.test.ts`

**Interfaces:** produces the CHECK value `'pallet_membership_removal'` that Task 2's quarantine insert relies on.

- [ ] **Step 1: Extend the existing migration test (it migrates the full folder after the legacy cut, so the new migration is exercised)**

In `packages/db/test/warehouse-pallets-migration.test.ts`, inside `it("lets pallet_exceptions carry no shift and adds the quarantine kind", …)` add after the existing `toContain("'pallet_membership'")`:

```ts
// 0165: a removal is denied and quarantined like the membership it undoes.
expect(check.rows[0]?.def).toContain("'pallet_membership_removal'");
```

- [ ] **Step 2: Run it, expect FAIL**

```bash
DATABASE_URL=<test db> pnpm --filter @markiro/db exec vitest run test/warehouse-pallets-migration.test.ts
```

Expected: the new `toContain` fails.

- [ ] **Step 3: Change the schema**

In `packages/db/src/schema/platform.ts`, the CHECK becomes:

```ts
    check(
      "station_sync_quarantine_record_kind_check",
      sql`${t.recordKind} IN ('item', 'box', 'exception', 'product_label_event', 'pallet', 'pallet_exception', 'pallet_membership', 'pallet_membership_removal')`,
    ),
```

- [ ] **Step 4: Generate the migration and review it**

```bash
DATABASE_URL=<test db> pnpm --filter @markiro/db db:generate --name pallet_membership_removal_quarantine
```

Expected output: `0165_pallet_membership_removal_quarantine.sql` containing exactly a DROP CONSTRAINT + ADD CONSTRAINT pair for `station_sync_quarantine_record_kind_check`, plus a journal entry and snapshot. If drizzle emits anything else (partitioned tables are excluded per `drizzle.config.ts`), stop and report.

- [ ] **Step 5: Build and test**

```bash
pnpm --filter @markiro/db build
DATABASE_URL=<test db> pnpm --filter @markiro/db exec vitest run test/warehouse-pallets-migration.test.ts
pnpm --filter @markiro/db typecheck && pnpm --filter @markiro/db lint
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
/usr/bin/git add packages/db/src/schema/platform.ts packages/db/migrations packages/db/test/warehouse-pallets-migration.test.ts
/usr/bin/git commit -m "feat(db): quarantine kind pallet_membership_removal (0165)"
```

---

### Task 2: API — DTO, digest, denial/quarantine, OpenAPI

**Files:**

- Modify: `apps/api/src/modules/station-scans/dto.ts`
- Modify: `apps/api/src/modules/station-scans/station-scans.service.ts` (`payloadDigest`, the read-only `denied` list and body filter, `quarantine()` payload map)
- Modify: `apps/api/src/modules/station-scans/station-scans.controller.ts` (forward `membershipRemovals`)
- Test: `apps/api/test/station-scans-dto.test.ts`

**Interfaces:** produces `palletMembershipRemovalSchema`, `PalletMembershipRemovalDto`, `PalletMembershipRemovalStatus`, `PalletMembershipRemovalOutcomeDto`, `SyncBatchDto.palletMembershipRemovals`, `SyncBatchResponseDto.membershipRemovals`, and the `"pallet_membership_removal"` record kind, all consumed by Task 3.

- [ ] **Step 1: Failing DTO tests** — in `apps/api/test/station-scans-dto.test.ts`, next to the `palletMemberships` cases (~line 265), add:

```ts
const removal = {
  palletId: "w1",
  boxSscc: "003460068200000018",
  removedAt: "2026-09-18T10:00:00.000Z",
  operatorId: null,
};

it("accepts palletMembershipRemovals and defaults them to empty", () => {
  expect(syncBatchSchema.parse({ batchId: "b", items: [] }).palletMembershipRemovals).toEqual([]);
  const parsed = syncBatchSchema.parse({
    batchId: "b",
    items: [],
    palletMembershipRemovals: [removal],
  });
  expect(parsed.palletMembershipRemovals).toEqual([removal]);
});

it("caps palletMembershipRemovals at the membership limit and refuses a duplicate key", () => {
  const tooMany = Array.from({ length: MAX_PALLET_MEMBERSHIPS_PER_SYNC_BATCH + 1 }, (_, i) => ({
    ...removal,
    boxSscc: `0034600682${String(i).padStart(8, "0")}`,
  }));
  expect(() =>
    syncBatchSchema.parse({ batchId: "b", items: [], palletMembershipRemovals: tooMany }),
  ).toThrow();
  expect(() =>
    syncBatchSchema.parse({
      batchId: "b",
      items: [],
      palletMembershipRemovals: [removal, removal],
    }),
  ).toThrow();
});
```

Run: `pnpm --filter @markiro/api exec vitest run test/station-scans-dto.test.ts` — expected FAIL (unknown key is stripped/rejected).

- [ ] **Step 2: DTO** — in `dto.ts` after `palletMembershipSchema`:

```ts
/**
 * A box taken back off the device's own OPEN warehouse pallet (spec
 * 2026-09-18-open-pallet-box-removal §2). The undo of `palletMembershipSchema`:
 * same identity, applied BEFORE memberships so a removal and a re-scan in one
 * batch land in that order.
 */
export const palletMembershipRemovalSchema = z.object({
  palletId: z.string().min(1).max(64),
  boxSscc: z.string().regex(/^\d{18}$/),
  removedAt: z.string().datetime(),
  operatorId: z.string().uuid().toLowerCase().nullable(),
});
export type PalletMembershipRemovalDto = z.infer<typeof palletMembershipRemovalSchema>;
```

In `syncBatchSchema`, after `palletMemberships`:

```ts
  // Boxes taken back off open warehouse pallets. Bounded by the membership
  // cap: a removal is the undo of exactly one membership.
  palletMembershipRemovals: z
    .array(palletMembershipRemovalSchema)
    .max(MAX_PALLET_MEMBERSHIPS_PER_SYNC_BATCH)
    .refine(
      (removals) =>
        new Set(removals.map((r) => `${r.palletId}|${r.boxSscc}`)).size === removals.length,
      "Pallet membership removals must name each (pallet, box) at most once in a batch",
    )
    .default([]),
```

Add `"pallet_membership_removal"` to `DeniedStationRecordDto.recordKind` and to `deniedStationRecordOpenApiSchema.properties.recordKind.enum`. Add:

```ts
export type PalletMembershipRemovalStatus =
  "removed" | "replayed" | "not_found" | "pallet_closed" | "subscription_read_only";

export interface PalletMembershipRemovalOutcomeDto {
  palletId: string;
  boxSscc: string;
  status: PalletMembershipRemovalStatus;
}
```

and on `SyncBatchResponseDto`:

```ts
  /** Present when the batch carried `palletMembershipRemovals`; one entry per record, same order. */
  membershipRemovals?: PalletMembershipRemovalOutcomeDto[];
```

OpenAPI: a `palletMembershipRemovalOutcomeOpenApiSchema` (object, `additionalProperties: false`, required `palletId`/`boxSscc`/`status`, `status.enum` = the five statuses) and a `membershipRemovals` array property on the batch response schema with description "Present when the batch carried palletMembershipRemovals; one entry per record, same order." Also add the request field to the request OpenAPI schema if the file declares one for `palletMemberships` (grep `palletMemberships` in `dto.ts` and mirror every occurrence).

- [ ] **Step 3: Service plumbing** — in `station-scans.service.ts`:

`payloadDigest`: destructure `palletMembershipRemovals` too and add
`if (palletMembershipRemovals.length > 0) canonical.palletMembershipRemovals = palletMembershipRemovals;`.

Read-only block: capture `const submittedRemovals = body.palletMembershipRemovals;` beside `submittedMemberships`; append to `denied`:

```ts
            // The undo of a membership is held to the same rule as the
            // membership: always denied while read-only, quarantined, never dropped.
            ...body.palletMembershipRemovals.map((_removal, recordIndex) => ({
              recordKind: "pallet_membership_removal" as const,
              recordIndex,
              shiftId: null,
              code: "subscription_read_only" as const,
            })),
```

and filter them out of `body` like memberships (`palletMembershipRemovals: body.palletMembershipRemovals.filter((_r, index) => !deniedKeys.has(\`pallet_membership_removal:${index}\`))`).

`quarantine()` payload map: add `pallet_membership_removal: body.palletMembershipRemovals,`.

Replay path (`stored?.memberships`): add `...(stored?.membershipRemovals ? { membershipRemovals: stored.membershipRemovals } : {}),`.

Controller: add `...(result.membershipRemovals ? { membershipRemovals: result.membershipRemovals } : {}),` beside `memberships`.

- [ ] **Step 4: Run DTO tests, typecheck, lint, OpenAPI coverage**

```bash
pnpm --filter @markiro/api exec vitest run test/station-scans-dto.test.ts
pnpm --filter @markiro/api typecheck && pnpm --filter @markiro/api lint
pnpm --filter @markiro/api exec vitest run test/openapi
```

(Use whatever file the OpenAPI coverage gate lives in: `ls apps/api/test | grep -i openapi`.) Expected: PASS.

- [ ] **Step 5: Commit**

```bash
/usr/bin/git add apps/api/src/modules/station-scans/dto.ts apps/api/src/modules/station-scans/station-scans.service.ts apps/api/src/modules/station-scans/station-scans.controller.ts apps/api/test/station-scans-dto.test.ts
/usr/bin/git commit -m "feat(api): palletMembershipRemovals record kind on the station batch"
```

---

### Task 3: API — apply removals, prune emptied drafts, e2e

**Files:**

- Modify: `apps/api/src/modules/station-scans/pallet-ingest.ts` (new `applyPalletMembershipRemovals`, `pruneEmptyWarehouseDrafts`, generic `assembleMembershipOutcomes`)
- Modify: `apps/api/src/modules/station-scans/station-scans.service.ts` (wire between pre-pass and memberships; prune after memberships; response assembly)
- Test: `apps/api/test/station-scans-warehouse-pallets.e2e.test.ts`

**Interfaces:** consumes Task 2's DTOs. Produces:

```ts
export async function applyPalletMembershipRemovals(
  tx: Transaction,
  tenantId: string,
  removals: readonly PalletMembershipRemovalDto[],
  deviceId: string,
): Promise<{
  outcomes: PalletMembershipRemovalOutcomeDto[];
  changedBoxIds: string[];
  touchedPalletIds: string[];
}>;
export async function pruneEmptyWarehouseDrafts(
  tx: Transaction,
  tenantId: string,
  palletIds: readonly string[],
): Promise<string[]>; // deleted ids
```

- [ ] **Step 1: Failing e2e** — in `station-scans-warehouse-pallets.e2e.test.ts` add a helper next to `membership`:

```ts
const removal = (palletId: string, boxSscc: string) => ({
  palletId,
  boxSscc,
  removedAt: "2026-09-17T09:05:00.000Z",
  operatorId,
});
```

Insert a new `it` RIGHT AFTER `"replays a membership as a no-op and refuses the box for another device's pallet"` (w1 is still open there, holding B1 and B3; the next test closes it):

```ts
it("takes a box off the open pallet, refuses the same for a foreign device, and re-attaches in one batch", async () => {
  const before = await boxRegistryVersions();
  // Device 2 cannot remove from device 1's pallet: its own "w1" does not exist.
  const foreign = await request(app!.getHttpServer())
    .post("/station/scans")
    .set("x-api-key", device2Key)
    .send({
      batchId: `foreign-rm-${randomUUID()}`,
      items: [],
      palletMembershipRemovals: [removal("w1", B3_SSCC)],
    })
    .expect(201);
  expect(foreign.body.membershipRemovals).toEqual([
    { palletId: "w1", boxSscc: B3_SSCC, status: "not_found" },
  ]);
  expect(await memberBoxSsccs((await warehousePallets())[0]!.id)).toEqual([B1_SSCC, B3_SSCC]);

  const res = await postBatch({
    palletMembershipRemovals: [
      removal("w1", B3_SSCC),
      removal("w1", B2_SSCC),
      removal("w1", UNKNOWN_SSCC),
    ],
  });
  expect(res.body.membershipRemovals).toEqual([
    { palletId: "w1", boxSscc: B3_SSCC, status: "removed" },
    { palletId: "w1", boxSscc: B2_SSCC, status: "replayed" }, // never on it
    { palletId: "w1", boxSscc: UNKNOWN_SSCC, status: "not_found" },
  ]);
  const pallet = (await warehousePallets())[0]!;
  expect(await memberBoxSsccs(pallet.id)).toEqual([B1_SSCC]);
  const after = await boxRegistryVersions();
  expect(after.get(B3_SSCC)).toBeGreaterThan(before.get(B3_SSCC)!);
  expect(after.get(B1_SSCC)).toEqual(before.get(B1_SSCC));

  // Removal and re-scan in ONE batch: the removal applies first, so the
  // membership is a fresh `accepted`, not a replay that then gets cleared.
  const again = await postBatch({
    palletMembershipRemovals: [removal("w1", B3_SSCC)],
    palletMemberships: [membership("w1", B3_SSCC)],
  });
  expect(again.body.membershipRemovals).toEqual([
    { palletId: "w1", boxSscc: B3_SSCC, status: "replayed" },
  ]);
  expect(again.body.memberships).toEqual([
    { palletId: "w1", boxSscc: B3_SSCC, status: "accepted" },
  ]);
  expect(await memberBoxSsccs(pallet.id)).toEqual([B1_SSCC, B3_SSCC]);
});
```

And a second `it` RIGHT AFTER `"refuses a membership whose target warehouse pallet is already closed"` (by then w1 is closed AND disassembled, B3 still points at it, and B8 is a free closed box of `productId`):

```ts
it("refuses to take a box off a closed pallet, and deletes an emptied open draft with its rejections", async () => {
  const closed = await postBatch({ palletMembershipRemovals: [removal("w1", B3_SSCC)] });
  expect(closed.body.membershipRemovals).toEqual([
    { palletId: "w1", boxSscc: B3_SSCC, status: "pallet_closed" },
  ]);
  // The box keeps its pointer at the closed pallet: only disassembly moves it.
  expect(await memberBoxSsccs((await warehousePallet("w1", stationDeviceId)).id)).toContain(
    B3_SSCC,
  );

  // A fresh draft "w3": one accepted box, one refused (unknown) so it owns a rejection row.
  const opened = await postBatch({
    palletMemberships: [membership("w3", B8_SSCC), membership("w3", UNKNOWN_SSCC)],
  });
  expect(opened.body.memberships.map((m: { status: string }) => m.status)).toEqual([
    "accepted",
    "not_found",
  ]);
  const draft = await warehousePallet("w3", stationDeviceId);
  expect(draft.closedAt).toBeNull();
  expect(await rejections(draft.id)).toHaveLength(1);

  const emptied = await postBatch({ palletMembershipRemovals: [removal("w3", B8_SSCC)] });
  expect(emptied.body.membershipRemovals).toEqual([
    { palletId: "w3", boxSscc: B8_SSCC, status: "removed" },
  ]);
  const db = app!.get<Db>(DB);
  const rows = await db
    .select({ id: schema.pallets.id })
    .from(schema.pallets)
    .where(and(eq(schema.pallets.tenantId, tenantId), eq(schema.pallets.devicePalletId, "w3")));
  expect(rows).toEqual([]);
  const orphanRejections = await db
    .select({ id: schema.palletMembershipRejections.id })
    .from(schema.palletMembershipRejections)
    .where(eq(schema.palletMembershipRejections.palletId, draft.id));
  expect(orphanRejections).toEqual([]);
  // The freed box can open a NEW draft under the same device-local id.
  const reopened = await postBatch({ palletMemberships: [membership("w3", B8_SSCC)] });
  expect(reopened.body.memberships).toEqual([
    { palletId: "w3", boxSscc: B8_SSCC, status: "accepted" },
  ]);
  expect((await warehousePallet("w3", stationDeviceId)).id).not.toEqual(draft.id);
  // Leave no draft behind for the later tests.
  await postBatch({ palletMembershipRemovals: [removal("w3", B8_SSCC)] });
});
```

`B8_SSCC` is seeded and closed inside the preceding test and left unattached, which is why this test must follow it; `memberBoxSsccs` may list disassembled boxes too, hence `toContain`. If either assumption does not hold when you read the file, adjust and say so in the report. Also extend the read-only test: add `palletMembershipRemovals: [removal("l1", L1_SSCC)]` to the denied batch and assert the outcome `subscription_read_only`, a `denied` entry `{ recordKind: "pallet_membership_removal", recordIndex: 0, shiftId: null, code: "subscription_read_only" }` and a quarantine row with that kind (mirror the existing membership assertions in that test).

Run: `pnpm --filter @markiro/api exec vitest run test/station-scans-warehouse-pallets.e2e.test.ts` — expected FAIL (`membershipRemovals` undefined).

- [ ] **Step 2: Ingest** — in `pallet-ingest.ts` add:

```ts
/**
 * Takes boxes back off the device's own OPEN warehouse pallets (spec
 * 2026-09-18-open-pallet-box-removal §2). The undo of `applyPalletMemberships`,
 * and the second relaxation of 06d's «pallet_id is never cleared»: a draft
 * pallet has no SSCC, no label and no export, so nothing refers to it.
 *
 * Runs BEFORE memberships so a removal and a re-scan of the same box in one
 * batch land in that order. Never creates a pallet row: a removal naming a
 * pallet the server has never seen is `not_found`, which is harmless.
 */
export async function applyPalletMembershipRemovals(
  tx: Transaction,
  tenantId: string,
  removals: readonly PalletMembershipRemovalDto[],
  deviceId: string,
): Promise<{
  outcomes: PalletMembershipRemovalOutcomeDto[];
  changedBoxIds: string[];
  touchedPalletIds: string[];
}> {
  const ordered = [...removals]
    .map((removal, index) => ({ removal, index }))
    .sort((a, b) => {
      const left = `${a.removal.palletId}|${a.removal.boxSscc}`;
      const right = `${b.removal.palletId}|${b.removal.boxSscc}`;
      return left < right ? -1 : left > right ? 1 : 0;
    });
  const outcomes = new Array<PalletMembershipRemovalOutcomeDto>(removals.length);
  const changedBoxIds: string[] = [];
  const touched = new Set<string>();
  const palletByDeviceId = new Map<string, { id: string; open: boolean }>();

  for (const { removal, index } of ordered) {
    let pallet = palletByDeviceId.get(removal.palletId);
    if (pallet === undefined) {
      const [row] = await tx
        .select({
          id: schema.pallets.id,
          closedAt: schema.pallets.closedAt,
          disassembledAt: schema.pallets.disassembledAt,
        })
        .from(schema.pallets)
        .where(
          and(
            eq(schema.pallets.tenantId, tenantId),
            eq(schema.pallets.kind, "warehouse"),
            eq(schema.pallets.deviceId, deviceId),
            eq(schema.pallets.devicePalletId, removal.palletId),
          ),
        )
        .limit(1);
      pallet = row
        ? { id: row.id, open: row.closedAt === null && row.disassembledAt === null }
        : { id: "", open: false };
      palletByDeviceId.set(removal.palletId, pallet);
    }
    const base = { palletId: removal.palletId, boxSscc: removal.boxSscc };
    if (pallet.id === "") {
      outcomes[index] = { ...base, status: "not_found" };
      continue;
    }
    const updated = await tx.execute<{ id: string }>(sql`
      UPDATE boxes b
         SET pallet_id = NULL, updated_at = now()
        FROM pallets tp
       WHERE b.tenant_id = ${tenantId} AND b.sscc = ${removal.boxSscc}
         AND tp.tenant_id = b.tenant_id AND tp.id = b.pallet_id AND tp.id = ${pallet.id}
         AND tp.closed_at IS NULL AND tp.disassembled_at IS NULL
      RETURNING b.id
    `);
    const removed = updated.rows[0];
    if (removed) {
      changedBoxIds.push(removed.id);
      touched.add(pallet.id);
      outcomes[index] = { ...base, status: "removed" };
      continue;
    }
    const [box] = await tx
      .select({ palletId: schema.boxes.palletId })
      .from(schema.boxes)
      .where(and(eq(schema.boxes.tenantId, tenantId), eq(schema.boxes.sscc, removal.boxSscc)))
      .limit(1);
    // Ordered by what the operator can act on: a box that is simply not on
    // this pallet any more is the common replay; a closed pallet is the one
    // answer that sends them to the disassemble flow instead.
    if (!box) outcomes[index] = { ...base, status: "not_found" };
    else if (box.palletId !== pallet.id) outcomes[index] = { ...base, status: "replayed" };
    else if (!pallet.open) outcomes[index] = { ...base, status: "pallet_closed" };
    else throw new Error("unclassified membership removal refusal");
  }
  return { outcomes, changedBoxIds, touchedPalletIds: [...touched] };
}

/**
 * Deletes every named warehouse pallet that is still an open draft and holds
 * no box any more, with its rejection rows (FK). Runs AFTER memberships, so a
 * batch that empties a draft and refills it in the same delivery keeps it.
 */
export async function pruneEmptyWarehouseDrafts(
  tx: Transaction,
  tenantId: string,
  palletIds: readonly string[],
): Promise<string[]> {
  const deleted: string[] = [];
  for (const palletId of [...palletIds].sort()) {
    const [empty] = await tx
      .select({ id: schema.pallets.id })
      .from(schema.pallets)
      .where(
        and(
          eq(schema.pallets.tenantId, tenantId),
          eq(schema.pallets.id, palletId),
          eq(schema.pallets.kind, "warehouse"),
          isNull(schema.pallets.closedAt),
          isNull(schema.pallets.disassembledAt),
          sql`NOT EXISTS (SELECT 1 FROM boxes b WHERE b.tenant_id = ${tenantId} AND b.pallet_id = ${palletId})`,
        ),
      )
      .limit(1);
    if (!empty) continue;
    await tx
      .delete(schema.palletMembershipRejections)
      .where(
        and(
          eq(schema.palletMembershipRejections.tenantId, tenantId),
          eq(schema.palletMembershipRejections.palletId, palletId),
        ),
      );
    await tx
      .delete(schema.pallets)
      .where(and(eq(schema.pallets.tenantId, tenantId), eq(schema.pallets.id, palletId)));
    deleted.push(palletId);
  }
  return deleted;
}
```

Make `assembleMembershipOutcomes` generic so it serves both lists:

```ts
export function assembleMembershipOutcomes<
  R extends { palletId: string; boxSscc: string },
  O extends { palletId: string; boxSscc: string; status: string },
>(
  all: readonly R[],
  deniedIndexes: ReadonlySet<number>,
  applied: readonly O[],
): (O | (R & { status: "subscription_read_only" }))[];
```

(keep the body; the denied branch returns `{ palletId, boxSscc, status: "subscription_read_only" as const }`). Adjust the two call sites' types (`PalletMembershipOutcomeDto[]` / `PalletMembershipRemovalOutcomeDto[]`) with a cast-free assignment — if the generic return type does not assign cleanly, write a second small function `assembleRemovalOutcomes` with the same body rather than casting.

Import `isNull` from drizzle-orm and the two new DTO types in `pallet-ingest.ts`.

- [ ] **Step 3: Wire the service** — in `station-scans.service.ts`, before the `// Warehouse memberships…` block:

```ts
// Removals BEFORE memberships (spec 2026-09-18 §2): a box taken off and
// re-scanned before the next sync arrives as both records, and the
// membership must land on a box that is already free.
let removalOutcomes: PalletMembershipRemovalOutcomeDto[] = [];
let removalTouched: string[] = [];
if (body.palletMembershipRemovals.length > 0) {
  const applied = await applyPalletMembershipRemovals(
    tx,
    tenantId,
    body.palletMembershipRemovals,
    authenticatedTerminalId,
  );
  removalOutcomes = applied.outcomes;
  removalTouched = applied.touchedPalletIds;
  await this.advanceBoxRegistryVersions(tx, tenantId, applied.changedBoxIds);
}
```

After the memberships block (before `// Pallet closures…`):

```ts
// A draft this batch emptied and did not refill is deleted: it has no
// SSCC, no label and no export, and the device already forgot it.
if (removalTouched.length > 0) {
  const pruned = await pruneEmptyWarehouseDrafts(tx, tenantId, removalTouched);
  for (const id of pruned) {
    for (const [key, palletId] of palletsByKey) if (palletId === id) palletsByKey.delete(key);
  }
}
```

Response assembly: build `membershipRemovals` from `submittedRemovals` and the `pallet_membership_removal` denied indexes, and add `...(membershipRemovals.length > 0 ? { membershipRemovals } : {})` to `result`.

- [ ] **Step 4: Run e2e + package gates**

```bash
DATABASE_URL=… pnpm --filter @markiro/api exec vitest run test/station-scans-warehouse-pallets.e2e.test.ts test/station-scans.service.test.ts test/box-registry-pallets.e2e.test.ts test/pallets.e2e.test.ts test/station-scans-dto.test.ts
pnpm --filter @markiro/api typecheck && pnpm --filter @markiro/api lint
```

Expected: PASS. If `pallets.e2e.test.ts` does not exist, list `apps/api/test | grep pallet` and run those.

- [ ] **Step 5: Commit**

```bash
/usr/bin/git add apps/api/src/modules/station-scans/pallet-ingest.ts apps/api/src/modules/station-scans/station-scans.service.ts apps/api/test/station-scans-warehouse-pallets.e2e.test.ts
/usr/bin/git commit -m "feat(api): take a box off an open warehouse pallet; prune emptied drafts"
```

---

### Task 4: Handheld storage — removal queue, Room 19, DAO additions

**Files:**

- Create: `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/storage/PalletMembershipRemovalEntities.kt`
- Modify: `core/storage/HandheldDatabase.kt` (entity list, `palletMembershipRemovalDao()`, version 19), `core/storage/Migrations.kt` (`MIGRATION_18_19`), `core/storage/StorageModule.kt` (register), `core/storage/PalletMembershipEntities.kt` (DAO `delete`, `deleteForPallet`), `core/storage/PalletDao.kt` (`delete`), `core/storage/BoxRegistryEntities.kt` (`clearPallet`)
- Modify tests: every test that lists `MIGRATION_17_18` (`grep -rl MIGRATION_17_18 app/src/test`) gets `MIGRATION_18_19` appended
- Create test: `app/src/test/kotlin/app/markiro/handheld/core/storage/PalletMembershipRemovalStorageTest.kt`

**Interfaces (produces):**

```kotlin
object RemovalStatus { const val PENDING = "pending"; const val SENT = "sent" }

@Entity(tableName = "pallet_membership_removals", indices = [Index(value = ["status", "id"])])
data class PalletMembershipRemovalEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val palletId: String, val sscc: String, val removedAt: String, val operatorId: String?, val status: String,
)

@Dao interface PalletMembershipRemovalDao {
    @Insert(onConflict = OnConflictStrategy.ABORT) suspend fun insert(row: PalletMembershipRemovalEntity): Long
    @Query("SELECT * FROM pallet_membership_removals WHERE status = 'pending' AND palletId = :palletId AND sscc = :sscc LIMIT 1")
    suspend fun pendingFor(palletId: String, sscc: String): PalletMembershipRemovalEntity?
    @Query("SELECT COUNT(*) FROM pallet_membership_removals WHERE sscc = :sscc") suspend fun queuedFor(sscc: String): Int
    @Query("SELECT * FROM pallet_membership_removals WHERE status = 'pending' ORDER BY id LIMIT :limit") suspend fun pending(limit: Int): List<PalletMembershipRemovalEntity>
    @Query("SELECT * FROM pallet_membership_removals WHERE status = 'sent' ORDER BY id LIMIT :limit") suspend fun sent(limit: Int): List<PalletMembershipRemovalEntity>
    @Query("UPDATE pallet_membership_removals SET status = 'sent' WHERE status = 'pending' AND id = :id") suspend fun markSent(id: Long)
    @Query("UPDATE pallet_membership_removals SET status = 'pending' WHERE status = 'sent'") suspend fun revertSent()
    @Query("DELETE FROM pallet_membership_removals WHERE id = :id") suspend fun delete(id: Long)
    @Query("SELECT COUNT(*) FROM pallet_membership_removals WHERE status IN ('pending', 'sent')") fun observePendingCount(): Flow<Int>
    @Query("SELECT * FROM pallet_membership_removals ORDER BY id") suspend fun all(): List<PalletMembershipRemovalEntity>
    @Query("DELETE FROM pallet_membership_removals") suspend fun clear()
}
```

Plus `PalletMembershipDao.delete(palletId, sscc): Int` (any status), `PalletMembershipDao.deleteForPallet(palletId): Int`, `PalletDao.delete(palletId): Int` (`DELETE FROM pallets WHERE palletId = :palletId AND closedAt IS NULL`), `BoxRegistryDao.clearPallet(sscc)` (`UPDATE box_registry SET palletId = NULL, palletSscc = NULL, palletActive = 0 WHERE sscc = :sscc`).

- [ ] **Step 1: Failing storage + migration tests**

`PalletMembershipRemovalStorageTest.kt` (in-memory Room, same setup as `PalletStorageTest`): insert two rows for the same key, `pendingFor` finds the pending one, `markSent(id)` then `pendingFor` returns null and `queuedFor(sscc) == 2`, `revertSent` brings it back, `delete(id)` removes it, `observePendingCount` counts pending+sent. Also `BoxRegistryDao.clearPallet` and `PalletDao.delete` (an open pallet is deleted, a closed one is not).

In `WarehousePalletMigrationTest.kt` add a test `aVersionEighteenDeviceGainsTheRemovalQueue`: build the DB, drop `pallet_membership_removals` and set `PRAGMA user_version = 18` with the raw SQLite handle, reopen through `database(name)` (with `MIGRATION_18_19` in the list), and assert `db.palletMembershipRemovalDao().all()` is empty (no throw = schema validated by Room). Append `MIGRATION_18_19` to every migration list found by `grep -rl MIGRATION_17_18 app/src/test`.

Run: `./gradlew --no-daemon testDebugUnitTest --tests '*PalletMembershipRemovalStorageTest*' --tests '*WarehousePalletMigrationTest*'` — expected: compile failure / FAIL.

- [ ] **Step 2: Implement** — entity/DAO file as above; `HANDHELD_DATABASE_VERSION = 19`; add the entity to `@Database(entities = […])` and the abstract DAO getter; in `Migrations.kt`:

```kotlin
/**
 * Room 18 → 19 (spec 2026-09-18-open-pallet-box-removal §3.1): the removal
 * queue. Additive; nothing existing is touched.
 */
val MIGRATION_18_19 = object : Migration(18, 19) {
    override fun migrate(db: SupportSQLiteDatabase) {
        db.execSQL(
            "CREATE TABLE IF NOT EXISTS `pallet_membership_removals` (`id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, " +
                "`palletId` TEXT NOT NULL, `sscc` TEXT NOT NULL, `removedAt` TEXT NOT NULL, `operatorId` TEXT, `status` TEXT NOT NULL)",
        )
        db.execSQL("CREATE INDEX IF NOT EXISTS `index_pallet_membership_removals_status_id` ON `pallet_membership_removals` (`status`, `id`)")
    }
}
```

Register it in `StorageModule.kt`. Add the three DAO queries listed under Interfaces.

- [ ] **Step 3: Run the focused tests, then the storage package**

```bash
./gradlew --no-daemon testDebugUnitTest --tests 'app.markiro.handheld.core.storage.*'
```

Expected: PASS (Room's schema validation on open is what proves the migration DDL matches the entity).

- [ ] **Step 4: Commit**

```bash
/usr/bin/git add apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/storage apps/handheld/app/src/test/kotlin/app/markiro/handheld/core
/usr/bin/git commit -m "feat(handheld): pallet membership removal queue (Room 19)"
```

---

### Task 5: Handheld — `WarehousePallets.remove` for every status, draft deletion, attach exemption

**Files:**

- Modify: `core/pallets/WarehousePallets.kt`
- Modify: `feature/pallets/PalletsFeatureModule.kt` (`PalletsGateway.remove(palletId, sscc, operatorId)`), `feature/pallets/PalletsViewModel.kt` (`remove` passes `operatorId`)
- Test: `core/pallets/WarehousePalletsTest.kt`, `feature/pallets/PalletsViewModelTest.kt` (FakeGateway signature)

**Interfaces:** `suspend fun remove(palletId: String, sscc: String, operatorId: String?): Boolean`.

- [ ] **Step 1: Rewrite the failing test** — replace `removeOnlyTakesAPendingRowAndReleasesTheClaim` with:

```kotlin
    /** Spec 2026-09-18: a sent or accepted row comes off too, through a queued removal. */
    @Test
    fun removeTakesAnyNonRejectedRowQueuesARemovalAndFreesTheMirrorRow() = runTest {
        product()
        registry("034600682000000018"); registry("034600682000000025")
        val r = pallets.attach("034600682000000018", null) as AttachResult.Attached
        pallets.attach("034600682000000025", null)
        db.palletMembershipDao().markSent(r.pallet.palletId, "034600682000000025")
        db.palletMembershipDao().markAccepted(r.pallet.palletId, "034600682000000025", "t")
        // Mirror the registry refresh that follows an accepted membership.
        registry("034600682000000025", palletActive = true, localPalletId = r.pallet.palletId)

        assertTrue(pallets.remove(r.pallet.palletId, "034600682000000025", "op-1"))
        val row = db.boxRegistryDao().bySscc("034600682000000025")!!
        assertNull(row.localPalletId); assertFalse(row.palletActive); assertNull(row.palletId)
        assertEquals(listOf("034600682000000018"), db.palletMembershipDao().byPallet(r.pallet.palletId).map { it.sscc })
        val queued = db.palletMembershipRemovalDao().all()
        assertEquals(1, queued.size)
        assertEquals("034600682000000025" to RemovalStatus.PENDING, queued[0].sscc to queued[0].status)
        assertEquals("op-1", queued[0].operatorId)
        // The pallet still holds one box, so it stays open.
        assertNotNull(db.palletDao().get(r.pallet.palletId))
        // A second removal of the same box before sync reuses the pending row.
        pallets.attach("034600682000000025", null)
        assertTrue(pallets.remove(r.pallet.palletId, "034600682000000025", null))
        assertEquals(1, db.palletMembershipRemovalDao().all().size)
        // …but a SENT removal belongs to a pinned batch and gets a sibling.
        db.palletMembershipRemovalDao().markSent(queued[0].id)
        pallets.attach("034600682000000025", null)
        assertTrue(pallets.remove(r.pallet.palletId, "034600682000000025", null))
        assertEquals(2, db.palletMembershipRemovalDao().all().size)
    }

    @Test
    fun removingTheLastBoxDeletesTheOpenDraftWithoutBurningASerial() = runTest {
        product()
        registry("034600682000000018")
        val r = pallets.attach("034600682000000018", null) as AttachResult.Attached
        assertTrue(pallets.remove(r.pallet.palletId, "034600682000000018", null))
        assertNull(db.palletDao().get(r.pallet.palletId))
        assertNull(pallets.observeOpen().first())
        assertEquals(0, db.ssccPoolDao().countBurned()) // use whatever the pool exposes; if nothing, assert `pool` state as the existing close tests do
        // The next scan opens a NEW draft.
        val next = pallets.attach("034600682000000018", null) as AttachResult.Attached
        assertTrue(next.pallet.palletId != r.pallet.palletId)
    }

    @Test
    fun removeRefusesAMissingOrRejectedRow() = runTest {
        product()
        registry("034600682000000018")
        val r = pallets.attach("034600682000000018", null) as AttachResult.Attached
        assertFalse(pallets.remove(r.pallet.palletId, "034600682000000099", null))
        db.palletMembershipDao().markRejected(r.pallet.palletId, "034600682000000018", "already_on_pallet", null, "t")
        assertFalse(pallets.remove(r.pallet.palletId, "034600682000000018", null))
        assertTrue(db.palletMembershipRemovalDao().all().isEmpty())
    }

    /** The registry may still show the device's own claim that a queued removal undoes. */
    @Test
    fun aQueuedRemovalLetsTheBoxBeScannedAgainDespiteAStaleActiveFlag() = runTest {
        product()
        registry("034600682000000018")
        val r = pallets.attach("034600682000000018", null) as AttachResult.Attached
        assertTrue(pallets.remove(r.pallet.palletId, "034600682000000018", null))
        registry("034600682000000018", palletActive = true) // stale delta: server still says "on an open pallet"
        assertTrue(pallets.attach("034600682000000018", null) is AttachResult.Attached)
        // Without a queued removal the same row is the real foreign-open-pallet refusal.
        db.palletMembershipRemovalDao().clear()
        db.palletMembershipDao().clear()
        registry("034600682000000025", palletActive = true)
        assertTrue(pallets.attach("034600682000000025", null) is AttachResult.OnAnotherPallet)
    }
```

(For the serial assertion: look at how `closingBurnsExactlyOneSerial`-style tests in this file read the pool and reuse that; do not invent a DAO method.)

Run: `./gradlew --no-daemon testDebugUnitTest --tests '*WarehousePalletsTest*'` — expected: compile failure.

- [ ] **Step 2: Implement `remove`** in `WarehousePallets.kt`:

```kotlin
    /**
     * Takes a box back off the open pallet, whatever its membership status
     * (spec 2026-09-18-open-pallet-box-removal §3.2). The row is gone at once;
     * the server learns through a queued removal record. A `sent` removal
     * belongs to a pinned batch and is never rewritten, so a later removal of
     * the same box is a NEW row; a `pending` one is reused so a batch never
     * carries the same key twice.
     *
     * Takes [PalletLock] like [attach] and [close]: without it, a `remove`
     * could interleave with a `close` that read `countOnPallet` for the same
     * pallet, closing with a stale count or racing the membership delete.
     */
    suspend fun remove(palletId: String, sscc: String, operatorId: String?): Boolean = db.recovery.exclusive {
        lock.withLock {
            db.recovery.commit {
                val row = db.palletMembershipDao().byPallet(palletId).firstOrNull { it.sscc == sscc }
                if (row == null || row.status == MembershipStatus.REJECTED) return@commit false
                db.palletMembershipDao().delete(palletId, sscc)
                db.boxRegistryDao().release(sscc)
                // Optimistic: the server will say exactly this once the removal lands.
                db.boxRegistryDao().clearPallet(sscc)
                if (db.palletMembershipRemovalDao().pendingFor(palletId, sscc) == null) {
                    db.palletMembershipRemovalDao().insert(
                        PalletMembershipRemovalEntity(
                            palletId = palletId, sscc = sscc, removedAt = Iso.format(clock()),
                            operatorId = operatorId, status = RemovalStatus.PENDING,
                        ),
                    )
                }
                val pallet = db.palletDao().get(palletId)
                if (pallet != null && pallet.closedAt == null && db.palletMembershipDao().countOnPallet(palletId) == 0) {
                    // An empty draft is nothing: no SSCC, no label, no serial burned.
                    db.palletMembershipDao().deleteForPallet(palletId)
                    db.boxRegistryDao().releaseAll(palletId)
                    db.palletDao().delete(palletId)
                }
                true
            }
        }
    }
```

In `attachOwned`, change the null-SSCC refusal:

```kotlin
        // A queued removal is this device's own undo of the claim the registry
        // may still show; the server will clear it in the same batch order.
        if (box.palletActive && db.palletMembershipRemovalDao().queuedFor(sscc) == 0) return AttachResult.OnAnotherPallet(box.palletSscc)
```

Update the class doc comment's sentence about removal. Gateway: `suspend fun remove(palletId: String, sscc: String, operatorId: String?): Boolean` in the interface, the repository, and the test `FakeGateway` (store `removed = palletId to sscc`, ignore operator). View model: `gateway.remove(pallet.palletId, sscc, operatorId)`.

- [ ] **Step 3: Run**

```bash
./gradlew --no-daemon testDebugUnitTest --tests '*WarehousePalletsTest*' --tests '*PalletsViewModelTest*'
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
/usr/bin/git add apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/pallets/WarehousePallets.kt apps/handheld/app/src/main/kotlin/app/markiro/handheld/feature/pallets apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/pallets/WarehousePalletsTest.kt apps/handheld/app/src/test/kotlin/app/markiro/handheld/feature/pallets/PalletsViewModelTest.kt
/usr/bin/git commit -m "feat(handheld): take any box off the open warehouse pallet; empty draft vanishes"
```

---

### Task 6: Handheld — sync channel for removals

**Files:**

- Modify: `core/network/PalletDtos.kt` (`PalletMembershipRemovalDto`), `core/network/SyncDtos.kt` (`SyncBatchRequest.palletMembershipRemovals`), `core/storage/MetaStore.kt` (`SYNC_PENDING_MEMBERSHIP_REMOVAL_COUNT = "sync_pending_membership_removal_count"`), `core/sync/SyncEngine.kt`
- Create test: `core/sync/SyncPalletMembershipRemovalsTest.kt`
- Modify test: `core/sync/SyncLimitsFixturesTest.kt`

**Interfaces:** `SyncEngine.MAX_PALLET_MEMBERSHIP_REMOVALS = 100`.

- [ ] **Step 1: Failing tests** — `SyncPalletMembershipRemovalsTest.kt`, same scaffold as `SyncPalletMembershipsTest` (copy `setUp`/`engine`/`bodyOf`/`takeRequest`/`warehousePallet`/`boxRegistry`), with helpers:

```kotlin
    private suspend fun removal(palletId: String, sscc: String) = db.palletMembershipRemovalDao().insert(
        PalletMembershipRemovalEntity(palletId = palletId, sscc = sscc, removedAt = "2026-09-18T08:20:00.000Z", operatorId = "op-1", status = RemovalStatus.PENDING),
    )
    private fun outcome(vararg entries: String) = MockResponse().setResponseCode(201)
        .setBody("""{"applied":0,"alreadyApplied":false,"conflicts":[],"membershipRemovals":[${entries.joinToString(",")}]}""")
```

Tests:

1. `removalsRideTheBatchInOrderAndAreDeletedOnAnyAnswer`: two removals; server answers `removed` and `pallet_closed`; body's `palletMembershipRemovals[].boxSscc` in insertion order with `removedAt`/`operatorId` present; afterwards `all()` is empty; the `removed` box's registry row has `palletActive == false` and `palletId == null` (seed it active via `boxRegistry` with `palletId = "srv", palletActive = true`), the `pallet_closed` one is untouched.
2. `aMissingOrShortRemovalsAnswerDoesNotAckTheRows`: answer without the array → `drainAll()` false, rows stay `sent`.
3. `aRemovalQueuedWhileABatchIsInFlightWaitsForTheNextOne`: mirror the membership test (500 first, then two answers; the retry carries one removal and the same `batchId`, the next batch carries the other).
4. `theQueueIndicatorCountsRemovalsToo`: `engine().state.first { it.pending == 1 }`.
5. `aRemovalAndAMembershipShareOneBatch`: a pending membership and a pending removal for different boxes; server answers both arrays; both acked.

`SyncLimitsFixturesTest`: add

```kotlin
        // Removals are bounded by the MEMBERSHIP cap: a removal is the undo of one membership.
        assertEquals(
            fixtures.getValue("maxPalletMembershipsPerSyncBatch").jsonPrimitive.int,
            SyncEngine.MAX_PALLET_MEMBERSHIP_REMOVALS,
        )
```

Run the two test classes — expected: compile failure.

- [ ] **Step 2: Implement** — `PalletDtos.kt`:

```kotlin
/** A box taken back off the device's own open warehouse pallet; the undo of [PalletMembershipDto]. */
@Serializable
data class PalletMembershipRemovalDto(val palletId: String, val boxSscc: String, val removedAt: String, val operatorId: String?)
```

`SyncDtos.kt`: `val palletMembershipRemovals: List<PalletMembershipRemovalDto> = emptyList(),` after `palletMemberships`.

`SyncEngine.kt`, mirroring every membership line (search `membership` and add the twin beside each):

- `pending` combine: `db.palletMembershipRemovalDao().observePendingCount(),`
- limit: `val removalLimit = if (pendingCeiling != null) meta.get(MetaStore.SYNC_PENDING_MEMBERSHIP_REMOVAL_COUNT)?.toIntOrNull() ?: 0 else MAX_PALLET_MEMBERSHIP_REMOVALS`
- rows: `var removalRows = when { removalLimit == 0 -> emptyList(); pendingCeiling != null -> db.palletMembershipRemovalDao().sent(removalLimit); else -> db.palletMembershipRemovalDao().pending(removalLimit) }`
- emptiness check adds `&& removalRows.isEmpty()`
- inside the pin commit: re-read pending for a fresh batch; signature gains a seventh component `":" + idSignature(removalRows.map { it.id.toString() })`; `meta.put(MetaStore.SYNC_PENDING_MEMBERSHIP_REMOVAL_COUNT, removalRows.size.toString())`; `for (r in removalRows) db.palletMembershipRemovalDao().markSent(r.id)`
- request: `removalRows.map { PalletMembershipRemovalDto(it.palletId, it.sscc, it.removedAt, it.operatorId) }`
- guard: `if (removalRows.isNotEmpty() && parsed.membershipRemovals?.size != removalRows.size) return Step.FAILED`
- outcomes, inside the ack commit:

```kotlin
            if (removalRows.isNotEmpty()) {
                parsed.membershipRemovals?.forEachIndexed { i, outcome ->
                    val row = removalRows[i]
                    // Terminal either way: the record is consumed. Only an answer
                    // that says the box is free updates the mirror; a closed
                    // pallet or a quarantined record leaves it to the next refresh.
                    when (outcome.status) {
                        "removed", "replayed", "not_found" -> db.boxRegistryDao().clearPallet(row.sscc)
                        else -> Log.w(TAG, "membership removal ${row.palletId}/${row.sscc}: ${outcome.status}")
                    }
                    db.palletMembershipRemovalDao().delete(row.id)
                }
            }
```

(use the file's existing logging idiom instead of `Log.w` if it has one)

- ack cleanup and `clearPending`: `meta.remove(MetaStore.SYNC_PENDING_MEMBERSHIP_REMOVAL_COUNT)` and `db.palletMembershipRemovalDao().revertSent()`
- `BatchResponse` gains `val membershipRemovals: List<RemovalOutcome>?` with `private class RemovalOutcome(val palletId: String, val boxSscc: String, val status: String)` parsed from `obj["membershipRemovals"]` with the same shape guard as memberships
- companion: `const val MAX_PALLET_MEMBERSHIP_REMOVALS = 100` with a doc comment pointing at the membership cap.

- [ ] **Step 3: Run**

```bash
./gradlew --no-daemon testDebugUnitTest --tests 'app.markiro.handheld.core.sync.*'
```

Expected: PASS, including `SyncBatchIdBoundTest` (the id is hashed per channel, so a seventh signature must still fit; if that test fails, report rather than raising the bound).

- [ ] **Step 4: Commit**

```bash
/usr/bin/git add apps/handheld/app/src/main/kotlin/app/markiro/handheld/core apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/sync
/usr/bin/git commit -m "feat(handheld): sync channel for pallet membership removals"
```

---

### Task 7: Handheld UI, README, CHANGELOG

**Files:**

- Modify: `feature/pallets/PalletsScreens.kt` (`MemberRow` gate), `apps/handheld/README.md` (pallets section), `apps/handheld/CHANGELOG.md`
- Test: `feature/pallets/PalletsScreensTest.kt`

- [ ] **Step 1: Failing screen test** — replace `aPendingRowCanBeTakenOffAndASentOneCannot` with:

```kotlin
    /** Spec 2026-09-18: every non-rejected box can be taken off, whatever its sync status. */
    @Test
    fun anyNonRejectedRowCanBeTakenOff() {
        val removed = mutableListOf<String>()
        compose.setContent {
            MarkiroTheme {
                PalletsRoute(
                    PalletsUi(
                        pallet = pallet, productName = "Вода 0,5 л", boxCount = 3, capacity = 12,
                        members = listOf(
                            member("034600682000000014", MembershipStatus.SENT),
                            member("034600682000000021", MembershipStatus.PENDING),
                            member("034600682000000038", MembershipStatus.ACCEPTED),
                        ),
                    ),
                    PalletsCallbacks(onRemove = { removed += it }),
                )
            }
        }
        compose.onAllNodesWithContentDescription("Убрать с паллеты").assertCountEquals(3)
        compose.onAllNodesWithContentDescription("Убрать с паллеты")[0].performClick()
        // Rows are listed newest first.
        assertEquals(listOf("034600682000000038"), removed)
    }
```

Run `./gradlew --no-daemon testDebugUnitTest --tests '*PalletsScreensTest*'` — expected FAIL (count 1).

- [ ] **Step 2: Implement** — `MemberRow`: `if (member.status != MembershipStatus.REJECTED)` and rewrite its doc comment: «Убрать» is offered for every box still on the pallet; a sent or accepted row is undone through a queued removal (spec 2026-09-18).

README «Паллеты (складская сборка)»: replace the `localPalletId` sentence's "cleared when the box is removed or…" as needed and add one paragraph after the closing-rules paragraph:

> Any box can be taken off the open pallet with «Убрать с паллеты», whatever its sync status. A pending row is simply deleted; a sent or accepted one is undone by a queued `pallet_membership_removals` record that rides the next batch ahead of any memberships, so the server clears `boxes.pallet_id` before a re-scan of the same box lands. Taking off the last box deletes the open pallet on the device and, once the removal is applied, on the server — no serial is burned and nothing is printed. Storage is Room 19 (the removal queue).

Update the "Storage lives at Room database version 18" sentence to 19.

CHANGELOG: add at the top, under a new `## 1.0.6` heading (check the last released version in the file and bump the patch):

```
- Паллеты: короб можно убрать с открытой паллеты в любом статусе, а не только пока
  он «в очереди». Если убран последний короб, паллета исчезает без сжигания номера
  SSCC и без этикетки.
```

- [ ] **Step 3: Full handheld gates**

```bash
ANDROID_HOME=$HOME/Library/Android/sdk ./gradlew --no-daemon testDebugUnitTest lintDebug assembleDebug
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
/usr/bin/git add apps/handheld/app/src/main/kotlin/app/markiro/handheld/feature/pallets/PalletsScreens.kt apps/handheld/app/src/test/kotlin/app/markiro/handheld/feature/pallets/PalletsScreensTest.kt apps/handheld/README.md apps/handheld/CHANGELOG.md
/usr/bin/git commit -m "feat(handheld): «Убрать с паллеты» for every box on the open pallet"
```

---

### Task 8: Cross-package gates and docs check

- [ ] Run `pnpm --filter @markiro/domain test` (fixture test unchanged), `pnpm --filter @markiro/db test` (with DATABASE_URL), `pnpm --filter @markiro/api test` (with the full env), `pnpm --filter @markiro/api build`, `pnpm format:check`, `/usr/bin/git diff --check`.
- [ ] Confirm `docs/superpowers/specs/2026-09-18-open-pallet-box-removal-design.md` still matches what was built; note deviations in the PR body.
- [ ] No commit needed unless formatting changed something; if so, commit `style: prettier`.
