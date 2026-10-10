import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { z } from "zod";

/** A COM scan, the raw text (`src-tauri/src/scanner.rs`). */
export const SCAN_EVENT = "standalone://scan";
/** The configured COM ports and their connection. */
export const SCANNER_STATUS_EVENT = "standalone://scanner-status";

/** Where a label goes (`PrintTarget` in `src-tauri/src/printer.rs`). */
export type PrintTarget =
  | { kind: "serial"; port: string; baud: number }
  | { kind: "tcp"; host: string; port: number }
  | { kind: "usb"; printer: string };

/** Codes `print_bytes` refuses with (`PrintError::code` in src-tauri). */
export const PRINT_FAILURE_CODES = [
  "not_sent",
  "outcome_unknown",
  "invalid_target",
  "invalid_payload",
  "unsupported",
] as const;
export type PrintFailureCode = (typeof PRINT_FAILURE_CODES)[number];

/**
 * One send. `sent`: every byte left this computer (the spooler took the
 * job, or the printer's connection took the bytes), which is not yet a
 * printed label. Otherwise the code: `not_sent` — nothing left, so printing
 * again cannot double a label; `outcome_unknown` — a label may exist, so
 * only the operator may print again (plan 2a7). An answer the shell never
 * gives — an unknown code, a failed IPC call — reads as `outcome_unknown`,
 * the reading that cannot double a label. `invalid_payload` is also this
 * wrapper's own answer for bytes it could not encode, before the shell is
 * asked, so nothing was sent then either.
 */
export type PrintResult = { sent: true } | { sent: false; code: PrintFailureCode };

export const scannerConfigSchema = z
  .object({ port: z.string().min(1), baud: z.number().int().positive() })
  .strict();
/** One COM scanner as the shell configures it: `COM3` and `com3` are one port. */
export type ScannerConfig = z.infer<typeof scannerConfigSchema>;

export const scannerSnapshotSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    scanners: z.array(
      z
        .object({
          port: z.string(),
          baud: z.number().int().positive(),
          status: z.enum(["connected", "disconnected"]),
        })
        .strict(),
    ),
  })
  .strict();
/** The configured ports and their connection; `revision` grows with every change. */
export type ScannerSnapshot = z.infer<typeof scannerSnapshotSchema>;

export const usbPrinterSchema = z.object({ name: z.string(), port: z.string() }).strict();
/** An installed Windows queue: the spooler's queue name and its port. */
export type UsbPrinter = z.infer<typeof usbPrinterSchema>;

/** Codes the other hardware commands refuse with, and two of the webview's own. */
export const HARDWARE_ERROR_CODES = [
  "invalid_scanners",
  "serial_unavailable",
  "spooler_unavailable",
  "power_request_failed",
  "invalid_response",
  "unknown",
] as const;
export type HardwareErrorCode = (typeof HARDWARE_ERROR_CODES)[number];

/** A refused hardware command; screens choose text by `code`, never by message. */
export class HardwareError extends Error {
  readonly code: HardwareErrorCode;

  constructor(code: HardwareErrorCode, message: string) {
    super(message);
    this.name = "HardwareError";
    this.code = code;
  }
}

/**
 * The shell's printers, COM scanners and power request. Function-typed
 * properties, so they may be passed around unbound
 * (`@typescript-eslint/unbound-method`).
 */
