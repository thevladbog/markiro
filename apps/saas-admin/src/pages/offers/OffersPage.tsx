import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation } from "react-router";
import { Alert, Button, Card, Input, PageHeader, Spinner, StatusChip, Table } from "@markiro/ui";
import { usePlatformPrincipal } from "../../auth/PlatformAuthBoundary.js";
import { listOffers, payOffer, publishOffer, type Offer } from "./api.js";

export function OffersPage() {
  const { t } = useTranslation();
  const principal = usePlatformPrincipal();
  const client = useQueryClient();
  const location = useLocation();
  const offers = useQuery({ queryKey: ["platform", "offers"], queryFn: listOffers });
  const [bankReference, setBankReference] = useState("");
  const [selected, setSelected] = useState<Offer | null>(null);
  const publish = useMutation({
    mutationFn: () => publishOffer(selected!.id),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["platform", "offers"] }),
  });
  const pay = useMutation({
    mutationFn: () => payOffer(selected!.id, selected!.total, bankReference, crypto.randomUUID()),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["platform", "offers"] }),
  });
  const createAction = principal.capabilities.includes("billing.write") ? (
    <Link to="/offers/new">{t("offers.create")}</Link>
  ) : null;
  const headerActions = (
    <>
      {createAction}
      <Link to="/catalog">{t("offers.catalogLink")}</Link>
    </>
  );
  const createdNotice =
    (location.state as { offerCreated?: unknown } | null)?.offerCreated === true;
  if (offers.isPending)
    return (
      <section className="catalog-page">
        <PageHeader title={t("offers.title")} actions={headerActions} />
        <Spinner label={t("shell.routeLoading")} />
      </section>
    );
  if (offers.error)
    return (
      <section className="catalog-page">
        <PageHeader title={t("offers.title")} actions={headerActions} />
        <Alert tone="error">{t("offers.loadError")}</Alert>
      </section>
    );
  return (
    <section className="catalog-page">
      <PageHeader title={t("offers.title")} actions={headerActions} />
      {createdNotice ? <Alert tone="ok">{t("offers.created")}</Alert> : null}
      <Table
        columns={[
          {
            key: "tenantId",
            title: t("offers.tenant"),
            render: (offer: Offer) => (
              <button type="button" className="table-link" onClick={() => setSelected(offer)}>
                {offer.tenantId}
              </button>
            ),
          },
          {
            key: "status",
            title: t("offers.status"),
            render: (offer: Offer) => (
              <StatusChip
                status={
                  offer.status === "paid" ? "ok" : offer.status === "cancelled" ? "neutral" : "warn"
                }
                label={offer.status}
              />
            ),
          },
          { key: "total", title: t("offers.total") },
        ]}
        rows={offers.data ?? []}
        empty={t("offers.empty")}
      />
      {selected ? (
        <Card title={`${t("offers.detail")} · ${selected.total} ₽`}>
          {selected.status === "draft" && principal.capabilities.includes("billing.write") ? (
            <Button onClick={() => void publish.mutateAsync()} loading={publish.isPending}>
              {t("offers.publish")}
            </Button>
          ) : null}
          {selected.status === "published" && principal.capabilities.includes("billing.write") ? (
            <div style={{ display: "grid", gap: 10, maxWidth: 420 }}>
              <Link to="/billing/new" state={{ sourceOfferId: selected.id }}>
                {t("offers.createInvoice")}
              </Link>
              <Input
                label={t("offers.bankReference")}
                value={bankReference}
                onChange={(event) => setBankReference(event.target.value)}
              />
              <Button
                onClick={() => void pay.mutateAsync()}
                loading={pay.isPending}
                disabled={!bankReference}
              >
                {t("offers.pay")}
              </Button>
            </div>
          ) : null}
        </Card>
      ) : null}
    </section>
  );
}
