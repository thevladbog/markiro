import { useEffect, useRef, useState } from "react";
import { Button } from "@markiro/ui";
import type { UsLotCardEvidencePage } from "@markiro/platform-contracts";
import { useTranslation } from "react-i18next";
import { UsClientError } from "../client.js";
import type { ReadinessEventTarget } from "../readiness/source.js";
import type { LotCardPanelProps } from "./card-panels.js";
import { traceCivilDate } from "../trace/projection.js";

export function LotCardEvidence({
  client,
  lotId,
  disabled,
  onOpenEvent,
  onForbidden,
  onSessionLost,
}: LotCardPanelProps) {
  const { t, i18n } = useTranslation();
  const [page, setPage] = useState<UsLotCardEvidencePage | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [pending, setPending] = useState(true);
  const [failed, setFailed] = useState(false);
  const token = useRef(0);
  useEffect(() => {
    const request = ++token.current;
    setPending(true);
    setFailed(false);
    setPage(null);
    void client
      .listLotCardEvidence(lotId, { limit: "20", ...(cursor === null ? {} : { cursor }) })
      .then((value) => {
        if (request === token.current) setPage(value);
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
  }, [client, lotId, cursor, refresh, onForbidden, onSessionLost]);
  function action(label: string, target: ReadinessEventTarget) {
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
      aria-label={t("lots.cardEvidence")}
      aria-busy={pending}
    >
      <div className="us-lot-basis-header">
        <h2>{t("lots.cardEvidence")}</h2>
        <Button
          variant="secondary"
          disabled={pending || disabled}
          onClick={() => {
            setCursor(null);
            setRefresh((n) => n + 1);
          }}
        >
          {t("lots.cardEvidenceRefresh")}
        </Button>
      </div>
      <p className="us-lot-note">{t("lots.cardEvidenceHint")}</p>
      {pending ? (
        <p role="status">{t("lots.cardEvidenceLoading")}</p>
      ) : failed ? (
        <p role="alert">{t("lots.cardEvidenceError")}</p>
      ) : page ? (
        <>
          {page.items.length === 0 ? (
            <p>{t("lots.cardEvidenceEmpty")}</p>
          ) : (
            page.items.map((item) => (
              <article key={item.eventId}>
                <h3>
                  {item.eventNumber} · {traceCivilDate(item.eventDate, i18n.language)} ·{" "}
                  {item.timeZone}
                </h3>
                <ul className="us-lot-basis-list">
                  {item.lines.map((line) => (
                    <li key={`${line.kind}/${line.lineNo}`}>
                      {action(
                        `${item.eventNumber} · ${t("lots.cardRevision", { revision: item.revision, line: line.lineNo })}`,
                        {
                          type: item.type,
                          eventId: item.eventId,
                          revision: item.revision,
                          lineSide:
                            line.kind === "transformation_input"
                              ? "inputs"
                              : line.kind === "transformation_output"
                                ? "outputs"
                                : "items",
                          lineNo: line.lineNo,
                        },
                      )}
                      <span>
                        {line.kind === "transformation_input"
                          ? `${t("lots.cardInput")} · `
                          : line.kind === "transformation_output"
                            ? `${t("lots.cardOutput")} · `
                            : ""}
                        {line.quantity} {line.unitOfMeasure}
                      </span>
                      {line.originProduct ? (
                        <span>
                          {line.originProduct.kind === "receiving"
                            ? line.originProduct.description.productName
                            : line.originProduct.description}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
                <ul className="us-lot-basis-list">
                  {item.documents.map((document) => (
                    <li key={document.documentId}>
                      {action(`${document.type} · ${document.number} · ${item.eventNumber}`, {
                        type: item.type,
                        eventId: item.eventId,
                        revision: item.revision,
                        lineSide: null,
                        lineNo: null,
                      })}
                    </li>
                  ))}
                </ul>
              </article>
            ))
          )}
          {page.nextCursor ? (
            <Button
              variant="secondary"
              disabled={disabled}
              onClick={() => setCursor(page.nextCursor)}
            >
              {t("lots.cardEvidenceNext")}
            </Button>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
