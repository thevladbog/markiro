import type { TFunction } from "i18next";

import { StatusChip } from "@markiro/ui";
import type { PlatformHealth } from "@markiro/platform-contracts";

const COMPONENTS = ["database", "jobs", "smtp", "storage"] as const;

export function HealthSummary({ health, t }: { health: PlatformHealth; t: TFunction }) {
  return (
    <div className="health-summary">
      <div className="health-summary__headline">
        <StatusChip
          status={health.status === "ok" ? "ok" : health.status === "degraded" ? "warn" : "error"}
          label={t(`overview.health.status.${health.status}`)}
        />
        <span>
          {t("overview.health.checkedAt", {
            value: new Date(health.checkedAt).toLocaleTimeString(),
          })}
        </span>
      </div>
      <dl className="health-summary__components">
        {COMPONENTS.map((component) => {
          const check = health.checks[component];
          return (
            <div key={component}>
              <dt>{t(`overview.health.components.${component}`)}</dt>
              <dd>
                {check.category
                  ? t(`overview.health.categories.${check.category}`)
                  : t(`overview.health.componentStatus.${check.status}`)}
              </dd>
            </div>
          );
        })}
        <div>
          <dt>DaData</dt>
          <dd>{t(`overview.health.dadata.${health.integrations.dadata.status}`)}</dd>
        </div>
      </dl>
    </div>
  );
}
