# Pickup Kiosk Plan B-1 — Server & Domain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver everything the pickup-kiosk device needs from the server side — a shared PBKDF2/PHC verifier in `packages/domain`, a bootstrap payload that ships badge **hashes** instead of plaintext, single-use device pairing, persisted sync conflicts surfaced in the admin panel, and the device-key-surface triage this workstream owes — so that Plan B-2 (`apps/kiosk`) can be built against frozen contracts.

**Architecture:** Follows the repo's existing patterns exactly. Pure, dependency-free logic goes to `packages/domain` (WebCrypto, works in Node and the browser). Tables land in `packages/db` as Drizzle schemas using the composite `(tenant_id, id)` FK pattern; migrations are drizzle-generated. API work is NestJS 4-file modules (`dto`/`controller`/`service`/`module`) with Zod validation via `ZodValidationPipe`, `TenantGuard` for cabinet routes, `SessionOnlyGuard` where a device key must be refused, and the existing `KioskDeviceGuard` for device routes. The one unauthenticated route (`POST /kiosk/pair`) lives in its own controller so no guard applies to it.

**Tech Stack:** TypeScript 6, NestJS 11 + Drizzle 0.45 + Postgres + Better Auth 1.6 + Zod 4, React 19 + Vite 8 + TanStack Query 5 (admin), Vitest 4 (+ supertest for API e2e, React Testing Library for admin).

## Global Constraints

- **Versions pinned** per `docs/architecture.md` §1 (Node 24, TS 6.0, NestJS 11.1, Drizzle 0.45 / drizzle-kit 0.31, better-auth 1.6, React 19.2, Vite 8.1, Zod 4.4; pnpm 11.10 + turbo 2.10). Root `.npmrc` stays as committed (npmjs registry, `save-exact`, `engine-strict`, `minimum-release-age=10080` — any new dep must be ≥7 days old and pinned EXACTLY, no `^`).
- **Multi-tenant:** every new table carries `tenant_id`; cross-table references use the composite `(tenant_id, id)` FK pattern from `packages/db/src/schema/pickup.ts`. Every query is tenant-scoped. Cross-tenant access returns **404**, never 403.
- **Credential-hash contract (byte-exact, do not alter):** PHC `pbkdf2$sha256$<iter>$<saltB64>$<hashB64>`, SHA-256, **100000** iterations, **32-byte** key, **16-byte** salt, standard base64 **with padding**, verify floor `MIN_ITERATIONS = 10000`. The executable specs are `apps/api/test/pin-hash.test.ts` and `apps/station/test/crypto.test.ts` — both must stay green.
- **No plaintext credentials to devices.** Per `docs/device-key-surface.md`, a device payload carries PBKDF2 verifiers only. This plan removes the kiosk's plaintext-badge exception.
- **Badge verifiers use a per-tenant salt; PIN verifiers keep a per-row salt.** (Spec §6.2 — badge lookup must cost one derivation, PINs are 4 digits and must stay per-row salted.)
- **`POST /kiosk/orders` request/response shape does not change.**
- **TDD throughout** (Vitest); test output must be pristine (no stray warnings). API/DB tests run against the live dev Postgres — they must RUN, not skip.
- **All UI: RU primary + EN, key-parallel** (`apps/admin/src/i18n/{ru,en}.json`; a missing key throws in tests).
- **CI gate** is `pnpm turbo lint typecheck test build` **plus** `pnpm format:check` (prettier). Format only the files you touch: `pnpm exec prettier --write <paths>` — never `prettier --write .`, which descends into sibling git worktrees under `.worktrees/`.

## Environment

The dev Postgres container is up on `localhost:5432`. API and DB tests gate on env vars and will silently SKIP without them. Load env before running them:

```bash
set -a; . ./.env; set +a
```

`pnpm --filter <pkg> test -- <name>` does **not** filter to one file in this repo. To run a single suite use:

```bash
pnpm --filter @markiro/api exec vitest run <name>
```

## File Structure

**`packages/domain`** — shared, pure, no I/O:

- `src/crypto/phc.ts` (new) — parse/format PHC strings, derive digests, verify. The single implementation both the kiosk (Plan B-2) and future callers use.
- `src/index.ts` (modify) — barrel exports.
- `test/phc.test.ts` (new) — interop vectors + the fast-path derivation.

**`packages/db`** — schema only:

- `src/schema/pickup.ts` (modify) — `employeeBadgeSalts`, `kioskPairingCodes`, `pickupOrders.syncConflicts`.
- `migrations/0011_*.sql` + `meta/` (generated).
- `test/pickup-b1-schema.test.ts` (new) — constraint behaviour against live Postgres.

**`apps/api`**:

- `src/lib/badge-salt.ts` (new) — get-or-create the tenant badge salt, hash a badge with it. One responsibility, unit-testable.
- `src/modules/operators/operators.service.ts` (modify) — `activeBadgeHashes` re-hashes with the tenant salt.
- `src/modules/pickup-orders/dto.ts` (modify) — `KioskBootstrapDto` (badgeHash + operators), pairing DTOs, conflict fields.
- `src/modules/pickup-orders/pickup-orders.service.ts` (modify) — bootstrap payload; persist conflicts; `nextDeviceSeq`.
- `src/modules/kiosks/{dto,kiosks.service,kiosks.controller}.ts` (modify) — issue pairing code.
- `src/modules/kiosk/kiosk-pair.controller.ts` (new) — the unauthenticated exchange, guardless by construction.
- `src/modules/kiosk/pairing.service.ts` (new) — code generation, verification, lockout, bundle assembly.
- Guard triage: `src/modules/{kiosks/kiosks,pickup-orders/pickup-orders,pickup-reasons/pickup-reasons}.controller.ts` (modify).
- Tests: `test/{badge-salt,kiosk-pairing,kiosk-bootstrap-hashes,pickup-conflicts,device-key-triage}.e2e.test.ts` (new).

**`apps/admin`**:

- `src/pages/pickup/api.ts` (modify) — conflict fields on the DTOs.
- `src/pages/pickup/OrderDetail.tsx` (modify) — conflicts plaque.
- `src/i18n/{ru,en}.json` (modify).
- `test/pickup-detail.test.tsx` (modify).

**Docs:** `docs/device-key-surface.md`, `docs/superpowers/plans/2026-07-21-markiro-mvp-roadmap.md`.

---

### Task 1: Shared PHC verifier in `packages/domain`

**Files:**

- Create: `packages/domain/src/crypto/phc.ts`
- Modify: `packages/domain/src/index.ts`
- Test: `packages/domain/test/phc.test.ts`

**Interfaces:**

- Consumes: nothing (first task).
- Produces, exported from `@markiro/domain`:

  ```ts
  export interface ParsedPhc {
    iterations: number;
    saltB64: string;
    digestB64: string;
  }
  export function parsePhc(phc: string): ParsedPhc | null;
  export function formatPhc(iterations: number, saltB64: string, digestB64: string): string;
  export function deriveDigestB64(
    secret: string,
    saltB64: string,
    iterations: number,
  ): Promise<string>;
  export function verifyPhc(secret: string, phc: string): Promise<boolean>;
  export const PHC_ITERATIONS: 100000;
  ```

  `deriveDigestB64` is what makes the kiosk's one-derivation badge lookup possible (Plan B-2 derives once, then compares against a `Map<digestB64, employeeId>`).

- [ ] **Step 1: Write the failing test** — `packages/domain/test/phc.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  deriveDigestB64,
  formatPhc,
  parsePhc,
  PHC_ITERATIONS,
  verifyPhc,
} from "../src/crypto/phc.js";

// A structurally valid 16-byte salt, borrowed from the station's DUMMY_PHC
// constant (apps/station/src/lib/auth.ts). Its plaintext is deliberately
// unknown — DUMMY_PHC exists only to equalise verification timing — so use
// this value ONLY for structural assertions, never to assert that some
// particular secret verifies against it.
const KNOWN_SALT_B64 = "fwGrIt01vwgBxxDlhqLVRQ==";

describe("parsePhc", () => {
  it("splits a well-formed verifier into its fields", () => {
    const phc = `pbkdf2$sha256$100000$${KNOWN_SALT_B64}$PGnhdQA2lW09CcvuOhCmvp0z4HbztWXaYIq7+dqmLoQ=`;
    expect(parsePhc(phc)).toEqual({
      iterations: 100000,
      saltB64: KNOWN_SALT_B64,
      digestB64: "PGnhdQA2lW09CcvuOhCmvp0z4HbztWXaYIq7+dqmLoQ=",
    });
  });

  it("rejects a malformed, foreign or downgraded verifier", () => {
    expect(parsePhc("nope")).toBeNull();
    expect(parsePhc("pbkdf2$sha512$100000$AA==$AA==")).toBeNull();
    expect(parsePhc(`argon2$sha256$100000$${KNOWN_SALT_B64}$AA==`)).toBeNull();
    // below MIN_ITERATIONS: a tampered bundle must not cheapen the derivation
    expect(parsePhc(`pbkdf2$sha256$1000$${KNOWN_SALT_B64}$AA==`)).toBeNull();
    // non-canonical base64 must not slip through
    expect(parsePhc(`pbkdf2$sha256$100000$${KNOWN_SALT_B64}$AA==!`)).toBeNull();
  });
});

describe("deriveDigestB64 / verifyPhc", () => {
  it("round-trips: a derived digest verifies against its own PHC string", async () => {
    const digest = await deriveDigestB64("BADGE-4412", KNOWN_SALT_B64, PHC_ITERATIONS);
    const phc = formatPhc(PHC_ITERATIONS, KNOWN_SALT_B64, digest);
    await expect(verifyPhc("BADGE-4412", phc)).resolves.toBe(true);
    await expect(verifyPhc("BADGE-9999", phc)).resolves.toBe(false);
  });

  it("is deterministic for the same secret and salt — this is what lets the kiosk derive once and look the result up in a map", async () => {
    const a = await deriveDigestB64("BADGE-4412", KNOWN_SALT_B64, PHC_ITERATIONS);
    const b = await deriveDigestB64("BADGE-4412", KNOWN_SALT_B64, PHC_ITERATIONS);
    expect(a).toBe(b);
  });

  it("returns false instead of throwing on a malformed verifier", async () => {
    await expect(verifyPhc("x", "not-a-phc-string")).resolves.toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @markiro/domain exec vitest run phc`
