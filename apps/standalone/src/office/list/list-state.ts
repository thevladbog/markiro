/** What a list shows in the place of its rows (or its rows). */
export type ListViewState = "loading" | "error" | "empty" | "nothing" | "rows";

export interface ListViewInput {
  /** The first read is still on its way. */
  pending: boolean;
  /** The read failed (and no earlier data is shown). */
  failed: boolean;
  /** Every row the list has, before the filters. */
  total: number;
  /** The rows the filters keep. */
  found: number;
}

/**
 * The one choice of a list's state: loading first (a retry in flight is not an error yet), then
 * the error, then «пусто» (the list has no rows at all, so a filter cannot help), then
 * «ничего не найдено» (the filters hide every row), else the rows.
 */
export function listViewState({ pending, failed, total, found }: ListViewInput): ListViewState {
  if (pending) return "loading";
  if (failed) return "error";
  if (total === 0) return "empty";
  if (found === 0) return "nothing";
  return "rows";
}
