import { randomUUID } from "node:crypto";
import { schema } from "@markiro/db";
import { NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { UsTraceStore } from "../src/modules/traceability/trace/us-trace-store";
import * as evidence from "../src/modules/traceability/trace/us-trace-evidence";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import {
  seedTwoByTwoGenealogy,
  seedZeroFtlGenealogy,
} from "./support/us-transformation-genealogy-fixture";
import {
  seedShippingLifecycle,
  finalizeFixtureShipment,
} from "./support/us-shipping-lifecycle-fixture";

const url = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!url)("current trace store", () => {
  let f: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  beforeAll(async () => {
    f = await createUsProfileTestDatabase(url!);
  }, 60000);
  afterAll(async () => {
    await f?.close();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns current 2-to-2 evidence and counts historical revisions once", async () => {
    const c = await seedTwoByTwoGenealogy(f);
    const result = await new UsTraceStore(f.db).read(
      c.tenant,
      c.actor,
      c.revision.snapshot.outputs[0]!.lotId,
      {},
    );
    expect(result.currentEvents.map((e) => e.id)).toEqual([c.origin.id, c.revision.id]);
    expect(result.edges.filter((e) => e.eventId === c.revision.id).map((e) => e.quantity)).toEqual([
      "500",
      "500",
      "110",
      "70",
    ]);
    expect(result.excludedSummary).toEqual({ count: 1 });
    expect(result.findings).toEqual([]);
    expect(result.completion).toEqual({ state: "complete", returnedNodes: 6, returnedEdges: 6 });
    const limited = await new UsTraceStore(f.db).read(
      c.tenant,
      c.actor,
      c.revision.snapshot.outputs[0]!.lotId,
      { maxDepth: "0" },
    );
    expect(limited.completion).toEqual({
      state: "limited",
      limit: "depth",
      returnedNodes: 1,
      returnedEdges: 0,
    });
    expect(limited.excludedSummary).toEqual({ count: 1 });
  });
  it("reports a voided origin independently of completion", async () => {
    const c = await seedZeroFtlGenealogy(f);
    const lotId = c.revision.snapshot.outputs[0]!.lotId;
    const result = await new UsTraceStore(f.db).read(c.tenant, c.actor, lotId, {});
    expect(result.findings).toEqual([{ code: "origin_gap", lotId }]);
    expect(result.completion.state).toBe("complete");
    expect(result.excludedSummary).toEqual({ count: 2 });
  });
  it("makes foreign and missing lot UUIDs indistinguishable to an authorized tenant", async () => {
    const a = await seedShippingLifecycle(f.db),
      b = await seedShippingLifecycle(f.db);
    const store = new UsTraceStore(f.db);
    await expect(store.read(b.tenant, b.actor, a.lot, {})).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(store.read(a.tenant, a.actor, b.lot, {})).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(store.read(b.tenant, b.actor, randomUUID(), {})).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect((await store.read(a.tenant, a.actor, a.lot, {})).rootLotId).toBe(a.lot);
  });
  it("keeps authorization and all traversal rounds in one snapshot during concurrent finalization", async () => {
    const c = await seedShippingLifecycle(f.db);
    const actual = evidence.readCurrentTraceFrontier;
    let finalized = false;
    vi.spyOn(evidence, "readCurrentTraceFrontier").mockImplementation(async (...args) => {
      const page = await actual(...args);
      if (!finalized) {
        finalized = true;
        await finalizeFixtureShipment(c, "20");
      }
      return page;
    });
    const store = new UsTraceStore(f.db);
    const before = await store.read(c.tenant, c.actor, c.lot, {});
    expect(before.currentEvents.map((e) => e.type)).toEqual(["receiving"]);
    expect(before.excludedSummary.count).toBe(0);
    const after = await store.read(c.tenant, c.actor, c.lot, {});
    expect(after.currentEvents.map((e) => e.type)).toEqual(["receiving", "shipping"]);
  });
  it("converts a real statement timeout to 503 without a partial result", async () => {
    const c = await seedShippingLifecycle(f.db);
    vi.spyOn(evidence, "readCurrentTraceFrontier").mockImplementation(async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout='1ms'`);
      await tx.execute(sql`SELECT pg_sleep(0.05)`);
      return { events: [], hasMore: false };
    });
    await expect(new UsTraceStore(f.db).read(c.tenant, c.actor, c.lot, {})).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
  it("reloads a revoked membership before returning evidence", async () => {
    const c = await seedShippingLifecycle(f.db);
    await f.db.delete(schema.member).where(eq(schema.member.organizationId, c.tenant));
    await expect(new UsTraceStore(f.db).read(c.tenant, c.actor, c.lot, {})).rejects.toMatchObject({
      status: 403,
    });
  });
});
