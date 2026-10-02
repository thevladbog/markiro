import { useEffect, useState } from "react";
import { Button, StatusChip } from "@markiro/ui";
import type { UsReadinessResult } from "@markiro/platform-contracts";
import { useTranslation } from "react-i18next";
import { UsClientError } from "../client.js";
import {
  sourceTarget,
  relatedSourceTarget,
  type ReadinessEventTarget,
} from "../readiness/source.js";
import type { LotCardPanelProps } from "./card-panels.js";
import { traceCivilDate } from "../trace/projection.js";

export function CardFindings({
  client,
  lotId,
  disabled,
  onOpenEvent,
  onOpenLot,
  onForbidden,
  onSessionLost,
}: LotCardPanelProps) {
  const { t, i18n } = useTranslation();
  const [result, setResult] = useState<UsReadinessResult | null>(null);
  const [pending, setPending] = useState(true);
  const [failed, setFailed] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    setPending(true);
    setFailed(false);
    setResult(null);
    void client
      .readReadiness({ lotId })
      .then((value) => {
        if (active) setResult(value);
      })
      .catch(async (error: unknown) => {
        if (!active) return;
        setFailed(true);
        if (error instanceof UsClientError && error.code === "session_required") onSessionLost();
        if (error instanceof UsClientError && error.code === "forbidden") await onForbidden();
      })
      .finally(() => {
        if (active) setPending(false);
      });
    return () => {
      active = false;
    };
  }, [client, lotId, refresh, onForbidden, onSessionLost]);
  const findings = result?.findings.filter((finding) => finding.lotId === lotId) ?? [];
  function eventAction(label: string, target: ReadinessEventTarget) {
    return onOpenEvent ? (
      <Button variant="secondary" disabled={disabled} onClick={() => onOpenEvent(target)}>
        {label}
      </Button>
    ) : (
      <span>{label}</span>
    );
  }
  return (
    <section
      className="us-lot-panel us-lot-card"
      aria-label={t("lots.cardFindings")}
      aria-busy={pending}
    >
      <div className="us-lot-basis-header">
        <h2>{t("lots.cardFindings")}</h2>
        <Button
          variant="secondary"
          disabled={pending || disabled}
          onClick={() => setRefresh((n) => n + 1)}
        >
          {t("lots.cardFindingsRefresh")}
        </Button>
      </div>
      {pending ? (
        <p role="status">{t("usReadiness.loading")}</p>
      ) : failed ? (
        <p role="alert">{t("lots.cardFindingsError")}</p>
      ) : result ? (
        <>
          <p className="us-lot-note">
            {t("lots.cardFindingsPeriod", {
              from: traceCivilDate(result.scope.eventDateFrom, i18n.language),
              to: traceCivilDate(result.scope.eventDateTo, i18n.language),
            })}
          </p>
          <p className="us-lot-note">{t("lots.cardFindingsHint")}</p>
          {findings.length === 0 ? (
            <p>{t("lots.cardFindingsEmpty")}</p>
          ) : (
            <ul className="us-lot-basis-list">
              {findings.map((finding) => {
                const event = sourceTarget(finding);
                const related = relatedSourceTarget(finding);
                return (
                  <li key={finding.key}>
                    <StatusChip
                      status={
                        finding.severity === "error"
                          ? "error"
                          : finding.severity === "warning"
                            ? "warn"
                            : "info"
                      }
                      label={t(`usReadiness.${finding.severity}Severity`)}
                    />
                    <span>
                      {t(`usReadiness.rules.${finding.code}`, {
                        defaultValue: t("usReadiness.reviewSource"),
                      })}{" "}
                      · {finding.field}
                    </span>
                    {event
                      ? eventAction(
                          t("usReadiness.event", {
                            number: finding.eventNumber,
                            revision: finding.revision,
                          }) +
                            (finding.lineSide && finding.lineNo
                              ? ` · ${t(`usReadiness.context${finding.lineSide}`, { number: finding.lineNo })}`
                              : ""),
                          event,
                        )
                      : null}
                    {onOpenLot ? (
                      <Button
                        variant="secondary"
                        disabled={disabled}
                        onClick={() => onOpenLot(lotId)}
                      >
                        {t("usReadiness.openLot")} {lotId}
                      </Button>
                    ) : null}
                    {related && finding.relatedEvent
                      ? eventAction(
                          t("usReadiness.relatedOrigin", {
                            number: finding.relatedEvent.eventNumber,
                            revision: related.revision,
                          }),
                          related,
                        )
                      : null}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      ) : null}
    </section>
  );
}
