import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Modal } from "@markiro/ui";
import type { KioskBootstrapSnapshotDto } from "../api/types.js";
import { classifyKioskScan } from "../domain-guard/classify.js";
import type { ScanListener } from "../scanner/source.js";
import {
  canSubmit,
  cartPickupPolicy,
  cartReducer,
  initialCartState,
  remainingToday,
  type CartAction,
  type BoxLine,
  type KioskCartLine,
  type CartNotice,
  type CartState,
} from "../session/cart.js";
// The money rules live beside the two screens that print money, so the cart and
// the confirmation that summarises it cannot drift apart on a separator or a
// rounding step.
import { formatMoney, moneyFormat, toKopecks, totalKopecks, UNPRICED } from "./money.js";
import { productMonogram } from "./product-monogram.js";

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
  bootstrap: KioskBootstrapSnapshotDto;
  /**
   * What this employee has already taken today, as far as the device can tell:
   * the sum of the two disjoint halves `session/day-count.ts` owns — this
   * kiosk's own journal and queue, plus the roster's `takenTodayElsewhere` for
   * every OTHER kiosk. The caller adds them; this screen only prints and
   * subtracts.
   *
   * It can still be short (history older than the journal keeps, a withdrawal
   * made elsewhere since the last bootstrap), which is why the number this
   * screen prints is a courtesy and `POST /kiosk/orders` remains the authority.
   */
  alreadyTakenToday: number;
  /** Canonical session draft restored after navigation or a failed durable submit. */
  initialState?: CartState;
  /**
   * Subscribes `cb` to the device's scans and MAY return a teardown, which
   * this screen calls on unmount — same contract as `Idle`, and called
   * EXACTLY ONCE at mount for the same reason (see the effect below).
   */
  onScan: (cb: ScanListener) => void | (() => void);
  /** Local-only SSCC resolver; network access is intentionally outside this contract. */
  resolveBox?: (
    sscc: string,
  ) => Promise<
    | { kind: "resolved"; box: BoxLine }
    | { kind: "rejected"; notice: "unknown-box" | "registry-unavailable" | "registry-blocked" }
  >;
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
  "duplicate-box": "cart.duplicateBox",
  "duplicate-sscc": "cart.duplicateSscc",
  "unknown-box": "cart.unknownBox",
  "registry-unavailable": "cart.registryUnavailable",
  "registry-blocked": "cart.registryBlocked",
  incomplete: "cart.incomplete",
  "not-a-code": "cart.notACode",
};

/**
 * How long an amber banner stands before it clears itself — design 2026-07-24
 * §8.2, «Повторный код → янтарный баннер (~2,6 с)».
 *
 * It applies to the `BANNER` map above and to nothing else, which is the whole
 * subtlety. The other two amber-or-red things on this screen look like notices
 * and are not:
 *
 *  - the RED MODAL (`unknown-product`) is the one refusal the worker has to ACT
 *    on — the bottle in their hand goes back on the shelf — so it keeps
 *    requiring acknowledgement. A modal that dismissed itself would leave them
 *    holding something the kiosk had quietly stopped objecting to;
 *  - the LIMIT PANEL is a state, not a notice: it renders off `remaining === 0`
 *    rather than off `state.notice`, and it stays until something leaves the
 *    cart. (The `limit` notice has no `BANNER` entry, so this timer never sees
 *    it either.)
 */
const NOTICE_MS = 2_600;

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
 * Both halves are read straight off the item. This screen owns no GS1
 * knowledge whatsoever — it does not know that `kmKey` is `01<gtin14>21<serial>`,
 * so a change to that layout cannot reach it.
 */
