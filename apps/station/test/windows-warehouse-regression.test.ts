import { purgeWarehouseJobs } from "../src/lib/warehouse-reprint/retention.js";
// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { encodeMonoRaster, productLabelBytesDigest } from "@markiro/domain";
import { applyMigrations } from "../src/lib/mirror.js";
import { bytesToBase64, tauriWindowsPrinting } from "../src/lib/hardware.js";
import { makeRotatingExec } from "./support/sqlite-exec.js";
import { warehousePreparedJobInput, seedWarehouseOperator } from "./support/warehouse-reprint.js";
import {
  prepareWarehouseJob,
  saveWarehouseSession,
  readWarehouseJob,
  appendWarehouseEvent,
  warehouseJobView,
  findWarehouseJobView,
} from "../src/lib/warehouse-reprint/store.js";
import { printWarehouseJob, reprintWarehouseJob } from "../src/lib/warehouse-reprint/printing.js";
import { resolvePrintDelivery, readPrintDelivery } from "../src/lib/print-deliveries.js";
afterEach(() => vi.restoreAllMocks());
async function setup(format: "mono-raster-v1" | "zpl" | "tspl" = "mono-raster-v1") {
  const db = new DatabaseSync(":memory:");
  const exec = makeRotatingExec([db, db]);
  await applyMigrations(exec);
  const original = warehousePreparedJobInput();
  const bytes = encodeMonoRaster({
    format: "mono-raster-v1",
    widthMm: 10,
    heightMm: 10,
    dpi: 203,
    widthDots: 80,
    heightDots: 80,
    stride: 10,
    requiredBounds: { left: 0, top: 0, right: 0, bottom: 0 },
    pixels: new Uint8Array(800),
  });
  const { language, printFormat, ...event } = original.preparedEvent;
  void language;
  void printFormat;
  const rasterInput = {
    ...original,
    printer: {
      ...original.printer,
      mode: "windows_driver" as const,
      target: { kind: "usb" as const, printer: "Queue" },
    },
    bytesBase64: bytesToBase64(bytes),
    bytesDigest: productLabelBytesDigest(bytes),
    preparedEvent: {
      ...event,
      printFormat: "mono-raster-v1" as const,
      bytesDigest: productLabelBytesDigest(bytes),
    },
  };
  const input =
    format === "mono-raster-v1"
      ? rasterInput
      : {
          ...original,
          printer: { ...original.printer, language: format },
          preparedEvent: { ...event, language: format },
        };
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
  vi.spyOn(tauriWindowsPrinting, "preflightWindowsRaster").mockResolvedValue({ ok: true });
  const send = vi
    .spyOn(tauriWindowsPrinting, "printWindowsRaster")
    .mockImplementation(async (queue, _, documentName) => ({
      ok: true,
      receipt: { queue, jobId: 42, documentName },
    }));
  const deps = {
    exec,
    owner: input.owner,
    operatorId: input.operatorId,
    profile: input.printer,
    print: vi.fn(),
    isCurrent: () => true,
  };
  const key = {
    scope: input.owner,
    purpose: "box" as const,
    jobId: input.jobId,
    attemptId: input.preparedEvent.attemptId,
  };
  return { db, exec, input, bytes, send, deps, key };
}
it("replays a Windows page on a compatible queue with another remembered RAW language", async () => {
  const w = await setup();
  try {
    await printWarehouseJob(w.deps, w.input.jobId);
    await reprintWarehouseJob(
      { ...w.deps, profile: { ...w.input.printer, language: "zpl" } },
      w.input.jobId,
      "damaged",
    );
    const job = await readWarehouseJob(w.exec, w.input.owner, w.input.jobId);
    expect(job.projection.state).toBe("sent");
    expect(job.bytesBase64).toBe(w.input.bytesBase64);
    expect(w.send).toHaveBeenCalledTimes(2);
    expect(w.send.mock.calls[1]?.[1]).toEqual(w.bytes);
  } finally {
    w.db.close();
  }
});
it("does not dispatch when the controller closes during driver preflight", async () => {
  const w = await setup();
  let current = true;
  try {
    vi.mocked(tauriWindowsPrinting.preflightWindowsRaster).mockImplementation(async () => {
      current = false;
      return { ok: true };
    });
    await printWarehouseJob({ ...w.deps, isCurrent: () => current }, w.input.jobId);
    expect(w.send).not.toHaveBeenCalled();
    expect((await readWarehouseJob(w.exec, w.input.owner, w.input.jobId)).projection.state).toBe(
      "failed_before_send",
    );
    expect((await readPrintDelivery(w.exec, w.key))?.state).toBe("failed_before_send");
  } finally {
    w.db.close();
  }
});
it("resolves the unknown sidecar atomically with the verified journal projection", async () => {
  const w = await setup();
  try {
    w.send.mockResolvedValue({
      ok: false,
      error: { code: "driver_failure", phase: "delivery_unknown" },
    });
    await printWarehouseJob(w.deps, w.input.jobId);
    const job = await readWarehouseJob(w.exec, w.input.owner, w.input.jobId);
    await appendWarehouseEvent(w.exec, w.input.owner, {
      kind: "verified",
      eventId: crypto.randomUUID(),
      jobId: job.jobId,
      sessionId: job.sessionId,
      attemptId: job.projection.attemptId,
      operatorId: job.operatorId,
      occurredAt: new Date().toISOString(),
      sequence: job.projection.latestSequence + 1,
    });
    expect((await readPrintDelivery(w.exec, w.key))?.resolved_at).not.toBeNull();
  } finally {
    w.db.close();
  }
});

