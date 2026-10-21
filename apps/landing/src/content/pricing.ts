/**
 * Published prices of «Маркиро Автоном», per site and year, without VAT (the seller
 * is on НПД). Source: spec `2026-10-20-standalone-download-trial-pricing-design.md`,
 * sections 3.2–3.5. The home page, /stoimost/ and the Product/Offer JSON-LD all read
 * this module, so a price changes in one place.
 */

export const TARIFF_CODES = ["start", "line", "workshop", "plant"] as const;
export type TariffCode = (typeof TARIFF_CODES)[number];

export interface Tariff {
  readonly code: TariffCode;
  readonly name: string;
  readonly audience: string;
  /** Yearly price in roubles; `null` for «Завод», which is priced on request. */
  readonly pricePerYear: number | null;
  /** The «from» price used in structured data and comparisons when `pricePerYear` is null. */
  readonly priceFrom: number;
  readonly features: readonly string[];
  readonly recommended?: true;
}

export const TARIFFS: readonly Tariff[] = [
  {
    code: "start",
    name: "Старт",
    audience: "одна линия, один компьютер",
    pricePerYear: 60_000,
    priceFrom: 60_000,
    features: ["1 линия", "1 рабочее место", "2 пользователя офиса", "ответ до 2 рабочих дней"],
  },
  {
    code: "line",
    name: "Линия",
    audience: "Линия и склад с ТСД",
    pricePerYear: 120_000,
    priceFrom: 120_000,
    features: [
      "1 линия",
      "2 рабочих места: станция и ТСД",
      "3 пользователя офиса",
      "Ответ в тот же рабочий день",
      "Докупаются места и линии",
    ],
    recommended: true,
  },
  {
    code: "workshop",
    name: "Цех",
    audience: "До трёх линий",
    pricePerYear: 240_000,
    priceFrom: 240_000,
    features: [
      "3 линии",
      "5 рабочих мест",
      "10 пользователей офиса",
      "Логотип на этикетках и формах",
      "Ответ в тот же рабочий день",
    ],
  },
  {
    code: "plant",
    name: "Завод",
    audience: "От четырёх линий",
    pricePerYear: null,
    priceFrom: 400_000,
    features: ["Линии и места по договору", "Запуск на площадке", "Условия поддержки по договору"],
  },
];

export function findTariff(code: TariffCode): Tariff {
  const tariff = TARIFFS.find((candidate) => candidate.code === code);
  if (tariff === undefined) throw new Error(`Unknown tariff ${code}`);
  return tariff;
}

/** Seats left in the «first 10 sites» offer. Edited by hand as sites sign up. */
export const FIRST_SITES_SEATS_LEFT = 10;
export const FIRST_SITES_DISCOUNT_PERCENT = 30;

export interface PriceLine {
  readonly name: string;
  readonly price: string;
  readonly note: string;
}

export const ADDONS: readonly PriceLine[] = [
  {
    name: "Рабочее место",
    price: "30 000 ₽/год",
    note: "Ещё одна станция у линии или ещё один ТСД на складе.",
  },
  {
    name: "Линия с рабочим местом",
    price: "60 000 ₽/год",
    note: "Новая линия в программе и станция для неё.",
  },
  {
    name: "Логотип для «Линии»",
    price: "15 000 ₽/год",
    note: "Ваш логотип на этикетках коробов и печатных формах. В «Цехе» уже включён.",
  },
];

export const LAUNCH_OPTIONS: readonly PriceLine[] = [
  {
    name: "Самостоятельно",
    price: "0 ₽",
    note: "Инструкции, демо-данные и один бесплатный созвон в пробный период.",
  },
  {
    name: "Удалённый запуск",
    price: "30 000 ₽",
    note: "Установка главного ПК, станции и ТСД, шаблон этикетки и первая смена по видеосвязи.",
  },
  {
    name: "Запуск на площадке",
    price: "90 000 ₽ + дорога",
    note: "Два дня на вашем производстве: оборудование, сеть, обучение операторов.",
  },
];

/** Short rules under the home page price grid. */
export const PRICE_TERMS: readonly string[] = [
  "Цены за площадку в год, без НДС.",
  "Оплата по счёту; договор-оферта.",
  "При переходе на другой тариф остаток засчитывается.",
  "После срока смена не прерывается: данные и выгрузки доступны.",
];

const RUB = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0, useGrouping: true });

/** «120 000» with a regular space, so monospace digits line up and copy-paste stays plain. */
export function formatRoubles(value: number): string {
  return RUB.format(value).replace(/\s/g, " ");
}

export function monthlyEquivalent(pricePerYear: number): number {
  return Math.round(pricePerYear / 12);
}

export function discountedFirstYear(pricePerYear: number): number {
  return Math.round((pricePerYear * (100 - FIRST_SITES_DISCOUNT_PERCENT)) / 100);
}
