import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { warehouseBoxSource, resolveWarehouseReprintScan } from "@markiro/domain";
import { applyMigrations } from "../src/lib/mirror";
import { makeRotatingExec } from "./support/sqlite-exec";
import {
  cacheWarehouseSource,
  findWarehouseSource,
  resolveWarehouseSource,
} from "../src/lib/warehouse-reprint/sources";
import type { StationClient } from "../src/lib/api-client";
it("uses a known offline source without waiting for an online lookup", async () => {
  const db = new DatabaseSync(":memory:");
  const exec = makeRotatingExec([db, db]);
  await applyMigrations(exec);
  const s = warehouseBoxSource();
  const client = {
    post: vi.fn().mockRejectedValue(new Error("must not contact offline network")),
  } as unknown as StationClient;
  const connected = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
  try {
    await cacheWarehouseSource(exec, "owner", s);
    expect(
      await resolveWarehouseSource(client, exec, "owner", s.identity, "operator"),
    ).toMatchObject({ status: "found", source: s });
    expect(client.post).not.toHaveBeenCalled();
  } finally {
    connected.mockRestore();
    db.close();
  }
});
it("uses the mirrored CHZ group for an offline accepted unit with a restricted template", async () => {
  const { productLabelAcceptanceFixture, seedProductLabelShift } =
    await import("./support/product-labels");
  const { recordProductLabelAcceptance } = await import("../src/lib/product-labels/acceptance");
  const { renderWarehouseLabel } = await import("../src/lib/warehouse-reprint/prepare");
  const { buildWarehouseCodeOnlyLabelTemplate, productLabelValueDigest, warehouseBoxTemplate } =
    await import("@markiro/domain");
  const db = new DatabaseSync(":memory:");
  const exec = makeRotatingExec([db, db]);
  await applyMigrations(exec);
  const i = productLabelAcceptanceFixture({ ownership: "owner" });
  try {
    await seedProductLabelShift(exec, i);
    await exec.run(
      "INSERT INTO product_mirror(id,gtin14,name,status,chz_product_group_code) SELECT product_id,?,'Unit','active',15 FROM shift_mirror WHERE id=?",
      [i.gtin14, i.shiftId],
    );
    await recordProductLabelAcceptance(exec, i);
    const found = await resolveWarehouseSource(
      {
        post: async () => {
          throw new TypeError("offline");
        },
      } as unknown as StationClient,
      exec,
      "owner",
      i.raw,
      i.operatorId,
    );
    expect(found).toMatchObject({
      status: "found",
      source: { chzProductGroupCode: 15, fields: { "km.code": i.canonicalRaw } },
    });
    if (found.status !== "found") throw new Error("missing local source");
    const { digest, ...base } = warehouseBoxTemplate();
    void digest;
    const selection = {
      ...base,
      purpose: "product_duplicate" as const,
      chzProductGroupCodes: [15],
      spec: buildWarehouseCodeOnlyLabelTemplate().spec,
    };
    const rendered = await renderWarehouseLabel(
      found.source,
      { ...selection, digest: productLabelValueDigest(selection) },
      {
        id: "tsc",
        name: "TSC 210",
        target: { kind: "tcp", host: "127.0.0.1", port: 9100 },
        language: "tspl",
        dpi: 203,
      },
      async () => ({ width: 8, height: 1, hex: "80", bytesPerRow: 1, totalBytes: 1 }),
    );
    expect(rendered.fields["km.code"]).toBe(i.canonicalRaw);
    expect(rendered.bytesBase64.length).toBeGreaterThan(0);
  } finally {
    db.close();
  }
});
it("refreshes online box eligibility and does not resurrect a remote retired box offline", async () => {
  const db = new DatabaseSync(":memory:");
  const exec = makeRotatingExec([db, db]);
  await applyMigrations(exec);
  const s = warehouseBoxSource();
  const client = {
    post: vi.fn().mockResolvedValue({ status: "unavailable", code: "source_not_printable" }),
  } as unknown as StationClient;
  try {
    await cacheWarehouseSource(exec, "owner", s);
    expect(
      await resolveWarehouseSource(client, exec, "owner", `00${s.identity}`, "operator"),
    ).toEqual({ status: "unavailable", code: "source_not_printable" });
    vi.mocked(client.post).mockRejectedValue(new TypeError("offline"));
    expect(
      await resolveWarehouseSource(client, exec, "owner", `00${s.identity}`, "operator"),
    ).toEqual({ status: "network_required" });
  } finally {
    db.close();
  }
});
it("keeps the local closed-box group and historical fields when eligibility is refreshed", async () => {
  const { cacheWarehouseClosedBox } = await import("../src/lib/warehouse-reprint/sources");
  const db = new DatabaseSync(":memory:");
  const exec = makeRotatingExec([db, db]);
  await applyMigrations(exec);
  const s = warehouseBoxSource();
  const client = {
    post: vi.fn().mockResolvedValue({ status: "found", source: s, repair: null }),
  } as unknown as StationClient;
  try {
    await cacheWarehouseClosedBox(exec, "owner", {
      sourceId: s.sourceId,
      sourceShiftId: s.sourceShiftId,
      fields: s.fields,
      chzProductGroupCode: 15,
    });
    const local = await findWarehouseSource(exec, "owner", resolveWarehouseReprintScan(s.identity));
    expect(local?.chzProductGroupCode).toBe(15);
    const found = await resolveWarehouseSource(client, exec, "owner", s.identity, "operator");
    expect(found).toMatchObject({ status: "found", source: { fields: s.fields } });
    expect(client.post).toHaveBeenCalledTimes(1);
  } finally {
    db.close();
  }
});
it("uses an owned durable source offline, keeps owners separate and reports absence", async () => {
  const db = new DatabaseSync(":memory:");
  const exec = makeRotatingExec([db, db]);
  await applyMigrations(exec);
  const client = {
    post: vi.fn().mockRejectedValue(new TypeError("offline")),
  } as unknown as StationClient;
  try {
    const source = warehouseBoxSource();
    await cacheWarehouseSource(exec, "owner", source);
    const scan = resolveWarehouseReprintScan(`!100${source.identity}`);
    expect(await findWarehouseSource(exec, "owner", scan)).toEqual(source);
    expect(
      await resolveWarehouseSource(client, exec, "owner", `!100${source.identity}`, "operator"),
    ).toMatchObject({ status: "found", repair: "legacy_tspl_fnc1_literal" });
    expect(client.post).toHaveBeenCalledTimes(1);
    expect(
      await resolveWarehouseSource(client, exec, "other", `00${source.identity}`, "operator"),
    ).toEqual({ status: "network_required" });
    vi.mocked(client.post).mockRejectedValueOnce(new DOMException("deadline", "AbortError"));
    expect(
      await resolveWarehouseSource(client, exec, "other", `00${source.identity}`, "operator"),
    ).toEqual({ status: "network_required" });
    await exec.run("UPDATE warehouse_reprint_cache SET value_json='{}'");
    await expect(findWarehouseSource(exec, "owner", scan)).rejects.toThrow();
  } finally {
    db.close();
  }
});
it("retains the first closed-box fields for offline warehouse use", async () => {
  const db = new DatabaseSync(":memory:");
  const exec = makeRotatingExec([db, db]);
  await applyMigrations(exec);
  try {
    const { cacheWarehouseClosedBox } = await import("../src/lib/warehouse-reprint/sources");
    const s = warehouseBoxSource();
    await cacheWarehouseClosedBox(exec, "owner", {
      sourceId: s.sourceId,
      sourceShiftId: s.sourceShiftId,
      fields: s.fields,
    });
    await cacheWarehouseClosedBox(exec, "owner", {
      sourceId: s.sourceId,
      sourceShiftId: s.sourceShiftId,
      fields: { ...s.fields, date: "01.01.2030" },
    });
    expect(
      (await findWarehouseSource(exec, "owner", resolveWarehouseReprintScan(`!100${s.identity}`)))
        ?.fields.date,
    ).toBe(s.fields.date);
  } finally {
    db.close();
  }
});

