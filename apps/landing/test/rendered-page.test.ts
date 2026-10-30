import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { JSDOM } from "jsdom";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { LANDING_LEAD_SOURCE_PATHS } from "../../../packages/platform-contracts/src/landing-leads";

const appRoot = fileURLToPath(new URL("../", import.meta.url));
const outputDirectory = mkdtempSync(path.join(tmpdir(), "markiro-landing-render-"));
const enabledOutputDirectory = mkdtempSync(path.join(tmpdir(), "markiro-landing-enabled-render-"));
let document: Document;
const documents = new Map<string, Document>();
const enabledDocuments = new Map<string, Document>();

const EXPECTED_ROUTES = [
  "/",
  "/markirovka-chestny-znak/",
  "/sscc-i-agregatsiya/",
  "/rabochee-mesto-upakovki/",
  "/integratsiya-1c/",
  "/oflayn-rabota/",
  "/faq/",
  "/en/",
  "/en/chestny-znak-serialization/",
  "/en/sscc-and-aggregation/",
  "/en/packing-workstation/",
  "/en/1c-integration/",
  "/en/offline-production/",
  "/en/faq/",
] as const;
const HUB_ROUTES = ["/stati/", "/instruktsii/", "/en/articles/", "/en/instructions/"] as const;
const SAMPLE_CLUSTER_ROUTES = [
  "/stati/markirovka-piva-2026/",
  "/instruktsii/stantsiya-vkhod-i-start-smeny/",
] as const;
const AUTONOM_ROUTES = ["/skachat/", "/stoimost/"] as const;

beforeAll(() => {
  execFileSync(
    path.join(appRoot, "node_modules/.bin/astro"),
    ["build", "--outDir", outputDirectory],
    {
      cwd: appRoot,
      env: {
        ...process.env,
        ASTRO_TELEMETRY_DISABLED: "1",
        PUBLIC_DEMO_CONSENT_VERSION: "stray-consent-version",
        PUBLIC_DEMO_SUBMISSION_ENABLED: "false",
        PUBLIC_PERSONAL_DATA_CONSENT_PATH: "/stray-consent/",
        PUBLIC_PHONE: "",
        PUBLIC_PRIVACY_POLICY_PATH: "/stray-privacy/",
        PUBLIC_SMARTCAPTCHA_CLIENT_KEY: "ysc1_stray-client-key",
      },
      stdio: "pipe",
    },
  );

  execFileSync(
    path.join(appRoot, "node_modules/.bin/astro"),
    ["build", "--outDir", enabledOutputDirectory],
    {
      cwd: appRoot,
      env: {
        ...process.env,
        ASTRO_TELEMETRY_DISABLED: "1",
        PUBLIC_DEMO_CONSENT_VERSION: "stray-enabled-consent",
        PUBLIC_DEMO_SUBMISSION_ENABLED: "true",
        PUBLIC_INDEXNOW_KEY: "markiro-indexnow-render-key",
        PUBLIC_PERSONAL_DATA_CONSENT_PATH: "/personal-data-consent/",
        PUBLIC_PHONE: "",
        PUBLIC_PRIVACY_POLICY_PATH: "/privacy/",
        PUBLIC_SMARTCAPTCHA_CLIENT_KEY: "",
      },
      stdio: "pipe",
    },
  );

  for (const route of [
    ...EXPECTED_ROUTES,
    ...HUB_ROUTES,
    ...SAMPLE_CLUSTER_ROUTES,
    ...AUTONOM_ROUTES,
  ]) {
    const outputPath =
      route === "/"
        ? path.join(outputDirectory, "index.html")
        : path.join(outputDirectory, route.slice(1), "index.html");
    const html = readFileSync(outputPath, "utf8");
    documents.set(route, new JSDOM(html).window.document);

    const enabledOutputPath =
      route === "/"
        ? path.join(enabledOutputDirectory, "index.html")
        : path.join(enabledOutputDirectory, route.slice(1), "index.html");
    const enabledHtml = readFileSync(enabledOutputPath, "utf8");
    enabledDocuments.set(route, new JSDOM(enabledHtml).window.document);
  }
  document = documents.get("/") as Document;
}, 180_000);

afterAll(() => {
  rmSync(outputDirectory, { force: true, recursive: true });
  rmSync(enabledOutputDirectory, { force: true, recursive: true });
});

