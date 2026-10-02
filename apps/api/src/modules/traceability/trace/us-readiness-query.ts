import {
  traceabilityCivilDateSchema,
  usReadinessQuerySchema,
  type UsProfileCode,
  type UsReadinessQuery,
  type UsReadinessScope,
} from "@markiro/platform-contracts";
import { BadRequestException } from "@nestjs/common";

const invalidQuery = () => new BadRequestException({ code: "us_invalid_query" });

/** Controller rejects duplicate URL keys before passing the raw query object. */
export function parseUsReadinessQuery(raw: unknown): UsReadinessQuery {
  const parsed = usReadinessQuerySchema.safeParse(raw);
  if (!parsed.success) throw invalidQuery();
  return parsed.data;
}

/** The caller supplies the authorized tenant's civil day, never a UTC event instant. */
export function resolveUsReadinessScope(
  query: UsReadinessQuery,
  tenantToday: string,
  profileCode: UsProfileCode,
): UsReadinessScope {
  const day = traceabilityCivilDateSchema.parse(tenantToday);
  if (query.eventDateFrom !== undefined && query.eventDateTo !== undefined)
    return {
      eventDateFrom: query.eventDateFrom,
      eventDateTo: query.eventDateTo,
      productId: query.productId ?? null,
      lotId: query.lotId ?? null,
      profileCode,
      defaulted: false,
    };

  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7));
  // Civil YYYY starts at 0001-01 (month index 12); earlier months cannot be returned.
  const firstMonthIndex = Math.max(12, year * 12 + (month - 1) - 23);
  const firstYear = Math.floor(firstMonthIndex / 12);
  const firstMonth = firstMonthIndex - firstYear * 12 + 1;
  const from = `${String(firstYear).padStart(4, "0")}-${String(firstMonth).padStart(2, "0")}-01`;
  return {
    eventDateFrom: from,
    eventDateTo: day,
    productId: query.productId ?? null,
    lotId: query.lotId ?? null,
    profileCode,
    defaulted: true,
  };
}
