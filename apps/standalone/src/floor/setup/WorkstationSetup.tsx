import { sampleLabelData } from "@markiro/domain";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, Card, Input, Select } from "@markiro/ui";

import type {
  HardwareApi,
  ScannerConfig,
  ScannerSnapshot,
  UsbPrinter,
} from "../../hardware/hardware.js";
import type { LocalExecutor } from "../../local/executor.js";
import { renderLabel } from "../print/label-render.js";
import { settleOutcome, type PrintJobCode, type RenderLabel } from "../print/print-jobs.js";
import type { PrintRuntime } from "../print/print-runtime.js";
import type { ScanSource } from "../scan-source.js";
import { playSignalTone } from "../work/signal-sound.js";
import { draftOf, NEW_PRINTER, profileOf, type PrinterDraft } from "./printer-draft.js";
import { makeTestCode, scannedTestCode, testLabelSpec } from "./test-label.js";
import {
  canonicalPort,
  InvalidSettingsError,
  isPortName,
  MAX_SCANNERS,
  PRINT_PURPOSES,
  printerTargetKey,
  readWorkstationSettings,
  saveWorkstationSettings,
  sharedSerialPort,
  soundLevel,
  type PrinterProfile,
  type PrintPurpose,
  type WorkstationSettings,
} from "./workstation-settings.js";

/** The steps of the tones' level: 0, 10, … 100. */
const VOLUME_STEP = 10;

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
  /** «Проверить звук»: the floor's own tone at this level (0–1); the generated tone by default. */
  playTone?: (level: number) => void;
  /** The settings were stored: the floor reads them again. */
  onSaved: (settings: WorkstationSettings) => void;
  onBack: () => void;
}

/** How a test print went, in words: the printer's answer, then the scan of its code. */
type TestState =
  | { kind: "sending"; printerId: string }
  | { kind: "sent"; printerId: string; name: string; code: string }
  | { kind: "failed"; code: PrintJobCode; unknown: boolean }
  | { kind: "render_failed" }
  | { kind: "match" }
  | { kind: "mismatch"; name: string; code: string };

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

/** A button that waits for an answer: still on the keyboard, and a press that does nothing. */
const WAITING_STYLE: CSSProperties = { opacity: 0.45, cursor: "not-allowed" };