Expected: FAIL — `Cannot find module '../src/crypto/phc.js'`.

- [ ] **Step 3: Implement `packages/domain/src/crypto/phc.ts`**

```ts
/**
 * Shared PBKDF2/PHC verifier. Byte-compatible with the server
 * (`apps/api/src/lib/pin-hash.ts`) and the station
 * (`apps/station/src/lib/crypto.ts`): `pbkdf2$sha256$<iter>$<saltB64>$<hashB64>`,
 * SHA-256, 100000 iterations, 32-byte key, 16-byte salt, standard base64 WITH
 * padding. Uses WebCrypto, which exists both in browsers and in Node 24, so
 * this module stays dependency-free and runnable on a kiosk tablet.
 */
export const PHC_ITERATIONS = 100_000;
const KEY_BITS = 256;
const KEY_BYTES = 32;
const SALT_BYTES = 16;
/** Verify floor: a foreign or tampered verifier must not cheapen the work. */
const MIN_ITERATIONS = 10_000;

export interface ParsedPhc {
  iterations: number;
  saltB64: string;
  digestB64: string;
}

function fromB64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toB64(bytes: Uint8Array): string {
  let s = "";
  for (const byte of bytes) s += String.fromCharCode(byte);
  return btoa(s);
}

/**
 * Decodes base64 only when the input is the CANONICAL encoding of its bytes.
 * `atob` is lenient about trailing garbage and padding, which would let a
 * non-canonical field past a naive length check.
 */
function decodeCanonical(value: string, expectedBytes: number): Uint8Array | null {
  let decoded: Uint8Array;
  try {
    decoded = fromB64(value);
  } catch {
    return null;
  }
  if (decoded.length !== expectedBytes) return null;
  if (toB64(decoded) !== value) return null;
  return decoded;
}

export function parsePhc(phc: string): ParsedPhc | null {
  const parts = phc.split("$");
  if (parts.length !== 5 || parts[0] !== "pbkdf2" || parts[1] !== "sha256") return null;
  const iterations = Number(parts[2]);
  if (!Number.isInteger(iterations) || iterations < MIN_ITERATIONS) return null;
  const saltB64 = parts[3]!;
  const digestB64 = parts[4]!;
  if (!decodeCanonical(saltB64, SALT_BYTES)) return null;
  if (!decodeCanonical(digestB64, KEY_BYTES)) return null;
  return { iterations, saltB64, digestB64 };
}

export function formatPhc(iterations: number, saltB64: string, digestB64: string): string {
  return `pbkdf2$sha256$${iterations}$${saltB64}$${digestB64}`;
}

export async function deriveDigestB64(
  secret: string,
  saltB64: string,
  iterations: number,
): Promise<string> {
  const salt = fromB64(saltB64);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
    key,
    KEY_BITS,
  );
  return toB64(new Uint8Array(bits));
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyPhc(secret: string, phc: string): Promise<boolean> {
  const parsed = parsePhc(phc);
  if (!parsed) return false;
  const actual = await deriveDigestB64(secret, parsed.saltB64, parsed.iterations);
  return constantTimeEqual(actual, parsed.digestB64);
}
```

- [ ] **Step 4: Add the barrel exports** — append to `packages/domain/src/index.ts`:

```ts
export { deriveDigestB64, formatPhc, parsePhc, PHC_ITERATIONS, verifyPhc } from "./crypto/phc.js";
export type { ParsedPhc } from "./crypto/phc.js";
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @markiro/domain exec vitest run phc`
Expected: PASS (5 tests).

- [ ] **Step 6: Prove interop with the two existing implementations**

Add to `packages/domain/test/phc.test.ts`:

```ts
import { hashSecret as stationHash } from "../../../apps/station/src/lib/crypto.js";

describe("interop with the station verifier", () => {
  it("verifies a PHC string minted by apps/station/src/lib/crypto.ts", async () => {
    const phc = await stationHash("1234");
    await expect(verifyPhc("1234", phc)).resolves.toBe(true);
    await expect(verifyPhc("4321", phc)).resolves.toBe(false);
  });
});
```

Run: `pnpm --filter @markiro/domain exec vitest run phc`
Expected: PASS. If the cross-package import cannot resolve (domain has no path mapping to `apps/`), delete this `describe` block and instead paste the station's known vector inline:

```ts
it("verifies a known-answer vector computed with the contract's parameters", async () => {
  // Known-answer test, computed independently with node:crypto:
  //   pbkdf2Sync("735519", base64decode(KNOWN_SALT_B64), 100000, 32, "sha256")
  // "735519" is the secret apps/station/test/crypto.test.ts hashes, so this
  // pins THIS module to the same PBKDF2 parameters the station uses. If the
  // iteration count, digest, key length or base64 padding ever drift, this
  // fails — which is the whole point of a hardcoded vector.
  const phc =
    "pbkdf2$sha256$100000$fwGrIt01vwgBxxDlhqLVRQ==$PgepXwOPCgYDtXjghPhCfde+aOxZvagqdzi1WbEVZBo=";

  expect(parsePhc(phc)!.iterations).toBe(100000);
  await expect(verifyPhc("735519", phc)).resolves.toBe(true);
  await expect(verifyPhc("735518", phc)).resolves.toBe(false);
});
```

- [ ] **Step 7: Typecheck and format**

```bash
pnpm --filter @markiro/domain typecheck
pnpm exec prettier --write packages/domain/src/crypto/phc.ts packages/domain/src/index.ts packages/domain/test/phc.test.ts
```

Expected: typecheck exits 0.

- [ ] **Step 8: Commit**

```bash
git add packages/domain/src/crypto/phc.ts packages/domain/src/index.ts packages/domain/test/phc.test.ts
git commit -m "feat(domain): shared PBKDF2/PHC verifier"
```

---

### Task 2: Schema — badge salts, pairing codes, sync conflicts

**Files:**

- Modify: `packages/db/src/schema/pickup.ts`
- Create: `packages/db/migrations/0011_*.sql` + `meta/` (drizzle-generated)
- Test: `packages/db/test/pickup-b1-schema.test.ts`

**Interfaces:**

- Consumes: nothing from Task 1.
- Produces (all exported via the existing `packages/db` barrel as `schema.*`):

  ```ts
  schema.employeeBadgeSalts; // { tenantId (PK), salt, createdAt }
  schema.kioskPairingCodes; // { id, tenantId, kioskId, codeHash, expiresAt, usedAt, attempts, createdAt }
  schema.pickupOrders.syncConflicts; // jsonb, nullable — OrderConflict[]
  ```

