# Pickup Day Limits Off By Default

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop charging employees a daily pickup allowance unless a tenant asks
for one — off for every existing tenant and off for every new one, with the
cabinet switch left in place.

**Architecture:** One lever moves: `pickup_tenant_policies.limits_enabled`. Its
column default flips, both insert sites follow, and a migration turns it off for
tenants that already exist.

**Tech Stack:** Drizzle, Postgres, NestJS, Vitest.

**Decided:** in brainstorming on 2026-09-14 — "выкл по умолчанию, механизм
остаётся". This is plan 0 of the handheld write-off set and is independent of
the other three.

## Scope decision, and what it deliberately leaves alone

`limits_enabled` is the tenant-wide switch: the effective policy is
`limitsEnabled && limitMode === "limited"` (`resolveActiveEmployee`), so turning
it off disables the allowance whatever the per-employee rows say.

**`employee_pickup_policies.limit_mode` keeps its `limited` default.** That
column describes how an employee _would_ be treated if a tenant turns limits back
on. Flipping it too would mean a tenant that re-enables the switch silently gets
no limits for anyone added after this change — the opposite of what re-enabling
means. The mechanism stays intact; only the master switch moves.

`kiosks.day_limit_per_employee` also keeps its default: new orders do not read
it (see the comment in `kiosk-orders.e2e.test.ts`'s `createPolicySubject`), and
changing a field nothing reads is noise.

## Global Constraints

- Add a NEW migration; never rewrite an applied one.
- The backfill touches every existing tenant's policy row. It sets a flag; it
  does not delete or rewrite limit configuration, so a tenant that wants limits
  back only has to flip the switch.
- `pnpm --filter @markiro/db build` before API tests.

## File Structure

| File                                                                   | Change                                                     |
| ---------------------------------------------------------------------- | ---------------------------------------------------------- |
| `packages/db/src/schema/pickup.ts`                                     | `limitsEnabled` default `false`                            |
| `packages/db/migrations/0151_pickup_limits_off_by_default.sql`         | Column default + backfill                                  |
| `packages/db/migrations/meta/_journal.json`                            | Journal entry                                              |
| `apps/api/src/auth/auth.setup.ts`                                      | New organisation inserts `false`                           |
| `apps/api/src/modules/platform-tenants/tenant-provisioning.service.ts` | Provisioning inserts `false`                               |
| `apps/api/test/kiosk-orders.e2e.test.ts`                               | Suites that rely on limits must now enable them explicitly |

---

### Task 1: The switch defaults to off

**Files:**

- Modify: `packages/db/src/schema/pickup.ts`
- Create: `packages/db/migrations/0151_pickup_limits_off_by_default.sql`
- Modify: `packages/db/migrations/meta/_journal.json`
- Modify: `apps/api/src/auth/auth.setup.ts`
- Modify: `apps/api/src/modules/platform-tenants/tenant-provisioning.service.ts`
- Test: `apps/api/test/pickup-limits-default.e2e.test.ts` (create)

**Interfaces:**

- Produces: no new exports. Behaviour: a tenant with no explicit choice does not
  charge an allowance.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/pickup-limits-default.e2e.test.ts`. Sign up a fresh tenant
(the existing e2e files show the helper), seed an employee on the DEFAULT policy
— do not set `limitMode` or `dayLimit` — and file more items than the old default
of 5 allowed:

```ts
it("does not charge a daily allowance to a tenant that never asked for one", async () => {
  const res = await request(app!.getHttpServer())
    .post("/kiosk/orders")
    .set("x-kiosk-token", TOKEN)
    .send({
      deviceSeq: 1,
      badgeCode: BADGE,
      reason: "buy",
      items: Array.from({ length: 7 }, (_, i) => ({ rawKm: km(`D${i}`) })),
    })
    .expect(201);
  expect(res.body.conflicts).toEqual([]);
  expect(res.body.itemCount).toBe(7);
});

it("still charges one once the tenant turns limits on", async () => {
  await db
    .update(schema.pickupTenantPolicies)
    .set({ limitsEnabled: true })
    .where(eq(schema.pickupTenantPolicies.tenantId, tenantId));

  const res = await request(app!.getHttpServer())
    .post("/kiosk/orders")
    .set("x-kiosk-token", TOKEN)
    .send({
      deviceSeq: 2,
      badgeCode: BADGE,
      reason: "buy",
      items: Array.from({ length: 7 }, (_, i) => ({ rawKm: km(`E${i}`) })),
    })
    .expect(201);
  expect(res.body.conflicts).toContainEqual(expect.objectContaining({ reason: "over_limit" }));
});
```

The second test is the one that proves the mechanism survived rather than being
deleted — without it this change is indistinguishable from ripping limits out.

- [ ] **Step 2: Run it to verify it fails**

```bash
set -a; source .env; set +a
pnpm --filter @markiro/api exec vitest run test/pickup-limits-default.e2e.test.ts
```

Expected: FAIL on the first case with `over_limit` conflicts.

- [ ] **Step 3: Flip the schema default**

```ts
    limitsEnabled: boolean("limits_enabled").notNull().default(false),
```

- [ ] **Step 4: Write the migration**

`packages/db/migrations/0151_pickup_limits_off_by_default.sql`:

```sql
-- The daily pickup allowance becomes opt-in. The cabinet switch
-- (`pickupLimitsEnabled`, org profile) is unchanged, and no limit configuration
-- is deleted: a tenant that wants the allowance back only flips the switch.
ALTER TABLE "pickup_tenant_policies" ALTER COLUMN "limits_enabled" SET DEFAULT false;--> statement-breakpoint
UPDATE "pickup_tenant_policies" SET "limits_enabled" = false, "updated_at" = now() WHERE "limits_enabled" = true;
```

Append journal entry `idx: 151`, tag `0151_pickup_limits_off_by_default`.

- [ ] **Step 5: Follow the two insert sites**

`auth.setup.ts` and `tenant-provisioning.service.ts` both write
`limitsEnabled: true` explicitly, which would defeat the new default. Both become
`false`.

- [ ] **Step 6: Run the tests**

```bash
pnpm --filter @markiro/db db:migrate
pnpm --filter @markiro/db build
pnpm --filter @markiro/api exec vitest run test/pickup-limits-default.e2e.test.ts test/kiosk-orders.e2e.test.ts test/kiosk-bootstrap-day-count.e2e.test.ts test/pickup-orders.e2e.test.ts
```

Expected: PASS. Suites that assert limit behaviour will need to enable limits in
their own fixtures — that is following the new default, not weakening them. The
existing `createPolicySubject` helper already seeds explicit policies, so most
should be unaffected; fix only what actually breaks, and enable the switch rather
than re-asserting the old default.

- [ ] **Step 7: Full gates and commit**

```bash
pnpm --filter @markiro/db test && pnpm --filter @markiro/db typecheck && pnpm --filter @markiro/db lint && pnpm --filter @markiro/db build
pnpm --filter @markiro/api test && pnpm --filter @markiro/api typecheck && pnpm --filter @markiro/api lint && pnpm --filter @markiro/api build
pnpm format:check
git add packages/db apps/api
git commit -m "feat: pickup day limits are off unless a tenant asks for them"
```

## Done when

- A fresh tenant does not charge an allowance.
- Every existing tenant has the switch off.
- Turning the switch on restores the allowance exactly as before.
- The cabinet toggle and all per-employee limit configuration are untouched.

## Not in this plan

Removing the limit feature. The mechanism stays; only its default moves. Plan 3
(the handheld app) is unrelated and independent.
