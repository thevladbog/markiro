import { isValidGtin, normalizeToGtin14 } from "@markiro/domain";
import type { ParsedItem, ParsedOffer } from "./parse";

/**
 * The reference currency `products.unit_price` is kept in. Per spec §4.3, a
 * price quoted in anything else is never applied -- there is no conversion
 * step in this exchange, only a refusal recorded for the journal.
 *
 * Review fix (PR #32, item 3): a bare `"руб"` literal used to be the only accepted
 * spelling. Which of these a real export uses depends on the 1С
 * configuration, not on anything this connection controls -- `руб` (typed
 * label), `руб.` (with the period Russian abbreviations conventionally take),
 * `RUB` (ISO 4217 alpha code), and `643` (ISO 4217 numeric code) are all the
 * SAME currency, and a channel that only recognised one spelling was silently
 * refusing every price from a 1С configuration that happened to use another
 * -- indistinguishable, from the journal, from a genuinely foreign currency.
 * Genuinely foreign currencies (`USD`, `978`/EUR, ...) are still refused:
 * this is a closed set of RUB spellings, not a loosened comparison.
 */
const HOME_CURRENCY_ALIASES = new Set(["руб", "руб.", "rub", "643"]);

/** Case/whitespace-insensitive membership check against `HOME_CURRENCY_ALIASES`. */
function isHomeCurrency(currency: string): boolean {
  return HOME_CURRENCY_ALIASES.has(currency.trim().toLowerCase());
}

/**
 * One tenant product, as looked up ahead of time by the caller (DB access is
 * its job, not this one) -- ALL of them, not just the ones already linked to
 * a 1С `<Ид>`. GTIN-based auto-link (below) needs the whole catalog: a
 * product's `gtin14` might match an incoming item's barcode long before that
 * product ever got an `externalRef` at all.
 */
export interface CatalogProduct {
  id: string;
  gtin14: string;
  externalRef: string | null;
}

/** A new `products.external_ref` link this round's GTIN match decided on. */
export interface AutoLink {
  productId: string;
  externalRef: string;
  gtin: string;
}

/** One `<Картинка>` to fetch and attach to `productId` -- see the loop that builds `ApplicationPlan.images`. */
export interface ImageWork {
  productId: string;
  source: string;
}

/**
 * An unmatched `<Товар>`, same shape as the old plain `ParsedItem` candidate
 * plus its own normalized `gtin` (`null` when the item carried no usable
 * barcode) -- so a human resolving this candidate can see the GTIN this
 * round already computed, without recomputing it.
 */
export interface CandidateItem {
  externalRef: string;
  name: string;
  article: string | null;
  unit: string | null;
  gtin: string | null;
}

/**
 * An incoming item's GTIN matched a catalog product that is already linked
 * to a DIFFERENT `<Ид>` -- see the comment inside `decideApplication` where
 * this is built. Not auto-resolved: only a human can say which of the two
 * `<Ид>`s the product actually belongs to.
 */
export interface GtinConflict {
  externalRef: string;
  gtin: string;
  productId: string;
  productExternalRef: string;
}

/** Two or more incoming items claimed the SAME GTIN this round -- see `decideApplication`'s `claimants` map. Neither is auto-linked. */
export interface GtinAmbiguity {
  gtin: string;
  externalRefs: string[];
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
 * first pair, and `normalizeUnitPriceValue` for the second.
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
  links: AutoLink[];
  priceUpdates: PriceUpdate[];
  images: ImageWork[];
  candidates: CandidateItem[];
  skipped: SkippedOffer[];
  gtinConflicts: GtinConflict[];
  gtinAmbiguities: GtinAmbiguity[];
  invalidBarcodes: number;
}

