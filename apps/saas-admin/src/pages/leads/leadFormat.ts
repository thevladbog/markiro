import type { LandingLeadStatus } from "@markiro/platform-contracts";
import type { TagPhase } from "@markiro/ui";

/**
 * Фаза тега выводится из статуса заявки: новая ждёт первого письма
 * (`planned`, как новая заявка на биллинг), переписка и выставленный счёт —
 * идущий процесс (`running`), пробный период — действующий (`active`),
 * оплата — завершение (`done`), отказ — вывод из оборота (`retired`).
 */
export const LEAD_STATUS_TO_PHASE = {
  new: "planned",
  contacted: "running",
  trial: "active",
  invoice_sent: "running",
  won: "done",
  lost: "retired",
} as const satisfies Record<LandingLeadStatus, TagPhase>;

/** Moscow has kept UTC+3 all year since 2014. */
const MOSCOW_OFFSET_MS = 3 * 60 * 60 * 1000;
const MOSCOW = "Europe/Moscow";

/** A civil next-touch date means 09:00 in Moscow, the time of the daily digest. */
export function moscowTouchInstant(civilDate: string): string {
  return new Date(`${civilDate}T09:00:00+03:00`).toISOString();
}

export function moscowCivilDate(instant: string | null | undefined): string {
  if (!instant) return "";
  return new Date(new Date(instant).getTime() + MOSCOW_OFFSET_MS).toISOString().slice(0, 10);
}

function intlLocale(language: string): string {
  return language.startsWith("en") ? "en-GB" : "ru-RU";
}

export function formatLeadDate(instant: string, language: string): string {
  return new Intl.DateTimeFormat(intlLocale(language), {
    dateStyle: "medium",
    timeZone: MOSCOW,
  }).format(new Date(instant));
}

export function formatLeadDateTime(instant: string, language: string): string {
  return new Intl.DateTimeFormat(intlLocale(language), {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: MOSCOW,
  }).format(new Date(instant));
}

const CYRILLIC_TO_LATIN: Readonly<Record<string, string>> = {
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  д: "d",
  е: "e",
  ё: "e",
  ж: "zh",
  з: "z",
  и: "i",
  й: "y",
  к: "k",
  л: "l",
  м: "m",
  н: "n",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  у: "u",
  ф: "f",
  х: "kh",
  ц: "ts",
  ч: "ch",
  ш: "sh",
  щ: "shch",
  ъ: "",
  ы: "y",
  ь: "",
  э: "e",
  ю: "yu",
  я: "ya",
};

const LEGAL_FORMS = new Set(["ооо", "оао", "зао", "пао", "ао", "ип", "нао", "llc", "ooo"]);
const SLUG_MAX_LENGTH = 128;

/**
 * Slug for «Создать клиента без кабинета»: the INN when the lead has one
 * (unique and stable), otherwise the transliterated company name without its
 * legal form. An empty result leaves the field for the operator to type.
 */
export function suggestLeadTenantSlug(company: string, inn: string | null): string {
  if (inn) return `inn-${inn}`;
  const words = company
    .toLocaleLowerCase("ru")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word && !LEGAL_FORMS.has(word));
  const latin = words
    .map((word) =>
      Array.from(word, (char) => CYRILLIC_TO_LATIN[char] ?? char)
        .join("")
        .replace(/[^a-z0-9]/g, ""),
    )
    .filter(Boolean)
    .join("-");
  return latin.slice(0, SLUG_MAX_LENGTH).replace(/-+$/u, "");
}
