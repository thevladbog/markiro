import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import {
  buildPalletLabelTemplates,
  buildPalletSheetPresets,
  createPalletSheetSnapshot,
  kmHash,
  parseDuplicateKm,
  PALLET_REPRINT_PROTOCOL,
  LABEL_FACTS_PROTOCOL,
  productLabelValueDigest,
  sheetLogoFingerprint,
  warehouseBoxSource,
} from "@markiro/domain";
import { applyMigrations } from "../src/lib/mirror.js";
import { makeRotatingExec } from "./support/sqlite-exec.js";
import { createCredentialGeneration } from "../src/lib/credential-recovery.js";
import { attemptProductionPalletPrint } from "../src/lib/warehouse-reprint/production-pallet-printing.js";
import { syncUnitLabelFacts } from "../src/lib/warehouse-reprint/label-facts.js";
import { purgeWarehousePalletJobs } from "../src/lib/warehouse-reprint/pallet-sync.js";
import { recoverWarehousePalletJobs } from "../src/lib/warehouse-reprint/pallet-printing.js";
import type { StationClient } from "../src/lib/api-client.js";
const shiftId = "00000000-0000-4000-8000-000000000010",
  sscc = "146000000000001231",
  owner = "owner";
async function setup() {
  const db = new DatabaseSync(":memory:"),
    exec = makeRotatingExec([db, db]);
  await applyMigrations(exec);
  return { db, exec };
}
async function seedPallet(exec: ReturnType<typeof makeRotatingExec>, dual: boolean) {
  const template = buildPalletLabelTemplates()[0],
    preset = buildPalletSheetPresets()[0];
  if (!template || !preset) throw new Error("missing presets");
  const content = {
    schemaVersion: 1,
    producerVersion: "logo-raster-v1",
    tenantId: "tenant",
    ownerDigest: "a".repeat(64),
    organizationName: "Plant",
    logoRevision: null,
    sourceChecksum: null,
    logo: {
      width: 4,
      height: 1,
      stride: 1,
      pixelsBase64: "gA==",
      digest: sheetLogoFingerprint({ width: 4, height: 1, stride: 1, pixels: Uint8Array.of(128) }),
      source: "markiro",
    },
  };
  const brandingJson = JSON.stringify({ ...content, digest: productLabelValueDigest(content) });
  await exec.run(
    "INSERT INTO station_organization_branding(tenant_id,owner_digest,snapshot_json) VALUES('tenant',?,?)",
    [content.ownerDigest, brandingJson],
  );
  await exec.run(
    "INSERT INTO product_mirror(id,gtin14,name,status,shelf_life_days) VALUES('p','04600000000015','Frozen','active',1)",
  );
  await exec.run(
    "INSERT INTO shift_mirror(id,status,mode,product_id,production_date,pallet_label_template_spec,pallet_sheet_template_id,pallet_sheet_template_snapshot) VALUES(?,'active','aggregation','p','2026-02-28',?,?,?)",
    [
      shiftId,
      JSON.stringify(template.spec),
      dual ? "00000000-0000-4000-8000-000000000011" : null,
      dual
        ? JSON.stringify(
            createPalletSheetSnapshot({
              id: "00000000-0000-4000-8000-000000000011",
              name: "Sheet",
              revision: 1,
              spec: preset.spec,
            }),
          )
        : null,
    ],
  );
  await exec.run(
    "INSERT INTO pallets_mirror(pallet_id,shift_id,sscc,opened_at) VALUES('pallet',?,?,'2026-02-28T12:00:00Z')",
    [shiftId, sscc],
  );
  await exec.run(
    "INSERT INTO boxes_mirror(box_id,shift_id,sscc,opened_at,closed_at,pallet_id) VALUES('box',?,'046000000000001234','2026-02-28T12:00:00Z','2026-02-28T12:01:00Z','pallet')",
    [shiftId],
  );
  await exec.run(
    "INSERT INTO codes_mirror(code_hash,shift_id,gtin14,serial,scanned_at,box_id) VALUES(?,?,'04600000000015','unit','2026-02-28T12:00:00Z','box')",
    ["b".repeat(64), shiftId],
  );
  await exec.run("UPDATE pallets_mirror SET closed_at='2026-02-28T12:02:00Z'");
  // Emulate branding captured by the closure trigger on the paired device.
  await exec.run("DROP TRIGGER warehouse_pallet_closure_immutable");
  await exec.run(
    "UPDATE warehouse_pallet_closures SET context_json=json_set(context_json,'$.brandingJson',?)",
    [brandingJson],
  );
  return template.spec;
}
it.each([false, true])(
  "prints ordinary thermal pallets despite auxiliary conflict=%s",
  async (conflict) => {
    const { db, exec } = await setup();
    try {
      const template = await seedPallet(exec, true);
      if (conflict)
        await exec.run(
          "INSERT INTO conflicts_mirror(code_hash,winning_scanned_at,detected_at) VALUES(?,'2026-02-28T11:00:00Z','2026-02-28T13:00:00Z')",
          ["b".repeat(64)],
        );
      const print = vi.fn(async () => {}),
        bytes = new TextEncoder().encode("label");
      const result = await attemptProductionPalletPrint({
        generation: createCredentialGeneration(),
        owner,
        tenantId: "tenant",
        sscc,
        template,
        fields: { ...warehouseBoxSource().fields, sscc, qty: "1", "qty.boxes": "1" },
        destination: {
          exec,
          key: { scope: "production", purpose: "pallet", jobId: sscc, attemptId: "label" },
        },
        printing: {
          target: { kind: "tcp", host: "127.0.0.1", port: 9100 },
          language: "zpl",
          dpi: 203,
          print,
        },
        render: async () => bytes,
      });
      expect(result).toEqual({ kind: "printed", bytes });
      expect(print).toHaveBeenCalledWith({ kind: "tcp", host: "127.0.0.1", port: 9100 }, bytes);
      if (!conflict)
        expect(
          JSON.parse(
            (
              await exec.all<{ value_json: string }>(
                "SELECT value_json FROM warehouse_pallet_sources",
              )
            )[0]?.value_json ?? "null",
          ),
        ).toMatchObject({ version: 3, sscc });
    } finally {
      db.close();
    }
  },
);
it("stores label facts without any new raw KM copy and ignores reconciliation replay", async () => {
  const { db, exec } = await setup();
  try {
    await exec.run(
      "INSERT INTO product_mirror(id,gtin14,name,status,shelf_life_days) VALUES('p','04600000000015','Today','active',365)",
    );
    await exec.run(
      "INSERT INTO shift_mirror(id,status,mode,product_id) VALUES(?,'closed','aggregation','p')",
      [shiftId],
    );
    const raw = "010460000000001521OLD\u001d91Key1\u001d92Crypto",
      km = parseDuplicateKm(raw);
    await exec.run(
      "INSERT INTO outbox(shift_id,raw,verdict,scanned_at,code_hash,gtin14,replay_origin) VALUES(?,?,'ok','2026-02-28T12:00:00Z',?,?,1)",
      [shiftId, raw, kmHash(km), km.gtin14],
    );
    expect(await exec.all("SELECT 1 FROM unit_label_facts")).toEqual([]);
    await exec.run(
      "INSERT INTO outbox(shift_id,raw,verdict,scanned_at,code_hash,gtin14) VALUES(?,?,'ok','2026-02-28T12:00:01Z',?,?)",
      [shiftId, raw, kmHash(km), km.gtin14],
    );
    expect(await exec.all("SELECT canonical_raw FROM unit_label_facts")).toEqual([
      { canonical_raw: "" },
    ]);
  } finally {
    db.close();
  }
});
it("rotates retryable label facts so a full old batch cannot starve a later fact", async () => {
  const { db, exec } = await setup();
  try {
    const legacyRaw = (
      await exec.all<{ name: string }>("PRAGMA table_info(unit_label_facts)")
    ).some((r) => r.name === "canonical_raw");
    for (let i = 0; i < 101; i++)
      await exec.run(
        legacyRaw
          ? "INSERT INTO unit_label_facts(owner,shift_id,code_hash,accepted_at,canonical_raw,fields_json) VALUES(?,?,?,'2026-02-28T12:00:00.000Z','',?)"
          : "INSERT INTO unit_label_facts(owner,shift_id,code_hash,accepted_at,fields_json) VALUES(?,?,?,'2026-02-28T12:00:00.000Z',?)",
        [
          owner,
          shiftId,
          i.toString(16).padStart(64, "0"),
          JSON.stringify({ ...warehouseBoxSource().fields, "km.code": "", sscc: "", qty: "1" }),
        ],
      );
    const uploaded: string[][] = [];
    const client: Pick<StationClient, "get" | "post"> = {
      get: async <T>() => ({ protocols: [LABEL_FACTS_PROTOCOL] }) as T,
      post: async <T>(_path: string, body?: unknown) => {
        const entries = (body as { entries: Array<{ codeHash: string; digest: string }> }).entries;
        uploaded.push(entries.map((e) => e.codeHash));
        return {
          protocol: LABEL_FACTS_PROTOCOL,
          results: entries.map((e) => ({ digest: e.digest, status: "retryable" })),
        } as T;
      },
    };
    await syncUnitLabelFacts(exec, client, owner, () => true);
    await syncUnitLabelFacts(exec, client, owner, () => true);
    expect(uploaded[1]).toContain((100).toString(16).padStart(64, "0"));
  } finally {
    db.close();
  }
});
it("recovery cannot overwrite a concurrently finished transport or emit another outcome", async () => {
  const { db, exec } = await setup();
  try {
    await seedPallet(exec, false);
    const { retainPalletClosureSource } =
      await import("../src/lib/warehouse-reprint/pallet-sources.js");
    const { prepareWarehousePalletJob } =
      await import("../src/lib/warehouse-reprint/pallet-printing.js");
    const source = await retainPalletClosureSource(exec, owner, sscc, "thermal");
    if (!source) throw new Error("missing source");
    const operatorId = "00000000-0000-4000-8000-000000000030";
    const job = await prepareWarehousePalletJob({
      exec,
      owner,
      operatorId,
      reason: "damaged",
      source,
      tenantId: "tenant",
      profile: {
        id: "thermal",
        name: "Thermal",
        target: { kind: "tcp", host: "127.0.0.1", port: 9100 },
        language: "zpl",
        dpi: 203,
      },
      render: async () => Uint8Array.of(1),
    });
    await exec.run("UPDATE warehouse_pallet_jobs SET state='sending',claim_id='claim'");
    let raced = false;
    const racing = {
      run: exec.run.bind(exec),
      all: async <T>(sql: string, values?: unknown[]) => {
        const result = await exec.all<T>(sql, values);
        if (!raced && sql.includes("FROM printer_deliveries")) {
          raced = true;
          await exec.run(
            "UPDATE warehouse_pallet_jobs SET state='sent',event_json=json_set(event_json,'$.eventId',?,'$.state','sent')",
            [crypto.randomUUID()],
          );
        }
        return result;
      },
    };
    await recoverWarehousePalletJobs(racing, owner, operatorId);
    expect(
      (
        await exec.all<{ state: string }>(
          "SELECT state FROM warehouse_pallet_jobs WHERE job_id=?",
          [job.jobId],
        )
      )[0]?.state,
    ).toBe("sent");
    expect(
      await exec.all(
        "SELECT 1 FROM warehouse_pallet_events WHERE json_extract(value_json,'$.state')='delivery_unknown'",
      ),
    ).toEqual([]);
  } finally {
    db.close();
  }
});
it("expires old accepted sent pallet bytes and acknowledged closure history", async () => {
  const { db, exec } = await setup();
  try {
    await seedPallet(exec, false);
    const { retainPalletClosureSource } =
      await import("../src/lib/warehouse-reprint/pallet-sources.js");
    const { prepareWarehousePalletJob } =
      await import("../src/lib/warehouse-reprint/pallet-printing.js");
    const source = await retainPalletClosureSource(exec, owner, sscc, "thermal");
    if (!source) throw new Error("missing source");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-02-28T12:02:00Z"));
    await prepareWarehousePalletJob({
      exec,
      owner,
      operatorId: "00000000-0000-4000-8000-000000000030",
      reason: "damaged",
      source,
      tenantId: "tenant",
      profile: {
        id: "thermal",
        name: "Thermal",
        target: { kind: "tcp", host: "127.0.0.1", port: 9100 },
        language: "zpl",
        dpi: 203,
      },
      render: async () => Uint8Array.of(1),
    });
    vi.useRealTimers();
    await exec.run(
      "UPDATE warehouse_pallet_jobs SET state='sent',event_json=json_set(event_json,'$.eventId',?,'$.state','sent','$.occurredAt','2026-02-28T12:02:00Z')",
      [crypto.randomUUID()],
    );
    await exec.run("UPDATE warehouse_pallet_events SET receive_status='accepted'");
    await exec.run("UPDATE warehouse_pallet_sources SET receive_status='accepted'");
    for (const sql of [
      "UPDATE shift_mirror SET status='closed'",
      "UPDATE pallets_mirror SET acked_at='2026-02-28T12:02:00Z'",
      "UPDATE boxes_mirror SET acked_at='2026-02-28T12:02:00Z',confirmed_revision=reconciliation_revision",
    ])
      await exec.run(sql);
    await purgeWarehousePalletJobs(exec, owner, "2026-04-01T00:00:00Z");
    for (const table of [
      "warehouse_pallet_jobs",
      "warehouse_pallet_events",
      "warehouse_pallet_sources",
      "warehouse_pallet_closures",
    ])
      expect(await exec.all(`SELECT 1 FROM ${table}`), table).toEqual([]);
  } finally {
    vi.useRealTimers();
    db.close();
  }
});
it.each(["pinned", "pending", "conflict", "unknown", "unacknowledged", "proof"])(
  "retains all pallet evidence while %s work remains",
  async (guard) => {
    const { db, exec } = await setup();
    try {
      await seedPallet(exec, false);
      const { retainPalletClosureSource } =
        await import("../src/lib/warehouse-reprint/pallet-sources.js");
      const { prepareWarehousePalletJob } =
        await import("../src/lib/warehouse-reprint/pallet-printing.js");
      const source = await retainPalletClosureSource(exec, owner, sscc, "thermal");
      if (!source) throw new Error("missing source");
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-02-28T12:02:00Z"));
      await prepareWarehousePalletJob({
        exec,
        owner,
        operatorId: "00000000-0000-4000-8000-000000000030",
        reason: "damaged",
        source,
        tenantId: "tenant",
        profile: {
          id: "thermal",
          name: "Thermal",
          target: { kind: "tcp", host: "127.0.0.1", port: 9100 },
          language: "zpl",
          dpi: 203,
        },
        render: async () => Uint8Array.of(1),
      });
      vi.useRealTimers();
      await exec.run(
        "UPDATE warehouse_pallet_jobs SET state='sent',event_json=json_set(event_json,'$.eventId',?,'$.state','sent','$.occurredAt','2026-02-28T12:02:00Z')",
        [crypto.randomUUID()],
      );
      await exec.run("UPDATE warehouse_pallet_events SET receive_status='accepted'");
      await exec.run("UPDATE warehouse_pallet_sources SET receive_status='accepted'");
      for (const sql of [
        "UPDATE shift_mirror SET status='closed'",
        "UPDATE pallets_mirror SET acked_at='2026-02-28T12:02:00Z'",
        "UPDATE boxes_mirror SET acked_at='2026-02-28T12:02:00Z',confirmed_revision=reconciliation_revision",
      ])
        await exec.run(sql);
      if (guard === "pinned")
        await exec.run(
          "INSERT INTO station_meta(key,value) VALUES('sync_pending_batch_id','pinned')",
        );
      if (guard === "pending")
        await exec.run("UPDATE warehouse_pallet_events SET receive_status='pending'");
      if (guard === "conflict")
        await exec.run("UPDATE warehouse_pallet_sources SET receive_status='conflict'");
      if (guard === "unknown")
        await exec.run("UPDATE warehouse_pallet_jobs SET state='delivery_unknown'");
      if (guard === "unacknowledged") await exec.run("UPDATE boxes_mirror SET acked_at=NULL");
      if (guard === "proof")
        await exec.run(
          "UPDATE warehouse_pallet_sources SET production_delivery_json=json_object('sequence',1,'state','delivery_unknown')",
        );
      await purgeWarehousePalletJobs(exec, owner, "2026-04-01T00:00:00Z");
      for (const table of [
        "warehouse_pallet_jobs",
        "warehouse_pallet_events",
        "warehouse_pallet_sources",
        "warehouse_pallet_closures",
      ])
        expect((await exec.all(`SELECT 1 FROM ${table}`)).length, table).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
      db.close();
    }
  },
);
it("continues V1 history after independent pallet and fact channel failures", async () => {
  const { runWarehouseHistoryChannels } = await import("../src/lib/warehouse-reprint/channels.js");
  const acknowledged: string[] = [];
  await runWarehouseHistoryChannels([
    async () => {
      throw new TypeError("optional capability endpoint unavailable");
    },
    async () => {
      throw new Error("invalid historical fact");
    },
    async () => {
      acknowledged.push("V1 accepted");
    },
  ]);
  expect(acknowledged).toEqual(["V1 accepted"]);
});
it("durably records ordinary transport unknown before send and sent only after return", async () => {
  const { db, exec } = await setup();
  try {
    const template = await seedPallet(exec, false),
      states: string[] = [];
    const result = await attemptProductionPalletPrint({
      generation: createCredentialGeneration(),
      owner,
      tenantId: "tenant",
      sscc,
      template,
      fields: { ...warehouseBoxSource().fields, sscc, qty: "1", "qty.boxes": "1" },
      destination: {
        exec,
        key: { scope: "production", purpose: "pallet", jobId: sscc, attemptId: "label" },
      },
      printing: {
        target: { kind: "tcp", host: "127.0.0.1", port: 9100 },
        language: "zpl",
        dpi: 203,
        print: async () => {
          const [r] = await exec.all<{ production_delivery_json: string | null }>(
            "SELECT production_delivery_json FROM warehouse_pallet_sources",
          );
          states.push(
            r?.production_delivery_json ? JSON.parse(r.production_delivery_json).state : "missing",
          );
        },
      },
      render: async () => Uint8Array.of(1),
    });
    expect(result.kind).toBe("printed");
    expect(states).toEqual(["delivery_unknown"]);
    const [row] = await exec.all<{ revision: string; production_delivery_json: string }>(
      "SELECT revision,production_delivery_json FROM warehouse_pallet_sources",
    );
    expect(JSON.parse(row?.production_delivery_json ?? "null")).toMatchObject({
      sourceRevision: row?.revision,
      sequence: 2,
      attemptId: "label",
      state: "sent",
    });
  } finally {
    db.close();
  }
});
it("uploads finish as a new sequence after an unknown claim was acknowledged, and preserves concurrent evidence", async () => {
  const { db, exec } = await setup();
  try {
    await seedPallet(exec, false);
    const { retainPalletClosureSource } =
      await import("../src/lib/warehouse-reprint/pallet-sources.js");
    const { beginProductionPalletDelivery, finishProductionPalletDelivery } =
      await import("../src/lib/warehouse-reprint/production-delivery.js");
    const { syncWarehousePallets } = await import("../src/lib/warehouse-reprint/pallet-sync.js");
    const { PALLET_PRODUCTION_DELIVERY_PROTOCOL } = await import("@markiro/domain");
    const source = await retainPalletClosureSource(exec, owner, sscc, "thermal");
    if (!source) throw new Error("missing source");
    const claim = await beginProductionPalletDelivery(exec, owner, sscc, "label", "a".repeat(64));
    const uploaded: Array<{ sequence: number; state: string }> = [];
    let finishDuringReceipt = false;
    const client: Pick<StationClient, "get" | "post"> = {
      get: async <T>() =>
        ({ protocols: [PALLET_REPRINT_PROTOCOL, PALLET_PRODUCTION_DELIVERY_PROTOCOL] }) as T,
      post: async <T>(_path: string, body?: unknown) => {
        const sent = body as { productionDelivery: { sequence: number; state: string } };
        uploaded.push(sent.productionDelivery);
        if (finishDuringReceipt)
          await finishProductionPalletDelivery(exec, owner, sscc, claim, "sent");
        return {
          protocol: PALLET_REPRINT_PROTOCOL,
          results: [{ revision: source.revision, status: "accepted" }],
        } as T;
      },
    };
    finishDuringReceipt = true;
    await syncWarehousePallets(exec, client, owner, () => true);
    expect(
      (
        await exec.all<{ production_delivery_acked_sequence: number }>(
          "SELECT production_delivery_acked_sequence FROM warehouse_pallet_sources",
        )
      )[0]?.production_delivery_acked_sequence,
    ).toBe(0);
    finishDuringReceipt = false;
    await syncWarehousePallets(exec, client, owner, () => true);
    expect(uploaded.map((x) => [x.sequence, x.state])).toEqual([
      [1, "delivery_unknown"],
      [2, "sent"],
    ]);
    expect(
      (
        await exec.all<{ production_delivery_acked_sequence: number }>(
          "SELECT production_delivery_acked_sequence FROM warehouse_pallet_sources",
        )
      )[0]?.production_delivery_acked_sequence,
    ).toBe(2);
    const newer = await beginProductionPalletDelivery(exec, owner, sscc, "retry", "b".repeat(64));
    await finishProductionPalletDelivery(exec, owner, sscc, claim, "sent");
    expect(
      (
        await exec.all<{ production_delivery_json: string }>(
          "SELECT production_delivery_json FROM warehouse_pallet_sources",
        )
      )[0]?.production_delivery_json,
    ).toBe(JSON.stringify(newer));
  } finally {
    db.close();
  }
});
it("keeps proof pending on an old server while uploading unrelated pallet events", async () => {
  const { db, exec } = await setup();
  try {
    await seedPallet(exec, false);
    const { retainPalletClosureSource } =
      await import("../src/lib/warehouse-reprint/pallet-sources.js");
    const { beginProductionPalletDelivery } =
      await import("../src/lib/warehouse-reprint/production-delivery.js");
    const { syncWarehousePallets } = await import("../src/lib/warehouse-reprint/pallet-sync.js");
    const { prepareWarehousePalletJob } =
      await import("../src/lib/warehouse-reprint/pallet-printing.js");
    const source = await retainPalletClosureSource(exec, owner, sscc, "thermal");
    if (!source) throw new Error("missing source");
    await beginProductionPalletDelivery(exec, owner, sscc, "label", "a".repeat(64));
    await prepareWarehousePalletJob({
      exec,
      owner,
      operatorId: "00000000-0000-4000-8000-000000000030",
      reason: "damaged",
      source,
      tenantId: "tenant",
      profile: {
        id: "thermal",
        name: "Thermal",
        target: { kind: "tcp", host: "127.0.0.1", port: 9100 },
        language: "zpl",
        dpi: 203,
      },
      render: async () => Uint8Array.of(1),
    });
    const paths: string[] = [];
    const client: Pick<StationClient, "get" | "post"> = {
      get: async <T>() => ({ protocols: [PALLET_REPRINT_PROTOCOL] }) as T,
      post: async <T>(path: string, body?: unknown) => {
        paths.push(path);
        const entries = (body as { entries: Array<{ eventId: string }> }).entries;
        return {
          protocol: PALLET_REPRINT_PROTOCOL,
          results: entries.map((e) => ({ eventId: e.eventId, status: "accepted" })),
        } as T;
      },
    };
    await syncWarehousePallets(exec, client, owner, () => true);
    expect(paths).toEqual(["/station/warehouse-reprint/pallet-events"]);
    expect(
      (
        await exec.all<{ receive_status: string; production_delivery_acked_sequence: number }>(
          "SELECT receive_status,production_delivery_acked_sequence FROM warehouse_pallet_sources",
        )
      )[0],
    ).toEqual({ receive_status: "pending", production_delivery_acked_sequence: 0 });
  } finally {
    db.close();
  }
});
it("rotates unsupported production evidence so old-server compatible sources still sync", async () => {
  const { db, exec } = await setup();
  try {
    await seedPallet(exec, false);
    const { retainPalletClosureSource, savePalletLabelSource } =
      await import("../src/lib/warehouse-reprint/pallet-sources.js");
    const { beginProductionPalletDelivery } =
      await import("../src/lib/warehouse-reprint/production-delivery.js");
    const { syncWarehousePallets } = await import("../src/lib/warehouse-reprint/pallet-sync.js");
    const { makePalletLabelSource } = await import("@markiro/domain");
    const source = await retainPalletClosureSource(exec, owner, sscc, "thermal");
    if (!source || source.rendering.kind !== "thermal") throw new Error("missing source");
    await beginProductionPalletDelivery(exec, owner, sscc, "label", "a".repeat(64));
    const { revision: ignored, ...content } = source;
    void ignored;
    const compatible = makePalletLabelSource({
      ...content,
      sscc: "246000000000001238",
      rendering: {
        ...source.rendering,
        fields: { ...source.rendering.fields, sscc: "246000000000001238" },
      },
    });
    await savePalletLabelSource(exec, owner, compatible);
    const uploaded: string[] = [];
    const client: Pick<StationClient, "get" | "post"> = {
      get: async <T>() => ({ protocols: [PALLET_REPRINT_PROTOCOL] }) as T,
      post: async <T>(_path: string, body?: unknown) => {
        const entries = (body as { entries: Array<{ revision: string }> }).entries;
        uploaded.push(entries[0]?.revision ?? "");
        return {
          protocol: PALLET_REPRINT_PROTOCOL,
          results: entries.map((e) => ({ revision: e.revision, status: "accepted" })),
        } as T;
      },
    };
    await syncWarehousePallets(exec, client, owner, () => true);
    await syncWarehousePallets(exec, client, owner, () => true);
    expect(uploaded).toEqual([compatible.revision]);
  } finally {
    db.close();
  }
});
it("keeps acknowledged ordinary delivery unknown in sealed recovery until genuinely resolved later", async () => {
  const { db, exec } = await setup();
  try {
    await seedPallet(exec, false);
    const { retainPalletClosureSource } =
      await import("../src/lib/warehouse-reprint/pallet-sources.js");
    const { beginProductionPalletDelivery } =
      await import("../src/lib/warehouse-reprint/production-delivery.js");
    const { readSealedWorkSummary } = await import("../src/lib/credential-recovery.js");
    await retainPalletClosureSource(exec, owner, sscc, "thermal");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-01T00:00:00Z"));
    await beginProductionPalletDelivery(exec, owner, sscc, "label", "a".repeat(64));
    vi.useRealTimers();
    await exec.run(
      "UPDATE warehouse_pallet_sources SET receive_status='accepted',production_delivery_acked_sequence=1",
    );
    expect(await readSealedWorkSummary(exec)).toMatchObject({ unknownPrints: 1 });
    await exec.run("UPDATE pallets_mirror SET print_verified_at='2026-02-28T23:59:00Z'");
    expect(await readSealedWorkSummary(exec)).toMatchObject({ unknownPrints: 1 });
    await exec.run("UPDATE pallets_mirror SET print_verified_at='2026-03-01T00:01:00Z'");
    expect(await readSealedWorkSummary(exec)).toMatchObject({ unknownPrints: 0 });
  } finally {
    vi.useRealTimers();
    db.close();
  }
});
it("continues the authorised retained source sequence after credential rotation without adopting another tenant", async () => {
  const { db, exec } = await setup();
  try {
    await seedPallet(exec, false);
    const { retainPalletClosureSource } =
      await import("../src/lib/warehouse-reprint/pallet-sources.js");
    const { beginProductionPalletDelivery, finishProductionPalletDelivery } =
      await import("../src/lib/warehouse-reprint/production-delivery.js");
    const original = await retainPalletClosureSource(exec, owner, sscc, "thermal");
    const claim = await beginProductionPalletDelivery(exec, owner, sscc, "first", "a".repeat(64));
    await finishProductionPalletDelivery(exec, owner, sscc, claim, "sent");
    const ownerJson = JSON.stringify({
      serverOrigin: "https://api.example",
      tenantId: "tenant",
      deviceId: "00000000-0000-4000-8000-000000000044",
      kind: "station",
    });
    await exec.run(
      "INSERT INTO station_device_recovery(id,machine_id,owner_json,phase,active_hash) VALUES(1,'machine',?,'active','new-owner')",
      [ownerJson],
    );
    for (const hash of [owner, "new-owner"])
      await exec.run(
        "INSERT OR IGNORE INTO station_device_owners(credential_hash,owner_json) VALUES(?,?)",
        [hash, ownerJson],
      );
    expect((await retainPalletClosureSource(exec, "new-owner", sscc, "thermal"))?.revision).toBe(
      original?.revision,
    );
    const next = await beginProductionPalletDelivery(
      exec,
      "new-owner",
      sscc,
      "next",
      "b".repeat(64),
    );
    expect(next?.sequence).toBe(3);
    await finishProductionPalletDelivery(exec, "new-owner", sscc, next, "sent");
    expect(
      await exec.all(
        "SELECT owner,json_extract(production_delivery_json,'$.sequence') sequence FROM warehouse_pallet_sources",
      ),
    ).toEqual([{ owner, sequence: 4 }]);
    expect(
      await beginProductionPalletDelivery(exec, "foreign-owner", sscc, "foreign", "c".repeat(64)),
    ).toBeNull();
  } finally {
    db.close();
  }
});
it("retains accepted unit facts while an acknowledged ordinary RAW transport remains unknown", async () => {
  const { db, exec } = await setup();
  try {
    await seedPallet(exec, false);
    const { retainPalletClosureSource } =
      await import("../src/lib/warehouse-reprint/pallet-sources.js");
    const { beginProductionPalletDelivery } =
      await import("../src/lib/warehouse-reprint/production-delivery.js");
    const { purgeUnitLabelFacts } =
      await import("../src/lib/warehouse-reprint/history-retention.js");
    await retainPalletClosureSource(exec, owner, sscc, "thermal");
    await beginProductionPalletDelivery(exec, owner, sscc, "raw", "a".repeat(64));
    await exec.run(
      "UPDATE warehouse_pallet_sources SET receive_status='accepted',production_delivery_acked_sequence=1",
    );
    await exec.run(
      "INSERT INTO unit_label_facts(owner,shift_id,code_hash,accepted_at,canonical_raw,fields_json,receive_status) VALUES(?,?,?,'2026-02-28T12:00:00Z','legacy-original','{}','accepted')",
      [owner, shiftId, "b".repeat(64)],
    );
    for (const sql of [
      "UPDATE shift_mirror SET status='closed'",
      "UPDATE pallets_mirror SET acked_at='2026-02-28T12:02:00Z'",
      "UPDATE boxes_mirror SET acked_at='2026-02-28T12:02:00Z',confirmed_revision=reconciliation_revision",
    ])
      await exec.run(sql);
    await purgeUnitLabelFacts(exec, owner, "2026-04-01T00:00:00Z");
    expect(await exec.all("SELECT canonical_raw FROM unit_label_facts")).toEqual([
      { canonical_raw: "legacy-original" },
    ]);
  } finally {
    db.close();
  }
});
it("restores positive eligibility and new lookup aliases on the authorised retained source after rotation", async () => {
  const { db, exec } = await setup();
  try {
    await seedPallet(exec, false);
    const { retainPalletClosureSource, resolveWarehousePalletSource } =
      await import("../src/lib/warehouse-reprint/pallet-sources.js");
    const saved = await retainPalletClosureSource(exec, owner, sscc, "thermal");
    if (!saved) throw new Error("missing source");
    for (const table of ["codes_mirror", "boxes_mirror", "pallets_mirror"])
      await exec.run(`DELETE FROM ${table}`);
    await exec.run("UPDATE warehouse_pallet_sources SET eligibility_denied=1");
    const ownerJson = JSON.stringify({
      serverOrigin: "https://api.example",
      tenantId: "tenant",
      deviceId: "00000000-0000-4000-8000-000000000044",
      kind: "station",
    });
    await exec.run(
      "INSERT INTO station_device_recovery(id,machine_id,owner_json,phase,active_hash) VALUES(1,'machine',?,'active','new-owner')",
      [ownerJson],
    );
    await exec.run(
      "INSERT OR IGNORE INTO station_device_owners(credential_hash,owner_json) VALUES(?,?)",
      [owner, ownerJson],
    );
    const raw = "010460000000001521NEW-ALIAS\u001d91Key1\u001d92Crypto";
    const client: StationClient = {
      get: async <T>() => ({ protocols: [PALLET_REPRINT_PROTOCOL] }) as T,
      post: async <T>() => ({ status: "found", source: saved }) as T,
      download: async () => new Blob(),
      whoami: async () => ({ ok: true }),
    };
    const found = await resolveWarehousePalletSource(
      client,
      exec,
      "new-owner",
      raw,
      "00000000-0000-4000-8000-000000000030",
    );
    expect(found.source.revision).toBe(saved.revision);
    expect(
      (
        await exec.all<{ eligibility_denied: number }>(
          "SELECT eligibility_denied FROM warehouse_pallet_sources",
        )
      )[0]?.eligibility_denied,
    ).toBe(0);
    const offline = {
      ...client,
      get: async <T>(): Promise<T> => {
        throw new TypeError("Offline");
      },
    };
    expect(
      (
        await resolveWarehousePalletSource(
          offline,
          exec,
          "new-owner",
          raw,
          "00000000-0000-4000-8000-000000000030",
        )
      ).source.revision,
    ).toBe(saved.revision);
    expect(await exec.all("SELECT owner,revision FROM warehouse_pallet_sources")).toEqual([
      { owner, revision: saved.revision },
    ]);
  } finally {
    db.close();
  }
});

