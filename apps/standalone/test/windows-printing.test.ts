import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  DRIVER_FAILED_CODES,
  WINDOWS_DRIVER_CODES,
  createTauriWindowsPrinting,
  windowsJobObservationSchema,
  windowsPrintOutcomeSchema,
  windowsPrintResult,
} from "../src/hardware/hardware.js";
import type { PrintResult } from "../src/hardware/hardware.js";
import { FAILED_CODES, UNKNOWN_CODES, settleOutcome } from "../src/floor/print/print-jobs.js";

// Bind the module URL before use (see test/hardware.test.ts).
const moduleUrl = import.meta.url;
const SHAPES_URL = new URL("../src-tauri/tests/fixtures/hardware-shapes.json", moduleUrl);

const QUEUE = "Godex G500";
const DOCUMENT = "Markiro:7d1c2a8e-3b4f-4c5d-9e6f-0a1b2c3d4e5f";
const RECEIPT = { queue: QUEUE, jobId: 42, documentName: DOCUMENT };

describe("the driver printing answers the shell sends", () => {
  it("are the shapes the shell's fixture pins, parsed strictly", () => {
    const shapes: Record<string, unknown> = JSON.parse(readFileSync(SHAPES_URL, "utf8"));
    for (const key of [
      "windowsPrintSent",
      "windowsPrintSentAdjusted",
      "windowsPrintUnknown",
      "windowsPrintRefused",
      "windowsPrintRefusedDiagnostic",
    ]) {
      expect(windowsPrintOutcomeSchema.parse(shapes[key]), key).toEqual(shapes[key]);
    }
    for (const key of [
      "windowsJobPresent",
      "windowsJobAbsent",
      "windowsJobIdentityMismatch",
      "windowsJobUnavailable",
    ]) {
      expect(windowsJobObservationSchema.parse(shapes[key]), key).toEqual(shapes[key]);
    }
    // The file pins two shapes of the scanners/printers and nine driver answers.
    expect(Object.keys(shapes)).toHaveLength(11);
    // A sheet that was moved says how far, and a refusal brings its numbers (beta 3.2).
    expect(windowsPrintResult(shapes["windowsPrintSentAdjusted"], QUEUE, DOCUMENT)).toEqual({
      sent: true,
      receipt: RECEIPT,
      adjusted: { percent: 100, shiftXMm: 0, shiftYMm: -3.2 },
    });
    expect(windowsPrintResult(shapes["windowsPrintRefusedDiagnostic"], QUEUE, DOCUMENT)).toEqual({
      sent: false,
      code: "geometry_mismatch",
      diagnostic:
        "reason=printable_too_small dpi=600x600 page_mm=210x297 printable_mm=159.2x246.2 needs_mm=190x277",
    });
    expect(
      windowsPrintOutcomeSchema.safeParse({ ok: true, receipt: RECEIPT, extra: 1 }).success,
    ).toBe(false);
  });
});

describe("windowsPrintResult", () => {
  const before = (code: string) => ({ ok: false, error: { code, phase: "before_start" } });

  it("is sent with its receipt only when the receipt names this queue and document", () => {
    expect(windowsPrintResult({ ok: true, receipt: RECEIPT }, QUEUE, DOCUMENT)).toEqual({
      sent: true,
      receipt: RECEIPT,
    });
    expect(
      windowsPrintResult({ ok: true, receipt: { ...RECEIPT, queue: "Other" } }, QUEUE, DOCUMENT),
    ).toEqual({ sent: false, code: "driver_unknown" });
  });

  it("reads a refusal before the start as a code that cannot double a label", () => {
    expect(windowsPrintResult(before("unsupported_platform"), QUEUE, DOCUMENT)).toEqual({
      sent: false,
      code: "unsupported",
    });
    expect(windowsPrintResult(before("invalid_artifact"), QUEUE, DOCUMENT)).toEqual({
      sent: false,
      code: "invalid_payload",
    });
    expect(windowsPrintResult(before("queue_unavailable"), QUEUE, DOCUMENT)).toEqual({
      sent: false,
      code: "queue_unavailable",
    });
    expect(windowsPrintResult(before("geometry_mismatch"), QUEUE, DOCUMENT)).toEqual({
      sent: false,
      code: "geometry_mismatch",
    });
    expect(windowsPrintResult(before("driver_failure"), QUEUE, DOCUMENT)).toEqual({
      sent: false,
      code: "driver_not_started",
    });
  });

  it("reads a delivery in doubt, an answer of no known shape, as driver_unknown", () => {
    const unknown = {
      ok: false,
      error: { code: "driver_failure", phase: "delivery_unknown", receipt: RECEIPT },
    };
    expect(windowsPrintResult(unknown, QUEUE, DOCUMENT)).toEqual({
      sent: false,
      code: "driver_unknown",
      receipt: RECEIPT,
    });
    expect(
      windowsPrintResult(
        { ok: false, error: { code: "driver_failure", phase: "delivery_unknown" } },
        QUEUE,
        DOCUMENT,
      ),
    ).toEqual({ sent: false, code: "driver_unknown" });
    expect(
      "receipt" in
        windowsPrintResult(
          { ok: false, error: { code: "driver_failure", phase: "delivery_unknown" } },
          QUEUE,
          DOCUMENT,
        ),
    ).toBe(false);
    expect(windowsPrintResult(null, QUEUE, DOCUMENT)).toEqual({
      sent: false,
      code: "driver_unknown",
    });
    expect(windowsPrintResult({ ok: true }, QUEUE, DOCUMENT)).toEqual({
      sent: false,
      code: "driver_unknown",
    });
  });
});

