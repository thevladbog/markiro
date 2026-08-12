import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation, useNavigate } from "react-router";
import { Alert, Button, Card, Input, PageHeader, Spinner, StatusChip, Table } from "@markiro/ui";
import { usePlatformPrincipal } from "../../auth/PlatformAuthBoundary.js";
import { getOffer, listOffers, payOffer, publishOffer, type Offer } from "./api.js";

export function OffersPage() {
  const { t } = useTranslation();
  const principal = usePlatformPrincipal();
  const client = useQueryClient();
  const location = useLocation();
  const navigate = useNavigate();
  const offers = useQuery({ queryKey: ["platform", "offers"], queryFn: listOffers });
  const [bankReference, setBankReference] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = useQuery({
    queryKey: ["platform", "offers", selectedId],
    queryFn: () => getOffer(selectedId!),
    enabled: selectedId !== null,
  });
  const publish = useMutation({
    mutationFn: () => publishOffer(selected.data!.id),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["platform", "offers"] }),
  });
  const pay = useMutation({
    mutationFn: () =>
      payOffer(selected.data!.id, selected.data!.total, bankReference, crypto.randomUUID()),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["platform", "offers"] }),
  });
  if (offers.isPending)
    return (
      <section className="catalog-page">
        <PageHeader title={t("offers.title")} />
        <Spinner label={t("shell.routeLoading")} />
      </section>
    );
  if (offers.error)
    return (
      <section className="catalog-page">
        <PageHeader title={t("offers.title")} />
        <Alert tone="error">{t("offers.loadError")}</Alert>
      </section>
    );
  return (
    <section className="catalog-page">
      <PageHeader
        title={t("offers.title")}
        actions={
          <>
            <Link to="/catalog">{t("offers.catalogLink")}</Link>
            {principal.capabilities.includes("billing.write") ? (
              <Link to="/offers/new">{t("offers.create")}</Link>
            ) : null}
          </>
        }
      />
      {(location.state as { createdDocument?: unknown } | null)?.createdDocument === "offer" ? (
        <Alert tone="ok">{t("offers.created")}</Alert>
      ) : null}
      <Table
        columns={[
          {
            key: "tenantId",
            title: t("offers.tenant"),
            render: (offer: Offer) => (
              <button type="button" className="table-link" onClick={() => setSelectedId(offer.id)}>
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
      {selected.data ? (
        <Card title={`${t("offers.detail")} · ${selected.data.total} ₽`}>
          <p>{t("offers.lines", { count: selected.data.lines.length })}</p>
          {selected.data.status === "draft" && principal.capabilities.includes("billing.write") ? (
            <Button onClick={() => void publish.mutateAsync()} loading={publish.isPending}>
              {t("offers.publish")}
            </Button>
          ) : null}
          {selected.data.status === "published" &&
          principal.capabilities.includes("billing.write") ? (
            <div style={{ display: "grid", gap: 10, maxWidth: 420 }}>
              <Button
                variant="secondary"
                onClick={() =>
                  void navigate("/billing/new", { state: { sourceOfferId: selected.data.id } })
                }
              >
                {t("offers.createInvoice")}
              </Button>
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
      ) : selected.isPending ? (
        <Spinner label={t("shell.routeLoading")} />
      ) : null}
    </section>
  );
}
