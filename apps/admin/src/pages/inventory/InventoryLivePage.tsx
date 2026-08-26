import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import { CABINET_CAPABILITY } from "@markiro/domain";
import { AdminPage, Alert, Card, Spinner, StatusChip } from "@markiro/ui";

import { useCan } from "../../access/context.js";
import { useInventoryProgress } from "./api.js";
import type { InventoryDetail } from "./schemas.js";

function formatCount(value: number, locale: string): string {
  return new Intl.NumberFormat(locale).format(value);
}

export function InventoryLivePage({ inventory }: { inventory: InventoryDetail }) {
  const { t, i18n } = useTranslation();
  const canCorrect = useCan(CABINET_CAPABILITY.OPERATIONS_WRITE);
  const progress = useInventoryProgress(inventory.id);

  if (progress.isPending) {
    return (
      <div className="mk-inventory-centered">
        <Spinner label={t("pages.inventory.live.loading")} />
      </div>
    );
  }

  if (progress.isError || !progress.data) {
    return (
      <AdminPage className="mk-inventory-page">
        <Alert tone="error">{t("pages.inventory.live.loadError")}</Alert>
      </AdminPage>
    );
  }

  const data = progress.data;

  return (
    <AdminPage className="mk-inventory-page mk-inventory-live">
      <header className="mk-inventory-live__header">
        <div>
          <h1>{t("pages.inventory.live.title", { number: inventory.number })}</h1>
          <p className="mk-inventory-page__description">
            {inventory.productName} · {inventory.lineName}
          </p>
        </div>
        <div className="mk-inventory-live__actions">
          <StatusChip
            status={data.status === "running" ? "ok" : "neutral"}
            label={t(`pages.inventory.status.${data.status}`)}
          />
          {canCorrect && data.status === "running" ? (
            <Link className="mk-inventory-action-link" to="corrections">
              {t("pages.inventory.live.corrections")}
            </Link>
          ) : null}
        </div>
      </header>

      <section
        className="mk-inventory-live__metrics"
        aria-label={t("pages.inventory.live.summary")}
      >
        <LiveMetric
          label={t("pages.inventory.live.expected")}
          value={formatCount(data.expectedCount, i18n.language)}
        />
        <LiveMetric
          label={t("pages.inventory.live.verified")}
          value={formatCount(data.verifiedCount, i18n.language)}
          tone="ok"
        />
        <LiveMetric
          label={t("pages.inventory.live.missing")}
          value={formatCount(data.missingCount, i18n.language)}
          tone="warn"
        />
        <LiveMetric
          label={t("pages.inventory.live.discrepancies")}
          value={formatCount(
            data.ineligibleCount + data.unknownCount + data.dateMismatchCount,
            i18n.language,
          )}
          tone="error"
        />
      </section>

      {data.pendingEventCount > 0 ? (
        <Alert tone="info">
          {t("pages.inventory.live.pending", { count: data.pendingEventCount })}
        </Alert>
      ) : null}

      <div className="mk-inventory-live__columns">
        <Card title={t("pages.inventory.live.participants")} titleAs="h2">
          {data.participants.length === 0 ? (
            <p className="mk-inventory-section-description">{t("pages.inventory.live.none")}</p>
          ) : (
            <ul className="mk-inventory-evidence-list">
              {data.participants.map((participant) => (
                <li key={participant.deviceId}>
                  <span>
                    <strong>{participant.terminalName}</strong>
                    <small>{participant.operatorName}</small>
                  </span>
                  <span className="mk-inventory-evidence-list__state">
                    <StatusChip
                      status={
                        participant.state === "active"
                          ? "ok"
                          : participant.state === "stale"
                            ? "warn"
                            : "neutral"
                      }
                      label={t(`pages.inventory.live.participantState.${participant.state}`)}
                    />
                    {participant.pendingEventCount > 0 ? (
                      <small>
                        {t("pages.inventory.live.localPending", {
                          count: participant.pendingEventCount,
                        })}
                      </small>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title={t("pages.inventory.live.boxes")} titleAs="h2">
          {data.boxes.length === 0 ? (
            <p className="mk-inventory-section-description">{t("pages.inventory.live.none")}</p>
          ) : (
            <ul className="mk-inventory-evidence-list">
              {data.boxes.map((box) => (
                <li key={box.id}>
                  <span>
                    <strong className="mk-inventory-mono">{box.sscc}</strong>
                    <small>{box.terminalName}</small>
                  </span>
                  <span className="mk-inventory-evidence-list__state">
                    <StatusChip
                      status={box.state === "invalidated" ? "error" : "info"}
                      label={t(`pages.inventory.live.boxState.${box.state}`)}
                    />
                    <small>{t("pages.inventory.live.items", { count: box.itemCount })}</small>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card title={t("pages.inventory.live.recentEvents")} titleAs="h2">
        {data.recentEvents.length === 0 ? (
          <p className="mk-inventory-section-description">{t("pages.inventory.live.none")}</p>
        ) : (
          <ul className="mk-inventory-evidence-list">
            {data.recentEvents.map((event) => (
              <li key={event.eventId}>
                <span>
                  <strong className="mk-inventory-mono">{event.displayIdentity}</strong>
                  <small>{event.terminalName}</small>
                </span>
                <StatusChip
                  status={event.classification === "expected" ? "ok" : "warn"}
                  label={
                    event.classification
                      ? t(`pages.inventory.live.classification.${event.classification}`)
                      : event.authoritativeVerdict
                  }
                />
              </li>
            ))}
          </ul>
        )}
      </Card>
    </AdminPage>
  );
}

function LiveMetric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "ok" | "warn" | "error";
}) {
  return (
    <div
      className={
        tone
          ? `mk-inventory-live-metric mk-inventory-live-metric--${tone}`
          : "mk-inventory-live-metric"
      }
    >
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
