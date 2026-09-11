import { useQuery } from "@tanstack/react-query";
import { Alert, Button, SectionHeader, Spinner, StatusChip, Table } from "@markiro/ui";
import {
  platformUuidSchema,
  type OfferPreview as Preview,
  type OfferWorkspaceV2 as OfferWorkspace,
} from "@markiro/platform-contracts";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation, useParams } from "react-router";
import { usePlatformPrincipal } from "../../auth/PlatformAuthBoundary.js";
import { ApiRequestError } from "../../api/client.js";
import { getOfferWorkspace } from "./api.js";
import { OfferReadiness } from "./OfferReadiness.js";
import { OfferActions } from "./OfferActions.js";
import { OfferDocuments } from "./OfferDocuments.js";
import { OfferPreview } from "./OfferPreview.js";
import { offerDate, offerErrorKey, offerMoney, registryReturnTo } from "./offerPresentation.js";

export function OfferDetailPage() {
  const { offerId } = useParams();
  return <OfferDetail key={offerId} offerId={offerId ?? ""} />;
}
function OfferDetail({ offerId }: { offerId: string }) {
  const { t, i18n } = useTranslation();
  const principal = usePlatformPrincipal();
  const location = useLocation();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [copyState, setCopyState] = useState<"copied" | "copyError" | null>(null);
  const idValid = platformUuidSchema.safeParse(offerId).success;
  const canRead = principal.capabilities.includes("billing.read");
  const canWrite = principal.capabilities.includes("billing.write");
  const workspace = useQuery({
    queryKey: ["platform", "offers", offerId, "workspace"],
    queryFn: () => getOfferWorkspace(offerId),
    enabled: canRead && idValid,
    refetchOnMount: "always",
  });
  const returnTo = registryReturnTo((location.state as { returnTo?: unknown } | null)?.returnTo);
  const data = workspace.data;
  const offer = data?.offer;
  const accessLost =
    workspace.error instanceof ApiRequestError &&
    [401, 403, 404].includes(workspace.error.status ?? 0);
  return (
    <section className="catalog-page offer-detail">
      <Link to={returnTo}>{t("offerWorkspace.back")}</Link>
      {(location.state as { createdDocument?: unknown } | null)?.createdDocument === "offer" ? (
        <Alert tone="ok">{t("offers.created")}</Alert>
      ) : null}
      {!canRead || !idValid ? (
        <Alert tone="error">{t("offerWorkspace.errors.forbidden")}</Alert>
      ) : workspace.error && (!data || accessLost) ? (
        <>
          <Alert tone="error">{t(offerErrorKey(workspace.error))}</Alert>
          <Button onClick={() => void workspace.refetch()}>{t("offerWorkspace.retry")}</Button>
        </>
      ) : !data || !offer ? (
        <Spinner label={t("shell.routeLoading")} />
      ) : (
        <>
          {workspace.error ? (
            <div>
              <Alert tone="error">{t(offerErrorKey(workspace.error))}</Alert>
              <Button onClick={() => void workspace.refetch()}>{t("offerWorkspace.retry")}</Button>
            </div>
          ) : null}
          <SectionHeader
            title={offer.number ?? t("offerWorkspace.status.draft")}
            description={data.tenant.name}
          />
          <div className="offer-detail__meta">
            <StatusChip
              status={
                offer.status === "paid" ? "ok" : offer.status === "draft" ? "neutral" : "info"
              }
              label={t(`offerWorkspace.status.${offer.status}`)}
            />
            <span>{t("offerWorkspace.revision", { revision: offer.revision })}</span>
            <span className="offer-detail__total offer-money">
              {offerMoney(offer.total, i18n.language)}
            </span>
          </div>
          <dl className="offer-facts">
            <div>
              <dt>{t("offerWorkspace.createdAt")}</dt>
              <dd>{offerDate(offer.createdAt, i18n.language)}</dd>
            </div>
            <div>
              <dt>{t("offerWorkspace.publishedAt")}</dt>
              <dd>
                {offerDate(offer.publishedAt, i18n.language) ?? t("offerWorkspace.notIssued")}
              </dd>
            </div>
            <div>
              <dt>{t("offerWorkspace.expiresAt")}</dt>
              <dd>{offerDate(offer.expiresAt, i18n.language) ?? t("offerWorkspace.noExpiry")}</dd>
            </div>
          </dl>
          <OfferReadiness workspace={data} />
          {canWrite ? (
            <OfferActions
              workspace={data}
              preview={preview}
              onPreviewInvalid={() => setPreview(null)}
              onChanged={() => workspace.refetch()}
              returnTo={returnTo}
            />
          ) : (
            <p className="offer-muted">{t("offerWorkspace.readOnly")}</p>
          )}
          <section className="offer-section" aria-labelledby="offer-lines-title">
            <h2 id="offer-lines-title">{t("offerWorkspace.lines")}</h2>
            <Table
              scrollLabel={t("offerWorkspace.lines")}
              rows={offer.lines}
              columns={[
                {
                  key: "nameRu",
                  title: t("offerWorkspace.lineName"),
                  wrap: true,
                  render: (line) => (
                    <div className="offer-cell">
                      <strong>
                        {i18n.language.startsWith("ru")
                          ? (line.commercialTerms?.documentNameRu ?? line.nameRu)
                          : (line.commercialTerms?.documentNameEn ?? line.nameEn)}
                      </strong>
                      {line.commercialTerms?.billingPeriod ? (
                        <small>
                          {t(`catalog.units.${line.commercialTerms.billingPeriod}`)} ·{" "}
                          {t(`commercial.activation.${line.commercialTerms.activationRule}`)}
                        </small>
                      ) : null}
                      {(
                        i18n.language.startsWith("ru") ? line.descriptionRu : line.descriptionEn
                      ) ? (
                        <small>
                          {i18n.language.startsWith("ru") ? line.descriptionRu : line.descriptionEn}
                        </small>
                      ) : null}
                    </div>
                  ),
                },
                {
                  key: "quantity",
                  title: t("offerWorkspace.quantity"),
                  mono: true,
                  align: "right",
                },
                {
                  key: "unit",
                  title: t("offerWorkspace.unit"),
                  render: (line) =>
                    line.commercialTerms?.billingPeriod
                      ? t(`catalog.units.${line.commercialTerms.billingPeriod}`)
                      : line.unit,
                },
                {
                  key: "agreedUnitPrice",
                  title: t("offerWorkspace.price"),
                  mono: true,
                  align: "right",
                  render: (line) => offerMoney(line.agreedUnitPrice, i18n.language),
                },
                {
                  key: "vatRate",
                  title: t("offerWorkspace.vat"),
                  render: (line) =>
                    line.vatRate === null
                      ? t("offerWorkspace.noVat")
                      : `${new Intl.NumberFormat(i18n.language).format(Number(line.vatRate))}% (${t(line.vatIncluded ? "offerWorkspace.vatIncluded" : "offerWorkspace.vatAdded")})`,
                },
                {
                  key: "lineTotal",
                  title: t("offerWorkspace.lineTotal"),
                  mono: true,
                  align: "right",
                  render: (line) => offerMoney(line.lineTotal, i18n.language),
                },
              ]}
            />
            <div className="offer-total">
              <span>{t("offers.total")}</span>
              <strong className="offer-money">{offerMoney(offer.total, i18n.language)}</strong>
            </div>
          </section>
          <section className="offer-section">
            <h2>{t("offerWorkspace.terms")}</h2>
            <p className="offer-terms">{offer.termsMarkdown ?? t("offerWorkspace.noTerms")}</p>
          </section>
          {offer.status === "draft" ? (
            <OfferPreview
              offerId={offerId}
              onPreview={setPreview}
              onInvalidate={() => setPreview(null)}
            />
          ) : null}
          <section className="offer-section">
            <h2>{t("offerWorkspace.parties")}</h2>
            <p className="offer-muted">
              {t(offer.number ? "offerWorkspace.frozenParties" : "offerWorkspace.draftParties")}
            </p>
            <div className="offer-parties">
              <OfferParty
                title={t("offerWorkspace.seller")}
                party={data.parties.seller}
                account={data.parties.sellerBankAccount}
              />
              <OfferParty
                title={t("offerWorkspace.buyer")}
                party={data.parties.buyer}
                account={data.parties.buyerBankAccount}
              />
            </div>
          </section>
          <OfferDocuments workspace={data} canWrite={canWrite} />
          <section className="offer-section">
            <h2>{t("offerWorkspace.history")}</h2>
            {data.decision ? (
              <div className="offer-decision">
                <strong>{t(`offerWorkspace.${data.decision.decision}`)}</strong>
                <time dateTime={data.decision.createdAt}>
                  {offerDate(data.decision.createdAt, i18n.language)}
                </time>
                {data.decision.message ? <p>{data.decision.message}</p> : null}
              </div>
            ) : (
              <p className="offer-muted">{t("offerWorkspace.noDecision")}</p>
            )}
            <ul className="offer-revisions">
              {data.revisions.map((revision) => (
                <li key={revision.id}>
                  <Link
                    aria-current={revision.id === offer.id ? "page" : undefined}
                    to={`/offers/${revision.id}`}
                    state={{ returnTo }}
                  >
                    {revision.number ?? t("offerWorkspace.status.draft")} (
                    {t("offerWorkspace.revision", { revision: revision.revision })})
                  </Link>
                  <span>{t(`offerWorkspace.status.${revision.status}`)}</span>
                  <time dateTime={revision.createdAt}>
                    {offerDate(revision.createdAt, i18n.language)}
                  </time>
                </li>
              ))}
            </ul>
            {data.request ? (
              <Link to={`/billing-requests/${data.request.id}`}>
                {t("offerWorkspace.request")} {data.request.number}
              </Link>
            ) : null}
          </section>
          <details className="offer-technical">
            <summary>{t("offerWorkspace.technical")}</summary>
            <p className="offer-money">{offer.id}</p>
            <Button
              variant="secondary"
              onClick={() => {
                void navigator.clipboard.writeText(offer.id).then(
                  () => setCopyState("copied"),
                  () => setCopyState("copyError"),
                );
              }}
            >
              {t("offerWorkspace.copyId")}
            </Button>
            {copyState ? <p role="status">{t(`offerWorkspace.${copyState}`)}</p> : null}
          </details>
        </>
      )}
    </section>
  );
}

