import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, FullScreenDialog } from "@markiro/ui";
import { sampleLabelData, type LabelTemplateSpec } from "@markiro/domain";
import { playSignalTone, saveSoundSettings, type SoundSettings } from "../lib/signal-sound.js";
import type { HardwareContract, PrintTarget, UsbPrinterInfo } from "../lib/hardware.js";
import {
  loadHardwareConfig,
  saveHardwareConfig,
  type HardwareConfig,
  type PrinterLanguage,
} from "../lib/hardware-config.js";
import { renderLabelBytes } from "../lib/print-label.js";
import { rasterizeText } from "../lib/rasterizer.js";
import type { SqlExecutor } from "../lib/mirror.js";
import { PrinterSetupPanel } from "../ui/setup/PrinterSetupPanel.js";
import { ScannerSetupPanel } from "../ui/setup/ScannerSetupPanel.js";
import { SetupTabs, type SetupTabId } from "../ui/setup/SetupTabs.js";
import { SoundSetupPanel } from "../ui/setup/SoundSetupPanel.js";
import { makeSetupTestCode, type SetupCheckResult } from "../ui/setup/test-code.js";

export interface WorkstationSetupProps {
  hw: HardwareContract;
  exec: SqlExecutor;
  sound: SoundSettings;
  onSoundChange: (s: SoundSettings) => void;
  onConfigChange: (config: HardwareConfig) => void;
  onResetCredential?: () => Promise<void>;
  credentialResetBlockedReason?: string;
  onDone: () => void;
}

const DEFAULT_BAUD = 9600;
const DEFAULT_PRINTER_PORT = 9100;
const MAX_BAUD = 4294967295;
const TAB_ORDER: readonly SetupTabId[] = ["scanner", "printer", "sound"];

function parseBaud(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const number = Number(trimmed);
  if (!Number.isInteger(number) || number < 1 || number > MAX_BAUD) return null;
  return number;
}

function parseTcpPort(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const number = Number(trimmed);
  if (!Number.isInteger(number) || number < 1 || number > 65535) return null;
  return number;
}

type ConfigResult = { ok: true; config: HardwareConfig } | { ok: false; error: string };

