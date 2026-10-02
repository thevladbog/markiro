import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { UOM_CODES_V1 } from "@markiro/domain";
import {
  shippingDraftSchema,
  type ShippingDraft,
  type ShippingDraftRecord,
  type ShippingHistoricalRecord,
  type ShippingReadiness,
  type ShippingRevisionList,
} from "@markiro/platform-contracts";
import { Button, Input, Modal, Select, StatusChip, Textarea } from "@markiro/ui";
import { useTranslation } from "react-i18next";
import { UsClientError, UsShippingConflictError } from "../client.js";
import type { MasterDataViewProps } from "../master-data/workspace-shared.js";
import { ReceivingReferencePicker } from "../receiving/reference-picker.js";
import { ShippingDetail } from "./detail.js";
import type { ReadinessEventTarget } from "../readiness/source.js";
import {
  readinessSourceMatches,
  ReadinessSourceError,
  ReadinessSourceNotice,
  useReadinessSourceFocus,
} from "../readiness/view.js";
import { ShippingBalanceRead } from "./balance-read.js";
import { ShippingReadinessPanel } from "./readiness-panel.js";
import { ShippingRevisionHistory } from "./revision-history.js";
import "./shipping.css";

const emptyDraft: ShippingDraft = {
  eventDate: null,
  shipFromLocationId: null,
  recipientLocationId: null,
  carrierReference: null,
  notes: null,
  items: [],
  documentIds: [],
};
type Command =
  | { kind: "create"; payload: { operationKey: string; draft: ShippingDraft } }
  | {
      kind: "save";
      id: string;
      payload: { operationKey: string; expectedDraftVersion: number; draft: ShippingDraft };
    }
  | {
      kind: "finalize";
      id: string;
      payload: { operationKey: string; expectedDraftVersion: number; expectedInputDigest: string };
    }
  | {
      kind: "amend" | "void";
      id: string;
      payload: {
        operationKey: string;
        expectedLifecycleVersion: number;
        reason: string;
        expectedDraftVersion?: number;
      };
    };
type Dialog = "finalize" | "amend" | "void" | null;
type Props = Pick<
  MasterDataViewProps,
  | "client"
  | "mutationPending"
  | "beginMutation"
  | "onDirtyChange"
  | "onForbidden"
  | "onSessionLost"
  | "accessRecovery"
> & {
  eventId: string | null;
  sourceTarget?: ReadinessEventTarget;
  backLabel?: string;
  timeZone: string;
  canShip: boolean;
  canManageQa: boolean;
  onClose: () => void;
};

function isDraft(record: ShippingHistoricalRecord | null): record is ShippingDraftRecord {
  return record?.status === "draft";
}

