import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Input } from "@markiro/ui";
import { saveSoundSettings, type SoundSettings } from "../lib/signal-sound.js";
import type { HardwareContract, PrintTarget } from "../lib/hardware.js";
import type { SqlExecutor } from "../lib/mirror.js";

export interface WorkstationSetupProps {
  hw: HardwareContract;
  exec: SqlExecutor;
  sound: SoundSettings;
  onSoundChange: (s: SoundSettings) => void;
  onDone: () => void;
}

const DEFAULT_BAUD = 9600;
const DEFAULT_PRINTER_PORT = 9100;

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
  onDone,
}: WorkstationSetupProps) {
  const { t } = useTranslation();
  const [ports, setPorts] = useState<string[]>([]);
  const [port, setPort] = useState("");
  const [baud, setBaud] = useState(String(DEFAULT_BAUD));
  const [lastScan, setLastScan] = useState<string | null>(null);
  const [printerHost, setPrinterHost] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void hw
      .listScannerPorts()
      .then(setPorts)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : t("setup.failed")));
  }, [hw, t]);

  // Live scans are shown for as long as this screen is open, so the operator
  // can confirm the scanner really works before leaving.
  useEffect(() => {
    let unsubscribe: (() => void) | null = null;
    let stopped = false;
    void hw.onScan(setLastScan).then((fn) => {
      if (stopped) fn();
      else unsubscribe = fn;
    });
    return () => {
      stopped = true;
      unsubscribe?.();
    };
  }, [hw]);

  async function openScanner() {
    setBusy(true);
    setError(null);
    try {
      await hw.openScanner(port, Number(baud) || DEFAULT_BAUD);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("setup.failed"));
    } finally {
      setBusy(false);
    }
  }

  async function testPrint() {
    setBusy(true);
    setError(null);
    try {
      const target: PrintTarget = printerHost
        ? { kind: "tcp", host: printerHost, port: DEFAULT_PRINTER_PORT }
        : { kind: "serial", port, baud: Number(baud) || DEFAULT_BAUD };
      // A minimal, printer-agnostic ZPL self-test: start, one line, end.
      const zpl = "^XA^FO40,40^A0N,40,40^FDMarkiro^FS^XZ";
      await hw.print(target, new TextEncoder().encode(zpl));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("setup.failed"));
    } finally {
      setBusy(false);
    }
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
        <Button
          type="button"
          style={{ minHeight: 64 }}
          disabled={busy}
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

      <Button type="button" style={{ minHeight: 64 }} onClick={onDone}>
        {t("setup.done")}
      </Button>
    </main>
  );
}
