import { Button, Input, RadioGroup, Textarea } from "@markiro/ui";
import type { ReceivingDraftItem } from "@markiro/platform-contracts";
import { useTranslation } from "react-i18next";

type ExemptReceipt = NonNullable<ReceivingDraftItem["exemptReceipt"]>;

const emptyReceipt: ExemptReceipt = {
  evidenceUrl: null,
  tlcHandling: null,
  proposedTlc: null,
};

export function ReceivingExemptionFields({
  value,
  receivingLocationId,
  receivingLocationLabel,
  disabled,
  onChange,
}: {
  value: ReceivingDraftItem;
  receivingLocationId: string | null;
  receivingLocationLabel: string;
  disabled: boolean;
  onChange: (value: ReceivingDraftItem) => void;
}) {
  const { t } = useTranslation();
  const receipt = value.exemptReceipt ?? emptyReceipt;
  const patchReceipt = (change: Partial<ExemptReceipt>) =>
    onChange({ ...value, exemptReceipt: { ...receipt, ...change } });
  const assign = receipt.tlcHandling === "assign_if_missing";
  const sourceMatches =
    receivingLocationId !== null &&
    value.source?.kind === "location" &&
    value.source.locationId === receivingLocationId;
  const sourceConflicts = assign && value.source !== null && !sourceMatches;

  return (
    <div className="us-rec-exemption-fields">
      <div className="us-rec-fields">
        <Textarea
          label={t("receiving.exemptReason")}
          value={value.exemptReason ?? ""}
          maxLength={2000}
          disabled={disabled}
          onChange={(event) => onChange({ ...value, exemptReason: event.target.value || null })}
        />
        <Input
          label={t("receiving.supplierLot")}
          value={value.supplierLotReference ?? ""}
          maxLength={128}
          disabled={disabled}
          onChange={(event) =>
            onChange({ ...value, supplierLotReference: event.target.value || null })
          }
        />
        <Input
          type="url"
          label={t("receiving.evidenceUrl")}
          value={receipt.evidenceUrl ?? ""}
          maxLength={1024}
          disabled={disabled}
          onChange={(event) => patchReceipt({ evidenceUrl: event.target.value || null })}
        />
        <RadioGroup
          label={t("receiving.tlcHandling")}
          value={receipt.tlcHandling ?? ""}
          disabled={disabled}
          options={[
            { value: "preserve_existing", label: t("receiving.preserveExisting") },
            { value: "assign_if_missing", label: t("receiving.assignIfMissing") },
          ]}
          onValueChange={(handling) => {
            if (handling !== "preserve_existing" && handling !== "assign_if_missing") return;
            const next: ReceivingDraftItem = {
              ...value,
              exemptReceipt: { ...receipt, tlcHandling: handling },
            };
            if (
              handling === "assign_if_missing" &&
              receivingLocationId !== null &&
              (value.source === null || sourceMatches)
            )
              next.source = { kind: "location", locationId: receivingLocationId };
            onChange(next);
          }}
        />
      </div>
      {assign ? (
        <div className="us-rec-own-assignment">
          <Input
            label={t("receiving.proposedTlc")}
            value={receipt.proposedTlc ?? ""}
            disabled={disabled}
            onChange={(event) => patchReceipt({ proposedTlc: event.target.value || null })}
          />
          <div className="us-rec-source-summary">
            <span>{t("receiving.ownSource")}</span>
            <strong>
              {receivingLocationLabel || receivingLocationId || t("receiving.absent")}
            </strong>
          </div>
          {sourceConflicts ? (
            <div className="us-md-notice us-md-notice--alert" role="alert">
              <p>{t("receiving.ownSourceMismatch")}</p>
              {receivingLocationId ? (
                <Button
                  type="button"
                  variant="secondary"
                  disabled={disabled}
                  onClick={() =>
                    onChange({
                      ...value,
                      source: { kind: "location", locationId: receivingLocationId },
                    })
                  }
                >
                  {t("receiving.useReceivingSource")}
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
