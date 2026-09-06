import type { Locale, SearchPageRecord } from "./pages";

export type HubKind = "articles" | "instructions";
export type HubPath = "/stati/" | "/instruktsii/" | "/en/articles/" | "/en/instructions/";

export interface HubPageDefinition {
  readonly path: HubPath;
  readonly alternatePath: HubPath;
  readonly locale: Locale;
  readonly kind: HubKind;
  readonly title: string;
  readonly description: string;
  readonly heading: string;
  readonly navigationLabel: string;
  readonly eyebrow: string;
  readonly introduction: string;
  readonly socialImage: string;
  readonly socialImageAlt: string;
  readonly reviewedAt: `${number}-${number}-${number}`;
}

const SHARED_IMAGE = "/og-markiro.jpg";

export const HUB_PAGES: readonly HubPageDefinition[] = [
  {
    path: "/stati/",
    alternatePath: "/en/articles/",
    locale: "ru",
    kind: "articles",
    title: "Статьи о маркировке пива и агрегации на линии — Markiro",
    description:
      "Практические статьи Markiro о маркировке пива: Data Matrix, агрегация в короба, SSCC, отчёт о нанесении, работа линии без интернета и выбор оборудования.",
    heading: "Статьи о маркировке пива на производственной линии",
    navigationLabel: "Статьи",
    eyebrow: "Практика маркировки",
    introduction:
      "Разборы реальных задач линии: от Data Matrix, который не считывается, до отчёта о нанесении. Каждая статья описывает проверяемый процесс и отдельно обозначает границу текущего контура Markiro.",
    socialImage: SHARED_IMAGE,
    socialImageAlt: "Markiro — статьи о маркировке пива и агрегации на производственной линии",
    reviewedAt: "2026-09-06",
  },
  {
    path: "/instruktsii/",
    alternatePath: "/en/instructions/",
    locale: "ru",
    kind: "instructions",
    title: "Инструкции Markiro для операторов, наладчиков и менеджеров",
    description:
      "Печатные инструкции Markiro: вход в станцию, цикл сканирования и агрегации, исключения, настройка рабочего места, инвентаризация, планирование и закрытие смены.",
    heading: "Инструкции по работе со станцией и кабинетом Markiro",
    navigationLabel: "Инструкции",
    eyebrow: "Печатные инструкции",
    introduction:
      "Каждая инструкция опубликована как редакция с кодом, датой вступления в силу и неизменяемым PDF/A. Здесь они собраны по рабочим местам: станция сканирования на линии и кабинет производства.",
    socialImage: SHARED_IMAGE,
    socialImageAlt:
      "Markiro — печатные инструкции для станции сканирования и кабинета производства",
    reviewedAt: "2026-09-06",
  },
  {
    path: "/en/articles/",
    alternatePath: "/stati/",
    locale: "en",
    kind: "articles",
    title: "Articles on beer marking and case aggregation — Markiro",
    description:
      "Practical Markiro articles on Russian beer marking: Data Matrix diagnostics, case aggregation, SSCC, application reports, offline lines, and equipment selection.",
    heading: "Articles on beer marking for production lines",
    navigationLabel: "Articles",
    eyebrow: "Serialization practice",
    introduction:
      "Real line problems, from a Data Matrix that will not scan to the code application report. Every article describes a verifiable workflow and states the current Markiro boundary separately.",
    socialImage: SHARED_IMAGE,
    socialImageAlt: "Markiro — articles on beer marking and case aggregation for production lines",
    reviewedAt: "2026-09-06",
  },
  {
    path: "/en/instructions/",
    alternatePath: "/instruktsii/",
    locale: "en",
    kind: "instructions",
    title: "Markiro instructions for station operators and technicians",
    description:
      "Printable Markiro instructions: station sign-in, the scanning and aggregation cycle, exceptions and recovery, workstation setup, and inventory on the terminal.",
    heading: "Instructions for the Markiro scanning station",
    navigationLabel: "Instructions",
    eyebrow: "Printable instructions",
    introduction:
      "Each instruction is published as a revision with a code, an effective date and an immutable PDF/A. English editions are informational translations of the authoritative Russian revisions.",
    socialImage: SHARED_IMAGE,
    socialImageAlt: "Markiro — printable instructions for the scanning station",
    reviewedAt: "2026-09-06",
  },
];

export const HUB_SEARCH_PAGES: readonly SearchPageRecord[] = HUB_PAGES.map((hub) => ({
  path: hub.path,
  alternatePath: hub.alternatePath,
  locale: hub.locale,
  navigationLabel: hub.navigationLabel,
  description: hub.description,
  lastModified: hub.reviewedAt,
}));

export function findHubPage(path: string): HubPageDefinition {
  const hub = HUB_PAGES.find((candidate) => candidate.path === path);
  if (hub === undefined) throw new Error(`Unknown hub page: ${path}`);
  return hub;
}

export function hubPath(locale: Locale, kind: HubKind): HubPath {
  const hub = HUB_PAGES.find((candidate) => candidate.locale === locale && candidate.kind === kind);
  if (hub === undefined) throw new Error(`Unknown hub: ${locale}/${kind}`);
  return hub.path;
}
