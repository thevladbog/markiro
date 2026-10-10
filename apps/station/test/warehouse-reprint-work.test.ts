import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import {
  productLabelValueDigest,
  warehouseBoxTemplate,
  buildWarehouseCodeOnlyLabelTemplate,
  WAREHOUSE_REPRINT_PROTOCOL,
  warehouseBoxSource,
  buildSscc,
  productLabelBytesDigest,
  warehouseTemplateSchema,
  type WarehouseTemplate,
  type WarehouseTemplateCatalog,
} from "@markiro/domain";
import { applyMigrations } from "../src/lib/mirror";
import { makeRotatingExec } from "./support/sqlite-exec";
import { createCredentialGeneration } from "../src/lib/credential-recovery";
import { StationApiError, type StationClient } from "../src/lib/api-client";
import { createWarehouseWork } from "../src/lib/warehouse-reprint/work";
import { warehousePreparedJobInput, seedWarehouseOperator } from "./support/warehouse-reprint";
vi.mock("../src/lib/rasterizer", () => ({
  rasterizeText: async () => ({
    width: 8,
    height: 8,
    hex: "0000000000000000",
    totalBytes: 8,
    bytesPerRow: 1,
  }),
}));

function catalogResponse(
  path: string,
  catalog: WarehouseTemplateCatalog,
  defaultBoxId: string | null = null,
) {
  const url = new URL(path, "https://station.test");
  if (url.pathname === "/shifts/box-label-templates")
    return {
      items: [],
      defaultBoxLabelTemplateId: defaultBoxId,
      defaultSource: defaultBoxId ? "organization" : null,
    };
  const ids = url.searchParams.get("ids")?.split(",");
  const templates = ids ? catalog.templates.filter((t) => ids.includes(t.id)) : catalog.templates;
  return { ...catalog, revision: productLabelValueDigest(templates), templates };
}
function changedTemplate(template: WarehouseTemplate, changes: Partial<WarehouseTemplate>) {
  const { digest, ...value } = { ...template, ...changes };
  void digest;
  return warehouseTemplateSchema.parse({ ...value, digest: productLabelValueDigest(value) });
}
async function templateWork() {
  const db = new DatabaseSync(":memory:");
  const exec = makeRotatingExec([db, db]);
  await applyMigrations(exec);
  const input = warehousePreparedJobInput();
  await seedWarehouseOperator(exec, input.operatorId);
  const box = warehouseBoxTemplate();
  const unit = changedTemplate(box, {
    id: crypto.randomUUID(),
    purpose: "product_duplicate",
    spec: buildWarehouseCodeOnlyLabelTemplate().spec,
  });
  let catalog: WarehouseTemplateCatalog = {
    protocol: WAREHOUSE_REPRINT_PROTOCOL,
    revision: productLabelValueDigest([unit, box]),
    templates: [unit, box],
  };
  let defaultBoxId: string | null = box.id;
  const get = vi.fn(async (path: string) => catalogResponse(path, catalog, defaultBoxId));
  const print = vi.fn().mockResolvedValue(undefined);
  const options = {
    exec,
    client: {
      get,
      post: vi
        .fn()
        .mockResolvedValue({ status: "found", source: warehouseBoxSource(), repair: null }),
    } as unknown as StationClient,
    generation: createCredentialGeneration("template-controller-key"),
    deviceId: input.deviceId,
    operatorId: input.operatorId,
    hardware: () => ({
      scanner: null,
      printer: input.printer.target,
      printerLanguage: "tspl" as const,
      printerDpi: 203 as const,
      verifyPrintedLabel: false,
    }),
    print,
  };
  const work = createWarehouseWork(options);
  return {
    db,
    exec,
    input,
    box,
    unit,
    get,
    print,
    work,
    options,
    setCatalog: (value: WarehouseTemplate[]) => {
      catalog = { ...catalog, templates: value, revision: productLabelValueDigest(value) };
    },
    setDefault: (id: string | null) => {
      defaultBoxId = id;
    },
  };
}

