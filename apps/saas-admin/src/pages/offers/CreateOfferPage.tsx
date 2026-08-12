import { useMutation, useQuery } from "@tanstack/react-query";
import { Alert, PageHeader, Spinner } from "@markiro/ui";
import { useTranslation } from "react-i18next";
import { Navigate, useNavigate, useSearchParams } from "react-router";

import { ApiRequestError } from "../../api/client.js";
import { usePlatformPrincipal } from "../../auth/PlatformAuthBoundary.js";
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

function toTenantListItem(detail: TenantDetail): TenantListItem {
  return {
    id: detail.tenant.id,
    name: detail.tenant.name,
    slug: detail.tenant.slug,
    createdAt: detail.tenant.createdAt,
    subscriptionStatus: detail.subscriptionStatus,
  };
}

export function CreateOfferPage() {
  const principal = usePlatformPrincipal();
  if (!principal.capabilities.includes("billing.write")) {
    return <Navigate to="/offers" replace />;
  }
  return <OfferEditor />;
}

function OfferEditor() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const selectedTenantId = tenantIdSchema.safeParse(search.get("tenantId")).data;
  const tenants = useQuery({
    queryKey: ["platform", "tenants", "document-picker"],
    queryFn: () => listTenants({ page: 1, limit: 100 }),
  });
  const catalog = useQuery({
    queryKey: ["platform", "catalog", "document-picker"],
    queryFn: listCatalogVersions,
  });
  const selectedTenantOnPage =
    tenants.data?.items.some((tenant) => tenant.id === selectedTenantId) ?? false;
  const needsTenantPrefetch =
    selectedTenantId !== undefined && tenants.isSuccess && !selectedTenantOnPage;
  const prefetchedTenant = useQuery({
    queryKey: ["platform", "tenants", selectedTenantId],
    queryFn: () => getTenant(selectedTenantId!),
    enabled: needsTenantPrefetch,
  });
  const create = useMutation({
    mutationFn: async (draft: DocumentDraft) => {
      const refreshedCatalog = await catalog.refetch();
      const publishedIds = new Set(
        (refreshedCatalog.data?.items ?? [])
          .filter((version) => version.status === "published")
          .map((version) => version.id),
      );
      if (
        draft.lines.some(
          (line) => line.catalogVersionId !== null && !publishedIds.has(line.catalogVersionId),
        )
      ) {
        throw new ApiRequestError(409, "Catalog version unavailable", "catalog_version_stale");
      }
      return createOffer(toOfferCreateInput(draft));
    },
  });

  if (
    tenants.isPending ||
    catalog.isPending ||
    (needsTenantPrefetch && prefetchedTenant.isPending)
  ) {
    return (
      <section className="catalog-page">
        <PageHeader title="" />
        <Spinner label={t("shell.routeLoading")} />
      </section>
    );
  }
  if (tenants.error || catalog.error || (needsTenantPrefetch && prefetchedTenant.error)) {
    return (
      <section className="catalog-page">
        <PageHeader title="" />
        <Alert tone="error">{t("documents.errors.loadOfferEditor")}</Alert>
      </section>
    );
  }

  const pickerTenants = [...(tenants.data?.items ?? [])];
  if (
    prefetchedTenant.data &&
    !pickerTenants.some((tenant) => tenant.id === prefetchedTenant.data.tenant.id)
  ) {
    pickerTenants.push(toTenantListItem(prefetchedTenant.data));
  }
  const initialDraft: DocumentDraft = {
    tenantId: selectedTenantId ?? "",
    applicationMode: "automatic",
    date: "",
    lines: [],
  };

  return (
    <DocumentComposer
      kind="offer"
      initialDraft={initialDraft}
      tenants={pickerTenants}
      catalog={(catalog.data?.items ?? []).filter((version) => version.status === "published")}
      loadingSources={false}
      submitting={create.isPending}
      {...(create.error
        ? {
            submitError:
              create.error instanceof ApiRequestError &&
              create.error.code === "catalog_version_stale"
                ? t("documents.errors.catalogVersionStale")
                : t("documents.errors.createOffer"),
          }
        : {})}
      onSubmit={async (draft) => {
        await create.mutateAsync(draft);
      }}
      onSuccess={() => void navigate("/offers", { state: { createdDocument: "offer" } })}
      onCancel={() => void navigate("/offers")}
    />
  );
}
