import request from "supertest";
// setupWarehouseApi binds the server once through listenOnLoopback.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@markiro/db";
import { makeUnitLabelFacts, warehouseLookupResultSchema } from "@markiro/domain";
import { setupWarehouseApi, WAREHOUSE_TEST_KM } from "./support/warehouse-reprint";
const ready = Boolean(process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET);
describe.skipIf(!ready)("immutable warehouse unit label facts", () => {
  let h: Awaited<ReturnType<typeof setupWarehouseApi>>;
  beforeAll(async () => {
    h = await setupWarehouseApi();
    await h.db
      .update(schema.codeRegistry)
      .set({ terminalId: h.a.deviceId })
      .where(
        and(
          eq(schema.codeRegistry.tenantId, h.a.tenantId),
          eq(schema.codeRegistry.codeHash, h.codeHash),
        ),
      );
  });
  afterAll(async () => {
    await h?.close();
  });
  async function entry() {
    const lookup = warehouseLookupResultSchema.parse(
      (await h.lookup(h.a.apiKey, h.a.operatorId, WAREHOUSE_TEST_KM)).body,
    );
    if (lookup.status !== "found") throw new Error("fixture source missing");
    const [code] = await h.db
      .select()
      .from(schema.codes)
      .where(and(eq(schema.codes.tenantId, h.a.tenantId), eq(schema.codes.codeHash, h.codeHash)));
    if (!code) throw new Error("fixture code missing");
    return makeUnitLabelFacts({
      version: 1,
      shiftId: h.shiftId,
      codeHash: h.codeHash,
      acceptedAt: code.scannedAt.toISOString(),
      fields: { ...lookup.source.fields, "km.code": "", date: "08.10.2026", expiry: "15.10.2026" },
      dateProvenance: "saved_print_job",
    });
  }
  const send = (key: string, body: object) =>
    request(h.app.getHttpServer())
      .post("/station/warehouse-reprint/label-facts")
      .set("x-api-key", key)
      .send(body);
  it("quarantines a proven displaced occurrence without treating missing ingestion as final", async () => {
    const original = await entry();
    const { digest: _digest, ...body } = original;
    void _digest;
    const facts = makeUnitLabelFacts({ ...body, acceptedAt: "2026-10-10T01:00:00.000Z" });
    const payload = { protocol: "warehouse-label-facts-v1", operatorId: null, entries: [facts] };
    expect((await send(h.a.apiKey, payload).expect(200)).body.results).toEqual([
      { digest: facts.digest, status: "retryable" },
    ]);
    await h.db.insert(schema.codeConflicts).values({
      tenantId: h.a.tenantId,
      codeHash: h.codeHash,
      losingShiftId: h.shiftId,
      losingTerminalId: h.a.deviceId,
      losingScannedAt: new Date(facts.acceptedAt),
      winningShiftId: h.shiftId,
      winningTerminalId: h.a.deviceId,
      winningScannedAt: new Date(original.acceptedAt),
    });
    expect((await send(h.a.apiKey, payload).expect(200)).body.results).toEqual([
      { digest: facts.digest, status: "conflict" },
    ]);
  });
  it("finishes an exactly cancelled box occurrence as conflict", async () => {
    const original = await entry();
    const { digest: _digest, ...body } = original;
    void _digest;
    const facts = makeUnitLabelFacts({ ...body, acceptedAt: "2026-10-10T02:00:00.000Z" });
    const [item] = await h.db
      .select()
      .from(schema.boxItems)
      .where(
        and(eq(schema.boxItems.tenantId, h.a.tenantId), eq(schema.boxItems.codeHash, h.codeHash)),
      )
      .limit(1);
    if (!item) throw new Error("box occurrence missing");
    const [box] = await h.db.select().from(schema.boxes).where(eq(schema.boxes.id, item.boxId));
    if (!box) throw new Error("box missing");
    await h.db
      .update(schema.boxes)
      .set({ terminalId: h.a.deviceId })
      .where(eq(schema.boxes.id, item.boxId));
    const scope = and(
      eq(schema.boxItems.tenantId, h.a.tenantId),
      eq(schema.boxItems.boxId, item.boxId),
      eq(schema.boxItems.codeHash, h.codeHash),
    );
    await h.db
      .update(schema.boxItems)
      .set({ addedAt: new Date(facts.acceptedAt), removedAt: new Date() })
      .where(scope);
    try {
      expect(
        (
          await send(h.a.apiKey, {
            protocol: "warehouse-label-facts-v1",
            operatorId: null,
            entries: [facts],
          }).expect(200)
        ).body.results,
      ).toEqual([{ digest: facts.digest, status: "conflict" }]);
    } finally {
      await h.db
        .update(schema.boxItems)
        .set({ addedAt: item.addedAt, removedAt: item.removedAt })
        .where(scope);
    }
  });
  it("finishes a durable denied item only for its exact tenant, device and occurrence", async () => {
    const original = await entry();
    const { digest: _digest, ...body } = original;
    void _digest;
    const facts = makeUnitLabelFacts({ ...body, acceptedAt: "2026-10-10T03:00:00.000Z" });
    const batchId = "denied-label-fact";
    await h.db.insert(schema.syncBatches).values({
      tenantId: h.a.tenantId,
      batchId,
      terminalId: h.a.deviceId,
      payloadDigest: "a".repeat(64),
    });
    await h.db.insert(schema.stationSyncQuarantine).values({
      tenantId: h.a.tenantId,
      batchId,
      terminalId: h.a.deviceId,
      payloadDigest: "a".repeat(64),
      recordKind: "item",
      recordIndex: 0,
      shiftId: h.shiftId,
      reason: "shift_closed",
      payload: {
        shiftId: h.shiftId,
        scannedAt: facts.acceptedAt,
        code: { codeHash: facts.codeHash },
      },
    });
    expect(
      (
        await send(h.a.apiKey, {
          protocol: "warehouse-label-facts-v1",
          operatorId: null,
          entries: [facts],
        }).expect(200)
      ).body.results,
    ).toEqual([{ digest: facts.digest, status: "conflict" }]);
    const another = makeUnitLabelFacts({ ...body, acceptedAt: "2026-10-10T03:00:01.000Z" });
    expect(
      (
        await send(h.a.apiKey, {
          protocol: "warehouse-label-facts-v1",
          operatorId: null,
          entries: [another],
        }).expect(200)
      ).body.results,
    ).toEqual([{ digest: another.digest, status: "retryable" }]);
  });
  it("keeps frozen expiry in lookup after idempotent upload and product changes", async () => {
    const facts = await entry();
    const body = { protocol: "warehouse-label-facts-v1", operatorId: null, entries: [facts] };
    const response = await send(h.a.apiKey, body).expect(200);
    expect(response.body.results).toEqual([{ digest: facts.digest, status: "accepted" }]);
    await send(h.a.apiKey, body).expect(200, response.body);
    await h.db
      .update(schema.products)
      .set({ shelfLifeDays: 1 })
      .where(
        eq(
          schema.products.id,
          (await h.db.select().from(schema.shifts).where(eq(schema.shifts.id, h.shiftId)))[0]
            ?.productId ?? "00000000-0000-4000-8000-000000000000",
        ),
      );
    expect(
      (await h.lookup(h.a.apiKey, h.a.operatorId, WAREHOUSE_TEST_KM)).body.source,
    ).toMatchObject({
      fields: { date: "08.10.2026", expiry: "15.10.2026" },
      unavailableFields: [],
    });
    const audit = await h.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(
        and(
          eq(schema.tenantAuditEvents.organizationId, h.a.tenantId),
          eq(schema.tenantAuditEvents.action, "unit_label_facts.saved"),
          eq(schema.tenantAuditEvents.targetId, h.shiftId),
        ),
      );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actorUserId: null,
      targetType: "shift",
      outcome: "accepted",
      after: { deviceId: h.a.deviceId, codeHash: h.codeHash, digest: facts.digest },
    });
  });
  it("rejects overwrite and isolates foreign tenant and wrong credential", async () => {
    const facts = await entry();
    const { digest: _digest, ...original } = facts;
    void _digest;
    const changed = makeUnitLabelFacts({
      ...original,
      fields: { ...facts.fields, expiry: "16.10.2026" },
    });
    expect(
      (
        await send(h.a.apiKey, {
          protocol: "warehouse-label-facts-v1",
          operatorId: null,
          entries: [changed],
        }).expect(200)
      ).body.results[0].status,
    ).toBe("conflict");
    expect(
      (
        await send(h.b.apiKey, {
          protocol: "warehouse-label-facts-v1",
          operatorId: null,
          entries: [facts],
        }).expect(200)
      ).body.results[0].status,
    ).toBe("retryable");
    await h.a.cabinet
      .post("/station/warehouse-reprint/label-facts")
      .send({ protocol: "warehouse-label-facts-v1", operatorId: null, entries: [facts] })
      .expect(403);
  });
});
