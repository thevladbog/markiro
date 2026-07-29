import { XMLParser } from "fast-xml-parser";

/**
 * One `<Товар>` from a CommerceML catalog (`import*.xml`).
 * `externalRef` is `<Ид>` -- 1С's own identifier for the item, not its name.
 * Nothing here decides whether the item is new, matched, or hidden; that is
 * for the caller (candidate-matching is later work).
 */
export interface ParsedItem {
  externalRef: string;
  name: string;
  article: string | null;
  unit: string | null;
}

export interface ParsedCatalog {
  items: ParsedItem[];
}

/**
 * One `<Цена>` under a `<Предложение>`. `type` is the price type's own label
 * (e.g. "Розничная", "Закупочная") -- CommerceML carries several price types
 * per offer, and this parser is not the place that picks which one is "the"
 * price. That choice belongs to the caller.
 *
 * 1С's built-in web exchange writes the label straight onto the price as
 * `<Представление>`, but the typical configurations (УТ, Розница,
 * Бухгалтерия) instead put a `<ИдТипЦены>` GUID on the price and declare the
 * name once in the document-level `<ТипыЦен>` catalog (see
 * `ParsedOffers.priceTypes`). `type` is resolved from whichever form is
 * present -- inline label first, catalog lookup second -- so callers never
 * have to think about which shape a given file used.
 *
 * `typeRef` carries the raw `<ИдТипЦены>` GUID whenever the price had one,
 * regardless of whether it resolved. This is what makes an *unresolvable*
 * reference distinguishable from *no type at all*: both leave `type: ""`,
 * but only the former leaves `typeRef` set. `typeRef` is `undefined` (not
 * `null`) when the price never carried a `<ИдТипЦены>`, because `null` would
 * be a real, present-but-empty value and this is the absence of one.
 */
export interface ParsedOfferPrice {
  type: string;
  typeRef?: string | undefined;
  value: string;
  currency: string;
}

/** One `<Предложение>` from a CommerceML offer pack (`offers*.xml`). */
export interface ParsedOffer {
  externalRef: string;
  prices: ParsedOfferPrice[];
}

export interface ParsedOffers {
  offers: ParsedOffer[];
  /**
   * The document's `<ТипыЦен>` catalog, as GUID -> `<Наименование>`.
   * Declared once per document (under `<ПакетПредложений>`), not per price,
   * so it is returned alongside `offers` rather than duplicated onto every
   * `ParsedOfferPrice`. Already used to resolve `ParsedOfferPrice.type`
   * where possible; exposed here too so a caller can look up a `typeRef`
   * that failed to resolve (e.g. to report *which* GUID was unknown).
   */
  priceTypes: Record<string, string>;
}

/**
 * Tags that repeat under their parent and must always come back as an array,
 * even when a file happens to carry exactly one. Without this, fast-xml-parser
 * hands back a bare object for a single `<Товар>` and an array for two or
 * more, and every caller would need to special-case the singular shape.
 */
const REPEATING_TAGS = new Set(["Товар", "Предложение", "Цена", "ТипЦены"]);

/**
 * 1С defaults to windows-1251 and only ever declares its real encoding in the
 * XML prolog -- guessing (or hardcoding utf-8) turns every Cyrillic byte into
 * mojibake. The declaration itself is pure ASCII, so it is always safe to
 * read the first bytes as latin1 (a 1:1 byte<->codepoint mapping) purely to
 * locate `encoding="..."`; the *body* is then decoded with the declared
 * encoding, never with latin1.
 */
function declaredEncoding(bytes: Buffer): string {
  const head = bytes.subarray(0, 200).toString("latin1");
  const match = /encoding\s*=\s*["']([^"']+)["']/i.exec(head);
  return match?.[1]?.trim() || "utf-8";
}

function decode(bytes: Buffer): string {
  const encoding = declaredEncoding(bytes);
  return new TextDecoder(encoding).decode(bytes);
}

/**
 * Parses `bytes` into the raw fast-xml-parser tree, first decoding per the
 * declared encoding. Malformed XML must not fail silently -- the message
 * this throws ends up in the integration journal, read by a 1С specialist on
 * the client's side, so it names CommerceML and gives a position rather than
 * a bare parser error.
 */