it.each([
  "terminal",
  "test",
  "other-shift",
  "same-shift",
  "pending",
  "unresolved-conflict",
  "removed-conflict",
  "quarantine",
  "durable-quarantine",
])("scopes closed-shift retention while preserving %s evidence", async (guard) => {
  const { db, exec } = await setup();
  try {
    await seedPallet(exec, false);
    const { retainPalletClosureSource } =
      await import("../src/lib/warehouse-reprint/pallet-sources.js");
    const { purgeUnitLabelFacts } =
      await import("../src/lib/warehouse-reprint/history-retention.js");
    await retainPalletClosureSource(exec, owner, sscc, "thermal");
    await exec.run("UPDATE warehouse_pallet_sources SET receive_status='accepted'");
    await exec.run("UPDATE shift_mirror SET status='closed'");
    await exec.run("UPDATE pallets_mirror SET acked_at='2026-02-28T12:02:00Z'");
    await exec.run(
      "UPDATE boxes_mirror SET acked_at='2026-02-28T12:02:00Z',confirmed_revision=reconciliation_revision",
    );
    for (const [hash, status] of [
      ["b".repeat(64), "accepted"],
      ["c".repeat(64), guard === "pending" ? "pending" : "conflict"],
    ]) {
      await exec.run(
        "INSERT INTO unit_label_facts(owner,shift_id,code_hash,accepted_at,canonical_raw,fields_json,receive_status) VALUES(?,?,?,'2026-02-28T12:00:00Z','legacy-original','{}',?)",
        [owner, shiftId, hash, status],
      );
    }
    if (guard === "unresolved-conflict" || guard === "removed-conflict") {
      await exec.run(
        "INSERT INTO conflicts_mirror(code_hash,winning_scanned_at,detected_at) VALUES(?,'2026-02-28T11:00:00Z','2026-02-28T13:00:00Z')",
        [guard === "removed-conflict" ? "c".repeat(64) : "b".repeat(64)],
      );
    }
    if (guard === "durable-quarantine") {
      const { retainRecoveryDeniedShifts } = await import("../src/lib/sync-recovery-denials.js");
      await retainRecoveryDeniedShifts(exec, [shiftId]);
    }
    if (guard === "quarantine")
      await exec.run("INSERT INTO station_meta(key,value) VALUES('sync_last_recovery_denied',?)", [
        JSON.stringify({
          denied: [{ shiftId, recordKind: "item", code: "ownership_conflict" }],
        }),
      ]);
    if (["test", "other-shift", "same-shift"].includes(guard)) {
      const scope =
        guard === "test"
          ? "setup-owner"
          : JSON.stringify([guard === "same-shift" ? shiftId : "other-shift", null]);
      await exec.run(
        "INSERT INTO printer_deliveries(scope,purpose,job_id,attempt_id,state,profile_json,artifact_digest,artifact_base64,document_name,updated_at) VALUES(?,?,'job','attempt','delivery_unknown','{}','digest','AQ==','test','2026-02-28T12:00:00Z')",
        [scope, guard === "test" ? "test" : "pallet"],
      );
    }
    await purgeWarehousePalletJobs(exec, owner, "2026-04-01T00:00:00Z");
    await purgeUnitLabelFacts(exec, owner, "2026-04-01T00:00:00Z");
    const retained = [
      "same-shift",
      "pending",
      "unresolved-conflict",
      "removed-conflict",
      "quarantine",
      "durable-quarantine",
    ].includes(guard);
    expect(await exec.all("SELECT canonical_raw FROM unit_label_facts")).toHaveLength(
      retained ? 2 : 0,
    );
    expect(await exec.all("SELECT 1 FROM warehouse_pallet_sources")).toHaveLength(retained ? 1 : 0);
    expect(await exec.all("SELECT 1 FROM warehouse_pallet_closures")).toHaveLength(
      retained ? 1 : 0,
    );
    if (["test", "other-shift", "same-shift"].includes(guard))
      expect(await exec.all("SELECT state FROM printer_deliveries")).toEqual([
        { state: "delivery_unknown" },
      ]);
  } finally {
    db.close();
  }
});

