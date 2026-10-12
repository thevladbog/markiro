import { schema, type Db } from "@markiro/db";
import { US_CAPABILITY } from "@markiro/domain";
import { platformUuidSchema, usRequestArtifactKindSchema } from "@markiro/platform-contracts";
import { HttpException, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { parseMasterDataInput } from "../master-data/us-master-data-support";
import { authorizeUsRequestHttp, type UsRequestHttpContext } from "./us-request-http-context";
import type { UsRequestPackageArtifactStore } from "./us-request-package-artifacts";
import { readUsRequestPublishedState } from "./us-request-publication-read";
import { verifyUsRequestRunEvidence } from "./us-request-run-evidence";
import { usWorkerFailureCodeSchema } from "./us-request-worker-types";

export interface UsRequestDownload {
  readonly bytes: Buffer;
  readonly filename: string;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly sha256: string;
}
const unavailable = (code: string) => new ServiceUnavailableException({ code });
const safeFailure = (error: unknown): HttpException =>
  error instanceof HttpException ? error : unavailable("us_request_download_unavailable");

/** Buffered private release: both authorization transactions end before bytes leave this service. */
export class UsRequestDownloadStore {
  constructor(
    private readonly db: Db,
    private readonly packageStore: () => UsRequestPackageArtifactStore,
  ) {}

  async download(
    ctx: UsRequestHttpContext,
    rawRunId: unknown,
    rawKind: unknown,
  ): Promise<UsRequestDownload> {
    // A rejected identity lookup creates no audit with guessed business/private facts.
    const resolved = await this.db
      .transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL lock_timeout='2s'`);
        await tx.execute(sql`SET LOCAL statement_timeout='3s'`);
        await authorizeUsRequestHttp(tx, ctx, [US_CAPABILITY.EXPORT_READ]);
        const runId = parseMasterDataInput(platformUuidSchema, rawRunId);
        const kind = parseMasterDataInput(usRequestArtifactKindSchema, rawKind);
        const state = await readUsRequestPublishedState(tx, ctx.tenantId, runId);
        const evidence = state.artifacts.find((item) => item.kind === kind);
        if (!evidence) throw new NotFoundException({ code: "us_request_artifact_not_found" });
        return { state, evidence };
      })
      .catch((error: unknown) => {
        throw safeFailure(error);
      });
    const { state: published, evidence } = resolved;
    const frozen = verifyUsRequestRunEvidence(published.run, ctx.tenantId);
    try {
      let store: UsRequestPackageArtifactStore;
      try {
        store = this.packageStore();
      } catch {
        throw unavailable("us_request_package_storage_unavailable");
      }
      const bytes = await store
        .readVerified({ tenantId: ctx.tenantId, runId: published.run.id }, evidence)
        .catch((error: unknown) => {
          const code = usWorkerFailureCodeSchema.safeParse(
            error instanceof Error && "code" in error ? error.code : undefined,
          );
          throw unavailable(code.success ? code.data : "us_request_package_storage_read_failed");
        });
      await this.db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL lock_timeout='2s'`);
        await tx.execute(sql`SET LOCAL statement_timeout='3s'`);
        await authorizeUsRequestHttp(tx, ctx, [US_CAPABILITY.EXPORT_READ]);
        const current = await readUsRequestPublishedState(tx, ctx.tenantId, published.run.id);
        const same = current.artifacts.find((item) => item.kind === evidence.kind);
        if (
          !same ||
          same.id !== evidence.id ||
          same.attemptId !== evidence.attemptId ||
          same.objectKey !== evidence.objectKey ||
          same.name !== evidence.name ||
          same.mediaType !== evidence.mediaType ||
          same.byteSize !== evidence.byteSize ||
          same.sha256 !== evidence.sha256 ||
          current.run.scopedContentDigest !== published.run.scopedContentDigest ||
          current.run.completedAt?.getTime() !== published.run.completedAt?.getTime()
        )
          throw unavailable("us_request_publication_invalid");
        await tx.insert(schema.tenantAuditEvents).values({
          organizationId: ctx.tenantId,
          actorUserId: ctx.userId,
          requestId: ctx.httpRequestId,
          action: "traceability.request.artifact_downloaded",
          outcome: "success",
          targetType: "trace_export_run",
          targetId: published.run.id,
          before: null,
          after: {
            requestId: published.run.requestId,
            requestRevision: frozen.validationSnapshot.request.revision,
            runRevision: published.run.revision,
            mode: published.run.mode,
            kind: evidence.kind,
            byteSize: evidence.byteSize,
            sha256: evidence.sha256,
          },
        });
      });
      return {
        bytes,
        filename: evidence.name,
        mediaType: evidence.mediaType,
        byteSize: evidence.byteSize,
        sha256: evidence.sha256,
      };
    } catch (error) {
      const safe = safeFailure(error);
      const response = safe.getResponse();
      const code =
        typeof response === "object" && "code" in response && typeof response.code === "string"
          ? response.code
          : "us_request_download_unavailable";
      try {
        // Only the already-authorized tenant/run identity is recorded on failure.
        await this.db.transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL lock_timeout='2s'`);
          await tx.execute(sql`SET LOCAL statement_timeout='3s'`);
          await tx.insert(schema.tenantAuditEvents).values({
            organizationId: ctx.tenantId,
            actorUserId: ctx.userId,
            requestId: ctx.httpRequestId,
            action: "traceability.request.artifact_downloaded",
            outcome: "rejected",
            targetType: "trace_export_run",
            targetId: published.run.id,
            before: null,
            after: { code },
          });
        });
      } catch {
        throw unavailable("us_request_download_unavailable");
      }
      throw safe;
    }
  }
}