it("preselects the cabinet box default and sole enabled unit and refreshes explicit choices on reopen", async () => {
  const h = await templateWork();
  try {
    await h.work.initialize();
    expect(h.work.getSnapshot()).toMatchObject({
      defaultBoxId: h.box.id,
      session: { unitTemplate: { id: h.unit.id }, boxTemplate: { id: h.box.id } },
    });
    const other = changedTemplate(h.box, { id: crypto.randomUUID(), name: "Other box" });
    h.setCatalog([h.unit, h.box, other]);
    h.setDefault(other.id);
    await h.work.refreshCatalog();
    expect(h.work.getSnapshot().session?.boxTemplate?.id).toBe(h.box.id);
    const renamed = changedTemplate(h.box, {
      name: "Current cabinet name",
      revision: "b".repeat(64),
    });
    h.setCatalog([h.unit, renamed, other]);
    await h.work.refreshCatalog();
    expect(h.work.getSnapshot().session?.boxTemplate).toEqual(renamed);
    await h.work.close();
    const resumed = createWarehouseWork(h.options);
    await resumed.initialize();
    expect(resumed.getSnapshot().session?.boxTemplate).toEqual(renamed);
    await resumed.close();
  } finally {
    await h.work.close();
    h.db.close();
  }
});

it("checks only a fresh job's selected template and saves its current spec and digest, while reprints replay bytes", async () => {
  const h = await templateWork();
  try {
    await h.work.initialize();
    await h.work.configure("damaged", h.unit, h.box);
    await h.work.start();
    const current = changedTemplate(h.box, {
      name: "Updated cabinet label",
      revision: "c".repeat(64),
      spec: { ...h.box.spec, widthMm: h.box.spec.widthMm + 1 },
    });
    h.setCatalog([h.unit, current]);
    h.get.mockClear();
    await h.work.scan(h.input.source.identity);
    expect(h.print).toHaveBeenCalledTimes(1);
    const jobId = h.work.getSnapshot().job?.jobId;
    if (!jobId) throw new Error("job missing");
    const { readWarehouseJob } = await import("../src/lib/warehouse-reprint/store");
    const job = await readWarehouseJob(h.exec, h.work.getSnapshot().session?.owner ?? "", jobId);
    expect(job.template).toEqual(current);
    expect(job.preparedEvent.templateDigest).toBe(current.digest);
    expect(h.get.mock.calls.map(([path]) => path)).toEqual([
      `/station/warehouse-reprint/templates?ids=${h.box.id}`,
    ]);
    h.setCatalog([]);
    h.get.mockRejectedValue(new StationApiError(403, "denied"));
    await h.work.reprint("lost");
    expect(h.print).toHaveBeenCalledTimes(2);
    expect(h.print.mock.calls[1]?.[1]).toEqual(h.print.mock.calls[0]?.[1]);
    expect(h.get).toHaveBeenCalledTimes(1);
  } finally {
    await h.work.close();
    h.db.close();
  }
});

it.each([502, 503, 504])(
  "prints an authorized cached source and template during gateway failure %s",
  async (status) => {
    const h = await templateWork();
    try {
      await h.work.initialize();
      await h.work.start();
      const session = h.work.getSnapshot().session;
      if (!session) throw new Error("session missing");
      const { cacheWarehouseSource } = await import("../src/lib/warehouse-reprint/sources");
      await cacheWarehouseSource(h.exec, session.owner, warehouseBoxSource());
      vi.mocked(h.options.client.post).mockRejectedValue(new StationApiError(status, "gateway"));
      h.get.mockRejectedValue(new StationApiError(status, "gateway"));
      await h.work.scan(h.input.source.identity);
      expect(h.work.getSnapshot().error).toBeNull();
      expect(h.work.getSnapshot().job?.state).toBe("sent");
      expect(h.print).toHaveBeenCalledTimes(1);
    } finally {
      await h.work.close();
      h.db.close();
    }
  },
);

