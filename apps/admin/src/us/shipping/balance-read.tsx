import { useEffect, useRef, useState } from "react";
import { projectShippingRemaining } from "@markiro/domain";
import type { ShippingBalanceResponse } from "@markiro/platform-contracts";
import { Button } from "@markiro/ui";
import { useTranslation } from "react-i18next";
import { UsClientError, type UsBrowserClient } from "../client.js";

type Props = {
  client: UsBrowserClient;
  lotId: string;
  quantity: string | null;
  unit: string | null;
  contextDraftId?: string | undefined;
  expectedDraftVersion?: number | undefined;
  historical?: boolean;
  onOriginUom?: (unit: ShippingBalanceResponse["originUom"]) => void;
  onForbidden: () => Promise<void>;
  onSessionLost: () => void;
};

export function ShippingBalanceRead({
  client,
  lotId,
  quantity,
  unit,
  contextDraftId,
  expectedDraftVersion,
  historical = false,
  onOriginUom,
  onForbidden,
  onSessionLost,
}: Props) {
  const { t } = useTranslation();
  const [refresh, setRefresh] = useState(0);
  const [result, setResult] = useState<ShippingBalanceResponse | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const onOriginRef = useRef(onOriginUom);
  onOriginRef.current = onOriginUom;

  useEffect(() => {
    let active = true;
    setResult(null);
    setState("loading");
    const context =
      contextDraftId && expectedDraftVersion ? { contextDraftId, expectedDraftVersion } : {};
    void client
      .getShippingBalance(lotId, context)
      .then((value) => {
        if (!active) return;
        setResult(value);
        setState("ready");
        if (!historical && value.originUom) onOriginRef.current?.(value.originUom);
      })
      .catch(async (error: unknown) => {
        if (!active) return;
        setState("failed");
        if (error instanceof UsClientError && error.code === "session_required") onSessionLost();
        else if (error instanceof UsClientError && error.code === "forbidden") await onForbidden();
      });
    return () => {
      active = false;
    };
  }, [
    client,
    lotId,
    contextDraftId,
    expectedDraftVersion,
    refresh,
    historical,
    onForbidden,
    onSessionLost,
  ]);

  const balance = result?.balance;
  const forecast =
    !historical && balance ? projectShippingRemaining(balance, quantity, unit) : null;
  return (
    <div className="us-sh-balance" aria-live="polite">
      {state === "loading" ? <p>{t("shipping.balanceLoading")}</p> : null}
      {state === "failed" ? <p role="alert">{t("shipping.balanceReadFailed")}</p> : null}
      {balance?.state === "known" ? (
        <p>
          {t(
            contextDraftId
              ? "shipping.balanceBeforeReplacement"
              : "shipping.currentRecordedBalance",
            {
              quantity: balance.remaining,
              unit: balance.unitOfMeasure,
            },
          )}
        </p>
      ) : null}
      {balance?.state === "unknown" ? (
        <p role="status">{t(`shipping.balanceUnknownReason.${balance.reason}`)}</p>
      ) : null}
      {forecast?.state === "known" || forecast?.state === "over_shipment" ? (
        <p>{t("shipping.proposedQuantity", { quantity, unit })}</p>
      ) : null}
      {forecast?.state === "known" ? (
        <p>{t("shipping.projectedRemaining", { quantity: forecast.projectedRemaining, unit })}</p>
      ) : null}
      {forecast?.state === "over_shipment" ? (
        <p role="alert">
          {t("shipping.forecastOver", { quantity: forecast.projectedRemaining, unit })}
        </p>
      ) : null}
      {forecast?.state === "exhausted" ? (
        <p role="alert">{t("shipping.forecastExhausted")}</p>
      ) : null}
      {forecast?.state === "uom_mismatch" ? (
        <p role="alert">{t("shipping.forecastUomMismatch", { unit: forecast.expectedUnit })}</p>
      ) : null}
      {forecast?.state === "unknown" ? <p>{t("shipping.forecastUnknown")}</p> : null}
      {forecast?.state === "invalid_quantity" ? (
        <p role="alert">{t("shipping.forecastInvalidQuantity")}</p>
      ) : null}
      {forecast?.state === "quantity_required" || forecast?.state === "unit_required" ? (
        <p>{t("shipping.forecastInputNeeded")}</p>
      ) : null}
      {!historical && state === "ready" ? <small>{t("shipping.forecastCaveat")}</small> : null}
      {state !== "loading" ? (
        <Button type="button" variant="secondary" onClick={() => setRefresh((value) => value + 1)}>
          {t("shipping.refreshBalance")}
        </Button>
      ) : null}
    </div>
  );
}
