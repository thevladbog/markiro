import type {
  PlatformGrantRollbackCancelRequest,
  PlatformGrantRollbackConfirmRequest,
  PlatformGrantRollbackPreparation,
  PlatformGrantRollbackPrepareRequest,
} from "@markiro/platform-contracts";
import { Alert, Button, Input } from "@markiro/ui";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { activationErrorKind } from "./offline-grant-activation-api.js";
import {
  cancelOfflineGrantRollback,
  confirmOfflineGrantRollback,
  listOfflineGrantRollbackCandidates,
  listOfflineGrantRollbacks,
  prepareOfflineGrantRollback,
} from "./offline-grant-rollback-api.js";
import { rollbackKeys, type GrantRollbackAttempt } from "./offline-grant-rollback-state.js";

type PrepareAttempt = GrantRollbackAttempt<PlatformGrantRollbackPrepareRequest>;
type ConfirmAttempt = GrantRollbackAttempt<PlatformGrantRollbackConfirmRequest>;
type CancelAttempt = GrantRollbackAttempt<PlatformGrantRollbackCancelRequest>;

export function OfflineGrantRollbackPanel({
  canActivate,
  currentUserId,
  onDirtyChange,
}: {
  canActivate: boolean;
  currentUserId: string;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const candidates = useInfiniteQuery({
    queryKey: rollbackKeys.candidates,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      listOfflineGrantRollbackCandidates(pageParam ? { cursor: pageParam } : {}),
    getNextPageParam: (page) => page.nextCursor,
  });
  const rollbacks = useInfiniteQuery({
    queryKey: rollbackKeys.list,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => listOfflineGrantRollbacks(pageParam ? { cursor: pageParam } : {}),
    getNextPageParam: (page) => page.nextCursor,
  });
  const [selected, setSelected] = useState<string[]>([]);
  const [decisionReference, setDecisionReference] = useState("");
  const [cancellation, setCancellation] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<"uncertain" | "stale" | null>(null);
  const candidateItems = candidates.data?.pages.flatMap((page) => page.items) ?? [];
  const rollbackItems = rollbacks.data?.pages.flatMap((page) => page.items) ?? [];
  const prepareAttempt = queryClient.getQueryData<PrepareAttempt>(rollbackKeys.prepare);
  const unresolved = rollbackItems.some(
    (item) =>
      queryClient.getQueryData<ConfirmAttempt>(rollbackKeys.confirm(item.id))?.notice ===
        "uncertain" ||
      queryClient.getQueryData<CancelAttempt>(rollbackKeys.cancel(item.id))?.notice === "uncertain",
  );
  const dirty =
    selected.length > 0 ||
    decisionReference.length > 0 ||
    Object.values(cancellation).some(Boolean) ||
    prepareAttempt?.notice === "uncertain" ||
    unresolved;
  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  useEffect(() => {
    if (candidates.hasNextPage && !candidates.isFetchingNextPage) void candidates.fetchNextPage();
  }, [candidates.fetchNextPage, candidates.hasNextPage, candidates.isFetchingNextPage]);
  useEffect(() => {
    if (rollbacks.hasNextPage && !rollbacks.isFetchingNextPage) void rollbacks.fetchNextPage();
  }, [rollbacks.fetchNextPage, rollbacks.hasNextPage, rollbacks.isFetchingNextPage]);
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: rollbackKeys.candidates }),
      queryClient.invalidateQueries({ queryKey: rollbackKeys.list }),
    ]);
  };
  const prepare = useMutation({
    mutationFn: async () => {
      const cached = queryClient.getQueryData<PrepareAttempt>(rollbackKeys.prepare);
      const request =
        cached?.notice === "uncertain"
          ? cached.request
          : {
              protocol: "offline-grants-rollback-v1" as const,
              activationIds: selected,
              decisionReference: decisionReference.trim(),
              requestId: crypto.randomUUID(),
            };
      queryClient.setQueryData<PrepareAttempt>(rollbackKeys.prepare, { request, notice: null });
      return prepareOfflineGrantRollback(request);
    },
    onSuccess: async () => {
      queryClient.removeQueries({ queryKey: rollbackKeys.prepare, exact: true });
      setSelected([]);
      setDecisionReference("");
      setNotice(null);
      await refresh();
    },
    onError: (error) => {
      const kind = activationErrorKind(error);
      const current = queryClient.getQueryData<PrepareAttempt>(rollbackKeys.prepare);
      if (current) queryClient.setQueryData(rollbackKeys.prepare, { ...current, notice: kind });
      setNotice(kind === "authorization" ? "stale" : kind);
    },
  });
  const confirm = useMutation({
    mutationFn: async (item: PlatformGrantRollbackPreparation) => {
      const key = rollbackKeys.confirm(item.id);
      const cached = queryClient.getQueryData<ConfirmAttempt>(key);
      const request =
        cached?.notice === "uncertain"
          ? cached.request
          : {
              protocol: "offline-grants-rollback-v1" as const,
              rollbackDigest: item.rollbackDigest,
              requestId: crypto.randomUUID(),
            };
      queryClient.setQueryData<ConfirmAttempt>(key, { request, notice: null });
      return confirmOfflineGrantRollback(item.id, request);
    },
    onSuccess: async (result, item) => {
      queryClient.removeQueries({ queryKey: rollbackKeys.confirm(item.id), exact: true });
      setNotice(result.status === "needs_review" ? "stale" : null);
      await refresh();
    },
    onError: (error, item) => {
      const key = rollbackKeys.confirm(item.id);
      const current = queryClient.getQueryData<ConfirmAttempt>(key);
      const kind = activationErrorKind(error);
      if (current) queryClient.setQueryData(key, { ...current, notice: kind });
      setNotice(kind === "authorization" ? "stale" : kind);
    },
  });
  const cancel = useMutation({
    mutationFn: async (item: PlatformGrantRollbackPreparation) => {
      const key = rollbackKeys.cancel(item.id);
      const cached = queryClient.getQueryData<CancelAttempt>(key);
      const request =
        cached?.notice === "uncertain"
          ? cached.request
          : {
              protocol: "offline-grants-rollback-v1" as const,
              reason: cancellation[item.id]?.trim() ?? "",
              requestId: crypto.randomUUID(),
            };
      queryClient.setQueryData<CancelAttempt>(key, { request, notice: null });
      return cancelOfflineGrantRollback(item.id, request);
    },
    onSuccess: async (_result, item) => {
      queryClient.removeQueries({ queryKey: rollbackKeys.cancel(item.id), exact: true });
      setCancellation((value) => ({ ...value, [item.id]: "" }));
      setNotice(null);
      await refresh();
    },
    onError: (error, item) => {
      const key = rollbackKeys.cancel(item.id);
      const current = queryClient.getQueryData<CancelAttempt>(key);
      const kind = activationErrorKind(error);
      if (current) queryClient.setQueryData(key, { ...current, notice: kind });
      setNotice(kind === "authorization" ? "stale" : kind);
    },
  });
  return (
    <section aria-labelledby="offline-grant-rollback-heading" className="catalog-form">
      <h3 id="offline-grant-rollback-heading">{t("catalog.offlineRollback.title")}</h3>
      <Alert tone="info">{t("catalog.offlineRollback.compatibility")}</Alert>
      {notice ? (
        <Alert tone={notice === "uncertain" ? "error" : "warn"}>
          {t(`catalog.offlineRollback.notice.${notice}`)}
        </Alert>
      ) : null}
      {candidates.isError || rollbacks.isError ? (
        <Alert tone="error">{t("catalog.offlineRollback.loadError")}</Alert>
      ) : null}
      {candidateItems.length ? (
        <fieldset disabled={!canActivate || prepareAttempt?.notice === "uncertain"}>
          <legend>{t("catalog.offlineRollback.candidates")}</legend>
          {candidateItems.map((item) => (
            <label key={item.activationId} className="catalog-checkbox">
              <input
                type="checkbox"
                checked={selected.includes(item.activationId)}
                onChange={() =>
                  setSelected((value) =>
                    value.includes(item.activationId)
                      ? value.filter((id) => id !== item.activationId)
                      : [...value, item.activationId],
                  )
                }
              />{" "}
              {item.tenantName} · {item.deviceName} · {item.strictDecisionReference}
            </label>
          ))}
        </fieldset>
      ) : (
        <p>{t("catalog.offlineRollback.empty")}</p>
      )}
      <div className="catalog-form__actions">
        <Input
          label={t("catalog.offlineRollback.decisionReference")}
          value={decisionReference}
          disabled={prepareAttempt?.notice === "uncertain"}
          onChange={(event) => setDecisionReference(event.target.value)}
        />
        <Button
          type="button"
          disabled={
            !canActivate ||
            prepare.isPending ||
            (prepareAttempt?.notice !== "uncertain" &&
              (selected.length === 0 || !decisionReference.trim()))
          }
          onClick={() => prepare.mutate()}
        >
          {t("catalog.offlineRollback.prepare")}
        </Button>
      </div>
      {rollbackItems
        .filter((item) => item.state === "prepared" || item.state === "needs_review")
        .map((item) => {
          const sameOperator = item.preparedBy.userId === currentUserId;
          return (
            <article key={item.id} className="catalog-form">
              <h4>{item.decisionReference}</h4>
              <p>
                {t("catalog.offlineRollback.summary", {
                  count: item.members.length,
                  expiresAt: new Date(item.expiresAt).toLocaleString(),
                })}
              </p>
              {sameOperator ? (
                <Alert tone="warn">{t("catalog.offlineRollback.secondOperator")}</Alert>
              ) : null}
              <div className="catalog-form__actions">
                <Button
                  type="button"
                  disabled={!canActivate || sameOperator || confirm.isPending}
                  onClick={() => confirm.mutate(item)}
                >
                  {t("catalog.offlineRollback.confirm")}
                </Button>
                <Input
                  label={t("catalog.offlineRollback.cancelReason")}
                  value={cancellation[item.id] ?? ""}
                  onChange={(event) =>
                    setCancellation((value) => ({ ...value, [item.id]: event.target.value }))
                  }
                />
                <Button
                  type="button"
                  variant="secondary"
                  disabled={
                    !canActivate || cancel.isPending || !(cancellation[item.id] ?? "").trim()
                  }
                  onClick={() => cancel.mutate(item)}
                >
                  {t("catalog.offlineRollback.cancel")}
                </Button>
              </div>
            </article>
          );
        })}
    </section>
  );
}
