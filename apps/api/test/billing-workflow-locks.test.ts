import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { Db } from "@markiro/db";
import { describe, expect, it, vi } from "vitest";

import {
  acquireBillingWorkflowLocks,
  billingWorkflowResourceKeys,
  sortAndDedupeBillingLockIdentities,
} from "../src/modules/billing-workflow-locks";
import {
  beginPlatformBillingMutation,
  platformBillingPayloadHash,
} from "../src/modules/platform-billing-idempotency";

describe("billing workflow lock identities", () => {
  it("uses one global identity for global unique resources across tenants", () => {
    const first = billingWorkflowResourceKeys("tenant-a", [
      { kind: "act_number", id: "ACT-42" },
      { kind: "payment_key", id: "00000000-0000-4000-8000-000000000042" },
      { kind: "invoice_number", id: "allocator" },
      { kind: "offer_number", id: "KP-2026-000042" },
      { kind: "request", id: "10000000-0000-4000-8000-000000000042" },
    ]);
    const second = billingWorkflowResourceKeys("tenant-b", [
      { kind: "act_number", id: "ACT-42" },
      { kind: "payment_key", id: "00000000-0000-4000-8000-000000000042" },
      { kind: "invoice_number", id: "allocator" },
      { kind: "offer_number", id: "KP-2026-000042" },
      { kind: "request", id: "10000000-0000-4000-8000-000000000042" },
    ]);

    expect(first.slice(0, 4)).toEqual(second.slice(0, 4));
    expect(first[4]).not.toBe(second[4]);
    expect(first).toEqual([...first].sort());
  });

  it("sorts signed physical identities and removes a deliberate hash collision", () => {
    expect(sortAndDedupeBillingLockIdentities([9n, -2n, 9n, 1n, -2n])).toEqual([-2n, 1n, 9n]);
  });

  it("acquires two-int platform idempotency before a collision-injected bigint workflow lock", async () => {
    const dialect = new PgDialect();
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const payload = { message: "same payload" };
    const idempotencyKey = "00000000-0000-4000-8000-000000000042";
    const targetId = "10000000-0000-4000-8000-000000000042";
    const existing = {
      operation: "billing.request.comment",
      targetId,
      payloadHash: platformBillingPayloadHash(payload),
      state: "committed",
      result: { id: "result" },
    };
    const query = resolvedQuery([existing]);
    const tx = {
      execute: vi.fn(async (statement: SQL) => {
        const rendered = dialect.sqlToQuery(statement);
        queries.push(rendered);
        return rendered.sql.includes("from unnest") ? { rows: [{ identity: "42" }] } : { rows: [] };
      }),
      select: vi.fn(() => query),
      insert: vi.fn(),
      update: vi.fn(),
    } as unknown as Db;

    await beginPlatformBillingMutation(tx, {
      tenantId: "tenant-a",
      idempotencyKey,
      operation: existing.operation,
      targetId,
      payload,
      actorPlatformUserId: "actor-a",
    });
    await acquireBillingWorkflowLocks(tx, "tenant-a", [{ kind: "request", id: targetId }]);

    expect(queries).toHaveLength(3);
    expect(queries[0]).toMatchObject({
      sql: "select pg_advisory_xact_lock($1::integer, hashtext($2))",
      params: [0x42494c50, `platform-billing:tenant-a:${idempotencyKey}`],
    });
    expect(queries[1]).toMatchObject({ sql: expect.stringContaining("from unnest") });
    expect(queries[2]).toMatchObject({
      sql: "select pg_advisory_xact_lock($1::bigint)",
      params: ["42"],
    });
  });
});

function resolvedQuery<T>(rows: T[]) {
  const promise = Promise.resolve(rows);
  const query = {
    from: vi.fn(() => query),
    where: vi.fn(() => query),
    limit: vi.fn(() => promise),
  };
  return query;
}
