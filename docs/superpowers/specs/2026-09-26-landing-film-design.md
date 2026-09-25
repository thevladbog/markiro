# Landing film «Как работает» — design

**Status:** accepted by the owner 2026-09-26. The mock is in pen.dev
(`pencil-new.pen`, the owner's working document): components `L · Знак`,
`L · Кнопка`, `L · Метка`, `L · Шапка`, `L · Карточка главы`, `L · Рельс`;
desktop frames `L1`…`L7`; mobile frames `M1`, `M2`, `M7`; the notes frame
`L · Заметки к лендингу-фильму «Как работает»`. Every frame's background is a
render of the prototype scene in `output/scroll-world/lab/sample/`
(untracked; served by the `scroll-world-lab` entry in `.claude/launch.json`).

Owner decisions on the way:

- Markiro is shown as a system for any marked goods: juice, cosmetics, beer,
  dairy. It is not a beer and cider product.
- Art direction is an architectural scale model: white plaster and card,
  graphite section cuts on the walls. Green `#3DDC7A` appears only where a code
  has passed, on indicators and on the call to action.
- The camera flies over the world. It descends into a scene, rises and flies
  on to the next one.
- The light goes from morning to night over the course of the page.
- No generated video or images. The world is built in code with Three.js and
  rendered in the browser; pen.dev is the design tool. The work started from
  the `/scroll-world` skill, and its video pipeline was dropped.
- Seven chapters, including the disposal kiosk.
- The film is a separate page first, linked from the home page. It becomes the
  home page later, in its own step.
- People are smooth figures in white coats. The first capsule figures were
  rejected.

## Problem

The owner asked for a new landing built around a camera that scroll moves
through the production. The current home page
(`apps/landing/src/components/HomePage.astro`) opens with a factory photo and
describes Markiro as software for beer, cider and low-alcohol drinks (the hero
lead in `src/content/ui.ts`, the `/` description in `src/content/pages.ts`).
The owner says the product is for any marked goods and wants the page to show
how the parts connect: the line, packing, the warehouse, work without a
network, the disposal kiosk and the office.

## Outcome

- `/kak-rabotaet/` and `/en/how-it-works/`: scrolling moves a camera through a
  3D model of a production site in seven chapters, from morning to night.
  Scrolling up plays the film backwards.
- Each chapter's text is real HTML. Without JavaScript or WebGL the page reads
  as a long page with one still frame per chapter.
- The page passes the landing Lighthouse gate (performance ≥ 0.9,
  accessibility 1, SEO 1, best practices ≥ 0.95) and the landing CSP.
- The home page hero gets a link to the film. Nothing else on the home page
  changes.

## Chapters and copy

The RU copy was reviewed with the owner in the pen.dev frames. It follows the
voice of the current site: short paired headings, plain sentences with a clear
actor, no dashes. The phrases «Маркировка и агрегация. Линия идёт.», «Код
прошёл. Короб собран.» and «не через отгрузку» come from the current site.

| # | Scene, time | Kicker | Title | Body | Tags |
| - | ----------- | ------ | ----- | ---- | ---- |
| 1 | District, morning | МАРКИРОВКА / АГРЕГАЦИЯ / ПРОСЛЕЖИВАЕМОСТЬ | Маркировка и агрегация. Линия идёт. (H1) | Проверяем коды, собираем короба и паллеты, печатаем этикетки для соков, косметики, пива и молочной продукции. Когда пропадает сеть, станция продолжает работать. | Соки · Косметика · Пиво · Молочная продукция |
| 2 | Line, day | 02 / ЛИНИЯ | Каждый код проверяем до короба. | Станция не пустит в короб повторный код, код чужого товара или код с ошибкой. Оператор видит причину на экране. | Дубли · Чужой GTIN · Несколько терминалов |
| 3 | Packing, day | 03 / УПАКОВКА | Код прошёл. Короб собран. | Когда короб заполнен, станция печатает этикетку с SSCC. Номера идут по порядку из диапазона, который выдали заранее, а принтер получает ZPL или TSPL. | SSCC · ZPL / TSPL · Паллеты |
| 4 | Warehouse, early evening | 04 / СКЛАД | Паллеты собираем на ТСД. | Кладовщик с терминалом на Android собирает паллеты, снимает с них коробы и проводит инвентаризацию у стеллажа. | ТСД · Инвентаризация · Пересборка |
| 5 | No network, sunset | 05 / НЕТ СЕТИ | Сеть пропала. Линия идёт. | Станция пишет операции в свой журнал и отправляет их на сервер, когда связь вернётся. Если записи с разных станций не сошлись, это видно в разделе «Конфликты». | Офлайн-журнал · Синхронизация · Конфликты |
| 6 | Disposal kiosk, evening | 06 / КИОСК ВЫБЫТИЯ | Выбытие оформляют на киоске. | Часть продукции уходит с производства не через отгрузку: покупка сотрудником, образцы, бой. Сотрудник сканирует бейдж и коды, и заявка приходит в кабинет. | Бейдж · Лимиты · Офлайн-очередь |
| 7 | Office, night | 07 / ОФИС | В кабинете видно каждую смену. | Сюда приходят операции со станций, ТСД и киосков. Отсюда идёт обмен с 1С и выгрузка документов для Честного знака. | 1С · Честный знак · Отчёты |

Chapter 1 also has the buttons «Запросить демо» (`requestDemoShort`) and «Как
это работает ↓», and the scroll hint «Листайте вниз: пройдём по производству
от линии до офиса ↓». Chapter 5 shows a status chip «Нет связи с сервером · в
очереди 128 операций» (warning colours, `wifi-off` icon, text). Chapter 7 ends
with «Запросить демо» and «Как проходит внедрение →».

The EN copy is a translation of the RU copy and is reviewed during
implementation:

| # | Title | Body | Tags |
| - | ----- | ---- | ---- |
| 1 | Serialization and aggregation. Keep the line moving. (H1, the current EN hero) | We verify codes, assemble cases and pallets, and print labels for juice, cosmetics, beer and dairy. When the network drops, the station keeps working. | Juice · Cosmetics · Beer · Dairy |
| 2 | We check every code before it goes into a case. | The station keeps repeated codes, codes of another product and malformed codes out of the case. The operator sees the reason on screen. | Duplicates · Foreign GTIN · Multiple terminals |
| 3 | Code verified. Case complete. (the current EN cycle heading) | When a case is full, the station prints an SSCC label. Numbers come in order from a range issued in advance, and the printer receives ZPL or TSPL. | SSCC · ZPL / TSPL · Pallets |
| 4 | Pallets are built on the handheld. | A warehouse worker with an Android handheld builds pallets, removes cases from them and runs inventory at the rack. | Handheld · Inventory · Repacking |
| 5 | The network is gone. The line keeps moving. | The station writes operations to its own journal and sends them to the server when the connection returns. If records from different stations disagree, they show up under Conflicts. | Offline journal · Sync · Conflicts |
| 6 | Disposal goes through the kiosk. | Some products leave production other than by shipment: employee purchases, samples, breakage. The employee scans a badge and the codes, and the request arrives in the admin panel. | Badge · Limits · Offline queue |
| 7 | Every shift is visible in the admin panel. | Operations from stations, handhelds and kiosks arrive here. From here you exchange data with 1C and export documents for Chestny ZNAK. | 1C · Chestny ZNAK · Reports |

The claims match what the product does today: duplicate, foreign-GTIN and
malformed-code rejection, SSCC pools, ZPL/TSPL output, handheld pallets and
inventory, offline journals with conflicts, the disposal kiosk, CommerceML/1C
exchange and GIS MT report exports (README «Core capabilities»,
`SOFTWARE_FACTS` in `src/lib/seo.ts`). Code ordering from СУЗ is not
implemented and is not mentioned.

## The page

The page has three layers.

1. The text layer: seven chapters of HTML, then a call-to-action row, the
   existing `DemoSection` and `LandingFooter`. This is what search engines,
   LLM crawlers and screen readers get.
2. The poster: a still frame of chapter 1. It is the LCP element.
3. The stage: a full-viewport canvas behind the text, sticky for the length of
   the film. It replaces the poster with a crossfade once the first frame is
   drawn.

On desktop the chapter card sits at the bottom left, 560 px wide, on
`#FAFAF8EB` by day and `#131216D6` at night, with a background blur. On
phones the card becomes a bottom sheet with a progress row «0N / 07». The rail
of seven chapters sits on the right from chapter 2 on; the active chapter is
marked with the green module of the brand mark, and each item is a link to its
chapter, so it works from the keyboard. The existing header stays at the top
with a gradient under it so the menu reads over any frame. At night the mark's
tile is inverted and the button uses `#3DDC7A` instead of `#0FAF56`.

In chapter 1 the model sits to the right of the headline on desktop and above
it on phones.

Each chapter takes 130 to 160 % of the viewport height of scroll; chapters 1 and 7
take the longer end. The time of day per chapter, as in the prototype: 0.05,
0.15, 0.25, 0.42, 0.52, 0.72 and 1.

## The 3D world

Everything is built from a small kit: rounded boxes (`RoundedBoxGeometry`),
matte materials, graphite caps on cut walls, faceted trees, scale figures.
Day colours come from `packages/ui/src/tokens.css` (paper `#FAFAF8`, panel
`#F0EFEA`, lines `#E0DED7` and `#C9C6BD`, ink `#17161A`). At night the
materials move 60 % of the way to a darker set, so the model still reads as a
lit white model rather than a black one.

Green `#3DDC7A` is used for verified codes, the scanner lamp, box cells on
screens, handheld and kiosk screens and the network mast when it is online.
Amber `#DD9420` is used only for the mast in chapter 5, because that is a
status.

The site has, by chapter:

- a district with several producers for the overview (a juice plant, a
  cosmetics workshop, a brewery). The prototype has one site; the producers are
  modelled during implementation;
- the line hall: conveyor, scanner arch, products that change as they pass
  (bottle, cream jar, can). A code turns green after the arch, and a rejected
  item with a red code is pushed aside;
- the packing table: an open case, the label printer, the operator's monitor
  with box cells;
- the warehouse: racks, pallets, a worker with a handheld, a van at the gate;
- the network mast with a status light;
- the checkpoint with the disposal kiosk; the visitor holds a badge;
- a two-floor office whose windows light up at night.

Figures have a lathe-profile white coat, arms made of one tube through
shoulder, elbow and hand, a cap, trousers and dark shoes. Poses: work, walk,
handheld, stand.

One number, the time of day from 0 to 1, drives the sun's colour, direction
and strength, the sky light, the interior lamps, the bloom, the material mix
and the page background. The background moves through `#FAFAF8`, `#F1EAE1`,
`#6B6461`, `#1E1C21` and `#131216`, and the text switches from ink to light
when the background gets dark.

The camera follows a spline through key frames: an establishing view, the
descent into the scene, a pause while the card is fully visible, the rise and
the flight to the next building.

Every moving thing is a function of the scroll position: the conveyor, the
codes at the arch, the box filling, the label coming out, the pallet growing,
the queue of offline operations and its flush, the kiosk screen, the office
lights. Nothing accumulates between frames, so scrolling back plays the film
backwards.

Rendering: `WebGLRenderer` with PCF shadows, GTAO, bloom only after dusk, a
tilt-shift pass and MSAA on the composer target. Tone mapping is off, so the
canvas background matches the CSS background exactly.

## Loading and fallbacks

- The chapter posters (16:10 for desktop, 9:19.5 for phones, AVIF and WebP)
  are rendered from the same scene by a script and committed. The chapter 1
  poster is the LCP element.
- The 3D code (three and the film modules) is imported on the first
  interaction: scroll, pointer or key. Lighthouse does not interact, so the
  gate measures the poster page.
- With `prefers-reduced-motion`, without WebGL, or when the median frame time
  stays above 50 ms over the first two seconds of scrolling, the page stays on
  the posters.
- Quality tiers: pixel ratio capped at 2 on desktop and 1.5 on phones; smaller
  shadow maps; no GTAO on phones and on the low tier; no bloom on the low tier.
- No CDN. three and every asset are bundled and served from the site, which the
  CSP (`script-src 'self'`) requires.

## Code layout

All in `apps/landing` unless noted.

- `package.json`: `three` at exactly `0.186.0`. It was published on 2026-09-08
  and is past the seven-day `minimum-release-age` in `.npmrc`. pnpm updates the
  lockfile.
- `src/content/film.ts`: RU and EN page metadata and chapters, and
  `FILM_SEARCH_PAGES`.
- `src/lib/seo.ts`: `INDEXABLE_PAGES` adds `...FILM_SEARCH_PAGES`, so the
  sitemap, `llms.txt` and hreflang pairs include the film.
- `src/pages/kak-rabotaet/index.astro` and
  `src/pages/en/how-it-works/index.astro` render `src/components/FilmPage.astro`
  inside `BaseLayout`.
- `src/components/HomePage.astro`: the hero link to the film, RU and EN.
- `src/scripts/film/`:
  - `film.ts`: entry, first-interaction import, fallbacks;
  - `stage.ts`: renderer, composer, quality tiers, resize;
  - `lighting.ts`: time of day;
  - `camera-path.ts`: key frames, spline, pauses;
  - `timeline.ts`: scroll position to film time and chapter progress;
  - `animations.ts`: the moving parts as functions of film time;
  - `world/kit.ts`, `world/figures.ts`, `world/buildings/*.ts`.
- `src/assets/film/`: the posters.
- `tools/production-browser/scripts/render-film-posters.mjs`: renders the
  posters with Playwright against the landing that `serve-landing.mjs` already
  serves there.

The prototype in `output/scroll-world/lab/sample/scene.js` is a sketch. The
kit, the figures, the lighting and the composition parameters carry over; the
single-file structure and the URL parameters do not.

## Tests and gates

- Unit tests (vitest, `apps/landing`): `timeline` clamps, keeps chapter
  boundaries and is monotonic in both directions; `camera-path` is continuous
  at chapter joins; `lighting` hits the day and night end points and the
  background stops.
- `apps/landing/test/rendered-page.test.ts`: one H1, one H2 per chapter, all
  chapter text in the HTML, canonical, hreflang, JSON-LD, the demo form, the
  link from the home page.
- The site audit (`src/lib/audit.ts`) passes: description, canonical, no
  duplicate descriptions.
- Browser tests in `tools/production-browser`: no console errors; the stage
  starts after scrolling; the rail moves to a chapter; reduced motion keeps the
  posters; a phone viewport works; `landing-caddy-csp.spec.ts` covers the new
  route.
- `tools/production-browser/scripts/lighthouse-landing.mjs`: add
  `/kak-rabotaet/` to `LIGHTHOUSE_ROUTES`.
- A manual check in a browser: every chapter on desktop and on a phone, the
  move from day to night, scrolling back. It is reported apart from the
  automated checks.
- Gates: `pnpm --filter @markiro/landing test`, `typecheck`, `lint`, `build`;
  `pnpm test:landing:browser`; `pnpm test:landing:lighthouse`;
  `pnpm format:check`.

## Out of scope

- Making the film the home page. That is a separate step after launch.
- Rewriting the current home page and SEO pages.
- Exporting the film as video. Analytics beyond the existing CTA events.

## Open items

- The mock lives in the owner's working document
  (`~/.pencil/documents/…/pencil-new.pen`) next to the station screens. Whether
  to save the `L` frames as `docs/design-briefs/landing-film.pen` is the
  owner's call.
- The home page and several SEO pages still describe a beer and cider focus.
  Aligning them with "any marked goods" is a separate content task.
