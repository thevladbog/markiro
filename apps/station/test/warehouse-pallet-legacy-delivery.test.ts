import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import {
  makePalletLabelSource,
  PALLET_REPRINT_PROTOCOL,
  PALLET_PRODUCTION_DELIVERY_PROTOCOL,
} from "@markiro/domain";
import { thermalPalletSource } from "../../../packages/domain/test/support/pallet-reprint.js";
import { applyMigrations } from "../src/lib/mirror.js";
import { makeRotatingExec } from "./support/sqlite-exec.js";
import { savePalletLabelSource } from "../src/lib/warehouse-reprint/pallet-sources.js";
import { syncWarehousePallets } from "../src/lib/warehouse-reprint/pallet-sync.js";
import type { StationClient } from "../src/lib/api-client.js";

it.each([
  { state: "sent", digest: "b".repeat(64), owner: "owner", later: false, expected: 1 },
  { state: "delivery_unknown", digest: "b".repeat(64), owner: "owner", later: false, expected: 0 },
  { state: "sent", digest: "c".repeat(64), owner: "owner", later: false, expected: 0 },
  { state: "sent", digest: "b".repeat(64), owner: "foreign", later: false, expected: 0 },
  { state: "sent", digest: "b".repeat(64), owner: "owner", later: true, expected: 0 },
])(
  "recovers only the exact retained successful driver attempt: $state / $owner / $digest",
  async ({ state, digest, owner, later, expected }) => {
    const db = new DatabaseSync(":memory:"),
      exec = makeRotatingExec([db, db]);
    await applyMigrations(exec);
    try {
      const { revision, ...body } = thermalPalletSource();
      expect(revision).toHaveLength(64);
      const scope = JSON.stringify([body.shiftId, "device"]);
      const source = makePalletLabelSource({
        ...body,
        originalAttempt: {
          scope,
          attemptId: "label",
          bytesDigest: "b".repeat(64),
          geometryFingerprint: null,
        },
      });
      await savePalletLabelSource(exec, owner, source);
      await exec.run("UPDATE warehouse_pallet_sources SET receive_status='accepted'");
      await exec.run(
        "INSERT INTO pallets_mirror(pallet_id,shift_id,terminal_id,sscc,opened_at,closed_at,print_state) VALUES('pallet',?,'device',?, ?,?,'printed')",
        [source.shiftId, source.sscc, source.closedAt, source.closedAt],
      );
      await exec.run(
        "INSERT INTO printer_deliveries(scope,purpose,job_id,attempt_id,state,profile_json,artifact_digest,artifact_base64,document_name,updated_at) VALUES(?,'pallet',?,'label',?,'{}',?,'','label','2026-10-11T00:00:01.000Z')",
        [scope, source.sscc, state, digest],
      );
      if (later)
        await exec.run(
          "INSERT INTO printer_deliveries(scope,purpose,job_id,attempt_id,state,profile_json,artifact_digest,artifact_base64,document_name,updated_at) VALUES(?,'pallet',?,'later','delivery_unknown','{}',?,'','label','2026-10-11T00:00:02.000Z')",
          [scope, source.sscc, digest],
        );
      const deliveries: unknown[] = [];
      const client: Pick<StationClient, "get" | "post"> = {
        get: async <T>() =>
          ({ protocols: [PALLET_REPRINT_PROTOCOL, PALLET_PRODUCTION_DELIVERY_PROTOCOL] }) as T,
        post: async <T>(_path: string, body?: unknown) => {
          const request = body as { productionDelivery: unknown };
          deliveries.push(request.productionDelivery);
          return {
            protocol: PALLET_REPRINT_PROTOCOL,
            results: [{ revision: source.revision, status: "accepted" }],
          } as T;
        },
      };
      expect(await syncWarehousePallets(exec, client, "owner", () => true)).toBe(expected);
      if (expected) {
        expect(deliveries).toEqual([
          {
            sourceRevision: source.revision,
            sequence: 1,
            attemptId: "label",
            bytesDigest: "b".repeat(64),
            state: "sent",
            occurredAt: "2026-10-11T00:00:01.000Z",
          },
        ]);
        expect(
          await exec.all("SELECT production_delivery_acked_sequence FROM warehouse_pallet_sources"),
        ).toEqual([{ production_delivery_acked_sequence: 1 }]);
        expect(await syncWarehousePallets(exec, client, "owner", () => true)).toBe(0);
      } else expect(deliveries).toEqual([]);
      expect(
        (await exec.all<{ revision: string }>("SELECT revision FROM warehouse_pallet_sources"))[0]
          ?.revision,
      ).toBe(source.revision);
    } finally {
      db.close();
    }
  },
);
