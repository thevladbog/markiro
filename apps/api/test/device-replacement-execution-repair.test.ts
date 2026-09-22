import { createDb, schema } from "@markiro/db";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { DeviceReplacementExecutionService } from "../src/modules/device-licensing/device-replacement-execution.service";
import { replacementExecutionHarness } from "./support/device-replacement-execution-fixture";

describe.skipIf(!process.env.DATABASE_URL)("replacement cutover failure windows", () => {
  const { db, connection, entitlements, audit, execution, repair, ready, preview, service } =
    replacementExecutionHarness();
  async function persisted(tenantId: string) {
    return (
      await db
        .select()
        .from(schema.workingDeviceReplacementExecutions)
        .where(eq(schema.workingDeviceReplacementExecutions.tenantId, tenantId))
    )[0];
  }
  it.each(["before_revoke", "after_revoke", "before_transfer"] as const)(
    "repairs process failure at %s without a second slot",
    async (point) => {
      const f = await ready();
      const p = await preview(f);
      const table =
        point === "before_revoke"
          ? "apikey"
          : point === "after_revoke"
            ? "working_device_replacement_executions"
            : "station_devices";
      const op =
        point === "before_revoke" ? "DELETE" : point === "after_revoke" ? "UPDATE" : "INSERT";
      const condition =
        point === "before_revoke"
          ? `OLD.id = '${f.identity.apiKeyId}'`
          : point === "after_revoke"
            ? `NEW.tenant_id = '${f.tenantId}' AND NEW.step = 'credential_revoked'`
            : `NEW.tenant_id = '${f.tenantId}' AND NEW.name = 'Target'`;
      await connection.pool.query(
        `CREATE FUNCTION task6_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${condition} THEN RAISE EXCEPTION 'simulated process failure'; END IF; RETURN ${point === "before_revoke" ? "OLD" : "NEW"}; END $$; CREATE TRIGGER task6_failure BEFORE ${op} ON ${table} FOR EACH ROW EXECUTE FUNCTION task6_fail()`,
      );
      try {
        await expect(
          execution.executeNormal(f.tenantId, f.preparation.id, p.request, f.actor),
        ).rejects.toThrow();
        expect(await persisted(f.tenantId)).toMatchObject({
          state: "executing",
          step: point === "before_transfer" ? "credential_revoked" : "revoke_pending",
          targetDeviceId: null,
        });
        expect(
          await db
            .select()
            .from(schema.stationDevices)
            .where(eq(schema.stationDevices.tenantId, f.tenantId)),
        ).toHaveLength(1);
        expect(
          await db.select().from(schema.apikey).where(eq(schema.apikey.id, f.identity.apiKeyId)),
        ).toHaveLength(point === "before_revoke" ? 1 : 0);
        expect(
          (await service.list(f.tenantId, f.actor)).items[0]?.preparation.execution,
        ).toMatchObject({ targetDeviceId: null, executedAt: null });
      } finally {
        await connection.pool.query(
          `DROP TRIGGER task6_failure ON ${table}; DROP FUNCTION task6_fail()`,
        );
      }
      const receipt = await repair.repairExecution(f.tenantId, f.preparation.id);
      expect(receipt.preparation.state).toBe("completed");
      expect(await repair.repairExecution(f.tenantId, f.preparation.id)).toEqual(receipt);
      expect(
        await execution.executeNormal(f.tenantId, f.preparation.id, p.request, f.actor),
      ).toEqual(receipt);
      expect(
        await db
          .select()
          .from(schema.stationDevices)
          .where(eq(schema.stationDevices.tenantId, f.tenantId)),
      ).toHaveLength(2);
      expect(
        await db.select().from(schema.apikey).where(eq(schema.apikey.id, f.identity.apiKeyId)),
      ).toHaveLength(0);
    },
  );
  it.each(["before_revoke", "after_revoke", "before_transfer"] as const)(
    "survives connection termination at PostgreSQL barrier %s",
    async (point) => {
      const f = await ready();
      const p = await preview(f);
      const poolError = (error: Error) => {
        expect(error.message).toBe("Connection terminated unexpectedly");
      };
      const worker = createDb(connection.pool.options.connectionString!);
      worker.pool.on("connect", (client) => client.on("error", poolError));
      const workerExecution = new DeviceReplacementExecutionService(worker.db, entitlements, audit);
      const holder = await connection.pool.connect();
      const pid = (await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!
        .pid;
      const table =
        point === "before_revoke"
          ? "apikey"
          : point === "after_revoke"
            ? "working_device_replacement_executions"
            : "station_devices";
      const operation =
        point === "before_revoke" ? "DELETE" : point === "after_revoke" ? "UPDATE" : "INSERT";
      const condition =
        point === "before_revoke"
          ? `OLD.id = '${f.identity.apiKeyId}'`
          : point === "after_revoke"
            ? `NEW.tenant_id = '${f.tenantId}' AND NEW.step = 'credential_revoked'`
            : `NEW.tenant_id = '${f.tenantId}' AND NEW.name = 'Target'`;
      await holder.query("SELECT pg_advisory_lock(606106)");
      await connection.pool.query(
        `CREATE FUNCTION task6_barrier() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${condition} THEN PERFORM pg_advisory_xact_lock(606106); END IF; RETURN ${point === "before_revoke" ? "OLD" : "NEW"}; END $$; CREATE TRIGGER task6_barrier BEFORE ${operation} ON ${table} FOR EACH ROW EXECUTE FUNCTION task6_barrier()`,
      );
      const running = workerExecution
        .executeNormal(f.tenantId, f.preparation.id, p.request, f.actor)
        .then(
          () => null,
          (error: unknown) => error,
        );
      try {
        let blockedPid: number | undefined;
        for (let attempt = 0; attempt < 200 && !blockedPid; attempt++) {
          blockedPid = (
            await connection.pool.query<{ pid: number }>(
              "SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))",
              [pid],
            )
          ).rows[0]?.pid;
          if (!blockedPid) await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(blockedPid).toBeDefined();
        expect(await persisted(f.tenantId)).toMatchObject({
          state: "executing",
          targetDeviceId: null,
        });
        expect(
          await db
            .select()
            .from(schema.stationDevices)
            .where(eq(schema.stationDevices.tenantId, f.tenantId)),
        ).toHaveLength(1);
        await connection.pool.query("SELECT pg_terminate_backend($1)", [blockedPid]);
        expect(await running).toBeInstanceOf(Error);
      } finally {
        await holder.query("SELECT pg_advisory_unlock(606106)");
        holder.release();
        await running;
        await connection.pool.query(
          `DROP TRIGGER task6_barrier ON ${table}; DROP FUNCTION task6_barrier()`,
        );
      }
      expect(
        await db.select().from(schema.apikey).where(eq(schema.apikey.id, f.identity.apiKeyId)),
      ).toHaveLength(point === "before_revoke" ? 1 : 0);
      const receipt = await repair.repairExecution(f.tenantId, f.preparation.id);
      expect(receipt.preparation.state).toBe("completed");
      expect(await repair.repairExecution(f.tenantId, f.preparation.id)).toEqual(receipt);
      await worker.pool.end();
      expect(
        await db
          .select()
          .from(schema.stationDevices)
          .where(eq(schema.stationDevices.tenantId, f.tenantId)),
      ).toHaveLength(2);
    },
  );
  it("reconciles an ambiguous transfer commit from persisted receipt", async () => {
    const f = await ready();
    const p = await preview(f);
    const original = db.transaction.bind(db);
    let calls = 0;
    const spy = vi.spyOn(db, "transaction").mockImplementation(async (...args) => {
      const result = await original(...args);
      if (++calls === 3) throw new Error("connection lost after commit");
      return result;
    });
    await expect(
      execution.executeNormal(f.tenantId, f.preparation.id, p.request, f.actor),
    ).rejects.toThrow("connection lost after commit");
    spy.mockRestore();
    const saved = await persisted(f.tenantId);
    expect(saved).toMatchObject({ state: "completed", step: "transferred" });
    expect(await repair.repairExecution(f.tenantId, f.preparation.id)).toEqual(saved?.response);
    expect(
      await db
        .select()
        .from(schema.stationDevices)
        .where(eq(schema.stationDevices.tenantId, f.tenantId)),
    ).toHaveLength(2);
  });
});