it("rejects a cached box after local disassembly without changing its historical fields", async () => {
  const { insertException } = await import("../src/lib/box-exceptions-mirror");
  const db = new DatabaseSync(":memory:");
  const exec = makeRotatingExec([db, db]);
  await applyMigrations(exec);
  const s = warehouseBoxSource();
  const client = {
    post: vi.fn().mockRejectedValue(new TypeError("offline")),
  } as unknown as StationClient;
  try {
    await exec.run(
      "INSERT INTO boxes_mirror(box_id,shift_id,sscc,opened_at,closed_at) VALUES(?,?,?,?,?)",
      [
        s.sourceId,
        s.sourceShiftId,
        s.identity,
        "2026-10-08T10:00:00.000Z",
        "2026-10-08T11:00:00.000Z",
      ],
    );
    await cacheWarehouseSource(exec, "owner", s);
    await insertException(exec, {
      kind: "disassemble",
      boxId: s.sourceId,
      codeHash: null,
      targetScannedAt: null,
      shiftId: s.sourceShiftId ?? "shift",
      terminalId: null,
      operatorId: null,
      reason: "repack",
      at: "2026-10-09T10:00:00.000Z",
    });
    expect(
      await resolveWarehouseSource(client, exec, "owner", `00${s.identity}`, "operator"),
    ).toEqual({ status: "unavailable", code: "source_not_printable" });
    expect(client.post).not.toHaveBeenCalled();
    expect(
      JSON.parse(
        (
          await exec.all<{ value_json: string }>("SELECT value_json FROM warehouse_reprint_cache")
        )[0]?.value_json ?? "{}",
      ),
    ).toEqual(s);
  } finally {
    db.close();
  }
});

