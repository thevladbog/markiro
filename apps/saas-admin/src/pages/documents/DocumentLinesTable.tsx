import { useTranslation } from "react-i18next";

import { Select } from "@markiro/ui";

import type { CatalogVersionDto } from "../catalog/api.js";
import { calculateDocumentTotals } from "./documentDraft.js";
import type { DocumentDraftAction, DocumentKind, DocumentLineDraft } from "./types.js";
import { CatalogPositionPicker } from "./CatalogPositionPicker.js";

function percent(value: number) {
  return (value / 100).toFixed(value % 100 === 0 ? 0 : 2);
}

function lineTotal(kind: DocumentKind, line: DocumentLineDraft, english: boolean) {
  try {
    const value = calculateDocumentTotals(kind, [line]).total;
    return english ? `${value} RUB` : `${value.replace(".", ",")} ₽`;
  } catch {
    return "—";
  }
}

export interface DocumentLinesTableProps {
  kind: DocumentKind;
  lines: readonly DocumentLineDraft[];
  catalog: readonly CatalogVersionDto[];
  loadingSources: boolean;
  submitting: boolean;
  errors: Readonly<Record<string, string>>;
  dispatch: (action: DocumentDraftAction) => void;
  onAdd: (version: CatalogVersionDto, separate?: boolean) => void;
}

