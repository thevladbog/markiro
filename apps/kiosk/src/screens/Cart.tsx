import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Modal } from "@markiro/ui";
import type { KioskBootstrapDto } from "../api/types.js";
import { classifyKioskScan } from "../domain-guard/classify.js";
import type { ScanListener } from "../scanner/source.js";
import {
  canSubmit,
  cartReducer,
  initialCartState,
  type CartAction,
  type CartItem,
  type CartNotice,
  type CartState,
} from "../session/cart.js";

export type KioskOrientation = "landscape" | "portrait";

/**
 * Which way round the kiosk is standing. Extracted as a pure function so the
 * decision can be pinned in a unit test without a real viewport, and so the
 * component has exactly one place that looks at the window.
 *
 * A square viewport counts as landscape: there is no taller axis to stack
 * along, and the two-column layout is the one that survives an unexpected
 * shape without pushing the list below the fold.
 */
export function orientationOf(width: number, height: number): KioskOrientation {
  return height > width ? "portrait" : "landscape";
}

export interface CartProps {
  /** Who the badge admitted. Shown in the header so the wrong person notices. */
  employee: { id: string; fullName: string };
  bootstrap: KioskBootstrapDto;
  /** What this employee has already taken today, counted against the limit. */
  alreadyTakenToday: number;
  /**
   * Subscribes `cb` to the device's scans and MAY return a teardown, which
   * this screen calls on unmount — same contract as `Idle`, and called
   * EXACTLY ONCE at mount for the same reason (see the effect below).
   */
  onScan: (cb: ScanListener) => void | (() => void);
  /** The cart, handed over whole. The caller turns it into a `CreateOrderDto`. */
  onSubmit: (state: CartState) => void;
  /** The worker says the badge was not theirs — end the session. */
  onNotMe: () => void;
}

/**
 * Notices that belong in the amber strip under the header: each one is
 * something the worker fixes at the scanner within seconds.
 *
 * `unknown-product` is missing on purpose — it takes the red modal, because
 * nothing the worker does with the scanner will change the answer.
 * `limit` is missing too: the blocking panel below has already replaced the
 * scan zone by the time the reducer can refuse for the limit, so the screen is
 * not silent and a second amber strip repeating it would only add noise.
 */
const BANNER: Partial<Record<CartNotice["kind"], string>> = {
  duplicate: "cart.duplicate",
  incomplete: "cart.incomplete",
  "not-a-code": "cart.notACode",
};

/** «Смирнов Алексей» -> «СА». Decoration; the full name is next to it. */
function initialsOf(fullName: string): string {
  return fullName
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word.slice(0, 1).toUpperCase())
    .join("");
}

/**
 * How the worker tells one bottle from another in the list. Product images are
 * deliberately out of scope, so the name plus this tail are the whole identity:
 * the end of the GTIN and the serial, exactly as the prototype prints it.
 *
 * The serial is recovered from `kmKey` (`01<gtin14>21<serial>`, the canonical
 * dedup identity built by `@markiro/domain`'s `kmKey`) rather than re-parsed
 * from `rawKm` — this screen owns no GS1 parsing. The `startsWith` guard keeps
 * a future change to that shape from silently printing a mangled tail.
 */
function codeTail(item: CartItem): string {
  const prefix = `01${item.gtin14}21`;
  const serial = item.kmKey.startsWith(prefix) ? item.kmKey.slice(prefix.length) : item.kmKey;
  return `…${item.gtin14.slice(-6)}-${serial}`;
}

/**
 * Money in minor units. `unitPrice` arrives as a decimal string, and summing
 * those as floats drifts (0.1 + 0.2); a price the kiosk cannot parse counts as
 * nothing rather than as NaN, which would poison the whole total.
 */
function kopecksOf(unitPrice: string | null): number {
  if (unitPrice === null) return 0;
  const value = Number(unitPrice);
  return Number.isFinite(value) ? Math.round(value * 100) : 0;
}

function formatMoney(kopecks: number): string {
  return (kopecks / 100).toFixed(2);
}

