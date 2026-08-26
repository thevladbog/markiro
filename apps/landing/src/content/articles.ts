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

export const ARTICLE_SEARCH_PAGES: readonly SearchPageRecord[] = [BEER_CASE_AGGREGATION_ARTICLE];
