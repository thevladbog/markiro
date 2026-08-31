import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, Card, Checkbox, Modal, Spinner, Textarea } from "@markiro/ui";

import { ApiRequestError } from "../../api/client.js";
import { useCloseInventory, useInventoryClosePreview, useReopenInventory } from "./api.js";
import { InventoryLateEvents } from "./InventoryLateEvents.js";
import {
  inventoryCloseBlockedErrorSchema,
  type InventoryCloseBlocker,
  type InventoryProgress,
} from "./schemas.js";

const BLOCKER_KEYS: Record<InventoryCloseBlocker["code"], string> = {
  ACTIVE_PARTICIPANT: "active",
  STALE_PARTICIPANT: "stale",
  PENDING_OUTBOX: "pending",
  PARTICIPANT_OPEN_BOX: "participantBoxes",
  OPEN_REPACK_BOX: "openBoxes",
  INVALIDATED_REPACK_BOX: "invalidated",
  UNRESOLVED_BOX_PRINT: "unresolvedPrint",
  UNRESOLVED_DISCREPANCY: "discrepancies",
};

/**
 * Invalidated boxes split by source: the cabinet's own `invalidate_box` correction
 * blocks a safe close forever, while a scan conflict can still be undone from the
 * terminal. The manager needs the difference to decide between calling the line and
 * closing the inventory in emergency mode.
 */
function blockerKey(blocker: InventoryCloseBlocker): string {
  if (blocker.code === "INVALIDATED_REPACK_BOX" && blocker.invalidationSource !== null) {
    return `invalidated_${blocker.invalidationSource}`;
  }
  return BLOCKER_KEYS[blocker.code];
}

