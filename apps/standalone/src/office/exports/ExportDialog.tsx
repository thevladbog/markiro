import { shiftExportFormatRequiresPallets } from "@markiro/domain";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, Checkbox, Input, Modal, RadioGroup } from "@markiro/ui";

import {
  isSupportedHistoryTimeZone,
  requireHistoryTimeZone,
  UnsupportedHistoryTimeZoneError,
} from "../import/history-time-zone.js";
import { historyFailure } from "../import/history-errors.js";
import { errorMessageKey } from "../../host/errors.js";
import type { OfficeShift, ShiftExportRecord } from "../../host/protocol.js";
import type { ConflictQuery } from "../../host/review.js";
import { shiftExportRecord } from "../../host/requests.js";
import { isKnownTimeZone } from "../../lib/civil-date.js";
import { DEMO_FILE_PREFIX, isGismtFormat } from "../demo/demo.js";
import { officeKeys, useOfficeMutation, useOfficeQuery } from "../office-query.js";
import { useOfficeSession } from "../office-session.js";
import { LoadError, PageLoading } from "../page-state.js";
import { civilDateLabel } from "../shifts/shift-list.js";
import {
  conflictWarnings,
  exportFolder,
  reportedCountWarnings,
  type ExportWarning,
} from "./export-checks.js";
import { useExportPlan, yieldToUi } from "./export-plan.js";
import { OfficeFilesError, type SavedFolder } from "./office-files.js";
import { storeExportFiles } from "./stored-files.js";
import { useRefreshStoredFiles } from "./use-refresh-files.js";
import { useOfficeFiles } from "./office-files-context.js";
import { runExport } from "./run-export.js";

const MIN_LINES = 2;
const MAX_LINES = 1_000_000;
/** The cloud's default lines a part (`ShiftExportsDialog`). */
const DEFAULT_LINES = "2000";

/** A whole number of lines in 2–1 000 000, as the domain takes it; `null` otherwise. */
function parseLineLimit(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return parsed >= MIN_LINES && parsed <= MAX_LINES ? parsed : null;
}

const formatKey = (format: { id: string; version: number }) => `${format.id}@${format.version}`;

/** Where an export is: the first two can still be called off, the rest cannot. */
type Phase = "idle" | "reading" | "forming" | "saving" | "recording";

/** What became of the host's own copy of the files (host migration `0029`). */
type HostCopy = { kind: "stored" } | { kind: "failed"; message: string };

type Outcome =
  | { kind: "failed"; message: string; reason?: string }
  | { kind: "cancelled" }
  | {
      kind: "saved";
      /** The folder the shell wrote, or `null` when it could not and only the host holds the files. */
      saved: SavedFolder | null;
      /** Why the folder has no files (the words), when `saved` is `null`. */
      folderFailure: string | null;
      hostCopy: HostCopy;
      /** The record the host has not taken, with why; `null` once it is written. */
      unrecorded: { record: ShiftExportRecord; message: string } | null;
    };

export interface ExportDialogProps {
  /** An active or closed shift. */
  shift: Pick<OfficeShift, "id" | "number" | "mode">;
  sourceKind?: "native" | "cloud";
  /**
   * Only this pallet's ЧЗ document (plan КРТ, the pallet's card): the dialog
   * shows its row and its «XML паллеты», not the shift's formats.
   */
  palletId?: string;
  /**
   * A demo shift (spec 2026-10-21, decision Д1): no format for ГИС МТ and no pallet's document;
   * its TXT and CSV files are named `DEMO_…`.
   */
  demo?: boolean;
  onClose: () => void;
}

/**
 * «Выгрузка» of a shift (plan ЧЗ): the cloud's formats with what the source
 * would refuse now, the line limit, the warnings, and the pallets of the
 * shift for a ЧЗ document each. Forming reads the host's rows again, renders
 * with `@markiro/domain` exactly as the cloud does (`runExport`), saves the
 * parts into a new folder under «Документы\Markiro\Выгрузки» and only then
 * records the export in the host's audit trail; a record the host did not
 * take is said, with «Записать снова», and the saved files stay.
 *
 * A shift can hold 200 000 codes, so the dialog works in turns: the formats
 * are checked one a turn (`useExportPlan`), and forming gives the event loop
 * back before it renders and again before it hands the files to the shell, so
 * the words that say what is going on are on the screen first. Until the
 * files are being saved an export can be called off (the button, or Escape);
 * from then on nothing closes the dialog and nothing starts another export.
 * What the dialog says it does goes into one polite region, where the focus
 * goes when an export starts; the focus then goes to its result.
 */
