import { randomUUID } from "node:crypto";
import { schema } from "@markiro/db";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { replacementExecutionHarness } from "./support/device-replacement-execution-fixture";
import { assertDeviceReplacementNewWorkAllowed } from "../src/modules/device-licensing/device-replacement-admission";

const capability = "replacement-readiness-v1";
describe.skipIf(!process.env.DATABASE_URL)("replacement capability compatibility", () => {
  const h = replacementExecutionHarness();
  it("keeps old never-polling clients prepared and admitted without creating a drain intent", async () => {
    const f = await h.fixture();
    await expect(
      h.readiness.requestDrain(
        f.tenantId,
        f.prepared.preparation.id,
        { requestId: randomUUID(), expectedRevision: 1 },
        f.actor,
      ),
    ).rejects.toMatchObject({
      response: { code: "client_upgrade_required" },
      status: 409,
    });
    expect((await h.service.list(f.tenantId, f.actor)).items[0]?.preparation).toMatchObject({
      state: "prepared",
      revision: 1,
      drainEligibility: { status: "blocked", reasons: ["client_upgrade_required"] },
    });
    expect(await h.readiness.currentIntent(f.identity)).toBeNull();
    expect(
      await h.db
        .select()
        .from(schema.workingDeviceReplacementReadinessIntents)
        .where(eq(schema.workingDeviceReplacementReadinessIntents.tenantId, f.tenantId)),
    ).toEqual([]);
    await expect(
      h.db.transaction((tx) => assertDeviceReplacementNewWorkAllowed(tx, f.tenantId, f.device.id)),
    ).resolves.toBeUndefined();
  });
  it.each(["station", "handheld"] as const)(
    "requires an explicit capability from authenticated %s v1 polling",
    async (kind) => {
      const f = await h.fixture(kind);
      expect(await h.readiness.currentIntentProjection(f.identity, undefined, capability)).toEqual({
        version: 1,
        state: "none",
      });
      const listed = (await h.service.list(f.tenantId, f.actor)).items[0]?.preparation;
      expect(listed).toMatchObject({
        state: "prepared",
        drainEligibility: { status: "eligible", reasons: [] },
      });
      await expect(
        h.readiness.requestDrain(
          f.tenantId,
          f.prepared.preparation.id,
          { requestId: randomUUID(), expectedRevision: 1 },
          f.actor,
        ),
      ).resolves.toMatchObject({ preparation: { state: "draining" } });
      expect(await h.readiness.currentIntent(f.identity)).toBeNull();
      expect(
        await h.readiness.currentIntentProjection(
          f.identity,
          undefined,
          "replacement-readiness-v10",
        ),
      ).toEqual({ version: 1, state: "none" });
    },
  );
  it("bounds observed support by server time and expires it exactly at five minutes", async () => {
    const f = await h.fixture();
    const observedAt = new Date("2026-10-01T12:00:00.000Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(observedAt);
    await h.readiness.currentIntentProjection(f.identity, undefined, capability);
    const [stored] = await h.db
      .select()
      .from(schema.workingDeviceReplacementCapabilities)
      .where(eq(schema.workingDeviceReplacementCapabilities.deviceId, f.device.id));
    expect(stored).toMatchObject({
      tenantId: f.tenantId,
      deviceId: f.device.id,
      credentialEpoch: f.device.credentialEpoch,
      supported: true,
      observedAt,
      expiresAt: new Date(observedAt.getTime() + 300_000),
    });
    for (const offset of [-1, 300_000]) {
      vi.setSystemTime(new Date(observedAt.getTime() + offset));
      expect(
        (await h.service.list(f.tenantId, f.actor)).items[0]?.preparation.drainEligibility,
      ).toEqual({ status: "blocked", reasons: ["client_upgrade_required"] });
      await expect(
        h.readiness.requestDrain(
          f.tenantId,
          f.prepared.preparation.id,
          { requestId: randomUUID(), expectedRevision: 1 },
          f.actor,
        ),
      ).rejects.toMatchObject({ response: { code: "client_upgrade_required" } });
    }
  });
  it("rejects tenant/key/kind spoofing and never inherits a prior credential epoch", async () => {
    const f = await h.fixture();
    const other = await h.fixture();
    for (const identity of [
      { ...f.identity, tenantId: other.tenantId },
      { ...f.identity, apiKeyId: other.identity.apiKeyId },
      { ...f.identity, kind: "handheld" as const },
    ])
      await expect(
        h.readiness.currentIntentProjection(identity, undefined, capability),
      ).rejects.toMatchObject({ status: 401 });
    await h.readiness.currentIntentProjection(f.identity, undefined, capability);
    await h.db.insert(schema.apikey).values({
      id: "rotated-" + f.device.id,
      configId: "station",
      referenceId: f.tenantId,
      key: "test-digest",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await h.db
      .update(schema.stationDevices)
      .set({ apiKeyId: "rotated-" + f.device.id })
      .where(eq(schema.stationDevices.id, f.device.id));
    await expect(
      h.readiness.currentIntentProjection(f.identity, undefined, capability),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      h.readiness.requestDrain(
        f.tenantId,
        f.prepared.preparation.id,
        { requestId: randomUUID(), expectedRevision: 1 },
        f.actor,
      ),
    ).rejects.toMatchObject({ response: { code: "client_upgrade_required" } });
    const currentIdentity = { ...f.identity, apiKeyId: "rotated-" + f.device.id };
    await h.readiness.currentIntentProjection(currentIdentity, undefined, capability);
    const rows = await h.db
      .select()
      .from(schema.workingDeviceReplacementCapabilities)
      .where(eq(schema.workingDeviceReplacementCapabilities.deviceId, f.device.id));
    expect(rows.map((row) => row.credentialEpoch).sort()).toEqual([1, 2]);
    expect(
      (await h.service.list(f.tenantId, f.actor)).items[0]?.preparation.drainEligibility?.status,
    ).toBe("eligible");
    expect(
      (await h.service.list(other.tenantId, other.actor)).items[0]?.preparation.drainEligibility
        ?.status,
    ).toBe("blocked");
  });
  it("keeps emergency preview available for an old client with the conservative offline boundary", async () => {
    const f = await h.fixture("station", 1, true);
    await expect(
      h.execution.previewEmergency(
        f.tenantId,
        f.prepared.preparation.id,
        {
          requestId: randomUUID(),
          expectedRevision: 1,
          reason: "Source is unavailable",
        },
        f.actor,
      ),
    ).resolves.toMatchObject({ mode: "emergency" });
  });
  it("blocks normal execution after an explicit capability downgrade without clearing a saved drain", async () => {
    const f = await h.ready();
    await h.readiness.currentIntentProjection(f.identity, undefined);
    await expect(h.preview(f)).rejects.toMatchObject({
      response: { code: "client_upgrade_required" },
    });
    expect((await h.service.list(f.tenantId, f.actor)).items[0]?.preparation).toMatchObject({
      state: "draining",
      readiness: { eligibility: { status: "blocked", reasons: ["client_upgrade_required"] } },
    });
    await expect(
      h.db.transaction((tx) => assertDeviceReplacementNewWorkAllowed(tx, f.tenantId, f.device.id)),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("rechecks capability at confirmation after a normal preview without starting execution", async () => {
    const f = await h.ready();
    const preview = await h.preview(f);
    await h.readiness.currentIntentProjection(f.identity, undefined);
    await expect(
      h.execution.executeNormal(f.tenantId, f.preparation.id, preview.request, f.actor),
    ).rejects.toMatchObject({ response: { code: "client_upgrade_required" } });
    expect(
      await h.db
        .select()
        .from(schema.workingDeviceReplacementExecutions)
        .where(eq(schema.workingDeviceReplacementExecutions.tenantId, f.tenantId)),
    ).toEqual([]);
    const [device] = await h.db
      .select()
      .from(schema.stationDevices)
      .where(eq(schema.stationDevices.id, f.device.id));
    expect(device).toMatchObject({
      apiKeyId: f.identity.apiKeyId,
      credentialEpoch: f.device.credentialEpoch,
      revokedAt: null,
    });
  });
  it("records polling on an unmanaged tenant without creating a replacement or restricting work", async () => {
    const f = await h.fixture();
    const apiKeyId = randomUUID();
    await h.db.insert(schema.apikey).values({
      id: apiKeyId,
      configId: "station",
      referenceId: f.tenantId,
      key: "test-digest",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const [device] = await h.db
      .insert(schema.stationDevices)
      .values({ tenantId: f.tenantId, name: "Unchanged source", kind: "station", apiKeyId })
      .returning();
    if (!device) throw new Error("fixture");
    const identity = {
      tenantId: f.tenantId,
      deviceId: device.id,
      kind: "station" as const,
      apiKeyId,
    };
    expect(await h.readiness.currentIntentProjection(identity, undefined, capability)).toEqual({
      version: 1,
      state: "none",
    });
    expect(
      await h.db
        .select()
        .from(schema.workingDeviceReplacementPreparations)
        .where(eq(schema.workingDeviceReplacementPreparations.deviceId, device.id)),
    ).toEqual([]);
    expect(
      await h.db
        .select()
        .from(schema.workingDeviceReplacementReadinessIntents)
        .where(eq(schema.workingDeviceReplacementReadinessIntents.deviceId, device.id)),
    ).toEqual([]);
    await expect(
      h.db.transaction((tx) => assertDeviceReplacementNewWorkAllowed(tx, f.tenantId, device.id)),
    ).resolves.toBeUndefined();
  });
  it("immediately replaces earlier support when v1 capability is lost or downgraded", async () => {
    const f = await h.fixture();
    for (const header of [undefined, "replacement-boundary-v1", "replacement-readiness-v10"]) {
      await h.readiness.currentIntentProjection(f.identity, undefined, capability);
      await h.readiness.currentIntentProjection(f.identity, undefined, header);
      await expect(
        h.readiness.requestDrain(
          f.tenantId,
          f.prepared.preparation.id,
          { requestId: randomUUID(), expectedRevision: 1 },
          f.actor,
        ),
      ).rejects.toMatchObject({ response: { code: "client_upgrade_required" } });
    }
  });
});
