import { randomUUID } from "node:crypto";
import { createDb, schema } from "@markiro/db";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";
import { DeviceReplacementExecutionRepairService } from "../src/modules/device-licensing/device-replacement-execution-repair.service";
import { replacementExecutionHarness } from "./support/device-replacement-execution-fixture";

describe.skipIf(!process.env.DATABASE_URL)("durable replacement repair scheduling", () => {
  const h = replacementExecutionHarness();
  const executions = schema.workingDeviceReplacementExecutions;

  beforeEach(() => {
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
  });

  async function persisted(tenantId: string) {
    const [row] = await h.db.select().from(executions).where(eq(executions.tenantId, tenantId));
    if (!row) throw new Error("Missing execution");
    return row;
  }

  async function committed() {
    const f = await h.ready();
    const p = await h.preview(f);
    const revoke = vi.spyOn(h.db, "delete").mockImplementationOnce(() => {
      throw new Error("interrupted revoke");
    });
    await expect(
      h.execution.executeNormal(f.tenantId, f.preparation.id, p.request, f.actor),
    ).rejects.toThrow("interrupted revoke");
    revoke.mockRestore();
    return f;
  }

  it("persists due times across connections, retries only when due, and caps exponential backoff", async () => {
    const f = await committed();
    let now = new Date();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    const attempt = vi
      .spyOn(h.execution, "repairExecution")
      .mockRejectedValue(new Error("retry later"));
    expect(await persisted(f.tenantId)).toMatchObject({
      repairAttempts: 0,
      lastRepairAt: null,
      nextRepairAt: null,
    });
    await h.repair.repairPending();
    const first = await persisted(f.tenantId);
    expect(first).toMatchObject({
      repairAttempts: 1,
      lastRepairAt: now,
      nextRepairAt: new Date(now.getTime() + 30_000),
    });
    const databaseUrl = h.connection.pool.options.connectionString;
    if (!databaseUrl) throw new Error("Missing test connection");
    const fresh = createDb(databaseUrl);
    try {
      const restarted = new DeviceReplacementExecutionRepairService(fresh.db, h.execution);
      expect(await restarted.repairPending()).toEqual([]);
      vi.setSystemTime(new Date(now.getTime() + 29_999));
      expect(await restarted.repairPending()).toEqual([]);
      for (let failure = 2; failure <= 10; failure++) {
        const prior = await persisted(f.tenantId);
        if (!prior.nextRepairAt) throw new Error("Missing retry time");
        now = prior.nextRepairAt;
        vi.setSystemTime(now);
        expect(await restarted.repairPending()).toHaveLength(1);
        const retry = await persisted(f.tenantId);
        expect(retry).toMatchObject({
          repairAttempts: failure,
          lastRepairAt: now,
          nextRepairAt: new Date(now.getTime() + Math.min(3_600_000, 30_000 * 2 ** (failure - 1))),
        });
      }
      const beforeManual = await persisted(f.tenantId);
      attempt.mockRestore();
      expect(
        (await restarted.repairExecution(f.tenantId, f.preparation.id)).preparation.state,
      ).toBe("completed");
      expect(await persisted(f.tenantId)).toMatchObject({
        state: "completed",
        repairAttempts: beforeManual.repairAttempts,
        lastRepairAt: beforeManual.lastRepairAt,
        nextRepairAt: beforeManual.nextRepairAt,
      });
      expect(await restarted.repairPending()).toEqual([]);
    } finally {
      await fresh.pool.end();
    }
  });

  it("records one scheduled failure for concurrent replicas and allows concurrent manual completion", async () => {
    const f = await committed();
    const replica = new DeviceReplacementExecutionRepairService(h.db, h.execution);
    let release: () => void = () => {
      throw new Error("Barrier missing");
    };
    const both = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const attempt = vi.spyOn(h.execution, "repairExecution").mockImplementation(async () => {
      if (++calls === 2) release();
      await both;
      throw new Error("concurrent failure");
    });
    await Promise.all([h.repair.repairPending(), replica.repairPending()]);
    expect(calls).toBe(2);
    expect(await persisted(f.tenantId)).toMatchObject({ repairAttempts: 1, state: "executing" });
    attempt.mockRestore();
    const [a, b] = await Promise.all([
      h.repair.repairExecution(f.tenantId, f.preparation.id),
      replica.repairExecution(f.tenantId, f.preparation.id),
    ]);
    expect(a).toEqual(b);
    expect(await persisted(f.tenantId)).toMatchObject({ repairAttempts: 1, state: "completed" });
    expect(
      await h.db
        .select()
        .from(schema.stationDevices)
        .where(eq(schema.stationDevices.tenantId, f.tenantId)),
    ).toHaveLength(2);
  });

  it("retains committed step progress when scheduling a failed transfer", async () => {
    const f = await committed();
    await h.connection.pool.query(`
      CREATE FUNCTION task9_transfer_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.name = 'Target' THEN RAISE EXCEPTION 'transfer interrupted'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER task9_transfer_failure BEFORE INSERT ON station_devices
      FOR EACH ROW EXECUTE FUNCTION task9_transfer_failure();
    `);
    try {
      expect(await h.repair.repairPending()).toEqual([
        { executionId: expect.any(String), status: "pending" },
      ]);
      expect(await persisted(f.tenantId)).toMatchObject({
        step: "credential_revoked",
        revision: 3,
        repairAttempts: 1,
      });
      expect(
        await h.db.select().from(schema.apikey).where(eq(schema.apikey.id, f.identity.apiKeyId)),
      ).toEqual([]);
    } finally {
      await h.connection.pool.query(
        "DROP TRIGGER task9_transfer_failure ON station_devices; DROP FUNCTION task9_transfer_failure()",
      );
    }
    expect((await h.repair.repairExecution(f.tenantId, f.preparation.id)).preparation.state).toBe(
      "completed",
    );
  });

  it("does not rewrite a completed aggregate after an ambiguous successful repair", async () => {
    const f = await committed();
    const original = h.execution.repairExecution.bind(h.execution);
    const lost = vi
      .spyOn(h.execution, "repairExecution")
      .mockImplementationOnce(async (...args) => {
        await original(...args);
        throw new Error("lost completion response");
      });
    await h.repair.repairPending();
    lost.mockRestore();
    expect(await persisted(f.tenantId)).toMatchObject({
      state: "completed",
      repairAttempts: 0,
      lastRepairAt: null,
      nextRepairAt: null,
    });
    const before = await persisted(f.tenantId);
    expect(await h.repair.repairExecution(f.tenantId, f.preparation.id)).toEqual(before.response);
    expect(await persisted(f.tenantId)).toEqual(before);
  });

  it("orders an older due retry before a later never-attempted execution", async () => {
    const old = await committed();
    const fail = vi.spyOn(h.execution, "repairExecution").mockRejectedValueOnce(new Error("retry"));
    await h.repair.repairPending();
    fail.mockRestore();
    const retry = await persisted(old.tenantId);
    if (!retry.nextRepairAt) throw new Error("Missing retry time");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(retry.nextRepairAt.getTime() + 1_000));
    const later = await committed();
    expect(await h.repair.repairPending(1)).toEqual([
      { executionId: retry.id, status: "completed" },
    ]);
    expect((await persisted(later.tenantId)).state).toBe("executing");
    await h.repair.repairExecution(later.tenantId, later.preparation.id);
  });

  it("reaches a newer repairable execution behind more than 100 permanently failing rows", async () => {
    const seed = await h.fixture();
    const now = new Date();
    const rows = Array.from({ length: 101 }, () => ({
      deviceId: randomUUID(),
      previewId: randomUUID(),
      preparationId: randomUUID(),
      id: randomUUID(),
    }));
    await h.db.insert(schema.stationDevices).values(
      rows.map((r) => ({
        id: r.deviceId,
        tenantId: seed.tenantId,
        name: "Blocked source",
        kind: "station" as const,
      })),
    );
    await h.db.insert(schema.workingDeviceReplacementPreviews).values(
      rows.map((r) => ({
        id: r.previewId,
        tenantId: seed.tenantId,
        deviceId: r.deviceId,
        actorDomain: "cabinet" as const,
        actorId: seed.actor.id,
        requestId: randomUUID(),
        payload: {},
        payloadHash: "a".repeat(64),
        factsFingerprint: "a".repeat(64),
        observation: {},
        createdAt: now,
        expiresAt: new Date(now.getTime() + 60_000),
      })),
    );
    await h.db.insert(schema.workingDeviceReplacementPreparations).values(
      rows.map((r) => ({
        id: r.preparationId,
        tenantId: seed.tenantId,
        deviceId: r.deviceId,
        previewId: r.previewId,
        actorDomain: "cabinet" as const,
        actorId: seed.actor.id,
        state: "executing" as const,
        observation: seed.prepared.preparation.observation,
        factsFingerprint: "a".repeat(64),
      })),
    );
    await h.db.insert(executions).values(
      rows.map((r) => ({
        id: r.id,
        tenantId: seed.tenantId,
        deviceId: r.deviceId,
        preparationId: r.preparationId,
        actorDomain: "cabinet" as const,
        actorId: seed.actor.id,
        requestId: randomUUID(),
        requestHash: "a".repeat(64),
        factsFingerprint: "a".repeat(64),
        mode: "emergency" as const,
        sourceCredentialEpoch: 1,
        emergencyReason: "Permanent server blocker",
        recoveryState: "required" as const,
        offlineAuthorityUntil: now,
        newWorkAllowedAt: now,
        startedAt: new Date(now.getTime() - 60_000),
      })),
    );
    const good = await committed();
    const original = h.execution.repairExecution.bind(h.execution);
    vi.spyOn(h.execution, "repairExecution").mockImplementation((tenantId, preparationId) => {
      if (tenantId === seed.tenantId) return Promise.reject(new Error("permanent blocker"));
      return original(tenantId, preparationId);
    });
    expect(await h.repair.repairPending()).toHaveLength(100);
    const restarted = new DeviceReplacementExecutionRepairService(h.db, h.execution);
    const next = await restarted.repairPending();
    expect(next).toHaveLength(2);
    expect(next).toContainEqual({ executionId: expect.any(String), status: "completed" });
    expect(
      await h.db.select().from(executions).where(eq(executions.tenantId, good.tenantId)),
    ).toMatchObject([{ state: "completed", step: "transferred" }]);
    expect(
      await h.db
        .select()
        .from(schema.stationDevices)
        .where(eq(schema.stationDevices.tenantId, good.tenantId)),
    ).toHaveLength(2);
  });
});
