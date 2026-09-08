import { Button, Checkbox, Input, Select, Textarea } from "@markiro/ui";
import { UOM_CODES_V1 } from "@markiro/domain";
import type { ReceivingDraftItem } from "@markiro/platform-contracts";
import { useTranslation } from "react-i18next";
import type { UsBrowserClient } from "../client.js";
import { ReceivingReferencePicker } from "./reference-picker.js";
import { ReceivingExemptionFields } from "./exemption-fields.js";

export const emptyReceivingLine: ReceivingDraftItem = {
  productId: null,
  lotLinkMode: "create_on_finalize",
  lotId: null,
  tlc: null,
  source: null,
  exemptSupplier: false,
  exemptReason: null,
  exemptReceipt: null,
  supplierLotReference: null,
  quantity: null,
  unitOfMeasure: null,
  notes: null,
};
export function ReceivingLineEditor({
  value,
  number,
  disabled,
  receivingLocationId,
  receivingLocationLabel,
  client,
  onChange,
  onRemove,
  onSessionLost,
  onForbidden,
}: {
  value: ReceivingDraftItem;
  number: number;
  disabled: boolean;
  receivingLocationId: string | null;
  receivingLocationLabel: string;
  client: UsBrowserClient;
  onChange: (value: ReceivingDraftItem) => void;
  onRemove: () => void;
  onSessionLost: () => void;
  onForbidden: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const picker = { client, disabled, onSessionLost, onForbidden };
  const patch = (change: Partial<ReceivingDraftItem>) => onChange({ ...value, ...change });
  const text = (key: "tlc" | "quantity" | "notes", input: string) =>
    patch({ [key]: input || null });
  const source = value.source;
  return (
    <fieldset className="us-rec-line-editor" disabled={disabled}>
      <legend>{t("receiving.line", { number })}</legend>
      <div className="us-rec-fields">
        <ReceivingReferencePicker
          {...picker}
          kind="product"
          label={t("receiving.product")}
          value={value.productId ?? ""}
          onChange={(id) => patch({ productId: id || null })}
        />
        <div className="us-rec-stack">
          <Select
            native
            label={t("receiving.linkMode")}
            value={value.lotLinkMode}
            onValueChange={(mode) => {
              if (mode === "create_on_finalize" || mode === "link_existing")
                patch({ lotLinkMode: mode });
            }}
            options={[
              { value: "create_on_finalize", label: t("receiving.createOnFinalize") },
              { value: "link_existing", label: t("receiving.linkExisting") },
            ]}
          />
          {value.lotLinkMode === "link_existing" ? (
            <ReceivingReferencePicker
              {...picker}
              kind="lot"
              label={t("receiving.lot")}
              value={value.lotId ?? ""}
              {...(value.productId ? { productId: value.productId } : {})}
              onChange={(id) => patch({ lotId: id || null })}
            />
          ) : null}
          <Input
            label={t("receiving.tlc")}
            value={value.tlc ?? ""}
            onChange={(e) => text("tlc", e.target.value)}
          />
          <div className="us-rec-quantity">
            <Input
              label={t("receiving.quantity")}
              inputMode="decimal"
              value={value.quantity ?? ""}
              maxLength={30}
              onChange={(e) => text("quantity", e.target.value)}
            />
            <Select
              native
              label={t("receiving.unit")}
              value={value.unitOfMeasure ?? ""}
              onValueChange={(unit) => {
                patch({ unitOfMeasure: UOM_CODES_V1.find((entry) => entry === unit) ?? null });
              }}
              options={[
                { value: "", label: t("receiving.choose") },
                ...UOM_CODES_V1.map((unit) => ({ value: unit, label: unit })),
              ]}
            />
          </div>
        </div>
      </div>
      <Select
        native
        label={t("receiving.sourceKind")}
        value={source?.kind ?? "absent"}
        options={[
          { value: "absent", label: t("receiving.absent") },
          { value: "location", label: t("receiving.locationKind") },
          { value: "reference", label: t("receiving.referenceKind") },
        ]}
        onValueChange={(kind) => {
          if (kind === (source?.kind ?? "absent")) return;
          const hasSourceValue =
            source?.kind === "location"
              ? Boolean(source.locationId)
              : Boolean(source?.referenceValue || source?.resolvedLocationId);
          if (hasSourceValue && !window.confirm(t("receiving.replaceSourceConfirm"))) return;
          patch({
            source:
              kind === "location"
                ? { kind, locationId: "" }
                : kind === "reference"
                  ? { kind, referenceKind: "web_url", referenceValue: "", resolvedLocationId: "" }
                  : null,
          });
        }}
      />
      {source?.kind === "location" ? (
        <ReceivingReferencePicker
          {...picker}
          kind="location"
          label={t("receiving.sourceLocation")}
          value={source.locationId}
          onChange={(id) => patch({ source: { ...source, locationId: id } })}
        />
      ) : source?.kind === "reference" ? (
        <div className="us-rec-fields">
          <Input
            label={t("receiving.sourceReference")}
            value={source.referenceValue}
            maxLength={1024}
            onChange={(e) => patch({ source: { ...source, referenceValue: e.target.value } })}
          />
          <ReceivingReferencePicker
            {...picker}
            kind="location"
            label={t("receiving.resolvedLocation")}
            value={source.resolvedLocationId}
            onChange={(id) => patch({ source: { ...source, resolvedLocationId: id } })}
          />
        </div>
      ) : null}
      <Checkbox
        label={t("receiving.exempt")}
        checked={value.exemptSupplier}
        onCheckedChange={(checked) => patch({ exemptSupplier: checked })}
      />
      {value.exemptSupplier ? (
        <ReceivingExemptionFields
          value={value}
          receivingLocationId={receivingLocationId}
          receivingLocationLabel={receivingLocationLabel}
          disabled={disabled}
          onChange={onChange}
        />
      ) : null}
      <p className="us-rec-hint">{t("receiving.identityHint")}</p>
      <Textarea
        label={t("receiving.lineNotes")}
        value={value.notes ?? ""}
        maxLength={2000}
        onChange={(e) => text("notes", e.target.value)}
      />
      <Button type="button" variant="secondary" disabled={disabled} onClick={onRemove}>
        {t("receiving.removeLine")}
      </Button>
    </fieldset>
  );
}
