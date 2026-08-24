import { Fragment } from "react";
import { Button, Input, Select, Textarea } from "@markiro/ui";
import { useTranslation } from "react-i18next";

import {
  getSupportedActivationPolicies,
  type DocumentDraft,
  type DocumentKind,
  type DocumentLineDraft,
} from "./documentDraft.js";

const VAT_OPTIONS = [
  { value: "included", labelKey: "documents.vatIncluded" },
  { value: "excluded", labelKey: "documents.vatExcluded" },
] as const;

function policyLabelKey(policy: NonNullable<DocumentLineDraft["activationPolicy"]>) {
  return `documents.policies.${policy}`;
}

export function DocumentLinesTable({
  kind,
  draft,
  errors,
  onQuantityChange,
  onPriceChange,
  onPriceBlur,
  onDescriptionChange,
  onPriceOverrideReasonChange,
  onVatIncludedChange,
  onPolicyChange,
  onMove,
  onRemove,
}: {
  kind: DocumentKind;
  draft: DocumentDraft;
  errors: Record<string, string>;
  onQuantityChange: (line: DocumentLineDraft, quantity: number) => void;
  onPriceChange: (line: DocumentLineDraft, price: string) => void;
  onPriceBlur: (line: DocumentLineDraft, price: string) => void;
  onDescriptionChange: (line: DocumentLineDraft, description: string) => void;
  onPriceOverrideReasonChange: (line: DocumentLineDraft, reason: string) => void;
  onVatIncludedChange: (line: DocumentLineDraft, included: boolean) => void;
  onPolicyChange: (
    line: DocumentLineDraft,
    policy: NonNullable<DocumentLineDraft["activationPolicy"]>,
  ) => void;
  onMove: (line: DocumentLineDraft, direction: -1 | 1) => void;
  onRemove: (line: DocumentLineDraft) => void;
}) {
  const { t } = useTranslation();

  return (
    <div
      className="document-lines-table"
      role="region"
      aria-labelledby="document-lines-title"
      tabIndex={0}
    >
      <table>
        <thead>
          <tr>
            <th scope="col">{t("documents.columns.position")}</th>
            <th scope="col">{t("documents.columns.quantity")}</th>
            <th scope="col">{t("documents.columns.price")}</th>
            <th scope="col">{t("documents.columns.vat")}</th>
            <th scope="col">{t("documents.columns.policy")}</th>
            <th scope="col">
              <span className="sr-only">{t("documents.columns.actions")}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {draft.lines.map((line, index) => {
            const prefix = `lines.${line.id}`;
            const policies = getSupportedActivationPolicies(kind, line.kind);
            return (
              <Fragment key={line.id}>
                <tr className="document-lines-table__row">
                  <th scope="row">
                    <strong>{line.nameRu}</strong>
                    <span>
                      {line.catalogItemCode} · v{line.version} · {line.unit}
                    </span>
                  </th>
                  <td>
                    <Input
                      aria-label={t("documents.quantityFor", { name: line.nameRu })}
                      value={String(line.quantity)}
                      inputMode="numeric"
                      {...(errors[`${prefix}.quantity`]
                        ? { error: t(`documents.errors.${errors[`${prefix}.quantity`]}`) }
                        : {})}
                      onChange={(event) => onQuantityChange(line, Number(event.target.value))}
                    />
                  </td>
                  <td>
                    <Input
                      aria-label={t("documents.priceFor", { name: line.nameRu })}
                      value={line.agreedUnitPrice}
                      inputMode="decimal"
                      mono
                      {...(errors[`${prefix}.agreedUnitPrice`]
                        ? { error: t(`documents.errors.${errors[`${prefix}.agreedUnitPrice`]}`) }
                        : {})}
                      onChange={(event) => onPriceChange(line, event.target.value)}
                      onBlur={(event) => onPriceBlur(line, event.target.value)}
                    />
                    {kind === "offer" ? (
                      <Input
                        label={t("documents.priceOverrideReasonFor", { name: line.nameRu })}
                        value={line.priceOverrideReason ?? ""}
                        onChange={(event) => onPriceOverrideReasonChange(line, event.target.value)}
                      />
                    ) : null}
                  </td>
                  <td>
                    {line.vatRateBps === null ? (
                      <span className="document-lines-table__muted">{t("documents.noVat")}</span>
                    ) : (
                      <Select<"included" | "excluded">
                        aria-label={t("documents.vatFor", { name: line.nameRu })}
                        options={VAT_OPTIONS.map((option) => ({
                          value: option.value,
                          label: t(option.labelKey),
                        }))}
                        value={line.vatIncluded ? "included" : "excluded"}
                        onValueChange={(value) => onVatIncludedChange(line, value === "included")}
                      />
                    )}
                  </td>
                  <td>
                    {policies.length === 0 ? (
                      <span className="document-lines-table__muted">{t("documents.noPolicy")}</span>
                    ) : (
                      <Select<NonNullable<DocumentLineDraft["activationPolicy"]>>
                        aria-label={t("documents.policyFor", { name: line.nameRu })}
                        options={policies.map((policy) => ({
                          value: policy,
                          label: t(policyLabelKey(policy)),
                        }))}
                        {...(line.activationPolicy ? { value: line.activationPolicy } : {})}
                        {...(errors[`${prefix}.activationPolicy`]
                          ? {
                              error: t(`documents.errors.${errors[`${prefix}.activationPolicy`]}`),
                            }
                          : {})}
                        onValueChange={(policy) => onPolicyChange(line, policy)}
                      />
                    )}
                  </td>
                  <td>
                    <div className="document-line-actions">
                      <Button
                        type="button"
                        variant="secondary"
                        className="document-line__action"
                        aria-label={t("documents.moveUp", { name: line.nameRu })}
                        disabled={index === 0}
                        onClick={() => onMove(line, -1)}
                      >
                        ↑
                      </Button>
                      <Button
                        type="button"
                        variant="secondary"
                        className="document-line__action"
                        aria-label={t("documents.moveDown", { name: line.nameRu })}
                        disabled={index === draft.lines.length - 1}
                        onClick={() => onMove(line, 1)}
                      >
                        ↓
                      </Button>
                      <Button
                        type="button"
                        variant="destructive"
                        className="document-line__action"
                        aria-label={t("documents.remove", { name: line.nameRu })}
                        onClick={() => onRemove(line)}
                      >
                        ×
                      </Button>
                    </div>
                  </td>
                </tr>
                <tr className="document-lines-table__comment-row">
                  <td colSpan={6}>
                    <Textarea
                      label={t("documents.commentFor", { name: line.nameRu })}
                      value={line.descriptionRu ?? ""}
                      rows={2}
                      maxLength={10_000}
                      onChange={(event) => onDescriptionChange(line, event.target.value)}
                    />
                  </td>
                </tr>
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