describe("createTauriWindowsPrinting", () => {
  it("asks the shell's driver commands by name with the page as base64", async () => {
    const call = vi.fn(async (command: string) =>
      command === "print_windows_raster" ? { ok: true, receipt: RECEIPT } : true,
    );
    const windows = createTauriWindowsPrinting(call);
    await expect(windows.supportsWindowsPrinting()).resolves.toBe(true);
    await expect(
      windows.printWindowsRaster(QUEUE, new Uint8Array([65]), DOCUMENT),
    ).resolves.toEqual({ sent: true, receipt: RECEIPT });
    expect(call).toHaveBeenCalledWith("supports_windows_printing", {});
    expect(call).toHaveBeenCalledWith("print_windows_raster", {
      queue: QUEUE,
      payloadBase64: "QQ==",
      documentName: DOCUMENT,
    });
  });

  it("asks the driver for an A4 page only when told", async () => {
    const call = vi.fn(async (_command: string, _args?: Record<string, unknown>) => ({
      ok: true,
      receipt: RECEIPT,
    }));
    const windows = createTauriWindowsPrinting(call);
    await windows.printWindowsRaster(QUEUE, new Uint8Array([65]), DOCUMENT, "a4");
    expect(call).toHaveBeenLastCalledWith("print_windows_raster", {
      queue: QUEUE,
      payloadBase64: "QQ==",
      documentName: DOCUMENT,
      paper: "a4",
    });
    await windows.printWindowsRaster(QUEUE, new Uint8Array([65]), DOCUMENT);
    // No `paper` key at all, not a `paper: undefined` one: the label path is as it was.
    const labelArgs = call.mock.lastCall?.[1];
    expect(Object.keys(labelArgs ?? {}).sort()).toEqual(["documentName", "payloadBase64", "queue"]);
    await windows.printWindowsRaster(QUEUE, new Uint8Array([65]), DOCUMENT, undefined);
    expect(Object.keys(call.mock.lastCall?.[1] ?? {})).not.toContain("paper");
  });

  it("answers an A4 print like any other: the receipt of the job, or its refusal", async () => {
    const refused = { ok: false, error: { code: "geometry_mismatch", phase: "before_start" } };
    const call = vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>(
      async () => refused,
    );
    const windows = createTauriWindowsPrinting(call);
    await expect(
      windows.printWindowsRaster(QUEUE, new Uint8Array([65]), DOCUMENT, "a4"),
    ).resolves.toEqual({ sent: false, code: "geometry_mismatch" });
    call.mockResolvedValueOnce({ ok: true, receipt: RECEIPT });
    await expect(
      windows.printWindowsRaster(QUEUE, new Uint8Array([65]), DOCUMENT, "a4"),
    ).resolves.toEqual({ sent: true, receipt: RECEIPT });
  });

  it("never throws: a failed call is unknown for a print, false and unavailable for questions", async () => {
    const call = vi.fn(async () => {
      throw new Error("ipc");
    });
    const windows = createTauriWindowsPrinting(call);
    await expect(windows.supportsWindowsPrinting()).resolves.toBe(false);
    await expect(windows.printWindowsRaster(QUEUE, new Uint8Array([1]), DOCUMENT)).resolves.toEqual(
      {
        sent: false,
        code: "driver_unknown",
      },
    );
    await expect(windows.getWindowsPrintJob(RECEIPT)).resolves.toEqual({ state: "unavailable" });
  });

  it("reads the spooler's observation strictly, anything else as unavailable", async () => {
    const answers: unknown[] = [{ state: "present", statusFlags: 8 }, { state: "gone" }];
    const call = vi.fn(async () => answers.shift());
    const windows = createTauriWindowsPrinting(call);
    await expect(windows.getWindowsPrintJob(RECEIPT)).resolves.toEqual({
      state: "present",
      statusFlags: 8,
    });
    expect(call).toHaveBeenCalledWith("get_windows_print_job", { receipt: RECEIPT });
    await expect(windows.getWindowsPrintJob(RECEIPT)).resolves.toEqual({ state: "unavailable" });
  });
});