/** Sole owner of setup state, persistence, and hardware side effects. */
export function WorkstationSetup({
  hw,
  exec,
  sound,
  onSoundChange,
  onConfigChange,
  onResetCredential,
  credentialResetBlockedReason,
  onDone,
}: WorkstationSetupProps) {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<SetupTabId>("scanner");
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;
  const [ports, setPorts] = useState<string[]>([]);
  const [port, setPort] = useState("");
  const [storedPort, setStoredPort] = useState("");
  const [baud, setBaud] = useState(String(DEFAULT_BAUD));
  // The check codes and their verdicts. Refs mirror the pieces the mount-only
  // scan subscription needs, so a scan is always judged against the code that
  // is on screen (or on the last printed label) at the moment it arrives.
  const [scannerTestCode, setScannerTestCode] = useState(() => makeSetupTestCode());
  const [scannerCheck, setScannerCheck] = useState<SetupCheckResult | null>(null);
  const [printedTestCode, setPrintedTestCode] = useState<string | null>(null);
  const [printerCheck, setPrinterCheck] = useState<SetupCheckResult | null>(null);
  const scannerCodeRef = useRef(scannerTestCode);
  scannerCodeRef.current = scannerTestCode;
  const printedCodeRef = useRef(printedTestCode);
  printedCodeRef.current = printedTestCode;
  const [printerHost, setPrinterHost] = useState("");
  const [printerTcpPort, setPrinterTcpPort] = useState(String(DEFAULT_PRINTER_PORT));
  const [printerPort, setPrinterPort] = useState("");
  const [printerBaud, setPrinterBaud] = useState(String(DEFAULT_BAUD));
  const [usbPrinters, setUsbPrinters] = useState<UsbPrinterInfo[]>([]);
  const [usbPrinter, setUsbPrinter] = useState("");
  const [printerTransport, setPrinterTransport] = useState<PrintTarget["kind"] | "none">("none");
  const [printerLanguage, setPrinterLanguage] = useState<PrinterLanguage>("zpl");
  const [verifyPrintedLabel, setVerifyPrintedLabel] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ tab: SetupTabId; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [resetConfirmationOpen, setResetConfirmationOpen] = useState(false);

  useEffect(() => {
    void hw
      .listScannerPorts()
      .then(setPorts)
      .catch((caught: unknown) =>
        setError(caught instanceof Error ? caught.message : t("setup.failed")),
      );
  }, [hw, t]);

  useEffect(() => {
    void hw
      .listUsbPrinters()
      .then(setUsbPrinters)
      .catch((caught: unknown) =>
        setError(caught instanceof Error ? caught.message : t("setup.failed")),
      );
  }, [hw, t]);

  useEffect(() => {
    void loadHardwareConfig(exec)
      .then((config) => {
        if (config.scanner) {
          setPort(config.scanner.port);
          setStoredPort(config.scanner.port);
          setBaud(String(config.scanner.baud));
        }
        if (config.printer?.kind === "tcp") {
          setPrinterTransport("tcp");
          setPrinterHost(config.printer.host);
          setPrinterTcpPort(String(config.printer.port));
        } else if (config.printer?.kind === "serial") {
          setPrinterTransport("serial");
          setPrinterPort(config.printer.port);
          setPrinterBaud(String(config.printer.baud));
        } else if (config.printer?.kind === "usb") {
          setPrinterTransport("usb");
          setUsbPrinter(config.printer.printer);
        } else {
          setPrinterTransport("none");
        }
        setPrinterLanguage(config.printerLanguage);
        setVerifyPrintedLabel(config.verifyPrintedLabel);
        setLoading(false);
      })
      .catch((caught: unknown) => {
        setError(caught instanceof Error ? caught.message : t("setup.failed"));
        setLoading(false);
      });
  }, [exec, t]);

  useEffect(() => {
    let unsubscribe: (() => void) | null = null;
    let stopped = false;
    void hw
      .onScan((raw) => {
        // A scan on the printer tab with a test label outstanding judges the
        // PRINTED code; anywhere else it judges the on-screen code. Both are
        // exact comparisons — a stale or foreign code must read as a failure,
        // never as «works correctly».
        if (activeTabRef.current === "printer" && printedCodeRef.current !== null) {
          setPrinterCheck({ ok: raw === printedCodeRef.current, received: raw });
        } else {
          setScannerCheck({ ok: raw === scannerCodeRef.current, received: raw });
        }
      })
      .then((stop) => {
        if (stopped) stop();
        else unsubscribe = stop;
      })
      .catch((caught: unknown) => {
        if (!stopped) setError(caught instanceof Error ? caught.message : t("setup.failed"));
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
    setTestResult(null);
    try {
      // Scanner session ownership stays atomic: retire the old session before
      // opening the test selection, exactly as the runtime reconciliation does.
      await hw.closeScanner();
      await hw.openScanner(port, baudValue);
      setTestResult({ tab: "scanner", text: t("setup.scannerConnected") });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("setup.failed"));
    } finally {
      setBusy(false);
    }
  }

  async function refreshUsbPrinters() {
    setBusy(true);
    setError(null);
    try {
      setUsbPrinters(await hw.listUsbPrinters());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("setup.failed"));
    } finally {
      setBusy(false);
    }
  }

  function buildConfig(): ConfigResult {
    let scanner: HardwareConfig["scanner"] = null;
    if (port !== "") {
      const baudValue = parseBaud(baud);
      if (baudValue === null) return { ok: false, error: t("setup.invalidNumber") };
      scanner = { port, baud: baudValue };
    }

    let printer: PrintTarget | null = null;
    if (printerTransport === "tcp") {
      if (printerHost === "") return { ok: false, error: t("setup.printerFieldRequired") };
      const tcpPort = parseTcpPort(printerTcpPort);
      if (tcpPort === null) return { ok: false, error: t("setup.invalidNumber") };
      printer = { kind: "tcp", host: printerHost, port: tcpPort };
    } else if (printerTransport === "serial") {
      if (printerPort === "") return { ok: false, error: t("setup.printerFieldRequired") };
      const serialBaud = parseBaud(printerBaud);
      if (serialBaud === null) return { ok: false, error: t("setup.invalidNumber") };
      printer = { kind: "serial", port: printerPort, baud: serialBaud };
    } else if (printerTransport === "usb") {
      if (usbPrinter === "") return { ok: false, error: t("setup.printerFieldRequired") };
      printer = { kind: "usb", printer: usbPrinter };
    }

    return {
      ok: true,
      config: {
        scanner,
        printer,
        printerLanguage,
        verifyPrintedLabel: printer === null ? false : verifyPrintedLabel,
      },
    };
  }

  async function testPrint() {
    const result = buildConfig();
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setBusy(true);
    setError(null);
    setTestResult(null);
    try {
      if (!result.config.printer) throw new Error(t("setup.failed"));
      // A fresh code per print: scanning yesterday's test label must fail the
      // check, because the check certifies THIS print run, not the printer's
      // biography. The barcode makes the check end-to-end — transport,
      // language, print quality, and the scanner all vouch for each other.
      const code = makeSetupTestCode();
      const spec: LabelTemplateSpec = {
        widthMm: 58,
        heightMm: 40,
        dpi: 203,
        language: result.config.printerLanguage,
        elements: [
          // Plain ASCII on purpose: non-ASCII text switches the ZPL emitter to
          // its rasterized branch, which needs a 2D canvas the test print must
          // not depend on.
          { id: "t", kind: "text", text: "MARKIRO TEST", xMm: 4, yMm: 4, fontSizePt: 10 },
          {
            id: "b",
            kind: "barcode",
            format: "code128",
            data: { literal: code },
            xMm: 4,
            yMm: 11,
            sizeMm: 16,
          },
          { id: "c", kind: "text", text: code, xMm: 4, yMm: 30, fontSizePt: 10 },
        ],
      };
      const bytes = await renderLabelBytes(
        spec,
        sampleLabelData(),
        result.config.printerLanguage,
        rasterizeText,
      );
      await hw.print(result.config.printer, bytes);
      setPrintedTestCode(code);
      setPrinterCheck(null);
      setTestResult({ tab: "printer", text: t("setup.testPrintSent") });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("setup.failed"));
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
    try {
      await saveHardwareConfig(exec, result.config);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("setup.failed"));
      setBusy(false);
      return;
    }
    setBusy(false);
    onConfigChange(result.config);
    onDone();
  }

  async function changeSound(next: SoundSettings) {
    setTestResult((current) => (current?.tab === "sound" ? null : current));
    onSoundChange(next);
    try {
      await saveSoundSettings(exec, next);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("setup.failed"));
    }
  }

  function testSound() {
    if (sound.muted || sound.volume <= 0) return;
    setError(null);
    playSignalTone("ok", sound);
    setTestResult({ tab: "sound", text: t("setup.soundTestRequested") });
  }

  async function resetCredential() {
    if (!onResetCredential || busy) return;
    setResetConfirmationOpen(false);
    setBusy(true);
    setError(null);
    try {
      await onResetCredential();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("setup.resetCredentialFailed"));
    } finally {
      setBusy(false);
    }
  }

  function nextTab() {
    const index = TAB_ORDER.indexOf(activeTab);
    const next = TAB_ORDER[index + 1];
    if (next) setActiveTab(next);
  }

  const tabs = [
    {
      id: "scanner" as const,
      label: t("setup.scanner"),
      panel: (
        <ScannerSetupPanel
          ports={ports}
          port={port}
          storedPort={storedPort}
          baud={baud}
          disabled={loading}
          busy={busy}
          testCode={scannerTestCode}
          check={scannerCheck}
          onPortChange={setPort}
          onBaudChange={setBaud}
          onConnect={() => void openScanner()}
          onNewCode={() => {
            setScannerTestCode(makeSetupTestCode());
            setScannerCheck(null);
          }}
        />
      ),
    },
    {
      id: "printer" as const,
      label: t("setup.printer"),
      panel: (
        <PrinterSetupPanel
          printedCode={printedTestCode}
          check={printerCheck}
          transport={printerTransport}
          host={printerHost}
          tcpPort={printerTcpPort}
          serialPort={printerPort}
          serialBaud={printerBaud}
          usbPrinters={usbPrinters}
          usbPrinter={usbPrinter}
          language={printerLanguage}
          verifyPrintedLabel={verifyPrintedLabel}
          disabled={loading}
          busy={busy}
          onTransportChange={setPrinterTransport}
          onHostChange={setPrinterHost}
          onTcpPortChange={setPrinterTcpPort}
          onSerialPortChange={setPrinterPort}
          onSerialBaudChange={setPrinterBaud}
          onUsbPrinterChange={setUsbPrinter}
          onUsbRefresh={() => void refreshUsbPrinters()}
          onLanguageChange={setPrinterLanguage}
          onVerifyPrintedLabelChange={setVerifyPrintedLabel}
          onTestPrint={() => void testPrint()}
        />
      ),
    },
    {
      id: "sound" as const,
      label: t("setup.sound"),
      panel: (
        <SoundSetupPanel
          sound={sound}
          disabled={loading || busy}
          onSoundChange={(next) => void changeSound(next)}
          onTestSound={testSound}
        />
      ),
    },
  ];

  const soundTestUnavailable = sound.muted || sound.volume <= 0;
  const activeResult =
    testResult?.tab === activeTab && !(activeTab === "sound" && soundTestUnavailable)
      ? testResult.text
      : null;
  const resultText = error
    ? error
    : loading
      ? t("setup.loading")
      : (activeResult ??
        (credentialResetBlockedReason
          ? credentialResetBlockedReason
          : activeTab === "printer"
            ? t("setup.testPrintHint")
            : activeTab === "sound" && soundTestUnavailable
              ? t("setup.soundTestUnavailable")
              : onResetCredential
                ? t("setup.repairHint")
                : activeTab === "sound"
                  ? t("setup.soundHint")
                  : t("setup.testScanHint")));

  return (
    <main className="workstation-setup" aria-labelledby="workstation-setup-title">
      <header className="workstation-setup__header">
        <h1 id="workstation-setup-title">{t("setup.title")}</h1>
      </header>

      <SetupTabs tabs={tabs} activeTab={activeTab} onTabChange={setActiveTab} />

      <div
        className={`workstation-setup__result${error ? " workstation-setup__result--error" : ""}`}
        data-testid="setup-result"
        role={error ? "alert" : "status"}
      >
        {resultText}
      </div>

      <footer className="workstation-setup__footer" data-testid="setup-footer">
        <Button size="floor" variant="secondary" disabled={busy} onClick={onDone}>
          {t("setup.back")}
        </Button>
        {onResetCredential ? (
          <Button
            size="floor"
            variant="secondary"
            disabled={busy || loading}
            onClick={() => setResetConfirmationOpen(true)}
          >
            {t("setup.repairAction")}
          </Button>
        ) : null}
        <span className="workstation-setup__footer-spacer" />
        {activeTab !== "sound" ? (
          <Button size="floor" variant="secondary" disabled={busy} onClick={nextTab}>
            {t("setup.next")}
          </Button>
        ) : null}
        <Button size="floor" disabled={busy || loading} onClick={() => void finish()}>
          {t("setup.done")}
        </Button>
      </footer>

      {onResetCredential ? (
        <FullScreenDialog
          open={resetConfirmationOpen}
          title={t("setup.resetCredentialConfirmTitle")}
          backLabel={t("setup.cancel")}
          onClose={() => setResetConfirmationOpen(false)}
          footer={
            <Button
              size="floor"
              variant="destructive"
              disabled={busy}
              onClick={() => void resetCredential()}
            >
              {t("setup.resetCredentialConfirmAction")}
            </Button>
          }
        >
          <div className="workstation-setup__reset-confirmation">
            <p>{t("setup.resetCredentialConfirmDetail")}</p>
          </div>
        </FullScreenDialog>
      ) : null}
    </main>
  );
}