export function ExportDialog({
  shift,
  palletId,
  demo = false,
  onClose,
  sourceKind = "native",
}: ExportDialogProps) {
  const { t } = useTranslation();
  const formId = useId();
  const progressId = useId();
  const outcomeId = useId();
  const files = useOfficeFiles();
  const session = useOfficeSession();
  const queryClient = useQueryClient();
  const refreshFiles = useRefreshStoredFiles();
  const sourceKey =
    sourceKind === "cloud"
      ? officeKeys.cloudExportSource(shift.id)
      : officeKeys.shiftExportSource(shift.id);
  const source = useOfficeQuery(sourceKey, (api, token) =>
    sourceKind === "cloud"
      ? api.getCloudShiftExportSource(token, shift.id)
      : api.getShiftExportSource(token, shift.id),
  );
  const org = useOfficeQuery(officeKeys.org, (api, token) => api.getOrg(token));
  const rows = source.data;
  // The host's own count of a pallet's boxes against the station's: information, so a list that
  // does not load leaves the dialog whole and the warning out.
  const palletList = useOfficeQuery(
    officeKeys.shiftPallets(shift.id),
    (api, token) => api.listShiftPallets(token, shift.id),
    { enabled: sourceKind === "native" && rows?.shift.palletsEnabled === true },
  );
  // The shift's unreviewed conflicts (plan КНФ): information, so a list that does not load
  // leaves the dialog whole and the warning out (ПР-12: never a refusal).
  const conflictQuery: ConflictQuery = { shiftId: shift.id, reviewed: false, page: 1 };
  const unreviewed = useOfficeQuery(officeKeys.conflictList(conflictQuery), (api, token) =>
    api.listConflicts(token, conflictQuery),
  );
  const plan = useExportPlan(rows, shift.mode);
  const record = useOfficeMutation((api, token, body: ShiftExportRecord) =>
    api.recordShiftExport(token, shift.id, body),
  );
  const [chosen, setChosen] = useState<string | null>(null);
  const [split, setSplit] = useState(false);
  const [lineLimit, setLineLimit] = useState(DEFAULT_LINES);
  const [phase, setPhase] = useState<Phase>("idle");
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [openFailure, setOpenFailure] = useState<string | null>(null);
  const inFlight = useRef(false);
  const calledOff = useRef(false);
  const wake = useRef<(() => void) | null>(null);

  // The rows of a shift of 200 000 codes are tens of megabytes: they do not stay in the cache
  // once the dialog is gone, and the next opening reads them again.
  useEffect(() => {
    const key =
      sourceKind === "cloud"
        ? officeKeys.cloudExportSource(shift.id)
        : officeKeys.shiftExportSource(shift.id);
    return () => queryClient.removeQueries({ queryKey: key });
  }, [queryClient, shift.id, sourceKind]);

  // The time zone of the organization, this PC's while its profile is unread or names a zone
  // this PC lacks: it names the folder, and writes the time of late data.
  const nativeTimeZone =
    org.data !== undefined && isKnownTimeZone(org.data.timeZone)
      ? org.data.timeZone
      : Intl.DateTimeFormat().resolvedOptions().timeZone;
  const sourceZoneSupported =
    sourceKind !== "cloud" || isSupportedHistoryTimeZone(rows?.organization.timeZone);
  const reportTimeZone = () =>
    sourceKind === "cloud" ? requireHistoryTimeZone(rows?.organization.timeZone) : nativeTimeZone;

  const checks = (plan.status === "ready" ? plan.plan.checks : []).filter(
    (check) => !demo || !isGismtFormat(check.format.id),
  );
  // A pallet's own dialog (plan КРТ) lists that pallet only; a demo shift's pallets get no ЧЗ
  // document.
  const pallets =
    plan.status === "ready" && !demo
      ? plan.plan.pallets.filter((pallet) => palletId === undefined || pallet.palletId === palletId)
      : [];
  const firstAllowed = checks.find((check) => check.refusal === null);
  const selected =
    checks.find((check) => formatKey(check.format) === chosen && check.refusal === null) ??
    firstAllowed;
  const warnings: ExportWarning[] =
    selected === undefined || palletId !== undefined
      ? []
      : [
          ...selected.warnings,
          ...conflictWarnings(unreviewed.data?.total ?? 0),
          ...(shiftExportFormatRequiresPallets(selected.format) && palletList.data !== undefined
            ? reportedCountWarnings(palletList.data)
            : []),
        ];
  const maxLines = split ? parseLineLimit(lineLimit) : null;
  const lineLimitError =
    split && maxLines === null ? t("office.exports.lineLimitError") : undefined;
  const busy = phase !== "idle";
  const cancelable = phase === "reading" || phase === "forming";

  // The focus goes to what an export ended with, as after a write on the other pages.
  useEffect(() => {
    if (outcome !== null) document.getElementById(outcomeId)?.focus();
  }, [outcome, outcomeId]);

  /** Calls the export off: at once while its rows are read, at the next turn while it forms. */
  const cancel = () => {
    calledOff.current = true;
    wake.current?.();
  };

  const close = () => {
    if (cancelable) cancel();
    else if (!inFlight.current) onClose();
  };

  async function exportNow(
    format: { id: string; version: number },
    lines: number | null,
    palletId: string | null,
  ): Promise<void> {
    if (inFlight.current) return;
    inFlight.current = true;
    calledOff.current = false;
    setOutcome(null);
    setOpenFailure(null);
    setPhase("reading");
    document.getElementById(progressId)?.focus();
    try {
      // Formed of the host's rows of this moment, as the cloud reads its source when it runs.
      // Read here and not through the cache: a mutation would keep tens of megabytes.
      const calledOffWhileReading = new Promise<null>((resolve) => {
        wake.current = () => resolve(null);
      });
      let fresh;
      try {
        fresh = await Promise.race([
          session.call((token) =>
            sourceKind === "cloud"
              ? session.api.getCloudShiftExportSource(token, shift.id)
              : session.api.getShiftExportSource(token, shift.id),
          ),
          calledOffWhileReading,
        ]);
      } catch (error) {
        setOutcome({
          kind: "failed",
          message: sourceKind === "cloud" ? historyFailure(t, error) : t(errorMessageKey(error)),
        });
        return;
      } finally {
        wake.current = null;
      }
      if (fresh === null || calledOff.current) {
        setOutcome({ kind: "cancelled" });
        return;
      }
      const originalZone =
        sourceKind === "cloud"
          ? requireHistoryTimeZone(fresh.organization.timeZone)
          : nativeTimeZone;
      setPhase("forming");
      await yieldToUi();
      const formedAt = new Date().toISOString();
      const documentId = crypto.randomUUID();
      const result = runExport(fresh, {
        formatId: format.id,
        formatVersion: format.version,
        maxLines: lines,
        palletId,
        documentId,
        formedAt,
      });
      // A click that came while it formed is handled in this turn, before anything is saved.
      await yieldToUi();
      if (calledOff.current) {
        setOutcome({ kind: "cancelled" });
        return;
      }
      if (!result.ok) {
        setOutcome({
          kind: "failed",
          message: t(`office.exports.failures.${result.failure}`),
          ...("reason" in result ? { reason: result.reason } : {}),
        });
        return;
      }
      setPhase("saving");
      // A demo shift's files say so in their names (decision Д1).
      const parts = demo
        ? result.parts.map((part) => ({ ...part, filename: `${DEMO_FILE_PREFIX}${part.filename}` }))
        : result.parts;
      // The host keeps the exact bytes first: whatever happens to the folder on this PC, the
      // file stays downloadable from the shift's drawer. A host that cannot keep them (its store
      // is full, it does not answer) never stops the export: the folder copy is made all the same.
      const stored = await storeExportFiles(session, {
        kind: palletId === null ? "shift_export" : "pallet_export",
        targetType: palletId === null ? "shift" : "pallet",
        targetId: palletId ?? shift.id,
        batchId: documentId,
        formatId: format.id,
        formatVersion: format.version,
        parts: parts.map((part, index) => ({
          partNo: index + 1,
          name: part.filename,
          bytes: part.bytes,
        })),
      });
      refreshFiles();
      const hostCopy: HostCopy = stored.ok
        ? { kind: "stored" }
        : { kind: "failed", message: t(stored.messageKey) };
      let saved: SavedFolder | null = null;
      let folderFailure: string | null = null;
      try {
        saved = await files.save(
          exportFolder(fresh.shift.number, format.id, formedAt, originalZone),
          parts.map((part) => ({ name: part.filename, bytes: part.bytes })),
        );
      } catch (error) {
        const code = error instanceof OfficeFilesError ? error.code : "storage";
        folderFailure = t(`office.exports.files.${code}`);
      }
      if (saved === null && !stored.ok) {
        // Neither the host nor the folder has the files: nothing is recorded.
        setOutcome({ kind: "failed", message: folderFailure ?? t("office.exports.files.storage") });
        return;
      }
      const body = shiftExportRecord({
        formatId: format.id,
        formatVersion: format.version,
        maxLines: lines,
        palletId,
        documentId,
        parts,
        openPalletSuppressedBoxCount: result.openPalletSuppressedBoxCount,
      });
      await writeRecord(saved, folderFailure, hostCopy, body);
    } catch (error) {
      // Nothing above is meant to throw; if it does, the dialog says so instead of going quiet.
      setOutcome({
        kind: "failed",
        message:
          error instanceof UnsupportedHistoryTimeZoneError
            ? historyFailure(t, error)
            : t("office.exports.failures.GENERATION_FAILED"),
        ...(error instanceof UnsupportedHistoryTimeZoneError
          ? {}
          : { reason: error instanceof Error && error.name !== "" ? error.name : "Error" }),
      });
    } finally {
      inFlight.current = false;
      setPhase("idle");
    }
  }

  /** Writes the journal's row of files already saved; a refusal leaves the same row to write again. */
  async function writeRecord(
    saved: SavedFolder | null,
    folderFailure: string | null,
    hostCopy: HostCopy,
    body: ShiftExportRecord,
  ): Promise<void> {
    setPhase("recording");
    try {
      await record.mutateAsync(body);
      setOutcome({ kind: "saved", saved, folderFailure, hostCopy, unrecorded: null });
    } catch (error) {
      setOutcome({
        kind: "saved",
        saved,
        folderFailure,
        hostCopy,
        unrecorded: { record: body, message: t(errorMessageKey(error)) },
      });
    }
  }

  async function recordAgain(
    done: Extract<Outcome, { kind: "saved" }>,
    body: ShiftExportRecord,
  ): Promise<void> {
    if (inFlight.current) return;
    inFlight.current = true;
    document.getElementById(progressId)?.focus();
    try {
      await writeRecord(done.saved, done.folderFailure, done.hostCopy, body);
    } finally {
      inFlight.current = false;
      setPhase("idle");
    }
  }

  async function openFolder(saved: SavedFolder): Promise<void> {
    setOpenFailure(null);
    try {
      await files.open(saved.segments);
    } catch (error) {
      const code = error instanceof OfficeFilesError ? error.code : "storage";
      setOpenFailure(t(`office.exports.files.${code}`));
    }
  }

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (selected === undefined || lineLimitError !== undefined || !sourceZoneSupported) return;
    void exportNow(selected.format, maxLines, null);
  };

  const warningText = (warning: ExportWarning): string => {
    switch (warning.kind) {
      case "late_data":
        return t("office.exports.warnings.late_data", {
          at: new Date(warning.at).toLocaleString("ru", { timeZone: reportTimeZone() }),
        });
      case "open_pallets":
        return t("office.exports.warnings.open_pallets", { count: warning.boxes });
      case "disassembled_pallets":
        return t("office.exports.warnings.disassembled_pallets", { count: warning.pallets });
      case "late_boxes":
        return t("office.exports.warnings.late_boxes", { count: warning.boxes });
      case "pallet_count_mismatch":
        return t("office.exports.warnings.pallet_count_mismatch", { count: warning.pallets });
      case "unreviewed_conflicts":
        return t("office.exports.warnings.unreviewed_conflicts", { count: warning.conflicts });
    }
  };

  const progressText = (): string => {
    switch (phase) {
      case "reading":
        return t("office.exports.reading");
      case "forming":
        return t("office.exports.forming");
      case "saving":
        return t("office.exports.saving");
      case "recording":
        return t("office.exports.recording");
      case "idle":
        return plan.status === "working" && rows !== undefined
          ? t("office.exports.checking", { done: plan.done, total: plan.total })
          : "";
    }
  };

  /** The alert the focus goes to: the last thing the export said. */
  const outcomeAlerts = () => {
    if (outcome === null) return null;
    if (outcome.kind === "cancelled") {
      return (
        <Alert tone="info" id={outcomeId} tabIndex={-1}>
          {t("office.exports.cancelled")}
        </Alert>
      );
    }
    if (outcome.kind === "failed") {
      return (
        <Alert tone="error" id={outcomeId} tabIndex={-1}>
          {outcome.message}
          {outcome.reason !== undefined && (
            <span className="shift-cell__quiet">
              {t("office.exports.reason", { reason: outcome.reason })}
            </span>
          )}
        </Alert>
      );
    }
    const unrecorded = outcome.unrecorded;
    const folder = outcome.saved;
    return (
      <>
        {folder !== null ? (
          <Alert
            tone="ok"
            role="status"
            {...(unrecorded === null ? { id: outcomeId, tabIndex: -1 } : {})}
            action={
              <Button variant="secondary" size="compact" onClick={() => void openFolder(folder)}>
                {t("office.exports.openFolder")}
              </Button>
            }
          >
            {t("office.exports.saved", {
              count: folder.files.length,
              path: folder.path,
            })}
          </Alert>
        ) : (
          <Alert
            tone="warn"
            role="status"
            {...(unrecorded === null ? { id: outcomeId, tabIndex: -1 } : {})}
          >
            {outcome.folderFailure} {t("office.exports.heldByHost")}
          </Alert>
        )}
        {outcome.hostCopy.kind === "failed" && (
          <Alert tone="warn" role="status">
            {t("office.storedFiles.hostCopyFailed", { reason: outcome.hostCopy.message })}
          </Alert>
        )}
        {unrecorded !== null && (
          <Alert
            tone="warn"
            id={outcomeId}
            tabIndex={-1}
            action={
              <Button
                variant="secondary"
                size="compact"
                disabled={busy}
                onClick={() => void recordAgain(outcome, unrecorded.record)}
              >
                {t("office.exports.recordAgain")}
              </Button>
            }
          >
            {t("office.exports.recordFailed", { reason: unrecorded.message })}
          </Alert>
        )}
      </>
    );
  };

  const content = () => {
    if (source.isPending || org.isPending) return <PageLoading />;
    if (source.isError || rows === undefined) {
      return sourceKind === "cloud" ? (
        <Alert
          tone="error"
          action={
            <Button variant="secondary" onClick={() => void source.refetch()}>
              {t("office.common.retry")}
            </Button>
          }
        >
          {historyFailure(t, source.error)}
        </Alert>
      ) : (
        <LoadError error={source.error} onRetry={() => void source.refetch()} />
      );
    }
    if (!sourceZoneSupported)
      return (
        <Alert tone="error">{t("office.cloudHistory.errors.history_time_zone_unsupported")}</Alert>
      );
    return (
      <>
        <p>
          {t("office.exports.summary", {
            product: rows.shift.productName,
            date: civilDateLabel(rows.shift.productionDate),
          })}
        </p>
        {plan.status === "ready" && (
          <p className="office-note">
            {t("office.exports.counts", {
              codes: plan.plan.counts.codes,
              inClosedBoxes: plan.plan.counts.codesInClosedBoxes,
              boxes: plan.plan.counts.closedBoxes,
              pallets: plan.plan.counts.closedPallets,
            })}
          </p>
        )}
        <div id={progressId} role="status" tabIndex={-1} className="office-note">
          {progressText()}
        </div>
        {cancelable && (
          <div>
            <Button variant="secondary" size="compact" onClick={cancel}>
              {t("office.exports.cancel")}
            </Button>
          </div>
        )}
        {plan.status === "failed" && (
          <Alert tone="error">
            {t("office.exports.checkFailed")}
            <span className="shift-cell__quiet">
              {t("office.exports.reason", { reason: plan.reason })}
            </span>
          </Alert>
        )}
        {outcomeAlerts()}
        {openFailure !== null && <Alert tone="error">{openFailure}</Alert>}
        {demo && <Alert tone="info">{t("office.demo.exportsNote")}</Alert>}
        {/* Heard once, by this region: its messages are not alerts of their own (`role="presentation"`). */}
        <div aria-live="polite">
          {warnings.map((warning) => (
            <Alert key={warning.kind} tone="warn" role="presentation">
              {warningText(warning)}
            </Alert>
          ))}
        </div>
        {plan.status === "ready" && (
          <>
            {palletId === undefined && (
              <>
                <div className="export-formats">
                  <RadioGroup
                    label={t("office.exports.formats")}
                    name="shift-export-format"
                    disabled={busy}
                    value={selected === undefined ? "" : formatKey(selected.format)}
                    onValueChange={setChosen}
                    options={checks.map((check) => ({
                      value: formatKey(check.format),
                      disabled: check.refusal !== null,
                      label:
                        check.refusal === null ? (
                          check.format.label
                        ) : (
                          <span className="shift-cell">
                            <span>{check.format.label}</span>
                            <span className="shift-cell__quiet">
                              {t(`office.exports.failures.${check.refusal}`)}
                            </span>
                          </span>
                        ),
                    }))}
                  />
                </div>
                <Checkbox
                  label={t("office.exports.split")}
                  checked={split}
                  disabled={busy}
                  onCheckedChange={setSplit}
                />
                {split && (
                  <Input
                    label={t("office.exports.lineLimit")}
                    inputMode="numeric"
                    value={lineLimit}
                    disabled={busy}
                    {...(lineLimitError === undefined ? {} : { error: lineLimitError })}
                    onChange={(event) => setLineLimit(event.target.value)}
                  />
                )}
              </>
            )}
            <Alert tone="info">{t("office.exports.folderHint")}</Alert>
            {palletId !== undefined && pallets.length === 0 && (
              <Alert tone="warn">{t("office.exports.palletUnavailable")}</Alert>
            )}
            {pallets.length > 0 && (
              <section aria-label={t("office.exports.pallets")}>
                <p>{t("office.exports.pallets")}</p>
                {pallets.map((pallet) => (
                  <div key={pallet.palletId} className="shift-cell">
                    <span>
                      {pallet.sscc === null
                        ? t("office.exports.palletOpen", { boxes: pallet.boxes })
                        : t("office.exports.palletRow", {
                            sscc: pallet.sscc,
                            boxes: pallet.boxes,
                          })}
                    </span>
                    {pallet.refusal !== null && (
                      <span className="shift-cell__quiet">
                        {t(`office.exports.failures.${pallet.refusal}`)}
                      </span>
                    )}
                    {pallet.warnings.map((warning) =>
                      warning.kind === "late_boxes" ? (
                        <span key={warning.kind} className="shift-cell__quiet">
                          {t("office.exports.palletLate", { count: warning.boxes })}
                        </span>
                      ) : null,
                    )}
                    <Button
                      variant="secondary"
                      size="compact"
                      disabled={busy || pallet.refusal !== null}
                      aria-label={t("office.exports.palletExportNamed", {
                        sscc: pallet.sscc ?? "—",
                      })}
                      onClick={() =>
                        void exportNow(
                          { id: "pallet_xml_gismt_aggregation", version: 1 },
                          null,
                          pallet.palletId,
                        )
                      }
                    >
                      {t("office.exports.palletExport")}
                    </Button>
                  </div>
                ))}
              </section>
            )}
          </>
        )}
      </>
    );
  };

  return (
    <Modal
      open
      title={
        palletId === undefined
          ? t("office.exports.title", { number: shift.number })
          : t("office.exports.palletTitle", { sscc: pallets[0]?.sscc ?? "—" })
      }
      onClose={close}
      closeLabel={t("office.common.close")}
      width="min(760px, calc(100vw - 32px))"
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={busy}>
            {t("office.common.close")}
          </Button>
          {palletId === undefined && (
            <Button
              type="submit"
              form={formId}
              loading={busy}
              disabled={
                selected === undefined || lineLimitError !== undefined || !sourceZoneSupported
              }
            >
              {t("office.exports.submit")}
            </Button>
          )}
        </>
      }
    >
      <form id={formId} className="standalone-form" onSubmit={submit} noValidate aria-busy={busy}>
        {content()}
      </form>
    </Modal>
  );
}
