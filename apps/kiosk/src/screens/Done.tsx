import { useCallback, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { BoxConflictReason, CreateOrderResultDto, OrderConflict } from "../api/types.js";
import type { CartState } from "../session/cart.js";
import { acceptedTotalKopecks, kioskOutcomeOf } from "../session/flow.js";
import { formatMoney, moneyFormat, UNPRICED } from "./money.js";

/**
 * How long the confirmation stands before the kiosk returns to the idle
 * screen. The prototype states ten seconds in words, so the number reaches the
 * copy by interpolation rather than being typed twice: a constant and a
 * sentence that disagree is a kiosk that lies to the worker about how long
 * they have.
 *
 * (The Russian line reads «через {{seconds}} секунд», which is correct for 10
 * and for every value this constant is plausibly ever set to except 1–4 and
 * 21–24. Changing it to one of those needs the copy re-read, not just the
 * number edited.)
 */
const AUTO_RESET_MS = 10_000;

export interface DoneProps {
  /** The server's answer, or null when the order was queued offline. */
  result: CreateOrderResultDto | null;
  /**
   * WHERE THE SUMMARY'S NUMBERS COME FROM: the cart exactly as `Cart` handed it
   * to `onSubmit`, carried through the shell untouched.
   *
   * It has to be this and cannot be anything else. `CreateOrderResultDto`
   * carries a count and conflicts — no reason and no prices — and an order that
   * is still queued has no `result` at all; the kiosk's own catalogue is a
   * snapshot that a refresh can replace between the submit and this screen, so
   * re-looking the items up by GTIN would price the order at whatever the
   * device believes a moment later. The cart is the only record of what the
   * worker actually handed over, at the prices they were shown while doing it.
   *
   * Narrowed to the two fields that are read: `notice` and `writeoffReasonId`
   * are cart-screen business, and a confirmation with a `notice` in its props is
   * a confirmation somebody will eventually render a banner on.
   */
  cart: Pick<CartState, "lines" | "reason">;
  /**
   * `bootstrap.config.showPrices`. Money is hidden device-wide when it is
   * false, and this screen must not be the one that leaks it back.
   */
  showPrices: boolean;
  onReset: () => void;
}

/** The words for the reason, borrowed from the screen the worker chose it on.
 * Deliberately NOT a second pair of `done.*` keys saying the same thing: the
 * chip here is a check against the button they pressed one screen ago, and two
 * dictionary entries are how «Покупка» there becomes «Покупки» here. */
const REASON: Record<CartState["reason"], string> = {
  buy: "cart.reasonBuy",
  writeoff: "cart.reasonWriteoff",
};

/** The summary's own separator, like `UNPRICED`: typography, identical in every
 * language, and not worth a dictionary entry the lockstep test must police. */
const DOT = " · ";

/**
 * The line an unrecognised reason gets.
 *
 * The `Record` below is exhaustive over the DECLARED union, which is a
 * compile-time property of this repo — and `CreateOrderResultDto` crosses the
 * network unvalidated, so a reason added on the server reaches an un-updated
 * kiosk as a string this map has never heard of. The lookup then yields
 * `undefined`, and handing that to `t()` throws in test mode and renders
 * nothing in production, on the ONE screen where a crash costs the most: the
 * worker is already holding the product, and the conflict list is what tells
 * them to put it back.
 *
 * So the unknown reason still counts, still shows up as a line, and still says
 * the item was refused — only the WHY is deferred to the administrator, which
 * is honest, because at that point the kiosk genuinely does not know it.
 */
const UNRECOGNISED_REASON = "done.conflictReason.other";

/**
 * Words for every reason the DTO can carry.
 *
 * A `Record` keyed by the union rather than a template-literal lookup: adding
 * a reason to `OrderConflict` then fails the BUILD here, instead of reaching a
 * worker as a bare `over_limit` — or falling through to the generic line above,
 * which exists for the server this kiosk has not been rebuilt against and not
 * as an excuse to skip the copy.
 */
const CONFLICT_REASON: Record<OrderConflict["reason"], string> = {
  not_km: "done.conflictReason.not_km",
  incomplete: "done.conflictReason.incomplete",
  unknown_product: "done.conflictReason.unknown_product",
  not_allowed: "done.conflictReason.not_allowed",
  duplicate: "done.conflictReason.duplicate",
  over_limit: "done.conflictReason.over_limit",
};

const BOX_CONFLICT_REASON: Record<BoxConflictReason, string> = {
  unknown_box: "done.boxConflictReason.unknown_box",
  box_not_closed: "done.boxConflictReason.box_not_closed",
  box_disassembled: "done.boxConflictReason.box_disassembled",
  box_contents_changed: "done.boxConflictReason.box_contents_changed",
  mixed_product_box: "done.boxConflictReason.mixed_product_box",
  duplicate: "done.boxConflictReason.duplicate",
  over_limit: "done.boxConflictReason.over_limit",
};

/**
 * The confirmation the worker reads before walking away, and the only place
 * the kiosk ever tells them what the server made of their order.
 *
 * Three outcomes, three different headlines, and the distinction between them
 * is the whole point of this screen:
 *
 *  - **Accepted.** `result.orderNo` is the number the administrator will look
 *    the order up by, printed verbatim.
 *  - **Queued offline.** `result` is null because the server has not seen the
 *    order yet, so there IS no number — and the screen says exactly that. A
 *    placeholder in a number's shape («№ —», «№ 0») sends the worker to the
 *    administrator with something that matches no order at all.
 *  - **Refused outright.** The server answers a submission where every item
 *    conflicted with `{ orderNo: "", itemCount: 0, conflicts }` (see
 *    `pickup-orders.service.ts`). Rendering the accepted headline around that
 *    empty string produces «Заявка №  передана»: a claim that an order exists,
 *    named nothing.
 *
 * Conflicts are never swallowed. A partial acceptance that says nothing is the
 * one outcome that loses product silently — the worker leaves with bottles the
 * order does not contain, and no screen ever said so. `rawKm` is not rendered:
 * a marking code is an item of value and this screen stands in a public room.
 */
export function Done({ result, cart, showPrices, onReset }: DoneProps): React.JSX.Element {
  const { t, i18n } = useTranslation();

  // Held in a ref so the timer effect below can stay mount-only while still
  // calling the CURRENT callback — the shell composes `onReset` inline in JSX,
  // so a dependency on it would restart the ten seconds on every re-render and
  // a kiosk that re-renders often would never reset at all.
  const latest = useRef(onReset);
  useEffect(() => {
    latest.current = onReset;
  });

  /**
   * The pending auto-reset, and whether the reset has already happened.
   *
   * Both are refs because both are read and written synchronously inside an
   * event handler, before React has re-rendered — a state flag would not be
   * visible to the second half of a double tap, which is exactly the input a
   * 72px button on a kiosk gets.
   *
   * `spent` is not redundant with clearing the timer: it also swallows the
   * second of two taps. One reset per order is the invariant, and a stray
   * second one lands on whatever the shell moved to — a fresh session someone
   * else has already started.
   */
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const spent = useRef(false);

  const reset = useCallback(() => {
    if (spent.current) return;
    spent.current = true;
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    latest.current();
  }, []);

  useEffect(() => {
    timer.current = setTimeout(reset, AUTO_RESET_MS);
    // Cleared on unmount, always. A timer that outlives this screen is one
    // leaked timer per order, each still holding the shell's `onReset`: the
    // kiosk would throw the NEXT worker back to idle mid-cart, on a schedule
    // set by somebody else's order.
    return () => {
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    };
  }, [reset]);

  // An empty `orderNo` is the server's way of saying it took nothing at all,
  // not a number it forgot to send.
  const orderNo = result && result.orderNo !== "" ? result.orderNo : null;
  const refused = result !== null && orderNo === null;
  const outcome = kioskOutcomeOf(0, result, { ...cart, writeoffReasonId: null, notice: null });
  const partial = outcome.kind === "partial";
  // With a result this is the server's ACCEPTED count (`remaining.length`
  // server-side); offline it is what the worker scanned. Both are honest
  // answers to «how much is in this order», which is what the chip asks.
  const count = result
    ? result.itemCount
    : cart.lines.reduce((sum, line) => sum + line.bottleCount, 0);
  const conflicts = result?.conflicts ?? [];
  const boxConflicts = result?.boxConflicts ?? [];
  const refusedCount =
    conflicts.length + boxConflicts.reduce((sum, conflict) => sum + (conflict.bottleCount ?? 1), 0);

  const money = useMemo(() => moneyFormat(i18n.language), [i18n.language]);
  /**
   * The order's total — and `null` wherever the kiosk cannot honestly state one.
   *
   * TWO ways it goes unknown, and the second is this screen's own:
   *
   *  - an item this kiosk has no price for, which is `totalKopecks`' rule and
   *    the same «—» the cart's footer prints. Understating the number the
   *    administrator charges against is worse than not stating it;
   *  - a PARTIAL acceptance. The count above is then the server's and the
   *    prices are the device's, and nothing here says WHICH bottles the server
   *    kept — `conflicts[]` names reasons, and matching them back to cart rows
   *    would put the server's arithmetic on the device (the shell's `awaited`
   *    ref exists precisely so that never happens). Multiplying the two out
   *    would print a confident overstatement of what the worker owes.
   *
   * Offline (`result === null`) there are no conflicts to know about yet, and
   * the cart IS the order — so the sum is exactly what the worker handed over.
   */
  const total = acceptedTotalKopecks(result, cart);

  // «Покупка · 3 шт · 269,70 ₽» — design 2026-07-24 §8.3's «сводка (причина ·
  // штук · сумма)». The money half is simply absent, not blanked, on a kiosk
  // configured to hide prices.
  const summary = [t(REASON[cart.reason]), t("done.summary", { n: count })];
  if (showPrices) {
    summary.push(total === null ? UNPRICED : t("cart.price", { value: formatMoney(total, money) }));
  }

  return (
    <main className="kiosk-screen kiosk-screen--centered kiosk-done">
      {/* Decoration: the prototype's tick in a square. Hidden from assistive
          tech — everything it signals is said in words below. A refusal gets
          no tick, because nothing succeeded. */}
      <svg
        width="104"
        height="104"
        viewBox="0 0 24 24"
        fill="none"
        stroke={refused || partial ? "var(--warn-fg)" : "var(--ok-solid)"}
        strokeWidth="2"
        aria-hidden="true"
        focusable="false"
      >
        <rect x="2" y="2" width="20" height="20" />
        {refused || partial ? <path d="M12 7v6M12 16.5v.5" /> : <path d="M7 12.5l3.5 3.5L17 8.5" />}
      </svg>

      <div
        role="status"
        style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}
      >
        <h1
          style={{
            margin: 0,
            font: "700 40px/48px var(--font-ui)",
            textAlign: "center",
            maxWidth: 900,
          }}
        >
          {orderNo !== null
            ? t("done.title", { order: orderNo })
            : refused
              ? t("done.titleRefused")
              : t("done.titleQueued")}
        </h1>
        {/* Two elements, one sentence: the design breaks the line after
            «заявку», and a dictionary entry carrying markup would push that
            break past every future translator — the rule `Cart` follows. */}
        <p
          style={{
            margin: 0,
            font: "400 20px/30px var(--font-ui)",
            color: "var(--fg-2)",
            textAlign: "center",
            maxWidth: 720,
          }}
        >
          {refused ? (
            <span style={{ display: "block" }}>{t("done.refusedHint")}</span>
          ) : (
            <>
              <span style={{ display: "block" }}>{t("done.subtitle")}</span>
              <span style={{ display: "block" }}>{t("done.subtitleTail")}</span>
              {/* Queued only, and the honest half of this screen.
                  `conflicts[]` is the SERVER's verdict, so offline there is
                  none: an order over the day limit, a duplicate code, a product
                  this kiosk does not issue — every one of them renders as
                  nothing at all, while the same worker online would at least
                  read «Не приняли N шт». One sentence, in the subtitle's own
                  voice rather than an alert, because the handover did succeed
                  and the confirmation must not become a warning screen. */}
              {result === null ? (
                <span style={{ display: "block" }}>{t("done.queuedCheck")}</span>
              ) : null}
            </>
          )}
        </p>
      </div>

      {/* Skipped at zero: «0 шт в заявке» under a headline that already says
          nothing was accepted is noise, not information. */}
      {count > 0 ? (
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            height: 52,
            padding: "0 24px",
            borderRadius: 10,
            background: "var(--surface-card)",
            border: "1px solid var(--line)",
            font: "600 20px/1 var(--font-mono)",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {summary.join(DOT)}
        </span>
      ) : null}

      {refusedCount > 0 ? (
        // `role="alert"`, like `Cart`'s banner: this is the one thing on the
        // screen the worker must not walk past.
        <div
          className="kiosk-done__conflicts"
          role="alert"
          style={{
            maxWidth: 720,
            boxSizing: "border-box",
            display: "flex",
            flexDirection: "column",
            gap: 10,
            padding: "18px 24px",
            borderRadius: 12,
            background: "var(--warn-bg)",
            border: "1px solid var(--warn-border)",
            textAlign: "left",
          }}
        >
          <span style={{ font: "700 22px/28px var(--font-ui)", color: "var(--warn-fg)" }}>
            {t("done.conflictsTitle", { n: refusedCount })}
          </span>
          <ul
            style={{
              listStyle: "disc",
              margin: 0,
              paddingInlineStart: 24,
              font: "400 18px/26px var(--font-ui)",
              color: "var(--fg-2)",
            }}
          >
            {conflicts.map((item, index) => (
              // The index is part of the key because the same code can legally
              // appear twice in one submission (that is what `duplicate`
              // means), so `rawKm` alone is not unique. Nothing here reorders,
              // so an index key is stable for this list's whole lifetime.
              <li key={`${item.rawKm}-${item.reason}-${index}`}>
                {t(CONFLICT_REASON[item.reason] ?? UNRECOGNISED_REASON)}
              </li>
            ))}
            {boxConflicts.map((box, index) => (
              <li key={`${box.sscc}-${box.reason}-${index}`}>
                {t(BOX_CONFLICT_REASON[box.reason] ?? "done.boxConflictReason.other", {
                  n: box.bottleCount ?? 1,
                })}
              </li>
            ))}
          </ul>
          <span style={{ font: "400 17px/24px var(--font-ui)", color: "var(--fg-2)" }}>
            {t("done.conflictsHint")}
          </span>
        </div>
      ) : null}

      <button
        className="kiosk-control"
        type="button"
        onClick={reset}
        style={{
          height: 72,
          padding: "0 48px",
          borderRadius: 12,
          border: "1px solid var(--line-strong)",
          background: "var(--surface-card)",
          color: "var(--fg-1)",
          font: "600 22px/1 var(--font-ui)",
        }}
      >
        {t("done.reset")}
      </button>

      <p style={{ margin: 0, font: "400 15px/20px var(--font-ui)", color: "var(--fg-3)" }}>
        {t("done.autoReset", { seconds: AUTO_RESET_MS / 1000 })}
      </p>
    </main>
  );
}