/**
 * The screen the worker actually uses: a pure projection of `session/cart.ts`.
 *
 * NO ACCEPT/REFUSE RULE LIVES HERE. Every scan is classified and handed
 * straight to `cartReducer`, which alone decides whether it joins the list and
 * which notice the worker sees; submit is gated by the reducer module's
 * `canSubmit` rather than by any condition written here. That is what keeps
 * the rules the server mirrors in exactly one testable place — a reviewer can
 * check it by looking for the things that are absent: this file never touches
 * `bootstrap.products`, never compares a `kmKey`, and never asks whether
 * `writeoffReasonId` is set.
 *
 * The one number it does compute is `remaining`, and it is display only: the
 * footer has to print it either way, and the blocking panel simply appears
 * when it reaches zero. It gates nothing — a scan made while the panel is up
 * still travels through the reducer and still comes back refused by the
 * reducer's own limit check.
 */
export function Cart({
  employee,
  bootstrap,
  alreadyTakenToday,
  onScan,
  onSubmit,
  onNotMe,
}: CartProps): React.JSX.Element {
  const { t } = useTranslation();

  // The reducer is rebuilt when its context changes so a dispatch always
  // decides against the current bootstrap; React reads the reducer from the
  // render in which the action is processed, so no ref is needed here.
  const reduce = useCallback(
    (state: CartState, action: CartAction) =>
      cartReducer(state, action, { bootstrap, alreadyTakenToday }),
    [bootstrap, alreadyTakenToday],
  );
  const [state, dispatch] = useReducer(reduce, initialCartState);

  const [orientation, setOrientation] = useState<KioskOrientation>(() =>
    orientationOf(window.innerWidth, window.innerHeight),
  );
  useEffect(() => {
    const measure = () => setOrientation(orientationOf(window.innerWidth, window.innerHeight));
    // Once on mount as well: a kiosk can be rotated while this screen is
    // unmounted, and the state initializer above only ran for the first mount.
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  /**
   * Held from the first render so the subscription can be mount-only, for the
   * reason `Idle` documents at length: a parent passing an inline `onScan`
   * gives a new identity every render, and a dependency on it would tear the
   * scanner down and resubscribe after every scan.
   */
  const subscribe = useRef(onScan);
  useEffect(() => {
    const stop = subscribe.current((raw) => {
      // The screen's entire scan logic: classify, then let the reducer decide.
      dispatch({ type: "scan", scan: classifyKioskScan(raw) });
    });
    return () => {
      if (stop) stop();
    };
  }, []);

  const portrait = orientation === "portrait";
  const limit = bootstrap.config.dayLimitPerEmployee;
  const showPrices = bootstrap.config.showPrices;
  const count = state.items.length;
  const remaining = Math.max(0, limit - alreadyTakenToday - count);
  const total = state.items.reduce((sum, item) => sum + kopecksOf(item.unitPrice), 0);
  const bannerKey = state.notice ? BANNER[state.notice.kind] : undefined;
  const submittable = canSubmit(state);

  const ghostButton = {
    borderRadius: 10,
    border: "1px solid var(--line-strong)",
    background: "transparent",
    color: "var(--fg-2)",
    font: "600 18px/1 var(--font-ui)",
  } as const;

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        background: "var(--surface-page)",
        color: "var(--fg-1)",
      }}
    >
      <header
        style={{
          height: 76,
          flexShrink: 0,
          boxSizing: "border-box",
          background: "var(--surface-card)",
          borderBottom: "1px solid var(--line)",
          display: "flex",
          alignItems: "center",
          gap: 16,
          padding: "0 24px",
        }}
      >
        {/* The wordless mark from the prototype's header; the wordmark next to
            it says everything this signals. */}
        <svg width="30" height="30" viewBox="0 0 64 64" aria-hidden="true" focusable="false">
          <rect x="4" y="4" width="56" height="56" fill="var(--surface-inverse)" />
          <g fill="var(--surface-page)">
            <rect x="14" y="14" width="8" height="8" />
            <rect x="14" y="26" width="8" height="8" />
            <rect x="14" y="38" width="8" height="8" />
            <rect x="26" y="22" width="8" height="8" />
            <rect x="38" y="14" width="8" height="8" />
            <rect x="38" y="26" width="8" height="8" />
            <rect x="38" y="38" width="8" height="8" />
            <rect x="26" y="42" width="8" height="8" fill="var(--accent-module)" />
          </g>
        </svg>
        <span style={{ font: "600 17px/1 var(--font-mono)" }}>{t("cart.logo")}</span>
        <span style={{ flex: 1 }} />
        <span style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
          <span
            aria-hidden="true"
            style={{
              width: 44,
              height: 44,
              flexShrink: 0,
              borderRadius: 10,
              background: "var(--surface-inverse)",
              color: "var(--fg-on-inverse)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              font: "600 17px/1 var(--font-ui)",
            }}
          >
            {initialsOf(employee.fullName)}
          </span>
          <span
            style={{
              font: "600 20px/1 var(--font-ui)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {employee.fullName}
          </span>
        </span>
        <button
          type="button"
          onClick={onNotMe}
          style={{ ...ghostButton, height: 56, padding: "0 22px", flexShrink: 0 }}
        >
          {t("cart.notMe")}
        </button>
      </header>

      {bannerKey ? (
        <div
          role="alert"
          style={{
            flexShrink: 0,
            background: "var(--warn-bg)",
            borderBottom: "1px solid var(--warn-border)",
            color: "var(--warn-fg)",
            padding: "14px 24px",
            font: "600 19px/26px var(--font-ui)",
          }}
        >
          {t(bannerKey)}
        </div>
      ) : null}

      {/* Landscape puts the scan zone beside the list, portrait stacks them.
          Flex direction only — no media queries, so the same build serves a
          rotated kiosk without a reload. */}
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: portrait ? "column" : "row",
          minHeight: 0,
        }}
      >
        <div
          style={{
            flex: portrait ? "0 0 auto" : "1 1 0",
            padding: 24,
            display: "flex",
            flexDirection: "column",
            gap: 16,
            minWidth: 0,
            minHeight: 0,
          }}
        >
          {remaining === 0 ? (
            // REPLACES the scan zone, never covers it: a scan prompt still on
            // screen next to an exhausted limit is an invitation the kiosk will
            // refuse, and the worker would keep waving bottles at it.
            <div
              role="status"
              style={{
                flex: portrait ? "0 0 auto" : "1 1 0",
                border: "2px solid var(--warn-border)",
                borderRadius: 16,
                background: "var(--warn-bg)",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 14,
                padding: 24,
                textAlign: "center",
              }}
            >
              <span style={{ font: "700 28px/36px var(--font-ui)", color: "var(--warn-fg)" }}>
                {t("cart.limitTitle", { limit })}
              </span>
              <span style={{ font: "400 18px/26px var(--font-ui)", color: "var(--fg-2)" }}>
                {t("cart.limitHint")}
              </span>
            </div>
          ) : (
            <div
              style={{
                flex: portrait ? "0 0 auto" : "1 1 0",
                border: "2px dashed var(--line-strong)",
                borderRadius: 16,
                background: "var(--surface-card)",
                display: "flex",
                flexDirection: portrait ? "row" : "column",
                alignItems: "center",
                justifyContent: "center",
                gap: portrait ? 20 : 18,
                padding: portrait ? "16px 22px" : 24,
              }}
            >
              <svg
                width={portrait ? 52 : 96}
                height={portrait ? 52 : 96}
                viewBox="0 0 24 24"
                fill="none"
                stroke="var(--line-strong)"
                strokeWidth="1.5"
                style={{ flexShrink: 0 }}
                aria-hidden="true"
                focusable="false"
              >
                <path d="M3 7V3h4M17 3h4v4M21 17v4h-4M7 21H3v-4M7 12h10" />
              </svg>
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                  textAlign: portrait ? "left" : "center",
                }}
              >
                {/* Two elements, one sentence: the design breaks the line after
                    «бутылку», and a dictionary entry carrying markup would push
                    that break past every future translator. */}
                <span
                  style={{ font: `700 ${portrait ? "22px/28px" : "28px/36px"} var(--font-ui)` }}
                >
                  {t("cart.scanTitle")}
                </span>
                <span
                  style={{ font: `700 ${portrait ? "22px/28px" : "28px/36px"} var(--font-ui)` }}
                >
                  {t("cart.scanTitleTarget")}
                </span>
                <span style={{ font: "400 17px/24px var(--font-ui)", color: "var(--fg-3)" }}>
                  {t("cart.scanHint")}
                </span>
              </div>
            </div>
          )}
        </div>

        <section
          style={{
            width: portrait ? "auto" : 460,
            flex: portrait ? "1 1 0" : "0 0 auto",
            flexShrink: 0,
            borderLeft: portrait ? "none" : "1px solid var(--line)",
            borderTop: portrait ? "1px solid var(--line)" : "none",
            display: "flex",
            flexDirection: "column",
            minHeight: 0,
            boxSizing: "border-box",
            background: "var(--surface-card)",
          }}
        >
          <div
            style={{
              padding: "20px 24px 14px 24px",
              display: "flex",
              alignItems: "baseline",
              gap: 10,
              borderBottom: "1px solid var(--line)",
            }}
          >
            <h1 style={{ margin: 0, font: "700 24px/30px var(--font-ui)" }}>
              {t("cart.listTitle")}
            </h1>
            <span
              style={{
                font: "600 20px/1 var(--font-mono)",
                fontVariantNumeric: "tabular-nums",
                color: "var(--fg-3)",
              }}
            >
              {count}
            </span>
          </div>

          <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
            {count === 0 ? (
              <div
                style={{
                  padding: "48px 24px",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 10,
                  textAlign: "center",
                }}
              >
                <span style={{ font: "600 20px/28px var(--font-ui)", color: "var(--fg-disabled)" }}>
                  {t("cart.emptyTitle")}
                </span>
                <span style={{ font: "400 16px/24px var(--font-ui)", color: "var(--fg-3)" }}>
                  {t("cart.emptyHint")}
                </span>
              </div>
            ) : (
              <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {state.items.map((item) => (
                  <li
                    key={item.kmKey}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 14,
                      padding: "12px 20px 12px 24px",
                      borderBottom: "1px solid var(--line)",
                    }}
                  >
                    {/* Product images are deliberately out of scope; the slot
                        keeps the row's rhythm so adding them later is a swap. */}
                    <span
                      aria-hidden="true"
                      style={{
                        width: 56,
                        height: 56,
                        flexShrink: 0,
                        borderRadius: 8,
                        background: "var(--surface-panel)",
                      }}
                    />
                    <span
                      style={{
                        flex: 1,
                        display: "flex",
                        flexDirection: "column",
                        gap: 3,
                        minWidth: 0,
                      }}
                    >
                      <span
                        style={{
                          font: "600 18px/24px var(--font-ui)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {item.name}
                      </span>
                      <span
                        style={{ font: "400 14px/18px var(--font-mono)", color: "var(--fg-3)" }}
                      >
                        {codeTail(item)}
                      </span>
                    </span>
                    {showPrices && item.unitPrice !== null ? (
                      <span
                        style={{
                          font: "600 19px/1 var(--font-mono)",
                          fontVariantNumeric: "tabular-nums",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {t("cart.price", { value: formatMoney(kopecksOf(item.unitPrice)) })}
                      </span>
                    ) : null}
                    <button
                      type="button"
                      aria-label={t("cart.remove", { name: item.name })}
                      onClick={() => dispatch({ type: "remove", kmKey: item.kmKey })}
                      style={{
                        ...ghostButton,
                        width: 56,
                        height: 56,
                        flexShrink: 0,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      <svg
                        width="22"
                        height="22"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        aria-hidden="true"
                        focusable="false"
                      >
                        <path d="M6 6l12 12M18 6L6 18" />
                      </svg>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div
            style={{
              flexShrink: 0,
              borderTop: "1px solid var(--line)",
              padding: "20px 24px",
              display: "flex",
              flexDirection: "column",
              gap: 12,
            }}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <span style={{ font: "500 14px/1 var(--font-ui)", color: "var(--fg-3)" }}>
                {t("cart.reason")}
              </span>
              <div style={{ display: "flex", gap: 8 }}>
                {(["buy", "writeoff"] as const).map((reason) => {
                  const on = state.reason === reason;
                  return (
                    <button
                      key={reason}
                      type="button"
                      aria-pressed={on}
                      onClick={() => dispatch({ type: "reason", reason })}
                      style={{
                        flex: 1,
                        height: 56,
                        borderRadius: 10,
                        border: `1px solid ${on ? "var(--surface-inverse)" : "var(--line-strong)"}`,
                        background: on ? "var(--surface-inverse)" : "transparent",
                        color: on ? "var(--fg-on-inverse)" : "var(--fg-2)",
                        font: "600 18px/1 var(--font-ui)",
                      }}
                    >
                      {t(reason === "buy" ? "cart.reasonBuy" : "cart.reasonWriteoff")}
                    </button>
                  );
                })}
              </div>
              {/* The sub-reasons are the tenant's own, straight from the
                  bootstrap — never a list hard-coded on the device. */}
              {state.reason === "writeoff" ? (
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {bootstrap.reasons.map((sub) => {
                    const on = state.writeoffReasonId === sub.id;
                    return (
                      <button
                        key={sub.id}
                        type="button"
                        aria-pressed={on}
                        onClick={() => dispatch({ type: "writeoffReason", id: sub.id })}
                        style={{
                          height: 48,
                          padding: "0 20px",
                          borderRadius: "var(--r-round)",
                          border: `1px solid ${on ? "var(--ok-solid)" : "var(--line-strong)"}`,
                          background: on ? "var(--ok-bg)" : "transparent",
                          color: on ? "var(--ok-fg)" : "var(--fg-2)",
                          font: "600 16px/1 var(--font-ui)",
                        }}
                      >
                        {sub.name}
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>

            <div
              style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}
            >
              <span style={{ font: "600 20px/26px var(--font-ui)" }}>
                {t("cart.total", { n: count })}
              </span>
              {showPrices ? (
                <span
                  style={{
                    font: "600 26px/1 var(--font-mono)",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {t("cart.price", { value: formatMoney(total) })}
                </span>
              ) : null}
            </div>

            <span style={{ font: "400 15px/20px var(--font-ui)", color: "var(--fg-3)" }}>
              {t("cart.limitFooter", { limit, remaining })}
            </span>

            <button
              type="button"
              disabled={!submittable}
              onClick={() => onSubmit(state)}
              style={{
                height: 84,
                borderRadius: 12,
                border: "none",
                background: submittable ? "var(--accent)" : "var(--surface-panel)",
                color: submittable ? "var(--fg-on-inverse)" : "var(--fg-disabled)",
                font: "700 24px/1 var(--font-ui)",
              }}
            >
              {t("cart.submit")}
            </button>
          </div>
        </section>
      </div>

      {/*
        The red stop. Its copy deliberately does NOT say «not in the catalogue»,
        which the plan proposed: `bootstrap.products` is this kiosk's allowlist
        (the same query the server's `kioskAllowlist` runs), so the device
        genuinely cannot tell the server's `unknown_product` from `not_allowed`
        — a product that exists in the tenant's catalogue but is not stocked
        here lands in this very branch. Telling the worker it does not exist
        would send them to argue with an administrator who can see it listed.
        This wording is true of both cases.
      */}
      <Modal
        open={state.notice?.kind === "unknown-product"}
        onClose={() => dispatch({ type: "dismissNotice" })}
        closeLabel={t("cart.close")}
        width={560}
        title={
          <span style={{ font: "700 24px/30px var(--font-ui)", color: "var(--err-fg)" }}>
            {t("cart.unknownTitle")}
          </span>
        }
        style={{ border: "2px solid var(--err-border)" }}
        footer={
          <button
            type="button"
            onClick={() => dispatch({ type: "dismissNotice" })}
            style={{
              height: 64,
              padding: "0 32px",
              borderRadius: 12,
              border: "none",
              background: "var(--err-solid)",
              color: "var(--fg-on-inverse)",
              font: "700 20px/1 var(--font-ui)",
            }}
          >
            {t("cart.unknownDismiss")}
          </button>
        }
      >
        <p style={{ margin: 0, font: "400 20px/28px var(--font-ui)", color: "var(--fg-2)" }}>
          {t("cart.unknownBody")}
        </p>
      </Modal>
    </main>
  );
}