describe("rendered landing page", () => {
  it("publishes the beer case aggregation guide as a self-contained article", () => {
    const articleOutput = path.join(outputDirectory, "stati/agregatsiya-piva-v-koroba/index.html");
    expect(existsSync(articleOutput)).toBe(true);
    if (!existsSync(articleOutput)) return;

    const articleDocument = new JSDOM(readFileSync(articleOutput, "utf8")).window.document;
    expect(articleDocument.querySelectorAll("h1")).toHaveLength(1);
    expect(articleDocument.querySelector("h1")?.textContent).toContain("Агрегация пива в короба");
    expect(articleDocument.querySelector('link[rel="canonical"]')?.getAttribute("href")).toBe(
      "https://markiro.app/stati/agregatsiya-piva-v-koroba/",
    );
    expect(articleDocument.querySelector('meta[property="og:type"]')?.getAttribute("content")).toBe(
      "article",
    );
    expect(
      articleDocument.querySelector('meta[property="og:image"]')?.getAttribute("content"),
    ).toBe("https://markiro.app/og-beer-case-aggregation.jpg");
    expect(
      articleDocument
        .querySelector('meta[property="article:published_time"]')
        ?.getAttribute("content"),
    ).toBe("2026-08-26");
    expect(
      articleDocument.querySelector('link[rel="alternate"][hreflang="en"]')?.getAttribute("href"),
    ).toBe("https://markiro.app/en/articles/beer-case-aggregation/");
    expect(articleDocument.querySelectorAll('meta[property="og:locale:alternate"]')).toHaveLength(
      1,
    );
    expect(articleDocument.querySelector('nav[aria-label="Содержание статьи"]')).not.toBeNull();
    expect(articleDocument.querySelectorAll("[data-key-takeaway]").length).toBeGreaterThanOrEqual(
      5,
    );
    expect(articleDocument.querySelectorAll("figure[data-article-visual]")).toHaveLength(3);

    const heroImage = articleDocument.querySelector<HTMLImageElement>("[data-article-hero-image]");
    expect(heroImage?.getAttribute("alt")).toContain("сканирует Data Matrix");
    expect(heroImage?.getAttribute("loading")).toBe("eager");
    expect(heroImage?.getAttribute("width")).not.toBeNull();
    expect(heroImage?.getAttribute("height")).not.toBeNull();

    for (const image of articleDocument.querySelectorAll<HTMLImageElement>(
      "[data-article-diagram]",
    )) {
      expect(image.getAttribute("alt")).not.toBe("");
      expect(image.getAttribute("loading")).toBe("lazy");
      expect(image.getAttribute("width")).not.toBeNull();
      expect(image.getAttribute("height")).not.toBeNull();
    }
    expect(articleDocument.querySelectorAll("[data-article-diagram]")).toHaveLength(2);
    expect(articleDocument.querySelectorAll("figure[data-article-visual] figcaption")).toHaveLength(
      3,
    );

    const graph = JSON.parse(
      articleDocument.querySelector('script[type="application/ld+json"]')?.textContent ?? "",
    ) as { "@graph": Array<Record<string, unknown>> };
    expect(graph["@graph"].find((entry) => entry["@type"] === "Article")).toMatchObject({
      dateModified: "2026-10-05",
      datePublished: "2026-08-26",
      headline: "Агрегация пива в короба: как не остановить производственную линию",
      image: "https://markiro.app/og-beer-case-aggregation.jpg",
      inLanguage: "ru",
    });

    const bodyText = articleDocument.body.textContent?.replace(/\s+/g, " ") ?? "";
    expect(bodyText).toContain("Текущий контур Markiro — «единица → короб → паллета»");
    expect(bodyText).toContain("У короба и у паллеты свой SSCC");
    expect(bodyText).toContain("Markiro работает на линиях пива и сидра");
    expect(bodyText).not.toContain("внедряется для производителей");
    expect(bodyText).not.toContain("относится к следующему этапу");
    expect(
      articleDocument.querySelector('a[href="https://www.gs1ru.org/gs1_system/capture/sscc/"]'),
    ).not.toBeNull();
    expect(articleDocument.querySelector('a[href="/sscc-i-agregatsiya/"]')).not.toBeNull();
    expect(
      documents
        .get("/sscc-i-agregatsiya/")
        ?.querySelector('[data-related-articles] a[href="/stati/agregatsiya-piva-v-koroba/"]'),
    ).not.toBeNull();
  });

  it("publishes the 2026 beer marking guide as a source-backed readiness checklist", () => {
    const articleOutput = path.join(outputDirectory, "stati/markirovka-piva-2026/index.html");
    expect(existsSync(articleOutput)).toBe(true);
    if (!existsSync(articleOutput)) return;

    const articleDocument = new JSDOM(readFileSync(articleOutput, "utf8")).window.document;
    expect(articleDocument.querySelectorAll("h1")).toHaveLength(1);
    expect(articleDocument.querySelector("h1")?.textContent).toContain(
      "Маркировка пива в 2026 году",
    );
    expect(articleDocument.querySelector('link[rel="canonical"]')?.getAttribute("href")).toBe(
      "https://markiro.app/stati/markirovka-piva-2026/",
    );
    expect(articleDocument.querySelector('meta[property="og:type"]')?.getAttribute("content")).toBe(
      "article",
    );
    expect(
      articleDocument.querySelector('meta[property="og:image"]')?.getAttribute("content"),
    ).toBe("https://markiro.app/og-beer-marking-2026.jpg");
    expect(articleDocument.querySelector('nav[aria-label="Содержание статьи"]')).not.toBeNull();
    expect(articleDocument.querySelectorAll("[data-key-takeaway]").length).toBeGreaterThanOrEqual(
      5,
    );
    expect(articleDocument.querySelectorAll("figure[data-article-visual]")).toHaveLength(3);

    const heroImage = articleDocument.querySelector<HTMLImageElement>("[data-article-hero-image]");
    expect(heroImage?.getAttribute("alt")).toContain("проверяет готовность");
    expect(heroImage?.getAttribute("loading")).toBe("eager");

    const graph = JSON.parse(
      articleDocument.querySelector('script[type="application/ld+json"]')?.textContent ?? "",
    ) as { "@graph": Array<Record<string, unknown>> };
    expect(graph["@graph"].find((entry) => entry["@type"] === "Article")).toMatchObject({
      dateModified: "2026-10-05",
      datePublished: "2026-08-26",
      headline: "Маркировка пива в 2026 году: что проверить производителю на линии",
      image: "https://markiro.app/og-beer-marking-2026.jpg",
      inLanguage: "ru",
    });

    const bodyText = articleDocument.body.textContent?.replace(/\s+/g, " ") ?? "";
    expect(bodyText).toContain("Адаптационный период не отменяет требования");
    expect(bodyText).toContain("отсутствие регистрации, МОД или подключения к ЭДО");
    expect(bodyText).toContain("Текущий контур Markiro — «единица → короб → паллета»");
    expect(bodyText).toContain("У короба и у паллеты свой SSCC");
    expect(bodyText).not.toContain("требования отложены для всех");
    expect(bodyText).not.toContain("относится к следующему этапу");

    for (const href of [
      "https://markirovka.ru/knowledge/tovarnye-gruppy/pivo-pivniye-napitki/perenos-srokov-po-ekzemplyarnomu-uchetu-piva",
      "https://markirovka.ru/knowledge/tovarnye-gruppy/pivo-pivniye-napitki/sroki-i-etapy-zapuska-obyazatelnoy-markirovki-piva-pivnykh-i-slaboalkogolnykh-napitkov",
      "https://markirovka.ru/knowledge/tovarnye-gruppy/pivo-pivniye-napitki/kogda-nuzhno-vvodit-pivo-i-pivnye-napitki-v-oborot",
      "/stati/agregatsiya-piva-v-koroba/",
      "/sscc-i-agregatsiya/",
      "/oflayn-rabota/",
    ]) {
      expect(articleDocument.querySelector(`a[href="${href}"]`)).not.toBeNull();
    }

    const previousArticleOutput = path.join(
      outputDirectory,
      "stati/agregatsiya-piva-v-koroba/index.html",
    );
    const previousArticleDocument = new JSDOM(readFileSync(previousArticleOutput, "utf8")).window
      .document;
    expect(
      previousArticleDocument.querySelector('a[href="/stati/markirovka-piva-2026/"]'),
    ).not.toBeNull();
  });

  it("publishes reciprocal English article versions with localized diagrams", () => {
    for (const [route, heading, alternate, diagramPrefix] of [
      [
        "en/articles/beer-case-aggregation",
        "Beer case aggregation",
        "/stati/agregatsiya-piva-v-koroba/",
        "beer-case-aggregation",
      ],
      [
        "en/articles/beer-marking-2026",
        "Beer marking in Russia in 2026",
        "/stati/markirovka-piva-2026/",
        "beer-marking-2026",
      ],
    ] as const) {
      const output = path.join(outputDirectory, route, "index.html");
      expect(existsSync(output)).toBe(true);
      if (!existsSync(output)) continue;

      const localizedDocument = new JSDOM(readFileSync(output, "utf8")).window.document;
      expect(localizedDocument.documentElement.lang).toBe("en");
      expect(localizedDocument.querySelector("h1")?.textContent).toContain(heading);
      expect(localizedDocument.querySelector('link[rel="canonical"]')?.getAttribute("href")).toBe(
        `https://markiro.app/${route}/`,
      );
      expect(
        localizedDocument
          .querySelector('link[rel="alternate"][hreflang="ru"]')
          ?.getAttribute("href"),
      ).toBe(`https://markiro.app${alternate}`);
      expect(localizedDocument.querySelector('a[hreflang="ru"]')?.getAttribute("href")).toBe(
        alternate,
      );
      expect(
        localizedDocument.querySelector('a[hreflang="en"][aria-current="page"]'),
      ).not.toBeNull();
      expect(
        localizedDocument.querySelectorAll("[data-key-takeaway]").length,
      ).toBeGreaterThanOrEqual(5);
      expect(localizedDocument.querySelectorAll("figure[data-article-visual]")).toHaveLength(3);

      for (const diagram of localizedDocument.querySelectorAll<HTMLImageElement>(
        "[data-article-diagram]",
      )) {
        expect(diagram.getAttribute("src")).toContain(diagramPrefix);
        expect(diagram.getAttribute("src")).toContain("-en.svg");
        expect(diagram.getAttribute("alt")).not.toBe("");
      }

      const graph = JSON.parse(
        localizedDocument.querySelector('script[type="application/ld+json"]')?.textContent ?? "",
      ) as { "@graph": Array<Record<string, unknown>> };
      expect(graph["@graph"].find((entry) => entry["@type"] === "Article")).toMatchObject({
        inLanguage: "en",
      });
    }
  });

  it("publishes a bilingual source-backed Data Matrix diagnostic guide", () => {
    for (const article of [
      {
        route: "stati/data-matrix-pivo-ne-schityvaetsya",
        lang: "ru",
        heading: "Почему Data Matrix на пиве не считывается",
        alternate: "/en/articles/beer-data-matrix-not-scanning/",
        alternateLang: "en",
        diagramPrefix: "data-matrix-pivo",
        sourceLabel: "Состав кода маркировки",
      },
      {
        route: "en/articles/beer-data-matrix-not-scanning",
        lang: "en",
        heading: "Beer Data Matrix not scanning",
        alternate: "/stati/data-matrix-pivo-ne-schityvaetsya/",
        alternateLang: "ru",
        diagramPrefix: "beer-data-matrix",
        sourceLabel: "official code structure",
      },
    ] as const) {
      const output = path.join(outputDirectory, article.route, "index.html");
      expect(existsSync(output)).toBe(true);
      if (!existsSync(output)) continue;

      const localizedDocument = new JSDOM(readFileSync(output, "utf8")).window.document;
      expect(localizedDocument.documentElement.lang).toBe(article.lang);
      expect(localizedDocument.querySelectorAll("h1")).toHaveLength(1);
      expect(localizedDocument.querySelector("h1")?.textContent).toContain(article.heading);
      expect(localizedDocument.querySelector('link[rel="canonical"]')?.getAttribute("href")).toBe(
        `https://markiro.app/${article.route}/`,
      );
      expect(
        localizedDocument
          .querySelector(`link[rel="alternate"][hreflang="${article.alternateLang}"]`)
          ?.getAttribute("href"),
      ).toBe(`https://markiro.app${article.alternate}`);
      expect(
        localizedDocument.querySelectorAll("[data-key-takeaway]").length,
      ).toBeGreaterThanOrEqual(5);
      expect(localizedDocument.querySelectorAll("figure[data-article-visual]")).toHaveLength(3);

      const hero = localizedDocument.querySelector<HTMLImageElement>("[data-article-hero-image]");
      expect(hero?.getAttribute("loading")).toBe("eager");
      expect(hero?.getAttribute("width")).not.toBeNull();
      expect(hero?.getAttribute("height")).not.toBeNull();

      for (const diagram of localizedDocument.querySelectorAll<HTMLImageElement>(
        "[data-article-diagram]",
      )) {
        expect(diagram.getAttribute("src")).toContain(article.diagramPrefix);
        expect(diagram.getAttribute("alt")).not.toBe("");
        expect(diagram.getAttribute("loading")).toBe("lazy");
      }
      expect(localizedDocument.querySelectorAll("[data-article-diagram]")).toHaveLength(2);

      const graph = JSON.parse(
        localizedDocument.querySelector('script[type="application/ld+json"]')?.textContent ?? "",
      ) as { "@graph": Array<Record<string, unknown>> };
      expect(graph["@graph"].find((entry) => entry["@type"] === "Article")).toMatchObject({
        dateModified: "2026-10-05",
        datePublished: "2026-08-26",
        inLanguage: article.lang,
      });

      const bodyText = localizedDocument.body.textContent?.replace(/\s+/g, " ") ?? "";
      expect(bodyText).toContain(article.sourceLabel);
      expect(bodyText).toMatch(/ASCII 29|GS separator/);
      expect(bodyText).toMatch(/1\.5 \(C\)|class 1\.5 \(C\)/);
      expect(bodyText).not.toMatch(/гарантирует чтение|guarantees every scan/i);
      expect(
        localizedDocument.querySelector(
          'a[href="https://markirovka.ru/knowledge/tovarnye-gruppy/pivo-pivniye-napitki/sostav-koda-markirovki-pivo"]',
        ),
      ).not.toBeNull();
    }
  });

  it("publishes a bilingual equipment-selection guide with explicit product boundaries", () => {
    for (const article of [
      {
        route: "stati/oborudovanie-dlya-markirovki-piva",
        lang: "ru",
        heading: "Оборудование для маркировки пива",
        alternate: "/en/articles/beer-marking-line-equipment/",
        alternateLang: "en",
        diagramPrefix: "oborudovanie-markirovki-piva",
        sourceLabel: "Официальная последовательность действий",
      },
      {
        route: "en/articles/beer-marking-line-equipment",
        lang: "en",
        heading: "Beer marking line equipment for Russia",
        alternate: "/stati/oborudovanie-dlya-markirovki-piva/",
        alternateLang: "ru",
        diagramPrefix: "beer-marking-equipment",
        sourceLabel: "official production sequence",
      },
    ] as const) {
      const output = path.join(outputDirectory, article.route, "index.html");
      expect(existsSync(output)).toBe(true);
      if (!existsSync(output)) continue;

      const localizedDocument = new JSDOM(readFileSync(output, "utf8")).window.document;
      expect(localizedDocument.documentElement.lang).toBe(article.lang);
      expect(localizedDocument.querySelectorAll("h1")).toHaveLength(1);
      expect(localizedDocument.querySelector("h1")?.textContent).toContain(article.heading);
      expect(localizedDocument.querySelector('link[rel="canonical"]')?.getAttribute("href")).toBe(
        `https://markiro.app/${article.route}/`,
      );
      expect(
        localizedDocument
          .querySelector(`link[rel="alternate"][hreflang="${article.alternateLang}"]`)
          ?.getAttribute("href"),
      ).toBe(`https://markiro.app${article.alternate}`);
      expect(
        localizedDocument.querySelectorAll("[data-key-takeaway]").length,
      ).toBeGreaterThanOrEqual(5);
      expect(localizedDocument.querySelectorAll("figure[data-article-visual]")).toHaveLength(3);
      expect(localizedDocument.querySelectorAll("[data-article-diagram]")).toHaveLength(2);

      const hero = localizedDocument.querySelector<HTMLImageElement>("[data-article-hero-image]");
      expect(hero?.getAttribute("loading")).toBe("eager");
      expect(hero?.getAttribute("width")).not.toBeNull();
      expect(hero?.getAttribute("height")).not.toBeNull();

      for (const diagram of localizedDocument.querySelectorAll<HTMLImageElement>(
        "[data-article-diagram]",
      )) {
        expect(diagram.getAttribute("src")).toContain(article.diagramPrefix);
        expect(diagram.getAttribute("alt")).not.toBe("");
      }

      const graph = JSON.parse(
        localizedDocument.querySelector('script[type="application/ld+json"]')?.textContent ?? "",
      ) as { "@graph": Array<Record<string, unknown>> };
      expect(graph["@graph"].find((entry) => entry["@type"] === "Article")).toMatchObject({
        dateModified: "2026-10-05",
        datePublished: "2026-08-26",
        inLanguage: article.lang,
      });

      const bodyText = localizedDocument.body.textContent?.replace(/\s+/g, " ") ?? "";
      expect(bodyText).toContain(article.sourceLabel);
      expect(bodyText).toMatch(/ZPL.*TSPL|ZPL and TSPL/);
      expect(bodyText).toMatch(/1\.5 \(C\)|class 1\.5 \(C\)/);
      expect(bodyText).toMatch(/совместимость.*конкретн|compatibility.*facility/i);
      expect(bodyText).toMatch(/item → case → pallet|единица → короб → паллета/);
      expect(bodyText).not.toMatch(/универсальный обязательный список|universal mandatory list/i);

      for (const href of [
        "https://markirovka.ru/knowledge/tovarnye-gruppy/pivo-pivniye-napitki/markirovka-tovarov-proizvedennykh-na-territorii-rf-posledovatelnost-deystviy-pivo",
        "https://markirovka.ru/knowledge/tovarnye-gruppy/pivo-pivniye-napitki/kakim-dolzhen-byt-datamatrix-trebovaniya-k-preobrazovaniyu-i-kachestvu-naneseniya-pivo",
        "https://markirovka.ru/knowledge/tovarnye-gruppy/pivo-pivniye-napitki/integratsiya-sistemy-markirovki-s-tovarouchetnoy-sistemoy-uchastnika-pivo",
      ]) {
        expect(localizedDocument.querySelector(`a[href="${href}"]`)).not.toBeNull();
      }
    }
  });

  it("publishes a bilingual affordability guide without inventing a Markiro price", () => {
    for (const article of [
      {
        route: "stati/stoimost-markirovki-piva",
        lang: "ru",
        heading: "Сколько стоит маркировка пива",
        alternate: "/en/articles/beer-marking-cost-russia/",
        alternateLang: "en",
        diagramPrefix: "stoimost-markirovki-piva",
        accessibilityClaim: "без космической стоимости входа",
      },
      {
        route: "en/articles/beer-marking-cost-russia",
        lang: "en",
        heading: "Beer marking cost in Russia",
        alternate: "/stati/stoimost-markirovki-piva/",
        alternateLang: "ru",
        diagramPrefix: "beer-marking-cost",
        accessibilityClaim: "without an excessive entry cost",
      },
    ] as const) {
      const output = path.join(outputDirectory, article.route, "index.html");
      expect(existsSync(output)).toBe(true);
      if (!existsSync(output)) continue;

      const localizedDocument = new JSDOM(readFileSync(output, "utf8")).window.document;
      expect(localizedDocument.documentElement.lang).toBe(article.lang);
      expect(localizedDocument.querySelectorAll("h1")).toHaveLength(1);
      expect(localizedDocument.querySelector("h1")?.textContent).toContain(article.heading);
      expect(localizedDocument.querySelector('link[rel="canonical"]')?.getAttribute("href")).toBe(
        `https://markiro.app/${article.route}/`,
      );
      expect(
        localizedDocument
          .querySelector(`link[rel="alternate"][hreflang="${article.alternateLang}"]`)
          ?.getAttribute("href"),
      ).toBe(`https://markiro.app${article.alternate}`);
      expect(
        localizedDocument.querySelectorAll("[data-key-takeaway]").length,
      ).toBeGreaterThanOrEqual(5);
      expect(localizedDocument.querySelectorAll("figure[data-article-visual]")).toHaveLength(3);
      expect(localizedDocument.querySelectorAll("[data-article-diagram]")).toHaveLength(2);

      const hero = localizedDocument.querySelector<HTMLImageElement>("[data-article-hero-image]");
      expect(hero?.getAttribute("loading")).toBe("eager");
      expect(hero?.getAttribute("width")).not.toBeNull();
      expect(hero?.getAttribute("height")).not.toBeNull();

      for (const diagram of localizedDocument.querySelectorAll<HTMLImageElement>(
        "[data-article-diagram]",
      )) {
        expect(diagram.getAttribute("src")).toContain(article.diagramPrefix);
        expect(diagram.getAttribute("alt")).not.toBe("");
        expect(diagram.getAttribute("loading")).toBe("lazy");
      }

      const graph = JSON.parse(
        localizedDocument.querySelector('script[type="application/ld+json"]')?.textContent ?? "",
      ) as { "@graph": Array<Record<string, unknown>> };
      expect(graph["@graph"].find((entry) => entry["@type"] === "Article")).toMatchObject({
        dateModified: "2026-10-05",
        datePublished: "2026-08-26",
        inLanguage: article.lang,
      });

      const bodyText = localizedDocument.body.textContent?.replace(/\s+/g, " ") ?? "";
      expect(bodyText).toContain(article.accessibilityClaim);
      expect(bodyText).toMatch(/50 копеек.*61 копейку|RUB 0\.50.*RUB 0\.61/);
      expect(bodyText).toMatch(/одной станции|one workstation/i);
      expect(bodyText).toMatch(/совместим|compatib/i);
      expect(bodyText).toMatch(/единица → короб → паллета|item → case → pallet/);
      expect(bodyText).not.toMatch(/Markiro (?:стоит|от \d|costs|from RUB)/i);

      for (const href of [
        "https://markirovka.ru/knowledge/tovarnye-gruppy/pivo-pivniye-napitki/stoimost-i-oplata-kodov-markirovki-dlya-piva-i-pivnykh-napitkov",
        "https://markirovka.ru/knowledge/tovarnye-gruppy/pivo-pivniye-napitki/kakoe-oborudovanie-i-po-potrebuetsya-uchastniku-dlya-raboty-v-sisteme-markirovki-pivo",
        "https://markirovka.ru/community/beer_producers/chto-neobkhodimo-dlya-tekhnicheskogo-osnashcheniya-proizvoditelyam-piva-pri-rabote-s-markirovkoy",
      ]) {
        expect(localizedDocument.querySelector(`a[href="${href}"]`)).not.toBeNull();
      }
    }
  });

  it("publishes a bilingual guide to beer Data Matrix application methods", () => {
    for (const article of [
      {
        route: "stati/nanesenie-data-matrix-na-pivo",
        lang: "ru",
        heading: "Как наносить Data Matrix на пиво",
        alternate: "/en/articles/beer-data-matrix-application-methods/",
        alternateLang: "en",
        diagramPrefix: "nanesenie-data-matrix-pivo",
        methods: /этикетк.*типограф.*прям/i,
        boundary: "единица → короб → паллета",
        backlinkRoute: "stati/oborudovanie-dlya-markirovki-piva",
      },
      {
        route: "en/articles/beer-data-matrix-application-methods",
        lang: "en",
        heading: "Beer Data Matrix application in Russia",
        alternate: "/stati/nanesenie-data-matrix-na-pivo/",
        alternateLang: "ru",
        diagramPrefix: "beer-datamatrix-application",
        methods: /label.*preprint.*direct print/i,
        boundary: "item → case → pallet",
        backlinkRoute: "en/articles/beer-marking-line-equipment",
      },
    ] as const) {
      const output = path.join(outputDirectory, article.route, "index.html");
      expect(existsSync(output)).toBe(true);
      if (!existsSync(output)) continue;

      const localizedDocument = new JSDOM(readFileSync(output, "utf8")).window.document;
      expect(localizedDocument.documentElement.lang).toBe(article.lang);
      expect(localizedDocument.querySelectorAll("h1")).toHaveLength(1);
      expect(localizedDocument.querySelector("h1")?.textContent).toContain(article.heading);
      expect(localizedDocument.querySelector('link[rel="canonical"]')?.getAttribute("href")).toBe(
        `https://markiro.app/${article.route}/`,
      );
      expect(
        localizedDocument
          .querySelector(`link[rel="alternate"][hreflang="${article.alternateLang}"]`)
          ?.getAttribute("href"),
      ).toBe(`https://markiro.app${article.alternate}`);
      expect(
        localizedDocument.querySelectorAll("[data-key-takeaway]").length,
      ).toBeGreaterThanOrEqual(5);
      expect(localizedDocument.querySelectorAll("figure[data-article-visual]")).toHaveLength(3);
      expect(localizedDocument.querySelectorAll("[data-article-diagram]")).toHaveLength(2);

      const hero = localizedDocument.querySelector<HTMLImageElement>("[data-article-hero-image]");
      expect(hero?.getAttribute("loading")).toBe("eager");
      expect(hero?.getAttribute("width")).not.toBeNull();
      expect(hero?.getAttribute("height")).not.toBeNull();

      for (const diagram of localizedDocument.querySelectorAll<HTMLImageElement>(
        "[data-article-diagram]",
      )) {
        expect(diagram.getAttribute("src")).toContain(article.diagramPrefix);
        expect(diagram.getAttribute("alt")).not.toBe("");
        expect(diagram.getAttribute("loading")).toBe("lazy");
      }

      const graph = JSON.parse(
        localizedDocument.querySelector('script[type="application/ld+json"]')?.textContent ?? "",
      ) as { "@graph": Array<Record<string, unknown>> };
      expect(graph["@graph"].find((entry) => entry["@type"] === "Article")).toMatchObject({
        dateModified: "2026-09-27",
        datePublished: "2026-08-26",
        image: "https://markiro.app/og-beer-datamatrix-application.jpg",
        inLanguage: article.lang,
      });

      const bodyText = localizedDocument.body.textContent?.replace(/\s+/g, " ") ?? "";
      expect(bodyText).toMatch(article.methods);
      expect(bodyText).toMatch(/1,5 \(C\)|1\.5 \(C\)/);
      expect(bodyText).toMatch(/только одно.*средств|only one.*identification means/i);
      expect(bodyText).toContain(article.boundary);
      expect(bodyText).toMatch(/физическ.*подтвержд|physical.*accepted/i);

      for (const href of [
        "https://markirovka.ru/knowledge/tovarnye-gruppy/pivo-pivniye-napitki/kakim-dolzhen-byt-datamatrix-trebovaniya-k-preobrazovaniyu-i-kachestvu-naneseniya-pivo",
        "https://markirovka.ru/knowledge/fast_start/marking_location/etiketirovanie-datamatrix-vneshniy-vid-oborudovanie-osobennosti-naneseniya",
        "https://markirovka.ru/knowledge/fast_start/typography/tipografskoe-nanesenie-datamatrix-preimushchestva-oborudovanie-protsess",
        "https://markirovka.ru/knowledge/fast_start/marking_location/praktika-pryamogo-naneseniya-data-matrix-vidy-upakovki-mesta-naneseniya-materialy",
      ]) {
        expect(localizedDocument.querySelector(`a[href="${href}"]`)).not.toBeNull();
      }

      const backlink = path.join(outputDirectory, article.backlinkRoute, "index.html");
      const backlinkDocument = new JSDOM(readFileSync(backlink, "utf8")).window.document;
      expect(backlinkDocument.querySelector(`a[href="${article.alternate}"]`)).toBeNull();
      expect(backlinkDocument.querySelector(`a[href="/${article.route}/"]`)).not.toBeNull();
    }
  });

  it("publishes a bilingual guide to resilient offline beer marking", () => {
    for (const article of [
      {
        route: "stati/markirovka-piva-bez-interneta",
        lang: "ru",
        heading: "Маркировка пива без интернета",
        alternate: "/en/articles/offline-beer-marking-russia/",
        alternateLang: "en",
        diagramPrefix: "markirovka-piva-offline",
        localBoundary: "единица → короб → паллета",
        durableClaim: /журнал.*перезапуск|перезапуск.*журнал/i,
        noFalseSuccess: /не.*зелёный успех|не показывать ложный успех/i,
        backlinkRoute: "stati/agregatsiya-piva-v-koroba",
      },
      {
        route: "en/articles/offline-beer-marking-russia",
        lang: "en",
        heading: "Offline beer marking in Russia",
        alternate: "/stati/markirovka-piva-bez-interneta/",
        alternateLang: "ru",
        diagramPrefix: "offline-beer-marking",
        localBoundary: "item → case → pallet",
        durableClaim: /journal.*restart|restart.*journal/i,
        noFalseSuccess: /must not invent|never display false success/i,
        backlinkRoute: "en/articles/beer-case-aggregation",
      },
    ] as const) {
      const output = path.join(outputDirectory, article.route, "index.html");
      expect(existsSync(output)).toBe(true);
      if (!existsSync(output)) continue;

      const localizedDocument = new JSDOM(readFileSync(output, "utf8")).window.document;
      expect(localizedDocument.documentElement.lang).toBe(article.lang);
      expect(localizedDocument.querySelectorAll("h1")).toHaveLength(1);
      expect(localizedDocument.querySelector("h1")?.textContent).toContain(article.heading);
      expect(localizedDocument.querySelector('link[rel="canonical"]')?.getAttribute("href")).toBe(
        `https://markiro.app/${article.route}/`,
      );
      expect(
        localizedDocument
          .querySelector(`link[rel="alternate"][hreflang="${article.alternateLang}"]`)
          ?.getAttribute("href"),
      ).toBe(`https://markiro.app${article.alternate}`);
      expect(
        localizedDocument.querySelectorAll("[data-key-takeaway]").length,
      ).toBeGreaterThanOrEqual(5);
      expect(localizedDocument.querySelectorAll("figure[data-article-visual]")).toHaveLength(3);
      expect(localizedDocument.querySelectorAll("[data-article-diagram]")).toHaveLength(2);

      const hero = localizedDocument.querySelector<HTMLImageElement>("[data-article-hero-image]");
      expect(hero?.getAttribute("loading")).toBe("eager");
      expect(hero?.getAttribute("width")).not.toBeNull();
      expect(hero?.getAttribute("height")).not.toBeNull();
      for (const diagram of localizedDocument.querySelectorAll<HTMLImageElement>(
        "[data-article-diagram]",
      )) {
        expect(diagram.getAttribute("src")).toContain(article.diagramPrefix);
        expect(diagram.getAttribute("alt")).not.toBe("");
        expect(diagram.getAttribute("loading")).toBe("lazy");
      }

      const graph = JSON.parse(
        localizedDocument.querySelector('script[type="application/ld+json"]')?.textContent ?? "",
      ) as { "@graph": Array<Record<string, unknown>> };
      expect(graph["@graph"].find((entry) => entry["@type"] === "Article")).toMatchObject({
        dateModified: "2026-09-27",
        datePublished: "2026-08-26",
        image: "https://markiro.app/og-offline-beer-marking.jpg",
        inLanguage: article.lang,
      });

      const bodyText = localizedDocument.body.textContent?.replace(/\s+/g, " ") ?? "";
      expect(bodyText).toContain(article.localBoundary);
      expect(bodyText).toMatch(article.durableClaim);
      expect(bodyText).toMatch(article.noFalseSuccess);
      expect(bodyText).toMatch(/прямой обмен.*не.*действующ|direct.*connection.*must not.*live/i);
      expect(bodyText).not.toMatch(
        /Markiro работает без интернета без ограничений|Markiro runs without internet without limits/i,
      );

      for (const href of [
        "https://markirovka.ru/knowledge/tovarnye-gruppy/pivo-pivniye-napitki/sroki-i-etapy-zapuska-obyazatelnoy-markirovki-piva-pivnykh-i-slaboalkogolnykh-napitkov",
        "https://markirovka.ru/knowledge/tovarnyegruppy/obschie-voprosy-gis/pochemu-otklyuchena-vozmozhnost-polucheniya-kodov-markirovki-v-csv-formate-v-stantsii-upravleniya-za",
        "https://markirovka.ru/knowledge/tovarnye-gruppy/pivo-pivniye-napitki/rezhim-proverok-na-kassakh-pivo",
      ]) {
        expect(localizedDocument.querySelector(`a[href="${href}"]`)).not.toBeNull();
      }

      const backlink = path.join(outputDirectory, article.backlinkRoute, "index.html");
      const backlinkDocument = new JSDOM(readFileSync(backlink, "utf8")).window.document;
      expect(backlinkDocument.querySelector(`a[href="/${article.route}/"]`)).not.toBeNull();
    }
  });

  it("publishes a bilingual diagnostic guide for duplicate beer marking codes", () => {
    for (const article of [
      {
        route: "stati/dubl-koda-markirovki-pivo",
        lang: "ru",
        heading: "Дубликат кода маркировки на пиве",
        alternate: "/en/articles/duplicate-beer-marking-code-russia/",
        alternateLang: "en",
        diagramPrefix: "dubl-koda-markirovki-pivo",
        chain: "единица → короб → паллета",
        reportClaim: /потерянный ответ не доказывает/i,
        identityClaim: /один товар — одна уникальная идентичность/i,
        backlinkRoute: "stati/markirovka-piva-bez-interneta",
      },
      {
        route: "en/articles/duplicate-beer-marking-code-russia",
        lang: "en",
        heading: "Duplicate beer marking code in Russia",
        alternate: "/stati/dubl-koda-markirovki-pivo/",
        alternateLang: "ru",
        diagramPrefix: "duplicate-beer-marking-code",
        chain: "item → case → pallet",
        reportClaim: /missing response does not prove/i,
        identityClaim: /one physical product, one unique identity/i,
        backlinkRoute: "en/articles/offline-beer-marking-russia",
      },
    ] as const) {
      const output = path.join(outputDirectory, article.route, "index.html");
      expect(existsSync(output)).toBe(true);
      if (!existsSync(output)) continue;

      const localizedDocument = new JSDOM(readFileSync(output, "utf8")).window.document;
      expect(localizedDocument.documentElement.lang).toBe(article.lang);
      expect(localizedDocument.querySelectorAll("h1")).toHaveLength(1);
      expect(localizedDocument.querySelector("h1")?.textContent).toContain(article.heading);
      expect(localizedDocument.querySelector('link[rel="canonical"]')?.getAttribute("href")).toBe(
        `https://markiro.app/${article.route}/`,
      );
      expect(
        localizedDocument
          .querySelector(`link[rel="alternate"][hreflang="${article.alternateLang}"]`)
          ?.getAttribute("href"),
      ).toBe(`https://markiro.app${article.alternate}`);
      expect(
        localizedDocument.querySelectorAll("[data-key-takeaway]").length,
      ).toBeGreaterThanOrEqual(5);
      expect(localizedDocument.querySelectorAll("figure[data-article-visual]")).toHaveLength(3);
      expect(localizedDocument.querySelectorAll("[data-article-diagram]")).toHaveLength(2);

      const hero = localizedDocument.querySelector<HTMLImageElement>("[data-article-hero-image]");
      expect(hero?.getAttribute("loading")).toBe("eager");
      expect(hero?.getAttribute("width")).not.toBeNull();
      expect(hero?.getAttribute("height")).not.toBeNull();
      for (const diagram of localizedDocument.querySelectorAll<HTMLImageElement>(
        "[data-article-diagram]",
      )) {
        expect(diagram.getAttribute("src")).toContain(article.diagramPrefix);
        expect(diagram.getAttribute("alt")).not.toBe("");
        expect(diagram.getAttribute("loading")).toBe("lazy");
      }

      const graph = JSON.parse(
        localizedDocument.querySelector('script[type="application/ld+json"]')?.textContent ?? "",
      ) as { "@graph": Array<Record<string, unknown>> };
      expect(graph["@graph"].find((entry) => entry["@type"] === "Article")).toMatchObject({
        dateModified: "2026-09-27",
        datePublished: "2026-08-27",
        image: "https://markiro.app/og-duplicate-beer-marking.jpg",
        inLanguage: article.lang,
      });

      const bodyText = localizedDocument.body.textContent?.replace(/\s+/g, " ") ?? "";
      expect(bodyText).toContain(article.chain);
      expect(bodyText).toMatch(article.reportClaim);
      expect(bodyText).toMatch(article.identityClaim);
      expect(bodyText).toMatch(/повторн.*скан|repeated scan/i);
      expect(bodyText).toMatch(/два.*товар|two.*product/i);
      expect(bodyText).toMatch(/повторн.*печат|controlled reprint/i);
      expect(bodyText).toMatch(
        /прямой обмен.*не следует считать готовым|direct.*connection.*not.*live/i,
      );

      for (const href of [
        "https://markirovka.ru/community/beer_producers/markirovka-piva-763",
        "https://markirovka.ru/community/beer_producers/oshibka-pri-otpravke-otcheta-o-nanesenii-",
        "https://markirovka.ru/knowledge/tovarnye-gruppy/pivo-pivniye-napitki/povtornaya-pechat-kodov-markirovki-pivo",
        "https://markirovka.ru/knowledge/tovarnye-gruppy/pivo-pivniye-napitki/povtornaya-pechat-km-dlya-naneseniya-na-vneshnyuyu-upakovku-pivo",
      ]) {
        expect(localizedDocument.querySelector(`a[href="${href}"]`)).not.toBeNull();
      }

      const backlink = path.join(outputDirectory, article.backlinkRoute, "index.html");
      const backlinkDocument = new JSDOM(readFileSync(backlink, "utf8")).window.document;
      expect(backlinkDocument.querySelector(`a[href="/${article.route}/"]`)).not.toBeNull();
    }
  });

  it("publishes a bilingual guide to the beer code application report", () => {
    for (const article of [
      {
        route: "stati/otchet-o-nanesenii-kodov-pivo",
        lang: "ru",
        heading: "Отчёт о нанесении кодов маркировки пива",
        alternate: "/en/articles/beer-code-application-report-russia/",
        alternateLang: "en",
        diagramPrefix: "otchet-nanesenie-pivo",
        sourceClaim: /закрыт.*смен|смен.*закрыт/i,
        partialClaim: /частичн.*только.*ошибочн|только.*ошибочн.*частичн/i,
        commissioningClaim: /ввод в оборот.*автоматически|автоматически.*ввод в оборот/i,
        backlinkRoute: "stati/dubl-koda-markirovki-pivo",
      },
      {
        route: "en/articles/beer-code-application-report-russia",
        lang: "en",
        heading: "Beer code application report in Russia",
        alternate: "/stati/otchet-o-nanesenii-kodov-pivo/",
        alternateLang: "ru",
        diagramPrefix: "beer-application-report",
        sourceClaim: /closed.*shift|shift.*closed/i,
        partialClaim: /partial.*only.*failed|only.*failed.*partial/i,
        commissioningClaim: /commissioning document.*generated|generated.*commissioning document/i,
        backlinkRoute: "en/articles/duplicate-beer-marking-code-russia",
      },
    ] as const) {
      const output = path.join(outputDirectory, article.route, "index.html");
      expect(existsSync(output)).toBe(true);
      if (!existsSync(output)) continue;

      const localizedDocument = new JSDOM(readFileSync(output, "utf8")).window.document;
      expect(localizedDocument.documentElement.lang).toBe(article.lang);
      expect(localizedDocument.querySelectorAll("h1")).toHaveLength(1);
      expect(localizedDocument.querySelector("h1")?.textContent).toContain(article.heading);
      expect(localizedDocument.querySelector('link[rel="canonical"]')?.getAttribute("href")).toBe(
        `https://markiro.app/${article.route}/`,
      );
      expect(
        localizedDocument
          .querySelector(`link[rel="alternate"][hreflang="${article.alternateLang}"]`)
          ?.getAttribute("href"),
      ).toBe(`https://markiro.app${article.alternate}`);
      expect(
        localizedDocument.querySelectorAll("[data-key-takeaway]").length,
      ).toBeGreaterThanOrEqual(5);
      expect(localizedDocument.querySelectorAll("figure[data-article-visual]")).toHaveLength(3);
      expect(localizedDocument.querySelectorAll("[data-article-diagram]")).toHaveLength(2);

      const hero = localizedDocument.querySelector<HTMLImageElement>("[data-article-hero-image]");
      expect(hero?.getAttribute("loading")).toBe("eager");
      expect(hero?.getAttribute("width")).not.toBeNull();
      expect(hero?.getAttribute("height")).not.toBeNull();
      for (const diagram of localizedDocument.querySelectorAll<HTMLImageElement>(
        "[data-article-diagram]",
      )) {
        expect(diagram.getAttribute("src")).toContain(article.diagramPrefix);
        expect(diagram.getAttribute("alt")).not.toBe("");
        expect(diagram.getAttribute("loading")).toBe("lazy");
      }

      const graph = JSON.parse(
        localizedDocument.querySelector('script[type="application/ld+json"]')?.textContent ?? "",
      ) as { "@graph": Array<Record<string, unknown>> };
      expect(graph["@graph"].find((entry) => entry["@type"] === "Article")).toMatchObject({
        dateModified: "2026-08-27",
        datePublished: "2026-08-27",
        image: "https://markiro.app/og-beer-application-report.jpg",
        inLanguage: article.lang,
      });

      const bodyText = localizedDocument.body.textContent?.replace(/\s+/g, " ") ?? "";
      expect(bodyText).toMatch(article.sourceClaim);
      expect(bodyText).toMatch(article.partialClaim);
      expect(bodyText).toMatch(article.commissioningClaim);
      expect(bodyText).toMatch(/GS.*ASCII 29|ASCII 29.*GS/i);
      expect(bodyText).toMatch(/TXT.*CSV|CSV.*TXT/i);
      expect(bodyText).toMatch(
        /прямая подача.*требу.*отдельн|direct submission.*require.*separate/i,
      );
      expect(bodyText).toMatch(
        /XML.*агрегац.*не.*отч[её]т.*нанес|aggregation XML.*not.*application report/i,
      );

      for (const href of [
        "https://markirovka.ru/knowledge/tovarnye-gruppy/pivo-pivniye-napitki/kak-otpravit-otchet-o-nanesenii-pivo",
        "https://markirovka.ru/knowledge/tovarnye-gruppy/pivo-pivniye-napitki/kogda-neobkhodimo-podavat-otchet-o-nanesenii-pivo",
        "https://markirovka.ru/knowledge/tovarnye-gruppy/pivo-pivniye-napitki/chto-delat-esli-ne-sozdalsya-chernovik-otcheta-o-nanesenii-pivo",
        "https://markirovka.ru/knowledge/tovarnye-gruppy/pivo-pivniye-napitki/instruktsiya-po-korrektirovke-svedeniy-o-kodakh-v-sisteme-markirovki-pivo",
      ]) {
        expect(localizedDocument.querySelector(`a[href="${href}"]`)).not.toBeNull();
      }

      const backlink = path.join(outputDirectory, article.backlinkRoute, "index.html");
      const backlinkDocument = new JSDOM(readFileSync(backlink, "utf8")).window.document;
      expect(backlinkDocument.querySelector(`a[href="/${article.route}/"]`)).not.toBeNull();
    }
  });

  it("renders the exact localized Markiro brand", () => {
    const ruBrand = documents.get("/")?.querySelector("header .brand-mark");
    const enBrand = documents.get("/en/")?.querySelector("header .brand-mark");

    expect(ruBrand?.querySelector(".brand-mark__word")?.textContent).toBe("маркиро");
    expect(ruBrand?.getAttribute("aria-label")).toBe("Маркиро");
    expect(enBrand?.querySelector(".brand-mark__word")?.textContent).toBe("MARKIRO");
    expect(enBrand?.getAttribute("aria-label")).toBe("Markiro");

    for (const brand of [ruBrand, enBrand]) {
      expect(brand?.querySelectorAll("[data-brand-module]")).toHaveLength(8);
      expect(brand?.querySelectorAll("[data-brand-accent]")).toHaveLength(1);
    }
  });

  it("keeps localized brand links accessible and prevents wordmark translation", () => {
    const ruDocument = documents.get("/");
    const ruTopic = documents.get("/sscc-i-agregatsiya/");
    const enDocument = documents.get("/en/");
    const ruBrandLinks = [
      ruDocument?.querySelector("header .ax-header__brand"),
      ruDocument?.querySelector("footer .ax-footer__top > a"),
      ruTopic?.querySelector("header .landing-header__brand"),
      ruTopic?.querySelector("footer .landing-footer__meta > a"),
    ];
    const enTopic = documents.get("/en/sscc-and-aggregation/");
    const enBrandLinks = [
      enDocument?.querySelector("header .ax-header__brand"),
      enDocument?.querySelector("footer .ax-footer__top > a"),
      enTopic?.querySelector("header .landing-header__brand"),
      enTopic?.querySelector("footer .landing-footer__meta > a"),
    ];

    for (const brandLink of ruBrandLinks) {
      expect(brandLink?.getAttribute("aria-label")).toBe("Маркиро, на главную страницу");
      expect(brandLink?.querySelector(".brand-mark")?.getAttribute("translate")).toBe("no");
    }

    for (const brandLink of enBrandLinks) {
      expect(brandLink?.getAttribute("aria-label")).toBe("Markiro home page");
      expect(brandLink?.querySelector(".brand-mark")?.getAttribute("translate")).toBe("no");
    }
  });

  it("links the localized footer to the Station product page instead of the binary", () => {
    const ruLink = documents
      .get("/sscc-i-agregatsiya/")
      ?.querySelector<HTMLAnchorElement>('footer a[href="/rabochee-mesto-upakovki/"]');
    const enLink = documents
      .get("/en/sscc-and-aggregation/")
      ?.querySelector<HTMLAnchorElement>('footer a[href="/en/packing-workstation/"]');

    expect(ruLink?.textContent?.trim()).toBe("Станция для Windows");
    expect(enLink?.textContent?.trim()).toBe("Station for Windows");
  });

  it("links the shared header navigation on every page", () => {
    // Every page of a language shares the standalone navigation of its home page.
    const ru = [
      ["/#produkt", "Продукт"],
      ["/stoimost/", "Цены"],
      ["/skachat/", "Скачать"],
      ["/instruktsii/", "Инструкции"],
      ["/#voprosy", "Вопросы"],
    ];
    const en = [
      ["/en/#product", "Product"],
      ["/en/offline-production/", "Offline work"],
      ["/en/instructions/", "Instructions"],
      ["/en/articles/", "Articles"],
      ["/en/faq/", "Questions"],
    ];
    for (const [route, expected] of [
      ["/", ru],
      ["/skachat/", ru],
      ["/stoimost/", ru],
      ["/sscc-i-agregatsiya/", ru],
      ["/en/", en],
      ["/en/sscc-and-aggregation/", en],
    ] as const) {
      const links = [
        ...(documents
          .get(route)
          ?.querySelectorAll(
            "header .landing-nav > a:not(.landing-nav__phone), header .ax-nav > a",
          ) ?? []),
      ].map((link) => [link.getAttribute("href"), link.textContent?.trim()]);
      expect(links, route).toEqual(expected);
    }
  });

  it("groups the footer into product, materials and company columns", () => {
    const columns = (route: string) =>
      [...(documents.get(route)?.querySelectorAll("footer [data-footer-column]") ?? [])].map(
        (column) => ({
          heading: column.querySelector("[data-footer-heading]")?.textContent?.trim(),
          links: [...column.querySelectorAll("a")].map((link) => link.getAttribute("href")),
        }),
      );

    expect(columns("/sscc-i-agregatsiya/")).toEqual([
      {
        heading: "Продукт",
        links: [
          "/skachat/",
          "/stoimost/",
          "/markirovka-chestny-znak/",
          "/sscc-i-agregatsiya/",
          "/rabochee-mesto-upakovki/",
          "/oflayn-rabota/",
          "/integratsiya-1c/",
        ],
      },
      { heading: "Материалы", links: ["/stati/", "/instruktsii/", "/faq/"] },
      { heading: "Компания", links: ["/legal/", "/privacy/", "/personal-data-consent/"] },
    ]);
    expect(columns("/en/sscc-and-aggregation/")).toEqual([
      {
        heading: "Product",
        links: [
          "/en/chestny-znak-serialization/",
          "/en/sscc-and-aggregation/",
          "/en/packing-workstation/",
          "/en/offline-production/",
          "/en/1c-integration/",
        ],
      },
      {
        heading: "Materials",
        links: ["/en/articles/", "/en/instructions/", "/en/faq/"],
      },
      { heading: "Company", links: ["/en/legal/", "/en/privacy/", "/en/personal-data-consent/"] },
    ]);
    expect(
      documents
        .get("/sscc-i-agregatsiya/")
        ?.querySelector("footer [data-footer-column] [data-consent-settings]"),
    ).not.toBeNull();
    for (const route of ["/", "/skachat/", "/stoimost/", "/en/"]) {
      expect(
        documents.get(route)?.querySelector("footer [data-consent-settings]"),
        route,
      ).not.toBeNull();
    }
  });

  it("keeps the words of the home headings apart for crawlers", () => {
    for (const [route, heading] of [
      ["/", "Маркировка и агрегация. Всё на вашем ПК."],
      ["/en/", "Serialization and aggregation. All on your PC."],
    ] as const) {
      const h1 = documents.get(route)?.querySelector("h1");
      // <br> is not text: crawlers read the line break, the spans need a real space.
      h1?.querySelectorAll("br").forEach((br) => br.replaceWith(" "));
      expect(h1?.textContent?.replace(/\s+/g, " ").trim(), route).toBe(heading);
    }
  });

  it("keeps topic pages on the dark theme", () => {
    const html = documents.get("/sscc-i-agregatsiya/")?.documentElement;
    expect(html?.getAttribute("data-theme")).toBe("dark");
    expect(
      documents
        .get("/sscc-i-agregatsiya/")
        ?.querySelector('meta[name="theme-color"]')
        ?.getAttribute("content"),
    ).toBe("#131216");
  });

  it("keeps the cookie panel dark on every page", () => {
    for (const route of ["/", "/en/", "/sscc-i-agregatsiya/"]) {
      expect(
        documents.get(route)?.querySelector("[data-consent-panel]")?.getAttribute("data-theme"),
        route,
      ).toBe("dark");
    }
  });

  it("renders the home page on the light theme", () => {
    for (const route of ["/", "/en/"] as const) {
      const home = documents.get(route);
      expect(home?.documentElement.getAttribute("data-theme"), route).toBe("light");
      expect(home?.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe(
        "#fafaf8",
      );
    }
  });

  it("sets a mobile-safe viewport without disabling zoom", () => {
    expect(document.querySelector('meta[name="viewport"]')?.getAttribute("content")).toBe(
      "width=device-width, initial-scale=1",
    );
  });

  it("renders localized cookie choices and a persistent settings control", () => {
    for (const [route, labels] of [
      ["/", ["Отклонить", "Настроить", "Принять все", "Настройки cookies"]],
      ["/en/", ["Reject", "Customize", "Accept all", "Cookie settings"]],
    ] as const) {
      const localizedDocument = documents.get(route);
      const panel = localizedDocument?.querySelector("[data-consent-panel]");
      expect(panel?.hasAttribute("hidden")).toBe(true);
      expect(panel?.querySelector("[data-consent-reject]")?.textContent?.trim()).toBe(labels[0]);
      expect(panel?.querySelector("[data-consent-customize]")?.textContent?.trim()).toBe(labels[1]);
      expect(panel?.querySelector("[data-consent-accept]")?.textContent?.trim()).toBe(labels[2]);
      expect(
        localizedDocument?.querySelector("footer [data-consent-settings]")?.textContent?.trim(),
      ).toBe(labels[3]);
    }
  });

  it("renders the approved semantic section hierarchy", () => {
    for (const [route, sectionIds] of [
      ["/", ["bez-oblaka", "produkt", "start", "tseny", "kto", "voprosy", "demo"]],
      ["/en/", ["no-cloud", "product", "start", "pricing", "people", "faq", "demo"]],
    ] as const) {
      const home = documents.get(route) as Document;
      expect(home.querySelectorAll("h1"), route).toHaveLength(1);
      expect(home.querySelector("nav[aria-label]"), route).not.toBeNull();
      expect(home.querySelector("main#main"), route).not.toBeNull();
      for (const sectionId of sectionIds) {
        expect(
          home.querySelector(`section#${sectionId}[aria-labelledby]`),
          `${route} ${sectionId}`,
        ).not.toBeNull();
      }
    }
  });

  it("gives every hub group an id without spaces that labels its section", () => {
    for (const hub of HUB_ROUTES) {
      const document = documents.get(hub);
      for (const section of document?.querySelectorAll("section.legal-registry") ?? []) {
        expect(section.id, hub).toMatch(/^hub-group-[a-z0-9]+(-[a-z0-9]+)*$/u);
        const label = section.getAttribute("aria-labelledby") ?? "";
        expect(label, hub).toMatch(/^\S+$/u);
        expect(document?.getElementById(label)?.tagName, `${hub} ${label}`).toBe("H2");
      }
    }
  });

  it("states one product-group boundary: running on beer and cider, other groups checked before launch", () => {
    for (const [route, running, check] of [
      [
        "/markirovka-chestny-znak/",
        "Маркиро работает на линиях пива и сидра",
        "сверяем до запуска",
      ],
      ["/sscc-i-agregatsiya/", "Маркиро работает на линиях пива и сидра", "сверяем до запуска"],
      ["/faq/", "Маркиро работает на линиях пива и сидра", "сверяем до запуска"],
      ["/en/chestny-znak-serialization/", "Markiro runs on beer and cider lines", "before launch"],
      ["/en/sscc-and-aggregation/", "Markiro runs on beer and cider lines", "before launch"],
      ["/en/faq/", "Markiro runs on beer and cider lines", "before launch"],
    ] as const) {
      const text = documents.get(route)?.body.textContent?.replace(/\s+/g, " ") ?? "";
      expect(text, route).toContain(running);
      expect(text, route).toContain(check);
    }

    // The beer-only boundary contradicted the home page; no built page may keep it.
    const retiredClaims = [
      "добавляются поэтапно",
      "Сейчас поддерживается товарная группа",
      "ориентирован на товарную группу",
      "ориентирован на производственные сценарии",
      "Сейчас — «Пиво",
      "being added gradually",
      "being introduced gradually",
      "currently focuses on",
      "The supported product group is currently",
      "Currently “Beer",
    ];
    const builtTexts = readdirSync(outputDirectory, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.(?:html|txt|xml)$/u.test(entry.name))
      .map((entry) => path.join(entry.parentPath, entry.name));
    expect(builtTexts.length).toBeGreaterThan(50);
    for (const file of builtTexts) {
      const text = readFileSync(file, "utf8").replace(/\s+/g, " ");
      for (const claim of retiredClaims) expect(text, `${file}: ${claim}`).not.toContain(claim);
    }

    const ruSscc = documents.get("/sscc-i-agregatsiya/")?.body.textContent ?? "";
    expect(ruSscc).toContain("Поддерживается цепочка «единица → короб → паллета»");
    expect(ruSscc).toContain("у паллеты свой SSCC и своя этикетка");
    expect(ruSscc).not.toContain("будет добавлена отдельным следующим этапом");
    expect(ruSscc).not.toContain("Пока нет");
    expect(ruSscc).not.toContain("у Markiro это короб.");
    expect(ruSscc).not.toContain("связывает короб с его составом");

    const enSscc = documents.get("/en/sscc-and-aggregation/")?.body.textContent ?? "";
    expect(enSscc).toContain("The item → case → pallet chain is supported");
    expect(enSscc).toContain("the pallet gets its own SSCC and label");
    expect(enSscc).not.toContain("will be added as a separate next stage");
    expect(enSscc).not.toContain("Not yet");
    expect(enSscc).not.toContain("a case in Markiro");
    expect(enSscc).not.toContain("connects the case to its contents");

    const ruSerialization = documents.get("/markirovka-chestny-znak/")?.body.textContent ?? "";
    expect(ruSerialization).toContain("связь единицы с коробом и короба с паллетой");
    expect(ruSerialization).not.toContain("связь единицы с коробом или паллетой");

    const enSerialization =
      documents.get("/en/chestny-znak-serialization/")?.body.textContent ?? "";
    expect(enSerialization).toContain(
      "the relationship between an item and its case, and between a case and its pallet",
    );
    expect(enSerialization).not.toContain("the relationship between an item, case, or pallet");

    const ruFaq = documents.get("/faq/")?.body.textContent ?? "";
    expect(ruFaq).toContain(
      "Да. Единицы собираются в короб с SSCC, короба — в паллету со своим SSCC: на станции упаковки или на ТСД.",
    );
    expect(ruFaq).not.toContain("Пока нет");
    expect(ruFaq).not.toContain("после паллетной агрегации");

    const enFaq = documents.get("/en/faq/")?.body.textContent ?? "";
    expect(enFaq).toContain(
      "Yes. Items are aggregated into a case with an SSCC, and cases into a pallet with its own SSCC, on the packing workstation or on the handheld.",
    );
    expect(enFaq).not.toContain("Not yet");
    expect(enFaq).not.toContain("after pallet aggregation");

    const ru1c = documents.get("/integratsiya-1c/")?.body.textContent ?? "";
    expect(ru1c).toContain("Прямого обмена с 1С сейчас нет.");
    expect(ru1c).toContain("XML «Отчёт об агрегации»");
    expect(ru1c).not.toContain("CommerceML");
    expect(ru1c).not.toContain("после паллетной агрегации");

    const en1c = documents.get("/en/1c-integration/")?.body.textContent ?? "";
    expect(en1c).toContain("There is no direct exchange with 1C today.");
    expect(en1c).toContain("the aggregation report XML");
    expect(en1c).not.toContain("CommerceML");
    expect(en1c).not.toContain("after pallet aggregation");
  });

  // MKR-AGR-01 is still a draft, so the home pages list only what /legal/ publishes.
  it("does not claim the agreement is published", () => {
    for (const [route, lead, link, retired] of [
      [
        "/",
        "Открыты до покупки: можно прочитать, как устроена работа на линии, ещё до установки.",
        "Документы и реквизиты",
        "договор и регламенты опубликованы",
      ],
      [
        "/en/",
        "Open before you buy: you can read the documents and the terms before installing anything.",
        "Legal documents",
        "the agreement and the regulations are published",
      ],
    ] as const) {
      const page = documents.get(route);
      const text = page?.body.textContent?.replace(/\s+/g, " ") ?? "";
      expect(text, route).toContain(lead);
      expect(text, route).not.toContain(retired);
      const legalLink = [...(page?.querySelectorAll("a") ?? [])].find(
        (anchor) => anchor.textContent?.replace("→", "").trim() === link,
      );
      expect(legalLink?.getAttribute("href"), route).toBe(route === "/" ? "/legal/" : "/en/legal/");
    }
  });

  // The owner's decision (#787): the home pages carry no call form; leads come through
  // /skachat/ and /stoimost/, and «Разобрать линию» leads to the contacts of the home page.
  it("closes both home pages with the contacts block that every call link targets", () => {
    for (const route of ["/", "/en/"] as const) {
      const home = documents.get(route) as Document;
      const contacts = home.querySelector("section#demo.ax-final[aria-labelledby]");
      expect(contacts, route).not.toBeNull();
      expect(contacts?.querySelector('a[href="mailto:hello@markiro.app"]'), route).not.toBeNull();
      expect(contacts?.querySelector('a[href^="https://t.me/"]'), route).not.toBeNull();
      const call = contacts?.querySelector<HTMLAnchorElement>(
        'a[data-placement="final"][href^="mailto:"]',
      );
      expect(call?.getAttribute("href"), route).toBe("mailto:hello@markiro.app");
      for (const link of home.querySelectorAll('main a[data-analytics="landing_demo_click"]')) {
        const href = link.getAttribute("href") ?? "";
        expect(href === `${route}#demo` || href.startsWith("mailto:"), `${route} ${href}`).toBe(
          true,
        );
      }
    }
  });

  it("renders no demo request form on any page", () => {
    const formRoutes = readdirSync(enabledOutputDirectory, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".html"))
      .filter((entry) =>
        readFileSync(path.join(entry.parentPath, entry.name), "utf8").includes("data-demo-form"),
      )
      .map((entry) => entry.name);
    expect(formRoutes).toEqual([]);
    for (const route of ["/", "/en/"]) {
      const home = enabledDocuments.get(route) as Document;
      expect(home.querySelector(".smart-captcha"), route).toBeNull();
      expect(home.documentElement.outerHTML, route).not.toContain("ysc1_render-test-key");
    }
  });

  // Sales contacts moved to the product domain; the published legal editions keep
  // the operator profile's address until they are reissued.
  it("publishes the site contact address on sales surfaces and in structured data", () => {
    for (const route of ["/", "/en/", "/faq/", "/en/faq/"] as const) {
      const routeDocument = documents.get(route);
      const graph = JSON.parse(
        routeDocument?.querySelector('script[type="application/ld+json"]')?.textContent ?? "{}",
      ) as { "@graph"?: Array<Record<string, unknown>> };
      const organization = graph["@graph"]?.find((entry) => entry["@type"] === "Organization");
      expect(organization?.email, route).toBe("hello@markiro.app");
      expect(routeDocument?.body.textContent, route).not.toContain("hello@v-b.tech");
    }
    expect(documents.get("/faq/")?.body.textContent).toContain("hello@markiro.app");
    expect(documents.get("/en/faq/")?.body.textContent).toContain("hello@markiro.app");

    const llms = readFileSync(path.join(outputDirectory, "llms.txt"), "utf8");
    expect(llms).toContain("hello@markiro.app");
    expect(llms).not.toContain("hello@v-b.tech");
  });

  it("offers the way home and to the demo form from the branded 404", () => {
    const notFound = new JSDOM(readFileSync(path.join(outputDirectory, "404.html"), "utf8")).window
      .document;
    expect(notFound.querySelector("h1")?.textContent).toContain("Revision not found");
    const hrefs = [...notFound.querySelectorAll("main a")].map((anchor) =>
      anchor.getAttribute("href"),
    );
    expect(hrefs).toEqual(expect.arrayContaining(["/", "/#demo", "/legal/"]));
  });

  it("does not ship an admin screenshot or invented contact data", () => {
    expect(document.documentElement.outerHTML).not.toContain("screenshot-127.0.0.1");
    expect(document.documentElement.outerHTML).not.toContain("+7 800 555");
    expect(document.querySelector('a[href^="tel:"]')).toBeNull();
  });

  it("ships an Apple touch icon and links it from every page", () => {
    expect(existsSync(path.join(outputDirectory, "apple-touch-icon.png"))).toBe(true);
    for (const [route, routeDocument] of documents) {
      const link = routeDocument.querySelector('link[rel="apple-touch-icon"]');
      expect(link?.getAttribute("href"), route).toBe("/apple-touch-icon.png");
      expect(link?.getAttribute("sizes"), route).toBe("180x180");
    }
  });

  it("keeps hub links short so the anchor text is the title alone", () => {
    for (const route of HUB_ROUTES) {
      const hub = documents.get(route) as Document;
      for (const item of hub.querySelectorAll("[data-hub-item]")) {
        const link = item.querySelector("a[href]");
        const description = item.querySelector(".hub-item__description");
        expect(description, route).not.toBeNull();
        expect(description?.closest("a"), route).toBeNull();
        expect(link?.textContent?.length ?? 999, route).toBeLessThan(160);
      }
    }
  });

  it("renders complete unique metadata for every canonical route", () => {
    const titles = new Set<string>();
    const descriptions = new Set<string>();

    for (const [route, routeDocument] of documents) {
      const title = routeDocument.title;
      const description = routeDocument
        .querySelector('meta[name="description"]')
        ?.getAttribute("content");

      expect(routeDocument.querySelectorAll("h1")).toHaveLength(1);
      expect(routeDocument.querySelector('meta[name="robots"]')?.getAttribute("content")).toBe(
        "index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1",
      );
      expect(routeDocument.querySelector('link[rel="canonical"]')?.getAttribute("href")).toBe(
        `https://markiro.app${route}`,
      );
      expect(routeDocument.querySelector('meta[property="og:site_name"]')).not.toBeNull();
      const expectedLocale = route.startsWith("/en/") ? "en" : "ru";
      const alternateLocale = expectedLocale === "ru" ? "en" : "ru";
      expect(routeDocument.documentElement.lang).toBe(expectedLocale);
      expect(
        routeDocument.querySelector('meta[property="og:locale"]')?.getAttribute("content"),
      ).toBe(expectedLocale === "ru" ? "ru_RU" : "en_US");
      // /skachat/ and /stoimost/ are Russian only (spec 2026-10-20, open question О7).
      const hasAlternate = !(AUTONOM_ROUTES as readonly string[]).includes(route);
      expect(
        routeDocument.querySelector(`link[rel="alternate"][hreflang="${alternateLocale}"]`) !==
          null,
        route,
      ).toBe(hasAlternate);
      expect(
        routeDocument.querySelector('link[rel="alternate"][hreflang="x-default"]') !== null,
        route,
      ).toBe(hasAlternate);
      expect(routeDocument.querySelector('meta[property="og:image:alt"]')).not.toBeNull();
      expect(routeDocument.querySelector('meta[name="twitter:title"]')).not.toBeNull();
      expect(routeDocument.querySelector('meta[name="twitter:description"]')).not.toBeNull();
      expect(routeDocument.querySelector('meta[name="twitter:image"]')).not.toBeNull();
      expect(routeDocument.querySelector('meta[name="twitter:image:alt"]')).not.toBeNull();
      expect(routeDocument.querySelector('link[rel="manifest"]')?.getAttribute("href")).toBe(
        expectedLocale === "ru" ? "/site.webmanifest" : "/site.en.webmanifest",
      );
      expect(title).not.toBe("");
      expect(description).toBeTruthy();
      titles.add(title);
      descriptions.add(description as string);
    }

    expect(titles.size).toBe(documents.size);
    expect(descriptions.size).toBe(documents.size);
  });

  it("publishes hubs that list every article and instruction of their locale", () => {
    const ruArticles = documents.get("/stati/") as Document;
    const enArticles = documents.get("/en/articles/") as Document;
    const ruInstructions = documents.get("/instruktsii/") as Document;
    const enInstructions = documents.get("/en/instructions/") as Document;

    const ruArticleLinks = [...ruArticles.querySelectorAll("[data-hub-item] a[href]")].map((a) =>
      a.getAttribute("href"),
    );
    expect(ruArticleLinks).toEqual(
      expect.arrayContaining([
        "/stati/markirovka-piva-2026/",
        "/stati/agregatsiya-piva-v-koroba/",
        "/stati/otchet-o-nanesenii-kodov-pivo/",
      ]),
    );
    expect(ruArticleLinks).toHaveLength(9);
    expect(ruArticleLinks.every((href) => href?.startsWith("/stati/"))).toBe(true);
    expect([...enArticles.querySelectorAll("[data-hub-item] a[href]")]).toHaveLength(9);

    const ruInstructionLinks = [...ruInstructions.querySelectorAll("[data-hub-item] a[href]")].map(
      (a) => a.getAttribute("href"),
    );
    expect(ruInstructionLinks).toHaveLength(10);
    expect(ruInstructionLinks.every((href) => href?.startsWith("/instruktsii/"))).toBe(true);
    expect([...enInstructions.querySelectorAll("[data-hub-item] a[href]")]).toHaveLength(10);

    for (const hub of [ruArticles, enArticles, ruInstructions, enInstructions]) {
      expect(hub.querySelectorAll("h1")).toHaveLength(1);
      expect(hub.querySelector('a[href$="#demo"]')).not.toBeNull();
    }
  });

  it("links the cluster from the header, the footer and the documents card", () => {
    // Both home pages link instructions from their header and documents card and
    // articles from the footer.
    for (const [route, instructions, articles, documentsCard] of [
      ["/", "/instruktsii/", "/stati/", "#kto"],
      ["/en/", "/en/instructions/", "/en/articles/", "#people"],
    ] as const) {
      const home = documents.get(route) as Document;
      expect(
        home.querySelector(`${documentsCard} a[href="${instructions}"]`),
        route,
      ).not.toBeNull();
      expect(home.querySelector(`header nav a[href="${instructions}"]`), route).not.toBeNull();
      expect(home.querySelector(`footer nav a[href="${articles}"]`), route).not.toBeNull();
      expect(home.querySelector(`footer nav a[href="${instructions}"]`), route).not.toBeNull();
    }
  });

  it("routes article and instruction breadcrumbs through their hubs", () => {
    const article = documents.get("/stati/markirovka-piva-2026/") as Document;
    const crumbs = [...article.querySelectorAll('nav[aria-label="Хлебные крошки"] li')].map(
      (item) => item.textContent?.trim(),
    );
    expect(crumbs).toEqual(["Markiro", "Статьи", "Маркировка пива в 2026 году"]);
    expect(
      article.querySelector('nav[aria-label="Хлебные крошки"] a[href="/stati/"]'),
    ).not.toBeNull();

    const instruction = documents.get("/instruktsii/stantsiya-vkhod-i-start-smeny/") as Document;
    const instructionCrumbs = [
      ...instruction.querySelectorAll('nav[aria-label="Хлебные крошки"] li'),
    ].map((item) => item.textContent?.trim());
    expect(instructionCrumbs.slice(0, 2)).toEqual(["Markiro", "Инструкции"]);
    expect(instructionCrumbs).toHaveLength(3);
  });

  it("links topic pages to related articles of the same locale", () => {
    for (const route of EXPECTED_ROUTES.filter((path) => path !== "/" && path !== "/en/")) {
      const routeDocument = documents.get(route) as Document;
      const articleLinks = [
        ...routeDocument.querySelectorAll('[data-related-articles] a[href^="/"]'),
      ].map((a) => a.getAttribute("href") ?? "");
      expect(articleLinks.length, route).toBeGreaterThanOrEqual(2);
      const prefix = route.startsWith("/en/") ? "/en/articles/" : "/stati/";
      expect(
        articleLinks.every((href) => href.startsWith(prefix)),
        route,
      ).toBe(true);
    }
  });

  it("renders English pages without Russian interface copy", () => {
    for (const [route, routeDocument] of documents) {
      if (!route.startsWith("/en/")) continue;
      expect(routeDocument.body.textContent).not.toMatch(/[А-Яа-яЁё]/);
      expect(routeDocument.querySelector('a[hreflang="ru"]')).not.toBeNull();
      expect(routeDocument.querySelector('a[hreflang="en"][aria-current="page"]')).not.toBeNull();
    }
  });

  it("renders parseable structured data that matches visible navigation", () => {
    for (const [route, routeDocument] of documents) {
      const script = routeDocument.querySelector('script[type="application/ld+json"]');
      expect(script).not.toBeNull();
      const graph = JSON.parse(script?.textContent ?? "") as {
        "@graph": Array<Record<string, unknown>>;
      };

      expect(graph["@graph"].some((entry) => entry["@type"] === "WebSite")).toBe(true);
      expect(
        graph["@graph"].some(
          (entry) => entry["@type"] === "WebPage" || entry["@type"] === "CollectionPage",
        ),
      ).toBe(true);
      expect(graph["@graph"].some((entry) => entry["@type"] === "Organization")).toBe(true);
      // The product entity belongs to the topic cluster; hubs, articles and
      // instructions describe their own content instead of repeating it.
      if ((EXPECTED_ROUTES as readonly string[]).includes(route)) {
        expect(graph["@graph"].some((entry) => entry["@type"] === "SoftwareApplication")).toBe(
          true,
        );
      }

      const breadcrumbsLabel = route.startsWith("/en/") ? "Breadcrumbs" : "Хлебные крошки";
      const showsBreadcrumbs =
        routeDocument.querySelector(`nav[aria-label="${breadcrumbsLabel}"]`) !== null;
      // Structured breadcrumbs describe only a trail the page shows; the home
      // pages, /skachat/ and /stoimost/ show none.
      expect(
        graph["@graph"].some((entry) => entry["@type"] === "BreadcrumbList"),
        route,
      ).toBe(showsBreadcrumbs);
      expect(showsBreadcrumbs, route).toBe(!["/", "/en/", ...AUTONOM_ROUTES].includes(route));
    }
  });

  it("keeps FAQ structured answers identical to visible answers on every page with FAQ", () => {
    let pagesWithFaq = 0;
    for (const [route, routeDocument] of documents) {
      const visible = [...routeDocument.querySelectorAll("[data-faq-item]")].map((item) => ({
        name: item.querySelector("h2, h3")?.textContent?.trim(),
        text: item.querySelector("p")?.textContent?.trim(),
      }));
      const graph = JSON.parse(
        routeDocument.querySelector('script[type="application/ld+json"]')?.textContent ?? "",
      ) as { "@graph": Array<Record<string, unknown>> };
      const faq = graph["@graph"].find((entry) => entry["@type"] === "FAQPage") as
        { mainEntity: Array<{ name: string; acceptedAnswer: { text: string } }> } | undefined;

      if (visible.length === 0) {
        expect(faq, route).toBeUndefined();
        continue;
      }
      pagesWithFaq += 1;
      expect(faq, route).toBeDefined();
      expect(visible, route).toEqual(
        faq?.mainEntity.map((entry) => ({ name: entry.name, text: entry.acceptedAnswer.text })),
      );
    }
    expect(pagesWithFaq).toBeGreaterThanOrEqual(14);
  });

  it("gives topic pages a summary, a visible review date and enough substance", () => {
    for (const route of EXPECTED_ROUTES.filter((path) => path !== "/" && path !== "/en/")) {
      const routeDocument = documents.get(route) as Document;
      expect(
        routeDocument.querySelectorAll("[data-page-summary] li").length,
        route,
      ).toBeGreaterThanOrEqual(3);
      const reviewed = routeDocument.querySelector<HTMLTimeElement>("time[data-reviewed-at]");
      expect(reviewed?.getAttribute("datetime"), route).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(reviewed?.textContent?.trim().length, route).toBeGreaterThan(0);
      const words =
        routeDocument
          .querySelector("main")
          ?.textContent?.replace(/\s+/g, " ")
          .trim()
          .split(" ")
          .filter(Boolean).length ?? 0;
      expect(words, route).toBeGreaterThanOrEqual(450);
    }
  });

  it("advertises the locale feed and a markdown mirror on every indexable page", () => {
    for (const [route, routeDocument] of documents) {
      const feed = routeDocument.querySelector('link[rel="alternate"][type="application/rss+xml"]');
      expect(feed?.getAttribute("href"), route).toBe(
        route.startsWith("/en/") ? "/en/articles/rss.xml" : "/stati/rss.xml",
      );
      const markdown = routeDocument.querySelector('link[rel="alternate"][type="text/markdown"]');
      const expected = route === "/" ? "/index.md" : `${route.slice(0, -1)}.md`;
      expect(markdown?.getAttribute("href"), route).toBe(expected);
    }
    const notFound = new JSDOM(readFileSync(path.join(outputDirectory, "404.html"), "utf8")).window
      .document;
    expect(notFound.querySelector('link[rel="alternate"][type="text/markdown"]')).toBeNull();
    const verification = new JSDOM(
      readFileSync(
        path.join(outputDirectory, "d/MKR-PD-01/2026.08/01/15.08.2026/index.html"),
        "utf8",
      ),
    ).window.document;
    expect(verification.querySelector('link[rel="alternate"][type="text/markdown"]')).toBeNull();
    expect(existsSync(path.join(outputDirectory, "stati/rss.xml"))).toBe(true);
    expect(existsSync(path.join(outputDirectory, "en/articles/rss.xml"))).toBe(true);
  });

  it("leads topic pages to the installer, the prices and the call request", () => {
    for (const [route, home, hreflang] of [
      ["/markirovka-chestny-znak/", "/", null],
      ["/en/chestny-znak-serialization/", "/en/", "ru"],
    ] as const) {
      const routeDocument = documents.get(route) as Document;
      for (const block of [".seo-hero", ".seo-cta"]) {
        for (const target of ["/skachat/", "/stoimost/"]) {
          const link = routeDocument.querySelector(`${block} a[href="${target}"]`);
          expect(link, `${route} ${block} ${target}`).not.toBeNull();
          expect(link?.getAttribute("hreflang") ?? null, `${route} ${target}`).toBe(hreflang);
        }
      }
      expect(routeDocument.querySelector(`.seo-cta a[href="${home}#demo"]`), route).not.toBeNull();
      // The build of this suite has no public phone.
      expect(routeDocument.querySelector('.seo-cta a[href^="tel:"]'), route).toBeNull();
    }
    const note = "The download and pricing pages are in Russian.";
    const english = documents.get("/en/chestny-znak-serialization/") as Document;
    expect(english.querySelector(".seo-hero__note")?.textContent).toBe(note);
    expect(documents.get("/markirovka-chestny-znak/")?.querySelector(".seo-hero__note")).toBeNull();
  });

  it("preloads the above-the-fold font subsets that the stylesheet actually uses", () => {
    for (const [route, expectedSubsets, forbiddenSubset] of [
      ["/", ["cyrillic", "latin"], null],
      ["/stati/markirovka-piva-2026/", ["cyrillic", "latin"], null],
      ["/en/", ["latin"], "cyrillic"],
    ] as const) {
      const routeDocument = documents.get(route) as Document;
      const preloads = [...routeDocument.querySelectorAll('link[rel="preload"][as="font"]')].map(
        (link) => link.getAttribute("href") ?? "",
      );
      expect(preloads.length, route).toBeGreaterThanOrEqual(3);
      expect(preloads.length, route).toBeLessThanOrEqual(6);
      const stylesheetHref =
        routeDocument.querySelector('link[rel="stylesheet"]')?.getAttribute("href") ?? "";
      const stylesheet = readFileSync(path.join(outputDirectory, stylesheetHref.slice(1)), "utf8");
      for (const href of preloads) {
        expect(href, route).toMatch(
          /^\/assets\/ibm-plex-(?:sans|mono)-[a-z-]+-(?:400|500|600)-normal\..+\.woff2$/,
        );
        expect(existsSync(path.join(outputDirectory, href.slice(1))), `${route} ${href}`).toBe(
          true,
        );
        expect(stylesheet.includes(href.slice("/assets/".length)), `${route} ${href}`).toBe(true);
      }
      for (const subset of expectedSubsets) {
        expect(
          preloads.some((href) => href.includes(`-${subset}-`)),
          `${route} ${subset}`,
        ).toBe(true);
      }
      if (forbiddenSubset !== null) {
        expect(
          preloads.some((href) => href.includes(`-${forbiddenSubset}-`)),
          route,
        ).toBe(false);
      }
      for (const link of routeDocument.querySelectorAll('link[rel="preload"][as="font"]')) {
        expect(link.hasAttribute("crossorigin"), route).toBe(true);
        expect(link.getAttribute("type"), route).toBe("font/woff2");
      }
    }
  });

  it("publishes the IndexNow key file only when the key is configured", () => {
    const keyFile = "markiro-indexnow-render-key.txt";
    expect(existsSync(path.join(outputDirectory, keyFile))).toBe(false);
    expect(existsSync(path.join(enabledOutputDirectory, keyFile))).toBe(true);
    expect(readFileSync(path.join(enabledOutputDirectory, keyFile), "utf8")).toBe(
      "markiro-indexnow-render-key",
    );
    expect(enabledDocuments.get("/")?.documentElement.outerHTML).not.toContain(
      "markiro-indexnow-render-key",
    );
  });

  it("falls back to a JPEG for article hero images instead of the multi-megabyte PNG", () => {
    const article = documents.get("/stati/markirovka-piva-2026/") as Document;
    const hero = article.querySelector<HTMLImageElement>("[data-article-hero-image]");
    expect(hero?.getAttribute("src")).toMatch(/\.jpe?g$/);
    expect(hero?.getAttribute("srcset")).not.toMatch(/\.png/);
    expect(article.querySelector('picture source[type="image/avif"]')).not.toBeNull();
  });

  it("retires the kiosk and the film from every built page and search surface", () => {
    // Both moved permanently to the home page of their language (Caddy 301, 2026-10-23).
    const retired = [
      "/kiosk-samovydachi/",
      "/en/self-service-pickup-kiosk/",
      "/kak-rabotaet/",
      "/en/how-it-works/",
    ];
    const builtFiles = readdirSync(outputDirectory, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.(?:html|txt|xml|md)$/u.test(entry.name))
      .map((entry) => path.join(entry.parentPath, entry.name));
    expect(builtFiles.length).toBeGreaterThan(50);
    for (const file of builtFiles) {
      const text = readFileSync(file, "utf8");
      for (const route of retired) expect(text, `${file}: ${route}`).not.toContain(route);
    }
    for (const route of retired) {
      expect(existsSync(path.join(outputDirectory, route.slice(1), "index.html")), route).toBe(
        false,
      );
    }
  });

  it("retires the inventory and National Catalog instructions from every built page", () => {
    // Markiro Autonom has neither feature, so MKR-INS-05, 06, 07 and 11 were withdrawn:
    // their pages moved permanently to the instructions hub of their language and their
    // verification pages to /instruktsii/ (Caddy 301, 2026-10-29).
    const retired = [
      "/instruktsii/inventarizatsiya-na-terminale/",
      "/instruktsii/inventarizatsiya-podgotovka/",
      "/instruktsii/inventarizatsiya-zakrytie/",
      "/instruktsii/katalog-zagruzka-iz-nk/",
      "/en/instructions/terminal-inventory-count/",
      "/en/instructions/inventory-preparation/",
      "/en/instructions/inventory-closing/",
      "/en/instructions/national-catalog-import/",
      "/d/MKR-INS-05/",
      "/d/MKR-INS-06/",
      "/d/MKR-INS-07/",
      "/d/MKR-INS-11/",
    ];
    const builtFiles = readdirSync(outputDirectory, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.(?:html|txt|xml|md)$/u.test(entry.name))
      .map((entry) => path.join(entry.parentPath, entry.name));
    expect(builtFiles.length).toBeGreaterThan(50);
    for (const file of builtFiles) {
      const text = readFileSync(file, "utf8");
      for (const route of retired) expect(text, `${file}: ${route}`).not.toContain(route);
    }
    for (const route of retired) {
      expect(existsSync(path.join(outputDirectory, route.slice(1))), route).toBe(false);
    }
  });

  it("links every specialist page to at least two canonical related pages", () => {
    for (const route of EXPECTED_ROUTES.filter((path) => path !== "/" && path !== "/en/")) {
      const routeDocument = documents.get(route) as Document;
      const relatedLinks = [...routeDocument.querySelectorAll('[data-related-pages] a[href^="/"]')];
      expect(relatedLinks.length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("standalone pages: home, /skachat/, /stoimost/", () => {
  function jsonLd(route: string): Array<Record<string, unknown>> {
    const script = documents.get(route)?.querySelector('script[type="application/ld+json"]');
    return (
      JSON.parse(script?.textContent ?? "{}") as { "@graph": Array<Record<string, unknown>> }
    )["@graph"];
  }

  it("leads the header button of every page to the installer", () => {
    for (const [route, selector, hreflang] of [
      ["/", ".ax-header__cta", null],
      ["/sscc-i-agregatsiya/", ".landing-header__cta", null],
      ["/en/", ".ax-header__cta", "ru"],
      ["/en/sscc-and-aggregation/", ".landing-header__cta", "ru"],
    ] as const) {
      const cta = documents.get(route)?.querySelector(selector);
      expect(cta?.getAttribute("href"), route).toBe("/skachat/");
      expect(cta?.getAttribute("hreflang") ?? null, route).toBe(hreflang);
    }
  });

  it("leads English calls to action to the Russian download and pricing pages and says so", () => {
    const home = documents.get("/en/") as Document;
    const links = [
      ...home.querySelectorAll<HTMLAnchorElement>(
        'main a[href="/skachat/"], main a[href="/stoimost/"]',
      ),
    ];
    expect(links.length).toBeGreaterThanOrEqual(4);
    for (const link of links) expect(link.getAttribute("hreflang"), link.href).toBe("ru");
    const text = home.body.textContent?.replace(/\s+/g, " ") ?? "";
    expect(text).toContain("The download and pricing pages are in Russian.");
    expect(home.querySelector('.ax-hero a[href="/stoimost/"]')?.textContent?.trim()).toBe(
      "Pricing from 60 000 RUB a year",
    );
  });

  it("lets the visitor pick the theme and applies it before the first paint", () => {
    for (const route of ["/", "/en/", ...AUTONOM_ROUTES]) {
      const page = documents.get(route) as Document;
      expect(page.documentElement.getAttribute("data-theme"), route).toBe("light");
      expect(page.documentElement.getAttribute("data-theme-choice"), route).toBe("system");
      const init = page.querySelector('head script[src="/theme-init.js"]');
      expect(init, route).not.toBeNull();
      expect(init?.hasAttribute("type"), route).toBe(false);
      expect(
        [...page.querySelectorAll("[data-theme-option]")].map((option) =>
          option.getAttribute("data-theme-option"),
        ),
        route,
      ).toEqual(["system", "light", "dark", "system", "light", "dark"]);
    }
    expect(existsSync(path.join(outputDirectory, "theme-init.js"))).toBe(true);
    // Topic pages keep their fixed theme and load no switch.
    const topic = documents.get("/sscc-i-agregatsiya/") as Document;
    expect(topic.querySelector('script[src="/theme-init.js"]')).toBeNull();
  });

  it("leads every download button to /skachat/ and every invoice link to the form", () => {
    const home = documents.get("/") as Document;
    const downloads = [
      ...home.querySelectorAll<HTMLAnchorElement>('a[data-analytics="landing_download_click"]'),
    ];
    expect(downloads.length).toBeGreaterThanOrEqual(5);
    for (const link of downloads) expect(link.getAttribute("href")).toBe("/skachat/");
    expect(
      [...home.querySelectorAll("a[data-invoice-tariff]")].map((link) => link.getAttribute("href")),
    ).toEqual([
      "/stoimost/?tarif=line#schet",
      "/stoimost/?tarif=workshop#schet",
      "/stoimost/?tarif=start#schet",
    ]);
    expect(home.querySelector('.ax-hero a[href="/stoimost/"]')?.textContent?.trim()).toBe(
      "Цены от 60 000 ₽ в год",
    );
    expect(
      documents.get("/stoimost/")?.querySelector("section#schet form[data-lead-form]"),
    ).not.toBeNull();
  });

  it("shows the published prices on the home page and /stoimost/", () => {
    for (const route of ["/", "/stoimost/"]) {
      const page = documents.get(route) as Document;
      const plans = [...page.querySelectorAll<HTMLElement>("[data-tariff]")].map((plan) => [
        plan.dataset.tariff,
        plan.querySelector(".ax-plan__amount, .ax-plan__price--words span")?.textContent?.trim(),
      ]);
      expect(plans, route).toEqual([
        ["line", "120 000"],
        ["workshop", "240 000"],
        ["plant", "По запросу"],
        ["start", "60 000"],
      ]);
      expect(page.querySelector('[data-tariff="line"]')?.getAttribute("data-theme"), route).toBe(
        "dark",
      );
    }
  });

  it("describes /stoimost/ prices as a Product with yearly offers in roubles", () => {
    const product = jsonLd("/stoimost/").find((entry) => entry["@type"] === "Product") as
      | {
          name: string;
          offers: { lowPrice: number; highPrice: number; offers: Array<Record<string, unknown>> };
        }
      | undefined;
    expect(product?.name).toBe("Маркиро Автоном");
    expect(product?.offers).toMatchObject({ lowPrice: 60_000, highPrice: 240_000 });
    expect(
      product?.offers.offers.map((offer) => [offer.name, offer.price, offer.priceCurrency]),
    ).toEqual([
      ["«Старт»", 60_000, "RUB"],
      ["«Линия»", 120_000, "RUB"],
      ["«Цех»", 240_000, "RUB"],
    ]);
    const visible = documents.get("/stoimost/")?.body.textContent?.replace(/\s+/g, " ") ?? "";
    for (const price of ["60 000", "120 000", "240 000"]) expect(visible).toContain(price);
    expect(jsonLd("/skachat/").some((entry) => entry["@type"] === "Product")).toBe(false);
  });

  it("renders the download form with the spec 15.3 contract only in enabled builds", () => {
    const disabled = documents
      .get("/skachat/")
      ?.querySelector<HTMLFormElement>("form[data-lead-form]");
    expect(disabled?.dataset.intent).toBe("download");
    expect(disabled?.hasAttribute("data-endpoint")).toBe(false);
    expect(
      disabled?.querySelector<HTMLFieldSetElement>("fieldset[data-lead-fields]")?.disabled,
    ).toBe(true);
    expect(disabled?.querySelector('input[name="consent"]')).toBeNull();
    expect(disabled?.querySelector(".smart-captcha")).toBeNull();
    expect(documents.get("/skachat/")?.documentElement.outerHTML).not.toContain(
      "ysc1_stray-client-key",
    );

    const form = enabledDocuments
      .get("/skachat/")
      ?.querySelector<HTMLFormElement>("form[data-lead-form]");
    expect(form?.dataset.endpoint).toBe("/api/landing-leads");
    expect(form?.dataset.consentVersion).toBe("MKR-PD-02/2026.08/01");
    expect(
      [...(form?.querySelectorAll("input[name], select[name]") ?? [])].map((input) =>
        input.getAttribute("name"),
      ),
    ).toEqual(["email", "company", "website", "consent"]);
    expect(form?.querySelector('input[name="email"]')?.getAttribute("autocomplete")).toBe("email");
    expect(
      form?.querySelector('.ax-honeypot input[name="website"]')?.getAttribute("tabindex"),
    ).toBe("-1");
    expect(form?.querySelector(".smart-captcha")).toBeNull();
    expect(form?.querySelector('a[href="/personal-data-consent/"]')).not.toBeNull();
    expect(form?.querySelector('a[href="/privacy/"]')).not.toBeNull();
    expect(
      enabledDocuments
        .get("/skachat/")
        ?.querySelector('script[src="https://smartcaptcha.cloud.yandex.ru/captcha.js"]'),
    ).toBeNull();
  });

  it("keeps spaces around every legal link in both consent labels", () => {
    for (const route of ["/skachat/", "/stoimost/"]) {
      const label = enabledDocuments.get(route)?.querySelector(".ax-consent label");
      expect(label?.textContent?.replace(/\s+/gu, " ").trim(), route).toBe(
        "Согласен на обработку персональных данных по политике Маркиро",
      );
    }
  });

  it("separates the Russian FAQ contact links from the surrounding words", () => {
    const text = documents
      .get("/")
      ?.querySelector("#voprosy .ax-faq__intro .ax-muted")
      ?.textContent?.replace(/\s+/gu, " ")
      .trim();
    expect(text).toBe(
      "Если ответа здесь нет, напишите в Telegram @thevladbog или на hello@markiro.app.",
    );
  });

  it("separates the English FAQ contact links from the surrounding words", () => {
    const text = documents
      .get("/en/")
      ?.querySelector("#faq .ax-faq__intro .ax-muted")
      ?.textContent?.replace(/\s+/gu, " ")
      .trim();
    expect(text).toBe(
      "If your question is not here, write to Telegram @thevladbog or to hello@markiro.app.",
    );
  });

  it("renders the invoice form with INN, tariff and address", () => {
    const form = enabledDocuments
      .get("/stoimost/")
      ?.querySelector<HTMLFormElement>("form[data-lead-form]");
    expect(form?.dataset.intent).toBe("invoice");
    expect(form?.dataset.endpoint).toBe("/api/landing-leads");
    expect(
      [...(form?.querySelectorAll("input[name], select[name]") ?? [])].map((input) =>
        input.getAttribute("name"),
      ),
    ).toEqual(["inn", "tariffCode", "email", "website", "consent"]);
    const options = [
      ...(form?.querySelectorAll<HTMLOptionElement>('select[name="tariffCode"] option') ?? []),
    ];
    expect(options.map((option) => option.value)).toEqual(["start", "line", "workshop"]);
    expect(options.find((option) => option.selected)?.value).toBe("line");
    expect(form?.querySelector('input[name="inn"]')?.getAttribute("inputmode")).toBe("numeric");
  });

  // Every page with a lead form posts its own `location.pathname` as `sourcePath`;
  // the API accepts only the paths of LANDING_LEAD_SOURCE_PATHS (spec 15.3).
  it("renders lead forms only on pages whose path the lead API accepts", () => {
    const formRoutes = readdirSync(enabledOutputDirectory, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".html"))
      .map((entry) => path.join(entry.parentPath, entry.name))
      .flatMap((file) => {
        if (!readFileSync(file, "utf8").includes("data-lead-form")) return [];
        const relative = path.relative(enabledOutputDirectory, file).split(path.sep).join("/");
        return [relative === "index.html" ? "/" : `/${relative.replace(/index\.html$/, "")}`];
      });
    expect(formRoutes.sort()).toEqual(["/skachat/", "/stoimost/"]);
    expect(
      formRoutes.filter(
        (route) => !(LANDING_LEAD_SOURCE_PATHS as readonly string[]).includes(route),
      ),
    ).toEqual([]);
  });

  it("keeps the download result hidden until the form is accepted", () => {
    const page = documents.get("/skachat/") as Document;
    expect(page.querySelector("[data-download-start]")?.hasAttribute("hidden")).toBe(false);
    expect(page.querySelector("[data-download-ready]")?.hasAttribute("hidden")).toBe(true);
    for (const section of page.querySelectorAll("[data-download-after]")) {
      expect(section.hasAttribute("hidden")).toBe(true);
    }
    expect(page.querySelector("[data-pending-only]")?.textContent).toContain("Версия готовится");
    expect(page.querySelector("[data-release-link]")).not.toBeNull();
    expect(page.body.textContent).toContain("Get-FileHash");
  });

  it("loads only the hero screen eagerly and gives every image alt text", () => {
    for (const [route, client] of [
      ["/", "Михайловский перевал"],
      ["/en/", "Mikhaylovsky Pereval"],
    ] as const) {
      const images = [...(documents.get(route)?.querySelectorAll("main img") ?? [])];
      expect(images.length, route).toBeGreaterThan(10);
      const eager = images.filter((image) => image.getAttribute("loading") === "eager");
      expect(eager, route).toHaveLength(1);
      expect(eager[0]?.getAttribute("fetchpriority"), route).toBe("high");
      expect(Number(eager[0]?.getAttribute("width")), route).toBeGreaterThan(0);
      for (const image of images) expect(image.hasAttribute("alt"), route).toBe(true);
      const clients = documents.get(route)?.querySelector(".ax-clients")?.textContent ?? "";
      expect(clients, route).toContain("Rebel Apple");
      expect(clients, route).toContain(client);
    }
  });

  it("lists the new pages in the sitemap and llms.txt", () => {
    const sitemap = readFileSync(path.join(outputDirectory, "sitemap.xml"), "utf8");
    for (const route of AUTONOM_ROUTES) {
      expect(sitemap).toContain(`<loc>https://markiro.app${route}</loc>`);
    }
    const llms = readFileSync(path.join(outputDirectory, "llms.txt"), "utf8");
    expect(llms).toContain("https://markiro.app/skachat/");
    expect(llms).toContain(
      "«Старт» 60 000 ₽, «Линия» 120 000 ₽, «Цех» 240 000 ₽, «Завод» по запросу",
    );
  });
});