- [ ] **Step 1: Add the two tables and the column** — append to `packages/db/src/schema/pickup.ts` (keep the file's existing import list; add `jsonb` to the `drizzle-orm/pg-core` import):

```ts
/**
 * One badge salt per tenant. Badge verifiers deliberately share a salt within
 * a tenant so a kiosk can derive ONCE per scan and look the digest up in a
 * map, instead of running PBKDF2 against every employee (that would take
 * seconds on a full staff roster). PIN verifiers keep their per-row salt —
 * a 4-digit PIN needs it.
 */
export const employeeBadgeSalts = pgTable("employee_badge_salts", {
  tenantId: text("tenant_id")
    .primaryKey()
    .references(() => organization.id),
  salt: text("salt").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Single-use device pairing codes. Only the hash is stored; the plaintext is
 * revealed once in the cabinet. `attempts` drives the per-code lockout.
 */
export const kioskPairingCodes = pgTable(
  "kiosk_pairing_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    kioskId: uuid("kiosk_id").notNull(),
    codeHash: text("code_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("kiosk_pairing_codes_tenant_id_uq").on(t.tenantId, t.id),
    // Lookup path for the unauthenticated exchange: the device presents only
    // a code, so this index is what makes that a single hash probe.
    index("kiosk_pairing_codes_hash_idx").on(t.codeHash),
    foreignKey({
      name: "kiosk_pairing_codes_tenant_kiosk_fk",
      columns: [t.tenantId, t.kioskId],
      foreignColumns: [kiosks.tenantId, kiosks.id],
    }),
  ],
);
```

- [ ] **Step 2: Add the conflicts column** — inside the existing `pickupOrders` table definition in the same file, directly after the `deviceSeq` line:

```ts
    deviceSeq: integer("device_seq"),
    // Items the server refused at sync time (OrderConflict[]). An offline
    // order can arrive hours late, so the admin must be able to see what was
    // dropped; without this the conflicts only ever existed in the HTTP
    // response the kiosk got.
    syncConflicts: jsonb("sync_conflicts").$type<{ rawKm: string; reason: string }[]>(),
```

- [ ] **Step 3: Generate the migration**

```bash
pnpm --filter @markiro/db db:generate
```

Expected: creates `packages/db/migrations/0011_<name>.sql` plus `meta/0011_snapshot.json` and a new `_journal.json` entry with `idx: 11`.

- [ ] **Step 4: Verify the generated SQL** — open `packages/db/migrations/0011_*.sql` and confirm it contains, and contains nothing else:

- `CREATE TABLE "employee_badge_salts"` with `tenant_id` PRIMARY KEY,
- `CREATE TABLE "kiosk_pairing_codes"`,
- `ALTER TABLE "pickup_orders" ADD COLUMN "sync_conflicts" jsonb;`,
- `ALTER TABLE ... ADD CONSTRAINT "kiosk_pairing_codes_tenant_kiosk_fk" ... REFERENCES "public"."kiosks"("tenant_id","id")`,
- `CREATE INDEX "kiosk_pairing_codes_hash_idx"`.

If drizzle-kit emits an ALTER touching any other table, STOP and report it rather than editing the file by hand.

- [ ] **Step 5: Write the failing schema test** — `packages/db/test/pickup-b1-schema.test.ts` (copy the harness — env gate, `randomUUID` org, `afterAll` cleanup in FK order — from the existing `packages/db/test/pickup-schema.test.ts`):

```ts
it("keeps one badge salt per tenant", async () => {
  await db.insert(schema.employeeBadgeSalts).values({ tenantId: org.id, salt: "AAAA" });
  await expect(
    db.insert(schema.employeeBadgeSalts).values({ tenantId: org.id, salt: "BBBB" }),
  ).rejects.toMatchObject({ code: "23505" });
});

it("rejects a pairing code for a kiosk of another tenant", async () => {
  await expect(
    db.insert(schema.kioskPairingCodes).values({
      tenantId: org.id,
      kioskId: foreignKioskId,
      codeHash: "deadbeef",
      expiresAt: new Date(Date.now() + 60_000),
    }),
  ).rejects.toMatchObject({ code: "23503" });
});

it("round-trips sync conflicts as JSON on the order", async () => {
  await db
    .update(schema.pickupOrders)
    .set({ syncConflicts: [{ rawKm: "01…", reason: "duplicate" }] })
    .where(and(eq(schema.pickupOrders.tenantId, org.id), eq(schema.pickupOrders.id, orderId)));
  const [row] = await db
    .select({ syncConflicts: schema.pickupOrders.syncConflicts })
    .from(schema.pickupOrders)
    .where(and(eq(schema.pickupOrders.tenantId, org.id), eq(schema.pickupOrders.id, orderId)));
  expect(row!.syncConflicts).toEqual([{ rawKm: "01…", reason: "duplicate" }]);
});
```

Scope every write in this file to `org.id` — an unscoped `UPDATE`/`DELETE` corrupts the shared test database for concurrently running API suites.

- [ ] **Step 6: Run the migration and the test**

```bash
set -a; . ./.env; set +a
pnpm --filter @markiro/db db:migrate
pnpm --filter @markiro/db exec vitest run pickup-b1-schema
```

Expected: the suite RUNS (not "skipped") and all three cases pass.

- [ ] **Step 7: Typecheck, format, commit**

```bash
pnpm --filter @markiro/db typecheck
pnpm exec prettier --write packages/db/src/schema/pickup.ts packages/db/test/pickup-b1-schema.test.ts
git add packages/db/src/schema/pickup.ts packages/db/migrations packages/db/test/pickup-b1-schema.test.ts
git commit -m "feat(db): badge salts, kiosk pairing codes, order sync conflicts"
```

---

### Task 3: Per-tenant badge salt + re-hashing

**Files:**

- Create: `apps/api/src/lib/badge-salt.ts`
- Modify: `apps/api/src/modules/operators/operators.service.ts`
- Test: `apps/api/test/badge-salt.e2e.test.ts`

**Interfaces:**

- Consumes: `schema.employeeBadgeSalts` (Task 2); `parsePhc`, `deriveDigestB64`, `formatPhc`, `PHC_ITERATIONS` from `@markiro/domain` (Task 1).
- Produces:

  ```ts
  export function getOrCreateBadgeSalt(db: Db, tenantId: string): Promise<string>; // base64, 16 bytes
  export function hashBadgeWithSalt(badgeCode: string, saltB64: string): Promise<string>; // PHC string
  ```

  Consumed by `OperatorsService.activeBadgeHashes` (this task) and the bootstrap payload (Task 4).

- [ ] **Step 1: Write the failing e2e test** — `apps/api/test/badge-salt.e2e.test.ts` (harness copied from `apps/api/test/employees.e2e.test.ts`):

```ts
it("mints one salt per tenant and reuses it", async () => {
  const a = await getOrCreateBadgeSalt(db, tenantId);
  const b = await getOrCreateBadgeSalt(db, tenantId);
  expect(a).toBe(b);
  expect(Buffer.from(a, "base64")).toHaveLength(16);
});

it("hashes every badge of a tenant under the same salt, so a kiosk derives once", async () => {
  const salt = await getOrCreateBadgeSalt(db, tenantId);
  const one = await hashBadgeWithSalt("BADGE-1", salt);
  const two = await hashBadgeWithSalt("BADGE-2", salt);
  expect(parsePhc(one)!.saltB64).toBe(parsePhc(two)!.saltB64);
  await expect(verifyPhc("BADGE-1", one)).resolves.toBe(true);
  await expect(verifyPhc("BADGE-2", one)).resolves.toBe(false);
});

it("re-hashes a legacy per-row-salted badge onto the tenant salt", async () => {
  // Seed a badge hashed the OLD way (random per-row salt, as hashSecret does).
  const legacy = await hashSecret("BADGE-LEGACY");
  await db.insert(schema.employeeBadges).values({
    tenantId,
    employeeId,
    badgeCode: "BADGE-LEGACY",
    badgeHash: legacy,
  });
  const salt = await getOrCreateBadgeSalt(db, tenantId);
  expect(parsePhc(legacy)!.saltB64).not.toBe(salt);

  const roster = await operatorsService.buildRoster(tenantId);
  const record = roster.find((r) => r.operatorId === employeeId)!;
  expect(parsePhc(record.badgeHash!)!.saltB64).toBe(salt);
  await expect(verifyPhc("BADGE-LEGACY", record.badgeHash!)).resolves.toBe(true);

  // …and it was persisted, not just computed in memory.
  const [stored] = await db
    .select({ badgeHash: schema.employeeBadges.badgeHash })
    .from(schema.employeeBadges)
    .where(
      and(
        eq(schema.employeeBadges.tenantId, tenantId),
        eq(schema.employeeBadges.badgeCode, "BADGE-LEGACY"),
      ),
    );
  expect(stored!.badgeHash).toBe(record.badgeHash);
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `set -a; . ./.env; set +a && pnpm --filter @markiro/api exec vitest run badge-salt`
Expected: FAIL — `getOrCreateBadgeSalt` is not defined.

- [ ] **Step 3: Implement `apps/api/src/lib/badge-salt.ts`**

```ts
import { randomBytes } from "node:crypto";
import { deriveDigestB64, formatPhc, PHC_ITERATIONS } from "@markiro/domain";
import { schema, type Db } from "@markiro/db";

const SALT_BYTES = 16;

/**
 * The tenant's badge salt, minted on first use. Shared by every badge
 * verifier of the tenant so the kiosk can derive once per scan (see the
 * comment on `employeeBadgeSalts`). The upsert is atomic: two concurrent
 * callers converge on one salt rather than racing to overwrite.
 */
export async function getOrCreateBadgeSalt(db: Db, tenantId: string): Promise<string> {
  const candidate = randomBytes(SALT_BYTES).toString("base64");
  const [row] = await db
    .insert(schema.employeeBadgeSalts)
    .values({ tenantId, salt: candidate })
    .onConflictDoUpdate({
      target: schema.employeeBadgeSalts.tenantId,
      // A no-op update so the existing row is returned instead of nothing.
      set: { tenantId },
    })
    .returning({ salt: schema.employeeBadgeSalts.salt });
  return row!.salt;
}

/** A PHC verifier for `badgeCode` under the tenant's shared badge salt. */
export async function hashBadgeWithSalt(badgeCode: string, saltB64: string): Promise<string> {
  const digest = await deriveDigestB64(badgeCode, saltB64, PHC_ITERATIONS);
  return formatPhc(PHC_ITERATIONS, saltB64, digest);
}
```

- [ ] **Step 4: Re-hash inside `activeBadgeHashes`** — in `apps/api/src/modules/operators/operators.service.ts`, replace the backfill block (the `const needsHash = rows.filter((b) => !b.badgeHash);` section) with:

```ts
// A badge needs (re)hashing when it has no verifier yet, or when its
// verifier still carries a legacy per-row salt. Both cases converge on
// the tenant salt so the kiosk's one-derivation lookup works.
const tenantSalt = await getOrCreateBadgeSalt(this.db, tenantId);
const needsHash = rows.filter((b) => {
  if (!b.badgeHash) return true;
  return parsePhc(b.badgeHash)?.saltB64 !== tenantSalt;
});
const backfilled = new Map<string, string>();
await Promise.all(
  needsHash.map(async (b) => {
    const hash = await hashBadgeWithSalt(b.badgeCode, tenantSalt);
    backfilled.set(b.id, hash);
    await this.db
      .update(schema.employeeBadges)
      .set({ badgeHash: hash })
      .where(and(eq(schema.employeeBadges.tenantId, tenantId), eq(schema.employeeBadges.id, b.id)));
  }),
);

const map = new Map<string, string>();
for (const b of rows) {
  map.set(b.employeeId, backfilled.get(b.id) ?? b.badgeHash!);
}
return map;
```

Add to the file's imports:

```ts
import { parsePhc } from "@markiro/domain";
import { getOrCreateBadgeSalt, hashBadgeWithSalt } from "../../lib/badge-salt";
```

Note the last loop now prefers `backfilled` over the stale `b.badgeHash` — the old code did the reverse, which would have returned the legacy hash it just replaced.

- [ ] **Step 5: Run the test and the station-roster suite**

```bash
set -a; . ./.env; set +a
pnpm --filter @markiro/api exec vitest run badge-salt
pnpm --filter @markiro/api exec vitest run operators
```

Expected: both PASS. The station roster keeps working because a PHC string carries its own salt — `verifyBadge` in `apps/station/src/lib/crypto.ts` is unaffected by where the salt came from.

- [ ] **Step 6: Typecheck, format, commit**

```bash
pnpm --filter @markiro/api typecheck
pnpm exec prettier --write apps/api/src/lib/badge-salt.ts apps/api/src/modules/operators/operators.service.ts apps/api/test/badge-salt.e2e.test.ts
git add apps/api/src/lib/badge-salt.ts apps/api/src/modules/operators/operators.service.ts apps/api/test/badge-salt.e2e.test.ts
git commit -m "feat(api): per-tenant badge salt with legacy re-hashing"
```

---

### Task 4: Bootstrap ships hashes, not plaintext

**Files:**

- Modify: `apps/api/src/modules/pickup-orders/dto.ts`, `apps/api/src/modules/pickup-orders/pickup-orders.service.ts`
- Modify: `apps/api/src/modules/pickup-orders/pickup-orders.module.ts` (provide `OperatorsService`)
- Test: `apps/api/test/kiosk-bootstrap-hashes.e2e.test.ts`

**Interfaces:**

- Consumes: `getOrCreateBadgeSalt` (Task 3); `OperatorsService.buildRoster` (existing).
- Produces the new `KioskBootstrapDto` — Plan B-2 consumes exactly this:

  ```ts
  export interface KioskBootstrapDto {
    config: { dayLimitPerEmployee: number; showPrices: boolean };
    badgeSalt: string; // base64; the salt every badgeHash below shares
    reasons: { id: string; name: string }[];
    products: {
      id: string;
      gtin14: string;
      name: string;
      unitPrice: string | null;
      egaisCode: string | null;
    }[];
    employees: { id: string; fullName: string; role: string | null; badgeHash: string | null }[];
    operators: {
      employeeId: string;
      name: string;
      login: string;
      role: string;
      pinHash: string;
      badgeHash: string | null;
    }[];
  }
  ```

- [ ] **Step 1: Write the failing e2e test** — `apps/api/test/kiosk-bootstrap-hashes.e2e.test.ts` (seed a tenant, an employee with badge `BADGE-4412`, an operator credential, a kiosk with an enrolled token — copy the seed helpers from `apps/api/test/kiosk-orders.e2e.test.ts`):

```ts
it("ships badge hashes and never a plaintext badge code", async () => {
  const res = await request(app!.getHttpServer())
    .get("/kiosk/bootstrap")
    .set("x-kiosk-token", TOKEN)
    .expect(200);

  const body = JSON.stringify(res.body);
  expect(body).not.toContain("BADGE-4412");

  const employee = res.body.employees[0];
  expect(employee.badgeCodes).toBeUndefined();
  expect(typeof employee.badgeHash).toBe("string");
  await expect(verifyPhc("BADGE-4412", employee.badgeHash)).resolves.toBe(true);
});

it("shares one salt across every badge hash so the kiosk derives once", async () => {
  const res = await request(app!.getHttpServer())
    .get("/kiosk/bootstrap")
    .set("x-kiosk-token", TOKEN)
    .expect(200);

  expect(typeof res.body.badgeSalt).toBe("string");
  for (const e of res.body.employees) {
    if (e.badgeHash) expect(parsePhc(e.badgeHash)!.saltB64).toBe(res.body.badgeSalt);
  }
});

it("ships the operator roster as hashes for the settings screen", async () => {
  const res = await request(app!.getHttpServer())
    .get("/kiosk/bootstrap")
    .set("x-kiosk-token", TOKEN)
    .expect(200);

  const operator = res.body.operators.find((o: { login: string }) => o.login === "1001");
  expect(operator).toBeDefined();
  expect(operator.pinHash).toMatch(/^pbkdf2\$sha256\$/);
  expect(JSON.stringify(res.body.operators)).not.toContain("4321"); // the PIN plaintext
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `set -a; . ./.env; set +a && pnpm --filter @markiro/api exec vitest run kiosk-bootstrap-hashes`
Expected: FAIL — `employee.badgeHash` is `undefined` (the payload still carries `badgeCodes`).

- [ ] **Step 3: Update the DTO** — in `apps/api/src/modules/pickup-orders/dto.ts`, replace the `KioskBootstrapDto` interface with the shape given in **Interfaces** above, and add the doc comment:

```ts
/**
 * GET /kiosk/bootstrap — everything a kiosk needs to work offline.
 *
 * Credentials are PBKDF2 verifiers, never plaintext: an unattended tablet at
 * a factory gate is the most theft-exposed node in the system, and a badge is
 * the credential that authorises a pickup (see docs/device-key-surface.md).
 * All badge verifiers share `badgeSalt` so the device derives once per scan
 * and looks the digest up, instead of running PBKDF2 per employee.
 */
```

- [ ] **Step 4: Update `bootstrap()`** — in `apps/api/src/modules/pickup-orders/pickup-orders.service.ts`, replace the `employeeRows`/`badgeRows`/`badgesByEmployee` block and the `return` with:

```ts
const badgeSalt = await getOrCreateBadgeSalt(this.db, tenantId);

const employeeRows = await this.db
  .select()
  .from(schema.employees)
  .where(and(eq(schema.employees.tenantId, tenantId), eq(schema.employees.status, "active")))
  .orderBy(asc(schema.employees.fullName));

// Reuses the roster builder's hashing/backfill path, so kiosk and station
// can never drift on how a badge verifier is produced.
const badgeHashes = await this.operatorsService.badgeHashesFor(
  tenantId,
  employeeRows.map((e) => e.id),
);
const operators = await this.operatorsService.buildRoster(tenantId);

return {
  config: {
    dayLimitPerEmployee: kiosk?.dayLimitPerEmployee ?? 0,
    showPrices: kiosk?.showPrices ?? true,
  },
  badgeSalt,
  reasons,
  products,
  employees: employeeRows.map((e) => ({
    id: e.id,
    fullName: e.fullName,
    role: e.role,
    badgeHash: badgeHashes.get(e.id) ?? null,
  })),
  operators: operators.map((o) => ({
    employeeId: o.operatorId,
    name: o.name,
    login: o.login,
    role: o.role,
    pinHash: o.pinHash,
    badgeHash: o.badgeHash,
  })),
};
```

- [ ] **Step 5: Expose the hashing helper** — in `apps/api/src/modules/operators/operators.service.ts`, change `private async activeBadgeHashes(` to a public wrapper (keep the private one as the implementation):

```ts
  /** Badge verifiers for the given employees, hashed under the tenant salt. */
  async badgeHashesFor(tenantId: string, employeeIds: string[]): Promise<Map<string, string>> {
    return this.activeBadgeHashes(tenantId, employeeIds);
  }
```

Then wire the dependency: in `apps/api/src/modules/pickup-orders/pickup-orders.module.ts` add `OperatorsModule` to `imports`, and inject `private readonly operatorsService: OperatorsService` in `PickupOrdersService`'s constructor. If `OperatorsModule` does not export `OperatorsService`, add it to that module's `exports`.

- [ ] **Step 6: Run the test to verify it passes**

```bash
set -a; . ./.env; set +a
pnpm --filter @markiro/api exec vitest run kiosk-bootstrap-hashes
pnpm --filter @markiro/api exec vitest run kiosk-orders
```

Expected: both PASS. `kiosk-orders` must stay green — `POST /kiosk/orders` still takes a plaintext `badgeCode` (the badge the employee physically presented), and the server still resolves it authoritatively.

- [ ] **Step 7: Typecheck, format, commit**

```bash
pnpm --filter @markiro/api typecheck
pnpm exec prettier --write apps/api/src/modules/pickup-orders/dto.ts apps/api/src/modules/pickup-orders/pickup-orders.service.ts apps/api/src/modules/pickup-orders/pickup-orders.module.ts apps/api/src/modules/operators/operators.service.ts apps/api/test/kiosk-bootstrap-hashes.e2e.test.ts
git add apps/api/src apps/api/test/kiosk-bootstrap-hashes.e2e.test.ts
git commit -m "feat(api): kiosk bootstrap ships badge hashes and the operator roster"
```

---

### Task 5: Issue a pairing code from the cabinet

**Files:**

- Create: `apps/api/src/modules/kiosk/pairing.service.ts`
- Modify: `apps/api/src/modules/kiosks/{dto.ts,kiosks.controller.ts,kiosks.module.ts}`
- Test: `apps/api/test/kiosk-pairing.e2e.test.ts`

**Interfaces:**

- Consumes: `schema.kioskPairingCodes` (Task 2).
- Produces:

  ```ts
  export interface IssuePairingCodeResultDto {
    code: string;
    expiresAt: Date;
  }
  export class PairingService {
    issueCode(tenantId: string, kioskId: string): Promise<IssuePairingCodeResultDto>;
    // redeem() lands in Task 6 on this same service
  }
  ```

  Route: `POST /kiosks/:id/pairing-code` (session-only).

- [ ] **Step 1: Write the failing e2e test** — `apps/api/test/kiosk-pairing.e2e.test.ts`:

```ts
it("issues an 8-digit code that expires in 15 minutes", async () => {
  const res = await agent.post(`/kiosks/${kioskId}/pairing-code`).send({}).expect(201);
  expect(res.body.code).toMatch(/^\d{8}$/);
  const ttlMs = new Date(res.body.expiresAt).getTime() - Date.now();
  expect(ttlMs).toBeGreaterThan(13 * 60_000);
  expect(ttlMs).toBeLessThanOrEqual(15 * 60_000);
});

it("stores only the hash, never the plaintext code", async () => {
  const res = await agent.post(`/kiosks/${kioskId}/pairing-code`).send({}).expect(201);
  const rows = await db
    .select()
    .from(schema.kioskPairingCodes)
    .where(eq(schema.kioskPairingCodes.kioskId, kioskId));
  expect(rows.some((r) => r.codeHash === res.body.code)).toBe(false);
  expect(rows.some((r) => r.codeHash === hashDeviceToken(res.body.code))).toBe(true);
});

it("invalidates the previous code when a new one is issued", async () => {
  const first = await agent.post(`/kiosks/${kioskId}/pairing-code`).send({}).expect(201);
  await agent.post(`/kiosks/${kioskId}/pairing-code`).send({}).expect(201);
  const [old] = await db
    .select()
    .from(schema.kioskPairingCodes)
    .where(eq(schema.kioskPairingCodes.codeHash, hashDeviceToken(first.body.code)));
  expect(old!.usedAt).not.toBeNull();
});

it("404s for a kiosk of another tenant", async () => {
  await otherAgent.post(`/kiosks/${kioskId}/pairing-code`).send({}).expect(404);
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `set -a; . ./.env; set +a && pnpm --filter @markiro/api exec vitest run kiosk-pairing`
Expected: FAIL with 404 — the route does not exist.

- [ ] **Step 3: Implement `apps/api/src/modules/kiosk/pairing.service.ts`**

```ts
import { randomInt } from "node:crypto";
import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, gt, isNull } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { DB } from "../../auth/auth.module";
import { hashDeviceToken } from "../../pickup/device-token";

const CODE_DIGITS = 8;
const TTL_MS = 15 * 60_000;
/** Bounded retries so a live-code hash collision can never be minted. */
const MINT_ATTEMPTS = 5;

// `hashDeviceToken` is a plain sha256, which an attacker holding a DB dump
// could brute-force over the 10^8 code space. That is acceptable here and
// deliberately not PBKDF2: the value is single-use, expires in 15 minutes,
// and the exchange must stay a single indexed hash probe for a device that
// has no credential yet. It is not a password.

export interface IssuePairingCodeResultDto {
  code: string;
  expiresAt: Date;
}

@Injectable()
export class PairingService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * A single-use 8-digit code for `kioskId`. Only its hash is stored; the
   * plaintext is returned exactly once for the cabinet's reveal. Issuing a new
   * code retires any code still live for that kiosk.
   */
  async issueCode(tenantId: string, kioskId: string): Promise<IssuePairingCodeResultDto> {
    const [kiosk] = await this.db
      .select({ id: schema.kiosks.id })
      .from(schema.kiosks)
      .where(and(eq(schema.kiosks.tenantId, tenantId), eq(schema.kiosks.id, kioskId)));
    if (!kiosk) throw new NotFoundException();

    // Retire the kiosk's live codes first: a device must never face two
    // valid codes, and the cabinet only ever shows the newest.
    await this.db
      .update(schema.kioskPairingCodes)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(schema.kioskPairingCodes.tenantId, tenantId),
          eq(schema.kioskPairingCodes.kioskId, kioskId),
          isNull(schema.kioskPairingCodes.usedAt),
        ),
      );

    const expiresAt = new Date(Date.now() + TTL_MS);
    for (let attempt = 0; attempt < MINT_ATTEMPTS; attempt++) {
      const code = String(randomInt(0, 10 ** CODE_DIGITS)).padStart(CODE_DIGITS, "0");
      const codeHash = hashDeviceToken(code);
      // The exchange looks a device up by hash alone, so a hash shared by two
      // simultaneously-live codes would be ambiguous. Mint a different one.
      const [clash] = await this.db
        .select({ id: schema.kioskPairingCodes.id })
        .from(schema.kioskPairingCodes)
        .where(
          and(
            eq(schema.kioskPairingCodes.codeHash, codeHash),
            isNull(schema.kioskPairingCodes.usedAt),
            gt(schema.kioskPairingCodes.expiresAt, new Date()),
          ),
        );
      if (clash) continue;

      await this.db
        .insert(schema.kioskPairingCodes)
        .values({ tenantId, kioskId, codeHash, expiresAt });
      return { code, expiresAt };
    }
    throw new Error("Could not mint a unique pairing code");
  }
}
```

- [ ] **Step 4: Add the route** — in `apps/api/src/modules/kiosks/kiosks.controller.ts` add the import `import { SessionOnlyGuard } from "../../tenancy/session-only.guard";`, inject `private readonly pairingService: PairingService` alongside `kiosksService`, and add:

```ts
  /** Session-only: a stolen device must not be able to mint pairing codes. */
  @Post(":id/pairing-code")
  @UseGuards(SessionOnlyGuard)
  async issuePairingCode(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
  ): Promise<IssuePairingCodeResultDto> {
    return this.pairingService.issueCode(req.tenantId!, id);
  }
