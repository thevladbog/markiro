import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import { StatusChip, type TagPhase } from "@markiro/ui";

import { backupWarnings } from "../backups/backup-warnings.js";
import { formatWhen } from "../backups/backup-format.js";
import { lastMomentBefore, licenseDay } from "../../lib/license-dates.js";
import { licenseTerms, stateText, stateTone } from "../info/license/license-view.js";
import { OfficeIcon, type OfficeIconName } from "../OfficeIcon.js";
import { Skel } from "./blocks.js";
import { deviceSummary } from "./overview-model.js";
import { relateToToday } from "./overview-time.js";
import type { OverviewData } from "./use-overview-data.js";

interface RowProps {
  icon: OfficeIconName;
  label: string;
  fact: string;
  to: string;
  chip: { phase: TagPhase; label: string } | null;
  loading?: boolean;
}

function Row({ icon, label, fact, to, chip, loading = false }: RowProps) {
  return (
    <li className="ov-sys__row">
      <Link className="ov-sys__link" to={to}>
        <span className="ov-sys__icon">
          <OfficeIcon name={icon} size={20} />
        </span>
        <span className="ov-sys__text">
          <strong>{label}</strong>
          {loading ? <Skel className="ov-skel--line" /> : <span>{fact}</span>}
        </span>
        {loading ? (
          <Skel className="ov-skel--chip" />
        ) : (
          chip !== null && <StatusChip phase={chip.phase} label={chip.label} />
        )}
      </Link>
    </li>
  );
}

/**
 * «Состояние системы»: the steady state of devices (administrators), copies and license, one row
 * each with a chip that says it in a word. The exceptions among them are «Требует внимания».
 */
export function SystemPanel({ data }: { data: OverviewData }): ReactNode {
  const { t } = useTranslation();
  const title = t("office.overview.system.title");
  const rows: ReactNode[] = [];
  const whenText = (instant: string): string => {
    const relation = relateToToday(new Date(instant), data.zone, data.today);
    return relation.day === "other"
      ? formatWhen(instant, data.zone)
      : t(`office.overview.system.${relation.day}At`, { time: relation.hm });
  };

  if (data.admin) {
    const noData = t("office.overview.system.noData");
    let fact = t("office.overview.system.noDataFact");
    let chip: RowProps["chip"] = { phase: "none", label: noData };
    const loading = data.devices.isPending;
    if (data.devices.data !== undefined && !data.hostDown) {
      const summary = deviceSummary(data.devices.data, data.nowMs);
      const total = Object.values(summary.byKind).reduce((sum, kind) => sum + kind.total, 0);
      const online = Object.values(summary.byKind).reduce((sum, kind) => sum + kind.online, 0);
      if (total === 0) {
        fact = t("office.overview.system.devicesNone");
        chip = null;
      } else {
        fact = t("office.overview.system.devicesFact", { online, total });
        chip =
          summary.silent.length === 0
            ? { phase: "done", label: t("office.overview.system.devicesAllOnline") }
            : {
                phase: "attention",
                label: t("office.overview.system.devicesSilent", { count: summary.silent.length }),
              };
      }
    } else if (data.devices.isError && data.devices.data === undefined) {
      fact = t("office.overview.system.errorFact");
    }
    rows.push(
      <Row
        key="devices"
        icon="monitor"
        label={t("office.overview.system.devices")}
        fact={fact}
        to="/devices"
        chip={chip}
        loading={loading}
      />,
    );
  }

  {
    let fact = t("office.overview.system.noDataFact");
    let chip: RowProps["chip"] = { phase: "none", label: t("office.overview.system.noData") };
    const state = data.backups.data;
    if (state !== undefined) {
      const newest = [state.local.copies[0], state.second?.copies[0]]
        .filter((copy) => copy !== undefined)
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
      const copies = state.local.copies.length + (state.second?.copies.length ?? 0);
      fact =
        newest === undefined
          ? t("office.overview.system.backupsNone")
          : t("office.overview.system.backupsLast", {
              when: whenText(newest.createdAt),
              count: copies,
            });
      if (!data.hostDown) {
        chip =
          backupWarnings(state).length === 0
            ? { phase: "done", label: t("office.overview.system.backupsOk") }
            : { phase: "attention", label: t("office.overview.system.backupsWarn") };
      }
    } else if (data.backups.isError) {
      fact = t("office.overview.system.errorFact");
    }
    rows.push(
      <Row
        key="backups"
        icon="database"
        label={t("office.overview.system.backups")}
        fact={fact}
        to="/backups"
        chip={chip}
        loading={data.backups.isPending}
      />,
    );
  }

  {
    let fact = t("office.overview.system.noDataFact");
    let chip: RowProps["chip"] = { phase: "none", label: t("office.overview.system.noData") };
    const license = data.license.data;
    if (license !== undefined) {
      const tone = stateTone(license.state);
      const text = stateText(license);
      const term = licenseTerms(license, data.zone)[0];
      const file = license.license;
      // A running subscription is «Действует до …» in the row's own few words; any other state
      // says what the license section says (it may take a second line).
      if ((license.state === "active" || license.state === "expiring") && file !== null) {
        fact = t("office.overview.system.licenseUntil", {
          date: licenseDay(lastMomentBefore(file.validUntil), data.zone),
        });
      } else {
        fact =
          term === undefined || tone === "error"
            ? t(text.key, text.values ?? {})
            : t(term.key, term.values ?? {});
      }
      if (tone === "ok") {
        chip = {
          phase: "done",
          label:
            license.license?.plan === "demo"
              ? t("office.overview.system.licenseDemo")
              : t("office.overview.system.licenseOk"),
        };
      } else if (tone === "info") {
        chip = { phase: "planned", label: t("office.overview.system.licenseTrial") };
      } else if (tone === "warn") {
        chip = {
          phase: "attention",
          label:
            license.state === "expiring" && license.daysLeft !== null
              ? t("office.overview.system.licenseDays", { count: license.daysLeft })
              : t("office.overview.system.licenseWarn"),
        };
      } else {
        chip = { phase: "failed", label: t("office.overview.system.licenseErr") };
      }
    } else if (data.license.isError) {
      fact = t("office.overview.system.errorFact");
    }
    rows.push(
      <Row
        key="license"
        icon="key"
        label={t("office.overview.system.license")}
        fact={fact}
        to="/about#license"
        chip={chip}
        loading={data.license.isPending}
      />,
    );
  }

  return (
    <section className="ov-panel ov-sys" aria-label={title}>
      <h2 className="ov-visually-hidden">{title}</h2>
      <ul className="ov-sys__list">{rows}</ul>
    </section>
  );
}
