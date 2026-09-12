import { SubscriptionUnmanagedException } from "../../subscriptions/subscription-errors";
import { AuthorizationService } from "../../authorization/authorization.service";
import { EntitlementsService } from "../../subscriptions/entitlements.service";
import {
  EntitlementAdmissionService,
  admissionScopeDigest,
} from "../../subscriptions/entitlement-admission.service";
import { lockTenantSubscriptionTimeline } from "../../subscriptions/subscription-locks";
import type { SubscriptionTransaction } from "../../subscriptions/entitlements.types";
import { CABINET_CAPABILITY, chzFilteredCisReportPolicy } from "@markiro/domain";
import { ForbiddenException, HttpException, Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";

import { DB } from "../../auth/auth.module";
import { describeErrorForLog } from "../../lib/error-log";
import { JournalService } from "../integrations/journal.service";
import { CHZ_MAX_INPUT_BYTES } from "../inventories/chz-tabular-reader";
import type { InventoryImportDto } from "../inventories/dto";
import { InventoriesService } from "../inventories/inventories.service";
import { CHZ_CHANNEL_TYPE } from "../signer-agents/chz-constants";
import { ChzTokenService } from "./chz-token.service";
import { TrueApiClient } from "./true-api.client";
import type { DispenserTaskSummary, TrueApiAuth } from "./true-api.types";

type ChzExportRunRow = typeof schema.chzExportRuns.$inferSelect;

/** A claim older than this belonged to a worker that is no longer running. */
const STALE_CLAIM_MS = 5 * 60_000;
/**
 * No `finished: false` order gets more than this much wall-clock time in
 * `ordered` or `ready`. A pass counter would need a new column; the deadline
 * needs none, since `markOrdered` stamps `orderedAt` and `markReady`
 * preserves it, and an operator cares about elapsed time, not how many polls
 * it took. Six hours is comfortably longer than any legitimate dispenser task
 * and shorter than the token's ten-hour life, so a timeout here is never
 * mistaken for a token problem.
 */
const MAX_ORDER_WAIT_MS = 6 * 60 * 60_000;
/**
 * A per-run cap on task-creation attempts. `attempts` is incremented once per
 * claim in `claim()`, so this bounds how many times a `queued` run may be
 * claimed and sent to `createDispenserTask` before it is failed outright
 * instead of looping forever against a dispenser that keeps saying
 * `unavailable`.
 *
 * `ChzExportsService.retry()` deliberately preserves `attempts` across an
 * operator retry — `attempts` is the record of how much quota this status has
 * already cost, not a per-attempt scratch value — so a run that is retried
 * while already at this cap must fail fast here rather than clear the counter
 * and loop again. Do not "fix" that by resetting `attempts` on retry.
 *
 * Exported so `ChzExportsService.retry()` can refuse an operator retry
 * outright once a run is already at the cap, instead of resetting it to
 * `queued` only for this same runner to fail it again on the very next pass.
 */
export const MAX_CREATE_ATTEMPTS = 10;
const ERROR_MESSAGE_LIMIT = 500;
/** Codes we write into `error_code`: constants below, or a parser diagnostic. */
const DIAGNOSTIC_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * The current dispenser contract names the terminal result states `SUCCESS`
 * and `FAILED`. Keep the earlier aliases for compatibility with responses from
 * older True API environments. Anything unknown is still treated as working,
 * which costs one more poll rather than recording a wrong terminal state.
 */
const COMPLETED_TASK_STATUSES = new Set(["COMPLETED", "SUCCESS", "DONE"]);
const FAILED_TASK_STATUSES = new Set([
  "FAILED",
  "ERROR",
  "CANCELED",
  "CANCELLED",
  "REJECTED",
  "EXPIRED",
]);

export const CHZ_EXPORT_SAFE_ERROR_CODES = [
  "CHZ_TOKEN_UNAVAILABLE",
  "CHZ_ACTION_ACCESS_DENIED",
  "CHZ_ORDER_CONTEXT_MISSING",
  "CHZ_TASK_REJECTED",
  "CHZ_TASK_FAILED",
  "CHZ_TASK_TIMED_OUT",
  "CHZ_CREATE_ATTEMPTS_EXHAUSTED",
  "CHZ_DOWNLOAD_REJECTED",
  "CHZ_IMPORT_FAILED",
  "CHZ_JOB_RETRIES_EXHAUSTED",
] as const;
export type ChzExportSafeErrorCode = (typeof CHZ_EXPORT_SAFE_ERROR_CODES)[number];

export interface AttemptContext {
  retryCount: number;
  retryLimit: number;
}

interface OrderContext {
  participantInn: string;
  productGroupCode: number;
  gtins: string[];
}

/**
 * One pass over one order: order what is queued, poll what is ordered, import
 * what is ready. Everything the pass learns is written to `chz_export_runs`, so
 * a pass that dies halfway is resumed by the next one rather than restarted.
 *
 * `finished` is false while any run is still non-terminal, which is how the
 * worker decides whether to re-enqueue itself with a delay. The timeout sweep
 * (`sweepExpiredOrders`) runs before anything else that could return early —
 * in particular before the token gate — because it needs only `orderedAt`,
 * not a token or a network call, and it is what stops a `finished: false`
 * order from being an immortal job when the token can never be obtained
 * again.
 */
@Injectable()
export class ChzExportRunnerService {
  private readonly logger = new Logger(ChzExportRunnerService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly tokens: ChzTokenService,
    private readonly client: TrueApiClient,
    private readonly inventories: InventoriesService,
    private readonly journal: JournalService,
    private readonly authorization: AuthorizationService,
    private readonly entitlements: EntitlementsService,
    private readonly admission: EntitlementAdmissionService,
  ) {}

  async run(
    tenantId: string,
    inventoryId: string,
    attempt: AttemptContext,
  ): Promise<{ finished: boolean }> {
    const runs = await this.loadRuns(tenantId, inventoryId);
    // Terminal order: not one request, not even a token lookup.
    if (runs.every(isTerminal)) return { finished: true };

    // No token needed, no network call: only `orderedAt` matters, so this
    // runs on every pass regardless of token state. Without it, a tenant
    // whose signing agent never comes back (a certificate expiring is
    // routine) would fail every `queued` run in `giveUpOnToken` and then loop
    // forever on the `ordered`/`ready` runs it deliberately leaves alone —
    // this is what bounds those instead. See `MAX_ORDER_WAIT_MS`.
    await this.sweepExpiredOrders(tenantId, inventoryId);
    const afterSweep = await this.loadRuns(tenantId, inventoryId);
    if (afterSweep.every(isTerminal)) return { finished: true };

    const token = await this.tokens.getActiveToken(tenantId);
    if (token.status !== "ok") {
      return this.giveUpOnToken(tenantId, inventoryId, attempt, token.status);
    }

    try {
      const context = await this.loadOrderContext(tenantId, inventoryId);
      if (context === null) {
        // The pre-flight passed when the operator ordered, so this is a product
        // or a profile edited afterwards. No pass will ever fix itself.
        await this.failNonTerminal(tenantId, inventoryId, "CHZ_ORDER_CONTEXT_MISSING");
        return { finished: true };
      }
      const taskGroups = await this.orderQueuedRuns(tenantId, inventoryId, token.auth, context);
      await this.pollOrderedRuns(
        tenantId,
        inventoryId,
        token.auth,
        context.productGroupCode,
        taskGroups,
      );
      await this.importReadyRuns(
        tenantId,
        inventoryId,
        token.auth,
        context.productGroupCode,
        taskGroups,
      );
    } catch (error) {
      if (!(error instanceof ChzUnauthorizedError)) throw error;
      // A 401 mid-pass is the same condition as a token we could not load:
      // the tenant's agent has to sign in again before anything else can move.
      // Invalidate the rejected bearer immediately and create one idempotent
      // signer task instead of waiting for the next fifteen-minute scheduler
      // tick to notice an apparently unexpired database row.
      await this.tokens.invalidateAndRequestRefresh(tenantId, token.obtainedAt);
      // A 403 never reaches here: the client maps it to `rejected`, not
      // `unauthorized`, since it is a terminal contract refusal, not a bad
      // bearer.
      return this.giveUpOnToken(tenantId, inventoryId, attempt, "unauthorized");
    }

    const after = await this.loadRuns(tenantId, inventoryId);
    return { finished: after.every(isTerminal) };
  }

  /**
   * A run stuck non-terminal past the deadline is failed here, independently
   * of everything else in the pass: it needs only `orderedAt`, which
   * `markOrdered` stamps and `markReady` preserves, so it costs no token and
   * no request. Both `ordered` (a task stuck in `PREPARATION` forever, or a
   * poll that keeps coming back `unavailable`/`rejected`) and `ready` (a
   * result that never becomes downloadable, so `importReadyRuns` logs and
   * moves on every pass) are the same failure class: a state this runner can
   * re-enter indefinitely without ever reaching a terminal one. Without this
   * sweep either would retry forever. See `MAX_ORDER_WAIT_MS`.
   */
  private async sweepExpiredOrders(tenantId: string, inventoryId: string): Promise<void> {
    const deadline = new Date(Date.now() - MAX_ORDER_WAIT_MS);
    for (const run of await this.loadRuns(tenantId, inventoryId)) {
      if (run.state !== "ordered" && run.state !== "ready") continue;
      if (run.orderedAt === null || run.orderedAt >= deadline) continue;
      await this.failRun(run, "CHZ_TASK_TIMED_OUT", null);
    }
  }

  /**
   * Ordering, one queued run at a time. The claim goes out before the request
   * does: it is what serialises two workers, and it is what tells the next pass
   * that a create may already have been paid for.
   */
  private async orderQueuedRuns(
    tenantId: string,
    inventoryId: string,
    auth: TrueApiAuth,
    context: OrderContext,
  ): Promise<Map<string, number>> {
    const taskGroups = new Map<string, number>();
    const allQueued = (await this.loadRuns(tenantId, inventoryId)).filter(
      (run) => run.state === "queued",
    );
    if (allQueued.length === 0) return taskGroups;

    // A run at the cap is failed outright, before it is claimed again: claiming
    // would push `attempts` past the cap and cost another create call for an
    // answer we already know. See `MAX_CREATE_ATTEMPTS`.
    const staleCutoff = new Date(Date.now() - STALE_CLAIM_MS);
    const exhausted = allQueued.filter(
      (run) =>
        run.attempts >= MAX_CREATE_ATTEMPTS &&
        (run.claimedAt === null || run.claimedAt < staleCutoff),
    );
    for (const run of exhausted) {
      await this.failRun(run, "CHZ_CREATE_ATTEMPTS_EXHAUSTED", null);
    }
    const queued = allQueued.filter((run) => run.attempts < MAX_CREATE_ATTEMPTS);
    if (queued.length === 0) return taskGroups;

    const awaitingAdoption = queued.filter(
      (run) =>
        run.dispenserTaskId === null && run.claimedAt !== null && run.claimedAt < staleCutoff,
    );
    const adoption = await this.resolveAdoption(tenantId, auth, context, awaitingAdoption);

    for (const run of queued) {
      const adoptedTaskId = adoption?.runId === run.id ? adoption.taskId : null;
      const claimed = await this.claim(run, staleCutoff, context, adoptedTaskId === null);
      if (!claimed) continue;
      const taskId = adoptedTaskId ?? (await this.createTask(auth, claimed.context, claimed.run));
      if (taskId === null) continue;
      await this.markOrdered(claimed.run, taskId);
      // Only this exact attempt/task may reuse the checked group in this pass.
      // Known/adopted work retains the pass's original recovery context.
      taskGroups.set(taskAttemptKey(claimed.run, taskId), claimed.context.productGroupCode);
    }
    return taskGroups;
  }

  /**
   * The claim keeps `state` at `queued` on purpose: a run becomes `ordered`
   * only once a `dispenserTaskId` exists, which is what keeps the table's state
   * consistency check true at every instant rather than only between steps.
   *
   * The previously loaded row supplies pre-claim eligibility and adoption context.
   * `UPDATE ... RETURNING` supplies the new attempt and claim timestamp used to
   * fence this worker's subsequent observation, result and journal writes.
   */
  private async claim(
    run: ChzExportRunRow,
    staleCutoff: Date,
    context: OrderContext,
    freshCreate: boolean,
  ): Promise<{ run: ChzExportRunRow; context: OrderContext } | null> {
    const facts = freshCreate ? await this.admission.capture(run.tenantId) : undefined;
    return this.db.transaction(async (tx) => {
      // Match lifecycle lock order before taking the run lock. No HTTP inside this transaction.
      await lockTenantSubscriptionTimeline(tx, run.tenantId);
      const [owned] = await tx
        .select()
        .from(schema.chzExportRuns)
        .where(
          and(
            this.ownedRunInState(run, "queued"),
            or(
              isNull(schema.chzExportRuns.claimedAt),
              lt(schema.chzExportRuns.claimedAt, staleCutoff),
            ),
          ),
        )
        .for("update");
      if (!owned) return null;
      if (freshCreate) {
        try {
          const principal = await this.authorization.resolvePrincipal(
            owned.orderedByUserId,
            owned.tenantId,
            tx,
          );
          if (!principal?.capabilities.includes(CABINET_CAPABILITY.OPERATIONS_WRITE))
            throw new ForbiddenException();
          await this.entitlements.assertWriteAccess(owned.tenantId, tx);
        } catch (error) {
          // Only an authoritative denial is terminal; infrastructure/auth lookup failure retries.
          if (
            !(error instanceof SubscriptionUnmanagedException) &&
            (!(error instanceof HttpException) || error.getStatus() !== 403)
          )
            throw error;
          await this.failRun(owned, "CHZ_ACTION_ACCESS_DENIED", null, tx);
          return null;
        }
      }
      // Read once through the owner after timeline/run and authorization waits.
      // A plain SELECT has one coherent statement snapshot and adds no inventory
      // lock after the run lock (receipt ingestion locks inventory -> run -> product).
      const checkedContext = freshCreate
        ? await this.loadOrderContext(owned.tenantId, owned.inventoryId, tx)
        : context;
      const contextObservedAt = new Date();
      if (checkedContext === null) {
        await this.failRun(owned, "CHZ_ORDER_CONTEXT_MISSING", null, tx);
        return null;
      }
      if (freshCreate && !chzFilteredCisReportPolicy(checkedContext.productGroupCode).supported) {
        await this.failRun(owned, "CHZ_ACTION_ACCESS_DENIED", null, tx);
        return null;
      }
      const now = new Date();
      const [claimed] = await tx
        .update(schema.chzExportRuns)
        .set({
          claimedAt: now,
          attempts: sql`${schema.chzExportRuns.attempts} + 1`,
          updatedAt: now,
        })
        .where(this.ownedRunInState(owned, "queued"))
        .returning();
      if (!claimed) return null;
      if (freshCreate)
        await this.admission.observe({
          tenantId: claimed.tenantId,
          actor: { domain: "cabinet", id: claimed.orderedByUserId },
          operationId: "chz.export.create.v1",
          scopeDigest: admissionScopeDigest({
            inventoryId: claimed.inventoryId,
            runId: claimed.id,
            status: claimed.status,
            context: checkedContext,
          }),
          transaction: tx,
          facts,
          attempt: {
            number: claimed.attempts,
            identity: `${claimed.id}:${claimed.claimedAt?.toISOString()}`,
          },
          runtime: {
            enabled: chzFilteredCisReportPolicy(checkedContext.productGroupCode).supported,
            observedAt: contextObservedAt,
          },
        });
      return { run: claimed, context: checkedContext };
    });
  }

  /**
   * A run that claimed, then came back still queued and with no task id, may
   * have had its create response lost in flight — the task exists and has
   * already cost the tenant a slot of a finite daily quota.
   *
   * Adoption is deliberately narrow, but not because a wrong pairing would
   * corrupt an import: `importEvidence` passes `expectedStatus` and
   * `expectedGtin14` into `parseChzImport` (`inventories.service.ts`), so an
   * adopted task for the wrong status fails the parse instead of importing
   * foreign codes. That risk is already closed downstream.
   *
   * The real constraint is that `DispenserTaskSummary` carries no report
   * filter — no status, no GTIN — so a listed task cannot be matched to the
   * status that requested it. What can be established without guessing is
   * that the pairing is forced: exactly one run of this order is waiting, and
   * exactly one listed task of this product group is not already held by a
   * run of this tenant and is not older than the waiting run. Anything less
   * certain would be a guess about a shape of `GET dispenser/tasks`'s response
   * that nobody has verified against the real API (this plan's runbook has a
   * sandbox step for that); until it is verified, this stays narrow.
   *
   * The honest cost of staying narrow: a pass in which two runs are
   * simultaneously awaiting a task id creates two tasks even when only one of
   * them was actually lost, paying twice for what may be the recoverable
   * case. If the sandbox step finds that `GET dispenser/tasks` does return
   * enough to match a task to a status, this rule can widen.
   */
  private async resolveAdoption(
    tenantId: string,
    auth: TrueApiAuth,
    context: OrderContext,
    awaiting: readonly ChzExportRunRow[],
  ): Promise<{ runId: string; taskId: string } | null> {
    const [run] = awaiting;
    if (run === undefined || awaiting.length !== 1) return null;

    const listed = await this.client.listDispenserTasks(auth, context.productGroupCode);
    if (listed.status === "unauthorized") throw new ChzUnauthorizedError();
    if (listed.status !== "ok") {
      this.logger.warn(
        `ChZ task list unavailable for tenant ${tenantId}; ordering without reconciliation`,
      );
      return null;
    }

    const held = await this.heldTaskIds(tenantId);
    const candidates = listed.value.filter(
      (task) =>
        // An empty `taskId` is the client's marker for a listed row whose id was
        // missing or not a string. That is a malformed row, never "the task this
        // run is waiting for": adopting it would move the run to `ordered` with
        // an id that can never be polled, stranding it exactly as the state
        // consistency check exists to prevent.
        task.taskId.length > 0 &&
        !held.has(task.taskId) &&
        !FAILED_TASK_STATUSES.has(task.status.toUpperCase()) &&
        !predatesRun(task, run),
    );
    const [candidate] = candidates;
    if (candidate === undefined || candidates.length !== 1) return null;
    return { runId: run.id, taskId: candidate.taskId };
  }

  /** Every task id this tenant has already recorded, across all inventories. */
  private async heldTaskIds(tenantId: string): Promise<Set<string>> {
    const rows = await this.db
      .select({ dispenserTaskId: schema.chzExportRuns.dispenserTaskId })
      .from(schema.chzExportRuns)
      .where(eq(schema.chzExportRuns.tenantId, tenantId));
    return new Set(
      rows.flatMap((row) =>
        row.dispenserTaskId !== null && row.dispenserTaskId.length > 0 ? [row.dispenserTaskId] : [],
      ),
    );
  }

  private async createTask(
    auth: TrueApiAuth,
    context: OrderContext,
    run: ChzExportRunRow,
  ): Promise<string | null> {
    const created = await this.client.createDispenserTask(auth, {
      participantInn: context.participantInn,
      productGroupCode: context.productGroupCode,
      chzStatus: run.status,
      gtins: context.gtins,
    });
    switch (created.status) {
      case "ok":
        return created.value.taskId;
      case "unauthorized":
        throw new ChzUnauthorizedError();
      case "rejected":
        // ЧЗ said no. Repeating it would spend the quota on the same answer.
        await this.failRun(run, "CHZ_TASK_REJECTED", created.message);
        return null;
      case "unavailable":
        // Including 429: a rate limit is a wait, not a refusal. The run stays
        // queued and the next pass claims it again.
        this.logger.warn(
          `ChZ dispenser unavailable while ordering ${run.status} for inventory ${run.inventoryId}`,
        );
        return null;
    }
  }

  /**
   * Batch statuses per product group. Normally this is one request for the
   * whole order; a group edited during creation needs a separate batch for
   * those new tasks. `GET dispenser/tasks/{id}` allows five calls a minute,
   * so do not poll the six statuses individually.
   */
  private async pollOrderedRuns(
    tenantId: string,
    inventoryId: string,
    auth: TrueApiAuth,
    productGroupCode: number,
    taskGroups: ReadonlyMap<string, number>,
  ): Promise<void> {
    // A run past the timeout deadline was already failed by
    // `sweepExpiredOrders` earlier in this same pass, before the token gate,
    // so nothing here needs to re-check `orderedAt`.
    const groups = new Map<number, Map<string, ChzExportRunRow>>();
    for (const run of await this.loadRuns(tenantId, inventoryId)) {
      if (run.state !== "ordered") continue;
      if (run.dispenserTaskId === null || run.dispenserTaskId.length === 0) continue;
      const group = taskGroups.get(taskAttemptKey(run)) ?? productGroupCode;
      const byTaskId = groups.get(group) ?? new Map<string, ChzExportRunRow>();
      byTaskId.set(run.dispenserTaskId, run);
      groups.set(group, byTaskId);
    }
    for (const [group, byTaskId] of groups) {
      const results = await this.client.listDispenserResults(auth, group, [...byTaskId.keys()]);
      if (results.status === "unauthorized") throw new ChzUnauthorizedError();
      if (results.status !== "ok") {
        // Both `rejected` and `unavailable` leave the runs ordered: a batch poll
        // says nothing about an individual task, and the report ЧЗ is preparing
        // outlives this pass either way.
        this.logger.warn(
          `ChZ dispenser results unavailable for inventory ${inventoryId} (${results.status})`,
        );
        continue;
      }

      for (const result of results.value) {
        // An empty `taskId` is a malformed listed row; a run's task id is never
        // empty, so it can only match by accident. Skipped explicitly.
        const run = result.taskId.length > 0 ? byTaskId.get(result.taskId) : undefined;
        if (run === undefined) continue;
        const status = result.status.toUpperCase();
        if (
          result.resultId !== null &&
          result.resultId.length > 0 &&
          COMPLETED_TASK_STATUSES.has(status)
        ) {
          if (
            result.available !== null &&
            result.available !== undefined &&
            result.available.toUpperCase() !== "AVAILABLE"
          ) {
            continue;
          }
          if (
            result.archiveSize !== null &&
            result.archiveSize !== undefined &&
            result.archiveSize > CHZ_MAX_INPUT_BYTES
          ) {
            await this.failRun(run, "CHZ_DOWNLOAD_REJECTED", null);
            continue;
          }
          await this.markReady(run, result.resultId);
        } else if (FAILED_TASK_STATUSES.has(status)) {
          await this.failRun(run, "CHZ_TASK_FAILED", result.errorMessage ?? null);
        }
      }
    }
  }

  private async importReadyRuns(
    tenantId: string,
    inventoryId: string,
    auth: TrueApiAuth,
    productGroupCode: number,
    taskGroups: ReadonlyMap<string, number>,
  ): Promise<void> {
    for (const run of await this.loadRuns(tenantId, inventoryId)) {
      if (run.state !== "ready") continue;
      const { resultId, dispenserTaskId } = run;
      if (resultId === null || dispenserTaskId === null) continue;

      const downloaded = await this.client.downloadDispenserResult(
        auth,
        resultId,
        taskGroups.get(taskAttemptKey(run)) ?? productGroupCode,
        CHZ_MAX_INPUT_BYTES,
      );
      switch (downloaded.status) {
        case "unauthorized":
          throw new ChzUnauthorizedError();
        case "rejected":
          // A refusal for one result id (gone, expired) is that run's answer.
          await this.failRun(run, "CHZ_DOWNLOAD_REJECTED", downloaded.message);
          continue;
        case "unavailable":
          this.logger.warn(
            `ChZ result ${maskId(resultId)} not downloadable yet for inventory ${inventoryId}`,
          );
          continue;
        case "ok":
          await this.importArchive(tenantId, inventoryId, run, downloaded.value);
      }
    }
  }

  private async importArchive(
    tenantId: string,
    inventoryId: string,
    run: ChzExportRunRow,
    archive: Uint8Array,
  ): Promise<void> {
    let imported: InventoryImportDto;
    try {
      imported = await this.inventories.importEvidence(
        tenantId,
        run.orderedByUserId,
        inventoryId,
        run.status,
        {
          // The parser already handles a zip holding exactly one CSV, which is
          // the dispenser's shape -- see chz-tabular-reader.ts `parseZipCsv`.
          // Naming the synthesised file is the entire adapter: unpacking and
          // re-packing here would be a second code path to the same invariant.
          originalName: `chz-${run.status.toLowerCase()}-${fileNamePart(run.dispenserTaskId)}.zip`,
          mimeType: "application/zip",
          bytes: Buffer.from(archive),
        },
        {
          runId: run.id,
          attempts: run.attempts,
          claimedAt: run.claimedAt,
          dispenserTaskId: run.dispenserTaskId,
          resultId: run.resultId,
        },
      );
    } catch (error) {
      this.logger.warn(
        `ChZ export import failed for ${run.status} of inventory ${inventoryId}`,
        describeErrorForLog(error),
      );
      await this.failRun(run, importErrorCode(error), null);
      return;
    }

    if (imported.result === "failed") {
      // The import row keeps the full diagnostic; the run keeps the code, which
      // is what the operator sees next to the status.
      await this.failRun(run, diagnosticCode(imported.diagnostics[0]?.code), null);
      return;
    }
    await this.markImported(run, imported.id);
  }

  /**
   * No token, no pass. `missing` and `expired` are a wait while the job still
   * has attempts left — the tenant's agent refreshes the token on its own
   * scheduler, within about fifteen minutes — and only an exhausted budget
   * turns those into an answer for the operator.
   *
   * `unconfigured` and `undecryptable` are never self-healing: nothing
   * un-rotates an encryption key or un-corrupts a ciphertext, so waiting out
   * the full `MAX_EXPORT_PASSES` budget (240 passes, roughly two hours at the
   * worker's cadence) would just leave the operator staring at «В очереди»
   * for that long before the same failure it could have reported on the
   * first pass. Those two are therefore terminal immediately, regardless of
   * `attempt.retryCount`. Branching on the two terminal reasons explicitly
   * (rather than on the two retryable ones) means a reason this runner has
   * never seen -- a future `ChzTokenResult` variant, or the literal
   * `"unauthorized"` this method is also called with from `run()`'s catch
   * branch -- falls on the safe, retryable side instead of failing outright.
   */
  private async giveUpOnToken(
    tenantId: string,
    inventoryId: string,
    attempt: AttemptContext,
    reason: string,
  ): Promise<{ finished: boolean }> {
    const neverSelfHeals = reason === "unconfigured" || reason === "undecryptable";
    if (!neverSelfHeals && attempt.retryCount < attempt.retryLimit) {
      this.logger.warn(
        `ChZ token unavailable (${reason}) for tenant ${tenantId}; export order will retry`,
      );
      await this.appendOrderJournal(
        tenantId,
        inventoryId,
        "warn",
        "Токен Честного Знака недоступен, заказ выгрузок отложен",
      );
      return { finished: false };
    }
    // Only `queued` runs need a token to make any progress at all. `ordered`
    // and `ready` runs already paid ЧЗ's finite daily quota for a task or a
    // report; failing them here would throw that work away for nothing, and an
    // operator retry would then re-create tasks the tenant already has. Leave
    // them non-terminal so a later pass, once the tenant's agent refreshes the
    // token, can still poll or download them. Do not "simplify" this back to
    // failing every non-terminal run.
    await this.failNonTerminal(tenantId, inventoryId, "CHZ_TOKEN_UNAVAILABLE", ["queued"]);
    const after = await this.loadRuns(tenantId, inventoryId);
    return { finished: after.every(isTerminal) };
  }

  /**
   * Called by the worker (`jobs.module.ts`) when `run()` threw and pg-boss's
   * own retry budget for the job (`job.retryLimit`) is spent: no `startAfter`
   * successor was ever sent for a thrown pass, so once the job's own retries
   * run out nothing would ever advance this order again. Reuses
   * `failNonTerminal`, the same helper `giveUpOnToken` uses, rather than a
   * second failure path — every non-terminal run becomes `failed` with a
   * stable code the operator can act on (retry, or fall back to manual
   * upload), instead of the order silently stranding itself.
   */
  async abandonAfterJobRetriesExhausted(tenantId: string, inventoryId: string): Promise<void> {
    await this.failNonTerminal(tenantId, inventoryId, "CHZ_JOB_RETRIES_EXHAUSTED");
  }

  private async failNonTerminal(
    tenantId: string,
    inventoryId: string,
    errorCode: ChzExportSafeErrorCode,
    states: readonly ChzExportRunRow["state"][] = ["queued", "ordered", "ready"],
  ): Promise<void> {
    for (const run of await this.loadRuns(tenantId, inventoryId)) {
      if (!states.includes(run.state)) continue;
      await this.failRun(run, errorCode, null);
    }
  }

  private async loadRuns(tenantId: string, inventoryId: string): Promise<ChzExportRunRow[]> {
    return this.db
      .select()
      .from(schema.chzExportRuns)
      .where(
        and(
          eq(schema.chzExportRuns.tenantId, tenantId),
          eq(schema.chzExportRuns.inventoryId, inventoryId),
        ),
      )
      .orderBy(schema.chzExportRuns.status);
  }

  /** The INN, product group and GTIN the six reports are filtered by. */
  private async loadOrderContext(
    tenantId: string,
    inventoryId: string,
    executor: Db | SubscriptionTransaction = this.db,
  ): Promise<OrderContext | null> {
    const [row] = await executor
      .select({
        inn: schema.orgProfiles.inn,
        productGroupCode: schema.products.chzProductGroupCode,
        gtin14: schema.products.gtin14,
      })
      .from(schema.inventories)
      .innerJoin(
        schema.products,
        and(
          eq(schema.products.tenantId, schema.inventories.tenantId),
          eq(schema.products.id, schema.inventories.productId),
        ),
      )
      .leftJoin(schema.orgProfiles, eq(schema.orgProfiles.tenantId, schema.inventories.tenantId))
      .where(
        and(eq(schema.inventories.tenantId, tenantId), eq(schema.inventories.id, inventoryId)),
      );
    if (!row || row.inn === null || row.inn.length === 0 || row.productGroupCode === null) {
      return null;
    }
    return {
      participantInn: row.inn,
      productGroupCode: row.productGroupCode,
      gtins: [row.gtin14],
    };
  }

  private async markOrdered(run: ChzExportRunRow, dispenserTaskId: string): Promise<void> {
    const now = new Date();
    await this.db.transaction(async (tx) => {
      const updated = await tx
        .update(schema.chzExportRuns)
        .set({
          state: "ordered",
          dispenserTaskId,
          resultId: null,
          importId: null,
          errorCode: null,
          errorMessage: null,
          orderedAt: now,
          completedAt: null,
          updatedAt: now,
        })
        .where(this.ownedRunInState(run, "queued"))
        .returning({ id: schema.chzExportRuns.id });
      if (updated.length)
        await this.appendJournal(run, "ok", "Заказан отчёт Честного Знака", dispenserTaskId, tx);
    });
  }

  private async markReady(run: ChzExportRunRow, resultId: string): Promise<void> {
    const now = new Date();
    await this.db
      .update(schema.chzExportRuns)
      .set({
        state: "ready",
        resultId,
        importId: null,
        errorCode: null,
        errorMessage: null,
        completedAt: null,
        updatedAt: now,
      })
      .where(this.ownedRunInState(run, "ordered"));
  }

  private async markImported(run: ChzExportRunRow, importId: string): Promise<void> {
    const now = new Date();
    await this.db.transaction(async (tx) => {
      const updated = await tx
        .update(schema.chzExportRuns)
        .set({
          state: "imported",
          importId,
          errorCode: null,
          errorMessage: null,
          completedAt: now,
          updatedAt: now,
        })
        .where(this.ownedRunInState(run, "ready"))
        .returning({ id: schema.chzExportRuns.id });
      if (updated.length)
        await this.appendJournal(
          run,
          "ok",
          "Отчёт Честного Знака загружен",
          run.dispenserTaskId,
          tx,
        );
    });
  }

  /**
   * `errorCode` is always one of this module's constants or a sanitised parser
   * diagnostic, and `errorMessage` only ever carries text ЧЗ itself sent back —
   * never an exception message, which is where a bearer token could hide.
   */
  private async failRun(
    run: ChzExportRunRow,
    errorCode: string,
    errorMessage: string | null,
    transaction?: SubscriptionTransaction,
  ): Promise<void> {
    const now = new Date();
    const bounded =
      errorMessage === null || errorMessage.length === 0
        ? null
        : errorMessage.slice(0, ERROR_MESSAGE_LIMIT);
    const write = async (tx: SubscriptionTransaction) => {
      const updated = await tx
        .update(schema.chzExportRuns)
        .set({
          state: "failed",
          errorCode,
          errorMessage: bounded,
          completedAt: now,
          updatedAt: now,
        })
        .where(this.ownedRunInState(run, run.state))
        .returning({ id: schema.chzExportRuns.id });
      if (!updated.length) return;
      await this.appendJournal(
        run,
        "error",
        `Выгрузка Честного Знака не удалась: ${errorCode}`,
        run.dispenserTaskId,
        tx,
      );
    };
    if (transaction) await write(transaction);
    else await this.db.transaction(write);
  }

  private ownedRunInState(run: ChzExportRunRow, state: ChzExportRunRow["state"]) {
    return and(
      eq(schema.chzExportRuns.tenantId, run.tenantId),
      eq(schema.chzExportRuns.id, run.id),
      eq(schema.chzExportRuns.state, state),
      eq(schema.chzExportRuns.attempts, run.attempts),
      run.claimedAt
        ? eq(schema.chzExportRuns.claimedAt, run.claimedAt)
        : isNull(schema.chzExportRuns.claimedAt),
    );
  }

  /**
   * Journal details are limited to the three fields the operator needs to read
   * a line: which inventory, which status, which ЧЗ task. Nothing derived from
   * the token or from an exception goes in.
   */
  private async appendJournal(
    run: ChzExportRunRow,
    outcome: "ok" | "warn" | "error",
    message: string,
    dispenserTaskId: string | null,
    transaction?: SubscriptionTransaction,
  ): Promise<void> {
    await this.append(
      run.tenantId,
      outcome,
      "out",
      message,
      {
        inventoryId: run.inventoryId,
        status: run.status,
        dispenserTaskId,
      },
      transaction,
    );
  }

  private async appendOrderJournal(
    tenantId: string,
    inventoryId: string,
    outcome: "ok" | "warn" | "error",
    message: string,
  ): Promise<void> {
    await this.append(tenantId, outcome, "local", message, { inventoryId });
  }

  /**
   * Fenced transitions append their journal entry in the owner transaction before
   * commit. The journal's savepoint isolates a failed append so that the owned
   * transition can still commit and the pass can continue.
   */
  private async append(
    tenantId: string,
    outcome: "ok" | "warn" | "error",
    direction: "out" | "local",
    message: string,
    details: Record<string, unknown>,
    transaction?: SubscriptionTransaction,
  ): Promise<void> {
    try {
      await this.journal.append(
        {
          tenantId,
          channelType: CHZ_CHANNEL_TYPE,
          sessionId: null,
          direction,
          outcome,
          grain: "item",
          message,
          details,
        },
        transaction,
      );
    } catch (error) {
      this.logger.error(
        `Failed to journal ChZ export event for tenant ${tenantId}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }
}

/**
 * A 401 anywhere in the pass unwinds to the token branch in `run()`. Never
 * thrown for a 403: `TrueApiClient` maps that to `rejected` (a terminal
 * contract refusal, not a bad bearer), which each call site already handles
 * as a normal non-`ok` result.
 */
class ChzUnauthorizedError extends Error {}

/** In-memory context only: a stale response must never select a winning task's group. */
function taskAttemptKey(run: ChzExportRunRow, taskId = run.dispenserTaskId): string {
  return `${run.id}:${run.attempts}:${run.claimedAt?.toISOString()}:${taskId}`;
}

function isTerminal(run: ChzExportRunRow): boolean {
  return run.state === "imported" || run.state === "failed";
}

/**
 * A task created before the run's row existed cannot be that run's lost create.
 * ЧЗ does not always report a creation time; when it does not, the other
 * candidate filters are all that stand between us and paying twice, so an
 * unknown time is accepted rather than treated as disqualifying.
 */
function predatesRun(task: DispenserTaskSummary, run: ChzExportRunRow): boolean {
  if (task.createdAt === null) return false;
  const createdAt = Date.parse(task.createdAt);
  return !Number.isNaN(createdAt) && createdAt < run.createdAt.getTime();
}

function importErrorCode(error: unknown): string {
  const response = error instanceof HttpException ? error.getResponse() : null;
  const code =
    typeof response === "object" && response !== null
      ? (response as { code?: unknown }).code
      : undefined;
  return diagnosticCode(typeof code === "string" ? code : undefined);
}

/** Structured codes only: an arbitrary string could carry anything at all. */
function diagnosticCode(code: string | undefined): string {
  return code !== undefined && DIAGNOSTIC_CODE.test(code) ? code : "CHZ_IMPORT_FAILED";
}

/**
 * The stored file name is the only place a ЧЗ id is echoed back to a person, so
 * it carries the id's shape rather than the id itself.
 */
function fileNamePart(taskId: string | null): string {
  const cleaned = (taskId ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
  return cleaned.length > 0 ? cleaned : "task";
}

/** A result id is not a secret, but it is not worth a full line in a log. */
function maskId(value: string): string {
  return value.length <= 8 ? value : `${value.slice(0, 8)}…`;
}
