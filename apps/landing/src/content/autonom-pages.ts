import type { SearchPageRecord } from "./pages";

export type AutonomPath = "/skachat/" | "/stoimost/";

export interface AutonomPageDefinition {
  readonly path: AutonomPath;
  readonly locale: "ru";
  readonly title: string;
  readonly description: string;
  readonly navigationLabel: string;
  readonly socialImage: string;
  readonly socialImageAlt: string;
  readonly reviewedAt: `${number}-${number}-${number}`;
}

const SOCIAL_IMAGE = "/og-markiro.jpg";
const SOCIAL_IMAGE_ALT = "Маркиро Автоном: маркировка и агрегация на вашем ПК";
const REVIEWED = "2026-10-21" as const;

export const AUTONOM_PAGES: readonly AutonomPageDefinition[] = [
  {
    path: "/skachat/",
    locale: "ru",
    title: "Скачать Маркиро Автоном для Windows: 14 дней бесплатно",
    description:
      "Установщик Маркиро Автоном для Windows 10 и 11: главный ПК, офис и станция в одном файле. Пробный период 14 дней со всеми функциями, без оплаты и карты.",
    navigationLabel: "Скачать",
    socialImage: SOCIAL_IMAGE,
    socialImageAlt: SOCIAL_IMAGE_ALT,
    reviewedAt: REVIEWED,
  },
  {
    path: "/stoimost/",
    locale: "ru",
    title: "Цены Маркиро Автоном: от 60 000 ₽ в год за площадку",
    description:
      "Четыре тарифа на площадку, оплата за год, все функции в каждом: «Старт» 60 000 ₽, «Линия» 120 000 ₽, «Цех» 240 000 ₽, «Завод» по запросу. Дополнения, запуск и примеры расчёта.",
    navigationLabel: "Цены",
    socialImage: SOCIAL_IMAGE,
    socialImageAlt: SOCIAL_IMAGE_ALT,
    reviewedAt: REVIEWED,
  },
];

export const AUTONOM_SEARCH_PAGES: readonly SearchPageRecord[] = AUTONOM_PAGES.map((page) => ({
  path: page.path,
  locale: page.locale,
  navigationLabel: page.navigationLabel,
  description: page.description,
  lastModified: page.reviewedAt,
}));

export function findAutonomPage(path: AutonomPath): AutonomPageDefinition {
  const page = AUTONOM_PAGES.find((candidate) => candidate.path === path);
  if (page === undefined) throw new Error(`Unknown standalone page: ${path}`);
  return page;
}