it("does not substitute retired choices when opening or cancelling selection or resuming the session", async () => {
  const h = await templateWork();
  try {
    await h.work.initialize();
    await h.work.configure("lost", h.unit, h.box);
    const nextUnit = changedTemplate(h.unit, { id: crypto.randomUUID(), name: "Different size" });
    const nextBox = changedTemplate(h.box, { id: crypto.randomUUID(), name: "New default" });
    h.setCatalog([nextUnit, nextBox]);
    h.setDefault(nextBox.id);
    await h.work.refreshCatalog();
    expect(h.work.getSnapshot().session).toMatchObject({ unitTemplate: null, boxTemplate: null });
    // Cancelling invokes no configure command. The cleared choices must survive restart.
    await h.work.close();
    const resumed = createWarehouseWork(h.options);
    try {
      await resumed.initialize();
      expect(resumed.getSnapshot().session).toMatchObject({
        unitTemplate: null,
        boxTemplate: null,
      });
      await resumed.start();
      expect(resumed.getSnapshot().error).toBe("WAREHOUSE_TEMPLATES_REQUIRED");
      expect(h.print).not.toHaveBeenCalled();
      await resumed.configure("lost", nextUnit, nextBox);
      await resumed.start();
      expect(resumed.getSnapshot().session?.status).toBe("active");
    } finally {
      await resumed.close();
    }
  } finally {
    await h.work.close();
    h.db.close();
  }
});

it.each([429, 500, "invalid"] as const)(
  "keeps the loaded catalog available when optional box defaults fail: %s",
  async (failure) => {
    const h = await templateWork();
    const normalGet = h.get.getMockImplementation();
    if (!normalGet) throw new Error("catalog implementation missing");
    h.get.mockImplementation(async (path) => {
      if (path === "/shifts/box-label-templates") {
        if (failure === "invalid")
          return { items: [], defaultBoxLabelTemplateId: "broken", defaultSource: "organization" };
        throw new StationApiError(failure, "default unavailable");
      }
      return normalGet(path);
    });
    try {
      await h.work.initialize();
      expect(h.work.getSnapshot()).toMatchObject({
        initialized: true,
        error: null,
        defaultBoxId: null,
      });
      expect(h.work.getSnapshot().catalog?.templates).toEqual([h.unit, h.box]);
      await h.work.configure("damaged", h.unit, h.box);
      await h.work.start();
      expect(h.work.getSnapshot().session?.status).toBe("active");
    } finally {
      await h.work.close();
      h.db.close();
    }
  },
);

it.each(["removed", "group", "fields", "denied"])(
  "refuses fresh printing after %s template eligibility changes",
  async (kind) => {
    const h = await templateWork();
    try {
      await h.work.initialize();
      await h.work.configure("damaged", h.unit, h.box);
      await h.work.start();
      if (kind === "removed") h.setCatalog([h.unit]);
      if (kind === "group")
        h.setCatalog([h.unit, changedTemplate(h.box, { chzProductGroupCodes: [4] })]);
      if (kind === "fields") {
        const { revision, ...source } = warehouseBoxSource();
        void revision;
        const value = { ...source, unavailableFields: ["expiry" as const] };
        vi.mocked(h.options.client.post).mockResolvedValue({
          status: "found",
          source: { ...value, revision: productLabelValueDigest(value) },
          repair: null,
        });
      }
      if (kind === "denied") h.get.mockRejectedValue(new StationApiError(403, "denied"));
      await h.work.scan(h.input.source.identity);
      expect(h.print).not.toHaveBeenCalled();
      expect(await h.exec.all("SELECT job_id FROM warehouse_reprint_jobs")).toEqual([]);
      expect(h.work.getSnapshot().error).toBe(
        kind === "removed"
          ? "WAREHOUSE_TEMPLATE_UNAVAILABLE"
          : kind === "group"
            ? "WAREHOUSE_TEMPLATE_GROUP"
            : kind === "fields"
              ? "WAREHOUSE_SOURCE_FIELDS"
              : "WAREHOUSE_OPERATION_FAILED",
      );
    } finally {
      await h.work.close();
      h.db.close();
    }
  },
);

it("retires a delayed picker refresh on close without overwriting the current template cache", async () => {
  const h = await templateWork();
  try {
    await h.work.initialize();
    const before = await h.exec.all(
      "SELECT value_json FROM warehouse_reprint_cache ORDER BY rowid",
    );
    let complete: (value: ReturnType<typeof catalogResponse>) => void = () => {};
    const response = new Promise<ReturnType<typeof catalogResponse>>((resolve) => {
      complete = resolve;
    });
    h.get.mockClear();
    h.get.mockReturnValueOnce(response);
    const refresh = h.work.refreshCatalog();
    await vi.waitFor(() => expect(h.get).toHaveBeenCalledTimes(1));
    const close = h.work.close();
    complete({
      protocol: WAREHOUSE_REPRINT_PROTOCOL,
      revision: productLabelValueDigest([]),
      templates: [],
    });
    await refresh;
    await close;
    expect(
      await h.exec.all("SELECT value_json FROM warehouse_reprint_cache ORDER BY rowid"),
    ).toEqual(before);
    expect(h.work.getSnapshot().session?.boxTemplate).toEqual(h.box);
  } finally {
    await h.work.close();
    h.db.close();
  }
});

