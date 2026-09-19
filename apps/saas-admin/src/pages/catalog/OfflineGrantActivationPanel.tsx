import type {
  PlatformGrantActivationCancelRequest,
  PlatformGrantActivationConfirmRequest,
  PlatformGrantActivationPreparation,
  PlatformGrantActivationPrepareRequest,
  PlatformGrantReadinessPreviewResponse,
} from "@markiro/platform-contracts";
import {
  Alert,
  Button,
  Input,
  StatusChip,
  Table,
  type TableColumn,
  type TagPhase,
} from "@markiro/ui";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  activationErrorKind,
  cancelOfflineGrantActivation,
  confirmOfflineGrantActivation,
  listOfflineGrantActivations,
  prepareOfflineGrantActivation,
} from "./offline-grant-activation-api.js";
import { activationKeys, type GrantActivationAttempt } from "./offline-grant-activation-state.js";
import { OfflineGrantRollbackPanel } from "./OfflineGrantRollbackPanel.js";

type PrepareAttempt = GrantActivationAttempt<
  PlatformGrantActivationPrepareRequest,
  PlatformGrantActivationPreparation
>;
type ConfirmAttempt = GrantActivationAttempt<PlatformGrantActivationConfirmRequest, null>;
type CancelAttempt = GrantActivationAttempt<PlatformGrantActivationCancelRequest, null>;

/**
 * Фактический union — `grantActivationStateSchema`
 * (`packages/platform-contracts/src/offline-grant-activations.ts`): пять
 * значений. Раньше три ветки схлопывали `cancelled`, `expired` и
 * `needs_review` в один и тот же серый тег, и партия, которой нужна ручная
 * проверка, выглядела как обычная отменённая партия. `expired` — система
 * прекратила действие сама, без участия человека (`failed`, как истёкший
 * токен агента подписи в `apps/admin/src/pages/integrations/
 * SignerAgentsPanel.tsx`), а не `retired` (человек отозвал).
 */
export function grantActivationStatePhase(
  state: PlatformGrantActivationPreparation["state"],
): TagPhase {
  switch (state) {
    case "prepared":
      return "planned";
    case "confirmed":
      return "done";
    case "cancelled":
      return "retired";
    case "expired":
      return "failed";
    case "needs_review":
      return "attention";
  }
}

