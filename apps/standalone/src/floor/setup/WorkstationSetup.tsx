import { parseScannedSscc, sampleLabelData, type MonoRaster } from "@markiro/domain";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, Input, Select, StatusChip, type TagPhase } from "@markiro/ui";

import type {
  HardwareApi,
  ScannerConfig,
  ScannerSnapshot,
  UsbPrinter,
} from "../../hardware/hardware.js";
import { checkScan, type ScanCheck } from "../../app/scan-check.js";
import { paintMonoRaster } from "../../labels/sheet-render.js";
import type { LocalExecutor } from "../../local/executor.js";
import { renderLabel } from "../print/label-render.js";
import { settleOutcome, type PrintJobCode, type RenderLabel } from "../print/print-jobs.js";
import type { PrintRuntime } from "../print/print-runtime.js";
import { printerFormatText } from "../print/printer-format.js";
import type { ScanChannel, ScanSource } from "../scan-source.js";
import { playSignalTone } from "../work/signal-sound.js";
import { a4TestSheet, makeA4TestSscc } from "./a4-test.js";
import {
  draftOf,
  newPrinterDraft,
  profileOf,
  settleDraft,
  type PrinterDraft,
} from "./printer-draft.js";
import { ComPortField } from "./ComPortField.js";
import { SetupTabs, type SetupTabId } from "./SetupTabs.js";
import {
  ScannerSelfTest,
  useScannerSelfTest,
  type SelfTestPrintResult,
} from "./ScannerSelfTest.js";
import type { SelfTestKind } from "./scanner-selftest.js";
import {
  makeTestCode,
  scannedTestCode,
  selfTestDataMatrixSpec,
  testLabelSpec,
} from "./test-label.js";
import { UnpairStation } from "./UnpairStation.js";
import {
  canonicalPort,
  InvalidSettingsError,
  isPortName,
  MAX_SCANNERS,
  PRINT_PURPOSES,
  printerMode,
  printerTargetKey,
  printsPurpose,
  readWorkstationSettings,
  saveWorkstationSettings,
  sharedSerialPort,
  soundLevel,
  type PrinterProfile,
  type PrintPurpose,
  type WorkstationSettings,
} from "./workstation-settings.js";
import "./workstation-setup.css";

/** The steps of the tones' level: 0, 10, … 100. */
const VOLUME_STEP = 10;

/** Dots per pixel of the A4 test sheet's preview: 2480 dots are 414 px wide. */
const A4_PREVIEW_FACTOR = 6;

export interface WorkstationSetupProps {
  local: LocalExecutor;
  hardware: Pick<
    HardwareApi,
    "listUsbPrinters" | "listSerialPorts" | "configureScanners" | "watchScanners"
  >;
  printing: PrintRuntime;
  /** The floor's scanner: the code of a test label is scanned back here. */
  source: ScanSource;
  /** How the test label is rendered; the app's by default. */
  render?: RenderLabel;
  /** How the A4 test sheet is made (plan А4); the app's by default. */
  a4Sheet?: typeof a4TestSheet;
  /** «Проверить звук»: the floor's own tone at this level (0–1); the generated tone by default. */
  playTone?: (level: number) => void;
  /** The settings were stored: the floor reads them again. */
  onSaved: (settings: WorkstationSettings) => void;
  onBack: () => void;
  /**
   * The tab the setup opens on (the cloud station's `initialTab`); «Принтеры» by default, as the
   * floor opens the setup mostly for a printer.
   */
  initialTab?: SetupTabId;
  /**
   * `scanners` — the scanner settings a station opens before its pairing
   * (owner feedback, first Windows test): the COM scanners and a check of what
   * a scan read, under «Настройки сканера»; printers, sound and the label
   * check stay as stored. `all` (the default) — the whole workstation setup.
   */
  scope?: "all" | "scanners";
}

/**
 * How a test print went, in words: the printer's answer, then the scan of its
 * code. A test on A4 paper (plan А4) is a sheet whose SSCC is scanned back
 * (`sheet`); any other is a label with a Code 128.
 */
type TestState =
  | { kind: "sending"; printerId: string }
  | { kind: "sent"; printerId: string; name: string; code: string; sheet: boolean }
  | { kind: "failed"; code: PrintJobCode; unknown: boolean; sheet: boolean }
  | { kind: "render_failed"; sheet: boolean }
  | { kind: "match" }
  | { kind: "mismatch"; name: string; code: string; sheet: boolean };

type Status =
  | { kind: "saved" }
  | { kind: "save_failed" }
  | { kind: "invalid" }
  | { kind: "scanners_failed" }
  | { kind: "scanner_unadded" };

/** The scanner as the shell lists it. */
function listed(snapshot: ScannerSnapshot, config: ScannerConfig) {
  return snapshot.scanners.some(
    (candidate) => candidate.port === config.port && candidate.baud === config.baud,
  );
}

/** The chip of a printer's row for the test it had: the phase of its tag (the words are in the bottom row). */
const TEST_CHIP: Record<TestState["kind"], { phase: TagPhase }> = {
  sending: { phase: "running" },
  sent: { phase: "planned" },
  match: { phase: "active" },
  mismatch: { phase: "attention" },
  failed: { phase: "failed" },
  render_failed: { phase: "failed" },
};

/** A button that waits for an answer: still on the keyboard, and a press that does nothing. */
const WAITING_STYLE: CSSProperties = { opacity: 0.45, cursor: "not-allowed" };

/** A toggle read as the cloud's touch checkbox: its box first, then its words (the button's style is inline). */
const TOGGLE_STYLE: CSSProperties = { justifyContent: "flex-start", padding: "0 16px" };
/** The label check's toggle sits in its own bordered row, as the cloud's checkbox does. */
const ROW_TOGGLE_STYLE: CSSProperties = {
  ...TOGGLE_STYLE,
  border: "1px solid transparent",
  background: "transparent",
};

/**
 * The workstation setup (stage 2a spec §5.7.8): the printers of this
 * computer — where each is, its language and resolution — which one prints
 * which label — for a Windows queue, whether it prints in the printer's
 * language or through the Windows driver (plan ДРВ, offered where the shell
 * prints through Windows) — and a test print whose code is scanned back; the
 * COM scanners with their connection as the shell reports it; the tones'
 * level; the check of a printed label. Nothing is stored until «Сохранить», which then gives
 * the shell the whole set of scanners — a set it would refuse is never
 * stored, so a scanner that works is not dropped for a bad one; «Назад»
 * leaves at once and says when it drops a change, so the setup never holds
 * the operator.
 */