function OfferParty({
  title,
  party,
  account,
}: {
  title: string;
  party: OfferWorkspace["parties"]["seller"];
  account: OfferWorkspace["parties"]["sellerBankAccount"];
}) {
  const { t } = useTranslation();
  return (
    <section>
      <h3>{title}</h3>
      {party ? (
        <>
          <strong>{party.fullName}</strong>
          <p>{party.legalAddressRaw}</p>
          <dl className="offer-party-details">
            {party.inn ? (
              <div>
                <dt>{t("offerWorkspace.inn")}</dt>
                <dd>{party.inn}</dd>
              </div>
            ) : null}
            {party.kpp ? (
              <div>
                <dt>{t("legal.fields.kpp")}</dt>
                <dd>{party.kpp}</dd>
              </div>
            ) : null}
            {(party.ogrn ?? party.ogrnip) ? (
              <div>
                <dt>{t(party.ogrn ? "legal.fields.ogrn" : "legal.fields.ogrnip")}</dt>
                <dd>{party.ogrn ?? party.ogrnip}</dd>
              </div>
            ) : null}
          </dl>
        </>
      ) : (
        <p className="offer-muted">{t("offerWorkspace.noRequisites")}</p>
      )}
      {account ? (
        <dl className="offer-party-details">
          <div>
            <dt>{t("offerWorkspace.account")}</dt>
            <dd>{account.settlementAccount}</dd>
          </div>
          <div>
            <dt>{account.bankName}</dt>
            <dd>
              {t("offerWorkspace.bic")} {account.bic}
            </dd>
          </div>
          <div>
            <dt>{t("offerWorkspace.correspondent")}</dt>
            <dd>{account.correspondentAccount}</dd>
          </div>
        </dl>
      ) : null}
    </section>
  );
}
