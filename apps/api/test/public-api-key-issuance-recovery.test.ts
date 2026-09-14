import { randomUUID, createHash } from "node:crypto";
import { createDb, schema } from "@markiro/db";
import { Test } from "@nestjs/testing";
import { ServiceUnavailableException } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { AUTH, DB } from "../src/auth/auth.module";
import { ApiKeysService } from "../src/modules/api-keys/api-keys.service";
import { JournalService } from "../src/modules/integrations/journal.service";
import { EntitlementsService } from "../src/subscriptions/entitlements.service";
function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const connection = createDb(process.env.DATABASE_URL ?? "postgres://invalid");
afterAll(() => connection.pool.end());
describe.skipIf(!process.env.DATABASE_URL)("public key issuance commit recovery", () => {
  async function fixture() {
    const db = connection.db,
      tenantId = randomUUID(),
      userId = randomUUID(),
      keyId = randomUUID(),
      raw = randomUUID();
    await db
      .insert(schema.organization)
      .values({ id: tenantId, name: "Issuance recovery", slug: tenantId, createdAt: new Date() });
    await db
      .insert(schema.user)
      .values({ id: userId, name: "Issuer", email: `${userId}@example.invalid` });
    const module = await Test.createTestingModule({
      providers: [
        { provide: DB, useValue: db },
        { provide: EntitlementsService, useValue: {} },
        {
          provide: AUTH,
          useValue: {
            api: {
              createApiKey: async () => {
                await db.insert(schema.apikey).values({
                  id: keyId,
                  referenceId: tenantId,
                  configId: "public",
                  key: createHash("sha256").update(raw).digest("base64url"),
                  enabled: true,
                  metadata: JSON.stringify({ kind: "public", scopes: ["inventory.read"] }),
                  createdAt: new Date(),
                  updatedAt: new Date(),
                });
                return { id: keyId, key: raw };
              },
            },
          },
        },
        JournalService,
        ApiKeysService,
      ],
    }).compile();
    return { db, tenantId, userId, keyId, raw, service: module.get(ApiKeysService) };
  }
  async function assertCommitted(f: Awaited<ReturnType<typeof fixture>>) {
    const [key] = await f.db.select().from(schema.apikey).where(eq(schema.apikey.id, f.keyId));
    expect(key?.enabled).toBe(true);
    const audits = await f.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(
        and(
          eq(schema.tenantAuditEvents.organizationId, f.tenantId),
          eq(schema.tenantAuditEvents.targetId, f.keyId),
        ),
      );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorUserId: f.userId,
      action: "public_api_key.created",
      targetType: "public_api_key",
      targetId: f.keyId,
      outcome: "success",
      after: { keyId: f.keyId, scopes: ["inventory.read"] },
    });
    expect(JSON.stringify(audits)).not.toContain(f.raw);
    const journal = await f.db
      .select()
      .from(schema.integrationEvents)
      .where(eq(schema.integrationEvents.tenantId, f.tenantId));
    expect(journal).toHaveLength(1);
  }
  it("returns the still-held secret once when audit commit succeeded but its response was lost", async () => {
    const f = await fixture();
    const transaction = f.db.transaction.bind(f.db);
    const spy = vi.spyOn(f.db, "transaction").mockImplementationOnce(async (work, config) => {
      await transaction(work, config);
      throw new Error("committed response lost");
    });
    try {
      expect(await f.service.create(f.tenantId, f.userId, "Recovered", ["inventory.read"])).toEqual(
        { id: f.keyId, key: f.raw, scopes: ["inventory.read"] },
      );
      await assertCommitted(f);
    } finally {
      spy.mockRestore();
    }
  });
  it("waits for the original key lock before deciding whether an in-flight audit committed", async () => {
    const f = await fixture(),
      ready = deferred(),
      release = deferred();
    const transaction = f.db.transaction.bind(f.db);
    let original: Promise<unknown> | undefined;
    let originalPid = 0;
    const spy = vi.spyOn(f.db, "transaction").mockImplementationOnce(async (work, config) => {
      original = transaction(async (tx) => {
        const pid = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
        originalPid = pid.rows[0]?.pid ?? 0;
        const result = await work(tx);
        ready.resolve();
        await release.promise;
        return result;
      }, config);
      await ready.promise;
      throw new Error("original commit still in flight");
    });
    const issuance = f.service.create(f.tenantId, f.userId, "In flight", ["inventory.read"]);
    const outcome = issuance.then(
      (value) => ({ value, error: null }),
      (error) => ({ value: null, error }),
    );
    try {
      await ready.promise;
      let blocked = false;
      for (let attempt = 0; attempt < 200 && !blocked; attempt++) {
        const waiting = await connection.pool.query<{ blocked: boolean }>(
          "select exists(select 1 from pg_stat_activity where $1::int=any(pg_blocking_pids(pid))) as blocked",
          [originalPid],
        );
        blocked = waiting.rows[0]?.blocked === true;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(blocked).toBe(true);
      expect(
        await f.db
          .select()
          .from(schema.tenantAuditEvents)
          .where(eq(schema.tenantAuditEvents.targetId, f.keyId)),
      ).toHaveLength(0);
      release.resolve();
      await original;
      expect(await outcome).toEqual({
        value: { id: f.keyId, key: f.raw, scopes: ["inventory.read"] },
        error: null,
      });
      await assertCommitted(f);
    } finally {
      release.resolve();
      await original;
      await outcome;
      spy.mockRestore();
    }
  });
  it("reports uncertainty without deleting when the reconciliation lock cannot be acquired", async () => {
    const f = await fixture();
    const spy = vi
      .spyOn(f.db, "transaction")
      .mockRejectedValueOnce(new Error("initial audit transport failure"))
      .mockRejectedValueOnce(new Error("reconciliation connection unavailable"));
    try {
      await expect(
        f.service.create(f.tenantId, f.userId, "Uncertain", ["inventory.read"]),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(
        await f.db.select().from(schema.apikey).where(eq(schema.apikey.id, f.keyId)),
      ).toHaveLength(1);
      expect(
        await f.db
          .select()
          .from(schema.tenantAuditEvents)
          .where(eq(schema.tenantAuditEvents.targetId, f.keyId)),
      ).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });
});