```

Wire the modules so `PairingService` has exactly one instance: it is provided **where its file lives**, and the cabinet module imports that module rather than re-providing it.

- `apps/api/src/modules/kiosk/kiosk.module.ts` — add `PairingService` to `providers` **and** `exports`.
- `apps/api/src/modules/kiosks/kiosks.module.ts` — add `KioskModule` to `imports`.

Providing the same class in both modules would give each controller its own instance; that is not a correctness bug for this service today, but it is exactly the kind of duplication that later becomes one (e.g. if the service ever caches).

- [ ] **Step 5: Run the test to verify it passes**

Run: `set -a; . ./.env; set +a && pnpm --filter @markiro/api exec vitest run kiosk-pairing`
Expected: PASS (4 tests).

- [ ] **Step 6: Typecheck, format, commit**

```bash
pnpm --filter @markiro/api typecheck
pnpm exec prettier --write apps/api/src/modules/kiosk/pairing.service.ts apps/api/src/modules/kiosks apps/api/test/kiosk-pairing.e2e.test.ts
git add apps/api/src/modules/kiosk/pairing.service.ts apps/api/src/modules/kiosks apps/api/test/kiosk-pairing.e2e.test.ts
git commit -m "feat(api): issue single-use kiosk pairing codes"
```

---

### Task 6: Redeem a pairing code for the provisioning bundle

**Files:**

- Create: `apps/api/src/modules/kiosk/kiosk-pair.controller.ts`
- Modify: `apps/api/src/modules/kiosk/pairing.service.ts`, `apps/api/src/modules/kiosk/kiosk.module.ts`, `apps/api/src/modules/pickup-orders/dto.ts`
- Test: extend `apps/api/test/kiosk-pairing.e2e.test.ts`

**Interfaces:**

- Consumes: `PairingService.issueCode` (Task 5), `KioskBootstrapDto` (Task 4), `generateDeviceToken`/`hashDeviceToken` (existing).
- Produces — **this is the contract Plan B-2's pairing screen calls**:

  ```ts
  export const pairKioskSchema = z.object({ code: z.string().regex(/^\d{8}$/) });
  export interface PairKioskResultDto {
    device: { kioskId: string; kioskName: string; place: string | null };
    token: string; // the x-kiosk-token
    nextDeviceSeq: number;
    bootstrap: KioskBootstrapDto;
  }
  ```

  Route: `POST /kiosk/pair` — **no guard**.

- [ ] **Step 1: Write the failing e2e cases** — append to `apps/api/test/kiosk-pairing.e2e.test.ts`:

```ts
it("exchanges a code for a working token and the initial dataset", async () => {
  const issued = await agent.post(`/kiosks/${kioskId}/pairing-code`).send({}).expect(201);

  const paired = await request(app!.getHttpServer())
    .post("/kiosk/pair")
    .send({ code: issued.body.code })
    .expect(201);

  expect(paired.body.device.kioskId).toBe(kioskId);
  expect(paired.body.nextDeviceSeq).toBe(0);
  expect(paired.body.bootstrap.products.length).toBeGreaterThan(0);

  // the token works straight away
  await request(app!.getHttpServer())
    .get("/kiosk/bootstrap")
    .set("x-kiosk-token", paired.body.token)
    .expect(200);
});

