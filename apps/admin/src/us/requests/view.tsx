import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Input, Select } from "@markiro/ui";
import {
  usRequestListQuerySchema,
  usTraceRequestCreateBodySchema,
  type UsRequestDetailResponse,
  type UsRequestListResponse,
  type UsRequestCommandResponse,
  type UsTraceRequestCreateBody,
  type UsTraceRequestUpdateBody,
  usRequestValidationHttpResponseSchema,
  usRequestWarningAckHttpBodySchema,
  usRequestPrepareResponseSchema,
  usRequestRunDetailSchema,
  type UsRequestPrepareHttpBody,
  type UsRequestPrepareResponse,
  type UsRequestRunDetail,
  type UsRequestRunListResponse,
  type UsRequestAttemptListResponse,
  usRequestRetryResponseSchema,
} from "@markiro/platform-contracts";
import { useTranslation } from "react-i18next";
import { UsClientError, type UsBrowserClient } from "../client.js";
import type { ReadinessEventTarget } from "../readiness/source.js";
import { createRequestFence } from "./async-ownership.js";
import { RequestList } from "./list.js";
import { RequestCard } from "./card.js";
import { RequestEditor } from "./editor.js";
import { RequestScopeEditor } from "./scope-editor.js";
import { parseRequestScope, scopeToFields, type RequestScopeFields } from "./scope.js";
import { getRequestCopy } from "./copy.js";
import type { UsRequestListInput } from "./types.js";
import {
  RequestValidation,
  matchingRequestValidation,
  type RequestFreshValidation,
} from "./validation.js";
import { RequestPreparation, requestCanPrepare } from "./preparation.js";
import {
  makeRequestPrepareIntent,
  makeRequestRetryIntent,
  type RequestPrepareIntent,
  type RequestRetryIntent,
} from "./command-intent.js";
import { RequestRuns, RequestAttempts } from "./runs.js";
import { RequestRunDetail } from "./run-detail.js";
import { startRequestPolling, type RequestPollingOptions } from "./polling.js";
import type { UsRequestArtifact } from "./types.js";
import "./requests.css";

export type RequestEntry = { requestId?: string; runId?: string };
export type RequestsViewProps = {
  client: UsBrowserClient;
  organizationId: string;
  profile: Awaited<ReturnType<UsBrowserClient["profile"]>>;
  canRead: boolean;
  canManageQa: boolean;
  canExport: boolean;
  authorityPending: boolean;
  entry: RequestEntry;
  onEntryChange?: (entry: RequestEntry) => void;
  onForbidden: () => Promise<void>;
  onSessionLost: () => void;
  onDirtyChange: (dirty: boolean) => void;
  onMutationPendingChange: (pending: boolean) => void;
  onOpenSource: (target: ReadinessEventTarget) => void;
  onOpenLot: (lotId: string) => void;
};
type Read<T> = {
  value: T | null;
  pending: boolean;
  error: "failed" | "forbidden" | "missing" | null;
  stale: boolean;
};
const emptyRead = <T,>(): Read<T> => ({ value: null, pending: false, error: null, stale: false });
type Draft = {
  generation: number;
  kind: "requester" | "scope";
  baseline: UsRequestDetailResponse | null;
  scope: RequestScopeFields;
};
type Outcome = {
  kind: "accepted" | "ambiguous" | "conflict" | "noMatch";
  requestId: string | null;
  requestNumber: string;
  receipt: UsRequestCommandResponse | null;
  operation: "create" | "update" | "close";
};
type PreparationIntent = RequestPrepareIntent & { receipt?: UsRequestPrepareResponse };

export function RequestsView(props: RequestsViewProps) {
  const { i18n } = useTranslation();
  const copy = getRequestCopy(i18n.language);
  if (!props.canRead || props.profile.code !== "US_FSMA204_PROCESSOR")
    return (
      <section className="us-requests">
        <h1 tabIndex={-1}>{copy.title}</h1>
        <p>{copy.localNotice}</p>
        <p role="alert">{copy.unavailable}</p>
      </section>
    );
  return <RequestsWorkspace key={props.organizationId} {...props} />;
}

