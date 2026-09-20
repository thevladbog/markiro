import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { applyMigrations, type SqlExecutor, type StationBundle } from "../src/lib/mirror.js";
import { ensureShiftExecutionProjection } from "../src/lib/shift-bundle.js";
import { admitTaskEntry } from "../src/lib/offline-grants/entry.js";
import type { ShiftExecutionProjection } from "../src/lib/offline-grants/semantic.js";
import { createCredentialGeneration } from "../src/lib/credential-recovery.js";

function nodeExecutor(): SqlExecutor {
  const db = new DatabaseSync(":memory:");
  return {
    async run(sql, params = []) {
      db.prepare(sql).run(...(params as never[]));
    },
    async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      return db.prepare(sql).all(...(params as never[])) as T[];
    },
  };
}

const bundle: StationBundle = {
  shift: {
    id: "s1",
    status: "active",
    mode: "aggregation",
    productId: "p1",
    productName: "Cola",
    lineId: null,
    lineName: null,
    counterpartyId: null,
    counterpartyName: null,
    ssccIssuerCounterpartyId: null,
    boxLabelTemplateId: null,
    palletLabelTemplateId: null,
    createdFrom: "station",
    stationCloseAccess: { kind: "single_device", ownerDeviceId: "device" },
    labelTemplateId: null,
    labelTemplateName: null,
    plannedQty: null,
    plannedDate: "2026-09-20",
    productionDate: "2026-09-18",
    boxCapacity: 12,
    palletBoxCapacity: null,
    palletsEnabled: false,
    openedAt: "2026-09-20T06:00:00.000Z",
    number: "SEP26-001/S",
    validationPrint: {
      mode: "none",
      verification: "none",
      templateId: null,
      snapshot: null,
      policyRevision: null,
    },
  },
  product: {
    id: "p1",
    gtin14: "04600000000015",
    name: "Cola",
    productGroup: null,
    boxCapacity: 12,
    palletBoxCapacity: null,
    status: "active",
    defaultCounterpartyId: null,
    defaultLabelTemplateId: null,
  },
  labelTemplate: null,
  boxLabelTemplate: null,
  palletLabelTemplate: null,
  counterpartyGln: null,
  operators: [],
  sscc: null,
};

