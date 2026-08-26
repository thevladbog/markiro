import type { SearchPageRecord } from "./pages";

export interface ArticlePageDefinition extends SearchPageRecord {
  readonly title: string;
  readonly heading: string;
  readonly eyebrow: string;
  readonly introduction: string;
  readonly socialImage: string;
  readonly socialImageAlt: string;
  readonly publishedAt: `${number}-${number}-${number}`;
  readonly modifiedAt: `${number}-${number}-${number}`;
  readonly authorName: string;
  readonly readingTimeMinutes: number;
  readonly ogType: "article";
}

export const BEER_CASE_AGGREGATION_ARTICLE = {
  path: "/stati/agregatsiya-piva-v-koroba/",
  alternatePath: "/en/articles/beer-case-aggregation/",
  locale: "ru",
  title: "Агрегация пива в короба без остановки линии — Markiro",
  heading: "Агрегация пива в короба: как не остановить производственную линию",
  eyebrow: "Практика маркировки на линии",
  introduction:
    "Основные сложности маркировки начинаются не при заказе кодов, а на линии: повторный скан, незакрытый короб, сбой печати или потеря сети. Разбираем рабочий процесс, который сохраняет темп упаковки и прослеживаемость операций.",
  navigationLabel: "Агрегация пива в короба",
  description:
    "Как организовать агрегацию пива в короба: проверка Data Matrix, SSCC, повторная печать, офлайн-работа и восстановление без остановки линии.",
  socialImage: "/og-beer-case-aggregation.jpg",
  socialImageAlt: "Markiro — агрегация пива в короба на производственной линии",
  publishedAt: "2026-08-26",
  modifiedAt: "2026-08-26",
  authorName: "Команда Markiro",
  readingTimeMinutes: 8,
  ogType: "article",
  lastModified: "2026-08-26",
} as const satisfies ArticlePageDefinition;

export const BEER_MARKING_2026_ARTICLE = {
  path: "/stati/markirovka-piva-2026/",
  alternatePath: "/en/articles/beer-marking-2026/",
  locale: "ru",
  title: "Маркировка пива в 2026 году: чек-лист производителя — Markiro",
  heading: "Маркировка пива в 2026 году: что проверить производителю на линии",
  eyebrow: "Требования и готовность производства",
  introduction:
    "Основные этапы обязательной маркировки уже действуют. В 2026 году производителю важно проверить не только личный кабинет и документы, но и реальную готовность линии: данные, нанесение, агрегацию, восстановление после сбоев и передачу подтверждённых результатов во внешние системы.",
  navigationLabel: "Маркировка пива в 2026 году",
  description:
    "Маркировка пива в 2026 году: действующие требования, адаптационный период и практический чек-лист готовности производственной линии.",
  socialImage: "/og-beer-marking-2026.jpg",
  socialImageAlt: "Markiro — проверка готовности линии маркировки пива в 2026 году",
  publishedAt: "2026-08-26",
  modifiedAt: "2026-08-26",
  authorName: "Команда Markiro",
  readingTimeMinutes: 6,
  ogType: "article",
  lastModified: "2026-08-26",
} as const satisfies ArticlePageDefinition;

export const BEER_CASE_AGGREGATION_ARTICLE_EN = {
  path: "/en/articles/beer-case-aggregation/",
  alternatePath: "/stati/agregatsiya-piva-v-koroba/",
  locale: "en",
  title: "Beer case aggregation for Russian traceability — Markiro",
  heading: "Beer case aggregation: keeping a packaging line running",
  eyebrow: "Production-line serialization practice",
  introduction:
    "The hardest marking problems rarely begin when codes are ordered. They appear on the line: a duplicate scan, an unfinished case, a failed print job, or a network outage. This guide explains a workflow that preserves both packing throughput and traceability.",
  navigationLabel: "Beer case aggregation",
  description:
    "How to aggregate beer into cases for Russian traceability: Data Matrix checks, SSCC, reprinting, offline operation, and controlled recovery.",
  socialImage: "/og-beer-case-aggregation.jpg",
  socialImageAlt: "Markiro — beer case aggregation on a production line",
  publishedAt: "2026-08-26",
  modifiedAt: "2026-08-26",
  authorName: "Markiro team",
  readingTimeMinutes: 7,
  ogType: "article",
  lastModified: "2026-08-26",
} as const satisfies ArticlePageDefinition;

