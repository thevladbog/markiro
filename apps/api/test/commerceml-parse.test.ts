import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCatalog, parseOffers } from "../src/modules/exchange/commerceml/parse";

const fixture = (name: string) => readFileSync(join(__dirname, "fixtures/commerceml", name));

describe("commerceml parse", () => {
  it("читает windows-1251 — 1С выгружает в ней по умолчанию, и utf-8 превратил бы кириллицу в мусор", () => {
    const catalog = parseCatalog(fixture("import-cp1251.xml"));
    expect(catalog.items[0]!.name).toBe("Жигулёвское 0,5");
  });

  it("берёт Ид как внешний идентификатор, а не наименование", () => {
    const catalog = parseCatalog(fixture("import-cp1251.xml"));
    expect(catalog.items[0]!.externalRef).toBe("a1b2c3d4-0000-0000-0000-000000000001");
  });

  it("отдаёт все типы цен, а не первый попавшийся — выбор делает вызывающий", () => {
    const offers = parseOffers(fixture("offers.xml"));
    expect(offers.offers[0]!.prices).toEqual([
      { type: "Розничная", value: "89.90", currency: "руб" },
      { type: "Закупочная", value: "54.10", currency: "руб" },
    ]);
  });

  it("разрешает тип цены по ИдТипЦены через справочник ТипыЦен, когда Представление не задано", () => {
    const offers = parseOffers(fixture("offers-price-ref.xml"));
    expect(offers.priceTypes).toEqual({
      "a0000000-0000-0000-0000-000000000001": "Розничная",
      "a0000000-0000-0000-0000-000000000002": "Закупочная",
    });
    expect(offers.offers[0]!.prices[0]).toEqual({
      type: "Розничная",
      typeRef: "a0000000-0000-0000-0000-000000000001",
      value: "99.90",
      currency: "руб",
    });
  });

  it("оставляет тип цены пустым, но отличимым от «типа не было», когда ссылка не разрешается", () => {
    const offers = parseOffers(fixture("offers-price-ref.xml"));
    const unresolved = offers.offers[0]!.prices[1]!;
    expect(unresolved.type).toBe("");
    expect(unresolved.typeRef).toBe("a0000000-0000-0000-0000-000000000099");
  });

  it("не падает на файле без товаров", () => {
    const empty = Buffer.from(
      '<?xml version="1.0" encoding="UTF-8"?><КоммерческаяИнформация/>',
      "utf8",
    );
    expect(parseCatalog(empty).items).toEqual([]);
    expect(parseOffers(empty).offers).toEqual([]);
  });

  it("сообщает о неразобранном XML, а не возвращает пустоту", () => {
    expect(() => parseCatalog(Buffer.from("<не xml", "utf8"))).toThrow(/CommerceML/);
  });

  // Review fix (PR #32, item 5): an unrecognised `encoding="..."` used to
  // reach the caller as Node's own `RangeError` message ("The \"encoding\"
  // argument..."), not the "CommerceML: не удалось разобрать XML" wrapper
  // every other parse failure gets -- the one thing a 1С specialist reading
  // the journal actually knows to look for.
  it("сообщает о неразобранной кодировке тем же сообщением CommerceML, а не сырым RangeError", () => {
    const bytes = Buffer.from(
      '<?xml version="1.0" encoding="such-encoding-does-not-exist"?><a/>',
      "utf8",
    );
    expect(() => parseCatalog(bytes)).toThrow(/CommerceML/);
  });

  // Review fix (PR #32, item 1 -- Security): `/1c_exchange` is the one route
  // in this API reachable with no credential at all, so this parser is the
  // one XML parse call in the codebase an anonymous caller controls end to
  // end. fast-xml-parser defaults to expanding `<!DOCTYPE>` entities
  // (`processEntities: true`); this file's own `parseXml` turns that off.
  // These two cases are the classic "billion laughs" shapes -- proof the
  // parse neither hangs nor blows up memory, not just that it "still works".
  it("сущность, ссылающаяся на другие сущности (billion laughs), не раздувается и не виснет", () => {
    const bomb = Buffer.from(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        "<!DOCTYPE d [",
        ' <!ENTITY lol "lol">',
        ' <!ENTITY lol1 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">',
        ' <!ENTITY lol2 "&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;">',
        ' <!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">',
        "]>",
        "<КоммерческаяИнформация><Каталог><Товары><Товар>",
        "<Ид>guid-bomb</Ид><Наименование>&lol3;</Наименование>",
        "</Товар></Товары></Каталог></КоммерческаяИнформация>",
      ].join(""),
      "utf8",
    );

    const catalog = parseCatalog(bomb);

    // Not expanded at all: with `processEntities: false`, the reference is
    // left exactly as it arrived -- proof no substitution happened, not just
    // that whatever came back is merely short. This alone rules out the
    // expansion (a genuine one would be gigabytes of text, not a 6-character
    // literal), without an elapsed-time assertion that would be flaky under
    // CI load rather than actually testing this behavior.
    expect(catalog.items[0]!.name).toBe("&lol3;");
  });

  it("одна сущность, повторённая много раз (амплификация без вложенности), тоже не раздувается", () => {
    const bigEntityValue = "A".repeat(9999);
    const repeatedRef = "&big;".repeat(20_000);
    const bomb = Buffer.from(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        `<!DOCTYPE d [ <!ENTITY big "${bigEntityValue}"> ]>`,
        "<КоммерческаяИнформация><Каталог><Товары><Товар>",
        `<Ид>guid-amplify</Ид><Наименование>${repeatedRef}</Наименование>`,
        "</Товар></Товары></Каталог></КоммерческаяИнформация>",
      ].join(""),
      "utf8",
    );

    const catalog = parseCatalog(bomb);

    // The raw file itself is ~100KB (20,000 * 5-byte references); a real
    // expansion would be ~190MB (20,000 * 9999 chars). This bound alone
    // proves no expansion happened -- an elapsed-time or heap-delta
    // assertion would claim the same thing less directly, and be flaky
    // under CI load or ordinary GC noise besides.
    expect(catalog.items[0]!.name.length).toBeLessThan(repeatedRef.length + 1);
  });

  // Review fix (PR #32, item 1): `processEntities: false` must not take the
  // five entities XML itself defines down with it -- a product name
  // legitimately containing `&` or `<` MUST be escaped to stay well-formed
  // XML, and this parser is still the one thing that has to read it back.
  it("раскрывает пять предопределённых сущностей XML несмотря на отключённый processEntities", () => {
    const bytes = Buffer.from(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        "<КоммерческаяИнформация><Каталог><Товары><Товар>",
        "<Ид>guid-entities</Ид>",
        "<Наименование>Соль &amp; перец &lt;3&gt; &quot;острый&quot; &apos;набор&apos;</Наименование>",
        "</Товар></Товары></Каталог></КоммерческаяИнформация>",
      ].join(""),
      "utf8",
    );
    const catalog = parseCatalog(bytes);
    expect(catalog.items[0]!.name).toBe(`Соль & перец <3> "острый" 'набор'`);
  });

  // Review fix (round 2): decodePredefinedXmlEntities now also resolves
  // numeric character references, which `processEntities: false` leaves
  // untouched the same way it leaves named entities untouched.
  it("раскрывает числовые ссылки на символы (десятичные и шестнадцатеричные)", () => {
    const bytes = Buffer.from(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        "<КоммерческаяИнформация><Каталог><Товары><Товар>",
        "<Ид>guid-numeric-refs</Ид>",
        "<Наименование>&#1046;&#x438;&#1075;&#x443;&#1083;&#x451;&#1074;&#x441;&#1082;&#1086;&#1077;</Наименование>",
        "</Товар></Товары></Каталог></КоммерческаяИнформация>",
      ].join(""),
      "utf8",
    );
    const catalog = parseCatalog(bytes);
    expect(catalog.items[0]!.name).toBe("Жигулёвское");
  });

  it("оставляет нечитаемую числовую ссылку как есть, не бросая исключение", () => {
    const bytes = Buffer.from(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        "<КоммерческаяИнформация><Каталог><Товары><Товар>",
        "<Ид>guid-bad-numeric-ref</Ид>",
        "<Наименование>перед&#xFFFFFFFF;после</Наименование>",
        "</Товар></Товары></Каталог></КоммерческаяИнформация>",
      ].join(""),
      "utf8",
    );
    const catalog = parseCatalog(bytes);
    expect(catalog.items[0]!.name).toBe("перед&#xFFFFFFFF;после");
  });

  // Review fix (round 2): `String.fromCodePoint` alone accepts a NUL byte and
  // lone UTF-16 surrogate halves, but XML's own `Char` production forbids
  // referencing either -- and a bare NUL is invalid in a Postgres `text`
  // column outright, so decoding one here would turn into a DB error several
  // layers downstream instead of staying inert text at the one place that
  // knows why.
  it("не расшифровывает числовые ссылки на NUL и суррогатные половины", () => {
    const bytes = Buffer.from(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        "<КоммерческаяИнформация><Каталог><Товары><Товар>",
        "<Ид>guid-illegal-numeric-ref</Ид>",
        "<Наименование>до&#0;после &#xD800;далее</Наименование>",
        "</Товар></Товары></Каталог></КоммерческаяИнформация>",
      ].join(""),
      "utf8",
    );
    const catalog = parseCatalog(bytes);
    expect(catalog.items[0]!.name).toBe("до&#0;после &#xD800;далее");
  });
});
