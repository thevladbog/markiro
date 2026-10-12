import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import {
  WAREHOUSE_REPRINT_PROTOCOL,
  PALLET_REPRINT_V2_PROTOCOL,
  UNIFIED_REPRINT_PROTOCOL,
  warehouseBoxSource,
  warehouseBoxTemplate,
  warehouseTemplateSchema,
  warehouseSourceSchema,
  buildWarehouseCodeOnlyLabelTemplate,
  productLabelValueDigest,
  productLabelBytesDigest,
  parseDuplicateKm,
  kmHash,
  palletDataFromLegacySource,
  type WarehouseTemplate,
} from "@markiro/domain";
import {
  thermalPalletSource,
  thermalChoice,
} from "../../../packages/domain/test/support/pallet-reprint.js";
import { applyMigrations } from "../src/lib/mirror.js";
import { makeRotatingExec } from "./support/sqlite-exec.js";
import { seedWarehouseOperator, warehousePreparedJobInput } from "./support/warehouse-reprint.js";
import { createCredentialGeneration } from "../src/lib/credential-recovery.js";
import { createStationClient } from "../src/lib/api-client.js";
import type { HardwareConfig } from "../src/lib/hardware-config.js";
import type { PrintTarget } from "../src/lib/hardware.js";
import * as workModule from "../src/lib/warehouse-reprint/work.js";
vi.mock("../src/lib/rasterizer.js", () => ({
  rasterizeText: async () => ({
    width: 8,
    height: 8,
    hex: "0000000000000000",
    totalBytes: 8,
    bytesPerRow: 1,
  }),
  rasterizeDriverText: async () => ({
    width: 8,
    height: 8,
    hex: "0000000000000000",
    totalBytes: 8,
    bytesPerRow: 1,
  }),
}));
afterEach(() => vi.unstubAllGlobals());
async function fixture(palletAvailable = true, unifiedAvailable = true) {
  const db = new DatabaseSync(":memory:"),
    exec = makeRotatingExec([db, db]);
  await applyMigrations(exec);
  const input = warehousePreparedJobInput();
  await seedWarehouseOperator(exec, input.operatorId);
  const box = warehouseBoxTemplate();
  const { digest: discarded, ...unitBody } = box;
  void discarded;
  const unit: WarehouseTemplate = warehouseTemplateSchema.parse({
    ...unitBody,
    id: "00000000-0000-4000-8000-000000000041",
    purpose: "product_duplicate",
    name: "Unit",
    spec: buildWarehouseCodeOnlyLabelTemplate().spec,
    digest: productLabelValueDigest({
      ...unitBody,
      id: "00000000-0000-4000-8000-000000000041",
      purpose: "product_duplicate",
      name: "Unit",
      spec: buildWarehouseCodeOnlyLabelTemplate().spec,
    }),
  });
  const pallet = thermalChoice(),
    palletB = {
      ...thermalChoice(),
      id: "00000000-0000-4000-8000-000000000032",
      name: "Second thermal layout",
    },
    data = palletDataFromLegacySource(thermalPalletSource());
  const raw = "010460068200001321abcDEF1234567\u001d93crypto",
    km = parseDuplicateKm(raw);
  const { revision: oldRevision, ...base } = warehouseBoxSource();
  void oldRevision;
  const unitSourceBody = {
    ...base,
    kind: "unit" as const,
    sourceId: kmHash(km),
    identity: kmHash(km),
    fields: { ...base.fields, "km.code": km.raw, sscc: "", qty: "1", "qty.boxes": "" },
    payloadDigest: productLabelBytesDigest(new TextEncoder().encode(km.raw)),
  };
  const unitSource = warehouseSourceSchema.parse({
    ...unitSourceBody,
    revision: productLabelValueDigest(unitSourceBody),
  });
  const catalog = {
    protocol: WAREHOUSE_REPRINT_PROTOCOL,
    revision: productLabelValueDigest([unit, box]),
    templates: [unit, box],
  };
  let palletCatalogChoices = [pallet, palletB];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (info: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(
        typeof info === "string" ? info : info instanceof URL ? info.href : info.url,
      );
      let response: unknown;
      if (url.pathname.endsWith("source-capabilities"))
        response = {
          protocols: palletAvailable
            ? [PALLET_REPRINT_V2_PROTOCOL, ...(unifiedAvailable ? [UNIFIED_REPRINT_PROTOCOL] : [])]
            : [],
        };
      else if (url.pathname.endsWith("pallet-templates-v2"))
        response = { protocol: PALLET_REPRINT_V2_PROTOCOL, templates: palletCatalogChoices };
      else if (url.pathname === "/shifts/box-label-templates")
        response = { items: [], defaultBoxLabelTemplateId: box.id, defaultSource: "organization" };
      else if (url.pathname.endsWith("templates")) {
        const ids = url.searchParams.get("ids")?.split(",");
        const templates = ids
          ? catalog.templates.filter((t) => ids.includes(t.id))
          : catalog.templates;
        response = { ...catalog, templates, revision: productLabelValueDigest(templates) };
      } else {
        const body: unknown = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
        if (typeof body !== "object" || body === null || !("raw" in body))
          throw new Error("Unexpected test request");
        const scanned = body.raw;
        response = url.pathname.endsWith("lookup-v3")
          ? scanned === data.sscc
            ? { status: "found", kind: "pallet", data }
            : { status: "found", kind: "box", source: warehouseBoxSource(), repair: null }
          : {
              status: "found",
              source: scanned === raw ? unitSource : warehouseBoxSource(),
              repair: null,
            };
      }
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  const hardware: HardwareConfig = {
    scanner: null,
    printer: null,
    printerLanguage: "tspl",
    printerDpi: 203,
    verifyPrintedLabel: false,
    printerRouting: {
      printers: [
        ...(["unit", "box", "pallet"] as const).map((id) => ({
          ...input.printer,
          id,
          name: id,
          target: {
            kind: "tcp" as const,
            host: `192.0.2.${id === "unit" ? 1 : id === "box" ? 2 : 3}`,
            port: 9100,
          },
        })),
      ],
      assignments: { duplicate: "unit", box: "box", pallet: "pallet" },
    },
  };
  const delivered: PrintTarget[] = [];
  const options = {
    exec,
    client: createStationClient({
      apiKey: "unified-synthetic-device-key",
      serverUrl: "https://station.test",
    }),
    generation: createCredentialGeneration("unified-synthetic-device-key"),
    deviceId: input.deviceId,
    operatorId: input.operatorId,
    hardware: () => hardware,
    print: async (target: PrintTarget) => {
      delivered.push(target);
    },
  };
  const work = workModule.createUnifiedWarehouseWork(options);
  return {
    db,
    exec,
    work,
    box,
    unit,
    pallet,
    palletB,
    data,
    raw,
    delivered,
    hardware,
    options,
    replacePalletCatalog: (choices: typeof palletCatalogChoices) => {
      palletCatalogChoices = choices;
    },
  };
}
it("starts with three templates and prints unit, box and pallet scans immediately in one session", async () => {
  const h = await fixture();
  try {
    await h.work.initialize();
    await h.work.configure("damaged", h.unit, h.box, h.pallet);
    await h.work.start();
    expect(h.work.getSnapshot().session?.status).toBe("active");
    await h.work.scan(h.raw);
    expect(h.work.getSnapshot().error).toBeNull();
    await h.work.scan(warehouseBoxSource().identity);
    expect(h.work.getSnapshot().error).toBeNull();
    await h.work.scan(h.data.sscc);
    expect(h.delivered).toEqual([
      { kind: "tcp", host: "192.0.2.1", port: 9100 },
      { kind: "tcp", host: "192.0.2.2", port: 9100 },
      { kind: "tcp", host: "192.0.2.3", port: 9100 },
    ]);
    expect(h.work.getSnapshot().session?.sentCount).toBe(3);
    expect(h.work.getSnapshot().job?.kind).toBe("pallet");
    await h.work.scan(h.data.sscc);
    expect(h.delivered).toHaveLength(3);
    expect(h.work.getSnapshot().duplicate).toBe(true);
    expect(await h.work.finish()).toBe(true);
  } finally {
    await h.work.close();
    h.db.close();
  }
});
it("does not start a new session until the pallet template is chosen", async () => {
  const h = await fixture();
  try {
    await h.work.initialize();
    await h.work.configure("damaged", h.unit, h.box, null);
    await h.work.start();
    expect(h.work.getSnapshot().session?.status).toBe("paused");
    expect(h.work.getSnapshot().error).toBe("WAREHOUSE_TEMPLATES_REQUIRED");
    expect(h.delivered).toHaveLength(0);
  } finally {
    await h.work.close();
    h.db.close();
  }
});

it("explicit repeat creates a new pallet attempt while another scan does not", async () => {
  const h = await fixture();
  try {
    await h.work.initialize();
    await h.work.configure("damaged", h.unit, h.box, h.pallet);
    await h.work.start();
    await h.work.scan(h.data.sscc);
    const first = h.work.getSnapshot().job?.jobId;
    await h.work.reprint("lost");
    expect(h.delivered).toHaveLength(2);
    expect(h.work.getSnapshot().job?.jobId).not.toBe(first);
    expect(h.work.getSnapshot().session?.sentCount).toBe(2);
    const events = await h.exec.all<{ reason: string }>(
      "SELECT json_extract(value_json,'$.reason') reason FROM warehouse_pallet_events WHERE json_extract(value_json,'$.state')='prepared' ORDER BY rowid",
    );
    expect(events.map((e) => e.reason)).toEqual(["damaged", "lost"]);
  } finally {
    await h.work.close();
    h.db.close();
  }
});

it("does not prepare or print a pallet after ownership is sealed during lookup", async () => {
  const h = await fixture();
  const { sealCredentialGeneration } = await import("../src/lib/credential-recovery.js");
  const completion: { run?: () => void } = {};
  try {
    await h.work.initialize();
    await h.work.configure("damaged", h.unit, h.box, h.pallet);
    await h.work.start();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            completion.run = () =>
              resolve(
                new Response(JSON.stringify({ status: "found", kind: "pallet", data: h.data }), {
                  status: 200,
                }),
              );
          }),
      ),
    );
    const pending = h.work.scan(h.data.sscc);
    await vi.waitFor(() => expect(completion.run).toBeTypeOf("function"));
    expect(await sealCredentialGeneration(h.options.generation)).toBe(true);
    completion.run?.();
    await pending;
    expect(h.delivered).toEqual([]);
    expect(await h.exec.all("SELECT 1 FROM warehouse_pallet_jobs")).toEqual([]);
  } finally {
    await h.work.close();
    h.db.close();
  }
});
it("restores an unknown pallet attempt in the same session and blocks an unrelated scan", async () => {
  const h = await fixture();
  let restored: ReturnType<typeof workModule.createUnifiedWarehouseWork> | null = null;
  try {
    await h.work.initialize();
    await h.work.configure("damaged", h.unit, h.box, h.pallet);
    await h.work.start();
    h.options.print = async () => {
      throw new Error("Connection lost after dispatch");
    };
    await h.work.scan(h.data.sscc);
    const first = h.work.getSnapshot().job?.jobId;
    expect(h.work.getSnapshot().job?.state).toBe("delivery_unknown");
    await h.work.close();
    restored = workModule.createUnifiedWarehouseWork(h.options);
    await restored.initialize();
    await restored.start();
    expect(restored.getSnapshot().job?.jobId).toBe(first);
    await restored.scan(h.raw);
    expect(restored.getSnapshot().error).toBe("WAREHOUSE_RECOVERY_REQUIRED");
    expect(await restored.finish()).toBe(false);
    restored.requestVerification();
    await restored.scan(`!100${h.data.sscc}`);
    expect(restored.getSnapshot().error).toBe("WAREHOUSE_VERIFY_MISMATCH");
    expect(restored.getSnapshot().job?.state).toBe("delivery_unknown");
    await restored.scan(`]C100${h.data.sscc}`);
    expect(restored.getSnapshot().job?.state).toBe("verified");
    expect(await restored.finish()).toBe(true);
  } finally {
    await restored?.close();
    await h.work.close();
    h.db.close();
  }
});

