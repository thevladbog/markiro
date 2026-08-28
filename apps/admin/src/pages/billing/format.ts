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
