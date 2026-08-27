/**
 * Formats a civil date (`yyyy-mm-dd`) for operator-facing UI in the station
 * locale (`ru` renders as `дд.мм.гггг`). The UTC anchor keeps the calendar day
 * stable regardless of the terminal's timezone.
 */
export function formatCivilDate(value: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { timeZone: "UTC" }).format(
    new Date(`${value}T00:00:00.000Z`),
  );
}