describe("shift entry execution projection", () => {
  it("refreshes the reference bundle when entry finds no projection to bind", async () => {
    const exec = nodeExecutor();
    await applyMigrations(exec);
    const get = vi.fn().mockResolvedValue(bundle);

    const projection = await ensureShiftExecutionProjection({
      client: { get },
      exec,
      shiftId: "s1",
      terminalId: "device",
    });

    expect(get).toHaveBeenCalledWith("/shifts/s1/reference-bundle");
    expect(projection?.scope.shift).toMatchObject({
      id: "s1",
      productionDate: "2026-09-18",
      stationCloseOwnerDeviceId: "device",
      stationClosePolicy: "single_device",
    });
  });

  it("keeps the mirrored projection without touching the network", async () => {
    const exec = nodeExecutor();
    await applyMigrations(exec);
    const get = vi.fn().mockResolvedValue(bundle);
    await ensureShiftExecutionProjection({ client: { get }, exec, shiftId: "s1" });
    get.mockClear();

    const projection = await ensureShiftExecutionProjection({
      client: { get },
      exec,
      shiftId: "s1",
    });

    expect(get).not.toHaveBeenCalled();
    expect(projection?.taskId).toBe("s1");
  });

  it("leaves a pending box-template recovery to the operator instead of repairing it", async () => {
    const exec = nodeExecutor();
    await applyMigrations(exec);
    // The legacy shape the backfilled recovery classifies: an active
    // aggregation shift with a serial block, no box template, and a closed
    // box whose print never resolved.
    await exec.run(
      `INSERT INTO shift_mirror(id,status,mode,product_id,issuer_prefix,box_capacity)
       VALUES('s1','active','aggregation','p1','460123456',12)`,
    );
    await exec.run(
      `INSERT INTO boxes_mirror(box_id,shift_id,sscc,opened_at,closed_at,print_state,terminal_id)
       VALUES('b1','s1','046012345600000016','2026-09-20T06:00:00.000Z','2026-09-20T06:30:00.000Z','pending','device')`,
    );
    const get = vi.fn().mockResolvedValue(bundle);

    const projection = await ensureShiftExecutionProjection({
      client: { get },
      exec,
      shiftId: "s1",
      terminalId: "device",
    });

    expect(get).not.toHaveBeenCalled();
    expect(projection).toBeNull();
  });

  it("re-reads a mirrored projection when the caller forces a refresh", async () => {
    const exec = nodeExecutor();
    await applyMigrations(exec);
    const get = vi.fn().mockResolvedValue(bundle);
    await ensureShiftExecutionProjection({ client: { get }, exec, shiftId: "s1" });
    get.mockClear();
    get.mockResolvedValue({
      ...bundle,
      shift: { ...bundle.shift, stationCloseAccess: { kind: "admin_only" } },
    });

    const projection = await ensureShiftExecutionProjection({
      client: { get },
      exec,
      shiftId: "s1",
      force: true,
    });

    expect(get).toHaveBeenCalledWith("/shifts/s1/reference-bundle");
    expect(projection?.scope.shift).toMatchObject({
      stationClosePolicy: "admin_only",
      stationCloseOwnerDeviceId: null,
    });
  });

  it("keeps the mirrored projection when a forced refresh cannot run or fails", async () => {
    const exec = nodeExecutor();
    await applyMigrations(exec);
    const get = vi.fn().mockResolvedValue(bundle);
    await ensureShiftExecutionProjection({ client: { get }, exec, shiftId: "s1" });
    get.mockClear();
    get.mockRejectedValue(new Error("offline"));

    const projection = await ensureShiftExecutionProjection({
      client: { get },
      exec,
      shiftId: "s1",
      force: true,
    });

    expect(projection?.scope.shift).toMatchObject({ stationClosePolicy: "single_device" });
  });
});

const owner = {
  tenantId: "tenant",
  deviceId: "device",
  kind: "station" as const,
  credentialEpoch: 1,
};
const execution: ShiftExecutionProjection = {
  taskKind: "shift",
  taskId: "s1",
  scope: {} as ShiftExecutionProjection["scope"],
};
const entry = {
  generation: createCredentialGeneration(),
  owner,
  capability: "shift.start.v1" as const,
  eventType: "shift.scan.v1" as const,
  taskId: "s1",
  resuming: false,
};

