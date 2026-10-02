import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { UOM_CODES_V1 } from "@markiro/domain";
import { Button, Input, Select, Textarea } from "@markiro/ui";
import {
  transformationDraftSchema,
  type TransformationDraft,
  type TransformationDraftRecord,
  type TransformationHttpRecord,
  type TransformationHttpError,
  type TransformationRevisionList,
  type TransformationReadiness,
} from "@markiro/platform-contracts";
import { useTranslation } from "react-i18next";
import { UsClientError, UsTransformationConflictError, type UsClientErrorCode } from "../client.js";
import type { MasterDataViewProps } from "../master-data/workspace-shared.js";
import { ReceivingReferencePicker } from "../receiving/reference-picker.js";
import { TransformationReadinessPanel } from "./readiness-panel.js";
import { TransformationDetail } from "./detail.js";
import type { ReadinessEventTarget } from "../readiness/source.js";
import {
  readinessSourceMatches,
  ReadinessSourceError,
  ReadinessSourceNotice,
  useReadinessSourceFocus,
} from "../readiness/view.js";
import { TransformationRevisionHistory } from "./revision-history.js";
import {
  TransformationLifecycleActions,
  type TransformationLifecycleAction,
} from "./lifecycle-actions.js";
import "./transformation.css";

// Parsed rejections are definite; unknown responses and transport failures retain the command.
const transformationRecovery: Partial<Record<UsClientErrorCode, string>> = {
  transformation_not_found: "notFound",
  transformation_reference_not_found: "referenceNotFound",
  transformation_not_draft: "notDraft",
  transformation_draft_conflict: "stale",
  transformation_lifecycle_conflict: "stale",
  transformation_operation_conflict: "operationConflict",
  transformation_readiness_changed: "stale",
  transformation_output_identity_locked: "stale",
  transformation_lot_conflict: "stale",
  transformation_genealogy_cycle: "genealogyCycle",
  transformation_pending_amendment: "pendingAmendment",
  event_incomplete: "incomplete",
  traceability_downstream_blocked: "downstreamBlocked",
} satisfies Record<TransformationHttpError["code"], string>;

const emptyDraft: TransformationDraft = {
  eventDate: null,
  processorLocationId: null,
  reason: null,
  reasonNote: null,
  notes: null,
  inputs: [],
  outputs: [],
  documentIds: [],
};
const emptyFtl: TransformationDraft["inputs"][number] = {
  kind: "ftl_lot",
  lotId: null,
  quantity: null,
  unitOfMeasure: null,
};
const emptyNonFtl: TransformationDraft["inputs"][number] = {
  kind: "non_ftl",
  productId: null,
  sourceLocationId: null,
  reference: null,
  quantity: null,
  unitOfMeasure: null,
};
const emptyOutput: TransformationDraft["outputs"][number] = {
  productId: null,
  tlc: null,
  quantity: null,
  unitOfMeasure: null,
};
type Command =
  | {
      kind: "create";
      id: null;
      operationKey: string;
      payload: { operationKey: string; draft: TransformationDraft };
    }
  | {
      kind: "save";
      id: string;
      operationKey: string;
      payload: { operationKey: string; draft: TransformationDraft; expectedDraftVersion: number };
    }
  | {
      kind: "finalize";
      id: string;
      operationKey: string;
      payload: { operationKey: string; expectedDraftVersion: number; expectedInputDigest: string };
    }
  | {
      kind: "amend" | "void";
      id: string;
      operationKey: string;
      payload: {
        operationKey: string;
        expectedLifecycleVersion: number;
        reason: string;
        expectedDraftVersion?: number;
      };
    };
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
  canTransform: boolean;
  canManageQa: boolean;
  onClose: () => void;
  onOpenLot: (id: string) => void;
  fallback?: ReactNode;
};

function isDraft(record: TransformationHttpRecord | null): record is TransformationDraftRecord {
  return record?.status === "draft";
}

function quantitySummary(draft: TransformationDraft) {
  const describe = (lines: { quantity: string | null; unitOfMeasure: string | null }[]) =>
    lines.map((line) => `${line.quantity ?? "—"} ${line.unitOfMeasure ?? "—"}`).join(", ") || "—";
  return { inputs: describe(draft.inputs), outputs: describe(draft.outputs) };
}

