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

function parseBaud(value: string): number {
  return Number(value) || DEFAULT_BAUD;
}

function parsePort(value: string): number {
  return Number(value) || DEFAULT_PRINTER_PORT;
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
  const [baud, setBaud] = useState(String(DEFAULT_BAUD));
  const [lastScan, setLastScan] = useState<string | null>(null);
  const [printerHost, setPrinterHost] = useState("");
  const [printerTcpPort, setPrinterTcpPort] = useState(String(DEFAULT_PRINTER_PORT));
  const [printerPort, setPrinterPort] = useState("");
  const [printerBaud, setPrinterBaud] = useState(String(DEFAULT_BAUD));
  const [printerLanguage, setPrinterLanguage] = useState<PrinterLanguage>("zpl");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void hw
      .listScannerPorts()
      .then(setPorts)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : t("setup.failed")));
  }, [hw, t]);

  // Seed every field from the stored configuration, so an operator reopening
  // this screen sees what is actually configured rather than blank defaults.
  useEffect(() => {
    void loadHardwareConfig(exec).then((config) => {
      if (config.scanner) {
        setPort(config.scanner.port);
        setBaud(String(config.scanner.baud));
      }
      if (config.printer?.kind === "tcp") {
        setPrinterHost(config.printer.host);
        setPrinterTcpPort(String(config.printer.port));
      }
      if (config.printer?.kind === "serial") {
        setPrinterPort(config.printer.port);
        setPrinterBaud(String(config.printer.baud));
      }
      setPrinterLanguage(config.printerLanguage);
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
    setBusy(true);
    setError(null);
    try {
      // Retire any previous session first: without this a wrong port leaves
      // the scanner "already open" until the app restarts.
      await hw.closeScanner();
      await hw.openScanner(port, parseBaud(baud));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("setup.failed"));
    } finally {
      setBusy(false);
    }
  }

  function currentConfig(): HardwareConfig {
    const printer: PrintTarget | null = printerHost
      ? { kind: "tcp", host: printerHost, port: parsePort(printerTcpPort) }
      : printerPort
        ? { kind: "serial", port: printerPort, baud: parseBaud(printerBaud) }
        : null;
    return {
      scanner: port ? { port, baud: parseBaud(baud) } : null,
      printer,
      printerLanguage,
    };
  }

  async function testPrint() {
    setBusy(true);
    setError(null);
    try {
      const config = currentConfig();
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
    setBusy(true);
    setError(null);
    const config = currentConfig();
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

      <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <h2 style={{ fontSize: "1.5rem" }}>{t("setup.scanner")}</h2>
        <ul style={{ listStyle: "none", padding: 0, display: "flex", gap: 12 }}>
          <li>
            {/* Renders even when `ports` is empty (Finding 1): a serial
                scanner that has been unplugged and replaced with a USB HID
                one must still be de-selectable, and the discovered port list
                being empty is exactly that case. Clearing `port` makes
                `currentConfig()` emit `scanner: null`, which is what lets
                `pickScanSource` fall back to the keyboard wedge. */}
            <Button
              type="button"
              variant={port === "" ? "primary" : "secondary"}
              style={{ minHeight: 64 }}
              onClick={() => setPort("")}
            >
              {t("setup.noScanner")}
            </Button>
          </li>
          {ports.map((p) => (
            <li key={p}>
              <Button
                type="button"
                variant={p === port ? "primary" : "secondary"}
                style={{ minHeight: 64 }}
                onClick={() => setPort(p)}
              >
                {p}
              </Button>
            </li>
          ))}
        </ul>
        <Input label={t("setup.baud")} value={baud} onChange={(e) => setBaud(e.target.value)} />
        <Button
          type="button"
          style={{ minHeight: 64 }}
          disabled={busy || port.length === 0}
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
        <Input
          label={t("setup.host")}
          value={printerHost}
          onChange={(e) => setPrinterHost(e.target.value)}
        />
        <Input
          label={t("setup.printerTcpPort")}
          value={printerTcpPort}
          onChange={(e) => setPrinterTcpPort(e.target.value)}
        />
        <Input
          label={t("setup.printerPort")}
          value={printerPort}
          onChange={(e) => setPrinterPort(e.target.value)}
        />
        <Input
          label={t("setup.printerBaud")}
          value={printerBaud}
          onChange={(e) => setPrinterBaud(e.target.value)}
        />
        <div style={{ display: "flex", gap: 12 }}>
          <span>{t("setup.printerLanguage")}</span>
          <Button
            type="button"
            variant={printerLanguage === "zpl" ? "primary" : "secondary"}
            style={{ minHeight: 64 }}
            onClick={() => setPrinterLanguage("zpl")}
          >
            {t("setup.languageZpl")}
          </Button>
          <Button
            type="button"
            variant={printerLanguage === "tspl" ? "primary" : "secondary"}
            style={{ minHeight: 64 }}
            onClick={() => setPrinterLanguage("tspl")}
          >
            {t("setup.languageTspl")}
          </Button>
        </div>
        <Button
          type="button"
          style={{ minHeight: 64 }}
          disabled={busy || (printerHost.length === 0 && printerPort.length === 0)}
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
        {/* Unconditional: unlike Done, this never depends on
            `saveHardwareConfig` succeeding, so a SQLite write failure never
            traps the operator on this screen with no way out. */}
        <Button
          type="button"
          variant="secondary"
          style={{ minHeight: 64 }}
          onClick={() => onDone()}
        >
          {t("setup.back")}
        </Button>
        <Button
          type="button"
          style={{ minHeight: 64 }}
          disabled={busy}
          onClick={() => void finish()}
        >
          {t("setup.done")}
        </Button>
      </div>
    </main>
  );
}
