import type { Locale, SearchPageRecord } from "./pages";

export type FilmTheme = "light" | "dark";

export type FilmChapterId =
  "district" | "line" | "packing" | "warehouse" | "offline" | "kiosk" | "office";

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
  scrollHint: "Листайте вниз: пройдём по производству от линии до офиса",
  heroSecondary: { label: "Как это работает", href: "#line" },
  finalSecondary: { label: "Как проходит внедрение", href: "/#implementation" },
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
  scrollHint: "Scroll down: we go through production from the line to the office",
  heroSecondary: { label: "How it works", href: "#line" },
  finalSecondary: { label: "How implementation works", href: "/en/#implementation" },
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
