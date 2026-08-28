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
  /** `<Штрихкод>` -- read as a single tag per CommerceML 2.05 spec.
   * If multiple Штрихкод tags are present (non-compliant), degraded to null. */
  barcode: string | null;
  /** Zero or more `<Картинка>` tags, as a list of file paths. */
  images: string[];
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
  /** `<Штрихкод>` of the offer, if present. */
  barcode: string | null;
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

/** Both sections a CommerceML file can carry, read off ONE parsed tree -- see `parseCommerceMl`. */
export interface ParsedCommerceMl {
  items: ParsedItem[];
  offers: ParsedOffer[];
  priceTypes: Record<string, string>;
}

/**
 * Tags that repeat under their parent and must always come back as an array,
 * even when a file happens to carry exactly one. Without this, fast-xml-parser
 * hands back a bare object for a single `<Товар>` and an array for two or
 * more, and every caller would need to special-case the singular shape.
 */
/**
 * "Документ" and "ЗначениеРеквизита" added for плана И-2's outgoing/incoming
 * order documents (`order-export.ts`/`order-status.ts`) -- `<ПакетДокументов>`
 * carries zero or more `<Документ>`, and each `<Документ>`'s
 * `<ЗначенияРеквизитов>` carries zero or more `<ЗначениеРеквизита>`, the same
 * shape `<Товар>`/`<Предложение>`/`<Цена>` already have here.
 */
const REPEATING_TAGS = new Set([
  "Товар",
  "Предложение",
  "Цена",
  "ТипЦены",
  "Документ",
  "ЗначениеРеквизита",
  "Картинка",
]);

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

/**
 * `declaredEncoding`'s own comment covers why the label comes straight off
 * the file. `TextDecoder`'s constructor throws a plain `RangeError` (not
 * something naming CommerceML) for a label it doesn't recognise -- an
 * attacker-controlled `encoding="..."` on this ungated route (see
 * exchange.controller.ts's class-level comment), or simply a 1С
 * configuration exporting under a label Node's ICU build doesn't carry. Any
 * throw here must reach the caller the SAME shape a genuine parse failure
 * does -- one message naming CommerceML, not a bare "Invalid encoding label"
 * that a 1С specialist reading the journal has no reason to connect to their
 * export.
 */
function decode(bytes: Buffer): string {
  const encoding = declaredEncoding(bytes);
  try {
    return new TextDecoder(encoding).decode(bytes);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`CommerceML: не удалось разобрать XML (${detail})`, { cause });
  }
}

/**
 * The five entities XML itself defines (`&lt; &gt; &amp; &quot; &apos;`),
 * plus numeric character references (`&#930;`, `&#xD2;`) -- the other form
 * XML allows for escaping a character, and one a genuine CommerceML export
 * uses too (some 1С configurations emit non-ASCII or reserved characters
 * this way rather than as a raw named entity). A single, non-recursive,
 * linear pass (`String.replace` with a global regex never re-scans text it
 * has already substituted), so this cannot itself be turned into an
 * expansion attack: there is no table of custom names to grow, nested, or
 * reference each other -- a numeric reference always resolves to exactly one
 * Unicode scalar value, never to more text that could itself contain another
 * reference. `parseXml` below turns off fast-xml-parser's own entity
 * substitution entirely (`processEntities: false`) -- this is what puts
 * these entities, which a genuine CommerceML product name legitimately needs
 * (a name containing literal `&` or `<` MUST be escaped to stay well-formed
 * XML), back without reopening the door `processEntities` closes.
 */
const PREDEFINED_XML_ENTITIES: Readonly<Record<string, string>> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
};

/**
 * XML 1.0's own `Char` production (https://www.w3.org/TR/xml/#charsets):
 * tab/LF/CR, U+0020-U+D7FF, U+E000-U+FFFD, U+10000-U+10FFFF. This is
 * narrower than "whatever `String.fromCodePoint` accepts" -- that also
 * happily builds a NUL byte or a lone UTF-16 surrogate half (U+D800-U+DFFF),
 * neither of which XML permits a document to contain at all, well-formed
 * character reference or not. Decoding one anyway would put a value in the
 * parsed tree a compliant XML processor would have rejected the document
 * for containing in the first place -- and one Postgres' own `text` columns
 * reject outright for a bare NUL byte, so an out-of-range reference here
 * would otherwise turn into a DB error several layers downstream instead of
 * being left as inert text at the one place that actually understands why.
 */
