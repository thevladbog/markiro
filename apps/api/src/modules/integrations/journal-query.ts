import { BadRequestException } from "@nestjs/common";

import type { ListJournalQueryDto } from "./dto.js";

const DAY_MS = 86_400_000;

export const JOURNAL_DEFAULT_PAGE_SIZE = 20;
export const JOURNAL_MAX_RANGE_DAYS = 90;
export const JOURNAL_ITEM_EVENTS_PER_SESSION_LIMIT = 20;

export interface ResolvedJournalQuery {
  page: number;
  pageSize: number;
  outcome: ListJournalQueryDto["outcome"];
  direction: ListJournalQueryDto["direction"];
  from: Date;
  to: Date;
}

export function resolveJournalQuery(
  query: ListJournalQueryDto,
  now: Date,
): ResolvedJournalQuery {
  const to = query.to ?? now;
  const from = query.from ?? new Date(to.getTime() - 30 * DAY_MS);

  if (from > to || to.getTime() - from.getTime() > JOURNAL_MAX_RANGE_DAYS * DAY_MS) {
    throw new BadRequestException({ code: "INTEGRATION_JOURNAL_DATE_RANGE_INVALID" });
  }

  return {
    page: query.page,
    pageSize: query.pageSize,
    outcome: query.outcome,
    direction: query.direction,
    from,
    to,
  };
}