export interface DecideApplicationInput {
  /** ВСЕ карточки тенанта, не только связанные -- GTIN matching needs the whole catalog (see `CatalogProduct`). */
  products: CatalogProduct[];
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
 * Three shapes `parse.ts`'s `textOf` can hand back that this still catches:
 * an empty string (`<ЦенаЗаЕдиницу>` present but empty, or absent entirely --
 * see parse.ts), a comma decimal separator (`"89,90"`, the RU locale 1С's own
 * operator UI would show, but never what CommerceML's numeric fields use),
 * and a value whose integer part is too wide for 10 digits (a data error
 * upstream, or a stray extra zero).
 *
 * Review fix (PR #32, item 2 -- regression): a typed 1С configuration commonly
 * exports `<ЦенаЗаЕдиницу>` with FOUR fractional digits (`"89.9000"`), not
 * two -- the previous pattern (`\.\d{1,2}` only) rejected every one of these
 * as `invalid_price_value`, turning a routine, well-formed export into a
 * file-wide string of skips. `numeric(12,2)` itself already rounds a value
 * with more than two fractional digits on write (confirmed directly against
 * Postgres: `89.9000` -> `89.90`, `89.905` -> `89.91`, half rounds up, an
 * overflowing integer part still raises `numeric field overflow` exactly as
 * before) -- so accepting extra fractional digits here does not, on its own,
 * change what ends up stored. Rounding is still done HERE, not left to
 * Postgres, so `PriceUpdate.unitPrice` -- what this pure function actually
 * hands back, asserted directly in `commerceml-apply.test.ts` with no
 * database involved -- already reads the value that lands on the row,
 * rather than a figure only `numeric(12,2)`'s own silent cast would produce.
 */
const UNIT_PRICE_PATTERN = /^(\d{1,10})(?:\.(\d+))?$/;

/** Adds 1 to a string of decimal digits; used by `normalizeUnitPriceValue`'s carry step. */
function incrementDecimalDigitString(digits: string): string {
  const chars = digits.split("");
  let carry = 1;
  for (let i = chars.length - 1; i >= 0 && carry > 0; i--) {
    const next = Number(chars[i]) + carry;
    chars[i] = String(next % 10);
    carry = next >= 10 ? 1 : 0;
  }
  return (carry > 0 ? "1" : "") + chars.join("");
}

/**
 * Accepts `value` as a `numeric(12,2)`-bound price and returns the exact
 * string that should be written, rounded to two fractional digits -- half
 * rounds up, matching `numeric(12,2)`'s own observed rounding (see this
 * section's own comment). Returns `null` for anything `UNIT_PRICE_PATTERN`
 * doesn't match at all, AND for the one case rounding can itself create: an
 * integer part already at the 10-digit ceiling whose fractional part rounds
 * up into an 11th digit (e.g. `"9999999999.995"`) would still overflow
 * `numeric(12,2)` after rounding, so it is refused here rather than handed to
 * Postgres as a value that looks accepted only to fail the write.
 */
function normalizeUnitPriceValue(value: string): string | null {
  const match = UNIT_PRICE_PATTERN.exec(value);
  if (!match) return null;
  const [, integerPart, fractionalPart = ""] = match;

  if (fractionalPart.length <= 2) {
    return fractionalPart.length === 0 ? integerPart! : `${integerPart}.${fractionalPart}`;
  }

  const kept = fractionalPart.slice(0, 2);
  const roundUp = fractionalPart.charCodeAt(2) >= "5".charCodeAt(0);
  if (!roundUp) {
    return `${integerPart}.${kept}`;
  }

  const roundedKept = incrementDecimalDigitString(kept);
  if (roundedKept.length > 2) {
    // Carried out of the fractional part (".99" -> "100"): the integer part
    // itself absorbs the extra one.
    const roundedInteger = incrementDecimalDigitString(integerPart!);
    if (roundedInteger.length > 10) return null; // would overflow numeric(12,2)
    return `${roundedInteger}.${roundedKept.slice(1)}`;
  }
  return `${integerPart}.${roundedKept}`;
}

/**
 * `null` вместо исключения: для обмена невалидный штрихкод — «штрихкода
 * нет», а не ошибка файла (одна кривая позиция не рушит раунд). Проверка
 * длины (8/12/13/14) и контрольной цифры — целиком в @markiro/domain,
 * второй GTIN-валидатор в кодовой базе не заводится.
 */
function normalizeGtinOrNull(raw: string): string | null {
  const digits = raw.trim();
  return isValidGtin(digits) ? normalizeToGtin14(digits) : null;
}

/**
 * Pure planning step for the CommerceML intake: given ALL of a tenant's
 * catalog products (`products`) and what 1С just sent (`items`, `offers`),
 * decides which products get a new `unit_price`, which unmatched items
 * become catalog candidates, which get auto-linked by GTIN, which photos to
 * fetch, and which offers were refused and why. No database, no HTTP --
 * writing the plan out is a later task.
 */
export function decideApplication(input: DecideApplicationInput): ApplicationPlan {
  const { products, items, offers, configuredPriceType } = input;

  const knownByRef = new Map<string, CatalogProduct>();
  for (const product of products) {
    if (product.externalRef !== null) knownByRef.set(product.externalRef, product);
  }
  const productsByGtin = new Map(products.map((p) => [p.gtin14, p]));

  // Штрихкод предложения — запасной источник: некоторые конфигурации кладут
  // его только в offers-файл. Первый выигрывает — как и везде в этом файле.
  const offerBarcodeByRef = new Map<string, string>();
  for (const offer of offers) {
    if (offer.barcode !== null && !offerBarcodeByRef.has(offer.externalRef)) {
      offerBarcodeByRef.set(offer.externalRef, offer.barcode);
    }
  }

  // GTIN считается только для НЕсвязанных позиций: у связанных он ничего не
  // решает (связь уже есть), а его расхождение с карточкой — вне среза.
  let invalidBarcodes = 0;
  const gtinByRef = new Map<string, string>();
  const unmatchedItems = items.filter((item) => !knownByRef.has(item.externalRef));
  for (const item of unmatchedItems) {
    const raw = item.barcode ?? offerBarcodeByRef.get(item.externalRef) ?? null;
    if (raw === null) continue;
    const gtin = normalizeGtinOrNull(raw);
    if (gtin === null) {
      invalidBarcodes++;
      continue;
    }
    gtinByRef.set(item.externalRef, gtin);
  }

  // Претенденты по каждому GTIN, у которого ЕСТЬ карточка. Двое и больше —
  // не угадываем (та же дисциплина, что ambiguous_price_type): все в
  // кандидаты, а факт — в журнал. GTIN без карточки в это вообще не входит:
  // там нечего связывать, дубль в файле — просто два кандидата.
  const claimants = new Map<string, string[]>();
  for (const [ref, gtin] of gtinByRef) {
    if (!productsByGtin.has(gtin)) continue;
    const list = claimants.get(gtin) ?? [];
    list.push(ref);
    claimants.set(gtin, list);
  }

  const links: AutoLink[] = [];
  const gtinConflicts: GtinConflict[] = [];
  const gtinAmbiguities: GtinAmbiguity[] = [];
  const linkedByRef = new Map<string, CatalogProduct>();
  for (const [gtin, refs] of claimants) {
    if (refs.length > 1) {
      gtinAmbiguities.push({ gtin, externalRefs: refs });
      continue;
    }
    const ref = refs[0]!;
    const product = productsByGtin.get(gtin)!;
    if (product.externalRef !== null) {
      // Карточка уже связана с ДРУГИМ <Ид> (с этим же — была бы в knownByRef,
      // и позиция не попала бы в unmatchedItems). Решает человек.
      gtinConflicts.push({
        externalRef: ref,
        gtin,
        productId: product.id,
        productExternalRef: product.externalRef,
      });
      continue;
    }
    links.push({ productId: product.id, externalRef: ref, gtin });
    linkedByRef.set(ref, product);
  }

  // Цены: давно связанные ПЛЮС связанные этим же раундом — «связь раньше
  // цены» из спеки §8 начинается уже здесь, в плане.
  const priceTargetByRef = new Map([...knownByRef, ...linkedByRef]);

  const priceUpdates: PriceUpdate[] = [];
  const skipped: SkippedOffer[] = [];
  for (const offer of offers) {
    const product = priceTargetByRef.get(offer.externalRef);
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
    if (!isHomeCurrency(choice.price.currency)) {
      skipped.push({ externalRef: offer.externalRef, reason: "foreign_currency" });
      continue;
    }
    const normalizedPrice = normalizeUnitPriceValue(choice.price.value);
    if (normalizedPrice === null) {
      // Review fix (PR #32, item 2): the same treatment as a foreign currency --
      // this one offer is refused, the rest of the round keeps moving. See
      // `normalizeUnitPriceValue`'s own comment for why this check cannot be
      // skipped in favour of letting Postgres reject the write.
      skipped.push({ externalRef: offer.externalRef, reason: "invalid_price_value" });
      continue;
    }
    priceUpdates.push({ productId: product.id, unitPrice: normalizedPrice });
  }

  // Фото — первая <Картинка> позиции, чья карточка известна (старая или
  // новая связь). Остальные картинки сознательно игнорируются (спека §1).
  const images: ImageWork[] = [];
  for (const item of items) {
    if (item.images.length === 0) continue;
    const product = knownByRef.get(item.externalRef) ?? linkedByRef.get(item.externalRef);
    if (product === undefined) continue;
    images.push({ productId: product.id, source: item.images[0]! });
  }

  // Catalog owns product creation, not the exchange -- an item without a
  // known link is a candidate for a human to resolve, never an auto-create.
  const candidates: CandidateItem[] = unmatchedItems
    .filter((item) => !linkedByRef.has(item.externalRef))
    .map((item) => ({
      externalRef: item.externalRef,
      name: item.name,
      article: item.article,
      unit: item.unit,
      gtin: gtinByRef.get(item.externalRef) ?? null,
    }));

  return {
    links,
    priceUpdates,
    images,
    candidates,
    skipped,
    gtinConflicts,
    gtinAmbiguities,
    invalidBarcodes,
  };
}
