import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Spinner } from "@markiro/ui";
import {
  platformUuidSchema,
  type OfferDraftUpdate,
  type OfferWorkspaceV2,
} from "@markiro/platform-contracts";
import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams } from "react-router";
import { ApiRequestError } from "../../api/client.js";
import { usePlatformPrincipal } from "../../auth/PlatformAuthBoundary.js";
import { useNavigationGuard } from "../../layout/NavigationGuard.js";
import { listCatalogVersions } from "../catalog/api.js";
import { DocumentComposer } from "../documents/DocumentComposer.js";
import { toOfferCreateInput } from "../documents/documentDraft.js";
import { listOperatorBankAccounts } from "../settings/api.js";
import { getOfferWorkspace, updateOfferDraft } from "./api.js";
import { offerErrorKey } from "./offerPresentation.js";
import { offerToDocumentDraft } from "./offerDraft.js";

export function EditOfferPage() {
  const { offerId = "" } = useParams();
  const principal = usePlatformPrincipal();
  const { t } = useTranslation();
  const allowed =
    principal.capabilities.includes("billing.write") &&
    platformUuidSchema.safeParse(offerId).success;
  const workspace = useQuery({
    queryKey: ["platform", "offers", offerId, "workspace"],
    queryFn: () => getOfferWorkspace(offerId),
    enabled: allowed,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  if (!allowed) return <Alert tone="error">{t("offerWorkspace.errors.forbidden")}</Alert>;
  if (workspace.error && !workspace.data)
    return <Alert tone="error">{t(offerErrorKey(workspace.error))}</Alert>;
  if (!workspace.data || (workspace.isFetching && !workspace.isFetchedAfterMount))
    return <Spinner label={t("shell.routeLoading")} />;
  if (workspace.data.offer.status !== "draft")
    return (
      <>
        <Alert tone="info">{t("offerWorkspace.issuedImmutable")}</Alert>
        <Link to={`/offers/${offerId}`}>{t("offerWorkspace.open")}</Link>
      </>
    );
  return <OfferDraftEditor key={offerId} workspace={workspace.data} />;
}

function OfferDraftEditor({ workspace }: { workspace: OfferWorkspaceV2 }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const client = useQueryClient();
  // A background refresh must not advance the concurrency token for unsaved edits.
  const [offer] = useState(() => workspace.offer);
  const initial = useMemo(() => offerToDocumentDraft(offer), [offer]);
  const catalog = useQuery({
    queryKey: ["platform", "catalog", "document-picker"],
    queryFn: listCatalogVersions,
  });
  const accounts = useQuery({
    queryKey: ["platform", "billing", "operator", "accounts"],
    queryFn: listOperatorBankAccounts,
  });
  const attempt = useRef<OfferDraftUpdate | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const save = useMutation({
    mutationFn: (input: OfferDraftUpdate) => updateOfferDraft(offer.id, input),
    onError: (error) => {
      const ambiguous =
        !(error instanceof ApiRequestError) ||
        error.status === null ||
        error.status >= 500 ||
        error.kind === "contract";
      setUncertain(ambiguous);
      if (!ambiguous) attempt.current = null;
    },
  });
  const guard = useNavigationGuard(false, uncertain || save.isPending);
  const finish = () => {
    guard.allowNextNavigation();
    void client.invalidateQueries({ queryKey: ["platform", "offers"], refetchType: "none" });
    void navigate(`/offers/${offer.id}`, { state: { savedDraft: true } });
  };
  if (catalog.isPending || accounts.isPending) return <Spinner label={t("shell.routeLoading")} />;
  const sourcesError =
    catalog.error || accounts.error ? (
      <Alert tone="error">
        {t("offers.loadError")}
        <Button
          onClick={() => {
            void catalog.refetch();
            void accounts.refetch();
          }}
        >
          {t("offerWorkspace.retry")}
        </Button>
      </Alert>
    ) : null;
  if ((catalog.error && !catalog.data) || (accounts.error && !accounts.data)) return sourcesError;
  return (
    <>
      {sourcesError}
      {uncertain ? (
        <section className="catalog-page">
          <Alert tone="error">{t("offers.requestRetry.ambiguous")}</Alert>
          <p>{t("offerWorkspace.retryFrozen")}</p>
          <Button
            loading={save.isPending}
            disabled={save.isPending}
            onClick={() => {
              if (attempt.current)
                void save
                  .mutateAsync(attempt.current)
                  .then(finish)
                  .catch(() => undefined);
            }}
          >
            {t("offers.requestRetry.retry")}
          </Button>
        </section>
      ) : null}

      <div className="offer-editor" hidden={uncertain}>
        <Link to={`/offers/${offer.id}`}>{t("offerWorkspace.backToOffer")}</Link>
        <DocumentComposer
          kind="offer"
          editing
          initialDraft={initial}
          tenants={[]}
          lockedTenantId={offer.tenantId}
          lockedTenantName={workspace.tenant.name}
          catalog={(catalog.data?.items ?? []).filter((version) => version.status === "published")}
          sellerAccounts={accounts.data ?? []}
          loadingSources={false}
          submitting={save.isPending}
          {...(save.error ? { submitError: t(offerErrorKey(save.error)) } : {})}
          onSubmit={async (draft) => {
            const { tenantId: _tenant, ...input } = toOfferCreateInput(draft);
            void _tenant;
            attempt.current = {
              ...input,
              termsMarkdown: draft.termsMarkdown ?? null,
              expiresAt: draft.date === initial.date ? offer.expiresAt : (input.expiresAt ?? null),
              expectedUpdatedAt: offer.updatedAt,
              idempotencyKey: crypto.randomUUID(),
            };
            await save.mutateAsync(attempt.current);
          }}
          onSuccess={finish}
          onCancel={() => void navigate(`/offers/${offer.id}`)}
        />
      </div>
    </>
  );
}
