import { schema, type Db } from "@markiro/db";
import { and, asc, eq, ne, or, sql } from "drizzle-orm";
import type { UsMasterDataTransaction } from "../master-data/us-master-data-support";
import type { UsRequestPackageArtifactStore } from "./us-request-package-artifacts";
import { classifyUsWorkerFailure } from "./us-request-worker-failures";
import {
  auditUsWorkerPublication,
  lockUsWorkerPublicationRun,
  usWorkerIntentEvidence,
  usWorkerPublicationInvalid,
  usWorkerPublicationNow,
} from "./us-request-worker-publication";
import {
  parseUsWorkerScope,
  type UsWorkerObjectEvidence,
  type UsWorkerScope,
} from "./us-request-worker-types";

type Tx = UsMasterDataTransaction;
type Intent = typeof schema.traceExportObjectIntents.$inferSelect;
type Outcome = "idle" | "referenced" | "deleted" | "unresolved" | "retry_required";
const intents = schema.traceExportObjectIntents,
  attempts = schema.traceExportAttempts;
const same = (scope: UsWorkerScope) =>
  and(eq(intents.tenantId, scope.tenantId), eq(intents.runId, scope.runId));

/** Bounded internal ledger repair, with no bucket discovery or scheduler. */
export class UsRequestWorkerCleanup {
  constructor(
    private readonly db: Db,
    private readonly store: Pick<UsRequestPackageArtifactStore, "removeFenced">,
  ) {}
  private async transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL lock_timeout='2s'`);
      await tx.execute(sql`SET LOCAL statement_timeout='15s'`);
      return work(tx);
    });
  }
  private async referenced(tx: Tx, object: Intent): Promise<boolean> {
    // Key references are checked even if unexpected scope metadata is corrupt.
    const artifacts = await tx
      .select({ id: schema.traceExportArtifacts.id })
      .from(schema.traceExportArtifacts)
      .where(eq(schema.traceExportArtifacts.objectKey, object.objectKey))
      .limit(1);
    return object.state === "referenced" || object.referencedAt !== null || artifacts.length > 0;
  }
  private async candidate(tx: Tx, scope: UsWorkerScope) {
    const [candidate] = await tx
      .select({ object: intents, attempt: attempts })
      .from(intents)
      .innerJoin(
        attempts,
        and(
          eq(attempts.tenantId, intents.tenantId),
          eq(attempts.runId, intents.runId),
          eq(attempts.id, intents.attemptId),
        ),
      )
      .where(
        and(
          same(scope),
          ne(intents.state, "deleted"),
          or(
            eq(attempts.status, "failed"),
            eq(attempts.status, "abandoned"),
            eq(intents.state, "referenced"),
          ),
        ),
      )
      .orderBy(
        sql`CASE ${intents.state} WHEN 'fenced' THEN 0 WHEN 'verified' THEN 1 WHEN 'allocated' THEN 2 WHEN 'unresolved' THEN 3 ELSE 4 END`,
        asc(intents.allocatedAt),
        asc(intents.name),
        asc(intents.id),
      )
      .limit(1)
      .for("update");
    return candidate;
  }
  private async confirmed(
    tx: Tx,
    scope: UsWorkerScope,
    evidence: UsWorkerObjectEvidence,
  ): Promise<Intent | null> {
    const run = await lockUsWorkerPublicationRun(tx, scope);
    const [object] = await tx
      .select()
      .from(intents)
      .where(and(same(scope), eq(intents.id, evidence.id)))
      .limit(1)
      .for("update");
    if (
      !object ||
      object.state !== "fenced" ||
      !object.fencedAt ||
      !object.verifiedAt ||
      object.deletedAt ||
      run.leaseAttemptId === object.attemptId ||
      (await this.referenced(tx, object))
    )
      return null;
    const actual = usWorkerIntentEvidence(object);
    if (
      actual.objectKey !== evidence.objectKey ||
      actual.attemptId !== evidence.attemptId ||
      actual.name !== evidence.name ||
      actual.sha256 !== evidence.sha256 ||
      actual.byteSize !== evidence.byteSize ||
      actual.mediaType !== evidence.mediaType ||
      actual.kind !== evidence.kind
    )
      return null;
    const [attempt] = await tx
      .select()
      .from(attempts)
      .where(
        and(
          eq(attempts.tenantId, scope.tenantId),
          eq(attempts.runId, scope.runId),
          eq(attempts.id, object.attemptId),
        ),
      )
      .limit(1);
    if (!attempt || !["failed", "abandoned"].includes(attempt.status)) return null;
    return object;
  }
  async cleanupOne(scopeInput: UsWorkerScope): Promise<Outcome> {
    const scope = parseUsWorkerScope(scopeInput);
    let evidence: UsWorkerObjectEvidence | null = null;
    let outcome: Outcome;
    try {
      outcome = await this.transaction(async (tx) => {
        const run = await lockUsWorkerPublicationRun(tx, scope),
          candidate = await this.candidate(tx, scope);
        if (!candidate) return "idle";
        const { object, attempt } = candidate;
        evidence = usWorkerIntentEvidence(object);
        if (await this.referenced(tx, object)) return "referenced";
        if (
          run.leaseAttemptId === object.attemptId ||
          !["failed", "abandoned"].includes(attempt.status)
        )
          return "idle";
        const extra = {
          object: {
            name: evidence.name,
            kind: evidence.kind,
            sha256: evidence.sha256,
            byteSize: evidence.byteSize,
          },
        };
        // Allocation or a colliding/uncertain PUT never establishes ownership.
        if (!object.verifiedAt || object.state === "allocated" || object.state === "unresolved") {
          if (object.state === "allocated") {
            const now = await usWorkerPublicationNow(tx);
            await tx.update(intents).set({ state: "unresolved" }).where(eq(intents.id, object.id));
            await auditUsWorkerPublication(tx, run, attempt, "cleanup", "unresolved", now, extra);
          }
          return "unresolved";
        }
        if (object.state === "fenced" && object.fencedAt && !object.deletedAt) return "deleted";
        if (object.state !== "verified" || object.fencedAt || object.deletedAt)
          throw usWorkerPublicationInvalid();
        const now = await usWorkerPublicationNow(tx);
        await tx
          .update(intents)
          .set({ state: "fenced", fencedAt: now })
          .where(eq(intents.id, object.id));
        await auditUsWorkerPublication(tx, run, attempt, "cleanup", "fenced", now, extra);
        return "deleted";
      });
    } catch {
      // Lost COMMIT response: only a fresh confirmed fence may authorize DELETE.
      // An unavailable database leaves all objects in place.
      if (!evidence) return "retry_required";
      const uncertainEvidence = evidence;
      try {
        if (!(await this.transaction((tx) => this.confirmed(tx, scope, uncertainEvidence))))
          return "retry_required";
        outcome = "deleted";
      } catch {
        return "retry_required";
      }
    }
    if (outcome !== "deleted" || !evidence) return outcome;
    const candidateEvidence: UsWorkerObjectEvidence = evidence;
    try {
      if (!(await this.transaction((tx) => this.confirmed(tx, scope, candidateEvidence))))
        return "retry_required";
    } catch {
      return "retry_required";
    }
    let deletionFailure: string | null = null;
    try {
      await this.store.removeFenced(scope, candidateEvidence);
    } catch (error) {
      deletionFailure = classifyUsWorkerFailure(error).code;
    }
    try {
      return await this.transaction(async (tx) => {
        const run = await lockUsWorkerPublicationRun(tx, scope);
        const [object] = await tx
          .select()
          .from(intents)
          .where(and(same(scope), eq(intents.id, candidateEvidence.id)))
          .limit(1)
          .for("update");
        if (object?.state === "deleted") return "deleted";
        if (!(await this.confirmed(tx, scope, candidateEvidence)) || !object)
          throw usWorkerPublicationInvalid();
        const [attempt] = await tx
          .select()
          .from(attempts)
          .where(
            and(
              eq(attempts.tenantId, scope.tenantId),
              eq(attempts.runId, scope.runId),
              eq(attempts.id, object.attemptId),
            ),
          )
          .limit(1);
        if (!attempt) throw usWorkerPublicationInvalid();
        const now = await usWorkerPublicationNow(tx);
        if (!deletionFailure)
          await tx
            .update(intents)
            .set({ state: "deleted", deletedAt: now })
            .where(eq(intents.id, object.id));
        await auditUsWorkerPublication(
          tx,
          run,
          attempt,
          "cleanup",
          deletionFailure ? "retry_required" : "deleted",
          now,
          {
            object: {
              name: candidateEvidence.name,
              kind: candidateEvidence.kind,
              sha256: candidateEvidence.sha256,
              byteSize: candidateEvidence.byteSize,
            },
            ...(deletionFailure ? { failureCode: deletionFailure } : {}),
          },
        );
        return deletionFailure ? "retry_required" : "deleted";
      });
    } catch {
      // DELETE is idempotent; the durable fence remains if its outcome cannot be recorded.
      return "retry_required";
    }
  }
}
