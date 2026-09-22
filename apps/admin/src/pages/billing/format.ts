import type { TagPhase } from "@markiro/ui";

import type { TenantServicePeriodState } from "./api.js";

/**
 * Общая для `ServicePeriodsPage` и `ServicePeriodDetailPage` фаза чипа
 * периода обслуживания. Фактический union состояний — `upcoming` | `active`
 * | `expired` (сверено с `apps/api/src/modules/service-periods/
 * service-period-read-model.ts`, `servicePeriodState`); список периодов не
 * фильтруется по состоянию, поэтому все три доходят до экрана.
 *
 * `upcoming` («Предстоящий») ещё не начался — `planned`, а не вывод из
 * оборота. `expired` («Завершён») закончился штатно — `done`. `active`
 * идёт прямо сейчас — `active`, если только лимит минут ещё не выбран
 * (`exhausted`): тогда период по-прежнему активен, но требует внимания —
 * `attention`, отдельная подпись «Пакет исчерпан».
 */
export function servicePeriodPhase(state: TenantServicePeriodState, exhausted: boolean): TagPhase {
  switch (state) {
    case "upcoming":
      return "planned";
    case "active":
      return exhausted ? "attention" : "active";
    case "expired":
      return "done";
  }
}

/** Formats a strict API money amount without leaking Intl failures into billing pages. */
export function formatMoney(
  value: string | number | null,
  currency: string,
  locale: string,
): string {
  if (value === null) return "—";
  const amount = typeof value === "string" ? Number(value) : value;
  if (
    (typeof value === "string" && (!value.trim() || !/^\d+(?:\.\d+)?$/.test(value))) ||
    !Number.isFinite(amount) ||
    amount < 0 ||
    !/^[A-Z]{3}$/.test(currency)
  ) {
    return "—";
  }

  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency }).format(amount);
  } catch {
    try {
      return new Intl.NumberFormat("ru-RU", { style: "currency", currency }).format(amount);
    } catch {
      return "—";
    }
  }
}

/** Formats a strict API ISO date while keeping invalid or absent values explicit. */
export function formatBillingDate(value: string | null, locale: string): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";

  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(date);
  } catch {
    return new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium" }).format(date);
  }
}

/** Event history requires both the local date and time to preserve chronology visibly. */
export function formatBillingDateTime(value: string, locale: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
      date,
    );
  } catch {
    return new Intl.DateTimeFormat("ru-RU", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(date);
  }
}
