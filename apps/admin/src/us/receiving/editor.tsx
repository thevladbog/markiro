import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Button, DataTabs, Input, Textarea } from "@markiro/ui";
import {
  receivingDraftSchema,
  receivingAmendmentDraftSchema,
  receivingLiveRecordSchema,
  type ReceivingAmendmentDraft,
  type ReceivingDraft,
  type ReceivingLiveRecord,
  type ReceivingFinalizeResult,
  type ReceivingCommandResult,
} from "@markiro/platform-contracts";
import { useTranslation } from "react-i18next";
import { UsClientError, UsReceivingLifecycleError } from "../client.js";
import type { MasterDataViewProps } from "../master-data/workspace-shared.js";
import { ReceivingReferencePicker } from "./reference-picker.js";
import { ReceivingDocumentSection } from "./document-section.js";
import { ReceivingLineEditor, emptyReceivingLine } from "./line-editor.js";
import { ReceivingReadinessPanel } from "./readiness-panel.js";
import {
  isReceivingDraftView,
  type ReceivingDraftView,
  type ReceivingFrozenView,
} from "./live-record.js";
import { ReceivingAmendmentComparison } from "./amendment-comparison.js";
import { ReceivingRetainedLineEditor } from "./retained-line-editor.js";
import { ReceivingLifecycleNotice } from "./lifecycle-notice.js";
import { ReceivingLifecycleActions } from "./lifecycle-dialog.js";
import { ReceivingRevisionNavigation } from "./revision-history.js";
import { ReceivingConflictDetails } from "./conflict-details.js";

const emptyDraft: ReceivingDraft = {
  dateReceived: null,
  locationId: null,
  previousSourceLocationId: null,
  receivedAtNote: null,
  notes: null,
  items: [],
  documentIds: [],
};
type EditableDraft = Omit<ReceivingDraft, "items"> & {
  items: Array<ReceivingDraft["items"][number] | ReceivingAmendmentDraft["items"][number]>;
};
type Command = {
  id: string | null;
  operationKey: string;
  expectedDraftVersion: number | null;
  draft: ReceivingDraft;
  captured: ReceivingLiveRecord | null;
};
type Props = MasterDataViewProps & {
  initial: ReceivingDraftView | null;
  timeZone: string;
  onClose: () => void;
  backLabel?: string;
  canManageQa?: boolean;
  onOpenRecord?: (record: ReceivingLiveRecord) => void;
  predecessor?: ReceivingFrozenView;
};
const fieldKeys: Record<string, string> = {
  dateReceived: "date",
  locationId: "location",
  previousSourceLocationId: "previousSource",
  receivedAtNote: "receivedAtNote",
  notes: "notes",
  productId: "product",
  lotId: "lot",
  tlc: "tlc",
  quantity: "quantity",
  unitOfMeasure: "unit",
  source: "sourceKind",
  exemptReason: "exemptReason",
  supplierLotReference: "supplierLot",
  documentIds: "documents",
};

