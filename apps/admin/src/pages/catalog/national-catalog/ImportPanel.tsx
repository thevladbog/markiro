import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CABINET_CAPABILITY, isValidGtin } from "@markiro/domain";
import { importApplyConflictSchema } from "@markiro/platform-contracts";
import type {
  ImportApply,
  ImportDecision,
  ImportPrepare,
  ImportPrepareResponse,
  ImportResult as Result,
} from "@markiro/platform-contracts";
import { Alert, Button, Textarea, SidePanel, Spinner } from "@markiro/ui";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import { useCan } from "../../../access/context.js";
import { ApiRequestError } from "../../../api/client.js";
import { useAuthClient } from "../../../auth/client.js";
import { PRODUCTS_QUERY_KEY, PRODUCT_CHZ_LINK_QUERY_KEY } from "../api.js";
import { closeCatalogPanel } from "../ProductPanelRoute.js";
import * as api from "./api.js";
import {
  abandonIntent,
  type IntentState,
  clearIdentityIntents,
  readIntentOwner,
  writeIntentOwner,
  clearIntent,
  identityKey,
  loadIntent,
  saveIntent,
  type PendingIntent,
} from "./pendingIntent.js";
import { ImportSelection, initialItemsQuery } from "./ImportSelection.js";
import { ImportReview, type ReviewDrafts } from "./ImportReview.js";
import { ImportResult } from "./ImportResult.js";
const polling = () =>
  typeof document !== "undefined" && document.visibilityState === "visible" && document.hasFocus()
    ? 2000
    : false;
