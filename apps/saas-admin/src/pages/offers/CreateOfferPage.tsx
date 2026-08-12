import { useMutation, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useSearchParams } from "react-router";

import { Alert, PageHeader, Spinner } from "@markiro/ui";

import { listCatalogVersions } from "../catalog/api.js";
import { DocumentComposer } from "../documents/DocumentComposer.js";
import { toOfferCreateInput, type DocumentDraft } from "../documents/documentDraft.js";
import {
  getTenant,
  listTenants,
  tenantIdSchema,
  type TenantDetail,
  type TenantListItem,
} from "../tenants/api.js";
import { createOffer } from "./api.js";

function tenantOption(detail: TenantDetail): TenantListItem {
  return {
    id: detail.tenant.id,
    name: detail.tenant.name,
    slug: detail.tenant.slug,
    createdAt: detail.tenant.createdAt,
    subscriptionStatus: detail.subscriptionStatus,
  };
}

export function CreateOfferPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [submitError, setSubmitError] = useState<string>();
  const queryTenantId = searchParams.get("tenantId");
  const desiredTenantId =
    queryTenantId && tenantIdSchema.safeParse(queryTenantId).success ? queryTenantId : null;
  const tenantsQuery = useQuery({
    queryKey: ["platform", "tenants", "document-picker", 100],
    queryFn: () => listTenants({ page: 1, limit: 100 }),
  });
  const catalogQuery = useQuery({
    queryKey: ["platform", "catalog", "document-picker"],
    queryFn: listCatalogVersions,
  });
  const tenantMissingFromPage =
    desiredTenantId !== null &&
    tenantsQuery.data !== undefined &&
    !tenantsQuery.data.items.some((tenant) => tenant.id === desiredTenantId);
  const selectedTenantQuery = useQuery({
    queryKey: ["platform", "tenants", desiredTenantId, "document-picker"],
    queryFn: () => getTenant(desiredTenantId!),
    enabled: tenantMissingFromPage,
  });
  const create = useMutation({ mutationFn: createOffer });
  const tenants = useMemo(() => {
    const items = tenantsQuery.data?.items ?? [];
    if (!selectedTenantQuery.data) return items;
    return [...items, tenantOption(selectedTenantQuery.data)];
  }, [selectedTenantQuery.data, tenantsQuery.data]);
  const catalog = useMemo(
    () => (catalogQuery.data?.items ?? []).filter((version) => version.status === "published"),
    [catalogQuery.data],
  );
  const initialDraft = useMemo<DocumentDraft | undefined>(
    () =>
      desiredTenantId
        ? { tenantId: desiredTenantId, applicationMode: "automatic", date: "", lines: [] }
        : undefined,
    [desiredTenantId],
  );
  const loading =
    tenantsQuery.isPending ||
    catalogQuery.isPending ||
    (tenantMissingFromPage && selectedTenantQuery.isPending);
  const loadError =
    tenantsQuery.error ??
    catalogQuery.error ??
    (tenantMissingFromPage ? selectedTenantQuery.error : null);

  return (
    <section className="document-editor-page">
      <div className="tenant-detail-backline">
        <Link to="/offers">{t("offers.editor.back")}</Link>
      </div>
      <PageHeader title={t("offers.editor.title")} />
      {loading ? (
        <Spinner label={t("documents.loadingSources")} />
      ) : loadError ? (
        <Alert tone="error">{t("documents.loadSourcesError")}</Alert>
      ) : (
        <DocumentComposer
          kind="offer"
          {...(initialDraft ? { initialDraft } : {})}
          tenants={tenants}
          catalog={catalog}
          loadingSources={false}
          submitting={create.isPending}
          {...(submitError ? { submitError } : {})}
          onSubmit={async (draft) => {
            setSubmitError(undefined);
            try {
              await create.mutateAsync(toOfferCreateInput(draft));
              window.setTimeout(
                () => void navigate("/offers", { state: { offerCreated: true } }),
                0,
              );
            } catch {
              setSubmitError(t("offers.editor.createError"));
              return false;
            }
          }}
          onCancel={() => void navigate("/offers")}
        />
      )}
    </section>
  );
}