function RequestsWorkspace(props: RequestsViewProps) {
  const { i18n } = useTranslation();
  const copy = getRequestCopy(i18n.language);
  const { client, organizationId, profile, authorityPending } = props;
  const callbacks = useRef(props);
  callbacks.current = props;
  const heading = useRef<HTMLHeadingElement>(null);
  const [list, setList] = useState<Read<UsRequestListResponse>>(emptyRead);
  const [card, setCard] = useState<Read<UsRequestDetailResponse>>(emptyRead);
  const cardRef = useRef(card);
  cardRef.current = card;
  const [selected, setSelected] = useState<RequestEntry>(props.entry);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const [query, setQuery] = useState<UsRequestListInput>({ limit: "25", offset: "0" });
  const [number, setNumber] = useState("");
  const [status, setStatus] = useState<"" | "open" | "closed">("");
  const [invalid, setInvalid] = useState(false);
  const [listRetry, setListRetry] = useState(0);
  const [cardRetry, setCardRetry] = useState(0);
  const [stopped, setStopped] = useState(false);
  const [refreshPending, setRefreshPending] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [sessionLookupError, setSessionLookupError] = useState(false);
  const [sessionLookupPending, setSessionLookupPending] = useState(false);
  const [sessionRetry, setSessionRetry] = useState(0);
  const [actorId, setActorId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const draftGeneration = useRef(0);
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  const [mutationPending, setMutationPending] = useState(false);
  const mutationOwner = useRef<object | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const outcomeRef = useRef<Outcome | null>(null);
  const [notice, setNotice] = useState<
    | "savedCurrent"
    | "savedCandidate"
    | "commandRejected"
    | "validationFailed"
    | "selectionLimit"
    | "snapshotLimit"
    | "scopeRequired"
    | "conflict"
    | "ambiguous"
    | "acceptedRefresh"
    | null
  >(null);
  const [scopeInvalid, setScopeInvalid] = useState(false);
  const [closeConfirm, setCloseConfirm] = useState(false);
  // Task 6's fresh-validation seam: edits/save/close immediately invalidate it.
  const [validationGeneration, setValidationGeneration] = useState(0);
  const validationGenerationRef = useRef(validationGeneration);
  validationGenerationRef.current = validationGeneration;
  const [freshState, setFreshState] = useState<{
    value: RequestFreshValidation;
    generation: number;
  } | null>(null);
  const [intent, setIntent] = useState<PreparationIntent | null>(null);
  const intentRef = useRef<PreparationIntent | null>(null);
  const [retryIntent, setRetryIntent] = useState<RequestRetryIntent | null>(null);
  const retryIntentRef = useRef<RequestRetryIntent | null>(null);
  const [retryNotice, setRetryNotice] = useState<
    "retryAccepted" | "retryAmbiguous" | "retryRejected" | null
  >(null);
  const [runRead, setRunRead] = useState<Read<UsRequestRunDetail>>(emptyRead);
  const runRef = useRef(runRead);
  runRef.current = runRead;
  const [history, setHistory] = useState<Read<UsRequestRunListResponse>>(emptyRead);
  const [attempts, setAttempts] = useState<Read<UsRequestAttemptListResponse>>(emptyRead);
  const [runRefresh, setRunRefresh] = useState(0);
  const [pollResume, setPollResume] = useState(0);
  const [pollPause, setPollPause] = useState<
    Parameters<RequestPollingOptions["onPause"]>[0] | null
  >(null);
  const pollPauseRef = useRef<Parameters<RequestPollingOptions["onPause"]>[0] | null>(null);
  const [lastRunUpdate, setLastRunUpdate] = useState<string | null>(null);
  const [downloadActive, setDownloadActive] = useState(false);
  const [downloadError, setDownloadError] = useState(false);
  const preparedSeed = useRef<string | null>(null);
  const [visible, setVisible] = useState(document.visibilityState === "visible");
  const downloadOwner = useRef<AbortController | null>(null);
  const blobUrls = useRef(new Set<string>());
  const runFence = useRef(createRequestFence());
  const historyFence = useRef(createRequestFence());
  const attemptsFence = useRef(createRequestFence());
  const historyOwner = useRef<{ epoch: number; controller: AbortController } | null>(null);
  const attemptsOwner = useRef<{ epoch: number; controller: AbortController } | null>(null);
  const identity = useRef({
    client,
    canRead: props.canRead,
    canManageQa: props.canManageQa,
    canExport: props.canExport,
    authorityPending,
    entry: props.entry,
  });
  const identityEpoch = useRef(0);
  if (
    identity.current.client !== client ||
    identity.current.canRead !== props.canRead ||
    identity.current.canManageQa !== props.canManageQa ||
    identity.current.canExport !== props.canExport ||
    identity.current.authorityPending !== authorityPending ||
    identity.current.entry.requestId !== props.entry.requestId ||
    identity.current.entry.runId !== props.entry.runId
  ) {
    identityEpoch.current += 1;
    identity.current = {
      client,
      canRead: props.canRead,
      canManageQa: props.canManageQa,
      canExport: props.canExport,
      authorityPending,
      entry: props.entry,
    };
  }
  const readIdentityEpoch = identityEpoch.current;
  const listFence = useRef(createRequestFence());
  const cardFence = useRef(createRequestFence());
  const sessionFence = useRef(createRequestFence());
  const alive = useRef(true);
  const sessionLost = useRef(false);
  const refreshFence = useRef(0);
  const denied = useRef({ list: false, card: false, session: false });
  const sessionRequiresRetry = useRef(false);
  const blocked = stopped || authorityPending || refreshPending || refreshFailed;
  const blockedRef = useRef(blocked);
  blockedRef.current = blocked;
  const fresh =
    freshState?.generation === validationGeneration &&
    !blocked &&
    !card.pending &&
    !card.stale &&
    !draft
      ? freshState.value
      : null;
  const commandAllowed = () =>
    !blockedRef.current &&
    callbacks.current.canRead &&
    callbacks.current.canManageQa &&
    callbacks.current.canExport;
  const reportUnresolved = useCallback(() => {
    callbacks.current.onDirtyChange(
      dirtyRef.current ||
        outcomeRef.current !== null ||
        intentRef.current !== null ||
        retryIntentRef.current !== null,
    );
  }, []);
  function recordIntent(value: PreparationIntent | null) {
    intentRef.current = value;
    setIntent(value);
    reportUnresolved();
  }
  useEffect(() => {
    if (blocked || card.pending || card.stale) setFreshState(null);
  }, [blocked, card.pending, card.stale]);
  useEffect(() => {
    setFreshState(null);
    setValidationGeneration((current) => current + 1);
  }, [blocked, props.canRead, props.canManageQa, props.canExport]);

  useEffect(() => {
    const fences = [
      listFence.current,
      cardFence.current,
      sessionFence.current,
      runFence.current,
      historyFence.current,
      attemptsFence.current,
    ];
    const urls = blobUrls.current;
    heading.current?.focus();
    alive.current = true;
    return () => {
      alive.current = false;
      for (const fence of fences) fence.invalidate();
      refreshFence.current += 1;
      downloadOwner.current?.abort();
      historyOwner.current?.controller.abort();
      attemptsOwner.current?.controller.abort();
      for (const url of urls) URL.revokeObjectURL(url);
      urls.clear();
      if (mutationOwner.current) {
        mutationOwner.current = null;
        callbacks.current.onMutationPendingChange(false);
      }
      callbacks.current.onDirtyChange(false);
    };
  }, []);

  useEffect(() => {
    setSelected((current) =>
      current.requestId === props.entry.requestId && current.runId === props.entry.runId
        ? current
        : props.entry,
    );
  }, [props.entry.requestId, props.entry.runId, props.entry]);

  const loseSession = useCallback(() => {
    if (sessionLost.current || !alive.current) return;
    sessionLost.current = true;
    blockedRef.current = true;
    downloadOwner.current?.abort();
    runFence.current.invalidate();
    historyFence.current.invalidate();
    attemptsFence.current.invalidate();
    listFence.current.invalidate();
    cardFence.current.invalidate();
    sessionFence.current.invalidate();
    refreshFence.current += 1;
    setStopped(true);
    setActorId(null);
    setSessionLookupPending(false);
    setList(emptyRead());
    setCard(emptyRead());
    setDraft(null);
    dirtyRef.current = false;
    setDirty(false);
    setOutcome(null);
    outcomeRef.current = null;
    setFreshState(null);
    intentRef.current = null;
    setIntent(null);
    retryIntentRef.current = null;
    setRetryIntent(null);
    setRunRead(emptyRead());
    setHistory(emptyRead());
    setAttempts(emptyRead());
    callbacks.current.onDirtyChange(false);
    callbacks.current.onSessionLost();
  }, []);

  const rejectedRead = useCallback(async () => {
    const token = ++refreshFence.current;
    blockedRef.current = true;
    downloadOwner.current?.abort();
    setRefreshPending(true);
    setActorId(null);
    sessionFence.current.invalidate();
    try {
      await callbacks.current.onForbidden();
    } catch {
      if (alive.current && token === refreshFence.current) setRefreshFailed(true);
    } finally {
      if (alive.current && token === refreshFence.current) setRefreshPending(false);
    }
  }, []);

  useEffect(() => {
    if (blocked || denied.current.session || sessionRequiresRetry.current) return;
    const fence = sessionFence.current;
    const token = fence.issue(organizationId);
    setSessionLookupPending(true);
    void client
      .session()
      .then((session) => {
        if (!fence.owns(token) || !alive.current) return;
        if (session === null || session.activeOrganizationId !== organizationId) {
          loseSession();
          return;
        }
        // The verified actor is only a retry identity, never a source of capabilities.
        setActorId(session.user.id);
        setSessionLookupError(false);
      })
      .catch((error: unknown) => {
        if (!fence.owns(token) || !alive.current) return;
        setActorId(null);
        if (error instanceof UsClientError && error.code === "session_required") loseSession();
        else if (error instanceof UsClientError && error.code === "forbidden") {
          denied.current.session = true;
          void rejectedRead();
        } else {
          sessionRequiresRetry.current = true;
          setSessionLookupError(true);
        }
      })
      .finally(() => {
        if (fence.owns(token) && alive.current) setSessionLookupPending(false);
      });
    return () => {
      fence.invalidate();
      if (alive.current) setSessionLookupPending(false);
    };
  }, [client, organizationId, blocked, sessionRetry, loseSession, rejectedRead]);

  useEffect(() => {
    if (blocked || denied.current.list || mutationOwner.current) return;
    const fence = listFence.current;
    const controller = new AbortController();
    const token = fence.issue(`${organizationId}:${JSON.stringify(query)}`);
    setList((current) => ({
      ...current,
      pending: true,
      error: null,
      stale: current.value !== null,
    }));
    void client.requests
      .list(query, controller.signal)
      .then((value) => {
        if (!fence.owns(token) || !alive.current) return;
        setList({ value, pending: false, error: null, stale: false });
      })
      .catch((error: unknown) => {
        if (!fence.owns(token) || !alive.current) return;
        if (error instanceof UsClientError && error.code === "session_required") {
          loseSession();
          return;
        }
        if (error instanceof UsClientError && error.code === "forbidden") {
          denied.current.list = true;
          setList({ ...emptyRead(), error: "forbidden" });
          void rejectedRead();
          return;
        }
        setList((current) => ({
          ...current,
          pending: false,
          error: "failed",
          stale: current.value !== null,
        }));
      });
    return () => {
      fence.invalidate();
      controller.abort();
    };
  }, [client, organizationId, query, listRetry, blocked, loseSession, rejectedRead]);

  useEffect(() => {
    const id = selected.requestId;
    if (!id) {
      setCard(emptyRead());
      return;
    }
    if (blocked || denied.current.card) return;
    if (outcomeRef.current || mutationOwner.current) return;
    const fence = cardFence.current;
    const controller = new AbortController();
    const token = fence.issue(`${organizationId}:${id}`);
    setCard((current) => ({
      ...current,
      pending: true,
      error: null,
      stale: current.value !== null,
    }));
    void client.requests
      .get(id, controller.signal)
      .then((value) => {
        if (!fence.owns(token) || !alive.current || selectedRef.current.requestId !== id) return;
        if (value.id !== id) {
          setCard({ ...emptyRead(), error: "failed" });
          return;
        }
        setCard({ value, pending: false, error: null, stale: false });
      })
      .catch((error: unknown) => {
        if (!fence.owns(token) || !alive.current || selectedRef.current.requestId !== id) return;
        if (error instanceof UsClientError && error.code === "session_required") {
          loseSession();
          return;
        }
        if (error instanceof UsClientError && error.code === "forbidden") {
          denied.current.card = true;
          setCard({ ...emptyRead(), error: "forbidden" });
          void rejectedRead();
          return;
        }
        if (error instanceof UsClientError && error.code === "us_request_not_found") {
          setCard({ ...emptyRead(), error: "missing" });
          return;
        }
        setCard((current) => ({
          ...current,
          pending: false,
          error: "failed",
          stale: current.value !== null,
        }));
      });
    return () => {
      fence.invalidate();
      controller.abort();
    };
  }, [client, organizationId, selected.requestId, cardRetry, blocked, loseSession, rejectedRead]);

  function runOwns(requestId: string, runId: string, epoch: number) {
    return (
      alive.current &&
      !sessionLost.current &&
      !blockedRef.current &&
      callbacks.current.canRead &&
      selectedRef.current.requestId === requestId &&
      selectedRef.current.runId === runId &&
      identityEpoch.current === epoch
    );
  }
  useEffect(() => {
    const historyRead = historyOwner.current;
    if (historyRead && (historyRead.epoch !== readIdentityEpoch || blocked)) {
      historyRead.controller.abort();
      if (historyOwner.current === historyRead) {
        historyOwner.current = null;
        historyFence.current.invalidate();
        setHistory((current) => ({ ...current, pending: false, stale: current.value !== null }));
      }
    }
    const attemptRead = attemptsOwner.current;
    if (attemptRead && (attemptRead.epoch !== readIdentityEpoch || blocked)) {
      attemptRead.controller.abort();
      if (attemptsOwner.current === attemptRead) {
        attemptsOwner.current = null;
        attemptsFence.current.invalidate();
        setAttempts((current) => ({ ...current, pending: false, stale: current.value !== null }));
      }
    }
  }, [readIdentityEpoch, blocked]);
  useEffect(() => {
    historyOwner.current?.controller.abort();
    historyOwner.current = null;
    historyFence.current.invalidate();
    setHistory(emptyRead());
  }, [selected.requestId]);
  useEffect(() => {
    attemptsOwner.current?.controller.abort();
    attemptsOwner.current = null;
    attemptsFence.current.invalidate();
    setAttempts(emptyRead());
  }, [selected.runId]);
  useEffect(() => {
    pollPauseRef.current = null;
    setPollPause(null);
  }, [selected.requestId, selected.runId]);
  useEffect(() => {
    const visibility = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", visibility);
    return () => document.removeEventListener("visibilitychange", visibility);
  }, []);
  function acceptRun(value: UsRequestRunDetail, requestId: string, runId: string) {
    const run = usRequestRunDetailSchema.parse(value);
    if (run.requestId !== requestId || run.runId !== runId)
      throw new UsClientError("invalid_response");
    setRunRead({ value: run, pending: false, stale: false, error: null });
    runRef.current = { value: run, pending: false, stale: false, error: null };
    setLastRunUpdate(new Date().toISOString());
    if (run.status === "ready") setRetryNotice(null);
    return run;
  }
  const runError = useCallback(
    (error: unknown) => {
      if (error instanceof UsClientError && error.code === "session_required") {
        loseSession();
        return "stop" as const;
      }
      if (error instanceof UsClientError && error.code === "forbidden") {
        void rejectedRead();
        return "stop" as const;
      }
      if (
        !(error instanceof UsClientError) ||
        error.code === "unavailable" ||
        error.code === "rate_limited"
      )
        return "transient" as const;
      return "stop" as const;
    },
    [loseSession, rejectedRead],
  );
  useEffect(() => {
    const requestId = selected.requestId;
    const runId = selected.runId;
    const fence = runFence.current;
    const controller = new AbortController();
    const epoch = identityEpoch.current;
    if (!requestId || !runId) {
      setRunRead(emptyRead());
      setAttempts(emptyRead());
      setLastRunUpdate(null);
      return;
    }
    if (blocked || mutationOwner.current) return;
    // Prepare has already verified this exact receipt's run, so retain its read.
    if (preparedSeed.current === runId) {
      preparedSeed.current = null;
      return;
    }
    const token = fence.issue(`${organizationId}:${requestId}:${runId}`);
    setRunRead((current) => ({
      ...current,
      pending: true,
      stale: current.value !== null,
      error: null,
    }));
    void client.requests
      .getRun(runId, controller.signal)
      .then((value) => {
        if (!fence.owns(token) || !runOwns(requestId, runId, epoch)) return;
        acceptRun(value, requestId, runId);
      })
      .catch((error: unknown) => {
        if (!fence.owns(token) || !runOwns(requestId, runId, epoch)) return;
        runError(error);
        setRunRead((current) => ({
          ...current,
          pending: false,
          stale: current.value !== null,
          error: "failed",
        }));
      });
    return () => {
      fence.invalidate();
      controller.abort();
    };
  }, [
    client,
    organizationId,
    selected.requestId,
    selected.runId,
    blocked,
    runRefresh,
    props.canManageQa,
    props.canExport,
    runError,
  ]);
  const runPollable =
    !!runRead.value && (runRead.value.status === "queued" || runRead.value.status === "processing");
  useEffect(() => {
    const requestId = selected.requestId;
    const runId = selected.runId;
    if (
      !requestId ||
      !runId ||
      !runPollable ||
      runRead.pending ||
      runRead.stale ||
      blocked ||
      mutationPending ||
      pollPauseRef.current !== null
    )
      return;
    const epoch = identityEpoch.current;
    const controller = new AbortController();
    let active = true;
    const ownsPoll = () => active && runOwns(requestId, runId, epoch) && !mutationOwner.current;
    const poll = startRequestPolling({
      read: async () => {
        const run = usRequestRunDetailSchema.parse(
          await client.requests.getRun(runId, controller.signal),
        );
        if (run.runId !== runId || run.requestId !== requestId)
          throw new UsClientError("invalid_response");
        return run;
      },
      onValue: (value) => {
        if (ownsPoll()) acceptRun(value, requestId, runId);
      },
      onPause: (reason) => {
        if (active && alive.current && selectedRef.current.runId === runId) {
          pollPauseRef.current = reason;
          setPollPause(reason);
        }
      },
      onError: runError,
      owns: ownsPoll,
      isVisible: () => document.visibilityState === "visible",
      now: () => Date.now(),
    });
    setPollPause(null);
    const hidden = () => {
      if (document.visibilityState !== "visible") {
        poll.stop();
        controller.abort();
        if (ownsPoll()) {
          pollPauseRef.current = "hidden";
          setPollPause("hidden");
        }
      }
    };
    document.addEventListener("visibilitychange", hidden);
    hidden();
    return () => {
      active = false;
      poll.stop();
      controller.abort();
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [
    client,
    selected.requestId,
    selected.runId,
    runPollable,
    runRead.pending,
    runRead.stale,
    blocked,
    mutationPending,
    pollResume,
    props.canRead,
    props.canManageQa,
    props.canExport,
    runError,
  ]);
  useEffect(() => {
    downloadOwner.current?.abort();
    downloadOwner.current = null;
    setDownloadActive(false);
  }, [
    client,
    selected.requestId,
    selected.runId,
    props.canExport,
    props.canRead,
    blocked,
    actorId,
    card.value?.revision,
    runRead.value?.lifecycleVersion,
    runRead.value?.scopedContentDigest,
  ]);

  async function readHistory(offset: number) {
    const requestId = selectedRef.current.requestId;
    if (!requestId || blockedRef.current || mutationOwner.current) return;
    const epoch = identityEpoch.current;
    const fence = historyFence.current;
    const token = fence.issue(`${organizationId}:${requestId}:${offset}`);
    const controller = new AbortController();
    historyOwner.current?.controller.abort();
    const owner = { epoch, controller };
    historyOwner.current = owner;
    const owned = () =>
      alive.current &&
      historyOwner.current === owner &&
      !blockedRef.current &&
      fence.owns(token) &&
      selectedRef.current.requestId === requestId &&
      identityEpoch.current === epoch;
    setHistory((current) => ({ ...current, pending: true, stale: current.value !== null }));
    try {
      const value = await client.requests.listRuns(
        requestId,
        { limit: "25", offset: String(offset) },
        controller.signal,
      );
      if (owned()) setHistory({ value, pending: false, stale: false, error: null });
    } catch (error) {
      if (owned()) {
        runError(error);
        setHistory((current) => ({
          ...current,
          pending: false,
          stale: current.value !== null,
          error: "failed",
        }));
      }
    } finally {
      if (historyOwner.current === owner && fence.owns(token)) {
        historyOwner.current = null;
        if (alive.current)
          setHistory((current) => ({
            ...current,
            pending: false,
            stale:
              identityEpoch.current !== epoch || blockedRef.current
                ? current.value !== null
                : current.stale,
          }));
      }
    }
  }
  async function readAttempts(offset: number) {
    const requestId = selectedRef.current.requestId;
    const runId = selectedRef.current.runId;
    if (!requestId || !runId || blockedRef.current || mutationOwner.current) return;
    const epoch = identityEpoch.current;
    const fence = attemptsFence.current;
    const token = fence.issue(`${runId}:${offset}`);
    const controller = new AbortController();
    attemptsOwner.current?.controller.abort();
    const owner = { epoch, controller };
    attemptsOwner.current = owner;
    const owned = () =>
      attemptsOwner.current === owner && fence.owns(token) && runOwns(requestId, runId, epoch);
    setAttempts((current) => ({ ...current, pending: true, stale: current.value !== null }));
    try {
      const value = await client.requests.listAttempts(
        runId,
        { limit: "25", offset: String(offset) },
        controller.signal,
      );
      if (owned()) setAttempts({ value, pending: false, stale: false, error: null });
    } catch (error) {
      if (owned()) {
        runError(error);
        setAttempts((current) => ({
          ...current,
          pending: false,
          stale: current.value !== null,
          error: "failed",
        }));
      }
    } finally {
      if (attemptsOwner.current === owner && fence.owns(token)) {
        attemptsOwner.current = null;
        if (alive.current)
          setAttempts((current) => ({
            ...current,
            pending: false,
            stale:
              identityEpoch.current !== epoch || blockedRef.current
                ? current.value !== null
                : current.stale,
          }));
      }
    }
  }
  function selectRun(runId: string) {
    const requestId = selectedRef.current.requestId;
    if (!requestId || blockedRef.current || history.stale || history.pending || !leaveDraft())
      return;
    runFence.current.invalidate();
    attemptsFence.current.invalidate();
    downloadOwner.current?.abort();
    setRunRead(emptyRead());
    runRef.current = emptyRead();
    setAttempts(emptyRead());
    const next = { requestId, runId };
    selectedRef.current = next;
    setSelected(next);
    callbacks.current.onEntryChange?.(next);
  }
  function recordRetry(value: RequestRetryIntent | null) {
    retryIntentRef.current = value;
    setRetryIntent(value);
    reportUnresolved();
  }
  async function retryRun(reason: string) {
    const run = runRef.current.value;
    const requestId = selectedRef.current.requestId;
    if (
      !run ||
      !requestId ||
      !commandAllowed() ||
      runRef.current.pending ||
      runRef.current.stale ||
      actorId !== run.createdBy ||
      cardRef.current.value?.availability.packageStorage !== "configured" ||
      draft ||
      outcomeRef.current ||
      intentRef.current
    )
      return;
    const original = retryIntentRef.current;
    if (
      !original &&
      (run.status !== "failed" ||
        run.lifecycleVersion <= 0 ||
        cardRef.current.value?.status !== "open")
    )
      return;
    if (original && original.runId !== run.runId) return;
    const owner = acquire();
    if (!owner) return;
    const epoch = identityEpoch.current;
    const runId = run.runId;
    const owned = () =>
      owns(owner, requestId) && runOwns(requestId, runId, epoch) && commandAllowed();
    let value: RequestRetryIntent | null = original;
    try {
      value ??= makeRequestRetryIntent(runId, run.lifecycleVersion, reason, crypto.randomUUID());
      recordRetry(value);
      setFreshState(null);
      setRetryNotice(null);
      const receipt = usRequestRetryResponseSchema.parse(
        await client.requests.retry(runId, value.body),
      );
      if (!owned()) return;
      if (
        receipt.runId !== runId ||
        receipt.idempotencyKey !== value.body.idempotencyKey ||
        receipt.requestedBy !== actorId ||
        receipt.lifecycleVersion <= value.body.expectedLifecycleVersion
      )
        throw new UsClientError("invalid_response");
      recordRetry({ ...value, status: "accepted" });
      setRetryNotice("retryAccepted");
      const saved = usRequestRunDetailSchema.parse(await client.requests.getRun(runId));
      if (!owned()) return;
      if (
        saved.lifecycleVersion < receipt.lifecycleVersion ||
        saved.retryCycle < receipt.cycle ||
        saved.runRevision !== run.runRevision ||
        saved.commandDigest !== run.commandDigest ||
        saved.scopedContentDigest !== run.scopedContentDigest
      )
        throw new UsClientError("invalid_response");
      acceptRun(saved, requestId, runId);
      recordRetry(null);
      setAttempts(emptyRead());
    } catch (error) {
      if (!owned() || !value) return;
      if (error instanceof UsClientError && error.code === "session_required") {
        loseSession();
        return;
      }
      const accepted = retryIntentRef.current?.status === "accepted";
      recordRetry({ ...value, status: accepted ? "accepted" : "ambiguous" });
      const unknown =
        !(error instanceof UsClientError) ||
        error.code === "unavailable" ||
        error.code === "invalid_response";
      setRetryNotice(accepted ? "retryAccepted" : unknown ? "retryAmbiguous" : "retryRejected");
      if (error instanceof UsClientError && error.code === "forbidden") await rejectedRead();
    } finally {
      release(owner);
    }
  }
  async function download(artifact: UsRequestArtifact) {
    const run = runRef.current.value;
    const requestId = selectedRef.current.requestId;
    if (
      !run ||
      !requestId ||
      downloadOwner.current ||
      mutationOwner.current ||
      blockedRef.current ||
      !callbacks.current.canExport ||
      runRef.current.pending ||
      runRef.current.stale ||
      run.status !== "ready" ||
      cardRef.current.pending ||
      cardRef.current.stale ||
      cardRef.current.value?.availability.packageStorage !== "configured" ||
      !run.artifacts.some(
        (file) =>
          file.kind === artifact.kind &&
          file.sha256 === artifact.sha256 &&
          file.byteSize === artifact.byteSize,
      )
    )
      return;
    const controller = new AbortController();
    downloadOwner.current = controller;
    setDownloadActive(true);
    setDownloadError(false);
    const epoch = identityEpoch.current;
    const revision = cardRef.current.value.revision;
    const ownsDownload = () =>
      downloadOwner.current === controller &&
      !controller.signal.aborted &&
      runOwns(requestId, run.runId, epoch) &&
      callbacks.current.canExport &&
      !cardRef.current.pending &&
      !cardRef.current.stale &&
      cardRef.current.value?.revision === revision &&
      cardRef.current.value.availability.packageStorage === "configured" &&
      !runRef.current.pending &&
      !runRef.current.stale &&
      runRef.current.value?.status === "ready" &&
      runRef.current.value.lifecycleVersion === run.lifecycleVersion &&
      runRef.current.value.artifacts.some(
        (file) =>
          file.kind === artifact.kind &&
          file.sha256 === artifact.sha256 &&
          file.byteSize === artifact.byteSize,
      );
    let url: string | null = null;
    try {
      const verified = await client.requests.download(run.runId, artifact, controller.signal);
      if (!ownsDownload()) return;
      if (
        verified.sha256 !== artifact.sha256 ||
        verified.filename !== artifact.name ||
        verified.bytes.byteLength !== artifact.byteSize
      )
        throw new UsClientError("invalid_response");
      const blob = new Blob([new Uint8Array(verified.bytes)], { type: artifact.mediaType });
      if (!ownsDownload()) return;
      url = URL.createObjectURL(blob);
      blobUrls.current.add(url);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = artifact.name;
      if (!ownsDownload()) return;
      anchor.click();
    } catch (error) {
      if (!ownsDownload()) return;
      setDownloadError(true);
      if (error instanceof UsClientError && error.code === "forbidden") {
        controller.abort();
        blockedRef.current = true;
        await rejectedRead();
      } else if (error instanceof UsClientError && error.code === "session_required") loseSession();
    } finally {
      if (url) {
        URL.revokeObjectURL(url);
        blobUrls.current.delete(url);
      }
      if (downloadOwner.current === controller) {
        downloadOwner.current = null;
        if (alive.current) setDownloadActive(false);
      }
    }
  }

  function select(id: string) {
    if (blocked || list.stale || !leaveDraft()) return;
    const next = { requestId: id };
    cardFence.current.invalidate();
    selectedRef.current = next;
    denied.current.card = false;
    setCard(emptyRead());
    setHistory(emptyRead());
    setSelected(next);
    callbacks.current.onEntryChange?.(next);
  }
  function apply(next: UsRequestListInput) {
    if (mutationOwner.current) return;
    if (!usRequestListQuerySchema.safeParse(next).success) {
      setInvalid(true);
      return;
    }
    listFence.current.invalidate();
    setInvalid(false);
    setList(emptyRead());
    setQuery(next);
    denied.current.list = false;
  }
  const setDraftDirty = useCallback(
    (value: boolean) => {
      dirtyRef.current = value;
      setDirty(value);
      reportUnresolved();
      if (value) setValidationGeneration((current) => current + 1);
    },
    [reportUnresolved],
  );
  function leaveDraft() {
    if (mutationOwner.current) return false;
    if (intentRef.current && !window.confirm(copy.leavePreparation)) return false;
    if (retryIntentRef.current && !window.confirm(copy.leaveRetry)) return false;
    if ((dirtyRef.current || outcomeRef.current) && !window.confirm(copy.discardDraft))
      return false;
    setDraft(null);
    setDraftDirty(false);
    recordOutcome(null);
    setNotice(null);
    setCloseConfirm(false);
    setScopeInvalid(false);
    recordIntent(null);
    recordRetry(null);
    setRetryNotice(null);
    setFreshState(null);
    return true;
  }
  function recordOutcome(value: Outcome | null) {
    outcomeRef.current = value;
    setOutcome(value);
    reportUnresolved();
  }
  function begin(kind: Draft["kind"], baseline: UsRequestDetailResponse | null) {
    if (blocked || !callbacks.current.canManageQa || !leaveDraft()) return;
    setDraft({
      generation: ++draftGeneration.current,
      kind,
      baseline,
      scope: scopeToFields(baseline?.scope ?? null),
    });
    setValidationGeneration((current) => current + 1);
  }
  function owns(owner: object, id: string | undefined) {
    return (
      alive.current &&
      mutationOwner.current === owner &&
      selectedRef.current.requestId === id &&
      !sessionLost.current
    );
  }
  function acquire() {
    if (mutationOwner.current) return null;
    const owner = {};
    mutationOwner.current = owner;
    listFence.current.invalidate();
    setList((current) => ({ ...current, pending: false, stale: current.value !== null }));
    setMutationPending(true);
    callbacks.current.onMutationPendingChange(true);
    return owner;
  }
  function release(owner: object) {
    if (mutationOwner.current !== owner) return;
    mutationOwner.current = null;
    if (alive.current) setMutationPending(false);
    callbacks.current.onMutationPendingChange(false);
  }
  async function commandError(error: unknown, value: Outcome) {
    if (error instanceof UsClientError && error.code === "session_required") {
      loseSession();
      return;
    }
    if (error instanceof UsClientError && error.code === "forbidden") {
      setNotice("commandRejected");
      await rejectedRead();
      return;
    }
    if (error instanceof UsClientError && error.code === "us_request_revision_conflict")
      recordOutcome({ ...value, kind: "conflict" });
    else if (
      !(error instanceof UsClientError) ||
      error.code === "unavailable" ||
      error.code === "invalid_response"
    )
      recordOutcome({ ...value, kind: "ambiguous" });
    else setNotice("commandRejected");
  }
  async function canonical(value: Outcome, owner: object, originalId: string | undefined) {
    if (blockedRef.current || !callbacks.current.canRead) return;
    const fence = cardFence.current;
    const token = fence.issue(
      `${organizationId}:${value.requestId ?? value.requestNumber}:${value.receipt?.revision ?? "unknown"}`,
    );
    const current = () =>
      owns(owner, originalId) &&
      fence.owns(token) &&
      !blockedRef.current &&
      callbacks.current.canRead;
    let id = value.requestId;
    if (!id) {
      const result = await client.requests.list({
        requestNumber: value.requestNumber,
        limit: "25",
        offset: "0",
      });
      if (!current()) return;
      if (result.items.length === 0 && !result.hasMore) {
        recordOutcome({ ...value, kind: "noMatch" });
        return;
      }
      if (
        result.items.length !== 1 ||
        result.hasMore ||
        result.items[0]?.requestNumber !== value.requestNumber
      )
        return;
      id = result.items[0].id;
    }
    const detail = await client.requests.get(id);
    if (!current() || detail.id !== id) return;
    if (
      value.operation === "create" &&
      !value.receipt &&
      detail.requestNumber !== value.requestNumber
    )
      return;
    if (
      value.receipt &&
      (detail.revision < value.receipt.revision ||
        (value.operation === "close" && detail.status !== "closed"))
    )
      return;
    cardFence.current.invalidate();
    setCard({ value: detail, pending: false, stale: false, error: null });
    const next = { requestId: id };
    selectedRef.current = next;
    setSelected(next);
    callbacks.current.onEntryChange?.(next);
    setListRetry((current) => current + 1);
    if (value.kind === "accepted") {
      recordOutcome(null);
      setNotice("savedCurrent");
      // QA loss keeps readable raw input until explicit discard.
      if (callbacks.current.canManageQa) {
        setDraft(null);
        setDraftDirty(false);
      }
      setCloseConfirm(false);
    } else if (value.operation === "create") {
      recordOutcome({ ...value, kind: "ambiguous", requestId: id });
      setNotice("savedCandidate");
    }
    // Ambiguous updates/conflicts keep the captured editor revision and raw text.
  }
  async function recover() {
    const value = outcomeRef.current;
    if (!value || blocked || !callbacks.current.canRead) return;
    const owner = acquire();
    if (!owner) return;
    const originalId = selectedRef.current.requestId;
    try {
      await canonical(value, owner, originalId);
    } catch (error) {
      if (owns(owner, originalId)) {
        if (error instanceof UsClientError && error.code === "session_required") loseSession();
        else if (error instanceof UsClientError && error.code === "forbidden") await rejectedRead();
      }
    } finally {
      release(owner);
    }
  }
  async function save(body: UsTraceRequestCreateBody | UsTraceRequestUpdateBody) {
    if (blocked || !callbacks.current.canManageQa || outcomeRef.current || mutationOwner.current)
      return;
    const baseline = draft?.baseline;
    if (
      baseline &&
      (card.value?.id !== baseline.id || card.value.revision !== baseline.revision || card.stale)
    )
      return;
    let originalId = selectedRef.current.requestId;
    const owner = acquire();
    if (!owner) return;
    setValidationGeneration((current) => current + 1);
    setNotice(null);
    const value: Outcome = {
      kind: "ambiguous",
      operation: baseline ? "update" : "create",
      requestId: baseline?.id ?? null,
      requestNumber:
        "requestNumber" in body && body.requestNumber !== undefined
          ? body.requestNumber
          : (baseline?.requestNumber ?? ""),
      receipt: null,
    };
    try {
      let receipt: UsRequestCommandResponse;
      if (baseline) {
        if (!("expectedRevision" in body) || body.expectedRevision !== baseline.revision)
          throw new UsClientError("invalid_input");
        receipt = await client.requests.update(baseline.id, body);
      } else {
        const parsed = usTraceRequestCreateBodySchema.safeParse(body);
        if (!parsed.success) throw new UsClientError("invalid_input");
        receipt = await client.requests.create({ ...parsed.data, scope: null });
      }
      if (!receipt || !owns(owner, originalId)) return;
      const accepted: Outcome = {
        ...value,
        kind: "accepted",
        requestId: receipt.requestId,
        receipt,
      };
      recordOutcome(accepted);
      setCard((current) => ({ ...current, stale: current.value !== null }));
      setList((current) => ({ ...current, stale: current.value !== null }));
      if (!baseline) {
        const next = { requestId: receipt.requestId };
        cardFence.current.invalidate();
        setCard(emptyRead());
        selectedRef.current = next;
        setSelected(next);
        callbacks.current.onEntryChange?.(next);
        originalId = receipt.requestId;
      }
      // Keep commands unresolved if this canonical read fails.
      try {
        await canonical(accepted, owner, originalId);
      } catch (error) {
        if (owns(owner, originalId)) {
          if (error instanceof UsClientError && error.code === "session_required") loseSession();
          else if (error instanceof UsClientError && error.code === "forbidden")
            await rejectedRead();
        }
      }
    } catch (error) {
      if (owns(owner, originalId)) await commandError(error, value);
    } finally {
      release(owner);
    }
  }
  async function close() {
    const detail = card.value;
    if (
      !detail ||
      detail.status !== "open" ||
      blocked ||
      card.stale ||
      !callbacks.current.canManageQa ||
      outcomeRef.current ||
      !closeConfirm
    )
      return;
    const originalId = selectedRef.current.requestId;
    const owner = acquire();
    if (!owner) return;
    setValidationGeneration((current) => current + 1);
    setNotice(null);
    const value: Outcome = {
      kind: "ambiguous",
      operation: "close",
      requestId: detail.id,
      requestNumber: detail.requestNumber,
      receipt: null,
    };
    try {
      const receipt = await client.requests.close(detail.id, { expectedRevision: detail.revision });
      if (!owns(owner, originalId)) return;
      const accepted: Outcome = { ...value, kind: "accepted", receipt };
      recordOutcome(accepted);
      setCard((current) => ({ ...current, stale: current.value !== null }));
      setList((current) => ({ ...current, stale: current.value !== null }));
      try {
        await canonical(accepted, owner, originalId);
      } catch (error) {
        if (owns(owner, originalId)) {
          if (error instanceof UsClientError && error.code === "session_required") loseSession();
          else if (error instanceof UsClientError && error.code === "forbidden")
            await rejectedRead();
        }
      }
    } catch (error) {
      if (owns(owner, originalId)) await commandError(error, value);
    } finally {
      release(owner);
    }
  }
  async function actionError(error: unknown, fallback: "validationFailed" | "commandRejected") {
    setFreshState(null);
    if (error instanceof UsClientError && error.code === "session_required") {
      loseSession();
      return;
    }
    if (error instanceof UsClientError && error.code === "forbidden") {
      await rejectedRead();
      return;
    }
    const code = error instanceof UsClientError ? error.code : "unavailable";
    setNotice(
      code === "us_request_scope_required"
        ? "scopeRequired"
        : code === "us_request_selection_limit"
          ? "selectionLimit"
          : code === "us_request_snapshot_limit"
            ? "snapshotLimit"
            : code === "conflict" || code.startsWith("us_request_")
              ? "conflict"
              : fallback,
    );
  }
  async function validate() {
    const detail = cardRef.current.value;
    if (
      !detail ||
      !commandAllowed() ||
      cardRef.current.pending ||
      cardRef.current.stale ||
      draft ||
      intentRef.current ||
      outcomeRef.current ||
      detail.status !== "open" ||
      detail.scope === null ||
      detail.availability.build !== "available"
    )
      return;
    const owner = acquire();
    if (!owner) return;
    setFreshState(null);
    setNotice(null);
    try {
      const response = usRequestValidationHttpResponseSchema.parse(
        await client.requests.validate(detail.id, { expectedRevision: detail.revision }),
      );
      if (
        !owns(owner, detail.id) ||
        !commandAllowed() ||
        validationGenerationRef.current !== validationGeneration
      )
        return;
      if (
        response.requestId !== detail.id ||
        response.revision !== detail.revision ||
        cardRef.current.value?.id !== detail.id ||
        cardRef.current.value.revision !== detail.revision
      )
        throw new UsClientError("invalid_response");
      const saved = {
        ...detail,
        lastValidatedAt: response.validatedAt,
        savedValidation: {
          digest: response.digest,
          validatedAt: response.validatedAt,
          matchedRevisionCount: response.matchedRevisionCount,
          findings: response.findings,
          freshness: "not_rechecked" as const,
        },
        // Every server Validate clears acknowledgement, even for the same digest.
        warningAcknowledgement: null,
      };
      setCard({ value: saved, pending: false, stale: false, error: null });
      setFreshState({
        value: { requestId: detail.id, revision: detail.revision, response },
        generation: validationGeneration,
      });
    } catch (error) {
      if (owns(owner, detail.id)) await actionError(error, "validationFailed");
    } finally {
      release(owner);
    }
  }
  async function acknowledge(reason: string) {
    const detail = cardRef.current.value;
    const evidence = detail && (matchingRequestValidation(detail, fresh) ?? detail.savedValidation);
    if (
      !detail ||
      !evidence ||
      !commandAllowed() ||
      draft ||
      cardRef.current.stale ||
      cardRef.current.pending ||
      intentRef.current ||
      outcomeRef.current ||
      detail.status !== "open" ||
      !evidence.findings.some((finding) => finding.severity === "warning")
    )
      return;
    const body = usRequestWarningAckHttpBodySchema.safeParse({
      expectedRevision: detail.revision,
      digest: evidence.digest,
      reason,
    });
    if (!body.success) return;
    const owner = acquire();
    if (!owner) return;
    const capturedFresh = freshState;
    const capturedGeneration = validationGenerationRef.current;
    setFreshState(null);
    setNotice(null);
    try {
      const receipt = await client.requests.acknowledgeWarnings(detail.id, body.data);
      if (
        !owns(owner, detail.id) ||
        !commandAllowed() ||
        capturedGeneration !== validationGenerationRef.current
      )
        return;
      if (receipt.requestId !== detail.id || receipt.revision !== detail.revision)
        throw new UsClientError("invalid_response");
      setCard((current) => ({ ...current, stale: true }));
      const saved = await client.requests.get(detail.id);
      if (
        !owns(owner, detail.id) ||
        !commandAllowed() ||
        capturedGeneration !== validationGenerationRef.current
      )
        return;
      if (saved.id !== detail.id || saved.revision < receipt.revision)
        throw new UsClientError("invalid_response");
      setCard({ value: saved, pending: false, stale: false, error: null });
      // Ack changes acknowledgement only. Retain the original real Validate proof
      // only after an exact canonical read; saved-only acknowledgement never creates it.
      if (
        capturedFresh?.generation === capturedGeneration &&
        matchingRequestValidation(saved, capturedFresh.value) &&
        saved.status === "open" &&
        saved.revision === detail.revision &&
        saved.savedValidation?.validatedAt === capturedFresh.value.response.validatedAt &&
        saved.warningAcknowledgement?.digest === body.data.digest &&
        saved.warningAcknowledgement.reason === body.data.reason
      )
        setFreshState(capturedFresh);
    } catch (error) {
      if (owns(owner, detail.id)) await actionError(error, "commandRejected");
    } finally {
      release(owner);
    }
  }
  async function sendPreparation(value: PreparationIntent, owner: object) {
    const epoch = identityEpoch.current;
    try {
      const receipt = usRequestPrepareResponseSchema.parse(
        await client.requests.prepare(value.requestId, value.body),
      );
      if (!owns(owner, value.requestId)) return;
      if (
        receipt.requestId !== value.requestId ||
        receipt.requestRevision !== value.body.expectedRevision ||
        receipt.mode !== value.body.mode ||
        receipt.idempotencyKey !== value.body.idempotencyKey ||
        receipt.scopedContentDigest !== value.body.validationDigest
      )
        throw new UsClientError("invalid_response");
      recordIntent({ ...value, status: "accepted", receipt });
      setNotice("acceptedRefresh");
      if (!commandAllowed() || identityEpoch.current !== epoch) return;
      const run = usRequestRunDetailSchema.parse(await client.requests.getRun(receipt.runId));
      if (!owns(owner, value.requestId) || !commandAllowed() || identityEpoch.current !== epoch)
        return;
      if (
        run.runId !== receipt.runId ||
        run.requestId !== value.requestId ||
        run.requestRevision !== value.body.expectedRevision ||
        run.runRevision !== receipt.runRevision ||
        run.mode !== value.body.mode ||
        run.scopedContentDigest !== value.body.validationDigest
      )
        throw new UsClientError("invalid_response");
      const next = { requestId: value.requestId, runId: receipt.runId };
      preparedSeed.current = receipt.runId;
      acceptRun(run, value.requestId, receipt.runId);
      selectedRef.current = next;
      setSelected(next);
      callbacks.current.onEntryChange?.(next);
      recordIntent(null);
      setNotice(null);
    } catch (error) {
      if (!owns(owner, value.requestId)) return;
      if (error instanceof UsClientError && error.code === "session_required") {
        loseSession();
        return;
      }
      if (error instanceof UsClientError && error.code === "forbidden") {
        recordIntent({
          ...(intentRef.current ?? value),
          status: intentRef.current?.status === "accepted" ? "accepted" : "ambiguous",
        });
        await rejectedRead();
        return;
      }
      const accepted = intentRef.current?.status === "accepted";
      recordIntent({
        ...(intentRef.current ?? value),
        status: accepted ? "accepted" : "ambiguous",
      });
      const code = error instanceof UsClientError ? error.code : "unavailable";
      setNotice(
        accepted
          ? "acceptedRefresh"
          : code === "us_request_selection_limit"
            ? "selectionLimit"
            : code === "us_request_snapshot_limit"
              ? "snapshotLimit"
              : code === "unavailable" || code === "invalid_response"
                ? "ambiguous"
                : "conflict",
      );
      setFreshState(null);
    } finally {
      release(owner);
    }
  }
  async function prepare(mode: UsRequestPrepareHttpBody["mode"]) {
    const detail = cardRef.current.value;
    if (
      !detail ||
      !commandAllowed() ||
      cardRef.current.pending ||
      cardRef.current.stale ||
      draft ||
      outcomeRef.current ||
      intentRef.current ||
      retryIntentRef.current ||
      !requestCanPrepare(detail, fresh, mode)
    )
      return;
    const response = matchingRequestValidation(detail, fresh);
    if (!response) return;
    const owner = acquire();
    if (!owner) return;
    try {
      const value = makeRequestPrepareIntent(
        detail.id,
        detail.revision,
        response.digest,
        mode,
        crypto.randomUUID(),
      );
      recordIntent(value);
      setNotice(null);
      setFreshState(null);
      await sendPreparation(value, owner);
    } catch (error) {
      if (owns(owner, detail.id)) await actionError(error, "commandRejected");
      release(owner);
    }
  }
  async function replayPreparation() {
    const value = intentRef.current;
    const detail = cardRef.current.value;
    if (
      !value ||
      !detail ||
      value.requestId !== detail.id ||
      !commandAllowed() ||
      cardRef.current.pending ||
      cardRef.current.stale ||
      detail.availability.build !== "available" ||
      detail.availability.packageStorage !== "configured" ||
      draft ||
      outcomeRef.current
    )
      return;
    const owner = acquire();
    if (!owner) return;
    setNotice(null);
    await sendPreparation(value, owner);
  }
  function newResponse() {
    if (mutationOwner.current || !intentRef.current || !window.confirm(copy.abandonPreparation))
      return;
    recordIntent(null);
    setFreshState(null);
    setNotice(null);
  }
  function openSource(target: ReadinessEventTarget) {
    if (blockedRef.current || cardRef.current.stale || !leaveDraft()) return;
    callbacks.current.onEntryChange?.(selectedRef.current);
    callbacks.current.onOpenSource(target);
  }
  const pageOffset = Number(query.offset ?? "0");
  const filtered = query.requestNumber !== undefined || query.status !== undefined;
  return (
    <section
      className="us-requests"
      aria-labelledby="us-requests-title"
      data-selected-run={selected.runId}
      data-session-actor-ready={actorId !== null}
      data-validation-generation={validationGeneration}
    >
      <header>
        <h1 id="us-requests-title" tabIndex={-1} ref={heading}>
          {copy.title}
        </h1>
        <p>{copy.intro}</p>
      </header>
      <p className="us-md-notice" role="note">
        {copy.localNotice}
      </p>
      {stopped ? <p role="alert">{copy.sessionLost}</p> : null}
      {props.canManageQa ? (
        <Button disabled={blocked || mutationPending} onClick={() => begin("requester", null)}>
          {copy.newRequest}
        </Button>
      ) : null}
      {notice ? (
        <p role={notice === "savedCurrent" || notice === "savedCandidate" ? "status" : "alert"}>
          {copy[notice]}
        </p>
      ) : null}
      {outcome ? (
        <div className="us-md-notice us-md-notice--alert">
          <p role="alert">
            {outcome.kind === "accepted"
              ? copy.acceptedRefresh
              : outcome.kind === "conflict"
                ? copy.conflict
                : outcome.kind === "noMatch"
                  ? copy.noSavedMatch
                  : copy.ambiguous}
          </p>
          <Button disabled={blocked || mutationPending} onClick={() => void recover()}>
            {copy.checkSaved}
          </Button>
          {outcome.kind === "noMatch" && props.canManageQa ? (
            <Button
              disabled={blocked || mutationPending}
              onClick={() => {
                if (window.confirm(copy.continueConfirm)) recordOutcome(null);
              }}
            >
              {copy.continueAfterNoMatch}
            </Button>
          ) : null}
          {outcome.operation !== "create" || outcome.requestId !== null ? (
            <Button
              disabled={blocked || mutationPending}
              onClick={() => {
                if (!leaveDraft()) return;
                setCardRetry((current) => current + 1);
              }}
            >
              {copy.discardReload}
            </Button>
          ) : null}
        </div>
      ) : null}
      {draft ? (
        <section aria-label={draft.kind === "requester" ? copy.editRequest : copy.editScope}>
          {draft.kind === "requester" ? (
            <RequestEditor
              key={draft.generation}
              detail={draft.baseline}
              timeZone={profile.timeZone}
              disabled={blocked || mutationPending || !props.canManageQa || outcome !== null}
              onSave={save}
              onDirtyChange={setDraftDirty}
            />
          ) : (
            <form
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                if (!draft.baseline) return;
                const parsed = parseRequestScope(draft.scope);
                if (!parsed.success) {
                  setScopeInvalid(true);
                  return;
                }
                void save({ expectedRevision: draft.baseline.revision, scope: parsed.data });
              }}
            >
              <RequestScopeEditor
                client={client}
                value={draft.scope}
                disabled={blocked || mutationPending || !props.canManageQa || outcome !== null}
                onChange={(scope) => {
                  setDraft({ ...draft, scope });
                  setDraftDirty(
                    JSON.stringify(scope) !==
                      JSON.stringify(scopeToFields(draft.baseline?.scope ?? null)),
                  );
                }}
                onForbidden={rejectedRead}
                onSessionLost={loseSession}
              />
              {scopeInvalid ? <p role="alert">{copy.scopeInvalid}</p> : null}
              {props.canManageQa ? (
                <>
                  <Button type="submit" disabled={blocked || mutationPending || outcome !== null}>
                    {copy.saveScope}
                  </Button>
                  <Button
                    type="button"
                    disabled={blocked || mutationPending || outcome !== null}
                    onClick={() => {
                      if (draft.baseline && window.confirm(copy.discardDraft))
                        void save({ expectedRevision: draft.baseline.revision, scope: null });
                    }}
                  >
                    {copy.clearScope}
                  </Button>
                </>
              ) : null}
            </form>
          )}
          <Button disabled={mutationPending} onClick={() => leaveDraft()}>
            {copy.cancel}
          </Button>
          {dirty ? <p>{copy.freshInvalidated}</p> : null}
        </section>
      ) : null}
      {sessionLookupError && !stopped ? (
        <div className="us-md-notice us-md-notice--alert">
          <p role="alert">{copy.sessionLookupError}</p>
          <Button
            variant="secondary"
            disabled={blocked || sessionLookupPending || denied.current.session}
            onClick={() => {
              if (blocked || sessionLookupPending || denied.current.session) return;
              sessionRequiresRetry.current = false;
              setSessionLookupPending(true);
              setSessionRetry((current) => current + 1);
            }}
          >
            {copy.retrySessionLookup}
          </Button>
        </div>
      ) : null}
      <form
        className="us-request-filters"
        onSubmit={(event) => {
          event.preventDefault();
          if (!blocked)
            apply({
              limit: "25",
              offset: "0",
              ...(number ? { requestNumber: number } : {}),
              ...(status ? { status } : {}),
            });
        }}
      >
        <Input
          label={copy.exactNumber}
          value={number}
          disabled={blocked}
          onChange={(event) => setNumber(event.target.value)}
        />
        <Select
          native
          label={copy.lifecycle}
          value={status}
          disabled={blocked}
          onValueChange={setStatus}
          options={[
            { value: "", label: copy.all },
            { value: "open", label: copy.open },
            { value: "closed", label: copy.closed },
          ]}
        />
        <Button type="submit" disabled={blocked}>
          {copy.applyFilters}
        </Button>
        <Button
          variant="secondary"
          disabled={blocked}
          onClick={() => {
            setNumber("");
            setStatus("");
            apply({ limit: "25", offset: "0" });
          }}
        >
          {copy.resetFilters}
        </Button>
      </form>
      {invalid ? <p role="alert">{copy.invalid}</p> : null}
      <div className="us-request-actions">
        <Button
          disabled={blocked || list.pending || mutationPending}
          onClick={() => {
            denied.current.list = false;
            setList((current) => ({ ...current, error: null }));
            setListRetry((current) => current + 1);
          }}
        >
          {copy.refresh}
        </Button>
      </div>
      {list.pending ? <p role="status">{copy.loading}</p> : null}
      {list.error ? (
        <p role="alert">{list.error === "forbidden" ? copy.forbidden : copy.requestError}</p>
      ) : null}
      {list.stale ? <p role="status">{copy.staleList}</p> : null}
      {list.value?.items.length ? (
        <RequestList
          rows={list.value.items}
          stale={list.stale || blocked || mutationPending}
          timeZone={profile.timeZone}
          onSelect={select}
        />
      ) : list.value ? (
        <p>{filtered ? copy.noMatch : copy.empty}</p>
      ) : null}
      <div className="us-request-actions">
        <Button
          variant="secondary"
          disabled={blocked || list.pending || pageOffset === 0}
          onClick={() => apply({ ...query, offset: String(Math.max(0, pageOffset - 25)) })}
        >
          {copy.previous}
        </Button>
        <span>
          {copy.page} {Math.floor(pageOffset / 25) + 1}
        </span>
        <Button
          variant="secondary"
          disabled={
            blocked || list.pending || list.stale || !list.value?.hasMore || pageOffset + 25 > 10000
          }
          onClick={() => apply({ ...query, offset: String(pageOffset + 25) })}
        >
          {copy.next}
        </Button>
      </div>
      {selected.requestId ? (
        <>
          <Button
            variant="secondary"
            disabled={blocked || card.pending || mutationPending}
            onClick={() => {
              if (outcomeRef.current) {
                void recover();
                return;
              }
              if (!intentRef.current && !leaveDraft()) return;
              setFreshState(null);
              setValidationGeneration((current) => current + 1);
              denied.current.card = false;
              setCard((current) => ({ ...current, error: null }));
              setCardRetry((current) => current + 1);
            }}
          >
            {copy.refreshRequest}
          </Button>
          {card.pending ? <p role="status">{copy.loadingCard}</p> : null}
          {card.error ? (
            <p role="alert">
              {card.error === "forbidden"
                ? copy.forbidden
                : card.error === "missing"
                  ? copy.missing
                  : copy.requestError}
            </p>
          ) : null}
          {card.stale ? <p role="status">{copy.staleCard}</p> : null}
          {card.value ? (
            <RequestCard
              key={card.value.id}
              detail={card.value}
              timeZone={profile.timeZone}
              validationContent={
                <RequestValidation
                  detail={card.value}
                  fresh={fresh}
                  canAct={
                    props.canManageQa &&
                    props.canExport &&
                    !blocked &&
                    !card.stale &&
                    !card.pending &&
                    !draft &&
                    !outcome &&
                    !intent
                  }
                  pending={mutationPending}
                  onValidate={validate}
                  onAcknowledge={acknowledge}
                  onOpenSource={openSource}
                />
              }
              packageContent={
                <>
                  <RequestPreparation
                    detail={card.value}
                    fresh={fresh}
                    intent={intent}
                    canAct={
                      props.canManageQa &&
                      props.canExport &&
                      !blocked &&
                      !card.stale &&
                      !card.pending &&
                      !draft &&
                      !outcome &&
                      !retryIntent
                    }
                    pending={mutationPending}
                    onPrepare={prepare}
                    onReplay={replayPreparation}
                    onNewResponse={newResponse}
                  />
                  <RequestRuns
                    page={history.value}
                    pending={history.pending}
                    stale={history.stale}
                    disabled={blocked || mutationPending}
                    timeZone={profile.timeZone}
                    onPage={(offset) => void readHistory(offset)}
                    onSelect={selectRun}
                  />
                  {history.error ? <p role="alert">{copy.runReadFailed}</p> : null}
                  {selected.runId ? (
                    <>
                      <Button
                        disabled={blocked || runRead.pending || mutationPending}
                        onClick={() => {
                          pollPauseRef.current = null;
                          setPollPause(null);
                          setRunRead((current) => ({ ...current, stale: true }));
                          setRunRefresh((current) => current + 1);
                        }}
                      >
                        {copy.refreshRun}
                      </Button>
                      {runRead.pending ? <p role="status">{copy.loadingRuns}</p> : null}
                      {runRead.error ? <p role="alert">{copy.runReadFailed}</p> : null}
                      {lastRunUpdate ? (
                        <p>
                          {copy.lastRunUpdate}: {lastRunUpdate}
                        </p>
                      ) : null}
                      {pollPause ? (
                        <p role="status">
                          {copy.pollingPaused}: {copy[pollPause]}
                        </p>
                      ) : null}
                      {runPollable && pollPause ? (
                        <Button
                          disabled={blocked || mutationPending || !visible}
                          onClick={() => {
                            pollPauseRef.current = null;
                            setPollPause(null);
                            setPollResume((current) => current + 1);
                          }}
                        >
                          {copy.resumePolling}
                        </Button>
                      ) : null}
                      {retryNotice ? <p role="status">{copy[retryNotice]}</p> : null}
                      {retryIntent ? (
                        <>
                          <p>{copy.retryMemory}</p>
                          <Button
                            disabled={
                              blocked ||
                              mutationPending ||
                              !props.canManageQa ||
                              !props.canExport ||
                              actorId !== runRead.value?.createdBy ||
                              card.value.availability.packageStorage !== "configured"
                            }
                            onClick={() => void retryRun(retryIntent.body.reason)}
                          >
                            {copy.replayRetry}
                          </Button>
                        </>
                      ) : null}
                      {downloadError ? <p role="alert">{copy.downloadFailed}</p> : null}
                      {downloadActive ? <p role="status">{copy.downloading}</p> : null}
                      {runRead.value && runRead.value.runId === selected.runId ? (
                        <>
                          <RequestRunDetail
                            key={runRead.value.runId}
                            run={runRead.value}
                            timeZone={profile.timeZone}
                            actorId={actorId}
                            canAct={
                              props.canManageQa &&
                              props.canExport &&
                              !blocked &&
                              !mutationPending &&
                              !runRead.stale &&
                              !runRead.pending &&
                              !draft &&
                              !outcome &&
                              !intent &&
                              !retryIntent &&
                              card.value.status === "open"
                            }
                            canDownload={
                              props.canExport &&
                              !blocked &&
                              !mutationPending &&
                              !downloadActive &&
                              !runRead.stale &&
                              !runRead.pending &&
                              !card.stale &&
                              !card.pending
                            }
                            storageAvailable={
                              card.value.availability.packageStorage === "configured"
                            }
                            onRetry={retryRun}
                            onDownload={download}
                          />
                          <RequestAttempts
                            page={attempts.value}
                            pending={attempts.pending}
                            disabled={blocked || mutationPending}
                            timeZone={profile.timeZone}
                            onPage={(offset) => void readAttempts(offset)}
                          />
                          {attempts.error ? <p role="alert">{copy.runReadFailed}</p> : null}
                        </>
                      ) : null}
                    </>
                  ) : null}
                </>
              }
            >
              {props.canManageQa && card.value.status === "open" && !draft ? (
                <div className="us-request-actions">
                  <Button
                    disabled={
                      blocked || card.stale || card.pending || mutationPending || outcome !== null
                    }
                    onClick={() => begin("requester", card.value)}
                  >
                    {copy.editRequest}
                  </Button>
                  <Button
                    disabled={
                      blocked || card.stale || card.pending || mutationPending || outcome !== null
                    }
                    onClick={() => begin("scope", card.value)}
                  >
                    {copy.editScope}
                  </Button>
                  <Button
                    disabled={
                      blocked || card.stale || card.pending || mutationPending || outcome !== null
                    }
                    onClick={() => setCloseConfirm(true)}
                  >
                    {copy.close}
                  </Button>
                </div>
              ) : null}
              {closeConfirm ? (
                <div role="group" aria-label={copy.close}>
                  <p>{copy.closeHelp}</p>
                  {props.canManageQa ? (
                    <Button
                      disabled={blocked || mutationPending || outcome !== null}
                      onClick={() => void close()}
                    >
                      {copy.confirmClose}
                    </Button>
                  ) : null}
                  <Button disabled={mutationPending} onClick={() => setCloseConfirm(false)}>
                    {copy.cancel}
                  </Button>
                </div>
              ) : null}
              {card.value.scope?.lotId ? (
                <Button
                  variant="secondary"
                  disabled={blocked || card.stale || mutationPending}
                  onClick={() => {
                    if (leaveDraft()) callbacks.current.onOpenLot(card.value?.scope?.lotId ?? "");
                  }}
                >
                  {copy.openLot}
                </Button>
              ) : null}
            </RequestCard>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
