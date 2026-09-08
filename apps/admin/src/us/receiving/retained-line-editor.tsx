import { Button, Input, Select, Textarea } from "@markiro/ui";
import { UOM_CODES_V1 } from "@markiro/domain";
import type { ReceivingDraftItem } from "@markiro/platform-contracts";
import { useTranslation } from "react-i18next";
import { ReceivingFrozenIdentity, type FrozenReceivingLine } from "./amendment-comparison.js";

/** A retained line exposes only documentary/material facts that cannot replace lot identity. */
export function ReceivingRetainedLineEditor({
  value,
  original,
  number,
  disabled,
  onChange,
  onRemove,
}: {
  value: ReceivingDraftItem;
  original: FrozenReceivingLine;
  number: number;
  disabled: boolean;
  onChange: (value: ReceivingDraftItem) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const patch = (next: Partial<ReceivingDraftItem>) => onChange({ ...value, ...next });
  return (
    <fieldset className="us-rec-line-editor" disabled={disabled}>
      <legend>{t("receiving.line", { number })}</legend>
      <p className="us-rec-hint">{t("receiving.retainedIdentityHint")}</p>
      <ReceivingFrozenIdentity item={original} />
      {value.exemptReceipt?.tlcHandling === "assign_if_missing" ? (
        <dl className="us-rec-identity">
          <dt>{t("receiving.receivedTlc")}</dt>
          <dd>{value.tlc ?? t("receiving.absent")}</dd>
          <dt>{t("receiving.proposedTlc")}</dt>
          <dd>{value.exemptReceipt.proposedTlc}</dd>
        </dl>
      ) : null}
      <div className="us-rec-quantity">
        <Input
          label={t("receiving.quantity")}
          value={value.quantity ?? ""}
          inputMode="decimal"
          maxLength={30}
          onChange={(event) => patch({ quantity: event.target.value || null })}
        />
        <Select
          native
          label={t("receiving.unit")}
          value={value.unitOfMeasure ?? ""}
          options={[
            { value: "", label: t("receiving.choose") },
            ...UOM_CODES_V1.map((unit) => ({ value: unit, label: unit })),
          ]}
          onValueChange={(unit) =>
            patch({ unitOfMeasure: UOM_CODES_V1.find((item) => item === unit) ?? null })
          }
        />
      </div>
      <Input
        label={t("receiving.supplierLot")}
        value={value.supplierLotReference ?? ""}
        maxLength={128}
        onChange={(event) => patch({ supplierLotReference: event.target.value || null })}
      />
      {value.exemptSupplier ? (
        <>
          <Textarea
            label={t("receiving.exemptReason")}
            value={value.exemptReason ?? ""}
            maxLength={2000}
            onChange={(event) => patch({ exemptReason: event.target.value || null })}
          />
          <Input
            type="url"
            label={t("receiving.evidenceUrl")}
            value={value.exemptReceipt?.evidenceUrl ?? ""}
            maxLength={1024}
            onChange={(event) =>
              patch({
                exemptReceipt: {
                  tlcHandling: value.exemptReceipt?.tlcHandling ?? null,
                  proposedTlc: value.exemptReceipt?.proposedTlc ?? null,
                  evidenceUrl: event.target.value || null,
                },
              })
            }
          />
          <p className="us-rec-hint">{t("receiving.freshExemptionReview")}</p>
        </>
      ) : null}
      <Textarea
        label={t("receiving.lineNotes")}
        value={value.notes ?? ""}
        maxLength={2000}
        onChange={(event) => patch({ notes: event.target.value || null })}
      />
      <Button type="button" variant="secondary" disabled={disabled} onClick={onRemove}>
        {t("receiving.removeLine")}
      </Button>
    </fieldset>
  );
}
