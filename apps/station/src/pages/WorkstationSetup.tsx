import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Input } from "@markiro/ui";
import { sampleLabelData, type LabelTemplateSpec } from "@markiro/domain";
import { saveSoundSettings, type SoundSettings } from "../lib/signal-sound.js";
import type { HardwareContract, PrintTarget } from "../lib/hardware.js";
import {
  loadHardwareConfig,
  saveHardwareConfig,
  type HardwareConfig,
  type PrinterLanguage,
} from "../lib/hardware-config.js";
import { renderLabelBytes } from "../lib/print-label.js";
import { rasterizeText } from "../lib/rasterizer.js";
import type { SqlExecutor } from "../lib/mirror.js";

export interface WorkstationSetupProps {
  hw: HardwareContract;
  exec: SqlExecutor;
  sound: SoundSettings;
  onSoundChange: (s: SoundSettings) => void;
  /** Fired after the configuration is persisted, so the app can apply it. */
  onConfigChange: (config: HardwareConfig) => void;
  onDone: () => void;
}

const DEFAULT_BAUD = 9600;
const DEFAULT_PRINTER_PORT = 9100;

/** u32::MAX -- the ceiling Rust's scanner-open/serial-print baud accepts. */
const MAX_BAUD = 4294967295;

/**
 * Accepts only a finite non-negative integer within u32 range, used for both
 * the scanner and the serial printer baud rate. Rust deserializes each into a
 * `u32`, so a value like `-1`, `1.5`, or `Infinity` must be rejected here
 * rather than silently coerced to a default: a bad value that reaches
 * `station_meta` breaks every scanner open or print attempt on this
 * workstation until someone reopens Setup and happens to notice.
 */
function parseBaud(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < 0 || n > MAX_BAUD) return null;
  return n;
}

/**
 * Accepts only a finite integer within the valid TCP port range. Rust
 * deserializes the TCP printer port into a `u16`, so anything outside
 * `1..=65535` must be rejected rather than silently coerced (see
 * `parseBaud`).
 */
function parseTcpPort(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return null;
  return n;
}

/**
 * Workstation setup (design brief 04 §7): pick the scanner and printer once,
 * prove each works, set the sound level. Meant to be completed by a non-IT
 * person, so every action has an immediate, visible result.
 */