export function WorkstationSetup({
  local,
  hardware,
  printing,
  source,
  render = renderLabel,
  a4Sheet = a4TestSheet,
  playTone = (level) => playSignalTone("ok", undefined, level),
  onSaved,
  onBack,
  initialTab = "printer",
  scope = "all",
}: WorkstationSetupProps) {
  const { t } = useTranslation();
  const scannersOnly = scope === "scanners";
  // What the last scan read, for the scanner check (scanners only).
  const [scanCheck, setScanCheck] = useState<ScanCheck | null>(null);
  // The scanner self-test («Проверить сканер»): its code and results outlive a change of tab.
  const selfTest = useScannerSelfTest();
  const { onScan: selfTestScan } = selfTest;
  const [activeTab, setActiveTab] = useState<SetupTabId>(initialTab);
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;
  const [stored, setStored] = useState<WorkstationSettings | null>(null);
  const [draft, setDraft] = useState<WorkstationSettings | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const [editor, setEditor] = useState<PrinterDraft | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [usbPrinters, setUsbPrinters] = useState<UsbPrinter[] | null>(null);
  const [usbFailed, setUsbFailed] = useState(false);
  const [usbAsking, setUsbAsking] = useState(false);
  // The shell prints through Windows drivers: the choice of the way of printing is offered only then.
  const [windowsDriver, setWindowsDriver] = useState(false);
  const [test, setTestState] = useState<TestState | null>(null);
  // The A4 test sheet as it was printed, for the screen (plan А4): the printer it was for, and its raster.
  const [a4Preview, setA4Preview] = useState<{ printerId: string; raster: MonoRaster } | null>(
    null,
  );
  const a4Canvas = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [saving, setSaving] = useState(false);
  // Two presses in one render see the same `saving`: the ref is the one that holds.
  const savingNow = useRef(false);
  const [snapshot, setSnapshot] = useState<ScannerSnapshot | null>(null);
  const [watchFailed, setWatchFailed] = useState(false);
  // The shell refused the saved scanners (`unapplied`), or this screen has not yet
  // given it the ones it found saved (neither): «Сохранить» gives them again.
  // `applied`: the shell took them, and its next snapshot lists them.
  const [unapplied, setUnapplied] = useState(false);
  const [applied, setApplied] = useState(false);
  const [serialPorts, setSerialPorts] = useState<string[] | null>(null);
  const [serialFailed, setSerialFailed] = useState(false);
  const [serialAsking, setSerialAsking] = useState(false);
  const [scanner, setScanner] = useState({ port: "", baud: "9600" });
  const [scannerError, setScannerError] = useState<string | null>(null);

  // The configured COM scanners and their connection, as the shell reports it.
  useEffect(() => {
    let stop: (() => void) | null = null;
    let cancelled = false;
    hardware
      .watchScanners((next) => {
        if (!cancelled) setSnapshot(next);
      })
      .then(
        (stopWatching) => {
          if (cancelled) stopWatching();
          else stop = stopWatching;
        },
        () => {
          if (!cancelled) setWatchFailed(true);
        },
      );
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [hardware]);

  useEffect(() => {
    let cancelled = false;
    readWorkstationSettings(local).then(
      (settings) => {
        if (cancelled) return;
        setStored(settings);
        setDraft(settings);
      },
      () => {
        if (!cancelled) setReadFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [local]);

  // The heading of what the operator works on — the printers, or a printer's
  // form — takes the focus when the screen opens and when the form opens or
  // closes: a keyboard starts at the section, not on the page behind it.
  const sectionHeading = useRef<HTMLHeadingElement>(null);
  const scannersHeading = useRef<HTMLHeadingElement>(null);
  const loaded = draft !== null && stored !== null;
  const editing = editor !== null;
  useEffect(() => {
    if (!loaded) return;
    (scannersOnly ? scannersHeading : sectionHeading).current?.focus();
  }, [loaded, editing, scannersOnly]);

  // The test print as the scanner's listener reads it: kept as it is set, so
  // a scan right after the label went is checked against it, never missed.
  const testRef = useRef<TestState | null>(null);
  const setTest = useCallback((next: TestState | null) => {
    testRef.current = next;
    setTestState(next);
  }, []);
  // Whose test it is, and which test: a test whose printer's paper changed, or that was removed, is
  // forgotten, and the answer of one still on its way is dropped (plan А4: «print checks reset when
  // the paper changes»).
  const testOwner = useRef<string | null>(null);
  const testGeneration = useRef(0);
  useEffect(() => {
    const listen = (raw: string, channel: ScanChannel) => {
      // The self-test judges the scans of its own tab against the code it showed (a label's
      // test scan on the printers tab is not its business); the text stays here.
      if (scannersOnly || activeTabRef.current === "check") selfTestScan(raw, channel);
      // The scanner check says what any scan read, never its text.
      if (scannersOnly) setScanCheck(checkScan(raw));
      const now = testRef.current;
      // The check stays open after a wrong scan, until the right code comes.
      if (now?.kind !== "sent" && now?.kind !== "mismatch") return;
      // A scan that is not this label's code is never shown: it may be a badge.
      // A sheet's SSCC is read as any scanner hands an SSCC over; a label's Code 128 as it was printed.
      const read = now.sheet ? parseScannedSscc(raw) : scannedTestCode(raw);
      setTest(
        read === now.code
          ? { kind: "match" }
          : { kind: "mismatch", name: now.name, code: now.code, sheet: now.sheet },
      );
    };
    return source.startTagged
      ? source.startTagged(listen)
      : source.start((raw) => listen(raw, "unknown"));
  }, [source, setTest, scannersOnly, selfTestScan]);

  // The keys typed into a text field are the field's, not a scan: the scan
  // source ignores them, and its Enter stays the field's. A field removed with
  // the focus on it (the printer form closing, the setup leaving) sends no
  // blur, so the source is told again when the form opens or closes and when
  // this screen goes.
  const manualEntry = {
    onFocus: () => source.setManualTextEntryActive(true),
    onBlur: () => source.setManualTextEntryActive(false),
  };
  // Another tab takes its fields away with the focus on one, too.
  useLayoutEffect(() => () => source.setManualTextEntryActive(false), [source, editing, activeTab]);

  // The test sheet on the screen, shrunk to a sixth: drawn once its raster is there (nothing to undo).
  useEffect(() => {
    if (a4Preview !== null && a4Canvas.current !== null) {
      paintMonoRaster(a4Canvas.current, a4Preview.raster, A4_PREVIEW_FACTOR);
    }
  }, [a4Preview]);

  useEffect(() => {
    let cancelled = false;
    void printing.supportsWindowsDriver().then((supported) => {
      if (!cancelled) setWindowsDriver(supported);
    });
    return () => {
      cancelled = true;
    };
  }, [printing]);

  // Only the newest ask is heard: an older answer that comes late is dropped.
  const usbAsk = useRef(0);
  const refreshUsb = () => {
    const ask = usbAsk.current + 1;
    usbAsk.current = ask;
    setUsbFailed(false);
    setUsbAsking(true);
    hardware.listUsbPrinters().then(
      (printers) => {
        if (usbAsk.current !== ask) return;
        setUsbAsking(false);
        setUsbPrinters(printers);
      },
      () => {
        if (usbAsk.current !== ask) return;
        setUsbAsking(false);
        setUsbPrinters([]);
        setUsbFailed(true);
      },
    );
  };

  // Only the newest ask is heard here too.
  const serialAsk = useRef(0);
  const refreshSerial = () => {
    const ask = serialAsk.current + 1;
    serialAsk.current = ask;
    setSerialFailed(false);
    setSerialAsking(true);
    hardware.listSerialPorts().then(
      (ports) => {
        if (serialAsk.current !== ask) return;
        setSerialAsking(false);
        setSerialPorts(ports);
      },
      () => {
        if (serialAsk.current !== ask) return;
        setSerialAsking(false);
        setSerialPorts([]);
        setSerialFailed(true);
      },
    );
  };

  // The scanner tab and the serial printer's form show the COM ports of this PC: ask for them once.
  const wantsPorts =
    draft !== null &&
    (scannersOnly ||
      activeTab === "scanner" ||
      activeTab === "check" ||
      (editor !== null && editor.kind === "serial"));
  useEffect(() => {
    if (wantsPorts && serialPorts === null && serialAsk.current === 0) refreshSerial();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- asked once, by the first need
  }, [wantsPorts]);

  const change = (next: WorkstationSettings) => {
    setDraft(next);
    setStatus(null);
  };

  if (readFailed || draft === null || stored === null) {
    return (
      <section className="workstation-setup" aria-labelledby="workstation-setup-title">
        <header className="workstation-setup__header">
          <h2 id="workstation-setup-title">
            {t(scannersOnly ? "floor.setup.scannerScope.title" : "floor.setup.title")}
          </h2>
        </header>
        <div className="workstation-setup__loading" aria-live="polite">
          {readFailed ? (
            <Alert tone="error" role="presentation">
              {t("floor.setup.readFailed")}
            </Alert>
          ) : (
            <p className="workstation-setup__result">{t("floor.setup.loading")}</p>
          )}
        </div>
        <footer className="workstation-setup__footer">
          <Button size="floor" variant="secondary" onClick={onBack}>
            {t("floor.setup.back")}
          </Button>
        </footer>
      </section>
    );
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(stored);
  // A saved scanner the shell does not list, though nothing was given it since: it never
  // got it (the app started before the setup was saved, or refused the set).
  const unopened =
    !applied &&
    snapshot !== null &&
    !watchFailed &&
    stored.scanners.some((saved) => !listed(snapshot, saved));
  const typedPort = scanner.port.trim() !== "";
  const canSave = dirty || unapplied || unopened || typedPort;

  const forgetTestOf = (printerId: string) => {
    if (a4Preview?.printerId === printerId) setA4Preview(null);
    if (testOwner.current !== printerId) return;
    testGeneration.current += 1;
    setTest(null);
  };

  const applyEditor = () => {
    if (editor === null) return;
    const result = profileOf(editor, () => crypto.randomUUID());
    if ("error" in result) {
      setEditorError(t(`floor.setup.printers.errors.${result.error}`));
      return;
    }
    const { profile } = result;
    const before = draft.printers.find((printer) => printer.id === profile.id);
    const clash = draft.printers.find(
      (printer) =>
        printer.id !== profile.id &&
        printerTargetKey(printer.target) === printerTargetKey(profile.target),
    );
    if (clash !== undefined) {
      setEditorError(t("floor.setup.printers.errors.duplicate", { name: clash.name }));
      return;
    }
    const scanned = sharedSerialPort([profile], draft.scanners);
    if (scanned !== null) {
      setEditorError(t("floor.setup.printers.errors.scannerPort", { port: scanned }));
      return;
    }
    const exists = before !== undefined;
    // An A4 printer prints pallets only: the box and the duplicate it was given are taken away.
    const assignments = { ...draft.assignments };
    for (const purpose of PRINT_PURPOSES) {
      if (assignments[purpose] === profile.id && !printsPurpose(profile, purpose)) {
        assignments[purpose] = null;
      }
    }
    if (exists && before.paper !== profile.paper) forgetTestOf(profile.id);
    change({
      ...draft,
      printers: exists
        ? draft.printers.map((printer) => (printer.id === profile.id ? profile : printer))
        : [...draft.printers, profile],
      assignments,
    });
    setEditor(null);
    setEditorError(null);
  };

  const remove = (id: string) => {
    forgetTestOf(id);
    const assignments = { ...draft.assignments };
    for (const purpose of PRINT_PURPOSES) {
      if (assignments[purpose] === id) assignments[purpose] = null;
    }
    change({ ...draft, printers: draft.printers.filter((p) => p.id !== id), assignments });
  };

  const assign = (purpose: PrintPurpose, id: string) => {
    change({ ...draft, assignments: { ...draft.assignments, [purpose]: id === "" ? null : id } });
  };

  const testPrint = async (printer: PrinterProfile) => {
    // One test label at a time: a press while one is on its way does nothing.
    if (testRef.current?.kind === "sending") return;
    const sheet = printer.paper === "a4";
    testOwner.current = printer.id;
    const generation = testGeneration.current;
    const stale = () => generation !== testGeneration.current;
    setTest({ kind: "sending", printerId: printer.id });
    let bytes: Uint8Array;
    let code: string;
    if (sheet) {
      // The A4 test (plan А4): a sheet of the stock layout with a made-up SSCC, shown on the
      // screen as it is sent, and checked by a scan of that SSCC.
      code = makeA4TestSscc();
      try {
        const made = await a4Sheet("portrait", code, {
          title: t("floor.setup.printers.a4Test.title"),
          product: t("floor.setup.printers.a4Test.product"),
        });
        if (stale()) return;
        bytes = made.bytes;
        setA4Preview({ printerId: printer.id, raster: made.raster });
      } catch {
        if (!stale()) setTest({ kind: "render_failed", sheet });
        return;
      }
    } else {
      code = makeTestCode();
      try {
        bytes = await render(testLabelSpec(code, printer.language), sampleLabelData(), printer);
      } catch {
        if (!stale()) setTest({ kind: "render_failed", sheet });
        return;
      }
    }
    const settled = settleOutcome(
      sheet
        ? await printing.send(null, printer.target, bytes, printerMode(printer), "a4")
        : await printing.send(null, printer.target, bytes, printerMode(printer)),
    );
    if (stale()) return;
    // What was typed ahead (a letter on a list) would join the code of the label.
    source.clearPendingInput();
    setTest(
      settled.state === "sent"
        ? { kind: "sent", printerId: printer.id, name: printer.name, code, sheet }
        : { kind: "failed", code: settled.code, unknown: settled.state === "unknown", sheet },
    );
  };

  const save = async () => {
    if (savingNow.current || editor !== null) return;
    // A port typed and never added would be lost in silence: say so instead.
    if (typedPort) {
      setStatus({ kind: "scanner_unadded" });
      return;
    }
    if (!canSave) return;
    savingNow.current = true;
    setSaving(true);
    setStatus(null);
    try {
      if (dirty) {
        try {
          await saveWorkstationSettings(local, draft);
        } catch (error) {
          setStatus(
            error instanceof InvalidSettingsError ? { kind: "invalid" } : { kind: "save_failed" },
          );
          return;
        }
        setStored(draft);
        onSaved(draft);
      }
      try {
        // The whole set at once: the shell checks it before it changes anything,
        // and a removed scanner's port is closed too.
        await hardware.configureScanners(draft.scanners);
        setUnapplied(false);
        setApplied(true);
        setStatus({ kind: "saved" });
      } catch {
        setUnapplied(true);
        setApplied(false);
        setStatus({ kind: "scanners_failed" });
      }
    } finally {
      savingNow.current = false;
      setSaving(false);
    }
  };

  const summary = (printer: PrinterProfile) => {
    const { target } = printer;
    const where =
      target.kind === "tcp"
        ? t("floor.setup.printers.summary.tcp", { host: target.host, port: target.port })
        : target.kind === "serial"
          ? t("floor.setup.printers.summary.serial", { port: target.port, baud: target.baud })
          : t("floor.setup.printers.summary.usb", { printer: target.printer });
    // A printer of A4 sheets is told by its paper, not by a language and a resolution (plan А4).
    if (printer.paper === "a4" && target.kind === "usb") {
      return t("floor.setup.printers.summary.a4", { printer: target.printer });
    }
    return `${where} · ${t("floor.setup.printers.format", {
      language: printerFormatText(t, printer),
      dpi: printer.dpi,
    })}`;
  };

  const testText = (state: TestState): { tone: "ok" | "error" | "info" | "warn"; text: string } => {
    switch (state.kind) {
      case "sending":
        return { tone: "info", text: t("floor.setup.printers.testResult.sending") };
      case "sent":
        return {
          tone: "info",
          text: state.sheet
            ? `${t("floor.setup.printers.testResult.sentSheet", { name: state.name })} ${t(
                "floor.setup.printers.a4Test.scan",
              )}`
            : t("floor.setup.printers.testResult.sent", { name: state.name }),
        };
      case "failed":
        return {
          tone: "error",
          text: `${t(
            `floor.setup.printers.testResult.${state.unknown ? "unknown" : "failed"}${
              state.sheet ? "Sheet" : ""
            }`,
          )} ${t(`floor.print.codes.${state.code}`)}`,
        };
      case "render_failed":
        return {
          tone: "error",
          text: t(`floor.setup.printers.testResult.renderFailed${state.sheet ? "Sheet" : ""}`),
        };
      case "match":
        return { tone: "ok", text: t("floor.setup.printers.testResult.match") };
      case "mismatch":
        return {
          tone: "warn",
          text: t(`floor.setup.printers.testResult.mismatch${state.sheet ? "Sheet" : ""}`),
        };
    }
  };

  const editorForm = (form: PrinterDraft) => {
    const set = (patch: Partial<PrinterDraft>) => {
      setEditor(settleDraft(form, patch));
      setEditorError(null);
    };
    const usbOptions = [
      { value: "", label: t("floor.setup.printers.editor.usbChoose") },
      ...(form.usbPrinter !== "" && !(usbPrinters ?? []).some((p) => p.name === form.usbPrinter)
        ? [{ value: form.usbPrinter, label: form.usbPrinter }]
        : []),
      ...(usbPrinters ?? []).map((printer) => ({ value: printer.name, label: printer.name })),
    ];
    const driver = form.kind === "usb" && form.mode === "windows_driver";
    return (
      <div className="setup-split setup-split--editor">
        <section
          className="setup-card setup-card--printer-config"
          aria-labelledby="printer-editor-title"
        >
          <h2
            id="printer-editor-title"
            className="setup-card__title"
            ref={sectionHeading}
            tabIndex={-1}
          >
            {form.id === null
              ? t("floor.setup.printers.editor.titleNew")
              : t("floor.setup.printers.editor.titleEdit", { name: form.name })}
          </h2>
          <div className="setup-printer-identity">
            <Input
              {...manualEntry}
              size="floor"
              label={t("floor.setup.printers.editor.name")}
              value={form.name}
              onChange={(event) => set({ name: event.target.value })}
            />
            <Select
              custom
              size="floor"
              label={t("floor.setup.printers.editor.dpi")}
              value={form.dpi}
              disabled={form.paper === "a4"}
              options={[
                { value: "203", label: "203 dpi" },
                { value: "300", label: "300 dpi" },
              ]}
              onValueChange={(dpi) => set({ dpi })}
            />
          </div>
          <Select
            custom
            size="floor"
            label={t("floor.setup.printers.editor.kind")}
            value={form.kind}
            options={(["tcp", "serial", "usb"] as const).map((kind) => ({
              value: kind,
              label: t(`floor.setup.printers.editor.kinds.${kind}`),
            }))}
            onValueChange={(kind) => {
              set({ kind });
              if (kind === "usb" && usbPrinters === null) refreshUsb();
            }}
          />
          <div className="setup-printer-connection">
            {form.kind === "tcp" && (
              <>
                <Input
                  {...manualEntry}
                  size="floor"
                  label={t("floor.setup.printers.editor.host")}
                  value={form.host}
                  onChange={(event) => set({ host: event.target.value })}
                />
                <Input
                  {...manualEntry}
                  size="floor"
                  mono
                  inputMode="numeric"
                  label={t("floor.setup.printers.editor.port")}
                  value={form.tcpPort}
                  onChange={(event) => set({ tcpPort: event.target.value })}
                />
              </>
            )}
            {form.kind === "serial" && (
              <>
                <ComPortField
                  label={t("floor.setup.printers.editor.serialPort")}
                  value={form.serialPort}
                  ports={serialPorts}
                  manualEntry={manualEntry}
                  onChange={(serialPort) => set({ serialPort })}
                />
                <Button
                  size="floor"
                  variant="secondary"
                  className="setup-printer-connection__wide setup-nowrap"
                  onClick={refreshSerial}
                >
                  {t("floor.setup.scanners.listPorts")}
                </Button>
                <Input
                  {...manualEntry}
                  size="floor"
                  mono
                  inputMode="numeric"
                  label={t("floor.setup.printers.editor.baud")}
                  value={form.baud}
                  onChange={(event) => set({ baud: event.target.value })}
                />
              </>
            )}
            {form.kind === "usb" && (
              <>
                <Select
                  custom
                  size="floor"
                  label={t("floor.setup.printers.editor.usbPrinter")}
                  searchable
                  searchLabel={t("floor.setup.printers.editor.usbSearch")}
                  searchPlaceholder={t("floor.setup.printers.editor.usbSearchPlaceholder")}
                  searchEmptyLabel={t("floor.setup.printers.editor.usbSearchEmpty")}
                  value={form.usbPrinter}
                  options={usbOptions}
                  {...(usbFailed ? { error: t("floor.setup.printers.editor.usbFailed") } : {})}
                  {...(usbAsking
                    ? { hint: t("floor.setup.printers.editor.usbAsking") }
                    : usbPrinters !== null && usbPrinters.length === 0 && !usbFailed
                      ? { hint: t("floor.setup.printers.editor.usbNone") }
                      : {})}
                  className="setup-printer-connection__wide"
                  onValueChange={(usbPrinter) => set({ usbPrinter })}
                />
                <Button
                  size="floor"
                  variant="secondary"
                  className="setup-printer-connection__wide setup-nowrap"
                  onClick={refreshUsb}
                >
                  {t("floor.setup.printers.editor.usbRefresh")}
                </Button>
              </>
            )}
          </div>
        </section>
        <section
          className="setup-card setup-card--printer-output"
          aria-labelledby="printer-output-title"
        >
          <h2 id="printer-output-title" className="setup-card__title">
            {t("floor.setup.printers.editor.output")}
          </h2>
          {form.kind === "usb" && (windowsDriver || form.mode === "windows_driver") && (
            <Select
              custom
              size="floor"
              label={t("floor.setup.printers.editor.mode")}
              value={form.mode}
              options={(["raw", "windows_driver"] as const).map((mode) => ({
                value: mode,
                label: t(`floor.setup.printers.editor.modes.${mode}`),
              }))}
              onValueChange={(mode) => set({ mode })}
            />
          )}
          {driver && (
            <Select
              custom
              size="floor"
              label={t("floor.setup.printers.editor.paper")}
              value={form.paper}
              options={(["label", "a4"] as const).map((paper) => ({
                value: paper,
                label: t(
                  paper === "a4"
                    ? "floor.setup.printers.editor.paperA4"
                    : "floor.setup.printers.editor.paperLabel",
                ),
              }))}
              hint={t("floor.setup.printers.editor.paperHint")}
              onValueChange={(paper) => set({ paper })}
            />
          )}
          {driver ? (
            <p className="setup-card__hint">{t("floor.setup.printers.editor.driverHint")}</p>
          ) : (
            <Select
              custom
              size="floor"
              label={t("floor.setup.printers.editor.language")}
              value={form.language}
              options={[
                { value: "zpl", label: "ZPL (Zebra)" },
                { value: "tspl", label: "TSPL (TSC)" },
              ]}
              onValueChange={(language) => set({ language })}
            />
          )}
          {editorError !== null && <Alert tone="error">{editorError}</Alert>}
          <div className="setup-card__actions">
            <Button
              size="floor"
              variant="secondary"
              onClick={() => {
                setEditor(null);
                setEditorError(null);
              }}
            >
              {t("floor.setup.printers.editor.cancel")}
            </Button>
            <Button size="floor" onClick={applyEditor}>
              {t("floor.setup.printers.editor.apply")}
            </Button>
          </div>
        </section>
      </div>
    );
  };

  const addScanner = () => {
    const port = canonicalPort(scanner.port);
    const baud = /^[0-9]+$/.test(scanner.baud.trim()) ? Number(scanner.baud.trim()) : 0;
    const taken = draft.printers.find(
      (printer) => printer.target.kind === "serial" && canonicalPort(printer.target.port) === port,
    );
    if (port === "") {
      setScannerError(t("floor.setup.scanners.errors.port"));
    } else if (!isPortName(port)) {
      setScannerError(t("floor.setup.scanners.errors.portName"));
    } else if (baud < 1 || baud > 4_294_967_295) {
      setScannerError(t("floor.setup.scanners.errors.baud"));
    } else if (draft.scanners.some((existing) => existing.port === port)) {
      setScannerError(t("floor.setup.scanners.errors.duplicate", { port }));
    } else if (taken !== undefined) {
      setScannerError(t("floor.setup.scanners.errors.printerPort", { port, name: taken.name }));
    } else if (draft.scanners.length >= MAX_SCANNERS) {
      setScannerError(t("floor.setup.scanners.errors.tooMany", { max: MAX_SCANNERS }));
    } else {
      change({ ...draft, scanners: [...draft.scanners, { port, baud }] });
      setScanner({ port: "", baud: "9600" });
      setScannerError(null);
    }
  };

  /** A scanner's connection as the shell reports it: its words, and the phase of its tag. */
  const connection = (configured: ScannerConfig): { text: string; phase: TagPhase } => {
    const saved = stored.scanners.some(
      (candidate) => candidate.port === configured.port && candidate.baud === configured.baud,
    );
    if (!saved) return { text: t("floor.setup.scanners.notApplied"), phase: "planned" };
    if (watchFailed) return { text: t("floor.setup.scanners.watchFailed"), phase: "attention" };
    if (snapshot === null) return { text: t("floor.setup.scanners.checking"), phase: "running" };
    const known = snapshot.scanners.find(
      (candidate) => candidate.port === configured.port && candidate.baud === configured.baud,
    );
    if (known === undefined) {
      return {
        text: t(
          unapplied || unopened
            ? "floor.setup.scanners.notOpenedRetry"
            : "floor.setup.scanners.notOpened",
        ),
        phase: "attention",
      };
    }
    return known.status === "connected"
      ? { text: t("floor.setup.scanners.connected"), phase: "active" }
      : { text: t("floor.setup.scanners.disconnected"), phase: "failed" };
  };

  const silent = soundLevel(draft.sound) === 0;
  const setVolume = (volume: number) => {
    change({ ...draft, sound: { ...draft.sound, volume: Math.min(100, Math.max(0, volume)) } });
  };

  // An A4 printer is offered for the pallet only (plan А4); the box and the duplicate are label purposes.
  const purposeOptions = (purpose: PrintPurpose) => [
    { value: "", label: t("floor.setup.printers.purposes.none") },
    ...draft.printers
      .filter((printer) => printsPurpose(printer, purpose))
      .map((printer) => ({ value: printer.id, label: printer.name })),
  ];

  const printersPanel =
    editor !== null ? (
      editorForm(editor)
    ) : (
      <div className="setup-printer-routing">
        <section className="setup-printer-list" aria-labelledby="setup-printers-title">
          <div className="setup-printer-list__header">
            <div className="setup-printer-list__heading">
              <h2
                id="setup-printers-title"
                className="setup-card__title"
                ref={sectionHeading}
                tabIndex={-1}
              >
                {t("floor.setup.printers.title")}
              </h2>
              <span className="setup-printer-list__count" aria-hidden="true">
                {draft.printers.length}
              </span>
            </div>
            <Button
              size="floor"
              variant="secondary"
              onClick={() =>
                setEditor(
                  newPrinterDraft(
                    draft.printers.map((printer) => printer.name),
                    t("floor.setup.printers.defaultNamePrefix"),
                  ),
                )
              }
            >
              {t("floor.setup.printers.add")}
            </Button>
          </div>
          <div className="setup-printer-list__scroll">
            {draft.printers.length === 0 ? (
              <p className="setup-printer-list__empty">{t("floor.setup.printers.empty")}</p>
            ) : (
              <ul className="setup-printer-list__rows">
                {draft.printers.map((printer) => {
                  const purposes = PRINT_PURPOSES.filter(
                    (purpose) => draft.assignments[purpose] === printer.id,
                  );
                  return (
                    <li className="setup-printer-row" key={printer.id}>
                      <div className="setup-printer-row__detail">
                        <h3>{printer.name}</h3>
                        <p className="setup-printer-row__connection">{summary(printer)}</p>
                        <p className="setup-printer-row__purposes">
                          {purposes.length === 0
                            ? t("floor.setup.printers.purposes.none")
                            : purposes
                                .map((purpose) => t(`floor.setup.printers.purposes.${purpose}`))
                                .join(" · ")}
                        </p>
                        {test !== null && testOwner.current === printer.id && (
                          <StatusChip
                            size="floor"
                            wrap
                            phase={TEST_CHIP[test.kind].phase}
                            label={t(`floor.setup.printers.testChip.${test.kind}`)}
                          />
                        )}
                      </div>
                      <div className="setup-printer-row__actions">
                        <Button
                          size="floor"
                          variant="secondary"
                          aria-label={t("floor.setup.printers.editFor", { name: printer.name })}
                          onClick={() => setEditor(draftOf(printer))}
                        >
                          {t("floor.setup.printers.edit")}
                        </Button>
                        <Button
                          size="floor"
                          variant="secondary"
                          aria-label={t("floor.setup.printers.testFor", { name: printer.name })}
                          {...(test?.kind === "sending"
                            ? { "aria-disabled": true, style: WAITING_STYLE }
                            : {})}
                          onClick={() => void testPrint(printer)}
                        >
                          {t("floor.setup.printers.test")}
                        </Button>
                        <Button
                          size="floor"
                          variant="secondary"
                          aria-label={t("floor.setup.printers.removeFor", { name: printer.name })}
                          onClick={() => remove(printer.id)}
                        >
                          {t("floor.setup.printers.remove")}
                        </Button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            {a4Preview !== null && (
              <div className="setup-a4-preview">
                <canvas
                  ref={a4Canvas}
                  role="img"
                  aria-label={t("floor.setup.printers.a4Test.preview")}
                  className="sheet-preview"
                />
              </div>
            )}
          </div>
        </section>
        <section
          className="setup-card setup-printer-assignments"
          aria-labelledby="setup-purposes-title"
        >
          <h2 id="setup-purposes-title" className="setup-card__title">
            {t("floor.setup.printers.purposes.title")}
          </h2>
          {PRINT_PURPOSES.map((purpose) => (
            <Select
              key={purpose}
              custom
              size="floor"
              label={t(`floor.setup.printers.purposes.${purpose}`)}
              value={draft.assignments[purpose] ?? ""}
              options={purposeOptions(purpose)}
              onValueChange={(id) => assign(purpose, id)}
            />
          ))}
          <p className="setup-card__hint">{t("floor.setup.check.body")}</p>
        </section>
      </div>
    );

  const scanCheckTone = (check: ScanCheck) =>
    check.kind === "unreadable" ? "warn" : check.kind === "pairing" ? "ok" : "info";
  const scanCheckText = (check: ScanCheck): string => {
    if (check.kind === "unreadable") return t("floor.setup.scannerScope.unreadable");
    const parts =
      check.kind === "pairing"
        ? [
            check.addresses.length === 0
              ? t("floor.setup.scannerScope.pairingNoAddress")
              : t("floor.setup.scannerScope.pairing", { addresses: check.addresses.join(", ") }),
          ]
        : [
            t("floor.setup.scannerScope.other", { length: check.length }),
            ...(check.groupSeparator ? [t("floor.setup.scannerScope.groupSeparator")] : []),
          ];
    if (check.russianLayout) parts.push(t("floor.setup.scannerScope.russianLayout"));
    return parts.join(" ");
  };

  // The self-test's code on a label: the printer is the operator's choice among the label printers.
  const selfTestPrint = async (
    printerId: string,
    kind: SelfTestKind,
    code: string,
  ): Promise<SelfTestPrintResult> => {
    const printer = draft.printers.find((candidate) => candidate.id === printerId);
    if (printer === undefined) return "failed";
    let bytes: Uint8Array;
    try {
      bytes =
        kind === "dm"
          ? await render(
              selfTestDataMatrixSpec(printer.language),
              { ...sampleLabelData(), "km.code": code },
              printer,
            )
          : await render(testLabelSpec(code, printer.language), sampleLabelData(), printer);
    } catch {
      return "render_failed";
    }
    const settled = settleOutcome(
      await printing.send(null, printer.target, bytes, printerMode(printer)),
    );
    // What was typed ahead would join the next scan.
    source.clearPendingInput();
    return settled.state === "sent" ? "sent" : "failed";
  };

  const selfTestPanel = (
    <ScannerSelfTest
      state={selfTest}
      printers={draft.printers
        .filter((printer) => printer.paper !== "a4")
        .map((printer) => ({ id: printer.id, name: printer.name }))}
      print={selfTestPrint}
    />
  );

  const scannerPanel = (
    <div className="setup-scanner-stack">
      <div
        className={`setup-split setup-split--scanners${scannersOnly ? " setup-split--scanners-check" : ""}`}
      >
        <section
          className="setup-card setup-card--scanner-config"
          aria-labelledby="setup-scanner-add"
        >
          <h2 id="setup-scanner-add" className="setup-card__title">
            {t("floor.setup.scanners.connection")}
          </h2>
          <ComPortField
            label={t("floor.setup.scanners.port")}
            value={scanner.port}
            ports={serialPorts}
            manualEntry={manualEntry}
            onChange={(port) => {
              setScanner({ ...scanner, port });
              setScannerError(null);
              setStatus((now) => (now?.kind === "scanner_unadded" ? null : now));
            }}
          />
          <Input
            {...manualEntry}
            size="floor"
            mono
            inputMode="numeric"
            label={t("floor.setup.scanners.baud")}
            value={scanner.baud}
            onChange={(event) => {
              setScanner({ ...scanner, baud: event.target.value });
              setScannerError(null);
            }}
          />
          <div className="workstation-setup__live" aria-live="polite">
            {scannerError !== null && (
              <Alert tone="error" role="presentation">
                {scannerError}
              </Alert>
            )}
          </div>
          <div className="setup-card__actions setup-card__actions--fill">
            <Button size="floor" variant="secondary" onClick={refreshSerial}>
              {t("floor.setup.scanners.listPorts")}
            </Button>
            <Button size="floor" onClick={addScanner}>
              {t("floor.setup.scanners.add")}
            </Button>
          </div>
          <div className="workstation-setup__live" aria-live="polite">
            {serialAsking ? (
              <p className="setup-card__hint">{t("floor.setup.scanners.portsAsking")}</p>
            ) : (
              serialPorts !== null && (
                <p className="setup-card__hint">
                  {serialFailed
                    ? t("floor.setup.scanners.portsFailed")
                    : serialPorts.length === 0
                      ? t("floor.setup.scanners.portsNone")
                      : t("floor.setup.scanners.ports", { ports: serialPorts.join(", ") })}
                </p>
              )
            )}
          </div>
        </section>
        <section className="setup-card setup-card--scanners" aria-labelledby="setup-scanners-title">
          <h2
            id="setup-scanners-title"
            className="setup-card__title"
            ref={scannersHeading}
            tabIndex={-1}
          >
            {t("floor.setup.scanners.title")}
          </h2>
          {draft.scanners.length === 0 ? (
            <p className="setup-card__waiting">{t("floor.setup.scanners.empty")}</p>
          ) : (
            <ul className="setup-scanner-list">
              {draft.scanners.map((configured) => {
                const state = connection(configured);
                return (
                  <li className="setup-scanner-row" key={configured.port}>
                    <div className="setup-scanner-row__detail">
                      <strong>
                        {t("floor.setup.scanners.summary", {
                          port: configured.port,
                          baud: configured.baud,
                        })}
                      </strong>
                      <span aria-live="polite">
                        <StatusChip size="floor" wrap phase={state.phase} label={state.text} />
                      </span>
                    </div>
                    <Button
                      size="floor"
                      variant="secondary"
                      aria-label={t("floor.setup.scanners.removeFor", { port: configured.port })}
                      onClick={() => {
                        change({
                          ...draft,
                          scanners: draft.scanners.filter((s) => s.port !== configured.port),
                        });
                        // The button that was here is gone: the keyboard stays in the section.
                        scannersHeading.current?.focus();
                      }}
                    >
                      {t("floor.setup.scanners.remove")}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="setup-card__hint">{t("floor.setup.scanners.keyboard")}</p>
        </section>
        {scannersOnly && (
          <section
            className="setup-card setup-card--check"
            aria-labelledby="setup-scan-check"
            data-testid="scanner-check"
          >
            <h2 id="setup-scan-check" className="setup-card__title">
              {t("floor.setup.scannerScope.checkTitle")}
            </h2>
            <p className="setup-card__hint">{t("floor.setup.scannerScope.checkBody")}</p>
            <div className="workstation-setup__live" aria-live="polite">
              {scanCheck !== null && (
                <Alert tone={scanCheckTone(scanCheck)} role="presentation">
                  {scanCheckText(scanCheck)}
                </Alert>
              )}
            </div>
          </section>
        )}
      </div>
      {/* Before the pairing there are no tabs: the check stands under the connection. */}
      {scannersOnly && selfTestPanel}
      {!scannersOnly && (
        <section className="setup-card setup-card--check-cta" aria-labelledby="setup-check-cta">
          <h2 id="setup-check-cta" className="setup-card__title">
            {t("floor.setup.selfTestCta.title")}
          </h2>
          <p className="setup-card__hint">{t("floor.setup.selfTestCta.body")}</p>
          <Button size="floor" onClick={() => setActiveTab("check")}>
            {t("floor.setup.selfTestCta.open")}
          </Button>
        </section>
      )}
    </div>
  );

  const checkPanel = <div className="setup-panel setup-panel--check">{selfTestPanel}</div>;

  const soundPanel = (
    <div className="setup-panel setup-panel--sound setup-card">
      <div className="setup-sound__controls">
        <Button
          size="floor"
          variant="secondary"
          className="setup-toggle"
          style={TOGGLE_STYLE}
          aria-pressed={draft.sound.muted}
          onClick={() => change({ ...draft, sound: { ...draft.sound, muted: !draft.sound.muted } })}
        >
          <span className="setup-toggle__box" aria-hidden="true">
            {draft.sound.muted ? "✓" : ""}
          </span>
          {t("floor.setup.sound.mute")}
        </Button>
        <div className="setup-sound__level">
          {/* At a limit a button stays on the keyboard and does nothing: one that vanished would take the focus. */}
          <Button
            size="floor"
            variant="secondary"
            {...(draft.sound.muted || draft.sound.volume <= 0
              ? { "aria-disabled": true, style: WAITING_STYLE }
              : {})}
            onClick={() => {
              if (!draft.sound.muted && draft.sound.volume > 0) {
                setVolume(draft.sound.volume - VOLUME_STEP);
              }
            }}
          >
            {t("floor.setup.sound.quieter")}
          </Button>
          <p className="setup-sound__value" aria-live="polite">
            {silent
              ? t("floor.setup.sound.mutedNow")
              : t("floor.setup.sound.level", { volume: draft.sound.volume })}
          </p>
          <Button
            size="floor"
            variant="secondary"
            {...(draft.sound.muted || draft.sound.volume >= 100
              ? { "aria-disabled": true, style: WAITING_STYLE }
              : {})}
            onClick={() => {
              if (!draft.sound.muted && draft.sound.volume < 100) {
                setVolume(draft.sound.volume + VOLUME_STEP);
              }
            }}
          >
            {t("floor.setup.sound.louder")}
          </Button>
        </div>
        <Button size="floor" variant="secondary" onClick={() => playTone(soundLevel(draft.sound))}>
          {t("floor.setup.sound.try")}
        </Button>
      </div>
    </div>
  );

  const tabs = [
    { id: "scanner" as const, label: t("floor.setup.tabs.scanner"), panel: scannerPanel },
    { id: "check" as const, label: t("floor.setup.tabs.check"), panel: checkPanel },
    { id: "printer" as const, label: t("floor.setup.tabs.printer"), panel: printersPanel },
    { id: "sound" as const, label: t("floor.setup.tabs.sound"), panel: soundPanel },
  ];
  // Before its pairing a station sets its scanners only: no tabs, the scanner panel alone.
  const shownTab: SetupTabId = scannersOnly ? "scanner" : activeTab;
  const routing = shownTab === "printer" && editor === null;
  const showTest = routing && test !== null;
  const hint =
    shownTab === "printer"
      ? editor !== null
        ? t("floor.setup.hint.editor")
        : t("floor.setup.check.later")
      : shownTab === "scanner"
        ? t("floor.setup.hint.scanner")
        : shownTab === "check"
          ? t("floor.setup.hint.check")
          : t("floor.setup.hint.sound");

  return (
    <section className="workstation-setup" aria-labelledby="workstation-setup-title">
      <header className="workstation-setup__header">
        <h2 id="workstation-setup-title">
          {t(scannersOnly ? "floor.setup.scannerScope.title" : "floor.setup.title")}
        </h2>
      </header>

      {scannersOnly ? (
        <div className="workstation-setup__single">{scannerPanel}</div>
      ) : (
        <SetupTabs
          tabs={tabs}
          label={t("floor.setup.tabs.label")}
          activeTab={activeTab}
          locked={editor !== null}
          onTabChange={setActiveTab}
        />
      )}

      <div
        className={`workstation-setup__feedback${routing ? " workstation-setup__feedback--printers" : ""}`}
      >
        {routing && (
          <div className="setup-printer-verification">
            <Button
              size="floor"
              variant="secondary"
              className="setup-toggle"
              style={ROW_TOGGLE_STYLE}
              aria-pressed={draft.verifyPrintedLabel}
              onClick={() => change({ ...draft, verifyPrintedLabel: !draft.verifyPrintedLabel })}
            >
              <span className="setup-toggle__box" aria-hidden="true">
                {draft.verifyPrintedLabel ? "✓" : ""}
              </span>
              {t("floor.setup.check.toggle")}
            </Button>
            <p className="setup-printer-verification__state" aria-live="polite">
              {t(draft.verifyPrintedLabel ? "floor.setup.check.on" : "floor.setup.check.off")}
            </p>
          </div>
        )}
        <div className="workstation-setup__result">
          {/* Regions that are always there, so a reader hears what comes into them; their alerts are no alerts of their own. */}
          <div className="workstation-setup__live" aria-live="polite">
            {showTest && (
              <Alert tone={testText(test).tone} role="presentation">
                {testText(test).text}
              </Alert>
            )}
          </div>
          <div className="workstation-setup__live" aria-live="polite">
            {status !== null && (
              <Alert tone={status.kind === "saved" ? "ok" : "error"} role="presentation">
                {t(`floor.setup.status.${status.kind}`)}
              </Alert>
            )}
          </div>
          {!showTest && status === null && <p className="workstation-setup__hint">{hint}</p>}
        </div>
      </div>

      <footer className="workstation-setup__footer">
        {/* Never held by a save or a test print: leaving is always open. */}
        <Button size="floor" variant="secondary" onClick={onBack}>
          {t(dirty ? "floor.setup.backUnsaved" : "floor.setup.back")}
        </Button>
        <span className="workstation-setup__footer-spacer" />
        {/* Beta 3: the station's unpairing; renders only where the app provides it. */}
        {!scannersOnly && <UnpairStation />}
        {/* Kept on the keyboard while it saves or has nothing to save: a button that vanishes from the tab order takes the focus with it. */}
        <Button
          size="floor"
          disabled={editor !== null}
          {...(!canSave || saving ? { "aria-disabled": true, style: WAITING_STYLE } : {})}
          onClick={() => void save()}
        >
          {t("floor.setup.save")}
        </Button>
      </footer>
    </section>
  );
}