// Every code of the shell's `Failure`, before the start, and what a send reads it as. The
// table is typed over `WINDOWS_DRIVER_CODES`: a code added there without a row here does not compile.
const BEFORE_START: Record<(typeof WINDOWS_DRIVER_CODES)[number], PrintResult> = {
  unsupported_platform: { sent: false, code: "unsupported" },
  invalid_artifact: { sent: false, code: "invalid_payload" },
  queue_unavailable: { sent: false, code: "queue_unavailable" },
  geometry_mismatch: { sent: false, code: "geometry_mismatch" },
  driver_failure: { sent: false, code: "driver_not_started" },
};

describe("every answer kind of the shell reads as exactly one result", () => {
  it.each(WINDOWS_DRIVER_CODES)("%s before the start is one fixed code", (code) => {
    expect(
      windowsPrintResult({ ok: false, error: { code, phase: "before_start" } }, QUEUE, DOCUMENT),
    ).toEqual(BEFORE_START[code]);
  });

  it.each(WINDOWS_DRIVER_CODES)(
    "%s with the delivery in doubt is driver_unknown, never a refusal",
    (code) => {
      expect(
        windowsPrintResult(
          { ok: false, error: { code, phase: "delivery_unknown", receipt: RECEIPT } },
          QUEUE,
          DOCUMENT,
        ),
      ).toEqual({ sent: false, code: "driver_unknown", receipt: RECEIPT });
      expect(
        windowsPrintResult(
          { ok: false, error: { code, phase: "delivery_unknown" } },
          QUEUE,
          DOCUMENT,
        ),
      ).toEqual({ sent: false, code: "driver_unknown" });
    },
  );

  it("keeps the refusals that make printing again safe apart from the ones that do not", () => {
    const safe = WINDOWS_DRIVER_CODES.map((code) => BEFORE_START[code]);
    // Each refusal before the start is its own code, so none can stand for another.
    expect(new Set(safe.map((result) => (result.sent ? "sent" : result.code))).size).toBe(
      WINDOWS_DRIVER_CODES.length,
    );
    for (const result of safe) {
      expect(result.sent).toBe(false);
      expect(result.sent ? "" : result.code).not.toBe("driver_unknown");
      expect(result.sent ? "" : result.code).not.toBe("outcome_unknown");
    }
  });
});

