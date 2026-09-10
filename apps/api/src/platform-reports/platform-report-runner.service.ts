import { createHash } from "node:crypto";
import { ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { schema, type Db } from "@markiro/db";
import { platformReportInputSchema } from "@markiro/platform-contracts";
import { and, asc, eq, gt, lt, or, sql } from "drizzle-orm";
import { DB } from "../auth/auth.module";
import { ObjectStorageService } from "../modules/storage/object-storage.service";
import { PlatformAuditService } from "../platform-auth/platform-audit.service";
import {
  PlatformReportSourceBusyError,
  PlatformReportSourceError,
  PlatformReportSourceService,
} from "./report-source.service";
import { renderPlatformReport } from "./report-renderer";
import { platformReportObjectKey } from "./report-object-key";
import { requireReportCreator } from "./report-access";

const reports = schema.platformReports;
// Covers both 60s summary statements, validation queries, rendering and bounded S3 retries.
const claimTime = sql`greatest(date_trunc('milliseconds', statement_timestamp()), ${schema.platformReports.updatedAt} + interval '1 millisecond')`;
const emptyArtifact = {
  artifactObjectKey: null,
  artifactChecksum: null,
  artifactByteSize: null,
  artifactFilename: null,
};

@Injectable()
export class PlatformReportRunnerService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly source: PlatformReportSourceService,
    private readonly storage: ObjectStorageService,
    private readonly audit: PlatformAuditService,
  ) {}

  async run(id: string): Promise<void> {
    const now = new Date();
    const [row] = await this.db
      .update(reports)
      .set({
        status: "processing",
        attemptCount: sql`${reports.attemptCount} + 1`,
        leaseExpiresAt: sql`${claimTime} + interval '10 minutes'`,
        updatedAt: claimTime,
      })
      .where(
        and(
          eq(reports.id, id),
          lt(reports.attemptCount, 3),
          gt(reports.expiresAt, now),
          or(
            eq(reports.status, "queued"),
            and(eq(reports.status, "processing"), lt(reports.leaseExpiresAt, now)),
          ),
        ),
      )
      .returning();
    if (!row) return;
    const lease = row.leaseExpiresAt!;
    const fence = and(
      eq(reports.id, id),
      eq(reports.status, "processing"),
      eq(reports.attemptCount, row.attemptCount),
      eq(reports.leaseExpiresAt, lease),
    );
    let phase: "source" | "storage" = "source";
    try {
      const parameters = platformReportInputSchema.parse(row.parameters);
      await requireReportCreator(
        this.db,
        row.createdByPlatformUserId,
        "reports.create",
        parameters.privacy === "identified" || !!parameters.operatorId,
      );
      const source = await this.source.load(parameters);
      const artifact = renderPlatformReport(parameters, source);
      // Verify ownership immediately before uploading; attempt keys cannot be reused after this point.
      const [owned] = await this.db
        .select({ id: reports.id })
        .from(reports)
        .where(
          and(fence, gt(reports.leaseExpiresAt, new Date()), gt(reports.expiresAt, new Date())),
        );
      if (!owned) return;
      phase = "storage";
      const key = platformReportObjectKey(id, row.attemptCount);
      const checksum = createHash("sha256").update(artifact.body).digest("hex");
      await this.storage.putVerified(key, artifact.body, "application/zip", checksum);
      await this.db
        .update(reports)
        .set({
          status: "ready",
          leaseExpiresAt: null,
          artifactObjectKey: key,
          artifactChecksum: checksum,
          artifactByteSize: artifact.body.length,
          artifactFilename: artifact.filename,
          snapshotAt: source.snapshotAt,
          rowCount: artifact.rowCount,
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(fence, gt(reports.leaseExpiresAt, new Date()), gt(reports.expiresAt, new Date())),
        );
      // Never delete here: commit may have succeeded despite an ambiguous transport error.
      // Reconciliation derives stale keys and cannot delete a ready winner's artifact.
    } catch (error) {
      if (error instanceof PlatformReportSourceBusyError && phase === "source") {
        await this.db
          .update(reports)
          .set({
            status: "queued",
            attemptCount: row.attemptCount - 1,
            leaseExpiresAt: null,
            updatedAt: claimTime,
          })
          .where(fence);
        return;
      }
      const code =
        error instanceof ForbiddenException
          ? "REPORT_PERMISSION_REVOKED"
          : error instanceof PlatformReportSourceError
            ? error.code
            : phase === "storage"
              ? "REPORT_STORAGE_FAILED"
              : "REPORT_GENERATION_FAILED";
      const terminal =
        row.attemptCount >= 3 ||
        code === "REPORT_PERMISSION_REVOKED" ||
        code === "REPORT_INVALID_PARAMETERS" ||
        code === "REPORT_LIMIT_EXCEEDED";
      await this.db.transaction(async (tx) => {
        const [changed] = await tx
          .update(reports)
          .set({
            status: terminal ? "failed" : "queued",
            leaseExpiresAt: null,
            completedAt: terminal ? new Date() : null,
            errorCode: terminal ? code : null,
            updatedAt: new Date(),
          })
          .where(fence)
          .returning();
        if (changed && terminal) await this.recordFailure(tx, changed, code);
      });
    }
  }

  async reconcile(dispatch: (reportId: string) => Promise<unknown>): Promise<void> {
    const now = new Date();
    // Cleanup before clearing artifact fields, and retry even already-expired rows:
    // late stale PUTs remain discoverable using the three deterministic keys.
    const expired = await this.db
      .select()
      .from(reports)
      .where(lt(reports.expiresAt, now))
      .orderBy(asc(reports.updatedAt), asc(reports.id))
      .limit(100);
    for (const row of expired) {
      try {
        for (let attempt = 1; attempt <= 3; attempt++)
          await this.storage.deleteConfirmed(platformReportObjectKey(row.id, attempt));
        await this.db
          .update(reports)
          .set({
            status: "expired",
            ...emptyArtifact,
            leaseExpiresAt: null,
            completedAt: sql`coalesce(${reports.completedAt}, ${now})`,
            errorCode: null,
            updatedAt: now,
          })
          .where(and(eq(reports.id, row.id), lt(reports.expiresAt, now)));
      } catch {
        /* A later tick retries confirmed deletion without exposing storage details. */
        await this.db
          .update(reports)
          .set({ updatedAt: now })
          .where(and(eq(reports.id, row.id), lt(reports.expiresAt, now)));
      }
    }
    const candidates = await this.db
      .select()
      .from(reports)
      .where(
        and(
          gt(reports.expiresAt, now),
          or(
            eq(reports.status, "queued"),
            and(eq(reports.status, "processing"), lt(reports.leaseExpiresAt, now)),
          ),
        ),
      )
      .orderBy(asc(reports.createdAt))
      .limit(50);
    for (const row of candidates) {
      if (row.attemptCount >= 3) {
        await this.db.transaction(async (tx) => {
          const [changed] = await tx
            .update(reports)
            .set({
              status: "failed",
              leaseExpiresAt: null,
              completedAt: now,
              errorCode: "REPORT_RETRY_EXHAUSTED",
              updatedAt: now,
            })
            .where(
              and(
                eq(reports.id, row.id),
                eq(reports.status, row.status),
                eq(reports.attemptCount, row.attemptCount),
                row.leaseExpiresAt
                  ? eq(reports.leaseExpiresAt, row.leaseExpiresAt)
                  : eq(reports.status, "queued"),
              ),
            )
            .returning();
          if (changed) await this.recordFailure(tx, changed, "REPORT_RETRY_EXHAUSTED");
        });
      } else await dispatch(row.id);
    }
  }

  private async recordFailure(
    tx: Pick<Db, "insert" | "select">,
    row: typeof reports.$inferSelect,
    code: string,
  ) {
    const [user] = await tx
      .select({ role: schema.platformUsers.role })
      .from(schema.platformUsers)
      .where(eq(schema.platformUsers.id, row.createdByPlatformUserId));
    const input = platformReportInputSchema.parse(row.parameters);
    await this.audit.record(tx, {
      actorPlatformUserId: row.createdByPlatformUserId,
      actorRole: user?.role ?? null,
      action: "platform.report.failed",
      outcome: "failure",
      tenantId: input.tenantIds.length === 1 ? input.tenantIds[0]! : null,
      targetType: "platform_report",
      targetId: row.id,
      reason: code,
      before: null,
      after: { tenantIds: input.tenantIds },
      requestId: null,
    });
  }
}
