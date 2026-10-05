import type { Db } from "@markiro/db";
import { createHash } from "node:crypto";
import { ServiceUnavailableException, type HttpException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { bindUsRequestPackageInputs } from "./us-request-package-inputs";
import { assembleUsRequestPackage } from "./us-request-package";
import {
  US_REQUEST_PACKAGE_VERSION,
  US_REQUEST_REPORT_PDF_VERSION,
} from "./us-request-package-types";
import { renderUsRequestPayloads } from "./us-request-payloads";
import { requireUsRequestPackageEvidence } from "./us-request-run-evidence";
import { stableStringify } from "./us-request-snapshot";
import { classifyUsWorkerFailure, sanitizedUsWorkerError } from "./us-request-worker-failures";
import type { UsRequestPackageArtifactStore } from "./us-request-package-artifacts";
import type { UsRequestPlanReader } from "./us-request-plan-reader";
import type { UsRequestWorkerCheckpoints } from "./us-request-worker-checkpoint";
import type { UsRequestWorkerCleanup } from "./us-request-worker-cleanup";
import {
  assertUsRequestWorkerExecutionIdentity,
  type UsRequestWorkerExecutionIdentity,
} from "./us-request-worker-execution";
import type { UsRequestWorkerLifecycleContract } from "./us-request-worker-lifecycle";
import type { UsRequestWorkerPublication } from "./us-request-worker-publication";
import {
  US_REQUEST_WORKER_POLICY,
  usWorkerFailureCodeSchema,
  type UsWorkerScope,
  type UsWorkerFailureCode,
  type UsWorkerLease,
  type UsWorkerRunState,
} from "./us-request-worker-types";

export type UsRequestWorkerResult =
  | { kind: "storage_unavailable" }
  | { kind: "idle" }
  | { kind: "ready"; scope: UsWorkerScope }
  | { kind: "retry_scheduled"; scope: UsWorkerScope }
  | { kind: "failed"; scope: UsWorkerScope; code: UsWorkerFailureCode }
  | { kind: "lease_lost"; scope: UsWorkerScope }
  | { kind: "outcome_unresolved"; scope: UsWorkerScope };
type Dependencies = {
  lifecycle: UsRequestWorkerLifecycleContract;
  checkpoints: Pick<
    UsRequestWorkerCheckpoints,
    "acceptReport" | "acceptPackage" | "assertReproduction" | "assertPackageReproduction"
  >;
  publication: Pick<
    UsRequestWorkerPublication,
    "allocate" | "markVerified" | "publish" | "reconcile"
  >;
  cleanup: Pick<UsRequestWorkerCleanup, "cleanupOne">;
  storage: UsRequestPackageArtifactStore | null;
  planReader: UsRequestPlanReader;
  execution: UsRequestWorkerExecutionIdentity;
};

/** Only a live invocation owns this helper. stop joins the last renewal on every exit.
 * It cannot interrupt synchronous CPU work; persisted fences govern late results. */
class InvocationRenewal {
  private readonly timer: ReturnType<typeof setInterval>;
  private pending: Promise<void> = Promise.resolve();
  private renewing = false;
  private stopped = false;
  private error: HttpException | undefined;
  constructor(
    private readonly lifecycle: UsRequestWorkerLifecycleContract,
    private lease: UsWorkerLease,
  ) {
    this.timer = setInterval(() => {
      if (this.stopped || this.renewing || this.error !== undefined) return;
      this.renewing = true;
      this.pending = this.lifecycle
        .renew(this.lease)
        .then(
          (renewed) => {
            this.lease = renewed;
          },
          (error: unknown) => {
            this.error = sanitizedUsWorkerError(error);
          },
        )
        .finally(() => {
          this.renewing = false;
        });
    }, US_REQUEST_WORKER_POLICY.renewMs);
  }
  assertHealthy(): void {
    if (this.error !== undefined) throw this.error;
  }
  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    await this.pending;
  }
}