it("preserves quarantine protection across a later denial for another shift", async () => {
  const { db, exec } = await setup();
  try {
    const { retainRecoveryDeniedShifts } = await import("../src/lib/sync-recovery-denials.js");
    await exec.run("INSERT INTO station_meta(key,value) VALUES('sync_last_recovery_denied',?)", [
      JSON.stringify({ denied: [{ shiftId, recordKind: "item", code: "ownership_conflict" }] }),
    ]);
    await retainRecoveryDeniedShifts(exec, ["other-shift"]);
    await exec.run("UPDATE station_meta SET value=? WHERE key='sync_last_recovery_denied'", [
      JSON.stringify({ denied: [{ shiftId: "other-shift" }] }),
    ]);
    await retainRecoveryDeniedShifts(exec, ["other-shift"]);
    expect(
      await exec.all(
        "SELECT key FROM station_meta WHERE key LIKE 'sync_recovery_denied_shift:%' ORDER BY key",
      ),
    ).toEqual([
      { key: `sync_recovery_denied_shift:${shiftId}` },
      { key: "sync_recovery_denied_shift:other-shift" },
    ]);
  } finally {
    db.close();
  }
});

it("reconstructs closure rendering from saved context when data-only V3 already exists", async () => {
  const { db, exec } = await setup();
  try {
    await seedPallet(exec, false);
    const { retainPalletClosureSource } =
      await import("../src/lib/warehouse-reprint/pallet-sources.js");
    const first = await retainPalletClosureSource(exec, owner, sscc, "thermal", true);
    expect(first?.version).toBe(1);
    const before = await exec.all("SELECT revision,value_json FROM warehouse_pallet_sources");
    const again = await retainPalletClosureSource(exec, owner, sscc, "thermal", true);
    expect(again?.revision).toBe(first?.revision);
    expect(await exec.all("SELECT revision,value_json FROM warehouse_pallet_sources")).toEqual(
      before,
    );
  } finally {
    db.close();
  }
});
