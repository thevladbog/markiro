import { Alert } from "@markiro/ui";
import type { OfferWorkspaceV2 } from "@markiro/platform-contracts";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { commercialIssuanceError } from "../documents/commercialError.js";

export function OfferReadiness({ workspace }: { workspace: OfferWorkspaceV2 }) {
  const { t } = useTranslation();
  const { offer, parties, actions } = workspace;
  if (offer.status !== "draft") return null;
  const missing = offer.lines.filter((line) => !line.commercialTerms);
  const commercial = commercialIssuanceError(offer.lines, {
    taxPolicy: parties.seller?.taxPolicy ?? null,
    sellerPolicyRevision: parties.seller?.revision ?? 0,
  });
  const issues: Array<{ key: string; to: string }> = [];
  if (!actions.publish) {
    if (!parties.seller?.confirmedAt)
      issues.push({ key: "sellerUnconfirmed", to: "/settings/organization" });
    if (!parties.buyer?.confirmedAt)
      issues.push({ key: "buyerUnconfirmed", to: `/tenants/${offer.tenantId}` });
    if (!parties.sellerBankAccount)
      issues.push({ key: "sellerAccountMissing", to: "/settings/organization" });
    if (offer.expiresAt && Date.parse(offer.expiresAt) <= Date.now())
      issues.push({ key: "expiredDraft", to: `/offers/${offer.id}/edit` });
  }
  if (!missing.length && !commercial && !issues.length) return null;
  return (
    <Alert tone="warn">
      <strong>{t("offerWorkspace.beforeIssue")}</strong>
      <ul>
        {issues.map((issue) => (
          <li key={issue.key}>
            {t(`offerWorkspace.${issue.key}`)}{" "}
            <Link to={issue.to}>{t("offerWorkspace.correct")}</Link>
          </li>
        ))}
        {missing.map((line) => (
          <li key={line.id}>{t("offerWorkspace.lineTermsMissing", { name: line.nameRu })}</li>
        ))}
        {commercial && commercial !== "commercial_terms_review_required" ? (
          <li>
            {t(`commercial.errors.${commercial}`)}{" "}
            <Link
              to={
                commercial === "seller_tax_policy_unconfigured"
                  ? "/settings/organization"
                  : `/offers/${offer.id}/edit`
              }
            >
              {t("offerWorkspace.correct")}
            </Link>
          </li>
        ) : null}
      </ul>
      {missing.length ? (
        <p>
          {t("offerWorkspace.legacyDraftHint")}{" "}
          <Link to="/catalog">{t("offerWorkspace.openCatalog")}</Link>
        </p>
      ) : null}
    </Alert>
  );
}