it("keeps an unsynced accepted unit printable after online not_found", async () => {
  const { productLabelAcceptanceFixture, seedProductLabelShift } =
    await import("./support/product-labels");
  const { recordProductLabelAcceptance } = await import("../src/lib/product-labels/acceptance");
  const db = new DatabaseSync(":memory:");
  const exec = makeRotatingExec([db, db]);
  await applyMigrations(exec);
  const i = productLabelAcceptanceFixture({ ownership: "owner" });
  try {
    await seedProductLabelShift(exec, i);
    await recordProductLabelAcceptance(exec, i);
    const result = await resolveWarehouseSource(
      { post: async () => ({ status: "not_found" }) } as unknown as StationClient,
      exec,
      "owner",
      i.raw,
      i.operatorId,
    );
    expect(result).toMatchObject({
      status: "found",
      source: { fields: { ...i.fields, "km.code": i.canonicalRaw, sscc: "" } },
    });
    expect(
      await resolveWarehouseSource(
        { post: async () => ({ status: "not_found" }) } as unknown as StationClient,
        exec,
        "other",
        i.raw,
        i.operatorId,
      ),
    ).toEqual({ status: "not_found" });
  } finally {
    db.close();
  }
});

it("preserves a locally frozen box through online absence, retirement, and later eligibility refresh", async () => {
  const { cacheWarehouseClosedBox } = await import("../src/lib/warehouse-reprint/sources");
  const db = new DatabaseSync(":memory:");
  const exec = makeRotatingExec([db, db]);
  await applyMigrations(exec);
  const original = warehouseBoxSource();
  const localFields = {
    ...original.fields,
    date: "08.10.2026",
    expiry: "09.10.2026",
    "product.printName": "Frozen name",
  };
  const client = {
    post: vi.fn().mockResolvedValue({ status: "not_found" }),
  } as unknown as StationClient;
  try {
    await exec.run(
      "INSERT INTO boxes_mirror(box_id,shift_id,sscc,opened_at,closed_at) VALUES(?,?,?,?,?)",
      [
        original.sourceId,
        original.sourceShiftId,
        original.identity,
        "2026-10-08T10:00:00Z",
        "2026-10-08T11:00:00Z",
      ],
    );
    await cacheWarehouseClosedBox(exec, "owner", {
      sourceId: original.sourceId,
      sourceShiftId: original.sourceShiftId,
      fields: localFields,
    });
    expect(
      await resolveWarehouseSource(client, exec, "owner", original.identity, "operator"),
    ).toMatchObject({ status: "found", source: { fields: localFields } });
    vi.mocked(client.post).mockResolvedValue({
      status: "unavailable",
      code: "source_not_printable",
    });
    expect(
      await resolveWarehouseSource(client, exec, "owner", original.identity, "operator"),
    ).toEqual({ status: "unavailable", code: "source_not_printable" });
    vi.mocked(client.post).mockRejectedValue(new TypeError("offline"));
    expect(
      await resolveWarehouseSource(client, exec, "owner", original.identity, "operator"),
    ).toEqual({ status: "unavailable", code: "source_not_printable" });
    vi.mocked(client.post).mockResolvedValue({ status: "found", source: original, repair: null });
    expect(
      await resolveWarehouseSource(client, exec, "owner", original.identity, "operator"),
    ).toMatchObject({ status: "found", source: { fields: localFields } });
    vi.mocked(client.post).mockRejectedValue(new TypeError("offline"));
    expect(
      await resolveWarehouseSource(client, exec, "owner", original.identity, "operator"),
    ).toMatchObject({ status: "found", source: { fields: localFields } });
  } finally {
    db.close();
  }
});

