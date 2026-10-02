import { randomUUID } from "node:crypto";
import { schema } from "@markiro/db";
import * as domain from "@markiro/domain";
import {
  receivingFinalizationSnapshotV2Schema,
  usReadinessResultSchema,
} from "@markiro/platform-contracts";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { UsTraceStore } from "../src/modules/traceability/trace/us-trace-store";
import * as evidence from "../src/modules/traceability/trace/us-readiness-evidence";
import { UsCaseStore } from "../src/modules/traceability/cases/us-case-store";
import { caseState, seedCaseBridge } from "./support/us-case-bridge-fixture";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { seedCompleteReceiving, seedReceivingTenant } from "./support/us-receiving-fixture";
import {
  finalizeFixtureShipment,
  seedShippingLifecycle,
} from "./support/us-shipping-lifecycle-fixture";

const url = process.env.US_TEST_DATABASE_URL;
const dates = { eventDateFrom: "2026-09-01", eventDateTo: "2026-09-28" };
describe.skipIf(!url)("US complete readiness assessment", () => {
  let f: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  let store: UsTraceStore;
  beforeAll(async () => {
    if (!url) throw new Error("Missing isolated URL");
    f = await createUsProfileTestDatabase(url);
    store = new UsTraceStore(f.db);
  }, 60_000);
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  afterAll(async () => {
    await f?.close();
  });

  async function state(tenant: string) {
    const result = await f.pool.query(
      `SELECT
      (SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM traceability_events x WHERE tenant_id=$1) events,
      (SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM traceability_lots x WHERE tenant_id=$1) lots,
      (SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM tenant_audit_events x WHERE organization_id=$1) audits`,
      [tenant],
    );
    return result.rows[0];
  }

  it("distinguishes empty scope from assessed zero gaps and never writes business or audit rows", async () => {
    const empty = await seedReceivingTenant(f.db);
    expect(await store.readiness(empty.tenant, empty.actor, dates)).toMatchObject({
      state: "empty",
      recordsChecked: { events: 0, lots: 0 },
      findings: [],
      counts: { error: 0, warning: 0, info: 0 },
    });
    const c = await seedShippingLifecycle(f.db);
    await finalizeFixtureShipment(c, "20");
    const before = await state(c.tenant);
    const result = await store.readiness(c.tenant, c.actor, dates);
    expect(result).toMatchObject({
      state: "assessed",
      recordsChecked: { events: 2, lots: 2 },
      findings: [],
      groups: { byCte: [], byProduct: [], bySeverity: [] },
    });
    expect(usReadinessResultSchema.safeParse(result).success).toBe(true);
    expect(await state(c.tenant)).toEqual(before);
  });

  it("projects exact event and line provenance with deterministic keys and matching totals", async () => {
    const c = await seedShippingLifecycle(f.db);
    const shipment = await finalizeFixtureShipment(c, "20");
    const first = shipment.snapshot.items[0];
    if (!first) throw new Error("Missing shipment line");
    await f.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role='replica'`);
      await tx
        .update(schema.traceabilityEvents)
        .set({
          finalizationSnapshot: {
            ...shipment.snapshot,
            documents: [],
            items: [{ ...first, quantity: null }],
          },
        })
        .where(eq(schema.traceabilityEvents.id, shipment.id));
      await tx
        .update(schema.shippingEventItems)
        .set({ quantity: null })
        .where(eq(schema.shippingEventItems.eventId, shipment.id));
    });
    const before = await state(c.tenant);
    const query = { ...dates, eventDateFrom: "2026-09-27", lotId: c.lot };
    const result = await store.readiness(c.tenant, c.actor, query);
    expect(result).toMatchObject({
      recordsChecked: { events: 1, lots: 1 },
      dependenciesChecked: 1,
      counts: { error: 2, warning: 0, info: 0 },
      groups: {
        byCte: [{ cte: "shipping", count: 2 }],
        bySeverity: [{ severity: "error", count: 2 }],
      },
    });
    expect(result.findings).toMatchObject([
      {
        code: "required_reference",
        field: "documents",
        lotId: null,
        lineSide: null,
        lineNo: null,
        eventId: shipment.id,
        links: { lotHref: null, eventHref: `/traceability/shipping/${shipment.id}` },
      },
      {
        code: "required_kde",
        field: "lines.items[1].quantity",
        lotId: c.lot,
        lineSide: "items",
        lineNo: 1,
        eventId: shipment.id,
      },
    ]);
    expect(result.groups.byProduct).toEqual(
      expect.arrayContaining([
        { productId: null, count: 1 },
        { productId: c.product, count: 1 },
      ]),
    );
    expect(new Set(result.findings.map((x) => x.key)).size).toBe(2);
    expect(result.findings.every((x) => !("lineId" in x))).toBe(true);
    await f.db
      .update(schema.products)
      .set({ name: "Renamed after finalization" })
      .where(eq(schema.products.id, c.product));
    expect((await store.readiness(c.tenant, c.actor, query)).findings).toEqual(result.findings);
    expect(await state(c.tenant)).toEqual(before);
  });

  it("derives profile from persisted authorization and isolates generic coverage rules", async () => {
    const c = await seedShippingLifecycle(f.db);
    const [row] = await f.db
      .select()
      .from(schema.traceabilityEvents)
      .where(eq(schema.traceabilityEvents.tenantId, c.tenant));
    if (!row) throw new Error("Missing receipt");
    const snapshot = receivingFinalizationSnapshotV2Schema.parse(row.finalizationSnapshot);
    await f.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role='replica'`);
      await tx
        .update(schema.traceabilityEvents)
        .set({
          finalizationSnapshot: {
            ...snapshot,
            documents: [],
            items: snapshot.items.map((line) => ({ ...line, coverage: null })),
          },
        })
        .where(eq(schema.traceabilityEvents.id, row.id));
    });
    const processor = await store.readiness(c.tenant, c.actor, dates);
    expect(processor.counts).toEqual({ error: 3, warning: 0, info: 0 });
    expect(processor.findings.map((finding) => finding.code)).toEqual([
      "required_reference",
      "coverage_unresolved",
      "coverage_unresolved",
    ]);
    await f.db
      .update(schema.traceabilityProfiles)
      .set({ code: "US_GENERIC_LOT_TRACEABILITY" })
      .where(eq(schema.traceabilityProfiles.tenantId, c.tenant));
    const generic = await store.readiness(c.tenant, c.actor, dates);
    expect(generic.scope.profileCode).toBe("US_GENERIC_LOT_TRACEABILITY");
    expect(generic.counts).toEqual({ error: 0, warning: 1, info: 0 });
    expect(generic.findings).toMatchObject([{ code: "required_reference", severity: "warning" }]);
  });

  it("uses one assessment instant and tenant civil day around UTC midnight", async () => {
    const c = await seedReceivingTenant(f.db);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-01T00:30:00.000Z"));
    const result = await store.readiness(c.tenant, c.actor, {});
    expect(result.assessedAt).toBe("2026-10-01T00:30:00.000Z");
    expect(result.scope).toMatchObject({
      eventDateFrom: "2024-10-01",
      eventDateTo: "2026-09-30",
      defaulted: true,
    });
  });

  it("keeps retained void-output lot and active case link, with a blocking historical-origin link", async () => {
    const c = await seedCaseBridge(f);
    await new UsCaseStore(f.db).link(
      c.tenant,
      c.actor,
      c.lotId,
      { operationKey: randomUUID(), ssccs: [c.codes[0]] },
      "assessment-case",
    );
    await c.store.void(
      c.tenant,
      c.actor,
      c.original.id,
      {
        operationKey: randomUUID(),
        expectedLifecycleVersion: 2,
        reason: "Withdraw synthetic origin",
      },
      "assessment-void",
    );
    const before = await caseState(f, c.tenant);
    const businessBefore = await state(c.tenant);
    const result = await store.readiness(c.tenant, c.actor, { ...dates, lotId: c.lotId });
    expect(result).toMatchObject({
      state: "assessed",
      recordsChecked: { events: 0, lots: 1 },
      counts: { error: 1, warning: 0, info: 0 },
    });
    expect(result.findings).toMatchObject([
      {
        code: "origin_gap",
        severity: "error",
        lotId: c.lotId,
        eventId: null,
        lineSide: null,
        lineNo: null,
        relatedEventId: c.original.id,
        relatedEvent: {
          type: "transformation",
          eventNumber: c.original.eventNumber,
          revision: c.original.revision,
        },
        links: {
          lotHref: `/traceability/lots/${c.lotId}`,
          relatedEventHref: `/traceability/events/${c.original.id}`,
        },
      },
    ]);
    expect(await caseState(f, c.tenant)).toEqual(before);
    expect(await state(c.tenant)).toEqual(businessBefore);
  });

  it("returns 10000 complete findings but refuses the 10001st finding without truncation", async () => {
    const c = await seedShippingLifecycle(f.db);
    const [event] = await f.db
      .select()
      .from(schema.traceabilityEvents)
      .where(eq(schema.traceabilityEvents.tenantId, c.tenant));
    if (!event) throw new Error("Missing receipt");
    const snapshot = receivingFinalizationSnapshotV2Schema.parse(event.finalizationSnapshot);
    const [root] = await f.db
      .select()
      .from(schema.receivingEventRoots)
      .where(eq(schema.receivingEventRoots.id, event.id));
    const items = await f.db
      .select()
      .from(schema.receivingEventItems)
      .where(eq(schema.receivingEventItems.eventId, event.id));
    if (!root) throw new Error("Missing root");
    // Five independent business gaps per event; structurally coherent saved child rows.
    const gaps = {
      ...snapshot,
      documents: [],
      dateReceived: null,
      locationDescription: null,
      previousSourceDescription: null,
      items: snapshot.items.map((line, i) => ({
        ...line,
        productDescription: i === 0 ? null : line.productDescription,
      })),
    };
    await f.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role='replica'`);
      await tx
        .update(schema.traceabilityEvents)
        .set({ finalizationSnapshot: gaps })
        .where(eq(schema.traceabilityEvents.id, event.id));
      for (let offset = 0; offset < 1999; offset += 250) {
        const copies = Array.from({ length: Math.min(250, 1999 - offset) }, (_, i) => ({
          id: randomUUID(),
          number: `REC-26-${100000 + offset + i}`,
        }));
        await tx.insert(schema.traceabilityEvents).values(
          copies.map(({ id, number }) => ({
            ...event,
            id,
            rootEventId: id,
            eventNumber: number,
            finalizationSnapshot: gaps,
          })),
        );
        await tx.insert(schema.receivingEventRoots).values(
          copies.map(({ id, number }) => ({
            ...root,
            id,
            currentEventId: id,
            eventNumber: number,
          })),
        );
        await tx
          .insert(schema.receivingEventItems)
          .values(copies.flatMap(({ id }) => items.map((item) => ({ ...item, eventId: id }))));
      }
    });
    const started = performance.now();
    const result = await store.readiness(c.tenant, c.actor, dates);
    expect(result.recordsChecked).toEqual({ events: 2000, lots: 2 });
    expect(result.findings).toHaveLength(10000);
    expect(result.counts).toEqual({ error: 10000, warning: 0, info: 0 });
    console.info(
      `Readiness assessment: 2000 roots / 2 lots / 10000 findings in ${(performance.now() - started).toFixed(1)}ms`,
    );
    await f.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role='replica'`);
      await tx
        .update(schema.traceabilityEvents)
        .set({
          finalizationSnapshot: {
            ...gaps,
            items: gaps.items.map((line) => ({ ...line, productDescription: null })),
          },
        })
        .where(eq(schema.traceabilityEvents.id, event.id));
    });
    const evaluate = domain.assessFrozenReadiness;
    let domainFailure: unknown;
    // Observe the real evaluator, without substituting facts or results: the API
    // must stop finding emission in the domain, not reject an oversized array later.
    vi.spyOn(domain, "assessFrozenReadiness").mockImplementation((...args) => {
      try {
        return evaluate(...args);
      } catch (error) {
        domainFailure = error;
        throw error;
      }
    });
    await expect(store.readiness(c.tenant, c.actor, dates)).rejects.toMatchObject({
      status: 503,
      response: { code: "us_readiness_scope_too_large" },
    });
    expect(domainFailure).toBeInstanceOf(domain.DomainError);
    expect(domainFailure).toMatchObject({ code: "readiness_finding_limit_exceeded" });
  }, 30_000);

  it("preserves exact draft totals with a 50-row preview and Events continuation", async () => {
    const c = await seedCompleteReceiving(f.db);
    const { UsReceivingStore } =
      await import("../src/modules/traceability/receiving/us-receiving-store");
    const receiving = new UsReceivingStore(f.db);
    for (let i = 0; i < 51; i++)
      await receiving.createDraft(
        c.tenant,
        c.actor,
        { operationKey: randomUUID(), draft: c.draft },
        `readiness-draft-${i}`,
      );
    const result = await store.readiness(c.tenant, c.actor, dates);
    expect(result).toMatchObject({
      state: "empty",
      recordsChecked: { events: 0, lots: 0 },
      findings: [],
      draftWork: { total: 51, hasMore: true, eventsHref: "/traceability/events" },
    });
    expect(result.draftWork.items).toHaveLength(50);
    expect(new Set(result.draftWork.items.map((x) => x.eventId)).size).toBe(50);
  });

  it("rejects invalid filters and hides foreign or missing explicit IDs after fresh authorization", async () => {
    const c = await seedReceivingTenant(f.db);
    const other = await seedReceivingTenant(f.db);
    for (const query of [
      { lotId: other.lot },
      { lotId: randomUUID() },
      { productId: other.product },
      { productId: randomUUID() },
    ]) {
      await expect(
        store.readiness(c.tenant, c.actor, { ...dates, ...query }),
      ).rejects.toMatchObject({ status: 404, response: { code: "us_readiness_scope_not_found" } });
    }
    for (const query of [
      { profileCode: "US_GENERIC_LOT_TRACEABILITY" },
      { eventDateFrom: "2026-09-01" },
      { lotId: "bad" },
    ])
      await expect(store.readiness(c.tenant, c.actor, query)).rejects.toMatchObject({
        status: 400,
      });
    await f.db.delete(schema.member).where(eq(schema.member.id, c.member));
    await expect(store.readiness(c.tenant, c.actor, dates)).rejects.toMatchObject({ status: 403 });
  });

  it("keeps one repeatable-read snapshot when Shipping is concurrently voided", async () => {
    const c = await seedShippingLifecycle(f.db);
    const shipment = await finalizeFixtureShipment(c, "20");
    const before = await store.readiness(c.tenant, c.actor, dates);
    const read = evidence.readUsReadinessEvidence;
    let observedIsolation = "";
    vi.spyOn(evidence, "readUsReadinessEvidence").mockImplementationOnce(
      async (tx, tenantId, scope) => {
        const isolation = await tx.execute<{ transaction_isolation: string }>(
          sql`SHOW transaction_isolation`,
        );
        observedIsolation = isolation.rows[0]?.transaction_isolation ?? "";
        if (!shipment.lifecycle) throw new Error("Missing lifecycle");
        await c.store.void(
          c.tenant,
          c.actor,
          shipment.id,
          {
            operationKey: randomUUID(),
            expectedLifecycleVersion: shipment.lifecycle.lifecycleVersion,
            reason: "Synthetic concurrent cancellation",
          },
          "readiness-concurrent-void",
        );
        return read(tx, tenantId, scope);
      },
    );
    const during = await store.readiness(c.tenant, c.actor, dates);
    expect(observedIsolation).toBe("repeatable read");
    expect(during.recordsChecked).toEqual(before.recordsChecked);
    expect(during.findings).toEqual(before.findings);
    expect((await store.readiness(c.tenant, c.actor, dates)).recordsChecked.events).toBe(1);
  });

  it("does not misclassify unrelated evaluator failures as a scope overflow", async () => {
    const c = await seedShippingLifecycle(f.db);
    for (const error of [
      new domain.DomainError("other_rule_failure", "Private diagnostic"),
      Object.assign(new Error("Private diagnostic"), { code: "readiness_finding_limit_exceeded" }),
    ]) {
      vi.spyOn(domain, "assessFrozenReadiness").mockImplementationOnce(() => {
        throw error;
      });
      await expect(store.readiness(c.tenant, c.actor, dates)).rejects.toMatchObject({
        status: 503,
        response: { code: "us_database_unavailable" },
      });
      vi.restoreAllMocks();
    }
  });

  it("returns sanitized 503 for corrupt snapshots and actual storage timeouts", async () => {
    const c = await seedShippingLifecycle(f.db);
    const holder = await f.pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("LOCK TABLE traceability_events IN ACCESS EXCLUSIVE MODE");
      await expect(store.readiness(c.tenant, c.actor, dates)).rejects.toMatchObject({
        status: 503,
        response: { code: "us_database_unavailable" },
      });
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
    await f.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role='replica'`);
      await tx
        .update(schema.traceabilityEvents)
        .set({ finalizationSnapshot: { secret: "Never emit raw snapshot contents" } })
        .where(eq(schema.traceabilityEvents.tenantId, c.tenant));
    });
    await expect(store.readiness(c.tenant, c.actor, dates)).rejects.toMatchObject({
      status: 503,
      response: { code: "us_database_unavailable" },
    });
  }, 10_000);
});
