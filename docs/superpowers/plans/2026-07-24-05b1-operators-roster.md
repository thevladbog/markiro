# Plan 05b-1: Operators Roster & Station Access — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the server-side operator roster (an employee granted station access), sync it to the line station so a freshly installed device has someone to sign in as, and manage it from the admin panel — closing the 05a **F6 deadlock**.

**Architecture:** `employees` stays the single people registry and `employee_badges` the single badge registry (badge codes are shared identifiers used by the pickup kiosk and external systems). Station access is a new 1:1 `operator_credentials` table (`login` + `pinHash` + `active`). One shared service method builds the roster; two consumers read it — a station-facing `GET /station/operators` (device api-key, called during station initialization right after enrollment) and the existing `GET /shifts/:id/bundle`. PINs are hashed **server-side** with a PBKDF2 implementation byte-compatible with the station's; badge plaintext never leaves the server (the station receives `badgeHash` only).

**Tech Stack:** NestJS 11 + Drizzle (Postgres) on the server, `node:crypto` PBKDF2, React 19 + TanStack Query + react-hook-form + zod in the admin, Tauri/React + `node:sqlite`-testable mirror on the station, vitest everywhere.

**Spec:** `docs/superpowers/specs/2026-07-24-operators-roster-design.md`

## Global Constraints

- **Hash interop is load-bearing.** PHC format `pbkdf2$sha256$<iterations>$<saltB64>$<hashB64>`, SHA-256, **100000** iterations, **32-byte** derived key, **16-byte** salt, **standard base64 WITH padding**, verify floor **10000** iterations, malformed → `false`, constant-time compare. The server implementation must verify a hash produced by `apps/station/src/lib/crypto.ts` and vice-versa. A stock PHC library strips base64 padding and will break this — do not use one.
- **Plaintext PINs are never stored and never leave the request.** The server hashes on receipt; no endpoint ever returns `pinHash` or a PIN.
- **Badge codes stay plaintext server-side** (identifier for kiosk + external systems). The station receives only `badgeHash`.
- **Tenant scoping in the SQL statement** — every query and mutation filters `tenant_id` in the statement itself, never via a precheck alone (repo precedent).
- **Admin-only routes** use `@UseGuards(TenantGuard, SessionOnlyGuard)` (a station api-key must never manage operators). The roster route for devices uses `TenantGuard` only.
- Zod-validated bodies via `ZodValidationPipe`; English error copy; `23505` → 409 (`error.code` **and** `error.cause.code` — drizzle wraps pg errors).
- i18n RU (default) + EN in **lockstep** for every new admin/station key; the admin i18n throws on a missing key in test mode.
- No new dependencies. `.npmrc` untouched — **adding `minimumReleaseAgeExclude` is task failure.**
- Never `docker compose down`. e2e must be **EXECUTED**, not skipped, with:
  `DATABASE_URL=postgres://markiro:markiro@localhost:5432/markiro BETTER_AUTH_SECRET=insecure-dummy-ci-placeholder-not-a-secret BETTER_AUTH_URL=http://localhost:3000 ADMIN_ORIGIN=http://localhost:5173`
- Conventional commits, English, TDD.

## File Structure

| File                                                                | Responsibility                                                                  |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `packages/db/src/schema/pickup.ts`                                  | + `operatorCredentials` table, + `employeeBadges.badgeHash`                     |
| `packages/db/migrations/0010_*.sql`                                 | generated migration                                                             |
| `apps/api/src/lib/pin-hash.ts`                                      | server PBKDF2 PHC hasher (node:crypto)                                          |
| `apps/api/src/modules/operators/{dto,service,controller,module}.ts` | admin CRUD over station access + shared roster query                            |
| `apps/api/src/modules/operators/station-operators.controller.ts`    | `GET /station/operators` (device key)                                           |
| `apps/api/src/modules/shifts/shifts.service.ts`                     | bundle uses the shared roster query                                             |
| `packages/db/src/sqlite/{schema,migrations}.ts`                     | + `login` on `operators_mirror` (create + guarded ALTER)                        |
| `apps/station/src/lib/mirror.ts`                                    | + `login`, extracted `replaceOperatorsMirror`, ALTER-tolerant `applyMigrations` |
| `apps/station/src/lib/{auth,roster-sync}.ts`                        | login+PIN verification; initialization roster sync                              |
| `apps/station/src/pages/OperatorLogin.tsx`                          | personnel number + PIN entry                                                    |
| `apps/admin/src/pages/employees/{api,StationAccess}.ts(x)`          | station-access hooks + form block                                               |

---

### Task 1: `operator_credentials` table + badge hash column

**Files:**

- Modify: `packages/db/src/schema/pickup.ts`
- Create (generated): `packages/db/migrations/0010_*.sql` + `packages/db/migrations/meta/0010_snapshot.json`

**Interfaces:**

- Consumes: existing `employees`, `employeeBadges`, the file-local `tenantId()` helper.
- Produces: `schema.operatorCredentials` with columns `tenantId`, `employeeId`, `login`, `pinHash`, `active`, `createdAt`, `updatedAt`; PK `(tenant_id, employee_id)`; unique `(tenant_id, login)`. `schema.employeeBadges.badgeHash` (`text`, nullable).

- [ ] **Step 1: Add the table and the badge-hash column**

In `packages/db/src/schema/pickup.ts`, add `primaryKey` to the existing `drizzle-orm/pg-core` import list, add `badgeHash: text("badge_hash"),` to `employeeBadges` (after `label`), and append after the `employeeBadges` table:

```ts
/**
 * Station access for an employee (1:1). An operator is NOT a separate person
 * record: `employees` stays the single people registry and `employee_badges`
 * the single badge registry (badge codes are shared identifiers used by the
 * pickup kiosk and external systems). Only employees WITH a row here appear in
 * the line station's roster. `pinHash` is a PBKDF2 PHC verifier byte-compatible
 * with apps/station/src/lib/crypto.ts — plaintext PINs are never stored.
 */
export const operatorCredentials = pgTable(
  "operator_credentials",
  {
    tenantId: tenantId(),
    employeeId: uuid("employee_id").notNull(),
    login: text("login").notNull(),
    pinHash: text("pin_hash").notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.employeeId] }),
    foreignKey({
      name: "operator_credentials_tenant_employee_fk",
      columns: [t.tenantId, t.employeeId],
      foreignColumns: [employees.tenantId, employees.id],
    }),
    // The personnel number the operator types on the station keypad.
    unique("operator_credentials_tenant_login_uq").on(t.tenantId, t.login),
  ],
);
```

- [ ] **Step 2: Generate the migration**

Run:

```bash
DATABASE_URL=postgres://markiro:markiro@localhost:5432/markiro pnpm --filter @markiro/db db:generate
```

Expected: a new `packages/db/migrations/0010_<tag>.sql` plus `meta/0010_snapshot.json` and a `_journal.json` entry chaining 0009 → 0010.

- [ ] **Step 3: Inspect the generated SQL**

Read the generated `0010_*.sql`. It must contain exactly: `CREATE TABLE "operator_credentials"` with the PK/unique/FK constraints, and `ALTER TABLE "employee_badges" ADD COLUMN "badge_hash" text;`. If it tries to create or drop anything else, the schema edit is wrong — fix and regenerate.

- [ ] **Step 4: Apply and verify**

Run:

```bash
DATABASE_URL=postgres://markiro:markiro@localhost:5432/markiro pnpm --filter @markiro/db db:migrate
DATABASE_URL=postgres://markiro:markiro@localhost:5432/markiro pnpm --filter @markiro/db test
```

Expected: migration applies without error; the db suite passes unchanged.

- [ ] **Step 5: Give the SQLite mirror a `login` column**

The station identifies an operator by personnel number, so the mirror needs the
column too. Both stores change in this task so no intermediate commit leaves the
station type-broken.

In `packages/db/src/sqlite/schema.ts`, add to `operatorsMirror` after `name`:

```ts
  // Nullable in SQLite only because devices enrolled before this column
  // existed already have rows; the server always sends a login and the first
  // roster sync replaces the whole set (see readOperatorsMirror's `?? ""`).
  login: text("login"),
```

and add `login: string;` to the `OperatorMirrorRecord` interface after `name: string;`.

In `packages/db/src/sqlite/migrations.ts`, add `login TEXT,` to the
`operators_mirror` `CREATE TABLE` (after `name TEXT NOT NULL,`) and append a new
entry at the end of the array:

```ts
  // Upgrade path for devices enrolled before operators had a personnel number.
  // SQLite has no `ADD COLUMN IF NOT EXISTS`, and applyMigrations re-runs every
  // statement on each boot, so this throws "duplicate column name" once the
  // column exists — applyMigrations swallows exactly that error.
  `ALTER TABLE operators_mirror ADD COLUMN login TEXT;`,
```

- [ ] **Step 6: Make `applyMigrations` tolerate the re-run ALTER**

In `apps/station/src/lib/mirror.ts` replace `applyMigrations` with:

```ts
/** True for SQLite's "duplicate column name: x" error from a re-run ALTER. */
function isDuplicateColumnError(err: unknown): boolean {
  return /duplicate column name/i.test(err instanceof Error ? err.message : String(err));
}

export async function applyMigrations(exec: SqlExecutor): Promise<void> {
  for (const stmt of STATION_MIGRATIONS) {
    try {
      await exec.run(stmt);
    } catch (err) {
      // `CREATE TABLE IF NOT EXISTS` is idempotent; `ALTER TABLE ADD COLUMN`
      // is not, and every statement re-runs on each boot. A duplicate-column
      // error means the desired end state already holds — anything else is a
      // real failure and must surface.
      if (!isDuplicateColumnError(err)) throw err;
    }
  }
}
```