export function ShippingRecordView({
  eventId,
  sourceTarget,
  backLabel,
  timeZone,
  client,
  canShip,
  canManageQa,
  mutationPending,
  beginMutation,
  onDirtyChange,
  onForbidden,
  onSessionLost,
  accessRecovery,
  onClose,
}: Props) {
  const { t } = useTranslation();
  const [record, setRecord] = useState<ShippingHistoricalRecord | null>(null);
  const [draft, setDraft] = useState<ShippingDraft>(emptyDraft);
  const [loading, setLoading] = useState(eventId !== null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [sourceFailed, setSourceFailed] = useState(false);
  const [sourceRetry, setSourceRetry] = useState(0);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [readiness, setReadiness] = useState<ShippingReadiness | null>(null);
  const [issues, setIssues] = useState<ShippingReadiness["issues"]>([]);
  const [downstream, setDownstream] = useState<{
    blockers: NonNullable<UsShippingConflictError["blockers"]>;
    hasMore: boolean;
  } | null>(null);
  const [documentCandidate, setDocumentCandidate] = useState("");
  const [dialog, setDialog] = useState<Dialog>(null);
  const [reason, setReason] = useState("");
  const [history, setHistory] = useState<ShippingRevisionList | null>(null);
  const [historyOffset, setHistoryOffset] = useState(0);
  const [historyRefresh, setHistoryRefresh] = useState(0);
  const [historyPending, setHistoryPending] = useState(false);
  const [historyFailure, setHistoryFailure] = useState(false);
  const [historyReadFailure, setHistoryReadFailure] = useState(false);
  const [historyReading, setHistoryReading] = useState(false);
  const pendingCommand = useRef<Command | null>(null);
  const busyRef = useRef(false);
  const alive = useRef(true);
  const heading = useRef<HTMLHeadingElement>(null);
  const historyRun = useRef(0);
  const revisionRun = useRef(0);
  const savedDraft = isDraft(record) ? record : null;
  const canWrite =
    canShip &&
    (!record || (record.status === "draft" && (record.revision === 1 || canManageQa))) &&
    !accessRecovery?.pending;
  const dirty = savedDraft
    ? JSON.stringify(draft) !== JSON.stringify(savedDraft.draft)
    : !record && JSON.stringify(draft) !== JSON.stringify(emptyDraft);
  const protectedState =
    dirty || Boolean(reason) || dialog !== null || uncertain || pendingCommand.current !== null;
  const disabled = !canWrite || busy || mutationPending || blocked || uncertain || historyReading;
  const picker = { client, disabled, onSessionLost, onForbidden };
  const currentReadiness =
    savedDraft &&
    !dirty &&
    readiness?.eventId === savedDraft.id &&
    readiness.expectedDraftVersion === savedDraft.draftVersion
      ? readiness
      : null;
  const handleAuth = useCallback(
    async (error: unknown) => {
      if (!(error instanceof UsClientError)) return false;
      if (error.code === "session_required") {
        onSessionLost();
        return true;
      }
      if (error.code === "forbidden") {
        await onForbidden();
        return true;
      }
      return false;
    },
    [onForbidden, onSessionLost],
  );

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      historyRun.current += 1;
      revisionRun.current += 1;
    };
  }, []);
  useEffect(() => {
    heading.current?.focus();
  }, [record?.id, loading]);
  useEffect(() => {
    onDirtyChange(protectedState);
  }, [onDirtyChange, protectedState]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  useEffect(() => {
    if (!protectedState && !busy) return;
    const protect = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, [protectedState, busy]);
  useEffect(() => {
    if (!canManageQa) setDialog(null);
  }, [canManageQa]);
  useEffect(() => {
    if (!eventId) return;
    let active = true;
    void client
      .getShipping(eventId)
      .then((result) => {
        if (!active) return;
        if (sourceTarget) {
          const items =
            "snapshot" in result
              ? result.snapshot.items
              : result.draft.items.map((_, index) => ({ lineNo: index + 1 }));
          if (!readinessSourceMatches(sourceTarget, result, { items })) {
            setSourceFailed(true);
            setLoading(false);
            return;
          }
        }
        setSourceFailed(false);
        setRecord(result);
        if (isDraft(result)) setDraft(result.draft);
        setLoading(false);
        setLoadFailed(false);
      })
      .catch(async (error: unknown) => {
        if (!active) return;
        setLoading(false);
        setLoadFailed(true);
        if (sourceTarget && error instanceof UsClientError && error.code === "invalid_response")
          setSourceFailed(true);
        await handleAuth(error);
      });
    return () => {
      active = false;
    };
  }, [eventId, client, handleAuth, sourceTarget, sourceRetry]);
  useEffect(() => {
    if (!record?.lifecycle) return;
    const selected = record;
    const run = ++historyRun.current;
    setHistoryPending(true);
    setHistoryFailure(false);
    void client
      .listShippingRevisions(selected.id, { limit: 50, offset: historyOffset })
      .then((list) => {
        if (historyRun.current !== run) return;
        const first = list.items[0];
        if (
          first &&
          (first.rootId.toLowerCase() !== selected.lifecycle?.rootId.toLowerCase() ||
            first.eventNumber !== selected.eventNumber ||
            first.timeZone !== selected.timeZone ||
            list.lifecycleVersion !== selected.lifecycle?.lifecycleVersion)
        )
          throw new UsClientError("invalid_response");
        setHistory(list);
      })
      .catch(async (error: unknown) => {
        if (historyRun.current !== run) return;
        setHistoryFailure(true);
        await handleAuth(error);
      })
      .finally(() => {
        if (historyRun.current === run) setHistoryPending(false);
      });
    return () => {
      historyRun.current += 1;
    };
  }, [client, record, historyOffset, historyRefresh, handleAuth]);
  function accept(next: ShippingHistoricalRecord) {
    setRecord(next);
    if (isDraft(next)) setDraft(next.draft);
    setReadiness(null);
    setIssues([]);
    setFailure(null);
    setDownstream(null);
    setBlocked(false);
    setUncertain(false);
    setLoadFailed(false);
    setLoading(false);
    setDialog(null);
    setReason("");
    setHistoryOffset(0);
    pendingCommand.current = null;
  }
  function edit(next: ShippingDraft) {
    if (disabled) return;
    setDraft(next);
    setReadiness(null);
    setIssues([]);
    setFailure(null);
    setDialog(null);
  }
  function close() {
    if (busyRef.current || mutationPending) return;
    if (
      protectedState &&
      !window.confirm(t(uncertain ? "shipping.leaveUncertain" : "md.discardConfirm"))
    )
      return;
    onClose();
  }
  async function reload() {
    if (busyRef.current || mutationPending) return;
    const id = record?.id ?? eventId;
    if (!id) return;
    if ((dirty || uncertain) && !window.confirm(t("shipping.reloadConfirm"))) return;
    setBusy(true);
    try {
      accept(await client.getShipping(id));
    } catch (error) {
      setFailure("loadError");
      await handleAuth(error);
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function runCommand() {
    const command = pendingCommand.current;
    if (!command || busyRef.current || mutationPending) return;
    if (
      (command.kind === "finalize" || command.kind === "amend" || command.kind === "void") &&
      !canManageQa
    )
      return;
    if ((command.kind === "create" || command.kind === "save") && !canWrite) return;
    busyRef.current = true;
    setBusy(true);
    setFailure(null);
    setDownstream(null);
    const release = beginMutation();
    try {
      const next =
        command.kind === "create"
          ? await client.createShipping(command.payload)
          : command.kind === "save"
            ? await client.saveShipping(command.id, command.payload)
            : command.kind === "finalize"
              ? await client.finalizeShipping(command.id, command.payload)
              : command.kind === "amend"
                ? (await client.amendShipping(command.id, command.payload)).record
                : (await client.voidShipping(command.id, command.payload)).record;
      if (alive.current) accept(next);
    } catch (error) {
      if (!alive.current) return;
      const code = error instanceof UsClientError ? error.code : "unavailable";
      if (await handleAuth(error)) {
        pendingCommand.current = null;
        setFailure("unavailable");
      } else if (error instanceof UsShippingConflictError && error.code === "event_incomplete") {
        pendingCommand.current = null;
        setUncertain(false);
        setReadiness(null);
        setIssues(error.issues ?? []);
        setDialog(null);
        setFailure("incomplete");
      } else if (
        error instanceof UsShippingConflictError &&
        error.code === "traceability_downstream_blocked"
      ) {
        pendingCommand.current = null;
        setUncertain(false);
        setBlocked(true);
        setDialog(null);
        setDownstream({ blockers: error.blockers ?? [], hasMore: error.hasMore ?? false });
        setFailure("downstreamBlocked");
      } else if (
        [
          "shipping_draft_conflict",
          "shipping_lifecycle_conflict",
          "shipping_readiness_changed",
          "shipping_operation_conflict",
          "shipping_pending_amendment",
          "shipping_not_draft",
          "shipping_not_found",
          "shipping_reference_not_found",
        ].includes(code)
      ) {
        pendingCommand.current = null;
        setUncertain(false);
        setBlocked(true);
        setDialog(null);
        setReadiness(null);
        setFailure("stale");
      } else if (code === "invalid_input" || code === "request_rejected") {
        pendingCommand.current = null;
        setUncertain(false);
        setFailure("invalid");
      } else {
        // No definitive response: retain the exact operation key and body for same-intent retry.
        setUncertain(true);
        setFailure("uncertain");
      }
    } finally {
      busyRef.current = false;
      if (alive.current) setBusy(false);
      release();
    }
  }
  function save(event: FormEvent) {
    event.preventDefault();
    if (disabled || pendingCommand.current) return;
    const parsed = shippingDraftSchema.safeParse(draft);
    if (!parsed.success) {
      setFailure("invalid");
      return;
    }
    const operationKey = crypto.randomUUID();
    pendingCommand.current = savedDraft
      ? {
          kind: "save",
          id: savedDraft.id,
          payload: {
            operationKey,
            expectedDraftVersion: savedDraft.draftVersion,
            draft: parsed.data,
          },
        }
      : { kind: "create", payload: { operationKey, draft: parsed.data } };
    void runCommand();
  }
  async function checkReadiness() {
    if (
      !savedDraft ||
      dirty ||
      blocked ||
      pendingCommand.current ||
      busyRef.current ||
      mutationPending
    )
      return;
    setBusy(true);
    setFailure(null);
    try {
      const result = await client.checkShippingReadiness(savedDraft.id, savedDraft.draftVersion);
      if (!alive.current) return;
      setReadiness(result);
      setIssues(result.issues);
    } catch (error) {
      if (!alive.current) return;
      const code = error instanceof UsClientError ? error.code : "unavailable";
      if (await handleAuth(error)) setFailure("unavailable");
      else if (code === "shipping_draft_conflict" || code === "shipping_readiness_changed") {
        setBlocked(true);
        setFailure("stale");
      } else setFailure("checkFailed");
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  function finalize() {
    if (
      !canManageQa ||
      !savedDraft ||
      dirty ||
      blocked ||
      uncertain ||
      busyRef.current ||
      mutationPending ||
      currentReadiness?.state !== "complete"
    )
      return;
    pendingCommand.current = {
      kind: "finalize",
      id: savedDraft.id,
      payload: {
        operationKey: crypto.randomUUID(),
        expectedDraftVersion: savedDraft.draftVersion,
        expectedInputDigest: currentReadiness.inputDigest,
      },
    };
    setDialog(null);
    void runCommand();
  }
  function lifecycle(action: "amend" | "void") {
    if (
      !canManageQa ||
      !record?.lifecycle ||
      !reason.trim() ||
      busyRef.current ||
      mutationPending ||
      blocked ||
      uncertain
    )
      return;
    pendingCommand.current = {
      kind: action,
      id: record.id,
      payload: {
        operationKey: crypto.randomUUID(),
        expectedLifecycleVersion: record.lifecycle.lifecycleVersion,
        reason: reason.trim(),
        ...(action === "void" && record.status === "draft"
          ? { expectedDraftVersion: record.draftVersion }
          : {}),
      },
    };
    setDialog(null);
    void runCommand();
  }
  async function openRevision(id: string) {
    if (!record || protectedState || busyRef.current || historyReading || id === record.id) return;
    const prior = record;
    const run = ++revisionRun.current;
    setHistoryReading(true);
    setHistoryReadFailure(false);
    try {
      const next = await client.getShipping(id);
      if (!alive.current || revisionRun.current !== run) return;
      if (
        next.id.toLowerCase() !== id.toLowerCase() ||
        next.eventNumber !== prior.eventNumber ||
        next.lifecycle?.rootId.toLowerCase() !== prior.lifecycle?.rootId.toLowerCase() ||
        next.timeZone !== prior.timeZone
      )
        throw new UsClientError("invalid_response");
      accept(next);
    } catch (error) {
      if (!alive.current || revisionRun.current !== run) return;
      setHistoryReadFailure(true);
      await handleAuth(error);
    } finally {
      if (alive.current && revisionRun.current === run) setHistoryReading(false);
    }
  }
  const canAmend =
    canManageQa &&
    record?.status === "finalized" &&
    record.lifecycle?.currentEventId === record.id &&
    record.lifecycle.pendingDraftId === null;
  const canVoid =
    canManageQa &&
    (canAmend ||
      (record?.status === "draft" &&
        record.lifecycle?.pendingDraftId === record.id &&
        (record.revision === 1 ||
          (record.revision > 1 &&
            record.lifecycle.currentEventId === record.lifecycle.previousRevisionId))));
  const cancelPendingAmendment = record?.status === "draft" && record.revision > 1;
  const quantitySummary =
    draft.items.map((item) => `${item.quantity ?? "—"} ${item.unitOfMeasure ?? "—"}`).join(", ") ||
    "—";
  const sourceRef = useReadinessSourceFocus(sourceTarget, record?.id);
  if (sourceFailed)
    return (
      <ReadinessSourceError
        disabled={busy || mutationPending}
        onRetry={() => {
          setSourceFailed(false);
          setLoading(true);
          setSourceRetry((n) => n + 1);
        }}
        onBack={close}
      />
    );
  if (loading || loadFailed)
    return (
      <div className="us-sh-page">
        {sourceTarget ? (
          <Button variant="secondary" disabled={busy || mutationPending} onClick={close}>
            {backLabel ?? t("events.back")}
          </Button>
        ) : null}
        <p role={loadFailed ? "alert" : "status"}>
          {t(loadFailed ? "shipping.loadError" : "md.stale")}
        </p>
        {loadFailed ? (
          <Button onClick={() => (sourceTarget ? setSourceRetry((n) => n + 1) : void reload())}>
            {t("md.retry")}
          </Button>
        ) : null}
      </div>
    );
  return (
    <div ref={sourceRef} className="us-sh-page" aria-busy={busy}>
      <Button type="button" variant="secondary" disabled={busy || mutationPending} onClick={close}>
        {backLabel ?? t("events.back")}
      </Button>
      {sourceTarget && record?.id === sourceTarget.eventId ? (
        <ReadinessSourceNotice target={sourceTarget} />
      ) : null}
      <header className="us-sh-header">
        <div className="us-sh-header__identity">
          <span>
            {record ? t("shipping.revision", { number: record.revision }) : t("shipping.new")}
          </span>
          {record ? (
            <StatusChip
              status={
                record.status === "finalized"
                  ? "ok"
                  : record.status === "void"
                    ? "error"
                    : record.status === "amended"
                      ? "info"
                      : "neutral"
              }
              label={t(`events.${record.status}`)}
            />
          ) : null}
        </div>
        <h1 ref={heading} tabIndex={-1} className={record ? "us-sh-mono" : undefined}>
          {record?.eventNumber ?? t("shipping.title")}
        </h1>
        <p className="us-sh-hint">{record?.timeZone ?? timeZone}</p>
      </header>
      {failure ? (
        <p role="alert" className="us-sh-notice">
          {t(`shipping.${failure}`)}
        </p>
      ) : null}
      {downstream ? (
        <div className="us-sh-blockers" role="alert" aria-label={t("shipping.downstreamBlocked")}>
          <ul>
            {downstream.blockers.map((item) => (
              <li key={`${item.lotId}/${item.eventId}`} className="us-sh-mono">
                {t("shipping.downstreamItem", item)}
              </li>
            ))}
          </ul>
          {downstream.hasMore ? <p>{t("shipping.downstreamMore")}</p> : null}
        </div>
      ) : null}
      {uncertain ? (
        <Button type="button" disabled={busy} onClick={() => void runCommand()}>
          {t("shipping.retrySame")}
        </Button>
      ) : null}
      {(blocked || uncertain) && record ? (
        <Button type="button" variant="secondary" disabled={busy} onClick={() => void reload()}>
          {t("shipping.reload")}
        </Button>
      ) : null}
      {isDraft(record) || record === null ? (
        <>
          <form onSubmit={save}>
            <section className="us-sh-section" aria-labelledby="us-sh-header-fields">
              <h2 id="us-sh-header-fields">{t("shipping.title")}</h2>
              <div className="us-sh-fields">
                <Input
                  type="date"
                  label={t("shipping.date")}
                  value={draft.eventDate ?? ""}
                  disabled={disabled}
                  onChange={(event) => edit({ ...draft, eventDate: event.target.value || null })}
                />
                <ReceivingReferencePicker
                  {...picker}
                  kind="location"
                  roles={["ship_from"]}
                  label={t("shipping.shipFrom")}
                  value={draft.shipFromLocationId ?? ""}
                  onChange={(id) => edit({ ...draft, shipFromLocationId: id || null })}
                />
                <ReceivingReferencePicker
                  {...picker}
                  kind="location"
                  roles={["recipient"]}
                  label={t("shipping.recipient")}
                  value={draft.recipientLocationId ?? ""}
                  onChange={(id) => edit({ ...draft, recipientLocationId: id || null })}
                />
              </div>
              <p className="us-sh-hint">{t("shipping.recipientHint")}</p>
              <div className="us-sh-fields">
                <Input
                  label={t("shipping.carrier")}
                  value={draft.carrierReference ?? ""}
                  disabled={disabled}
                  maxLength={2000}
                  onChange={(event) =>
                    edit({ ...draft, carrierReference: event.target.value || null })
                  }
                />
                <Textarea
                  label={t("shipping.notes")}
                  value={draft.notes ?? ""}
                  disabled={disabled}
                  maxLength={2000}
                  onChange={(event) => edit({ ...draft, notes: event.target.value || null })}
                />
              </div>
            </section>
            <section className="us-sh-section" aria-labelledby="us-sh-lines">
              <h2 id="us-sh-lines">{t("shipping.lines")}</h2>
              <p className="us-sh-hint">{t("shipping.lotIdentity")}</p>
              {draft.items.map((line, index) => (
                <fieldset className="us-sh-line" key={index} disabled={disabled}>
                  <legend>{t("shipping.line", { number: index + 1 })}</legend>
                  <ReceivingReferencePicker
                    {...picker}
                    kind="lot"
                    label={t("shipping.lot")}
                    value={line.lotId}
                    onChange={(id) =>
                      edit({
                        ...draft,
                        items: draft.items.map((row, itemIndex) =>
                          itemIndex === index ? { ...row, lotId: id } : row,
                        ),
                      })
                    }
                  />
                  <div className="us-sh-fields">
                    <Input
                      label={t("shipping.quantity")}
                      inputMode="decimal"
                      value={line.quantity ?? ""}
                      disabled={disabled}
                      maxLength={30}
                      onChange={(event) =>
                        edit({
                          ...draft,
                          items: draft.items.map((row, itemIndex) =>
                            itemIndex === index
                              ? { ...row, quantity: event.target.value || null }
                              : row,
                          ),
                        })
                      }
                    />
                    <Select
                      native
                      label={t("shipping.unit")}
                      value={line.unitOfMeasure ?? ""}
                      disabled={disabled}
                      options={[
                        { value: "", label: "—" },
                        ...UOM_CODES_V1.map((unit) => ({ value: unit, label: unit })),
                      ]}
                      onValueChange={(unit) =>
                        edit({
                          ...draft,
                          items: draft.items.map((row, itemIndex) =>
                            itemIndex === index
                              ? {
                                  ...row,
                                  unitOfMeasure:
                                    UOM_CODES_V1.find((value) => value === unit) ?? null,
                                }
                              : row,
                          ),
                        })
                      }
                    />
                  </div>
                  {line.lotId ? (
                    <ShippingBalanceRead
                      key={`${line.lotId}/${savedDraft?.id ?? ""}/${savedDraft?.draftVersion ?? ""}`}
                      client={client}
                      lotId={line.lotId}
                      quantity={line.quantity}
                      unit={line.unitOfMeasure}
                      contextDraftId={
                        savedDraft && savedDraft.revision > 1 ? savedDraft.id : undefined
                      }
                      expectedDraftVersion={
                        savedDraft && savedDraft.revision > 1 ? savedDraft.draftVersion : undefined
                      }
                      onForbidden={onForbidden}
                      onSessionLost={onSessionLost}
                      onOriginUom={(originUom) => {
                        if (
                          !originUom ||
                          draft.items[index]?.lotId !== line.lotId ||
                          draft.items[index]?.unitOfMeasure !== null
                        )
                          return;
                        edit({
                          ...draft,
                          items: draft.items.map((row, rowIndex) =>
                            rowIndex === index ? { ...row, unitOfMeasure: originUom } : row,
                          ),
                        });
                      }}
                    />
                  ) : null}
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={disabled}
                    onClick={() =>
                      edit({
                        ...draft,
                        items: draft.items.filter((_, itemIndex) => itemIndex !== index),
                      })
                    }
                  >
                    {t("shipping.removeLine")}
                  </Button>
                </fieldset>
              ))}
              <Button
                type="button"
                variant="secondary"
                disabled={disabled || draft.items.length >= 100}
                onClick={() =>
                  edit({
                    ...draft,
                    items: [...draft.items, { lotId: "", quantity: null, unitOfMeasure: null }],
                  })
                }
              >
                {t("shipping.addLot")}
              </Button>
            </section>
            <section className="us-sh-section" aria-labelledby="us-sh-documents">
              <h2 id="us-sh-documents">{t("shipping.documents")}</h2>
              <ul className="us-sh-documents">
                {draft.documentIds.map((id) => (
                  <li key={id}>
                    <span className="us-sh-mono">{id}</span>
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={disabled}
                      onClick={() =>
                        edit({
                          ...draft,
                          documentIds: draft.documentIds.filter((value) => value !== id),
                        })
                      }
                    >
                      {t("shipping.detach")}
                    </Button>
                  </li>
                ))}
              </ul>
              <ReceivingReferencePicker
                {...picker}
                kind="document"
                label={t("shipping.document")}
                value={documentCandidate}
                onChange={setDocumentCandidate}
              />
              <Button
                type="button"
                variant="secondary"
                disabled={
                  disabled ||
                  !documentCandidate ||
                  draft.documentIds.includes(documentCandidate) ||
                  draft.documentIds.length >= 100
                }
                onClick={() => {
                  edit({ ...draft, documentIds: [...draft.documentIds, documentCandidate] });
                  setDocumentCandidate("");
                }}
              >
                {t("shipping.addDocument")}
              </Button>
            </section>
            <div className="us-sh-actions">
              <Button type="submit" disabled={disabled || (!dirty && record !== null)}>
                {t(busy ? "shipping.saving" : "shipping.save")}
              </Button>
            </div>
          </form>
          <ShippingReadinessPanel
            record={savedDraft}
            dirty={dirty}
            pending={busy || mutationPending || blocked || uncertain}
            readiness={readiness}
            issues={issues}
            onCheck={() => void checkReadiness()}
          />
          {canManageQa && currentReadiness?.state === "complete" && !blocked && !uncertain ? (
            <Button
              type="button"
              disabled={busy || mutationPending}
              onClick={() => setDialog("finalize")}
            >
              {t("shipping.finalize")}
            </Button>
          ) : null}
        </>
      ) : (
        <ShippingDetail
          key={record.id}
          record={record}
          client={client}
          onForbidden={onForbidden}
          onSessionLost={onSessionLost}
        />
      )}
      {record && (canAmend || canVoid) ? (
        <div className="us-sh-actions us-sh-lifecycle">
          {canAmend ? (
            <Button
              type="button"
              variant="secondary"
              disabled={busy || blocked || uncertain || mutationPending}
              onClick={() => {
                setReason("");
                setDialog("amend");
              }}
            >
              {t("shipping.amendment")}
            </Button>
          ) : null}
          {canVoid ? (
            <Button
              type="button"
              variant="destructive-outline"
              disabled={busy || blocked || uncertain || mutationPending || dirty}
              onClick={() => {
                setReason("");
                setDialog("void");
              }}
            >
              {t(cancelPendingAmendment ? "shipping.cancelAmendment" : "shipping.void")}
            </Button>
          ) : null}
        </div>
      ) : null}
      {historyReadFailure ? <p role="alert">{t("shipping.historyReadFailed")}</p> : null}
      {record?.lifecycle ? (
        <ShippingRevisionHistory
          list={history}
          selectedId={record.id}
          pending={historyPending || historyReading || protectedState}
          failure={historyFailure}
          onOpen={(id) => void openRevision(id)}
          onPage={setHistoryOffset}
          onRetry={() => setHistoryRefresh((value) => value + 1)}
        />
      ) : null}
      <Modal
        open={dialog === "finalize"}
        title={t("shipping.finalize")}
        closeLabel={t("shipping.cancel")}
        onClose={() => setDialog(null)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setDialog(null)}>
              {t("shipping.cancel")}
            </Button>
            <Button disabled={busy || !canManageQa} onClick={finalize}>
              {t("shipping.confirmFinalization")}
            </Button>
          </>
        }
      >
        <p>{t("shipping.finalizeConfirm")}</p>
        <p className="us-sh-mono">
          {t("shipping.finalizeQuantity", { quantity: quantitySummary })}
        </p>
        <p>{t("shipping.noCaseClaim")}</p>
      </Modal>
      <Modal
        open={dialog === "amend" || dialog === "void"}
        title={t(
          dialog === "amend"
            ? "shipping.amendment"
            : cancelPendingAmendment
              ? "shipping.cancelAmendment"
              : "shipping.void",
        )}
        closeLabel={t("shipping.cancel")}
        onClose={() => {
          setDialog(null);
          setReason("");
        }}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setDialog(null);
                setReason("");
              }}
            >
              {t("shipping.cancel")}
            </Button>
            <Button
              disabled={busy || !reason.trim() || !canManageQa}
              variant={dialog === "void" ? "destructive" : "primary"}
              onClick={() => {
                if (dialog === "amend" || dialog === "void") lifecycle(dialog);
              }}
            >
              {t(
                dialog === "amend"
                  ? "shipping.confirmAmendment"
                  : cancelPendingAmendment
                    ? "shipping.confirmCancellation"
                    : "shipping.confirmVoid",
              )}
            </Button>
          </>
        }
      >
        <p>
          {t(
            dialog === "amend"
              ? "shipping.amendmentHint"
              : cancelPendingAmendment
                ? "shipping.cancelAmendmentHint"
                : "shipping.voidHint",
          )}
        </p>
        <Textarea
          label={t("shipping.actionReason")}
          value={reason}
          maxLength={2000}
          onChange={(event) => setReason(event.target.value)}
        />
      </Modal>
    </div>
  );
}
