import { useEffect, useRef, useState } from "react";
import { Button } from "@markiro/ui";
import type { TransformationGenealogyResult } from "@markiro/platform-contracts";
import { useTranslation } from "react-i18next";
import { UsClientError, type UsBrowserClient } from "../client.js";

type Props = {
  client: UsBrowserClient;
  lotId: string;
  evidenceVersion?: string;
  pinnedRevisionId?: string;
  disabled?: boolean;
  onForbidden: () => Promise<void>;
  onSessionLost: () => void;
  onCurrentOrigin?: (eventId: string | null, state: "current" | "gap" | "unknown") => void;
};

/** Use only a complete, server-selected current graph as corroboration for a lot-origin link. */
export function corroboratedCurrentOrigin(value: TransformationGenealogyResult): string | null {
  if (value.mode !== "current" || !value.complete || value.diagnostics.length) return null;
  if (!value.lots.some((lot) => lot.id === value.startLotId && lot.currentOrigin)) return null;
  const origins = value.events.filter(
    (event) =>
      event.status === "finalized" &&
      value.selectedRevisionIds.includes(event.id) &&
      event.snapshot?.outputs.some((output) => output.lotId === value.startLotId),
  );
  return origins.length === 1 ? origins[0]!.id : null;
}

export function TransformationGenealogyPanel({
  client,
  lotId,
  evidenceVersion = "",
  pinnedRevisionId,
  disabled = false,
  onForbidden,
  onSessionLost,
  onCurrentOrigin,
}: Props) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<"current" | "pinned">("current");
  const [direction, setDirection] = useState<"upstream" | "downstream">("upstream");
  const [result, setValue] = useState<TransformationGenealogyResult | null>(null);
  const [loadedVersion, setLoadedVersion] = useState<string | null>(null);
  const value = loadedVersion === evidenceVersion ? result : null;
  const [pending, setPending] = useState(true);
  const [failed, setFailed] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const run = useRef(0);
  const originCallback = useRef(onCurrentOrigin);
  originCallback.current = onCurrentOrigin;

  useEffect(() => {
    const current = ++run.current;
    setPending(true);
    setFailed(false);
    setValue(null);
    originCallback.current?.(null, "unknown");
    void client
      .queryTransformationGenealogy({
        startLotId: lotId,
        direction,
        maxDepth: 4,
        maxNodes: 100,
        ...(mode === "pinned" && pinnedRevisionId
          ? { mode: "pinned" as const, pinnedRevisionIds: [pinnedRevisionId] }
          : { mode: "current" as const }),
      })
      .then((result) => {
        if (run.current !== current) return;
        setValue(result);
        setLoadedVersion(evidenceVersion);
        if (mode === "current" && direction === "upstream") {
          const eventId = corroboratedCurrentOrigin(result);
          const lot = result.lots.find((item) => item.id === lotId);
          const gap =
            !lot?.currentOrigin ||
            result.diagnostics.some((item) => item.code === "origin_gap" && item.lotId === lotId);
          originCallback.current?.(eventId, eventId ? "current" : gap ? "gap" : "unknown");
        }
      })
      .catch(async (error: unknown) => {
        if (run.current !== current) return;
        setFailed(true);
        if (error instanceof UsClientError && error.code === "session_required") onSessionLost();
        if (error instanceof UsClientError && error.code === "forbidden") await onForbidden();
      })
      .finally(() => {
        if (run.current === current) setPending(false);
      });
    return () => {
      run.current += 1;
    };
  }, [
    client,
    lotId,
    evidenceVersion,
    mode,
    direction,
    pinnedRevisionId,
    refresh,
    onForbidden,
    onSessionLost,
  ]);

  return (
    <section
      className="us-tr-section"
      aria-label={t("transformation.genealogy.title")}
      aria-busy={pending}
    >
      <h2>{t("transformation.genealogy.title")}</h2>
      <p className="us-tr-hint">{t("transformation.genealogy.hint")}</p>
      <div
        className="us-tr-actions"
        role="group"
        aria-label={t("transformation.genealogy.revisionMode")}
      >
        <Button
          type="button"
          variant={mode === "current" ? "primary" : "secondary"}
          aria-pressed={mode === "current"}
          disabled={disabled || pending}
          onClick={() => setMode("current")}
        >
          {t("transformation.genealogy.current")}
        </Button>
        {pinnedRevisionId ? (
          <Button
            type="button"
            variant={mode === "pinned" ? "primary" : "secondary"}
            aria-pressed={mode === "pinned"}
            disabled={disabled || pending}
            onClick={() => setMode("pinned")}
          >
            {t("transformation.genealogy.pinned")}
          </Button>
        ) : null}
      </div>
      <div
        className="us-tr-actions"
        role="group"
        aria-label={t("transformation.genealogy.directionMode")}
      >
        <Button
          type="button"
          variant={direction === "upstream" ? "primary" : "secondary"}
          aria-pressed={direction === "upstream"}
          disabled={disabled || pending}
          onClick={() => setDirection("upstream")}
        >
          {t("transformation.genealogy.showUpstream")}
        </Button>
        <Button
          type="button"
          variant={direction === "downstream" ? "primary" : "secondary"}
          aria-pressed={direction === "downstream"}
          disabled={disabled || pending}
          onClick={() => setDirection("downstream")}
        >
          {t("transformation.genealogy.showDownstream")}
        </Button>
      </div>
      <div className="us-tr-actions">
        <Button
          type="button"
          variant="secondary"
          disabled={disabled || pending}
          onClick={() => setRefresh((n) => n + 1)}
        >
          {t("transformation.genealogy.reload")}
        </Button>
      </div>
      {pending ? <p role="status">{t("transformation.genealogy.loading")}</p> : null}
      {failed ? <p role="alert">{t("transformation.genealogy.failed")}</p> : null}
      {value ? (
        <>
          {mode === "pinned" ? <p>{t("transformation.genealogy.pinnedEvidence")}</p> : null}
          <p role="status">
            {t(
              value.complete
                ? "transformation.genealogy.complete"
                : "transformation.genealogy.incomplete",
            )}
          </p>
          <p>
            {t("transformation.genealogy.counts", {
              lots: value.lots.length,
              events: value.events.length,
              links: value.links.length,
            })}
          </p>
          {value.diagnostics.length ? (
            <ul aria-label={t("transformation.genealogy.diagnostics")}>
              {value.diagnostics.map((item, index) => (
                <li key={`${item.code}-${item.lotId ?? item.eventId ?? index}`}>
                  {t(`transformation.genealogy.${item.code}`)}
                  {item.lotId ? ` · ${item.lotId}` : item.eventId ? ` · ${item.eventId}` : ""}
                </li>
              ))}
            </ul>
          ) : null}
          {value.balance.state === "arithmetic" ? (
            <p>
              {t("transformation.genealogy.balance", {
                input: value.balance.inputQuantity,
                output: value.balance.outputQuantity,
                delta: value.balance.deltaQuantity,
                unit: value.balance.unitOfMeasure,
              })}
            </p>
          ) : (
            <p>{t("transformation.genealogy.notComparable")}</p>
          )}
          {value.balance.state === "unknown" && value.balance.values.length ? (
            <ul aria-label={t("transformation.genealogy.quantities")}>
              {value.balance.values.map((item, index) => (
                <li key={index}>
                  {t(`transformation.genealogy.${item.side}`)}: {item.quantity} {item.unitOfMeasure}
                </li>
              ))}
            </ul>
          ) : null}
          <div className="us-tr-genealogy-preview" aria-hidden="true">
            <span>{t("transformation.genealogy.lots", { count: value.lots.length })}</span>
            <span>→</span>
            <span>{t("transformation.genealogy.events", { count: value.events.length })}</span>
            <span>→</span>
            <span>{t("transformation.genealogy.links", { count: value.links.length })}</span>
            {value.links.slice(0, 6).map((link) => (
              <div
                className="us-tr-genealogy-edge us-tr-mono"
                key={`${link.eventId}/${link.inputLotId}/${link.outputLotId}`}
              >
                <span>{link.inputLotId}</span>
                <span>→</span>
                <span>{link.eventId}</span>
                <span>→</span>
                <span>{link.outputLotId}</span>
              </div>
            ))}
          </div>
          <div className="us-tr-genealogy-text">
            <h3>{t("transformation.genealogy.textGraph")}</h3>
            <p>{t("transformation.genealogy.selected")}</p>
            <ul aria-label={t("transformation.genealogy.selected")}>
              {value.selectedRevisionIds.map((id) => (
                <li className="us-tr-mono" key={id}>
                  {id}
                </li>
              ))}
            </ul>
            <ul aria-label={t("transformation.genealogy.lotList")}>
              {value.lots.map((lot) => (
                <li className="us-tr-mono" key={lot.id}>
                  {lot.id} ·{" "}
                  {t(
                    lot.currentOrigin
                      ? "transformation.genealogy.originCurrent"
                      : "transformation.genealogy.originMissing",
                  )}
                </li>
              ))}
            </ul>
            <ul aria-label={t("transformation.genealogy.eventList")}>
              {value.events.map((event) => (
                <li className="us-tr-mono" key={event.id}>
                  {event.id} · {t("transformation.detail.revision")} {event.revision} ·{" "}
                  {t(`events.${event.status}`)}
                </li>
              ))}
            </ul>
            <ul aria-label={t("transformation.genealogy.linkList")}>
              {value.links.map((link) => (
                <li
                  className="us-tr-mono"
                  key={`${link.eventId}/${link.inputLotId}/${link.outputLotId}`}
                >
                  {link.inputLotId} → {link.eventId} → {link.outputLotId}
                </li>
              ))}
            </ul>
          </div>
        </>
      ) : null}
    </section>
  );
}
