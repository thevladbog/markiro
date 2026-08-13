import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Modal } from "@markiro/ui";
import type { KioskBootstrapSnapshotDto } from "../api/types.js";
import { classifyKioskScan } from "../domain-guard/classify.js";
import type { ScanListener } from "../scanner/source.js";
import {
  canSubmit,
  bottleCount,
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
import { pageSizeFor } from "../session/pagination.js";
// The money rules live beside the two screens that print money, so the cart and
// the confirmation that summarises it cannot drift apart on a separator or a
// rounding step.
import { formatMoney, moneyFormat, toKopecks, totalKopecks, UNPRICED } from "./money.js";
import { CartLineDialog } from "../ui/CartLineDialog.js";
import { ItemKindIcon } from "../ui/ItemKindIcon.js";
import { PagedLines } from "../ui/PagedLines.js";

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

  const limit = pickupPolicy.dayLimit;
  const showPrices = bootstrap.config.showPrices;
  const count = state.lines.length;
  const remaining = remainingToday(state, cartContext);
  const total = totalKopecks(state.lines);
  const bannerKey = notice ? BANNER[notice.kind] : undefined;
  const submittable = canSubmit(state, cartContext);
  const bottles = bottleCount(state);
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<KioskCartLine | null>(null);
  const pageSize = pageSizeFor(window.innerWidth, window.innerHeight);
  const summary = t("cart.summary", {
    positions: t("cart.positions", { count }),
    bottles: t("cart.bottles", { count: bottles }),
  });

  return (
    <main className="kiosk-screen kiosk-cart" data-orientation={orientation}>
      <header className="kiosk-cart__header">
        <span className="kiosk-cart__wordmark">{t("cart.logo")}</span>
        <span className="kiosk-cart__employee" title={employee.fullName}>
          <span aria-hidden="true" className="kiosk-cart__initials">
            {initialsOf(employee.fullName)}
          </span>
          <span className="kiosk-cart__employee-name">{employee.fullName}</span>
        </span>
        <button className="kiosk-control kiosk-cart__not-me" type="button" onClick={onNotMe}>
          {t("cart.notMe")}
        </button>
      </header>

      {bannerKey ? (
        <div className="kiosk-cart__banner" role="alert">
          {t(bannerKey)}
        </div>
      ) : null}

      <div className="kiosk-cart__workspace">
        <section className="kiosk-cart__scan" aria-label={t("cart.scanRegion")}>
          <div
            className={
              remaining === 0 ? "kiosk-scan-card kiosk-scan-card--limit" : "kiosk-scan-card"
            }
            role={remaining === 0 ? "status" : undefined}
          >
            <svg
              className="kiosk-scan-card__icon"
              viewBox="0 0 24 24"
              aria-hidden="true"
              focusable="false"
            >
              <path d="M3 7V3h4M17 3h4v4M21 17v4h-4M7 21H3v-4M7 12h10" />
            </svg>
            <div className="kiosk-scan-card__copy">
              <strong>
                {remaining === 0 ? t("cart.limitTitle", { limit }) : t("cart.scanTitle")}
              </strong>
              <span>{remaining === 0 ? t("cart.limitHint") : t("cart.scanTitleTarget")}</span>
              {remaining === 0 ? null : <small>{t("cart.scanHint")}</small>}
            </div>
          </div>

          <div className="kiosk-cart__legacy-operation" aria-label={t("cart.reason")}>
            {(pickupPolicy.canWriteoff ? (["buy", "writeoff"] as const) : (["buy"] as const)).map(
              (reason) => (
                <button
                  className="kiosk-control kiosk-cart__operation-button"
                  key={reason}
                  type="button"
                  aria-pressed={state.reason === reason}
                  onClick={() => dispatch({ type: "reason", reason })}
                >
                  {t(reason === "buy" ? "cart.reasonBuy" : "cart.reasonWriteoff")}
                </button>
              ),
            )}
            {pickupPolicy.canWriteoff && state.reason === "writeoff"
              ? bootstrap.reasons.map((reason) => (
                  <button
                    className="kiosk-control kiosk-cart__reason-button"
                    key={reason.id}
                    type="button"
                    aria-pressed={state.writeoffReasonId === reason.id}
                    onClick={() => dispatch({ type: "writeoffReason", id: reason.id })}
                  >
                    {reason.name}
                  </button>
                ))
              : null}
          </div>
        </section>

        <section className="kiosk-cart__basket" aria-labelledby="kiosk-cart-list-title">
          <header className="kiosk-cart__basket-header">
            <h1 id="kiosk-cart-list-title">{t("cart.listTitle")}</h1>
            <span>{summary}</span>
          </header>

          {count === 0 ? (
            <div className="kiosk-cart__empty">
              <strong>{t("cart.emptyTitle")}</strong>
              <span>{t("cart.emptyHint")}</span>
            </div>
          ) : (
            <PagedLines
              items={state.lines}
              pageSize={pageSize}
              page={page}
              onPageChange={setPage}
              renderItem={(item) => {
                const unitKopecks = item.unitPrice === null ? null : toKopecks(item.unitPrice);
                const kopecks = unitKopecks === null ? null : unitKopecks * item.bottleCount;
                return (
                  <button
                    className="kiosk-control kiosk-line"
                    type="button"
                    aria-label={t("cart.openLine", {
                      name: item.name,
                      quantity: t("cart.bottles", { count: item.bottleCount }),
                    })}
                    onClick={() => setSelected(item)}
                  >
                    <ItemKindIcon kind={item.kind} />
                    <span className="kiosk-line__copy">
                      <span className="kiosk-line__name" title={item.name}>
                        {item.name}
                      </span>
                      <span className="kiosk-line__code" title={codeTail(item)}>
                        {codeTail(item)}
                      </span>
                    </span>
                    <span className="kiosk-line__count">
                      {t("cart.bottles", { count: item.bottleCount })}
                    </span>
                    {showPrices ? (
                      <span className="kiosk-line__price">
                        {kopecks === null
                          ? UNPRICED
                          : t("cart.price", { value: formatMoney(kopecks, money) })}
                      </span>
                    ) : null}
                  </button>
                );
              }}
            />
          )}
        </section>
      </div>

      <footer className="kiosk-cart__checkout">
        <div className="kiosk-cart__totals">
          <strong>{summary}</strong>
          <span className="kiosk-cart__legacy-total">
            <span>{t("cart.total", { n: count })}</span>
            {showPrices ? (
              <span>
                {total === null ? UNPRICED : t("cart.price", { value: formatMoney(total, money) })}
              </span>
            ) : null}
          </span>
          <small>
            {pickupPolicy.limited
              ? t("cart.limitFooter", { limit, remaining })
              : t("cart.unlimitedFooter")}
          </small>
        </div>
        <button
          className="kiosk-control kiosk-cart__continue"
          type="button"
          disabled={!submittable}
          onClick={() => {
            if (canSubmit(state, cartContext)) onSubmit(state);
          }}
        >
          {t("cart.submit")}
        </button>
      </footer>

      <CartLineDialog
        line={selected}
        onClose={() => setSelected(null)}
        onRemove={(line) => {
          dispatch(
            line.kind === "km"
              ? { type: "remove", kmKey: line.kmKey }
              : { type: "removeBox", sscc: line.sscc },
          );
          setSelected(null);
        }}
      />

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
