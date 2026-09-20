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
  it("observes instead of blocking the floor when no projection could be bound", async () => {
    const admission = {
      commitNewWork: vi.fn(),
      assessTaskWork: vi.fn(),
    };

    await expect(
      admitTaskEntry({ ...entry, admission, mode: "observe", execution: null }),
    ).resolves.toEqual({ allow: true, observe: true });
    expect(admission.commitNewWork).not.toHaveBeenCalled();
  });

  it("refuses an unbound task in strict mode", async () => {
    const admission = {
      commitNewWork: vi.fn(),
      assessTaskWork: vi.fn(),
    };

    await expect(
      admitTaskEntry({ ...entry, admission, mode: "strict", execution: null }),
    ).resolves.toEqual({ allow: false, reason: "execution_unavailable" });
  });

  it("observes a scope that no longer matches its signed grant", async () => {
    const admission = {
      commitNewWork: vi.fn().mockRejectedValue(new Error("offline grant active shift mismatch")),
      assessTaskWork: vi.fn(),
    };

    await expect(
      admitTaskEntry({ ...entry, admission, mode: "observe", execution }),
    ).resolves.toEqual({ allow: true, observe: true });
  });

  it("refuses a scope that no longer matches its signed grant in strict mode", async () => {
    const admission = {
      commitNewWork: vi.fn().mockRejectedValue(new Error("offline grant active shift mismatch")),
      assessTaskWork: vi.fn(),
    };

    await expect(
      admitTaskEntry({ ...entry, admission, mode: "strict", execution }),
    ).resolves.toEqual({ allow: false, reason: "execution_mismatch" });
  });

  it("passes a bound task through and reports an observed allowance", async () => {
    const admission = {
      commitNewWork: vi.fn().mockResolvedValue({ allow: true, reason: "missing_grant" }),
      assessTaskWork: vi.fn().mockResolvedValue({ allow: true }),
    };

    await expect(
      admitTaskEntry({ ...entry, admission, mode: "observe", execution }),
    ).resolves.toEqual({ allow: true, observe: true });
    expect(admission.assessTaskWork).toHaveBeenCalledOnce();
  });

  it("does not consume new-work authority for a resumed task", async () => {
    const admission = {
      commitNewWork: vi.fn(),
      assessTaskWork: vi.fn().mockResolvedValue({ allow: true }),
    };

    await expect(
      admitTaskEntry({ ...entry, admission, mode: "strict", resuming: true, execution }),
    ).resolves.toEqual({ allow: true, observe: false });
    expect(admission.commitNewWork).not.toHaveBeenCalled();
  });

  it("returns the denial reason a strict grant produced", async () => {
    const admission = {
      commitNewWork: vi.fn().mockResolvedValue({ allow: false, reason: "exhausted" }),
      assessTaskWork: vi.fn(),
    };

    await expect(
      admitTaskEntry({ ...entry, admission, mode: "strict", execution }),
    ).resolves.toEqual({ allow: false, reason: "exhausted" });
  });
});