it("retains an unresolved sidecar without aborting the warehouse retention sweep", async () => {
  const w = await setup();
  try {
    await printWarehouseJob(w.deps, w.input.jobId);
    await w.exec.run("UPDATE printer_deliveries SET state='delivery_unknown' WHERE job_id=?", [
      w.input.jobId,
    ]);
    await w.exec.run("UPDATE warehouse_reprint_events SET receive_status='accepted'");
    const session = {
      owner: w.input.owner,
      sessionId: w.input.sessionId,
      operatorId: w.input.operatorId,
      reason: w.input.reason,
      status: "paused" as const,
      unitTemplate: null,
      boxTemplate: w.input.template,
    };
    await saveWarehouseSession(w.exec, session);
    await saveWarehouseSession(w.exec, { ...session, sessionId: crypto.randomUUID() });
    await purgeWarehouseJobs(w.exec, w.input.owner, "2099-01-01T00:00:00.000Z");
    expect(await w.exec.all("SELECT job_id FROM warehouse_reprint_jobs")).toHaveLength(1);
    await resolvePrintDelivery(w.exec, w.key);
    await purgeWarehouseJobs(w.exec, w.input.owner, "2099-01-01T00:00:00.000Z");
    expect(await w.exec.all("SELECT job_id FROM warehouse_reprint_jobs")).toHaveLength(0);
    expect(await readPrintDelivery(w.exec, w.key)).toBeNull();
  } finally {
    w.db.close();
  }
});

it("records a proven pre-StartDoc rejection as failed before send in both journals", async () => {
  const w = await setup();
  try {
    w.send.mockResolvedValue({
      ok: false,
      error: { code: "driver_failure", phase: "before_start" },
    });
    await printWarehouseJob(w.deps, w.input.jobId);
    expect((await readPrintDelivery(w.exec, w.key))?.state).toBe("failed_before_send");
    expect((await readWarehouseJob(w.exec, w.input.owner, w.input.jobId)).projection.state).toBe(
      "failed_before_send",
    );
  } finally {
    w.db.close();
  }
});

it("classifies a driver preflight rejection before send and rerenders a corrected-DPI attempt", async () => {
  const w = await setup();
  try {
    vi.mocked(tauriWindowsPrinting.preflightWindowsRaster).mockResolvedValueOnce({
      ok: false,
      error: { code: "geometry_mismatch", phase: "before_start" },
    });
    await printWarehouseJob(w.deps, w.input.jobId);
    const failed = await readWarehouseJob(w.exec, w.input.owner, w.input.jobId);
    expect(failed.projection.state).toBe("failed_before_send");
    expect(w.send).not.toHaveBeenCalled();
    await reprintWarehouseJob(
      {
        ...w.deps,
        profile: { ...w.input.printer, dpi: 300 },
        rasterizeText: async () => ({
          hex: "80",
          bytesPerRow: 1,
          totalBytes: 1,
          width: 1,
          height: 1,
        }),
      },
      w.input.jobId,
      "not_printed",
    );
    const next = await readWarehouseJob(w.exec, w.input.owner, w.input.jobId);
    expect(next.projection.state).toBe("sent");
    expect(next.printer.dpi).toBe(300);
    expect(next.bytesDigest).not.toBe(failed.bytesDigest);
    expect(next.preparedEvent.bytesDigest).toBe(failed.preparedEvent.bytesDigest);
    expect(next.fields).toEqual(failed.fields);
    expect(next.template).toEqual(failed.template);
    expect(w.send).toHaveBeenCalledTimes(1);
    expect(await w.exec.all("SELECT attempt_id FROM warehouse_reprint_attempts")).toHaveLength(2);
  } finally {
    w.db.close();
  }
});