export function ReceivingEditor({
  initial,
  timeZone,
  client,
  canWrite: receivingWrite,
  mutationPending,
  beginMutation,
  onDirtyChange,
  onForbidden,
  onSessionLost,
  onClose,
  backLabel,
  canManageQa = false,
  onOpenRecord,
  predecessor,
}: Props) {
  const { t, i18n } = useTranslation();
  const [record, setRecord] = useState(initial);
  const isAmendment = record !== null && record.lifecycle.previousRevisionId !== null;
  const canWrite =
    record?.status === "void"
      ? false
      : isAmendment
        ? canManageQa && predecessor !== undefined
        : receivingWrite;
  const panelId = useId();
  const [pane, setPane] = useState<"draft" | "previous">("draft");
  const [draft, setDraft] = useState<EditableDraft>(initial?.content.draft ?? emptyDraft);
  const [lineKeys, setLineKeys] = useState(() =>
    (initial?.content.draft.items ?? []).map(() => crypto.randomUUID()),
  );
  const [activeLine, setActiveLine] = useState(0);
  const [documentDirty, setDocumentDirty] = useState(false);
  const [readinessGeneration, setReadinessGeneration] = useState(0);
  const [pending, setPending] = useState(false);
  const [finalizationLocked, setFinalizationLocked] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [conflictDetail, setConflictDetail] = useState<UsReceivingLifecycleError["detail"] | null>(
    null,
  );
  const [saved, setSaved] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [resolvedReceivingLocation, setResolvedReceivingLocation] = useState<{
    id: string;
    label: string;
  } | null>(null);
  const receivingLocationLabel =
    resolvedReceivingLocation?.id === draft.locationId ? resolvedReceivingLocation.label : "";
  const [issues, setIssues] = useState<{ key: string; line: number | null }[]>([]);
  const command = useRef<Command | null>(null);
  const acknowledgedEventId = useRef<{ eventId: string; result: ReceivingCommandResult } | null>(
    null,
  );
  const busy = useRef(false);
  const alive = useRef(true);
  const heading = useRef<HTMLHeadingElement>(null);
  const alert = useRef<HTMLDivElement>(null);
  const dirty =
    JSON.stringify(draft) !== JSON.stringify(record?.content.draft ?? emptyDraft) || documentDirty;
  const recovering = acknowledgedEventId.current !== null;
  const disabled =
    !canWrite || pending || mutationPending || uncertain || blocked || finalizationLocked;
  const currentLine = draft.items[activeLine];
  const documentChanged = useCallback((next: boolean) => {
    setDocumentDirty(next);
    if (next) setReadinessGeneration((value) => value + 1);
  }, []);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    heading.current?.focus();
  }, [record?.id]);
  useEffect(
    () => onDirtyChange(dirty || uncertain || recovering || finalizationLocked),
    [dirty, uncertain, recovering, finalizationLocked, onDirtyChange],
  );
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  useEffect(() => {
    if (failure && !pending) alert.current?.focus();
  }, [failure, pending]);
  useEffect(() => {
    let current = true;
    const id = draft.locationId;
    if (!id) {
      setResolvedReceivingLocation(null);
      return () => {
        current = false;
      };
    }
    void client
      .getLocation(id)
      .then((location) => {
        if (current) setResolvedReceivingLocation({ id, label: location.name });
      })
      .catch(async (error: unknown) => {
        if (!current) return;
        setResolvedReceivingLocation(null);
        if (error instanceof UsClientError && error.code === "session_required") onSessionLost();
        if (error instanceof UsClientError && error.code === "forbidden") await onForbidden();
      });
    return () => {
      current = false;
    };
  }, [client, draft.locationId, onForbidden, onSessionLost]);
  useEffect(() => {
    if (!dirty && !pending && !uncertain && !recovering && !finalizationLocked) return;
    const protect = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, [dirty, pending, uncertain, recovering, finalizationLocked]);

  function change(next: EditableDraft) {
    setReadinessGeneration((value) => value + 1);
    setDraft(next);
    setSaved(false);
    setIssues([]);
  }
  function canLeave() {
    if (busy.current || mutationPending || finalizationLocked) return false;
    if (
      (dirty || uncertain || recovering) &&
      !window.confirm(t(uncertain || recovering ? "receiving.leaveUncertain" : "md.discardConfirm"))
    )
      return false;
    return true;
  }
  function close() {
    if (canLeave()) onClose();
  }
  function acceptCurrent(result: ReceivingLiveRecord) {
    if (
      !isReceivingDraftView(result) ||
      result.status !== "draft" ||
      (record !== null && result.id !== record.id)
    ) {
      onOpenRecord?.(result);
      return;
    }
    setRecord(result);
    setDraft(result.content.draft);
    setLineKeys(result.content.draft.items.map(() => crypto.randomUUID()));
    setActiveLine((line) => Math.min(line, Math.max(0, result.content.draft.items.length - 1)));
    setBlocked(false);
    setUncertain(false);
    setFailure(null);
    setIssues([]);
    setConflictDetail(null);
    command.current = null;
    acknowledgedEventId.current = null;
  }
  async function recoverAcknowledgement() {
    const id = acknowledgedEventId.current?.eventId;
    if (!id || busy.current || mutationPending) return;
    return readAcknowledged(id);
  }
  async function finalizedAcknowledgement(result: ReceivingFinalizeResult) {
    if (!alive.current) return;
    const id = "receiptVersion" in result ? result.eventId : result.id;
    acknowledgedEventId.current = { eventId: id, result };
    setBlocked(true);
    setUncertain(false);
    setReadinessGeneration((value) => value + 1);
    return readAcknowledged(id);
  }
  async function readAcknowledged(id: string) {
    busy.current = true;
    setPending(true);
    const release = beginMutation();
    try {
      const result = await client.getReceivingRecord(id);
      if (alive.current) {
        acceptCurrent(result);
        setSaved(true);
      }
    } catch (error) {
      if (!alive.current) return;
      setFailure("currentUnavailable");
      if (error instanceof UsClientError && error.code === "session_required") onSessionLost();
      if (error instanceof UsClientError && error.code === "forbidden") await onForbidden();
    } finally {
      busy.current = false;
      if (alive.current) setPending(false);
      release();
    }
  }
  async function reload() {
    if (acknowledgedEventId.current) return recoverAcknowledgement();
    if (!record || busy.current || mutationPending) return;
    if ((dirty || uncertain) && !window.confirm(t("receiving.reloadConfirm"))) return;
    setReadinessGeneration((value) => value + 1);
    // Once recovery starts, only a successful current-record read may reopen editing/checking.
    setBlocked(true);
    busy.current = true;
    setPending(true);
    const release = beginMutation();
    try {
      const result = await client.getReceivingRecord(record.id);
      if (!alive.current) return;
      acceptCurrent(result);
      setSaved(false);
    } catch (error) {
      if (!alive.current) return;
      setFailure("reloadError");
      if (error instanceof UsClientError && error.code === "session_required") onSessionLost();
      if (error instanceof UsClientError && error.code === "forbidden") await onForbidden();
    } finally {
      busy.current = false;
      if (alive.current) setPending(false);
      release();
    }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (
      busy.current ||
      mutationPending ||
      !canWrite ||
      blocked ||
      documentDirty ||
      finalizationLocked
    )
      return;
    if (!command.current) {
      const parsed = (isAmendment ? receivingAmendmentDraftSchema : receivingDraftSchema).safeParse(
        draft,
      );
      if (!parsed.success) {
        setFailure("invalid");
        setIssues(
          parsed.error.issues.map((issue) => {
            const item = issue.path[0] === "items";
            return {
              key: fieldKeys[String(issue.path[item ? 2 : 0])] ?? "lines",
              line: item && typeof issue.path[1] === "number" ? issue.path[1] + 1 : null,
            };
          }),
        );
        return;
      }
      // Freeze a validated command before sending. An uncertain outcome reuses its exact key/body.
      command.current = {
        id: record?.id ?? null,
        operationKey: crypto.randomUUID(),
        expectedDraftVersion: record?.draftVersion ?? null,
        draft: parsed.data,
        captured: isAmendment && record ? receivingLiveRecordSchema.parse(record) : null,
      };
    }
    const attempt = command.current;
    setReadinessGeneration((value) => value + 1);
    busy.current = true;
    setPending(true);
    setFailure(null);
    setSaved(false);
    const release = beginMutation();
    try {
      const input = { operationKey: attempt.operationKey, draft: attempt.draft };
      const receipt =
        attempt.id === null
          ? await client.createReceivingDraft(input)
          : attempt.captured
            ? await client.saveReceivingDraft(
                attempt.id,
                {
                  ...input,
                  commandVersion: 2,
                  expectedLifecycleVersion: attempt.captured.lifecycle.lifecycleVersion,
                  expectedDraftVersion: attempt.expectedDraftVersion,
                },
                attempt.captured,
              )
            : await client.saveReceivingDraft(attempt.id, {
                ...input,
                expectedDraftVersion: attempt.expectedDraftVersion,
              });
      if (!alive.current) return;
      // A replayed create/save receipt is historical. Read current lifecycle before reopening editing.
      acknowledgedEventId.current = {
        eventId: "receiptVersion" in receipt ? receipt.eventId : receipt.id,
        result: receipt,
      };
      setUncertain(false);
      setBlocked(true);
      const result = await client.getReceivingRecord(acknowledgedEventId.current.eventId);
      if (!alive.current) return;
      acceptCurrent(result);
      setSaved(true);
    } catch (error) {
      if (!alive.current) return;
      const code = error instanceof UsClientError ? error.code : "unavailable";
      if (code === "session_required") {
        onSessionLost();
        return;
      }
      if (acknowledgedEventId.current) {
        setFailure("currentUnavailable");
        setBlocked(true);
        setUncertain(false);
        if (code === "forbidden") await onForbidden();
        return;
      }
      if (code === "forbidden") {
        setFailure("denied");
        // Keep an earlier uncertain command, even while current permissions are being reloaded.
        if (!uncertain) command.current = null;
        await onForbidden();
      } else if (error instanceof UsReceivingLifecycleError) {
        setConflictDetail(error.detail);
        command.current = null;
        setUncertain(false);
        setBlocked(true);
        setFailure("conflict");
      } else if (
        [
          "receiving_draft_conflict",
          "receiving_already_finalized",
          "receiving_operation_conflict",
          "receiving_draft_not_found",
          "conflict",
        ].includes(code)
      ) {
        command.current = null;
        setUncertain(false);
        setBlocked(true);
        setFailure(
          code === "receiving_operation_conflict"
            ? "operationConflict"
            : code === "receiving_draft_not_found"
              ? "notFound"
              : "conflict",
        );
      } else if (
        [
          "receiving_reference_inactive",
          "receiving_reference_not_found",
          "invalid_input",
          "request_rejected",
        ].includes(code)
      ) {
        command.current = null;
        setUncertain(false);
        setFailure(
          code === "receiving_reference_inactive"
            ? "referenceInactive"
            : code === "receiving_reference_not_found"
              ? "referenceMissing"
              : "failed",
        );
      } else {
        setUncertain(true);
        setFailure("uncertain");
      }
    } finally {
      busy.current = false;
      if (alive.current) setPending(false);
      release();
    }
  }
  const picker = { client, disabled, onSessionLost, onForbidden };
  const previousLineNo =
    currentLine && "previousLineNo" in currentLine ? currentLine.previousLineNo : null;
  const retained =
    typeof previousLineNo === "number"
      ? predecessor?.content.snapshot.items.find((item) => item.lineNo === previousLineNo)
      : undefined;
  function moveLine(direction: -1 | 1) {
    const destination = activeLine + direction;
    if (disabled || destination < 0 || destination >= draft.items.length) return;
    const items = [...draft.items];
    const keys = [...lineKeys];
    const [item] = items.splice(activeLine, 1);
    const [key] = keys.splice(activeLine, 1);
    if (!item || !key) return;
    items.splice(destination, 0, item);
    keys.splice(destination, 0, key);
    change({ ...draft, items });
    setLineKeys(keys);
    setActiveLine(destination);
  }
  function removeLine() {
    if (disabled) return;
    change({ ...draft, items: draft.items.filter((_, index) => index !== activeLine) });
    setLineKeys(lineKeys.filter((_, index) => index !== activeLine));
    setActiveLine(Math.max(0, activeLine - 1));
  }
  return (
    <div className="us-rec-page" aria-busy={pending}>
      <Button
        type="button"
        variant="secondary"
        disabled={pending || mutationPending || finalizationLocked}
        onClick={close}
      >
        {backLabel ?? t("receiving.back")}
      </Button>
      <header className="us-md-page-header">
        <div>
          <h1 ref={heading} tabIndex={-1}>
            {record?.eventNumber ?? t("receiving.new")}
          </h1>
          <p>{t(recovering ? "receiving.loadedDraftHint" : "receiving.scope")}</p>
        </div>
        <span className="us-rec-status">
          {recovering
            ? t("receiving.currentUnconfirmed")
            : t(`receiving.${record?.status ?? "draft"}`)}
          {record ? ` · ${t("receiving.version")} ${record.draftVersion}` : ""}
        </span>
      </header>
      {record ? <ReceivingLifecycleNotice record={record} /> : null}
      {record && onOpenRecord ? (
        <ReceivingRevisionNavigation
          key={`navigation/${record.id}/${record.draftVersion}/${record.lifecycle.lifecycleVersion}`}
          record={record}
          client={client}
          disabled={pending || mutationPending || finalizationLocked || uncertain || recovering}
          beginMutation={beginMutation}
          onOpenRecord={onOpenRecord}
          onSessionLost={onSessionLost}
          onForbidden={onForbidden}
          canNavigate={canLeave}
        />
      ) : null}
      {isAmendment ? (
        <section className="us-md-notice" aria-label={t("receiving.correctionDraft")}>
          <p>{t("receiving.correctionHint", { revision: predecessor?.revision ?? "—" })}</p>
          <p>
            {t("receiving.reason")}: {record.lifecycle.amendmentReason}
          </p>
          <p className="us-rec-hint">{t("receiving.amendmentWorkflow")}</p>
        </section>
      ) : null}
      {record && canManageQa && onOpenRecord ? (
        <ReceivingLifecycleActions
          key={`${record.id}/${record.draftVersion}/${record.lifecycle.lifecycleVersion}`}
          record={record}
          client={client}
          mutationPending={mutationPending}
          beginMutation={beginMutation}
          onForbidden={onForbidden}
          onSessionLost={onSessionLost}
          onOpenRecord={onOpenRecord}
          disabled={dirty || pending || uncertain || blocked || finalizationLocked || recovering}
        />
      ) : null}
      {predecessor ? (
        <DataTabs
          className="us-rec-comparison-tabs"
          label={t("receiving.comparison")}
          activeId={pane}
          onChange={setPane}
          items={[
            { id: "draft", label: t("receiving.correctionDraft"), panelId: `${panelId}-draft` },
            {
              id: "previous",
              label: t("receiving.previousRevision"),
              panelId: `${panelId}-previous`,
            },
          ]}
        />
      ) : null}
      <div className={predecessor ? "us-rec-amendment-layout" : undefined} data-pane={pane}>
        <div
          id={`${panelId}-draft`}
          className="us-rec-amendment-draft"
          role={predecessor ? "tabpanel" : undefined}
          aria-label={predecessor ? t("receiving.correctionDraft") : undefined}
        >
          <form className="us-rec-form" noValidate onSubmit={(event) => void save(event)}>
            {failure ? (
              <div
                ref={alert}
                role="alert"
                tabIndex={-1}
                className="us-md-notice us-md-notice--alert"
              >
                <p>{t(`receiving.${failure}`)}</p>
                <ReceivingConflictDetails detail={conflictDetail} />
                {issues.length ? (
                  <ul>
                    {issues.map((issue, index) => (
                      <li key={index}>
                        {issue.line ? `${t("receiving.line", { number: issue.line })}: ` : ""}
                        {t(`receiving.${issue.key}`)}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {acknowledgedEventId.current ? (
                  <Button
                    type="button"
                    disabled={pending || mutationPending}
                    onClick={() => void recoverAcknowledgement()}
                  >
                    {t("receiving.retryCurrent")}
                  </Button>
                ) : blocked && record ? (
                  <Button
                    type="button"
                    disabled={pending || mutationPending}
                    onClick={() => void reload()}
                  >
                    {t("receiving.reload")}
                  </Button>
                ) : null}
              </div>
            ) : null}
            {!canWrite ? <p role="status">{t("receiving.readOnly")}</p> : null}
            <section className="us-rec-section" aria-labelledby="receiving-header">
              <h2 id="receiving-header">{t("receiving.header")}</h2>
              <p className="us-rec-hint">
                {t("receiving.zone", { zone: record?.timeZone ?? timeZone })}
              </p>
              <fieldset disabled={disabled} className="us-rec-fields">
                <Input
                  type="date"
                  label={t("receiving.date")}
                  value={draft.dateReceived ?? ""}
                  onChange={(e) => change({ ...draft, dateReceived: e.target.value || null })}
                />
                <Input
                  label={t("receiving.receivedAtNote")}
                  value={draft.receivedAtNote ?? ""}
                  maxLength={2000}
                  onChange={(e) => change({ ...draft, receivedAtNote: e.target.value || null })}
                />
                <ReceivingReferencePicker
                  {...picker}
                  kind="location"
                  label={t("receiving.location")}
                  value={draft.locationId ?? ""}
                  roles={["receive_at"]}
                  onChange={(id) => change({ ...draft, locationId: id || null })}
                />
                <ReceivingReferencePicker
                  {...picker}
                  kind="location"
                  label={t("receiving.previousSource")}
                  value={draft.previousSourceLocationId ?? ""}
                  onChange={(id) => change({ ...draft, previousSourceLocationId: id || null })}
                />
                <Textarea
                  label={t("receiving.notes")}
                  value={draft.notes ?? ""}
                  maxLength={2000}
                  onChange={(e) => change({ ...draft, notes: e.target.value || null })}
                />
              </fieldset>
            </section>
            <section className="us-rec-section" aria-labelledby="receiving-lines">
              <div className="us-rec-section-heading">
                <h2 id="receiving-lines">
                  {t("receiving.lines")} <span>{draft.items.length}</span>
                </h2>
                {canWrite ? (
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={disabled || draft.items.length >= 100}
                    onClick={() => {
                      setActiveLine(draft.items.length);
                      setLineKeys([...lineKeys, crypto.randomUUID()]);
                      change({
                        ...draft,
                        items: [
                          ...draft.items,
                          isAmendment
                            ? { ...emptyReceivingLine, previousLineNo: null }
                            : { ...emptyReceivingLine },
                        ],
                      });
                    }}
                  >
                    {t("receiving.addLine")}
                  </Button>
                ) : null}
              </div>
              {!draft.items.length ? (
                <p className="us-rec-hint">{t("receiving.noLines")}</p>
              ) : (
                <div className="us-rec-lines">
                  <ol className="us-rec-line-list" aria-label={t("receiving.lines")}>
                    {draft.items.map((item, index) => (
                      <li key={lineKeys[index]}>
                        <Button
                          type="button"
                          variant="secondary"
                          style={{
                            display: "grid",
                            justifyContent: "stretch",
                            justifyItems: "start",
                            width: "100%",
                            padding: 12,
                            font: "var(--text-meta)",
                            textAlign: "left",
                            background:
                              index === activeLine ? "var(--surface-page)" : "var(--surface-card)",
                            borderColor:
                              index === activeLine ? "var(--accent-strong)" : "var(--line)",
                          }}
                          className={`us-rec-line-link ${index === activeLine ? "is-active" : ""}`}
                          aria-current={index === activeLine ? "true" : undefined}
                          onClick={() => setActiveLine(index)}
                        >
                          <span>{t("receiving.line", { number: index + 1 })}</span>
                          {isAmendment ? (
                            <span>
                              {t(
                                "previousLineNo" in item && item.previousLineNo !== null
                                  ? "receiving.retainedLot"
                                  : "receiving.addedLine",
                              )}
                            </span>
                          ) : null}
                          <strong>{item.tlc ?? "—"}</strong>
                          <span>
                            {item.quantity ?? "—"} {item.unitOfMeasure ?? ""}
                          </span>
                        </Button>
                      </li>
                    ))}
                  </ol>
                  <div className="us-rec-stack">
                    {isAmendment && currentLine ? (
                      <div className="us-rec-confirm-actions">
                        <Button
                          type="button"
                          variant="secondary"
                          disabled={disabled || activeLine === 0}
                          onClick={() => moveLine(-1)}
                        >
                          {t("receiving.moveUp")}
                        </Button>
                        <Button
                          type="button"
                          variant="secondary"
                          disabled={disabled || activeLine === draft.items.length - 1}
                          onClick={() => moveLine(1)}
                        >
                          {t("receiving.moveDown")}
                        </Button>
                      </div>
                    ) : null}
                    {currentLine && retained ? (
                      <ReceivingRetainedLineEditor
                        value={currentLine}
                        original={retained}
                        number={activeLine + 1}
                        disabled={disabled}
                        onRemove={removeLine}
                        onChange={(value) =>
                          change({
                            ...draft,
                            items: draft.items.map((item, index) =>
                              index === activeLine ? { ...value, previousLineNo } : item,
                            ),
                          })
                        }
                      />
                    ) : currentLine && previousLineNo !== null ? (
                      <p role="alert">{t("receiving.predecessorUnavailable")}</p>
                    ) : currentLine ? (
                      <ReceivingLineEditor
                        key={lineKeys[activeLine]}
                        {...picker}
                        number={activeLine + 1}
                        value={currentLine}
                        receivingLocationId={draft.locationId}
                        receivingLocationLabel={receivingLocationLabel}
                        onChange={(value) =>
                          change({
                            ...draft,
                            items: draft.items.map((item, index) =>
                              index === activeLine
                                ? isAmendment
                                  ? { ...value, previousLineNo: null }
                                  : value
                                : item,
                            ),
                          })
                        }
                        onRemove={removeLine}
                      />
                    ) : null}
                  </div>
                </div>
              )}
              {draft.items.length >= 100 ? <p>{t("receiving.lineLimit")}</p> : null}
            </section>
            <section className="us-rec-section" aria-labelledby="receiving-documents">
              <h2 id="receiving-documents">{t("receiving.documents")}</h2>
              <ReceivingDocumentSection
                {...picker}
                documentIds={draft.documentIds}
                onChange={(documentIds) => change({ ...draft, documentIds })}
                beginMutation={beginMutation}
                onDirtyChange={documentChanged}
              />
            </section>
            <ReceivingReadinessPanel
              client={client}
              record={record}
              dirty={dirty}
              generation={readinessGeneration}
              disabled={pending || mutationPending || uncertain || blocked}
              onReload={reload}
              onForbidden={onForbidden}
              onSessionLost={onSessionLost}
              canManageQa={canManageQa}
              beginMutation={beginMutation}
              onFinalizationLocked={setFinalizationLocked}
              onAcknowledged={finalizedAcknowledgement}
              {...(onOpenRecord ? { onOpenRecord } : {})}
            />
            <footer className="us-rec-save">
              <div role="status" aria-live="polite">
                {recovering
                  ? t("receiving.currentUnconfirmed")
                  : pending
                    ? t("receiving.saving")
                    : saved
                      ? t("receiving.saved")
                      : dirty
                        ? t("receiving.unsaved")
                        : record
                          ? `${t("receiving.updated")}: ${new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium", timeStyle: "short", timeZone: record.timeZone }).format(new Date(record.updatedAt))}`
                          : t("receiving.draft")}
              </div>
              {documentDirty ? <p>{t("receiving.documentPending")}</p> : null}
              {canWrite ? (
                <Button
                  type="submit"
                  disabled={
                    pending || mutationPending || blocked || documentDirty || finalizationLocked
                  }
                >
                  {t(uncertain ? "receiving.retrySave" : "receiving.save")}
                </Button>
              ) : null}
            </footer>
          </form>
        </div>
        {predecessor ? (
          <div
            id={`${panelId}-previous`}
            className="us-rec-amendment-previous"
            role="tabpanel"
            aria-label={t("receiving.previousRevision")}
          >
            <ReceivingAmendmentComparison predecessor={predecessor} draft={draft} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