it("remembers the last enabled unit across finished sessions while starting a new identity with the cabinet box default", async () => {
  const h = await templateWork();
  try {
    const second = changedTemplate(h.unit, { id: crypto.randomUUID(), name: "Chosen unit" });
    h.setCatalog([h.unit, second, h.box]);
    await h.work.initialize();
    await h.work.configure("lost", second, h.box);
    await h.work.start();
    await h.work.scan(h.input.source.identity);
    const original = h.work.getSnapshot().session;
    if (!original) throw new Error("session missing");
    expect(original.sentCount).toBe(1);
    expect(await h.work.finish()).toBe(true);
    const current = changedTemplate(second, {
      name: "Canonical unit after restart",
      revision: "e".repeat(64),
    });
    const cabinet = changedTemplate(h.box, {
      id: crypto.randomUUID(),
      name: "New cabinet default",
    });
    h.setCatalog([h.unit, current, h.box, cabinet]);
    h.setDefault(cabinet.id);
    const { saveWarehouseSession } = await import("../src/lib/warehouse-reprint/store");
    await saveWarehouseSession(h.exec, {
      ...original,
      owner: "unrelated-credential-owner",
      sessionId: crypto.randomUUID(),
      unitTemplate: h.unit,
    });
    const fresh = createWarehouseWork(h.options);
    try {
      await fresh.initialize();
      expect(fresh.getSnapshot().session).toMatchObject({
        reason: "damaged",
        status: "paused",
        sentCount: 0,
        unitTemplate: current,
        boxTemplate: cabinet,
      });
      expect(fresh.getSnapshot().session?.sessionId).not.toBe(original.sessionId);
      expect(fresh.getSnapshot().job).toBeNull();
    } finally {
      await fresh.close();
    }
  } finally {
    await h.work.close();
    h.db.close();
  }
});

it("treats the newest finished session as a barrier to older paused sessions and remembers only its template preference", async () => {
  const h = await templateWork();
  try {
    const second = changedTemplate(h.unit, { id: crypto.randomUUID(), name: "Latest unit choice" });
    h.setCatalog([h.unit, second, h.box]);
    await h.work.initialize();
    await h.work.configure("damaged", h.unit, h.box);
    const older = h.work.getSnapshot().session;
    if (!older) throw new Error("older session missing");
    await h.work.newSession();
    await h.work.configure("lost", second, h.box);
    const latest = h.work.getSnapshot().session;
    if (!latest) throw new Error("latest session missing");
    expect(latest.sessionId).not.toBe(older.sessionId);
    expect(await h.work.finish()).toBe(true);
    const fresh = createWarehouseWork(h.options);
    try {
      await fresh.initialize();
      expect(fresh.getSnapshot().session?.sessionId).not.toBe(older.sessionId);
      expect(fresh.getSnapshot().session?.sessionId).not.toBe(latest.sessionId);
      expect(fresh.getSnapshot().session).toMatchObject({
        reason: "damaged",
        sentCount: 0,
        unitTemplate: second,
      });
      expect(fresh.getSnapshot().job).toBeNull();
    } finally {
      await fresh.close();
    }
  } finally {
    await h.work.close();
    h.db.close();
  }
});

