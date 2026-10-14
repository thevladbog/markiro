import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import {
  Alert,
  Badge,
  Button,
  Card,
  DefinitionGrid,
  Table,
  type DefinitionGridItem,
  type TableColumn,
} from "@markiro/ui";

import type { OfficeLicense } from "../../host/protocol.js";
import { useCan } from "../access.js";
import { useBackupTime } from "../backups/backup-time.js";
import { officeKeys, useOfficeQuery } from "../office-query.js";
import { LoadError, PageLoading } from "../page-state.js";
import { copyText } from "./clipboard.js";
import { LicenseLoad } from "./license/LicenseLoad.js";
import {
  featureRows,
  licenseTerms,
  quotaRows,
  planText,
  shortLicenseId,
  stateText,
  stateTone,
  type QuotaRow,
} from "./license/license-view.js";

/**
 * «Лицензия» (license spec §9.2): the state the host computed, in words and
 * with the alert's glyph, the terms in the organization's zone, the seats
 * used of what the license gives, the features, and what binds the file to
 * this site. Every role reads it; the actions are the administrator's. A
 * host that does not answer is this section's error alone: the page stands.
 */
export function LicenseSection() {
  const { t } = useTranslation();
  const license = useOfficeQuery(officeKeys.license, (api, token) => api.getLicense(token));
  const time = useBackupTime(license.isSuccess);
  return (
    <Card title={t("office.about.license.title")} titleAs="h2">
      {license.isError ? (
        <LoadError error={license.error} onRetry={() => void license.refetch()} />
      ) : license.isSuccess && time.ready ? (
        <LicenseBody license={license.data} zone={time.zone} />
      ) : (
        <PageLoading />
      )}
    </Card>
  );
}

function LicenseBody({ license, zone }: { license: OfficeLicense; zone: string | null }) {
  const { t } = useTranslation();
  const admin = useCan("manageLicense");
  const state = stateText(license);
  return (
    <div className="standalone-form">
      <Alert
        className="license-state"
        tone={stateTone(license.state)}
        role="presentation"
        title={t(state.key, state.values ?? {})}
      >
        {licenseTerms(license, zone).map((term) => (
          <p key={term.key}>{t(term.key, term.values ?? {})}</p>
        ))}
      </Alert>
      {license.state === "inn_mismatch" && (
        <Alert tone="error" role="presentation">
          {t("office.about.license.innState", {
            orgInn: license.binding.orgInn ?? "—",
            fileInn: license.license?.customer.inn ?? "—",
          })}
        </Alert>
      )}
      {license.binding.orgInn === null && (
        <Alert tone="warn" role="presentation">
          {t("office.about.license.innNeeded")}{" "}
          <Link to="/org">{t("office.about.license.orgLink")}</Link>
        </Alert>
      )}
      <LicenseSeats rows={quotaRows(license)} />
      <LicenseFeatures license={license} />
      <LicenseBinding license={license} />
      {admin ? (
        <LicenseLoad license={license} zone={zone} />
      ) : (
        <p className="office-note">{t("office.about.license.readOnly")}</p>
      )}
      <p className="office-note">{t("office.about.license.keepFile")}</p>
    </div>
  );
}

/** «Рабочие места»: used and given by quota, «без ограничения» for none, a row over its limit in words. */
function LicenseSeats({ rows }: { rows: QuotaRow[] }) {
  const { t } = useTranslation();
  const columns: TableColumn<QuotaRow>[] = [
    {
      key: "what",
      title: t("office.about.license.seats.what"),
      render: (row) => t(`office.about.license.quotas.${row.key}`),
    },
    {
      key: "used",
      title: t("office.about.license.seats.used"),
      align: "right",
      mono: true,
      render: (row) => String(row.used),
    },
    {
      key: "limit",
      title: t("office.about.license.seats.limit"),
      align: "right",
      render: (row) =>
        row.limit === null ? t("office.about.license.seats.unlimited") : String(row.limit),
    },
    {
      key: "state",
      title: t("office.about.license.seats.state"),
      wrap: true,
      render: (row) =>
        row.over ? (
          <Badge tone="error" wrap>
            {t("office.about.license.seats.over")}
          </Badge>
        ) : (
          t("office.about.license.seats.fits")
        ),
    },
  ];
  return (
    <section className="license-part" aria-label={t("office.about.license.seats.title")}>
      <h3>{t("office.about.license.seats.title")}</h3>
      <Table
        columns={columns}
        rows={rows}
        getRowKey={(row) => row.key}
        empty={t("office.about.license.seats.empty")}
      />
      {rows.some((row) => row.over) && (
        <p className="office-note">{t("office.about.license.seats.overNote")}</p>
      )}
    </section>
  );
}