export function TransformationRecordView({
  eventId,
  sourceTarget,
  backLabel,
  timeZone,
  client,
  canTransform,
  canManageQa,
  mutationPending,
  beginMutation,
  onDirtyChange,
  onForbidden,
  onSessionLost,
  onClose,
  onOpenLot,
  fallback,
  accessRecovery,
}: Props) {
  const { t } = useTranslation();
  const [savedRecord, setSavedRecord] = useState<TransformationHttpRecord | null>(null);
  const [draft, setDraft] = useState<TransformationDraft>(emptyDraft);
  const [loading, setLoading] = useState(eventId !== null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [sourceFailed, setSourceFailed] = useState(false);
  const [sourceRetry, setSourceRetry] = useState(0);
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [readFailed, setReadFailed] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [readiness, setReadiness] = useState<TransformationReadiness | null>(null);
  const [issues, setIssues] = useState<TransformationReadiness["issues"]>([]);
  const [downstream, setDownstream] = useState<{
    blockers: NonNullable<UsTransformationConflictError["blockers"]>;
    hasMore: boolean;
  } | null>(null);
  const [finalizeOpen, setFinalizeOpen] = useState(false);
  const [documentCandidate, setDocumentCandidate] = useState("");
  const [coverageFailure, setCoverageFailure] = useState<string | null>(null);
  const [lifecycleReasonDirty, setLifecycleReasonDirty] = useState(false);
  const [caseProtected, setCaseProtected] = useState(false);
  const [predecessorOutputs, setPredecessorOutputs] = useState<
    | {
        lotId: string;
        productId: string;
        tlc: string;
      }[]
    | null
  >(null);
  const [revisions, setRevisions] = useState<TransformationRevisionList | null>(null);
  const [historyPending, setHistoryPending] = useState(false);
  const [historyFailure, setHistoryFailure] = useState(false);
  const [historyReadFailure, setHistoryReadFailure] = useState(false);
  const [historyReading, setHistoryReading] = useState(false);
  const [historyOffset, setHistoryOffset] = useState(0);
  const [historyRefresh, setHistoryRefresh] = useState(0);
  const historyRun = useRef(0);
  const revisionRun = useRef(0);
  const pendingCommand = useRef<Command | null>(null);
  const acknowledgedId = useRef<string | null>(null);
  const busyRef = useRef(false);
  const alive = useRef(true);
  const editGeneration = useRef(0);
  const draftRef = useRef(draft);
  const inputKeys = useRef<string[]>([]);
  const profileRequests = useRef(new Map<string, string>());
  const heading = useRef<HTMLHeadingElement>(null);
  const canWrite =
    canTransform &&
    (savedRecord === null ||
      savedRecord.revision === 1 ||
      (savedRecord.revision > 1 && canManageQa)) &&
    (savedRecord === null || savedRecord.status === "draft") &&
    !accessRecovery?.pending;
  const dirty = isDraft(savedRecord)
    ? JSON.stringify(draft) !== JSON.stringify(savedRecord.draft)
    : savedRecord === null && JSON.stringify(draft) !== JSON.stringify(emptyDraft);
  const protectedState =
    dirty ||
    lifecycleReasonDirty ||
    caseProtected ||
    uncertain ||
    readFailed ||
    pendingCommand.current !== null ||
    finalizeOpen;
  const disabled = busy || mutationPending || blocked || uncertain || readFailed || !canWrite;
  const canEditRef = useRef(!disabled);
  canEditRef.current = !disabled;
  draftRef.current = draft;
  const savedDraft = isDraft(savedRecord) ? savedRecord : null;
  const revisionLocked = (savedRecord?.revision ?? 1) > 1;
  const picker = { client, disabled, onSessionLost, onForbidden };

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    heading.current?.focus();
  }, [savedRecord?.id]);
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
    if (!canManageQa) setFinalizeOpen(false);
  }, [canManageQa]);
  useEffect(() => {
    const predecessorId = savedRecord?.lifecycle?.previousRevisionId;
    if (!predecessorId || savedRecord?.status !== "draft") return;
    let active = true;
    void client
      .getTransformation(predecessorId)
      .then((previous) => {
        if (!active || !("snapshot" in previous)) return;
        setPredecessorOutputs(
          previous.snapshot.outputs.map((row) => ({
            lotId: row.lotId,
            productId: row.product.id,
            tlc: row.tlc,
          })),
        );
      })
      .catch(async (error: unknown) => {
        if (!active) return;
        if (error instanceof UsClientError && error.code === "session_required") onSessionLost();
        if (error instanceof UsClientError && error.code === "forbidden") await onForbidden();
      });
    return () => {
      active = false;
    };
  }, [
    client,
    savedRecord?.id,
    savedRecord?.lifecycle?.previousRevisionId,
    savedRecord?.status,
    onForbidden,
    onSessionLost,
  ]);
  useEffect(() => {
    if (!eventId) return;
    let current = true;
    setLoading(true);
    setSourceFailed(false);
    void client
      .getTransformation(eventId)
      .then((record) => {
        if (!current) return;
        if (sourceTarget) {
          const lines =
            "snapshot" in record
              ? record.snapshot
              : {
                  inputs: record.draft.inputs.map((_, index) => ({ lineNo: index + 1 })),
                  outputs: record.draft.outputs.map((_, index) => ({ lineNo: index + 1 })),
                };
          if (!readinessSourceMatches(sourceTarget, record, lines)) {
            setSourceFailed(true);
            setLoading(false);
            return;
          }
        }
        revisionRun.current += 1;
        setHistoryReading(false);
        setSavedRecord(record);
        if (isDraft(record)) {
          setDraft(record.draft);
          inputKeys.current = record.draft.inputs.map(() => crypto.randomUUID());
        }
        setLoading(false);
        setLoadFailed(false);
      })
      .catch(async (error: unknown) => {
        if (!current) return;
        setLoading(false);
        setLoadFailed(true);
        if (sourceTarget && error instanceof UsClientError && error.code === "invalid_response")
          setSourceFailed(true);
        if (error instanceof UsClientError && error.code === "session_required") onSessionLost();
        if (error instanceof UsClientError && error.code === "forbidden") await onForbidden();
      });
    return () => {
      current = false;
    };
  }, [eventId, client, onForbidden, onSessionLost, sourceTarget, sourceRetry]);
  useEffect(() => {
    if (!savedRecord?.lifecycle) return;
    const record = savedRecord;
    const run = ++historyRun.current;
    setHistoryPending(true);
    setHistoryFailure(false);
    void client
      .listTransformationRevisions(record.id, { limit: 50, offset: historyOffset })
      .then((list) => {
        if (historyRun.current !== run) return;
        const first = list.items[0];
        if (
          first &&
          (first.rootId.toLowerCase() !== record.lifecycle?.rootId.toLowerCase() ||
            first.eventNumber !== record.eventNumber ||
            first.timeZone !== record.timeZone ||
            first.currentEventId?.toLowerCase() !==
              record.lifecycle?.currentEventId?.toLowerCase() ||
            first.pendingDraftId?.toLowerCase() !==
              record.lifecycle?.pendingDraftId?.toLowerCase() ||
            list.lifecycleVersion !== record.lifecycle?.lifecycleVersion)
        )
          throw new UsClientError("invalid_response");
        setRevisions(list);
      })
      .catch(async (error: unknown) => {
        if (historyRun.current !== run) return;
        setHistoryFailure(true);
        if (error instanceof UsClientError && error.code === "session_required") onSessionLost();
        if (error instanceof UsClientError && error.code === "forbidden") await onForbidden();
      })
      .finally(() => {
        if (historyRun.current === run) setHistoryPending(false);
      });
    return () => {
      historyRun.current += 1;
    };
  }, [client, savedRecord, historyOffset, historyRefresh, onForbidden, onSessionLost]);

  async function openRevision(id: string) {
    if (
      !savedRecord ||
      id === savedRecord.id ||
      protectedState ||
      busy ||
      mutationPending ||
      historyReading
    )
      return;
    const current = savedRecord;
    const run = ++revisionRun.current;
    setHistoryReading(true);
    setHistoryReadFailure(false);
    try {
      const next = await client.getTransformation(id);
      if (!alive.current || revisionRun.current !== run) return;
      if (
        next.id.toLowerCase() !== id.toLowerCase() ||
        next.eventNumber !== current.eventNumber ||
        next.timeZone !== current.timeZone ||
        next.lifecycle?.rootId.toLowerCase() !== current.lifecycle?.rootId.toLowerCase()
      )
        throw new UsClientError("invalid_response");
      setPredecessorOutputs(null);
      accept(next);
    } catch (error) {
      if (!alive.current || revisionRun.current !== run) return;
      setHistoryReadFailure(true);
      await handleAuth(error);
    } finally {
      if (alive.current && revisionRun.current === run) setHistoryReading(false);
    }
  }

  function edit(next: TransformationDraft) {
    if (disabled) return;
    revisionRun.current += 1;
    setHistoryReading(false);
    editGeneration.current += 1;
    draftRef.current = next;
    setDraft(next);
    setReadiness(null);
    setIssues([]);
    setCoverageFailure(null);
    setFinalizeOpen(false);
    setFailure(null);
  }
  function close() {
    if (busyRef.current || mutationPending) return;
    if (
      protectedState &&
      !window.confirm(
        t(uncertain || readFailed ? "transformation.leaveUncertain" : "md.discardConfirm"),
      )
    )
      return;
    onClose();
  }
  function openOutputLot(id: string) {
    if (
      busyRef.current ||
      mutationPending ||
      uncertain ||
      readFailed ||
      historyReading ||
      pendingCommand.current !== null
    )
      return;
    if (protectedState && !window.confirm(t("md.discardConfirm"))) return;
    onOpenLot(id);
  }
  async function handleAuth(error: unknown) {
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
  }
  function accept(record: TransformationHttpRecord) {
    revisionRun.current += 1;
    setHistoryReading(false);
    editGeneration.current += 1;
    setSavedRecord(record);
    setHistoryOffset(0);
    setHistoryReadFailure(false);
    if (isDraft(record)) {
      setDraft(record.draft);
      inputKeys.current = record.draft.inputs.map(() => crypto.randomUUID());
    }
    setReadiness(null);
    setIssues([]);
    setFailure(null);
    setDownstream(null);
    setBlocked(false);
    setUncertain(false);
    setReadFailed(false);
    setFinalizeOpen(false);
    setLoading(false);
    setLoadFailed(false);
    pendingCommand.current = null;
    acknowledgedId.current = null;
  }
  async function readCurrent(id: string) {
    revisionRun.current += 1;
    setHistoryReading(false);
    try {
      const current = await client.getTransformation(id);
      if (alive.current) accept(current);
    } catch (error) {
      if (!alive.current) return;
      setReadFailed(true);
      setBlocked(true);
      setFailure("readFailed");
      await handleAuth(error);
    }
  }
  async function runCommand() {
    const command = pendingCommand.current;
    if (!command || busyRef.current || mutationPending) return;
    if (command.kind === "finalize" || command.kind === "amend" || command.kind === "void") {
      if (!canManageQa) return;
    } else if (!canWrite) return;
    revisionRun.current += 1;
    setHistoryReading(false);
    busyRef.current = true;
    setBusy(true);
    setFailure(null);
    setDownstream(null);
    const release = beginMutation();
    try {
      const receipt =
        command.kind === "create"
          ? await client.createTransformation(command.payload)
          : command.kind === "save"
            ? await client.saveTransformation(command.id, command.payload)
            : command.kind === "finalize"
              ? await client.finalizeTransformation(command.id, command.payload)
              : command.kind === "amend"
                ? await client.amendTransformation(command.id, command.payload)
                : await client.voidTransformation(command.id, command.payload);
      if (!alive.current) return;
      const id = "eventId" in receipt ? receipt.eventId : receipt.id;
      acknowledgedId.current = id;
      setUncertain(false);
      setBlocked(true);
      await readCurrent(id);
    } catch (error) {
      if (!alive.current) return;
      const code = error instanceof UsClientError ? error.code : "unavailable";
      const recovery = transformationRecovery[code];
      if (await handleAuth(error)) {
        if (!uncertain) pendingCommand.current = null;
        setFailure("qaOnly");
      } else if (
        error instanceof UsTransformationConflictError &&
        error.code === "event_incomplete"
      ) {
        pendingCommand.current = null;
        setUncertain(false);
        setIssues(error.issues ?? []);
        setReadiness(null);
        setBlocked(true);
        setFailure("incomplete");
      } else if (recovery || code === "conflict") {
        pendingCommand.current = null;
        setUncertain(false);
        setReadiness(null);
        // A rejected create has no persisted record to reload; let the user correct its references.
        setBlocked(!(command.kind === "create" && code === "transformation_reference_not_found"));
        setFailure(recovery ?? "stale");
        if (
          error instanceof UsTransformationConflictError &&
          error.code === "traceability_downstream_blocked"
        ) {
          setDownstream({ blockers: error.blockers ?? [], hasMore: error.hasMore ?? false });
        }
      } else if (["invalid_input", "request_rejected"].includes(code)) {
        pendingCommand.current = null;
        setUncertain(false);
        setFailure("saveFailed");
      } else {
        // The server may have accepted this exact body. Keep it frozen for a same-intent retry.
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
    const parsed = transformationDraftSchema.safeParse(draft);
    if (!parsed.success) {
      setFailure("invalid");
      return;
    }
    const operationKey = crypto.randomUUID();
    pendingCommand.current = savedDraft
      ? {
          kind: "save",
          id: savedDraft.id,
          operationKey,
          payload: {
            operationKey,
            expectedDraftVersion: savedDraft.draftVersion,
            draft: parsed.data,
          },
        }
      : { kind: "create", id: null, operationKey, payload: { operationKey, draft: parsed.data } };
    void runCommand();
  }
  async function reload() {
    if (busyRef.current || mutationPending) return;
    const id = acknowledgedId.current ?? savedRecord?.id ?? eventId;
    if (!id) return;
    if (uncertain && !acknowledgedId.current && !window.confirm(t("transformation.abandonConfirm")))
      return;
    if (
      !uncertain &&
      !acknowledgedId.current &&
      dirty &&
      !window.confirm(t("transformation.reloadConfirm"))
    )
      return;
    busyRef.current = true;
    setBusy(true);
    try {
      const current = await client.getTransformation(id);
      if (alive.current) accept(current);
    } catch (error) {
      if (alive.current) {
        setFailure("loadError");
        await handleAuth(error);
      }
    } finally {
      busyRef.current = false;
      if (alive.current) setBusy(false);
    }
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
    const generation = editGeneration.current;
    const id = savedDraft.id,
      version = savedDraft.draftVersion;
    busyRef.current = true;
    setBusy(true);
    setFailure(null);
    try {
      const result = await client.checkTransformationReadiness(id, version);
      if (alive.current && generation === editGeneration.current) {
        setReadiness(result);
        setIssues(result.issues);
      }
    } catch (error) {
      if (!alive.current) return;
      const code = error instanceof UsClientError ? error.code : "unavailable";
      if (await handleAuth(error)) setFailure("qaOnly");
      else if (
        error instanceof UsTransformationConflictError &&
        error.code === "event_incomplete"
      ) {
        setIssues(error.issues ?? []);
        setReadiness(null);
        setBlocked(true);
        setFailure("incomplete");
      } else if (
        code === "transformation_draft_conflict" ||
        code === "transformation_readiness_changed"
      ) {
        setBlocked(true);
        setFailure("stale");
      } else setFailure("checkFailed");
    } finally {
      busyRef.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function finalize() {
    if (
      !canManageQa ||
      !savedDraft ||
      dirty ||
      blocked ||
      pendingCommand.current !== null ||
      acknowledgedId.current !== null ||
      uncertain ||
      readFailed ||
      busyRef.current ||
      mutationPending ||
      readiness?.state !== "complete" ||
      readiness.eventId !== savedDraft.id ||
      readiness.expectedDraftVersion !== savedDraft.draftVersion
    )
      return;
    const operationKey = crypto.randomUUID();
    pendingCommand.current = {
      kind: "finalize",
      id: savedDraft.id,
      operationKey,
      payload: {
        operationKey,
        expectedDraftVersion: savedDraft.draftVersion,
        expectedInputDigest: readiness.inputDigest,
      },
    };
    setFinalizeOpen(false);
    await runCommand();
  }
  async function lifecycle(action: TransformationLifecycleAction, reason: string) {
    if (
      !canManageQa ||
      !savedRecord?.lifecycle ||
      blocked ||
      dirty ||
      caseProtected ||
      pendingCommand.current !== null ||
      acknowledgedId.current !== null ||
      uncertain ||
      readFailed ||
      busyRef.current ||
      mutationPending
    )
      return;
    const operationKey = crypto.randomUUID();
    pendingCommand.current = {
      kind: action,
      id: savedRecord.id,
      operationKey,
      payload: {
        operationKey,
        expectedLifecycleVersion: savedRecord.lifecycle.lifecycleVersion,
        reason,
        ...(action === "void" && savedRecord.status === "draft"
          ? { expectedDraftVersion: savedRecord.draftVersion }
          : {}),
      },
    };
    await runCommand();
  }
  async function selectNonFtlProduct(index: number, id: string) {
    const rowKey = inputKeys.current[index];
    if (!rowKey || !canEditRef.current) return;
    const requestKey = crypto.randomUUID();
    profileRequests.current.set(rowKey, requestKey);
    if (!id) {
      replaceInput(index, { ...emptyNonFtl });
      return;
    }
    try {
      const profile = await client.getProductProfile(id);
      const currentIndex = inputKeys.current.indexOf(rowKey);
      if (
        !alive.current ||
        !canEditRef.current ||
        currentIndex < 0 ||
        profileRequests.current.get(rowKey) !== requestKey
      )
        return;
      if (profile.coverageStatus !== "not_covered") {
        setCoverageFailure("nonFtlCoverage");
        return;
      }
      const current = draftRef.current;
      const row = current.inputs[currentIndex];
      if (row?.kind === "non_ftl")
        edit({
          ...current,
          inputs: current.inputs.map((line, i) =>
            i === currentIndex ? { ...row, productId: id } : line,
          ),
        });
    } catch (error) {
      if (
        !alive.current ||
        !canEditRef.current ||
        profileRequests.current.get(rowKey) !== requestKey
      )
        return;
      setCoverageFailure("profileFailed");
      await handleAuth(error);
    }
  }
  function replaceInput(index: number, value: TransformationDraft["inputs"][number]) {
    edit({ ...draft, inputs: draft.inputs.map((row, i) => (i === index ? value : row)) });
  }
  function replaceOutput(index: number, value: TransformationDraft["outputs"][number]) {
    edit({ ...draft, outputs: draft.outputs.map((row, i) => (i === index ? value : row)) });
  }
  const unitOptions = [
    { value: "", label: t("transformation.choose") },
    ...UOM_CODES_V1.map((value) => ({ value, label: value })),
  ];
  const reasonOptions = [
    { value: "", label: t("transformation.choose") },
    ...(
      ["commingling_and_repacking", "repacking", "relabeling", "processing", "other"] as const
    ).map((value) => ({ value, label: t(`transformation.${value}`) })),
  ];

  const sourceRef = useReadinessSourceFocus(sourceTarget, savedRecord?.id);
  if (sourceFailed)
    return (
      <ReadinessSourceError
        disabled={busy || mutationPending}
        onRetry={() => setSourceRetry((n) => n + 1)}
        onBack={close}
      />
    );
  if (loading || loadFailed)
    return (
      <div className="us-tr-page">
        {sourceTarget ? (
          <Button variant="secondary" disabled={busy || mutationPending} onClick={close}>
            {backLabel ?? t("events.back")}
          </Button>
        ) : null}
        {fallback}
        <p role={loadFailed ? "alert" : "status"}>
          {t(loadFailed ? "transformation.loadError" : "md.stale")}
        </p>
        {loadFailed ? (
          <Button
            type="button"
            onClick={() => (sourceTarget ? setSourceRetry((n) => n + 1) : void reload())}
          >
            {t("md.retry")}
          </Button>
        ) : null}
      </div>
    );

  return (
    <div ref={sourceRef} className="us-tr-page" aria-busy={busy}>
      <Button type="button" variant="secondary" disabled={busy || mutationPending} onClick={close}>
        {backLabel ?? t("events.back")}
      </Button>
      {sourceTarget && savedRecord?.id === sourceTarget.eventId ? (
        <ReadinessSourceNotice target={sourceTarget} />
      ) : null}
      <header className="us-tr-header">
        <span className="us-tr-kicker">
          {savedRecord
            ? `${t("receiving.revision")} ${savedRecord.revision} · ${t(`events.${savedRecord.status}`)}`
            : t("transformation.new")}
        </span>
        <h1 ref={heading} tabIndex={-1} className="us-tr-mono">
          {savedRecord?.eventNumber ?? t("transformation.title")}
        </h1>
        <p>{savedRecord?.timeZone ?? timeZone}</p>
        {savedRecord?.lifecycle ? (
          <p className="us-tr-hint">
            {t("transformation.current")}:{" "}
            <span className="us-tr-mono">{savedRecord.lifecycle.currentEventId ?? "—"}</span> ·{" "}
            {t("transformation.previous")}:{" "}
            <span className="us-tr-mono">{savedRecord.lifecycle.previousRevisionId ?? "—"}</span>
          </p>
        ) : null}
      </header>
      {failure ? (
        <div role="alert" className="us-tr-notice">
          {t(`transformation.${failure === "incomplete" ? "incomplete" : failure}`)}
        </div>
      ) : null}
      {coverageFailure ? (
        <p role="alert">
          {coverageFailure === "nonFtlCoverage"
            ? t("transformation.nonFtlCoverage")
            : t("transformation.profileFailed")}
        </p>
      ) : null}
      {downstream ? (
        <section className="us-tr-notice" aria-label={t("transformation.downstreamTitle")}>
          <ul aria-label={t("transformation.downstreamTitle")}>
            {downstream.blockers.map((blocker) => (
              <li className="us-tr-mono" key={`${blocker.lotId}/${blocker.eventId}`}>
                {t("transformation.downstreamItem", blocker)}
              </li>
            ))}
          </ul>
          {downstream.hasMore ? <p>{t("transformation.downstreamMore")}</p> : null}
        </section>
      ) : null}
      {uncertain && !readFailed ? (
        <Button
          type="button"
          disabled={busy || (!canWrite && !canManageQa)}
          onClick={() => void runCommand()}
        >
          {t("transformation.retrySame")}
        </Button>
      ) : null}
      {(blocked || readFailed || uncertain) && (savedRecord || acknowledgedId.current) ? (
        <Button type="button" variant="secondary" disabled={busy} onClick={() => void reload()}>
          {t("transformation.reload")}
        </Button>
      ) : null}
      {isDraft(savedRecord) || savedRecord === null ? (
        <>
          <form onSubmit={save}>
            <section className="us-tr-section" aria-labelledby="us-tr-event">
              <h2 id="us-tr-event">{t("transformation.title")}</h2>
              <div className="us-tr-fields">
                <Input
                  type="date"
                  label={t("transformation.completionDate")}
                  value={draft.eventDate ?? ""}
                  disabled={disabled}
                  onChange={(event) => edit({ ...draft, eventDate: event.target.value || null })}
                />
                <ReceivingReferencePicker
                  {...picker}
                  disabled={disabled || revisionLocked}
                  kind="location"
                  roles={["tlc_source"]}
                  label={t("transformation.processor")}
                  value={draft.processorLocationId ?? ""}
                  onChange={(id) => edit({ ...draft, processorLocationId: id || null })}
                />
                <Select
                  native
                  label={t("transformation.reason")}
                  value={draft.reason ?? ""}
                  disabled={disabled}
                  options={reasonOptions}
                  onValueChange={(value) =>
                    edit({
                      ...draft,
                      reason:
                        reasonOptions.some((row) => row.value === value) && value
                          ? (value as TransformationDraft["reason"])
                          : null,
                    })
                  }
                />
                <Textarea
                  label={t("transformation.reasonNote")}
                  value={draft.reasonNote ?? ""}
                  disabled={disabled}
                  maxLength={2000}
                  onChange={(event) => edit({ ...draft, reasonNote: event.target.value || null })}
                />
              </div>
              <Textarea
                label={t("transformation.notes")}
                value={draft.notes ?? ""}
                disabled={disabled}
                maxLength={2000}
                onChange={(event) => edit({ ...draft, notes: event.target.value || null })}
              />
              <p className="us-tr-hint">{t("transformation.source")}</p>
            </section>
            <section className="us-tr-section" aria-labelledby="us-tr-inputs">
              <h2 id="us-tr-inputs">{t("transformation.inputs")}</h2>
              {draft.inputs.map((row, index) => (
                <fieldset
                  className="us-tr-line"
                  key={inputKeys.current[index] ?? index}
                  disabled={disabled}
                >
                  <legend>
                    {t("transformation.input", { number: index + 1 })} ·{" "}
                    {t(`transformation.${row.kind === "ftl_lot" ? "ftl" : "nonFtl"}`)}
                  </legend>
                  {row.kind === "ftl_lot" ? (
                    <ReceivingReferencePicker
                      {...picker}
                      kind="lot"
                      label={t("transformation.lot")}
                      value={row.lotId ?? ""}
                      onChange={(id) => replaceInput(index, { ...row, lotId: id || null })}
                    />
                  ) : (
                    <div className="us-tr-fields">
                      <ReceivingReferencePicker
                        {...picker}
                        kind="product"
                        label={t("transformation.product")}
                        value={row.productId ?? ""}
                        onChange={(id) => {
                          void selectNonFtlProduct(index, id);
                        }}
                      />
                      <ReceivingReferencePicker
                        {...picker}
                        kind="location"
                        label={t("transformation.sourceLocation")}
                        value={row.sourceLocationId ?? ""}
                        onChange={(id) =>
                          replaceInput(index, { ...row, sourceLocationId: id || null })
                        }
                      />
                      <Input
                        label={t("transformation.reference")}
                        value={row.reference ?? ""}
                        maxLength={2000}
                        onChange={(event) =>
                          replaceInput(index, { ...row, reference: event.target.value || null })
                        }
                      />
                    </div>
                  )}
                  <div className="us-tr-fields">
                    <Input
                      label={t("transformation.quantity")}
                      inputMode="decimal"
                      value={row.quantity ?? ""}
                      maxLength={30}
                      onChange={(event) =>
                        replaceInput(index, { ...row, quantity: event.target.value || null })
                      }
                    />
                    <Select
                      native
                      label={t("transformation.unit")}
                      value={row.unitOfMeasure ?? ""}
                      options={unitOptions}
                      onValueChange={(unit) =>
                        replaceInput(index, {
                          ...row,
                          unitOfMeasure: UOM_CODES_V1.find((value) => value === unit) ?? null,
                        })
                      }
                    />
                  </div>
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={disabled}
                    onClick={() => {
                      inputKeys.current = inputKeys.current.filter((_, i) => i !== index);
                      edit({ ...draft, inputs: draft.inputs.filter((_, i) => i !== index) });
                    }}
                  >
                    {t("transformation.remove")}
                  </Button>
                </fieldset>
              ))}
              <div className="us-tr-actions">
                <Button
                  type="button"
                  variant="secondary"
                  disabled={disabled || draft.inputs.length >= 100}
                  onClick={() => {
                    inputKeys.current = [...inputKeys.current, crypto.randomUUID()];
                    edit({ ...draft, inputs: [...draft.inputs, { ...emptyFtl }] });
                  }}
                >
                  {t("transformation.addFtl")}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={disabled || draft.inputs.length >= 100}
                  onClick={() => {
                    inputKeys.current = [...inputKeys.current, crypto.randomUUID()];
                    edit({ ...draft, inputs: [...draft.inputs, { ...emptyNonFtl }] });
                  }}
                >
                  {t("transformation.addNonFtl")}
                </Button>
              </div>
            </section>
            <section className="us-tr-section" aria-labelledby="us-tr-outputs">
              <h2 id="us-tr-outputs">{t("transformation.outputs")}</h2>
              <p className="us-tr-hint">
                {t("transformation.source")} · {t("transformation.outputIdentity")}
              </p>
              {draft.outputs.map((row, index) => (
                <fieldset className="us-tr-line" key={index} disabled={disabled}>
                  <legend>{t("transformation.output", { number: index + 1 })}</legend>
                  {revisionLocked ? (
                    <p className="us-tr-hint us-tr-mono">
                      {predecessorOutputs?.[index]?.lotId ?? t("transformation.outputIdentity")}
                    </p>
                  ) : null}
                  <div className="us-tr-fields">
                    <ReceivingReferencePicker
                      {...picker}
                      disabled={disabled || revisionLocked}
                      kind="product"
                      label={t("transformation.product")}
                      value={row.productId ?? ""}
                      onChange={(id) => replaceOutput(index, { ...row, productId: id || null })}
                    />
                    <Input
                      label={t("transformation.tlc")}
                      value={row.tlc ?? ""}
                      disabled={disabled || revisionLocked}
                      maxLength={128}
                      onChange={(event) =>
                        replaceOutput(index, { ...row, tlc: event.target.value || null })
                      }
                    />
                    <Input
                      label={t("transformation.quantity")}
                      inputMode="decimal"
                      value={row.quantity ?? ""}
                      maxLength={30}
                      onChange={(event) =>
                        replaceOutput(index, { ...row, quantity: event.target.value || null })
                      }
                    />
                    <Select
                      native
                      label={t("transformation.unit")}
                      value={row.unitOfMeasure ?? ""}
                      options={unitOptions}
                      onValueChange={(unit) =>
                        replaceOutput(index, {
                          ...row,
                          unitOfMeasure: UOM_CODES_V1.find((value) => value === unit) ?? null,
                        })
                      }
                    />
                  </div>
                  {!revisionLocked ? (
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={disabled}
                      onClick={() =>
                        edit({ ...draft, outputs: draft.outputs.filter((_, i) => i !== index) })
                      }
                    >
                      {t("transformation.remove")}
                    </Button>
                  ) : null}
                </fieldset>
              ))}
              {!revisionLocked ? (
                <Button
                  type="button"
                  variant="secondary"
                  disabled={disabled || draft.outputs.length >= 100}
                  onClick={() =>
                    edit({ ...draft, outputs: [...draft.outputs, { ...emptyOutput }] })
                  }
                >
                  {t("transformation.addOutput")}
                </Button>
              ) : null}
            </section>
            <section className="us-tr-section" aria-labelledby="us-tr-documents">
              <h2 id="us-tr-documents">{t("transformation.documents")}</h2>
              {draft.documentIds.map((id) => (
                <div className="us-tr-document" key={id}>
                  <span className="us-tr-mono">{id}</span>
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
                    {t("transformation.detach")}
                  </Button>
                </div>
              ))}
              <ReceivingReferencePicker
                {...picker}
                kind="document"
                label={t("transformation.document")}
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
                {t("transformation.addDocument")}
              </Button>
            </section>
            <div className="us-tr-actions">
              <Button type="submit" disabled={disabled || (!dirty && savedRecord !== null)}>
                {t(busy ? "transformation.saving" : "transformation.save")}
              </Button>
            </div>
          </form>
          <TransformationReadinessPanel
            record={savedDraft}
            dirty={dirty}
            busy={
              busy ||
              blocked ||
              mutationPending ||
              pendingCommand.current !== null ||
              uncertain ||
              readFailed
            }
            readiness={readiness}
            issues={issues}
            onCheck={() => void checkReadiness()}
          />
          {canManageQa &&
          savedDraft &&
          !dirty &&
          !blocked &&
          pendingCommand.current === null &&
          acknowledgedId.current === null &&
          !uncertain &&
          !readFailed &&
          readiness?.state === "complete" &&
          readiness.expectedDraftVersion === savedDraft.draftVersion ? (
            <>
              <Button
                type="button"
                disabled={busy || mutationPending}
                onClick={() => setFinalizeOpen(true)}
              >
                {t("transformation.finalize")}
              </Button>
              {finalizeOpen ? (
                <div
                  role="dialog"
                  aria-modal="true"
                  aria-label={t("transformation.finalize")}
                  className="us-tr-dialog"
                >
                  <h3>{t("transformation.finalize")}</h3>
                  <p>
                    {t(
                      savedDraft.revision > 1
                        ? "transformation.finalizeAmendmentConfirm"
                        : "transformation.finalizeConfirm",
                      {
                        inputs: draft.inputs.length,
                        outputs: draft.outputs.length,
                        documents: draft.documentIds.length,
                      },
                    )}
                  </p>
                  <p>
                    {t("transformation.inputs")}: {quantitySummary(draft).inputs}
                  </p>
                  <p>
                    {t("transformation.outputs")}: {quantitySummary(draft).outputs}
                  </p>
                  <p>
                    {t(
                      savedDraft.revision > 1
                        ? "transformation.noCasesAmendment"
                        : "transformation.noCases",
                    )}
                  </p>
                  <div className="us-tr-actions">
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => setFinalizeOpen(false)}
                    >
                      {t("transformation.cancel")}
                    </Button>
                    <Button
                      type="button"
                      disabled={!canManageQa || busy}
                      onClick={() => void finalize()}
                    >
                      {t("transformation.confirm")}
                    </Button>
                  </div>
                </div>
              ) : null}
            </>
          ) : null}
        </>
      ) : (
        <TransformationDetail
          record={savedRecord}
          onOpenLot={openOutputLot}
          onOpenRevision={(id) => void openRevision(id)}
          evidence={{
            client,
            canWriteCases: canTransform && !accessRecovery?.pending,
            beginMutation,
            onForbidden,
            onSessionLost,
            onProtectedChange: setCaseProtected,
          }}
          navigationDisabled={
            busy ||
            mutationPending ||
            uncertain ||
            readFailed ||
            historyReading ||
            pendingCommand.current !== null
          }
        />
      )}
      {savedRecord ? (
        <TransformationLifecycleActions
          record={savedRecord}
          canManageQa={canManageQa}
          disabled={
            busy ||
            blocked ||
            mutationPending ||
            dirty ||
            caseProtected ||
            pendingCommand.current !== null ||
            uncertain ||
            readFailed
          }
          onSubmit={lifecycle}
          onReasonDirtyChange={setLifecycleReasonDirty}
        />
      ) : null}
      {savedRecord?.lifecycle ? (
        <>
          {historyReadFailure ? <p role="alert">{t("transformation.history.readFailed")}</p> : null}
          <TransformationRevisionHistory
            list={revisions}
            selectedEventId={savedRecord.id}
            onPage={setHistoryOffset}
            onOpenRevision={(id) => void openRevision(id)}
            pending={historyPending || historyReading || protectedState}
            failure={historyFailure}
            onRetry={() => setHistoryRefresh((value) => value + 1)}
          />
        </>
      ) : null}
    </div>
  );
}