it("recovers unresolved older work ahead of a newer finished-session barrier", async () => {
  const h = await templateWork();
  try {
    await h.work.initialize();
    const older = h.work.getSnapshot().session;
    if (!older) throw new Error("older session missing");
    await h.work.newSession();
    expect(await h.work.finish()).toBe(true);
    const { prepareWarehouseJob, saveWarehouseSession, resumeWarehouseSession } =
      await import("../src/lib/warehouse-reprint/store");
    await saveWarehouseSession(h.exec, { ...older, status: "active" });
    await prepareWarehouseJob(h.exec, {
      ...h.input,
      owner: older.owner,
      sessionId: older.sessionId,
      preparedEvent: { ...h.input.preparedEvent, sessionId: older.sessionId },
    });
    expect((await resumeWarehouseSession(h.exec, older.owner))?.sessionId).toBe(older.sessionId);
  } finally {
    await h.work.close();
    h.db.close();
  }
});
it("retires delayed lookup without cache writes or printing and resumes the same identity set", async () => {
  const db = new DatabaseSync(":memory:");
  const exec = makeRotatingExec([db, db]);
  await applyMigrations(exec);
  const i = warehousePreparedJobInput();
  await seedWarehouseOperator(exec, i.operatorId);
  const box = warehouseBoxTemplate();
  const { digest, ...u } = {
    ...box,
    purpose: "product_duplicate" as const,
    id: crypto.randomUUID(),
    spec: buildWarehouseCodeOnlyLabelTemplate().spec,
  };
  void digest;
  const unit = { ...u, digest: productLabelValueDigest(u) };
  let complete: (value: unknown) => void = () => {};
  const response = new Promise((resolve) => {
    complete = resolve;
  });
  const client = {
    get: async (path: string) =>
      catalogResponse(path, {
        protocol: WAREHOUSE_REPRINT_PROTOCOL,
        revision: productLabelValueDigest([unit, box]),
        templates: [unit, box],
      }),
    post: vi.fn(() => response),
  } as unknown as StationClient;
  const print = vi.fn();
  const options = {
    exec,
    client,
    generation: createCredentialGeneration("owned-key"),
    deviceId: i.deviceId,
    operatorId: i.operatorId,
    hardware: () => ({
      scanner: null,
      printer: i.printer.target,
      printerLanguage: "tspl" as const,
      printerDpi: 203 as const,
      verifyPrintedLabel: false,
    }),
    print,
  };
  try {
    const work = createWarehouseWork(options);
    await work.initialize();
    await work.configure("damaged", unit, box);
    await work.start();
    const scan = work.scan(`!100${i.source.identity}`);
    await vi.waitFor(() => expect(client.post).toHaveBeenCalled());
    const close = work.close();
    complete({ status: "found", source: warehouseBoxSource(), repair: "legacy_tspl_fnc1_literal" });
    await scan;
    await close;
    expect(print).not.toHaveBeenCalled();
    expect(await exec.all("SELECT job_id FROM warehouse_reprint_jobs")).toEqual([]);
    expect(await exec.all("SELECT identity FROM warehouse_reprint_cache WHERE kind='box'")).toEqual(
      [],
    );
    const resumed = createWarehouseWork(options);
    await resumed.initialize();
    expect(resumed.getSnapshot().session?.sessionId).toBe(work.getSnapshot().session?.sessionId);
    const oldId = resumed.getSnapshot().session?.sessionId;
    await resumed.newSession();
    expect(resumed.getSnapshot().session?.sessionId).not.toBe(oldId);
    expect(resumed.getSnapshot().session?.sentCount).toBe(0);
    await resumed.close();
  } finally {
    db.close();
  }
});