export const BEER_MARKING_2026_ARTICLE_EN = {
  path: "/en/articles/beer-marking-2026/",
  alternatePath: "/stati/markirovka-piva-2026/",
  locale: "en",
  title: "Beer marking in Russia in 2026: line-readiness checklist — Markiro",
  heading: "Beer marking in Russia in 2026: what manufacturers should verify on the line",
  eyebrow: "Requirements and production readiness",
  introduction:
    "The main mandatory-marking stages are already in force. In 2026, a manufacturer must verify more than an account and its documents: product data, code application, aggregation, recovery after failures, and the transfer of confirmed results to external systems all have to work as one process.",
  navigationLabel: "Beer marking in Russia in 2026",
  description:
    "Beer marking in Russia in 2026: current requirements, the adaptation period, and a practical production-line readiness checklist.",
  socialImage: "/og-beer-marking-2026.jpg",
  socialImageAlt: "Markiro — production-line readiness for beer marking in Russia in 2026",
  publishedAt: "2026-08-26",
  modifiedAt: "2026-08-26",
  authorName: "Markiro team",
  readingTimeMinutes: 6,
  ogType: "article",
  lastModified: "2026-08-26",
} as const satisfies ArticlePageDefinition;

export const BEER_DATAMATRIX_DIAGNOSTICS_ARTICLE = {
  path: "/stati/data-matrix-pivo-ne-schityvaetsya/",
  alternatePath: "/en/articles/beer-data-matrix-not-scanning/",
  locale: "ru",
  title: "Data Matrix на пиве не считывается: диагностика — Markiro",
  heading: "Почему Data Matrix на пиве не считывается: диагностика от печати до ПО",
  eyebrow: "Диагностика на производственной линии",
  introduction:
    "Одинаковое сообщение «код не читается» может означать четыре разных сбоя: камера не распознала символ, сканер изменил поток данных, программа отклонила формат или внешняя система не приняла статус. Разбираем порядок проверки, который быстро локализует причину.",
  navigationLabel: "Диагностика Data Matrix на пиве",
  description:
    "Почему Data Matrix на пиве не считывается: проверка печати и тары, настроек сканера, GS-разделителя, формата кода и производственного ПО.",
  socialImage: "/og-beer-datamatrix-diagnostics.jpg",
  socialImageAlt: "Markiro — диагностика чтения Data Matrix на бутылке пива",
  publishedAt: "2026-08-26",
  modifiedAt: "2026-08-26",
  authorName: "Команда Markiro",
  readingTimeMinutes: 9,
  ogType: "article",
  lastModified: "2026-08-26",
} as const satisfies ArticlePageDefinition;

export const BEER_DATAMATRIX_DIAGNOSTICS_ARTICLE_EN = {
  path: "/en/articles/beer-data-matrix-not-scanning/",
  alternatePath: "/stati/data-matrix-pivo-ne-schityvaetsya/",
  locale: "en",
  title: "Beer Data Matrix not scanning: production diagnosis — Markiro",
  heading: "Beer Data Matrix not scanning: diagnose print, scanner, and software",
  eyebrow: "Production-line troubleshooting",
  introduction:
    "The message “code not read” can describe four different failures: the symbol was not decoded, the scanner altered the byte stream, line software rejected the payload, or an external system rejected its state. This guide gives each layer a separate test and next action.",
  navigationLabel: "Beer Data Matrix diagnostics",
  description:
    "Diagnose a beer Data Matrix that will not scan: print and packaging, scanner configuration, GS separators, payload validation, and production software.",
  socialImage: "/og-beer-datamatrix-diagnostics.jpg",
  socialImageAlt: "Markiro — diagnosing a Data Matrix scan on a beer bottle",
  publishedAt: "2026-08-26",
  modifiedAt: "2026-08-26",
  authorName: "Markiro team",
  readingTimeMinutes: 9,
  ogType: "article",
  lastModified: "2026-08-26",
} as const satisfies ArticlePageDefinition;

export const BEER_MARKING_EQUIPMENT_ARTICLE = {
  path: "/stati/oborudovanie-dlya-markirovki-piva/",
  alternatePath: "/en/articles/beer-marking-line-equipment/",
  locale: "ru",
  title: "Оборудование для маркировки пива: состав линии — Markiro",
  heading: "Оборудование для маркировки пива: что нужно линии и как проверить совместимость",
  eyebrow: "Проектирование производственной линии",
  introduction:
    "Готового универсального списка оборудования не существует: состав линии зависит от тары, способа нанесения, скорости, агрегации и допустимого уровня ручных операций. Разбираем функции каждого узла и приёмочные испытания до покупки.",
  navigationLabel: "Оборудование для маркировки пива",
  description:
    "Как выбрать оборудование для маркировки пива: принтер, сканер, камера, верификатор, отбраковка, агрегация, интерфейсы и проверка на линии.",
  socialImage: "/og-beer-marking-equipment.jpg",
  socialImageAlt: "Markiro — оборудование линии маркировки пива",
  publishedAt: "2026-08-26",
  modifiedAt: "2026-08-26",
  authorName: "Команда Markiro",
  readingTimeMinutes: 10,
  ogType: "article",
  lastModified: "2026-08-26",
} as const satisfies ArticlePageDefinition;

