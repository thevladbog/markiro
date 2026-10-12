import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button, FullScreenDialog, Input, Select } from "@markiro/ui";
import {
  resolveWarehouseReprintScan,
  warehouseReasonSchema,
  type PalletDeliveryDiagnostic,
} from "@markiro/domain";
import type { WarehouseSession } from "../../lib/warehouse-reprint/types.js";
type WarehouseReason = WarehouseSession["reason"];
import type { ScanSource } from "../../lib/scan-source.js";
export function PalletDeliveryRecovery({
  diagnostic,
  outcome,
  source,
  busy,
  onClose,
  onResolve,
  error,
}: {
  diagnostic: PalletDeliveryDiagnostic;
  outcome: "confirmed" | "skipped";
  source: ScanSource;
  busy: boolean;
  onClose: () => void;
  onResolve: (raw: string, reason: WarehouseReason) => void;
  error?: string | null;
}) {
  const { t } = useTranslation(),
    [raw, setRaw] = useState(""),
    [reason, setReason] = useState<WarehouseReason>("not_printed");
  const scan = resolveWarehouseReprintScan(raw),
    valid =
      outcome === "skipped" ||
      (scan.kind === "box" && scan.repair === null && scan.sscc === diagnostic.sscc);
  useEffect(() => {
    if (busy || outcome !== "confirmed") return;
    source.clearPendingInput?.();
    return source.start((value) => setRaw(value));
  }, [busy, outcome, source]);
  return (
    <FullScreenDialog
      open
      title={t(
        outcome === "confirmed"
          ? "warehouse.pallet.resolveConfirm"
          : "warehouse.pallet.resolveSkip",
      )}
      onClose={onClose}
      backDisabled={busy}
      backLabel={t("warehouse.cancel")}
      footer={
        <Button size="floor" disabled={busy || !valid} onClick={() => onResolve(raw, reason)}>
          {t(
            outcome === "confirmed"
              ? "warehouse.pallet.resolveConfirm"
              : "warehouse.pallet.resolveSkip",
          )}
        </Button>
      }
    >
      <div className="warehouse-confirm-body">
        {error ? (
          <Alert tone="error">
            {t("warehouse.errors." + error, {
              defaultValue: t("warehouse.errors.WAREHOUSE_OPERATION_FAILED"),
            })}
          </Alert>
        ) : null}
        <Alert tone="warn">
          {t(
            outcome === "confirmed"
              ? "warehouse.pallet.originalConfirmHint"
              : "warehouse.pallet.originalSkipHint",
          )}
        </Alert>
        <p>
          SSCC: <strong>{diagnostic.sscc}</strong>
        </p>
        {outcome === "confirmed" ? (
          <Input
            size="floor"
            mono
            label={t("warehouse.pallet.verifyHint")}
            value={raw}
            maxLength={2048}
            onChange={(event) => setRaw(event.currentTarget.value)}
            disabled={busy}
          />
        ) : null}
        <Select
          label={t("warehouse.reason")}
          value={reason}
          disabled={busy}
          options={(["not_printed", "damaged", "lost"] as const).map((value) => ({
            value,
            label: t("warehouse.reasons." + value),
          }))}
          onValueChange={(value) => setReason(warehouseReasonSchema.parse(value))}
        />
      </div>
    </FullScreenDialog>
  );
}
