import { useTranslation } from "react-i18next";

import { Alert, Badge, Button, type BadgeTone } from "@markiro/ui";

import { useChzExportState, useOrderChzExports, useRetryChzExport } from "./api.js";
import type { ChzExportRunState, InventoryChzStatus } from "./schemas.js";

const RUN_BADGE_TONE: Record<ChzExportRunState, BadgeTone> = {
  queued: "neutral",
  ordered: "info",
  ready: "info",
  imported: "ok",
  failed: "error",
};

/**
 * The «Заказать из Честного Знака» button and blocker list. Lives above the
 * upload grid; ordering is one action for all six statuses (Task 7's
 * `POST /chz-exports` skips statuses already in flight or imported).
 */
export function ChzExportOrderButton({
  inventoryId,
  canMutate,
}: {
  inventoryId: string;
  canMutate: boolean;
}) {
  const { t } = useTranslation();
  const state = useChzExportState(inventoryId);
  const order = useOrderChzExports();
  const blockedBy = state.data?.blockedBy ?? [];
  const disabled = !canMutate || !state.data?.available || order.isPending;

  return (
    <div className="mk-chz-exports-order">
      <Button
        type="button"
        variant="secondary"
        disabled={disabled}
        loading={order.isPending}
        onClick={() => order.mutate(inventoryId)}
      >
        {order.isPending
          ? t("pages.inventory.chzExports.ordering")
          : t("pages.inventory.chzExports.order")}
      </Button>
      {blockedBy.length > 0 ? (
        <Alert tone="warn">
          <ul className="mk-chz-exports-blockers">
            {blockedBy.map((code) => (
              <li key={code}>{t(`pages.inventory.chzExports.blocked.${code}`)}</li>
            ))}
          </ul>
        </Alert>
      ) : null}
      {order.isError ? <Alert tone="error">{order.error.message}</Alert> : null}
    </div>
  );
}

/**
 * Per-status run state, rendered inside each upload slot alongside the
 * unconditional `FileDropZone` manual-upload fallback.
 */
export function ChzExportRunStatus({
  inventoryId,
  status,
}: {
  inventoryId: string;
  status: InventoryChzStatus;
}) {
  const { t } = useTranslation();
  const state = useChzExportState(inventoryId);
  const retry = useRetryChzExport();
  const run = state.data?.runs.find((item) => item.status === status);
  if (!run) return null;

  return (
    <div className="mk-chz-export-run">
      <Badge tone={RUN_BADGE_TONE[run.state]}>
        {t(`pages.inventory.chzExports.state.${run.state}`)}
      </Badge>
      {run.state === "failed" ? (
        <>
          {run.errorMessage ? (
            <small className="mk-inventory-error">{run.errorMessage}</small>
          ) : null}
          <Button
            type="button"
            variant="secondary"
            size="compact"
            loading={retry.isPending && retry.variables?.status === status}
            onClick={() => retry.mutate({ inventoryId, status })}
          >
            {t("pages.inventory.chzExports.retry")}
          </Button>
        </>
      ) : null}
    </div>
  );
}