function isPermittedXmlChar(codePoint: number): boolean {
  return (
    codePoint === 0x9 ||
    codePoint === 0xa ||
    codePoint === 0xd ||
    (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
    (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
    (codePoint >= 0x10000 && codePoint <= 0x10ffff)
  );
}

function decodePredefinedXmlEntities(text: string): string {
  return text.replace(
    /&(?:(lt|gt|amp|quot|apos)|#(\d+)|#[xX]([0-9a-fA-F]+));/g,
    (match: string, name?: string, decimal?: string, hex?: string) => {
      if (name !== undefined) return PREDEFINED_XML_ENTITIES[name]!;
      const codePoint = Number.parseInt(decimal ?? hex!, decimal !== undefined ? 10 : 16);
      // Malformed, out-of-range, or otherwise-illegal references (a stray
      // `&#xFFFFFFFF;`, a NUL, a lone surrogate half) are left exactly as
      // they arrived -- this is a best-effort decode of leaf text, not a
      // validator that rejects the whole document.
      if (!isPermittedXmlChar(codePoint)) return match;
      return String.fromCodePoint(codePoint);
    },
  );
}

/**
 * Parses `bytes` into the raw fast-xml-parser tree, first decoding per the
 * declared encoding. Malformed XML must not fail silently -- the message
 * this throws ends up in the integration journal, read by a 1С specialist on
 * the client's side, so it names CommerceML and gives a position rather than
 * a bare parser error.
 *
 * Review fix (PR #32, item 1 -- Security): `bytes` arrives over `/1c_exchange`, the
 * one route in this whole API reachable with no credential at all (see
 * exchange.controller.ts's class-level comment) -- so this is the one XML
 * parse call in the codebase an anonymous caller controls end to end.
 * fast-xml-parser v5 defaults `processEntities` to `true`: a `<!DOCTYPE>`
 * carrying `<!ENTITY>` declarations gets expanded during parsing, the classic
 * "billion laughs" shape, and the library's own advisory history (several
 * GHSAs against its expansion limits, the most recent fixed only in 5.10.1 --
 * the exact version pinned here) shows those built-in limits have been
 * bypassed before. CommerceML never legitimately declares a custom entity --
 * 1С's exporter has no reason to -- so there is no feature lost by refusing
 * the whole mechanism outright rather than trusting whichever limits this
 * dependency's CURRENT version happens to enforce. `parseTagValue: false` is
 * unrelated: it keeps leaf values un-coerced strings (see its own comment),
 * not entity substitution.
 */
export function parseXml(bytes: Buffer): unknown {
  const xml = decode(bytes);
  const parser = new XMLParser({
    ignoreAttributes: true,
    // Keep every leaf value a raw string: CommerceML prices like "89.90" or
    // codes like "0000" must round-trip exactly, not get coerced to numbers.
    parseTagValue: false,
    isArray: (tagName) => REPEATING_TAGS.has(tagName),
    // Review fix (PR #32, item 1): see this function's own comment above.
    processEntities: false,
  });
  try {
    return parser.parse(xml, true);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`CommerceML: не удалось разобрать XML (${detail})`, { cause });
  }
}

export function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** Walks a dot-path of tag names, returning `{}` at any missing step. */
export function dig(root: unknown, ...path: string[]): Record<string, unknown> {
  let current = asObject(root);
  for (const step of path) {
    current = asObject(current[step]);
  }
  return current;
}

/**
 * Every leaf value in the parsed tree passes through here -- the one place
 * that applies `decodePredefinedXmlEntities`, so every field (`Наименование`,
 * `Артикул`, `Представление`, ...) gets the same treatment regardless of
 * which caller reads it.
 */
export function textOf(value: unknown): string {
  if (typeof value === "string") return decodePredefinedXmlEntities(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function optionalTextOf(value: unknown): string | null {
  const text = textOf(value);
  return text === "" ? null : text;
}

/** Reads `<Каталог><Товары><Товар>` entries off an already-parsed tree. */
function catalogItemsFrom(root: unknown): ParsedItem[] {
  const goods = dig(root, "КоммерческаяИнформация", "Каталог", "Товары");
  const rawItems = goods["Товар"];
  return (Array.isArray(rawItems) ? rawItems : []).map((raw): ParsedItem => {
    const item = asObject(raw);
    const rawImages = item["Картинка"];
    return {
      externalRef: textOf(item["Ид"]),
      name: textOf(item["Наименование"]),
      article: optionalTextOf(item["Артикул"]),
      unit: optionalTextOf(item["БазоваяЕдиница"]),
      barcode: optionalTextOf(item["Штрихкод"]),
      images: (Array.isArray(rawImages) ? rawImages : [])
        .map((raw) => textOf(raw))
        .filter((value) => value !== ""),
    };
  });
}

/** `parseCatalog(bytes)` -- reads `<Каталог><Товары><Товар>` entries. */
export function parseCatalog(bytes: Buffer): ParsedCatalog {
  return { items: catalogItemsFrom(parseXml(bytes)) };
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

/** Reads `<ПакетПредложений><Предложения><Предложение>` entries off an already-parsed tree. */
function offersFrom(root: unknown, priceTypes: Record<string, string>): ParsedOffer[] {
  const listing = dig(root, "КоммерческаяИнформация", "ПакетПредложений", "Предложения");
  const rawOffers = listing["Предложение"];
  return (Array.isArray(rawOffers) ? rawOffers : []).map((raw): ParsedOffer => {
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
    return {
      externalRef: textOf(offer["Ид"]),
      prices,
      barcode: optionalTextOf(offer["Штрихкод"]),
    };
  });
}

/** `parseOffers(bytes)` -- reads `<ПакетПредложений><Предложения><Предложение>` entries. */
export function parseOffers(bytes: Buffer): ParsedOffers {
  const root = parseXml(bytes);
  const priceTypes = parsePriceTypes(root);
  return { offers: offersFrom(root, priceTypes), priceTypes };
}

/**
 * Parses `bytes` exactly ONCE and reads off both sections a CommerceML file
 * can carry. `parseCatalog`/`parseOffers` each call `parseXml` themselves --
 * fine for a caller that only wants one section, but `exchange.controller.ts`
 * (`mode=import`) always wants both, since a given file's kind isn't known
 * ahead of time (whichever section is absent just comes back empty either
 * way). Calling them back-to-back there used to mean decoding and parsing the
 * same buffer twice per round for no reason; this reuses the one tree for
 * both.
 */
export function parseCommerceMl(bytes: Buffer): ParsedCommerceMl {
  const root = parseXml(bytes);
  const priceTypes = parsePriceTypes(root);
  return {
    items: catalogItemsFrom(root),
    offers: offersFrom(root, priceTypes),
    priceTypes,
  };
}
