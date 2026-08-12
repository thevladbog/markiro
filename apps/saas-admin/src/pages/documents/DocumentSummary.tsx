import { useTranslation } from "react-i18next";

import { Alert, Button } from "@markiro/ui";

import type { DocumentKind } from "./documentDraft.js";

export interface DocumentTotalsView {
  subtotal: string;
  vatTotal: string;
  total: string;
}

function formatRub(value: string, language: string): string {
  return language.startsWith("en") ? `${value} RUB` : `${value.replace(".", ",")} ₽`;
}

export interface DocumentSummaryProps {
  kind: DocumentKind;
  lineCount: number;
  totals: DocumentTotalsView;
  errors: readonly string[];
  submitError?: string;
  submitting: boolean;
  onCancel: () => void;
}

export function DocumentSummary({
  kind,
  lineCount,
  totals,
  errors,
  submitError,
  submitting,
  onCancel,
}: DocumentSummaryProps) {
  const { t, i18n } = useTranslation();
  return (
    <aside className="document-summary" aria-labelledby="document-summary-title">
      <div className="document-summary__sticky">
        <span className="document-summary__coordinate" aria-hidden="true">
          DOCUMENT / TOTALS
        </span>
        <h2 id="document-summary-title">{t("documents.summary.title")}</h2>
        <dl className="document-summary__totals" aria-live="polite">
          <div>
            <dt>{t("documents.summary.lines")}</dt>
            <dd>{lineCount}</dd>
          </div>
          <div>
            <dt>{t("documents.summary.subtotal")}</dt>
            <dd>{formatRub(totals.subtotal, i18n.language)}</dd>
          </div>
          <div>
            <dt>{t("documents.summary.vat")}</dt>
            <dd>{formatRub(totals.vatTotal, i18n.language)}</dd>
          </div>
          <div className="document-summary__grand-total">
            <dt>{t("documents.summary.total")}</dt>
            <dd>{formatRub(totals.total, i18n.language)}</dd>
          </div>
        </dl>
        {submitError ? <Alert tone="error">{submitError}</Alert> : null}
        {errors.length > 0 ? (
          <Alert tone="warn">
            <strong>{t("documents.summary.blocking")}</strong>
            <ul className="document-summary__errors">
              {errors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          </Alert>
        ) : null}
        <div className="document-summary__actions">
          <Button type="submit" fullWidth loading={submitting} disabled={errors.length > 0}>
            {t(`documents.submit.${kind}`)}
          </Button>
          <Button
            type="button"
            variant="secondary"
            fullWidth
            disabled={submitting}
            onClick={onCancel}
          >
            {t("documents.cancel")}
          </Button>
        </div>
      </div>
    </aside>
  );
}
