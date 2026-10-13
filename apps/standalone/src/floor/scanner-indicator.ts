import { useEffect, useState } from "react";

import type { HardwareApi, ScannerSnapshot } from "../hardware/hardware.js";

/**
 * What the floor may honestly say about its scanner (the cloud station's
 * `ScannerIndicator`, `apps/station/src/ui/StatusBar.tsx`, plus `unknown`). A
 * keyboard-wedge scanner is a keyboard and cannot be seen, so with no COM
 * scanner configured the floor says «keyboard»: it neither claims a device nor
 * denies that scanning works. With COM scanners configured the shell's
 * snapshot (`standalone://scanner-status`) is the truth: all connected, some,
 * or none. `unknown`: the shell could not be asked at all.
 */
export type ScannerIndicator = "keyboard" | "connected" | "partial" | "disconnected" | "unknown";

/** Where the indicator comes from: no shell to ask, the shell's last snapshot, or a refused watch. */
export type ScannerWatch =
  { kind: "none" } | { kind: "watching"; snapshot: ScannerSnapshot | null } | { kind: "failed" };

export function scannerIndicator(watch: ScannerWatch): ScannerIndicator {
  if (watch.kind === "none") return "keyboard";
  if (watch.kind === "failed") return "unknown";
  // Before the first snapshot only the wedge is certain.
  const scanners = watch.snapshot?.scanners ?? [];
  if (scanners.length === 0) return "keyboard";
  const connected = scanners.filter((scanner) => scanner.status === "connected").length;
  if (connected === scanners.length) return "connected";
  return connected === 0 ? "disconnected" : "partial";
}

/** The sign-in screen's scanner chip: its tone and the key of its words (`floor.signIn.scanner.*`). */
export interface SignInScannerState {
  tone: "ok" | "warn" | "error";
  key: "ready" | "partial" | "disconnected" | "unknown" | "locked";
}

/**
 * The chip on the sign-in screen. `stationLocked`: the last attempt was
 * answered by the station's lockout (ten failures pause every sign-in), so a
 * scan is not taken now whatever the scanner; an operator's PIN lockout leaves
 * the badge working and does not count here.
 */
export function signInScannerState(
  indicator: ScannerIndicator,
  stationLocked: boolean,
): SignInScannerState {
  if (stationLocked) return { tone: "error", key: "locked" };
  switch (indicator) {
    case "keyboard":
    case "connected":
      return { tone: "ok", key: "ready" };
    case "partial":
      return { tone: "warn", key: "partial" };
    case "unknown":
      return { tone: "warn", key: "unknown" };
    case "disconnected":
      return { tone: "error", key: "disconnected" };
  }
}

/**
 * The indicator, following the shell's COM scanners while mounted. Without a
 * `watch` (tests, a build with no shell) the wedge alone is assumed.
 */
export function useScannerIndicator(
  watch: HardwareApi["watchScanners"] | undefined,
): ScannerIndicator {
  // What the watch of `source` reported; a new `watch` starts from nothing
  // (derived below, so no state is set during an effect).
  const [reported, setReported] = useState<{
    source: HardwareApi["watchScanners"];
    watch: ScannerWatch;
  } | null>(null);
  useEffect(() => {
    if (watch === undefined) return;
    let cancelled = false;
    let stop: (() => void) | null = null;
    const onSnapshot = (snapshot: ScannerSnapshot) => {
      if (!cancelled) setReported({ source: watch, watch: { kind: "watching", snapshot } });
    };
    const refused = () => {
      if (!cancelled) setReported({ source: watch, watch: { kind: "failed" } });
    };
    // A chip must never take the sign-in down: a watch that throws, or that
    // answers with something other than a promise of a stop, reads as refused
    // or as nothing to stop.
    let subscription: Promise<unknown>;
    try {
      subscription = Promise.resolve(watch(onSnapshot));
    } catch (error) {
      subscription = Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    subscription.then((stopWatching) => {
      if (typeof stopWatching !== "function") return;
      const stopIt = stopWatching as () => void;
      if (cancelled) stopIt();
      else stop = stopIt;
    }, refused);
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [watch]);
  if (watch === undefined) return scannerIndicator({ kind: "none" });
  if (reported === null || reported.source !== watch) {
    return scannerIndicator({ kind: "watching", snapshot: null });
  }
  return scannerIndicator(reported.watch);
}
