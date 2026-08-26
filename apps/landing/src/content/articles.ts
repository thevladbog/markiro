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

export const ARTICLE_SEARCH_PAGES: readonly SearchPageRecord[] = [
  BEER_CASE_AGGREGATION_ARTICLE,
  BEER_MARKING_2026_ARTICLE,
  BEER_CASE_AGGREGATION_ARTICLE_EN,
  BEER_MARKING_2026_ARTICLE_EN,
];