it("never changes the saved raster or DPI after uncertain warehouse delivery", async () => {
  const w = await setup();
  try {
    w.send.mockResolvedValueOnce({
      ok: false,
      error: { code: "driver_failure", phase: "delivery_unknown" },
    });
    await printWarehouseJob(w.deps, w.input.jobId);
    await expect(
      reprintWarehouseJob(
        { ...w.deps, profile: { ...w.input.printer, dpi: 300 } },
        w.input.jobId,
        "not_printed",
      ),
    ).rejects.toThrow("WAREHOUSE_PRINTER_CHANGED");
    const saved = await readWarehouseJob(w.exec, w.input.owner, w.input.jobId);
    expect(saved.projection.state).toBe("delivery_unknown");
    expect(saved.bytesBase64).toBe(w.input.bytesBase64);
    expect(saved.projection.attemptNo).toBe(1);
    expect(w.send).toHaveBeenCalledTimes(1);
  } finally {
    w.db.close();
  }
});

it.each(["mono-raster-v1", "zpl", "tspl"] as const)(
  "recovers a committed %s replacement after its database response is lost",
  async (format) => {
    const w = await setup();
    try {
      vi.mocked(tauriWindowsPrinting.preflightWindowsRaster).mockResolvedValueOnce({
        ok: false,
        error: { code: "geometry_mismatch", phase: "before_start" },
      });
      await printWarehouseJob(w.deps, w.input.jobId);
      const corrected = {
        ...w.input.printer,
        dpi: 300 as const,
        mode: format === "mono-raster-v1" ? ("windows_driver" as const) : ("raw" as const),
        language: format === "mono-raster-v1" ? ("zpl" as const) : format,
      };
      const faulty: typeof w.exec = {
        all: w.exec.all,
        run: async (sql, params) => {
          await w.exec.run(sql, params);
          if (sql.includes("INSERT INTO warehouse_reprint_commands"))
            throw new Error("Lost commit response");
        },
      };
      await expect(
        reprintWarehouseJob(
          {
            ...w.deps,
            exec: faulty,
            profile: corrected,
            rasterizeText: async () => ({
              hex: "80",
              bytesPerRow: 1,
              totalBytes: 1,
              width: 1,
              height: 1,
            }),
          },
          w.input.jobId,
          "not_printed",
        ),
      ).rejects.toThrow("Lost commit response");
      const restored = await readWarehouseJob(w.exec, w.input.owner, w.input.jobId);
      expect(restored.projection).toMatchObject({
        state: "prepared",
        attemptNo: 2,
        raster: { dpi: 300, bytesDigest: restored.bytesDigest },
      });
      expect(w.send).not.toHaveBeenCalled();
      expect(w.deps.print).not.toHaveBeenCalled();
      const send = format === "mono-raster-v1" ? w.send : w.deps.print;
      await printWarehouseJob({ ...w.deps, profile: corrected }, w.input.jobId);
      expect((await readWarehouseJob(w.exec, w.input.owner, w.input.jobId)).projection.state).toBe(
        "sent",
      );
      expect(send).toHaveBeenCalledTimes(1);
      expect(
        await w.exec.all(
          "SELECT event_id FROM warehouse_reprint_events WHERE json_extract(event_json,'$.kind')='reprint_prepared'",
        ),
      ).toHaveLength(1);
    } finally {
      w.db.close();
    }
  },
);

