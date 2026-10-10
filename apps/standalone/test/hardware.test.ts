import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  bytesToBase64,
  createTauriHardware,
  HARDWARE_ERROR_CODES,
  HardwareError,
  PRINT_FAILURE_CODES,
  SCAN_EVENT,
  SCANNER_STATUS_EVENT,
  type PrintTarget,
  scannerSnapshotSchema,
  usbPrinterSchema,
  type ScannerSnapshot,
} from "../src/hardware/hardware.js";

// Bind the module URL before use: the jsdom environment rewrites a literal
// `new URL(..., import.meta.url)` (see test/protocol.test.ts).
const moduleUrl = import.meta.url;
const SHAPES_URL = new URL("../src-tauri/tests/fixtures/hardware-shapes.json", moduleUrl);

type Handler = (event: { payload: unknown }) => void;

/** A fake `listen`: records handlers so the test can emit shell events. */
function fakeEvents() {
  const handlers = new Map<string, Handler>();
  const order: string[] = [];
  const listen = vi.fn(async (event: string, handler: Handler) => {
    order.push(`listen ${event}`);
    handlers.set(event, handler);
    return () => {
      handlers.delete(event);
    };
  });
  const emit = (event: string, payload: unknown) => handlers.get(event)?.({ payload });
  return { listen, emit, handlers, order };
}

async function failure(promise: Promise<unknown>): Promise<HardwareError> {
  const error: unknown = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (!(error instanceof HardwareError)) throw new Error("expected a HardwareError");
  return error;
}

function snapshot(revision: number, status: "connected" | "disconnected"): ScannerSnapshot {
  return { revision, scanners: [{ port: "COM3", baud: 9600, status }] };
}

const USB_TARGET: PrintTarget = { kind: "usb", printer: "Zebra" };
const ONE_BYTE = new Uint8Array([1]);

describe("the shell's hardware contract", () => {
  it("listens to the shell's own event names", () => {
    expect(SCAN_EVENT).toBe("standalone://scan");
    expect(SCANNER_STATUS_EVENT).toBe("standalone://scanner-status");
  });

  it("names the refusals exactly as the shell's codes", () => {
    expect(PRINT_FAILURE_CODES).toEqual([
      "not_sent",
      "outcome_unknown",
      "invalid_target",
      "invalid_payload",
      "unsupported",
    ]);
    expect(HARDWARE_ERROR_CODES).toEqual([
      "invalid_scanners",
      "serial_unavailable",
      "spooler_unavailable",
      "power_request_failed",
      "invalid_response",
      "unknown",
    ]);
  });

  it("reads the shapes the shell's own test pins to the shared fixture", () => {
    const shapes: { scannerSnapshot: unknown; usbPrinter: unknown } = JSON.parse(
      readFileSync(SHAPES_URL, "utf8"),
    );
    // Both schemas are strict: a field the shell added and the schema lacks
    // would fail here instead of dropping every status event in the app.
    expect(scannerSnapshotSchema.parse(shapes.scannerSnapshot)).toEqual(shapes.scannerSnapshot);
    expect(usbPrinterSchema.parse(shapes.usbPrinter)).toEqual(shapes.usbPrinter);
  });
});

describe("bytesToBase64", () => {
  it("encodes every byte value losslessly", () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);
    const decoded = Uint8Array.from(atob(bytesToBase64(bytes)), (char) => char.charCodeAt(0));
    expect(decoded).toEqual(bytes);
  });

  it("encodes nothing as nothing and a large label whole", () => {
    expect(bytesToBase64(new Uint8Array())).toBe("");
    const label = Uint8Array.from({ length: 600_000 }, (_, index) => (index * 31) % 256);
    const decoded = Uint8Array.from(atob(bytesToBase64(label)), (char) => char.charCodeAt(0));
    // A boolean, so a failure does not make the runner diff 600 000 elements.
    expect(decoded.length === label.length && decoded.every((byte, i) => byte === label[i])).toBe(
      true,
    );
  });
});

