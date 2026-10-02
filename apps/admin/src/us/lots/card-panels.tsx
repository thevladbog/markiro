import { useEffect, useRef, useState } from "react";
import { Button } from "@markiro/ui";
import type { UsLotCard } from "@markiro/platform-contracts";
import { useTranslation } from "react-i18next";
import { UsClientError, type UsBrowserClient } from "../client.js";
import type { ReadinessEventTarget } from "../readiness/source.js";
import { traceCivilDate } from "../trace/projection.js";
import { LotCardEvidence } from "./card-evidence.js";
import { CardFindings } from "./card-findings.js";
import { CardHistory } from "./card-history.js";

export type LotCardPanelProps = {
  client: UsBrowserClient;
  lotId: string;
  disabled?: boolean;
  onOpenEvent?: (target: ReadinessEventTarget) => void;
  onOpenLot?: (lotId: string) => void;
  onOpenTrace?: (direction: "backward" | "forward") => void;
  onForbidden: () => Promise<void>;
  onSessionLost: () => void;
};

export function LotCardPanels(props: LotCardPanelProps) {
  // A lot change immediately unmounts all readers, including cursor state and old facts.
  return <LotCardReaders key={props.lotId} {...props} />;
}

function LotCardReaders(props: LotCardPanelProps) {
  const { client, lotId, disabled, onOpenTrace, onForbidden, onSessionLost } = props;
  const { t, i18n } = useTranslation();
  const [card, setCard] = useState<UsLotCard | null>(null);
  const [pending, setPending] = useState(true);
  const [failed, setFailed] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const token = useRef(0);
  useEffect(() => {
    const request = ++token.current;
    setPending(true);
    setFailed(false);
    setCard(null);
    void client
      .getLotCard(lotId)
      .then((value) => {
        if (request === token.current) setCard(value);
      })
      .catch(async (error: unknown) => {
        if (request !== token.current) return;
        setFailed(true);
        if (error instanceof UsClientError && error.code === "session_required") onSessionLost();
        if (error instanceof UsClientError && error.code === "forbidden") await onForbidden();
      })
      .finally(() => {
        if (request === token.current) setPending(false);
      });
    return () => {
      token.current = request + 1;
    };
  }, [client, lotId, refresh, onForbidden, onSessionLost]);
  return (
    <>
      <section
        className="us-lot-panel us-lot-card"
        aria-label={t("lots.cardTitle")}
        aria-busy={pending}
      >
        <div className="us-lot-basis-header">
          <h2>{t("lots.cardTitle")}</h2>
          <Button
            variant="secondary"
            disabled={pending || disabled}
            onClick={() => setRefresh((n) => n + 1)}
          >
            {t("lots.cardRefresh")}
          </Button>
        </div>
        <p className="us-lot-note">{t("lots.cardHint")}</p>
        {pending ? (
          <p role="status">{t("lots.cardLoading")}</p>
        ) : failed ? (
          <p role="alert">{t("lots.cardError")}</p>
        ) : card ? (
          <>
            <dl className="us-lot-facts">
              <div>
                <dt>{t("lots.tlc")}</dt>
                <dd>{card.lot.tlc}</dd>
              </div>
              <div>
                <dt>{t("lots.source")}</dt>
                <dd>
                  {card.lot.source === null
                    ? t("lots.absent")
                    : card.lot.source.kind === "location"
                      ? card.lot.source.locationId
                      : card.lot.source.referenceValue}
                </dd>
              </div>
              <div>
                <dt>{t("lots.cardMaster")}</dt>
                <dd>{card.currentMasterProduct?.name ?? t("lots.absent")}</dd>
              </div>
              <div>
                <dt>{t("lots.cardBalance")}</dt>
                <dd>
                  {card.balance.state === "known" ? (
                    <>
                      <span>
                        {card.balance.remaining} {card.balance.unitOfMeasure}
                      </span>
                      <p>
                        {t("lots.cardSupply", {
                          supply: card.balance.supply,
                          used: card.balance.used,
                          uom: card.balance.unitOfMeasure,
                        })}
                      </p>
                    </>
                  ) : (
                    t("lots.cardUnknown", {
                      reason: t(`lots.balanceReasons.${card.balance.reason}`),
                    })
                  )}
                </dd>
              </div>
              <div>
                <dt>{t("lots.cardCases")}</dt>
                <dd>
                  {t("lots.cardCaseCount", {
                    active: card.caseSummary.activeCount,
                    historical: card.caseSummary.historicalCount,
                  })}
                </dd>
              </div>
              <div>
                <dt>{t("lots.cardCtes")}</dt>
                <dd>
                  {card.currentCteCount} ·{" "}
                  {card.firstEventDate ? traceCivilDate(card.firstEventDate, i18n.language) : "—"} –{" "}
                  {card.lastEventDate ? traceCivilDate(card.lastEventDate, i18n.language) : "—"}
                </dd>
              </div>
            </dl>
            <h3>{t("lots.cardOrigins")}</h3>
            {card.originState === "gap" ? (
              <p role="status">{t("lots.cardGap")}</p>
            ) : (
              <ul className="us-lot-basis-list">
                {card.currentOriginProducts.map((origin) => (
                  <li key={`${origin.eventId}/${origin.lineNo}`}>
                    <span>
                      {origin.kind === "receiving"
                        ? origin.description.productName
                        : origin.description}
                    </span>
                    <span>
                      {traceCivilDate(origin.eventDate, i18n.language)} ·{" "}
                      {t("lots.cardRevision", { revision: origin.revision, line: origin.lineNo })}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {card.moreCurrentOriginProducts ? (
              <p role="status">
                {t("lots.cardMoreOrigins", {
                  shown: card.currentOriginProducts.length,
                  total: card.currentOriginProductCount,
                })}
              </p>
            ) : null}
          </>
        ) : null}
        {onOpenTrace ? (
          <div className="us-lot-actions">
            {(["backward", "forward"] as const).map((direction) => (
              <Button
                key={direction}
                variant="secondary"
                disabled={disabled}
                onClick={() => onOpenTrace(direction)}
              >
                {t(`lots.cardTrace.${direction}`)}
              </Button>
            ))}
          </div>
        ) : null}
      </section>
      <LotCardEvidence {...props} />
      <CardFindings {...props} />
      <CardHistory {...props} />
    </>
  );
}
