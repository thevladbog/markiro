// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { tauriHardware } from "../src/lib/hardware.js";
import { applyMigrations } from "../src/lib/mirror.js";
import { printWarehouseJob, recoverWarehouseJobs } from "../src/lib/warehouse-reprint/printing.js";
import {
  prepareWarehouseJob,
  readWarehouseJob,
  saveWarehouseSession,
} from "../src/lib/warehouse-reprint/store.js";
import { makeRotatingExec } from "./support/sqlite-exec.js";
import { seedWarehouseOperator, warehousePreparedJobInput } from "./support/warehouse-reprint.js";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

it("releases recovery after a USB IPC timeout and preserves frozen bytes without resending", async () => {
  const db = new DatabaseSync(":memory:");
  const exec = makeRotatingExec([db, db]);
  const input = warehousePreparedJobInput();
  input.printer.target = { kind: "usb", printer: "TSC 210" };
  await applyMigrations(exec);
  await seedWarehouseOperator(exec, input.operatorId);
  await saveWarehouseSession(exec, {
    owner: input.owner,
    sessionId: input.sessionId,
    operatorId: input.operatorId,
    reason: input.reason,
    status: "active",
    unitTemplate: null,
    boxTemplate: input.template,
  });
  await prepareWarehouseJob(exec, input);
  let started: () => void = () => {};
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  let rejectTransport: (error: Error) => void = () => {};
  const transport = new Promise<never>((_resolve, reject) => {
    rejectTransport = reject;
  });
  vi.mocked(invoke).mockImplementation(async () => {
    started();
    return transport;
  });
  const sending = printWarehouseJob(
    {
      exec,
      owner: input.owner,
      operatorId: input.operatorId,
      profile: input.printer,
      print: tauriHardware.print,
      isCurrent: () => true,
    },
    input.jobId,
  );
  let recovery: Promise<void> | undefined;
  try {
    await entered;
    expect((await readWarehouseJob(exec, input.owner, input.jobId)).projection.state).toBe(
      "sending",
    );
    recovery = recoverWarehouseJobs(exec, input.owner, input.operatorId);
    rejectTransport(new Error("USB print spooler timed out; delivery is unknown"));
    await Promise.all([sending, recovery]);
    const saved = await readWarehouseJob(exec, input.owner, input.jobId);
    expect(saved.projection.state).toBe("delivery_unknown");
    expect(saved.bytesBase64).toBe(input.bytesBase64);
    await recoverWarehouseJobs(exec, input.owner, input.operatorId);
    expect(vi.mocked(invoke).mock.calls).toEqual([
      ["print_bytes", { target: input.printer.target, payloadBase64: input.bytesBase64 }],
    ]);
    expect(
      await exec.all(
        "SELECT json_extract(event_json,'$.kind') AS kind, json_extract(event_json,'$.errorCode') AS errorCode FROM warehouse_reprint_events ORDER BY sequence",
      ),
    ).toEqual([
      { kind: "prepared", errorCode: null },
      { kind: "sending", errorCode: null },
      { kind: "delivery_unknown", errorCode: "transport_failed" },
    ]);
  } finally {
    rejectTransport(new Error("test cleanup"));
    await Promise.allSettled([sending, recovery]);
    db.close();
  }
});