describe("printBytes", () => {
  it("sends a label's exact bytes as base64 with its target", async () => {
    const call = vi.fn().mockResolvedValue(null);
    const target = { kind: "tcp", host: "192.168.1.50", port: 9100 } as const;
    const bytes = new Uint8Array([0x5e, 0x58, 0x41, 0xa4, 0x1d]);
    await expect(createTauriHardware(call).printBytes(target, bytes)).resolves.toEqual({
      sent: true,
    });
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith("print_bytes", { target, payloadBase64: "XlhBpB0=" });
  });

  it("hands every kind of target over untouched", async () => {
    const call = vi.fn().mockResolvedValue(null);
    const hardware = createTauriHardware(call);
    const serial: PrintTarget = { kind: "serial", port: "COM5", baud: 115200 };
    await hardware.printBytes(serial, ONE_BYTE);
    await hardware.printBytes(USB_TARGET, ONE_BYTE);
    expect(call).toHaveBeenNthCalledWith(1, "print_bytes", {
      target: serial,
      payloadBase64: "AQ==",
    });
    expect(call).toHaveBeenNthCalledWith(2, "print_bytes", {
      target: USB_TARGET,
      payloadBase64: "AQ==",
    });
  });

  it.each(PRINT_FAILURE_CODES)("answers the shell's %s refusal without throwing", async (code) => {
    const call = vi.fn().mockRejectedValue(code);
    await expect(createTauriHardware(call).printBytes(USB_TARGET, ONE_BYTE)).resolves.toEqual({
      sent: false,
      code,
    });
  });

  it.each([
    ["an unknown code", "from_a_newer_shell"],
    ["a failed IPC call", new Error("IPC channel closed")],
    ["a known code inside an error", new Error("not_sent")],
    ["a known code with other text around it", "not_sent: the queue is gone"],
    ["a known code in another case", "NOT_SENT"],
    ["an empty rejection", undefined],
    ["a null rejection", null],
    ["a rejection that is an object", { code: "not_sent" }],
  ])("reads %s as an unknown outcome, never as nothing sent", async (_case, rejection) => {
    const call = vi.fn().mockRejectedValue(rejection);
    await expect(createTauriHardware(call).printBytes(USB_TARGET, ONE_BYTE)).resolves.toEqual({
      sent: false,
      code: "outcome_unknown",
    });
  });

  it("reads an invoke that throws at once as an unknown outcome too", async () => {
    const call = vi.fn(() => {
      throw new Error("the IPC bridge is gone");
    });
    await expect(createTauriHardware(call).printBytes(USB_TARGET, ONE_BYTE)).resolves.toEqual({
      sent: false,
      code: "outcome_unknown",
    });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("answers a payload that cannot be encoded as invalid, without calling the shell", async () => {
    const call = vi.fn().mockResolvedValue(null);
    const broken = Object.assign(new Uint8Array(1), {
      [Symbol.iterator]: () => {
        throw new Error("cannot read the label");
      },
    });
    await expect(createTauriHardware(call).printBytes(USB_TARGET, broken)).resolves.toEqual({
      sent: false,
      code: "invalid_payload",
    });
    expect(call).not.toHaveBeenCalled();
  });
});

describe("the lists", () => {
  it("lists installed queues and serial ports", async () => {
    const queues = [
      { name: "Zebra ZD421", port: "USB001" },
      { name: "TSC TE200", port: "COM3:" },
    ];
    const call = vi.fn(async (command: string) =>
      command === "list_usb_printers" ? queues : ["COM3", "COM4"],
    );
    const hardware = createTauriHardware(call);
    await expect(hardware.listUsbPrinters()).resolves.toEqual(queues);
    await expect(hardware.listSerialPorts()).resolves.toEqual(["COM3", "COM4"]);
    expect(call).toHaveBeenCalledWith("list_usb_printers", {});
    expect(call).toHaveBeenCalledWith("list_serial_ports", {});
  });

  it("lists nothing as nothing", async () => {
    const hardware = createTauriHardware(vi.fn().mockResolvedValue([]));
    await expect(hardware.listUsbPrinters()).resolves.toEqual([]);
    await expect(hardware.listSerialPorts()).resolves.toEqual([]);
  });

  it.each([
    ["a queue without its port", [{ name: "Zebra" }]],
    ["a queue with another field", [{ name: "Zebra", port: "USB001", extra: 1 }]],
    ["a queue whose name is a number", [{ name: 7, port: "USB001" }]],
    ["a list that is not a list", { name: "Zebra", port: "USB001" }],
    ["nothing", null],
  ])("refuses %s as an invalid answer", async (_case, answer) => {
    const hardware = createTauriHardware(vi.fn().mockResolvedValue(answer));
    const error = await failure(hardware.listUsbPrinters());
    expect(error.code).toBe("invalid_response");
    expect(error.message).toContain("list_usb_printers");
  });

  it.each([
    ["a port that is a number", ["COM3", 4]],
    ["a list that is not a list", "COM3"],
    ["nothing", undefined],
  ])("refuses serial ports with %s as an invalid answer", async (_case, answer) => {
    const hardware = createTauriHardware(vi.fn().mockResolvedValue(answer));
    const error = await failure(hardware.listSerialPorts());
    expect(error.code).toBe("invalid_response");
    expect(error.message).toContain("list_serial_ports");
  });
});

describe("the other commands", () => {
  it("hands the whole set of scanners over and closes them", async () => {
    const call = vi.fn().mockResolvedValue(null);
    const hardware = createTauriHardware(call);
    const scanners = [
      { port: "COM3", baud: 9600 },
      { port: "COM4", baud: 115200 },
    ];
    await expect(hardware.configureScanners(scanners)).resolves.toBeUndefined();
    expect(call).toHaveBeenCalledWith("configure_scanners", { scanners });
    await expect(hardware.closeScanners()).resolves.toBeUndefined();
    expect(call).toHaveBeenLastCalledWith("close_scanners", {});
  });

  it("hands an empty set over as an empty set, which closes every scanner", async () => {
    const call = vi.fn().mockResolvedValue(null);
    await createTauriHardware(call).configureScanners([]);
    expect(call).toHaveBeenCalledWith("configure_scanners", { scanners: [] });
  });

  it("asks to keep the computer awake and to let it sleep", async () => {
    const call = vi.fn().mockResolvedValue(null);
    const hardware = createTauriHardware(call);
    await expect(hardware.setSystemAwake(true)).resolves.toBeUndefined();
    expect(call).toHaveBeenLastCalledWith("set_system_awake", { awake: true });
    await hardware.setSystemAwake(false);
    expect(call).toHaveBeenLastCalledWith("set_system_awake", { awake: false });
  });

  const refusing: [
    string,
    (hardware: ReturnType<typeof createTauriHardware>) => Promise<unknown>,
  ][] = [
    ["listUsbPrinters", (hardware) => hardware.listUsbPrinters()],
    ["listSerialPorts", (hardware) => hardware.listSerialPorts()],
    ["configureScanners", (hardware) => hardware.configureScanners([])],
    ["closeScanners", (hardware) => hardware.closeScanners()],
    ["setSystemAwake", (hardware) => hardware.setSystemAwake(true)],
    ["watchScanners", (hardware) => hardware.watchScanners(vi.fn())],
  ];

  describe.each(refusing)("%s", (_name, run) => {
    it.each(HARDWARE_ERROR_CODES)("keeps the shell's %s code", async (code) => {
      const hardware = createTauriHardware(vi.fn().mockRejectedValue(code), fakeEvents().listen);
      expect((await failure(run(hardware))).code).toBe(code);
    });

    it.each([
      ["an unexpected shell error", new Error("boom")],
      ["a code from a newer shell", "from_a_newer_shell"],
      ["a code of the printer", "not_sent"],
    ])("treats %s as unknown", async (_case, rejection) => {
      const hardware = createTauriHardware(
        vi.fn().mockRejectedValue(rejection),
        fakeEvents().listen,
      );
      const error = await failure(run(hardware));
      expect(error.code).toBe("unknown");
      expect(error.name).toBe("HardwareError");
      expect(error).toBeInstanceOf(Error);
    });
  });

  it("names the command in a refusal's message, never in its code", async () => {
    const hardware = createTauriHardware(vi.fn().mockRejectedValue("power_request_failed"));
    const error = await failure(hardware.setSystemAwake(true));
    expect(error.message).toBe("set_system_awake: power_request_failed");
  });
});

describe("watchScanners", () => {
  it("subscribes to the scanners' status before asking for the current one", async () => {
    const events = fakeEvents();
    const call = vi.fn(async (command: string) => {
      events.order.push(command);
      return snapshot(1, "disconnected");
    });
    const seen: ScannerSnapshot[] = [];
    await createTauriHardware(call, events.listen).watchScanners((next) => seen.push(next));
    expect(events.order).toEqual([`listen ${SCANNER_STATUS_EVENT}`, "get_scanner_connections"]);
    expect(call).toHaveBeenCalledWith("get_scanner_connections", {});
    expect(seen).toEqual([snapshot(1, "disconnected")]);
  });

  it("delivers the shell's first snapshot, revision 0 and no scanners", async () => {
    const events = fakeEvents();
    const call = vi.fn().mockResolvedValue({ revision: 0, scanners: [] });
    const seen: ScannerSnapshot[] = [];
    await createTauriHardware(call, events.listen).watchScanners((next) => seen.push(next));
    expect(seen).toEqual([{ revision: 0, scanners: [] }]);
  });

  it("keeps only newer snapshots and ignores malformed ones", async () => {
    const events = fakeEvents();
    // The shell published revision 3 while the snapshot (revision 2) was on its way.
    const call = vi.fn(async () => {
      events.emit(SCANNER_STATUS_EVENT, snapshot(3, "connected"));
      return snapshot(2, "disconnected");
    });
    const seen: ScannerSnapshot[] = [];
    const stop = await createTauriHardware(call, events.listen).watchScanners((next) =>
      seen.push(next),
    );
    events.emit(SCANNER_STATUS_EVENT, snapshot(3, "disconnected"));
    events.emit(SCANNER_STATUS_EVENT, snapshot(1, "disconnected"));
    events.emit(SCANNER_STATUS_EVENT, { revision: 9, scanners: "COM3" });
    events.emit(SCANNER_STATUS_EVENT, snapshot(4, "disconnected"));
    expect(seen).toEqual([snapshot(3, "connected"), snapshot(4, "disconnected")]);

    stop();
    expect(events.handlers.has(SCANNER_STATUS_EVENT)).toBe(false);
  });

  it("delivers a snapshot that skips revisions", async () => {
    const events = fakeEvents();
    const call = vi.fn().mockResolvedValue(snapshot(1, "disconnected"));
    const seen: ScannerSnapshot[] = [];
    await createTauriHardware(call, events.listen).watchScanners((next) => seen.push(next));
    events.emit(SCANNER_STATUS_EVENT, snapshot(7, "connected"));
    expect(seen.map((next) => next.revision)).toEqual([1, 7]);
  });

  it.each([
    ["a revision that is not a number", { revision: "2", scanners: [] }],
    ["a revision below zero", { revision: -1, scanners: [] }],
    ["a revision that is not whole", { revision: 1.5, scanners: [] }],
    ["no revision", { scanners: [] }],
    ["no scanners", { revision: 2 }],
    ["another field", { revision: 2, scanners: [], extra: true }],
    [
      "a status of its own",
      { revision: 2, scanners: [{ port: "COM3", baud: 9600, status: "busy" }] },
    ],
    [
      "a baud rate of zero",
      { revision: 2, scanners: [{ port: "COM3", baud: 0, status: "connected" }] },
    ],
    [
      "a baud rate that is not whole",
      { revision: 2, scanners: [{ port: "COM3", baud: 9600.5, status: "connected" }] },
    ],
    ["a scanner without a port", { revision: 2, scanners: [{ baud: 9600, status: "connected" }] }],
    [
      "a scanner with another field",
      { revision: 2, scanners: [{ port: "COM3", baud: 9600, status: "connected", extra: 1 }] },
    ],
    ["a text", "connected"],
    ["nothing", null],
  ])("ignores an event with %s", async (_case, payload) => {
    const events = fakeEvents();
    const call = vi.fn().mockResolvedValue(snapshot(1, "disconnected"));
    const seen: ScannerSnapshot[] = [];
    await createTauriHardware(call, events.listen).watchScanners((next) => seen.push(next));
    events.emit(SCANNER_STATUS_EVENT, payload);
    expect(seen).toEqual([snapshot(1, "disconnected")]);
  });

  it("stops listening when the current snapshot cannot be read", async () => {
    const events = fakeEvents();
    const call = vi.fn().mockRejectedValue("unknown");
    const watching = createTauriHardware(call, events.listen).watchScanners(vi.fn());
    expect((await failure(watching)).code).toBe("unknown");
    expect(events.handlers.has(SCANNER_STATUS_EVENT)).toBe(false);
  });

  it("stops listening when the current snapshot is malformed", async () => {
    const events = fakeEvents();
    const call = vi.fn().mockResolvedValue({ revision: 1 });
    const onSnapshot = vi.fn();
    const watching = createTauriHardware(call, events.listen).watchScanners(onSnapshot);
    const error = await failure(watching);
    expect(error.code).toBe("invalid_response");
    expect(error.message).toContain("get_scanner_connections");
    expect(events.handlers.has(SCANNER_STATUS_EVENT)).toBe(false);
    expect(onSnapshot).not.toHaveBeenCalled();
  });

  it("asks for nothing when it cannot subscribe", async () => {
    const call = vi.fn().mockResolvedValue(snapshot(1, "disconnected"));
    const listen = vi.fn().mockRejectedValue(new Error("the event bridge is gone"));
    const error = await failure(createTauriHardware(call, listen).watchScanners(vi.fn()));
    expect(error.code).toBe("unknown");
    expect(error.message).toContain("standalone://scanner-status");
    expect(call).not.toHaveBeenCalled();
  });

  it("lets a caller stop and later watch again from the start", async () => {
    const events = fakeEvents();
    const call = vi.fn().mockResolvedValue(snapshot(5, "connected"));
    const hardware = createTauriHardware(call, events.listen);
    const first: ScannerSnapshot[] = [];
    const stop = await hardware.watchScanners((next) => first.push(next));
    stop();
    const second: ScannerSnapshot[] = [];
    await hardware.watchScanners((next) => second.push(next));
    expect(first).toEqual([snapshot(5, "connected")]);
    expect(second).toEqual([snapshot(5, "connected")]);
  });
});

describe("onScan", () => {
  it("delivers each COM scan raw, the group separator kept", async () => {
    const events = fakeEvents();
    const scans: string[] = [];
    const stop = await createTauriHardware(vi.fn(), events.listen).onScan((raw) => scans.push(raw));
    expect(events.order).toEqual([`listen ${SCAN_EVENT}`]);
    events.emit(SCAN_EVENT, "]d2010460000000001521serial\u001d91key");
    events.emit(SCAN_EVENT, { not: "a scan" });
    events.emit(SCAN_EVENT, 42);
    events.emit(SCAN_EVENT, null);
    expect(scans).toEqual(["]d2010460000000001521serial\u001d91key"]);

    stop();
    expect(events.handlers.has(SCAN_EVENT)).toBe(false);
  });

  it("delivers a scan exactly as the shell framed it, in order", async () => {
    const events = fakeEvents();
    const scans: string[] = [];
    await createTauriHardware(vi.fn(), events.listen).onScan((raw) => scans.push(raw));
    events.emit(SCAN_EVENT, "  ]C101234\t ");
    events.emit(SCAN_EVENT, "second");
    events.emit(SCAN_EVENT, "\ufffd");
    expect(scans).toEqual(["  ]C101234\t ", "second", "\ufffd"]);
  });

  it("does not take the scanners' status for a scan", async () => {
    const events = fakeEvents();
    const scans: string[] = [];
    await createTauriHardware(vi.fn(), events.listen).onScan((raw) => scans.push(raw));
    expect(events.handlers.has(SCANNER_STATUS_EVENT)).toBe(false);
    events.emit(SCANNER_STATUS_EVENT, "COM3");
    expect(scans).toEqual([]);
  });

  it("refuses with a hardware error when it cannot subscribe", async () => {
    const listen = vi.fn().mockRejectedValue(new Error("the event bridge is gone"));
    const error = await failure(createTauriHardware(vi.fn(), listen).onScan(vi.fn()));
    expect(error.code).toBe("unknown");
    expect(error.message).toContain("standalone://scan");
  });
});
