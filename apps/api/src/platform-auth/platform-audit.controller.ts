import { Controller, Get, Query, Req } from "@nestjs/common";
import { and, desc, eq, gte, like, lte, or } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { z } from "zod";
import { DB } from "../auth/auth.module";
import { Inject } from "@nestjs/common";
import { ZodValidationPipe } from "../zod.pipe";
import { RequirePlatformCapabilities } from "./platform-access-policy";
import type { RequestWithPlatformPrincipal } from "./platform-auth.guard";
import { sanitizeAuditMetadata, sanitizeSupportAuditMetadata } from "./platform-audit.service";

const auditQuerySchema = z.object({
  tenantId: z.string().trim().min(1).max(128).optional(),
  actorId: z.string().trim().min(1).max(128).optional(),
  action: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^[a-z0-9_.-]+$/)
    .optional(),
  outcome: z.enum(["success", "failed", "denied"]).optional(),
  from: z.iso
    .datetime()
    .transform((value) => new Date(value))
    .optional(),
  to: z.iso
    .datetime()
    .transform((value) => new Date(value))
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
});
type AuditQuery = z.infer<typeof auditQuerySchema>;

@Controller("platform/audit")
@RequirePlatformCapabilities("audit.read")
export class PlatformAuditController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  async list(
    @Req() request: RequestWithPlatformPrincipal,
    @Query(new ZodValidationPipe(auditQuerySchema)) query: AuditQuery,
  ) {
    const sanitizeResponseMetadata =
      request.platformPrincipal!.role === "support"
        ? sanitizeSupportAuditMetadata
        : sanitizeAuditMetadata;
    const roleFilter =
      request.platformPrincipal!.role === "support"
        ? or(
            like(schema.platformAuditEvents.action, "platform.tenant.%"),
            like(schema.platformAuditEvents.action, "tenant.%"),
          )
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

    return {
      items: rows.map((row) => ({
        ...row,
        before: sanitizeResponseMetadata(row.before),
        after: sanitizeResponseMetadata(row.after),
      })),
      nextOffset: rows.length === query.limit ? query.offset + query.limit : null,
    };
  }
}