export function WorkstationSetup({
  hw,
  exec,
  sound,
  onSoundChange,
  onConfigChange,
  onDone,
}: WorkstationSetupProps) {
  const { t } = useTranslation();
  const [ports, setPorts] = useState<string[]>([]);
  const [port, setPort] = useState("");
  // The port loaded from storage, captured once and never reassigned after
  // that (see the config-seeding effect below). Needed because `port` itself
  // moves as the operator clicks buttons on this screen, but the "configured,
  // not detected" button (Finding 4) has to keep pointing at the originally
  // stored value even after the operator has clicked something else.
  const [storedPort, setStoredPort] = useState("");
  const [baud, setBaud] = useState(String(DEFAULT_BAUD));
  const [lastScan, setLastScan] = useState<string | null>(null);
  const [printerHost, setPrinterHost] = useState("");
  const [printerTcpPort, setPrinterTcpPort] = useState(String(DEFAULT_PRINTER_PORT));
  const [printerPort, setPrinterPort] = useState("");
  const [printerBaud, setPrinterBaud] = useState(String(DEFAULT_BAUD));
  // Single source of truth for which printer target `buildConfig()` builds.
  // Without this, the transport was inferred from which fields happened to
  // be non-empty (`printerHost ? tcp : serial`), so a workstation with a
  // stored TCP printer would keep sending the stale TCP target the moment an
  // operator typed a serial port, because the host field was still populated.
  const [printerTransport, setPrinterTransport] = useState<PrintTarget["kind"]>("tcp");
  const [printerLanguage, setPrinterLanguage] = useState<PrinterLanguage>("zpl");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // True until the stored configuration has seeded every field below. While
  // true, every control that can change or persist the configuration stays
  // disabled: the seed effect is async, so without this an operator could
  // select a device or press Done against the blank/default values this
  // screen starts with -- after which the seed effect would either silently
  // overwrite that choice, or (if Done ran first) persist the defaults and
  // erase the scanner/printer configuration that was actually stored.
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void hw
      .listScannerPorts()
      .then(setPorts)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : t("setup.failed")));
  }, [hw, t]);

  // Seed every field from the stored configuration, so an operator reopening
  // this screen sees what is actually configured rather than blank defaults.
  // `loading` stays true until this resolves (see its declaration above), so
  // nothing here can be raced by an operator interacting with the form.
  useEffect(() => {
    void loadHardwareConfig(exec).then((config) => {
      if (config.scanner) {
        setPort(config.scanner.port);
        setStoredPort(config.scanner.port);
        setBaud(String(config.scanner.baud));
      }
      if (config.printer?.kind === "tcp") {
        setPrinterTransport("tcp");
        setPrinterHost(config.printer.host);
        setPrinterTcpPort(String(config.printer.port));
      }
      if (config.printer?.kind === "serial") {
        setPrinterTransport("serial");
        setPrinterPort(config.printer.port);
        setPrinterBaud(String(config.printer.baud));
      }
      setPrinterLanguage(config.printerLanguage);
      setLoading(false);
    });
  }, [exec]);

  // Live scans are shown for as long as this screen is open, so the operator
  // can confirm the scanner really works before leaving.
  useEffect(() => {
    let unsubscribe: (() => void) | null = null;
    let stopped = false;
    void hw
      .onScan(setLastScan)
      .then((fn) => {
        if (stopped) fn();
        else unsubscribe = fn;
      })
      .catch((err: unknown) => {
        // A rejected `listen` leaves the scan source silently dead — surface
        // it through the same on-screen error line as every other failure
        // here, but only if the screen is still mounted to show it.
        if (stopped) return;
        setError(err instanceof Error ? err.message : t("setup.failed"));
      });
    return () => {
      stopped = true;
      unsubscribe?.();
    };
  }, [hw, t]);

  async function openScanner() {
    const baudValue = parseBaud(baud);
    if (baudValue === null) {
      setError(t("setup.invalidNumber"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Retire any previous session first: without this a wrong port leaves
      // the scanner "already open" until the app restarts.
      await hw.closeScanner();
      await hw.openScanner(port, baudValue);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("setup.failed"));
    } finally {
      setBusy(false);
    }
  }

  type ConfigResult = { ok: true; config: HardwareConfig } | { ok: false; error: string };

  /**
   * Validates and assembles the configuration from the current form state.
   * Returns an error instead of a config when a numeric field is out of
   * range, so an invalid baud or port can never reach `saveHardwareConfig` --
   * Rust cannot deserialize it into a `u32`/`u16`, and the resulting failure
   * would otherwise surface far away from (and long after) the field the
   * operator actually typed into.
   *
   * The printer transport is read from `printerTransport`, the explicit
   * selector below -- not inferred from which fields happen to be
   * non-empty. That selector is the single source of truth for which target
   * kind is built, so switching it always fully replaces the printer target
   * instead of leaving a stale host/port from the previously-selected
   * transport in play.
   */
  function buildConfig(): ConfigResult {
    let scanner: HardwareConfig["scanner"] = null;
    if (port !== "") {
      const baudValue = parseBaud(baud);
      if (baudValue === null) return { ok: false, error: t("setup.invalidNumber") };
      scanner = { port, baud: baudValue };
    }

    let printer: PrintTarget | null = null;
    if (printerTransport === "tcp") {
      if (printerHost !== "") {
        const tcpPort = parseTcpPort(printerTcpPort);
        if (tcpPort === null) return { ok: false, error: t("setup.invalidNumber") };
        printer = { kind: "tcp", host: printerHost, port: tcpPort };
      }
    } else if (printerPort !== "") {
      const serialBaud = parseBaud(printerBaud);
      if (serialBaud === null) return { ok: false, error: t("setup.invalidNumber") };
      printer = { kind: "serial", port: printerPort, baud: serialBaud };
    }

    return { ok: true, config: { scanner, printer, printerLanguage } };
  }

  async function testPrint() {
    const result = buildConfig();
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { config } = result;
      if (!config.printer) throw new Error(t("setup.failed"));
      // A minimal spec: one line of text, rendered by the same code that will
      // print real labels, in the language this workstation is configured for.
      const spec: LabelTemplateSpec = {
        widthMm: 58,
        heightMm: 40,
        dpi: 203,
        language: config.printerLanguage,
        elements: [{ id: "t", kind: "text", text: "Markiro", xMm: 4, yMm: 4, fontSizePt: 12 }],
      };
      const bytes = await renderLabelBytes(
        spec,
        sampleLabelData(),
        config.printerLanguage,
        rasterizeText,
      );
      await hw.print(config.printer, bytes);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("setup.failed"));
    } finally {
      setBusy(false);
    }
  }

  async function finish() {
    const result = buildConfig();
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setBusy(true);
    setError(null);
    const { config } = result;
    try {
      await saveHardwareConfig(exec, config);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("setup.failed"));
      setBusy(false);
      return;
    }
    setBusy(false);
    onConfigChange(config);
    onDone();
  }

  async function changeSound(next: SoundSettings) {
    // Optimistic: the UI reflects the operator's choice immediately even if
    // persistence below fails, so the toggle never appears stuck.
    onSoundChange(next);
    try {
      await saveSoundSettings(exec, next);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("setup.failed"));
    }
  }

  return (
    <main style={{ padding: 32, display: "flex", flexDirection: "column", gap: 32 }}>
      <h1 style={{ fontSize: "2rem" }}>{t("setup.title")}</h1>
      {/* Visible for as long as the stored configuration is still loading, so
          the screen doesn't just look unresponsive while every control below
          is disabled. */}
      {loading && <p role="status">{t("setup.loading")}</p>}

      <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <h2 style={{ fontSize: "1.5rem" }}>{t("setup.scanner")}</h2>
        <ul style={{ listStyle: "none", padding: 0, display: "flex", gap: 12 }}>
          <li>
            {/* Renders even when `ports` is empty (Finding 1): a serial
                scanner that has been unplugged and replaced with a USB HID
                one must still be de-selectable, and the discovered port list
                being empty is exactly that case. Clearing `port` makes
                `buildConfig()` emit `scanner: null`, which is what lets
                `pickScanSource` fall back to the keyboard wedge. */}
            <Button
              type="button"
              variant={port === "" ? "primary" : "secondary"}
              style={{ minHeight: 64 }}
              disabled={loading}
              onClick={() => setPort("")}
            >
              {t("setup.noScanner")}
            </Button>
          </li>
          {/* Finding 4: a port stored in configuration but absent from the
              discovered list (e.g. a serial scanner unplugged and replaced by
              a USB HID wedge, so `listScannerPorts()` no longer reports it)
              must still render as a selectable, visibly-selected button.
              Without this, an operator sees no button matching what is
              actually configured, mistakes the (unrelated) "no scanner"
              button's unselected look for "nothing is configured", and
              re-saves the stale port by pressing Done. */}
          {storedPort !== "" && !ports.includes(storedPort) && (
            <li>
              <Button
                type="button"
                variant={port === storedPort ? "primary" : "secondary"}
                style={{ minHeight: 64 }}
                disabled={loading}
                onClick={() => setPort(storedPort)}
              >
                {t("setup.portNotDetected", { port: storedPort })}
              </Button>
            </li>
          )}
          {ports.map((p) => (
            <li key={p}>
              <Button
                type="button"
                variant={p === port ? "primary" : "secondary"}
                style={{ minHeight: 64 }}
                disabled={loading}
                onClick={() => setPort(p)}
              >
                {p}
              </Button>
            </li>
          ))}
        </ul>
        <Input
          label={t("setup.baud")}
          value={baud}
          disabled={loading}
          onChange={(e) => setBaud(e.target.value)}
        />
        <Button
          type="button"
          style={{ minHeight: 64 }}
          disabled={busy || loading || port.length === 0}
          onClick={() => void openScanner()}
        >
          {t("setup.openScanner")}
        </Button>
        <p>{t("setup.testScanHint")}</p>
        <p>
          {t("setup.lastScan")}: <span>{lastScan ?? "—"}</span>
        </p>
      </section>

      <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <h2 style={{ fontSize: "1.5rem" }}>{t("setup.printer")}</h2>
        <div style={{ display: "flex", gap: 12 }}>
          <span>{t("setup.printerTransport")}</span>
          {/* Explicit and mutually exclusive: replaces the old
              `printerHost ? tcp : serial` inference, which kept building a
              stale TCP target after an operator typed a serial port because
              the host field from a previously-stored TCP printer was still
              populated. Only the fields for the selected transport render
              below, so there is never an ambiguous "both filled in" state,
              and switching transports doesn't require clearing anything by
              hand for it to take effect. */}
          <Button
            type="button"
            variant={printerTransport === "tcp" ? "primary" : "secondary"}
            style={{ minHeight: 64 }}
            disabled={loading}
            onClick={() => setPrinterTransport("tcp")}
          >
            {t("setup.transportTcp")}
          </Button>
          <Button
            type="button"
            variant={printerTransport === "serial" ? "primary" : "secondary"}
            style={{ minHeight: 64 }}
            disabled={loading}
            onClick={() => setPrinterTransport("serial")}
          >
            {t("setup.transportSerial")}
          </Button>
        </div>
        {printerTransport === "tcp" ? (
          <>
            <Input
              label={t("setup.host")}
              value={printerHost}
              disabled={loading}
              onChange={(e) => setPrinterHost(e.target.value)}
            />
            <Input
              label={t("setup.printerTcpPort")}
              value={printerTcpPort}
              disabled={loading}
              onChange={(e) => setPrinterTcpPort(e.target.value)}
            />
          </>
        ) : (
          <>
            <Input
              label={t("setup.printerPort")}
              value={printerPort}
              disabled={loading}
              onChange={(e) => setPrinterPort(e.target.value)}
            />
            <Input
              label={t("setup.printerBaud")}
              value={printerBaud}
              disabled={loading}
              onChange={(e) => setPrinterBaud(e.target.value)}
            />
          </>
        )}
        <div style={{ display: "flex", gap: 12 }}>
          <span>{t("setup.printerLanguage")}</span>
          <Button
            type="button"
            variant={printerLanguage === "zpl" ? "primary" : "secondary"}
            style={{ minHeight: 64 }}
            disabled={loading}
            onClick={() => setPrinterLanguage("zpl")}
          >
            {t("setup.languageZpl")}
          </Button>
          <Button
            type="button"
            variant={printerLanguage === "tspl" ? "primary" : "secondary"}
            style={{ minHeight: 64 }}
            disabled={loading}
            onClick={() => setPrinterLanguage("tspl")}
          >
            {t("setup.languageTspl")}
          </Button>
        </div>
        <Button
          type="button"
          style={{ minHeight: 64 }}
          disabled={
            busy ||
            loading ||
            (printerTransport === "tcp" ? printerHost.length === 0 : printerPort.length === 0)
          }
          onClick={() => void testPrint()}
        >
          {t("setup.testPrint")}
        </Button>
      </section>

      <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <h2 style={{ fontSize: "1.5rem" }}>{t("setup.sound")}</h2>
        <label style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <input
            type="checkbox"
            checked={sound.muted}
            onChange={(e) => void changeSound({ ...sound, muted: e.target.checked })}
          />
          {t("setup.mute")}
        </label>
        <label style={{ display: "flex", gap: 12, alignItems: "center" }}>
          {t("setup.volume")}
          <input
            type="range"
            min={0}
            max={1}
            step={0.1}
            value={sound.volume}
            onChange={(e) => void changeSound({ ...sound, volume: Number(e.target.value) })}
          />
        </label>
      </section>

      {error !== null && <p role="alert">{error}</p>}

      <div style={{ display: "flex", gap: 12 }}>
        {/* Never depends on `saveHardwareConfig` succeeding, so a SQLite
            write failure never traps the operator on this screen with no way
            out. Disabled only while `busy` -- a hardware operation (scanner
            open, test print, or save) is in flight: if Back unmounted this
            screen while an abandoned `openScanner()` was still resolving,
            the app's saved-config reconciliation could race that open and an
            unsaved test port could win and replace the persisted scanner.
            `busy` always clears in a `finally` above, so this is never
            disabled for longer than that operation's own retry budget --
            Back can never strand the operator here. */}
        <Button
          type="button"
          variant="secondary"
          style={{ minHeight: 64 }}
          disabled={busy}
          onClick={() => onDone()}
        >
          {t("setup.back")}
        </Button>
        <Button
          type="button"
          style={{ minHeight: 64 }}
          disabled={busy || loading}
          onClick={() => void finish()}
        >
          {t("setup.done")}
        </Button>
      </div>
    </main>
  );
}
