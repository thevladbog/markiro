# Landing film «Как работает» Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `/kak-rabotaet/` and `/en/how-it-works/`: a page where scrolling moves a camera through a live Three.js scale model of a production site in seven chapters, from morning to night, with real HTML text, poster fallbacks and the landing's SEO, CSP and Lighthouse gates intact.

**Architecture:** The page is plain HTML: seven tall chapter sections with sticky cards and sticky poster images, so it reads without JavaScript. A small entry script turns the section layout into one number, film time (0 to 7), and on the first interaction imports a separate 3D chunk that renders the district for that film time. The light, the camera and every moving part are pure functions of film time, so scrolling back plays the film backwards and the pure parts are unit tested without WebGL.

**Tech Stack:** Astro 7 (static), TypeScript (strict), three 0.186.0 with its addons (EffectComposer, GTAO, bloom, tilt-shift), Vitest (node and jsdom), Playwright and Lighthouse in `tools/production-browser`.

**Spec:** `docs/superpowers/specs/2026-09-26-landing-film-design.md` (accepted 2026-09-26).

## Global Constraints

- `three` and `@types/three` at exactly `0.186.0` in `apps/landing`. three 0.186.0 was published on 2026-09-08 and @types/three 0.186.0 on 2026-09-11, both older than the seven-day release-age policy; 0.186.1 is too new. pnpm 11 does not read `save-exact` or `minimum-release-age` from `.npmrc`, so pass `--save-exact` and check the age of every new lockfile entry yourself. Install with pnpm only; never edit `pnpm-lock.yaml` by hand.
- No CDN or runtime network dependency: three and every asset are bundled; the landing CSP allows `script-src 'self'`.
- Copy comes verbatim from the spec tables (RU and EN). The demo button label is the shared `copy.common.requestDemoShort`. Film copy contains no em dash (U+2014) and no en dash (U+2013); a test enforces it.
- Green `#3DDC7A` only where a code has passed, on indicators and on the call to action: meshes named `code`, `scanner-lamp`, `scan-line`, `printer-led`, `handheld-screen`, `mast-lamp`, `kiosk-ok`, queue tiles while they sync, the box cells and progress bars drawn on the station and kiosk screen textures, the active rail marker and the call to action. Amber `#DD9420` only on the mast while offline. Red `#C0392B` only on rejected codes.
- Everything on screen is a function of film time. Nothing accumulates between frames.
- The 3D chunk loads only after the first scroll, wheel, pointer, touch or key event. `prefers-reduced-motion`, missing WebGL 2, a failed load, or a median frame time above 50 ms over the first 2 s of rendering keep the posters.
- Lighthouse on `/kak-rabotaet/`, mobile and desktop: performance ≥ 0.9, accessibility 1, SEO 1, best practices ≥ 0.95.
- TypeScript strict with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. In `src`: no `any`, no non-null assertions, no `as` type casts outside tests (`as const` is fine); `import type` for type-only imports. `astro check` typechecks tests too.
- Unit tests live next to their module in `src/**` (repo convention) and are linted with type-aware rules. Build-level page tests live in `apps/landing/test/`.
- In a fresh worktree build dependencies first: `pnpm turbo run build --filter='@markiro/landing^...'`.
- The code blocks in this plan are not Prettier-formatted. Before each commit run `pnpm exec prettier --write` on the files you touched.
- Each commit stages explicit paths (never `git add -A`: `.claude/launch.json` and `output/` hold unrelated local work) and ends with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- The home page changes only by one hero link (Task 13).

## File Structure

`packages/ui`
- `src/tokens.css`: `[data-theme="light"]` joins the `:root` rule, so a subtree of a dark page can opt back into light tokens.
- `test/tokens.test.ts`: test for that.

`apps/landing/src/content`
- `film.ts`: RU and EN page definitions and chapters; `FILM_SEARCH_PAGES`.
- `film.test.ts`
- `film-posters.ts`: static imports of the 14 poster JPEGs; `posterFor(id)`.

`apps/landing/src/lib`
- `seo.ts`: `INDEXABLE_PAGES` gains the film; new `buildFilmPageGraph`.
- `seo.test.ts`: film cases.

`apps/landing/src/scripts/film` (no static three import outside `world/`)
- `math.ts`: `clamp01`, `ramp`.
- `color.ts` + test: hex parsing, linear-light mixing, colour stops, luminance.
- `timeline.ts` + test: section layout to film time; chapter position; camera dwell.
- `lighting.ts` + test: film time to time of day to light, palette mix, background, contact shadow, UI theme.
- `camera-path.ts` + test: camera key type, orbit helper, Catmull-Rom pose evaluation.
- `camera-keys.ts`: the fifteen camera keys.
- `animations.ts` + test: belt, case, label, pallet, offline queue, kiosk and office state.
- `quality.ts` + test: quality tiers and the frame budget.
- `film.ts` + test: DOM glue and the browser runtime; imports the 3D chunk lazily.

`apps/landing/src/scripts/film/world` (three; loaded only through `runtime.ts`)
- `kit.ts`: palette roles, shared materials, signal materials, rounded-box helpers.
- `textures.ts`: texture factory (canvas or blank), label, station, kiosk and contact-shadow textures.
- `props.ts`: products, cases, pallet, rack, van, tree, lamp fixture.
- `figures.ts`: people in white coats with poses.
- `kit.test.ts`: kit, props, figures, textures.
- `plant.ts`: the main plant (line hall, packing, warehouse corner, mast, kiosk, office) and its animation handles.
- `district.ts`: base, roads, brewery, cosmetics workshop, trees, contact shadow, and the plant.
- `district.test.ts`
- `rig.ts`: lights driven by `LightingState`.
- `apply.ts`: writes `FilmAnimationState` into the scene.
- `apply.test.ts`: apply and rig.
- `stage.ts`: renderer, composer, passes, lens shift.
- `runtime.ts`: `startWorld`, the only export the entry script loads.

The spec's code layout puts `stage.ts` next to `film.ts` and buildings under `world/buildings/`. Here `stage.ts` lives in `world/` because it imports three, and the buildings are `world/plant.ts` and `world/district.ts` (`plant`, not `site`, because `src/scripts/site.ts` already exists).

`apps/landing/src/components`
- `FilmPage.astro`: the page.
- `FilmPoster.astro`: art-directed poster `<picture>` (tall on phones, wide elsewhere).
- `HomePage.astro`: the hero link to the film.

`apps/landing/src/pages/kak-rabotaet/index.astro`, `apps/landing/src/pages/en/how-it-works/index.astro`.
`apps/landing/src/styles/film.css`: film styles, loaded only by the film page.
`apps/landing/src/assets/film/*.jpg`: 14 posters (`<chapter>-wide.jpg` 1600×1000, `<chapter>-tall.jpg` 780×1688).
`apps/landing/test/rendered-page.test.ts`: page assertions.

`tools/production-browser`
- `scripts/render-film-posters.mjs`: renders the posters from the live page.
- `tests/landing-seo.spec.ts`, `tests/landing-caddy-csp.spec.ts`: browser checks.
- `scripts/lighthouse-landing.mjs`, `test/lighthouse-landing.test.mjs`: gate route.

---

### Task 1: Light tokens for a subtree

**Files:**
- Modify: `packages/ui/src/tokens.css:2`
- Test: `packages/ui/test/tokens.test.ts`

**Interfaces:**
- Produces: any element with `data-theme="light"` gets the light value of every token in the first `:root` rule, even inside `html[data-theme="dark"]`. Apps set `data-theme` only on `<html>`, so their behaviour does not change. Task 12 puts `data-theme="light"` on the film header wrapper, the film and the morning chapters.

- [ ] **Step 1: Write the failing test**

Append to `packages/ui/test/tokens.test.ts`:

```ts
describe("светлая тема на поддереве тёмной страницы", () => {
  /**
   * Лендинг работает в тёмной теме, а утренние главы фильма «Как работает»
   * светлые. Поддерево с data-theme="light" получает светлые токены без
   * второго набора значений в самом лендинге.
   */
  it("возвращает светлые значения элементу с data-theme=light", () => {
    document.documentElement.dataset.theme = "dark";
    const island = document.createElement("div");
    island.dataset.theme = "light";
    document.body.append(island);
    try {
      const page = getComputedStyle(document.documentElement);
      const light = getComputedStyle(island);
      expect(page.getPropertyValue("--surface-page").trim()).toBe("#131216");
      expect(light.getPropertyValue("--surface-page").trim()).toBe("#fafaf8");
      expect(light.getPropertyValue("--fg-1").trim()).toBe("#17161a");
      expect(light.getPropertyValue("--accent").trim()).toBe("#0faf56");
    } finally {
      island.remove();
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @markiro/ui exec vitest run test/tokens.test.ts`
Expected: FAIL in «возвращает светлые значения элементу с data-theme=light»: the island reports `""` or `#131216` instead of `#fafaf8`.

- [ ] **Step 3: Implement**

In `packages/ui/src/tokens.css` replace line 2 `:root {` with:

```css
:root,
[data-theme="light"] {
```

- [ ] **Step 4: Run the package gates**

Run:
```bash
pnpm --filter @markiro/ui test
pnpm --filter @markiro/ui typecheck
pnpm --filter @markiro/ui lint
pnpm --filter @markiro/ui build
```
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/tokens.css packages/ui/test/tokens.test.ts
git commit -m "feat(ui): let a subtree opt back into light tokens" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Film copy

**Files:**
- Create: `apps/landing/src/content/film.ts`
- Test: `apps/landing/src/content/film.test.ts`

**Interfaces:**
- Produces:
  - `type FilmTheme = "light" | "dark"`
  - `type FilmChapterId = "district" | "line" | "packing" | "warehouse" | "offline" | "kiosk" | "office"`
  - `interface FilmLink { label: string; href: string }`
  - `interface FilmChapter { id; railLabel; kicker; title; body; tags: readonly string[]; span: number; theme: FilmTheme; status?: string }` (`span` is the section height in viewport heights)
  - `type FilmPath = "/kak-rabotaet/" | "/en/how-it-works/"`
  - `interface FilmPageDefinition { path; alternatePath; locale; title; description; navigationLabel; socialImage; socialImageAlt; reviewedAt; railLabel; scrollHint; heroSecondary: FilmLink; finalSecondary: FilmLink; chapters }` (structurally a `PageMetadata` from `src/lib/seo.ts`)
  - `FILM_PAGES`, `findFilmPage(locale: Locale): FilmPageDefinition`, `FILM_SEARCH_PAGES: readonly SearchPageRecord[]`

- [ ] **Step 1: Write the failing test**

Create `apps/landing/src/content/film.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { FILM_PAGES, FILM_SEARCH_PAGES, findFilmPage } from "./film";

const DASHES = /[\u2013\u2014]/u;

function visibleStrings(locale: "ru" | "en"): string[] {
  const page = findFilmPage(locale);
  return [
    page.title,
    page.description,
    page.navigationLabel,
    page.socialImageAlt,
    page.railLabel,
    page.scrollHint,
    page.heroSecondary.label,
    page.finalSecondary.label,
    ...page.chapters.flatMap((chapter) => [
      chapter.railLabel,
      chapter.kicker,
      chapter.title,
      chapter.body,
      ...chapter.tags,
      ...(chapter.status === undefined ? [] : [chapter.status]),
    ]),
  ];
}

describe("film page copy", () => {
  it.each(["ru", "en"] as const)("tells seven chapters in %s", (locale) => {
    expect(findFilmPage(locale).chapters).toHaveLength(7);
  });

  it("keeps both locales in step", () => {
    const ru = findFilmPage("ru").chapters;
    const en = findFilmPage("en").chapters;
    expect(en.map((chapter) => chapter.id)).toEqual(ru.map((chapter) => chapter.id));
    expect(en.map((chapter) => chapter.span)).toEqual(ru.map((chapter) => chapter.span));
    expect(en.map((chapter) => chapter.theme)).toEqual(ru.map((chapter) => chapter.theme));
    expect(en.map((chapter) => chapter.tags.length)).toEqual(ru.map((chapter) => chapter.tags.length));
    expect(en.map((chapter) => chapter.status === undefined)).toEqual(
      ru.map((chapter) => chapter.status === undefined),
    );
  });

  it.each(["ru", "en"] as const)("writes the %s copy without dashes", (locale) => {
    for (const text of visibleStrings(locale)) expect(text, text).not.toMatch(DASHES);
  });

  it("numbers the kickers of chapters two to seven", () => {
    for (const page of FILM_PAGES) {
      page.chapters.slice(1).forEach((chapter, index) => {
        expect(chapter.kicker.startsWith(`0${index + 2} / `), chapter.kicker).toBe(true);
      });
    }
  });

  it("gives every chapter 130 to 160 % of the viewport in scroll", () => {
    const { chapters } = findFilmPage("ru");
    // Chapter 1 also holds the first screen, which is read before the camera moves.
    const scroll = chapters.map((chapter, index) => (index === 0 ? chapter.span - 1 : chapter.span));
    for (const length of scroll) {
      expect(length).toBeGreaterThanOrEqual(1.3);
      expect(length).toBeLessThanOrEqual(1.6);
    }
    expect(scroll[0]).toBeCloseTo(1.6);
    expect(scroll.at(-1)).toBeCloseTo(1.6);
  });

  it("starts in daylight and ends at night", () => {
    expect(findFilmPage("ru").chapters.map((chapter) => chapter.theme)).toEqual([
      "light",
      "light",
      "light",
      "light",
      "light",
      "dark",
      "dark",
    ]);
  });

  it("links the locales to each other and publishes both for search", () => {
    const ru = findFilmPage("ru");
    const en = findFilmPage("en");
    expect(ru.path).toBe("/kak-rabotaet/");
    expect(en.path).toBe("/en/how-it-works/");
    expect(ru.alternatePath).toBe(en.path);
    expect(en.alternatePath).toBe(ru.path);
    expect(FILM_SEARCH_PAGES).toEqual(
      FILM_PAGES.map((page) => ({
        path: page.path,
        alternatePath: page.alternatePath,
        locale: page.locale,
        navigationLabel: page.navigationLabel,
        description: page.description,
        lastModified: page.reviewedAt,
      })),
    );
  });

  it("keeps titles and descriptions within snippet limits", () => {
    for (const page of FILM_PAGES) {
      expect(page.title.length, page.title).toBeLessThanOrEqual(70);
      expect(page.description.length, page.description).toBeGreaterThanOrEqual(120);
      expect(page.description.length, page.description).toBeLessThanOrEqual(170);
    }
  });

  it("uses the reviewed Russian copy", () => {
    const [district, line] = findFilmPage("ru").chapters;
    expect(district?.title).toBe("Маркировка и агрегация. Линия идёт.");
    expect(line?.title).toBe("Каждый код проверяем до короба.");
    expect(line?.body).toBe(
      "Станция не пустит в короб повторный код, код чужого товара или код с ошибкой. Оператор видит причину на экране.",
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @markiro/landing exec vitest run src/content/film.test.ts`
Expected: FAIL, the module `./film` cannot be resolved.

- [ ] **Step 3: Implement**

Create `apps/landing/src/content/film.ts`:

```ts
import type { Locale, SearchPageRecord } from "./pages";

export type FilmTheme = "light" | "dark";

export type FilmChapterId =
  | "district"
  | "line"
  | "packing"
  | "warehouse"
  | "offline"
  | "kiosk"
  | "office";

export interface FilmLink {
  readonly label: string;
  readonly href: string;
}

export interface FilmChapter {
  readonly id: FilmChapterId;
  readonly railLabel: string;
  readonly kicker: string;
  readonly title: string;
  readonly body: string;
  readonly tags: readonly string[];
  /** Height of the chapter section, in viewport heights. */
  readonly span: number;
  readonly theme: FilmTheme;
  readonly status?: string;
}

export type FilmPath = "/kak-rabotaet/" | "/en/how-it-works/";

export interface FilmPageDefinition {
  readonly path: FilmPath;
  readonly alternatePath: FilmPath;
  readonly locale: Locale;
  readonly title: string;
  readonly description: string;
  readonly navigationLabel: string;
  readonly socialImage: string;
  readonly socialImageAlt: string;
  readonly reviewedAt: `${number}-${number}-${number}`;
  readonly railLabel: string;
  readonly scrollHint: string;
  /** The link next to the demo button in chapter 1. */
  readonly heroSecondary: FilmLink;
  /** The link next to the demo button after the last chapter. */
  readonly finalSecondary: FilmLink;
  readonly chapters: readonly FilmChapter[];
}

const REVIEWED = "2026-09-26" as const;
const SOCIAL_IMAGE = "/og-markiro.jpg";

const RU: FilmPageDefinition = {
  path: "/kak-rabotaet/",
  alternatePath: "/en/how-it-works/",
  locale: "ru",
  title: "Как работает Markiro: маркировка от линии до кабинета",
  description:
    "Семь сцен производства: проверка кодов на линии, короба и паллеты, работа без сети, киоск выбытия и кабинет. Для соков, косметики, пива и молочной продукции.",
  navigationLabel: "Как работает",
  socialImage: SOCIAL_IMAGE,
  socialImageAlt: "Markiro: маркировка, агрегация и прослеживаемость производства",
  reviewedAt: REVIEWED,
  railLabel: "Главы",
  scrollHint: "Листайте вниз: пройдём по производству от линии до офиса ↓",
  heroSecondary: { label: "Как это работает ↓", href: "#line" },
  finalSecondary: { label: "Как проходит внедрение →", href: "/#implementation" },
  chapters: [
    {
      id: "district",
      railLabel: "Район",
      kicker: "МАРКИРОВКА / АГРЕГАЦИЯ / ПРОСЛЕЖИВАЕМОСТЬ",
      title: "Маркировка и агрегация. Линия идёт.",
      body: "Проверяем коды, собираем короба и паллеты, печатаем этикетки для соков, косметики, пива и молочной продукции. Когда пропадает сеть, станция продолжает работать.",
      tags: ["Соки", "Косметика", "Пиво", "Молочная продукция"],
      span: 2.6,
      theme: "light",
    },
    {
      id: "line",
      railLabel: "Линия",
      kicker: "02 / ЛИНИЯ",
      title: "Каждый код проверяем до короба.",
      body: "Станция не пустит в короб повторный код, код чужого товара или код с ошибкой. Оператор видит причину на экране.",
      tags: ["Дубли", "Чужой GTIN", "Несколько терминалов"],
      span: 1.3,
      theme: "light",
    },
    {
      id: "packing",
      railLabel: "Упаковка",
      kicker: "03 / УПАКОВКА",
      title: "Код прошёл. Короб собран.",
      body: "Когда короб заполнен, станция печатает этикетку с SSCC. Номера идут по порядку из диапазона, который выдали заранее, а принтер получает ZPL или TSPL.",
      tags: ["SSCC", "ZPL / TSPL", "Паллеты"],
      span: 1.3,
      theme: "light",
    },
    {
      id: "warehouse",
      railLabel: "Склад",
      kicker: "04 / СКЛАД",
      title: "Паллеты собираем на ТСД.",
      body: "Кладовщик с терминалом на Android собирает паллеты, снимает с них коробы и проводит инвентаризацию у стеллажа.",
      tags: ["ТСД", "Инвентаризация", "Пересборка"],
      span: 1.35,
      theme: "light",
    },
    {
      id: "offline",
      railLabel: "Нет сети",
      kicker: "05 / НЕТ СЕТИ",
      title: "Сеть пропала. Линия идёт.",
      body: "Станция пишет операции в свой журнал и отправляет их на сервер, когда связь вернётся. Если записи с разных станций не сошлись, это видно в разделе «Конфликты».",
      tags: ["Офлайн-журнал", "Синхронизация", "Конфликты"],
      span: 1.45,
      theme: "light",
      status: "Нет связи с сервером · в очереди 128 операций",
    },
    {
      id: "kiosk",
      railLabel: "Киоск",
      kicker: "06 / КИОСК ВЫБЫТИЯ",
      title: "Выбытие оформляют на киоске.",
      body: "Часть продукции уходит с производства не через отгрузку: покупка сотрудником, образцы, бой. Сотрудник сканирует бейдж и коды, и заявка приходит в кабинет.",
      tags: ["Бейдж", "Лимиты", "Офлайн-очередь"],
      span: 1.35,
      theme: "dark",
    },
    {
      id: "office",
      railLabel: "Офис",
      kicker: "07 / ОФИС",
      title: "В кабинете видно каждую смену.",
      body: "Сюда приходят операции со станций, ТСД и киосков. Отсюда идёт обмен с 1С и выгрузка документов для Честного знака.",
      tags: ["1С", "Честный знак", "Отчёты"],
      span: 1.6,
      theme: "dark",
    },
  ],
};

const EN: FilmPageDefinition = {
  path: "/en/how-it-works/",
  alternatePath: "/kak-rabotaet/",
  locale: "en",
  title: "How Markiro works: serialization from the line to the admin panel",
  description:
    "Seven scenes from a plant: code checks on the line, cases and pallets, work without a network, disposal kiosk and admin panel. For juice, cosmetics, beer and dairy.",
  navigationLabel: "How it works",
  socialImage: SOCIAL_IMAGE,
  socialImageAlt: "Markiro: production serialization, aggregation and traceability",
  reviewedAt: REVIEWED,
  railLabel: "Chapters",
  scrollHint: "Scroll down: we go through production from the line to the office ↓",
  heroSecondary: { label: "How it works ↓", href: "#line" },
  finalSecondary: { label: "How implementation works →", href: "/en/#implementation" },
  chapters: [
    {
      id: "district",
      railLabel: "District",
      kicker: "SERIALIZATION / AGGREGATION / TRACEABILITY",
      title: "Serialization and aggregation. Keep the line moving.",
      body: "We verify codes, assemble cases and pallets, and print labels for juice, cosmetics, beer and dairy. When the network drops, the station keeps working.",
      tags: ["Juice", "Cosmetics", "Beer", "Dairy"],
      span: 2.6,
      theme: "light",
    },
    {
      id: "line",
      railLabel: "Line",
      kicker: "02 / LINE",
      title: "We check every code before it goes into a case.",
      body: "The station keeps repeated codes, codes of another product and malformed codes out of the case. The operator sees the reason on screen.",
      tags: ["Duplicates", "Foreign GTIN", "Multiple terminals"],
      span: 1.3,
      theme: "light",
    },
    {
      id: "packing",
      railLabel: "Packing",
      kicker: "03 / PACKING",
      title: "Code verified. Case complete.",
      body: "When a case is full, the station prints an SSCC label. Numbers come in order from a range issued in advance, and the printer receives ZPL or TSPL.",
      tags: ["SSCC", "ZPL / TSPL", "Pallets"],
      span: 1.3,
      theme: "light",
    },
    {
      id: "warehouse",
      railLabel: "Warehouse",
      kicker: "04 / WAREHOUSE",
      title: "Pallets are built on the handheld.",
      body: "A warehouse worker with an Android handheld builds pallets, removes cases from them and runs inventory at the rack.",
      tags: ["Handheld", "Inventory", "Repacking"],
      span: 1.35,
      theme: "light",
    },
    {
      id: "offline",
      railLabel: "No network",
      kicker: "05 / NO NETWORK",
      title: "The network is gone. The line keeps moving.",
      body: "The station writes operations to its own journal and sends them to the server when the connection returns. If records from different stations disagree, they show up under Conflicts.",
      tags: ["Offline journal", "Sync", "Conflicts"],
      span: 1.45,
      theme: "light",
      status: "No connection to the server · 128 operations queued",
    },
    {
      id: "kiosk",
      railLabel: "Kiosk",
      kicker: "06 / DISPOSAL KIOSK",
      title: "Disposal goes through the kiosk.",
      body: "Some products leave production other than by shipment: employee purchases, samples, breakage. The employee scans a badge and the codes, and the request arrives in the admin panel.",
      tags: ["Badge", "Limits", "Offline queue"],
      span: 1.35,
      theme: "dark",
    },
    {
      id: "office",
      railLabel: "Office",
      kicker: "07 / OFFICE",
      title: "Every shift is visible in the admin panel.",
      body: "Operations from stations, handhelds and kiosks arrive here. From here you exchange data with 1C and export documents for Chestny ZNAK.",
      tags: ["1C", "Chestny ZNAK", "Reports"],
      span: 1.6,
      theme: "dark",
    },
  ],
};

export const FILM_PAGES: readonly FilmPageDefinition[] = [RU, EN];

export function findFilmPage(locale: Locale): FilmPageDefinition {
  return locale === "ru" ? RU : EN;
}

export const FILM_SEARCH_PAGES: readonly SearchPageRecord[] = FILM_PAGES.map((page) => ({
  path: page.path,
  alternatePath: page.alternatePath,
  locale: page.locale,
  navigationLabel: page.navigationLabel,
  description: page.description,
  lastModified: page.reviewedAt,
}));
```

- [ ] **Step 4: Run the test, typecheck and lint**

Run:
```bash
pnpm --filter @markiro/landing exec vitest run src/content/film.test.ts
pnpm --filter @markiro/landing typecheck
pnpm --filter @markiro/landing lint
```
Expected: 10 tests pass; no errors. If a description length check fails, shorten the description, never the chapter copy.

- [ ] **Step 5: Commit**

```bash
git add apps/landing/src/content/film.ts apps/landing/src/content/film.test.ts
git commit -m "feat(landing): film page copy in Russian and English" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Colour mixing and the film timeline

**Files:**
- Create: `apps/landing/src/scripts/film/math.ts`, `color.ts`, `timeline.ts` (all in `apps/landing/src/scripts/film/`)
- Test: `apps/landing/src/scripts/film/color.test.ts`, `apps/landing/src/scripts/film/timeline.test.ts`

**Interfaces:**
- Produces:
  - `math.ts`: `clamp01(value: number): number`, `ramp(value: number, from: number, to: number): number`
  - `color.ts`: `type Rgb = readonly [number, number, number]`, `type ColourStop = readonly [position: number, colour: string]`, `parseHex(hex: string): Rgb`, `formatHex(rgb: Rgb): string` (lowercase `#rrggbb`), `toLinear(channel: number): number`, `toSrgb(channel: number): number`, `mixHex(from: string, to: string, amount: number): string`, `mixStops(stops: readonly ColourStop[], position: number): string`, `relativeLuminance(hex: string): number`
  - `timeline.ts`: `interface SectionBox { top: number; height: number }`, `interface ChapterPosition { index: number; local: number }`, `filmTimeFromLayout(sections: readonly SectionBox[], viewportHeight: number): number`, `chapterAt(filmTime: number, chapterCount: number): ChapterPosition`, `dwell(local: number, strength?: number): number`, `cameraTime(filmTime: number, chapterCount: number): number`