export class UsRequestWorker {
  constructor(
    private readonly db: Db,
    private readonly deps: Dependencies,
  ) {}
  async runOne(): Promise<UsRequestWorkerResult> {
    if (!this.deps.storage) return { kind: "storage_unavailable" };
    assertUsRequestWorkerExecutionIdentity(this.deps.execution);
    let lease: UsWorkerLease | null;
    try {
      lease = await this.deps.lifecycle.claimNext();
    } catch (error) {
      throw sanitizedUsWorkerError(error);
    }
    if (!lease) return { kind: "idle" };
    const scope = { tenantId: lease.tenantId, runId: lease.runId };
    let renewal: InvocationRenewal | undefined;
    try {
      renewal = new InvocationRenewal(this.deps.lifecycle, lease);
      await this.deps.lifecycle.authorize(lease);
      await this.active(lease, renewal);
      const state = await this.deps.lifecycle.read(scope);
      const frozen = requireUsRequestPackageEvidence(state.run, scope.tenantId);
      if (
        stableStringify(frozen.validationSnapshot.build) !==
          stableStringify(this.deps.execution.build) ||
        (state.checkpoint && state.checkpoint.executionDigest !== this.deps.execution.digest)
      )
        throw new ServiceUnavailableException({ code: "us_request_worker_execution_invalid" });
      await this.active(lease, renewal);
      const payloads = await renderUsRequestPayloads(state.run, scope.tenantId);
      await this.active(lease, renewal);
      const plan = await this.deps.planReader.read(state.run, scope.tenantId);
      await this.active(lease, renewal);
      // Branch deliberately: explicit saved null workerStartedAt is evidence.
      const context = state.checkpoint
        ? {
            schemaVersion: 1 as const,
            workerStartedAt: state.checkpoint.model.timing.workerStartedAt,
            reportDataPreparedAt: state.checkpoint.model.timing.reportDataPreparedAt,
          }
        : {
            schemaVersion: 1 as const,
            workerStartedAt: lease.startedAt,
            reportDataPreparedAt: await this.now(),
          };
      const inputs = bindUsRequestPackageInputs(state.run, scope.tenantId, payloads, plan, context);
      if (state.checkpoint)
        this.deps.checkpoints.assertReproduction(
          state.checkpoint,
          inputs,
          this.deps.execution.digest,
        );
      await this.active(lease, renewal);
      await this.deps.checkpoints.acceptReport(lease, {
        model: inputs.model,
        modelDigest: createHash("sha256").update(stableStringify(inputs.model)).digest("hex"),
        executionDigest: this.deps.execution.digest,
        packageVersion: US_REQUEST_PACKAGE_VERSION,
        reportVersion: US_REQUEST_REPORT_PDF_VERSION,
      });
      await this.active(lease, renewal);
      const result = await assembleUsRequestPackage(inputs);
      const renderedAt = await this.now();
      await this.active(lease, renewal);
      if (state.expectation)
        this.deps.checkpoints.assertPackageReproduction(state.expectation, result);
      const { bytes: zipBytes, ...zip } = result.zip;
      void zipBytes;
      const expectation = await this.deps.checkpoints.acceptPackage(
        lease,
        {
          manifest: result.manifest,
          entries: result.files.map(({ bytes, ...descriptor }) => {
            void bytes;
            return descriptor;
          }),
          zip,
        },
        renderedAt,
      );
      await this.active(lease, renewal);
      const objects = await this.deps.publication.allocate(lease, expectation);
      for (const evidence of objects) {
        await this.active(lease, renewal);
        const file =
          evidence.name === "package.zip"
            ? result.zip
            : result.files.find((entry) => entry.name === evidence.name);
        if (!file)
          throw new ServiceUnavailableException({ code: "us_request_worker_stored_invalid" });
        // Adapter returns only after owned conditional PUT and actual bounded GET/hash.
        await this.deps.storage.putVerified(scope, evidence, file.bytes);
        await this.active(lease, renewal);
        await this.deps.publication.markVerified(lease, evidence);
      }
      await this.active(lease, renewal);
      await this.deps.publication.publish(lease);
      return { kind: "ready", scope };
    } catch (error) {
      await renewal?.stop();
      return this.failure(lease, scope, error);
    } finally {
      await renewal?.stop();
    }
  }

  private async now(): Promise<string> {
    const result = await this.db.execute<{ milliseconds: string }>(
      sql`select extract(epoch from date_trunc('milliseconds',clock_timestamp())) * 1000 as milliseconds`,
    );
    const milliseconds = Number(result.rows[0]?.milliseconds);
    if (!Number.isSafeInteger(milliseconds))
      throw new ServiceUnavailableException({ code: "us_request_worker_stored_invalid" });
    return new Date(milliseconds).toISOString();
  }
  private async active(lease: UsWorkerLease, renewal: InvocationRenewal): Promise<void> {
    renewal.assertHealthy();
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL lock_timeout='2s'`);
      await tx.execute(sql`SET LOCAL statement_timeout='15s'`);
      // lifecycle reloads the persisted expiry, including a renewal completed
      // after this caller originally captured lease.expiresAt.
      await this.deps.lifecycle.assertActive(tx, lease);
    });
    renewal.assertHealthy();
  }
  private outcome(state: UsWorkerRunState, scope: UsWorkerScope): UsRequestWorkerResult | null {
    if (state.run.status === "ready") return { kind: "ready", scope };
    if (state.run.status === "queued") return { kind: "retry_scheduled", scope };
    if (state.run.status === "failed") {
      const parsed = usWorkerFailureCodeSchema.safeParse(state.run.failureCode);
      return parsed.success
        ? { kind: "failed", scope, code: parsed.data }
        : { kind: "outcome_unresolved", scope };
    }
    return null;
  }
  private async failure(
    lease: UsWorkerLease,
    scope: UsWorkerScope,
    error: unknown,
  ): Promise<UsRequestWorkerResult> {
    const failure = classifyUsWorkerFailure(error);
    // Any exception can follow a committed publication. Prove the actual
    // durable winner or absence of winner before transitioning or deleting.
    let state: UsWorkerRunState;
    try {
      state = await this.deps.publication.reconcile(scope);
    } catch {
      return { kind: "outcome_unresolved", scope };
    }
    const saved = this.outcome(state, scope);
    if (saved) return saved;
    if (
      failure.code === "us_request_worker_lease_lost" ||
      failure.code === "us_request_worker_deadline_exceeded"
    )
      return { kind: "lease_lost", scope };
    try {
      await this.deps.lifecycle.finishFailure(lease, failure);
    } catch {
      try {
        const resolved = this.outcome(await this.deps.publication.reconcile(scope), scope);
        return resolved ?? { kind: "outcome_unresolved", scope };
      } catch {
        return { kind: "outcome_unresolved", scope };
      }
    }
    try {
      state = await this.deps.publication.reconcile(scope);
    } catch {
      return { kind: "outcome_unresolved", scope };
    }
    const outcome = this.outcome(state, scope);
    if (!outcome) return { kind: "outcome_unresolved", scope };
    if (outcome.kind === "ready") return outcome;
    // At most six owned candidate objects. Uncertain ownership remains durable.
    for (let count = 0; count < 6; count++) {
      try {
        if ((await this.deps.cleanup.cleanupOne(scope)) !== "deleted") break;
      } catch {
        break;
      }
    }
    return outcome;
  }
}
