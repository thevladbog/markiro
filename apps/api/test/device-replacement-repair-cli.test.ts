import { describe, expect, it, vi } from "vitest";
import { schema } from "@markiro/db";
import { eq } from "drizzle-orm";
import { runReplacementRepairCli } from "../src/cli/repair-device-replacement";
import { replacementExecutionHarness } from "./support/device-replacement-execution-fixture";

it("rejects missing or malformed repair identity without exposing configuration", async () => {
  for (const argv of [
    [],
    ["tenant"],
    ["tenant", "invalid"],
    ["", "11111111-1111-4111-8111-111111111111"],
  ]) {
    const output: string[] = [];
    expect(
      await runReplacementRepairCli({ argv, env: {}, stderr: { write: (s) => output.push(s) } }),
    ).toBe(1);
    expect(output).toEqual([
      "Device replacement repair failed; verify arguments, database access and execution state.\n",
    ]);
  }
});

describe.skipIf(!process.env.DATABASE_URL)("targeted replacement repair CLI", () => {
  const h = replacementExecutionHarness();
  it("repairs only the persisted requested execution and returns the same target on retry", async () => {
    const f = await h.ready();
    const p = await h.preview(f);
    const revoke = vi.spyOn(h.db, "delete").mockImplementationOnce(() => {
      throw new Error("interrupted");
    });
    await expect(
      h.execution.executeNormal(f.tenantId, f.preparation.id, p.request, f.actor),
    ).rejects.toThrow();
    revoke.mockRestore();
    const failedRepair = vi
      .spyOn(h.repair, "repairExecution")
      .mockRejectedValueOnce(new Error("retry later"));
    await h.repair.repairPending();
    failedRepair.mockRestore();
    const [scheduled] = await h.db
      .select()
      .from(schema.workingDeviceReplacementExecutions)
      .where(eq(schema.workingDeviceReplacementExecutions.tenantId, f.tenantId));
    expect(scheduled?.nextRepairAt?.getTime()).toBeGreaterThan(Date.now());
    const url = new URL(process.env.DATABASE_URL ?? "postgres://invalid");
    const database = (
      await h.connection.pool.query<{ name: string }>("select current_database() as name")
    ).rows[0];
    if (!database) throw new Error("Database identity missing");
    url.pathname = `/${database.name}`;
    const env = { ...process.env, DATABASE_URL: url.toString() };
    const output: string[] = [];
    const options = {
      argv: [f.tenantId, f.preparation.id],
      env,
      stdout: { write: (s: string) => output.push(s) },
    };
    expect(await runReplacementRepairCli(options)).toBe(0);
    expect(await runReplacementRepairCli(options)).toBe(0);
    expect(output[0]).toBe(output[1]);
    expect(JSON.parse(output[0] ?? "null")).toEqual({
      executionId: expect.any(String),
      targetDeviceId: expect.any(String),
      status: "completed",
    });
    const prepared = await h.fixture();
    expect(
      await runReplacementRepairCli({
        ...options,
        argv: [prepared.tenantId, prepared.prepared.preparation.id],
        stderr: { write: () => undefined },
      }),
    ).toBe(1);
    expect(
      (await h.service.list(prepared.tenantId, prepared.actor)).items[0]?.preparation.state,
    ).toBe("prepared");
  });
});