export function InventoryClosePanel({
  inventoryId,
  status,
}: {
  inventoryId: string;
  status: "running" | "closed" | "completed";
  progress: InventoryProgress;
}) {
  const { t } = useTranslation();
  const close = useCloseInventory();
  const reopen = useReopenInventory();
  const [closeOpen, setCloseOpen] = useState(false);
  const [reopenOpen, setReopenOpen] = useState(false);
  const [lateOpen, setLateOpen] = useState(false);
  const [emergencyReason, setEmergencyReason] = useState("");
  const [acknowledgeBlockers, setAcknowledgeBlockers] = useState(false);
  const [authoritativeBlockers, setAuthoritativeBlockers] = useState<
    InventoryCloseBlocker[] | null
  >(null);
  const [success, setSuccess] = useState<"closed" | "reopened" | null>(null);
  const preview = useInventoryClosePreview(inventoryId, closeOpen && status === "running");
  const blockers = authoritativeBlockers ?? preview.data?.blockers ?? [];
  const hasBlockers = blockers.length > 0;
  const emergencyReasonBytes = new TextEncoder().encode(emergencyReason.trim()).byteLength;
  const emergencyReasonValid = emergencyReasonBytes > 0 && emergencyReasonBytes <= 4096;

  const closeInventory = (emergency: boolean) => {
    close.mutate(
      {
        inventoryId,
        ...(emergency ? { emergencyReason: emergencyReason.trim() } : {}),
      },
      {
        onSuccess: () => {
          setSuccess("closed");
          setCloseOpen(false);
        },
        onError: (error) => {
          if (error instanceof ApiRequestError && error.code === "INVENTORY_CLOSE_BLOCKED") {
            const parsed = inventoryCloseBlockedErrorSchema.safeParse(error.details);
            if (parsed.success) setAuthoritativeBlockers(parsed.data.blockers);
          }
        },
      },
    );
  };

  const reopenInventory = () => {
    reopen.mutate(inventoryId, {
      onSuccess: () => {
        setSuccess("reopened");
        setReopenOpen(false);
      },
    });
  };

  return (
    <Card title={t("pages.inventory.close.title")} titleAs="h2">
      <div className="mk-inventory-close-panel">
        {success ? <Alert tone="ok">{t(`pages.inventory.close.success.${success}`)}</Alert> : null}
        {close.isError || reopen.isError ? (
          <Alert tone="error">{t("pages.inventory.close.actionError")}</Alert>
        ) : null}

        {status === "running" ? (
          <>
            <p className="mk-inventory-section-description">
              {t("pages.inventory.close.runningHint")}
            </p>
            <div className="mk-inventory-actions">
              <Button
                variant="secondary"
                onClick={() => {
                  setAuthoritativeBlockers(null);
                  setCloseOpen(true);
                }}
              >
                {t("pages.inventory.close.open")}
              </Button>
              <Button variant="secondary" onClick={() => setLateOpen(true)}>
                {t("pages.inventory.late.open")}
              </Button>
            </div>
          </>
        ) : null}

        {status === "closed" ? (
          <>
            <Alert tone="info">{t("pages.inventory.close.closedHint")}</Alert>
            <div className="mk-inventory-actions">
              <Button variant="secondary" onClick={() => setLateOpen(true)}>
                {t("pages.inventory.late.open")}
              </Button>
              <Button variant="warning-outline" onClick={() => setReopenOpen(true)}>
                {t("pages.inventory.close.reopen")}
              </Button>
            </div>
          </>
        ) : null}

        {status === "completed" ? (
          <>
            <Alert tone="ok">{t("pages.inventory.close.completedImmutable")}</Alert>
            <Button variant="secondary" onClick={() => setLateOpen(true)}>
              {t("pages.inventory.late.open")}
            </Button>
          </>
        ) : null}
      </div>

      <Modal
        open={closeOpen}
        title={t("pages.inventory.close.modalTitle")}
        closeLabel={t("common.cancel")}
        onClose={() => setCloseOpen(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setCloseOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              disabled={preview.isPending || hasBlockers}
              loading={close.isPending}
              onClick={() => closeInventory(false)}
            >
              {t("pages.inventory.close.safe")}
            </Button>
            {hasBlockers ? (
              <Button
                variant="destructive"
                disabled={!emergencyReasonValid || !acknowledgeBlockers}
                loading={close.isPending}
                onClick={() => closeInventory(true)}
              >
                {t("pages.inventory.close.emergency")}
              </Button>
            ) : null}
          </>
        }
      >
        {preview.isPending && authoritativeBlockers === null ? (
          <Spinner label={t("pages.inventory.close.previewLoading")} />
        ) : null}
        {preview.isError && authoritativeBlockers === null ? (
          <Alert tone="error">{t("pages.inventory.close.previewError")}</Alert>
        ) : null}
        {!preview.isPending && !preview.isError && !hasBlockers ? (
          <Alert tone="ok">{t("pages.inventory.close.ready")}</Alert>
        ) : null}
        {hasBlockers ? (
          <div className="mk-inventory-close-panel">
            <Alert tone="warn">{t("pages.inventory.close.blocked")}</Alert>
            <ul className="mk-inventory-close-blockers">
              {blockers.map((item) => (
                <li
                  key={`${item.code}:${item.discrepancyCategory ?? item.invalidationSource ?? "all"}`}
                >
                  {t(`pages.inventory.close.blocker.${blockerKey(item)}`, {
                    count: item.count,
                  })}
                  {item.code === "INVALIDATED_REPACK_BOX" && item.invalidationSource !== null ? (
                    <small>{t(`pages.inventory.close.blockerHint.${blockerKey(item)}`)}</small>
                  ) : null}
                </li>
              ))}
            </ul>
            <Textarea
              label={t("pages.inventory.close.emergencyReason")}
              value={emergencyReason}
              required
              onChange={(event) => setEmergencyReason(event.currentTarget.value)}
            />
            {emergencyReasonBytes > 4096 ? (
              <Alert tone="error">{t("pages.inventory.close.reasonTooLong")}</Alert>
            ) : null}
            <Checkbox
              checked={acknowledgeBlockers}
              onCheckedChange={setAcknowledgeBlockers}
              label={t("pages.inventory.close.acknowledgeBlockers")}
            />
          </div>
        ) : null}
      </Modal>

      <Modal
        open={reopenOpen}
        title={t("pages.inventory.close.reopenConfirmTitle")}
        closeLabel={t("common.cancel")}
        onClose={() => setReopenOpen(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setReopenOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button variant="warning-outline" loading={reopen.isPending} onClick={reopenInventory}>
              {t("pages.inventory.close.reopenConfirm")}
            </Button>
          </>
        }
      >
        <Alert tone="warn">{t("pages.inventory.close.reopenExplanation")}</Alert>
        {reopen.isError ? (
          <Alert tone="error">{t("pages.inventory.close.actionError")}</Alert>
        ) : null}
      </Modal>

      <InventoryLateEvents
        inventoryId={inventoryId}
        inventoryStatus={status}
        open={lateOpen}
        onClose={() => setLateOpen(false)}
      />
    </Card>
  );
}