describe("an answer of no known shape is never a send that left nothing", () => {
  const unknownCode = { ok: false, error: { code: "weird", phase: "before_start" } };
  const unknownPhase = { ok: false, error: { code: "driver_failure", phase: "later" } };
  const sentWithError = { ok: true, receipt: RECEIPT, error: unknownCode.error };
  const refusedWithReceipt = {
    ok: false,
    error: { code: "driver_failure", phase: "before_start", receipt: RECEIPT, extra: true },
  };
  const refusedWithExtra = {
    ok: false,
    error: { code: "driver_failure", phase: "before_start" },
    extra: 1,
  };
  const badReceipts = [
    { ...RECEIPT, jobId: 0 },
    { ...RECEIPT, jobId: -3 },
    { ...RECEIPT, jobId: 1.5 },
    { ...RECEIPT, queue: "" },
    { ...RECEIPT, documentName: "" },
    { ...RECEIPT, extra: 1 },
    { queue: QUEUE, jobId: 42 },
  ];

  it.each([
    ["an unknown code", unknownCode],
    ["an unknown phase", unknownPhase],
    ["a success with an error beside it", sentWithError],
    ["a refusal whose error has an extra key", refusedWithReceipt],
    ["a refusal with an extra key", refusedWithExtra],
    ["undefined", undefined],
    ["a string", "ok"],
    ["an empty object", {}],
    ["ok as a string", { ok: "true", receipt: RECEIPT }],
    ["a refusal without an error", { ok: false }],
  ])("%s reads as driver_unknown", (_name, raw) => {
    expect(windowsPrintResult(raw, QUEUE, DOCUMENT)).toEqual({
      sent: false,
      code: "driver_unknown",
    });
  });

  it.each(badReceipts)("a sent answer whose receipt is %j reads as driver_unknown", (receipt) => {
    expect(windowsPrintResult({ ok: true, receipt }, QUEUE, DOCUMENT)).toEqual({
      sent: false,
      code: "driver_unknown",
    });
  });

  it("drops a receipt that does not name this queue, or this document, from a doubt as from a success", () => {
    for (const receipt of [
      { ...RECEIPT, queue: "Other" },
      { ...RECEIPT, documentName: "Markiro:00000000-0000-4000-8000-000000000000" },
    ]) {
      expect(windowsPrintResult({ ok: true, receipt }, QUEUE, DOCUMENT)).toEqual({
        sent: false,
        code: "driver_unknown",
      });
      expect(
        windowsPrintResult(
          { ok: false, error: { code: "driver_failure", phase: "delivery_unknown", receipt } },
          QUEUE,
          DOCUMENT,
        ),
      ).toEqual({ sent: false, code: "driver_unknown" });
    }
  });

  it("refuses a receipt with an empty queue or document name even when the send asked for the same empty one", () => {
    expect(
      windowsPrintResult({ ok: true, receipt: { ...RECEIPT, queue: "" } }, "", DOCUMENT),
    ).toEqual({ sent: false, code: "driver_unknown" });
    expect(
      windowsPrintResult({ ok: true, receipt: { ...RECEIPT, documentName: "" } }, QUEUE, ""),
    ).toEqual({ sent: false, code: "driver_unknown" });
  });

  it("keeps a refusal before the start free of any receipt", () => {
    const result = windowsPrintResult(
      {
        ok: false,
        error: { code: "geometry_mismatch", phase: "before_start", receipt: RECEIPT },
      },
      QUEUE,
      DOCUMENT,
    );
    expect(result).toEqual({ sent: false, code: "geometry_mismatch" });
    expect("receipt" in result).toBe(false);
  });

  it("is strict about the fixture's shapes: an extra key, or a changed value kind, is refused", () => {
    const shapes: Record<string, unknown> = JSON.parse(readFileSync(SHAPES_URL, "utf8"));
    const refused = shapes["windowsPrintRefused"] as { ok: boolean; error: object };
    expect(windowsPrintOutcomeSchema.safeParse({ ...refused, extra: 1 }).success).toBe(false);
    expect(
      windowsPrintOutcomeSchema.safeParse({ ...refused, error: { ...refused.error, extra: 1 } })
        .success,
    ).toBe(false);
    for (const bad of [
      { state: "present" },
      { state: "present", statusFlags: -1 },
      { state: "present", statusFlags: 1.5 },
      { state: "present", statusFlags: "8" },
      { state: "present", statusFlags: 8, extra: 1 },
      { state: "absent", statusFlags: 8 },
      { state: "gone" },
      {},
    ]) {
      expect(windowsJobObservationSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    for (const good of [
      { state: "present", statusFlags: 0 },
      { state: "absent" },
      { state: "identity_mismatch" },
      { state: "unavailable" },
    ]) {
      expect(windowsJobObservationSchema.parse(good)).toEqual(good);
    }
  });
});

describe("a driver result settles a job", () => {
  it("leaves the three refusals failed, the doubt unknown, the spooler's take sent", () => {
    expect([...DRIVER_FAILED_CODES]).toEqual([
      "queue_unavailable",
      "geometry_mismatch",
      "driver_not_started",
    ]);
    for (const code of DRIVER_FAILED_CODES) {
      expect(FAILED_CODES).toContain(code);
      expect(settleOutcome({ kind: "answered", result: { sent: false, code } })).toEqual({
        state: "failed",
        code,
      });
    }
    expect(UNKNOWN_CODES).toContain("driver_unknown");
    expect(
      settleOutcome({ kind: "answered", result: { sent: false, code: "driver_unknown" } }),
    ).toEqual({ state: "unknown", code: "driver_unknown" });
    expect(
      settleOutcome({
        kind: "answered",
        result: { sent: false, code: "driver_unknown", receipt: RECEIPT },
      }),
    ).toEqual({ state: "unknown", code: "driver_unknown" });
    expect(settleOutcome({ kind: "answered", result: { sent: true, receipt: RECEIPT } })).toEqual({
      state: "sent",
    });
  });

  it("settles every code a driver print can answer, and none of them as sent", () => {
    for (const raw of WINDOWS_DRIVER_CODES.flatMap((code) =>
      (["before_start", "delivery_unknown"] as const).map((phase) => ({
        ok: false,
        error: { code, phase },
      })),
    )) {
      const settled = settleOutcome({
        kind: "answered",
        result: windowsPrintResult(raw, QUEUE, DOCUMENT),
      });
      if (raw.error.phase === "delivery_unknown") {
        expect(settled).toEqual({ state: "unknown", code: "driver_unknown" });
      } else {
        expect(settled.state).toBe("failed");
        // Every refusal the driver gives is one of the codes a job may fail with.
        expect(settled.state === "failed" ? FAILED_CODES : []).toContain(
          settled.state === "failed" ? settled.code : "",
        );
      }
    }
  });
});

describe("createTauriWindowsPrinting, the edges", () => {
  it("is supported only for an answer of exactly true", async () => {
    for (const answer of [false, "true", 1, null, undefined, {}]) {
      const windows = createTauriWindowsPrinting(async () => answer);
      await expect(windows.supportsWindowsPrinting(), String(answer)).resolves.toBe(false);
    }
  });

  it("never asks the shell for bytes it could not encode, and reads that as nothing sent", async () => {
    const call = vi.fn(async () => ({ ok: true, receipt: RECEIPT }));
    const broken = new Uint8Array([1]);
    Object.defineProperty(broken, Symbol.iterator, {
      value: () => {
        throw new Error("cannot iterate");
      },
    });
    const windows = createTauriWindowsPrinting(call);
    await expect(windows.printWindowsRaster(QUEUE, broken, DOCUMENT)).resolves.toEqual({
      sent: false,
      code: "invalid_payload",
    });
    expect(call).not.toHaveBeenCalled();
  });

  it("reads an answer of no known shape from the shell as unknown, not as sent or refused", async () => {
    for (const answer of [undefined, null, true, { ok: true }, { state: "present" }]) {
      const windows = createTauriWindowsPrinting(async () => answer);
      await expect(
        windows.printWindowsRaster(QUEUE, new Uint8Array([1]), DOCUMENT),
        JSON.stringify(answer),
      ).resolves.toEqual({ sent: false, code: "driver_unknown" });
    }
  });

  it("matches a receipt against the queue and document it asked for, not the ones it answers", async () => {
    const windows = createTauriWindowsPrinting(async () => ({
      ok: true,
      receipt: { ...RECEIPT, documentName: "Markiro:00000000-0000-4000-8000-000000000000" },
    }));
    await expect(windows.printWindowsRaster(QUEUE, new Uint8Array([1]), DOCUMENT)).resolves.toEqual(
      { sent: false, code: "driver_unknown" },
    );
  });

  it("answers unavailable for a thrown question and for a rejected observation", async () => {
    const throwing = createTauriWindowsPrinting(async () => {
      throw new Error("ipc");
    });
    await expect(throwing.getWindowsPrintJob(RECEIPT)).resolves.toEqual({ state: "unavailable" });
    for (const state of ["absent", "identity_mismatch", "unavailable"] as const) {
      const windows = createTauriWindowsPrinting(async () => ({ state }));
      await expect(windows.getWindowsPrintJob(RECEIPT)).resolves.toEqual({ state });
    }
    const extra = createTauriWindowsPrinting(async () => ({ state: "absent", jobId: 1 }));
    await expect(extra.getWindowsPrintJob(RECEIPT)).resolves.toEqual({ state: "unavailable" });
  });
});
