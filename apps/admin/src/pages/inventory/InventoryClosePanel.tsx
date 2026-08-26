import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, Card, Checkbox, Modal, Textarea } from "@markiro/ui";

import { useCloseInventory, useCompleteInventory, useReopenInventory } from "./api.js";
import { InventoryLateEvents } from "./InventoryLateEvents.js";
import type { InventoryProgress } from "./schemas.js";

interface ClosePreviewItem {
  key: string;
  count: number;
}

export function InventoryClosePanel({
  inventoryId,
  status,
  progress,
}: {
  inventoryId: string;
  status: "running" | "closed" | "completed";
  progress: InventoryProgress;
}) {
  const { t } = useTranslation();
  const close = useCloseInventory();
  const reopen = useReopenInventory();
  const complete = useCompleteInventory();
  const [closeOpen, setCloseOpen] = useState(false);
  const [lateOpen, setLateOpen] = useState(false);
  const [emergencyReason, setEmergencyReason] = useState("");
  const [acknowledgeBlockers, setAcknowledgeBlockers] = useState(false);
  const [documentsChecked, setDocumentsChecked] = useState(false);
  const [success, setSuccess] = useState<"closed" | "reopened" | "completed" | null>(null);
  const blockers = useMemo(() => closePreview(progress), [progress]);
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
      },
    );
  };

  return (
    <Card title={t("pages.inventory.close.title")} titleAs="h2">
      <div className="mk-inventory-close-panel">
        {success ? <Alert tone="ok">{t(`pages.inventory.close.success.${success}`)}</Alert> : null}
        {close.isError || reopen.isError || complete.isError ? (
          <Alert tone="error">{t("pages.inventory.close.actionError")}</Alert>
        ) : null}

        {status === "running" ? (
          <>
            <p className="mk-inventory-section-description">
              {t("pages.inventory.close.runningHint")}
            </p>
            <Button variant="secondary" onClick={() => setCloseOpen(true)}>
              {t("pages.inventory.close.open")}
            </Button>
          </>
        ) : null}

        {status === "closed" ? (
          <>
            <Alert tone="info">{t("pages.inventory.close.closedHint")}</Alert>
            <div className="mk-inventory-actions">
              <Button variant="secondary" onClick={() => setLateOpen(true)}>
                {t("pages.inventory.late.open")}
              </Button>
              <Button
                variant="warning-outline"
                loading={reopen.isPending}
                onClick={() =>
                  reopen.mutate(inventoryId, { onSuccess: () => setSuccess("reopened") })
                }
              >
                {t("pages.inventory.close.reopen")}
              </Button>
            </div>
            <Checkbox
              checked={documentsChecked}
              onCheckedChange={setDocumentsChecked}
              label={t("pages.inventory.close.documentsChecked")}
            />
            <Button
              disabled={!documentsChecked}
              loading={complete.isPending}
              onClick={() =>
                complete.mutate(inventoryId, { onSuccess: () => setSuccess("completed") })
              }
            >
              {t("pages.inventory.close.complete")}
            </Button>
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
              disabled={hasBlockers}
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
        {hasBlockers ? (
          <div className="mk-inventory-close-panel">
            <Alert tone="warn">{t("pages.inventory.close.blocked")}</Alert>
            <ul className="mk-inventory-close-blockers">
              {blockers.map((item) => (
                <li key={item.key}>
                  {t(`pages.inventory.close.blocker.${item.key}`, { count: item.count })}
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
        ) : (
          <Alert tone="ok">{t("pages.inventory.close.ready")}</Alert>
        )}
      </Modal>

      <InventoryLateEvents
        inventoryId={inventoryId}
        inventoryStatus={status === "running" ? "closed" : status}
        open={lateOpen}
        onClose={() => setLateOpen(false)}
      />
    </Card>
  );
}

function closePreview(progress: InventoryProgress): ClosePreviewItem[] {
  const active = progress.participants.filter(
    (participant) => participant.leftAt === null && participant.state === "active",
  ).length;
  const stale = progress.participants.filter(
    (participant) => participant.leftAt === null && participant.state === "stale",
  ).length;
  const participantOpenBoxes = progress.participants.reduce(
    (sum, participant) => sum + (participant.leftAt === null ? participant.openBoxCount : 0),
    0,
  );
  const invalidated = progress.boxes.filter((box) => box.state === "invalidated").length;
  const unresolvedPrint = progress.boxes.filter(
    (box) => box.state === "closed" && box.printState !== "printed",
  ).length;
  const discrepancies =
    progress.unknownCount +
    progress.ineligibleCount +
    progress.dateMismatchCount +
    progress.voidedCount;
  return [
    { key: "active", count: active },
    { key: "stale", count: stale },
    { key: "pending", count: progress.pendingEventCount },
    { key: "participantBoxes", count: participantOpenBoxes },
    { key: "openBoxes", count: progress.openBoxCount },
    { key: "invalidated", count: invalidated },
    { key: "unresolvedPrint", count: unresolvedPrint },
    { key: "discrepancies", count: discrepancies },
  ].filter((item) => item.count > 0);
}
