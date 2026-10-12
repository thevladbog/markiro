import { purgeWarehousePalletHistory } from "../src/lib/warehouse-reprint/history-retention.js";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { PALLET_REPRINT_V2_PROTOCOL, makePalletRenderingV2 } from "@markiro/domain";
import {
  thermalPalletSource,
  thermalChoice,
} from "../../../packages/domain/test/support/pallet-reprint.js";
import { applyMigrations } from "../src/lib/mirror.js";
import { makeRotatingExec } from "./support/sqlite-exec.js";
import { warehousePreparedJobInput } from "./support/warehouse-reprint.js";
import { syncWarehousePalletV2 } from "../src/lib/warehouse-reprint/pallet-v2-sync.js";
import type { StationClient } from "../src/lib/api-client.js";
it("retries immutable rendering, checks exact receipt and ignores late owner ACK", async () => {
  const db = new DatabaseSync(":memory:"),
    exec = makeRotatingExec([db, db]);
  await applyMigrations(exec);
  try {
    const rendering = makePalletRenderingV2(thermalPalletSource(), thermalChoice());
    const source = thermalPalletSource(),
      input = warehousePreparedJobInput(),
      jobId = "00000000-0000-4000-8000-000000000040";
    const event = {
      eventId: crypto.randomUUID(),
      jobId,
      attemptId: crypto.randomUUID(),
      sscc: source.sscc,
      sourceRevision: source.revision,
      renderingRevision: rendering.renderingRevision,
      operatorId: input.operatorId,
      reason: "damaged",
      occurredAt: new Date().toISOString(),
      state: "prepared",
      printFormat: "tspl",
      bytesDigest: "a".repeat(64),
    };
    await exec.run(
      "INSERT INTO warehouse_pallet_jobs(owner,job_id,sscc,source_revision,source_json,profile_json,bytes_base64,bytes_digest,state,event_json,rendering_json,rendering_revision,protocol) VALUES(?,?,?,?,?,?,?,?,'prepared',?,?,?,?)",
      [
        "owner",
        jobId,
        source.sscc,
        source.revision,
        JSON.stringify(source),
        JSON.stringify(input.printer),
        "",
        event.bytesDigest,
        JSON.stringify(event),
        JSON.stringify(rendering),
        rendering.renderingRevision,
        PALLET_REPRINT_V2_PROTOCOL,
      ],
    );
    let current = true,
      late = false;
    const client: Pick<StationClient, "get" | "post"> = {
      get: async <T>() => ({ protocols: [PALLET_REPRINT_V2_PROTOCOL] }) as T,
      post: async <T>(_path: string, body?: unknown) => {
        const input = body as {
          entries: Array<{
            jobId: string;
            eventId?: string;
            rendering?: { renderingRevision: string };
          }>;
        };
        if (late) current = false;
        return {
          protocol: PALLET_REPRINT_V2_PROTOCOL,
          results: input.entries.map((e) =>
            e.rendering
              ? {
                  jobId: e.jobId,
                  renderingRevision: e.rendering.renderingRevision,
                  status: "accepted",
                }
              : { eventId: e.eventId, status: "accepted" },
          ),
        } as T;
      },
    };
    late = true;
    await syncWarehousePalletV2(exec, client, "owner", () => current);
    expect(
      (
        await exec.all<{ receive_status: string }>(
          "SELECT receive_status FROM warehouse_pallet_renderings",
        )
      )[0]?.receive_status,
    ).toBe("pending");
    current = true;
    late = false;
    await syncWarehousePalletV2(exec, client, "owner", () => current);
    expect(
      (
        await exec.all<{ receive_status: string }>(
          "SELECT receive_status FROM warehouse_pallet_renderings",
        )
      )[0]?.receive_status,
    ).toBe("accepted");
    await exec.run(
      "UPDATE warehouse_pallet_jobs SET state='sent',event_json=json_set(event_json,'$.eventId',?, '$.state','sent','$.occurredAt','2026-01-01T00:00:00.000Z')",
      [crypto.randomUUID()],
    );
    await exec.run("UPDATE warehouse_pallet_events SET receive_status='accepted'");
    await exec.run("UPDATE warehouse_pallet_renderings SET receive_status='pending'");
    await purgeWarehousePalletHistory(exec, "owner", "2026-10-01T00:00:00.000Z");
    expect(await exec.all("SELECT job_id FROM warehouse_pallet_jobs")).toHaveLength(1);
    await exec.run("UPDATE warehouse_pallet_renderings SET receive_status='conflict'");
    await purgeWarehousePalletHistory(exec, "owner", "2026-10-01T00:00:00.000Z");
    expect(await exec.all("SELECT job_id FROM warehouse_pallet_jobs")).toHaveLength(1);
    await exec.run("UPDATE warehouse_pallet_renderings SET receive_status='accepted'");
    await purgeWarehousePalletHistory(exec, "owner", "2026-10-01T00:00:00.000Z");
    expect(await exec.all("SELECT job_id FROM warehouse_pallet_jobs")).toHaveLength(0);
  } finally {
    db.close();
  }
});