/**
 * The workstation setup (stage 2a spec §5.7.8): the printers of this
 * computer — where each is, its language and resolution — which one prints
 * which label, and a test print whose code is scanned back; the COM scanners
 * with their connection as the shell reports it; the tones' level; the check
 * of a printed label. Nothing is stored until «Сохранить», which then gives
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
  playTone = (level) => playSignalTone("ok", undefined, level),
  onSaved,
  onBack,
}: WorkstationSetupProps) {
  const { t } = useTranslation();
  const [stored, setStored] = useState<WorkstationSettings | null>(null);
  const [draft, setDraft] = useState<WorkstationSettings | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const [editor, setEditor] = useState<PrinterDraft | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [usbPrinters, setUsbPrinters] = useState<UsbPrinter[] | null>(null);
  const [usbFailed, setUsbFailed] = useState(false);
  const [usbAsking, setUsbAsking] = useState(false);
  const [test, setTestState] = useState<TestState | null>(null);
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
  const loaded = draft !== null && stored !== null;
  const editing = editor !== null;
  useEffect(() => {
    if (loaded) sectionHeading.current?.focus();
  }, [loaded, editing]);

  // The test print as the scanner's listener reads it: kept as it is set, so
  // a scan right after the label went is checked against it, never missed.
  const testRef = useRef<TestState | null>(null);
  const setTest = useCallback((next: TestState | null) => {
    testRef.current = next;
    setTestState(next);
  }, []);
  useEffect(
    () =>
      source.start((raw) => {
        const now = testRef.current;
        // The check stays open after a wrong scan, until the right code comes.
        if (now?.kind !== "sent" && now?.kind !== "mismatch") return;
        // A scan that is not this label's code is never shown: it may be a badge.
        setTest(
          scannedTestCode(raw) === now.code
            ? { kind: "match" }
            : { kind: "mismatch", name: now.name, code: now.code },
        );
      }),
    [source, setTest],
  );

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

  const scannersHeading = useRef<HTMLHeadingElement>(null);

  const change = (next: WorkstationSettings) => {
    setDraft(next);
    setStatus(null);
  };

  if (readFailed || draft === null || stored === null) {
    return (
      <Card className="standalone-card" title={t("floor.setup.title")} titleAs="h2">
        <div className="standalone-form">
          <div aria-live="polite">
            {readFailed ? (
              <Alert tone="error" role="presentation">
                {t("floor.setup.readFailed")}
              </Alert>
            ) : (
              <p>{t("floor.setup.loading")}</p>
            )}
          </div>
          <div className="standalone-form__actions">
            <Button size="floor" variant="secondary" onClick={onBack}>
              {t("floor.setup.back")}
            </Button>
          </div>
        </div>
      </Card>
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

  const applyEditor = () => {
    if (editor === null) return;
    const result = profileOf(editor, () => crypto.randomUUID());
    if ("error" in result) {
      setEditorError(t(`floor.setup.printers.errors.${result.error}`));
      return;
    }
    const { profile } = result;
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
    const exists = draft.printers.some((printer) => printer.id === profile.id);
    change({
      ...draft,
      printers: exists
        ? draft.printers.map((printer) => (printer.id === profile.id ? profile : printer))
        : [...draft.printers, profile],
    });
    setEditor(null);
    setEditorError(null);
  };

  const remove = (id: string) => {
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
    const code = makeTestCode();
    setTest({ kind: "sending", printerId: printer.id });
    let bytes: Uint8Array;
    try {
      bytes = await render(testLabelSpec(code, printer.language), sampleLabelData(), printer);
    } catch {
      setTest({ kind: "render_failed" });
      return;
    }
    const settled = settleOutcome(await printing.send(null, printer.target, bytes));
    setTest(
      settled.state === "sent"
        ? { kind: "sent", printerId: printer.id, name: printer.name, code }
        : { kind: "failed", code: settled.code, unknown: settled.state === "unknown" },
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
    return `${where} · ${t("floor.setup.printers.format", {
      language: printer.language.toUpperCase(),
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
          text: t("floor.setup.printers.testResult.sent", { name: state.name }),
        };
      case "failed":
        return {
          tone: "error",
          text: `${t(
            state.unknown
              ? "floor.setup.printers.testResult.unknown"
              : "floor.setup.printers.testResult.failed",
          )} ${t(`floor.print.codes.${state.code}`)}`,
        };
      case "render_failed":
        return { tone: "error", text: t("floor.setup.printers.testResult.renderFailed") };
      case "match":
        return { tone: "ok", text: t("floor.setup.printers.testResult.match") };
      case "mismatch":
        return { tone: "warn", text: t("floor.setup.printers.testResult.mismatch") };
    }
  };

  const editorForm = (form: PrinterDraft) => {
    const set = (patch: Partial<PrinterDraft>) => {
      setEditor({ ...form, ...patch });
      setEditorError(null);
    };
    const usbOptions = [
      { value: "", label: t("floor.setup.printers.editor.usbChoose") },
      ...(form.usbPrinter !== "" && !(usbPrinters ?? []).some((p) => p.name === form.usbPrinter)
        ? [{ value: form.usbPrinter, label: form.usbPrinter }]
        : []),
      ...(usbPrinters ?? []).map((printer) => ({ value: printer.name, label: printer.name })),
    ];
    return (
      <div className="standalone-form workstation-setup__editor">
        <h3 ref={sectionHeading} tabIndex={-1}>
          {form.id === null
            ? t("floor.setup.printers.editor.titleNew")
            : t("floor.setup.printers.editor.titleEdit", { name: form.name })}
        </h3>
        <Input
          size="floor"
          label={t("floor.setup.printers.editor.name")}
          value={form.name}
          onChange={(event) => set({ name: event.target.value })}
        />
        <Select
          native
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
        {form.kind === "tcp" && (
          <>
            <Input
              size="floor"
              label={t("floor.setup.printers.editor.host")}
              value={form.host}
              onChange={(event) => set({ host: event.target.value })}
            />
            <Input
              size="floor"
              inputMode="numeric"
              label={t("floor.setup.printers.editor.port")}
              value={form.tcpPort}
              onChange={(event) => set({ tcpPort: event.target.value })}
            />
          </>
        )}
        {form.kind === "serial" && (
          <>
            <Input
              size="floor"
              label={t("floor.setup.printers.editor.serialPort")}
              value={form.serialPort}
              onChange={(event) => set({ serialPort: event.target.value })}
            />
            <Input
              size="floor"
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
              native
              size="floor"
              label={t("floor.setup.printers.editor.usbPrinter")}
              value={form.usbPrinter}
              options={usbOptions}
              {...(usbFailed ? { error: t("floor.setup.printers.editor.usbFailed") } : {})}
              {...(usbAsking
                ? { hint: t("floor.setup.printers.editor.usbAsking") }
                : usbPrinters !== null && usbPrinters.length === 0 && !usbFailed
                  ? { hint: t("floor.setup.printers.editor.usbNone") }
                  : {})}
              onValueChange={(usbPrinter) => set({ usbPrinter })}
            />
            <Button size="floor" variant="secondary" onClick={refreshUsb}>
              {t("floor.setup.printers.editor.usbRefresh")}
            </Button>
          </>
        )}
        <Select
          native
          size="floor"
          label={t("floor.setup.printers.editor.language")}
          value={form.language}
          options={[
            { value: "zpl", label: "ZPL (Zebra)" },
            { value: "tspl", label: "TSPL (TSC)" },
          ]}
          onValueChange={(language) => set({ language })}
        />
        <Select
          native
          size="floor"
          label={t("floor.setup.printers.editor.dpi")}
          value={form.dpi}
          options={[
            { value: "203", label: "203 dpi" },
            { value: "300", label: "300 dpi" },
          ]}
          onValueChange={(dpi) => set({ dpi })}
        />
        {editorError !== null && <Alert tone="error">{editorError}</Alert>}
        <div className="standalone-form__actions">
          <Button size="floor" onClick={applyEditor}>
            {t("floor.setup.printers.editor.apply")}
          </Button>
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
        </div>
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

  const connection = (configured: ScannerConfig): string => {
    const saved = stored.scanners.some(
      (candidate) => candidate.port === configured.port && candidate.baud === configured.baud,
    );
    if (!saved) return t("floor.setup.scanners.notApplied");
    if (watchFailed) return t("floor.setup.scanners.watchFailed");
    if (snapshot === null) return t("floor.setup.scanners.checking");
    const known = snapshot.scanners.find(
      (candidate) => candidate.port === configured.port && candidate.baud === configured.baud,
    );
    if (known === undefined) {
      return t(
        unapplied || unopened
          ? "floor.setup.scanners.notOpenedRetry"
          : "floor.setup.scanners.notOpened",
      );
    }
    return t(
      known.status === "connected"
        ? "floor.setup.scanners.connected"
        : "floor.setup.scanners.disconnected",
    );
  };

  const silent = soundLevel(draft.sound) === 0;
  const setVolume = (volume: number) => {
    change({ ...draft, sound: { ...draft.sound, volume: Math.min(100, Math.max(0, volume)) } });
  };

  const purposeOptions = [
    { value: "", label: t("floor.setup.printers.purposes.none") },
    ...draft.printers.map((printer) => ({ value: printer.id, label: printer.name })),
  ];

  return (
    <Card className="standalone-card workstation-setup" title={t("floor.setup.title")} titleAs="h2">
      <div className="standalone-form">
        {editor === null && (
          <h3 ref={sectionHeading} tabIndex={-1}>
            {t("floor.setup.printers.title")}
          </h3>
        )}
        {editor !== null ? (
          editorForm(editor)
        ) : (
          <>
            {draft.printers.length === 0 ? (
              <p>{t("floor.setup.printers.empty")}</p>
            ) : (
              <ul className="workstation-setup__list">
                {draft.printers.map((printer) => (
                  <li key={printer.id}>
                    <strong>{printer.name}</strong>
                    <span>{summary(printer)}</span>
                    <div className="standalone-form__actions">
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
                ))}
              </ul>
            )}
            {/* A region that is always there, so a reader hears what comes into it; its alert is no alert of its own. */}
            <div className="workstation-setup__live" aria-live="polite">
              {test !== null && (
                <Alert tone={testText(test).tone} role="presentation">
                  {testText(test).text}
                </Alert>
              )}
            </div>
            <Button size="floor" variant="secondary" onClick={() => setEditor(NEW_PRINTER)}>
              {t("floor.setup.printers.add")}
            </Button>
            <h3>{t("floor.setup.printers.purposes.title")}</h3>
            {PRINT_PURPOSES.map((purpose) => (
              <Select
                key={purpose}
                native
                size="floor"
                label={t(`floor.setup.printers.purposes.${purpose}`)}
                value={draft.assignments[purpose] ?? ""}
                options={purposeOptions}
                {...(purpose === "box" ? {} : { hint: t("floor.setup.printers.purposes.later") })}
                onValueChange={(id) => assign(purpose, id)}
              />
            ))}
          </>
        )}
        {editor === null && (
          <>
            <h3 ref={scannersHeading} tabIndex={-1}>
              {t("floor.setup.scanners.title")}
            </h3>
            {draft.scanners.length === 0 ? (
              <p>{t("floor.setup.scanners.empty")}</p>
            ) : (
              <ul className="workstation-setup__list">
                {draft.scanners.map((configured) => (
                  <li key={configured.port}>
                    <strong>
                      {t("floor.setup.scanners.summary", {
                        port: configured.port,
                        baud: configured.baud,
                      })}
                    </strong>
                    <span aria-live="polite">{connection(configured)}</span>
                    <div className="standalone-form__actions">
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
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <Input
              size="floor"
              label={t("floor.setup.scanners.port")}
              value={scanner.port}
              onChange={(event) => {
                setScanner({ ...scanner, port: event.target.value });
                setScannerError(null);
                setStatus((now) => (now?.kind === "scanner_unadded" ? null : now));
              }}
            />
            <Input
              size="floor"
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
            <div className="standalone-form__actions">
              <Button size="floor" variant="secondary" onClick={addScanner}>
                {t("floor.setup.scanners.add")}
              </Button>
              <Button size="floor" variant="secondary" onClick={refreshSerial}>
                {t("floor.setup.scanners.listPorts")}
              </Button>
            </div>
            <div className="workstation-setup__live" aria-live="polite">
              {serialAsking ? (
                <p>{t("floor.setup.scanners.portsAsking")}</p>
              ) : (
                serialPorts !== null && (
                  <p>
                    {serialFailed
                      ? t("floor.setup.scanners.portsFailed")
                      : serialPorts.length === 0
                        ? t("floor.setup.scanners.portsNone")
                        : t("floor.setup.scanners.ports", { ports: serialPorts.join(", ") })}
                  </p>
                )
              )}
            </div>
            <p>{t("floor.setup.scanners.keyboard")}</p>

            <h3>{t("floor.setup.sound.title")}</h3>
            <p aria-live="polite">
              {silent
                ? t("floor.setup.sound.mutedNow")
                : t("floor.setup.sound.level", { volume: draft.sound.volume })}
            </p>
            <div className="standalone-form__actions">
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
              <Button
                size="floor"
                variant="secondary"
                aria-pressed={draft.sound.muted}
                onClick={() =>
                  change({ ...draft, sound: { ...draft.sound, muted: !draft.sound.muted } })
                }
              >
                {t("floor.setup.sound.mute")}
              </Button>
              <Button
                size="floor"
                variant="secondary"
                onClick={() => playTone(soundLevel(draft.sound))}
              >
                {t("floor.setup.sound.try")}
              </Button>
            </div>

            <h3>{t("floor.setup.check.title")}</h3>
            <p>{t("floor.setup.check.body")}</p>
            <p>{t("floor.setup.check.later")}</p>
            <Button
              size="floor"
              variant="secondary"
              aria-pressed={draft.verifyPrintedLabel}
              onClick={() => change({ ...draft, verifyPrintedLabel: !draft.verifyPrintedLabel })}
            >
              {t("floor.setup.check.toggle")}
            </Button>
            <p aria-live="polite">
              {t(draft.verifyPrintedLabel ? "floor.setup.check.on" : "floor.setup.check.off")}
            </p>
          </>
        )}
        <div className="workstation-setup__live" aria-live="polite">
          {status !== null && (
            <Alert tone={status.kind === "saved" ? "ok" : "error"} role="presentation">
              {t(`floor.setup.status.${status.kind}`)}
            </Alert>
          )}
        </div>
        <div className="standalone-form__actions">
          {/* Kept on the keyboard while it saves or has nothing to save: a button that vanishes from the tab order takes the focus with it. */}
          <Button
            size="floor"
            disabled={editor !== null}
            {...(!canSave || saving ? { "aria-disabled": true, style: WAITING_STYLE } : {})}
            onClick={() => void save()}
          >
            {t("floor.setup.save")}
          </Button>
          {/* Never held by a save or a test print: leaving is always open. */}
          <Button size="floor" variant="secondary" onClick={onBack}>
            {t(dirty ? "floor.setup.backUnsaved" : "floor.setup.back")}
          </Button>
        </div>
      </div>
    </Card>
  );
}