- [ ] **Step 1: Write the failing tests**

Create `apps/landing/src/scripts/film/color.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { formatHex, mixHex, mixStops, parseHex, relativeLuminance } from "./color";

describe("film colour helpers", () => {
  it("round-trips hex colours", () => {
    expect(formatHex(parseHex("#3DDC7A"))).toBe("#3ddc7a");
  });

  it("rejects anything that is not #rrggbb", () => {
    expect(() => parseHex("green")).toThrow("Expected a #rrggbb colour");
  });

  it("mixes in linear light", () => {
    expect(mixHex("#000000", "#ffffff", 0)).toBe("#000000");
    expect(mixHex("#000000", "#ffffff", 1)).toBe("#ffffff");
    expect(mixHex("#000000", "#ffffff", 0.5)).toBe("#bcbcbc");
    expect(mixHex("#000000", "#ffffff", 7)).toBe("#ffffff");
  });

  it("walks colour stops", () => {
    const stops = [
      [0, "#fafaf8"],
      [0.5, "#6b6461"],
      [1, "#131216"],
    ] as const;
    expect(mixStops(stops, -1)).toBe("#fafaf8");
    expect(mixStops(stops, 0.5)).toBe("#6b6461");
    expect(mixStops(stops, 2)).toBe("#131216");
  });

  it("measures relative luminance", () => {
    expect(relativeLuminance("#ffffff")).toBeCloseTo(1);
    expect(relativeLuminance("#000000")).toBeCloseTo(0);
  });
});
```

Create `apps/landing/src/scripts/film/timeline.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { cameraTime, chapterAt, dwell, filmTimeFromLayout } from "./timeline";

const VIEWPORT = 1000;
const SPANS = [2.6, 1.3, 1.3, 1.35, 1.45, 1.35, 1.6];
const STARTS = SPANS.map((_, index) =>
  SPANS.slice(0, index).reduce((sum, span) => sum + span * VIEWPORT, 0),
);
const TOTAL_SCROLL = SPANS.reduce((sum, span) => sum + span * VIEWPORT, 0) - VIEWPORT;

function layoutAt(scrollY: number) {
  return SPANS.map((span, index) => ({
    top: (STARTS[index] ?? 0) - scrollY,
    height: span * VIEWPORT,
  }));
}

const timeAt = (scrollY: number) => filmTimeFromLayout(layoutAt(scrollY), VIEWPORT);

describe("film timeline", () => {
  it("starts at zero at the top of the page", () => {
    expect(timeAt(0)).toBe(0);
  });

  it("runs the first chapter until the second enters from the bottom", () => {
    expect(timeAt(800)).toBeCloseTo(0.5);
    expect(timeAt(1600)).toBeCloseTo(1);
  });

  it("starts every later chapter exactly when its section enters at the bottom", () => {
    for (let chapter = 1; chapter < SPANS.length; chapter += 1) {
      expect(timeAt((STARTS[chapter] ?? 0) - VIEWPORT)).toBeCloseTo(chapter);
    }
    expect(timeAt(2600 - VIEWPORT + 650)).toBeCloseTo(1.5);
  });

  it("clamps above and below the film", () => {
    expect(timeAt(-400)).toBe(0);
    expect(timeAt(TOTAL_SCROLL)).toBeCloseTo(7);
    expect(timeAt(TOTAL_SCROLL + 5000)).toBe(7);
  });

  it("moves forward while scrolling down and backward while scrolling up", () => {
    let previous = 0;
    for (let scrollY = 0; scrollY <= TOTAL_SCROLL; scrollY += 37) {
      expect(timeAt(scrollY)).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = timeAt(scrollY);
    }
    previous = 7;
    for (let scrollY = TOTAL_SCROLL; scrollY >= 0; scrollY -= 41) {
      expect(timeAt(scrollY)).toBeLessThanOrEqual(previous + 1e-9);
      previous = timeAt(scrollY);
    }
  });

  it("splits film time into chapter and local progress", () => {
    expect(chapterAt(3.25, 7)).toEqual({ index: 3, local: 0.25 });
    expect(chapterAt(7, 7)).toEqual({ index: 6, local: 1 });
    expect(chapterAt(-1, 7)).toEqual({ index: 0, local: 0 });
  });

  it("slows the camera mid-chapter and keeps the joins smooth", () => {
    expect(dwell(0)).toBe(0);
    expect(dwell(1)).toBeCloseTo(1);
    expect(dwell(0.5)).toBeCloseTo(0.5);
    const slope = (x: number) => (dwell(x + 1e-4) - dwell(x - 1e-4)) / 2e-4;
    expect(slope(0.5)).toBeLessThan(slope(0.05));
    let previous = 0;
    for (let x = 0; x <= 1; x += 0.01) {
      expect(dwell(x)).toBeGreaterThanOrEqual(previous);
      previous = dwell(x);
    }
    expect(cameraTime(2 - 1e-9, 7)).toBeCloseTo(cameraTime(2 + 1e-9, 7), 6);
    expect(cameraTime(7, 7)).toBeCloseTo(7);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @markiro/landing exec vitest run src/scripts/film/color.test.ts src/scripts/film/timeline.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

Create `apps/landing/src/scripts/film/math.ts`:

```ts
export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** 0 before `from`, 1 after `to`, linear in between. */
export function ramp(value: number, from: number, to: number): number {
  return clamp01((value - from) / (to - from));
}
```

Create `apps/landing/src/scripts/film/color.ts`:

```ts
import { clamp01 } from "./math";

export type Rgb = readonly [number, number, number];
export type ColourStop = readonly [position: number, colour: string];

const HEX = /^#([0-9a-f]{6})$/iu;