export interface HardwareApi {
  /** Sends a label's bytes; never throws. One send at a time per address (plan 2a7). */
  printBytes: (target: PrintTarget, bytes: Uint8Array) => Promise<PrintResult>;
  /** The installed Windows queues, `USB…` ports first; empty off Windows. */
  listUsbPrinters: () => Promise<UsbPrinter[]>;
  listSerialPorts: () => Promise<string[]>;
  /** Replaces the whole set of COM scanners; an empty set closes them all. */
  configureScanners: (scanners: readonly ScannerConfig[]) => Promise<void>;
  closeScanners: () => Promise<void>;
  /**
   * The current snapshot, then every newer one, until the returned function
   * is called. Subscribes first and asks second, so no change is lost.
   */
  watchScanners: (onSnapshot: (snapshot: ScannerSnapshot) => void) => Promise<() => void>;
  /**
   * Every COM scan as the scanner sent it, until the returned function is
   * called. A scan the shell emits while no listener is registered (a
   * webview that is reloading) is lost.
   */
  onScan: (listener: (raw: string) => void) => Promise<() => void>;
  /** Keeps the computer and its display awake (`true`) or lets them sleep. */
  setSystemAwake: (awake: boolean) => Promise<void>;
}

/** Tauri's IPC is JSON, so a label's bytes cross it base64-encoded. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

type Invoke = (command: string, args: Record<string, unknown>) => Promise<unknown>;
type Listen = (
  event: string,
  handler: (event: { payload: unknown }) => void,
) => Promise<() => void>;

/** The hardware commands of `src-tauri/src/{printer,scanner,power}.rs`. */
export function createTauriHardware(
  call: Invoke = invoke,
  subscribe: Listen = (event, handler) => listen(event, handler),
): HardwareApi {
  async function run(command: string, args: Record<string, unknown>): Promise<unknown> {
    try {
      return await call(command, args);
    } catch (error) {
      const code = HARDWARE_ERROR_CODES.find((candidate) => candidate === error) ?? "unknown";
      throw new HardwareError(code, `${command}: ${String(error)}`);
    }
  }

  function parse<T>(command: string, schema: z.ZodType<T>, raw: unknown): T {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      throw new HardwareError("invalid_response", `${command}: ${parsed.error.message}`);
    }
    return parsed.data;
  }

  async function listenTo(
    event: string,
    handler: (event: { payload: unknown }) => void,
  ): Promise<() => void> {
    try {
      return await subscribe(event, handler);
    } catch (error) {
      throw new HardwareError("unknown", `listen ${event}: ${String(error)}`);
    }
  }

  return {
    printBytes: async (target, bytes) => {
      let payloadBase64: string;
      try {
        payloadBase64 = bytesToBase64(bytes);
      } catch {
        // Nothing was asked of the shell, so nothing was sent.
        return { sent: false, code: "invalid_payload" };
      }
      try {
        await call("print_bytes", { target, payloadBase64 });
        return { sent: true };
      } catch (error) {
        const code =
          PRINT_FAILURE_CODES.find((candidate) => candidate === error) ?? "outcome_unknown";
        return { sent: false, code };
      }
    },
    listUsbPrinters: async () =>
      parse("list_usb_printers", z.array(usbPrinterSchema), await run("list_usb_printers", {})),
    listSerialPorts: async () =>
      parse("list_serial_ports", z.array(z.string()), await run("list_serial_ports", {})),
    configureScanners: async (scanners) => {
      await run("configure_scanners", { scanners });
    },
    closeScanners: async () => {
      await run("close_scanners", {});
    },
    watchScanners: async (onSnapshot) => {
      let newest = -1;
      const accept = (snapshot: ScannerSnapshot) => {
        if (snapshot.revision <= newest) return;
        newest = snapshot.revision;
        onSnapshot(snapshot);
      };
      const stop = await listenTo(SCANNER_STATUS_EVENT, (event) => {
        const parsed = scannerSnapshotSchema.safeParse(event.payload);
        if (parsed.success) accept(parsed.data);
      });
      try {
        const raw = await run("get_scanner_connections", {});
        accept(parse("get_scanner_connections", scannerSnapshotSchema, raw));
      } catch (error) {
        stop();
        throw error;
      }
      return stop;
    },
    onScan: (listener) =>
      listenTo(SCAN_EVENT, (event) => {
        if (typeof event.payload === "string") listener(event.payload);
      }),
    setSystemAwake: async (awake) => {
      await run("set_system_awake", { awake });
    },
  };
}
