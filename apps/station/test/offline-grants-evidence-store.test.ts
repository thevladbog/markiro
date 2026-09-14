import { DatabaseSync } from "node:sqlite";
import { STATION_MIGRATIONS } from "@markiro/db/station-sqlite";
import { describe, expect, it } from "vitest";
import { createCredentialGeneration } from "../src/lib/credential-recovery.js";
import type { SqlExecutor } from "../src/lib/mirror.js";
import {
  sendStationEvidence,
  stationEvidenceCommitExecutor,
} from "../src/lib/offline-grants/evidence-store.js";

function fixture() {
  const db = new DatabaseSync(":memory:");
  for (const sql of STATION_MIGRATIONS) {
    try {
      db.exec(sql);
    } catch (error) {
      if (!/duplicate column name/.test(String(error))) throw error;
    }
  }
  const exec: SqlExecutor = {
    async atomic(statements) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const changes = statements.map((statement) =>
          Number(db.prepare(statement.sql).run(...((statement.values ?? []) as never[])).changes),
        );
        db.exec("COMMIT");
        return changes;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    async run(sql, values = []) {
      db.prepare(sql).run(...(values as never[]));
    },
    async all<T>(sql: string, values: readonly unknown[] = []) {
      return db.prepare(sql).all(...(values as never[])) as T[];
    },
  };
  return { db, exec };
}
const receipt = {
  protocol: "offline-grants-v1",
  batchId: "batch",
  outcome: "accepted",
  reason: null,
  receiptId: "22222222-2222-4222-8222-222222222222",
  reconciliation: { status: "applied", statusCode: 201, result: { ok: true } },
};

describe("Station durable evidence receipt", () => {
  it("retains the queue pin but no receipt when device ownership changes during POST", async () => {
    const { db, exec } = fixture();
    await expect(
      sendStationEvidence({
        exec,
        generation: createCredentialGeneration("old-secret"),
        key: "late",
        path: "/evidence",
        batchId: "batch",
        payload: { raw: "original" },
        links: [],
        client: {
          async post() {
            db.exec(
              "INSERT INTO station_device_recovery VALUES(1,'machine','other-owner','active','other-hash',NULL)",
            );
            return receipt;
          },
        },
      }),
    ).rejects.toThrow(/owner/);
    expect(
      db
        .prepare(
          "SELECT count(*) count FROM station_meta WHERE key LIKE 'offline_grant_evidence_pin:%'",
        )
        .get(),
    ).toEqual({ count: 1 });
    expect(
      db
        .prepare(
          "SELECT count(*) count FROM station_meta WHERE key LIKE 'offline_grant_evidence_receipt:%'",
        )
        .get(),
    ).toEqual({ count: 0 });
    db.close();
  });

  it("fences a durable owner switch after preparation before the actual ACK transaction", async () => {
    const { db, exec } = fixture();
    const generation = createCredentialGeneration("old-secret");
    const guarded = await stationEvidenceCommitExecutor(exec, generation);
    db.exec("INSERT INTO station_meta VALUES('queued','original')");
    db.exec(
      "INSERT INTO station_device_recovery VALUES(1,'machine','new-owner','active','new-hash',NULL)",
    );
    await expect(guarded.run("DELETE FROM station_meta WHERE key='queued'")).rejects.toThrow(
      /OWNER/,
    );
    expect(db.prepare("SELECT value FROM station_meta WHERE key='queued'").get()).toEqual({
      value: "original",
    });
    db.close();
  });

  it("replays original native bytes after an unknown outcome and restart, then repairs ACK without another POST", async () => {
    const { db, exec } = fixture();
    const bodies: unknown[] = [];
    const input = {
      exec,
      generation: createCredentialGeneration("same-secret"),
      key: "scans:batch",
      path: "/evidence",
      batchId: "batch",
      payload: { raw: "ABC\u001d93tail", printed: false },
      links: [],
      client: {
        async post(_path: string, body?: unknown) {
          bodies.push(body);
          throw new Error("response lost");
        },
      },
    };
    await expect(sendStationEvidence(input)).rejects.toThrow("response lost");
    const recovered = {
      ...input,
      generation: createCredentialGeneration("same-secret"),
      payload: { raw: "changed", printed: true },
      client: {
        async post(_path: string, body?: unknown) {
          bodies.push(body);
          return receipt;
        },
      },
    };
    expect(await sendStationEvidence(recovered)).toEqual({ ok: true });
    expect(bodies[1]).toEqual(bodies[0]);
    expect(
      await sendStationEvidence({
        ...input,
        generation: createCredentialGeneration("same-secret"),
      }),
    ).toEqual({ ok: true });
    expect(bodies).toHaveLength(2);
    await expect(
      sendStationEvidence({ ...recovered, generation: createCredentialGeneration("other-secret") }),
    ).rejects.toThrow(/owner/);
    db.close();
  });
  it("retains a quarantined receipt and never acknowledges or falls back", async () => {
    const { db, exec } = fixture();
    let calls = 0;
    const input = {
      exec,
      generation: createCredentialGeneration("secret"),
      key: "scan:batch",
      path: "/evidence",
      batchId: "batch",
      payload: { items: [] },
      links: [],
      client: {
        async post() {
          calls++;
          return {
            ...receipt,
            outcome: "quarantined",
            reason: "late_no_proof",
            reconciliation: { status: "not_applied", statusCode: null, result: null },
          };
        },
      },
    };
    await expect(sendStationEvidence(input)).rejects.toThrow(/late_no_proof/);
    await expect(sendStationEvidence(input)).rejects.toThrow(/late_no_proof/);
    expect(calls).toBe(1);
    db.close();
  });
});
