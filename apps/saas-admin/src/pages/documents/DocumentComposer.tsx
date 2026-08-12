import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { CatalogVersionDto } from "../catalog/api.js";
import type { TenantListItem } from "../tenants/api.js";
import { useNavigationGuard } from "../../layout/NavigationGuard.js";
import {
  calculateDocumentTotals,
  documentDraftReducer,
  validateDocumentDraft,
  type DocumentDraft,
} from "./documentDraft.js";
import { CatalogPositionPicker } from "./CatalogPositionPicker.js";
import { DocumentLinesTable } from "./DocumentLinesTable.js";
import { DocumentSummary } from "./DocumentSummary.js";
import { TenantPicker } from "./TenantPicker.js";

export interface DocumentComposerProps {
  kind: "invoice" | "offer";
  initialDraft?: DocumentDraft;
  tenants: readonly TenantListItem[];
  catalog: readonly CatalogVersionDto[];
  loadingSources: boolean;
  submitting: boolean;
  submitError?: string;
  onSubmit: (draft: DocumentDraft) => Promise<void>;
  onSuccess?: () => void;
  onCancel: () => void;
}

function emptyDraft(): DocumentDraft {
  return { tenantId: "", applicationMode: "automatic", date: "", lines: [] };
}

function snapshot(draft: DocumentDraft) {
  return JSON.stringify(draft);
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
  onSuccess,
  onCancel,
}: DocumentComposerProps) {
  const { t } = useTranslation();
  const initial = useMemo(() => initialDraft ?? emptyDraft(), [initialDraft]);
  const [draft, setDraft] = useState<DocumentDraft>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [separate, setSeparate] = useState(false);
  const nextLineId = useRef(0);
  const dirty = snapshot(draft) !== snapshot(initial);
  const guard = useNavigationGuard(dirty, submitting);
  const totals = calculateDocumentTotals(
    kind,
    draft.lines.filter(
      (line) =>
        Number.isInteger(line.quantity) &&
        line.quantity > 0 &&
        /^\d{1,12}\.\d{2}$/.test(line.agreedUnitPrice),
    ),
  );

  const dispatch = (action: Parameters<typeof documentDraftReducer>[1]) => {
    setDraft((current) => documentDraftReducer(current, action));
    setErrors({});
  };

  const submit = async () => {
    const nextErrors = validateDocumentDraft(draft, kind);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    try {
      await onSubmit(draft);
    } catch {
      return;
    }
    guard.allowNextNavigation();
    onSuccess?.();
  };

  const addCatalogPosition = (version: CatalogVersionDto) => {
    nextLineId.current += 1;
    dispatch({
      type: "catalog.added",
      version,
      separate,
      id: `document-line-${nextLineId.current}`,
    });
    setSeparate(false);
  };

  return (
    <form
      className="document-composer"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <section className="document-composer__workspace" aria-labelledby="document-lines-title">
        <header className="document-composer__header">
          <div>
            <p>{t(`documents.eyebrow.${kind}`)}</p>
            <h1 id="document-lines-title">{t(`documents.title.${kind}`)}</h1>
          </div>
          <TenantPicker
            tenants={tenants}
            value={draft.tenantId}
            loading={loadingSources}
            {...(errors.tenantId ? { error: t(`documents.errors.${errors.tenantId}`) } : {})}
            onValueChange={(tenantId) => dispatch({ type: "tenant.selected", tenantId })}
          />
        </header>
        <CatalogPositionPicker
          catalog={catalog}
          loading={loadingSources}
          separate={separate}
          onSeparateChange={setSeparate}
          onSelected={addCatalogPosition}
        />
        {draft.lines.length === 0 ? (
          <p className="document-composer__onboarding">{t("documents.emptyOnboarding")}</p>
        ) : (
          <DocumentLinesTable
            kind={kind}
            draft={draft}
            errors={errors}
            onQuantityChange={(line, quantity) =>
              dispatch({ type: "line.quantityChanged", id: line.id, quantity })
            }
            onPriceChange={(line, price) =>
              dispatch({ type: "line.priceChanged", id: line.id, price })
            }
            onPriceOverrideReasonChange={(line, reason) =>
              dispatch({ type: "line.priceOverrideReasonChanged", id: line.id, reason })
            }
            onVatIncludedChange={(line, included) =>
              dispatch({ type: "line.vatIncludedChanged", id: line.id, included })
            }
            onPolicyChange={(line, policy) =>
              dispatch({ type: "line.policyChanged", id: line.id, policy })
            }
            onMove={(line, direction) => dispatch({ type: "line.moved", id: line.id, direction })}
            onRemove={(line) => dispatch({ type: "line.removed", id: line.id })}
          />
        )}
      </section>
      <DocumentSummary
        kind={kind}
        draft={draft}
        totals={totals}
        errors={errors}
        submitting={submitting}
        {...(submitError ? { submitError } : {})}
        onApplicationModeChange={(applicationMode) =>
          setDraft((current) => ({ ...current, applicationMode }))
        }
        onDateChange={(date) => setDraft((current) => ({ ...current, date }))}
        onCancel={() => guard.requestProtectedAction(onCancel)}
      />
    </form>
  );
}
