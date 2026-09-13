import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, FullScreenDialog } from "@markiro/ui";
import { sampleLabelData, type LabelTemplateSpec } from "@markiro/domain";
import { playSignalTone, saveSoundSettings, type SoundSettings } from "../lib/signal-sound.js";
import type {
  HardwareContract,
  PrintTarget,
  UsbPrinterInfo,
  ScannerConnection,
} from "../lib/hardware.js";
import {
  loadHardwareConfig,
  configuredScanners,
  canonicalScannerPort,
  type SerialScannerConfig,
  saveHardwareConfig,
  type HardwareConfig,
  type PrinterLanguage,
} from "../lib/hardware-config.js";
import { renderLabelBytes } from "../lib/print-label.js";
import { rasterizeText } from "../lib/rasterizer.js";
import type { SqlExecutor } from "../lib/mirror.js";
import {
  configuredPrinterRouting,
  printerTargetKey,
  parsePrinterProfile,
  serializePrinterOutput,
  type PrinterProfile,
  type PrinterRouting,
} from "../lib/printer-routing.js";
import { PrinterRoutingPanel } from "../ui/setup/PrinterRoutingPanel.js";
import { PrinterSetupPanel } from "../ui/setup/PrinterSetupPanel.js";
import { ScannerSetupPanel, type AdditionalScannerRow } from "../ui/setup/ScannerSetupPanel.js";
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
  initialTab?: SetupTabId;
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
  initialTab = "scanner",
}: WorkstationSetupProps) {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<SetupTabId>(initialTab);
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;
  const [ports, setPorts] = useState<string[]>([]);
  const [port, setPort] = useState("");
  const [storedPort, setStoredPort] = useState("");
  const [baud, setBaud] = useState(String(DEFAULT_BAUD));
  const [additionalScanners, setAdditionalScanners] = useState<AdditionalScannerRow[]>([]);
  const [scannerConnections, setScannerConnections] = useState<ScannerConnection[]>([]);
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
  const [routing, setRouting] = useState<PrinterRouting>({
    printers: [],
    assignments: { box: null, duplicate: null, pallet: null },
  });
  const [editorId, setEditorId] = useState<string | null>(null);
  const [printerName, setPrinterName] = useState("");
  const [removeConfirmationOpen, setRemoveConfirmationOpen] = useState(false);
  const [printerHost, setPrinterHost] = useState("");
  const [printerTcpPort, setPrinterTcpPort] = useState(String(DEFAULT_PRINTER_PORT));
  const [printerPort, setPrinterPort] = useState("");
  const [printerBaud, setPrinterBaud] = useState(String(DEFAULT_BAUD));
  const [usbPrinters, setUsbPrinters] = useState<UsbPrinterInfo[]>([]);
  const [usbPrinter, setUsbPrinter] = useState("");
  const [printerTransport, setPrinterTransport] = useState<PrintTarget["kind"] | "none">("none");
  const [printerLanguage, setPrinterLanguage] = useState<PrinterLanguage>("zpl");
  const [printerDpi, setPrinterDpi] = useState<203 | 300 | null>(null);
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
        const savedScanners = configuredScanners(config);
        const first = savedScanners[0];
        setPort(first?.port ?? "");
        setStoredPort(first?.port ?? "");
        setBaud(String(first?.baud ?? DEFAULT_BAUD));
        setAdditionalScanners(
          savedScanners.slice(1).map((scanner) => ({
            id: crypto.randomUUID(),
            port: scanner.port,
            storedPort: scanner.port,
            baud: String(scanner.baud),
          })),
        );
        setRouting(configuredPrinterRouting(config));
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

  useEffect(() => {
    let stopped = false;
    let unsubscribe: (() => void) | null = null;
    void hw
      .onScannerConnections((connections) => {
        if (!stopped) setScannerConnections(connections);
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

  function buildScanners():
    { ok: true; scanners: SerialScannerConfig[] } | { ok: false; error: string } {
    const scanners: SerialScannerConfig[] = [];
    const seen = new Set<string>();
    for (const row of [{ port, baud }, ...additionalScanners]) {
      if (row.port === "") continue;
      const scannerPort = canonicalScannerPort(row.port);
      const baudValue = parseBaud(row.baud);
      if (!scannerPort || scannerPort.includes("\0") || baudValue === null)
        return { ok: false, error: t("setup.invalidNumber") };
      if (seen.has(scannerPort))
        return { ok: false, error: t("setup.duplicateScannerPort", { port: scannerPort }) };
      seen.add(scannerPort);
      scanners.push({ port: scannerPort, baud: baudValue });
    }
    return { ok: true, scanners };
  }

  async function openScanner() {
    const result = buildScanners();
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setBusy(true);
    setError(null);
    setTestResult(null);
    try {
      await hw.configureScanners(result.scanners);
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

  function openPrinter(printer?: PrinterProfile) {
    setEditorId(printer?.id ?? crypto.randomUUID());
    setPrinterName(
      printer?.name ?? t("setup.defaultPrinterName", { number: routing.printers.length + 1 }),
    );
    setPrinterTransport(printer?.target.kind ?? "none");
    setPrinterHost(printer?.target.kind === "tcp" ? printer.target.host : "");
    setPrinterTcpPort(
      String(printer?.target.kind === "tcp" ? printer.target.port : DEFAULT_PRINTER_PORT),
    );
    setPrinterPort(printer?.target.kind === "serial" ? printer.target.port : "");
    setPrinterBaud(String(printer?.target.kind === "serial" ? printer.target.baud : DEFAULT_BAUD));
    setUsbPrinter(printer?.target.kind === "usb" ? printer.target.printer : "");
    setPrinterLanguage(printer?.language ?? "zpl");
    setPrinterDpi(printer?.dpi ?? null);
    setPrintedTestCode(null);
    setPrinterCheck(null);
    setTestResult(null);
    setError(null);
  }

  function closePrinter() {
    setEditorId(null);
    setPrintedTestCode(null);
    setPrinterCheck(null);
    setTestResult(null);
    setError(null);
  }

  function buildPrinter():
    { ok: true; printer: PrinterProfile | null } | { ok: false; error: string } {
    if (printerTransport === "none") {
      if (routing.printers.some((printer) => printer.id === editorId))
        return { ok: false, error: t("setup.printerFieldRequired") };
      return { ok: true, printer: null };
    }
    const name = printerName.trim();
    if (!name || !editorId) return { ok: false, error: t("setup.printerNameRequired") };
    let target: PrintTarget;
    if (printerTransport === "tcp") {
      if (!printerHost.trim()) return { ok: false, error: t("setup.printerFieldRequired") };
      const tcpPort = parseTcpPort(printerTcpPort);
      if (tcpPort === null) return { ok: false, error: t("setup.invalidNumber") };
      target = { kind: "tcp", host: printerHost.trim(), port: tcpPort };
    } else if (printerTransport === "serial") {
      if (!printerPort.trim()) return { ok: false, error: t("setup.printerFieldRequired") };
      const serialBaud = parseBaud(printerBaud);
      if (serialBaud === null) return { ok: false, error: t("setup.invalidNumber") };
      target = { kind: "serial", port: canonicalScannerPort(printerPort), baud: serialBaud };
    } else {
      if (!usbPrinter.trim()) return { ok: false, error: t("setup.printerFieldRequired") };
      target = { kind: "usb", printer: usbPrinter.trim() };
    }
    const duplicate = routing.printers.find(
      (printer) =>
        printer.id !== editorId && printerTargetKey(printer.target) === printerTargetKey(target),
    );
    if (duplicate)
      return { ok: false, error: t("setup.duplicatePrinter", { name: duplicate.name }) };
    const printer = parsePrinterProfile({
      id: editorId,
      name,
      target,
      language: printerLanguage,
      dpi: printerDpi,
    });
    return printer ? { ok: true, printer } : { ok: false, error: t("setup.printerFieldRequired") };
  }

  function withPrinter(printer: PrinterProfile | null): PrinterRouting {
    if (!printer) return routing;
    const exists = routing.printers.some((saved) => saved.id === printer.id);
    return {
      printers: exists
        ? routing.printers.map((saved) => (saved.id === printer.id ? printer : saved))
        : [...routing.printers, printer],
      assignments:
        routing.printers.length === 0
          ? { box: printer.id, duplicate: printer.id, pallet: printer.id }
          : routing.assignments,
    };
  }

  function savePrinter() {
    const result = buildPrinter();
    if (!result.ok) {
      setError(result.error);
      return;
    }
    if (!result.printer) {
      setError(t("setup.printerFieldRequired"));
      return;
    }
    setRouting(withPrinter(result.printer));
    closePrinter();
  }

  function removePrinter() {
    setRouting((current) => ({
      printers: current.printers.filter((printer) => printer.id !== editorId),
      assignments: {
        box: current.assignments.box === editorId ? null : current.assignments.box,
        duplicate:
          current.assignments.duplicate === editorId ? null : current.assignments.duplicate,
        pallet: current.assignments.pallet === editorId ? null : current.assignments.pallet,
      },
    }));
    setRemoveConfirmationOpen(false);
    closePrinter();
  }

  function buildConfig(): ConfigResult {
    const scannerResult = buildScanners();
    if (!scannerResult.ok) return scannerResult;
    let nextRouting = routing;
    if (editorId !== null) {
      const result = buildPrinter();
      if (!result.ok) return result;
      nextRouting = withPrinter(result.printer);
    }
    const boxPrinter = nextRouting.printers.find(
      (printer) => printer.id === nextRouting.assignments.box,
    );
    return {
      ok: true,
      config: {
        scanner: scannerResult.scanners[0] ?? null,
        scanners: scannerResult.scanners,
        printer: boxPrinter?.target ?? null,
        printerLanguage: boxPrinter?.language ?? "zpl",
        printerDpi: boxPrinter?.dpi ?? null,
        printerRouting: nextRouting,
        verifyPrintedLabel: boxPrinter ? verifyPrintedLabel : false,
      },
    };
  }

  async function testPrint() {
    const result = buildPrinter();
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setBusy(true);
    setError(null);
    setTestResult(null);
    try {
      if (!result.printer) throw new Error(t("setup.failed"));
      // A fresh code per print: scanning yesterday's test label must fail the
      // check, because the check certifies THIS print run, not the printer's
      // biography. The barcode makes the check end-to-end — transport,
      // language, print quality, and the scanner all vouch for each other.
      const code = makeSetupTestCode();
      const spec: LabelTemplateSpec = {
        widthMm: 58,
        heightMm: 40,
        dpi: 203,
        language: result.printer.language,
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
      // The test label prints at the resolution the working labels will use.
      const bytes = await renderLabelBytes(
        spec,
        sampleLabelData(),
        result.printer.language,
        rasterizeText,
        { dpi: result.printer.dpi ?? null },
      );
      const target = result.printer.target;
      await serializePrinterOutput(target, () => hw.print(target, bytes));
      setPrintedTestCode(code);
      setPrinterCheck(null);
      setTestResult({
        tab: "printer",
        text: t("setup.testPrintSentTo", { name: result.printer.name }),
      });
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
          additionalScanners={additionalScanners}
          connections={scannerConnections}
          onAddScanner={() =>
            setAdditionalScanners((rows) => [
              ...rows,
              { id: crypto.randomUUID(), port: "", storedPort: "", baud: String(DEFAULT_BAUD) },
            ])
          }
          onRemoveScanner={(id) =>
            setAdditionalScanners((rows) => rows.filter((row) => row.id !== id))
          }
          onAdditionalScannerChange={(id, patch) =>
            setAdditionalScanners((rows) =>
              rows.map((row) => (row.id === id ? { ...row, ...patch } : row)),
            )
          }
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
      panel:
        editorId !== null ? (
          <PrinterSetupPanel
            name={printerName}
            onNameChange={setPrinterName}
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
            printerDpi={printerDpi}
            onPrinterDpiChange={setPrinterDpi}
            disabled={loading || busy}
            busy={busy}
            onTransportChange={setPrinterTransport}
            onHostChange={setPrinterHost}
            onTcpPortChange={setPrinterTcpPort}
            onSerialPortChange={setPrinterPort}
            onSerialBaudChange={setPrinterBaud}
            onUsbPrinterChange={setUsbPrinter}
            onUsbRefresh={() => void refreshUsbPrinters()}
            onLanguageChange={setPrinterLanguage}
            onTestPrint={() => void testPrint()}
          />
        ) : (
          <PrinterRoutingPanel
            routing={routing}
            disabled={loading || busy}
            onAdd={() => openPrinter()}
            onEdit={openPrinter}
            onAssign={(purpose, printerId) =>
              setRouting((current) => ({
                ...current,
                assignments: { ...current.assignments, [purpose]: printerId },
              }))
            }
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

  const showPrinterRouting = activeTab === "printer" && editorId === null;
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
            ? editorId !== null
              ? t("setup.testPrintHint")
              : t("setup.printerRoutingHint")
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

      <SetupTabs
        tabs={tabs}
        activeTab={activeTab}
        onTabChange={(tab) => {
          if (!busy) setActiveTab(tab);
        }}
      />

      <div
        className={`workstation-setup__feedback${showPrinterRouting ? " workstation-setup__feedback--printers" : ""}`}
      >
        {showPrinterRouting ? (
          <label className="setup-touch-choice setup-touch-choice--checkbox setup-printer-verification">
            <input
              type="checkbox"
              checked={routing.assignments.box !== null && verifyPrintedLabel}
              disabled={loading || busy || routing.assignments.box === null}
              onChange={(event) => setVerifyPrintedLabel(event.target.checked)}
            />
            <span>{t("setup.verifyPrintedLabel")}</span>
          </label>
        ) : null}
        <div
          className={`workstation-setup__result${error ? " workstation-setup__result--error" : ""}`}
          data-testid="setup-result"
          role={error ? "alert" : "status"}
        >
          {resultText}
        </div>
      </div>

      <footer className="workstation-setup__footer" data-testid="setup-footer">
        <Button
          size="floor"
          variant="secondary"
          disabled={busy}
          onClick={activeTab === "printer" && editorId !== null ? closePrinter : onDone}
        >
          {activeTab === "printer" && editorId !== null ? t("setup.cancel") : t("setup.back")}
        </Button>
        {onResetCredential && editorId === null ? (
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
        {activeTab === "printer" && editorId !== null ? (
          <>
            {routing.printers.some((printer) => printer.id === editorId) ? (
              <Button
                size="floor"
                variant="destructive"
                disabled={busy}
                onClick={() => setRemoveConfirmationOpen(true)}
              >
                {t("setup.removePrinter")}
              </Button>
            ) : null}
            <Button
              size="floor"
              variant="secondary"
              disabled={busy || loading}
              onClick={savePrinter}
            >
              {t("setup.savePrinter")}
            </Button>
          </>
        ) : activeTab !== "sound" ? (
          <Button size="floor" variant="secondary" disabled={busy} onClick={nextTab}>
            {t("setup.next")}
          </Button>
        ) : null}
        <Button size="floor" disabled={busy || loading} onClick={() => void finish()}>
          {t("setup.done")}
        </Button>
      </footer>

      <FullScreenDialog
        open={removeConfirmationOpen}
        title={t("setup.removePrinterTitle")}
        backLabel={t("setup.cancel")}
        onClose={() => setRemoveConfirmationOpen(false)}
        footer={
          <Button size="floor" variant="destructive" disabled={busy} onClick={removePrinter}>
            {t("setup.removePrinter")}
          </Button>
        }
      >
        <div className="workstation-setup__reset-confirmation">
          <p>
            {t("setup.removePrinterDetail", {
              name:
                routing.printers.find((printer) => printer.id === editorId)?.name ?? printerName,
            })}
          </p>
        </div>
      </FullScreenDialog>
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
