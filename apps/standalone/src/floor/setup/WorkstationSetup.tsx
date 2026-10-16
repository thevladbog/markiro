import { parseScannedSscc, sampleLabelData, type MonoRaster } from "@markiro/domain";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type CSSProperties,
  type ReactNode,
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
import type { SheetAdjusted } from "../../hardware/hardware.js";
import { paintMonoRaster } from "../../labels/sheet-render.js";
import type { LocalExecutor } from "../../local/executor.js";
import { IpKeypad } from "../kit/IpKeypad.js";
import { checkAddress, checkBaud, checkPort, pasteInto, type IpTarget } from "../kit/ip-entry.js";
import { ModeSegment } from "../kit/ModeSegment.js";
import { SwitchCard } from "../kit/SwitchCard.js";
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
import { DiagnosticCopy } from "./DiagnosticCopy.js";
import { SetupTabList, SetupTabPanel, type SetupTabId } from "./SetupTabs.js";
import { KeyboardIcon, TrashIcon } from "./setup-icons.js";
import { StationPanel, VolumeScale, type StationFacts } from "./setup-parts.js";
import { unsavedParts, volumeDivisions } from "./setup-status.js";
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
  /**
   * What «Станция» tells of this station: its name, device and host. The floor passes the
   * pairing; without it (the scanner settings before a pairing) the tab is not offered.
   */
  facts?: StationFacts | null;
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
  | {
      kind: "sent";
      printerId: string;
      name: string;
      code: string;
      sheet: boolean;
      /** A sheet the driver path moved or drew smaller to fit the printer (beta 3.2). */
      adjusted?: SheetAdjusted;
    }
  | {
      kind: "failed";
      code: PrintJobCode;
      unknown: boolean;
      sheet: boolean;
      /** The driver's measured numbers of a refused sheet (beta 3.2). */
      diagnostic?: string;
    }
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
  facts = null,
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
  // The on-screen keypad of the printer form and the scanner's baud rate: the field it types into.
  const [keypad, setKeypad] = useState<IpTarget | null>(null);
  const keypadRef = useRef<IpTarget | null>(null);
  keypadRef.current = keypad;
  // The printer form was applied once and refused: its fields now name what is wrong.
  const [submitted, setSubmitted] = useState(false);

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
      if (scannersOnly || activeTabRef.current === "scanner") selfTestScan(raw, channel);
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
    // With the keypad open the field is still the one being typed into: a scanner must not take it.
    onBlur: () => {
      if (keypadRef.current === null) source.setManualTextEntryActive(false);
    },
  };
  // Another tab takes its fields away with the focus on one, too.
  useLayoutEffect(() => () => source.setManualTextEntryActive(false), [source, editing, activeTab]);
  // The keypad is closed with its form or its tab, and while it is open the scanner stays out of the entry.
  useEffect(() => {
    setKeypad(null);
  }, [editing, activeTab]);
  const keypadOpen = keypad !== null;
  useEffect(() => {
    if (!keypadOpen) return;
    source.setManualTextEntryActive(true);
    return () => {
      // Closed by its own button the focus stays in the field, which then still owns the entry.
      if (!(document.activeElement instanceof HTMLInputElement)) {
        source.setManualTextEntryActive(false);
      }
    };
  }, [keypadOpen, source]);

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
    (scannersOnly || activeTab === "scanner" || (editor !== null && editor.kind === "serial"));
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
      setSubmitted(true);
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
      setSubmitted(true);
      return;
    }
    const scanned = sharedSerialPort([profile], draft.scanners);
    if (scanned !== null) {
      setEditorError(t("floor.setup.printers.errors.scannerPort", { port: scanned }));
      setSubmitted(true);
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
    setSubmitted(false);
    setKeypad(null);
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
    const outcome = sheet
      ? await printing.send(null, printer.target, bytes, printerMode(printer), "a4")
      : await printing.send(null, printer.target, bytes, printerMode(printer));
    const settled = settleOutcome(outcome);
    if (stale()) return;
    // What was typed ahead (a letter on a list) would join the code of the label.
    source.clearPendingInput();
    const answer = outcome.kind === "answered" ? outcome.result : null;
    const adjusted = answer?.sent === true ? answer.adjusted : undefined;
    const diagnostic = answer !== null && !answer.sent ? answer.diagnostic : undefined;
    setTest(
      settled.state === "sent"
        ? {
            kind: "sent",
            printerId: printer.id,
            name: printer.name,
            code,
            sheet,
            ...(adjusted === undefined ? {} : { adjusted }),
          }
        : {
            kind: "failed",
            code: settled.code,
            unknown: settled.state === "unknown",
            sheet,
            ...(diagnostic === undefined ? {} : { diagnostic }),
          },
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

  /** What the driver path did to a sheet to fit the printer, in words (moved, drawn smaller). */
  const adjustedWords = (adjusted: SheetAdjusted | undefined): string[] => {
    if (adjusted === undefined) return [];
    const words: string[] = [];
    if (adjusted.percent < 100) {
      words.push(t("floor.setup.printers.a4Test.adjustedShrunk", { percent: adjusted.percent }));
    }
    const moved = Math.max(Math.abs(adjusted.shiftXMm), Math.abs(adjusted.shiftYMm));
    if (moved > 0) {
      words.push(
        t("floor.setup.printers.a4Test.adjustedMoved", {
          mm: moved.toLocaleString("ru-RU", { maximumFractionDigits: 1 }),
        }),
      );
    }
    return words;
  };

  const testText = (state: TestState): { tone: "ok" | "error" | "info" | "warn"; text: string } => {
    switch (state.kind) {
      case "sending":
        return { tone: "info", text: t("floor.setup.printers.testResult.sending") };
      case "sent":
        return {
          tone: "info",
          text: state.sheet
            ? [
                t("floor.setup.printers.testResult.sentSheet", { name: state.name }),
                ...adjustedWords(state.adjusted),
                t("floor.setup.printers.a4Test.scan"),
              ].join(" ")
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

  /** What the form's fields say is wrong, live: an octet above 255, a port out of range. */
  const liveErrors = (form: PrinterDraft) => {
    const address = form.kind === "tcp" ? checkAddress(form.host) : { state: "empty" as const };
    const port = form.kind === "tcp" ? checkPort(form.tcpPort) : { state: "empty" as const };
    const baud = form.kind === "serial" ? checkBaud(form.baud) : { state: "empty" as const };
    return {
      address,
      port,
      baud,
      hostError:
        address.state === "octet"
          ? t("floor.setup.printers.errors.octet", { octet: address.octet })
          : address.state === "format"
            ? t("floor.setup.printers.editor.hostFormat")
            : null,
      portError: port.state === "range" ? t("floor.setup.printers.errors.portRange") : null,
      baudError: baud.state === "range" ? t("floor.setup.printers.errors.baudRange") : null,
    };
  };

  /** The words of the footer's alert for a form that cannot be applied as typed. */
  const liveFooterError = (form: PrinterDraft): string | null => {
    const live = liveErrors(form);
    if (live.address.state === "octet") {
      return t("floor.setup.printers.errors.addressOctet", { octet: live.address.octet });
    }
    if (live.address.state === "format") return t("floor.setup.printers.errors.address");
    if (live.portError !== null) return t("floor.setup.printers.errors.port");
    if (live.baudError !== null) return t("floor.setup.printers.errors.baud");
    return null;
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
    const live = liveErrors(form);
    // What the refused «Готово» found wrong, named under each field.
    const refused = submitted ? profileOf(form, () => "check") : null;
    const refusedWith = refused !== null && "error" in refused ? refused.error : null;
    const fieldError = (text: string | null, codes: readonly string[]): string | undefined => {
      const shown =
        text ??
        (refusedWith !== null && codes.includes(refusedWith)
          ? t(`floor.setup.printers.errors.${refusedWith}`)
          : null);
      return shown === null
        ? undefined
        : t("floor.setup.printers.editor.liveError", { text: shown });
    };
    // The keypad's field: typed into by the keys and by the hardware keyboard through the same `onChange`.
    const keyField = (
      target: IpTarget,
      field: {
        label: string;
        value: string;
        onChange: (text: string) => void;
        hint?: string | undefined;
        error?: string | undefined;
      },
    ) => (
      <div
        className="setup-keyfield"
        data-active={keypad === target ? "true" : "false"}
        data-field={target}
      >
        <Input
          {...manualEntry}
          size="floor"
          mono
          inputMode="none"
          label={field.label}
          value={field.value}
          {...(keypad === target ? { suffix: <KeyboardIcon /> } : {})}
          {...(field.hint === undefined ? {} : { hint: field.hint })}
          {...(field.error === undefined ? {} : { error: field.error })}
          onChange={(event) => field.onChange(event.target.value)}
          onPointerDown={() => setKeypad(target)}
          onPaste={(event: ClipboardEvent<HTMLInputElement>) => {
            event.preventDefault();
            const input = event.currentTarget;
            field.onChange(
              pasteInto(
                field.value,
                input.selectionStart ?? field.value.length,
                input.selectionEnd ?? field.value.length,
                event.clipboardData.getData("text"),
              ),
            );
          }}
        />
      </div>
    );
    const tcp = form.kind === "tcp";
    const serial = form.kind === "serial";
    const folded = keypad !== null && (tcp || serial);
    const hostHint =
      keypad === "host"
        ? live.address.state === "ok" || live.address.state === "name"
          ? t("floor.setup.printers.editor.addressAccepted")
          : t("floor.setup.printers.editor.hostFormat")
        : undefined;
    const keypadValue =
      keypad === "host" ? form.host : keypad === "port" ? form.tcpPort : form.baud;
    const typeKeys = (next: string) => {
      if (keypad === "host") set({ host: next });
      else if (keypad === "port") set({ tcpPort: next });
      else set({ baud: next });
    };
    const nameError = fieldError(null, ["name"]);
    return (
      <div className={`setup-editor${folded ? " setup-editor--keypad" : ""}`}>
        <section className="setup-editor__card" aria-labelledby="printer-editor-title">
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
          <div className="setup-editor__grid">
            <div className="setup-editor__column">
              <div className="setup-editor__top">
                <Input
                  {...manualEntry}
                  size="floor"
                  label={t("floor.setup.printers.editor.name")}
                  value={form.name}
                  {...(nameError === undefined ? {} : { error: nameError })}
                  onChange={(event) => set({ name: event.target.value })}
                />
                <ModeSegment
                  label={t("floor.setup.printers.editor.kind")}
                  reserveHint={false}
                  options={(["tcp", "serial", "usb"] as const).map((kind) => ({
                    value: kind,
                    label: t(`floor.setup.printers.editor.kinds.${kind}`),
                  }))}
                  value={form.kind}
                  onChange={(kind) => {
                    setKeypad(null);
                    set({ kind });
                    if (kind === "usb" && usbPrinters === null) refreshUsb();
                  }}
                />
              </div>
              <div className="setup-printer-connection">
                {tcp && (
                  <>
                    {keyField("host", {
                      label: t("floor.setup.printers.editor.host"),
                      value: form.host,
                      onChange: (host) => set({ host }),
                      hint: hostHint,
                      error: fieldError(live.hostError, ["host", "address"]),
                    })}
                    {keyField("port", {
                      label: t("floor.setup.printers.editor.port"),
                      value: form.tcpPort,
                      onChange: (tcpPort) => set({ tcpPort }),
                      hint:
                        keypad === "port" ? t("floor.setup.printers.editor.portFormat") : undefined,
                      error: fieldError(live.portError, ["port"]),
                    })}
                  </>
                )}
                {serial && (
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
                    {keyField("baud", {
                      label: t("floor.setup.printers.editor.baud"),
                      value: form.baud,
                      onChange: (baud) => set({ baud }),
                      error: fieldError(live.baudError, ["baud"]),
                    })}
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
              {folded && (
                <div className="setup-editor__summary">
                  <p className="setup-card__hint">{t("floor.setup.printers.editor.rest")}</p>
                  <div className="setup-editor__summary-row">
                    <span className="setup-editor__chips">
                      <StatusChip
                        size="floor"
                        phase="none"
                        label={t(
                          form.paper === "a4"
                            ? "floor.setup.printers.editor.paperA4"
                            : "floor.setup.printers.editor.paperLabel",
                        )}
                      />
                      <StatusChip
                        size="floor"
                        phase="none"
                        label={
                          driver
                            ? t("floor.setup.printers.editor.modes.windows_driver")
                            : form.language.toUpperCase()
                        }
                      />
                      <StatusChip size="floor" phase="none" label={`${form.dpi} dpi`} />
                    </span>
                    <Button size="floor" variant="secondary" onClick={() => setKeypad(null)}>
                      {t("floor.setup.printers.editor.change")}
                    </Button>
                  </div>
                </div>
              )}
            </div>
            {!folded && (
              <>
                <div className="setup-editor__column">
                  {driver && (
                    <ModeSegment
                      label={t("floor.setup.printers.editor.paper")}
                      options={(["label", "a4"] as const).map((paper) => ({
                        value: paper,
                        label: t(
                          paper === "a4"
                            ? "floor.setup.printers.editor.paperA4"
                            : "floor.setup.printers.editor.paperLabel",
                        ),
                      }))}
                      value={form.paper}
                      hint={t("floor.setup.printers.editor.paperHint")}
                      onChange={(paper) => set({ paper })}
                    />
                  )}
                  {driver ? (
                    <p className="setup-card__hint">
                      {t("floor.setup.printers.editor.driverHint")}
                    </p>
                  ) : (
                    <ModeSegment
                      label={t("floor.setup.printers.editor.language")}
                      options={[
                        { value: "zpl" as const, label: "ZPL" },
                        { value: "tspl" as const, label: "TSPL" },
                      ]}
                      value={form.language}
                      hint={t("floor.setup.printers.editor.languageHint")}
                      onChange={(language) => set({ language })}
                    />
                  )}
                </div>
                <div className="setup-editor__column">
                  <ModeSegment
                    label={t("floor.setup.printers.editor.dpi")}
                    disabled={form.paper === "a4"}
                    options={[
                      { value: "203" as const, label: "203 dpi" },
                      { value: "300" as const, label: "300 dpi" },
                    ]}
                    value={form.dpi}
                    hint={t("floor.setup.printers.editor.dpiHint")}
                    onChange={(dpi) => set({ dpi })}
                  />
                  {form.kind === "usb" && (windowsDriver || form.mode === "windows_driver") && (
                    <ModeSegment
                      label={t("floor.setup.printers.editor.mode")}
                      reserveHint={false}
                      options={(["raw", "windows_driver"] as const).map((mode) => ({
                        value: mode,
                        label: t(`floor.setup.printers.editor.modes.${mode}`),
                      }))}
                      value={form.mode}
                      onChange={(mode) => set({ mode })}
                    />
                  )}
                </div>
              </>
            )}
          </div>
        </section>
        {folded && keypad !== null && (
          <IpKeypad
            target={keypad}
            targets={
              tcp
                ? [
                    { value: "host", label: t("floor.setup.printers.editor.keypad.host") },
                    { value: "port", label: t("floor.setup.printers.editor.keypad.port") },
                  ]
                : [{ value: "baud", label: t("floor.setup.printers.editor.keypad.baud") }]
            }
            onTargetChange={setKeypad}
            value={keypadValue}
            onChange={typeKeys}
            ariaLabel={t(
              tcp
                ? "floor.setup.printers.editor.keypad.label"
                : "floor.setup.printers.editor.keypad.labelBaud",
            )}
            segmentLabel={t("floor.setup.printers.editor.keypad.target")}
            eraseLabel={t("floor.setup.printers.editor.keypad.erase")}
            actionLabel={t(
              keypad === "host"
                ? "floor.setup.printers.editor.keypad.next"
                : "floor.setup.printers.editor.keypad.close",
            )}
            actionPrimary={keypad === "host"}
            actionDisabled={
              keypad === "host" && live.address.state !== "ok" && live.address.state !== "name"
            }
            onAction={() => setKeypad(keypad === "host" ? "port" : null)}
          />
        )}
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

  const palletOnA4 = draft.printers.some(
    (printer) => printer.id === draft.assignments.pallet && printer.paper === "a4",
  );

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
              onClick={() => {
                setSubmitted(false);
                setEditor(
                  newPrinterDraft(
                    draft.printers.map((printer) => printer.name),
                    t("floor.setup.printers.defaultNamePrefix"),
                  ),
                );
              }}
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
                  const tested = test !== null && testOwner.current === printer.id;
                  return (
                    <li className="setup-printer-row" key={printer.id}>
                      <div className="setup-printer-row__detail">
                        <div className="setup-printer-row__title">
                          <h3>{printer.name}</h3>
                          {tested ? (
                            <StatusChip
                              size="floor"
                              phase={TEST_CHIP[test.kind].phase}
                              label={t(`floor.setup.printers.testChip.${test.kind}`)}
                            />
                          ) : (
                            <StatusChip
                              size="floor"
                              phase="none"
                              label={t("floor.setup.printers.notTested")}
                            />
                          )}
                        </div>
                        <p className="setup-printer-row__connection">{summary(printer)}</p>
                      </div>
                      <div className="setup-printer-row__actions">
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
                          aria-label={t("floor.setup.printers.editFor", { name: printer.name })}
                          onClick={() => {
                            setSubmitted(false);
                            setEditor(draftOf(printer));
                          }}
                        >
                          {t("floor.setup.printers.edit")}
                        </Button>
                        <Button
                          size="floor"
                          variant="secondary"
                          className="setup-printer-row__remove"
                          aria-label={t("floor.setup.printers.removeFor", { name: printer.name })}
                          title={t("floor.setup.printers.remove")}
                          onClick={() => remove(printer.id)}
                        >
                          <TrashIcon />
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
            <div className="setup-printer-verification">
              <SwitchCard
                title={t("floor.setup.check.toggle")}
                hint={t(
                  draft.verifyPrintedLabel ? "floor.setup.check.on" : "floor.setup.check.off",
                )}
                checked={draft.verifyPrintedLabel}
                stateLabel={t(
                  draft.verifyPrintedLabel
                    ? "floor.setup.sound.stateOn"
                    : "floor.setup.sound.stateOff",
                )}
                onChange={(verifyPrintedLabel) => change({ ...draft, verifyPrintedLabel })}
              />
            </div>
          </div>
        </section>
        <section className="setup-printer-assignments" aria-labelledby="setup-purposes-title">
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
              {...(purpose === "pallet" && palletOnA4
                ? { hint: t("floor.setup.printers.purposes.a4Note") }
                : {})}
              onValueChange={(id) => assign(purpose, id)}
            />
          ))}
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

  const baudCheck = checkBaud(scanner.baud);
  const scannerBaudError =
    baudCheck.state === "range"
      ? t("floor.setup.printers.editor.liveError", {
          text: t("floor.setup.printers.errors.baudRange"),
        })
      : undefined;

  const scannerPanel = (
    <div className={`setup-scanners${scannersOnly ? " setup-scanners--only" : ""}`}>
      <section className="setup-scanners__list" aria-labelledby="setup-scanners-title">
        <div className="setup-printer-list__header">
          <div className="setup-printer-list__heading">
            <h2
              id="setup-scanners-title"
              className="setup-card__title"
              ref={scannersHeading}
              tabIndex={-1}
            >
              {t("floor.setup.scanners.title")}
            </h2>
            <span className="setup-printer-list__count" aria-hidden="true">
              {draft.scanners.length}
            </span>
          </div>
        </div>
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
                  <span className="setup-scanner-row__kind">
                    {t("floor.setup.scanners.rowKind")}
                  </span>
                </div>
                <span aria-live="polite" className="setup-scanner-row__state">
                  <StatusChip size="floor" wrap phase={state.phase} label={state.text} />
                </span>
                <Button
                  size="floor"
                  variant="secondary"
                  icon={<TrashIcon />}
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
          <li className="setup-scanner-row setup-scanner-row--always">
            <div className="setup-scanner-row__detail">
              <strong>{t("floor.setup.scanners.keyboardTitle")}</strong>
              <span className="setup-scanner-row__kind">
                {t("floor.setup.scanners.keyboardBody")}
              </span>
            </div>
            <StatusChip size="floor" phase="none" label={t("floor.setup.scanners.keyboardChip")} />
          </li>
        </ul>
        {draft.scanners.length === 0 && (
          <p className="setup-card__waiting">{t("floor.setup.scanners.empty")}</p>
        )}
        <div className="setup-scanner-add" role="group" aria-labelledby="setup-scanner-add">
          <h3 id="setup-scanner-add" className="setup-scanner-add__title">
            {t("floor.setup.scanners.connection")}
          </h3>
          <div className="setup-scanner-add__fields">
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
            <div
              className="setup-keyfield"
              data-active={keypad === "baud" ? "true" : "false"}
              data-field="baud"
            >
              <Input
                {...manualEntry}
                size="floor"
                mono
                inputMode="none"
                label={t("floor.setup.scanners.baud")}
                value={scanner.baud}
                {...(keypad === "baud" ? { suffix: <KeyboardIcon /> } : {})}
                {...(scannerBaudError === undefined ? {} : { error: scannerBaudError })}
                onChange={(event) => {
                  setScanner({ ...scanner, baud: event.target.value });
                  setScannerError(null);
                }}
                onPointerDown={() => setKeypad("baud")}
                onPaste={(event: ClipboardEvent<HTMLInputElement>) => {
                  event.preventDefault();
                  const input = event.currentTarget;
                  setScanner({
                    ...scanner,
                    baud: pasteInto(
                      scanner.baud,
                      input.selectionStart ?? scanner.baud.length,
                      input.selectionEnd ?? scanner.baud.length,
                      event.clipboardData.getData("text"),
                    ),
                  });
                  setScannerError(null);
                }}
              />
            </div>
            <Button size="floor" onClick={addScanner}>
              {t("floor.setup.scanners.add")}
            </Button>
          </div>
          <div className="workstation-setup__live" aria-live="polite">
            {scannerError !== null && (
              <Alert tone="error" role="presentation">
                {scannerError}
              </Alert>
            )}
          </div>
          <div className="setup-scanner-add__ports">
            <Button size="floor" variant="secondary" onClick={refreshSerial}>
              {t("floor.setup.scanners.listPorts")}
            </Button>
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
          </div>
        </div>
      </section>
      <div className="setup-scanners__side">
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
        {keypad === "baud" ? (
          <IpKeypad
            target="baud"
            targets={[{ value: "baud", label: t("floor.setup.printers.editor.keypad.baud") }]}
            onTargetChange={setKeypad}
            value={scanner.baud}
            onChange={(baud) => {
              setScanner({ ...scanner, baud });
              setScannerError(null);
            }}
            ariaLabel={t("floor.setup.printers.editor.keypad.labelBaud")}
            segmentLabel={t("floor.setup.printers.editor.keypad.target")}
            eraseLabel={t("floor.setup.printers.editor.keypad.erase")}
            actionLabel={t("floor.setup.printers.editor.keypad.close")}
            onAction={() => setKeypad(null)}
          />
        ) : (
          selfTestPanel
        )}
      </div>
    </div>
  );

  const soundPanel = (
    <div className="setup-sound">
      <SwitchCard
        title={t("floor.setup.sound.title")}
        hint={t(draft.sound.muted ? "floor.setup.sound.off" : "floor.setup.sound.on")}
        checked={!draft.sound.muted}
        stateLabel={t(
          draft.sound.muted ? "floor.setup.sound.stateOff" : "floor.setup.sound.stateOn",
        )}
        onChange={(on) => change({ ...draft, sound: { ...draft.sound, muted: !on } })}
      />
      <section className="setup-volume" aria-labelledby="setup-volume-title">
        <div className="setup-volume__head">
          <h2 id="setup-volume-title" className="setup-card__title">
            {t("floor.setup.sound.volume")}
          </h2>
          <p className="setup-volume__value" aria-live="polite">
            {silent
              ? t("floor.setup.sound.silent")
              : t("floor.setup.sound.percent", { volume: draft.sound.volume })}
          </p>
        </div>
        <div className="setup-volume__row">
          {/* At a limit a button stays on the keyboard and does nothing: one that vanished would take the focus. */}
          <Button
            size="floor"
            variant="secondary"
            className="setup-volume__step"
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
          <VolumeScale filled={volumeDivisions(draft.sound)} silent={silent} />
          <Button
            size="floor"
            variant="secondary"
            className="setup-volume__step"
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
        <p className="setup-card__hint" aria-live="polite">
          {silent
            ? t("floor.setup.sound.scaleSilent")
            : t("floor.setup.sound.scale", { level: volumeDivisions(draft.sound) })}
        </p>
        <div>
          <Button
            size="floor"
            variant="secondary"
            onClick={() => playTone(soundLevel(draft.sound))}
          >
            {t("floor.setup.sound.try")}
          </Button>
        </div>
      </section>
    </div>
  );

  const tabs: { id: SetupTabId; label: string }[] = [
    { id: "printer", label: t("floor.setup.tabs.printer") },
    { id: "scanner", label: t("floor.setup.tabs.scanner") },
    { id: "sound", label: t("floor.setup.tabs.sound") },
    { id: "station", label: t("floor.setup.tabs.station") },
  ];
  // Before its pairing a station sets its scanners only: no tabs, the scanner panel alone.
  const shownTab: SetupTabId = scannersOnly ? "scanner" : activeTab;
  const shown = tabs.find((tab) => tab.id === shownTab) ?? tabs[0];
  const routing = shownTab === "printer" && editor === null;
  const showTest = routing && test !== null;
  const panels: Record<SetupTabId, ReactNode> = {
    printer: printersPanel,
    scanner: scannerPanel,
    sound: soundPanel,
    station: <StationPanel facts={facts} />,
  };
  const subtitle = t(
    `floor.setup.subtitle.${shownTab === "printer" && editor !== null ? "editor" : shownTab}`,
  );

  // The footer's words: what is unsaved (or saved, or nothing), or what is wrong with the printer form.
  const parts = unsavedParts(stored, draft);
  const unsaved = parts.length > 0 || canSave;
  const partNames = (parts.length > 0 ? parts : (["scanners"] as const)).map((part) =>
    t(`floor.setup.footer.parts.${part}`),
  );
  const formAlert = editor === null ? null : (editorError ?? liveFooterError(editor));
  const formBlocked = editor !== null && liveFooterError(editor) !== null;

  return (
    <section className="workstation-setup" aria-labelledby="workstation-setup-title">
      <header className="workstation-setup__header">
        <div className="workstation-setup__heading">
          <h2 id="workstation-setup-title">
            {t(scannersOnly ? "floor.setup.scannerScope.title" : "floor.setup.title")}
          </h2>
          <p className="workstation-setup__subtitle">{subtitle}</p>
        </div>
        {!scannersOnly && (
          <SetupTabList
            tabs={tabs}
            label={t("floor.setup.tabs.label")}
            activeTab={activeTab}
            locked={editor !== null}
            onTabChange={setActiveTab}
          />
        )}
      </header>

      {shown !== undefined && (
        <SetupTabPanel tab={shown}>
          {scannersOnly ? (
            <div className="workstation-setup__single">{scannerPanel}</div>
          ) : (
            panels[shownTab]
          )}
        </SetupTabPanel>
      )}

      {/* Regions that are always there, so a reader hears what comes into them; their alerts are no alerts of their own. */}
      <div className="workstation-setup__result">
        <div className="workstation-setup__live" aria-live="polite">
          {showTest && (
            <Alert tone={testText(test).tone} role="presentation">
              {testText(test).text}
            </Alert>
          )}
          {showTest && test.kind === "failed" && test.diagnostic !== undefined && (
            <DiagnosticCopy text={test.diagnostic} />
          )}
        </div>
      </div>

      {editor !== null ? (
        <footer className="workstation-setup__footer">
          <Button
            size="floor"
            variant="secondary"
            className="setup-footer__back"
            onClick={() => {
              setEditor(null);
              setEditorError(null);
              setSubmitted(false);
              setKeypad(null);
            }}
          >
            {t("floor.setup.printers.editor.cancel")}
          </Button>
          <div className="setup-footer__status" aria-live="polite">
            {formAlert !== null ? (
              <Alert tone="error" role="presentation">
                {formAlert}
              </Alert>
            ) : (
              <p className="setup-footer__hint">
                {t(
                  keypad !== null
                    ? "floor.setup.footer.keypadHint"
                    : "floor.setup.footer.editorHint",
                )}
              </p>
            )}
          </div>
          <Button
            size="floor"
            className="floor-primary setup-footer__primary"
            {...(formBlocked ? { "aria-disabled": true, style: WAITING_STYLE } : {})}
            onClick={() => {
              if (!formBlocked) applyEditor();
            }}
          >
            {t("floor.setup.printers.editor.apply")}
          </Button>
        </footer>
      ) : (
        <footer className="workstation-setup__footer">
          {/* Never held by a save or a test print: leaving is always open. */}
          <Button size="floor" variant="secondary" className="setup-footer__back" onClick={onBack}>
            {t(dirty ? "floor.setup.backUnsaved" : "floor.setup.back")}
          </Button>
          <div className="setup-footer__status" aria-live="polite">
            {status !== null && status.kind !== "saved" ? (
              <Alert tone="error" role="presentation">
                {t(`floor.setup.status.${status.kind}`)}
              </Alert>
            ) : status !== null ? (
              <StatusChip size="floor" phase="done" label={t("floor.setup.footer.saved")} />
            ) : unsaved ? (
              <StatusChip
                size="floor"
                wrap
                phase="attention"
                label={t("floor.setup.footer.unsaved", { parts: partNames.join(", ") })}
              />
            ) : (
              <StatusChip size="floor" phase="done" label={t("floor.setup.footer.clean")} />
            )}
          </div>
          {/* Kept on the keyboard while it saves or has nothing to save: a button that vanishes from the tab order takes the focus with it. */}
          <Button
            size="floor"
            className="floor-primary setup-footer__primary"
            {...(!canSave || saving ? { "aria-disabled": true, style: WAITING_STYLE } : {})}
            onClick={() => void save()}
          >
            {t("floor.setup.save")}
          </Button>
        </footer>
      )}
    </section>
  );
}
