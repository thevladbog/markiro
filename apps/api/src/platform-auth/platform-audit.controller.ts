import { Controller, Get, Query, Req } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { and, desc, eq, gte, like, lte, or } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { platformAuditContracts, type PlatformAuditQuery } from "@markiro/platform-contracts";
import { DB } from "../auth/auth.module";
import { Inject } from "@nestjs/common";
import { PlatformApiProtectedOk } from "../platform-http/platform-openapi";
import { ZodValidationPipe } from "../zod.pipe";
import { RequirePlatformCapabilities } from "./platform-access-policy";
import type { RequestWithPlatformPrincipal } from "./platform-auth.guard";
import { sanitizeAuditMetadata, sanitizeSupportAuditMetadata } from "./platform-audit.service";
import { parsePlatformResponse } from "../platform-http/platform-response";

@ApiTags("platform-auth")
@Controller("platform/audit")
@RequirePlatformCapabilities("audit.read")
export class PlatformAuditController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  @ApiOperation({
    summary: "List platform audit events",
    description:
      "Support and accountant roles see a role-scoped subset of actions with sanitized metadata.",
  })
  @PlatformApiProtectedOk({ response: platformAuditContracts.list.response })
  async list(
    @Req() request: RequestWithPlatformPrincipal,
    @Query(new ZodValidationPipe(platformAuditContracts.list.query)) query: PlatformAuditQuery,
  ) {
    const sanitizeResponseMetadata =
      request.platformPrincipal!.role === "support"
        ? sanitizeSupportAuditMetadata
        : sanitizeAuditMetadata;
    const roleFilter =
      request.platformPrincipal!.role === "support"
        ? or(like(schema.platformAuditEvents.action, "platform.tenant.%"))
        : request.platformPrincipal!.role === "accountant"
          ? or(
              like(schema.platformAuditEvents.action, "payment.%"),
              like(schema.platformAuditEvents.action, "billing.%"),
              like(schema.platformAuditEvents.action, "catalog.%"),
              like(schema.platformAuditEvents.action, "offer.%"),
              like(schema.platformAuditEvents.action, "subscription.%"),
            )
          : undefined;
    const rows = await this.db
      .select()
      .from(schema.platformAuditEvents)
      .where(
        and(
          roleFilter,
          query.tenantId ? eq(schema.platformAuditEvents.tenantId, query.tenantId) : undefined,
          query.actorId
            ? eq(schema.platformAuditEvents.actorPlatformUserId, query.actorId)
            : undefined,
          query.action ? eq(schema.platformAuditEvents.action, query.action) : undefined,
          query.outcome ? eq(schema.platformAuditEvents.outcome, query.outcome) : undefined,
          query.from ? gte(schema.platformAuditEvents.createdAt, query.from) : undefined,
          query.to ? lte(schema.platformAuditEvents.createdAt, query.to) : undefined,
        ),
      )
      .orderBy(desc(schema.platformAuditEvents.createdAt), desc(schema.platformAuditEvents.id))
      .limit(query.limit)
      .offset(query.offset);

    return parsePlatformResponse(platformAuditContracts.list.response, {
      items: rows.map((row) => ({
        ...row,
        before: sanitizeResponseMetadata(row.before),
        after: sanitizeResponseMetadata(row.after),
      })),
      nextOffset: rows.length === query.limit ? query.offset + query.limit : null,
    });
  }
}