it("does not use a lookup-only source after online not_found", async () => {
  const db = new DatabaseSync(":memory:");
  const exec = makeRotatingExec([db, db]);
  await applyMigrations(exec);
  const source = warehouseBoxSource();
  const client = {
    post: vi.fn().mockResolvedValue({ status: "not_found" }),
  } as unknown as StationClient;
  try {
    await cacheWarehouseSource(exec, "owner", source);
    expect(
      await resolveWarehouseSource(client, exec, "owner", source.identity, "operator"),
    ).toEqual({ status: "not_found" });
    vi.mocked(client.post).mockRejectedValue(new TypeError("offline"));
    expect(
      await resolveWarehouseSource(client, exec, "owner", source.identity, "operator"),
    ).toEqual({ status: "network_required" });
  } finally {
    db.close();
  }
});

it("expires offline lookup copies and never replaces complete frozen fields with server fields", async () => {
  const { cacheWarehouseClosedBox } = await import("../src/lib/warehouse-reprint/sources");
  const db = new DatabaseSync(":memory:");
  const exec = makeRotatingExec([db, db]);
  await applyMigrations(exec);
  const source = warehouseBoxSource();
  try {
    await cacheWarehouseSource(exec, "owner", source);
    await exec.run("UPDATE warehouse_reprint_cache SET cached_at='2020-01-01'");
    expect(
      await findWarehouseSource(exec, "owner", resolveWarehouseReprintScan(source.identity)),
    ).toBeNull();
    await cacheWarehouseClosedBox(exec, "owner", {
      sourceId: source.sourceId,
      sourceShiftId: source.sourceShiftId,
      fields: { ...source.fields, date: "Saved date" },
    });
    expect(
      await resolveWarehouseSource(
        {
          post: async () => ({ status: "found", source, repair: null }),
        } as unknown as StationClient,
        exec,
        "owner",
        source.identity,
        "operator",
      ),
    ).toMatchObject({ status: "found", source: { fields: { date: "Saved date" } } });
    const [stored] = await exec.all<{ value_json: string }>(
      "SELECT value_json FROM warehouse_reprint_local_boxes",
    );
    expect(JSON.parse(stored?.value_json ?? "{}").fields.date).toBe("Saved date");
  } finally {
    db.close();
  }
});