export function parseHex(hex: string): Rgb {
  const digits = HEX.exec(hex)?.[1];
  if (digits === undefined) throw new Error(`Expected a #rrggbb colour, got ${hex}`);
  const value = Number.parseInt(digits, 16);
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

export function formatHex(rgb: Rgb): string {
  const channel = (value: number): string =>
    Math.round(clamp01(value) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${channel(rgb[0])}${channel(rgb[1])}${channel(rgb[2])}`;
}

export function toLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

export function toSrgb(channel: number): number {
  return channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055;
}

/** Mixes two sRGB colours in linear light, the way the renderer blends them. */
export function mixHex(from: string, to: string, amount: number): string {
  const t = clamp01(amount);
  const a = parseHex(from);
  const b = parseHex(to);
  const mix = (x: number, y: number): number =>
    toSrgb(toLinear(x) + (toLinear(y) - toLinear(x)) * t);
  return formatHex([mix(a[0], b[0]), mix(a[1], b[1]), mix(a[2], b[2])]);
}

export function mixStops(stops: readonly ColourStop[], position: number): string {
  const first = stops[0];
  const last = stops.at(-1);
  if (first === undefined || last === undefined) throw new Error("mixStops needs a stop");
  if (position <= first[0]) return first[1];
  for (let index = 1; index < stops.length; index += 1) {
    const previous = stops[index - 1];
    const next = stops[index];
    if (previous === undefined || next === undefined) continue;
    if (position <= next[0]) {
      return mixHex(previous[1], next[1], (position - previous[0]) / (next[0] - previous[0]));
    }
  }
  return last[1];
}

export function relativeLuminance(hex: string): number {
  const [red, green, blue] = parseHex(hex);
  return 0.2126 * toLinear(red) + 0.7152 * toLinear(green) + 0.0722 * toLinear(blue);
}
```

Create `apps/landing/src/scripts/film/timeline.ts`:

```ts
import { clamp01 } from "./math";

export interface SectionBox {
  readonly top: number;
  readonly height: number;
}

export interface ChapterPosition {
  readonly index: number;
  readonly local: number;
}

/**
 * Film time runs from 0 to the number of chapters. Chapter 1 starts at the top
 * of the page and ends when chapter 2 enters at the bottom of the viewport.
 * Every later chapter runs from its section entering at the bottom to its
 * section leaving at the bottom, which is while its sticky card is on screen.
 */
export function filmTimeFromLayout(sections: readonly SectionBox[], viewportHeight: number): number {
  for (let index = sections.length - 1; index >= 0; index -= 1) {
    const box = sections[index];
    if (box === undefined) continue;
    const start = index === 0 ? 0 : viewportHeight;
    if (box.top > start) continue;
    const span = index === 0 ? box.height - viewportHeight : box.height;
    return index + (span <= 0 ? 1 : clamp01((start - box.top) / span));
  }
  return 0;
}

export function chapterAt(filmTime: number, chapterCount: number): ChapterPosition {
  const clamped = Math.min(chapterCount, Math.max(0, filmTime));
  const index = Math.min(chapterCount - 1, Math.floor(clamped));
  return { index, local: clamped - index };
}

/** Slows the camera mid-chapter; f(0)=0, f(1)=1 and equal slopes at both ends. */
export function dwell(local: number, strength = 0.45): number {
  const x = clamp01(local);
  return x + (strength / (2 * Math.PI)) * Math.sin(2 * Math.PI * x);
}

export function cameraTime(filmTime: number, chapterCount: number): number {
  const { index, local } = chapterAt(filmTime, chapterCount);
  return index + dwell(local);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @markiro/landing exec vitest run src/scripts/film/color.test.ts src/scripts/film/timeline.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/landing/src/scripts/film/math.ts apps/landing/src/scripts/film/color.ts apps/landing/src/scripts/film/timeline.ts apps/landing/src/scripts/film/color.test.ts apps/landing/src/scripts/film/timeline.test.ts
git commit -m "feat(landing): film timeline and linear-light colour mixing" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Time of day and lighting

**Files:**
- Create: `apps/landing/src/scripts/film/lighting.ts`
- Test: `apps/landing/src/scripts/film/lighting.test.ts`

**Interfaces:**
- Consumes: `mixHex`, `mixStops`, `type ColourStop` (Task 3), `clamp01`, `ramp`.
- Produces: `CHAPTER_TIME_OF_DAY`, `interface LightingState` (fields in code), `timeOfDayAt(filmTime: number): number`, `lightingAt(timeOfDay: number): LightingState`.

- [ ] **Step 1: Write the failing test**

Create `apps/landing/src/scripts/film/lighting.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { relativeLuminance } from "./color";
import { CHAPTER_TIME_OF_DAY, lightingAt, timeOfDayAt } from "./lighting";

describe("film lighting", () => {
  it("holds each chapter's time of day at its middle", () => {
    CHAPTER_TIME_OF_DAY.forEach((value, index) => {
      expect(timeOfDayAt(index + 0.5)).toBeCloseTo(value);
    });
    expect(timeOfDayAt(0)).toBeCloseTo(0.05);
    expect(timeOfDayAt(7)).toBeCloseTo(1);
  });

  it("only moves forward through the day", () => {
    let previous = 0;
    for (let time = 0; time <= 7; time += 0.05) {
      expect(timeOfDayAt(time)).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = timeOfDayAt(time);
    }
  });

  it("starts on the light page and ends on the dark one", () => {
    const morning = lightingAt(0);
    const night = lightingAt(1);
    expect(morning.background).toBe("#fafaf8");
    expect(night.background).toBe("#131216");
    expect(morning.uiTheme).toBe("light");
    expect(night.uiTheme).toBe("dark");
    expect(morning.lamps).toBe(0);
    expect(night.lamps).toBe(1);
    expect(morning.bloom).toBe(0);
    expect(night.glow).toBe(1);
    expect(morning.materialNight).toBe(0);
    expect(night.materialNight).toBeCloseTo(0.6);
    expect(morning.contactShadow).toBeCloseTo(0.24);
    expect(night.contactShadow).toBeCloseTo(0.55);
  });

  it("passes through every background stop", () => {
    expect(lightingAt(0.42).background).toBe("#f1eae1");
    expect(lightingAt(0.62).background).toBe("#6b6461");
    expect(lightingAt(0.82).background).toBe("#1e1c21");
  });

  it("darkens the background steadily, within 8-bit rounding", () => {
    let previous = Number.POSITIVE_INFINITY;
    for (let tod = 0; tod <= 1; tod += 0.02) {
      const luminance = relativeLuminance(lightingAt(tod).background);
      expect(luminance).toBeLessThanOrEqual(previous + 0.005);
      previous = luminance;
    }
  });

  it("switches the chrome to dark between chapters five and six", () => {
    expect(lightingAt(timeOfDayAt(4.5)).uiTheme).toBe("light");
    expect(lightingAt(timeOfDayAt(5.5)).uiTheme).toBe("dark");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @markiro/landing exec vitest run src/scripts/film/lighting.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

Create `apps/landing/src/scripts/film/lighting.ts`:

```ts
import { mixHex, mixStops, type ColourStop } from "./color";
import { clamp01, ramp } from "./math";

/** Time of day in the middle of each chapter: morning, sunset, night. */
export const CHAPTER_TIME_OF_DAY = [0.05, 0.15, 0.25, 0.42, 0.52, 0.72, 1] as const;

export interface LightingState {
  readonly timeOfDay: number;
  readonly background: string;
  /** How far materials move towards the night palette. */
  readonly materialNight: number;
  readonly skyColor: string;
  readonly groundColor: string;
  readonly skyIntensity: number;
  readonly sunColor: string;
  readonly sunIntensity: number;
  readonly sunPosition: readonly [number, number, number];
  readonly fillIntensity: number;
  readonly lamps: number;
  readonly glow: number;
  readonly bloom: number;
  readonly ambientOcclusion: number;
  readonly contactShadow: number;
  readonly uiTheme: "light" | "dark";
}

const BACKGROUND: readonly ColourStop[] = [
  [0, "#fafaf8"],
  [0.42, "#f1eae1"],
  [0.62, "#6b6461"],
  [0.82, "#1e1c21"],
  [1, "#131216"],
];

export function timeOfDayAt(filmTime: number): number {
  const first = CHAPTER_TIME_OF_DAY[0];
  const last = CHAPTER_TIME_OF_DAY[CHAPTER_TIME_OF_DAY.length - 1] ?? 1;
  if (filmTime <= 0.5) return first;
  if (filmTime >= CHAPTER_TIME_OF_DAY.length - 0.5) return last;
  const position = filmTime - 0.5;
  const index = Math.floor(position);
  const from = CHAPTER_TIME_OF_DAY[index] ?? last;
  const to = CHAPTER_TIME_OF_DAY[index + 1] ?? last;
  const k = position - index;
  return from + (to - from) * k * k * (3 - 2 * k);
}

function blend(tod: number, day: number, sunset: number, night: number): number {
  return tod < 0.5 ? day + (sunset - day) * tod * 2 : sunset + (night - sunset) * (tod - 0.5) * 2;
}

function blendColour(tod: number, day: string, sunset: string, night: string): string {
  return tod < 0.5 ? mixHex(day, sunset, tod * 2) : mixHex(sunset, night, (tod - 0.5) * 2);
}

export function lightingAt(timeOfDay: number): LightingState {
  const tod = clamp01(timeOfDay);
  return {
    timeOfDay: tod,
    background: mixStops(BACKGROUND, tod),
    materialNight: ramp(tod, 0.5, 1) * 0.6,
    skyColor: blendColour(tod, "#ffffff", "#f1ddcb", "#7d879f"),
    groundColor: blendColour(tod, "#cfcac0", "#8c8178", "#131216"),
    skyIntensity: blend(tod, 1.1, 0.9, 0.62),
    sunColor: blendColour(tod, "#ffffff", "#ffc49a", "#b4c2ff"),
    sunIntensity: blend(tod, 2.7, 2.2, 0.8),
    sunPosition: [blend(tod, -11, -16, 9), blend(tod, 12, 5.5, 15), blend(tod, 7, 3, -11)],
    fillIntensity: blend(tod, 0.3, 0.12, 0),
    lamps: ramp(tod, 0.35, 0.8),
    glow: ramp(tod, 0.4, 0.9),
    bloom: 0.7 * ramp(tod, 0.35, 0.9),
    ambientOcclusion: blend(tod, 1.15, 1.05, 0.9),
    contactShadow: 0.24 + 0.31 * ramp(tod, 0.3, 0.9),
    uiTheme: tod >= 0.6 ? "dark" : "light",
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @markiro/landing exec vitest run src/scripts/film/lighting.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/landing/src/scripts/film/lighting.ts apps/landing/src/scripts/film/lighting.test.ts
git commit -m "feat(landing): film time of day drives light and page colour" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Camera path

**Files:**
- Create: `apps/landing/src/scripts/film/camera-path.ts`, `apps/landing/src/scripts/film/camera-keys.ts`
- Test: `apps/landing/src/scripts/film/camera-path.test.ts`

**Interfaces:**
- Consumes: `cameraTime` (Task 3).
- Produces:
  - `type Vec2 = readonly [number, number]`, `type Vec3 = readonly [number, number, number]`
  - `interface CameraPose { position: Vec3; target: Vec3; fov: number; shiftWide: Vec2; shiftTall: Vec2 }` (lens shift in NDC: where the look-at target lands on screen; `shiftWide` for landscape viewports, `shiftTall` for portrait)
  - `interface CameraKey extends CameraPose { at: number }`
  - `catmullRom(p0, p1, p2, p3, s): number`, `orbitKey(at, target, azimuthDeg, elevationDeg, distance, fov, shiftWide, shiftTall): CameraKey`, `poseAt(keys: readonly CameraKey[], time: number): CameraPose`
  - `CAMERA_KEYS: readonly CameraKey[]` (fifteen keys at 0, 0.5, …, 7)

- [ ] **Step 1: Write the failing test**

Create `apps/landing/src/scripts/film/camera-path.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { CAMERA_KEYS } from "./camera-keys";
import { orbitKey, poseAt, type CameraKey } from "./camera-path";
import { cameraTime } from "./timeline";

const keys: CameraKey[] = [
  orbitKey(0, [0, 0, 0], 0, 30, 10, 20, [0.2, 0], [0, 0.2]),
  orbitKey(0.5, [1, 0, 0], 20, 20, 6, 30, [0.1, 0], [0, 0.1]),
  orbitKey(1, [2, 0, 1], 40, 10, 4, 40, [0, 0], [0, 0]),
];

const distance = (a: readonly number[], b: readonly number[]) =>
  Math.hypot(...a.map((value, index) => value - (b[index] ?? 0)));

describe("film camera path", () => {
  it("places an orbit key at the requested distance", () => {
    const key = orbitKey(0, [1, 2, 3], -38, 34, 12, 20, [0, 0], [0, 0]);
    expect(distance(key.position, key.target)).toBeCloseTo(12);
  });

  it("passes exactly through every key", () => {
    for (const key of keys) {
      const pose = poseAt(keys, key.at);
      expect(pose.position[0]).toBeCloseTo(key.position[0]);
      expect(pose.target[2]).toBeCloseTo(key.target[2]);
      expect(pose.fov).toBeCloseTo(key.fov);
    }
  });

  it("stays continuous across keys", () => {
    const before = poseAt(keys, 0.5 - 1e-6);
    const after = poseAt(keys, 0.5 + 1e-6);
    expect(distance(before.position, after.position)).toBeLessThan(1e-3);
  });

  it("interpolates field of view and lens shift linearly", () => {
    const middle = poseAt(keys, 0.25);
    expect(middle.fov).toBeCloseTo(25);
    expect(middle.shiftWide[0]).toBeCloseTo(0.15);
  });

  it("clamps outside the path", () => {
    expect(poseAt(keys, -1).fov).toBe(20);
    expect(poseAt(keys, 9).fov).toBe(40);
  });

  it("gives the film two keys per chapter and a final pull-out", () => {
    expect(CAMERA_KEYS).toHaveLength(15);
    CAMERA_KEYS.forEach((key, index) => {
      expect(key.at).toBeCloseTo(index * 0.5);
      expect(key.fov).toBeGreaterThanOrEqual(15);
      expect(key.fov).toBeLessThanOrEqual(45);
      expect(key.position[1]).toBeGreaterThan(key.target[1]);
    });
  });

  it("does not jump at chapter joins", () => {
    for (let chapter = 1; chapter < 7; chapter += 1) {
      const before = poseAt(CAMERA_KEYS, cameraTime(chapter - 1e-7, 7));
      const after = poseAt(CAMERA_KEYS, cameraTime(chapter + 1e-7, 7));
      expect(distance(before.position, after.position), `chapter ${chapter}`).toBeLessThan(1e-3);
      expect(distance(before.target, after.target), `chapter ${chapter}`).toBeLessThan(1e-3);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @markiro/landing exec vitest run src/scripts/film/camera-path.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

Create `apps/landing/src/scripts/film/camera-path.ts`:

```ts
export type Vec2 = readonly [number, number];
export type Vec3 = readonly [number, number, number];

export interface CameraPose {
  readonly position: Vec3;
  readonly target: Vec3;
  readonly fov: number;
  /** Where the target lands on a landscape screen, in normalised device units. */
  readonly shiftWide: Vec2;
  /** Where the target lands on a portrait screen, in normalised device units. */
  readonly shiftTall: Vec2;
}

export interface CameraKey extends CameraPose {
  readonly at: number;
}

export function catmullRom(p0: number, p1: number, p2: number, p3: number, s: number): number {
  const s2 = s * s;
  const s3 = s2 * s;
  return (
    0.5 *
    (2 * p1 +
      (p2 - p0) * s +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * s2 +
      (3 * p1 - p0 - 3 * p2 + p3) * s3)
  );
}

export function orbitKey(
  at: number,
  target: Vec3,
  azimuthDeg: number,
  elevationDeg: number,
  distance: number,
  fov: number,
  shiftWide: Vec2,
  shiftTall: Vec2,
): CameraKey {
  const azimuth = (azimuthDeg * Math.PI) / 180;
  const elevation = (elevationDeg * Math.PI) / 180;
  return {
    at,
    target,
    fov,
    shiftWide,
    shiftTall,
    position: [
      target[0] + distance * Math.cos(elevation) * Math.sin(azimuth),
      target[1] + distance * Math.sin(elevation),
      target[2] + distance * Math.cos(elevation) * Math.cos(azimuth),
    ],
  };
}

export function poseAt(keys: readonly CameraKey[], time: number): CameraPose {
  const first = keys[0];
  const last = keys.at(-1);
  if (first === undefined || last === undefined) throw new Error("camera path needs a key");
  if (time <= first.at) return first;
  if (time >= last.at) return last;
  let segment = 0;
  while (segment < keys.length - 2 && (keys[segment + 1]?.at ?? Number.POSITIVE_INFINITY) < time) {
    segment += 1;
  }
  const k0 = keys[Math.max(0, segment - 1)] ?? first;
  const k1 = keys[segment] ?? first;
  const k2 = keys[segment + 1] ?? last;
  const k3 = keys[Math.min(keys.length - 1, segment + 2)] ?? last;
  const s = (time - k1.at) / (k2.at - k1.at);
  const curve = (a: Vec3, b: Vec3, c: Vec3, d: Vec3): Vec3 => [
    catmullRom(a[0], b[0], c[0], d[0], s),
    catmullRom(a[1], b[1], c[1], d[1], s),
    catmullRom(a[2], b[2], c[2], d[2], s),
  ];
  const lerp = (a: number, b: number): number => a + (b - a) * s;
  const lerp2 = (a: Vec2, b: Vec2): Vec2 => [lerp(a[0], b[0]), lerp(a[1], b[1])];
  return {
    position: curve(k0.position, k1.position, k2.position, k3.position),
    target: curve(k0.target, k1.target, k2.target, k3.target),
    fov: lerp(k1.fov, k2.fov),
    shiftWide: lerp2(k1.shiftWide, k2.shiftWide),
    shiftTall: lerp2(k1.shiftTall, k2.shiftTall),
  };
}
```

Create `apps/landing/src/scripts/film/camera-keys.ts`:

```ts
import { orbitKey, type CameraKey, type Vec2, type Vec3 } from "./camera-path";

// On landscape screens the subject sits right of the chapter card; on
// portrait screens it sits above the bottom sheet.
const OVERVIEW_WIDE: Vec2 = [0.28, 0];
const OVERVIEW_TALL: Vec2 = [0, 0.3];
const CLOSE_WIDE: Vec2 = [0.12, 0];
const CLOSE_TALL: Vec2 = [0, 0.22];
const PLANT_WIDE: Vec2 = [0.2, 0];
const PLANT_TALL: Vec2 = [0, 0.26];
const DISTRICT: Vec3 = [0, 0.5, -1];

/** Two keys per chapter (arrival and the middle), then the final pull-out. */
export const CAMERA_KEYS: readonly CameraKey[] = [
  orbitKey(0, DISTRICT, -38, 34, 88, 20, OVERVIEW_WIDE, OVERVIEW_TALL),
  orbitKey(0.5, DISTRICT, -35, 32, 76, 20, OVERVIEW_WIDE, OVERVIEW_TALL),
  orbitKey(1, [-1.5, 0.8, -1.1], -32, 38, 16, 30, CLOSE_WIDE, CLOSE_TALL),
  orbitKey(1.5, [-0.6, 0.9, -1.1], -30, 20, 4.6, 40, CLOSE_WIDE, CLOSE_TALL),
  orbitKey(2, [0.6, 0.95, -1.05], -26, 18, 4.2, 40, CLOSE_WIDE, CLOSE_TALL),
  orbitKey(2.5, [1.6, 0.98, -1.0], -18, 17, 3.5, 34, CLOSE_WIDE, CLOSE_TALL),
  orbitKey(3, [2.6, 0.9, 0.8], -45, 30, 7.5, 34, CLOSE_WIDE, CLOSE_TALL),
  orbitKey(3.5, [2.75, 0.95, 1.05], -58, 19, 4.4, 38, CLOSE_WIDE, CLOSE_TALL),
  orbitKey(4, [0.5, 0.8, -0.5], -42, 40, 34, 22, PLANT_WIDE, PLANT_TALL),
  orbitKey(4.5, [0.8, 1.0, -0.8], -36, 30, 26, 22, PLANT_WIDE, PLANT_TALL),
  orbitKey(5, [-4.6, 1.0, 3.2], -20, 28, 9, 34, CLOSE_WIDE, CLOSE_TALL),
  orbitKey(5.5, [-4.65, 1.05, 3.2], -18, 16, 4.2, 36, CLOSE_WIDE, CLOSE_TALL),
  orbitKey(6, [6.0, 1.3, -2.5], -24, 26, 13, 30, CLOSE_WIDE, CLOSE_TALL),
  orbitKey(6.5, [6.0, 1.25, -2.5], -24, 20, 9.5, 30, CLOSE_WIDE, CLOSE_TALL),
  orbitKey(7, DISTRICT, -40, 36, 80, 20, PLANT_WIDE, OVERVIEW_TALL),
];
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @markiro/landing exec vitest run src/scripts/film/camera-path.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/landing/src/scripts/film/camera-path.ts apps/landing/src/scripts/film/camera-keys.ts apps/landing/src/scripts/film/camera-path.test.ts
git commit -m "feat(landing): film camera keys and Catmull-Rom path" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Moving parts as functions of film time

**Files:**
- Create: `apps/landing/src/scripts/film/animations.ts`
- Test: `apps/landing/src/scripts/film/animations.test.ts`

**Interfaces:**
- Consumes: `clamp01`, `ramp` (Task 3).
- Produces: `type ProductKind = "bottle" | "jar" | "can"`, `PRODUCT_KINDS`, `interface BeltItemState { x; visible; kind; code: "idle" | "verified" | "rejected"; aside }`, `interface FilmAnimationState { belt; caseFill; labelOut; palletCases; queueCount; queueFlush; networkOnline; kioskStep; officeLights }`, `BELT` (`start`, `end`, `archX`, `spacing`, `count`, `rejectEvery`, `travelPerUnit`), `CASE_CAPACITY = 6`, `PALLET_CAPACITY = 8`, `QUEUE_TILES = 12`, `beltAt(filmTime): BeltItemState[]`, `animationAt(filmTime): FilmAnimationState`.

- [ ] **Step 1: Write the failing test**

Create `apps/landing/src/scripts/film/animations.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  animationAt,
  BELT,
  beltAt,
  CASE_CAPACITY,
  PALLET_CAPACITY,
  QUEUE_TILES,
} from "./animations";

const sweep = (from: number, to: number, step = 0.01) => {
  const times: number[] = [];
  for (let time = from; time <= to + 1e-9; time += step) times.push(time);
  return times;
};

describe("film animation state", () => {
  it("keeps every belt item on the belt and verifies it past the arch", () => {
    for (const time of sweep(0, 7, 0.1)) {
      for (const item of beltAt(time)) {
        expect(item.x).toBeGreaterThanOrEqual(BELT.start - 1e-9);
        expect(item.x).toBeLessThan(BELT.start + BELT.count * BELT.spacing);
        if (item.x <= BELT.archX) expect(item.code).toBe("idle");
        else expect(item.code).not.toBe("idle");
        if (item.aside > 0) expect(item.code).toBe("rejected");
      }
    }
  });

  it("changes the product on the belt from lap to lap", () => {
    const kinds = new Set(sweep(1, 2.2, 0.05).flatMap((time) => beltAt(time).map((item) => item.kind)));
    expect(kinds).toEqual(new Set(["bottle", "jar", "can"]));
  });

  it("rejects some items and pushes them aside", () => {
    const rejected = sweep(1, 2.2, 0.05).flatMap((time) =>
      beltAt(time).filter((item) => item.code === "rejected"),
    );
    expect(rejected.length).toBeGreaterThan(0);
    expect(rejected.some((item) => item.aside > 0.5)).toBe(true);
  });

  it("fills the case, prints the label and grows the pallet in order", () => {
    let fill = 0;
    let pallet = 0;
    for (const time of sweep(1.8, 4)) {
      const state = animationAt(time);
      expect(state.caseFill).toBeGreaterThanOrEqual(fill);
      expect(state.palletCases).toBeGreaterThanOrEqual(pallet);
      expect(state.labelOut).toBeGreaterThanOrEqual(0);
      expect(state.labelOut).toBeLessThanOrEqual(1);
      fill = state.caseFill;
      pallet = state.palletCases;
    }
    expect(fill).toBe(CASE_CAPACITY);
    expect(pallet).toBe(PALLET_CAPACITY);
    expect(animationAt(2.9).labelOut).toBe(1);
  });

  it("goes offline in chapter five, queues operations and flushes them", () => {
    expect(animationAt(3.9).networkOnline).toBe(true);
    expect(animationAt(4.3).networkOnline).toBe(false);
    expect(animationAt(4.65).queueCount).toBe(QUEUE_TILES);
    expect(animationAt(4.65).queueFlush).toBe(0);
    expect(animationAt(4.8).networkOnline).toBe(true);
    expect(animationAt(5).queueFlush).toBe(1);
    expect(animationAt(3).queueCount).toBe(0);
  });

  it("walks the kiosk through its steps and lights the office", () => {
    expect(animationAt(5.1).kioskStep).toBe(0);
    expect(animationAt(5.9).kioskStep).toBe(3);
    expect(animationAt(5.9).officeLights).toBe(0);
    expect(animationAt(6.5).officeLights).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @markiro/landing exec vitest run src/scripts/film/animations.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

Create `apps/landing/src/scripts/film/animations.ts`:

```ts
import { clamp01, ramp } from "./math";

export type ProductKind = "bottle" | "jar" | "can";

export const PRODUCT_KINDS: readonly ProductKind[] = ["bottle", "jar", "can"];

export interface BeltItemState {
  readonly x: number;
  readonly visible: boolean;
  readonly kind: ProductKind;
  readonly code: "idle" | "verified" | "rejected";
  /** 0 on the belt, 1 pushed off into the reject bin. */
  readonly aside: number;
}

export interface FilmAnimationState {
  readonly belt: readonly BeltItemState[];
  readonly caseFill: number;
  readonly labelOut: number;
  readonly palletCases: number;
  readonly queueCount: number;
  readonly queueFlush: number;
  readonly networkOnline: boolean;
  readonly kioskStep: number;
  readonly officeLights: number;
}

export const BELT = {
  start: -5.0,
  end: 0.45,
  archX: -2.1,
  spacing: 0.42,
  count: 13,
  rejectEvery: 6,
  travelPerUnit: 2.4,
} as const;

export const CASE_CAPACITY = 6;
export const PALLET_CAPACITY = 8;
export const QUEUE_TILES = 12;

export function beltAt(filmTime: number): BeltItemState[] {
  const span = BELT.count * BELT.spacing;
  const phase = Math.max(0, filmTime) * BELT.travelPerUnit;
  const items: BeltItemState[] = [];
  for (let index = 0; index < BELT.count; index += 1) {
    const travelled = index * BELT.spacing + phase;
    const lap = Math.floor(travelled / span);
    const x = BELT.start + (travelled - lap * span);
    const serial = index + lap;
    const kind = PRODUCT_KINDS[serial % PRODUCT_KINDS.length] ?? "bottle";
    const rejected = serial % BELT.rejectEvery === 0;
    const passed = x > BELT.archX;
    items.push({
      x,
      visible: x < BELT.end,
      kind,
      code: passed ? (rejected ? "rejected" : "verified") : "idle",
      aside: rejected && passed ? clamp01((x - BELT.archX) / 0.9) : 0,
    });
  }
  return items;
}

function steps(value: number, count: number): number {
  return Math.min(count, Math.floor(value * count + 1e-9));
}

export function animationAt(filmTime: number): FilmAnimationState {
  const offline = filmTime >= 4.1 && filmTime < 4.7;
  return {
    belt: beltAt(filmTime),
    caseFill: steps(ramp(filmTime, 2.05, 2.55), CASE_CAPACITY),
    labelOut: ramp(filmTime, 2.55, 2.8),
    palletCases: 4 + steps(ramp(filmTime, 3.1, 3.7), PALLET_CAPACITY - 4),
    queueCount: filmTime < 4.1 ? 0 : Math.ceil(ramp(filmTime, 4.1, 4.6) * QUEUE_TILES - 1e-9),
    queueFlush: ramp(filmTime, 4.7, 4.95),
    networkOnline: !offline,
    kioskStep: steps(ramp(filmTime, 5.2, 5.8), 3),
    officeLights: ramp(filmTime, 6.0, 6.4),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @markiro/landing exec vitest run src/scripts/film/animations.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/landing/src/scripts/film/animations.ts apps/landing/src/scripts/film/animations.test.ts
git commit -m "feat(landing): film belt, case, pallet, queue and kiosk states" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Quality tiers and the frame budget

**Files:**
- Create: `apps/landing/src/scripts/film/quality.ts`
- Test: `apps/landing/src/scripts/film/quality.test.ts`

**Interfaces:**
- Produces: `type QualityTier = "high" | "mid" | "low"`, `QUALITY_TIERS`, `interface DeviceHints { coarsePointer: boolean; deviceMemory: number | null; cores: number | null }`, `interface TierSettings { pixelRatioCap; shadowMapSize; ambientOcclusion; bloom; tiltShift; antialiasSamples }`, `TIER_SETTINGS`, `chooseTier(hints): QualityTier`, `type FrameVerdict = "measuring" | "ok" | "too-slow"`, `interface FrameBudget { push(frameMs: number, now: number): FrameVerdict }`, `createFrameBudget(limitMs?: number, windowMs?: number): FrameBudget`.

- [ ] **Step 1: Write the failing test**

Create `apps/landing/src/scripts/film/quality.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { chooseTier, createFrameBudget, TIER_SETTINGS } from "./quality";

describe("film quality", () => {
  it("picks a tier from device hints", () => {
    expect(chooseTier({ coarsePointer: false, deviceMemory: 8, cores: 8 })).toBe("high");
    expect(chooseTier({ coarsePointer: true, deviceMemory: 8, cores: 8 })).toBe("mid");
    expect(chooseTier({ coarsePointer: false, deviceMemory: 2, cores: 8 })).toBe("low");
    expect(chooseTier({ coarsePointer: true, deviceMemory: null, cores: 2 })).toBe("low");
    expect(chooseTier({ coarsePointer: false, deviceMemory: null, cores: null })).toBe("high");
  });

  it("drops ambient occlusion on phones and bloom on weak devices", () => {
    expect(TIER_SETTINGS.high.ambientOcclusion).toBe(true);
    expect(TIER_SETTINGS.mid.ambientOcclusion).toBe(false);
    expect(TIER_SETTINGS.low.bloom).toBe(false);
    expect(TIER_SETTINGS.high.pixelRatioCap).toBe(2);
    expect(TIER_SETTINGS.mid.pixelRatioCap).toBe(1.5);
  });

  it("measures for two seconds, then judges the median frame once", () => {
    const fast = createFrameBudget();
    let verdict = fast.push(16, 0);
    for (let now = 16; now < 2100; now += 16) verdict = fast.push(16, now);
    expect(verdict).toBe("ok");

    const slow = createFrameBudget();
    let slowVerdict = slow.push(120, 0);
    expect(slowVerdict).toBe("measuring");
    for (let now = 120; now < 2200; now += 120) slowVerdict = slow.push(120, now);
    expect(slowVerdict).toBe("too-slow");
    expect(slow.push(10, 5000)).toBe("too-slow");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @markiro/landing exec vitest run src/scripts/film/quality.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

Create `apps/landing/src/scripts/film/quality.ts`:

```ts
export type QualityTier = "high" | "mid" | "low";

export const QUALITY_TIERS: readonly QualityTier[] = ["high", "mid", "low"];

export interface DeviceHints {
  readonly coarsePointer: boolean;
  readonly deviceMemory: number | null;
  readonly cores: number | null;
}

export interface TierSettings {
  readonly pixelRatioCap: number;
  readonly shadowMapSize: number;
  readonly ambientOcclusion: boolean;
  readonly bloom: boolean;
  readonly tiltShift: boolean;
  readonly antialiasSamples: number;
}

export const TIER_SETTINGS: Readonly<Record<QualityTier, TierSettings>> = {
  high: {
    pixelRatioCap: 2,
    shadowMapSize: 4096,
    ambientOcclusion: true,
    bloom: true,
    tiltShift: true,
    antialiasSamples: 4,
  },
  mid: {
    pixelRatioCap: 1.5,
    shadowMapSize: 2048,
    ambientOcclusion: false,
    bloom: true,
    tiltShift: true,
    antialiasSamples: 2,
  },
  low: {
    pixelRatioCap: 1,
    shadowMapSize: 1024,
    ambientOcclusion: false,
    bloom: false,
    tiltShift: false,
    antialiasSamples: 0,
  },
};

export function chooseTier(hints: DeviceHints): QualityTier {
  const weakMemory = hints.deviceMemory !== null && hints.deviceMemory <= 2;
  const weakCpu = hints.cores !== null && hints.cores <= 2;
  if (weakMemory || weakCpu) return "low";
  return hints.coarsePointer ? "mid" : "high";
}

export type FrameVerdict = "measuring" | "ok" | "too-slow";

export interface FrameBudget {
  push(frameMs: number, now: number): FrameVerdict;
}

/** Judges the median frame of the first `windowMs` of rendering, once. */
export function createFrameBudget(limitMs = 50, windowMs = 2000): FrameBudget {
  const samples: number[] = [];
  let startedAt: number | null = null;
  let verdict: FrameVerdict = "measuring";
  return {
    push(frameMs, now) {
      if (verdict !== "measuring") return verdict;
      startedAt ??= now;
      samples.push(frameMs);
      if (now - startedAt < windowMs) return verdict;
      const sorted = [...samples].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
      verdict = median > limitMs ? "too-slow" : "ok";
      return verdict;
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @markiro/landing exec vitest run src/scripts/film/quality.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/landing/src/scripts/film/quality.ts apps/landing/src/scripts/film/quality.test.ts
git commit -m "feat(landing): film quality tiers and frame budget" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: three, the model kit, textures, props and figures

**Files:**
- Modify: `apps/landing/package.json`, `pnpm-lock.yaml` (by pnpm)
- Create: `apps/landing/src/scripts/film/world/kit.ts`, `textures.ts`, `props.ts`, `figures.ts` (all in `world/`)
- Test: `apps/landing/src/scripts/film/world/kit.test.ts`

**Interfaces:**
- Consumes: `mixHex` (Task 3), `ProductKind` (Task 6).
- Produces:
  - `kit.ts`: `ROLES`, `type Role`, `DAY_PALETTE`, `NIGHT_PALETTE`, `interface PlaceOptions { castShadow?; receiveShadow?; rotationY? }`, `class Signals { verified; rejected; offline; lamp: MeshBasicMaterial; setGlow(glow: number, lamps: number): void }`, `class Kit { signals; material(role): MeshStandardMaterial; flat(role): MeshStandardMaterial; colorOf(role): string; setNightMix(mix: number): void; box(w, h, d, r?): RoundedBoxGeometry; place(parent, geometry, material, x, y, z, options?): Mesh; block(parent, w, h, d, material: Role | Material, x, y, z, r?, options?): Mesh }` (`block` stands the box on `y`)
  - `textures.ts`: `type Draw`, `interface TextureFactory { create(width, height, draw): Texture }`, `canvasTextureFactory`, `blankTextureFactory`, `interface ScreenTextures { label; contactShadow; station(dark: boolean): Texture; kiosk(dark: boolean, step: number): Texture }`, `createScreenTextures(factory): ScreenTextures`
  - `props.ts`: `interface Product { group: Group; code: Mesh }`, `createProduct(kit, kind): Product`, `openCase(kit, parent, x, y, z, capacity): { group; products: readonly Object3D[] }`, `closedCase(kit, parent, x, y, z, rotationY, label: Material): Group`, `pallet(kit, parent, x, y, z, capacity, label): { group; cases: readonly Group[] }`, `rack(kit, parent, x0, z0)`, `van(kit, parent, x, z, label)`, `tree(kit, parent, x, z, scale)`, `lampFixture(kit, parent, x, y, z, ceiling)`
  - `figures.ts`: `type Pose = "stand" | "work" | "walk" | "device" | "badge"`, `person(kit, parent, x, z, rotationY, pose?, y?): Group` (group named `person`; `device` adds a mesh named `handheld-screen`, `badge` a mesh named `badge`)

- [ ] **Step 1: Install three and its types**

Run:
```bash
pnpm --filter @markiro/landing add --save-exact three@0.186.0
pnpm --filter @markiro/landing add --save-exact -D @types/three@0.186.0
git diff apps/landing/package.json
git diff pnpm-lock.yaml | grep -E '^\+  [^ ]+@[0-9]' | sort -u
```
Expected: `"three": "0.186.0"` in `dependencies` and `"@types/three": "0.186.0"` in `devDependencies`, no `^`. For every new package in the last command's output check `npm view <name>@<version> time --json`: each must be older than seven days. If one is newer, stop and report it; do not add exclusions or bypass the policy.

- [ ] **Step 2: Write the failing test**

Create `apps/landing/src/scripts/film/world/kit.test.ts`:

```ts
import { Group, Mesh, MeshBasicMaterial } from "three";
import { describe, expect, it } from "vitest";

import { parseHex } from "../color";
import { person } from "./figures";
import { DAY_PALETTE, Kit, NIGHT_PALETTE, ROLES } from "./kit";
import { createProduct, openCase, pallet } from "./props";
import { blankTextureFactory, createScreenTextures } from "./textures";

function meshes(root: Group): Mesh[] {
  const found: Mesh[] = [];
  root.traverse((node) => {
    if (node instanceof Mesh) found.push(node);
  });
  return found;
}

function expectColour(actual: string, expected: string): void {
  const a = parseHex(`#${actual}`);
  const b = parseHex(expected);
  a.forEach((channel, index) => {
    expect(Math.abs(channel - (b[index] ?? 0))).toBeLessThan(2 / 255);
  });
}

describe("film model kit", () => {
  it("shares one material per palette role and recolours it for the night", () => {
    const kit = new Kit();
    const wall = kit.material("wall");
    expect(kit.material("wall")).toBe(wall);
    expectColour(wall.color.getHexString(), DAY_PALETTE.wall);
    kit.setNightMix(1);
    expectColour(wall.color.getHexString(), NIGHT_PALETTE.wall);
    for (const role of ROLES) expect(NIGHT_PALETTE[role]).toMatch(/^#[0-9a-f]{6}$/u);
  });

  it("stands blocks on their base", () => {
    const kit = new Kit();
    const block = kit.block(new Group(), 1, 2, 1, "wall", 3, 0.5, -1);
    expect(block.position.toArray()).toEqual([3, 1.5, -1]);
  });

  it("builds every product with a code plate", () => {
    const kit = new Kit();
    for (const kind of ["bottle", "jar", "can"] as const) {
      const product = createProduct(kit, kind);
      expect(product.code.name).toBe("code");
      expect(product.group.children).toContain(product.code);
    }
  });

  it("fills an open case with verified products and stacks a pallet", () => {
    const kit = new Kit();
    const root = new Group();
    const packing = openCase(kit, root, 0, 0, 0, 6);
    expect(packing.products).toHaveLength(6);
    const codes = meshes(packing.group).filter((mesh) => mesh.name === "code");
    expect(codes).toHaveLength(6);
    expect(codes.every((mesh) => mesh.material === kit.signals.verified)).toBe(true);
    expect(pallet(kit, root, 0, 0, 0, 8, new MeshBasicMaterial()).cases).toHaveLength(8);
  });

  it("dresses people in coats and gives the handheld worker a green screen", () => {
    const kit = new Kit();
    const root = new Group();
    const worker = person(kit, root, 0, 0, 0, "device");
    const visitor = person(kit, root, 1, 0, 0, "badge");
    expect(worker.name).toBe("person");
    expect(meshes(worker).find((mesh) => mesh.name === "handheld-screen")?.material).toBe(
      kit.signals.verified,
    );
    expect(meshes(visitor).some((mesh) => mesh.name === "badge")).toBe(true);
    expect(meshes(worker).length).toBeGreaterThan(10);
  });

  it("prepares day and night screens for every kiosk step", () => {
    const screens = createScreenTextures(blankTextureFactory);
    expect(screens.station(false)).not.toBe(screens.station(true));
    const kiosk = new Set(
      [0, 1, 2, 3].flatMap((step) => [screens.kiosk(false, step), screens.kiosk(true, step)]),
    );
    expect(kiosk.size).toBe(8);
    expect(screens.kiosk(false, 9)).toBe(screens.kiosk(false, 3));
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @markiro/landing exec vitest run src/scripts/film/world/kit.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 4: Implement the kit**

Create `apps/landing/src/scripts/film/world/kit.ts`:

```ts
import {
  Color,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  type BufferGeometry,
  type Material,
  type Object3D,
} from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";

import { mixHex } from "../color";

export const ROLES = [
  "base",
  "yard",
  "road",
  "marking",
  "floor",
  "wall",
  "cut",
  "column",
  "steel",
  "graphite",
  "belt",
  "plaster",
  "bottle",
  "card",
  "cardDark",
  "tape",
  "pallet",
  "tree",
  "trunk",
  "coat",
  "trousers",
  "skin",
  "cap",
  "shoe",
  "glass",
  "tank",
  "roof",
  "codeIdle",
] as const;

export type Role = (typeof ROLES)[number];

// Day colours follow packages/ui/src/tokens.css and the prototype scene.
export const DAY_PALETTE: Readonly<Record<Role, string>> = {
  base: "#ebe9e2",
  yard: "#e2dfd6",
  road: "#dcd8ce",
  marking: "#f6f5f1",
  floor: "#f2f0eb",
  wall: "#fbfaf7",
  cut: "#17161a",
  column: "#f6f4ef",
  steel: "#c9c6bd",
  graphite: "#2a292e",
  belt: "#3a393f",
  plaster: "#f7f5f0",
  bottle: "#ffffff",
  card: "#e6e1d6",
  cardDark: "#d8d2c5",
  tape: "#cbc4b6",
  pallet: "#d6d0c4",
  tree: "#f4f2ec",
  trunk: "#bdb9af",
  coat: "#f7f5f0",
  trousers: "#8e8b83",
  skin: "#e4dfd5",
  cap: "#ffffff",
  shoe: "#3a393f",
  glass: "#a9a59c",
  tank: "#eeece6",
  roof: "#e9e6df",
  codeIdle: "#8e8b83",
};

export const NIGHT_PALETTE: Readonly<Record<Role, string>> = {
  base: "#1e1d22",
  yard: "#1a191e",
  road: "#232228",
  marking: "#34333a",
  floor: "#29282e",
  wall: "#302f36",
  cut: "#8e8b83",
  column: "#36353c",
  steel: "#4a4950",
  graphite: "#0f0e12",
  belt: "#17161b",
  plaster: "#3c3b42",
  bottle: "#8e8b83",
  card: "#57534b",
  cardDark: "#4a463f",
  tape: "#645f56",
  pallet: "#46423c",
  tree: "#2b2a31",
  trunk: "#3a3940",
  coat: "#d8d5cd",
  trousers: "#5b5952",
  skin: "#bdb9af",
  cap: "#edebe6",
  shoe: "#1c1b21",
  glass: "#2e2d34",
  tank: "#34333a",
  roof: "#2a2930",
  codeIdle: "#5b5952",
};

export interface PlaceOptions {
  readonly castShadow?: boolean;
  readonly receiveShadow?: boolean;
  readonly rotationY?: number;
}

/** Unlit status colours. Only the meshes named in the plan may use them. */
export class Signals {
  readonly verified = new MeshBasicMaterial({ color: "#3ddc7a" });
  readonly rejected = new MeshBasicMaterial({ color: "#c0392b" });
  readonly offline = new MeshBasicMaterial({ color: "#dd9420" });
  readonly lamp = new MeshBasicMaterial({ color: "#ffe6bf" });
  private readonly base = {
    verified: new Color("#3ddc7a"),
    rejected: new Color("#c0392b"),
    offline: new Color("#dd9420"),
    lamp: new Color("#ffe6bf"),
  };

  /** Pushes the signals above 1 after dusk so the bloom pass picks them up. */
  setGlow(glow: number, lamps: number): void {
    this.verified.color.copy(this.base.verified).multiplyScalar(1 + 0.8 * glow);
    this.rejected.color.copy(this.base.rejected).multiplyScalar(1 + 0.6 * glow);
    this.offline.color.copy(this.base.offline).multiplyScalar(1 + 0.8 * glow);
    this.lamp.color.copy(this.base.lamp).multiplyScalar(1 + 2 * lamps);
  }
}

export class Kit {
  readonly signals = new Signals();
  private readonly materials = new Map<Role, MeshStandardMaterial>();
  private readonly flatMaterials = new Map<Role, MeshStandardMaterial>();
  private readonly boxes = new Map<string, RoundedBoxGeometry>();
  private nightMix = 0;

  /** The shared matte material of a palette role. */
  material(role: Role): MeshStandardMaterial {
    return this.cached(this.materials, role, false);
  }

  /** The same colour with flat shading, for faceted shapes such as tree crowns. */
  flat(role: Role): MeshStandardMaterial {
    return this.cached(this.flatMaterials, role, true);
  }

  private cached(
    cache: Map<Role, MeshStandardMaterial>,
    role: Role,
    flatShading: boolean,
  ): MeshStandardMaterial {
    let material = cache.get(role);
    if (material === undefined) {
      material = new MeshStandardMaterial({
        color: this.colorOf(role),
        roughness: 0.9,
        metalness: 0,
        flatShading,
      });
      material.name = role;
      cache.set(role, material);
    }
    return material;
  }

  colorOf(role: Role): string {
    return mixHex(DAY_PALETTE[role], NIGHT_PALETTE[role], this.nightMix);
  }

  setNightMix(mix: number): void {
    if (mix === this.nightMix) return;
    this.nightMix = mix;
    for (const [role, material] of this.materials) material.color.set(this.colorOf(role));
    for (const [role, material] of this.flatMaterials) material.color.set(this.colorOf(role));
  }

  box(width: number, height: number, depth: number, radius = 0.03): RoundedBoxGeometry {
    const r = Math.max(
      0.0005,
      Math.min(radius, width / 2 - 1e-4, height / 2 - 1e-4, depth / 2 - 1e-4),
    );
    const key = `${width}|${height}|${depth}|${r}`;
    let geometry = this.boxes.get(key);
    if (geometry === undefined) {
      geometry = new RoundedBoxGeometry(width, height, depth, 2, r);
      this.boxes.set(key, geometry);
    }
    return geometry;
  }

  place(
    parent: Object3D,
    geometry: BufferGeometry,
    material: Material,
    x: number,
    y: number,
    z: number,
    options: PlaceOptions = {},
  ): Mesh {
    const mesh = new Mesh(geometry, material);
    mesh.position.set(x, y, z);
    mesh.rotation.y = options.rotationY ?? 0;
    mesh.castShadow = options.castShadow ?? true;
    mesh.receiveShadow = options.receiveShadow ?? true;
    parent.add(mesh);
    return mesh;
  }

  /** A rounded box standing on `y`, centred on `x` and `z`. */
  block(
    parent: Object3D,
    width: number,
    height: number,
    depth: number,
    material: Role | Material,
    x: number,
    y: number,
    z: number,
    radius = 0.03,
    options: PlaceOptions = {},
  ): Mesh {
    const resolved = typeof material === "string" ? this.material(material) : material;
    return this.place(
      parent,
      this.box(width, height, depth, radius),
      resolved,
      x,
      y + height / 2,
      z,
      options,
    );
  }
}
```

- [ ] **Step 5: Implement the textures**

Create `apps/landing/src/scripts/film/world/textures.ts`:

```ts
import { CanvasTexture, SRGBColorSpace, Texture } from "three";

export type Draw = (context: CanvasRenderingContext2D, width: number, height: number) => void;

export interface TextureFactory {
  create(width: number, height: number, draw: Draw): Texture;
}

export const canvasTextureFactory: TextureFactory = {
  create(width, height, draw) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (context !== null) draw(context, width, height);
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    texture.anisotropy = 8;
    return texture;
  },
};

/** For tests: textures without pixels. */
export const blankTextureFactory: TextureFactory = {
  create: () => new Texture(),
};

export interface ScreenTextures {
  readonly label: Texture;
  readonly contactShadow: Texture;
  station(dark: boolean): Texture;
  kiosk(dark: boolean, step: number): Texture;
}

const GREEN = "#3DDC7A";

function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 16807) % 2147483647;
    return state / 2147483647;
  };
}

const drawLabel: Draw = (g, width) => {
  const random = seeded(7);
  g.fillStyle = "#FFFFFF";
  g.fillRect(0, 0, width, 176);
  g.fillStyle = "#17161A";
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      if (x === 0 || y === 7 || random() > 0.5) g.fillRect(16 + x * 7, 14 + y * 7, 7, 7);
    }
  }
  for (let row = 0; row < 5; row += 1) g.fillRect(92, 18 + row * 12, 60 + random() * 90, 5);
  let x = 16;
  while (x < width - 18) {
    const bar = 2 + Math.floor(random() * 5);
    g.fillRect(x, 100, bar, 56);
    x += bar + 2 + Math.floor(random() * 4);
  }
};

function drawStation(dark: boolean): Draw {
  return (g, width) => {
    g.fillStyle = dark ? "#1C1B21" : "#FFFFFF";
    g.fillRect(0, 0, width, 320);
    g.fillStyle = dark ? "#2E2D33" : "#17161A";
    g.fillRect(0, 0, width, 26);
    g.fillStyle = dark ? "#45444B" : "#E0DED7";
    g.fillRect(24, 50, 120, 150);
    for (let row = 0; row < 4; row += 1) g.fillRect(24, 214 + row * 18, 90 + (row % 2) * 30, 8);
    for (let cell = 0; cell < 10; cell += 1) {
      const x = 172 + (cell % 5) * 62;
      const y = 60 + Math.floor(cell / 5) * 70;
      if (cell < 7) {
        g.fillStyle = GREEN;
        g.fillRect(x, y, 52, 56);
      } else {
        g.strokeStyle = dark ? "#5B5952" : "#C9C6BD";
        g.lineWidth = 3;
        g.strokeRect(x + 1.5, y + 1.5, 49, 53);
      }
    }
    g.fillStyle = dark ? "#2E2D33" : "#F0EFEA";
    g.fillRect(172, 222, 302, 14);
    g.fillStyle = GREEN;
    g.fillRect(172, 222, 212, 14);
  };
}

function drawKiosk(dark: boolean, step: number): Draw {
  return (g, width, height) => {
    g.fillStyle = dark ? "#1C1B21" : "#FFFFFF";
    g.fillRect(0, 0, width, height);
    g.fillStyle = dark ? "#2E2D33" : "#17161A";
    g.fillRect(0, 0, width, 30);
    g.fillStyle = dark ? "#45444B" : "#E0DED7";
    g.fillRect(24, 56, 96, 96);
    for (let row = 0; row < 3; row += 1) g.fillRect(136, 60 + row * 22, 90 - row * 14, 10);
    for (let row = 0; row < 3; row += 1) {
      g.fillStyle = row < step ? GREEN : dark ? "#45444B" : "#E0DED7";
      g.fillRect(24, 180 + row * 34, width - 48, 22);
    }
    g.fillStyle = step >= 3 ? GREEN : dark ? "#2E2D33" : "#F0EFEA";
    g.fillRect(24, 300, width - 48, 36);
  };
}

const drawContactShadow: Draw = (g, width, height) => {
  g.filter = "blur(30px)";
  g.fillStyle = "#000000";
  g.beginPath();
  g.roundRect(64, 120, width - 128, height - 240, 36);
  g.fill();
};

export function createScreenTextures(factory: TextureFactory): ScreenTextures {
  const label = factory.create(256, 176, drawLabel);
  const contactShadow = factory.create(512, 512, drawContactShadow);
  const stations = [
    factory.create(512, 320, drawStation(false)),
    factory.create(512, 320, drawStation(true)),
  ];
  const kiosks = [false, true].map((dark) =>
    [0, 1, 2, 3].map((step) => factory.create(256, 360, drawKiosk(dark, step))),
  );
  return {
    label,
    contactShadow,
    station: (dark) => stations[dark ? 1 : 0] ?? label,
    kiosk: (dark, step) => {
      const row = kiosks[dark ? 1 : 0] ?? [];
      return row[Math.max(0, Math.min(3, step))] ?? label;
    },
  };
}
```

- [ ] **Step 6: Implement the props**

Create `apps/landing/src/scripts/film/world/props.ts`:

```ts
import {
  CircleGeometry,
  CylinderGeometry,
  Group,
  IcosahedronGeometry,
  LatheGeometry,
  PlaneGeometry,
  Vector2,
  type Material,
  type Mesh,
  type Object3D,
} from "three";

import type { ProductKind } from "../animations";
import type { Kit } from "./kit";

export interface Product {
  readonly group: Group;
  readonly code: Mesh;
}

const BOTTLE_PROFILE: readonly (readonly [number, number])[] = [
  [0, 0],
  [0.085, 0],
  [0.1, 0.025],
  [0.1, 0.3],
  [0.088, 0.345],
  [0.05, 0.4],
  [0.042, 0.44],
  [0.042, 0.5],
  [0, 0.5],
];

const shapes = {
  bottle: new LatheGeometry(
    BOTTLE_PROFILE.map(([r, y]) => new Vector2(r, y)),
    28,
  ),
  bottleCap: new CylinderGeometry(0.047, 0.047, 0.05, 18),
  jar: new CylinderGeometry(0.11, 0.11, 0.2, 28),
  jarLid: new CylinderGeometry(0.116, 0.116, 0.05, 28),
  can: new CylinderGeometry(0.075, 0.075, 0.3, 24),
  canRim: new CylinderGeometry(0.068, 0.075, 0.02, 24),
  codeBottle: new PlaneGeometry(0.08, 0.08),
  codeJar: new PlaneGeometry(0.07, 0.07),
  codeCan: new PlaneGeometry(0.06, 0.06),
  caseLabel: new PlaneGeometry(0.24, 0.165),
  palletLabel: new PlaneGeometry(0.34, 0.24),
  wheel: new CylinderGeometry(0.24, 0.24, 0.16, 20),
  headlight: new PlaneGeometry(0.16, 0.1),
  crown: new IcosahedronGeometry(0.46, 1),
  trunk: new CylinderGeometry(0.035, 0.045, 0.62, 8),
  shade: new CylinderGeometry(0.08, 0.26, 0.16, 20),
  disc: new CircleGeometry(0.23, 20),
};

export function createProduct(kit: Kit, kind: ProductKind): Product {
  const group = new Group();
  group.name = `product-${kind}`;
  let code: Mesh;
  if (kind === "bottle") {
    kit.place(group, shapes.bottle, kit.material("bottle"), 0, 0, 0);
    kit.place(group, shapes.bottleCap, kit.material("graphite"), 0, 0.52, 0);
    code = kit.place(group, shapes.codeBottle, kit.material("codeIdle"), 0, 0.19, 0.102, {
      castShadow: false,
    });
  } else if (kind === "jar") {
    kit.place(group, shapes.jar, kit.material("bottle"), 0, 0.1, 0);
    kit.place(group, shapes.jarLid, kit.material("graphite"), 0, 0.225, 0);
    code = kit.place(group, shapes.codeJar, kit.material("codeIdle"), 0, 0.1, 0.112, {
      castShadow: false,
    });
  } else {
    kit.place(group, shapes.can, kit.material("tank"), 0, 0.15, 0);
    kit.place(group, shapes.canRim, kit.material("steel"), 0, 0.305, 0);
    code = kit.place(group, shapes.codeCan, kit.material("codeIdle"), 0, 0.15, 0.077, {
      castShadow: false,
    });
  }
  code.name = "code";
  return { group, code };
}

export function openCase(
  kit: Kit,
  parent: Object3D,
  x: number,
  y: number,
  z: number,
  capacity: number,
): { readonly group: Group; readonly products: readonly Object3D[] } {
  const group = new Group();
  group.name = "open-case";
  group.position.set(x, y, z);
  const width = 0.62;
  const depth = 0.44;
  const height = 0.34;
  const t = 0.018;
  kit.block(group, width, t, depth, "card", 0, 0, 0, 0.004);
  for (const side of [-1, 1]) {
    kit.block(group, width, height, t, "card", 0, 0, side * (depth / 2 - t / 2), 0.004);
    kit.block(group, t, height, depth, "card", side * (width / 2 - t / 2), 0, 0, 0.004);
  }
  const flap = (
    flapWidth: number,
    flapDepth: number,
    px: number,
    pz: number,
    axis: "x" | "z",
    angle: number,
    cx: number,
    cz: number,
  ): void => {
    const pivot = new Group();
    pivot.position.set(px, height, pz);
    pivot.rotation[axis] = angle;
    kit.block(pivot, flapWidth, t, flapDepth, "cardDark", cx, -t / 2, cz, 0.004);
    group.add(pivot);
  };
  flap(width, depth * 0.48, 0, -depth / 2, "x", 0.62, 0, -depth * 0.24);
  flap(width, depth * 0.48, 0, depth / 2, "x", -0.62, 0, depth * 0.24);
  flap(width * 0.48, depth, -width / 2, 0, "z", -0.62, -width * 0.24, 0);
  flap(width * 0.48, depth, width / 2, 0, "z", 0.62, width * 0.24, 0);
  const products: Object3D[] = [];
  for (let slot = 0; slot < capacity; slot += 1) {
    const product = createProduct(kit, "bottle");
    product.group.position.set(((slot % 3) - 1) * 0.2, t, (Math.floor(slot / 3) - 0.5) * 0.2);
    product.code.material = kit.signals.verified;
    group.add(product.group);
    products.push(product.group);
  }
  parent.add(group);
  return { group, products };
}

export function closedCase(
  kit: Kit,
  parent: Object3D,
  x: number,
  y: number,
  z: number,
  rotationY: number,
  label: Material,
): Group {
  const group = new Group();
  group.name = "closed-case";
  group.position.set(x, y, z);
  group.rotation.y = rotationY;
  kit.block(group, 0.62, 0.5, 0.44, "card", 0, 0, 0, 0.014);
  kit.block(group, 0.63, 0.012, 0.09, "tape", 0, 0.495, 0, 0.004, { castShadow: false });
  kit.place(group, shapes.caseLabel, label, 0.12, 0.27, 0.2215, { castShadow: false }).name =
    "label";
  parent.add(group);
  return group;
}

export function pallet(
  kit: Kit,
  parent: Object3D,
  x: number,
  y: number,
  z: number,
  capacity: number,
  label: Material,
): { readonly group: Group; readonly cases: readonly Group[] } {
  const group = new Group();
  group.name = "pallet";
  group.position.set(x, y, z);
  for (const side of [-1, 0, 1]) {
    kit.block(group, 1.28, 0.1, 0.12, "pallet", 0, 0, side * 0.4, 0.01);
  }
  for (let board = 0; board < 7; board += 1) {
    kit.block(group, 0.13, 0.035, 0.94, "pallet", -0.57 + board * 0.19, 0.1, 0, 0.008);
  }
  const cases: Group[] = [];
  for (let slot = 0; slot < capacity; slot += 1) {
    const layer = Math.floor(slot / 4);
    const place = slot % 4;
    cases.push(
      closedCase(
        kit,
        group,
        place % 2 === 0 ? -0.32 : 0.32,
        0.135 + layer * 0.505,
        place < 2 ? 0.225 : -0.225,
        0,
        label,
      ),
    );
  }
  kit.place(group, shapes.palletLabel, label, -0.05, 0.3, 0.472, { castShadow: false }).name =
    "pallet-label";
  parent.add(group);
  return { group, cases };
}

export function rack(kit: Kit, parent: Object3D, x0: number, z0: number): void {
  const length = 1.6;
  const depth = 0.5;
  const height = 1.55;
  for (const dx of [0, length]) {
    for (const dz of [0, depth]) {
      kit.block(parent, 0.05, height, 0.05, "graphite", x0 + dx, 0.06, z0 + 0.25 + dz, 0.01);
    }
  }
  for (const shelf of [0.25, 0.8, 1.35]) {
    kit.block(parent, length + 0.05, 0.04, depth + 0.05, "steel", x0 + length / 2, 0.06 + shelf, z0 + 0.25 + depth / 2, 0.01);
    kit.block(parent, length - 0.3, 0.22, depth - 0.12, "card", x0 + length / 2, 0.1 + shelf, z0 + 0.25 + depth / 2, 0.01);
  }
}

export function van(kit: Kit, parent: Object3D, x: number, z: number, label: Material): void {
  const group = new Group();
  group.name = "van";
  group.position.set(x, 0.02, z);
  kit.block(group, 2.3, 1.3, 1.3, "plaster", 0.1, 0.28, 0, 0.08);
  kit.block(group, 0.95, 0.95, 1.26, "plaster", 1.72, 0.28, 0, 0.12);
  kit.block(group, 0.05, 0.42, 1.08, "graphite", 2.18, 0.72, 0, 0.02);
  for (const [wx, wz] of [
    [-0.6, -0.6],
    [-0.6, 0.6],
    [1.6, -0.6],
    [1.6, 0.6],
  ] as const) {
    kit.place(group, shapes.wheel, kit.material("graphite"), wx, 0.26, wz).rotation.x = Math.PI / 2;
  }
  for (const side of [-1, 1]) {
    const door = kit.block(group, 0.04, 1.2, 0.62, "plaster", -1.33, 0.33, side * 0.62, 0.01);
    door.rotation.y = side * 1.25;
    const light = kit.place(group, shapes.headlight, kit.signals.lamp, 2.206, 0.55, side * 0.45, {
      castShadow: false,
    });
    light.rotation.y = Math.PI / 2;
    light.name = "headlight";
  }
  closedCase(kit, group, -0.5, 0.33, -0.25, 0.1, label);
  closedCase(kit, group, -0.5, 0.33, 0.24, -0.05, label);
  parent.add(group);
}

export function tree(kit: Kit, parent: Object3D, x: number, z: number, scale: number): void {
  kit.place(parent, shapes.trunk, kit.material("trunk"), x, 0.31, z);
  kit.place(parent, shapes.crown, kit.flat("tree"), x, 0.62 + 0.4 * scale, z).scale.setScalar(scale);
}

export function lampFixture(
  kit: Kit,
  parent: Object3D,
  x: number,
  y: number,
  z: number,
  ceiling: number,
): void {
  kit.block(parent, 0.03, Math.max(0.05, ceiling - y - 0.1), 0.03, "graphite", x, y + 0.1, z, 0.005, {
    castShadow: false,
  });
  kit.place(parent, shapes.shade, kit.material("graphite"), x, y + 0.02, z, { castShadow: false });
  const disc = kit.place(parent, shapes.disc, kit.signals.lamp, x, y - 0.065, z, {
    castShadow: false,
  });
  disc.rotation.x = Math.PI / 2;
  disc.name = "lamp-disc";
}
```

- [ ] **Step 7: Implement the figures**

Create `apps/landing/src/scripts/film/world/figures.ts`:

```ts
import {
  CapsuleGeometry,
  CatmullRomCurve3,
  CylinderGeometry,
  Euler,
  Group,
  LatheGeometry,
  PlaneGeometry,
  SphereGeometry,
  TubeGeometry,
  Vector2,
  Vector3,
  type Object3D,
} from "three";

import type { Kit } from "./kit";

export type Pose = "stand" | "work" | "walk" | "device" | "badge";

type Arm = readonly [pitch: number, abduction: number, bend: number];

interface PoseSpec {
  readonly legs: readonly [number, number];
  readonly arms: readonly [Arm, Arm];
}

const POSES: Readonly<Record<Pose, PoseSpec>> = {
  stand: { legs: [0, 0], arms: [[0.04, 0.09, -0.14], [0.04, 0.09, -0.14]] },
  work: { legs: [0.04, -0.04], arms: [[-0.4, 0.12, -0.8], [-0.4, 0.12, -0.8]] },
  walk: { legs: [0.3, -0.27], arms: [[-0.3, 0.08, -0.3], [0.28, 0.08, -0.2]] },
  device: { legs: [0, 0], arms: [[0.05, 0.09, -0.16], [-0.26, 0.06, -1.3]] },
  badge: { legs: [0, 0], arms: [[0.05, 0.09, -0.16], [-0.62, 0.05, -0.9]] },
};

// The white coat is one lathe silhouette, so the figure has no seam at the waist.
const COAT_PROFILE: readonly (readonly [number, number])[] = [
  [0, 0.47],
  [0.156, 0.47],
  [0.151, 0.62],
  [0.141, 0.86],
  [0.131, 1.0],
  [0.149, 1.22],
  [0.161, 1.34],
  [0.139, 1.43],
  [0.074, 1.49],
  [0, 1.5],
];

const shapes = {
  coat: new LatheGeometry(
    COAT_PROFILE.map(([r, y]) => new Vector2(r, y)),
    32,
  ),
  leg: new CapsuleGeometry(0.054, 0.4, 4, 14),
  shoe: new SphereGeometry(0.066, 16, 10),
  neck: new CylinderGeometry(0.042, 0.048, 0.08, 14),
  head: new SphereGeometry(0.098, 28, 20),
  cap: new SphereGeometry(0.107, 28, 12, 0, Math.PI * 2, 0, Math.PI / 2),
  hand: new SphereGeometry(0.04, 16, 12),
  shoulder: new SphereGeometry(0.043, 14, 10),
  screen: new PlaneGeometry(0.066, 0.1),
};

const DOWN = new Vector3(0, -1, 0);

export function person(
  kit: Kit,
  parent: Object3D,
  x: number,
  z: number,
  rotationY: number,
  pose: Pose = "stand",
  y = 0.06,
): Group {
  const spec = POSES[pose];
  const figure = new Group();
  figure.name = "person";
  figure.position.set(x, y, z);
  figure.rotation.y = rotationY;
  spec.legs.forEach((swing, index) => {
    const hip = new Group();
    hip.position.set((index === 0 ? -1 : 1) * 0.068, 0.56, 0);
    hip.rotation.x = swing;
    kit.place(hip, shapes.leg, kit.material("trousers"), 0, -0.25, 0);
    kit.place(hip, shapes.shoe, kit.material("shoe"), 0, -0.5, 0.034).scale.set(0.95, 0.55, 1.55);
    figure.add(hip);
  });
  kit.place(figure, shapes.coat, kit.material("coat"), 0, 0, 0).scale.z = 0.72;
  kit.place(figure, shapes.neck, kit.material("skin"), 0, 1.53, 0);
  kit.place(figure, shapes.head, kit.material("skin"), 0, 1.645, 0.004).scale.set(0.9, 1.1, 0.98);
  kit.place(figure, shapes.cap, kit.material("cap"), 0, 1.675, -0.004).scale.set(1, 0.8, 1.04);
  spec.arms.forEach(([pitch, abduction, bend], index) => {
    const side = index === 0 ? -1 : 1;
    const shoulder = new Vector3(side * 0.158, 1.39, 0);
    const upper = DOWN.clone().applyEuler(new Euler(pitch, 0, side * abduction));
    const elbow = shoulder.clone().addScaledVector(upper, 0.3);
    const forearm = DOWN.clone().applyEuler(new Euler(pitch + bend, 0, side * abduction * 0.6));
    const hand = elbow.clone().addScaledVector(forearm, 0.27);
    const sleeve = new TubeGeometry(
      new CatmullRomCurve3([shoulder, elbow, hand], false, "centripetal"),
      20,
      0.041,
      12,
      false,
    );
    kit.place(figure, sleeve, kit.material("coat"), 0, 0, 0);
    kit.place(figure, shapes.shoulder, kit.material("coat"), shoulder.x, shoulder.y, shoulder.z);
    kit.place(figure, shapes.hand, kit.material("skin"), hand.x, hand.y, hand.z);
    if (side === 1 && (pose === "device" || pose === "badge")) {
      holdItem(kit, figure, hand, forearm, pose);
    }
  });
  parent.add(figure);
  return figure;
}

function holdItem(
  kit: Kit,
  figure: Group,
  hand: Vector3,
  forearm: Vector3,
  pose: "device" | "badge",
): void {
  const item = new Group();
  item.position.copy(hand).addScaledVector(forearm, 0.05);
  item.lookAt(item.position.clone().add(forearm));
  item.rotateX(-Math.PI / 2 + 0.35);
  if (pose === "device") {
    kit.block(item, 0.09, 0.02, 0.16, "graphite", 0, -0.01, 0, 0.008);
    const screen = kit.place(item, shapes.screen, kit.signals.verified, 0, 0.0115, 0.01, {
      castShadow: false,
    });
    screen.rotation.x = -Math.PI / 2;
    screen.name = "handheld-screen";
  } else {
    kit.block(item, 0.085, 0.006, 0.055, "plaster", 0, 0, 0, 0.002, { castShadow: false }).name =
      "badge";
  }
  figure.add(item);
}
```

- [ ] **Step 8: Run the test, typecheck and lint**

Run:
```bash
pnpm --filter @markiro/landing exec vitest run src/scripts/film/world/kit.test.ts
pnpm --filter @markiro/landing typecheck
pnpm --filter @markiro/landing lint
```
Expected: the test passes; no type or lint errors. If `@types/three` 0.186.0 names a parameter differently from a call above, adjust the call to the typings, never the typings.

- [ ] **Step 9: Commit**

```bash
git add apps/landing/package.json pnpm-lock.yaml apps/landing/src/scripts/film/world/kit.ts apps/landing/src/scripts/film/world/textures.ts apps/landing/src/scripts/film/world/props.ts apps/landing/src/scripts/film/world/figures.ts apps/landing/src/scripts/film/world/kit.test.ts
git commit -m "feat(landing): film model kit, props and figures on three 0.186.0" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: The plant and the district

**Files:**
- Create: `apps/landing/src/scripts/film/world/plant.ts`, `apps/landing/src/scripts/film/world/district.ts`
- Test: `apps/landing/src/scripts/film/world/district.test.ts`

**Interfaces:**
- Consumes: Task 8 modules; `BELT`, `CASE_CAPACITY`, `PALLET_CAPACITY`, `QUEUE_TILES`, `ProductKind` (Task 6).
- Produces:
  - `plant.ts`: `FLOOR = 0.06`, `HALL`, `CONVEYOR`, `BELT_TOP`, `type Vec3Tuple = readonly [number, number, number]`, `interface BeltSlot { group: Group; products: Readonly<Record<ProductKind, Group>>; codes: readonly Mesh[] }`, `interface PlantHandles { belt; caseProducts: readonly Object3D[]; labelTongue: Mesh; palletCases: readonly Object3D[]; queueTiles: readonly Mesh[]; queueBase: Vec3Tuple; mastLamp: Mesh; monitorScreen: Mesh<PlaneGeometry, MeshBasicMaterial>; kioskScreen: Mesh<PlaneGeometry, MeshBasicMaterial>; windows: MeshStandardMaterial; scanLamp: Vec3Tuple; lampSpots: readonly Vec3Tuple[] }`, `buildPlant(kit, parent, screens): PlantHandles` (adds a group named `plant`)
  - `district.ts`: `DISTRICT = { width: 36, depth: 24 }`, `interface DistrictHandles extends PlantHandles { contactShadow: MeshBasicMaterial }`, `buildDistrict(kit, parent, screens): DistrictHandles` (adds groups named `district`, `brewery`, `cosmetics`)

- [ ] **Step 1: Write the failing test**

Create `apps/landing/src/scripts/film/world/district.test.ts`:

```ts
import { Group, Mesh, MeshStandardMaterial } from "three";
import { describe, expect, it } from "vitest";

import { BELT, CASE_CAPACITY, PALLET_CAPACITY, QUEUE_TILES } from "../animations";
import { buildDistrict } from "./district";
import { Kit, ROLES } from "./kit";
import { blankTextureFactory, createScreenTextures } from "./textures";

const GREEN_NAMES = new Set([
  "code",
  "scanner-lamp",
  "scan-line",
  "printer-led",
  "handheld-screen",
  "mast-lamp",
  "kiosk-ok",
]);

function build() {
  const kit = new Kit();
  const root = new Group();
  const handles = buildDistrict(kit, root, createScreenTextures(blankTextureFactory));
  const meshes: Mesh[] = [];
  root.traverse((node) => {
    if (node instanceof Mesh) meshes.push(node);
  });
  return { kit, root, handles, meshes };
}

describe("film district", () => {
  it("exposes every animated part", () => {
    const { handles } = build();
    expect(handles.belt).toHaveLength(BELT.count);
    for (const slot of handles.belt) {
      expect(Object.keys(slot.products).sort()).toEqual(["bottle", "can", "jar"]);
      expect(slot.codes).toHaveLength(3);
    }
    expect(handles.caseProducts).toHaveLength(CASE_CAPACITY);
    expect(handles.palletCases).toHaveLength(PALLET_CAPACITY);
    expect(handles.queueTiles).toHaveLength(QUEUE_TILES);
    expect(handles.lampSpots).toHaveLength(4);
    expect(handles.contactShadow.transparent).toBe(true);
  });

  it("keeps green for passed codes, indicators and screens", () => {
    const { kit, meshes } = build();
    const green = meshes.filter((mesh) => mesh.material === kit.signals.verified);
    expect(green.length).toBeGreaterThan(0);
    for (const mesh of green) expect(GREEN_NAMES.has(mesh.name), mesh.name).toBe(true);
  });

  it("paints lit surfaces only from the palette", () => {
    const { meshes } = build();
    const allowed = new Set<string>([...ROLES, "label", "window"]);
    for (const mesh of meshes) {
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) {
        if (material instanceof MeshStandardMaterial) {
          expect(allowed.has(material.name), material.name).toBe(true);
        }
      }
    }
  });

  it("builds three producers and their people", () => {
    const { root } = build();
    for (const name of ["district", "plant", "brewery", "cosmetics", "kiosk", "office", "van"]) {
      expect(root.getObjectByName(name), name).toBeDefined();
    }
    let people = 0;
    root.traverse((node) => {
      if (node.name === "person") people += 1;
    });
    expect(people).toBeGreaterThanOrEqual(7);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @markiro/landing exec vitest run src/scripts/film/world/district.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement the plant**

Create `apps/landing/src/scripts/film/world/plant.ts`:

```ts
import {
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  SphereGeometry,
  type Object3D,
} from "three";

import { BELT, CASE_CAPACITY, PALLET_CAPACITY, QUEUE_TILES, type ProductKind } from "../animations";
import { person } from "./figures";
import type { Kit } from "./kit";
import { createProduct, lampFixture, openCase, pallet, rack, van } from "./props";
import type { ScreenTextures } from "./textures";

export type Vec3Tuple = readonly [number, number, number];

export const FLOOR = 0.06;
export const HALL = { x0: -6.2, x1: 3.4, z0: -3.6, z1: 2.4 } as const;
export const CONVEYOR = { x0: -5.2, x1: 0.55, z: -1.1, y: 0.78, width: 0.62 } as const;
export const BELT_TOP = CONVEYOR.y + 0.01;

const TABLE = { x: 1.55, z: -1.1, width: 1.7, depth: 1.1, height: 0.76 } as const;
const COLUMN_HEIGHT = 2.9;
const TRUSS_X = [-3.8, -1.3, 1.1] as const;
const PRODUCTS_FACE = (-30 * Math.PI) / 180;
const LAMP_SPOTS: readonly Vec3Tuple[] = [
  [-3.8, FLOOR + 2.45, -1.1],
  [-1.3, FLOOR + 2.45, -1.1],
  [1.1, FLOOR + 2.45, -1.0],
  [2.4, FLOOR + 2.45, 1.3],
];

export interface BeltSlot {
  readonly group: Group;
  readonly products: Readonly<Record<ProductKind, Group>>;
  readonly codes: readonly Mesh[];
}

export interface PlantHandles {
  readonly belt: readonly BeltSlot[];
  readonly caseProducts: readonly Object3D[];
  readonly labelTongue: Mesh;
  readonly palletCases: readonly Object3D[];
  readonly queueTiles: readonly Mesh[];
  readonly queueBase: Vec3Tuple;
  readonly mastLamp: Mesh;
  readonly monitorScreen: Mesh<PlaneGeometry, MeshBasicMaterial>;
  readonly kioskScreen: Mesh<PlaneGeometry, MeshBasicMaterial>;
  readonly windows: MeshStandardMaterial;
  readonly scanLamp: Vec3Tuple;
  readonly lampSpots: readonly Vec3Tuple[];
}

/** A cut wall: a white slab with a graphite cap, split around its openings. */
function wall(
  kit: Kit,
  parent: Object3D,
  from: readonly [number, number],
  to: readonly [number, number],
  height: number,
  gaps: readonly (readonly [number, number])[] = [],
): void {
  const thickness = 0.2;
  const alongX = Math.abs(to[1] - from[1]) < 1e-6;
  const start = alongX ? Math.min(from[0], to[0]) : Math.min(from[1], to[1]);
  const end = alongX ? Math.max(from[0], to[0]) : Math.max(from[1], to[1]);
  const segments: (readonly [number, number])[] = [];
  let cursor = start;
  for (const [gapStart, gapEnd] of [...gaps].sort((a, b) => a[0] - b[0])) {
    if (gapStart > cursor) segments.push([cursor, gapStart]);
    cursor = Math.max(cursor, gapEnd);
  }
  if (cursor < end) segments.push([cursor, end]);
  for (const [s0, s1] of segments) {
    const length = s1 - s0;
    const middle = (s0 + s1) / 2;
    const width = alongX ? length : thickness;
    const depth = alongX ? thickness : length;
    const x = alongX ? middle : from[0];
    const z = alongX ? from[1] : middle;
    kit.block(parent, width, height, depth, "wall", x, FLOOR, z, 0.02);
    kit.block(parent, width + 0.004, 0.035, depth + 0.004, "cut", x, FLOOR + height, z, 0.006, {
      castShadow: false,
    });
  }
}

function hallShell(kit: Kit, plant: Group): void {
  kit.block(plant, HALL.x1 - HALL.x0, FLOOR, HALL.z1 - HALL.z0, "floor", (HALL.x0 + HALL.x1) / 2, 0, (HALL.z0 + HALL.z1) / 2, 0.02);
  wall(kit, plant, [HALL.x0, HALL.z0], [HALL.x1, HALL.z0], 1.9);
  wall(kit, plant, [HALL.x1, HALL.z0], [HALL.x1, HALL.z1], 1.9, [[0.1, 2.25]]);
  wall(kit, plant, [HALL.x0, HALL.z0], [HALL.x0, HALL.z1], 0.42);
  wall(kit, plant, [HALL.x0, HALL.z1], [HALL.x1, HALL.z1], 0.42, [[-5.3, -4.3]]);
  const roller = kit.place(plant, new CylinderGeometry(0.16, 0.16, 2.3, 20), kit.material("steel"), HALL.x1, FLOOR + 1.72, 1.18);
  roller.rotation.x = Math.PI / 2;
  for (const x of [HALL.x0, ...TRUSS_X, HALL.x1]) {
    for (const z of [HALL.z0, HALL.z1]) {
      kit.block(plant, 0.17, COLUMN_HEIGHT, 0.17, "column", x, FLOOR, z, 0.02);
    }
  }
  for (const x of TRUSS_X) {
    kit.block(plant, 0.11, 0.13, HALL.z1 - HALL.z0, "column", x, FLOOR + COLUMN_HEIGHT - 0.13, (HALL.z0 + HALL.z1) / 2, 0.02);
  }
  for (const z of [HALL.z0, HALL.z1]) {
    kit.block(plant, HALL.x1 - HALL.x0, 0.13, 0.11, "column", (HALL.x0 + HALL.x1) / 2, FLOOR + COLUMN_HEIGHT - 0.13, z, 0.02);
  }
  for (const [x, y, z] of LAMP_SPOTS) lampFixture(kit, plant, x, y, z, FLOOR + COLUMN_HEIGHT - 0.13);
}

function line(kit: Kit, plant: Group): readonly BeltSlot[] {
  const middle = (CONVEYOR.x0 + CONVEYOR.x1) / 2;
  const length = CONVEYOR.x1 - CONVEYOR.x0;
  for (let x = CONVEYOR.x0 + 0.3; x <= CONVEYOR.x1 - 0.2; x += 1.1) {
    for (const side of [-1, 1]) {
      kit.block(plant, 0.07, CONVEYOR.y - FLOOR - 0.06, 0.07, "steel", x, FLOOR, CONVEYOR.z + side * (CONVEYOR.width / 2 - 0.06), 0.01);
    }
  }
  for (const side of [-1, 1]) {
    kit.block(plant, length, 0.12, 0.06, "steel", middle, CONVEYOR.y - 0.08, CONVEYOR.z + side * (CONVEYOR.width / 2), 0.01);
    kit.block(plant, length, 0.03, 0.03, "steel", middle, CONVEYOR.y + 0.16, CONVEYOR.z + side * 0.2, 0.01);
  }
  kit.block(plant, length, 0.05, CONVEYOR.width - 0.1, "belt", middle, CONVEYOR.y - 0.04, CONVEYOR.z, 0.02);
  for (const side of [-1, 1]) {
    kit.block(plant, 0.12, 1.28, 0.12, "graphite", BELT.archX, FLOOR, CONVEYOR.z + side * 0.46, 0.02);
  }
  kit.block(plant, 0.22, 0.16, 1.04, "graphite", BELT.archX, FLOOR + 1.26, CONVEYOR.z, 0.03);
  kit.place(plant, new SphereGeometry(0.075, 20, 14), kit.signals.verified, BELT.archX, FLOOR + 1.5, CONVEYOR.z, { castShadow: false }).name = "scanner-lamp";
  kit.block(plant, 0.03, 0.012, 0.82, kit.signals.verified, BELT.archX, FLOOR + 1.245, CONVEYOR.z, 0.004, { castShadow: false }).name = "scan-line";
  // Reject bin beside the belt, just past the arch.
  kit.block(plant, 0.62, 0.34, 0.42, "graphite", BELT.archX + 0.75, FLOOR, CONVEYOR.z + 0.62, 0.03);

  const slots: BeltSlot[] = [];
  for (let index = 0; index < BELT.count; index += 1) {
    const group = new Group();
    group.name = "belt-slot";
    group.position.set(BELT.start, BELT_TOP, CONVEYOR.z);
    group.rotation.y = PRODUCTS_FACE;
    const bottle = createProduct(kit, "bottle");
    const jar = createProduct(kit, "jar");
    const can = createProduct(kit, "can");
    group.add(bottle.group, jar.group, can.group);
    plant.add(group);
    slots.push({
      group,
      products: { bottle: bottle.group, jar: jar.group, can: can.group },
      codes: [bottle.code, jar.code, can.code],
    });
  }
  return slots;
}

function mast(kit: Kit, plant: Group, x: number, z: number): Mesh {
  kit.block(plant, 0.5, 0.08, 0.5, "steel", x, 0.02, z, 0.02);
  kit.place(plant, new CylinderGeometry(0.035, 0.07, 3.6, 12), kit.material("column"), x, 1.9, z);
  for (const y of [1.2, 2.2, 3.1]) {
    kit.place(plant, new CylinderGeometry(0.16, 0.16, 0.03, 16), kit.material("steel"), x, y, z);
  }
  const dish = kit.place(plant, new SphereGeometry(0.22, 20, 12), kit.material("column"), x + 0.12, 3.35, z);
  dish.scale.set(1, 0.35, 1);
  dish.rotation.z = -1.1;
  const lamp = kit.place(plant, new SphereGeometry(0.075, 16, 12), kit.signals.verified, x, 3.78, z, {
    castShadow: false,
  });
  lamp.name = "mast-lamp";
  return lamp;
}

function checkpoint(
  kit: Kit,
  plant: Group,
  screens: ScreenTextures,
  x: number,
  z: number,
): Mesh<PlaneGeometry, MeshBasicMaterial> {
  const kiosk = new Group();
  kiosk.name = "kiosk";
  kiosk.position.set(x, 0.02, z);
  kiosk.rotation.y = 0.35;
  kit.block(kiosk, 0.62, 0.05, 0.5, "steel", 0, 0, 0, 0.02);
  kit.block(kiosk, 0.5, 1.32, 0.34, "plaster", 0, 0.05, -0.02, 0.05);
  const head = new Group();
  head.position.set(0, 1.28, 0.02);
  head.rotation.x = -0.35;
  kit.block(head, 0.56, 0.72, 0.07, "graphite", 0, 0, 0, 0.02);
  const screen = new Mesh(new PlaneGeometry(0.46, 0.64), new MeshBasicMaterial({ map: screens.kiosk(false, 0) }));
  screen.name = "kiosk-screen";
  screen.position.set(0, 0.36, 0.036);
  head.add(screen);
  kiosk.add(head);
  kit.block(kiosk, 0.22, 0.1, 0.06, "graphite", 0, 0.92, 0.17, 0.015);
  kit.place(kiosk, new PlaneGeometry(0.14, 0.04), kit.signals.verified, 0, 0.97, 0.2, { castShadow: false }).name = "kiosk-ok";
  plant.add(kiosk);
  kit.block(plant, 1.9, 0.06, 1.3, "column", x + 0.1, 2.35, z - 0.1, 0.02);
  for (const [dx, dz] of [
    [-0.85, 0.5],
    [0.95, 0.5],
  ] as const) {
    kit.block(plant, 0.07, 2.33, 0.07, "column", x + dx, 0.02, z + dz, 0.01);
  }
  person(kit, plant, x + 0.25, z + 0.7, Math.atan2(-0.25, -0.7), "badge");
  return screen;
}

function office(kit: Kit, plant: Group, x: number, z: number, windows: MeshStandardMaterial): void {
  const group = new Group();
  group.name = "office";
  const width = 3.0;
  const depth = 2.2;
  const floorHeight = 1.15;
  for (let floor = 0; floor < 2; floor += 1) {
    const y = 0.02 + floor * floorHeight;
    kit.block(group, width, 0.14, depth, "wall", x, y, z, 0.02);
    for (const [dx, dz] of [
      [-width / 2 + 0.08, -depth / 2 + 0.08],
      [width / 2 - 0.08, -depth / 2 + 0.08],
      [-width / 2 + 0.08, depth / 2 - 0.08],
      [width / 2 - 0.08, depth / 2 - 0.08],
    ] as const) {
      kit.block(group, 0.14, floorHeight - 0.14, 0.14, "wall", x + dx, y + 0.14, z + dz, 0.02);
    }
    kit.block(group, width - 0.24, floorHeight - 0.44, 0.03, windows, x, y + 0.3, z + depth / 2 - 0.05, 0.005, { castShadow: false });
    kit.block(group, 0.03, floorHeight - 0.44, depth - 0.24, windows, x - width / 2 + 0.05, y + 0.3, z, 0.005, { castShadow: false });
    kit.block(group, width - 0.12, 0.16, 0.05, "wall", x, y + floorHeight - 0.16, z + depth / 2 - 0.02, 0.01);
    for (let k = 1; k < 6; k += 1) {
      kit.block(group, 0.05, floorHeight - 0.44, 0.05, "wall", x - width / 2 + k * (width / 6), y + 0.3, z + depth / 2 - 0.03, 0.01);
    }
    for (let k = 1; k < 4; k += 1) {
      kit.block(group, 0.05, floorHeight - 0.44, 0.05, "wall", x - width / 2 + 0.03, y + 0.3, z - depth / 2 + k * (depth / 4), 0.01);
    }
  }
  kit.block(group, width + 0.1, 0.16, depth + 0.1, "wall", x, 0.02 + 2 * floorHeight, z, 0.03);
  kit.block(group, width + 0.1, 0.035, depth + 0.1, "cut", x, 0.18 + 2 * floorHeight, z, 0.006, { castShadow: false });
  plant.add(group);
}

export function buildPlant(kit: Kit, parent: Object3D, screens: ScreenTextures): PlantHandles {
  const plant = new Group();
  plant.name = "plant";
  parent.add(plant);
  const label = new MeshStandardMaterial({ map: screens.label, roughness: 0.8 });
  label.name = "label";

  hallShell(kit, plant);
  const belt = line(kit, plant);

  kit.block(plant, TABLE.width, 0.05, TABLE.depth, "plaster", TABLE.x, TABLE.height - 0.05, TABLE.z, 0.02);
  for (const [dx, dz] of [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ] as const) {
    kit.block(plant, 0.06, TABLE.height - 0.05 - FLOOR, 0.06, "steel", TABLE.x + dx * (TABLE.width / 2 - 0.08), FLOOR, TABLE.z + dz * (TABLE.depth / 2 - 0.08), 0.01);
  }
  const packing = openCase(kit, plant, TABLE.x + 0.02, TABLE.height, TABLE.z + 0.08, CASE_CAPACITY);
  kit.block(plant, 0.36, 0.26, 0.32, "graphite", TABLE.x + 0.6, TABLE.height, TABLE.z - 0.28, 0.04);
  const labelTongue = kit.place(plant, new PlaneGeometry(0.17, 0.13), label, TABLE.x + 0.6, TABLE.height + 0.2, TABLE.z - 0.08, { castShadow: false });
  labelTongue.rotation.x = -0.9;
  labelTongue.name = "label-tongue";
  kit.place(plant, new SphereGeometry(0.02, 10, 8), kit.signals.verified, TABLE.x + 0.72, TABLE.height + 0.265, TABLE.z - 0.14, { castShadow: false }).name = "printer-led";

  const monitor = new Group();
  monitor.position.set(TABLE.x - 0.55, TABLE.height, TABLE.z - 0.34);
  monitor.rotation.y = 0.35;
  kit.block(monitor, 0.07, 0.34, 0.07, "graphite", 0, 0, 0, 0.01);
  kit.block(monitor, 0.66, 0.44, 0.045, "graphite", 0, 0.3, 0, 0.02);
  const monitorScreen = new Mesh(new PlaneGeometry(0.6, 0.375), new MeshBasicMaterial({ map: screens.station(false) }));
  monitorScreen.name = "monitor-screen";
  monitorScreen.position.set(0, 0.52, 0.024);
  monitor.add(monitorScreen);
  plant.add(monitor);

  // Offline operations stack up above the hall and fly away once synced.
  const queueBase: Vec3Tuple = [0.3, 1.95, -1.6];
  const queueTiles: Mesh[] = [];
  for (let index = 0; index < QUEUE_TILES; index += 1) {
    const tile = kit.block(plant, 0.9, 0.08, 0.6, "graphite", queueBase[0], queueBase[1] + index * 0.14, queueBase[2], 0.02, { castShadow: false });
    tile.name = "queue-tile";
    tile.visible = false;
    queueTiles.push(tile);
  }

  const loaded = pallet(kit, plant, 2.45, FLOOR, 1.2, PALLET_CAPACITY, label);
  rack(kit, plant, -5.9, HALL.z0);
  rack(kit, plant, -4.05, HALL.z0);

  person(kit, plant, TABLE.x + 0.02, TABLE.z + 0.86, Math.PI, "work");
  person(kit, plant, CONVEYOR.x0 + 0.45, CONVEYOR.z + 0.72, Math.PI - 0.15, "work");
  person(kit, plant, 2.05, 2.05, Math.atan2(2.45 - 2.05, 1.2 - 2.05), "device");
  person(kit, plant, -4.35, 0.75, Math.PI / 2 - 0.35, "walk");

  const mastLamp = mast(kit, plant, 4.3, -3.9);
  const kioskScreen = checkpoint(kit, plant, screens, -4.75, 3.05);
  const windows = new MeshStandardMaterial({
    color: kit.colorOf("glass"),
    emissive: "#f2d2a6",
    emissiveIntensity: 0,
    roughness: 0.25,
  });
  windows.name = "window";
  office(kit, plant, 6.2, -2.75, windows);
  van(kit, plant, 5.3, 1.25, label);

  return {
    belt,
    caseProducts: packing.products,
    labelTongue,
    palletCases: loaded.cases,
    queueTiles,
    queueBase,
    mastLamp,
    monitorScreen,
    kioskScreen,
    windows,
    scanLamp: [BELT.archX, FLOOR + 1.1, CONVEYOR.z],
    lampSpots: LAMP_SPOTS,
  };
}
```

- [ ] **Step 4: Implement the district**

Create `apps/landing/src/scripts/film/world/district.ts`:

```ts
import {
  ConeGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  type Object3D,
} from "three";

import { person } from "./figures";
import type { Kit } from "./kit";
import { buildPlant, type PlantHandles } from "./plant";
import { tree } from "./props";
import type { ScreenTextures } from "./textures";

export const DISTRICT = { width: 36, depth: 24 } as const;

export interface DistrictHandles extends PlantHandles {
  readonly contactShadow: MeshBasicMaterial;
}

const TREES: readonly (readonly [number, number, number])[] = [
  [-16.2, -10.2, 0.9],
  [-16.4, -2.2, 0.8],
  [-16.1, 4.2, 1.0],
  [-8.2, -10.6, 0.8],
  [-7.8, 4.0, 0.9],
  [-7.2, 8.6, 0.8],
  [-2.2, 8.8, 0.9],
  [2.6, 8.7, 0.8],
  [7.4, 8.9, 1.0],
  [15.9, 8.5, 0.9],
  [16.2, 1.8, 0.8],
  [16.3, -10.4, 0.9],
  [8.4, -10.6, 0.8],
  [0.4, -8.6, 0.9],
  [-3.4, -8.9, 0.8],
  [3.8, -9.2, 1.0],
];

function road(
  kit: Kit,
  parent: Object3D,
  from: readonly [number, number],
  to: readonly [number, number],
): void {
  const alongX = Math.abs(to[1] - from[1]) < 1e-6;
  const width = 1.8;
  const length = alongX ? Math.abs(to[0] - from[0]) : Math.abs(to[1] - from[1]);
  const x = (from[0] + to[0]) / 2;
  const z = (from[1] + to[1]) / 2;
  kit.block(parent, alongX ? length : width, 0.015, alongX ? width : length, "road", x, 0, z, 0.006, {
    castShadow: false,
  });
  if (!alongX) return;
  for (let dx = -length / 2 + 0.6; dx < length / 2 - 0.3; dx += 1.2) {
    kit.block(parent, 0.55, 0.008, 0.06, "marking", x + dx, 0.015, z, 0.003, { castShadow: false });
  }
}

function brewery(kit: Kit, parent: Object3D, x: number, z: number): void {
  const group = new Group();
  group.name = "brewery";
  group.position.set(x, 0, z);
  kit.block(group, 5.2, 0.05, 6.6, "yard", 0, 0, 0.6, 0.02, { castShadow: false });
  kit.block(group, 5, 2.6, 3.4, "wall", 0, 0.02, -1.2, 0.04);
  kit.block(group, 5.04, 0.04, 3.44, "cut", 0, 2.62, -1.2, 0.01, { castShadow: false });
  kit.block(group, 1.4, 1.5, 0.08, "graphite", 1.3, 0.02, 0.52, 0.01);
  const tank = new CylinderGeometry(0.72, 0.72, 2.8, 28);
  const top = new ConeGeometry(0.72, 0.55, 28);
  for (const tx of [-1.8, -0.6, 0.6, 1.8]) {
    kit.block(group, 1.1, 0.5, 1.1, "steel", tx, 0.02, 2.1, 0.05);
    kit.place(group, tank, kit.material("tank"), tx, 1.92, 2.1);
    kit.place(group, top, kit.material("tank"), tx, 3.595, 2.1);
  }
  kit.block(group, 4.2, 0.08, 0.08, "steel", 0, 3.0, 2.1, 0.01);
  parent.add(group);
}

function cosmetics(kit: Kit, parent: Object3D, x: number, z: number): void {
  const group = new Group();
  group.name = "cosmetics";
  group.position.set(x, 0, z);
  kit.block(group, 6.8, 0.05, 5.6, "yard", 0, 0, 0.4, 0.02, { castShadow: false });
  kit.block(group, 6.4, 1.8, 3.4, "wall", 0, 0.02, -0.6, 0.04);
  for (let bay = 0; bay < 4; bay += 1) {
    kit.block(group, 1.6, 0.05, 3.4, "roof", -2.4 + bay * 1.6, 2.1, -0.6, 0.01).rotation.z = 0.42;
    kit.block(group, 0.04, 0.62, 3.3, "glass", -1.65 + bay * 1.6, 1.82, -0.6, 0.005);
  }
  kit.block(group, 1.6, 0.9, 0.9, "card", 2.2, 0.02, 1.7, 0.03);
  kit.block(group, 1.2, 1.2, 0.08, "graphite", -1.6, 0.02, 1.12, 0.01);
  parent.add(group);
}

export function buildDistrict(kit: Kit, parent: Object3D, screens: ScreenTextures): DistrictHandles {
  const district = new Group();
  district.name = "district";
  parent.add(district);
  kit.block(district, DISTRICT.width, 0.5, DISTRICT.depth, "base", 0, -0.5, 0, 0.16);
  const contactShadow = new MeshBasicMaterial({
    color: "#000000",
    alphaMap: screens.contactShadow,
    transparent: true,
    opacity: 0.24,
    depthWrite: false,
  });
  const shadow = new Mesh(new PlaneGeometry(DISTRICT.width * 1.3, DISTRICT.depth * 1.55), contactShadow);
  shadow.name = "contact-shadow";
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.set(0.7, -0.95, 0.6);
  district.add(shadow);

  kit.block(district, 4.6, 0.02, 9.2, "yard", 5.7, 0, 0, 0.01, { castShadow: false });
  for (const z of [0.35, 2.15]) {
    for (let x = 4.1; x < 7.6; x += 0.6) {
      kit.block(district, 0.34, 0.012, 0.05, "marking", x, 0.02, z, 0.004, { castShadow: false });
    }
  }
  road(kit, district, [-17, 6.4], [17, 6.4]);
  road(kit, district, [5.7, 4.6], [5.7, 6.4]);
  road(kit, district, [-12.5, -3.2], [-12.5, 6.4]);
  road(kit, district, [12.5, -3.4], [12.5, 6.4]);
  brewery(kit, district, -12.5, -6.2);
  cosmetics(kit, district, 12.5, -6.4);
  for (const [x, z, scale] of TREES) tree(kit, district, x, z, scale);
  person(kit, district, -10.4, 1.2, Math.PI / 2, "walk", 0);
  person(kit, district, 10.8, 0.4, -Math.PI / 2 + 0.3, "walk", 0);
  return { ...buildPlant(kit, district, screens), contactShadow };
}
```

- [ ] **Step 5: Run the tests, typecheck and lint**

Run:
```bash
pnpm --filter @markiro/landing exec vitest run src/scripts/film/world/district.test.ts src/scripts/film/world/kit.test.ts
pnpm --filter @markiro/landing typecheck
pnpm --filter @markiro/landing lint
```
Expected: tests pass; no type or lint errors.

- [ ] **Step 6: Commit**

```bash
git add apps/landing/src/scripts/film/world/plant.ts apps/landing/src/scripts/film/world/district.ts apps/landing/src/scripts/film/world/district.test.ts
git commit -m "feat(landing): film district with the line hall, kiosk and office" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Lights, animation wiring, stage and the world runtime

**Files:**
- Create: `apps/landing/src/scripts/film/world/rig.ts`, `apply.ts`, `stage.ts`, `runtime.ts` (all in `world/`)
- Test: `apps/landing/src/scripts/film/world/apply.test.ts`

**Interfaces:**
- Consumes: Tasks 3 to 9.
- Produces:
  - `rig.ts`: `interface LightRig { root: Group; apply(state: LightingState): void }`, `createLightRig(handles: PlantHandles, shadowMapSize: number): LightRig`
  - `apply.ts`: `applyAnimation(handles: PlantHandles, kit: Kit, screens: ScreenTextures, state: FilmAnimationState, dark: boolean, lamps: number): void`
  - `stage.ts`: `interface Stage { scene: Scene; resize(width, height, devicePixelRatio): void; render(pose: CameraPose, lighting: LightingState): void; dispose(): void }`, `createStage(canvas, settings: TierSettings): Stage`
  - `runtime.ts`: `FILM_CHAPTERS = 7`, `interface WorldHandle { render(filmTime: number): void; resize(width: number, height: number, devicePixelRatio: number): void; dispose(): void }`, `startWorld(canvas: HTMLCanvasElement, tier: QualityTier, textures?: TextureFactory): WorldHandle`

- [ ] **Step 1: Write the failing test**

Create `apps/landing/src/scripts/film/world/apply.test.ts`:

```ts
import { Group, PointLight } from "three";
import { describe, expect, it } from "vitest";

import { animationAt, type FilmAnimationState } from "../animations";
import { lightingAt } from "../lighting";
import { applyAnimation } from "./apply";
import { buildDistrict } from "./district";
import { Kit } from "./kit";
import { createLightRig } from "./rig";
import { blankTextureFactory, createScreenTextures } from "./textures";

function setup() {
  const kit = new Kit();
  const screens = createScreenTextures(blankTextureFactory);
  const handles = buildDistrict(kit, new Group(), screens);
  return { kit, screens, handles };
}

const state = (overrides: Partial<FilmAnimationState>): FilmAnimationState => ({
  ...animationAt(0),
  ...overrides,
});

describe("applying film state to the scene", () => {
  it("shows as many case products and pallet cases as the state asks for", () => {
    const { kit, screens, handles } = setup();
    applyAnimation(handles, kit, screens, state({ caseFill: 3, palletCases: 5 }), false, 0);
    expect(handles.caseProducts.filter((product) => product.visible)).toHaveLength(3);
    expect(handles.palletCases.filter((item) => item.visible)).toHaveLength(5);
  });

  it("stacks the offline queue and hides it once it is flushed", () => {
    const { kit, screens, handles } = setup();
    applyAnimation(handles, kit, screens, state({ queueCount: 5, queueFlush: 0, networkOnline: false }), false, 0);
    expect(handles.queueTiles.filter((tile) => tile.visible)).toHaveLength(5);
    expect(handles.mastLamp.material).toBe(kit.signals.offline);
    applyAnimation(handles, kit, screens, state({ queueCount: 12, queueFlush: 1, networkOnline: true }), false, 0);
    expect(handles.queueTiles.filter((tile) => tile.visible)).toHaveLength(0);
    expect(handles.mastLamp.material).toBe(kit.signals.verified);
  });

  it("shows one product kind per belt slot and paints its code", () => {
    const { kit, screens, handles } = setup();
    const film = animationAt(1.7);
    applyAnimation(handles, kit, screens, film, false, 0);
    film.belt.forEach((item, index) => {
      const slot = handles.belt[index];
      expect(slot?.products[item.kind].visible).toBe(true);
      const expected =
        item.code === "verified"
          ? kit.signals.verified
          : item.code === "rejected"
            ? kit.signals.rejected
            : kit.material("codeIdle");
      expect(slot?.codes.every((code) => code.material === expected)).toBe(true);
    });
  });

  it("switches screens to the dark interface at night", () => {
    const { kit, screens, handles } = setup();
    applyAnimation(handles, kit, screens, state({ kioskStep: 2 }), true, 1);
    expect(handles.monitorScreen.material.map).toBe(screens.station(true));
    expect(handles.kioskScreen.material.map).toBe(screens.kiosk(true, 2));
  });

  it("turns the interior lamps on only after dusk", () => {
    const { handles } = setup();
    const rig = createLightRig(handles, 1024);
    const lamps = () => {
      const found: PointLight[] = [];
      rig.root.traverse((node) => {
        if (node instanceof PointLight) found.push(node);
      });
      return found;
    };
    rig.apply(lightingAt(0));
    expect(lamps().every((lamp) => lamp.intensity === 0)).toBe(true);
    rig.apply(lightingAt(1));
    expect(lamps().some((lamp) => lamp.intensity > 0)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @markiro/landing exec vitest run src/scripts/film/world/apply.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement the rig and the animation wiring**

Create `apps/landing/src/scripts/film/world/rig.ts`:

```ts
import { DirectionalLight, Group, HemisphereLight, PointLight } from "three";

import type { LightingState } from "../lighting";
import type { PlantHandles } from "./plant";

export interface LightRig {
  readonly root: Group;
  apply(state: LightingState): void;
}

export function createLightRig(handles: PlantHandles, shadowMapSize: number): LightRig {
  const root = new Group();
  root.name = "lights";
  const sky = new HemisphereLight("#ffffff", "#cfcac0", 1.1);
  const sun = new DirectionalLight("#ffffff", 2.7);
  sun.castShadow = true;
  sun.shadow.mapSize.set(shadowMapSize, shadowMapSize);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.025;
  sun.shadow.radius = 4;
  const shadowCamera = sun.shadow.camera;
  shadowCamera.left = -22;
  shadowCamera.right = 22;
  shadowCamera.top = 22;
  shadowCamera.bottom = -22;
  shadowCamera.near = 1;
  shadowCamera.far = 80;
  shadowCamera.updateProjectionMatrix();
  const fill = new DirectionalLight("#ffffff", 0.3);
  fill.position.set(11, 7, 12);
  root.add(sky, sun, sun.target, fill);
  // Point lights never cast shadows: one shadow map per lamp would cost more than the film.
  const lamps = handles.lampSpots.map(([x, y, z]) => {
    const lamp = new PointLight("#ffd7a3", 0, 7.5, 1.7);
    lamp.position.set(x, y - 0.15, z);
    root.add(lamp);
    return lamp;
  });
  const [sx, sy, sz] = handles.scanLamp;
  const scanGlow = new PointLight("#3ddc7a", 0, 2.6, 1.6);
  scanGlow.position.set(sx, sy, sz);
  const office = new PointLight("#ffd9a8", 0, 5, 1.6);
  office.position.set(6.2, 1.6, -1.2);
  root.add(scanGlow, office);
  return {
    root,
    apply(state) {
      sky.color.set(state.skyColor);
      sky.groundColor.set(state.groundColor);
      sky.intensity = state.skyIntensity;
      sun.color.set(state.sunColor);
      sun.intensity = state.sunIntensity;
      const [px, py, pz] = state.sunPosition;
      sun.position.set(px * 1.4, py * 1.4, pz * 1.4);
      fill.intensity = state.fillIntensity;
      for (const lamp of lamps) lamp.intensity = 7.5 * state.lamps;
      scanGlow.intensity = 1.6 * state.glow;
      office.intensity = 2.5 * state.lamps;
    },
  };
}
```

Create `apps/landing/src/scripts/film/world/apply.ts`:

```ts
import type { Material, MeshBasicMaterial, Texture } from "three";

import { PRODUCT_KINDS, type FilmAnimationState } from "../animations";
import type { Kit } from "./kit";
import { BELT_TOP, CONVEYOR, type PlantHandles } from "./plant";
import type { ScreenTextures } from "./textures";

const QUEUE_STEP = 0.14;

function setMap(material: MeshBasicMaterial, texture: Texture): void {
  if (material.map !== texture) material.map = texture;
}

export function applyAnimation(
  handles: PlantHandles,
  kit: Kit,
  screens: ScreenTextures,
  state: FilmAnimationState,
  dark: boolean,
  lamps: number,
): void {
  state.belt.forEach((item, index) => {
    const slot = handles.belt[index];
    if (slot === undefined) return;
    slot.group.visible = item.visible;
    slot.group.position.set(item.x, BELT_TOP - item.aside * 0.3, CONVEYOR.z + item.aside * 0.62);
    for (const kind of PRODUCT_KINDS) slot.products[kind].visible = kind === item.kind;
    const material: Material =
      item.code === "verified"
        ? kit.signals.verified
        : item.code === "rejected"
          ? kit.signals.rejected
          : kit.material("codeIdle");
    for (const code of slot.codes) code.material = material;
  });
  handles.caseProducts.forEach((product, index) => {
    product.visible = index < state.caseFill;
  });
  handles.labelTongue.visible = state.labelOut > 0.001;
  handles.labelTongue.scale.set(1, Math.max(0.001, state.labelOut), 1);
  handles.palletCases.forEach((item, index) => {
    item.visible = index < state.palletCases;
  });
  const [qx, qy, qz] = handles.queueBase;
  handles.queueTiles.forEach((tile, index) => {
    tile.visible = index < state.queueCount && state.queueFlush < 1;
    tile.position.set(qx, qy + 0.04 + index * QUEUE_STEP + state.queueFlush * (7 + index * 0.45), qz);
    tile.material = state.queueFlush > 0 ? kit.signals.verified : kit.material("graphite");
  });
  handles.mastLamp.material = state.networkOnline ? kit.signals.verified : kit.signals.offline;
  setMap(handles.monitorScreen.material, screens.station(dark));
  setMap(handles.kioskScreen.material, screens.kiosk(dark, state.kioskStep));
  handles.windows.color.set(kit.colorOf("glass"));
  handles.windows.emissiveIntensity = 1.4 * lamps * (0.35 + 0.65 * state.officeLights);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @markiro/landing exec vitest run src/scripts/film/world/apply.test.ts`
Expected: PASS.

- [ ] **Step 5: Implement the stage and the runtime**

Create `apps/landing/src/scripts/film/world/stage.ts`:

```ts
import {
  Color,
  HalfFloatType,
  NoToneMapping,
  PCFShadowMap,
  PerspectiveCamera,
  Scene,
  Vector2,
  WebGLRenderer,
  WebGLRenderTarget,
} from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { GTAOPass } from "three/addons/postprocessing/GTAOPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { HorizontalTiltShiftShader } from "three/addons/shaders/HorizontalTiltShiftShader.js";
import { VerticalTiltShiftShader } from "three/addons/shaders/VerticalTiltShiftShader.js";

import type { CameraPose } from "../camera-path";
import type { LightingState } from "../lighting";
import type { TierSettings } from "../quality";

export interface Stage {
  readonly scene: Scene;
  resize(width: number, height: number, devicePixelRatio: number): void;
  render(pose: CameraPose, lighting: LightingState): void;
  dispose(): void;
}

const TILT_PIXELS = 3;
const TILT_FOCUS = 0.5;

function setUniform(pass: ShaderPass | null, name: string, value: number): void {
  const uniform = pass?.uniforms[name];
  if (uniform !== undefined) uniform.value = value;
}

export function createStage(canvas: HTMLCanvasElement, settings: TierSettings): Stage {
  const renderer = new WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance" });
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFShadowMap;
  // Tone mapping stays off so the canvas background equals the CSS background.
  renderer.toneMapping = NoToneMapping;
  const scene = new Scene();
  const background = new Color("#fafaf8");
  scene.background = background;
  const camera = new PerspectiveCamera(20, 1, 0.5, 400);
  const target = new WebGLRenderTarget(1, 1, {
    type: HalfFloatType,
    samples: settings.antialiasSamples,
  });
  const composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));
  const ambient = settings.ambientOcclusion ? new GTAOPass(scene, camera, 1, 1) : null;
  if (ambient !== null) {
    ambient.updateGtaoMaterial({ radius: 0.55, distanceExponent: 1.4, thickness: 1.3, scale: 1.5, samples: 16 });
    ambient.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 5, rings: 2, samples: 16 });
    composer.addPass(ambient);
  }
  const bloom = settings.bloom ? new UnrealBloomPass(new Vector2(1, 1), 0, 0.55, 0.8) : null;
  if (bloom !== null) composer.addPass(bloom);
  const tiltH = settings.tiltShift ? new ShaderPass(HorizontalTiltShiftShader) : null;
  const tiltV = settings.tiltShift ? new ShaderPass(VerticalTiltShiftShader) : null;
  if (tiltH !== null && tiltV !== null) {
    composer.addPass(tiltH);
    composer.addPass(tiltV);
    setUniform(tiltH, "r", TILT_FOCUS);
    setUniform(tiltV, "r", TILT_FOCUS);
  }
  composer.addPass(new OutputPass());
  let width = 1;
  let height = 1;
  return {
    scene,
    resize(nextWidth, nextHeight, devicePixelRatio) {
      width = Math.max(1, nextWidth);
      height = Math.max(1, nextHeight);
      const ratio = Math.min(devicePixelRatio, settings.pixelRatioCap);
      renderer.setPixelRatio(ratio);
      renderer.setSize(width, height, false);
      composer.setPixelRatio(ratio);
      composer.setSize(width, height);
      setUniform(tiltH, "h", TILT_PIXELS / (width * ratio));
      setUniform(tiltV, "v", TILT_PIXELS / (height * ratio));
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    },
    render(pose, lighting) {
      camera.fov = pose.fov;
      camera.position.set(pose.position[0], pose.position[1], pose.position[2]);
      camera.lookAt(pose.target[0], pose.target[1], pose.target[2]);
      // Lens shift: the target lands at `shift` in normalised device units.
      // setViewOffset also refreshes the projection matrix after the fov change.
      const shift = width >= height ? pose.shiftWide : pose.shiftTall;
      camera.setViewOffset(width, height, (-shift[0] * width) / 2, (shift[1] * height) / 2, width, height);
      background.set(lighting.background);
      if (ambient !== null) ambient.blendIntensity = lighting.ambientOcclusion;
      if (bloom !== null) bloom.strength = lighting.bloom;
      composer.render();
    },
    dispose() {
      composer.dispose();
      target.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}
```

Create `apps/landing/src/scripts/film/world/runtime.ts`:

```ts
import { animationAt } from "../animations";
import { CAMERA_KEYS } from "../camera-keys";
import { poseAt } from "../camera-path";
import { lightingAt, timeOfDayAt } from "../lighting";
import { TIER_SETTINGS, type QualityTier } from "../quality";
import { cameraTime } from "../timeline";
import { applyAnimation } from "./apply";
import { buildDistrict } from "./district";
import { Kit } from "./kit";
import { createLightRig } from "./rig";
import { createStage } from "./stage";
import { canvasTextureFactory, createScreenTextures, type TextureFactory } from "./textures";

export const FILM_CHAPTERS = 7;

export interface WorldHandle {
  render(filmTime: number): void;
  resize(width: number, height: number, devicePixelRatio: number): void;
  dispose(): void;
}

export function startWorld(
  canvas: HTMLCanvasElement,
  tier: QualityTier,
  textures: TextureFactory = canvasTextureFactory,
): WorldHandle {
  const settings = TIER_SETTINGS[tier];
  const stage = createStage(canvas, settings);
  const kit = new Kit();
  const screens = createScreenTextures(textures);
  const handles = buildDistrict(kit, stage.scene, screens);
  const rig = createLightRig(handles, settings.shadowMapSize);
  stage.scene.add(rig.root);
  return {
    render(filmTime) {
      const lighting = lightingAt(timeOfDayAt(filmTime));
      kit.setNightMix(lighting.materialNight);
      kit.signals.setGlow(lighting.glow, lighting.lamps);
      rig.apply(lighting);
      handles.contactShadow.opacity = lighting.contactShadow;
      applyAnimation(handles, kit, screens, animationAt(filmTime), lighting.uiTheme === "dark", lighting.lamps);
      stage.render(poseAt(CAMERA_KEYS, cameraTime(filmTime, FILM_CHAPTERS)), lighting);
    },
    resize(width, height, devicePixelRatio) {
      stage.resize(width, height, devicePixelRatio);
    },
    dispose() {
      stage.dispose();
    },
  };
}
```

- [ ] **Step 6: Typecheck, lint and run the world tests**

Run:
```bash
pnpm --filter @markiro/landing typecheck
pnpm --filter @markiro/landing lint
pnpm --filter @markiro/landing exec vitest run src/scripts/film/world
```
Expected: no errors; all world tests pass. The GTAO, bloom and tilt-shift calls match the three 0.186.0 addon sources that the prototype (`output/scroll-world/lab/sample/scene.js`) already uses; if `@types/three` disagrees, follow the typings.

- [ ] **Step 7: Commit**

```bash
git add apps/landing/src/scripts/film/world/rig.ts apps/landing/src/scripts/film/world/apply.ts apps/landing/src/scripts/film/world/stage.ts apps/landing/src/scripts/film/world/runtime.ts apps/landing/src/scripts/film/world/apply.test.ts
git commit -m "feat(landing): film lights, stage and world runtime" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: The entry script

**Files:**
- Create: `apps/landing/src/scripts/film/film.ts`
- Test: `apps/landing/src/scripts/film/film.test.ts`

**Interfaces:**
- Consumes: `filmTimeFromLayout`, `chapterAt`, `type SectionBox` (Task 3), `lightingAt`, `timeOfDayAt` (Task 4), `chooseTier`, `createFrameBudget`, `QUALITY_TIERS`, `type QualityTier` (Task 7), `type WorldHandle` (Task 10, type-only import, so three stays out of the entry bundle).
- Produces: `interface FilmRuntime { reducedMotion; webgl; tier; frameBudget; viewportHeight(): number; devicePixelRatio(): number; requestFrame(callback: (now: number) => void): void; listen(type: "scroll" | "resize", listener: () => void): () => void; onFirstInteraction(listener: () => void): () => void; loadWorld(canvas, tier): Promise<WorldHandle> }`, `initFilm(root: Document, runtime: FilmRuntime): () => void`, `browserFilmRuntime(window): FilmRuntime`.
- DOM contract used by Task 12: `[data-film]` (gets `data-theme`, `data-chapter`, `data-film-time`, class `film--live`), `[data-film-chrome]` elements outside the film (get `data-theme`), `[data-film-canvas]`, `[data-film-chapter]` sections in order, `[data-film-rail]` (class `is-visible` from chapter 2 on) with one link per chapter (`aria-current="step"` on the current one).
- URL switches for poster renders: `?film-tier=high|mid|low` pins the tier; `?film-budget=off` keeps slow software-rendered frames live.

- [ ] **Step 1: Write the failing test**

Create `apps/landing/src/scripts/film/film.test.ts`:

```ts
// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import { initFilm, type FilmRuntime } from "./film";
import type { WorldHandle } from "./world/runtime";

const VIEWPORT = 1000;
const SPANS = [2.6, 1.3, 1.3, 1.35, 1.45, 1.35, 1.6];
const TOTAL_SCROLL = SPANS.reduce((sum, span) => sum + span * VIEWPORT, 0) - VIEWPORT;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function mountFilm() {
  document.body.innerHTML = `
    <div data-film-chrome data-theme="light"></div>
    <div data-film data-theme="light">
      <canvas data-film-canvas></canvas>
      ${SPANS.map((_, index) => `<section data-film-chapter id="c${index}"></section>`).join("")}
      <nav data-film-rail>${SPANS.map((_, index) => `<a href="#c${index}">${index}</a>`).join("")}</nav>
    </div>`;
  let scrollY = 0;
  let start = 0;
  for (const [index, section] of [...document.querySelectorAll<HTMLElement>("[data-film-chapter]")].entries()) {
    const top = start;
    const height = (SPANS[index] ?? 0) * VIEWPORT;
    section.getBoundingClientRect = () => ({ top: top - scrollY, height }) as DOMRect;
    start += height;
  }
  return {
    film: document.querySelector("[data-film]") as HTMLElement,
    chrome: document.querySelector("[data-film-chrome]") as HTMLElement,
    scrollTo: (y: number) => {
      scrollY = y;
    },
  };
}

function fakeRuntime(overrides: Partial<FilmRuntime> = {}) {
  const frames: ((now: number) => void)[] = [];
  const listeners = new Map<string, () => void>();
  let interaction: (() => void) | null = null;
  let clock = 0;
  const renders: number[] = [];
  const world = {
    render: (time: number) => {
      renders.push(time);
    },
    resize: vi.fn(),
    dispose: vi.fn(),
  } satisfies WorldHandle;
  const loadWorld = vi.fn(() => Promise.resolve<WorldHandle>(world));
  const runtime: FilmRuntime = {
    reducedMotion: false,
    webgl: true,
    tier: "high",
    frameBudget: true,
    viewportHeight: () => VIEWPORT,
    devicePixelRatio: () => 1,
    requestFrame: (callback) => {
      frames.push(callback);
    },
    listen: (type, listener) => {
      listeners.set(type, listener);
      return () => {
        listeners.delete(type);
      };
    },
    onFirstInteraction: (listener) => {
      interaction = listener;
      return () => {
        interaction = null;
      };
    },
    loadWorld,
    ...overrides,
  };
  return {
    runtime,
    world,
    renders,
    loadWorld,
    flush(stepMs = 16) {
      while (frames.length > 0) {
        clock += stepMs;
        frames.shift()?.(clock);
      }
    },
    scroll: () => listeners.get("scroll")?.(),
    interact: () => interaction?.(),
  };
}

/** Thirty scroll steps, each rendered frame taking 120 ms. */
function scrollSlowly(fake: ReturnType<typeof fakeRuntime>, scrollTo: (y: number) => void): void {
  for (let step = 1; step <= 30; step += 1) {
    scrollTo(step * 40);
    fake.scroll();
    fake.flush(120);
  }
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("film entry script", () => {
  it("loads the world only after the first interaction and renders film time", async () => {
    const { film, scrollTo } = mountFilm();
    const fake = fakeRuntime();
    initFilm(document, fake.runtime);
    fake.flush();
    expect(fake.loadWorld).not.toHaveBeenCalled();
    fake.interact();
    await settle();
    fake.flush();
    expect(film.classList.contains("film--live")).toBe(true);
    expect(fake.renders.at(-1)).toBe(0);
    scrollTo(800);
    fake.scroll();
    fake.flush();
    expect(fake.renders.at(-1)).toBeCloseTo(0.5);
    expect(film.dataset.filmTime).toBe("0.500");
  });

  it("never loads the world with reduced motion", async () => {
    const { film } = mountFilm();
    const fake = fakeRuntime({ reducedMotion: true });
    initFilm(document, fake.runtime);
    fake.interact();
    await settle();
    expect(fake.loadWorld).not.toHaveBeenCalled();
    expect(film.classList.contains("film--live")).toBe(false);
  });

  it("keeps the posters and warns when the world fails to load", async () => {
    const { film } = mountFilm();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fake = fakeRuntime({ loadWorld: () => Promise.reject(new Error("no context")) });
    initFilm(document, fake.runtime);
    fake.interact();
    await settle();
    expect(film.classList.contains("film--live")).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("marks the current chapter in the rail and hides the rail on chapter one", () => {
    const { scrollTo } = mountFilm();
    const fake = fakeRuntime();
    initFilm(document, fake.runtime);
    fake.flush();
    const rail = document.querySelector("[data-film-rail]");
    expect(rail?.classList.contains("is-visible")).toBe(false);
    scrollTo(2600 - VIEWPORT + 650);
    fake.scroll();
    fake.flush();
    expect(rail?.classList.contains("is-visible")).toBe(true);
    const links = [...document.querySelectorAll("[data-film-rail] a")];
    expect(links.map((link) => link.getAttribute("aria-current"))).toEqual([
      null,
      "step",
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  it("turns the film and the header chrome dark at night", () => {
    const { film, chrome, scrollTo } = mountFilm();
    const fake = fakeRuntime();
    initFilm(document, fake.runtime);
    fake.flush();
    expect(film.dataset.theme).toBe("light");
    scrollTo(TOTAL_SCROLL);
    fake.scroll();
    fake.flush();
    expect(film.dataset.theme).toBe("dark");
    expect(chrome.dataset.theme).toBe("dark");
  });

  it("falls back to the posters when rendered frames stay slow", async () => {
    const { film, scrollTo } = mountFilm();
    const fake = fakeRuntime();
    initFilm(document, fake.runtime);
    fake.interact();
    await settle();
    fake.flush();
    scrollSlowly(fake, scrollTo);
    expect(fake.world.dispose).toHaveBeenCalled();
    expect(film.classList.contains("film--live")).toBe(false);
  });

  it("keeps slow frames live when the budget is off", async () => {
    const { film, scrollTo } = mountFilm();
    const fake = fakeRuntime({ frameBudget: false });
    initFilm(document, fake.runtime);
    fake.interact();
    await settle();
    fake.flush();
    scrollSlowly(fake, scrollTo);
    expect(fake.world.dispose).not.toHaveBeenCalled();
    expect(film.classList.contains("film--live")).toBe(true);
  });

  it("cleans up listeners and the world", async () => {
    mountFilm();
    const fake = fakeRuntime();
    const cleanup = initFilm(document, fake.runtime);
    fake.interact();
    await settle();
    cleanup();
    expect(fake.world.dispose).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @markiro/landing exec vitest run src/scripts/film/film.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

Create `apps/landing/src/scripts/film/film.ts`:

```ts
import { lightingAt, timeOfDayAt } from "./lighting";
import { chooseTier, createFrameBudget, QUALITY_TIERS, type QualityTier } from "./quality";
import { chapterAt, filmTimeFromLayout, type SectionBox } from "./timeline";
import type { WorldHandle } from "./world/runtime";

export interface FilmRuntime {
  readonly reducedMotion: boolean;
  readonly webgl: boolean;
  readonly tier: QualityTier;
  /** When false, slow frames never switch the page back to the posters. */
  readonly frameBudget: boolean;
  viewportHeight(): number;
  devicePixelRatio(): number;
  requestFrame(callback: (now: number) => void): void;
  listen(type: "scroll" | "resize", listener: () => void): () => void;
  onFirstInteraction(listener: () => void): () => void;
  loadWorld(canvas: HTMLCanvasElement, tier: QualityTier): Promise<WorldHandle>;
}

export function initFilm(root: Document, runtime: FilmRuntime): () => void {
  const film = root.querySelector<HTMLElement>("[data-film]");
  const canvas = root.querySelector<HTMLCanvasElement>("[data-film-canvas]");
  if (film === null || canvas === null) return () => undefined;
  const sections = [...film.querySelectorAll<HTMLElement>("[data-film-chapter]")];
  if (sections.length === 0) return () => undefined;
  const themed = [film, ...root.querySelectorAll<HTMLElement>("[data-film-chrome]")];
  const rail = film.querySelector<HTMLElement>("[data-film-rail]");
  const railLinks = [...film.querySelectorAll<HTMLAnchorElement>("[data-film-rail] a")];
  const budget = createFrameBudget();
  const cleanups: (() => void)[] = [];
  let world: WorldHandle | null = null;
  let pending = false;
  let lastFilmTime = Number.NaN;

  const stopWorld = (): void => {
    world?.dispose();
    world = null;
    film.classList.remove("film--live");
  };

  const resizeWorld = (): void => {
    world?.resize(canvas.clientWidth, canvas.clientHeight, runtime.devicePixelRatio());
    lastFilmTime = Number.NaN;
  };

  // The next frame starts only after the rendered one is presented, so the gap
  // between the two callbacks is the real cost of the frame, GPU included.
  const measure =
    (renderedAt: number) =>
    (now: number): void => {
      if (world !== null && budget.push(now - renderedAt, now) === "too-slow") stopWorld();
    };

  const update = (now: number): void => {
    pending = false;
    const boxes: SectionBox[] = sections.map((section) => {
      const rect = section.getBoundingClientRect();
      return { top: rect.top, height: rect.height };
    });
    const filmTime = filmTimeFromLayout(boxes, runtime.viewportHeight());
    const { index } = chapterAt(filmTime, sections.length);
    const theme = lightingAt(timeOfDayAt(filmTime)).uiTheme;
    for (const element of themed) {
      if (element.dataset.theme !== theme) element.dataset.theme = theme;
    }
    film.dataset.chapter = String(index + 1);
    rail?.classList.toggle("is-visible", index > 0);
    railLinks.forEach((link, linkIndex) => {
      if (linkIndex === index) link.setAttribute("aria-current", "step");
      else link.removeAttribute("aria-current");
    });
    if (world === null || filmTime === lastFilmTime) return;
    world.render(filmTime);
    lastFilmTime = filmTime;
    film.dataset.filmTime = filmTime.toFixed(3);
    if (runtime.frameBudget) runtime.requestFrame(measure(now));
  };

  const schedule = (): void => {
    if (pending) return;
    pending = true;
    runtime.requestFrame(update);
  };

  cleanups.push(
    runtime.listen("scroll", schedule),
    runtime.listen("resize", () => {
      resizeWorld();
      schedule();
    }),
  );

  if (!runtime.reducedMotion && runtime.webgl) {
    cleanups.push(
      runtime.onFirstInteraction(() => {
        void runtime
          .loadWorld(canvas, runtime.tier)
          .then((handle) => {
            world = handle;
            resizeWorld();
            film.classList.add("film--live");
            schedule();
          })
          .catch((error: unknown) => {
            // The posters already tell the story; leave a trace for debugging.
            console.warn("Markiro film: the 3D stage is unavailable, keeping the posters", error);
            stopWorld();
          });
      }),
    );
  }

  schedule();
  return () => {
    for (const cleanup of cleanups) cleanup();
    stopWorld();
  };
}

export function browserFilmRuntime(browserWindow: Window & typeof globalThis): FilmRuntime {
  const matches = (query: string): boolean => browserWindow.matchMedia(query).matches;
  const hardware: Navigator & { readonly deviceMemory?: number } = browserWindow.navigator;
  // Poster renders pin the tier and keep slow software frames: ?film-tier=high&film-budget=off
  const params = new URL(browserWindow.location.href).searchParams;
  const pinnedTier = QUALITY_TIERS.find((tier) => tier === params.get("film-tier"));
  return {
    reducedMotion: matches("(prefers-reduced-motion: reduce)"),
    webgl: typeof browserWindow.WebGL2RenderingContext === "function",
    tier:
      pinnedTier ??
      chooseTier({
        coarsePointer: matches("(pointer: coarse)"),
        deviceMemory: hardware.deviceMemory ?? null,
        cores: hardware.hardwareConcurrency > 0 ? hardware.hardwareConcurrency : null,
      }),
    frameBudget: params.get("film-budget") !== "off",
    viewportHeight: () => browserWindow.innerHeight,
    devicePixelRatio: () => browserWindow.devicePixelRatio || 1,
    requestFrame: (callback) => {
      browserWindow.requestAnimationFrame(callback);
    },
    listen: (type, listener) => {
      browserWindow.addEventListener(type, listener, { passive: true });
      return () => {
        browserWindow.removeEventListener(type, listener);
      };
    },
    onFirstInteraction: (listener) => {
      const events = ["scroll", "wheel", "pointerdown", "touchstart", "keydown"] as const;
      const remove = (): void => {
        for (const type of events) browserWindow.removeEventListener(type, handle);
      };
      const handle = (): void => {
        remove();
        listener();
      };
      for (const type of events) browserWindow.addEventListener(type, handle, { passive: true });
      return remove;
    },
    loadWorld: async (canvas, tier) => {
      const { startWorld } = await import("./world/runtime");
      return startWorld(canvas, tier);
    },
  };
}
```

- [ ] **Step 4: Run the test, typecheck and lint**

Run:
```bash
pnpm --filter @markiro/landing exec vitest run src/scripts/film/film.test.ts
pnpm --filter @markiro/landing typecheck
pnpm --filter @markiro/landing lint
```
Expected: 8 tests pass; no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/landing/src/scripts/film/film.ts apps/landing/src/scripts/film/film.test.ts
git commit -m "feat(landing): film entry script with lazy 3D and poster fallback" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: The film page and its search surfaces

The page and its sitemap entry land together: the site audit fails when the sitemap and the HTML routes differ.

**Files:**
- Create: `apps/landing/src/content/film-posters.ts`, `apps/landing/src/components/FilmPoster.astro`, `apps/landing/src/components/FilmPage.astro`, `apps/landing/src/styles/film.css`, `apps/landing/src/pages/kak-rabotaet/index.astro`, `apps/landing/src/pages/en/how-it-works/index.astro`, `apps/landing/src/assets/film/*.jpg` (placeholders)
- Modify: `apps/landing/src/lib/seo.ts` (imports at the top, `INDEXABLE_PAGES` at lines 20-25, new function after `buildHubPageGraph`)
- Test: `apps/landing/src/lib/seo.test.ts`, `apps/landing/test/rendered-page.test.ts`

**Interfaces:**
- Consumes: `FilmPageDefinition`, `findFilmPage`, `FILM_SEARCH_PAGES`, `FilmChapterId` (Task 2), `initFilm`, `browserFilmRuntime` (Task 11), `getUiCopy`, `readPublicSiteConfig`, `BaseLayout`, `LandingHeader`, `LandingFooter`, `DemoSection`.
- Produces: the two routes; `buildFilmPageGraph(page: FilmPageDefinition): PageGraph`; `posterFor(id: FilmChapterId): { wide: ImageMetadata; tall: ImageMetadata }`.

- [ ] **Step 1: Write the failing tests**

In `apps/landing/src/lib/seo.test.ts` add `import { findFilmPage } from "../content/film";` after the `../content/articles` import, add `buildFilmPageGraph,` after `buildArticlePageGraph,` in the `./seo` import list, and append:

```ts
describe("film page search surfaces", () => {
  it("lists both locales in the sitemap with reciprocal hreflang", () => {
    const sitemap = renderSitemapXml();
    expect(sitemap).toContain("<loc>https://markiro.app/kak-rabotaet/</loc>");
    expect(sitemap).toContain("<loc>https://markiro.app/en/how-it-works/</loc>");
    expect(sitemap).toContain(
      '<xhtml:link rel="alternate" hreflang="en" href="https://markiro.app/en/how-it-works/" />',
    );
  });

  it("describes the film in llms.txt for both languages", () => {
    const llms = renderLlmsTxt();
    expect(llms).toContain("- [Как работает](https://markiro.app/kak-rabotaet/): ");
    expect(llms).toContain("- [How it works](https://markiro.app/en/how-it-works/): ");
  });

  it("builds a web page graph with a breadcrumb to the home page", () => {
    const nodes = buildFilmPageGraph(findFilmPage("ru"))["@graph"];
    expect(nodes.find((node) => node["@type"] === "WebPage")).toMatchObject({
      url: "https://markiro.app/kak-rabotaet/",
      inLanguage: "ru",
      dateModified: "2026-09-26",
    });
    expect(nodes.find((node) => node["@type"] === "BreadcrumbList")).toMatchObject({
      itemListElement: [
        { position: 1, name: "Markiro", item: "https://markiro.app/" },
        { position: 2, name: "Как работает", item: "https://markiro.app/kak-rabotaet/" },
      ],
    });
  });
});
```

In `apps/landing/test/rendered-page.test.ts`:
1. Add `import { findFilmPage } from "../src/content/film";` after the `vitest` import.
2. Add after `SAMPLE_CLUSTER_ROUTES`: `const FILM_ROUTES = ["/kak-rabotaet/", "/en/how-it-works/"] as const;`
3. Change the `beforeAll` loop to `for (const route of [...EXPECTED_ROUTES, ...HUB_ROUTES, ...SAMPLE_CLUSTER_ROUTES, ...FILM_ROUTES]) {`.
4. Append at the end of the file:

```ts
describe("rendered film page", () => {
  it.each([
    ["/kak-rabotaet/", "ru"],
    ["/en/how-it-works/", "en"],
  ] as const)("%s tells the seven chapters as HTML", (route, locale) => {
    const film = documents.get(route) as Document;
    const page = findFilmPage(locale);
    expect(film.documentElement.getAttribute("lang")).toBe(locale);
    expect(film.querySelectorAll("h1")).toHaveLength(1);
    expect(film.querySelector("h1")?.textContent?.trim()).toBe(page.chapters[0]?.title);
    expect(film.querySelectorAll("section[data-film-chapter]")).toHaveLength(7);
    expect(film.querySelectorAll("section[data-film-chapter] h2")).toHaveLength(6);
    expect(film.querySelectorAll("[data-film-rail] a")).toHaveLength(7);
    expect(film.querySelector("canvas[data-film-canvas]")).not.toBeNull();
    const text = film.body.textContent?.replace(/\s+/gu, " ") ?? "";
    for (const chapter of page.chapters) {
      for (const phrase of [chapter.kicker, chapter.title, chapter.body, ...chapter.tags]) {
        expect(text, phrase).toContain(phrase);
      }
      if (chapter.status !== undefined) expect(text).toContain(chapter.status);
    }
  });

  it.each([
    ["/kak-rabotaet/", "ru", "/en/how-it-works/"],
    ["/en/how-it-works/", "en", "/kak-rabotaet/"],
  ] as const)("%s publishes canonical, hreflang, JSON-LD and the demo form", (route, locale, alternate) => {
    const film = documents.get(route) as Document;
    expect(film.querySelector('link[rel="canonical"]')?.getAttribute("href")).toBe(
      `https://markiro.app${route}`,
    );
    expect(
      film
        .querySelector(`link[rel="alternate"][hreflang="${locale === "ru" ? "en" : "ru"}"]`)
        ?.getAttribute("href"),
    ).toBe(`https://markiro.app${alternate}`);
    const graph = JSON.parse(
      film.querySelector('script[type="application/ld+json"]')?.textContent ?? "",
    ) as { "@graph": Array<Record<string, unknown>> };
    expect(graph["@graph"].find((entry) => entry["@type"] === "WebPage")).toMatchObject({
      url: `https://markiro.app${route}`,
      inLanguage: locale,
    });
    expect(film.querySelector("main#main #demo")).not.toBeNull();
    expect(enabledDocuments.get(route)?.querySelector("main#main [data-demo-form]")).not.toBeNull();
  });

  it("keeps the morning light, the night dark and the header in step", () => {
    const film = documents.get("/kak-rabotaet/") as Document;
    expect(
      [...film.querySelectorAll<HTMLElement>("section[data-film-chapter]")].map(
        (section) => section.dataset.theme,
      ),
    ).toEqual(["light", "light", "light", "light", "light", "dark", "dark"]);
    const chrome = film.querySelector(".film-top");
    expect(chrome?.getAttribute("data-theme")).toBe("light");
    expect(chrome?.hasAttribute("data-film-chrome")).toBe(true);
  });

  it("loads the first poster eagerly, the rest lazily, all decorative and art-directed", () => {
    const film = documents.get("/kak-rabotaet/") as Document;
    const images = [...film.querySelectorAll<HTMLImageElement>(".film-chapter__poster img")];
    expect(images).toHaveLength(7);
    expect(images[0]?.getAttribute("loading")).toBe("eager");
    expect(images[0]?.getAttribute("fetchpriority")).toBe("high");
    for (const image of images.slice(1)) expect(image.getAttribute("loading")).toBe("lazy");
    for (const image of images) {
      expect(image.getAttribute("alt")).toBe("");
      expect(image.getAttribute("width")).not.toBeNull();
      expect(image.getAttribute("height")).not.toBeNull();
    }
    expect(
      film.querySelectorAll('.film-chapter__poster source[media="(max-width: 860px)"]'),
    ).toHaveLength(14);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:
```bash
pnpm turbo run build --filter='@markiro/landing^...'
pnpm --filter @markiro/landing exec vitest run src/lib/seo.test.ts test/rendered-page.test.ts
```
Expected: FAIL. `seo.test.ts` fails on the missing `buildFilmPageGraph` export; `rendered-page.test.ts` fails in `beforeAll` with `ENOENT … kak-rabotaet/index.html`.

- [ ] **Step 3: Create placeholder posters**

Run:
```bash
mkdir -p apps/landing/src/assets/film
pnpm --filter @markiro/landing exec node --input-type=module -e '
import sharp from "sharp";
const ids = ["district", "line", "packing", "warehouse", "offline", "kiosk", "office"];
for (const id of ids) {
  const background = id === "kiosk" || id === "office" ? "#131216" : id === "offline" ? "#f1eae1" : "#fafaf8";
  for (const [name, width, height] of [["wide", 1600, 1000], ["tall", 780, 1688]]) {
    await sharp({ create: { width, height, channels: 3, background } })
      .jpeg({ quality: 80 })
      .toFile(`src/assets/film/${id}-${name}.jpg`);
  }
}
'
ls apps/landing/src/assets/film | wc -l
```
Expected: `14`. Task 14 replaces them with renders of the scene.

- [ ] **Step 4: Register the film for search**

In `apps/landing/src/lib/seo.ts` add after `import { articlesForLocale } from "../content/articles";`:

```ts
import { FILM_SEARCH_PAGES, type FilmPageDefinition } from "../content/film";
```

Replace the `INDEXABLE_PAGES` constant with:

```ts
const INDEXABLE_PAGES: readonly SearchPageRecord[] = [
  ...MARKETING_SEARCH_PAGES,
  ...FILM_SEARCH_PAGES,
  ...HUB_SEARCH_PAGES,
  ...ARTICLE_SEARCH_PAGES,
  ...LEGAL_SEARCH_PAGES,
];
```

Add after `buildHubPageGraph`:

```ts
export function buildFilmPageGraph(page: FilmPageDefinition): PageGraph {
  const pageUrl = absoluteUrl(page.path);
  return {
    "@context": "https://schema.org",
    "@graph": [
      websiteNode(),
      organizationNode(),
      {
        "@type": "WebPage",
        "@id": `${pageUrl}#webpage`,
        url: pageUrl,
        name: page.title,
        description: page.description,
        inLanguage: page.locale,
        dateModified: page.reviewedAt,
        isPartOf: { "@id": `${SITE_URL}/#website` },
      },
      breadcrumbList(page.locale, [{ name: page.navigationLabel, path: page.path }]),
    ],
  };
}
```

- [ ] **Step 5: Implement the poster map and component**

Create `apps/landing/src/content/film-posters.ts`:

```ts
import type { ImageMetadata } from "astro";

import districtTall from "../assets/film/district-tall.jpg";
import districtWide from "../assets/film/district-wide.jpg";
import kioskTall from "../assets/film/kiosk-tall.jpg";
import kioskWide from "../assets/film/kiosk-wide.jpg";
import lineTall from "../assets/film/line-tall.jpg";
import lineWide from "../assets/film/line-wide.jpg";
import officeTall from "../assets/film/office-tall.jpg";
import officeWide from "../assets/film/office-wide.jpg";
import offlineTall from "../assets/film/offline-tall.jpg";
import offlineWide from "../assets/film/offline-wide.jpg";
import packingTall from "../assets/film/packing-tall.jpg";
import packingWide from "../assets/film/packing-wide.jpg";
import warehouseTall from "../assets/film/warehouse-tall.jpg";
import warehouseWide from "../assets/film/warehouse-wide.jpg";
import type { FilmChapterId } from "./film";

export interface FilmPoster {
  readonly wide: ImageMetadata;
  readonly tall: ImageMetadata;
}

const POSTERS: Readonly<Record<FilmChapterId, FilmPoster>> = {
  district: { wide: districtWide, tall: districtTall },
  line: { wide: lineWide, tall: lineTall },
  packing: { wide: packingWide, tall: packingTall },
  warehouse: { wide: warehouseWide, tall: warehouseTall },
  offline: { wide: offlineWide, tall: offlineTall },
  kiosk: { wide: kioskWide, tall: kioskTall },
  office: { wide: officeWide, tall: officeTall },
};

export function posterFor(id: FilmChapterId): FilmPoster {
  return POSTERS[id];
}
```

Create `apps/landing/src/components/FilmPoster.astro`:

```astro
---
import type { ImageMetadata } from "astro";
import { getImage } from "astro:assets";

interface Props {
  wide: ImageMetadata;
  tall: ImageMetadata;
  eager: boolean;
}

const { wide, tall, eager } = Astro.props;
const [wideAvif, wideWebp, tallAvif, tallWebp] = await Promise.all([
  getImage({ src: wide, widths: [800, 1200, 1600], format: "avif" }),
  getImage({ src: wide, widths: [800, 1200, 1600], format: "webp" }),
  getImage({ src: tall, widths: [390, 780], format: "avif" }),
  getImage({ src: tall, widths: [390, 780], format: "webp" }),
]);
---

<picture>
  <source media="(max-width: 860px)" type="image/avif" srcset={tallAvif.srcSet.attribute} sizes="100vw" />
  <source media="(max-width: 860px)" type="image/webp" srcset={tallWebp.srcSet.attribute} sizes="100vw" />
  <source type="image/avif" srcset={wideAvif.srcSet.attribute} sizes="100vw" />
  <source type="image/webp" srcset={wideWebp.srcSet.attribute} sizes="100vw" />
  <img
    src={wideWebp.src}
    width={wide.width}
    height={wide.height}
    alt=""
    loading={eager ? "eager" : "lazy"}
    fetchpriority={eager ? "high" : "auto"}
    decoding={eager ? "sync" : "async"}
  />
</picture>
```

- [ ] **Step 6: Implement the page and the routes**

Create `apps/landing/src/components/FilmPage.astro`:

```astro
---
import type { FilmPageDefinition } from "../content/film";
import { posterFor } from "../content/film-posters";
import { getUiCopy } from "../content/ui";
import { buildFilmPageGraph } from "../lib/seo";
import { readPublicSiteConfig } from "../lib/site-config";
import BaseLayout from "../layouts/BaseLayout.astro";
import DemoSection from "./DemoSection.astro";
import FilmPoster from "./FilmPoster.astro";
import LandingFooter from "./LandingFooter.astro";
import LandingHeader from "./LandingHeader.astro";
import "../styles/film.css";

interface Props {
  page: FilmPageDefinition;
}

const { page } = Astro.props;
const copy = getUiCopy(page.locale);
const siteConfig = readPublicSiteConfig(
  {
    PUBLIC_DEMO_SUBMISSION_ENABLED: import.meta.env.PUBLIC_DEMO_SUBMISSION_ENABLED,
    PUBLIC_PHONE: import.meta.env.PUBLIC_PHONE,
    PUBLIC_SMARTCAPTCHA_CLIENT_KEY: import.meta.env.PUBLIC_SMARTCAPTCHA_CLIENT_KEY,
  },
  page.locale,
);
const total = String(page.chapters.length).padStart(2, "0");
const lastIndex = page.chapters.length - 1;
---

<BaseLayout metadata={page} graph={buildFilmPageGraph(page)}>
  <div class="film-top" data-theme="light" data-film-chrome>
    <LandingHeader page={page} phone={siteConfig.phone} />
  </div>

  <main id="main">
    <div class="film" data-film data-theme="light">
      <div class="film__stage" aria-hidden="true">
        <canvas class="film__canvas" data-film-canvas></canvas>
      </div>

      {page.chapters.map((chapter, index) => {
        const poster = posterFor(chapter.id);
        return (
          <section
            class:list={["film-chapter", { "film-chapter--hero": index === 0 }]}
            id={chapter.id}
            data-film-chapter
            data-theme={chapter.theme}
            style={`--span: ${chapter.span}`}
            aria-labelledby={`${chapter.id}-title`}
          >
            <div class="film-chapter__poster" aria-hidden="true">
              <FilmPoster wide={poster.wide} tall={poster.tall} eager={index === 0} />
            </div>
            {index === 0 ? (
              <div class="film-hero">
                <p class="film-kicker">{chapter.kicker}</p>
                <h1 id={`${chapter.id}-title`} class="film-hero__title">{chapter.title}</h1>
                <p class="film-hero__lead">{chapter.body}</p>
                <div class="film-hero__actions">
                  <a class="button" href="#demo" data-analytics="landing_demo_click" data-placement="film_hero">
                    {copy.common.requestDemoShort} <span aria-hidden="true">→</span>
                  </a>
                  <a class="film-link" href={page.heroSecondary.href}>{page.heroSecondary.label}</a>
                </div>
                <ul class="film-tags">
                  {chapter.tags.map((tag) => <li>{tag}</li>)}
                </ul>
                <p class="film-hero__hint">{page.scrollHint}</p>
              </div>
            ) : (
              <div class="film-card">
                <p class="film-card__progress" aria-hidden="true">{String(index + 1).padStart(2, "0")} / {total}</p>
                {chapter.status !== undefined && (
                  <p class="film-card__status">
                    <svg class="film-card__status-icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
                      <path d="M1.5 5.5a10 10 0 0 1 13 0M4 8.4a6.5 6.5 0 0 1 8 0M6.4 11.2a2.6 2.6 0 0 1 3.2 0M2 2l12 12" />
                      <circle cx="8" cy="13.6" r="0.9" />
                    </svg>
                    {chapter.status}
                  </p>
                )}
                <p class="film-kicker">{chapter.kicker}</p>
                <h2 id={`${chapter.id}-title`} class="film-card__title">{chapter.title}</h2>
                <p class="film-card__body">{chapter.body}</p>
                <ul class="film-tags">
                  {chapter.tags.map((tag) => <li>{tag}</li>)}
                </ul>
                {index === lastIndex && (
                  <div class="film-card__actions">
                    <a class="button" href="#demo" data-analytics="landing_demo_click" data-placement="film_final">
                      {copy.common.requestDemoShort} <span aria-hidden="true">→</span>
                    </a>
                    <a class="film-link" href={page.finalSecondary.href}>{page.finalSecondary.label}</a>
                  </div>
                )}
              </div>
            )}
          </section>
        );
      })}

      <nav class="film__rail" data-film-rail aria-label={page.railLabel}>
        <ol>
          {page.chapters.map((chapter, index) => (
            <li>
              <a href={`#${chapter.id}`}>
                <span class="film__rail-mark" aria-hidden="true"></span>
                {String(index + 1).padStart(2, "0")} {chapter.railLabel}
              </a>
            </li>
          ))}
        </ol>
      </nav>
    </div>

    <DemoSection
      locale={page.locale}
      phone={siteConfig.phone}
      demoEndpoint={siteConfig.demoEndpoint}
      legalLinks={siteConfig.legalLinks}
      captchaClientKey={siteConfig.captchaClientKey}
      consentVersion={siteConfig.consentVersion}
      sourcePath={page.path}
    />
  </main>

  <LandingFooter page={page} />

  <script>
    import { browserDemoFormRuntime, initDemoForm } from "../scripts/demo-form";
    import { browserFilmRuntime, initFilm } from "../scripts/film/film";
    import { browserLandingRuntime, initLanding } from "../scripts/site";

    initLanding(document, browserLandingRuntime(window));
    initFilm(document, browserFilmRuntime(window));
    const demoForm = document.querySelector<HTMLFormElement>("[data-demo-form]");
    if (demoForm !== null) initDemoForm(demoForm, browserDemoFormRuntime(window));
  </script>
</BaseLayout>
```

Create `apps/landing/src/pages/kak-rabotaet/index.astro`:

```astro
---
import FilmPage from "../../components/FilmPage.astro";
import { findFilmPage } from "../../content/film";
---

<FilmPage page={findFilmPage("ru")} />
```

Create `apps/landing/src/pages/en/how-it-works/index.astro`:

```astro
---
import FilmPage from "../../../components/FilmPage.astro";
import { findFilmPage } from "../../../content/film";
---

<FilmPage page={findFilmPage("en")} />
```

- [ ] **Step 7: Implement the styles**

Create `apps/landing/src/styles/film.css`:

```css
/* Лендинг-фильм «Как работает». Цвета из токенов @markiro/ui: элемент с
   data-theme="light" получает светлые значения, с "dark" остаётся тёмным.
   Скрипт фильма переключает тему шапки и фильма вместе со временем суток. */

.film-top::before {
  position: fixed;
  z-index: 19;
  top: 0;
  right: 0;
  left: 0;
  height: 6.5rem;
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--surface-page) 88%, transparent) 40%,
    transparent
  );
  content: "";
  pointer-events: none;
}

/* The header stays over every frame of the film. */
.film-top .landing-header {
  position: fixed;
  border-bottom-color: var(--line);
}

.film-top .menu-trigger {
  border-color: var(--line-strong);
  background: color-mix(in srgb, var(--surface-page) 86%, transparent);
}

.film {
  position: relative;
  isolation: isolate;
  background: var(--surface-page);
}

.film__stage {
  position: sticky;
  z-index: 0;
  top: 0;
  height: 100lvh;
  margin-bottom: -100lvh;
  overflow: hidden;
  pointer-events: none;
}

.film__canvas {
  display: block;
  width: 100%;
  height: 100%;
}

.film-chapter {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  min-height: calc(var(--span) * 100lvh);
  padding: 0 var(--landing-section-inline) 3.5rem;
  /* A chapter link lands in the middle of the chapter, where its card rests. */
  scroll-margin-top: calc((1 - var(--span) / 2) * 100lvh);
  color: var(--fg-1);
}

.film-chapter--hero {
  justify-content: flex-start;
  scroll-margin-top: 0;
}

.film-chapter__poster {
  position: absolute;
  z-index: -2;
  inset: 0;
  pointer-events: none;
  transition:
    opacity 480ms var(--landing-ease),
    visibility 0s linear 0s;
}

/* Posters fade out over the stage, which draws its first frame within the fade. */
.film--live .film-chapter__poster {
  opacity: 0;
  visibility: hidden;
  transition:
    opacity 480ms var(--landing-ease),
    visibility 0s linear 480ms;
}

.film-chapter__poster picture {
  position: sticky;
  top: 0;
  display: block;
  height: 100lvh;
}

.film-chapter__poster img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.film-chapter--hero::before {
  position: absolute;
  z-index: -1;
  inset: 0 45% 0 0;
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--surface-page) 72%, transparent),
    transparent
  );
  content: "";
  pointer-events: none;
}

.film-hero {
  display: flex;
  flex-direction: column;
  justify-content: center;
  max-width: 40rem;
  min-height: 100lvh;
  padding-top: 5rem;
}

.film-kicker {
  margin: 0;
  color: var(--fg-2);
  font: var(--landing-kicker);
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.film-hero__title {
  max-width: 38rem;
  margin: 1.75rem 0 0;
  font: var(--landing-display-xl);
  letter-spacing: -0.055em;
}

.film-hero__lead {
  max-width: 32rem;
  margin: 1.75rem 0 0;
  color: var(--fg-2);
  font: var(--landing-lead);
}

.film-hero__actions,
.film-card__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 1.5rem 1.75rem;
  margin-top: 1.75rem;
}

.film-link {
  color: var(--fg-1);
  font: 600 0.9375rem / 1.2 var(--font-ui);
  text-decoration-color: var(--line-strong);
  text-underline-offset: 0.3rem;
}

.film-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin: 1.25rem 0 0;
  padding: 0;
  list-style: none;
}

.film-tags li {
  padding: 0.375rem 0.625rem;
  border: 1px solid var(--line-strong);
  border-radius: 2px;
  color: var(--fg-2);
  font: 500 0.75rem / 1 var(--font-mono);
}

.film-hero__hint {
  margin: 3.5rem 0 0;
  color: var(--fg-3);
  font: 500 0.6875rem / 1.4 var(--font-mono);
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.film-card {
  position: sticky;
  bottom: 3.5rem;
  width: min(35rem, 100%);
  padding: 2rem;
  border: 1px solid var(--line);
  border-radius: var(--r-3);
  background: color-mix(in srgb, var(--surface-page) 92%, transparent);
  backdrop-filter: blur(16px);
}

.film-chapter[data-theme="dark"] .film-card {
  background: color-mix(in srgb, var(--surface-page) 84%, transparent);
}

.film-card__progress {
  display: none;
  margin: 0 0 0.75rem;
  color: var(--fg-3);
  font: 500 0.6875rem / 1 var(--font-mono);
  letter-spacing: 0.1em;
}

.film-card__status {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  margin: 0 0 1rem;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--warn-border);
  border-radius: var(--r-1);
  background: var(--warn-bg);
  color: var(--warn-fg);
  font: 600 0.75rem / 1.2 var(--font-mono);
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.film-card__status-icon {
  flex: none;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
  stroke-linecap: round;
}

.film-card__status-icon circle {
  fill: currentColor;
  stroke: none;
}

.film-card__title {
  margin: 1rem 0 0;
  font: 600 clamp(1.75rem, 2.6vw, 2.5rem) / 1.08 var(--font-ui);
  letter-spacing: -0.02em;
  text-wrap: balance;
}

.film-card__body {
  margin: 1rem 0 0;
  color: var(--fg-2);
  font: 400 1.0625rem / 1.55 var(--font-ui);
}

.film__rail {
  position: fixed;
  z-index: 5;
  top: 50%;
  right: max(1.5rem, calc((100vw - 75rem) / 2 - 3rem));
  padding: 1rem;
  border-radius: var(--r-3);
  background: color-mix(in srgb, var(--surface-page) 88%, transparent);
  backdrop-filter: blur(12px);
  opacity: 0;
  visibility: hidden;
  transform: translateY(-50%);
  transition:
    opacity 240ms var(--landing-ease),
    visibility 240ms;
}

.film__rail.is-visible {
  opacity: 1;
  visibility: visible;
}

.film__rail ol {
  display: grid;
  gap: 0.75rem;
  margin: 0;
  padding: 0;
  list-style: none;
}

.film__rail a {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  color: var(--fg-3);
  font: 500 0.75rem / 1 var(--font-mono);
  text-decoration: none;
}

.film__rail a[aria-current="step"] {
  color: var(--fg-1);
  font-weight: 600;
}

.film__rail-mark {
  width: 0.5rem;
  height: 0.5rem;
  border: 1.5px solid currentColor;
}

/* The active chapter carries the green module of the brand mark. */
.film__rail a[aria-current="step"] .film__rail-mark {
  border-color: transparent;
  background: var(--accent-module);
}

@media (max-width: 860px) {
  .film-chapter {
    padding: 0;
  }

  .film-chapter--hero::before {
    inset: 30% 0 0;
    background: linear-gradient(
      0deg,
      color-mix(in srgb, var(--surface-page) 90%, transparent) 40%,
      transparent
    );
  }

  .film-hero {
    justify-content: flex-end;
    padding: 6rem 1.25rem 2.5rem;
  }

  .film-hero__title {
    font: 600 2.5rem / 1.02 var(--font-ui);
    letter-spacing: -0.03em;
  }

  .film-card {
    bottom: 0;
    width: 100%;
    padding: 1.25rem 1.25rem 1.75rem;
    border-width: 1px 0 0;
    border-radius: 1rem 1rem 0 0;
  }

  .film-card__progress {
    display: block;
  }

  .film-card__title {
    font-size: 1.625rem;
  }

  .film-card__body {
    font-size: 0.9375rem;
  }

  .film__rail {
    display: none;
  }
}

@media (max-width: 47.9375rem) {
  /* The shared phone menu is painted dark; follow the film theme instead. */
  .film-top .landing-nav {
    background: var(--surface-card);
  }
}

@media (prefers-reduced-motion: reduce) {
  .film__stage {
    display: none;
  }

  .film-chapter__poster {
    transition: none;
  }
}
```

- [ ] **Step 8: Run the page tests, the audit, typecheck and lint**

Run:
```bash
pnpm --filter @markiro/landing exec vitest run src/lib/seo.test.ts test/rendered-page.test.ts test/site-audit.test.ts
pnpm --filter @markiro/landing typecheck
pnpm --filter @markiro/landing lint
```
Expected: all pass. `site-audit` must stay `[]`: unique title and description, one H1, matching canonical, sitemap equal to the HTML routes, no broken links.

- [ ] **Step 9: Commit**

```bash
git add apps/landing/src/lib/seo.ts apps/landing/src/lib/seo.test.ts apps/landing/src/content/film-posters.ts apps/landing/src/components/FilmPoster.astro apps/landing/src/components/FilmPage.astro apps/landing/src/styles/film.css apps/landing/src/pages/kak-rabotaet/index.astro apps/landing/src/pages/en/how-it-works/index.astro apps/landing/src/assets/film apps/landing/test/rendered-page.test.ts
git commit -m "feat(landing): film page with sticky chapters, posters and search entries" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Link the home page hero to the film

**Files:**
- Modify: `apps/landing/src/content/ui.ts` (RU `home.hero` near line 75, EN `home.hero` near line 260)
- Modify: `apps/landing/src/components/HomePage.astro` (`.hero__actions`, lines 56-68)
- Modify: `apps/landing/src/styles/landing.css` (after `.hero__phone`, line 332)
- Test: `apps/landing/test/rendered-page.test.ts`

**Interfaces:**
- Produces: `copy.home.hero.filmLink` in both locales.

- [ ] **Step 1: Write the failing test**

Append inside the `rendered film page` describe block in `apps/landing/test/rendered-page.test.ts`:

```ts
  it.each([
    ["/", "/kak-rabotaet/", "Посмотреть, как это работает"],
    ["/en/", "/en/how-it-works/", "See how it works"],
  ] as const)("%s links its hero to the film", (route, href, label) => {
    const home = documents.get(route) as Document;
    const link = home.querySelector<HTMLAnchorElement>(`.hero a[href="${href}"]`);
    expect(link?.textContent?.trim()).toBe(label);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @markiro/landing exec vitest run test/rendered-page.test.ts -t "links its hero to the film"`
Expected: FAIL (`undefined` instead of the label).

- [ ] **Step 3: Implement**

In `apps/landing/src/content/ui.ts` add as the first key of the RU `hero` object:

```ts
      filmLink: "Посмотреть, как это работает",
```

and as the first key of the EN `hero` object:

```ts
      filmLink: "See how it works",
```

In `apps/landing/src/components/HomePage.astro`, inside `<div class="hero__actions" data-reveal>`, add after the phone block and before `</div>`:

```astro
          <a class="hero__film-link" href={page.locale === "ru" ? "/kak-rabotaet/" : "/en/how-it-works/"}>
            {copy.home.hero.filmLink}
          </a>
```

In `apps/landing/src/styles/landing.css` add after the `.hero__phone` rule:

```css
.hero__film-link {
  color: var(--fg-1);
  font: 600 0.875rem / 1 var(--font-ui);
  text-decoration-color: var(--line-strong);
  text-underline-offset: 0.3rem;
}
```

- [ ] **Step 4: Run the tests**

Run:
```bash
pnpm --filter @markiro/landing exec vitest run test/rendered-page.test.ts test/site-audit.test.ts
pnpm --filter @markiro/landing typecheck
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/landing/src/content/ui.ts apps/landing/src/components/HomePage.astro apps/landing/src/styles/landing.css apps/landing/test/rendered-page.test.ts
git commit -m "feat(landing): link the home hero to the film page" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Render the posters from the live page

**Files:**
- Create: `tools/production-browser/scripts/render-film-posters.mjs`
- Modify: `tools/production-browser/package.json` (script `render:film-posters`)
- Modify: `apps/landing/src/assets/film/*.jpg` (replaced by renders)

**Interfaces:**
- Consumes: `data-film-time`, `film--live`, `?film-tier=high&film-budget=off` (Task 11); `scripts/serve-landing.mjs`, which builds the landing and serves it on `127.0.0.1:5473`.
- Produces: 14 JPEGs. The chapter 1 poster is the first 3D frame (film time 0), the others the middle of their chapter (film time `index + 0.5`), where the camera rests.

- [ ] **Step 1: Install the browser tooling if this worktree lacks it**

Run:
```bash
test -d tools/production-browser/node_modules || pnpm --dir tools/production-browser --ignore-workspace install --frozen-lockfile
pnpm --dir tools/production-browser --ignore-workspace exec playwright install chromium
```
Expected: exits 0.

- [ ] **Step 2: Write the script**

Create `tools/production-browser/scripts/render-film-posters.mjs`:

```js
import { spawn } from "node:child_process";
import path from "node:path";

import { chromium } from "@playwright/test";

const toolRoot = path.resolve(import.meta.dirname, "..");
const outputRoot = path.resolve(toolRoot, "../../apps/landing/src/assets/film");
const baseUrl = "http://127.0.0.1:5473";
const filmUrl = `${baseUrl}/kak-rabotaet/?film-tier=high&film-budget=off`;
const CHAPTERS = ["district", "line", "packing", "warehouse", "offline", "kiosk", "office"];
const LAYOUTS = [
  { name: "wide", viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  { name: "tall", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
];
// Posters carry the scene only: the page draws its own text over them.
const SCENE_ONLY = `
  .film-top, .film-hero, .film-card, .film__rail, [data-consent-panel],
  .film-chapter__poster, .film-chapter--hero::before { visibility: hidden !important; }
`;

async function waitForServer(url, child) {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (child.exitCode !== null) throw new Error("landing server exited early");
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("landing server did not start");
}

async function scrollToFilmTime(page, filmTime) {
  await page.evaluate((target) => {
    const sections = [...document.querySelectorAll("[data-film-chapter]")];
    const index = Math.min(sections.length - 1, Math.floor(target));
    const local = target - index;
    const section = sections[index];
    const top = section.getBoundingClientRect().top + window.scrollY;
    const viewport = window.innerHeight;
    const y =
      index === 0
        ? top + local * (section.offsetHeight - viewport)
        : top - viewport + local * section.offsetHeight;
    window.scrollTo({ top: Math.round(y), behavior: "instant" });
  }, filmTime);
  await page.waitForFunction(
    (target) => Math.abs(Number(document.querySelector("[data-film]")?.dataset.filmTime ?? -1) - target) < 0.01,
    filmTime,
    { timeout: 60_000 },
  );
  await page.waitForTimeout(500);
}

const server = spawn(process.execPath, [path.join(toolRoot, "scripts/serve-landing.mjs")], { stdio: "inherit" });
try {
  await waitForServer(`${baseUrl}/kak-rabotaet/`, server);
  const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  for (const layout of LAYOUTS) {
    const context = await browser.newContext({ ...layout, reducedMotion: "no-preference" });
    const page = await context.newPage();
    page.on("console", (message) => {
      if (message.type() === "error") console.error(`[page] ${message.text()}`);
    });
    await page.goto(filmUrl, { waitUntil: "networkidle" });
    await page.addStyleTag({ content: SCENE_ONLY });
    await page.evaluate(() => window.scrollBy({ top: 1, behavior: "instant" }));
    await page.waitForFunction(() => document.querySelector("[data-film]")?.classList.contains("film--live"), null, {
      timeout: 120_000,
    });
    for (const [index, id] of CHAPTERS.entries()) {
      await scrollToFilmTime(page, index === 0 ? 0 : index + 0.5);
      await page.screenshot({ path: path.join(outputRoot, `${id}-${layout.name}.jpg`), type: "jpeg", quality: 88 });
      console.log(`rendered ${id}-${layout.name}.jpg`);
    }
    await context.close();
  }
  await browser.close();
} finally {
  server.kill("SIGTERM");
}
```

Add to the `scripts` of `tools/production-browser/package.json`:

```json
    "render:film-posters": "node scripts/render-film-posters.mjs",
```

- [ ] **Step 3: Render**

Run: `pnpm --dir tools/production-browser --ignore-workspace render:film-posters`
Expected: 14 lines `rendered <id>-<wide|tall>.jpg`; the tall files are 780×1688. If the page never goes live, report the `[page]` console output; do not keep the placeholders.

- [ ] **Step 4: Inspect every poster**

Open each of the 14 files with the Read tool. Check that the subject of each chapter is framed: the district overview; the line with green codes past the arch; the packing table; the pallet and the handheld worker; the sunset plant with the amber mast; the kiosk and the visitor; the lit office at night. The frames must contain no text or UI, and the tall posters keep the subject in the upper two thirds. When a frame is wrong, fix `camera-keys.ts` (Task 16, Step 3) and render again.

- [ ] **Step 5: Re-run the page tests**

Run: `pnpm --filter @markiro/landing exec vitest run test/rendered-page.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add tools/production-browser/scripts/render-film-posters.mjs tools/production-browser/package.json apps/landing/src/assets/film
git commit -m "feat(landing): render film posters from the live scene" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: Browser, CSP and Lighthouse gates

**Files:**
- Modify: `tools/production-browser/test/lighthouse-landing.test.mjs:67-74`
- Modify: `tools/production-browser/scripts/lighthouse-landing.mjs:11-16`
- Modify: `tools/production-browser/tests/landing-seo.spec.ts` (the `routes` array, new tests at the end)
- Modify: `tools/production-browser/tests/landing-caddy-csp.spec.ts` (new test at the end)

- [ ] **Step 1: Change the Lighthouse route test first**

In `tools/production-browser/test/lighthouse-landing.test.mjs` replace the test «gates the home page, a commercial topic page and an article» with:

```js
test("gates the home page, a commercial topic page, an article and the film", () => {
  assert.ok(Object.isFrozen(LIGHTHOUSE_ROUTES));
  assert.deepEqual(LIGHTHOUSE_ROUTES, [
    "/",
    "/markirovka-chestny-znak/",
    "/stati/markirovka-piva-2026/",
    "/kak-rabotaet/",
  ]);
});
```

Run: `pnpm --dir tools/production-browser --ignore-workspace test:lighthouse-parser`
Expected: FAIL on the routes assertion.

- [ ] **Step 2: Add the route**

In `tools/production-browser/scripts/lighthouse-landing.mjs` replace the comment and constant with:

```js
/** The home page, one commercial topic page, one article and the film: the page templates that carry leads. */
export const LIGHTHOUSE_ROUTES = Object.freeze([
  "/",
  "/markirovka-chestny-znak/",
  "/stati/markirovka-piva-2026/",
  "/kak-rabotaet/",
]);
```

Run: `pnpm --dir tools/production-browser --ignore-workspace test:lighthouse-parser`
Expected: PASS.

- [ ] **Step 3: Add the browser checks**

In `tools/production-browser/tests/landing-seo.spec.ts` add `"/kak-rabotaet/",` after `"/faq/",` and `"/en/how-it-works/",` after `"/en/faq/",` in `routes`, so both pages get the status, H1, canonical, overflow and console checks on desktop and phone. Append at the end of the file:

```ts
test.describe("film page", () => {
  // Headless Chromium has no GPU; SwiftShader provides WebGL 2.
  test.use({ launchOptions: { args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] } });

  test("starts the 3D stage only after the first scroll", async ({ page }) => {
    await page.goto("/kak-rabotaet/", { waitUntil: "networkidle" });
    const film = page.locator("[data-film]");
    await expect(film).not.toHaveClass(/film--live/);
    await page.evaluate(() => window.scrollBy({ top: 400, behavior: "instant" }));
    await expect(film).toHaveClass(/film--live/, { timeout: 20_000 });
    await expect
      .poll(async () => Number(await film.getAttribute("data-film-time")), { timeout: 10_000 })
      .toBeGreaterThan(0);
  });

  test("marks the chapter the rail links to", async ({ page, isMobile }) => {
    test.skip(isMobile, "the rail is hidden on phones");
    await page.goto("/kak-rabotaet/");
    await page.evaluate(() => window.scrollBy({ top: 2000, behavior: "instant" }));
    const link = page.locator('[data-film-rail] a[href="#warehouse"]');
    await expect(link).toBeVisible();
    await link.click();
    await expect(link).toHaveAttribute("aria-current", "step");
  });

  test("keeps the posters and never goes live with reduced motion", async ({ browser }) => {
    const context = await browser.newContext({
      baseURL: "http://127.0.0.1:5473",
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    await page.goto("/kak-rabotaet/");
    await page.evaluate(() => window.scrollBy({ top: 1400, behavior: "instant" }));
    await page.waitForTimeout(1_000);
    await expect(page.locator("[data-film]")).not.toHaveClass(/film--live/);
    await expect(page.locator("#line .film-chapter__poster img")).toBeVisible();
    await context.close();
  });
});
```

In `tools/production-browser/tests/landing-caddy-csp.spec.ts` append:

```ts
test.describe("film page under the production CSP", () => {
  test.use({ launchOptions: { args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] } });

  test("runs its 3D stage without CSP violations", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("pageerror", (error) => errors.push(error.message));
    const response = await page.goto("/kak-rabotaet/", { waitUntil: "networkidle" });
    expect(response?.status()).toBe(200);
    expect(response?.headers()["content-security-policy"]).toContain("script-src 'self'");
    await page.evaluate(() => window.scrollBy({ top: 400, behavior: "instant" }));
    await expect(page.locator("[data-film]")).toHaveClass(/film--live/, { timeout: 20_000 });
    expect(errors).toEqual([]);
  });
});
```

- [ ] **Step 4: Run the typecheck, the browser suite and Lighthouse**

Run:
```bash
pnpm --dir tools/production-browser --ignore-workspace typecheck
pnpm test:landing:browser
pnpm test:landing:lighthouse
```
Expected: typecheck passes; the browser suite passes on the desktop and mobile projects; Lighthouse prints `landing Lighthouse gates passed` with `/kak-rabotaet/` at performance ≥ 0.90, accessibility 1.00, SEO 1.00 and best practices ≥ 0.95 on mobile and desktop. If accessibility fails, fix contrast or markup at the printed selectors; never lower a threshold.

- [ ] **Step 5: Run the CSP spec against the production Caddy config**

No script or CI job runs `landing-caddy-csp.spec.ts`; run it by hand against the landing part of `deploy/production/Caddyfile` in Docker (Docker commands may need to run outside the sandbox):

```bash
pnpm --filter @markiro/landing build
mkdir -p "$HOME/markiro-caddy-film"
{
  printf '{\n\tauto_https off\n\thttp_port 8080\n}\n\n'
  awk '/^\((standard_api_transport|common_headers|landing_csp|landing_routes)\)/,/^}/' deploy/production/Caddyfile
  printf '\n:8080 {\n\timport common_headers\n\timport landing_csp\n\timport landing_routes\n}\n'
} > "$HOME/markiro-caddy-film/Caddyfile"
docker run --rm -d --name markiro-caddy-film -p 18080:8080 -v "$HOME/markiro-caddy-film:/etc/caddy" -v "$PWD/apps/landing/dist:/srv/landing" caddy:2.11.4-alpine
MARKIRO_BROWSER_BASE_URL=http://127.0.0.1:18080 pnpm --dir tools/production-browser --ignore-workspace exec playwright test --config landing-caddy.playwright.config.ts -g "film page"
docker stop markiro-caddy-film
```

Expected: the film test passes on both projects. If Caddy reports an unknown snippet, add its name to the `awk` pattern. If Docker is unavailable, report the spec as not run.

- [ ] **Step 6: Commit**

```bash
git add tools/production-browser/tests/landing-seo.spec.ts tools/production-browser/tests/landing-caddy-csp.spec.ts tools/production-browser/test/lighthouse-landing.test.mjs tools/production-browser/scripts/lighthouse-landing.mjs
git commit -m "test(landing): browser, CSP and Lighthouse gates for the film" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 16: Look at it, tune it, final gates

**Files:**
- Possibly modify: `apps/landing/src/scripts/film/camera-keys.ts`, `apps/landing/src/styles/film.css`, `apps/landing/src/assets/film/*.jpg`

- [ ] **Step 1: Run the page**

Start the landing with the preview tools (`preview_start`; if `.claude/launch.json` has no landing entry, add one running `pnpm --filter @markiro/landing dev` on port 5473 and do not commit that file) and open `/kak-rabotaet/`. Scroll slowly through all seven chapters at 1440×900, then at 390×844 (`resize_window`), then back to the top.

- [ ] **Step 2: Check against these criteria and note every failure**

1. Each chapter's subject is on screen and not under its card: the district overview; the line, where codes turn green at the arch and a rejected item is pushed aside; the case filling and the label coming out; the pallet and the handheld worker; the sunset plant with the amber mast and the queue rising and flying off when the network returns; the kiosk with a badge; the lit office, then the whole district at night.
2. The camera never passes through a wall, a truss or a figure between chapters.
3. The light moves from morning to night without jumps; the header, the rail and the cards turn dark between chapters five and six.
4. Scrolling up plays everything backwards.
5. Card text is readable over every frame in both themes; on the first screen the headline and the model do not overlap.
6. The browser console shows no errors.

- [ ] **Step 3: Tune**

Fix framing and clipping only in `CAMERA_KEYS` (target, azimuth, elevation, distance, fov, shifts) and readability only in `film.css`. After each change run `pnpm --filter @markiro/landing exec vitest run src/scripts/film/camera-path.test.ts` and look again. When it is right, take a screenshot of every chapter at both sizes.

- [ ] **Step 4: Re-render the posters if any camera key changed**

Run: `pnpm --dir tools/production-browser --ignore-workspace render:film-posters`, then inspect the 14 files again.

- [ ] **Step 5: Final gates**

Run:
```bash
pnpm turbo run lint typecheck test build --filter=@markiro/landing --filter=@markiro/ui --concurrency=1 --force
pnpm check:deps
pnpm --dir tools/production-browser --ignore-workspace typecheck
pnpm --dir tools/production-browser --ignore-workspace test:lighthouse-parser
pnpm test:landing:browser
pnpm test:landing:lighthouse
pnpm format:check
git diff --check origin/main...HEAD
```
Expected: all green. If `graphify-out/graph.json` exists, run `graphify update .` afterwards.

- [ ] **Step 6: Commit the tuning**

```bash
git add apps/landing/src/scripts/film/camera-keys.ts apps/landing/src/styles/film.css apps/landing/src/assets/film
git commit -m "fix(landing): tune the film camera and readability after review" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Skip this commit if nothing changed.

- [ ] **Step 7: Report**

List the behaviour added, the files changed, every automated check with its result, the manual browser check (desktop and phone sizes, with screenshots), and what was not verified: real phones, Safari, and the production Caddy CSP spec if Docker was unavailable. The `@markiro/ui` change touches every app that loads the tokens; they set `data-theme` only on `<html>`, so their behaviour does not change, and the affected CI jobs confirm it.

---

## Spec coverage

| Spec section | Tasks |
| --- | --- |
| Chapters and copy (RU, EN, buttons, hint, status chip) | 2, 12 |
| The page: text layer, poster as LCP, sticky stage, crossfade | 11, 12 |
| Card, bottom sheet with «0N / 07», rail with the green module, header over every frame | 12 |
| Chapter lengths 130 to 160 %, time of day per chapter | 2, 3, 4 |
| 3D world: kit, palette and night mix, signals, district, plant, people | 8, 9 |
| One time of day drives sun, sky, lamps, bloom, materials, background, text | 4, 10, 11 |
| Camera spline with the pause mid-chapter | 3, 5 |
| Every moving thing is a function of scroll | 6, 10 |
| Rendering: PCF shadows, GTAO, bloom after dusk, tilt-shift, MSAA, no tone mapping | 7, 10 |
| Loading: posters, first-interaction import, reduced motion, no WebGL, 50 ms median | 11, 12, 14 |
| Quality tiers | 7 |
| No CDN, CSP | 8, 15 |
| Code layout, three pinned at 0.186.0 | 8 to 12 |
| Home page hero link | 13 |
| Tests and gates, manual browser check | 3 to 16 |
