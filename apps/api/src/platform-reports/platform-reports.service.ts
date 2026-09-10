import {
  BadRequestException,
  ConflictException,
  GoneException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { schema, type Db } from "@markiro/db";
import {
  platformReportContracts,
  platformReportInputSchema,
  platformReportSchema,
  type PlatformReportInput,
} from "@markiro/platform-contracts";
import { and, asc, desc, eq, inArray, ilike } from "drizzle-orm";
import { DB } from "../auth/auth.module";
import {
  platformCapabilitiesForRole,
  type PlatformPrincipal,
} from "../platform-auth/platform-access-policy";
import { PlatformAuditService } from "../platform-auth/platform-audit.service";
import { ObjectStorageService } from "../modules/storage/object-storage.service";
import { PgBossService } from "../jobs/jobs.module";
import { requireReportCreator } from "./report-access";
import { validateReportFilters } from "./report-query";
import { PlatformReportSourceError } from "./report-definitions";

type Report = typeof schema.platformReports.$inferSelect;
@Injectable()
export class PlatformReportsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: PlatformAuditService,
    private readonly storage: ObjectStorageService,
    private readonly jobs: PgBossService,
  ) {}

  async create(principal: PlatformPrincipal, raw: unknown) {
    const parsed = platformReportContracts.create.body.safeParse(raw);
    if (!parsed.success) throw new BadRequestException("REPORT_INVALID_PARAMETERS");
    const { idempotencyKey, ...parameters } = parsed.data;
    const row = await this.db.transaction(async (tx) => {
      const user = await requireReportCreator(
        tx,
        principal.userId,
        "reports.create",
        parameters.privacy === "identified" || !!parameters.operatorId,
      );
      const identity = and(
        eq(schema.platformReports.createdByPlatformUserId, user.id),
        eq(schema.platformReports.idempotencyKey, idempotencyKey),
      );
      const [committed] = await tx.select().from(schema.platformReports).where(identity);
      if (committed) {
        if (canonical(committed.parameters) !== canonical(parameters))
          throw new ConflictException("Idempotency parameters differ");
        return committed;
      }
      const tenants = await tx
        .select({ id: schema.organization.id })
        .from(schema.organization)
        .where(inArray(schema.organization.id, parameters.tenantIds));
      if (tenants.length !== parameters.tenantIds.length)
        throw new BadRequestException("REPORT_INVALID_PARAMETERS");
      try {
        await validateReportFilters(tx, parameters);
      } catch (error) {
        if (error instanceof PlatformReportSourceError)
          throw new BadRequestException("REPORT_INVALID_PARAMETERS");
        throw error;
      }
      const [inserted] = await tx
        .insert(schema.platformReports)
        .values({
          createdByPlatformUserId: user.id,
          parameters,
          idempotencyKey,
          expiresAt: new Date(Date.now() + 7 * 86400_000),
        })
        .onConflictDoNothing({
          target: [
            schema.platformReports.createdByPlatformUserId,
            schema.platformReports.idempotencyKey,
          ],
        })
        .returning();
      if (!inserted) {
        const [existing] = await tx.select().from(schema.platformReports).where(identity);
        if (!existing || canonical(existing.parameters) !== canonical(parameters))
          throw new ConflictException("Idempotency parameters differ");
        return existing;
      }
      await tx
        .insert(schema.platformReportTenants)
        .values(parameters.tenantIds.map((tenantId) => ({ reportId: inserted.id, tenantId })));
      await this.audit.record(tx, {
        actorPlatformUserId: user.id,
        actorRole: user.role,
        action: "platform.report.created",
        outcome: "success",
        tenantId: parameters.tenantIds.length === 1 ? parameters.tenantIds[0]! : null,
        targetType: "platform_report",
        targetId: inserted.id,
        reason: null,
        before: null,
        after: { tenantIds: parameters.tenantIds },
        requestId: null,
      });
      return inserted;
    });
    // A queue outage cannot turn a committed intent into a false client failure.
    await this.jobs.wakePlatformReports().catch(() => undefined);
    return publicReport(row, principal.capabilities.includes("reports.identified"));
  }

  async list(principal: PlatformPrincipal, query: { limit: number; offset: number }) {
    const user = await requireReportCreator(this.db, principal.userId, "reports.read", false);
    const identified =
      principal.capabilities.includes("reports.identified") &&
      platformCapabilitiesForRole(user.role).includes("reports.identified");
    const rows = await this.db
      .select()
      .from(schema.platformReports)
      .where(eq(schema.platformReports.createdByPlatformUserId, principal.userId))
      .orderBy(desc(schema.platformReports.createdAt), desc(schema.platformReports.id))
      .limit(query.limit + 1)
      .offset(query.offset);
    return {
      items: rows.slice(0, query.limit).map((row) => publicReport(row, identified)),
      nextOffset: rows.length > query.limit ? query.offset + query.limit : null,
    };
  }

  async download(principal: PlatformPrincipal, id: string) {
    await requireReportCreator(this.db, principal.userId, "reports.download", false);
    const [row] = await this.db
      .select()
      .from(schema.platformReports)
      .where(
        and(
          eq(schema.platformReports.id, id),
          eq(schema.platformReports.createdByPlatformUserId, principal.userId),
        ),
      );
    if (!row) throw new NotFoundException();
    const parameters = platformReportInputSchema.parse(row.parameters);
    const user = await requireReportCreator(
      this.db,
      principal.userId,
      "reports.download",
      parameters.privacy === "identified",
    );
    const expiresInSeconds = Math.min(
      300,
      Math.floor((row.expiresAt.getTime() - Date.now()) / 1000),
    );
    if (expiresInSeconds < 1 || row.status === "expired") throw new GoneException();
    if (row.status !== "ready" || !row.artifactObjectKey || !row.artifactFilename)
      throw new ConflictException("Report is not ready");
    const url = await this.storage.presignRead(row.artifactObjectKey, expiresInSeconds, {
      downloadFilename: row.artifactFilename,
    });
    await this.audit.record(this.db, {
      actorPlatformUserId: user.id,
      actorRole: user.role,
      action: "platform.report.downloaded",
      outcome: "success",
      tenantId: parameters.tenantIds.length === 1 ? parameters.tenantIds[0]! : null,
      targetType: "platform_report",
      targetId: id,
      reason: null,
      before: null,
      after: { tenantIds: parameters.tenantIds },
      requestId: null,
    });
    return { url, filename: row.artifactFilename, expiresInSeconds };
  }

  async options(principal: PlatformPrincipal, raw: unknown) {
    const parsed = platformReportContracts.options.query.safeParse(raw);
    if (!parsed.success) throw new BadRequestException("REPORT_INVALID_PARAMETERS");
    const query = parsed.data;
    await requireReportCreator(
      this.db,
      principal.userId,
      "reports.read",
      query.kind === "operators",
    );
    const tenants = await this.db
      .select({ id: schema.organization.id })
      .from(schema.organization)
      .where(inArray(schema.organization.id, query.tenantIds));
    if (tenants.length !== query.tenantIds.length)
      throw new BadRequestException("REPORT_INVALID_PARAMETERS");
    const table =
      query.kind === "lines"
        ? schema.lines
        : query.kind === "products"
          ? schema.products
          : schema.employees;
    const name =
      query.kind === "operators"
        ? schema.employees.fullName
        : query.kind === "lines"
          ? schema.lines.name
          : schema.products.name;
    const search = query.search?.replace(/[\\%_]/g, "\\$&");
    const items = await this.db
      .select({ id: table.id, name, tenantId: table.tenantId })
      .from(table)
      .where(
        and(
          inArray(table.tenantId, query.tenantIds),
          search ? ilike(name, `%${search}%`) : undefined,
        ),
      )
      .orderBy(asc(name), asc(table.tenantId), asc(table.id))
      .limit(query.limit + 1)
      .offset(query.offset);
    return {
      items: items.slice(0, query.limit),
      nextOffset: items.length > query.limit ? query.offset + query.limit : null,
    };
  }
}

function publicReport(row: Report, identified: boolean) {
  const parameters = platformReportInputSchema.parse(row.parameters);
  if (!identified) delete parameters.operatorId;
  return platformReportSchema.parse({
    id: row.id,
    parameters,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    snapshotAt: row.snapshotAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt.toISOString(),
    errorCode: row.errorCode,
    rowCount: row.rowCount,
    byteSize: row.artifactByteSize,
    filename: row.artifactFilename,
  });
}
function canonical(input: Record<string, unknown> | PlatformReportInput) {
  const parsed = platformReportInputSchema.parse(input);
  return JSON.stringify(
    Object.entries({ ...parsed, tenantIds: [...parsed.tenantIds].sort() }).sort(([a], [b]) =>
      a.localeCompare(b),
    ),
  );
}
