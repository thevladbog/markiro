# Chestny ZNAK Signer Agent — Cloud Side Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the cloud half of the CHZ signer agent per
`docs/superpowers/specs/2026-08-28-chz-signer-agent-design.md`: DB tables, protocol
contracts, pairing + task-queue endpoints, encrypted token storage, the pg-boss refresh
cron, and the admin Integrations panel. The Windows agent itself (`apps/signer`,
`signer-core`) is a separate follow-up plan.

**Architecture:** A new `signer-agents` NestJS module clones the proven kiosk/station
device-pairing pattern (tenant-scoped 8-digit code → 192-bit agent secret, sha256 hash
stored on the agent row). Agents long-poll `GET /signer-agent/tasks/next`; a claim is a
single atomic `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)`. Completing a
`true_api_auth` task stores the True API token AES-256-GCM-encrypted in `chz_api_tokens`.
A pg-boss cron enqueues refresh tasks when the token is within 90 minutes of expiry and
expires stale tasks. Everything is audited through the existing `JournalService`
(`channelType: "chestny_znak"`, already registered as a placeholder in the channel
registry).

**Tech Stack:** NestJS 11, Drizzle ORM (Postgres), pg-boss 12, zod 4, TanStack Query +
react-i18next (admin), vitest + supertest.

## Global Constraints

- Monorepo: pnpm + turbo. API tests: `pnpm --filter @markiro/api exec vitest run test/<file>`. DB: `pnpm --filter @markiro/db ...`.
- Migration flow (AGENTS.md): `set -a; source .env; set +a` → `db:generate` → `build` → `test` → `db:migrate`. Never edit an applied migration. Next migration number was **0086** at plan-writing time (last applied: `0085_yielding_warbound`); `main` landed its own `0086`/`0087` in the meantime, so this plan actually shipped as `0088_chz_signer_agent` (+ `0089_chz_api_tokens_agent_fk`, added in review follow-up for the `chz_api_tokens.agent_id` FK).
- New schema files must be added to BOTH `packages/db/src/schema.ts` (barrel) and `packages/db/drizzle.config.ts` (explicit whitelist).
- Every new HTTP endpoint must carry OpenAPI decorators (`@ApiTags`, `ApiZodBody`/`ApiZodResponse`/explicit response schema, auth decorator) — `apps/api/test/openapi-coverage.test.ts` is a hard gate. Helpers live in `apps/api/src/lib/openapi.ts`.
- API e2e tests need the dev Postgres from `docker-compose.dev.yml` and env (`DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`); gate with `describe.skipIf(!ready)` like `apps/api/test/api-keys.e2e.test.ts:15-17`. `fileParallelism: false` is intentional — don't change it.
- Token values must NEVER appear in `integration_events`, logs, or task `result_summary`.
- Endpoints returning plaintext secrets (pairing code): `@Header("Cache-Control", "no-store")`; in admin, call them via bare async functions, NOT `useMutation` (rationale: `apps/admin/src/pages/integrations/api.ts:177-189`).
- i18n: every new admin string goes to both `apps/admin/src/i18n/ru.json` and `en.json`.
- Commit после каждой задачи; сообщения в стиле репо (`feat(integrations): …`), футер `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: DB schema `chz.ts` + migration 0086

**Files:**

- Create: `packages/db/src/schema/chz.ts`
- Modify: `packages/db/src/schema.ts` (add `export * from "./schema/chz.js";`)
- Modify: `packages/db/drizzle.config.ts` (add `"./src/schema/chz.ts"` to the schema list)
- Create (generated): `packages/db/migrations/0086_chz_signer_agent.sql`

**Interfaces:**

- Produces: tables `chzSignerAgents`, `chzSignerPairingCodes`, `chzSignerTasks`, `chzApiTokens`; constants `CHZ_SIGNER_AGENT_STATUSES`, `CHZ_SIGNER_TASK_TYPES`, `CHZ_SIGNER_TASK_STATUSES`; row types `ChzSignerAgentRow`, `ChzSignerTaskRow`, `ChzApiTokenRow`. All later API tasks import these via `schema.*`.

- [ ] **Step 1: Write the schema file**

`packages/db/src/schema/chz.ts` (the `tenantId` helper, `organization` import and `bytea` custom type are copied verbatim from `packages/db/src/schema/integrations.ts:16-27`):

```ts
import { sql } from "drizzle-orm";
import {
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organization } from "./auth.js";

const tenantId = () =>
  text("tenant_id")
    .notNull()
    .references(() => organization.id);

const bytea = customType<{ data: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const CHZ_SIGNER_AGENT_STATUSES = ["active", "revoked"] as const;
export type ChzSignerAgentStatus = (typeof CHZ_SIGNER_AGENT_STATUSES)[number];

export const CHZ_SIGNER_TASK_TYPES = ["true_api_auth"] as const;
export type ChzSignerTaskType = (typeof CHZ_SIGNER_TASK_TYPES)[number];

export const CHZ_SIGNER_TASK_STATUSES = [
  "pending",
  "claimed",
  "completed",
  "failed",
  "expired",
] as const;
export type ChzSignerTaskStatus = (typeof CHZ_SIGNER_TASK_STATUSES)[number];

/**
 * Агент-подписант КЭП на машине клиента. Секрет — 192-битный токен, здесь
 * хранится только его sha256 (модель киоска: kiosks.device_token_hash).
 */
export const chzSignerAgents = pgTable(
  "chz_signer_agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    name: text("name").notNull(),
    appVersion: text("app_version"),
    secretHash: text("secret_hash").notNull(),
    status: text("status").notNull().default("active"),
    certThumbprint: text("cert_thumbprint"),
    certSubject: text("cert_subject"),
    certInn: text("cert_inn"),
    certNotAfter: timestamp("cert_not_after", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("chz_signer_agents_tenant_id_uq").on(t.tenantId, t.id),
    uniqueIndex("chz_signer_agents_secret_uq").on(t.secretHash),
    index("chz_signer_agents_tenant_idx").on(t.tenantId),
  ],
);

/**
 * Коды привязки — калька station_pairing_codes (platform.ts:581-608), но код
 * тенант-скоуповый: агент создаётся в момент redeem, а не заранее. Частичные
 * unique-индексы держат инварианты «один живой код на тенанта» и «один живой
 * код на hash» на стороне БД (retire-then-insert — два стейтмента).
 */
export const chzSignerPairingCodes = pgTable(
  "chz_signer_pairing_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    codeHash: text("code_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    issuedByUserId: text("issued_by_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("chz_signer_pairing_codes_hash_idx").on(t.codeHash),
    uniqueIndex("chz_signer_pairing_codes_one_live_uq")
      .on(t.tenantId)
      .where(sql`used_at is null`),
    uniqueIndex("chz_signer_pairing_codes_code_hash_live_uq")
      .on(t.codeHash)
      .where(sql`used_at is null`),
  ],
);

export const chzSignerTasks = pgTable(
  "chz_signer_tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    agentId: uuid("agent_id"),
    type: text("type").notNull(),
    status: text("status").notNull().default("pending"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    resultSummary: jsonb("result_summary").$type<Record<string, unknown>>(),
    attempts: integer("attempts").notNull().default(0),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "chz_signer_tasks_tenant_agent_fk",
      columns: [t.tenantId, t.agentId],
      foreignColumns: [chzSignerAgents.tenantId, chzSignerAgents.id],
    }),
    index("chz_signer_tasks_tenant_status_idx").on(t.tenantId, t.status),
    index("chz_signer_tasks_status_created_idx").on(t.status, t.createdAt),
  ],
);

/**
 * Один действующий токен True API на тенанта. Значение шифруется AES-256-GCM
 * на уровне приложения (три bytea-колонки — паттерн mail.ts:45-47); expires_at
 * хранится открыто, чтобы cron и админка читали срок без расшифровки.
 */