export function DocumentLinesTable({
  kind,
  lines,
  catalog,
  loadingSources,
  submitting,
  errors,
  dispatch,
  onAdd,
}: DocumentLinesTableProps) {
  const { t, i18n } = useTranslation();
  const picker = (
    <CatalogPositionPicker
      catalog={catalog}
      loading={loadingSources}
      disabled={submitting || lines.length >= 100}
      onAdd={(version) => onAdd(version)}
    />
  );

  return (
    <div
      className="document-lines-region"
      role="region"
      aria-label={t("documents.linesRegion")}
      tabIndex={0}
    >
      {lines.length > 0 ? <div className="document-lines__toolbar">{picker}</div> : null}
      <div className="document-lines__scroll">
        <table aria-label={t("documents.linesRegion")}>
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">{t("documents.columns.position")}</th>
              <th scope="col">{t("documents.columns.quantity")}</th>
              <th scope="col">{t("documents.columns.price")}</th>
              <th scope="col">{t("documents.columns.vat")}</th>
              <th scope="col">{t("documents.columns.policy")}</th>
              <th scope="col">{t("documents.columns.total")}</th>
              <th scope="col">{t("documents.columns.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {lines.length === 0 ? (
              <tr className="document-lines__empty-row">
                <td colSpan={8}>
                  <div className="document-lines__onboarding">
                    <div>
                      <strong>{t("documents.empty.title")}</strong>
                      <span>{t("documents.empty.body")}</span>
                    </div>
                    {picker}
                  </div>
                </td>
              </tr>
            ) : (
              lines.map((line, index) => {
                const quantityError = errors[`lines.${line.id}.quantity`];
                const priceError = errors[`lines.${line.id}.agreedUnitPrice`];
                const policyError = errors[`lines.${line.id}.activationPolicy`];
                const catalogError = errors[`lines.${line.id}.catalogVersionId`];
                return (
                  <tr key={line.id} className="document-line">
                    <td className="document-line__index">{index + 1}</td>
                    <td className="document-line__identity">
                      <span className="document-line__kind">
                        {t(`documents.kinds.${line.kind}`)}
                      </span>
                      <span className="document-line__name">{line.nameRu}</span>
                      <span className="document-line__meta">
                        {line.catalogItemCode} · v{line.version} · {line.unit}
                      </span>
                      {catalogError ? (
                        <span className="document-field-error">{catalogError}</span>
                      ) : null}
                      <button
                        type="button"
                        className="document-line__separate"
                        disabled={submitting || lines.length >= 100}
                        aria-label={t("documents.actions.separateNamed", { name: line.nameRu })}
                        onClick={() => {
                          const version = catalog.find((item) => item.id === line.catalogVersionId);
                          if (version) onAdd(version, true);
                        }}
                      >
                        {t("documents.actions.separate")}
                      </button>
                    </td>
                    <td>
                      <label className="document-line__field">
                        <span className="document-line__mobile-label">
                          {t("documents.columns.quantity")}
                        </span>
                        <input
                          type="number"
                          min={1}
                          step={1}
                          value={line.quantity}
                          disabled={submitting}
                          aria-label={t("documents.fields.quantityNamed", { name: line.nameRu })}
                          aria-invalid={quantityError ? true : undefined}
                          onChange={(event) =>
                            dispatch({
                              type: "line.quantityChanged",
                              id: line.id,
                              quantity: event.currentTarget.valueAsNumber || 0,
                            })
                          }
                        />
                        {quantityError ? (
                          <span className="document-field-error">{quantityError}</span>
                        ) : null}
                      </label>
                    </td>
                    <td>
                      <label className="document-line__field">
                        <span className="document-line__mobile-label">
                          {t("documents.columns.price")}
                        </span>
                        <input
                          type="text"
                          inputMode="decimal"
                          value={line.agreedUnitPrice}
                          disabled={submitting}
                          aria-label={t("documents.fields.priceNamed", { name: line.nameRu })}
                          aria-invalid={priceError ? true : undefined}
                          onChange={(event) =>
                            dispatch({
                              type: "line.priceChanged",
                              id: line.id,
                              price: event.currentTarget.value,
                            })
                          }
                        />
                        {priceError ? (
                          <span className="document-field-error">{priceError}</span>
                        ) : null}
                      </label>
                    </td>
                    <td>
                      {line.vatRateBps === null ? (
                        <span className="document-line__fixed-value">
                          {t("documents.vat.none")}
                        </span>
                      ) : (
                        <Select
                          aria-label={t("documents.fields.vatNamed", { name: line.nameRu })}
                          value={line.vatIncluded ? "included" : "excluded"}
                          options={[
                            {
                              value: "included",
                              label: t("documents.vat.included", {
                                rate: percent(line.vatRateBps),
                              }),
                            },
                            {
                              value: "excluded",
                              label: t("documents.vat.excluded", {
                                rate: percent(line.vatRateBps),
                              }),
                            },
                          ]}
                          disabled={submitting}
                          onValueChange={(value) =>
                            dispatch({
                              type: "line.vatIncludedChanged",
                              id: line.id,
                              included: value === "included",
                            })
                          }
                        />
                      )}
                    </td>
                    <td>
                      {line.kind === "service" ? (
                        <span className="document-line__fixed-value">
                          {t("documents.policy.none")}
                        </span>
                      ) : kind === "offer" && line.kind === "addon" ? (
                        <span className="document-line__fixed-value">
                          {t("documents.policy.immediateAfterPayment")}
                        </span>
                      ) : (
                        <Select
                          aria-label={t("documents.fields.policyNamed", { name: line.nameRu })}
                          {...(line.activationPolicy === null
                            ? {}
                            : { value: line.activationPolicy })}
                          options={[
                            { value: "immediate", label: t("documents.policy.immediate") },
                            {
                              value: "after_current",
                              label: t("documents.policy.afterCurrent"),
                            },
                            ...(kind === "invoice"
                              ? [
                                  {
                                    value: "manual" as const,
                                    label: t("documents.policy.manual"),
                                  },
                                ]
                              : []),
                          ]}
                          disabled={submitting}
                          {...(policyError ? { error: policyError } : {})}
                          onValueChange={(policy) =>
                            dispatch({ type: "line.policyChanged", id: line.id, policy })
                          }
                        />
                      )}
                    </td>
                    <td className="document-line__total">
                      {lineTotal(kind, line, i18n.language.startsWith("en"))}
                    </td>
                    <td>
                      <div className="document-line__actions">
                        <button
                          type="button"
                          disabled={submitting || index === 0}
                          aria-label={t("documents.actions.moveUpNamed", { name: line.nameRu })}
                          onClick={() =>
                            dispatch({ type: "line.moved", id: line.id, direction: -1 })
                          }
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          disabled={submitting || index === lines.length - 1}
                          aria-label={t("documents.actions.moveDownNamed", { name: line.nameRu })}
                          onClick={() =>
                            dispatch({ type: "line.moved", id: line.id, direction: 1 })
                          }
                        >
                          ↓
                        </button>
                        <button
                          type="button"
                          className="document-line__remove"
                          disabled={submitting}
                          aria-label={t("documents.actions.removeNamed", { name: line.nameRu })}
                          onClick={() => dispatch({ type: "line.removed", id: line.id })}
                        >
                          ×
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
