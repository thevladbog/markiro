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
    expect(client.post).not.toHaveBeenCalled();
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