it("polls and detects a duplicate without decoding every saved label in the session", async () => {
  const { saveWarehouseSession, prepareWarehouseJob, appendWarehouseEvent } =
    await import("../src/lib/warehouse-reprint/store");
  const db = new DatabaseSync(":memory:");
  const exec = makeRotatingExec([db, db]);
  await applyMigrations(exec);
  const i = warehousePreparedJobInput();
  await seedWarehouseOperator(exec, i.operatorId);
  const work = createWarehouseWork({
    exec,
    client: {
      get: vi.fn().mockRejectedValue(new TypeError("offline")),
      post: vi.fn(),
    } as unknown as StationClient,
    generation: createCredentialGeneration("summary-key"),
    deviceId: i.deviceId,
    operatorId: i.operatorId,
    hardware: () => ({
      scanner: null,
      printer: i.printer.target,
      printerLanguage: "tspl",
      printerDpi: 203,
      verifyPrintedLabel: false,
    }),
    print: vi.fn(),
  });
  const decode = vi.spyOn(globalThis, "atob");
  try {
    await work.initialize();
    const session = work.getSnapshot().session;
    if (!session) throw new Error("session missing");
    await saveWarehouseSession(exec, { ...session, status: "active" });
    for (let n = 1; n <= 4; n++) {
      const identity = buildSscc(3, "4600682", n);
      const { revision, ...sourceBase } = i.source;
      void revision;
      const sourceValue = {
        ...sourceBase,
        identity,
        fields: { ...sourceBase.fields, sscc: identity },
        payloadDigest: productLabelBytesDigest(new TextEncoder().encode(identity)),
      };
      const source = { ...sourceValue, revision: productLabelValueDigest(sourceValue) };
      const p = {
        ...i.preparedEvent,
        eventId: crypto.randomUUID(),
        jobId: crypto.randomUUID(),
        sessionId: session.sessionId,
        attemptId: crypto.randomUUID(),
        identity,
        sourceRevision: source.revision,
        payloadDigest: source.payloadDigest,
      };
      await prepareWarehouseJob(exec, {
        ...i,
        owner: session.owner,
        jobId: p.jobId,
        sessionId: session.sessionId,
        source,
        fields: source.fields,
        preparedEvent: p,
      });
      for (const [kind, sequence] of [
        ["sending", 2],
        ["sent", 3],
      ] as const)
        await appendWarehouseEvent(exec, session.owner, {
          kind,
          sequence,
          eventId: crypto.randomUUID(),
          jobId: p.jobId,
          sessionId: p.sessionId,
          attemptId: p.attemptId,
          operatorId: p.operatorId,
          occurredAt: p.occurredAt,
        });
    }
    decode.mockClear();
    await work.poll();
    expect(decode).not.toHaveBeenCalled();
    await work.scan(buildSscc(3, "4600682", 2));
    expect(work.getSnapshot()).toMatchObject({
      duplicate: true,
      job: { identity: "346006820000000021", state: "sent" },
    });
    expect(decode).not.toHaveBeenCalled();
    await work.close();
  } finally {
    decode.mockRestore();
    db.close();
  }
});
it("checks the current local operator roster before preparing a label", async () => {
  const db = new DatabaseSync(":memory:");
  const exec = makeRotatingExec([db, db]);
  await applyMigrations(exec);
  const i = warehousePreparedJobInput();
  await seedWarehouseOperator(exec, i.operatorId);
  const box = warehouseBoxTemplate();
  const { digest, ...v } = {
    ...box,
    purpose: "product_duplicate" as const,
    id: crypto.randomUUID(),
    spec: buildWarehouseCodeOnlyLabelTemplate().spec,
  };
  void digest;
  const unit = { ...v, digest: productLabelValueDigest(v) };
  const client = {
    get: (path: string) =>
      Promise.resolve(
        catalogResponse(path, {
          protocol: WAREHOUSE_REPRINT_PROTOCOL,
          revision: productLabelValueDigest([unit, box]),
          templates: [unit, box],
        }),
      ),
    post: vi.fn().mockResolvedValue({
      status: "found",
      source: warehouseBoxSource(),
      repair: "legacy_tspl_fnc1_literal",
    }),
  } as unknown as StationClient;
  const print = vi.fn();
  const work = createWarehouseWork({
    exec,
    client,
    generation: createCredentialGeneration("active-key"),
    deviceId: i.deviceId,
    operatorId: i.operatorId,
    hardware: () => ({
      scanner: null,
      printer: i.printer.target,
      printerLanguage: "tspl",
      printerDpi: 203,
      verifyPrintedLabel: false,
    }),
    print,
  });
  try {
    await work.initialize();
    await work.configure("damaged", unit, box);
    await work.start();
    await exec.run("UPDATE operators_mirror SET active=0");
    await work.scan(`!100${i.source.identity}`);
    expect(print).not.toHaveBeenCalled();
    expect(work.getSnapshot().error).toBe("WAREHOUSE_OPERATOR_DENIED");
    await work.close();
  } finally {
    db.close();
  }
});

