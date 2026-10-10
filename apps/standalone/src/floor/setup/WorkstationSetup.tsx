import { sampleLabelData } from "@markiro/domain";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, Card, Input, Select } from "@markiro/ui";

import type { HardwareApi, UsbPrinter } from "../../hardware/hardware.js";
import type { LocalExecutor } from "../../local/executor.js";
import { renderLabel } from "../print/label-render.js";
import { settleOutcome, type PrintJobCode, type RenderLabel } from "../print/print-jobs.js";
import type { PrintRuntime } from "../print/print-runtime.js";
import type { ScanSource } from "../scan-source.js";
import { draftOf, NEW_PRINTER, profileOf, type PrinterDraft } from "./printer-draft.js";
import { makeTestCode, scannedTestCode, testLabelSpec } from "./test-label.js";
import {
  InvalidSettingsError,
  PRINT_PURPOSES,
  printerTargetKey,
  readWorkstationSettings,
  saveWorkstationSettings,
  type PrinterProfile,
  type PrintPurpose,
  type WorkstationSettings,
} from "./workstation-settings.js";

export interface WorkstationSetupProps {
  local: LocalExecutor;
  hardware: Pick<HardwareApi, "listUsbPrinters">;
  printing: PrintRuntime;
  /** The floor's scanner: the code of a test label is scanned back here. */
  source: ScanSource;
  /** How the test label is rendered; the app's by default. */
  render?: RenderLabel;
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

type Status = { kind: "saved" } | { kind: "save_failed" } | { kind: "invalid" };

/** A button that waits for an answer: still on the keyboard, and a press that does nothing. */
const WAITING_STYLE: CSSProperties = { opacity: 0.45, cursor: "not-allowed" };

/**
 * The workstation setup (stage 2a spec §5.7.8): the printers of this
 * computer — where each is, its language and resolution — which one prints
 * which label, and a test print whose code is scanned back. Nothing is
 * stored until «Сохранить»; «Назад» leaves at once and says when it drops a
 * change, so the setup never holds the operator.
 */
export function WorkstationSetup({
  local,
  hardware,
  printing,
  source,
  render = renderLabel,
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
    if (savingNow.current || !dirty || editor !== null) return;
    savingNow.current = true;
    setSaving(true);
    setStatus(null);
    try {
      await saveWorkstationSettings(local, draft);
      setStored(draft);
      setStatus({ kind: "saved" });
      onSaved(draft);
    } catch (error) {
      setStatus(
        error instanceof InvalidSettingsError ? { kind: "invalid" } : { kind: "save_failed" },
      );
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
            {...(!dirty || saving ? { "aria-disabled": true, style: WAITING_STYLE } : {})}
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