export const BEER_MARKING_EQUIPMENT_ARTICLE_EN = {
  path: "/en/articles/beer-marking-line-equipment/",
  alternatePath: "/stati/oborudovanie-dlya-markirovki-piva/",
  locale: "en",
  title: "Beer marking line equipment for Russia — Markiro",
  heading: "Beer marking line equipment for Russia: functions, interfaces, and acceptance tests",
  eyebrow: "Production-line engineering",
  introduction:
    "There is no universal equipment list for Russian beer marking. The right line depends on packaging, code-application method, speed, aggregation, and the permitted level of manual handling. This guide maps the functions and acceptance tests before purchase.",
  navigationLabel: "Beer marking line equipment",
  description:
    "Plan beer marking line equipment for Russia: printer, scanner, machine vision, verifier, rejection, aggregation, interfaces, and factory acceptance tests.",
  socialImage: "/og-beer-marking-equipment.jpg",
  socialImageAlt: "Markiro — beer marking line equipment for Russia",
  publishedAt: "2026-08-26",
  modifiedAt: "2026-08-26",
  authorName: "Markiro team",
  readingTimeMinutes: 10,
  ogType: "article",
  lastModified: "2026-08-26",
} as const satisfies ArticlePageDefinition;

export const BEER_MARKING_COST_ARTICLE = {
  path: "/stati/stoimost-markirovki-piva/",
  alternatePath: "/en/articles/beer-marking-cost-russia/",
  locale: "ru",
  title: "Стоимость маркировки пива: бюджет запуска — Markiro",
  heading: "Сколько стоит маркировка пива: как запустить линию без лишних затрат",
  eyebrow: "Экономика небольшого производства",
  introduction:
    "Маркировка пива не обязана превращаться в проект с космическим бюджетом. Стоимость можно удержать под контролем, если отделить обязательный рабочий контур от автоматизации, которая понадобится только после роста скорости и объёма.",
  navigationLabel: "Стоимость маркировки пива",
  description:
    "Из чего складывается стоимость маркировки пива и как запустить небольшую линию без лишнего оборудования: коды, принтер, сканер, ПО и поэтапный бюджет.",
  socialImage: "/og-beer-marking-cost.jpg",
  socialImageAlt: "Markiro — доступное рабочее место маркировки для небольшой пивоварни",
  publishedAt: "2026-08-26",
  modifiedAt: "2026-08-26",
  authorName: "Команда Markiro",
  readingTimeMinutes: 9,
  ogType: "article",
  lastModified: "2026-08-26",
} as const satisfies ArticlePageDefinition;

export const BEER_MARKING_COST_ARTICLE_EN = {
  path: "/en/articles/beer-marking-cost-russia/",
  alternatePath: "/stati/stoimost-markirovki-piva/",
  locale: "en",
  title: "Beer marking cost in Russia: staged launch — Markiro",
  heading: "Beer marking cost in Russia: how to start without overbuilding the line",
  eyebrow: "Economics for smaller producers",
  introduction:
    "Russian beer marking does not have to begin as an oversized capital project. A producer can control the budget by separating the minimum reliable production loop from automation that becomes useful only at higher speed and volume.",
  navigationLabel: "Beer marking cost in Russia",
  description:
    "Understand beer marking cost in Russia: codes, printer, scanner, software, integration, consumables, and a staged launch for smaller producers.",
  socialImage: "/og-beer-marking-cost.jpg",
  socialImageAlt: "Markiro — an accessible beer marking workstation for a smaller producer",
  publishedAt: "2026-08-26",
  modifiedAt: "2026-08-26",
  authorName: "Markiro team",
  readingTimeMinutes: 9,
  ogType: "article",
  lastModified: "2026-08-26",
} as const satisfies ArticlePageDefinition;

export const ARTICLE_SEARCH_PAGES: readonly SearchPageRecord[] = [
  BEER_CASE_AGGREGATION_ARTICLE,
  BEER_MARKING_2026_ARTICLE,
  BEER_DATAMATRIX_DIAGNOSTICS_ARTICLE,
  BEER_MARKING_EQUIPMENT_ARTICLE,
  BEER_MARKING_COST_ARTICLE,
  BEER_CASE_AGGREGATION_ARTICLE_EN,
  BEER_MARKING_2026_ARTICLE_EN,
  BEER_DATAMATRIX_DIAGNOSTICS_ARTICLE_EN,
  BEER_MARKING_EQUIPMENT_ARTICLE_EN,
  BEER_MARKING_COST_ARTICLE_EN,
];