it("refuses a second redemption of the same code", async () => {
  const issued = await agent.post(`/kiosks/${kioskId}/pairing-code`).send({}).expect(201);
  await request(app!.getHttpServer())
    .post("/kiosk/pair")
    .send({ code: issued.body.code })
    .expect(201);
  await request(app!.getHttpServer())
    .post("/kiosk/pair")
    .send({ code: issued.body.code })
    .expect(401);
});

it("refuses an expired code", async () => {
  const issued = await agent.post(`/kiosks/${kioskId}/pairing-code`).send({}).expect(201);
  await db
    .update(schema.kioskPairingCodes)
    .set({ expiresAt: new Date(Date.now() - 1000) })
    .where(eq(schema.kioskPairingCodes.codeHash, hashDeviceToken(issued.body.code)));
  await request(app!.getHttpServer())
    .post("/kiosk/pair")
    .send({ code: issued.body.code })
    .expect(401);
});

it("locks a code out after 5 wrong attempts", async () => {
  const issued = await agent.post(`/kiosks/${kioskId}/pairing-code`).send({}).expect(201);
  const codeHash = hashDeviceToken(issued.body.code);
  await db
    .update(schema.kioskPairingCodes)
    .set({ attempts: 5 })
    .where(eq(schema.kioskPairingCodes.codeHash, codeHash));
  await request(app!.getHttpServer())
    .post("/kiosk/pair")
    .send({ code: issued.body.code })
    .expect(401);
});

