import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { Alert, Button, Card, Input, PageHeader, Spinner, StatusChip, Table } from "@markiro/ui";
import { usePlatformPrincipal } from "../../auth/PlatformAuthBoundary.js";
import { createOffer, listOffers, payOffer, publishOffer, type Offer } from "./api.js";

export function OffersPage() {
  const { t } = useTranslation();
  const principal = usePlatformPrincipal();
  const client = useQueryClient();
  const offers = useQuery({ queryKey: ["platform", "offers"], queryFn: listOffers });
  const [tenantId, setTenantId] = useState("");
  const [amount, setAmount] = useState("0.00");
  const [bankReference, setBankReference] = useState("");
  const [selected, setSelected] = useState<Offer | null>(null);
  const create = useMutation({
    mutationFn: () =>
      createOffer({
        tenantId,
        lines: [
          {
            kind: "service",
            nameRu: "Услуга",
            nameEn: "Service",
            quantity: 1,
            unit: "service",
            agreedUnitPrice: amount,
            vatIncluded: true,
          },
        ],
      }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["platform", "offers"] }),
  });
  const publish = useMutation({
    mutationFn: () => publishOffer(selected!.id),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["platform", "offers"] }),
  });
  const pay = useMutation({
    mutationFn: () => payOffer(selected!.id, selected!.total, bankReference, crypto.randomUUID()),
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
        actions={<Link to="/catalog">{t("offers.catalogLink")}</Link>}
      />
      {principal.capabilities.includes("billing.write") ? (
        <Card title={t("offers.newTitle")}>
          <div style={{ display: "grid", gap: 10, maxWidth: 520 }}>
            <Input
              label={t("offers.tenantId")}
              value={tenantId}
              onChange={(event) => setTenantId(event.target.value)}
            />
            <Input
              label={t("offers.amount")}
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />
            <Button
              onClick={() => void create.mutateAsync()}
              loading={create.isPending}
              disabled={!tenantId}
            >
              {t("offers.create")}
            </Button>
          </div>
        </Card>
      ) : null}
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
          <p>{t("offers.lines", { count: selected.lines.length })}</p>
          {selected.status === "draft" && principal.capabilities.includes("billing.write") ? (
            <Button onClick={() => void publish.mutateAsync()} loading={publish.isPending}>
              {t("offers.publish")}
            </Button>
          ) : null}
          {selected.status === "published" && principal.capabilities.includes("billing.write") ? (
            <div style={{ display: "grid", gap: 10, maxWidth: 420 }}>
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