export function OfflineGrantActivationPanel({
  preview,
  canActivate,
  currentUserId,
  onDirtyChange,
}: {
  preview: PlatformGrantReadinessPreviewResponse | null;
  canActivate: boolean;
  currentUserId: string;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const list = useInfiniteQuery({
    queryKey: activationKeys.list,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => listOfflineGrantActivations(pageParam ? { cursor: pageParam } : {}),
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });
  const [decisionReference, setDecisionReference] = useState("");
  const [cancellation, setCancellation] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<"uncertain" | "stale" | null>(null);
  const [rollbackDirty, setRollbackDirty] = useState(false);
  const items = list.data?.pages.flatMap((page) => page.items) ?? [];
  const prepareAttempt = queryClient.getQueryData<PrepareAttempt>(activationKeys.prepare);
  const mutationUncertain = items.some(
    (item) =>
      queryClient.getQueryData<ConfirmAttempt>(activationKeys.confirm(item.id))?.notice ===
        "uncertain" ||
      queryClient.getQueryData<CancelAttempt>(activationKeys.cancel(item.id))?.notice ===
        "uncertain",
  );
  const dirty =
    decisionReference.length > 0 ||
    Object.values(cancellation).some(Boolean) ||
    prepareAttempt?.notice === "uncertain" ||
    mutationUncertain ||
    rollbackDirty;

  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  useEffect(() => {
    if (list.hasNextPage && !list.isFetchingNextPage) void list.fetchNextPage();
  }, [list.fetchNextPage, list.hasNextPage, list.isFetchingNextPage]);

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: activationKeys.list });
  };
  const prepare = useMutation({
    mutationFn: async () => {
      if (!preview) throw new Error("preview_required");
      const cached = queryClient.getQueryData<PrepareAttempt>(activationKeys.prepare);
      const request =
        cached?.notice === "uncertain"
          ? cached.request
          : {
              protocol: "offline-grants-activation-v1" as const,
              previewRequestId: preview.requestId,
              previewDigest: preview.previewDigest,
              policyId: preview.policyId,
              deviceIds: preview.items.map((item) => item.deviceId),
              decisionReference: decisionReference.trim(),
              requestId: crypto.randomUUID(),
            };
      queryClient.setQueryData<PrepareAttempt>(activationKeys.prepare, {
        request,
        response: null,
        notice: null,
      });
      return prepareOfflineGrantActivation(request);
    },
    onSuccess: async (response) => {
      queryClient.setQueryData<PrepareAttempt>(activationKeys.prepare, {
        request: queryClient.getQueryData<PrepareAttempt>(activationKeys.prepare)!.request,
        response,
        notice: null,
      });
      setDecisionReference("");
      setNotice(null);
      await refresh();
    },
    onError: (error) => {
      const kind = activationErrorKind(error);
      const current = queryClient.getQueryData<PrepareAttempt>(activationKeys.prepare);
      if (current) queryClient.setQueryData(activationKeys.prepare, { ...current, notice: kind });
      setNotice(kind === "authorization" ? "stale" : kind);
    },
  });

  const confirm = useMutation({
    mutationFn: async (preparation: PlatformGrantActivationPreparation) => {
      const key = activationKeys.confirm(preparation.id);
      const cached = queryClient.getQueryData<ConfirmAttempt>(key);
      const request =
        cached?.notice === "uncertain"
          ? cached.request
          : {
              protocol: "offline-grants-activation-v1" as const,
              preparationDigest: preparation.preparationDigest,
              requestId: crypto.randomUUID(),
            };
      queryClient.setQueryData<ConfirmAttempt>(key, { request, response: null, notice: null });
      return confirmOfflineGrantActivation(preparation.id, request);
    },
    onSuccess: async (result, preparation) => {
      queryClient.removeQueries({ queryKey: activationKeys.confirm(preparation.id), exact: true });
      setNotice(result.status === "needs_review" ? "stale" : null);
      await refresh();
    },
    onError: (error, preparation) => {
      const key = activationKeys.confirm(preparation.id);
      const current = queryClient.getQueryData<ConfirmAttempt>(key);
      const kind = activationErrorKind(error);
      if (current) queryClient.setQueryData(key, { ...current, notice: kind });
      setNotice(kind === "authorization" ? "stale" : kind);
    },
  });

  const cancel = useMutation({
    mutationFn: async (preparation: PlatformGrantActivationPreparation) => {
      const key = activationKeys.cancel(preparation.id);
      const cached = queryClient.getQueryData<CancelAttempt>(key);
      const request =
        cached?.notice === "uncertain"
          ? cached.request
          : {
              protocol: "offline-grants-activation-v1" as const,
              reason: cancellation[preparation.id]?.trim() ?? "",
              requestId: crypto.randomUUID(),
            };
      queryClient.setQueryData<CancelAttempt>(key, { request, response: null, notice: null });
      return cancelOfflineGrantActivation(preparation.id, request);
    },
    onSuccess: async (_result, preparation) => {
      queryClient.removeQueries({ queryKey: activationKeys.cancel(preparation.id), exact: true });
      setCancellation((current) => ({ ...current, [preparation.id]: "" }));
      setNotice(null);
      await refresh();
    },
    onError: (error, preparation) => {
      const key = activationKeys.cancel(preparation.id);
      const current = queryClient.getQueryData<CancelAttempt>(key);
      const kind = activationErrorKind(error);
      if (current) queryClient.setQueryData(key, { ...current, notice: kind });
      setNotice(kind === "authorization" ? "stale" : kind);
    },
  });

  const columns: TableColumn<PlatformGrantActivationPreparation>[] = [
    {
      key: "cohort",
      title: t("catalog.offlineActivation.columns.cohort"),
      render: (item) =>
        `${item.members.length} · ${item.basePolicy.policyKey} v${item.basePolicy.version}`,
    },
    {
      key: "state",
      title: t("catalog.offlineActivation.columns.state"),
      render: (item) => (
        <StatusChip
          phase={grantActivationStatePhase(item.state)}
          label={t(`catalog.offlineActivation.state.${item.state}`)}
        />
      ),
    },
    {
      key: "actors",
      title: t("catalog.offlineActivation.columns.actors"),
      render: (item) =>
        `${item.preparedBy.userId}${item.confirmedBy ? ` → ${item.confirmedBy.userId}` : ""}`,
    },
  ];
  return (
    <section aria-labelledby="offline-grant-activation-heading" className="catalog-form">
      <h3 id="offline-grant-activation-heading">{t("catalog.offlineActivation.title")}</h3>
      <Alert tone="info">{t("catalog.offlineActivation.compatibility")}</Alert>
      {notice ? (
        <Alert tone={notice === "uncertain" ? "error" : "warn"}>
          {t(`catalog.offlineActivation.notice.${notice}`)}
        </Alert>
      ) : null}
      {preview && preview.aggregates.blocked === 0 && canActivate ? (
        <div className="catalog-form__actions">
          <Input
            label={t("catalog.offlineActivation.decisionReference")}
            value={decisionReference}
            disabled={prepareAttempt?.notice === "uncertain"}
            onChange={(event) => setDecisionReference(event.target.value)}
          />
          <Button
            type="button"
            disabled={
              prepare.isPending ||
              (!decisionReference.trim() && prepareAttempt?.notice !== "uncertain")
            }
            onClick={() => prepare.mutate()}
          >
            {t("catalog.offlineActivation.prepare")}
          </Button>
        </div>
      ) : null}
      {list.isError ? <Alert tone="error">{t("catalog.offlineActivation.loadError")}</Alert> : null}
      {items.length ? <Table columns={columns} rows={items} empty="" /> : null}
      {items.map((item) => {
        const actionable = item.state === "prepared" || item.state === "needs_review";
        if (!actionable) return null;
        const sameOperator = item.preparedBy.userId === currentUserId;
        return (
          <article key={item.id} className="catalog-form">
            <h4>{item.decisionReference}</h4>
            <p>
              {t("catalog.offlineActivation.preparedAt", {
                preparedAt: new Date(item.preparedAt).toLocaleString(),
                expiresAt: new Date(item.expiresAt).toLocaleString(),
              })}
            </p>
            {sameOperator ? (
              <Alert tone="warn">{t("catalog.offlineActivation.secondOperator")}</Alert>
            ) : null}
            <div className="catalog-form__actions">
              <Button
                type="button"
                disabled={!canActivate || sameOperator || confirm.isPending}
                onClick={() => confirm.mutate(item)}
              >
                {t("catalog.offlineActivation.confirm")}
              </Button>
              <Input
                label={t("catalog.offlineActivation.cancelReason")}
                value={cancellation[item.id] ?? ""}
                onChange={(event) =>
                  setCancellation((current) => ({ ...current, [item.id]: event.target.value }))
                }
              />
              <Button
                type="button"
                variant="secondary"
                disabled={!canActivate || cancel.isPending || !(cancellation[item.id] ?? "").trim()}
                onClick={() => cancel.mutate(item)}
              >
                {t("catalog.offlineActivation.cancel")}
              </Button>
            </div>
          </article>
        );
      })}
      <OfflineGrantRollbackPanel
        canActivate={canActivate}
        currentUserId={currentUserId}
        onDirtyChange={setRollbackDirty}
      />
    </section>
  );
}
