import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { applyMigrations } from "../src/lib/mirror";
import { makeRotatingExec } from "./support/sqlite-exec";
import { warehousePreparedJobInput, seedWarehouseOperator } from "./support/warehouse-reprint";
import {
  saveWarehouseSession,
  prepareWarehouseJob,
  appendWarehouseEvent,
} from "../src/lib/warehouse-reprint/store";
import { syncWarehouseEvents } from "../src/lib/warehouse-reprint/sync";
import type { StationClient } from "../src/lib/api-client";
it("acknowledges only the exact sent batch and retains quarantined and concurrent facts", async () => {
  const db = new DatabaseSync(":memory:");
  const exec = makeRotatingExec([db, db]);
  await applyMigrations(exec);
  const i = warehousePreparedJobInput();
  await seedWarehouseOperator(exec, i.operatorId);
  try {
    await saveWarehouseSession(exec, {
      owner: i.owner,
      sessionId: i.sessionId,
      operatorId: i.operatorId,
      reason: i.reason,
      status: "active",
      unitTemplate: null,
      boxTemplate: i.template,
    });
    await prepareWarehouseJob(exec, i);
    const client = {
      post: vi.fn(async () => {
        await appendWarehouseEvent(exec, i.owner, {
          kind: "sending",
          eventId: crypto.randomUUID(),
          jobId: i.jobId,
          sessionId: i.sessionId,
          attemptId: i.preparedEvent.attemptId,
          operatorId: i.operatorId,
          sequence: 2,
          occurredAt: i.preparedEvent.occurredAt,
        });
        return {
          protocol: "warehouse-label-reprint-v1",
          acceptedEventIds: [i.preparedEvent.eventId],
          quarantined: [],
        };
      }),
    } as unknown as StationClient;
    await syncWarehouseEvents(exec, client, i.owner, () => true);
    expect(
      await exec.all(
        "SELECT sequence,receive_status FROM warehouse_reprint_events ORDER BY sequence",
      ),
    ).toEqual([
      { sequence: 1, receive_status: "accepted" },
      { sequence: 2, receive_status: "pending" },
    ]);
    const mismatch = {
      post: vi.fn().mockResolvedValue({
        protocol: "warehouse-label-reprint-v1",
        acceptedEventIds: [crypto.randomUUID()],
        quarantined: [],
      }),
    } as unknown as StationClient;
    await expect(syncWarehouseEvents(exec, mismatch, i.owner, () => true)).rejects.toThrow(
      "WAREHOUSE_RECEIPT_MISMATCH",
    );
    expect(
      (
        await exec.all<{ receive_status: string }>(
          "SELECT receive_status FROM warehouse_reprint_events WHERE sequence=2",
        )
      )[0]?.receive_status,
    ).toBe("pending");
  } finally {
    db.close();
  }
});

it("uploads local production before dependent warehouse history through the full engine", async () => {
  const { createSyncEngine } = await import("../src/lib/sync");
  const { createCredentialGeneration, credentialGenerationOwnership } =
    await import("../src/lib/credential-recovery");
  const db = new DatabaseSync(":memory:");
  const exec = makeRotatingExec([db, db]);
  await applyMigrations(exec);
  const generation = createCredentialGeneration("sync-key");
  const owner = await credentialGenerationOwnership(generation);
  if (!owner) throw new Error("owner missing");
  const i = { ...warehousePreparedJobInput(), owner };
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
  await exec.run(
    "INSERT INTO outbox(shift_id,terminal_id,raw,verdict,scanned_at,code_hash,gtin14,serial) VALUES(?,?,?,'ok',?,?,?,?)",
    [
      i.source.sourceShiftId,
      "terminal",
      "raw",
      i.preparedEvent.occurredAt,
      "a".repeat(64),
      "04600682000013",
      "serial",
    ],
  );
  await exec.run(
    "INSERT INTO boxes_mirror(box_id,shift_id,sscc,opened_at,closed_at) VALUES(?,?,?,?,?)",
    [
      i.source.sourceId,
      i.source.sourceShiftId,
      i.source.identity,
      i.preparedEvent.occurredAt,
      i.preparedEvent.occurredAt,
    ],
  );
  let sourceUploaded = false;
  const post = vi.fn(async (path: string) => {
    if (path === "/station/scans") {
      sourceUploaded = true;
      return { applied: 1, alreadyApplied: false };
    }
    if (path === "/station/warehouse-reprint/event-batches")
      return {
        protocol: "warehouse-label-reprint-v1",
        acceptedEventIds: sourceUploaded ? [i.preparedEvent.eventId] : [],
        quarantined: sourceUploaded
          ? []
          : [{ eventId: i.preparedEvent.eventId, code: "source_not_printable" }],
      };
    return {};
  });
  const client = { post } as unknown as StationClient;
  const engine = createSyncEngine({
    exec,
    client,
    machineId: "local",
    credentialGeneration: generation,
    onState: () => {},
  });
  try {
    engine.nudge();
    await engine.idle();
    expect(sourceUploaded).toBe(true);
    expect(await exec.all("SELECT receive_status FROM warehouse_reprint_events")).toEqual([
      { receive_status: "accepted" },
    ]);
    const paths = post.mock.calls.map(([path]) => path);
    expect(paths.indexOf("/station/scans")).toBeLessThan(
      paths.indexOf("/station/warehouse-reprint/event-batches"),
    );
  } finally {
    engine.stop();
    db.close();
  }
});
