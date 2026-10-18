/** Two large cards stay legible on the 1280×800 line terminal, as on the cloud station. */
export const HUB_PAGE_SIZE = 2;

/** The photo's width in px by layout (the design's boards): one card is wide, two share the row. */
const PHOTO_ONE = 520;
const PHOTO_TWO = 260;

export interface HubLayout {
  kind: "empty" | "cards";
  /** Card columns of the page. */
  columns: number;
  /** The photo's width in px at the 1280 px frame; the stylesheet caps it to a share of the card. */
  photo: number;
  pageCount: number;
}

/**
 * How the hub lays its shifts out (owner-approved design, «Смены линии»): 1 shift is one card on
 * the full width, 2 are two columns, 3 and more are pages of two with a pager, nothing scrolls;
 * 0 is the empty state.
 */
export function hubLayout(count: number): HubLayout {
  if (count <= 0) return { kind: "empty", columns: 0, photo: 0, pageCount: 1 };
  if (count === 1) return { kind: "cards", columns: 1, photo: PHOTO_ONE, pageCount: 1 };
  return {
    kind: "cards",
    columns: 2,
    photo: PHOTO_TWO,
    pageCount: Math.ceil(count / HUB_PAGE_SIZE),
  };
}

/** The page shown (clamped where it is read: a shorter list shows its last page) and its slice. */
export function hubPage(
  count: number,
  requested: number,
): { page: number; from: number; to: number } {
  const pageCount = hubLayout(count).pageCount;
  const page = Math.min(Math.max(1, requested), pageCount);
  return {
    page,
    from: Math.min((page - 1) * HUB_PAGE_SIZE, count),
    to: Math.min(page * HUB_PAGE_SIZE, count),
  };
}

export interface ShiftProgress {
  accepted: number;
  planned: number;
  /** 0..1, for the bar. */
  ratio: number;
}

/**
 * «Принято N из M»: only when both counters exist locally. The plan is the shift's snapshot
 * (`plannedQty`); the accepted count is this station's own codes in the shift, so a shift this
 * station never entered has none to show. No plan, or no readable count: no row.
 */
export function shiftProgress(input: {
  plannedQty: number | null;
  accepted: number | null;
  entered: boolean;
}): ShiftProgress | null {
  const { plannedQty, accepted, entered } = input;
  if (plannedQty === null || plannedQty <= 0 || accepted === null || !entered) return null;
  return { accepted, planned: plannedQty, ratio: Math.min(1, accepted / plannedQty) };
}

export interface QueueBadge {
  kind: "none" | "waiting" | "rejected";
  tone: "neutral" | "warn" | "error";
  n: number;
}

/**
 * The count on the hub's queue button: «0» while nothing waits, «N ждут» (a warning) while
 * records wait for the host, «Отклонено N» (an error) once the host refused any. The queue is not
 * a chip of the hub's header, so a refusal must show here. `null` before the outbox was read.
 */
export function queueBadge(status: { unsent: number; rejected: number } | null): QueueBadge | null {
  if (status === null) return null;
  if (status.rejected > 0) return { kind: "rejected", tone: "error", n: status.rejected };
  if (status.unsent > 0) return { kind: "waiting", tone: "warn", n: status.unsent };
  return { kind: "none", tone: "neutral", n: 0 };
}