/** «Возможности»: each feature of the license with «включено» or «выключено» in words. */
function LicenseFeatures({ license }: { license: OfficeLicense }) {
  const { t } = useTranslation();
  return (
    <section className="license-part" aria-label={t("office.about.license.featuresTitle")}>
      <h3>{t("office.about.license.featuresTitle")}</h3>
      <ul className="license-features">
        {featureRows(license).map((row) => (
          <li key={row.key}>
            <span>{t(`office.about.license.features.${row.key}`)}</span>
            <Badge tone={row.on ? "ok" : "neutral"}>
              {t(row.on ? "office.about.license.features.on" : "office.about.license.features.off")}
            </Badge>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** «Организация и привязка»: the file's customer and INN, the site's INN, the host and the file. */
function LicenseBinding({ license }: { license: OfficeLicense }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState<"copied" | "failed" | null>(null);
  const file = license.license;
  const { orgInn, innMatches, hostId, fingerprint } = license.binding;
  const items: DefinitionGridItem[] = [];
  if (file !== null) {
    items.push(
      {
        id: "customer",
        term: t("office.about.license.binding.customer"),
        description: file.customer.name,
      },
      {
        id: "fileInn",
        term: t("office.about.license.binding.fileInn"),
        description: file.customer.inn,
        mono: true,
      },
    );
  }
  items.push(
    {
      id: "orgInn",
      term: t("office.about.license.binding.orgInn"),
      description:
        orgInn === null
          ? t("office.about.license.binding.innMissing")
          : innMatches === false
            ? t("office.about.license.binding.innDiffers", { inn: orgInn })
            : innMatches === true
              ? t("office.about.license.binding.innMatches", { inn: orgInn })
              : orgInn,
    },
    {
      id: "hostId",
      term: t("office.about.license.binding.hostId"),
      description: hostId,
      mono: true,
    },
    {
      id: "fingerprint",
      term: t("office.about.license.binding.fingerprint"),
      description: fingerprint,
      mono: true,
    },
    {
      id: "file",
      term: t("office.about.license.binding.file"),
      description:
        file === null
          ? t("office.about.license.binding.noFile")
          : t("office.about.license.binding.fileValue", {
              sequence: file.sequence,
              id: shortLicenseId(file.licenseId),
            }),
    },
  );
  if (file !== null) {
    const plan = planText(file.plan);
    items.push({
      id: "plan",
      term: t("office.about.license.binding.plan"),
      description: t(plan.key, plan.values ?? {}),
    });
  }
  const copy = async () => {
    setCopied(null);
    setCopied((await copyText(hostId)) ? "copied" : "failed");
  };
  return (
    <section className="license-part" aria-label={t("office.about.license.binding.title")}>
      <h3>{t("office.about.license.binding.title")}</h3>
      <DefinitionGrid items={items} />
      <div className="standalone-form__actions">
        <Button variant="secondary" size="compact" onClick={() => void copy()}>
          {t("office.about.license.copyHostId")}
        </Button>
      </div>
      <div aria-live="polite">
        {copied === "copied" && (
          <Alert tone="ok" role="presentation">
            {t("office.about.license.copied")}
          </Alert>
        )}
        {copied === "failed" && (
          <Alert tone="warn" role="presentation">
            {t("office.about.license.copyFailed")}
          </Alert>
        )}
      </div>
    </section>
  );
}
