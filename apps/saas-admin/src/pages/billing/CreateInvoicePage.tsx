import { useMutation, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";

import { Alert, PageHeader, Spinner } from "@markiro/ui";

import { listCatalogVersions } from "../catalog/api.js";
import { DocumentComposer } from "../documents/DocumentComposer.js";
import {
  toInvoiceCreateInput,
  type DocumentDraft,
  type DocumentLineDraft,
} from "../documents/documentDraft.js";
import { getOffer, offerIdSchema, type OfferDetail } from "../offers/api.js";
import {
  getTenant,
  listTenants,
  tenantIdSchema,
  type TenantDetail,
  type TenantListItem,
} from "../tenants/api.js";
import { createInvoice } from "./api.js";

function tenantOption(detail: TenantDetail): TenantListItem {
  return {
    id: detail.tenant.id,
    name: detail.tenant.name,
    slug: detail.tenant.slug,
    createdAt: detail.tenant.createdAt,
    subscriptionStatus: detail.subscriptionStatus,
  };
}

function sourceDraft(
  source: OfferDetail,
  catalog: Awaited<ReturnType<typeof listCatalogVersions>>["items"],
): DocumentDraft {
  const lines: DocumentLineDraft[] = source.lines.map((line) => {
    const version = catalog.find((candidate) => candidate.id === line.catalogVersionId);
    return {
      id: `source-offer-${line.id}`,
      kind: line.kind,
      catalogVersionId: line.catalogVersionId ?? "",
      catalogItemCode: version?.catalogItemCode ?? "source-offer",
      version: version?.version ?? 1,
      nameRu: line.nameRu,
      nameEn: line.nameEn,
      quantity: line.quantity,
      unit: line.unit,
      agreedUnitPrice: line.agreedUnitPrice,
      vatRateBps: line.vatRate === null ? null : Math.round(Number(line.vatRate) * 100),
      vatIncluded: line.vatIncluded,
      activationPolicy:
        line.kind === "service"
          ? null
          : line.kind === "addon" || line.activationPolicy === "immediately"
            ? "immediate"
            : "after_current",
    };
  });
  return {
    tenantId: source.tenantId,
    applicationMode: "automatic",
    date: "",
    lines,
  };
}

export function CreateInvoicePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const [submitError, setSubmitError] = useState<string>();
  const sourceState = (location.state as { sourceOfferId?: unknown } | null)?.sourceOfferId;
  const sourceOfferId =
    typeof sourceState === "string" && offerIdSchema.safeParse(sourceState).success
      ? sourceState
      : null;
  const queryTenantId = searchParams.get("tenantId");
  const validQueryTenantId =
    queryTenantId && tenantIdSchema.safeParse(queryTenantId).success ? queryTenantId : null;

  const tenantsQuery = useQuery({
    queryKey: ["platform", "tenants", "document-picker", 100],
    queryFn: () => listTenants({ page: 1, limit: 100 }),
  });
  const catalogQuery = useQuery({
    queryKey: ["platform", "catalog", "document-picker"],
    queryFn: listCatalogVersions,
  });
  const sourceQuery = useQuery({
    queryKey: ["platform", "offers", sourceOfferId, "invoice-source"],
    queryFn: () => getOffer(sourceOfferId!),
    enabled: sourceOfferId !== null,
  });
  const desiredTenantId = sourceQuery.data?.tenantId ?? validQueryTenantId;
  const tenantMissingFromPage =
    desiredTenantId !== null &&
    tenantsQuery.data !== undefined &&
    !tenantsQuery.data.items.some((tenant) => tenant.id === desiredTenantId);
  const selectedTenantQuery = useQuery({
    queryKey: ["platform", "tenants", desiredTenantId, "document-picker"],
    queryFn: () => getTenant(desiredTenantId!),
    enabled: tenantMissingFromPage,
  });
  const create = useMutation({ mutationFn: createInvoice });

  const tenants = useMemo(() => {
    const items = tenantsQuery.data?.items ?? [];
    if (!selectedTenantQuery.data) return items;
    return [...items, tenantOption(selectedTenantQuery.data)];
  }, [selectedTenantQuery.data, tenantsQuery.data]);
  const catalog = useMemo(
    () => (catalogQuery.data?.items ?? []).filter((version) => version.status === "published"),
    [catalogQuery.data],
  );
  const initialDraft = useMemo<DocumentDraft | undefined>(() => {
    if (sourceQuery.data) return sourceDraft(sourceQuery.data, catalog);
    if (!desiredTenantId) return undefined;
    return { tenantId: desiredTenantId, applicationMode: "automatic", date: "", lines: [] };
  }, [catalog, desiredTenantId, sourceQuery.data]);

  const loading =
    tenantsQuery.isPending ||
    catalogQuery.isPending ||
    (sourceOfferId !== null && sourceQuery.isPending) ||
    (tenantMissingFromPage && selectedTenantQuery.isPending);
  const loadError =
    tenantsQuery.error ??
    catalogQuery.error ??
    (sourceOfferId !== null ? sourceQuery.error : null) ??
    (tenantMissingFromPage ? selectedTenantQuery.error : null);

  return (
    <section className="document-editor-page">
      <div className="tenant-detail-backline">
        <Link to="/billing">{t("billing.editor.back")}</Link>
      </div>
      <PageHeader title={t("billing.editor.title")} />
      {loading ? (
        <Spinner label={t("documents.loadingSources")} />
      ) : loadError ? (
        <Alert tone="error">{t("documents.loadSourcesError")}</Alert>
      ) : (
        <DocumentComposer
          kind="invoice"
          {...(initialDraft ? { initialDraft } : {})}
          tenants={tenants}
          catalog={catalog}
          loadingSources={false}
          submitting={create.isPending}
          {...(submitError ? { submitError } : {})}
          onSubmit={async (draft) => {
            setSubmitError(undefined);
            try {
              await create.mutateAsync(toInvoiceCreateInput(draft));
              window.setTimeout(
                () => void navigate("/billing", { state: { invoiceCreated: true } }),
                0,
              );
            } catch {
              setSubmitError(t("billing.editor.createError"));
              return false;
            }
          }}
          onCancel={() => void navigate("/billing")}
        />
      )}
    </section>
  );
}
