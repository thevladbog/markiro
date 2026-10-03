import { schema, type Db } from "@markiro/db";
import {
  US_CAPABILITY,
  buildUsPlanSnapshot,
  buildUsPlanDraftFactSources,
  buildUsPlanApprovedEvidence,
  canonicalExportDigest,
  traceabilityRetention,
  usPlanApprovalRequestDigest,
  usPlanIdempotencyKeyHash,
  type UsCapability,
} from "@markiro/domain";
import {
  usPlanInternalApproveInputSchema,
  platformUuidSchema,
  type UsPlanInternalApproveInput,
} from "@markiro/platform-contracts";
import {
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { UsDevelopmentOwnerStore } from "../../../deployment/us-development-owner";
import {
  authorizeUsMasterData,
  parseMasterDataInput,
  type UsMasterDataTransaction,
} from "../master-data/us-master-data-support";
import { readUsPlanConfiguration } from "./us-plan-configuration";
import { parseUsPlanDraftRow, type UsPlanVersionRow } from "./us-plan-model";
import type { UsPlanArtifactStore, UsPlanArtifactAttempt } from "./us-plan-artifacts";
import { renderUsPlanPdf } from "./us-plan-pdf";
import { parseUsPlanPublishedRow } from "./us-plan-published";
import { validateUsPlanSavedContent } from "./us-plan-validation";

const versions = schema.traceabilityPlanVersions;
const fences = schema.traceabilityPlanCleanupFences;
const scope = (tenantId: string, id: string) =>
  and(eq(versions.tenantId, tenantId), eq(versions.id, id));
const metadata = (row: UsPlanVersionRow) => ({
  versionNumber: row.versionNumber,
  draftRevision: row.draftRevision,
});
type Published = ReturnType<typeof parseUsPlanPublishedRow>;
type AuditMetadata = Record<string, unknown>;

/** Internal US service only; no runtime registration or public route. */
export class UsPlanApprovalStore {
  constructor(
    private readonly db: Db,
    private readonly artifacts: UsPlanArtifactStore | null,
    private readonly render: typeof renderUsPlanPdf = renderUsPlanPdf,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private configuredArtifacts(): UsPlanArtifactStore {
    if (!this.artifacts)
      throw new ServiceUnavailableException({ code: "us_plan_artifact_storage_unconfigured" });
    return this.artifacts;
  }

  private async authorize(
    tx: UsMasterDataTransaction,
    tenantId: string,
    actor: string,
    capability: UsCapability,
  ) {
    const profile = await authorizeUsMasterData(tx, tenantId, actor, capability);
    if (profile !== "US_FSMA204_PROCESSOR")
      throw new ForbiddenException({ code: "us_plan_profile_unsupported" });
  }
  private async lockTenant(tx: UsMasterDataTransaction, tenantId: string) {
    const [row] = await tx
      .select({ id: schema.organization.id })
      .from(schema.organization)
      .where(eq(schema.organization.id, tenantId))
      .for("update");
    if (!row) throw new NotFoundException({ code: "us_plan_version_not_found" });
  }
  private async version(tx: UsMasterDataTransaction, tenantId: string, id: string) {
    const [row] = await tx.select().from(versions).where(scope(tenantId, id)).for("update");
    if (!row) throw new NotFoundException({ code: "us_plan_version_not_found" });
    return row;
  }
  private async retry(
    tx: UsMasterDataTransaction,
    tenantId: string,
    input: UsPlanInternalApproveInput,
  ) {
    const [saved] = await tx
      .select()
      .from(versions)
      .where(
        and(
          eq(versions.tenantId, tenantId),
          eq(versions.idempotencyKeyHash, usPlanIdempotencyKeyHash(input.idempotencyKey)),
        ),
      );
    if (!saved) return null;
    if (saved.approvalRequestDigest !== usPlanApprovalRequestDigest({ ...input, tenantId }))
      throw new ConflictException({ code: "us_plan_idempotency_conflict" });
    // Approval receipt is stable even after the version's lifecycle changes.
    return {
      ...parseUsPlanPublishedRow(saved),
      status: "effective" as const,
      supersededAt: null,
      retainThrough: null,
      retentionIndefiniteReason: null,
    };
  }
  private audit(
    tx: UsMasterDataTransaction,
    tenantId: string,
    actor: string,
    requestId: string,
    id: string | null,
    action: string,
    outcome: "success" | "conflict" | "rejected" | "unconfirmed",
    before: AuditMetadata | null,
    after: AuditMetadata | null,
  ) {
    return tx.insert(schema.tenantAuditEvents).values({
      organizationId: tenantId,
      actorUserId: actor,
      requestId,
      targetType: "traceability_plan_version",
      targetId: id,
      action,
      outcome,
      before,
      after,
    });
  }
  async approve(
    tenantId: string,
    actor: string,
    raw: unknown,
    requestId: string,
  ): Promise<Published> {
    let attempt: UsPlanArtifactAttempt | undefined;
    let context: AuditMetadata = {};
    let id: string | null = null;
    let number = 0;
    try {
      const input = parseMasterDataInput(usPlanInternalApproveInputSchema, raw);
      id = input.versionId;
      // One coherent capture; locks end before rendering or provider I/O.
      const captured = await this.db.transaction(
        async (tx) => {
          await this.authorize(tx, tenantId, actor, US_CAPABILITY.QA_MANAGE);
          this.configuredArtifacts();
          const retry = await this.retry(tx, tenantId, input);
          if (retry) return { retry };
          const row = await this.version(tx, tenantId, input.versionId);
          context = metadata(row);
          number = row.versionNumber;
          this.checkDraft(row, input.expectedRevision);
          const draft = parseUsPlanDraftRow(row);
          const config = await readUsPlanConfiguration(tx, tenantId);
          const approvedAt = this.now();
          const seed = await new UsDevelopmentOwnerStore(this.db).verifyTrustedSeed(
            tenantId,
            approvedAt,
            tx,
          );
          const provenance = seed ? "trusted_synthetic" : "operational";
          const issues = validateUsPlanSavedContent(
            {
              ...draft,
              profileCode: config.facts.profileCode,
              tlcSourceLocationCount: config.facts.tlcSourceLocations.length,
              provenance,
              confirmations: input.confirmations,
            },
            config.facts,
          );
          if (issues.length)
            throw new ConflictException({ code: "us_plan_validation_failed", issues });
          const snapshot = buildUsPlanSnapshot(config.facts, draft.sections, provenance);
          const evidence = buildUsPlanApprovedEvidence(
            snapshot,
            buildUsPlanDraftFactSources(config.facts, draft.sections),
            {
              kind: seed ? "synthetic" : "operational",
              actorId: actor,
              confirmedAt: approvedAt.toISOString(),
              confirmations: input.confirmations,
              ...(seed ? { trustedSeed: seed } : {}),
            },
          );
          return { row, config, approvedAt, evidence, seed };
        },
        { isolationLevel: "repeatable read" },
      );
      if (captured.retry) return captured.retry;
      const pdf = await this.render({
        versionNumber: captured.row.versionNumber,
        approvedBy: actor,
        approvedAt: captured.approvedAt.toISOString(),
        changeSummary: captured.row.changeSummary,
        evidence: captured.evidence,
      });
      const artifacts = this.configuredArtifacts();
      attempt = artifacts.createAttempt({ tenantId, versionId: input.versionId }, pdf);
      context = {
        ...context,
        sha256: attempt.artifact.sha256,
        objectKey: attempt.artifact.objectKey,
      };
      const artifact = await artifacts.putVerified(attempt);
      const result = await this.publicationTransaction(async (tx) => {
        // Organization -> authorization -> versions. READ COMMITTED is essential:
        // a fence/config commit while waiting for this lock must be visible below.
        await this.lockTenant(tx, tenantId);
        await this.authorize(tx, tenantId, actor, US_CAPABILITY.QA_MANAGE);
        const retry = await this.retry(tx, tenantId, input);
        if (retry) return retry;
        const [fence] = await tx
          .select()
          .from(fences)
          .where(and(eq(fences.tenantId, tenantId), eq(fences.objectKey, artifact.objectKey)));
        if (fence) throw new ConflictException({ code: "us_plan_attempt_fenced" });
        const row = await this.version(tx, tenantId, input.versionId);
        this.checkDraft(row, input.expectedRevision);
        const current = await readUsPlanConfiguration(tx, tenantId);
        const seed = await new UsDevelopmentOwnerStore(this.db).verifyTrustedSeed(
          tenantId,
          captured.approvedAt,
          tx,
        );
        if (
          current.digest !== captured.config.digest ||
          canonicalExportDigest(seed) !== canonicalExportDigest(captured.seed)
        )
          throw new ConflictException({ code: "us_plan_configuration_conflict" });
        const [previous] = await tx
          .select()
          .from(versions)
          .where(and(eq(versions.tenantId, tenantId), eq(versions.status, "effective")))
          .for("update");
        const committedAt = this.now();
        if (previous) {
          const frozen = parseUsPlanPublishedRow(previous);
          const zone = frozen.evidence.snapshot.configured.timeZone;
          const retention = traceabilityRetention({
            recordClass: "plan",
            createdOrObtainedOn: civilDate(frozen.approvedAt, zone),
            supersededOn: civilDate(committedAt.toISOString(), zone),
            retentionYears: current.facts.retentionYears,
            ...(previous.retentionFloor ? { previousRetainThrough: previous.retentionFloor } : {}),
            ...(previous.holdUntil ? { holdUntil: previous.holdUntil } : {}),
            indefiniteHold: previous.indefiniteHold,
          });
          await tx
            .update(versions)
            .set({
              status: "superseded",
              supersededById: row.id,
              supersededAt: committedAt,
              retainThrough: retention.retainThrough,
              retentionIndefiniteReason: retention.indefiniteReason,
            })
            .where(scope(tenantId, previous.id));
        }
        const [published] = await tx
          .update(versions)
          .set({
            status: "effective",
            approvedBy: actor,
            approvedAt: captured.approvedAt,
            configSnapshot: captured.evidence.snapshot,
            configDigest: canonicalExportDigest(captured.evidence.snapshot),
            approvedEvidence: captured.evidence,
            idempotencyKeyHash: usPlanIdempotencyKeyHash(input.idempotencyKey),
            approvalRequestDigest: usPlanApprovalRequestDigest({ ...input, tenantId }),
            pdfObjectKey: artifact.objectKey,
            pdfSha256: artifact.sha256,
            pdfByteSize: artifact.byteSize,
            rendererVersion: artifact.rendererVersion,
            updatedAt: committedAt,
          })
          .where(scope(tenantId, row.id))
          .returning();
        if (!published) throw new ServiceUnavailableException({ code: "us_database_unavailable" });
        await this.audit(
          tx,
          tenantId,
          actor,
          requestId,
          row.id,
          "traceability.plan.approved",
          "success",
          metadata(row),
          {
            ...metadata(row),
            sha256: artifact.sha256,
            objectKey: artifact.objectKey,
            configDigest: published.configDigest,
          },
        );
        return parseUsPlanPublishedRow(published);
      });
      if (result.artifact.objectKey === artifact.objectKey) artifacts.markReferenced(attempt);
      else await this.cleanup(tenantId, actor, input.versionId, number, requestId, attempt);
      return result;
    } catch (error) {
      if (attempt && id) await this.cleanup(tenantId, actor, id, number, requestId, attempt);
      const response = error instanceof HttpException ? error.getResponse() : null;
      const code =
        response &&
        typeof response === "object" &&
        "code" in response &&
        typeof response.code === "string"
          ? response.code
          : "us_plan_approval_failed";
      await this.db.transaction((tx) =>
        this.audit(
          tx,
          tenantId,
          actor,
          requestId,
          id,
          "traceability.plan.approved",
          code === "us_plan_artifact_storage_unconfigured"
            ? "rejected"
            : error instanceof ConflictException
              ? "conflict"
              : error instanceof HttpException && error.getStatus() < 500
                ? "rejected"
                : "unconfirmed",
          null,
          { code, ...context },
        ),
      );
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException({ code: "us_plan_approval_failed" });
    }
  }
  private checkDraft(row: UsPlanVersionRow, revision: number) {
    if (row.status !== "draft") throw new ConflictException({ code: "us_plan_not_draft" });
    if (row.draftRevision !== revision)
      throw new ConflictException({ code: "us_plan_revision_conflict" });
  }
  private async publicationTransaction<T>(
    run: (tx: UsMasterDataTransaction) => Promise<T>,
  ): Promise<T> {
    for (let tries = 0; ; tries++) {
      try {
        return await this.db.transaction(run, { isolationLevel: "read committed" });
      } catch (error) {
        const cause = error && typeof error === "object" && "cause" in error ? error.cause : error;
        const code = cause && typeof cause === "object" && "code" in cause ? cause.code : null;
        if (tries >= 2 || (code !== "40001" && code !== "40P01")) throw error;
      }
    }
  }
  private async referenced(tx: UsMasterDataTransaction, tenantId: string, key: string) {
    if (!key.startsWith(`us/plans/${tenantId}/`)) throw new Error("cleanup_scope_invalid");
    // Internal deletion veto only: inspect all references to this already-owned
    // exact key, including corrupt cross-tenant references. No foreign data leaves.
    const [row] = await tx
      .select({ id: versions.id })
      .from(versions)
      .where(
        and(eq(versions.pdfObjectKey, key), inArray(versions.status, ["effective", "superseded"])),
      );
    return row !== undefined;
  }
  private async cleanup(
    tenantId: string,
    actor: string,
    id: string,
    versionNumber: number,
    requestId: string,
    attempt: UsPlanArtifactAttempt,
  ) {
    try {
      const outcome = await this.configuredArtifacts().cleanupUnreferenced(
        attempt,
        async (artifact, remove) => {
          // Commit irreversible publication fence BEFORE provider I/O. A failed COMMIT
          // response is never proof that publication failed or that a fence persisted.
          const protectedReference = await this.db.transaction(async (tx) => {
            await this.lockTenant(tx, tenantId);
            if (await this.referenced(tx, tenantId, artifact.objectKey)) return true;
            await tx
              .insert(fences)
              .values({
                tenantId,
                versionId: id,
                versionNumber,
                actorUserId: actor,
                requestId,
                objectKey: artifact.objectKey,
                sha256: artifact.sha256,
              })
              .onConflictDoNothing();
            const [fence] = await tx
              .select()
              .from(fences)
              .where(and(eq(fences.tenantId, tenantId), eq(fences.objectKey, artifact.objectKey)));
            if (!fence || fence.versionId !== id || fence.sha256 !== artifact.sha256)
              throw new Error("cleanup_fence_missing");
            return false;
          });
          if (protectedReference) return "referenced";
          // The permanent fence now excludes publication across process failure;
          // no database transaction or organization lock spans provider I/O.
          await remove();
          await this.db.transaction(async (tx) => {
            await tx
              .update(fences)
              .set({ state: "deleted" })
              .where(
                and(
                  eq(fences.tenantId, tenantId),
                  eq(fences.objectKey, artifact.objectKey),
                  eq(fences.state, "fenced"),
                ),
              );
          });
          return "deleted";
        },
        { tenantId, versionId: id },
      );
      await this.db.transaction((tx) =>
        this.audit(
          tx,
          tenantId,
          actor,
          requestId,
          id,
          "traceability.plan.artifact_cleanup",
          outcome === "not_owned" ? "unconfirmed" : "success",
          null,
          {
            versionNumber,
            objectKey: attempt.artifact.objectKey,
            sha256: attempt.artifact.sha256,
            cleanupOutcome: outcome === "not_owned" ? "unresolved_upload" : outcome,
          },
        ),
      );
    } catch {
      await this.db.transaction((tx) =>
        this.audit(
          tx,
          tenantId,
          actor,
          requestId,
          id,
          "traceability.plan.artifact_cleanup",
          "rejected",
          null,
          {
            versionNumber,
            objectKey: attempt.artifact.objectKey,
            sha256: attempt.artifact.sha256,
            cleanupOutcome: "retry_required",
          },
        ),
      );
    }
  }
  async getPublished(tenantId: string, actor: string, rawId: unknown): Promise<Published> {
    return this.db.transaction(async (tx) => {
      await this.authorize(tx, tenantId, actor, US_CAPABILITY.READ);
      const id = parseMasterDataInput(platformUuidSchema, rawId);
      const [row] = await tx.select().from(versions).where(scope(tenantId, id));
      if (!row) throw new NotFoundException({ code: "us_plan_version_not_found" });
      return parseUsPlanPublishedRow(row);
    });
  }
  async readPdf(
    tenantId: string,
    actor: string,
    rawId: unknown,
    requestId: string,
  ): Promise<Buffer> {
    let context: AuditMetadata = {};
    try {
      const published = await this.db.transaction(async (tx) => {
        await this.authorize(tx, tenantId, actor, US_CAPABILITY.EXPORT_READ);
        this.configuredArtifacts();
        const id = parseMasterDataInput(platformUuidSchema, rawId);
        const [row] = await tx.select().from(versions).where(scope(tenantId, id));
        if (!row) throw new NotFoundException({ code: "us_plan_version_not_found" });
        return parseUsPlanPublishedRow(row);
      });
      context = { versionNumber: published.versionNumber, sha256: published.artifact.sha256 };
      const bytes = await this.configuredArtifacts().readVerified(
        { tenantId, versionId: published.id },
        published.artifact,
      );
      await this.db.transaction(async (tx) => {
        await this.authorize(tx, tenantId, actor, US_CAPABILITY.EXPORT_READ);
        await this.audit(
          tx,
          tenantId,
          actor,
          requestId,
          published.id,
          "traceability.plan.downloaded",
          "success",
          null,
          { versionNumber: published.versionNumber, sha256: published.artifact.sha256 },
        );
      });
      return bytes;
    } catch (error) {
      const id = platformUuidSchema.safeParse(rawId);
      const response = error instanceof HttpException ? error.getResponse() : null;
      const code =
        response &&
        typeof response === "object" &&
        "code" in response &&
        typeof response.code === "string"
          ? response.code
          : "us_plan_artifact_read_failed";
      await this.db.transaction((tx) =>
        this.audit(
          tx,
          tenantId,
          actor,
          requestId,
          id.success ? id.data : null,
          "traceability.plan.downloaded",
          "rejected",
          null,
          { code, ...context },
        ),
      );
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException({ code: "us_plan_artifact_read_failed" });
    }
  }
}
function civilDate(instant: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(instant));
  const value = (type: string) => parts.find((part) => part.type === type)?.value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}