it.each([
  ["mono-raster-v1", "zpl"],
  ["mono-raster-v1", "tspl"],
  ["zpl", "mono-raster-v1"],
  ["tspl", "mono-raster-v1"],
  ["zpl", "tspl"],
  ["tspl", "zpl"],
] as const)(
  "recovers an unsent %s job in %s with frozen source and attempt history",
  async (from, to) => {
    const w = await setup(from);
    try {
      if (from === "mono-raster-v1") {
        vi.mocked(tauriWindowsPrinting.preflightWindowsRaster).mockResolvedValueOnce({
          ok: false,
          error: { code: "geometry_mismatch", phase: "before_start" },
        });
        await printWarehouseJob(w.deps, w.input.jobId);
      } else {
        await printWarehouseJob({ ...w.deps, profile: null }, w.input.jobId);
      }
      const profile = {
        ...w.input.printer,
        mode: to === "mono-raster-v1" ? ("windows_driver" as const) : ("raw" as const),
        language: to === "mono-raster-v1" ? ("zpl" as const) : to,
        target: { kind: "usb" as const, printer: "Replacement queue" },
      };
      await reprintWarehouseJob(
        {
          ...w.deps,
          profile,
          rasterizeText: async () => ({
            hex: "80",
            bytesPerRow: 1,
            totalBytes: 1,
            width: 1,
            height: 1,
          }),
        },
        w.input.jobId,
        "not_printed",
      );
      const next = await readWarehouseJob(w.exec, w.input.owner, w.input.jobId);
      expect(next.projection.state).toBe("sent");
      expect(next.preparedEvent).toEqual(w.input.preparedEvent);
      expect(next.source).toEqual(w.input.source);
      expect(next.template).toEqual(w.input.template);
      expect(next.bytesDigest).not.toBe(w.input.bytesDigest);
      expect(next.projection.attemptNo).toBe(2);
      const scope = to === "mono-raster-v1" ? w.input.owner : undefined;
      expect(warehouseJobView(next).printScope).toBe(scope);
      expect(
        (await findWarehouseJobView(w.exec, w.input.owner, { jobId: w.input.jobId }))?.printScope,
      ).toBe(scope);
      const calls = to === "mono-raster-v1" ? w.send : w.deps.print;
      expect(calls).toHaveBeenCalledTimes(1);
      const sentBytes = calls.mock.calls[0]?.[1];
      expect(sentBytes).toEqual(Uint8Array.from(atob(next.bytesBase64), (c) => c.charCodeAt(0)));
      if (to !== "mono-raster-v1") {
        expect(new TextDecoder().decode(sentBytes)).toContain(to === "zpl" ? "^XA" : "SIZE");
      }
      await reprintWarehouseJob({ ...w.deps, profile }, w.input.jobId, "damaged");
      expect((await readWarehouseJob(w.exec, w.input.owner, w.input.jobId)).bytesBase64).toBe(
        next.bytesBase64,
      );
      expect(calls).toHaveBeenCalledTimes(2);
      expect(await w.exec.all("SELECT attempt_id FROM warehouse_reprint_attempts")).toHaveLength(3);
    } finally {
      w.db.close();
    }
  },
);

it.each(["sent", "delivery_unknown"] as const)(
  "rejects format changes after %s without creating an attempt",
  async (state) => {
    const w = await setup();
    try {
      if (state === "delivery_unknown")
        w.send.mockResolvedValueOnce({
          ok: false,
          error: { code: "driver_failure", phase: "delivery_unknown" },
        });
      await printWarehouseJob(w.deps, w.input.jobId);
      await expect(
        reprintWarehouseJob(
          { ...w.deps, profile: { ...w.input.printer, mode: "raw", language: "zpl" } },
          w.input.jobId,
          "not_printed",
        ),
      ).rejects.toThrow("WAREHOUSE_PRINTER_CHANGED");
      const saved = await readWarehouseJob(w.exec, w.input.owner, w.input.jobId);
      expect(saved.projection).toMatchObject({ state, attemptNo: 1 });
      expect(saved.bytesBase64).toBe(w.input.bytesBase64);
      expect(w.deps.print).not.toHaveBeenCalled();
      expect(await w.exec.all("SELECT attempt_id FROM warehouse_reprint_attempts")).toHaveLength(1);
    } finally {
      w.db.close();
    }
  },
);
