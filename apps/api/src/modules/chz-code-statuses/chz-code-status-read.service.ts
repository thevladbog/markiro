import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { schema, type Db } from "@markiro/db";
import { eq, sql } from "drizzle-orm";

import { DB } from "../../auth/auth.module";
import { describeChannel, type IntegrationChannelType } from "../integrations/channel-registry";
import type { ChzCodeStatusSummaryDto } from "./dto";

/**
 * `describeChannel` throws a plain `Error` for a type not in the registry --
 * fine for code that only ever passes a literal `IntegrationChannelType`, but
 * here `type` comes straight off the URL path, so it can be anything. Mirrors
 * `safeDescribeChannel` in `integrations.service.ts` exactly: a channel type
 * that simply doesn't exist is a 404, not a 500.
 */
function safeDescribeChannel(type: IntegrationChannelType): void {
  try {
    describeChannel(type);
  } catch {
    throw new NotFoundException(`Unknown channel type: ${type}`);
  }
}

/**
 * Backs `GET /integrations/:type/code-statuses` (Task 6). `chz_code_statuses`
 * carries no channel column at all -- see its own doc, packages/db/src/schema/chz.ts:
 * one row per `(tenantId, codeHash)`, not one per integration channel -- so the
 * summary is identical for every registered channel type, `chestny_znak`
 * included. `type` exists here only so an unregistered type still answers 404,
 * the same as `:type/candidates` and `:type/journal` do (`safeDescribeChannel`
 * above); a registered type that isn't `chestny_znak` gets the real summary,
 * just like `:type/candidates` runs its real (if empty) query for any
 * registered channel rather than refusing non-`commerceml` types.
 */
@Injectable()
export class ChzCodeStatusReadService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async summary(tenantId: string, type: IntegrationChannelType): Promise<ChzCodeStatusSummaryDto> {
    safeDescribeChannel(type);

    // A bare aggregate with no GROUP BY always returns exactly one row, even
    // when nothing matches the WHERE clause -- so a tenant that has never run
    // a pass gets a row of zeroes/null here, not an empty result set.
    const [row] = await this.db
      .select({
        total: sql<number>`count(*)`.mapWith(Number),
        refreshedLastDay: sql<number>`count(*) filter (
          where ${schema.chzCodeStatuses.checkedAt} > now() - interval '1 day'
        )`.mapWith(Number),
        withoutProductGroup: sql<number>`count(*) filter (
          where ${schema.chzCodeStatuses.chzProductGroupCode} is null
        )`.mapWith(Number),
        // Unlike `schema.chzCodeStatuses.checkedAt` read through a typed
        // select (which drizzle maps to a JS `Date` via the column's own
        // config), a bare `max(...)` aggregate carries no column mapping --
        // the driver hands back whatever it parses a `timestamptz` into,
        // which is a string here, not a `Date`. `new Date(...)` normalizes
        // either shape before `.toISOString()` below.
        lastCheckedAt: sql<string | null>`max(${schema.chzCodeStatuses.checkedAt})`,
      })
      .from(schema.chzCodeStatuses)
      .where(eq(schema.chzCodeStatuses.tenantId, tenantId));

    return {
      total: row?.total ?? 0,
      refreshedLastDay: row?.refreshedLastDay ?? 0,
      withoutProductGroup: row?.withoutProductGroup ?? 0,
      lastCheckedAt: row?.lastCheckedAt ? new Date(row.lastCheckedAt).toISOString() : null,
    };
  }
}
