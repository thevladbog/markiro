import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { makePalletRenderingV2, productLabelValueDigest } from "@markiro/domain";
import {
  thermalPalletSource,
  thermalChoice,
} from "../../../packages/domain/test/support/pallet-reprint.js";
import { applyMigrations } from "../src/lib/mirror.js";
import { makeRotatingExec } from "./support/sqlite-exec.js";
import { savePalletLabelSource } from "../src/lib/warehouse-reprint/pallet-sources.js";
import {
  savePalletRendering,
  readPalletRendering,
} from "../src/lib/warehouse-reprint/pallet-rendering-store.js";
import {
  recordPalletProductionResolution,
  readPalletProductionResolution,
} from "../src/lib/warehouse-reprint/pallet-resolution-store.js";
it("stores immutable snapshots and journals one resolution with its durable sync state", async () => {
  const db = new DatabaseSync(":memory:"),
    exec = makeRotatingExec([db, db]);
  await applyMigrations(exec);
  try {
    const source = thermalPalletSource(),
      rendering = makePalletRenderingV2(source, thermalChoice());
    await savePalletRendering(exec, "owner", "job", rendering);
    await savePalletRendering(exec, "owner", "job", rendering);
    expect(await readPalletRendering(exec, "owner", "job")).toEqual(rendering);
    const { renderingRevision, ...originalBody } = rendering;
    expect(renderingRevision).toHaveLength(64);
    const changed = { ...originalBody, templateName: "Changed" };
    await expect(
      savePalletRendering(exec, "owner", "job", {
        ...changed,
        renderingRevision: productLabelValueDigest(changed),
      }),
    ).rejects.toThrow("PALLET_RENDERING_IMMUTABLE");
    await savePalletLabelSource(exec, "owner", source);
    const resolution = {
      eventId: "00000000-0000-4000-8000-000000000010",
      sscc: source.sscc,
      sourceRevision: source.revision,
      attemptId: "production-1",
      operatorId: "00000000-0000-4000-8000-000000000011",
      reason: "not_printed" as const,
      occurredAt: "2026-10-12T00:00:00.000Z",
      outcome: "confirmed" as const,
      scannedSscc: source.sscc,
    };
    await exec.run("UPDATE warehouse_pallet_sources SET production_delivery_json=?", [
      JSON.stringify({
        sourceRevision: source.revision,
        sequence: 1,
        attemptId: resolution.attemptId,
        bytesDigest: "a".repeat(64),
        state: "delivery_unknown",
        occurredAt: "2026-10-11T00:00:00.000Z",
      }),
    ]);
    await recordPalletProductionResolution(exec, "owner", resolution);
    await recordPalletProductionResolution(exec, "owner", resolution);
    expect(
      await readPalletProductionResolution(exec, "owner", source.sscc, resolution.attemptId),
    ).toMatchObject({ resolution, receiveStatus: "pending" });
    expect(await exec.all("SELECT event_id FROM warehouse_pallet_production_resolutions")).toEqual([
      { event_id: resolution.eventId },
    ]);
    await expect(
      recordPalletProductionResolution(exec, "owner", {
        ...resolution,
        outcome: "skipped",
        scannedSscc: null,
      }),
    ).rejects.toThrow();
    await expect(
      recordPalletProductionResolution(exec, "owner", {
        ...resolution,
        eventId: "00000000-0000-4000-8000-000000000012",
        attemptId: "later-attempt",
      }),
    ).rejects.toThrow("WAREHOUSE_PALLET_SOURCE_CHANGED");
  } finally {
    db.close();
  }
});