it("recovers both retained legacy journals without hiding the remaining box attempt", async () => {
  const h = await fixture();
  const { prepareWarehouseJob } = await import("../src/lib/warehouse-reprint/store.js");
  const { prepareWarehousePalletJob } =
    await import("../src/lib/warehouse-reprint/pallet-printing.js");
  const { resolvePrinter } = await import("../src/lib/printer-routing.js");
  let restored: ReturnType<typeof workModule.createUnifiedWarehouseWork> | null = null;
  try {
    await h.work.initialize();
    await h.work.configure("damaged", h.unit, h.box, h.pallet);
    await h.work.start();
    const session = h.work.getSnapshot().session,
      input = warehousePreparedJobInput(),
      profile = resolvePrinter(h.hardware, "pallet");
    if (!session || !profile) throw new Error("Missing fixture session");
    await prepareWarehouseJob(h.exec, {
      ...input,
      owner: session.owner,
      sessionId: session.sessionId,
      printer: resolvePrinter(h.hardware, "box") ?? input.printer,
      preparedEvent: { ...input.preparedEvent, sessionId: session.sessionId },
    });
    await prepareWarehousePalletJob({
      exec: h.exec,
      owner: session.owner,
      operatorId: input.operatorId,
      sessionId: session.sessionId,
      source: thermalPalletSource(),
      reason: "damaged",
      profile,
      tenantId: "tenant-fixture",
      render: async () => new TextEncoder().encode("retained-pallet"),
    });
    await h.work.close();
    restored = workModule.createUnifiedWarehouseWork(h.options);
    await restored.initialize();
    expect(restored.getSnapshot().job?.kind).toBe("pallet");
    await restored.sendPrepared();
    expect(restored.getSnapshot().job).toMatchObject({ kind: "box", state: "prepared" });
    await restored.sendPrepared();
    expect(h.delivered).toHaveLength(2);
    expect(await restored.finish()).toBe(true);
  } finally {
    await restored?.close();
    await h.work.close();
    h.db.close();
  }
});

