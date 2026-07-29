import type { ParsedItem, ParsedOffer } from "./parse";

/**
 * The reference currency `products.unit_price` is kept in. Per spec §4.3, a
 * price quoted in anything else is never applied -- there is no conversion
 * step in this exchange, only a refusal recorded for the journal.
 */
const HOME_CURRENCY = "руб";

/** A product this connection already links to a 1С `<Ид>`, looked up ahead of time by the caller (DB access is its job, not this one). */
export interface KnownProduct {
  id: string;
  externalRef: string;
}

export interface PriceUpdate {
  productId: string;
  unitPrice: string;
}

/**
 * Why an offer's price was not applied. Both reasons stand for "we cannot
 * tell which of the incoming prices is the right one" -- the first because
 * nothing said so, the second because the one thing that did (the connection
 * setting) doesn't match anything in this offer. Guessing is off the table
 * either way: see the comment on `choosePrice`.
 */
export type SkipReason =
  "ambiguous_price_type" | "configured_price_type_not_found" | "foreign_currency";

export interface SkippedOffer {
  externalRef: string;
  reason: SkipReason;
  /**
   * The distinct price types (`ParsedOfferPrice.type`, in order of first
   * appearance) that arrived on this offer. Per spec §4.3, the journal must
   * say which types showed up whenever the price was ambiguous -- this is
   * exactly what tells an administrator what to type into the connection's
   * configured price type. Present only for the two "couldn't pick a price"
   * reasons (`ambiguous_price_type`, `configured_price_type_not_found`);
   * absent for `foreign_currency`, which isn't a type-selection problem.
   */
  priceTypes?: string[];
}

export interface ApplicationPlan {
  priceUpdates: PriceUpdate[];
  candidates: ParsedItem[];
  skipped: SkippedOffer[];
}

export interface DecideApplicationInput {
  /** Products already linked to a 1С GUID for this connection. */
  known: KnownProduct[];
  /** `<Товар>` entries from the catalog file -- source of unmatched candidates. */
  items: ParsedItem[];
  /** `<Предложение>` entries from the offers file -- source of price updates. */
  offers: ParsedOffer[];
  /** The connection's configured price type name, if one was set. */
  configuredPriceType?: string | undefined;
}

type PriceChoice =
  | { ok: true; price: ParsedOffer["prices"][number] }
  | {
      ok: false;
      reason: "ambiguous_price_type" | "configured_price_type_not_found";
      priceTypes: string[];
    };

/** The distinct `type` labels among `prices`, in order of first appearance. */
function distinctPriceTypes(prices: ParsedOffer["prices"]): string[] {
  return [...new Set(prices.map((price) => price.type))];
}

/**
 * Picks the one price to apply out of an offer's `prices`, or explains why
 * none can be picked. Never guesses: spec §4.3 is explicit that proposing a
 * price when the type is unclear will eventually hand a kiosk a purchase
 * price instead of retail, so ambiguity is a hard stop, not a "pick the
 * first one" fallback.
 *
 * `configuredPriceType`, when set, always wins: every offer is searched for
 * a price of that type, no matter how many prices it carries. A lone price
 * of the *wrong* type is exactly the case the setting exists to catch --
 * taking it anyway (as a size-1 shortcut once did) would silently hand
 * `unit_price` a purchase price on a connection configured for retail. Only
 * when no `configuredPriceType` was set at all does the "how many distinct
 * types arrived" question take over: one distinct type (whether carried by
 * one price record or several identical ones) is taken as-is, more than one
 * is `ambiguous_price_type`.
 *
 * `ParsedOfferPrice.type` is `""` both when the price carried an
 * `<ИдТипЦены>` that failed to resolve to a name (`typeRef` set) and when it
 * carried no type reference at all (`typeRef` undefined) -- see parse.ts.
 * This function deliberately does not distinguish the two: either way there
 * is no name to compare against `configuredPriceType`. The `typeRef` itself
 * is a diagnostic detail for the journal (task 9's concern, once this plan
 * reaches persistence), not a selection input here.
 */
function choosePrice(
  prices: ParsedOffer["prices"],
  configuredPriceType: string | undefined,
): PriceChoice {
  if (configuredPriceType !== undefined) {
    const match = prices.find((price) => price.type === configuredPriceType);
    if (match === undefined) {
      return {
        ok: false,
        reason: "configured_price_type_not_found",
        priceTypes: distinctPriceTypes(prices),
      };
    }
    return { ok: true, price: match };
  }
  const types = distinctPriceTypes(prices);
  if (types.length > 1) {
    return { ok: false, reason: "ambiguous_price_type", priceTypes: types };
  }
  return { ok: true, price: prices[0]! };
}

/**
 * Pure planning step for the CommerceML intake: given what a connection
 * already knows (`known`) and what 1С just sent (`items`, `offers`), decides
 * which products get a new `unit_price`, which unmatched items become
 * catalog candidates, and which offers were refused and why. No database, no
 * HTTP -- writing the plan out is a later task.
 */
export function decideApplication(input: DecideApplicationInput): ApplicationPlan {
  const { known, items, offers, configuredPriceType } = input;
  const knownByRef = new Map(known.map((product) => [product.externalRef, product]));

  const priceUpdates: PriceUpdate[] = [];
  const skipped: SkippedOffer[] = [];

  for (const offer of offers) {
    const product = knownByRef.get(offer.externalRef);
    if (product === undefined) {
      // Not a linked product. Offers carry no name/article/unit, so unlike
      // catalog items they cannot become a candidate either -- there is
      // simply nothing this offer can do yet.
      continue;
    }
    if (offer.prices.length === 0) {
      // "Пропало из выгрузки" for prices too: no price sent this round, the
      // existing unit_price stands. Not a failure, so not journaled here.
      continue;
    }

    const choice = choosePrice(offer.prices, configuredPriceType);
    if (!choice.ok) {
      skipped.push({
        externalRef: offer.externalRef,
        reason: choice.reason,
        priceTypes: choice.priceTypes,
      });
      continue;
    }
    if (choice.price.currency !== HOME_CURRENCY) {
      skipped.push({ externalRef: offer.externalRef, reason: "foreign_currency" });
      continue;
    }
    priceUpdates.push({ productId: product.id, unitPrice: choice.price.value });
  }

  // Catalog owns product creation, not the exchange -- an item without a
  // known link is a candidate for a human to resolve, never an auto-create.
  const candidates = items.filter((item) => !knownByRef.has(item.externalRef));

  return { priceUpdates, candidates, skipped };
}
