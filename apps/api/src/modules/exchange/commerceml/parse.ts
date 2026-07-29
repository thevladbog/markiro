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
 */
export interface ParsedOfferPrice {
  type: string;
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
}

/**
 * Tags that repeat under their parent and must always come back as an array,
 * even when a file happens to carry exactly one. Without this, fast-xml-parser
 * hands back a bare object for a single `<Товар>` and an array for two or
 * more, and every caller would need to special-case the singular shape.
 */
const REPEATING_TAGS = new Set(["Товар", "Предложение", "Цена"]);

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

/** `parseOffers(bytes)` -- reads `<ПакетПредложений><Предложения><Предложение>` entries. */
export function parseOffers(bytes: Buffer): ParsedOffers {
  const root = parseXml(bytes);
  const listing = dig(root, "КоммерческаяИнформация", "ПакетПредложений", "Предложения");
  const rawOffers = listing["Предложение"];
  const offers = (Array.isArray(rawOffers) ? rawOffers : []).map((raw): ParsedOffer => {
    const offer = asObject(raw);
    const rawPrices = asObject(offer["Цены"])["Цена"];
    const prices = (Array.isArray(rawPrices) ? rawPrices : []).map((rawPrice): ParsedOfferPrice => {
      const price = asObject(rawPrice);
      return {
        type: textOf(price["Представление"]),
        value: textOf(price["ЦенаЗаЕдиницу"]),
        currency: textOf(price["Валюта"]),
      };
    });
    return { externalRef: textOf(offer["Ид"]), prices };
  });
  return { offers };
}