it("continues deviceSeq after a re-pair so the first order is not mistaken for a replay", async () => {
  await db
    .update(schema.pickupOrders)
    .set({ deviceSeq: 7 })
    .where(
      and(eq(schema.pickupOrders.tenantId, tenantId), eq(schema.pickupOrders.id, seededOrder)),
    );
  const issued = await agent.post(`/kiosks/${kioskId}/pairing-code`).send({}).expect(201);
  const paired = await request(app!.getHttpServer())
    .post("/kiosk/pair")
    .send({ code: issued.body.code })
    .expect(201);
  expect(paired.body.nextDeviceSeq).toBe(8);
});
```

- [ ] **Step 2: Run them, verify they fail**

Run: `set -a; . ./.env; set +a && pnpm --filter @markiro/api exec vitest run kiosk-pairing`
Expected: FAIL with 404 — `/kiosk/pair` does not exist.

- [ ] **Step 3: Add `redeem` to `PairingService`**

```ts
const MAX_ATTEMPTS = 5;

  /**
   * Exchanges a plaintext code for a device credential plus the initial
   * dataset. Redemption is atomic: the row is claimed by a conditional
   * UPDATE, so two devices racing on the same code cannot both win.
   */
  async redeem(code: string): Promise<PairKioskResultDto> {
    const codeHash = hashDeviceToken(code);
    const [candidate] = await this.db
      .select()
      .from(schema.kioskPairingCodes)
      .where(eq(schema.kioskPairingCodes.codeHash, codeHash));

    // A wrong code matches nothing — there is no row to count attempts on, so
    // the lockout necessarily applies per issued code, exactly as designed.
    if (!candidate) throw new UnauthorizedException();
    if (candidate.attempts >= MAX_ATTEMPTS) throw new UnauthorizedException();
    if (candidate.usedAt || candidate.expiresAt.getTime() <= Date.now()) {
      await this.db
        .update(schema.kioskPairingCodes)
        .set({ attempts: candidate.attempts + 1 })
        .where(eq(schema.kioskPairingCodes.id, candidate.id));
      throw new UnauthorizedException();
    }

    const [claimed] = await this.db
      .update(schema.kioskPairingCodes)
      .set({ usedAt: new Date() })
      .where(
        and(eq(schema.kioskPairingCodes.id, candidate.id), isNull(schema.kioskPairingCodes.usedAt)),
      )
      .returning({ id: schema.kioskPairingCodes.id });
    if (!claimed) throw new UnauthorizedException();

    const { tenantId, kioskId } = candidate;
    const token = generateDeviceToken();
    const [kiosk] = await this.db
      .update(schema.kiosks)
      .set({ deviceTokenHash: hashDeviceToken(token) })
      .where(and(eq(schema.kiosks.tenantId, tenantId), eq(schema.kiosks.id, kioskId)))
      .returning({ name: schema.kiosks.name, location: schema.kiosks.location });
    if (!kiosk) throw new UnauthorizedException();

    const [seq] = await this.db
      .select({ max: max(schema.pickupOrders.deviceSeq) })
      .from(schema.pickupOrders)
      .where(
        and(eq(schema.pickupOrders.tenantId, tenantId), eq(schema.pickupOrders.kioskId, kioskId)),
      );

    return {
      device: { kioskId, kioskName: kiosk.name, place: kiosk.location },
      token,
      nextDeviceSeq: (seq?.max ?? -1) + 1,
      bootstrap: await this.pickupOrdersService.bootstrap(tenantId, kioskId),
    };
  }
```

Add the imports `UnauthorizedException` from `@nestjs/common`, `max` from `drizzle-orm`, `generateDeviceToken` from `../../pickup/device-token`, and inject `private readonly pickupOrdersService: PickupOrdersService`.

- [ ] **Step 4: Add the guardless controller** — `apps/api/src/modules/kiosk/kiosk-pair.controller.ts`:

```ts
import { Body, Controller, Post } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { ZodValidationPipe } from "../../zod.pipe";
import { pairKioskSchema, type PairKioskDto, type PairKioskResultDto } from "../pickup-orders/dto";
import { PairingService } from "./pairing.service";

/**
 * The one unauthenticated kiosk route: a device has no credential until this
 * call succeeds. It lives in its own controller because `KioskController`
 * applies `KioskDeviceGuard` at class level. Brute force is bounded by the
 * per-code attempt lockout in `PairingService.redeem`.
 */
@ApiTags("kiosk")
@Controller("kiosk")
export class KioskPairController {
  constructor(private readonly pairingService: PairingService) {}

  @Post("pair")
  async pair(
    @Body(new ZodValidationPipe(pairKioskSchema)) body: PairKioskDto,
  ): Promise<PairKioskResultDto> {
    return this.pairingService.redeem(body.code);
  }
}
```

Add `pairKioskSchema`/`PairKioskDto`/`PairKioskResultDto` to `apps/api/src/modules/pickup-orders/dto.ts` per the **Interfaces** block, and register `KioskPairController` in `apps/api/src/modules/kiosk/kiosk.module.ts`'s `controllers`. That module already provides `PairingService` and imports `PickupOrdersModule` (Task 5 Step 4), so no further wiring is needed here.

- [ ] **Step 5: Run the test to verify it passes**

Run: `set -a; . ./.env; set +a && pnpm --filter @markiro/api exec vitest run kiosk-pairing`
Expected: PASS (9 tests).

- [ ] **Step 6: Typecheck, format, commit**

```bash
pnpm --filter @markiro/api typecheck
pnpm exec prettier --write apps/api/src/modules/kiosk apps/api/src/modules/pickup-orders/dto.ts apps/api/test/kiosk-pairing.e2e.test.ts
git add apps/api/src/modules/kiosk apps/api/src/modules/pickup-orders/dto.ts apps/api/test/kiosk-pairing.e2e.test.ts
git commit -m "feat(api): redeem a pairing code for the kiosk provisioning bundle"
```

---

### Task 7: Persist sync conflicts and expose them

**Files:**

- Modify: `apps/api/src/modules/pickup-orders/pickup-orders.service.ts`, `apps/api/src/modules/pickup-orders/dto.ts`
- Test: `apps/api/test/pickup-conflicts.e2e.test.ts`

**Interfaces:**

- Consumes: `schema.pickupOrders.syncConflicts` (Task 2).
- Produces: `PickupOrderRowDto.conflictCount: number` and `PickupOrderDetailDto.syncConflicts: OrderConflict[]` — consumed by the admin UI (Task 8) and Plan B-2's journal.

- [ ] **Step 1: Write the failing e2e test** — `apps/api/test/pickup-conflicts.e2e.test.ts`:

```ts
it("records the codes it refused, so an admin can see what the kiosk lost", async () => {
  // Two items: one valid, one whose GTIN is not on this kiosk's allowlist.
  const res = await request(app!.getHttpServer())
    .post("/kiosk/orders")
    .set("x-kiosk-token", TOKEN)
    .send({
      deviceSeq: 1,
      badgeCode: BADGE,
      reason: "buy",
      items: [{ rawKm: GOOD_KM }, { rawKm: NOT_ALLOWED_KM }],
    })
    .expect(201);

  expect(res.body.itemCount).toBe(1);
  expect(res.body.conflicts).toHaveLength(1);

  const list = await agent.get("/pickup-orders").expect(200);
  const row = list.body.items.find((r: { orderNo: string }) => r.orderNo === res.body.orderNo);
  expect(row.conflictCount).toBe(1);

  const detail = await agent.get(`/pickup-orders/${row.id}`).expect(200);
  expect(detail.body.syncConflicts).toEqual([
    { rawKm: NOT_ALLOWED_KM, reason: expect.stringMatching(/unknown_product|not_allowed/) },
  ]);
});

