import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router";
import {
  Alert,
  Button,
  Checkbox,
  Input,
  SectionHeader,
  Select,
  Spinner,
  StatusChip,
  Table,
  type TagPhase,
} from "@markiro/ui";

import { listAgreements, type AgreementStatus, type AgreementSummary } from "./api.js";

const STATUSES = ["draft", "in_review", "sent", "signed", "terminated"] as const;

/**
 * `in_review` и `sent` — предложено спекой как `attention`/`running`
 * (`docs/superpowers/specs/2026-09-19-tag-semantics-and-geometry-design.md`),
 * хотя граница между «на согласовании» и «отправлен» в продукте нечёткая:
 * обе фазы означают «ждём решения не от нас». Решение оставлено как в спеке
 * до отдельного продуктового разбора.
 */
export const AGREEMENT_STATUS_TO_PHASE: Record<AgreementStatus, TagPhase> = {
  draft: "draft",
  in_review: "attention",
  sent: "running",
  signed: "done",
  terminated: "retired",
};

export function AgreementsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [status, setStatus] = useState<AgreementStatus | "">("");
  const [withoutTenant, setWithoutTenant] = useState(false);
  const [search, setSearch] = useState("");

  const query = {
    ...(status === "" ? {} : { status }),
    ...(withoutTenant ? { withoutTenant: true } : {}),
    ...(search.trim() === "" ? {} : { search: search.trim() }),
  };
  const agreements = useQuery({
    queryKey: ["platform", "agreements", query],
    queryFn: () => listAgreements(query),
  });

  return (
    <section className="catalog-page">
      <SectionHeader
        eyebrow="COMMERCE / AGREEMENTS"
        title={t("agreements.title")}
        description={t("agreements.description")}
      />

      <div className="agreements-filters">
        <Select
          id="agreements-status"
          label={t("agreements.filters.status")}
          value={status}
          options={[
            { value: "", label: t("agreements.filters.anyStatus") },
            ...STATUSES.map((value) => ({ value, label: t(`agreements.statuses.${value}`) })),
          ]}
          onValueChange={(next) => setStatus(next)}
        />
        <Input
          id="agreements-search"
          label={t("agreements.filters.search")}
          value={search}
          placeholder={t("agreements.filters.searchPlaceholder")}
          onChange={(event) => setSearch(event.target.value)}
        />
        <Checkbox
          checked={withoutTenant}
          onCheckedChange={setWithoutTenant}
          label={t("agreements.filters.withoutTenant")}
        />
        <Button type="button" onClick={() => void navigate("/agreements/new")}>
          {t("agreements.create")}
        </Button>
      </div>

      {agreements.isPending && <Spinner label={t("shell.routeLoading")} />}
      {agreements.error && <Alert tone="error">{t("agreements.loadError")}</Alert>}

      {agreements.data && (
        <Table<AgreementSummary>
          scrollLabel={t("agreements.title")}
          empty={t("agreements.list.empty")}
          rows={[...agreements.data.agreements]}
          getRowKey={(row) => row.id}
          columns={[
            {
              key: "number",
              title: t("agreements.columns.number"),
              mono: true,
              render: (row) => <Link to={`/agreements/${row.id}`}>{row.number}</Link>,
            },
            {
              key: "counterparty",
              title: t("agreements.columns.counterparty"),
              wrap: true,
              render: (row) => row.counterpartyName,
            },
            {
              key: "inn",
              title: t("agreements.columns.inn"),
              mono: true,
              render: (row) => row.counterpartyInn ?? "—",
            },
            {
              key: "status",
              title: t("agreements.columns.status"),
              render: (row) => (
                <StatusChip
                  phase={AGREEMENT_STATUS_TO_PHASE[row.status]}
                  label={t(`agreements.statuses.${row.status}`)}
                />
              ),
            },
            {
              key: "documentForm",
              title: t("agreements.columns.documentForm"),
              mono: true,
              // A badge, not a sentence: the column is narrow and the value is
              // one of two.
              render: (row) =>
                t(
                  row.documentForm === "ru_en"
                    ? "agreements.documentForm.badgeRuEn"
                    : "agreements.documentForm.badgeRu",
                ),
            },
            {
              key: "conclusionDate",
              title: t("agreements.columns.conclusionDate"),
              mono: true,
              render: (row) => row.conclusionDate ?? "—",
            },
            {
              key: "tenant",
              title: t("agreements.columns.tenant"),
              wrap: true,
              render: (row) => row.tenantId ?? t("agreements.list.noTenant"),
            },
          ]}
        />
      )}
    </section>
  );
}