it("allows verification of a retained box attempt before selecting the new third template", async () => {
  const h = await fixture();
  const legacy = workModule.createWarehouseWork(h.options);
  let restored: ReturnType<typeof workModule.createUnifiedWarehouseWork> | null = null;
  try {
    await legacy.initialize();
    await legacy.configure("damaged", h.unit, h.box);
    await legacy.start();
    h.options.print = async () => {
      throw new Error("Unknown legacy dispatch");
    };
    await legacy.scan(warehouseBoxSource().identity);
    expect(legacy.getSnapshot().job?.state).toBe("delivery_unknown");
    await legacy.close();
    restored = workModule.createUnifiedWarehouseWork(h.options);
    await restored.initialize();
    expect(restored.getSnapshot().session?.palletTemplate ?? null).toBeNull();
    await restored.start();
    expect(restored.getSnapshot().session?.status).toBe("active");
    restored.requestVerification();
    await restored.scan(warehouseBoxSource().identity);
    expect(restored.getSnapshot().job?.state).toBe("verified");
    expect(await restored.finish()).toBe(true);
  } finally {
    await restored?.close();
    await legacy.close();
    await h.work.close();
    h.db.close();
  }
});

it("uses the current pallet choice for a new explicit repeat and preserves the old attempt", async () => {
  const h = await fixture();
  try {
    await h.work.initialize();
    await h.work.configure("damaged", h.unit, h.box, h.pallet);
    await h.work.start();
    await h.work.scan(h.data.sscc);
    const first = h.work.getSnapshot().job?.jobId;
    await h.work.configure("damaged", h.unit, h.box, h.palletB);
    await h.work.reprint("lost");
    expect(h.work.getSnapshot().error).toBeNull();
    expect(h.delivered).toHaveLength(2);
    expect(h.work.getSnapshot().job?.jobId).not.toBe(first);
    const rows = await h.exec.all<{ choice: string }>(
      "SELECT json_extract(rendering_json,'$.choice.id') choice FROM warehouse_pallet_jobs ORDER BY rowid",
    );
    expect(rows.map((r) => r.choice)).toEqual([h.pallet.id, h.palletB.id]);
  } finally {
    await h.work.close();
    h.db.close();
  }
});

