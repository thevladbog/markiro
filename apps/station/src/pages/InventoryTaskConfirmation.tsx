import { useTranslation } from "react-i18next";
import { Alert, Button, FullScreenDialog } from "@markiro/ui";

import type { ResolvedInventoryTask } from "../lib/floor-task.js";

export interface InventoryTaskConfirmationProps {
  resolved: ResolvedInventoryTask;
  currentLineName: string | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function InventoryTaskConfirmation({
  resolved,
  currentLineName,
  busy,
  onCancel,
  onConfirm,
}: InventoryTaskConfirmationProps) {
  const { t } = useTranslation();
  const { task } = resolved;
  return (
    <FullScreenDialog
      open
      title={t("inventory.confirmation.title")}
      backLabel={t("inventory.confirmation.cancel")}
      backDisabled={busy}
      backPlacement="footer"
      initialFocus="dialog"
      onClose={onCancel}
      className="inventory-confirmation"
      footer={
        <Button size="floor" disabled={busy} onClick={onConfirm}>
          {busy
            ? t("inventory.joining")
            : t("inventory.confirmation.join", { number: task.inventoryNumber })}
        </Button>
      }
    >
      <div className="inventory-confirmation__panel">
        <p className="inventory-confirmation__barcode">
          {t("inventory.confirmation.barcode", { number: task.inventoryNumber })}
        </p>
        <div
          className="inventory-confirmation__lines"
          aria-label={t("inventory.confirmation.lines")}
        >
          <section>
            <span>{t("inventory.confirmation.currentLine")}</span>
            <strong>{currentLineName ?? t("inventory.confirmation.unknownLine")}</strong>
          </section>
          <span className="inventory-confirmation__arrow" aria-hidden="true">
            →
          </span>
          <section className="inventory-confirmation__target-line">
            <span>{t("inventory.confirmation.assignedLine")}</span>
            <strong>{task.lineName}</strong>
            <small>{task.inventoryNumber}</small>
          </section>
        </div>
        <section className="inventory-confirmation__task">
          <strong>{task.productPrintName ?? task.productName}</strong>
          <span>{t(task.mode === "repack" ? "inventory.modeRepack" : "inventory.modeCheck")}</span>
        </section>
        <Alert tone="warn">{t("inventory.confirmation.warning")}</Alert>
      </div>
    </FullScreenDialog>
  );
}
