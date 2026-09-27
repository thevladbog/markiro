# Home page redesign — design

**Status:** accepted by the owner 2026-09-26, section by section. The mock is in
pen.dev (`pencil-new.pen`, the owner's working document), in the band below the
film frames:

- `HP · Главная · направление A · полная страница · 1440` is the full desktop
  page and the reference for this spec. Its hero is a copy of
  `HP-H5 · Hero «Карта» · 1440×900`.
- `HM · Главная · телефон · hero с лентой · 390×844` is the phone hero.
- Explored and rejected: `HA`, `HB`, `HC` (visual directions),
  `HP-H1` … `HP-H4` (hero layouts).
- The mock's images are `images/home-*` next to the document. The handheld
  screen in the mock is a design stand-in (`06b ТСД`, showing a cider) and must
  not ship.

Owner decisions on the way:

- The redesign has three goals: position Markiro for any marked goods and show
  the whole product, get more demo requests, and give the page a new look.
- Scope is the home page (`/` and `/en/`) plus the shared header, footer and
  demo form. Topic pages and articles follow in a later project.
- Product groups: the page says Markiro works for any marked goods, and the
  rollout block says the rules of the customer's product group are checked
  before launch. This replaces «Сейчас — пиво, сидр и слабоалкогольные
  напитки». The code supports it: a product carries any Chestny ZNAK product
  group code, label templates are universal or per group, EGAIS applies only
  to alcohol.
- Proof is real screens of the station, the handheld, the admin panel and the
  kiosk, plus the published instructions and documents. No client logos, no
  prices.
- Visual direction A: a light page in the scale-model world of the film. The
  dark "control room" and the dark night-model directions were rejected.
- The film stays a separate page at `/kak-rabotaet/`. The home page is a light,
  static page with a block that leads to the film. Making the film the home
  page and a live 3D hero were both declined.
- The hero is the whole plant on the full first screen with hotspots ("the
  map"). Text beside a rectangular picture was rejected as unengaging, and a
  product screen layered over a render was rejected as confusing.
- The "code path" section is gone on desktop because the map covers it. On
  phones the five stops become a card strip under the hero.
- The handheld is shown inside a device frame.
- Copy follows the humanizer rules: a caption says what the frame shows and
  never claims it is real; the film's reviewed chapter wording is reused
  wherever it exists; no "not X but Y", no clipped endings, dashes only where
  Russian grammar needs them.

## Problem

The home page (`apps/landing/src/components/HomePage.astro`, copy in
`src/content/ui.ts` under `home`, SEO in `src/content/pages.ts`) says Markiro
is for beer, cider and low-alcohol drinks in the hero lead, the implementation
block, the materials lead, a mock product («Сидр яблочный 0,45 л») and the
title and description. It never mentions the handheld, pallets or the
warehouse, which are now a large part of the product. Every "interface" on it
is drawn with CSS. It is dark, while the film it links to is a light model
world.

Search does not hold it back: the Search Console baseline
(`docs/seo/search-console-baseline-2026-09-06-d0.md`) shows 3 impressions and
0 clicks for `/`, all demand branded. The beer articles and topic pages keep
their own queries.

## Outcome

- The first screen says what Markiro is, invites the visitor to explore the
  plant, and offers the demo.
- Every part of the product appears on a real screen: station, handheld, admin
  panel, kiosk, the Chestny ZNAK link.
- The page is honest about product groups, screens and documents.
- `/` keeps its Lighthouse gate (performance ≥ 0.9 on mobile, accessibility 1,
  SEO 1, best practices ≥ 0.95) and loads no 3D.

## Page structure and copy

Russian copy is final unless marked otherwise. English mirrors it; the English
lines below are final for headings, leads and the hero; bullets and captions
are translated in the plan and reviewed by the owner.

### Header (shared by every page)

Logo; navigation «Продукт» (`/#product`), «Как работает» (`/kak-rabotaet/`),
«Инструкции», «Статьи», «Вопросы»; phone; RU/EN; «Запросить демо». English:
Product, How it works, Guides, Articles, FAQ. The topic-page links that are in
the header today (serialization, aggregation, offline) move to the footer. The
header is positioned absolutely at the top of the page, as today, so on the
home page it sits over the scene with no background of its own and scrolls
away with it.

### Hero «Карта» (`#hero`)

- Kicker «МАРКИРОВКА · АГРЕГАЦИЯ · ПРОСЛЕЖИВАЕМОСТЬ» /
  "SERIALIZATION · AGGREGATION · TRACEABILITY".
- H1 «Маркировка и агрегация. Линия идёт.» /
  "Serialization and aggregation. Keep the line moving."
- Lead «Проверяем коды, собираем короба и паллеты, печатаем этикетки для соков,
  косметики, пива и молочной продукции. Когда пропадает сеть, станция
  продолжает работать.» / "We verify codes, assemble cases and pallets, and
  print labels for juice, cosmetics, beer and dairy. When the network drops,
  the station keeps working."
- Buttons «Запросить демо» (`#demo`) and «Посмотреть, как это работает →»
  (`/kak-rabotaet/`).
- Desktop hint under the text: «Наведите на точку, чтобы увидеть экран на этом
  участке».
- Five hotspots on the scene. Each tooltip has a title, one line, a screen and
  «Подробнее →»:

| Hotspot  | Line                                                        | Screen                  | Goes to             |
| -------- | ----------------------------------------------------------- | ----------------------- | ------------------- |
| Линия    | Станция проверяет каждый код до короба.                     | station, box assembly   | `#product-line`     |
| Упаковка | Когда короб заполнен, станция печатает этикетку с SSCC.     | station, box and pallet | `#product-line`     |
| Склад    | ТСД собирает паллеты и ведёт инвентаризацию.                | handheld                | `#product-handheld` |
| Киоск    | Покупки сотрудников, образцы и бой оформляют на киоске.     | kiosk                   | `#product-kiosk`    |
| Офис     | В кабинете все смены, обмен с 1С и выгрузки в Честный знак. | admin panel, shifts     | `#product-office`   |

On phones (below 768 px) the hotspots and the hint are hidden. Under the text
and the button sits a horizontal strip of five cards with a scene thumbnail
and «Линия →», «Упаковка →», «Склад →», «Киоск →», «Офис →», linking to the
same anchors.

### 01 Product (`#product`)

Heading «Экраны, с которыми работают на смене.» / "The screens people work
with on shift." Three rows, text and a framed screen alternating sides, then
two cards.

- Station (`#product-line`), kicker «ЛИНИЯ · СТАНЦИЯ», title «Каждый код
  проверяем до короба.», text «Станция не пустит в короб повторный код, код
  чужого товара или код с ошибкой. Оператор видит причину на экране, а
  заполненный короб сразу получает этикетку с SSCC.», bullets «Повторные коды
  и чужой GTIN», «Несколько терминалов на одной линии», «Печать в ZPL и TSPL»,
  link «Маркировка и агрегация →» (`/markirovka-chestny-znak/`), caption
  «СТАНЦИЯ · КОРОБ И ПАЛЛЕТА».
- Handheld (`#product-handheld`), kicker «СКЛАД · ТСД НА ANDROID», title
  «Паллеты собираем на ТСД.», text «Кладовщик с терминалом на Android собирает
  паллеты, снимает с них коробы и проводит инвентаризацию у стеллажа. Операции
  уходят в тот же журнал, что и со станции.», bullets «Сборка и разборка
  паллет», «Инвентаризация у стеллажа», «Печать этикеток с терминала», link
  «Как это выглядит на складе →» (`/kak-rabotaet/#warehouse`), the screen in a
  handheld device frame, caption «ТСД НА ANDROID».
- Admin panel (`#product-office`), kicker «ОФИС · КАБИНЕТ», title «В кабинете
  видно каждую смену.», text «Сюда приходят операции со станций, ТСД и
  киосков. Отсюда идёт обмен с 1С и выгрузка документов для Честного знака.»,
  bullets «Сводка смен и сигналы», «Выгрузки в Честный знак», «Товары из
  Национального каталога», link «Инструкции для кабинета →», caption «КАБИНЕТ ·
  СВОДКА СМЕН».
- Card kiosk (`#product-kiosk`), kicker «ВЫБЫТИЕ · КИОСК», title «Выбытие
  оформляют на киоске.», text «Когда продукция уходит не через отгрузку
  (покупка сотрудником, образцы, бой), сотрудник сканирует на киоске бейдж и
  коды, а заявка приходит в кабинет.», link «Киоск самовыдачи →», caption
  «КИОСК».
- Card integrations (`#product-integrations`), kicker «ИНТЕГРАЦИИ», title
  «Честный знак, 1С и API.», text «Кабинет связан с Честным знаком, а с 1С
  обменивается заданиями и статусами. Данные не переносят вручную.», link
  «Интеграция с 1С →», caption «КАБИНЕТ · СВЯЗЬ С ЧЕСТНЫМ ЗНАКОМ».

### 02 Without a network (`#offline`, dark section)

Heading «Сеть может исчезнуть. Производство не должно.» / "The network may
disappear. Production must not." (the owner's existing line, both languages). Lead: the film's
offline chapter text. Points: «Проверка на месте»: «Коды проверяются на
станции без ожидания сервера.»; «Операции сохраняются»: «Каждое действие
лежит в локальном журнале до отправки.»; «Линия продолжает работу»:
«Оператор видит, что происходит, и продолжает смену после сбоя.». Visual: the
sunset render with the station's offline screen over its lower left, caption
«СТАНЦИЯ БЕЗ СЕТИ».

### 03 Traceability (`#traceability`)

Heading «У каждой ошибки есть история и следующий шаг.» / "Every error has a
history and a next step." Lead «Каждое действие остаётся в истории.
Проблемную операцию можно понять, повторить или передать ответственному.»
Screen: the station's conflicts view, caption «СТАНЦИЯ · КОНФЛИКТЫ».

### 04 The film (`#film`)

A dark panel: kicker «КАК ЭТО РАБОТАЕТ», heading «Посмотрите, как код
проходит через производство.» / "See how a code travels through production.",
lead «Прокрутите страницу, и камера пройдёт по макету завода: линия,
упаковка, склад, киоск и офис.», a light button «Посмотреть, как это работает
→» to `/kak-rabotaet/`, and a screenshot of the film page itself (a chapter
card over the scene) filling the rest of the panel.

### 05 Rollout (`#implementation`)

Heading «Для любой маркируемой продукции.» / "For any marked goods." Lead
«Коды, короба и паллеты устроены одинаково для соков и воды, молочной
продукции, пива и косметики. Особенности вашей товарной группы сверяем до
запуска.» Steps: «Сверяем правила вашей товарной группы»: «Фиксируем
товарную группу, форм-фактор упаковки и правила учёта.»; «Разбираем линию»:
«Сопоставляем оборудование, роли и текущий маршрут кодов.»; «Запускаем один
сценарий»: «Настраиваем станцию под конкретный продукт и короб.»;
«Проверяем на смене»: «Работаем с оператором и проверяем восстановление
после ошибок.». Beside the heading: the juice and cosmetics case labels from
`examples/labels`, captions «ЭТИКЕТКА КОРОБА · СОКИ» and «ЭТИКЕТКА КОРОБА ·
КОСМЕТИКА».

### 06 Open documents (`#documents`)

Heading «Всё описано до покупки.» / "Everything is documented before you buy."
Lead «Инструкции для станции и кабинета, договор и регламенты опубликованы на
сайте. Их можно прочитать до разговора с нами.» Links «Все инструкции →» and
«Договор и регламенты →». Three covers of published instructions (MKR-INS-01,
MKR-INS-02, MKR-INS-09) with their numbers and titles as captions.

### 07 Articles (`#materials`)

Heading «Разборы задач с линии.» / "Field notes from the line." The three
newest articles with their real titles, which today are all about beer, and
«Все статьи →». New articles for other product groups are separate work.

### 08 Demo (`#demo`, dark section)

Heading «Покажем Markiro на вашей линии.» / "We will show Markiro on your
line." Lead «Разберём ваш процесс, сверим правила вашей товарной группы и
покажем сценарий на вашем продукте.» Phone and the existing form: same fields,
consent, captcha, analytics events. Only the look changes.

### Footer (shared)

Brand and year, then three columns. «Продукт»: Маркировка, SSCC и агрегация,
Station для Windows (the packing workstation page), Работа без сети, Киоск
самовыдачи, Интеграция с 1С. «Материалы»: Как это работает, Статьи,
Инструкции, Вопросы. «Компания»: Документы, Политика обработки данных,
Согласие, Настройки cookies.

## Visual system

- Light tokens from `@markiro/ui` (`[data-theme="light"]`) for the home page.
  The two dark sections set `data-theme="dark"` on themselves, the way the
  film page themes its parts.
- IBM Plex Sans for text: H1 76 px on the map hero, section headings 44–48 px,
  row titles 34 px, leads 18–19 px, body 15–17 px. IBM Plex Mono for kickers
  and captions at 11–13 px with letter spacing.
- Section kickers read «NN / НАЗВАНИЕ» in page order, from «01 / ПРОДУКТ»
  to «08 / ДЕМО НА ВАШЕЙ ЛИНИИ»; the hero kicker has no number.
- Green is reserved for buttons, hotspot dots and the small list markers, as
  in the film.
- Scene renders are the world: the map in the hero, the sunset in section 02.
  Real screens sit in a white 6 px frame with a soft shadow and a mono caption
  under them. The handheld sits in a graphite device frame (scanner window on
  top, side scan buttons), drawn in CSS.
- Phones: sections stack, screens go full width, the device frame scales down.

## The map

- The hero image is a still of the film scene at a chosen moment of its camera
  path, where the flight from the district towards the line frames the hall
  large on the right with calm space on the left. It is rendered by the poster
  script at 2880 × 1800 for desktop and as a wide crop at 1170 × 720 for the
  phone hero. The chosen film time is recorded next to the images.
- Hotspot positions are computed, not drawn. A pure function projects five 3D
  anchors (the conveyor, the packing table, the pallet, the kiosk, the office)
  with the same camera the render used, through the stage's shared
  `aimCamera`, and returns normalised coordinates. The Astro component calls
  it at build time, so the dots follow the scene.
- Hotspots are buttons with an accessible name (area and line). Hover and
  focus show the tooltip; Enter, Space and click go to the anchor; Escape
  closes the tooltip. The halo pulses only when reduced motion is off.
  Tooltips are rendered in the HTML; the script only toggles them and weighs a
  few kilobytes. The home page loads no three.js.

## Images and screens

All images live in `apps/landing/src/assets/home/` and go through
`astro:assets` (AVIF and WebP, responsive sizes, lazy below the first screen,
the hero preloaded).

- Scene renders: the map (desktop and phone) and the film-page screenshot come
  from the poster script in `tools/production-browser/scripts/`; the sunset
  reuses the film's `offline-wide.jpg`.
- Screens are a dedicated landing set with neutral demo products (for example
  «Сок яблочный 1 л»), captured at double pixel density:
  - station screens from the station's dev screen gallery
    (`apps/station/src/dev/StationScreenGallery`, fixtures in
    `gallery-fixtures.ts`), with landing fixtures added next to the existing
    ones;
  - the handheld on the Android emulator with broadcast scans, as for the
    customer proposal stand;
  - the admin panel on a seeded stand;
  - the kiosk from its harness.
    No real customer data and no «Тестовый товар А» on any frame. A short
    manifest next to the images says how each one was captured.
- Case labels are copies of `examples/labels/juices/box-100x150.png` and
  `examples/labels/cosmetics/box-100x150.png`. A test checks the copies match.
- Instruction covers are first pages of the published PDFs in
  `apps/landing/public/legal/files/`. A small script renders them with macOS
  `sips` on the maintainer's machine; the PNGs are committed, so CI never
  renders PDFs. A test fails when a cover's release no longer matches the
  published file name.

## Code layout

- `src/layouts/BaseLayout.astro` gets a `theme` prop (default `dark`); the
  home page passes `light`.
- `src/components/HomePage.astro` composes new sections under
  `src/components/home/`: the map hero, product, offline, traceability, film
  block, rollout and documents. Articles and the demo form reuse
  `HomeMaterials` and `DemoSection`.
- `LineConsole`, `ProductionCycle`, `ProductModes`, `TraceLog`,
  `PlatformModules` and `ImplementationSteps` and their styles are removed.
- `src/styles/home.css` holds the home sections. `landing.css` keeps the shared
  header, footer and form, restyled on tokens so they render correctly in both
  themes (the film page switches the header between them).
- Copy stays in `src/content/ui.ts` (`home`, RU and EN); SEO in
  `src/content/pages.ts`. Within the existing length tests (title 30–70,
  description 100–180):
  - `/` title «ПО для маркировки и агрегации по Честному знаку — Markiro»
    (57), description «Проверка кодов на линии, сборка коробов и паллет,
    печать этикеток и работа без сети. Для соков, молочной продукции, пива,
    косметики и другой маркируемой продукции.» (163);
  - `/en/` title "Serialization and aggregation software for Chestny ZNAK —
    Markiro" (65), description "Code verification on the line, case and
    pallet aggregation, label printing and offline work. For juice, dairy,
    beer, cosmetics and other marked goods." (150).
    The unused `eyebrow` and `introduction` fields of the two home entries are
    rewritten to the same positioning so no beer boundary is left in the data.
- The hotspot projection lives beside the film world code
  (`src/scripts/film/world/`), with its test; the tooltip script in
  `src/scripts/home/`.

## Tests and gates

- `test/rendered-page.test.ts`: the section-id test lists `hero`, `product`,
  `offline`, `traceability`, `film`, `implementation`, `documents`,
  `materials`, `demo`. The product-category test splits: `/` and `/en/` must
  say any marked goods and the product-group check before launch, and must not
  contain «Сейчас — пиво, сидр»; `/sscc-i-agregatsiya/` keeps the current
  assertion until its own redesign.
- `src/content/pages.test.ts` keeps its length rules; title and description
  change for `/` and `/en/`.
- Unit tests: the hotspot projection lands every dot inside the image, in the
  intended area, and in a stable order; the label copies match
  `examples/labels`; the covers match the published releases.
- `tools/production-browser/tests/landing-seo.spec.ts`: hotspots work with the
  keyboard and the pointer; no horizontal overflow at 390, 412 and 1440 px;
  every image has alt text; the home route requests no film chunk and no
  three.js; the existing GTM, consent and demo-form tests pass unchanged.
- `lighthouse-landing.mjs` keeps `/` in `LIGHTHOUSE_ROUTES`.
- The film page's browser tests pass with the restyled shared header.
- `seo.test.ts` product facts and `llms.txt` are updated if they carry the
  beer boundary.

## Out of scope

- Topic pages, articles and instruction pages in the light style, and neutral
  positioning on topic pages, including the beer boundary on
  `/sscc-i-agregatsiya/`.
- A dedicated handheld page.
- Articles for other product groups.
- Client logos, cases and prices.
- A live 3D hero or a video loop of the scene.
- Making the film the home page.

## Open items

- Pick the film moment for the map render; the owner reviews it before the
  hotspots are finalised.
- The landing screen set (demo products, which screens) is reviewed by the
  owner before commit.
- English bullets and captions are reviewed by the owner.
- Handheld capture needs the emulator stand. The design stand-in must not
  ship, so the handheld row waits for a real frame.
- Moving the topic links from the header to the footer changes internal
  linking on every page; check it in the site audit.