- [ ] **Step 7: Carry `login` through the mirror and extract the operator replace**

In `apps/station/src/lib/mirror.ts`, replace the operator upsert + delete block at
the end of `upsertBundleBody` with a call to a new exported helper, and add the
helper (Task 7's roster sync reuses it, so the two paths can never diverge):

```ts
  await replaceOperatorsMirror(exec, bundle.operators);
}

/**
 * Replaces the ENTIRE local operator set with `operators`: upserts each record
 * and deletes every mirrored operator not present in the new set (including the
 * empty case, which clears the table). Shared by the shift-bundle mirror and the
 * initialization roster sync so a removed/deactivated operator can never keep
 * authenticating offline from a stale row. The caller owns the transaction.
 */
export async function replaceOperatorsMirror(
  exec: SqlExecutor,
  operators: OperatorMirrorRecord[],
): Promise<void> {
  for (const op of operators) {
    await exec.run(
      `INSERT INTO operators_mirror (operator_id, name, login, role, pin_hash, badge_hash, active)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(operator_id) DO UPDATE SET
         name=excluded.name, login=excluded.login, role=excluded.role,
         pin_hash=excluded.pin_hash, badge_hash=excluded.badge_hash, active=excluded.active`,
      [op.operatorId, op.name, op.login, op.role, op.pinHash, op.badgeHash, b(op.active)],
    );
  }
  if (operators.length === 0) {
    await exec.run("DELETE FROM operators_mirror");
  } else {
    const placeholders = operators.map(() => "?").join(",");
    await exec.run(
      `DELETE FROM operators_mirror WHERE operator_id NOT IN (${placeholders})`,
      operators.map((op) => op.operatorId),
    );
  }
}
```

and update `readOperatorsMirror`'s row type and mapping to include the column:

```ts
export async function readOperatorsMirror(exec: SqlExecutor): Promise<OperatorMirrorRecord[]> {
  const rows = await exec.all<{
    operator_id: string;
    name: string;
    login: string | null;
    role: string;
    pin_hash: string;
    badge_hash: string | null;
    active: number;
  }>("SELECT operator_id, name, login, role, pin_hash, badge_hash, active FROM operators_mirror");
  return rows.map((r) => ({
    operatorId: r.operator_id,
    name: r.name,
    // Legacy rows (mirrored before the column existed) read as "", which never
    // matches a real personnel number; the first roster sync overwrites them.
    login: r.login ?? "",
    role: r.role,
    pinHash: r.pin_hash,
    badgeHash: r.badge_hash,
    active: r.active === 1,
  }));
}
```

- [ ] **Step 8: Add a mirror test for the new column and the re-run ALTER**

Append to `apps/station/test/mirror.test.ts`:

```ts
it("round-trips an operator login and tolerates re-running the migrations", async () => {
  const exec = makeExec();
  await applyMigrations(exec);
  // Re-running must not throw on the non-idempotent ALTER.
  await applyMigrations(exec);

  await replaceOperatorsMirror(exec, [
    {
      operatorId: "op-1",
      name: "Смирнов А.",
      login: "1042",
      role: "operator",
      pinHash: "pbkdf2$sha256$100000$c2FsdA==$aGFzaA==",
      badgeHash: null,
      active: true,
    },
  ]);

  const [op] = await readOperatorsMirror(exec);
  expect(op?.login).toBe("1042");
});
```

Import `replaceOperatorsMirror` alongside the existing imports in that file (`makeExec` is the file's existing `node:sqlite` executor helper — reuse it exactly as the other tests do).

- [ ] **Step 9: Run both suites**

```bash
DATABASE_URL=postgres://markiro:markiro@localhost:5432/markiro pnpm --filter @markiro/db test
pnpm --filter @markiro/station test
pnpm --filter @markiro/station typecheck
```

Expected: all green (the station suite gains one test).

- [ ] **Step 10: Commit**

```bash
git add packages/db apps/station/src/lib/mirror.ts apps/station/test/mirror.test.ts
git commit -m "feat(db): operator credentials, badge hash, and operator login in the station mirror"
```

---

### Task 2: Server PBKDF2 hasher (station-compatible)

**Files:**

- Create: `apps/api/src/lib/pin-hash.ts`
- Test: `apps/api/test/pin-hash.test.ts`

**Interfaces:**

- Produces: `hashSecret(secret: string): Promise<string>` (PHC string), `verifySecret(secret: string, phc: string): Promise<boolean>`.
- Consumed by: Task 3 (PIN set/reset), Task 4 (badge hashing for the roster).

**Why not `packages/domain`:** the domain package is imported by the station's browser bundle and must stay DOM/Node-neutral; this uses `node:crypto`, so it lives in the API app.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/pin-hash.test.ts`:

```ts
import { pbkdf2Sync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashSecret, verifySecret } from "../src/lib/pin-hash";

describe("pin-hash (PBKDF2 PHC, station-compatible)", () => {
  // The SAME vector as apps/station/test/crypto.test.ts — this is the
  // executable interop contract between the two implementations.
  it("verifies the station's known vector", async () => {
    const salt = Buffer.from(Array.from({ length: 16 }, (_, i) => i));
    const derived = pbkdf2Sync("1234", salt, 100000, 32, "sha256");
    const phc = `pbkdf2$sha256$100000$${salt.toString("base64")}$${derived.toString("base64")}`;
    expect(await verifySecret("1234", phc)).toBe(true);
    expect(await verifySecret("0000", phc)).toBe(false);
  });

  it("produces a PHC string the station's format accepts", async () => {
    const phc = await hashSecret("735519");
    const parts = phc.split("$");
    expect(parts[0]).toBe("pbkdf2");
    expect(parts[1]).toBe("sha256");
    expect(parts[2]).toBe("100000");
    // 16-byte salt and 32-byte key, standard base64 WITH padding.
    expect(Buffer.from(parts[3]!, "base64")).toHaveLength(16);
    expect(Buffer.from(parts[4]!, "base64")).toHaveLength(32);
    expect(phc.endsWith("=")).toBe(true);
    expect(await verifySecret("735519", phc)).toBe(true);
    expect(await verifySecret("000000", phc)).toBe(false);
  });

  it("rejects malformed PHC strings without throwing", async () => {
    expect(await verifySecret("1234", "not-a-phc")).toBe(false);
    expect(await verifySecret("1234", "argon2$x$y$z$w")).toBe(false);
  });

  it("rejects an iteration count below the 10000 floor", async () => {
    const salt = Buffer.from(Array.from({ length: 16 }, (_, i) => i));
    const derived = pbkdf2Sync("1234", salt, 1, 32, "sha256");
    const phc = `pbkdf2$sha256$1$${salt.toString("base64")}$${derived.toString("base64")}`;
    expect(await verifySecret("1234", phc)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @markiro/api exec vitest run pin-hash`
Expected: FAIL — cannot resolve `../src/lib/pin-hash`.

- [ ] **Step 3: Implement the hasher**

Create `apps/api/src/lib/pin-hash.ts`:

```ts
import { pbkdf2, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const pbkdf2Async = promisify(pbkdf2);

/**
 * Server side of the operator credential-hash contract. MUST stay
 * byte-for-byte compatible with apps/station/src/lib/crypto.ts, which verifies
 * these strings offline: PHC `pbkdf2$sha256$<iter>$<saltB64>$<hashB64>`,
 * SHA-256, 100000 iterations, 32-byte key, 16-byte salt, standard base64 WITH
 * padding (a stock PHC encoder strips padding and breaks interop). The known
 * vector in test/pin-hash.test.ts is the executable spec.
 */
const ITERATIONS = 100_000;
const KEY_BYTES = 32;
const SALT_BYTES = 16;
/** Verify floor: a foreign/tampered hash must not push the cost down. */
const MIN_ITERATIONS = 10_000;

export async function hashSecret(secret: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const derived = await pbkdf2Async(secret, salt, ITERATIONS, KEY_BYTES, "sha256");
  return `pbkdf2$sha256$${ITERATIONS}$${salt.toString("base64")}$${derived.toString("base64")}`;
}

export async function verifySecret(secret: string, phc: string): Promise<boolean> {
  const parts = phc.split("$");
  if (parts.length !== 5 || parts[0] !== "pbkdf2" || parts[1] !== "sha256") return false;
  const iterations = Number(parts[2]);
  if (!Number.isInteger(iterations) || iterations < MIN_ITERATIONS) return false;
  const salt = Buffer.from(parts[3]!, "base64");
  const expected = Buffer.from(parts[4]!, "base64");
  // Reject malformed/tampered hash fields up front: never derive a key whose
  // length is taken from untrusted input (that would let a truncated hash
  // "fail open" with far less entropy, and diverge from the station, which
  // always derives a fixed KEY_BITS = 256).
  if (salt.length === 0 || expected.length !== KEY_BYTES) return false;
  const actual = await pbkdf2Async(secret, salt, iterations, KEY_BYTES, "sha256");
  return timingSafeEqual(actual, expected);
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @markiro/api exec vitest run pin-hash`
Expected: PASS (6 tests).

- [ ] **Step 5: Prove interop against the station implementation**

Add to `apps/station/test/crypto.test.ts` a case proving the station verifies a server-produced hash (the server's `hashSecret` output shape is deterministic in format, so reproduce it with `node:crypto` exactly as the server builds it):

```ts
it("verifies a hash produced the way the server's pin-hash.ts builds it (interop)", async () => {
  const salt = Buffer.from(Array.from({ length: 16 }, (_, i) => 255 - i));
  const derived = pbkdf2Sync("4821", salt, 100000, 32, "sha256");
  const phc = `pbkdf2$sha256$100000$${salt.toString("base64")}$${derived.toString("base64")}`;
  expect(await verifyPin("4821", phc)).toBe(true);
});
```

Run: `pnpm --filter @markiro/station exec vitest run crypto`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/lib/pin-hash.ts apps/api/test/pin-hash.test.ts apps/station/test/crypto.test.ts
git commit -m "feat(api): station-compatible PBKDF2 credential hasher"
```

---

### Task 3: Operators module — grant / update / revoke / list station access

**Files:**

- Create: `apps/api/src/modules/operators/dto.ts`, `operators.service.ts`, `operators.controller.ts`, `operators.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Test: `apps/api/test/operators.e2e.test.ts`

**Interfaces:**

- Consumes: `hashSecret` (Task 2), `schema.operatorCredentials` / `schema.employees` / `schema.employeeBadges` (Task 1), `DB` token from `../../auth/auth.module`, `TenantGuard` + `SessionOnlyGuard` from `../../tenancy/`, `ZodValidationPipe` from `../../zod.pipe`.
- Produces: `OperatorsService` (exported from `OperatorsModule`) with
  `listOperators(tenantId): Promise<ListOperatorsResponseDto>`,
  `grantAccess(tenantId, employeeId, dto): Promise<StationAccessDto>`,
  `updateAccess(tenantId, employeeId, dto): Promise<StationAccessDto>`,
  `revokeAccess(tenantId, employeeId): Promise<void>`.
  Routes `GET /operators`, `PUT /operators/:employeeId`, `PATCH /operators/:employeeId`, `DELETE /operators/:employeeId` — all admin-only.

- [ ] **Step 1: Write the DTOs**

Create `apps/api/src/modules/operators/dto.ts`:

```ts
import { z } from "zod";

/** Personnel number typed on the station keypad — digits only. */
const loginSchema = z
  .string()
  .trim()
  .regex(/^\d{3,12}$/, "login must be 3-12 digits");
/** Floor PIN — digits only; the station's verifier requires at least 4. */
const pinSchema = z
  .string()
  .trim()
  .regex(/^\d{4,6}$/, "pin must be 4-6 digits");

export const grantStationAccessSchema = z.object({ login: loginSchema, pin: pinSchema });
export type GrantStationAccessDto = z.infer<typeof grantStationAccessSchema>;

export const updateStationAccessSchema = z
  .object({
    login: loginSchema.optional(),
    pin: pinSchema.optional(),
    active: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "no fields to update" });
export type UpdateStationAccessDto = z.infer<typeof updateStationAccessSchema>;

/** Station access as returned to the admin — never carries the PIN or its hash. */
export interface StationAccessDto {
  employeeId: string;
  login: string;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface OperatorListItemDto {
  employeeId: string;
  fullName: string;
  role: string | null;
  login: string;
  active: boolean;
  hasBadge: boolean;
}

export interface ListOperatorsResponseDto {
  items: OperatorListItemDto[];
}
```

- [ ] **Step 2: Write the failing e2e**

Create `apps/api/test/operators.e2e.test.ts` (harness copied from `employees.e2e.test.ts`):

```ts
import { randomUUID } from "node:crypto";
import express from "express";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

describe.skipIf(!ready)("operators e2e", () => {
  let app: INestApplication | undefined;
  let setup: AuthSetup;

  beforeAll(async () => {
    const env = loadEnv();
    setup = setupAuth(env);
    const ref = await Test.createTestingModule({
      imports: [AppModule.forRoot({ ...setup, databaseUrl: env.DATABASE_URL })],
    }).compile();
    app = ref.createNestApplication({ bodyParser: false });
    const server = app.getHttpAdapter().getInstance();
    mountAuth(server, setup.auth);
    server.use(express.json());
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  async function signUpAndActivate(agent: ReturnType<typeof request.agent>): Promise<string> {
    const email = `t-${randomUUID()}@example.com`;
    await agent
      .post("/api/auth/sign-up/email")
      .send({ email, password: "Passw0rd!123", name: "T" })
      .expect(200);
    const org = await agent
      .post("/api/auth/organization/create")
      .send({
        name: "Test Plant",
        slug: `plant-${randomUUID()}`,
        keepCurrentActiveOrganization: true,
      })
      .expect(200);
    const orgId = org.body.id as string;
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: orgId })
      .expect(200);
    return orgId;
  }

  async function createEmployee(
    agent: ReturnType<typeof request.agent>,
    fullName: string,
  ): Promise<string> {
    const res = await agent.post("/employees").send({ fullName }).expect(201);
    return res.body.id as string;
  }

  it("grants station access, lists it, and never leaks the PIN", async () => {
    const agent = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent);
    const employeeId = await createEmployee(agent, "Смирнов Алексей");

    const granted = await agent
      .put(`/operators/${employeeId}`)
      .send({ login: "1042", pin: "4821" })
      .expect(200);
    expect(granted.body.login).toBe("1042");
    expect(granted.body.active).toBe(true);
    expect(JSON.stringify(granted.body)).not.toContain("4821");
    expect(JSON.stringify(granted.body)).not.toContain("pbkdf2");

    const list = await agent.get("/operators").expect(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({
      employeeId,
      fullName: "Смирнов Алексей",
      login: "1042",
      active: true,
      hasBadge: false,
    });
    expect(JSON.stringify(list.body)).not.toContain("pbkdf2");
  });

  it("rejects a duplicate login in the same tenant with 409", async () => {
    const agent = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent);
    const first = await createEmployee(agent, "Первый");
    const second = await createEmployee(agent, "Второй");

    await agent.put(`/operators/${first}`).send({ login: "700", pin: "1234" }).expect(200);
    await agent.put(`/operators/${second}`).send({ login: "700", pin: "5678" }).expect(409);
  });

  it("deactivates and revokes access", async () => {
    const agent = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent);
    const employeeId = await createEmployee(agent, "Ким Е.");
    await agent.put(`/operators/${employeeId}`).send({ login: "88", pin: "1234" }).expect(400);
    await agent.put(`/operators/${employeeId}`).send({ login: "880", pin: "1234" }).expect(200);

    const patched = await agent
      .patch(`/operators/${employeeId}`)
      .send({ active: false })
      .expect(200);
    expect(patched.body.active).toBe(false);

    await agent.delete(`/operators/${employeeId}`).expect(204);
    const list = await agent.get("/operators").expect(200);
    expect(list.body.items).toHaveLength(0);
  });

  it("is tenant-isolated: another tenant cannot see or revoke access", async () => {
    const alice = request.agent(app!.getHttpServer());
    await signUpAndActivate(alice);
    const employeeId = await createEmployee(alice, "Алиса");
    await alice.put(`/operators/${employeeId}`).send({ login: "9001", pin: "1234" }).expect(200);

    const bob = request.agent(app!.getHttpServer());
    await signUpAndActivate(bob);
    const bobList = await bob.get("/operators").expect(200);
    expect(bobList.body.items).toHaveLength(0);
    await bob.delete(`/operators/${employeeId}`).expect(404);
  });
});
```

- [ ] **Step 3: Run it to see it fail**

Run:

```bash
DATABASE_URL=postgres://markiro:markiro@localhost:5432/markiro BETTER_AUTH_SECRET=insecure-dummy-ci-placeholder-not-a-secret BETTER_AUTH_URL=http://localhost:3000 ADMIN_ORIGIN=http://localhost:5173 pnpm --filter @markiro/api exec vitest run operators
```

Expected: FAIL — every route 404s (module does not exist).

- [ ] **Step 4: Implement the service**

Create `apps/api/src/modules/operators/operators.service.ts`:

```ts
import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { schema, type Db, type OperatorMirrorRecord } from "@markiro/db";
import { DB } from "../../auth/auth.module";
import { hashSecret } from "../../lib/pin-hash";
import type {
  GrantStationAccessDto,
  ListOperatorsResponseDto,
  StationAccessDto,
  UpdateStationAccessDto,
} from "./dto";

/** Fallback for the station record's required `role` when the employee has none. */
const DEFAULT_ROLE = "operator";

@Injectable()
export class OperatorsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async listOperators(tenantId: string): Promise<ListOperatorsResponseDto> {
    const rows = await this.db
      .select({
        employeeId: schema.operatorCredentials.employeeId,
        login: schema.operatorCredentials.login,
        active: schema.operatorCredentials.active,
        fullName: schema.employees.fullName,
        role: schema.employees.role,
      })
      .from(schema.operatorCredentials)
      .innerJoin(
        schema.employees,
        and(
          eq(schema.employees.tenantId, schema.operatorCredentials.tenantId),
          eq(schema.employees.id, schema.operatorCredentials.employeeId),
        ),
      )
      .where(eq(schema.operatorCredentials.tenantId, tenantId))
      .orderBy(schema.employees.fullName);

    const badged = await this.activeBadgeCodes(tenantId);
    return {
      items: rows.map((r) => ({
        employeeId: r.employeeId,
        fullName: r.fullName,
        role: r.role,
        login: r.login,
        active: r.active,
        hasBadge: badged.has(r.employeeId),
      })),
    };
  }

  async grantAccess(
    tenantId: string,
    employeeId: string,
    dto: GrantStationAccessDto,
  ): Promise<StationAccessDto> {
    await this.requireEmployee(tenantId, employeeId);
    const pinHash = await hashSecret(dto.pin);
    try {
      const [row] = await this.db
        .insert(schema.operatorCredentials)
        .values({ tenantId, employeeId, login: dto.login, pinHash, active: true })
        .onConflictDoUpdate({
          target: [schema.operatorCredentials.tenantId, schema.operatorCredentials.employeeId],
          set: { login: dto.login, pinHash, active: true, updatedAt: new Date() },
        })
        .returning();
      return this.toDto(row!);
    } catch (error) {
      throw this.mapWriteError(error);
    }
  }

  async updateAccess(
    tenantId: string,
    employeeId: string,
    dto: UpdateStationAccessDto,
  ): Promise<StationAccessDto> {
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (dto.login !== undefined) set.login = dto.login;
    if (dto.active !== undefined) set.active = dto.active;
    if (dto.pin !== undefined) set.pinHash = await hashSecret(dto.pin);
    try {
      const [row] = await this.db
        .update(schema.operatorCredentials)
        .set(set)
        .where(
          and(
            eq(schema.operatorCredentials.tenantId, tenantId),
            eq(schema.operatorCredentials.employeeId, employeeId),
          ),
        )
        .returning();
      if (!row) throw new NotFoundException();
      return this.toDto(row);
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      throw this.mapWriteError(error);
    }
  }

  async revokeAccess(tenantId: string, employeeId: string): Promise<void> {
    const [row] = await this.db
      .delete(schema.operatorCredentials)
      .where(
        and(
          eq(schema.operatorCredentials.tenantId, tenantId),
          eq(schema.operatorCredentials.employeeId, employeeId),
        ),
      )
      .returning();
    if (!row) throw new NotFoundException();
  }

  /**
   * The station roster: every ACTIVE operator of the tenant with the PBKDF2
   * verifiers the device stores in `operators_mirror`. Shared by
   * `GET /station/operators` and `GET /shifts/:id/bundle` — one query, two
   * consumers, so the two can never drift.
   */
  async buildRoster(tenantId: string): Promise<OperatorMirrorRecord[]> {
    const rows = await this.db
      .select({
        employeeId: schema.operatorCredentials.employeeId,
        login: schema.operatorCredentials.login,
        pinHash: schema.operatorCredentials.pinHash,
        fullName: schema.employees.fullName,
        role: schema.employees.role,
      })
      .from(schema.operatorCredentials)
      .innerJoin(
        schema.employees,
        and(
          eq(schema.employees.tenantId, schema.operatorCredentials.tenantId),
          eq(schema.employees.id, schema.operatorCredentials.employeeId),
        ),
      )
      .where(
        and(
          eq(schema.operatorCredentials.tenantId, tenantId),
          eq(schema.operatorCredentials.active, true),
          eq(schema.employees.status, "active"),
        ),
      )
      .orderBy(schema.employees.fullName);

    const badgeHashes = await this.activeBadgeHashes(tenantId);
    return rows.map((r) => ({
      operatorId: r.employeeId,
      name: r.fullName,
      role: r.role ?? DEFAULT_ROLE,
      login: r.login,
      pinHash: r.pinHash,
      badgeHash: badgeHashes.get(r.employeeId) ?? null,
      active: true,
    }));
  }

  /**
   * Badge hashes for the roster. The plaintext code stays server-side (it is a
   * shared identifier used by the pickup kiosk and external systems); the
   * device only ever receives the hash. Rows issued before the `badge_hash`
   * column existed are hashed and backfilled on first read.
   */
  private async activeBadgeHashes(tenantId: string): Promise<Map<string, string>> {
    const rows = await this.db
      .select()
      .from(schema.employeeBadges)
      .where(
        and(eq(schema.employeeBadges.tenantId, tenantId), isNull(schema.employeeBadges.revokedAt)),
      );
    const map = new Map<string, string>();
    for (const b of rows) {
      let hash = b.badgeHash;
      if (!hash) {
        hash = await hashSecret(b.badgeCode);
        await this.db
          .update(schema.employeeBadges)
          .set({ badgeHash: hash })
          .where(
            and(eq(schema.employeeBadges.tenantId, tenantId), eq(schema.employeeBadges.id, b.id)),
          );
      }
      map.set(b.employeeId, hash);
    }
    return map;
  }

  private async activeBadgeCodes(tenantId: string): Promise<Set<string>> {
    const rows = await this.db
      .select({ employeeId: schema.employeeBadges.employeeId })
      .from(schema.employeeBadges)
      .where(
        and(eq(schema.employeeBadges.tenantId, tenantId), isNull(schema.employeeBadges.revokedAt)),
      );
    return new Set(rows.map((r) => r.employeeId));
  }

  private async requireEmployee(tenantId: string, employeeId: string): Promise<void> {
    const [row] = await this.db
      .select({ id: schema.employees.id })
      .from(schema.employees)
      .where(and(eq(schema.employees.tenantId, tenantId), eq(schema.employees.id, employeeId)));
    if (!row) throw new NotFoundException();
  }

  /** 23505 = unique violation (the per-tenant login). Drizzle wraps pg errors. */
  private mapWriteError(error: unknown): Error {
    const code =
      (error as { code?: string })?.code ?? (error as { cause?: { code?: string } })?.cause?.code;
    if (code === "23505") return new ConflictException("Login already in use");
    return error as Error;
  }

  private toDto(row: typeof schema.operatorCredentials.$inferSelect): StationAccessDto {
    return {
      employeeId: row.employeeId,
      login: row.login,
      active: row.active,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
```

- [ ] **Step 5: Implement the controller and module**

Create `apps/api/src/modules/operators/operators.controller.ts`:

```ts
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Put,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import { SessionOnlyGuard } from "../../tenancy/session-only.guard";
import { ZodValidationPipe } from "../../zod.pipe";
import {
  grantStationAccessSchema,
  updateStationAccessSchema,
  type GrantStationAccessDto,
  type ListOperatorsResponseDto,
  type StationAccessDto,
  type UpdateStationAccessDto,
} from "./dto";
import { OperatorsService } from "./operators.service";

/**
 * Admin-only management of station access. `SessionOnlyGuard` keeps a station
 * api-key out: a floor device must never be able to mint or revoke operator
 * credentials, even though `TenantGuard` accepts its key for tenant resolution.
 */
@ApiTags("operators")
@Controller("operators")
@UseGuards(TenantGuard, SessionOnlyGuard)
export class OperatorsController {
  constructor(private readonly operatorsService: OperatorsService) {}

  @Get()
  async listOperators(@Req() req: RequestWithTenant): Promise<ListOperatorsResponseDto> {
    return this.operatorsService.listOperators(req.tenantId!);
  }

  @Put(":employeeId")
  async grantAccess(
    @Req() req: RequestWithTenant,
    @Param("employeeId") employeeId: string,
    @Body(new ZodValidationPipe(grantStationAccessSchema)) body: GrantStationAccessDto,
  ): Promise<StationAccessDto> {
    return this.operatorsService.grantAccess(req.tenantId!, employeeId, body);
  }

  @Patch(":employeeId")
  async updateAccess(
    @Req() req: RequestWithTenant,
    @Param("employeeId") employeeId: string,
    @Body(new ZodValidationPipe(updateStationAccessSchema)) body: UpdateStationAccessDto,
  ): Promise<StationAccessDto> {
    return this.operatorsService.updateAccess(req.tenantId!, employeeId, body);
  }

  @Delete(":employeeId")
  @HttpCode(204)
  async revokeAccess(
    @Req() req: RequestWithTenant,
    @Param("employeeId") employeeId: string,
  ): Promise<void> {
    return this.operatorsService.revokeAccess(req.tenantId!, employeeId);
  }
}
```

Create `apps/api/src/modules/operators/operators.module.ts`:

```ts
import { Module } from "@nestjs/common";
import { OperatorsController } from "./operators.controller";
import { OperatorsService } from "./operators.service";

@Module({
  controllers: [OperatorsController],
  providers: [OperatorsService],
  // Exported so ShiftsModule can reuse `buildRoster` for the shift bundle.
  exports: [OperatorsService],
})
export class OperatorsModule {}
```

- [ ] **Step 6: Register the module**

In `apps/api/src/app.module.ts`, add the import line after the `EmployeesModule` import:

```ts
import { OperatorsModule } from "./modules/operators/operators.module";
```

and add `OperatorsModule,` to the `imports` array immediately after `EmployeesModule,`.

- [ ] **Step 7: Run the e2e**

Run:

```bash
DATABASE_URL=postgres://markiro:markiro@localhost:5432/markiro BETTER_AUTH_SECRET=insecure-dummy-ci-placeholder-not-a-secret BETTER_AUTH_URL=http://localhost:3000 ADMIN_ORIGIN=http://localhost:5173 pnpm --filter @markiro/api exec vitest run operators
```

Expected: PASS (4 tests).

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/modules/operators apps/api/src/app.module.ts apps/api/test/operators.e2e.test.ts
git commit -m "feat(api): operator station-access management (grant/update/revoke/list)"
```

---

### Task 4: `GET /station/operators` roster endpoint (device api-key)

**Files:**

- Create: `apps/api/src/modules/operators/station-operators.controller.ts`
- Modify: `apps/api/src/modules/operators/operators.module.ts`
- Test: extend `apps/api/test/operators.e2e.test.ts`

**Interfaces:**

- Consumes: `OperatorsService.buildRoster` (Task 3), `TenantGuard`.
- Produces: `GET /station/operators` → `{ items: OperatorMirrorRecord[] }`, reachable with a station `x-api-key` (no session), tenant-scoped.

- [ ] **Step 1: Write the failing e2e**

Append to `apps/api/test/operators.e2e.test.ts` (inside the same `describe`). It mints a station device key exactly the way `station-devices.e2e.test.ts` does:

```ts
it("serves the roster to a station api-key and refuses admin routes to it", async () => {
  const agent = request.agent(app!.getHttpServer());
  await signUpAndActivate(agent);
  const employeeId = await createEmployee(agent, "Оператор Смены");
  await agent.put(`/operators/${employeeId}`).send({ login: "1042", pin: "4821" }).expect(200);
  await agent
    .post(`/employees/${employeeId}/badges`)
    .send({ badgeCode: `BADGE-${randomUUID()}` })
    .expect(201);

  const device = await agent.post("/station-devices").send({ name: "Line 1 terminal" }).expect(201);
  const apiKey = device.body.apiKey as string;

  const roster = await request(app!.getHttpServer())
    .get("/station/operators")
    .set("x-api-key", apiKey)
    .expect(200);

  expect(roster.body.items).toHaveLength(1);
  const op = roster.body.items[0];
  expect(op).toMatchObject({
    operatorId: employeeId,
    name: "Оператор Смены",
    login: "1042",
    active: true,
  });
  expect(op.pinHash).toMatch(/^pbkdf2\$sha256\$100000\$/);
  expect(op.badgeHash).toMatch(/^pbkdf2\$sha256\$100000\$/);
  // The plaintext badge code must never reach the device.
  expect(JSON.stringify(roster.body)).not.toContain("BADGE-");

  // The same key must NOT be able to manage operators.
  await request(app!.getHttpServer()).get("/operators").set("x-api-key", apiKey).expect(403);
  await request(app!.getHttpServer())
    .delete(`/operators/${employeeId}`)
    .set("x-api-key", apiKey)
    .expect(403);
});

it("requires auth for the roster and never crosses tenants", async () => {
  const alice = request.agent(app!.getHttpServer());
  await signUpAndActivate(alice);
  const aliceEmployee = await createEmployee(alice, "Алисин оператор");
  await alice.put(`/operators/${aliceEmployee}`).send({ login: "5001", pin: "1234" }).expect(200);

  const bob = request.agent(app!.getHttpServer());
  await signUpAndActivate(bob);
  const bobDevice = await bob.post("/station-devices").send({ name: "Bob terminal" }).expect(201);

  await request(app!.getHttpServer()).get("/station/operators").expect(401);

  const bobRoster = await request(app!.getHttpServer())
    .get("/station/operators")
    .set("x-api-key", bobDevice.body.apiKey as string)
    .expect(200);
  expect(bobRoster.body.items).toHaveLength(0);
});
```

- [ ] **Step 2: Run it to see it fail**

Run:

```bash
DATABASE_URL=postgres://markiro:markiro@localhost:5432/markiro BETTER_AUTH_SECRET=insecure-dummy-ci-placeholder-not-a-secret BETTER_AUTH_URL=http://localhost:3000 ADMIN_ORIGIN=http://localhost:5173 pnpm --filter @markiro/api exec vitest run operators
```

Expected: FAIL — `GET /station/operators` 404s.

- [ ] **Step 3: Implement the station-facing controller**

Create `apps/api/src/modules/operators/station-operators.controller.ts`:

```ts
import { Controller, Get, Req, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { OperatorMirrorRecord } from "@markiro/db";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import { OperatorsService } from "./operators.service";

/**
 * Station-facing roster. Deliberately `TenantGuard`-only (no
 * `SessionOnlyGuard`): the device calls this with its own api-key during
 * initialization, right after enrollment and BEFORE any operator can sign in —
 * that is what makes a freshly installed station usable at all. It returns
 * PBKDF2 verifiers, never plaintext PINs or badge codes.
 */
@ApiTags("station")
@Controller("station")
@UseGuards(TenantGuard)
export class StationOperatorsController {
  constructor(private readonly operatorsService: OperatorsService) {}

  @Get("operators")
  async listRoster(@Req() req: RequestWithTenant): Promise<{ items: OperatorMirrorRecord[] }> {
    return { items: await this.operatorsService.buildRoster(req.tenantId!) };
  }
}
```

Add it to `apps/api/src/modules/operators/operators.module.ts`:

```ts
import { Module } from "@nestjs/common";
import { OperatorsController } from "./operators.controller";
import { OperatorsService } from "./operators.service";
import { StationOperatorsController } from "./station-operators.controller";

@Module({
  controllers: [OperatorsController, StationOperatorsController],
  providers: [OperatorsService],
  // Exported so ShiftsModule can reuse `buildRoster` for the shift bundle.
  exports: [OperatorsService],
})
export class OperatorsModule {}
```

- [ ] **Step 4: Run the e2e**

Run the command from Step 2.
Expected: PASS (6 tests). `OperatorMirrorRecord.login` already exists (Task 1, Step 5), so the roster type-checks without any temporary workaround.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/operators apps/api/test/operators.e2e.test.ts
git commit -m "feat(api): station roster endpoint for device-key initialization"
```

---

### Task 5: Shift bundle serves the real roster

**Files:**

- Modify: `apps/api/src/modules/shifts/shifts.service.ts`, `apps/api/src/modules/shifts/shifts.module.ts`
- Test: `apps/api/test/shifts-bundle.e2e.test.ts:130-155`

**Interfaces:**

- Consumes: `OperatorsService.buildRoster` (Task 3) via `OperatorsModule`'s export.
- Produces: `GET /shifts/:id/bundle` `operators` is the tenant's active roster — the same array `GET /station/operators` returns.

- [ ] **Step 1: Update the e2e that pins the mock**

In `apps/api/test/shifts-bundle.e2e.test.ts`, rename the test at line 130 to
`"GET /shifts/:id/bundle returns shift+product+labelTemplate+counterpartyGln and the operator roster"`,
and replace the assertion at line 155 (`expect(bundle.body.operators).toEqual([]);`) with a real
roster expectation. Before opening the shift, grant one employee station access:

```ts
const employee = await agent.post("/employees").send({ fullName: "Оператор Бандла" }).expect(201);
await agent.put(`/operators/${employee.body.id}`).send({ login: "3300", pin: "1234" }).expect(200);
```

and assert:

```ts
expect(bundle.body.operators).toHaveLength(1);
expect(bundle.body.operators[0]).toMatchObject({
  operatorId: employee.body.id,
  name: "Оператор Бандла",
  login: "3300",
  role: "operator",
  badgeHash: null,
  active: true,
});
expect(bundle.body.operators[0].pinHash).toMatch(/^pbkdf2\$sha256\$100000\$/);
```

- [ ] **Step 2: Run it to see it fail**

Run:

```bash
DATABASE_URL=postgres://markiro:markiro@localhost:5432/markiro BETTER_AUTH_SECRET=insecure-dummy-ci-placeholder-not-a-secret BETTER_AUTH_URL=http://localhost:3000 ADMIN_ORIGIN=http://localhost:5173 pnpm --filter @markiro/api exec vitest run shifts-bundle
```

Expected: FAIL — `operators` is `[]` (the mock).

- [ ] **Step 3: Inject the roster query**

In `apps/api/src/modules/shifts/shifts.module.ts`, import `OperatorsModule` and add it to the module's `imports` array:

```ts
import { OperatorsModule } from "../operators/operators.module";
```

In `apps/api/src/modules/shifts/shifts.service.ts`, inject the service into the constructor
alongside the existing `@Inject(DB) private readonly db: Db`:

```ts
    private readonly operatorsService: OperatorsService,
```

with `import { OperatorsService } from "../operators/operators.service";` at the top, then replace
the mock in `getBundle`:

```ts
// The tenant's active operators, hydrated into the station's
// `operators_mirror`. Same query as GET /station/operators (one service
// method, two consumers) so the initialization sync and the per-shift
// refresh can never drift.
const operators = await this.operatorsService.buildRoster(tenantId);
```

Delete the now-stale `OperatorMirrorRecord` import from `shifts.service.ts` if TypeScript reports it unused, and update the `getBundle` doc comment — it currently claims `operators` is `[]` in 05a.

- [ ] **Step 4: Run the e2e**

Run the command from Step 2.
Expected: PASS.

- [ ] **Step 5: Run the whole API suite**

```bash
DATABASE_URL=postgres://markiro:markiro@localhost:5432/markiro BETTER_AUTH_SECRET=insecure-dummy-ci-placeholder-not-a-secret BETTER_AUTH_URL=http://localhost:3000 ADMIN_ORIGIN=http://localhost:5173 pnpm --filter @markiro/api test
pnpm --filter @markiro/api typecheck && pnpm --filter @markiro/api lint
```

Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/shifts apps/api/test/shifts-bundle.e2e.test.ts
git commit -m "feat(api): shift bundle carries the real operator roster"
```

---

### Task 6: Station sign-in by personnel number + PIN

**Files:**

- Modify: `apps/station/src/lib/auth.ts`, `apps/station/src/pages/OperatorLogin.tsx`, `apps/station/src/i18n/ru.json`, `apps/station/src/i18n/en.json`
- Test: `apps/station/test/operator-login.test.tsx` (existing), `apps/station/test/auth.test.ts` (create if absent — otherwise extend the existing auth test file)

**Interfaces:**

- Consumes: `readOperatorsMirror` (returns records with `login`, Task 1).
- Produces: `verifyOperatorPin(exec, login: string, pin: string): Promise<OperatorMirrorRecord | null>` — **signature change**, `login` is new and required. `verifyOperatorBadge` is unchanged.

**Why:** PIN-alone identification scans every active operator and returns the first match. With 4-digit PINs and dozens of operators, collisions are certain — the wrong operator would be signed in. Looking up by personnel number first makes the PIN a per-identity secret.

- [ ] **Step 1: Write the failing auth test**

Create `apps/station/test/auth.test.ts` (if the repo already has one, append these cases instead):

```ts
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { applyMigrations, replaceOperatorsMirror, type SqlExecutor } from "../src/lib/mirror.js";
import { hashSecret } from "../src/lib/crypto.js";
import { verifyOperatorBadge, verifyOperatorPin } from "../src/lib/auth.js";

function makeExec(): SqlExecutor {
  const db = new DatabaseSync(":memory:");
  return {
    run: async (sql, params = []) => {
      db.prepare(sql).run(...(params as never[]));
    },
    all: async <T>(sql: string, params: unknown[] = []) =>
      db.prepare(sql).all(...(params as never[])) as T[],
  };
}

describe("operator auth (login + PIN)", () => {
  it("signs in the operator whose personnel number matches, not merely a matching PIN", async () => {
    const exec = makeExec();
    await applyMigrations(exec);
    const sharedPin = await hashSecret("1234");
    await replaceOperatorsMirror(exec, [
      {
        operatorId: "op-a",
        name: "Первый",
        login: "1001",
        role: "operator",
        pinHash: sharedPin,
        badgeHash: null,
        active: true,
      },
      {
        operatorId: "op-b",
        name: "Второй",
        login: "1002",
        role: "operator",
        // Same PIN as op-a — a PIN-only lookup would return whichever row came first.
        pinHash: await hashSecret("1234"),
        badgeHash: null,
        active: true,
      },
    ]);

    expect((await verifyOperatorPin(exec, "1002", "1234"))?.operatorId).toBe("op-b");
    expect(await verifyOperatorPin(exec, "1002", "9999")).toBeNull();
    expect(await verifyOperatorPin(exec, "9999", "1234")).toBeNull();
  });

  it("refuses an inactive operator and a malformed PIN", async () => {
    const exec = makeExec();
    await applyMigrations(exec);
    await replaceOperatorsMirror(exec, [
      {
        operatorId: "op-c",
        name: "Уволен",
        login: "2001",
        role: "operator",
        pinHash: await hashSecret("4321"),
        badgeHash: null,
        active: false,
      },
    ]);

    expect(await verifyOperatorPin(exec, "2001", "4321")).toBeNull();
    expect(await verifyOperatorPin(exec, "2001", "12")).toBeNull();
  });

  it("still signs in by badge without a personnel number", async () => {
    const exec = makeExec();
    await applyMigrations(exec);
    await replaceOperatorsMirror(exec, [
      {
        operatorId: "op-d",
        name: "Бейдж",
        login: "3001",
        role: "operator",
        pinHash: await hashSecret("1111"),
        badgeHash: await hashSecret("BADGE-77"),
        active: true,
      },
    ]);

    expect((await verifyOperatorBadge(exec, "BADGE-77"))?.operatorId).toBe("op-d");
    expect(await verifyOperatorBadge(exec, "BADGE-00")).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @markiro/station exec vitest run auth`
Expected: FAIL — `verifyOperatorPin` takes two arguments, not three.

- [ ] **Step 3: Change the verifier**

Replace `verifyOperatorPin` in `apps/station/src/lib/auth.ts`:

```ts
/**
 * Returns the active operator whose personnel number is `login` when `pin`
 * matches their verifier, else null. Looking up by login first is not just the
 * UX from the sign-in design — it is correctness: 4-digit PINs collide across a
 * roster of any size, so a PIN-only scan can sign in the wrong person.
 */
export async function verifyOperatorPin(
  exec: SqlExecutor,
  login: string,
  pin: string,
): Promise<OperatorMirrorRecord | null> {
  if (!/^\d{4,}$/.test(pin)) return null;
  if (login.length === 0) return null;
  const operator = (await readOperatorsMirror(exec)).find((op) => op.active && op.login === login);
  if (!operator) return null;
  return (await verifyPin(pin, operator.pinHash)) ? operator : null;
}
```

- [ ] **Step 4: Run the auth test**

Run: `pnpm --filter @markiro/station exec vitest run auth`
Expected: PASS (3 tests).

- [ ] **Step 5: Add the i18n keys (RU + EN in lockstep)**

In `apps/station/src/i18n/ru.json`, inside the `login` block add:

```json
    "loginPrompt": "Введите табельный номер",
    "loginLabel": "Табельный номер",
    "pinLabel": "ПИН-код",
    "next": "Далее",
    "back": "Назад",
```

and the same keys in `apps/station/src/i18n/en.json`:

```json
    "loginPrompt": "Enter your personnel number",
    "loginLabel": "Personnel number",
    "pinLabel": "PIN",
    "next": "Next",
    "back": "Back",
```

- [ ] **Step 6: Update the sign-in screen to a two-step keypad**

Replace the body of `apps/station/src/pages/OperatorLogin.tsx` with a two-stage entry
(personnel number, then PIN) reusing the same `PinPad`:

```tsx
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button } from "@markiro/ui";
import type { OperatorMirrorRecord } from "@markiro/db";
import type { SqlExecutor } from "../lib/mirror.js";
import { verifyOperatorPin } from "../lib/auth.js";
import { PinPad } from "../ui/PinPad.js";

export interface OperatorLoginProps {
  exec: SqlExecutor;
  onAuthed: (operator: OperatorMirrorRecord) => void;
}

/**
 * Floor sign-in: personnel number, then PIN. Deliberately NOT a picker of every
 * operator — the roster is org-wide and can be large, and a PIN-only entry
 * cannot identify a person (PINs collide).
 */
export function OperatorLogin({ exec, onAuthed }: OperatorLoginProps) {
  const { t } = useTranslation();
  const [stage, setStage] = useState<"login" | "pin">("login");
  const [login, setLogin] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    let operator: OperatorMirrorRecord | null;
    try {
      operator = await verifyOperatorPin(exec, login, pin);
    } catch (err) {
      // If boot migrations failed (App.tsx logs and continues rather than
      // strand the device), `operators_mirror` may not exist yet and this
      // query throws — surface the same wrong-credentials slot instead of an
      // unhandled rejection.
      console.error("station: verifyOperatorPin failed", err);
      operator = null;
    }
    if (operator) {
      onAuthed(operator);
      return;
    }
    // Never say WHICH half was wrong — that would enumerate personnel numbers.
    setError(t("login.wrong"));
    setPin("");
    setStage("login");
    setLogin("");
  }

  const value = stage === "login" ? login : pin;
  const setValue = stage === "login" ? setLogin : setPin;

  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", gap: 24 }}>
      <h1 style={{ fontSize: "2.25rem" }}>{t("login.title")}</h1>
      <p style={{ fontSize: "1.25rem" }}>
        {stage === "login" ? t("login.loginPrompt") : t("login.pinPrompt")}
      </p>
      <div
        aria-label={stage === "login" ? "login" : "pin"}
        style={{ fontSize: "3rem", letterSpacing: "0.5rem" }}
      >
        {stage === "login" ? login : "•".repeat(pin.length)}
      </div>
      {error ? <Alert tone="error">{error}</Alert> : null}
      <PinPad value={value} onChange={setValue} />
      <div style={{ display: "flex", gap: 12 }}>
        <Button
          variant="secondary"
          style={{ minHeight: 64 }}
          onClick={() => {
            if (stage === "pin") {
              setPin("");
              setStage("login");
            } else {
              setLogin("");
            }
          }}
        >
          {stage === "pin" ? t("login.back") : t("login.clear")}
        </Button>
        <Button
          style={{ minHeight: 64 }}
          disabled={value.length === 0}
          onClick={() => {
            if (stage === "login") {
              setError(null);
              setStage("pin");
            } else {
              void submit();
            }
          }}
        >
          {stage === "login" ? t("login.next") : t("login.submit")}
        </Button>
      </div>
    </main>
  );
}
```

- [ ] **Step 7: Update the operator-login component test**

`apps/station/test/operator-login.test.tsx` drives the old single-stage screen. Rewrite its
happy path to walk both stages, keeping the file's existing render helper and mocks:

```tsx
it("signs in with a personnel number then a PIN", async () => {
  const exec = makeExec();
  await applyMigrations(exec);
  await replaceOperatorsMirror(exec, [
    {
      operatorId: "op-1",
      name: "Смирнов А.",
      login: "1042",
      role: "operator",
      pinHash: await hashSecret("4821"),
      badgeHash: null,
      active: true,
    },
  ]);
  const onAuthed = vi.fn();
  render(<OperatorLogin exec={exec} onAuthed={onAuthed} />);

  // Stage 1: personnel number -> Next
  for (const digit of "1042") {
    fireEvent.click(screen.getByRole("button", { name: digit }));
  }
  fireEvent.click(screen.getByRole("button", { name: "Next" }));

  // Stage 2: PIN -> Sign in
  for (const digit of "4821") {
    fireEvent.click(screen.getByRole("button", { name: digit }));
  }
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

  await waitFor(() => expect(onAuthed).toHaveBeenCalledTimes(1));
  expect(onAuthed.mock.calls[0]![0]).toMatchObject({ operatorId: "op-1", login: "1042" });
});
```

Update the wrong-credentials case the same way (wrong PIN at stage 2 → error shown,
`onAuthed` not called, screen back at stage 1), and keep the throwing-executor case
unchanged in intent. `makeExec` is the `node:sqlite` helper used by
`apps/station/test/mirror.test.ts` — copy it into this file if it is not already shared.
The button names above assume the EN dictionary (`i18n.changeLanguage("en")` in
`beforeAll`, as the file already does); use `login.next` / `login.submit` values verbatim.

- [ ] **Step 8: Run the station suite**

```bash
pnpm --filter @markiro/station test
pnpm --filter @markiro/station typecheck
pnpm --filter @markiro/station lint
```

Expected: all green.

- [ ] **Step 9: Commit**

```bash
git add apps/station/src apps/station/test
git commit -m "feat(station): sign in by personnel number and PIN"
```

---

### Task 7: Station initialization roster sync (the F6 fix)

**Files:**

- Create: `apps/station/src/lib/roster-sync.ts`
- Modify: `apps/station/src/App.tsx`
- Test: `apps/station/test/roster-sync.test.ts`

**Interfaces:**

- Consumes: `StationClient.get` (`apps/station/src/lib/api-client.ts`), `replaceOperatorsMirror` + `SqlExecutor` (Task 1), `GET /station/operators` (Task 4).
- Produces: `syncOperatorRoster(client: Pick<StationClient, "get">, exec: SqlExecutor): Promise<void>` — resilient (never throws).

**Why this closes F6:** enrollment happens before any sign-in, so a device that pulls the roster as soon as it has a credential always has someone to sign in as. Running it whenever the client becomes available also covers "already enrolled, app restarted" and refreshes after a hire.

- [ ] **Step 1: Write the failing test**

Create `apps/station/test/roster-sync.test.ts`:

```ts
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { applyMigrations, readOperatorsMirror, type SqlExecutor } from "../src/lib/mirror.js";
import { syncOperatorRoster } from "../src/lib/roster-sync.js";

function makeExec(): SqlExecutor {
  const db = new DatabaseSync(":memory:");
  return {
    run: async (sql, params = []) => {
      db.prepare(sql).run(...(params as never[]));
    },
    all: async <T>(sql: string, params: unknown[] = []) =>
      db.prepare(sql).all(...(params as never[])) as T[],
  };
}

const OPERATOR = {
  operatorId: "op-1",
  name: "Смирнов А.",
  login: "1042",
  role: "operator",
  pinHash: "pbkdf2$sha256$100000$c2FsdA==$aGFzaA==",
  badgeHash: null,
  active: true,
};

describe("syncOperatorRoster", () => {
  it("pulls the roster into the mirror before any sign-in", async () => {
    const exec = makeExec();
    await applyMigrations(exec);
    const get = vi.fn().mockResolvedValue({ items: [OPERATOR] });

    await syncOperatorRoster({ get }, exec);

    expect(get).toHaveBeenCalledWith("/station/operators");
    const rows = await readOperatorsMirror(exec);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ operatorId: "op-1", login: "1042" });
  });

  it("replaces the previous set so a removed operator stops authenticating", async () => {
    const exec = makeExec();
    await applyMigrations(exec);
    await syncOperatorRoster(
      {
        get: vi.fn().mockResolvedValue({
          items: [OPERATOR, { ...OPERATOR, operatorId: "op-2", login: "1043" }],
        }),
      },
      exec,
    );
    expect(await readOperatorsMirror(exec)).toHaveLength(2);

    await syncOperatorRoster({ get: vi.fn().mockResolvedValue({ items: [OPERATOR] }) }, exec);
    const rows = await readOperatorsMirror(exec);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.operatorId).toBe("op-1");
  });

  it("never throws when offline — the device keeps its cached roster", async () => {
    const exec = makeExec();
    await applyMigrations(exec);
    await syncOperatorRoster({ get: vi.fn().mockResolvedValue({ items: [OPERATOR] }) }, exec);

    await expect(
      syncOperatorRoster({ get: vi.fn().mockRejectedValue(new Error("offline")) }, exec),
    ).resolves.toBeUndefined();
    expect(await readOperatorsMirror(exec)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @markiro/station exec vitest run roster-sync`
Expected: FAIL — cannot resolve `../src/lib/roster-sync.js`.

- [ ] **Step 3: Implement the sync**

Create `apps/station/src/lib/roster-sync.ts`:

```ts
import type { OperatorMirrorRecord } from "@markiro/db";
import type { StationClient } from "./api-client.js";
import { replaceOperatorsMirror, type SqlExecutor } from "./mirror.js";

/**
 * Downloads the tenant's operator roster (`GET /station/operators`) into the
 * local mirror. Runs during station initialization — right after the device has
 * a credential and BEFORE any operator can sign in — which is what makes a
 * freshly installed station usable (05a shipped with an empty mirror and no way
 * to fill it before login).
 *
 * Deliberately resilient: a device that is offline at startup must keep working
 * on the roster it already cached, so failures are logged, never rethrown. A
 * successful sync REPLACES the whole set, so an operator removed or deactivated
 * server-side stops authenticating offline.
 */
export async function syncOperatorRoster(
  client: Pick<StationClient, "get">,
  exec: SqlExecutor,
): Promise<void> {
  try {
    const { items } = await client.get<{ items: OperatorMirrorRecord[] }>("/station/operators");
    await exec.run("BEGIN");
    try {
      await replaceOperatorsMirror(exec, items);
      await exec.run("COMMIT");
    } catch (err) {
      await exec.run("ROLLBACK");
      throw err;
    }
  } catch (err) {
    console.error("station: operator roster sync failed", err);
  }
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @markiro/station exec vitest run roster-sync`
Expected: PASS (3 tests).

- [ ] **Step 5: Run it during initialization**

In `apps/station/src/App.tsx`, add the import:

```ts
import { syncOperatorRoster } from "./lib/roster-sync.js";
```

and add this effect immediately after the `client` memo (it must sit with the other
hooks, before the `if (!config)` early return):

```tsx
// Initialization sync: as soon as the device has a credential — right after
// enrollment, and on every later start — pull the operator roster so the
// sign-in screen has someone to authenticate. Without this a freshly
// enrolled station shows a PIN pad no PIN can ever satisfy.
useEffect(() => {
  if (!client) return;
  void syncOperatorRoster(client, tauriExecutor);
}, [client]);
```

- [ ] **Step 6: Run the station suite**

```bash
pnpm --filter @markiro/station test
pnpm --filter @markiro/station typecheck
pnpm --filter @markiro/station lint
```

Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add apps/station/src apps/station/test
git commit -m "feat(station): sync the operator roster during initialization"
```

---

### Task 8: Admin — station access on the employee card

**Files:**

- Create: `apps/admin/src/pages/employees/station-access-api.ts`
- Modify: `apps/admin/src/pages/employees/EmployeeForm.tsx`, `apps/admin/src/i18n/ru.json`, `apps/admin/src/i18n/en.json`
- Test: `apps/admin/test/employees.test.tsx` (extend; create if absent)

**Interfaces:**

- Consumes: `apiFetch` / `ApiRequestError` (`../../api/client.js`), `errorProp` (`../../lib/form-error.js`), `toast` (`../../lib/toast.js`), the operators routes from Tasks 3–4.
- Produces: `useGrantStationAccess()`, `useUpdateStationAccess()`, `useRevokeStationAccess()`, `useOperators()`, plus types `OperatorListItemDto` / `StationAccessDto`.

- [ ] **Step 1: Write the API hooks**

Create `apps/admin/src/pages/employees/station-access-api.ts`:

```ts
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";

import { apiFetch } from "../../api/client.js";
import { EMPLOYEES_QUERY_KEY } from "./api.js";

export interface OperatorListItemDto {
  employeeId: string;
  fullName: string;
  role: string | null;
  login: string;
  active: boolean;
  hasBadge: boolean;
}

export interface StationAccessDto {
  employeeId: string;
  login: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface GrantStationAccessInput {
  login: string;
  pin: string;
}

export interface UpdateStationAccessInput {
  login?: string;
  pin?: string;
  active?: boolean;
}

export const OPERATORS_QUERY_KEY = ["operators"] as const;

/** `GET /operators` — employees who have line-station access. */
export function useOperators(): UseQueryResult<OperatorListItemDto[]> {
  return useQuery({
    queryKey: OPERATORS_QUERY_KEY,
    queryFn: async () => {
      const response = await apiFetch<{ items: OperatorListItemDto[] }>("/operators");
      return response.items;
    },
  });
}

function invalidate(queryClient: ReturnType<typeof useQueryClient>) {
  void queryClient.invalidateQueries({ queryKey: OPERATORS_QUERY_KEY });
  void queryClient.invalidateQueries({ queryKey: EMPLOYEES_QUERY_KEY });
}

/** `PUT /operators/:employeeId` — grants access or replaces the personnel number + PIN. */
export function useGrantStationAccess(): UseMutationResult<
  StationAccessDto,
  Error,
  { employeeId: string; input: GrantStationAccessInput }
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ employeeId, input }) =>
      apiFetch<StationAccessDto>(`/operators/${employeeId}`, {
        method: "PUT",
        body: JSON.stringify(input),
      }),
    onSuccess: () => invalidate(queryClient),
  });
}

/** `PATCH /operators/:employeeId` — reset the PIN or enable/disable access. */
export function useUpdateStationAccess(): UseMutationResult<
  StationAccessDto,
  Error,
  { employeeId: string; input: UpdateStationAccessInput }
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ employeeId, input }) =>
      apiFetch<StationAccessDto>(`/operators/${employeeId}`, {
        method: "PATCH",
        body: JSON.stringify(input),
      }),
    onSuccess: () => invalidate(queryClient),
  });
}

/** `DELETE /operators/:employeeId` — removes station access entirely. */
export function useRevokeStationAccess(): UseMutationResult<void, Error, string> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (employeeId) => apiFetch<void>(`/operators/${employeeId}`, { method: "DELETE" }),
    onSuccess: () => invalidate(queryClient),
  });
}
```

- [ ] **Step 2: Add the i18n keys (RU + EN, identical key sets)**

In `apps/admin/src/i18n/ru.json`, inside `pages.employees`, add a `stationAccess` block after `badges`:

```json
      "stationAccess": {
        "title": "Доступ на станцию",
        "emptyHint": "Доступ на линейную станцию не выдан",
        "loginLabel": "Табельный номер",
        "pinLabel": "ПИН-код",
        "grantAction": "Выдать доступ",
        "resetAction": "Сменить ПИН",
        "disableAction": "Отключить",
        "enableAction": "Включить",
        "revokeAction": "Убрать доступ",
        "activeBadge": "Активен",
        "disabledBadge": "Отключён",
        "current": "Табельный номер {{login}}"
      },
```

and the matching English block in `apps/admin/src/i18n/en.json`:

```json
      "stationAccess": {
        "title": "Station access",
        "emptyHint": "No line-station access granted",
        "loginLabel": "Personnel number",
        "pinLabel": "PIN",
        "grantAction": "Grant access",
        "resetAction": "Change PIN",
        "disableAction": "Disable",
        "enableAction": "Enable",
        "revokeAction": "Remove access",
        "activeBadge": "Active",
        "disabledBadge": "Disabled",
        "current": "Personnel number {{login}}"
      },
```

Also add to both files' `pages.employees.toasts` block:

```json
        "stationAccessSuccess": "Доступ на станцию обновлён",
        "stationAccessError": "Не удалось обновить доступ на станцию"
```

(EN: `"Station access updated"` / `"Could not update station access"`.)

- [ ] **Step 3: Add the block to the employee form**

In `apps/admin/src/pages/employees/EmployeeForm.tsx`, add to the imports:

```tsx
import {
  useGrantStationAccess,
  useOperators,
  useRevokeStationAccess,
  useUpdateStationAccess,
} from "./station-access-api.js";
```

Add this state + handlers next to the badge sub-panel's (after `handleRevokeBadge`):

```tsx
// --- Station access sub-panel (edit mode only) ---
const operatorsQuery = useOperators();
const grantAccessMutation = useGrantStationAccess();
const updateAccessMutation = useUpdateStationAccess();
const revokeAccessMutation = useRevokeStationAccess();
const [accessLogin, setAccessLogin] = useState("");
const [accessPin, setAccessPin] = useState("");

const access = employee
  ? operatorsQuery.data?.find((op) => op.employeeId === employee.id)
  : undefined;

useEffect(() => {
  if (open) {
    setAccessLogin("");
    setAccessPin("");
  }
}, [open, employee?.id]);

/** Runs a station-access mutation with the file's shared toast/error idiom. */
const runAccess = async (action: () => Promise<unknown>) => {
  try {
    await action();
    toast("ok", t("pages.employees.toasts.stationAccessSuccess"));
  } catch (error) {
    toast(
      "error",
      error instanceof ApiRequestError
        ? error.message
        : t("pages.employees.toasts.stationAccessError"),
    );
  }
};

const handleGrantAccess = async () => {
  if (!employee) return;
  const login = accessLogin.trim();
  const pin = accessPin.trim();
  if (!login || !pin) return;
  await runAccess(() =>
    grantAccessMutation.mutateAsync({ employeeId: employee.id, input: { login, pin } }),
  );
  setAccessPin("");
};
```

Render this block immediately after the badges block's closing `)}` (still inside the
outer `<div>`, `mode === "edit" && employee` only):

```tsx
{
  mode === "edit" && employee && (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 12,
        borderTop: "1px solid var(--line)",
        paddingTop: 16,
      }}
    >
      <span style={{ font: "600 13px/1 var(--font-ui)", color: "var(--fg-1)" }}>
        {t("pages.employees.stationAccess.title")}
      </span>

      {access ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
          }}
        >
          <span style={{ font: "var(--text-body)", color: "var(--fg-1)" }}>
            {t("pages.employees.stationAccess.current", { login: access.login })}
          </span>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <StatusChip
              status={access.active ? "ok" : "neutral"}
              label={
                access.active
                  ? t("pages.employees.stationAccess.activeBadge")
                  : t("pages.employees.stationAccess.disabledBadge")
              }
            />
            <Button
              type="button"
              size="compact"
              variant="secondary"
              loading={updateAccessMutation.isPending}
              onClick={() =>
                void runAccess(() =>
                  updateAccessMutation.mutateAsync({
                    employeeId: employee.id,
                    input: { active: !access.active },
                  }),
                )
              }
            >
              {access.active
                ? t("pages.employees.stationAccess.disableAction")
                : t("pages.employees.stationAccess.enableAction")}
            </Button>
            <Button
              type="button"
              size="compact"
              variant="destructive"
              loading={revokeAccessMutation.isPending}
              onClick={() => void runAccess(() => revokeAccessMutation.mutateAsync(employee.id))}
            >
              {t("pages.employees.stationAccess.revokeAction")}
            </Button>
          </div>
        </div>
      ) : (
        <p style={{ font: "var(--text-caption)", color: "var(--fg-3)", margin: 0 }}>
          {t("pages.employees.stationAccess.emptyHint")}
        </p>
      )}

      <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
        <div style={{ flex: 1 }}>
          <Input
            label={t("pages.employees.stationAccess.loginLabel")}
            mono
            inputMode="numeric"
            value={accessLogin}
            onChange={(event) => setAccessLogin(event.target.value)}
          />
        </div>
        <div style={{ flex: 1 }}>
          <Input
            label={t("pages.employees.stationAccess.pinLabel")}
            mono
            inputMode="numeric"
            type="password"
            value={accessPin}
            onChange={(event) => setAccessPin(event.target.value)}
          />
        </div>
        <Button
          type="button"
          size="compact"
          disabled={accessLogin.trim().length === 0 || accessPin.trim().length === 0}
          loading={grantAccessMutation.isPending}
          onClick={() => void handleGrantAccess()}
        >
          {access
            ? t("pages.employees.stationAccess.resetAction")
            : t("pages.employees.stationAccess.grantAction")}
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Write the component test**

Extend `apps/admin/test/employees.test.tsx` (create it following the repo's other
admin page tests if it does not exist) with a case that opens an employee for edit,
fills the personnel number and PIN, clicks **Grant access**, and asserts a
`PUT /operators/:id` request carrying `{ login, pin }`. Mock `fetch` the way the
existing admin tests do, and render in EN (`i18n.changeLanguage("en")` in `beforeAll`).

- [ ] **Step 5: Run the admin suite**

```bash
pnpm --filter @markiro/admin test
pnpm --filter @markiro/admin typecheck
pnpm --filter @markiro/admin lint
```

Expected: all green (the i18n lockstep test must pass — it fails on any key present in one dictionary only).

- [ ] **Step 6: Commit**

```bash
git add apps/admin/src apps/admin/test
git commit -m "feat(admin): grant and manage line-station access on the employee card"
```

---

### Task 9: Docs and full verification

**Files:**

- Modify: `docs/superpowers/plans/2026-07-21-markiro-mvp-roadmap.md`, `apps/station/README.md`

- [ ] **Step 1: Update the roadmap**

In `docs/superpowers/plans/2026-07-21-markiro-mvp-roadmap.md`, split the 05b row into
`05b-1` (this plan: operators roster & station access — mark **done** with the date) and
`05b-2` (validation work screen, signal system, hardware module — depends on 05b-1).

- [ ] **Step 2: Document the roster in the station README**

Add a short "Operator roster" section to `apps/station/README.md`: the device pulls
`GET /station/operators` during initialization (right after enrollment) into
`operators_mirror`; sign-in is personnel number + PIN or a badge scan; the roster
refreshes whenever the app starts online and with each shift bundle; an operator hired
while the device is offline cannot sign in until the next sync. Reference the credential-hash
contract section already in that file.

- [ ] **Step 3: Full workspace verification**

```bash
pnpm format:check
DATABASE_URL=postgres://markiro:markiro@localhost:5432/markiro BETTER_AUTH_SECRET=insecure-dummy-ci-placeholder-not-a-secret BETTER_AUTH_URL=http://localhost:3000 ADMIN_ORIGIN=http://localhost:5173 pnpm --filter @markiro/db db:migrate
DATABASE_URL=postgres://markiro:markiro@localhost:5432/markiro BETTER_AUTH_SECRET=insecure-dummy-ci-placeholder-not-a-secret BETTER_AUTH_URL=http://localhost:3000 ADMIN_ORIGIN=http://localhost:5173 pnpm turbo lint typecheck test build
cargo test --manifest-path apps/station/src-tauri/Cargo.toml
```

Expected: `format:check` clean, all turbo tasks green (report per-package test counts), cargo green.
If `pnpm format:check` flags new files, run `pnpm format` and re-check.

- [ ] **Step 4: Commit**

```bash
git add docs apps/station/README.md
git commit -m "docs: 05b-1 roster in the roadmap and station README"
```

---

## Verification Checklist

- [ ] A hash produced by `apps/api/src/lib/pin-hash.ts` verifies in `apps/station/src/lib/crypto.ts` (the known-vector tests on both sides).
- [ ] No response body anywhere contains a plaintext PIN, a `pinHash` on an admin route, or a plaintext badge code on a station route.
- [ ] Every operators query and mutation filters `tenant_id` in the SQL statement; the cross-tenant e2e proves list/revoke isolation.
- [ ] A station api-key gets `200` on `GET /station/operators` and `403` on every `/operators` admin route.
- [ ] `GET /shifts/:id/bundle` and `GET /station/operators` return the same roster (one service method).
- [ ] A freshly enrolled station reaches a usable sign-in screen without a shift being selected first (F6 closed).
- [ ] Re-running `applyMigrations` on an already-migrated device does not throw.
- [ ] Admin i18n RU/EN key sets are identical.
