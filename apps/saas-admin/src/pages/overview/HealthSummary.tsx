import type { TFunction } from "i18next";

import { StatusChip, type TagPhase } from "@markiro/ui";
import type { PlatformHealth } from "@markiro/platform-contracts";

const COMPONENTS = ["database", "jobs", "smtp", "storage"] as const;

/**
 * Фактический union — `platformHealthSchema["status"]`
 * (`packages/platform-contracts/src/operations.ts`): `ok` | `degraded` |
 * `unavailable`. `ok` — платформа сейчас исправна (`active`, по образцу
 * «канал работает»), `unavailable` — система недоступна, системный сбой
 * (`failed`), а не вывод из оборота человеком.
 */
function healthStatusPhase(status: PlatformHealth["status"]): TagPhase {
  switch (status) {
    case "ok":
      return "active";
    case "degraded":
      return "attention";
    case "unavailable":
      return "failed";
  }
}

export function HealthSummary({ health, t }: { health: PlatformHealth; t: TFunction }) {
  return (
    <div className="health-summary">
      <div className="health-summary__headline">
        <StatusChip
          phase={healthStatusPhase(health.status)}
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
