import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Checkbox, Input, Textarea } from "@markiro/ui";
import { RECEIVING_CSV_COLUMNS, RECEIVING_CSV_VERSION } from "@markiro/domain";
import {
  receivingCsvPreviewInputSchema,
  type ReceivingCsvPreview,
  type ReceivingCsvPreviewInput,
  type ReceivingCsvApplyInput,
  type ReceivingLiveRecord,
} from "@markiro/platform-contracts";
import { useTranslation } from "react-i18next";
import { UsClientError } from "../client.js";
import type { MasterDataViewProps } from "../master-data/workspace-shared.js";
import { ReceivingReferencePicker } from "./reference-picker.js";
import { ReceivingDocumentSection } from "./document-section.js";
import { ReceivingCsvPreviewDetails } from "./csv-preview.js";
import "./receiving.css";
import "./csv.css";

const emptyHeader: ReceivingCsvPreviewInput["header"] = {
  dateReceived: null,
  locationId: null,
  previousSourceLocationId: null,
  receivedAtNote: null,
  notes: null,
  documentIds: [],
};
type Command = { id: string; body: ReceivingCsvApplyInput };
type Props = MasterDataViewProps & {
  timeZone: string;
  onClose: () => void;
  onOpenRecord: (record: ReceivingLiveRecord) => void;
  backLabel?: string;
};
function fileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reader.onabort = () => reject(new UsClientError("invalid_input"));
    reader.onload = () => {
      if (!(reader.result instanceof ArrayBuffer)) {
        reject(new UsClientError("invalid_input"));
        return;
      }
      let binary = "";
      for (const byte of new Uint8Array(reader.result)) binary += String.fromCharCode(byte);
      resolve(btoa(binary));
    };
    reader.readAsArrayBuffer(file);
  });
}
function downloadTemplate() {
  const url = URL.createObjectURL(
    new Blob([RECEIVING_CSV_COLUMNS.join(",") + "\n"], { type: "text/csv;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = "markiro-receiving-v1.csv";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function ReceivingCsvImport(props: Props) {
  const {
    client,
    canWrite,
    mutationPending,
    beginMutation,
    onDirtyChange,
    onForbidden,
    onSessionLost,
    onOpenRecord,
    onClose,
  } = props;
  const { t } = useTranslation();
  const [step, setStep] = useState<"input" | "review" | "confirm">("input");
  const [file, setFile] = useState<File | null>(null);
  const [header, setHeader] = useState(emptyHeader);
  const [documentDirty, setDocumentDirty] = useState(false);
  const [preview, setPreview] = useState<ReceivingCsvPreview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [eventId, setEventId] = useState<string | null>(null);
  const [blocked, setBlocked] = useState(false);
  const command = useRef<Command | null>(null);
  const acknowledged = useRef<string | null>(null);
  const generation = useRef(0),
    busy = useRef(false),
    alive = useRef(true);
  const heading = useRef<HTMLHeadingElement>(null);
  const dirty = Boolean(
    file ||
    preview ||
    uncertain ||
    eventId ||
    documentDirty ||
    JSON.stringify(header) !== JSON.stringify(emptyHeader),
  );
  const dirtyCallback = useRef(onDirtyChange);
  dirtyCallback.current = onDirtyChange;
  useEffect(() => {
    const epoch = generation;
    alive.current = true;
    return () => {
      alive.current = false;
      epoch.current++;
      command.current = null;
      acknowledged.current = null;
      dirtyCallback.current(false);
    };
  }, []);
  useEffect(() => {
    dirtyCallback.current(dirty);
  }, [dirty]);
  useEffect(() => {
    heading.current?.focus();
  }, [step, blocked]);
  useEffect(() => {
    if (!dirty) return;
    const protect = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, [dirty]);
  const clearAccess = useCallback(() => {
    generation.current++;
    command.current = null;
    acknowledged.current = null;
    setFile(null);
    setHeader(emptyHeader);
    setDocumentDirty(false);
    setPreview(null);
    setConfirmed(false);
    setUncertain(false);
    setEventId(null);
    setError(null);
    setBlocked(true);
  }, []);
  useEffect(() => {
    if (!canWrite) clearAccess();
  }, [canWrite, clearAccess]);
  const handleForbidden = useCallback(async () => {
    clearAccess();
    await onForbidden();
  }, [clearAccess, onForbidden]);
  const handleSessionLost = useCallback(() => {
    clearAccess();
    onSessionLost();
  }, [clearAccess, onSessionLost]);
  async function authError(value: unknown): Promise<boolean> {
    if (
      !(value instanceof UsClientError) ||
      !["session_required", "forbidden"].includes(value.code)
    )
      return false;
    clearAccess();
    if (value.code === "session_required") onSessionLost();
    else await onForbidden();
    return true;
  }
  const disabled = pending || mutationPending || blocked || !canWrite;
  const current = (run: number) => alive.current && generation.current === run;
  function leave() {
    if (busy.current || mutationPending) return;
    if (
      dirty &&
      !window.confirm(t(uncertain || eventId ? "receiving.leaveUncertain" : "md.discardConfirm"))
    )
      return;
    onDirtyChange(false);
    onClose();
  }
  async function previewFile() {
    if (disabled || busy.current) return;
    if (!file || file.size > 262144) {
      setError("fileError");
      return;
    }
    const capturedFile = file,
      capturedHeader = structuredClone(header);
    const run = ++generation.current;
    busy.current = true;
    setPending(true);
    setError(null);
    const release = beginMutation();
    try {
      const encoded = await fileBase64(capturedFile);
      if (!current(run)) return;
      const input = {
        templateVersion: RECEIVING_CSV_VERSION,
        fileBase64: encoded,
        fileName: capturedFile.name,
        header: capturedHeader,
      };
      if (!receivingCsvPreviewInputSchema.safeParse(input).success) {
        setError("inputError");
        return;
      }
      const saved = await client.previewReceivingCsv(input);
      if (!current(run)) return;
      setPreview(saved);
      setConfirmed(false);
      setStep("review");
    } catch (value) {
      if (current(run) && !(await authError(value))) setError("previewError");
    } finally {
      release();
      busy.current = false;
      if (alive.current) setPending(false);
    }
  }
  async function applyOrRecover() {
    if (
      disabled ||
      busy.current ||
      !preview?.previewDigest ||
      (!confirmed && !uncertain && !eventId)
    )
      return;
    const run = generation.current;
    if (!acknowledged.current && !command.current)
      command.current = {
        id: preview.id,
        body: { operationKey: crypto.randomUUID(), expectedPreviewDigest: preview.previewDigest },
      };
    busy.current = true;
    setPending(true);
    setError(null);
    const release = beginMutation();
    try {
      if (!acknowledged.current) {
        const captured = command.current;
        if (!captured) return;
        const result = await client.applyReceivingCsv(captured.id, captured.body);
        if (!current(run)) return;
        acknowledged.current = result.receipt.eventId;
        command.current = null;
        setUncertain(false);
        setEventId(result.receipt.eventId);
      }
      const id = acknowledged.current;
      if (!id) return;
      const record = await client.getReceivingRecord(id);
      if (current(run)) {
        onDirtyChange(false);
        onOpenRecord(record);
      }
    } catch (value) {
      if (!current(run) || (await authError(value))) return;
      if (acknowledged.current) setError("acknowledged");
      else if (value instanceof UsClientError && value.code === "receiving_csv_preview_expired") {
        command.current = null;
        setUncertain(false);
        setError("expired");
        setConfirmed(false);
      } else if (
        value instanceof UsClientError &&
        ["receiving_csv_preview_stale", "receiving_csv_preview_not_applicable"].includes(value.code)
      ) {
        command.current = null;
        setUncertain(false);
        setError("stale");
        setConfirmed(false);
      } else if (
        value instanceof UsClientError &&
        [
          "receiving_csv_preview_conflict",
          "receiving_operation_conflict",
          "receiving_csv_preview_not_found",
        ].includes(value.code)
      ) {
        command.current = null;
        setUncertain(false);
        setError("conflict");
        setConfirmed(false);
      } else {
        setUncertain(true);
        setError("unknown");
      }
    } finally {
      release();
      busy.current = false;
      if (alive.current) setPending(false);
    }
  }
  const picker = {
    client,
    disabled,
    onForbidden: handleForbidden,
    onSessionLost: handleSessionLost,
  };
  return (
    <div className="us-rec-page us-rec-csv" aria-busy={pending}>
      <header className="us-md-page-header">
        <div>
          <h1 ref={heading} tabIndex={-1}>
            {t("receivingCsv.title")}
          </h1>
          <p>{t("receivingCsv.intro")}</p>
        </div>
        <Button variant="secondary" disabled={pending || mutationPending} onClick={leave}>
          {props.backLabel ?? t("receiving.back")}
        </Button>
      </header>
      {blocked || !canWrite ? (
        <p role="alert">{t("receivingCsv.forbidden")}</p>
      ) : (
        <>
          <ol className="us-rec-csv-steps" aria-label={t("receivingCsv.steps")}>
            {(["input", "review", "confirm"] as const).map((phase, index) => (
              <li key={phase} aria-current={step === phase ? "step" : undefined}>
                <span>{index + 1}</span>
                {t(`receivingCsv.${phase}`)}
              </li>
            ))}
          </ol>
          {error ? (
            <div role="alert" className="us-rec-section">
              {t(`receivingCsv.${error}`)}
            </div>
          ) : null}
          {pending ? <p role="status">{t("receivingCsv.pending")}</p> : null}
          {step === "input" ? (
            <>
              <section className="us-rec-section">
                <h2>{t("receivingCsv.input")}</h2>
                <p>{t("receivingCsv.limit")}</p>
                <p>{t("receivingCsv.columns")}</p>
                <Button variant="secondary" onClick={downloadTemplate} disabled={disabled}>
                  {t("receivingCsv.template")}
                </Button>
                <Input
                  type="file"
                  accept=".csv,text/csv"
                  label={t("receivingCsv.file")}
                  disabled={disabled}
                  onChange={(event) => {
                    setFile(event.target.files?.[0] ?? null);
                    setError(null);
                  }}
                />
                {file ? (
                  <p className="us-rec-csv-literal">
                    {t("receivingCsv.selectedFile", { name: file.name })}
                  </p>
                ) : null}
              </section>
              <section className="us-rec-section">
                <h2>{t("receiving.header")}</h2>
                <p>{t("receiving.zone", { zone: props.timeZone })}</p>
                <fieldset className="us-rec-fields" disabled={disabled}>
                  <Input
                    type="date"
                    label={t("receiving.date")}
                    value={header.dateReceived ?? ""}
                    onChange={(e) => setHeader({ ...header, dateReceived: e.target.value || null })}
                  />
                  <Input
                    label={t("receiving.receivedAtNote")}
                    value={header.receivedAtNote ?? ""}
                    maxLength={2000}
                    onChange={(e) =>
                      setHeader({ ...header, receivedAtNote: e.target.value || null })
                    }
                  />
                  <ReceivingReferencePicker
                    {...picker}
                    kind="location"
                    roles={["receive_at"]}
                    label={t("receiving.location")}
                    value={header.locationId ?? ""}
                    onChange={(id) => setHeader({ ...header, locationId: id || null })}
                  />
                  <ReceivingReferencePicker
                    {...picker}
                    kind="location"
                    label={t("receiving.previousSource")}
                    value={header.previousSourceLocationId ?? ""}
                    onChange={(id) =>
                      setHeader({ ...header, previousSourceLocationId: id || null })
                    }
                  />
                  <Textarea
                    label={t("receiving.notes")}
                    value={header.notes ?? ""}
                    maxLength={2000}
                    onChange={(e) => setHeader({ ...header, notes: e.target.value || null })}
                  />
                </fieldset>
              </section>
              <section className="us-rec-section">
                <h2>{t("receiving.documents")}</h2>
                <ReceivingDocumentSection
                  {...picker}
                  documentIds={header.documentIds}
                  onChange={(documentIds) => setHeader((value) => ({ ...value, documentIds }))}
                  beginMutation={beginMutation}
                  onDirtyChange={setDocumentDirty}
                />
              </section>
              <Button
                disabled={disabled || !file || documentDirty}
                onClick={() => void previewFile()}
              >
                {t("receivingCsv.preview")}
              </Button>
            </>
          ) : preview ? (
            <>
              <section className="us-rec-section">
                <h2>{preview.fileName}</h2>
                <p>{t(preview.proposedDraft ? "receivingCsv.ready" : "receivingCsv.blocked")}</p>
                <p>{t("receivingCsv.draftOnly")}</p>
              </section>
              {step === "review" ? (
                <ReceivingCsvPreviewDetails preview={preview} />
              ) : (
                <section className="us-rec-section">
                  <h2>{t("receivingCsv.confirm")}</h2>
                  <p>{t("receivingCsv.count", { count: preview.rowCount })}</p>
                  <Checkbox
                    className="us-rec-csv-confirm"
                    label={t("receivingCsv.check")}
                    checked={confirmed}
                    disabled={disabled || uncertain || eventId !== null || error !== null}
                    onCheckedChange={setConfirmed}
                  />
                </section>
              )}
              <footer className="us-rec-csv-actions">
                {!uncertain && !eventId ? (
                  <Button
                    variant="secondary"
                    disabled={disabled}
                    onClick={() => {
                      setError(null);
                      setConfirmed(false);
                      if (step === "confirm" && !error) setStep("review");
                      else {
                        setStep("input");
                        setPreview(null);
                      }
                    }}
                  >
                    {t(
                      step === "confirm" && !error
                        ? "receivingCsv.backReview"
                        : "receivingCsv.back",
                    )}
                  </Button>
                ) : null}
                {step === "review" ? (
                  <Button
                    disabled={disabled || !preview.proposedDraft}
                    onClick={() => setStep("confirm")}
                  >
                    {t("receivingCsv.next")}
                  </Button>
                ) : (
                  <Button
                    disabled={
                      disabled ||
                      (!confirmed && !uncertain && !eventId) ||
                      (Boolean(error) && !uncertain && !eventId)
                    }
                    onClick={() => void applyOrRecover()}
                  >
                    {t(
                      eventId
                        ? "receivingCsv.read"
                        : uncertain
                          ? "receivingCsv.retry"
                          : "receivingCsv.create",
                    )}
                  </Button>
                )}
              </footer>
            </>
          ) : null}
        </>
      )}
    </div>
  );
}