it("restores retained warehouse work under a replacement key of the same device", async () => {
  const { initializeDeviceRecovery, sealDeviceRecovery, restoreDeviceRecovery } =
    await import("../src/lib/device-recovery");
  const { credentialGenerationOwnership } = await import("../src/lib/credential-recovery");
  const { saveWarehouseSession, prepareWarehouseJob, appendWarehouseEvent, readWarehouseJob } =
    await import("../src/lib/warehouse-reprint/store");
  const { cacheWarehouseSource, findWarehouseSource } =
    await import("../src/lib/warehouse-reprint/sources");
  const { syncWarehouseEvents } = await import("../src/lib/warehouse-reprint/sync");
  const { resolveWarehouseReprintScan } = await import("@markiro/domain");
  const db = new DatabaseSync(":memory:");
  const exec = makeRotatingExec([db, db]);
  await applyMigrations(exec);
  const generation = createCredentialGeneration("key-a");
  const owner = await credentialGenerationOwnership(generation);
  if (!owner) throw new Error("owner");
  const i = { ...warehousePreparedJobInput(), owner };
  const config = {
    machineId: "local",
    tenantId: "tenant",
    deviceId: i.deviceId,
    serverUrl: "https://api.example/api",
    apiKey: "key-a",
  };
  const view = await initializeDeviceRecovery(exec, config);
  if (!view.owner) throw new Error("device owner");
  await seedWarehouseOperator(exec, i.operatorId);
  await saveWarehouseSession(exec, {
    owner,
    sessionId: i.sessionId,
    operatorId: i.operatorId,
    reason: i.reason,
    status: "active",
    unitTemplate: null,
    boxTemplate: i.template,
  });
  await prepareWarehouseJob(exec, i);
  await cacheWarehouseSource(exec, owner, i.source);
  await appendWarehouseEvent(exec, owner, {
    kind: "sending",
    eventId: crypto.randomUUID(),
    jobId: i.jobId,
    sessionId: i.sessionId,
    attemptId: i.preparedEvent.attemptId,
    operatorId: i.operatorId,
    sequence: 2,
    occurredAt: i.preparedEvent.occurredAt,
  });
  await sealDeviceRecovery(exec, config, generation);
  await restoreDeviceRecovery(
    exec,
    view.owner,
    {
      deviceId: i.deviceId,
      tenantId: "tenant",
      serverUrl: config.serverUrl,
      apiKey: "key-b",
      deviceName: "Station",
      organizationName: "Org",
      operators: [],
    },
    async () => {},
  );
  await seedWarehouseOperator(exec, i.operatorId);
  const replacement = createCredentialGeneration("key-b");
  const nextOwner = await credentialGenerationOwnership(replacement);
  if (!nextOwner) throw new Error("owner");
  const client = {
    get: vi.fn().mockRejectedValue(new TypeError("offline")),
    post: vi.fn(async (_path: string, body: unknown) => {
      const input = body as { events: { eventId: string }[] };
      return {
        protocol: "warehouse-label-reprint-v1",
        acceptedEventIds: input.events.map((e) => e.eventId),
        quarantined: [],
      };
    }),
  } as unknown as StationClient;
  const print = vi.fn();
  const work = createWarehouseWork({
    exec,
    client,
    generation: replacement,
    deviceId: i.deviceId,
    operatorId: i.operatorId,
    hardware: () => ({
      scanner: null,
      printer: i.printer.target,
      printerLanguage: "tspl",
      printerDpi: 203,
      verifyPrintedLabel: false,
    }),
    print,
  });
  try {
    await work.initialize();
    expect(work.getSnapshot().session?.sessionId).toBe(i.sessionId);
    expect(work.getSnapshot().job?.state).toBe("delivery_unknown");
    expect((await readWarehouseJob(exec, nextOwner, i.jobId)).owner).toBe(owner);
    expect(
      await findWarehouseSource(
        exec,
        nextOwner,
        resolveWarehouseReprintScan(`00${i.source.identity}`),
      ),
    ).toEqual(i.source);
    await expect(readWarehouseJob(exec, "foreign-key", i.jobId)).rejects.toThrow();
    await syncWarehouseEvents(exec, client, "foreign-key", () => true);
    expect(client.post).not.toHaveBeenCalled();
    await syncWarehouseEvents(exec, client, nextOwner, () => true);
    expect(
      await exec.all("SELECT DISTINCT owner,receive_status FROM warehouse_reprint_events"),
    ).toEqual([{ owner, receive_status: "accepted" }]);
    expect(print).not.toHaveBeenCalled();
    await work.start();
    await work.scan(`00${i.source.identity}`);
    expect(work.getSnapshot().error).toBe("WAREHOUSE_RECOVERY_REQUIRED");
    await work.close();
  } finally {
    db.close();
  }
});