it("persists local retirement denial before an interrupted lookup-cache invalidation", async () => {
  const { cacheWarehouseClosedBox } = await import("../src/lib/warehouse-reprint/sources");
  const db = new DatabaseSync(":memory:");
  let interrupt = false;
  const exec = makeRotatingExec([db, db], {
    afterRun(sql) {
      if (interrupt && sql.startsWith("DELETE FROM warehouse_reprint_cache")) {
        interrupt = false;
        throw new Error("interrupted after cache invalidation");
      }
    },
  });
  await applyMigrations(exec);
  const source = warehouseBoxSource();
  try {
    await cacheWarehouseClosedBox(exec, "owner", {
      sourceId: source.sourceId,
      sourceShiftId: source.sourceShiftId,
      fields: source.fields,
    });
    const client = {
      post: vi.fn().mockResolvedValue({ status: "unavailable", code: "source_not_printable" }),
    } as unknown as StationClient;
    interrupt = true;
    await expect(
      resolveWarehouseSource(client, exec, "owner", source.identity, "operator"),
    ).rejects.toThrow("interrupted after cache invalidation");
    vi.mocked(client.post).mockRejectedValue(new TypeError("offline"));
    expect(
      await resolveWarehouseSource(client, exec, "owner", source.identity, "operator"),
    ).toEqual({ status: "unavailable", code: "source_not_printable" });
  } finally {
    db.close();
  }
});

it.each([
  { shifted: true, group: 23 },
  { shifted: true, group: null },
  { shifted: false, group: 23 },
  { shifted: false, group: null },
])(
  "retains server group $group offline for a frozen box with shifted=$shifted without rewriting its JSON",
  async ({ shifted, group }) => {
    const { cacheWarehouseClosedBox } = await import("../src/lib/warehouse-reprint/sources");
    const { productLabelValueDigest, warehouseSourceSchema } = await import("@markiro/domain");
    const db = new DatabaseSync(":memory:");
    const exec = makeRotatingExec([db, db]);
    await applyMigrations(exec);
    const { revision, ...original } = warehouseBoxSource();
    void revision;
    const serverValue = {
      ...original,
      sourceShiftId: shifted ? original.sourceShiftId : null,
      chzProductGroupCode: group,
    };
    const server = warehouseSourceSchema.parse({
      ...serverValue,
      revision: productLabelValueDigest(serverValue),
    });
    try {
      if (shifted) {
        await exec.run(
          "INSERT INTO product_mirror(id,gtin14,name,status,chz_product_group_code) VALUES('group-product',?,'Product','active',15)",
          [original.fields["product.gtin"]],
        );
        await exec.run(
          "INSERT INTO shift_mirror(id,product_id,status,mode) VALUES(?,'group-product','active','aggregation')",
          [server.sourceShiftId],
        );
      }
      await cacheWarehouseClosedBox(exec, "owner", {
        sourceId: original.sourceId,
        sourceShiftId: server.sourceShiftId,
        fields: original.fields,
        chzProductGroupCode: 15,
      });
      const [before] = await exec.all<{ value_json: string }>(
        "SELECT value_json FROM warehouse_reprint_local_boxes",
      );
      const client = {
        post: vi.fn().mockResolvedValue({ status: "found", source: server, repair: null }),
      } as unknown as StationClient;
      expect(
        await resolveWarehouseSource(client, exec, "owner", original.identity, "operator"),
      ).toMatchObject({
        status: "found",
        source: { chzProductGroupCode: group, fields: original.fields },
      });
      vi.mocked(client.post).mockRejectedValue(new TypeError("offline"));
      expect(
        await resolveWarehouseSource(client, exec, "owner", original.identity, "operator"),
      ).toMatchObject({
        status: "found",
        source: { chzProductGroupCode: group, fields: original.fields },
      });
      expect(await exec.all("SELECT value_json FROM warehouse_reprint_local_boxes")).toEqual([
        before,
      ]);
    } finally {
      db.close();
    }
  },
);