const terminalError = (error: unknown) => error instanceof ApiRequestError && error.status === 410;
/** Storage lifecycle follows settled auth; query isolation remains AuthQueryBoundary's job. */
export function NationalCatalogIdentityBoundary({
  children,
  onIdentityChange,
}: {
  children: ReactNode;
  onIdentityChange: () => Promise<void>;
}) {
  const auth = useAuthClient().useSession();
  const tenant = auth.data?.session.activeOrganizationId;
  const identity = tenant && auth.data ? identityKey(tenant, auth.data.user.id) : null;
  const lastSettledOwner = useRef<string | null | undefined>(undefined);
  const [verified, setVerified] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (auth.isPending) return;
    let mounted = true;
    const previous =
      lastSettledOwner.current === undefined ? readIntentOwner() : lastSettledOwner.current;
    async function settle() {
      if (previous !== undefined && previous !== identity) {
        if (previous) clearIdentityIntents(previous);
        await onIdentityChange();
      }
      if (mounted) {
        lastSettledOwner.current = identity;
        writeIntentOwner(identity);
        setVerified(identity);
      }
    }
    void settle();
    return () => {
      mounted = false;
    };
  }, [identity, auth.isPending, onIdentityChange]);
  return !auth.isPending && verified === identity ? <>{children}</> : null;
}
export function ImportPanel() {
  const auth = useAuthClient().useSession();
  const tenant = auth.data?.session.activeOrganizationId;
  const user = auth.data?.user.id;
  const [routeParams] = useSearchParams();
  return tenant && user ? (
    <ScopedImportPanel
      key={`${identityKey(tenant, user)}${routeParams.get("sessionId") ?? ""}`}
      identity={identityKey(tenant, user)}
    />
  ) : null;
}
function ScopedImportPanel({ identity }: { identity: string }) {
  const { t } = useTranslation();
  const tr = (key: string) => t(`pages.catalog.import.${key}`);
  const canWrite = useCan(CABINET_CAPABILITY.OPERATIONS_WRITE);
  const client = useQueryClient();
  const location = useLocation();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const sessionId = params.get("sessionId") ?? "";
  const preparationId = params.get("preparationId") ?? "";
  const operationId = params.get("operationId") ?? "";
  const step = params.get("step");
  const exactCardId = params.get("exactCardId");
  const exactGtin = params.get("exactGtin") ?? "";
  const originProductId = params.get("originProductId") ?? "";
  const exactEntry = exactCardId !== null;
  const validExactEntry =
    !!exactCardId &&
    exactCardId.length <= 1000 &&
    /^\d{14}$/.test(exactGtin) &&
    isValidGtin(exactGtin);
  const comparisonRejected =
    !!preparationId && params.get("rejectedPreparationId") === preparationId;
  const rejectedIdsText = params.get("rejectedPreviewIds") ?? "";
  const rejectedDetails = importApplyConflictSchema.safeParse({
    statusCode: 409,
    error: "Conflict",
    message: params.get("rejectedReason"),
    previewIds: rejectedIdsText.length <= 3700 ? rejectedIdsText.split(",") : [],
  });
  const rejectedPreviewIds =
    comparisonRejected && rejectedDetails.success ? rejectedDetails.data.previewIds : [];

  const showResult = !!operationId && step !== "selection" && step !== "review";
  const showReview = !!preparationId && !showResult && step !== "selection";
  const [query, setQuery] = useState(initialItemsQuery);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryBlocked, setRetryBlocked] = useState(false);
  const [recovery, setRecovery] = useState<IntentState>(() =>
    sessionId ? loadIntent(identity, sessionId) : { status: "missing" },
  );
  const pending = recovery.status === "valid" ? recovery.intent : null;
  const storageBlocked = recovery.status === "corrupt" || recovery.status === "unavailable";
  const [abandonConfirm, setAbandonConfirm] = useState(false);
  function setPending(intent: PendingIntent | null) {
    setRecovery(intent ? { status: "valid", intent } : { status: "missing" });
  }
  const [receiptToClear, setReceiptToClear] = useState<{
    sessionId: string;
    kind: "prepare" | "apply";
    id: string;
  } | null>(null);
  const active = useRef(true);
  const lock = useRef(false);
  const abort = useRef(new AbortController());
  const prefix = ["national-catalog", identity];
  useEffect(() => {
    active.current = true;
    const controller = new AbortController();
    abort.current = controller;
    return () => {
      active.current = false;
      controller.abort();
      void client.cancelQueries({ queryKey: ["national-catalog", identity] });
    };
  }, [identity, client]);
  useEffect(() => {
    setRecovery(sessionId ? loadIntent(identity, sessionId) : { status: "missing" });
  }, [identity, sessionId]);
  useEffect(() => {
    if (
      receiptToClear &&
      sessionId === receiptToClear.sessionId &&
      (receiptToClear.kind === "prepare" ? preparationId : operationId) === receiptToClear.id
    ) {
      clearIntent(identity, sessionId);
      setPending(null);
      setReceiptToClear(null);
    }
  }, [identity, sessionId, preparationId, operationId, receiptToClear]);
  const capabilities = useQuery({
    queryKey: [...prefix, "capabilities"],
    queryFn: ({ signal }) => api.getCapabilities(signal),
    retry: false,
  });
  const session = useQuery({
    queryKey: [...prefix, sessionId, "session"],
    queryFn: ({ signal }) => api.getImportSession(sessionId, signal),
    enabled: !!sessionId && !showResult,
    retry: false,
    refetchOnWindowFocus: (q) => !terminalError(q.state.error),
    refetchOnReconnect: (q) => !terminalError(q.state.error),
    refetchInterval: (q) =>
      !terminalError(q.state.error) && ["queued", "loading"].includes(q.state.data?.state ?? "")
        ? polling()
        : false,
  });
  const live =
    !!session.data &&
    !["expired", "cancelled"].includes(session.data.state) &&
    !terminalError(session.error);
  const modeAvailable =
    session.data?.mode === "gtins" ? capabilities.data?.gtinLookup : capabilities.data?.ownCatalog;
  const mutable = canWrite && live && !!modeAvailable && !pending && !storageBlocked;
  const items = useQuery({
    queryKey: [...prefix, sessionId, "items", query],
    queryFn: ({ signal }) => api.getImportItems(sessionId, query, signal),
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[2] === sessionId ? previous : undefined,
    enabled:
      !!sessionId && !exactEntry && !showReview && !showResult && !terminalError(session.error),
    retry: false,
    refetchOnWindowFocus: (q) => !terminalError(q.state.error),
    refetchOnReconnect: (q) => !terminalError(q.state.error),
    refetchInterval: (q) =>
      !terminalError(q.state.error) && ["queued", "loading"].includes(session.data?.state ?? "")
        ? polling()
        : false,
  });
  const exactItems = useQuery({
    queryKey: [...prefix, sessionId, "exact-items", session.data?.revision],
    queryFn: ({ signal }) => api.getExactCardItems(sessionId, signal),
    enabled:
      !!sessionId &&
      exactEntry &&
      validExactEntry &&
      session.data?.complete === true &&
      !showReview &&
      !showResult,
    retry: false,
  });
  const exactMatches =
    exactItems.data?.filter((item) => item.cardId === exactCardId && item.gtin14 === exactGtin) ??
    [];
  const exactItem = exactMatches.length === 1 ? exactMatches[0] : undefined;
  const exactReason =
    !validExactEntry || (session.data && session.data.mode !== "gtins")
      ? "exactMissing"
      : session.data &&
          !session.data.complete &&
          !["queued", "loading"].includes(session.data.state)
        ? "exactIncomplete"
        : exactItems.isError
          ? "exactIncomplete"
          : !exactItems.data
            ? null
            : exactMatches.length > 1
              ? "exactAmbiguous"
              : !exactItem
                ? "exactMissing"
                : exactItem.statusKeys.includes("archived")
                  ? "archived"
                  : !exactItem.selectable ||
                      exactItem.match === "inaccessible" ||
                      exactItem.match === "ambiguous"
                    ? "exactMissing"
                    : null;
  const exactSelected =
    !!exactItem &&
    !exactReason &&
    session.data?.selectedItemIds.length === 1 &&
    session.data.selectedItemIds[0] === exactItem.id;
  const preparation = useQuery({
    queryKey: [...prefix, sessionId, preparationId, "preparation"],
    queryFn: ({ signal }) => api.getPreparation(sessionId, preparationId, signal),
    enabled: !!sessionId && showReview,
    retry: false,
    refetchOnWindowFocus: (q) => !terminalError(q.state.error),
    refetchOnReconnect: (q) => !terminalError(q.state.error),
    refetchInterval: (q) =>
      !terminalError(q.state.error) &&
      (q.state.data?.preparation.state === "queued" ||
        q.state.data?.preparation.state === "loading" ||
        q.state.data?.items.some((p) => p.photos.some((photo) => photo.state === "pending")))
        ? polling()
        : false,
  });
  const result = useQuery({
    queryKey: [...prefix, sessionId, operationId, "result"],
    queryFn: ({ signal }) => api.getImportResult(sessionId, operationId, signal),
    enabled: !!sessionId && !!operationId,
    retry: false,
    refetchOnWindowFocus: (q) => !terminalError(q.state.error),
    refetchOnReconnect: (q) => !terminalError(q.state.error),
    refetchInterval: (q) =>
      !terminalError(q.state.error) && ["pending", "running"].includes(q.state.data?.state ?? "")
        ? polling()
        : false,
  });
  const invalidatedResult = useRef<string | null>(null);
  function invalidateResult(data: Result) {
    const receipt = JSON.stringify(data);
    if (invalidatedResult.current === receipt) return;
    invalidatedResult.current = receipt;
    void client.invalidateQueries({ queryKey: PRODUCTS_QUERY_KEY });
    void client.invalidateQueries({ queryKey: PRODUCT_CHZ_LINK_QUERY_KEY });
  }
  useEffect(() => {
    if (result.data) {
      const receipt = JSON.stringify(result.data);
      if (invalidatedResult.current !== receipt) {
        invalidatedResult.current = receipt;
        void client.invalidateQueries({ queryKey: PRODUCTS_QUERY_KEY });
        void client.invalidateQueries({ queryKey: PRODUCT_CHZ_LINK_QUERY_KEY });
      }
    }
  }, [result.data, client]);
  useEffect(() => {
    if (result.data?.state === "finished" || result.data?.state === "cancelled")
      setRetryBlocked(false);
  }, [result.dataUpdatedAt, result.data?.state]);
  function route(
    ids: {
      sessionId: string;
      preparationId?: string;
      operationId?: string;
      step?: string;
      rejectedPreparationId?: string;
      rejectedPreviewIds?: string;
      rejectedReason?: string;
    },
    clearRejection = false,
  ) {
    const originalState: unknown = location.state;
    const state =
      originalState &&
      typeof originalState === "object" &&
      "catalogBackground" in originalState &&
      originalState.catalogBackground === true
        ? { catalogBackground: true }
        : null;
    const retainedRejection =
      !clearRejection && params.has("rejectedPreparationId")
        ? {
            rejectedPreparationId: params.get("rejectedPreparationId") ?? "",
            rejectedPreviewIds: params.get("rejectedPreviewIds") ?? "",
            rejectedReason: params.get("rejectedReason") ?? "",
          }
        : {};
    const retainedExact = exactEntry
      ? { exactCardId: exactCardId ?? "", exactGtin, originProductId }
      : {};
    setParams({ ...retainedExact, ...retainedRejection, ...ids }, { replace: true, state });
  }
  async function run(action: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      if (active.current) {
        const code = e instanceof ApiRequestError ? (e.code ?? e.message) : "";
        if (e instanceof ApiRequestError && e.status === 409) {
          setError(tr(code === "operation_running" ? "operationRunning" : "conflict"));
          if (code === "operation_running") {
            setRetryBlocked(true);
            await result.refetch();
          }
          if (code === "session_revision_conflict") await session.refetch();
        } else
          setError(
            tr(
              terminalError(e)
                ? "expired"
                : e instanceof ApiRequestError && [401, 403].includes(e.status)
                  ? "accessDenied"
                  : "requestFailed",
            ),
          );
      }
    } finally {
      lock.current = false;
      if (active.current) setBusy(false);
    }
  }
  function acceptedPreparation(data: ImportPrepareResponse, sid = sessionId) {
    client.setQueryData([...prefix, sid, data.preparation.id, "preparation"], data);
    route(
      { sessionId: sid, preparationId: data.preparation.id },
      data.preparation.id !== params.get("rejectedPreparationId"),
    );
    setReceiptToClear({ sessionId: sid, kind: "prepare", id: data.preparation.id });
  }
  function acceptedResult(data: Result, sid = sessionId) {
    invalidateResult(data);
    client.setQueryData([...prefix, sid, data.operationId, "result"], data);
    route({
      sessionId: sid,
      ...(preparationId ? { preparationId } : {}),
      operationId: data.operationId,
    });
    setReceiptToClear({ sessionId: sid, kind: "apply", id: data.operationId });
  }
  async function submitIntent(intent: PendingIntent) {
    try {
      saveIntent(identity, intent);
    } catch {
      setRecovery(loadIntent(identity, intent.sessionId));
      setError(tr("storageUnavailable"));
      return;
    }
    setPending(intent);
    try {
      if (intent.kind === "prepare") {
        const data = await api.prepareImport(intent.sessionId, intent.body, abort.current.signal);
        if (active.current) acceptedPreparation(data, intent.sessionId);
      } else {
        const data = await api.applyImport(intent.sessionId, intent.body, abort.current.signal);
        if (active.current) acceptedResult(data, intent.sessionId);
      }
    } catch (e) {
      if (
        active.current &&
        intent.kind === "apply" &&
        e instanceof ApiRequestError &&
        e.status === 409 &&
        (e.code ?? e.message) !== "operation_running"
      ) {
        const details = importApplyConflictSchema.safeParse(e.details);
        const attempted = new Set(intent.body.decisions.map((decision) => decision.previewId));
        const ids = details.success
          ? details.data.previewIds.filter((id) => attempted.has(id))
          : [];
        route({
          sessionId,
          preparationId,
          ...(operationId ? { operationId } : {}),
          rejectedPreparationId: preparationId,
          rejectedPreviewIds: ids.join(","),
          rejectedReason: details.success ? details.data.message : "",
        });
      }
      if (
        e instanceof ApiRequestError &&
        (e.status === 400 ||
          e.status === 410 ||
          (e.status === 409 &&
            (intent.kind === "prepare" ||
              ["preview_expired", "environment_mismatch"].includes(e.code ?? e.message))))
      ) {
        clearIntent(identity, intent.sessionId);
        if (active.current) setPending(null);
      }
      throw e;
    }
  }
  function prepare(drafts: ReviewDrafts = { manualNames: {}, categoryChoices: {} }) {
    if (!session.data || pending || storageBlocked || (exactEntry && !exactSelected && !showReview))
      return;
    const body: ImportPrepare = {
      requestId: crypto.randomUUID(),
      itemIds: [...session.data.selectedItemIds].sort(),
      manualNames: Object.entries(drafts.manualNames)
        .filter(([, name]) => name.trim())
        .map(([itemId, name]) => ({ itemId, name: name.trim() }))
        .sort((a, b) => a.itemId.localeCompare(b.itemId)),
      categoryChoices: Object.entries(drafts.categoryChoices)
        .filter(([, optionId]) => optionId)
        .map(([itemId, optionId]) => ({ itemId, optionId }))
        .sort((a, b) => a.itemId.localeCompare(b.itemId)),
    };
    void run(() =>
      submitIntent({
        version: 1,
        kind: "prepare",
        sessionId,
        expiresAt: session.data?.expiresAt ?? new Date().toISOString(),
        body,
      }),
    );
  }
  function apply(decisions: ImportDecision[]) {
    if (!session.data || pending || storageBlocked || comparisonRejected) return;
    const body: ImportApply = {
      requestId: crypto.randomUUID(),
      decisions: decisions
        .map((d) => ({ ...d, acceptedEntryIds: [...d.acceptedEntryIds].sort() }))
        .sort((a, b) => a.previewId.localeCompare(b.previewId)),
    };
    void run(() =>
      submitIntent({
        version: 1,
        kind: "apply",
        sessionId,
        expiresAt: session.data?.expiresAt ?? new Date().toISOString(),
        body,
      }),
    );
  }
  const readError = showResult
    ? result.error
    : showReview
      ? (preparation.error ?? session.error)
      : (session.error ?? items.error);
  return (
    <SidePanel
      open
      size="complex"
      title={tr("title")}
      closeLabel={t("common.close")}
      onClose={() => closeCatalogPanel(location, navigate)}
    >
      <div className="mk-nc-import">
        <nav aria-label={tr("steps")} className="mk-nc-actions">
          <Button
            variant="secondary"
            disabled={!sessionId || busy}
            onClick={() =>
              route({
                sessionId,
                ...(preparationId ? { preparationId } : {}),
                ...(operationId ? { operationId } : {}),
                step: "selection",
              })
            }
          >
            {tr("selection")}
          </Button>
          <Button
            variant="secondary"
            disabled={!preparationId || busy}
            onClick={() =>
              route({
                sessionId,
                preparationId,
                ...(operationId ? { operationId } : {}),
                step: "review",
              })
            }
          >
            {tr("review")}
          </Button>
          {operationId && (
            <Button
              variant="secondary"
              disabled={busy}
              aria-current={showResult ? "step" : undefined}
              onClick={() =>
                route({ sessionId, ...(preparationId ? { preparationId } : {}), operationId })
              }
            >
              {tr("result")}
            </Button>
          )}
        </nav>
        {error && <Alert tone="error">{error}</Alert>}
        {readError && (
          <Alert tone="error">{tr(terminalError(readError) ? "expired" : "loadFailed")}</Alert>
        )}
        {storageBlocked && (
          <Alert tone="error">
            <p>{tr("storageRecoveryBlocked")}</p>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => {
                setRecovery(loadIntent(identity, sessionId));
                setAbandonConfirm(false);
              }}
            >
              {tr("retryStorageRead")}
            </Button>
            {canWrite && (
              <>
                <Button variant="secondary" disabled={busy} onClick={() => setAbandonConfirm(true)}>
                  {tr("abandonRequest")}
                </Button>
                {abandonConfirm && (
                  <>
                    <p>{tr("abandonWarning")}</p>
                    <Button
                      variant="secondary"
                      disabled={busy}
                      onClick={() => {
                        try {
                          abandonIntent(identity, sessionId);
                          setRecovery({ status: "missing" });
                          setAbandonConfirm(false);
                          setError(null);
                        } catch {
                          setError(tr("storageUnavailable"));
                        }
                      }}
                    >
                      {tr("confirmAbandon")}
                    </Button>
                  </>
                )}
              </>
            )}
          </Alert>
        )}
        {pending && (
          <Alert>
            <p>{tr("pendingRequest")}</p>
            {canWrite && (
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => void run(() => submitIntent(pending))}
              >
                {tr("recoverRequest")}
              </Button>
            )}
          </Alert>
        )}
        {!sessionId && (
          <>
            <p>{tr("accessHint")}</p>
            {capabilities.isPending && <Spinner label={t("common.loading")} />}
            {capabilities.isError && <Alert tone="error">{tr("loadFailed")}</Alert>}
            {capabilities.data && (
              <>
                {capabilities.data.connection.state !== "ready" && (
                  <Alert>
                    {tr(
                      capabilities.data.connection.state === "missing"
                        ? "connectionMissing"
                        : "connectionBlocked",
                    )}
                  </Alert>
                )}
                {!canWrite && <Alert>{tr("readOnly")}</Alert>}
                {canWrite && (
                  <>
                    <Button
                      variant="secondary"
                      disabled={busy || !capabilities.data.ownCatalog}
                      onClick={() =>
                        void run(async () => {
                          const data = await api.startImport(
                            { mode: "own_catalog" },
                            abort.current.signal,
                          );
                          if (active.current) {
                            client.setQueryData([...prefix, data.id, "session"], data);
                            route({ sessionId: data.id });
                          }
                        })
                      }
                    >
                      {tr("loadOwn")}
                    </Button>
                    {!capabilities.data.ownCatalog && <p>{tr("modeUnavailable")}</p>}
                    <Textarea
                      label={tr("gtins")}
                      value={text}
                      onChange={(e) => setText(e.target.value)}
                      aria-describedby="nc-gtin-hint"
                    />
                    <p id="nc-gtin-hint">{tr("gtinsHint")}</p>
                    <Button
                      variant="secondary"
                      disabled={busy || !text.trim() || !capabilities.data.gtinLookup}
                      onClick={() =>
                        void run(async () => {
                          const data = await api.startImport(
                            { mode: "gtins", text },
                            abort.current.signal,
                          );
                          if (active.current) {
                            client.setQueryData([...prefix, data.id, "session"], data);
                            route({ sessionId: data.id });
                          }
                        })
                      }
                    >
                      {tr("loadGtins")}
                    </Button>
                    {!capabilities.data.gtinLookup && <p>{tr("modeUnavailable")}</p>}
                  </>
                )}
              </>
            )}
          </>
        )}
        {sessionId && !showResult && session.isPending && <Spinner label={t("common.loading")} />}
        {session.data && !showResult && !live && (
          <Alert>{tr(session.data.state === "cancelled" ? "cancelled" : "expired")}</Alert>
        )}
        {session.data && exactEntry && !showReview && !showResult && (
          <section className="mk-nc-review-item">
            <p>
              {exactGtin} · {exactCardId}
            </p>
            {exactReason ? (
              <Alert tone="warn">{t(`pages.catalog.chz.${exactReason}`)}</Alert>
            ) : !exactItems.data ? (
              <Spinner label={t("pages.catalog.chz.exactLoading")} />
            ) : (
              <>
                <p>{exactItem?.name}</p>
                {exactSelected ? (
                  <>
                    <p>{t("pages.catalog.chz.exactSelected")}</p>
                    <Button disabled={!mutable || busy} onClick={() => prepare()}>
                      {tr("compare")}
                    </Button>
                  </>
                ) : (
                  <Button
                    disabled={!mutable || busy}
                    onClick={() =>
                      void run(async () => {
                        if (!exactItem || exactReason) return;
                        const data = await api.saveImportSelection(
                          sessionId,
                          { expectedRevision: session.data.revision, itemIds: [exactItem.id] },
                          abort.current.signal,
                        );
                        if (active.current)
                          client.setQueryData([...prefix, sessionId, "session"], data);
                      })
                    }
                  >
                    {t("pages.catalog.chz.exactSelect")}
                  </Button>
                )}
              </>
            )}
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => {
                const originalState: unknown = location.state;
                const hasBackground =
                  originalState &&
                  typeof originalState === "object" &&
                  "catalogBackground" in originalState &&
                  originalState.catalogBackground === true;
                if (hasBackground) closeCatalogPanel(location, navigate);
                else if (/^[0-9a-f-]{36}$/i.test(originProductId))
                  void navigate(`/catalog/${originProductId}/chz`, { replace: true });
                else closeCatalogPanel(location, navigate);
              }}
            >
              {t("pages.catalog.chz.exactRetry")}
            </Button>
          </section>
        )}
        {session.data && !exactEntry && !showReview && !showResult && items.data && (
          <ImportSelection
            session={session.data}
            data={items.data}
            query={query}
            onQuery={setQuery}
            canWrite={mutable}
            busy={busy}
            onPrepare={() => prepare()}
            onSelection={(ids) =>
              void run(async () => {
                const data = await api.saveImportSelection(
                  sessionId,
                  { expectedRevision: session.data.revision, itemIds: ids },
                  abort.current.signal,
                );
                if (active.current) client.setQueryData([...prefix, sessionId, "session"], data);
              })
            }
          />
        )}
        {session.data &&
          !showReview &&
          !showResult &&
          mutable &&
          ["partial", "blocked"].includes(session.data.state) && (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const data = await api.retrySession(sessionId, abort.current.signal);
                  if (active.current) client.setQueryData([...prefix, sessionId, "session"], data);
                })
              }
            >
              {tr("retryList")}
            </Button>
          )}
        {preparation.data && showReview && (
          <ImportReview
            key={preparation.data.preparation.id}
            sessionId={sessionId}
            data={preparation.data}
            canPreparePhotos={capabilities.data?.photos === true}
            canWrite={mutable}
            busy={busy}
            comparisonRejected={comparisonRejected}
            rejectedPreviewIds={rejectedPreviewIds}
            onPrepare={prepare}
            onApply={apply}
            onPhoto={(pid, cid) =>
              void run(async () => {
                await api.preparePhoto(sessionId, pid, cid, abort.current.signal);
                await preparation.refetch();
              })
            }
            onRetry={() =>
              void run(async () => {
                const data = await api.retryPreparation(
                  sessionId,
                  preparationId,
                  abort.current.signal,
                );
                if (active.current)
                  client.setQueryData([...prefix, sessionId, preparationId, "preparation"], data);
              })
            }
          />
        )}
        {result.data && showResult && (
          <ImportResult
            result={result.data}
            canWrite={canWrite}
            busy={busy}
            retryBlocked={retryBlocked}
            onRetry={(ids) =>
              void run(async () => {
                const data = await api.retryImport(
                  sessionId,
                  operationId,
                  ids,
                  abort.current.signal,
                );
                if (active.current) {
                  setRetryBlocked(false);
                  acceptedResult(data);
                }
              })
            }
            onCancel={() =>
              void run(async () => {
                await api.cancelImport(sessionId, abort.current.signal);
                await result.refetch();
              })
            }
          />
        )}
        {sessionId && readError && !terminalError(readError) && (
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => void client.invalidateQueries({ queryKey: [...prefix, sessionId] })}
          >
            {tr("reload")}
          </Button>
        )}
      </div>
    </SidePanel>
  );
}
