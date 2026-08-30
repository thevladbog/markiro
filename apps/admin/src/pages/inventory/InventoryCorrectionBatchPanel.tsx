import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, Input, Modal, Textarea } from "@markiro/ui";

export interface InventoryCorrectionBatchPanelProps {
  action: "void_scan" | "change_date";
  selectedEventCount: number;
  affectedCodeCount: number;
  pending: boolean;
  errorCode: string | null;
  onCancel: () => void;
  onConfirm: (input: { reason: string; observedProductionDate?: string }) => void;
}

export function formatCorrectionCount(value: number, locale: string): string {
  return new Intl.NumberFormat(locale).format(value).replace(/[\u00a0\u202f]/g, " ");
}

export function InventoryCorrectionBatchPanel({
  action,
  selectedEventCount,
  affectedCodeCount,
  pending,
  errorCode,
  onCancel,
  onConfirm,
}: InventoryCorrectionBatchPanelProps) {
  const { t, i18n } = useTranslation();
  const [reason, setReason] = useState("");
  const [observedProductionDate, setObservedProductionDate] = useState("");
  const trimmedReason = reason.trim();
  const reasonBytes = new TextEncoder().encode(trimmedReason).byteLength;
  const valid =
    reasonBytes > 0 &&
    reasonBytes <= 1024 &&
    (action !== "change_date" || observedProductionDate.length > 0);

  return (
    <Modal
      open
      width={560}
      title={t(`pages.inventory.corrections.batch.title.${action}`)}
      closeLabel={t("common.close")}
      {...(pending ? {} : { onClose: onCancel })}
      footer={
        <>
          <Button variant="secondary" disabled={pending} onClick={onCancel}>
            {t("common.cancel")}
          </Button>
          <Button
            variant={action === "void_scan" ? "destructive" : "primary"}
            disabled={!valid}
            loading={pending}
            onClick={() =>
              onConfirm({
                reason: trimmedReason,
                ...(action === "change_date" ? { observedProductionDate } : {}),
              })
            }
          >
            {t(`pages.inventory.corrections.batch.confirm.${action}`)}
          </Button>
        </>
      }
    >
      <div className="mk-inventory-correction-batch-panel">
        <p>
          {t("pages.inventory.corrections.batch.summary", {
            events: formatCorrectionCount(selectedEventCount, i18n.language),
            codes: formatCorrectionCount(affectedCodeCount, i18n.language),
          })}
        </p>
        <p className="mk-inventory-section-description">
          {t("pages.inventory.corrections.batch.auditHint")}
        </p>
        <Textarea
          label={t("pages.inventory.corrections.reason")}
          value={reason}
          required
          onChange={(event) => setReason(event.currentTarget.value)}
        />
        {reasonBytes > 1024 ? (
          <Alert tone="error">{t("pages.inventory.corrections.reasonTooLong")}</Alert>
        ) : null}
        {action === "change_date" ? (
          <Input
            type="date"
            label={t("pages.inventory.corrections.observedDate")}
            value={observedProductionDate}
            required
            onChange={(event) => setObservedProductionDate(event.currentTarget.value)}
          />
        ) : null}
        {errorCode ? (
          <Alert tone="error">
            {errorCode === "NETWORK"
              ? t("pages.inventory.corrections.batch.networkError")
              : t("pages.inventory.corrections.batch.saveError")}
          </Alert>
        ) : null}
      </div>
    </Modal>
  );
}
