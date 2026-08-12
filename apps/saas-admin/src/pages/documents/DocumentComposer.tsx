import { useId, useMemo, useReducer, useRef, type FormEvent } from "react";
import { useTranslation } from "react-i18next";

import { Input, Select } from "@markiro/ui";

import { useNavigationGuard } from "../../layout/NavigationGuard.js";
import type { CatalogVersionDto } from "../catalog/api.js";
import type { TenantListItem } from "../tenants/api.js";
import {
  calculateDocumentTotals,
  documentDraftReducer,
  validateDocumentDraft,
} from "./documentDraft.js";
import type { DocumentDraft, DocumentDraftAction, DocumentKind } from "./types.js";
import { DocumentLinesTable } from "./DocumentLinesTable.js";
import { DocumentSummary, type DocumentTotalsView } from "./DocumentSummary.js";
import { TenantPicker } from "./TenantPicker.js";

export interface DocumentComposerProps {
  kind: "invoice" | "offer";
  initialDraft?: DocumentDraft;
  tenants: readonly TenantListItem[];
  catalog: readonly CatalogVersionDto[];
  loadingSources: boolean;
  submitting: boolean;
  submitError?: string;
  /** Resolve `false` when a handled submit failure leaves the draft open. */
  onSubmit: (draft: DocumentDraft) => Promise<void | false>;
  onCancel: () => void;
}

type ComposerAction =
  | DocumentDraftAction
  | { type: "form.dateChanged"; date: string }
  | { type: "form.applicationModeChanged"; applicationMode: DocumentDraft["applicationMode"] };

function composerReducer(draft: DocumentDraft, action: ComposerAction): DocumentDraft {
  if (action.type === "form.dateChanged") return { ...draft, date: action.date };
  if (action.type === "form.applicationModeChanged")
    return { ...draft, applicationMode: action.applicationMode };
  return documentDraftReducer(draft, action);
}

function createInitialDraft(initialDraft?: DocumentDraft): DocumentDraft {
  return initialDraft
    ? { ...initialDraft, lines: initialDraft.lines.map((line) => ({ ...line })) }
    : { tenantId: "", applicationMode: "automatic", date: "", lines: [] };
}

function validationMessages(
  draft: DocumentDraft,
  kind: DocumentKind,
  catalog: readonly CatalogVersionDto[],
  t: (key: string) => string,
) {
  const messages: Record<string, string> = {};
  Object.entries(validateDocumentDraft(draft, kind)).forEach(([path, code]) => {
    messages[path] = t(`documents.validation.${code}`);
  });
  draft.lines.forEach((line) => {
    if (
      line.kind !== "custom" &&
      !catalog.some(
        (version) => version.id === line.catalogVersionId && version.status === "published",
      )
    ) {
      messages[`lines.${line.id}.catalogVersionId`] = t(
        "documents.validation.published_catalog_version_required",
      );
    }
  });
  return messages;
}

function safeTotals(kind: DocumentKind, draft: DocumentDraft): DocumentTotalsView {
  try {
    return calculateDocumentTotals(kind, draft.lines);
  } catch {
    return { subtotal: "0.00", vatTotal: "0.00", total: "0.00" };
  }
}

export function DocumentComposer({
  kind,
  initialDraft,
  tenants,
  catalog,
  loadingSources,
  submitting,
  submitError,
  onSubmit,
  onCancel,
}: DocumentComposerProps) {
  const { t } = useTranslation();
  const lineIdPrefix = useId().replaceAll(":", "");
  const lineSequence = useRef(0);
  const initial = useMemo(() => createInitialDraft(initialDraft), [initialDraft]);
  const initialSnapshot = useRef(JSON.stringify(initial));
  const [draft, dispatch] = useReducer(composerReducer, initial);
  const dirty = JSON.stringify(draft) !== initialSnapshot.current;
  const guard = useNavigationGuard(dirty, submitting);
  const errors = validationMessages(draft, kind, catalog, t);
  const errorMessages = Array.from(new Set(Object.values(errors)));

  const addCatalogVersion = (version: CatalogVersionDto, separate = false) => {
    lineSequence.current += 1;
    dispatch({
      type: "catalog.added",
      version,
      id: `document-line-${lineIdPrefix}-${lineSequence.current}`,
      ...(separate ? { separate: true } : {}),
    });
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextErrors = validationMessages(draft, kind, catalog, t);
    if (Object.keys(nextErrors).length > 0 || submitting) return;
    const outcome = await onSubmit(draft);
    if (outcome !== false) guard.allowNextNavigation();
  };

  return (
    <form className="document-composer" noValidate onSubmit={(event) => void submit(event)}>
      <section className="document-composer__workspace" aria-labelledby="document-lines-title">
        <div className="document-composer__heading">
          <span className="document-composer__coordinate" aria-hidden="true">
            DOCUMENT / COMPOSE
          </span>
          <h2 id="document-lines-title">{t("documents.linesTitle")}</h2>
        </div>
        <div className="document-composer__metadata">
          <TenantPicker
            tenants={tenants}
            value={draft.tenantId}
            loading={loadingSources}
            disabled={submitting}
            {...(errors.tenantId ? { error: errors.tenantId } : {})}
            onChange={(tenantId) => dispatch({ type: "tenant.selected", tenantId })}
          />
          <Input
            label={t(`documents.date.${kind}`)}
            type="date"
            value={draft.date}
            disabled={submitting}
            onChange={(event) =>
              dispatch({ type: "form.dateChanged", date: event.currentTarget.value })
            }
          />
          {kind === "invoice" ? (
            <Select
              label={t("documents.applicationMode.label")}
              value={draft.applicationMode}
              options={[
                { value: "automatic", label: t("documents.applicationMode.automatic") },
                { value: "manual", label: t("documents.applicationMode.manual") },
              ]}
              disabled={submitting}
              onValueChange={(applicationMode) =>
                dispatch({ type: "form.applicationModeChanged", applicationMode })
              }
            />
          ) : null}
        </div>
        <DocumentLinesTable
          kind={kind}
          lines={draft.lines}
          catalog={catalog}
          loadingSources={loadingSources}
          submitting={submitting}
          errors={errors}
          dispatch={dispatch}
          onAdd={addCatalogVersion}
        />
      </section>
      <DocumentSummary
        kind={kind}
        lineCount={draft.lines.length}
        totals={safeTotals(kind, draft)}
        errors={errorMessages}
        {...(submitError ? { submitError } : {})}
        submitting={submitting}
        onCancel={() => guard.requestProtectedAction(onCancel)}
      />
    </form>
  );
}
