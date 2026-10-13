import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Alert, Button, Modal, Table, type TableColumn } from "@markiro/ui";
import type { StandaloneIssuanceSummary, StandaloneSite } from "@markiro/platform-contracts";

import { downloadStandaloneLicense, getStandaloneIssuances } from "./standalone-api.js";
import { saveLicenseFile } from "./standalone-download.js";
import { standaloneSitesKey, useStandaloneDate } from "./standalone-format.js";

export function StandaloneIssuanceHistory({
  tenantId,
  site,
  onClose,
}: {
  tenantId: string;
  site: StandaloneSite;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const formatDate = useStandaloneDate();
  const query = useQuery({
    queryKey: [...standaloneSitesKey(tenantId), site.id, "issuances"],
    queryFn: () => getStandaloneIssuances(tenantId, site.id),
  });
  const download = useMutation({
    mutationFn: (licenseId: string) => downloadStandaloneLicense(tenantId, site.id, licenseId),
    onSuccess: (file) => saveLicenseFile(file.fileName, file.compact),
  });
  const columns: TableColumn<StandaloneIssuanceSummary>[] = [
    {
      key: "sequence",
      title: t("tenants.detail.standalone.history.sequence"),
      mono: true,
      render: (row) => row.sequence,
    },
    {
      key: "plan",
      title: t("tenants.detail.standalone.history.plan"),
      render: (row) => t(`tenants.detail.standalone.plan.${row.plan}`),
    },
    {
      key: "validUntil",
      title: t("tenants.detail.standalone.history.validUntil"),
      render: (row) => formatDate(row.validUntil),
    },
    {
      key: "graceDays",
      title: t("tenants.detail.standalone.history.graceDays"),
      mono: true,
      render: (row) => row.graceDays,
    },
    {
      key: "kid",
      title: t("tenants.detail.standalone.history.kid"),
      mono: true,
      render: (row) => row.kid,
    },
    {
      key: "sha256",
      title: t("tenants.detail.standalone.history.sha256"),
      mono: true,
      render: (row) => row.sha256.slice(0, 12),
    },
    {
      key: "download",
      title: t("tenants.detail.standalone.history.download"),
      render: (row) => (
        <Button
          variant="secondary"
          size="compact"
          aria-label={t("tenants.detail.standalone.history.downloadLabel", {
            sequence: row.sequence,
          })}
          disabled={download.isPending}
          onClick={() => download.mutate(row.licenseId)}
        >
          {t("tenants.detail.standalone.history.download")}
        </Button>
      ),
    },
  ];
  return (
    <Modal
      open
      title={t("tenants.detail.standalone.history.title", { name: site.name })}
      onClose={onClose}
      closeLabel={t("tenants.detail.standalone.history.close")}
    >
      {download.isError ? (
        <Alert tone="error" role="alert">
          {t("tenants.detail.standalone.history.downloadError")}
        </Alert>
      ) : null}
      {query.isPending ? (
        <p role="status">{t("tenants.detail.standalone.loading")}</p>
      ) : !query.data ? (
        <Alert tone="error" role="alert">
          {t("tenants.detail.standalone.loadError")}
        </Alert>
      ) : (
        <Table
          columns={columns}
          rows={query.data.items}
          getRowKey={(row) => row.licenseId}
          empty={t("tenants.detail.standalone.history.empty")}
          scrollLabel={t("tenants.detail.standalone.history.scrollLabel")}
        />
      )}
    </Modal>
  );
}