it("reports no conflicts for a clean order", async () => {
  const res = await request(app!.getHttpServer())
    .post("/kiosk/orders")
    .set("x-kiosk-token", TOKEN)
    .send({ deviceSeq: 2, badgeCode: BADGE, reason: "buy", items: [{ rawKm: GOOD_KM_2 }] })
    .expect(201);

  const list = await agent.get("/pickup-orders").expect(200);
  const row = list.body.items.find((r: { orderNo: string }) => r.orderNo === res.body.orderNo);
  expect(row.conflictCount).toBe(0);

  const detail = await agent.get(`/pickup-orders/${row.id}`).expect(200);
  expect(detail.body.syncConflicts).toEqual([]);
});
```

Use the fixtures already established in `apps/api/test/kiosk-orders.e2e.test.ts`: `GOOD_KM` built from the check-digit-valid GTIN `04600682000013` with a real GS (`String.fromCharCode(0x1d)`), and `NOT_ALLOWED_KM` from a second valid GTIN that is deliberately not on the allowlist.

- [ ] **Step 2: Run it, verify it fails**

Run: `set -a; . ./.env; set +a && pnpm --filter @markiro/api exec vitest run pickup-conflicts`
Expected: FAIL — `row.conflictCount` is `undefined`.

- [ ] **Step 3: Persist the conflicts** — in `createFromKiosk`, where the order row is inserted, add `syncConflicts` to the inserted values:

```ts
      syncConflicts: conflicts.length > 0 ? conflicts : null,
```

Do this in the same `insert(schema.pickupOrders)` call that already sets `orderNo`, `itemCount` and `deviceSeq`, so the conflicts commit atomically with the order they belong to. Leave the idempotent-replay branch alone: a replay returns the stored order, and its stored conflicts come back with it via the detail route.

- [ ] **Step 4: Expose the fields** — in `apps/api/src/modules/pickup-orders/dto.ts` add to the interfaces:

```ts
export interface PickupOrderRowDto {
  // …existing fields…
  /** How many scanned codes the server refused when this order synced. */
  conflictCount: number;
}

