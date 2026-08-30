import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { schema, type Db } from "@markiro/db";
import { eq, sql } from "drizzle-orm";

import { DB } from "../../auth/auth.module";
import { describeChannel, type IntegrationChannelType } from "../integrations/channel-registry";
import { CHZ_CHANNEL_TYPE } from "../signer-agents/chz-constants";
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
 * one row per `(tenantId, codeHash)`, not one per integration channel. That
 * does NOT mean any registered channel should get this summary, though: the
 * data is Chestny ZNAK's, and answering it for e.g. `commerceml` would hand
 * that channel's own freshness line ЧЗ's numbers, which have nothing to do
 * with it.
 *
 * So `type` is checked twice, the same shape `IntegrationsService.issueCredentials`/
 * `deleteChannel` already use for narrowing a route to the one channel that
 * supports it: `safeDescribeChannel` first, 404 for a type the registry has
 * never heard of at all (mirrors `:type/candidates` and `:type/journal`);
 * then a 409 `ConflictException` for a type that IS registered but isn't
 * `chestny_znak` -- the same "channel exists, but this action does not apply
 * to it" shape `usesExchangeCredentials` already uses there, rather than a
 * blanket 404 that would also hide a genuinely unknown type behind the same
 * status code.
 */
@Injectable()
export class ChzCodeStatusReadService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async summary(tenantId: string, type: IntegrationChannelType): Promise<ChzCodeStatusSummaryDto> {
    safeDescribeChannel(type);
    if (type !== CHZ_CHANNEL_TYPE) {
      throw new ConflictException("Channel does not carry Chestny ZNAK code statuses");
    }

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