function codeTail(item: KioskCartLine): string {
  return item.kind === "km"
    ? `…${item.gtin14.slice(-6)}-${item.serial}`
    : `…${item.sscc.slice(-6)}`;
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
 * The one number it shows beyond the list itself is `remaining`, and it does
 * not compute that either: `remainingToday` is exported from the reducer
 * module, and `applyScan` asks it the same question, so «осталось 0» and "the
 * next scan is refused" are one expression rather than two that agree today.
 * It gates nothing — a scan made while the blocking panel is up still travels
 * through the reducer and still comes back refused there.
 */
export function Cart({
  employee,
  bootstrap,
  alreadyTakenToday,
  initialState = initialCartState,
  onScan,
  resolveBox,
  onSubmit,
  onNotMe,
}: CartProps): React.JSX.Element {
  const { t, i18n } = useTranslation();

  // Rebuilt only when the language does. `Intl.NumberFormat` is the expensive
  // half of formatting a price, and this screen formats one per list row on
  // every scan.
  const money = useMemo(() => moneyFormat(i18n.language), [i18n.language]);

  const cartContext = useMemo(
    () => ({ bootstrap, employeeId: employee.id, alreadyTakenToday }),
    [alreadyTakenToday, bootstrap, employee.id],
  );

  // The reducer is rebuilt when its context changes so a dispatch always
  // decides against the current bootstrap; React reads the reducer from the
  // render in which the action is processed, so no ref is needed here.
  const reduce = useCallback(
    (state: CartState, action: CartAction) => cartReducer(state, action, cartContext),
    [cartContext],
  );
  const [state, dispatch] = useReducer(reduce, initialState);
  const pickupPolicy = cartPickupPolicy(cartContext);

  // A refresh may revoke writeoff while this cart is already open. Normalize
  // the stale choice immediately; hiding the control alone would leave a
  // forbidden reason in the state handed to the shell.
  useEffect(() => {
    if (!pickupPolicy.canWriteoff && state.reason === "writeoff") {
      dispatch({ type: "reason", reason: "buy" });
    }
  }, [pickupPolicy.canWriteoff, state.reason]);

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
  const resolveScannedBox = useRef(resolveBox);
  const scanChain = useRef<Promise<void> | null>(null);
  const resolverFailureLogged = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const stop = subscribe.current((raw) => {
      const classified = classifyKioskScan(raw);
      const apply = async () => {
        if (!mounted.current) return;
        if (classified.kind !== "sscc") {
          dispatch({ type: "scan", scan: classified });
          return;
        }
        let resolution:
          | { kind: "resolved"; box: BoxLine }
          | {
              kind: "rejected";
              notice: "unknown-box" | "registry-unavailable" | "registry-blocked";
            };
        try {
          resolution = resolveScannedBox.current
            ? await resolveScannedBox.current(classified.sscc)
            : { kind: "rejected", notice: "registry-unavailable" };
        } catch (error) {
          // One corrupt/unreadable IndexedDB lookup must not poison the promise
          // tail and silently disable every later scan. Log once per mounted
          // session to avoid flooding an unattended kiosk, and convert the
          // failure to the same actionable notice as an unavailable registry.
          if (!resolverFailureLogged.current) {
            resolverFailureLogged.current = true;
            console.error("kiosk: the local box registry could not be read", error);
          }
          resolution = { kind: "rejected", notice: "registry-unavailable" };
        }
        if (!mounted.current) return;
        dispatch(
          resolution.kind === "resolved"
            ? { type: "scanBox", box: resolution.box }
            : { type: "boxRejected", kind: resolution.notice },
        );
      };
      // A normal KM remains synchronous for the legacy touch surface. Once an
      // SSCC lookup is pending, later scans queue behind it so the first scan
      // still wins overlap regardless of IndexedDB latency.
      if (classified.kind !== "sscc" && scanChain.current === null) {
        void apply();
        return;
      }
      const work = (scanChain.current ?? Promise.resolve()).then(apply);
      const settled = work.finally(() => {
        if (scanChain.current === settled) scanChain.current = null;
      });
      scanChain.current = settled;
    });
    return () => {
      mounted.current = false;
      if (stop) stop();
    };
  }, []);

  /**
   * The amber strip's own clock.
   *
   * Keyed on the NOTICE OBJECT rather than on the message: `applyScan` builds a
   * fresh `{ kind }` for every refusal, so a second duplicate scan re-runs this
   * effect and re-arms the full 2.6 s instead of inheriting whatever was left of
   * the previous banner's. The cleanup is what makes both of those true, and it
   * is also what stops a timer outliving the screen — one leaked timer per
   * refused scan, each holding a dispatch into a reducer nobody is reading.
   *
   * `dismissNotice` is the reducer's own action, so the banner leaves the same
   * way the worker's tap on the modal makes one leave: no screen-local "hidden"
   * flag that `CartState` knows nothing about.
   */
  const notice = state.notice;
  useEffect(() => {
    // Nothing this effect may time: an accepted scan (`null`), the red modal's
    // `unknown-product`, or the limit — the last two are absent from `BANNER`
    // precisely because they are not banners. See `NOTICE_MS`.
    if (notice === null || BANNER[notice.kind] === undefined) return;
    const timer = setTimeout(() => dispatch({ type: "dismissNotice" }), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  const portrait = orientation === "portrait";
  const limit = pickupPolicy.dayLimit;
  const showPrices = bootstrap.config.showPrices;
  const count = state.lines.length;
  const remaining = remainingToday(state, cartContext);
  const total = totalKopecks(state.lines);
  const bannerKey = notice ? BANNER[notice.kind] : undefined;
  const submittable = canSubmit(state, cartContext);

  const ghostButton = {
    borderRadius: 10,
    border: "1px solid var(--line-strong)",
    background: "transparent",
    color: "var(--fg-2)",
    font: "600 18px/1 var(--font-ui)",
  } as const;

  return (
    <main className="kiosk-screen kiosk-cart">
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
          className="kiosk-control"
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
          aria-labelledby="kiosk-cart-list-title"
          style={{
            width: portrait ? "auto" : 460,
            flex: portrait ? "1 1 0" : "0 0 auto",
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
            <h1
              id="kiosk-cart-list-title"
              style={{ margin: 0, font: "700 24px/30px var(--font-ui)" }}
            >
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

          <div className="kiosk-cart__list" style={{ flex: 1 }}>
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
                {state.lines.map((item) => {
                  const unitKopecks = item.unitPrice === null ? null : toKopecks(item.unitPrice);
                  const kopecks = unitKopecks === null ? null : unitKopecks * item.bottleCount;
                  return (
                    <li
                      key={item.kind === "km" ? item.kmKey : item.sscc}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 14,
                        padding: "12px 20px 12px 24px",
                        borderBottom: "1px solid var(--line)",
                      }}
                    >
                      <span aria-hidden="true" className="kiosk-product-monogram">
                        {productMonogram(item.name)}
                      </span>
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
                          {kopecks === null
                            ? UNPRICED
                            : t("cart.price", { value: formatMoney(kopecks, money) })}
                        </span>
                      ) : null}
                      <button
                        className="kiosk-control"
                        type="button"
                        aria-label={t("cart.remove", { name: item.name })}
                        onClick={() =>
                          dispatch(
                            item.kind === "km"
                              ? { type: "remove", kmKey: item.kmKey }
                              : { type: "removeBox", sscc: item.sscc },
                          )
                        }
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
                  );
                })}
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
            <div
              className="kiosk-cart__reason-scroll"
              style={{ display: "flex", flexDirection: "column", gap: 8 }}
            >
              <span style={{ font: "500 14px/1 var(--font-ui)", color: "var(--fg-3)" }}>
                {t("cart.reason")}
              </span>
              <div style={{ display: "flex", gap: 8 }}>
                {(pickupPolicy.canWriteoff
                  ? (["buy", "writeoff"] as const)
                  : (["buy"] as const)
                ).map((reason) => {
                  const on = state.reason === reason;
                  return (
                    <button
                      className="kiosk-control"
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
              {pickupPolicy.canWriteoff && state.reason === "writeoff" ? (
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {bootstrap.reasons.map((sub) => {
                    const on = state.writeoffReasonId === sub.id;
                    return (
                      <button
                        className="kiosk-control"
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
                  {/* «—», not a sum with the unpriced items quietly left out:
                      this is the number the administrator charges against. */}
                  {total === null
                    ? UNPRICED
                    : t("cart.price", { value: formatMoney(total, money) })}
                </span>
              ) : null}
            </div>

            <span style={{ font: "400 15px/20px var(--font-ui)", color: "var(--fg-3)" }}>
              {pickupPolicy.limited
                ? t("cart.limitFooter", { limit, remaining })
                : t("cart.unlimitedFooter")}
            </span>

            <button
              className="kiosk-control"
              type="button"
              disabled={!submittable}
              onClick={() => {
                if (canSubmit(state, cartContext)) onSubmit(state);
              }}
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
            className="kiosk-control"
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