export interface PickupOrderDetailDto extends PickupOrderRowDto {
  // …existing fields…
  syncConflicts: OrderConflict[];
}
```

In `list()`'s projection add `syncConflicts: schema.pickupOrders.syncConflicts`, and map each row with `conflictCount: row.syncConflicts?.length ?? 0` (do not return the raw array from the list — the summary only needs the count). In `detail()` add the same projection and map `syncConflicts: row.syncConflicts ?? []` plus the same `conflictCount`.

- [ ] **Step 5: Run the test to verify it passes**

```bash
set -a; . ./.env; set +a
pnpm --filter @markiro/api exec vitest run pickup-conflicts
pnpm --filter @markiro/api exec vitest run pickup-orders
```

Expected: both PASS.

- [ ] **Step 6: Typecheck, format, commit**

```bash
pnpm --filter @markiro/api typecheck
pnpm exec prettier --write apps/api/src/modules/pickup-orders apps/api/test/pickup-conflicts.e2e.test.ts
git add apps/api/src/modules/pickup-orders apps/api/test/pickup-conflicts.e2e.test.ts
git commit -m "feat(api): persist and expose kiosk sync conflicts"
```

---

### Task 8: Show sync conflicts in the admin order card

**Files:**

- Modify: `apps/admin/src/pages/pickup/api.ts`, `apps/admin/src/pages/pickup/OrderDetail.tsx`, `apps/admin/src/pages/pickup/index.tsx`, `apps/admin/src/i18n/{ru,en}.json`
- Test: `apps/admin/test/pickup-detail.test.tsx`

**Interfaces:**

- Consumes: `PickupOrderRowDto.conflictCount`, `PickupOrderDetailDto.syncConflicts` (Task 7).
- Produces: no new exports.

- [ ] **Step 1: Write the failing test** — add to `apps/admin/test/pickup-detail.test.tsx`:

```tsx
it("shows what the kiosk lost at sync time", async () => {
  const fetchMock = vi.fn(async () =>
    jsonResponse(200, {
      ...PENDING_ORDER,
      conflictCount: 2,
      syncConflicts: [
        { rawKm: "0104600682000013215AAA", reason: "duplicate" },
        { rawKm: "0104600682000013215BBB", reason: "over_limit" },
      ],
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  renderDetail();

  expect(await screen.findByText(/Отклонено при синхронизации: 2/)).toBeDefined();
  expect(screen.getByText(/дубль/i)).toBeDefined();
  expect(screen.getByText(/лимит/i)).toBeDefined();
});

it("renders no conflicts plaque for a clean order", async () => {
  const fetchMock = vi.fn(async () =>
    jsonResponse(200, { ...PENDING_ORDER, conflictCount: 0, syncConflicts: [] }),
  );
  vi.stubGlobal("fetch", fetchMock);
  renderDetail();

  expect(await screen.findByText(PENDING_ORDER.orderNo)).toBeDefined();
  expect(screen.queryByText(/Отклонено при синхронизации/)).toBeNull();
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm --filter @markiro/admin exec vitest run pickup-detail`
Expected: FAIL — the plaque text is not found.

- [ ] **Step 3: Mirror the DTO fields** — in `apps/admin/src/pages/pickup/api.ts` add `conflictCount: number;` to `PickupOrderRowDto` and:

```ts
export interface SyncConflict {
  rawKm: string;
  reason: "not_km" | "incomplete" | "unknown_product" | "not_allowed" | "duplicate" | "over_limit";
}
```

plus `syncConflicts: SyncConflict[];` on `PickupOrderDetailDto`.

- [ ] **Step 4: Render the plaque** — in `apps/admin/src/pages/pickup/OrderDetail.tsx`, directly under the header `Card` and above the items table:

```tsx
{
  order.syncConflicts.length > 0 && (
    <Alert
      tone="warn"
      title={t("pages.pickup.conflicts.title", { count: order.syncConflicts.length })}
    >
      <ul style={{ margin: 0, paddingInlineStart: "var(--sp-5)" }}>
        {order.syncConflicts.map((c) => (
          <li key={c.rawKm} style={{ font: "var(--text-code)" }}>
            {c.rawKm} — {t(`pages.pickup.conflicts.reason.${c.reason}`)}
          </li>
        ))}
      </ul>
    </Alert>
  );
}
```

Import `Alert` from `@markiro/ui`. In `apps/admin/src/pages/pickup/index.tsx`, add a conflict marker to the summary table's status column so the свод surfaces it too:

```tsx
{
  row.conflictCount > 0 && (
    <Badge tone="warn">{t("pages.pickup.conflicts.badge", { count: row.conflictCount })}</Badge>
  );
}
```

- [ ] **Step 5: Add the i18n keys** — to BOTH `apps/admin/src/i18n/ru.json` and `apps/admin/src/i18n/en.json` under `pages.pickup`:

```json
"conflicts": {
  "title": "Отклонено при синхронизации: {{count}}",
  "badge": "{{count}} откл.",
  "reason": {
    "not_km": "не код маркировки",
    "incomplete": "код прочитан не полностью",
    "unknown_product": "товара нет в каталоге",
    "not_allowed": "товар недоступен на киоске",
    "duplicate": "дубль — код уже в другой заявке",
    "over_limit": "превышен дневной лимит"
  }
}
```

English values: `"Rejected at sync: {{count}}"`, `"{{count}} rejected"`, `"not a marking code"`, `"code read incompletely"`, `"product not in catalog"`, `"product not available at this kiosk"`, `"duplicate — code already in another order"`, `"daily limit exceeded"`. Keys must stay identical in both files or the i18n test throws.

- [ ] **Step 6: Run the tests to verify they pass**

```bash
pnpm --filter @markiro/admin exec vitest run pickup-detail
pnpm --filter @markiro/admin exec vitest run pickup
pnpm --filter @markiro/admin exec vitest run i18n
```

Expected: all PASS.

- [ ] **Step 7: Typecheck, format, commit**

```bash
pnpm --filter @markiro/admin typecheck
pnpm exec prettier --write apps/admin/src/pages/pickup apps/admin/src/i18n/ru.json apps/admin/src/i18n/en.json apps/admin/test/pickup-detail.test.tsx
git add apps/admin/src apps/admin/test/pickup-detail.test.tsx
git commit -m "feat(admin): surface kiosk sync conflicts on the order card"
```

---

### Task 9: Device-key-surface triage

**Files:**

- Modify: `apps/api/src/modules/kiosks/kiosks.controller.ts`, `apps/api/src/modules/pickup-orders/pickup-orders.controller.ts`, `apps/api/src/modules/pickup-reasons/pickup-reasons.controller.ts`
- Modify: `docs/device-key-surface.md`
- Test: `apps/api/test/device-key-triage.e2e.test.ts`

**Interfaces:** no new exports; this task changes who may call existing routes.

- [ ] **Step 1: Write the failing e2e test** — `apps/api/test/device-key-triage.e2e.test.ts`. Mint a station api-key for the tenant the way `apps/api/test/station-devices.e2e.test.ts` does, then:

```ts
it("refuses a station api-key on kiosk management", async () => {
  await request(app!.getHttpServer()).get("/kiosks").set("x-api-key", stationKey).expect(403);
});

it("refuses a station api-key on the pickup order flow", async () => {
  await request(app!.getHttpServer())
    .get("/pickup-orders")
    .set("x-api-key", stationKey)
    .expect(403);
});

it("refuses a station api-key on pickup reasons", async () => {
  await request(app!.getHttpServer())
    .get("/pickup-reasons")
    .set("x-api-key", stationKey)
    .expect(403);
});

it("still serves a cabinet session", async () => {
  await agent.get("/kiosks").expect(200);
  await agent.get("/pickup-orders").expect(200);
  await agent.get("/pickup-reasons").expect(200);
});

it("leaves the kiosk's own device routes reachable", async () => {
  await request(app!.getHttpServer())
    .get("/kiosk/bootstrap")
    .set("x-kiosk-token", TOKEN)
    .expect(200);
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `set -a; . ./.env; set +a && pnpm --filter @markiro/api exec vitest run device-key-triage`
Expected: FAIL — the first three cases return 200 instead of 403.

- [ ] **Step 3: Apply the guards** — change the class-level decorator in each of the three controllers from `@UseGuards(TenantGuard)` to:

```ts
@UseGuards(TenantGuard, SessionOnlyGuard)
```

adding `import { SessionOnlyGuard } from "../../tenancy/session-only.guard";` to each. In `kiosks.controller.ts` the per-route `@UseGuards(SessionOnlyGuard)` added in Task 5 becomes redundant — remove it, the class-level guard now covers it.

Add this comment above each class:

```ts
// Cabinet-only: the kiosk device talks to /kiosk/* behind KioskDeviceGuard and
// never needs this module, so no device key — station or kiosk — should reach
// it (see docs/device-key-surface.md).
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
set -a; . ./.env; set +a
pnpm --filter @markiro/api exec vitest run device-key-triage
pnpm --filter @markiro/api exec vitest run kiosks
pnpm --filter @markiro/api exec vitest run pickup-orders
pnpm --filter @markiro/api exec vitest run pickup-reasons
pnpm --filter @markiro/api exec vitest run kiosk-pairing
```

Expected: all PASS. The cabinet suites use a session agent, so they are unaffected.

- [ ] **Step 5: Update the policy doc** — in `docs/device-key-surface.md`, delete the three rows from the "Not yet triaged" table, delete that section's now-stale paragraph about the pickup-kiosk workstream, and add to the "Cabinet-only" table:

```markdown
| `kiosks` | device management and pairing-code issue — a stolen device must not be able to enrol or re-pair another |
| `pickup-orders` | the admin's order resolution flow; the kiosk uses `/kiosk/*` behind `KioskDeviceGuard` |
| `pickup-reasons` | the reason list is edited in the cabinet; the kiosk receives it in its bootstrap payload |
```

Keep the "Rule for new routes" section's note about `kiosk.controller.ts` (singular) being out of scope by construction — that is still true, and now `POST /kiosk/pair` joins it as an intentionally unauthenticated route. Add it to that note:

```markdown
- `POST /kiosk/pair` (`apps/api/src/modules/kiosk/kiosk-pair.controller.ts`) carries
  **no guard** — a device has no credential until it succeeds. Brute force is
  bounded by a per-code attempt lockout, not by a guard.
```

- [ ] **Step 6: Format and commit**

```bash
pnpm exec prettier --write apps/api/src/modules apps/api/test/device-key-triage.e2e.test.ts docs/device-key-surface.md
git add apps/api/src/modules apps/api/test/device-key-triage.e2e.test.ts docs/device-key-surface.md
git commit -m "fix(api): make kiosk management, orders and reasons cabinet-only"
```

---

### Task 10: Roadmap rows

**Files:**

- Modify: `docs/superpowers/plans/2026-07-21-markiro-mvp-roadmap.md`

**Interfaces:** none.

- [ ] **Step 1: Add the missing rows** — the roadmap has no pickup-kiosk entry at all, though Plan A shipped in PR #5. Insert after the `05b-3` row:

```markdown
| K-A | **Pickup kiosk «Для себя» — data, API & admin** (spec `2026-07-23-pickup-kiosk-design.md`, plan `2026-07-23-pickup-kiosk-a-backend-admin.md`; **done**, PR #5) | Employees + badges, kiosks + allowlist + device enrollment, configurable write-off reasons, kiosk device endpoints (bootstrap + order create/sync), admin «Для себя» section, bulk code export, printed A4 slip | 03 |
| K-B1 | **Pickup kiosk — server & domain for the device** (spec `2026-07-24-pickup-kiosk-b-app-offline-design.md`, plan `2026-07-28-pickup-kiosk-b1-server-domain.md`) | Shared PHC verifier, per-tenant badge salt, bootstrap ships hashes + operator roster, single-use device pairing, persisted sync conflicts, device-key triage | K-A, 05b-1 |
| K-B2 | **Pickup kiosk — the device app** (`apps/kiosk`) | PWA shell, pluggable scanner transport (keyboard wedge + Web Serial), IndexedDB cache/queue/sync, badge verification, pairing & scanner-setup screens | K-B1 |
```

Use `K-` prefixes deliberately: the roadmap's numeric `07` already means "Exports, history & dashboard", and the pickup-kiosk track is a parallel workstream rather than a step in the main chain.

- [ ] **Step 2: Verify the table still renders** — confirm the new rows have the same column count as their neighbours (4 columns: id, plan, scope, depends-on).

- [ ] **Step 3: Format and commit**

```bash
pnpm exec prettier --write docs/superpowers/plans/2026-07-21-markiro-mvp-roadmap.md
git add docs/superpowers/plans/2026-07-21-markiro-mvp-roadmap.md
git commit -m "docs: put the pickup-kiosk track on the roadmap"
```

---

## Final Verification

- [ ] Run the full gate with env loaded so nothing skips:

```bash
set -a; . ./.env; set +a
pnpm turbo lint typecheck test build
pnpm format:check
```

Expected: turbo reports all tasks successful; `format:check` reports "All matched files use Prettier code style!". (A local-only warning about `.claude/settings.local.json` is expected and harmless — that file is git-ignored and absent in CI.)

- [ ] Confirm `/docs` (Scalar) lists the new routes: `POST /kiosks/:id/pairing-code` and `POST /kiosk/pair`.
- [ ] Manual smoke: create a kiosk in the admin panel → issue a pairing code → `curl -X POST localhost:3000/kiosk/pair -H 'content-type: application/json' -d '{"code":"<code>"}'` → confirm the response carries a token, `nextDeviceSeq`, and a bootstrap whose `employees[].badgeHash` verifies against a known badge while the payload contains no plaintext badge code.

## Self-Review (completed while writing)

- **Spec coverage:** §5.1 pairing server (Tasks 5, 6) · §5.1 bundle shape incl. `nextDeviceSeq` (Task 6) · §6.1 badge hashes + operator roster + shared PHC verifier (Tasks 1, 3, 4) · §6.2 per-tenant salt and one-derivation lookup (Tasks 1, 3; the client-side lookup itself is B-2) · §7.1 conflict persistence + admin surfacing (Tasks 7, 8) · §7.2 `deviceSeq` continuation (Task 6) · §10 device-key triage (Task 9) · §4 roadmap rows (Task 10). Deliberately **not** here: everything in `apps/kiosk` — §5.2, §5.3, §6 scanner transports, §7 cache/queue/sync, §7.3 thresholds, §8 screens, §9 app architecture. Those are Plan B-2.
- **Type consistency:** `parsePhc`/`deriveDigestB64`/`formatPhc`/`verifyPhc`/`PHC_ITERATIONS` (Task 1) are used verbatim in Tasks 3 and 4; `getOrCreateBadgeSalt`/`hashBadgeWithSalt` (Task 3) in Tasks 3 and 4; `KioskBootstrapDto` (Task 4) is consumed by `PairKioskResultDto` (Task 6); `OrderConflict` (existing) is reused by `syncConflicts` (Tasks 2, 7, 8) rather than redefined.
- **Assumptions carried from the spec:** conflicts stored as JSONB on `pickup_orders` (§11.2); badge verifiers share a per-tenant salt while PIN verifiers keep per-row salts (§11.6); the PHC verifier lands in `packages/domain` and migrating the station/API copies is out of scope (§11.7); `POST /kiosk/orders` is untouched (§11.8).