function parseXml(bytes: Buffer): unknown {
  const xml = decode(bytes);
  const parser = new XMLParser({
    ignoreAttributes: true,
    // Keep every leaf value a raw string: CommerceML prices like "89.90" or
    // codes like "0000" must round-trip exactly, not get coerced to numbers.
    parseTagValue: false,
    isArray: (tagName) => REPEATING_TAGS.has(tagName),
  });
  try {
    return parser.parse(xml, true);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`CommerceML: не удалось разобрать XML (${detail})`, { cause });
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** Walks a dot-path of tag names, returning `{}` at any missing step. */
function dig(root: unknown, ...path: string[]): Record<string, unknown> {
  let current = asObject(root);
  for (const step of path) {
    current = asObject(current[step]);
  }
  return current;
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function optionalTextOf(value: unknown): string | null {
  const text = textOf(value);
  return text === "" ? null : text;
}

/** `parseCatalog(bytes)` -- reads `<Каталог><Товары><Товар>` entries. */
export function parseCatalog(bytes: Buffer): ParsedCatalog {
  const root = parseXml(bytes);
  const goods = dig(root, "КоммерческаяИнформация", "Каталог", "Товары");
  const rawItems = goods["Товар"];
  const items = (Array.isArray(rawItems) ? rawItems : []).map((raw): ParsedItem => {
    const item = asObject(raw);
    return {
      externalRef: textOf(item["Ид"]),
      name: textOf(item["Наименование"]),
      article: optionalTextOf(item["Артикул"]),
      unit: optionalTextOf(item["БазоваяЕдиница"]),
    };
  });
  return { items };
}

/**
 * Reads the document-level `<ТипыЦен>` catalog into a GUID -> name table.
 * Declared once under `<ПакетПредложений>`, sibling to `<Предложения>`, so
 * it is parsed independently of any single offer or price.
 */
function parsePriceTypes(root: unknown): Record<string, string> {
  const container = dig(root, "КоммерческаяИнформация", "ПакетПредложений", "ТипыЦен");
  const rawTypes = container["ТипЦены"];
  const table: Record<string, string> = {};
  for (const raw of Array.isArray(rawTypes) ? rawTypes : []) {
    const entry = asObject(raw);
    const id = textOf(entry["Ид"]);
    if (id === "") continue;
    table[id] = textOf(entry["Наименование"]);
  }
  return table;
}

/** `parseOffers(bytes)` -- reads `<ПакетПредложений><Предложения><Предложение>` entries. */
export function parseOffers(bytes: Buffer): ParsedOffers {
  const root = parseXml(bytes);
  const priceTypes = parsePriceTypes(root);
  const listing = dig(root, "КоммерческаяИнформация", "ПакетПредложений", "Предложения");
  const rawOffers = listing["Предложение"];
  const offers = (Array.isArray(rawOffers) ? rawOffers : []).map((raw): ParsedOffer => {
    const offer = asObject(raw);
    const rawPrices = asObject(offer["Цены"])["Цена"];
    const prices = (Array.isArray(rawPrices) ? rawPrices : []).map((rawPrice): ParsedOfferPrice => {
      const price = asObject(rawPrice);
      const inline = textOf(price["Представление"]);
      const typeRef = optionalTextOf(price["ИдТипЦены"]) ?? undefined;
      // Inline label wins when present -- it is what 1С's built-in exchange
      // form writes. Only consult the <ТипыЦен> catalog when there is no
      // inline label to use; if the GUID isn't in the catalog either, `type`
      // stays "" but `typeRef` (set above) still records the GUID that
      // failed to resolve, so this case is never confused with a price that
      // carried no type information at all.
      const type =
        inline !== "" ? inline : typeRef !== undefined ? (priceTypes[typeRef] ?? "") : "";
      return {
        type,
        typeRef,
        value: textOf(price["ЦенаЗаЕдиницу"]),
        currency: textOf(price["Валюта"]),
      };
    });
    return { externalRef: textOf(offer["Ид"]), prices };
  });
  return { offers, priceTypes };
}