it("keeps quarantine acknowledgments scoped and shows later rejections while denying inactive operators", async () => {
  const { credentialGenerationOwnership } = await import("../src/lib/credential-recovery");
  const { saveWarehouseSession, prepareWarehouseJob, appendWarehouseEvent } =
    await import("../src/lib/warehouse-reprint/store");
  const db = new DatabaseSync(":memory:");
  const exec = makeRotatingExec([db, db]);
  await applyMigrations(exec);
  await applyMigrations(exec);
  const i = warehousePreparedJobInput();
  await seedWarehouseOperator(exec, i.operatorId);
  const generation = createCredentialGeneration("history-owner-test-key");
  const owner = await credentialGenerationOwnership(generation);
  if (!owner) throw new Error("fixture owner");
  const options = {
    exec,
    client: {
      get: vi.fn().mockRejectedValue(new TypeError("offline")),
    } as unknown as StationClient,
    generation,
    deviceId: i.deviceId,
    operatorId: i.operatorId,
    hardware: () => ({
      scanner: null,
      printer: i.printer.target,
      printerLanguage: "tspl" as const,
      printerDpi: 203 as const,
      verifyPrintedLabel: false,
    }),
    print: vi.fn(),
  };
  const work = createWarehouseWork(options);
  try {
    for (const scopedOwner of [owner, "foreign-owner"]) {
      await saveWarehouseSession(exec, {
        owner: scopedOwner,
        sessionId: i.sessionId,
        operatorId: i.operatorId,
        reason: i.reason,
        status: "active",
        unitTemplate: null,
        boxTemplate: i.template,
      });
      await prepareWarehouseJob(exec, { ...i, owner: scopedOwner });
    }
    await exec.run(
      "UPDATE warehouse_reprint_events SET receive_status='quarantined',rejection_code='template_mismatch'",
    );
    await work.initialize();
    expect(work.getSnapshot().historyIssue).toBe("template_mismatch");
    const originalAll = exec.all.bind(exec);
    let holdPoll = true;
    let pollRead: () => void = () => {};
    let releasePoll: () => void = () => {};
    const read = new Promise<void>((resolve) => {
      pollRead = resolve;
    });
    const held = new Promise<void>((resolve) => {
      releasePoll = resolve;
    });
    exec.all = async <T>(sql: string, params?: unknown[]) => {
      const rows = await originalAll<T>(sql, params);
      if (holdPoll && sql.startsWith("SELECT e.owner")) {
        holdPoll = false;
        pollRead();
        await held;
      }
      return rows;
    };
    const stalePoll = work.poll();
    await read;
    await work.acknowledgeHistory();
    expect(work.getSnapshot().historyIssue).toBeNull();
    releasePoll();
    await stalePoll;
    expect(work.getSnapshot().historyIssue).toBeNull();
    expect(await exec.all("SELECT owner FROM warehouse_reprint_history_acknowledgements")).toEqual([
      { owner },
    ]);
    await appendWarehouseEvent(exec, owner, {
      jobId: i.jobId,
      sessionId: i.sessionId,
      attemptId: i.preparedEvent.attemptId,
      operatorId: i.operatorId,
      occurredAt: i.preparedEvent.occurredAt,
      kind: "sending",
      sequence: 2,
      eventId: crypto.randomUUID(),
    });
    await exec.run(
      "UPDATE warehouse_reprint_events SET receive_status='quarantined',rejection_code='parent_missing' WHERE owner=? AND sequence=2",
      [owner],
    );
    await work.poll();
    expect(work.getSnapshot().historyIssue).toBe("parent_missing");
    await exec.run("UPDATE operators_mirror SET active=0 WHERE operator_id=?", [i.operatorId]);
    await work.acknowledgeHistory();
    expect(work.getSnapshot().error).toBe("WAREHOUSE_OPERATOR_DENIED");
    expect(work.getSnapshot().historyIssue).toBe("parent_missing");
    expect(
      await exec.all("SELECT event_id FROM warehouse_reprint_history_acknowledgements"),
    ).toEqual([{ event_id: i.preparedEvent.eventId }]);
    expect(await exec.all("SELECT receive_status FROM warehouse_reprint_events")).toEqual([
      { receive_status: "quarantined" },
      { receive_status: "quarantined" },
      { receive_status: "quarantined" },
    ]);
    expect(options.print).not.toHaveBeenCalled();
  } finally {
    await work.close();
    db.close();
  }
});
