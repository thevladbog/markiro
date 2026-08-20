/**
 * The one place a date becomes PRINTED TEXT.
 *
 * Every date in this system is carried as `YYYY-MM-DD` (or a full UTC ISO
 * instant in storage): it sorts lexicographically, it is what
 * `apps/station/src/lib/box-label.ts`'s calendar arithmetic operates on, and
 * it is unambiguous. But `YYYY-MM-DD` is NOT what a Russian warehouse reads
 * off a box: the customer-approved paper mock-up shows `дд.мм.гггг`, and the
 * first physical print of the stock 58×40 label came back with `2026-08-20`
 * where `20.08.2026` was expected.
 *
 * So the conversion happens HERE, at the display boundary, and nowhere else:
 * storage stays UTC ISO, the shelf-life arithmetic stays on `YYYY-MM-DD`
 * (timezone- and DST-safe as written), and both the station's real print data
 * (`boxLabelFields`) and the admin preview's `sampleLabelData()` route their
 * date field VALUES through this function so preview and print can never
 * disagree about the format.
 */

/** The printed date format, for docs and test names: `дд.мм.гггг`. */
export const LABEL_DATE_FORMAT = "дд.мм.гггг";

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Formats a `YYYY-MM-DD` calendar date as `DD.MM.YYYY` for printing.
 *
 * Tolerant by design, exactly like the callers it serves: a label must never
 * fail to print because of a date, so anything that is not a well-formed
 * `YYYY-MM-DD` (including the empty string the station emits for "no shelf
 * life") is returned UNCHANGED rather than throwing. It performs no calendar
 * validation either — `2025-02-30` is the caller's problem (and
 * `addCalendarDays` already rejects it), not a formatting concern.
 */
export function formatLabelDate(isoDate: string): string {
  const parts = ISO_DATE.exec(isoDate);
  if (!parts) return isoDate;
  const [, year, month, day] = parts;
  return `${day}.${month}.${year}`;
}