describe("task entry admission", () => {
  const stub = (
    mode: "observe" | "strict",
    methods: Record<string, unknown> = {},
    approvedPolicy = true,
  ) => ({
    commitNewWork: vi.fn(),
    assessTaskWork: vi.fn(),
    installedMode: vi.fn().mockResolvedValue(mode),
    hasApprovedPolicy: vi.fn().mockResolvedValue(approvedPolicy),
    ...methods,
  });

  it("observes instead of blocking the floor when no projection could be bound", async () => {
    const admission = stub("observe");

    await expect(admitTaskEntry({ ...entry, admission, execution: null })).resolves.toEqual({
      allow: true,
      observe: true,
    });
    expect(admission.commitNewWork).not.toHaveBeenCalled();
  });

  it("refuses an unbound task in strict mode", async () => {
    const admission = stub("strict");

    await expect(admitTaskEntry({ ...entry, admission, execution: null })).resolves.toEqual({
      allow: false,
      reason: "execution_unavailable",
    });
  });

  it("reads the mode at the decision, not from a snapshot taken before the refresh", async () => {
    // A readiness refresh installs strict while entry waits on the network.
    const admission = stub("strict");

    await expect(admitTaskEntry({ ...entry, admission, execution: null })).resolves.toEqual({
      allow: false,
      reason: "execution_unavailable",
    });
    expect(admission.installedMode).toHaveBeenCalledOnce();
  });

  it("rebinds against a refreshed projection before judging a mismatch", async () => {
    const refreshed: ShiftExecutionProjection = { ...execution, taskId: "s1" };
    const commitNewWork = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline grant active shift mismatch"))
      .mockResolvedValueOnce({ allow: true });
    const admission = stub("strict", {
      commitNewWork,
      assessTaskWork: vi.fn().mockResolvedValue({ allow: true }),
    });
    const refreshExecution = vi.fn().mockResolvedValue(refreshed);

    await expect(
      admitTaskEntry({ ...entry, admission, execution, refreshExecution }),
    ).resolves.toEqual({ allow: true, observe: false });
    expect(refreshExecution).toHaveBeenCalledOnce();
    expect(commitNewWork).toHaveBeenCalledTimes(2);
  });

  it("refuses a mismatch that survives the refresh in strict mode", async () => {
    const admission = stub("strict", {
      commitNewWork: vi.fn().mockRejectedValue(new Error("offline grant active shift mismatch")),
    });
    const refreshExecution = vi.fn().mockResolvedValue(execution);

    await expect(
      admitTaskEntry({ ...entry, admission, execution, refreshExecution }),
    ).resolves.toEqual({ allow: false, reason: "execution_mismatch" });
    expect(refreshExecution).toHaveBeenCalledOnce();
  });

  it("observes a mismatch that survives the refresh", async () => {
    const admission = stub("observe", {
      commitNewWork: vi.fn().mockRejectedValue(new Error("offline grant active shift mismatch")),
    });

    await expect(admitTaskEntry({ ...entry, admission, execution })).resolves.toEqual({
      allow: true,
      observe: true,
    });
  });

  it("passes a bound task through and reports an observed allowance", async () => {
    const admission = stub("observe", {
      commitNewWork: vi.fn().mockResolvedValue({ allow: true, reason: "missing_grant" }),
      assessTaskWork: vi.fn().mockResolvedValue({ allow: true }),
    });

    await expect(admitTaskEntry({ ...entry, admission, execution })).resolves.toEqual({
      allow: true,
      observe: true,
    });
    expect(admission.assessTaskWork).toHaveBeenCalledOnce();
    expect(admission.installedMode).not.toHaveBeenCalled();
  });

  it("does not consume new-work authority for a resumed task", async () => {
    const admission = stub("strict", {
      assessTaskWork: vi.fn().mockResolvedValue({ allow: true }),
    });

    await expect(
      admitTaskEntry({ ...entry, admission, resuming: true, execution }),
    ).resolves.toEqual({ allow: true, observe: false });
    expect(admission.commitNewWork).not.toHaveBeenCalled();
  });

  it("stays silent when no approved policy governs the device", async () => {
    // Every station receives grant configuration; only an attached policy
    // gives the floor something to confirm.
    const admission = stub("observe", {}, false);

    await expect(admitTaskEntry({ ...entry, admission, execution: null })).resolves.toEqual({
      allow: true,
      observe: false,
    });
  });

  it("stays silent about an observed allowance when no policy is attached", async () => {
    const admission = stub(
      "observe",
      {
        commitNewWork: vi.fn().mockResolvedValue({ allow: true, reason: "missing_grant" }),
        assessTaskWork: vi.fn().mockResolvedValue({ allow: true }),
      },
      false,
    );

    await expect(admitTaskEntry({ ...entry, admission, execution })).resolves.toEqual({
      allow: true,
      observe: false,
    });
  });

  it("returns the denial reason a strict grant produced", async () => {
    const admission = stub("strict", {
      commitNewWork: vi.fn().mockResolvedValue({ allow: false, reason: "exhausted" }),
    });

    await expect(admitTaskEntry({ ...entry, admission, execution })).resolves.toEqual({
      allow: false,
      reason: "exhausted",
    });
  });
});
