import { Alert, Button, Input, Select } from "@markiro/ui";
import { useTranslation } from "react-i18next";

import type { DocumentDraft, DocumentKind } from "./documentDraft.js";

export function DocumentSummary({
  kind,
  draft,
  totals,
  errors,
  submitting,
  submitError,
  onApplicationModeChange,
  onDateChange,
  onCancel,
}: {
  kind: DocumentKind;
  draft: DocumentDraft;
  totals: { subtotal: string; vatTotal: string; total: string };
  errors: Record<string, string>;
  submitting: boolean;
  submitError?: string;
  onApplicationModeChange: (mode: DocumentDraft["applicationMode"]) => void;
  onDateChange: (date: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const errorValues = Array.from(new Set(Object.values(errors)));

  return (
    <aside className="document-summary" aria-labelledby="document-summary-title">
      <h2 id="document-summary-title">{t("documents.summary")}</h2>
      <div className="document-summary__totals" aria-live="polite">
        <p>{t("documents.lineCount", { count: draft.lines.length })}</p>
        <dl>
          <div>
            <dt>{t("documents.subtotal")}</dt>
            <dd>{totals.subtotal} ₽</dd>
          </div>
          <div>
            <dt>{t("documents.vat")}</dt>
            <dd>{totals.vatTotal} ₽</dd>
          </div>
          <div>
            <dt>{t("documents.total")}</dt>
            <dd>{totals.total} ₽</dd>
          </div>
        </dl>
      </div>
      <Input
        type="date"
        label={t(`documents.date.${kind}`)}
        value={draft.date}
        onChange={(event) => onDateChange(event.target.value)}
      />
      {kind === "invoice" ? (
        <Select
          label={t("documents.applicationMode")}
          options={[
            { value: "automatic", label: t("documents.applicationModes.automatic") },
            { value: "manual", label: t("documents.applicationModes.manual") },
          ]}
          value={draft.applicationMode}
          onValueChange={onApplicationModeChange}
        />
      ) : null}
      {errorValues.length > 0 ? (
        <Alert tone="error">
          <ul>
            {errorValues.map((error) => (
              <li key={error}>{t(`documents.errors.${error}`)}</li>
            ))}
          </ul>
        </Alert>
      ) : null}
      {submitError ? <Alert tone="error">{submitError}</Alert> : null}
      <div className="document-summary__actions">
        <Button type="submit" loading={submitting}>
          {t(`documents.submit.${kind}`)}
        </Button>
        <Button type="button" variant="secondary" disabled={submitting} onClick={onCancel}>
          {t("documents.cancel")}
        </Button>
      </div>
    </aside>
  );
}
