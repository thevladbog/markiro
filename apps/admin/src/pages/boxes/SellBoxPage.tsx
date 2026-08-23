import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { formatSsccHri, parseScannedSscc } from "@markiro/domain";
import { Alert, Button, PageHeader, Spinner } from "@markiro/ui";

import { ApiRequestError } from "../../api/client.js";
import { useBoxSellCodes } from "./sell-api.js";

import "./sell.css";

const SellCode = lazy(() => import("./SellCode.js"));
const SsccScanner = lazy(() => import("./SsccScanner.js"));

/** Minimal shape this module needs from the Wake Lock API -- `lib.dom`'s
 * `WakeLockSentinel`/`navigator.wakeLock` aren't in every TS lib target this
 * repo compiles against, so this local interface avoids `any` without
 * depending on that lib being present. */
interface WakeLockSentinelLike {
  release(): Promise<void>;
}

/**
 * Sell-at-register (спека 2026-08-23-box-sell-scan-design.md): кассир вводит
 * SSCC закрытого короба и листает его DataMatrix-коды по одному во весь
 * экран, чтобы касса сканировала их с телефона. Read-only: статус короба не
 * меняется. Один код на экране за раз -- сканер кассы не должен зацепить
 * соседний код.
 */
export function SellBoxPage() {
  const { t } = useTranslation();

  const [ssccInput, setSsccInput] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);
  const [sscc, setSscc] = useState<string | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);
  const [index, setIndex] = useState(0);
  const [finished, setFinished] = useState(false);
  const [scanning, setScanning] = useState(false);
  const touchStartX = useRef<number | null>(null);
  const cameraAvailable = typeof navigator !== "undefined" && Boolean(navigator.mediaDevices);

  const { data, isPending, error } = useBoxSellCodes(sscc, attempt);

  // Пока идёт показ кодов, экран телефона не должен гаснуть. Wake Lock
  // может быть недоступен (iOS < 16.4, http) -- тогда молча живём без него.
  useEffect(() => {
    if (!data || finished) return;
    let lock: WakeLockSentinelLike | null = null;
    let cancelled = false;
    const nav = navigator as Navigator & {
      wakeLock?: { request(type: "screen"): Promise<WakeLockSentinelLike> };
    };
    nav.wakeLock
      ?.request("screen")
      .then((sentinel) => {
        if (cancelled) void sentinel.release();
        else lock = sentinel;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      void lock?.release().catch(() => {});
    };
  }, [data, finished]);

  const handleDetected = useCallback((raw: string) => {
    const parsed = parseScannedSscc(raw);
    if (parsed === null) {
      setInputError("invalidSscc");
      return;
    }
    setInputError(null);
    setIndex(0);
    setFinished(false);
    // Bump `attempt` on every submit -- including a re-submit of the same
    // SSCC after a failed fetch -- so `useBoxSellCodes`'s query key always
    // changes and React Query actually refetches instead of serving the
    // cached error back (see that hook's comment).
    setAttempt((current) => current + 1);
    setSscc(parsed);
  }, []);

  const reset = useCallback(() => {
    setSscc(undefined);
    setSsccInput("");
    setInputError(null);
    setIndex(0);
    setFinished(false);
  }, []);

  if (sscc === undefined || error !== null) {
    const errorKey =
      error instanceof ApiRequestError
        ? error.code === "box_not_found"
          ? "boxNotFound"
          : error.code === "box_disassembled"
            ? "boxDisassembled"
            : error.code === "box_empty"
              ? "boxEmpty"
              : error.code === "box_not_closed"
                ? "boxNotClosed"
                : "loadFailed"
        : error
          ? "loadFailed"
          : null;
    return (
      <div className="mk-sell">
        <PageHeader title={t("pages.boxSell.title")} />
        <form
          className="mk-sell-entry"
          onSubmit={(event) => {
            event.preventDefault();
            handleDetected(ssccInput);
          }}
        >
          <label className="mk-sell-entry__label" htmlFor="sell-sscc">
            {t("pages.boxSell.ssccLabel")}
          </label>
          <input
            id="sell-sscc"
            className="mk-sell-entry__input"
            inputMode="numeric"
            autoComplete="off"
            placeholder="00123456789012345675"
            value={ssccInput}
            onChange={(event) => setSsccInput(event.target.value)}
          />
          <Button type="submit" size="floor">
            {t("pages.boxSell.find")}
          </Button>
          {cameraAvailable && !scanning && (
            <Button
              type="button"
              size="floor"
              variant="secondary"
              onClick={() => setScanning(true)}
            >
              {t("pages.boxSell.openScanner")}
            </Button>
          )}
          {scanning && (
            <div className="mk-sell-scanner">
              <Suspense fallback={<Spinner />}>
                <SsccScanner
                  onDetected={(raw) => {
                    setScanning(false);
                    handleDetected(raw);
                  }}
                  onError={() => {
                    setScanning(false);
                    setInputError("cameraFailed");
                  }}
                />
              </Suspense>
              <Button
                type="button"
                size="floor"
                variant="secondary"
                onClick={() => setScanning(false)}
              >
                {t("pages.boxSell.closeScanner")}
              </Button>
            </div>
          )}
          {inputError !== null && (
            <Alert tone="error">{t(`pages.boxSell.errors.${inputError}`)}</Alert>
          )}
          {errorKey !== null && <Alert tone="error">{t(`pages.boxSell.errors.${errorKey}`)}</Alert>}
        </form>
      </div>
    );
  }

  if (isPending || !data) {
    return (
      <div className="mk-sell mk-sell--center">
        <Spinner />
      </div>
    );
  }

  if (finished) {
    return (
      <div className="mk-sell mk-sell--center">
        <div className="mk-sell-done">
          <div className="mk-sell-done__title">
            {t("pages.boxSell.done", { count: data.itemCount })}
          </div>
          <div className="mk-sell-done__sscc">{formatSsccHri(data.sscc)}</div>
          <Button type="button" size="floor" onClick={reset}>
            {t("pages.boxSell.nextBox")}
          </Button>
        </div>
      </div>
    );
  }

  const item = data.items[index]!;
  const goPrev = () => setIndex((current) => Math.max(0, current - 1));
  const goNext = () => {
    if (index + 1 >= data.itemCount) setFinished(true);
    else setIndex((current) => current + 1);
  };
  return (
    <div
      className="mk-sell"
      onTouchStart={(event) => {
        touchStartX.current = event.touches[0]?.clientX ?? null;
      }}
      onTouchEnd={(event) => {
        const startX = touchStartX.current;
        touchStartX.current = null;
        if (startX === null) return;
        const delta = (event.changedTouches[0]?.clientX ?? startX) - startX;
        // Порог 60px: короткие касания при удержании телефона у сканера не
        // должны листать код.
        if (delta <= -60) goNext();
        else if (delta >= 60) goPrev();
      }}
    >
      <div className="mk-sell-head">
        <div className="mk-sell-head__counter">{`${index + 1} / ${data.itemCount}`}</div>
        <div className="mk-sell-head__product">{data.productName}</div>
        <div className="mk-sell-head__sscc">{formatSsccHri(data.sscc)}</div>
      </div>
      <div className="mk-sell-progress">
        <div
          className="mk-sell-progress__bar"
          style={{ width: `${((index + 1) / data.itemCount) * 100}%` }}
        />
      </div>
      <div className="mk-sell-stage">
        <Suspense fallback={<Spinner />}>
          <SellCode key={item.codeHash} rawKm={item.rawKm} fallbackLabel={item.serial} />
        </Suspense>
        <div className="mk-sell-stage__serial">{item.serial}</div>
      </div>
      <div className="mk-sell-nav">
        <Button
          type="button"
          size="floor"
          variant="secondary"
          fullWidth
          disabled={index === 0}
          onClick={goPrev}
        >
          {t("pages.boxSell.prev")}
        </Button>
        <Button type="button" size="floor" fullWidth onClick={goNext}>
          {t("pages.boxSell.next")}
        </Button>
      </div>
    </div>
  );
}
