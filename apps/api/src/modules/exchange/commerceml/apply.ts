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
 * Why an offer's price was not applied. `ambiguous_price_type` and
 * `configured_price_type_not_found` both stand for "we cannot tell which of
 * the incoming prices is the right one" -- the first because nothing said
 * so, the second because the one thing that did (the connection setting)
 * doesn't match anything in this offer. `foreign_currency` and
 * `invalid_price_value` are the opposite: exactly one price was picked, but
 * its own content disqualifies it -- see the comment on `choosePrice` for the
 * first pair, and `isValidUnitPriceValue` for the second.
 */
export type SkipReason =
  | "ambiguous_price_type"
  | "configured_price_type_not_found"
  | "foreign_currency"
  | "invalid_price_value";

export interface SkippedOffer {
  externalRef: string;
  reason: SkipReason;
  /**
   * The distinct prices (`ParsedOfferPrice.type`, falling back to `typeRef`
   * -- see `distinctPriceTypes` -- in order of first appearance) that arrived
   * on this offer. Per spec §4.3, the journal must say which types showed up
   * whenever the price was ambiguous -- this is exactly what tells an
   * administrator what to type into the connection's configured price type.
   * Present only for the two "couldn't pick a price" reasons
   * (`ambiguous_price_type`, `configured_price_type_not_found`); absent for
   * `foreign_currency` and `invalid_price_value`, neither of which is a
   * type-selection problem -- exactly one price WAS picked in both cases.
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

/**
 * The distinct prices among `prices`, in order of first appearance, keyed by
 * `type` when it has a name and by `typeRef` when it doesn't.
 *
 * Fix 4 (final review): keying by `price.type` alone used to collapse EVERY
 * unresolved `<ИдТипЦены>` onto the same `""` bucket, no matter how many
 * distinct GUIDs they carried -- a file whose `<ТипыЦен>` catalog lives in a
 * different upload than its offers (offers and their nomenclature commonly
 * arrive as separate files against the same session, each parsed
 * independently -- see `exchange.controller.ts`) leaves every price's
 * `<ИдТипЦены>` unresolved, so several genuinely different price types all
 * read as "one type" and `choosePrice` below took the first one as-is. That
 * is exactly the "propose a purchase price to a kiosk" failure spec §4.3
 * forbids, just reached through a different door than an outright ambiguous
 * NAME. `typeRef` is the discriminator already sitting right next to `type`
 * for exactly this case (see parse.ts's own comment on `ParsedOfferPrice`):
 * fall back to it whenever `type` is empty, so two unresolved references are
 * told apart. A price that carries genuinely neither a name nor a reference
 * (no signal at all) still collapses into the single blank bucket, unchanged
 * from before -- there is nothing left to discriminate it by.
 */
function distinctPriceTypes(prices: ParsedOffer["prices"]): string[] {
  return [
    ...new Set(prices.map((price) => (price.type !== "" ? price.type : (price.typeRef ?? "")))),
  ];
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
 * types arrived" question (`distinctPriceTypes`) take over: one distinct
 * type is taken as-is, more than one is `ambiguous_price_type`. Accepted
 * limitation this leaves open: two price records that share the same `type`
 * NAME are treated as one distinct type by that count regardless of whether
 * their VALUES agree -- nothing here compares the values themselves, so if a
 * file genuinely carries two same-named prices with different figures, the
 * first one in document order silently wins.
 *
 * `ParsedOfferPrice.type` is `""` both when the price carried an
 * `<ИдТипЦены>` that failed to resolve to a name (`typeRef` set) and when it
 * carried no type reference at all (`typeRef` undefined) -- see parse.ts.
 * Matching against `configuredPriceType` (immediately below) deliberately
 * does not distinguish the two: either way there is no NAME to compare a
 * configured name against. `distinctPriceTypes`, however, does fall back to
 * `typeRef` -- see its own comment (Fix 4) for why the ambiguity count still
 * needs that distinction even though a name-based match never will.
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
 * `products.unit_price` (packages/db/src/schema/platform.ts) is
 * `numeric(12,2)` -- 10 integer digits, 2 fractional. Anything that does not
 * fit this exact shape must be caught HERE, not by Postgres, because a
 * rejected `UPDATE` inside `exchange.controller.ts`'s `mode=import` loop
 * throws `invalid input syntax for type numeric`, which
 * `ExchangeExceptionFilter` turns into a `failure` response for the WHOLE
 * round -- the import cursor (`ExchangeSessionService.readImportCursor`)
 * never advances past the bad row, and 1С resubmits the identical file on
 * its next tick, reproducing the exact same failure forever. One bad price
 * must be a skip, exactly like a foreign currency, not a stuck cursor.
 *
 * Three shapes `parse.ts`'s `textOf` can hand back that this catches: an
 * empty string (`<ЦенаЗаЕдиницу>` present but empty, or absent entirely --
 * see parse.ts), a comma decimal separator (`"89,90"`, the RU locale 1С's
 * own operator UI would show, but never what CommerceML's numeric fields
 * use), and a value whose integer part is too wide for 10 digits (a data
 * error upstream, or a stray extra zero). All three, and anything else that
 * isn't a plain `\d{1,10}(\.\d{1,2})?`, come back `false`.
 */
const UNIT_PRICE_PATTERN = /^\d{1,10}(\.\d{1,2})?$/;

function isValidUnitPriceValue(value: string): boolean {
  return UNIT_PRICE_PATTERN.test(value);
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
    if (!isValidUnitPriceValue(choice.price.value)) {
      // Fix 3 (final review): the same treatment as a foreign currency --
      // this one offer is refused, the rest of the round keeps moving. See
      // `isValidUnitPriceValue`'s own comment for why this check cannot be
      // skipped in favour of letting Postgres reject the write.
      skipped.push({ externalRef: offer.externalRef, reason: "invalid_price_value" });
      continue;
    }
    priceUpdates.push({ productId: product.id, unitPrice: choice.price.value });
  }

  // Catalog owns product creation, not the exchange -- an item without a
  // known link is a candidate for a human to resolve, never an auto-create.
  const candidates = items.filter((item) => !knownByRef.has(item.externalRef));

  return { priceUpdates, candidates, skipped };
}