export const chzApiTokens = pgTable("chz_api_tokens", {
  tenantId: text("tenant_id")
    .primaryKey()
    .references(() => organization.id),
  encryptedToken: bytea("encrypted_token").notNull(),
  tokenNonce: bytea("token_nonce").notNull(),
  tokenTag: bytea("token_tag").notNull(),
  tokenType: text("token_type").notNull().default("jwt"),
  obtainedAt: timestamp("obtained_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  agentId: uuid("agent_id"),
  certThumbprint: text("cert_thumbprint"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ChzSignerAgentRow = typeof chzSignerAgents.$inferSelect;
export type ChzSignerTaskRow = typeof chzSignerTasks.$inferSelect;
export type ChzApiTokenRow = typeof chzApiTokens.$inferSelect;
```

- [ ] **Step 2: Register the schema file**

In `packages/db/src/schema.ts` add (alphabetically with the other exports):

```ts
export * from "./schema/chz.js";
```

In `packages/db/drizzle.config.ts` add `"./src/schema/chz.ts"` to the `schema` array.

- [ ] **Step 3: Generate the migration**

```bash
set -a; source .env; set +a
pnpm --filter @markiro/db db:generate
```

Expected: a new `packages/db/migrations/0086_*.sql`. Rename the generated file AND its
`meta/_journal.json` tag to `0086_chz_signer_agent` (both must match — follow the naming
style of `0083_inventory_document_rendering_metadata`). Review the SQL: 4 tables, the two
partial unique indexes with `WHERE (used_at is null)`, composite FK on
`(tenant_id, agent_id)`.

- [ ] **Step 4: Build, test, migrate**

```bash
pnpm --filter @markiro/db build
pnpm --filter @markiro/db test
pnpm --filter @markiro/db db:migrate
```

Expected: build/test pass, migration applies cleanly.

- [ ] **Step 5: Commit**

```bash
git add packages/db
git commit -m "feat(db): chz signer agent tables (agents, pairing codes, tasks, tokens)"
```

---

### Task 2: Protocol contracts in `packages/platform-contracts`

**Files:**

- Create: `packages/platform-contracts/src/chz-signer.ts`
- Modify: `packages/platform-contracts/src/index.ts` (re-export)
- Create: `packages/platform-contracts/fixtures/chz-signer/pair-request.json`, `pair-response.json`, `task.json`, `task-complete.json`, `task-fail.json`
- Test: `packages/platform-contracts/test/chz-signer.test.ts`

**Interfaces:**

- Produces: `chzSignerPairRequestSchema`, `chzSignerPairResponseSchema`, `chzSignerTaskSchema`, `chzTrueApiAuthPayloadSchema`, `chzSignerTaskCompleteSchema`, `chzSignerTaskFailSchema`, `CHZ_SIGNER_ERROR_CODES`, aggregate `chzSignerContracts`, and inferred types (`ChzSignerPairRequest`, `ChzSignerTask`, `ChzSignerTaskComplete`, `ChzSignerTaskFail`). Task 5/6 controllers validate bodies with these. The JSON fixtures are the shared source of truth the future Rust `signer-core` will parse in its own tests.

- [ ] **Step 1: Write the failing test**

`packages/platform-contracts/test/chz-signer.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  chzSignerPairRequestSchema,
  chzSignerPairResponseSchema,
  chzSignerTaskCompleteSchema,
  chzSignerTaskFailSchema,
  chzSignerTaskSchema,
} from "../src/chz-signer.js";

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(__dirname, "..", "fixtures", "chz-signer", name), "utf8"));

describe("chz-signer contracts", () => {
  it("accept the shared fixtures (Rust signer-core parses the same files)", () => {
    expect(() => chzSignerPairRequestSchema.parse(fixture("pair-request.json"))).not.toThrow();
    expect(() => chzSignerPairResponseSchema.parse(fixture("pair-response.json"))).not.toThrow();
    expect(() => chzSignerTaskSchema.parse(fixture("task.json"))).not.toThrow();
    expect(() => chzSignerTaskCompleteSchema.parse(fixture("task-complete.json"))).not.toThrow();
    expect(() => chzSignerTaskFailSchema.parse(fixture("task-fail.json"))).not.toThrow();
  });

  it("rejects a malformed pairing code", () => {
    expect(
      chzSignerPairRequestSchema.safeParse({
        pairingCode: "1234",
        hostname: "PC",
        appVersion: "0.1.0",
      }).success,
    ).toBe(false);
  });

  it("rejects unknown task fail codes and extra keys", () => {
    expect(chzSignerTaskFailSchema.safeParse({ errorCode: "NOPE", message: "x" }).success).toBe(
      false,
    );
    expect(
      chzSignerTaskCompleteSchema.safeParse({
        token: "t",
        expiresAt: "2026-08-28T10:00:00.000Z",
        certThumbprint: "ab",
        extra: 1,
      }).success,
    ).toBe(false);
  });

  it("requires a valid inn shape in the auth payload", () => {
    expect(
      chzSignerTaskSchema.safeParse({
        id: "3f0e0f5e-8d1c-4d7a-9b1a-111111111111",
        type: "true_api_auth",
        payload: { trueApiBaseUrl: "https://markirovka.crpt.ru/api/v3/true-api", inn: "12345" },
      }).success,
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @markiro/platform-contracts exec vitest run test/chz-signer.test.ts`
Expected: FAIL — cannot resolve `../src/chz-signer.js`.

- [ ] **Step 3: Write the contracts and fixtures**

`packages/platform-contracts/src/chz-signer.ts` (style mirrors `src/catalog.ts`: strict
objects, `.js` import extensions, aggregate export):

```ts
import { z } from "zod";

export const chzSignerPairRequestSchema = z
  .object({
    pairingCode: z.string().regex(/^\d{8}$/),
    hostname: z.string().trim().min(1).max(200),
    appVersion: z.string().trim().min(1).max(50),
  })
  .strict();

export const chzSignerPairResponseSchema = z
  .object({
    agentId: z.uuid(),
    agentSecret: z.string().min(32),
    tenantName: z.string(),
  })
  .strict();

const innSchema = z.string().regex(/^\d{10}(\d{2})?$/);

export const chzTrueApiAuthPayloadSchema = z
  .object({
    trueApiBaseUrl: z.url(),
    inn: innSchema.optional(),
  })
  .strict();

export const chzSignerTaskSchema = z
  .object({
    id: z.uuid(),
    type: z.literal("true_api_auth"),
    payload: chzTrueApiAuthPayloadSchema,
  })
  .strict();

export const chzSignerTaskCompleteSchema = z
  .object({
    token: z.string().min(1).max(8192),
    expiresAt: z.iso.datetime({ offset: true }),
    certThumbprint: z.string().trim().min(1).max(128),
    certSubject: z.string().trim().max(1000).optional(),
    certInn: innSchema.optional(),
    certNotAfter: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();

export const CHZ_SIGNER_ERROR_CODES = [
  "CRYPTO_PROVIDER_MISSING",
  "CRYPTO_CERT_NOT_FOUND",
  "CRYPTO_CERT_EXPIRED",
  "CRYPTO_CONTAINER_UNAVAILABLE",
  "CRYPTO_PIN_REQUIRED",
  "NETWORK",
  "TRUE_API",
] as const;

export const chzSignerTaskFailSchema = z
  .object({
    errorCode: z.enum(CHZ_SIGNER_ERROR_CODES),
    message: z.string().trim().min(1).max(2000),
  })
  .strict();

export type ChzSignerPairRequest = z.infer<typeof chzSignerPairRequestSchema>;
export type ChzSignerPairResponse = z.infer<typeof chzSignerPairResponseSchema>;
export type ChzTrueApiAuthPayload = z.infer<typeof chzTrueApiAuthPayloadSchema>;
export type ChzSignerTask = z.infer<typeof chzSignerTaskSchema>;
export type ChzSignerTaskComplete = z.infer<typeof chzSignerTaskCompleteSchema>;
export type ChzSignerTaskFail = z.infer<typeof chzSignerTaskFailSchema>;

export const chzSignerContracts = {
  pairRequest: chzSignerPairRequestSchema,
  pairResponse: chzSignerPairResponseSchema,
  task: chzSignerTaskSchema,
  trueApiAuthPayload: chzTrueApiAuthPayloadSchema,
  taskComplete: chzSignerTaskCompleteSchema,
  taskFail: chzSignerTaskFailSchema,
} as const;
```

Fixtures (`packages/platform-contracts/fixtures/chz-signer/`):

`pair-request.json`

```json
{ "pairingCode": "01234567", "hostname": "BUH-PC-01", "appVersion": "0.1.0" }
```

`pair-response.json`

```json
{
  "agentId": "3f0e0f5e-8d1c-4d7a-9b1a-111111111111",
  "agentSecret": "example-agent-secret-not-a-real-credential",
  "tenantName": "ООО Ромашка"
}
```

`task.json`

```json
{
  "id": "3f0e0f5e-8d1c-4d7a-9b1a-222222222222",
  "type": "true_api_auth",
  "payload": {
    "trueApiBaseUrl": "https://markirovka.sandbox.crptech.ru/api/v3/true-api",
    "inn": "7712345678"
  }
}
```

`task-complete.json`

```json
{
  "token": "example-true-api-token-not-a-real-credential",
  "expiresAt": "2026-08-28T20:00:00.000Z",
  "certThumbprint": "AB12CD34EF56AB12CD34EF56AB12CD34EF56AB12",
  "certSubject": "CN=ООО Ромашка, ИНН=7712345678",
  "certInn": "7712345678",
  "certNotAfter": "2027-03-01T00:00:00.000Z"
}
```

`task-fail.json`

```json
{ "errorCode": "CRYPTO_CONTAINER_UNAVAILABLE", "message": "Rutoken is not inserted" }
```

In `packages/platform-contracts/src/index.ts` add the named re-exports (values and
`export type` block) following the existing style, e.g.:

```ts
export {
  CHZ_SIGNER_ERROR_CODES,
  chzSignerContracts,
  chzSignerPairRequestSchema,
  chzSignerPairResponseSchema,
  chzSignerTaskCompleteSchema,
  chzSignerTaskFailSchema,
  chzSignerTaskSchema,
  chzTrueApiAuthPayloadSchema,
} from "./chz-signer.js";
export type {
  ChzSignerPairRequest,
  ChzSignerPairResponse,
  ChzSignerTask,
  ChzSignerTaskComplete,
  ChzSignerTaskFail,
  ChzTrueApiAuthPayload,
} from "./chz-signer.js";
```

If `vitest.config.ts` / `package.json` `files` list excludes `fixtures/`, add the
directory so it ships with the package.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @markiro/platform-contracts exec vitest run test/chz-signer.test.ts`
Expected: PASS (4 tests). Then `pnpm --filter @markiro/platform-contracts build`.

- [ ] **Step 5: Commit**

```bash
git add packages/platform-contracts
git commit -m "feat(contracts): chz signer agent protocol schemas and shared fixtures"
```

---

### Task 3: Env key + `ChzCryptoService` (AES-256-GCM token encryption)

**Files:**

- Modify: `apps/api/src/env.ts`
- Modify: `.env.example`, `.env.production.example`
- Create: `apps/api/src/modules/signer-agents/chz-crypto.service.ts`
- Test: `apps/api/test/chz-crypto.test.ts`

**Interfaces:**

- Consumes: `mailEncryptionKeySchema` pattern at `apps/api/src/env.ts:76-84`.
- Produces: env field `CHZ_TOKEN_ENCRYPTION_KEY?: Buffer`; class `ChzCryptoService` with `encrypt(tenantId: string, token: string): EncryptedChzToken` and `decrypt(tenantId: string, payload: EncryptedChzToken): string`, where `EncryptedChzToken = { encryptedToken: Buffer; tokenNonce: Buffer; tokenTag: Buffer }`. Task 6 stores/loads `chz_api_tokens` through it; Task 5's module provides it via DI factory.

- [ ] **Step 1: Write the failing test**

`apps/api/test/chz-crypto.test.ts`:

```ts
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ChzCryptoService } from "../src/modules/signer-agents/chz-crypto.service";

describe("ChzCryptoService", () => {
  const key = randomBytes(32);

  it("round-trips a token", () => {
    const svc = new ChzCryptoService(key);
    const payload = svc.encrypt("tenant-1", "jwt-token-value");
    expect(svc.decrypt("tenant-1", payload)).toBe("jwt-token-value");
  });

  it("binds ciphertext to the tenant via AAD", () => {
    const svc = new ChzCryptoService(key);
    const payload = svc.encrypt("tenant-1", "jwt-token-value");
    expect(() => svc.decrypt("tenant-2", payload)).toThrow();
  });

  it("rejects a key of the wrong length", () => {
    expect(() => new ChzCryptoService(randomBytes(16))).toThrow(/32 bytes/);
  });

  it("throws a clear error when the key is not configured", () => {
    const svc = new ChzCryptoService(undefined);
    expect(() => svc.encrypt("t", "x")).toThrow(/CHZ_TOKEN_ENCRYPTION_KEY/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @markiro/api exec vitest run test/chz-crypto.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the service and env field**

`apps/api/src/modules/signer-agents/chz-crypto.service.ts` (pattern:
`apps/api/src/modules/mail/mail-crypto.service.ts`, AAD = tenantId):

```ts
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { Injectable } from "@nestjs/common";

export interface EncryptedChzToken {
  encryptedToken: Buffer;
  tokenNonce: Buffer;
  tokenTag: Buffer;
}

/**
 * Токен True API — bearer-доступ к данным ЧЗ тенанта на 10 часов, поэтому в
 * БД он лежит только шифрованным. AAD = tenantId: чужой строкой расшифровать
 * значение нельзя даже с тем же ключом.
 */
@Injectable()
export class ChzCryptoService {
  constructor(private readonly key: Buffer | undefined) {
    if (key && key.length !== 32) {
      throw new Error("CHZ_TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes");
    }
  }

  private requireKey(): Buffer {
    if (!this.key) {
      throw new Error(
        "CHZ_TOKEN_ENCRYPTION_KEY is not configured; set it to use the Chestny ZNAK signer integration",
      );
    }
    return this.key;
  }

  encrypt(tenantId: string, token: string): EncryptedChzToken {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.requireKey(), nonce);
    cipher.setAAD(Buffer.from(tenantId, "utf8"));
    const encryptedToken = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
    return { encryptedToken, tokenNonce: nonce, tokenTag: cipher.getAuthTag() };
  }

  decrypt(tenantId: string, payload: EncryptedChzToken): string {
    const decipher = createDecipheriv("aes-256-gcm", this.requireKey(), payload.tokenNonce);
    decipher.setAAD(Buffer.from(tenantId, "utf8"));
    decipher.setAuthTag(payload.tokenTag);
    return Buffer.concat([decipher.update(payload.encryptedToken), decipher.final()]).toString(
      "utf8",
    );
  }
}
```

In `apps/api/src/env.ts`:

1. Next to the other optional secrets (near `DADATA_TOKEN`, ~line 189) add, reusing the
   existing base64-32-byte schema from `:76-84` (it already transforms to `Buffer`):
   ```ts
   CHZ_TOKEN_ENCRYPTION_KEY: mailEncryptionKeySchema.optional(),
   ```
   If `mailEncryptionKeySchema` is named differently or mail-specific, extract the
   base64→32-byte-Buffer zod schema into a local `encryptionKeySchema` and reuse it for
   both fields — do not duplicate the validation.
2. Add `"CHZ_TOKEN_ENCRYPTION_KEY"` to the empty-string normalization list inside
   `loadEnv` (`:287-303`) so `CHZ_TOKEN_ENCRYPTION_KEY=""` from compose reads as "not
   configured".
3. `.env.example` / `.env.production.example`: add a commented line
   `# CHZ_TOKEN_ENCRYPTION_KEY= # base64, exactly 32 bytes; enables the Chestny ZNAK signer integration (generate: openssl rand -base64 32)`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @markiro/api exec vitest run test/chz-crypto.test.ts`
Expected: PASS (4 tests). Also run `pnpm --filter @markiro/api typecheck` if the script
exists (otherwise `pnpm --filter @markiro/api exec tsc -p tsconfig.json --noEmit`).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/env.ts apps/api/src/modules/signer-agents/chz-crypto.service.ts apps/api/test/chz-crypto.test.ts .env.example .env.production.example
git commit -m "feat(api): CHZ token encryption key and AES-GCM crypto service"
```

---

### Task 4: Enable the `chestny_znak` channel in the registry

**Files:**

- Modify: `apps/api/src/modules/integrations/channel-registry.ts:131-138`
- Test: `apps/api/test/channel-registry.test.ts`

**Interfaces:**

- Produces: `chzSignerSettingsSchema` (exported from `channel-registry.ts`) with shape `{ environment: "production" | "sandbox"; mchdInn?: string }`; descriptor `chestny_znak` becomes `available: true`. Task 7's scheduler parses `integration_channels.settings` with this schema.

- [ ] **Step 1: Update the failing registry test first**

In `apps/api/test/channel-registry.test.ts`:

- Line 15: change to `expect(describeChannel("chestny_znak").available).toBe(true);`
- Find the test asserting that non-commerceml channels accept arbitrary settings; if it
  uses `chestny_znak` as its sample, switch the sample to `gis_mt_files`.
- Add:

```ts
it("chestny_znak settings accept environment and mchdInn and reject junk", () => {
  const schema = describeChannel("chestny_znak").settingsSchema;
  expect(schema.safeParse({ environment: "sandbox" }).success).toBe(true);
  expect(schema.safeParse({ environment: "sandbox", mchdInn: "7712345678" }).success).toBe(true);
  expect(schema.safeParse({ environment: "staging" }).success).toBe(false);
  expect(schema.safeParse({ mchdInn: "123" }).success).toBe(false);
  expect(schema.safeParse({ unknown: true }).success).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @markiro/api exec vitest run test/channel-registry.test.ts`
Expected: FAIL on `available` and on the new settings test.

- [ ] **Step 3: Implement**

In `channel-registry.ts`, above the `CHANNELS` array:

```ts
export const chzSignerSettingsSchema = z
  .object({
    environment: z.enum(["production", "sandbox"]).default("production"),
    mchdInn: z
      .string()
      .regex(/^\d{10}(\d{2})?$/)
      .optional(),
  })
  .strict();
```

Update the `chestny_znak` descriptor (`:131-138`): `available: true`,
`settingsSchema: chzSignerSettingsSchema` (keep `inbound` and
`usesExchangeCredentials: false` as they are; the channel is managed through the
signer-agents endpoints, not exchange credentials, and stays non-deletable in v1).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @markiro/api exec vitest run test/channel-registry.test.ts test/integrations.e2e.test.ts`
Expected: PASS. If an integrations e2e asserts the channel list, update its expectation
for `chestny_znak` (`state` becomes `not_configured` instead of `unavailable`).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/integrations/channel-registry.ts apps/api/test/channel-registry.test.ts
git commit -m "feat(integrations): enable chestny_znak channel with signer settings schema"
```

---

### Task 5: `signer-agents` module — pairing + cabinet endpoints

**Files:**

- Create: `apps/api/src/modules/signer-agents/chz-constants.ts`
- Create: `apps/api/src/modules/signer-agents/dto.ts`
- Create: `apps/api/src/modules/signer-agents/signer-agents.service.ts`
- Create: `apps/api/src/modules/signer-agents/signer-agents.controller.ts` (cabinet)
- Create: `apps/api/src/modules/signer-agents/signer-agent-pair.controller.ts` (public)
- Create: `apps/api/src/modules/signer-agents/signer-agents.module.ts`
- Modify: `apps/api/src/app.module.ts` (import + register)
- Test: `apps/api/test/signer-agents.e2e.test.ts`

**Interfaces:**

- Consumes: `PairAttemptsService` + `pairAttemptWindowStart`/`mintPairingCode`/`PAIRING_TTL_MS`/`PAIR_CODE_MAX_ATTEMPTS` from `apps/api/src/modules/device-pairing/`; `hashPairingCode`/`generateDeviceToken`/`hashDeviceToken` from `apps/api/src/pickup/device-token.ts`; `JournalService`; `ChzCryptoService` (Task 3); contracts (Task 2); tables (Task 1); guards/decorators from `tenancy`/`authorization`/`subscriptions`; OpenAPI helpers from `apps/api/src/lib/openapi.ts` and `ApiPairingCodeSecretResponse` from `apps/api/src/modules/device-pairing/secret-response.openapi.ts`.
- Produces: `SignerAgentsService` with `overview(tenantId)`, `issuePairingCode(tenantId, userId)`, `revoke(tenantId, agentId)`, `pair(code, source, hostname, appVersion)`; routes `GET /signer-agents`, `POST /signer-agents/pairing-code`, `POST /signer-agents/:id/revoke`, `POST /signer-agent/pair`. Task 6 adds the tasks controller to this module; Task 8's admin panel calls the cabinet routes.

- [ ] **Step 1: Write the failing e2e test**

`apps/api/test/signer-agents.e2e.test.ts` (setup copied from
`apps/api/test/integrations-delete.e2e.test.ts:32-52`; same `ready` gate):

```ts
import express from "express";
import request from "supertest";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { loadEnv } from "../src/env";
import { setupAuth, mountAuth, type AuthSetup } from "../src/auth/auth-setup"; // ← copy exact imports from integrations-delete.e2e.test.ts
import { listenOnLoopback } from "./support/listen-loopback";
import { signUpAndActivate } from "./support/auth";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

describe.skipIf(!ready)("signer agents pairing", () => {
  let app: any, agent: request.Agent, tenantId: string;

  beforeAll(async () => {
    const env = loadEnv();
    const setup: AuthSetup = setupAuth(env);
    const ref = await Test.createTestingModule({
      imports: [AppModule.forRoot({ ...setup, databaseUrl: env.DATABASE_URL })],
    }).compile();
    app = ref.createNestApplication({ bodyParser: false });
    const server = app.getHttpAdapter().getInstance();
    mountAuth(server, setup.auth);
    server.use(express.json());
    await app.init();
    await listenOnLoopback(app);
    agent = request.agent(app.getHttpServer());
    tenantId = await signUpAndActivate(agent);
  });

  afterAll(async () => {
    await app?.close();
  });

  it("issues an 8-digit pairing code", async () => {
    const res = await agent.post("/api/signer-agents/pairing-code").expect(201);
    expect(res.body.code).toMatch(/^\d{8}$/);
    expect(new Date(res.body.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("rejects a wrong code and pairs with the right one exactly once", async () => {
    const { body: issued } = await agent.post("/api/signer-agents/pairing-code").expect(201);
    await request(app.getHttpServer())
      .post("/api/signer-agent/pair")
      .send({ pairingCode: "00000000", hostname: "PC", appVersion: "0.1.0" })
      .expect(401);
    const pair = await request(app.getHttpServer())
      .post("/api/signer-agent/pair")
      .send({ pairingCode: issued.code, hostname: "BUH-PC", appVersion: "0.1.0" })
      .expect(201);
    expect(pair.body.agentId).toBeTruthy();
    expect(pair.body.agentSecret.length).toBeGreaterThanOrEqual(32);
    expect(pair.body.tenantName).toBeTruthy();
    // one-time use
    await request(app.getHttpServer())
      .post("/api/signer-agent/pair")
      .send({ pairingCode: issued.code, hostname: "BUH-PC", appVersion: "0.1.0" })
      .expect(401);
    // agent shows up in the overview with the empty token status
    const overview = await agent.get("/api/signer-agents").expect(200);
    expect(
      overview.body.agents.some((a: any) => a.name === "BUH-PC" && a.status === "active"),
    ).toBe(true);
    expect(overview.body.token.status).toBe("none");
  });

  it("revokes an agent", async () => {
    const { body: issued } = await agent.post("/api/signer-agents/pairing-code").expect(201);
    const pair = await request(app.getHttpServer())
      .post("/api/signer-agent/pair")
      .send({ pairingCode: issued.code, hostname: "PC-2", appVersion: "0.1.0" })
      .expect(201);
    await agent.post(`/api/signer-agents/${pair.body.agentId}/revoke`).expect(204);
    const overview = await agent.get("/api/signer-agents").expect(200);
    const revoked = overview.body.agents.find((a: any) => a.id === pair.body.agentId);
    expect(revoked.status).toBe("revoked");
  });
});
```

Note: if the app is NOT mounted under a `/api` global prefix in other e2e tests, drop
the `/api` segment to match them (check how `integrations-delete.e2e.test.ts` builds
paths and mirror it exactly).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @markiro/api exec vitest run test/signer-agents.e2e.test.ts`
Expected: FAIL — 404 (routes not registered).

- [ ] **Step 3: Implement constants and DTOs**

`apps/api/src/modules/signer-agents/chz-constants.ts`:

```ts
export const CHZ_CHANNEL_TYPE = "chestny_znak" as const;

export const CHZ_TRUE_API_BASE_URLS = {
  production: "https://markirovka.crpt.ru/api/v3/true-api",
  sandbox: "https://markirovka.sandbox.crptech.ru/api/v3/true-api",
} as const;

/** Начинаем обновление за 90 минут до истечения 10-часового токена. */
export const CHZ_TOKEN_REFRESH_LEAD_MS = 90 * 60_000;
/** pending/claimed задача старше 30 минут считается протухшей. */
export const CHZ_TASK_STALE_MS = 30 * 60_000;
/** Токен, истекающий в пределах lead-окна, показываем как "expiring". */
export type ChzTokenUiStatus = "none" | "active" | "expiring" | "expired";
```

`apps/api/src/modules/signer-agents/dto.ts`:

```ts
import {
  chzSignerPairRequestSchema,
  type ChzSignerPairRequest,
  type ChzSignerPairResponse,
} from "@markiro/platform-contracts";
import type { ChzTokenUiStatus } from "./chz-constants";

export const pairSignerAgentSchema = chzSignerPairRequestSchema;
export type PairSignerAgentDto = ChzSignerPairRequest;
export type PairSignerAgentResultDto = ChzSignerPairResponse;

export interface SignerAgentSummaryDto {
  id: string;
  name: string;
  appVersion: string | null;
  status: "active" | "revoked";
  certThumbprint: string | null;
  certSubject: string | null;
  certInn: string | null;
  certNotAfter: string | null;
  lastSeenAt: string | null;
  createdAt: string;
}

export interface SignerTokenStatusDto {
  status: ChzTokenUiStatus;
  obtainedAt: string | null;
  expiresAt: string | null;
  certThumbprint: string | null;
}

export interface SignerAgentsOverviewDto {
  agents: SignerAgentSummaryDto[];
  token: SignerTokenStatusDto;
}

export interface IssueSignerPairingCodeResultDto {
  code: string;
  expiresAt: Date;
}
```

- [ ] **Step 4: Implement `SignerAgentsService`**

`apps/api/src/modules/signer-agents/signer-agents.service.ts`. Mirror the kiosk pairing
service structure (`apps/api/src/modules/kiosk/pairing.service.ts:69-382`), simplified:
codes are tenant-scoped, the agent row is created at redeem.

```ts
import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { schema } from "@markiro/db"; // ← copy the exact schema/db import style from journal.service.ts
import { DB } from "../../auth/auth.module";
import type { Db } from "../../auth/auth.module"; // ← same source journal.service.ts uses for the Db type
import { loadEnv } from "../../env";
import { generateDeviceToken, hashDeviceToken, hashPairingCode } from "../../pickup/device-token";
import {
  mintPairingCode,
  PAIR_CODE_MAX_ATTEMPTS,
  PAIRING_TTL_MS,
  pairAttemptWindowStart,
} from "../device-pairing/pairing-policy";
import { PairAttemptsService } from "../device-pairing/pair-attempts.service";
import { JournalService } from "../integrations/journal.service";
import { CHZ_CHANNEL_TYPE, CHZ_TOKEN_REFRESH_LEAD_MS } from "./chz-constants";
import type {
  IssueSignerPairingCodeResultDto,
  PairSignerAgentResultDto,
  SignerAgentsOverviewDto,
  SignerTokenStatusDto,
} from "./dto";

const MINT_ATTEMPTS = 5;

class PairingCodeHashCollisionError extends Error {}

@Injectable()
export class SignerAgentsService {
  private readonly logger = new Logger(SignerAgentsService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly pairAttempts: PairAttemptsService,
    private readonly journal: JournalService,
  ) {}

  async overview(tenantId: string): Promise<SignerAgentsOverviewDto> {
    const agents = await this.db
      .select()
      .from(schema.chzSignerAgents)
      .where(eq(schema.chzSignerAgents.tenantId, tenantId))
      .orderBy(desc(schema.chzSignerAgents.createdAt));
    const [token] = await this.db
      .select()
      .from(schema.chzApiTokens)
      .where(eq(schema.chzApiTokens.tenantId, tenantId));
    return {
      agents: agents.map((a) => ({
        id: a.id,
        name: a.name,
        appVersion: a.appVersion,
        status: a.status as "active" | "revoked",
        certThumbprint: a.certThumbprint,
        certSubject: a.certSubject,
        certInn: a.certInn,
        certNotAfter: a.certNotAfter?.toISOString() ?? null,
        lastSeenAt: a.lastSeenAt?.toISOString() ?? null,
        createdAt: a.createdAt.toISOString(),
      })),
      token: this.tokenStatus(token ?? null),
    };
  }

  private tokenStatus(token: typeof schema.chzApiTokens.$inferSelect | null): SignerTokenStatusDto {
    if (!token) {
      return { status: "none", obtainedAt: null, expiresAt: null, certThumbprint: null };
    }
    const now = Date.now();
    const expiresAt = token.expiresAt.getTime();
    const status =
      expiresAt <= now
        ? "expired"
        : expiresAt <= now + CHZ_TOKEN_REFRESH_LEAD_MS
          ? "expiring"
          : "active";
    return {
      status,
      obtainedAt: token.obtainedAt.toISOString(),
      expiresAt: token.expiresAt.toISOString(),
      certThumbprint: token.certThumbprint,
    };
  }

  async issuePairingCode(
    tenantId: string,
    userId: string,
  ): Promise<IssueSignerPairingCodeResultDto> {
    const expiresAt = new Date(Date.now() + PAIRING_TTL_MS);
    const pepper = loadEnv().PAIRING_CODE_PEPPER;
    for (let attempt = 0; attempt < MINT_ATTEMPTS; attempt++) {
      const code = mintPairingCode();
      const codeHash = hashPairingCode(code, pepper);
      try {
        await this.db.transaction(async (tx) => {
          await tx
            .update(schema.chzSignerPairingCodes)
            .set({ usedAt: new Date() })
            .where(
              and(
                eq(schema.chzSignerPairingCodes.tenantId, tenantId),
                isNull(schema.chzSignerPairingCodes.usedAt),
              ),
            );
          const [clash] = await tx
            .select({ id: schema.chzSignerPairingCodes.id })
            .from(schema.chzSignerPairingCodes)
            .where(
              and(
                eq(schema.chzSignerPairingCodes.codeHash, codeHash),
                isNull(schema.chzSignerPairingCodes.usedAt),
              ),
            );
          if (clash) throw new PairingCodeHashCollisionError();
          await tx.insert(schema.chzSignerPairingCodes).values({
            tenantId,
            codeHash,
            expiresAt,
            issuedByUserId: userId,
          });
        });
      } catch (error) {
        if (error instanceof PairingCodeHashCollisionError || this.isUniqueViolation(error)) {
          continue;
        }
        throw error;
      }
      return { code, expiresAt };
    }
    throw new Error("Could not mint a unique signer pairing code");
  }

  // 23505 detection: copy the constraint()/error-code helpers from
  // apps/api/src/modules/station-pairing/station-pairing.service.ts:482-499
  private isUniqueViolation(error: unknown): boolean {
    const candidates = [error, (error as { cause?: unknown })?.cause];
    return candidates.some((e) => (e as { code?: string } | undefined)?.code === "23505");
  }

  async revoke(tenantId: string, agentId: string): Promise<void> {
    const [agent] = await this.db
      .update(schema.chzSignerAgents)
      .set({ status: "revoked", revokedAt: new Date() })
      .where(
        and(
          eq(schema.chzSignerAgents.tenantId, tenantId),
          eq(schema.chzSignerAgents.id, agentId),
          eq(schema.chzSignerAgents.status, "active"),
        ),
      )
      .returning({ id: schema.chzSignerAgents.id, name: schema.chzSignerAgents.name });
    if (!agent) throw new NotFoundException();
    // Отзыв агента = отзыв доступа: чистим токен тенанта (спека, §Security).
    await this.db.delete(schema.chzApiTokens).where(eq(schema.chzApiTokens.tenantId, tenantId));
    await this.journal.append({
      tenantId,
      channelType: CHZ_CHANNEL_TYPE,
      sessionId: null,
      direction: "local",
      outcome: "warn",
      grain: "session",
      message: `Signer agent revoked: ${agent.name}`,
    });
  }

  async pair(
    code: string,
    source: string,
    hostname: string,
    appVersion: string,
  ): Promise<PairSignerAgentResultDto> {
    const now = new Date();
    const windowStart = pairAttemptWindowStart(now);
    await this.pairAttempts.assertUnderPairRateLimit(source, windowStart);
    const result = await this.attemptPair(code, now, hostname, appVersion);
    await this.pairAttempts
      .refundPairAttempt(source, windowStart)
      .catch((e) => this.logger.warn(`pair attempt refund failed: ${e}`));
    await this.journal.append({
      tenantId: result.tenantId,
      channelType: CHZ_CHANNEL_TYPE,
      sessionId: null,
      direction: "in",
      outcome: "ok",
      grain: "session",
      message: `Signer agent paired: ${hostname}`,
    });
    return result.dto;
  }

  private async attemptPair(
    code: string,
    now: Date,
    hostname: string,
    appVersion: string,
  ): Promise<{ tenantId: string; dto: PairSignerAgentResultDto }> {
    const pepper = loadEnv().PAIRING_CODE_PEPPER;
    const codeHash = hashPairingCode(code, pepper);
    const rows = await this.db
      .select({
        id: schema.chzSignerPairingCodes.id,
        tenantId: schema.chzSignerPairingCodes.tenantId,
        expiresAt: schema.chzSignerPairingCodes.expiresAt,
        usedAt: schema.chzSignerPairingCodes.usedAt,
        attempts: schema.chzSignerPairingCodes.attempts,
        tenantName: schema.organization.name,
      })
      .from(schema.chzSignerPairingCodes)
      .innerJoin(
        schema.organization,
        eq(schema.organization.id, schema.chzSignerPairingCodes.tenantId),
      )
      .where(eq(schema.chzSignerPairingCodes.codeHash, codeHash))
      .orderBy(desc(schema.chzSignerPairingCodes.createdAt));
    const live = rows.filter((r) => r.usedAt === null && r.expiresAt > now);
    if (live.length > 1) throw new UnauthorizedException(); // кросс-тенантная коллизия hash — отказ, не угадывание
    const candidate = live[0] ?? rows[0];
    if (!candidate) throw new UnauthorizedException();
    if (candidate.attempts >= PAIR_CODE_MAX_ATTEMPTS) throw new UnauthorizedException();
    if (candidate.usedAt !== null || candidate.expiresAt <= now) {
      await this.db
        .update(schema.chzSignerPairingCodes)
        .set({ attempts: candidate.attempts + 1 })
        .where(eq(schema.chzSignerPairingCodes.id, candidate.id));
      throw new UnauthorizedException();
    }

    const secret = generateDeviceToken();
    const secretHash = hashDeviceToken(secret);
    const agentId = await this.db.transaction(async (tx) => {
      const [claimed] = await tx
        .update(schema.chzSignerPairingCodes)
        .set({ usedAt: new Date() })
        .where(
          and(
            eq(schema.chzSignerPairingCodes.id, candidate.id),
            isNull(schema.chzSignerPairingCodes.usedAt),
            gt(schema.chzSignerPairingCodes.expiresAt, sql`now()`),
          ),
        )
        .returning({ id: schema.chzSignerPairingCodes.id });
      if (!claimed) throw new UnauthorizedException();
      const [agent] = await tx
        .insert(schema.chzSignerAgents)
        .values({ tenantId: candidate.tenantId, name: hostname, appVersion, secretHash })
        .returning({ id: schema.chzSignerAgents.id });
      if (!agent) throw new Error("Signer agent insert returned no row");
      return agent.id;
    });
    return {
      tenantId: candidate.tenantId,
      dto: { agentId, agentSecret: secret, tenantName: candidate.tenantName },
    };
  }
}
```

Note: `schema.organization` — use the exact export name the other services use for the
organization table (check `journal.service.ts` / `station-pairing.service.ts` imports and
match).

- [ ] **Step 5: Implement the controllers and module**

`apps/api/src/modules/signer-agents/signer-agents.controller.ts` (cabinet; decorator set
copied from `apps/api/src/modules/integrations/integrations.controller.ts:65-69` and
`kiosks.controller.ts:223-247` — including `SecurityAuditService.credentialMutation`
audit calls for issue/revoke, actions `chz_signer_pairing_code.issue` and
`chz_signer_agent.revoke`):

```ts
@ApiTags("signer-agents")
@Controller("signer-agents")
@UseGuards(TenantGuard, AuthorizationGuard, SubscriptionAccessGuard)
@AllowSubscriptionReadOnly("read")
@ApiCabinetAuth()
export class SignerAgentsController {
  constructor(
    private readonly service: SignerAgentsService,
    private readonly audit: SecurityAuditService,
  ) {}

  @Get()
  @RequirePermissions(CABINET_CAPABILITY.INTEGRATIONS_READ)
  @ApiOkResponse({ schema: signerAgentsOverviewOpenApiSchema })
  async overview(@Req() req: RequestWithTenant): Promise<SignerAgentsOverviewDto> {
    return this.service.overview(req.tenantId!);
  }

  @Post("pairing-code")
  @Header("Cache-Control", "no-store")
  @ApiPairingCodeSecretResponse()
  @RequireSubscriptionWrite()
  @RequirePermissions(CABINET_CAPABILITY.INTEGRATIONS_WRITE, CABINET_CAPABILITY.CREDENTIALS_MANAGE)
  async issuePairingCode(@Req() req: RequestWithTenant): Promise<IssueSignerPairingCodeResultDto> {
    const result = await this.service.issuePairingCode(req.tenantId!, req.userId!);
    this.auditMutation(req, "chz_signer_pairing_code.issue", "succeeded");
    return result;
  }

  @Post(":id/revoke")
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireSubscriptionWrite()
  @RequirePermissions(CABINET_CAPABILITY.INTEGRATIONS_WRITE, CABINET_CAPABILITY.CREDENTIALS_MANAGE)
  async revoke(@Req() req: RequestWithTenant, @Param("id") id: string): Promise<void> {
    await this.service.revoke(req.tenantId!, id);
    this.auditMutation(req, "chz_signer_agent.revoke", "succeeded");
  }
  // auditMutation helper: copy the shape from kiosks.controller.ts:249+
}
```

`signerAgentsOverviewOpenApiSchema`: hand-written `SchemaObject` in `dto.ts` following
the `apiKeySummaryListOpenApiSchema` pattern (`api-keys.controller.ts:41-45`) —
`additionalProperties: false`, required `agents`, `token`.

`apps/api/src/modules/signer-agents/signer-agent-pair.controller.ts` (deliberately a
separate controller — no class-level guard, same reasoning as
`kiosk-pair.controller.ts:9-19`):

```ts
@ApiTags("signer-agent")
@Controller("signer-agent")
export class SignerAgentPairController {
  constructor(private readonly service: SignerAgentsService) {}

  @Post("pair")
  @Header("Cache-Control", "no-store")
  @ApiZodBody(pairSignerAgentSchema)
  @ApiZodResponse(chzSignerPairResponseSchema) // if ApiZodResponse doesn't exist, use @ApiOkResponse({ schema: zodApiSchema(chzSignerPairResponseSchema) })
  async pair(
    @Body(new ZodValidationPipe(pairSignerAgentSchema)) body: PairSignerAgentDto,
    @Ip() ip: string,
  ): Promise<PairSignerAgentResultDto> {
    return this.service.pair(body.pairingCode, ip, body.hostname, body.appVersion);
  }
}
```

`apps/api/src/modules/signer-agents/signer-agents.module.ts` (DynamicModule — needs env
for the crypto key; pattern `storage.module.ts:1-19`):

```ts
import { Module, type DynamicModule } from "@nestjs/common";
import type { Env } from "../../env";
import { DevicePairingModule } from "../device-pairing/device-pairing.module";
import { JournalService } from "../integrations/journal.service";
import { ChzCryptoService } from "./chz-crypto.service";
import { SignerAgentPairController } from "./signer-agent-pair.controller";
import { SignerAgentsController } from "./signer-agents.controller";
import { SignerAgentsService } from "./signer-agents.service";

@Module({})
export class SignerAgentsModule {
  static forRoot(env: Env): DynamicModule {
    return {
      module: SignerAgentsModule,
      imports: [DevicePairingModule],
      controllers: [SignerAgentsController, SignerAgentPairController],
      providers: [
        SignerAgentsService,
        JournalService,
        {
          provide: ChzCryptoService,
          useFactory: () => new ChzCryptoService(env.CHZ_TOKEN_ENCRYPTION_KEY),
        },
      ],
      exports: [ChzCryptoService],
    };
  }
}
```

If `SecurityAuditService` is not globally provided, add it to `providers` the same way
`kiosks.module.ts` does.

In `apps/api/src/app.module.ts`: import `SignerAgentsModule` and add
`SignerAgentsModule.forRoot(env)` to `imports` next to `IntegrationsModule` (`:119`).

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @markiro/api exec vitest run test/signer-agents.e2e.test.ts test/openapi-coverage.test.ts`
Expected: PASS. Fix any coverage-gate complaints by completing the OpenAPI decorators.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/signer-agents apps/api/src/app.module.ts apps/api/test/signer-agents.e2e.test.ts
git commit -m "feat(api): chz signer agent pairing and cabinet endpoints"
```

---

### Task 6: Agent guard + task queue endpoints

**Files:**

- Create: `apps/api/src/tenancy/signer-agent.guard.ts`
- Create: `apps/api/src/modules/signer-agents/signer-tasks.service.ts`
- Create: `apps/api/src/modules/signer-agents/signer-agent-tasks.controller.ts`
- Modify: `apps/api/src/modules/signer-agents/signer-agents.module.ts` (register controller + service + guard)
- Test: `apps/api/test/signer-agent-tasks.e2e.test.ts`

**Interfaces:**

- Consumes: `hashDeviceToken`; `ChzCryptoService.encrypt`; contracts `chzSignerTaskCompleteSchema` / `chzSignerTaskFailSchema` / `ChzSignerTask`; tables from Task 1.
- Produces: `SignerAgentGuard` (header `x-signer-token`, sets `req.tenantId` + `req.signerAgentId`, bumps `lastSeenAt`); `SignerTasksService` with `claimNext(tenantId, agentId, waitMs): Promise<ChzSignerTask | null>`, `complete(tenantId, agentId, taskId, body: ChzSignerTaskComplete): Promise<void>`, `fail(tenantId, agentId, taskId, body: ChzSignerTaskFail): Promise<void>`; routes `GET /signer-agent/tasks/next?wait=`, `POST /signer-agent/tasks/:id/complete`, `POST /signer-agent/tasks/:id/fail`. Task 7's scheduler inserts the rows this service serves.

- [ ] **Step 1: Write the failing e2e test**

`apps/api/test/signer-agent-tasks.e2e.test.ts` (same bootstrap as Task 5's test; add a
local helper that pairs an agent and returns its secret, and a helper that inserts a
pending task directly via `db`):

```ts
// bootstrap identical to signer-agents.e2e.test.ts, plus: const db = ref.get(DB);

async function pairAgent(): Promise<{ agentId: string; secret: string }> {
  const { body: issued } = await agent.post("/api/signer-agents/pairing-code").expect(201);
  const pair = await request(app.getHttpServer())
    .post("/api/signer-agent/pair")
    .send({ pairingCode: issued.code, hostname: "PC", appVersion: "0.1.0" })
    .expect(201);
  return { agentId: pair.body.agentId, secret: pair.body.agentSecret };
}

async function insertTask(): Promise<string> {
  const [row] = await db
    .insert(schema.chzSignerTasks)
    .values({
      tenantId,
      type: "true_api_auth",
      payload: { trueApiBaseUrl: "https://markirovka.sandbox.crptech.ru/api/v3/true-api" },
    })
    .returning({ id: schema.chzSignerTasks.id });
  return row.id;
}

it("rejects a bad agent token", async () => {
  await request(app.getHttpServer())
    .get("/api/signer-agent/tasks/next?wait=0")
    .set("x-signer-token", "nope")
    .expect(401);
});

it("claims, returns and completes a task, storing the encrypted token", async () => {
  const { agentId, secret } = await pairAgent();
  const taskId = await insertTask();
  const next = await request(app.getHttpServer())
    .get("/api/signer-agent/tasks/next?wait=0")
    .set("x-signer-token", secret)
    .expect(200);
  expect(next.body.task).toMatchObject({ id: taskId, type: "true_api_auth" });
  // повторный опрос — задач нет (уже claimed этим агентом)
  const empty = await request(app.getHttpServer())
    .get("/api/signer-agent/tasks/next?wait=0")
    .set("x-signer-token", secret)
    .expect(200);
  expect(empty.body.task).toBeNull();

  const expiresAt = new Date(Date.now() + 10 * 3600_000).toISOString();
  await request(app.getHttpServer())
    .post(`/api/signer-agent/tasks/${taskId}/complete`)
    .set("x-signer-token", secret)
    .send({ token: "jwt-abc", expiresAt, certThumbprint: "AB12" })
    .expect(204);

  const [stored] = await db
    .select()
    .from(schema.chzApiTokens)
    .where(eq(schema.chzApiTokens.tenantId, tenantId));
  expect(stored).toBeTruthy();
  expect(stored.encryptedToken.toString("utf8")).not.toContain("jwt-abc"); // токен не в открытом виде
  expect(stored.agentId).toBe(agentId);

  const overview = await agent.get("/api/signer-agents").expect(200);
  expect(overview.body.token.status).toBe("active");
  const agentRow = overview.body.agents.find((a: any) => a.id === agentId);
  expect(agentRow.certThumbprint).toBe("AB12");
});

it("records a failed task with its error code", async () => {
  const { secret } = await pairAgent();
  const taskId = await insertTask();
  await request(app.getHttpServer())
    .get("/api/signer-agent/tasks/next?wait=0")
    .set("x-signer-token", secret)
    .expect(200);
  await request(app.getHttpServer())
    .post(`/api/signer-agent/tasks/${taskId}/fail`)
    .set("x-signer-token", secret)
    .send({ errorCode: "CRYPTO_PIN_REQUIRED", message: "PIN prompt pending" })
    .expect(204);
  const [row] = await db
    .select()
    .from(schema.chzSignerTasks)
    .where(eq(schema.chzSignerTasks.id, taskId));
  expect(row.status).toBe("failed");
  expect(row.errorCode).toBe("CRYPTO_PIN_REQUIRED");
});

it("does not let an agent complete a task claimed by another agent", async () => {
  const a1 = await pairAgent();
  const a2 = await pairAgent();
  const taskId = await insertTask();
  await request(app.getHttpServer())
    .get("/api/signer-agent/tasks/next?wait=0")
    .set("x-signer-token", a1.secret)
    .expect(200);
  await request(app.getHttpServer())
    .post(`/api/signer-agent/tasks/${taskId}/complete`)
    .set("x-signer-token", a2.secret)
    .send({
      token: "x",
      expiresAt: new Date(Date.now() + 1000).toISOString(),
      certThumbprint: "CD",
    })
    .expect(404);
});
```

Note: this test requires `CHZ_TOKEN_ENCRYPTION_KEY` in the environment — add
`CHZ_TOKEN_ENCRYPTION_KEY` (any `openssl rand -base64 32` value) to the dev `.env` and
include it in the `ready` gate: `const ready = Boolean(... && process.env.CHZ_TOKEN_ENCRYPTION_KEY)`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @markiro/api exec vitest run test/signer-agent-tasks.e2e.test.ts`
Expected: FAIL — 404 on `/signer-agent/tasks/next`.

- [ ] **Step 3: Implement the guard**

`apps/api/src/tenancy/signer-agent.guard.ts` (clone of
`apps/api/src/tenancy/kiosk-device.guard.ts` with the signer header/table):

```ts
import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";
import { and, eq } from "drizzle-orm";
import { schema } from "@markiro/db"; // match kiosk-device.guard.ts imports exactly
import { DB, type Db } from "../auth/auth.module";
import { hashDeviceToken } from "../pickup/device-token";

export interface RequestWithSignerAgent extends Request {
  tenantId?: string;
  signerAgentId?: string;
}

@Injectable()
export class SignerAgentGuard implements CanActivate {
  constructor(@Inject(DB) private readonly db: Db) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<RequestWithSignerAgent>();
    const header = req.headers["x-signer-token"];
    const token = Array.isArray(header) ? header[0] : header;
    if (!token) throw new UnauthorizedException();
    const [agent] = await this.db
      .select({
        id: schema.chzSignerAgents.id,
        tenantId: schema.chzSignerAgents.tenantId,
      })
      .from(schema.chzSignerAgents)
      .where(
        and(
          eq(schema.chzSignerAgents.secretHash, hashDeviceToken(token)),
          eq(schema.chzSignerAgents.status, "active"),
        ),
      );
    if (!agent) throw new UnauthorizedException();
    req.tenantId = agent.tenantId;
    req.signerAgentId = agent.id;
    await this.db
      .update(schema.chzSignerAgents)
      .set({ lastSeenAt: new Date() })
      .where(eq(schema.chzSignerAgents.id, agent.id));
    return true;
  }
}
```

- [ ] **Step 4: Implement `SignerTasksService`**

`apps/api/src/modules/signer-agents/signer-tasks.service.ts`:

```ts
import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import {
  chzTrueApiAuthPayloadSchema,
  type ChzSignerTask,
  type ChzSignerTaskComplete,
  type ChzSignerTaskFail,
} from "@markiro/platform-contracts";
import { schema } from "@markiro/db";
import { DB, type Db } from "../../auth/auth.module";
import { JournalService } from "../integrations/journal.service";
import { CHZ_CHANNEL_TYPE } from "./chz-constants";
import { ChzCryptoService } from "./chz-crypto.service";

const CLAIM_POLL_INTERVAL_MS = 2_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

@Injectable()
export class SignerTasksService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly crypto: ChzCryptoService,
    private readonly journal: JournalService,
  ) {}

  async claimNext(
    tenantId: string,
    agentId: string,
    waitMs: number,
  ): Promise<ChzSignerTask | null> {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const claimed = await this.tryClaim(tenantId, agentId);
      if (claimed) return claimed;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      await sleep(Math.min(CLAIM_POLL_INTERVAL_MS, remaining));
    }
  }

  private async tryClaim(tenantId: string, agentId: string): Promise<ChzSignerTask | null> {
    // Одностейтментный атомарный claim: SKIP LOCKED защищает от гонки двух агентов.
    const [task] = await this.db
      .update(schema.chzSignerTasks)
      .set({
        status: "claimed",
        agentId,
        claimedAt: new Date(),
        attempts: sql`${schema.chzSignerTasks.attempts} + 1`,
      })
      .where(
        sql`${schema.chzSignerTasks.id} in (
          select id from chz_signer_tasks
          where tenant_id = ${tenantId} and status = 'pending'
          order by created_at asc
          limit 1
          for update skip locked
        )`,
      )
      .returning({
        id: schema.chzSignerTasks.id,
        type: schema.chzSignerTasks.type,
        payload: schema.chzSignerTasks.payload,
      });
    if (!task) return null;
    return {
      id: task.id,
      type: task.type as "true_api_auth",
      payload: chzTrueApiAuthPayloadSchema.parse(task.payload),
    };
  }

  async complete(
    tenantId: string,
    agentId: string,
    taskId: string,
    body: ChzSignerTaskComplete,
  ): Promise<void> {
    const encrypted = this.crypto.encrypt(tenantId, body.token);
    const obtainedAt = new Date();
    const expiresAt = new Date(body.expiresAt);
    await this.db.transaction(async (tx) => {
      const [task] = await tx
        .update(schema.chzSignerTasks)
        .set({
          status: "completed",
          completedAt: new Date(),
          resultSummary: { expiresAt: body.expiresAt, certThumbprint: body.certThumbprint },
        })
        .where(
          and(
            eq(schema.chzSignerTasks.id, taskId),
            eq(schema.chzSignerTasks.tenantId, tenantId),
            eq(schema.chzSignerTasks.agentId, agentId),
            eq(schema.chzSignerTasks.status, "claimed"),
          ),
        )
        .returning({ id: schema.chzSignerTasks.id });
      if (!task) throw new NotFoundException();
      await tx
        .insert(schema.chzApiTokens)
        .values({
          tenantId,
          encryptedToken: encrypted.encryptedToken,
          tokenNonce: encrypted.tokenNonce,
          tokenTag: encrypted.tokenTag,
          obtainedAt,
          expiresAt,
          agentId,
          certThumbprint: body.certThumbprint,
        })
        .onConflictDoUpdate({
          target: schema.chzApiTokens.tenantId,
          set: {
            encryptedToken: encrypted.encryptedToken,
            tokenNonce: encrypted.tokenNonce,
            tokenTag: encrypted.tokenTag,
            obtainedAt,
            expiresAt,
            agentId,
            certThumbprint: body.certThumbprint,
            updatedAt: new Date(),
          },
        });
      await tx
        .update(schema.chzSignerAgents)
        .set({
          certThumbprint: body.certThumbprint,
          certSubject: body.certSubject ?? null,
          certInn: body.certInn ?? null,
          certNotAfter: body.certNotAfter ? new Date(body.certNotAfter) : null,
        })
        .where(
          and(
            eq(schema.chzSignerAgents.tenantId, tenantId),
            eq(schema.chzSignerAgents.id, agentId),
          ),
        );
    });
    await this.journal.append({
      tenantId,
      channelType: CHZ_CHANNEL_TYPE,
      sessionId: null,
      direction: "in",
      outcome: "ok",
      grain: "item",
      message: "True API token refreshed",
      details: { expiresAt: body.expiresAt, certThumbprint: body.certThumbprint },
    });
  }

  async fail(
    tenantId: string,
    agentId: string,
    taskId: string,
    body: ChzSignerTaskFail,
  ): Promise<void> {
    const [task] = await this.db
      .update(schema.chzSignerTasks)
      .set({
        status: "failed",
        completedAt: new Date(),
        errorCode: body.errorCode,
        errorMessage: body.message,
      })
      .where(
        and(
          eq(schema.chzSignerTasks.id, taskId),
          eq(schema.chzSignerTasks.tenantId, tenantId),
          eq(schema.chzSignerTasks.agentId, agentId),
          eq(schema.chzSignerTasks.status, "claimed"),
        ),
      )
      .returning({ id: schema.chzSignerTasks.id });
    if (!task) throw new NotFoundException();
    await this.journal.append({
      tenantId,
      channelType: CHZ_CHANNEL_TYPE,
      sessionId: null,
      direction: "in",
      outcome: "error",
      grain: "item",
      message: `Signer task failed: ${body.errorCode}`,
      details: { errorCode: body.errorCode, errorMessage: body.message },
    });
  }
}
```

- [ ] **Step 5: Implement the controller and register everything**

`apps/api/src/modules/signer-agents/signer-agent-tasks.controller.ts`:

```ts
const nextTaskQuerySchema = z.object({
  wait: z.coerce.number().int().min(0).max(25_000).default(25_000),
});

@ApiTags("signer-agent")
@Controller("signer-agent")
@UseGuards(SignerAgentGuard)
export class SignerAgentTasksController {
  constructor(private readonly tasks: SignerTasksService) {}

  @Get("tasks/next")
  @ApiOkResponse({ schema: nextTaskOpenApiSchema }) // { task: ChzSignerTask | null } — hand-written SchemaObject in dto.ts
  async next(
    @Req() req: RequestWithSignerAgent,
    @Query(new ZodValidationPipe(nextTaskQuerySchema)) q: { wait: number },
  ): Promise<{ task: ChzSignerTask | null }> {
    const task = await this.tasks.claimNext(req.tenantId!, req.signerAgentId!, q.wait);
    return { task };
  }

  @Post("tasks/:id/complete")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiZodBody(chzSignerTaskCompleteSchema)
  async complete(
    @Req() req: RequestWithSignerAgent,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(chzSignerTaskCompleteSchema)) body: ChzSignerTaskComplete,
  ): Promise<void> {
    await this.tasks.complete(req.tenantId!, req.signerAgentId!, id, body);
  }

  @Post("tasks/:id/fail")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiZodBody(chzSignerTaskFailSchema)
  async fail(
    @Req() req: RequestWithSignerAgent,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(chzSignerTaskFailSchema)) body: ChzSignerTaskFail,
  ): Promise<void> {
    await this.tasks.fail(req.tenantId!, req.signerAgentId!, id, body);
  }
}
```

Add an OpenAPI security scheme for the `x-signer-token` header following how
`ApiKioskAuth()` is defined in `apps/api/src/lib/openapi.ts`, and apply it to this
controller (needed for the coverage gate).

In `signer-agents.module.ts`: add `SignerAgentTasksController` to `controllers`,
`SignerTasksService` and `SignerAgentGuard` to `providers`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @markiro/api exec vitest run test/signer-agent-tasks.e2e.test.ts test/openapi-coverage.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/tenancy/signer-agent.guard.ts apps/api/src/modules/signer-agents apps/api/test/signer-agent-tasks.e2e.test.ts
git commit -m "feat(api): signer agent auth guard and task queue endpoints"
```

---

### Task 7: Scheduler service + pg-boss cron

**Files:**

- Create: `apps/api/src/modules/signer-agents/signer-scheduler.service.ts`
- Modify: `apps/api/src/jobs/jobs.module.ts`
- Test: `apps/api/test/signer-scheduler.e2e.test.ts`

**Interfaces:**

- Consumes: tables from Task 1; `chzSignerSettingsSchema` (Task 4); `CHZ_TRUE_API_BASE_URLS`, `CHZ_TOKEN_REFRESH_LEAD_MS`, `CHZ_TASK_STALE_MS` (Task 5); `JournalService`.
- Produces: `SignerSchedulerService.run(now?: Date): Promise<void>` — the pg-boss handler. Deterministic given `now`, so tests drive it directly.

- [ ] **Step 1: Write the failing test**

`apps/api/test/signer-scheduler.e2e.test.ts` — instantiate the service directly against
the test DB (bootstrap the Nest app as in Task 5's test to get `db = ref.get(DB)` and a
paired tenant, or insert an agent row directly). Cases:

```ts
// helper: insertAgent(tenantId) — direct insert into chzSignerAgents (status active, secretHash: randomBytes hash)
// helper: setToken(tenantId, expiresAt) — upsert chzApiTokens with dummy bytea Buffers
// helper: pendingTasks(tenantId) — select tasks where status in ('pending','claimed')
// service under test: new SignerSchedulerService(db, new JournalService(db) /* match its constructor */)

it("does nothing for tenants without active agents", async () => {
  await svc.run(new Date());
  expect(await pendingTasks(tenantId)).toHaveLength(0);
});

it("enqueues a refresh task when there is no token", async () => {
  await insertAgent(tenantId);
  await svc.run(new Date());
  const tasks = await pendingTasks(tenantId);
  expect(tasks).toHaveLength(1);
  expect(tasks[0].payload.trueApiBaseUrl).toBe("https://markirovka.crpt.ru/api/v3/true-api");
});

it("does not enqueue a duplicate while a task is open", async () => {
  await insertAgent(tenantId);
  await svc.run(new Date());
  await svc.run(new Date());
  expect(await pendingTasks(tenantId)).toHaveLength(1);
});

it("skips tenants with a fresh token and fires when it nears expiry", async () => {
  await insertAgent(tenantId);
  await setToken(tenantId, new Date(Date.now() + 5 * 3600_000)); // 5h left
  await svc.run(new Date());
  expect(await pendingTasks(tenantId)).toHaveLength(0);
  await setToken(tenantId, new Date(Date.now() + 60 * 60_000)); // 60min < 90min lead
  await svc.run(new Date());
  expect(await pendingTasks(tenantId)).toHaveLength(1);
});

it("uses sandbox URL and inn from channel settings", async () => {
  await insertAgent(tenantId);
  await db
    .insert(schema.integrationChannels)
    .values({
      tenantId,
      type: "chestny_znak",
      settings: { environment: "sandbox", mchdInn: "7712345678" },
    })
    .onConflictDoUpdate({/* target (tenantId,type), set settings */});
  await svc.run(new Date());
  const [task] = await pendingTasks(tenantId);
  expect(task.payload.trueApiBaseUrl).toBe("https://markirovka.sandbox.crptech.ru/api/v3/true-api");
  expect(task.payload.inn).toBe("7712345678");
});

it("expires stale pending and claimed tasks", async () => {
  await insertAgent(tenantId);
  const [t] = await db
    .insert(schema.chzSignerTasks)
    .values({
      tenantId,
      type: "true_api_auth",
      payload: {},
      createdAt: new Date(Date.now() - 31 * 60_000),
    })
    .returning();
  await svc.run(new Date());
  const [row] = await db
    .select()
    .from(schema.chzSignerTasks)
    .where(eq(schema.chzSignerTasks.id, t.id));
  expect(row.status).toBe("expired");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @markiro/api exec vitest run test/signer-scheduler.e2e.test.ts`
Expected: FAIL — service module not found.

- [ ] **Step 3: Implement the scheduler**

`apps/api/src/modules/signer-agents/signer-scheduler.service.ts`:

```ts
import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, inArray, sql } from "drizzle-orm";
import { schema } from "@markiro/db";
import { DB, type Db } from "../../auth/auth.module";
import { chzSignerSettingsSchema } from "../integrations/channel-registry";
import { JournalService } from "../integrations/journal.service";
import {
  CHZ_CHANNEL_TYPE,
  CHZ_TASK_STALE_MS,
  CHZ_TOKEN_REFRESH_LEAD_MS,
  CHZ_TRUE_API_BASE_URLS,
} from "./chz-constants";

@Injectable()
export class SignerSchedulerService {
  private readonly logger = new Logger(SignerSchedulerService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly journal: JournalService,
  ) {}

  /** Идемпотентный проход: детерминирован относительно now — тесты дёргают напрямую. */
  async run(now: Date = new Date()): Promise<void> {
    await this.expireStaleTasks(now);
    await this.enqueueRefreshTasks(now);
  }

  private async expireStaleTasks(now: Date): Promise<void> {
    const cutoff = new Date(now.getTime() - CHZ_TASK_STALE_MS);
    const expired = await this.db
      .update(schema.chzSignerTasks)
      .set({ status: "expired" })
      .where(
        and(
          inArray(schema.chzSignerTasks.status, ["pending", "claimed"]),
          sql`coalesce(${schema.chzSignerTasks.claimedAt}, ${schema.chzSignerTasks.createdAt}) < ${cutoff}`,
        ),
      )
      .returning({ id: schema.chzSignerTasks.id, tenantId: schema.chzSignerTasks.tenantId });
    for (const task of expired) {
      await this.journal.append({
        tenantId: task.tenantId,
        channelType: CHZ_CHANNEL_TYPE,
        sessionId: null,
        direction: "local",
        outcome: "warn",
        grain: "item",
        message: "Signer task expired without an agent response",
        details: { taskId: task.id },
      });
    }
  }

  private async enqueueRefreshTasks(now: Date): Promise<void> {
    const tenants = await this.db
      .selectDistinct({ tenantId: schema.chzSignerAgents.tenantId })
      .from(schema.chzSignerAgents)
      .where(eq(schema.chzSignerAgents.status, "active"));
    for (const { tenantId } of tenants) {
      const [token] = await this.db
        .select()
        .from(schema.chzApiTokens)
        .where(eq(schema.chzApiTokens.tenantId, tenantId));

      // Деградация: токен пересёк границу истечения в последнем cron-периоде —
      // одно error-событие на переход (cron идёт каждые 15 минут).
      if (
        token &&
        token.expiresAt <= now &&
        token.expiresAt > new Date(now.getTime() - 15 * 60_000)
      ) {
        await this.journal.append({
          tenantId,
          channelType: CHZ_CHANNEL_TYPE,
          sessionId: null,
          direction: "local",
          outcome: "error",
          grain: "session",
          message: "True API token expired; signer agent has not refreshed it",
        });
      }

      const threshold = new Date(now.getTime() + CHZ_TOKEN_REFRESH_LEAD_MS);
      if (token && token.expiresAt > threshold) continue;

      const [open] = await this.db
        .select({ id: schema.chzSignerTasks.id })
        .from(schema.chzSignerTasks)
        .where(
          and(
            eq(schema.chzSignerTasks.tenantId, tenantId),
            eq(schema.chzSignerTasks.type, "true_api_auth"),
            inArray(schema.chzSignerTasks.status, ["pending", "claimed"]),
          ),
        )
        .limit(1);
      if (open) continue;

      const settings = await this.loadSettings(tenantId);
      await this.db.insert(schema.chzSignerTasks).values({
        tenantId,
        type: "true_api_auth",
        payload: {
          trueApiBaseUrl: CHZ_TRUE_API_BASE_URLS[settings.environment],
          ...(settings.mchdInn ? { inn: settings.mchdInn } : {}),
        },
      });
      this.logger.log(`Enqueued True API token refresh for tenant ${tenantId}`);
    }
  }

  private async loadSettings(
    tenantId: string,
  ): Promise<{ environment: "production" | "sandbox"; mchdInn?: string }> {
    const [channel] = await this.db
      .select({ settings: schema.integrationChannels.settings })
      .from(schema.integrationChannels)
      .where(
        and(
          eq(schema.integrationChannels.tenantId, tenantId),
          eq(schema.integrationChannels.type, CHZ_CHANNEL_TYPE),
        ),
      );
    const parsed = chzSignerSettingsSchema.safeParse(channel?.settings ?? {});
    return parsed.success ? parsed.data : { environment: "production" };
  }
}
```

- [ ] **Step 4: Wire the cron into `jobs.module.ts`**

In `apps/api/src/jobs/jobs.module.ts`, following the exact pattern of
`prune-integration-journal` (constants at `:86-87`, register at `:173-180`-style block,
startup run near `:317`):

```ts
const CHZ_SIGNER_SCHEDULER_QUEUE_NAME = "chz-signer-token-scheduler";
const CHZ_SIGNER_SCHEDULER_QUEUE_CRON = "*/15 * * * *";
```

- Import `SignerSchedulerService`, add it (and nothing else — `JournalService` is already
  a provider there) to the module's providers and inject into `PgBossService`.
- In `onModuleInit`: `createQueue` → `schedule(CHZ_SIGNER_SCHEDULER_QUEUE_NAME, CHZ_SIGNER_SCHEDULER_QUEUE_CRON)` → `work(...)` calling `this.signerScheduler.run()`; add
  one startup invocation alongside the other maintenance jobs.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @markiro/api exec vitest run test/signer-scheduler.e2e.test.ts`
Expected: PASS (6 tests). Also run the full API suite once:
`pnpm --filter @markiro/api test` — expected green.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/signer-agents/signer-scheduler.service.ts apps/api/src/jobs/jobs.module.ts apps/api/test/signer-scheduler.e2e.test.ts
git commit -m "feat(api): chz signer token refresh scheduler on pg-boss cron"
```

---

### Task 8: Admin UI — signer panel on the Chestny ZNAK channel page

**Files:**

- Modify: `apps/admin/src/pages/integrations/api.ts`
- Create: `apps/admin/src/pages/integrations/SignerAgentsPanel.tsx`
- Modify: `apps/admin/src/pages/integrations/ChannelPage.tsx:600-672` (add the branch)
- Modify: `apps/admin/src/i18n/ru.json`, `apps/admin/src/i18n/en.json`
- Test: `apps/admin/test/signer-agents-panel.test.tsx`

**Interfaces:**

- Consumes: cabinet routes from Task 5 (`GET /signer-agents`, `POST /signer-agents/pairing-code`, `POST /signer-agents/:id/revoke`); `apiFetch` from `apps/admin/src/api/client.ts`; `useCan` from `apps/admin/src/access/context.js`; components from `@markiro/ui` (`Card`, `Table`, `Button`, `StatusChip`, `ConfirmDialog`, `Alert`, `Spinner`, `EmptyState`).
- Produces: `SignerAgentsPanel` rendered on `/integrations/chestny_znak`.

- [ ] **Step 1: Write the failing test**

`apps/admin/test/signer-agents-panel.test.tsx` — follow the mocking/render pattern of
`apps/admin/test/device-pairing.test.tsx` (same QueryClient/i18n/router wrappers and
fetch-mock helper the suite already uses). Test cases:

```tsx
it("renders agents and token status", async () => {
  // mock GET /signer-agents → { agents: [{ id: "a1", name: "BUH-PC", status: "active",
  //   appVersion: "0.1.0", certThumbprint: null, certSubject: null, certInn: null,
  //   certNotAfter: null, lastSeenAt: null, createdAt: "2026-08-28T00:00:00Z" }],
  //   token: { status: "none", obtainedAt: null, expiresAt: null, certThumbprint: null } }
  render(<SignerAgentsPanel />, { wrapper });
  expect(await screen.findByText("BUH-PC")).toBeInTheDocument();
  expect(screen.getByText(/нет токена|no token/i)).toBeInTheDocument();
});

it("reveals a pairing code once after the button is pressed", async () => {
  // mock POST /signer-agents/pairing-code → { code: "01234567", expiresAt: <in 15 min> }
  render(<SignerAgentsPanel />, { wrapper });
  await userEvent.click(await screen.findByRole("button", { name: /код привязки|pairing code/i }));
  expect(await screen.findByText(/0123\s?4567/)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @markiro/admin exec vitest run test/signer-agents-panel.test.tsx`
Expected: FAIL — component not found.

- [ ] **Step 3: Add API hooks**

Append to `apps/admin/src/pages/integrations/api.ts` (types mirror
`apps/api/src/modules/signer-agents/dto.ts` — same manual-mirror convention as the rest
of the file):

```ts
export type SignerAgentStatus = "active" | "revoked";

export interface SignerAgent {
  id: string;
  name: string;
  appVersion: string | null;
  status: SignerAgentStatus;
  certThumbprint: string | null;
  certSubject: string | null;
  certInn: string | null;
  certNotAfter: string | null;
  lastSeenAt: string | null;
  createdAt: string;
}

export interface SignerTokenStatus {
  status: "none" | "active" | "expiring" | "expired";
  obtainedAt: string | null;
  expiresAt: string | null;
  certThumbprint: string | null;
}

export interface SignerAgentsOverview {
  agents: SignerAgent[];
  token: SignerTokenStatus;
}

export const signerAgentsQueryKey = ["integrations", "chestny_znak", "agents"] as const;

export function useSignerAgents() {
  return useQuery({
    queryKey: signerAgentsQueryKey,
    queryFn: () => apiFetch<SignerAgentsOverview>("/signer-agents"),
  });
}

export interface SignerPairingCodeResult {
  code: string;
  expiresAt: string;
}

// Плейнтекст-секрет: голая функция, НЕ useMutation (см. обоснование выше, :177-189).
export function issueSignerPairingCode(): Promise<SignerPairingCodeResult> {
  return apiFetch<SignerPairingCodeResult>("/signer-agents/pairing-code", {
    method: "POST",
  });
}

export function useRevokeSignerAgent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (agentId: string) =>
      apiFetch<undefined>(`/signer-agents/${agentId}/revoke`, { method: "POST" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: signerAgentsQueryKey });
    },
  });
}
```

- [ ] **Step 4: Implement the panel and wire it into `ChannelPage`**

`apps/admin/src/pages/integrations/SignerAgentsPanel.tsx`:

```tsx
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Alert,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  Spinner,
  StatusChip,
  Table,
} from "@markiro/ui";
import { useCan } from "../../access/context.js";
import { CABINET_CAPABILITY } from "@markiro/domain"; // match how ChannelPage imports capabilities
import {
  issueSignerPairingCode,
  useRevokeSignerAgent,
  useSignerAgents,
  type SignerAgent,
  type SignerPairingCodeResult,
} from "./api";

const TOKEN_CHIP_STATUS = {
  none: "neutral",
  active: "ok",
  expiring: "warn",
  expired: "error",
} as const;

export function SignerAgentsPanel() {
  const { t } = useTranslation();
  const { data, isLoading, error } = useSignerAgents();
  const canManage =
    useCan(CABINET_CAPABILITY.INTEGRATIONS_WRITE) && useCan(CABINET_CAPABILITY.CREDENTIALS_MANAGE);
  const revoke = useRevokeSignerAgent();
  const [code, setCode] = useState<SignerPairingCodeResult | null>(null);
  const [issuing, setIssuing] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<SignerAgent | null>(null);

  const issue = async () => {
    if (issuing) return;
    setIssuing(true);
    try {
      setCode(await issueSignerPairingCode());
    } finally {
      setIssuing(false);
    }
  };

  if (isLoading) return <Spinner />;
  if (error) return <Alert tone="error">{t("pages.integrations.channel.signer.loadError")}</Alert>;
  if (!data) return null;

  return (
    <Card>
      <h3>{t("pages.integrations.channel.signer.title")}</h3>
      <p>
        {t("pages.integrations.channel.signer.tokenLabel")}{" "}
        <StatusChip
          status={TOKEN_CHIP_STATUS[data.token.status]}
          label={t(`pages.integrations.channel.signer.token.${data.token.status}`)}
        />
        {data.token.expiresAt
          ? ` · ${t("pages.integrations.channel.signer.tokenExpires", {
              at: new Date(data.token.expiresAt).toLocaleString(),
            })}`
          : null}
      </p>

      {canManage ? (
        <div>
          <Button onClick={issue} disabled={issuing}>
            {t("pages.integrations.channel.signer.issueCode")}
          </Button>
          {code ? (
            <p data-testid="signer-pairing-code">
              <code>{code.code.replace(/(\d{4})(\d{4})/, "$1 $2")}</code>{" "}
              {t("pages.integrations.channel.signer.codeExpires", {
                at: new Date(code.expiresAt).toLocaleTimeString(),
              })}
            </p>
          ) : null}
        </div>
      ) : null}

      {data.agents.length === 0 ? (
        <EmptyState title={t("pages.integrations.channel.signer.empty")} />
      ) : (
        <Table>
          <thead>
            <tr>
              <th>{t("pages.integrations.channel.signer.columns.name")}</th>
              <th>{t("pages.integrations.channel.signer.columns.status")}</th>
              <th>{t("pages.integrations.channel.signer.columns.cert")}</th>
              <th>{t("pages.integrations.channel.signer.columns.lastSeen")}</th>
              {canManage ? <th /> : null}
            </tr>
          </thead>
          <tbody>
            {data.agents.map((agent) => (
              <tr key={agent.id}>
                <td>{agent.name}</td>
                <td>
                  <StatusChip
                    status={agent.status === "active" ? "ok" : "neutral"}
                    label={t(`pages.integrations.channel.signer.status.${agent.status}`)}
                  />
                </td>
                <td>{agent.certSubject ?? agent.certThumbprint ?? "—"}</td>
                <td>{agent.lastSeenAt ? new Date(agent.lastSeenAt).toLocaleString() : "—"}</td>
                {canManage ? (
                  <td>
                    {agent.status === "active" ? (
                      <Button variant="destructive" onClick={() => setRevokeTarget(agent)}>
                        {t("pages.integrations.channel.signer.revoke")}
                      </Button>
                    ) : null}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      <ConfirmDialog
        open={revokeTarget !== null}
        tone="destructive"
        entity={revokeTarget?.name ?? ""}
        busy={revoke.isPending}
        onConfirm={() => {
          if (!revokeTarget) return;
          revoke.mutate(revokeTarget.id, { onSuccess: () => setRevokeTarget(null) });
        }}
        onCancel={() => setRevokeTarget(null)}
      />
    </Card>
  );
}
```

Adjust `StatusChip`/`ConfirmDialog`/`Table` props to the actual component APIs used in
`ChannelPage.tsx` and `index.tsx` (e.g. if `StatusChip` takes `status` + `label` exactly
as in `index.tsx:87-137`, keep it; otherwise mirror the local idiom). If `useCan` cannot
be called twice conditionally, hoist both calls unconditionally (hooks rule).

In `ChannelPage.tsx`, inside the type-specific block (`:600-672`), add:

```tsx
{
  channel.type === "chestny_znak" ? <SignerAgentsPanel /> : null;
}
```

(and the import at the top).

i18n — `apps/admin/src/i18n/ru.json` (mirror the keys into `en.json` with English
copy):

```json
"signer": {
  "title": "Агент КЭП",
  "tokenLabel": "Токен True API:",
  "token": { "none": "нет токена", "active": "действует", "expiring": "истекает", "expired": "истёк" },
  "tokenExpires": "действует до {{at}}",
  "issueCode": "Получить код привязки",
  "codeExpires": "действует до {{at}}",
  "empty": "Агенты ещё не подключены. Установите приложение «Markiro Подписант» на компьютер с КЭП и введите код привязки.",
  "columns": { "name": "Компьютер", "status": "Статус", "cert": "Сертификат", "lastSeen": "Был на связи" },
  "status": { "active": "активен", "revoked": "отозван" },
  "revoke": "Отозвать",
  "loadError": "Не удалось загрузить список агентов"
}
```

Place under `pages.integrations.channel` alongside the existing `settings`/`danger`
blocks.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @markiro/admin exec vitest run test/signer-agents-panel.test.tsx`
Expected: PASS. Then the full admin suite: `pnpm --filter @markiro/admin test` and
`pnpm --filter @markiro/admin lint`.

- [ ] **Step 6: Commit**

```bash
git add apps/admin/src/pages/integrations apps/admin/src/i18n apps/admin/test/signer-agents-panel.test.tsx
git commit -m "feat(admin): chz signer agents panel on the integrations channel page"
```

---

### Task 9: Full verification pass

**Files:** none new.

- [ ] **Step 1: Run the full affected test suites**

```bash
pnpm --filter @markiro/db test
pnpm --filter @markiro/platform-contracts test
pnpm --filter @markiro/api test
pnpm --filter @markiro/admin test
```

Expected: all green (API suite runs serially — allow time).

- [ ] **Step 2: Lint and typecheck the touched packages**

```bash
pnpm --filter @markiro/api lint && pnpm --filter @markiro/admin lint
pnpm --filter @markiro/api exec tsc -p tsconfig.json --noEmit
pnpm --filter @markiro/admin typecheck
```

Expected: clean.

- [ ] **Step 3: Update the graphify graph if present**

```bash
test -f graphify-out/graph.json && graphify update . || true
```

- [ ] **Step 4: Commit any straggler fixes**

```bash
git add -A && git commit -m "chore(chz-signer): verification fixes" || echo "nothing to commit"
```

---

## Deferred to the agent-side plan (next)

- `apps/signer` Tauri tray app and the `signer-core` Rust crate (protocol client,
  CAdESCOM signing, DPAPI storage) — will consume the fixtures from Task 2 and the
  endpoints from Tasks 5–6.
- Direct True API consumption of the stored token (`cises/info` refresh jobs, dispenser
  exports) — separate design per the spec's out-of-scope list.