it("allows unit and box intake without a pallet catalog but keeps pallet intake blocked", async () => {
  const h = await fixture(false);
  try {
    await h.work.initialize();
    await h.work.configure("damaged", h.unit, h.box, null);
    await h.work.start();
    expect(h.work.getSnapshot().session?.status).toBe("active");
    await h.work.scan(h.raw);
    await h.work.scan(warehouseBoxSource().identity);
    expect(h.delivered).toHaveLength(2);
    await h.work.scan(h.data.sscc);
    expect(h.work.getSnapshot().error).toBe("WAREHOUSE_TEMPLATES_REQUIRED");
    expect(h.delivered).toHaveLength(2);
  } finally {
    await h.work.close();
    h.db.close();
  }
});
it("revalidates a completed pallet before an explicit new print", async () => {
  const h = await fixture();
  try {
    await h.work.initialize();
    await h.work.configure("damaged", h.unit, h.box, h.pallet);
    await h.work.start();
    await h.work.scan(h.data.sscc);
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ status: "unavailable", code: "composition_changed" }), {
        status: 200,
      }),
    );
    await h.work.reprint("lost");
    expect(h.delivered).toHaveLength(1);
    expect(h.work.getSnapshot().error).toBe("WAREHOUSE_PALLET_COMPOSITION_CHANGED");
  } finally {
    await h.work.close();
    h.db.close();
  }
});
it("records a newly chosen reason when retrying an unknown pallet attempt", async () => {
  const h = await fixture();
  try {
    await h.work.initialize();
    await h.work.configure("damaged", h.unit, h.box, h.pallet);
    await h.work.start();
    const sending = h.options.print;
    h.options.print = async () => {
      throw new Error("unknown");
    };
    await h.work.scan(h.data.sscc);
    h.options.print = sending;
    await h.work.reprint("lost");
    expect(h.work.getSnapshot().job?.state).toBe("sent");
    const [last] = await h.exec.all<{ reason: string }>(
      "SELECT json_extract(value_json,'$.reason') reason FROM warehouse_pallet_events ORDER BY rowid DESC LIMIT 1",
    );
    expect(last?.reason).toBe("lost");
  } finally {
    await h.work.close();
    h.db.close();
  }
});

it("invalidates a changed pallet selection after a completed attempt", async () => {
  const h = await fixture();
  try {
    await h.work.initialize();
    await h.work.configure("damaged", h.unit, h.box, h.pallet);
    await h.work.start();
    await h.work.scan(h.data.sscc);
    const snapshot = { ...h.pallet.snapshot, widthMm: 80 };
    h.replacePalletCatalog([
      { ...h.pallet, snapshot, snapshotDigest: productLabelValueDigest(snapshot) },
    ]);
    await h.work.refreshCatalog();
    expect(h.work.getSnapshot().session?.palletTemplate).toBeNull();
    expect(h.work.getSnapshot().session?.status).toBe("paused");
    expect(h.work.getSnapshot().job?.state).toBe("sent");
  } finally {
    await h.work.close();
    h.db.close();
  }
});

it("does not require pallet selection on a server advertising only the old pallet protocol", async () => {
  const h = await fixture(true, false);
  try {
    await h.work.initialize();
    expect(h.work.getSnapshot().palletCatalog).toBeNull();
    await h.work.configure("damaged", h.unit, h.box, null);
    await h.work.start();
    expect(h.work.getSnapshot().session?.status).toBe("active");
  } finally {
    await h.work.close();
    h.db.close();
  }
});
